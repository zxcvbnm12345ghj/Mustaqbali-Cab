// Mustaqbali Cab — Customer App Shell (PWA) — v2 (Careem/Uber-grade)
// Same backend contract: submit_trip_request RPC + the new
// get_trip_request_status RPC for live status polling (see schema.sql v1.1).

// Fallback defaults used only until loadServicePrices() successfully
// fetches the real, admin-editable prices from Supabase (service_prices
// table). These numbers are never shown to the customer as final unless
// the fetch fails — see loadServicePrices().
const SERVICES = {
  taxi:      { label: 'تكسي',            base: 3000,  perKm: 500, icon: 'taxi' },
  private:   { label: 'خصوصي',           base: 8000,  perKm: 800, icon: 'private' },
  courier:   { label: 'توصيل أغراض',      base: 2000,  perKm: 400, icon: 'courier' },
  intercity: { label: 'بين المحافظات',    base: 20000, perKm: 350, icon: 'intercity' },
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
const TIMELINE_LABELS = { new: 'جديد', assigned: 'تم التعيين', en_route: 'قيد التنفيذ', arrived: 'تم الوصول', completed: 'مكتملة' };
const STATUS_POLL_MS = 6000;
const RECENT_KEY = 'mustaqbali_recent_locations';
// Straight-line (haversine) distance underestimates real road distance.
// This fixed correction factor approximates typical road-vs-straight-line
// ratios until a paid routing API (Google/Mapbox Directions) is configured
// — see README's "أفكار للتوسع لاحقاً" section, which already flags this.
const ROAD_DISTANCE_FACTOR = 1.3;

const state = {
  currentService: null,
  pickupLatLng: null,
  dropoffLatLng: null,
  mapTargetMode: 'pickup', // 'pickup' | 'dropoff' — which marker the next map tap sets
  map: null,
  pickupMarker: null,
  dropoffMarker: null,
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

    const tiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(state.map);

    tiles.on('load', () => {
      const skel = document.getElementById('mapSkeleton');
      if (skel) skel.classList.add('hide');
    });

    state.map.on('click', (e) => {
      if (state.mapTargetMode === 'dropoff') {
        setDropoff(e.latlng.lat, e.latlng.lng, { reverseGeocode: true, fly: false });
      } else {
        setPickup(e.latlng.lat, e.latlng.lng, { reverseGeocode: true, fly: false });
      }
    });

    setTimeout(() => state.map.invalidateSize(), 250);
    window.addEventListener('resize', () => state.map && state.map.invalidateSize());
  } catch (err) {
    console.error('Map failed to load', err);
    document.getElementById('map').style.background =
      'radial-gradient(120% 90% at 15% -10%, #F8FBFF 0%, #FFFFFF 45%)';
    const skel = document.getElementById('mapSkeleton');
    if (skel) skel.classList.add('hide');
  }
}

function pickupDivIcon() {
  return L.divIcon({
    className: 'pickup-pin dropped',
    html: `<svg viewBox="0 0 34 34" fill="none">
      <path d="M17 2c-6.6 0-12 5.3-12 11.8C5 22 17 32 17 32s12-10 12-18.2C29 7.3 23.6 2 17 2Z" fill="#E5B85C" stroke="#FFFFFF" stroke-width="1.4"/>
      <circle cx="17" cy="13.5" r="4.6" fill="#263746"/>
    </svg>`,
    iconSize: [40, 52],
    iconAnchor: [20, 50],
  });
}

