/* Mustaqbali Cab — driver.html logic.
   Token-only auth (see chat decision): the URL's ?driver_token= value
   is the driver's one and only credential, sent as p_token with every
   location ping to update_driver_location(p_token, p_lat, p_lng) — that
   RPC's own parameter name is p_token and is left untouched (unified
   token system decision: only the drivers.driver_token column/link
   naming changed, never these two existing functions' signatures). No
   password, no Supabase Auth session — matches the "single secret
   link" design.

   Reporting strategy: getCurrentPosition on a fixed interval (NOT
   watchPosition) — a deliberate battery/data trade-off discussed and
   approved in chat. One fix every REPORT_INTERVAL_MS is more than
   enough for zone/distance sorting, and is far lighter than a
   continuous GPS lock. */

const REPORT_INTERVAL_MS = 15000; // 15s — balances "real-time enough for
                                   // sorting" against battery/data use.
const GEO_TIMEOUT_MS = 12000;
const TOKEN_STORAGE_KEY = 'mustaqbali_driver_token';

// Current-trip polling (get_driver_current_trip RPC) — separate, lighter
// cadence from GPS reporting above. Purely additive: does not touch
// reportTimer/REPORT_INTERVAL_MS or the driver-queue/location-ping flow.
const TRIP_POLL_INTERVAL_MS = 15000;

const TRIP_STATUS_LABELS = {
  assigned: 'تم التعيين',
  accepted: 'تم القبول',
  en_route: 'في الطريق',
  arrived: 'وصل',
};

// "gone" (post-reject) banner auto-hide delay.
const TRIP_GONE_MSG_MS = 8000;

// Public VAPID key — safe to embed client-side by design (it's how the
// browser verifies push messages came from OUR server, not a secret).
// The matching PRIVATE key lives only in the push-sending Edge Function
// (deployed under the slug "super-worker" — see that function's own
// header comment for why), never in this file.
const VAPID_PUBLIC_KEY = 'BFVWm5hrmgd1XW353mNtKys8H6fSrdvhpIWiksixEUMcP1ZmyiNQohlGR3DIVOScBtW3bIyhnPPmADi4Ncg7nFk'; // ⚠️ replace with your real generated key before deploying — must match admin.js's key exactly

let driverToken = null;
let reportTimer = null;
let paused = false;
let consecutiveFailures = 0;

// Current-trip state
let currentTrip = null;
let tripTimer = null;

// Accept/reject state — isResponding guards against double-clicks /
// double-submits while the driver_respond_to_trip RPC is in flight.
let isResponding = false;
let tripGoneMsgTimer = null;

function getTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const t = params.get('driver_token');
  const result = t && t.trim() ? t.trim() : null;
  return result;
}

// Falls back to a previously-saved token when the page is opened
// without ?driver_token= in the URL — this is what lets tapping a push
// notification reopen driver.html correctly (a notification click
// can't carry the original query string). The very first visit must
// still come from the real ?driver_token= link; after that, this is
// purely additive convenience and never overrides an explicit URL token.
function resolveDriverToken() {
  const fromUrl = getTokenFromUrl();
  if (fromUrl) {
    try { localStorage.setItem(TOKEN_STORAGE_KEY, fromUrl); } catch (_) {}
    return fromUrl;
  }
  let stored = null;
  try { stored = localStorage.getItem(TOKEN_STORAGE_KEY); } catch (_) { stored = null; }
  return stored;
}

function setStatus(dotClass, text) {
  const dot = document.getElementById('driverStatusDot');
  const txt = document.getElementById('driverStatusText');
  if (dot) dot.className = 'driver-status-dot' + (dotClass ? ' ' + dotClass : '');
  if (txt) txt.textContent = text;
}

