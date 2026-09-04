// Yammak — Customer App Shell (PWA) — v2 (Careem/Uber-grade)
// Same backend contract: submit_trip_request RPC + the new
// get_trip_request_status RPC for live status polling (see schema.sql v1.1).

// Fallback defaults used only until loadServicePrices() successfully
// fetches the real, admin-editable prices from Supabase (service_prices
// table). These numbers are never shown to the customer as final unless
// the fetch fails — see loadServicePrices().
const SERVICES = {
  taxi:      { label: 'تكسي',            base: 3000,  perKm: 500, icon: 'taxi' },
  private:   { label: 'خصوصي',           base: 8000,  perKm: 800, icon: 'private' },
  courier:   { label: 'دليفري',          base: 2000,  perKm: 400, icon: 'courier' },
  intercity: { label: 'بين المحافظات',    base: 20000, perKm: 350, icon: 'intercity' },
  cargo:     { label: 'حمل',             base: 6000,  perKm: 700, icon: 'cargo' },
  starx:     { label: 'نقل نفرات',        base: 4000,  perKm: 550, icon: 'starx' },
};

// Stage — real vehicle photos for the service list/switch, replacing
// the flat SVG car icons. Each service maps to a local image under
// assets/vehicles/ (ship these files with the app — no network call,
// works offline like the rest of the shell). If a photo file is
// missing (e.g. before you've dropped the real photos in), the <img>
// onerror handler below falls back to the old ICONS SVG for that one
// service only, so the UI never breaks — nothing else changes.
// Recommended photo specs: real, well-lit photo of the actual vehicle
// type, square-ish crop (at least 300x300px), JPG or WEBP, vehicle
// filling most of the frame on a plain/blurred background so it reads
// clearly at the small 38–44px display size.
// v=2026090401 — cache-busting query tag. Bump this string any time the
// image FILES under assets/vehicles/ are replaced/updated. Without it,
// a browser or the PWA service worker (sw.js) that already cached the
// old 404/missing response for these paths can keep "remembering" the
// failure and never re-request the now-present file — this alone can
// make correctly-uploaded images silently keep showing the SVG
// fallback. The tag forces every client to treat this as a brand-new
// URL and re-fetch it for real.
const VEHICLE_PHOTOS_VERSION = 'v=2026090401';
const VEHICLE_PHOTOS = {
  taxi:      `assets/vehicles/taxi.jpg?${VEHICLE_PHOTOS_VERSION}`,       // سيارة تكسي (سيدان صفراء/عادية)
  private:   `assets/vehicles/private.jpg?${VEHICLE_PHOTOS_VERSION}`,    // سيارة خصوصي (سيدان فاخرة)
  courier:   `assets/vehicles/courier.jpg?${VEHICLE_PHOTOS_VERSION}`,    // دراجة نارية توصيل
  intercity: `assets/vehicles/intercity.jpg?${VEHICLE_PHOTOS_VERSION}`,  // باص/فان بين المحافظات
  cargo:     `assets/vehicles/cargo.jpg?${VEHICLE_PHOTOS_VERSION}`,      // بيك أب / سيارة حمل
  starx:     `assets/vehicles/starx.jpg?${VEHICLE_PHOTOS_VERSION}`,      // فان نقل نفرات
};

// Stage — realistic, multi-color vehicle icons (replaces the previous
// flat single-stroke outlines). Each is a small self-contained flat
// illustration (body + windows + wheels + accent) built from inline
// SVG shapes with their own explicit fill colors, so every service
// reads as a distinct little "photo-like" vehicle badge instead of a
// generic line icon recolored per service. Purely visual: still valid
// inner-SVG markup dropped into the exact same wrapper markup as
// before (buildQuickServiceChips / buildServiceSwitch), so no other
// app.js logic, data attribute, or click handler changes.
// Stage 2 — refined to match the reference ride-list icon style more
// closely: smoother rounded car-silhouette body (instead of a boxy
// rect body) for the three car-type services, plus a light diagonal
// "gloss" reflection stroke added to every icon for a glossier,
// less flat-drawn look. Still small self-contained flat illustrations
// (no external images/network calls — offline-safe), still dropped
// into the exact same wrapper markup, so no other app.js logic changes.
const CAR_BODY = 'M2.2 14.8c0-.66.4-1.25 1-1.5l2.1-.9 1.7-2.9A2.1 2.1 0 0 1 8.8 8.4h6.4a2.1 2.1 0 0 1 1.8 1.1l1.7 2.9 2.1.9c.6.25 1 .84 1 1.5v1.6a.9.9 0 0 1-.9.9h-1.3a2.4 2.4 0 0 1-4.7 0H8.9a2.4 2.4 0 0 1-4.7 0H3.1a.9.9 0 0 1-.9-.9Z';
const CAR_WHEELS = '<circle cx="6.5" cy="17.3" r="2.3" fill="#1F2430"/><circle cx="6.5" cy="17.3" r="0.85" fill="#C9CFDA"/><circle cx="17.5" cy="17.3" r="2.3" fill="#1F2430"/><circle cx="17.5" cy="17.3" r="0.85" fill="#C9CFDA"/>';
const CAR_GLOSS = '<path d="M5.4 10c2-1 4.5-1.5 6.6-1.5s4.6.5 6.6 1.5" stroke="#FFFFFF" stroke-width="0.9" stroke-linecap="round" opacity="0.4" fill="none"/>';
function carIcon(bodyFill, windowFill){
  return `<path d="${CAR_BODY}" fill="${bodyFill}"/>` +
    `<path d="M6.9 12.9l1.5-3.55a1 1 0 0 1 .95-.65h2.05v4.2Z" fill="${windowFill}"/>` +
    `<path d="M11.85 8.7h2.65a1.1 1.1 0 0 1 1 .63l1.7 3.57h-5.35Z" fill="${windowFill}"/>` +
    CAR_GLOSS + CAR_WHEELS;
}
const ICONS = {
  taxi: carIcon('#F5B301', '#FFF3D0') + '<rect x="9.6" y="8.55" width="4.8" height="0.55" fill="#1A1A1A"/><rect x="9.9" y="4.6" width="4.2" height="1.5" rx="0.4" fill="#1A1A1A"/>',
  private: carIcon('#2B3352', '#9FC6FF'),
  courier: '<circle cx="5.8" cy="17.4" r="2.1" fill="#1F2430"/><circle cx="5.8" cy="17.4" r="0.8" fill="#C9CFDA"/><circle cx="17.5" cy="17.4" r="2.1" fill="#1F2430"/><circle cx="17.5" cy="17.4" r="0.8" fill="#C9CFDA"/><path d="M5.8 17.4h2.8l1.6-5.4h2.7" stroke="#3A2E1A" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M10.5 12l1.3-3h2.6" stroke="#3A2E1A" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><rect x="14" y="9.6" width="5.4" height="5.1" rx="0.9" fill="#D9A441"/><rect x="14" y="9.6" width="5.4" height="1.5" fill="#8A6415"/><circle cx="11.9" cy="7.1" r="1.5" fill="#E7B463"/><path d="M14.7 10.7h3.9" stroke="#FFFFFF" stroke-width="0.6" stroke-linecap="round" opacity="0.45"/>',
  intercity: '<rect x="2.6" y="6" width="18.8" height="9.4" rx="2.2" fill="#1E9E82"/><rect x="4" y="7.4" width="3" height="2.6" rx="0.5" fill="#EAF9F4"/><rect x="7.6" y="7.4" width="3" height="2.6" rx="0.5" fill="#EAF9F4"/><rect x="11.2" y="7.4" width="3" height="2.6" rx="0.5" fill="#EAF9F4"/><rect x="14.8" y="7.4" width="3" height="2.6" rx="0.5" fill="#EAF9F4"/><rect x="2.6" y="11.6" width="18.8" height="1.4" fill="#146854"/><rect x="2.6" y="15.2" width="18.8" height="2" rx="1" fill="#146854"/><path d="M3.4 6.9h17.2" stroke="#FFFFFF" stroke-width="0.6" stroke-linecap="round" opacity="0.4"/><circle cx="6.6" cy="18" r="1.8" fill="#12131A"/><circle cx="6.6" cy="18" r="0.7" fill="#8B93A8"/><circle cx="17.4" cy="18" r="1.8" fill="#12131A"/><circle cx="17.4" cy="18" r="0.7" fill="#8B93A8"/>',
  cargo: '<rect x="2.4" y="9.4" width="10.6" height="6" rx="0.8" fill="#C97A3D"/><rect x="2.4" y="8" width="7.6" height="1.6" fill="#8A4E1E"/><path d="M13 11h3.6a2 2 0 0 1 1.8 1.1l1.4 2.6v1.7h-6.8Z" fill="#8A4E1E"/><rect x="15.2" y="12.4" width="3.4" height="2.2" rx="0.4" fill="#FFE1C2"/><rect x="3.2" y="10.6" width="8.9" height="1" fill="#E0A16A"/><path d="M3.2 10.1h7" stroke="#FFFFFF" stroke-width="0.5" stroke-linecap="round" opacity="0.4"/><circle cx="6.6" cy="17.6" r="1.9" fill="#1F2430"/><circle cx="6.6" cy="17.6" r="0.75" fill="#C9CFDA"/><circle cx="16.6" cy="17.6" r="1.9" fill="#1F2430"/><circle cx="16.6" cy="17.6" r="0.75" fill="#C9CFDA"/>',
  starx: carIcon('#6E5CC4', '#E6E1FA') + '<path d="M11.85 8.7v4.2" stroke="#453579" stroke-width="0.5"/>',
};

const BUSINESS_WHATSAPP_NUMBER = '9647718828710'; // دعم يمّك — 07718828710
// Initial camera position only — used to frame the map (south Mosul /
// Nineveh service area, not Baghdad) for the brief moment before a
// real GPS fix arrives; it is never shown as a marker, pin, or name,
// and setPickup()/setDropoff() always override it with the customer's
// actual GPS/tap/search position. Kept because Leaflet needs *some*
// initial center — removing it would leave the map with no defined
// starting view (e.g. mid-ocean at zoom 11) until GPS resolves or if
// location permission is denied.
const SERVICE_REGION_CENTER = { lat: 35.9824, lng: 43.2578 };
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
  // Set once we've attempted an automatic GPS fix for the customer's
  // pickup point, so we only ever try this once per visit — never
  // re-prompting or overwriting a point the customer already set
  // manually (typed address, map tap, marker drag, or the "موقعي" button).
  autoLocateAttempted: false,
  // Live GPS tracking (watchPosition) — see startGpsWatch()/stopGpsWatch().
  // gpsWatchId: the id returned by navigator.geolocation.watchPosition(),
  // so it can be cleared; null when no watch is currently running.
  // gpsFollowing: true only while the pickup pin should keep following the
  // customer's real, moving device position. Set true on every real GPS fix
  // (auto-locate or the "موقعي الحالي" button) and set false the instant the
  // customer takes manual control of the pickup point (map tap or marker
  // drag) — so live tracking can never fight or overwrite a manual choice.
  gpsWatchId: null,
  gpsFollowing: false,
  // Throttle for reverse-geocoding pickup while live-tracking: avoids
  // hammering the Nominatim API (and rewriting the pickup text field) on
  // every single GPS tick — only re-resolves the address once the device
  // has actually moved a meaningful distance since the last lookup.
  lastGeocodedPickup: null,
  lastGeocodeAt: 0,
  mapTargetMode: 'pickup', // 'pickup' | 'dropoff' — which marker the next map tap sets
  map: null,
  pickupMarker: null,
  dropoffMarker: null,
  decorLine: null,
  lastSubmission: null, // { id, request_number, phone, service_type, pickup, dropoff, created_at }
  statusPollTimer: null,
  lastKnownStatus: null,
  featuredDriverId: null, // id of the driver currently shown on the booking card, captured at booking time
  featuredDriverPhone: null, // phone of that same driver — sent to submit_trip_request so the pick is a real assignment, not cosmetic
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
// The sheet is now a fixed, non-draggable panel — no peek/half/full
// resizing, no swipe gestures, no horizontal movement of any kind. Height
// is one constant value set entirely in CSS (see .sheet in app.css).
// This class is kept only so every existing sheet.setSnap(...) call
// elsewhere in the app (after booking, after submit, on view switches,
// etc.) keeps working without needing to touch those call sites —
// setSnap() now simply scrolls the panel's content back to the top,
// which is the only "reset" a fixed panel still needs.
class BottomSheet {
  constructor(el, handleEl, scrollEl) {
    this.el = el;
    this.handle = handleEl;
    this.scrollEl = scrollEl;
    this.current = 'fixed';
  }

