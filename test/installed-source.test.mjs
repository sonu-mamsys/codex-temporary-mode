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
  if (manifest) assert.equal(fs.readFileSync(asset.absolute, 'utf8'), transformed, `${label} installed source must match its dynamic adapter transformation`);
}

function copySource(root, relative, source) {
  const destination = inside(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
}

test('real extension adapters discover the current profile and parse selected source files', { skip: !reviewRoot }, () => {
  const installed = loadInstalledExtension();
  const patchedMain = adaptVSCodeSource(installed.main.source, installed.pkg);
  assert.ok(installed.compatibility.profile.id);
  assert.ok(installed.compatibility.renderer?.path);
  assertInstalledTransform(installed, installed.main, patchedMain, 'core');
  new vm.Script(patchedMain, { filename: installed.main.absolute });

  const renderer = installed.compatibility.renderer;
  const patchedRenderer = adaptRendererSource(renderer.source, installed.compatibility.profile);
  assertInstalledTransform(installed, renderer, patchedRenderer, 'renderer');

  const composer = installed.compatibility.composer;
  if (composer) {
    const patchedComposer = adaptComposerSource(composer.source, installed.compatibility.profile);
    assertInstalledTransform(installed, composer, patchedComposer, 'composer');
    const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: patchedComposer, encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  }
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
