import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { adaptVSCodeSource, adaptRendererSource, adaptComposerSource, RENDERER_PATH, COMPOSER_PATH } from './vscode-adapter.mjs';

const PATCH_VERSION = 5;
const RELOAD_MARKER = '.temp-codex-reload-once';
const digest = value => createHash('sha256').update(value).digest('hex');
function inside(root, relative) {
  const result = path.resolve(root, relative);
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error(`Path outside application: ${relative}`);
  // Do not follow junctions/symlinks into another installation.
  for (let p = result; p !== root; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error(`Symlink not supported: ${p}`);
  }
  return result;
}

export function installVSCode(directory, helperSource) {
  const root = fs.realpathSync(directory);
  const packagePath = inside(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const main = inside(root, pkg.main || 'out/extension.js');
  const helper = inside(root, path.join(path.dirname(pkg.main || 'out/extension.js'), 'temp-codex-inject.cjs'));
  const manifestPath = inside(root, '.temp-codex-v3.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    verifyManifest(root, manifest);
    if (manifest.version === PATCH_VERSION) return 'Already patched.';
    restoreVSCode(root);
    return installVSCode(root, helperSource);
  }
  const originalMain = fs.readFileSync(main);
  const originalPackage = fs.readFileSync(packagePath);
  const patchedMain = adaptVSCodeSource(originalMain.toString('utf8'), pkg);
  const renderer = inside(root, RENDERER_PATH);
  const originalRenderer = fs.readFileSync(renderer);
  const patchedRenderer = adaptRendererSource(originalRenderer.toString('utf8'));
  const composer = inside(root, COMPOSER_PATH);
  const originalComposer = fs.readFileSync(composer);
  const patchedComposer = adaptComposerSource(originalComposer.toString('utf8'));
  new vm.Script(patchedMain, { filename: main });
  new vm.Script(helperSource, { filename: helper });
  pkg.contributes ||= {};
  pkg.contributes.configuration ||= {};
  const property = { type: 'boolean', default: false, scope: 'window', description: 'Request ephemeral storage for newly created local Codex threads. Existing threads keep their mode.' };
  const configs = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
  let config = configs.find(c => c.properties?.['codex.temporaryChats']);
  if (!config) {
    if (Array.isArray(pkg.contributes.configuration)) {
      config = { title: 'Codex Temporary Chats', properties: {} };
      configs.push(config);
    } else config = configs[0];
  }
  config.properties ||= {};
  config.properties['codex.temporaryChats'] = property;
  pkg.contributes.commands ||= [];
  if (!pkg.contributes.commands.some(c => c.command === 'chatgpt.tempCodex.toggle')) {
    pkg.contributes.commands.push({ command: 'chatgpt.tempCodex.toggle', title: 'Codex: Toggle Temporary Chats' });
  }
  const patchedPackage = JSON.stringify(pkg, null, 2) + '\n';
  const files = [
    { file: main, original: originalMain, patched: patchedMain },
    { file: packagePath, original: originalPackage, patched: patchedPackage },
    { file: renderer, original: originalRenderer, patched: patchedRenderer },
    { file: composer, original: originalComposer, patched: patchedComposer },
  ];
  for (const { file } of files) {
    if (fs.existsSync(`${file}.temp-codex.bak`)) throw new Error('Existing backup found. Refusing to overwrite an earlier installation.');
  }
  if (fs.existsSync(helper)) throw new Error('Existing helper found. Refusing to overwrite it.');
  const reloadMarker = inside(root, RELOAD_MARKER);
  if (fs.existsSync(reloadMarker)) throw new Error('Existing reload marker found. Refusing to overwrite it.');
  const created = [];
  const modified = [];
  const createExclusive = (file, content) => {
    const fd = fs.openSync(file, 'wx');
    created.push(file);
    try { fs.writeFileSync(fd, content); } finally { fs.closeSync(fd); }
  };
  try {
    for (const entry of files) {
      createExclusive(`${entry.file}.temp-codex.bak`, entry.original);
    }
    createExclusive(helper, helperSource);
    for (const entry of files) {
      modified.push(entry);
      fs.writeFileSync(entry.file, entry.patched);
    }
    createExclusive(reloadMarker, 'This one-shot marker is removed by the patched extension after it requests a clean reload.\n');
    const manifest = { version: PATCH_VERSION, files: files.map(e => ({ path: path.relative(root, e.file), original: digest(e.original), patched: digest(e.patched) })), helper: { path: path.relative(root, helper), hash: digest(helperSource) } };
    createExclusive(manifestPath, JSON.stringify(manifest, null, 2));
    return `Patched VS Code extension ${pkg.version}. Reload VS Code once; the patch performs the final clean reload automatically.`;
  } catch (error) {
    for (const entry of modified) fs.writeFileSync(entry.file, entry.original);
    for (const file of created.reverse()) fs.unlinkSync(file);
    throw error;
  }
}

function verifyManifest(root, manifest) {
  if (![2, 3, 4, PATCH_VERSION].includes(manifest.version) || !Array.isArray(manifest.files) || ![2, 3, 4].includes(manifest.files.length)) throw new Error('Invalid patch manifest. No files changed.');
  for (const entry of manifest.files) {
    const file = inside(root, entry.path);
    if (digest(fs.readFileSync(file)) !== entry.patched || digest(fs.readFileSync(`${file}.temp-codex.bak`)) !== entry.original) {
      throw new Error('Application or backup changed since patching. Refusing to overwrite it.');
    }
  }
  if (digest(fs.readFileSync(inside(root, manifest.helper.path))) !== manifest.helper.hash) throw new Error('Patch helper changed. Refusing to overwrite it.');
}

export function restoreVSCode(directory) {
  const root = fs.realpathSync(directory);
  const manifestPath = inside(root, '.temp-codex-v3.json');
  if (!fs.existsSync(manifestPath)) throw new Error('No v3 patch manifest. No files changed; legacy patches require separate recovery.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  verifyManifest(root, manifest);
  // Keep backups until every original has been written successfully.
  const restored = [];
  try {
    for (const entry of manifest.files) {
      const file = inside(root, entry.path);
      restored.push({ file, patched: fs.readFileSync(file) });
      fs.copyFileSync(`${file}.temp-codex.bak`, file);
    }
  } catch (error) {
    for (const entry of restored) fs.writeFileSync(entry.file, entry.patched);
    throw error;
  }
  fs.unlinkSync(inside(root, manifest.helper.path));
  fs.unlinkSync(manifestPath);
  const reloadMarker = inside(root, RELOAD_MARKER);
  if (fs.existsSync(reloadMarker)) fs.unlinkSync(reloadMarker);
  for (const entry of manifest.files) fs.unlinkSync(`${inside(root, entry.path)}.temp-codex.bak`);
  return 'Restored VS Code extension.';
}