  setSnap() {
    if (this.el) this.el.style.removeProperty('--sheet-h');
    if (this.scrollEl) this.scrollEl.scrollTop = 0;
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
      // A minimal attribution control is required by the tile provider's
      // usage policy below (OpenStreetMap) — kept as small/unobtrusive as
      // possible via app.css's .leaflet-control-attribution rule, not a
      // design change to the map itself.
      attributionControl: true,
      center: [SERVICE_REGION_CENTER.lat, SERVICE_REGION_CENTER.lng],
      zoom: 11,
      minZoom: 6,
      maxZoom: 18,
      // No maxBounds/maxBoundsViscosity clamp — panning and zooming
      // (drag, pinch, scroll, double-tap) all behave like a normal,
      // unrestricted Leaflet map. Dragging, touch-zoom, scroll-wheel
      // zoom, and double-click zoom all stay at their Leaflet defaults
      // (enabled) — nothing here disables any of them.
      fadeAnimation: true,
      zoomAnimation: true,
    });

    // Standard OpenStreetMap raster tiles — a reliable, genuinely keyless
    // source (no account, no secret, nothing to embed in the published
    // code). Switched from CARTO's basemaps.cartocdn.com endpoint, which
    // started requiring an API key in late August 2026 and now serves
    // every unauthenticated request with a large "API KEY REQUIRED"
    // watermark. Same Leaflet setup, same raster-tile approach, same
    // real place names sourced live from OpenStreetMap data in whatever
    // language OSM itself has each name tagged in — which for this
    // service region is already predominantly Arabic. Nothing here is
    // hardcoded or fabricated. Combined with the accuracy filter in
    // app.css (.leaflet-tile-pane), this keeps the same calm, light look.
    const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      subdomains: 'abc',
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(state.map);

    tiles.on('load', () => {
      const skel = document.getElementById('mapSkeleton');
      if (skel) skel.classList.add('hide');
    });

    state.map.on('click', (e) => {
      if (state.mapTargetMode === 'dropoff') {
        setDropoff(e.latlng.lat, e.latlng.lng, { reverseGeocode: true, fly: false });
      } else {
        // Manual pickup selection on the map — the customer has explicitly
        // chosen a point, so live GPS tracking must stop instead of moving
        // this pin again on the next device-position update.
        stopGpsWatch();
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
      <path d="M17 2c-6.6 0-12 5.3-12 11.8C5 22 17 32 17 32s12-10 12-18.2C29 7.3 23.6 2 17 2Z" fill="#1D6FD1" stroke="#FFFFFF" stroke-width="1.4"/>
      <circle cx="17" cy="13.5" r="4.6" fill="#FFFFFF"/>
    </svg>`,
    iconSize: [40, 52],
    iconAnchor: [20, 50],
  });
}

function dropoffDivIcon() {
  return L.divIcon({
    className: 'pickup-pin dropped dropoff-pin',
    html: `<svg viewBox="0 0 34 34" fill="none">
      <path d="M17 2c-6.6 0-12 5.3-12 11.8C5 22 17 32 17 32s12-10 12-18.2C29 7.3 23.6 2 17 2Z" fill="#E5B85C" stroke="#FFFFFF" stroke-width="1.4"/>
      <rect x="13.5" y="10" width="7" height="7" rx="1.4" fill="#FFFFFF"/>
    </svg>`,
    iconSize: [40, 52],
    iconAnchor: [20, 50],
  });
}

function setPickup(lat, lng, { reverseGeocode = false, fly = true, animate = true, accuracy = null } = {}) {
  state.pickupLatLng = { lat, lng };
  document.getElementById('pickupLat').value = lat;
  document.getElementById('pickupLng').value = lng;
  showLocationMapLink('pickupMapLink', lat, lng);

  if (state.map) {
    if (!state.pickupMarker) {
      state.pickupMarker = L.marker([lat, lng], { icon: pickupDivIcon(), draggable: true }).addTo(state.map);
      state.pickupMarker.on('dragend', () => {
        // The customer just took manual control of the pickup point —
        // live GPS tracking must stop here so it can never drag the pin
        // back to the device's real-time position on the next fix.
        stopGpsWatch();
        const p = state.pickupMarker.getLatLng();
        setPickup(p.lat, p.lng, { reverseGeocode: true, fly: false });
      });
    } else {
      state.pickupMarker.setLatLng([lat, lng]);
      // animate=false is used for live GPS ticks (see startGpsWatch()) so
      // the pin glides to its new spot instead of replaying the "drop"
      // bounce every few seconds while the customer is simply moving.
      if (animate) {
        const el = state.pickupMarker.getElement();
        if (el) {
          el.classList.remove('dropped');
          void el.offsetWidth;
          el.classList.add('dropped');
        }
      }
    }
    drawRoute();
    if (fly) state.map.flyTo([lat, lng], 15, { duration: 1.1 });
  }

  if (reverseGeocode) reverseGeocodePickup(lat, lng, accuracy);
  updatePriceBar();
  validateField('pickup');
  updateSubmitButtonState();
}

function setDropoff(lat, lng, { reverseGeocode = false, fly = true } = {}) {
  state.dropoffLatLng = { lat, lng };
  document.getElementById('dropoffLat').value = lat;
  document.getElementById('dropoffLng').value = lng;
  showLocationMapLink('dropoffMapLink', lat, lng);

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

// Nominatim's reverse geocode returns a full administrative chain in
// display_name (country, governorate, city, district, village...). The
// customer needs the most precise detail actually available — a street/
// road, plus a nearby landmark and/or area for context — never a bare
// area/neighbourhood name standing in for a precise location, and never
// the generic administrative chain. This only changes what's SHOWN in
// the text field; the lat/lng hidden inputs are already set from the
// raw coordinates before this ever runs (see setPickup/setDropoff above)
// and are completely untouched by it.
function shortAddressFromGeocode(data) {
  if (!data) return null;
  const a = data.address || {};
  const landmark = a.amenity || a.shop || a.tourism || a.building || a.office || a.leisure;
  const street = a.road;
  const area = a.neighbourhood || a.suburb || a.quarter || a.city_district || a.village || a.hamlet || a.town;
  // Broader administrative name (county/district/nearest city) — used only
  // as extra context next to `area`, or as the name itself when even a
  // village/hamlet/suburb tag is missing. This is the fix for rural spots
  // and road junctions (e.g. a junction south of Mosul) that Nominatim has
  // no street/landmark/village tag for at all: previously that meant
  // falling straight through to the GPS-accuracy fallback text below,
  // even though OSM often still knows the surrounding county/city name —
  // e.g. "جنوب الموصل"-style context — which reads as an actual place to
  // the driver instead of nothing.
  const broader = a.county || a.state_district || a.city || a.town;

  // A name is only ever returned when there's a real street, landmark, or
  // at least an area/broader-region tag to anchor it. With absolutely
  // none of those (extremely rare — essentially no OSM coverage at all,
  // e.g. open desert/water), the caller falls back to the real lat/lng
  // (+ GPS accuracy when available) instead of guessing a place name.
  if (landmark && street && area) return `${landmark}، ${street}، ${area}`;
  if (landmark && street) return `${landmark}، ${street}`;
  if (landmark && area) return `${landmark}، ${area}`;
  if (landmark) return landmark;
  if (street && area) return `${street}، ${area}`;
  if (street) return street;
  if (area && broader && area !== broader) return `${area}، ${broader}`;
  if (area) return area;
  if (broader) return broader;
  // Absolute last resort before giving up on a name entirely: the
  // governorate alone (e.g. "نينوى") — coarser than ideal, but still an
  // actual place name rather than the GPS-accuracy fallback text below.
  if (a.state) return a.state;
  return null;
}

// location-system fix: renders a small tappable "open on map" link into
// one of the (originally empty/hidden) pickupMapLink / dropoffMapLink
// hint spans, using the exact saved coordinates — so both the customer
// and, wherever this same trip data is displayed to a driver, anyone
// reading the address text also has a one-tap way to open the precise
// GPS point itself, never just a written name that could be ambiguous.
// Purely presentational: does not read/write state.*LatLng or touch the
// hidden #pickupLat/#pickupLng/#dropoffLat/#dropoffLng inputs used for
// submission — those are already set by setPickup()/setDropoff() before
// this ever runs.
function showLocationMapLink(hintElId, lat, lng) {
  const el = document.getElementById(hintElId);
  if (!el) return;
  const url = `https://www.google.com/maps?q=${lat},${lng}`;
  el.innerHTML = `<a href="${url}" target="_blank" rel="noopener">📍 فتح الموقع على الخريطة</a>`;
  el.hidden = false;
}

// Fallback label used when reverse geocoding has no reliable street or
// landmark name to offer. Never shows the raw lat/lng digits to the
// customer — those are already saved separately (hidden #pickupLat/
// #pickupLng / #dropoffLat/#dropoffLng inputs + state.pickupLatLng/
// state.dropoffLatLng, set in setPickup()/setDropoff() before this ever
// runs) and are exactly what's used for GPS tracking, distance/price,
// and the request sent to Supabase — this only controls what the
// customer sees written in the address text field, which must always
// read like a location, never like coordinates. `accuracy` is only ever
// passed for a real device GPS fix (pickup), so its presence is what
// distinguishes "your current location" from a manually chosen point.
function coordsLabel(lat, lng, accuracy = null) {
  if (accuracy != null && isFinite(accuracy)) {
    return `موقعك الحالي (دقة تحديد GPS ±${Math.round(accuracy)} م تقريبًا)`;
  }
  return 'الموقع المحدد على الخريطة';
}

async function reverseGeocodePickup(lat, lng, accuracy = null) {
  // While live GPS tracking is moving this pin every few seconds, re-
  // resolving the address on every single tick would hammer the Nominatim
  // API and make the pickup text field flicker constantly while the
  // customer is simply standing still or moving slowly. Skip the lookup
  // if the device hasn't moved meaningfully since the last one — this
  // only throttles the *text lookup*; the actual GPS coordinates saved
  // for the trip are always the latest real fix, untouched by this.
  const now = Date.now();
  if (state.lastGeocodedPickup) {
    const movedM = haversineKm(state.lastGeocodedPickup.lat, state.lastGeocodedPickup.lng, lat, lng) * 1000;
    if (movedM < 40 && (now - state.lastGeocodeAt) < 8000) return;
  }
  state.lastGeocodedPickup = { lat, lng };
  state.lastGeocodeAt = now;

  const input = document.getElementById('pickup');
  const original = input.value;
  input.placeholder = ' ';
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}&accept-language=ar`);
    const data = await res.json();
    input.value = shortAddressFromGeocode(data) || coordsLabel(lat, lng, accuracy);
  } catch (err) {
    if (!original) input.value = coordsLabel(lat, lng, accuracy);
  }
  updateSubmitButtonState();
}

async function reverseGeocodeDropoff(lat, lng) {
  const input = document.getElementById('dropoff');
  const original = input.value;
  input.placeholder = ' ';
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}&accept-language=ar`);
    const data = await res.json();
    input.value = shortAddressFromGeocode(data) || coordsLabel(lat, lng);
  } catch (err) {
    if (!original) input.value = coordsLabel(lat, lng);
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

// Locates the customer and drops the pickup pin on their real position.
//
// Two things used to make this fail even after the browser's native
// permission prompt was accepted:
//  1) A single getCurrentPosition() call with enableHighAccuracy:true and
//     only a 10s timeout — a fresh GPS/Wi-Fi fix regularly takes longer
//     than that on a phone that isn't outdoors, so the call would hit
//     TIMEOUT (error code 3) and we'd show a "check your permission"
//     message even though permission was never the problem.
//  2) Every failure (denied / unavailable / timeout) showed the exact
//     same generic message, so the customer had no way to tell a real
//     permission block from a slow/failed fix.
//
// Fix: try a high-accuracy fix first; if that specifically times out,
// silently retry once with a relaxed (low-accuracy, longer timeout,
// cached-position-allowed) request instead of failing outright. Only
// PERMISSION_DENIED and a failed retry produce an error toast, and each
// case gets its own message.
function locateMe(auto = false) {
  const btn = document.getElementById('recenterBtn');
  const locateBtn = document.getElementById('locateBtnApp');
  const startSpin = () => [btn, locateBtn].forEach(b => b && b.classList.add('locating'));
  const stopSpin = () => [btn, locateBtn].forEach(b => b && b.classList.remove('locating'));
  startSpin();

  if (!navigator.geolocation) {
    stopSpin();
    if (!auto) toast('متصفحك لا يدعم تحديد الموقع الجغرافي');
    return;
  }

  // Geolocation is only available in a secure context (HTTPS or
  // localhost). On a plain-HTTP page the browser blocks the call before
  // any permission prompt even appears, which used to surface as the
  // same confusing "check your permission" toast.
  if (window.isSecureContext === false) {
    stopSpin();
    if (!auto) toast('تحديد الموقع يتطلب اتصالاً آمنًا (HTTPS) — تعذّر الوصول لموقعك');
    return;
  }

  const onSuccess = (pos) => {
    // A real GPS/network fix just came in — the pin should now actively
    // follow the customer's real, moving device position until they take
    // manual control (map tap / marker drag — see setPickup()).
    state.gpsFollowing = true;
    setPickup(pos.coords.latitude, pos.coords.longitude, { reverseGeocode: true, fly: true, accuracy: pos.coords.accuracy });
    startGpsWatch();
    stopSpin();
  };

  const attemptRelaxed = () => {
    navigator.geolocation.getCurrentPosition(
      onSuccess,
      (err) => {
        stopSpin();
        if (auto) return;
        if (err.code === err.PERMISSION_DENIED) {
          toast('تعذّر الوصول لموقعك — الرجاء السماح بإذن الموقع من إعدادات المتصفح');
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          toast('تعذّر تحديد موقعك حاليًا — تأكد من تفعيل خدمة الموقع (GPS) وحاول مجددًا');
        } else {
          toast('تعذّر تحديد موقعك — حاول مرة أخرى');
        }
      },
      { enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 }
    );
  };

  navigator.geolocation.getCurrentPosition(
    onSuccess,
    (err) => {
      // Permission was actually denied: no point retrying, and no
      // amount of relaxing the accuracy/timeout will fix that.
      if (err.code === err.PERMISSION_DENIED) {
        stopSpin();
        if (!auto) toast('تعذّر الوصول لموقعك — الرجاء السماح بإذن الموقع من إعدادات المتصفح');
        return;
      }
      // TIMEOUT or POSITION_UNAVAILABLE on the high-accuracy attempt:
      // retry once with relaxed settings before giving up.
      attemptRelaxed();
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

/* ============================================================
   Live GPS tracking (watchPosition)
   ------------------------------------------------------------
   Keeps the pickup pin following the customer's REAL, moving device
   position — using the browser's native watchPosition with
   enableHighAccuracy:true, exactly like the single-fix call above.
   This is what makes the pin update automatically while the customer
   is in motion, instead of only ever reflecting a single moment-in-
   time fix. It only ever runs after a real fix has already succeeded
   (see locateMe's onSuccess) and only ever moves the pin while
   state.gpsFollowing is true — the instant the customer manually taps
   the map or drags the pin, that flag flips false and this watch is
   cleared outright (see setPickup/map click handler), so live
   tracking can never override a manual choice. No fixed/simulated
   coordinates are ever used here — every update comes straight from
   navigator.geolocation.
   ============================================================ */
function startGpsWatch() {
  if (!navigator.geolocation || state.gpsWatchId !== null) return;
  state.gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (!state.gpsFollowing) return; // customer already took manual control
      setPickup(pos.coords.latitude, pos.coords.longitude, {
        reverseGeocode: true,
        fly: false,   // don't fight the customer's own map panning/zooming
        animate: false, // glide, don't replay the drop-bounce every tick
        accuracy: pos.coords.accuracy,
      });
    },
    () => {
      // Silent by design: a transient signal-loss/timeout on one watch
      // tick shouldn't interrupt the customer with a toast — the watch
      // keeps running and simply resumes updating on the next good fix,
      // and the pin stays exactly where its last real fix placed it.
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function stopGpsWatch() {
  if (state.gpsWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(state.gpsWatchId);
  }
  state.gpsWatchId = null;
  state.gpsFollowing = false;
}

/* ============================================================
   View switching
   ============================================================ */
function showView(name) {
  document.querySelectorAll('.sheet-view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
  document.getElementById('sheetScroll').scrollTop = 0;
  setActiveNavTab(name);
}

function openBooking(serviceKey) {
  if (serviceKey) selectService(serviceKey);
  else if (!state.currentService) selectService('taxi');
  showView('booking');
  sheet.setSnap('full');
  applyProfileToBookingForm();
  haptic();

  // Auto-detect the customer's pickup location once per visit, the
  // moment they open the request form — the right time to ask per
  // Android/iOS guidance (in context, not on cold page load), and
  // silent (auto=true) so a denial or slow fix never shows an error;
  // the pickup field simply stays open for manual entry as before.
  // Skipped entirely if a pickup point is already set, so this never
  // overwrites a manually typed address, map tap, or marker drag.
  if (!state.pickupLatLng && !state.autoLocateAttempted) {
    state.autoLocateAttempted = true;
    locateMe(true);
  }
}

function backToHome() {
  stopStatusPolling();
  showView('home');
  sheet.setSnap('half');
}

/* ============================================================
   Service selection
   ============================================================ */
function selectService(key) {
  state.currentService = key;
  document.querySelectorAll('.svc-pill').forEach(p => p.classList.toggle('active', p.dataset.service === key));
  const isCourier = key === 'courier' || key === 'cargo';
  document.querySelector('label[for="pickup"]').textContent = isCourier ? 'مكان الاستلام' : 'مكان الانطلاق';
  document.querySelector('label[for="dropoff"]').textContent = isCourier ? 'مكان التسليم' : 'الوجهة';
  updatePriceBar();
  loadServiceDrivers(key);
  haptic();
}

/* ============================================================
   Driver card (booking view) — shows EVERY driver currently returned
   by get_service_driver_roster() for this service, with no queue/turn
   concept on the customer side at all: no "front of the queue", no
   "waiting their turn". The customer sees only two real states —
   available or busy — and can tap "طلب" on ANY available driver to
   request that exact driver directly. A busy driver is shown (so the
   customer can see who's currently working) but has no "طلب" button
   and cannot be selected. The customer never sees a name or phone-as-
   identifier here, only vehicle type and status, per privacy design.

   status is computed server-side (see get_service_driver_roster) —
   this file only ever reads it, never assumes a value when absent
   (falls back to "متاح" so a driver still returned by the roster is
   never wrongly shown as busy).
   ============================================================ */
const DRIVER_AVATAR_SVG = '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.6"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const CALL_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const WA_ICON_SVG = '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.36 5.07L2 22l5.06-1.33A9.94 9.94 0 0 0 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2Zm0 18a7.9 7.9 0 0 1-4.03-1.1l-.29-.17-3 .79.8-2.93-.19-.3A7.93 7.93 0 1 1 12 20Zm4.4-5.9c-.24-.12-1.42-.7-1.64-.78-.22-.08-.38-.12-.54.12-.16.24-.62.78-.76.94-.14.16-.28.18-.52.06-.24-.12-1.02-.38-1.94-1.2-.72-.64-1.2-1.44-1.34-1.68-.14-.24-.02-.37.1-.49.11-.11.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.54-1.3-.74-1.78-.2-.47-.4-.4-.54-.41h-.46c-.16 0-.42.06-.64.3-.22.24-.84.82-.84 2s.86 2.32.98 2.48c.12.16 1.7 2.6 4.12 3.64.58.25 1.03.4 1.38.51.58.18 1.11.16 1.53.1.47-.07 1.42-.58 1.62-1.14.2-.56.2-1.04.14-1.14-.06-.1-.22-.16-.46-.28Z"/></svg>';
const REQUEST_ICON_SVG = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Exactly two states shown to the customer, per the no-FIFO design:
// 🟢 متاح (status === 'active' — selectable) or 🔴 مشغول (anything
// else — busy or offline both read as simply "not available right
// now"; the customer never sees a third "بانتظار الدور" queue state).
function rosterStatusInfo(status) {
  const isAvailable = String(status || '').toLowerCase() === 'active';
  return isAvailable
    ? { dot: '🟢', label: 'متاح', cls: 'badge-live' }
    : { dot: '🔴', label: 'مشغول', cls: 'badge-onjob' };
}

// Renders EVERY driver for this service, each in its own card (no
// limit(1), nothing hidden — get_service_driver_roster() returns the
// full roster, including phone). The customer can call/WhatsApp ANY
// visible driver. "طلب" only appears on an available driver (status
// === 'active') and requests that exact driver directly — a busy
// driver has no "طلب" button and cannot be selected. There is no
// queue/turn concept here at all: no driver is singled out as "next",
// every available driver is equally selectable.
// Display-order-only sort: closest real GPS distance to the customer
// first, everyone else after in original list order — purely
// cosmetic ordering, never touches the database or any driver's data.
// A driver's location is ignored (treated as unknown) once it's older
// than STALE_LOCATION_MS — they simply fall back to the end of the
// list in original order, instead of showing a false position.
const STALE_LOCATION_MS = 10 * 60 * 1000; // 10 minutes

function sortRosterByDistance(roster, customerLat, customerLng) {
  if (customerLat == null || customerLng == null) return roster;
  const now = Date.now();

  const enriched = roster.map((row, idx) => {
    const hasFreshLoc =
      row.driver_lat != null && row.driver_lng != null && row.location_updated_at &&
      (now - new Date(row.location_updated_at).getTime()) <= STALE_LOCATION_MS;
    const distanceKm = hasFreshLoc ? haversineKm(customerLat, customerLng, row.driver_lat, row.driver_lng) : Infinity;
    return { row, idx, distanceKm };
  });

  enriched.sort((a, b) => {
    if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    return a.idx - b.idx; // stable fallback — preserves the existing list order
  });

  return enriched.map((e) => e.row);
}

async function loadServiceDrivers(serviceType) {
  const wrap = document.getElementById('driversListApp');
  if (!wrap) return;

  state.featuredDriverId = null;
  wrap.hidden = true;
  wrap.innerHTML = '';

  try {
    const { data: roster, error: rosterError } = await supabaseClient
      .rpc('get_service_driver_roster', { p_service_type: serviceType });

    if (rosterError || !roster || roster.length === 0) return; // hidden entirely if no drivers exist yet for this service

    const waText = encodeURIComponent(`مرحباً، أريد حجز ${SERVICES[serviceType]?.label || ''} عبر يمّك`);

    // Pure real-GPS distance sort (see sortRosterByDistance). Falls
    // back to the roster's original order untouched when the customer
    // hasn't set a pickup point yet.
    const sortedRoster = state.pickupLatLng
      ? sortRosterByDistance(roster, state.pickupLatLng.lat, state.pickupLatLng.lng)
      : roster;

    const cardsHtml = sortedRoster.map((row) => {
      const info = rosterStatusInfo(row.status);
      const vehicleTypeLabel = row.vehicle_type || SERVICES[serviceType]?.label || 'مركبة';
      const cleanTel = (row.phone || '').replace(/[^\d+]/g, '');
      const waTarget = normalizeIraqiPhoneForWhatsapp(row.phone);
      // "طلب" is only offered on an actually available driver (status
      // === 'active') — a busy driver cannot be picked for a real,
      // immediate assignment. Every available driver in the
      // GPS-sorted list can be chosen equally; none is singled out.
      const canRequest = row.status === 'active';
      const hasActions = cleanTel || waTarget || canRequest;

      const actionsHtml = hasActions ? `
        <div class="driver-actions">
          ${cleanTel ? `<a href="tel:${cleanTel}" class="driver-action-btn call" aria-label="اتصال بالسائق">${CALL_ICON_SVG} اتصال</a>` : ''}
          ${waTarget ? `<a href="https://wa.me/${waTarget}?text=${waText}" class="driver-action-btn whatsapp" target="_blank" rel="noopener" aria-label="واتساب السائق">${WA_ICON_SVG} واتساب</a>` : ''}
          ${canRequest ? `<button type="button" class="driver-action-btn request" data-driver-action="request" data-driver-id="${escapeHtml(row.id)}" data-driver-phone="${escapeHtml(row.phone || '')}" aria-label="طلب">${REQUEST_ICON_SVG} طلب</button>` : ''}
        </div>
      ` : '';

      return `
        <div class="driver-card-app${canRequest ? ' driver-live' : ''}">
          <span class="driver-avatar">${DRIVER_AVATAR_SVG}</span>
          <div class="driver-info">
            <b>${escapeHtml(vehicleTypeLabel)}</b>
            <div class="driver-meta"><span class="${info.cls}">${info.dot} ${info.label}</span></div>
          </div>
        </div>
        ${actionsHtml}
      `;
    }).join('');

    wrap.innerHTML = `<p class="section-label">السواق</p>${cardsHtml}`;
    wrap.hidden = false;
  } catch (err) {
    console.error('loadServiceDrivers failed', err);
  }
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
   Customer ads carousel — additive only. Reads active/in-schedule
   ads via the get_active_customer_ads() RPC (see
   migrations/migration_customer_ads.sql) and rotates them in the
   home view, right below the existing promo-card. Does not touch
   booking, pricing, the map, or any GPS/location code.
   ============================================================ */
const adsState = {
  ads: [],
  index: 0,
  timer: null,
};

function stopAdsRotation() {
  if (adsState.timer) {
    clearTimeout(adsState.timer);
    adsState.timer = null;
  }
}

function renderAdsDots() {
  const dots = document.getElementById('adsDots');
  if (!dots) return;
  if (adsState.ads.length <= 1) {
    dots.hidden = true;
    dots.innerHTML = '';
    return;
  }
  dots.hidden = false;
  dots.innerHTML = adsState.ads.map((_, i) =>
    `<span class="ads-dot${i === adsState.index ? ' active' : ''}"></span>`
  ).join('');
}

function showAdSlide(i) {
  const track = document.getElementById('adsTrack');
  if (!track) return;
  adsState.index = ((i % adsState.ads.length) + adsState.ads.length) % adsState.ads.length;
  track.style.transform = `translateX(${adsState.index * 100}%)`;
  renderAdsDots();
}

function scheduleNextAdSlide() {
  stopAdsRotation();
  if (adsState.ads.length <= 1) return;
  const current = adsState.ads[adsState.index];
  const seconds = Number(current?.display_seconds) > 0 ? Number(current.display_seconds) : 6;
  adsState.timer = setTimeout(() => {
    showAdSlide(adsState.index + 1);
    scheduleNextAdSlide();
  }, seconds * 1000);
}

function renderAdsCarousel() {
  const carousel = document.getElementById('adsCarousel');
  const track = document.getElementById('adsTrack');
  if (!carousel || !track) return;

  if (!adsState.ads.length) {
    carousel.hidden = true;
    track.innerHTML = '';
    stopAdsRotation();
    return;
  }

  track.innerHTML = adsState.ads.map(ad => {
    const img = ad.image_url
      ? `<img class="ad-slide-img" src="${escapeHtmlAttr(ad.image_url)}" alt="" loading="lazy">`
      : '';
    const hasText = ad.title || ad.body;
    const body = hasText
      ? `<div class="ad-slide-body">${ad.title ? `<b>${escapeHtmlText(ad.title)}</b>` : ''}${ad.body ? `<span>${escapeHtmlText(ad.body)}</span>` : ''}</div>`
      : '';
    const tag = ad.link_url ? 'a' : 'div';
    const href = ad.link_url ? ` href="${escapeHtmlAttr(ad.link_url)}" target="_blank" rel="noopener noreferrer"` : '';
    return `<${tag} class="ad-slide"${href} data-ad-id="${escapeHtmlAttr(ad.id)}">${img}${body}</${tag}>`;
  }).join('');

  carousel.hidden = false;
  adsState.index = 0;
  track.style.transform = 'translateX(0%)';
  renderAdsDots();
  scheduleNextAdSlide();
}

// Small, local escaping helpers (app.js has no existing escapeHtml —
// that lives only in admin.js) — kept minimal and scoped to ads only.
function escapeHtmlText(str) {
  return String(str == null ? '' : str)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function escapeHtmlAttr(str) {
  return escapeHtmlText(str).replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

async function loadCustomerAds() {
  try {
    const { data, error } = await supabaseClient.rpc('get_active_customer_ads');
    if (error || !data) return;
    adsState.ads = data;
    renderAdsCarousel();
  } catch (err) {
    console.error('failed to load customer ads', err);
  }
}

/* ============================================================
   Future services teaser (المطاعم / الأسواق) — reads ACTIVE rows
   from the admin-managed restaurants/markets tables (see the
   "المطاعم والأسواق" tab in admin.js) and swaps the static "قريباً"
   card content in index.html (#soonCardRestaurants/#soonCardMarkets)
   for the real list of names, but ONLY once a category actually has
   at least one active row. If a category has zero active rows, or
   this read fails for any reason (offline, RLS, etc.), the existing
   static "قريباً" markup already in index.html is left completely
   untouched — there is no separate empty-state branch to maintain,
   the original HTML already IS the empty state. Purely a read-only
   display list: no click handler, no data-service attribute, no
   ordering/booking logic is attached to these names, and nothing
   about trip_requests/drivers/service_prices/customer_ads is read
   or touched here.
   ============================================================ */
async function loadFutureServices() {
  await Promise.all([
    loadFutureServiceCategory('restaurants', 'soonCardRestaurants', '🍔', 'المطاعم'),
    loadFutureServiceCategory('markets', 'soonCardMarkets', '🛒', 'الأسواق'),
    loadFutureServiceCategory('other_services', 'soonCardOtherServices', '🛠️', 'خدمات أخرى'),
  ]);
}

async function loadFutureServiceCategory(table, cardId, icon, label) {
  const card = document.getElementById(cardId);
  if (!card) return;
  try {
    const { data, error } = await supabaseClient
      .from(table)
      .select('name')
      .eq('active', true)
      .order('created_at', { ascending: false });
    if (error || !data || data.length === 0) return; // keep the static "قريباً" card as-is

    const namesText = data.map((row) => escapeHtmlText(row.name)).join('، ');
    card.innerHTML = `
      <span class="soon-ic">${icon}</span>
      <span class="soon-label">${label}</span>
      <span class="soon-badge" style="background:transparent; color:var(--text-muted); font-weight:600; white-space:normal;">${namesText}</span>
    `;
  } catch (err) {
    console.error(`failed to load ${table} for future services teaser`, err);
    // network/RLS hiccup — silently keep showing the static "قريباً" card
  }
}

/* ============================================================
   Customer ads push opt-in — additive only. Registers the SAME
   sw.js already used for the app shell (registerServiceWorker()
   above already does this on page load; this just reuses that
   registration rather than creating a second one), subscribes via
   the browser's Push API using the SAME public VAPID key already
   used elsewhere in this project, and saves the subscription via
   save_customer_push_subscription() — a brand-new RPC that only
   writes to the brand-new customer_push_subscriptions table. Does
   not touch driver/admin push in any way.
   ============================================================ */
// Public VAPID key — safe to embed client-side by design (matches the
// same key already used in admin.js/driver.js; the private key never
// leaves the Edge Function's environment).
const CUSTOMER_VAPID_PUBLIC_KEY = 'BA_mwRbHk_BXqtt8PKCma9oaAbuQVAoYNvNvtTmq2L8bcWTPakSgiU4AuDZKpo6NCpKCRzXM2gFaZ5QIA6s5_ww';

function urlBase64ToUint8ArrayForAds(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function setupCustomerPushNotifications() {
  const btn = document.getElementById('enableCustomerPushBtn');
  const label = btn ? btn.querySelector('.more-item-label') : null;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    if (label) label.textContent = 'الإشعارات غير مدعومة بهذا المتصفح';
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    let permission = Notification.permission;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      if (label) label.textContent = 'تم رفض إذن الإشعارات';
      return;
    }

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8ArrayForAds(CUSTOMER_VAPID_PUBLIC_KEY),
      });
    }

    const { error } = await supabaseClient.rpc('save_customer_push_subscription', {
      p_subscription: subscription.toJSON(),
    });
    if (error) throw error;

    if (label) label.textContent = 'الإشعارات مفعّلة 🔔';
    if (btn) btn.disabled = true;
    haptic();
  } catch (err) {
    console.error('customer push setup failed', err);
    if (label) label.textContent = 'تعذّر تفعيل الإشعارات';
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
   Submit button enable/disable
   #bookSubmitBtn is `disabled` by default in index.html. Nothing
   previously removed that attribute, so the button could never be
   clicked and the form's `submit` event never fired — handleSubmit()
   never even started. This re-evaluates the required conditions
   (pickup + name + a validly-formatted phone + the consent checkbox
   + a specifically chosen available driver — no-FIFO: there is no
   "submit and let the system pick someone" path) on every relevant
   change and toggles `disabled` accordingly, without touching
   validateField()'s own inline error-message logic or anything past
   the button itself.
   ============================================================ */
function updateSubmitButtonState() {
  const btn = document.getElementById('bookSubmitBtn');
  if (!btn) return;
  const pickup = document.getElementById('pickup')?.value.trim();
  const name = document.getElementById('customerName')?.value.trim();
  const phone = document.getElementById('phone')?.value.trim();
  const consent = document.getElementById('consentCheck');
  const ready = !!pickup && !!name && name.length >= 2 && !!phone && PHONE_RE.test(phone) && !!(consent && consent.checked) && !!state.featuredDriverPhone;
  // FIX (bug #1 — button unresponsive): this used to set btn.disabled =
  // !ready. A native `disabled` button in HTML swallows every click
  // before it ever reaches our own JS — including the "submit" event
  // listener that calls handleSubmit() — so whenever `ready` was false
  // (most commonly: no driver picked from the list yet) the button
  // looked normal but literally could not be tapped, with no message
  // explaining why. The button is now ALWAYS enabled/clickable; we only
  // toggle a CSS class for the same dimmed visual, and
  // handleSubmit() itself does the real validation and tells the
  // customer exactly what's missing. `removeAttribute` also covers the
  // case where index.html still hard-codes `disabled` on this button by
  // default — this guarantees it's cleared on first load too.
  btn.classList.toggle('is-blocked', !ready);
  btn.setAttribute('aria-disabled', String(!ready));
  btn.removeAttribute('disabled');
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

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function handleSubmit(e) {
  // ============================================================
  // DIAGNOSTIC INSTRUMENTATION (temporary — see console.log/[SUBMIT] lines)
  // ------------------------------------------------------------
  // ROOT CAUSE FOUND: the previous version's try/catch only wrapped the
  // code from `showView('submitting')` onward. Every statement BEFORE
  // that — e.preventDefault(), clearMsg(), all eight
  // document.getElementById(...).value reads, and the three
  // validateField() calls — sat OUTSIDE any try/catch. If ANY of those
  // throws (e.g. a getElementById() call returns null because an input
  // id doesn't match the live HTML, so `.value` throws
  // "Cannot read properties of null"), the exception is never caught:
  // it becomes a silent unhandled promise rejection (async function),
  // execution of handleSubmit stops dead right there, and:
  //   - no code after it ever runs, so .rpc() is never called → no POST,
  //     ever, in the API Gateway — matches exactly what you're seeing.
  //   - no NEW message is shown either, since showMsg() is also further
  //     down — so whatever "تعذّر إرسال الطلب" text was already on
  //     screen from an earlier attempt just stays there, looking
  //     identical every time and making it seem like the same
  //     "network" failure is recurring.
  // The whole function is now wrapped in ONE try/catch from the very
  // first line, with a `step` tracker updated before each statement.
  // Whatever throws, we now catch it, log exactly which step it was on
  // plus the real error, and show the user feedback instead of hanging
  // silently. This structural fix is the actual bug fix — the labeled
  // console.log lines are the temporary diagnostic layer on top of it;
  // they can be trimmed later, but the try/catch restructuring must stay.
  let step = 'start';
  try {
    step = 'preventDefault';
    e.preventDefault();
    console.log('[SUBMIT] 1/20 preventDefault OK');

    step = 'clearMsg';
    clearMsg();
    console.log('[SUBMIT] 2/20 clearMsg OK');

    step = 'read #customerName';
    const name = document.getElementById('customerName').value.trim();
    console.log('[SUBMIT] 3/20 name =', JSON.stringify(name));

    step = 'read #phone';
    const phone = document.getElementById('phone').value.trim();
    console.log('[SUBMIT] 4/20 phone =', JSON.stringify(phone));

    step = 'read #pickup';
    const pickup = document.getElementById('pickup').value.trim();
    console.log('[SUBMIT] 5/20 pickup =', JSON.stringify(pickup));

    step = 'read #dropoff';
    const dropoff = document.getElementById('dropoff').value.trim();
    console.log('[SUBMIT] 6/20 dropoff =', JSON.stringify(dropoff));

    step = 'read #scheduledAt';
    const scheduledAt = document.getElementById('scheduledAt').value;
    console.log('[SUBMIT] 7/20 scheduledAt =', JSON.stringify(scheduledAt));

    step = 'read #notes';
    const notes = document.getElementById('notes').value.trim();
    console.log('[SUBMIT] 8/20 notes =', JSON.stringify(notes));

    step = 'read #pickupLat';
    const pickupLat = document.getElementById('pickupLat').value;
    console.log('[SUBMIT] 9/20 pickupLat =', JSON.stringify(pickupLat));

    step = 'read #pickupLng';
    const pickupLng = document.getElementById('pickupLng').value;
    console.log('[SUBMIT] 10/20 pickupLng =', JSON.stringify(pickupLng));

    step = 'validateField(pickup)';
    const validPickup = validateField('pickup');
    console.log('[SUBMIT] 11/20 validPickup =', validPickup);

    step = 'validateField(customerName)';
    const validName = validateField('customerName');
    console.log('[SUBMIT] 12/20 validName =', validName);

    step = 'validateField(phone)';
    const validPhone = validateField('phone');
    console.log('[SUBMIT] 13/20 validPhone =', validPhone);

    if (!validPickup || !validName || !validPhone) {
      console.log('[SUBMIT] validation failed — stopping before RPC (this is expected/normal, not a bug)');
      haptic(20);
      const firstInvalid = document.querySelector('.float-field.invalid input');
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    // FIX (bug #1): the consent checkbox used to only be enforced by
    // disabling the button (updateSubmitButtonState). Now that the
    // button is always clickable (see that function), handleSubmit
    // must check it explicitly too, or an unchecked box would let the
    // request through — or, before this fix, could just as easily be
    // the silent, unexplained reason the old disabled-button click did
    // nothing at all.
    step = 'check consent checkbox';
    const consentEl = document.getElementById('consentCheck');
    if (!consentEl || !consentEl.checked) {
      console.log('[SUBMIT] consent not checked — stopping before RPC');
      haptic(20);
      showMsg('يرجى الموافقة على الشروط أولاً');
      consentEl?.focus();
      return;
    }

    // No-FIFO guard: a request can only ever be sent to a specific
    // driver the customer actually tapped "طلب" on in the list. There
    // is no "submit with nobody chosen" path from the customer side —
    // if that ever happens (e.g. the driver list refreshed and the
    // previous pick is now stale), stop here with a clear message
    // instead of letting the RPC fall through to any server-side
    // auto-assignment.
    step = 'check featuredDriverPhone (no-FIFO guard)';
    if (!state.featuredDriverPhone) {
      console.log('[SUBMIT] no driver selected — stopping before RPC');
      haptic(20);
      showMsg('يرجى اختيار سائق متاح من القائمة أولاً');
      return;
    }

    step = 'showView(submitting)';
    showView('submitting');
    console.log('[SUBMIT] 14/20 showView(submitting) OK');

    step = "sheet.setSnap('half') #1";
    sheet.setSnap('half');
    console.log('[SUBMIT] 15/20 sheet.setSnap OK');

    // Build every RPC argument OUTSIDE the .rpc() call itself, field by
    // field, with risky conversions guarded individually (an unparsable
    // scheduledAt used to throw RangeError here — now it just falls
    // back to null instead of aborting the whole function).
    step = 'build p_scheduled_at';
    let p_scheduled_at = null;
    if (scheduledAt) {
      const parsed = new Date(scheduledAt);
      if (isNaN(parsed.getTime())) {
        console.error('[SUBMIT] scheduledAt unparsable, using null:', scheduledAt);
      } else {
        p_scheduled_at = parsed.toISOString();
      }
    }
    console.log('[SUBMIT] 16/20 p_scheduled_at =', p_scheduled_at);

    step = 'build lat/lng';
    const parsedPickupLat = pickupLat && Number.isFinite(Number(pickupLat)) ? Number(pickupLat) : null;
    const parsedPickupLng = pickupLng && Number.isFinite(Number(pickupLng)) ? Number(pickupLng) : null;
    console.log('[SUBMIT] 17/20 parsedPickupLat/Lng =', parsedPickupLat, parsedPickupLng);

    step = 'build submitPayload';
    const submitPayload = {
      p_service_type: state.currentService,
      p_customer_name: name,
      p_phone: phone,
      p_pickup_location: pickup,
      p_pickup_lat: parsedPickupLat,
      p_pickup_lng: parsedPickupLng,
      p_dropoff_location: dropoff || null,
      p_scheduled_at,
      p_notes: notes || null,
      // The driver the customer actually tapped "طلب" on (if any) —
      // the RPC re-validates this driver is still active for this
      // service at the moment of insert and, only if so, assigns them
      // to the trip immediately (status → 'assigned'). If the driver
      // is gone/inactive by now, or nothing was picked, this is simply
      // null and behavior is identical to before (status stays 'new').
      p_selected_driver_phone: state.featuredDriverPhone || null,
    };
    console.log('[SUBMIT] 18/20 payload built:', submitPayload);

    step = 'check supabaseClient';
    console.log('[SUBMIT] 19/20 typeof supabaseClient =', typeof supabaseClient, supabaseClient);
    if (!supabaseClient || typeof supabaseClient.rpc !== 'function') {
      throw new Error('supabaseClient is missing or not initialized (typeof=' + typeof supabaseClient + ') — check script load order / that the Supabase config script runs before app.js');
    }

    step = 'await supabaseClient.rpc(submit_trip_request)';
    console.log('[SUBMIT] 20/20 calling supabaseClient.rpc("submit_trip_request", ...) now — if this is the LAST line you see, the request never left the browser.');
    const { data, error } = await supabaseClient
      .rpc('submit_trip_request', submitPayload)
      .single();

    step = 'after rpc call returned';
    console.log('[SUBMIT] rpc() returned. error =', error, ' data =', data);

    if (error) throw error;

    // ⚠️ Design change (see migration 3 / FINAL_DESIGN.md): the queue
    // bump (last_served_at + request_count) now happens ATOMICALLY
    // *inside* submit_trip_request itself — for BOTH the case where the
    // customer picked a specific driver AND the new case where nobody
    // was picked and the RPC auto-assigns the front-of-queue driver
    // server-side. A separate select_driver() call here would DOUBLE-
    // bump the same driver for the same booking, corrupting fairness
    // stats. So this call is intentionally gone — do not re-add it.
    state.featuredDriverId = null;
    state.featuredDriverPhone = null;

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
    console.log('[SUBMIT] success — request_number:', data.request_number);
  } catch (err) {
    // Log the REAL Postgres/PostgREST error (message/details/hint/code)
    // instead of only the generic object — this is what actually shows
    // the true cause (e.g. an outdated CHECK constraint, a missing grant,
    // vs. an actual network failure) in the browser console. Also logs
    // WHICH step failed, since the try/catch now covers the entire
    // function instead of only the RPC call.
    console.error(`[SUBMIT] FAILED at step "${step}":`, {
      message: err?.message, details: err?.details, hint: err?.hint, code: err?.code, name: err?.name, raw: err,
    });
    showView('booking');
    sheet.setSnap('full');

    // ============================================================
    // TEMPORARY ON-SCREEN DIAGNOSTIC (remove once root cause is
    // confirmed — see request to restore the plain user-facing message
    // afterward). Console isn't reachable from the reporter's iPhone,
    // so surface the same step name + real error detail that
    // console.error already logs above, directly in the visible
    // error banner (showMsg → #appMsg, via textContent, so this is
    // safe from HTML injection regardless of error content).
    // ============================================================
    const diagnosticDetail = [
      err?.message,
      err?.code ? `code=${err.code}` : null,
      err?.hint ? `hint=${err.hint}` : null,
      err?.details ? `details=${err.details}` : null,
    ].filter(Boolean).join(' | ') || String(err);
    showMsg(`تعذّر إرسال الطلب. [تشخيص مؤقت] فشل عند الخطوة: "${step}" — ${diagnosticDetail}`);
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
    `مرحباً، لدي طلب رحلة على يمّك\n` +
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
// Stage 2 — short, generic one-line descriptors shown under each
// service name (subtitle), matching the title+description row layout
// in the reference design. Static display copy only — not fetched
// from Supabase, not used in pricing/logic, so loadServicePrices()
// (which only overwrites label/base/perKm) is unaffected.
const SERVICE_TAGLINES = {
  taxi: 'الخيار الأفضل لتنقلاتك اليومية',
  private: 'رحلة خاصة وراحة أكثر',
  courier: 'توصيل سريع للطرود',
  intercity: 'رحلات بين المحافظات',
  cargo: 'نقل الأغراض والحمولات',
  starx: 'نقل عدة أشخاص دفعة واحدة',
};

// Stage — shared fallback for the real vehicle <img> photos above: if
// a photo file hasn't been added yet (or fails to load) for a given
// service, swap that single <img> out for the old flat SVG icon so
// the row/pill still looks correct instead of showing a broken-image
// glyph. Purely cosmetic, DOM-only — no service data/logic touched.
function vehiclePhotoFallback(imgEl, serviceKey) {
  const wrap = document.createElement('span');
  wrap.className = imgEl.className === 'svc-pill-photo' ? 'svc-pill-photo-fallback' : 'qs-row-photo-fallback';
  wrap.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[SERVICES[serviceKey]?.icon] || ''}</svg>`;
  imgEl.replaceWith(wrap.firstChild);
}

// Stage — quick-service selector rebuilt as a single vertical list of
// rows (icon + title/subtitle + trailing chevron) instead of a grid of
// icon tiles, matching the reference design's ride-option list
// pattern. Same data source (SERVICES), same data-service attribute,
// same click handler (openBooking) — only the markup/classes are new,
// so nothing else in app.js needs to change. Price is intentionally
// left out of this row (kept hidden from the customer, same as
// elsewhere in the app — see .price-bar).
function buildQuickServiceChips() {
  const wrap = document.getElementById('quickServices');
  wrap.innerHTML = Object.entries(SERVICES).map(([key, svc]) => `
    <button type="button" class="qs-row" data-service="${key}">
      <span class="qs-row-ic"><img class="qs-row-photo" src="${VEHICLE_PHOTOS[key]}" alt="${svc.label}" loading="lazy" onerror="vehiclePhotoFallback(this, '${key}')"></span>
      <span class="qs-row-label">
        <b>${svc.label}</b>
        <span>${SERVICE_TAGLINES[key] || ''}</span>
      </span>
      <span class="qs-row-chev"><svg viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>
  `).join('');
  wrap.querySelectorAll('.qs-row').forEach(chip => {
    chip.addEventListener('click', () => openBooking(chip.dataset.service));
  });
}

// Stage — service switch (inside the booking form) now shows the same
// realistic, full-color vehicle icon as the list above instead of a
// single-tone masked silhouette. Same data-service attribute, same
// click handler (selectService).
function buildServiceSwitch() {
  const wrap = document.getElementById('svcSwitch');
  wrap.innerHTML = Object.entries(SERVICES).map(([key, svc]) => `
    <button type="button" class="svc-pill" data-service="${key}">
      <img class="svc-pill-photo" src="${VEHICLE_PHOTOS[key]}" alt="${svc.label}" loading="lazy" onerror="vehiclePhotoFallback(this, '${key}')">
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
// No persistent install button over the map anymore (topbar button
// removed). This flag is the single source of truth for whether an
// install action is currently offerable, and drives the visibility of
// the remaining install entry points (welcome screen + "More" menu).
let installAvailable = false;

function injectInstallCardStyles() {
  if (document.getElementById('pwaInstallStyles')) return;
  const style = document.createElement('style');
  style.id = 'pwaInstallStyles';
  style.textContent = `
    #pwaInstallCard {
      position: fixed;
      left: 16px;
      right: 16px;
      bottom: calc(var(--bnav-h, 60px) + env(safe-area-inset-bottom) + 12px);
      z-index: 45;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      border-radius: 16px;
      background: var(--bg-deep, #fff);
      color: var(--text, #263746);
      box-shadow: var(--shadow-deep, 0 10px 28px -12px rgba(50,90,120,0.25));
      border: 1px solid var(--surface-brd, #DCEAF3);
      font-family: inherit;
      direction: rtl;
      transform: translateY(120%);
      transition: transform 0.3s ease;
    }
    #pwaInstallCard.show { transform: translateY(0); }
    #pwaInstallCard .pwa-icon {
      width: 40px; height: 40px; flex-shrink: 0;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--gold, #E5B85C), var(--teal, #1D6FD1));
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
      font-weight: 700;
      color: #fff;
      background: linear-gradient(180deg, var(--teal-soft, #4A90D9), var(--teal, #1D6FD1));
      cursor: pointer;
    }
    #pwaInstallCard .pwa-close-btn {
      flex-shrink: 0;
      border: none;
      background: transparent;
      color: var(--text-faint, #8091A0);
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
      <b>ثبّت تطبيق يمّك</b>
      <span>وصول أسرع بدون فتح المتصفح في كل مرة</span>
    </span>
    <button type="button" class="pwa-install-btn" id="pwaInstallBtn">تثبيت التطبيق</button>
    <button type="button" class="pwa-close-btn" id="pwaCloseBtn" aria-label="إغلاق">✕</button>
  `;
  document.body.appendChild(card);
  requestAnimationFrame(() => card.classList.add('show'));

  document.getElementById('pwaInstallBtn').addEventListener('click', triggerInstall);

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

// Shared by the bottom install card's button, the welcome screen's
// install button, and the "More" menu entry — all just trigger the one
// captured beforeinstallprompt event the same way. On iOS/Safari, where
// that event never exists, tapping instead opens the dedicated
// "Add to Home Screen" modal dialog (see below) — always does something
// useful, immediately, on every platform.
async function triggerInstall() {
  if (deferredInstallPrompt) {
    const capturedPrompt = deferredInstallPrompt;
    // The captured beforeinstallprompt event can go stale (Chrome
    // invalidates it after enough time passes, or if it was already
    // used once) — calling .prompt()/.userChoice on a stale event
    // throws, and with no catch here that error used to abort this
    // whole async function silently: no native dialog, no toast, no
    // fallback — the button just sat there looking broken. Wrapping
    // this in try/catch guarantees the tap always does something
    // visible, on every path.
    try {
      capturedPrompt.prompt();
      const { outcome } = await capturedPrompt.userChoice;
      deferredInstallPrompt = null;
      installAvailable = false;
      hideInstallCard();
      syncWelcomeInstallVisibility();
      syncMoreInstallVisibility();
      if (outcome === 'accepted') {
        localStorage.setItem(PWA_INSTALLED_KEY, '1');
      } else {
        // Dismissing the native mini-prompt is easy to do by accident
        // (small system UI, tap outside it, etc.) and Chrome won't
        // re-offer this same captured event again — so without this
        // message, the button simply vanishing looks identical to the
        // tap having done nothing at all.
        toast('تم إغلاق نافذة التثبيت — يمكنك التثبيت لاحقًا من قائمة المتصفح (⋮)');
      }
    } catch (err) {
      // Stale/invalid captured event: the native prompt failed to open.
      // Reset state and fall back to something the tap can still do,
      // instead of leaving the button visible but inert.
      deferredInstallPrompt = null;
      installAvailable = false;
      hideInstallCard();
      syncWelcomeInstallVisibility();
      syncMoreInstallVisibility();
      if (isIosDevice()) {
        showIosInstallModal();
      } else {
        toast('تعذّر فتح نافذة التثبيت الآن — افتح قائمة المتصفح (⋮) واختر "تثبيت التطبيق" أو "إضافة إلى الشاشة الرئيسية"');
      }
    }
    return;
  }
  if (isIosDevice()) {
    showIosInstallModal();
    return;
  }
  // Real PWA install isn't available right now — either the browser
  // doesn't support it, the app is already installed, or Chrome hasn't
  // judged the visit "engaged enough" yet to offer beforeinstallprompt.
  // Rather than doing nothing, tell the customer what to do instead.
  if (isStandaloneDisplay() || localStorage.getItem(PWA_INSTALLED_KEY) === '1') {
    toast('التطبيق مثبّت لديك بالفعل ✓');
  } else {
    toast('التثبيت غير متاح الآن على هذا المتصفح — افتح قائمة المتصفح (⋮) واختر "تثبيت التطبيق" أو "إضافة إلى الشاشة الرئيسية"');
  }
}

function initPwaInstallPrompt() {
  const alreadyInstalled = localStorage.getItem(PWA_INSTALLED_KEY) === '1';

  if (!alreadyInstalled) {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      showInstallCard();
      // Android: also reveal the welcome screen and "More" menu install
      // entries, so the offer to install stays reachable even after the
      // bottom card is dismissed (Chrome only fires this event once it
      // judges the visit "engaged enough" — timing it can't control from
      // here).
      installAvailable = true;
      syncWelcomeInstallVisibility();
      syncMoreInstallVisibility();
    });

    window.addEventListener('appinstalled', () => {
      localStorage.setItem(PWA_INSTALLED_KEY, '1');
      deferredInstallPrompt = null;
      hideInstallCard();
      installAvailable = false;
      syncWelcomeInstallVisibility();
      syncMoreInstallVisibility();
    });
  }

  // iOS/Safari never fires beforeinstallprompt, so without this the
  // install entries would simply never appear there. Show them upfront
  // instead — triggerInstall() already knows to open the modal for it
  // when tapped, since no native install dialog exists on iOS.
  if (!alreadyInstalled && isIosDevice() && !isStandaloneDisplay()) {
    installAvailable = true;
  }

  syncWelcomeInstallVisibility();
  syncMoreInstallVisibility();
}

/* ============================================================
   iOS "Add to Home Screen" modal (#iosInstallModal, static markup in
   index.html) — Safari never fires beforeinstallprompt, so there is no
   programmatic install dialog on iPhone/iPad. This is the ONLY place
   the explanation is ever shown: not automatically, not at the bottom
   of the page, not inside the FAQ — strictly on demand, the instant the
   install button is tapped (see triggerInstall above).
   ============================================================ */
function isIosDevice() {
  const ua = window.navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document);
}

function isStandaloneDisplay() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function showIosInstallModal() {
  const modal = document.getElementById('iosInstallModal');
  if (!modal) return;
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('show'));
}

function hideIosInstallModal() {
  const modal = document.getElementById('iosInstallModal');
  if (!modal) return;
  modal.classList.remove('show');
  setTimeout(() => { modal.hidden = true; }, 200);
}

function initIosInstallModal() {
  const modal = document.getElementById('iosInstallModal');
  const closeBtn = document.getElementById('iosModalCloseBtn');
  if (!modal || !closeBtn) return;
  closeBtn.addEventListener('click', hideIosInstallModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) hideIosInstallModal(); // tap on the backdrop itself
  });
}

/* ============================================================
   In-app browser detection (Facebook / Messenger / Instagram /
   TikTok / Threads and similar embedded WebViews) — these don't
   reliably support real PWA installation: Android in-app WebViews
   generally never fire beforeinstallprompt, and iOS in-app browsers
   don't expose a working "Add to Home Screen" the way Safari does.
   Detecting this and helping the visitor reach a real browser is
   what makes install actually work afterwards.

   Behavior per platform/app, as requested:
   - Android (any detected in-app browser): a clear "فتح في المتصفح"
     button attempts Chrome via an Android intent:// URL; if Chrome
     isn't available the intent's own browser_fallback_url hands off
     to the device's default browser at the OS level.
   - iOS + Instagram/Threads: a button attempts the "x-safari-https://"
     handoff those two apps' WebViews are known to honor; if it
     doesn't visibly leave the page, we fall back to the same
     step-by-step guide used below.
   - iOS + Facebook/Messenger/TikTok (or any other detected iOS
     in-app browser): per Apple's WebView sandboxing there is no
     reliable way to force Safari to open, so we go straight to a
     clear instructional dialog: tap (⋯) then "Open in Safari".

   Purely additive: does not change triggerInstall(),
   initPwaInstallPrompt(), the existing iOS install modal, or any
   other install entry point. Self-contained (styles injected via
   JS) — does not touch index.html, app.css, style.css, or
   Supabase/schema.
   ============================================================ */
const INAPP_DISMISSED_KEY = 'mustaqbali_inapp_browser_dismissed_at';
const INAPP_DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000; // يوم واحد

const INAPP_LABELS = {
  facebook: 'فيسبوك',
  messenger: 'ماسنجر',
  instagram: 'إنستغرام',
  threads: 'Threads',
  tiktok: 'تيك توك',
  line: 'Line',
  wechat: 'WeChat',
  snapchat: 'سناب شات',
  twitter: 'X (Twitter)'
};

// Returns a short app key ('facebook', 'messenger', 'instagram',
// 'threads', 'tiktok', ...) for the in-app browser hosting this page,
// or null when the page is running in a normal browser. Order matters:
// Instagram/Threads/Messenger user agents can also contain the generic
// Facebook "FBAN/FBAV" tokens, so the more specific apps are checked
// first.
function detectInAppBrowser() {
  const ua = navigator.userAgent || '';
  if (/Instagram/i.test(ua)) return 'instagram';
  if (/Threads|Barcelona/i.test(ua)) return 'threads';
  if (/Messenger/i.test(ua)) return 'messenger';
  if (/FBAN|FBAV|FB_IAB|FBIOS|FBSV/i.test(ua)) return 'facebook';
  if (/musical_ly|BytedanceWebview|TikTok/i.test(ua)) return 'tiktok';
  if (/Line\//i.test(ua)) return 'line';
  if (/MicroMessenger/i.test(ua)) return 'wechat';
  if (/Snapchat/i.test(ua)) return 'snapchat';
  if (/Twitter/i.test(ua)) return 'twitter';
  return null;
}

function isInAppBrowser() {
  return detectInAppBrowser() !== null;
}

function isAndroidDevice() {
  return /Android/i.test(navigator.userAgent || '');
}

// Builds an Android "intent://" URL that asks the OS to hand the
// current page to Chrome specifically, while also carrying a
// browser_fallback_url — if Chrome isn't installed/resolvable,
// Android itself falls back to opening the URL in the device's
// default browser, with no extra JS needed for that part.
function buildAndroidChromeIntentUrl(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const scheme = u.protocol.replace(':', '');
    const withoutScheme = u.href.replace(/^https?:\/\//, '');
    const fallback = encodeURIComponent(u.href);
    return `intent://${withoutScheme}#Intent;scheme=${scheme};package=com.android.chrome;S.browser_fallback_url=${fallback};end;`;
  } catch {
    return null;
  }
}

function attemptOpenInExternalBrowserAndroid() {
  const targetUrl = window.location.href;
  const intentUrl = buildAndroidChromeIntentUrl(targetUrl);
  if (!intentUrl) {
    window.location.href = targetUrl;
    return;
  }

  // Primary attempt: hand off to Chrome (with the OS-level fallback to
  // the default browser described above).
  window.location.href = intentUrl;

  // Secondary, client-side safety net: some in-app WebViews block
  // "intent://" navigation outright rather than letting the OS resolve
  // it, in which case we're still on the same page a moment later. A
  // plain reload of the https URL is the only remaining fallback
  // reachable from JS in that case.
  setTimeout(() => {
    if (document.visibilityState === 'visible') {
      window.location.href = targetUrl;
    }
  }, 1200);
}

// Builds the "x-safari-https://" / "x-safari-http://" URL that
// Instagram's and Threads' iOS WebViews are known to honor as a
// handoff to Safari. Facebook, Messenger, and TikTok's iOS WebViews do
// not reliably honor this, which is why they skip straight to the
// manual instructions below instead.
function buildIosSafariUrl(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (u.protocol === 'https:') return 'x-safari-https://' + u.href.slice('https://'.length);
    if (u.protocol === 'http:') return 'x-safari-http://' + u.href.slice('http://'.length);
  } catch {
    /* fall through */
  }
  return null;
}

function attemptForceSafariIOS() {
  const targetUrl = window.location.href;
  const safariUrl = buildIosSafariUrl(targetUrl);
  if (safariUrl) {
    window.location.href = safariUrl;
  }
  // If the handoff didn't actually leave the page, fall back to the
  // same clear step-by-step guide used for Facebook/Messenger/TikTok.
  setTimeout(() => {
    if (document.visibilityState === 'visible') {
      showIosManualOpenGuide();
    }
  }, 1200);
}

function injectInAppBrowserStyles() {
  if (document.getElementById('inAppBrowserStyles')) return;
  const style = document.createElement('style');
  style.id = 'inAppBrowserStyles';
  style.textContent = `
    #inAppBrowserCard {
      position: fixed;
      left: 16px;
      right: 16px;
      top: calc(env(safe-area-inset-top) + 12px);
      z-index: 2147483000;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      border-radius: 16px;
      background: var(--bg-deep, #fff);
      color: var(--text, #263746);
      box-shadow: var(--shadow-deep, 0 10px 28px -12px rgba(50,90,120,0.35));
      border: 1px solid var(--surface-brd, #DCEAF3);
      font-family: inherit;
      direction: rtl;
      transform: translateY(-140%);
      transition: transform 0.3s ease;
    }
    #inAppBrowserCard.show { transform: translateY(0); }
    #inAppBrowserCard .inapp-icon { flex-shrink: 0; font-size: 20px; line-height: 1; }
    #inAppBrowserCard .inapp-text { flex: 1; min-width: 0; }
    #inAppBrowserCard .inapp-text b { display: block; font-size: 14px; }
    #inAppBrowserCard .inapp-text span { display: block; font-size: 12px; opacity: 0.75; margin-top: 2px; }
    #inAppBrowserCard .inapp-open-btn {
      flex-shrink: 0;
      border: none;
      border-radius: 10px;
      padding: 9px 14px;
      font-size: 13px;
      font-weight: 700;
      color: #fff;
      background: linear-gradient(180deg, var(--teal-soft, #4A90D9), var(--teal, #1D6FD1));
      cursor: pointer;
      white-space: nowrap;
    }
    #inAppBrowserCard .inapp-close-btn {
      flex-shrink: 0;
      border: none;
      background: transparent;
      color: var(--text-faint, #8091A0);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 4px;
    }

    #inAppGuideBackdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483100;
      background: rgba(10,20,35,0.55);
      display: flex;
      align-items: flex-end;
      justify-content: center;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
    }
    #inAppGuideBackdrop.show { opacity: 1; pointer-events: auto; }
    #inAppGuideBackdrop .inapp-guide-card {
      width: 100%;
      max-width: 420px;
      background: var(--bg-deep, #fff);
      color: var(--text, #263746);
      border-radius: 20px 20px 0 0;
      padding: 22px 20px calc(env(safe-area-inset-bottom) + 20px);
      direction: rtl;
      font-family: inherit;
      transform: translateY(20px);
      transition: transform 0.25s ease;
    }
    #inAppGuideBackdrop.show .inapp-guide-card { transform: translateY(0); }
    #inAppGuideBackdrop .inapp-guide-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
      gap: 10px;
    }
    #inAppGuideBackdrop .inapp-guide-head h3 { font-size: 16px; margin: 0; }
    #inAppGuideBackdrop .inapp-guide-close {
      border: none;
      background: transparent;
      font-size: 18px;
      color: var(--text-faint, #8091A0);
      cursor: pointer;
      padding: 4px;
      flex-shrink: 0;
    }
    #inAppGuideBackdrop ol { margin: 0; padding-inline-start: 20px; }
    #inAppGuideBackdrop li { font-size: 14px; line-height: 1.9; margin-bottom: 6px; }
    #inAppGuideBackdrop li b { color: var(--teal-text, #1D6FD1); }
  `;
  document.head.appendChild(style);
}

function hideInAppBrowserNotice() {
  const card = document.getElementById('inAppBrowserCard');
  if (!card) return;
  card.classList.remove('show');
  setTimeout(() => card.remove(), 300);
}

function hideIosManualOpenGuide() {
  const backdrop = document.getElementById('inAppGuideBackdrop');
  if (!backdrop) return;
  backdrop.classList.remove('show');
  setTimeout(() => backdrop.remove(), 250);
}

function showIosManualOpenGuide() {
  if (document.getElementById('inAppGuideBackdrop')) return;
  injectInAppBrowserStyles();

  const backdrop = document.createElement('div');
  backdrop.id = 'inAppGuideBackdrop';
  backdrop.innerHTML = `
    <div class="inapp-guide-card">
      <div class="inapp-guide-head">
        <h3>لأفضل تجربة، افتح الرابط في Safari</h3>
        <button type="button" class="inapp-guide-close" id="inAppGuideCloseBtn" aria-label="إغلاق">✕</button>
      </div>
      <ol>
        <li>اضغط على زر <b>(⋯)</b> الظاهر أعلى الشاشة</li>
        <li>اختر من القائمة <b>"Open in Safari"</b> (فتح في Safari)</li>
        <li>بعد فتح الرابط في Safari، يمكنك تثبيت التطبيق من: مشاركة ← إضافة إلى الشاشة الرئيسية</li>
      </ol>
    </div>
  `;
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('show'));

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) hideIosManualOpenGuide();
  });
  document.getElementById('inAppGuideCloseBtn').addEventListener('click', hideIosManualOpenGuide);
}

function showInAppBrowserNotice(app) {
  const dismissedAt = Number(localStorage.getItem(INAPP_DISMISSED_KEY) || 0);
  if (dismissedAt && Date.now() - dismissedAt < INAPP_DISMISS_COOLDOWN_MS) return;
  if (document.getElementById('inAppBrowserCard')) return;

  injectInAppBrowserStyles();

  const android = isAndroidDevice();
  const ios = isIosDevice();
  const label = INAPP_LABELS[app] || 'هذا التطبيق';

  let actionHtml = '';
  let actionHandler = null;

  if (android) {
    actionHtml = `<button type="button" class="inapp-open-btn" id="inAppOpenBtn">فتح في المتصفح</button>`;
    actionHandler = attemptOpenInExternalBrowserAndroid;
  } else if (ios && (app === 'instagram' || app === 'threads')) {
    actionHtml = `<button type="button" class="inapp-open-btn" id="inAppOpenBtn">فتح في Safari</button>`;
    actionHandler = attemptForceSafariIOS;
  } else if (ios) {
    actionHtml = `<button type="button" class="inapp-open-btn" id="inAppOpenBtn">عرض التعليمات</button>`;
    actionHandler = showIosManualOpenGuide;
  }

  const card = document.createElement('div');
  card.id = 'inAppBrowserCard';
  card.innerHTML = `
    <span class="inapp-icon">⚠️</span>
    <span class="inapp-text">
      <b>افتح الرابط في متصفحك</b>
      <span>أنت تتصفح من داخل تطبيق ${label} — لتجربة كاملة وتثبيت التطبيق بنجاح، يُرجى المتابعة عبر Chrome أو Safari</span>
    </span>
    ${actionHtml}
    <button type="button" class="inapp-close-btn" id="inAppCloseBtn" aria-label="إغلاق">✕</button>
  `;
  document.body.appendChild(card);
  requestAnimationFrame(() => card.classList.add('show'));

  const openBtn = document.getElementById('inAppOpenBtn');
  if (openBtn && actionHandler) {
    openBtn.addEventListener('click', actionHandler);
  }

  document.getElementById('inAppCloseBtn').addEventListener('click', () => {
    localStorage.setItem(INAPP_DISMISSED_KEY, String(Date.now()));
    hideInAppBrowserNotice();
  });
}

function initInAppBrowserNotice() {
  const app = detectInAppBrowser();
  if (!app) return;
  showInAppBrowserNotice(app);
}

/* ============================================================
   iOS keyboard / viewport handling
   Uses the VisualViewport API (supported on iOS Safari 13+ and all
   modern Android browsers) to detect the on-screen keyboard opening
   and keep the focused field visible instead of letting it hide
   behind the keyboard or the bottom sheet collapsing awkwardly.
   ============================================================ */
// FIX (bug #3 helper): scrolls a field into view using ONLY the app's
// internal .sheet-scroll container, never window/document scroll — see
// initViewportHandling() below for why. Shared by the keyboard-focus
// handler and the "طلب" driver-list handler, which had the same
// document-level scrollIntoView() call causing the same white-gap bug.
function scrollFieldIntoSheetView(el) {
  if (!el) return;
  const scrollEl = el.closest('.sheet-scroll');
  if (!scrollEl) return;
  const fieldRect = el.getBoundingClientRect();
  const boxRect = scrollEl.getBoundingClientRect();
  const delta = (fieldRect.top - boxRect.top) - (boxRect.height / 2) + (fieldRect.height / 2);
  scrollEl.scrollTop += delta;
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
}

function initViewportHandling() {
  // --- Anti page-zoom guard ---------------------------------------------
  // The viewport <meta> tag's user-scalable=no is NOT enough on its own:
  // iOS Safari has ignored it since iOS 10 for accessibility reasons, so a
  // two-finger touch anywhere (map, services panel, booking sheet) can
  // still trigger the browser's native page zoom. Actively cancelling the
  // Safari-only 'gesture*' events is what actually stops it there, while
  // still letting Leaflet's own touch/pointer-based map pinch-zoom work
  // normally (it doesn't use these events).
  const cancelGesture = (e) => e.preventDefault();
  document.addEventListener('gesturestart', cancelGesture, { passive: false });
  document.addEventListener('gesturechange', cancelGesture, { passive: false });
  document.addEventListener('gestureend', cancelGesture, { passive: false });

  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  let baseHeight = vv.height;

  // Self-healing fallback: if the page scale ever ends up above 1 anyway
  // (e.g. an edge case the guard above missed), snap it back to normal
  // immediately — no reload/close-and-reopen needed.
  const resetZoomIfStuck = () => {
    if (vv.scale && vv.scale > 1.01) {
      const meta = document.querySelector('meta[name="viewport"]');
      if (meta) {
        const original = meta.getAttribute('content');
        meta.setAttribute('content', original + ', maximum-scale=1.0');
        requestAnimationFrame(() => meta.setAttribute('content', original));
      }
    }
  };

  vv.addEventListener('resize', () => {
    resetZoomIfStuck();
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

  // FIX (bug #3 — white gap / page jumps up when typing): html and
  // body are position:fixed with overflow:hidden (see app.css) so the
  // *document* can never scroll — but the old code still called
  // e.target.scrollIntoView(...) directly on the focused input. On iOS
  // Safari in particular, asking the browser to scroll an element
  // "into view" can still nudge the outer page/visual viewport even
  // when its fixed ancestors supposedly can't scroll, which is what
  // left a blank strip above/below the fixed app shell. The fix scrolls
  // ONLY the app's own internal scroll container (.sheet-scroll) by
  // computing the offset manually, and never touches window/document
  // scroll at all — so there's nothing for iOS to misinterpret.
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('input, textarea')) {
      setTimeout(() => scrollFieldIntoSheetView(e.target), 300);
    }
  });

  // Same safety net on its own, independent of focus events — catches
  // any stray scroll the OS/browser triggers on its own (e.g. while the
  // keyboard is animating open/closed) rather than only right after a
  // field is focused.
  window.addEventListener('scroll', () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  }, { passive: true });
}

