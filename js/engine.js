// San Rafael Sentinel — motor de datos y evaluación de amenazas.
// Mismo código en el navegador (app) y en Node (vigía en GitHub Actions).
// Regla: nada simulado. Si una fuente no responde, el resultado lo dice.

export const TZ = 'America/Argentina/Mendoza';

export const API = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  ensemble: 'https://ensemble-api.open-meteo.com/v1/ensemble',
  flood: 'https://flood-api.open-meteo.com/v1/flood',
  archive: 'https://archive-api.open-meteo.com/v1/archive',
  geocoding: 'https://geocoding-api.open-meteo.com/v1/search',
};

// Modelos deterministas globales con datos sobre Cuyo (verificado 11-oct-2026).
export const DET_MODELS = [
  { id: 'ecmwf_ifs025', name: 'ECMWF IFS' },
  { id: 'gfs_seamless', name: 'GFS' },
  { id: 'icon_seamless', name: 'ICON' },
  { id: 'gem_seamless', name: 'GEM' },
  { id: 'ukmo_seamless', name: 'UKMO' },
  { id: 'meteofrance_seamless', name: 'ARPEGE' },
  { id: 'cma_grapes_global', name: 'CMA' },
  { id: 'jma_seamless', name: 'JMA' },
];

// Ensambles: 51 + 31 + 40 + 21 = 143 escenarios.
export const ENS_MODELS = [
  { req: 'ecmwf_ifs025', suffix: 'ecmwf_ifs025_ensemble', name: 'ECMWF ENS' },
  { req: 'gfs025', suffix: 'ncep_gefs025', name: 'GEFS' },
  { req: 'icon_seamless', suffix: 'icon_seamless_eps', name: 'ICON-EPS' },
  { req: 'gem_global', suffix: 'gem_global_ensemble', name: 'GEPS' },
];

const DET_VARS = [
  'precipitation', 'cape', 'lifted_index', 'freezing_level_height',
  'wind_gusts_10m', 'wind_speed_10m', 'wind_direction_10m',
  'wind_speed_500hPa', 'wind_direction_500hPa',
  'temperature_2m', 'relative_humidity_2m', 'total_column_integrated_water_vapour',
];
const ENS_VARS = ['precipitation', 'wind_gusts_10m', 'cape'];

// Celdas de río del modelo GloFAS (grilla 0,05°), elegidas por máximo caudal
// del modelo y ubicadas respecto de embalses de OpenStreetMap.
export const RIVER_CELLS = [
  { id: 'diamante-alto', river: 'Diamante', name: 'Diamante antes de Agua del Toro', lat: -34.675, lon: -69.325, upstream: true },
  { id: 'diamante-sr', river: 'Diamante', name: 'Diamante en San Rafael', lat: -34.675, lon: -68.325, upstream: false },
  { id: 'atuel-alto', river: 'Atuel', name: 'Atuel antes de El Nihuil', lat: -35.175, lon: -69.025, upstream: true },
  { id: 'atuel-vg', river: 'Atuel', name: 'Atuel después de Valle Grande', lat: -34.825, lon: -68.525, upstream: false },
  { id: 'atuel-bajo', river: 'Atuel', name: 'Atuel en Villa Atuel', lat: -34.825, lon: -67.925, upstream: false },
];

export const DEFAULT_THRESHOLDS = {
  rain24: [20, 40],     // mm en 24 h: atención, alerta
  rain1h: 10,           // mm en una hora (los modelos globales subestiman picos convectivos)
  gust: [60, 90],       // km/h
  cape: [1000, 2000],   // J/kg
  shear: [54, 72],      // km/h entre 10 m y 500 hPa (≈15 y 20 m/s)
  frost: [0, -3],       // °C mínima
  heat: [35, 38],       // °C máxima
  prob: 0.3,            // fracción de escenarios del ensamble
  agree: 0.5,           // fracción de modelos deterministas
};

export const LEVEL = { NODATA: 0, OK: 1, WATCH: 2, ALERT: 3 };
export const LEVEL_TEXT = ['Sin datos', 'Normal', 'Atención', 'Alerta'];

// ---------------------------------------------------------------- red

