const CACHE_NAME = "e-lab-v17";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=17",
  "./app.js?v=17",
  "./utils.js?v=17",
  "./modules/auth.js?v=17",
  "./modules/calendar.js?v=17",
  "./modules/chemicals.js?v=17",
  "./modules/constants.js?v=17",
  "./modules/equipment.js?v=17",
  "./modules/schedule.js?v=17",
  "./modules/ui.js?v=17",
  "./modules/icons.js?v=17",
  "./modules/navigation.js?v=17",
  "./modules/shell.js?v=17",
  "./modules/inventory-quantity.js?v=17",
  "./modules/inventory-store.js?v=17",
  "./modules/inventory-ui.js?v=17",
  "./modules/inventory-history.js?v=17",
  "./modules/inventory-alerts.js?v=17",
  "./modules/inventory-recipes.js?v=17",
  "./modules/inventory-theory.js?v=17",
  "./modules/inventory-orders.js?v=17",
  "./modules/inventory-docx.js?v=17",
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
