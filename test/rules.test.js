'use strict';

// Server-side rules the UI relies on but must not be the only guard for:
// shared chores credit one kid per day, kids check off today only, kid PINs
// need a parent PIN first, deleting a kid ends their sessions, and the week
// grid can be asked for by the client's own start date.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootServer } = require('./helpers');

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// A server with a parent PIN, two kids with PINs, a shared and a per-kid chore.
async function bootFamily() {
  const srv = await bootServer({ env: { ADMIN_PIN: '9999' } });
  const login = async (pin) => (await srv.api('POST', '/api/auth/login', { pin })).body.token;
  const as = (token) => async (method, route, body) => {
    const res = await fetch(srv.base + route, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const admin = as(await login('9999'));
  const ada = (await admin('POST', '/api/kids', { name: 'Ada', pin: '1111' })).body;
  const bo = (await admin('POST', '/api/kids', { name: 'Bo', pin: '2222' })).body;
  const dishes = (await admin('POST', '/api/chores', { title: 'Dishes', frequency: 'daily', points: 5 })).body;
  const reading = (await admin('POST', '/api/chores', { title: 'Reading', frequency: 'personal', points: 3 })).body;
  return { srv, admin, as, login, ada, bo, dishes, reading };
}

test('a shared chore credits one kid per day', async (t) => {
  const f = await bootFamily();
  t.after(() => f.srv.stop());
  const first = await f.admin('POST', '/api/completions', { choreId: f.dishes.id, kidId: f.ada.id, date: '2024-05-01' });
  assert.equal(first.status, 201);
  const second = await f.admin('POST', '/api/completions', { choreId: f.dishes.id, kidId: f.bo.id, date: '2024-05-01' });
  assert.equal(second.status, 409);
  assert.deepEqual(second.body, { error: 'Ada already did this one' });
  // Each-kid chores are unaffected.
  assert.equal((await f.admin('POST', '/api/completions', { choreId: f.reading.id, kidId: f.ada.id, date: '2024-05-01' })).status, 201);
  assert.equal((await f.admin('POST', '/api/completions', { choreId: f.reading.id, kidId: f.bo.id, date: '2024-05-01' })).status, 201);
});

test('kids check off today only; parents can fill in any day', async (t) => {
  const f = await bootFamily();
  t.after(() => f.srv.stop());
  const kid = f.as(await f.login('1111'));
  const past = await kid('POST', '/api/completions', { choreId: f.reading.id, kidId: f.ada.id, date: '2024-05-01' });
  assert.equal(past.status, 403);
  assert.deepEqual(past.body, { error: 'Only a parent can fill in other days' });
  assert.equal((await kid('POST', '/api/completions', { choreId: f.reading.id, kidId: f.ada.id, date: today() })).status, 201);
  assert.equal((await f.admin('POST', '/api/completions', { choreId: f.dishes.id, kidId: f.ada.id, date: '2024-05-01' })).status, 201);
});

test('kid PINs need a parent PIN first', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());
  const withPin = await srv.api('POST', '/api/kids', { name: 'Cy', pin: '3333' });
  assert.equal(withPin.status, 400);
  assert.match(withPin.body.error, /parent PIN first/);
  const kid = await srv.api('POST', '/api/kids', { name: 'Cy' });
  assert.equal((await srv.api('PUT', `/api/kids/${kid.body.id}/pin`, { pin: '3333' })).status, 400);
  // Still open: nobody got locked out.
  assert.deepEqual((await srv.api('GET', '/api/auth/status')).body, { required: false, session: null });
});

test("deleting a kid ends that kid's sessions", async (t) => {
  const f = await bootFamily();
  t.after(() => f.srv.stop());
  const token = await f.login('2222');
  const kid = f.as(token);
  assert.equal((await kid('GET', '/api/auth/status')).body.session.role, 'kid');
  assert.equal((await f.admin('DELETE', `/api/kids/${f.bo.id}`)).status, 200);
  assert.deepEqual((await kid('GET', '/api/auth/status')).body, { required: true, session: null });
});

test('the week grid can be asked for by start date', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());
  const res = await srv.api('GET', '/api/week?start=2024-12-29');
  assert.deepEqual(res.body.week.map((w) => w.date), [
    '2024-12-29', '2024-12-30', '2024-12-31', '2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04',
  ]);
  assert.equal(res.body.week[0].day, 'Sunday');
});

