/* ============================================================
   خدمات يمّك — Local Services section
   ------------------------------------------------------------
   Own, additive, self-contained feature. Reads ONLY three
   existing Supabase tables — local_service_sections (16 rows),
   local_service_categories, local_service_providers — with no
   new tables, no migrations, no invented/placeholder data.

   Reuses ONLY existing globals already defined in app.js:
   supabaseClient, showView, backToHome, haptic, escapeHtmlText,
   escapeHtmlAttr — exactly the same pattern market.js and
   places.js already use. Nothing here is redefined, and nothing
   in app.js / market.js / places.js / config.js is touched.
   No GPS, no trip_requests, no RPCs, no driver logic.

   One sheet-view ("yammakServices" in index.html) with 4 internal
   levels toggled purely by hiding/showing plain <div>s — no bottom
   sheet, no swipe-up, no horizontal scroll at any level:
     1) sections    — 16 cards, 2-column grid
     2) categories  — categories of the chosen section, 2-column grid
     3) providers   — real providers of the chosen category, 2-column
                      grid of cards (image/name/address) — "قريباً"
                      shown whenever a category has zero active rows
     4) providerDetail — full details of one provider (image, name,
                      details, phone, address, hours) + call action
   ============================================================ */

const YSVC_ICON_PLACEHOLDER = '🧰';

const ysvcState = {
  level: 'sections',
  section: null,
  category: null,
  provider: null,
};

/* ---- Level switching (within the "yammakServices" sheet-view only) ---- */
function ysvcShowLevel(level) {
  ysvcState.level = level;
  document.querySelectorAll('.sheet-view[data-view="yammakServices"] [data-ysvc-level]').forEach((el) => {
    el.hidden = el.dataset.ysvcLevel !== level;
  });

  const titleEl = document.getElementById('ysvcTitle');
  const introEl = document.getElementById('ysvcIntro');

  if (level === 'sections') {
    if (titleEl) titleEl.textContent = 'خدمات يمّك';
    if (introEl) { introEl.hidden = false; introEl.textContent = 'تحتاج خدمة؟ يمّك يوصلك إلها.'; }
  } else if (level === 'categories') {
    if (titleEl) titleEl.textContent = ysvcState.section ? ysvcState.section.label : 'خدمات يمّك';
    if (introEl) { introEl.hidden = false; introEl.textContent = 'اختر الفئة المطلوبة وشوف مزودي الخدمة القريبين منك.'; }
  } else if (level === 'providers') {
    if (titleEl) titleEl.textContent = ysvcState.category ? ysvcState.category.label : 'مزودو الخدمة';
    if (introEl) introEl.hidden = true;
  } else if (level === 'providerDetail') {
    if (titleEl) titleEl.textContent = ysvcState.provider ? ysvcState.provider.name : '—';
    if (introEl) introEl.hidden = true;
  }

  const scrollEl = document.getElementById('sheetScroll');
  if (scrollEl) scrollEl.scrollTop = 0;
}

/* ---- Back button — one clear step back at a time; only exits to
   Home from the top level ("sections"), reusing backToHome() exactly
   as every other view does. ---- */
function ysvcBack() {
  if (ysvcState.level === 'providerDetail') {
    ysvcShowLevel('providers');
  } else if (ysvcState.level === 'providers') {
    ysvcState.category = null;
    ysvcShowLevel('categories');
  } else if (ysvcState.level === 'categories') {
    ysvcState.section = null;
    ysvcShowLevel('sections');
  } else {
    backToHome();
  }
}

/* ---- Entry point — wired to #soonCardYammakServices on Home.
   Mirrors openPlaces()/openPlaceDetail() in places.js exactly:
   showView() then sheet.setSnap('full') then haptic(). ---- */
function openYammakServices() {
  ysvcState.section = null;
  ysvcState.category = null;
  ysvcState.provider = null;
  showView('yammakServices');
  sheet.setSnap('full');
  ysvcShowLevel('sections');
  haptic();
  ysvcLoadSections();
}

