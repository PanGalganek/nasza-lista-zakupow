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
import { createWaterStore } from "../public/modules/water-store.js";
import { waterAnnualId, waterPlan } from "../public/modules/water-plan.js";
import { randomUUID } from "node:crypto";

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

test("editing recipe contents and managing its methods preserve each other's fields", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const recipe = doc(db, "magazyn_receptury", "shared");
  const ingredients = [{ name: "Woda", productId: "", unit: "ml", quantity: quantity("100", "ml") }];
  await assertSucceeds(setDoc(recipe, {
    name: "Roztwór demonstracyjny", baseVolume: 100, defaultVolume: 100, scalable: true,
    methods: ["a", "b"], ingredients, instruction: "", version: 1,
  }));
  await assertSucceeds(updateDoc(recipe, { instruction: "Zmieniona instrukcja", version: 2 }));
  assert.deepEqual((await getDoc(recipe)).data().methods, ["a", "b"]);
  await assertSucceeds(updateDoc(recipe, { methods: ["a", "c"], version: 3 }));
  await assertFails(updateDoc(recipe, { instruction: "Konkurencyjna zmiana", version: 3 }));
  await assertFails(updateDoc(recipe, { methods: [], version: 4 }));
  const record = (await getDoc(recipe)).data();
  assert.equal(record.instruction, "Zmieniona instrukcja");
  assert.deepEqual(record.ingredients, ingredients);
  assert.deepEqual(record.methods, ["a", "c"]);
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

test("optional purchasing data is validated and stays on the root when receiving new lots", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const store = createInventoryStore(db, { collection, doc, runTransaction, serverTimestamp });
  const packageAmount = quantity("500", "g");
  const fields = { name: "Wzorzec testowy", group: "VI-08", usage: "", received: "", expiry: "2028-03-01",
    timestamp: 1, ordered: false, packageAmount, packageUnit: "g" };
  const root = doc(db, "odczynniki", "catalog");
  await assertSucceeds(setDoc(root, fields));
  const order = { orderDescription: "Wzorzec SO₄²⁻\nCertyfikat jakości",
    orderPackages: 3, orderPackaging: { amount: quantity("250", "ml"), unit: "ml" } };
  await assertSucceeds(updateDoc(root, order));
  await assertFails(updateDoc(root, { orderDescription: "A".repeat(4001) }));
  await assertFails(updateDoc(root, { orderPackaging: { amount: -1, unit: "g" } }));
  await assertFails(updateDoc(root, { orderPackaging: { amount: 1, unit: "xyz" } }));
  await assertFails(updateDoc(root, { orderPackaging: { amount: 1 } }));
  await assertFails(setDoc(doc(db, "odczynniki", "wrong"), { ...fields, ...order, productId: "catalog" }));
  await assertSucceeds(store.receive([{ fields: { ...fields, productId: "catalog", lotNumber: "TEST" }, initial: packageAmount }], "catalog-receipt"));
  const saved = (await getDoc(root)).data();
  assert.deepEqual(Object.fromEntries(Object.keys(order).map((key) => [key, saved[key]])), order);
  assert.equal(saved.name, fields.name);
  assert.equal(saved.expiry, fields.expiry);
  assert.equal(saved.packageAmount, packageAmount);
  const { anchor } = (await getDoc(store.ref("events", "catalog-receipt"))).data();
  const lot = doc(db, "odczynniki", anchor);
  await assertFails(updateDoc(lot, { orderDescription: "Niedozwolona kopia" }));
  await assertSucceeds(updateDoc(lot, { expiry: "2028-03-02", orderPackages: 2 }));
  assert.equal((await getDoc(lot)).data().orderDescription, undefined);
  await assertSucceeds(updateDoc(root, { orderDescription: "", orderPackaging: null }));
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

test("order history accepts an approved requester alongside earlier history records", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const order = { date: "2026-11-26", status: "generated", createdAt: serverTimestamp(),
    lines: [{ productId: "catalog", lotId: "batch", name: "Wzorzec", amount: "50 ml", expiry: "2027-01-05", standardKind: "O" }] };
  await assertSucceeds(setDoc(doc(db, "magazyn_zamowienia", "legacy-order"), order));
  const current = doc(db, "magazyn_zamowienia", "requester-order");
  await assertSucceeds(setDoc(current, { ...order, requester: "K. Łoboda" }));
  await assertFails(setDoc(doc(db, "magazyn_zamowienia", "outside-list"), { ...order, requester: "Inna osoba" }));
  await assertFails(updateDoc(current, { requester: "M. Piasecka" }));
  await assertSucceeds(updateDoc(current, { status: "ordered", orderedAt: serverTimestamp() }));
  assert.equal((await getDoc(current)).data().requester, "K. Łoboda");
});

test("linked receipts advance only one order line and cannot be counted twice", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const store = createInventoryStore(db, { collection, doc, runTransaction, serverTimestamp });
  const root = { name: "Odczynnik", group: "VI-1", usage: "", received: "", expiry: "", timestamp: 1, ordered: true,
    category: "Odczynniki", packageUnit: "g", packageAmount: quantity("25", "g") };
  const rootRef = doc(db, "odczynniki", "root");
  await setDoc(rootRef, root);
  const order = store.ref("orders", "linked");
  const other = store.ref("orders", "other");
  const original = { name: root.name, productId: "root", lotId: "root", amount: "2 × 25 g", packages: 2 };
  for (const target of [order, other]) {
    await setDoc(target, { lines: [original], date: "2026-11-26", status: "generated", requester: "B. Joachim", createdAt: serverTimestamp() });
    await updateDoc(target, { status: "ordered", orderedAt: serverTimestamp() });
  }
  await assertFails(updateDoc(order, { deliveries: { 0: { received: 1, complete: false } }, lastReceipt: "invented" }));
  const receive = (id, orderId = "linked") => store.receive([{ fields: { ...root, ordered: false, lotNumber: id,
    productId: "root" }, initial: root.packageAmount }], id, { orderId, lineIndex: 0, kind: "", complete: false });
  await assertSucceeds(receive("partial"));
  await assertSucceeds(receive("partial"));
  assert.deepEqual((await getDoc(order)).data().deliveries[0], { received: 1, complete: false });
  assert.equal((await getDoc(other)).data().deliveries, undefined);
  await assertSucceeds(receive("final"));
  assert.deepEqual((await getDoc(order)).data().deliveries[0], { received: 2, complete: true });
  assert.deepEqual((await getDoc(order)).data().lines, [original]);
  assert.deepEqual((await getDoc(store.ref("events", "final"))).data().details.delivery, { orderId: "linked", lineIndex: 0, complete: true });
  assert.equal((await getDoc(rootRef)).data().ordered, true);
  await assert.rejects(receive("extra"), /już rozliczona/);
  assert.equal((await getDoc(store.ref("events", "extra"))).exists(), false);
});

