// Service worker: la app abre sin conexión y muestra los últimos datos guardados.
// Los pronósticos no se guardan acá (los maneja la app con su fecha); solo la interfaz.
const VERSION = 'srs-v2';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/engine.js', 'js/points.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // APIs de datos: siempre a la red (la app decide qué hacer si fallan)
  if (/open-meteo\.com|gibs\.earthdata|tile\.openstreetmap|raw\.githubusercontent/.test(url.hostname)) return;
  // datos del vigía: red primero, copia guardada si no hay conexión
  if (url.origin === location.origin && url.pathname.includes('/data/')) {
    e.respondWith(fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(VERSION).then((c) => c.put(e.request.url.split('?')[0], copy));
      return r;
    }).catch(() => caches.match(e.request.url.split('?')[0])));
    return;
  }
  // interfaz y fuentes tipográficas: caché primero, actualiza en segundo plano
  e.respondWith(caches.match(e.request).then((hit) => {
    const net = fetch(e.request).then((r) => {
      if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => hit);
    return hit || net;
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});