export async function getJSON(url, { timeout = 30000, retries = 1 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        let reason = '';
        try { reason = JSON.parse(body).reason || ''; } catch { reason = body.slice(0, 120); }
        const msg = r.status === 429
          ? (/daily/i.test(reason) ? 'se agotó el cupo gratuito del día; vuelve mañana' : 'demasiadas consultas seguidas; se reintenta en unos minutos')
          : `HTTP ${r.status}${reason ? ': ' + reason : ''}`;
        const err = new Error(msg);
        err.status = r.status;
        throw err;
      }
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (e.status && e.status < 500) break;
      await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------- descarga

export async function fetchDeterministic({ lat, lon }) {
  const url = `${API.forecast}?${qs({
    latitude: round(lat, 3), longitude: round(lon, 3),
    hourly: DET_VARS.join(','), models: DET_MODELS.map((m) => m.id).join(','),
    past_days: 3, forecast_days: 4, timeformat: 'unixtime', timezone: TZ,
  })}`;
  const d = await getJSON(url);
  const h = d.hourly;
  const models = {};
  for (const m of DET_MODELS) {
    const series = {};
    let any = false;
    for (const v of DET_VARS) {
      const arr = h[`${v}_${m.id}`];
      if (arr && arr.some((x) => x != null)) { series[v] = arr; any = true; }
    }
    if (any) models[m.id] = series;
  }
  return {
    source: 'Open-Meteo / modelos deterministas', url,
    times: h.time, offset: d.utc_offset_seconds, models,
    grid: { lat: d.latitude, lon: d.longitude, elevation: d.elevation },
    fetchedAt: Date.now(),
  };
}

export async function fetchEnsemble({ lat, lon }) {
  const url = `${API.ensemble}?${qs({
    latitude: round(lat, 3), longitude: round(lon, 3),
    hourly: ENS_VARS.join(','), models: ENS_MODELS.map((m) => m.req).join(','),
    forecast_days: 15, timeformat: 'unixtime', timezone: TZ,
  })}`;
  const d = await getJSON(url, { timeout: 45000 });
  const h = d.hourly;
  const members = {}; // var -> [{model, values}]
  for (const v of ENS_VARS) members[v] = [];
  for (const key of Object.keys(h)) {
    if (key === 'time') continue;
    const em = ENS_MODELS.find((m) => key.endsWith('_' + m.suffix));
    if (!em) continue;
    const v = ENS_VARS.find((x) => key.startsWith(x + '_'));
    if (!v) continue;
    const vals = h[key];
    if (!vals.some((x) => x != null)) continue;
    members[v].push({ model: em.name, values: vals });
  }
  return {
    source: 'Open-Meteo / ensambles', url,
    times: h.time, offset: d.utc_offset_seconds, members, fetchedAt: Date.now(),
  };
}

export async function fetchFlood(cells = RIVER_CELLS) {
  const url = `${API.flood}?${qs({
    latitude: cells.map((c) => c.lat).join(','), longitude: cells.map((c) => c.lon).join(','),
    daily: 'river_discharge,river_discharge_median,river_discharge_p25,river_discharge_p75,river_discharge_max,river_discharge_min',
    past_days: 7, forecast_days: 30,
  })}`;
  let d = await getJSON(url, { timeout: 45000 });
  if (!Array.isArray(d)) d = [d];
  return cells.map((c, i) => ({
    ...c,
    days: d[i].daily.time,
    q: d[i].daily.river_discharge,
    median: d[i].daily.river_discharge_median,
    p25: d[i].daily.river_discharge_p25,
    p75: d[i].daily.river_discharge_p75,
    max: d[i].daily.river_discharge_max,
    min: d[i].daily.river_discharge_min,
    fetchedAt: Date.now(),
  }));
}

// Climatología de caudal del propio GloFAS (reanálisis 1991-2020) por día del año.
// Comparar el modelo con su propia historia evita el sesgo absoluto del modelo.
export async function fetchFloodClim(cell) {
  const url = `${API.flood}?${qs({
    latitude: cell.lat, longitude: cell.lon, daily: 'river_discharge',
    start_date: '1991-01-01', end_date: '2020-12-31',
  })}`;
  const d = await getJSON(url, { timeout: 60000 });
  return compactDailyClim(d.daily.time, d.daily.river_discharge, [0.5, 0.9, 0.99], 7);
}

// Precipitación diaria ERA5 1991-2020 en el punto.
export async function fetchPrecipClim({ lat, lon }) {
  const url = `${API.archive}?${qs({
    latitude: round(lat, 2), longitude: round(lon, 2), daily: 'precipitation_sum',
    start_date: '1991-01-01', end_date: '2020-12-31', timezone: TZ,
  })}`;
  const d = await getJSON(url, { timeout: 60000 });
  const t = d.daily.time, p = d.daily.precipitation_sum;
  const years = 30;
  const perYear = {};
  for (const T of [5, 10, 20, 30, 40, 60]) perYear[T] = round(p.filter((x) => x != null && x >= T).length / years, 2);
  const annual = round(p.reduce((a, x) => a + (x || 0), 0) / years, 0);
  const meanDoy = new Array(366).fill(0), cntDoy = new Array(366).fill(0);
  t.forEach((ti, i) => {
    if (p[i] == null) return;
    const k = doy(ti);
    meanDoy[k] += p[i]; cntDoy[k] += 1;
  });
  const raw = meanDoy.map((s, i) => (cntDoy[i] ? s / cntDoy[i] : 0));
  const smooth = raw.map((_, i) => {
    let s = 0;
    for (let j = -7; j <= 7; j++) s += raw[(i + j + 366) % 366];
    return round(s / 15, 3);
  });
  const monthly = new Array(12).fill(0);
  t.forEach((ti, i) => { if (p[i] != null) monthly[+ti.slice(5, 7) - 1] += p[i]; });
  return {
    source: 'ERA5 (Copernicus) vía Open-Meteo, 1991-2020', cell: { lat: d.latitude, lon: d.longitude, elevation: d.elevation },
    perYear, annual, monthly: monthly.map((x) => round(x / years, 1)), meanDailyByDoy: smooth,
  };
}

// Lluvia de 72 h en muchos puntos a la vez (para "dónde llueve más").
export async function fetchMultiPointRain(points) {
  const models = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'gem_seamless'];
  const url = `${API.forecast}?${qs({
    latitude: points.map((p) => round(p.lat, 3)).join(','), longitude: points.map((p) => round(p.lon, 3)).join(','),
    hourly: 'precipitation', models: models.join(','), forecast_days: 4, timeformat: 'unixtime', timezone: TZ,
  })}`;
  let d = await getJSON(url, { timeout: 45000 });
  if (!Array.isArray(d)) d = [d];
  const now = Date.now() / 1000;
  return points.map((p, i) => {
    const h = d[i].hourly;
    const i0 = h.time.findIndex((t) => t >= now - 3600);
    const totals = [];
    for (const m of models) {
      const arr = h[`precipitation_${m}`];
      if (!arr) continue;
      const w = arr.slice(i0, i0 + 72);
      if (w.filter((x) => x != null).length < 60) continue;
      totals.push(w.reduce((a, x) => a + (x || 0), 0));
    }
    return {
      id: p.id, name: p.name, n: totals.length,
      median: totals.length ? round(quantile(totals, 0.5), 1) : null,
      min: totals.length ? round(Math.min(...totals), 1) : null,
      max: totals.length ? round(Math.max(...totals), 1) : null,
      grid: { lat: d[i].latitude, lon: d[i].longitude },
    };
  });
}