test("legacy order progress can be linked to the same register product without changing the source bottle ID", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const store = createInventoryStore(db, { collection, doc, runTransaction, serverTimestamp });
  const product = { name: "Odczynnik", group: "VI-2", usage: "", received: "", expiry: "", timestamp: 1, ordered: false,
    category: "Odczynniki", packageUnit: "g", packageAmount: quantity("25", "g") };
  for (const id of ["catalog", "old"]) await setDoc(doc(db, "odczynniki", id), product);
  const order = store.ref("orders", "legacy");
  await setDoc(order, { date: "2026-11-26", createdAt: serverTimestamp(), status: "generated",
    lines: [{ name: product.name, productId: "old", lotId: "old", amount: "2 × 25 g" }] });
  await updateDoc(order, { status: "ordered", orderedAt: serverTimestamp() });
  await assertSucceeds(store.receive([{ fields: { ...product, productId: "catalog", lotNumber: "Lot" }, initial: product.packageAmount }],
    "old-receipt", { orderId: "legacy", lineIndex: 0, kind: "", complete: true }));
  assert.deepEqual((await getDoc(order)).data().deliveries[0], { received: 1, complete: false });
  assert.deepEqual((await getDoc(doc(db, "odczynniki", "old"))).data(), product);
});

test("two clients competing for the final delivery create only one receipt and one lot", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const secondDb = testEnvironment.authenticatedContext(allowedUid).firestore();
  const firestore = { collection, doc, runTransaction, serverTimestamp };
  const first = createInventoryStore(db, firestore);
  const second = createInventoryStore(secondDb, firestore);
  const root = { name: "Odczynnik", group: "VI-3", usage: "", received: "", expiry: "", timestamp: 1, ordered: false,
    category: "Odczynniki", productId: "root", packageUnit: "g", packageAmount: quantity("25", "g") };
  await setDoc(doc(db, "odczynniki", "root"), root);
  const order = first.ref("orders", "delivery");
  await setDoc(order, { date: "2026-11-26", createdAt: serverTimestamp(), status: "generated",
    lines: [{ name: root.name, productId: "root", lotId: "root", amount: "25 g", packages: 1 }] });
  await updateDoc(order, { status: "ordered", orderedAt: serverTimestamp() });
  const receive = (store, id) => store.receive([{ fields: { ...root, lotNumber: id, timestamp: 2 }, initial: root.packageAmount }],
    id, { orderId: "delivery", lineIndex: 0, kind: "", complete: false });
  const results = await Promise.allSettled([receive(first, "client-a"), receive(second, "client-b")]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const failure = results.find(({ status }) => status === "rejected").reason;
  assert.ok(["permission-denied", "aborted"].includes(failure.code) || /już rozliczona/.test(failure.message));
  assert.deepEqual((await getDoc(order)).data().deliveries[0], { received: 1, complete: true });
  assert.equal((await getDocs(collection(db, "odczynniki"))).size, 2);
  assert.equal((await getDocs(collection(db, "magazyn_partie"))).size, 1);
  assert.equal((await getDocs(collection(db, "magazyn_operacje"))).size, 1);
});

