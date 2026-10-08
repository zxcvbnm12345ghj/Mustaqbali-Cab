// Yammak — Admin Panel
// Auth via Supabase Auth (email/password). Access to actual trip data is
// gated server-side by is_admin()/RLS (see schema.sql) — logging in alone
// grants nothing; the admins table is the real gate. This file only
// controls what the UI *shows*, never what the database *allows*.

const STATUS_LABELS = { new: 'جديد', assigned: 'تم التعيين', accepted: 'تم القبول', en_route: 'قيد التنفيذ', arrived: 'تم الوصول', completed: 'مكتملة', cancelled: 'ملغاة' };
const TIMELINE_STEPS = ['new', 'assigned', 'accepted', 'en_route', 'arrived', 'completed'];
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
   Dashboard tabs — purely a display toggle between the panels
   already present in admin.html (#tabPanel-home/drivers/requests/
   ads/settings). Does not load or query anything on its own; each
   panel's own existing load function (loadRequests/loadPrices/
   loadDriverStats/loadAds) still runs from enterDashboard() as
   before, regardless of which tab is currently visible.
   ============================================================ */
function switchTab(tab) {
  document.querySelectorAll('.admin-tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.tabPanel === tab);
  });
  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
}

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
  boardState.rows = [];
  boardState.selected.clear();
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
  await loadUnlinkedDrivers();
  await loadAds();
  await loadPlaces('restaurants');
  await loadPlaces('markets');
  await loadPlaces('futureOffice');
  await loadLocalServicesTab();
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
    .select('id, name, phone, service_type, active, driver_token')
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

  // Each driver row is clickable — expands an inline row right below it
  // showing that driver's requests (filtered from state.requests, already
  // loaded by loadRequests()). No new page, tab, or Supabase query.
  body.innerHTML = rows.map(r => `
    <tr class="driver-row" data-driver-phone="${escapeAttr(r.phone)}">
      <td>${escapeHtml(r.name)}${r.active ? '' : ' <span class="opt">(غير نشط)</span>'}</td>
      <td>${escapeHtml(r.phone)}</td>
      <td>${escapeHtml(SERVICE_LABELS[r.service_type] || r.service_type)}</td>
      <td>${r.dayCount}</td>
      <td>${r.totalCount}</td>
      <td>
        <div class="driver-link-cell">
          <span class="driver-link-text" title="${escapeAttr(r.driver_token ? buildDriverLink(r.driver_token) : '')}">${r.driver_token ? escapeHtml(buildDriverLink(r.driver_token)) : '<span class="opt">سيُنشأ عند الضغط على نسخ</span>'}</span>
          <button type="button" class="admin-btn ghost driver-copy-link-btn"
            data-driver-id="${escapeAttr(r.id)}"
            style="width:auto; padding:6px 12px; font-size:12.5px;">نسخ رابط السائق</button>
        </div>
      </td>
    </tr>
    <tr class="driver-requests-row" data-driver-requests-for="${escapeAttr(r.phone)}" hidden>
      <td colspan="6"></td>
    </tr>
  `).join('');

  body.querySelectorAll('tr.driver-row').forEach(tr => {
    tr.addEventListener('click', () => toggleDriverRequests(tr.dataset.driverPhone));
  });

  // Copy-link buttons live inside the clickable driver row, so stop the
  // click from bubbling up and toggling the requests panel below.
  body.querySelectorAll('button.driver-copy-link-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // String() on both sides: harmless if drivers.id is already
      // uuid/text (comparison stays string-to-string, unchanged
      // behavior), but fixes a silent lookup failure if drivers.id is
      // a numeric type — dataset.driverId is always a string, so
      // `r.id === btn.dataset.driverId` would otherwise always be
      // false (number !== string) and silently no-op the button.
      const driver = rows.find(r => String(r.id) === btn.dataset.driverId);
      if (driver) copyDriverLink(driver, btn);
    });
  });
}

/* ============================================================
   Driver login accounts (phone + password) — additive only. Calls
   the create-driver-account Edge Function, which alone holds
   service_role and re-verifies this admin's identity server-side via
   their own JWT + is_admin(). supabaseClient.functions.invoke()
   attaches that JWT automatically from the current session — same
   supabaseClient instance as every other call in this file, no
   separate fetch()/URL wiring needed. This file never sees or sends
   service_role. Does not touch driver_token, driverStatsState/
   loadDriversRoster above, GPS, requests, or any existing RPC/RLS.
   ============================================================ */
const createAccountState = {
  drivers: [], // active drivers with no linked account yet — { id, name, phone }
};

// Same normalization as normalizeIraqiPhone() in driver.js and in the
// Edge Function (duplicated deliberately — three separate runtimes,
// no shared import). Used here only for an immediate client-side
// check before calling the function; the function itself re-
// normalizes and is the real authority.
function normalizeIraqiPhone(raw) {
  if (!raw) return null;
  let digits = raw.trim().replace(/[\s\-()]/g, '');
  digits = digits.replace(/^00/, '+');
  if (digits.startsWith('+964')) {
    digits = digits.slice(4);
  } else if (digits.startsWith('964')) {
    digits = digits.slice(3);
  } else if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  if (!/^7\d{9}$/.test(digits)) return null;
  return '+964' + digits;
}

async function loadUnlinkedDrivers() {
  const { data, error } = await supabaseClient
    .from('drivers')
    .select('id, name, phone')
    .eq('active', true)
    .is('auth_user_id', null)
    .order('name', { ascending: true });

  createAccountState.drivers = error ? [] : (data || []);
  if (error) console.error(error);
  renderCreateAccountDriverSelect();
}

function renderCreateAccountDriverSelect() {
  const sel = document.getElementById('createAccountDriverSelect');
  if (!sel) return;
  const previousValue = sel.value;
  sel.innerHTML = '<option value="">اختر السائق...</option>' +
    createAccountState.drivers.map(d =>
      `<option value="${escapeAttr(d.id)}">${escapeHtml(d.name)} (${escapeHtml(d.phone)})</option>`
    ).join('');
  if (createAccountState.drivers.some(d => String(d.id) === previousValue)) {
    sel.value = previousValue;
  }
}

function handleCreateAccountDriverSelect() {
  const sel = document.getElementById('createAccountDriverSelect');
  const phoneEl = document.getElementById('createAccountPhone');
  if (!sel || !phoneEl) return;
  const driver = createAccountState.drivers.find(d => String(d.id) === sel.value);
  phoneEl.value = driver ? driver.phone : '';
}

function showCreateAccountError(message) {
  const el = document.getElementById('createAccountError');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.add('show');
  } else {
    el.textContent = '';
    el.classList.remove('show');
  }
}

function showCreateAccountSuccess(message) {
  const el = document.getElementById('createAccountSuccessMsg');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.add('show');
  } else {
    el.textContent = '';
    el.classList.remove('show');
  }
}

async function handleCreateDriverAccount() {
  showCreateAccountError(null);
  showCreateAccountSuccess(null);

  const sel = document.getElementById('createAccountDriverSelect');
  const phoneEl = document.getElementById('createAccountPhone');
  const passEl = document.getElementById('createAccountPassword');
  const btn = document.getElementById('createDriverAccountBtn');

  const driver_id = sel ? sel.value : '';
  const rawPhone = phoneEl ? phoneEl.value.trim() : '';
  const password = passEl ? passEl.value : '';

  if (!driver_id) {
    showCreateAccountError('اختر السائق أولًا.');
    return;
  }
  const phone = normalizeIraqiPhone(rawPhone);
  if (!phone) {
    showCreateAccountError('رقم الهاتف غير صحيح. أدخله بصيغة 07XXXXXXXXX.');
    return;
  }
  if (!password || password.length < 8) {
    showCreateAccountError('كلمة المرور يجب أن تكون ٨ أحرف على الأقل.');
    return;
  }

  if (btn) btn.disabled = true;

  const { data, error } = await supabaseClient.functions.invoke('create-driver-account', {
    body: { driver_id, phone, password },
  });

  if (btn) btn.disabled = false;

  // functions.invoke() sets `error` on a network failure or a non-2xx
  // response; the function's own JSON body (its { error: '...' } shape
  // on 4xx/5xx, or { success, ... } on 200) is still read from `data`
  // where available — checked defensively so a failure always shows a
  // real message instead of a blank one.
  if (error || !data?.success) {
    console.error('create-driver-account failed', error, data);
    showCreateAccountError(data?.error || error?.message || 'تعذّر إنشاء الحساب.');
    return;
  }

  // Success — the password is never shown again or stored client-side.
  if (passEl) passEl.value = '';
  if (phoneEl) phoneEl.value = '';
  if (sel) sel.value = '';
  showCreateAccountSuccess(`تم إنشاء حساب الدخول بنجاح${data.phone ? ' (' + data.phone + ')' : ''}.`);

  // Minimal refresh: this driver is linked now, so drop them from the
  // selectable list. Does not touch driverStatsTable/loadDriverStats.
  await loadUnlinkedDrivers();
}

/* ============================================================
   Driver link — builds and copies the single "secret link" a driver
   opens on their phone (driver.html?driver_token=...) to start sending
   GPS. The token is the driver's only credential (see driver.js), never
   a system secret/API key, so it's safe to have client-side and to put
   in a plain URL — same design already documented in driver.js.
   Unified naming (chat decision): the column is drivers.driver_token
   (matching the live database, and what update_driver_location /
   save_driver_push_subscription already look up internally — those two
   functions are untouched here, only their own p_token *parameter*
   name stays as-is). Every driver already gets a driver_token
   automatically at creation time (drivers.driver_token default in
   schema.sql); the fallback branch below only covers an already-
   existing row that somehow has none, and it NEVER overwrites a
   driver_token that's already set (requirement: don't regenerate an
   existing driver's link).
   ============================================================ */
function buildDriverLink(token) {
  // driver.html is assumed to live next to admin.html (same project
  // root), matching how the app already ships its pages.
  return new URL('driver.html', window.location.href).toString() +
    '?driver_token=' + encodeURIComponent(token);
}

async function copyDriverLink(driver, btn) {
  // Build the link directly from driver_token already loaded in memory
  // (from loadDriversRoster(), via loadDriverStats()) — no extra
  // Supabase query on every click. Only the "no token yet" fallback
  // below still talks to Supabase, to create and persist one.
  let token = driver.driver_token;

  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/-/g, '');
    const { error } = await supabaseClient
      .from('drivers')
      .update({ driver_token: token })
      .eq('id', driver.id);
    if (error) {
      console.error(error);
      alert('تعذّر إنشاء رابط السائق: ' + error.message);
      return;
    }
    driver.driver_token = token; // keep in-memory row in sync for subsequent clicks

    // Reflect the newly-created token in the visible link cell right away.
    const cell = btn ? btn.closest('.driver-link-cell') : null;
    const textEl = cell ? cell.querySelector('.driver-link-text') : null;
    if (textEl) {
      textEl.textContent = buildDriverLink(token);
      textEl.title = buildDriverLink(token);
    }
  }

  const link = buildDriverLink(token);

  try {
    await navigator.clipboard.writeText(link);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = 'تم النسخ ✓';
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
  } catch (err) {
    // Clipboard API can fail (no HTTPS, permissions, older browser) —
    // fall back to a manual-copy prompt so the admin still gets the link.
    window.prompt('انسخ رابط السائق يدويًا:', link);
  }
}

/* ============================================================
   Inline "طلبات كل سائق" — expands under the clicked driver row
   inside the السائقون tab itself. Purely a client-side filter over
   state.requests (already loaded by loadRequests()) matched by
   driver_phone, same matching key driver stats above already use.
   No new query, no new page, no new tab.
   ============================================================ */
function toggleDriverRequests(phone) {
  const detailRow = document.querySelector(
    `tr.driver-requests-row[data-driver-requests-for="${CSS.escape(phone)}"]`
  );
  if (!detailRow) return;
  const wasHidden = detailRow.hidden;

  // Keep it simple — only one driver's requests open at a time.
  document.querySelectorAll('tr.driver-requests-row').forEach(row => { row.hidden = true; });
  document.querySelectorAll('tr.driver-row').forEach(row => row.classList.remove('open'));

  if (wasHidden) {
    detailRow.hidden = false;
    const driverRow = document.querySelector(`tr.driver-row[data-driver-phone="${CSS.escape(phone)}"]`);
    if (driverRow) driverRow.classList.add('open');
    renderDriverRequestsPanel(detailRow, phone);
  }
}

