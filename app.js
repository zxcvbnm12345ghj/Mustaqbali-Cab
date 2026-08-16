// Mustaqbali Cab — Customer App Shell (PWA) — v2 (Careem/Uber-grade)
// Same backend contract: submit_trip_request RPC + the new
// get_trip_request_status RPC for live status polling (see schema.sql v1.1).

const SERVICES = {
  taxi:      { label: 'تاكسي',            base: 3000,  icon: 'taxi' },
  private:   { label: 'سيارة خاصة',        base: 8000,  icon: 'private' },
  courier:   { label: 'توصيل طرود',        base: 2000,  icon: 'courier' },
  intercity: { label: 'رحلات بين المدن',   base: 20000, icon: 'intercity' },
};

const ICONS = {
  taxi: '<path d="M5 17H3v-4l2-5h11l3 4v5h-2M9 17h6M7 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  private: '<path d="M4 17h1a2 2 0 0 0 4 0h6a2 2 0 0 0 4 0h1v-5l-2.5-5.5A2 2 0 0 0 15.7 5H8.3a2 2 0 0 0-1.8 1.5L4 12v5Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  courier: '<path d="M3 8l3-4h12l3 4M3 8h18M3 8v9a1 1 0 0 0 1 1h1a2 2 0 0 0 2-2v0h10v0a2 2 0 0 0 2 2h1a1 1 0 0 0 1-1V8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  intercity: '<path d="M9 20l-5-2V4l5 2m0 14l6-2m-6 2V6m6 12l5 2V6l-5-2m0 14V4m0 2L9 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
};

const BUSINESS_WHATSAPP_NUMBER = '9647700000000'; // TODO: replace with the real company WhatsApp number
const BAGHDAD = { lat: 33.3152, lng: 44.3661 };
const TIMELINE_STEPS = ['new', 'assigned', 'en_route', 'arrived', 'completed'];
const TIMELINE_LABELS = { new: 'جديد', assigned: 'تم التعيين', en_route: 'السائق بالطريق', arrived: 'تم الوصول', completed: 'مكتملة' };
const STATUS_POLL_MS = 6000;
const RECENT_KEY = 'mustaqbali_recent_locations';

const state = {
  currentService: null,
  pickupLatLng: null,
  map: null,
  pickupMarker: null,
  decorLine: null,
  lastSubmission: null, // { id, request_number, phone, service_type, pickup, dropoff, created_at }
  statusPollTimer: null,
  lastKnownStatus: null,
};

/* ============================================================
   Haptic-like feedback (real device vibration where supported;
   silently does nothing on iOS Safari, which has no vibrate API —
   the visual press animations in CSS carry the feedback there).
   ============================================================ */
function haptic(strength = 8) {
  if (navigator.vibrate) navigator.vibrate(strength);
}

/* ============================================================
   Bottom Sheet — drag engine
   Snap points: peek 25vh, half 50vh, full 85vh.
   - Dragging from the handle always works, any direction.
   - Dragging from the content only converts to a sheet-drag when the
     content is already scrolled to its top AND the finger moves down;
     otherwise the content scrolls natively with zero interference.
   - Velocity is tracked so a fast flick snaps in the flick direction
     even if released before crossing the midpoint (fling gesture).
   - Every view (home/booking/submitting/status) shares the same single
     #sheet element, so switching views can never "lose" the drag
     handlers — this is what fixes the freeze after submitting.
   ============================================================ */
class BottomSheet {
  constructor(el, handleEl, scrollEl) {
    this.el = el;
    this.handle = handleEl;
    this.scrollEl = scrollEl;
    this.snapFractions = { peek: 0.25, half: 0.50, full: 0.85 };
    this.current = 'half';
    this.dragging = false;
    this.startY = 0;
    this.startHeightPx = 0;
    this.samples = []; // {y, t} for velocity calc
    this.contentDragDecided = null; // null | 'sheet' | 'scroll'
    this.contentStartScrollTop = 0;
    this.onSnapChange = null;

    this._onHandleDown = this._onHandleDown.bind(this);
    this._onContentDown = this._onContentDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);