test("unknown collections and other access records are denied", async () => {
  const database = testEnvironment.authenticatedContext(allowedUid).firestore();
  await assertFails(setDoc(doc(database, "unknown", "one"), { value: true }));
  await assertFails(getDoc(doc(database, "app_users", "another-user")));
});


const waterFirestore = { doc, runTransaction };
const waterSelection = (key, year = 2026, extra = {}) => ({
  year, itemKey: key, origin: "plan", planVersion: waterPlan(year).version, ...extra,
});
const waterDoc = (db, { year, origin, itemKey }) => doc(db, "harmonogram", waterAnnualId(year, origin, itemKey));
const finishWater = (date, expectedDate = null, note = "", expectedNote = "") =>
  ({ kind: "finish", date, expectedDate, note, expectedNote });

test("water annual rules protect against v31 partial writes, replacement and deletion", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const selection = waterSelection("barwa-spo");
  const target = waterDoc(db, selection);
  const store = createWaterStore(db, waterFirestore, () => true);
  await assertSucceeds(store.save(selection, finishWater("2026-05-03")));
  const today = (await getDoc(target)).data();
  assert.equal(today.revision, 1);
  await assertFails(updateDoc(target, { doneDate: null }));
  await assertFails(updateDoc(target, { doneDate: "2026-06-01" }));
  await assertFails(deleteDoc(target));
  await assertFails(setDoc(target, { name: "Starszy formularz", lab: "woda", doneDate: null, timestamp: 1 }));
  await assertFails(updateDoc(target, { year: "2027", revision: 2 }));
  await assertFails(updateDoc(target, { doneDate: "2026-02-29", revision: 2 }));
  await assertFails(updateDoc(target, { doneDate: "2027-03-03", revision: 2 }));
  await assertFails(updateDoc(target, { revision: 2, measurements: { [randomUUID()]: "2026-03-03" } }));
  const anonymous = testEnvironment.authenticatedContext("outsider").firestore();
  await assertFails(getDoc(waterDoc(anonymous, selection)));
  await assertSucceeds(store.save(selection, finishWater("2026-06-01", "2026-05-03")));
  await assertSucceeds(store.save(selection, finishWater(null, "2026-06-01")));
  assert.equal((await getDoc(target)).data().doneDate, null);
});