function renderDriverRequestsPanel(detailRow, phone) {
  const cell = detailRow.querySelector('td');
  if (!cell) return;
  const rows = state.requests.filter(r => r.driver_phone === phone);

  if (rows.length === 0) {
    cell.innerHTML = `<div class="driver-requests-empty">لا توجد طلبات مرتبطة بهذا السائق ضمن الطلبات المحمّلة حالياً.</div>`;
    return;
  }

  cell.innerHTML = `
    <div class="driver-requests-wrap">
      <table class="admin-table driver-requests-table">
        <thead>
          <tr>
            <th>رقم الطلب</th>
            <th>الخدمة</th>
            <th>العميل</th>
            <th>الحالة</th>
            <th>التاريخ</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr class="clickable" data-id="${escapeAttr(r.id)}">
              <td>${escapeHtml(r.request_number || r.id.slice(0, 8))}</td>
              <td>${escapeHtml(SERVICE_LABELS[r.service_type] || r.service_type)}</td>
              <td>${escapeHtml(r.customer_name)}</td>
              <td><span class="status-pill ${escapeAttr(r.status)}">${escapeHtml(STATUS_LABELS[r.status] || r.status)}</span></td>
              <td>${escapeHtml(formatDate(r.created_at))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  // Opens the existing trip detail modal (same modal the "الطلبات" tab
  // uses) — still the same page, no new tab/window.
  cell.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      e.stopPropagation();
      openDetail(tr.dataset.id);
    });
  });
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
  refreshServiceBoard(); // per-service boards (see "Service boards" section)
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
   Driver-assignment dropdown (fix: link by drivers.phone exactly).
   get_driver_current_trip() and queue_driver_push_on_assignment()
   both join trip_requests.driver_phone = drivers.phone by exact
   string equality (confirmed by reading both definitions directly
   in the database). The old free-text #driverPhone input let the
   admin type any string, so a stray space/format difference between
   what was typed and the driver's real drivers.phone silently broke
   that match: the trip still showed fine here (no join needed to
   just display trip_requests), but it never reached the driver's own
   app or push notification. This replaces that input with a
   <select> built from loadDriversRoster() — the same data already
   used by the driver-stats table above — so the saved driver_phone
   is always byte-identical to drivers.phone.

   Purely additive to the save path: saveDriver() below is completely
   unchanged, it still just reads #driverPhone / #driverName's
   .value — a native <select> has the same .value property as an
   <input>, so nothing downstream needed to change.
   ============================================================ */
let assignDriverRoster = [];

// Turns the original free-text <input id="driverPhone"> into a
// <select id="driverPhone"> once, at startup. Keeping the same id
// means saveDriver()/openDetail() keep working completely unchanged.
function convertDriverPhoneFieldToSelect() {
  const oldInput = document.getElementById('driverPhone');
  if (!oldInput || oldInput.tagName === 'SELECT') return;
  const select = document.createElement('select');
  select.id = 'driverPhone';
  select.className = oldInput.className;
  oldInput.parentNode.replaceChild(select, oldInput);

  select.addEventListener('change', () => {
    const nameEl = document.getElementById('driverName');
    if (!nameEl) return;
    const match = assignDriverRoster.find(d => d.phone === select.value);
    if (match) {
      nameEl.value = match.name;
    } else if (!select.value) {
      nameEl.value = '';
    }
    // else: the "unmatched legacy value" option is selected — leave
    // whatever name is already showing untouched.
  });
}

// Rebuilds the <select>'s options from the live drivers roster and
// selects currentPhone. If currentPhone was saved before this fix and
// doesn't exactly match any driver, it's kept as its own clearly-
// labeled option instead of silently reverting to blank — the stored
// value itself is never touched here, only how it's displayed, until
// the admin explicitly changes the selection and saves.
async function populateDriverAssignSelect(currentPhone) {
  const select = document.getElementById('driverPhone');
  if (!select) return;

  // Only drivers of the SAME service as the open request are offered
  // (drivers.service_type === trip_requests.service_type). Active/inactive
  // handling is unchanged: inactive drivers of that service still show,
  // labelled "(غير نشط)". How driver_phone is saved is untouched.
  const openRequest = findRequestById(state.selectedId);
  const allDrivers = (await loadDriversRoster()) || [];
  assignDriverRoster = openRequest
    ? allDrivers.filter(d => d.service_type === openRequest.service_type)
    : [];

  const options = ['<option value="">— بلا سائق —</option>'].concat(
    assignDriverRoster.map(d =>
      `<option value="${escapeAttr(d.phone)}">${escapeHtml(d.name)} — ${escapeHtml(d.phone)}${d.active ? '' : ' (غير نشط)'}</option>`
    )
  );

  const hasExactMatch = !!currentPhone && assignDriverRoster.some(d => d.phone === currentPhone);
  if (currentPhone && !hasExactMatch) {
    options.push(
      `<option value="${escapeAttr(currentPhone)}">${escapeHtml(currentPhone)} (غير مطابق لأي سائق مسجّل)</option>`
    );
  }

  select.innerHTML = options.join('');
  select.value = currentPhone || '';
}

/* ============================================================
   Detail modal
   ============================================================ */
async function openDetail(id) {
  const r = findRequestById(id);
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
  await populateDriverAssignSelect(r.driver_phone || '');
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
  const current = findRequestById(state.selectedId);
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
  const refreshed = findRequestById(state.selectedId);
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
  const refreshed = findRequestById(state.selectedId);
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
  adImageWidget.open(ad?.image_url || '');
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
  adImageWidget.discard();
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

  await adImageWidget.finalize(payload.image_url);
  await loadAds();
  closeAdModal();
}

async function deleteAd(id) {
  if (!id) return;
  if (!confirm('حذف هذا الإعلان نهائياً؟')) return;
  const oldImageUrl = (adsState.ads.find(a => a.id === id) || {}).image_url || '';
  const { error } = await supabaseClient.from('customer_ads').delete().eq('id', id);
  if (error) {
    console.error(error);
    alert('تعذّر حذف الإعلان: ' + error.message);
    return;
  }
  if (oldImageUrl) await removeStoredImageIfOurs('ad-images', oldImageUrl);
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
   Real image upload (Supabase Storage) — المطاعم / الأسواق / مكتب
   المستقبل (bucket "place-images": restaurants/, markets/,
   future-office/) والإعلانات (bucket "ad-images": ads/).
   Additive only. Public read / admin-only write (policies in
   migration_admin_image_uploads.sql — prepared for review, not run
   from here). The manual image-URL text field stays next to the
   uploader so old/external links keep working; both write the same
   image_url column, nothing else about saving changes.
   Cleanup rules:
     - replace / remove / delete record -> the OLD file is removed from
       Storage only after the DB write succeeded, only if the URL
       points into our own bucket, and only if no other row still
       references the same URL. External links are never touched.
     - uploaded but never saved (modal closed, another file chosen,
       "إزالة الصورة") -> the temporary file is removed right away.
   Does not touch local-service-images / the providers image system.
   ============================================================ */
const IMG_MAX_BYTES = 5 * 1024 * 1024;
const IMG_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const IMG_REFERENCING_TABLES = ['restaurants', 'markets', 'future_office', 'customer_ads', 'local_service_providers'];

// Public URL -> object path inside `bucket`, or null if the URL is not ours.
function storagePathFromPublicUrl(bucket, url) {
  if (!url || typeof url !== 'string') return null;
  const marker = '/storage/v1/object/public/' + bucket + '/';
  const i = url.indexOf(marker);
  if (i === -1) return null;
  let path = url.slice(i + marker.length).split('?')[0].split('#')[0];
  try { path = decodeURIComponent(path); } catch (_) { return null; }
  return path || null;
}

async function isImageUrlStillReferenced(url) {
  for (const table of IMG_REFERENCING_TABLES) {
    const { count, error } = await supabaseClient
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('image_url', url);
    if (error) {
      // Can't prove it's unused -> keep the file (safe side).
      console.warn('image reference check failed for', table, error);
      return true;
    }
    if (count > 0) return true;
  }
  return false;
}

async function removeObjectFromBucket(bucket, path) {
  const { error } = await supabaseClient.storage.from(bucket).remove([path]);
  if (error) {
    console.warn('تعذّر حذف الصورة من التخزين:', bucket, path, error);
    return false;
  }
  return true;
}

// Old saved image -> delete from Storage if (and only if) it is ours and unused.
async function removeStoredImageIfOurs(bucket, url) {
  const path = storagePathFromPublicUrl(bucket, url);
  if (!path) return false;
  if (await isImageUrlStillReferenced(url)) return false;
  return removeObjectFromBucket(bucket, path);
}

// Reads an optional integer sort_order input. value === undefined means "left empty".
function readSortOrderInput(inputId) {
  const el = document.getElementById(inputId);
  const raw = el ? String(el.value).trim() : '';
  if (raw === '') return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 9999) return { ok: false, value: undefined };
  return { ok: true, value: n };
}

function createImageWidget(cfg) {
  // cfg: { prefix, bucket, folder: () => string, saveBtnId }
  const el = (suffix) => document.getElementById(cfg.prefix + suffix);
  const w = { originalUrl: '', sessionUrl: null, sessionId: 0 };

  function setStatus(text) {
    const s = el('ImageUploadStatus');
    if (s) s.textContent = text || '';
  }

  w.refresh = function () {
    const urlEl = el('ImageUrl');
    const img = el('ImagePreview');
    const removeBtn = el('ImageRemoveBtn');
    const url = urlEl ? urlEl.value.trim() : '';
    if (img) {
      if (/^https?:\/\//i.test(url)) {
        img.src = url;
        img.style.display = 'block';
      } else {
        img.removeAttribute('src');
        img.style.display = 'none';
      }
    }
    if (removeBtn) removeBtn.hidden = !url;
  };

  w.open = function (url) {
    w.sessionId += 1;
    w.originalUrl = url || '';
    w.sessionUrl = null;
    const urlEl = el('ImageUrl');
    if (urlEl) urlEl.value = w.originalUrl;
    const fileEl = el('ImageFile');
    if (fileEl) fileEl.value = '';
    setStatus('الحد الأقصى 5MB — JPG / PNG / WebP / GIF');
    w.refresh();
  };

  async function dropSessionUpload() {
    const url = w.sessionUrl;
    w.sessionUrl = null;
    if (!url) return;
    const path = storagePathFromPublicUrl(cfg.bucket, url);
    if (path) await removeObjectFromBucket(cfg.bucket, path);
  }

  w.upload = async function (file) {
    if (!file) return;
    const fileEl = el('ImageFile');
    if (!IMG_ALLOWED_TYPES.includes(file.type)) {
      setStatus('الملف المختار ليس صورة مدعومة (JPG / PNG / WebP / GIF).');
      if (fileEl) fileEl.value = '';
      return;
    }
    if (file.size > IMG_MAX_BYTES) {
      setStatus('حجم الصورة يجب ألا يتجاوز 5MB.');
      if (fileEl) fileEl.value = '';
      return;
    }

    const myOpen = w.sessionId;
    const uploadBtn = el('ImageUploadBtn');
    const saveBtn = cfg.saveBtnId ? document.getElementById(cfg.saveBtnId) : null;
    setStatus('جارٍ رفع الصورة...');
    if (uploadBtn) uploadBtn.disabled = true;
    if (saveBtn) saveBtn.disabled = true;

    const extFromName = (file.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const ext = extFromName || { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[file.type];
    const path = `${cfg.folder()}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

    const { error: uploadError } = await supabaseClient.storage
      .from(cfg.bucket)
      .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type });

    if (uploadBtn) uploadBtn.disabled = false;
    if (saveBtn) saveBtn.disabled = false;
    if (fileEl) fileEl.value = '';

    if (uploadError) {
      console.error(uploadError);
      setStatus('تعذّر رفع الصورة: ' + uploadError.message);
      return;
    }

    const { data: publicUrlData } = supabaseClient.storage.from(cfg.bucket).getPublicUrl(path);
    const publicUrl = publicUrlData && publicUrlData.publicUrl;
    if (!publicUrl) {
      await removeObjectFromBucket(cfg.bucket, path);
      setStatus('تعذّر الحصول على رابط الصورة.');
      return;
    }

    // Modal was closed / reopened while uploading -> this file belongs to nobody.
    if (myOpen !== w.sessionId) {
      await removeObjectFromBucket(cfg.bucket, path);
      return;
    }

    // A previous unsaved upload from this same session is now replaced.
    await dropSessionUpload();
    w.sessionUrl = publicUrl;
    el('ImageUrl').value = publicUrl;
    w.refresh();
    setStatus('تم رفع الصورة ✓ — اضغط حفظ لتثبيتها');
  };

  // Manual URL typed/pasted over an unsaved upload -> that upload is orphaned.
  w.onUrlEdited = async function () {
    const urlEl = el('ImageUrl');
    const value = urlEl ? urlEl.value.trim() : '';
    if (w.sessionUrl && value !== w.sessionUrl) await dropSessionUpload();
    w.refresh();
  };

  w.remove = async function () {
    const urlEl = el('ImageUrl');
    if (urlEl) urlEl.value = '';
    const fileEl = el('ImageFile');
    if (fileEl) fileEl.value = '';
    await dropSessionUpload();
    w.refresh();
    setStatus(w.originalUrl ? 'ستُزال الصورة عند الحفظ.' : '');
  };

  // Call after the DB write succeeded. savedUrl = the image_url that was saved (or null).
  w.finalize = async function (savedUrl) {
    const old = w.originalUrl;
    w.sessionUrl = null;
    w.originalUrl = savedUrl || '';
    if (old && old !== (savedUrl || '')) {
      await removeStoredImageIfOurs(cfg.bucket, old);
    }
  };

  // Modal closed without saving -> remove any temporary upload.
  w.discard = function () {
    w.sessionId += 1;
    const pending = dropSessionUpload();
    w.originalUrl = '';
    return pending;
  };

  w.bind = function () {
    el('ImageUploadBtn')?.addEventListener('click', () => el('ImageFile')?.click());
    el('ImageFile')?.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) w.upload(file);
    });
    el('ImageRemoveBtn')?.addEventListener('click', () => w.remove());
    el('ImageUrl')?.addEventListener('input', () => w.refresh());
    el('ImageUrl')?.addEventListener('change', () => w.onUrlEdited());
    el('ImagePreview')?.addEventListener('error', () => {
      const url = el('ImageUrl') ? el('ImageUrl').value.trim() : '';
      if (url) setStatus('تعذّر عرض معاينة الصورة — تأكد أن الرابط مباشر لصورة.');
    });
  };

  return w;
}

