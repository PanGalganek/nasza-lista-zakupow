const CACHE_NAME = "e-lab-v10";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js?v=10",
  "./utils.js?v=10",
  "./modules/auth.js?v=10",
  "./modules/calendar.js?v=10",
  "./modules/chemicals.js?v=10",
  "./modules/constants.js?v=10",
  "./modules/equipment.js?v=10",
  "./modules/schedule.js?v=10",
  "./modules/ui.js?v=10",
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
