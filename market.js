// =============================================================
// سوق يمّك (Yammak Market) — customer-facing marketplace shell.
// Additive-only file, loaded AFTER app.js/config.js in index.html.
// Reuses (never redefines) the following globals already defined in
// app.js: supabaseClient, state, sheet, showView, backToHome, haptic,
// toast, escapeHtml, escapeHtmlAttr, openBooking, setPickup,
// updatePriceBar, getSavedProfile, normalizeIraqiPhoneForWhatsapp,
// BUSINESS_WHATSAPP_NUMBER, WA_ICON_SVG.
//
// Backend contract (see migration_market.sql — run once in the
// Supabase SQL editor, same way every other migration_*.sql file in
// this project is applied):
//   - market_categories        (public read)
//   - market_listings          (public read where status='active')
//   - create_market_listing()  RPC — the only way to publish a new ad
//   - get_my_market_listings() RPC — phone-scoped, same trust model as
//                               get_trip_request_status(): possession
//                               of the phone number used at posting
//                               time, not full authentication.
//   - update_market_listing_status() RPC — pause/resume/mark
//                               sold/react, also phone-scoped.
//   - delete_market_listing()  RPC — phone-scoped delete.
//   - Storage bucket "market-images" (public, anon insert allowed).
//
// No mock/fake data anywhere below: every list starts empty and is
// only ever filled from a real Supabase response. If a migration
// hasn't been run yet, calls simply fail/return empty and the existing
// empty-state markup is shown — never a fabricated listing.
// =============================================================

// Fallback categories — used ONLY until loadMarketCategories()
// successfully reads the real, admin-editable rows from
// market_categories (same pattern as SERVICES/VEHICLE_PHOTOS in
// app.js). Keys match the seed data in migration_market.sql exactly,
// so once the DB is reachable this fallback is never shown.
const MARKET_CATEGORIES_FALLBACK = [
  { key: 'electronics', label: 'إلكترونيات',   icon: '💻', sort_order: 1 },
  { key: 'cars',        label: 'سيارات',        icon: '🚗', sort_order: 2 },
  { key: 'furniture',   label: 'أثاث',          icon: '🛋️', sort_order: 3 },
  { key: 'realestate',  label: 'عقارات',        icon: '🏠', sort_order: 4 },
  { key: 'fashion',     label: 'ملابس',         icon: '👕', sort_order: 5 },
  { key: 'tools',       label: 'أدوات ومعدات',  icon: '🛠️', sort_order: 6 },
  { key: 'books',       label: 'كتب وقرطاسية',  icon: '📚', sort_order: 7 },
  { key: 'other',       label: 'أخرى',          icon: '🧩', sort_order: 8 },
];

const MARKET_PHONE_KEY = 'mustaqbali_market_phone';
const MARKET_MAX_PHOTOS = 5;

const marketState = {
  categories: [],
  listingsCache: {},   // id -> row, filled as cards render so detail/my-ads never need a second fetch
  currentCategoryKey: null,
  currentSearch: '',
  myAdsStatus: 'active',
  myAdsRows: { active: [], paused: [], sold: [] },
  myAdsPhone: '',
  myAdsError: false,    // true when the last get_my_market_listings call failed (≠ "no ads")
  wizardStep: 1,
  photos: [],           // [{file, previewUrl}]
};

function formatIQD(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('en-US') + ' د.ع';
}

function marketCategoryLabel(key) {
  const cat = marketState.categories.find((c) => c.key === key);
  return cat ? cat.label : (key || '—');
}

function getMarketPhone() {
  const saved = getSavedProfile()?.phone;
  if (saved) return saved;
  try { return localStorage.getItem(MARKET_PHONE_KEY) || ''; } catch { return ''; }
}

function rememberMarketPhone(phone) {
  try { localStorage.setItem(MARKET_PHONE_KEY, phone); } catch { /* non-critical */ }
}

// Search text goes into an ILIKE pattern: neutralize the LIKE wildcards (%, _)
// and the escape character itself (\) so the customer's text always matches
// literally. The surrounding %…% added by the caller stay real wildcards.
function escapeMarketLike(text) {
  return String(text).replace(/[\\%_]/g, '\\$&');
}

// "Failed to load" state — deliberately different from the "no ads yet" empty
// state, so a broken connection / backend is never presented as an empty market.
// Reuses the existing .mkt-empty look and app-btn classes: no HTML/CSS change.
const MARKET_LOAD_ERROR_TEXT = 'تعذّر تحميل الإعلانات الآن. تحقق من اتصالك بالإنترنت ثم أعد المحاولة.';

