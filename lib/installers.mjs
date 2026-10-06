import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { adaptVSCodeSource, adaptRendererSource, adaptComposerSource, detectVSCodeCompatibility } from './vscode-adapter.mjs';

const PATCH_VERSION = 12;
const LEGACY_RELOAD_MARKER = '.temp-codex-reload-once';
const PATCH_STATE_DIRECTORY = '.codex-temporary-mode';
const PATCH_STATE_FILE = 'vscode-patch-state.json';
const digest = value => createHash('sha256').update(value).digest('hex');
function inside(root, relative) {
  const result = path.resolve(root, relative);
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error(`Path outside application: ${relative}`);
  for (let p = result; p !== root; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error(`Symlink not supported: ${p}`);
  }
  return result;
}

function bundleAssets(root) {
  const assetsDirectory = inside(root, 'webview/assets');
  if (!fs.existsSync(assetsDirectory) || !fs.lstatSync(assetsDirectory).isDirectory()) throw new Error('Unsupported webview asset directory. No files changed.');
  return fs.readdirSync(assetsDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^app-initial-[\da-f]+\.js$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => {
      const relative = path.join('webview', 'assets', entry.name);
      const absolute = inside(root, relative);
      return { path: relative, absolute, source: fs.readFileSync(absolute, 'utf8') };
    });
}

function patchStatePath(env = process.env) {
  const home = env.CODEX_TEMPORARY_STATE_HOME ? path.resolve(env.CODEX_TEMPORARY_STATE_HOME) : os.homedir();
  return path.join(home, PATCH_STATE_DIRECTORY, PATCH_STATE_FILE);
}

function readPatchState() {
  try {
    const file = patchStatePath();
    if (!fs.existsSync(file)) return null;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state?.version === 1 && Array.isArray(state.patches) ? state : null;
  } catch { return null; }
}

/** Whether a prior explicit install opted this user into update repair. */
export function hasVSCodePatchHistory() {
  return Boolean(readPatchState()?.patches.some(entry => typeof entry?.path === 'string'));
}

