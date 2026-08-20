// Mustaqbali Cab — Admin Panel
// Auth via Supabase Auth (email/password). Access to actual trip data is
// gated server-side by is_admin()/RLS (see schema.sql) — logging in alone
// grants nothing; the admins table is the real gate. This file only
// controls what the UI *shows*, never what the database *allows*.

const STATUS_LABELS = { new: 'جديد', assigned: 'تم التعيين', en_route: 'قيد التنفيذ', arrived: 'تم الوصول', completed: 'مكتملة', cancelled: 'ملغاة' };
const TIMELINE_STEPS = ['new', 'assigned', 'en_route', 'arrived', 'completed'];
const SERVICE_LABELS = { taxi: 'تكسي', private: 'خصوصي', courier: 'توصيل أغراض', intercity: 'بين المحافظات' };

const state = {
  session: null,
  requests: [],
  activeFilter: 'all',
  searchTerm: '',
  selectedId: null,
  prices: {}, // service_type -> { label, base_price, price_per_km }
};

/* ============================================================
   XSS-safe rendering helpers
   Every customer-supplied value (name, phone, pickup, notes...)
   goes through escapeHtml before hitting innerHTML. service_type
   and status are already constrained by a CHECK constraint in the
   database, but escapeAttr is applied to them too as a second,
   defensive layer.
   ============================================================ */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
function escapeAttr(str) {
  return escapeHtml(str).replaceAll('`', '&#096;');
}

/* ============================================================
   Auth
   ============================================================ */
async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginBtn');
  const errEl = document.getElementById('loginError');
  errEl.classList.remove('show');
  btn.disabled = true;

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  if (error) {
    errEl.textContent = 'تعذّر تسجيل الدخول. تحقق من البريد وكلمة المرور.';
    errEl.classList.add('show');
    return;
  }
  state.session = data.session;
  await enterDashboard();
}

async function handleLogout() {
  await supabaseClient.auth.signOut();
  state.session = null;
  state.requests = [];
  document.getElementById('adminShell').classList.remove('active');
  document.getElementById('adminLogin').style.display = 'flex';
}

async function enterDashboard() {
  document.getElementById('adminLogin').style.display = 'none';
  document.getElementById('adminShell').classList.add('active');
  document.getElementById('adminEmail').textContent = state.session?.user?.email || '';
  await loadRequests();
  await loadPrices();
  subscribeToNewRequests();
}

/* ============================================================
   Realtime — auto-refresh + alert sound on new trip_requests
   Added on top of existing manual-refresh behavior; does not
   change or remove any existing function.
   ============================================================ */
function subscribeToNewRequests() {
  supabaseClient
    .channel('trip_requests_admin')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trip_requests' }, () => {
      playAlertSound();
      loadRequests();
    })
    .subscribe((status) => {
      // تشخيص مؤقت — يمكن حذف هذا السطر لاحقاً بعد التأكد من عمل Realtime
      alert('Realtime status: ' + status);
    });
}

function playAlertSound() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.3, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
  osc.start();
  osc.stop(ctx.currentTime + 0.6);
}

/* ============================================================
   Pricing — real, DB-driven, admin-editable (service_prices table)
   ============================================================ */
async function loadPrices() {
  const { data, error } = await supabaseClient.from('service_prices').select('*');
  if (error) {
    console.error(error);
    return;
  }
  state.prices = {};
  (data || []).forEach(row => { state.prices[row.service_type] = row; });
  renderPriceGrid();
}

function renderPriceGrid() {
  const grid = document.getElementById('priceGrid');
  if (!grid) return;
  grid.innerHTML = Object.values(state.prices).map(p => `
    <div class="admin-price-card" data-service="${escapeAttr(p.service_type)}">
      <b>${escapeHtml(p.label)}</b>
      <div class="admin-price-row">
        <label>السعر الأساسي (دينار)</label>
        <input type="number" min="0" step="1" class="price-base" value="${escapeAttr(p.base_price)}">
      </div>
      <div class="admin-price-row">
        <label>سعر الكيلومتر (دينار)</label>
        <input type="number" min="0" step="1" class="price-perkm" value="${escapeAttr(p.price_per_km)}">
      </div>
    </div>
  `).join('');
}

async function savePrices() {
  const errEl = document.getElementById('priceError');
  errEl.classList.remove('show');
  const cards = document.querySelectorAll('.admin-price-card');
  const updates = [];
  for (const card of cards) {
    const service_type = card.dataset.service;
    const baseRaw = card.querySelector('.price-base').value;
    const perKmRaw = card.querySelector('.price-perkm').value;
    const base_price = Number(baseRaw);
    const price_per_km = Number(perKmRaw);
    if (Number.isNaN(base_price) || Number.isNaN(price_per_km) || base_price < 0 || price_per_km < 0) {
      errEl.textContent = 'الأسعار يجب أن تكون أرقاماً موجبة.';
      errEl.classList.add('show');
      return;
    }
    updates.push({ service_type, base_price, price_per_km });
  }

  for (const u of updates) {
    const { error } = await supabaseClient
      .from('service_prices')
      .update({ base_price: u.base_price, price_per_km: u.price_per_km })
      .eq('service_type', u.service_type);
    if (error) {
      console.error(error);
      errEl.textContent = 'تعذّر حفظ الأسعار: ' + error.message;
      errEl.classList.add('show');
      return;
    }
  }
  await loadPrices();
}

