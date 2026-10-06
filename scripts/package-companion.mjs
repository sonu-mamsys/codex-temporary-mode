import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'companion/package.json'), 'utf8'));
const files = new Map();
const add = (name, source) => files.set(name, Buffer.isBuffer(source) ? source : Buffer.from(source));
for (const name of ['companion/extension.cjs', 'companion/controller.mjs', 'codex-temporary-mode.mjs',
  'lib/terminal.mjs', 'lib/app-server.mjs', 'lib/installers.mjs', 'lib/vscode-adapter.mjs',
  'src/inject/composer-ui.js', 'src/inject/vscode-inject.cjs']) {
  const { code } = await transform(fs.readFileSync(path.join(root, name), 'utf8'), {
    loader: 'js', target: 'es2022', minify: true, sourcemap: false, legalComments: 'none',
    ...(name.endsWith('.mjs') ? { format: 'esm' } : {}),
  });
  add(`extension/${name}`, code);
}
add('extension/package.json', JSON.stringify(metadata, null, 2));
add('extension/README.md', fs.readFileSync(path.join(root, 'companion/README.md')));
add('extension/LICENSE', fs.readFileSync(path.join(root, 'LICENSE')));
add('[Content_Types].xml', '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="vsixmanifest" ContentType="text/xml"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="mjs" ContentType="application/javascript"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="" ContentType="text/plain"/></Types>');
add('extension.vsixmanifest', `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
<Metadata><Identity Language="en-US" Id="${metadata.name}" Version="${metadata.version}" Publisher="${metadata.publisher}"/><DisplayName>${metadata.displayName}</DisplayName><Description xml:space="preserve">${metadata.description}</Description><Tags>codex,temporary</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${metadata.engines.vscode}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/><Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true"/></Properties><License>extension/LICENSE</License></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/></Assets></PackageManifest>`);

// A small deterministic, uncompressed ZIP avoids a packaging dependency and
// includes only the explicitly listed runtime files, never workspace settings.
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const records = [], directory = [];
let offset = 0;
for (const [name, data] of files) {
  const filename = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
  records.push(local, filename, data); directory.push(central, filename);
  offset += local.length + filename.length + data.length;
}
const central = Buffer.concat(directory);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
const destination = path.join(root, 'dist', `${metadata.name}-${metadata.version}.vsix`);
fs.mkdirSync(path.dirname(destination), { recursive: true });
const archive = Buffer.concat([...records, central, end]);
fs.writeFileSync(destination, archive);
// Stable runtime path inside the npm files allowlist. Build clears stale assets.
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'companion.vsix'), archive);
console.log(`Packaged ${path.relative(root, destination)} (${files.size} allowlisted files).`);