test('a team splits the points; one team per day', async (t) => {
  const f = await bootFamily();
  t.after(() => f.srv.stop());
  const car = (await f.admin('POST', '/api/chores', { title: 'Wash car', frequency: 'daily', points: 101 })).body;
  const team = await f.admin('POST', '/api/completions', { choreId: car.id, kidIds: [f.ada.id, f.bo.id], date: '2024-05-01' });
  assert.equal(team.status, 201);
  assert.deepEqual(team.body.completions.map((c) => c.points), [51, 50], 'remainder goes to the first kid');
  const again = await f.admin('POST', '/api/completions', { choreId: car.id, kidId: f.bo.id, date: '2024-05-01' });
  assert.equal(again.status, 409);
  // Each-kid chores don't take teams.
  const solo = await f.admin('POST', '/api/completions', { choreId: f.reading.id, kidIds: [f.ada.id, f.bo.id], date: '2024-05-01' });
  assert.equal(solo.status, 400);
});

test('a kid can credit a team they are on, not one they are not', async (t) => {
  const f = await bootFamily();
  t.after(() => f.srv.stop());
  const kid = f.as(await f.login('1111')); // Ada
  const onTeam = await kid('POST', '/api/completions', { choreId: f.dishes.id, kidIds: [f.ada.id, f.bo.id], date: today() });
  assert.equal(onTeam.status, 201);
  const junk = (await f.admin('POST', '/api/chores', { title: 'Sweep', frequency: 'daily', points: 4 })).body;
  const offTeam = await kid('POST', '/api/completions', { choreId: junk.id, kidIds: [f.bo.id], date: today() });
  assert.equal(offTeam.status, 403);
});

test('anytime jobs rest for their cooldown, for everyone', async (t) => {
  const f = await bootFamily();
  t.after(() => f.srv.stop());
  const garage = (await f.admin('POST', '/api/chores', { title: 'Garage', frequency: 'anytime', points: 50, cooldownDays: 30, days: [1] })).body;
  assert.equal(garage.cooldown_days, 30);
  assert.equal(garage.days, null, 'anytime jobs have no days');
  assert.equal((await f.admin('POST', '/api/completions', { choreId: garage.id, kidId: f.ada.id, date: '2024-05-01' })).status, 201);
  const soon = await f.admin('POST', '/api/completions', { choreId: garage.id, kidId: f.bo.id, date: '2024-05-20' });
  assert.equal(soon.status, 409);
  assert.match(soon.body.error, /available again Fri, May 31/);
  assert.equal((await f.admin('POST', '/api/completions', { choreId: garage.id, kidId: f.bo.id, date: '2024-05-31' })).status, 201);
  // Default cooldown is a week; the week grid reports when it was last done.
  const quick = (await f.admin('POST', '/api/chores', { title: 'Quick', frequency: 'anytime' })).body;
  assert.equal(quick.cooldown_days, 7);
  const week = await f.srv.api('GET', '/api/week?start=2024-05-27');
  const g = week.body.chores.find((c) => c.id === garage.id);
  assert.equal(g.lastDone, '2024-05-31');
  assert.equal(g.cooldownDays, 30);
});

test('the activity ledger records check-offs, undos and spends, and who logged them', async (t) => {
  const f = await bootFamily();
  t.after(() => f.srv.stop());
  const kid = f.as(await f.login('1111')); // Ada
  const mine = await kid('POST', '/api/completions', { choreId: f.reading.id, kidId: f.ada.id, date: today() });
  await f.admin('POST', '/api/completions', { choreId: f.dishes.id, kidIds: [f.ada.id, f.bo.id], date: '2024-05-01' });
  await kid('DELETE', `/api/completions/${mine.body.id}`);
  await f.admin('POST', '/api/completions', { choreId: f.reading.id, kidId: f.bo.id, date: '2024-05-01' });
  await f.admin('POST', '/api/redeem', { kidId: f.bo.id, reward: { label: 'Sticker', points: 2 } });

  const log = (await f.admin('GET', '/api/activity')).body;
  const brief = log.map((r) => [r.action, r.kidName, r.subject, r.points, r.actor, r.actorName, r.note]);
  assert.deepEqual(brief.reverse(), [
    ['done', 'Ada', 'Reading', 3, 'kid', 'Ada', null],
    ['done', 'Ada', 'Dishes', 3, 'parent', null, 'team with Bo'],
    ['done', 'Bo', 'Dishes', 2, 'parent', null, 'team with Ada'],
    ['undo', 'Ada', 'Reading', -3, 'kid', 'Ada', null],
    ['done', 'Bo', 'Reading', 3, 'parent', null, null],
    ['redeem', 'Bo', 'Sticker', -2, 'parent', null, 'custom spend'],
  ]);
  assert.equal(log.find((r) => r.subject === 'Dishes').forDate, '2024-05-01');

  // Filters, and parents only.
  assert.equal((await f.admin('GET', `/api/activity?kidId=${f.bo.id}&action=done`)).body.length, 2);
  assert.equal((await kid('GET', '/api/activity')).status, 401);
  // History survives deleting the kid.
  await f.admin('DELETE', `/api/kids/${f.bo.id}`);
  assert.equal((await f.admin('GET', '/api/activity')).body.filter((r) => r.kidName === 'Bo').length, 3);
});

