'use strict';

// Foreign keys are enforced on the connection, so deleting a kid (or a chore) takes its
// completions/redemptions with it instead of orphaning rows that would keep inflating
// /api/totals and /api/redeem balances forever.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { bootServer } = require('./helpers');

test('deleting a kid cascades to its completions and redemptions', async () => {
  const srv = await bootServer();
  try {
    const kid = await srv.api('POST', '/api/kids', { name: 'Ada', emoji: '🚀' });
    const dishes = await srv.api('POST', '/api/chores', { title: 'Dishes', points: 5, frequency: 'daily' });
    const bins = await srv.api('POST', '/api/chores', { title: 'Bins', points: 5, frequency: 'weekly' });
    assert.equal(kid.status, 201);
    assert.equal(dishes.status, 201);
    assert.equal(bins.status, 201);

    assert.equal((await srv.api('POST', '/api/completions', { choreId: dishes.body.id, kidId: kid.body.id, date: '2020-01-01' })).status, 201);
    assert.equal((await srv.api('POST', '/api/completions', { choreId: bins.body.id, kidId: kid.body.id, date: '2020-01-02' })).status, 201);

    // The duplicate guard is what the UNIQUE index buys us — it must survive.
    const dup = await srv.api('POST', '/api/completions', { choreId: dishes.body.id, kidId: kid.body.id, date: '2020-01-01' });
    assert.equal(dup.status, 409);
    assert.deepEqual(dup.body, { error: 'Already completed for that day — undo it first' });

    const beforeRedeem = await srv.api('GET', '/api/totals');
    assert.equal(beforeRedeem.status, 200);
    assert.deepEqual(beforeRedeem.body, [
      { id: 1, name: 'Ada', color: '#7c3aed', emoji: '🚀', earned: 10, spent: 0, balance: 10 }
    ]);

    const spend = await srv.api('POST', '/api/redeem', { kidId: kid.body.id, reward: { label: 'Ice cream', points: 10 } });
    assert.equal(spend.status, 201);
    assert.equal(spend.body.balance, 0);
    const totalsAfterSpend = await srv.api('GET', '/api/totals');
    assert.deepEqual(totalsAfterSpend.body, [
      { id: 1, name: 'Ada', color: '#7c3aed', emoji: '🚀', earned: 10, spent: 10, balance: 0 }
    ]);

    assert.equal(srv.scalar('SELECT COUNT(*) FROM completions'), 2);
    assert.equal(srv.scalar('SELECT COUNT(*) FROM redemptions'), 1);

    const del = await srv.api('DELETE', `/api/kids/${kid.body.id}`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { ok: true });

    const after = await srv.api('GET', '/api/totals');
    assert.equal(after.status, 200);
    assert.deepEqual(after.body, []);

    // Proof the cascade fired, read through a separate connection.
    assert.equal(srv.scalar('SELECT COUNT(*) FROM completions'), 0);
    assert.equal(srv.scalar('SELECT COUNT(*) FROM redemptions'), 0);

    // Deleting something that is not there is still 404, same shape.
    const again = await srv.api('DELETE', `/api/kids/${kid.body.id}`);
    assert.equal(again.status, 404);
    assert.deepEqual(again.body, { error: 'Kid not found' });
  } finally {
    await srv.stop();
  }
});

test('deleting a chore cascades to its completions', async () => {
  const srv = await bootServer();
  try {
    const kid = await srv.api('POST', '/api/kids', { name: 'Bo' });
    const chore = await srv.api('POST', '/api/chores', { title: 'Toys', points: 3 });
    assert.equal((await srv.api('POST', '/api/completions', { choreId: chore.body.id, kidId: kid.body.id, date: '2020-02-02' })).status, 201);
    assert.equal(srv.scalar('SELECT COUNT(*) FROM completions'), 1);

    const del = await srv.api('DELETE', `/api/chores/${chore.body.id}`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { ok: true });
    assert.equal(srv.scalar('SELECT COUNT(*) FROM completions'), 0);

    const again = await srv.api('DELETE', `/api/chores/${chore.body.id}`);
    assert.equal(again.status, 404);
    assert.deepEqual(again.body, { error: 'Chore not found' });
  } finally {
    await srv.stop();
  }
});

test('other endpoints keep their shapes while FKs are enforced', async () => {
  const srv = await bootServer();
  try {
    const kid = await srv.api('POST', '/api/kids', { name: 'Bo' });
    const chore = await srv.api('POST', '/api/chores', { title: 'Toys', points: 3, frequency: 'daily', dayOfWeek: 1 });
    const completion = await srv.api('POST', '/api/completions', { choreId: chore.body.id, kidId: kid.body.id, date: '2020-06-06' });
    assert.deepEqual(Object.keys(completion.body).sort(), ['choreId', 'doneDate', 'id', 'kidId', 'points']);

    const kids = await srv.api('GET', '/api/kids');
    assert.deepEqual(Object.keys(kids.body[0]).sort(), ['color', 'created_at', 'emoji', 'hasPin', 'id', 'name', 'points']);
    const chores = await srv.api('GET', '/api/chores');
    assert.deepEqual(Object.keys(chores.body[0]).sort(), ['active', 'day_of_week', 'doneToday', 'frequency', 'id', 'points', 'title']);
    const week = await srv.api('GET', '/api/week');
    assert.deepEqual(Object.keys(week.body).sort(), ['chores', 'grid', 'kids', 'week']);
    const completions = await srv.api('GET', '/api/completions?date=2020-06-06');
    assert.equal(completions.body.length, 1);
    assert.equal(completions.body[0].kid_name, 'Bo');
    const undo = await srv.api('DELETE', `/api/completions/${completion.body.id}`);
    assert.deepEqual(undo.body, { ok: true });
    assert.equal((await srv.api('DELETE', `/api/completions/${completion.body.id}`)).status, 404);
    const redeemables = await srv.api('GET', '/api/settings');
    assert.ok(Array.isArray(redeemables.body.rewards));
  } finally {
    await srv.stop();
  }
});

test('server.js turns foreign keys on itself and restores them after every rebuild', () => {
  // node:sqlite happens to enable the pragma on new connections in recent Node releases,
  // but that is an implementation detail — the server must not depend on it.
  const file = join(__dirname, '..', 'server.js');
  assert.ok(existsSync(file));
  const source = readFileSync(file, 'utf8');

  const enable = source.search(/PRAGMA foreign_keys = ON/i);
  assert.ok(enable > -1, 'expected an explicit `PRAGMA foreign_keys = ON`');
  assert.ok(enable > source.indexOf('new DatabaseSync('), 'must be issued on the opened connection');
  assert.ok(enable < source.indexOf('PRAGMA journal_mode'), 'must be set before any other statement');

  // Every rebuild that drops enforcement has to put it back, so the connection ends
  // each migration in the state startup established (ON).
  const off = (source.match(/PRAGMA foreign_keys = OFF/gi) || []).length;
  const on = (source.match(/PRAGMA foreign_keys = ON/gi) || []).length;
  assert.equal(on, off + 1, 'each `= OFF` needs a matching restore to ON, plus the startup enable');
});
