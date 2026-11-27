import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { evolvePlan } from "./plan-model.js";
import { currentPeriod, deadlineWarnings, executionCounts, executionHistory, executionTiming, isOverdue } from "./execution-model.js";
import { emulatorProject, emulatorStore } from "./emulator-store.mjs";

const empty = { draft: null, approved: null };
const activity = { id: "a1", kind: "Sprawdzenie", label: "Przegląd", active: true };
const device = { id: "r1", name: "Pipeta", number: "I-1", status: "active", activities: [activity] };
const equipment = { r1: device };
const term = month => ({ id: randomUUID(), deviceId: "r1", activityId: "a1", month, doneDate: null });
const now = "2026-11-27T12:00:00Z";
const evolve = (state, command) => evolvePlan(state, command, equipment, now);
const approve = (state, entries) => evolve(state, { action: "approve", entries });

test("early and late execution do not move the planned month, and correction and reversal preserve the term", () => {
  const january = term(1);
  const november = term(11);
  const approved = approve(empty, [january, november]);
  const completed = evolve(approved, { action: "complete", entryId: january.id, doneDate: "2026-02-01", doneNotes: " Zeszyt 1 " });
  assert.equal(executionTiming(completed.approved.entries[0], 2026), "Po terminie");
  assert.equal(completed.approved.entries[0].doneNotes, "Zeszyt 1");
  const corrected = evolve(completed, { action: "correct", entryId: january.id, doneDate: "2025-12-27", doneNotes: "Zeszyt 2" });
  assert.equal(executionTiming(corrected.approved.entries[0], 2026), "Przed terminem");
  assert.equal(corrected.approved.entries[0].month, 1);
  assert.equal(approve(corrected, [january, november]).approved.entries[0].doneNotes, "Zeszyt 2");
  const reversed = evolve(corrected, { action: "undo", entryId: january.id });
  assert.deepEqual(reversed.approved.entries[0], january);
  assert.equal(isOverdue(reversed.approved.entries[0], 2026, { year: 2026, month: 11 }), true);
  assert.throws(() => evolve(reversed, { action: "correct", entryId: january.id, doneDate: now.slice(0, 10) }), /wykonany/);
  assert.throws(() => evolve(reversed, { action: "undo", entryId: january.id }), /wykonany/);
  assert.throws(() => evolve(reversed, { action: "complete", entryId: january.id, doneDate: "2026-12-01" }), /nie późniejszą/);
  assert.throws(() => evolve(reversed, { action: "complete", entryId: january.id, doneDate: "2026-11-12", doneNotes: "x".repeat(501) }), /500/);
});

test("warnings cross New Year and cancelled or moved terms only count in the active published plan", () => {
  const oldYear = term(11);
  const cancelled = term(10);
  const december = term(12);
  const moved = term(1);
  const january = term(1);
  const early = { ...term(1), doneDate: "2026-11-20" };
  const original = approve(empty, [oldYear, cancelled, december, moved]);
  const consulted = approve(original, [oldYear, { ...moved, month: 2 }, december]);
  const plans = [{ year: 2026, entries: consulted.approved.entries }, { year: 2027, entries: [january, early] }];
  assert.deepEqual(currentPeriod(new Date("2026-12-31T22:59:59Z")), { year: 2026, month: 12 });
  assert.deepEqual(currentPeriod(new Date("2026-12-31T23:00:00Z")), { year: 2027, month: 1 });
  const dec = deadlineWarnings(plans, { year: 2026, month: 12 });
  const jan = deadlineWarnings(plans, { year: 2027, month: 1 });
  assert.deepEqual(dec.current.map(row => row.id), [december.id]);
  assert.deepEqual(dec.overdue.map(row => row.id), [moved.id, oldYear.id]);
  assert.deepEqual(dec.upcoming.map(row => row.id), [january.id, early.id]);
  assert.deepEqual(dec.next, { year: 2027, month: 1 });
  assert.deepEqual(jan.current.map(row => row.id), [january.id]);
  assert.deepEqual(jan.overdue.map(row => row.id), [moved.id, oldYear.id, december.id]);
  assert.deepEqual(executionCounts(consulted.approved.entries), { total: 3, done: 0 });
  assert.deepEqual(executionCounts(plans[1].entries), { total: 2, done: 1 });
});

