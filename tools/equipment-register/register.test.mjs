
import test from "node:test";
import assert from "node:assert/strict";
import {
  createExport, createRegister, duplicateNumbers, groupActivities, groupSources,
  moveSources, restoreDraft, reviseActivity, reviseGroup, setApproval,
} from "./model.js";
import { readDataset } from "./server.mjs";

function position(id, name, month, type, doneDate = null) {
  return { id, name, month, ...(type ? { type } : {}), doneDate };
}

const sources = [
  position("i46-a", "Pipeta automatyczna I-46/K/S (wzorcowanie)", "02", "", "2026-02-04"),
  position("i46-b", "Pipeta automatyczna I-46/K/S (sprawdzenie)", "08"),
  position("cpc-ph", "pH-metr CPC 105 I-52/K/S (sprawdzenie)", "04", "Sprawdzenie"),
  position("cpc-cond", "Konduktometr CPC 105 I-52/K/S (sprawdzenie)", "04", "Sprawdzenie"),
  position("spec-a", "Spektrofotometr (S - Mn)", "02", "Sprawdzenie"),
  position("spec-b", "Spektrofotometr (S - Mn)", "08", "Sprawdzenie", "2026-09-01"),
  position("thermo", "Termometry elektroniczne użytkowe I-17/S (sprawdzenie)", "02", "Sprawdzenie"),
  position("thermo-05", "Termometry elektroniczne wzorcowe I-17/05/W/S (sprawdzenie)", "06", "Sprawdzenie"),
  position("vapodest", "Vapodest (konserwacja przez firmę zewnętrzną)", "07"),
];

test("common numbers suggest groups, while same names alone do not establish equipment identity", () => {
  const { draft, proposals } = createRegister(sources);
  const group = id => draft.assignments[id].groupId;
  const kind = id => draft.assignments[id].kind;
  assert.equal(group("i46-a"), group("i46-b"));
  assert.equal(group("cpc-ph"), group("cpc-cond"));
  assert.notEqual(group("spec-a"), group("spec-b"));
  assert.notEqual(group("thermo"), group("thermo-05"));
  assert.equal(kind("i46-b"), "Sprawdzenie");
  assert.equal(kind("vapodest"), "Konserwacja");
  for (const key of ["i46-b", "cpc-ph", "spec-b", "thermo", "thermo-05", "vapodest"]) {
    assert.ok(proposals[key].notes.length > 0);
  }
  assert.equal(draft.groups.some(item => item.approved), false);
  const cpc = groupActivities(draft, groupSources(draft, sources).get(group("cpc-ph")));
  assert.deepEqual(cpc.map(activity => activity.label), ["Tor pH", "Tor przewodności"]);
});

test("moving, splitting and merging preserve the source positions and require approval again", () => {
  const original = structuredClone(sources);
  const { draft } = createRegister(sources);
  const pipette = draft.assignments["i46-a"].groupId;
  setApproval(draft, pipette, true);
  const newId = moveSources(draft, pipette, ["i46-b"], "");
  assert.equal(draft.groups.find(group => group.id === newId).number, "");
  assert.equal(draft.groups.find(group => group.id === pipette).approved, false);
  assert.equal(draft.assignments["i46-b"].groupId, newId);
  reviseActivity(draft, "i46-b", "Kalibracja", "Kontrola dozowania");
  reviseGroup(draft, newId, { name: "Pipeta kontrolna", number: "I-88" });
  moveSources(draft, newId, ["i46-b"], pipette);
  assert.equal(draft.groups.some(group => group.id === newId), false);
  assert.equal(draft.assignments["i46-b"].label, "Kontrola dozowania");
  assert.equal(draft.assignments["i46-b"].kind, "Kalibracja");
  assert.deepEqual(sources, original);
});

test("export includes incomplete verification and preserves every original and allocation once", () => {
  const { draft } = createRegister(sources);
  const dataset = { readTime: "2026-11-27T17:28:19Z", fingerprint: "copy-hash", sources };
  assert.equal(createExport(draft, dataset).summary.verifiedSourcePositions, 0);
  const probe = draft.groups.find(group => group.number !== "I-17").id;
  reviseGroup(draft, probe, { name: "Konflikt", number: " i-17 " });
  assert.equal(duplicateNumbers(draft).size, 2);
  assert.throws(() => setApproval(draft, probe, true), /powtórzony numer/);
  reviseGroup(draft, probe, { name: "Skorygowane", number: "X-15" });
  for (const group of draft.groups) setApproval(draft, group.id, true);
  const saved = restoreDraft(JSON.parse(JSON.stringify(draft)), sources);
  const exported = createExport(saved, dataset);
  assert.deepEqual(exported.originalPositions, sources);
  assert.deepEqual(exported.devices.flatMap(device => device.activities.flatMap(activity => activity.sourceIds)).sort(),
    sources.map(row => row.id).sort());
  assert.equal(exported.summary.completedSourcePositions, 2);
  delete saved.assignments["cpc-ph"];
  assert.throws(() => restoreDraft(saved, sources), /szkicu/);
});

test("a backup is read without unrelated collections or invented original field values", () => {
  const raw = {
    readTime: "2026-11-27T17:28:19Z",
    collections: {
      other: [{ fields: { private: true } }],
      wzorcowanie: [{
        name: "projects/demo-qa/databases/(default)/documents/wzorcowanie/src",
        fields: { name: { stringValue: "Waga" }, month: { stringValue: "01" },
          doneDate: { stringValue: "2026-02-03" }, timestamp: { integerValue: "100" } },
      }],
    },
  };
  const first = readDataset(raw);
  assert.deepEqual(first.sources, [position("src", "Waga", "01", "", "2026-02-03")]);
  assert.equal(readDataset(structuredClone(raw)).fingerprint, first.fingerprint);
  raw.collections.wzorcowanie[0].fields.doneDate.stringValue = "2026-02-29";
  assert.throws(() => readDataset(raw), /Nieprawidłowa pozycja/);
});
