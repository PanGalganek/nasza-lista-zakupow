import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from "firebase/firestore";

const projectId = "demo-nasza-lista-zakupow";
const allowedUid = "allowed-user";
let testEnvironment;

before(async () => {
  testEnvironment = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8"),
    },
  });
});

beforeEach(async () => {
  await testEnvironment.clearFirestore();
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "app_users", allowedUid), { active: true, role: "admin" });
  });
});

after(async () => {
  await testEnvironment.cleanup();
});

test("unauthenticated and unlisted users cannot read application data", async () => {
  const unauthenticated = testEnvironment.unauthenticatedContext().firestore();
  const unlisted = testEnvironment.authenticatedContext("unlisted-user").firestore();
  await assertFails(getDoc(doc(unauthenticated, "odczynniki", "one")));
  await assertFails(getDocs(collection(unlisted, "odczynniki")));
});

test("an active listed user can complete the chemical create, edit, order, and delete cycle", async () => {
  const database = testEnvironment.authenticatedContext(allowedUid).firestore();
  const reference = doc(database, "odczynniki", "valid");
  await assertSucceeds(setDoc(reference, {
    name: "Wzorzec testowy",
    group: "II-4/31",
    usage: "Test",
    received: "2026-07-01",
    expiry: "2027-07-01",
    timestamp: 1,
    ordered: false,
    category: "Wzorce",
  }));
  await assertSucceeds(updateDoc(reference, { group: "II-4/32", expiry: "2028-07-01" }));
  await assertSucceeds(updateDoc(reference, { ordered: true }));
  const updated = await assertSucceeds(getDoc(reference));
  assert.equal(updated.data().group, "II-4/32");
  assert.equal(updated.data().expiry, "2028-07-01");
  assert.equal(updated.data().ordered, true);
  await assertSucceeds(deleteDoc(reference));
  const deleted = await assertSucceeds(getDoc(reference));
  assert.equal(deleted.exists(), false);
});

test("schema validation rejects unexpected fields and invalid categories", async () => {
  const database = testEnvironment.authenticatedContext(allowedUid).firestore();
  const base = {
    name: "Wzorzec testowy",
    group: "II-4/31",
    usage: "Test",
    received: "2026-07-01",
    expiry: "2027-07-01",
    timestamp: 1,
    ordered: false,
  };
  await assertFails(setDoc(doc(database, "odczynniki", "extra"), { ...base, injected: "field" }));
  await assertFails(setDoc(doc(database, "odczynniki", "category"), { ...base, category: "Nieznana" }));
  await assertFails(setDoc(doc(database, "odczynniki", "invalid-date"), { ...base, received: "2026-99-99" }));
  await assertFails(setDoc(doc(database, "odczynniki", "february"), { ...base, expiry: "2026-02-30" }));
  await assertFails(setDoc(doc(database, "odczynniki", "april"), { ...base, expiry: "2026-04-31" }));
});

test("invalid edits are rejected without corrupting an existing chemical", async () => {
  const database = testEnvironment.authenticatedContext(allowedUid).firestore();
  const reference = doc(database, "odczynniki", "protected");
  await assertSucceeds(setDoc(reference, {
    name: "Wzorzec testowy",
    group: "II-4/31",
    usage: "Test",
    received: "2026-07-01",
    expiry: "2027-07-01",
    timestamp: 1,
    ordered: false,
    category: "Wzorce",
  }));
  await assertFails(updateDoc(reference, { name: "" }));
  await assertFails(updateDoc(reference, { ordered: "tak" }));
  await assertFails(updateDoc(reference, { expiry: "2026-11-31" }));
  const unchanged = await assertSucceeds(getDoc(reference));
  assert.equal(unchanged.data().name, "Wzorzec testowy");
  assert.equal(unchanged.data().ordered, false);
  assert.equal(unchanged.data().expiry, "2027-07-01");
});

test("only active admin and operator access records authorize application data", async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "app_users", "operator-user"), { active: true, role: "operator" });
    await setDoc(doc(context.firestore(), "app_users", "inactive-user"), { active: false, role: "admin" });
    await setDoc(doc(context.firestore(), "app_users", "unknown-role"), { active: true, role: "viewer" });
  });
  const operator = testEnvironment.authenticatedContext("operator-user").firestore();
  const inactive = testEnvironment.authenticatedContext("inactive-user").firestore();
  const unknownRole = testEnvironment.authenticatedContext("unknown-role").firestore();
  const data = {
    name: "Odczynnik",
    group: "VI-1/01",
    usage: "Test",
    received: "2026-08-28",
    expiry: "2027-08-28",
    timestamp: 1,
    ordered: false,
    category: "Odczynniki",
  };
  await assertSucceeds(setDoc(doc(operator, "odczynniki", "operator-write"), data));
  await assertFails(setDoc(doc(inactive, "odczynniki", "inactive-write"), data));
  await assertFails(setDoc(doc(unknownRole, "odczynniki", "unknown-write"), data));
});

test("legacy task shape remains updatable", async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "harmonogram", "legacy"), {
      name: "Chrom",
      lab: "scieki",
      doneDate: "2025-12-26",
      lastDoneYear: null,
      timestamp: 1,
    });
  });
  const database = testEnvironment.authenticatedContext(allowedUid).firestore();
  await assertSucceeds(updateDoc(doc(database, "harmonogram", "legacy"), { doneDate: "2026-07-01" }));
});

test("unknown collections and other access records are denied", async () => {
  const database = testEnvironment.authenticatedContext(allowedUid).firestore();
  await assertFails(setDoc(doc(database, "unknown", "one"), { value: true }));
  await assertFails(getDoc(doc(database, "app_users", "another-user")));
});
