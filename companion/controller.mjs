import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureVSCodePatch, hasVSCodePatchHistory, inspectVSCodePatch, restoreVSCode } from '../lib/installers.mjs';

const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const command = name => `temporaryCompanion.${name}`;

export function terminalOptions({ nodePath = '', cwd, env = process.env, platform = process.platform, root = runtimeRoot }) {
  const searchPath = Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1] || '';
  const candidates = nodePath ? [nodePath] : searchPath.split(path.delimiter).filter(Boolean)
    .map(directory => path.join(directory.replace(/^"|"$/g, ''), platform === 'win32' ? 'node.exe' : 'node'));
  const executable = candidates.find(candidate => path.isAbsolute(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!executable) throw new Error('Install Node.js 22.13+ or set Temporary Companion: Node Path to its absolute executable path.');
  return {
    name: 'Codex Temporary Chat', shellPath: executable,
    shellArgs: [path.join(root, 'codex-temporary-mode.mjs'), '--cwd', cwd], cwd,
    env: { CODEX_TEMPORARY_SKIP_VSCODE_REPAIR: '1' },
    message: 'Temporary terminal chat (read-only by default). Requires Codex CLI on PATH and an existing Codex login.\r\n',
  };
}

// VS Code owns this extension independently of openai.chatgpt. Only the optional
// embedded integration depends on Codex's private bundle layout.
export async function startCompanion(vscode, context, services = {}) {
  const inspect = services.inspect || inspectVSCodePatch;
  const ensure = services.ensure || (root => ensureVSCodePatch(root, fs.readFileSync(path.join(runtimeRoot, 'src/inject/vscode-inject.cjs'), 'utf8')));
  const managed = services.managed || hasVSCodePatchHistory;
  const restorePatch = services.restore || restoreVSCode;
  const launchOptions = services.terminalOptions || terminalOptions;
  const output = vscode.window.createOutputChannel('Codex Temporary Companion');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 94);
  status.name = 'Codex Temporary Companion';
  status.command = command('menu');
  let state = { status: 'checking' };
  let stopped = false;
  let reloadRequired = false;
  let reloadReason;
  let noticeKey;
  let queue = Promise.resolve();
  const config = () => vscode.workspace.getConfiguration('temporaryCompanion');
  const render = () => {
    const labels = { checking: 'Checking', patched: 'Embedded ready', reload: 'Reload needed', 'compatible-unpatched': 'Install toggle', unavailable: 'Terminal available', missing: 'Terminal available', untrusted: 'Trust required' };
    status.text = `$(shield) Temporary Chat: ${labels[state.status] || 'Terminal available'}`;
    status.tooltip = state.detail || 'Open temporary chat controls. Terminal chat is independent of the Codex renderer.';
    status.show();
  };
  const reload = async message => {
    const selection = await vscode.window.showInformationMessage(message, 'Reload Window');
    if (selection === 'Reload Window' && !stopped) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  };
  const check = async mode => {
    if (stopped) return state;
    if (!vscode.workspace.isTrusted) {
      state = { status: 'untrusted', detail: 'Trust this workspace before repairing Codex or starting a terminal.' };
      render(); return state;
    }
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    if (!extension) {
      state = { status: 'missing', detail: 'Codex extension is not installed or enabled. The temporary terminal client remains available.' };
      render(); return state;
    }
    const root = extension.extensionPath;
    try {
      const inspection = inspect(root);
      const shouldRepair = mode === 'repair' || (mode === 'auto' && config().get('autoRepair', true) && (inspection.status === 'patched' || managed()));
      const result = shouldRepair ? await ensure(root) : inspection;
      if (result.action === 'reapplied') {
        reloadRequired = true;
        reloadReason = 'The patch is installed on disk. Reload VS Code before using the embedded Temporary toggle.';
      }
      state = { ...result, status: reloadRequired ? 'reload' : result.status, root,
        detail: reloadRequired ? reloadReason : `Codex ${result.extensionVersion}: ${result.status}. Click for temporary chat controls.` };
      render();
      if (result.action === 'reapplied') void reload('Temporary Chat repaired the compatible Codex extension. Reload the window to load it.').catch(error => output.appendLine(error.message));
    } catch (error) {
      state = { status: 'unavailable', root, detail: 'Embedded Temporary Mode is unavailable. Use Start Terminal Chat; ordinary Codex chats are not made temporary by this companion.' };
      output.appendLine(`Codex ${extension.packageJSON?.version || 'unknown'}: ${error.message}`);
      render();
      const key = `${root}:${error.message}`;
      if (mode === 'repair' || (mode === 'auto' && managed() && config().get('autoRepair', true) && noticeKey !== key)) {
        noticeKey = key;
        // A notification must not hold activation or the update queue open.
        void Promise.resolve(vscode.window.showWarningMessage('Embedded Temporary Mode could not be repaired. Temporary terminal chat is still available.', 'Start Terminal Chat', 'Show Details')).then(async choice => {
          if (choice === 'Start Terminal Chat' && !stopped) await startTerminal();
          if (choice === 'Show Details' && !stopped) output.show();
        }).catch(error => output.appendLine(error.message));
      }
    }
    return state;
  };
  // Serialize update notifications and manual requests within this window.
  const refresh = (mode = 'check') => {
    const next = queue.then(() => check(mode));
    queue = next.catch(error => output.appendLine(error.message));
    return next;
  };
  const startTerminal = async () => {
    if (!vscode.workspace.isTrusted) return vscode.window.showWarningMessage('Trust this workspace before starting a temporary terminal chat.');
    // UI extensions run locally; never reinterpret a remote workspace URI as
    // a local directory with the same path.
    if (vscode.env.remoteName) return vscode.window.showInformationMessage('Open a terminal on the remote host and run codex-temporary-mode there. This companion manages local VS Code installations.');
    const folders = vscode.workspace.workspaceFolders || [];
    const selected = folders.length > 1 ? await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose the temporary chat workspace' }) : folders[0];
    if (folders.length > 1 && !selected) return;
    if (selected && selected.uri.scheme !== 'file') return vscode.window.showWarningMessage('Temporary terminal chat requires a local filesystem workspace.');
    try {
      const options = launchOptions({ nodePath: config().get('nodePath', ''), cwd: selected?.uri.fsPath || os.homedir() });
      vscode.window.createTerminal(options).show();
    } catch (error) { await vscode.window.showErrorMessage(error.message); }
  };
  const toggle = async () => {
    const current = await refresh();
    if (current.status !== 'patched') return vscode.window.showWarningMessage('Embedded Temporary Mode is not ready. Repair/reload it, or use Start Terminal Chat.');
    const setting = vscode.workspace.getConfiguration('codex');
    const target = setting.inspect('temporaryChats')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await setting.update('temporaryChats', setting.get('temporaryChats', false) !== true, target);
    reloadRequired = true;
    reloadReason = 'Reload VS Code to discard chats prewarmed in the previous storage mode.';
    state = { ...state, status: 'reload', detail: reloadReason };
    render();
    await reload('Temporary mode changed. Reload before starting an embedded chat to discard prewarmed threads.');
  };
  const restore = async () => {
    await queue;
    if (!vscode.workspace.isTrusted) return vscode.window.showWarningMessage('Trust this workspace before restoring Codex files.');
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    if (!extension) return vscode.window.showInformationMessage('No enabled Codex extension was found.');
    try {
      restorePatch(extension.extensionPath);
      reloadRequired = true;
      reloadReason = 'Original Codex files restored and automatic repair opt-in cleared. Reload VS Code to unload the patch.';
      await refresh();
      void reload(reloadReason).catch(error => output.appendLine(error.message));
    } catch (error) { await vscode.window.showErrorMessage(error.message); }
  };
  const menu = async () => {
    const selected = await vscode.window.showQuickPick([
      { label: 'Start Terminal Chat', description: 'Independent of the Codex renderer', action: startTerminal },
      { label: 'Toggle Embedded Mode', description: state.detail, action: toggle },
      { label: 'Repair Embedded Toggle', description: 'Validate compatibility and apply the patch', action: () => refresh('repair') },
      { label: 'Check Codex Compatibility', action: () => refresh() },
      { label: 'Restore Original Codex Files', description: 'Remove the embedded patch and stop automatic repair', action: restore },
    ], { placeHolder: 'Temporary Chat' });
    await selected?.action();
  };
  context.subscriptions.push(output, status, { dispose() { stopped = true; } });
  for (const [name, callback] of Object.entries({ menu, terminal: startTerminal, toggle, restore, repair: () => refresh('repair'), check: () => refresh() })) {
    context.subscriptions.push(vscode.commands.registerCommand(command(name), callback));
  }
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => { void refresh('auto'); }),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('temporaryCompanion.autoRepair')) void refresh('auto'); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { void refresh('auto'); }),
  );
  render();
  await refresh('auto');
  return { refresh, getState: () => ({ ...state }) };
}
