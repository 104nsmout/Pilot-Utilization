// Your Supabase project's address and public key.
// Find both in Supabase > Project Settings > API.
//
// Is it safe to put the key here, where anyone can read it? Yes, for THIS key.
// The "anon public" key only identifies your project. It can't read crew data
// by itself: the database's access rules (schema.sql, section 7) require a
// logged-in user whose email is on the app_users list.
// NEVER put the "service_role" key in this file. That one bypasses every rule.
window.CW_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT-ID.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-PUBLIC-KEY'
};