/* ---- Level 1: الأقسام الـ16 ---- */
async function ysvcLoadSections() {
  const grid = document.getElementById('ysvcSectionsGrid');
  const empty = document.getElementById('ysvcSectionsEmpty');
  if (!grid) return;
  grid.innerHTML = '';
  if (empty) empty.hidden = true;

  try {
    const { data, error } = await supabaseClient
      .from('local_service_sections')
      .select('id, key, label, icon')
      .eq('active', true)
      .order('sort_order', { ascending: true });

    if (error || !data || data.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }

    grid.innerHTML = data.map((row) => `
      <button type="button" class="soon-card soon-card-clickable" data-ysvc-section-id="${escapeHtmlAttr(row.id)}">
        <span class="soon-ic">${escapeHtmlText(row.icon || YSVC_ICON_PLACEHOLDER)}</span>
        <span class="soon-label">${escapeHtmlText(row.label)}</span>
      </button>
    `).join('');

    grid.querySelectorAll('[data-ysvc-section-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = data.find((r) => String(r.id) === String(btn.dataset.ysvcSectionId));
        if (!row) return;
        ysvcState.section = row;
        ysvcState.category = null;
        if (typeof haptic === 'function') haptic();
        ysvcShowLevel('categories');
        ysvcLoadCategories(row.id);
      });
    });
  } catch (err) {
    console.error('ysvcLoadSections failed', err);
    if (empty) empty.hidden = false;
  }
}

/* ---- Level 2: فئات القسم المختار ---- */
async function ysvcLoadCategories(sectionId) {
  const grid = document.getElementById('ysvcCategoriesGrid');
  const empty = document.getElementById('ysvcCategoriesEmpty');
  if (!grid) return;
  grid.innerHTML = '';
  if (empty) empty.hidden = true;

  const sectionIcon = (ysvcState.section && ysvcState.section.icon) || YSVC_ICON_PLACEHOLDER;

  try {
    const { data, error } = await supabaseClient
      .from('local_service_categories')
      .select('id, label')
      .eq('section_id', sectionId)
      .eq('active', true)
      .order('sort_order', { ascending: true });

    if (error || !data || data.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }

    grid.innerHTML = data.map((row) => `
      <button type="button" class="soon-card soon-card-clickable" data-ysvc-category-id="${escapeHtmlAttr(row.id)}">
        <span class="soon-ic">${escapeHtmlText(sectionIcon)}</span>
        <span class="soon-label">${escapeHtmlText(row.label)}</span>
      </button>
    `).join('');

    grid.querySelectorAll('[data-ysvc-category-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = data.find((r) => String(r.id) === String(btn.dataset.ysvcCategoryId));
        if (!row) return;
        ysvcState.category = row;
        if (typeof haptic === 'function') haptic();
        ysvcShowLevel('providers');
        ysvcLoadProviders(row.id);
      });
    });
  } catch (err) {
    console.error('ysvcLoadCategories failed', err);
    if (empty) empty.hidden = false;
  }
}

/* ---- Level 3: مزودو الخدمة الحقيقيون للفئة المختارة —
   card image fallback reuses placeImgFallback(imgEl, emptyIcon)
   from places.js as-is (it's already generic, no place-specific
   logic inside it) instead of redefining the same behaviour. ---- */
