/* ======================================================================
   Crew Workload importer
   Turns Airplane Manager CSV exports into one row per pilot per day.

   Everything here is a "pure function": data in, data out, no network,
   no page. That's deliberate. It means the same file runs in the browser
   (upload page) and in Node (test/run-importer.js), so the merge logic
   can be tested against real exports without clicking anything.
   ====================================================================== */
(function (root) {
  'use strict';

  // Categories, in priority order. When a pilot has two things on one day,
  // the earlier one wins (the database view uses the same order).
  var CATEGORIES = ['Flying', 'Training', 'Travel', 'Office', 'Standby', 'Layover', 'Sick', 'Vacation', 'Other'];
  // Which categories count as a duty day.
  var DUTY = ['Flying', 'Training', 'Travel', 'Office', 'Standby', 'Layover'];

  // ---------- Small helpers ----------

  // "Coffey, Benjamin (Ben)" -> "Coffey, Benjamin".
  // Some reports add nicknames and some don't; stripping them gives one
  // spelling per person so rows from different files line up.
  function cleanName(s) {
    return String(s || '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  }

  // "Androl, Garrick David" -> "Garrick Androl"
  function displayName(name) {
    var p = String(name).split(',');
    if (p.length < 2) return name;
    return p[1].trim().split(' ')[0] + ' ' + p[0].trim();
  }

  // "10/1/2026 5:45:00 AM" -> { day: "2026-10-01", t: sortable number, midnight: bool }
  function parseLocal(s) {
    var m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
    if (!m) return null;
    var h = (+m[4]) % 12;
    if (/pm/i.test(m[7])) h += 12;
    return {
      day: m[3] + '-' + pad(m[1]) + '-' + pad(m[2]),
      t: Date.UTC(+m[3], +m[1] - 1, +m[2], h, +m[5], +(m[6] || 0)),
      midnight: h === 0 && +m[5] === 0 && +(m[6] || 0) === 0
    };
  }
  function pad(x) { return String(x).padStart(2, '0'); }

  // Day math on "YYYY-MM-DD" strings, in UTC, so a daylight-saving change
  // can never shift a date by an hour into the wrong day.
  function addDays(day, n) {
    var d = new Date(day + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function diffDays(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }
  function eachDay(a, b, fn) { for (var d = a; d <= b; d = addDays(d, 1)) fn(d); }

  // ---------- Recognizing files ----------

  // Identify a file by its column headers, not its file name. People rename
  // files; Airplane Manager's column names are much more stable.
  function detect(headers) {
    var h = {};
    (headers || []).forEach(function (x) { h[String(x).trim()] = true; });
    if (h['Crew Name'] && h['Flight (Trip) Number']) return 'crewLegs';
    if (h['Leg Order'] && h['Arrival Date/Time Local']) return 'legDetail';
    if (h['Staff Name'] && h['Type'] && h['Start Local']) return 'schedule';
    if (h['Summary Report URL']) return 'tripList';
    return 'unknown';
  }

  var FILE_LABELS = {
    crewLegs: 'Crew legs (who flew which leg)',
    legDetail: 'Leg detail (actual flight times)',
    schedule: 'Schedule entries (training, travel, vacation…)',
    tripList: 'Trip list',
    unknown: 'Not recognized'
  };

  // Airplane Manager names exports like "...report-2026_10_01_05Z-2026_11_12_06Z.csv".
  // The end stamp is midnight at the END of the range, so the last day
  // actually covered is the day before it.
  function rangeFromFileName(name) {
    var m = String(name || '').match(/(\d{4})_(\d{2})_(\d{2})_\d{2}Z-(\d{4})_(\d{2})_(\d{2})_\d{2}Z/);
    if (!m) return null;
    return { start: m[1] + '-' + m[2] + '-' + m[3], end: addDays(m[4] + '-' + m[5] + '-' + m[6], -1) };
  }

  // ---------- Flights: crew legs (+ optional leg detail) ----------

  /*
    crewRows:   rows from the crew legs export (one row per pilot per leg)
    detailRows: rows from the leg detail export (one row per leg, actual times) — optional
    range:      { start, end } days to keep
    Returns { rows, warnings, pilots }
  */
  function buildLegDays(crewRows, detailRows, range, opts) {
    opts = opts || {};
    // A gap inside one trip longer than this is treated as the pilot going
    // home rather than sitting on a layover.
    var maxGap = opts.maxLayoverGap == null ? 4 : opts.maxLayoverGap;
    var warnings = [];

    // 1) Index leg detail by trip + from + to + occurrence. Occurrence is
    //    needed because one trip can fly the same city pair twice
    //    (KRBL→KSJC, KSJC→KRBL, KRBL→KSJC).
    var detail = {};
    var haveDetail = !!(detailRows && detailRows.length);
    if (haveDetail) {
      var seen = {};
      detailRows.slice().sort(function (a, b) {
        return String(a['Flight (Trip) Number']).localeCompare(String(b['Flight (Trip) Number'])) ||
               ((+a['Leg Order'] || 0) - (+b['Leg Order'] || 0));
      }).forEach(function (r) {
        var key = [r['Flight (Trip) Number'], r['Departure Location (Airport)'], r['Arrival Location (Airport)']].join('|');
        var k = seen[key] || 0;
        seen[key] = k + 1;
        var arr = parseLocal(r['Arrival Date/Time Local']);
        detail[key + '|' + k] = {
          arrDay: arr ? arr.day : null,
          hours: parseFloat(r['Flight Time (HR)']) || 0
        };
      });
    }

    // 2) Turn crew rows into legs, matched to their detail.
    var legs = [];
    var bad = 0;
    crewRows.forEach(function (r) {
      var dep = parseLocal(r['Scheduled Departure Date/Time (Local)']);
      var pilot = cleanName(r['Crew Name']);
      if (!dep || !pilot) { bad++; return; }
      legs.push({
        pilot: pilot, trip: String(r['Flight (Trip) Number'] || '').trim(),
        tail: String(r['Aircraft Tail'] || '').trim(),
        from: r['Departure Location (Airport)'], to: r['Arrival Location (Airport)'],
        depDay: dep.day, t: dep.t, schedHr: parseFloat(r['Scheduled Flight Time (HR)']) || 0
      });
    });
    if (bad) warnings.push(bad + ' crew rows had no name or an unreadable date and were skipped.');

    legs.sort(function (a, b) { return a.trip.localeCompare(b.trip) || a.t - b.t; });
    var occ = {}, unmatched = 0;
    legs.forEach(function (l) {
      var key = [l.trip, l.from, l.to].join('|');
      var ok = key + '|' + l.pilot;
      var k = occ[ok] || 0;
      occ[ok] = k + 1;
      var d = detail[key + '|' + k];
      if (haveDetail && !d) unmatched++;
      l.arrDay = d && d.arrDay ? d.arrDay : l.depDay;
      l.hours = d ? d.hours : l.schedHr;
      l.flown = haveDetail ? !!(d && d.hours > 0) : null;
    });
    if (unmatched) warnings.push(unmatched + ' crew legs had no match in the leg detail file; scheduled times were used for those.');

    // 3) Build days per pilot per trip: leg days are Flying, the days in
    //    between are Layover (inferred — nothing in the export records RONs).
    var byDay = {}; // pilot|day -> row
    function put(pilot, day, cat, trip, tail) {
      if (range && (day < range.start || day > range.end)) return null;
      var key = pilot + '|' + day;
      var row = byDay[key];
      if (!row) row = byDay[key] = { pilot: pilot, day: day, category: cat, trips: {}, tail: tail, legs: 0, flight_hr: 0, flown: false, sched: false };
      if (cat === 'Flying') row.category = 'Flying';
      row.trips[trip] = true;
      return row;
    }

    var groups = {};
    legs.forEach(function (l) { (groups[l.pilot + '|' + l.trip] = groups[l.pilot + '|' + l.trip] || []).push(l); });
    Object.keys(groups).forEach(function (g) {
      var gl = groups[g];
      var days = {};
      gl.forEach(function (l) {
        days[l.depDay] = true; days[l.arrDay] = true;
        var row = put(l.pilot, l.depDay, 'Flying', l.trip, l.tail);
        if (row) {
          row.legs += 1;
          row.flight_hr += l.hours;
          if (l.flown === true) row.flown = true;
          if (l.flown === false) row.sched = true;
        }
        if (l.arrDay !== l.depDay) put(l.pilot, l.arrDay, 'Flying', l.trip, l.tail); // landed after midnight
      });
      var sorted = Object.keys(days).sort();
      for (var i = 1; i < sorted.length; i++) {
        var gap = diffDays(sorted[i - 1], sorted[i]) - 1;
        if (gap > 0 && gap <= maxGap) {
          for (var d = addDays(sorted[i - 1], 1); d < sorted[i]; d = addDays(d, 1)) put(gl[0].pilot, d, 'Layover', gl[0].trip, gl[0].tail);
        }
      }
    });

    var rows = Object.keys(byDay).map(function (k) {
      var r = byDay[k];
      var status = r.category === 'Layover' ? 'Inferred'
        : r.flown ? 'Flown'
        : r.sched ? 'Scheduled'
        : (haveDetail ? 'Scheduled' : 'Unverified');
      return {
        pilot: r.pilot, day: r.day, category: r.category,
        detail: Object.keys(r.trips).sort().join(' / '),
        tail: r.tail, legs: r.legs, flight_hr: Math.round(r.flight_hr * 100) / 100, status: status
      };
    }).sort(byPilotDay);

    return { rows: rows, warnings: warnings, pilots: uniq(rows.map(function (r) { return r.pilot; })) };
  }

  // ---------- Schedule entries ----------

  // Map Airplane Manager schedule types to board categories. Known names
  // first, then keyword rules so a renamed type still lands somewhere sensible.
  var TYPE_MAP = { 'Travel Day': 'Travel', 'Training': 'Training', 'Vacation': 'Vacation', 'Office Duty Only': 'Office' };
  function mapType(t) {
    t = String(t || '').trim();
    if (TYPE_MAP[t]) return TYPE_MAP[t];
    if (/vacat|pto|leave|holiday/i.test(t)) return 'Vacation';
    if (/sick|medical/i.test(t)) return 'Sick';
    if (/train|recurrent|checkride|sim\b/i.test(t)) return 'Training';
    if (/travel|deadhead|commut|position/i.test(t)) return 'Travel';
    if (/office|admin/i.test(t)) return 'Office';
    if (/call|standby|reserve/i.test(t)) return 'Standby';
    return 'Other';
  }

  function buildScheduleDays(schedRows, range) {
    var warnings = [], unmapped = {}, bad = 0;
    var byKey = {};
    schedRows.forEach(function (r) {
      var pilot = cleanName(r['Staff Name']);
      var s = parseLocal(r['Start Local']);
      var e = parseLocal(r['End Local']) || s;
      if (!pilot || !s) { bad++; return; }
      var type = String(r['Type'] || '').trim();
      var cat = mapType(type);
      if (cat === 'Other') unmapped[type] = (unmapped[type] || 0) + 1;
      // An entry ending exactly at midnight doesn't include that day.
      var last = (e.midnight && e.day > s.day) ? addDays(e.day, -1) : e.day;
      var note = String(r['Note'] || '').trim();
      var detail = type + (note ? ' · ' + note : '');
      eachDay(s.day, last, function (d) {
        if (range && (d < range.start || d > range.end)) return;
        var k = pilot + '|' + d + '|' + cat;
        if (!byKey[k]) byKey[k] = { pilot: pilot, day: d, category: cat, detail: detail, tail: null, legs: 0, flight_hr: 0, status: 'Scheduled' };
      });
    });
    if (bad) warnings.push(bad + ' schedule rows had no name or an unreadable date and were skipped.');
    var types = Object.keys(unmapped);
    if (types.length) warnings.push('Schedule types not recognized, saved as "Other": ' + types.map(function (t) { return t + ' (' + unmapped[t] + ')'; }).join(', ') + '.');
    var rows = Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(byPilotDay);
    return { rows: rows, warnings: warnings, pilots: uniq(rows.map(function (r) { return r.pilot; })), unmapped: types };
  }

  // ---------- Combining (same rule as the database view) ----------

  function resolve(rows) {
    var rank = {};
    CATEGORIES.forEach(function (c, i) { rank[c] = i; });
    var best = {};
    rows.forEach(function (r) {
      var k = r.pilot + '|' + r.day;
      if (!best[k] || rank[r.category] < rank[best[k].category]) best[k] = r;
    });
    return Object.keys(best).map(function (k) { return best[k]; }).sort(byPilotDay);
  }

  function byPilotDay(a, b) { return a.pilot.localeCompare(b.pilot) || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0); }
  function uniq(a) { var s = {}; a.forEach(function (x) { s[x] = true; }); return Object.keys(s).sort(); }
  function minMax(rows) {
    if (!rows.length) return null;
    var lo = rows[0].day, hi = rows[0].day;
    rows.forEach(function (r) { if (r.day < lo) lo = r.day; if (r.day > hi) hi = r.day; });
    return { start: lo, end: hi };
  }

  var api = {
    CATEGORIES: CATEGORIES, DUTY: DUTY, FILE_LABELS: FILE_LABELS,
    cleanName: cleanName, displayName: displayName, parseLocal: parseLocal,
    addDays: addDays, diffDays: diffDays, detect: detect, rangeFromFileName: rangeFromFileName,
    mapType: mapType, buildLegDays: buildLegDays, buildScheduleDays: buildScheduleDays,
    resolve: resolve, minMax: minMax
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CWImport = api;
})(this);
