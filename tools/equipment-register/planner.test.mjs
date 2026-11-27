import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { calendarDate, evolvePlan, planCounts, planRows } from "./plan-model.js";
import { emulatorProject, emulatorStore } from "./emulator-store.mjs";

const sources = [{ id: "original", name: "Pipeta", month: "02", doneDate: "2026-03-21" }];
const empty = { approved: null, draft: null };
const activity = { id: "a1", kind: "Sprawdzenie", label: "", active: true };
const device = { id: "r1", name: "Pipeta", number: "", status: "active", activities: [activity] };
const equipment = { r1: device };
const term = (month, changes = {}) => ({ id: randomUUID(), deviceId: "r1", activityId: "a1", month, ...changes });
const apply = (previous, action, entries, registry = equipment) => evolvePlan(previous, { action, entries }, registry);
const approve = entries => apply(empty, "approve", entries);

test("plans include equipment without a number and retain archived scheduled rows", () => {
  assert.equal(planRows(equipment, [], true).length, 1);
  const inactive = { r1: { ...device, status: "withdrawn" } };
  assert.deepEqual(planRows(inactive, [], true), []);
  assert.equal(planRows(inactive, [term(1)], false)[0].available, false);
  assert.throws(() => apply(empty, "draft", [term(1)], inactive), /nie są dostępne/);
  const jan = term(1);
  const state = apply(approve([jan]), "approve", [{ ...jan, month: 3 }], inactive);
  assert.equal(state.approved.entries[0].id, jan.id);
  assert.equal(state.approved.entries[0].month, 3);
});

test("a draft can add, move and cancel terms, leaving the approved plan intact until approval", () => {
  const jan = term(1);
  const feb = term(2);
  const approved = approve([jan, feb]);
  const mar = term(3);
  const draft = apply(approved, "draft", [{ ...jan, month: 5 }, mar]);
  assert.deepEqual(draft.approved, approved.approved);
  assert.deepEqual(planCounts(draft.draft.entries), { months: [0,0,1,0,1,0,0,0,0,0,0,0], total: 2, completed: 0 });
  const updated = apply(draft, "approve", draft.draft.entries);
  assert.equal(updated.draft, null);
  assert.deepEqual(updated.approved.entries.map(row => [row.id, row.month]), [[jan.id, 5], [mar.id, 3]]);
});

test("duplicate slots and identities, invalid months and unknown activities are rejected", () => {
  const jan = term(1);
  assert.throws(() => approve([jan, term(1)]), /jeden termin/);
  assert.throws(() => approve([jan, { ...jan, month: 2 }]), /powtórzony/);
  assert.throws(() => approve([term(13)]), /Nieprawidłowy/);
  assert.throws(() => approve([term(2, { activityId: "a99" })]), /nie są dostępne/);
  assert.throws(() => approve([term(2, { deviceId: "__proto__" })]), /nie są dostępne/);
});

test("the execution date stays independent of the planned month and cannot be injected or erased", () => {
  const jan = term(1, { doneDate: "2026-02-11" });
  const approved = approve([jan]);
  assert.equal(approved.approved.entries[0].doneDate, null);
  for (const invalid of ["2025-02-29", "2199-01-01"]) {
    assert.throws(() => evolvePlan(approved, { action: "complete", entryId: jan.id, doneDate: invalid }, equipment), /datę wykonania/);
  }
  const completed = evolvePlan(approved, { action: "complete", entryId: jan.id, doneDate: "2025-03-21" }, equipment);
  assert.deepEqual(completed.approved.entries[0], { ...jan, doneDate: "2025-03-21" });
  assert.throws(() => apply(completed, "approve", []), /pozostać/);
  assert.throws(() => apply(completed, "draft", [{ ...jan, month: 2 }]), /przesunąć/);
  assert.throws(() => evolvePlan(completed, { action: "complete", entryId: jan.id, doneDate: "2025-03-22" }, equipment), /bez daty/);
  assert.equal(apply(completed, "approve", [jan]).approved.entries[0].doneDate, "2025-03-21");
});

