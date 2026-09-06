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
  en_route: 'في الطريق',
  arrived: 'وصل',
};

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

// ===== TEMP DIAG: log helper, masks the token to length-only. Delete
// this whole function when removing the diagnostic. =====
function diagMaskLen(t) {
  return t ? `(len=${t.length})` : '(none)';
}

// ===== TEMP DIAG UI START — on-screen diagnostic box for iPhone/no-DevTools
// debugging of the "رابط غير صالح" issue. Purely additive: only READS
// state that the existing code already computes and only WRITES to its
// own #tempDiagBox element. Does not change resolveDriverToken(),
// lookupDriverByToken(), initDriverPage()'s branching, or any Supabase/
// RPC call. Never shows the full token, only its length. Delete this
// whole block (state object + render function) plus every
// `updateDiag(...)` call site when removing the diagnostic. =====
const diagState = {
  urlHasToken: null,      // true/false — was ?driver_token= present in the URL
  tokenSource: null,      // 'url' | 'localStorage' | 'none'
  tokenLength: 0,         // length only, never the token itself
  rpcCalled: false,       // was get_driver_by_token actually invoked
  rpcResultShape: null,   // 'array(len=N)' | 'object' | 'null' | '(not called)'
  rpcErrorMessage: null,  // full error message/code, or null if no error
  finalBranch: null,      // 'NO TOKEN' | 'RPC ERROR' | 'NO DRIVER' | 'SUCCESS'
};

function updateDiag(patch) {
  Object.assign(diagState, patch);
  renderDiagBox();
}

function renderDiagBox() {
  let box = document.getElementById('tempDiagBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'tempDiagBox';
    box.setAttribute('dir', 'ltr');
    box.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:999999',
      'background:#111', 'color:#0f0', 'font-family:monospace',
      'font-size:11px', 'line-height:1.5', 'padding:8px 10px',
      'white-space:pre-wrap', 'word-break:break-word',
      'max-height:45vh', 'overflow:auto', 'direction:ltr', 'text-align:left',
      'border-bottom:2px solid #0f0',
    ].join(';');
    // document.body always exists by the time this is called (only
    // triggered from code that runs after/at DOMContentLoaded).
    document.body.appendChild(box);
  }
  const s = diagState;
  box.textContent =
    'TEMP DIAG (remove after debugging)\n' +
    '1) URL has driver_token? ' + (s.urlHasToken === null ? '(not checked yet)' : s.urlHasToken) + '\n' +
    '2) Token source: ' + (s.tokenSource || '(none yet)') + ' | length: ' + s.tokenLength + '\n' +
    '3) get_driver_by_token called? ' + s.rpcCalled + '\n' +
    '4) RPC result shape: ' + (s.rpcResultShape || '(not called)') + '\n' +
    '5) RPC error: ' + (s.rpcErrorMessage || '(none)') + '\n' +
    '6) FINAL BRANCH: ' + (s.finalBranch || '(pending)');
}
// ===== TEMP DIAG UI END (state object + render function) =====

function getTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const t = params.get('driver_token');
  const result = t && t.trim() ? t.trim() : null;
  console.log('[DIAG] getTokenFromUrl() ->', diagMaskLen(result)); // TEMP DIAG
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
  updateDiag({ urlHasToken: !!fromUrl }); // TEMP DIAG UI
  if (fromUrl) {
    try { localStorage.setItem(TOKEN_STORAGE_KEY, fromUrl); } catch (_) {}
    console.log('[DIAG] resolveDriverToken() using URL token ->', diagMaskLen(fromUrl)); // TEMP DIAG
    updateDiag({ tokenSource: 'url', tokenLength: fromUrl.length }); // TEMP DIAG UI
    return fromUrl;
  }
  let stored = null;
  try { stored = localStorage.getItem(TOKEN_STORAGE_KEY); } catch (_) { stored = null; }
  console.log('[DIAG] resolveDriverToken() no URL token, using localStorage ->', diagMaskLen(stored)); // TEMP DIAG
  updateDiag({ tokenSource: stored ? 'localStorage' : 'none', tokenLength: stored ? stored.length : 0 }); // TEMP DIAG UI
  return stored;
}

function setStatus(dotClass, text) {
  const dot = document.getElementById('driverStatusDot');
  const txt = document.getElementById('driverStatusText');
  if (dot) dot.className = 'driver-status-dot' + (dotClass ? ' ' + dotClass : '');
  if (txt) txt.textContent = text;
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
        setStatus('error', 'تم رفض إذن الموقع — فعّله من إعدادات المتصفح لمتابعة العمل');
        stopReporting();
      } else {
        setStatus('warn', 'تعذّر تحديد موقعك حاليًا — سيُعاد المحاولة');
      }
    },
    { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 5000 }
  );
}

function startReporting() {
  paused = false;
  const btn = document.getElementById('driverToggleBtn');
  if (btn) { btn.textContent = 'إيقاف مؤقت'; btn.classList.remove('paused'); }
  reportOnce();
  if (reportTimer) clearInterval(reportTimer);
  reportTimer = setInterval(reportOnce, REPORT_INTERVAL_MS);
}