// Cordillera: lluvia, nieve e isoterma de 0 °C en 72 h (GFS e ICON informan isoterma).
export async function fetchMountain(points) {
  const models = ['gfs_seamless', 'icon_seamless', 'ecmwf_ifs025'];
  const url = `${API.forecast}?${qs({
    latitude: points.map((p) => round(p.lat, 3)).join(','), longitude: points.map((p) => round(p.lon, 3)).join(','),
    hourly: 'precipitation,snowfall,freezing_level_height', models: models.join(','),
    forecast_days: 4, timeformat: 'unixtime', timezone: TZ,
  })}`;
  let d = await getJSON(url, { timeout: 45000 });
  if (!Array.isArray(d)) d = [d];
  const now = Date.now() / 1000;
  return points.map((p, i) => {
    const h = d[i].hourly;
    const i0 = h.time.findIndex((t) => t >= now - 3600);
    const prec = [], snow = [], fzl = [];
    for (const m of models) {
      const pr = h[`precipitation_${m}`]?.slice(i0, i0 + 72).filter((x) => x != null);
      if (pr && pr.length >= 60) prec.push(pr.reduce((a, x) => a + x, 0));
      const sn = h[`snowfall_${m}`]?.slice(i0, i0 + 72).filter((x) => x != null);
      if (sn && sn.length >= 60) snow.push(sn.reduce((a, x) => a + x, 0));
      const fz = h[`freezing_level_height_${m}`]?.slice(i0, i0 + 72).filter((x) => x != null);
      if (fz && fz.length >= 60) fzl.push(Math.max(...fz));
    }
    const elev = d[i].elevation;
    const pMed = quantile(prec, 0.5), fMax = quantile(fzl, 0.5);
    const rainOnSnow = pMed != null && fMax != null && pMed >= 10 && fMax > elev + 300;
    return {
      id: p.id, name: p.name, elevation: elev,
      precip: pMed == null ? null : round(pMed, 1), snow: snow.length ? round(quantile(snow, 0.5), 1) : null,
      freezingMax: fMax == null ? null : Math.round(fMax), rainOnSnow, n: prec.length,
    };
  });
}

// Bandas horarias de lluvia (mediana, mínimo y máximo entre modelos) para el gráfico de 72 h.
export function hourlyPrecipBands(det, now = Date.now() / 1000, hours = 72) {
  if (!det) return [];
  const [i0, i1] = windowIdx(det.times, now, hours);
  const series = DET_MODELS.map((m) => det.models[m.id]?.precipitation).filter(Boolean);
  const out = [];
  for (let i = i0; i < i1; i++) {
    const v = series.map((s) => s[i]).filter((x) => x != null);
    out.push({ t: det.times[i], med: v.length ? quantile(v, 0.5) : null, lo: v.length ? Math.min(...v) : null, hi: v.length ? Math.max(...v) : null });
  }
  return out;
}

// ---------------------------------------------------------------- utilidades

export function quantile(arr, q) {
  const a = arr.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

function doy(isoDate) {
  const d = new Date(isoDate.slice(0, 10) + 'T00:00:00Z');
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.min(365, Math.floor((d - start) / 86400000));
}

export function compactDailyClim(times, values, qs_, halfWindow) {
  const byDoy = Array.from({ length: 366 }, () => []);
  times.forEach((t, i) => { if (values[i] != null) byDoy[doy(t)].push(values[i]); });
  const out = qs_.map(() => new Array(366).fill(null));
  for (let k = 0; k < 366; k++) {
    const pool = [];
    for (let j = -halfWindow; j <= halfWindow; j++) pool.push(...byDoy[(k + j + 366) % 366]);
    qs_.forEach((q, qi) => { out[qi][k] = pool.length ? round(quantile(pool, q), 2) : null; });
  }
  return { quantiles: qs_, byDoy: out, source: 'GloFAS reanálisis 1991-2020 vía Open-Meteo' };
}

export function localParts(t, offset) {
  const d = new Date((t + offset) * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), day: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), key: d.toISOString().slice(0, 10) };
}

const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
export function dayLabel(key, todayKey) {
  if (key === todayKey) return 'hoy';
  const a = new Date(key + 'T00:00:00Z'), b = new Date(todayKey + 'T00:00:00Z');
  const diff = Math.round((a - b) / 86400000);
  if (diff === 1) return 'mañana';
  return `${WD[a.getUTCDay()]} ${a.getUTCDate()}`;
}

export function describeWindow(t0, t1, offset, now = Date.now() / 1000) {
  const a = localParts(t0, offset), b = localParts(t1, offset), n = localParts(now, offset);
  const pad = (x) => String(x).padStart(2, '0');
  if (a.key === b.key) return `${dayLabel(a.key, n.key)} ${pad(a.h)}–${pad((b.h + 1) % 24)} h`;
  return `${dayLabel(a.key, n.key)} ${pad(a.h)} h a ${dayLabel(b.key, n.key)} ${pad((b.h + 1) % 24)} h`;
}

