// public/app.js — auth + backdated actions (full updated)

const listEl       = document.getElementById('list');
const detailEl     = document.getElementById('detail');
const addBtn       = document.getElementById('addPlantBtn');
const authBar      = document.getElementById('authBar');
const whoami       = document.getElementById('whoami');
const loginBtn     = document.getElementById('loginBtn');
const logoutBtn    = document.getElementById('logoutBtn');
const authDialog   = document.getElementById('authDialog');
const authForm     = document.getElementById('authForm');
const dateDialog   = document.getElementById('dateDialog');
const dateForm     = document.getElementById('dateForm');

// Fallback auth panel (only shown if <dialog> fails / is unavailable)
const authFallback      = document.getElementById('authFallback');
const authFallbackForm  = document.getElementById('authFallbackForm');

let me = null;
let plants = [];

init();

async function init() {
  // prevent full-page submits (Enter key)
  authForm?.addEventListener('submit', (e) => e.preventDefault());
  authFallbackForm?.addEventListener('submit', (e) => e.preventDefault());

  await refreshAuth();
  if (me) {
    addBtn.classList.remove('hidden');
    await loadPlants();
  }
}

async function refreshAuth() {
  try {
    const r = await fetch('/api/me');
    if (!r.ok) throw new Error('unauth');
    me = await r.json();
    whoami.textContent = `Signed in as ${me.email}`;
    whoami.classList.remove('hidden');
    loginBtn.classList.add('hidden');
    logoutBtn.classList.remove('hidden');
  } catch {
    me = null;
    whoami.textContent = '';
    whoami.classList.add('hidden');
    loginBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
  }
}

// ---- Auth UI ----
loginBtn.addEventListener('click', () => {
  try {
    if (authDialog && typeof authDialog.showModal === 'function') {
      authDialog.showModal();
    } else {
      authFallback?.classList.remove('hidden');
    }
  } catch (e) {
    console.error('authDialog.showModal error:', e);
    authFallback?.classList.remove('hidden');
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  me = null;
  listEl.innerHTML = '';
  detailEl.innerHTML = '';
  addBtn.classList.add('hidden');
  await refreshAuth();
});

authDialog.addEventListener('close', () => { /* no-op */ });

// Handle dialog login/register buttons
authForm.addEventListener('click', async (e) => {
  if (e.target.id === 'doLogin' || e.target.id === 'doRegister') {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(authForm));
    const endpoint = e.target.id === 'doLogin' ? '/api/login' : '/api/register';
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (r.ok) {
      authDialog.close();
      await refreshAuth();
      if (me) {
        addBtn.classList.remove('hidden');
        await loadPlants();
      }
    } else {
      const j = await r.json().catch(() => ({ error: 'error' }));
      alert(j.error || 'Auth failed');
    }
  }
});

// Handle fallback login/register buttons
authFallbackForm?.addEventListener('click', async (e) => {
  if (e.target.id !== 'fbLogin' && e.target.id !== 'fbRegister') return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(authFallbackForm));
  const endpoint = e.target.id === 'fbLogin' ? '/api/login' : '/api/register';
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (r.ok) {
    authFallback?.classList.add('hidden');
    await refreshAuth();
    if (me) {
      addBtn.classList.remove('hidden');
      await loadPlants();
    }
  } else {
    const j = await r.json().catch(() => ({ error: 'error' }));
    alert(j.error || 'Auth failed');
  }
});

// ---- Plants ----
async function loadPlants() {
  const r = await fetch('/api/plants');
  if (!r.ok) {
    listEl.innerHTML = '<p>Please log in to view plants.</p>';
    return;
  }
  plants = await r.json();
  renderList();
}

function renderList() {
  listEl.innerHTML = '';
  plants.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'plant-card';
    card.innerHTML = `
      <h3>${escapeHtml(p.name)}</h3>
      <p>${escapeHtml(p.species || '')}</p>
      <p>Location: ${escapeHtml(p.location || '')}</p>
      <p>Last watered: ${p.last_watered ? new Date(p.last_watered).toDateString() : '—'}</p>
      <p>Last repotted: ${p.last_repotted ? new Date(p.last_repotted).toDateString() : '—'}</p>
      <div class="row">
        <button data-act="water" data-id="${p.id}">💧 Water</button>
        <button data-act="repot" data-id="${p.id}">🪴 Repot</button>
        <button data-act="history" data-id="${p.id}">🗂 History</button>
      </div>
    `;
    card.addEventListener('click', onCardClick);
    listEl.appendChild(card);
  });
}

async function onCardClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === 'history') return showHistory(id);
  if (btn.dataset.act === 'water') return backdateAction('Watered on', id, '/api/water/');
  if (btn.dataset.act === 'repot') return backdateAction('Repotted on', id, '/api/repot/');
}

// ---- Date dialog helper (showModal is synchronous; we resolve on 'close') ----
function openDateDialog(title) {
  return new Promise((resolve) => {
    dateForm.reset();
    dateDialog.querySelector('#dateTitle').textContent = title;
    dateForm.elements.date.valueAsDate = new Date();

    const onClose = () => {
      dateDialog.removeEventListener('close', onClose);
      if (dateDialog.returnValue === 'cancel') return resolve(null);
      resolve(dateForm.elements.date.value); // YYYY-MM-DD
    };
    dateDialog.addEventListener('close', onClose, { once: true });
    dateDialog.showModal();
  });
}

async function backdateAction(title, plantId, pathPrefix) {
  const date = await openDateDialog(title);
  if (!date) return; // user canceled
  const r = await fetch(pathPrefix + plantId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({ error: 'error' }));
    alert(j.error || 'Failed');
    return;
  }
  await loadPlants();
}

async function showHistory(id) {
  const r = await fetch('/api/history/' + id);
  if (!r.ok) return alert('Failed to fetch history');
  const items = await r.json();
  detailEl.classList.remove('hidden');
  detailEl.innerHTML =
    '<h3>History</h3>' +
    items
      .map((it) => {
        const d = new Date(it.at).toDateString();
        return `<div>• ${it.type} — ${d}</div>`;
      })
      .join('');
}

// Add Plant button — unchanged from your version (just ensure it POSTs to /api/plants)
addBtn?.addEventListener('click', () => {
  const dlg = document.getElementById('plantDialog');
  dlg?.showModal();
});

// Utils
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}
