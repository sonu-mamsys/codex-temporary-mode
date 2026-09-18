import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanSettings, discover, restoreIfPatched, removePackages, uninstall } from '../lib/uninstall.mjs';
function directory(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'codex-uninstall-test-'));
  t.after(() => { assert.equal(fs.realpathSync(dir), dir); assert.equal(path.dirname(dir), parent); fs.rmSync(dir, { recursive: true }); });
  return dir;
}
test('settings cleanup preserves comments, unrelated settings and workspace content; repeat is safe', t => {
  const root = directory(t);
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, '{\n// keep comment\n"editor.fontSize": 16,\n"codex.temporaryChats": true,\n}\n');
  assert.equal(cleanSettings(file), true);
  const text = fs.readFileSync(file, 'utf8');
  assert(text.includes('// keep comment')); assert(text.includes('"editor.fontSize": 16')); assert(!text.includes('codex.temporaryChats'));
  assert.equal(cleanSettings(file), false);
  const workspace = path.join(root, 'a.code-workspace');
  fs.writeFileSync(workspace, '{"folders":[{"path":"."}],"settings":{"codex.temporaryChats":false,"editor.tabSize":4}}');
  cleanSettings(workspace);
  assert.deepEqual(JSON.parse(fs.readFileSync(workspace)), { folders: [{ path: '.' }], settings: { 'editor.tabSize': 4 } });
});
test('malformed settings with our key are preserved and stop package removal', async t => {
  const file = path.join(directory(t), 'settings.json');
  const text = '{"codex.temporaryChats":true, broken'; fs.writeFileSync(file, text);
  let removed = false;
  await assert.rejects(uninstall([], { targets: { extensions: [], settings: [file] }, runPackages() { removed = true; }, log() {} }), /kept/);
  assert.equal(removed, false); assert.equal(fs.readFileSync(file, 'utf8'), text);
});
test('discovery includes all extension versions, profiles, current workspace and ignores unrelated packages', t => {
  const home = directory(t);
  for (const name of ['openai.chatgpt-1', 'openai.chatgpt-2', 'other']) fs.mkdirSync(path.join(home, '.vscode/extensions', name), { recursive: true });
  fs.mkdirSync(path.join(home, '.config/Code/User/profiles/example'), { recursive: true });
  const found = discover({ home, env: {}, platform: 'linux', cwd: home });
  assert.equal(found.extensions.length, 2);
  assert(found.settings.includes(path.join(home, '.config/Code/User/profiles/example/settings.json')));
  assert(found.settings.includes(path.join(home, '.vscode/settings.json')));
});
test('restore skips clean installations and refuses missing-manifest remnants', t => {
  const root = directory(t); fs.mkdirSync(path.join(root, 'out'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ publisher: 'openai', name: 'chatgpt', main: 'out/extension.js' }));
  fs.writeFileSync(path.join(root, 'out/extension.js'), 'original');
  assert.equal(restoreIfPatched(root), 'Already restored.');
  fs.writeFileSync(path.join(root, 'out/temp-codex-inject.cjs'), 'helper');
  assert.throws(() => restoreIfPatched(root), /Incomplete patch/);
});
test('npm cleanup removes only known project packages with lifecycle scripts disabled', () => {
  const calls = [];
  const run = (command, args) => { calls.push(args); return calls.length === 1 ? { status: 0, stdout: JSON.stringify({ dependencies: { 'codex-temporary-mode': {}, ghostthread: {}, '@openai/codex': {}, unrelated: {} } }) } : { status: 0 }; };
  removePackages(run, { command: 'npm', args: [] });
  assert.deepEqual(calls[1], ['uninstall', '--global', '--ignore-scripts', '--no-audit', '--no-fund', 'codex-temporary-mode', 'ghostthread']);
  assert.throws(() => removePackages(() => ({ status: 1 }), { command: 'npm', args: [] }), /No packages removed/);
});
test('unknown uninstall options fail before npm changes; empty cleanup is repeatable', async () => {
  let count = 0; const options = { targets: { extensions: [], settings: [] }, runPackages() { count++; return 'none'; }, log() {} };
  await assert.rejects(uninstall(['--bad'], options), /Use uninstall/);
  assert.equal(count, 0); await uninstall([], options); await uninstall([], options); assert.equal(count, 2);
});