function dropoffDivIcon() {
  return L.divIcon({
    className: 'pickup-pin dropped dropoff-pin',
    html: `<svg viewBox="0 0 34 34" fill="none">
      <path d="M17 2c-6.6 0-12 5.3-12 11.8C5 22 17 32 17 32s12-10 12-18.2C29 7.3 23.6 2 17 2Z" fill="#4AADE8" stroke="#FFFFFF" stroke-width="1.4"/>
      <rect x="13.5" y="10" width="7" height="7" rx="1.4" fill="#263746"/>
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
    drawRoute();
    if (fly) state.map.flyTo([lat, lng], 15, { duration: 1.1 });
  }

  if (reverseGeocode) reverseGeocodePickup(lat, lng);
  updatePriceBar();
  validateField('pickup');
}

function setDropoff(lat, lng, { reverseGeocode = false, fly = true } = {}) {
  state.dropoffLatLng = { lat, lng };
  document.getElementById('dropoffLat').value = lat;
  document.getElementById('dropoffLng').value = lng;

  if (state.map) {
    if (!state.dropoffMarker) {
      state.dropoffMarker = L.marker([lat, lng], { icon: dropoffDivIcon(), draggable: true }).addTo(state.map);
      state.dropoffMarker.on('dragend', () => {
        const p = state.dropoffMarker.getLatLng();
        setDropoff(p.lat, p.lng, { reverseGeocode: true, fly: false });
      });
    } else {
      state.dropoffMarker.setLatLng([lat, lng]);
      const el = state.dropoffMarker.getElement();
      if (el) {
        el.classList.remove('dropped');
        void el.offsetWidth;
        el.classList.add('dropped');
      }
    }
    drawRoute();
    if (fly) state.map.flyTo([lat, lng], 15, { duration: 1.1 });
  }

  if (reverseGeocode) reverseGeocodeDropoff(lat, lng);
  updatePriceBar();
}

// Draws the visible line between pickup and dropoff when both are set;
// falls back to the short decorative flourish (original behavior) when
// only pickup is known yet. This is a straight line on the map — it is
// NOT a routed path (no driving-directions API is configured) — but the
// distance used for pricing already accounts for that via
// ROAD_DISTANCE_FACTOR, so the price itself is a fair approximation even
// though the drawn line is straight.
function drawRoute() {
  if (!state.map || !state.pickupLatLng) return;
  if (state.decorLine) state.map.removeLayer(state.decorLine);

  const from = [state.pickupLatLng.lat, state.pickupLatLng.lng];
  const to = state.dropoffLatLng
    ? [state.dropoffLatLng.lat, state.dropoffLatLng.lng]
    : [state.pickupLatLng.lat + 0.01, state.pickupLatLng.lng + 0.014]; // decorative fallback

  state.decorLine = L.polyline([from, to], {
    className: 'decor-route',
    weight: 4,
  }).addTo(state.map);

  if (state.dropoffLatLng) {
    state.map.fitBounds(L.latLngBounds([from, to]), { padding: [70, 70], maxZoom: 15 });
  }
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

async function reverseGeocodeDropoff(lat, lng) {
  const input = document.getElementById('dropoff');
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

// Forward-geocodes whatever the customer typed into the dropoff field so
// distance-based pricing works even if they never touch the map. Only
// runs when we don't already have dropoff coordinates from a map tap/drag
// (those are more precise and shouldn't be overwritten by a text search).
async function geocodeDropoff(query) {
  if (!query || state.dropoffLatLng) return;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&accept-language=ar&countrycodes=iq`);
    const data = await res.json();
    if (data && data[0]) {
      setDropoff(parseFloat(data[0].lat), parseFloat(data[0].lon), { reverseGeocode: false, fly: false });
      // setDropoff() overwrites the input with our own value only via
      // reverseGeocode; since that's false here, the customer's typed
      // text is preserved as-is instead of being replaced.
    }
  } catch (err) {
    console.error('dropoff geocoding failed', err);
  }
}

// Great-circle distance in kilometers between two coordinates.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
  if (!svc) return;

  let distanceKm = null;
  let total = svc.base;
  if (state.pickupLatLng && state.dropoffLatLng) {
    const straightKm = haversineKm(
      state.pickupLatLng.lat, state.pickupLatLng.lng,
      state.dropoffLatLng.lat, state.dropoffLatLng.lng
    );
    distanceKm = straightKm * ROAD_DISTANCE_FACTOR;
    total = svc.base + distanceKm * svc.perKm;
  }

  const priceEl = document.getElementById('priceEstimate');
  const distanceTag = document.getElementById('distanceTag');
  priceEl.style.opacity = '0';
  setTimeout(() => {
    if (distanceKm != null) {
      priceEl.textContent = `${Math.round(total).toLocaleString('en-US')} دينار`;
      distanceTag.hidden = false;
      distanceTag.textContent = `المسافة التقريبية: ${distanceKm.toFixed(1)} كم`;
    } else {
      priceEl.textContent = `${Math.round(svc.base).toLocaleString('en-US')} دينار (سعر أساسي بدون وجهة)`;
      distanceTag.hidden = true;
    }
    priceEl.style.opacity = '1';
  }, 100);
  document.getElementById('bookBtnLabel').textContent = `اطلب ${svc.label} الآن`;
}

