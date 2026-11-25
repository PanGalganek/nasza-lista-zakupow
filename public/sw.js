const CACHE_NAME = "e-lab-v16";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=16",
  "./app.js?v=16",
  "./utils.js?v=16",
  "./modules/auth.js?v=16",
  "./modules/calendar.js?v=16",
  "./modules/chemicals.js?v=16",
  "./modules/constants.js?v=16",
  "./modules/equipment.js?v=16",
  "./modules/schedule.js?v=16",
  "./modules/ui.js?v=16",
  "./modules/inventory-quantity.js?v=16",
  "./modules/inventory-store.js?v=16",
  "./modules/inventory-ui.js?v=16",
  "./modules/inventory-history.js?v=16",
  "./modules/inventory-alerts.js?v=16",
  "./modules/inventory-recipes.js?v=16",
  "./modules/inventory-theory.js?v=16",
  "./modules/inventory-orders.js?v=16",
  "./modules/inventory-docx.js?v=16",
  "./manifest.json",
  "./icon.svg",
];
const SHELL_URLS = new Set(APP_SHELL.map((asset) => new URL(asset, self.registration.scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL.map((asset) => new Request(new URL(asset, self.registration.scope), { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => /^e-lab-v\d+$/.test(key) && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || !request.url.startsWith(self.registration.scope)) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match("./index.html")) || Response.error();
    }));
  } else if (SHELL_URLS.has(request.url)) {
    event.respondWith(caches.open(CACHE_NAME).then(async (cache) => (await cache.match(request)) || fetch(request)));
  }
});
