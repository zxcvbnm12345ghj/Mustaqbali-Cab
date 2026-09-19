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

// New-trip in-app alert (sound/vibration/toast) — mirrors admin.js's
// own new-request sound alert (playAlertSound() + the seenRequestIds
// "seed, then only alert on genuinely new ones" pattern), adapted for
// the driver's single current-trip view. This is a SEPARATE channel
// from the existing Web Push setup below: push covers background/
// closed-app delivery via driver-sw.js + the server-side queue; this
// covers the tab being open (foreground or backgrounded-but-open),
// where a push notification may be suppressed by the browser anyway.
const NEW_TRIP_TOAST_MS = 7000;

// Public VAPID key — safe to embed client-side by design (it's how the
// browser verifies push messages came from OUR server, not a secret).
// The matching PRIVATE key lives only in the push-sending Edge Function
// (deployed under the slug "super-worker" — see that function's own
// header comment for why), never in this file.
const VAPID_PUBLIC_KEY = 'BA_mwRbHk_BXqtt8PKCma9oaAbuQVAoYNvNvtTmq2L8bcWTPakSgiU4AuDZKpo6NCpKCRzXM2gFaZ5QIA6s5_ww'; // matches admin.js's VAPID_PUBLIC_KEY exactly (fixed — was a stale placeholder)

let driverToken = null;

// Real login (Supabase Auth) — additive, parallel identity path. See
// chat decision: added alongside driver_token, never replacing it.
// When true, every RPC call below uses the *_auth counterpart
// (get_driver_current_trip_auth, etc.) instead of the original
// p_token-based function; the originals are untouched and still used
// whenever authMode is false (any driver not yet migrated to a real
// account keeps working exactly as before, off their token link).
let authMode = false;
let driverProfile = null; // { id, name } from get_driver_profile_auth()

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

// New-trip alert state. tripAlertSeeded starts false so the very
// first fetchCurrentTrip() after page load only *records* whatever
// trip is already showing (if any) without alerting — exactly like
// admin.js seeding seenRequestIds from the initial loadRequests()
// before polling starts, so a pre-existing assignment never fires a
// false "new trip" alert on open.
let lastSeenTripId = null;
let tripAlertSeeded = false;
let newTripToastTimer = null;

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

// ---- Real login (Supabase Auth) ----
// Checks for an existing session and resolves it to an active driver
// via the new get_driver_profile_auth() RPC (SECURITY DEFINER, reads
// auth.uid() server-side — no id is ever passed from the client).
// Returns true/sets authMode+driverProfile only when the session
// belongs to a currently-active driver; otherwise signs out (a stray
// session with nothing valid to do here) and returns false so the
// caller falls back to the token flow / shows the login screen.
async function tryResolveAuthSession() {
  try {
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const session = sessionData?.session;
    if (!session) return false;

    const { data, error } = await supabaseClient.rpc('get_driver_profile_auth');
    if (error) throw error;
    const profile = Array.isArray(data) ? (data[0] || null) : (data || null);

    if (!profile) {
      // Real account, but not linked to any active driver row (e.g. an
      // admin account signed in here by mistake, or a driver disabled
      // via drivers.active = false). Not this app's audience.
      await supabaseClient.auth.signOut();
      authMode = false;
      driverProfile = null;
      return false;
    }

    authMode = true;
    driverProfile = profile;
    return true;
  } catch (err) {
    console.error('tryResolveAuthSession failed', err);
    authMode = false;
    driverProfile = null;
    return false;
  }
}

// Normalizes an Iraqi mobile number the driver types into E.164
// (+964XXXXXXXXXX) — the format Supabase Auth's phone field expects,
// and the format the driver's account must be created with (see the
// onboarding note near the bottom of this file / the migration).
// Accepts the variations a driver is likely to type:
//   07701234567    -> +9647701234567   (local, leading 0)
//   7701234567     -> +9647701234567   (local, no leading 0)
//   00964770...    -> +964770...       (international dialing prefix)
//   +9647701234567 -> +9647701234567   (already correct)
// Strips spaces/dashes/parentheses first. Returns null (instead of a
// guess) when the result isn't a plausible Iraqi mobile number, so the
// caller can show a clear error instead of sending garbage to Supabase.
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
  // What remains should be the 10-digit local subscriber number
  // (Iraqi mobiles start with 7), with no country code / leading zero.
  if (!/^7\d{9}$/.test(digits)) return null;
  return '+964' + digits;
}

