'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootServer, createLegacyDb, seedDb } = require('./helpers');

const bearer = (token) => ({ authorization: `Bearer ${token}` });

async function loginAs(s, pin) {
  const res = await s.api('POST', '/api/auth/login', { pin });
  assert.equal(res.status, 200, `login ${pin} should succeed: ${JSON.stringify(res.body)}`);
  return res.body;
}

// Once an admin PIN exists, setup routes need the admin session — so seeding
// goes through the same door the UI uses.
async function seedAsAdmin(s, adminToken) {
  const post = async (route, body) => {
    const res = await fetch(s.base + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(adminToken) },
      body: JSON.stringify(body),
    });
    const parsed = await res.json();
    assert.equal(res.status, 201, `seed ${route} failed: ${JSON.stringify(parsed)}`);
    return parsed;
  };
  // kid 1 (Ada) has a PIN, kid 2 (Bo) does not
  await post('/api/kids', { name: 'Ada', pin: '2468' });
  await post('/api/kids', { name: 'Bo' });
  await post('/api/chores', { title: 'Dishes', points: 3, frequency: 'daily' });
}

// Boots with an admin PIN and two kids (one with a PIN), like a configured household.
async function bootLocked() {
  const s = await bootServer({ env: { ADMIN_PIN: '1234' } });
  const admin = await loginAs(s, '1234');
  s.adminToken = admin.token;
  await seedAsAdmin(s, admin.token);
  return s;
}

test('unconfigured app stays open and reports required:false', async () => {
  const s = await bootServer();
  const status = await s.api('GET', '/api/auth/status');
  assert.deepEqual(status.body, { required: false, session: null });
  const kid = await s.api('POST', '/api/kids', { name: 'Open' });
  assert.equal(kid.status, 201);
  await s.stop();
});

test('env bootstrap: admin + kid PINs, and PINs never leak to the client', async () => {
  const s = await bootLocked();
  const status = await s.api('GET', '/api/auth/status');
  assert.equal(status.body.required, true);
  assert.equal(status.body.session, null);

  const kids = await s.api('GET', '/api/kids');
  for (const kid of kids.body) {
    assert.equal(kid.pin_hash, undefined);
    assert.equal(kid.pin_salt, undefined);
  }
  assert.equal(kids.body.find((k) => k.name === 'Ada').hasPin, true);
  assert.equal(kids.body.find((k) => k.name === 'Bo').hasPin, false);

  const settings = await s.api('GET', '/api/settings');
  assert.equal(settings.body.adminPinHash, undefined);
  assert.equal(settings.body.adminPinSalt, undefined);
  await s.stop();
});

test('wrong PIN is rejected; admin and kid PINs both sign in', async () => {
  const s = await bootLocked();
  const bad = await s.api('POST', '/api/auth/login', { pin: '9999' });
  assert.equal(bad.status, 401);

  const admin = await loginAs(s, '1234');
  assert.equal(admin.role, 'admin');

  const kid = await loginAs(s, '2468');
  assert.equal(kid.role, 'kid');
  assert.equal(kid.kid.name, 'Ada');
  await s.stop();
});

