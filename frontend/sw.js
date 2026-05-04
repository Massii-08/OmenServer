/**
 * OmenServer — Service Worker
 * 
 * Gère le cache pour fonctionnement hors-ligne (PWA).
 * Stratégie : Network-first avec fallback cache.
 * 
 * Pour désactiver : supprimer ce fichier + la ligne d'enregistrement dans index.html.
 */

const CACHE_NAME = 'omenserver-v4';
const STATIC_ASSETS = [
    '/',
    '/css/style.css',
    '/js/app.js',
    '/js/auth.js',
    '/js/toast.js',
    '/js/monitoring.js',
    '/js/game_server.js',
    '/js/server_view.js',
    '/js/sv_files.js',
    '/js/sv_monitoring.js',
    '/js/files_module.js',
    '/js/bots_module.js',
    '/js/media_module.js',
    '/js/web_module.js',
    '/js/network_module.js',
    '/favicon.svg',
    '/manifest.json',
];

// Installation : mettre en cache les assets statiques
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] Cache des assets statiques');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => self.skipWaiting())
    );
});

// Activation : nettoyer les anciens caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => {
                        console.log('[SW] Suppression ancien cache:', key);
                        return caches.delete(key);
                    })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch : Network-first, fallback sur le cache
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Ne pas cacher les appels API (toujours réseau)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Mettre en cache la réponse fraîche
                if (response.ok && event.request.method === 'GET') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, clone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Hors-ligne : servir depuis le cache
                return caches.match(event.request).then(cached => {
                    if (cached) return cached;
                    // Fallback : page principale si la ressource n'est pas cachée
                    if (event.request.mode === 'navigate') {
                        return caches.match('/');
                    }
                });
            })
    );
});
