import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { equipmentManifest } from "./equipment-v38-stage.mjs";

const production = "nasza-lista-zakupow";
const database = "(default)";
const cutoverPath = "equipmentState/cutover";
const preparePaths = new Set(["equipmentState", "equipmentDevices", "equipmentLinks"]);
const writeActions = new Set(["freeze", "stage", "activate", "pause", "resume"]);
const text = stringValue => ({ stringValue });
const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  }
  return value;
};
const canonical = value => JSON.stringify(normalize(value));
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
const encode = path => path.split("/").map(encodeURIComponent).join("/");

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function outsideRepository(path, existing) {
  const folder = await realpath(dirname(resolve(path)));
  const file = existing ? await realpath(path) : resolve(folder, path.split(/[\\/]/).at(-1));
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const repository = await stat(resolve(dir, ".git")).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    ensure(!repository, "Użyj pliku poza repozytorium Git.");
    if (dirname(dir) === dir) return file;
  }
}

function indexBackup(copy, expectedProject) {
  ensure(copy?.projectId === expectedProject && copy.databaseId === database && copy.formatVersion === 2
    && copy.collections && Number.isFinite(Date.parse(copy.readTime)), "Kopia pochodzi z innego projektu lub ma nieznany format.");
  const prefix = "projects/" + expectedProject + "/databases/" + database + "/documents/";
  const documents = new Map();
  for (const [collection, entries] of Object.entries(copy.collections)) {
    ensure(Array.isArray(entries) && collection.split("/").length % 2 === 1, "Nieprawidłowa kolekcja w kopii.");
    for (const { name, fields = {} } of entries) {
      const root = prefix + collection + "/";
      ensure(name.startsWith(root) && /^[^/]+$/.test(name.slice(root.length)), "Nieprawidłowa ścieżka w kopii.");
      const path = name.slice(prefix.length);
      ensure(!documents.has(path), "Powtórzona ścieżka w kopii.");
      documents.set(path, fields);
    }
  }
  return documents;
}

function compare(before, after) {
  const summary = {};
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const group = path.split("/")[0];
    summary[group] ??= { unchanged: 0, added: 0, changed: 0, removed: 0 };
    const status = !before.has(path) ? "added" : !after.has(path) ? "removed"
      : canonical(before.get(path)) === canonical(after.get(path)) ? "unchanged" : "changed";
    summary[group][status]++;
  }
  return summary;
}

