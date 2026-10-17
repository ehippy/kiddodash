'use strict';

// A parent can mark a check-off bogus from the activity ledger: the check-off
// comes off and the kid pays a 100-point penalty on top, even into the negative.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootServer } = require('./helpers');

test('marking a check-off bogus removes it and deducts a penalty', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());

  const kid = await srv.api('POST', '/api/kids', { name: 'Ada' });
  const chore = await srv.api('POST', '/api/chores', { title: 'Dishes', points: 30, frequency: 'daily' });
  await srv.api('POST', '/api/completions', { choreId: chore.body.id, kidId: kid.body.id, date: '2030-06-03' });

  const done = (await srv.api('GET', '/api/activity')).body.find((r) => r.action === 'done');
  assert.equal(done.bogus, false);

  const res = await srv.api('POST', `/api/activity/${done.id}/bogus`);
  assert.equal(res.status, 200);
  assert.equal(res.body.removed, 30);
  assert.equal(res.body.penalty, 100);
  assert.equal(res.body.balance, -100);

  const totals = (await srv.api('GET', '/api/totals')).body;
  assert.equal(totals.find((k) => k.id === kid.body.id).balance, -100);

  const rows = (await srv.api('GET', '/api/activity')).body;
  assert.equal(rows.find((r) => r.id === done.id).bogus, true);
  assert.deepEqual(rows.map((r) => [r.action, r.points]), [['penalty', -100], ['undo', -30], ['done', 30]]);

  const again = await srv.api('POST', `/api/activity/${done.id}/bogus`);
  assert.equal(again.status, 409);
  const penalty = rows.find((r) => r.action === 'penalty');
  assert.equal((await srv.api('POST', `/api/activity/${penalty.id}/bogus`)).status, 400);
});

test('an already-undone check-off still costs the penalty only', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());

  const kid = await srv.api('POST', '/api/kids', { name: 'Ada' });
  const chore = await srv.api('POST', '/api/chores', { title: 'Dishes', points: 30, frequency: 'daily' });
  const c = await srv.api('POST', '/api/completions', { choreId: chore.body.id, kidId: kid.body.id, date: '2030-06-03' });
  await srv.api('DELETE', `/api/completions/${c.body.id}`);

  const done = (await srv.api('GET', '/api/activity')).body.find((r) => r.action === 'done');
  const res = await srv.api('POST', `/api/activity/${done.id}/bogus`);
  assert.equal(res.body.removed, 0);
  assert.equal(res.body.balance, -100);
});
