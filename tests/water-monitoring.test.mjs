import test from "node:test";
import assert from "node:assert/strict";
import { waterAnnualId, waterCompleted, waterDateInYear, waterPlan, waterSamplingLabel, waterUsesMeasurements } from "../public/modules/water-plan.js";
import { createWaterStore } from "../public/modules/water-store.js";

const plan = waterPlan(2026);
test("the revised water catalogue covers 101 controls in 17 methods and keeps the original revisions", () => {
  assert.equal(waterPlan(2025), undefined);
  assert.equal(waterPlan(2027), plan);
  assert.equal(waterPlan(2028), plan);
  assert.equal(plan.methods.length, 17);
  assert.equal(new Set(plan.methods.map(({ key }) => key)).size, 17);
  assert.equal(new Set(plan.controls.map(({ key }) => key)).size, 101);
  const totals = new Map();
  const matrices = new Map();
  for (const { category, matrix } of plan.controls) {
    totals.set(category, (totals.get(category) || 0) + 1);
    if (matrix) {
      const group = waterSamplingLabel(matrix).split(" – ")[0];
      matrices.set(group, (matrices.get(group) || 0) + 1);
    }
  }
  assert.deepEqual(Object.fromEntries(totals), { Slepa: 17, Porownania: 17, Granice: 20, Probkobranie: 38, Archiwalna: 9 });
  assert.deepEqual(Object.fromEntries(matrices), {
    "Woda do spożycia": 14, "Woda podziemna": 12, "Woda powierzchniowa": 7, "Ścieki": 5,
  });
  assert.deepEqual(plan.controls.filter(({ planVersion }) => planVersion !== "woda-2026.1").map(({ key }) => key), ["przewod-sc"]);
  assert.equal(waterSamplingLabel("przem"), "Ścieki – SUW Jutrzkowicka");
  assert.equal(plan.methods.find(({ key }) => key === "przewod").approvedOn, "2026-09-16");
  assert.deepEqual(plan.controls.filter(({ method }) => method === "przewod").map(({ key }) => key),
    ["przewod-slepa", "przewod-por", "przewod-spo", "przewod-stud", "przewod-pow", "przewod-sc"]);
  assert.equal(plan.controls.filter(({ boundary }) => boundary === "dol").length, 8);
  assert.equal(plan.controls.filter(({ boundary }) => boundary === "gor").length, 12);
  assert.equal(waterDateInYear("2026-12-31", 2026), true);
  assert.equal(waterDateInYear("2026-12-31", 2027), false);
  assert.equal(waterDateInYear("2026-02-29", 2026), false);
});

test("each gravimetric sulphate limit completes independently with six measurements or a saved annual confirmation", () => {
  const entries = Array.from({ length: 6 }, (_, id) => [id, "2026-09-01"]);
  const six = Object.fromEntries(entries);
  const five = Object.fromEntries(entries.slice(1));
  const measuredKeys = plan.controls.filter(({key}) => waterUsesMeasurements(key)).map(({key}) => key);
  assert.deepEqual(measuredKeys, ["siar-g-dol", "siar-g-gor"]);
  for (const key of measuredKeys) {
    assert.equal(waterCompleted(key, { measurements: six }), true);
    assert.equal(waterCompleted(key, { measurements: five }), false);
    assert.equal(waterCompleted(key, { measurements: five, doneDate: "2026-09-01" }), true);
    assert.equal(waterCompleted(key, undefined), false);
  }
  assert.equal(waterCompleted("siar-t-gor", { measurements: six }), false);
});

test("plan writes read only the annual record and retain any saved v32 provenance", async () => {
  const selection = { year: 2026, origin: "plan", itemKey: "indeks-arch", planVersion: "woda-2026.1" };
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
