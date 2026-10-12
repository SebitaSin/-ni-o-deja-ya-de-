// Puntos precargados. Cada coordenada tiene su fuente; nada inventado.
// OSM = OpenStreetMap (consultado 11-oct-2026). GeoNames vía Open-Meteo Geocoding.

export const PRESET_POINTS = [
  // Los tres puntos pedidos
  { id: 'bariloche-gaboto', name: 'Bariloche y Sebastián Gaboto', group: 'Mis puntos', lat: -34.61659, lon: -68.31626,
    source: 'OSM, nodo 1100625108 (cruce de ambas calles)', verified: true },
  { id: 'rp160-rojo', name: 'Ruta 160 y calle Rojo (camino a Goudge)', group: 'Mis puntos', lat: -34.67484, lon: -68.23118,
    source: 'OSM, nodo compartido entre calle Rojo (vía 227061741) y RP160 (vía 244459750)', verified: true,
    note: 'Que la RP160 sea la "ruta a Goudge" es una inferencia: corre de oeste a este hacia Goudge. Confirmalo.' },
  { id: 'day-1532', name: 'Calle Day 1532', group: 'Mis puntos', lat: -34.61201, lon: -68.33502,
    source: 'OSM: calle Day verificada (vías 90356648 y 1430151315). La altura 1532 no figura en OSM.', verified: false,
    note: 'Punto provisorio sobre calle Day (±1 km). Para los modelos del tiempo da igual; para anegamiento no. Fijalo con "Estoy acá" o tocando el mapa.' },

  // Infraestructura crítica
  { id: 'hospital', name: 'Hospital Schestakow', group: 'Infraestructura', lat: -34.62010, lon: -68.32530,
    source: 'OSM, vía 245970130 (amenity=hospital)', verified: true },

  // Ciudad y distritos
  { id: 'sr-centro', name: 'San Rafael centro', group: 'Distritos', lat: -34.61531, lon: -68.33238, source: 'GeoNames', verified: true },
  { id: 'cuadro-nacional', name: 'Cuadro Nacional', group: 'Distritos', lat: -34.61714, lon: -68.27537, source: 'GeoNames', verified: true },
  { id: 'cuadro-benegas', name: 'Cuadro Benegas', group: 'Distritos', lat: -34.63856, lon: -68.46663, source: 'GeoNames', verified: true },
  { id: 'rama-caida', name: 'Rama Caída', group: 'Distritos', lat: -34.70121, lon: -68.36552, source: 'GeoNames', verified: true },
  { id: 'las-paredes', name: 'Las Paredes', group: 'Distritos', lat: -34.47700, lon: -68.47500, source: 'GeoNames', verified: true },
  { id: 'capitan-montoya', name: 'Capitán Montoya', group: 'Distritos', lat: -34.58231, lon: -68.45760, source: 'GeoNames', verified: true },
  { id: 'colonia-espanola', name: 'Colonia Española', group: 'Distritos', lat: -34.52406, lon: -68.14444, source: 'GeoNames', verified: true },
  { id: 'salto-rosas', name: 'Salto de las Rosas', group: 'Distritos', lat: -34.72409, lon: -68.22778, source: 'GeoNames', verified: true },
  { id: 'canada-seca', name: 'Cañada Seca', group: 'Distritos', lat: -34.74389, lon: -68.15413, source: 'GeoNames', verified: true },
  { id: 'goudge', name: 'Goudge', group: 'Distritos', lat: -34.68003, lon: -68.13174, source: 'GeoNames', verified: true },
  { id: 'las-malvinas', name: 'Las Malvinas', group: 'Distritos', lat: -34.83510, lon: -68.24863, source: 'GeoNames', verified: true },
  { id: 'monte-coman', name: 'Monte Comán', group: 'Distritos', lat: -34.59258, lon: -67.87606, source: 'GeoNames', verified: true },
  { id: 'villa-atuel', name: 'Villa Atuel', group: 'Distritos', lat: -34.83011, lon: -67.92287, source: 'GeoNames', verified: true },
  { id: 'real-del-padre', name: 'Real del Padre', group: 'Distritos', lat: -34.84013, lon: -67.76261, source: 'GeoNames', verified: true },
  { id: 'jaime-prats', name: 'Jaime Prats', group: 'Distritos', lat: -34.91181, lon: -67.81719, source: 'GeoNames', verified: true },
  { id: 'valle-grande', name: 'Valle Grande', group: 'Distritos', lat: -34.82060, lon: -68.50670, source: 'GeoNames', verified: true },
  { id: 'el-nihuil', name: 'El Nihuil', group: 'Distritos', lat: -35.02998, lon: -68.67351, source: 'GeoNames', verified: true },

  // Aguas arriba: embalses y cordillera
  { id: 'presa-agua-toro', name: 'Presa Agua del Toro', group: 'Aguas arriba', lat: -34.5841, lon: -69.0367, source: 'OSM (waterway=dam)', verified: true },
  { id: 'dique-reyunos', name: 'Dique Los Reyunos', group: 'Aguas arriba', lat: -34.6028, lon: -68.6411, source: 'OSM (waterway=dam)', verified: true },
  { id: 'presa-valle-grande', name: 'Presa Valle Grande', group: 'Aguas arriba', lat: -34.8329, lon: -68.5166, source: 'OSM (waterway=dam)', verified: true },
  { id: 'embalse-nihuil', name: 'Embalse El Nihuil', group: 'Aguas arriba', lat: -35.0886, lon: -68.7483, source: 'OSM (relación 8642574)', verified: true },
  { id: 'laguna-diamante', name: 'Laguna del Diamante (naciente)', group: 'Aguas arriba', lat: -34.1657, lon: -69.6968, source: 'OSM (vía 39992435)', verified: true, mountain: true },
  { id: 'laguna-atuel', name: 'Laguna del Atuel (naciente)', group: 'Aguas arriba', lat: -34.5548, lon: -70.0861, source: 'OSM (vía 106151281)', verified: true, mountain: true },
  { id: 'el-sosneado', name: 'El Sosneado (valle del Atuel)', group: 'Aguas arriba', lat: -35.07897, lon: -69.56738, source: 'GeoNames', verified: true, mountain: true },
];

// Datos de contexto verificados (con fecha y fuente). No se actualizan solos.
export const CONTEXT_FACTS = [
  { label: 'Niño 3.4 (setiembre, índice relativo)', value: '+2,1 °C', date: '8 oct 2026',
    source: 'NOAA CPC, ENSO Diagnostic Discussion', url: 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml' },
  { label: 'Probabilidad de El Niño histórico (RONI ≥ +2,5 °C) en oct–dic', value: '83 %', date: '8 oct 2026',
    source: 'NOAA CPC', url: 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml' },
  { label: 'Derrame previsto río Diamante 2026-27 (La Jaula)', value: '1.090 hm³ · 112 % · año húmedo', date: '1 oct 2026',
    source: 'Irrigación, citado por Diario San Rafael', url: 'https://diariosanrafael.com.ar/el-rio-atuel-tendra-un-ano-normal-y-el-diamante-uno-humedo-luego-de-20-temporadas/' },
  { label: 'Derrame previsto río Atuel 2026-27 (La Angostura)', value: '1.080 hm³ · 100 % · año normal', date: '1 oct 2026',
    source: 'Irrigación, citado por Diario San Rafael', url: 'https://diariosanrafael.com.ar/el-rio-atuel-tendra-un-ano-normal-y-el-diamante-uno-humedo-luego-de-20-temporadas/' },
];
