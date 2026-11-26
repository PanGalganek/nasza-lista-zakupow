import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleUrls = ["auth", "calendar", "chemicals", "constants", "equipment", "schedule", "ui", "icons", "navigation", "shell",
  "inventory-quantity", "inventory-items", "inventory-store", "inventory-ui", "inventory-alerts", "inventory-history",
  "inventory-recipes", "inventory-theory", "inventory-docx", "inventory-orders"]
  .map((name) => new URL(`../public/modules/${name}.js`, import.meta.url));

const [html, app, modules, manifest, serviceWorker, firebaseConfig, firebaseWorkflow] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  Promise.all(moduleUrls.map((url) => readFile(url, "utf8"))).then((files) => files.join("\n")),
  readFile(new URL("../public/manifest.json", import.meta.url), "utf8"),
  readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  readFile(new URL("../firebase.json", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/firebase.yml", import.meta.url), "utf8"),
]);

test("HTML has no inline event handlers or inline scripts", () => {
  assert.doesNotMatch(html, /\son\w+=/i);
  assert.doesNotMatch(html, /<script(?![^>]+src=)[^>]*>/i);
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com/);
});

test("dynamic application data is not rendered with innerHTML", () => {
  assert.doesNotMatch(`${app}\n${modules}`, /\.innerHTML\s*=/);
  assert.match(modules, /await updateDoc\(doc\(db, "odczynniki", editId\), selectedItems\[0\]\)/);
});

test("every chemical LP can render its own add-position form", () => {
  assert.match(modules, /openNewLot\(group\)/);
  assert.match(modules, /dataset\.inlineChemicalForm/);
  assert.match(modules, /suggestNextGroupValue\(group\.items, group\.prefix\)/);
});

test("chemical inventory provides search, status filters, and sorting", () => {
  assert.match(html, /id="chemicalSearch"/);
  assert.match(html, /id="chemicalStatusFilter"/);
  assert.match(html, /id="chemicalSort"/);
  assert.match(modules, /statusFilter === "attention"/);
  assert.match(modules, /statusFilter === "ordered"/);
  assert.match(modules, /statusFilter === "expired"/);
  assert.match(modules, /Brak pozycji spełniających kryteria\./);
});

test("routed screens share unique form targets and an accessible dialog", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["homeScreen", "inventoryNav", "inventoryRegistry", "chemicalFilters", "formContainer",
    "formWzorcowanie", "eventForm", "inventoryAction", "dialogTitle", "dialogClose"]) assert.ok(ids.includes(id));
  assert.match(html, /<dialog id="labDialog"[^>]+aria-labelledby="dialogTitle"/);
  assert.match(html, /aria-controls="chemicalFilters" aria-expanded="false"/);
  assert.match(app, /"go-back": \(\) => navigation\.back\(\)/);
});

