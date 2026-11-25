import { formatLocalDate } from "../utils.js?v=16";
import { createElement } from "./ui.js?v=16";
import { compatibleUnits, formatQuantity, maxQuantity, quantity, units } from "./inventory-quantity.js?v=16";
import { button, details, field, input, panel, saveButton, select, unitSelect } from "./inventory-ui.js?v=16";

function theoreticalAmount(amount, multiplier, divisor = 1n) {
  const numerator = BigInt(amount) * multiplier;
  const whole = (numerator + divisor / 2n) / divisor;
  if (whole > BigInt(maxQuantity)) throw new Error("Wynik wykracza poza zakres kalkulatora.");
  return Number(whole);
}

export function calculateTheory(usage, recipes, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) throw new Error("Podaj od 1 do miliona oznaczeń.");
  const solutions = [];
  const commercial = [];
  for (const row of usage) {
    if (row.target === "product") {
      commercial.push({ productId: row.key, name: row.name, unit: row.unit, quantity: theoreticalAmount(row.quantity, BigInt(count)) });
      continue;
    }
    const recipe = recipes.get(row.key);
    if (!recipe || units[row.unit]?.[0] !== "objętość") throw new Error("Sprawdź recepturę i jednostkę objętości.");
    const volume = theoreticalAmount(row.quantity, BigInt(count));
    solutions.push({ recipeId: recipe.id, recipeVersion: recipe.version, name: recipe.name, unit: row.unit, quantity: volume });
    for (const item of recipe.ingredients) {
      if (!item.productId) continue;
      commercial.push({ productId: item.productId, name: item.name, unit: item.unit,
        quantity: theoreticalAmount(item.quantity, BigInt(volume), BigInt(recipe.baseVolume) * BigInt(units.ml[1])) });
    }
  }
  return { solutions, commercial };
}

export function mountInventoryTheory(inventory, { db, firestore }) {
  const { collection, doc, setDoc, updateDoc, serverTimestamp } = firestore;
  inventory.mount("theory", (container) => {
    const methods = inventory.rows("methods");
    container.replaceChildren(createElement("h2", "text-lg font-bold", "Zużycie teoretyczne"));
    if (!methods.length) {
      container.append(createElement("p", "text-sm", "Dodaj metody badawcze w bazie receptur."));
      return;
    }
    const filter = select(methods.map(({ id, name }) => [id, name]));
    const content = createElement("div", "space-y-3");
    container.append(field("Metoda badawcza", filter), content);
    const render = () => {
      const method = methods.find(({ id }) => id === filter.value);
      const box = panel();
      const config = details("Zużycie na jedno oznaczenie");
      const form = createElement("div", "space-y-2");
      const configStatus = createElement("p", "text-sm text-red-700");
      const recipes = new Map(inventory.rows("recipes").map((recipe) => [recipe.id, recipe]));
      const products = new Map(inventory.products());
      const entries = new Map();
      const add = (entry = {}) => {
        const row = panel();
        const linked = [...recipes.values()].filter((recipe) => recipe.methods.includes(method.id) || recipe.id === entry.key);
        const candidates = [...linked.map((recipe) => [`recipe:${recipe.id}`, `Roztwór · ${recipe.name}`]),
          ...inventory.productOptions().map(([id, label]) => [`product:${id}`, label])];
        const target = select(candidates, entry.target && `${entry.target}:${entry.key}`);
        const value = input("Ilość na oznaczenie", entry.quantity ? formatQuantity(entry.quantity, entry.unit).replace(/\s+[^\s]+$/, "").replace(/\s/g, "") : "");
        const unit = unitSelect(entry.unit);
        row.append(field("Roztwór lub odczynnik", target), field("Ilość na oznaczenie", value), field("Jednostka", unit),
          button("Usuń wiersz", () => { entries.delete(row); row.remove(); }));
        entries.set(row, () => {
          const [kind, key] = target.value.split(":");
          const record = kind === "recipe" ? recipes.get(key) : products.get(key);
          if (!record || (kind === "recipe" && units[unit.value]?.[0] !== "objętość")) throw new Error("Wybierz pozycję i zgodną jednostkę.");
          if (kind === "product") {
            const stockUnit = inventory.lotsFor(key).find((lot) => lot.stock?.unit)?.stock.unit || record.packageUnit;
            if (stockUnit && !compatibleUnits(unit.value, stockUnit)) throw new Error("Jednostka zużycia jest niezgodna z pozycją handlową.");
          }
          return { target: kind, key, name: record.name, unit: unit.value, quantity: quantity(value.value, unit.value) };
        });
        form.append(row);
      };
      method.usage.forEach(add);
      let current = method.usage;
      config.append(form, button("Dodaj składnik zużycia", () => add()), saveButton("Zapisz konfigurację", async () => {
        const usage = [...entries.values()].map((read) => read());
        if (new Set(usage.map((row) => `${row.target}:${row.key}`)).size !== usage.length) throw new Error("Połącz powtórzone pozycje konfiguracji.");
        await updateDoc(inventory.store.ref("methods", method.id), { usage });
        current = usage;
        configStatus.textContent = "Zapisano konfigurację.";
      }, configStatus), configStatus);
      const counts = ["Wykonane oznaczenia", "Próby ślepe", "Wzorce", "Odzyski", "Dodatkowe powtórzenia"];
      const amounts = counts.map((label, index) => input(label, index ? 0 : "", "number"));
      amounts.forEach((value, index) => {
        value.min = "0";
        value.step = "1";
        box.append(field(counts[index], value));
      });
      box.append(createElement("p", "text-xs text-gray-600", "Doliczaj tylko pozycje, których nie uwzględniono w liczbie wykonanych oznaczeń."));
      const date = input("Data oznaczeń", formatLocalDate(), "date");
      const result = createElement("div", "space-y-1");
      const status = createElement("p", "text-sm text-red-700");
      let calculation;
      const invalidate = () => { calculation = null; result.replaceChildren(); };
      for (const field of [...amounts, date]) field.addEventListener("input", invalidate);
      box.append(field("Data oznaczeń", date), saveButton("Oblicz", () => {
        invalidate();
        if (!current.length) throw new Error("Najpierw zapisz recepturę zużycia metody.");
        const values = amounts.map((input) => Number(input.value));
        if (!date.value || values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Podaj prawidłową datę i liczby oznaczeń.");
        const count = values.reduce((sum, value) => sum + value, 0);
        const summary = calculateTheory(current, recipes, count);
        calculation = { methodId: method.id, methodName: method.name, date: date.value, count, counts: values, ...summary };
        result.append(createElement("p", "font-bold", `Liczba oznaczeń ${count}`));
        for (const row of summary.solutions) result.append(createElement("p", "text-sm", `Roztwór ${row.name} · ${formatQuantity(row.quantity, row.unit)}`));
        for (const row of summary.commercial) result.append(createElement("p", "text-sm", `Odczynnik ${row.name} · ${formatQuantity(row.quantity, row.unit)}`));
        const ref = doc(collection(db, "magazyn_obliczenia"));
        result.append(saveButton("Zapisz wynik do statystyk", async () => {
          if (!calculation) throw new Error("Oblicz zużycie.");
          await setDoc(ref, { ...calculation, createdAt: serverTimestamp() });
          result.lastElementChild.remove();
          status.textContent = "Zapisano wynik teoretyczny.";
        }, status));
      }, status, { online: false }), result, status);
      content.replaceChildren(config, box);
    };
    filter.addEventListener("change", render);
    render();
  });
}
