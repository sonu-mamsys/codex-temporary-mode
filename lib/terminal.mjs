import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { CodexAppServer, resolveCodex, RpcError, runTurn, startTemporaryThread } from './app-server.mjs';

export const HELP = `codex-temporary-mode — Temporary Mode for Codex

Usage: codex-temporary-mode [options] [first prompt]
       codex-temporary-mode temporary install|restore|check|reapply [--vscode-path <directory>]
       codex-temporary-mode companion install [--code-path <path>] [--profile <name>]
       codex-temporary-mode accelerator setup [-C <repository>] [--skip-pipeline-config]
       codex-temporary-mode setup [--all] [-C <repository>] [--skip-vscode] [--skip-pipeline-config] [--code-path <path>] [--profile <name>]
       codex-temporary-mode doctor [--json] [-C <directory>] [--codex-path <path>]
       codex-temporary-mode uninstall [--vscode-path <directory>] [--settings-path <file>]
       codex-temporary-mode --verify [test prompt]
       codex-temporary-mode vscode install|restore [--vscode-path <directory>]

Feature commands:
  temporary install         Install the VS Code Temporary Mode patch
  companion install         Install/update the bundled VS Code companion
  temporary check|reapply   Inspect or safely restore an opted-in patch
  accelerator setup         Configure this Git project's MCP and Pipeline Mode
  setup --all               Install companion, Temporary Mode and project Accelerator
  doctor [--json]           Read-only local diagnostics for support

Options:
  -C, --cwd <directory>  Working directory (default: current directory)
  -m, --model <name>     Model override
      --read-only       Read-only sandbox (default)
      --workspace-write Allow real workspace edits in the sandbox
      --codex-path <p>  Codex executable or npm JavaScript entry point
      --timeout <secs>  Maximum duration of each turn (default: 600)
      --verify          Confirm ephemeral storage, restart, then check absence
      --                Treat remaining arguments as the prompt
  -h, --help            Show help

Chat commands: /new (fresh server and thread), /status, /exit
Piped input is processed line by line. EOF and Ctrl+C close the owned server.
This is a small terminal client, not the full Codex TUI. Interactive approvals
and interactive tool questions are not supported; they are never auto-approved.
`;

export function parseArgs(args) {
  const options = { cwd: process.cwd(), sandbox: 'read-only', timeout: 600000, prompt: '' };
  const prompt = [];
  let selectedSandbox;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { prompt.push(...args.slice(i + 1)); break; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--verify') { options.verify = true; continue; }
    if (arg === '--read-only' || arg === '--workspace-write') {
      if (selectedSandbox && selectedSandbox !== arg) throw new Error('Choose only one sandbox mode.');
      selectedSandbox = arg; options.sandbox = arg.slice(2); continue;
    }
    const key = { '-C': 'cwd', '--cwd': 'cwd', '-m': 'model', '--model': 'model', '--codex-path': 'codexPath', '--timeout': 'timeout' }[arg];
    if (key) {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}.`);
      options[key] = value; continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}. Use --help.`);
    prompt.push(arg);
  }
  options.cwd = path.resolve(options.cwd);
  if (typeof options.timeout === 'string') {
    const seconds = Number(options.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error('--timeout must be between 0 and 86400 seconds (exclusive of zero).');
    options.timeout = seconds * 1000;
  }
  options.prompt = prompt.join(' ');
  return options;
}

