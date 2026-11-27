import test from "node:test";
import assert from "node:assert/strict";
import { sixMeasurementsKey, waterAnnualId, waterCompleted, waterDateInYear, waterPlan } from "../public/modules/water-plan.js";
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

test("plan writes read only the annual record and retain any saved v32 provenance", async () => {
  const selection = { year: 2026, origin: "plan", itemKey: "indeks-arch", planVersion: plan.version };
  const target = waterAnnualId(selection.year, selection.origin, selection.itemKey);
  let record;
  const store = createWaterStore({}, {
    doc: (_db, _collection, id) => id,
    runTransaction: (_db, body) => body({
      get(id) {
        assert.equal(id, target);
        return { data: () => record };
      },
      set(id, data) {
        assert.equal(id, target);
        record = data;
      },
    }),
  }, () => true);
  const action = { kind: "finish", expectedDate: null, expectedNote: "", date: "2026-06-03", note: "Kontrola" };
  await store.save({ ...selection, legacyTaskId: "legacy-task" }, action);
  assert.equal(record.legacyTaskId, "");
  record.legacyTaskId = "saved-v32-link";
  const previous = { ...record };
  await store.save(selection, { ...action, expectedDate: record.doneDate, expectedNote: record.note, date: "2026-06-04" });
  assert.deepEqual(record, { ...previous, doneDate: "2026-06-04", revision: 2 });
});

test("going offline keeps a pending edit out of the write queue", async () => {
  const store = createWaterStore({}, { runTransaction() { assert.fail("offline transaction"); } }, () => false);
  await assert.rejects(store.save({}, {}), /Brak połączenia/);
});
