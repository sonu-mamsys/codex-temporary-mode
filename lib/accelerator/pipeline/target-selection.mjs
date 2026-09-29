import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalRelativePath } from '../paths.mjs';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const MAX_SOURCE_FILES = 4_096;
const MAX_SOURCE_BYTES = 1_048_576;
const MAX_SELECTED_TESTS = 64;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'coverage', 'dist', 'build']);
const STATIC_IMPORT = /(?:\bimport\s*['"]([^'"\\]+)['"]|\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)['"]([^'"\\]+)['"])/g;

function sorted(values) {
  return [...new Set(values)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function isSourceFile(file) { return SOURCE_EXTENSIONS.has(path.posix.extname(file).toLowerCase()); }
function isTestFile(file) { return /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(file); }

async function regularFile(filename) {
  try { return (await fs.lstat(filename)).isFile(); }
  catch { return false; }
}

async function workspaceFiles(workspaceRoot) {
  const files = [];
  let truncated = false;
  const walk = async relative => {
    if (files.length > MAX_SOURCE_FILES) return;
    let entries;
    try { entries = await fs.readdir(path.join(workspaceRoot, relative), { withFileTypes: true }); }
    catch { return; }
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      if (files.length > MAX_SOURCE_FILES) return;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(child);
      } else if (entry.isFile() && isSourceFile(child)) {
        files.push(child);
        if (files.length > MAX_SOURCE_FILES) { truncated = true; return; }
      }
    }
  };
  await walk('');
  return { files: files.slice(0, MAX_SOURCE_FILES), truncated };
}

function moduleCandidates(importer, specifier) {
  if (!specifier.startsWith('.') || specifier.includes('\0')) return [];
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (base === '..' || base.startsWith('../') || path.posix.isAbsolute(base)) return [];
  const extension = path.posix.extname(base);
  const direct = extension ? [base] : [...SOURCE_EXTENSIONS].map(item => `${base}${item}`);
  if (!extension) direct.push(...[...SOURCE_EXTENSIONS].map(item => `${base}/index${item}`));
  return direct;
}

async function directImportConsumers(workspaceRoot, changedFiles) {
  const changed = new Set(changedFiles.filter(isSourceFile));
  if (!changed.size) return { consumers: [], truncated: false };
  const consumers = [];
  const scan = await workspaceFiles(workspaceRoot);
  for (const importer of scan.files) {
    let text;
    try {
      const stat = await fs.stat(path.join(workspaceRoot, importer));
      if (stat.size > MAX_SOURCE_BYTES) continue;
      text = await fs.readFile(path.join(workspaceRoot, importer), 'utf8');
    } catch { continue; }
    STATIC_IMPORT.lastIndex = 0;
    let match;
    while ((match = STATIC_IMPORT.exec(text))) {
      if (moduleCandidates(importer, match[1] || match[2]).some(candidate => changed.has(candidate))) {
        consumers.push(importer);
        break;
      }
    }
  }
  return { consumers: sorted(consumers), truncated: scan.truncated };
}

async function conventionTests(workspaceRoot, sourceFiles) {
  const tests = [];
  const sourceFileLimitReached = sourceFiles.length > MAX_SOURCE_FILES;
  for (const sourceFile of sourceFiles.slice(0, MAX_SOURCE_FILES)) {
    if (isTestFile(sourceFile)) {
      if (await regularFile(path.join(workspaceRoot, sourceFile))) tests.push(sourceFile);
      continue;
    }
    const parsed = path.posix.parse(sourceFile);
    const basename = `${parsed.dir ? `${parsed.dir}/` : ''}${parsed.name}`;
    const parent = path.posix.basename(parsed.dir);
    const candidates = [
      ...[...SOURCE_EXTENSIONS].flatMap(extension => [`${basename}.test${extension}`, `${basename}.spec${extension}`]),
      ...[...SOURCE_EXTENSIONS].flatMap(extension => [
        `${parsed.dir ? `${parsed.dir}/` : ''}__tests__/${parsed.name}.test${extension}`,
        `${parsed.dir ? `${parsed.dir}/` : ''}__tests__/${parsed.name}.spec${extension}`,
      ]),
      ...[...SOURCE_EXTENSIONS].flatMap(extension => [
        `test/${parsed.name}.test${extension}`,
        `test/${parsed.name}.spec${extension}`,
        `tests/${parsed.name}.test${extension}`,
        `tests/${parsed.name}.spec${extension}`,
        ...(parent ? [
          `test/${parent}-${parsed.name}.test${extension}`,
          `test/${parent}-${parsed.name}.spec${extension}`,
          `tests/${parent}-${parsed.name}.test${extension}`,
          `tests/${parent}-${parsed.name}.spec${extension}`,
        ] : []),
      ]),
    ];
    for (const candidate of candidates) {
      if (await regularFile(path.join(workspaceRoot, candidate))) tests.push(candidate);
    }
  }
  const unique = sorted(tests);
  return {
    tests: unique.slice(0, MAX_SELECTED_TESTS),
    sourceFileLimitReached,
    selectedTestLimitReached: unique.length > MAX_SELECTED_TESTS,
  };
}

function canTargetTests(command) {
  return command.parser === 'vitest' || command.parser === 'jest';
}

function appendSelectedTests(command, selectedTests) {
  const args = [...command.args];
  const executable = path.basename(command.executable).toLowerCase().replace(/\.(?:cmd|exe)$/i, '');
  if ((executable === 'npm' || executable === 'npx') && !args.includes('--')) args.push('--');
  return [...args, ...selectedTests];
}

/**
 * Deterministically narrows only explicitly declared Vitest/Jest commands.
 * Configuration remains authoritative: the executable and configured arguments
 * are preserved, and paths are passed as argument-array entries (never a shell).
 */
export async function selectTargetedValidation({ workspaceRoot, commands, changedFiles }) {
  const changed = sorted(changedFiles.map(canonicalRelativePath));
  const consumerScan = await directImportConsumers(workspaceRoot, changed);
  const consumers = consumerScan.consumers;
  const testSelection = await conventionTests(workspaceRoot, [...changed, ...consumers]);
  const selectedTests = testSelection.tests;
  const fallbackReason = consumerScan.truncated || testSelection.sourceFileLimitReached
    ? 'source-file-scan-limit'
    : testSelection.selectedTestLimitReached ? 'selected-test-limit' : null;
  const selected = commands.map(command => {
    const targetable = !fallbackReason && selectedTests.length > 0 && canTargetTests(command);
    return {
      ...command,
      args: targetable ? appendSelectedTests(command, selectedTests) : [...command.args],
      impact: {
        strategy: targetable ? 'configured-test-command-with-selected-paths' : 'configured-command-unchanged',
        selectedTestCount: targetable ? selectedTests.length : 0,
        ...(fallbackReason ? { fallbackReason, fallbackImpact: 'Ran the complete configured test command because targeted selection was incomplete.' } : {}),
      },
    };
  });
  return {
    commands: selected,
    impact: {
      changedFileCount: changed.length,
      changedFiles: changed,
      directImportConsumers: consumers,
      selectedTests,
      ...(fallbackReason ? { selectionFallback: { reason: fallbackReason, impact: 'Targeted paths were omitted; configured test commands run with their original arguments.' } } : {}),
      commands: selected.map(command => ({ id: command.id, ...command.impact })),
    },
  };
}
