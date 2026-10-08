// =============================================================
// المطاعم / الأسواق / مكتب المستقبل — customer-facing directory.
// Additive-only file, loaded AFTER app.js/market.js in index.html.
// Reuses (never redefines) the following globals already defined in
// app.js: supabaseClient, state, sheet, showView, backToHome, haptic,
// toast, escapeHtmlText, escapeHtmlAttr, openBooking, updatePriceBar.
//
// Backend contract (see migration_places_details.sql — run once in
// the Supabase SQL editor, same way every other migration_*.sql file
// in this project is applied):
//   - restaurants / markets  — existing tables, now with extra rich
//                              columns: category, description,
//                              image_url, phone, address, hours_text,
//                              sort_order (all admin-editable from the
//                              "المطاعم والأسواق ومكتب المستقبل" tab).
//   - future_office          — brand-new table, identical shape.
//
// No mock/fake data anywhere below: every grid/detail starts empty
// and is only ever filled from a real Supabase response. If the
// migration hasn't been run yet, or a category has zero active rows,
// this shows the existing professional "قريباً" empty state — never a
// fabricated place.
// =============================================================

const PLACE_KINDS = {
  restaurants:  { table: 'restaurants',    title: 'المطاعم',        emptyIcon: '🍔', tabLabel: '🍔 المطاعم' },
  markets:      { table: 'markets',        title: 'الأسواق',        emptyIcon: '🛒', tabLabel: '🛒 الأسواق' },
  futureOffice: { table: 'future_office',  title: 'مكتب المستقبل',  emptyIcon: '🏪', tabLabel: '🏪 مكتب المستقبل' },
};

const placesState = {
  currentKind: null,
  rowsCache: {},     // id -> row, filled as cards render so detail never needs a second fetch
  detailBackTarget: 'places', // 'places' or 'home' — where the detail page's back button goes
};

/* ============================================================
   Navigation
   ============================================================ */
function openPlaces(kind) {
  placesState.currentKind = kind;
  placesState.detailBackTarget = 'places';

  const cfg = PLACE_KINDS[kind];
  document.getElementById('plcListTitle').textContent = cfg.title;

  // Tabs only make sense switching between "المطاعم"/"الأسواق" — مكتب
  // المستقبل is its own dedicated flow (usually a single office), so
  // the tab row is hidden for it and shown otherwise.
  const tabs = document.getElementById('plcTabs');
  if (tabs) tabs.hidden = kind === 'futureOffice';
  document.querySelectorAll('#plcTabs [data-plc-kind]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.plcKind === kind);
  });

  showView('places');
  sheet.setSnap('full');
  haptic();
  loadPlacesList(kind);
}

// مكتب المستقبل: skip the list entirely when there's exactly one
// active branch (the common case today) and go straight to its
// details page; fall back to the list view if there are zero (empty
// state) or several (let the customer pick one).
async function openFutureOffice() {
  const cfg = PLACE_KINDS.futureOffice;
  try {
    const { data, error } = await supabaseClient
      .from(cfg.table)
      .select('*')
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (!data || data.length === 0) {
      toast('قريباً — لا تتوفر معلومات مكتب المستقبل حالياً');
      return;
    }
    if (data.length === 1) {
      placesState.detailBackTarget = 'home';
      openPlaceDetail('futureOffice', data[0]);
      return;
    }
    openPlaces('futureOffice');
  } catch (err) {
    console.error('openFutureOffice failed', err);
    toast('تعذّر تحميل بيانات مكتب المستقبل حالياً');
  }
}

function switchPlacesTab(kind) {
  if (kind === placesState.currentKind) return;
  openPlaces(kind);
}

function openPlaceDetail(kind, row) {
  placesState.rowsCache[row.id] = row;
  renderPlaceDetail(kind, row);
  showView('placeDetail');
  sheet.setSnap('full');
  haptic();
}

/* ============================================================
   List / grid
   ============================================================ */