    this.handle.addEventListener('pointerdown', this._onHandleDown);
    this.scrollEl.addEventListener('pointerdown', this._onContentDown);
    window.addEventListener('resize', () => this.setSnap(this.current, false));
  }

  vhPx(fraction) {
    return Math.round(window.innerHeight * fraction);
  }

  heightPxFor(name) {
    return this.vhPx(this.snapFractions[name]);
  }

  currentHeightPx() {
    return this.el.getBoundingClientRect().height;
  }

  setSnap(name, animate = true) {
    this.current = name;
    this.el.style.transition = animate ? '' : 'none';
    this.el.dataset.height = name;
    this.el.style.setProperty('--sheet-h', this.heightPxFor(name) + 'px');
    if (!animate) {
      // Force reflow so the next state change re-enables the transition.
      void this.el.offsetHeight;
      this.el.style.transition = '';
    }
    if (this.onSnapChange) this.onSnapChange(name);
  }

  _beginDrag(clientY) {
    this.dragging = true;
    this.startY = clientY;
    this.startHeightPx = this.currentHeightPx();
    this.samples = [{ y: clientY, t: performance.now() }];
    this.el.classList.add('dragging');
    haptic(6);
  }

  _onHandleDown(e) {
    this.handle.setPointerCapture(e.pointerId);
    this._beginDrag(e.clientY);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
  }

  _onContentDown(e) {
    this.contentDragDecided = null;
    this.contentStartScrollTop = this.scrollEl.scrollTop;
    this._contentStartY = e.clientY;
    this._contentPointerId = e.pointerId;
    window.addEventListener('pointermove', this._onContentMoveDecide);
    window.addEventListener('pointerup', this._onContentUpCancel);
    window.addEventListener('pointercancel', this._onContentUpCancel);
  }

  // Bound once, reused — decides whether a content-area drag becomes a
  // sheet-drag (only when already at scrollTop 0 and moving downward).
  _onContentMoveDecide = (e) => {
    if (this.contentDragDecided) return;
    const deltaY = e.clientY - this._contentStartY;
    if (this.contentStartScrollTop <= 0 && deltaY > 8) {
      this.contentDragDecided = 'sheet';
      // Lock native scrolling for the duration of this gesture so the
      // browser can't fight our transform-driven drag.
      this.scrollEl.style.overflowY = 'hidden';
      this.scrollEl.setPointerCapture(this._contentPointerId);
      this._beginDrag(this._contentStartY);
      window.addEventListener('pointermove', this._onMove);
      window.addEventListener('pointerup', this._onUp);
      window.addEventListener('pointercancel', this._onUp);
    } else if (Math.abs(deltaY) > 8) {
      this.contentDragDecided = 'scroll'; // let native scrolling proceed untouched
    }
  };

  _onContentUpCancel = () => {
    window.removeEventListener('pointermove', this._onContentMoveDecide);
    window.removeEventListener('pointerup', this._onContentUpCancel);
    window.removeEventListener('pointercancel', this._onContentUpCancel);
    if (this.contentDragDecided !== 'sheet') {
      this.scrollEl.style.overflowY = '';
    }
  };

  _onMove(e) {
    if (!this.dragging) return;
    e.preventDefault();
    const delta = this.startY - e.clientY; // positive = dragging up (growing)
    const newHeight = Math.min(this.vhPx(0.94), Math.max(this.vhPx(0.10), this.startHeightPx + delta));
    this.el.style.setProperty('--sheet-h', newHeight + 'px');
    this.samples.push({ y: e.clientY, t: performance.now() });
    if (this.samples.length > 6) this.samples.shift();
  }

  _velocity() {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return 0;
    return (first.y - last.y) / dt; // px/ms, positive = moving up
  }

  _onUp() {
    if (!this.dragging) return;
    this.dragging = false;
    this.el.classList.remove('dragging');
    this.scrollEl.style.overflowY = '';
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);

    const h = this.currentHeightPx();
    const vh = window.innerHeight;
    const ratio = h / vh;
    const velocity = this._velocity();

    let target;
    // Fast flick overrides plain position — a decisive swipe snaps two
    // steps if needed, matching how Careem/Uber sheets feel.
    if (velocity > 0.6) {
      target = ratio > 0.62 ? 'full' : (ratio > 0.30 ? 'full' : 'half');
    } else if (velocity < -0.6) {
      target = ratio < 0.38 ? 'peek' : (ratio < 0.70 ? 'peek' : 'half');
    } else if (ratio < 0.37) {
      target = 'peek';
    } else if (ratio < 0.68) {
      target = 'half';
    } else {
      target = 'full';
    }
    haptic(10);
    this.setSnap(target, true);
  }
}

