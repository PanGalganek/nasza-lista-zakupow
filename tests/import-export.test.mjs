import test from "node:test";
import assert from "node:assert/strict";
import {
  chemicalsToCsv,
  cleanChemicalName,
  createChemicalBackup,
  parseExpiryDate,
  rowsToChemicalDrafts,
} from "../public/import-export.js";

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
