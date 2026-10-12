import * as E from './engine.js';
import { PRESET_POINTS, CONTEXT_FACTS } from './points.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x, d = 0) => (x == null || Number.isNaN(x) ? '—' : Number(x).toLocaleString('es-AR', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)} %`);
const hhmm = (ms) => new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: E.TZ });
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'recién';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
};

// ---------------------------------------------------------------- almacenamiento local (solo conveniencia)
const store = {
  get(k, d) { try { const v = localStorage.getItem('srs:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('srs:' + k, JSON.stringify(v)); } catch { /* lleno o bloqueado */ } },
};

const MIN = 60000;
const REFRESH = { point: 15 * MIN, ranking: 30 * MIN, rivers: 180 * MIN, mountain: 60 * MIN, server: 10 * MIN };

const S = {
  thresholds: { ...E.DEFAULT_THRESHOLDS, ...store.get('thresholds', {}) },
  selected: store.get('selected', null),
  live: null, geo: 'desconocido', watchId: null, lastLiveFetch: null,
  det: null, ens: null, clim: null, A: null, bands: [],
  ranking: store.get('ranking', null), flood: null, floodClims: {}, rivers: null, mountain: store.get('mountain', null),
  server: {}, src: store.get('src', {}), busy: {}, mapReady: false, installEvt: null,
  at: { point: 0, ranking: store.get('ranking')?.at || 0, rivers: 0, mountain: store.get('mountain')?.at || 0, server: 0 },
};

function setSrc(key, status, msg = '') {
  S.src[key] = { status, msg, at: Date.now() };
  store.set('src', S.src);
  if (!$('#tab-fuentes').hidden) renderSources();
}

// ---------------------------------------------------------------- puntos
function userPoints() { return store.get('points', { custom: [], overrides: {}, hidden: [] }); }
function allPoints() {
  const u = userPoints();
  const pts = PRESET_POINTS.filter((p) => !u.hidden.includes(p.id)).map((p) => ({ ...p, ...(u.overrides[p.id] || {}) }));
  for (const c of u.custom) pts.push({ ...c, group: 'Agregados por vos', custom: true });
  return pts;
}
function livePoint() {
  return S.live ? { id: 'live', name: 'Mi ubicación', group: 'Ahora', lat: S.live.lat, lon: S.live.lon, source: `GPS del dispositivo (±${Math.round(S.live.acc)} m)`, verified: true } : null;
}
function currentPoint() {
  if (S.selected === 'live') return livePoint() || allPoints()[0];
  return allPoints().find((p) => p.id === S.selected) || allPoints()[0];
}
const km = (a, b) => {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// ---------------------------------------------------------------- ubicación en tiempo real
function startGeo() {
  if (!('geolocation' in navigator)) { S.geo = 'no disponible'; renderPerms(); obState(); return; }
  if (S.watchId != null) return;
  S.geo = 'pidiendo';
  obState();
  S.watchId = navigator.geolocation.watchPosition((pos) => {
    const first = !S.live;
    // se redondea a 1 km antes de pedir pronósticos; la coordenada fina queda en el dispositivo
    S.live = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now() };
    S.geo = 'activa';
    store.set('geoOk', true);
    obState(); renderPerms(); updateLiveOnMap();
    if (first && (!S.selected || S.selected === 'live' || !store.get('selectedByUser'))) selectPoint('live', false);
    else if (S.selected === 'live') {
      const q = { lat: +S.live.lat.toFixed(2), lon: +S.live.lon.toFixed(2) };
      if (!S.lastLiveFetch || km(q, S.lastLiveFetch) > 2) refreshPoint();
    }
  }, (err) => {
    S.geo = err.code === 1 ? 'denegada' : 'sin señal';
    if (err.code === 1) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; store.set('geoOk', false); }
    obState(); renderPerms();
  }, { enableHighAccuracy: true, maximumAge: 60000, timeout: 30000 });
}

async function geoAlreadyGranted() {
  try {
    const p = await navigator.permissions.query({ name: 'geolocation' });
    return p.state === 'granted';
  } catch { return store.get('geoOk', false); }
}

// ---------------------------------------------------------------- avisos
async function askNotif() {
  if (!('Notification' in window)) { toast('Este navegador no permite avisos.'); return; }
  const r = await Notification.requestPermission();
  obState(); renderPerms();
  if (r === 'granted') toast('Avisos activados en este dispositivo.');
}
async function notify(point, A) {
  const notified = store.get('notified', {});
  const last = notified[point.id] ?? 1;
  if (A.maxLevel >= 2 && A.maxLevel > last) {
    const top = A.hazards[0];
    const title = `${E.LEVEL_TEXT[A.maxLevel]} · ${point.name}`;
    const body = `${top.title}: ${top.headline}${top.when ? ' · ' + top.when : ''}. Aviso preventivo calculado, no alerta oficial.`;
    toast(`${title}. ${top.title}.`);
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) await reg.showNotification(title, { body, tag: 'srs-' + point.id, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
        else new Notification(title, { body, icon: 'icons/icon-192.png' });
      } catch { /* sin permiso efectivo */ }
    }
  }
  notified[point.id] = A.maxLevel >= 1 ? A.maxLevel : last;
  store.set('notified', notified);
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

// ---------------------------------------------------------------- descarga y evaluación del punto
async function refreshPoint() {
  const p = currentPoint();
  if (!p || S.busy.point) return;
  S.busy.point = true;
  renderHeader('Actualizando…');
  const q = p.id === 'live' ? { lat: +p.lat.toFixed(2), lon: +p.lon.toFixed(2) } : { lat: p.lat, lon: p.lon };
  if (p.id === 'live') S.lastLiveFetch = q;
  // Los ensambles cambian 2 a 4 veces por día: se piden como mucho una vez por hora (cuidan el cupo gratuito).
  const needEns = !S.ens || S.ensFor !== p.id || Date.now() - (S.ensAt || 0) > 60 * MIN;
  const [det, ens] = await Promise.allSettled([E.fetchDeterministic(q), needEns ? E.fetchEnsemble(q) : Promise.resolve(S.ens)]);
  S.busy.point = false;
  if (det.status === 'fulfilled') { S.det = det.value; setSrc('det', 'ok', `${Object.keys(det.value.models).length} modelos`); }
  else { S.det = null; setSrc('det', 'err', det.reason?.message); }
  if (ens.status === 'fulfilled') {
    S.ens = ens.value;
    if (needEns) { S.ensAt = Date.now(); S.ensFor = p.id; setSrc('ens', 'ok', `${ens.value.members.precipitation.length} escenarios`); }
  } else { S.ens = null; setSrc('ens', 'err', ens.reason?.message); }

  if (!S.det && !S.ens) {
    const cached = store.get('cache:' + p.id, null);
    if (cached) { S.A = cached.A; S.bands = cached.bands; S.at.point = cached.at; renderAhora(true); }
    else { S.A = null; renderAhora(true); }
    renderHeader();
    return;
  }
  S.at.point = Date.now();
  // climatología por celda ERA5 (0,25°): puntos cercanos comparten la misma consulta pesada
  const qc = { lat: Math.round(q.lat * 4) / 4, lon: Math.round(q.lon * 4) / 4 };
  S.clim = loadClim(qc);
  evaluate(p);
  if (!S.clim && !S.busy['clim' + climKey(qc)]) fetchClim(qc, p);
}

function climKey(q) { return `clim:${q.lat.toFixed(2)},${q.lon.toFixed(2)}`; }
function loadClim(q) { return store.get(climKey(q), null); }
async function fetchClim(q, p) {
  S.busy['clim' + climKey(q)] = true;
  try {
    const c = await E.fetchPrecipClim(q);
    store.set(climKey(q), c);
    setSrc('era5', 'ok', `anual ${fmt(c.annual)} mm`);
    if (currentPoint()?.id === p.id) { S.clim = c; evaluate(p, true); }
  } catch (e) { setSrc('era5', 'err', e.message); }
  S.busy['clim' + climKey(q)] = false;
}

function evaluate(p, quiet = false) {
  const prev = store.get('prev:' + p.id, null);
  S.A = E.assessAll({ det: S.det, ens: S.ens, clim: S.clim, thresholds: S.thresholds });
  S.bands = E.hourlyPrecipBands(S.det);
  S.changes = diffAssessments(prev, S.A);
  if (!quiet) {
    store.set('prev:' + p.id, slimA(S.A));
    logPrediction(p, S.A);
    notify(p, S.A);
  }
  store.set('cache:' + p.id, { A: S.A, bands: S.bands, at: S.at.point });
  const lv = store.get('levels', {}); lv[p.id] = S.A.maxLevel; store.set('levels', lv);
  renderAhora(); renderHeader(); refreshMapMarkers();
}

function slimA(A) {
  return { at: Date.now(), hz: Object.fromEntries(A.hazards.map((h) => [h.id, { level: h.level, m: h.metrics || {} }])) };
}

function diffAssessments(prev, A) {
  if (!prev) return ['Primera consulta para este punto en este dispositivo.'];
  const out = [];
  for (const h of A.hazards) {
    const o = prev.hz[h.id];
    if (!o) continue;
    if (o.level !== h.level) out.push(`${h.title}: pasó de ${E.LEVEL_TEXT[o.level]} a ${E.LEVEL_TEXT[h.level]}.`);
    const m = h.metrics || {}, om = o.m || {};
    if (h.id === 'lluvia' && m.median24 != null && om.median24 != null && Math.abs(m.median24 - om.median24) >= 5)
      out.push(`Lluvia máxima en 24 h: ${fmt(om.median24)} → ${fmt(m.median24)} mm.`);
    if (h.id === 'lluvia' && m.eP1 != null && om.eP1 != null && Math.abs(m.eP1 - om.eP1) >= 0.1)
      out.push(`Escenarios con ≥ ${S.thresholds.rain24[0]} mm: ${pct(om.eP1)} → ${pct(m.eP1)}.`);
    if (h.id === 'viento' && m.medMax != null && om.medMax != null && Math.abs(m.medMax - om.medMax) >= 10)
      out.push(`Ráfaga máxima: ${fmt(om.medMax)} → ${fmt(m.medMax)} km/h.`);
    if (h.id === 'tormenta' && m.capeMed != null && om.capeMed != null && Math.abs(m.capeMed - om.capeMed) >= 300)
      out.push(`Energía para tormentas: ${fmt(om.capeMed)} → ${fmt(m.capeMed)} J/kg.`);
  }
  if (!out.length) out.push(`Sin cambios importantes respecto de la consulta de las ${hhmm(prev.at)}.`);
  return out;
}

function logPrediction(p, A) {
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: E.TZ });
  const log = store.get('log', []);
  if (log.some((r) => r.d === day && r.id === p.id)) return;
  const tomorrow = A.outlook?.rows?.[1];
  log.push({
    d: day, id: p.id, lat: +p.lat.toFixed(2), lon: +p.lon.toFixed(2),
    lv: Object.fromEntries(A.hazards.map((h) => [h.id, h.level])),
    tomorrow: tomorrow ? { key: tomorrow.key, median: tomorrow.median, P10: tomorrow.P10, P20: tomorrow.P20 } : null,
  });
  store.set('log', log.slice(-400));
}

