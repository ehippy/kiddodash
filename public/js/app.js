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

function freqBadgeHtml(chore) {
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
function renderChoreDaysPicker(container, idPrefix, freq, selectedDays) {
  if (freq === 'daily' || freq === 'schooldays') {
    container.innerHTML = '';
    return;
  }
  const selected = new Set(selectedDays || []);
  if (freq === 'due_by') {
    // One deadline day: radios sharing a name, read back by readChoreDaysPicker.
    const pick = selected.size ? [...selected][0] : WEEK_ORDER[WEEK_ORDER.length - 1];
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
  // Anything marked admin-only (reward edit/delete)
  document.querySelectorAll('[data-admin-only]').forEach((el) => {
    el.classList.toggle('d-none', !admin);
  });
  if (!admin && $('#pane-settings').classList.contains('show')) {
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
  }[chore.frequency];
  return `${isPerKid(chore) ? 'Each kid' : 'Shared — anyone can do it'} · ${when}`;
}

const scopeIcon = (chore) =>
  isPerKid(chore)
    ? '<i class="bi bi-person-fill scope-icon" aria-label="Each kid"></i>'
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
    const earned = items.filter((i) => i.done).reduce((sum, i) => sum + i.done.points, 0);
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

  // Shared chores due today: one row each; tapping asks who did it.
  const dow = now.getDay();
  const shared = state.chores.filter((c) => c.active && !isPerKid(c) && choreIsDueOn(c, dow));
  const sharedRows = shared.map((chore) => {
    const doneBy = Object.values(state.currentGrid?.[chore.id]?.[today] || {})[0];
    const body = (who) => `
      <span class="board-check">${doneBy ? '<i class="bi bi-check-lg"></i>' : ''}</span>
      <span class="board-text"><span class="board-title">${esc(chore.title)}</span>${who}</span>
      <span class="board-pts">+${chore.points}</span>`;
    if (doneBy) {
      const who = `<span class="board-note"><span class="who-dot" style="background:${esc(doneBy.kidColor)}"></span>${esc(doneBy.kidEmoji)} ${esc(doneBy.kidName)} did it</span>`;
      return canActFor(doneBy.kidId)
        ? `<button class="board-item done" data-undo="${doneBy.id}" data-undo-label="${esc(doneBy.kidName)}’s “${esc(chore.title)}”" title="Tap to undo">${body(who)}</button>`
        : `<div class="board-item done">${body(who)}</div>`;
    }
    const canAct = isAdmin() || myKidId() !== null;
    return canAct
      ? `<button class="board-item" data-chore="${chore.id}" data-date="${today}" title="Tap when done">${body('<span class="board-note">whoever does it gets the points</span>')}</button>`
      : `<div class="board-item">${body('')}</div>`;
  });
  if (sharedRows.length) {
    cards.push(`<div class="col-12 col-md-6 col-xl-4">
      <div class="kid-board shared-board">
        <div class="kid-board-head">
          <span class="kid-avatar shared-avatar"><i class="bi bi-people-fill"></i></span>
          <div class="flex-grow-1">
            <div class="kid-board-name">Shared</div>
            <div class="kid-board-status">Anyone can do these</div>
          </div>
        </div>
        <div class="board-list">${sharedRows.join('')}</div>
      </div>
    </div>`);
  }
  board.innerHTML = cards.join('');
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
  if (st === 'future' || !canActFor(kid.id)) {
    return `<span class="av ${st}" style="--kid-color:${esc(kid.color)}" title="${title(label.split(' · ')[0])}">${esc(kid.emoji)}</span>`;
  }
  return `<button class="av ${st}" style="--kid-color:${esc(kid.color)}" data-complete data-chore="${choreId}" data-kid="${kid.id}" data-date="${date}" title="${title(label)}">${esc(kid.emoji)}</button>`;
}

// Same idea for an undone shared chore: a single "+" slot that opens the kid picker.
function sharedSlotHtml(st, choreId, date) {
  const canAct = st !== 'future' && (isAdmin() || myKidId() !== null);
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
    ['<i class="bi bi-people-fill"></i> Shared — anyone can do it', activeChores.filter((c) => !isPerKid(c))],
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
  const reqs = [api('/api/week?offset=' + state.weekOffset), api('/api/totals')];
  if (state.weekOffset !== 0) reqs.push(api('/api/week?offset=0'));
  const [data, totals, current] = await Promise.all(reqs);
  state.kids = data.kids;
  state.chores = data.chores;
  state.kidTotals = totals;
  // grid is already { choreId: { date: { kidId: completion } } }
  state.weekGrid = data.grid;
  state.currentGrid = (current || data).grid; // the Today board always shows this week
  state.currentDates = (current || data).week.map((w) => w.date);
  renderChart();
  loadKidsTab();
  loadChoresTab();
  loadAccessTab(); // Settings is one scrolling page now — keep every section in sync
  applyRoleUI(); // re-apply after re-render (chart buttons depend on role)
}

// The grid a date belongs to: the Today board's current week, or the week on screen.
const gridForDate = (date) => (state.currentDates?.includes(date) ? state.currentGrid : state.weekGrid) || {};

async function completeChore(choreId, kidId, date) {
  try {
    const done = await api('/api/completions', { method: 'POST', body: { choreId, kidId, date } });
    const kid = state.kids.find((k) => k.id === done.kidId);
    toast(`${kid?.emoji || '🎉'} ${kid?.name || 'Someone'} got ${ptsLabel(done.points)}!`);
    await refreshWeek();
  } catch (err) {
    toast(err.message, 'danger');
  }
}

async function openCellPicker(choreId, date) {
  pickCtx = { choreId, date };
  const chore = state.chores.find((c) => c.id === Number(choreId));
  if (!chore) return;
  const day = DAYS_FULL[new Date(date + 'T00:00:00').getDay()];
  $('#cellModalTitle').textContent = `Who did “${chore.title}”? — ${day}`;
  if (!state.kids.length) {
    $('#cellModalBody').innerHTML =
      '<div class="empty-state"><i class="bi bi-people"></i>Add a kid first (Settings → Kids), then check off chores.</div>';
  } else {
    const grid = gridForDate(date);
    const doneMap = grid[Number(choreId)]?.[date] || {};
    const doneWeek = chore.frequency === 'due_by' ? doneThisWeek(chore, grid) : null;
    const isDone = (k) => (doneWeek ? doneWeek.has(k.id) : !!doneMap[k.id]);
    const mine = myKidId();
    const available = state.kids.filter((k) => !isDone(k) && (mine === null || k.id === mine));
    $('#cellModalBody').innerHTML = available.length
      ? `<div class="vstack gap-2">${available
          .map(
            (k) => `<button class="pick-kid-btn" style="--kid-color:${esc(k.color)}" data-kid="${k.id}">
            <span class="kid-avatar" style="background:${esc(k.color)}">${esc(k.emoji)}</span>
            <span>${esc(k.name)}</span>
            <span class="badge text-bg-light ms-auto">${ptsLabel(chore.points)}</span>
          </button>`
          )
          .join('')}</div>`
      : '<div class="empty-state"><i class="bi bi-check2-all"></i>Every kid already did this one!</div>';
  }
  new bootstrap.Modal('#cellModal').show();
}

// Context for the cell being picked (chore + date)
let pickCtx = null;

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
            <div class="d-flex justify-content-between align-items-baseline">
              <span class="fw-bold">${esc(k.name)}</span>
              <span class="kid-points-badge text-primary">${pts} pts
                ${spent ? `<span class="text-muted small" title="${spent} points spent on rewards">(${spent} spent)</span>` : ''}
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

function loadAccessTab() {
  const admin = isAdmin();
  $('#accessAdminCard').classList.toggle('d-none', !admin);
  $('#accessKidsCard').classList.toggle('d-none', !admin);
  const list = $('#kidPinsList');
  if (!list) return;
  if (!state.kids.length) {
    list.innerHTML = '<li class="list-group-item empty-state"><i class="bi bi-people"></i>No kids yet.</li>';
    return;
  }
  list.innerHTML = state.kids
    .map(
      (k) => `<li class="list-group-item">
        <div class="d-flex align-items-center gap-3">
          <span class="kid-avatar" style="background:${esc(k.color)}">${esc(k.emoji)}</span>
          <span class="fw-bold flex-grow-1">${esc(k.name)}</span>
          <span class="badge ${k.hasPin ? 'text-bg-success' : 'text-bg-secondary'}">${k.hasPin ? 'PIN set' : 'no PIN'}</span>
          <button class="btn btn-sm btn-outline-primary" data-editkid="${k.id}">
            <i class="bi bi-key me-1"></i>${k.hasPin ? 'Change' : 'Set PIN'}
          </button>
        </div>
      </li>`
    )
    .join('');
}

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
          <span class="fw-bold flex-grow-1 ${c.active ? '' : 'text-muted'}">${esc(c.title)}</span>
          <span class="chore-pts">${c.points} pt${c.points > 1 ? 's' : ''}</span>
          ${freqBadgeHtml(c)}
          <button class="btn btn-sm btn-outline-secondary" data-editchore="${c.id}" title="Edit"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-danger" data-delchore="${c.id}" title="Delete"><i class="bi bi-trash"></i></button>
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
    list.innerHTML = '<div class="empty-state"><i class="bi bi-trophy"></i>No rewards yet — add one!</div>';
    return;
  }
  const byId = new Map(state.kidTotals.map((t) => [t.id, t]));
  list.innerHTML = s.rewards
    .map((r) => {
      const mine = myKidId();
      const eligible = mine === null ? state.kidTotals : state.kidTotals.filter((t) => t.id === mine);
      const kidOpts = eligible
        .map((t) => {
          const can = t.balance >= r.points;
          return `<option value="${t.id}" ${can ? '' : 'disabled'}>
            ${esc(t.emoji)} ${esc(t.name)} — ${t.balance} pts${can ? '' : ' (not enough)'}
          </option>`;
        })
        .join('');
      return `<div class="reward-item d-flex align-items-center gap-2">
          <i class="bi bi-gift text-primary fs-5"></i>
          <span class="fw-bold flex-grow-1">${esc(r.label)}</span>
          <span class="badge text-bg-warning">${r.points} pts</span>
          <select class="form-select form-select-sm d-none d-sm-inline-block w-auto" data-redeemkid="${r.id}">
            ${mine === null ? '<option value="">Pick a kid…</option>' : ''}${kidOpts}
          </select>
          <button class="btn btn-sm btn-primary" data-redeem="${r.id}" title="Redeem for the selected kid"><i class="bi bi-check-lg me-1"></i>Redeem</button>
          <button class="btn btn-sm btn-outline-secondary d-none" data-admin-only data-editreward='${esc(JSON.stringify(r))}'><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-danger d-none" data-admin-only data-delreward="${r.id}"><i class="bi bi-trash"></i></button>
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
  const byId = new Map(state.kidTotals.map((t) => [t.id, t]));
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
          <div class="text-muted small">${esc(r.kidName)} · ${new Date(r.createdAt + 'Z').toLocaleDateString()}</div>
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
  applyRoleUI(); // reward edit/delete buttons follow the role
  loadRewardsTab(); // re-render redeem selects with fresh balances
  loadKidsTab(); // kid cards now show balance, not lifetime earned
}

/* ============================ Events ============================ */

document.addEventListener('DOMContentLoaded', () => {
  // Week navigation
  $('#btnPrevWeek').addEventListener('click', () => { state.weekOffset--; refreshWeek(); });
  $('#btnNextWeek').addEventListener('click', () => { state.weekOffset++; refreshWeek(); });
  $('#btnToday').addEventListener('click', () => { state.weekOffset = 0; refreshWeek(); });

  // Today / Week toggle
  $('#viewToday').addEventListener('change', () => setChartView('today'));
  $('#viewWeek').addEventListener('change', () => setChartView('week'));

  // Chart clicks, both views (delegated): undo a check, check off for a known
  // kid directly, or open the kid picker for a shared chore.
  $('#pane-chart').addEventListener('click', async (e) => {
    const undo = e.target.closest('[data-undo]');
    if (undo) {
      const ok = await confirmDialog(`Undo ${undo.dataset.undoLabel || 'this check'}?`);
      if (ok) {
        try {
          await api('/api/completions/' + undo.dataset.undo, { method: 'DELETE' });
          toast('Undone', 'secondary');
          await refreshWeek();
        } catch (err) { toast(err.message, 'danger'); }
      }
      return;
    }
    const direct = e.target.closest('[data-complete]');
    if (direct) {
      direct.disabled = true; // no double-taps while the request is in flight
      return completeChore(Number(direct.dataset.chore), Number(direct.dataset.kid), direct.dataset.date);
    }
    const cell = e.target.closest('[data-chore]');
    if (cell) openCellPicker(cell.dataset.chore, cell.dataset.date);
  });

  // Kid picker modal
  $('#cellModalBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-kid]');
    if (!btn || !pickCtx) return;
    bootstrap.Modal.getInstance('#cellModal')?.hide();
    await completeChore(Number(pickCtx.choreId), Number(btn.dataset.kid), pickCtx.date);
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
      await Promise.all([refreshWeek()]);
    } catch (err) {
      toast(err.message, 'danger');
    }
  });

  // Kids list actions (delegated)
  $('#kidsList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-delkid]');
    if (del) {
      const kid = state.kids.find((k) => k.id === Number(del.dataset.delkid));
      const ok = await confirmDialog(`Remove ${kid?.name}? Their completed chores and points will also be removed.`);
      if (ok) {
        try {
          await api('/api/kids/' + del.dataset.delkid, { method: 'DELETE' });
          toast('Removed', 'secondary');
          await Promise.all([refreshWeek()]);
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
          points: Number($('#chorePoints').value) || 1,
        },
      });
      toast('Chore added');
      $('#choreTitle').value = '';
      await Promise.all([refreshWeek()]);
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
          await Promise.all([refreshWeek()]);
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
        await Promise.all([refreshWeek()]);
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
    renderChoreDaysPicker($('#choreEditDaysRow'), 'choreEditDay', chore.frequency, chore.days || []);
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
      if (!reward) return;
      const sel = $(`[data-redeemkid="${reward.id}"]`);
      // A signed-in kid has exactly one option in their picker — use it implicitly.
      const auto = myKidId() !== null ? myKidId() : 0;
      const kidId = sel && sel.value ? Number(sel.value) : auto;
      if (!kidId) return toast('Pick a kid first', 'warning');
      try {
        const res = await api('/api/redeem', { method: 'POST', body: { kidId, reward } });
        toast(`${res.kidEmoji} ${res.kidName} redeemed “${res.rewardLabel}”! (${res.balance} pts left)`);
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
          await api('/api/settings', { method: 'PUT', body: { rewards } });
          loadRewardsTab();
          toast('Reward deleted', 'secondary');
        } catch (err) { toast(err.message, 'danger'); }
      }
      return;
    }
    const edit = e.target.closest('[data-editreward]');
    if (edit) {
      const r = JSON.parse(edit.dataset.editreward);
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
    const points = Number($('#rewardPoints').value) || 0;
    if (id) {
      const i = rewards.findIndex((r) => r.id === Number(id));
      if (i >= 0) rewards[i] = { ...rewards[i], label, points };
    } else {
      rewards.push({ id: Date.now(), label, points });
    }
    try {
      await api('/api/settings', { method: 'PUT', body: { rewards } });
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

  $('#kidPinsList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-editkid]');
    if (btn) openKidEditModal(Number(btn.dataset.editkid));
  });

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
    const ok = await confirmDialog(`Remove ${kid.name}? Their completed chores and points will also be removed.`);
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
  };
  document.querySelectorAll('[data-bs-toggle="pill"]').forEach((btn) => {
    btn.addEventListener('shown.bs.tab', () => {
      const name = btn.dataset.bsTarget.replace('#pane-', '');
      history.replaceState(null, '', name === 'chart' ? location.pathname + location.search : '#' + name);
      const action = tabActions[btn.dataset.bsTarget];
      if (action) action();
    });
  });

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

/* ============================ Theme toggle ============================ */

(function () {
  const root = document.documentElement;
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  function apply(theme) {
    root.setAttribute('data-bs-theme', theme);
    const dark = theme === 'dark';
    btn.querySelector('.theme-icon-dark').classList.toggle('d-none', !dark);
    btn.querySelector('.theme-icon-light').classList.toggle('d-none', dark);
    btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }

  // Follow the system until the user picks a preference
  mq.addEventListener('change', () => {
    if (!localStorage.getItem('kiddodash-theme')) apply(mq.matches ? 'dark' : 'light');
  });

  btn.addEventListener('click', () => {
    const next = root.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('kiddodash-theme', next);
    apply(next);
  });

  // Sync icon with whatever the inline head script already applied
  apply(root.getAttribute('data-bs-theme') || 'light');
})();

/* ============================ Confirm dialog ============================ */

let confirmResolve = null;
async function confirmDialog(message) {
  $('#confirmModalBody').textContent = message;
  return new Promise((resolve) => {
    confirmResolve = resolve;
    new bootstrap.Modal('#confirmModal').show();
  });
}
document.addEventListener('DOMContentLoaded', () => {
  $('#confirmOk').addEventListener('click', () => {
    bootstrap.Modal.getInstance('#confirmModal')?.hide();
    confirmResolve?.(true);
  });
  $('#confirmModal').addEventListener('hidden.bs.modal', () => confirmResolve?.(false));
});