test('the ledger is seeded once from existing history', async (t) => {
  const srv = await bootServer();
  const kid = await srv.api('POST', '/api/kids', { name: 'Ada' });
  const chore = await srv.api('POST', '/api/chores', { title: 'Dishes', frequency: 'daily', points: 5 });
  await srv.api('POST', '/api/completions', { choreId: chore.body.id, kidId: kid.body.id, date: '2024-05-01' });
  // Simulate a database from before the ledger: wipe it, then reboot.
  srv.seed('DELETE FROM activity');
  await srv.stop();
  const again = await bootServer({ dataDir: srv.dataDir });
  t.after(() => again.stop());
  assert.match(again.logsJoined(), /activity ledger: seeded 1 past entries/);
  const log = (await again.api('GET', '/api/activity')).body;
  assert.deepEqual(log.map((r) => [r.action, r.kidName, r.subject, r.points, r.actor]), [['done', 'Ada', 'Dishes', 5, null]]);
});

test('kids suggest rewards; parents add them to the menu or turn them down', async (t) => {
  const f = await bootFamily();
  t.after(() => f.srv.stop());
  const ada = f.as(await f.login('1111'));
  const bo = f.as(await f.login('2222'));
  const idea = await ada('POST', '/api/suggestions', { kidId: f.ada.id, label: 'Trampoline park', note: 'so fun', points: 50 });
  assert.equal(idea.status, 201);
  // Not for someone else, max 3 waiting.
  assert.equal((await ada('POST', '/api/suggestions', { kidId: f.bo.id, label: 'x' })).status, 403);
  await ada('POST', '/api/suggestions', { kidId: f.ada.id, label: 'Pizza night' });
  await ada('POST', '/api/suggestions', { kidId: f.ada.id, label: 'Late bedtime' });
  const fourth = await ada('POST', '/api/suggestions', { kidId: f.ada.id, label: 'One more' });
  assert.equal(fourth.status, 400);
  assert.match(fourth.body.error, /3 ideas waiting/);
  await bo('POST', '/api/suggestions', { kidId: f.bo.id, label: 'Sleepover' });

  // Kids see only their own; parents see all, pending first.
  assert.deepEqual((await bo('GET', '/api/suggestions')).body.map((s) => s.label), ['Sleepover']);
  assert.equal((await f.admin('GET', '/api/suggestions')).body.length, 4);
  assert.equal((await ada('PUT', `/api/suggestions/${idea.body.id}`, { status: 'approved', points: 1 })).status, 401);

  // Approve at the parent's price -> it's on the menu.
  const ok = await f.admin('PUT', `/api/suggestions/${idea.body.id}`, { status: 'approved', points: 800, response: 'deal!' });
  assert.equal(ok.status, 200);
  const menu = (await f.srv.api('GET', '/api/settings')).body.rewards;
  assert.ok(menu.some((r) => r.label === 'Trampoline park' && r.points === 800));
  assert.equal((await f.admin('PUT', `/api/suggestions/${idea.body.id}`, { status: 'declined' })).status, 409);

  // Decline with a note; the kid sees it.
  const sleepover = (await bo('GET', '/api/suggestions')).body[0];
  await f.admin('PUT', `/api/suggestions/${sleepover.id}`, { status: 'declined', response: 'maybe in summer' });
  const mine = (await bo('GET', '/api/suggestions')).body[0];
  assert.deepEqual([mine.status, mine.response], ['declined', 'maybe in summer']);
  const adaIdeas = (await ada('GET', '/api/suggestions')).body;
  assert.deepEqual(adaIdeas.find((s) => s.label === 'Trampoline park').points, 800);
});