/* ============================================================
   Data loading
   Capped at 300 rows — see DEPLOYMENT_CHECKLIST.md section 5.
   Search/filter below operate on this loaded set, not a fresh
   query, so a request older than the most recent 300 won't
   surface in search. That's a deliberate cost/simplicity
   trade-off documented in the checklist, not a bug.
   ============================================================ */
async function loadRequests() {
  const { data, error } = await supabaseClient
    .from('trip_requests')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(300);

  if (error) {
    console.error(error);
    document.getElementById('emptyState').style.display = 'block';
    document.getElementById('emptyState').textContent = 'تعذّر تحميل الطلبات. تأكد من صلاحيات حسابك.';
    document.getElementById('requestsBody').innerHTML = '';
    updateStats([]);
    return;
  }

  state.requests = data || [];
  updateStats(state.requests);
  renderTable();
}

function updateStats(rows) {
  document.getElementById('statTotal').textContent = rows.length;
  document.getElementById('statNew').textContent = rows.filter(r => r.status === 'new').length;
  document.getElementById('statProgress').textContent = rows.filter(r => r.status === 'assigned' || r.status === 'en_route' || r.status === 'arrived').length;
  document.getElementById('statDone').textContent = rows.filter(r => r.status === 'completed').length;
}

/* ============================================================
   Table rendering
   ============================================================ */
function filteredRequests() {
  let rows = state.requests;
  if (state.activeFilter !== 'all') {
    rows = rows.filter(r => r.status === state.activeFilter);
  }
  if (state.searchTerm) {
    const q = state.searchTerm.toLowerCase();
    rows = rows.filter(r =>
      (r.customer_name || '').toLowerCase().includes(q) ||
      (r.phone || '').toLowerCase().includes(q) ||
      (r.request_number || '').toLowerCase().includes(q)
    );
  }
  return rows;
}

function renderTable() {
  const rows = filteredRequests();
  const body = document.getElementById('requestsBody');
  const empty = document.getElementById('emptyState');

  if (rows.length === 0) {
    body.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = 'لا توجد طلبات مطابقة.';
    return;
  }
  empty.style.display = 'none';

  body.innerHTML = rows.map(r => `
    <tr class="clickable" data-id="${escapeAttr(r.id)}">
      <td>›</td>
      <td>${escapeHtml(r.request_number || r.id.slice(0, 8))}</td>
      <td>${escapeHtml(SERVICE_LABELS[r.service_type] || r.service_type)}</td>
      <td>${escapeHtml(r.customer_name)}</td>
      <td>${escapeHtml(r.phone)}</td>
      <td>${escapeHtml(r.pickup_location)}</td>
      <td><span class="status-pill ${escapeAttr(r.status)}">${escapeHtml(STATUS_LABELS[r.status] || r.status)}</span></td>
      <td>${escapeHtml(formatDate(r.created_at))}</td>
    </tr>
  `).join('');

  body.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', () => openDetail(tr.dataset.id));
  });
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ar-IQ', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/* ============================================================
   Detail modal
   ============================================================ */
async function openDetail(id) {
  const r = state.requests.find(x => x.id === id);
  if (!r) return;
  state.selectedId = id;

  document.getElementById('modalReqNumber').textContent = '#' + (r.request_number || r.id.slice(0, 8).toUpperCase());
  const pill = document.getElementById('modalStatusPill');
  pill.className = 'status-pill ' + r.status;
  pill.textContent = STATUS_LABELS[r.status] || r.status;

  document.getElementById('modalService').textContent = SERVICE_LABELS[r.service_type] || r.service_type;
  document.getElementById('modalName').textContent = r.customer_name || '—';
  document.getElementById('modalPhone').textContent = r.phone || '—';
  document.getElementById('modalPickup').textContent = r.pickup_location || '—';
  document.getElementById('modalDropoff').textContent = r.dropoff_location || '—';
  document.getElementById('modalScheduled').textContent = r.scheduled_at ? formatDate(r.scheduled_at) : 'فوري';
  document.getElementById('modalNotes').textContent = r.notes || '—';
  document.getElementById('driverName').value = r.driver_name || '';
  document.getElementById('driverPhone').value = r.driver_phone || '';
  document.getElementById('driverPhoto').value = r.driver_photo_url || '';
  document.getElementById('driverCarType').value = r.driver_car_type || '';
  document.getElementById('driverPlate').value = r.driver_plate || '';
  document.getElementById('driverRating').value = r.driver_rating ?? '';
  document.getElementById('driverEta').value = r.eta_minutes ?? '';

  document.querySelectorAll('.admin-status-actions button').forEach(b => {
    b.classList.toggle('active', b.dataset.status === r.status);
  });

  renderModalTimeline(r.status);

  document.getElementById('modalBackdrop').classList.add('show');
}