function parseDoctorArgs(args) {
  const options = { cwd: process.cwd(), json: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') { options.json = true; continue; }
    const key = { '-C': 'cwd', '--cwd': 'cwd', '--codex-path': 'codexPath' }[arg];
    if (!key) throw new Error(`Unknown doctor option: ${arg}. Use "codex-temporary-mode doctor --help".`);
    const value = args[++index];
    if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}.`);
    options[key] = value;
  }
  options.cwd = path.resolve(options.cwd);
  return options;
}

async function runVSCodeAction(action, args) {
  if (!['install', 'restore', 'check', 'reapply'].includes(action)) throw new Error('Use codex-temporary-mode temporary install|restore|check|reapply (or the existing vscode alias).');
  const actionFlag = { restore: '--uninstall', check: '--check', reapply: '--reapply' }[action];
  process.argv = [process.argv[0], process.argv[1], '--vscode', ...(actionFlag ? [actionFlag] : []), ...args];
  await import('../patch.mjs');
}

function repairManagedVSCodePatch() {
  if (process.env.CODEX_TEMPORARY_SKIP_VSCODE_REPAIR === '1') return;
  const patchEntry = fileURLToPath(new URL('../patch.mjs', import.meta.url));
  // Repair is independent of the terminal session. A blocked extension scan
  // must not delay or keep the Codex session alive.
  const child = spawn(process.execPath, [patchEntry, '--vscode', '--repair-if-managed'], {
    detached: true, stdio: 'ignore', shell: false, windowsHide: true,
  });
  child.on('error', error => console.error(`[codex-temporary-mode] VS Code patch repair could not start: ${error.message}`));
  child.unref();
}

export function sessionFiles(codexHome, threadId) {
  if (!codexHome) throw new Error('Codex did not report its home directory; disk verification is unavailable.');
  const matches = [];
  const visit = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.includes(threadId)) matches.push(file);
    }
  };
  for (const name of ['sessions', 'archived_sessions']) visit(path.join(codexHome, name));
  return matches;
}

export async function verifyGone(server, codexHome, threadId) {
  try {
    await server.request('thread/resume', { threadId });
  } catch (error) {
    // Authentication, transport and unsupported-method errors do not prove absence.
    if (!(error instanceof RpcError) || error.code !== -32600 ||
        !/(thread.*not found|no (?:rollout|thread|session) found|(?:rollout|thread|session).*does not exist)/i.test(error.message)) throw error;
    const files = sessionFiles(codexHome, threadId);
    if (files.length) throw new Error(`Temporary thread has ${files.length} session file(s) on disk.`);
    return;
  }
  throw new Error('The thread was readable after restart; temporary storage verification failed.');
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === 'companion') {
    if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
    const { companionInstallCommand } = await import('./companion-install.mjs');
    return companionInstallCommand(args.slice(1));
  }
  if (args[0] === 'doctor') {
    if (args[1] === '--help' || args[1] === '-h') { console.log(HELP); return; }
    const { doctor, printDoctor } = await import('./doctor.mjs');
    const options = parseDoctorArgs(args.slice(1));
    printDoctor(await doctor(options), options);
    return;
  }
  if (args[0] === 'temporary') {
    const [action, ...rest] = args.slice(1);
    if (action === '--help' || action === '-h' || rest.includes('--help') || rest.includes('-h')) { console.log(HELP); return; }
    return runVSCodeAction(action, rest);
  }
  if (args[0] === 'accelerator') {
    const [action, ...rest] = args.slice(1);
    if (action === '--help' || action === '-h' || rest.includes('--help') || rest.includes('-h')) { console.log(HELP); return; }
    if (action !== 'setup') throw new Error('Use codex-temporary-mode accelerator setup.');
    const { setup } = await import('./setup.mjs');
    return setup(['--skip-vscode', ...rest]);
  }
  if (args[0] === 'setup') {
    if (args.slice(1).includes('--help') || args.slice(1).includes('-h')) { console.log(HELP); return; }
    const { setup } = await import('./setup.mjs');
    return setup(args.slice(1));
  }
  if (args[0] === 'uninstall') {
    const { uninstall } = await import('./uninstall.mjs');
    return uninstall(args.slice(1));
  }
  if (args[0] === 'vscode') {
    const [action, ...rest] = args.slice(1);
    if (action === '--help' || action === '-h' || rest.includes('--help') || rest.includes('-h')) { console.log(HELP); return; }
    return runVSCodeAction(action, rest);
  }
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  if (!fs.statSync(options.cwd).isDirectory()) throw new Error('--cwd must be a directory.');
  // A prior explicit VS Code install opts into lightweight update repair. The
  // helper is a short-lived process and never patches a first-time user.
  repairManagedVSCodePatch();
  const launch = resolveCodex(options.codexPath);
  // A configured accelerator child inherits this marker from the temporary
  // Codex app-server and keeps its SQLite/log state entirely ephemeral.
  const serverEnv = { ...process.env, CODEX_ACCELERATOR_EPHEMERAL: '1' };
  let server, thread, initialized, stopped = false, lines, unexpectedError;
  // Attach the iterator before initialization so piped lines are not lost.
  if (!options.verify) lines = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY), crlfDelay: Infinity });
  const input = lines?.[Symbol.asyncIterator]();
  const open = async () => {
    if (stopped) throw new Error('Session closed.');
    server = new CodexAppServer({ launch, env: serverEnv });
    const owned = server;
    owned.on('disconnect', error => {
      if (!owned.isStopping) { unexpectedError = error; lines?.close(); }
    });
    initialized = await server.start();
    if (stopped) throw new Error('Session closed.');
    thread = await startTemporaryThread(server, options);
    if (stopped) throw new Error('Session closed.');
  };
  const stop = () => { stopped = true; lines?.close(); void server?.stop(); };
  lines?.on('SIGINT', stop);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const label = process.stdout.isTTY && !process.env.NO_COLOR ? '\x1b[45;97m TEMPORARY \x1b[0m' : '[TEMPORARY]';
  const status = () => console.log(`${label} Server-confirmed ephemeral: ${thread.ephemeral}\nThread: ${thread.id}\nSession file: none\nWorkspace: ${options.cwd}\nSandbox: ${options.sandbox}`);
  try {
    await open(); status();
    if (!options.verify) console.log('Commands: /new  /status  /exit. Workspace edits remain real.\n');
    if (options.prompt) await runTurn(server, thread.id, options.prompt, { timeout: options.timeout });
    if (options.verify) {
      const previousId = thread.id, home = initialized.codexHome;
      await server.stop();
      server = new CodexAppServer({ launch, env: serverEnv });
      const fresh = await server.start();
      if (!home || fresh.codexHome !== home) throw new Error('Cannot verify absence across different or unknown Codex home directories.');
      await verifyGone(server, home, previousId);
      console.log(`PASS: server confirmed ephemeral storage; thread is unavailable after restart; no matching session files.\n${options.prompt ? 'A model reply was included in this check.' : 'No model turn was run. Add a test prompt to verify a completed conversation.'}`);
      return;
    }
    while (!stopped) {
      if (process.stdin.isTTY) process.stdout.write('you> ');
      const { value, done } = await input.next();
      if (done || stopped) break;
      const text = value.trim();
      if (!text) continue;
      if (text === '/exit' || text === '/quit') break;
      if (text === '/status') { status(); continue; }
      if (text === '/new') {
        await server.stop(); thread = null;
        await open(); status(); continue;
      }
      if (text.startsWith('/')) { console.log('Unknown command. Use /new, /status or /exit.'); continue; }
      process.stdout.write('codex> ');
      await runTurn(server, thread.id, value, { timeout: options.timeout });
    }
    if (unexpectedError) throw unexpectedError;
  } catch (error) { if (!stopped) throw error; }
  finally {
    lines?.close(); await server?.stop();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
