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
function renderPlaceCard(kind, row) {
  placesState.rowsCache[row.id] = row;
  const img = row.image_url;
  const cfg = PLACE_KINDS[kind];
  return `
    <button type="button" class="plc-card" data-place-row-id="${escapeHtmlAttr(row.id)}">
      <span class="plc-card-img">
        ${img ? `<img src="${escapeHtmlAttr(img)}" alt="" loading="lazy">` : `<span class="plc-card-img-ph">${cfg.emptyIcon}</span>`}
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
function renderPlaceDetail(kind, row) {
  const cfg = PLACE_KINDS[kind];

  const hero = document.getElementById('plcDetailHero');
  const heroPh = document.getElementById('plcDetailHeroPh');
  if (row.image_url) {
    hero.style.backgroundImage = `url("${row.image_url.replace(/"/g, '')}")`;
    hero.classList.add('has-img');
    if (heroPh) heroPh.hidden = true;
  } else {
    hero.style.backgroundImage = '';
    hero.classList.remove('has-img');
    if (heroPh) { heroPh.hidden = false; heroPh.textContent = cfg.emptyIcon; }
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
}

function requestPlaceDelivery(kind, row) {
  // The place IS the pickup here — an explicit, manual choice — so GPS
  // must not replace it. Same rule app.js already applies when the
  // customer taps the map or drags the pin: stop live GPS following
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
    const pickupEl = document.getElementById('pickup');
    const pickupText = row.address || row.name || '';
    // Always use the place as pickup, not only when #pickup is empty:
    // GPS has usually already filled it with the customer's own address.
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
