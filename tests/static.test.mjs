import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleUrls = ["auth", "calendar", "chemical-transfer", "chemicals", "constants", "equipment", "schedule", "ui"]
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
  assert.match(modules, /Dodaj nową pozycję do:/);
  assert.match(modules, /data-inline-chemical-form/);
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

test("chemical alerts provide direct editing of the affected record", () => {
  assert.match(modules, /✏️ Edytuj/);
  assert.match(modules, /\(\) => startEdit\(alertData\.item\)/);
  assert.match(modules, /formContainer"\)\.scrollIntoView/);
  assert.match(modules, /item: candidate/);
});

test("chemical inventory provides local DOCX import and CSV/JSON export", () => {
  assert.match(html, /id="wordImportFile"/);
  assert.match(html, /\.\/vendor\/jszip\.min\.js/);
  assert.match(modules, /readChemicalRowsFromDocx/);
  assert.match(modules, /confirmImport/);
  assert.match(modules, /batch\.update\(doc\(db, "odczynniki", draft\.matchId\)/);
  assert.match(modules, /Zaktualizuj istniejącą/);
  assert.match(modules, /exportCsv/);
  assert.match(modules, /exportJson/);
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
  assert.match(modules, /\.\/chemical-transfer\.js/);
});

test("PWA assets use the correctly cased service worker and local icon", () => {
  assert.match(app, /register\("\.\/sw\.js"\)/);
  assert.equal(JSON.parse(manifest).icons[0].src, "./icon.svg");
  assert.match(serviceWorker, /APP_SHELL/);
  assert.match(serviceWorker, /const CACHE_NAME = "e-lab-v6"/);
  assert.match(serviceWorker, /\.\/modules\/chemicals\.js/);
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