let sheet;

/* ============================================================
   Map
   ============================================================ */
function initMap() {
  try {
    state.map = L.map('map', {
      zoomControl: false,
      attributionControl: true,
      center: [BAGHDAD.lat, BAGHDAD.lng],
      zoom: 13,
      fadeAnimation: true,
      zoomAnimation: true,
    });

    const tiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(state.map);

    tiles.on('load', () => {
      const skel = document.getElementById('mapSkeleton');
      if (skel) skel.classList.add('hide');
    });

    state.map.on('click', (e) => setPickup(e.latlng.lat, e.latlng.lng, { reverseGeocode: true, fly: false }));

    setTimeout(() => state.map.invalidateSize(), 250);
    window.addEventListener('resize', () => state.map && state.map.invalidateSize());
  } catch (err) {
    console.error('Map failed to load', err);
    document.getElementById('map').style.background =
      'radial-gradient(120% 90% at 15% -10%, #16204A 0%, #0A0E1A 45%)';
    const skel = document.getElementById('mapSkeleton');
    if (skel) skel.classList.add('hide');
  }
}

function pickupDivIcon() {
  return L.divIcon({
    className: 'pickup-pin dropped',
    html: `<svg viewBox="0 0 34 34" fill="none">
      <path d="M17 2c-6.6 0-12 5.3-12 11.8C5 22 17 32 17 32s12-10 12-18.2C29 7.3 23.6 2 17 2Z" fill="#E8A94C" stroke="#0A0E1A" stroke-width="1.4"/>
      <circle cx="17" cy="13.5" r="4.6" fill="#0A0E1A"/>
    </svg>`,
    iconSize: [40, 52],
    iconAnchor: [20, 50],
  });
}

function setPickup(lat, lng, { reverseGeocode = false, fly = true } = {}) {
  state.pickupLatLng = { lat, lng };
  document.getElementById('pickupLat').value = lat;
  document.getElementById('pickupLng').value = lng;

  if (state.map) {
    if (!state.pickupMarker) {
      state.pickupMarker = L.marker([lat, lng], { icon: pickupDivIcon(), draggable: true }).addTo(state.map);
      state.pickupMarker.on('dragend', () => {
        const p = state.pickupMarker.getLatLng();
        setPickup(p.lat, p.lng, { reverseGeocode: true, fly: false });
      });
    } else {
      state.pickupMarker.setLatLng([lat, lng]);
      const el = state.pickupMarker.getElement();
      if (el) {
        el.classList.remove('dropped');
        void el.offsetWidth;
        el.classList.add('dropped');
      }
    }
    drawDecorRoute(lat, lng);
    if (fly) state.map.flyTo([lat, lng], 15, { duration: 1.1 });
  }

  if (reverseGeocode) reverseGeocodePickup(lat, lng);
  updatePriceBar();
  validateField('pickup');
}

function drawDecorRoute(lat, lng) {
  if (!state.map) return;
  const offset = [lat + 0.01, lng + 0.014];
  if (state.decorLine) state.map.removeLayer(state.decorLine);
  state.decorLine = L.polyline([[lat, lng], offset], {
    className: 'decor-route',
    weight: 4,
  }).addTo(state.map);
}