test('admin-only routes: anonymous 401, kid 401, admin 200', async () => {
  const s = await bootLocked();
  const anon = await s.api('POST', '/api/chores', { title: 'Sweep' });
  assert.equal(anon.status, 401);

  const kid = await loginAs(s, '2468');
  const kidTry = await fetch(`${s.base}/api/chores`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(kid.token) },
    body: JSON.stringify({ title: 'Sweep' }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal(kidTry.status, 401);

  const admin = await loginAs(s, '1234');
  const adminOk = await fetch(`${s.base}/api/chores`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(admin.token) },
    body: JSON.stringify({ title: 'Sweep' }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal(adminOk.status, 201);

  // kids/chores/settings mutations are locked too
  for (const [method, route] of [
    ['DELETE', '/api/kids/2'],
    ['PUT', '/api/chores/1'],
    ['PUT', '/api/settings'],
  ]) {
    const r = await fetch(`${s.base}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 401, `${method} ${route} anonymous`);
  }
  await s.stop();
});

test('kid checks off own chore, cannot check for or undo another kid', async () => {
  const s = await bootLocked();
  const kid = await loginAs(s, '2468');
  const auth = bearer(kid.token);
  const post = (route, body, headers = auth) =>
    fetch(`${s.base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const mine = await post('/api/completions', { choreId: 1, kidId: 1 });
  assert.equal(mine.status, 201);

  const other = await post('/api/completions', { choreId: 1, kidId: 2 });
  assert.equal(other.status, 403);

  // undo own is fine
  const undoMine = await fetch(`${s.base}/api/completions/${mine.body.id}`, { method: 'DELETE', headers: auth });
  assert.equal(undoMine.status, 200);

  // create another completion for kid 1, then undo it as admin
  await post('/api/completions', { choreId: 1, kidId: 1 });
  const anonUndo = await fetch(`${s.base}/api/completions/2`, { method: 'DELETE' });
  assert.equal(anonUndo.status, 401, 'anonymous must not undo');

  const admin = await loginAs(s, '1234');
  const adminUndo = await fetch(`${s.base}/api/completions/2`, {
    method: 'DELETE',
    headers: bearer(admin.token),
  });
  assert.equal(adminUndo.status, 200);
  await s.stop();
});

test('kid redeems own reward only; admin redeems anyone', async () => {
  const s = await bootLocked();
  const admin = await loginAs(s, '1234');
  // seed points for kid 2 via admin
  const comp = await fetch(`${s.base}/api/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(admin.token) },
    body: JSON.stringify({ choreId: 1, kidId: 2 }),
  });
  assert.equal(comp.status, 201);

  const kid = await loginAs(s, '2468');
  const redeemOther = await fetch(`${s.base}/api/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(kid.token) },
    body: JSON.stringify({ kidId: 2, reward: { label: 'Treat', points: 1 } }),
  });
  assert.equal(redeemOther.status, 403);

  // kid 1 has no points, so the own-redeem hits the balance check, not the wall
  const redeemSelf = await fetch(`${s.base}/api/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(kid.token) },
    body: JSON.stringify({ kidId: 1, reward: { label: 'Treat', points: 1 } }),
  });
  assert.equal(redeemSelf.status, 400, 'past auth, blocked on balance');
  const redeemBody = await redeemSelf.json();
  assert.match(redeemBody.error, /0 points/);

  const adminRedeem = await fetch(`${s.base}/api/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(admin.token) },
    body: JSON.stringify({ kidId: 2, reward: { label: 'Treat', points: 3 } }),
  });
  assert.equal(adminRedeem.status, 201);
  await s.stop();
});

test('admin manages kid PINs; duplicate PINs rejected; admin PIN changed', async () => {
  const s = await bootLocked();
  const admin = await loginAs(s, '1234');
  const put = (route, body, headers = bearer(admin.token)) =>
    fetch(`${s.base}${route}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  // set a PIN for Bo (kid 2)
  const set = await put('/api/kids/2/pin', { pin: '1357' });
  assert.deepEqual(set.body, { ok: true, pinSet: true });
  const boLogin = await loginAs(s, '1357');
  assert.equal(boLogin.kid.name, 'Bo');

  // duplicate PIN rejected
  const dup = await put('/api/kids/2/pin', { pin: '2468' });
  assert.equal(dup.status, 409);

  // malformed rejected
  const bad = await put('/api/kids/2/pin', { pin: '12' });
  assert.equal(bad.status, 400);

  // remove PIN
  const remove = await put('/api/kids/2/pin', { pin: null });
  assert.deepEqual(remove.body, { ok: true, pinSet: false });

  // admin PIN change, old one stops working
  const change = await put('/api/auth/admin-pin', { pin: '987654' });
  assert.equal(change.status, 200);
  const oldLogin = await s.api('POST', '/api/auth/login', { pin: '1234' });
  assert.equal(oldLogin.status, 401);
  await loginAs(s, '987654');

  // admin PIN cannot collide with a kid PIN
  const collide = await put('/api/auth/admin-pin', { pin: '2468' });
  assert.equal(collide.status, 409);
  await s.stop();
});

test('login throttles after 10 wrong attempts', async () => {
  const s = await bootLocked();
  let last;
  for (let i = 0; i < 10; i++) last = await s.api('POST', '/api/auth/login', { pin: '0000' });
  assert.equal(last.status, 401);
  const blocked = await s.api('POST', '/api/auth/login', { pin: '1234' });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.body.error.includes('Too many attempts'));
  await s.stop();
});

test('auth is Bearer-only: no cookie is ever set, so shared devices cannot inherit a session', async () => {
  const s = await bootLocked();
  const res = await fetch(`${s.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '1234' }),
  });
  // A cookie would live in the browser profile and hand the next person on a
  // shared tablet this session for free. Refuse to mint one.
  assert.equal(res.headers.get('set-cookie'), null);

  const { token } = await res.json();
  const who = await fetch(`${s.base}/api/auth/status`, { headers: bearer(token) });
  assert.deepEqual((await who.json()).session, { role: 'admin' });

  // The token alone (no header) buys nothing.
  const naked = await fetch(`${s.base}/api/chores`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Sneaky' }),
  });
  assert.equal(naked.status, 401);

  await fetch(`${s.base}/api/auth/logout`, { method: 'POST', headers: bearer(token) });
  const after = await fetch(`${s.base}/api/auth/status`, { headers: bearer(token) });
  assert.equal((await after.json()).session, null);
  await s.stop();
});

test('legacy DB gains pin columns via migration; env seeds kid PIN after restart', async () => {
  // Pre-PIN database on disk, then boot it with PIN env — the migration must
  // add the columns before bootstrapPinsFromEnv touches the kids table.
  const dataDir = createLegacyDb();
  seedDb(dataDir, "INSERT INTO kids (id, name) VALUES (1, 'Old')");

  const s = await bootServer({ dataDir, env: { ADMIN_PIN: '4321', KID_PIN_1: '1111' } });
  assert.match(s.logsJoined(), /kids table now supports login PINs/);
  const kid = await loginAs(s, '1111');
  assert.equal(kid.kid.name, 'Old');

  // restart again: env must not clobber existing PIN hashes, PIN still works
  await s.stop();
  const s2 = await bootServer({ dataDir, env: { ADMIN_PIN: '4321', KID_PIN_1: '1111' } });
  await loginAs(s2, '1111');
  await s2.stop();
});

test('unauthenticated reads stay open (chart is visible to the family)', async () => {
  const s = await bootLocked();
  for (const route of ['/api/week', '/api/totals', '/api/chores', '/api/settings', '/api/redeemptions']) {
    const res = await fetch(s.base + route);
    assert.equal(res.status, 200, `${route} should be readable anonymously`);
  }
  await s.stop();
});
