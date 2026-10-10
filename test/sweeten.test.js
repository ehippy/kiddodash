'use strict';

// 'Sweeten': a parent piles a temporary bonus (sweeten_points, until a given day
// inclusive) onto a chore. Completions dated within the window pay base + bonus;
// after the window the chore reverts to its base price. The bonus rides on the
// completion row, so undoing a sweetened check-off removes exactly what was paid.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootServer } = require('./helpers');

test('sweeten sets, updates and clears a temporary bonus', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());

  const chore = await srv.api('POST', '/api/chores', { title: 'Patios & stairs', points: 100, frequency: 'weekly', days: [0] });
  const id = chore.body.id;
  assert.equal(chore.body.sweetenPoints ?? null, null);

  const set = await srv.api('POST', `/api/chores/${id}/sweeten`, { points: 150, until: '2030-06-09' });
  assert.equal(set.status, 200);
  assert.equal(set.body.sweeten_points, 150);
  assert.equal(set.body.sweeten_until, '2030-06-09');

  // Re-sweetening replaces the previous bonus.
  const again = await srv.api('POST', `/api/chores/${id}/sweeten`, { points: 200, until: '2030-06-12' });
  assert.equal(again.body.sweeten_points, 200);
  assert.equal(again.body.sweeten_until, '2030-06-12');

  const cleared = await srv.api('POST', `/api/chores/${id}/sweeten`, { points: 0 });
  assert.equal(cleared.body.sweeten_points, null);
  assert.equal(cleared.body.sweeten_until, null);
});

test('sweeten validates its input', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());

  const chore = await srv.api('POST', '/api/chores', { title: 'Sweep', points: 10, frequency: 'weekly', days: [1] });
  const id = chore.body.id;

  const noUntil = await srv.api('POST', `/api/chores/${id}/sweeten`, { points: 50 });
  assert.equal(noUntil.status, 400);
  const badDate = await srv.api('POST', `/api/chores/${id}/sweeten`, { points: 50, until: 'June 9' });
  assert.equal(badDate.status, 400);
  const negative = await srv.api('POST', `/api/chores/${id}/sweeten`, { points: -5, until: '2030-06-09' });
  assert.equal(negative.status, 400);
  const missing = await srv.api('POST', '/api/chores/9999/sweeten', { points: 5, until: '2030-06-09' });
  assert.equal(missing.status, 404);
});

test('completions inside the window pay base + bonus, outside pay base', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());

  const kid = await srv.api('POST', '/api/kids', { name: 'Ada' });
  const chore = await srv.api('POST', '/api/chores', { title: 'Patios', points: 100, frequency: 'weekly', days: [0] });
  await srv.api('POST', `/api/chores/${chore.body.id}/sweeten`, { points: 150, until: '2030-06-09' });

  const done = (date) =>
    srv.api('POST', '/api/completions', { choreId: chore.body.id, kidId: kid.body.id, date });

  const inside = await done('2030-06-08');
  assert.equal(inside.status, 201);
  assert.equal(inside.body.points, 250, 'base 100 + bonus 150');

  // The last day of the window still pays out; the day after does not.
  const lastDay = await done('2030-06-09');
  assert.equal(lastDay.status, 201);
  assert.equal(lastDay.body.points, 250);

  // (A fresh week: the shared-chore rule is one team per day, so use later dates.)
  const after = await done('2030-06-16');
  assert.equal(after.status, 201);
  assert.equal(after.body.points, 100, 'bonus expired — base price only');

  // Undo removes exactly what was paid.
  const undone = await srv.api('DELETE', `/api/completions/${inside.body.id}`);
  assert.equal(undone.status, 200);
  const totals = await srv.api('GET', '/api/totals');
  const ada = totals.body.find((k) => k.id === kid.body.id);
  assert.equal(ada.balance, 250 + 100);
});

test('team splits include the bonus', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());

  const ada = await srv.api('POST', '/api/kids', { name: 'Ada' });
  const bo = await srv.api('POST', '/api/kids', { name: 'Bo' });
  const chore = await srv.api('POST', '/api/chores', { title: 'Patios', points: 101, frequency: 'weekly', days: [0] });
  await srv.api('POST', `/api/chores/${chore.body.id}/sweeten`, { points: 149, until: '2030-06-09' });

  const team = await srv.api('POST', '/api/completions', {
    choreId: chore.body.id, kidIds: [ada.body.id, bo.body.id], date: '2030-06-08',
  });
  assert.equal(team.status, 201);
  // 101 + 149 = 250 split two ways.
  assert.deepEqual(team.body.completions.map((c) => c.points), [125, 125]);
});

test('/api/week exposes the sweetener', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());

  const chore = await srv.api('POST', '/api/chores', { title: 'Patios', points: 100, frequency: 'weekly', days: [0] });
  await srv.api('POST', `/api/chores/${chore.body.id}/sweeten`, { points: 150, until: '2030-06-09' });

  const week = await srv.api('GET', '/api/week?start=2030-06-03');
  const c = week.body.chores.find((x) => x.id === chore.body.id);
  assert.equal(c.sweetenPoints, 150);
  assert.equal(c.sweetenUntil, '2030-06-09');
});