function uv(speed, dir) {
  const r = (dir * Math.PI) / 180;
  return [-speed * Math.sin(r), -speed * Math.cos(r)];
}

function windowIdx(times, now, hours) {
  let i0 = times.findIndex((t) => t >= now - 3600);
  if (i0 < 0) i0 = 0;
  return [i0, Math.min(times.length, i0 + hours)];
}

function rollingMax(arr, i0, i1, span) {
  let best = null, at = -1;
  for (let i = i0; i + span <= i1; i++) {
    let s = 0, n = 0;
    for (let j = i; j < i + span; j++) if (arr[j] != null) { s += arr[j]; n++; }
    if (n < span * 0.8) continue;
    if (best == null || s > best) { best = s; at = i; }
  }
  return { value: best, at };
}

function medianSeries(seriesList, i0, i1) {
  const out = [];
  for (let i = i0; i < i1; i++) out.push(quantile(seriesList.map((s) => s[i]), 0.5));
  return out;
}

function confidence({ nModels, agreeFrac, leadHours, ensProb }) {
  let score = 0;
  const reasons = [];
  if (nModels >= 4) { score++; reasons.push(`${nModels} modelos con datos`); } else reasons.push(`solo ${nModels} modelos con datos`);
  if (agreeFrac != null) {
    if (agreeFrac >= 0.7 || agreeFrac <= 0.15) { score++; reasons.push('los modelos coinciden'); } else reasons.push('los modelos no coinciden');
  }
  if (leadHours != null) {
    if (leadHours <= 48) { score++; reasons.push('plazo menor a 48 h'); } else reasons.push('plazo mayor a 48 h');
  }
  if (ensProb != null) {
    if (ensProb >= 0.6 || ensProb <= 0.1) { score++; reasons.push('el ensamble es consistente'); } else reasons.push('el ensamble está dividido');
  }
  const level = score >= 3 ? 'alta' : score === 2 ? 'media' : 'baja';
  return { level, reasons };
}