test("the dashboard links directly to warnings and affected lots can be replenished", () => {
  assert.match(html, /data-route="alerts" data-warning-count/);
  assert.match(modules, /createButton\("Nowa partia", [^\n]+\(\) => newLot\(lot\)/);
  assert.match(modules, /presentForm\("Edytuj partię"\)/);
  assert.match(modules, /buildChemicalAlerts\(categoryItems, threshold\)/);
  assert.match(app, /\.\/modules\/chemicals\.js\?v=25/);
  assert.match(html, /\.\/app\.js\?v=25/);
});

test("all visible full dates use the Polish day-month-year format", () => {
  assert.match(modules, /ważna do \$\{formatPolishDate\(alertData\.date\)\}/);
  assert.match(modules, /TERMIN MINĄŁ \$\{formatPolishDate\(alertData\.date\)\}/);
  assert.match(modules, /Ważność:.*formatPolishDate\(item\.expiry\)/s);
  assert.match(modules, /Wykonano: \$\{formatPolishDate\(task\.doneDate\)\}/);
  assert.match(modules, /Wykonano: \$\{formatPolishDate\(equipment\.doneDate\)\}/);
  assert.match(modules, /Dzień: \$\{formatPolishDate\(selectedDay\)\}/);
  assert.doesNotMatch(modules, /Wykonano: \$\{task\.doneDate\}|Dzień: \$\{selectedDay\}|ważny do \$\{alertData\.date\}/);
});

test("retired chemical import and export are absent from the interface and modules", () => {
  assert.doesNotMatch(html, /wordImport|Import z Worda|Eksport CSV|Kopia JSON|jszip/i);
  assert.doesNotMatch(`${app}\n${modules}`, /chemical-transfer|import-export|confirmImport|exportCsv|exportJson/i);
  assert.doesNotMatch(serviceWorker, /chemical-transfer|import-export|jszip/i);
});

test("frontend access requires an active admin or operator account", () => {
  assert.match(modules, /accessData\.active !== true/);
  assert.match(modules, /!\["admin", "operator"\]\.includes\(accessData\.role\)/);
});

test("application responsibilities are split into focused modules", () => {
  assert.ok(app.split("\n").length < 200);
  for (const name of ["auth", "calendar", "chemicals", "equipment", "schedule", "ui"]) {
    assert.match(app, new RegExp(`\\./modules/${name}\\.js`));
  }
});

test("all local JavaScript imports use one cache version", () => {
  const localImports = [...`${app}\n${modules}`.matchAll(/from "(\.{1,2}\/[^"?]+\.js(?:\?v=\d+)?)"/g)]
    .map((match) => match[1]);
  assert.ok(localImports.length > 0);
  assert.ok(localImports.every((path) => path.endsWith("?v=25")));
});

test("PWA caches PNG icons for Android, Apple Home Screen, and browser tabs", async () => {
  assert.match(app, /register\("\.\/sw\.js", \{ updateViaCache: "none" \}\)/);
  const { id, scope, start_url, icons } = JSON.parse(manifest);
  assert.deepEqual([id, scope, start_url], ["./", "./", "./"]);
  assert.deepEqual(icons.map(({ sizes, type, purpose }) => [sizes, type, purpose]), [
    ["192x192", "image/png", "any"],
    ["512x512", "image/png", "any"],
    ["512x512", "image/png", "maskable"],
  ]);
  assert.match(html, /rel="icon" href="\.\/favicon-v18\.png" type="image\/png" sizes="32x32"/);
  assert.match(html, /rel="apple-touch-icon" href="\.\/apple-touch-icon-v18\.png" sizes="180x180"/);
  const assets = [
    ...icons.map(({ src, sizes }) => [src, Number(sizes.split("x")[0])]),
    ["./favicon-v18.png", 32], ["./apple-touch-icon-v18.png", 180],
  ];
  assert.equal(new Set(assets.map(([src]) => src)).size, assets.length);
  await Promise.all(assets.map(async ([src, size]) => {
    assert.match(src, /^\.\/[a-z0-9-]+\.png$/);
    assert.ok(serviceWorker.includes(JSON.stringify(src)));
    const png = await readFile(new URL(`../public/${src}`, import.meta.url));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.subarray(12, 16).toString(), "IHDR");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [size, size]);
    assert.equal(png[25], 2, "Opaque RGB icon");
  }));
  assert.match(serviceWorker, /APP_SHELL/);
  assert.match(serviceWorker, /const CACHE_NAME = "e-lab-v25"/);
  assert.match(html, /styles\.css\?v=25/);
  assert.match(serviceWorker, /styles\.css\?v=25/);
  assert.match(serviceWorker, /\.\/modules\/chemicals\.js/);
  for (const name of ["icons", "navigation", "shell"]) assert.ok(serviceWorker.includes(`./modules/${name}.js?v=25`));
});

test("Firebase deployment uses Application Default Credentials", () => {
  assert.match(firebaseWorkflow, /google-github-actions\/auth@v3/);
  assert.match(firebaseWorkflow, /deploy --only hosting,firestore:rules --project nasza-lista-zakupow/);
  assert.match(firebaseWorkflow, /styles\.input\.css \.github\/workflows\/firebase\.yml/);
  assert.equal(firebaseWorkflow.match(/for attempt in 1 2 3/g)?.length, 2);
  assert.doesNotMatch(firebaseWorkflow, /token_format:\s*access_token/);
  assert.doesNotMatch(firebaseWorkflow, /FIREBASE_TOKEN/);
});

test("Firebase Hosting serves only the public directory with security headers", () => {
  const config = JSON.parse(firebaseConfig);
  assert.equal(config.hosting.public, "public");
  const headers = config.hosting.headers[0].headers;
  assert.ok(headers.some(({ key }) => key === "Content-Security-Policy"));
  assert.ok(headers.some(({ key }) => key === "X-Content-Type-Options"));
});
