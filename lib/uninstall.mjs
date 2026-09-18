import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { restoreVSCode } from './installers.mjs';
import { RENDERER_PATH, COMPOSER_PATH } from './vscode-adapter.mjs';

const setting = 'codex.temporaryChats';
export function cleanSettings(file) {
  if (!fs.existsSync(file)) return false;
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== path.resolve(file)) throw new Error(`Settings path must be a regular file without symlinks: ${file}`);
  const original = fs.readFileSync(file, 'utf8');
  if (!original.includes(setting)) return false;
  const errors = [];
  const value = parse(original, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Cannot safely read settings: ${file}`);
  const prefix = file.endsWith('.code-workspace') ? ['settings'] : [];
  let updated = original;
  // Remove duplicates as well, while preserving unrelated settings and comments.
  while (Object.hasOwn(prefix.length ? parse(updated)?.settings ?? {} : parse(updated), setting)) {
    const next = applyEdits(updated, modify(updated, [...prefix, setting], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    if (next === updated) throw new Error(`Could not remove temporary-mode setting: ${file}`);
    updated = next;
  }
  if (updated === original) return false;
  if (fs.readFileSync(file, 'utf8') !== original) throw new Error(`Settings changed during cleanup: ${file}`);
  fs.writeFileSync(file, updated);
  return true;
}

export function discover({ home = os.homedir(), env = process.env, platform = process.platform, cwd = process.cwd() } = {}) {
  const extensions = [], settings = [];
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.vscode-server', '.vscode-server-insiders']) {
    const dir = path.join(home, editor, 'extensions');
    if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('openai.chatgpt-')) extensions.push(path.join(dir, entry.name));
    }
  }
  const config = platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming') : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : env.XDG_CONFIG_HOME || path.join(home, '.config');
  const users = ['Code', 'Code - Insiders', 'Cursor'].map(editor => path.join(config, editor, 'User'));
  for (const server of ['.vscode-server', '.vscode-server-insiders']) users.push(path.join(home, server, 'data', 'Machine'), path.join(home, server, 'data', 'User'));
  for (const user of users) {
    settings.push(path.join(user, 'settings.json'));
    const profiles = path.join(user, 'profiles');
    if (fs.existsSync(profiles)) for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) settings.push(path.join(profiles, entry.name, 'settings.json'));
    }
  }
  settings.push(path.join(cwd, '.vscode', 'settings.json'));
  if (fs.existsSync(cwd)) for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.code-workspace')) settings.push(path.join(cwd, entry.name));
  }
  return { extensions, settings };
}

export function restoreIfPatched(root) {
  if (!fs.existsSync(root)) throw new Error(`Extension not found: ${root}`);
  if (fs.existsSync(path.join(root, '.temp-codex-v3.json'))) return restoreVSCode(root);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.publisher !== 'openai' || pkg.name !== 'chatgpt') throw new Error(`Not a Codex extension: ${root}`);
  const main = path.resolve(root, pkg.main || 'out/extension.js');
  if (!main.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid extension entry point');
  if (fs.existsSync(path.join(path.dirname(main), 'temp-codex-inject.cjs')) || fs.readFileSync(main, 'utf8').includes('__TEMP_CODEX_') || fs.existsSync(main + '.temp-codex.bak')) {
    throw new Error(`Incomplete patch at ${root}; restore its original files before uninstalling the package.`);
  }
  for (const file of ['package.json', RENDERER_PATH, COMPOSER_PATH]) {
    const absolute = path.join(root, file);
    if (fs.existsSync(absolute + '.temp-codex.bak') || (fs.existsSync(absolute) && /tempCodexComposer|chatgpt\.tempCodex|codex\.temporaryChats|ephemeral:v\.thread\.ephemeral===!0\|\|d\.ephemeral/.test(fs.readFileSync(absolute, 'utf8')))) throw new Error('Patch remnants without a manifest at ' + root + '; original files must be recovered before uninstalling.');
  }
  return 'Already restored.';
}

function npmLaunch() {
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH || process.env.Path || '').split(path.delimiter)];
  for (const dir of dirs) {
    const cli = path.join(dir.replace(/^"|"$/g, ''), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(cli)) return { command: process.execPath, args: [cli] };
  }
  throw new Error('npm was not found. Install Node.js/npm and run uninstall again.');
}

export function removePackages(run = spawnSync, launch = npmLaunch()) {
  const result = run(launch.command, [...launch.args, 'list', '--global', '--depth=0', '--json'], { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Could not check globally installed npm packages. No packages removed.');
  const installed = JSON.parse(result.stdout).dependencies || {};
  const names = ['codex-temporary-mode', 'ghostthread', 'temp-codex-patcher'].filter(name => Object.hasOwn(installed, name));
  if (!names.length) return 'No temporary-mode npm packages installed in the active npm prefix.';
  const removed = run(launch.command, [...launch.args, 'uninstall', '--global', '--ignore-scripts', '--no-audit', '--no-fund', ...names], { stdio: 'inherit', shell: false, windowsHide: true });
  if (removed.error || removed.status !== 0) throw new Error('npm uninstall failed. Run uninstall again after resolving the npm error.');
  return `Removed npm packages: ${names.join(', ')}.`;
}

export async function uninstall(args = [], { targets = discover(), runPackages = removePackages, log = console.log } = {}) {
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--vscode-path', '--settings-path'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use uninstall [--vscode-path <extension>] [--settings-path <settings.json or .code-workspace>].');
    targets[flag === '--vscode-path' ? 'extensions' : 'settings'].push(path.resolve(args[++i]));
  }
  // Keep the uninstall tool available if any extension or settings cleanup fails.
  const errors = [];
  for (const root of new Set(targets.extensions)) try { log(`${root}: ${restoreIfPatched(root)}`); } catch (error) { errors.push(error.message); }
  for (const file of new Set(targets.settings)) try { if (cleanSettings(file)) log(`Removed temporary-mode setting: ${file}`); } catch (error) { errors.push(error.message); }
  if (errors.length) throw new Error(errors.join('\n') + '\nThe npm package was kept so cleanup can be retried.');
  log(runPackages());
  log('Cleanup complete for detected installations and the active npm prefix. Reload VS Code and close any running temporary-mode chats.');
}
