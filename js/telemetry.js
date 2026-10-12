// Mediciones reales en tiempo casi real.
// Fuente principal: telemetría pública del Departamento General de Irrigación (Mendoza):
// pluviómetros, escalas de ríos, diques, canales y tomas de agua potable, con datos cada 1 a 15 min.
// Mismo código en la app y en el vigía.

export const DGI_URL = 'https://serviciosweb.cloud.irrigacion.gov.ar/services/telemetria/api/public/dato-medicions/fullDto';
export const RADAR = {
  sur: 'https://www2.contingencias.mendoza.gov.ar/radar/sur.gif',
  animacion: 'https://www2.contingencias.mendoza.gov.ar/radar/animacion.gif',
  pagina: 'https://www.mendoza.gov.ar/contingencias/radar/',
};
// Sur de Mendoza: cuencas del Diamante y del Atuel, San Rafael, General Alvear y norte de Malargüe
export const REGION = { s: -35.8, n: -33.85, w: -70.2, e: -67.3 };

const RAIN_SATURATED = 19660.5;   // valor fijo de pluviómetros con contador saturado (65535 cuentas)
const MAX_RIVER_M3S = 1500;       // por encima: error de calibración (los ríos del sur no llegan a eso)
const STALE_H = 3;

export function kindOf(name) {
  const n = name.toLowerCase().replace(/^[\d-]+\s*-\s*/, '');
  if (/pluvi/.test(n)) return 'pluvio';
  if (/suelo/.test(n)) return 'suelo';
  if (/meteorol|metereol/.test(n)) return 'meteo';
  if (/conductividad|reservorio|pozo|prueba|laboratorio/.test(n)) return 'otro';
  if (/aysam/.test(n)) return 'agua';
  if (/^(canal|hij|hijuela|toma|comparto|cmna|marginal|rama|izuel|perrone|correa|babacci|san pedro|concesi)/.test(n)) return 'canal';
  if (/^r[ií]o\b|^arroyo|^dique|^presa|^embalse/.test(n)) return 'rio';
  return 'canal';
}

const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };

// Normaliza la respuesta completa de Irrigación a estaciones de la región con control de calidad.
export function parseDGI(list, now = Date.now()) {
  const out = [];
  for (const x of list) {
    const lat = x.latitud, lon = x.longitud;
    if (!(lat >= REGION.s && lat <= REGION.n && lon >= REGION.w && lon <= REGION.e)) continue;
    const t = Date.parse(x.fecha);
    if (!Number.isFinite(t)) continue;
    const v = {};
    for (const m of x.datoMedicionList || []) {
      const tipo = (m.tipoSensor?.nombre || '').toLowerCase();
      const unidad = (m.unidadMedida?.nombre || '').toLowerCase();
      const val = num(m.valor);
      if (val == null) continue;
      if (tipo === 'lluvia ac.') v.rainAcc = val;
      else if (tipo === 'altura') v.height = unidad === 'mts' ? val * 100 : val;          // cm
      else if (tipo === 'caudal') v.flow = unidad === 'l/s' ? val / 1000 : unidad === 'm3/h' ? val / 3600 : unidad === 'm3/s' ? val : null; // m³/s
      else if (tipo === 'temperatura') v.temp = val;
      else if (tipo === 'humedad') v.hum = val;
      else if (tipo === 'presión') v.press = val;
      else if (tipo.startsWith('humedad - prof. 30')) v.soil30 = val;
      else if (tipo.startsWith('humedad - prof. 60')) v.soil60 = val;
      else if (tipo === 'volumen') v.volume = unidad === 'hm3' ? val : unidad === 'm3' ? val / 1e6 : v.volume;
    }
    const kind = kindOf(x.maestroSensor);
    const flags = [];
    const ageH = (now - t) / 3600e3;
    if (ageH > STALE_H) flags.push(ageH > 48 ? `sin transmitir hace ${Math.round(ageH / 24)} días` : `sin transmitir hace ${Math.round(ageH)} h`);
    if (v.rainAcc === RAIN_SATURATED) { flags.push('contador del pluviómetro saturado'); v.rainAcc = null; }
    if (v.flow != null && (v.flow > MAX_RIVER_M3S || v.flow < 0)) { flags.push('caudal imposible (sensor mal calibrado)'); v.flow = null; }
    if (v.temp != null && (v.temp < -40 || v.temp > 55)) { flags.push('temperatura imposible'); v.temp = null; }
    if (v.hum != null && v.hum <= 0) v.hum = null;
    if (v.press != null && v.press < 500) v.press = null;
    const name = x.maestroSensor.replace(/^[\d-]+\s*-\s*/, '').replace(/\s+/g, ' ').trim();
    out.push({ id: x.codigoMaestro, name, lat, lon, kind, t, ageH, v, flags, ok: ageH <= STALE_H });
  }
  return out;
}

