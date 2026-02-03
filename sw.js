const CACHE_NAME = 'flow-cache-v2';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    'https://unpkg.com/lucide@latest',
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

self.addEventListener('install', (e) => {
    self.skipWaiting(); // Force waiting service worker to become active
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        Promise.all([
            self.clients.claim(), // Take control of all clients immediately
            caches.keys().then((keys) => {
                return Promise.all(
                    keys.map((key) => {
                        if (key !== CACHE_NAME) {
                            return caches.delete(key);
                        }
                    })
                );
            })
        ])
    );
});


self.addEventListener('fetch', (e) => {
    // Network First Strategy
    e.respondWith(
        fetch(e.request)
            .then((response) => {
                // Check if we received a valid response
                if (!response || response.status !== 200 || response.type !== 'basic') {
                    if (e.request.destination === 'image' || e.request.url.startsWith('http')) {
                         // For external assets, just return
                         return response;
                    }
                }
                
                // Clone the response
                const responseToCache = response.clone();

                caches.open(CACHE_NAME)
                    .then((cache) => {
                        cache.put(e.request, responseToCache);
                    });

                return response;
            })
            .catch(() => {
                // Network failed, try cache
                return caches.match(e.request);
            })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    
    const action = event.action;
    const taskId = event.notification.data ? event.notification.data.taskId : null;

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // Find existing window
            const client = clientList.find(c => 
                c.url.includes(self.registration.scope) && 'focus' in c
            );

            if (client) {
                // Focus the existing window
                return client.focus().then(() => {
                    if (action && taskId) {
                        // Send message to client to handle action
                        client.postMessage({
                            type: 'ACTION',
                            action: action,
                            taskId: taskId
                        });
                    }
                });
            } 
            
            // Otherwise open a new window
            if (clients.openWindow) {
                let url = './';
                if (action && taskId) {
                    url = `./?action=${action}&taskId=${taskId}`;
                }
                return clients.openWindow(url);
            }
        })
    );
});
