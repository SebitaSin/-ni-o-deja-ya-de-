import * as E from '../js/engine.js';
const P = { lat: -34.61659, lon: -68.31626 };
const t0 = Date.now();
const [det, ens, flood] = await Promise.all([
  E.fetchDeterministic(P).catch(e => ({ err: e.message })),
  E.fetchEnsemble(P).catch(e => ({ err: e.message })),
  E.fetchFlood().catch(e => ({ err: e.message })),
]);
console.log('fetch ms', Date.now() - t0, 'det models', det.err || Object.keys(det.models), 'grid', det.grid);
console.log('ens members', ens.err || Object.fromEntries(Object.entries(ens.members).map(([k, v]) => [k, v.length])));
let clim = null;
try { clim = await E.fetchPrecipClim(P); console.log('clim annual', clim.annual, 'perYear', clim.perYear, 'monthly', clim.monthly); } catch (e) { console.log('clim ERR', e.message); }
const A = E.assessAll({ det: det.err ? null : det, ens: ens.err ? null : ens, clim });
console.log('SUMMARY:', A.summary, '| maxLevel', A.maxLevel, '| models', A.modelsUsed.join(', '), '| members', A.ensembleMembers);
for (const h of A.hazards) {
  console.log(`\n[${E.LEVEL_TEXT[h.level]}] ${h.title}: ${h.headline} | cuándo: ${h.when} | confianza: ${h.confidence?.level} (${h.confidence?.reasons.join('; ')})`);
  for (const ev of h.evidence) console.log('   -', ev.label, ':', ev.value);
  if (h.models) console.log('   modelos:', h.models.map(m => `${m.model}=${m.value}${m.extra ? ' (' + m.extra + ')' : ''}`).join(' | '));
}
console.log('\nOUTLOOK 15d: sumMedian', A.outlook?.sumMedian, 'sumNormal', A.outlook?.sumNormal);
for (const r of A.outlook?.rows || []) console.log(`  ${r.label.padEnd(8)} n=${r.n} med=${r.median} p10-p90=${r.p10}-${r.p90} P10=${(r.P10*100).toFixed(0)}% P20=${(r.P20*100).toFixed(0)}% Pgust60=${r.Pg==null?'-':(r.Pg*100).toFixed(0)+'%'} normal=${r.normal}`);
if (!flood.err) {
  const clims = {};
  for (const c of E.RIVER_CELLS) { try { clims[c.id] = await E.fetchFloodClim(c); } catch (e) { console.log('floodclim ERR', c.id, e.message); } }
  for (const r of E.assessRivers(flood, clims)) console.log(`RIO [${E.LEVEL_TEXT[r.level]}] ${r.name}: ${r.headline} refs=${JSON.stringify(r.refs)}`);
} else console.log('flood ERR', flood.err);
