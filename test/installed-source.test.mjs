// Optional, read-only verification against a real extension bundle.
// TEMP_CODEX_REVIEW_EXTENSION must point to its installation directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { adaptVSCodeSource, adaptRendererSource, adaptComposerSource, detectVSCodeCompatibility } from '../lib/vscode-adapter.mjs';
import { installVSCode, restoreVSCode } from '../lib/installers.mjs';

const reviewRoot = process.env.TEMP_CODEX_REVIEW_EXTENSION;
const helper = fs.readFileSync(new URL('../src/inject/vscode-inject.cjs', import.meta.url), 'utf8');
const key = relative => path.posix.normalize(relative.replaceAll('\\', '/'));

function inside(root, relative) {
  const resolved = path.resolve(root, relative);
  assert.ok(resolved.startsWith(`${path.resolve(root)}${path.sep}`), `Path outside supplied extension: ${relative}`);
  return resolved;
}

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'temp-codex-installed-source-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function loadInstalledExtension() {
  const root = path.resolve(reviewRoot);
  const manifestFile = inside(root, '.temp-codex-v3.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const patchedPaths = new Set((manifest?.files || []).map(entry => key(entry.path)));
  const original = relative => {
    const file = inside(root, relative);
    return fs.readFileSync(patchedPaths.has(key(relative)) ? `${file}.temp-codex.bak` : file, 'utf8');
  };
  const packagePath = 'package.json';
  const pkg = JSON.parse(original(packagePath));
  const mainPath = pkg.main || 'out/extension.js';
  const assetsRoot = inside(root, 'webview/assets');
  const assets = fs.readdirSync(assetsRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^app-initial-[\da-f]+\.js$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => {
      const assetPath = path.posix.join('webview', 'assets', entry.name);
      return { path: assetPath, absolute: inside(root, assetPath), source: original(assetPath) };
    });
  const main = { path: mainPath, absolute: inside(root, mainPath), source: original(mainPath) };
  const compatibility = detectVSCodeCompatibility(pkg, main.source, assets);
  return { root, manifest, pkg, original, packagePath, main, compatibility };
}

function assertInstalledTransform({ manifest }, asset, transformed, label) {
  assert.notEqual(transformed, asset.source, `${label} adapter must alter the selected original source`);
  const patchedEntry = manifest?.files.find(entry => key(entry.path) === key(asset.path));
  if (patchedEntry != null) assert.equal(fs.readFileSync(asset.absolute, 'utf8'), transformed, `${label} installed source must match its dynamic adapter transformation`);
}

