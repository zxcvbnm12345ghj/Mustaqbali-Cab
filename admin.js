// Mustaqbali Cab — Admin Panel
// Auth via Supabase Auth (email/password). Access to actual trip data is
// gated server-side by is_admin()/RLS (see schema.sql) — logging in alone
// grants nothing; the admins table is the real gate. This file only
// controls what the UI *shows*, never what the database *allows*.

const STATUS_LABELS = { new: 'جديد', assigned: 'تم التعيين', en_route: 'قيد التنفيذ', arrived: 'تم الوصول', completed: 'مكتملة', cancelled: 'ملغاة' };
const TIMELINE_STEPS = ['new', 'assigned', 'en_route', 'arrived', 'completed'];
// cargo/starx were missing from this map (pre-existing gap — the six
// service types have existed in the DB/customer app since v1.1). Only
// adding the two missing keys here; taxi/private/courier/intercity are
// untouched so no existing label anywhere in the admin panel changes.
const SERVICE_LABELS = { taxi: 'تكسي', private: 'خصوصي', courier: 'توصيل أغراض', intercity: 'بين المحافظات', cargo: 'حمل', starx: 'ستاركس' };

/* ============================================================
   Push notifications — additive only. Registers admin-sw.js
   (completely separate from driver-sw.js/sw.js), subscribes via the
   browser's Push API, and saves the subscription via
   save_admin_push_subscription() — which itself re-checks is_admin()
   server-side, so this button grants nothing on its own; it only
   works for an already-authenticated admin, same as every other
   action in this file. Does not touch polling, playAlertSound(), or
   any existing function — push is a second, independent channel on
   top of the existing in-tab 3s-poll alert, not a replacement.
   ============================================================ */
const VAPID_PUBLIC_KEY = 'BA_mwRbHk_BXqtt8PKCma9oaAbuQVAoYNvNvtTmq2L8bcWTPakSgiU4AuDZKpo6NCpKCRzXM2gFaZ5QIA6s5_ww';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function setupAdminPushNotifications() {
  const btn = document.getElementById('enablePushBtn');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    if (btn) { btn.textContent = 'الإشعارات غير مدعومة بهذا المتصفح'; btn.disabled = true; }
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register('admin-sw.js');
    let permission = Notification.permission;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      if (btn) btn.textContent = 'تم رفض إذن الإشعارات';
      return;
    }

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const { error } = await supabaseClient.rpc('save_admin_push_subscription', {
      p_subscription: subscription.toJSON(),
    });
    if (error) throw error;

    if (btn) { btn.textContent = '🔔 الإشعارات مفعّلة'; btn.disabled = true; }
  } catch (err) {
    console.error('admin push setup failed', err);
    if (btn) btn.textContent = 'تعذّر تفعيل الإشعارات';
  }
}

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
  stopRequestPolling();
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
  await loadDriverStats();
  await loadAds();
  startRequestPolling();
}

/* ============================================================
   Polling — checks for new trip_requests every 3s (no Realtime,
   no Broadcast). Uses request IDs (not client-clock timestamps)
   to detect new rows, so it isn't affected by any time skew
   between the user's device and the Supabase server. Additive
   only: no other function, markup, styling, or login behavior
   is touched.
   ============================================================ */
let pollIntervalId = null;
const seenRequestIds = new Set();

function startRequestPolling() {
  // Seed with whatever loadRequests() already fetched, so existing rows
  // never trigger a sound — only genuinely new ones after this point do.
  seenRequestIds.clear();
  state.requests.forEach((r) => seenRequestIds.add(r.id));

  if (pollIntervalId) clearInterval(pollIntervalId);
  pollIntervalId = setInterval(checkForNewRequests, 3000);
}

function stopRequestPolling() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

async function checkForNewRequests() {
  const { data, error } = await supabaseClient
    .from('trip_requests')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error || !data) return;

  const newIds = data.filter((r) => !seenRequestIds.has(r.id));
  if (newIds.length === 0) return;

  newIds.forEach((r) => seenRequestIds.add(r.id));
  playAlertSound();
  loadRequests();
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
   Driver stats — real counts (today/selected-day + total) per
   driver. Read-only reporting: queries the same trip_requests and
   drivers tables the rest of this admin panel already reads (same
   RLS/is_admin() policies, no schema changes). Matched by phone
   number (drivers.phone = trip_requests.driver_phone), since
   trip_requests has no driver_id foreign key — the admin assigns a
   driver to a request by typing their name/phone in the modal, not
   by picking from the roster. This never writes to, or reads from,
   the separate queue/rotation system (drivers.request_count,
   select_driver(), get_front_driver(), get_service_drivers()) —
   those stay exactly as they are.
   ============================================================ */
