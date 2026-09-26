/* Service worker : garde l'appli à jour et la fait marcher hors connexion.

   Stratégie « réseau d'abord » : à chaque ouverture, on télécharge la dernière
   version publiée. Si le réseau ne répond pas (pas de connexion, ou plus de
   4 secondes), on utilise la copie enregistrée sur le téléphone.
   Ce fichier ne voit jamais tes données : elles restent chiffrées dans le
   stockage du navigateur. */

const CACHE = 'orbe-v11';
const CORE = [
  './',
  './index.html',
  './css/styles.css',
  './js/vault.js',
  './js/storage.js',
  './js/calendar.js',
  './js/csv-import.js',
  './js/sync.js',
  './js/backup.js',
  './js/analysis.js',
  './js/ai-context.js',
  './js/ai-store.js',
  './js/ai.js',
  './js/wealth-store.js',
  './js/chart-kit.js',
  './js/forecast.js',
  './js/widget-summary.js',
  './js/wealth.js',
  './js/tabbar.js',
  './js/lock.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/orbe-glacier-180.png',
  './icons/orbe-aurore-180.png',
  './icons/orbe-emeraude-180.png',
  './icons/orbe-soleil-180.png',
  './icons/orbe-graphite-180.png'
];
const NETWORK_TIMEOUT = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function fromCache(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  if (request.mode === 'navigate') return caches.match('./index.html');
  return Response.error();
}

async function networkFirst(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT);
  try {
    // « no-cache » : on demande toujours au serveur s'il y a une version plus récente
    const response = await fetch(request.url, { cache: 'no-cache', signal: controller.signal });
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  } catch (e) {
    return fromCache(request);
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
