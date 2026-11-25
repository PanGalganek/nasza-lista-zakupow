import test from "node:test";
import assert from "node:assert/strict";
import { compatibleUnits, matchesInventorySearch, quantity, scaledQuantity, stockLevel } from "../public/modules/inventory-quantity.js";
import { allocateIngredients, recipeIngredients } from "../public/modules/inventory-recipes.js";
import { calculateTheory } from "../public/modules/inventory-theory.js";
import { warningGroups } from "../public/modules/inventory-alerts.js";
import { createOrderDocx, orderColumns } from "../public/modules/inventory-docx.js";

test("quantities convert exactly and colours use the unrounded ratio", () => {
  assert.equal(quantity("0,5", "kg"), quantity("500", "g"));
  assert.equal(quantity("0.001", "l"), quantity("1000", "µl"));
  assert.equal(compatibleUnits("g", "ml"), false);
  assert.throws(() => quantity("0.5", "szt."), /dokładność/);
  assert.throws(() => scaledQuantity(1, 250, 100), /dokładnoś/);
  for (const [balance, color] of [[500, "green"], [251, "green"], [250, "yellow"], [126, "yellow"], [125, "red"], [0, "red"]]) {
    assert.equal(stockLevel({ initial: 500, balance }).color, color);
  }
  assert.equal(stockLevel(null), null);
});

test("inventory search supports names without Polish accents and multiple fragments", () => {
  assert.equal(matchesInventorySearch("zelaz LOT", "Żelazo", "LOT001"), true);
  assert.equal(matchesInventorySearch("hydroksylo", "chlorowodorek hydroksyloaminy"), true);
});

test("preparation scales each ingredient and allocates the earliest usable batches", () => {
  const recipe = { baseVolume: 100, scalable: true, ingredients: [
    { name: "A", productId: "a", unit: "g", quantity: quantity("10", "g") },
    { name: "B", productId: "b", unit: "ml", quantity: quantity("1", "ml") },
    { name: "Woda", productId: "", unit: "ml", quantity: quantity("20", "ml") },
  ] };
  const makeLot = (id, expiry, unit, amount) => ({ id, expiry, stock: { status: "active", unit, balance: quantity(amount, unit) } });
  const lots = {
    a: [makeLot("later", "2029-01-02", "g", "30"), makeLot("first", "2029-01-01", "g", "15"), makeLot("expired", "2026-01-01", "g", "100")],
    b: [makeLot("b", "", "ml", "5")],
  };
  const ingredients = recipeIngredients(recipe, 250);
  for (const [index, volume] of [50, 100, 250, 500, 1000].entries()) {
    const scaled = recipeIngredients(recipe, volume);
    assert.equal(scaled[0].quantity, quantity([5, 10, 25, 50, 100][index], "g"));
    assert.equal(scaled[1].quantity, quantity([0.5, 1, 2.5, 5, 10][index], "ml"));
  }
  assert.throws(() => recipeIngredients({ ...recipe, scalable: false }, 250), /objętości/);
  const plan = allocateIngredients(ingredients, (id) => lots[id], {}, "2027-01-01");
  assert.deepEqual(plan.requests.map(({ lotId }) => lotId), ["first", "later", "b"]);
  assert.equal(plan.requests[1].quantity, quantity("10", "g"));
  assert.throws(() => allocateIngredients(ingredients, (id) => lots[id].filter((lot) => lot.id !== "b"), {}, "2027-01-01"), /Za mało/);
});

test("125 determinations calculates 12.5 g without changing inventory", () => {
  const recipe = { id: "one", name: "Roztwór testowy", baseVolume: 100, version: 1,
    ingredients: [{ productId: "a", name: "Składnik A", unit: "g", quantity: quantity("10", "g") }] };
  const result = calculateTheory([{ target: "recipe", key: "one", unit: "ml", quantity: quantity("1", "ml") }], new Map([["one", recipe]]), 125);
  assert.equal(result.solutions[0].quantity, quantity("125", "ml"));
  assert.equal(result.commercial[0].quantity, quantity("12.5", "g"));
  assert.equal(result.solutions[0].recipeVersion, 1);
});

test("expiry and quantity warnings retain linked backup information", () => {
  const a = { id: "a", productId: "p", name: "A", expiry: "2026-11-23", stock: { initial: 500, balance: 125, status: "active" } };
  const b = { id: "b", productId: "p", name: "A", expiry: "2027-10-01", stock: { initial: 500, balance: 500, status: "active" } };
  const signals = warningGroups([a, b], 40, new Date(2026, 10, 25));
  assert.equal(signals.expired[0].backup.id, "b");
  assert.equal(signals.low[0].lot.id, "a");
  assert.equal(signals.warning.length, 0);
  const unknown = warningGroups([{ ...a, stock: undefined }, { ...b, stock: undefined }], 40, new Date(2026, 10, 25));
  assert.equal(unknown.expired[0].possibleBackup.id, "b");
  assert.equal(unknown.expired[0].backup, undefined);
  assert.deepEqual([unknown.low.length, unknown.warning.length], [0, 0]);
});

test("Word order is an editable table with eleven cells and blank supplier and order number", async () => {
  const row = { name: "Pozycja & wzorzec", amount: "2 × 500 g", notes: "test" };
  const values = orderColumns(row, "25.11.2026");
  assert.equal(values.length, 11);
  assert.deepEqual(values.slice(4, 6), ["", ""]);
  const zip = new Uint8Array(await createOrderDocx([row], "25.11.2026").arrayBuffer());
  assert.deepEqual([...zip.slice(0, 4)], [80, 75, 3, 4]);
  const content = new TextDecoder().decode(zip);
  assert.equal([...content.matchAll(/<w:tc>/g)].length, 11);
  assert.match(content, /landscape/);
  assert.match(content, /Arial/);
  assert.match(content, /C00000/);
  assert.match(content, /Pozycja &amp; wzorzec/);
  assert.doesNotMatch(content, /w:documentProtection|w:headerReference|w:footerReference/);
});