// ---------------------------------------------------------------- otras fuentes
async function refreshRanking(force = false) {
  if (S.busy.ranking || (!force && Date.now() - S.at.ranking < REFRESH.ranking)) return;
  S.busy.ranking = true;
  try {
    const pts = allPoints();
    const lp = livePoint();
    if (lp) pts.unshift({ ...lp, lat: +lp.lat.toFixed(2), lon: +lp.lon.toFixed(2) });
    const rows = await E.fetchMultiPointRain(pts);
    S.ranking = { at: Date.now(), rows };
    S.at.ranking = Date.now();
    store.set('ranking', S.ranking);
    setSrc('multi', 'ok', `${rows.length} puntos`);
  } catch (e) { setSrc('multi', 'err', e.message); }
  S.busy.ranking = false;
  renderRanking(); refreshMapMarkers();
}

async function refreshRivers(force = false) {
  if (S.busy.rivers || (!force && Date.now() - S.at.rivers < REFRESH.rivers)) return;
  S.busy.rivers = true;
  try {
    S.flood = await E.fetchFlood();
    S.at.rivers = Date.now();
    setSrc('glofas', 'ok', `${S.flood.length} tramos`);
    for (const c of E.RIVER_CELLS) {
      S.floodClims[c.id] = store.get('fclim:' + c.id, null);
      if (!S.floodClims[c.id]) {
        try { S.floodClims[c.id] = await E.fetchFloodClim(c); store.set('fclim:' + c.id, S.floodClims[c.id]); }
        catch (e) { setSrc('glofasClim', 'err', e.message); }
      }
    }
    if (Object.values(S.floodClims).some(Boolean)) setSrc('glofasClim', 'ok', 'referencia 1991-2020');
    S.rivers = E.assessRivers(S.flood, S.floodClims);
  } catch (e) { setSrc('glofas', 'err', e.message); }
  S.busy.rivers = false;
  renderRivers(); refreshMapMarkers();
}

async function refreshMountain(force = false) {
  if (S.busy.mountain || (!force && Date.now() - S.at.mountain < REFRESH.mountain)) return;
  S.busy.mountain = true;
  try {
    const pts = PRESET_POINTS.filter((p) => p.mountain);
    const rows = await E.fetchMountain(pts);
    S.mountain = { at: Date.now(), rows };
    S.at.mountain = Date.now();
    store.set('mountain', S.mountain);
    setSrc('mountain', 'ok', `${rows.length} puntos de cordillera`);
  } catch (e) { setSrc('mountain', 'err', e.message); }
  S.busy.mountain = false;
  renderMountain();
}

