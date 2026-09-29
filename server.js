'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new DatabaseSync(path.join(DATA_DIR, 'kiddodash.db'));

// SQLite defaults `foreign_keys` to OFF, so the ON DELETE CASCADE clauses in the
// schema below do nothing until we ask for them. Turn enforcement on once, right
// after opening the connection: this is a single shared connection for the whole
// process, so it stays on for the process lifetime. Deleting a kid or a chore now
// removes the dependent completions/redemptions instead of orphaning them.
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS kids (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '#7c3aed',
    emoji       TEXT NOT NULL DEFAULT '🙂',
    pin_hash    TEXT,
    pin_salt    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    points      INTEGER NOT NULL DEFAULT 1,
    frequency   TEXT NOT NULL DEFAULT 'weekly'
                CHECK (frequency IN ('daily', 'weekly', 'personal', 'schooldays')),
    days        TEXT, -- comma-separated day-of-week ints (0=Sun..6=Sat), e.g. '1,4'
    active      INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS completions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chore_id     INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
    kid_id       INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
    done_date    TEXT NOT NULL,
    points       INTEGER NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (chore_id, kid_id, done_date)
  );

  CREATE INDEX IF NOT EXISTS idx_completions_date ON completions(done_date);

  CREATE TABLE IF NOT EXISTS redemptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kid_id       INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
    reward_label TEXT NOT NULL,
    points       INTEGER NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_redemptions_kid ON redemptions(kid_id);

  CREATE TABLE IF NOT EXISTS sessions (
    token   TEXT PRIMARY KEY,
    role    TEXT NOT NULL,
    kid_id  INTEGER,
    expires INTEGER NOT NULL
  );
`);

// ---------------------------------------------------------------------------
// Migrations (CREATE TABLE IF NOT EXISTS won't alter existing schemas)
// ---------------------------------------------------------------------------

function tableSql(name) {
  const row = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', name);
  return row ? row.sql : null;
}

function migrate() {
  const choresSql = tableSql('chores');
  if (choresSql && !/CHECK \(frequency IN \('daily', 'weekly', 'personal', 'schooldays'\)\)/.test(choresSql)) {
    // Rebuilding a table needs FKs off. Both pragmas are no-ops inside a transaction,
    // so they sit outside the statements below and are restored afterwards to match the
    // startup state (foreign_keys ON). legacy_alter_table keeps `completions` pointing at
    // `chores`: by default SQLite rewrites the FK clause of *other* tables to
    // `chores_old` when a parent is renamed, which breaks inserts/cascades once FKs are enforced.
    db.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      ALTER TABLE chores RENAME TO chores_old;
      CREATE TABLE chores (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT NOT NULL,
        points      INTEGER NOT NULL DEFAULT 1,
        frequency   TEXT NOT NULL DEFAULT 'weekly'
                    CHECK (frequency IN ('daily', 'weekly', 'personal', 'schooldays')),
        day_of_week INTEGER,
        active      INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO chores (id, title, points, frequency, day_of_week, active)
        SELECT id, title, points, frequency, day_of_week, active FROM chores_old;
      DROP TABLE chores_old;
      PRAGMA legacy_alter_table = OFF;
      PRAGMA foreign_keys = ON;
    `);
    console.log('migrated: chores now supports personal frequency');
  }

  const choresSql2 = tableSql('chores');
  if (choresSql2 && /day_of_week/.test(choresSql2) && !/\bdays\b/.test(choresSql2)) {
    // Same rebuild dance as above: day_of_week (one day) becomes days (a
    // comma-separated set), so a chore like "water the plants" can run on
    // more than one day without being duplicated into separate rows.
    db.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      ALTER TABLE chores RENAME TO chores_old;
      CREATE TABLE chores (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT NOT NULL,
        points      INTEGER NOT NULL DEFAULT 1,
        frequency   TEXT NOT NULL DEFAULT 'weekly'
                    CHECK (frequency IN ('daily', 'weekly', 'personal', 'schooldays')),
        days        TEXT,
        active      INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO chores (id, title, points, frequency, days, active)
        SELECT id, title, points, frequency,
               CASE WHEN day_of_week IS NULL THEN NULL ELSE CAST(day_of_week AS TEXT) END,
               active
          FROM chores_old;
      DROP TABLE chores_old;
      PRAGMA legacy_alter_table = OFF;
      PRAGMA foreign_keys = ON;
    `);
    console.log('migrated: chores now support multiple days per week');
  }

  const compSql = tableSql('completions');
  if (compSql && !/UNIQUE \(chore_id, kid_id, done_date\)/.test(compSql)) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      ALTER TABLE completions RENAME TO completions_old;
      CREATE TABLE completions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        chore_id     INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
        kid_id       INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        done_date    TEXT NOT NULL,
        points       INTEGER NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (chore_id, kid_id, done_date)
      );
      INSERT INTO completions (id, chore_id, kid_id, done_date, points, created_at)
        SELECT id, chore_id, kid_id, done_date, points, created_at FROM completions_old;
      DROP TABLE completions_old;
      PRAGMA foreign_keys = ON;
      CREATE INDEX IF NOT EXISTS idx_completions_date ON completions(done_date);
    `);
    console.log('migrated: completions now unique per kid');
  }

  const kidsSql = tableSql('kids');
  if (kidsSql && !/pin_hash\s+TEXT/.test(kidsSql)) {
    // Adding two nullable columns — no rebuild needed; kids without PINs simply
    // have none until an admin sets one.
    db.exec('ALTER TABLE kids ADD COLUMN pin_hash TEXT; ALTER TABLE kids ADD COLUMN pin_salt TEXT;');
    console.log('migrated: kids table now supports login PINs');
  }

  cleanUpOrphans();
}

