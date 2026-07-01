import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateBusinessDays,
  formatLocalDate,
  isDoneInYear,
  parseLocalDate,
  shiftCalendarMonth,
} from "../public/utils.js";

test("formatLocalDate uses the local calendar date", () => {
  assert.equal(formatLocalDate(new Date(2026, 6, 1, 23, 30)), "2026-07-01");
});

test("parseLocalDate rejects impossible dates", () => {
  assert.equal(parseLocalDate("2026-02-29"), null);
  assert.equal(formatLocalDate(parseLocalDate("2026-07-01")), "2026-07-01");
});

test("calculateBusinessDays counts weekdays inclusively", () => {
  assert.equal(calculateBusinessDays(new Date(2026, 6, 3), new Date(2026, 6, 6)), 2);
  assert.equal(calculateBusinessDays(new Date(2026, 6, 6), new Date(2026, 6, 6)), 1);
  assert.equal(calculateBusinessDays(new Date(2026, 6, 7), new Date(2026, 6, 6)), -1);
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