test("recording completion protects its original term even when a saved draft moves it", () => {
  const jan = term(1);
  const standalone = term(4);
  const drafted = apply(approve([jan]), "draft", [{ ...jan, month: 2 }, term(1), standalone]);
  const executed = evolvePlan(drafted, { action: "complete", entryId: jan.id, doneDate: "2026-03-21" }, equipment);
  assert.deepEqual(executed.draft.entries.map(row => [row.month, row.doneDate]), [[4, null], [1,"2026-03-21"]]);
});

test("the planner uses the Warsaw calendar at a year boundary", () => {
  assert.equal(calendarDate(new Date("2026-12-31T22:59:59Z")), "2026-12-31");
  assert.equal(calendarDate(new Date("2026-12-31T23:00:00Z")), "2027-01-01");
});

test("independent years, journal, registry changes and concurrent client writes in Firestore", {
  skip: process.env.GCLOUD_PROJECT !== emulatorProject,
}, async () => {
  const fingerprint = "plan-test-" + randomUUID();
  const first = emulatorStore({ fingerprint, sources });
  const second = emulatorStore({ fingerprint, sources });
  const original = structuredClone(sources);
  const reg = await first.load();
  const sourceDevice = Object.values(reg.state.equipment)[0];
  const entries = [1,2,3].map(month => term(month, { deviceId: sourceDevice.id, activityId: sourceDevice.activities[0].id }));
  const envelope = (revision, action, list) => ({ revision, operationId: randomUUID(), command: { action, entries: list } });
  const input = envelope(0, "draft", [entries[0]]);
  const races = await Promise.allSettled([first.savePlan(2026, input), second.savePlan(2026, envelope(0, "approve", [entries[1]])),
    first.savePlan(2027, envelope(0, "approve", [entries[1]])), second.savePlan(2028, envelope(0, "approve", [entries[2]]))]);
  assert.deepEqual(races.slice(2).map(result => result.status), ["fulfilled","fulfilled"]);
  assert.equal(races.slice(0,2).filter(result => result.status === "fulfilled").length, 1);
  assert.equal(races.slice(0,2).find(result => result.status === "rejected").reason.status, 409);
  const old = await first.loadPlan(2026);
  if (races[0].status === "fulfilled") assert.deepEqual((await second.savePlan(2026, input)).state, old.state);
  const amended = await first.savePlan(2026, envelope(old.revision, "approve", [entries[0]]));
  const complete = { revision: amended.revision, operationId: randomUUID(), command: { action: "complete", entryId: entries[0].id, doneDate: "2026-03-21" } };
  await second.savePlan(2026, complete);
  assert.equal((await first.loadPlan(2026)).state.approved.entries[0].doneDate, "2026-03-21");
  for (const [index, year] of [2027, 2028].entries()) {
    const plan = await first.loadPlan(year);
    assert.equal(plan.revision, 1);
    assert.equal(plan.state.approved.entries[0].month, index + 2);
    assert.equal(plan.state.approved.entries[0].doneDate, null);
  }
  const registry = await second.save({ revision: reg.revision, operationId: randomUUID(), command: { action: "status", deviceId: sourceDevice.id, status: "withdrawn" } });
  assert.equal(registry.revision, 1);
  assert.equal((await first.loadPlan(2026)).state.approved.entries[0].deviceId, sourceDevice.id);
  const url = "http://" + process.env.FIRESTORE_EMULATOR_HOST + "/v1/projects/" + emulatorProject
    + "/databases/(default)/documents/lokalneRejestrySprzetu/" + fingerprint + "/plany/2026/historia/" + complete.operationId;
  const history = await (await fetch(url, { headers: { Authorization: "Bearer owner" } })).json();
  assert.deepEqual(JSON.parse(history.fields.previous.stringValue), amended.state);
  assert.deepEqual(sources, original);
});
