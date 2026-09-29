import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodex } from './app-server.mjs';
import { inspectVSCodePatch } from './installers.mjs';
import { loadPipelineConfig } from './accelerator/pipeline/config.mjs';

const PACKAGE_CANDIDATES = [
  fileURLToPath(new URL('../package.json', import.meta.url)),
  fileURLToPath(new URL('../../package.json', import.meta.url)),
];
const MANAGED_BEGIN = '# codex-temporary-mode: accelerator begin';
const MANAGED_END = '# codex-temporary-mode: accelerator end';

function packageVersion() {
  for (const filename of PACKAGE_CANDIDATES) {
    try { return JSON.parse(fs.readFileSync(filename, 'utf8')).version; }
    catch { /* Try the packaged location next. */ }
  }
  return 'unknown';
}

function check(id, status, message, details = undefined) {
  return { id, status, message, ...(details === undefined ? {} : { details }) };
}

function compareVersion(actual, minimum) {
  const parse = value => String(value).replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0);
  const a = parse(actual), b = parse(minimum);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

function bounded(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
}

function commandCheck(codexPath) {
  try {
    const launch = resolveCodex(codexPath);
    const version = bounded(launch.command, [...launch.args, '--version']);
    const mcp = bounded(launch.command, [...launch.args, 'mcp', 'list']);
    const versionText = String(version.stdout || version.stderr || '').trim().split(/\r?\n/, 1)[0];
    const details = {
      command: launch.command, args: launch.args,
      version: version.status === 0 ? versionText : null,
      mcpList: mcp.status === 0 ? 'ok' : 'unavailable',
      ...(mcp.status === 0 ? {} : { mcpExitCode: mcp.status, mcpError: String(mcp.stderr || mcp.error?.message || '').trim() || null }),
    };
    if (version.status !== 0) return check('codex-cli', 'warning', 'Codex CLI was located but did not answer --version.', details);
    if (mcp.status !== 0) return check('codex-cli', 'warning', `Codex CLI ${versionText || 'detected'}; \"codex mcp list\" did not complete.`, details);
    return check('codex-cli', 'ok', `Codex CLI ${versionText || 'detected'}; \"codex mcp list\" completed.`, details);
  } catch (error) {
    return check('codex-cli', 'warning', error.message);
  }
}

