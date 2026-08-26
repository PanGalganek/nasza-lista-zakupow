import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateCalendarDays,
  formatLocalDate,
  isDoneInYear,
  parseLocalDate,
  shiftCalendarMonth,
  suggestNextGroupValue,
} from "../public/utils.js";

test("formatLocalDate uses the local calendar date", () => {
  assert.equal(formatLocalDate(new Date(2026, 6, 1, 23, 30)), "2026-07-01");
});

test("parseLocalDate rejects impossible dates", () => {
  assert.equal(parseLocalDate("2026-02-29"), null);
  assert.equal(formatLocalDate(parseLocalDate("2026-07-01")), "2026-07-01");
});

test("calculateCalendarDays counts calendar-day distance", () => {
  assert.equal(calculateCalendarDays(new Date(2026, 6, 3), new Date(2026, 6, 6)), 3);
  assert.equal(calculateCalendarDays(new Date(2026, 6, 6), new Date(2026, 6, 6)), 0);
  assert.equal(calculateCalendarDays(new Date(2026, 6, 7), new Date(2026, 6, 6)), -1);
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

