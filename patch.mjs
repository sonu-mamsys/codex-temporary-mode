#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installVSCode, restoreVSCode, inspectVSCodePatch, ensureVSCodePatch, hasVSCodePatchHistory } from './lib/installers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VSCODE_INJECT = fs.readFileSync(path.join(HERE, 'src', 'inject', 'vscode-inject.cjs'), 'utf8');
const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const doVSCode = args.includes('--vscode');
const check = args.includes('--check');
const reapply = args.includes('--reapply');
const repairIfManaged = args.includes('--repair-if-managed');

function valueAfter(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function log(message) { console.log(`[codex-temporary-mode] ${message}`); }
function fail(message) { console.error(`[codex-temporary-mode] ${message}`); process.exitCode = 1; }

function findVSCodeExtensions() {
  const explicit = valueAfter('--vscode-path');
  if (explicit) return [path.resolve(explicit)];
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
  return candidates
    .filter(candidate => fs.existsSync(candidate))
    .map(candidate => ({ candidate, mtime: fs.statSync(candidate).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
    .map(item => item.candidate);
}

function patchVSCode() {
  const candidates = findVSCodeExtensions();
  // Restore is an explicit opt-out: find the newest installed extension that
  // actually has our patch manifest, even when a newer extension version is
  // present but has never been patched. An explicit path remains authoritative.
  const explicitPath = valueAfter('--vscode-path');
  const root = uninstall && !explicitPath
    ? (candidates.find(candidate => fs.existsSync(path.join(candidate, '.temp-codex-v3.json'))) || candidates[0])
    : candidates[0];
  if (!root) throw new Error('Codex VS Code extension was not found. Use --vscode-path <extension-dir>.');
  if (uninstall) return log(restoreVSCode(root));
  if (check) {
    const result = inspectVSCodePatch(root);
    return log(`VS Code extension ${result.extensionVersion}: ${result.status} (${result.profile || 'legacy-manifest'}, ${result.fingerprint || 'fingerprint unavailable'}).`);
  }
  if (repairIfManaged) {
    const currentManifest = fs.existsSync(path.join(root, '.temp-codex-v3.json'));
    const olderManifest = candidates.slice(1).some(candidate => fs.existsSync(path.join(candidate, '.temp-codex-v3.json')));
    if (!currentManifest && !olderManifest && !hasVSCodePatchHistory()) return;
  }
  if (reapply || repairIfManaged) {
    const result = ensureVSCodePatch(root, VSCODE_INJECT);
    return log(result.action === 'reapplied' ? result.message : `VS Code extension ${result.extensionVersion} is already patched.`);
  }
  log(installVSCode(root, VSCODE_INJECT));
}

try {
  const known = new Set(['--vscode', '--uninstall', '--check', '--reapply', '--repair-if-managed', '--vscode-path']);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error('Unknown argument: ' + args[i]);
    if (args[i].endsWith('-path')) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing path for ' + args[i]);
      i++;
    }
  }
  if (!doVSCode) throw new Error('Choose --vscode explicitly.');
  if (uninstall && (check || reapply || repairIfManaged)) throw new Error('--uninstall cannot be combined with a check or repair option.');
  if ([check, reapply, repairIfManaged].filter(Boolean).length > 1) throw new Error('Choose only one of --check, --reapply, or --repair-if-managed.');
  patchVSCode();
} catch (error) {
  fail(error?.stack || String(error));
}