test("water records retain dates and history while separating years, matrix and method", async () => {
  const db = testEnvironment.authenticatedContext(allowedUid).firestore();
  const store = createWaterStore(db, waterFirestore, () => true);
  const legacyTask = { lab: "woda", name: "Azot Amonowy woda podziemna", category: "Probkobranie", timestamp: 1, doneDate: "2026-01-05" };
  await setDoc(doc(db, "harmonogram", "old-source"), legacyTask);
  const plan = waterSelection("amon-stud");
  const manual = { year: 2026, origin: "manual", itemKey: "old-source" };
  await assertSucceeds(store.save(manual, finishWater("2026-04-05")));
  await assertSucceeds(store.save(plan, finishWater("2026-04-05")));
  assert.equal((await getDoc(waterDoc(db, plan))).data().doneDate, "2026-04-05");
  assert.deepEqual((await getDoc(doc(db, "harmonogram", "old-source"))).data(), legacyTask);
  const next = waterSelection("amon-stud", 2027, { legacyTaskId: "old-source" });
  const other = waterSelection("amon-spo", 2027);
  await assertSucceeds(store.save(next, finishWater("2027-01-02")));
  await assertSucceeds(store.save(other, finishWater("2027-01-03")));
  assert.equal((await getDoc(waterDoc(db, plan))).data().doneDate, "2026-04-05");
  assert.equal((await getDoc(waterDoc(db, next))).data().doneDate, "2027-01-02");
  assert.equal((await getDoc(waterDoc(db, next))).data().legacyTaskId, "");
  assert.equal((await getDoc(waterDoc(db, other))).data().doneDate, "2027-01-03");
  await assertFails(setDoc(waterDoc(db, waterSelection("unknown")), { ...(await getDoc(waterDoc(db, other))).data(),
    year: "2026", itemKey: "unknown", revision: 1, doneDate: null }));
});

test("two operators safely share the sixth measurement and corrections", async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "app_users", "second"), { active: true, role: "operator" });
  });
  const a = testEnvironment.authenticatedContext(allowedUid).firestore();
  const b = testEnvironment.authenticatedContext("second").firestore();
  const first = createWaterStore(a, waterFirestore, () => true);
  const second = createWaterStore(b, waterFirestore, () => true);
  const selection = waterSelection("siar-g-dol");
  const add = () => ({ kind: "add", id: randomUUID(), date: "2026-04-06" });
  const repeated = add();
  await Promise.all([first.save(selection, repeated), second.save(selection, repeated)]);
  assert.equal(Object.keys((await getDoc(waterDoc(a, selection))).data().measurements).length, 1);
  for (let index = 1; index < 5; index++) await first.save(selection, add());
  const competing = await Promise.allSettled([first.save(selection, add()), second.save(selection, add())]);
  assert.equal(competing.filter(({ status }) => status === "fulfilled").length, 1);
  const before = (await getDoc(waterDoc(a, selection))).data();
  assert.equal(Object.keys(before.measurements).length, 6);
  await assertFails(updateDoc(waterDoc(a, selection), { revision: before.revision + 1, measurements: { ...before.measurements, [randomUUID()]: repeated.date } }));
  await first.save(selection, finishWater("2026-04-07"));
  await second.save(selection, { kind: "remove", id: repeated.id, expectedDate: repeated.date });
  const corrected = (await getDoc(waterDoc(a, selection))).data();
  assert.equal(Object.keys(corrected.measurements).length, 5);
  assert.equal(corrected.doneDate, "2026-04-07");
  await assert.rejects(first.save(selection, { kind: "remove", id: repeated.id, expectedDate: repeated.date }));
  assert.equal((await getDoc(waterDoc(a, waterSelection("siar-g-gor")))).exists(), false);
});