export function migrationClient({ project, confirm, host, token }) {
  const local = Boolean(host);
  ensure(local ? /^demo-[a-z0-9-]+$/.test(project) && /^127\.0\.0\.1:[1-9]\d{0,4}$/.test(host)
    : project === production && typeof token === "string" && token.length > 0, "Nieprawidłowy projekt, emulator lub brak tokenu OAuth.");
  const origin = local ? "http://" + host : "https://firestore.googleapis.com";
  const dbPath = "projects/" + project + "/databases/" + database;
  const root = dbPath + "/documents";
  const base = origin + "/v1/" + root;
  const headers = { Authorization: "Bearer " + (local ? "owner" : token), "Content-Type": "application/json" };

  async function call(url, body, missing = false) {
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000),
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
    if (missing && response.status === 404) return null;
    ensure(response.ok, "Żądanie administracyjne zostało odrzucone (HTTP " + response.status + ").");
    return response.json();
  }
  const get = path => call(base + "/" + encode(path), undefined, true);
  const commit = writes => call(base + ":commit", { writes });
  const put = (path, fields, existing = null) => ({
    update: { name: root + "/" + path, fields }, currentDocument: existing ? { updateTime: existing.updateTime } : { exists: false },
  });

  async function platform() {
    if (local) return;
    const data = await call(origin + "/v1/" + dbPath);
    ensure(data.name === dbPath && data.type === "FIRESTORE_NATIVE", "Nie potwierdzono docelowej bazy.");
    const billing = await call("https://cloudbilling.googleapis.com/v1/projects/" + project + "/billingInfo");
    ensure(billing.billingEnabled === false, "Rozliczenia muszą pozostać wyłączone.");
  }
  async function deploymentReady() {
    if (local) return;
    const origin = "https://firebaserules.googleapis.com/v1/";
    const release = await call(origin + "projects/" + project + "/releases/cloud.firestore");
    ensure(release.rulesetName?.startsWith("projects/" + project + "/rulesets/"), "Reguły pochodzą z innego projektu.");
    const remote = await call(origin + release.rulesetName);
    const expected = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");
    const clean = value => value?.replace(/\r\n/g, "\n").trimEnd();
    ensure(remote.source?.files?.length === 1 && clean(remote.source.files[0].content) === clean(expected),
      "W projekcie muszą być aktywne reguły z tej wersji.");
    ensure(Date.now() - Date.parse(release.updateTime) >= 600_000, "Odczekaj 10 minut od aktywacji reguł.");
    const configured = await call("https://firestore.googleapis.com/v1/" + dbPath + "/collectionGroups/equipmentHistory/indexes");
    for (const field of ["year", "device"]) {
      ensure(configured.indexes?.some(index => index.state === "READY" && index.queryScope === "COLLECTION"
        && index.fields[0]?.fieldPath === field && index.fields[0]?.order === "ASCENDING"
        && index.fields[1]?.fieldPath === "at" && index.fields[1]?.order === "DESCENDING"),
      "Brakuje gotowego indeksu historii dla pola " + field + ".");
    }
  }

  async function listDocs(path, readTime, showMissing = false) {
    const result = [];
    let pageToken;
    do {
      const args = new URLSearchParams({ pageSize: "100", ...(showMissing ? { showMissing: "true" } : {}),
        ...(readTime ? { readTime } : {}), ...(pageToken ? { pageToken } : {}) });
      const page = await call(base + "/" + encode(path) + "?" + args);
      result.push(...(page.documents ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return result;
  }

  async function snapshot() {
    const response = await call(base + ":batchGet", { documents: [root + "/" + cutoverPath] });
    const readTime = response[0]?.readTime;
    ensure(Number.isFinite(Date.parse(readTime)), "Firestore nie zwrócił czasu spójnego odczytu.");
    const selector = local ? undefined : readTime;
    const collections = {};
    let missingParents = 0;
    let parents = [""];
    while (parents.length) {
      const next = [];
      for (let i = 0; i < parents.length; i += 12) {
        await Promise.all(parents.slice(i, i + 12).map(async parent => {
          let pageToken;
          do {
            const url = base + (parent ? "/" + encode(parent) : "") + ":listCollectionIds";
            // The emulator rejects listCollectionIds on some nested document paths.
            // Equipment collections below the year are fixed by the rules.
            const deepEquipment = local && parent.startsWith("equipmentYears/") && parent.split("/").length >= 4;
            const page = deepEquipment
              ? { collectionIds: /^equipmentYears\/[^/]+\/versions\/[^/]+$/.test(parent) ? ["rows"] : [] }
              : await call(url, { pageSize: 100, readTime: selector, pageToken });
            for (const name of page.collectionIds ?? []) {
              const path = parent ? parent + "/" + name : name;
              const docs = await listDocs(path, selector, true);
              collections[path] = docs.filter(doc => doc.createTime || doc.updateTime || Object.hasOwn(doc, "fields"));
              missingParents += docs.length - collections[path].length;
              next.push(...docs.map(item => item.name.slice(root.length + 1)));
            }
            pageToken = page.nextPageToken;
          } while (pageToken);
        }));
      }
      parents = next;
    }
    return { formatVersion: 2, projectId: project, databaseId: database, readTime, collections, missingParents };
  }

  const entries = (docs) => new Map(docs.map(item => [item.name.slice(root.length + 1), item.fields ?? {}]));
  async function liveSource() { return entries(await listDocs("wzorcowanie")); }
  function sourceHash(map) { return hash(Object.fromEntries([...map].filter(([path]) => path.startsWith("wzorcowanie/")))); }

  async function inspect(backup, backupProject, mapping, marker) {
    const before = indexBackup(backup, backupProject);
    const source = sourceHash(before);
    ensure(sourceHash(await liveSource()) === source, "Kopia i pełna zawartość źródłowa wzorcowanie różnią się.");
    const { desired, deviceCount, dataset } = equipmentManifest(backup, mapping);
    const manifest = hash(Object.fromEntries(desired));
    const frozen = marker?.fields.mode?.stringValue === "preparing" && Date.parse(backup.readTime) >= Date.parse(marker.createTime)
      && canonical(before.get(cutoverPath)) === canonical({ mode: text("preparing") });
    return { before, source, desired, manifest, frozen, deviceCount, dataset };
  }

  async function validateTargets(desired, complete) {
    let missing = 0;
    for (const name of [...preparePaths, "equipmentYears", "equipmentHistory", "equipmentActivities"]) {
      const actual = entries(await listDocs(name, undefined, true));
      actual.delete(cutoverPath);
      for (const [path, value] of actual) {
        ensure(desired.has(path) && canonical(value) === canonical(desired.get(path)),
          "Zbiór docelowy zawiera dodatkowy lub zmieniony dokument w " + name + ".");
      }
      for (const path of desired.keys()) if (path.startsWith(name + "/") && !actual.has(path)) missing++;
    }
    ensure(!complete || missing === 0, "Migracja nie zawiera wszystkich dokumentów manifestu.");
    return missing;
  }

  async function run(action, { backup, backupProject = project, mapping } = {}) {
    ensure(!writeActions.has(action) || confirm === project, "Operacja zapisu wymaga jawnego potwierdzenia projektu.");
    ensure(local || backupProject === project, "Kopia musi pochodzić z docelowego projektu.");
    await platform();
    let marker = await get(cutoverPath);
    const mode = marker?.fields.mode?.stringValue ?? "legacy";

    if (action === "capture") return snapshot();
    if (action === "freeze") {
      await deploymentReady();
      if (mode === "preparing") return { mode };
      ensure(!marker, "Nie można zamrozić wcześniej aktywowanego modułu.");
      await validateTargets(new Map(), true);
      await commit([put(cutoverPath, { mode: text("preparing") })]);
      return { mode: "preparing" };
    }
    if (action === "pause") {
      if (mode === "paused") return { mode };
      ensure(mode === "active" && marker.fields.phase?.stringValue === "staged", "Brak aktywnej migracji.");
      await commit([put(cutoverPath, { ...marker.fields, mode: text("paused") }, marker)]);
      return { mode: "paused" };
    }
    if (action === "resume") {
      ensure(mode === "paused" && marker.fields.phase?.stringValue === "staged"
        && marker.fields.source?.stringValue === sourceHash(await liveSource()) && await get("equipmentState/registry"),
      "Brak kompletnego, wcześniej aktywowanego rejestru lub zmieniło się źródło.");
      await deploymentReady();
      await commit([put(cutoverPath, { ...marker.fields, mode: text("active") }, marker)]);
      return { mode: "active" };
    }
    if (action === "audit") {
      const before = indexBackup(backup, backupProject);
      const after = indexBackup(await snapshot(), project);
      ensure(sourceHash(before) === sourceHash(after), "Zmieniły się dokumenty źródłowe sprzętu.");
      return { mode, differences: compare(before, after) };
    }
    ensure(["dry-run", "stage", "activate"].includes(action), "Nieznana operacja migracji.");
    const checked = await inspect(backup, backupProject, mapping, marker);
    const { before, source, desired, manifest, frozen, deviceCount, dataset } = checked;
    const summary = { mode, frozen, devices: deviceCount, sourceCount: dataset.sources.length,
      executionCount: dataset.sources.filter(item => item.doneDate).length, targetDocuments: desired.size, manifest };
    if (action === "dry-run") {
      ensure(mode === "legacy" || mode === "preparing", "Użyj audit po aktywacji.");
      return { ...summary, missing: await validateTargets(desired, false) };
    }

    ensure(frozen, "Do zapisu wymagana jest pełna kopia pobrana po zamrożeniu i przed rozpoczęciem migracji.");
    const bound = { ...marker.fields, source: text(source), manifest: text(manifest) };
    if (marker.fields.manifest) {
      ensure(marker.fields.manifest.stringValue === manifest && marker.fields.source.stringValue === source,
        "Wznowienie wymaga tej samej kopii źródła i tego samego manifestu.");
    }
    if (action === "activate") {
      ensure(marker.fields.phase?.stringValue === "staged", "Brak zakończonego przygotowania.");
      await deploymentReady();
      await validateTargets(desired, true);
      ensure(sourceHash(await liveSource()) === source, "Zmieniły się dane źródłowe.");
      await commit([put(cutoverPath, { ...bound, mode: text("active") }, marker)]);
      return { ...summary, mode: "active" };
    }

    await validateTargets(desired, false);
    if (!marker.fields.manifest) {
      await commit([put(cutoverPath, bound, marker)]);
      marker = await get(cutoverPath);
    }
    const rows = [...desired];
    for (let i = 0; i < rows.length; i += 30) {
      const page = rows.slice(i, i + 30);
      const present = await Promise.all(page.map(([path]) => get(path)));
      const writes = page.flatMap(([path, fields], index) => {
        if (!present[index]) return [put(path, fields)];
        ensure(canonical(present[index].fields) === canonical(fields), "Zmienił się dokument przygotowania.");
        return [];
      });
      if (writes.length) await commit(writes);
    }
    await validateTargets(desired, true);
    const after = indexBackup(await snapshot(), project);
    ensure(sourceHash(after) === source && [...desired].every(([path, fields]) => canonical(after.get(path)) === canonical(fields)),
      "Weryfikacja spójnej kopii po przygotowaniu nie powiodła się.");
    if (marker.fields.phase?.stringValue !== "staged") {
      await commit([put(cutoverPath, { ...bound, phase: text("staged") }, marker)]);
    }
    return { ...summary, differences: compare(before, after) };
  }
  return { run };
}

async function main() {
  const { positionals: [action], values } = parseArgs({ allowPositionals: true, options: {
    project: { type: "string" }, confirm: { type: "string" }, backup: { type: "string" },
    mapping: { type: "string" }, output: { type: "string" },
  } });
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const client = migrationClient({ project: values.project, confirm: values.confirm, host, token: process.env.ELAB_FIRESTORE_ADMIN_TOKEN });
  ensure(action !== "capture" || values.output, "Podaj prywatną ścieżkę --output.");
  const backup = values.backup ? JSON.parse(await readFile(await outsideRepository(values.backup, true), "utf8")) : undefined;
  const mapping = values.mapping ? JSON.parse(await readFile(await outsideRepository(values.mapping, true), "utf8")) : undefined;
  const output = values.output ? await outsideRepository(values.output, false) : undefined;
  const result = await client.run(action, { backup, mapping, backupProject: host ? backup?.projectId ?? values.project : values.project });
  if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (action === "capture") {
    console.log(JSON.stringify({ readTime: result.readTime, collections: Object.keys(result.collections).length,
      documents: Object.values(result.collections).flat().length }));
  } else console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
