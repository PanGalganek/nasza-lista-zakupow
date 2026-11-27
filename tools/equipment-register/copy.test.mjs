import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyCandidates, copyDraft } from "./copy-model.js";
import { emulatorProject, emulatorStore } from "./emulator-store.mjs";

const activity = (id, active = true) => ({ id, kind: "Sprawdzenie", label: "", active });
const term = (deviceId, activityId, month, execution = {}) => ({ id: randomUUID(), deviceId, activityId, month, ...execution });
const envelope = (revision, command) => ({ revision, operationId: randomUUID(), command });

test("a copy retains only active planned slots, clears execution metadata and uses new IDs", () => {
  const equipment = {
    active: { status: "active", activities: [activity("a1"), activity("a2", false)] },
    withdrawn: { status: "withdrawn", activities: [activity("a1")] },
  };
  const completed = term("active", "a1", 4, { doneDate: "2026-05-08", doneNotes: "Zeszyt 2" });
  const inactive = term("active", "a2", 5);
  const withdrawn = term("withdrawn", "a1", 6);
  const missing = term("missing", "a1", 7);
  const pending = term("active", "a1", 11);
  const approved = { entries: [completed, inactive, withdrawn, missing, pending] };
  const before = structuredClone(approved);
  assert.deepEqual(copyCandidates(approved, equipment).map(row => row.id), [completed.id, pending.id]);
  const draft = copyDraft(approved, equipment, [completed.id], randomUUID);
  assert.equal(draft.approved, null);
  const [entry] = draft.draft.entries;
  assert.notEqual(entry.id, completed.id);
  assert.deepEqual(entry, { id: entry.id, deviceId: "active", activityId: "a1", month: 4, doneDate: null });
  assert.deepEqual(approved, before);
  assert.throws(() => copyDraft(approved, equipment, [pending.id, pending.id], randomUUID), /tylko raz/);
  assert.throws(() => copyDraft(approved, equipment, [], randomUUID), /przynajmniej jeden/);
  assert.throws(() => copyDraft(approved, equipment, [inactive.id], randomUUID), /niedostępna/);
  assert.throws(() => copyDraft(null, equipment, [completed.id], randomUUID), /zatwierdzonym/);
  const duplicateSlot = term("active", "a1", 11);
  assert.throws(() => copyDraft({ entries: [pending, duplicateSlot] }, equipment, [pending.id, duplicateSlot.id], randomUUID), /jeden termin/);
});

const sources = [
  { id: "one", name: "Pipeta I-1", month: "02", doneDate: null },
  { id: "two", name: "Miernik I-2", month: "04", doneDate: null },
];
const options = { skip: process.env.GCLOUD_PROJECT !== emulatorProject };

async function fixture() {
  const dataset = { fingerprint: "copy-test-" + randomUUID(), sources };
  const first = emulatorStore(dataset);
  const second = emulatorStore(dataset);
  const reg = await first.load();
  const [a, b] = Object.values(reg.state.equipment);
  const entries = [term(a.id, a.activities[0].id, 2), term(a.id, a.activities[0].id, 5), term(b.id, b.activities[0].id, 8)];
  const plan = await first.savePlan(2026, envelope(0, { action: "approve", entries }));
  return { dataset, first, second, reg, a, b, entries, plan };
}

const command = (sourceYear, sourceRevision, registryRevision, selectedIds) =>
  ({ action: "copy", sourceYear, sourceRevision, registryRevision, selectedIds });

