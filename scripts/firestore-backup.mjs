import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

const projectId = "nasza-lista-zakupow";
const databaseId = "(default)";
const collections = ["odczynniki", "harmonogram", "wzorcowanie", "wydarzenia", "app_users"];
const firestore = "https://firestore.googleapis.com/v1";
const require = createRequire(import.meta.url);

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${new URL(url).origin}: HTTP ${response.status}`);
  return response.json();
}

async function getGoogleAccessToken() {
  const cliCandidates = [
    process.env.FIRESTORE_BACKUP_FIREBASE_CLI,
    ...process.env.PATH.split(delimiter).map((directory) => resolve(directory, "..", "firebase-tools")),
  ];
  const cli = cliCandidates.find((directory) => directory && existsSync(join(directory, "lib", "api.js")));
  if (!cli) throw new Error("Uruchom eksport przez npm exec --package=firebase-tools@15.22.4 lub wskaż katalog firebase-tools.");

  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const sessionPath = join(config, "configstore", "firebase-tools.json");
  if (!existsSync(sessionPath)) throw new Error("Najpierw zaloguj się do Firebase CLI kontem z dostępem do projektu.");
  const { tokens } = JSON.parse(readFileSync(sessionPath, "utf8"));
  if (!tokens?.refresh_token) throw new Error("Brak aktywnej sesji Firebase CLI.");

  const { clientId, clientSecret } = require(join(cli, "lib", "api.js"));
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });
  return (await request("https://oauth2.googleapis.com/token", { method: "POST", body })).access_token;
}

function outsideGit(directory) {
  const target = realpathSync(directory);
  for (let parent = target; ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git"))) throw new Error("Wskaż katalog kopii poza repozytorium Git.");
    if (parent === dirname(parent)) return target;
  }
}

async function exportBackup(directory) {
  const target = outsideGit(directory);
  const headers = { Authorization: `Bearer ${await getGoogleAccessToken()}` };
  const billing = await request(`https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`, { headers });
  if (billing.billingEnabled !== false) throw new Error("Eksport wymaga projektu z wyłączonymi rozliczeniami.");

  const readTime = new Date(Date.now() - 3000).toISOString();
  const backup = { formatVersion: 1, projectId, databaseId, readTime, collections: {} };
  for (const collection of collections) {
    const documents = [];
    let pageToken;
    do {
      const params = new URLSearchParams({ readTime, pageSize: "500" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await request(`${firestore}/projects/${projectId}/databases/${databaseId}/documents/${collection}?${params}`, { headers });
      documents.push(...(page.documents ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    backup.collections[collection] = documents;
  }

  const name = `firestore-e-laboratorium-${readTime.replace(/[:.]/g, "-")}.json`;
  writeFileSync(join(target, name), `${JSON.stringify(backup, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`${name} (${collections.reduce((count, collection) => count + backup.collections[collection].length, 0)} dokumentów)`);
}

async function restoreLocal(filename) {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  if (!/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(host)) throw new Error("Ustaw FIRESTORE_EMULATOR_HOST na 127.0.0.1:port.");
  const backup = JSON.parse(readFileSync(filename, "utf8"));
  if (backup.formatVersion !== 1 || backup.projectId !== projectId || backup.databaseId !== databaseId) {
    throw new Error("Plik nie jest obsługiwaną kopią e-Laboratorium.");
  }

  const database = `projects/demo-elab-restore/databases/${databaseId}`;
  const writes = [];
  const names = new Set();
  for (const collection of collections) {
    if (!Array.isArray(backup.collections?.[collection])) throw new Error(`Brak kolekcji ${collection} w kopii.`);
    const prefix = `projects/${projectId}/databases/${databaseId}/documents/${collection}/`;
    for (const document of backup.collections[collection]) {
      const id = document.name?.slice(prefix.length);
      if (!document.name?.startsWith(prefix) || !id || id.includes("/") || names.has(document.name)) {
        throw new Error(`Nieprawidłowa lub powtórzona ścieżka dokumentu w kolekcji ${collection}.`);
      }
      names.add(document.name);
      writes.push({
        update: { name: `${database}/documents/${collection}/${id}`, fields: document.fields ?? {} },
        currentDocument: { exists: false },
      });
    }
  }

  for (let offset = 0; offset < writes.length; offset += 50) {
    await request(`http://${host}/v1/${database}/documents:commit`, {
      method: "POST",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({ writes: writes.slice(offset, offset + 50) }),
    });
  }
  console.log(`${basename(filename)} → demo-elab-restore (${writes.length} dokumentów)`);
}

try {
  const [action, target, ...extra] = process.argv.slice(2);
  if (!target || extra.length || !["export", "restore-local"].includes(action)) {
    throw new Error("Użycie: node scripts/firestore-backup.mjs export <katalog> | restore-local <plik>");
  }
  if (action === "export") await exportBackup(target);
  else await restoreLocal(target);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
