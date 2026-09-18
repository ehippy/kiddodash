'use strict';

// Test runner for `npm test`.
//
// KiddoDash needs Node 22+ (built-in `node:sqlite`), so the suite boots the real server;
// an older interpreter cannot run it at all. Rather than failing on the interpreter alone,
// fall back to a locally available runtime when one exists (KIDDOSH_NODE or
// node_modules/.runtime/node22), and otherwise explain what is needed.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const FALLBACKS = [
  process.env.KIDDOSH_NODE,
  path.join(__dirname, '..', 'node_modules', '.runtime', 'node22'),
  path.join(__dirname, '..', 'node_modules', '.runtime', 'node')
].filter(Boolean);

const hasSqlite = (executable) =>
  spawnSync(executable, ['-e', "require('node:sqlite')"], { encoding: 'utf8' }).status === 0;

function testFiles() {
  return fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join(TEST_DIR, f));
}

function runWith(executable, files) {
  const child = spawn(executable, ['--test', ...files], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
}

function main() {
  const files = testFiles();
  if (!files.length) {
    console.error('No *.test.js files found in test/');
    process.exit(1);
  }

  if (hasSqlite(process.execPath)) return runWith(process.execPath, files);

  const fallback = FALLBACKS.find((candidate) => fs.existsSync(candidate) && hasSqlite(candidate));
  if (fallback) {
    const version = spawnSync(fallback, ['--version'], { encoding: 'utf8' }).stdout.trim();
    console.log(`note: this interpreter (${process.version}) has no node:sqlite; using ${fallback} (${version})`);
    return runWith(fallback, files);
  }

  console.error(`KiddoDash tests need Node.js 22+ with the built-in node:sqlite module.
  current interpreter: ${process.execPath} (${process.version})
  tried fallbacks: ${FALLBACKS.join(', ') || '(none configured)'}
Install Node 22+ (or point KIDDOSH_NODE at it) and run \`npm test\` again.`);
  process.exit(1);
}

main();
