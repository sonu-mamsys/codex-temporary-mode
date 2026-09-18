#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installVSCode, restoreVSCode } from './lib/installers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VSCODE_INJECT = fs.readFileSync(path.join(HERE, 'src', 'inject', 'vscode-inject.cjs'), 'utf8');
const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const doVSCode = args.includes('--vscode');

function valueAfter(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function log(message) { console.log(`[ghostthread] ${message}`); }
function fail(message) { console.error(`[ghostthread] ${message}`); process.exitCode = 1; }

function newest(paths) {
  return paths
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.p;
}

function findVSCodeExtension() {
  const explicit = valueAfter('--vscode-path');
  if (explicit) return path.resolve(explicit);
  const home = os.homedir();
  const roots = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.vscode-server-insiders', 'extensions'),
  ];
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith('openai.chatgpt-')) candidates.push(path.join(root, name));
    }
  }
  return newest(candidates);
}

function patchVSCode() {
  const root = findVSCodeExtension();
  if (!root) throw new Error('Codex VS Code extension was not found. Use --vscode-path <extension-dir>.');
  log(uninstall ? restoreVSCode(root) : installVSCode(root, VSCODE_INJECT));
}

try {
  const known = new Set(['--vscode', '--uninstall', '--vscode-path']);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error('Unknown argument: ' + args[i]);
    if (args[i].endsWith('-path')) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing path for ' + args[i]);
      i++;
    }
  }
  if (!doVSCode) throw new Error('Choose --vscode explicitly.');
  patchVSCode();
} catch (error) {
  fail(error?.stack || String(error));
}
