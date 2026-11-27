import test from "node:test";
import assert from "node:assert/strict";
import { matchWaterTasks, sixMeasurementsKey, waterCompleted, waterDateInYear, waterManualPrefix, waterPlan } from "../public/modules/water-plan.js";
import { createWaterStore } from "../public/modules/water-store.js";

const plan = waterPlan(2026);
test("first water plan includes the complete 100-control catalogue and preserves its revision", () => {
  assert.equal(waterPlan(2025), undefined);
  assert.equal(waterPlan(2027), plan);
  assert.equal(new Set(plan.controls.map(({ key }) => key)).size, 100);
  const totals = new Map();
  const matrices = new Map();
  for (const { category, matrix } of plan.controls) {
    totals.set(category, (totals.get(category) || 0) + 1);
    if (matrix) matrices.set(matrix, (matrices.get(matrix) || 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(totals), { Slepa: 17, Porownania: 17, Granice: 20, Probkobranie: 37, Archiwalna: 9 });
  assert.deepEqual(Object.fromEntries(matrices), { spo: 14, pod: 7, pow: 7, stud: 5, sc: 3, przem: 1 });
  assert.equal(plan.controls.filter(({ boundary }) => boundary === "dol").length, 8);
  assert.equal(plan.controls.filter(({ boundary }) => boundary === "gor").length, 12);
  assert.equal(waterDateInYear("2026-12-31", 2026), true);
  assert.equal(waterDateInYear("2026-12-31", 2027), false);
  assert.equal(waterDateInYear("2026-02-29", 2026), false);
});

test("both routes complete exactly one lower-limit control", () => {
  const entries = Array.from({ length: 6 }, (_, id) => [id, "2026-09-01"]);
  const six = Object.fromEntries(entries);
  assert.equal(waterCompleted(sixMeasurementsKey, { measurements: six }), true);
  assert.equal(waterCompleted(sixMeasurementsKey, { measurements: Object.fromEntries(entries.slice(1)) }), false);
  assert.equal(waterCompleted(sixMeasurementsKey, { doneDate: "2026-09-01" }), true);
  assert.equal(waterCompleted("siar-g-gor", { measurements: six }), false);
  assert.equal(waterCompleted("siar-t-gor", { measurements: six }), false);
});

test("legacy matching respects documented matrices, scopes and doubles", () => {
  const tasks = [
    { id: "archive", name: "Indeks Nadmanganianowy", category: "Archiwalna", doneDate: "2026-03-02" },
    { id: waterManualPrefix + "later", name: "Indeks Nadmanganianowy", category: "Archiwalna" },
    { id: "chlor", name: "Chlor wolny", category: "Slepa" },
    { id: "ground", name: "Azot Amonowy woda podziemna", category: "Probkobranie" },
    { id: "river", name: "Azot Azotanowy rzeka", category: "Probkobranie" },
    { id: "iron", name: "Żelazo popłuczne SUW Jutrzkowice", category: "Probkobranie" },
    { id: "old", name: "Mangan", doneDate: "2025-12-26" },
    { id: "new", name: "Mangan", category: "Archiwalna" },
  ];
  const before = structuredClone(tasks);
  let result = matchWaterTasks(tasks, [], 2026, plan.controls);
  assert.deepEqual([...result.linked], [["indeks-arch", tasks[0]], ["azotany-pow", tasks[4]]]);
  assert.equal(result.candidates.get("ground").control.key, "amon-stud");
  assert.equal(result.candidates.get("iron").control.key, "zelazo-przem");
  const link = { year: "2027", origin: "plan", itemKey: "amon-stud", legacyTaskId: "ground" };
  assert.equal(matchWaterTasks(tasks, [link], 2026, plan.controls).used.has("ground"), false);
  result = matchWaterTasks(tasks, [link], 2027, plan.controls);
  assert.equal(result.linked.get("amon-stud")?.id, "ground");
  assert.deepEqual(tasks, before);
});

test("going offline keeps a pending edit out of the write queue", async () => {
  const store = createWaterStore({}, { runTransaction() { assert.fail("offline transaction"); } }, () => false);
  await assert.rejects(store.save({}, {}), /Brak połączenia/);
});
