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