// Datos que deja el vigía (GitHub Actions) junto a la app: alertas SMN, ENSO, verificación.
async function refreshServer(force = false) {
  if (!force && Date.now() - S.at.server < REFRESH.server) return;
  S.at.server = Date.now();
  // primero la copia publicada junto a la app; si no está (app abierta desde la PC), la del repositorio
  const REMOTE = 'https://raw.githubusercontent.com/SebitaSin/-ni-o-deja-ya-de-/main/data/';
  const get = async (f) => {
    for (const base of ['data/', REMOTE]) {
      try { const r = await fetch(`${base}${f}?t=${Date.now()}`, { cache: 'no-store' }); if (r.ok) return await r.json(); } catch { /* sigue */ }
    }
    return null;
  };
  const [estado, smn, enso, verif] = await Promise.all([get('estado.json'), get('smn_alertas.json'), get('enso.json'), get('verificacion.json')]);
  S.server = { estado, smn, enso, verif };
  if (estado) setSrc('vigia', Date.now() - Date.parse(estado.generated) < 3 * 3600e3 ? 'ok' : 'warn', `última corrida ${ago(Date.parse(estado.generated))}`);
  else setSrc('vigia', 'off', 'todavía no está instalado');
  if (smn) setSrc('smn', 'ok', `${smn.alerts?.length ?? 0} alertas que tocan Mendoza, ${smn.nationalCount ?? '—'} en el país`); else setSrc('smn', 'off', 'llega con el vigía');
  if (enso) setSrc('enso', 'ok', `semana ${enso.weekly?.at(-1)?.week ?? ''}`); else setSrc('enso', 'off', 'llega con el vigía');
  renderSMN(); renderContext(); renderVerif();
}

// ---------------------------------------------------------------- render: encabezado
function renderHeader(msg) {
  const p = currentPoint();
  $('#pointName').textContent = p ? p.name : '—';
  const f = $('#fresh');
  f.className = 'fresh';
  if (msg) { f.textContent = msg; return; }
  if (!S.at.point) { f.textContent = ''; return; }
  const age = Date.now() - S.at.point;
  if (!S.det && !S.ens) { f.className = 'fresh off'; f.textContent = `Sin conexión · datos ${ago(S.at.point)}`; }
  else if (age > 3 * 3600e3) { f.className = 'fresh stale'; f.textContent = `Datos ${ago(S.at.point)}`; }
  else f.textContent = `Actualizado ${hhmm(S.at.point)}`;
}

// ---------------------------------------------------------------- render: Ahora
function renderAhora(offline = false) {
  const A = S.A;
  const v = $('#verdict');
  if (!A) {
    v.className = 'verdict lv-0';
    $('#verdictText').textContent = offline ? 'Sin conexión y sin datos guardados para este punto' : 'Consultando modelos…';
    $('#verdictMeta').textContent = '';
    $('#hazards').innerHTML = '';
    return;
  }
  v.className = `verdict lv-${A.maxLevel}`;
  $('#verdictText').textContent = A.summary;
  const top = A.hazards[0];
  const conf = top?.confidence ? `Confianza ${top.confidence.level}` : '';
  $('#verdictMeta').textContent = [conf, `${A.modelsUsed.length} modelos`, `${A.ensembleMembers} escenarios`,
    A.grid ? `celda ${fmt(A.grid.lat, 2)}, ${fmt(A.grid.lon, 2)}` : '', offline ? 'datos guardados' : ''].filter(Boolean).join(' · ');

  $('#hazards').innerHTML = A.hazards.map((h, i) => `
    <details class="hz lv-${h.level}" ${i === 0 && h.level >= 2 ? 'open' : ''}>
      <summary>
        <span class="stripe"></span>
        <span class="hz-title">${esc(h.title)}</span>
        <span class="pill">${E.LEVEL_TEXT[h.level]}</span>
        <span class="hz-head">${esc(h.headline)}</span>
        <span class="hz-when">${h.when ? 'Cuándo: ' + esc(h.when) + ' · ' : ''}${h.confidence ? 'Confianza ' + esc(h.confidence.level) : ''}</span>
      </summary>
      <div class="hz-body">
        <h4>Por qué</h4>
        <table class="ev">${(h.evidence || []).map((e) => `<tr><td>${esc(e.label)}</td><td>${esc(e.value)}</td></tr>`).join('')}</table>
        ${h.models?.length ? `<h4>Cada modelo</h4><div class="models">${h.models.map((m) => `<span>${esc(m.model)} ${fmt(m.value)} ${esc(m.unit)}${m.extra ? ' · ' + esc(m.extra) : ''}</span>`).join('')}</div>` : ''}
        ${h.confidence ? `<h4>Confianza</h4><p class="conf"><b>${esc(h.confidence.level)}</b>: ${esc(h.confidence.reasons.join('; '))}.</p>` : ''}
        ${(h.notes || []).map((n) => `<p>${esc(n)}</p>`).join('')}
      </div>
    </details>`).join('');

  renderRainChart();
  renderOutlook();
  $('#changes').innerHTML = (S.changes || []).map((c) => `<li>${esc(c)}</li>`).join('');
  renderRanking();
  renderSMN();
}

