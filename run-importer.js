// Runs the importer on real exports, outside the browser.
// Usage: node test/run-importer.js <file.csv> [more files...]
// Needs: npm install papaparse   (same parser the upload page uses)
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const I = require('../js/importer.js');

const files = process.argv.slice(2).map(f => {
  const parsed = Papa.parse(fs.readFileSync(f, 'utf8'), { header: true, skipEmptyLines: true });
  const kind = I.detect(parsed.meta.fields);
  return { name: path.basename(f), kind, rows: parsed.data, range: I.rangeFromFileName(path.basename(f)) };
});
files.forEach(f => console.log(`${f.name}: ${I.FILE_LABELS[f.kind]}, ${f.rows.length} rows, range ${JSON.stringify(f.range)}`));

const crew = files.find(f => f.kind === 'crewLegs');
const det = files.find(f => f.kind === 'legDetail');
const sch = files.filter(f => f.kind === 'schedule');
let all = [];
if (crew) {
  const r = I.buildLegDays(crew.rows, det && det.rows, crew.range);
  console.log('\nFlights →', r.rows.length, 'pilot-days,', r.pilots.length, 'pilots'); r.warnings.forEach(w => console.log('  !', w));
  all = all.concat(r.rows);
}
sch.forEach(s => {
  const r = I.buildScheduleDays(s.rows, s.range);
  console.log('Schedule →', r.rows.length, 'pilot-days,', r.pilots.length, 'pilots'); r.warnings.forEach(w => console.log('  !', w));
  all = all.concat(r.rows);
});
const days = I.resolve(all);
const count = {};
days.forEach(d => { count[d.category] = (count[d.category] || 0) + 1; });
console.log('\nCombined:', days.length, 'pilot-days', count);
if (process.env.OUT) { fs.writeFileSync(process.env.OUT, JSON.stringify({ entries: all, days }, null, 0)); console.log('wrote', process.env.OUT); }
