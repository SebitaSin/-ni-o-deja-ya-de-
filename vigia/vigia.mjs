// Vigía de San Rafael Sentinel. Corre cada hora en GitHub Actions
// con el mismo motor que la app. Escribe data/*.json para la app y avisa por ntfy al celular.
//
// Variables de entorno:
//   NTFY_TOPIC    tema privado de ntfy (sin él no manda avisos)
//   NTFY_SERVER   por defecto https://ntfy.sh
//   APP_URL       dirección pública de la app (para el enlace del aviso)
//   VIGIA_PUNTOS  ids de puntos a vigilar, separados por coma

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../js/engine.js';
import { PRESET_POINTS } from '../js/points.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const APP_URL = process.env.APP_URL || '';
const WATCH = (process.env.VIGIA_PUNTOS || 'bariloche-gaboto,rp160-rojo,day-1532,hospital').split(',').map((s) => s.trim()).filter(Boolean);
const UA = { 'User-Agent': 'SanRafaelSentinel-vigia/1.0' };
const HOUR = 3600e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function readJSON(f, d) { try { return JSON.parse(await fs.readFile(path.join(DATA, f), 'utf8')); } catch { return d; } }
async function writeJSON(f, v) { await fs.mkdir(path.dirname(path.join(DATA, f)), { recursive: true }); await fs.writeFile(path.join(DATA, f), JSON.stringify(v)); }
const ageOf = (iso) => (iso ? Date.now() - Date.parse(iso) : Infinity);
const localDate = (ms = Date.now()) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: E.TZ });
const localHour = () => +new Date().toLocaleString('en-GB', { timeZone: E.TZ, hour: '2-digit', hour12: false });

async function ntfy({ title, message, priority = 3, tags = [] }) {
  if (!NTFY_TOPIC) { log('ntfy sin configurar:', title); return; }
  // publicación JSON de ntfy: todo en UTF-8, sin problemas con acentos en encabezados
  const body = { topic: NTFY_TOPIC, title, message, priority, tags };
  if (APP_URL) body.click = APP_URL;
  const r = await fetch(NTFY_SERVER, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...UA } });
  log('ntfy', r.status, title);
  if (!r.ok) throw new Error(`ntfy HTTP ${r.status}`);
}

// ---------------------------------------------------------------- 1. puntos vigilados
async function watchPoints() {
  const points = PRESET_POINTS.filter((p) => WATCH.includes(p.id));
  const out = [];
  for (const p of points) {
    let det = null, ens = null;
    const err = [];
    try { det = await E.fetchDeterministic(p); } catch (e) { err.push('modelos: ' + e.message); }
    await sleep(800);
    try { ens = await E.fetchEnsemble(p); } catch (e) { err.push('ensamble: ' + e.message); }
    const A = E.assessAll({ det, ens, clim: null });
    out.push({
      id: p.id, name: p.name, lat: p.lat, lon: p.lon,
      maxLevel: A.maxLevel, summary: A.summary,
      hazards: A.hazards.map((h) => ({ id: h.id, title: h.title, level: h.level, headline: h.headline, when: h.when, confidence: h.confidence?.level })),
      tomorrow: A.outlook?.rows?.[1] || null, models: A.modelsUsed.length, members: A.ensembleMembers,
      errors: err,
    });
    await sleep(1500);
  }
  return out;
}

// ---------------------------------------------------------------- 2. ríos
async function rivers(state) {
  if (ageOf(state.riversAt) < 3 * HOUR - 5 * 60e3 && state.rivers) return state.rivers;
  const flood = await E.fetchFlood();
  const clims = await readJSON('fclim.json', {});
  for (const c of E.RIVER_CELLS) {
    if (!clims[c.id]) { clims[c.id] = await E.fetchFloodClim(c); await sleep(1500); }
  }
  await writeJSON('fclim.json', clims);
  state.riversAt = new Date().toISOString();
  state.rivers = E.assessRivers(flood, clims).map((r) => ({ id: r.id, name: r.name, level: r.level, headline: r.headline, upstream: r.upstream }));
  return state.rivers;
}