function workspaceCheck(cwd) {
  try {
    const workspace = execFileSync('git', ['--no-optional-locks', 'rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }).trim();
    return { workspace: fs.realpathSync(workspace), result: check('git-workspace', 'ok', `Git workspace: ${workspace}.`, { workspace }) };
  } catch {
    return { workspace: null, result: check('git-workspace', 'warning', `Not a Git workspace: ${cwd}.`) };
  }
}

function mcpCheck(workspace) {
  if (!workspace) return check('mcp-config', 'info', 'Skipped because no Git workspace was detected.');
  const filename = path.join(workspace, '.codex', 'config.toml');
  if (!fs.existsSync(filename)) return check('mcp-config', 'info', `No project MCP config at ${filename}. Run \"codex-temporary-mode accelerator setup\" to add the optional accelerator.`);
  try {
    const text = fs.readFileSync(filename, 'utf8');
    const begin = text.indexOf(MANAGED_BEGIN), end = text.indexOf(MANAGED_END);
    if (begin < 0 && end < 0) return check('mcp-config', 'info', `No managed codex_accelerator MCP block in ${filename}.`);
    if (begin < 0 || end < begin || text.indexOf(MANAGED_BEGIN, begin + 1) >= 0 || text.indexOf(MANAGED_END, end + 1) >= 0) {
      return check('mcp-config', 'warning', `Managed accelerator MCP block is incomplete in ${filename}.`);
    }
    return check('mcp-config', 'ok', `Managed codex_accelerator MCP block found in ${filename}.`, { path: filename });
  } catch (error) {
    return check('mcp-config', 'warning', `Could not inspect ${filename}: ${error.message}`);
  }
}

async function pipelineCheck(workspace) {
  if (!workspace) return check('pipeline-config', 'info', 'Skipped because no Git workspace was detected.');
  try {
    const config = await loadPipelineConfig(workspace);
    if (!config.found) return check('pipeline-config', 'info', `No Pipeline configuration at ${config.configPath}.`);
    return check('pipeline-config', 'ok', `Pipeline configuration is valid (${Object.keys(config.profiles).length} profile(s)).`, { path: config.configPath, profiles: Object.keys(config.profiles) });
  } catch (error) {
    return check('pipeline-config', 'warning', `Pipeline configuration is invalid or unreadable: ${error.message}`);
  }
}

function extensionRoots() {
  const home = os.homedir();
  return [
    path.join(home, '.vscode', 'extensions'), path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.cursor', 'extensions'), path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.vscode-server-insiders', 'extensions'),
  ];
}

function newestCodexExtension() {
  const candidates = [];
  for (const root of extensionRoots()) {
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('openai.chatgpt-')) continue;
      const directory = path.join(root, name);
      try {
        const stat = fs.statSync(directory);
        if (stat.isDirectory()) candidates.push({ directory, mtimeMs: stat.mtimeMs });
      } catch { /* An extension may be updating while doctor runs. */ }
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.directory || null;
}

function vscodeChecks() {
  const directory = newestCodexExtension();
  if (!directory) return [
    check('vscode-extension', 'info', 'No local OpenAI VS Code extension was detected.'),
    check('vscode-patch', 'info', 'Skipped because no local extension was detected.'),
  ];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    let patch;
    try {
      const inspection = inspectVSCodePatch(directory);
      patch = inspection.status === 'patched'
        ? check('vscode-patch', 'ok', `Temporary Mode patch is installed and intact (${inspection.profile || 'legacy profile'}).`, inspection)
        : check('vscode-patch', 'info', 'The extension layout is compatible but Temporary Mode is not installed. Run \"codex-temporary-mode temporary install\" to add it.', inspection);
    } catch (error) {
      patch = check('vscode-patch', 'warning', `Temporary Mode is not compatible with this extension layout: ${error.message}`);
    }
    return [
      check('vscode-extension', 'ok', `OpenAI VS Code extension ${pkg.version || 'unknown'} detected.`, { path: directory, version: pkg.version }),
      patch,
    ];
  } catch (error) {
    return [
      check('vscode-extension', 'warning', `Could not read the detected VS Code extension: ${error.message}`, { path: directory }),
      check('vscode-patch', 'info', 'Skipped because the detected extension could not be read.'),
    ];
  }
}

/** Read-only local environment diagnostics for support and bug reports. */
export async function doctor({ cwd = process.cwd(), codexPath } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const node = compareVersion(process.versions.node, '22.13.0') >= 0
    ? check('node', 'ok', `Node ${process.version}.`, { version: process.versions.node })
    : check('node', 'warning', `Node ${process.version} is below the required 22.13.0.`, { version: process.versions.node });
  const workspace = workspaceCheck(resolvedCwd);
  const checks = [node, workspace.result, commandCheck(codexPath), ...vscodeChecks(), mcpCheck(workspace.workspace), await pipelineCheck(workspace.workspace)];
  return { name: 'codex-temporary-mode', version: packageVersion(), cwd: resolvedCwd, readOnly: true, checks };
}

function marker(status) { return status === 'ok' ? '✓' : status === 'warning' ? '!' : '•'; }

export function printDoctor(result, { json = false, log = console.log } = {}) {
  if (json) { log(JSON.stringify(result, null, 2)); return; }
  log(`Codex Temporary Mode ${result.version} diagnostics (read-only)`);
  for (const item of result.checks) log(`${marker(item.status)} ${item.message}`);
  const warnings = result.checks.filter(item => item.status === 'warning').length;
  log(warnings ? `\n${warnings} item(s) need attention. This command made no changes.` : '\nNo blocking problems found. This command made no changes.');
}
