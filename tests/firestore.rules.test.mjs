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
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { createInventoryStore } from "../public/modules/inventory-store.js";
import { quantity } from "../public/modules/inventory-quantity.js";

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
  for (const inventory of ["magazyn_partie", "magazyn_operacje", "magazyn_receptury", "magazyn_metody", "magazyn_zamowienia", "magazyn_obliczenia"]) {
    await assertFails(getDoc(doc(unauthenticated, inventory, "one")));
    await assertFails(getDocs(collection(unlisted, inventory)));
  }
});

test("an active listed user can create, edit, order, and archive without deleting a chemical", async () => {
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
  await assertFails(deleteDoc(reference));
  await assertSucceeds(createInventoryStore(database, { collection, doc, runTransaction, serverTimestamp }).close("valid", "withdrawn"));
  assert.equal((await getDoc(reference)).exists(), true);
});

test("stock transactions preserve balances, reject concurrent overspending and retain immutable history", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const store = createInventoryStore(db, { collection, doc, runTransaction, serverTimestamp });
  const legacy = { name: "Odczynnik testowy", group: "A/01", usage: "", received: "", expiry: "", timestamp: 1, ordered: false };
  await setDoc(doc(db, "odczynniki", "legacy"), legacy);
  assert.equal((await getDoc(store.ref("stock", "legacy"))).exists(), false);
  await store.establish("legacy", quantity("500", "g"), "g", "opening");
  await assert.rejects(store.establish("legacy", 100, "g", "opening-again"), /już ustalony/);
  await store.receive([{ fields: { ...legacy, productId: "legacy", packageAmount: quantity("500", "g"), packageUnit: "g", lotNumber: "LOT001" }, initial: quantity("500", "g") }], "delivery");
  const request = { lotId: "legacy", productId: "legacy", unit: "g", quantity: quantity("10", "g") };
  await Promise.all([store.withdraw([request], { id: "same" }), store.withdraw([request], { id: "same" })])
    .catch((cause) => { throw new Error("Idempotent withdrawal failed", { cause }); });
  await assert.rejects(store.withdraw([{ ...request, quantity: quantity("20", "g") }], { id: "same" }), /Wcześniejszy zapis ma inne dane/);
  assert.equal((await getDoc(store.ref("stock", "legacy"))).data().balance, quantity("490", "g"));
  await store.reverse("same").catch((cause) => { throw new Error("Reversal failed", { cause }); });
  await store.reverse("same");
  assert.equal((await getDoc(store.ref("stock", "legacy"))).data().balance, quantity("500", "g"));
  const heavy = { ...request, quantity: quantity("400", "g") };
  const concurrent = await Promise.allSettled([store.withdraw([heavy], { id: "heavy-a" }), store.withdraw([heavy], { id: "heavy-b" })]);
  assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
  await assertFails(updateDoc(store.ref("stock", "legacy"), { balance: 1 }));
  await assertFails(deleteDoc(store.ref("events", "same")));
  await store.close("legacy", "used");
  assert.equal((await getDoc(store.ref("stock", "legacy"))).data().status, "used");
  assert.equal((await getDoc(doc(db, "odczynniki", "legacy"))).exists(), true);
});