function buildMarketLoadError(id, retry) {
  const el = document.createElement('div');
  el.className = 'mkt-empty mkt-load-error';
  el.id = id;
  el.setAttribute('role', 'alert');
  el.innerHTML = `<span class="mkt-empty-ic">⚠️</span><p>${MARKET_LOAD_ERROR_TEXT}</p>`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'app-btn secondary';
  btn.textContent = 'إعادة المحاولة';
  btn.addEventListener('click', () => { haptic(); retry(); });
  el.appendChild(btn);
  return el;
}

function clearMarketLoadError(id) {
  document.getElementById(id)?.remove();
}

// For grids that have a separate "empty" element: hide it, clear the grid and
// show the error block right after the grid.
function showMarketGridLoadError(grid, emptyEl, id, retry) {
  grid.innerHTML = '';
  if (emptyEl) emptyEl.hidden = true;
  clearMarketLoadError(id);
  grid.insertAdjacentElement('afterend', buildMarketLoadError(id, retry));
}

/* ============================================================
   Navigation
   ============================================================ */
function openMarket() {
  showView('market');
  sheet.setSnap('full');
  haptic();
  loadMarketCategories();
  loadMarketLatest();
}

function openMarketCategory(key, label, opts = {}) {
  marketState.currentCategoryKey = key || null;
  marketState.currentSearch = opts.search || '';
  document.getElementById('mktCatTitle').textContent = label || 'كل الإعلانات';
  showView('marketCategory');
  sheet.setSnap('full');
  haptic();
  renderMarketCatsScroll();
  loadCategoryListings();
}

function openMarketProduct(row) {
  marketState.listingsCache[row.id] = row;
  marketState.currentListingId = row.id;
  renderMarketProduct(row);
  showView('marketProduct');
  sheet.setSnap('full');
  haptic();
}

function openMarketMyAds() {
  showView('marketMyAds');
  sheet.setSnap('full');
  haptic();
  marketState.myAdsPhone = getMarketPhone();
  renderMyAdsPhoneGate();
}

function openMarketAddWizard() {
  resetMarketAddForm();
  showView('marketAdd');
  sheet.setSnap('full');
  haptic();
  // Prefill step-3 contact fields from the saved profile, exactly like
  // the ride-booking form does via applyProfileToBookingForm().
  const profile = getSavedProfile();
  if (profile) {
    const nameEl = document.getElementById('mktSellerName');
    const phoneEl = document.getElementById('mktSellerPhone');
    if (nameEl && !nameEl.value) nameEl.value = profile.name || '';
    if (phoneEl && !phoneEl.value) phoneEl.value = profile.phone || '';
  }
}

/* ============================================================
   Categories
   ============================================================ */
async function loadMarketCategories() {
  try {
    const { data, error } = await supabaseClient
      .from('market_categories')
      .select('key,label,icon,sort_order')
      .order('sort_order', { ascending: true });
    marketState.categories = (!error && data && data.length) ? data : MARKET_CATEGORIES_FALLBACK;
  } catch {
    marketState.categories = MARKET_CATEGORIES_FALLBACK;
  }
  renderMarketCatsGrid();
  renderMarketCatsScroll();
  populateMarketCategorySelect();
}

function renderMarketCatsGrid() {
  const wrap = document.getElementById('mktCatsGrid');
  if (!wrap) return;
  wrap.innerHTML = marketState.categories.map((cat) => `
    <button type="button" class="mkt-cat-card" data-cat="${escapeHtmlAttr(cat.key)}">
      <span class="mkt-cat-ic">${cat.icon || '🛍️'}</span>
      <span class="mkt-cat-label">${escapeHtml(cat.label)}</span>
    </button>
  `).join('');
  wrap.querySelectorAll('[data-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cat = marketState.categories.find((c) => c.key === btn.dataset.cat);
      openMarketCategory(btn.dataset.cat, cat?.label);
    });
  });
}