test("2026 to 2027 to 2028 preserves the source and allows the copied draft to be edited and approved", options, async () => {
  const { first, second, reg, a, b, entries, plan } = await fixture();
  const original = await first.savePlan(2026, envelope(plan.revision, { action: "complete", entryId: entries[0].id,
    doneDate: "2026-03-21", doneNotes: "Tylko w 2026" }));
  const updated = await second.save(envelope(reg.revision, { action: "status", deviceId: b.id, status: "withdrawn" }));
  await assert.rejects(first.savePlan(2027, envelope(0, command(2026, original.revision, updated.revision, [entries[2].id]))), /niedostępna/);
  const copied = await first.savePlan(2027, envelope(0, command(2026, original.revision, updated.revision, [entries[0].id, entries[1].id])));
  assert.equal(copied.state.approved, null);
  assert.deepEqual(copied.state.draft.entries.map(row => row.month), [2, 5]);
  assert.ok(copied.state.draft.entries.every(row => row.deviceId === a.id && !row.doneDate && !Object.hasOwn(row, "doneNotes")));
  assert.equal(new Set([...entries, ...copied.state.draft.entries].map(row => row.id)).size, 5);
  const draft = copied.state.draft.entries.map(row => row.month === 2 ? { ...row, month: 3 } : row);
  const approved = await second.savePlan(2027, envelope(copied.revision, { action: "approve", entries: draft }));
  const execution = await second.savePlan(2027, envelope(approved.revision, { action: "complete", entryId: draft[0].id, doneDate: "2026-10-02" }));
  const third = await first.savePlan(2028, envelope(0, command(2027, execution.revision, updated.revision, [draft[0].id])));
  assert.equal(third.state.draft.entries[0].month, 3);
  assert.equal(third.state.draft.entries[0].doneDate, null);
  assert.notEqual(third.state.draft.entries[0].id, draft[0].id);
  assert.deepEqual((await first.loadPlan(2026)).state, original.state);
  assert.deepEqual((await first.loadPlan(2027)).state, execution.state);
  assert.deepEqual(await first.loadHistory(2028), []);
  assert.equal((await first.loadHistory(2026))[0].after.notes, "Tylko w 2026");
  assert.notEqual((await first.loadHistory(2027))[0].entryId, entries[0].id);
});

test("drafts and approved plans are protected, including empty ones and retries", options, async () => {
  const { first, second, reg, entries, plan } = await fixture();
  const body = command(2026, plan.revision, reg.revision, [entries[0].id]);
  await assert.rejects(first.savePlan(2026, envelope(plan.revision, body)), /istnieje już|różne lata/);
  const existingDraft = await first.savePlan(2027, envelope(0, { action: "draft", entries: [] }));
  const existingPlan = await second.savePlan(2028, envelope(0, { action: "approve", entries: [] }));
  for (const [year, existing] of [[2027, existingDraft], [2028, existingPlan]]) {
    await assert.rejects(first.savePlan(year, envelope(existing.revision, body)), /istnieje już/);
    assert.deepEqual((await first.loadPlan(year)).state, existing.state);
  }
  const retry = envelope(0, body);
  const outcomes = await Promise.all([first.savePlan(2029, retry), second.savePlan(2029, retry)]);
  assert.deepEqual(outcomes[0].state, outcomes[1].state);
  assert.equal((await first.loadPlan(2029)).revision, 1);
  const races = await Promise.allSettled([first.savePlan(2030, envelope(0, body)), second.savePlan(2030, envelope(0, body))]);
  assert.equal(races.filter(row => row.status === "fulfilled").length, 1);
  assert.match(races.find(row => row.status === "rejected").reason.message, /istnieje już/);
  assert.equal((await first.loadPlan(2030)).state.draft.entries.length, 1);
});

test("the commit verifies source and registry versions atomically even after they were read", options, async t => {
  const { first, second, reg, a, entries, plan } = await fixture();
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  const interleave = (year, change) => {
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith(":commit") && options?.body) {
        const writes = JSON.parse(options.body).writes;
        if (writes.some(write => write.verify) && writes.some(write => write.update?.name.endsWith("/plany/" + year))) {
          await change();
        }
      }
      return fetch(url, options);
    };
  };
  interleave(2027, () => second.savePlan(2026, envelope(plan.revision,
    { action: "approve", entries: [{ ...entries[0], month: 4 }, ...entries.slice(1)] })));
  await assert.rejects(first.savePlan(2027, envelope(0, command(2026, plan.revision, reg.revision, [entries[0].id]))), /Odśwież podgląd/);
  assert.equal((await first.loadPlan(2027)).revision, 0);
  const latest = await first.loadPlan(2026);
  interleave(2028, () => second.save(envelope(reg.revision, { action: "status", deviceId: a.id, status: "withdrawn" })));
  await assert.rejects(first.savePlan(2028, envelope(0, command(2026, latest.revision, reg.revision, [entries[0].id]))), /Odśwież podgląd/);
  assert.equal((await first.loadPlan(2028)).revision, 0);
});