const fmt = (x, d = 0) => (x == null ? '—' : Number(x).toLocaleString('es-AR', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)} %`);

function ensRolling(ens, v, now, hours, span, agg = 'sum') {
  if (!ens || !ens.members[v] || !ens.members[v].length) return null;
  const [i0, i1] = windowIdx(ens.times, now, hours);
  return ens.members[v].map((m) => {
    if (agg === 'max') {
      const w = m.values.slice(i0, i1).filter((x) => x != null);
      return w.length >= (i1 - i0) * 0.7 ? Math.max(...w) : null;
    }
    return rollingMax(m.values, i0, i1, span).value;
  }).filter((x) => x != null);
}

const frac = (arr, pred) => (arr && arr.length ? arr.filter(pred).length / arr.length : null);

// ---------------------------------------------------------------- amenazas 0-72 h

export function assessRain(det, ens, clim, th = DEFAULT_THRESHOLDS, now = Date.now() / 1000) {
  const base = { id: 'lluvia', title: 'Lluvia fuerte y anegamientos' };
  if (!det) return { ...base, level: LEVEL.NODATA, headline: 'Sin datos de modelos', evidence: [] };
  const [i0, i1] = windowIdx(det.times, now, 72);
  const per = [];
  for (const m of DET_MODELS) {
    const s = det.models[m.id]?.precipitation;
    if (!s) continue;
    const r24 = rollingMax(s, i0, i1, 24);
    if (r24.value == null) continue;
    const w = s.slice(i0, i1).filter((x) => x != null);
    per.push({ model: m.name, max24: r24.value, at: r24.at, max1h: Math.max(...w), total72: w.reduce((a, x) => a + x, 0) });
  }
  if (!per.length) return { ...base, level: LEVEL.NODATA, headline: 'Ningún modelo devolvió lluvia', evidence: [] };
  const [T1, T2] = th.rain24;
  const f1 = frac(per, (p) => p.max24 >= T1), f2 = frac(per, (p) => p.max24 >= T2);
  const nHourly = per.filter((p) => p.max1h >= th.rain1h).length;
  const e24 = ensRolling(ens, 'precipitation', now, 72, 24);
  const eP1 = frac(e24, (x) => x >= T1), eP2 = frac(e24, (x) => x >= T2);

  let level = LEVEL.OK;
  if (f2 >= th.agree || (eP2 ?? 0) >= th.prob) level = LEVEL.ALERT;
  else if (f1 >= th.agree || (eP1 ?? 0) >= th.prob || nHourly >= 2) level = LEVEL.WATCH;

  const med = medianSeries(per.map((p) => det.models[DET_MODELS.find((m) => m.name === p.model).id].precipitation), i0, i1);
  const med24 = rollingMax(med, 0, med.length, 24);
  const max24s = per.map((p) => p.max24);
  const lo = Math.min(...max24s), hi = Math.max(...max24s);
  let when = null;
  if (med24.value != null && med24.value >= 1) {
    // horas con lluvia apreciable (≥ 0,3 mm/h en la mediana) dentro de la peor ventana de 24 h
    const ks = [];
    for (let k = med24.at; k < med24.at + 24; k++) if ((med[k] ?? 0) >= 0.3) ks.push(k);
    const a = ks.length ? ks[0] : med24.at, b = ks.length ? ks[ks.length - 1] : med24.at + 23;
    when = describeWindow(det.times[i0 + a], det.times[i0 + b], det.offset, now);
  }

  // lluvia previa (suelo): 72 h anteriores, mediana entre modelos
  const pastStart = Math.max(0, i0 - 72);
  const past = per.map((p) => {
    const s = det.models[DET_MODELS.find((m) => m.name === p.model).id].precipitation.slice(pastStart, i0).filter((x) => x != null);
    return s.reduce((a, x) => a + x, 0);
  });
  const prev72 = quantile(past, 0.5);

  const headline = level === LEVEL.OK
    ? (quantile(max24s, 0.5) < 1 ? 'Sin lluvia significativa en 72 h' : `Lluvia débil: hasta ${fmt(quantile(max24s, 0.5))} mm en 24 h`)
    : `Hasta ${fmt(quantile(max24s, 0.5))} mm en 24 h (modelos: ${fmt(lo)}–${fmt(hi)} mm)`;

  const evidence = [
    { label: `Modelos con ≥ ${T1} mm en 24 h`, value: `${per.filter((p) => p.max24 >= T1).length} de ${per.length}` },
    { label: `Modelos con ≥ ${T2} mm en 24 h`, value: `${per.filter((p) => p.max24 >= T2).length} de ${per.length}` },
    ...(e24 ? [
      { label: `Escenarios con ≥ ${T1} mm en 24 h`, value: `${pct(eP1)} (${e24.filter((x) => x >= T1).length} de ${e24.length})` },
      { label: `Escenarios con ≥ ${T2} mm en 24 h`, value: `${pct(eP2)} (${e24.filter((x) => x >= T2).length} de ${e24.length})` },
    ] : [{ label: 'Ensamble', value: 'no disponible' }]),
    { label: `Modelos con ≥ ${th.rain1h} mm en una hora`, value: `${nHourly} de ${per.length}` },
    { label: 'Lluvia estimada en las 72 h previas', value: `${fmt(prev72, 1)} mm` },
  ];
  if (clim) {
    evidence.push({ label: `Días por año con ≥ ${T1} mm aquí (ERA5)`, value: fmt(clim.perYear[T1] ?? clim.perYear[20], 1) });
    evidence.push({ label: `Días por año con ≥ ${T2} mm aquí (ERA5)`, value: fmt(clim.perYear[T2] ?? clim.perYear[40], 1) });
  }
  const notes = [];
  if (prev72 != null && prev72 >= 15 && level >= LEVEL.WATCH) notes.push('El suelo ya recibió lluvia: el agua escurre más rápido hacia calles y acequias.');
  notes.push('Los modelos globales promedian celdas de 9 a 25 km: no ven una tormenta sobre una cuadra y subestiman los picos de pocos minutos.');

  return {
    ...base, level, when, headline, evidence, notes,
    models: per.map((p) => ({ model: p.model, value: round(p.max24, 1), unit: 'mm/24 h' })),
    confidence: confidence({ nModels: per.length, agreeFrac: level >= LEVEL.ALERT ? f2 : f1, leadHours: med24.at >= 0 ? med24.at : null, ensProb: level >= LEVEL.ALERT ? eP2 : eP1 }),
    metrics: { median24: round(quantile(max24s, 0.5), 1), lo: round(lo, 1), hi: round(hi, 1), eP1, eP2, prev72: round(prev72 ?? 0, 1) },
  };
}

export function assessStorm(det, ens, th = DEFAULT_THRESHOLDS, now = Date.now() / 1000) {
  const base = { id: 'tormenta', title: 'Tormentas y granizo' };
  if (!det) return { ...base, level: LEVEL.NODATA, headline: 'Sin datos de modelos', evidence: [] };
  const [i0, i1] = windowIdx(det.times, now, 72);
  const n = i1 - i0;
  const sig1 = new Array(n).fill(0), sig2 = new Array(n).fill(0);
  let nModels = 0, strongPair = 0;
  const perModel = [];
  for (const m of DET_MODELS) {
    const s = det.models[m.id];
    if (!s?.cape || !s?.precipitation) continue;
    nModels++;
    let capeMax = 0, shearAtCape = null, any2 = false, fzl = null;
    for (let k = 0; k < n; k++) {
      const i = i0 + k;
      const cape = s.cape[i];
      if (cape == null) continue;
      const pr = Math.max(s.precipitation[i - 1] ?? 0, s.precipitation[i] ?? 0, s.precipitation[i + 1] ?? 0);
      let shear = null;
      if (s.wind_speed_500hPa && s.wind_speed_10m && s.wind_speed_500hPa[i] != null && s.wind_speed_10m[i] != null) {
        const [u5, v5] = uv(s.wind_speed_500hPa[i], s.wind_direction_500hPa[i]);
        const [u1, v1] = uv(s.wind_speed_10m[i], s.wind_direction_10m[i]);
        shear = Math.hypot(u5 - u1, v5 - v1);
      }
      const storm = cape >= th.cape[0] && pr >= 0.5;
      const severe = storm && shear != null && shear >= th.shear[0];
      if (storm) sig1[k]++;
      if (severe) { sig2[k]++; any2 = true; }
      if (cape > capeMax) { capeMax = cape; shearAtCape = shear; fzl = s.freezing_level_height?.[i] ?? null; }
      if (cape >= th.cape[1] && shear != null && shear >= th.shear[1] && pr >= 0.5) strongPair++;
    }
    perModel.push({ model: m.name, capeMax, shearAtCape, any2, fzl });
  }
  if (!nModels) return { ...base, level: LEVEL.NODATA, headline: 'Los modelos no informan inestabilidad', evidence: [] };
  const f1 = sig1.map((c) => c / nModels), f2 = sig2.map((c) => c / nModels);
  const max1 = Math.max(...f1), max2 = Math.max(...f2);
  const nSevere = perModel.filter((p) => p.any2).length;
  const eCape = ensRolling(ens, 'cape', now, 72, 1, 'max');
  const eP = frac(eCape, (x) => x >= th.cape[0]);

  let level = LEVEL.OK;
  if (max2 >= th.agree && strongPair > 0) level = LEVEL.ALERT;
  else if (max1 >= th.agree || nSevere >= 2 || (eP ?? 0) >= 0.5) level = LEVEL.WATCH;

  let when = null;
  const key = level === LEVEL.ALERT ? f2 : f1;
  const idx = key.map((f, k) => (f >= th.agree ? k : -1)).filter((k) => k >= 0);
  if (idx.length) when = describeWindow(det.times[i0 + idx[0]], det.times[i0 + idx[idx.length - 1]], det.offset, now);
  else if (level === LEVEL.WATCH) {
    const k = key.indexOf(Math.max(...key));
    if (k >= 0 && key[k] > 0) when = describeWindow(det.times[i0 + k], det.times[i0 + k], det.offset, now);
  }
  const capeMed = quantile(perModel.map((p) => p.capeMax), 0.5);
  const headline = level === LEVEL.OK
    ? (capeMed < 300 ? 'Atmósfera estable en 72 h' : 'Inestabilidad débil, sin señal de tormentas organizadas')
    : level === LEVEL.WATCH ? 'Ingredientes para tormentas fuertes' : 'Ingredientes para tormentas severas con granizo';
  const fzls = perModel.map((p) => p.fzl).filter((x) => x != null);
  const evidence = [
    { label: 'Energía para tormentas (CAPE) máxima, mediana', value: `${fmt(capeMed)} J/kg` },
    { label: `Modelos con tormenta y cizalladura ≥ ${th.shear[0]} km/h`, value: `${nSevere} de ${nModels}` },
    { label: 'Hora con más modelos de acuerdo', value: `${Math.round(max1 * nModels)} de ${nModels}` },
    ...(eCape ? [{ label: `Escenarios con CAPE ≥ ${th.cape[0]} J/kg`, value: `${pct(eP)} (${eCape.filter((x) => x >= th.cape[0]).length} de ${eCape.length})` }] : []),
    ...(fzls.length ? [{ label: 'Altura de la isoterma de 0 °C', value: `${fmt(quantile(fzls, 0.5))} m` }] : []),
  ];
  return {
    ...base, level, when, headline, evidence,
    notes: ['Esto mide ingredientes, no la probabilidad de granizo en un lugar. El granizo se confirma con radar: Contingencias Climáticas de Mendoza y SMN.'],
    models: perModel.map((p) => ({ model: p.model, value: Math.round(p.capeMax), unit: 'J/kg', extra: p.shearAtCape != null ? `cizalladura ${Math.round(p.shearAtCape)} km/h` : '' })),
    confidence: confidence({ nModels, agreeFrac: level >= LEVEL.ALERT ? max2 : max1, leadHours: idx.length ? idx[0] : null, ensProb: eP }),
    metrics: { capeMed: Math.round(capeMed ?? 0), nSevere, nModels, eP },
  };
}

export function assessWind(det, ens, th = DEFAULT_THRESHOLDS, now = Date.now() / 1000) {
  const base = { id: 'viento', title: 'Viento y Zonda' };
  if (!det) return { ...base, level: LEVEL.NODATA, headline: 'Sin datos de modelos', evidence: [] };
  const [i0, i1] = windowIdx(det.times, now, 72);
  const per = [];
  const zondaHours = new Array(i1 - i0).fill(0);
  let nZ = 0;
  for (const m of DET_MODELS) {
    const s = det.models[m.id];
    if (!s?.wind_gusts_10m) continue;
    const w = s.wind_gusts_10m.slice(i0, i1);
    const vals = w.filter((x) => x != null);
    if (vals.length < (i1 - i0) * 0.7) continue;
    const mx = Math.max(...vals);
    per.push({ model: m.name, max: mx, at: i0 + w.indexOf(mx) });
    if (s.relative_humidity_2m && s.wind_direction_10m) {
      nZ++;
      for (let k = 0; k < i1 - i0; k++) {
        const i = i0 + k, d = s.wind_direction_10m[i], rh = s.relative_humidity_2m[i], g = s.wind_gusts_10m[i];
        if (d != null && rh != null && g != null && (d >= 250 || d <= 20) && rh <= 25 && g >= 40) zondaHours[k]++;
      }
    }
  }
  if (!per.length) return { ...base, level: LEVEL.NODATA, headline: 'Ningún modelo devolvió ráfagas', evidence: [] };
  const [G1, G2] = th.gust;
  const f1 = frac(per, (p) => p.max >= G1), f2 = frac(per, (p) => p.max >= G2);
  const eg = ensRolling(ens, 'wind_gusts_10m', now, 72, 1, 'max');
  const eP1 = frac(eg, (x) => x >= G1), eP2 = frac(eg, (x) => x >= G2);
  let level = LEVEL.OK;
  if (f2 >= th.agree || (eP2 ?? 0) >= th.prob) level = LEVEL.ALERT;
  else if (f1 >= th.agree || (eP1 ?? 0) >= th.prob) level = LEVEL.WATCH;
  const zIdx = zondaHours.map((c, k) => (nZ && c / nZ >= th.agree ? k : -1)).filter((k) => k >= 0);
  const zonda = zIdx.length ? describeWindow(det.times[i0 + zIdx[0]], det.times[i0 + zIdx[zIdx.length - 1]], det.offset, now) : null;
  const maxes = per.map((p) => p.max);
  const medMax = quantile(maxes, 0.5);
  const peak = per.slice().sort((a, b) => b.max - a.max)[Math.floor(per.length / 2)];
  const when = level >= LEVEL.WATCH ? describeWindow(det.times[peak.at], det.times[peak.at], det.offset, now) : null;
  const headline = level === LEVEL.OK
    ? `Ráfagas de hasta ${fmt(medMax)} km/h`
    : `Ráfagas de ${fmt(medMax)} km/h (modelos: ${fmt(Math.min(...maxes))}–${fmt(Math.max(...maxes))})`;
  const evidence = [
    { label: `Modelos con ráfagas ≥ ${G1} km/h`, value: `${per.filter((p) => p.max >= G1).length} de ${per.length}` },
    { label: `Modelos con ráfagas ≥ ${G2} km/h`, value: `${per.filter((p) => p.max >= G2).length} de ${per.length}` },
    ...(eg ? [{ label: `Escenarios con ráfagas ≥ ${G1} km/h`, value: `${pct(eP1)} (${eg.filter((x) => x >= G1).length} de ${eg.length})` }] : []),
    { label: 'Señal de Zonda (viento del oeste muy seco)', value: zonda ? zonda : 'no' },
  ];
  return {
    ...base, level, when, headline: zonda ? `${headline}. Posible Zonda ${zonda}` : headline, evidence,
    notes: ['La señal de Zonda combina viento del sector oeste, humedad menor a 25 % y ráfagas de 40 km/h o más en al menos la mitad de los modelos.'],
    models: per.map((p) => ({ model: p.model, value: Math.round(p.max), unit: 'km/h' })),
    confidence: confidence({ nModels: per.length, agreeFrac: level >= LEVEL.ALERT ? f2 : f1, leadHours: (peak.at - i0), ensProb: level >= LEVEL.ALERT ? eP2 : eP1 }),
    metrics: { medMax: Math.round(medMax), eP1, eP2, zonda },
  };
}

export function assessTemp(det, th = DEFAULT_THRESHOLDS, now = Date.now() / 1000) {
  const base = { id: 'temperatura', title: 'Helada o calor extremo' };
  if (!det) return { ...base, level: LEVEL.NODATA, headline: 'Sin datos de modelos', evidence: [] };
  const [i0, i1] = windowIdx(det.times, now, 72);
  const series = DET_MODELS.map((m) => det.models[m.id]?.temperature_2m).filter(Boolean);
  if (!series.length) return { ...base, level: LEVEL.NODATA, headline: 'Ningún modelo devolvió temperatura', evidence: [] };
  const med = medianSeries(series, i0, i1);
  const valid = med.filter((x) => x != null);
  const tmin = Math.min(...valid), tmax = Math.max(...valid);
  const kmin = med.indexOf(tmin), kmax = med.indexOf(tmax);
  let level = LEVEL.OK, headline = `Entre ${fmt(tmin)} y ${fmt(tmax)} °C`, when = null;
  if (tmin <= th.frost[1]) { level = LEVEL.ALERT; headline = `Helada fuerte: ${fmt(tmin)} °C`; when = describeWindow(det.times[i0 + kmin], det.times[i0 + kmin], det.offset, now); }
  else if (tmax >= th.heat[1]) { level = LEVEL.ALERT; headline = `Calor extremo: ${fmt(tmax)} °C`; when = describeWindow(det.times[i0 + kmax], det.times[i0 + kmax], det.offset, now); }
  else if (tmin <= th.frost[0]) { level = LEVEL.WATCH; headline = `Helada: ${fmt(tmin)} °C`; when = describeWindow(det.times[i0 + kmin], det.times[i0 + kmin], det.offset, now); }
  else if (tmax >= th.heat[0]) { level = LEVEL.WATCH; headline = `Calor: ${fmt(tmax)} °C`; when = describeWindow(det.times[i0 + kmax], det.times[i0 + kmax], det.offset, now); }
  const mins = series.map((s) => Math.min(...s.slice(i0, i1).filter((x) => x != null)));
  const maxs = series.map((s) => Math.max(...s.slice(i0, i1).filter((x) => x != null)));
  const spread = Math.max(Math.max(...mins) - Math.min(...mins), Math.max(...maxs) - Math.min(...maxs));
  return {
    ...base, level, when, headline,
    evidence: [
      { label: 'Mínima (mediana de modelos)', value: `${fmt(tmin, 1)} °C` },
      { label: 'Máxima (mediana de modelos)', value: `${fmt(tmax, 1)} °C` },
      { label: 'Diferencia entre modelos', value: `${fmt(spread, 1)} °C` },
    ],
    notes: ['La temperatura del modelo es la de su celda; en zonas bajas y fincas la mínima real suele ser más baja.'],
    confidence: { level: spread <= 3 ? 'alta' : spread <= 6 ? 'media' : 'baja', reasons: [`los modelos difieren hasta ${fmt(spread, 1)} °C`] },
    metrics: { tmin: round(tmin, 1), tmax: round(tmax, 1) },
  };
}

// ---------------------------------------------------------------- ríos

export function assessRivers(flood, clims, now = Date.now() / 1000) {
  if (!flood) return [];
  const today = new Date(now * 1000).toISOString().slice(0, 10);
  return flood.map((c) => {
    const clim = clims?.[c.id];
    const i0 = Math.max(0, c.days.indexOf(today));
    const fut = c.days.slice(i0).map((d, k) => ({ d, med: c.median[i0 + k], p75: c.p75[i0 + k], p25: c.p25[i0 + k], max: c.max[i0 + k] }));
    const cur = c.q[i0] ?? c.median[i0];
    let level = LEVEL.OK, peak = null, refs = null;
    if (clim) {
      let worst = 0;
      for (const f of fut) {
        const k = doy(f.d);
        const p50 = clim.byDoy[0][k], p90 = clim.byDoy[1][k], p99 = clim.byDoy[2][k];
        let l = LEVEL.OK;
        if (f.med != null && f.med > p99) l = LEVEL.ALERT;
        else if ((f.med != null && f.med > p90) || (f.p75 != null && f.p75 > p99)) l = LEVEL.WATCH;
        if (l > worst || (l === worst && peak && f.med > peak.med)) { worst = l; peak = { ...f, p50, p90, p99 }; }
      }
      level = worst || LEVEL.OK;
      const k = doy(fut[0]?.d ?? today);
      refs = { p50: clim.byDoy[0][k], p90: clim.byDoy[1][k], p99: clim.byDoy[2][k] };
    } else {
      level = LEVEL.NODATA;
    }
    const maxMed = Math.max(...fut.map((f) => f.med ?? 0));
    const ratio = refs?.p50 ? cur / refs.p50 : null;
    return {
      id: c.id, river: c.river, name: c.name, upstream: c.upstream, level,
      current: cur, maxMed, ratio, refs, peak, series: fut,
      past: c.days.slice(0, i0).map((d, k) => ({ d, q: c.q[k] })),
      headline: refs
        ? `${fmt(cur, 1)} m³/s hoy (${ratio != null ? fmt(ratio * 100) + ' % de lo habitual' : '—'}); máximo previsto ${fmt(maxMed, 1)} m³/s`
        : `${fmt(cur, 1)} m³/s hoy (sin referencia histórica cargada)`,
      note: c.upstream
        ? 'Aporte natural que entra a los embalses. Es la señal temprana de crecida.'
        : 'Aguas abajo de diques: el caudal real depende de la erogación que decidan Irrigación y las hidroeléctricas, que el modelo no conoce.',
    };
  });
}

// ---------------------------------------------------------------- 15 días

export function dailyOutlook(ens, clim, th = DEFAULT_THRESHOLDS, now = Date.now() / 1000) {
  if (!ens) return null;
  const off = ens.offset;
  const keys = [...new Set(ens.times.map((t) => localParts(t, off).key))];
  const todayKey = localParts(now, off).key;
  const rows = [];
  for (const key of keys) {
    if (key < todayKey) continue;
    const idx = ens.times.map((t, i) => (localParts(t, off).key === key && t >= now - 3600 ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const sums = [], gusts = [];
    for (const m of ens.members.precipitation) {
      const v = idx.map((i) => m.values[i]);
      if (v.filter((x) => x != null).length < idx.length * 0.8) continue;
      sums.push(v.reduce((a, x) => a + (x || 0), 0));
    }
    for (const m of ens.members.wind_gusts_10m || []) {
      const v = idx.map((i) => m.values[i]).filter((x) => x != null);
      if (v.length >= idx.length * 0.8) gusts.push(Math.max(...v));
    }
    if (sums.length < 10) continue;
    const k = doy(key);
    rows.push({
      key, label: dayLabel(key, todayKey), partial: key === todayKey, n: sums.length,
      p10: round(quantile(sums, 0.1), 1), median: round(quantile(sums, 0.5), 1), p90: round(quantile(sums, 0.9), 1),
      P10: frac(sums, (x) => x >= 10), P20: frac(sums, (x) => x >= th.rain24[0]), P40: frac(sums, (x) => x >= th.rain24[1]),
      Pg: gusts.length ? frac(gusts, (x) => x >= th.gust[0]) : null,
      normal: clim ? clim.meanDailyByDoy[k] : null,
    });
  }
  const total = (f) => round(rows.reduce((a, r) => a + (r[f] ?? 0), 0), 1);
  return { rows, sumMedian: total('median'), sumNormal: clim ? total('normal') : null };
}

// ---------------------------------------------------------------- todo junto

export function assessAll({ det, ens, clim, thresholds = DEFAULT_THRESHOLDS, now = Date.now() / 1000 }) {
  const hazards = [
    assessRain(det, ens, clim, thresholds, now),
    assessStorm(det, ens, thresholds, now),
    assessWind(det, ens, thresholds, now),
    assessTemp(det, thresholds, now),
  ];
  hazards.sort((a, b) => b.level - a.level);
  const top = hazards[0];
  const summary = top.level >= LEVEL.WATCH
    ? `${LEVEL_TEXT[top.level]}: ${top.title.toLowerCase()}${top.when ? ', ' + top.when : ''}`
    : top.level === LEVEL.NODATA ? 'Sin datos suficientes para evaluar' : 'Sin amenazas relevantes en las próximas 72 h';
  return {
    hazards, summary, maxLevel: top.level,
    outlook: dailyOutlook(ens, clim, thresholds, now),
    modelsUsed: det ? Object.keys(det.models).map((id) => DET_MODELS.find((m) => m.id === id).name) : [],
    ensembleMembers: ens ? ens.members.precipitation.length : 0,
    grid: det?.grid, generatedAt: Date.now(),
  };
}