function renderMarketCatsScroll() {
  const wrap = document.getElementById('mktCatsScroll');
  if (!wrap) return;
  const chips = [{ key: null, label: 'الكل', icon: '🛍️' }, ...marketState.categories];
  wrap.innerHTML = chips.map((cat) => `
    <button type="button" class="mkt-chip ${marketState.currentCategoryKey === cat.key ? 'active' : ''}" data-cat="${escapeHtmlAttr(cat.key || '')}">
      <span>${cat.icon || ''}</span> ${escapeHtml(cat.label)}
    </button>
  `).join('');
  wrap.querySelectorAll('[data-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.cat || null;
      const cat = marketState.categories.find((c) => c.key === key);
      marketState.currentCategoryKey = key;
      marketState.currentSearch = '';
      document.getElementById('mktCatTitle').textContent = cat ? cat.label : 'كل الإعلانات';
      wrap.querySelectorAll('.mkt-chip').forEach((c) => c.classList.toggle('active', c === btn));
      loadCategoryListings();
      haptic();
    });
  });
}

function populateMarketCategorySelect() {
  const sel = document.getElementById('mktCategory');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="" disabled' + (current ? '' : ' selected') + '>اختر التصنيف</option>' +
    marketState.categories.map((cat) => `<option value="${escapeHtmlAttr(cat.key)}">${cat.icon || ''} ${escapeHtml(cat.label)}</option>`).join('');
  if (current) sel.value = current;
}

/* ============================================================
   Listings — browse / search
   ============================================================ */
// FIX (صور إعلانات السوق لا تظهر — image_urls فشل بصمت): <img> الحقيقية
// كانت بلا onerror، فإن فشل تحميل رابط الصورة (مثلاً رابط Storage غير
// صالح/محذوف) تبقى فارغة دون بديل. عند الفشل تُستبدل بنفس الحالة
// الفارغة المستخدمة أصلاً حين لا توجد صورة إطلاقاً (span.mkt-card-img-ph)
// — لا صورة وهمية، ولا تغيير على image_urls أو طريقة الرفع/التخزين.
function marketImgFallback(imgEl) {
  if (!imgEl) return;
  const ph = document.createElement('span');
  ph.className = 'mkt-card-img-ph';
  ph.textContent = '🛍️';
  imgEl.replaceWith(ph);
}

// نفس الفكرة لصورة واحدة داخل معرض صور صفحة المنتج (قد تحوي أكثر من
// صورة) — الصورة الفاشلة فقط تُستبدل بعنصر بديل صغير، بقية صور
// المعرض (إن وُجدت) تبقى كما هي دون تأثر.
function marketGalleryImgFallback(imgEl) {
  if (!imgEl) return;
  const ph = document.createElement('div');
  ph.className = 'mkt-gallery-ph';
  ph.textContent = '🛍️';
  imgEl.replaceWith(ph);
}

function renderListingCard(row) {
  marketState.listingsCache[row.id] = row;
  const img = Array.isArray(row.image_urls) && row.image_urls[0];
  return `
    <button type="button" class="mkt-card" data-listing-id="${escapeHtmlAttr(row.id)}">
      <span class="mkt-card-img">
        ${img ? `<img src="${escapeHtmlAttr(img)}" alt="" loading="lazy" onerror="marketImgFallback(this)">` : `<span class="mkt-card-img-ph">🛍️</span>`}
        ${row.condition === 'new' ? '<span class="mkt-card-tag">جديد</span>' : ''}
      </span>
      <span class="mkt-card-body">
        <b class="mkt-card-title">${escapeHtml(row.title)}</b>
        <span class="mkt-card-price">${formatIQD(row.price)}</span>
        <span class="mkt-card-loc">
          <svg viewBox="0 0 24 24" fill="none" width="11" height="11"><path d="M12 21s-6.5-5.7-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.3-6.5 11-6.5 11Z" stroke="currentColor" stroke-width="2"/></svg>
          ${escapeHtml(row.location_text || '—')}
        </span>
      </span>
    </button>
  `;
}

function wireListingCards(container, rows) {
  container.querySelectorAll('[data-listing-id]').forEach((card) => {
    card.addEventListener('click', () => {
      const row = rows.find((r) => String(r.id) === card.dataset.listingId);
      if (row) openMarketProduct(row);
      haptic();
    });
  });
}

