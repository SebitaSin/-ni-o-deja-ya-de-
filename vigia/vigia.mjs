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
import * as T from '../js/telemetry.js';

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

// ---------------------------------------------------------------- 6. mediciones en tiempo real
// Telemetría de Irrigación: guarda historia de 72 h para calcular lluvia por hora y subida de ríos.
async function telemetry() {
  const stations = await T.fetchDGI((u, o) => fetch(u, { ...o, headers: { ...(o?.headers || {}), ...UA } }));
  const prev = await readJSON('telemetria.json', { stations: [] });
  const hist = Object.fromEntries((prev.stations || []).map((s) => [s.id, s.hist || []]));
  const keep = stations.filter((s) => s.ageH <= 24 * 30 && s.kind !== 'otro');
  const out = keep.map((s) => {
    const h = T.mergeHistory(hist[s.id], s);
    const r1 = T.rainLast(h, s, 60), r24 = T.rainLast(h, s, 1440);
    const dq1 = T.changeLast(h, s, 60, 'flow'), dh1 = T.changeLast(h, s, 60, 'height');
    return {
      id: s.id, name: s.name, lat: +s.lat.toFixed(4), lon: +s.lon.toFixed(4), kind: s.kind, t: s.t, ok: s.ok, flags: s.flags,
      v: Object.fromEntries(Object.entries(s.v).filter(([, x]) => x != null).map(([k, x]) => [k, +(+x).toFixed(3)])),
      rain1h: r1?.mm ?? null, rain24h: r24?.mm ?? null, dFlow1h: dq1 ? +dq1.delta.toFixed(2) : null, dHeight1h: dh1 ? +dh1.delta.toFixed(1) : null,
      hist: h.map((p) => p.map((x, i) => (i === 0 ? x : x == null ? null : +(+x).toFixed(2)))),
    };
  });
  return { generated: new Date().toISOString(), source: 'Departamento General de Irrigación, telemetría pública', url: T.DGI_URL, stations: out };
}

// SYNOP horario de San Rafael Aero (87509) vía OGIMET: lluvia medida y tiempo presente (granizo, tormenta)
const WW = {
  17: 'tormenta sin lluvia', 27: 'chaparrón de granizo', 29: 'tormenta en la última hora', 60: 'lluvia débil', 61: 'lluvia débil', 62: 'lluvia moderada',
  63: 'lluvia moderada', 64: 'lluvia fuerte', 65: 'lluvia fuerte', 80: 'chaparrón débil', 81: 'chaparrón fuerte', 82: 'chaparrón violento',
  87: 'granizo pequeño', 88: 'granizo pequeño', 89: 'granizo', 90: 'granizo', 91: 'lluvia tras tormenta', 92: 'lluvia fuerte tras tormenta',
  93: 'granizo tras tormenta', 94: 'granizo fuerte tras tormenta', 95: 'tormenta con lluvia', 96: 'tormenta con granizo', 97: 'tormenta fuerte con lluvia',
  98: 'tormenta con polvo', 99: 'tormenta fuerte con granizo',
};
const PERIOD = { 1: 6, 2: 12, 3: 18, 4: 24, 5: 1, 6: 2, 7: 3, 8: 9, 9: 15 };
function decodeSynop(line) {
  const f = line.split(',');
  const t = Date.UTC(+f[1], +f[2] - 1, +f[3], +f[4], +f[5]);
  const msg = f.slice(6).join(',').replace(/=$/, '').trim();
  const groups = msg.split(/\s+/);
  const out = { t, raw: msg, rain: [], ww: null };
  const i333 = groups.indexOf('333');
  const sec1 = groups.slice(3, i333 < 0 ? undefined : i333), sec3 = i333 < 0 ? [] : groups.slice(i333 + 1);
  const rr = (g) => {
    const RRR = +g.slice(1, 4), tR = +g[4];
    if (!Number.isFinite(RRR)) return null;
    const mm = RRR === 990 ? 0.05 : RRR > 990 ? (RRR - 990) / 10 : RRR;
    return { mm, hours: PERIOD[tR] ?? null };
  };
  for (const g of sec1.slice(2)) {
    if (/^6\d{3}[0-9]$/.test(g)) { const x = rr(g); if (x) out.rain.push(x); }
    if (/^7\d{4}$/.test(g)) { const ww = +g.slice(1, 3); out.ww = ww; out.wwText = WW[ww] || null; }
  }
  for (const g of sec3) if (/^6\d{3}[0-9]$/.test(g)) { const x = rr(g); if (x) out.rain.push(x); }
  return out;
}
async function airport() {
  const d = new Date(Date.now() - 30 * HOUR);
  const begin = d.toISOString().slice(0, 13).replace(/[-T]/g, '') + '00';
  const txt = await (await fetch(`https://www.ogimet.com/cgi-bin/getsynop?block=87509&begin=${begin}`, { headers: UA })).text();
  const synop = txt.split('\n').filter((l) => /^87509,/.test(l)).map(decodeSynop);
  let metar = [];
  try {
    const m = await (await fetch('https://aviationweather.gov/api/data/metar?ids=SAMR&format=json&hours=12', { headers: UA })).json();
    metar = (m || []).map((x) => ({ t: x.obsTime * 1000, raw: x.rawOb, wx: x.wxString || null, temp: x.temp, wspd: x.wspd, wgst: x.wgst ?? null }));
  } catch (e) { log('METAR', e.message); }
  return { generated: new Date().toISOString(), station: 'San Rafael Aero (87509 / SAMR)', source: 'SMN vía OGIMET (SYNOP) y NOAA aviationweather.gov (METAR)', synop: synop.slice(-30), metar: metar.slice(0, 12) };
}

