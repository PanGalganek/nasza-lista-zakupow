const CACHE_NAME = "e-lab-v38-r2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=38.1",
  "./app.js?v=38.1",
  "./utils.js?v=38.1",
  "./modules/auth.js?v=38.1",
  "./modules/calendar.js?v=38.1",
  "./modules/chemicals.js?v=38.1",
  "./modules/constants.js?v=38.1",
  "./modules/equipment.js?v=38.1",
  "./modules/schedule.js?v=38.1",
  "./modules/water-plan.js?v=38.1",
  "./modules/water-store.js?v=38.1",
  "./modules/water-monitoring.js?v=38.1",
  "./modules/ui.js?v=38.1",
  "./modules/icons.js?v=38.1",
  "./modules/navigation.js?v=38.1",
  "./modules/shell.js?v=38.1",
  "./modules/inventory-quantity.js?v=38.1",
  "./modules/inventory-items.js?v=38.1",
  "./modules/inventory-store.js?v=38.1",
  "./modules/inventory-ui.js?v=38.1",
  "./modules/inventory-history.js?v=38.1",
  "./modules/inventory-statistics.js?v=38.1",
  "./modules/inventory-statistics-data.js?v=38.1",
  "./modules/inventory-alerts.js?v=38.1",
  "./modules/inventory-recipes.js?v=38.1",
  "./modules/inventory-theory.js?v=38.1",
  "./modules/inventory-orders.js?v=38.1",
  "./modules/inventory-docx.js?v=38.1",
  "./modules/equipment-v38.js?v=38.1",
  "./equipment/copy-model.js?v=38.1",
  "./equipment/execution-model.js?v=38.1",
  "./equipment/execution.js?v=38.1",
  "./equipment/firestore-store.js?v=38.1",
  "./equipment/activity-codec.js?v=38.1",
  "./equipment/model.js?v=38.1",
  "./equipment/plan-copy.js?v=38.1",
  "./equipment/plan-model.js?v=38.1",
  "./equipment/planner.js?v=38.1",
  "./equipment/registry-model.js?v=38.1",
  "./equipment/registry-ui.js?v=38.1",
  "./manifest.json",
  "./favicon-v18.png",
  "./apple-touch-icon-v18.png",
  "./icon-192-v18.png",
  "./icon-512-v18.png",
  "./icon-maskable-512-v18.png",
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