async function loadMarketLatest() {
  const grid = document.getElementById('mktLatestGrid');
  const empty = document.getElementById('mktLatestEmpty');
  if (!grid || !empty) return;
  clearMarketLoadError('mktLatestGridError');
  try {
    const { data, error } = await supabaseClient
      .from('market_listings')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(12);
    if (error) throw error;
    if (!data || data.length === 0) {
      grid.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    grid.innerHTML = data.map(renderListingCard).join('');
    wireListingCards(grid, data);
  } catch (err) {
    console.error('loadMarketLatest failed', err);
    showMarketGridLoadError(grid, empty, 'mktLatestGridError', loadMarketLatest);
  }
}

async function loadCategoryListings() {
  const grid = document.getElementById('mktCatGrid');
  const empty = document.getElementById('mktCatEmpty');
  if (!grid || !empty) return;
  clearMarketLoadError('mktCatGridError');
  grid.innerHTML = '<div class="qs-skel"></div><div class="qs-skel"></div><div class="qs-skel"></div><div class="qs-skel"></div>';
  empty.hidden = true;
  try {
    let query = supabaseClient.from('market_listings').select('*').eq('status', 'active').order('created_at', { ascending: false }).limit(60);
    if (marketState.currentCategoryKey) query = query.eq('category_key', marketState.currentCategoryKey);
    if (marketState.currentSearch) query = query.ilike('title', `%${escapeMarketLike(marketState.currentSearch)}%`);
    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) {
      grid.innerHTML = '';
      empty.hidden = false;
      return;
    }
    grid.innerHTML = data.map(renderListingCard).join('');
    wireListingCards(grid, data);
  } catch (err) {
    console.error('loadCategoryListings failed', err);
    showMarketGridLoadError(grid, empty, 'mktCatGridError', loadCategoryListings);
  }
}

let marketSearchDebounce = null;
function handleMarketSearchInput(e) {
  const q = e.target.value.trim();
  clearTimeout(marketSearchDebounce);
  marketSearchDebounce = setTimeout(() => {
    if (!q) return;
    openMarketCategory(null, `نتائج البحث: "${q}"`, { search: q });
  }, 450);
}

/* ============================================================
   Product detail
   ============================================================ */
function renderMarketProduct(row) {
  const gallery = document.getElementById('mktProductGallery');
  const images = Array.isArray(row.image_urls) && row.image_urls.length ? row.image_urls : [];
  gallery.innerHTML = images.length
    ? `<div class="mkt-gallery-track">${images.map((u) => `<img src="${escapeHtmlAttr(u)}" alt="" loading="lazy" onerror="marketGalleryImgFallback(this)">`).join('')}</div>`
    : `<div class="mkt-gallery-ph">🛍️</div>`;

  document.getElementById('mktProductTitle').textContent = row.title || '—';
  document.getElementById('mktProductPrice').textContent = formatIQD(row.price);
  document.getElementById('mktProductCondition').textContent = row.condition === 'new' ? 'جديد' : 'مستخدم';
  document.getElementById('mktProductCategory').textContent = marketCategoryLabel(row.category_key);
  document.getElementById('mktProductDesc').textContent = row.description || 'لا يوجد وصف إضافي.';
  document.getElementById('mktProductLocation').querySelector('span').textContent = row.location_text || '—';
  document.getElementById('mktProductNumber').textContent = row.listing_number || '—';

  const contactBtn = document.getElementById('mktContactSellerBtn');
  const waTarget = normalizeIraqiPhoneForWhatsapp(row.seller_phone);
  if (waTarget) {
    const text = encodeURIComponent(
      `مرحباً، أنا مهتم بإعلانك على سوق يمّك\n` +
      `المنتج: ${row.title}\n` +
      `السعر: ${formatIQD(row.price)}\n` +
      `رقم الإعلان: ${row.listing_number || ''}`
    );
    contactBtn.href = `https://wa.me/${waTarget}?text=${text}`;
    contactBtn.classList.remove('is-disabled');
  } else {
    contactBtn.href = '#';
    contactBtn.classList.add('is-disabled');
  }

  const deliveryBtn = document.getElementById('mktRequestDeliveryBtn');
  deliveryBtn.onclick = () => requestMarketDelivery(row);
}

function requestMarketDelivery(row) {
  openBooking('courier');
  setTimeout(() => {
    if (row.location_lat && row.location_lng) {
      setPickup(Number(row.location_lat), Number(row.location_lng), { reverseGeocode: true, fly: true, animate: true });
    }
    const pickupEl = document.getElementById('pickup');
    if (pickupEl && !pickupEl.value) pickupEl.value = row.location_text || '';
    const notesEl = document.getElementById('notes');
    if (notesEl) notesEl.value = `توصيل من سوق يمّك — ${row.title} (إعلان #${row.listing_number || ''})`;
    if (typeof updatePriceBar === 'function') updatePriceBar();
    toast('جهّزنا طلب التوصيل — أكمل بياناتك للتأكيد');
  }, 60);
}

