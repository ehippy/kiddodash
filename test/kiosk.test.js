'use strict';

// The kitchen screen (/kiosk?key=…): with PINs configured, a request carrying the
// kiosk key may check chores off and undo them for today, and nothing else.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootServer } = require('./helpers');

async function call(s, method, route, { body, token, key } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['x-kiosk-key'] = key;
  const res = await fetch(s.base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const isoDay = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function bootHousehold() {
  const s = await bootServer({ env: { ADMIN_PIN: '1234' } });
  const admin = (await call(s, 'POST', '/api/auth/login', { body: { pin: '1234' } })).body.token;
  const kid = (await call(s, 'POST', '/api/kids', { token: admin, body: { name: 'Ada', pin: '2468' } })).body;
  const chore = (await call(s, 'POST', '/api/chores', { token: admin, body: { title: 'Dishes', points: 3, frequency: 'daily' } })).body;
  const key = (await call(s, 'GET', '/api/kiosk-key', { token: admin })).body.key;
  return { s, admin, kid, chore, key };
}

test('the kiosk key is admin-only and never leaks through settings', async () => {
  const { s, admin, key } = await bootHousehold();
  assert.ok(key && key.length >= 20, 'a key is generated');
  assert.equal((await call(s, 'GET', '/api/kiosk-key')).status, 401);
  assert.equal((await call(s, 'GET', '/api/settings')).body.kioskKey, undefined);
  const put = await call(s, 'PUT', '/api/settings', { token: admin, body: { weekStartDay: 0 } });
  assert.equal(put.status, 200);
  assert.equal(put.body.kioskKey, undefined);
  assert.equal((await call(s, 'GET', '/api/kiosk-key', { token: admin })).body.key, key, 'stable across settings saves');
  await s.stop();
});

test('with the key, today’s chores check off and undo without a PIN', async () => {
  const { s, admin, kid, chore, key } = await bootHousehold();
  assert.equal((await call(s, 'POST', '/api/completions', { body: { choreId: chore.id, kidId: kid.id } })).status, 401);
  assert.equal((await call(s, 'POST', '/api/completions', { key: 'nope', body: { choreId: chore.id, kidId: kid.id } })).status, 401);

  const done = await call(s, 'POST', '/api/completions', { key, body: { choreId: chore.id, kidId: kid.id } });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  const log = (await call(s, 'GET', '/api/activity', { token: admin })).body;
  assert.equal(log[0].actor, 'kiosk');

  assert.equal((await call(s, 'DELETE', `/api/completions/${done.body.id}`, { key })).status, 200);
  await s.stop();
});

test('the kiosk can’t touch other days or anything beyond check-offs', async () => {
  const { s, admin, kid, chore, key } = await bootHousehold();
  const past = await call(s, 'POST', '/api/completions', { key, body: { choreId: chore.id, kidId: kid.id, date: isoDay(-5) } });
  assert.equal(past.status, 403);

  // A parent's backfill from last week can't be undone from the kitchen.
  const old = await call(s, 'POST', '/api/completions', { token: admin, body: { choreId: chore.id, kidId: kid.id, date: isoDay(-5) } });
  assert.equal(old.status, 201);
  assert.equal((await call(s, 'DELETE', `/api/completions/${old.body.id}`, { key })).status, 403);

  assert.equal((await call(s, 'POST', '/api/kids', { key, body: { name: 'Sneaky' } })).status, 401);
  assert.equal((await call(s, 'POST', '/api/redeem', { key, body: { kidId: kid.id, rewardId: 1 } })).status, 401);
  assert.equal((await call(s, 'PUT', `/api/kids/${kid.id}/pin`, { key, body: { pin: '1111' } })).status, 401);
  assert.equal((await call(s, 'GET', '/api/kiosk-key', { key })).status, 401);
  await s.stop();
});

test('schedule: kids are home unless custody says away (alternating weeks, exceptions win)', async () => {
  const { s, admin } = await bootHousehold();
  const home = async (date) => (await call(s, 'GET', `/api/schedule?date=${date}`)).body.home;
  assert.equal(await home('2026-11-09'), true, 'no custody configured: always home');
  const custody = { enabled: true, homeStart: '2026-11-02', exceptions: { '2026-11-12': 'home', '2026-11-04': 'away' } };
  assert.equal((await call(s, 'PUT', '/api/settings', { token: admin, body: { custody } })).status, 200);
  assert.equal(await home('2026-11-02'), true); // first home week
  assert.equal(await home('2026-11-08'), true);
  assert.equal(await home('2026-11-09'), false); // away week
  assert.equal(await home('2026-11-12'), true); // pinned home
  assert.equal(await home('2026-11-04'), false); // pinned away
  assert.equal(await home('2026-11-16'), true); // home again
  assert.equal(await home('2026-10-26'), false); // the week before the start is away
  await s.stop();
});