/* ============================================================
   "مساعد يمّك" — FAQ accordion (home view, index.html only).
   The trigger button now lives in the top quick-access row
   (#helpToggleBtn) and the FAQ content (#helpAccordionWrap) is a
   separate sibling block — both get `open` toggled together by this
   one click handler. Self-contained; touches no existing state, view,
   or booking/request logic.
   ============================================================ */
function initHelpAccordion() {
  const toggleBtn = document.getElementById('helpToggleBtn');
  const wrapEl = document.getElementById('helpAccordionWrap');
  if (toggleBtn && wrapEl) {
    toggleBtn.addEventListener('click', () => {
      const isOpen = wrapEl.classList.toggle('open');
      toggleBtn.classList.toggle('open', isOpen);
      toggleBtn.setAttribute('aria-expanded', String(isOpen));
      haptic();
    });
  }

  const wrap = document.getElementById('helpAccordion');
  if (!wrap) return;

  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.help-q');
    if (!btn) return;
    const item = btn.closest('.help-item');
    const wasOpen = item.classList.contains('open');

    wrap.querySelectorAll('.help-item.open').forEach((el) => {
      el.classList.remove('open');
      el.querySelector('.help-q').setAttribute('aria-expanded', 'false');
    });

    if (!wasOpen) {
      item.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
    haptic();
  });
}