async function ysvcLoadProviders(categoryId) {
  const grid = document.getElementById('ysvcProvidersGrid');
  const empty = document.getElementById('ysvcProvidersEmpty');
  if (!grid) return;
  grid.innerHTML = '';
  if (empty) empty.hidden = true;

  try {
    const { data, error } = await supabaseClient
      .from('local_service_providers')
      .select('id, image_url, name, details, phone, address, hours_text, lat, lng')
      .eq('category_id', categoryId)
      .eq('active', true)
      .order('sort_order', { ascending: true });

    if (error || !data || data.length === 0) {
      if (empty) empty.hidden = false; // "قريباً" — no invented providers
      return;
    }

    // Same card shape/markup as renderPlaceCard() in places.js
    // (image w/ onerror fallback, title, hours meta) — no category
    // chip here since every card in this grid already belongs to the
    // one category the customer just picked.
    grid.innerHTML = data.map((row) => `
      <button type="button" class="plc-card" data-ysvc-provider-id="${escapeHtmlAttr(row.id)}">
        <span class="plc-card-img">
          ${row.image_url
            ? `<img src="${escapeHtmlAttr(row.image_url)}" alt="" loading="lazy" onerror="placeImgFallback(this, '${YSVC_ICON_PLACEHOLDER}')">`
            : `<span class="plc-card-img-ph">${YSVC_ICON_PLACEHOLDER}</span>`}
        </span>
        <span class="plc-card-body">
          <b class="plc-card-title">${escapeHtmlText(row.name)}</b>
          ${row.hours_text ? `<span class="plc-card-meta">🕒 ${escapeHtmlText(row.hours_text)}</span>` : ''}
        </span>
      </button>
    `).join('');

    grid.querySelectorAll('[data-ysvc-provider-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = data.find((r) => String(r.id) === String(btn.dataset.ysvcProviderId));
        if (!row) return;
        ysvcState.provider = row;
        if (typeof haptic === 'function') haptic();
        ysvcShowLevel('providerDetail');
        ysvcRenderProviderDetail(row);
      });
    });
  } catch (err) {
    console.error('ysvcLoadProviders failed', err);
    if (empty) empty.hidden = false;
  }
}

/* ---- Level 4: تفاصيل مزود الخدمة — same Image()-preload-before-
   background-swap technique as renderPlaceDetail() in places.js,
   including the token guard against a slow older load landing after
   the customer has already opened a different provider. ---- */
let ysvcDetailImgToken = 0;
function ysvcRenderProviderDetail(row) {
  const hero = document.getElementById('ysvcDetailHero');
  const heroPh = document.getElementById('ysvcDetailHeroPh');
  const myImgToken = ++ysvcDetailImgToken;
  const showHeroEmpty = () => {
    if (!hero) return;
    hero.style.backgroundImage = '';
    if (heroPh) heroPh.hidden = false;
  };
  if (hero) {
    if (row.image_url) {
      const preload = new Image();
      preload.onload = () => {
        if (myImgToken !== ysvcDetailImgToken) return; // فُتح مزود آخر قبل اكتمال هذا التحميل
        hero.style.backgroundImage = `url("${row.image_url.replace(/"/g, '')}")`;
        if (heroPh) heroPh.hidden = true;
      };
      preload.onerror = () => {
        if (myImgToken !== ysvcDetailImgToken) return;
        showHeroEmpty();
      };
      preload.src = row.image_url;
    } else {
      showHeroEmpty();
    }
  }

  const nameEl = document.getElementById('ysvcDetailName');
  if (nameEl) nameEl.textContent = row.name || '—';

  const catEl = document.getElementById('ysvcDetailCategory');
  if (catEl) {
    if (ysvcState.category && ysvcState.category.label) {
      catEl.textContent = ysvcState.category.label;
      catEl.hidden = false;
    } else {
      catEl.hidden = true;
    }
  }

  const descEl = document.getElementById('ysvcDetailDesc');
  if (descEl) {
    if (row.details) { descEl.textContent = row.details; descEl.hidden = false; }
    else { descEl.textContent = ''; descEl.hidden = true; }
  }

  const hoursRow = document.getElementById('ysvcDetailHoursRow');
  const hoursEl = document.getElementById('ysvcDetailHours');
  if (hoursRow) {
    if (row.hours_text) { hoursEl.textContent = row.hours_text; hoursRow.hidden = false; }
    else hoursRow.hidden = true;
  }

  const addrRow = document.getElementById('ysvcDetailAddressRow');
  const addrEl = document.getElementById('ysvcDetailAddress');
  if (addrRow) {
    if (row.address) { addrEl.textContent = row.address; addrRow.hidden = false; }
    else addrRow.hidden = true;
  }

  const phoneRow = document.getElementById('ysvcDetailPhoneRow');
  const phoneEl = document.getElementById('ysvcDetailPhone');
  if (phoneRow) {
    if (row.phone) { phoneEl.textContent = row.phone; phoneRow.hidden = false; }
    else phoneRow.hidden = true;
  }

  const deliveryBtn = ysvcEnsureDeliveryButton();
  if (deliveryBtn) deliveryBtn.onclick = () => ysvcRequestDelivery(row);

  const callBtn = document.getElementById('ysvcCallBtn');
  if (callBtn) {
    const cleanTel = (row.phone || '').replace(/[^\d+]/g, '');
    if (cleanTel) {
      callBtn.href = `tel:${cleanTel}`;
      callBtn.classList.remove('is-disabled');
    } else {
      callBtn.href = '#';
      callBtn.classList.add('is-disabled');
    }
  }
}

