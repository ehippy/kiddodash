'use strict';

// Shared helpers for the KiddoDash test suite. Each test boots the real server in a
// child process against a throwaway DATA_DIR and talks to it over HTTP, so the tests
// exercise the same code path the Docker image does. Database assertions open the DB
// through a *second* connection, i.e. what `sqlite3 "$DATA_DIR/kiddodash.db" ...` shows.

const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SERVER = join(__dirname, '..', 'server.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** SQLite rows are null-prototype objects; copy them so they compare to literals. */
const plain = (rows) => rows.map((row) => ({ ...row }));

/** Ask the OS for a free port (test files run in parallel, so no fixed ports). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start server.js and resolve once /api/health answers.
 * Pass `dataDir` to (re)start against an existing database.
 */
async function bootServer({ dataDir, env = {} } = {}) {
  const dir = dataDir || mkdtempSync(join(os.tmpdir(), 'kiddodash-test-'));
  const port = await freePort();
  const log = [];
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(port) },
  });
  child.stdout.on('data', (d) => log.push(String(d).trim()));
  child.stderr.on('data', (d) => log.push(String(d).trim()));

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    try {
      up = (await fetch(`${base}/api/health`)).ok;
    } catch {
      /* not listening yet */
    }
    if (!up) await wait(100);
  }
  if (!up) throw new Error(`server did not start:\n${log.join('\n')}`);

  const withDb = (fn) => {
    const handle = new DatabaseSync(join(dir, 'kiddodash.db'));
    try {
      return fn(handle);
    } finally {
      handle.close();
    }
  };

  return {
    dataDir: dir,
    base,
    /** stdout+stderr of the server, without Node's experimental-sqlite noise. */
    logsJoined: () =>
      log
        .filter((line) => !/Experimental|trace-warnings/.test(line))
        .join('\n'),
    api: async (method, route, body) => {
      const res = await fetch(base + route, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed };
    },
    /** Read the DB out-of-band. */
    query: (sql, ...args) => withDb((handle) => plain(handle.prepare(sql).all(...args))),
    /** SELECT a single number, e.g. a COUNT(*). */
    scalar: (sql, ...args) => withDb((handle) => Object.values(handle.prepare(sql).get(...args))[0]),
    /**
     * Write to the DB behind the server's back -- reproduces what the old, FK-less
     * code left in a live database. Enforcement is switched off on *this* connection
     * first so deliberately bogus rows are accepted on any Node version.
     */
    seed: (sql) =>
      withDb((handle) => {
        handle.exec('PRAGMA foreign_keys = OFF;');
        return handle.prepare(sql).run();
      }),
    stop: async () => {
      child.kill('SIGTERM');
      await wait(250);
    },
  };
}

/** Create a data dir holding a database with the pre-migration schemas. */
function createLegacyDb({ completions = 'legacy' } = {}) {
  const dataDir = mkdtempSync(join(os.tmpdir(), 'kiddodash-legacy-'));
  const handle = new DatabaseSync(join(dataDir, 'kiddodash.db'));
  handle.exec(`
    CREATE TABLE kids (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#7c3aed', emoji TEXT NOT NULL DEFAULT '🙂',
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE chores (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 1,
      frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('daily', 'weekly')),
      day_of_week INTEGER, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid_id INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
      reward_label TEXT NOT NULL, points INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  if (completions === 'modern') {
    // Already UNIQUE and already carrying FK clauses: only `chores` needs rebuilding.
    handle.exec(`
      CREATE TABLE completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chore_id INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
        kid_id INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        done_date TEXT NOT NULL, points INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (chore_id, kid_id, done_date));
      CREATE INDEX idx_completions_date ON completions(done_date);
    `);
  } else {
    // No UNIQUE, no FK clauses: the old completions table migrate() must rebuild.
    handle.exec(`
      CREATE TABLE completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chore_id INTEGER NOT NULL, kid_id INTEGER NOT NULL,
        done_date TEXT NOT NULL, points INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);
  }
  handle.close();
  return dataDir;
}

/** Seed rows into a data dir before the server boots (FKs off on this connection). */
function seedDb(dataDir, sql) {
  const handle = new DatabaseSync(join(dataDir, 'kiddodash.db'));
  try {
    handle.exec('PRAGMA foreign_keys = OFF;');
    return handle.prepare(sql).run();
  } finally {
    handle.close();
  }
}

/** Read rows from a data dir without the server running. */
function queryDb(dataDir, sql, ...args) {
  const handle = new DatabaseSync(join(dataDir, 'kiddodash.db'));
  try {
    return plain(handle.prepare(sql).all(...args));
  } finally {
    handle.close();
  }
}

/** SELECT a single number from a data dir without the server running. */
function scalarDb(dataDir, sql, ...args) {
  const handle = new DatabaseSync(join(dataDir, 'kiddodash.db'));
  try {
    return Object.values(handle.prepare(sql).get(...args))[0];
  } finally {
    handle.close();
  }
}

module.exports = { bootServer, createLegacyDb, seedDb, queryDb, scalarDb, wait };
