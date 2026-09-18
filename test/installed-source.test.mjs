// Optional, read-only verification against a real extension bundle.
// TEMP_CODEX_REVIEW_EXTENSION must point to its installation directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { adaptVSCodeSource, adaptRendererSource, adaptComposerSource, RENDERER_PATH, COMPOSER_PATH } from '../lib/vscode-adapter.mjs';
import { spawnSync } from 'node:child_process';

test('real composer adapter parses and matches installed UI', { skip: !process.env.TEMP_CODEX_REVIEW_EXTENSION }, () => {
  const file = path.join(process.env.TEMP_CODEX_REVIEW_EXTENSION, COMPOSER_PATH);
  const original = fs.readFileSync(fs.existsSync(`${file}.temp-codex.bak`) ? `${file}.temp-codex.bak` : file, 'utf8');
  const patched = adaptComposerSource(original);
  if (fs.existsSync(`${file}.temp-codex.bak`)) assert.equal(fs.readFileSync(file, 'utf8'), patched);
  const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: patched, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('installed extension routing delivers user temporary events and hides internal ones', { skip: !process.env.TEMP_CODEX_REVIEW_EXTENSION }, () => {
  const root = process.env.TEMP_CODEX_REVIEW_EXTENSION;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const main = path.join(root, pkg.main);
  const installed = fs.readFileSync(main, 'utf8');
  const hasPatch = fs.existsSync(path.join(root, '.temp-codex-v3.json'));
  const original = hasPatch ? fs.readFileSync(`${main}.temp-codex.bak`, 'utf8') : installed;
  const patched = adaptVSCodeSource(original, pkg);
  if (hasPatch) assert.equal(installed, patched, 'Installed adapter must match the tested source transformation');
  new vm.Script(patched);
  const classStart = patched.indexOf('vI=class{');
  const classEnd = patched.indexOf(';function Eyt', classStart);
  assert(classStart > 0 && classEnd > classStart);
  const context = vm.createContext({
    module: { exports: {} }, queueMicrotask() {},
    require: name => {
      if (name === 'fs') return fs;
      if (name === 'path') return path;
      assert.equal(name, 'vscode');
      return { workspace: { getConfiguration: () => ({ get: () => true }) } };
    },
    ES: 'ui', SA: () => false, hf: x => x, Eyt: t => t.ephemeral === true,
    BA: p => p?.thread ?? null, _f: p => p?.thread?.id ?? p?.threadId ?? null,
    nq: e => e.result?.thread ?? null, oG: () => true,
  });
  vm.runInContext(fs.readFileSync(new URL('../src/inject/vscode-inject.cjs', import.meta.url), 'utf8'), context);
  const Host = vm.runInContext(`(${patched.slice(classStart + 3, classEnd)})`, context);
  // No host constructor, modules, child processes, timers, UI or credentials run.
  const host = Object.create(Host.prototype);
  const events = [];
  Object.assign(host, {
    providers: new Map([['ui', { onResult: e => events.push(e), onNotification: e => events.push(e) }]]),
    pendingRequests: new Map(), pendingTurnStartRequestIds: new Set(), pendingPrewarmedThreadStartRequestIds: new Set(),
    internalNotificationHandlers: new Set(), ephemeralThreadTimeouts: new Map(),
    requestUserInputAutoResolutionCoordinator: { observeServerNotification() {} },
    prewarmedThreads: { suppressThreadStarted: () => false },
    recordLastOutboundMethod() {}, sendMessage(m) { this.sent = m; return true; },
    markEphemeralThreadId(id) { this.ephemeralThreadTimeouts.set(id, true); },
  });
  host.sendProviderRequest('ui', '1', 'thread/start', {});
  assert.equal(host.sent.params.ephemeral, true);
  host.routeIncomingMessage({ id: 'ui:1', result: { thread: { id: 'temp', ephemeral: true } } });
  assert.equal(host.routeIncomingMessage({ method: 'thread/started', params: { thread: { id: 'temp', ephemeral: true } } }).routeKind, 'notification');
  for (const method of ['item/agentMessage/delta', 'turn/completed']) {
    assert.equal(host.routeIncomingMessage({ method, params: { threadId: 'temp' } }).routeKind, 'notification');
    assert.equal(events.at(-1).method, method);
  }
  assert.equal(host.routeIncomingMessage({ method: 'thread/started', params: { thread: { id: 'internal', ephemeral: true } } }).routeKind, 'notification_ephemeral_thread_started');
  assert.equal(host.routeIncomingMessage({ method: 'turn/completed', params: { threadId: 'internal' } }).routeKind, 'notification_dropped_ephemeral');
});

test('real renderer storage-mode mapping feeds its existing history exclusion', { skip: !process.env.TEMP_CODEX_REVIEW_EXTENSION }, () => {
  const root = process.env.TEMP_CODEX_REVIEW_EXTENSION;
  const file = path.join(root, RENDERER_PATH);
  const original = fs.readFileSync(fs.existsSync(`${file}.temp-codex.bak`) ? `${file}.temp-codex.bak` : file, 'utf8');
  const patched = adaptRendererSource(original);
  if (fs.existsSync(`${file}.temp-codex.bak`)) assert.equal(fs.readFileSync(file, 'utf8'), patched);
  const mapping = patched.match(/ephemeral:v\.thread\.ephemeral===!0\|\|d\.ephemeral,sideConversation:d\.ephemeral/)[0];
  const create = new Function('v', 'd', `return {${mapping}}`);
  const historySource = fs.readFileSync(path.join(root, 'webview/assets/app-initial-1e5ee25fb4ec.js'), 'utf8');
  const filter = historySource.match(/e\.filter\(e=>e\.ephemeral!==!0\)/)[0];
  const saveHistory = new Function('e', `return ${filter}`);
  const temporary = create({ thread: { ephemeral: true } }, { ephemeral: false });
  const normal = create({ thread: { ephemeral: false } }, { ephemeral: false });
  assert.deepEqual(saveHistory([temporary, normal]), [normal]);
  assert.equal(temporary.sideConversation, false);
});
