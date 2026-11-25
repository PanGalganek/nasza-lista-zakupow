import { formatLocalDate, formatPolishDate } from "../utils.js?v=15";
import { createElement } from "./ui.js?v=15";
import { compatibleUnits, flaskVolumes, formatQuantity, matchesInventorySearch, quantity, scaledQuantity, validLots } from "./inventory-quantity.js?v=15";
import { batchLabel, button, details, field, input, panel, saveButton, select, unitSelect } from "./inventory-ui.js?v=15";

const say = (target, value) => target.append(createElement("p", "text-sm", value));
const methodOptions = (inventory) => inventory.rows("methods").map((method) => [method.id, method.name]);
const required = (value, label, limit = 200) => {
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.length > limit) throw new Error(`Podaj poprawną wartość pola „${label}”.`);
  return trimmed;
};

export function recipeIngredients(recipe, volume) {
  if (!flaskVolumes.includes(volume) || (!recipe.scalable && volume !== recipe.baseVolume)) {
    throw new Error("Ta receptura nie dopuszcza wybranej objętości.");
  }
  return recipe.ingredients.map((row) => ({
    ...row, quantity: scaledQuantity(row.quantity, volume, recipe.baseVolume),
  }));
}

export function allocateIngredients(ingredients, getLots, choices = {}, today = formatLocalDate()) {
  const remaining = new Map();
  const requests = [];
  const preview = [];
  ingredients.forEach((ingredient, index) => {
    if (!ingredient.productId) return;
    let need = ingredient.quantity;
    const candidates = validLots(getLots(ingredient.productId), ingredient.unit, today);
    const preferred = choices[index];
    if (preferred) {
      const option = candidates.find((lot) => lot.id === preferred);
      if (!option) throw new Error("Wybrana partia przestała być dostępna.");
      candidates.splice(candidates.indexOf(option), 1);
      candidates.unshift(option);
    }
    for (const lot of candidates) {
      const before = remaining.get(lot.id) ?? lot.stock.balance;
      const used = Math.min(need, before);
      if (!used) continue;
      need -= used;
      remaining.set(lot.id, before - used);
      requests.push({ lotId: lot.id, productId: ingredient.productId, unit: ingredient.unit, quantity: used });
      preview.push({ ingredient, lot, before, after: before - used });
      if (!need) break;
    }
    if (need) throw new Error(`Za mało składnika ${ingredient.name}. Brakuje ${formatQuantity(need, ingredient.unit)}.`);
  });
  return { requests, preview };
}

function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Ustawienia są opcjonalne. */ }
}

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

