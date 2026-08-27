import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyChemicalDrafts,
  chemicalsToCsv,
  cleanChemicalName,
  createChemicalBackup,
  parseExpiryDate,
  rowsToChemicalDrafts,
} from "../public/import-export.js";

function chemical(overrides = {}) {
  return {
    id: "existing",
    category: "Wzorce",
    group: "II-3/06",
    name: "Wzorzec fosforanów",
    usage: "Oznaczanie fosforanów",
    received: "2025-01-10",
    expiry: "2026-09-16",
    ordered: false,
    ...overrides,
  };
}

function draft(overrides = {}) {
  const { id, ordered, ...value } = chemical(overrides);
  return { ...value, sourceName: value.name, warnings: [], importIndex: 0 };
}

test("expiry parser supports exact and month-only dates from the Word register", () => {
  assert.deepEqual(parseExpiryDate("ważny do 05.10.2025"), { value: "2025-10-05", precision: "day" });
  assert.deepEqual(parseExpiryDate("ważny do 03/2028"), { value: "2028-03-31", precision: "month" });
  assert.deepEqual(parseExpiryDate("ważny do 02.2027"), { value: "2027-02-28", precision: "month" });
  assert.deepEqual(parseExpiryDate("brak terminu"), { value: "", precision: "missing" });
});

test("chemical name omits lot and expiry metadata", () => {
  assert.equal(cleanChemicalName("Wzorzec barwy 500 Units ważny do 05.10.2025 nr lot. 844676"), "Wzorzec barwy 500 Units");
  assert.equal(cleanChemicalName("Residual Free Chlorine, Lot LRAE1141, ważny 30.04.2028"), "Residual Free Chlorine");
});

test("Word table rows map to editable chemical drafts and skip headers", () => {
  const drafts = rowsToChemicalDrafts([
    ["Lp.", "Grupa", "Nazwa", "Zastosowanie"],
    ["1.", "II-1/28", "Wzorzec barwy 500 Units ważny do 05.10.2025 nr lot. 844676", "Oznaczanie barwy"],
    ["2.", "II-17/11", "Total Kjeldahl Nitrogen ważny do 03.2027", "Oznaczanie TKN"],
  ], { category: "Wzorce", received: "2026-08-26" });

  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts[0], {
    name: "Wzorzec barwy 500 Units",
    group: "II-1/28",
    usage: "Oznaczanie barwy",
    received: "2026-08-26",
    expiry: "2025-10-05",
    category: "Wzorce",
    sourceName: "Wzorzec barwy 500 Units ważny do 05.10.2025 nr lot. 844676",
    warnings: [],
  });
  assert.equal(drafts[1].expiry, "2027-03-31");
  assert.match(drafts[1].warnings[0], /ostatni dzień/);
});

test("exports are compatible with Polish Excel and preserve backup metadata", () => {
  const items = [{ id: "abc", category: "Wzorce", group: "II-1/28", name: "Wzorzec, barwy", usage: "Test", received: "2026-08-26", expiry: "2027-01-01", ordered: false }];
  const csv = chemicalsToCsv(items);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /"Wzorzec, barwy"/);
  const backup = createChemicalBackup(items, "2026-08-26T12:00:00.000Z");
  assert.equal(backup.version, 1);
  assert.equal(backup.items[0].id, "abc");
});

test("unchanged rows are skipped automatically", () => {
  const [result] = classifyChemicalDrafts([draft()], [chemical()]);
  assert.equal(result.status, "unchanged");
  assert.equal(result.action, "skip");
  assert.equal(result.matchId, "existing");
  assert.deepEqual(result.changes, []);
});

test("same full group with a new expiry is proposed as an update", () => {
  const [result] = classifyChemicalDrafts([draft({ expiry: "2027-09-20" })], [chemical()]);
  assert.equal(result.status, "changed");
  assert.equal(result.action, "skip");
  assert.equal(result.matchId, "existing");
  assert.deepEqual(result.changes.map(({ field }) => field), ["expiry"]);
});

test("II-3/06 changing to II-3/07 is matched within the same base group", () => {
  const [result] = classifyChemicalDrafts([
    draft({ group: "II-3/07", expiry: "2027-09-20" }),
  ], [chemical()]);
  assert.equal(result.status, "changed");
  assert.equal(result.matchId, "existing");
  assert.equal(result.matchType, "family-name");
  assert.deepEqual(result.changes.map(({ field }) => field), ["group", "expiry"]);
});

test("exact rows are preserved before pairing a replacement in a multi-bottle family", () => {
  const existing = [
    chemical({ id: "old", group: "II-1/28", name: "Wzorzec barwy", expiry: "2025-10-05" }),
    chemical({ id: "current", group: "II-1/29", name: "Wzorzec barwy", expiry: "2026-11-20" }),
  ];
  const incoming = [
    draft({ importIndex: 0, group: "II-1/29", name: "Wzorzec barwy", expiry: "2026-11-20" }),
    draft({ importIndex: 1, group: "II-1/30", name: "Wzorzec barwy", expiry: "2027-12-01" }),
  ];
  const results = classifyChemicalDrafts(incoming, existing);
  assert.equal(results[0].status, "unchanged");
  assert.equal(results[0].matchId, "current");
  assert.equal(results[1].status, "changed");
  assert.equal(results[1].matchId, "old");
});

test("new and ambiguous rows never update an existing record automatically", () => {
  const [newResult] = classifyChemicalDrafts([
    draft({ group: "II-9/01", name: "Nowy wzorzec" }),
  ], [chemical()]);
  assert.equal(newResult.status, "new");
  assert.equal(newResult.action, "add");

  const [ambiguous] = classifyChemicalDrafts([
    draft({ group: "II-3/07", name: "Inna nazwa" }),
  ], [
    chemical({ id: "one", group: "II-3/05", name: "Pierwszy" }),
    chemical({ id: "two", group: "II-3/06", name: "Drugi" }),
  ]);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.action, "skip");
  assert.equal(ambiguous.matchId, undefined);
});
