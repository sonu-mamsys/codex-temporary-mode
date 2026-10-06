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

function applyEdits(source, edits, api, uiProvider) {
  for (const edit of edits) {
    if (matchCount(source, edit.matcher) !== 1) throw new Error(`Unsupported ${edit.area} layout: ${edit.id}. No files changed.`);
    source = source.replace(edit.matcher, (...args) => edit.replace(args, api, uiProvider));
  }
  return source;
}

function uiProviderSymbol(source) {
  const registration = new RegExp(`this\\.codexMcpConnection\\.registerProvider\\((${identifier}),\\{onInitialized:`);
  if (matchCount(source, registration) !== 1) return null;
  const symbol = source.match(registration)?.[1];
  const dispatches = [
    `this.codexMcpConnection.sendRequest(${symbol},String(n),o,i,r.retainResponse)`,
    `this.codexMcpConnection.prewarmThreadStart(${symbol},String(n),o,r.retainResponse)`,
  ];
  return dispatches.every(dispatch => matchCount(source, dispatch) === 1) ? symbol : null;
}

const mainEdits = Object.freeze([
  Object.freeze({ area: 'extension', id: 'settings-rpc', matcher: '"get-settings":()=>this.settings.readAll(),', replace: (_args, api) => `"temp-codex-get-mode":()=>({enabled:${api}.enabled()}),"temp-codex-set-mode":({enabled})=>${api}.setEnabled(enabled),"get-settings":()=>this.settings.readAll(),` }),
  Object.freeze({ area: 'extension', id: 'outbound-request', matcher: 'sendProviderRequest(e,r,n,o,i,s){', replace: (_args, api, uiProvider) => `sendProviderRequest(e,r,n,o,i,s){const __tc=${api}.before(this,e,${uiProvider},r,n,o,i);if(__tc.blocked)return;n=__tc.method??n;o=__tc.params;` }),
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

// Match the response/record relationship, not the generated variable names.
// The surrounding fields are intentional guards against unrelated ephemeral
// flags. Reviewed against Codex 26.930.51102; ambiguous matches still fail closed.
const responseStorageEdit = Object.freeze({
  area: 'renderer', id: 'thread-storage-mode',
  matcher: new RegExp(`sessionId:(${identifier})\\.thread\\.sessionId,shellEnvironmentPolicy:(${identifier})\\.shellEnvironmentPolicy,codexAppEnabledToolNames:\\2\\.codexAppEnabledToolNames,forkedFromId:\\1\\.thread\\.forkedFromId==null\\?null:(${identifier})\\(\\1\\.thread\\.forkedFromId\\),ephemeral:(${identifier})\\.ephemeral,sideConversation:\\4\\.ephemeral`),
  replace: args => args[0].replace(`ephemeral:${args[4]}.ephemeral,`, `ephemeral:${args[1]}.thread.ephemeral===!0||${args[4]}.ephemeral,`),
});
const responseRendererEdits = Object.freeze([responseStorageEdit, rendererEdits[1]]);

const composerNeedle = 'function zKn(e){';
const composerBindings = Object.freeze(['O$', 'k$.jsx', 'il(Dm)', 'il($)', 'Th(FHe())', 'NC(scope,composer.conversationId)', 'scope.get(GC)', 'xm(']);

// Xxi is the Codex composer adapter shared by home, new-thread panel, and
// local conversation routes. The generic F4n layout root also serves ChatGPT.
const sharedComposerNeedle = 'function Xxi(e){';
const sharedComposerBody = 'children:(0,X5.jsx)(uY.Body,{ref:Jd(uo===`auto-single-line`?nc:null,Aa),animateHeight:Gt&&we!=="default"&&je==null,layout:qc,children:pee})';
const sharedComposerBindings = Object.freeze([
  'Fe=ma(rf),Ie=ma($)',
  'rt=qf(Fe)',
  'st=kl(pA,it)',
  'ot=eH(it)',
  'localThreadPrewarmReservation:Re',
  'localThreadPrewarmReservation:ce,localWorkspaceMaterialization:le}){',
  'xht as Eg',
  'Z5=ml()',
  'Q5=Q()',
  '"data-codex-composer-root":``',
  'children:[nn,gn]',
  sharedComposerBody,
]);

const currentComposerNeedle = 'function Nha(e){';
const currentComposerBody = 'children:(0,r9.jsx)(Gj.Body,{ref:H_(Ao===`auto-single-line`?cee:null,Qa),animateHeight:tn&&Le!=="default"&&Je==null,layout:Sc?.isActive&&Sc.showTranscript?`multiline`:ul,children:_l})';
const currentComposerBindings = Object.freeze([
  'Ge=Wl(lg),Ke=Wl($)', 'mt=c_(Ge)', 'vt=bY(ht)', 'yt=Qd(Nj,ht)',
  'localThreadPrewarmReservation:ve,localWorkspaceMaterialization:ye}){',
  'F0t as qp', 'n9=ad()', 'r9=bs()',
  '"data-codex-composer-root":``', 'children:[En,Gn]', currentComposerBody,
]);
const currentComposerRuntime = Object.freeze({
  context: 'composer=Wl(lg),conversationId=c_(composer),hostId=Qd(Nj,conversationId),manager=bY(conversationId)',
  react: 'n9', jsx: 'r9', rpc: 'qp', body: currentComposerBody,
  bodyComponent: 'Gj.Body', children: '_l', reservation: 've',
});


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
    uiProvider: uiProviderSymbol(mainSource),
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
    uiProviderSymbol(mainSource) != null &&
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
  const renderer = selectBundle(profile, assets, 'renderer', source =>
    [profile.rendererEdits, responseRendererEdits].filter(edits => matchesExactlyOnce(source, edits)).length === 1);
  const selectedRendererEdits = matchesExactlyOnce(renderer.source, responseRendererEdits) ? responseRendererEdits : profile.rendererEdits;
  const composerLayouts = [
    { needle: profile.composerNeedle, bindings: profile.composerBindings, id: profile.id },
    { needle: sharedComposerNeedle, bindings: sharedComposerBindings, id: `${profile.id}-shared-composer` },
    { needle: currentComposerNeedle, bindings: currentComposerBindings, runtime: currentComposerRuntime, id: `${profile.id}-26-930-shared-composer` },
  ];
  const composers = composerLayouts.flatMap(layout => assets.filter(asset =>
    matchCount(asset.source, layout.needle) === 1 && layout.bindings.every(binding => asset.source.includes(binding))
  ).map(asset => ({ asset, layout })));
  if (composers.length !== 1) throw new Error(`Unsupported composer bundle layout: expected one verified composer bundle, found ${composers.length}. No files changed.`);
  const { asset: composer, layout: composerLayout } = composers[0];
  if (composer && renderer.path === composer.path) throw new Error('Unsupported webview bundle layout: renderer and composer resolved to the same file. No files changed.');
  const selectedProfile = { ...profile, id: composerLayout.id, rendererEdits: selectedRendererEdits, composerNeedle: composerLayout.needle, composerBindings: composerLayout.bindings, composerRuntime: composerLayout.runtime };
  return { profile: selectedProfile, fingerprint: fingerprint(selectedProfile, mainSource, renderer.source, composer.source), renderer, composer };
}

export function adaptComposerSource(source, profile = VSCODE_COMPATIBILITY_PROFILES[0]) {
  if (matchCount(source, profile.composerNeedle) !== 1 ||
      !profile.composerBindings.every(binding => source.includes(binding)) ||
      source.includes('tempCodexComposer')) throw new Error('Unsupported composer layout. No files changed.');
  const helper = fs.readFileSync(new URL('../src/inject/composer-ui.js', import.meta.url), 'utf8');
  if (profile.composerNeedle === composerNeedle) {
    const wrapper = `function zKn(e){return tempCodexComposer(e,{React:O$,jsx:k$.jsx,Original:tempCodexOriginalComposer,
context:()=>{const composer=il(Dm).value,scope=il($),{hostId}=Th(FHe());const manager=composer.conversationId==null?null:NC(scope,composer.conversationId);return {kind:composer.kind,hostId:manager?.getHostId()??hostId,ephemeral:manager?.getConversation(composer.conversationId)?.ephemeral,clearPrewarmed:()=>{for(const manager of scope.get(GC))manager.clearPrewarmedThreads();}};},
readMode:()=>xm('temp-codex-get-mode'),writeMode:enabled=>xm('temp-codex-set-mode',{params:{enabled}})});}
`;
    return source.replace(profile.composerNeedle, `${helper}\n${wrapper}function tempCodexOriginalComposer(e){`);
  }
  const runtime = profile.composerRuntime || {
    context: 'composer=ma(rf),conversationId=qf(composer),hostId=kl(pA,conversationId),manager=eH(conversationId)',
    react: 'Z5', jsx: 'Q5', rpc: 'Eg', body: sharedComposerBody,
    bodyComponent: 'uY.Body', bodyJsx: 'X5', children: 'pee', reservation: 'ce',
  };
  const nativeControl = `function tempCodexNativeComposerControl({reservation}){
const ${runtime.context},root=${runtime.react}.useRef(null),previousInert=${runtime.react}.useRef(null);
const restore=()=>{const prior=previousInert.current;if(prior){prior.element.inert=prior.inert;previousInert.current=null}};
${runtime.react}.useEffect(()=>restore,[]);
return tempCodexComposer({ref:root},{React:${runtime.react},jsx:${runtime.jsx}.jsx,Original:'div',embedded:true,
context:()=>({kind:composer.value.kind==='local'&&composer.value.conversationId==null?'new':composer.value.kind,hostId,
ephemeral:conversationId==null?false:manager.getConversation(conversationId)?.ephemeral,
clearPrewarmed:()=>{reservation.clear();return manager.clearPrewarmedThreads()},
setComposerInert:enabled=>{if(!enabled){restore();return}const element=root.current?.closest('[data-codex-composer-root]');if(element&&!previousInert.current){previousInert.current={element,inert:element.inert};element.inert=true}}}),
readMode:()=>${runtime.rpc}('temp-codex-get-mode'),writeMode:enabled=>${runtime.rpc}('temp-codex-set-mode',{params:{enabled}})});
}\n`;
  // Render inside the bordered native body, before its attachments and input.
  // Keep the original outer root and footer intact; no DOM moves or overlays.
  if (matchCount(source, runtime.body) !== 1) throw new Error('Unsupported composer body layout. No files changed.');
  const jsx = runtime.bodyJsx || runtime.jsx;
  const embeddedBody = runtime.body.replace(`(0,${jsx}.jsx)(${runtime.bodyComponent}`, `(0,${jsx}.jsxs)(${runtime.bodyComponent}`)
    .replace(`children:${runtime.children}`, `children:[(0,${jsx}.jsx)(tempCodexNativeComposerControl,{reservation:${runtime.reservation}}),${runtime.children}]`);
  return `${helper}\n${nativeControl}${source.replace(runtime.body, embeddedBody)}`;
}


export function adaptRendererSource(source, profile = VSCODE_COMPATIBILITY_PROFILES[0]) {
  return applyEdits(source, profile.rendererEdits);
}

export function adaptVSCodeSource(source, pkg) {
  const { profile } = detectVSCodeCompatibility(pkg, source);
  const api = 'globalThis.__TEMP_CODEX_V3__';
  const patched = applyEdits(source, profile.mainEdits, api, uiProviderSymbol(source));
  return `require('./temp-codex-inject.cjs');\n${patched}`;
}
