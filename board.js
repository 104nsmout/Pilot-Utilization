/* ======================================================================
   The board Greg sees. Reads pilot_days + roster from Supabase, then does
   all the counting in the browser. A year of data is small enough that
   switching 30D → 90D is instant, with no new trip to the database.
   ====================================================================== */
(function () {
  'use strict';
  var I = window.CWImport, CWx = window.CW, esc = CWx.esc;
  var DUTY = {}; I.DUTY.forEach(function (c) { DUTY[c] = true; });
  var MIX = ['Flying', 'Layover', 'Training', 'Travel', 'Office', 'Standby', 'Sick', 'Vacation', 'Other'];
  var ABBR = { Flying: 'F', Layover: 'L', Training: 'T', Travel: 'Tr', Office: 'O', Standby: 'S', Sick: 'Sk', Vacation: 'V', Other: 'X' };
  var WINDOWS = [
    { id: 'd30', label: '30D', days: 30, long: 'last 30 days' },
    { id: 'd60', label: '60D', days: 60, long: 'last 60 days' },
    { id: 'd90', label: '90D', days: 90, long: 'last 90 days' },
    { id: 'ytd', label: 'YTD', long: 'year to date' },
    { id: 'd365', label: '12M', days: 365, long: 'last 12 months' }
  ];

  var state = { win: 'd30', base: 'All', view: 'board', showAll: false };
  try { var saved = localStorage.getItem('cw.win'); if (saved) state.win = saved; } catch (e) {}

  var roster = [];          // [{ name, display_name, base, on_board }]
  var byPilot = {};         // name -> { 'YYYY-MM-DD': row }
  var asOf, schedFrom, dataFrom, lastUpload;

  var app = document.getElementById('app');
  CWx.gate(app, 'member', function (session) { load(session).catch(showError); });

  function showError(e) {
    app.innerHTML = '<div class="center-msg card"><h1>Couldn\'t load the board</h1><p class="msg err">' + esc(e.message || e) + '</p><button class="btn" onclick="location.reload()">Try again</button></div>';
  }

  function localToday() { return new Date().toLocaleDateString('en-CA'); } // en-CA formats as YYYY-MM-DD

  async function load(session) {
    var sb = CWx.sb;
    roster = await CWx.fetchAll(function () { return sb.from('roster').select('name,display_name,base,on_board').order('name'); });
    var up = await sb.from('uploads').select('source,start_day,end_day,uploaded_at').order('uploaded_at', { ascending: false }).limit(200);
    if (up.error) throw up.error;
    var legsEnd = null;
    schedFrom = null; dataFrom = null;
    up.data.forEach(function (u) {
      if (u.source === 'legs' && (!legsEnd || u.end_day > legsEnd)) legsEnd = u.end_day;
      if (u.source === 'legs' && (!dataFrom || u.start_day < dataFrom)) dataFrom = u.start_day;
      if (u.source === 'schedule' && (!schedFrom || u.start_day < schedFrom)) schedFrom = u.start_day;
    });
    lastUpload = up.data[0] ? up.data[0].uploaded_at : null;
    // "As of" = the last day covered by a flight upload, never later than
    // today. Otherwise days you haven't uploaded yet would look like days off.
    var today = localToday();
    asOf = legsEnd && legsEnd < today ? legsEnd : today;

    var rows = await CWx.fetchAll(function () {
      return sb.from('pilot_days').select('pilot,day,category,detail,legs,flight_hr,status')
        .gte('day', I.addDays(asOf, -400)).lte('day', I.addDays(asOf, 60)).order('pilot').order('day');
    });
    byPilot = {};
    rows.forEach(function (r) { (byPilot[r.pilot] = byPilot[r.pilot] || {})[r.day] = r; });
    shell(session);
    render();
  }

  // ---------------- Counting ----------------

  function winRange(id) {
    var w = WINDOWS.find(function (x) { return x.id === id; }) || WINDOWS[0];
    var start = w.id === 'ytd' ? asOf.slice(0, 4) + '-01-01' : I.addDays(asOf, -(w.days - 1));
    return { start: start, end: asOf, n: I.diffDays(start, asOf) + 1, w: w };
  }

  function countPilot(name, start, end) {
    var c = { duty: 0, hours: 0, legs: 0 };
    MIX.forEach(function (k) { c[k] = 0; });
    var days = byPilot[name] || {};
    Object.keys(days).forEach(function (d) {
      if (d < start || d > end) return;
      var r = days[d];
      c[r.category] = (c[r.category] || 0) + 1;
      if (DUTY[r.category]) c.duty++;
      c.hours += +r.flight_hr || 0;
      c.legs += +r.legs || 0;
    });
    return c;
  }

  function aggregate() {
    var R = winRange(state.win);
    var all = roster.filter(function (p) { return p.on_board; }).map(function (p) {
      var c = countPilot(p.name, R.start, R.end);
      c.name = p.name; c.label = p.display_name || I.displayName(p.name); c.base = p.base || 'Unassigned';
      return c;
    });
    var avg = all.reduce(function (s, p) { return s + p.duty; }, 0) / (all.length || 1);
    all.forEach(function (p) { p.delta = p.duty - avg; });
    all.sort(function (a, b) { return b.duty - a.duty || a.label.localeCompare(b.label); });
    all.forEach(function (p, i) { p.rank = i + 1; });
    var shown = state.base === 'All' ? all : all.filter(function (p) { return p.base === state.base; });
    return { R: R, all: all, shown: shown, avg: avg, thr: Math.max(2, Math.round(7 * R.n / 30)) };
  }

  // ---------------- Formatting ----------------

  function r1(n) { return Math.abs(n) >= 10 ? Math.round(n) : Math.round(n * 10) / 10; }
  function dTxt(d) { var v = Math.round(d); return v > 0 ? '+' + v : v < 0 ? '−' + Math.abs(v) : '0'; }
  function dCls(d) { var v = Math.round(d); return v > 0 ? 'hi' : v < 0 ? 'lo' : ''; }
  function fmtDay(d, opts) { return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', Object.assign({ month: 'short', day: 'numeric', timeZone: 'UTC' }, opts || {})); }
  function code(base) { return base === 'Unassigned' ? '—' : base.split(',')[0].slice(0, 3).toUpperCase(); }
  function mixBar(p, n) {
    return '<div class="mix" aria-hidden="true">' + MIX.map(function (k) {
      return p[k] ? '<i class="c-' + k + '" style="width:' + (p[k] / n * 100) + '%"></i>' : '';
    }).join('') + '</div>';
  }
  function mixTxt(p) {
    var o = MIX.filter(function (k) { return p[k]; }).map(function (k) { return ABBR[k] + p[k]; });
    return o.join(' ') || 'off';
  }

  // ---------------- Page ----------------

  function shell(session) {
    app.innerHTML =
      '<div class="wrap">' +
      '<header class="top"><div><div class="eyebrow" id="eyebrow"></div><h1>Crew Workload</h1></div>' +
      '<div class="tools"><label for="baseSel" class="eyebrow" style="position:absolute;left:-9999px">Base</label><select id="baseSel"></select>' +
      '<button class="btn" id="signout" title="' + esc(session.user.email) + '">Sign out</button></div></header>' +
      '<div class="seg" role="group" aria-label="Time window" id="winSeg"></div>' +
      '<div class="summary" id="summary"></div>' +
      '<div class="legend">' + MIX.filter(function (k) { return k !== 'Other'; }).map(function (k) { return '<span><i class="sw c-' + k + '"></i>' + k + '</span>'; }).join('') + '<span><i class="sw" style="background:var(--sunk)"></i>Off</span></div>' +
      '<div class="note" id="dataNote"></div>' +
      '<div class="views"><section class="view on" id="v-board" aria-label="Leaderboard"></section><section class="view" id="v-balance" aria-label="Balance"></section><section class="view" id="v-bases" aria-label="Bases"></section></div>' +
      '</div>' +
      '<nav class="tabbar" role="tablist" aria-label="Views">' +
      tab('board', 'Board', '<path d="M8 21V11M16 21V5M12 21v-6M4 21h16"/>') +
      tab('balance', 'Balance', '<path d="M12 3v18M12 7h7M12 12H5M12 17h4"/>') +
      tab('bases', 'Bases', '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>') +
      '</nav>';
    document.getElementById('signout').onclick = CWx.signOut;
    document.getElementById('winSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      state.win = b.dataset.w; try { localStorage.setItem('cw.win', state.win); } catch (err) {}
      render();
    });
    document.getElementById('baseSel').addEventListener('change', function (e) { state.base = e.target.value; render(); });
    document.querySelector('.tabbar').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return; state.view = b.dataset.v; render(); window.scrollTo(0, 0);
    });
    document.querySelector('.views').addEventListener('click', function (e) {
      var t = e.target.closest('[data-p],[data-act]'); if (!t) return;
      if (t.dataset.p) openPilot(t.dataset.p);
      else { state.showAll = t.dataset.act === 'all'; render(); }
    });
  }
  function tab(v, label, path) {
    return '<button role="tab" aria-selected="' + (state.view === v) + '" data-v="' + v + '"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>' + label + '</button>';
  }

  function render() {
    var A = aggregate(), R = A.R;
    document.getElementById('eyebrow').textContent = fmtDay(R.start) + ' – ' + fmtDay(R.end, { year: 'numeric' }) + ' · ' + A.shown.length + ' pilots';
    document.getElementById('winSeg').innerHTML = WINDOWS.map(function (w) {
      return '<button data-w="' + w.id + '" aria-pressed="' + (w.id === state.win) + '" title="' + w.long + '">' + w.label + '</button>';
    }).join('');
    var bases = ['All'].concat(Object.keys(A.all.reduce(function (s, p) { s[p.base] = 1; return s; }, {})).sort());
    if (bases.indexOf(state.base) < 0) state.base = 'All';
    document.getElementById('baseSel').innerHTML = bases.map(function (b) {
      return '<option value="' + esc(b) + '"' + (b === state.base ? ' selected' : '') + '>' + (b === 'All' ? 'All bases' : esc(b.split(',')[0])) + '</option>';
    }).join('');

    var list = A.shown, duties = list.map(function (p) { return p.duty; });
    var avg = list.reduce(function (s, p) { return s + p.duty; }, 0) / (list.length || 1);
    document.getElementById('summary').innerHTML =
      '<div><small>' + (state.base === 'All' ? 'Fleet avg' : 'Base avg') + '</small><b>' + r1(avg) + '<i> days</i></b></div>' +
      '<div><small>Share of days</small><b>' + Math.round(avg / R.n * 100) + '<i>%</i></b></div>' +
      '<div><small>Spread</small><b>' + (list.length ? Math.min.apply(null, duties) + '–' + Math.max.apply(null, duties) : '—') + '</b></div>' +
      '<div><small>Outliers ±' + A.thr + '</small><b>' + list.filter(function (p) { return Math.abs(p.delta) >= A.thr; }).length + '</b></div>';

    var note = '<b>Data through ' + fmtDay(asOf, { year: 'numeric' }) + '.</b>';
    if (lastUpload) note += ' Last upload ' + new Date(lastUpload).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '.';
    if (!schedFrom) note += ' No training, travel or vacation data has been loaded yet, so those days count as off.';
    else if (schedFrom > R.start) note += ' Training, travel and vacation are only loaded from ' + fmtDay(schedFrom) + ', so earlier days in this window may be undercounted.';
    document.getElementById('dataNote').innerHTML = note;

    renderBoard(A); renderBalance(A); renderBases(A);
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('on', v.id === 'v-' + state.view); });
    document.querySelectorAll('.tabbar button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.v === state.view)); });
  }

  function rowHTML(p, n) {
    var rc = p.rank === 1 ? 'r1' : p.rank <= 3 ? 'r2' : '';
    return '<button class="row" data-p="' + esc(p.name) + '" aria-label="' + esc(p.label) + ', ' + p.duty + ' duty days, ' + dTxt(p.delta) + ' versus average">' +
      '<div class="l1"><span class="rank ' + rc + '">' + p.rank + '</span><span class="who"><b>' + esc(p.label) + '</b><small>' + esc(code(p.base)) + '</small></span>' +
      '<span class="duty">' + p.duty + '</span><span class="pill ' + dCls(p.delta) + '">' + dTxt(p.delta) + '</span></div>' +
      '<div class="l2">' + mixBar(p, n) + '<span class="mixtxt">' + mixTxt(p) + '</span></div></button>';
  }

  function renderBoard(A) {
    var el = document.getElementById('v-board'), list = A.shown, n = A.R.n;
    if (!list.length) { el.innerHTML = '<div class="panel"><div class="panel-h plain"><h2>No pilots on the board</h2></div><p class="msg" style="padding:12px">Give pilots a base and switch them on from the upload page.</p></div>'; return; }
    if (state.showAll || list.length <= 12) {
      var html = '', crossed = false;
      list.forEach(function (p) {
        if (!crossed && p.delta < 0) { crossed = true; html += '<div class="avgline">fleet avg ' + r1(A.avg) + '</div>'; }
        html += rowHTML(p, n);
      });
      el.innerHTML = '<div class="panel"><div class="panel-h plain"><h2>All pilots, ranked</h2><span>DUTY DAYS · VS AVG</span></div>' + html +
        (list.length > 12 ? '<button class="more" data-act="less">Show top and bottom only</button>' : '') + '</div>';
      return;
    }
    var top = list.slice(0, 6), bot = list.slice(-6).reverse();
    el.innerHTML =
      '<div class="panel"><div class="panel-h hi"><h2>Carrying the most</h2><span>DUTY DAYS · VS AVG</span></div>' + top.map(function (p) { return rowHTML(p, n); }).join('') + '</div>' +
      '<div class="panel"><div class="panel-h lo"><h2>Carrying the least</h2><span>DUTY DAYS · VS AVG</span></div>' + bot.map(function (p) { return rowHTML(p, n); }).join('') +
      '<button class="more" data-act="all">Show all ' + list.length + ' pilots</button></div>';
  }

  function groupByBase(list) {
    var g = {};
    list.forEach(function (p) { (g[p.base] = g[p.base] || []).push(p); });
    return Object.keys(g).sort(function (a, b) { return g[b].length - g[a].length || a.localeCompare(b); }).map(function (k) { return [k, g[k]]; });
  }

  function renderBalance(A) {
    var el = document.getElementById('v-balance');
    var maxD = Math.max(1, Math.max.apply(null, A.shown.map(function (p) { return Math.abs(p.delta); }).concat([0])));
    var html = '<div class="panel"><div class="panel-h plain"><h2>Balance vs fleet average</h2><span>' + r1(A.avg) + ' DAYS</span></div>' +
      '<div class="balkey"><span><i class="sw" style="background:var(--lo)"></i>Under-used</span><span class="num">avg</span><span>Over-loaded<i class="sw" style="background:var(--hi)"></i></span></div>';
    groupByBase(A.shown).forEach(function (pair) {
      var g = pair[1], avg = g.reduce(function (s, p) { return s + p.duty; }, 0) / g.length;
      html += '<div class="basehead"><h3>' + esc(pair[0]) + '</h3><span>' + g.length + ' pilot' + (g.length > 1 ? 's' : '') + ' · avg ' + r1(avg) + '</span></div>';
      g.forEach(function (p) {
        var w = Math.abs(p.delta) / maxD * 50, v = Math.round(p.delta);
        var col = v > 0 ? 'var(--hi)' : v < 0 ? 'var(--lo)' : 'var(--ink3)';
        var fg = v > 0 ? 'var(--hi-fg)' : v < 0 ? 'var(--lo-fg)' : 'var(--ink2)';
        html += '<button class="bal" data-p="' + esc(p.name) + '"><span class="nm">' + esc(p.label) + '</span><span class="tr" aria-hidden="true"><span class="bar" style="left:' + (p.delta >= 0 ? 50 : 50 - w) + '%;width:' + Math.max(w, 0.6) + '%;background:' + col + '"></span></span><span class="dv" style="color:' + fg + '">' + dTxt(p.delta) + '</span></button>';
      });
    });
    el.innerHTML = html + '<div style="height:8px"></div></div>';
  }

  function renderBases(A) {
    var el = document.getElementById('v-bases');
    var top = Math.max(5, Math.ceil(Math.max.apply(null, A.all.map(function (p) { return p.duty; }).concat([0])) / 5) * 5);
    var html = '<div class="panel"><div class="panel-h plain"><h2>Bases</h2><span>EACH DOT IS ONE PILOT</span></div>';
    groupByBase(A.all).forEach(function (pair) {
      if (state.base !== 'All' && pair[0] !== state.base) return;
      var g = pair[1], ds = g.map(function (p) { return p.duty; });
      var avg = ds.reduce(function (s, x) { return s + x; }, 0) / g.length;
      var vac = g.reduce(function (s, p) { return s + p.Vacation; }, 0);
      html += '<div class="basecard"><div class="bc1"><div><h3>' + esc(pair[0]) + '</h3><small>' + g.length + ' pilot' + (g.length > 1 ? 's' : '') + ' · range ' + Math.min.apply(null, ds) + '–' + Math.max.apply(null, ds) + ' · ' + vac + ' vacation days</small></div>' +
        '<div><div class="big">' + r1(avg) + '</div><small>avg days</small></div></div>' +
        '<div class="strip"><span class="avg" style="left:calc(' + (A.avg / top * 100) + '% - 1px)" title="Fleet average"></span>' +
        g.map(function (p) { return '<button class="dot" data-p="' + esc(p.name) + '" aria-label="' + esc(p.label) + ': ' + p.duty + ' days" title="' + esc(p.label) + ' · ' + p.duty + '" style="left:' + (p.duty / top * 100) + '%;background:' + (p.delta >= 0 ? 'var(--hi)' : 'var(--lo)') + '"></button>'; }).join('') +
        '</div><div class="axis"><span>0</span><span>' + (top / 2) + '</span><span>' + top + ' days</span></div></div>';
    });
    el.innerHTML = html + '</div>';
  }

  // ---------------- Pilot profile ----------------

  function openPilot(name) {
    var A = aggregate(), R = A.R, p = A.all.find(function (x) { return x.name === name; });
    if (!p) return;
    var days = byPilot[name] || {};

    // Flags: plain-language reasons to look closer.
    var flags = [];
    if (p.rank === 1) flags.push(['Highest in the fleet for this window', 'Rank 1 of ' + A.all.length + '.']);
    if (p.delta >= A.thr) flags.push(['Well above average', Math.round(p.delta) + ' more duty days than the fleet average over the ' + R.w.long + '.']);
    if (p.delta <= -A.thr && p.Vacation + p.Sick < A.thr) flags.push(['Under-used, not on leave', 'Only ' + (p.Vacation + p.Sick) + ' vacation or sick days explain a gap of ' + Math.abs(Math.round(p.delta)) + ' duty days.']);
    var nonFly = p.Training + p.Travel + p.Office;
    if (p.duty >= 8 && nonFly / p.duty >= 0.4) flags.push(['Heavy on non-flying duty', nonFly + ' of ' + p.duty + ' duty days were training, travel or office.']);
    var streak = 0, best = 0;
    for (var d = R.start; d <= R.end; d = I.addDays(d, 1)) { if (days[d] && DUTY[days[d].category]) { streak++; best = Math.max(best, streak); } else streak = 0; }
    if (best >= 7) flags.push(['Long stretch without a day off', best + ' duty days in a row in this window.']);

    // Calendar: the window, capped at the most recent 91 days so it stays readable.
    var calStart = R.n > 91 ? I.addDays(R.end, -90) : R.start;
    var lead = new Date(calStart + 'T12:00:00Z').getUTCDay();
    var cal = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(function (x) { return '<span class="dow">' + x + '</span>'; }).join('');
    for (var i = 0; i < lead; i++) cal += '<span class="d blank"></span>';
    for (d = calStart; d <= R.end; d = I.addDays(d, 1)) {
      var r = days[d], c = r ? r.category : null;
      cal += '<span class="d' + (c ? ' f c-' + c : '') + '" title="' + esc(fmtDay(d) + ': ' + (r ? c + (r.detail ? ' · ' + r.detail : '') : 'Off')) + '">' + (+d.slice(8)) + '</span>';
    }

    // Monthly trend: this pilot vs the fleet average, last 12 months.
    // Months before the first upload are skipped so they don't read as zeros.
    var months = [];
    for (var k = 11; k >= 0; k--) {
      var md = new Date(Date.UTC(+asOf.slice(0, 4), +asOf.slice(5, 7) - 1 - k, 1));
      var ms = md.toISOString().slice(0, 10), me = new Date(Date.UTC(md.getUTCFullYear(), md.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      if (me > asOf) me = asOf;
      if (dataFrom && me < dataFrom) continue;
      var mine = countPilot(name, ms, me).duty;
      var fleet = A.all.reduce(function (s, q) { return s + countPilot(q.name, ms, me).duty; }, 0) / (A.all.length || 1);
      months.push({ label: md.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), me: mine, avg: fleet, partial: me === asOf && k === 0 });
    }
    var trend = months.length >= 2 ? trendSVG(months, p.label)
      : '<p class="msg" style="margin:0">The trend fills in once at least two months of data are loaded.</p>';

    // Coming up: what's already on the schedule after the data-through date.
    var upc = [], cur = null;
    for (d = I.addDays(asOf, 1); d <= I.addDays(asOf, 45); d = I.addDays(d, 1)) {
      r = days[d];
      if (r && cur && cur.cat === r.category && cur.end === I.addDays(d, -1)) cur.end = d;
      else if (r) upc.push(cur = { cat: r.category, start: d, end: d, detail: r.detail });
      else cur = null;
    }

    var total = MIX.reduce(function (s, k2) { return s + p[k2]; }, 0);
    var root = document.getElementById('sheetRoot');
    root.innerHTML = '<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(p.label) + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><div><div class="eyebrow">' + esc(p.base) + ' · ' + fmtDay(R.start) + ' – ' + fmtDay(R.end) + '</div><h1>' + esc(p.label) + '</h1></div>' +
      '<button class="btn icon" id="closeSheet" aria-label="Close"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' +
      '<div class="card"><div class="hero"><div><div class="msg">Duty days</div><div class="n">' + p.duty + '</div><div class="msg">' + Math.round(p.duty / R.n * 100) + '% of ' + R.n + ' days · ' + r1(p.hours) + ' flight hrs</div></div>' +
      '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px"><span class="pill ' + dCls(p.delta) + '" style="font-size:14px;padding:5px 9px">' + dTxt(p.delta) + ' vs avg</span><span class="msg">Rank ' + p.rank + ' of ' + A.all.length + '</span></div></div></div>' +
      flags.map(function (f) { return '<div class="flag"><b>' + esc(f[0]) + '</b>' + esc(f[1]) + '</div>'; }).join('') +
      '<div class="card"><h3>Where the days went</h3><div class="mix" style="height:14px;border-radius:7px">' +
      MIX.map(function (k2) { return p[k2] ? '<i class="c-' + k2 + '" style="width:' + (p[k2] / R.n * 100) + '%"></i>' : ''; }).join('') + '</div>' +
      '<div class="brk">' + MIX.filter(function (k2) { return k2 !== 'Other' || p.Other; }).map(function (k2) {
        return '<div style="' + (p[k2] ? '' : 'color:var(--ink3)') + '"><i class="sw c-' + k2 + '" style="width:10px;height:10px"></i><span>' + k2 + '</span><span class="num" style="font-weight:600">' + p[k2] + '</span></div>';
      }).join('') + '<div style="color:var(--ink3)"><i class="sw" style="width:10px;height:10px;background:var(--sunk)"></i><span>Off</span><span class="num" style="font-weight:600">' + (R.n - total) + '</span></div></div></div>' +
      '<div class="card"><h3>Day by day' + (R.n > 91 ? ' (last 91 days)' : '') + '</h3><div class="cal">' + cal + '</div></div>' +
      '<div class="card trend"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h3>Monthly duty days</h3><span class="msg" style="font-size:11px"><span style="color:var(--hi-fg)">━</span> ' + esc(p.label.split(' ')[0]) + ' &nbsp;┄ fleet avg</span></div>' + trend + '</div>' +
      '<div class="card"><h3>Coming up</h3>' + (upc.length ? '<div class="upc">' + upc.slice(0, 10).map(function (u) {
        return '<div><span class="when">' + fmtDay(u.start) + (u.end !== u.start ? '–' + fmtDay(u.end) : '') + '</span><i class="sw c-' + u.cat + '"></i><span>' + u.cat + (u.detail ? ' · ' + esc(u.detail) : '') + '</span></div>';
      }).join('') + '</div>' : '<p class="msg" style="margin:0">Nothing scheduled yet in the next 45 days.</p>') + '</div>' +
      '</div></div>';
    var scrim = document.getElementById('scrim');
    scrim.addEventListener('click', function (e) { if (e.target === scrim) closeSheet(); });
    document.getElementById('closeSheet').onclick = closeSheet;
    document.getElementById('closeSheet').focus();
  }

  function trendSVG(months, name) {
    var W = 340, H = 140, pl = 26, pr = 10, pt = 10, pb = 22;
    var maxY = Math.max(5, Math.ceil(Math.max.apply(null, months.map(function (m) { return Math.max(m.me, m.avg); })) / 5) * 5);
    function x(i) { return pl + i * (W - pl - pr) / (months.length - 1); }
    function y(v) { return pt + (1 - v / maxY) * (H - pt - pb); }
    var g = [0, maxY / 2, maxY].map(function (v) {
      return '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--line)"/><text x="' + (pl - 5) + '" y="' + (y(v) + 3) + '" text-anchor="end" font-size="9" fill="var(--ink3)" font-family="IBM Plex Mono,monospace">' + v + '</text>';
    }).join('');
    var me = months.map(function (m, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(m.me).toFixed(1); }).join(' ');
    var av = months.map(function (m, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(m.avg).toFixed(1); }).join(' ');
    var area = me + ' L' + x(months.length - 1).toFixed(1) + ' ' + y(0) + ' L' + x(0) + ' ' + y(0) + ' Z';
    var lab = months.map(function (m, i) { return i % 2 === 1 ? '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="9" fill="var(--ink3)" font-family="IBM Plex Mono,monospace">' + m.label + '</text>' : ''; }).join('');
    var last = months[months.length - 1];
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Monthly duty days for ' + esc(name) + ' compared with the fleet average">' + g +
      '<path d="' + area + '" fill="var(--hi)" opacity=".12"/><path d="' + av + '" fill="none" stroke="var(--ink3)" stroke-width="1.5" stroke-dasharray="4 3"/>' +
      '<path d="' + me + '" fill="none" stroke="var(--hi)" stroke-width="2.25" stroke-linejoin="round"/>' +
      '<circle cx="' + x(months.length - 1) + '" cy="' + y(last.me) + '" r="4" fill="var(--hi)" stroke="var(--surface)" stroke-width="2"/>' + lab + '</svg>' +
      (last.partial ? '<div class="msg" style="font-size:11px">' + last.label + ' is month to date.</div>' : '');
  }

  function closeSheet() { document.getElementById('sheetRoot').innerHTML = ''; }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.getElementById('scrim')) closeSheet(); });
})();
