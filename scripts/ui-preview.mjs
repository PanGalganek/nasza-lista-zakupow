import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { account, seed } from "./ui-preview-fixtures.mjs";
import { stageEquipment } from "./equipment-v38-stage.mjs";

const project = "demo-elab-ui";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const loopback = /^127\.0\.0\.1:[1-9]\d{0,4}$/;
assert.match(authHost || "", loopback, "Uruchom lokalny emulator Auth.");
assert.match(firestoreHost || "", loopback, "Uruchom lokalny emulator Firestore.");
assert.equal(process.env.GCLOUD_PROJECT, project, "Użyj identyfikatora demonstracyjnego demo-elab-ui.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const port = Number(process.env.ELAB_UI_PORT || 4173);
const nested = "/nasza-lista-zakupow/";
const types = { ".css": "text/css", ".js": "text/javascript", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

function replaceRequired(source, search, replacement) {
  const modified = source.replace(search, replacement);
  assert.notEqual(modified, source, "Nie można odłączyć podglądu od produkcyjnej konfiguracji.");
  return modified;
}

function demoApplication(source) {
  source = replaceRequired(source, /const firebaseConfig = \{[\s\S]*?\n\};/, `const firebaseConfig = { apiKey: "fake-key", projectId: "${project}" };`);
  source = replaceRequired(source, "  getAuth,", "  connectAuthEmulator,\n  getAuth,");
  source = replaceRequired(source, "  getFirestore,", "  connectFirestoreEmulator,\n  getFirestore,");
  return replaceRequired(source, "const db = getFirestore(app);", `const db = getFirestore(app);
connectAuthEmulator(auth, "http://${authHost}", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", ${Number(firestoreHost.split(":")[1])});`);
}

await readFile(resolve(root, "styles.css"));
demoApplication(await readFile(resolve(root, "app.js"), "utf8"));
const equipmentBackup = process.env.ELAB_EQUIPMENT_BACKUP;
await seed(project, authHost, firestoreHost, { legacyEquipment: !equipmentBackup });
if (equipmentBackup) await stageEquipment(equipmentBackup, { host: firestoreHost, projectId: project, mapFile: process.env.ELAB_EQUIPMENT_MAPPING });

createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
  try {
    let path = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (path.startsWith(nested)) path = "/" + path.slice(nested.length);
    const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
    const type = types[extname(file)];
    if (!file.startsWith(root + sep) || !type) { response.writeHead(404).end(); return; }
    let payload = await readFile(file);
    if (path === "/app.js") payload = demoApplication(payload.toString());
    if (path === "/" || path === "/index.html") {
      payload = replaceRequired(payload.toString(), /connect-src [^;]+/, `connect-src 'self' http://${authHost} http://${firestoreHost}`);
      payload = payload.replace("<title>e-Laboratorium</title>", "<title>e-Laboratorium · Podgląd lokalny</title>");
    }
    response.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(payload);
  } catch (error) { response.writeHead(error.code === "ENOENT" ? 404 : 500).end(); }
}).listen(port, "127.0.0.1", () => {
  console.log(`Podgląd: http://127.0.0.1:${port}/ | przykładowe konto ${account.email} / ${account.password}`);
});