test("an incorrect opening amount can be corrected without replacing the original operation", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const store = createInventoryStore(db, { collection, doc, runTransaction, serverTimestamp });
  const lot = doc(db, "odczynniki", "existing");
  const fields = { name: "Odczynnik testowy", group: "A/01", usage: "", received: "", expiry: "", timestamp: 1,
    ordered: false, packageAmount: quantity("100", "g"), packageUnit: "g" };
  await setDoc(lot, fields);
  const oldAmount = quantity("500", "g");
  const corrected = quantity("100", "g");
  await store.establish("existing", oldAmount, "g", "opening");
  await assertFails(updateDoc(store.ref("stock", "existing"), { initial: corrected, balance: corrected }));
  await Promise.all([
    store.correctOpening("existing", corrected, "opening", "fix"),
    store.correctOpening("existing", corrected, "opening", "fix"),
  ]);
  const read = async (kind, id) => (await getDoc(store.ref(kind, id))).data();
  assert.deepEqual(await read("stock", "existing"), { initial: corrected, balance: corrected, unit: "g", status: "active", lastEvent: "fix" });
  assert.equal((await read("events", "opening")).changes.existing.after, oldAmount);
  const adjustment = await read("events", "fix");
  assert.equal(adjustment.kind, "opening_correction");
  assert.equal(adjustment.details.sourceKind, "opening");
  assert.equal(adjustment.changes.existing.before, oldAmount);
  assert.equal(adjustment.changes.existing.after, corrected);
  assert.deepEqual((await getDoc(lot)).data(), fields);
  await assert.rejects(store.correctOpening("existing", quantity("110", "g"), "opening", "stale"), /Stan partii uległ zmianie/);
  await store.correctOpening("existing", quantity("95", "g"), "fix", "fix-again");
  const request = { lotId: "existing", productId: "existing", unit: "g", quantity: quantity("10", "g") };
  await store.withdraw([request], { id: "withdraw" });
  await store.reverse("withdraw");
  const fullStock = await read("stock", "existing");
  assert.equal(fullStock.initial, fullStock.balance);
  await assert.rejects(store.correctOpening("existing", corrected, fullStock.lastEvent, "too-late"), /przed pierwszym rozchodem/);
  await assertFails(runTransaction(db, async (tx) => {
    const target = store.ref("stock", "existing");
    tx.set(store.ref("events", "invalid"), {
      kind: "opening_correction", anchor: "existing", createdAt: serverTimestamp(),
      details: { intent: "a".repeat(64), previousId: fullStock.lastEvent, sourceKind: "opening" },
      changes: { existing: { ...adjustment.changes.existing, before: fullStock.balance } },
    });
    tx.set(target, { ...fullStock, initial: corrected, balance: corrected, lastEvent: "invalid" });
  }));
  assert.deepEqual(await read("stock", "existing"), fullStock);
});

test("correcting a new receipt keeps it within its package amount", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const store = createInventoryStore(db, { collection, doc, runTransaction, serverTimestamp });
  const packageAmount = quantity("500", "g");
  const fields = { name: "Odczynnik testowy", group: "A/01", usage: "", received: "", expiry: "", timestamp: 1,
    ordered: false, lotNumber: "TEST01", packageAmount, packageUnit: "g" };
  await store.receive([{ fields, initial: packageAmount }], "receipt");
  const receipt = (await getDoc(store.ref("events", "receipt"))).data();
  await assert.rejects(store.correctOpening(receipt.anchor, quantity("600", "g"), "receipt", "above-package"), /wielkości opakowania/);
  await store.correctOpening(receipt.anchor, quantity("100", "g"), "receipt", "smaller");
  const correction = (await getDoc(store.ref("events", "smaller"))).data();
  assert.equal(correction.details.sourceKind, "receipt");
  assert.equal(correction.changes[receipt.anchor].after, quantity("100", "g"));
});

