'use strict';

/* ============================ State ============================ */

const state = {
  kids: [],
  chores: [],
  settings: null,
  kidTotals: [], // from /api/totals: earned, spent, balance
  recentSpends: [], // from /api/redeemptions
  weekOffset: 0, // 0 = current week
  chartView: (() => { try { return localStorage.getItem('kiddodash-view') === 'week' ? 'week' : 'today'; } catch { return 'today'; } })(),
  authRequired: false, // true once any PIN is configured server-side
  session: null, // { role: 'admin' } | { role: 'kid', kid: {...} } | null
};

// Session token lives in sessionStorage: cross-site fetches can't set the
// Authorization header, so the Bearer token doubles as our CSRF defense.
const authToken = {
  get: () => sessionStorage.getItem('kiddodash-token'),
  set: (t) => sessionStorage.setItem('kiddodash-token', t),
  clear: () => sessionStorage.removeItem('kiddodash-token'),
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

/* ============================ API ============================ */

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = authToken.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // Signed out underneath us (PINs changed, session expired or dropped): re-check
  // and let the sign-in screen take over instead of failing action after action.
  if (res.status === 401) refreshAuth().catch(() => {});
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, variant = 'success') {
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${variant} border-0 position-fixed bottom-0 end-0 m-3`;
  el.style.zIndex = 2000;
  el.innerHTML = `<div class="d-flex">
      <div class="toast-body fw-bold">${esc(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>`;
  document.body.appendChild(el);
  const t = new bootstrap.Toast(el, { delay: 3500 });
  t.show();
  el.addEventListener('hidden.bs.toast', () => el.remove());
}

/* ============================ Dates ============================ */

function dateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function weekDates(offset) {
  const startDay = state.settings?.weekStartDay ?? 1;
  const now = new Date();
  const jsDay = (now.getDay() - startDay + 7) % 7;
  const start = new Date(now);
  start.setDate(now.getDate() - jsDay + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun

function sortByWeekOrder(days) {
  return [...days].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
}

// Single source of truth for "is this chore due on this weekday" — used by both
// the chart and the today-summary chips, so they can't drift apart.
function choreIsDueOn(chore, dow) {
  if (chore.frequency === 'daily') return true;
  if (chore.frequency === 'schooldays') return dow >= 1 && dow <= 5;
  if (chore.frequency === 'personal') return !chore.days || !chore.days.length || chore.days.includes(dow);
  if (chore.frequency === 'weekly') return !!chore.days && chore.days.includes(dow);
  return false;
}

// 'due_by' chores: each kid does it once per chart week, on any day; the chosen
// day is the deadline.
function deadlineDate(chore, dates) {
  const d = dates.find((x) => x.getDay() === chore.days?.[0]);
  return d ? dateStr(d) : null;
}

// kidId -> { date, completion } for every kid who did this chore in `grid`'s week
function doneThisWeek(chore, grid) {
  const out = new Map();
  for (const [ds, byKid] of Object.entries((grid || {})[chore.id] || {})) {
    for (const [kidId, c] of Object.entries(byKid)) out.set(Number(kidId), { date: ds, completion: c });
  }
  return out;
}

// Shared custody: strictly alternating 7-day stretches starting (home) on
// custody.homeStart, with single-date exceptions. Away days have no chores due.
function isAway(ds) {
  const c = state.settings?.custody;
  if (!c?.enabled || !c.homeStart) return false;
  const pinned = c.exceptions?.[ds];
  if (pinned) return pinned === 'away';
  const days = Math.round((Date.parse(ds + 'T00:00:00Z') - Date.parse(c.homeStart + 'T00:00:00Z')) / 86400000);
  return Math.floor(days / 7) % 2 !== 0;
}

// First date on/after `ds` whose home/away status is `away` (false = next home day).
function nextSwitch(ds, away) {
  const d = new Date(ds + 'T00:00:00');
  for (let i = 0; i < 120; i++) {
    if (isAway(dateStr(d)) === away) return dateStr(d);
    d.setDate(d.getDate() + 1);
  }
  return null;
}

const fmtDay = (ds) =>
  new Date(ds + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

// Cooldown choices for anytime jobs (days), and how to say them.
const COOLDOWNS = [[1, 'once a day'], [7, 'once a week'], [14, 'every 2 weeks'], [30, 'once a month'], [90, 'every 3 months']];
const cooldownText = (n) => COOLDOWNS.find(([d]) => d === n)?.[1] || `every ${n} days`;

// Anytime jobs: the day this job is available again, or null if it is now.
function restingUntil(chore, today) {
  if (chore.frequency !== 'anytime' || !chore.lastDone || !chore.cooldownDays) return null;
  const d = new Date(chore.lastDone + 'T00:00:00');
  d.setDate(d.getDate() + chore.cooldownDays);
  const next = dateStr(d);
  return next > today ? next : null;
}

function freqBadgeHtml(chore) {
  if (chore.frequency === 'anytime') {
    return `<span class="badge text-bg-success freq-badge">anytime · ${esc(cooldownText(chore.cooldownDays))}</span>`;
  }
  if (chore.frequency === 'due_by') {
    return `<span class="badge text-bg-primary freq-badge">each kid, by ${DAY_NAMES[chore.days?.[0]] ?? '?'}</span>`;
  }
  if (chore.frequency === 'daily') return '<span class="badge text-bg-info freq-badge">daily</span>';
  if (chore.frequency === 'schooldays') return '<span class="badge text-bg-info freq-badge">each kid, school nights</span>';
  const daysLabel = chore.days && chore.days.length
    ? sortByWeekOrder(chore.days).map((d) => DAY_NAMES[d]).join(', ')
    : null;
  if (chore.frequency === 'personal') {
    return `<span class="badge text-bg-primary freq-badge">each kid, ${daysLabel || 'daily'}</span>`;
  }
  return `<span class="badge text-bg-secondary freq-badge">${daysLabel}</span>`;
}

// Multi-day picker: weekly needs at least one day picked (enforced server-side
// too), personal can mean every day (none picked) or specific days, daily/
// schooldays have no day concept at all. Shared by the add-chore form and the
// edit modal via a distinct `idPrefix` so their checkbox ids never collide.
function renderChoreDaysPicker(container, idPrefix, freq, selectedDays, cooldownDays = 7) {
  if (freq === 'anytime') {
    // No days: a bonus job can happen any time, then rests for a while.
    container.innerHTML = `
      <label class="form-label small fw-bold mb-1" for="${idPrefix}-cooldown">At most</label>
      <select class="form-select form-select-sm" id="${idPrefix}-cooldown" data-cooldown style="max-width:200px">
        ${COOLDOWNS.map(([d, label]) => `<option value="${d}"${d === cooldownDays ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
      <div class="form-text">Never due or missed. Once someone does it, it rests for everyone until then.</div>
    `;
    return;
  }
  if (freq === 'daily' || freq === 'schooldays') {
    container.innerHTML = '';
    return;
  }
  const selected = new Set(selectedDays || []);
  if (freq === 'due_by') {
    // One deadline day: radios sharing a name, read back by readChoreDaysPicker.
    const pick = selected.size ? [...selected][0] : ((state.settings?.weekStartDay ?? 1) + 6) % 7;
    container.innerHTML = `
      <div class="btn-group btn-group-sm chore-days-picker" role="group">
        ${WEEK_ORDER.map((d) => {
          const id = `${idPrefix}-${d}`;
          return `<input type="radio" class="btn-check" name="${idPrefix}" id="${id}" value="${d}" autocomplete="off"${d === pick ? ' checked' : ''}>
                  <label class="btn btn-outline-secondary" for="${id}">${DAY_NAMES[d]}</label>`;
        }).join('')}
      </div>
      <div class="form-text">Due by this day — can be done any day that week</div>
    `;
    return;
  }
  container.innerHTML = `
    <div class="btn-group btn-group-sm chore-days-picker" role="group">
      ${WEEK_ORDER.map((d) => {
        const id = `${idPrefix}-${d}`;
        return `<input type="checkbox" class="btn-check" id="${id}" value="${d}" autocomplete="off"${selected.has(d) ? ' checked' : ''}>
                <label class="btn btn-outline-secondary" for="${id}">${DAY_NAMES[d]}</label>`;
      }).join('')}
    </div>
    ${freq === 'personal' ? '<div class="form-text">No days picked = every day</div>' : ''}
  `;
}

function readChoreDaysPicker(container) {
  return Array.from(container.querySelectorAll('input:checked')).map((el) => Number(el.value));
}

const readCooldown = (container) => Number(container.querySelector('[data-cooldown]')?.value) || undefined;

/* ============================ Auth ============================ */

function isAdmin() {
  return !state.authRequired || state.session?.role === 'admin';
}

function myKidId() {
  return state.session?.role === 'kid' ? state.session.kid.id : null;
}

function applyRoleUI() {
  const admin = isAdmin();
  const kid = myKidId();
  // Admin-only tabs
  $('#tab-settings').classList.toggle('d-none', !admin);
  $('#tab-activity').classList.toggle('d-none', !admin);
  // Anything marked admin-only (reward edit/delete)
  document.querySelectorAll('[data-admin-only]').forEach((el) => {
    el.classList.toggle('d-none', !admin);
  });
  if (!admin && ($('#pane-settings').classList.contains('show') || $('#pane-activity').classList.contains('show'))) {
    bootstrap.Tab.getOrCreateInstance($('#tab-chart')).show();
  }
  // Rewards: kids redeem only their own — hide other kids in the pickers
  // (handled in loadRewardsTab).
  // Nav identity
  const badge = $('#whoBadge');
  const signOut = $('#btnSignOut');
  const myPin = $('#btnMyPin');
  if (state.session) {
    badge.classList.remove('d-none');
    signOut.classList.remove('d-none');
    if (state.session.role === 'admin') {
      badge.textContent = '👑 Admin';
      badge.className = 'badge text-bg-warning';
      myPin.classList.add('d-none');
    } else {
      badge.textContent = `${state.session.kid.emoji} ${state.session.kid.name}`;
      badge.style.background = state.session.kid.color;
      badge.className = 'badge text-light';
      myPin.classList.remove('d-none');
    }
  } else {
    badge.classList.add('d-none');
    signOut.classList.add('d-none');
    myPin.classList.add('d-none');
  }
}

let pinAutoSubmitTimer = null;

function onPinChanged() {
  clearTimeout(pinAutoSubmitTimer);
  const len = $('#loginPin').value.length;
  if (len === 8) {
    $('#loginForm').requestSubmit();
  } else if (len >= 4) {
    // Kid PINs are exactly 4 digits; admin PINs run 4-8. Give a brief pause
    // in case more digits are coming before auto-submitting.
    pinAutoSubmitTimer = setTimeout(() => $('#loginForm').requestSubmit(), 450);
  }
}

function showLogin(required) {
  $('#loginOverlay').style.display = required ? 'flex' : 'none';
  if (required) $('#loginPin').focus();
}

async function refreshAuth() {
  const status = await api('/api/auth/status');
  state.authRequired = status.required;
  state.session = status.session;
  if (!status.required) authToken.clear();
  if (status.required && !status.session && authToken.get()) authToken.clear(); // stale token
  applyRoleUI();
  showLogin(state.authRequired && !state.session);
}

async function doLogin(pin) {
  const res = await api('/api/auth/login', { method: 'POST', body: { pin } });
  authToken.set(res.token);
  state.session = res.role === 'admin' ? { role: 'admin' } : { role: 'kid', kid: res.kid };
  applyRoleUI();
  showLogin(false);
  $('#loginPin').value = '';
  $('#loginError').classList.add('d-none');
  clearTimeout(pinAutoSubmitTimer);
  await Promise.all([refreshWeek(), refreshRewards()]);
}

/* ============================ Chart tab ============================ */

// The chart tab has two views: Today (a board per kid, the default — what do I
// have to do now?) and Week (the grid, for looking back and planning ahead).
// Today always reads the *current* week's grid, even while Week is paged elsewhere.

const PER_KID = new Set(['personal', 'schooldays', 'due_by']);
const isPerKid = (chore) => PER_KID.has(chore.frequency);
const canActFor = (kidId) => isAdmin() || myKidId() === kidId;
const ptsLabel = (n) => `${n} pt${n === 1 ? '' : 's'}`;

// Plain-language schedule, shown as a tooltip and under titles on the Today board.
function scheduleText(chore) {
  const days = chore.days && chore.days.length ? sortByWeekOrder(chore.days).map((d) => DAY_NAMES[d]).join(', ') : null;
  const when = {
    daily: 'every day',
    schooldays: 'school nights (Mon–Fri)',
    personal: days || 'every day',
    weekly: days || '',
    due_by: `once a week, due by ${DAYS_FULL[chore.days?.[0]] ?? '?'}`,
    anytime: `anytime, at most ${cooldownText(chore.cooldownDays)}`,
  }[chore.frequency];
  return `${isPerKid(chore) ? 'Each kid' : 'Shared — anyone can do it'} · ${when}`;
}

const scopeIcon = (chore) =>
  isPerKid(chore)
    ? '<i class="bi bi-person-fill scope-icon" aria-label="Each kid"></i>'
    : chore.frequency === 'anytime'
      ? '<i class="bi bi-stars scope-icon" aria-label="Bonus job"></i>'
      : '<i class="bi bi-people-fill scope-icon" aria-label="Shared"></i>';

function setChartView(view) {
  state.chartView = view;
  try { localStorage.setItem('kiddodash-view', view); } catch { /* storage unavailable */ }
  renderChart();
}

function renderChart() {
  const week = state.chartView === 'week';
  $('#viewToday').checked = !week;
  $('#viewWeek').checked = week;
  $('#todayView').classList.toggle('d-none', week);
  $('#weekView').classList.toggle('d-none', !week);
  $('#weekNav').classList.toggle('d-none', !week);
  if (week) loadWeek();
  else renderTodayBoard();
}

/* ---------- Today board ---------- */

// One kid's chores for today: each-kid chores due today, plus due_by chores they
// haven't done yet this week (or did today). Shared chores live in their own card.
function todayItemsForKid(kid, today, dates) {
  const grid = state.currentGrid || {};
  const dow = new Date().getDay();
  const items = [];
  for (const chore of state.chores.filter((c) => c.active && isPerKid(c))) {
    if (chore.frequency === 'due_by') {
      const d = doneThisWeek(chore, grid).get(kid.id);
      if (d && d.date !== today) continue;
      const deadline = deadlineDate(chore, dates);
      const dueDay = DAY_NAMES[chore.days?.[0]];
      const late = d ? d.date > deadline : today > deadline;
      const note = d
        ? late ? 'done late' : 'done this week'
        : today < deadline ? `any day, due by ${dueDay}` : today === deadline ? 'due today' : `late — was due ${dueDay}`;
      items.push({ chore, done: d?.completion || null, note, late });
    } else if (choreIsDueOn(chore, dow)) {
      items.push({ chore, done: grid[chore.id]?.[today]?.[kid.id] || null, note: '', late: false });
    }
  }
  // Late first (needs attention), then to-do, then done.
  const rank = (i) => (i.done ? 2 : i.late ? 0 : 1);
  return items.sort((a, b) => rank(a) - rank(b));
}

function boardItemHtml({ chore, done, note, late }, kid, today) {
  const cls = `board-item${done ? ' done' : ''}${late && !done ? ' late' : ''}`;
  const noteHtml = note ? `<span class="board-note">${esc(note)}</span>` : '';
  const body = `
    <span class="board-check">${done ? `<i class="bi bi-${late ? 'clock-history' : 'check-lg'}"></i>` : ''}</span>
    <span class="board-text"><span class="board-title">${esc(chore.title)}</span>${noteHtml}</span>
    <span class="board-pts">+${chore.points}</span>`;
  if (!canActFor(kid.id)) {
    return `<div class="${cls}" title="Only ${esc(kid.name)} or a parent can check this">${body}</div>`;
  }
  return done
    ? `<button class="${cls}" data-undo="${done.id}" data-undo-label="${esc(kid.name)}’s “${esc(chore.title)}”" title="Tap to undo">${body}</button>`
    : `<button class="${cls}" data-complete data-chore="${chore.id}" data-kid="${kid.id}" data-date="${today}" title="Tap when done">${body}</button>`;
}

function renderTodayBoard() {
  const board = $('#todayBoard');
  const now = new Date();
  const today = dateStr(now);
  const dates = weekDates(0);
  $('#todayLabel').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('#todayHelp').classList.toggle('d-none', isAway(today));

  if (!state.kids.length) {
    board.innerHTML = '<div class="col-12"><div class="empty-state"><i class="bi bi-people"></i>Add a kid first (Settings → Kids).</div></div>';
    return;
  }
  if (isAway(today)) {
    const back = nextSwitch(today, false);
    const faces = state.kids.map((k) => `<span class="kid-avatar" style="background:${esc(k.color)}">${esc(k.emoji)}</span>`).join('');
    board.innerHTML = `<div class="col-12 col-lg-8"><div class="away-board">
        <div class="away-faces">${faces}</div>
        <div class="away-title">At the other house</div>
        <div class="away-sub">${back ? `Back ${esc(fmtDay(back))} 🏠` : 'See you soon 🏠'} · no chores until then</div>
      </div></div>`;
    return;
  }
  // A signed-in kid sees their own card first.
  const kids = [...state.kids].sort((a, b) => (b.id === myKidId()) - (a.id === myKidId()));
  const cards = kids.map((kid) => {
    const items = todayItemsForKid(kid, today, dates);
    const doneCount = items.filter((i) => i.done).length;
    const pct = items.length ? Math.round((doneCount / items.length) * 100) : 100;
    // Everything this kid earned today, bonus jobs and shared chores included.
    const earned = Object.values(state.currentGrid || {}).reduce((sum, byDate) => sum + (byDate[today]?.[kid.id]?.points || 0), 0);
    const status = !items.length
      ? 'Nothing today'
      : doneCount === items.length
        ? 'All done! 🎉'
        : `${doneCount} of ${items.length} done`;
    return `<div class="col-12 col-md-6 col-xl-4">
      <div class="kid-board${doneCount === items.length ? ' all-done' : ''}" style="--kid-color:${esc(kid.color)}">
        <div class="kid-board-head">
          <span class="kid-avatar" style="background:${esc(kid.color)}">${esc(kid.emoji)}</span>
          <div class="flex-grow-1">
            <div class="kid-board-name">${esc(kid.name)}</div>
            <div class="kid-board-status">${status}${earned ? ` · +${earned} today` : ''}</div>
          </div>
        </div>
        <div class="kid-board-progress"><span style="width:${pct}%"></span></div>
        <div class="board-list">
          ${items.map((i) => boardItemHtml(i, kid, today)).join('') || '<div class="board-empty">No chores for you today 🎉</div>'}
        </div>
      </div>
    </div>`;
  });

  // Shared chores due today, then anytime bonus jobs: one row each; tapping asks
  // who did it (one kid or a team).
  const dow = now.getDay();
  const shared = state.chores.filter((c) => c.active && c.frequency !== 'anytime' && !isPerKid(c) && choreIsDueOn(c, dow));
  const bonus = state.chores.filter((c) => c.active && c.frequency === 'anytime');
  const sharedCard = (title, status, icon, list, emptyNote) => `<div class="col-12 col-md-6 col-xl-4">
      <div class="kid-board shared-board">
        <div class="kid-board-head">
          <span class="kid-avatar shared-avatar"><i class="bi bi-${icon}"></i></span>
          <div class="flex-grow-1">
            <div class="kid-board-name">${title}</div>
            <div class="kid-board-status">${status}</div>
          </div>
        </div>
        <div class="board-list">${list.map((c) => sharedItemHtml(c, today, emptyNote)).join('')}</div>
      </div>
    </div>`;
  if (shared.length) cards.push(sharedCard('Shared', 'Anyone can do these — or team up', 'people-fill', shared, 'whoever does it gets the points'));
  if (bonus.length) cards.push(sharedCard('Bonus jobs', 'Extra points, any time', 'stars', bonus, 'team up and split the points'));
  board.innerHTML = cards.join('');
}

// One shared chore or bonus job on the Today board.
function sharedItemHtml(chore, today, hint) {
  const team = Object.values(state.currentGrid?.[chore.id]?.[today] || {});
  const resting = team.length ? null : restingUntil(chore, today);
  const cls = `board-item${team.length ? ' done' : ''}${resting ? ' resting' : ''}`;
  const body = (note) => `
      <span class="board-check">${team.length ? '<i class="bi bi-check-lg"></i>' : resting ? '<i class="bi bi-hourglass-split"></i>' : ''}</span>
      <span class="board-text"><span class="board-title">${esc(chore.title)}</span>${note}</span>
      <span class="board-pts">+${chore.points}</span>`;
  if (team.length) {
    const names = team.map((c) => `<span class="who-dot" style="background:${esc(c.kidColor)}"></span>${esc(c.kidEmoji)} ${esc(c.kidName)}`).join(' &nbsp;');
    const note = `<span class="board-note">${names} ${team.length > 1 ? 'did it together' : 'did it'}</span>`;
    const label = `${team.map((c) => c.kidName).join(' & ')}’s “${chore.title}”`;
    return team.every((c) => canActFor(c.kidId))
      ? `<button class="${cls}" data-undo="${team.map((c) => c.id).join(',')}" data-undo-label="${esc(label)}" title="Tap to undo">${body(note)}</button>`
      : `<div class="${cls}">${body(note)}</div>`;
  }
  if (resting) {
    return `<div class="${cls}" title="Resting until ${esc(fmtDay(resting))}">${body(`<span class="board-note">available again ${esc(fmtDay(resting))}</span>`)}</div>`;
  }
  const canAct = isAdmin() || myKidId() !== null;
  const note = `<span class="board-note">${esc(hint)}${chore.frequency === 'anytime' ? ` · ${esc(cooldownText(chore.cooldownDays))}` : ''}</span>`;
  return canAct
    ? `<button class="${cls}" data-chore="${chore.id}" data-date="${today}" title="Tap when done">${body(note)}</button>`
    : `<div class="${cls}">${body(note)}</div>`;
}

/* ---------- Week grid ---------- */

// A kid's avatar in a cell. Done: solid (clock badge if late). To do: faded,
// dashed ring in the kid's color — today it's tappable, in the past it's red
// ("missed", still tappable to backfill), in the future it's inert.
function avatarHtml(kid, { state: st, completion, date, choreId, late = false }) {
  const title = (s) => `${esc(kid.name)} — ${s}`;
  if (st === 'done') {
    const c = completion;
    const badge = late ? '<span class="av-badge"><i class="bi bi-clock-history"></i></span>' : '';
    return canActFor(c.kidId)
      ? `<button class="av done" style="--kid-color:${esc(c.kidColor)}" data-undo="${c.id}" data-undo-label="${esc(c.kidName)}’s check" title="${title(late ? 'done late · tap to undo' : 'done · tap to undo')}">${esc(c.kidEmoji)}${badge}</button>`
      : `<span class="av done" style="--kid-color:${esc(c.kidColor)}" title="${title(late ? 'done late' : 'done')}">${esc(c.kidEmoji)}${badge}</span>`;
  }
  const label = { todo: 'to do · tap when done', late: 'late · tap when done', missed: 'missed · tap to fill in', future: 'coming up' }[st];
  // Filling in a missed day is a parent's call (the server enforces it too).
  if (st === 'future' || !canActFor(kid.id) || (st === 'missed' && !isAdmin())) {
    return `<span class="av ${st}" style="--kid-color:${esc(kid.color)}" title="${title(label.split(' · ')[0])}">${esc(kid.emoji)}</span>`;
  }
  return `<button class="av ${st}" style="--kid-color:${esc(kid.color)}" data-complete data-chore="${choreId}" data-kid="${kid.id}" data-date="${date}" title="${title(label)}">${esc(kid.emoji)}</button>`;
}

// Same idea for an undone shared chore: a single "+" slot that opens the kid picker.
function sharedSlotHtml(st, choreId, date) {
  const canAct = st === 'todo' ? isAdmin() || myKidId() !== null : st === 'missed' && isAdmin();
  const icon = st === 'missed' ? 'x-lg' : 'plus-lg';
  const label = { todo: 'Tap when done', missed: 'Missed · tap to fill in', future: 'Coming up' }[st];
  return canAct
    ? `<button class="av shared ${st}" data-chore="${choreId}" data-date="${date}" title="${label}"><i class="bi bi-${icon}"></i></button>`
    : `<span class="av shared ${st}" title="${label}"><i class="bi bi-${icon}"></i></span>`;
}

const timeState = (ds, today) => (ds < today ? 'missed' : ds === today ? 'todo' : 'future');

function choreCellsHtml(chore, dates, today) {
  const grid = state.weekGrid || {};
  return dates
    .map((d) => {
      const ds = dateStr(d);
      const doneMap = grid[chore.id]?.[ds] || {};
      const due = choreIsDueOn(chore, d.getDay()) && !isAway(ds);
      const parts = [];
      if (isPerKid(chore)) {
        for (const kid of state.kids) {
          if (doneMap[kid.id]) parts.push(avatarHtml(kid, { state: 'done', completion: doneMap[kid.id] }));
          else if (due) parts.push(avatarHtml(kid, { state: timeState(ds, today), date: ds, choreId: chore.id }));
        }
      } else {
        const done = Object.values(doneMap);
        for (const c of done) parts.push(avatarHtml(state.kids.find((k) => k.id === c.kidId) || {}, { state: 'done', completion: c }));
        if (due && !done.length) parts.push(sharedSlotHtml(timeState(ds, today), chore.id, ds));
      }
      return cellHtml(parts);
    })
    .join('');
}

// A due_by row: each kid's avatar lands on the day they actually did it. Kids still
// to go sit in today's column (amber once the deadline has passed); for other
// weeks they sit on the deadline — red if that week is over, inert if it's ahead.
function dueByCellsHtml(chore, dates, today) {
  const deadline = deadlineDate(chore, dates);
  const done = doneThisWeek(chore, state.weekGrid);
  const dateStrs = dates.map(dateStr);
  const slotDs = dateStrs.includes(today) ? today : deadline;
  const slotState = slotDs === today ? (today > deadline ? 'late' : 'todo') : slotDs < today ? 'missed' : 'future';
  const weekAway = dateStrs.every(isAway); // a whole away stretch: nothing owed
  const showSlots = !weekAway && !isAway(slotDs);
  return dateStrs
    .map((ds) => {
      const parts = [];
      for (const kid of state.kids) {
        const d = done.get(kid.id);
        if (d?.date === ds) parts.push(avatarHtml(kid, { state: 'done', completion: d.completion, late: ds > deadline }));
        else if (!d && ds === slotDs && showSlots) parts.push(avatarHtml(kid, { state: slotState, date: ds, choreId: chore.id }));
      }
      if (ds === deadline && !weekAway) parts.push('<span class="due-tag">due</span>');
      return cellHtml(parts);
    })
    .join('');
}

const cellHtml = (parts) =>
  parts.length ? `<td class="chore-cell"><div class="cell-avs">${parts.join('')}</div></td>` : '<td class="chore-cell"></td>';

function loadWeek() {
  const dates = weekDates(state.weekOffset);
  const today = dateStr(new Date());

  $('#chartHead').innerHTML = `<tr><th class="chore-title-head">Chore</th>${dates
    .map(
      (d) => `<th class="text-center ${dateStr(d) === today ? 'today-col' : ''}${isAway(dateStr(d)) ? ' away-col' : ''}">
        ${DAY_NAMES[d.getDay()]}
        <div class="day-num">${isAway(dateStr(d)) ? 'away' : d.getDate()}</div>
      </th>`
    )
    .join('')}</tr>`;

  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const rel =
    state.weekOffset === 0
      ? 'This week'
      : state.weekOffset === -1
        ? 'Last week'
        : state.weekOffset === 1
          ? 'Next week'
          : state.weekOffset < 0
            ? `${-state.weekOffset} weeks ago`
            : `In ${state.weekOffset} weeks`;
  $('#weekLabel').innerHTML = `${rel} <span class="week-range">${fmt(dates[0])} – ${fmt(dates[6])}</span>`;
  $('#btnToday').disabled = state.weekOffset === 0;
  $('#btnPrevWeek').disabled = state.weekOffset <= -26;
  $('#btnNextWeek').disabled = state.weekOffset >= 26;

  // Rows — paused chores stay visible in Settings for editing, but never show up
  // on the family's chart. Grouped: each-kid chores, then shared.
  const body = $('#chartBody');
  const activeChores = state.chores.filter((c) => c.active);
  if (!activeChores.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty-state"><i class="bi bi-clipboard2-x"></i>No chores yet — add some in Settings.</td></tr>`;
    return;
  }
  if (!state.kids.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty-state"><i class="bi bi-people"></i>Add a kid first (Settings → Kids), then check off chores.</td></tr>`;
    return;
  }
  const row = (chore) => `<tr>
      <td class="chore-title-cell" title="${esc(scheduleText(chore))}">
        <div class="chore-name">${esc(chore.title)}</div>
        <div class="chore-meta">${scopeIcon(chore)}<span class="chore-pts">${ptsLabel(chore.points)}</span></div>
      </td>
      ${chore.frequency === 'due_by' ? dueByCellsHtml(chore, dates, today) : choreCellsHtml(chore, dates, today)}
    </tr>`;
  const groups = [
    ['<i class="bi bi-person-fill"></i> Each kid', activeChores.filter(isPerKid)],
    ['<i class="bi bi-people-fill"></i> Shared — anyone can do it', activeChores.filter((c) => !isPerKid(c) && c.frequency !== 'anytime')],
    ['<i class="bi bi-stars"></i> Bonus jobs — any time', activeChores.filter((c) => c.frequency === 'anytime')],
  ].filter(([, list]) => list.length);
  body.innerHTML = groups
    .map(([label, list]) => `<tr class="group-row"><th colspan="8"><span class="group-label">${label}</span></th></tr>${list.map(row).join('')}`)
    .join('');

  // Gray out away days, column by column; +1 skips the title cell.
  dates.forEach((d, i) => {
    if (isAway(dateStr(d))) body.querySelectorAll('tr:not(.group-row)').forEach((tr) => tr.children[i + 1]?.classList.add('away-col'));
  });

  // Tint today's column in the body too.
  const todayIdx = dates.findIndex((d) => dateStr(d) === today);
  if (todayIdx >= 0) {
    body.querySelectorAll('tr:not(.group-row)').forEach((tr) => tr.children[todayIdx + 1]?.classList.add('today-col'));
    // On a phone the days scroll sideways: bring today into view, just right of the sticky titles.
    const scroller = body.closest('.table-responsive');
    const th = $('#chartHead th.today-col');
    const titleW = $('#chartHead th.chore-title-head').offsetWidth;
    if (scroller.scrollWidth > scroller.clientWidth) scroller.scrollLeft = Math.max(0, th.offsetLeft - titleW - th.offsetWidth);
  }
}

async function refreshWeek() {
  // Settings first: week start and custody can change from another device, and
  // the week dates below depend on them.
  state.settings = await api('/api/settings');
  // Ask for weeks by this device's own start date — the server clock may be UTC.
  const weekUrl = (offset) => '/api/week?start=' + dateStr(weekDates(offset)[0]);
  const reqs = [api(weekUrl(state.weekOffset)), api('/api/totals')];
  if (state.weekOffset !== 0) reqs.push(api(weekUrl(0)));
  const [data, totals, current] = await Promise.all(reqs);
  state.kids = data.kids;
  state.chores = data.chores;
  state.kidTotals = totals;
  // grid is already { choreId: { date: { kidId: completion } } }
  state.weekGrid = data.grid;
  state.currentGrid = (current || data).grid; // the Today board always shows this week
  state.currentDates = (current || data).week.map((w) => w.date);
  renderChart();
  if (!$('#set-schedule').contains(document.activeElement)) {
    $('#weekStartDay').value = String(state.settings.weekStartDay ?? 1);
    renderCustodySettings();
  }
  loadKidsTab();
  loadChoresTab();
  applyRoleUI(); // re-apply after re-render (chart buttons depend on role)
}

// The grid a date belongs to: the Today board's current week, or the week on screen.
const gridForDate = (date) => (state.currentDates?.includes(date) ? state.currentGrid : state.weekGrid) || {};

async function completeChore(choreId, kidIds, date) {
  const ids = [].concat(kidIds);
  try {
    const done = await api('/api/completions', { method: 'POST', body: { choreId, kidIds: ids, date } });
    const who = done.completions.map((c) => state.kids.find((k) => k.id === c.kidId)).filter(Boolean);
    toast(
      who.length > 1
        ? `🤝 ${who.map((k) => k.name).join(' & ')} teamed up — ${ptsLabel(done.completions[0].points)} each!`
        : `${who[0]?.emoji || '🎉'} ${who[0]?.name || 'Someone'} got ${ptsLabel(done.points)}!`
    );
    await refreshWeek();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

// Who did a shared chore: tap one kid, or several to credit a team (the points
// split). A signed-in kid is always on the team; they can add siblings who helped.
async function openCellPicker(choreId, date) {
  const chore = state.chores.find((c) => c.id === Number(choreId));
  if (!chore) return;
  const mine = myKidId();
  pickCtx = { choreId: chore.id, date, points: chore.points, picked: new Set(mine === null ? [] : [mine]) };
  const day = DAYS_FULL[new Date(date + 'T00:00:00').getDay()];
  $('#cellModalTitle').textContent = `Who did “${chore.title}”? — ${day}`;
  if (!state.kids.length) {
    $('#cellModalBody').innerHTML =
      '<div class="empty-state"><i class="bi bi-people"></i>Add a kid first (Settings → Kids), then check off chores.</div>';
  } else {
    $('#cellModalBody').innerHTML = `<div class="vstack gap-2">${state.kids
      .map(
        (k) => `<button class="pick-kid-btn" style="--kid-color:${esc(k.color)}" data-kid="${k.id}"${k.id === mine ? ' data-locked' : ''}>
            <span class="kid-avatar" style="background:${esc(k.color)}">${esc(k.emoji)}</span>
            <span>${esc(k.name)}</span>
            <i class="bi bi-check-circle-fill pick-check ms-auto"></i>
          </button>`
      )
      .join('')}
      <button class="btn btn-primary mt-1" id="pickConfirm" disabled></button>
      <div class="form-text text-center">Pick everyone who helped — teams split the points.</div>
    </div>`;
    renderPickState();
  }
  bootstrap.Modal.getOrCreateInstance('#cellModal').show();
}

function renderPickState() {
  const n = pickCtx.picked.size;
  document.querySelectorAll('#cellModalBody [data-kid]').forEach((b) => b.classList.toggle('picked', pickCtx.picked.has(Number(b.dataset.kid))));
  const btn = $('#pickConfirm');
  btn.disabled = n === 0;
  const each = n ? Math.floor(pickCtx.points / n) : 0;
  btn.textContent = n === 0 ? 'Pick who did it' : n === 1 ? `Done — ${ptsLabel(pickCtx.points)}` : `Done together — ${n > 1 && pickCtx.points % n ? '~' : ''}${ptsLabel(each)} each`;
}

// Context for the cell being picked (chore + date)
let pickCtx = null;

/* ============================ Reward ideas ============================ */

let ideas = [];

async function refreshIdeas() {
  try { ideas = await api('/api/suggestions'); } catch { ideas = []; }
  renderIdeas();
}

function renderIdeas() {
  const admin = isAdmin();
  const mine = myKidId();
  const pending = ideas.filter((i) => i.status === 'pending');

  // Parents: a count on the Rewards tab while ideas wait.
  const badge = $('#ideasBadge');
  badge.textContent = pending.length;
  badge.classList.toggle('d-none', !admin || !pending.length);

  // Kids (or anyone, when the app has no PINs) can suggest.
  const canSuggest = mine !== null || !state.authRequired;
  $('#suggestCard').classList.toggle('d-none', !canSuggest);
  const kidSel = $('#suggestKid');
  kidSel.classList.toggle('d-none', mine !== null);
  if (mine === null) {
    const keep = kidSel.value;
    kidSel.innerHTML = '<option value="">Whose idea?</option>' +
      state.kids.map((k) => `<option value="${k.id}">${esc(k.emoji)} ${esc(k.name)}</option>`).join('');
    kidSel.value = keep;
  }
  const status = (i) =>
    i.status === 'pending'
      ? '<span class="badge text-bg-secondary">waiting</span>'
      : i.status === 'approved'
        ? `<span class="badge text-bg-success">on the menu! ${ptsLabel(i.points)}</span>`
        : '<span class="badge text-bg-light">not this time</span>';
  const own = mine === null ? [] : ideas;
  $('#myIdeas').innerHTML = own.length
    ? `<div class="idea-mine-head">Your ideas</div>${own
        .map((i) => `<div class="idea-mine">
            <div class="d-flex align-items-center gap-2"><span class="flex-grow-1 fw-bold">${esc(i.label)}</span>${status(i)}</div>
            ${i.response ? `<div class="idea-response"><i class="bi bi-chat-left-quote me-1"></i>${esc(i.response)}</div>` : ''}
          </div>`)
        .join('')}`
    : '';

  // Parents: the queue, then a few recent decisions.
  $('#ideasCard').classList.toggle('d-none', !admin || !ideas.length);
  if (!admin) return;
  const decided = ideas.filter((i) => i.status !== 'pending').slice(0, 5);
  $('#ideasList').innerHTML =
    (pending.length
      ? pending
          .map((i) => `<div class="idea-item" style="--kid-color:${esc(i.kidColor)}">
              <div class="idea-label">${esc(i.label)}</div>
              <div class="idea-meta">${esc(i.kidEmoji)} ${esc(i.kidName)}${i.points ? ` · thinks it’s worth ${ptsLabel(i.points)}` : ''}${i.note ? ` · “${esc(i.note)}”` : ''}</div>
              <div class="idea-actions">
                <div class="input-group input-group-sm idea-price">
                  <input type="number" min="1" max="99999" class="form-control" id="idea-pts-${i.id}" value="${i.points || ''}" placeholder="Price">
                  <span class="input-group-text">pts</span>
                </div>
                <input class="form-control form-control-sm idea-note" id="idea-note-${i.id}" maxlength="200" placeholder="Note to ${esc(i.kidName)} (optional)">
                <button class="btn btn-sm btn-primary" data-approve="${i.id}"><i class="bi bi-plus-lg me-1"></i>Add to menu</button>
                <button class="btn btn-sm btn-outline-secondary" data-decline="${i.id}">Not this time</button>
              </div>
            </div>`)
          .join('')
      : '<div class="text-muted small">No ideas waiting.</div>') +
    (decided.length
      ? `<div class="idea-mine-head mt-2">Recently decided</div>${decided
          .map((i) => `<div class="idea-decided">${status(i)} <strong>${esc(i.label)}</strong> <span class="text-muted">— ${esc(i.kidName)}</span></div>`)
          .join('')}`
      : '');
}

/* ============================ Activity ledger ============================ */

let activityRows = [];

const atDate = (at) => new Date(at.replace(' ', 'T') + 'Z'); // ledger times are UTC

async function loadActivity() {
  const kidSel = $('#actKid');
  const picked = kidSel.value;
  kidSel.innerHTML = '<option value="">All kids</option>' +
    state.kids.map((k) => `<option value="${k.id}">${esc(k.emoji)} ${esc(k.name)}</option>`).join('');
  kidSel.value = picked;
  const q = new URLSearchParams({ days: $('#actDays').value, kidId: kidSel.value, action: $('#actType').value });
  try {
    activityRows = await api('/api/activity?' + q);
  } catch (err) {
    $('#actList').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
    return;
  }
  renderActivitySummary();
  renderActivityList();
}

function renderActivitySummary() {
  const byKid = new Map();
  for (const r of activityRows) {
    const t = byKid.get(r.kidName) || { earned: 0, undone: 0, spent: 0, filled: 0 };
    if (r.action === 'done') t.earned += r.points;
    if (r.action === 'undo') t.undone -= r.points;
    if (r.action === 'redeem') t.spent -= r.points;
    if (r.action === 'done' && r.forDate && r.forDate !== dateStr(atDate(r.at))) t.filled++;
    byKid.set(r.kidName, t);
  }
  $('#actSummary').innerHTML = [...byKid]
    .map(([name, t]) => {
      const kid = state.kids.find((k) => k.name === name);
      return `<div class="col-6 col-md-4 col-xl-3"><div class="act-sum" style="--kid-color:${esc(kid?.color || '#9ca3af')}">
          <div class="act-sum-name">${esc(kid?.emoji || '')} ${esc(name || '?')}</div>
          <div class="act-sum-line"><span>Earned</span><strong class="text-success">+${t.earned}</strong></div>
          <div class="act-sum-line"><span>Undone</span><strong>${t.undone ? '−' + t.undone : 0}</strong></div>
          <div class="act-sum-line"><span>Spent</span><strong class="text-danger">${t.spent ? '−' + t.spent : 0}</strong></div>
          ${t.filled ? `<div class="act-sum-line"><span>Logged on another day</span><strong>${t.filled}</strong></div>` : ''}
        </div></div>`;
    })
    .join('');
}

function activityWho(r) {
  if (r.actor === 'parent') return 'logged by a parent';
  if (r.actor === 'kid') return `logged by ${r.actorName || 'a kid'}`;
  if (r.actor === 'open') return 'logged with no sign-in';
  return 'from before the ledger';
}

function renderActivityList() {
  const list = $('#actList');
  if (!activityRows.length) {
    list.innerHTML = '<div class="empty-state"><i class="bi bi-journal"></i>Nothing in this range.</div>';
    return;
  }
  const today = dateStr(new Date());
  const yesterday = dateStr(new Date(Date.now() - 86400000));
  let lastDay = null;
  const html = [];
  for (const r of activityRows) {
    const when = atDate(r.at);
    const day = dateStr(when);
    if (day !== lastDay) {
      lastDay = day;
      html.push(`<div class="act-day">${day === today ? 'Today' : day === yesterday ? 'Yesterday' : esc(fmtDay(day))}</div>`);
    }
    const kid = state.kids.find((k) => k.id === r.kidId);
    const icon = { done: 'check-circle-fill text-success', undo: 'arrow-counterclockwise act-undo-icon', redeem: 'gift-fill text-danger' }[r.action];
    const verb = { done: '', undo: 'Undid ', redeem: 'Redeemed ' }[r.action];
    const tags = [];
    // Logged on a different day than it counts for: late (filled in) or ahead of time.
    if (r.forDate && r.forDate !== day && r.action === 'done') {
      tags.push(`<span class="act-tag warn">${r.forDate < day ? 'filled in' : 'early'} · for ${esc(fmtDay(r.forDate))}</span>`);
    } else if (r.forDate && r.forDate !== day) {
      tags.push(`<span class="act-tag">for ${esc(fmtDay(r.forDate))}</span>`);
    }
    if (r.note) tags.push(`<span class="act-tag">${esc(r.note)}</span>`);
    html.push(`<div class="act-row act-${r.action}">
        <span class="act-time">${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
        <i class="bi bi-${icon} act-icon"></i>
        <div class="act-main">
          <div><span class="who-dot" style="background:${esc(kid?.color || '#9ca3af')}"></span><strong>${esc(r.kidName || '?')}</strong> · ${verb}${esc(r.subject || '')}</div>
          <div class="act-meta">${esc(activityWho(r))}${tags.length ? ' ' + tags.join(' ') : ''}</div>
        </div>
        <span class="act-pts ${r.points >= 0 ? 'plus' : 'minus'}">${r.points >= 0 ? '+' : '−'}${Math.abs(r.points)}</span>
      </div>`);
  }
  if (activityRows.length === 2000) html.push('<div class="act-day">Showing the newest 2000 — narrow the range to see more</div>');
  list.innerHTML = html.join('');
}

function downloadActivityCsv() {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['when', 'action', 'kid', 'item', 'points', 'counts for', 'logged by', 'note'].map(cell).join(',')];
  for (const r of activityRows) {
    const w = atDate(r.at);
    lines.push([`${dateStr(w)} ${w.toTimeString().slice(0, 5)}`, r.action, r.kidName, r.subject, r.points, r.forDate, activityWho(r), r.note].map(cell).join(','));
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `kiddodash-activity-${dateStr(new Date())}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ============================ Custody settings ============================ */

function renderCustodySettings() {
  const c = state.settings?.custody || { enabled: false, homeStart: null, exceptions: {} };
  $('#custodyEnabled').checked = !!c.enabled;
  $('#custodyHomeStart').value = c.homeStart || '';
  const today = dateStr(new Date());
  const status = $('#custodyStatus');
  if (c.enabled) {
    const away = isAway(today);
    const next = nextSwitch(today, !away);
    status.innerHTML = `<i class="bi bi-${away ? 'house-dash' : 'house-check'} me-1"></i>Now: <strong>${away ? 'away' : 'home'}</strong>${
      next ? ` · ${away ? 'back' : 'leaving'} ${esc(fmtDay(next))}` : ''}`;
  } else {
    status.textContent = 'Off — every day counts as a home day.';
  }
  const rows = Object.entries(c.exceptions || {}).sort(([a], [b]) => a.localeCompare(b));
  $('#custodyExceptions').innerHTML = rows.length
    ? rows
        .map(([d, v]) => `<li class="list-group-item d-flex align-items-center gap-2 px-0">
            <span class="badge ${v === 'home' ? 'text-bg-success' : 'text-bg-secondary'}">${v}</span>
            <span class="flex-grow-1">${esc(fmtDay(d))}${d < today ? ' <span class="text-muted small">(past)</span>' : ''}</span>
            <button class="btn btn-sm btn-outline-danger" data-del-exception="${d}" title="Remove"><i class="bi bi-x-lg"></i></button>
          </li>`)
        .join('')
    : '<li class="list-group-item px-0 text-muted small">No exceptions.</li>';
}

/* ============================ Kids tab ============================ */

function loadKidsTab() {
  const list = $('#kidsList');
  if (!state.kids.length) {
    list.innerHTML = '<li class="list-group-item empty-state"><i class="bi bi-people"></i>No kids yet.</li>';
    return;
  }
  list.innerHTML = state.kids
    .map((k) => {
      const t = state.kidTotals.find((x) => x.id === k.id);
      const spent = t ? t.spent : 0;
      const pts = t ? t.balance : k.points || 0;
      return `<li class="list-group-item">
        <div class="d-flex align-items-center gap-3">
          <span class="kid-avatar" style="background:${esc(k.color)}">${esc(k.emoji)}</span>
          <div class="flex-grow-1">
            <div class="fw-bold">${esc(k.name)}</div>
            <div class="kid-row-meta">
              <span class="kid-points-badge text-primary">${pts} pts</span>
              ${spent ? `<span class="text-muted small" title="${spent} points spent on rewards">${spent} spent</span>` : ''}
              <span class="badge ${k.hasPin ? 'text-bg-success' : 'text-bg-light'}" title="${k.hasPin ? 'Can sign in with their own PIN' : 'No PIN — can’t sign in on their own'}">
                <i class="bi bi-key me-1"></i>${k.hasPin ? 'PIN set' : 'no PIN'}
              </span>
            </div>
          </div>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-secondary" data-editkid="${k.id}" title="Edit"><i class="bi bi-pencil"></i></button>
            <button class="btn btn-outline-danger" data-delkid="${k.id}" title="Remove"><i class="bi bi-trash"></i></button>
          </div>
        </div>
      </li>`;
    })
    .join('');
}

/* ============================ Access tab ============================ */


/* ============================ Chores tab ============================ */

function loadChoresTab() {
  const list = $('#choresList');
  if (!state.chores.length) {
    list.innerHTML = '<li class="list-group-item empty-state"><i class="bi bi-list-check"></i>No chores yet.</li>';
    return;
  }
  list.innerHTML = state.chores
    .map(
      (c) => `<li class="list-group-item">
        <div class="chore-row">
          <div class="form-check form-switch m-0" title="${c.active ? 'Chore is active' : 'Chore is paused'}">
            <input class="form-check-input" type="checkbox" data-togglechores="${c.id}" ${c.active ? 'checked' : ''}>
          </div>
          <div class="chore-row-text">
            <div class="fw-bold ${c.active ? '' : 'text-muted'}">${esc(c.title)}</div>
            <div class="chore-row-meta">
              <span class="chore-pts">${ptsLabel(c.points)}</span>
              ${freqBadgeHtml(c)}
              ${c.active ? '' : '<span class="badge text-bg-light">paused</span>'}
            </div>
          </div>
          <div class="chore-row-actions">
            <button class="btn btn-sm btn-outline-secondary" data-editchore="${c.id}" title="Edit"><i class="bi bi-pencil"></i></button>
            <button class="btn btn-sm btn-outline-danger" data-delchore="${c.id}" title="Delete"><i class="bi bi-trash"></i></button>
          </div>
        </div>
      </li>`
    )
    .join('');
}

/* ============================ Rewards tab ============================ */

function loadRewardsTab() {
  const s = state.settings;
  if (!s) return;
  const list = $('#rewardsList');
  if (!s.rewards.length) {
    list.innerHTML = `<div class="empty-state"><i class="bi bi-trophy"></i>No rewards yet${isAdmin() ? ' — add one!' : '.'}</div>`;
    return;
  }
  const mine = myKidId();
  const kids = mine === null ? state.kidTotals : state.kidTotals.filter((t) => t.id === mine);
  const canRedeem = isAdmin() || mine !== null;
  list.innerHTML = [...s.rewards]
    .sort((a, b) => a.points - b.points)
    .map((r) => {
      // One button per kid: redeem if they can afford it, otherwise how far off they are.
      const kidBtns = canRedeem
        ? kids
            .map((t) => {
              const short = r.points - t.balance;
              return short <= 0
                ? `<button class="btn btn-sm btn-primary reward-kid" data-redeem="${r.id}" data-kid="${t.id}">
                    ${esc(t.emoji)} ${esc(t.name)} <i class="bi bi-check-lg ms-1"></i>
                  </button>`
                : `<span class="reward-kid reward-short" title="${esc(t.name)} has ${t.balance} pts">
                    ${esc(t.emoji)} ${esc(t.name)} · ${short} more
                  </span>`;
            })
            .join('')
        : '';
      const adminBtns = isAdmin()
        ? `<button class="btn btn-sm btn-outline-secondary" data-editreward="${r.id}" title="Edit"><i class="bi bi-pencil"></i></button>
           <button class="btn btn-sm btn-outline-danger" data-delreward="${r.id}" title="Delete"><i class="bi bi-trash"></i></button>`
        : '';
      return `<div class="reward-item">
          <div class="reward-head">
            <i class="bi bi-gift reward-icon"></i>
            <span class="reward-label">${esc(r.label)}</span>
            <span class="badge text-bg-warning reward-cost">${ptsLabel(r.points)}</span>
            ${adminBtns ? `<span class="reward-admin">${adminBtns}</span>` : ''}
          </div>
          ${kidBtns ? `<div class="reward-kids">${kidBtns}</div>` : ''}
        </div>`;
    })
    .join('');
}

function renderBalances() {
  const list = $('#balancesList');
  if (!list) return;
  if (!state.kidTotals.length) {
    list.innerHTML = '<li class="list-group-item empty-state"><i class="bi bi-people"></i>No kids yet.</li>';
    return;
  }
  list.innerHTML = state.kidTotals
    .map((t) => {
      return `<li class="list-group-item">
        <div class="d-flex align-items-center gap-3">
          <span class="kid-avatar" style="background:${esc(t.color)};width:34px;height:34px;font-size:1.05rem">${esc(t.emoji)}</span>
          <div class="flex-grow-1">
            <div class="d-flex justify-content-between align-items-baseline">
              <span class="fw-bold">${esc(t.name)}</span>
              <span class="kid-points-badge text-primary">${t.balance} pts</span>
            </div>
          </div>
        </div>
      </li>`;
    })
    .join('');
}

function renderRecentSpends() {
  const list = $('#recentSpends');
  if (!list) return;
  if (!state.recentSpends?.length) {
    list.innerHTML = '<li class="list-group-item empty-state"><i class="bi bi-receipt"></i>No spends yet.</li>';
    return;
  }
  list.innerHTML = state.recentSpends
    .map(
      (r) => `<li class="list-group-item d-flex align-items-center gap-2">
        <span class="kid-avatar" style="background:${esc(r.kidColor)};width:28px;height:28px;font-size:0.9rem">${esc(r.kidEmoji)}</span>
        <div class="flex-grow-1">
          <div class="fw-bold">${esc(r.rewardLabel)}</div>
          <div class="text-muted small">${esc(r.kidName)} · ${new Date(r.createdAt.replace(' ', 'T') + 'Z').toLocaleDateString()}</div>
        </div>
        <span class="badge text-bg-warning">−${r.points}</span>
      </li>`
    )
    .join('');
}

async function refreshRewards() {
  const [totals, spends] = await Promise.all([
    api('/api/totals'),
    api('/api/redeemptions?limit=8'),
  ]);
  state.kidTotals = totals;
  state.recentSpends = spends;
  renderBalances();
  renderRecentSpends();
  loadRewardsTab(); // fresh balances; edit/delete buttons render per role
  applyRoleUI();
  await refreshIdeas();
  loadKidsTab(); // kid cards now show balance, not lifetime earned
}

/* ============================ Events ============================ */

document.addEventListener('DOMContentLoaded', () => {
  // Week navigation
  $('#btnPrevWeek').addEventListener('click', () => { state.weekOffset = Math.max(-26, state.weekOffset - 1); refreshWeek(); });
  $('#btnNextWeek').addEventListener('click', () => { state.weekOffset = Math.min(26, state.weekOffset + 1); refreshWeek(); });
  $('#btnToday').addEventListener('click', () => { state.weekOffset = 0; refreshWeek(); });

  // Today / Week toggle
  $('#viewToday').addEventListener('change', () => setChartView('today'));
  $('#viewWeek').addEventListener('change', () => setChartView('week'));

  // Chart clicks, both views (delegated): undo a check, check off for a known
  // kid directly, or open the kid picker for a shared chore.
  $('#pane-chart').addEventListener('click', async (e) => {
    const undo = e.target.closest('[data-undo]');
    if (undo) {
      const ok = await confirmDialog(`Undo ${undo.dataset.undoLabel || 'this check'}?`, { ok: 'Undo', danger: false });
      if (ok) {
        try {
          for (const id of undo.dataset.undo.split(',')) await api('/api/completions/' + id, { method: 'DELETE' });
          toast('Undone', 'secondary');
          await refreshWeek();
        } catch (err) { toast(err.message, 'danger'); }
      }
      return;
    }
    const direct = e.target.closest('[data-complete]');
    if (direct) {
      direct.disabled = true; // no double-taps while the request is in flight
      return completeChore(Number(direct.dataset.chore), [Number(direct.dataset.kid)], direct.dataset.date);
    }
    const cell = e.target.closest('[data-chore]');
    if (cell) openCellPicker(cell.dataset.chore, cell.dataset.date);
  });

  // Kid picker modal
  $('#cellModalBody').addEventListener('click', async (e) => {
    if (!pickCtx) return;
    if (e.target.closest('#pickConfirm')) {
      bootstrap.Modal.getInstance('#cellModal')?.hide();
      return completeChore(pickCtx.choreId, [...pickCtx.picked], pickCtx.date);
    }
    const btn = e.target.closest('[data-kid]');
    if (!btn || btn.hasAttribute('data-locked')) return;
    const id = Number(btn.dataset.kid);
    pickCtx.picked.has(id) ? pickCtx.picked.delete(id) : pickCtx.picked.add(id);
    renderPickState();
  });

  // Kids form
  $('#kidForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const kid = await api('/api/kids', {
        method: 'POST',
        body: {
          name: $('#kidName').value.trim(),
          color: $('#kidColor').value,
          emoji: $('#kidEmoji').value.trim() || '🙂',
          pin: $('#kidPin').value.trim() || undefined,
        },
      });
      toast(`${kid.emoji} ${kid.name} added!`);
      $('#kidName').value = '';
      $('#kidPin').value = '';
      $('#kidFormWrap').classList.add('d-none');
      await refreshAuth();
      await refreshWeek();
    } catch (err) {
      toast(err.message, 'danger');
    }
  });

  // Settings: jump links scroll to a section and track the one in view
  $('.settings-jump').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-jump]');
    if (btn) document.getElementById(btn.dataset.jump).scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const jumpSpy = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) markJump(en.target.id);
      }
    },
    { rootMargin: '-45% 0px -50% 0px' } // "in view" = crossing the middle of the screen
  );
  document.querySelectorAll('#pane-settings .settings-section').forEach((sec) => jumpSpy.observe(sec));
  // The last section can't reach mid-screen on a tall display: at the bottom, it wins.
  const markJump = (id) =>
    document.querySelectorAll('.settings-jump [data-jump]').forEach((b) => b.classList.toggle('active', b.dataset.jump === id));
  window.addEventListener('scroll', () => {
    if (!$('#pane-settings').classList.contains('active')) return;
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) markJump('set-family');
  }, { passive: true });

  $('#btnShowKidForm').addEventListener('click', () => {
    const wrap = $('#kidFormWrap');
    wrap.classList.toggle('d-none');
    if (!wrap.classList.contains('d-none')) $('#kidName').focus();
  });

  // Kids list actions (delegated)
  $('#kidsList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-delkid]');
    if (del) {
      const kid = state.kids.find((k) => k.id === Number(del.dataset.delkid));
      const ok = await confirmDialog(`Remove ${kid?.name}? Their completed chores and points will also be removed.`, { ok: 'Remove' });
      if (ok) {
        try {
          await api('/api/kids/' + del.dataset.delkid, { method: 'DELETE' });
          toast('Removed', 'secondary');
          await refreshWeek();
        } catch (err) { toast(err.message, 'danger'); }
      }
      return;
    }
    const edit = e.target.closest('[data-editkid]');
    if (edit) openKidEditModal(Number(edit.dataset.editkid));
  });

  // Chores form
  renderChoreDaysPicker($('#choreDaysRow'), 'choreDay', $('#choreFreq').value, []);
  $('#choreFreq').addEventListener('change', (e) => {
    const kept = readChoreDaysPicker($('#choreDaysRow'));
    renderChoreDaysPicker($('#choreDaysRow'), 'choreDay', e.target.value, kept);
  });
  $('#choreForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/chores', {
        method: 'POST',
        body: {
          title: $('#choreTitle').value.trim(),
          frequency: $('#choreFreq').value,
          days: readChoreDaysPicker($('#choreDaysRow')),
          cooldownDays: readCooldown($('#choreDaysRow')),
          points: Number($('#chorePoints').value) || 1,
        },
      });
      toast('Chore added');
      $('#choreTitle').value = '';
      await refreshWeek();
    } catch (err) { toast(err.message, 'danger'); }
  });

  // Chores list actions
  $('#choresList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-delchore]');
    if (del) {
      const chore = state.chores.find((c) => c.id === Number(del.dataset.delchore));
      const ok = await confirmDialog(`Delete “${chore?.title}”? Its history will be removed too.`);
      if (ok) {
        try {
          await api('/api/chores/' + del.dataset.delchore, { method: 'DELETE' });
          toast('Chore deleted', 'secondary');
          await refreshWeek();
        } catch (err) { toast(err.message, 'danger'); }
      }
      return;
    }
    const edit = e.target.closest('[data-editchore]');
    if (edit) openChoreEditModal(Number(edit.dataset.editchore));
  });

  $('#choresList').addEventListener('change', async (e) => {
    const toggle = e.target.closest('[data-togglechores]');
    if (toggle) {
      try {
        await api('/api/chores/' + toggle.dataset.togglechores, { method: 'PUT', body: { active: toggle.checked } });
        await refreshWeek();
      } catch (err) { toast(err.message, 'danger'); }
    }
  });

  // ---- Edit chore modal ----
  let choreEditCtx = null;
  const choreEditModal = () => bootstrap.Modal.getOrCreateInstance('#choreEditModal');

  function openChoreEditModal(choreId) {
    const chore = state.chores.find((c) => c.id === choreId);
    if (!chore) return;
    choreEditCtx = chore;
    $('#choreEditTitle').value = chore.title;
    $('#choreEditPoints').value = chore.points;
    $('#choreEditFreq').value = chore.frequency;
    renderChoreDaysPicker($('#choreEditDaysRow'), 'choreEditDay', chore.frequency, chore.days || [], chore.cooldownDays || 7);
    choreEditModal().show();
  }

  $('#choreEditFreq').addEventListener('change', (e) => {
    const kept = readChoreDaysPicker($('#choreEditDaysRow'));
    renderChoreDaysPicker($('#choreEditDaysRow'), 'choreEditDay', e.target.value, kept);
  });

  $('#choreEditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!choreEditCtx) return;
    const title = $('#choreEditTitle').value.trim();
    if (!title) return toast('Title cannot be empty', 'warning');
    try {
      await api(`/api/chores/${choreEditCtx.id}`, {
        method: 'PUT',
        body: {
          title,
          frequency: $('#choreEditFreq').value,
          days: readChoreDaysPicker($('#choreEditDaysRow')),
          cooldownDays: readCooldown($('#choreEditDaysRow')),
          points: Number($('#choreEditPoints').value) || 1,
        },
      });
      choreEditModal().hide();
      toast('Chore saved');
      await refreshWeek();
    } catch (err) { toast(err.message, 'danger'); }
  });

  $('#choreEditDelete').addEventListener('click', async () => {
    if (!choreEditCtx) return;
    const chore = choreEditCtx;
    choreEditModal().hide();
    const ok = await confirmDialog(`Delete “${chore.title}”? Its history will be removed too.`);
    if (!ok) return;
    try {
      await api('/api/chores/' + chore.id, { method: 'DELETE' });
      toast('Chore deleted', 'secondary');
      await refreshWeek();
    } catch (err) { toast(err.message, 'danger'); }
  });

  // Rewards
  $('#btnAddReward').addEventListener('click', () => {
    $('#rewardId').value = '';
    $('#rewardLabel').value = '';
    $('#rewardPoints').value = '';
    $('#rewardModalTitle').textContent = 'Add reward';
    new bootstrap.Modal('#rewardModal').show();
  });

  $('#rewardsList').addEventListener('click', async (e) => {
    const redeem = e.target.closest('[data-redeem]');
    if (redeem) {
      const reward = state.settings.rewards.find((r) => r.id === Number(redeem.dataset.redeem));
      const kid = state.kidTotals.find((t) => t.id === Number(redeem.dataset.kid));
      if (!reward || !kid) return;
      const ok = await confirmDialog(
        `Spend ${ptsLabel(reward.points)} of ${kid.name}’s ${kid.balance} on “${reward.label}”?`,
        { ok: 'Redeem', danger: false }
      );
      if (!ok) return;
      try {
        const res = await api('/api/redeem', { method: 'POST', body: { kidId: kid.id, rewardId: reward.id } });
        toast(`${res.kidEmoji} ${res.kidName} redeemed “${res.rewardLabel}”! (${ptsLabel(res.balance)} left)`);
        await Promise.all([refreshRewards(), refreshWeek()]);
      } catch (err) {
        toast(err.message, 'danger');
      }
      return;
    }
    const del = e.target.closest('[data-delreward]');
    if (del) {
      const ok = await confirmDialog('Delete this reward?');
      if (ok) {
        try {
          const rewards = state.settings.rewards.filter((r) => r.id !== Number(del.dataset.delreward));
          state.settings = await api('/api/settings', { method: 'PUT', body: { rewards } });
          loadRewardsTab();
          toast('Reward deleted', 'secondary');
        } catch (err) { toast(err.message, 'danger'); }
      }
      return;
    }
    const edit = e.target.closest('[data-editreward]');
    if (edit) {
      const r = state.settings.rewards.find((x) => x.id === Number(edit.dataset.editreward));
      if (!r) return;
      $('#rewardId').value = r.id;
      $('#rewardLabel').value = r.label;
      $('#rewardPoints').value = r.points;
      $('#rewardModalTitle').textContent = 'Edit reward';
      new bootstrap.Modal('#rewardModal').show();
    }
  });

  // ---- General settings ----
  $('#weekStartDay').addEventListener('change', async (e) => {
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: { weekStartDay: Number(e.target.value) } });
      await refreshWeek();
      toast('Week start updated');
    } catch (err) { toast(err.message, 'danger'); }
  });

  // ---- Reward ideas ----
  $('#suggestForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const kidId = myKidId() ?? Number($('#suggestKid').value);
    if (!kidId) return toast('Pick whose idea it is', 'warning');
    try {
      await api('/api/suggestions', {
        method: 'POST',
        body: { kidId, label: $('#suggestLabel').value, points: $('#suggestPoints').value || undefined, note: $('#suggestNote').value },
      });
      ['#suggestLabel', '#suggestPoints', '#suggestNote'].forEach((sel) => ($(sel).value = ''));
      toast('💡 Idea sent! A parent will take a look.');
      await refreshIdeas();
    } catch (err) { toast(err.message, 'danger'); }
  });
  $('#ideasList').addEventListener('click', async (e) => {
    const approve = e.target.closest('[data-approve]');
    const decline = e.target.closest('[data-decline]');
    const id = (approve || decline)?.dataset.approve || (approve || decline)?.dataset.decline;
    if (!id) return;
    const response = $(`#idea-note-${id}`).value;
    try {
      if (approve) {
        const points = Number($(`#idea-pts-${id}`).value);
        if (!(points >= 1)) { $(`#idea-pts-${id}`).focus(); return toast('Set a price first', 'warning'); }
        const res = await api(`/api/suggestions/${id}`, { method: 'PUT', body: { status: 'approved', points, response } });
        toast(`🎁 “${res.reward.label}” is on the menu for ${ptsLabel(res.reward.points)}`);
        state.settings = await api('/api/settings');
        loadRewardsTab();
        applyRoleUI();
      } else {
        await api(`/api/suggestions/${id}`, { method: 'PUT', body: { status: 'declined', response } });
        toast('Marked “not this time”', 'secondary');
      }
      await refreshIdeas();
    } catch (err) { toast(err.message, 'danger'); }
  });

  // ---- Activity ledger ----
  ['#actKid', '#actDays', '#actType'].forEach((sel) => $(sel).addEventListener('change', loadActivity));
  $('#actCsv').addEventListener('click', downloadActivityCsv);

  // ---- Custody schedule ----
  const saveCustody = async (patch, msg) => {
    const current = state.settings.custody || { enabled: false, homeStart: null, exceptions: {} };
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: { custody: { ...current, ...patch } } });
      renderCustodySettings();
      await refreshWeek();
      if (msg) toast(msg);
    } catch (err) { toast(err.message, 'danger'); }
  };
  $('#custodyEnabled').addEventListener('change', (e) => {
    const homeStart = $('#custodyHomeStart').value || null;
    if (e.target.checked && !homeStart) {
      e.target.checked = false;
      $('#custodyHomeStart').focus();
      return toast('Pick a day they arrive first', 'warning');
    }
    saveCustody({ enabled: e.target.checked, homeStart }, e.target.checked ? 'Custody schedule on' : 'Custody schedule off');
  });
  $('#custodyHomeStart').addEventListener('change', (e) => {
    if (!e.target.value) return;
    saveCustody({ homeStart: e.target.value, enabled: $('#custodyEnabled').checked }, 'Schedule updated');
  });
  $('#custodyExceptionForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const date = $('#custodyExDate').value;
    if (!date) return;
    const exceptions = { ...(state.settings.custody?.exceptions || {}), [date]: $('#custodyExKind').value };
    $('#custodyExDate').value = '';
    saveCustody({ exceptions }, 'Exception added');
  });
  $('#custodyExceptions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-del-exception]');
    if (!btn) return;
    const exceptions = { ...(state.settings.custody?.exceptions || {}) };
    delete exceptions[btn.dataset.delException];
    saveCustody({ exceptions }, 'Exception removed');
  });

  $('#rewardForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#rewardId').value;
    const rewards = state.settings.rewards.slice();
    const label = $('#rewardLabel').value.trim();
    const points = Math.round(Number($('#rewardPoints').value));
    if (!label) return toast('Give the reward a name', 'warning');
    if (!(points >= 1)) return toast('Points must be at least 1', 'warning');
    if (id) {
      const i = rewards.findIndex((r) => r.id === Number(id));
      if (i >= 0) rewards[i] = { ...rewards[i], label, points };
    } else {
      rewards.push({ id: Date.now(), label, points });
    }
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: { rewards } });
      bootstrap.Modal.getInstance('#rewardModal')?.hide();
      loadRewardsTab();
      toast('Reward saved');
    } catch (err) { toast(err.message, 'danger'); }
  });

  // ---- Auth ----
  $('#loginPin').addEventListener('input', onPinChanged);

  let loggingIn = false;
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (loggingIn) return;
    const pin = $('#loginPin').value.trim();
    if (!pin) return;
    clearTimeout(pinAutoSubmitTimer);
    loggingIn = true;
    const err = $('#loginError');
    err.classList.add('d-none');
    try {
      await doLogin(pin);
    } catch (e2) {
      err.textContent = e2.message;
      err.classList.remove('d-none');
      $('#loginPin').value = '';
      $('#loginPin').focus();
      const card = $('#loginCard');
      card.classList.remove('shake');
      // restart the animation even if it's still mid-play from a prior error
      requestAnimationFrame(() => card.classList.add('shake'));
    } finally {
      loggingIn = false;
    }
  });
  $('#btnSignOut').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    authToken.clear();
    location.reload();
  });
  $('#btnMyPin').addEventListener('click', () => {
    $('#myPinCurrent').value = '';
    $('#myPinNew').value = '';
    $('#myPinError').classList.add('d-none');
    bootstrap.Modal.getOrCreateInstance('#myPinModal').show();
  });
  $('#myPinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#myPinError');
    err.classList.add('d-none');
    const currentPin = $('#myPinCurrent').value.trim();
    const pin = $('#myPinNew').value.trim();
    if (!/^\d{4}$/.test(pin)) {
      err.textContent = 'New PIN must be exactly 4 digits';
      return err.classList.remove('d-none');
    }
    try {
      await api(`/api/kids/${myKidId()}/pin`, { method: 'PUT', body: { currentPin, pin } });
      bootstrap.Modal.getInstance('#myPinModal')?.hide();
      toast('PIN updated');
    } catch (e2) {
      err.textContent = e2.message;
      err.classList.remove('d-none');
    }
  });
  $('#adminPinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = $('#adminPinInput').value.trim();
    if (!/^\d{4,8}$/.test(pin)) return toast('Admin PIN must be 4-8 digits', 'warning');
    try {
      await api('/api/auth/admin-pin', { method: 'PUT', body: { pin } });
      $('#adminPinInput').value = '';
      toast('Admin PIN updated');
      await refreshAuth(); // setting the first PIN turns sign-in on
    } catch (err) { toast(err.message, 'danger'); }
  });

  let kidEditCtx = null;
  const kidEditModal = () => bootstrap.Modal.getOrCreateInstance('#kidPinModal');

  function openKidEditModal(kidId) {
    const kid = state.kids.find((k) => k.id === kidId);
    if (!kid) return;
    kidEditCtx = kid;
    $('#kidPinModalTitle').textContent = `${kid.emoji} ${kid.name}`;
    $('#kidEditEmoji').value = kid.emoji;
    $('#kidEditName').value = kid.name;
    $('#kidEditColor').value = kid.color;
    $('#kidPinInput').value = '';
    $('#kidPinInput').placeholder = kid.hasPin ? 'New PIN (leave blank to keep)' : '4-digit PIN (optional)';
    $('#kidPinRemove').classList.toggle('d-none', !kid.hasPin);
    $('#kidEditPinHint').textContent = kid.hasPin
      ? 'A PIN is set for sign-in.'
      : 'No PIN set — this kid can’t sign in on their own yet.';
    kidEditModal().show();
  }


  $('#kidPinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!kidEditCtx) return;
    const name = $('#kidEditName').value.trim();
    if (!name) return toast('Name cannot be empty', 'warning');
    const emoji = $('#kidEditEmoji').value.trim() || kidEditCtx.emoji;
    const color = $('#kidEditColor').value;
    const pin = $('#kidPinInput').value.trim();
    if (pin && !/^\d{4}$/.test(pin)) return toast('Kid PIN must be exactly 4 digits', 'warning');
    try {
      await api(`/api/kids/${kidEditCtx.id}`, { method: 'PUT', body: { name, emoji, color } });
      if (pin) await api(`/api/kids/${kidEditCtx.id}/pin`, { method: 'PUT', body: { pin } });
      kidEditModal().hide();
      toast('Saved');
      await refreshAuth();
      await refreshWeek();
    } catch (err) { toast(err.message, 'danger'); }
  });

  $('#kidPinRemove').addEventListener('click', async () => {
    if (!kidEditCtx) return;
    try {
      await api(`/api/kids/${kidEditCtx.id}/pin`, { method: 'PUT', body: { pin: null } });
      kidEditCtx.hasPin = false;
      $('#kidPinInput').value = '';
      $('#kidPinInput').placeholder = '4-digit PIN (optional)';
      $('#kidPinRemove').classList.add('d-none');
      $('#kidEditPinHint').textContent = 'No PIN set — this kid can’t sign in on their own yet.';
      toast(`${kidEditCtx.name}'s PIN removed`, 'secondary');
      await refreshAuth();
      await refreshWeek();
    } catch (err) { toast(err.message, 'danger'); }
  });

  $('#kidEditDelete').addEventListener('click', async () => {
    if (!kidEditCtx) return;
    const kid = kidEditCtx;
    kidEditModal().hide();
    const ok = await confirmDialog(`Remove ${kid.name}? Their completed chores and points will also be removed.`, { ok: 'Remove' });
    if (!ok) return;
    try {
      await api('/api/kids/' + kid.id, { method: 'DELETE' });
      toast('Removed', 'secondary');
      await refreshWeek();
    } catch (err) { toast(err.message, 'danger'); }
  });

  // Tab switching refresh. The open tab also goes in the URL hash (#rewards,
  // #settings) so a page refresh comes back to it instead of the chart.
  const tabActions = {
    '#pane-chart': () => refreshWeek(),
    '#pane-settings': () => refreshWeek(), // one scrolling page: Kids/Chores/General/Access all refresh together
    '#pane-rewards': () => refreshRewards(),
    '#pane-activity': () => loadActivity(),
  };
  // A hash change without a reload (a pasted link, Back) switches tabs too.
  window.addEventListener('hashchange', () => {
    const tab = document.getElementById('tab-' + (location.hash.slice(1) || 'chart'));
    if (tab && tab.matches('[data-bs-toggle="pill"]') && !tab.classList.contains('d-none')) {
      bootstrap.Tab.getOrCreateInstance(tab).show();
    }
  });
  document.querySelectorAll('[data-bs-toggle="pill"]').forEach((btn) => {
    btn.addEventListener('shown.bs.tab', () => {
      const name = btn.dataset.bsTarget.replace('#pane-', '');
      history.replaceState(null, '', name === 'chart' ? location.pathname + location.search : '#' + name);
      const action = tabActions[btn.dataset.bsTarget];
      if (action) action();
    });
  });

  // Keep an always-on tablet current: pick up other devices' check-offs every
  // minute, and refresh right away when the screen comes back. Skipped while a
  // dialog is open or the tab is hidden, so nothing moves under someone's finger.
  const liveRefresh = () => {
    if (document.visibilityState !== 'visible' || document.querySelector('.modal.show')) return;
    if (state.authRequired && !state.session) return;
    refreshWeek().catch(() => {});
    refreshIdeas().catch(() => {});
  };
  setInterval(liveRefresh, 60 * 1000);
  document.addEventListener('visibilitychange', liveRefresh);

  // Initial load — auth first, then settings (the chart's week-start-day
  // lives there), and only then the chart/rewards that depend on it.
  refreshAuth()
    .then(() => api('/api/settings'))
    .then((settings) => {
      state.settings = settings;
      $('#weekStartDay').value = String(settings.weekStartDay ?? 1);
      renderCustodySettings();
      applyRoleUI();
      return Promise.all([refreshWeek(), refreshRewards()]);
    })
    .then(() => {
      // Reopen the tab named in the hash, unless it's hidden for this role (Settings for kids).
      const tab = document.getElementById('tab-' + location.hash.slice(1));
      if (tab && tab.matches('[data-bs-toggle="pill"]') && !tab.classList.contains('d-none')) {
        bootstrap.Tab.getOrCreateInstance(tab).show();
      }
    })
    .catch((err) => toast('Failed to load: ' + err.message, 'danger'));
});