/* ============================================================
   My Ads (إعلاناتي) — phone-scoped, same trust model as order
   tracking: possession of the phone number used when the ad was
   published, not full authentication.
   ============================================================ */
function renderMyAdsPhoneGate() {
  const list = document.getElementById('mktMyAdsList');
  const empty = document.getElementById('mktMyAdsEmpty');
  if (!list) return;
  if (marketState.myAdsPhone) {
    empty.hidden = true;
    loadMyAds();
    return;
  }
  empty.hidden = true;
  list.innerHTML = `
    <div class="mkt-phone-gate">
      <p>أدخل رقم الهاتف الذي استخدمته عند نشر إعلاناتك</p>
      <div class="float-field">
        <input type="tel" id="mktMyAdsPhoneInput" placeholder=" " inputmode="tel" maxlength="20">
        <label for="mktMyAdsPhoneInput">رقم الهاتف</label>
      </div>
      <button type="button" class="app-btn" id="mktMyAdsPhoneBtn">عرض إعلاناتي</button>
    </div>
  `;
  document.getElementById('mktMyAdsPhoneBtn').addEventListener('click', () => {
    const val = document.getElementById('mktMyAdsPhoneInput').value.trim();
    if (!val) return;
    marketState.myAdsPhone = val;
    rememberMarketPhone(val);
    loadMyAds();
  });
}

async function loadMyAds() {
  const list = document.getElementById('mktMyAdsList');
  const empty = document.getElementById('mktMyAdsEmpty');
  if (!list || !marketState.myAdsPhone) return;
  list.innerHTML = '<div class="qs-skel"></div><div class="qs-skel"></div>';
  empty.hidden = true;
  marketState.myAdsError = false;
  try {
    const { data, error } = await supabaseClient.rpc('get_my_market_listings', { p_phone: marketState.myAdsPhone });
    if (error) throw error;
    const rows = data || [];
    marketState.myAdsRows = {
      active: rows.filter((r) => r.status === 'active'),
      paused: rows.filter((r) => r.status === 'paused'),
      sold: rows.filter((r) => r.status === 'sold'),
    };
  } catch (err) {
    console.error('loadMyAds failed', err);
    marketState.myAdsRows = { active: [], paused: [], sold: [] };
    marketState.myAdsError = true;
  }
  renderMyAdsList();
}

function renderMyAdsList() {
  const list = document.getElementById('mktMyAdsList');
  const empty = document.getElementById('mktMyAdsEmpty');
  if (!list) return;
  if (marketState.myAdsError) {
    list.innerHTML = '';
    if (empty) empty.hidden = true;
    list.appendChild(buildMarketLoadError('mktMyAdsListError', loadMyAds));
    return;
  }
  const rows = marketState.myAdsRows[marketState.myAdsStatus] || [];
  if (rows.length === 0) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = rows.map((row) => {
    const img = Array.isArray(row.image_urls) && row.image_urls[0];
    return `
    <div class="mkt-myad-card" data-listing-id="${escapeHtmlAttr(row.id)}">
      <span class="mkt-myad-img">${img ? `<img src="${escapeHtmlAttr(img)}" alt="" loading="lazy" onerror="marketImgFallback(this)">` : '<span class="mkt-card-img-ph">🛍️</span>'}</span>
      <span class="mkt-myad-body">
        <b>${escapeHtml(row.title)}</b>
        <span class="mkt-myad-price">${formatIQD(row.price)}</span>
        <span class="mkt-myad-date">${escapeHtml(row.listing_number || '')}</span>
      </span>
      <span class="mkt-myad-actions">
        ${row.status !== 'sold' ? `<button type="button" class="mkt-myad-act" data-act="${row.status === 'active' ? 'paused' : 'active'}">${row.status === 'active' ? 'إيقاف' : 'تنشيط'}</button>` : ''}
        ${row.status !== 'sold' ? `<button type="button" class="mkt-myad-act" data-act="sold">تم البيع</button>` : ''}
        <button type="button" class="mkt-myad-act mkt-myad-act-danger" data-act="delete">حذف</button>
      </span>
    </div>
  `;
  }).join('');

  list.querySelectorAll('.mkt-myad-card').forEach((card) => {
    const row = rows.find((r) => String(r.id) === card.dataset.listingId);
    card.querySelector('.mkt-myad-img').addEventListener('click', () => row && openMarketProduct(row));
    card.querySelector('.mkt-myad-body').addEventListener('click', () => row && openMarketProduct(row));
    card.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => handleMyAdAction(row, btn.dataset.act));
    });
  });
}