const PLACE_IMAGE_FOLDERS = { restaurants: 'restaurants', markets: 'markets', futureOffice: 'future-office' };

const placeImageWidget = createImageWidget({
  prefix: 'place',
  bucket: 'place-images',
  folder: () => PLACE_IMAGE_FOLDERS[placesState.editingKind] || 'restaurants',
  saveBtnId: 'savePlaceBtn',
});

const adImageWidget = createImageWidget({
  prefix: 'ad',
  bucket: 'ad-images',
  folder: () => 'ads',
  saveBtnId: 'saveAdBtn',
});

/* ============================================================
   Restaurants / Markets / مكتب المستقبل ("المطاعم والأسواق ومكتب
   المستقبل" tab) — additive only. Three independent, admin-managed
   lists (tables: restaurants / markets / future_office), each row
   now carrying real display data (category, description, image_url,
   phone, address, hours_text) — not just a name/active flag. Same
   modal-based add/edit pattern as the ads modal above
   (openAdModal/saveAd), plus toggle/delete like before. Does not
   touch trip_requests, drivers, pricing, ads, GPS, or the requests
   table/modal in any way.
   Active rows here are exactly what places.js (customer app) reads
   and renders as real cards + a details page instead of the old
   static "قريباً" placeholder — a list with zero active rows still
   shows a professional "قريباً" empty state on its own, no action
   needed here for that case.
   Requires migration_places_details.sql to have been run once
   (adds the rich columns to restaurants/markets + creates the new
   future_office table).
   ============================================================ */
const placesState = { restaurants: [], markets: [], futureOffice: [], editingKind: null, editingId: null };

const PLACE_TABLES = {
  restaurants:  { table: 'restaurants',    bodyId: 'restaurantsBody',   emptyId: 'restaurantsEmpty',   addBtnId: 'addRestaurantBtn',   label: 'هذا المطعم', nameLabel: 'اسم المطعم',  namePlaceholder: 'مثال: مطعم بغداد' },
  markets:      { table: 'markets',        bodyId: 'marketsBody',       emptyId: 'marketsEmpty',       addBtnId: 'addMarketBtn',       label: 'هذا السوق',  nameLabel: 'اسم السوق',   namePlaceholder: 'مثال: سوق الجملة' },
  futureOffice: { table: 'future_office',  bodyId: 'futureOfficeBody',  emptyId: 'futureOfficeEmpty',  addBtnId: 'addFutureOfficeBtn', label: 'هذا الفرع',  nameLabel: 'اسم الفرع',   namePlaceholder: 'مكتب المستقبل للقرطاسية والطباعة' },
};

async function loadPlaces(kind) {
  const cfg = PLACE_TABLES[kind];
  const { data, error } = await supabaseClient
    .from(cfg.table)
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) {
    console.error(error);
    return;
  }
  placesState[kind] = data || [];
  renderPlacesTable(kind);
}