const driverStatsState = {
  selectedDate: null, // 'YYYY-MM-DD', local calendar date
};

function todayDateStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// [start, end) ISO bounds for a local calendar date, so "today" always
// means the admin's own local day rather than the UTC day.
function dayBoundsIso(dateStr) {
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

async function loadDriversRoster() {
  const { data, error } = await supabaseClient
    .from('drivers')
    .select('id, name, phone, service_type, active')
    .order('name', { ascending: true });
  if (error) {
    console.error(error);
    return null;
  }
  return data || [];
}

/* ============================================================
   Add new driver — writes straight into the drivers table (same
   table loadDriversRoster() above already reads). Purely additive:
   does not touch trip_requests, the queue/rotation system
   (drivers.request_count, select_driver(), get_front_driver(),
   get_service_drivers()), booking, services, or map/location.
   ============================================================ */
function populateDriverServiceSelect() {
  const sel = document.getElementById('newDriverService');
  if (!sel) return;
  sel.innerHTML = '<option value="">اختر الخدمة</option>' +
    Object.entries(SERVICE_LABELS).map(([key, label]) =>
      `<option value="${escapeAttr(key)}">${escapeHtml(label)}</option>`
    ).join('');
}

async function addDriver() {
  const errEl = document.getElementById('driverAddError');
  if (errEl) { errEl.textContent = ''; errEl.classList.remove('show'); }

  const nameEl = document.getElementById('newDriverName');
  const phoneEl = document.getElementById('newDriverPhone');
  const carTypeEl = document.getElementById('newDriverCarType');
  const serviceEl = document.getElementById('newDriverService');

  const name = nameEl.value.trim();
  const phone = phoneEl.value.trim();
  const car_type = carTypeEl.value.trim();
  const service_type = serviceEl.value;

  if (!name || !phone || !service_type) {
    if (errEl) {
      errEl.textContent = 'الاسم، رقم الجوال، والخدمة حقول مطلوبة.';
      errEl.classList.add('show');
    }
    return;
  }

  const btn = document.getElementById('addDriverBtn');
  if (btn) btn.disabled = true;

  const { error } = await supabaseClient
    .from('drivers')
    .insert({ name, phone, service_type, vehicle_type: car_type || null, active: true });

  if (btn) btn.disabled = false;

  if (error) {
    console.error(error);
    if (errEl) {
      errEl.textContent = 'تعذّر إضافة السائق: ' + error.message;
      errEl.classList.add('show');
    }
    return;
  }

  nameEl.value = '';
  phoneEl.value = '';
  carTypeEl.value = '';
  serviceEl.value = '';

  // New driver should appear immediately in the roster/stats table below.
  await loadDriverStats(driverStatsState.selectedDate);
}

// A real count() query against trip_requests — never an estimate, never
// a cached/local number. dateStr omitted = all-time total.
async function countDriverRequests(phone, dateStr) {
  if (!phone) return 0;
  let query = supabaseClient
    .from('trip_requests')
    .select('id', { count: 'exact', head: true })
    .eq('driver_phone', phone);

  if (dateStr) {
    const { startIso, endIso } = dayBoundsIso(dateStr);
    query = query.gte('created_at', startIso).lt('created_at', endIso);
  }

  const { count, error } = await query;
  if (error) {
    console.error(error);
    return 0;
  }
  return count || 0;
}

async function loadDriverStats(dateStr) {
  const selectedDate = dateStr || driverStatsState.selectedDate || todayDateStr();
  driverStatsState.selectedDate = selectedDate;

  const dateInput = document.getElementById('driverStatsDate');
  if (dateInput) {
    dateInput.value = selectedDate;
    dateInput.max = todayDateStr();
  }
  const colLabel = document.getElementById('driverStatsDateColLabel');
  if (colLabel) {
    colLabel.textContent = selectedDate === todayDateStr() ? 'طلبات اليوم' : `طلبات ${selectedDate}`;
  }

  const body = document.getElementById('driverStatsBody');
  const empty = document.getElementById('driverStatsEmpty');
  const loading = document.getElementById('driverStatsLoading');
  if (empty) empty.style.display = 'none';
  if (loading) { loading.style.display = 'block'; loading.textContent = 'جارٍ الحساب...'; }
  if (body) body.innerHTML = '';

  const drivers = await loadDriversRoster();

  if (drivers === null) {
    if (loading) loading.style.display = 'none';
    if (empty) { empty.style.display = 'block'; empty.textContent = 'تعذّر تحميل السائقين. تأكد من صلاحيات حسابك.'; }
    return;
  }

  if (drivers.length === 0) {
    if (loading) loading.style.display = 'none';
    if (empty) { empty.style.display = 'block'; empty.textContent = 'لا يوجد سائقون مسجّلون بعد.'; }
    return;
  }

  const rows = await Promise.all(drivers.map(async (d) => {
    const [dayCount, totalCount] = await Promise.all([
      countDriverRequests(d.phone, selectedDate),
      countDriverRequests(d.phone),
    ]);
    return { ...d, dayCount, totalCount };
  }));

  if (loading) loading.style.display = 'none';
  if (!body) return;

  body.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.name)}${r.active ? '' : ' <span class="opt">(غير نشط)</span>'}</td>
      <td>${escapeHtml(r.phone)}</td>
      <td>${escapeHtml(SERVICE_LABELS[r.service_type] || r.service_type)}</td>
      <td>${r.dayCount}</td>
      <td>${r.totalCount}</td>
    </tr>
  `).join('');
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
  // Driver assignment can change which driver a request counts toward —
  // refresh the stats table so the numbers stay accurate. Non-blocking:
  // doesn't delay the modal/detail view refresh above.
  loadDriverStats(driverStatsState.selectedDate);
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
   Customer Ads — إدارة الإعلانات (additive only). Direct CRUD on
   customer_ads (same pattern as drivers/service_prices — admin-only
   RLS policies in migrations/migration_customer_ads.sql), plus an
   on-demand push via the new queue_customer_ads_push() RPC. Does not
   touch trip_requests, drivers, GPS, or the existing admin/driver
   push tables/queue in any way.
   ============================================================ */
const adsState = {
  ads: [],
  editingId: null,
};

const AD_TYPE_LABELS = { scheduled: 'مجدول', daily: 'يومي' };

async function loadAds() {
  const { data, error } = await supabaseClient
    .from('customer_ads')
    .select('*')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) {
    console.error(error);
    return;
  }
  adsState.ads = data || [];
  renderAdsTable();
}

function formatAdSchedule(ad) {
  if (ad.ad_type === 'daily') {
    const start = ad.daily_start_time ? ad.daily_start_time.slice(0, 5) : null;
    const end = ad.daily_end_time ? ad.daily_end_time.slice(0, 5) : null;
    const timeRange = (start && end) ? `${start} - ${end}` : 'طوال اليوم';
    const dateRange = (ad.starts_at || ad.ends_at)
      ? ` (${ad.starts_at ? formatDate(ad.starts_at) : '—'} → ${ad.ends_at ? formatDate(ad.ends_at) : '—'})`
      : '';
    return `يومياً ${timeRange}${dateRange}`;
  }
  if (!ad.starts_at && !ad.ends_at) return 'بدون حدود زمنية';
  return `${ad.starts_at ? formatDate(ad.starts_at) : '—'} → ${ad.ends_at ? formatDate(ad.ends_at) : '—'}`;
}

function renderAdsTable() {
  const body = document.getElementById('adsBody');
  const empty = document.getElementById('adsEmpty');
  if (!body) return;

  if (!adsState.ads.length) {
    body.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  body.innerHTML = adsState.ads.map(ad => `
    <tr data-ad-id="${escapeAttr(ad.id)}">
      <td>${escapeHtml(ad.title)}</td>
      <td><span class="ads-type-badge ${escapeAttr(ad.ad_type)}">${escapeHtml(AD_TYPE_LABELS[ad.ad_type] || ad.ad_type)}</span></td>
      <td>${escapeHtml(formatAdSchedule(ad))}</td>
      <td>${escapeHtml(ad.display_seconds)} ث</td>
      <td><span class="ads-active-badge ${ad.active ? '' : 'off'}" data-ad-toggle="${escapeAttr(ad.id)}" style="cursor:pointer;">${ad.active ? 'نشط' : 'موقوف'}</span></td>
      <td class="ads-row-actions">
        <button type="button" class="primary" data-ad-edit="${escapeAttr(ad.id)}">تعديل</button>
        <button type="button" class="danger" data-ad-delete="${escapeAttr(ad.id)}">حذف</button>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-ad-edit]').forEach(btn => {
    btn.addEventListener('click', () => openAdModal(adsState.ads.find(a => a.id === btn.dataset.adEdit)));
  });
  body.querySelectorAll('[data-ad-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteAd(btn.dataset.adDelete));
  });
  body.querySelectorAll('[data-ad-toggle]').forEach(el => {
    el.addEventListener('click', () => toggleAdActive(el.dataset.adToggle));
  });
}

