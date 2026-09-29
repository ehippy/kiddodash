'use strict';

// PUT /api/settings: the custody schedule is validated and normalized, and the
// response never carries the admin PIN hash.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootServer } = require('./helpers');

test('custody schedule is validated and normalized', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());

  const initial = await srv.api('GET', '/api/settings');
  assert.deepEqual(initial.body.custody, { enabled: false, homeStart: null, exceptions: {} });

  const saved = await srv.api('PUT', '/api/settings', {
    custody: {
      enabled: true,
      homeStart: '2026-09-25',
      exceptions: { '2026-12-25': 'home', '2026-12-31': 'away', 'nope': 'home', '2026-11-01': 'maybe' },
    },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.custody, {
    enabled: true,
    homeStart: '2026-09-25',
    exceptions: { '2026-12-25': 'home', '2026-12-31': 'away' },
  });

  // Can't be on without a start date.
  const noStart = await srv.api('PUT', '/api/settings', { custody: { enabled: true, homeStart: null } });
  assert.equal(noStart.body.custody.enabled, false);

  const bad = await srv.api('PUT', '/api/settings', { custody: { enabled: true, homeStart: '25/09/2026' } });
  assert.equal(bad.status, 400);

  // Other settings survive a custody-only update.
  assert.ok(Array.isArray((await srv.api('GET', '/api/settings')).body.rewards));
});

test('saving settings never echoes the admin PIN hash', async (t) => {
  const srv = await bootServer({ env: { ADMIN_PIN: '4321' } });
  t.after(() => srv.stop());

  const login = await srv.api('POST', '/api/auth/login', { pin: '4321' });
  assert.equal(login.status, 200);
  const res = await fetch(`${srv.base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.body.token}` },
    body: JSON.stringify({ weekStartDay: 5 }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.weekStartDay, 5);
  assert.equal(body.adminPinHash, undefined);
  assert.equal(body.adminPinSalt, undefined);
});
