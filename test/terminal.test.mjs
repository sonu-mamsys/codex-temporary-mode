import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CodexAppServer, RpcError, startTemporaryThread, runTurn, resolveCodex } from '../lib/app-server.mjs';
import { parseArgs, verifyGone } from '../lib/terminal.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fake = path.join(root, 'fixtures/fake-codex.cjs');
function directory(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'temp-codex-terminal-'));
  t.after(() => {
    assert.equal(fs.realpathSync(dir), dir);
    assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir()));
    assert(path.basename(dir).startsWith('temp-codex-terminal-'));
    fs.rmSync(dir, { recursive: true });
  });
  return dir;
}
async function server(t, mode = '', requestTimeout = 1000) {
  const home = directory(t);
  const server = new CodexAppServer({ launch: { command: process.execPath, args: [fake] }, env: { ...process.env, TEMP_CODEX_FAKE_MODE: mode, TEMP_CODEX_FAKE_HOME: home }, requestTimeout });
  t.after(() => server.stop());
  await server.start();
  return server;
}

test('temporary creation fails closed on false, missing flag or persisted path', async t => {
  for (const mode of ['persistent', 'unconfirmed', 'path']) {
    const app = await server(t, mode);
    await assert.rejects(startTemporaryThread(app, { cwd: root }), /did not confirm/);
    await app.stop();
  }
});

test('multiple turns and events arriving before start response use exact thread and turn IDs', async t => {
  const app = await server(t, 'early');
  const thread = await startTemporaryThread(app, { cwd: root });
  let output = '';
  for (const text of ['first', 'second']) await runTurn(app, thread.id, text, { write: text => { output += text; } });
  assert.equal(output, 'first\nsecond\n');
  assert.equal(app.listenerCount('notification'), 0);
  assert.equal(app.listenerCount('disconnect'), 0);
  await app.stop();
});

test('rejected starts, failed turns, malformed output and disconnects terminate without hanging', async t => {
  for (const mode of ['reject', 'failed', 'disconnect', 'malformed']) {
    const app = await server(t, mode);
    const thread = await startTemporaryThread(app, { cwd: root });
    await assert.rejects(runTurn(app, thread.id, 'test', { write() {}, timeout: 500 }), /rejected|failed|exited|closed|JSON/);
    assert.equal(app.listenerCount('notification'), 0);
    await app.stop();
  }
});

test('missing response and turn deadline reject and release listeners', async t => {
  const app = await server(t, 'timeout');
  const thread = await startTemporaryThread(app, { cwd: root });
  await assert.rejects(runTurn(app, thread.id, 'test', { timeout: 25 }), /timed out/);
  assert.equal(app.pending.size, 0);
  assert.equal(app.listenerCount('notification'), 0);
  await app.stop();
});

test('child launch errors reject initialization and close cleanly', async () => {
  const app = new CodexAppServer({ launch: { command: path.join(root, 'missing-executable'), args: [] } });
  await assert.rejects(app.start(), /Unable to start/);
  await app.stop();
});

test('RPC timeout rejects pending requests without waiting for a turn', async t => {
  const app = await server(t);
  app.requestTimeout = 25;
  await assert.rejects(app.request('unanswered'), /request timed out/);
  assert.equal(app.pending.size, 0);
  await app.stop();
});

test('interactive approval requests receive an unsupported error, never approval', () => {
  const app = new CodexAppServer();
  let response;
  app.proc = { stdin: { writable: true, write: line => { response = JSON.parse(line); } } };
  app.handleLine(JSON.stringify({ id: 9, method: 'item/commandExecution/requestApproval', params: {} }));
  assert.equal(response.id, 9);
  assert.equal(response.error.code, -32601);
  assert.equal(response.result, undefined);
});

test('CLI preserves piped lines, resets the server for /new and reports verified status', t => {
  const home = directory(t), audit = path.join(home, 'audit.jsonl');
  const result = spawnSync(process.execPath, [path.join(root, 'ghostthread.mjs'), '--codex-path', fake], {
    input: 'first\n/status\n/new\nsecond\n/exit\n', encoding: 'utf8', timeout: 10000,
    env: { ...process.env, TEMP_CODEX_FAKE_HOME: home, TEMP_CODEX_FAKE_AUDIT: audit },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Server-confirmed ephemeral: true/);
  assert.match(result.stdout, /codex> first/); assert.match(result.stdout, /codex> second/);
  const calls = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse);
  const starts = calls.filter(call => call.method === 'thread/start');
  assert.equal(starts.length, 2); assert.notEqual(starts[0].pid, starts[1].pid);
  for (const call of starts) { assert.equal(call.params.ephemeral, true); assert.equal(call.params.sandbox, 'read-only'); }
});

test('verification includes a completed turn and a fresh-server absence check', t => {
  const home = directory(t);
  const result = spawnSync(process.execPath, [path.join(root, 'ghostthread.mjs'), '--codex-path', fake, '--verify', 'MARKER'], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, TEMP_CODEX_FAKE_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /PASS:/); assert.match(result.stdout, /MARKER/);
});

test('absence checks do not treat arbitrary errors or readable threads as success', async t => {
  const home = directory(t);
  for (const error of [new Error('disconnected'), new RpcError({ code: -32601, message: 'method not found' }), new RpcError({ code: -32600, message: 'not authenticated' })]) {
    await assert.rejects(verifyGone({ request: async () => { throw error; } }, home, 'thread-id'));
  }
  await assert.rejects(verifyGone({ request: async () => ({ thread: {} }) }, home, 'thread-id'), /readable/);
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'sessions', 'rollout-thread-id.jsonl'), '');
  await assert.rejects(verifyGone({ request: async () => { throw new RpcError({ code: -32600, message: 'thread not found' }); } }, home, 'thread-id'), /session file/);
});

test('argument validation catches missing values, unknown flags and conflicting modes', () => {
  for (const args of [['-C'], ['-m'], ['--unknown'], ['--timeout', 'abc'], ['--timeout', '0'], ['--read-only', '--workspace-write']]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(['--', '--not-an-option']).prompt, '--not-an-option');
  assert.equal(parseArgs(['--workspace-write']).sandbox, 'workspace-write');
});

test('executable resolution handles spaces and npm Windows shims without a shell', t => {
  const dir = directory(t), npm = path.join(dir, 'npm with spaces');
  fs.mkdirSync(path.join(npm, 'node_modules/@openai/codex/bin'), { recursive: true });
  fs.writeFileSync(path.join(npm, 'codex.cmd'), 'not executed');
  const js = path.join(npm, 'node_modules/@openai/codex/bin/codex.js'); fs.writeFileSync(js, '');
  assert.deepEqual(resolveCodex(undefined, { PATH: npm }, 'win32'), { command: process.execPath, args: [js] });
  assert.throws(() => resolveCodex(undefined, { PATH: dir }, 'win32'), /not found/);
});