async function handleMyAdAction(row, action) {
  if (!row) return;
  if (action === 'delete') {
    if (!confirm('هل تريد حذف هذا الإعلان نهائياً؟')) return;
    try {
      const { error } = await supabaseClient.rpc('delete_market_listing', { p_id: row.id, p_phone: marketState.myAdsPhone });
      if (error) throw error;
      toast('تم حذف الإعلان');
    } catch (err) {
      console.error('delete_market_listing failed', err);
      toast('تعذّر حذف الإعلان');
      return;
    }
  } else {
    try {
      const { error } = await supabaseClient.rpc('update_market_listing_status', { p_id: row.id, p_phone: marketState.myAdsPhone, p_status: action });
      if (error) throw error;
      toast(action === 'sold' ? 'تم تحديد الإعلان كمباع' : action === 'active' ? 'تم تنشيط الإعلان' : 'تم إيقاف الإعلان');
    } catch (err) {
      console.error('update_market_listing_status failed', err);
      toast('تعذّر تحديث حالة الإعلان');
      return;
    }
  }
  haptic();
  loadMyAds();
}

function initMyAdsTabs() {
  const tabs = document.getElementById('mktMyAdsTabs');
  if (!tabs) return;
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mkt-status]');
    if (!btn) return;
    marketState.myAdsStatus = btn.dataset.mktStatus;
    tabs.querySelectorAll('.mkt-myads-tab').forEach((t) => t.classList.toggle('active', t === btn));
    renderMyAdsList();
    haptic();
  });
}

/* ============================================================
   Add Listing wizard (4 steps)
   ============================================================ */
function resetMarketAddForm() {
  marketState.wizardStep = 1;
  marketState.photos = [];
  const form = document.getElementById('mktAddForm');
  if (form) form.reset();
  renderMarketPhotoGrid();
  setMarketWizardStep(1);
  const msg = document.getElementById('mktAddMsg');
  if (msg) { msg.classList.remove('show', 'err'); msg.textContent = ''; }
  const submitBtn = document.getElementById('mktSubmitBtn');
  if (submitBtn) submitBtn.disabled = true;
  const consent = document.getElementById('mktConsentCheck');
  if (consent) consent.checked = false;
}

function renderMarketPhotoGrid() {
  const grid = document.getElementById('mktPhotoGrid');
  const addBtn = document.getElementById('mktPhotoAddBtn');
  if (!grid || !addBtn) return;
  grid.querySelectorAll('.mkt-photo-thumb').forEach((el) => el.remove());
  marketState.photos.forEach((p, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'mkt-photo-thumb';
    thumb.innerHTML = `<img src="${p.previewUrl}" alt=""><button type="button" class="mkt-photo-remove" data-idx="${idx}" aria-label="إزالة">×</button>`;
    grid.insertBefore(thumb, addBtn);
  });
  addBtn.style.display = marketState.photos.length >= MARKET_MAX_PHOTOS ? 'none' : '';
  grid.querySelectorAll('.mkt-photo-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      URL.revokeObjectURL(marketState.photos[idx].previewUrl);
      marketState.photos.splice(idx, 1);
      renderMarketPhotoGrid();
    });
  });
}

function handleMarketPhotoInput(e) {
  const files = Array.from(e.target.files || []);
  const room = MARKET_MAX_PHOTOS - marketState.photos.length;
  files.slice(0, room).forEach((file) => {
    if (!file.type.startsWith('image/')) return;
    marketState.photos.push({ file, previewUrl: URL.createObjectURL(file) });
  });
  e.target.value = '';
  renderMarketPhotoGrid();
}

function setMarketWizardStep(n) {
  marketState.wizardStep = n;
  document.querySelectorAll('[data-mkt-step]').forEach((el) => {
    el.hidden = Number(el.dataset.mktStep) !== n;
  });
  document.querySelectorAll('[data-mkt-wp-step]').forEach((el) => {
    const step = Number(el.dataset.mktWpStep);
    el.classList.toggle('active', step === n);
    el.classList.toggle('done', step < n);
  });
  document.getElementById('mktWizardBackBtn').hidden = (n === 1);
  document.getElementById('mktWizardNextBtn').hidden = (n === 4);
  if (n === 4) renderMarketConfirmCard();
  const scroll = document.getElementById('sheetScroll');
  if (scroll) scroll.scrollTop = 0;
}

