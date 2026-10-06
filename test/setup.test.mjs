import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup } from '../lib/setup.mjs';
import { installCompanion, resolveCodeCli } from '../lib/companion-install.mjs';
import { loadPipelineConfig } from '../lib/accelerator/pipeline/config.mjs';

test('companion installation passes paths and profile as arguments without a shell and reports failure', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'codex-companion-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'resources', 'app', 'out'), { recursive: true });
  for (const name of ['bin/code.cmd', 'Code.exe', 'resources/app/out/cli.js']) fs.writeFileSync(path.join(root, name), '');
  const codePath = path.join(root, 'bin', 'code.cmd');
  const cli = resolveCodeCli({ codePath, platform: 'win32', env: {} });
  assert.equal(cli.command, path.join(root, 'Code.exe'));
  assert.equal(cli.env.ELECTRON_RUN_AS_NODE, '1');
  fs.mkdirSync(path.join(root, '07f806f999'));
  fs.renameSync(path.join(root, 'resources'), path.join(root, '07f806f999', 'resources'));
  fs.writeFileSync(codePath, '"%~dp0..\\Code.exe" "%~dp0..\\07f806f999\\resources\\app\\out\\cli.js" %*');
  assert.equal(resolveCodeCli({ codePath, platform: 'win32', env: {} }).args[0], path.join(root, '07f806f999', 'resources', 'app', 'out', 'cli.js'));
  const vsixPath = path.join(root, 'companion with spaces & symbols.vsix');
  const options = { codePath, vsixPath, profile: 'Work & Personal', resolveCli: () => cli };
  const result = installCompanion({ ...options, run(command, args, spawnOptions) {
    assert.equal(command, cli.command);
    assert.deepEqual(args, [...cli.args, '--install-extension', vsixPath, '--do-not-sync', '--profile', options.profile]);
    assert.equal(spawnOptions.shell, false);
    return { status: 0, stdout: 'Installed' };
  } });
  assert.equal(result.status, 'configured');
  const failure = installCompanion({ ...options, run: () => ({ status: 1, stderr: 'Install failed' }) });
  assert.equal(failure.status, 'unavailable');
  assert(failure.message.includes(vsixPath));
});

test('setup configures all modes per repository without replacing existing project configuration', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'codex-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, '.codex'));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, '.codex', 'config.toml'), '[features]\nexample = true\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'node --test' } }));

  const calls = [], messages = [];
  const installs = [];
  const companionInstaller = options => { installs.push(options); return { status: 'configured' }; };
  const run = (command, args) => { calls.push({ command, args }); return { status: 0, stdout: 'Temporary Mode configured.' }; };
  const first = await setup(['--all', '--profile', 'Work'], { cwd: path.join(root, 'nested'), run, companionInstaller, log: message => messages.push(message) });
  const second = await setup(['--skip-vscode'], { cwd: root, run, companionInstaller, log() {} });

  const codexConfig = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[features\]\nexample = true/);
  assert.equal(codexConfig.match(/\[mcp_servers\.codex_accelerator\]/g)?.length, 1);
  assert.match(codexConfig, /CODEX_ACCELERATOR_EPHEMERAL/);
  const pipeline = JSON.parse(fs.readFileSync(path.join(root, '.codex', 'accelerator.json'), 'utf8'));
  const loadedPipeline = await loadPipelineConfig(root);
  assert.equal(pipeline.generatedBy, 'codex-temporary-mode');
  assert.equal(loadedPipeline.found, true);
  assert.deepEqual(pipeline.pipeline.profiles.targeted.map(item => item.id), ['typecheck', 'tests']);
  assert.deepEqual(pipeline.pipeline.profiles.final.map(item => item.id), ['typecheck', 'tests']);
  assert.equal(first.mcp.changed, true);
  // Windows Git may expand an 8.3 temp path while Node retains the short name.
  const configuredRoot = fs.statSync(first.workspaceRoot);
  const fixtureRoot = fs.statSync(root);
  assert.equal(configuredRoot.dev, fixtureRoot.dev);
  assert.equal(configuredRoot.ino, fixtureRoot.ino);
  assert.equal(second.mcp.changed, false);
  assert.equal(calls.length, 1);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].profile, 'Work');
  assert.equal(first.companion.status, 'configured');
  assert.equal(second.companion.status, 'skipped');
  assert(calls[0].args.includes('--vscode'));
  assert(messages.some(message => message.includes('Restart Codex')));
});