function renderModalTimeline(status) {
  const idx = Math.max(0, TIMELINE_STEPS.indexOf(status));
  const el = document.getElementById('modalTimeline');
  if (status === 'cancelled') {
    el.innerHTML = `<div class="admin-tl-step current"><span class="admin-tl-dot"></span><span>ملغاة</span></div>`;
    return;
  }
  el.innerHTML = TIMELINE_STEPS.map((step, i) => `
    <div class="admin-tl-step ${i < idx ? 'done' : ''} ${i === idx ? 'current' : ''}">
      <span class="admin-tl-dot"></span>
      <span>${STATUS_LABELS[step]}</span>
    </div>
  `).join('');
}

function closeModal() {
  document.getElementById('modalBackdrop').classList.remove('show');
  state.selectedId = null;
}

// Surfaces a save failure directly in the modal instead of only logging it
// to the console — silently swallowing errors here was the root cause of
// driver assignments appearing to "work" for the admin while never
// reaching the customer.
function showAdminError(message) {
  const el = document.getElementById('modalError');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.add('show');
  } else {
    el.textContent = '';
    el.classList.remove('show');
  }
}

async function saveDriver() {
  if (!state.selectedId) return;
  const driver_name = document.getElementById('driverName').value.trim();
  const driver_phone = document.getElementById('driverPhone').value.trim();
  const driver_photo_url = document.getElementById('driverPhoto').value.trim();
  const driver_car_type = document.getElementById('driverCarType').value.trim();
  const driver_plate = document.getElementById('driverPlate').value.trim();
  const ratingRaw = document.getElementById('driverRating').value;
  const etaRaw = document.getElementById('driverEta').value;
  const ratingNum = ratingRaw === '' ? null : Number(ratingRaw);
  const etaNum = etaRaw === '' ? null : Number(etaRaw);

  if (ratingNum !== null && Number.isNaN(ratingNum)) {
    showAdminError('التقييم يجب أن يكون رقماً.');
    return;
  }
  if (etaNum !== null && Number.isNaN(etaNum)) {
    showAdminError('الوقت المتوقع يجب أن يكون رقماً.');
    return;
  }

  // Clamp client-side before sending, so an out-of-range value never even
  // reaches the database's CHECK constraint (driver_rating 0-5, eta 0-999)
  // and silently fails the whole update.
  const driver_rating = ratingNum === null ? null : Math.min(5, Math.max(0, ratingNum));
  const eta_minutes = etaNum === null ? null : Math.min(999, Math.max(0, Math.round(etaNum)));

  // Assigning a driver to a "new" request moves it to "assigned" automatically.
  const current = state.requests.find(r => r.id === state.selectedId);
  const nextStatus = (current && current.status === 'new' && driver_name) ? 'assigned' : current?.status;

  const { error } = await supabaseClient
    .from('trip_requests')
    .update({
      driver_name, driver_phone, driver_photo_url, driver_car_type, driver_plate,
      driver_rating, eta_minutes, status: nextStatus,
    })
    .eq('id', state.selectedId);

  if (error) {
    console.error(error);
    showAdminError('تعذّر حفظ بيانات السائق: ' + error.message);
    return;
  }
  showAdminError(null);
  await loadRequests();
  const refreshed = state.requests.find(r => r.id === state.selectedId);
  if (refreshed) openDetail(refreshed.id);
}

async function updateStatus(newStatus) {
  if (!state.selectedId) return;
  const { error } = await supabaseClient
    .from('trip_requests')
    .update({ status: newStatus })
    .eq('id', state.selectedId);

  if (error) {
    console.error(error);
    showAdminError('تعذّر تحديث الحالة: ' + error.message);
    return;
  }
  showAdminError(null);
  await loadRequests();
  const refreshed = state.requests.find(r => r.id === state.selectedId);
  if (refreshed) openDetail(refreshed.id);
}

/* ============================================================
   Init
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
  document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
  document.getElementById('modalBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modalBackdrop') closeModal();
  });
  document.getElementById('assignDriverBtn').addEventListener('click', saveDriver);
  document.getElementById('savePricesBtn').addEventListener('click', savePrices);
  document.querySelectorAll('.admin-status-actions button').forEach(b => {
    b.addEventListener('click', () => updateStatus(b.dataset.status));
  });
  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.searchTerm = e.target.value.trim();
    renderTable();
  });
  document.querySelectorAll('.admin-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeFilter = btn.dataset.status;
      renderTable();
    });
  });

  // Restore an existing session on reload instead of forcing re-login every time.
  const { data } = await supabaseClient.auth.getSession();
  if (data.session) {
    state.session = data.session;
    await enterDashboard();
  }

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    state.session = session;
  });
});