function stopReporting() {
  paused = true;
  if (reportTimer) clearInterval(reportTimer);
  reportTimer = null;
  const btn = document.getElementById('driverToggleBtn');
  if (btn) { btn.textContent = 'استئناف الإرسال'; btn.classList.add('paused'); }
  setStatus(null, 'متوقف مؤقتًا — لن يظهر موقعك للزبائن');
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
    return;
  }

  emptyEl.hidden = true;
  detailsEl.hidden = false;

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
  console.log('[DIAG] lookupDriverByToken() called, token length =', token ? token.length : 0); // TEMP DIAG
  updateDiag({ rpcCalled: true }); // TEMP DIAG UI
  try {
    const { data, error } = await supabaseClient.rpc('get_driver_by_token', {
      p_driver_token: token,
    });

    // TEMP DIAG — safe inspection of the raw RPC result, no full token,
    // no logic change below this block.
    console.log('[DIAG] get_driver_by_token raw error ->', error ? JSON.stringify({
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    }) : 'null');
    console.log('[DIAG] get_driver_by_token raw data is Array? ->', Array.isArray(data));
    console.log('[DIAG] get_driver_by_token raw data length ->', Array.isArray(data) ? data.length : '(not an array)');
    if (Array.isArray(data) && data.length > 0) {
      console.log('[DIAG] first row ->', JSON.stringify({ id: data[0].id, name: data[0].name }));
    } else if (data && !Array.isArray(data)) {
      console.log('[DIAG] non-array data ->', JSON.stringify({ id: data.id, name: data.name }));
    }
    // ===== END TEMP DIAG block for this section =====

    // TEMP DIAG UI — record result shape + error message for the on-page box
    updateDiag({
      rpcResultShape: Array.isArray(data) ? `array(len=${data.length})` : (data ? 'object' : 'null'),
      rpcErrorMessage: error ? (error.message || error.code || String(error)) : null,
    });

    if (error) throw error;
    const driver = Array.isArray(data) ? (data[0] || null) : (data || null);
    return { driver, error: null };
  } catch (err) {
    console.error('get_driver_by_token failed', err);
    updateDiag({ rpcErrorMessage: err ? (err.message || err.code || String(err)) : '(unknown error)' }); // TEMP DIAG UI
    return { driver: null, error: err };
  }
}

async function initDriverPage() {
  driverToken = resolveDriverToken();
  const invalidScreen = document.getElementById('driverInvalidScreen');
  const mainScreen = document.getElementById('driverMainScreen');

  console.log('[DIAG] initDriverPage() driverToken exists? ->', !!driverToken); // TEMP DIAG

  if (!driverToken) {
    console.log('[DIAG] initDriverPage() branch entered -> NO TOKEN'); // TEMP DIAG
    updateDiag({ finalBranch: 'NO TOKEN' }); // TEMP DIAG UI
    setInvalidDetail(null);
    invalidScreen.hidden = false;
    mainScreen.hidden = true;
    return;
  }

  const { driver, error } = await lookupDriverByToken(driverToken);

  console.log('[DIAG] initDriverPage() after lookup -> driver exists?', !!driver, '| error exists?', !!error); // TEMP DIAG

  if (error) {
    console.log('[DIAG] initDriverPage() branch entered -> RPC ERROR'); // TEMP DIAG
    // The RPC call itself failed — token may well be correct, this is
    // a real infrastructure problem (network/permissions/schema). Show
    // it instead of silently reusing the generic "invalid link" copy,
    // and do NOT clear the saved token: it hasn't been proven invalid.
    invalidScreen.hidden = false;
    mainScreen.hidden = true;
    setInvalidDetail('خطأ تقني: ' + (error.message || error.code || String(error)));
    updateDiag({ finalBranch: 'RPC ERROR' }); // TEMP DIAG UI
    return;
  }

  if (!driver) {
    console.log('[DIAG] initDriverPage() branch entered -> NO DRIVER (empty result)'); // TEMP DIAG
    // RPC succeeded and cleanly returned no row — token is genuinely
    // wrong, revoked, or belongs to an inactive driver. Same "invalid
    // link" screen as before, and drop it from localStorage so a stale
    // token doesn't keep silently failing on future visits.
    setInvalidDetail(null);
    invalidScreen.hidden = false;
    mainScreen.hidden = true;
    updateDiag({ finalBranch: 'NO DRIVER' }); // TEMP DIAG UI
    try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch (_) {}
    return;
  }

  console.log('[DIAG] initDriverPage() branch entered -> SUCCESS, showing main screen'); // TEMP DIAG
  updateDiag({ finalBranch: 'SUCCESS' }); // TEMP DIAG UI

  mainScreen.hidden = false;
  invalidScreen.hidden = true;

  const toggleBtn = document.getElementById('driverToggleBtn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      if (paused) startReporting();
      else stopReporting();
    });
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

document.addEventListener('DOMContentLoaded', initDriverPage);
