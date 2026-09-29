import fs from 'node:fs';
import { createHash } from 'node:crypto';

// Kept for legacy recovery tooling. These paths are not compatibility gates:
// current assets are discovered from their complete structural profile.
export const RENDERER_PATH = 'webview/assets/app-initial-bca4f920746a.js';
export const COMPOSER_PATH = 'webview/assets/app-initial-1e5ee25fb4ec.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const identifier = '[A-Za-z$_][A-Za-z0-9$_]*';

function matchCount(source, matcher) {
  if (typeof matcher === 'string') return source.split(matcher).length - 1;
  const flags = `${matcher.flags.replaceAll('g', '')}g`;
  return [...source.matchAll(new RegExp(matcher.source, flags))].length;
}

function matchesExactlyOnce(source, edits) {
  return edits.every(edit => matchCount(source, edit.matcher) === 1);
}

function applyEdits(source, edits, api) {
  for (const edit of edits) {
    if (matchCount(source, edit.matcher) !== 1) throw new Error(`Unsupported ${edit.area} layout: ${edit.id}. No files changed.`);
    source = source.replace(edit.matcher, (...args) => edit.replace(args, api));
  }
  return source;
}

const mainEdits = Object.freeze([
  Object.freeze({ area: 'extension', id: 'settings-rpc', matcher: '"get-settings":()=>this.settings.readAll(),', replace: (_args, api) => `"temp-codex-get-mode":()=>({enabled:${api}.enabled()}),"temp-codex-set-mode":({enabled})=>${api}.setEnabled(enabled),"get-settings":()=>this.settings.readAll(),` }),
  Object.freeze({ area: 'extension', id: 'outbound-request', matcher: 'sendProviderRequest(e,r,n,o,i,s){', replace: (_args, api) => `sendProviderRequest(e,r,n,o,i,s){const __tc=${api}.before(this,e,ES,r,n,o,i);if(__tc.blocked)return;n=__tc.method??n;o=__tc.params;` }),
  Object.freeze({ area: 'extension', id: 'incoming-message', matcher: 'routeIncomingMessage(e,r=e){', replace: (_args, api) => `routeIncomingMessage(e,r=e){e=${api}.receive(this,e);` }),
  // The predicate's minified name changed in a later bundle while the route
  // shape did not. Capture it rather than treating an identifier rename as a
  // new API contract, while still requiring one exact route structure.
  Object.freeze({ area: 'extension', id: 'ephemeral-thread-route', matcher: new RegExp(`if\\(n==="thread/started"&&i!=null&&(${identifier})\\(i\\)\\)`), replace: (args, api) => `if(n==="thread/started"&&i!=null&&${args[1]}(i)&&!${api}.visible(this,i.id))` }),
  Object.freeze({ area: 'extension', id: 'ephemeral-timeout-route', matcher: 'if(s&&this.ephemeralThreadTimeouts.has(s))', replace: (_args, api) => `if(s&&this.ephemeralThreadTimeouts.has(s)&&!${api}.visible(this,s))` }),
  Object.freeze({ area: 'extension', id: 'process-teardown', matcher: 'teardownProcess(){', replace: (_args, api) => `teardownProcess(){${api}.reset(this);` }),
]);

const rendererEdits = Object.freeze([
  Object.freeze({ area: 'renderer', id: 'thread-storage-mode', matcher: 'ephemeral:d.ephemeral,sideConversation:d.ephemeral', replace: () => 'ephemeral:v.thread.ephemeral===!0||d.ephemeral,sideConversation:d.ephemeral' }),
  // Only the generated function identifier is intentionally flexible.
  Object.freeze({ area: 'renderer', id: 'fork-storage-mode', matcher: new RegExp(`function ${identifier}\\(e,\\{conversationId:t,forkResponse:n,hostMode:r,threadRecognition:i,params:a,product:o,sourceConversation:s\\}\\)\\{`), replace: args => `${args[0]}a={...a,ephemeral:n.thread.ephemeral===!0||a.ephemeral};` }),
]);

const composerNeedle = 'function zKn(e){';
// The injected component closes over these bindings. A same-named, unrelated
// function (as seen in newer bundles) must not be patched.
const composerBindings = Object.freeze(['O$', 'k$.jsx', 'il(Dm)', 'il($)', 'Th(FHe())', 'NC(scope,composer.conversationId)', 'scope.get(GC)', 'xm(']);

// New profiles belong here only after source validation of a released bundle.
// The array makes compatibility data additive rather than version-gated.
export const VSCODE_COMPATIBILITY_PROFILES = Object.freeze([
  Object.freeze({
    id: 'codex-commonjs-temporary-v3',
    extension: Object.freeze({ publisher: 'openai', name: 'chatgpt' }),
    mainEdits,
    rendererEdits,
    composerNeedle,
    composerBindings,
  }),
]);

function firstMatch(source, matcher) {
  if (typeof matcher === 'string') return matcher;
  const flags = matcher.flags.replaceAll('g', '');
  return source.match(new RegExp(matcher.source, flags))?.[0];
}