function renderRainChart() {
  const b = S.bands;
  const el = $('#rainChart');
  const off = S.det?.offset ?? -10800;
  if (!b?.length) { el.innerHTML = '<p class="hint" style="padding:8px">Sin datos horarios.</p>'; return; }
  const W = 720, H = 190, L = 34, R = 8, T = 10, B = 30;
  const maxV = Math.max(2, ...b.map((x) => x.hi ?? 0)) * 1.1;
  const step = (W - L - R) / b.length;
  const y = (v) => T + (H - T - B) * (1 - v / maxV);
  const ticks = [0, maxV / 2, maxV].map((v) => Math.round(v * 10) / 10);
  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  for (const t of ticks) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t, t < 10 ? 1 : 0)}</text>`;
  b.forEach((x, i) => {
    const cx = L + i * step;
    const lp = E.localParts(x.t, off);
    if (lp.h === 0) s += `<line class="grid" x1="${cx}" x2="${cx}" y1="${T}" y2="${H - B}"/><text x="${cx + 3}" y="${H - 8}">${E.dayLabel(lp.key, E.localParts(Date.now() / 1000, off).key)}</text>`;
    else if (lp.h % 6 === 0) s += `<text x="${cx}" y="${H - B + 13}" text-anchor="middle">${lp.h}</text>`;
    if (x.hi != null && x.hi > 0.05) s += `<line class="rng" x1="${cx + step / 2}" x2="${cx + step / 2}" y1="${y(x.lo)}" y2="${y(x.hi)}"/>`;
    if (x.med != null && x.med > 0) s += `<rect class="bar" x="${cx + 0.5}" y="${y(x.med)}" width="${Math.max(1, step - 1)}" height="${(H - B) - y(x.med)}"/>`;
  });
  s += `<text x="${L}" y="${T + 2}" dy="-1" style="font-size:10px">mm/h</text></svg>`;
  el.innerHTML = s;
}

function renderOutlook() {
  const o = S.A?.outlook;
  const el = $('#outlook');
  if (!o) { el.innerHTML = '<p class="hint">Sin ensamble disponible.</p>'; $('#outlookNote').textContent = ''; return; }
  const T1 = S.thresholds.rain24[0];
  el.innerHTML = `<div class="ol-row ol-head"><span>Día</span><span>Escenarios con ≥ 10 mm</span><span style="text-align:right">mm (rango 80 %)</span></div>` +
    o.rows.map((r, i) => `
    <div class="ol-row ${i > 7 ? 'far' : ''}" title="${r.n} escenarios">
      <span class="ol-day">${esc(r.label)}${r.partial ? '*' : ''}</span>
      <span class="ol-p"><span class="f ${r.P20 >= S.thresholds.prob ? 'w' : ''}" style="width:${Math.round((r.P10 ?? 0) * 100)}%"></span><span>${pct(r.P10)}${r.P20 >= 0.05 ? ` · ≥${T1}: ${pct(r.P20)}` : ''}</span></span>
      <span class="ol-mm"><b>${fmt(r.median, 1)}</b> (${fmt(r.p10, 0)}–${fmt(r.p90, 0)})</span>
    </div>`).join('');
  const normal = o.sumNormal != null ? ` Lo normal para estos días en este punto (ERA5 1991-2020) es ${fmt(o.sumNormal)} mm.` : '';
  $('#outlookNote').textContent = `Suma de medianas: ${fmt(o.sumMedian)} mm.${normal} Barra amarilla: ${pct(S.thresholds.prob)} o más de escenarios con ≥ ${T1} mm. Del día 8 en adelante la confianza baja. * hoy: desde ahora.`;
}

function renderRanking() {
  const el = $('#ranking');
  const r = S.ranking?.rows?.filter((x) => x.median != null);
  if (!r?.length) { el.innerHTML = `<li class="hint">${S.src.multi?.status === 'err' ? 'La fuente no respondió (' + esc(S.src.multi.msg) + '). Se reintenta sola.' : 'Calculando…'}</li>`; return; }
  const sorted = r.slice().sort((a, b) => b.median - a.median);
  const max = Math.max(1, sorted[0].median);
  const sel = currentPoint()?.id;
  const show = sorted.slice(0, 8);
  if (sel && !show.some((x) => x.id === sel)) { const s = sorted.find((x) => x.id === sel); if (s) show.push(s); }
  el.innerHTML = show.map((x) => `
    <li class="${x.id === sel ? 'sel' : ''}"><span class="nm">${esc(x.name)}</span>
    <span class="track"><span class="fill" style="width:${Math.round((x.median / max) * 100)}%"></span></span>
    <span class="v">${fmt(x.median)} mm (${fmt(x.min)}–${fmt(x.max)})</span></li>`).join('');
}

function pointInPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
const SEV = { Minor: 'menor', Moderate: 'moderada', Severe: 'severa', Extreme: 'extrema', Unknown: 'sin dato' };
function renderSMN() {
  const el = $('#smnBanner');
  const p = currentPoint();
  const alerts = (S.server.smn?.alerts || []).filter((a) => Date.parse(a.expires) > Date.now() && a.polygons?.some((poly) => pointInPoly(p.lat, p.lon, poly)));
  if (!alerts.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = alerts.map((a) => `
    <p class="seal">Alerta oficial · Servicio Meteorológico Nacional</p>
    <h3>${esc(a.event)} · severidad ${esc(SEV[a.severity] || a.severity)}</h3>
    <p>Desde ${esc(new Date(a.onset).toLocaleString('es-AR', { timeZone: E.TZ, weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))} hasta ${esc(new Date(a.expires).toLocaleString('es-AR', { timeZone: E.TZ, weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</p>
    <p>${esc(a.description)}</p>
    <p><a href="https://www.smn.gob.ar/alertas" target="_blank" rel="noopener">Ver en smn.gob.ar</a></p>`).join('<hr>');
}

// ---------------------------------------------------------------- render: mapa
let map, markers = {}, liveMarker, liveCircle, irLayer, imergLayer, riverLayer;
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function initMap() {
  if (S.mapReady || typeof L === 'undefined') return;
  map = L.map('map', { zoomControl: true }).setView([-34.66, -68.45], 9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
  const gibs = (layer) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`;
  irLayer = L.tileLayer(gibs('GOES-East_ABI_Band13_Clean_Infrared'), { maxNativeZoom: 6, maxZoom: 18, opacity: 0.55, attribution: 'NASA GIBS · GOES-East' });
  imergLayer = L.tileLayer(gibs('IMERG_Precipitation_Rate_30min'), { maxNativeZoom: 6, maxZoom: 18, opacity: 0.75, attribution: 'NASA GIBS · IMERG' });
  irLayer.on('tileload', () => setSrc('goes', 'ok', 'última imagen disponible')).on('tileerror', () => setSrc('goes', 'err', 'no cargó'));
  imergLayer.on('tileload', () => setSrc('imerg', 'ok', 'última media hora disponible')).on('tileerror', () => setSrc('imerg', 'err', 'no cargó'));
  $('#layerIR').addEventListener('change', (e) => (e.target.checked ? irLayer.addTo(map) : irLayer.remove()));
  $('#layerIMERG').addEventListener('change', (e) => (e.target.checked ? imergLayer.addTo(map) : imergLayer.remove()));
  riverLayer = L.layerGroup().addTo(map);
  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    L.popup().setLatLng(e.latlng).setContent(`
      <div><b>Agregar punto aquí</b><br><span class="num">${lat.toFixed(5)}, ${lng.toFixed(5)}</span><br>
      <input id="mapNewName" type="text" placeholder="Nombre" style="width:100%;margin-top:6px;padding:6px;font-size:16px">
      <button class="btn small primary" id="mapAdd" data-lat="${lat}" data-lon="${lng}">Agregar</button></div>`).openOn(map);
  });
  map.on('popupopen', () => {
    const b = document.getElementById('mapAdd');
    if (b) b.onclick = () => {
      const name = document.getElementById('mapNewName').value.trim() || `Punto ${(+b.dataset.lat).toFixed(3)}, ${(+b.dataset.lon).toFixed(3)}`;
      addCustomPoint(name, +b.dataset.lat, +b.dataset.lon, 'Elegido en el mapa');
      map.closePopup();
    };
    const go = document.querySelector('.leaflet-popup [data-go]');
    if (go) go.onclick = () => { selectPoint(go.dataset.go); showTab('ahora'); };
  });
  S.mapReady = true;
  refreshMapMarkers(); updateLiveOnMap();
}
function rainColor(mm) {
  if (mm == null) return css('--nodata');
  if (mm >= 40) return css('--alert');
  if (mm >= 20) return css('--watch');
  if (mm >= 5) return css('--bar');
  return css('--muted');
}
function refreshMapMarkers() {
  if (!S.mapReady) return;
  const rank = Object.fromEntries((S.ranking?.rows || []).map((r) => [r.id, r]));
  const sel = currentPoint()?.id;
  for (const m of Object.values(markers)) m.remove();
  markers = {};
  for (const p of allPoints()) {
    const r = rank[p.id];
    const c = rainColor(r?.median);
    const m = L.circleMarker([p.lat, p.lon], {
      radius: p.id === sel ? 10 : 7, color: p.id === sel ? css('--ink') : css('--surface'), weight: p.id === sel ? 3 : 2,
      fillColor: c, fillOpacity: 0.9,
    }).addTo(map);
    m.bindPopup(`<b>${esc(p.name)}</b><br>${r?.median != null ? `Lluvia 72 h: ${fmt(r.median)} mm (${fmt(r.min)}–${fmt(r.max)})` : 'Sin cálculo de lluvia'}<br><span style="font-size:12px">${esc(p.source || '')}${p.verified === false ? ' · <b>por confirmar</b>' : ''}</span><br><button class="btn small" data-go="${esc(p.id)}">Ver este punto</button>`);
    markers[p.id] = m;
  }
  riverLayer.clearLayers();
  for (const c of E.RIVER_CELLS) {
    const rv = S.rivers?.find((x) => x.id === c.id);
    const col = rv ? [css('--nodata'), css('--ok'), css('--watch'), css('--alert')][rv.level] : css('--nodata');
    L.rectangle([[c.lat - 0.025, c.lon - 0.025], [c.lat + 0.025, c.lon + 0.025]], { color: col, weight: 2, fillOpacity: 0.15 })
      .bindPopup(`<b>${esc(c.name)}</b><br>${rv ? esc(rv.headline) : 'Sin datos de caudal'}<br><span style="font-size:12px">Celda GloFAS 5 km</span>`).addTo(riverLayer);
  }
  $('#mapLegend').innerHTML = `<span><i style="background:${css('--muted')}"></i>&lt; 5 mm</span><span><i style="background:${css('--bar')}"></i>5–20</span><span><i style="background:${css('--watch')}"></i>20–40</span><span><i style="background:${css('--alert')}"></i>≥ 40</span><span>▢ tramo de río</span><span>◎ vos</span>`;
}
function updateLiveOnMap() {
  if (!S.mapReady || !S.live) return;
  const ll = [S.live.lat, S.live.lon];
  if (!liveMarker) {
    liveCircle = L.circle(ll, { radius: S.live.acc, color: css('--accent'), weight: 1, fillOpacity: 0.1 }).addTo(map);
    liveMarker = L.circleMarker(ll, { radius: 9, color: css('--ink'), weight: 4, fillColor: css('--surface'), fillOpacity: 1 }).addTo(map).bindPopup('Mi ubicación');
  } else { liveMarker.setLatLng(ll); liveCircle.setLatLng(ll).setRadius(S.live.acc); }
}

// ---------------------------------------------------------------- render: ríos, cordillera, contexto
function riverChart(rv) {
  const pts = [...(rv.past || []).map((x) => ({ d: x.d, q: x.q })), ...rv.series.map((x) => ({ d: x.d, med: x.med, p25: x.p25, p75: x.p75 }))];
  const clim = S.floodClims[rv.id];
  const doyOf = (d) => { const t = new Date(d + 'T00:00:00Z'); return Math.min(365, Math.floor((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5)); };
  const W = 700, H = 150, L = 38, R = 8, T = 8, B = 22;
  const vals = pts.flatMap((p) => [p.q, p.med, p.p75]).concat(clim ? pts.map((p) => clim.byDoy[1][doyOf(p.d)]) : []).filter((x) => x != null);
  const maxV = Math.max(...vals) * 1.1, minV = Math.max(0, Math.min(...vals) * 0.8);
  const x = (i) => L + (i / (pts.length - 1)) * (W - L - R);
  const y = (v) => T + (H - T - B) * (1 - (v - minV) / (maxV - minV));
  const path = (key) => pts.map((p, i) => (p[key] != null ? `${i && pts[i - 1][key] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}` : '')).join('');
  let band = '';
  const fi = pts.findIndex((p) => p.med != null);
  if (fi >= 0) {
    const up = pts.map((p, i) => (p.p75 != null ? `${x(i).toFixed(1)},${y(p.p75).toFixed(1)}` : null)).filter(Boolean);
    const dn = pts.map((p, i) => (p.p25 != null ? `${x(i).toFixed(1)},${y(p.p25).toFixed(1)}` : null)).filter(Boolean).reverse();
    band = `<polygon class="band" points="${up.concat(dn).join(' ')}"/>`;
  }
  const ref = (qi, cls) => (clim ? `<path class="${cls}" fill="none" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(clim.byDoy[qi][doyOf(p.d)]).toFixed(1)}`).join('')}"/>` : '');
  const nowI = (rv.past || []).length;
  const ticks = [minV, (minV + maxV) / 2, maxV];
  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  for (const t of ticks) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`;
  s += band + ref(1, 'ref') + (maxV > (clim?.byDoy[2][doyOf(pts[0].d)] ?? Infinity) ? ref(2, 'ref2') : '');
  s += `<path class="past" d="${path('q')}"/><path class="line" d="${path('med')}"/>`;
  s += `<line class="now" x1="${x(nowI)}" x2="${x(nowI)}" y1="${T}" y2="${H - B}"/><text x="${x(nowI) + 4}" y="${H - 6}">hoy</text><text x="${W - R}" y="${H - 6}" text-anchor="end">+30 días</text>`;
  s += `<text x="${L}" y="${H - 6}">m³/s</text></svg>`;
  return s;
}
function renderRivers() {
  const el = $('#rivers');
  if (!S.rivers) { el.innerHTML = `<p class="hint">${S.src.glofas?.status === 'err' ? 'GloFAS no respondió (' + esc(S.src.glofas.msg) + '). Se reintenta sola.' : 'Consultando GloFAS…'}</p>`; return; }
  el.innerHTML = S.rivers.map((rv) => `
    <div class="card lv-${rv.level}">
      <h3><span>${esc(rv.name)}</span><span class="pill">${E.LEVEL_TEXT[rv.level]}</span></h3>
      <p>${esc(rv.headline)}</p>
      ${rv.refs ? `<p class="sub">Habitual para la fecha: ${fmt(rv.refs.p50, 1)} m³/s · alto (superado 1 de cada 10 días en esta época): ${fmt(rv.refs.p90, 1)} · muy alto (1 de cada 100): ${fmt(rv.refs.p99, 1)}</p>` : ''}
      <div class="chart">${riverChart(rv)}</div>
      <p class="sub">${esc(rv.note)}</p>
    </div>`).join('');
}
function renderMountain() {
  const el = $('#mountain');
  const rows = S.mountain?.rows;
  if (!rows) { el.innerHTML = `<p class="hint">${S.src.mountain?.status === 'err' ? 'Sin respuesta (' + esc(S.src.mountain.msg) + '). Se reintenta sola.' : 'Consultando…'}</p>`; return; }
  el.innerHTML = rows.map((m) => `
    <div class="card lv-${m.rainOnSnow ? 2 : m.precip == null ? 0 : 1}">
      <h3><span>${esc(m.name)}</span><span class="sub">${fmt(m.elevation)} m</span></h3>
      <p>Precipitación: <b>${fmt(m.precip, 1)} mm</b> · nieve: ${fmt(m.snow, 1)} cm · isoterma 0 °C máx.: ${fmt(m.freezingMax)} m</p>
      ${m.rainOnSnow ? '<p><b>Lluvia sobre nieve posible:</b> la isoterma queda por encima del punto con 10 mm o más. Acelera el escurrimiento hacia los embalses.</p>' : ''}
    </div>`).join('') + `<p class="hint">Actualizado ${S.mountain.at ? ago(S.mountain.at) : ''}. Mediana de GFS, ICON y ECMWF.</p>`;
}
function renderContext() {
  const el = $('#context');
  const enso = S.server.enso?.weekly?.at(-1);
  const live = enso ? `
    <div class="fact"><span>Niño 3.4, anomalía semanal OISST (semana ${esc(enso.week)})</span><span class="v">${enso.n34 > 0 ? '+' : ''}${fmt(enso.n34, 1)} °C</span>
    <span class="s">NOAA CPC, base 1991-2020. Niño 1+2: ${fmt(enso.n12, 1)} · Niño 3: ${fmt(enso.n3, 1)} · Niño 4: ${fmt(enso.n4, 1)} °C. Es el índice tradicional; NOAA clasifica la intensidad con el índice relativo (RONI).</span></div>` : '';
  el.innerHTML = `<div class="card">${live}${CONTEXT_FACTS.map((f) => `
    <div class="fact"><span>${esc(f.label)}</span><span class="v">${esc(f.value)}</span>
    <span class="s">${esc(f.date)} · <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.source)}</a></span></div>`).join('')}
    <p class="sub">El Niño aumenta la probabilidad de lluvias en Cuyo, pero no fija fechas ni lugares: las crecidas de abril 2021 y enero 2026 ocurrieron con La Niña. El derrame es el volumen de toda la temporada, no un caudal máximo.</p>
    <p class="sub">Perspectiva oficial de los próximos 3 meses: <a href="https://www.smn.gob.ar/pronostico-trimestral" target="_blank" rel="noopener">SMN, pronóstico trimestral</a>.</p></div>`;
}

// ---------------------------------------------------------------- render: Fuentes
const SOURCES = [
  ['det', 'Modelos del tiempo (8)', 'ECMWF, GFS, ICON, GEM, UKMO, ARPEGE, CMA, JMA vía Open-Meteo. Se actualizan cada hora; cada modelo corre 2 a 4 veces por día.'],
  ['ens', 'Ensambles (143 escenarios)', 'ECMWF 51, GEFS 31, ICON 40, GEPS 21. Base de las probabilidades a 15 días.'],
  ['multi', 'Lluvia por sector', 'Mismos modelos en todos tus puntos a la vez.'],
  ['era5', 'Climatología ERA5 1991-2020', 'Reanálisis de Copernicus. Define qué es "normal" en cada punto.'],
  ['glofas', 'Ríos (GloFAS)', 'Pronóstico de caudal a 30 días, 51 escenarios, grilla de 5 km.'],
  ['glofasClim', 'Historia de los ríos (GloFAS)', 'Reanálisis 1991-2020 para la misma fecha.'],
  ['mountain', 'Cordillera', 'Lluvia, nieve e isoterma de 0 °C en nacientes.'],
  ['goes', 'Satélite GOES-East', 'Infrarrojo cada 10 minutos (NASA GIBS).'],
  ['imerg', 'Lluvia satelital IMERG', 'NASA, cada 30 minutos, con algunas horas de demora.'],
  ['smn', 'Alertas oficiales SMN', 'Feed CAP del SMN (CC BY 4.0), filtrado por polígono. Lo descarga el vigía.'],
  ['enso', 'El Niño semanal (NOAA CPC)', 'Anomalías Niño 1+2, 3, 3.4 y 4. Lo descarga el vigía.'],
  ['vigia', 'Vigía en servidor', 'Revisa tus puntos cada hora con la app cerrada y avisa al celular por ntfy.'],
];
function renderSources() {
  $('#sources').innerHTML = SOURCES.map(([k, t, d]) => {
    const s = S.src[k];
    const cls = !s ? '' : s.status === 'ok' ? 'ok' : s.status === 'err' ? 'err' : s.status === 'warn' ? 'warn' : '';
    const st = !s ? 'sin consultar' : s.status === 'err' ? `error: ${s.msg}` : s.msg;
    return `<li><span class="dot ${cls}"></span><span class="t">${esc(t)}</span><span class="when">${s ? ago(s.at) : ''}</span><span class="d">${esc(st)}. ${esc(d)}</span></li>`;
  }).join('');
}
function renderPerms() {
  const n = 'Notification' in window ? Notification.permission : 'no disponible';
  const nTxt = { granted: 'activados', denied: 'bloqueados en el navegador', default: 'sin activar' }[n] || n;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#perms').innerHTML = `
    <div class="perm"><span>Ubicación en tiempo real<small>${esc(S.geo)}${S.live ? ` · ±${Math.round(S.live.acc)} m` : ''}</small></span>
      ${S.geo === 'activa' ? '' : `<button class="btn small" id="pGeo">${S.geo === 'denegada' ? 'Cómo habilitar' : 'Permitir'}</button>`}</div>
    <div class="perm"><span>Avisos en este dispositivo<small>${esc(nTxt)}</small></span>${n === 'default' ? '<button class="btn small" id="pNotif">Activar</button>' : ''}</div>
    <div class="perm"><span>App instalada<small>${standalone ? 'sí' : 'no'}</small></span>${!standalone && S.installEvt ? '<button class="btn small" id="pInstall">Instalar</button>' : ''}</div>`;
  $('#pGeo')?.addEventListener('click', () => {
    if (S.geo === 'denegada') toast('Habilitala en los ajustes del navegador para este sitio y volvé a abrir la app.');
    else startGeo();
  });
  $('#pNotif')?.addEventListener('click', askNotif);
  $('#pInstall')?.addEventListener('click', doInstall);
}
function renderPointList() {
  const u = userPoints();
  const pts = allPoints();
  const row = (p) => `
    <li><span>${esc(p.name)}${p.verified === false ? ' <span class="warn">· por confirmar</span>' : ''}</span>
      <span class="s">${fmt(p.lat, 5)}, ${fmt(p.lon, 5)} · ${esc(p.source || '')}</span>
      <span class="acts">
        ${p.verified === false ? `<button class="btn small" data-fix="${esc(p.id)}">Estoy acá</button>` : ''}
        <button class="btn small danger" data-del="${esc(p.id)}">Quitar</button>
      </span></li>`;
  const mine = pts.filter((p) => p.group === 'Mis puntos' || p.custom || p.verified === false);
  const rest = pts.filter((p) => !mine.includes(p));
  $('#pointList').innerHTML = mine.map(row).join('') +
    (rest.length ? `<li class="fold"><details><summary>Precargados: ${rest.length} (hospital, distritos, embalses, nacientes)</summary><ul class="point-list">${rest.map(row).join('')}</ul></details></li>` : '') +
    (u.hidden.length ? `<li><span class="s">${u.hidden.length} punto(s) precargado(s) ocultos</span><span class="acts"><button class="btn small" id="restorePts">Restaurar</button></span></li>` : '');
  $('#pointList').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = '¿Seguro?'; return; }
    removePoint(b.dataset.del);
  }));
  $('#pointList').querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', () => fixPointHere(b.dataset.fix)));
  $('#restorePts')?.addEventListener('click', () => { const v = userPoints(); v.hidden = []; store.set('points', v); renderPointList(); refreshRanking(true); });
}
function renderThresholds() {
  const t = S.thresholds;
  const row = (label, key, unit) => `<span>${label} (${unit})</span><input id="th-${key}-0" type="number" inputmode="decimal" value="${t[key][0]}"><input id="th-${key}-1" type="number" inputmode="decimal" value="${t[key][1]}">`;
  $('#thForm').innerHTML = `<span class="h">Amenaza</span><span class="h">Atención</span><span class="h">Alerta</span>
    ${row('Lluvia en 24 h', 'rain24', 'mm')}${row('Ráfagas', 'gust', 'km/h')}${row('Energía de tormenta', 'cape', 'J/kg')}
    ${row('Cizalladura', 'shear', 'km/h')}${row('Calor', 'heat', '°C')}${row('Helada', 'frost', '°C')}
    <span>Escenarios mínimos para avisar (%)</span><input id="th-prob" type="number" inputmode="numeric" value="${Math.round(t.prob * 100)}"><span></span>
    <button class="btn primary full" type="submit">Guardar y recalcular</button>
    <p class="hint full">Los valores iniciales siguen criterios de uso común: 20 y 40 mm en 24 h, ráfagas de 60 y 90 km/h, CAPE de 1000 y 2000 J/kg. En el «Por qué» de cada aviso ves cuántos días por año se superan en tu punto.</p>`;
}
function renderVerif() {
  const log = store.get('log', []);
  const v = S.server.verif;
  let html = `<p>Este dispositivo guardó <b>${log.length}</b> ${log.length === 1 ? 'pronóstico' : 'pronósticos'} (uno por punto y por día).</p>`;
  if (v && v.n >= 30) {
    html += `<p>Verificación del vigía contra ERA5 (${v.n} días): acierto de lluvia ≥ 10 mm al día siguiente ${pct(v.hitRate)}, falsas alarmas ${pct(v.farRate)}, puntaje de Brier ${fmt(v.brier, 3)} (0 es perfecto; el pronóstico de "lo normal" da ${fmt(v.brierClim, 3)}).</p>`;
  } else if (v) {
    html += `<p>El vigía lleva ${v.n ?? 0} días verificados contra ERA5. Hacen falta al menos 30 para medir aciertos y falsas alarmas con algún sentido.</p>`;
  } else {
    html += '<p>La verificación automática (pronóstico contra lo que pasó) la hace el vigía en servidor. Cuando lo instales, acá vas a ver aciertos, falsas alarmas y calibración.</p>';
  }
  $('#verif').innerHTML = html;
}

// ---------------------------------------------------------------- puntos: acciones
function addCustomPoint(name, lat, lon, source) {
  if (!(lat >= -56 && lat <= -21 && lon >= -74 && lon <= -53)) { $('#addMsg').textContent = 'Coordenadas fuera de Argentina.'; return; }
  const u = userPoints();
  const id = 'u-' + Date.now().toString(36);
  u.custom.push({ id, name, lat: +lat.toFixed(5), lon: +lon.toFixed(5), source, verified: true });
  store.set('points', u);
  $('#addMsg').textContent = `Agregado: ${name}.`;
  renderPointList(); refreshRanking(true); refreshMapMarkers();
  toast(`Punto agregado: ${name}`);
}
function removePoint(id) {
  const u = userPoints();
  if (u.custom.some((c) => c.id === id)) u.custom = u.custom.filter((c) => c.id !== id);
  else u.hidden.push(id);
  store.set('points', u);
  if (S.selected === id) selectPoint(allPoints()[0].id);
  renderPointList(); refreshMapMarkers();
}
function fixPointHere(id) {
  if (!S.live) { toast('Primero permití la ubicación y esperá la señal del GPS.'); startGeo(); return; }
  const u = userPoints();
  u.overrides[id] = { lat: +S.live.lat.toFixed(5), lon: +S.live.lon.toFixed(5), verified: true, source: `GPS del dispositivo, ${new Date().toLocaleDateString('es-AR')} (±${Math.round(S.live.acc)} m)` };
  store.set('points', u);
  renderPointList(); refreshMapMarkers(); refreshRanking(true);
  toast('Punto fijado con tu ubicación actual.');
  if (S.selected === id) refreshPoint();
}

// ---------------------------------------------------------------- selección y navegación
function selectPoint(id, byUser = true) {
  S.selected = id;
  store.set('selected', id);
  if (byUser) store.set('selectedByUser', id !== 'live');
  const p = currentPoint();
  const cached = store.get('cache:' + p.id, null);
  S.det = null; S.ens = null; S.clim = null; S.changes = [];
  if (cached) { S.A = cached.A; S.bands = cached.bands || []; S.at.point = cached.at; renderAhora(true); }
  else { S.A = null; renderAhora(); }
  renderHeader(); refreshMapMarkers();
  refreshPoint();
}
function openPointSheet() {
  const lv = store.get('levels', {});
  const groups = {};
  const lp = livePoint();
  const list = (lp ? [lp] : []).concat(allPoints());
  for (const p of list) (groups[p.group] = groups[p.group] || []).push(p);
  let html = '';
  if (!lp) html += `<h3>Ahora</h3><button data-geo="1"><span>Mi ubicación (permitir)</span></button>`;
  for (const [g, pts] of Object.entries(groups)) {
    html += `<h3>${esc(g)}</h3>` + pts.map((p) => `<button data-pick="${esc(p.id)}" aria-current="${p.id === S.selected}"><span>${esc(p.name)}${p.verified === false ? ' · por confirmar' : ''}</span><span class="lvdot l${lv[p.id] ?? 0}" aria-label="${E.LEVEL_TEXT[lv[p.id] ?? 0]}"></span></button>`).join('');
  }
  $('#pointChoices').innerHTML = html;
  $('#pointChoices').querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { closeSheet('pointSheet'); selectPoint(b.dataset.pick); }));
  $('#pointChoices').querySelector('[data-geo]')?.addEventListener('click', () => { closeSheet('pointSheet'); startGeo(); });
  $('#pointSheet').hidden = false;
}
function closeSheet(id) { $('#' + id).hidden = true; }

function showTab(name) {
  for (const t of ['ahora', 'mapa', 'rios', 'fuentes']) {
    $('#tab-' + t).hidden = t !== name;
    const b = $('#nav-' + t);
    if (t === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  if (name === 'mapa') { initMap(); setTimeout(() => map?.invalidateSize(), 50); }
  if (name === 'rios') { renderRivers(); renderMountain(); renderContext(); refreshRivers(); refreshMountain(); }
  if (name === 'fuentes') { renderSources(); renderPerms(); renderPointList(); renderThresholds(); renderVerif(); }
  store.set('tab', name);
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- primer uso
function obState() {
  const g = $('#obLocState');
  if (g) {
    g.className = 'ob-state ' + (S.geo === 'activa' ? 'ok' : S.geo === 'denegada' ? 'no' : '');
    g.textContent = { activa: '✓ Activa', denegada: 'Denegada', pidiendo: 'Esperando respuesta…', 'sin señal': 'Sin señal todavía', 'no disponible': 'No disponible' }[S.geo] || '';
  }
  const n = $('#obNotifState');
  if (n && 'Notification' in window) {
    n.className = 'ob-state ' + (Notification.permission === 'granted' ? 'ok' : Notification.permission === 'denied' ? 'no' : '');
    n.textContent = { granted: '✓ Activados', denied: 'Bloqueados' }[Notification.permission] || '';
  }
}
function setupOnboarding() {
  const total = PRESET_POINTS.length;
  document.querySelector('.ob-foot').textContent = `Ya están cargados ${total} puntos: tus 3 direcciones, el Hospital Schestakow, los distritos, los embalses y las nacientes de los ríos.`;
  $('#obLoc').addEventListener('click', startGeo);
  $('#obNotif').addEventListener('click', askNotif);
  $('#obInstall').addEventListener('click', doInstall);
  $('#obDone').addEventListener('click', () => { store.set('onboarded', true); closeSheet('onboard'); });
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) $('#obInstallItem').hidden = true;
  else if (ios) $('#obInstallText').textContent = 'En iPhone: tocá Compartir y después "Agregar a inicio". Al abrirla desde el ícono, te va a pedir la ubicación de nuevo.';
  if (!store.get('onboarded', false)) { $('#onboard').hidden = false; obState(); }
}
async function doInstall() {
  if (!S.installEvt) return;
  S.installEvt.prompt();
  await S.installEvt.userChoice.catch(() => null);
  S.installEvt = null;
  $('#obInstall').hidden = true; renderPerms();
}

// ---------------------------------------------------------------- arranque
function tick() {
  if (document.hidden) return;
  if (Date.now() - S.at.point > REFRESH.point) refreshPoint();
  refreshRanking(); refreshServer();
  if (!$('#tab-rios').hidden) { refreshRivers(); refreshMountain(); }
  renderHeader();
}

async function boot() {
  $('#pointBtn').addEventListener('click', openPointSheet);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet(b.dataset.close)));
  $('#pointSheet').addEventListener('click', (e) => { if (e.target.id === 'pointSheet') closeSheet('pointSheet'); });
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#addCoords').addEventListener('click', () => {
    const lat = parseFloat($('#newLat').value.replace(',', '.')), lon = parseFloat($('#newLon').value.replace(',', '.'));
    const name = $('#newName').value.trim();
    if (!name) { $('#addMsg').textContent = 'Poné un nombre.'; return; }
    if (Number.isNaN(lat) || Number.isNaN(lon)) { $('#addMsg').textContent = 'Revisá latitud y longitud (ej.: −34,61 y −68,33).'; return; }
    addCustomPoint(name, lat, lon, 'Coordenadas ingresadas');
  });
  $('#addHere').addEventListener('click', () => {
    if (!S.live) { startGeo(); $('#addMsg').textContent = 'Esperando la señal del GPS… volvé a tocar en unos segundos.'; return; }
    addCustomPoint($('#newName').value.trim() || `Lugar del ${new Date().toLocaleDateString('es-AR')}`, S.live.lat, S.live.lon, `GPS del dispositivo (±${Math.round(S.live.acc)} m)`);
  });
  $('#thForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const g = (id) => parseFloat($('#' + id).value);
    const t = { ...S.thresholds };
    for (const k of ['rain24', 'gust', 'cape', 'shear', 'heat', 'frost']) t[k] = [g(`th-${k}-0`), g(`th-${k}-1`)];
    t.prob = Math.min(1, Math.max(0.05, g('th-prob') / 100));
    if (Object.values(t).some((v) => (Array.isArray(v) ? v.some(Number.isNaN) : Number.isNaN(v)))) { toast('Revisá los números.'); return; }
    S.thresholds = t;
    store.set('thresholds', t);
    if (S.det || S.ens) evaluate(currentPoint(), true);
    toast('Umbrales guardados. Avisos recalculados.');
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; $('#obInstall').hidden = false; renderPerms(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('online', () => { toast('Conexión recuperada.'); tick(); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  setupOnboarding();
  if (await geoAlreadyGranted()) startGeo();
  if (!S.selected || (S.selected !== 'live' && !allPoints().some((p) => p.id === S.selected))) S.selected = 'bariloche-gaboto';
  if (S.selected === 'live' && !S.live) S.selected = store.get('lastFixed', 'bariloche-gaboto');
  showTab(store.get('tab', 'ahora'));
  selectPoint(S.selected, false);
  renderRanking();
  refreshRanking(true); refreshServer(true);
  setInterval(tick, MIN);
}

boot();