/* ============================================================
   Bottom navigation — الرئيسية / طلباتي / بياناتي / المزيد.
   Fixed, always on top (see CSS), position never changes with the
   sheet drag. Self-contained: does not touch request/driver/admin
   logic. "طلباتي" reuses the exact same status view already used
   right after a real submission (state.lastSubmission +
   renderStatusView).
   ============================================================ */
/* ============================================================
   Bottom navigation — الرئيسية / طلباتي / الدعم / بياناتي / المزيد.
   Fixed, always on top (see CSS), position never changes with the
   sheet (drag is disabled — see BottomSheet above). Self-contained:
   does not touch request/driver/admin logic. "طلباتي" uses the real
   get_customer_trip_history RPC (see migration_v1.3.sql) — current +
   past requests, by phone, same trust model as get_trip_request_status.
   ============================================================ */
function setActiveNavTab(view) {
  const map = { home: 'home', booking: 'home', submitting: 'requests', status: 'requests', orders: 'requests', support: 'support', more: 'more', profile: 'profile' };
  const activeKey = map[view] || null;
  document.querySelectorAll('.bnav-item[data-nav]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.nav === activeKey);
  });
}

/* ============================================================
   "طلباتي" — current + past requests, matched by the customer's own
   phone number (from the last submission this session, or the saved
   profile). Uses the real get_customer_trip_history RPC — no fake
   data, no Math.random(); if that migration hasn't been applied yet,
   the RPC call simply errors and the Empty State is shown, exactly
   as if there were no orders (never a fabricated list).
   ============================================================ */