// ---------------------------------------------------------------- 3. alertas oficiales SMN (CAP, CC BY 4.0)
const decode = (s) => (s || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
const tag = (x, t) => decode((x.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1]);
const MENDOZA_BOX = { s: -37.7, n: -32.0, w: -70.7, e: -66.4 };

function pointInPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

async function smnAlerts() {
  const feed = await (await fetch('https://ssl.smn.gob.ar/CAP/AR.php', { headers: UA })).text();
  const links = [...feed.matchAll(/<item>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<\/item>/g)].map((m) => decode(m[1]));
  const cache = await readJSON('smn_cache.json', {});
  const next = {};
  for (const link of links) {
    if (cache[link]) { next[link] = cache[link]; continue; }
    try {
      const x = await (await fetch(link, { headers: UA })).text();
      const polys = [...x.matchAll(/<polygon>([\s\S]*?)<\/polygon>/g)].map((m) => m[1].trim().split(/\s+/).map((pr) => pr.split(',').map(Number)));
      next[link] = {
        id: link, event: tag(x, 'event'), severity: tag(x, 'severity'), certainty: tag(x, 'certainty'), urgency: tag(x, 'urgency'),
        onset: tag(x, 'onset'), expires: tag(x, 'expires'), sent: tag(x, 'sent'), msgType: tag(x, 'msgType'),
        description: tag(x, 'description'), instruction: tag(x, 'instruction'), polygons: polys,
      };
      await sleep(250);
    } catch (e) { log('CAP no leído', link, e.message); }
  }
  await writeJSON('smn_cache.json', next);
  const all = Object.values(next).filter((a) => Date.parse(a.expires) > Date.now());
  const inBox = all.filter((a) => a.polygons.some((poly) => poly.some(([la, lo]) => la >= MENDOZA_BOX.s && la <= MENDOZA_BOX.n && lo >= MENDOZA_BOX.w && lo <= MENDOZA_BOX.e)));
  for (const a of inBox) a.points = PRESET_POINTS.filter((p) => a.polygons.some((poly) => pointInPoly(p.lat, p.lon, poly))).map((p) => p.id);
  return { generated: new Date().toISOString(), source: 'SMN Argentina, feed CAP https://ssl.smn.gob.ar/CAP/AR.php (CC BY 4.0)', nationalCount: all.length, alerts: inBox };
}

// ---------------------------------------------------------------- 4. ENSO semanal (NOAA CPC)
async function enso(prev) {
  if (prev && ageOf(prev.generated) < 6 * HOUR) return prev;
  const t = await (await fetch('https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for', { headers: UA })).text();
  const weekly = [];
  for (const line of t.split('\n')) {
    const m = line.match(/^\s*(\d{2}[A-Z]{3}\d{4})\s+([-\d.]+)\s*([-\d.]+)\s+([-\d.]+)\s*([-\d.]+)\s+([-\d.]+)\s*([-\d.]+)\s+([-\d.]+)\s*([-\d.]+)/);
    if (m) weekly.push({ week: m[1], n12: +m[3], n3: +m[5], n34: +m[7], n4: +m[9] });
  }
  if (!weekly.length) throw new Error('formato CPC no reconocido');
  return { generated: new Date().toISOString(), source: 'NOAA CPC wksst9120.for (OISST, anomalía respecto de 1991-2020)', weekly: weekly.slice(-26) };
}

// ---------------------------------------------------------------- 5. registro y verificación contra ERA5
async function registerAndVerify(points) {
  const today = localDate();
  const file = `registro/${today.slice(0, 7)}.json`;
  const month = await readJSON(file, []);
  for (const p of points) {
    if (!p.tomorrow || month.some((r) => r.d === today && r.id === p.id)) continue;
    month.push({ d: today, id: p.id, lat: p.lat, lon: p.lon, target: p.tomorrow.key, median: p.tomorrow.median, P10: p.tomorrow.P10, P20: p.tomorrow.P20, levels: Object.fromEntries(p.hazards.map((h) => [h.id, h.level])) });
  }
  await writeJSON(file, month);

  const verif = await readJSON('verificacion.json', { rows: [] });
  if (verif.day === today) return verif;
  const files = (await fs.readdir(path.join(DATA, 'registro')).catch(() => [])).filter((f) => f.endsWith('.json'));
  const pending = [];
  for (const f of files) for (const r of await readJSON('registro/' + f, [])) {
    const age = (Date.parse(today) - Date.parse(r.target)) / 864e5;
    if (age >= 6 && !verif.rows.some((v) => v.id === r.id && v.target === r.target)) pending.push(r);
  }
  const byPoint = {};
  for (const r of pending) (byPoint[r.id] = byPoint[r.id] || []).push(r);
  for (const rows of Object.values(byPoint)) {
    const start = rows.map((r) => r.target).sort()[0], end = rows.map((r) => r.target).sort().at(-1);
    try {
      const d = await E.getJSON(`${E.API.archive}?latitude=${rows[0].lat}&longitude=${rows[0].lon}&daily=precipitation_sum&start_date=${start}&end_date=${end}&timezone=${encodeURIComponent(E.TZ)}`);
      for (const r of rows) {
        const i = d.daily.time.indexOf(r.target);
        const obs = i >= 0 ? d.daily.precipitation_sum[i] : null;
        if (obs != null) verif.rows.push({ id: r.id, target: r.target, P10: r.P10, median: r.median, obs });
      }
      await sleep(1500);
    } catch (e) { log('verificación ERA5', e.message); }
  }
  const rows = verif.rows.filter((r) => r.P10 != null);
  const n = rows.length;
  const ev = rows.map((r) => (r.obs >= 10 ? 1 : 0));
  const yes = rows.map((r) => r.P10 >= 0.5);
  let H = 0, M = 0, F = 0;
  rows.forEach((r, i) => { if (ev[i] && yes[i]) H++; else if (ev[i]) M++; else if (yes[i]) F++; });
  const base = n ? ev.reduce((a, x) => a + x, 0) / n : null;
  return {
    ...verif, day: today, generated: new Date().toISOString(), n,
    hitRate: H + M ? H / (H + M) : null, farRate: H + F ? F / (H + F) : null,
    brier: n ? rows.reduce((a, r, i) => a + (r.P10 - ev[i]) ** 2, 0) / n : null,
    brierClim: n ? ev.reduce((a, o) => a + (base - o) ** 2, 0) / n : null,
    note: 'Pronóstico del día siguiente (probabilidad de ≥ 10 mm) contra ERA5. ERA5 es reanálisis, no estación: sirve para comparar, no para medir una calle.',
  };
}

// ---------------------------------------------------------------- principal
async function main() {
  await fs.mkdir(DATA, { recursive: true });
  const state = await readJSON('state.json', {});
  const errors = [];
  const run = async (name, fn) => { try { return await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); log('ERROR', name, e.message); return null; } };

  const points = (await run('puntos', () => watchPoints())) || [];
  const riv = await run('ríos', () => rivers(state));
  const smn = await run('smn', () => smnAlerts());
  const ens = await run('enso', async () => enso(await readJSON('enso.json', null)));
  const verif = await run('verificación', () => registerAndVerify(points));

  if (smn) await writeJSON('smn_alertas.json', smn);
  if (ens) await writeJSON('enso.json', ens);
  if (verif) await writeJSON('verificacion.json', verif);
  await writeJSON('estado.json', { generated: new Date().toISOString(), watched: WATCH, points, rivers: riv, errors });

  // avisos: solo cuando un punto sube de nivel, o aparece una alerta oficial nueva que lo toca
  const sent = await readJSON('avisos.json', { levels: {}, smn: [] });
  for (const p of points) {
    const last = sent.levels[p.id] ?? 1;
    if (p.maxLevel >= 2 && p.maxLevel > last) {
      const h = p.hazards[0];
      await run('ntfy', () => ntfy({
        title: `${E.LEVEL_TEXT[p.maxLevel]} · ${p.name}`,
        message: `${h.title}: ${h.headline}${h.when ? ' · ' + h.when : ''}. Confianza ${h.confidence}. Aviso preventivo calculado, no alerta oficial.`,
        priority: p.maxLevel === 3 ? 4 : 3, tags: [p.maxLevel === 3 ? 'rotating_light' : 'warning'],
      }));
    }
    if (p.maxLevel >= 1) sent.levels[p.id] = p.maxLevel;
  }
  for (const r of riv || []) {
    const k = 'rio:' + r.id, last = sent.levels[k] ?? 1;
    if (r.level >= 2 && r.level > last) await run('ntfy', () => ntfy({ title: `${E.LEVEL_TEXT[r.level]} · ${r.name}`, message: `${r.headline}. Modelo GloFAS, no caudal medido.`, priority: r.level === 3 ? 4 : 3, tags: ['ocean'] }));
    if (r.level >= 1) sent.levels[k] = r.level;
  }
  for (const a of smn?.alerts || []) {
    const hits = (a.points || []).filter((id) => WATCH.includes(id));
    if (!hits.length || sent.smn.includes(a.id)) continue;
    const names = PRESET_POINTS.filter((p) => hits.includes(p.id)).map((p) => p.name).join(', ');
    await run('ntfy', () => ntfy({ title: `Alerta oficial SMN: ${a.event}`, message: `Afecta: ${names}. Desde ${a.onset} hasta ${a.expires}. ${a.description}`.slice(0, 900), priority: 4, tags: ['loudspeaker'] }));
    sent.smn.push(a.id);
  }
  sent.smn = sent.smn.slice(-200);
  await writeJSON('avisos.json', sent);
  await writeJSON('state.json', state);
  log('listo', { puntos: points.length, rios: riv?.length, alertasMendoza: smn?.alerts?.length, errores: errors.length, hora: localHour() });
}

main().catch((e) => { console.error(e); process.exit(1); });