// Fetches real, admin-editable prices from Supabase and overwrites the
// SERVICES fallback defaults in place — every function that reads
// SERVICES[...] (chips, price bar, submit) automatically picks up the
// real values because they all read from this same shared object.
async function loadServicePrices() {
  try {
    const { data, error } = await supabaseClient.from('service_prices').select('*');
    if (error || !data) return;
    data.forEach(row => {
      if (SERVICES[row.service_type]) {
        SERVICES[row.service_type].label = row.label;
        SERVICES[row.service_type].base = Number(row.base_price);
        SERVICES[row.service_type].perKm = Number(row.price_per_km);
      }
    });
    buildQuickServiceChips();
    buildServiceSwitch();
    updatePriceBar();
  } catch (err) {
    console.error('failed to load service prices, using fallback defaults', err);
  }
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

/* ============================================================
   Iraqi phone normalization for wa.me links
   Admin can type the driver's number in more than one shape (with/
   without a leading 0, with +964, with spaces/dashes). A naive
   `.replace(/^0/, '964')` silently produces a wrong or incomplete
   number for every shape except the exact "07xxxxxxxxx" one — this
   normalizes all common shapes, and returns null (rather than a
   broken link) when the input can't be confidently normalized.
   ============================================================ */
function normalizeIraqiPhoneForWhatsapp(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, ''); // strip spaces, dashes, +, etc.
  if (!digits) return null;

  if (digits.startsWith('00964')) return digits.slice(2);        // 00964xxxxxxxxxx -> 964xxxxxxxxxx
  if (digits.startsWith('964') && digits.length === 13) return digits; // already correct
  if (digits.startsWith('0') && digits.length === 11) return '964' + digits.slice(1); // 07xxxxxxxxx
  if (digits.startsWith('7') && digits.length === 10) return '964' + digits;          // missing leading 0

  return null; // unrecognized shape — caller must hide the button rather than link a wrong number
}

function buildWhatsappLink(driverPhoneRaw) {
  const s = state.lastSubmission;
  if (!s) return null;
  const target = driverPhoneRaw ? normalizeIraqiPhoneForWhatsapp(driverPhoneRaw) : BUSINESS_WHATSAPP_NUMBER;
  if (!target) return null; // couldn't normalize — caller must not show a broken link
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
  const businessLink = buildWhatsappLink();
  const waBtnApp = document.getElementById('whatsappBtnApp');
  if (businessLink) {
    waBtnApp.href = businessLink;
    waBtnApp.hidden = false;
  } else {
    waBtnApp.hidden = true; // BUSINESS_WHATSAPP_NUMBER not configured — hide rather than link nothing
  }
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
      const cleanTel = row.driver_phone.replace(/[^\d+]/g, '');
      callBtn.href = `tel:${cleanTel}`;
      callBtn.hidden = false;
      const driverLink = buildWhatsappLink(row.driver_phone);
      if (driverLink) {
        waBtn.href = driverLink;
        waBtn.hidden = false;
      } else {
        // Couldn't confidently normalize this number — hide the button
        // instead of sending the customer to a wrong or dead WhatsApp chat.
        waBtn.hidden = true;
      }
    } else {
      callBtn.hidden = true;
      waBtn.hidden = true;
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
  pollStatus(); // fire immediately — setInterval alone waits STATUS_POLL_MS
  // before its first run, leaving the customer on stale data unnecessarily.
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
   PWA Install Prompt — captures beforeinstallprompt and shows a
   small branded card inviting the visitor to install the app.
   Self-contained (styles injected via JS): does not touch
   index.html, app.css, or style.css. Additive only — no existing
   function or markup is changed.
   ============================================================ */
const PWA_INSTALLED_KEY = 'mustaqbali_pwa_installed';
const PWA_DISMISSED_KEY = 'mustaqbali_pwa_install_dismissed_at';
const PWA_DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000; // 14 يوماً
let deferredInstallPrompt = null;

function injectInstallCardStyles() {
  if (document.getElementById('pwaInstallStyles')) return;
  const style = document.createElement('style');
  style.id = 'pwaInstallStyles';
  style.textContent = `
    #pwaInstallCard {
      position: fixed;
      left: 16px;
      right: 16px;
      bottom: 16px;
      z-index: 10000;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      border-radius: 16px;
      background: #0A0E1A;
      color: #fff;
      box-shadow: 0 8px 28px rgba(0,0,0,0.35);
      border: 1px solid rgba(232,169,76,0.35);
      font-family: inherit;
      direction: rtl;
      transform: translateY(120%);
      transition: transform 0.3s ease;
    }
    #pwaInstallCard.show { transform: translateY(0); }
    #pwaInstallCard .pwa-icon {
      width: 40px; height: 40px; flex-shrink: 0;
      border-radius: 10px;
      background: linear-gradient(135deg, #E8A94C, #33D6C0);
      display: flex; align-items: center; justify-content: center;
    }
    #pwaInstallCard .pwa-text { flex: 1; min-width: 0; }
    #pwaInstallCard .pwa-text b { display: block; font-size: 14px; }
    #pwaInstallCard .pwa-text span { display: block; font-size: 12px; opacity: 0.75; margin-top: 2px; }
    #pwaInstallCard .pwa-install-btn {
      flex-shrink: 0;
      border: none;
      border-radius: 10px;
      padding: 9px 14px;
      font-size: 13px;
      font-weight: 600;
      color: #0A0E1A;
      background: linear-gradient(135deg, #E8A94C, #33D6C0);
      cursor: pointer;
    }
    #pwaInstallCard .pwa-close-btn {
      flex-shrink: 0;
      border: none;
      background: transparent;
      color: rgba(255,255,255,0.55);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 4px;
    }
  `;
  document.head.appendChild(style);
}

function showInstallCard() {
  if (localStorage.getItem(PWA_INSTALLED_KEY) === '1') return;
  const dismissedAt = Number(localStorage.getItem(PWA_DISMISSED_KEY) || 0);
  if (dismissedAt && Date.now() - dismissedAt < PWA_DISMISS_COOLDOWN_MS) return;
  if (document.getElementById('pwaInstallCard')) return;

  injectInstallCardStyles();

  const card = document.createElement('div');
  card.id = 'pwaInstallCard';
  card.innerHTML = `
    <span class="pwa-icon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3 12L11 4L21 12L11 20L3 12Z" stroke="#0A0E1A" stroke-width="1.6" stroke-linejoin="round"/><circle cx="11" cy="12" r="2.2" fill="#0A0E1A"/></svg>
    </span>
    <span class="pwa-text">
      <b>ثبّت تطبيق مستقبلي</b>
      <span>وصول أسرع بدون فتح المتصفح في كل مرة</span>
    </span>
    <button type="button" class="pwa-install-btn" id="pwaInstallBtn">تثبيت التطبيق</button>
    <button type="button" class="pwa-close-btn" id="pwaCloseBtn" aria-label="إغلاق">✕</button>
  `;
  document.body.appendChild(card);
  requestAnimationFrame(() => card.classList.add('show'));

  document.getElementById('pwaInstallBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (outcome === 'accepted') {
      localStorage.setItem(PWA_INSTALLED_KEY, '1');
    }
    hideInstallCard();
  });

  document.getElementById('pwaCloseBtn').addEventListener('click', () => {
    localStorage.setItem(PWA_DISMISSED_KEY, String(Date.now()));
    hideInstallCard();
  });
}

