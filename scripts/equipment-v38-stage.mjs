import { encodeActivities } from "../public/equipment/activity-codec.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readDataset } from "../tools/equipment-register/server.mjs";
import { createRegister, restoreDraft } from "../tools/equipment-register/model.js";
import { evolveRegistry, makeInitialRegistry } from "../tools/equipment-register/registry-model.js";

const project = "demo-elab-ui";
const encoded = value => value === null ? { nullValue: null } : typeof value === "number" ? { integerValue: String(value) }
  : typeof value === "boolean" ? { booleanValue: value } : { stringValue: value };
const fields = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, encoded(value)]));
const canonical = input => JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));

export function equipmentManifest(backup, localDraft) {
  const dataset = readDataset(backup);
  const register = createRegister(dataset.sources);
  const initial = makeInitialRegistry(dataset.sources);
  let model = initial;
  if (localDraft) {
    if (localDraft.source?.fingerprint !== dataset.fingerprint || localDraft.schemaVersion !== 1 || !Array.isArray(localDraft.devices)) {
      throw new Error("Eksport przypisań nie odpowiada tej kopii źródłowej.");
    }
    const groups = localDraft.devices.map(device => ({ id: device.localId, name: device.name,
      number: device.inventoryNumber ?? "", approved: device.verified }));
    const pairs = localDraft.devices.flatMap(device => device.activities.flatMap(activity => activity.sourceIds.map(id =>
      [id, { groupId: device.localId, kind: activity.kind, label: activity.label }])));
    if (pairs.length !== new Set(pairs.map(([id]) => id)).size) throw new Error("Powtórzono pozycję źródłową.");
    const mapping = { groups, assignments: Object.fromEntries(pairs),
      nextGroup: Math.max(initial.mapping.nextGroup, ...groups.map(group => Number(group.id.slice(1)) + 1)) };
    restoreDraft(mapping, dataset.sources);
    model = evolveRegistry(initial, { action: "grouping", mapping }, dataset.sources, "seed").state;
  } else if (register.draft.groups.length !== Object.keys(initial.equipment).length) throw new Error("Niespójna liczba grup.");
  const desired = new Map();
  desired.set("equipmentState/registry", fields({ revision: 0, device: "" }));
  for (const { id, activities, ...device } of Object.values(model.equipment)) {
    desired.set("equipmentDevices/" + id, fields({ ...device, mergedInto: device.mergedInto ?? "", revision: 1,
      registry: 0, activities: encodeActivities(activities) }));
  }
  for (const [id, assignment] of Object.entries(model.mapping.assignments)) {
    const { groupId: device, kind, label } = assignment;
    const activity = model.equipment[device]?.activities.find(row => row.kind === kind && row.label === label);
    if (!activity) throw new Error("Brak czynności dla powiązania źródłowego.");
    desired.set("equipmentLinks/" + id, fields({ device, activity: activity.id, revision: 1 }));
  }
  return { dataset, desired, deviceCount: Object.keys(model.equipment).length };
}

export async function stageEquipment(filename, { host, projectId, mapFile } = {}) {
  if (projectId !== project || !/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(host ?? "")) {
    throw new Error("Skrypt działa wyłącznie w emulatorze Firestore demo-elab-ui.");
  }
  const backup = JSON.parse(await readFile(filename, "utf8"));
  const { dataset, deviceCount, desired } = equipmentManifest(backup, mapFile ? JSON.parse(await readFile(mapFile, "utf8")) : null);
  const root = "projects/" + project + "/databases/(default)/documents";
  const base = "http://" + host + "/v1/" + root;
  const config = "equipmentState/cutover";
  const current = { fingerprint: dataset.fingerprint, mode: "preparing", sourceCount: dataset.sources.length,
    completionCount: dataset.sources.filter(row => row.doneDate).length, deviceCount };
  async function req(path, body) {
    const response = await fetch(base + path, { method: body ? "POST" : "GET", redirect: "error",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Zapis przygotowania emulatora odrzucony: " + response.status);
    return response.json();
  }
  const write = (path, expected, precondition = { exists: false }) => ({
    update: { name: root + "/" + path, fields: expected }, currentDocument: precondition,
  });

  let cutover = await req("/" + config);
  if (cutover?.fields.fingerprint.stringValue !== dataset.fingerprint && cutover) throw new Error("Emulator został przygotowany z innej kopii.");
  if (cutover?.fields.mode.stringValue === "active" || cutover?.fields.mode.stringValue === "paused") return current;
  if (!cutover) await req(":commit", { writes: [write(config, fields(current))] });
  for (const item of backup.collections.wzorcowanie) desired.set("wzorcowanie/" + item.name.split("/").at(-1), item.fields);
  const list = [...desired];
  for (let i = 0; i < list.length; i += 30) {
    const page = list.slice(i, i + 30);
    const existing = await Promise.all(page.map(([path]) => req("/" + path)));
    const writes = page.flatMap(([path, expected], position) => {
      const previous = existing[position];
      if (!previous) return [write(path, expected)];
      if (canonical(previous.fields) !== canonical(expected)) throw new Error("Istniejący dokument odbiega od przygotowania: " + path);
      return [];
    });
    if (writes.length) await req(":commit", { writes });
  }
  for (let i = 0; i < list.length; i += 30) {
    await Promise.all(list.slice(i, i + 30).map(async ([path, expected]) => {
      const saved = await req("/" + path);
      if (!saved || canonical(saved.fields) !== canonical(expected)) throw new Error("Weryfikacja nie powiodła się: " + path);
    }));
  }
  for (const name of ["wzorcowanie","equipmentDevices","equipmentLinks"]) {
    const found = await req("/" + name + "?pageSize=300&mask.fieldPaths=revision");
    if (found?.nextPageToken || (found?.documents ?? []).length !== list.filter(([path]) => path.startsWith(name + "/")).length) {
      throw new Error("Nieoczekiwane dodatkowe dokumenty w kolekcji " + name + ".");
    }
  }
  cutover = await req("/" + config);
  if (cutover.fields.mode.stringValue !== "preparing") throw new Error("Zmienił się stan przygotowania.");
  await req(":commit", { writes: [write(config, fields({ ...current, mode: "active" }), { updateTime: cutover.updateTime })] });
  return current;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, mapFile] = process.argv.slice(2);
  const result = await stageEquipment(file, { host: process.env.FIRESTORE_EMULATOR_HOST, projectId: process.env.GCLOUD_PROJECT, mapFile });
  console.log("Zweryfikowano kopię i włączono v38 wyłącznie w emulatorze.", result);
}