function fingerprint(profile, mainSource, rendererSource, composerSource) {
  return digest(JSON.stringify({
    id: profile.id,
    // This captures the structural matches, including minified identifiers,
    // without treating full bundle bytes or hashed filenames as a gate.
    main: profile.mainEdits.map(edit => [edit.id, firstMatch(mainSource, edit.matcher)]),
    renderer: rendererSource ? profile.rendererEdits.map(edit => [edit.id, firstMatch(rendererSource, edit.matcher)]) : undefined,
    composer: composerSource ? [profile.composerNeedle, ...profile.composerBindings.map(binding => composerSource.includes(binding))] : undefined,
  }));
}

function profileFor(pkg, mainSource) {
  return VSCODE_COMPATIBILITY_PROFILES.find(profile =>
    pkg?.publisher === profile.extension.publisher &&
    pkg?.name === profile.extension.name &&
    pkg?.type !== 'module' &&
    !mainSource.includes('__TEMP_CODEX_') &&
    !mainSource.includes('temp-codex-inject.cjs') &&
    matchesExactlyOnce(mainSource, profile.mainEdits)
  );
}

function selectBundle(profile, assets, role, test) {
  const matches = assets.filter(asset => test(asset.source));
  if (matches.length !== 1) throw new Error(`Unsupported ${role} bundle layout: expected one ${role} bundle matching ${profile.id}, found ${matches.length}. No files changed.`);
  return matches[0];
}

// `assets` is an installer-provided list of app-initial JavaScript bundles from
// the extension's webview assets folder, after containment validation.
export function detectVSCodeCompatibility(pkg, mainSource, assets = []) {
  const profile = profileFor(pkg, mainSource);
  if (!profile) throw new Error('Unsupported VS Code extension layout or identity. Expected an unpatched CommonJS openai.chatgpt bundle with a known structural profile. No files changed.');
  if (!Array.isArray(assets) || assets.length === 0) return { profile, fingerprint: fingerprint(profile, mainSource) };
  const renderer = selectBundle(profile, assets, 'renderer', source => matchesExactlyOnce(source, profile.rendererEdits));
  const composers = assets.filter(asset =>
    matchCount(asset.source, profile.composerNeedle) === 1 && profile.composerBindings.every(binding => asset.source.includes(binding))
  );
  if (composers.length > 1) throw new Error('Unsupported composer bundle layout: multiple matching composer bundles. No files changed.');
  const composer = composers[0];
  if (composer && renderer.path === composer.path) throw new Error('Unsupported webview bundle layout: renderer and composer resolved to the same file. No files changed.');
  // Recent extensions moved the composer and its bindings. The validated
  // extension/renderer hooks still work, with the status-bar toggle in place
  // of an in-composer control. Never inject into a partial or unrelated match.
  const selectedProfile = composer ? profile : { ...profile, id: `${profile.id}-core` };
  return { profile: selectedProfile, fingerprint: fingerprint(selectedProfile, mainSource, renderer.source, composer?.source), renderer, composer };
}

export function adaptComposerSource(source, profile = VSCODE_COMPATIBILITY_PROFILES[0]) {
  // Full binding validation happens in detectVSCodeCompatibility before the
  // installer calls this transformer. Keep this narrow adapter usable by the
  // existing isolated source harness as well.
  if (matchCount(source, profile.composerNeedle) !== 1 || source.includes('tempCodexComposer')) throw new Error('Unsupported composer layout. No files changed.');
  const helper = fs.readFileSync(new URL('../src/inject/composer-ui.js', import.meta.url), 'utf8');
  const wrapper = `function zKn(e){return tempCodexComposer(e,{React:O$,jsx:k$.jsx,Original:tempCodexOriginalComposer,
context:()=>{const composer=il(Dm).value,scope=il($),{hostId}=Th(FHe());const manager=composer.conversationId==null?null:NC(scope,composer.conversationId);return {kind:composer.kind,hostId:manager?.getHostId()??hostId,ephemeral:manager?.getConversation(composer.conversationId)?.ephemeral,clearPrewarmed:()=>{for(const manager of scope.get(GC))manager.clearPrewarmedThreads();}};},
readMode:()=>xm('temp-codex-get-mode'),writeMode:enabled=>xm('temp-codex-set-mode',{params:{enabled}})});}
`;
  return source.replace(profile.composerNeedle, `${helper}\n${wrapper}function tempCodexOriginalComposer(e){`);
}

export function adaptRendererSource(source, profile = VSCODE_COMPATIBILITY_PROFILES[0]) {
  return applyEdits(source, profile.rendererEdits);
}

export function adaptVSCodeSource(source, pkg) {
  const { profile } = detectVSCodeCompatibility(pkg, source);
  const api = 'globalThis.__TEMP_CODEX_V3__';
  const patched = applyEdits(source, profile.mainEdits, api);
  return `require('./temp-codex-inject.cjs');\n${patched}`;
}