async function toggleAdActive(id) {
  const ad = adsState.ads.find(a => a.id === id);
  if (!ad) return;
  const { error } = await supabaseClient
    .from('customer_ads')
    .update({ active: !ad.active })
    .eq('id', id);
  if (error) {
    console.error(error);
    return;
  }
  await loadAds();
}

// ISO timestamptz (UTC, e.g. "2026-06-01T10:00:00+00:00") -> value a
// <input type="datetime-local"> understands ("YYYY-MM-DDTHH:mm", in the
// admin's own local time — the browser already renders/parses that
// input in local time, so no separate timezone math is needed here).
function isoToDatetimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// <input type="datetime-local"> value -> ISO string for Postgres
// timestamptz, or null if left empty (both bounds are optional).
function datetimeLocalValueToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toggleAdTypeFields() {
  const type = document.getElementById('adType').value;
  document.getElementById('adScheduledFields').hidden = type !== 'scheduled';
  document.getElementById('adDailyFields').hidden = type !== 'daily';
}

function openAdModal(ad) {
  adsState.editingId = ad ? ad.id : null;
  document.getElementById('adModalTitle').textContent = ad ? 'تعديل إعلان' : 'إضافة إعلان';
  document.getElementById('adTitle').value = ad?.title || '';
  document.getElementById('adBody').value = ad?.body || '';
  document.getElementById('adImageUrl').value = ad?.image_url || '';
  document.getElementById('adLinkUrl').value = ad?.link_url || '';
  document.getElementById('adDisplaySeconds').value = ad?.display_seconds ?? 6;
  document.getElementById('adType').value = ad?.ad_type || 'scheduled';
  document.getElementById('adStartsAt').value = isoToDatetimeLocalValue(ad?.starts_at);
  document.getElementById('adEndsAt').value = isoToDatetimeLocalValue(ad?.ends_at);
  document.getElementById('adDailyStart').value = ad?.daily_start_time ? ad.daily_start_time.slice(0, 5) : '';
  document.getElementById('adDailyEnd').value = ad?.daily_end_time ? ad.daily_end_time.slice(0, 5) : '';
  document.getElementById('adActive').checked = ad ? !!ad.active : true;
  toggleAdTypeFields();

  const deleteBtn = document.getElementById('deleteAdBtn');
  const pushBtn = document.getElementById('sendAdPushBtn');
  if (deleteBtn) deleteBtn.hidden = !ad;
  if (pushBtn) pushBtn.hidden = !ad;

  const errEl = document.getElementById('adModalError');
  if (errEl) { errEl.textContent = ''; errEl.classList.remove('show'); }
  const pushMsgEl = document.getElementById('adPushMsg');
  if (pushMsgEl) { pushMsgEl.textContent = ''; pushMsgEl.classList.remove('show'); }

  document.getElementById('adModalBackdrop').classList.add('show');
}

