
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { moveSources } from "./model.js";
import { makeInitialRegistry, evolveRegistry, needsDetails, scheduleEquipment } from "./registry-model.js";
import { emulatorStore, emulatorProject } from "./emulator-store.mjs";

const sources = [
  { id: "first", name: "Pipeta I-46/K/S (sprawdzenie)", type: "Sprawdzenie", month: "01", doneDate: "2026-02-04" },
  { id: "second", name: "Pipeta I-46/K/S (wzorcowanie)", month: "04", doneDate: null },
  { id: "third", name: "Minutnik", type: "Sprawdzenie", month: "05", doneDate: null },
];
const saveDevice = (device, updates = {}) => ({
  action: "upsert", deviceId: device?.id, name: device?.name ?? "Nowy sprzęt", number: device?.number ?? "",
  notes: device?.notes ?? "", activities: device?.activities ?? [], ...updates,
});
const smallActivity = kind => ({ id: null, kind, label: "", active: true });

test("a provisional device without a number is available in the schedule catalogue", () => {
  const state = makeInitialRegistry(sources);
  const id = state.mapping.assignments.third.groupId;
  assert.equal(needsDetails(state.equipment[id]), true);
  assert.ok(scheduleEquipment(state.equipment).some(device => device.id === id && !device.number));
});

test("rename, custom activity and withdraw/restore preserve the device and activity identifiers", () => {
  const original = structuredClone(sources);
  const initial = makeInitialRegistry(sources);
  const id = initial.mapping.assignments.first.groupId;
  const device = initial.equipment[id];
  const edits = device.activities.map((row,index) => index === 0 ? { ...row, kind: "Serwis zewnętrzny" } : row);
  const changed = evolveRegistry(initial, saveDevice(device, {
    name: "Pipeta kontrolna", number: "", notes: "Numer do ustalenia", activities: [...edits, smallActivity("Przegląd specjalny")],
  }), sources, randomUUID()).state;
  assert.equal(changed.equipment[id].name, "Pipeta kontrolna");
  assert.deepEqual(changed.equipment[id].activities.slice(0,2).map(row=>row.id), device.activities.map(row=>row.id));
  assert.equal(changed.mapping.assignments.first.groupId, id);
  assert.equal(changed.mapping.assignments.first.kind, "Serwis zewnętrzny");
  const archived = evolveRegistry(changed, {action:"status", deviceId:id, status:"withdrawn"}, sources,randomUUID()).state;
  assert.ok(!scheduleEquipment(archived.equipment).some(row => row.id === id));
  const reopened = evolveRegistry(archived, {action:"status", deviceId:id, status:"active"}, sources,randomUUID()).state;
  assert.deepEqual(reopened.equipment[id], changed.equipment[id]);
  assert.deepEqual(sources, original);
});

test("group merge retains the previous equipment card and its activities in the archive", () => {
  const initial = makeInitialRegistry(sources);
  const mapping = structuredClone(initial.mapping);
  const old = mapping.assignments.third.groupId;
  const target = mapping.assignments.first.groupId;
  moveSources(mapping, old, ["third"], target);
  const merged = evolveRegistry(initial, {action:"grouping", mapping}, sources,randomUUID()).state;
  assert.equal(merged.equipment[old].status, "withdrawn");
  assert.equal(merged.equipment[old].mergedInto, target);
  assert.deepEqual(merged.equipment[old].activities, initial.equipment[old].activities);
  assert.equal(merged.mapping.assignments.third.groupId, target);
  assert.equal(Object.keys(merged.mapping.assignments).length, sources.length);
});

test("group split assigns a new id and leaves the original device and its activities intact", () => {
  const initial = makeInitialRegistry(sources);
  const mapping = structuredClone(initial.mapping);
  const kept = mapping.assignments.first.groupId;
  const divided = moveSources(mapping, kept, ["second"], "");
  const next = evolveRegistry(initial, {action:"grouping", mapping}, sources,randomUUID()).state;
  assert.notEqual(divided, kept);
  assert.equal(next.equipment[kept].status, "active");
  assert.deepEqual(next.equipment[kept].activities, initial.equipment[kept].activities);
  assert.equal(next.equipment[divided].number, "");
  assert.equal(next.mapping.assignments.first.groupId, kept);
  assert.equal(next.mapping.assignments.second.groupId, divided);
});

test("emulator rejects concurrent stale saves and retains the journal and idempotent operation", {
  skip: process.env.GCLOUD_PROJECT !== emulatorProject,
}, async () => {
  const dataset = { fingerprint: "test-" + randomUUID(), sources };
  const client = emulatorStore(dataset);
  const other = emulatorStore(dataset);
  const original = await client.load();
  const inputs = ["Miernik pierwszy", "Miernik drugi"].map(name => ({
    revision: original.revision, operationId: randomUUID(),
    command: saveDevice(undefined, { name, activities: [smallActivity("Badanie własne")] }),
  }));
  const results = await Promise.allSettled([client.save(inputs[0]), other.save(inputs[1])]);
  const kept = results.findIndex(result => result.status === "fulfilled");
  assert.ok(kept >= 0);
  assert.equal(results[1-kept].reason.status, 409);
  const snapshot = await client.load();
  assert.equal(snapshot.revision, 1);
  assert.equal(Object.keys(snapshot.state.equipment).length, Object.keys(original.state.equipment).length + 1);
  assert.deepEqual(await other.save(inputs[kept]), snapshot);
  const url = "http://" + process.env.FIRESTORE_EMULATOR_HOST + "/v1/projects/" + emulatorProject +
    "/databases/(default)/documents/lokalneRejestrySprzetu/" + dataset.fingerprint + "/historia/" + inputs[kept].operationId;
  const entry = await (await fetch(url,{ headers:{Authorization:"Bearer owner"} })).json();
  assert.deepEqual(JSON.parse(entry.fields.previous.stringValue), original.state);
});

test("emulator access requires the demo project and explicit IPv4 loopback", () => {
  assert.throws(() => emulatorStore({}, { GCLOUD_PROJECT: "nasza-lista-zakupow", FIRESTORE_EMULATOR_HOST: "127.0.0.1:18138" }), /lokalnym emulatorem/);
  assert.throws(() => emulatorStore({}, { GCLOUD_PROJECT: emulatorProject, FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com:443" }), /lokalnym emulatorem/);
});