test("multi-ingredient preparation is atomic and retains its recipe snapshot", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const store = createInventoryStore(db, { collection, doc, runTransaction, serverTimestamp });
  const chemicals = Array.from({ length: 8 }, (_, index) => `lot-${index}`);
  for (const chemical of chemicals) {
    await setDoc(doc(db, "odczynniki", chemical), { name: chemical, group: "", usage: "", expiry: "", received: "", timestamp: 1, ordered: false });
    await store.establish(chemical, quantity("500", "g"), "g");
  }
  const prep = { recipeId: "recipe", recipeName: "Przygotowanie testowe", recipeVersion: 1, volume: 250, methodId: "method",
    methodName: "Metoda testowa", baseVolume: 100, ingredients: [{ name: "Składnik testowy", unit: "g", quantity: quantity("25", "g") }], instruction: "" };
  const recipeReference = store.ref("recipes", "recipe");
  await setDoc(recipeReference, { name: prep.recipeName, baseVolume: 100, defaultVolume: 100, scalable: true, methods: ["method"],
    ingredients: [{ productId: chemicals[0], name: "Składnik testowy", unit: "g", quantity: quantity("10", "g") }], instruction: "", version: 1 });
  const plan = chemicals.map((id) => ({ productId: id, lotId: id, unit: "g", quantity: quantity("25", "g") }));
  await assert.rejects(store.withdraw([...plan.slice(0, 7), { ...plan[7], quantity: quantity("501", "g") }], { id: "blocked", preparation: prep }), /dostępność/);
  assert.equal((await getDoc(store.ref("stock", chemicals[0]))).data().balance, quantity("500", "g"));
  assert.equal((await getDoc(store.ref("events", "blocked"))).exists(), false);
  await store.withdraw(plan, { id: "prepare", preparation: prep });
  for (const chemical of chemicals) assert.equal((await getDoc(store.ref("stock", chemical))).data().balance, quantity("475", "g"));
  await updateDoc(recipeReference, { name: "Zmieniona receptura", version: 2 });
  assert.equal((await getDoc(store.ref("events", "prepare"))).data().details.recipeVersion, 1);
  assert.equal((await getDoc(store.ref("events", "prepare"))).data().details.recipeName, prep.recipeName);
  await store.reverse("prepare");
  assert.equal((await getDoc(store.ref("stock", chemicals[7]))).data().balance, quantity("500", "g"));
  await store.withdraw([], { id: "untracked-preparation", preparation: { ...prep, ingredients: [{ name: "Woda", productId: "", unit: "ml", quantity: quantity("50", "ml") }] } });
  await store.reverse("untracked-preparation");
  assert.equal((await getDoc(store.ref("events", "reverse_untracked-preparation"))).exists(), true);
});

test("an existing linked product remains a root while legacy lots can be attached", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const store = createInventoryStore(db, { collection, doc, runTransaction, serverTimestamp });
  const fields = { name: "Partia testowa", group: "", usage: "", expiry: "", received: "", timestamp: 1, ordered: false };
  const chemical = (id) => doc(db, "odczynniki", id);
  await Promise.all(["root", "lot", "other"].map((id) => setDoc(chemical(id), fields)));
  await store.linkLot("lot", { productId: "root" });
  assert.equal((await getDoc(chemical("root"))).data().productId, "root");
  await assertFails(updateDoc(chemical("root"), { productId: "lot" }));
  await assert.rejects(store.linkLot("other", { productId: "lot" }), /główną pozycję/);
});

test("expired inventory can be withdrawn without recording analytical consumption", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const store = createInventoryStore(db, { collection, doc, runTransaction, serverTimestamp });
  await setDoc(doc(db, "odczynniki", "expired"), { name: "Partia testowa", group: "", usage: "", expiry: "2020-01-01", received: "", timestamp: 1, ordered: false });
  await store.establish("expired", quantity("5", "g"), "g");
  await assert.rejects(store.close("expired", "used"), /wycofaj/);
  await store.close("expired", "withdrawn", "retired");
  const event = (await getDoc(store.ref("events", "retired"))).data();
  assert.equal(event.kind, "withdrawn");
  assert.equal(event.changes.expired.before, quantity("5", "g"));
  assert.equal(event.changes.expired.after, 0);
});

test("bulk receipts record all eight new parties and their own opening amounts", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const store = createInventoryStore(db, { collection, doc, runTransaction, serverTimestamp });
  const fields = { name: "Przyjęcie testowe", group: "", usage: "", expiry: "", received: "", timestamp: 1, ordered: false,
    packageUnit: "g", packageAmount: quantity("500", "g") };
  await store.receive(Array.from({ length: 8 }, (_, index) => ({
    fields: { ...fields, lotNumber: `LOT-${index}` }, initial: quantity(index === 0 ? "400" : "500", "g"),
  })), "bulk");
  const events = (await getDoc(store.ref("events", "bulk"))).data();
  assert.equal(Object.keys(events.changes).length, 8);
  assert.equal(Object.values(events.changes).find(({ number }) => number === "LOT-0").after, quantity("400", "g"));
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