function copySource(root, relative, source) {
  const destination = inside(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
}

test('real extension adapters discover the current profile and parse selected source files', { skip: !reviewRoot }, async () => {
  const installed = loadInstalledExtension();
  const patchedMain = adaptVSCodeSource(installed.main.source, installed.pkg);
  assert.ok(installed.compatibility.profile.id);
  assert.ok(installed.compatibility.renderer?.path);
  new vm.Script(patchedMain, { filename: installed.main.absolute });

  // Exercise the actual minified provider symbol and host methods. A syntactically
  // valid patch can still intercept the wrong provider and silently do nothing.
  const providerDeclaration = installed.main.source.match(/([A-Za-z$_][A-Za-z0-9$_]*)="CodexWebviewProvider\.webview"/);
  assert.ok(providerDeclaration, 'Real bundle must declare the webview provider');
  const method = (start, next) => {
    const from = patchedMain.indexOf(start);
    const to = patchedMain.indexOf(next, from);
    assert.ok(from >= 0 && to > from, `Real bundle must contain ${start}`);
    return patchedMain.slice(from, to + 1);
  };
  const sendMethod = method('sendProviderRequest(e,r,n,o,i,s){', '}sendNotification(e,r){');
  const receiveMethod = method('routeIncomingMessage(e,r=e){', '}isMcpResponseMessage(e){');
  const context = vm.createContext({
    module: { exports: {} },
    queueMicrotask() {},
    $T: () => false,
    require(name) {
      assert.equal(name, 'vscode');
      return { workspace: { getConfiguration: () => ({ get: () => true }) } };
    },
  });
  vm.runInContext(helper, context);
  vm.runInContext(`var ${providerDeclaration[0]}; this.send=({${sendMethod}}).sendProviderRequest; this.receive=({${receiveMethod}}).routeIncomingMessage;`, context);
  const uiProvider = 'CodexWebviewProvider.webview';
  const results = [];
  const connection = {
    providers: new Map([[uiProvider, { onResult: message => results.push(message) }]]),
    pendingRequests: new Map(),
    pendingTurnStartRequestIds: new Set(),
    pendingPrewarmedThreadStartRequestIds: new Set(),
    recordLastOutboundMethod() {},
    sendMessage(message) { this.lastSent = message; return true; },
    isMcpResponseMessage: message => 'id' in message && ('result' in message || 'error' in message),
  };
  context.send.call(connection, uiProvider, '1', 'thread/start', { cwd: '/project' }, false, false);
  assert.equal(connection.lastSent.params.ephemeral, true);
  context.receive.call(connection, { id: `${uiProvider}:1`, result: { thread: { id: 'temporary-thread', ephemeral: true } } });
  assert.equal(results[0].result.thread.id, 'temporary-thread');
  assert.equal(context.__TEMP_CODEX_V3__.visible(connection, 'temporary-thread'), true);
  const internal = { cwd: '/internal' };
  context.send.call(connection, 'internal-provider', '2', 'thread/start', internal, false, false);
  assert.equal(connection.lastSent.params, internal);
  const renderer = installed.compatibility.renderer;
  const patchedRenderer = adaptRendererSource(renderer.source, installed.compatibility.profile);

  const composer = installed.compatibility.composer;
  if (composer) {
    const patchedComposer = adaptComposerSource(composer.source, installed.compatibility.profile);
    const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: patchedComposer, encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
    if (installed.compatibility.profile.id.endsWith('-shared-composer')) {
      assert.ok(patchedComposer.includes('layout:qc,children:[(0,X5.jsx)(tempCodexNativeComposerControl,{reservation:ce}),pee]'), 'Switch must be inside the native composer body before the input');
      assert.ok(patchedComposer.includes('"data-codex-composer-root":``,"data-composer-placement":De.kind,children:[nn,gn]'), 'Outer composer must retain its original children');
      const nativeStart = patchedComposer.indexOf('function tempCodexNativeComposerControl({reservation}){');
      const nativeEnd = patchedComposer.indexOf('\n}\n', nativeStart) + 2;
      assert.ok(nativeStart > 0 && nativeEnd > nativeStart, 'Shared Codex composer must contain its injected control');
      const injectedControl = patchedComposer.slice(0, nativeEnd);
      let composerValue = { kind: 'new', conversationId: null };
      let hostId = 'local';
      let existingEphemeral = false;
      const nativeRoot = { inert: false };
      const rpcCalls = [];
      const prewarmCalls = [];
      const events = [];
      const reservation = { clear() { events.push('reservation-clear'); } };
      const hookValues = [];
      const effects = [];
      let hookIndex = 0;
      const jsx = (type, props) => ({ type, props });
      const hooks = {
        useState(initial) {
          const index = hookIndex++;
          if (!(index in hookValues)) hookValues[index] = initial;
          return [hookValues[index], value => { hookValues[index] = value; }];
        },
        useRef(initial) {
          const index = hookIndex++;
          if (!(index in hookValues)) hookValues[index] = { current: initial };
          return hookValues[index];
        },
        useEffect(effect) {
          const index = hookIndex++;
          if (!(index in hookValues)) { hookValues[index] = true; effects.push(effect); }
        },
      };
      const manager = {
        getConversation: () => ({ ephemeral: existingEphemeral }),
        clearPrewarmedThreads: async () => { prewarmCalls.push('clear'); events.push('manager-clear'); },
      };
      const ui = vm.createContext({
        ma: () => ({ value: composerValue }), rf: {}, qf: composer => composer.value.conversationId,
        kl: () => hostId, pA: {}, eH: () => manager, Z5: hooks, Q5: { jsx },
        window: { addEventListener() {}, removeEventListener() {}, setInterval() { return 1; }, clearInterval() {} },
        Eg: async (name, payload) => {
          rpcCalls.push({ name, payload, inert: nativeRoot.inert });
          if (name === 'temp-codex-set-mode') events.push('rpc-set');
          return { enabled: name === 'temp-codex-set-mode' ? payload.params.enabled : false };
        },
      });
      vm.runInContext(`${injectedControl}\nthis.render=reservation=>tempCodexNativeComposerControl({reservation});`, ui);
      const render = async () => {
        hookIndex = 0;
        const tree = ui.render(reservation);
        for (const effect of effects.splice(0)) effect();
        await Promise.resolve();
        await Promise.resolve();
        return tree;
      };
      const switchIn = node => {
        if (Array.isArray(node)) return node.map(switchIn).find(Boolean) ?? null;
        if (!node || typeof node !== 'object') return null;
        if (node.props?.role === 'switch') return node;
        return switchIn(node.props?.children) ?? null;
      };
      await render();
      hookValues[0].current = { closest: () => nativeRoot };
      let control = switchIn(await render());
      assert.ok(control, 'New local Codex composer must show the temporary switch');
      assert.equal(control.props.disabled, false);
      composerValue = { kind: 'local', conversationId: null };
      assert.ok(switchIn(await render()), 'Local draft with no conversation ID must show the switch');
      composerValue = { kind: 'local', conversationId: 'existing-thread' };
      existingEphemeral = true;
      assert.equal(switchIn(await render()), null, 'Existing thread must not show a mode switch');
      composerValue = { kind: 'new', conversationId: null };
      hostId = 'remote';
      assert.equal(switchIn(await render()), null, 'Remote composer must not show a local mode switch');
      hostId = 'local';
      control = switchIn(await render());
      await control.props.onClick();
      assert.equal(prewarmCalls.length, 2);
      assert.deepEqual(events, ['reservation-clear', 'manager-clear', 'rpc-set', 'reservation-clear', 'manager-clear']);
      assert.equal(rpcCalls.at(-1).name, 'temp-codex-set-mode');
      assert.equal(rpcCalls.at(-1).payload.params.enabled, true);
      assert.equal(rpcCalls.at(-1).inert, true, 'Native composer must be inert during the setting change');
      assert.equal(nativeRoot.inert, false, 'Native composer must be restored after the setting change');
      assert.equal(switchIn(await render()).props['aria-checked'], true);
      assert.equal((await render()).props.style.boxShadow, undefined, 'Embedded switch must not draw a separate bordered pill');
    }
    assertInstalledTransform(installed, composer, patchedComposer, 'composer');
  }
  assertInstalledTransform(installed, renderer, patchedRenderer, 'renderer');
  assertInstalledTransform(installed, installed.main, patchedMain, 'core');
});

test('real extension profile installs and restores only a disposable copy', { skip: !reviewRoot }, t => {
  const installed = loadInstalledExtension();
  const scratch = tempDirectory(t);
  const sources = [
    { path: installed.packagePath, source: installed.original(installed.packagePath) },
    installed.main,
    installed.compatibility.renderer,
    ...(installed.compatibility.composer ? [installed.compatibility.composer] : []),
  ];
  for (const source of sources) copySource(scratch, source.path, source.source);
  const originals = new Map(sources.map(source => [source.path, Buffer.from(source.source)]));
  const priorStateHome = process.env.CODEX_TEMPORARY_STATE_HOME;
  process.env.CODEX_TEMPORARY_STATE_HOME = path.join(scratch, 'state');
  try {
    assert.match(installVSCode(scratch, helper), /Patched VS Code extension/);
    assert.equal(fs.existsSync(path.join(scratch, '.temp-codex-v3.json')), true);
    assert.match(restoreVSCode(scratch), /Restored VS Code extension/);
    for (const [relative, before] of originals) assert.deepEqual(fs.readFileSync(inside(scratch, relative)), before, `Restored ${relative} must be byte-exact.`);
  } finally {
    if (priorStateHome === undefined) delete process.env.CODEX_TEMPORARY_STATE_HOME;
    else process.env.CODEX_TEMPORARY_STATE_HOME = priorStateHome;
  }
});

test('real renderer storage-mode adapter is selected dynamically and preserves temporary storage semantics', { skip: !reviewRoot }, () => {
  const installed = loadInstalledExtension();
  const patched = adaptRendererSource(installed.compatibility.renderer.source, installed.compatibility.profile);
  const mapping = patched.match(/ephemeral:v\.thread\.ephemeral===!0\|\|d\.ephemeral,sideConversation:d\.ephemeral/);
  assert.ok(mapping, 'Selected renderer must preserve server-confirmed ephemeral storage without forcing a side conversation.');
  const create = new Function('v', 'd', `return {${mapping[0]}}`);
  const temporary = create({ thread: { ephemeral: true } }, { ephemeral: false });
  const normal = create({ thread: { ephemeral: false } }, { ephemeral: false });
  assert.equal(temporary.ephemeral, true);
  assert.equal(temporary.sideConversation, false);
  assert.equal(normal.ephemeral, false);
});