function closeAdModal() {
  document.getElementById('adModalBackdrop').classList.remove('show');
  adsState.editingId = null;
}

function showAdModalError(message) {
  const el = document.getElementById('adModalError');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.add('show');
  } else {
    el.textContent = '';
    el.classList.remove('show');
  }
}

async function saveAd() {
  showAdModalError(null);

  const title = document.getElementById('adTitle').value.trim();
  const bodyText = document.getElementById('adBody').value.trim();
  const image_url = document.getElementById('adImageUrl').value.trim();
  const link_url = document.getElementById('adLinkUrl').value.trim();
  const displayRaw = document.getElementById('adDisplaySeconds').value;
  const ad_type = document.getElementById('adType').value;
  const starts_at = datetimeLocalValueToIso(document.getElementById('adStartsAt').value);
  const ends_at = datetimeLocalValueToIso(document.getElementById('adEndsAt').value);
  const dailyStartRaw = document.getElementById('adDailyStart').value;
  const dailyEndRaw = document.getElementById('adDailyEnd').value;
  const active = document.getElementById('adActive').checked;

  if (!title) {
    showAdModalError('العنوان مطلوب.');
    return;
  }
  const display_seconds = Number(displayRaw);
  if (Number.isNaN(display_seconds) || display_seconds < 2 || display_seconds > 60) {
    showAdModalError('مدة العرض يجب أن تكون رقماً بين 2 و60 ثانية.');
    return;
  }
  if (starts_at && ends_at && new Date(starts_at) > new Date(ends_at)) {
    showAdModalError('تاريخ البداية يجب أن يكون قبل تاريخ النهاية.');
    return;
  }
  if (ad_type === 'daily' && dailyStartRaw && dailyEndRaw === '') {
    showAdModalError('حدّد وقت النهاية اليومي أيضاً، أو اترك كلا الحقلين فارغين.');
    return;
  }

  const payload = {
    title,
    body: bodyText || null,
    image_url: image_url || null,
    link_url: link_url || null,
    display_seconds,
    ad_type,
    starts_at,
    ends_at,
    daily_start_time: ad_type === 'daily' && dailyStartRaw ? dailyStartRaw : null,
    daily_end_time: ad_type === 'daily' && dailyEndRaw ? dailyEndRaw : null,
    active,
  };

  const saveBtn = document.getElementById('saveAdBtn');
  if (saveBtn) saveBtn.disabled = true;

  const query = adsState.editingId
    ? supabaseClient.from('customer_ads').update(payload).eq('id', adsState.editingId)
    : supabaseClient.from('customer_ads').insert(payload);
  const { error } = await query;

  if (saveBtn) saveBtn.disabled = false;

  if (error) {
    console.error(error);
    showAdModalError('تعذّر حفظ الإعلان: ' + error.message);
    return;
  }

  await loadAds();
  closeAdModal();
}

