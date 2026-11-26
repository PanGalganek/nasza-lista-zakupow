import { formatLocalDate } from "../utils.js?v=22";
import { createElement, notify } from "./ui.js?v=22";
import { compatibleUnits, formatQuantity, maxQuantity, quantity, units } from "./inventory-quantity.js?v=22";
import { button, field, input, panel, saveButton, select, unitSelect } from "./inventory-ui.js?v=22";

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

export function mountInventoryTheory(inventory, { db, firestore, navigation }) {
  const { collection, doc, setDoc, updateDoc, serverTimestamp } = firestore;
  const drafts = new Map();
  let selectedMethod = "";
  inventory.mount("theory", (container) => {
    const methods = inventory.rows("methods");
    const note = createElement("p", "lab-notice", "Obliczenia i zapis wyniku nie zmieniają stanu magazynowego.");
    container.replaceChildren(note);
    inventory.onChange("methods", () => inventory.refresh());
    if (!methods.length) {
      container.append(createElement("p", "lab-empty", "Dodaj metody badawcze w bazie receptur."));
      return;
    }
    const filter = select(methods.map(({ id, name }) => [id, name]));
    if (methods.some(({ id }) => id === selectedMethod)) filter.value = selectedMethod;
    const content = createElement("div", "lab-stack");
    container.append(field("Metoda badawcza", filter), content);
    const render = () => {
      const method = methods.find(({ id }) => id === filter.value);
      const box = panel();
      const config = createElement("div", "lab-stack");
      const form = createElement("div", "lab-list");
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
      const actions = createElement("div", "lab-dialog-actions");
      actions.append(button("Anuluj", () => navigation.close()), saveButton("Zapisz konfigurację", async () => {
        const usage = [...entries.values()].map((read) => read());
        if (new Set(usage.map((row) => `${row.target}:${row.key}`)).size !== usage.length) throw new Error("Połącz powtórzone pozycje konfiguracji.");
        await updateDoc(inventory.store.ref("methods", method.id), { usage });
        current = usage;
        navigation.close(true);
        notify("Zapisano konfigurację.");
      }, configStatus));
      config.append(form, button("Dodaj składnik zużycia", () => add()), configStatus, actions);
      const counts = ["Wykonane oznaczenia", "Próby ślepe", "Wzorce", "Odzyski", "Dodatkowe powtórzenia"];
      const prior = drafts.get(method.id);
      const amounts = counts.map((label, index) => input(label, prior?.amounts[index] ?? (index ? 0 : ""), "number"));
      const amountFields = createElement("div", "lab-fields");
      amounts.forEach((value, index) => {
        value.min = "0";
        value.step = "1";
        amountFields.append(field(counts[index], value));
      });
      box.append(amountFields, createElement("p", "lab-muted", "Doliczaj tylko pozycje, których nie uwzględniono w liczbie wykonanych oznaczeń."));
      const date = input("Data oznaczeń", prior?.date || formatLocalDate(), "date");
      const result = createElement("div", "space-y-1");
      const status = createElement("p", "text-sm text-red-700");
      let calculation;
      const invalidate = () => { calculation = null; result.replaceChildren(); };
      for (const field of [...amounts, date]) field.addEventListener("input", () => {
        drafts.set(method.id, { amounts: amounts.map((input) => input.value), date: date.value });
        invalidate();
      });
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
      content.replaceChildren(button("Zużycie na jedno oznaczenie", () => {
        navigation.show(config, "Zużycie na jedno oznaczenie", { onDismiss: () => {
          // Odtwórz pola po zamknięciu, także po odrzuceniu szkicu.
          entries.clear();
          form.replaceChildren();
          current.forEach(add);
        } });
      }), box);
    };
    filter.addEventListener("change", () => { selectedMethod = filter.value; render(); });
    render();
  });
}
