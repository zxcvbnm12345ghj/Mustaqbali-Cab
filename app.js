// Mustaqbali Cab — Customer App Shell (PWA)
// Same backend contract as before: submit_trip_request RPC, same WhatsApp
// deep-link logic, same service catalog. Only the customer UX changed.
// Localized for Iraq: Baghdad default map center, Iraqi Dinar pricing,
// +964 WhatsApp number, Iraqi phone format.

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

const BUSINESS_WHATSAPP_NUMBER = '9647700000000'; // TODO: replace with the real company WhatsApp number (964 + 10-digit Iraqi mobile, no leading 0)
const BAGHDAD = { lat: 33.3152, lng: 44.3661 };
const TIMELINE_STEPS = ['new', 'assigned', 'in_progress', 'completed'];
const TIMELINE_LABELS = { new: 'جديد', assigned: 'تم التعيين', in_progress: 'قيد التنفيذ', completed: 'مكتملة' };

const state = {
  currentService: null,
  pickupLatLng: null,
  map: null,
  pickupMarker: null,
  decorLine: null,
  lastSubmission: null, // { id, request_number, service_type, pickup, dropoff }
};

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
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(state.map);

    state.map.on('click', (e) => setPickup(e.latlng.lat, e.latlng.lng, { reverseGeocode: true, fly: false }));

    // Mobile browsers (especially iOS Safari) resize the viewport as the
    // address bar shows/hides, which can leave Leaflet's tile grid
    // mis-measured on first paint. Force a recheck after layout settles.
    setTimeout(() => state.map.invalidateSize(), 250);
    window.addEventListener('resize', () => state.map && state.map.invalidateSize());
  } catch (err) {
    console.error('Map failed to load', err);
    document.getElementById('map').style.background =
      'radial-gradient(120% 90% at 15% -10%, #16204A 0%, #0A0E1A 45%)';
  }
}

function pickupDivIcon() {
  return L.divIcon({
    className: 'pickup-pin dropped',
    html: `<svg viewBox="0 0 34 34" fill="none">
      <path d="M17 2c-6.6 0-12 5.3-12 11.8C5 22 17 32 17 32s12-10 12-18.2C29 7.3 23.6 2 17 2Z" fill="#E8A94C" stroke="#0A0E1A" stroke-width="1.4"/>
      <circle cx="17" cy="13.5" r="4.6" fill="#0A0E1A"/>
    </svg>`,
    iconSize: [34, 34],
    iconAnchor: [17, 32],
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
    }
    drawDecorRoute(lat, lng);
    if (fly) state.map.flyTo([lat, lng], 15, { duration: 1.1 });
  }

  if (reverseGeocode) reverseGeocodePickup(lat, lng);
  updatePriceBar();
}

function drawDecorRoute(lat, lng) {
  // purely decorative animated line hinting at "your trip" — same visual
  // motif used on the original marketing hero, not a real calculated route.
  if (!state.map) return;
  const offset = [lat + 0.01, lng + 0.014];
  if (state.decorLine) state.map.removeLayer(state.decorLine);
  state.decorLine = L.polyline([[lat, lng], offset], {
    className: 'decor-route',
    weight: 3,
  }).addTo(state.map);
}

async function reverseGeocodePickup(lat, lng) {
  const input = document.getElementById('pickup');
  const original = input.value;
  input.placeholder = 'جارٍ تحديد العنوان...';
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
   Bottom sheet — drag to snap between peek / half / full
   ============================================================ */
const SHEET_HEIGHTS = ['peek', 'half', 'full'];

function setSheetHeight(name) {
  document.getElementById('sheet').dataset.height = name;
  const fab = document.getElementById('recenterBtn');
  if (fab) {
    const bottomBySheet = { peek: 160, half: window.innerHeight * 0.44 + 20, full: window.innerHeight * 0.92 + 20 };
    fab.style.bottom = Math.min(bottomBySheet[name], window.innerHeight - 90) + 'px';
  }
}

function initSheetDrag() {
  const sheet = document.getElementById('sheet');
  const handle = document.getElementById('sheetHandleArea');
  let startY = 0;
  let startHeight = 0;
  let dragging = false;

  const getHeightPx = () => sheet.getBoundingClientRect().height;

  const onStart = (clientY) => {
    dragging = true;
    startY = clientY;
    startHeight = getHeightPx();
    sheet.classList.add('dragging');
  };
  const onMove = (clientY) => {
    if (!dragging) return;
    const delta = startY - clientY;
    const newHeight = Math.min(window.innerHeight * 0.92, Math.max(120, startHeight + delta));
    sheet.style.height = newHeight + 'px';
  };
  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('dragging');
    sheet.style.height = '';
    const h = getHeightPx();
    const vh = window.innerHeight;
    const ratio = h / vh;
    if (ratio < 0.22) setSheetHeight('peek');
    else if (ratio < 0.66) setSheetHeight('half');
    else setSheetHeight('full');
  };

  handle.addEventListener('pointerdown', (e) => { handle.setPointerCapture(e.pointerId); onStart(e.clientY); });
  handle.addEventListener('pointermove', (e) => onMove(e.clientY));
  handle.addEventListener('pointerup', onEnd);
  handle.addEventListener('pointercancel', onEnd);
}