async function deleteAd(id) {
  if (!id) return;
  if (!confirm('حذف هذا الإعلان نهائياً؟')) return;
  const { error } = await supabaseClient.from('customer_ads').delete().eq('id', id);
  if (error) {
    console.error(error);
    alert('تعذّر حذف الإعلان: ' + error.message);
    return;
  }
  if (adsState.editingId === id) closeAdModal();
  await loadAds();
}

// "Push إعلاني للزبائن عند الحاجة" — on demand only, never automatic.
// Queues into the brand-new ad_push_queue (see migration_customer_ads.sql);
// a separate scheduled Edge Function (send-customer-ads-push.ts) delivers
// it. Never touches push_notifications_queue (admin/driver).
async function sendAdPush() {
  if (!adsState.editingId) return;
  const ad = adsState.ads.find(a => a.id === adsState.editingId);
  if (!ad) return;

  const pushMsgEl = document.getElementById('adPushMsg');
  const pushBtn = document.getElementById('sendAdPushBtn');
  if (pushMsgEl) { pushMsgEl.textContent = ''; pushMsgEl.classList.remove('show'); }
  if (pushBtn) pushBtn.disabled = true;

  const { error } = await supabaseClient.rpc('queue_customer_ads_push', {
    p_ad_id: ad.id,
    p_title: ad.title,
    p_body: ad.body || ad.title,
    p_url: ad.link_url || '/index.html',
  });

  if (pushBtn) pushBtn.disabled = false;

  if (error) {
    console.error(error);
    showAdModalError('تعذّر جدولة الإشعار: ' + error.message);
    return;
  }
  if (pushMsgEl) {
    pushMsgEl.textContent = 'تم جدولة الإشعار — سيصل للزبائن المشتركين خلال ثوانٍ.';
    pushMsgEl.classList.add('show');
  }
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
  document.getElementById('enablePushBtn')?.addEventListener('click', setupAdminPushNotifications);
  document.getElementById('savePricesBtn').addEventListener('click', savePrices);
  document.getElementById('addAdBtn')?.addEventListener('click', () => openAdModal(null));
  document.getElementById('adModalCloseBtn')?.addEventListener('click', closeAdModal);
  document.getElementById('adModalBackdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'adModalBackdrop') closeAdModal();
  });
  document.getElementById('adType')?.addEventListener('change', toggleAdTypeFields);
  document.getElementById('saveAdBtn')?.addEventListener('click', saveAd);
  document.getElementById('deleteAdBtn')?.addEventListener('click', () => deleteAd(adsState.editingId));
  document.getElementById('sendAdPushBtn')?.addEventListener('click', sendAdPush);
  document.getElementById('driverStatsDate').addEventListener('change', (e) => {
    if (e.target.value) loadDriverStats(e.target.value);
  });
  document.getElementById('driverStatsTodayBtn').addEventListener('click', () => loadDriverStats(todayDateStr()));
  document.getElementById('driverStatsRefreshBtn').addEventListener('click', () => loadDriverStats(driverStatsState.selectedDate));
  populateDriverServiceSelect();
  document.getElementById('addDriverBtn').addEventListener('click', addDriver);
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