async function handleDriverLogin(e) {
  e.preventDefault();
  // id kept as driverLoginEmail (legacy name, see driver.html) — the
  // field now holds the driver's phone number, not an email.
  const phoneEl = document.getElementById('driverLoginEmail');
  const passEl = document.getElementById('driverLoginPassword');
  const btn = document.getElementById('driverLoginBtn');
  const errEl = document.getElementById('driverLoginError');
  const rawPhone = phoneEl ? phoneEl.value.trim() : '';
  const password = passEl ? passEl.value : '';

  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  const phone = normalizeIraqiPhone(rawPhone);
  if (!phone) {
    if (errEl) {
      errEl.textContent = 'رقم الهاتف غير صحيح. أدخله بصيغة 07XXXXXXXXX.';
      errEl.hidden = false;
    }
    return;
  }

  if (btn) btn.disabled = true;

  try {
    // No email anywhere in this flow — signInWithPassword() accepts
    // { phone, password } natively (Supabase Auth password-based auth
    // supports phone identities, not just email).
    const { error: signInError } = await supabaseClient.auth.signInWithPassword({ phone, password });
    if (signInError) throw signInError;

    const ok = await tryResolveAuthSession();
    if (!ok) {
      if (errEl) {
        errEl.textContent = 'هذا الحساب غير مرتبط بسائق نشط. تواصل مع الإدارة.';
        errEl.hidden = false;
      }
      return;
    }

    setScreenVisible(document.getElementById('driverMainScreen'), true);
    setScreenVisible(document.getElementById('driverLoginScreen'), false);
    setScreenVisible(document.getElementById('driverInvalidScreen'), false);
    startDriverApp();
  } catch (err) {
    console.error('driver login failed', err);
    if (errEl) {
      errEl.textContent = 'تعذّر تسجيل الدخول. تحقق من رقم الهاتف وكلمة المرور.';
      errEl.hidden = false;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleDriverLogout() {
  stopReporting();
  if (tripTimer) { clearInterval(tripTimer); tripTimer = null; }
  try { await supabaseClient.auth.signOut(); } catch (err) { console.error('signOut failed', err); }
  authMode = false;
  driverProfile = null;
  currentTrip = null;
  tripAlertSeeded = false;
  lastSeenTripId = null;
  setScreenVisible(document.getElementById('driverMainScreen'), false);
  setScreenVisible(document.getElementById('driverLoginScreen'), true);
  setScreenVisible(document.getElementById('driverInvalidScreen'), false);
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
    const { error } = authMode
      ? await supabaseClient.rpc('update_driver_location_auth', {
          p_lat: lat,
          p_lng: lng,
        })
      : await supabaseClient.rpc('update_driver_location', {
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

function setMsgFor(elId, text, isError) {
  const el = document.getElementById(elId);
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
function setRespondMsg(text, isError) { setMsgFor('driverRespondMsg', text, isError); }
// Same shape as setRespondMsg, for the separate trip-status-progress
// card (driverTripProgress) so its message doesn't fight with the
// accept/reject card's message over the same element.
function setProgressMsg(text, isError) { setMsgFor('driverProgressMsg', text, isError); }

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

// Sequential trip-status progression after acceptance. Only these three
// transitions are ever offered client-side; driver_update_trip_status
// (Supabase RPC) enforces the same set server-side, so this map is a UX
// convenience, not the actual authorization boundary.
const TRIP_NEXT_STATUS = {
  accepted: 'en_route',
  en_route: 'arrived',
  arrived: 'completed',
};
const TRIP_PROGRESS_BTN_LABELS = {
  accepted: 'بدء الرحلة',
  en_route: 'وصلت',
  arrived: 'إنهاء الرحلة',
};

function renderTripActions(trip) {
  const box = document.getElementById('driverTripActions');
  const acceptBtn = document.getElementById('driverAcceptBtn');
  const rejectBtn = document.getElementById('driverRejectBtn');
  const progressBox = document.getElementById('driverTripProgress');
  const progressBtn = document.getElementById('driverProgressBtn');
  if (!box || !acceptBtn || !rejectBtn) return;

  if (!trip) {
    box.hidden = true;
    if (progressBox) progressBox.hidden = true;
    return;
  }

  if (trip.status === 'assigned') {
    // Only actionable step at this stage: accept or reject.
    box.hidden = false;
    if (progressBox) progressBox.hidden = true;
    acceptBtn.disabled = isResponding;
    rejectBtn.disabled = isResponding;
    if (!isResponding) setRespondMsg(null);
    return;
  }

  // Past 'assigned' — accept/reject no longer applies. Show at most the
  // single next valid step (accepted/en_route/arrived); nothing shows
  // for any other status (e.g. after completed, currentTrip is cleared
  // client-side so we never get here with trip.status === 'completed').
  box.hidden = true;
  const nextStatus = TRIP_NEXT_STATUS[trip.status];
  if (nextStatus && progressBox && progressBtn) {
    progressBox.hidden = false;
    progressBtn.textContent = TRIP_PROGRESS_BTN_LABELS[trip.status];
    progressBtn.disabled = isResponding;
    if (!isResponding) setProgressMsg(null);
  } else if (progressBox) {
    progressBox.hidden = true;
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
    const { data, error } = authMode
      ? await supabaseClient.rpc('driver_respond_to_trip_auth', {
          p_request_id: requestId,
          p_action: action,
        })
      : await supabaseClient.rpc('driver_respond_to_trip', {
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

// ---- Trip status progression (driver_update_trip_status RPC) ----
// Advances an already-accepted trip through accepted -> en_route ->
// arrived -> completed, one step per call. Separate from
// respondToTrip()/driver_respond_to_trip above, which only ever
// resolves the initial assigned -> accepted|new decision. Reuses
// isResponding as the same in-flight guard (accept/reject and
// progression never show at the same time — see renderTripActions —
// so a single flag is enough and keeps this change minimal).
async function updateTripStatus(targetStatus) {
  if (isResponding) return;
  if (!currentTrip) return;
  // Guard against a stale/duplicate click sending a transition that no
  // longer matches the trip's current status (e.g. two taps before the
  // UI re-renders). The RPC re-checks this server-side regardless.
  if (TRIP_NEXT_STATUS[currentTrip.status] !== targetStatus) return;

  const requestId = getTripRequestId(currentTrip);
  if (!requestId) {
    console.error('driver_update_trip_status: no id-like field found on currentTrip', currentTrip);
    setProgressMsg('تعذّر تحديد رقم الطلب — أعد تحميل الصفحة وحاول مجدداً', true);
    return;
  }

  isResponding = true;
  const progressBtn = document.getElementById('driverProgressBtn');
  if (progressBtn) progressBtn.disabled = true;
  setProgressMsg('جارٍ التحديث…', false);

  try {
    const { data, error } = authMode
      ? await supabaseClient.rpc('driver_update_trip_status_auth', {
          p_request_id: requestId,
          p_new_status: targetStatus,
        })
      : await supabaseClient.rpc('driver_update_trip_status', {
          p_token: driverToken,
          p_request_id: requestId,
          p_new_status: targetStatus,
        });
    if (error) throw error;

    const result = Array.isArray(data) ? (data[0] || null) : (data || null);
    const newStatus = result?.new_status || targetStatus;

    if (newStatus === 'completed') {
      // Trip is done — same "clear + return to waiting" behavior as a
      // rejected trip disappearing, just without the "gone" banner.
      currentTrip = null;
      renderTrip(null);
      setProgressMsg(null);
    } else {
      currentTrip = { ...currentTrip, status: newStatus };
      renderTrip(currentTrip);
    }
  } catch (err) {
    console.error('driver_update_trip_status failed', err);
    setProgressMsg('تعذّر تنفيذ العملية — تحقق من الاتصال وحاول مجدداً', true);
    if (progressBtn) progressBtn.disabled = false;
  } finally {
    isResponding = false;
  }
}

// ---- New-trip in-app alert ----
// Same WebAudio beep approach as admin.js's playAlertSound() (a short
// oscillator tone) — kept as an independent copy here rather than a
// shared import, since driver.html and admin.html load separate JS
// bundles. A second, higher chime is layered on top of the single
// admin beep because a driver's phone is more likely to be in a
// pocket/mount than a desk, and two short tones read as "alert" more
// reliably than one on a small speaker.
function playNewTripAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const chime = (freq, delayMs) => {
      setTimeout(() => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);
        osc.start();
        osc.stop(ctx.currentTime + 0.55);
      }, delayMs);
    };
    chime(880, 0);
    chime(1175, 250);
  } catch (err) {
    console.error('playNewTripAlertSound failed (non-fatal)', err);
  }
}

// Best-effort — most desktop browsers simply have no navigator.vibrate,
// which is why this is guarded and never throws upward.
function vibrateNewTrip() {
  try {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
  } catch (_) {}
}

// Built with createElement + inline styles instead of new markup in
// driver.html/driver.css, so this feature touches driver.js only.
// Colors/fonts still come from driver.css's existing .driver-body
// custom properties (var(--brand-grad) etc.) since this button is
// appended to <body>, which already carries that class — same look
// as the rest of the page with zero new stylesheet rules.
function getOrCreateNewTripToast() {
  let el = document.getElementById('driverNewTripToast');
  if (el) return el;
  el = document.createElement('button');
  el.id = 'driverNewTripToast';
  el.type = 'button';
  el.setAttribute('aria-live', 'assertive');
  Object.assign(el.style, {
    position: 'fixed',
    top: '14px',
    insetInlineStart: '50%',
    transform: 'translateX(-50%)',
    zIndex: '9999',
    display: 'none',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 20px',
    borderRadius: 'var(--app-r-pill, 100px)',
    border: 'none',
    background: 'var(--brand-grad, linear-gradient(135deg,#7C3AED,#4F46E5))',
    color: '#fff',
    fontFamily: 'var(--f-body, sans-serif)',
    fontWeight: '700',
    fontSize: '14px',
    boxShadow: 'var(--elev-2, 0 12px 24px rgba(76,29,149,0.3))',
    cursor: 'pointer',
  });
  el.textContent = '🔔 طلب جديد — اضغط للفتح';
  // "Opens the request directly": the driver app has no separate
  // notification list to navigate into — the assigned trip is always
  // already rendered inline in #driverTripBox by renderTrip() above,
  // so clicking here just scrolls/focuses that section instead of
  // routing anywhere.
  el.addEventListener('click', () => {
    hideNewTripToast();
    const box = document.getElementById('driverTripBox');
    if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.body.appendChild(el);
  return el;
}

function hideNewTripToast() {
  const el = document.getElementById('driverNewTripToast');
  if (el) el.style.display = 'none';
  if (newTripToastTimer) { clearTimeout(newTripToastTimer); newTripToastTimer = null; }
}

function showNewTripToast() {
  const el = getOrCreateNewTripToast();
  el.style.display = 'flex';
  if (newTripToastTimer) clearTimeout(newTripToastTimer);
  newTripToastTimer = setTimeout(hideNewTripToast, NEW_TRIP_TOAST_MS);
}

function alertNewTrip(trip) {
  playNewTripAlertSound();
  vibrateNewTrip();
  showNewTripToast(trip);
}

async function fetchCurrentTrip() {
  if (!authMode && !driverToken) return;
  try {
    const { data, error } = authMode
      ? await supabaseClient.rpc('get_driver_current_trip_auth')
      : await supabaseClient.rpc('get_driver_current_trip', {
          p_token: driverToken,
        });
    if (error) throw error;
    const trip = Array.isArray(data) ? (data[0] || null) : (data || null);
    const tripId = getTripRequestId(trip);

    // Fire the in-app alert only for a trip id that wasn't showing a
    // moment ago — never on the first poll after page load (that call
    // only seeds lastSeenTripId) and never when respondToTrip() above
    // updates currentTrip/calls renderTrip() locally, since that path
    // never goes through fetchCurrentTrip() at all.
    if (!tripAlertSeeded) {
      tripAlertSeeded = true;
    } else if (tripId && tripId !== lastSeenTripId) {
      alertNewTrip(trip);
    }
    lastSeenTripId = tripId;

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
  if (!authMode && !driverToken) return;

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

    if (authMode) {
      await supabaseClient.rpc('save_driver_push_subscription_auth', {
        p_subscription: subscription.toJSON(),
      });
    } else {
      await supabaseClient.rpc('save_driver_push_subscription', {
        p_token: driverToken,
        p_subscription: subscription.toJSON(),
      });
    }
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

// Everything that used to run at the tail of initDriverPage() once a
// driver identity was confirmed — pulled out unchanged into its own
// function so BOTH identity paths (real login below, and the existing
// token flow further down) share the exact same setup instead of two
// copies of it. Nothing in this function's body was altered.
function startDriverApp() {
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

  const progressBtn = document.getElementById('driverProgressBtn');
  if (progressBtn) {
    progressBtn.addEventListener('click', () => {
      const next = currentTrip ? TRIP_NEXT_STATUS[currentTrip.status] : null;
      if (next) updateTripStatus(next);
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

  // Logout control + driver name only make sense in authMode — a
  // token-based driver has no session to log out of, so the button
  // stays hidden for that path (driver-sw.js/driver.html markup keeps
  // it [hidden] by default already; this just leaves it that way).
  const logoutBtn = document.getElementById('driverLogoutBtn');
  if (logoutBtn) {
    logoutBtn.hidden = !authMode;
    logoutBtn.addEventListener('click', handleDriverLogout);
  }
  const nameEl = document.getElementById('driverHeaderName');
  if (nameEl) nameEl.textContent = authMode && driverProfile?.name ? ` — ${driverProfile.name}` : '';

  startReporting();
  startTripPolling();
  setupPushNotifications();
}

async function initDriverPage() {
  const invalidScreen = document.getElementById('driverInvalidScreen');
  const mainScreen = document.getElementById('driverMainScreen');
  const loginScreen = document.getElementById('driverLoginScreen');

  const loginForm = document.getElementById('driverLoginForm');
  if (loginForm) loginForm.addEventListener('submit', handleDriverLogin);

  // 1) Real login (Supabase Auth) — tried first, purely additive. If no
  //    session exists this resolves to false immediately and falls
  //    through to the untouched token flow below, exactly as before.
  const hasAuthSession = await tryResolveAuthSession();
  if (hasAuthSession) {
    setScreenVisible(mainScreen, true);
    setScreenVisible(invalidScreen, false);
    setScreenVisible(loginScreen, false);
    startDriverApp();
    return;
  }

  // 2) Existing token system — same logic as before, unchanged.
  driverToken = resolveDriverToken();

  if (!driverToken) {
    // No session AND no token: this is the new default entry point.
    // Previously this always meant "invalid link"; now a bare visit to
    // driver.html is a legitimate way in via the login screen. A token
    // link that turns out to be wrong still goes to the "invalid link"
    // screen below, unchanged — only the *no token at all* case changes.
    setScreenVisible(loginScreen, true);
    setScreenVisible(invalidScreen, false);
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
    setScreenVisible(loginScreen, false);
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
    setScreenVisible(loginScreen, false);
    try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch (_) {}
    return;
  }

  setScreenVisible(mainScreen, true);
  setScreenVisible(invalidScreen, false);
  setScreenVisible(loginScreen, false);
  startDriverApp();
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
