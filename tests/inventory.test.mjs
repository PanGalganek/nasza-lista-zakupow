import test from "node:test";
import assert from "node:assert/strict";
import { compatibleUnits, matchesInventorySearch, quantity, scaledQuantity, stockLevel } from "../public/modules/inventory-quantity.js";
import { allocateIngredients, groupRecipesByMethod, recipeIngredients, usedPreparationLots } from "../public/modules/inventory-recipes.js";
import { outgoingAmount } from "../public/modules/inventory-history.js";
import { calculateTheory } from "../public/modules/inventory-theory.js";
import { expiryDaysLabel, warningGroups, warsawDate } from "../public/modules/inventory-alerts.js";
import { createOrderDocx, orderColumns } from "../public/modules/inventory-docx.js";
import { indexCatalog, legacyCatalogKey, lotOptions, orderItemKey, orderStatus, readableLotNames, standardKind } from "../public/modules/inventory-items.js";
import { orderDefaults, orderItems, orderRequesters, suggestedOrderLot } from "../public/modules/inventory-orders.js";

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

test("legacy bottles are grouped by register and commercial identity without overwriting IDs", () => {
  const root = { id: "first", group: "VI-84", name: "Odczynnik A cz.d.a.", category: "Odczynniki", timestamp: 1 };
  const sibling = { ...root, id: "second", timestamp: 2, packageAmount: 25000000, packageUnit: "g" };
  const other = { ...root, id: "other", group: "VI-53" };
  const differentGrade = { ...root, id: "grade", name: "Odczynnik A 99%" };
  const initial = indexCatalog([root, sibling, other, differentGrade]);
  assert.equal(initial.products.size, 3);
  assert.equal(initial.aliases.get(sibling.id), root.id);
  const received = { ...sibling, id: "recent", productId: root.id, group: "VI-84/2" };
  const later = indexCatalog([{ ...root, productId: root.id }, sibling, received]);
  assert.deepEqual(later.products.get(root.id).lots.map(({ id }) => id), ["first", "recent", "second"]);
  assert.equal(indexCatalog([{ ...root, producer: "A" }, { ...sibling, producer: "B" }]).products.size, 2);
  assert.equal(indexCatalog([{ ...root, productId: root.id }, { ...sibling, productId: sibling.id }]).products.size, 2);
  assert.equal(indexCatalog([{ ...root, category: "Wzorce", usage: "Okresowy" }, { ...sibling, category: "Wzorce", usage: "Bieżący" }]).products.size, 2);
  const names = readableLotNames([root, sibling]);
  assert.match(names.get("first"), /Partia bez numeru.*Opakowanie 1/);
  assert.match(names.get("second"), /Partia bez numeru.*Opakowanie 2/);
});

test("preparation prefers bottles with valid withdrawals, followed by expiry and receipt date", () => {
  const stock = { status: "active", balance: quantity("25", "g"), unit: "g" };
  const lots = [
    { id: "early", stock, expiry: "2027-01-02", received: "2026-02-01" },
    { id: "older", stock, expiry: "2027-01-02", received: "2026-01-01" },
    { id: "used", stock, expiry: "2027-05-02", received: "2026-01-01" },
    { id: "expired", stock, expiry: "2025-01-02" },
    { id: "unknown", expiry: "2027-01-01" },
  ];
  const ingredients = [{ name: "A", unit: "g", quantity: quantity("1", "g"), productId: "older" }];
  const used = usedPreparationLots([
    { id: "a", kind: "withdrawal", changes: { early: {} } },
    { id: "b", kind: "preparation", changes: { used: {}, expired: {} } },
    { kind: "reversal", details: { originalId: "a" } },
  ]);
  const choose = (manual, history) => allocateIngredients(ingredients, () => lots, manual, "2026-11-26", history).requests[0];
  assert.equal(choose({}, used).lotId, "used");
  assert.equal(choose({ 0: "early" }, used).lotId, "early");
  assert.equal(choose({}).lotId, "older");
  assert.equal(choose({}, used).productId, "used");
});

test("order badges distinguish generated documents, pending partial delivery and fulfilled lines", () => {
  const order = { status: "generated", date: "2026-11-26" };
  const entries = [{ order, index: 0 }];
  assert.equal(orderStatus(entries, {}).state, "generated");
  order.status = "ordered";
  order.deliveries = { 0: { received: 1, complete: false } };
  assert.equal(orderStatus(entries, {}).state, "ordered");
  order.deliveries[0].complete = true;
  assert.equal(orderStatus(entries, { ordered: true }).state, "idle");
  assert.equal(orderStatus([], { ordered: true }).state, "ordered");
});

