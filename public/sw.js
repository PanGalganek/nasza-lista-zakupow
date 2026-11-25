const CACHE_NAME = "e-lab-v14";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js?v=14",
  "./utils.js?v=14",
  "./modules/auth.js?v=14",
  "./modules/calendar.js?v=14",
  "./modules/chemicals.js?v=14",
  "./modules/constants.js?v=14",
  "./modules/equipment.js?v=14",
  "./modules/schedule.js?v=14",
  "./modules/ui.js?v=14",
  "./modules/inventory-quantity.js?v=14",
  "./modules/inventory-store.js?v=14",
  "./modules/inventory-ui.js?v=14",
  "./modules/inventory-history.js?v=14",
  "./modules/inventory-alerts.js?v=14",
  "./modules/inventory-recipes.js?v=14",
  "./modules/inventory-theory.js?v=14",
  "./modules/inventory-orders.js?v=14",
  "./modules/inventory-docx.js?v=14",
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