export function mountInventoryRecipes(inventory, { db, firestore }) {
  const { collection, doc, setDoc } = firestore;
  const createRef = (name) => doc(collection(db, name));
  let preparationPending = false;
  const recipeSearchContext = (recipe, methodName = "") => [recipe.name, methodName,
    ...recipe.ingredients.flatMap((row) => [row.name, ...inventory.lotsFor(row.productId).flatMap((lot) => [lot.name, lot.group, lot.lotNumber, lot.formula, lot.cas, lot.producer])])];

  inventory.mount("recipes", (container) => {
    const editor = createElement("div", "space-y-3");
    const list = createElement("div", "space-y-2");
    const search = input("Szukaj receptury, składnika lub metody", "", "search");
    const methods = details("Metody badawcze");
    const methodName = input("Nazwa nowej metody");
    const methodStatus = createElement("p", "text-xs text-red-700");
    for (const [, name] of methodOptions(inventory)) say(methods, name);
    methods.append(field("Dodaj metodę", methodName), saveButton("Zapisz metodę", async () => {
      const name = required(methodName.value, "Nazwa metody");
      if (methodOptions(inventory).some(([, value]) => matchesInventorySearch(value, name) && matchesInventorySearch(name, value))) {
        throw new Error("Metoda o tej nazwie już istnieje.");
      }
      await setDoc(createRef("magazyn_metody"), { name, usage: [] });
      if (editor.parentNode === container) inventory.refresh();
    }, methodStatus), methodStatus);
    container.replaceChildren(createElement("h2", "text-lg font-bold", "Baza receptur"), methods,
      button("Nowa receptura", () => showEditor({})), field("Szukaj receptury", search), editor, list);

    function showEditor(recipe) {
      const box = panel();
      const name = input("Nazwa roztworu", recipe.name);
      const base = input("Objętość podstawowa (ml)", recipe.baseVolume || 100, "number");
      const preferred = select(flaskVolumes.map((value) => [value, `${value} ml`]), recipe.defaultVolume || 100);
      const proportional = createElement("input");
      proportional.type = "checkbox";
      proportional.checked = recipe.scalable === true;
      const instruction = createElement("textarea", "w-full rounded border p-2 text-sm");
      instruction.value = recipe.instruction || "";
      instruction.maxLength = 4000;
      const methods = createElement("div", "grid gap-1 sm:grid-cols-2");
      const choices = methodOptions(inventory).map(([id, label]) => {
        const checkbox = createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = recipe.methods?.includes(id) === true;
        methods.append(field(label, checkbox));
        return [id, checkbox];
      });
      const ingredients = createElement("div", "space-y-2");
      const entries = new Map();
      const add = (item = {}) => {
        const row = panel();
        const product = select([["", "Poza ewidencją magazynową"], ...inventory.productOptions()], item.productId);
        const label = input("Nazwa składnika poza magazynem", item.productId ? "" : item.name);
        const amount = input("Ilość", item.quantity ? formatQuantity(item.quantity, item.unit).replace(/\s+[^\s]+$/, "").replace(/\s/g, "") : "");
        const unit = unitSelect(item.unit);
        row.append(field("Składnik", product), field("Nazwa składnika poza magazynem", label), field("Ilość podstawowa", amount),
          field("Jednostka", unit), button("Usuń składnik", () => { entries.delete(row); row.remove(); }));
        entries.set(row, () => {
          const productId = product.value;
          const source = inventory.products().find(([id]) => id === productId)?.[1];
          const stockUnit = inventory.lotsFor(productId).find((lot) => lot.stock?.unit)?.stock.unit || source?.packageUnit;
          if (stockUnit && !compatibleUnits(unit.value, stockUnit)) throw new Error("Jednostka składnika jest niezgodna z pozycją handlową.");
          return { productId, name: source?.name || required(label.value, "Składnik"), quantity: quantity(amount.value, unit.value), unit: unit.value };
        });
        ingredients.append(row);
      };
      (recipe.ingredients || [{}]).forEach(add);
      const status = createElement("p", "text-xs text-red-700");
      box.append(field("Nazwa roztworu", name), field("Podstawowa objętość końcowa (ml)", base),
        field("Dopuszczalne skalowanie proporcjonalne", proportional), field("Domyślna objętość", preferred), methods,
        field("Instrukcja przygotowania (opcjonalnie)", instruction), ingredients, button("Dodaj składnik", () => add()),
        saveButton("Zapisz recepturę", async () => {
          const baseVolume = Number(base.value);
          const defaultVolume = Number(preferred.value);
          if (!Number.isInteger(baseVolume) || baseVolume < 1 || baseVolume > 1_000_000
            || !flaskVolumes.includes(defaultVolume) || (!proportional.checked && baseVolume !== defaultVolume)) {
            throw new Error("Receptura bez skalowania musi mieć jedną z dostępnych standardowych objętości.");
          }
          const assigned = choices.filter(([, checkbox]) => checkbox.checked).map(([id]) => id);
          if (!entries.size || !assigned.length) throw new Error("Dodaj składnik i przypisz co najmniej jedną metodę.");
          await setDoc(recipe.id ? inventory.store.ref("recipes", recipe.id) : createRef("magazyn_receptury"), {
            name: required(name.value, "Nazwa roztworu"), baseVolume, defaultVolume, scalable: proportional.checked,
            methods: assigned, ingredients: [...entries.values()].map((read) => read()), instruction: instruction.value.trim(),
            version: (recipe.version || 0) + 1,
          });
          if (editor.parentNode === container) {
            editor.replaceChildren();
            render();
          }
        }, status), button("Anuluj", () => editor.replaceChildren()), status);
      editor.replaceChildren(box);
      box.scrollIntoView({ block: "nearest" });
    }
    const render = () => {
      list.replaceChildren();
      const methodsById = new Map(methodOptions(inventory));
      for (const recipe of inventory.rows("recipes")) {
        if (!matchesInventorySearch(search.value, ...recipeSearchContext(recipe, recipe.methods.map((id) => methodsById.get(id)).join(" ")))) continue;
        const card = details(recipe.name);
        say(card, `Objętość podstawowa ${recipe.baseVolume} ml · ${recipe.methods.map((key) => methodsById.get(key)).filter(Boolean).join(", ")}`);
        recipe.ingredients.forEach((row) => say(card, `${row.name} · ${formatQuantity(row.quantity, row.unit)}`));
        if (recipe.instruction) say(card, recipe.instruction);
        card.append(button("Edytuj recepturę", () => showEditor(recipe)));
        list.append(card);
      }
      if (!list.children.length) say(list, "Brak receptur.");
    };
    search.addEventListener("input", render);
    inventory.onChange("recipes", render);
    inventory.onChange("methods", render);
    render();
  });

  inventory.mount("preparation", (container) => {
    const search = input("Szukaj metody, receptury lub składnika", "", "search");
    const favoritesOnly = createElement("input");
    favoritesOnly.type = "checkbox";
    const favorites = new Set(readLocal("e-lab-favorite-recipes", []));
    const list = createElement("div", "space-y-2");
    const editor = createElement("div", "space-y-2");
    container.replaceChildren(createElement("h2", "text-lg font-bold", "Przygotowanie odczynników"),
      field("Szukaj", search), field("Tylko ulubione", favoritesOnly), editor, list);

    function prepare(recipe, methodId, methodName) {
      if (preparationPending) return;
      const box = panel();
      const choices = createElement("div", "flex flex-wrap gap-2");
      const preview = createElement("div", "space-y-2");
      const status = createElement("p", "text-sm text-red-700");
      status.setAttribute("role", "status");
      const savedVolumes = readLocal("e-lab-recipe-volumes", {});
      const preferred = {};
      let volume = recipe.scalable && flaskVolumes.includes(savedVolumes[recipe.id]) ? savedVolumes[recipe.id] : recipe.defaultVolume;
      const id = inventory.store.operationId();
      const show = () => {
        preview.replaceChildren();
        status.textContent = "";
        for (const control of choices.children) control.setAttribute("aria-pressed", String(Number(control.dataset.volume) === volume));
        try {
          const ingredients = recipeIngredients(recipe, volume);
          const selectors = createElement("div", "space-y-2");
          preview.append(selectors);
          ingredients.forEach((item, index) => {
            say(selectors, `${item.name} · ${formatQuantity(item.quantity, item.unit)}${item.productId ? "" : " · poza magazynem"}`);
            if (!item.productId) return;
            const candidates = validLots(inventory.lotsFor(item.productId), item.unit, formatLocalDate());
            const option = select([["", "Automatycznie według terminu ważności"],
              ...candidates.map((lot) => [lot.id, `${batchLabel(lot)} · ${formatPolishDate(lot.expiry)}`])], preferred[index]);
            option.addEventListener("change", () => { preferred[index] = option.value; show(); });
            selectors.append(field(`Pierwsza partia — ${item.name}`, option));
          });
          const plan = allocateIngredients(ingredients, inventory.lotsFor, preferred);
          for (const row of plan.preview) say(preview, `${batchLabel(row.lot)} · przed ${formatQuantity(row.before, row.lot.stock.unit)} · po ${formatQuantity(row.after, row.lot.stock.unit)}`);
          const confirm = saveButton("Zatwierdź przygotowanie", async () => {
            if (preparationPending) return;
            preparationPending = true;
            try {
              await inventory.store.withdraw(plan.requests, { id, preparation: {
                recipeId: recipe.id, recipeVersion: recipe.version, recipeName: recipe.name, methodId, methodName, volume,
                baseVolume: recipe.baseVolume, ingredients, instruction: recipe.instruction,
              } });
              writeLocal("e-lab-recipe-volumes", { ...savedVolumes, [recipe.id]: volume });
              editor.replaceChildren(createElement("p", "text-sm font-bold text-green-800", "Przygotowanie zapisane."));
            } finally { preparationPending = false; }
          }, status);
          preview.append(confirm);
        } catch (error) { status.textContent = error.message; }
      };
      for (const value of flaskVolumes) {
        const control = button(`${value} ml`, () => { if (!preparationPending) { volume = value; show(); } });
        control.className += " min-h-12 min-w-20";
        control.dataset.volume = String(value);
        control.disabled = !recipe.scalable && value !== recipe.baseVolume;
        choices.append(control);
      }
      box.append(createElement("h3", "font-bold", recipe.name), choices);
      if (recipe.instruction) say(box, recipe.instruction);
      box.append(preview, status, button("Anuluj", () => { if (!preparationPending) editor.replaceChildren(); }));
      editor.replaceChildren(box);
      show();
      box.scrollIntoView({ block: "nearest" });
    }
    const render = () => {
      const opened = new Set([...list.children].filter((element) => element.open).map((element) => element.dataset.method));
      list.replaceChildren();
      for (const [id, name] of methodOptions(inventory)) {
        const recipes = inventory.rows("recipes").filter((recipe) => recipe.methods.includes(id)
          && (!favoritesOnly.checked || favorites.has(recipe.id)) && matchesInventorySearch(search.value, ...recipeSearchContext(recipe, name)));
        if (!recipes.length) continue;
        const section = details(name);
        section.dataset.method = id;
        section.open = opened.has(id) || Boolean(search.value);
        for (const recipe of recipes) {
          const row = createElement("div", "mt-2 flex flex-wrap items-center gap-2 border-t pt-2 text-sm");
          row.append(createElement("span", "flex-1 font-semibold", recipe.name),
            button(favorites.has(recipe.id) ? "Usuń z ulubionych" : "Dodaj do ulubionych", () => {
              if (favorites.has(recipe.id)) favorites.delete(recipe.id); else favorites.add(recipe.id);
              writeLocal("e-lab-favorite-recipes", [...favorites]);
              render();
            }), button("Przygotowałem roztwór", () => prepare(recipe, id, name)));
          section.append(row);
        }
        list.append(section);
      }
      if (!list.children.length) say(list, "Brak przypisanych receptur spełniających kryteria.");
    };
    search.addEventListener("input", render);
    favoritesOnly.addEventListener("change", render);
    inventory.onChange("recipes", render);
    inventory.onChange("methods", render);
    render();
  });
}