test("withdrawal aggregates only the remaining balance at retirement and accounts for reversals", () => {
  const operations = [["receipt", 0, 500], ["preparation", 500, 490], ["preparation", 490, 465],
    ["reversal", 465, 490], ["withdrawal", 490, 465], ["withdrawn", 465, 0]];
  const outgoing = operations.map(([kind, before, after]) => outgoingAmount({ kind }, { before, after }));
  assert.deepEqual(outgoing, [null, 10, 25, -25, 25, 465]);
  assert.equal(outgoing.reduce((sum, value) => sum + (value || 0), 0), 500);
  assert.equal(outgoingAmount({ kind: "withdrawn" }, { before: null, after: null }), null);
});

test("recipe groups share the original records and show empty methods and unassigned recipes", () => {
  const methods = [["a", "Metoda A"], ["b", "Metoda B"], ["empty", "Pusta metoda"]];
  const shared = { id: "shared", methods: ["a", "b", "a"] };
  const unassigned = { id: "unassigned", methods: [] };
  const legacy = { id: "legacy", methods: ["missing"] };
  const groups = groupRecipesByMethod(methods, [shared, unassigned, legacy]);
  assert.deepEqual(groups.map(({ id, name, recipes }) => [id, name, recipes.map((recipe) => recipe.id)]), [
    ["a", "Metoda A", ["shared"]],
    ["b", "Metoda B", ["shared"]],
    ["empty", "Pusta metoda", []],
    [null, "Nieprzypisane", ["unassigned", "legacy"]],
  ]);
  assert.equal(groups[0].recipes[0], groups[1].recipes[0]);
  assert.deepEqual(groupRecipesByMethod(methods, [shared]).map(({ id }) => id), ["a", "b", "empty"]);
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

test("expiry alerts use Warsaw midnight and rank deadlines by urgency", () => {
  const now = new Date("2026-03-28T23:05:00Z");
  const lots = Object.entries({ next: "2026-03-30", near: "2026-03-28", later: "2026-04-03", today: "2026-03-29",
    overdue: "2026-03-19", distant: "2026-05-10", invalid: "2026-02-30" }).map(([id, expiry]) => ({ id, name: id, expiry }));
  const { expired, expiring } = warningGroups(lots, 40, now);
  assert.equal(warsawDate(new Date("2026-03-28T22:59:59Z")), "2026-03-28");
  assert.equal(warsawDate(now), "2026-03-29");
  assert.equal(warsawDate(new Date("2026-06-05T22:00:00Z")), "2026-06-06");
  assert.deepEqual(expired.map(({ lot, days }) => [lot.id, days]), [["overdue", -10], ["near", -1]]);
  assert.deepEqual(expiring.map(({ lot, days }) => [lot.id, days]), [["today", 0], ["next", 1], ["later", 5]]);
  assert.deepEqual([0, 1, 5, -1, -10].map(expiryDaysLabel),
    ["Termin upływa dzisiaj", "Pozostało 1 dzień", "Pozostało 5 dni", "Po terminie o 1 dzień", "Po terminie o 10 dni"]);
});

test("orders use the product purchasing profile and fall back to available legacy data", () => {
  const legacy = { name: "Wzorzec żelaza", producer: "Przykładowy producent" };
  const lots = [{ timestamp: 2, packageAmount: quantity("500", "g"), packageUnit: "g", orderPackages: 2 }];
  assert.deepEqual(orderDefaults(legacy, []), { description: "Wzorzec żelaza Przykładowy producent", size: "", unit: "", count: 1 });
  assert.deepEqual(orderDefaults(legacy, lots), { description: "Wzorzec żelaza Przykładowy producent", size: "500", unit: "g", count: 2 });
  const description = "Wzorzec SO₄²⁻\nCertyfikat jakości";
  const profile = { ...legacy, orderDescription: description, orderPackaging: { amount: quantity("125", "ml"), unit: "ml" }, orderPackages: 4 };
  assert.deepEqual(orderDefaults(profile, lots), { description, size: "125", unit: "ml", count: 4 });
});

test("orders group matching lots and retain separate O and B variants", () => {
  const base = { name: "Wzorzec z certyfikatem", orderDescription: "Wzorzec Mn²⁺", category: "Wzorce", group: "II-4/1", usage: "Oznaczenia okresowe" };
  const a = { ...base, id: "a", expiry: "2027-01-05" };
  const b = { ...base, id: "b", group: "II-4/2", expiry: "2027-01-01" };
  const c = { ...base, id: "c", usage: "Kontrole bieżące", expiry: "2027-02-05" };
  const unknown = { ...base, id: "d", usage: "Oznaczenia okresowe i bieżące" };
  assert.equal(standardKind(unknown), "");
  assert.equal(standardKind({ ...c, category: "Odczynniki" }), "");
  assert.notEqual(legacyCatalogKey(a), legacyCatalogKey({ ...a, orderDescription: "Wzorzec Mn²⁺ 10 µg/L" }));
  assert.equal(orderItemKey(a), orderItemKey(b));
  assert.notEqual(orderItemKey(a), orderItemKey(c));
  const groups = orderItems([a, b, c, unknown], new Map());
  assert.deepEqual([...groups.values()].map(({ kind, lots }) => [kind, lots.map(({ id }) => id)]),
    [["O", ["a", "b"]], ["B", ["c"]], ["", ["d"]]]);
  assert.equal(suggestedOrderLot([a, b]).id, "b");
  assert.equal(suggestedOrderLot([a, { ...b, stock: { status: "used" } }]).id, "a");
});

test("batch choices identify duplicate or unnamed lots and distinguish O from B", () => {
  const lot = { lotNumber: "", group: "II-4", expiry: "2027-01-05", category: "Wzorce", usage: "Wzorzec okresowy" };
  const entries = lotOptions([{ ...lot, id: "duplicate-a" }, { ...lot, id: "duplicate-b" }, { ...lot, id: "regular", usage: "Wzorzec bieżący" }]);
  assert.match(entries[0][1], /bez numeru.*\(O\).*05\.01\.2027.*ID duplicate-a/);
  assert.match(entries[1][1], /ID duplicate-b$/);
  assert.match(entries[2][1], /\(B\)/);
});

test("Word columns contain the requester, date, and only the known expiry and standard type", async () => {
  const separate = [
    { name: "Odczynnik", expiry: "2027-01-01", standardKind: "" },
    { name: "Wzorzec", expiry: "2027-01-05", standardKind: "O" },
    { name: "Wzorzec", expiry: "2027-02-05", standardKind: "B" },
    { name: "Wzorzec bez terminu", expiry: "", standardKind: "B" },
    { name: "Wzorzec bez informacji", expiry: "", standardKind: "" },
  ];
  const date = "26.11.2026";
  for (const requester of orderRequesters) {
    const columns = separate.map((line) => orderColumns(line, date, requester));
    assert.ok(columns.every((cells) => cells.length === 11 && cells[1] === `${requester}\n${date}`
      && cells[0] === "" && cells.slice(4, 10).every((text) => text === "")));
    assert.deepEqual(columns.map((cells) => cells[10]),
      ["Do\n01.01.2027", "Do\n05.01.2027\n(O)", "Do\n05.02.2027\n(B)", "(B)", ""]);
    const xml = new TextDecoder().decode(await createOrderDocx(separate, date, requester).arrayBuffer());
    assert.ok(xml.includes(`${requester}</w:t><w:br/><w:t xml:space="preserve">${date}`));
    assert.match(xml, /05\.01\.2027<\/w:t><w:br\/><w:t xml:space="preserve">\(O\)/);
    assert.match(xml, /05\.02\.2027<\/w:t><w:br\/><w:t xml:space="preserve">\(B\)/);
  }
  assert.equal(orderColumns({ name: "Archiwum", notes: "zapisane uwagi" }, date)[10], "zapisane uwagi");
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

test("Word description preserves lines, Unicode and the accepted table grid", async () => {
  const row = { name: "Zażółć gęślą jaźń · H₂SO₄\r\nCertyfikat & kontrola\n" + "Wymagania 10 µg/L. ".repeat(120), amount: "3 × 125 ml" };
  const content = new TextDecoder().decode(await createOrderDocx([row], "26.11.2026").arrayBuffer());
  assert.match(content, /H₂SO₄<\/w:t><w:br\/><w:t xml:space="preserve">Certyfikat &amp; kontrola<\/w:t><w:br\/>/);
  assert.doesNotMatch(content, /<w:cantSplit\/>/);
  assert.match(content, /Wymagania 10 µg\/L/);
  assert.deepEqual([...content.matchAll(/<w:gridCol w:w="(\d+)"/g)].map((match) => Number(match[1])),
    [454, 1417, 3855, 1247, 1106, 1389, 1247, 1049, 1219, 1162, 1191]);
  assert.equal([...content.matchAll(/<w:tc>/g)].length, 11);
});