function renderPlacesTable(kind) {
  const cfg = PLACE_TABLES[kind];
  const body = document.getElementById(cfg.bodyId);
  const empty = document.getElementById(cfg.emptyId);
  if (!body) return;

  const rows = placesState[kind];
  if (!rows.length) {
    body.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  body.innerHTML = rows.map(row => `
    <tr data-place-id="${escapeAttr(row.id)}">
      <td>${row.image_url ? `<img src="${escapeAttr(row.image_url)}" alt="" style="width:40px; height:40px; border-radius:8px; object-fit:cover; display:block;">` : '<span style="opacity:0.4;">—</span>'}</td>
      <td>${escapeHtml(row.name)}</td>
      <td>${row.category ? escapeHtml(row.category) : '<span style="opacity:0.4;">—</span>'}</td>
      <td>${row.sort_order ?? '<span style="opacity:0.4;">—</span>'}</td>
      <td><span class="ads-active-badge ${row.active ? '' : 'off'}" data-place-toggle="${escapeAttr(row.id)}" style="cursor:pointer;">${row.active ? 'نشط' : 'موقوف'}</span></td>
      <td class="ads-row-actions">
        <button type="button" data-place-edit="${escapeAttr(row.id)}">تعديل</button>
        <button type="button" class="danger" data-place-delete="${escapeAttr(row.id)}">حذف</button>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-place-toggle]').forEach(el => {
    el.addEventListener('click', () => togglePlaceActive(kind, el.dataset.placeToggle));
  });
  body.querySelectorAll('[data-place-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = placesState[kind].find(r => r.id === btn.dataset.placeEdit);
      if (row) openPlaceModal(kind, row);
    });
  });
  body.querySelectorAll('[data-place-delete]').forEach(btn => {
    btn.addEventListener('click', () => deletePlace(kind, btn.dataset.placeDelete));
  });
}

async function togglePlaceActive(kind, id) {
  const cfg = PLACE_TABLES[kind];
  const row = placesState[kind].find(r => r.id === id);
  if (!row) return;
  // تفعيل مكان بلا موقع يُظهره للزبائن دون إمكانية الطلب منه: يُمنع حتى يُحدَّد موقعه من «تعديل».
  if (!row.active && !(row.lat != null && row.lng != null && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng)))) {
    alert('لا يمكن تفعيل هذا المكان قبل تحديد موقعه: افتح «تعديل» ثم اضغط 📍 تحديد الموقع من الخريطة.');
    return;
  }
  const { error } = await supabaseClient.from(cfg.table).update({ active: !row.active }).eq('id', id);
  if (error) {
    console.error(error);
    return;
  }
  await loadPlaces(kind);
}

async function deletePlace(kind, id) {
  if (!id) return;
  const cfg = PLACE_TABLES[kind];
  if (!confirm(`حذف ${cfg.label} نهائياً؟`)) return;
  const oldImageUrl = ((placesState[kind] || []).find(r => r.id === id) || {}).image_url || '';
  const { error } = await supabaseClient.from(cfg.table).delete().eq('id', id);
  if (error) {
    console.error(error);
    alert('تعذّر الحذف: ' + error.message);
    return;
  }
  if (oldImageUrl) await removeStoredImageIfOurs('place-images', oldImageUrl);
  closePlaceModal();
  await loadPlaces(kind);
}

// Delivery pickup coordinates for restaurants / markets / future_office
// (columns lat/lng). The modal's static HTML has no inputs for them, so
// they are added once from here, right under the address field.
// The coordinates are no longer typed by hand: the admin taps
// "📍 تحديد الموقع من الخريطة" and picks the place on a map (picker below);
// #placeLat / #placeLng stay as READ-ONLY fields that hold the picked
// values, so openPlaceModal() / readPlaceCoords() / savePlace() keep
// reading and writing the same lat/lng columns exactly as before.
// Both empty = no coordinates = customers cannot request delivery from
// this place (places.js / yammak-services.js block the order).
function ensurePlaceCoordFields() {
  if (document.getElementById('placeLat')) return;
  const addr = document.getElementById('placeAddress');
  if (!addr) return;
  const anchor = addr.closest('.field, .form-field, .form-group, .float-field') || addr.parentElement;
  const wrap = document.createElement('div');
  wrap.id = 'placeCoordsWrap';
  wrap.className = 'admin-field';
  const cls = addr.className || '';
  wrap.innerHTML =
    '<label>موقع المكان <span class="opt">(مطلوب للمكان النشط)</span></label>' +
    '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px">' +
      '<button type="button" class="admin-btn" id="placeLocPickBtn" style="width:auto;padding:8px 16px">📍 تحديد الموقع من الخريطة</button>' +
      '<span id="placeLocStatus" style="font-size:13px"></span>' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">' +
      '<label style="flex:1;min-width:120px;display:block;font-size:12px;opacity:.8">خط العرض (lat)' +
        '<input id="placeLat" type="number" step="any" readonly tabindex="-1" class="' + cls + '" placeholder="يُملأ من الخريطة"></label>' +
      '<label style="flex:1;min-width:120px;display:block;font-size:12px;opacity:.8">خط الطول (lng)' +
        '<input id="placeLng" type="number" step="any" readonly tabindex="-1" class="' + cls + '" placeholder="يُملأ من الخريطة"></label>' +
    '</div>' +
    '<small style="display:block;margin-top:4px;opacity:.75">إحداثيات المكان — مطلوبة ليتمكّن الزبون من طلب توصيل من هذا المكان.</small>';
  anchor.insertAdjacentElement('afterend', wrap);
  wrap.querySelector('#placeLocPickBtn').addEventListener('click', openPlacePicker);
  refreshPlaceCoordStatus();
}

// Valid saved/picked coordinates from the two read-only inputs, or null.
function readPlaceCoordInputs() {
  const latRaw = (document.getElementById('placeLat')?.value ?? '').trim();
  const lngRaw = (document.getElementById('placeLng')?.value ?? '').trim();
  if (latRaw === '' || lngRaw === '') return null;
  const lat = Number(latRaw), lng = Number(lngRaw);
  return (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng } : null;
}

function refreshPlaceCoordStatus() {
  const statusEl = document.getElementById('placeLocStatus');
  const btn = document.getElementById('placeLocPickBtn');
  if (!statusEl || !btn) return;
  const c = readPlaceCoordInputs();
  if (c) {
    statusEl.textContent = '✅ الموقع محدد (' + c.lat.toFixed(5) + ' ، ' + c.lng.toFixed(5) + ')';
    btn.textContent = '📍 تغيير الموقع من الخريطة';
  } else {
    statusEl.textContent = '⚠️ لم يُحدَّد موقع بعد';
    btn.textContent = '📍 تحديد الموقع من الخريطة';
  }
}

/* ---------- Map picker for a place's coordinates ----------
   Leaflet 1.9.4 + OpenStreetMap tiles — the same library/tile source the
   customer app already uses (index.html / app.js), loaded on demand the
   first time the picker opens so the rest of the admin page is unchanged.
   The picker only fills #placeLat / #placeLng; nothing is saved until the
   normal "حفظ" button of the place modal runs savePlace(). */
const PLACE_PICKER_DEFAULT_CENTER = { lat: 35.9824, lng: 43.2578 }; // = SERVICE_REGION_CENTER في app.js (تطبيق الزبون)
const placePicker = { el: null, map: null, marker: null, lat: null, lng: null };
let leafletLoadPromise = null;

function loadLeafletOnce() {
  if (window.L && window.L.map) return Promise.resolve();
  if (leafletLoadPromise) return leafletLoadPromise;
  const cssP = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    css.onload = () => resolve();
    css.onerror = () => reject(new Error('leaflet-css-failed'));
    document.head.appendChild(css);
  });
  const jsP = new Promise((resolve, reject) => {
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => resolve();
    js.onerror = () => reject(new Error('leaflet-js-failed'));
    document.head.appendChild(js);
  });
  leafletLoadPromise = Promise.all([cssP, jsP]).then(() => undefined, (err) => {
    leafletLoadPromise = null; // allow a retry on the next click
    throw err;
  });
  return leafletLoadPromise;
}

function ensurePlacePickerModal() {
  if (placePicker.el) return placePicker.el;
  const el = document.createElement('div');
  el.id = 'placePickerBackdrop';
  el.style.cssText = 'display:none;position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);align-items:center;justify-content:center;padding:10px;';
  el.innerHTML =
    '<div style="background:#fff;color:#111;border-radius:14px;width:min(96vw,720px);max-height:96vh;display:flex;flex-direction:column;overflow:hidden;direction:rtl">' +
      '<div style="padding:12px 14px 4px;font-weight:700">حدّد موقع المكان على الخريطة</div>' +
      '<div style="padding:0 14px 8px;font-size:12px;opacity:.75">اضغط على الخريطة أو اسحب الدبوس لضبط الموقع بدقة.</div>' +
      '<div id="placePickerMap" style="height:min(60vh,460px);width:100%;background:#e9eef2"></div>' +
      '<div id="placePickerInfo" style="padding:8px 14px;font-size:13px;min-height:20px"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;padding:0 14px 14px">' +
        '<button type="button" class="admin-btn" id="placePickerConfirm" style="width:auto;padding:10px 18px" disabled>تأكيد الموقع</button>' +
        '<button type="button" class="admin-btn danger" id="placePickerCancel" style="width:auto;padding:10px 18px">إلغاء</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(el);
  el.addEventListener('click', (e) => { if (e.target === el) closePlacePicker(); });
  el.querySelector('#placePickerCancel').addEventListener('click', closePlacePicker);
  el.querySelector('#placePickerConfirm').addEventListener('click', confirmPlacePicker);
  placePicker.el = el;
  return el;
}

function setPlacePickerPoint(lat, lng) {
  placePicker.lat = lat;
  placePicker.lng = lng;
  if (!placePicker.marker) {
    placePicker.marker = L.marker([lat, lng], {
      draggable: true,
      icon: L.divIcon({
        className: '',
        html: '<span style="display:block;font-size:30px;line-height:30px;margin:-30px 0 0 -15px">📍</span>',
        iconSize: [0, 0],
      }),
    }).addTo(placePicker.map);
    placePicker.marker.on('dragend', () => {
      const ll = placePicker.marker.getLatLng().wrap();
      setPlacePickerPoint(ll.lat, ll.lng);
    });
  } else {
    placePicker.marker.setLatLng([lat, lng]);
  }
  const info = placePicker.el && placePicker.el.querySelector('#placePickerInfo');
  if (info) info.textContent = 'الإحداثيات: ' + lat.toFixed(6) + ' ، ' + lng.toFixed(6);
  const confirmBtn = placePicker.el && placePicker.el.querySelector('#placePickerConfirm');
  if (confirmBtn) confirmBtn.disabled = false;
}

function openPlacePicker() {
  const el = ensurePlacePickerModal();
  const info = el.querySelector('#placePickerInfo');
  const confirmBtn = el.querySelector('#placePickerConfirm');
  confirmBtn.disabled = true;
  placePicker.lat = null;
  placePicker.lng = null;
  info.textContent = 'جارٍ تحميل الخريطة…';
  el.style.display = 'flex';
  loadLeafletOnce().then(() => {
    if (el.style.display === 'none') return; // أُغلقت النافذة أثناء التحميل
    const existing = readPlaceCoordInputs(); // موقع محفوظ سابقاً (أو مختار الآن) يُعرض ويمكن تغييره
    const start = existing || PLACE_PICKER_DEFAULT_CENTER;
    const zoom = existing ? 17 : 13;
    if (!placePicker.map) {
      placePicker.map = L.map('placePickerMap').setView([start.lat, start.lng], zoom);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
      }).addTo(placePicker.map);
      placePicker.map.on('click', (e) => {
        const ll = e.latlng.wrap();
        setPlacePickerPoint(ll.lat, ll.lng);
      });
    } else {
      placePicker.map.setView([start.lat, start.lng], zoom);
    }
    if (placePicker.marker) { placePicker.marker.remove(); placePicker.marker = null; }
    if (existing) setPlacePickerPoint(existing.lat, existing.lng);
    else info.textContent = 'اضغط على موقع المكان في الخريطة.';
    setTimeout(() => { if (placePicker.map) placePicker.map.invalidateSize(); }, 50);
  }).catch((err) => {
    console.error('place picker: map failed to load', err);
    info.textContent = 'تعذّر تحميل الخريطة — تحقق من الاتصال بالإنترنت ثم أعد المحاولة.';
  });
}

function closePlacePicker() {
  if (placePicker.el) placePicker.el.style.display = 'none';
}

function confirmPlacePicker() {
  if (placePicker.lat == null || placePicker.lng == null) return;
  const latEl = document.getElementById('placeLat');
  const lngEl = document.getElementById('placeLng');
  if (latEl) latEl.value = Number(placePicker.lat.toFixed(6));
  if (lngEl) lngEl.value = Number(placePicker.lng.toFixed(6));
  refreshPlaceCoordStatus();
  showPlaceModalError(null);
  closePlacePicker();
}

function readPlaceCoords() {
  const latRaw = document.getElementById('placeLat')?.value.trim() ?? '';
  const lngRaw = document.getElementById('placeLng')?.value.trim() ?? '';
  if (latRaw === '' && lngRaw === '') return { ok: true, lat: null, lng: null };
  if (latRaw === '' || lngRaw === '') return { ok: false, message: 'أدخل خط العرض وخط الطول معاً أو اتركهما فارغين.' };
  const lat = Number(latRaw), lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, message: 'الإحداثيات غير صالحة (خط العرض بين -90 و90، وخط الطول بين -180 و180).' };
  }
  return { ok: true, lat, lng };
}

function openPlaceModal(kind, row) {
  const cfg = PLACE_TABLES[kind];
  ensurePlaceCoordFields();
  placesState.editingKind = kind;
  placesState.editingId = row ? row.id : null;

  document.getElementById('placeModalTitle').textContent = row ? `تعديل — ${cfg.label}` : `إضافة — ${cfg.nameLabel}`;
  document.getElementById('placeNameLabel').textContent = cfg.nameLabel;
  const nameEl = document.getElementById('placeName');
  nameEl.placeholder = cfg.namePlaceholder;
  nameEl.value = row?.name || '';
  const categoryEl = document.getElementById('placeCategory');
  categoryEl.value = row?.category || '';
  // Suggested category values (سكائر وتبغ، أركيلة...) only offered for
  // الأسواق — free-text field, no schema change, just a datalist hint.
  if (kind === 'markets') categoryEl.setAttribute('list', 'marketCategorySuggestions');
  else categoryEl.removeAttribute('list');
  placeImageWidget.open(row?.image_url || '');
  document.getElementById('placeSortOrder').value = row?.sort_order ?? '';
  document.getElementById('placePhone').value = row?.phone || '';
  document.getElementById('placeAddress').value = row?.address || '';
  const latEl = document.getElementById('placeLat'), lngEl = document.getElementById('placeLng');
  if (latEl) latEl.value = row?.lat ?? '';
  if (lngEl) lngEl.value = row?.lng ?? '';
  refreshPlaceCoordStatus();
  document.getElementById('placeHours').value = row?.hours_text || '';
  document.getElementById('placeDescription').value = row?.description || '';
  document.getElementById('placeActive').checked = row ? !!row.active : true;

  const deleteBtn = document.getElementById('deletePlaceBtn');
  if (deleteBtn) deleteBtn.hidden = !row;

  const errEl = document.getElementById('placeModalError');
  if (errEl) { errEl.textContent = ''; errEl.classList.remove('show'); }

  document.getElementById('placeModalBackdrop').classList.add('show');
}

function closePlaceModal() {
  document.getElementById('placeModalBackdrop').classList.remove('show');
  placesState.editingKind = null;
  placesState.editingId = null;
  placeImageWidget.discard();
}

function showPlaceModalError(message) {
  const el = document.getElementById('placeModalError');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.add('show');
  } else {
    el.textContent = '';
    el.classList.remove('show');
  }
}

async function savePlace() {
  showPlaceModalError(null);
  const kind = placesState.editingKind;
  if (!kind) return;
  const cfg = PLACE_TABLES[kind];

  const name = document.getElementById('placeName').value.trim();
  const category = document.getElementById('placeCategory').value.trim();
  const image_url = document.getElementById('placeImageUrl').value.trim();
  const phone = document.getElementById('placePhone').value.trim();
  const address = document.getElementById('placeAddress').value.trim();
  const hours_text = document.getElementById('placeHours').value.trim();
  const description = document.getElementById('placeDescription').value.trim();
  const active = document.getElementById('placeActive').checked;

  if (!name) {
    showPlaceModalError('الاسم مطلوب.');
    return;
  }
  if (image_url && !/^https?:\/\//i.test(image_url)) {
    showPlaceModalError('رابط الصورة يجب أن يبدأ بـ https:// وأن يكون رابطاً مباشراً للصورة.');
    return;
  }
  const sortOrder = readSortOrderInput('placeSortOrder');
  if (!sortOrder.ok) {
    showPlaceModalError('الترتيب يجب أن يكون رقمًا صحيحًا بين 0 و9999.');
    return;
  }

  const coords = readPlaceCoords();
  if (!coords.ok) {
    showPlaceModalError(coords.message);
    return;
  }
  // الموقع مطلوب لأي مكان ظاهر للزبائن: places.js (requestPlaceDelivery) يمنع الطلب من مكان بلا lat/lng.
  if (active && (coords.lat === null || coords.lng === null)) {
    showPlaceModalError('حدّد موقع المكان على الخريطة (📍) قبل الحفظ — الموقع مطلوب ليتمكّن الزبون من الطلب منه. (يمكنك إلغاء «نشط» لحفظه بدون موقع.)');
    return;
  }

  const payload = {
    name,
    category: category || null,
    image_url: image_url || null,
    phone: phone || null,
    address: address || null,
    lat: coords.lat,
    lng: coords.lng,
    hours_text: hours_text || null,
    description: description || null,
    active,
  };
  if (sortOrder.value !== undefined) payload.sort_order = sortOrder.value;

  const btn = document.getElementById('savePlaceBtn');
  if (btn) btn.disabled = true;

  const { error } = placesState.editingId
    ? await supabaseClient.from(cfg.table).update(payload).eq('id', placesState.editingId)
    : await supabaseClient.from(cfg.table).insert(payload);

  if (btn) btn.disabled = false;

  if (error) {
    console.error(error);
    showPlaceModalError('تعذّر الحفظ: ' + error.message + (error.message?.includes('column') ? ' — تأكد من تشغيل migration_places_details.sql على قاعدة البيانات.' : ''));
    return;
  }

  await placeImageWidget.finalize(payload.image_url);
  closePlaceModal();
  await loadPlaces(kind);
}

/* ============================================================
   يمّك للخدمات المحلية — additive only. Manages the three
   pre-existing tables local_service_sections / local_service_categories /
   local_service_providers (already created and seeded with the 16
   agreed sections + their sub-categories; providers table starts
   empty and is filled here with real data only). No migration, no
   new tables — same schema used as-is:
     local_service_sections:   id, key, label, icon, sort_order, active, created_at
     local_service_categories: id, section_id, label, sort_order, active, created_at
     local_service_providers:  id, category_id, image_url, name, details,
                                phone, address, lat, lng, hours_text,
                                active, sort_order, created_at
   Does not touch restaurants/markets/future_office, ads, drivers,
   pricing, GPS, RPCs, or the requests table/modal in any way.
   ============================================================ */
const localServicesState = {
  sections: [],
  categories: [],
  providers: [],
  expandedSectionId: null,
  editingSectionId: null,
  editingCategoryId: null,
  editingProviderId: null,
};

async function loadLocalServiceSections() {
  const { data, error } = await supabaseClient
    .from('local_service_sections')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  if (error) { console.error(error); return; }
  localServicesState.sections = data || [];
}

async function loadLocalServiceCategories() {
  const { data, error } = await supabaseClient
    .from('local_service_categories')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  if (error) { console.error(error); return; }
  localServicesState.categories = data || [];
}

async function loadLocalServiceProviders() {
  const { data, error } = await supabaseClient
    .from('local_service_providers')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) { console.error(error); return; }
  localServicesState.providers = data || [];
}

async function loadLocalServicesTab() {
  const loadingEl = document.getElementById('lsSectionsLoading');
  if (loadingEl) loadingEl.style.display = 'block';
  await Promise.all([loadLocalServiceSections(), loadLocalServiceCategories(), loadLocalServiceProviders()]);
  if (loadingEl) loadingEl.style.display = 'none';
  renderLsSections();
  populateLsSectionSelects();
  populateLsProviderCategorySelect(null, 'lsProviderCategoryFilter');
  renderLsProviders();
}

function categoriesForSection(sectionId) {
  return localServicesState.categories.filter(c => c.section_id === sectionId);
}
function sectionLabel(sectionId) {
  const s = localServicesState.sections.find(sec => sec.id === sectionId);
  return s ? s.label : '—';
}
function categoryLabel(categoryId) {
  const c = localServicesState.categories.find(cat => cat.id === categoryId);
  return c ? c.label : '—';
}
function categorySectionId(categoryId) {
  const c = localServicesState.categories.find(cat => cat.id === categoryId);
  return c ? c.section_id : null;
}

/* ---------- الأقسام + التصنيفات (جدول قابل للطي) ---------- */
function renderLsSections() {
  const body = document.getElementById('lsSectionsBody');
  const empty = document.getElementById('lsSectionsEmpty');
  if (!body) return;

  const rows = localServicesState.sections;
  if (!rows.length) {
    body.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  body.innerHTML = rows.map(sec => {
    const cats = categoriesForSection(sec.id);
    const isOpen = localServicesState.expandedSectionId === sec.id;
    const catsHtml = cats.map(cat => `
      <tr>
        <td style="padding-inline-start:28px;">${escapeHtml(cat.label)}</td>
        <td>${cat.sort_order ?? '<span style="opacity:0.4;">—</span>'}</td>
        <td><span class="ads-active-badge ${cat.active ? '' : 'off'}" data-ls-cat-toggle="${cat.id}" style="cursor:pointer;">${cat.active ? 'نشط' : 'موقوف'}</span></td>
        <td class="ads-row-actions">
          <button type="button" data-ls-cat-edit="${cat.id}">تعديل</button>
          <button type="button" class="danger" data-ls-cat-delete="${cat.id}">حذف</button>
        </td>
      </tr>
    `).join('');

    return `
      <tr class="driver-row${isOpen ? ' open' : ''}" data-ls-section-toggle="${sec.id}">
        <td>${isOpen ? '▾' : '◂'}</td>
        <td>${sec.icon ? escapeHtml(sec.icon) + ' ' : ''}<b>${escapeHtml(sec.label)}</b></td>
        <td>${sec.sort_order ?? '<span style="opacity:0.4;">—</span>'}</td>
        <td>${cats.length}</td>
        <td><span class="ads-active-badge ${sec.active ? '' : 'off'}" data-ls-sec-active-toggle="${sec.id}" style="cursor:pointer;">${sec.active ? 'نشط' : 'موقوف'}</span></td>
        <td class="ads-row-actions">
          <button type="button" data-ls-sec-add-cat="${sec.id}">+ تصنيف</button>
          <button type="button" data-ls-sec-edit="${sec.id}">تعديل</button>
          <button type="button" class="danger" data-ls-sec-delete="${sec.id}">حذف</button>
        </td>
      </tr>
      <tr class="driver-requests-row" ${isOpen ? '' : 'hidden'}>
        <td colspan="6">
          <div class="driver-requests-wrap">
            ${cats.length ? `
              <table class="driver-requests-table admin-table">
                <thead><tr><th>التصنيف</th><th>الترتيب</th><th>الحالة</th><th>إجراءات</th></tr></thead>
                <tbody>${catsHtml}</tbody>
              </table>
            ` : `<div class="driver-requests-empty">لا توجد تصنيفات بعد تحت هذا القسم.</div>`}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  body.querySelectorAll('[data-ls-section-toggle]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, span[data-ls-sec-active-toggle]')) return;
      const id = Number(tr.dataset.lsSectionToggle);
      localServicesState.expandedSectionId = localServicesState.expandedSectionId === id ? null : id;
      renderLsSections();
    });
  });
  body.querySelectorAll('[data-ls-sec-active-toggle]').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); toggleLsSectionActive(el.dataset.lsSecActiveToggle); });
  });
  body.querySelectorAll('[data-ls-sec-add-cat]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openLsCategoryModal(btn.dataset.lsSecAddCat, null); });
  });
  body.querySelectorAll('[data-ls-sec-edit]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = localServicesState.sections.find(s => s.id === Number(btn.dataset.lsSecEdit));
      if (row) openLsSectionModal(row);
    });
  });
  body.querySelectorAll('[data-ls-sec-delete]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteLsSection(btn.dataset.lsSecDelete); });
  });
  body.querySelectorAll('[data-ls-cat-toggle]').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); toggleLsCategoryActive(el.dataset.lsCatToggle); });
  });
  body.querySelectorAll('[data-ls-cat-edit]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = localServicesState.categories.find(c => c.id === Number(btn.dataset.lsCatEdit));
      if (row) openLsCategoryModal(row.section_id, row);
    });
  });
  body.querySelectorAll('[data-ls-cat-delete]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteLsCategory(btn.dataset.lsCatDelete); });
  });
}

