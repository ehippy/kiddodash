'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new DatabaseSync(path.join(DATA_DIR, 'kiddodash.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS kids (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '#7c3aed',
    emoji       TEXT NOT NULL DEFAULT '🙂',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    points      INTEGER NOT NULL DEFAULT 1,
    frequency   TEXT NOT NULL DEFAULT 'weekly'
                CHECK (frequency IN ('daily', 'weekly', 'personal')),
    day_of_week INTEGER,
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
  if (choresSql && !/CHECK \(frequency IN \('daily', 'weekly', 'personal'\)\)/.test(choresSql)) {
    db.exec(`
      ALTER TABLE chores RENAME TO chores_old;
      CREATE TABLE chores (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT NOT NULL,
        points      INTEGER NOT NULL DEFAULT 1,
        frequency   TEXT NOT NULL DEFAULT 'weekly'
                    CHECK (frequency IN ('daily', 'weekly', 'personal')),
        day_of_week INTEGER,
        active      INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO chores (id, title, points, frequency, day_of_week, active)
        SELECT id, title, points, frequency, day_of_week, active FROM chores_old;
      DROP TABLE chores_old;
    `);
    console.log('migrated: chores now supports personal frequency');
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
}

migrate();

// ---------------------------------------------------------------------------
// Settings (points, goal, rewards)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  pointsPerCompletion: 1,
  goalPoints: 20,
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
// Helpers
// ---------------------------------------------------------------------------

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekDates(offset = 0) {
  // Monday-start week, offset by whole weeks (negative = past, positive = future)
  const now = new Date();
  const jsDay = (now.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() - jsDay + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const p = (n) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      day: DAYS[(i + 1) % 7],
      weekdayIndex: (i + 1) % 7
    };
  });
}

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const prepare = (sql) => db.prepare(sql);

// --- Health ----------------------------------------------------------------

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- Kids --------------------------------------------------------------------

app.get('/api/kids', (req, res) => {
  const kids = prepare('SELECT * FROM kids ORDER BY id').all();
  const totals = prepare(
    `SELECT kid_id, COALESCE(SUM(points), 0) AS total
       FROM completions GROUP BY kid_id`
  ).all();
  const byKid = new Map(totals.map((t) => [t.kid_id, t.total]));
  res.json(kids.map((k) => ({ ...k, points: byKid.get(k.id) || 0 })));
});

app.post('/api/kids', (req, res) => {
  const { name, color, emoji } = req.body || {};
  if (!name || !String(name).trim()) return sendError(res, 400, 'Name is required');
  try {
    const info = prepare('INSERT INTO kids (name, color, emoji) VALUES (?, ?, ?)').run(
      String(name).trim(),
      color || '#7c3aed',
      emoji || '🙂'
    );
    res.status(201).json(prepare('SELECT * FROM kids WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

app.put('/api/kids/:id', (req, res) => {
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
  res.json(prepare('SELECT * FROM kids WHERE id = ?').get(kid.id));
});

app.delete('/api/kids/:id', (req, res) => {
  const info = prepare('DELETE FROM kids WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return sendError(res, 404, 'Kid not found');
  res.json({ ok: true });
});

// --- Chores --------------------------------------------------------------------

app.get('/api/chores', (req, res) => {
  const chores = prepare('SELECT * FROM chores ORDER BY frequency, day_of_week, id').all();
  const doneToday = new Map(
    prepare(
      `SELECT c.chore_id, COUNT(*) AS n FROM completions c
         WHERE c.done_date = ? GROUP BY c.chore_id`
    ).all(todayStr()).map((r) => [r.chore_id, r.n])
  );
  res.json(chores.map((c) => ({ ...c, doneToday: doneToday.get(c.id) || 0 })));
});

app.post('/api/chores', (req, res) => {
  const { title, points, frequency, dayOfWeek } = req.body || {};
  if (!title || !String(title).trim()) return sendError(res, 400, 'Title is required');
  const freq = ['daily', 'weekly', 'personal'].includes(frequency) ? frequency : 'weekly';
  let dow = dayOfWeek == null ? null : Number(dayOfWeek);
  if (dow < 0 || dow > 6) dow = null;
  const pts = Number.isInteger(points) && points > 0 ? points : 1;
  try {
    const info = prepare(
      `INSERT INTO chores (title, points, frequency, day_of_week) VALUES (?, ?, ?, ?)`
    ).run(String(title).trim(), pts, freq, dow);
    res.status(201).json(prepare('SELECT * FROM chores WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

app.put('/api/chores/:id', (req, res) => {
  const chore = prepare('SELECT * FROM chores WHERE id = ?').get(req.params.id);
  if (!chore) return sendError(res, 404, 'Chore not found');
  const title = req.body.title !== undefined ? String(req.body.title).trim() : chore.title;
  if (!title) return sendError(res, 400, 'Title cannot be empty');
  const points =
    req.body.points !== undefined && Number.isInteger(req.body.points) && req.body.points > 0
      ? req.body.points
      : chore.points;
  const frequency =
    req.body.frequency === 'daily' || req.body.frequency === 'weekly' || req.body.frequency === 'personal'
      ? req.body.frequency
      : chore.frequency;
  let dow =
    req.body.dayOfWeek !== undefined
      ? req.body.dayOfWeek == null
        ? null
        : Number(req.body.dayOfWeek)
      : chore.day_of_week;
  if (dow !== null && (dow < 0 || dow > 6)) dow = null;
  const active =
    req.body.active !== undefined ? (req.body.active ? 1 : 0) : chore.active;

  prepare('UPDATE chores SET title = ?, points = ?, frequency = ?, day_of_week = ?, active = ? WHERE id = ?').run(
    title, points, frequency, dow, active, chore.id
  );
  res.json(prepare('SELECT * FROM chores WHERE id = ?').get(chore.id));
});

app.delete('/api/chores/:id', (req, res) => {
  const info = prepare('DELETE FROM chores WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return sendError(res, 404, 'Chore not found');
  res.json({ ok: true });
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
app.post('/api/completions', (req, res) => {
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
app.delete('/api/completions/:id', (req, res) => {
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
    ...k,
    points: totals.get(k.id) || 0
  }));
  const chores = prepare('SELECT * FROM chores WHERE active = 1 ORDER BY frequency, day_of_week, id').all();
  const week = weekDates(offset);
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
      dayOfWeek: c.day_of_week
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
app.post('/api/redeem', (req, res) => {
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
  const settings = loadSettings();
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
        balance,
        goal: settings.goalPoints,
        rewardable: balance >= settings.goalPoints
      };
    })
  );
});

// --- Settings -----------------------------------------------------------------------

app.get('/api/settings', (req, res) => res.json(loadSettings()));

app.put('/api/settings', (req, res) => {
  const current = loadSettings();
  const body = req.body || {};
  const next = { ...current };
  if (body.goalPoints !== undefined) {
    if (!Number.isInteger(body.goalPoints) || body.goalPoints < 1) {
      return sendError(res, 400, 'goalPoints must be a positive integer');
    }
    next.goalPoints = body.goalPoints;
  }
  if (Array.isArray(body.rewards)) {
    next.rewards = body.rewards
      .filter((r) => r && String(r.label).trim())
      .map((r) => ({ id: Number(r.id) || Date.now(), label: String(r.label).trim(), points: Number(r.points) || 0 }));
  }
  saveSettings(next);
  res.json(next);
});

app.listen(PORT, () => {
  console.log(`KiddoDash chore chart running on http://localhost:${PORT}`);
});
