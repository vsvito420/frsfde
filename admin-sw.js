// Service Worker für die Admin-App: App-Hülle offline verfügbar, Termine immer frisch vom Server.
const CACHE = 'ff-admin-v1';
const SHELL = ['/admin', '/styles.css', '/fonts/fonts.css', '/assets/app/icon-192.png'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    // Termine und Login nie aus dem Cache
    if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
    // Netzwerk zuerst, damit Updates sofort ankommen; ohne Netz die gespeicherte Version
    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response.ok && SHELL.includes(url.pathname)) {
                    const copy = response.clone();
                    caches.open(CACHE).then(cache => cache.put(event.request, copy));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
