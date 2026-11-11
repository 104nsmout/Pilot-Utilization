/* ======================================================================
   Upload page (admins only).
   Flow: drop CSVs → the page recognizes each one → shows what it will
   save and anything odd → you press Save → replace_source() writes it.
   Nothing reaches the database until you press Save.
   ====================================================================== */
(function () {
  'use strict';
  var I = window.CWImport, CWx = window.CW, esc = CWx.esc, sb = CWx.sb;
  var files = [];     // { name, kind, rows, range }
  var plans = [];     // what will be saved
  var roster = {};    // name -> roster row
  var app = document.getElementById('app');

  CWx.gate(app, 'admin', function (session) { shell(session); refresh(); });

  function shell(session) {
    app.innerHTML =
      '<div class="wrap" style="max-width:900px">' +
      '<header class="top"><div><div class="eyebrow">Crew Workload · Admin</div><h1>Upload data</h1></div>' +
      '<div class="tools"><a class="btn" href="./">Open board</a><button class="btn" id="signout" title="' + esc(session.user.email) + '">Sign out</button></div></header>' +

      '<div class="card"><h3>1. Add your Airplane Manager exports</h3>' +
      '<p class="msg" style="margin:0">Drop any mix of these: <b>crew legs</b> (who flew which leg), <b>leg detail</b> (actual flight times) and <b>schedule entries</b> (training, travel, vacation). Keep the file names Airplane Manager gives them; the dates in the name tell the page which days the file covers.</p>' +
      '<label class="drop" id="drop" for="fileIn"><b>Drop CSV files here</b><span class="msg">or tap to choose</span>' +
      '<input type="file" id="fileIn" accept=".csv,text/csv" multiple hidden></label>' +
      '<div class="filelist" id="fileList"></div></div>' +

      '<div class="card" id="planCard" hidden><h3>2. Check what will be saved</h3><div class="plan" id="plan"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="btn primary" id="saveBtn">Save to board</button><button class="btn" id="clearBtn">Start over</button><span class="msg" id="saveMsg" role="status"></span></div></div>' +

      '<div class="card"><h3>Recent uploads</h3><div class="tablewrap" id="uploads"><p class="msg">Loading…</p></div></div>' +
      '<div class="card" id="conflictCard" hidden></div>' +

      '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><h3>Roster</h3><button class="btn" id="saveRoster" disabled>Save roster changes</button></div>' +
      '<p class="msg" style="margin:0">Pilots appear on the board only when <b>On board</b> is checked. New names from an upload are added here unchecked, at the top.</p>' +
      '<div class="tablewrap" id="roster"></div><span class="msg" id="rosterMsg" role="status"></span></div>' +
      '</div>';

    document.getElementById('signout').onclick = CWx.signOut;
    var drop = document.getElementById('drop');
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { addFiles(e.dataTransfer.files); });
    document.getElementById('fileIn').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
    document.getElementById('saveBtn').onclick = save;
    document.getElementById('clearBtn').onclick = function () { files = []; plans = []; renderFiles(); renderPlan(); };
    document.getElementById('saveRoster').onclick = saveRoster;
  }

  // ---------- Reading files ----------

  function parse(file) {
    return new Promise(function (resolve) {
      Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: function (res) { resolve({ name: file.name, kind: I.detect(res.meta.fields), rows: res.data, range: I.rangeFromFileName(file.name) }); },
        error: function (err) { resolve({ name: file.name, kind: 'unknown', rows: [], error: err.message }); }
      });
    });
  }

  async function addFiles(list) {
    var parsed = await Promise.all(Array.prototype.map.call(list, parse));
    parsed.forEach(function (f) {
      files = files.filter(function (x) { return x.name !== f.name; }); // same file twice = replace
      files.push(f);
    });
    renderFiles();
    buildPlans();
  }

  function renderFiles() {
    document.getElementById('fileList').innerHTML = files.map(function (f) {
      var note = f.kind === 'tripList' ? 'Not needed. Skipped.' : f.kind === 'unknown' ? (f.error || 'Columns not recognized. Skipped.') : f.rows.length + ' rows' + (f.range ? ' · ' + f.range.start + ' to ' + f.range.end : ' · no dates in file name');
      return '<div class="file"><span><b>' + esc(I.FILE_LABELS[f.kind]) + '</b> · ' + esc(f.name) + '</span><span class="msg">' + esc(note) + '</span></div>';
    }).join('');
  }

  // ---------- Building the plan ----------

  // One plan per crew-legs file and per schedule file. Each keeps its own
  // date range, because the save step clears exactly that range first.
  function buildPlans() {
    var detailRows = [];
    files.filter(function (f) { return f.kind === 'legDetail'; }).forEach(function (f) { detailRows = detailRows.concat(f.rows); });
    plans = [];
    files.forEach(function (f) {
      if (f.kind !== 'crewLegs' && f.kind !== 'schedule') return;
      plans.push({ file: f, source: f.kind === 'crewLegs' ? 'legs' : 'schedule', detailRows: detailRows, range: f.range ? Object.assign({}, f.range) : null });
    });
    plans.forEach(computePlan);
    renderPlan();
  }

  function computePlan(p) {
    var out = p.source === 'legs'
      ? I.buildLegDays(p.file.rows, p.detailRows, p.range)
      : I.buildScheduleDays(p.file.rows, p.range);
    p.warnings = out.warnings.slice();
    if (!p.range) {
      // No dates in the file name: fall back to the first and last day in
      // the data, and say so, because a removed entry at either edge won't be cleared.
      var mm = I.minMax(out.rows);
      if (mm) { p.range = mm; p.warnings.unshift('No date range in the file name, so the range was taken from the data. Adjust it if the export covered more days.'); }
      out = p.source === 'legs' ? I.buildLegDays(p.file.rows, p.detailRows, p.range) : I.buildScheduleDays(p.file.rows, p.range);
    }
    if (p.source === 'legs' && !p.detailRows.length) p.warnings.push('No leg detail file added, so flight hours are scheduled times, not actual.');
    p.rows = out.rows;
    p.pilots = out.pilots;
    p.newNames = out.pilots.filter(function (n) { return !roster[n]; });
    p.counts = {};
    out.rows.forEach(function (r) { p.counts[r.category] = (p.counts[r.category] || 0) + 1; });
  }

  function renderPlan() {
    var card = document.getElementById('planCard');
    var orphanDetail = files.some(function (f) { return f.kind === 'legDetail'; }) && !files.some(function (f) { return f.kind === 'crewLegs'; });
    card.hidden = !plans.length && !orphanDetail;
    var html = orphanDetail ? '<div class="flag"><b>Leg detail needs its crew legs file</b>The leg detail export has no crew names. Add the crew legs export for the same dates.</div>' : '';
    html += plans.map(function (p, i) {
      return '<div class="card" style="background:var(--bg)"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>' + (p.source === 'legs' ? 'Flights' : 'Schedule entries') + '</b><span class="msg">' + esc(p.file.name) + '</span></div>' +
        '<div class="range"><label for="rs' + i + '">Covers</label><input type="date" id="rs' + i + '" data-i="' + i + '" data-k="start" value="' + (p.range ? p.range.start : '') + '">' +
        '<label for="re' + i + '">to</label><input type="date" id="re' + i + '" data-i="' + i + '" data-k="end" value="' + (p.range ? p.range.end : '') + '"></div>' +
        '<p class="msg" style="margin:0">Saving replaces all ' + (p.source === 'legs' ? 'flight and layover' : 'schedule') + ' days in this range. Anything removed in Airplane Manager disappears from the board too.</p>' +
        '<div class="stats"><span><b>' + p.rows.length + '</b> pilot-days</span><span><b>' + p.pilots.length + '</b> pilots</span>' +
        Object.keys(p.counts).sort().map(function (c) { return '<span><i class="sw c-' + c + '"></i> ' + c + ' <b>' + p.counts[c] + '</b></span>'; }).join('') + '</div>' +
        (p.newNames.length ? '<div class="flag"><b>' + p.newNames.length + ' name' + (p.newNames.length > 1 ? 's' : '') + ' not on the roster</b>' + esc(p.newNames.join('; ')) + '. They\'ll be added hidden. If one is a spelling change of an existing pilot, fix the name in Airplane Manager instead.</div>' : '') +
        p.warnings.map(function (w) { return '<div class="flag">' + esc(w) + '</div>'; }).join('') +
        '</div>';
    }).join('');
    document.getElementById('plan').innerHTML = html;
    document.getElementById('saveBtn').disabled = !plans.length;
    document.querySelectorAll('#plan input[type=date]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var p = plans[+inp.dataset.i];
        p.range[inp.dataset.k] = inp.value;
        computePlan(p); renderPlan();
      });
    });
  }

  // ---------- Saving ----------

  async function save() {
    var msg = document.getElementById('saveMsg'), btn = document.getElementById('saveBtn');
    btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Saving…';
    var done = [];
    try {
      for (var i = 0; i < plans.length; i++) {
        var p = plans[i];
        if (!p.range || !p.range.start || !p.range.end || p.range.start > p.range.end) throw new Error('Check the date range for ' + p.file.name + '.');
        var r = await sb.rpc('replace_source', { p_source: p.source, p_start: p.range.start, p_end: p.range.end, p_rows: p.rows, p_file: p.file.name });
        if (r.error) throw new Error(p.file.name + ': ' + r.error.message);
        done.push(r.data + ' ' + (p.source === 'legs' ? 'flight' : 'schedule') + ' days');
      }
      msg.className = 'msg'; msg.innerHTML = '<span class="ok">Saved ' + esc(done.join(' and ')) + '. The board shows them the next time it\'s opened.</span>';
      files = []; plans = []; renderFiles(); renderPlan();
      document.getElementById('planCard').hidden = false;
      refresh();
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = 'Not saved. ' + e.message + (done.length ? ' (Already saved before the error: ' + done.join(', ') + '.)' : '');
      btn.disabled = false;
    }
  }

  // ---------- Uploads, conflicts, roster ----------

  async function refresh() {
    var rs = await CWx.fetchAll(function () { return sb.from('roster').select('*').order('name'); });
    roster = {};
    rs.forEach(function (r) { roster[r.name] = r; });
    renderRoster(rs);
    if (plans.length) { plans.forEach(computePlan); renderPlan(); }

    var up = await sb.from('uploads').select('*').order('uploaded_at', { ascending: false }).limit(15);
    document.getElementById('uploads').innerHTML = up.error ? '<p class="msg err">' + esc(up.error.message) + '</p>' : !up.data.length ? '<p class="msg">Nothing uploaded yet.</p>' :
      '<table><thead><tr><th>When</th><th>Type</th><th>Covers</th><th>Days saved</th><th>By</th></tr></thead><tbody>' + up.data.map(function (u) {
        return '<tr><td>' + esc(new Date(u.uploaded_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + '</td><td>' + (u.source === 'legs' ? 'Flights' : 'Schedule') + '</td><td class="num">' + u.start_day + ' → ' + u.end_day + '</td><td class="num">' + u.rows_saved + '</td><td>' + esc(u.uploaded_by || '') + '</td></tr>';
      }).join('') + '</tbody></table>';

    var cf = await sb.from('day_conflicts').select('*').gte('day', I.addDays(new Date().toLocaleDateString('en-CA'), -120)).order('day', { ascending: false }).limit(25);
    var cc = document.getElementById('conflictCard');
    cc.hidden = cf.error || !cf.data.length;
    if (!cc.hidden) cc.innerHTML = '<h3>Days that disagree</h3><p class="msg" style="margin:0">These pilots show a flight or trip on a day that also has vacation or sick time. The board counts them as duty. Usually one side wasn\'t updated in Airplane Manager.</p>' +
      '<div class="tablewrap"><table><thead><tr><th>Pilot</th><th>Day</th><th>Trip side</th><th>Time off side</th></tr></thead><tbody>' + cf.data.map(function (c) {
        return '<tr><td>' + esc(c.pilot) + '</td><td class="num">' + c.day + '</td><td>' + esc(c.trip_category) + '</td><td>' + esc(c.time_off_category) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  var edits = {};
  function renderRoster(rs) {
    edits = {};
    document.getElementById('saveRoster').disabled = true;
    rs.sort(function (a, b) { return (!!a.base - !!b.base) || (b.on_board - a.on_board) || String(a.base).localeCompare(String(b.base)) || a.name.localeCompare(b.name); });
    var bases = Object.keys(rs.reduce(function (s, r) { if (r.base) s[r.base] = 1; return s; }, {})).sort();
    document.getElementById('roster').innerHTML = '<datalist id="baseList">' + bases.map(function (b) { return '<option value="' + esc(b) + '">'; }).join('') + '</datalist>' +
      '<table><thead><tr><th>On board</th><th>Name in Airplane Manager</th><th>Show as</th><th>Base</th></tr></thead><tbody>' + rs.map(function (r, i) {
        return '<tr class="' + (r.on_board ? '' : 'hidden-row') + '" data-name="' + esc(r.name) + '">' +
          '<td><input type="checkbox" id="ob' + i + '" data-f="on_board"' + (r.on_board ? ' checked' : '') + ' aria-label="Show ' + esc(r.name) + ' on board"></td>' +
          '<td>' + esc(r.name) + '</td>' +
          '<td><input type="text" id="dn' + i + '" data-f="display_name" value="' + esc(r.display_name || I.displayName(r.name)) + '" aria-label="Display name"></td>' +
          '<td><input type="text" id="bs' + i + '" data-f="base" list="baseList" value="' + esc(r.base || '') + '" placeholder="e.g. Heber, Utah" aria-label="Base"></td></tr>';
      }).join('') + '</tbody></table>';
    document.querySelectorAll('#roster input').forEach(function (inp) {
      inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', function () {
        var name = inp.closest('tr').dataset.name;
        var row = edits[name] = edits[name] || Object.assign({}, roster[name]);
        row[inp.dataset.f] = inp.type === 'checkbox' ? inp.checked : (inp.value.trim() || null);
        document.getElementById('saveRoster').disabled = false;
      });
    });
  }

  async function saveRoster() {
    var msg = document.getElementById('rosterMsg');
    var rows = Object.keys(edits).map(function (n) {
      var e = edits[n];
      return { name: n, display_name: e.display_name, base: e.base, on_board: !!e.on_board, updated_at: new Date().toISOString() };
    });
    var r = await sb.from('roster').upsert(rows);
    if (r.error) { msg.className = 'msg err'; msg.textContent = r.error.message; return; }
    msg.className = 'msg'; msg.textContent = 'Saved ' + rows.length + ' roster change' + (rows.length > 1 ? 's' : '') + '.';
    refresh();
  }
})();