// Completions/redemptions written while `foreign_keys` was left at SQLite's default
// (OFF) can outlive their kid or chore. Remove those rows: they inflate /api/totals
// (and therefore /api/redeem balances) with points nobody can ever spend.
// Idempotent -- on a healthy database it deletes nothing and stays quiet.
function cleanUpOrphans() {
  const completions = db
    .prepare(
      `DELETE FROM completions
        WHERE kid_id NOT IN (SELECT id FROM kids)
           OR chore_id NOT IN (SELECT id FROM chores)`
    )
    .run();
  const redemptions = db
    .prepare('DELETE FROM redemptions WHERE kid_id NOT IN (SELECT id FROM kids)')
    .run();

  if (completions.changes > 0 || redemptions.changes > 0) {
    console.log(
      `migrated: removed ${completions.changes} orphaned completion(s), ${redemptions.changes} orphaned redemption(s)`
    );
  }
}

migrate();

// ---------------------------------------------------------------------------
// Settings (rewards)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  pointsPerCompletion: 1,
  weekStartDay: 1, // 0=Sunday .. 6=Saturday; default Monday
  rewards: [
    { id: 1, label: 'Pick the dinner menu', points: 10 },
    { id: 2, label: 'Extra 30 min screen time', points: 15 },
    { id: 3, label: 'Ice cream treat', points: 20 }
  ]
};

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS, rewards: [...DEFAULT_SETTINGS.rewards] };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// PINs & sessions
// ---------------------------------------------------------------------------

// scrypt at default N=16384 (~50-100ms) makes a 4-digit PIN brute-force
// expensive without needing any tuning on a Raspberry Pi.
function hashPin(pin, saltHex) {
  return crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

function makePinHash(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPin(pin, salt) };
}