// FIX (invalid-link-shows-with-main-screen bug): `.hidden = true/false`
// alone only works if no author CSS rule (e.g. `.driver-screen { display:
// flex }`) overrides the browser's default `[hidden]{display:none}` —
// which is exactly what was happening: both screens rendered at once.
// Setting inline style.display explicitly always wins over any class-
// based CSS rule (hidden or not), without editing driver.css/style.css
// at all. 'none' when hiding; '' (cleared) when showing, so the
// stylesheet's own display value (flex/block/whatever it is) still
// applies normally to the visible screen — this only forces the HIDDEN
// one off, it never dictates how the shown one looks.
function setScreenVisible(el, visible) {
  if (!el) return;
  el.hidden = !visible;
  el.style.display = visible ? '' : 'none';
}

function setLastSent(date) {
  const el = document.getElementById('driverLastSent');
  if (!el) return;
  const t = date.toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' });
  el.textContent = `آخر إرسال: ${t}`;
}

// Shows the real reason behind "رابط غير صالح" when one is available
// (an actual RPC/network error), instead of only the generic copy.
// Purely additive display helper — driverInvalidDetail is an optional
// element; if it isn't present in the page nothing breaks.
function setInvalidDetail(message) {
  const el = document.getElementById('driverInvalidDetail');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

async function sendLocation(lat, lng) {
  try {
    const { error } = await supabaseClient.rpc('update_driver_location', {
      p_token: driverToken,
      p_lat: lat,
      p_lng: lng,
    });
    if (error) throw error;
    consecutiveFailures = 0;
    setStatus('live', 'يعمل — يرسل موقعك تلقائيًا');
    setLastSent(new Date());
  } catch (err) {
    consecutiveFailures += 1;
    console.error('update_driver_location failed', err);
    setStatus(consecutiveFailures >= 3 ? 'error' : 'warn', 'تعذّر إرسال الموقع — سيُعاد المحاولة');
  }
}

function reportOnce() {
  if (paused) return;
  if (!navigator.geolocation) {
    setStatus('error', 'هذا الجهاز/المتصفح لا يدعم تحديد الموقع (GPS)');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => sendLocation(pos.coords.latitude, pos.coords.longitude),
    (err) => {
      console.error('geolocation error', err);
      if (err.code === err.PERMISSION_DENIED) {
        // FIX: stopReporting() used to be called with no arguments here,
        // and it unconditionally overwrote the status line with the
        // generic "متوقف مؤقتًا" text — wiping out the permission-denied
        // message the very same tick it was shown. The driver never saw
        // *why* nothing was happening; pressing "استئناف الإرسال" looked
        // like a no-op. Passing `true` tells stopReporting() to leave
        // the status line alone so this specific error message survives.
        setStatus('error', 'تم رفض إذن الموقع — فعّله من إعدادات المتصفح لمتابعة العمل');
        stopReporting(true);
      } else {
        setStatus('warn', 'تعذّر تحديد موقعك حاليًا — سيُعاد المحاولة');
      }
    },
    { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 5000 }
  );
}

// `preserveStatus` (optional, default false): when true, skip resetting
// the status line to the generic "متوقف مؤقتًا" message. Used by the
// PERMISSION_DENIED handler in reportOnce() above so its explicit error
// message stays visible instead of being overwritten in the same tick.
// The manual "إيقاف مؤقت" button click still calls stopReporting() with
// no argument, so that path is unchanged.
function stopReporting(preserveStatus) {
  paused = true;
  if (reportTimer) clearInterval(reportTimer);
  reportTimer = null;
  const btn = document.getElementById('driverToggleBtn');
  if (btn) { btn.textContent = 'استئناف الإرسال'; btn.classList.add('paused'); }
  if (!preserveStatus) {
    setStatus(null, 'متوقف مؤقتًا — لن يظهر موقعك للزبائن');
  }
}

// ---- Current trip (get_driver_current_trip RPC) ----
// Read-only lookup, independent of GPS reporting/pause state: the
// driver's current trip and pickup location should still be visible
// even while reporting is paused.

function renderTrip(trip) {
  currentTrip = trip;

  const box = document.getElementById('driverTripBox');
  const emptyEl = document.getElementById('driverTripEmpty');
  const detailsEl = document.getElementById('driverTripDetails');
  const mapBtn = document.getElementById('driverOpenMapBtn');
  if (!box || !emptyEl || !detailsEl) return;

  box.hidden = false;

  if (!trip) {
    emptyEl.hidden = false;
    detailsEl.hidden = true;
    if (mapBtn) mapBtn.hidden = true;
    renderTripActions(null);
    return;
  }

  emptyEl.hidden = true;
  detailsEl.hidden = false;

  // A real trip is showing again — the post-reject "gone" banner (if
  // still up from a moment ago) no longer applies.
  hideTripGoneMessage();

  setText('driverTripRequestNumber', trip.request_number || '');
  setText('driverTripStatus', TRIP_STATUS_LABELS[trip.status] || trip.status || '');
  setText('driverTripCustomer', trip.customer_name || '—');
  setText('driverTripServiceType', trip.service_type || '—');
  setText('driverTripPickupLocation', trip.pickup_location || '—');

  if (mapBtn) {
    // pickup_lat/pickup_lng are used exactly as returned by
    // get_driver_current_trip — no conversion, no substitution with the
    // text pickup_location.
    if (trip.pickup_lat != null && trip.pickup_lng != null) {
      mapBtn.hidden = false;
      mapBtn.dataset.lat = trip.pickup_lat;
      mapBtn.dataset.lng = trip.pickup_lng;
    } else {
      mapBtn.hidden = true;
      delete mapBtn.dataset.lat;
      delete mapBtn.dataset.lng;
    }
  }

  renderTripActions(trip);
}

// ---- Accept / Reject (driver_respond_to_trip RPC) ----
// Purely additive on top of the read-only trip box above: shows the
// accept/reject card only while status === 'assigned', and reflects
// 'accepted' (buttons disabled, no further action possible) once the
// driver has responded. Independent of GPS reporting/pause state,
// same as the rest of the trip box.

function setRespondMsg(text, isError) {
  const el = document.getElementById('driverRespondMsg');
  if (!el) return;
  if (!text) {
    el.textContent = '';
    el.hidden = true;
    el.classList.remove('is-error');
    return;
  }
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle('is-error', !!isError);
}

function hideTripGoneMessage() {
  const el = document.getElementById('driverTripGoneMsg');
  if (tripGoneMsgTimer) { clearTimeout(tripGoneMsgTimer); tripGoneMsgTimer = null; }
  if (el) el.hidden = true;
}

function showTripGoneMessage(text) {
  const el = document.getElementById('driverTripGoneMsg');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (tripGoneMsgTimer) clearTimeout(tripGoneMsgTimer);
  tripGoneMsgTimer = setTimeout(() => { el.hidden = true; }, TRIP_GONE_MSG_MS);
}

function renderTripActions(trip) {
  const box = document.getElementById('driverTripActions');
  const acceptBtn = document.getElementById('driverAcceptBtn');
  const rejectBtn = document.getElementById('driverRejectBtn');
  if (!box || !acceptBtn || !rejectBtn) return;

  if (!trip || (trip.status !== 'assigned' && trip.status !== 'accepted')) {
    box.hidden = true;
    return;
  }

  box.hidden = false;

  if (trip.status === 'accepted') {
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    setRespondMsg('تم قبول الطلب ✅', false);
  } else {
    // 'assigned' — actionable, unless a request is already in flight.
    acceptBtn.disabled = isResponding;
    rejectBtn.disabled = isResponding;
    if (!isResponding) setRespondMsg(null);
  }
}

// get_driver_current_trip's exact column name for the trip's own
// primary key was not directly confirmed against the live schema
// (schema.sql was not made available in this task) — `id` is the
// conventional name and is used first, with a defensive fallback to
// `request_id` in case the RPC exposes it under that name instead.
// If a driver ever sees "تعذّر تحديد رقم الطلب", this is the first
// thing to check against the real RPC definition.
function getTripRequestId(trip) {
  if (!trip) return null;
  return trip.id || trip.request_id || null;
}

async function respondToTrip(action) {
  if (isResponding) return; // guards against double-click / double-submit
  if (!currentTrip) return;

  const requestId = getTripRequestId(currentTrip);
  if (!requestId) {
    console.error('driver_respond_to_trip: no id-like field found on currentTrip', currentTrip);
    setRespondMsg('تعذّر تحديد رقم الطلب — أعد تحميل الصفحة وحاول مجدداً', true);
    return;
  }

  isResponding = true;
  const acceptBtn = document.getElementById('driverAcceptBtn');
  const rejectBtn = document.getElementById('driverRejectBtn');
  if (acceptBtn) acceptBtn.disabled = true;
  if (rejectBtn) rejectBtn.disabled = true;
  setRespondMsg(action === 'accept' ? 'جارٍ تأكيد القبول…' : 'جارٍ إرسال الرفض…', false);

  try {
    const { data, error } = await supabaseClient.rpc('driver_respond_to_trip', {
      p_token: driverToken,
      p_request_id: requestId,
      p_action: action,
    });
    if (error) throw error;

    const result = Array.isArray(data) ? (data[0] || null) : (data || null);
    const newStatus = result?.new_status || (action === 'accept' ? 'accepted' : 'new');

    if (action === 'accept') {
      currentTrip = { ...currentTrip, status: newStatus };
      renderTrip(currentTrip);
    } else {
      currentTrip = null;
      renderTrip(null);
      showTripGoneMessage('تم رفض الطلب. ستقوم الإدارة بإعادة تعيينه لاحقاً.');
    }
  } catch (err) {
    console.error('driver_respond_to_trip failed', err);
    setRespondMsg('تعذّر تنفيذ العملية — تحقق من الاتصال وحاول مجدداً', true);
    // Re-enable so the driver can retry immediately; the next poll will
    // also recompute this correctly regardless.
    if (acceptBtn) acceptBtn.disabled = false;
    if (rejectBtn) rejectBtn.disabled = false;
  } finally {
    isResponding = false;
  }
}

async function fetchCurrentTrip() {
  if (!driverToken) return;
  try {
    const { data, error } = await supabaseClient.rpc('get_driver_current_trip', {
      p_token: driverToken,
    });
    if (error) throw error;
    const trip = Array.isArray(data) ? (data[0] || null) : (data || null);
    renderTrip(trip);
  } catch (err) {
    console.error('get_driver_current_trip failed', err);
    // Non-fatal: leave whatever trip info was last shown in place
    // rather than clearing it on a transient network error.
  }
}

function startTripPolling() {
  fetchCurrentTrip();
  if (tripTimer) clearInterval(tripTimer);
  tripTimer = setInterval(fetchCurrentTrip, TRIP_POLL_INTERVAL_MS);
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Best-effort, non-blocking: notifications are a convenience on top of
// the core GPS reporting, so any failure here (unsupported browser,
// permission denied, offline) must never interrupt reportOnce()/
// startReporting() above.
async function setupPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (!driverToken) return;

  try {
    const registration = await navigator.serviceWorker.register('driver-sw.js');
    let permission = Notification.permission;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') return;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    await supabaseClient.rpc('save_driver_push_subscription', {
      p_token: driverToken,
      p_subscription: subscription.toJSON(),
    });
  } catch (err) {
    console.error('push setup failed (non-fatal)', err);
  }
}