/* ============================ Theme picker ============================ */

// Eight palettes × light/dark, chosen per device. The CSS owns the colors
// (data-kd-theme on <html>); `swatch` here is just for drawing the picker.
const THEMES = [
  { id: 'grape', name: 'Grape', swatch: ['#7c5cd9', '#9b5cc7'] },
  { id: 'ocean', name: 'Ocean', swatch: ['#2563eb', '#0e7490'] },
  { id: 'mint', name: 'Mint', swatch: ['#0f766e', '#047857'] },
  { id: 'forest', name: 'Forest', swatch: ['#3f7d3a', '#6b6a1f'] },
  { id: 'sunshine', name: 'Sunshine', swatch: ['#b45309', '#a16207'] },
  { id: 'sunset', name: 'Sunset', swatch: ['#c2410c', '#be185d'] },
  { id: 'bubblegum', name: 'Bubblegum', swatch: ['#db2777', '#a21caf'] },
  { id: 'slate', name: 'Slate', swatch: ['#475569', '#334155'] },
];

(function () {
  const root = document.documentElement;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* unavailable */ } },
  };

  const mode = () => store.get('kiddodash-theme') || 'auto';
  const applyMode = () => {
    const m = mode();
    root.setAttribute('data-bs-theme', m === 'auto' ? (mq.matches ? 'dark' : 'light') : m);
  };
  const palette = () => (THEMES.some((t) => t.id === store.get('kiddodash-palette')) ? store.get('kiddodash-palette') : 'grape');

  function renderPicker() {
    const current = palette();
    document.getElementById('themeSwatches').innerHTML = THEMES.map(
      (t) => `<button type="button" class="theme-swatch${t.id === current ? ' active' : ''}" data-theme="${t.id}" aria-pressed="${t.id === current}">
          <span class="theme-swatch-chip" style="background:linear-gradient(135deg, ${t.swatch[0]}, ${t.swatch[1]})">${t.id === current ? '<i class="bi bi-check-lg"></i>' : ''}</span>
          <span>${t.name}</span>
        </button>`
    ).join('');
    for (const m of ['light', 'dark', 'auto']) {
      document.getElementById('mode' + m[0].toUpperCase() + m.slice(1)).checked = mode() === m;
    }
  }

  mq.addEventListener('change', applyMode); // only matters in auto

  document.addEventListener('DOMContentLoaded', () => {
    root.setAttribute('data-kd-theme', palette());
    applyMode();
    renderPicker();
    document.getElementById('themeSwatches').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme]');
      if (!btn) return;
      store.set('kiddodash-palette', btn.dataset.theme);
      root.setAttribute('data-kd-theme', btn.dataset.theme);
      renderPicker();
    });
    document.querySelectorAll('input[name="themeMode"]').forEach((input) =>
      input.addEventListener('change', () => {
        store.set('kiddodash-theme', input.value === 'auto' ? null : input.value);
        applyMode();
      })
    );
  });
})();

/* ============================ Confirm dialog ============================ */

let confirmResolve = null;
async function confirmDialog(message, { ok = 'Delete', danger = true } = {}) {
  $('#confirmModalBody').textContent = message;
  const btn = $('#confirmOk');
  btn.textContent = ok;
  btn.className = `btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`;
  return new Promise((resolve) => {
    confirmResolve = resolve;
    bootstrap.Modal.getOrCreateInstance('#confirmModal').show();
  });
}
document.addEventListener('DOMContentLoaded', () => {
  $('#confirmOk').addEventListener('click', () => {
    bootstrap.Modal.getInstance('#confirmModal')?.hide();
    confirmResolve?.(true);
  });
  $('#confirmModal').addEventListener('hidden.bs.modal', () => confirmResolve?.(false));
});