/* ---- طلب توصيل من مزود خدمة حقيقي — نفس نظام الدليفري الحالي
   (نموذج خدمة courier → اختيار سائق → submit_trip_request). الاستلام
   من إحداثيات المزود الحقيقية (local_service_providers.lat/lng) وليس
   من موقع الزبون؛ مزود بلا إحداثيات لا يمكن الطلب منه. ---- */
function ysvcEnsureDeliveryButton() {
  let btn = document.getElementById('ysvcDeliveryBtn');
  if (btn) return btn;
  const actions = document.getElementById('ysvcDetailActions');
  if (!actions) return null;
  btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'ysvcDeliveryBtn';
  btn.className = 'app-btn secondary plc-delivery-btn';
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="7" cy="18" r="1.6" stroke="currentColor" stroke-width="1.4"/><circle cx="17.5" cy="18" r="1.6" stroke="currentColor" stroke-width="1.4"/></svg> اطلب توصيل';
  actions.appendChild(btn);
  return btn;
}

function ysvcRequestDelivery(row) {
  const lat = row && row.lat != null ? Number(row.lat) : NaN;
  const lng = row && row.lng != null ? Number(row.lng) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    toast('لا يمكن طلب توصيل من هذا المزود حالياً — موقعه غير محدد بعد');
    return;
  }

  // The provider IS the pickup — an explicit choice — so live GPS must
  // not replace it (same handling as requestPlaceDelivery in places.js).
  if (typeof stopGpsWatch === 'function') stopGpsWatch();
  const prevAutoLocate = state.autoLocateAttempted;
  state.autoLocateAttempted = true;
  try {
    openBooking('courier');
  } finally {
    state.autoLocateAttempted = prevAutoLocate;
  }
  setTimeout(() => {
    setPickup(lat, lng, { reverseGeocode: false, fly: true, animate: true });
    const pickupEl = document.getElementById('pickup');
    const pickupText = row.address || row.name || '';
    if (pickupEl && pickupText) pickupEl.value = pickupText;
    const notesEl = document.getElementById('notes');
    if (notesEl) notesEl.value = `توصيل من خدمات يمّك — ${row.name}`.slice(0, 480);
    if (typeof updatePriceBar === 'function') updatePriceBar();
    toast('جهّزنا طلب التوصيل — أكمل بياناتك للتأكيد');
  }, 60);
}

/* ---- Home tile badge — real active-section count, same pattern as
   updatePlacesBadge() in app.js for the restaurants/markets/future
   office tiles; leaves the static "قريباً" text as-is on any error. ---- */
async function ysvcUpdateHomeBadge() {
  const badge = document.getElementById('soonBadgeYammakServices');
  if (!badge) return;
  try {
    const { count, error } = await supabaseClient
      .from('local_service_sections')
      .select('id', { count: 'exact', head: true })
      .eq('active', true);
    if (error || !count) return;
    badge.textContent = `${count} قسم`;
  } catch (err) {
    console.error('ysvcUpdateHomeBadge failed', err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const homeBtn = document.getElementById('soonCardYammakServices');
  if (homeBtn) homeBtn.addEventListener('click', openYammakServices);

  const backBtn = document.getElementById('ysvcBackBtn');
  if (backBtn) backBtn.addEventListener('click', ysvcBack);

  // Same disabled-call-button guard as #plcCallBtn in places.js.
  document.getElementById('ysvcCallBtn')?.addEventListener('click', (e) => {
    if (e.currentTarget.classList.contains('is-disabled')) { e.preventDefault(); toast('رقم الهاتف غير متاح حالياً'); }
  });

  ysvcUpdateHomeBadge();
});