export async function fetchDGI(fetchImpl = fetch) {
  const r = await fetchImpl(DGI_URL, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Irrigación respondió HTTP ${r.status}`);
  return parseDGI(await r.json());
}

// ------------------------------------------------------------------ historia
// hist: [[t, rainAcc, height, flow], ...] ordenado por t
export function mergeHistory(hist = [], st, maxH = 72) {
  const row = [st.t, st.v.rainAcc ?? null, st.v.height ?? null, st.v.flow ?? null];
  const h = hist.filter((p) => p[0] !== st.t);
  h.push(row);
  h.sort((a, b) => a[0] - b[0]);
  const cut = st.t - maxH * 3600e3;
  return h.filter((p) => p[0] >= cut);
}

function valueAgo(hist, tNow, minutes, idx, tolerance = 0.5) {
  // el punto más cercano a (tNow - minutes), dentro de ±tolerance*minutes
  const target = tNow - minutes * 60e3;
  let best = null;
  for (const p of hist) {
    if (p[idx] == null) continue;
    const d = Math.abs(p[0] - target);
    if (d <= tolerance * minutes * 60e3 && (!best || d < Math.abs(best[0] - target))) best = p;
  }
  return best;
}

// Lluvia caída en los últimos N minutos según el contador acumulado.
export function rainLast(hist, st, minutes) {
  if (st.v.rainAcc == null) return null;
  const p = valueAgo(hist, st.t, minutes, 1);
  if (!p) return null;
  let d = st.v.rainAcc - p[1];
  if (d < 0) return null;                        // el contador se reinició
  if (d > minutes * 2.5) return null;            // más de 150 mm/h: dato no confiable
  return { mm: Math.round(d * 10) / 10, since: p[0] };
}

export function changeLast(hist, st, minutes, which) {
  const idx = which === 'height' ? 2 : 3;
  const cur = which === 'height' ? st.v.height : st.v.flow;
  if (cur == null) return null;
  const p = valueAgo(hist, st.t, minutes, idx);
  if (!p) return null;
  return { delta: cur - p[idx], from: p[idx], since: p[0] };
}

export function distanceKm(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Orden de las escalas del Atuel aguas abajo y del Diamante, para mostrarlas como un río.
export const RIVER_ORDER = [
  { match: /salado - puente ruta 40/i, river: 'Salado', label: 'Río Salado, puente Ruta 40', note: 'Afluente del Atuel en Malargüe' },
  { match: /atuel - 1 puente sosneado/i, river: 'Atuel', label: 'Atuel en Puente Sosneado (Ruta 40)', note: 'Aguas arriba de El Nihuil: primera señal de crecida' },
  { match: /atuel - 2 estacion loma negra/i, river: 'Atuel', label: 'Atuel en Loma Negra' },
  { match: /atuel - 3 estacion la angostura/i, river: 'Atuel', label: 'Atuel en La Angostura', note: 'Entrada a El Nihuil' },
  { match: /atuel - 5 estacion aforo nihuil 4/i, river: 'Atuel', label: 'Atuel aforo Nihuil 4', note: 'Salida del sistema de embalses' },
  { match: /atuel - 6 estacion puente escorial/i, river: 'Atuel', label: 'Atuel en Puente Escorial' },
  { match: /atuel - 7 estacion puente malvinas/i, river: 'Atuel', label: 'Atuel en Puente Malvinas' },
  { match: /atuel - 8 paso la arena/i, river: 'Atuel', label: 'Atuel en Paso La Arena' },
  { match: /dique galileo vitali/i, river: 'Diamante', label: 'Diamante en Dique Galileo Vitali', note: 'Derivador aguas abajo de Los Reyunos y El Tigre' },
  { match: /aysam - planta ballofet/i, river: 'Agua potable', label: 'Toma de AySAM, planta Ballofet', note: 'Agua cruda para la ciudad' },
];
