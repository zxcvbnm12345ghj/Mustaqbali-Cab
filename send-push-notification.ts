// Supabase Edge Function: send-push-notification
// Deploy path: supabase/functions/send-push-notification/index.ts
//
// This is the ONLY place the VAPID private key exists. It is read from
// an environment variable (set via `supabase secrets set`), never
// hard-coded, never shipped to any client file (index.html/app.js/
// driver.html/driver.js all only ever see the PUBLIC VAPID key, which
// is not secret by design).
//
// Reads unsent rows from push_notifications_queue, sends a real Web
// Push message to the matching subscription(s), marks each row sent
// (or removes the subscription if the browser reports it's gone —
// HTTP 404/410 means the user uninstalled/blocked notifications).
//
// Trigger this on a schedule (Supabase Cron, e.g. every 15-30 seconds)
// exactly like whatever already polls whatsapp_notifications — reuse
// the same scheduling mechanism/cadence already running in production
// for consistency, rather than introducing a second polling pattern.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!; // secret — Edge Function env only
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com'; // ⚠️ set your real contact

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async () => {
  const { data: jobs, error } = await supabase
    .from('push_notifications_queue')
    .select('id, target_type, driver_id, title, body, url')
    .eq('sent', false)
    .limit(50);

  if (error) {
    console.error('queue fetch failed', error);
    return new Response('error', { status: 500 });
  }
  if (!jobs || jobs.length === 0) {
    return new Response('no jobs', { status: 200 });
  }

  for (const job of jobs) {
    try {
      const subs = await getSubscriptionsFor(job.target_type, job.driver_id);
      for (const sub of subs) {
        await sendOne(sub, { title: job.title, body: job.body, url: job.url });
      }
      await supabase.from('push_notifications_queue').update({ sent: true }).eq('id', job.id);
    } catch (err) {
      // Leave `sent = false` so the next scheduled run retries it.
      console.error('push job failed', job.id, err);
    }
  }

  return new Response(`processed ${jobs.length}`, { status: 200 });
});

async function getSubscriptionsFor(targetType: string, driverId: string | null) {
  if (targetType === 'admin') {
    const { data } = await supabase.from('admin_push_subscriptions').select('id, subscription');
    return data ?? [];
  }
  if (targetType === 'driver' && driverId) {
    const { data } = await supabase
      .from('driver_push_subscriptions')
      .select('driver_id, subscription')
      .eq('driver_id', driverId);
    return data ?? [];
  }
  return [];
}

async function sendOne(
  row: { id?: string; driver_id?: string; subscription: unknown },
  payload: { title: string; body: string; url: string }
) {
  try {
    await webpush.sendNotification(row.subscription as any, JSON.stringify(payload));
  } catch (err: any) {
    // 404/410 = the browser has revoked/expired this subscription —
    // clean it up so we stop retrying a dead endpoint forever.
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      if (row.driver_id) {
        await supabase.from('driver_push_subscriptions').delete().eq('driver_id', row.driver_id);
      } else if (row.id) {
        await supabase.from('admin_push_subscriptions').delete().eq('id', row.id);
      }
    } else {
      throw err;
    }
  }
}