function verifyPin(pin, saltHex, hashHex) {
  if (!saltHex || !hashHex) return false;
  const candidate = Buffer.from(hashPin(pin, saltHex), 'hex');
  const stored = Buffer.from(hashHex, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

const ADMIN_PIN_RE = /^\d{4,8}$/;
const KID_PIN_RE = /^\d{4}$/;

function loadAuthSettings() {
  const s = loadSettings();
  return { adminPinHash: s.adminPinHash || null, adminPinSalt: s.adminPinSalt || null };
}

function setAdminPin(pin) {
  const s = loadSettings();
  const { salt, hash } = makePinHash(pin);
  s.adminPinHash = hash;
  s.adminPinSalt = salt;
  saveSettings(s);
}

// True once at least one PIN exists (env bootstrap or settings). While nothing
// is configured the app stays fully open: no lockout target, no broken dev/test.
function authConfigured() {
  if (loadAuthSettings().adminPinHash) return true;
  return db.prepare('SELECT COUNT(*) AS n FROM kids WHERE pin_hash IS NOT NULL').get().n > 0;
}

function adminPinMatches(pin) {
  const { adminPinHash, adminPinSalt } = loadAuthSettings();
  return !!adminPinHash && verifyPin(pin, adminPinSalt, adminPinHash);
}

function kidByPin(pin) {
  for (const kid of db.prepare('SELECT * FROM kids WHERE pin_hash IS NOT NULL').all()) {
    if (verifyPin(pin, kid.pin_salt, kid.pin_hash)) return kid;
  }
  return null;
}

// Throws when another kid already uses this PIN — kidByPin resolves by
// scanning, so duplicate PINs would silently sign into the wrong account.
function assertPinUnused(pin, exceptKidId) {
  for (const other of db.prepare('SELECT id, name, pin_hash, pin_salt FROM kids WHERE pin_hash IS NOT NULL AND id != ?').all(exceptKidId)) {
    if (verifyPin(pin, other.pin_salt, other.pin_hash)) {
      const err = new Error(`That PIN is already ${other.name}'s`);
      err.status = 409;
      throw err;
    }
  }
}

function setKidPin(kidId, pin) {
  if (pin === null) {
    db.prepare('UPDATE kids SET pin_hash = NULL, pin_salt = NULL WHERE id = ?').run(kidId);
    return;
  }
  const { salt, hash } = makePinHash(pin);
  db.prepare('UPDATE kids SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(hash, salt, kidId);
}

// One-time bootstrap from the environment so the very first deploy can seed
// PINs without an already-authenticated admin. Existing PINs are never
// overwritten by env, so restarts are idempotent.
function bootstrapPinsFromEnv() {
  if (!process.env.ADMIN_PIN && !loadAuthSettings().adminPinHash) {
    console.log('no ADMIN_PIN set and no admin PIN configured — app runs unlocked (anyone can edit)');
  }
  if (process.env.ADMIN_PIN && !loadAuthSettings().adminPinHash) {
    if (ADMIN_PIN_RE.test(process.env.ADMIN_PIN)) {
      setAdminPin(process.env.ADMIN_PIN);
      console.log('bootstrapped admin PIN from ADMIN_PIN env');
    } else {
      console.log('ignoring ADMIN_PIN env: must be 4-8 digits');
    }
  }
  if (!authConfigured()) return;
  for (const kid of db.prepare('SELECT * FROM kids').all()) {
    const envPin = process.env[`KID_PIN_${kid.id}`];
    if (envPin && !kid.pin_hash) {
      if (KID_PIN_RE.test(envPin)) {
        setKidPin(kid.id, envPin);
        console.log(`bootstrapped PIN for ${kid.name} from KID_PIN_${kid.id} env`);
      } else {
        console.log(`ignoring KID_PIN_${kid.id} env: must be exactly 4 digits`);
      }
    }
  }
}

// Sessions live in SQLite (not an in-memory Map) so a server restart — an app
// update, a Pi reboot — doesn't sign everyone out; they already carry a 30-day
// expiry, so this just lets that expiry actually mean something.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function createSession(session) {
  const token = crypto.randomBytes(32).toString('hex');
  prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); // lazy prune
  prepare('INSERT INTO sessions (token, role, kid_id, expires) VALUES (?, ?, ?, ?)').run(
    token, session.role, session.kidId ?? null, Date.now() + SESSION_TTL_MS
  );
  return token;
}

function getSession(req) {
  // Bearer header ONLY — deliberately no cookie fallback. A cookie would
  // persist the session in the browser profile for its whole lifetime, so on a
  // shared family tablet the next person who opens the site inherits whoever
  // last signed in (possibly admin, PIN-free). sessionStorage + Bearer dies
  // with the tab instead, and cross-site fetches still can't forge it.
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  const row = prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires < Date.now()) {
    prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { role: row.role, kidId: row.kid_id, token };
}

function dropSession(token) {
  prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Brute-force guard: 10 failed PIN attempts per source IP per 10 minutes.
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const loginFails = new Map(); // ip -> { count, resetAt }

function loginThrottle(ip) {
  const entry = loginFails.get(ip);
  if (!entry || entry.resetAt < Date.now()) return null;
  return entry.count >= LOGIN_MAX_FAILS ? Math.ceil((entry.resetAt - Date.now()) / 1000) : null;
}

function recordLoginFail(ip) {
  const entry = loginFails.get(ip);
  if (!entry || entry.resetAt < Date.now()) {
    loginFails.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearLoginFails(ip) {
  loginFails.delete(ip);
}

// (no session cookie anymore — see getSession: Bearer-only by design)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekDates(offset = 0, startDay = 1) {
  // Week starts on `startDay` (0=Sunday..6=Saturday), offset by whole weeks
  // (negative = past, positive = future).
  const now = new Date();
  const jsDay = (now.getDay() - startDay + 7) % 7;
  const start = new Date(now);
  start.setDate(now.getDate() - jsDay + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const p = (n) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      day: DAYS[d.getDay()],
      weekdayIndex: d.getDay()
    };
  });
}

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

// Run `fn` inside a transaction so a parent row and the children it cascades to all
// go, or none do. Returns whatever fn() returns; rethrows after ROLLBACK on failure.
function inTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the transaction was already unwound */
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const prepare = (sql) => db.prepare(sql);

// Never ship PIN material to the client — only whether a kid has one.
function publicKid(k) {
  const { pin_hash, pin_salt, ...rest } = k;
  return { ...rest, hasPin: !!pin_hash };
}

// --- Auth middleware ---------------------------------------------------------

// Roles: 'admin' (everything), 'kid' (check own chores, redeem own rewards),
// anonymous (read-only chart when auth is configured).
function requireAdmin(req, res, next) {
  if (!authConfigured()) return next(); // unlocked mode: no PINs set anywhere
  const session = getSession(req);
  if (session && session.role === 'admin') return next();
  return sendError(res, 401, 'Admin sign-in required');
}

// Kid sessions may only touch completions/redemptions for themselves; `getKidId`
// extracts whose record this request is about (body or lookup by route param).
function requireAdminOrSelf(getKidId) {
  return (req, res, next) => {
    if (!authConfigured()) return next();
    const session = getSession(req);
    if (!session) return sendError(res, 401, 'Sign in required');
    if (session.role === 'admin') return next();
    if (session.role === 'kid' && getKidId(req) === session.kidId) return next();
    return sendError(res, 403, 'That is for your own chores only');
  };
}

const completionKidId = (req) => {
  const row = db.prepare('SELECT kid_id FROM completions WHERE id = ?').get(req.params.id);
  return row ? row.kid_id : null;
};

// --- Login endpoints ---------------------------------------------------------

app.get('/api/auth/status', (req, res) => {
  if (!authConfigured()) return res.json({ required: false, session: null });
  const session = getSession(req);
  if (!session) return res.json({ required: true, session: null });
  if (session.role === 'admin') return res.json({ required: true, session: { role: 'admin' } });
  const kid = prepare('SELECT id, name, color, emoji FROM kids WHERE id = ?').get(session.kidId);
  res.json({ required: true, session: { role: 'kid', kid } });
});

app.post('/api/auth/login', (req, res) => {
  const pin = String(req.body?.pin || '').trim();
  if (!pin) return sendError(res, 400, 'PIN is required');
  const ip = req.ip || 'unknown';
  const retryAfter = loginThrottle(ip);
  if (retryAfter !== null) {
    res.set('Retry-After', String(retryAfter));
    return sendError(res, 429, `Too many attempts — try again in ${retryAfter}s`);
  }
  if (ADMIN_PIN_RE.test(pin) && adminPinMatches(pin)) {
    const token = createSession({ role: 'admin' });
    clearLoginFails(ip);
    return res.json({ role: 'admin', token });
  }
  if (KID_PIN_RE.test(pin)) {
    const kid = kidByPin(pin);
    if (kid) {
      const token = createSession({ role: 'kid', kidId: kid.id });
      clearLoginFails(ip);
      return res.json({ role: 'kid', token, kid: { id: kid.id, name: kid.name, color: kid.color, emoji: kid.emoji } });
    }
  }
  recordLoginFail(ip);
  sendError(res, 401, 'Wrong PIN');
});

app.post('/api/auth/logout', (req, res) => {
  const session = getSession(req);
  if (session) dropSession(session.token);
  res.json({ ok: true });
});

// --- PIN management (admin, or a kid changing their own) ---------------------

// PUT /api/kids/:id/pin  { pin, currentPin? }  — pin null/empty removes the kid's
// PIN (admin only). A kid changing their own PIN must also pass their current one;
// removal is admin-only so a kid can't lock themselves out of self-service sign-in.
app.put('/api/kids/:id/pin', requireAdminOrSelf((req) => Number(req.params.id)), (req, res) => {
  const kid = prepare('SELECT * FROM kids WHERE id = ?').get(req.params.id);
  if (!kid) return sendError(res, 404, 'Kid not found');
  const isSelf = getSession(req)?.role === 'kid';

  const raw = req.body?.pin;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    if (isSelf) return sendError(res, 403, 'Ask a parent to remove your PIN');
    setKidPin(kid.id, null);
    return res.json({ ok: true, pinSet: false });
  }

  if (isSelf && !verifyPin(String(req.body?.currentPin || '').trim(), kid.pin_salt, kid.pin_hash)) {
    return sendError(res, 403, 'Current PIN is incorrect');
  }

  const pin = String(raw).trim();
  if (!KID_PIN_RE.test(pin)) return sendError(res, 400, 'Kid PIN must be exactly 4 digits');
  try {
    assertPinUnused(pin, kid.id);
    setKidPin(kid.id, pin);
  } catch (e) {
    return sendError(res, e.status || 500, e.message);
  }
  res.json({ ok: true, pinSet: true });
});