test("losing the connection does not enqueue a water change or clear a saved date", async () => {
  const a = testEnvironment.authenticatedContext(allowedUid).firestore();
  const b = testEnvironment.authenticatedContext(allowedUid).firestore();
  const selection = waterSelection("chlorki-dol");
  const store = createWaterStore(a, waterFirestore, () => true);
  await store.save(selection, finishWater("2026-04-15"));
  let checks = 0;
  const interrupted = createWaterStore(a, waterFirestore, () => ++checks === 1);
  await assert.rejects(interrupted.save(selection, finishWater(null, "2026-04-15")), /Brak połączenia/);
  assert.equal((await getDoc(waterDoc(b, selection))).data().doneDate, "2026-04-15");
  await store.save(selection, finishWater("2026-04-17", "2026-04-15"));
  assert.equal((await getDoc(waterDoc(b, selection))).data().doneDate, "2026-04-17");
});


test("one measurement key has exactly one identifier and one calendar date", async () => {
  const database = testEnvironment.authenticatedContext(allowedUid).firestore();
  const selection = waterSelection("siar-g-dol");
  const target = waterDoc(database, selection);
  const store = createWaterStore(database, waterFirestore, () => true);
  const first = randomUUID();
  const second = randomUUID();
  const firstDate = "2026-03-04";
  const secondDate = "2026-03-05";
  await store.save(selection, { kind: "add", id: first, date: firstDate });
  await assertFails(updateDoc(target, { revision: 2, measurements: { [first]: firstDate + "_" + secondDate } }));
  await assertFails(updateDoc(target, { revision: 2, measurements: { [first + "_" + second]: firstDate } }));
  await assertFails(updateDoc(target, { revision: 2, measurements: { [first]: "2026-02-29" } }));
  await assertFails(updateDoc(target, { revision: 2, measurements: { [first]: "2027-03-04" } }));
  await store.save(selection, { kind: "add", id: second, date: firstDate });
  assert.deepEqual((await getDoc(target)).data().measurements, { [first]: firstDate, [second]: firstDate });
});

test("annual corrections and identity survive a v31 client deleting the legacy source", async () => {
  const database = testEnvironment.authenticatedContext(allowedUid).firestore();
  const legacy = doc(database, "harmonogram", "example-legacy-water");
  const name = "Azot amonowy woda podziemna";
  await setDoc(legacy, { name, lab: "woda", category: "Probkobranie", timestamp: 22, doneDate: "2026-01-05" });
  const store = createWaterStore(database, waterFirestore, () => true);
  const manual = { year: 2026, origin: "manual", itemKey: legacy.id };
  const plan = waterSelection("amon-stud");
  await store.save(manual, finishWater("2026-01-07", null, "Uwaga laboratoryjna"));
  await store.save(plan, finishWater("2026-01-07", null, "Uwaga laboratoryjna"));
  // A v32 client could associate the old task with this saved plan entry.
  await assertSucceeds(updateDoc(waterDoc(database, plan), { legacyTaskId: legacy.id, revision: 2 }));
  assert.equal((await getDoc(waterDoc(database, plan))).data().doneDate, "2026-01-07");
  await assertSucceeds(deleteDoc(legacy));
  await assertSucceeds(store.save(plan, finishWater("2026-01-09", "2026-01-07", "Korekta planu", "Uwaga laboratoryjna")));
  await assertSucceeds(store.save(manual, finishWater("2026-01-11", "2026-01-07", "Korekta ręczna", "Uwaga laboratoryjna")));
  const remembered = (await getDoc(waterDoc(database, manual))).data();
  assert.equal(remembered.taskName, name);
  assert.equal(remembered.taskCategory, "Probkobranie");
  assert.equal(remembered.doneDate, "2026-01-11");
  assert.equal((await getDoc(waterDoc(database, plan))).data().legacyTaskId, legacy.id);
  await assertFails(updateDoc(waterDoc(database, manual), { revision: remembered.revision + 1, taskName: "Inne zadanie" }));
  const unlinked = waterSelection("amon-spo");
  await store.save(unlinked, finishWater("2026-01-09"));
  await assertFails(updateDoc(waterDoc(database, unlinked), { legacyTaskId: legacy.id, revision: 2 }));
  await assert.rejects(store.save({ ...manual, year: 2027 }, finishWater("2027-01-02")), /Źródłowe zadanie Wody/);
});
