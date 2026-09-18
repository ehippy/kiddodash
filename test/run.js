'use strict';

// Test runner for `npm test`.
//
// KiddoDash needs Node 22+ (built-in `node:sqlite`), so the suite boots the real server;
// an older interpreter cannot run it at all. Rather than failing on the interpreter alone,
// fall back to any Node 22+ runtime that is reachable (KIDDOSH_NODE, a vendored copy in
// node_modules/.runtime, another name on PATH, or a version manager's install), and only
// then explain what is missing.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const CANDIDATES = [
  process.env.KIDDOSH_NODE,
  path.join(__dirname, '..', '.runtime', 'node22'),
  path.join(__dirname, '..', 'node_modules', '.runtime', 'node22'),
  path.join(__dirname, '..', 'node_modules', '.runtime', 'node')
].filter(Boolean);
// Node 22+ under another name on PATH (images that ship several runtimes).
const ON_PATH = ['node24', 'node23', 'node22'];
const MANAGER_DIRS = [
  path.join(process.env.HOME || '', '.nvm/versions/node'),
  path.join(process.env.HOME || '', '.local/share/fnm'),
  '/usr/local/n/versions/node'
];

const hasSqlite = (executable) =>
  spawnSync(executable, ['-e', "require('node:sqlite')"], { encoding: 'utf8' }).status === 0;

function testFiles() {
  return fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join(TEST_DIR, f));
}

function fromVersionManagers() {
  for (const dir of MANAGER_DIRS) {
    if (!dir || !fs.existsSync(dir)) continue;
    const versions = fs
      .readdirSync(dir)
      .filter((v) => /^v?\d+/.test(v))
      // newest first: 22+ is required, the highest version wins
      .sort((a, b) => Number(String(b).replace(/\D/g, '')) - Number(String(a).replace(/\D/g, '')));
    for (const version of versions) {
      for (const exe of [
        path.join(dir, version, 'bin', 'node'),
        path.join(dir, version, 'node', 'bin', 'node')
      ]) {
        if (fs.existsSync(exe) && hasSqlite(exe)) return exe;
      }
    }
  }
  return null;
}

function resolveInterpreter() {
  if (hasSqlite(process.execPath)) return process.execPath;
  const found = CANDIDATES.find((c) => fs.existsSync(c) && hasSqlite(c));
  if (found) return found;
  for (const name of ON_PATH) {
    const which = spawnSync('which', [name], { encoding: 'utf8' }).stdout.trim();
    if (which && hasSqlite(which)) return which;
  }
  return fromVersionManagers();
}

function runWith(executable, files) {
  // The suite spawns server processes on purpose; --test-force-exit keeps the run from
  // hanging on a leftover child once the assertions are done.
  const args = ['--test', ...files];
  const probe = spawnSync(executable, ['--test-force-exit', '-e', ''], { encoding: 'utf8' });
  if (probe.status === 0) args.splice(1, 0, '--test-force-exit');
  const child = spawn(executable, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
}

function main() {
  const files = testFiles();
  if (!files.length) {
    console.error('No *.test.js files found in test/');
    process.exit(1);
  }

  const interpreter = resolveInterpreter();
  if (!interpreter) {
    console.error(`KiddoDash tests need Node.js 22+ with the built-in node:sqlite module.
  current interpreter: ${process.execPath} (${process.version})
  also tried: ${[...CANDIDATES, ...ON_PATH].join(', ')}
Install Node 22+ (or point KIDDOSH_NODE at it) and run \`npm test\` again.`);
    process.exit(1);
  }
  if (interpreter !== process.execPath) {
    const version = spawnSync(interpreter, ['--version'], { encoding: 'utf8' }).stdout.trim();
    console.log(`note: this interpreter (${process.version}) has no node:sqlite; using ${interpreter} (${version})`);
  }
  runWith(interpreter, files);
}

main();
