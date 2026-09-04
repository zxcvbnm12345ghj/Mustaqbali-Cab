// Yammak — Supabase configuration
// Replace the two placeholder values below with your own project's
// Project URL and anon public key (Project Settings → API in the
// Supabase dashboard). The anon key is safe to ship in the browser —
// all real protection comes from Row Level Security (see schema.sql).
//
// ⚠️ Never put the service_role key here or in any file served to the
// browser. It is only used inside supabase/functions/notify-whatsapp.

const SUPABASE_URL = 'https://obebshipnjmmosxnrvcf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_V8sw7VKVvL1cyjPsVdJxMA_uO8RVySg';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