/* ============================================================
   View switching
   ============================================================ */
function showView(name) {
  document.querySelectorAll('.sheet-view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
}

function openBooking(serviceKey) {
  if (serviceKey) selectService(serviceKey);
  else if (!state.currentService) selectService('taxi');
  showView('booking');
  setSheetHeight('full');
  document.getElementById('sheetScroll').scrollTop = 0;
}

function backToHome() {
  showView('home');
  setSheetHeight('half');
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
}

function updatePriceBar() {
  if (!state.currentService) return;
  const svc = SERVICES[state.currentService];
  document.getElementById('priceEstimate').textContent = `${svc.base} دينار تقريباً`;
  document.getElementById('bookBtnLabel').textContent = `اطلب ${svc.label} الآن`;
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

  if (!name || !phone || !pickup) {
    showMsg('يرجى تعبئة الاسم ورقم الجوال ومكان الانطلاق.');
    return;
  }

  showView('submitting');

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
      service_type: state.currentService,
      pickup, dropoff,
    };
    renderStatusView();
    showView('status');
  } catch (err) {
    console.error(err);
    showView('booking');
    showMsg('تعذّر إرسال الطلب. تأكد من الاتصال بالإنترنت ثم حاول مجدداً.');
  }
}

function buildWhatsappLink() {
  const s = state.lastSubmission;
  if (!s) return '#';
  const svc = SERVICES[s.service_type]?.label || s.service_type;
  const text = encodeURIComponent(
    `مرحباً، لدي طلب رحلة على مستقبلي كاب\n` +
    `رقم الطلب: ${s.request_number}\n` +
    `الخدمة: ${svc}\n` +
    `من: ${s.pickup}\n` +
    (s.dropoff ? `إلى: ${s.dropoff}\n` : '')
  );
  return `https://wa.me/${BUSINESS_WHATSAPP_NUMBER}?text=${text}`;
}

/* ============================================================
   Status view rendering
   ============================================================ */
function renderStatusView() {
  const s = state.lastSubmission;
  document.getElementById('statusReqChip').textContent = '#' + (s.request_number || s.id.slice(0, 8).toUpperCase());
  document.getElementById('statusSvcTag').textContent = SERVICES[s.service_type]?.label || s.service_type;
  document.getElementById('statusPickup').textContent = s.pickup || '—';
  document.getElementById('statusDropoff').textContent = s.dropoff || '—';

  // A freshly submitted request always starts at "new" — this reflects the
  // real, current, known state (no fabricated live data). Further status
  // changes (assigned/in progress/completed) are pushed to the admin's
  // WhatsApp queue today; the customer is reachable via the WhatsApp button.
  const currentIndex = 0;
  const timelineEl = document.getElementById('timelineApp');
  timelineEl.innerHTML = TIMELINE_STEPS.map((step, i) => {
    const done = i < currentIndex;
    const current = i === currentIndex;
    return `
      <div class="tla-step ${done ? 'done' : ''} ${current ? 'current' : ''}">
        <span class="tla-dot">${done ? '<svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}</span>
        <span>${TIMELINE_LABELS[step]}</span>
      </div>`;
  }).join('');

  document.getElementById('whatsappBtnApp').href = buildWhatsappLink();
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

document.addEventListener('DOMContentLoaded', () => {
  buildQuickServiceChips();
  buildServiceSwitch();
  initMap();
  initSheetDrag();
  registerServiceWorker();

  setSheetHeight('half');
  window.addEventListener('resize', () => setSheetHeight(document.getElementById('sheet').dataset.height));

  document.getElementById('whereToBtn').addEventListener('click', () => openBooking());
  document.querySelectorAll('[data-back="home"]').forEach(b => b.addEventListener('click', backToHome));
  document.getElementById('requestForm').addEventListener('submit', handleSubmit);
  document.getElementById('recenterBtn').addEventListener('click', () => locateMe(false));
  document.getElementById('locateBtnApp').addEventListener('click', () => locateMe(false));
  document.getElementById('newRequestBtn').addEventListener('click', () => {
    document.getElementById('requestForm').reset();
    clearMsg();
    backToHome();
  });
  ['pickup', 'dropoff'].forEach(id => {
    document.getElementById(id).addEventListener('input', updatePriceBar);
  });

  // Try to center on the visitor's real location right away, like a real
  // ride-hailing app — falls back to the Baghdad default silently if denied.
  locateMe(true);
});
