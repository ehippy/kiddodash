'use strict';

// Rows orphaned by the old FK-less behaviour get removed at startup — idempotently, and
// quietly on healthy databases — so /api/totals stops counting points nobody can spend.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootServer } = require('./helpers');

const orphans = (srv) => ({
  completions: srv.scalar(
    'SELECT COUNT(*) FROM completions WHERE kid_id NOT IN (SELECT id FROM kids) OR chore_id NOT IN (SELECT id FROM chores)'
  ),
  redemptions: srv.scalar('SELECT COUNT(*) FROM redemptions WHERE kid_id NOT IN (SELECT id FROM kids)')
});

const counts = (srv) => ({
  kids: srv.scalar('SELECT COUNT(*) FROM kids'),
  completions: srv.scalar('SELECT COUNT(*) FROM completions'),
  redemptions: srv.scalar('SELECT COUNT(*) FROM redemptions')
});

/** Reproduce the damage the old code produced: parents deleted, children left behind. */
function seedOrphans(srv) {
  srv.seed("INSERT INTO kids (id, name) VALUES (7, 'Ghost'), (8, 'Real')");
  srv.seed("INSERT INTO chores (id, title, points) VALUES (9, 'Ghost chore', 4), (10, 'Real chore', 2)");
  srv.seed("INSERT INTO completions (id, chore_id, kid_id, done_date, points) VALUES (1, 9, 7, '2019-01-01', 4)");
  srv.seed("INSERT INTO completions (id, chore_id, kid_id, done_date, points) VALUES (2, 9, 999, '2019-01-02', 4)");
  srv.seed("INSERT INTO completions (id, chore_id, kid_id, done_date, points) VALUES (3, 888, 7, '2019-01-03', 4)");
  srv.seed("INSERT INTO completions (id, chore_id, kid_id, done_date, points) VALUES (4, 10, 8, '2019-05-05', 2)");
  srv.seed("INSERT INTO redemptions (id, kid_id, reward_label, points) VALUES (1, 66, 'stolen ice cream', 3)");
  srv.seed("INSERT INTO redemptions (id, kid_id, reward_label, points) VALUES (2, 8, 'real reward', 1)");
  // the pre-fix DELETE: kid 7 and chore 9 vanish, their dependents stay behind
  srv.seed('DELETE FROM kids WHERE id = 7');
  srv.seed('DELETE FROM chores WHERE id = 9');
}

test('startup removes orphaned rows, logs once, and stays quiet on later boots', async () => {
  const seeded = await bootServer();
  await seeded.stop();
  seedOrphans(seeded);
  assert.deepEqual(orphans(seeded), { completions: 3, redemptions: 1 }, 'seeding should leave orphans behind');

  const cleaned = await bootServer({ dataDir: seeded.dataDir });
  const log = cleaned.logsJoined();
  assert.match(
    log,
    /migrated: removed 3 orphaned completion\(s\), 1 orphaned redemption\(s\)/,
    `expected the cleanup line, got:\n${log}`
  );
  assert.deepEqual(orphans(cleaned), { completions: 0, redemptions: 0 });
  assert.deepEqual(counts(cleaned), { kids: 1, completions: 1, redemptions: 1 }, 'legit rows must survive');
  await cleaned.stop();

  // Ghost points are gone from the totals /api/redeem spends against; a second boot is
  // idempotent: nothing more is deleted and nothing is logged.
  const healthy = await bootServer({ dataDir: seeded.dataDir });
  try {
    const secondLog = healthy.logsJoined();
    assert.doesNotMatch(secondLog, /orphaned/, `healthy restart should stay quiet, got:\n${secondLog}`);
    assert.deepEqual(counts(healthy), { kids: 1, completions: 1, redemptions: 1 });
    assert.deepEqual((await healthy.api('GET', '/api/totals')).body, [
      { id: 8, name: 'Real', color: '#7c3aed', emoji: '🙂', earned: 2, spent: 1, balance: 1 }
    ]);
  } finally {
    await healthy.stop();
  }
});