function updatePatchState(root, details, { clearAll = false } = {}) {
  // Advisory state records update/reapply history but never participates in a
  // restore decision: the extension-local manifest remains authoritative.
  try {
    const file = patchStatePath();
    const directory = path.dirname(file);
    if (fs.existsSync(directory) && (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())) return;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) return;
    let state = readPatchState() || { version: 1, patches: [] };
    state.patches = clearAll ? [] : state.patches.filter(entry => entry?.path !== root);
    if (details) state.patches.push({ path: root, ...details, updatedAt: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Read-only or malformed advisory state must not turn a verified patch
    // operation into a partial failure.
  }
}

export function inspectVSCodePatch(directory) {
  const root = fs.realpathSync(directory);
  const packagePath = inside(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const main = inside(root, pkg.main || 'out/extension.js');
  const manifestPath = inside(root, '.temp-codex-v3.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    verifyManifest(root, manifest);
    return { status: 'patched', patchVersion: manifest.version, extensionVersion: pkg.version, fingerprint: manifest.compatibility?.fingerprint, profile: manifest.compatibility?.profile };
  }
  const compatibility = detectVSCodeCompatibility(pkg, fs.readFileSync(main, 'utf8'), bundleAssets(root));
  return { status: 'compatible-unpatched', extensionVersion: pkg.version, fingerprint: compatibility.fingerprint, profile: compatibility.profile.id };
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
    if (manifest.version === PATCH_VERSION) {
      updatePatchState(root, { extensionVersion: pkg.version, fingerprint: manifest.compatibility?.fingerprint, profile: manifest.compatibility?.profile });
      return 'Already patched.';
    }
    // Validate the backed-up originals before removing a working older patch.
    const originalSource = relative => fs.readFileSync(`${inside(root, relative)}.temp-codex.bak`, 'utf8');
    const originalPkg = JSON.parse(originalSource('package.json'));
    const originalAssets = bundleAssets(root).map(asset => ({ ...asset,
      source: manifest.files.some(entry => path.normalize(entry.path) === path.normalize(asset.path)) ? originalSource(asset.path) : asset.source,
    }));
    const review = detectVSCodeCompatibility(originalPkg, originalSource(originalPkg.main || 'out/extension.js'), originalAssets);
    if (!review.renderer || !review.composer) throw new Error('Unsupported previous patch layout. No files changed.');
    adaptRendererSource(review.renderer.source, review.profile);
    adaptComposerSource(review.composer.source, review.profile);
    restoreVSCode(root);
    return installVSCode(root, helperSource);
  }
  const originalMain = fs.readFileSync(main);
  const compatibility = detectVSCodeCompatibility(pkg, originalMain.toString('utf8'), bundleAssets(root));
  if (!compatibility.composer || compatibility.composer.path === compatibility.renderer.path) {
    throw new Error('Unsupported composer bundle layout. No files changed.');
  }
  const originalPackage = fs.readFileSync(packagePath);
  const patchedMain = adaptVSCodeSource(originalMain.toString('utf8'), pkg);
  const renderer = inside(root, compatibility.renderer.path);
  const originalRenderer = fs.readFileSync(renderer);
  const patchedRenderer = adaptRendererSource(originalRenderer.toString('utf8'), compatibility.profile);
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
  ];
  const composer = inside(root, compatibility.composer.path);
  const originalComposer = fs.readFileSync(composer);
  files.push({ file: composer, original: originalComposer, patched: adaptComposerSource(originalComposer.toString('utf8'), compatibility.profile) });
  for (const { file } of files) {
    if (fs.existsSync(`${file}.temp-codex.bak`)) throw new Error('Existing backup found. Refusing to overwrite an earlier installation.');
  }
  if (fs.existsSync(helper)) throw new Error('Existing helper found. Refusing to overwrite it.');
  const created = [];
  const modified = [];
  const createExclusive = (file, content) => {
    const fd = fs.openSync(file, 'wx');
    created.push(file);
    try { fs.writeFileSync(fd, content); } finally { fs.closeSync(fd); }
  };
  try {
    for (const entry of files) createExclusive(`${entry.file}.temp-codex.bak`, entry.original);
    createExclusive(helper, helperSource);
    for (const entry of files) {
      modified.push(entry);
      fs.writeFileSync(entry.file, entry.patched);
    }
    const manifest = { version: PATCH_VERSION, compatibility: { profile: compatibility.profile.id, fingerprint: compatibility.fingerprint, extensionVersion: pkg.version }, files: files.map(e => ({ path: path.relative(root, e.file), original: digest(e.original), patched: digest(e.patched) })), helper: { path: path.relative(root, helper), hash: digest(helperSource) } };
    createExclusive(manifestPath, JSON.stringify(manifest, null, 2));
    updatePatchState(root, { extensionVersion: pkg.version, fingerprint: compatibility.fingerprint, profile: compatibility.profile.id });
    return `Patched VS Code extension ${pkg.version}. Reload VS Code once.`;
  } catch (error) {
    for (const entry of modified) fs.writeFileSync(entry.file, entry.original);
    for (const file of created.reverse()) fs.unlinkSync(file);
    throw error;
  }
}

// Call from setup or CLI startup. No daemon is created; a missing manifest is
// reapplied only after the same compatibility and backup safety checks as a
// normal install pass.
export function ensureVSCodePatch(directory, helperSource) {
  const inspection = inspectVSCodePatch(directory);
  if (inspection.status === 'patched' && inspection.patchVersion === PATCH_VERSION) {
    updatePatchState(fs.realpathSync(directory), { extensionVersion: inspection.extensionVersion, fingerprint: inspection.fingerprint, profile: inspection.profile });
    return { ...inspection, action: 'none' };
  }
  const message = installVSCode(directory, helperSource);
  return { ...inspectVSCodePatch(directory), action: 'reapplied', message };
}

function verifyManifest(root, manifest) {
  if (![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, PATCH_VERSION].includes(manifest.version) || !Array.isArray(manifest.files) ||
      (manifest.version === PATCH_VERSION ? manifest.files.length !== 4 : ![2, 3, 4, 5, 6].includes(manifest.files.length))) {
    throw new Error('Invalid patch manifest. No files changed.');
  }
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
  const legacyReloadMarker = inside(root, LEGACY_RELOAD_MARKER);
  if (fs.existsSync(legacyReloadMarker)) fs.unlinkSync(legacyReloadMarker);
  for (const entry of manifest.files) fs.unlinkSync(`${inside(root, entry.path)}.temp-codex.bak`);
  // An explicit restore is also an explicit opt-out from future startup repair,
  // including advisory entries left by older extension-version directories.
  updatePatchState(root, null, { clearAll: true });
  return 'Restored VS Code extension. Reload VS Code once.';
}