async function reverseGeocodePickup(lat, lng) {
  const input = document.getElementById('pickup');
  const original = input.value;
  input.placeholder = ' ';
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=ar`);
    const data = await res.json();
    input.value = data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  } catch (err) {
    if (!original) input.value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
}

function locateMe(auto = false) {
  const btn = document.getElementById('recenterBtn');
  const locateBtn = document.getElementById('locateBtnApp');
  [btn, locateBtn].forEach(b => b && b.classList.add('locating'));

  if (!navigator.geolocation) {
    [btn, locateBtn].forEach(b => b && b.classList.remove('locating'));
    if (!auto) toast('متصفحك لا يدعم تحديد الموقع الجغرافي');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setPickup(pos.coords.latitude, pos.coords.longitude, { reverseGeocode: true, fly: true });
      [btn, locateBtn].forEach(b => b && b.classList.remove('locating'));
    },
    () => {
      [btn, locateBtn].forEach(b => b && b.classList.remove('locating'));
      if (!auto) toast('تعذّر الوصول لموقعك — تأكد من إذن الموقع');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

/* ============================================================
   View switching
   ============================================================ */
function showView(name) {
  document.querySelectorAll('.sheet-view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
  document.getElementById('sheetScroll').scrollTop = 0;
}

function openBooking(serviceKey) {
  if (serviceKey) selectService(serviceKey);
  else if (!state.currentService) selectService('taxi');
  showView('booking');
  sheet.setSnap('full');
  haptic();
}

function backToHome() {
  stopStatusPolling();
  showView('home');
  sheet.setSnap('half');
  renderRecentLocations();
}

/* ============================================================
   Service selection
   ============================================================ */
function selectService(key) {
  state.currentService = key;
  document.querySelectorAll('.svc-pill').forEach(p => p.classList.toggle('active', p.dataset.service === key));
  const isCourier = key === 'courier';
  document.querySelector('label[for="pickup"]').textContent = isCourier ? 'مكان الاستلام' : 'مكان الانطلاق';
  document.querySelector('label[for="dropoff"]').textContent = isCourier ? 'مكان التسليم' : 'الوجهة';
  updatePriceBar();
  haptic();
}

function updatePriceBar() {
  if (!state.currentService) return;
  const svc = SERVICES[state.currentService];
  const priceEl = document.getElementById('priceEstimate');
  priceEl.style.opacity = '0';
  setTimeout(() => {
    priceEl.textContent = `${svc.base} دينار تقريباً`;
    priceEl.style.opacity = '1';
  }, 100);
  document.getElementById('bookBtnLabel').textContent = `اطلب ${svc.label} الآن`;
}

/* ============================================================
   Live inline validation
   ============================================================ */
const PHONE_RE = /^07\d{9}$/;

// Explicit map from input id -> error <span> id. Deliberately not derived
// by string transformation (e.g. capitalizing "customerName") — that
// approach previously produced "errCustomerName", which doesn't exist in
// the markup (the real span is #errName) and threw on first validation.
const ERROR_EL_ID = { pickup: 'errPickup', customerName: 'errName', phone: 'errPhone' };

function setFieldError(inputId, message) {
  const inputEl = document.getElementById(inputId);
  const wrap = inputEl ? inputEl.closest('.float-field') : null;
  const errEl = document.getElementById(ERROR_EL_ID[inputId]);
  if (!wrap) return;
  if (message) {
    wrap.classList.add('invalid');
    if (errEl) errEl.textContent = message;
  } else {
    wrap.classList.remove('invalid');
    if (errEl) errEl.textContent = '';
  }
}

function validateField(inputId) {
  const val = document.getElementById(inputId).value.trim();

  if (inputId === 'pickup' && !val) {
    setFieldError('pickup', 'مكان الانطلاق مطلوب');
    return false;
  }
  if (inputId === 'customerName') {
    if (!val) { setFieldError('customerName', 'الاسم مطلوب'); return false; }
    if (val.length < 2) { setFieldError('customerName', 'الاسم قصير جداً'); return false; }
  }
  if (inputId === 'phone') {
    if (!val) { setFieldError('phone', 'رقم الجوال مطلوب'); return false; }
    if (!PHONE_RE.test(val)) { setFieldError('phone', 'رقم غير صحيح — مثال: 07xxxxxxxxx'); return false; }
  }
  setFieldError(inputId, null);
  return true;
}

/* ============================================================
   Submit
   ============================================================ */
function showMsg(msg) {
  const el = document.getElementById('appMsg');
  el.textContent = msg;
  el.classList.add('show', 'err');
}
function clearMsg() {
  document.getElementById('appMsg').classList.remove('show');
}

function toast(msg) {
  const t = document.getElementById('appToast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

function saveRecentLocation(pickup, dropoff) {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const entry = { pickup, dropoff, t: Date.now() };
    const filtered = list.filter(x => x.pickup !== pickup);
    filtered.unshift(entry);
    localStorage.setItem(RECENT_KEY, JSON.stringify(filtered.slice(0, 3)));
  } catch { /* localStorage unavailable — silently skip, non-critical */ }
}

function renderRecentLocations() {
  let list = [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    list = raw ? JSON.parse(raw) : [];
  } catch { /* ignore */ }
  const wrap = document.getElementById('recentLocations');
  const listEl = document.getElementById('recentList');
  if (!list.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  listEl.innerHTML = list.map((item, i) => `
    <button type="button" class="recent-item" data-idx="${i}">
      <span class="ic"><svg viewBox="0 0 24 24" fill="none"><path d="M12 21s7-6.5 7-12A7 7 0 0 0 5 9c0 5.5 7 12 7 12Z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="9" r="2.4" stroke="currentColor" stroke-width="1.6"/></svg></span>
      <div>
        <b>${escapeHtml(item.pickup)}</b>
        <span>${item.dropoff ? escapeHtml(item.dropoff) : 'بدون وجهة محددة'}</span>
      </div>
    </button>
  `).join('');
  listEl.querySelectorAll('.recent-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = list[Number(btn.dataset.idx)];
      openBooking(state.currentService || 'taxi');
      document.getElementById('pickup').value = item.pickup;
      document.getElementById('dropoff').value = item.dropoff || '';
      haptic();
    });
  });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function handleSubmit(e) {
  e.preventDefault();
  clearMsg();

  const name = document.getElementById('customerName').value.trim();
  const phone = document.getElementById('phone').value.trim();
  const pickup = document.getElementById('pickup').value.trim();
  const dropoff = document.getElementById('dropoff').value.trim();
  const scheduledAt = document.getElementById('scheduledAt').value;
  const notes = document.getElementById('notes').value.trim();
  const pickupLat = document.getElementById('pickupLat').value;
  const pickupLng = document.getElementById('pickupLng').value;

  const validPickup = validateField('pickup');
  const validName = validateField('customerName');
  const validPhone = validateField('phone');
  if (!validPickup || !validName || !validPhone) {
    haptic(20);
    const firstInvalid = document.querySelector('.float-field.invalid input');
    if (firstInvalid) firstInvalid.focus();
    return;
  }

  showView('submitting');
  sheet.setSnap('half');

  try {
    const { data, error } = await supabaseClient
      .rpc('submit_trip_request', {
        p_service_type: state.currentService,
        p_customer_name: name,
        p_phone: phone,
        p_pickup_location: pickup,
        p_pickup_lat: pickupLat ? Number(pickupLat) : null,
        p_pickup_lng: pickupLng ? Number(pickupLng) : null,
        p_dropoff_location: dropoff || null,
        p_scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        p_notes: notes || null,
      })
      .single();

    if (error) throw error;

    state.lastSubmission = {
      id: data.id,
      request_number: data.request_number,
      phone,
      service_type: state.currentService,
      pickup, dropoff,
      created_at: new Date().toISOString(),
    };
    state.lastKnownStatus = 'new';
    saveRecentLocation(pickup, dropoff);
    renderStatusView();
    showView('status');
    sheet.setSnap('half');
    haptic(15);
    startStatusPolling();
  } catch (err) {
    console.error(err);
    showView('booking');
    sheet.setSnap('full');
    showMsg('تعذّر إرسال الطلب. تأكد من الاتصال بالإنترنت ثم حاول مجدداً.');
  }
}

function buildWhatsappLink(driverPhone) {
  const s = state.lastSubmission;
  if (!s) return '#';
  const target = driverPhone || BUSINESS_WHATSAPP_NUMBER;
  const svc = SERVICES[s.service_type]?.label || s.service_type;
  const text = encodeURIComponent(
    `مرحباً، لدي طلب رحلة على مستقبلي كاب\n` +
    `رقم الطلب: ${s.request_number}\n` +
    `الخدمة: ${svc}\n` +
    `من: ${s.pickup}\n` +
    (s.dropoff ? `إلى: ${s.dropoff}\n` : '')
  );
  return `https://wa.me/${target}?text=${text}`;
}