function validateMarketStep(n) {
  if (n === 2) {
    const title = document.getElementById('mktTitle').value.trim();
    const category = document.getElementById('mktCategory').value;
    const price = document.getElementById('mktPrice').value;
    const location = document.getElementById('mktLocation').value.trim();
    if (!title || !category || price === '' || Number(price) < 0 || !location) {
      toast('يرجى تعبئة اسم المنتج والتصنيف والسعر والموقع');
      return false;
    }
  }
  if (n === 3) {
    const name = document.getElementById('mktSellerName').value.trim();
    const phone = document.getElementById('mktSellerPhone').value.trim();
    if (!name || !phone) {
      toast('يرجى إدخال اسمك ورقم هاتفك');
      return false;
    }
  }
  return true;
}

function renderMarketConfirmCard() {
  const card = document.getElementById('mktConfirmCard');
  if (!card) return;
  const title = document.getElementById('mktTitle').value.trim();
  const category = document.getElementById('mktCategory').value;
  const price = document.getElementById('mktPrice').value;
  const condition = document.querySelector('input[name="mktCondition"]:checked')?.value;
  const location = document.getElementById('mktLocation').value.trim();
  const name = document.getElementById('mktSellerName').value.trim();
  const phone = document.getElementById('mktSellerPhone').value.trim();

  card.innerHTML = `
    <div class="confirm-summary-head">
      <span class="confirm-summary-icon" aria-hidden="true">${marketState.categories.find((c) => c.key === category)?.icon || '🛍️'}</span>
      <div class="confirm-summary-head-text">
        <b>${escapeHtml(title) || '—'}</b>
        <span>${escapeHtml(marketCategoryLabel(category))}</span>
      </div>
    </div>
    <div class="confirm-summary-rows">
      <div class="csr-row"><span>السعر</span><b>${formatIQD(price)}</b></div>
      <div class="csr-row"><span>الحالة</span><b>${condition === 'new' ? 'جديد' : 'مستخدم'}</b></div>
      <div class="csr-row"><span>الموقع</span><b>${escapeHtml(location) || '—'}</b></div>
      <div class="csr-row"><span>البائع</span><b>${escapeHtml(name) || '—'}</b></div>
      <div class="csr-row"><span>الهاتف</span><b>${escapeHtml(phone) || '—'}</b></div>
      <div class="csr-row"><span>الصور</span><b>${marketState.photos.length} صورة</b></div>
    </div>
  `;
}

// Any photo that fails to upload (or comes back without a public URL) aborts the
// whole publish: the caller never reaches create_market_listing, so an ad is never
// published with fewer photos than the seller chose, and the seller is told.
function marketPhotoUploadError(cause) {
  const err = new Error('market photo upload failed');
  err.code = 'MARKET_PHOTO_UPLOAD';
  err.cause = cause;
  return err;
}

