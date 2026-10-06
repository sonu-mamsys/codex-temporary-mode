import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function bundledCompanion() {
  const candidates = ['../companion.vsix', '../build/companion.vsix']
    .map(relative => fileURLToPath(new URL(relative, import.meta.url)));
  const filename = candidates.find(candidate => fs.existsSync(candidate));
  if (!filename) throw new Error('Bundled companion is missing. Reinstall the npm package, or run npm run build in a source checkout.');
  return filename;
}

export function resolveCodeCli({ codePath, env = process.env, platform = process.platform } = {}) {
  const searchPath = Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1] || '';
  const candidates = codePath ? [path.resolve(codePath)] : searchPath.split(path.delimiter).filter(Boolean)
    .map(directory => path.join(directory.replace(/^"|"$/g, ''), platform === 'win32' ? 'code.cmd' : 'code'));
  if (!codePath && platform === 'win32') {
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'));
    if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, 'Microsoft VS Code', 'bin', 'code.cmd'));
  }
  if (!codePath && platform === 'darwin') candidates.push('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code');
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    if (platform !== 'win32') return { command: candidate, args: [], env };
    // Invoke VS Code's Node CLI directly: .cmd files require a shell on Windows.
    // Keeping executable and arguments separate also supports spaces safely.
    const root = candidate.toLowerCase().endsWith('.cmd') ? path.dirname(path.dirname(candidate)) : path.dirname(candidate);
    let cli = path.join(root, 'resources', 'app', 'out', 'cli.js');
    // New VS Code installers keep resources in a versioned directory. Read
    // only the constrained CLI path from its launcher; never execute the shell.
    const launcher = candidate.toLowerCase().endsWith('.cmd') ? candidate : path.join(root, 'bin', 'code.cmd');
    if (fs.existsSync(launcher)) {
      const match = fs.readFileSync(launcher, 'utf8').match(/"%~dp0\.\.\\((?:[a-z0-9][a-z0-9._-]*\\)?resources\\app\\out\\cli\.js)"/i);
      if (match) cli = path.join(root, ...match[1].split('\\'));
    }
    const executable = ['Code.exe', 'Code - Insiders.exe'].map(name => path.join(root, name)).find(filename => fs.existsSync(filename));
    if (executable && fs.existsSync(cli)) return { command: executable, args: [cli], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
  }
  throw new Error('VS Code CLI was not found. Add code to PATH, use --code-path <absolute CLI path>, or install the bundled VSIX with Extensions: Install from VSIX.');
}

export function installCompanion({ codePath, profile, run = spawnSync, resolveCli = resolveCodeCli, vsixPath = bundledCompanion() } = {}) {
  try {
    const cli = resolveCli({ codePath });
    const args = [...cli.args, '--install-extension', vsixPath, '--do-not-sync', ...(profile ? ['--profile', profile] : [])];
    const result = run(cli.command, args, { env: cli.env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 120_000 });
    if (result.error || result.status !== 0) throw new Error(String(result.stderr || result.error?.message || result.stdout || 'VS Code extension installation failed.').trim());
    return { status: 'configured', message: String(result.stdout || 'Companion installed. Reload VS Code.').trim(), vsixPath };
  } catch (error) {
    return { status: 'unavailable', message: `${error.message} Bundled VSIX: ${vsixPath}`, vsixPath };
  }
}

export function companionInstallCommand(args = []) {
  if (args[0] !== 'install') throw new Error('Use codex-temporary-mode companion install [--code-path <path>] [--profile <name>].');
  const options = {};
  for (let index = 1; index < args.length; index++) {
    const key = { '--code-path': 'codePath', '--profile': 'profile' }[args[index]];
    if (!key) throw new Error(`Unknown companion option: ${args[index]}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${args[index - 1]}.`);
    options[key] = value;
  }
  const result = installCompanion(options);
  console.log(`[companion] ${result.status}: ${result.message}`);
  if (result.status !== 'configured') process.exitCode = 1;
  else console.log('[companion] Reload VS Code, then use Temporary Chat: Open Controls.');
  return result;
}
