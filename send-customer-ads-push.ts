// Supabase Edge Function: send-customer-ads-push
// Deploy path: supabase/functions/send-customer-ads-push/index.ts
//
// Completely separate from send-push-notification.ts (admin/driver push),
// which is NOT modified by this feature at all. This function only ever
// reads/writes ad_push_queue and customer_push_subscriptions — two
// brand-new tables from migration_customer_ads.sql. It never touches
// push_notifications_queue, admin_push_subscriptions, or
// driver_push_subscriptions.
//
// Reuses the SAME VAPID keys (env vars) already configured for
// send-push-notification.ts — no new secret is introduced. The VAPID
// private key still only ever lives as an Edge Function environment
// variable, never in any client file.
//
// Trigger this on a schedule (Supabase Cron), same cadence as
// send-push-notification.ts, e.g. every 15-30 seconds.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!; // secret — Edge Function env only
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async () => {
  const { data: jobs, error } = await supabase
    .from('ad_push_queue')
    .select('id, title, body, url')
    .eq('sent', false)
    .limit(20);

  if (error) {
    console.error('ad_push_queue fetch failed', error);
    return new Response('error', { status: 500 });
  }
  if (!jobs || jobs.length === 0) {
    return new Response('no jobs', { status: 200 });
  }

  const { data: subs, error: subsError } = await supabase
    .from('customer_push_subscriptions')
    .select('id, subscription');

  if (subsError) {
    console.error('customer_push_subscriptions fetch failed', subsError);
    return new Response('error', { status: 500 });
  }

  for (const job of jobs) {
    try {
      for (const sub of subs ?? []) {
        await sendOne(sub, { title: job.title, body: job.body, url: job.url });
      }
      await supabase.from('ad_push_queue').update({ sent: true }).eq('id', job.id);
    } catch (err) {
      // Leave `sent = false` so the next scheduled run retries it.
      console.error('ad push job failed', job.id, err);
    }
  }

  return new Response(`processed ${jobs.length} job(s) for ${subs?.length ?? 0} subscriber(s)`, { status: 200 });
});

async function sendOne(
  row: { id: string; subscription: unknown },
  payload: { title: string; body: string; url: string }
) {
  try {
    await webpush.sendNotification(row.subscription as any, JSON.stringify(payload));
  } catch (err: any) {
    // 404/410 = the browser has revoked/expired this subscription —
    // clean it up so we stop retrying a dead endpoint forever.
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      await supabase.from('customer_push_subscriptions').delete().eq('id', row.id);
    } else {
      throw err;
    }
  }
}