// FIX (صور المطاعم/الأسواق لا تظهر — real image_url fails silently):
// كانت <img> الحقيقية بلا أي onerror، فإن كان image_url غير صالح
// (مسار خاطئ/رابط خاص/الملف محذوف) تبقى الصورة فارغة بصمت دون أي
// بديل. الحل هنا فقط: عند فشل تحميل <img> الحقيقية، تُستبدل بنفس
// الحالة الفارغة الموجودة أصلاً في المشروع (span.plc-card-img-ph
// بأيقونة التصنيف emptyIcon) — لا صورة وهمية جديدة، ولا تغيير على
// image_url أو مصدر البيانات نفسه.
function placeImgFallback(imgEl, emptyIcon) {
  if (!imgEl) return;
  const ph = document.createElement('span');
  ph.className = 'plc-card-img-ph';
  ph.textContent = emptyIcon;
  imgEl.replaceWith(ph);
}

function renderPlaceCard(kind, row) {
  placesState.rowsCache[row.id] = row;
  const img = row.image_url;
  const cfg = PLACE_KINDS[kind];
  return `
    <button type="button" class="plc-card" data-place-row-id="${escapeHtmlAttr(row.id)}">
      <span class="plc-card-img">
        ${img ? `<img src="${escapeHtmlAttr(img)}" alt="" loading="lazy" onerror="placeImgFallback(this, '${cfg.emptyIcon}')">` : `<span class="plc-card-img-ph">${cfg.emptyIcon}</span>`}
      </span>
      <span class="plc-card-body">
        <b class="plc-card-title">${escapeHtmlText(row.name)}</b>
        ${row.category ? `<span class="plc-card-cat plc-card-cat-${kind}">${escapeHtmlText(row.category)}</span>` : ''}
        ${row.hours_text ? `<span class="plc-card-meta">🕒 ${escapeHtmlText(row.hours_text)}</span>` : ''}
      </span>
    </button>
  `;
}

function wirePlaceCards(container, kind, rows) {
  container.querySelectorAll('[data-place-row-id]').forEach((card) => {
    card.addEventListener('click', () => {
      const row = rows.find((r) => String(r.id) === card.dataset.placeRowId);
      if (row) openPlaceDetail(kind, row);
      haptic();
    });
  });
}

async function loadPlacesList(kind) {
  const grid = document.getElementById('plcGrid');
  const empty = document.getElementById('plcEmpty');
  const emptyText = document.getElementById('plcEmptyText');
  if (!grid || !empty) return;
  const cfg = PLACE_KINDS[kind];

  grid.innerHTML = '<div class="qs-skel"></div><div class="qs-skel"></div><div class="qs-skel"></div><div class="qs-skel"></div>';
  empty.hidden = true;

  try {
    const { data, error } = await supabaseClient
      .from(cfg.table)
      .select('*')
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });

    // Bail out silently if the user has already switched tabs/left
    // this view while the request was in flight.
    if (placesState.currentKind !== kind) return;

    if (error || !data || data.length === 0) {
      grid.innerHTML = '';
      if (emptyText) emptyText.textContent = `قريباً — لا توجد ${cfg.title} مضافة بعد`;
      empty.hidden = false;
      return;
    }
    grid.innerHTML = data.map((row) => renderPlaceCard(kind, row)).join('');
    wirePlaceCards(grid, kind, data);
  } catch (err) {
    console.error(`loadPlacesList(${kind}) failed`, err);
    grid.innerHTML = '';
    if (emptyText) emptyText.textContent = `قريباً — لا توجد ${cfg.title} مضافة بعد`;
    empty.hidden = false;
  }
}

/* ============================================================
   Detail page
   ============================================================ */