const ORDER_STATUS_LABELS = { new: 'جديد', assigned: 'تم التعيين', en_route: 'قيد التنفيذ', arrived: 'تم الوصول', completed: 'مكتملة', cancelled: 'ملغى' };
const ORDER_STATUS_CLASS = { new: 'badge-live', assigned: 'badge-live', en_route: 'badge-live', arrived: 'badge-live', completed: 'badge-done', cancelled: 'badge-offline' };

function formatOrderDateTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ar-IQ', { day: 'numeric', month: 'short' }) + ' — ' + d.toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

async function loadOrdersTab() {
  const wrap = document.getElementById('ordersList');
  const empty = document.getElementById('ordersEmpty');
  if (!wrap || !empty) return;

  const phone = state.lastSubmission?.phone || getSavedProfile()?.phone || '';
  wrap.innerHTML = '';
  wrap.hidden = true;
  empty.hidden = true;

  if (!phone) { empty.hidden = false; return; }

  try {
    const { data, error } = await supabaseClient.rpc('get_customer_trip_history', { p_phone: phone, p_limit: 20 });
    if (error || !data || data.length === 0) { empty.hidden = false; return; }

    wrap.innerHTML = data.map((row) => {
      const isOpen = !['completed', 'cancelled'].includes(row.status);
      const statusCls = ORDER_STATUS_CLASS[row.status] || 'badge-live';
      const statusLabel = ORDER_STATUS_LABELS[row.status] || row.status;
      return `
        <div class="order-card">
          <div class="order-card-top">
            <span class="req-chip">#${escapeHtml(row.request_number || '')}</span>
            <span class="${statusCls}">${escapeHtml(statusLabel)}</span>
          </div>
          <div class="order-card-svc">${escapeHtml(SERVICES[row.service_type]?.label || row.service_type)}</div>
          <div class="order-card-route">
            <span>${escapeHtml(row.pickup_location || '—')}</span>
            ${row.dropoff_location ? `<span class="order-arrow">←</span><span>${escapeHtml(row.dropoff_location)}</span>` : ''}
          </div>
          <div class="order-card-time">${formatOrderDateTime(row.created_at)}</div>
          ${isOpen ? `<button type="button" class="app-btn secondary order-track-btn" data-track-order="${escapeHtml(row.request_number || '')}">تتبع الطلب</button>` : ''}
        </div>
      `;
    }).join('');

    wrap.hidden = false;

    wrap.querySelectorAll('[data-track-order]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = data.find((r) => r.request_number === btn.dataset.trackOrder);
        if (!row) return;
        state.lastSubmission = {
          id: null,
          request_number: row.request_number,
          phone,
          service_type: row.service_type,
          pickup: row.pickup_location,
          dropoff: row.dropoff_location,
          created_at: row.created_at,
        };
        state.lastKnownStatus = row.status;
        renderStatusView();
        showView('status');
        startStatusPolling();
        haptic();
      });
    });
  } catch (err) {
    console.error('loadOrdersTab failed', err);
    empty.hidden = false;
  }
}