// Reportes publicados (no son mediciones): noticias y prensa oficial filtradas por palabras clave.
const KEYS = /tormenta|granizo|piedra|anegad|anegamiento|inund|crecida|desborde|desbord|arroyo|aluvi|evacuad|corte de luz|sin luz|sin energ|apag[oó]n|corte de agua|sin agua|ruta cortada|calle cortada|corte de ruta|defensa civil|temporal|r[ií]o atuel|r[ií]o diamante|hedionda|el tigre|el salado|zonda|ca[ií]da de [aá]rbol/i;
const PLACE = /san rafael|sanrafael|sur mendocino|sur provincial|oasis sur|atuel|diamante|valle grande|nihuil|goudge|rama ca[ií]da|cuadro|ca[ñn]ada seca|monte com[aá]n|villa atuel|real del padre|las paredes|salto de las rosas|las malvinas|jaime prats|25 de mayo/i;
const FEEDS = [
  { name: 'Google Noticias', url: 'https://news.google.com/rss/search?q=%22San+Rafael%22+Mendoza+(tormenta+OR+granizo+OR+anegamiento+OR+inundaci%C3%B3n+OR+crecida+OR+arroyo+OR+%22corte+de+luz%22+OR+%22sin+luz%22+OR+evacuados+OR+%22Defensa+Civil%22)+when:3d&hl=es-419&gl=AR&ceid=AR:es-419', needPlace: true, titleOnly: true },
  { name: 'Municipalidad de San Rafael', url: 'https://www.sanrafael.gov.ar/feed/', needPlace: false },
  { name: 'Gobierno de Mendoza (prensa)', url: 'https://www.mendoza.gov.ar/prensa/feed/', needPlace: true },
  { name: 'Diario San Rafael', url: 'https://diariosanrafael.com.ar/feed/', needPlace: false },
];
async function reports() {
  const items = [];
  for (const f of FEEDS) {
    try {
      const x = await (await fetch(f.url, { headers: UA })).text();
      for (const it of x.split(/<item>/).slice(1)) {
        const title = decode(tag(it, 'title').replace(/<!\[CDATA\[|\]\]>/g, ''));
        const link = decode(tag(it, 'link'));
        const date = Date.parse(tag(it, 'pubDate'));
        const desc = decode(tag(it, 'description').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')).slice(0, 400);
        const text = `${title} ${desc}`;
        if (!Number.isFinite(date) || Date.now() - date > 72 * HOUR) continue;
        if (!KEYS.test(text)) continue;
        if (f.needPlace && !(f.titleOnly ? (PLACE.test(title) || /mendoza/i.test(title)) : PLACE.test(text))) continue;
        if (f.titleOnly && !KEYS.test(title)) continue;
        items.push({ source: f.name, title, link, date, keys: [...new Set((text.match(new RegExp(KEYS.source, 'gi')) || []).map((k) => k.toLowerCase()))].slice(0, 5) });
      }
    } catch (e) { log('feed', f.name, e.message); }
  }
  const seen = new Set();
  const uniq = items.sort((a, b) => b.date - a.date).filter((i) => { const k = i.title.toLowerCase().slice(0, 70); if (seen.has(k)) return false; seen.add(k); return true; });
  return { generated: new Date().toISOString(), note: 'Reportes publicados por medios y organismos. No son mediciones.', items: uniq.slice(0, 40) };
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
  const tel = await run('telemetría', () => telemetry());
  const aero = await run('aeropuerto', () => airport());
  const rep = await run('reportes', () => reports());
  if (tel) await writeJSON('telemetria.json', tel);
  if (aero) await writeJSON('aeropuerto.json', aero);
  if (rep) await writeJSON('reportes.json', rep);

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
  for (const p of PRESET_POINTS.filter((x) => WATCH.includes(x.id))) {
    const near = (tel?.stations || []).filter((st) => st.kind === 'pluvio' && st.ok && st.rain1h != null && T.distanceKm(p, st) <= 12);
    const top = near.sort((a, b) => b.rain1h - a.rain1h)[0];
    const k = 'medido:' + p.id;
    if (top && top.rain1h >= 10 && ageOf(sent.levels[k + ':t']) > 3 * HOUR) {
      await run('ntfy', () => ntfy({ title: `Lluvia medida fuerte · ${p.name}`, message: `${top.rain1h} mm en la última hora en el pluviómetro ${top.name} (a ${T.distanceKm(p, top).toFixed(1)} km). Dato de Irrigación.`, priority: 4, tags: ['cloud_with_rain'] }));
      sent.levels[k + ':t'] = new Date().toISOString();
    }
  }
  const up = (tel?.stations || []).find((st) => /atuel - 1 puente sosneado|puente sosneado - ruta 40/i.test(st.name) || st.id === '8056');
  if (up && up.ok && up.dHeight1h != null && up.dHeight1h >= 30 && ageOf(sent.levels['sosneado:t']) > 3 * HOUR) {
    await run('ntfy', () => ntfy({ title: 'Subida rápida del Atuel en Puente Sosneado', message: `La escala subió ${up.dHeight1h} cm en la última hora (ahora ${up.v.height} cm). Aguas arriba de El Nihuil. Dato de Irrigación.`, priority: 4, tags: ['ocean'] }));
    sent.levels['sosneado:t'] = new Date().toISOString();
  }
  const hail = (aero?.synop || []).filter((o) => Date.now() - o.t < 2 * HOUR && o.ww != null && [27, 87, 88, 89, 90, 93, 94, 96, 99].includes(o.ww));
  if (hail.length && ageOf(sent.levels['granizo:t']) > 3 * HOUR) {
    await run('ntfy', () => ntfy({ title: 'Granizo observado en San Rafael Aero', message: `Observación SYNOP: ${hail.at(-1).wwText}. Dato del SMN.`, priority: 4, tags: ['ice_cube'] }));
    sent.levels['granizo:t'] = new Date().toISOString();
  }
  sent.smn = sent.smn.slice(-200);
  await writeJSON('avisos.json', sent);
  await writeJSON('state.json', state);
  log('listo', { estaciones: tel?.stations?.length, reportes: rep?.items?.length, synop: aero?.synop?.length, puntos: points.length, rios: riv?.length, alertasMendoza: smn?.alerts?.length, errores: errors.length, hora: localHour() });
}

main().catch((e) => { console.error(e); process.exit(1); });