// FIX (صفحة تفاصيل مطعم/سوق — نفس مشكلة الصور): background-image لا
// يملك onerror أصلاً، فإن فشل image_url كانت الصورة تبقى مفقودة بصمت
// رغم أن hero.classList تحمل has-img. الحل: تحميل الصورة أولاً عبر
// Image() قبل اعتمادها خلفية؛ إن نجحت تُطبَّق كما كانت، وإن فشلت
// تُعرض نفس الحالة الفارغة الموجودة أصلاً (heroPh + emptyIcon) بدل
// خلفية مكسورة. التوكن (placeDetailImgToken) يمنع فقط أن يطبّق تحميل
// قديم متأخر صورة خاطئة إن فتح الزبون مطعماً/سوقاً آخر بسرعة قبل
// اكتمال التحميل السابق — لا تغيير آخر على منطق العرض.
let placeDetailImgToken = 0;
function renderPlaceDetail(kind, row) {
  const cfg = PLACE_KINDS[kind];

  const hero = document.getElementById('plcDetailHero');
  const heroPh = document.getElementById('plcDetailHeroPh');
  const myImgToken = ++placeDetailImgToken;
  const showHeroEmpty = () => {
    hero.style.backgroundImage = '';
    hero.classList.remove('has-img');
    if (heroPh) heroPh.hidden = false; // keeps the SVG icon from index.html (no emoji)
  };
  if (row.image_url) {
    const preload = new Image();
    preload.onload = () => {
      if (myImgToken !== placeDetailImgToken) return; // فُتح عنصر آخر قبل اكتمال هذا التحميل
      hero.style.backgroundImage = `url("${row.image_url.replace(/"/g, '')}")`;
      hero.classList.add('has-img');
      if (heroPh) heroPh.hidden = true;
    };
    preload.onerror = () => {
      if (myImgToken !== placeDetailImgToken) return;
      showHeroEmpty();
    };
    preload.src = row.image_url;
  } else {
    showHeroEmpty();
  }

  document.getElementById('plcDetailName').textContent = row.name || '—';

  const catEl = document.getElementById('plcDetailCategory');
  if (row.category) { catEl.textContent = row.category; catEl.hidden = false; catEl.className = `plc-detail-badge plc-card-cat-${kind}`; }
  else { catEl.hidden = true; }

  const descEl = document.getElementById('plcDetailDesc');
  if (row.description) { descEl.textContent = row.description; descEl.hidden = false; }
  else { descEl.hidden = true; }

  const hoursRow = document.getElementById('plcDetailHoursRow');
  if (row.hours_text) { document.getElementById('plcDetailHours').textContent = row.hours_text; hoursRow.hidden = false; }
  else { hoursRow.hidden = true; }

  const addressRow = document.getElementById('plcDetailAddressRow');
  if (row.address) { document.getElementById('plcDetailAddress').textContent = row.address; addressRow.hidden = false; }
  else { addressRow.hidden = true; }

  const phoneRow = document.getElementById('plcDetailPhoneRow');
  const callBtn = document.getElementById('plcCallBtn');
  const cleanTel = (row.phone || '').replace(/[^\d+]/g, '');
  if (row.phone) {
    document.getElementById('plcDetailPhone').textContent = row.phone;
    phoneRow.hidden = false;
  } else {
    phoneRow.hidden = true;
  }
  if (cleanTel) {
    callBtn.href = `tel:${cleanTel}`;
    callBtn.classList.remove('is-disabled');
  } else {
    callBtn.href = '#';
    callBtn.classList.add('is-disabled');
  }

  document.getElementById('plcDeliveryBtn').onclick = () => requestPlaceDelivery(kind, row);

  renderPlaceDetailExtras(kind, row);
}

/* ============================================================
   Detail page extras: WhatsApp, directions, map, «تواصل عبر يمّك».
   Everything is built ONLY from the real row (phone / lat / lng /
   name). Nothing is shown when the data behind it is missing, and no
   coordinates are ever invented.
   ============================================================ */

// «تواصل عبر يمّك» — ready but OFF. Set to true later to show the
// button. When on, it calls window.onPlaceYammakContact(kind, row) if
// a handler is defined; otherwise it just tells the customer it is
// coming soon. It is not connected to trips / orders / GPS.
const PLACE_DETAIL_YAMMAK_CONTACT_ENABLED = false;

// Valid, real coordinates only. Missing / out-of-range / 0,0 → null.
function placeDetailCoords(row) {
  if (!row || row.lat == null || row.lng == null || row.lat === '' || row.lng === '') return null;
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

// Local Iraqi numbers (07XXXXXXXXX / 7XXXXXXXXX) become 9647XXXXXXXXX.
// Numbers already in international form (+… / 00… / 964…) are kept.
// Anything that does not look like a phone number returns '' (no button).
function placeDetailWhatsappNumber(phone) {
  let d = String(phone || '')
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))   // Arabic-Indic digits
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06F0));  // Persian digits
  const hadPlus = /^\s*\+/.test(d);
  d = d.replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  else if (!hadPlus && d.startsWith('0')) d = '964' + d.slice(1);
  else if (!hadPlus && d.length === 10 && d.startsWith('7')) d = '964' + d;
  return d.length >= 10 && d.length <= 15 ? d : '';
}

