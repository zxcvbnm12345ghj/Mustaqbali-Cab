/* يمّك — driver-profile.html logic.
   Read-only profile share link. The token in the URL (?token=...) is
   looked up ONLY through the new get_driver_public_profile(p_driver_token)
   RPC (SECURITY DEFINER, added specifically for this page — see the
   matching migration). That RPC returns at most one row for an exact
   driver_token match and only four non-sensitive columns (name,
   vehicle_type, service_type, active) — no id, no phone, no
   driver_token, no GPS, no push data. A wrong/missing/foreign token
   simply returns zero rows, which this file treats the same as "invalid
   link" — it can never fall through to another driver's data.

   This file is entirely separate from driver.js: it does not read or
   write TOKEN_STORAGE_KEY, does not call update_driver_location or any
   other RPC driver.js uses, and does not touch driver.html/driver.css. */

// Arabic labels for the service_type codes stored in `drivers`. Falls
// back to the raw stored value for any code not listed here, so an
// unmapped/future service_type still displays (real value), never a
// blank or invented label.
const SERVICE_TYPE_LABELS = {
  taxi: 'تكسي',
  private: 'خاص',
  starx: 'ستار إكس',
  intercity: 'بين المدن',
  courier: 'دليفري',
  cargo: 'نقل بضائع',
};

function getTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const t = params.get('token');
  return t && t.trim() ? t.trim() : null;
}

function showScreen(id) {
  ['dpLoadingScreen', 'dpInvalidScreen', 'dpMainScreen'].forEach((sid) => {
    const el = document.getElementById(sid);
    if (!el) return;
    el.hidden = sid !== id;
  });
}

function renderProfile(profile) {
  const nameEl = document.getElementById('dpName');
  if (nameEl) nameEl.textContent = profile.name || '—';

  const isActive = profile.active === true;
  const pillEl = document.getElementById('dpStatusPill');
  const textEl = document.getElementById('dpStatusText');
  if (pillEl) {
    pillEl.classList.remove('is-active', 'is-inactive');
    pillEl.classList.add(isActive ? 'is-active' : 'is-inactive');
  }
  if (textEl) textEl.textContent = isActive ? 'نشط حالياً' : 'غير نشط حالياً';

  const serviceRow = document.getElementById('dpServiceRow');
  const serviceEl = document.getElementById('dpServiceType');
  const hasService = !!(profile.service_type && String(profile.service_type).trim());
  if (serviceRow) serviceRow.hidden = !hasService;
  if (hasService && serviceEl) {
    serviceEl.textContent = SERVICE_TYPE_LABELS[profile.service_type] || profile.service_type;
  }

  const vehicleRow = document.getElementById('dpVehicleRow');
  const vehicleEl = document.getElementById('dpVehicleType');
  const hasVehicle = !!(profile.vehicle_type && String(profile.vehicle_type).trim());
  if (vehicleRow) vehicleRow.hidden = !hasVehicle;
  if (hasVehicle && vehicleEl) vehicleEl.textContent = profile.vehicle_type;

  const noExtraEl = document.getElementById('dpNoExtra');
  if (noExtraEl) noExtraEl.hidden = hasService || hasVehicle;

  showScreen('dpMainScreen');
}

async function initDriverProfilePage() {
  const token = getTokenFromUrl();
  if (!token) {
    showScreen('dpInvalidScreen');
    return;
  }

  if (typeof supabaseClient === 'undefined' || !supabaseClient) {
    console.error('driver-profile: supabaseClient is not defined (check config.js)');
    showScreen('dpInvalidScreen');
    return;
  }

  try {
    const { data, error } = await supabaseClient.rpc('get_driver_public_profile', {
      p_driver_token: token,
    });
    if (error) throw error;

    const profile = Array.isArray(data) ? (data[0] || null) : (data || null);
    if (!profile) {
      showScreen('dpInvalidScreen');
      return;
    }

    renderProfile(profile);
  } catch (err) {
    console.error('get_driver_public_profile failed', err);
    showScreen('dpInvalidScreen');
  }
}

document.addEventListener('DOMContentLoaded', initDriverProfilePage);
