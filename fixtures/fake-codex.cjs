// Test-only protocol server. No model calls or credentials.
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const mode = process.env.TEMP_CODEX_FAKE_MODE;
const threadId = `test-thread-${process.pid}`;
let turnNumber = 0;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const input = createInterface({ input: process.stdin });
input.on('close', () => process.exit(0));
input.on('line', line => {
  const request = JSON.parse(line);
  if (process.env.TEMP_CODEX_FAKE_AUDIT) fs.appendFileSync(process.env.TEMP_CODEX_FAKE_AUDIT, JSON.stringify({ pid: process.pid, ...request }) + '\n');
  if (request.method === 'initialize') return send({ id: request.id, result: { codexHome: process.env.TEMP_CODEX_FAKE_HOME } });
  if (request.method === 'thread/start') return send({ id: request.id, result: { thread: { id: threadId, ephemeral: mode === 'persistent' ? false : mode === 'unconfirmed' ? undefined : true, path: mode === 'path' ? 'saved.jsonl' : null } } });
  if (request.method === 'thread/resume') return send({ id: request.id, error: { code: -32600, message: `no rollout found for thread id ${request.params.threadId}` } });
  if (request.method !== 'turn/start') return;
  if (mode === 'reject') return send({ id: request.id, error: { code: -32600, message: 'test start rejected' } });
  if (mode === 'disconnect') return process.exit(9);
  if (mode === 'malformed') return process.stdout.write('bad-json\n');
  if (mode === 'timeout') return;
  const id = `turn-${++turnNumber}`;
  const events = () => {
    send({ method: 'item/agentMessage/delta', params: { threadId: 'another-thread', turnId: id, delta: 'WRONG THREAD' } });
    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'old-turn', delta: 'WRONG TURN' } });
    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: id, delta: request.params.input[0].text } });
    send({ method: 'turn/completed', params: { threadId, turn: { id, status: mode === 'failed' ? 'failed' : 'completed', items: [] } } });
  };
  if (mode === 'early') events();
  send({ id: request.id, result: { turn: { id } } });
  if (mode !== 'early') events();
});