async function toggleLsSectionActive(id) {
  id = Number(id);
  const row = localServicesState.sections.find(s => s.id === id);
  if (!row) return;
  const { error } = await supabaseClient.from('local_service_sections').update({ active: !row.active }).eq('id', id);
  if (error) { console.error(error); return; }
  await loadLocalServiceSections();
  renderLsSections();
}

async function toggleLsCategoryActive(id) {
  id = Number(id);
  const row = localServicesState.categories.find(c => c.id === id);
  if (!row) return;
  const { error } = await supabaseClient.from('local_service_categories').update({ active: !row.active }).eq('id', id);
  if (error) { console.error(error); return; }
  await loadLocalServiceCategories();
  renderLsSections();
}

async function deleteLsSection(id) {
  id = Number(id);
  if (categoriesForSection(id).length) {
    alert('لا يمكن حذف قسم يحتوي على تصنيفات فرعية. احذف تصنيفاته أولاً.');
    return;
  }
  if (!confirm('حذف هذا القسم نهائياً؟')) return;
  const { error } = await supabaseClient.from('local_service_sections').delete().eq('id', id);
  if (error) { console.error(error); alert('تعذّر الحذف: ' + error.message); return; }
  await loadLocalServiceSections();
  renderLsSections();
  populateLsSectionSelects();
}

async function deleteLsCategory(id) {
  id = Number(id);
  if (localServicesState.providers.some(p => p.category_id === id)) {
    alert('لا يمكن حذف تصنيف يحتوي على مزودي خدمة. احذف مزوديه أولاً.');
    return;
  }
  if (!confirm('حذف هذا التصنيف نهائياً؟')) return;
  const { error } = await supabaseClient.from('local_service_categories').delete().eq('id', id);
  if (error) { console.error(error); alert('تعذّر الحذف: ' + error.message); return; }
  await loadLocalServiceCategories();
  renderLsSections();
  populateLsProviderCategorySelect(null, 'lsProviderCategoryFilter');
}

/* ---------- مودال القسم ---------- */
function openLsSectionModal(row) {
  localServicesState.editingSectionId = row ? row.id : null;
  document.getElementById('lsSectionModalTitle').textContent = row ? 'تعديل قسم' : 'إضافة قسم';
  const keyEl = document.getElementById('lsSectionKey');
  keyEl.value = row ? row.key : '';
  keyEl.disabled = !!row;
  document.getElementById('lsSectionLabel').value = row?.label || '';
  document.getElementById('lsSectionIcon').value = row?.icon || '';
  document.getElementById('lsSectionSortOrder').value = row?.sort_order ?? '';
  document.getElementById('lsSectionActive').checked = row ? !!row.active : true;
  document.getElementById('deleteLsSectionBtn').hidden = !row;
  showLsSectionModalError(null);
  document.getElementById('lsSectionModalBackdrop').classList.add('show');
}
function closeLsSectionModal() {
  document.getElementById('lsSectionModalBackdrop').classList.remove('show');
  document.getElementById('lsSectionKey').disabled = false;
  localServicesState.editingSectionId = null;
}
function showLsSectionModalError(message) {
  const el = document.getElementById('lsSectionModalError');
  if (!el) return;
  if (message) { el.textContent = message; el.classList.add('show'); }
  else { el.textContent = ''; el.classList.remove('show'); }
}
async function saveLsSection() {
  showLsSectionModalError(null);
  const key = document.getElementById('lsSectionKey').value.trim();
  const label = document.getElementById('lsSectionLabel').value.trim();
  const icon = document.getElementById('lsSectionIcon').value.trim();
  const active = document.getElementById('lsSectionActive').checked;
  const editingId = localServicesState.editingSectionId;

  if (!label) { showLsSectionModalError('اسم القسم مطلوب.'); return; }
  if (!editingId && !key) { showLsSectionModalError('المعرّف (key) مطلوب عند إضافة قسم جديد.'); return; }
  const sortOrder = readSortOrderInput('lsSectionSortOrder');
  if (!sortOrder.ok) { showLsSectionModalError('الترتيب يجب أن يكون رقمًا صحيحًا بين 0 و9999.'); return; }

  // icon: on edit an empty field clears it (customer app falls back to its
  // default tile icon); on insert an empty field is simply not sent.
  const sectionPayload = editingId ? { label, active, icon: icon || null } : { key, label, active };
  if (!editingId && icon) sectionPayload.icon = icon;
  if (sortOrder.value !== undefined) sectionPayload.sort_order = sortOrder.value;

  const btn = document.getElementById('saveLsSectionBtn');
  if (btn) btn.disabled = true;

  const { error } = editingId
    ? await supabaseClient.from('local_service_sections').update(sectionPayload).eq('id', editingId)
    : await supabaseClient.from('local_service_sections').insert(sectionPayload);

  if (btn) btn.disabled = false;
  if (error) {
    console.error(error);
    showLsSectionModalError('تعذّر الحفظ: ' + error.message);
    return;
  }
  closeLsSectionModal();
  await loadLocalServiceSections();
  renderLsSections();
  populateLsSectionSelects();
}

