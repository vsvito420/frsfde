// Service Worker für die Admin-App: App-Hülle offline verfügbar, Termine immer frisch vom Server.
const CACHE = 'ff-admin-v5';
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

// PUSH: neue Buchung als Benachrichtigung anzeigen
self.addEventListener('push', event => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch { }
    event.waitUntil(self.registration.showNotification(data.title || 'Fresh Fade Termine', {
        body: data.body || 'Neue Buchung',
        icon: '/assets/app/icon-192.png',
        badge: '/assets/app/badge-96.png',
        tag: data.tag,
        renotify: true,
        data: { url: data.url || '/admin' }
    }));
});

// Tippen auf die Benachrichtigung öffnet die App (oder holt sie nach vorne)
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = new URL(event.notification.data?.url || '/admin', self.location.origin).href;
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const app = windows.find(w => new URL(w.url).pathname.startsWith('/admin'));
        if (app) {
            await app.focus();
            return app.navigate(url);
        }
        return self.clients.openWindow(url);
    })());
});