function initBottomNav() {
  const homeBtn = document.getElementById('bnavHome');
  const requestsBtn = document.getElementById('bnavRequests');
  const supportBtn = document.getElementById('bnavSupport');
  const profileBtn = document.getElementById('bnavProfile');
  const moreBtn = document.getElementById('bnavMore');

  if (homeBtn) homeBtn.addEventListener('click', () => { backToHome(); haptic(); });

  if (requestsBtn) {
    requestsBtn.addEventListener('click', () => {
      showView('orders');
      loadOrdersTab();
      haptic();
    });
  }

  if (supportBtn) {
    supportBtn.addEventListener('click', () => {
      showView('support');
      haptic();
    });
  }

  if (profileBtn) {
    profileBtn.addEventListener('click', () => {
      loadProfileIntoForm();
      showView('profile');
      sheet.setSnap('full');
      haptic();
    });
  }

  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      showView('more');
      sheet.setSnap('full');
      haptic();
    });
  }
}

/* ============================================================
   "More" view — accordion for About/Terms/Privacy, a direct shortcut
   into the "الدعم" tab (where the FAQ + call/WhatsApp now live as
   their own dedicated tab), and an install-app shortcut mirroring
   the topbar button's own visibility logic.
   ============================================================ */
function initMoreView() {
  const moreList = document.querySelector('.more-list');
  if (moreList) {
    moreList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-more-toggle]');
      if (!btn) return;
      const key = btn.dataset.moreToggle;
      const panel = document.getElementById('morePanel-' + key);
      if (!panel) return;
      const wasOpen = !panel.hidden;
      document.querySelectorAll('.more-panel').forEach((p) => { p.hidden = true; });
      moreList.querySelectorAll('[data-more-toggle]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
      if (!wasOpen) {
        panel.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
      }
      haptic();
    });
  }

  const assistantBtn = document.getElementById('moreAssistantBtn');
  if (assistantBtn) {
    assistantBtn.addEventListener('click', () => {
      const helpToggleBtn = document.getElementById('helpToggleBtn');
      const helpAccordionWrap = document.getElementById('helpAccordionWrap');
      showView('support');
      if (helpToggleBtn && helpAccordionWrap && !helpAccordionWrap.classList.contains('open')) {
        helpToggleBtn.click();
      }
      haptic();
    });
  }

  const installMoreBtn = document.getElementById('moreInstallBtn');
  if (installMoreBtn) {
    installMoreBtn.addEventListener('click', () => { triggerInstall(); haptic(); });
    syncMoreInstallVisibility();
  }
}

