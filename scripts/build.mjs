import fs from 'node:fs/promises';
import { transform } from 'esbuild';

const root = new URL('../', import.meta.url);
const output = new URL('build/', root);
// This fixed directory contains generated files only.
await fs.rm(output, { recursive: true, force: true });
const files = ['ghostthread.mjs', 'temp-codex.mjs', 'patch.mjs',
  'lib/app-server.mjs', 'lib/terminal.mjs', 'lib/installers.mjs', 'lib/vscode-adapter.mjs',
  'src/inject/composer-ui.js', 'src/inject/vscode-inject.cjs'];
for (const file of files) {
  const source = await fs.readFile(new URL(file, root), 'utf8');
  const { code } = await transform(source, {
    loader: 'js', target: 'es2022', minify: true, sourcemap: false,
    legalComments: 'none',
    // Preserve top-level names in scripts injected into another JavaScript context.
    ...(file.endsWith('.mjs') ? { format: 'esm' } : {}),
  });
  const destination = new URL(file, output);
  await fs.mkdir(new URL('./', destination), { recursive: true });
  await fs.writeFile(destination, code);
}
for (const file of ['ghostthread.mjs', 'temp-codex.mjs', 'patch.mjs']) {
  await fs.chmod(new URL(file, output), 0o755);
}
console.log('Built minified release files (no source maps).');
