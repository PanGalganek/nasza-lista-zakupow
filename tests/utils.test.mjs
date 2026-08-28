import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChemicalAlerts,
  calculateCalendarDays,
  formatLocalDate,
  formatPolishDate,
  isDoneInYear,
  parseLocalDate,
  shiftCalendarMonth,
  suggestNextGroupValue,
} from "../public/utils.js";

test("formatLocalDate uses the local calendar date", () => {
  assert.equal(formatLocalDate(new Date(2026, 6, 1, 23, 30)), "2026-07-01");
});

test("formatPolishDate displays day, month, and year", () => {
  assert.equal(formatPolishDate("2026-09-16"), "16.09.2026");
  assert.equal(formatPolishDate(new Date(2026, 0, 5)), "05.01.2026");
  assert.equal(formatPolishDate(""), "--");
  assert.equal(formatPolishDate("błędna-data"), "--");
});

test("parseLocalDate rejects impossible dates", () => {
  assert.equal(parseLocalDate("2026-02-29"), null);
  assert.equal(formatLocalDate(parseLocalDate("2026-07-01")), "2026-07-01");
});

test("calculateCalendarDays counts calendar-day distance", () => {
  assert.equal(calculateCalendarDays(new Date(2026, 6, 3), new Date(2026, 6, 6)), 3);
  assert.equal(calculateCalendarDays(new Date(2026, 6, 6), new Date(2026, 6, 6)), 0);
  assert.equal(calculateCalendarDays(new Date(2026, 6, 7), new Date(2026, 6, 6)), -1);
  assert.equal(calculateCalendarDays(new Date(2026, 6, 7), null), null);
});

test("chemical alerts follow expiry, ordered state, backup, and quick-edit changes", () => {
  const today = new Date(2026, 7, 28);
  const expiring = {
    id: "old-bottle",
    name: "Wzorzec PO4",
    group: "II-3/06",
    expiry: "2026-09-16",
    ordered: false,
  };

  let alerts = buildChemicalAlerts([expiring], 40, today);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "warning");
  assert.equal(alerts[0].item.id, "old-bottle");

  alerts = buildChemicalAlerts([{ ...expiring, ordered: true }], 40, today);
  assert.equal(alerts[0].type, "ordered");

  alerts = buildChemicalAlerts([{ ...expiring, expiry: "2026-08-27", ordered: true }], 40, today);
  assert.equal(alerts[0].type, "expired");

  const replacement = { ...expiring, id: "new-bottle", group: "II-3/07", expiry: "2027-09-16" };
  alerts = buildChemicalAlerts([expiring, replacement], 40, today);
  assert.equal(alerts[0].type, "backup");
  assert.equal(alerts[0].item.id, "old-bottle");
  assert.equal(alerts[0].date, "2027-09-16");

  alerts = buildChemicalAlerts([replacement], 40, today);
  assert.deepEqual(alerts, []);
  assert.deepEqual(buildChemicalAlerts([{ ...replacement, expiry: "błędna-data" }], 40, today), []);
});

test("shiftCalendarMonth never skips February from the 31st", () => {
  const result = shiftCalendarMonth(new Date(2026, 0, 31), 1);
  assert.equal(formatLocalDate(result), "2026-02-01");
});

test("isDoneInYear handles empty and valid dates", () => {
  assert.equal(isDoneInYear(null, 2026), false);
  assert.equal(isDoneInYear("2026-05-10", 2026), true);
  assert.equal(isDoneInYear("2025-05-10", 2026), false);
});

test("suggestNextGroupValue proposes the next numeric position", () => {
  assert.equal(
    suggestNextGroupValue([{ group: "II-4/31" }, { group: "II-4/33" }], "II-4"),
    "II-4/34",
  );
  assert.equal(suggestNextGroupValue([{ group: "WZ/A" }], "WZ"), "WZ/");
  assert.equal(suggestNextGroupValue([{ group: "Bez numeru" }], "Bez numeru"), "Bez numeru");
});