// Verifies the token from the URL/localStorage actually matches an
// active driver in the database, via the narrow get_driver_by_token()
// RPC (see schema.sql) — read-only, returns only { id, name } for
// exactly one row, never the full roster. A token simply being present
// is no longer enough to open the main screen; it must be found in
// `drivers.driver_token` or the "invalid link" screen is shown instead
// (requirement from the driver-link-system task).
//
// Returns { driver, error }: `error` is only set when the RPC call
// itself failed (network/permissions/schema mismatch) — a *real*
// problem, as opposed to a clean "no row for this token" result. The
// caller (initDriverPage) uses this to show the actual reason instead
// of always defaulting to the same "invalid link" copy.
async function lookupDriverByToken(token) {
  try {
    const { data, error } = await supabaseClient.rpc('get_driver_by_token', {
      p_driver_token: token,
    });

    if (error) throw error;
    const driver = Array.isArray(data) ? (data[0] || null) : (data || null);
    return { driver, error: null };
  } catch (err) {
    console.error('get_driver_by_token failed', err);
    return { driver: null, error: err };
  }
}

async function initDriverPage() {
  driverToken = resolveDriverToken();
  const invalidScreen = document.getElementById('driverInvalidScreen');
  const mainScreen = document.getElementById('driverMainScreen');

  if (!driverToken) {
    setInvalidDetail(null);
    setScreenVisible(invalidScreen, true);
    setScreenVisible(mainScreen, false);
    return;
  }

  const { driver, error } = await lookupDriverByToken(driverToken);

  if (error) {
    // The RPC call itself failed — token may well be correct, this is
    // a real infrastructure problem (network/permissions/schema). Show
    // it instead of silently reusing the generic "invalid link" copy,
    // and do NOT clear the saved token: it hasn't been proven invalid.
    setScreenVisible(invalidScreen, true);
    setScreenVisible(mainScreen, false);
    setInvalidDetail('خطأ تقني: ' + (error.message || error.code || String(error)));
    return;
  }

  if (!driver) {
    // RPC succeeded and cleanly returned no row — token is genuinely
    // wrong, revoked, or belongs to an inactive driver. Same "invalid
    // link" screen as before, and drop it from localStorage so a stale
    // token doesn't keep silently failing on future visits.
    setInvalidDetail(null);
    setScreenVisible(invalidScreen, true);
    setScreenVisible(mainScreen, false);
    try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch (_) {}
    return;
  }

  setScreenVisible(mainScreen, true);
  setScreenVisible(invalidScreen, false);

  const toggleBtn = document.getElementById('driverToggleBtn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      if (paused) startReporting();
      else stopReporting();
    });
  }

  const acceptBtn = document.getElementById('driverAcceptBtn');
  if (acceptBtn) {
    acceptBtn.addEventListener('click', () => respondToTrip('accept'));
  }
  const rejectBtn = document.getElementById('driverRejectBtn');
  if (rejectBtn) {
    rejectBtn.addEventListener('click', () => respondToTrip('reject'));
  }

  // Opens the customer's pickup location using pickup_lat/pickup_lng
  // exactly as stored in trip_requests (read from the button's
  // data-lat/data-lng, set in renderTrip from the RPC result) — no
  // transformation, no fallback to pickup_location text.
  const mapBtn = document.getElementById('driverOpenMapBtn');
  if (mapBtn) {
    mapBtn.addEventListener('click', () => {
      const lat = mapBtn.dataset.lat;
      const lng = mapBtn.dataset.lng;
      if (!lat || !lng) return;
      const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
      window.open(url, '_blank', 'noopener');
    });
  }

  // Re-send promptly when the tab regains focus/visibility — mobile
  // browsers throttle background timers, so this recovers quickly
  // instead of waiting up to REPORT_INTERVAL_MS after switching back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !paused) reportOnce();
    if (!document.hidden) fetchCurrentTrip();
  });

  startReporting();
  startTripPolling();
  setupPushNotifications();
}

function startReporting() {
  paused = false;
  const btn = document.getElementById('driverToggleBtn');
  if (btn) { btn.textContent = 'إيقاف مؤقت'; btn.classList.remove('paused'); }
  reportOnce();
  if (reportTimer) clearInterval(reportTimer);
  reportTimer = setInterval(reportOnce, REPORT_INTERVAL_MS);
}

document.addEventListener('DOMContentLoaded', initDriverPage);