/* ---------- مودال التصنيف ---------- */
function populateLsCategorySectionSelect(selectedSectionId) {
  const sel = document.getElementById('lsCategorySection');
  if (!sel) return;
  sel.innerHTML = localServicesState.sections.map(s => `<option value="${s.id}">${escapeHtml(s.label)}</option>`).join('');
  if (selectedSectionId != null) sel.value = String(selectedSectionId);
}
function openLsCategoryModal(sectionId, row) {
  localServicesState.editingCategoryId = row ? row.id : null;
  document.getElementById('lsCategoryModalTitle').textContent = row ? 'تعديل تصنيف' : 'إضافة تصنيف';
  populateLsCategorySectionSelect(row ? row.section_id : sectionId);
  document.getElementById('lsCategoryLabel').value = row?.label || '';
  document.getElementById('lsCategorySortOrder').value = row?.sort_order ?? '';
  document.getElementById('lsCategoryActive').checked = row ? !!row.active : true;
  document.getElementById('deleteLsCategoryBtn').hidden = !row;
  showLsCategoryModalError(null);
  document.getElementById('lsCategoryModalBackdrop').classList.add('show');
}
function closeLsCategoryModal() {
  document.getElementById('lsCategoryModalBackdrop').classList.remove('show');
  localServicesState.editingCategoryId = null;
}
function showLsCategoryModalError(message) {
  const el = document.getElementById('lsCategoryModalError');
  if (!el) return;
  if (message) { el.textContent = message; el.classList.add('show'); }
  else { el.textContent = ''; el.classList.remove('show'); }
}
async function saveLsCategory() {
  showLsCategoryModalError(null);
  const sectionId = Number(document.getElementById('lsCategorySection').value);
  const label = document.getElementById('lsCategoryLabel').value.trim();
  const active = document.getElementById('lsCategoryActive').checked;
  const editingId = localServicesState.editingCategoryId;

  if (!sectionId) { showLsCategoryModalError('اختر القسم.'); return; }
  if (!label) { showLsCategoryModalError('اسم التصنيف مطلوب.'); return; }
  const sortOrder = readSortOrderInput('lsCategorySortOrder');
  if (!sortOrder.ok) { showLsCategoryModalError('الترتيب يجب أن يكون رقمًا صحيحًا بين 0 و9999.'); return; }
  const categoryPayload = { section_id: sectionId, label, active };
  if (sortOrder.value !== undefined) categoryPayload.sort_order = sortOrder.value;

  const btn = document.getElementById('saveLsCategoryBtn');
  if (btn) btn.disabled = true;

  const { error } = editingId
    ? await supabaseClient.from('local_service_categories').update(categoryPayload).eq('id', editingId)
    : await supabaseClient.from('local_service_categories').insert(categoryPayload);

  if (btn) btn.disabled = false;
  if (error) {
    console.error(error);
    showLsCategoryModalError('تعذّر الحفظ: ' + error.message);
    return;
  }
  closeLsCategoryModal();
  await loadLocalServiceCategories();
  renderLsSections();
  populateLsProviderCategorySelect(null, 'lsProviderCategoryFilter');
}

/* ---------- مزودو الخدمة ---------- */
function populateLsSectionSelects() {
  const filterSel = document.getElementById('lsProviderSectionFilter');
  if (filterSel) {
    const current = filterSel.value;
    filterSel.innerHTML = '<option value="">كل الأقسام</option>' +
      localServicesState.sections.map(s => `<option value="${s.id}">${escapeHtml(s.label)}</option>`).join('');
    filterSel.value = current;
  }
  const modalSel = document.getElementById('lsProviderSection');
  if (modalSel) {
    modalSel.innerHTML = localServicesState.sections.map(s => `<option value="${s.id}">${escapeHtml(s.label)}</option>`).join('');
  }
}

