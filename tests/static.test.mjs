import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, app, manifest, serviceWorker, firebaseConfig] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/manifest.json", import.meta.url), "utf8"),
  readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  readFile(new URL("../firebase.json", import.meta.url), "utf8"),
]);

test("HTML has no inline event handlers or inline scripts", () => {
  assert.doesNotMatch(html, /\son\w+=/i);
  assert.doesNotMatch(html, /<script(?![^>]+src=)[^>]*>/i);
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com/);
});

test("dynamic application data is not rendered with innerHTML", () => {
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
  assert.match(app, /await updateDoc\(doc\(db, "odczynniki", editId\), items\[0\]\)/);
});

test("every chemical LP can render its own add-position form", () => {
  assert.match(app, /Dodaj nową pozycję do:/);
  assert.match(app, /data-inline-chemical-form/);
  assert.match(app, /suggestNextGroupValue\(group\.items, group\.prefix\)/);
});

test("PWA assets use the correctly cased service worker and local icon", () => {
  assert.match(app, /register\("\.\/sw\.js"\)/);
  assert.equal(JSON.parse(manifest).icons[0].src, "./icon.svg");
  assert.match(serviceWorker, /APP_SHELL/);
});

test("Firebase Hosting serves only the public directory with security headers", () => {
  const config = JSON.parse(firebaseConfig);
  assert.equal(config.hosting.public, "public");
  const headers = config.hosting.headers[0].headers;
  assert.ok(headers.some(({ key }) => key === "Content-Security-Policy"));
  assert.ok(headers.some(({ key }) => key === "X-Content-Type-Options"));
});