test("the older annual journal yields an exact execution event without attributing a year from a completion date", () => {
  const term1 = term(11);
  const initial = approve(empty, [term1]);
  const first = evolve(initial, { action: "complete", entryId: term1.id, doneDate: "2025-10-09" });
  const journal = [{ revision: 1, action: "approve", previous: empty },
    { revision: 2, action: "complete", previous: initial }, { revision: 3, action: "draft", previous: first }];
  const [event] = executionHistory(journal, first);
  assert.equal(event.after.date, "2025-10-09");
  assert.equal(event.month, 11);
  assert.equal(event.entryId, term1.id);
  assert.equal(event.before, null);
  assert.equal(Object.hasOwn(event, "year"), false);
});

test("execution, correction, reversal and journal survive another client editing and archiving equipment", {
  skip: process.env.GCLOUD_PROJECT !== emulatorProject,
}, async () => {
  const fingerprint = "execution-test-" + randomUUID();
  const sources = [{ id: "old", name: "Pipeta I-1", month: "02", doneDate: "2026-03-21" }];
  const backup = structuredClone(sources);
  const first = emulatorStore({ fingerprint, sources });
  const second = emulatorStore({ fingerprint, sources });
  const original = await first.load();
  const equipment = Object.values(original.state.equipment)[0];
  const item = { ...term(10), deviceId: equipment.id, activityId: equipment.activities[0].id };
  const other = { ...item, id: randomUUID(), month: 11 };
  const envelope = (revision, command) => ({ revision, operationId: randomUUID(), command });
  await first.savePlan(2026, envelope(0, { action: "approve", entries: [item, other] }));
  await second.savePlan(2027, envelope(0, { action: "approve", entries: [other] }));
  const completion = envelope(1, { action: "complete", entryId: item.id, doneDate: "2026-11-06", doneNotes: "Notatka" });
  const results = await Promise.allSettled([first.savePlan(2026, completion), second.savePlan(2026,
    envelope(1, { action: "draft", entries: [{ ...item, month: 3 }, other] }))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.status, 409);
  const state = await first.loadPlan(2026);
  const completed = results[0].status === "fulfilled" ? state : await first.savePlan(2026,
    envelope(state.revision, completion.command));
  assert.equal(completed.state.approved.entries[0].month, 10);
  assert.equal(completed.state.draft?.entries.find(row => row.id === item.id)?.month ?? 10, 10);
  await assert.rejects(second.savePlan(2026, envelope(completed.revision, { action: "approve", entries: [other] })), /musi pozostać/);
  const changed = await second.save(envelope(original.revision, { action: "upsert", deviceId: equipment.id, name: "Po korekcie",
    number: "I-9", notes: "", activities: equipment.activities }));
  await first.save(envelope(changed.revision, { action: "status", deviceId: equipment.id, status: "withdrawn" }));
  const corrected = await second.savePlan(2026, envelope(completed.revision, { action: "correct", entryId: item.id, doneDate: "2026-09-30", doneNotes: "Poprawka" }));
  const reversal = envelope(corrected.revision, { action: "undo", entryId: item.id });
  const undone = await first.savePlan(2026, reversal);
  assert.equal((await second.savePlan(2026, reversal)).revision, undone.revision);
  const history = await second.loadHistory(2026);
  assert.deepEqual(history.map(row => row.action), ["undo", "correct", "complete"]);
  assert.ok(history.every(row => row.deviceId === equipment.id && row.month === 10));
  assert.equal(history[0].before.notes, "Poprawka");
  assert.equal(history[1].before.notes, "Notatka");
  assert.equal(history[2].deviceName, equipment.name);
  assert.equal(history[1].deviceName, "Po korekcie");
  assert.equal(history[1].number, "I-9");
  const plans = await first.loadSchedule();
  assert.deepEqual(plans.map(plan => [plan.year, plan.entries.filter(row => row.doneDate).length]), [[2026,0],[2027,0]]);
  assert.deepEqual(await second.loadHistory(2027), []);
  assert.deepEqual(sources, backup);
});
