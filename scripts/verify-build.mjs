import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const parent = fs.realpathSync(os.tmpdir());
const stage = fs.mkdtempSync(path.join(parent, 'ghostthread-build-'));
try {
  fs.cpSync(path.join(root, 'build'), stage, { recursive: true });
  for (const dir of ['test', 'fixtures']) fs.cpSync(path.join(root, dir), path.join(stage, dir), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));
  const env = { ...process.env };
  // Installed-source checks compare byte-for-byte with the original installed helper.
  delete env.TEMP_CODEX_REVIEW_EXTENSION;
  const result = spawnSync(process.execPath, ['--test'], { cwd: stage, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (fs.realpathSync(stage) !== stage || path.dirname(stage) !== parent || !path.basename(stage).startsWith('ghostthread-build-')) throw new Error('Unsafe test cleanup path');
  fs.rmSync(stage, { recursive: true });
}
