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

function getTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const t = params.get('driver_token');
  return t && t.trim() ? t.trim() : null;
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
  try { return localStorage.getItem(TOKEN_STORAGE_KEY); } catch (_) { return null; }
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
    invalidScreen.hidden = false;
    mainScreen.hidden = true;
    return;
  }

  const { driver, error } = await lookupDriverByToken(driverToken);

  if (error) {
    // The RPC call itself failed — token may well be correct, this is
    // a real infrastructure problem (network/permissions/schema). Show
    // it instead of silently reusing the generic "invalid link" copy,
    // and do NOT clear the saved token: it hasn't been proven invalid.
    invalidScreen.hidden = false;
    mainScreen.hidden = true;
    setInvalidDetail('خطأ تقني: ' + (error.message || error.code || String(error)));
    return;
  }

  if (!driver) {
    // RPC succeeded and cleanly returned no row — token is genuinely
    // wrong, revoked, or belongs to an inactive driver. Same "invalid
    // link" screen as before, and drop it from localStorage so a stale
    // token doesn't keep silently failing on future visits.
    setInvalidDetail(null);
    invalidScreen.hidden = false;
    mainScreen.hidden = true;
    try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch (_) {}
    return;
  }

  mainScreen.hidden = false;
  invalidScreen.hidden = true;

  const toggleBtn = document.getElementById('driverToggleBtn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      if (paused) startReporting();
      else stopReporting();
    });
  }

  // Re-send promptly when the tab regains focus/visibility — mobile
  // browsers throttle background timers, so this recovers quickly
  // instead of waiting up to REPORT_INTERVAL_MS after switching back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !paused) reportOnce();
  });

  startReporting();
  setupPushNotifications();
}

document.addEventListener('DOMContentLoaded', initDriverPage);