async function uploadMarketPhotos() {
  const urls = [];
  for (const p of marketState.photos) {
    const ext = (p.file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    let uploadError = null;
    try {
      const { error } = await supabaseClient.storage.from('market-images').upload(path, p.file, { upsert: false });
      uploadError = error || null;
    } catch (err) {
      uploadError = err;
    }
    if (uploadError) {
      console.error('market photo upload failed', uploadError);
      throw marketPhotoUploadError(uploadError);
    }
    const { data: pub } = supabaseClient.storage.from('market-images').getPublicUrl(path);
    if (!pub?.publicUrl) throw marketPhotoUploadError(new Error('no public URL for uploaded photo'));
    urls.push(pub.publicUrl);
  }
  return urls;
}

async function handleMarketAddSubmit(e) {
  e.preventDefault();
  const submitBtn = document.getElementById('mktSubmitBtn');
  const msg = document.getElementById('mktAddMsg');
  if (!document.getElementById('mktConsentCheck').checked) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'جارٍ النشر...';
  msg.classList.remove('show', 'err');

  try {
    const imageUrls = marketState.photos.length ? await uploadMarketPhotos() : [];

    const payload = {
      p_seller_name: document.getElementById('mktSellerName').value.trim(),
      p_seller_phone: document.getElementById('mktSellerPhone').value.trim(),
      p_category_key: document.getElementById('mktCategory').value,
      p_title: document.getElementById('mktTitle').value.trim(),
      p_description: document.getElementById('mktDescription').value.trim() || null,
      p_price: Number(document.getElementById('mktPrice').value),
      p_condition: document.querySelector('input[name="mktCondition"]:checked')?.value || 'used',
      p_location_text: document.getElementById('mktLocation').value.trim(),
      // No map picker in the add-listing wizard (location is a free-text
      // field only, step 2) — coordinates are intentionally left null
      // rather than reusing the unrelated ride-booking pickup pin.
      p_location_lat: null,
      p_location_lng: null,
      p_image_urls: imageUrls,
    };

    const { data, error } = await supabaseClient.rpc('create_market_listing', payload);
    if (error) throw error;

    rememberMarketPhone(payload.p_seller_phone);
    marketState.myAdsPhone = payload.p_seller_phone;
    marketState.lastPublishedId = Array.isArray(data) ? data[0]?.id : data?.id;

    showView('marketDone');
    sheet.setSnap('full');
    haptic();
  } catch (err) {
    if (err && err.code === 'MARKET_PHOTO_UPLOAD') {
      console.error('market publish aborted — photo upload failed', err);
      msg.textContent = 'فشل رفع الصور، لذلك لم يُنشر إعلانك. تحقق من اتصالك ثم أعد المحاولة، أو أزل الصور وانشر الإعلان بدونها.';
    } else {
      console.error('create_market_listing failed', err);
      msg.textContent = 'تعذّر نشر الإعلان، يرجى المحاولة مرة أخرى.';
    }
    msg.classList.add('show', 'err');
  } finally {
    submitBtn.disabled = !document.getElementById('mktConsentCheck').checked;
    submitBtn.textContent = 'نشر الإعلان';
  }
}

/* ============================================================
   Wiring — all event listeners attached once on DOMContentLoaded,
   after app.js's own init() has already run (script order in
   index.html: config.js → app.js → market.js).
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('marketBannerBtn')?.addEventListener('click', openMarket);
  document.getElementById('moreMarketBtn')?.addEventListener('click', openMarket);
  document.getElementById('accountMarketAdsBtn')?.addEventListener('click', openMarketMyAds);
  document.getElementById('mktMyAdsBtn')?.addEventListener('click', openMarketMyAds);
  document.getElementById('mktViewAllCats')?.addEventListener('click', () => openMarketCategory(null, 'كل الإعلانات'));
  document.getElementById('mktHeroBtn')?.addEventListener('click', openMarketAddWizard);
  document.getElementById('mktAddFabBtn')?.addEventListener('click', openMarketAddWizard);
  document.getElementById('mktMyAdsAddBtn')?.addEventListener('click', openMarketAddWizard);
  document.getElementById('mktFilterBtn')?.addEventListener('click', () => document.getElementById('mktSearchInput')?.focus());
  document.getElementById('mktSearchInput')?.addEventListener('input', handleMarketSearchInput);

  document.querySelectorAll('[data-back="market"]').forEach((b) => b.addEventListener('click', () => { showView('market'); sheet.setSnap('full'); haptic(); }));

  document.getElementById('mktContactSellerBtn')?.addEventListener('click', (e) => {
    if (e.currentTarget.classList.contains('is-disabled')) { e.preventDefault(); toast('رقم البائع غير متاح حالياً'); }
  });

  initMyAdsTabs();

  document.getElementById('mktPhotoAddBtn')?.addEventListener('click', () => document.getElementById('mktPhotoInput')?.click());
  document.getElementById('mktPhotoInput')?.addEventListener('change', handleMarketPhotoInput);

  document.getElementById('mktWizardNextBtn')?.addEventListener('click', () => {
    if (!validateMarketStep(marketState.wizardStep)) return;
    if (marketState.wizardStep < 4) setMarketWizardStep(marketState.wizardStep + 1);
    haptic();
  });
  document.getElementById('mktWizardBackBtn')?.addEventListener('click', () => {
    if (marketState.wizardStep > 1) setMarketWizardStep(marketState.wizardStep - 1);
    haptic();
  });
  document.getElementById('mktConsentCheck')?.addEventListener('change', (e) => {
    document.getElementById('mktSubmitBtn').disabled = !e.target.checked;
  });
  document.getElementById('mktAddForm')?.addEventListener('submit', handleMarketAddSubmit);

  document.getElementById('mktDoneViewBtn')?.addEventListener('click', () => {
    openMarketMyAds();
  });
  document.getElementById('mktDoneHomeBtn')?.addEventListener('click', openMarket);

  populateMarketCategorySelect();
});