// Keeps the "More" menu install entry in sync with the shared
// installAvailable flag (see initPwaInstallPrompt / triggerInstall).
function syncMoreInstallVisibility() {
  const moreBtn = document.getElementById('moreInstallBtn');
  if (!moreBtn) return;
  moreBtn.hidden = !installAvailable;
}

/* ============================================================
   Profile (بياناتي) — name + phone saved locally, used to
   auto-fill the booking form's customerName/phone fields. Purely
   client-side (localStorage): no Supabase table, no request/driver
   logic touched.
   ============================================================ */
const PROFILE_STORAGE_KEY = 'mustaqbali_profile';

function getSavedProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadProfileIntoForm() {
  const profile = getSavedProfile();
  const nameEl = document.getElementById('profileName');
  const phoneEl = document.getElementById('profilePhone');
  if (profile && nameEl) nameEl.value = profile.name || '';
  if (profile && phoneEl) phoneEl.value = profile.phone || '';
}

function applyProfileToBookingForm() {
  const profile = getSavedProfile();
  if (!profile) return;
  const nameField = document.getElementById('customerName');
  const phoneField = document.getElementById('phone');
  if (nameField && !nameField.value && profile.name) nameField.value = profile.name;
  if (phoneField && !phoneField.value && profile.phone) phoneField.value = profile.phone;
}

