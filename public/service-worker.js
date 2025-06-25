const CACHE_NAME = 'yousef-sh-cache-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  // Placeholder for main CSS bundle - actual name depends on build output
  // e.g., '/build/_assets/index-XXXXXX.css',
  // Placeholder for main JS bundle - actual name depends on build output
  // e.g., '/build/entry.client-XXXXXX.js',
  // Add other critical JS chunks if identifiable
  '/icons/icon-192.png',
  '/icons/icon-512.png'
  // Potentially add URLs for assets imported in app/root.tsx if they are static paths
  // For example, if reactToastifyStyles resolves to a predictable static path.
  // However, these are often bundled by Vite/Remix.
];

// Install event: cache core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Service Worker: Caching core assets');
        // Add assets that are critical and have static URLs
        // For dynamically named build assets, a more advanced strategy is needed (e.g., build tool integration)
        return cache.addAll(ASSETS_TO_CACHE.filter(url => !url.includes('XXXXXX'))); // Filter out placeholders
      })
      .catch(error => {
        console.error('Service Worker: Failed to cache assets during install:', error);
      })
  );
});

// Activate event: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Service Worker: Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  return self.clients.claim(); // Ensure new service worker takes control immediately
});

// Fetch event: serve from cache first, then network, then cache network response
self.addEventListener('fetch', (event) => {
  // We only want to cache GET requests.
  if (event.request.method !== 'GET') {
    return;
  }

  // For navigation requests, try network first to get the latest HTML,
  // then fallback to cache. For other assets, cache first is usually fine.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // If response is good, cache it (optional for navigation, but can be useful)
          if (response.ok) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return response;
        })
        .catch(() => {
          // Network failed, try to serve from cache
          return caches.match(event.request)
            .then((cachedResponse) => {
              return cachedResponse || caches.match('/'); // Fallback to root if specific page not cached
            });
        })
    );
  } else {
    // For non-navigation requests (CSS, JS, images), try cache first
    event.respondWith(
      caches.match(event.request)
        .then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // Not in cache, fetch from network
          return fetch(event.request).then((networkResponse) => {
            // If response is good, clone it and put it in the cache
            if (networkResponse && networkResponse.ok) {
              const responseToCache = networkResponse.clone();
              caches.open(CACHE_NAME)
                .then((cache) => {
                  cache.put(event.request, responseToCache);
                });
            }
            return networkResponse;
          }).catch(error => {
            console.error('Service Worker: Fetching asset from network failed:', error, event.request.url);
            // Optionally, provide a generic fallback for images or other assets here
          });
        })
    );
  }
});

// Optional: Listen for messages from clients (e.g., to skip waiting)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
