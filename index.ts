// Yammak — create-driver-account Edge Function
// NOT DEPLOYED. Written for review only.
//
// Purpose: create a Supabase Auth account (phone + password) for one
// driver and link it to drivers.auth_user_id — safely, with
// service_role staying server-side at all times.
//
// Security model (two separate Supabase clients, deliberately):
//   1. `callerClient` — created with the ANON key + the caller's own
//      JWT (from the Authorization header). Used ONLY to confirm the
//      caller is an authenticated admin, via the existing is_admin()
//      RPC. This client can do nothing else; it has exactly the
//      permissions the caller's own session has (same as any RPC call
//      from admin.js in the browser).
//   2. `adminClient` — created with SUPABASE_SERVICE_ROLE_KEY, the
//      secret Supabase injects automatically into every Edge Function
//      (never set manually, never leaves this function). Instantiated
//      ONLY after is_admin() returns true. Used for
//      auth.admin.createUser/deleteUser and the drivers UPDATE.
//
// If is_admin() is false, or the JWT is missing/invalid, the function
// returns 401/403 BEFORE the service-role client is ever created —
// the secret is untouched on every rejected request.
//
// Duplicate-link protection (two layers):
//   - Application layer: refuses up front if the driver row already
//     has auth_user_id set, and the final UPDATE is a single atomic
//     `WHERE id = :driver_id AND auth_user_id IS NULL`.
//   - Database layer (already in place — confirmed live, not added by
//     this function): the partial unique index
//     idx_drivers_auth_user_id on drivers(auth_user_id) WHERE
//     auth_user_id IS NOT NULL. Even if the application check above
//     had a bug, the database itself refuses a second link to the
//     same auth_user_id, or the same driver twice.
//
// Nothing here touches driver.js, driver.html, driver.css, config.js,
// the driver_token system, or any existing RPC/RLS.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
// Built-in secret — Supabase provides this automatically to every Edge
// Function; no manual secret needs to be set for it. (Changed from the
// earlier custom SERVICE_ROLE_KEY per review — that name required a
// manual secret and would silently fail at runtime if unset.)
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Admin panel's real origin (confirmed by the user, 2026-09-19).
const ADMIN_PANEL_ORIGIN = 'https://rahemcab.netlify.app';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ADMIN_PANEL_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Same normalization rules as normalizeIraqiPhone() in driver.js,
// duplicated here deliberately (an Edge Function cannot import a
// browser-side file) so an admin typing any common variation of the
// number still produces the exact E.164 value the driver will later
// type in on driver.html.
function normalizeIraqiPhone(raw: string | null | undefined): string | null {
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
  if (!/^7\d{9}$/.test(digits)) return null;
  return '+964' + digits;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }

  // ---- 1) Identify the caller from their OWN JWT — no service_role yet ----
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'missing bearer token' }, 401);
  }

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: isAdminResult, error: isAdminError } = await callerClient.rpc('is_admin');
  if (isAdminError) {
    console.error('is_admin() check failed', isAdminError);
    return jsonResponse({ error: 'could not verify admin session' }, 401);
  }
  if (isAdminResult !== true) {
    return jsonResponse({ error: 'not an admin' }, 403);
  }

  // ---- 2) Validate input ----
  let body: { driver_id?: string; phone?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  const { driver_id, password } = body;
  const phone = normalizeIraqiPhone(body.phone);

  if (!driver_id) {
    return jsonResponse({ error: 'driver_id is required' }, 400);
  }
  if (!phone) {
    return jsonResponse({ error: 'invalid phone number' }, 400);
  }
  if (!password || password.length < 8) {
    return jsonResponse({ error: 'password must be at least 8 characters' }, 400);
  }

  // ---- 3) Only now: service_role client, never exposed to the caller ----
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 3a) Load the driver row and check it's eligible.
  const { data: driver, error: driverError } = await adminClient
    .from('drivers')
    .select('id, active, auth_user_id')
    .eq('id', driver_id)
    .maybeSingle();

  if (driverError) {
    console.error('driver lookup failed', driverError);
    return jsonResponse({ error: 'driver lookup failed' }, 500);
  }
  if (!driver) {
    return jsonResponse({ error: 'driver not found' }, 404);
  }
  if (!driver.active) {
    return jsonResponse({ error: 'driver is not active' }, 400);
  }
  if (driver.auth_user_id) {
    // Application-layer check — the DB's own partial unique index is
    // the real backstop, this just gives a clear error early.
    return jsonResponse({ error: 'this driver already has a linked account' }, 409);
  }

  // 3b) Create the Auth user — phone + password, phone_confirm skips
  // any SMS/OTP requirement since the admin is creating this directly.
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    phone,
    password,
    phone_confirm: true,
  });

  if (createError || !created?.user) {
    console.error('createUser failed', createError);
    return jsonResponse({ error: createError?.message || 'failed to create auth user' }, 500);
  }

  const newAuthUserId = created.user.id;

  // 3c) Link atomically — WHERE auth_user_id IS NULL guards against a
  // race with a concurrent request for the same driver. If this
  // updates 0 rows, something claimed the driver in between: roll
  // back the just-created auth user so we don't leave an orphan.
  const { data: updated, error: updateError } = await adminClient
    .from('drivers')
    .update({ auth_user_id: newAuthUserId })
    .eq('id', driver_id)
    .is('auth_user_id', null)
    .select('id')
    .maybeSingle();

  if (updateError || !updated) {
    console.error('link failed, rolling back created auth user', updateError);
    await adminClient.auth.admin.deleteUser(newAuthUserId).catch((e) =>
      console.error('rollback deleteUser also failed', e)
    );
    return jsonResponse(
      { error: 'could not link account (driver may have just been linked by another request)' },
      409
    );
  }

  return jsonResponse(
    { success: true, driver_id, auth_user_id: newAuthUserId, phone },
    200
  );
});
