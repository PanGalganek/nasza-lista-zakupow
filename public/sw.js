const CACHE_NAME = "e-lab-v6";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./import-export.css",
  "./app.js",
  "./utils.js",
  "./import-export.js",
  "./modules/auth.js",
  "./modules/calendar.js",
  "./modules/chemical-transfer.js",
  "./modules/chemicals.js",
  "./modules/constants.js",
  "./modules/equipment.js",
  "./modules/schedule.js",
  "./modules/ui.js",
  "./vendor/jszip.min.js",
  "./manifest.json",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html"))),
  );
});
