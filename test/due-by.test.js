'use strict';

// 'due_by' chores: each kid does it once per chart week, on any day, and the one
// stored day is the deadline. The UNIQUE index only stops same-day duplicates, so the
// once-a-week rule lives in POST /api/completions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { bootServer } = require('./helpers');

test('due_by keeps exactly one deadline day', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());

  const wed = await srv.api('POST', '/api/chores', { title: 'Laundry', frequency: 'due_by', days: [3] });
  assert.equal(wed.status, 201);
  assert.equal(wed.body.frequency, 'due_by');
  assert.equal(wed.body.days, '3');

  // Several days picked -> only one survives; none picked -> last day of the week
  // (Sunday, with the default Monday start).
  const many = await srv.api('POST', '/api/chores', { title: 'A', frequency: 'due_by', days: [4, 1] });
  assert.equal(many.body.days, '1');
  const none = await srv.api('POST', '/api/chores', { title: 'B', frequency: 'due_by' });
  assert.equal(none.body.days, '0');

  // Switching an existing personal chore over keeps the one day it had.
  const personal = await srv.api('POST', '/api/chores', { title: 'C', frequency: 'personal', days: [1] });
  const moved = await srv.api('PUT', `/api/chores/${personal.body.id}`, { frequency: 'due_by' });
  assert.equal(moved.body.frequency, 'due_by');
  assert.equal(moved.body.days, '1');
});

test('due_by allows one completion per kid per week, on any day', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());

  const ada = await srv.api('POST', '/api/kids', { name: 'Ada' });
  const bo = await srv.api('POST', '/api/kids', { name: 'Bo' });
  const laundry = await srv.api('POST', '/api/chores', { title: 'Laundry', points: 3, frequency: 'due_by', days: [1] });
  const done = (kid, date) =>
    srv.api('POST', '/api/completions', { choreId: laundry.body.id, kidId: kid.body.id, date });

  // Week of Mon 2020-01-06 .. Sun 2020-01-12; the deadline (Monday) has passed by Tuesday.
  assert.equal((await done(ada, '2020-01-07')).status, 201, 'late is still allowed');
  const again = await done(ada, '2020-01-11');
  assert.equal(again.status, 409);
  assert.deepEqual(again.body, { error: 'Already done this week — undo it first' });

  assert.equal((await done(bo, '2020-01-11')).status, 201, 'the other kid is independent');
  assert.equal((await done(ada, '2020-01-13')).status, 201, 'next week starts fresh');

  // Late completions earn full points.
  assert.equal(srv.scalar('SELECT SUM(points) FROM completions WHERE kid_id = ?', ada.body.id), 6);
});

test('an existing chores table is widened for due_by without losing rows', async (t) => {
  // The schema as it stood before due_by: `days` column, four-value CHECK.
  const dataDir = mkdtempSync(join(os.tmpdir(), 'kiddodash-dueby-'));
  const handle = new DatabaseSync(join(dataDir, 'kiddodash.db'));
  handle.exec(`
    CREATE TABLE chores (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 1,
      frequency TEXT NOT NULL DEFAULT 'weekly'
                CHECK (frequency IN ('daily', 'weekly', 'personal', 'schooldays')),
      days TEXT, active INTEGER NOT NULL DEFAULT 1);
    INSERT INTO chores (id, title, points, frequency, days) VALUES
      (7, 'Laundry', 2, 'personal', '1'), (9, 'Plants', 1, 'weekly', '1,4,5');
  `);
  handle.close();

  const srv = await bootServer({ dataDir });
  t.after(() => srv.stop());
  assert.match(srv.logsJoined(), /migrated: chores now support due-by-day weekly chores/);
  assert.doesNotMatch(srv.logsJoined(), /personal frequency|multiple days per week/, 'older rebuilds must not re-run');
  assert.deepEqual(srv.query('SELECT id, title, frequency, days FROM chores ORDER BY id'), [
    { id: 7, title: 'Laundry', frequency: 'personal', days: '1' },
    { id: 9, title: 'Plants', frequency: 'weekly', days: '1,4,5' },
  ]);
  const moved = await srv.api('PUT', '/api/chores/7', { frequency: 'due_by' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.frequency, 'due_by');
});
