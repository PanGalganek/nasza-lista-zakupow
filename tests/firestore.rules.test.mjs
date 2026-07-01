import { after, before, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
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

test("an active listed user can create and read a valid chemical", async () => {
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
  await assertSucceeds(getDoc(reference));
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
