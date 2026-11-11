/* ======================================================================
   Shared by both pages: connecting to Supabase, signing in, and reading
   data. Keeping this in one place means the board and the upload page
   can't drift apart on how login or loading works.
   ====================================================================== */
(function () {
  'use strict';
  var cfg = window.CW_CONFIG || {};
  var configured = cfg.supabaseUrl && cfg.supabaseUrl.indexOf('YOUR-PROJECT') === -1;
  var sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Shows the sign-in form, a "no access" note, or calls onReady(session).
  // need: 'member' (board) or 'admin' (upload page).
  async function gate(root, need, onReady) {
    if (!sb) {
      root.innerHTML = '<div class="center-msg card"><h1>Almost there</h1><p class="msg">Add your Supabase address and public key to <b>config.js</b>, then reload. The setup guide (README) walks through it.</p></div>';
      return;
    }
    var res = await sb.auth.getSession();
    var session = res.data.session;
    if (!session) return renderLogin(root);

    var check = await sb.rpc(need === 'admin' ? 'is_admin' : 'is_member');
    if (check.error || !check.data) {
      root.innerHTML = '<div class="center-msg card"><h1>No access yet</h1><p class="msg">You are signed in as <b>' + esc(session.user.email) + '</b>, but that email isn\'t on this app\'s ' + (need === 'admin' ? 'admin' : 'access') + ' list. Ask Nicholas to add it.</p><button class="btn" id="signout">Sign out</button></div>';
      root.querySelector('#signout').onclick = signOut;
      return;
    }
    onReady(session);
  }

  // Passwordless sign-in: Supabase emails a one-time link. Nothing to
  // remember, nothing to reset, and the email list in app_users decides access.
  function renderLogin(root) {
    root.innerHTML =
      '<div class="login card"><div class="eyebrow">Crew Workload</div><h1>Sign in</h1>' +
      '<p class="msg">Enter your work email and we\'ll send you a sign-in link.</p>' +
      '<form id="loginForm"><label for="email">Email</label>' +
      '<input type="email" id="email" required autocomplete="email" placeholder="name@company.com">' +
      '<button class="btn primary" type="submit">Email me a link</button>' +
      '<div class="msg" id="loginMsg" role="status"></div></form></div>';
    root.querySelector('#loginForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = root.querySelector('#email').value.trim();
      var msg = root.querySelector('#loginMsg');
      msg.className = 'msg'; msg.textContent = 'Sending…';
      var r = await sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + location.pathname } });
      if (r.error) { msg.className = 'msg err'; msg.textContent = r.error.message; }
      else msg.textContent = 'Check ' + email + ' for the sign-in link. You can close this tab.';
    });
  }

  async function signOut() { await sb.auth.signOut(); location.reload(); }

  // Supabase returns at most 1,000 rows per request. A year of crew days is
  // ~15,000 rows, so we ask for one page at a time until a page comes back short.
  async function fetchAll(buildQuery) {
    var out = [], size = 1000, from = 0;
    for (;;) {
      var r = await buildQuery().range(from, from + size - 1);
      if (r.error) throw r.error;
      out = out.concat(r.data);
      if (r.data.length < size) return out;
      from += size;
    }
  }

  // Reload after the magic link signs someone in.
  if (sb) sb.auth.onAuthStateChange(function (event) { if (event === 'SIGNED_IN' && /access_token|code=/.test(location.href)) location.replace(location.pathname); });

  window.CW = { sb: sb, gate: gate, signOut: signOut, fetchAll: fetchAll, esc: esc };
})();