function hideInstallCard() {
  const card = document.getElementById('pwaInstallCard');
  if (!card) return;
  card.classList.remove('show');
  setTimeout(() => card.remove(), 300);
}

function initPwaInstallPrompt() {
  if (localStorage.getItem(PWA_INSTALLED_KEY) === '1') return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    showInstallCard();
  });

  window.addEventListener('appinstalled', () => {
    localStorage.setItem(PWA_INSTALLED_KEY, '1');
    deferredInstallPrompt = null;
    hideInstallCard();
  });
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
  initPwaInstallPrompt();
  renderRecentLocations();
  loadServicePrices();

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
    state.dropoffLatLng = null;
    if (state.dropoffMarker) { state.map.removeLayer(state.dropoffMarker); state.dropoffMarker = null; }
    document.getElementById('dropoffLat').value = '';
    document.getElementById('dropoffLng').value = '';
    backToHome();
  });
  document.getElementById('pickup').addEventListener('input', updatePriceBar);
  document.getElementById('dropoff').addEventListener('input', () => {
    state.dropoffLatLng = null; // typed text invalidates any previously map-picked coordinate
    document.getElementById('dropoffLat').value = '';
    document.getElementById('dropoffLng').value = '';
    updatePriceBar();
  });
  document.getElementById('dropoff').addEventListener('blur', (e) => {
    const q = e.target.value.trim();
    if (q) geocodeDropoff(q);
  });
  document.getElementById('pickup').addEventListener('blur', () => validateField('pickup'));
  document.getElementById('customerName').addEventListener('blur', () => validateField('customerName'));
  document.getElementById('phone').addEventListener('blur', () => validateField('phone'));

  document.querySelectorAll('.mt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mapTargetMode = btn.dataset.target;
      document.querySelectorAll('.mt-btn').forEach(b => b.classList.toggle('active', b === btn));
      haptic();
    });
  });

  locateMe(true);
});
