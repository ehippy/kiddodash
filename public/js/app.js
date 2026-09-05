'use strict';

/* ============================ State ============================ */

const state = {
  kids: [],
  chores: [],
  settings: null,
  weekOffset: 0, // 0 = current week
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

/* ============================ API ============================ */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
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
  const now = new Date();
  const jsDay = (now.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() - jsDay + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ============================ Chart tab ============================ */

function loadWeek() {
  const dates = weekDates(state.weekOffset);
  const today = dateStr(new Date());

  // Header
  const head = $('#chartHead');
  head.innerHTML = `<tr><th class="ps-2" style="min-width:150px">Chore</th>${dates
    .map(
      (d) => `<th class="text-center ${dateStr(d) === today ? 'today-col' : ''}">
        ${DAY_NAMES[d.getDay()]}${dateStr(d) === today ? '<span class="today-dot"></span>' : ''}
        <div class="fw-normal" style="font-size:.7rem;color:#9ca3af">${d.getDate()}</div>
      </th>`
    )
    .join('')}</tr>`;

  $('#weekLabel').textContent =
    state.weekOffset === 0
      ? 'This week'
      : state.weekOffset < 0
        ? `${-state.weekOffset} week${-state.weekOffset > 1 ? 's' : ''} ago`
        : `In ${state.weekOffset} week${state.weekOffset > 1 ? 's' : ''}`;

  // Rows
  const body = $('#chartBody');
  const grid = state.weekGrid || {};
  if (!state.chores.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty-state"><i class="bi bi-clipboard2-x"></i>No chores yet — add some in the “Chores” tab.</td></tr>`;
    return;
  }
  if (!state.kids.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty-state"><i class="bi bi-people"></i>Add a kid first (Kids tab), then check off chores.</td></tr>`;
    return;
  }
  body.innerHTML = state.chores
    .map((chore) => {
      const cells = dates
        .map((d) => {
          const ds = dateStr(d);
          const isDue =
            chore.frequency === 'daily' ||
            chore.frequency === 'personal' ||
            (chore.frequency === 'weekly' && chore.dayOfWeek === d.getDay());
          const doneMap = (grid[chore.id] || {})[ds];
          const due = isDue;
          const doneKids = state.kids.filter((k) => doneMap && doneMap[k.id]);
          const remaining =
            due && (chore.frequency === 'personal' ? state.kids.length - doneKids.length : doneMap ? 0 : 1);
          const parts = [];
          for (const k of doneKids) {
            const c = doneMap[k.id];
            parts.push(`<button class="cell-btn done" style="background:${esc(c.kidColor)}"
                  data-undo="${c.id}" data-kid="${esc(c.kidName)}" title="Click to undo">
                  <i class="bi bi-check-lg"></i>${esc(c.kidEmoji)} ${esc(c.kidName)}
                </button>`);
          }
          if (remaining > 0) {
            const hint =
              chore.frequency === 'personal'
                ? `${esc(chore.title)} — ${remaining} kid${remaining > 1 ? 's' : ''} to go`
                : 'Check off';
            parts.push(`<button class="cell-btn" data-chore="${chore.id}" data-date="${ds}" title="${hint}">✎</button>`);
          }
          if (!due && !doneKids.length) return `<td class="chore-cell"></td>`;
          if (!parts.length) return `<td class="chore-cell"></td>`;
          return `<td class="chore-cell text-center"><div class="d-flex flex-column gap-1">${parts.join('')}</div></td>`;
        })
        .join('');
      const freqBadge =
        chore.frequency === 'daily'
          ? '<span class="badge text-bg-info freq-badge">daily</span>'
          : chore.frequency === 'personal'
            ? '<span class="badge text-bg-primary freq-badge">each kid, daily</span>'
            : `<span class="badge text-bg-secondary freq-badge">${DAYS_FULL[chore.dayOfWeek]}</span>`;
      return `<tr>
        <td class="chore-title-cell ps-2">${esc(chore.title)}<span class="chore-pts">${chore.points} pt${chore.points > 1 ? 's' : ''}</span>${freqBadge}</td>
        ${cells}
      </tr>`;
    })
    .join('');
}

async function refreshWeek() {
  const data = await api('/api/week?offset=' + state.weekOffset);
  state.kids = data.kids;
  state.chores = data.chores;
  // grid is already { choreId: { date: { kidId: completion } } }
  state.weekGrid = data.grid;
  state.weekDates = data.week.map((w) => w.date);
  renderTodaySummary();
  loadWeek();
  loadKidsTab();
  loadChoresTab();
}

async function openCellPicker(choreId, date) {
  pickCtx = { choreId, date };
  const chore = state.chores.find((c) => c.id === Number(choreId));
  if (!chore) return;
  const day = DAYS_FULL[new Date(date + 'T00:00:00').getDay()];
  $('#cellModalTitle').textContent = `${chore.title} — ${day}`;
  if (!state.kids.length) {
    $('#cellModalBody').innerHTML =
      '<div class="empty-state"><i class="bi bi-people"></i>Add a kid first (Kids tab), then check off chores.</div>';
  } else {
    const doneMap = (state.weekGrid?.[Number(choreId)] || {})[date] || {};
    const available = state.kids.filter((k) => !doneMap[k.id]);
    $('#cellModalBody').innerHTML = available.length
      ? `<div class="vstack gap-2">${available
          .map(
            (k) => `<button class="pick-kid-btn" style="--kid-color:${esc(k.color)}" data-kid="${k.id}">
            <span class="kid-avatar" style="background:${esc(k.color)}">${esc(k.emoji)}</span>
            <span>${esc(k.name)}</span>
            <span class="badge text-bg-light ms-auto">${chore.points} pt${chore.points > 1 ? 's' : ''}</span>
          </button>`
          )
          .join('')}</div>`
      : '<div class="empty-state"><i class="bi bi-check2-all"></i>Every kid already did this one!</div>';
  }
  new bootstrap.Modal('#cellModal').show();
}

// Context for the cell being picked (chore + date)
let pickCtx = null;

/* ============================ Today summary (chart) ============================ */

// Per-kid "today" progress: which chores are due for this kid today, and which
// are already done. Reads the same week grid as the chart, so it can't go stale
// relative to it (and unlike the old Today tab, personal chores count).
function renderTodaySummary() {
  const el = $('#todaySummary');
  if (!el) return;
  if (!state.kids.length || !state.chores.length) {
    el.innerHTML = '';
    return;
  }
  const today = dateStr(new Date());
  const dow = new Date().getDay();
  const grid = state.weekGrid || {};
  const due = state.chores.filter(
    (c) =>
      c.active !== false &&
      (c.frequency === 'daily' || c.frequency === 'personal' || (c.frequency === 'weekly' && c.dayOfWeek === dow))
  );
  if (!due.length) {
    el.innerHTML = '<span class="today-chip" style="--kid-color:#6b7280">🎉 Nothing due today — enjoy the free day!</span>';
    return;
  }
  el.innerHTML = state.kids
    .map((k) => {
      const done = due.filter((c) => (grid[c.id] || {})[today]?.[k.id]).length;
      const allDone = done === due.length;
      return `<span class="today-chip ${allDone ? 'done' : ''}" style="--kid-color:${esc(k.color)}">
        <span class="today-dot-kid"></span>${esc(k.emoji)} ${esc(k.name)}
        <span class="today-chip-count">${done}/${due.length}</span>
        ${allDone ? '<i class="bi bi-check-lg"></i>' : ''}
      </span>`;
    })
    .join('');
}

/* ============================ Kids tab ============================ */

function loadKidsTab() {
  const list = $('#kidsList');
  if (!state.kids.length) {
    list.innerHTML = '<li class="list-group-item empty-state"><i class="bi bi-people"></i>No kids yet.</li>';
    return;
  }
  $('#goalBadge').textContent = `Goal: ${state.settings?.goalPoints ?? '—'} pts`;
  list.innerHTML = state.kids
    .map((k) => {
      const pts = k.points || 0;
      const goal = state.settings?.goalPoints || 1;
      const pct = Math.min(100, Math.round((pts / goal) * 100));
      return `<li class="list-group-item">
        <div class="d-flex align-items-center gap-3">
          <span class="kid-avatar" style="background:${esc(k.color)}">${esc(k.emoji)}</span>
          <div class="flex-grow-1">
            <div class="d-flex justify-content-between align-items-baseline">
              <span class="fw-bold">${esc(k.name)}</span>
              <span class="kid-points-badge text-primary">${pts} pts
                ${k.rewardable ? '<span class="rewardable-flag" title="Ready to redeem a reward!">🏆</span>' : ''}
              </span>
            </div>
            <div class="progress mt-1">
              <div class="progress-bar" role="progressbar" style="width:${pct}%;background:${esc(k.color)}"
                   aria-valuenow="${pts}" aria-valuemax="${goal}">${pct}%</div>
            </div>
          </div>
          <div class="btn-group btn-group-sm">
            <input type="color" class="form-control form-control-color btn border-end-0" style="width:38px"
                   value="${esc(k.color)}" data-recolor="${k.id}" title="Change color">
            <input class="form-control form-control-sm w-auto" style="width:44px;text-align:center" maxlength="4"
                   value="${esc(k.emoji)}" data-reemoji="${k.id}" title="Change emoji">
            <button class="btn btn-outline-secondary" data-rename="${k.id}" title="Rename"><i class="bi bi-pencil"></i></button>
            <button class="btn btn-outline-danger" data-delkid="${k.id}" title="Remove"><i class="bi bi-trash"></i></button>
          </div>
        </div>
      </li>`;
    })
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
          ${
            c.frequency === 'weekly'
              ? `<select class="form-select form-select-sm day-select" data-changeday="${c.id}">
                  ${[1, 2, 3, 4, 5, 6, 0]
                    .map((d) => `<option value="${d}" ${c.dayOfWeek === d ? 'selected' : ''}>${DAYS_FULL[d]}</option>`)
                    .join('')}
                </select>`
              : c.frequency === 'daily'
                ? '<span class="badge text-bg-info freq-badge">daily</span>'
                : '<span class="badge text-bg-primary freq-badge">each kid, daily</span>'
          }
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
  $('#goalPoints').value = s.goalPoints;
  const list = $('#rewardsList');
  if (!s.rewards.length) {
    list.innerHTML = '<li class="list-group-item empty-state"><i class="bi bi-trophy"></i>No rewards yet.</li>';
    return;
  }
  list.innerHTML = s.rewards
    .map(
      (r) => `<li class="list-group-item d-flex align-items-center gap-2">
          <i class="bi bi-gift text-primary fs-5"></i>
          <span class="fw-bold flex-grow-1">${esc(r.label)}</span>
          <span class="badge text-bg-warning">${r.points} pts</span>
          <button class="btn btn-sm btn-outline-secondary" data-editreward='${esc(JSON.stringify(r))}'><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-danger" data-delreward="${r.id}"><i class="bi bi-trash"></i></button>
        </li>`
    )
    .join('');
}

/* ============================ Events ============================ */

document.addEventListener('DOMContentLoaded', () => {
  // Week navigation
  $('#btnPrevWeek').addEventListener('click', () => { state.weekOffset--; refreshWeek(); });
  $('#btnNextWeek').addEventListener('click', () => { state.weekOffset++; refreshWeek(); });
  $('#btnToday').addEventListener('click', () => { state.weekOffset = 0; refreshWeek(); });

  // Chart cell clicks (delegated)
  $('#chartBody').addEventListener('click', async (e) => {
    const undo = e.target.closest('[data-undo]');
    if (undo) {
      const ok = await confirmDialog(`Undo “${undo.dataset.kid}” for this chore?`);
      if (ok) {
        await api('/api/completions/' + undo.dataset.undo, { method: 'DELETE' });
        toast('Undone');
        await Promise.all([refreshWeek()]);
      }
      return;
    }
    const cell = e.target.closest('[data-chore]');
    if (cell) openCellPicker(cell.dataset.chore, cell.dataset.date);
  });

  // Kid picker modal
  $('#cellModalBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-kid]');
    if (!btn || !pickCtx) return;
    bootstrap.Modal.getInstance('#cellModal')?.hide();
    try {
      const done = await api('/api/completions', {
        method: 'POST',
        body: { choreId: pickCtx.choreId, kidId: Number(btn.dataset.kid), date: pickCtx.date },
      });
      const kid = state.kids.find((k) => k.id === done.kidId);
      toast(`${kid?.emoji || '🎉'} ${kid?.name || 'Someone'} got ${done.points} point${done.points > 1 ? 's' : ''}!`);
      await Promise.all([refreshWeek(), loadKidsTab()]);
    } catch (err) {
      toast(err.message, 'danger');
    }
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
        },
      });
      toast(`${kid.emoji} ${kid.name} added!`);
      $('#kidName').value = '';
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
    const rename = e.target.closest('[data-rename]');
    if (rename) {
      const kid = state.kids.find((k) => k.id === Number(rename.dataset.rename));
      const name = prompt('New name:', kid?.name);
      if (name && name.trim() && name.trim() !== kid.name) {
        try {
          await api('/api/kids/' + kid.id, { method: 'PUT', body: { name: name.trim() } });
          await refreshWeek();
        } catch (err) { toast(err.message, 'danger'); }
      }
    }
  });

  $('#kidsList').addEventListener('change', async (e) => {
    const recolor = e.target.closest('[data-recolor]');
    if (recolor) {
      const kid = state.kids.find((k) => k.id === Number(recolor.dataset.recolor));
      try {
        await api('/api/kids/' + kid.id, { method: 'PUT', body: { color: recolor.value } });
        await refreshWeek();
      } catch (err) { toast(err.message, 'danger'); }
      return;
    }
    const reemoji = e.target.closest('[data-reemoji]');
    if (reemoji && reemoji.value.trim()) {
      const kid = state.kids.find((k) => k.id === Number(reemoji.dataset.reemoji));
      try {
        await api('/api/kids/' + kid.id, { method: 'PUT', body: { emoji: reemoji.value.trim() } });
        await refreshWeek();
      } catch (err) { toast(err.message, 'danger'); }
    }
  });

  // Chores form
  $('#choreFreq').addEventListener('change', (e) => {
    $('#choreDay').disabled = e.target.value !== 'weekly';
  });
  $('#choreForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/chores', {
        method: 'POST',
        body: {
          title: $('#choreTitle').value.trim(),
          frequency: $('#choreFreq').value,
          dayOfWeek: $('#choreFreq').value === 'weekly' ? Number($('#choreDay').value) : null,
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
    }
  });

  $('#choresList').addEventListener('change', async (e) => {
    const day = e.target.closest('[data-changeday]');
    if (day) {
      try {
        await api('/api/chores/' + day.dataset.changeday, { method: 'PUT', body: { dayOfWeek: Number(day.value) } });
        await Promise.all([refreshWeek()]);
      } catch (err) { toast(err.message, 'danger'); }
      return;
    }
    const toggle = e.target.closest('[data-togglechores]');
    if (toggle) {
      try {
        await api('/api/chores/' + toggle.dataset.togglechores, { method: 'PUT', body: { active: toggle.checked } });
        await Promise.all([refreshWeek()]);
      } catch (err) { toast(err.message, 'danger'); }
    }
  });

  // Rewards
  $('#btnSaveGoal').addEventListener('click', async () => {
    const goalPoints = Number($('#goalPoints').value);
    if (!Number.isInteger(goalPoints) || goalPoints < 1) return toast('Enter a whole number ≥ 1', 'warning');
    try {
      await api('/api/settings', { method: 'PUT', body: { goalPoints } });
      toast('Goal updated');
      await Promise.all([refreshWeek(), loadRewardsTab()]);
    } catch (err) { toast(err.message, 'danger'); }
  });

  $('#btnAddReward').addEventListener('click', () => {
    $('#rewardId').value = '';
    $('#rewardLabel').value = '';
    $('#rewardPoints').value = '';
    $('#rewardModalTitle').textContent = 'Add reward';
    new bootstrap.Modal('#rewardModal').show();
  });

  $('#rewardsList').addEventListener('click', async (e) => {
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

  // Tab switching refresh
  const tabActions = {
    'pane-chart': () => refreshWeek(),
    'pane-kids': () => refreshWeek(),
    'pane-chores': () => refreshWeek(),
    'pane-rewards': () => loadRewardsTab(),
  };
  document.querySelectorAll('[data-bs-toggle="pill"]').forEach((btn) => {
    btn.addEventListener('shown.bs.tab', () => {
      const action = tabActions[btn.dataset.bsTarget];
      if (action) action();
    });
  });

  // Initial load
  Promise.all([api('/api/settings'), refreshWeek()])
    .then(([settings]) => {
      state.settings = settings;
      loadRewardsTab();
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