/* ============================================================
   Status view rendering + live polling
   ============================================================ */
function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function renderStatusView() {
  const s = state.lastSubmission;
  document.getElementById('statusReqChip').textContent = '#' + (s.request_number || s.id.slice(0, 8).toUpperCase());
  document.getElementById('statusTime').textContent = formatTime(s.created_at);
  document.getElementById('statusSvcTag').textContent = SERVICES[s.service_type]?.label || s.service_type;
  document.getElementById('statusServiceLabel').textContent = SERVICES[s.service_type]?.label || s.service_type;
  document.getElementById('statusPickup').textContent = s.pickup || '—';
  document.getElementById('statusDropoff').textContent = s.dropoff || '—';
  renderTimeline('new');
  document.getElementById('whatsappBtnApp').href = buildWhatsappLink();
}

function renderTimeline(status) {
  const timelineEl = document.getElementById('timelineApp');
  if (status === 'cancelled') {
    timelineEl.innerHTML = `<div class="tla-step cancelled current"><span class="tla-dot"></span><span>تم إلغاء الطلب</span></div>`;
    return;
  }
  const currentIndex = Math.max(0, TIMELINE_STEPS.indexOf(status));
  timelineEl.innerHTML = TIMELINE_STEPS.map((step, i) => {
    const done = i < currentIndex;
    const current = i === currentIndex;
    return `
      <div class="tla-step ${done ? 'done' : ''} ${current ? 'current' : ''}">
        <span class="tla-dot">${done ? '<svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}</span>
        <span>${TIMELINE_LABELS[step]}</span>
      </div>`;
  }).join('');
}

