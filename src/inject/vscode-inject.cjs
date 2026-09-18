'use strict';

const fs = require('fs');
const path = require('path');

// Structured requests are handled before native or WSL serialization.
// No child_process monkey-patching or assumptions about stream chunks.
const connections = new WeakMap();
function state(connection) {
  if (!connections.has(connection)) connections.set(connection, { pending: new Map(), visible: new Set(), prewarmed: new Map(), queues: new Map(), nextQueueId: 0 });
  return connections.get(connection);
}
function enabled() {
  return require('vscode').workspace.getConfiguration('codex').get('temporaryChats', false) === true;
}
async function setEnabled(value) {
  if (typeof value !== 'boolean') throw new Error('Temporary mode must be a boolean.');
  const vscode = require('vscode');
  const config = vscode.workspace.getConfiguration('codex');
  const inspected = config.inspect('temporaryChats');
  const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config.update('temporaryChats', value, target);
  return { enabled: enabled() };
}
function before(connection, provider, uiProvider, id, method, params, prewarm) {
  if (provider !== uiProvider) return { params };
  const current = state(connection);
  const queue = threadId => {
    if (!current.queues.has(threadId)) current.queues.set(threadId, []);
    return current.queues.get(threadId);
  };
  const result = value => {
    connection.providers.get(provider)?.onResult?.({ id, result: value });
    return { blocked: true };
  };
  if (current.visible.has(params?.threadId) && method === 'thread/queue/list') {
    // The Codex server does not persist a queue for ephemeral threads. Keep its
    // equivalent queue in this extension host instead, for this window only.
    return result({ data: queue(params.threadId), nextCursor: null });
  }
  if (current.visible.has(params?.threadId) && method === 'thread/queue/add') {
    const submission = { id: `temp-codex-queue-${++current.nextQueueId}`, input: params.input, clientUserMessageId: params.clientUserMessageId };
    queue(params.threadId).push(submission);
    return result({ queuedSubmission: submission });
  }
  if (current.visible.has(params?.threadId) && method === 'thread/queue/update') {
    const submission = queue(params.threadId).find(entry => entry.id === params.queuedSubmissionId);
    if (!submission) return result({ error: { code: -32600, message: 'Queued temporary message was not found.' } });
    submission.input = params.input;
    return result({ queuedSubmission: submission });
  }
  if (current.visible.has(params?.threadId) && method === 'thread/queue/delete') {
    const entries = queue(params.threadId);
    const index = entries.findIndex(entry => entry.id === params.queuedSubmissionId);
    if (index === -1) return result({ deleted: false });
    entries.splice(index, 1);
    return result({ deleted: true });
  }
  if (current.visible.has(params?.threadId) && method === 'thread/queue/reorder') {
    const entries = queue(params.threadId);
    const ordered = params.queuedSubmissionIds.flatMap(queuedSubmissionId => {
      const entry = entries.find(candidate => candidate.id === queuedSubmissionId);
      return entry ? [entry] : [];
    });
    if (ordered.length !== entries.length) return result({ error: { code: -32600, message: 'Queued temporary message was not found.' } });
    current.queues.set(params.threadId, ordered);
    return result({});
  }
  if (current.visible.has(params?.threadId) && method === 'thread/queue/start') {
    const entries = queue(params.threadId);
    const index = entries.findIndex(entry => entry.id === params.queuedSubmissionId);
    if (index === -1) return result({ error: { code: -32600, message: 'Queued temporary message was not found.' } });
    const [submission] = entries.splice(index, 1);
    // Send the stored input as a normal ephemeral turn. It never reaches the
    // server's persisted queue and is discarded with this extension window.
    return { method: 'turn/start', params: { threadId: params.threadId, input: submission.input } };
  }
  if (method === 'turn/start' && current.prewarmed.has(params?.threadId)) {
    if (current.prewarmed.get(params.threadId) !== enabled()) {
      connection.providers.get(provider)?.onResult?.({ id, error: { code: -32600, message: 'This chat was prewarmed in a different storage mode. Reload the window and start a new chat.' } });
      return { blocked: true };
    }
    current.prewarmed.delete(params.threadId);
  }
  if (method === 'thread/startAeon' && enabled()) {
    connection.providers.get(provider)?.onResult?.({ id, error: { code: -32600, message: 'Temporary chats do not support this thread type. Turn temporary mode off to continue.' } });
    return { blocked: true };
  }
  if (method !== 'thread/start' && method !== 'thread/fork') return { params };
  const temporary = enabled();
  const next = temporary ? { ...params, ephemeral: true } : params;
  current.pending.set(`${provider}:${id}`, { temporary, prewarm });
  return { params: next };
}
function receive(connection, message) {
  const current = state(connection);
  if (current.pending.has(message.id) && ('result' in message || 'error' in message)) {
    const request = current.pending.get(message.id);
    current.pending.delete(message.id);
    if (!message.error) {
      const thread = message.result?.thread;
      if (request.temporary && (!thread?.id || thread.ephemeral !== true)) {
        return { id: message.id, error: { code: -32603, message: 'The server did not confirm an ephemeral thread. Temporary chat creation was stopped.' } };
      }
      if (request.temporary) current.visible.add(thread.id);
      if (request.prewarm && thread?.id) current.prewarmed.set(thread.id, thread.ephemeral === true);
    }
  }
  if (message.method === 'thread/deleted') {
    current.visible.delete(message.params?.threadId);
    current.prewarmed.delete(message.params?.threadId);
    current.queues.delete(message.params?.threadId);
  }
  return message;
}
const api = { enabled, setEnabled, before, receive, visible: (connection, id) => state(connection).visible.has(id), reset: connection => connections.delete(connection) };
module.exports = api;
globalThis.__TEMP_CODEX_V3__ = api;

queueMicrotask(() => {
  const vscode = require('vscode');
  const reloadMarker = path.join(__dirname, '..', '.temp-codex-reload-once');
  if (fs.existsSync(reloadMarker)) {
    // File-watcher notifications can arrive after the user's first reload. Remove
    // the marker before requesting one clean reload, so this can never loop.
    try {
      fs.unlinkSync(reloadMarker);
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch { /* A manual reload remains safe if VS Code cannot run the command. */ }
  }
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
  item.command = 'chatgpt.tempCodex.toggle';
  item.name = 'Codex Temporary Chats';
  const render = () => {
    item.text = enabled() ? '$(shield) Codex Temporary: ON' : '$(history) Codex Temporary: OFF';
    item.tooltip = 'Applies when a new thread is created. Existing and already prewarmed threads keep their original mode. File edits remain real.';
    item.show();
  };
  vscode.commands.registerCommand('chatgpt.tempCodex.toggle', async () => {
    const config = vscode.workspace.getConfiguration('codex');
    const inspected = config.inspect('temporaryChats');
    const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('temporaryChats', !enabled(), target);
    render();
    vscode.window.showInformationMessage('Temporary mode applies to newly created threads. Reload the window before starting a chat to discard already prewarmed threads.');
  });
  vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('codex.temporaryChats')) render(); });
  render();
});