function initProfile() {
  loadProfileIntoForm();
  applyProfileToBookingForm();

  const saveBtn = document.getElementById('profileSaveBtn');
  if (!saveBtn) return;

  saveBtn.addEventListener('click', () => {
    const name = document.getElementById('profileName').value.trim();
    const phone = document.getElementById('profilePhone').value.trim();
    const msgEl = document.getElementById('profileMsg');

    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ name, phone }));
      applyProfileToBookingForm();
      if (msgEl) {
        msgEl.textContent = 'تم حفظ بياناتك بنجاح.';
        msgEl.classList.remove('err');
        msgEl.classList.add('show');
        setTimeout(() => msgEl.classList.remove('show'), 2400);
      }
      haptic();
    } catch {
      if (msgEl) {
        msgEl.textContent = 'تعذّر حفظ البيانات على هذا الجهاز.';
        msgEl.classList.add('show', 'err');
      }
    }
  });
}

/* ============================================================
   Welcome screen — Step 1: simple local "login" (name + phone
   required, region optional), saved ONLY to localStorage — never
   sent to Supabase, never linked to the request/driver system.
   Step 2 (install + notifications) shows once, immediately after
   the first successful login on this device. On every later visit
   where saved login data already exists, the whole welcome screen
   is skipped and the app opens straight to the map.
   The install button in Step 2 mirrors the shared installAvailable
   flag (real Android PWA prompt when available, iOS "Add to Home
   Screen" modal otherwise, hidden once already installed) — no
   separate install logic lives here.
   ============================================================ */
const LOGIN_STORAGE_KEY = 'mustaqbali_login';

function getSavedLogin() {
  try {
    const raw = localStorage.getItem(LOGIN_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setWelcomeStep(step) {
  const loginStep = document.getElementById('welcomeLoginStep');
  const setupStep = document.getElementById('welcomeSetupStep');
  if (loginStep) loginStep.hidden = step !== 1;
  if (setupStep) setupStep.hidden = step !== 2;
  document.querySelectorAll('#welcomeSteps .welcome-step-dot').forEach((dot) => {
    dot.classList.toggle('active', Number(dot.dataset.step) === step);
  });
}

function syncWelcomeInstallVisibility() {
  const welcomeBtn = document.getElementById('welcomeInstallBtn');
  if (!welcomeBtn) return;
  welcomeBtn.hidden = !installAvailable;
}

function initWelcomeScreen() {
  const screen = document.getElementById('welcomeScreen');
  if (!screen) return;

  function dismiss() {
    screen.hidden = true;
  }

  const introStep = document.getElementById('welcomeIntroStep');
  const authStep = document.getElementById('welcomeAuthStep');
  const introBtn = document.getElementById('welcomeIntroBtn');

  // شاشة الترحيب التعريفية (الشعار + العبارة + الخدمات) تظهر في كل
  // مرة يُفتح فيها التطبيق، بصرف النظر عن وجود تسجيل دخول محفوظ من
  // عدمه. القرار بشأن تخطي تسجيل الدخول يُتخذ فقط عند الضغط على
  // «ابدأ الآن» أدناه، وليس هنا — بذلك تبقى الشاشة التعريفية أول ما
  // يظهر دائماً، دون أي تغيير في منطق الحجز/السواق/Supabase.
  screen.hidden = false;
  if (introStep) introStep.hidden = false;
  if (authStep) authStep.hidden = true;
  setWelcomeStep(1);

  if (introBtn) {
    introBtn.addEventListener('click', () => {
      haptic();
      if (getSavedLogin()) {
        // بيانات دخول محفوظة مسبقاً على هذا الجهاز → الانتقال مباشرة
        // للرئيسية دون إعادة طلب تسجيل الدخول.
        dismiss();
        return;
      }
      // لا توجد بيانات محفوظة → عرض خطوة تسجيل الدخول الحالية
      // (Step 1) كما هي، بدون أي تعديل على منطقها.
      if (introStep) introStep.hidden = true;
      if (authStep) authStep.hidden = false;
      setWelcomeStep(1);
    });
  }

  syncWelcomeInstallVisibility();

  const loginBtn = document.getElementById('welcomeLoginBtn');
  const errEl = document.getElementById('welcomeLoginError');

  function showLoginError(message) {
    if (!errEl) return;
    errEl.textContent = message;
    errEl.classList.add('show');
  }
  function clearLoginError() {
    if (!errEl) return;
    errEl.textContent = '';
    errEl.classList.remove('show');
  }

  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      const name = document.getElementById('loginName')?.value.trim() || '';
      const phone = document.getElementById('loginPhone')?.value.trim() || '';
      const region = document.getElementById('loginRegion')?.value || '';

      if (!name || name.length < 2) {
        showLoginError('يرجى إدخال الاسم الكامل');
        haptic();
        return;
      }
      if (!phone || !PHONE_RE.test(phone)) {
        showLoginError('رقم غير صحيح — مثال: 07xxxxxxxxx');
        haptic();
        return;
      }
      clearLoginError();

      try {
        localStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify({ name, phone, region }));
      } catch {
        // Non-critical — still let the customer continue into the app
        // even if this device can't persist the login locally.
      }

      const nameEl = document.getElementById('welcomeSetupName');
      if (nameEl) nameEl.textContent = name;
      syncWelcomeInstallVisibility();
      setWelcomeStep(2);
      haptic();
    });
  }

  // Enter key in either login field submits, like a normal form.
  ['loginName', 'loginPhone'].forEach((id) => {
    document.getElementById(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); loginBtn?.click(); }
    });
  });

  const installBtn = document.getElementById('welcomeInstallBtn');
  const notifBtn = document.getElementById('welcomeEnableNotifBtn');
  const continueBtn = document.getElementById('welcomeContinueBtn');

  if (installBtn) {
    // Install-only: does NOT dismiss the welcome screen. Entry into the
    // app happens exclusively via "ابدأ الآن" below.
    installBtn.addEventListener('click', () => {
      triggerInstall();
      haptic();
    });
  }
  if (notifBtn) {
    // Reuses the existing customer push-notification setup as-is —
    // does NOT dismiss the welcome screen.
    notifBtn.addEventListener('click', () => {
      setupCustomerPushNotifications();
      haptic();
    });
  }
  if (continueBtn) {
    continueBtn.addEventListener('click', () => { dismiss(); haptic(); });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  buildQuickServiceChips();
  buildServiceSwitch();
  initMap();
  registerServiceWorker();
  initPwaInstallPrompt();
  initIosInstallModal();
  initInAppBrowserNotice();
  initHelpAccordion();
  initBottomNav();
  initProfile();
  initMoreView();
  initWelcomeScreen();
  loadServicePrices();
  loadCustomerAds();
  loadFutureServices();
  document.getElementById('enableCustomerPushBtn')?.addEventListener('click', setupCustomerPushNotifications);
  // "Recent locations" feature removed — clear any stale data from
  // earlier sessions so nothing lingers unused.
  try { localStorage.removeItem(RECENT_KEY); } catch { /* non-critical */ }

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
  // Keep #bookSubmitBtn's disabled state in sync with the required
  // fields + consent checkbox every time any of them changes, and set
  // the correct initial state once on load (all empty → stays disabled).
  ['pickup', 'customerName', 'phone'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateSubmitButtonState);
  });
  document.getElementById('consentCheck')?.addEventListener('change', updateSubmitButtonState);
  updateSubmitButtonState();
  document.getElementById('recenterBtn').addEventListener('click', () => { locateMe(false); haptic(); });
  document.getElementById('locateBtnApp').addEventListener('click', () => { locateMe(false); haptic(); });
  // "طلب" on any driver in the list doesn't submit anything by itself —
  // it just records WHICH available driver was chosen (no-FIFO: only
  // that exact driver, never an auto-picked one) and brings the real
  // request form into view so the customer can fill it in and confirm.
  // Only a real, successful submission (handleSubmit) actually sends
  // the request to that driver. Event delegation (one listener on the
  // container) since the driver list is rebuilt on every service switch.
  document.getElementById('driversListApp').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-driver-action="request"]');
    if (!btn) return;
    state.featuredDriverId = btn.dataset.driverId;
    state.featuredDriverPhone = btn.dataset.driverPhone || null;
    sheet.setSnap('full');
    const pickupEl = document.getElementById('pickup');
    // FIX (bug #3): was pickupEl.scrollIntoView(...) — same document-
    // level scroll trigger as the keyboard-focus handler above. Now
    // scrolls only the internal .sheet-scroll panel via the shared
    // helper, then focuses with preventScroll so the browser's own
    // native "scroll focused field into view" behavior can't re-trigger
    // a page-level scroll either.
    scrollFieldIntoSheetView(pickupEl);
    pickupEl.focus({ preventScroll: true });
    haptic();
  });
  document.getElementById('newRequestBtn').addEventListener('click', () => {
    stopStatusPolling();
    document.getElementById('requestForm').reset();
    ['pickup', 'customerName', 'phone'].forEach(id => setFieldError(id === 'customerName' ? 'customerName' : id, null));
    clearMsg();
    updateSubmitButtonState();
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