function placeDetailSetLink(el, href) {
  if (!el) return;
  if (href) { el.href = href; el.hidden = false; }
  else { el.removeAttribute('href'); el.hidden = true; }
}

function renderPlaceDetailExtras(kind, row) {
  const coords = placeDetailCoords(row);

  // WhatsApp
  const waNumber = placeDetailWhatsappNumber(row.phone);
  const waText = `مرحباً، أتواصل معكم من تطبيق يمّك بخصوص: ${row.name || ''}`.trim();
  placeDetailSetLink(
    document.getElementById('plcWhatsappBtn'),
    waNumber ? `https://wa.me/${waNumber}?text=${encodeURIComponent(waText)}` : ''
  );

  // Directions (opens the customer's maps app with the real coordinates)
  placeDetailSetLink(
    document.getElementById('plcDirectionsBtn'),
    coords ? `https://www.google.com/maps/dir/?api=1&destination=${coords.lat},${coords.lng}&travelmode=driving` : ''
  );

  const quick = document.getElementById('plcDetailQuick');
  if (quick) {
    quick.hidden = !(waNumber || coords);
    quick.classList.toggle('is-single', !(waNumber && coords));
  }

  // «تواصل عبر يمّك»
  const yBtn = document.getElementById('plcYammakContactBtn');
  if (yBtn) {
    yBtn.hidden = !PLACE_DETAIL_YAMMAK_CONTACT_ENABLED;
    yBtn.onclick = () => {
      if (typeof window.onPlaceYammakContact === 'function') window.onPlaceYammakContact(kind, row);
      else toast('قريباً — التواصل عبر يمّك');
    };
  }

  renderPlaceDetailMap(coords);
}

/* Small read-only map (Leaflet is already loaded by index.html).
   Non-interactive on purpose so it never traps the page scroll. The
   marker is an inline SVG, so no extra image requests are needed. */
const placeDetailMapState = { map: null, marker: null, token: 0 };

// Tile source for the detail map — kept in ONE place so it can be linked to
// the project's own map provider later without touching the rest of the code.
// Defaults to the same source the admin map picker uses (OpenStreetMap, see
// admin.js). app.js was not available when this was written, so this is NOT
// confirmed against the customer map: to switch provider, define
//   window.YAMMAK_MAP_TILES = { url: '…{z}/{x}/{y}…', attribution: '…', maxZoom: 19, subdomains: 'abc' }
// before this file runs (or edit the fallback below).
function placeDetailTileConfig() {
  const custom = (typeof window !== 'undefined') ? window.YAMMAK_MAP_TILES : null;
  if (custom && typeof custom.url === 'string' && custom.url) return custom;
  return {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19
  };
}

function placeDetailPinIcon() {
  return L.divIcon({
    className: 'plc-map-pin',
    html: '<svg viewBox="0 0 24 32" width="34" height="44" aria-hidden="true">' +
          '<path d="M12 31s-9-9.2-9-18a9 9 0 0 1 18 0c0 8.800-9 18-9 18Z" fill="#6D28D9" stroke="#fff" stroke-width="1.6"/>' +
          '<circle cx="12" cy="13" r="3.600" fill="#fff"/></svg>',
    iconSize: [34, 44],
    iconAnchor: [17, 43]
  });
}

