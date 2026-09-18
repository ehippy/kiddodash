'use strict';

// The legacy migrations still run now that foreign keys are enforced: the pre-migration
// `completions` table is rebuilt without losing rows, `idx_completions_date` comes back,
// the duplicate guard still answers 409, and no rebuild leaves another table's FK clause
// pointing at a `*_old` table.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootServer, createLegacyDb, seedDb, queryDb, scalarDb } = require('./helpers');

const indexExists = (dir, name) =>
  scalarDb(dir, "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name = ?", name) === 1;

test('legacy completions table is rebuilt, keeps every row, and still rejects duplicates with 409', async () => {
  const dataDir = createLegacyDb();
  seedDb(dataDir, "INSERT INTO kids (id, name) VALUES (1, 'Legacy Kid'), (2, 'Second')");
  seedDb(dataDir, "INSERT INTO chores (id, title, points, frequency) VALUES (1, 'Old chore', 6, 'daily'), (2, 'Twice chore', 6, 'weekly')");
  seedDb(dataDir, `INSERT INTO completions (id, chore_id, kid_id, done_date, points) VALUES
      (1, 1, 1, '2019-03-01', 6), (2, 2, 1, '2019-03-02', 6),
      (3, 2, 1, '2019-03-03', 6), (4, 2, 2, '2019-03-02', 6)`);
  // two rows whose parent no longer exists -> cleaned up right after the rebuild
  seedDb(dataDir, "INSERT INTO completions (id, chore_id, kid_id, done_date, points) VALUES (5, 77, 1, '2019-03-04', 6)");
  seedDb(dataDir, "INSERT INTO completions (id, chore_id, kid_id, done_date, points) VALUES (6, 2, 77, '2019-03-05', 6)");
  seedDb(dataDir, "INSERT INTO redemptions (id, kid_id, reward_label, points) VALUES (1, 1, 'old reward', 5), (2, 77, 'ghost reward', 5)");
  assert.equal(scalarDb(dataDir, 'SELECT COUNT(*) FROM completions'), 6);

  const boot = await bootServer({ dataDir });
  const log = boot.logsJoined();
  assert.match(log, /migrated: chores now supports personal frequency/);
  assert.match(log, /migrated: completions now unique per kid/);
  assert.match(log, /migrated: removed 2 orphaned completion\(s\), 1 orphaned redemption\(s\)/);

  assert.equal(scalarDb(dataDir, 'SELECT COUNT(*) FROM completions'), 4, 'no non-orphan row may be lost');
  assert.equal(scalarDb(dataDir, 'SELECT COUNT(*) FROM redemptions'), 1);
  assert.equal(scalarDb(dataDir, 'SELECT COUNT(*) FROM chores'), 2);
  assert.ok(indexExists(dataDir, 'idx_completions_date'), 'idx_completions_date must be recreated');
  assert.deepEqual(queryDb(dataDir, 'PRAGMA foreign_key_check'), [], 'rebuild must not break FK integrity');

  const dup = await boot.api('POST', '/api/completions', { choreId: 2, kidId: 1, date: '2019-03-02' });
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.body, { error: 'Already completed for that day — undo it first' });

  assert.equal((await boot.api('POST', '/api/completions', { choreId: 1, kidId: 1, date: '2021-01-01' })).status, 201);
  const personal = await boot.api('POST', '/api/chores', { title: 'Personal thing', frequency: 'personal', points: 2 });
  assert.equal(personal.status, 201);
  assert.equal(personal.body.frequency, 'personal');

  const del = await boot.api('DELETE', '/api/kids/1');
  assert.equal(del.status, 200);
  assert.equal(scalarDb(dataDir, 'SELECT COUNT(*) FROM completions WHERE kid_id = 1'), 0);
  assert.equal(scalarDb(dataDir, 'SELECT COUNT(*) FROM redemptions WHERE kid_id = 1'), 0);
  await boot.stop();

  // Migrations must not run twice.
  const second = await bootServer({ dataDir });
  try {
    assert.doesNotMatch(second.logsJoined(), /migrated:/, 'second boot should not re-run migrations');
  } finally {
    await second.stop();
  }
});

test('rebuilding chores leaves completions pointing at chores, not chores_old', async () => {
  // Renaming a parent table makes SQLite rewrite the FK clause of *other* tables to the
  // new name; that breaks inserts and cascades the moment FKs are enforced.
  const dataDir = createLegacyDb({ completions: 'modern' });
  seedDb(dataDir, "INSERT INTO kids (id, name) VALUES (1, 'Kid')");
  seedDb(dataDir, "INSERT INTO chores (id, title, points, frequency) VALUES (1, 'Chore', 4, 'daily')");
  seedDb(dataDir, "INSERT INTO completions (chore_id, kid_id, done_date, points) VALUES (1, 1, '2020-04-04', 4)");

  const boot = await bootServer({ dataDir });
  try {
    assert.match(boot.logsJoined(), /migrated: chores now supports personal frequency/);
    assert.doesNotMatch(boot.logsJoined(), /STDERR|Error:/, `server crashed during the rebuild:\n${boot.logsJoined()}`);

    const created = await boot.api('POST', '/api/completions', { choreId: 1, kidId: 1, date: '2021-05-05' });
    assert.equal(created.status, 201, `insert after the chores rebuild failed: ${JSON.stringify(created.body)}`);

    const del = await boot.api('DELETE', '/api/kids/1');
    assert.equal(del.status, 200);
    assert.equal(scalarDb(dataDir, 'SELECT COUNT(*) FROM completions'), 0, 'cascade broke after the chores rebuild');
    assert.deepEqual(queryDb(dataDir, 'PRAGMA foreign_key_check'), [], 'FK integrity must hold after the rebuild');
    const ddl = queryDb(dataDir, "SELECT sql FROM sqlite_master WHERE name = 'completions'")[0].sql;
    assert.doesNotMatch(ddl, /chores_old/, "completions' FK must still reference chores");
  } finally {
    await boot.stop();
  }
});