function populateLsProviderCategorySelect(filteredSectionId, targetSelectId, selectedCategoryId) {
  targetSelectId = targetSelectId || 'lsProviderCategory';
  const sel = document.getElementById(targetSelectId);
  if (!sel) return;
  let cats = localServicesState.categories;
  if (filteredSectionId) cats = cats.filter(c => c.section_id === Number(filteredSectionId));
  const isFilter = targetSelectId === 'lsProviderCategoryFilter';
  sel.innerHTML = (isFilter ? '<option value="">كل التصنيفات</option>' : '') +
    cats.map(c => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('');
  if (selectedCategoryId != null) sel.value = String(selectedCategoryId);
}

function renderLsProviders() {
  const body = document.getElementById('lsProvidersBody');
  const empty = document.getElementById('lsProvidersEmpty');
  if (!body) return;

  const sectionFilter = document.getElementById('lsProviderSectionFilter')?.value;
  const categoryFilter = document.getElementById('lsProviderCategoryFilter')?.value;

  let rows = localServicesState.providers;
  if (categoryFilter) {
    rows = rows.filter(p => p.category_id === Number(categoryFilter));
  } else if (sectionFilter) {
    rows = rows.filter(p => categorySectionId(p.category_id) === Number(sectionFilter));
  }

  if (!rows.length) {
    body.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  body.innerHTML = rows.map(row => `
    <tr>
      <td>${row.image_url ? `<img src="${escapeAttr(row.image_url)}" alt="" style="width:40px; height:40px; border-radius:8px; object-fit:cover; display:block;">` : '<span style="opacity:0.4;">—</span>'}</td>
      <td>${escapeHtml(row.name)}</td>
      <td>${escapeHtml(sectionLabel(categorySectionId(row.category_id)))} / ${escapeHtml(categoryLabel(row.category_id))}</td>
      <td>${row.sort_order ?? '<span style="opacity:0.4;">—</span>'}</td>
      <td>${row.phone ? escapeHtml(row.phone) : '<span style="opacity:0.4;">—</span>'}</td>
      <td><span class="ads-active-badge ${row.active ? '' : 'off'}" data-ls-provider-toggle="${row.id}" style="cursor:pointer;">${row.active ? 'نشط' : 'موقوف'}</span></td>
      <td class="ads-row-actions">
        <button type="button" data-ls-provider-edit="${row.id}">تعديل</button>
        <button type="button" class="danger" data-ls-provider-delete="${row.id}">حذف</button>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-ls-provider-toggle]').forEach(el => {
    el.addEventListener('click', () => toggleLsProviderActive(el.dataset.lsProviderToggle));
  });
  body.querySelectorAll('[data-ls-provider-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = localServicesState.providers.find(p => p.id === Number(btn.dataset.lsProviderEdit));
      if (row) openLsProviderModal(row);
    });
  });
  body.querySelectorAll('[data-ls-provider-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteLsProvider(btn.dataset.lsProviderDelete));
  });
}

async function toggleLsProviderActive(id) {
  id = Number(id);
  const row = localServicesState.providers.find(p => p.id === id);
  if (!row) return;
  const { error } = await supabaseClient.from('local_service_providers').update({ active: !row.active }).eq('id', id);
  if (error) { console.error(error); return; }
  await loadLocalServiceProviders();
  renderLsProviders();
}

async function deleteLsProvider(id) {
  id = Number(id);
  if (!confirm('حذف مزود الخدمة هذا نهائياً؟')) return;
  const { error } = await supabaseClient.from('local_service_providers').delete().eq('id', id);
  if (error) { console.error(error); alert('تعذّر الحذف: ' + error.message); return; }
  closeLsProviderModal();
  await loadLocalServiceProviders();
  renderLsProviders();
}

/* ---------- رفع صورة مزود الخدمة — Supabase Storage bucket
   "local-service-images" (public read / admin-only write via
   is_admin(), same gate used everywhere else). Only writes the
   resulting public URL into the existing lsProviderImageUrl hidden
   field — local_service_providers.image_url column is untouched. ---------- */
function setLsProviderImagePreview(url) {
  const img = document.getElementById('lsProviderImagePreview');
  const removeBtn = document.getElementById('lsProviderImageRemoveBtn');
  if (!img) return;
  if (url) {
    img.src = url;
    img.style.display = 'block';
    if (removeBtn) removeBtn.hidden = false;
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
    if (removeBtn) removeBtn.hidden = true;
  }
}

async function handleLsProviderImageUpload(file) {
  const statusEl = document.getElementById('lsProviderImageUploadStatus');
  const uploadBtn = document.getElementById('lsProviderImageUploadBtn');
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    if (statusEl) statusEl.textContent = 'الملف المختار ليس صورة.';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    if (statusEl) statusEl.textContent = 'حجم الصورة يجب ألا يتجاوز 5MB.';
    return;
  }

  if (statusEl) statusEl.textContent = 'جارٍ رفع الصورة...';
  if (uploadBtn) uploadBtn.disabled = true;

  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `providers/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

  const { error: uploadError } = await supabaseClient.storage
    .from('local-service-images')
    .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type });

  if (uploadBtn) uploadBtn.disabled = false;

  if (uploadError) {
    console.error(uploadError);
    if (statusEl) statusEl.textContent = 'تعذّر رفع الصورة: ' + uploadError.message;
    return;
  }

  const { data: publicUrlData } = supabaseClient.storage.from('local-service-images').getPublicUrl(path);
  const publicUrl = publicUrlData?.publicUrl;
  if (!publicUrl) {
    if (statusEl) statusEl.textContent = 'تعذّر الحصول على رابط الصورة.';
    return;
  }

  document.getElementById('lsProviderImageUrl').value = publicUrl;
  setLsProviderImagePreview(publicUrl);
  if (statusEl) statusEl.textContent = 'تم رفع الصورة ✓';
}

function openLsProviderModal(row) {
  localServicesState.editingProviderId = row ? row.id : null;
  document.getElementById('lsProviderModalTitle').textContent = row ? 'تعديل مزود خدمة' : 'إضافة مزود خدمة';

  const sectionFilterVal = document.getElementById('lsProviderSectionFilter')?.value;
  const categoryFilterVal = document.getElementById('lsProviderCategoryFilter')?.value;
  const initialSectionId = row
    ? categorySectionId(row.category_id)
    : (sectionFilterVal ? Number(sectionFilterVal) : (localServicesState.sections[0]?.id ?? null));

  const sectionSel = document.getElementById('lsProviderSection');
  if (initialSectionId != null) sectionSel.value = String(initialSectionId);

  const initialCategoryId = row ? row.category_id : (categoryFilterVal ? Number(categoryFilterVal) : null);
  populateLsProviderCategorySelect(initialSectionId, 'lsProviderCategory', initialCategoryId);

  document.getElementById('lsProviderName').value = row?.name || '';
  document.getElementById('lsProviderSortOrder').value = row?.sort_order ?? '';
  document.getElementById('lsProviderImageUrl').value = row?.image_url || '';
  setLsProviderImagePreview(row?.image_url || '');
  const fileEl = document.getElementById('lsProviderImageFile');
  if (fileEl) fileEl.value = '';
  const uploadStatusEl = document.getElementById('lsProviderImageUploadStatus');
  if (uploadStatusEl) uploadStatusEl.textContent = '';
  document.getElementById('lsProviderDetails').value = row?.details || '';
  document.getElementById('lsProviderPhone').value = row?.phone || '';
  document.getElementById('lsProviderAddress').value = row?.address || '';
  document.getElementById('lsProviderLat').value = row?.lat ?? '';
  document.getElementById('lsProviderLng').value = row?.lng ?? '';
  document.getElementById('lsProviderHours').value = row?.hours_text || '';
  document.getElementById('lsProviderActive').checked = row ? !!row.active : true;

  document.getElementById('deleteLsProviderBtn').hidden = !row;
  showLsProviderModalError(null);
  document.getElementById('lsProviderModalBackdrop').classList.add('show');
}
function closeLsProviderModal() {
  document.getElementById('lsProviderModalBackdrop').classList.remove('show');
  localServicesState.editingProviderId = null;
}
function showLsProviderModalError(message) {
  const el = document.getElementById('lsProviderModalError');
  if (!el) return;
  if (message) { el.textContent = message; el.classList.add('show'); }
  else { el.textContent = ''; el.classList.remove('show'); }
}
async function saveLsProvider() {
  showLsProviderModalError(null);
  const categoryId = Number(document.getElementById('lsProviderCategory').value);
  const name = document.getElementById('lsProviderName').value.trim();
  const image_url = document.getElementById('lsProviderImageUrl').value.trim();
  const details = document.getElementById('lsProviderDetails').value.trim();
  const phone = document.getElementById('lsProviderPhone').value.trim();
  const address = document.getElementById('lsProviderAddress').value.trim();
  const latRaw = document.getElementById('lsProviderLat').value.trim();
  const lngRaw = document.getElementById('lsProviderLng').value.trim();
  const hours_text = document.getElementById('lsProviderHours').value.trim();
  const active = document.getElementById('lsProviderActive').checked;

  if (!categoryId) { showLsProviderModalError('اختر التصنيف الفرعي.'); return; }
  if (!name) { showLsProviderModalError('اسم مزود الخدمة مطلوب.'); return; }
  const sortOrder = readSortOrderInput('lsProviderSortOrder');
  if (!sortOrder.ok) { showLsProviderModalError('الترتيب يجب أن يكون رقمًا صحيحًا بين 0 و9999.'); return; }
  if (image_url && !/^https?:\/\//i.test(image_url)) {
    showLsProviderModalError('رابط الصورة يجب أن يبدأ بـ https:// وأن يكون رابطاً مباشراً للصورة.');
    return;
  }

  const payload = {
    category_id: categoryId,
    name,
    image_url: image_url || null,
    details: details || null,
    phone: phone || null,
    address: address || null,
    lat: latRaw ? Number(latRaw) : null,
    lng: lngRaw ? Number(lngRaw) : null,
    hours_text: hours_text || null,
    active,
  };
  if (sortOrder.value !== undefined) payload.sort_order = sortOrder.value;

  const editingId = localServicesState.editingProviderId;
  const btn = document.getElementById('saveLsProviderBtn');
  if (btn) btn.disabled = true;

  const { error } = editingId
    ? await supabaseClient.from('local_service_providers').update(payload).eq('id', editingId)
    : await supabaseClient.from('local_service_providers').insert(payload);

  if (btn) btn.disabled = false;
  if (error) {
    console.error(error);
    showLsProviderModalError('تعذّر الحفظ: ' + error.message);
    return;
  }
  closeLsProviderModal();
  await loadLocalServiceProviders();
  renderLsProviders();
}

/* ============================================================
   Service boards — لوحة طلبات منفصلة لكل خدمة (تبويب "الطلبات")

   Additive module. Reads/deletes trip_requests only through the
   existing supabaseClient; no schema change, no new service_type,
   no RPC touched. Everything the rest of this file uses
   (state.requests, loadRequests, openDetail, polling) is unchanged
   apart from tiny hooks:
     - loadRequests() calls refreshServiceBoard() when it finishes
       (so polling / status changes / driver saves refresh the board)
     - openDetail()/saveDriver()/updateStatus() look a request up via
       findRequestById(), which also finds rows only the board loaded
       (e.g. requests older than the latest-300 set).

   Counters are real database counts (head:true, count:'exact') per
   service + local calendar day — NOT computed from state.requests.

   To add a service later: flip `enabled: true` on its line below.
   ============================================================ */
const SERVICES = [
  { key: 'taxi',      icon: '🚕', label: 'التاكسي',       enabled: true },
  { key: 'courier',   icon: '🛵', label: 'الدليفري',      enabled: true },
  { key: 'private',   icon: '🚘', label: 'الخصوصي',      enabled: true },
  { key: 'starx',     icon: '🚐', label: 'نقل نفرات',     enabled: false },
  { key: 'cargo',     icon: '📦', label: 'شحن أو حمل',    enabled: false },
  { key: 'intercity', icon: '🛣️', label: 'بين المحافظات', enabled: false },
];
const BOARD_ROW_LIMIT = 500;                       // max rows shown for one service + one day
const BOARD_PURGE_STATUSES = ['completed', 'cancelled']; // "delete older" never touches live requests
const BOARD_DELETE_CHUNK = 50;                     // ids per delete request (keeps URLs short)

const boardState = {
  active: null,        // service key, or 'all' for the previous all-requests view
  date: null,          // 'YYYY-MM-DD' (local calendar day)
  rows: [],            // rows of the active service on the selected date
  dateCount: 0,        // real count for that date (can exceed rows.length)
  totalCount: 0,
  todayCounts: {},     // service key -> today's count
  selected: new Set(), // ids ticked for deletion
  loadToken: 0,        // drops out-of-order responses
  busy: false,
};

function enabledServices() { return SERVICES.filter(s => s.enabled); }
function boardService(key) { return SERVICES.find(s => s.key === key) || null; }

// state.requests first (latest 300), then whatever the board loaded.
function findRequestById(id) {
  return state.requests.find(r => r.id === id)
    || boardState.rows.find(r => r.id === id)
    || null;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Created-at split into a clock time and a date, in the admin's local time.
function formatDateTimeParts(iso) {
  if (!iso) return { date: '—', time: '', full: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: String(iso), time: '', full: '' };
  const date = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  const h24 = d.getHours();
  const time = `${pad2(h24 % 12 || 12)}:${pad2(d.getMinutes())} ${h24 >= 12 ? 'م' : 'ص'}`;
  const full = `${date} ${time}:${pad2(d.getSeconds())}`;
  return { date, time, full };
}

function dateStrToDisplay(dateStr) {
  const [y, m, d] = String(dateStr).split('-');
  return (y && m && d) ? `${d}/${m}/${y}` : String(dateStr || '');
}

function shiftDateStr(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// kind: 'error' | 'ok' | 'info' | falsy to hide.
// source: 'action' (delete results etc. — stays until the admin changes
// tab/date or refreshes) or 'auto' (row-limit note / load error — cleared
// by the next successful automatic refresh, never overwriting an 'action').
function showBoardMsg(text, kind, source) {
  const el = document.getElementById('svcMsg');
  if (!el) return;
  el.classList.remove('show', 'ok', 'info');
  el.dataset.source = '';
  if (!text) { el.textContent = ''; return; }
  el.textContent = text;
  el.dataset.source = source || 'action';
  el.classList.add('show');
  if (kind === 'ok') el.classList.add('ok');
  if (kind === 'info') el.classList.add('info');
}
function clearAutoBoardMsg() {
  const el = document.getElementById('svcMsg');
  if (el && el.dataset.source === 'auto') showBoardMsg(null);
}
function canShowAutoBoardMsg() {
  const el = document.getElementById('svcMsg');
  return !el || el.dataset.source !== 'action' || !el.classList.contains('show');
}

// Exact count for one service; with dateStr → only that local day.
async function countServiceRequests(key, dateStr) {
  let q = supabaseClient
    .from('trip_requests')
    .select('id', { count: 'exact', head: true })
    .eq('service_type', key);
  if (dateStr) {
    const { startIso, endIso } = dayBoundsIso(dateStr);
    q = q.gte('created_at', startIso).lt('created_at', endIso);
  }
  const { count, error } = await q;
  if (error) { console.error(error); return null; }
  return count ?? 0;
}

async function loadTodayCounts() {
  const today = todayDateStr();
  const list = enabledServices();
  const counts = await Promise.all(list.map(s => countServiceRequests(s.key, today)));
  list.forEach((s, i) => { if (counts[i] !== null) boardState.todayCounts[s.key] = counts[i]; });
  renderTabBadges();
}

function renderTabBadges() {
  document.querySelectorAll('[data-svc-badge]').forEach(el => {
    const n = boardState.todayCounts[el.dataset.svcBadge];
    el.textContent = (n === undefined) ? '…' : n;
  });
}

function setBoardLoading(on) {
  const el = document.getElementById('svcLoading');
  if (el) el.style.display = on ? 'block' : 'none';
}

async function refreshServiceBoard() {
  if (!document.getElementById('serviceBoard')) return;
  if (!state.session) return;

  if (boardState.active === 'all' || !boardService(boardState.active)) {
    loadTodayCounts(); // keep the tab badges fresh even while viewing "all"
    return;
  }

  const token = ++boardState.loadToken;
  const key = boardState.active;
  const date = boardState.date;
  const { startIso, endIso } = dayBoundsIso(date);

  setBoardLoading(true);
  const [rowsRes, totalCount] = await Promise.all([
    supabaseClient
      .from('trip_requests')
      .select('*', { count: 'exact' })
      .eq('service_type', key)
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .order('created_at', { ascending: false })
      .limit(BOARD_ROW_LIMIT),
    countServiceRequests(key, null),
    loadTodayCounts(),
  ]);
  if (token !== boardState.loadToken) return; // a newer refresh superseded this one
  setBoardLoading(false);

  if (rowsRes.error) {
    console.error(rowsRes.error);
    boardState.rows = [];
    boardState.dateCount = 0;
    if (canShowAutoBoardMsg()) showBoardMsg('تعذّر تحميل الطلبات. تأكد من صلاحيات حسابك.', 'error', 'auto');
    renderServiceBoard();
    return;
  }

  boardState.rows = rowsRes.data || [];
  boardState.dateCount = rowsRes.count ?? boardState.rows.length;
  boardState.totalCount = totalCount ?? boardState.totalCount;

  // Keep ticks only for rows that are still on screen.
  const visible = new Set(boardState.rows.map(r => r.id));
  boardState.selected = new Set([...boardState.selected].filter(id => visible.has(id)));

  if (boardState.dateCount > boardState.rows.length) {
    if (canShowAutoBoardMsg()) showBoardMsg(`يُعرض أحدث ${boardState.rows.length} طلب من أصل ${boardState.dateCount} في هذا التاريخ. الأرقام أعلاه هي العدد الحقيقي.`, 'info', 'auto');
  } else {
    clearAutoBoardMsg();
  }
  renderServiceBoard();
}

function renderServiceBoard() {
  const svc = boardService(boardState.active);
  if (!svc) return;

  const today = todayDateStr();
  const todayN = boardState.todayCounts[svc.key];
  document.getElementById('svcStatToday').textContent = (todayN === undefined) ? '…' : todayN;
  document.getElementById('svcStatDate').textContent = boardState.dateCount;
  document.getElementById('svcStatDateLabel').textContent =
    dateStrToDisplay(boardState.date) + (boardState.date === today ? ' (اليوم)' : '');
  document.getElementById('svcStatTotal').textContent = boardState.totalCount;

  const body = document.getElementById('svcBody');
  const empty = document.getElementById('svcEmpty');
  const rows = boardState.rows;

  if (rows.length === 0) {
    body.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = `لا توجد طلبات ${svc.label} بتاريخ ${dateStrToDisplay(boardState.date)}.`;
  } else {
    empty.style.display = 'none';
    body.innerHTML = rows.map(r => {
      const dt = formatDateTimeParts(r.created_at);
      const checked = boardState.selected.has(r.id);
      return `
        <tr class="clickable${checked ? ' selected' : ''}" data-id="${escapeAttr(r.id)}">
          <td class="svc-check"><input type="checkbox" data-select-id="${escapeAttr(r.id)}" aria-label="تحديد الطلب"${checked ? ' checked' : ''}></td>
          <td>${escapeHtml(r.request_number || r.id.slice(0, 8))}</td>
          <td>${escapeHtml(r.customer_name)}</td>
          <td>${escapeHtml(r.phone)}</td>
          <td class="svc-wrap">${escapeHtml(r.pickup_location)}</td>
          <td><span class="status-pill ${escapeAttr(r.status)}">${escapeHtml(STATUS_LABELS[r.status] || r.status)}</span></td>
          <td class="svc-dt" title="${escapeAttr(dt.full)}"><b>${escapeHtml(dt.time)}</b><span>${escapeHtml(dt.date)}</span></td>
        </tr>`;
    }).join('');
  }
  updateBoardSelectionUi();
}

function updateBoardSelectionUi() {
  const n = boardState.selected.size;
  const btn = document.getElementById('svcDeleteSelectedBtn');
  if (btn) {
    btn.textContent = `حذف المحدد (${n})`;
    btn.disabled = boardState.busy || n === 0;
  }
  const purge = document.getElementById('svcPurgeBtn');
  if (purge) purge.disabled = boardState.busy;
  const all = document.getElementById('svcSelectAll');
  if (all) {
    const total = boardState.rows.length;
    all.checked = total > 0 && n === total;
    all.indeterminate = n > 0 && n < total;
  }
}

function selectService(key) {
  boardState.active = key;
  boardState.selected.clear();
  showBoardMsg(null);

  document.querySelectorAll('.svc-tab').forEach(b => b.classList.toggle('active', b.dataset.svc === key));
  const isAll = (key === 'all');
  document.getElementById('serviceBoard').hidden = isAll;
  document.getElementById('allRequestsView').hidden = !isAll;

  if (!isAll) {
    boardState.rows = [];
    boardState.dateCount = 0;
    boardState.totalCount = 0;
    renderServiceBoard();
  }
  refreshServiceBoard();
}

function setBoardDate(dateStr) {
  if (!dateStr) return;
  boardState.date = dateStr;
  boardState.selected.clear();
  showBoardMsg(null);
  const input = document.getElementById('svcDate');
  if (input) input.value = dateStr;
  refreshServiceBoard();
}

/* ---------- Deletion ---------- */
// Reports honestly what happened. Supabase/RLS silently deletes 0 rows
// (no error) when the admin has no DELETE policy, so we compare the rows
// actually returned with what was requested.
function reportBoardDelete(deleted, requested) {
  if (deleted === 0) {
    showBoardMsg('لم يُحذف أي طلب. غالباً حسابك لا يملك صلاحية الحذف على جدول الطلبات (RLS) — راجع ملف SQL المقترح قبل تنفيذه.', 'error');
  } else if (deleted < requested) {
    showBoardMsg(`تم حذف ${deleted} من أصل ${requested} طلب. الباقي لم يُحذف (صلاحيات أو قيود في قاعدة البيانات).`, 'error');
  } else {
    showBoardMsg(`تم حذف ${deleted} طلب.`, 'ok');
  }
}

async function afterBoardDelete() {
  boardState.selected.clear();
  await loadRequests(); // refreshes state.requests and (via hook) the board
  loadDriverStats(driverStatsState.selectedDate); // driver day-counts derive from trip_requests
}

async function deleteSelectedRequests() {
  const ids = [...boardState.selected];
  if (ids.length === 0 || boardState.busy) return;

  const live = ids.map(findRequestById).filter(r => r && !BOARD_PURGE_STATUSES.includes(r.status)).length;
  let msg = `سيتم حذف ${ids.length} طلب نهائياً ولا يمكن التراجع عن ذلك.`;
  if (live > 0) msg += `\n\nتنبيه: ${live} منها ما زالت قيد المعالجة (ليست مكتملة أو ملغاة).`;
  if (!window.confirm(msg)) return;

  boardState.busy = true;
  updateBoardSelectionUi();
  let deleted = 0;
  try {
    for (let i = 0; i < ids.length; i += BOARD_DELETE_CHUNK) {
      const chunk = ids.slice(i, i + BOARD_DELETE_CHUNK);
      const { data, error } = await supabaseClient
        .from('trip_requests')
        .delete()
        .in('id', chunk)
        .select('id');
      if (error) throw error;
      deleted += (data || []).length;
    }
    reportBoardDelete(deleted, ids.length);
  } catch (err) {
    console.error(err);
    showBoardMsg('تعذّر الحذف: ' + (err.message || err) + (deleted ? `\n(تم حذف ${deleted} قبل الخطأ)` : ''), 'error');
  } finally {
    boardState.busy = false;
    await afterBoardDelete();
  }
}

// Deletes finished (completed/cancelled) requests of the ACTIVE service that
// were created before the start of the chosen day. Live requests are never
// touched by this button.
async function purgeOldRequests() {
  if (boardState.busy) return;
  const svc = boardService(boardState.active);
  const dateStr = document.getElementById('svcPurgeDate').value;
  if (!svc) return;
  if (!dateStr) { showBoardMsg('اختر التاريخ أولاً.', 'error'); return; }

  const { startIso } = dayBoundsIso(dateStr);
  const { count, error: countErr } = await supabaseClient
    .from('trip_requests')
    .select('id', { count: 'exact', head: true })
    .eq('service_type', svc.key)
    .in('status', BOARD_PURGE_STATUSES)
    .lt('created_at', startIso);
  if (countErr) { console.error(countErr); showBoardMsg('تعذّر حساب الطلبات: ' + countErr.message, 'error'); return; }
  if (!count) { showBoardMsg(`لا توجد طلبات ${svc.label} مكتملة/ملغاة قبل ${dateStrToDisplay(dateStr)}.`, 'info'); return; }

  const msg = `سيتم حذف ${count} طلب (مكتمل/ملغى) من «${svc.label}» أُنشئت قبل ${dateStrToDisplay(dateStr)} نهائياً ولا يمكن التراجع عن ذلك.\n\nالطلبات غير المكتملة لن تُحذف.`;
  if (!window.confirm(msg)) return;

  boardState.busy = true;
  updateBoardSelectionUi();
  try {
    const { data, error } = await supabaseClient
      .from('trip_requests')
      .delete()
      .eq('service_type', svc.key)
      .in('status', BOARD_PURGE_STATUSES)
      .lt('created_at', startIso)
      .select('id');
    if (error) throw error;
    reportBoardDelete((data || []).length, count);
  } catch (err) {
    console.error(err);
    showBoardMsg('تعذّر الحذف: ' + (err.message || err), 'error');
  } finally {
    boardState.busy = false;
    await afterBoardDelete();
  }
}

function initServiceBoards() {
  const tabs = document.getElementById('serviceTabs');
  if (!tabs || !document.getElementById('serviceBoard')) return;

  boardState.date = todayDateStr();
  boardState.active = enabledServices()[0]?.key || 'all';

  tabs.innerHTML = enabledServices().map(s => `
    <button type="button" class="svc-tab" data-svc="${escapeAttr(s.key)}">
      <span>${escapeHtml(s.icon)} ${escapeHtml(s.label)}</span>
      <span class="svc-badge" data-svc-badge="${escapeAttr(s.key)}">…</span>
    </button>`).join('') + `
    <button type="button" class="svc-tab" data-svc="all"><span>📋 كل الطلبات</span></button>`;
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-svc]');
    if (btn) selectService(btn.dataset.svc);
  });

  document.getElementById('svcDate').value = boardState.date;
  document.getElementById('svcPurgeDate').value = shiftDateStr(boardState.date, -30);
  document.getElementById('svcDate').addEventListener('change', (e) => setBoardDate(e.target.value));
  document.getElementById('svcTodayBtn').addEventListener('click', () => setBoardDate(todayDateStr()));
  document.getElementById('svcYesterdayBtn').addEventListener('click', () => setBoardDate(shiftDateStr(todayDateStr(), -1)));
  document.getElementById('svcRefreshBtn').addEventListener('click', () => { showBoardMsg(null); refreshServiceBoard(); });
  document.getElementById('svcDeleteSelectedBtn').addEventListener('click', deleteSelectedRequests);
  document.getElementById('svcPurgeBtn').addEventListener('click', purgeOldRequests);

  document.getElementById('svcSelectAll').addEventListener('change', (e) => {
    boardState.selected = e.target.checked ? new Set(boardState.rows.map(r => r.id)) : new Set();
    renderServiceBoard();
  });

  const body = document.getElementById('svcBody');
  body.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-select-id]');
    if (!box) return;
    if (box.checked) boardState.selected.add(box.dataset.selectId);
    else boardState.selected.delete(box.dataset.selectId);
    box.closest('tr')?.classList.toggle('selected', box.checked);
    updateBoardSelectionUi();
  });
  body.addEventListener('click', (e) => {
    if (e.target.closest('.svc-check')) return; // ticking a box must not open the modal
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDetail(tr.dataset.id);
  });

  selectService(boardState.active);
}