function renderPlaceDetailMap(coords) {
  const card = document.getElementById('plcDetailMapCard');
  const box = document.getElementById('plcDetailMap');
  if (!card || !box) return;

  if (!coords || typeof L === 'undefined') {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const myToken = ++placeDetailMapState.token;
  const place = () => {
    if (myToken !== placeDetailMapState.token) return; // another place was opened meanwhile
    const st = placeDetailMapState;
    const latlng = [coords.lat, coords.lng];
    if (!st.map) {
      st.map = L.map(box, {
        zoomControl: false, dragging: false, touchZoom: false, doubleClickZoom: false,
        scrollWheelZoom: false, boxZoom: false, keyboard: false, tap: false,
        attributionControl: true
      });
      st.map.attributionControl.setPrefix(false);
      const tiles = placeDetailTileConfig();
      L.tileLayer(tiles.url, {
        maxZoom: tiles.maxZoom || 19,
        attribution: tiles.attribution || '',
        subdomains: tiles.subdomains || 'abc'
      }).addTo(st.map);
    }
    st.map.invalidateSize();
    st.map.setView(latlng, 16, { animate: false });
    if (st.marker) st.marker.setLatLng(latlng);
    else st.marker = L.marker(latlng, { icon: placeDetailPinIcon(), interactive: false, keyboard: false }).addTo(st.map);
  };

  // The detail view becomes visible right after render (sheet snap
  // animation), so size the map again once it has a real width/height.
  setTimeout(place, 60);
  setTimeout(place, 450);
}

function requestPlaceDelivery(kind, row) {
  // The pickup of a delivery request is the PLACE's real coordinates
  // (restaurants/markets/future_office .lat/.lng, set from the admin
  // panel) — never the customer's GPS. A place without coordinates
  // cannot be used for delivery, so the request is blocked here instead
  // of silently sending the customer's own location as the pickup.
  const lat = row && row.lat != null ? Number(row.lat) : NaN;
  const lng = row && row.lng != null ? Number(row.lng) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    toast('لا يمكن طلب توصيل من هذا المكان حالياً — موقعه غير محدد بعد');
    return;
  }

  // The place IS the pickup here — an explicit choice — so live GPS must
  // not replace it. Same rule app.js already applies when the customer
  // taps the map or drags the pin: stop live GPS following
  // (stopGpsWatch), and skip openBooking()'s one-shot auto-locate for
  // this single call only (flag restored right after, so the normal
  // booking flow is unchanged).
  if (typeof stopGpsWatch === 'function') stopGpsWatch();
  const prevAutoLocate = state.autoLocateAttempted;
  state.autoLocateAttempted = true;
  try {
    openBooking('courier');
  } finally {
    state.autoLocateAttempted = prevAutoLocate;
  }
  setTimeout(() => {
    // Real place coordinates become the pickup point (hidden
    // #pickupLat/#pickupLng + marker), then the readable text.
    setPickup(lat, lng, { reverseGeocode: false, fly: true, animate: true });
    const pickupEl = document.getElementById('pickup');
    const pickupText = row.address || row.name || '';
    if (pickupEl && pickupText) pickupEl.value = pickupText;
    const notesEl = document.getElementById('notes');
    if (notesEl) {
      const cfg = PLACE_KINDS[kind];
      notesEl.value = `توصيل من ${cfg.title} — ${row.name}`;
    }
    if (typeof updatePriceBar === 'function') updatePriceBar();
    toast('جهّزنا طلب التوصيل — أكمل بياناتك للتأكيد');
  }, 60);
}

/* ============================================================
   Wiring — all event listeners attached once on DOMContentLoaded,
   after app.js's own init() has already run (script order in
   index.html: config.js → app.js → market.js → places.js).
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('soonCardRestaurants')?.addEventListener('click', () => openPlaces('restaurants'));
  document.getElementById('soonCardMarkets')?.addEventListener('click', () => openPlaces('markets'));
  document.getElementById('soonCardFutureOffice')?.addEventListener('click', openFutureOffice);

  document.querySelectorAll('#plcTabs [data-plc-kind]').forEach((btn) => {
    btn.addEventListener('click', () => switchPlacesTab(btn.dataset.plcKind));
  });

  document.getElementById('plcDetailBackBtn')?.addEventListener('click', () => {
    if (placesState.detailBackTarget === 'home') {
      backToHome();
    } else {
      showView('places');
      sheet.setSnap('full');
    }
    haptic();
  });

  document.getElementById('plcCallBtn')?.addEventListener('click', (e) => {
    if (e.currentTarget.classList.contains('is-disabled')) { e.preventDefault(); toast('رقم الهاتف غير متاح حالياً'); }
  });
});