function applyDriverInfo(row) {
  const card = document.getElementById('driverCard');
  const avatar = document.getElementById('driverAvatar');
  const pendingText = document.getElementById('driverPendingText');
  const pendingSub = document.getElementById('driverPendingSub');
  const meta = document.getElementById('driverMeta');
  const etaWrap = document.getElementById('driverEta');
  const actions = document.getElementById('driverActions');

  if (row.driver_name) {
    card.classList.remove('driver-pending');
    card.classList.add('driver-live');
    avatar.innerHTML = row.driver_photo_url
      ? `<img src="${escapeHtml(row.driver_photo_url)}" alt="">`
      : `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.6"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    pendingText.textContent = row.driver_name;
    pendingSub.textContent = row.status === 'arrived' ? 'السائق وصل لموقعك' : 'في الطريق إليك';

    meta.hidden = false;
    document.getElementById('driverRatingTag').textContent = row.driver_rating != null ? `${Number(row.driver_rating).toFixed(1)} ★` : '— ★';
    document.getElementById('driverCarTag').textContent = row.driver_car_type || '—';
    document.getElementById('driverPlateTag').textContent = row.driver_plate || '—';

    if (row.eta_minutes != null && row.status !== 'arrived' && row.status !== 'completed') {
      etaWrap.hidden = false;
      document.getElementById('driverEtaVal').textContent = row.eta_minutes;
    } else {
      etaWrap.hidden = true;
    }

    actions.hidden = false;
    const callBtn = document.getElementById('callDriverBtn');
    const waBtn = document.getElementById('whatsappDriverBtn');
    if (row.driver_phone) {
      callBtn.href = `tel:${row.driver_phone}`;
      waBtn.href = buildWhatsappLink(row.driver_phone.replace(/^0/, '964'));
    }
  } else {
    card.classList.add('driver-pending');
    card.classList.remove('driver-live');
    meta.hidden = true;
    etaWrap.hidden = true;
    actions.hidden = true;
  }
}

function startStatusPolling() {
  stopStatusPolling();
  state.statusPollTimer = setInterval(pollStatus, STATUS_POLL_MS);
}
function stopStatusPolling() {
  if (state.statusPollTimer) {
    clearInterval(state.statusPollTimer);
    state.statusPollTimer = null;
  }
}

async function pollStatus() {
  const s = state.lastSubmission;
  if (!s || !s.request_number) return;
  try {
    const { data, error } = await supabaseClient
      .rpc('get_trip_request_status', { p_request_number: s.request_number, p_phone: s.phone })
      .single();
    if (error || !data) return;

    if (data.status !== state.lastKnownStatus) {
      state.lastKnownStatus = data.status;
      renderTimeline(data.status);
      if (data.status === 'completed' || data.status === 'cancelled') {
        stopStatusPolling();
      }
      haptic(12);
    }
    applyDriverInfo(data);
  } catch (err) {
    console.error('status poll failed', err);
  }
}

/* ============================================================
   Init
   ============================================================ */
function buildQuickServiceChips() {
  const wrap = document.getElementById('quickServices');
  wrap.innerHTML = Object.entries(SERVICES).map(([key, svc]) => `
    <button type="button" class="qs-chip" data-service="${key}">
      <span class="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none">${ICONS[svc.icon]}</svg></span>
      <span>${svc.label}</span>
    </button>
  `).join('');
  wrap.querySelectorAll('.qs-chip').forEach(chip => {
    chip.addEventListener('click', () => openBooking(chip.dataset.service));
  });
}

function buildServiceSwitch() {
  const wrap = document.getElementById('svcSwitch');
  wrap.innerHTML = Object.entries(SERVICES).map(([key, svc]) => `
    <button type="button" class="svc-pill" data-service="${key}">
      <svg viewBox="0 0 24 24" fill="none">${ICONS[svc.icon]}</svg>
      <span>${svc.label}</span>
    </button>
  `).join('');
  wrap.querySelectorAll('.svc-pill').forEach(pill => {
    pill.addEventListener('click', () => selectService(pill.dataset.service));
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
}

/* ============================================================
   iOS keyboard / viewport handling
   Uses the VisualViewport API (supported on iOS Safari 13+ and all
   modern Android browsers) to detect the on-screen keyboard opening
   and keep the focused field visible instead of letting it hide
   behind the keyboard or the bottom sheet collapsing awkwardly.
   ============================================================ */
function initViewportHandling() {
  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  let baseHeight = vv.height;

  vv.addEventListener('resize', () => {
    const keyboardLikelyOpen = vv.height < baseHeight * 0.75;
    document.body.classList.toggle('kb-open', keyboardLikelyOpen);
    if (keyboardLikelyOpen) {
      // Keep the sheet tall enough that the focused field stays above
      // the keyboard instead of being covered by it.
      sheet.el.style.setProperty('--sheet-h', Math.round(vv.height * 0.94) + 'px');
    } else {
      sheet.setSnap(sheet.current, false);
      baseHeight = vv.height;
    }
  });

  document.addEventListener('focusin', (e) => {
    if (e.target.matches('input, textarea')) {
      setTimeout(() => {
        e.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 300);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  buildQuickServiceChips();
  buildServiceSwitch();
  initMap();
  registerServiceWorker();
  renderRecentLocations();

  sheet = new BottomSheet(
    document.getElementById('sheet'),
    document.getElementById('sheetHandleArea'),
    document.getElementById('sheetScroll')
  );
  sheet.setSnap('half', false);
  initViewportHandling();

  document.getElementById('whereToBtn').addEventListener('click', () => openBooking());
  document.querySelectorAll('[data-back="home"]').forEach(b => b.addEventListener('click', () => { backToHome(); }));
  document.getElementById('requestForm').addEventListener('submit', handleSubmit);
  document.getElementById('recenterBtn').addEventListener('click', () => { locateMe(false); haptic(); });
  document.getElementById('locateBtnApp').addEventListener('click', () => { locateMe(false); haptic(); });
  document.getElementById('newRequestBtn').addEventListener('click', () => {
    stopStatusPolling();
    document.getElementById('requestForm').reset();
    ['pickup', 'customerName', 'phone'].forEach(id => setFieldError(id === 'customerName' ? 'customerName' : id, null));
    clearMsg();
    backToHome();
  });
  ['pickup', 'dropoff'].forEach(id => {
    document.getElementById(id).addEventListener('input', updatePriceBar);
  });
  document.getElementById('pickup').addEventListener('blur', () => validateField('pickup'));
  document.getElementById('customerName').addEventListener('blur', () => validateField('customerName'));
  document.getElementById('phone').addEventListener('blur', () => validateField('phone'));

  locateMe(true);
});