/* ============================================================
   Init
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
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
  document.getElementById('addRestaurantBtn')?.addEventListener('click', () => openPlaceModal('restaurants', null));
  document.getElementById('addMarketBtn')?.addEventListener('click', () => openPlaceModal('markets', null));
  document.getElementById('addFutureOfficeBtn')?.addEventListener('click', () => openPlaceModal('futureOffice', null));
  document.getElementById('placeModalCloseBtn')?.addEventListener('click', closePlaceModal);
  document.getElementById('placeModalBackdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'placeModalBackdrop') closePlaceModal();
  });
  document.getElementById('savePlaceBtn')?.addEventListener('click', savePlace);
  document.getElementById('deletePlaceBtn')?.addEventListener('click', () => deletePlace(placesState.editingKind, placesState.editingId));
  placeImageWidget.bind();
  adImageWidget.bind();

  document.getElementById('addLsSectionBtn')?.addEventListener('click', () => openLsSectionModal(null));
  document.getElementById('lsSectionModalCloseBtn')?.addEventListener('click', closeLsSectionModal);
  document.getElementById('lsSectionModalBackdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'lsSectionModalBackdrop') closeLsSectionModal();
  });
  document.getElementById('saveLsSectionBtn')?.addEventListener('click', saveLsSection);
  document.getElementById('deleteLsSectionBtn')?.addEventListener('click', () => deleteLsSection(localServicesState.editingSectionId));

  document.getElementById('lsCategoryModalCloseBtn')?.addEventListener('click', closeLsCategoryModal);
  document.getElementById('lsCategoryModalBackdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'lsCategoryModalBackdrop') closeLsCategoryModal();
  });
  document.getElementById('saveLsCategoryBtn')?.addEventListener('click', saveLsCategory);
  document.getElementById('deleteLsCategoryBtn')?.addEventListener('click', () => deleteLsCategory(localServicesState.editingCategoryId));

  document.getElementById('addLsProviderBtn')?.addEventListener('click', () => openLsProviderModal(null));
  document.getElementById('lsProviderModalCloseBtn')?.addEventListener('click', closeLsProviderModal);
  document.getElementById('lsProviderModalBackdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'lsProviderModalBackdrop') closeLsProviderModal();
  });
  document.getElementById('saveLsProviderBtn')?.addEventListener('click', saveLsProvider);
  document.getElementById('deleteLsProviderBtn')?.addEventListener('click', () => deleteLsProvider(localServicesState.editingProviderId));
  document.getElementById('lsProviderImageUploadBtn')?.addEventListener('click', () => {
    document.getElementById('lsProviderImageFile')?.click();
  });
  document.getElementById('lsProviderImageFile')?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleLsProviderImageUpload(file);
  });
  document.getElementById('lsProviderImageRemoveBtn')?.addEventListener('click', () => {
    document.getElementById('lsProviderImageUrl').value = '';
    setLsProviderImagePreview('');
    const fileEl = document.getElementById('lsProviderImageFile');
    if (fileEl) fileEl.value = '';
    const statusEl = document.getElementById('lsProviderImageUploadStatus');
    if (statusEl) statusEl.textContent = '';
  });
  document.getElementById('lsProviderSection')?.addEventListener('change', (e) => {
    populateLsProviderCategorySelect(e.target.value, 'lsProviderCategory', null);
  });
  document.getElementById('lsProviderSectionFilter')?.addEventListener('change', () => {
    populateLsProviderCategorySelect(document.getElementById('lsProviderSectionFilter').value, 'lsProviderCategoryFilter', '');
    renderLsProviders();
  });
  document.getElementById('lsProviderCategoryFilter')?.addEventListener('change', renderLsProviders);
  document.getElementById('driverStatsDate').addEventListener('change', (e) => {
    if (e.target.value) loadDriverStats(e.target.value);
  });
  document.getElementById('driverStatsTodayBtn').addEventListener('click', () => loadDriverStats(todayDateStr()));
  document.getElementById('driverStatsRefreshBtn').addEventListener('click', () => loadDriverStats(driverStatsState.selectedDate));
  populateDriverServiceSelect();
  convertDriverPhoneFieldToSelect();
  document.getElementById('addDriverBtn').addEventListener('click', addDriver);
  document.getElementById('createAccountDriverSelect')?.addEventListener('change', handleCreateAccountDriverSelect);
  document.getElementById('createDriverAccountBtn')?.addEventListener('click', handleCreateDriverAccount);
  document.querySelectorAll('.admin-status-actions button').forEach(b => {
    b.addEventListener('click', () => updateStatus(b.dataset.status));
  });
  initServiceBoards();
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
