import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export function resolveCodex(explicit, env = process.env, platform = process.platform) {
  const fromFile = file => {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    if (/\.[cm]?js$/i.test(file)) return { command: process.execPath, args: [file] };
    if (/\.(cmd|bat|ps1)$/i.test(file)) {
      // npm's Windows shim is a shell script; invoke its JavaScript entry point directly.
      const entry = path.join(path.dirname(file), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      return fs.existsSync(entry) ? { command: process.execPath, args: [entry] } : null;
    }
    return { command: file, args: [] };
  };
  if (explicit) {
    const found = fromFile(path.resolve(explicit));
    if (!found) throw new Error('Invalid --codex-path. Use the Codex executable or its npm codex.js entry point.');
    return found;
  }
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const name of platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']) {
      const found = fromFile(path.join(dir.replace(/^"|"$/g, ''), name));
      if (found) return found;
    }
  }
  throw new Error('Codex was not found on PATH. Install @openai/codex, run codex login, or pass --codex-path.');
}

export class RpcError extends Error {
  constructor(error) { super(error.message || 'Codex request failed'); this.code = error.code; }
}

export class CodexAppServer extends EventEmitter {
  constructor({ launch, env = process.env, requestTimeout = 30000, spawnProcess = spawn } = {}) {
    super();
    Object.assign(this, { launch, env, requestTimeout, spawnProcess });
    this.pending = new Map(); this.nextId = 1; this.proc = null; this.failure = null;
  }

  async start() {
    if (this.proc) throw new Error('App server already started.');
    const launch = this.launch || resolveCodex(undefined, this.env);
    this.proc = this.spawnProcess(launch.command, [...launch.args, 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: this.env,
      detached: process.platform !== 'win32',
    });
    this.closed = new Promise(resolve => this.proc.once('close', resolve));
    this.proc.on('error', error => this.fail(new Error(`Unable to start Codex: ${error.message}`)));
    this.proc.on('exit', (code, signal) => this.fail(new Error(`Codex app-server exited (${signal || code || 0}).`)));
    this.proc.stdin.on('error', error => this.fail(error));
    this.proc.stdout.on('error', error => this.fail(error));
    this.proc.stderr.on('data', () => {}); // Drain diagnostics without retaining prompts or credentials.
    this.lines = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => this.handleLine(line));
    this.lines.on('close', () => this.fail(new Error('Codex app-server closed its output.')));
    const result = await this.request('initialize', {
      clientInfo: { name: 'codex-temporary-mode', title: 'codex-temporary-mode', version: '3.2.3' },
      capabilities: { experimentalApi: false },
    });
    this.notify('initialized', {});
    return result;
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('disconnect', error);
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return this.fail(new Error('Invalid JSON from Codex app-server.')); }
    if (!message || typeof message !== 'object') return;
    if (message.method && Object.hasOwn(message, 'id')) {
      // Never silently approve commands, permission elevation or interactive tools.
      try { this.send({ id: message.id, error: { code: -32601, message: 'Interactive server requests are not supported by codex-temporary-mode.' } }); }
      catch (error) { this.fail(error); }
    } else if (Object.hasOwn(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new RpcError(message.error));
      else pending.resolve(message.result);
    } else if (message.method) this.emit('notification', message.method, message.params || {});
  }

  send(message) {
    if (this.failure) throw this.failure;
    if (!this.proc?.stdin?.writable) throw new Error('Codex app-server is not writable.');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }
  notify(method, params) { this.send({ method, params }); }
  request(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Codex request timed out: ${method}`)), this.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async stop() {
    if (this.stopping) return this.stopping;
    this.isStopping = true;
    this.stopping = this.stopProcess();
    return this.stopping;
  }
  async stopProcess() {
    this.fail(new Error('Temporary session closed.'));
    if (!this.proc) return;
    this.proc.stdin.end();
    // The owned process normally exits on EOF. Bound shutdown if a tool is stuck.
    const timer = setTimeout(() => {
      if (this.proc.exitCode !== null || this.proc.signalCode) return;
      if (process.platform === 'win32' && this.proc.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        killer.on('error', () => this.proc.kill());
      } else {
        try { process.kill(-this.proc.pid, 'SIGKILL'); }
        catch { this.proc.kill('SIGKILL'); }
      }
    }, 1500);
    try { await this.closed; } finally { clearTimeout(timer); this.lines?.close(); }
  }
}

export async function startTemporaryThread(server, { cwd, sandbox = 'read-only', model } = {}) {
  const result = await server.request('thread/start', {
    cwd, sandbox, approvalPolicy: 'never', ephemeral: true, ...(model ? { model } : {}),
  });
  const thread = result?.thread;
  if (typeof thread?.id !== 'string' || !thread.id || thread.ephemeral !== true || thread.path != null) {
    throw new Error('Codex did not confirm an ephemeral thread without a session file. No prompt was sent.');
  }
  return thread;
}

export function runTurn(server, threadId, text, { write = value => process.stdout.write(value), timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    let turnId = null, queued = [], streamed = false, settled = false;
    const cleanup = () => { clearTimeout(timer); server.off('notification', notification); server.off('disconnect', disconnected); };
    const finish = (error, turn) => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(turn); };
    const disconnected = error => finish(error);
    const consume = (method, params) => {
      if (params.threadId !== threadId) return;
      const eventTurnId = params.turnId ?? params.turn?.id;
      if (eventTurnId !== turnId) return;
      if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') { streamed = true; write(params.delta); }
      if (method !== 'turn/completed') return;
      const turn = params.turn;
      if (turn?.status !== 'completed') return finish(new Error(turn?.error?.message || `Turn ${turn?.status || 'failed'}.`));
      if (!streamed) {
        const final = (turn.items || []).filter(item => item.type === 'agentMessage' && typeof item.text === 'string').map(item => item.text).join('\n');
        if (final) write(final);
      }
      write('\n'); finish(null, turn);
    };
    const notification = (method, params) => {
      if (params.threadId !== threadId || !['item/agentMessage/delta', 'turn/completed'].includes(method)) return;
      // Notifications can arrive before the turn/start response, including completion.
      if (turnId === null) queued.push([method, params]); else consume(method, params);
    };
    const timer = setTimeout(() => {
      finish(new Error('Turn timed out; the temporary server will be closed.'));
      server.fail(new Error('Turn timed out.'));
    }, timeout);
    server.on('notification', notification); server.on('disconnect', disconnected);
    server.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] }).then(result => {
      if (settled) return;
      if (typeof result?.turn?.id !== 'string') return finish(new Error('Codex did not return a turn id.'));
      turnId = result.turn.id;
      for (const [method, params] of queued) { if (settled) break; consume(method, params); }
      queued = [];
    }, error => finish(error));
  });
}
