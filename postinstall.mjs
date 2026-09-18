#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import tty from 'node:tty';

const here = path.dirname(fileURLToPath(import.meta.url));

export function askToPatch(input = process.stdin, output = process.stdout) {
  return new Promise(resolve => {
    const prompt = createInterface({ input, output });
    prompt.question('[codex-temporary-mode] Patch the supported VS Code Codex extension now? [Y/n] ', answer => {
      prompt.close();
      resolve(!/^n(?:o)?$/i.test(answer.trim()));
    });
  });
}

function installTerminal() {
  if (process.stdin.isTTY && process.stdout.isTTY) return { input: process.stdin, output: process.stdout };
  const device = process.platform === 'win32' ? ['\\\\.\\CONIN$', '\\\\.\\CONOUT$'] : ['/dev/tty', '/dev/tty'];
  try {
    return {
      input: new tty.ReadStream(fs.openSync(device[0], 'r')),
      output: new tty.WriteStream(fs.openSync(device[1], 'w')),
      close() { this.input.destroy(); this.output.destroy(); },
    };
  } catch {
    return null;
  }
}

export async function postinstall({ input = process.stdin, output = process.stdout, run = spawnSync } = {}) {
  const terminal = input.isTTY && output.isTTY ? { input, output } : installTerminal();
  if (!terminal) {
    output.write('[codex-temporary-mode] VS Code patch skipped because npm has no interactive terminal. Run "codex-temporary-mode vscode install" when ready.\n');
    return false;
  }
  try {
    if (!await askToPatch(terminal.input, terminal.output)) {
      terminal.output.write('[codex-temporary-mode] VS Code patch skipped. Run "codex-temporary-mode vscode install" when ready.\n');
      return false;
    }
    const result = run(process.execPath, [path.join(here, 'patch.mjs'), '--vscode'], { encoding: 'utf8' });
    if (result.stdout) terminal.output.write(result.stdout);
    if (result.stderr) terminal.output.write(result.stderr);
    if (result.error || result.status !== 0) {
      terminal.output.write('[codex-temporary-mode] VS Code was not patched. The terminal client remains installed.\n');
      return false;
    }
    return true;
  } finally {
    terminal.close?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  postinstall().catch(error => {
    console.error(`[codex-temporary-mode] VS Code patch skipped: ${error.message}`);
  });
}