// PUT /api/auth/admin-pin  { pin }  — change the admin PIN
app.put('/api/auth/admin-pin', requireAdmin, (req, res) => {
  const pin = String(req.body?.pin || '').trim();
  if (!ADMIN_PIN_RE.test(pin)) return sendError(res, 400, 'Admin PIN must be 4-8 digits');
  if (KID_PIN_RE.test(pin) && kidByPin(pin)) return sendError(res, 409, 'That PIN belongs to a kid — pick another');
  if (adminPinMatches(pin)) return sendError(res, 200, { ok: true, note: 'already the current admin PIN' });
  setAdminPin(pin);
  res.json({ ok: true });
});

// --- Health ----------------------------------------------------------------

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- Kids --------------------------------------------------------------------

app.get('/api/kids', (req, res) => {
  const kids = prepare('SELECT * FROM kids ORDER BY id').all().map(publicKid);
  const totals = prepare(
    `SELECT kid_id, COALESCE(SUM(points), 0) AS total
       FROM completions GROUP BY kid_id`
  ).all();
  const byKid = new Map(totals.map((t) => [t.kid_id, t.total]));
  res.json(kids.map((k) => ({ ...k, points: byKid.get(k.id) || 0 })));
});

app.post('/api/kids', requireAdmin, (req, res) => {
  const { name, color, emoji, pin } = req.body || {};
  if (!name || !String(name).trim()) return sendError(res, 400, 'Name is required');
  const pinStr = pin === undefined || pin === null ? '' : String(pin).trim();
  if (pinStr && !KID_PIN_RE.test(pinStr)) return sendError(res, 400, 'Kid PIN must be exactly 4 digits');
  try {
    const info = prepare('INSERT INTO kids (name, color, emoji) VALUES (?, ?, ?)').run(
      String(name).trim(),
      color || '#7c3aed',
      emoji || '🙂'
    );
    if (pinStr) {
      assertPinUnused(pinStr, info.lastInsertRowid);
      setKidPin(info.lastInsertRowid, pinStr);
    }
    res.status(201).json(publicKid(prepare('SELECT * FROM kids WHERE id = ?').get(info.lastInsertRowid)));
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

app.put('/api/kids/:id', requireAdmin, (req, res) => {
  const kid = prepare('SELECT * FROM kids WHERE id = ?').get(req.params.id);
  if (!kid) return sendError(res, 404, 'Kid not found');
  const name = req.body.name !== undefined ? String(req.body.name).trim() : kid.name;
  if (!name) return sendError(res, 400, 'Name cannot be empty');
  prepare('UPDATE kids SET name = ?, color = ?, emoji = ? WHERE id = ?').run(
    name,
    req.body.color || kid.color,
    req.body.emoji || kid.emoji,
    kid.id
  );
  res.json(publicKid(prepare('SELECT * FROM kids WHERE id = ?').get(kid.id)));
});

app.delete('/api/kids/:id', requireAdmin, (req, res) => {
  try {
    // FKs are enforced, so this kid's completions and redemptions cascade away in the
    // same transaction as the kid row itself.
    const info = inTransaction(() => prepare('DELETE FROM kids WHERE id = ?').run(req.params.id));
    if (info.changes === 0) return sendError(res, 404, 'Kid not found');
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// --- Chores --------------------------------------------------------------------

app.get('/api/chores', (req, res) => {
  const chores = prepare('SELECT * FROM chores ORDER BY frequency, days, id').all();
  const doneToday = new Map(
    prepare(
      `SELECT c.chore_id, COUNT(*) AS n FROM completions c
         WHERE c.done_date = ? GROUP BY c.chore_id`
    ).all(todayStr()).map((r) => [r.chore_id, r.n])
  );
  res.json(chores.map((c) => ({ ...c, doneToday: doneToday.get(c.id) || 0 })));
});

function parseDays(str) {
  return str ? str.split(',').map(Number) : null;
}

function encodeDays(days) {
  return days && days.length ? days.join(',') : null;
}

// A 'weekly' chore needs at least one day to ever come due, so days can't be
// left empty; 'daily'/'schooldays' ignore whatever days are stored, so they're
// cleared to avoid a stale value lingering after a frequency change. 'personal'
// may have specific days or none at all (none = every day, for that kid).
function normalizeChoreDays(freq, days) {
  if (freq === 'daily' || freq === 'schooldays') return null;
  const clean = Array.isArray(days)
    ? [...new Set(days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
    : [];
  if (freq === 'weekly') return clean.length ? clean : [1];
  return clean.length ? clean : null;
}

app.post('/api/chores', requireAdmin, (req, res) => {
  const { title, points, frequency, days } = req.body || {};
  if (!title || !String(title).trim()) return sendError(res, 400, 'Title is required');
  const freq = ['daily', 'weekly', 'personal', 'schooldays'].includes(frequency) ? frequency : 'weekly';
  const normalizedDays = normalizeChoreDays(freq, days);
  const pts = Number.isInteger(Number(points)) && Number(points) > 0 ? Number(points) : 1;
  try {
    const info = prepare(
      `INSERT INTO chores (title, points, frequency, days) VALUES (?, ?, ?, ?)`
    ).run(String(title).trim(), pts, freq, encodeDays(normalizedDays));
    res.status(201).json(prepare('SELECT * FROM chores WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

app.put('/api/chores/:id', requireAdmin, (req, res) => {
  const chore = prepare('SELECT * FROM chores WHERE id = ?').get(req.params.id);
  if (!chore) return sendError(res, 404, 'Chore not found');
  const title = req.body.title !== undefined ? String(req.body.title).trim() : chore.title;
  if (!title) return sendError(res, 400, 'Title cannot be empty');
  const points =
    req.body.points !== undefined && Number.isInteger(Number(req.body.points)) && Number(req.body.points) > 0
      ? Number(req.body.points)
      : chore.points;
  const frequency =
    ['daily', 'weekly', 'personal', 'schooldays'].includes(req.body.frequency)
      ? req.body.frequency
      : chore.frequency;
  const days = req.body.days !== undefined ? req.body.days : parseDays(chore.days);
  const normalizedDays = normalizeChoreDays(frequency, days);
  const active =
    req.body.active !== undefined ? (req.body.active ? 1 : 0) : chore.active;

  prepare('UPDATE chores SET title = ?, points = ?, frequency = ?, days = ?, active = ? WHERE id = ?').run(
    title, points, frequency, encodeDays(normalizedDays), active, chore.id
  );
  res.json(prepare('SELECT * FROM chores WHERE id = ?').get(chore.id));
});

app.delete('/api/chores/:id', requireAdmin, (req, res) => {
  try {
    // FKs are enforced, so this chore's completions cascade away with it.
    const info = inTransaction(() => prepare('DELETE FROM chores WHERE id = ?').run(req.params.id));
    if (info.changes === 0) return sendError(res, 404, 'Chore not found');
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// --- Completions ----------------------------------------------------------------

// GET /api/completions?date=YYYY-MM-DD
app.get('/api/completions', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr();
  const rows = prepare(
    `SELECT c.*, k.name AS kid_name, k.color AS kid_color, k.emoji AS kid_emoji,
            ch.title AS chore_title
       FROM completions c
       JOIN kids k ON k.id = c.kid_id
       JOIN chores ch ON ch.id = c.chore_id
      WHERE c.done_date = ?
      ORDER BY c.created_at`
  ).all(date);
  res.json(rows);
});

// POST /api/completions  { choreId, kidId, date? }
app.post('/api/completions', requireAdminOrSelf((req) => {
  const n = Number(req.body?.kidId);
  return Number.isInteger(n) && n > 0 ? n : null;
}), (req, res) => {
  const { choreId, kidId, date } = req.body || {};
  const chore = prepare('SELECT * FROM chores WHERE id = ? AND active = 1').get(choreId);
  if (!chore) return sendError(res, 404, 'Chore not found');
  const kid = prepare('SELECT * FROM kids WHERE id = ?').get(kidId);
  if (!kid) return sendError(res, 404, 'Kid not found');
  const doneDate = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : todayStr();
  try {
    const info = prepare(
      `INSERT INTO completions (chore_id, kid_id, done_date, points) VALUES (?, ?, ?, ?)`
    ).run(chore.id, kid.id, doneDate, chore.points);
    res.status(201).json({
      id: info.lastInsertRowid,
      choreId: chore.id,
      kidId: kid.id,
      doneDate,
      points: chore.points
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return sendError(res, 409, 'Already completed for that day — undo it first');
    }
    sendError(res, 500, e.message);
  }
});

// DELETE /api/completions/:id
app.delete('/api/completions/:id', requireAdminOrSelf(completionKidId), (req, res) => {
  const info = prepare('DELETE FROM completions WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return sendError(res, 404, 'Completion not found');
  res.json({ ok: true });
});

// --- Week view (the chart) ------------------------------------------------------

// GET /api/week?offset=N  -> { week: [{date, day}], grid: { choreId: { date: {id, kidId, kidName, kidColor, kidEmoji} } }, kids }
app.get('/api/week', (req, res) => {
  const offset = Math.max(-26, Math.min(26, parseInt(req.query.offset, 10) || 0));
  const totals = new Map(
    prepare('SELECT kid_id, SUM(points) AS total FROM completions GROUP BY kid_id').all()
      .map((t) => [t.kid_id, t.total])
  );
  const kids = prepare('SELECT * FROM kids ORDER BY id').all().map((k) => ({
    ...publicKid(k),
    points: totals.get(k.id) || 0
  }));
  // All chores (not just active ones) so the admin Chores list can still see and
  // manage paused chores; the chart itself filters to active ones client-side.
  const chores = prepare('SELECT * FROM chores ORDER BY frequency, days, id').all();
  const week = weekDates(offset, loadSettings().weekStartDay);
  const dates = week.map((w) => w.date);

  const rows = prepare(
    `SELECT c.chore_id, c.kid_id, c.done_date, c.id, c.points
       FROM completions c
      WHERE c.done_date IN (${dates.map(() => '?').join(',')})`
  ).all(...dates);

  const kidById = new Map(kids.map((k) => [k.id, k]));
  const grid = {};
  for (const row of rows) {
    const k = kidById.get(row.kid_id);
    if (!grid[row.chore_id]) grid[row.chore_id] = {};
    if (!grid[row.chore_id][row.done_date]) grid[row.chore_id][row.done_date] = {};
    grid[row.chore_id][row.done_date][row.kid_id] = {
      id: row.id,
      kidId: row.kid_id,
      kidName: k ? k.name : '?',
      kidColor: k ? k.color : '#999',
      kidEmoji: k ? k.emoji : '❓',
      points: row.points
    };
  }

  res.json({
    week,
    kids,
    grid,
    chores: chores.map((c) => ({
      id: c.id,
      title: c.title,
      points: c.points,
      frequency: c.frequency,
      days: parseDays(c.days),
      active: !!c.active
    }))
  });
});

// --- Redemptions ------------------------------------------------------------------

function earnedTotals() {
  return new Map(
    prepare('SELECT kid_id, COALESCE(SUM(points), 0) AS total FROM completions GROUP BY kid_id').all()
      .map((t) => [t.kid_id, t.total])
  );
}

function spentTotals() {
  return new Map(
    prepare('SELECT kid_id, COALESCE(SUM(points), 0) AS total FROM redemptions GROUP BY kid_id').all()
      .map((t) => [t.kid_id, t.total])
  );
}

// GET /api/redeemptions?limit=N  -> most recent spends
app.get('/api/redeemptions', (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
  res.json(
    prepare(
      `SELECT r.*, k.name AS kid_name, k.color AS kid_color, k.emoji AS kid_emoji
         FROM redemptions r
         JOIN kids k ON k.id = r.kid_id
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ?`
    ).all(limit)
  );
});

// POST /api/redeem  { kidId, reward: { label, points } }
app.post('/api/redeem', requireAdminOrSelf((req) => {
  const n = Number(req.body?.kidId);
  return Number.isInteger(n) && n > 0 ? n : null;
}), (req, res) => {
  const { kidId, reward } = req.body || {};
  const label = reward && String(reward.label || '').trim();
  const points = reward && Number(reward.points);
  if (!label) return sendError(res, 400, 'Reward label is required');
  if (!Number.isInteger(points) || points <= 0) return sendError(res, 400, 'Reward points must be a positive integer');
  const kid = prepare('SELECT * FROM kids WHERE id = ?').get(kidId);
  if (!kid) return sendError(res, 404, 'Kid not found');
  const earned = earnedTotals().get(kid.id) || 0;
  const spent = spentTotals().get(kid.id) || 0;
  const balance = earned - spent;
  if (balance < points) return sendError(res, 400, `${kid.name} only has ${balance} point${balance === 1 ? '' : 's'}`);
  try {
    const info = prepare(
      'INSERT INTO redemptions (kid_id, reward_label, points) VALUES (?, ?, ?)'
    ).run(kid.id, label, points);
    res.status(201).json({
      id: info.lastInsertRowid,
      kidId: kid.id,
      kidName: kid.name,
      kidEmoji: kid.emoji,
      kidColor: kid.color,
      rewardLabel: label,
      points,
      balance: balance - points
    });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// --- Totals / rewards -------------------------------------------------------------

app.get('/api/totals', (req, res) => {
  const kids = prepare('SELECT * FROM kids ORDER BY id').all();
  const earned = earnedTotals();
  const spent = spentTotals();
  res.json(
    kids.map((k) => {
      const earnedPts = earned.get(k.id) || 0;
      const spentPts = spent.get(k.id) || 0;
      const balance = earnedPts - spentPts;
      return {
        id: k.id,
        name: k.name,
        color: k.color,
        emoji: k.emoji,
        earned: earnedPts,
        spent: spentPts,
        balance
      };
    })
  );
});

// --- Settings -----------------------------------------------------------------------

app.get('/api/settings', (req, res) => {
  const { adminPinHash, adminPinSalt, ...publicSettings } = loadSettings();
  res.json(publicSettings);
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const current = loadSettings();
  const body = req.body || {};
  const next = { ...current };
  if (Array.isArray(body.rewards)) {
    next.rewards = body.rewards
      .filter((r) => r && String(r.label).trim())
      .map((r) => ({ id: Number(r.id) || Date.now(), label: String(r.label).trim(), points: Number(r.points) || 0 }));
  }
  if (body.weekStartDay !== undefined) {
    const wsd = Number(body.weekStartDay);
    if (!Number.isInteger(wsd) || wsd < 0 || wsd > 6) return sendError(res, 400, 'weekStartDay must be 0-6');
    next.weekStartDay = wsd;
  }
  saveSettings(next);
  res.json(next);
});

bootstrapPinsFromEnv();

app.listen(PORT, () => {
  console.log(`KiddoDash chore chart running on http://localhost:${PORT}`);
});
