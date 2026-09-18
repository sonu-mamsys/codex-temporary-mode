import fs from 'node:fs';
// Deliberately version-specific: fail before writing if the host routing changes.
export const SUPPORTED_VSCODE_VERSION = '26.908.40401';
export const RENDERER_PATH = 'webview/assets/app-initial-bca4f920746a.js';
export const COMPOSER_PATH = 'webview/assets/app-initial-1e5ee25fb4ec.js';

export function adaptComposerSource(source) {
  const needle = 'function zKn(e){';
  if (source.split(needle).length !== 2 || source.includes('tempCodexComposer')) throw new Error('Unsupported composer layout. No files changed.');
  const helper = fs.readFileSync(new URL('../src/inject/composer-ui.js', import.meta.url), 'utf8');
  const wrapper = `function zKn(e){return tempCodexComposer(e,{React:O$,jsx:k$.jsx,Original:tempCodexOriginalComposer,
context:()=>{const composer=il(Dm).value,scope=il($),{hostId}=Th(FHe());const manager=composer.conversationId==null?null:NC(scope,composer.conversationId);return {kind:composer.kind,hostId:manager?.getHostId()??hostId,ephemeral:manager?.getConversation(composer.conversationId)?.ephemeral,clearPrewarmed:()=>{for(const manager of scope.get(GC))manager.clearPrewarmedThreads();}};},
readMode:()=>xm('temp-codex-get-mode'),writeMode:enabled=>xm('temp-codex-set-mode',{params:{enabled}})});}
`;
  return source.replace(needle, `${helper}\n${wrapper}function tempCodexOriginalComposer(e){`);
}

export function adaptRendererSource(source) {
  const edits = [
    ['ephemeral:d.ephemeral,sideConversation:d.ephemeral', 'ephemeral:v.thread.ephemeral===!0||d.ephemeral,sideConversation:d.ephemeral'],
    // Fork state must also use the server's storage mode for resume and routing.
    ['function n6t(e,{conversationId:t,forkResponse:n,hostMode:r,threadRecognition:i,params:a,product:o,sourceConversation:s}){',
      'function n6t(e,{conversationId:t,forkResponse:n,hostMode:r,threadRecognition:i,params:a,product:o,sourceConversation:s}){a={...a,ephemeral:n.thread.ephemeral===!0||a.ephemeral};'],
  ];
  for (const [needle, replacement] of edits) {
    if (source.split(needle).length !== 2) throw new Error('Unsupported renderer layout. No files changed.');
    source = source.replace(needle, replacement);
  }
  return source;
}

export function adaptVSCodeSource(source, pkg) {
  if (pkg.publisher !== 'openai' || pkg.name !== 'chatgpt' || pkg.version !== SUPPORTED_VSCODE_VERSION || pkg.type === 'module') {
    throw new Error(`Unsupported VS Code extension. Expected openai.chatgpt ${SUPPORTED_VSCODE_VERSION} (CommonJS). No files changed.`);
  }
  const api = 'globalThis.__TEMP_CODEX_V3__';
  const edits = [
    ['"get-settings":()=>this.settings.readAll(),', `"temp-codex-get-mode":()=>({enabled:${api}.enabled()}),"temp-codex-set-mode":({enabled})=>${api}.setEnabled(enabled),"get-settings":()=>this.settings.readAll(),`],
    ['sendProviderRequest(e,r,n,o,i,s){', `sendProviderRequest(e,r,n,o,i,s){const __tc=${api}.before(this,e,ES,r,n,o,i);if(__tc.blocked)return;n=__tc.method??n;o=__tc.params;`],
    ['routeIncomingMessage(e,r=e){', `routeIncomingMessage(e,r=e){e=${api}.receive(this,e);`],
    ['if(n==="thread/started"&&i!=null&&Eyt(i))', `if(n==="thread/started"&&i!=null&&Eyt(i)&&!${api}.visible(this,i.id))`],
    ['if(s&&this.ephemeralThreadTimeouts.has(s))', `if(s&&this.ephemeralThreadTimeouts.has(s)&&!${api}.visible(this,s))`],
    ['teardownProcess(){', `teardownProcess(){${api}.reset(this);`],
  ];
  if (source.includes('__TEMP_CODEX_') || source.includes('temp-codex-inject.cjs')) {
    throw new Error('Extension already contains a patch. Restore it before patching.');
  }
  for (const [needle, replacement] of edits) {
    if (source.split(needle).length !== 2) throw new Error(`Unsupported extension layout: ${needle}. No files changed.`);
    source = source.replace(needle, replacement);
  }
  return `require('./temp-codex-inject.cjs');\n${source}`;
}
