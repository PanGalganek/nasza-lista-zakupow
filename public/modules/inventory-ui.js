import { formatLocalDate, formatPolishDate } from "../utils.js?v=14";
import { byId, createButton, createElement, createInput } from "./ui.js?v=14";
import { formatQuantity, quantity, stockLevel, units, validLots } from "./inventory-quantity.js?v=14";
import { createInventoryStore, inventoryCollections, productId } from "./inventory-store.js?v=14";

const fieldClass = "w-full rounded border bg-white p-2 text-sm text-black";
const actionClass = "rounded border border-blue-200 bg-white px-3 py-2 text-xs font-bold text-blue-800";
export const sections = [
  ["registry", "Rejestr odczynników i wzorców"], ["preparation", "Przygotowanie odczynników"],
  ["recipes", "Baza receptur"], ["theory", "Zużycie teoretyczne"],
  ["history", "Przychody i rozchody"], ["archive", "Archiwum"], ["statistics", "Statystyki"], ["orders", "Zamówienia"],
];

export function field(labelText, input) {
  const label = createElement("label", "grid gap-1 text-xs font-bold text-gray-700");
  label.append(createElement("span", "", labelText), input);
  return label;
}

export function input(label, value = "", type = "text") {
  return createInput(fieldClass, label, value, type);
}

export function select(options, value = "") {
  const element = createElement("select", fieldClass);
  for (const [key, label] of options) {
    const option = createElement("option", "", label);
    option.value = key;
    element.append(option);
  }
  if (value !== "") element.value = value;
  return element;
}

export const unitSelect = (value) => select([["", "—"], ...Object.keys(units).map((unit) => [unit, unit])], value);
export const button = (label, action) => createButton(label, label, action, actionClass);
export const panel = () => createElement("div", "space-y-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-left");

export function details(label) {
  const box = createElement("details", "rounded-lg border border-gray-200 bg-white p-3 text-left");
  box.append(createElement("summary", "cursor-pointer font-bold text-blue-900", label));
  return box;
}

export function saveButton(label, action, message) {
  const control = button(label, async () => {
    if (control.disabled) return;
    control.disabled = true;
    message.textContent = "";
    try { await action(); } catch (error) { message.textContent = error.message; }
    finally { control.disabled = false; }
  });
  return control;
}

export function batchLabel(lot) {
  return [lot.name, lot.lotNumber || lot.group, lot.producer].filter(Boolean).join(" · ");
}

export function showStock(lot) {
  const stock = lot.stock;
  const box = createElement("div", "min-w-0 space-y-1 text-xs");
  if (!stock || stock.initial === null) {
    box.textContent = "Stan nieustalony";
    return box;
  }
  const level = stockLevel(stock);
  box.append(createElement("span", "font-semibold", `${formatQuantity(stock.balance, stock.unit)} / ${formatQuantity(stock.initial, stock.unit)}${level ? ` · ${level.percent.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%` : ""}`));
  if (level) {
    const meter = createElement("progress", `inventory-meter inventory-${level.color} block w-full`);
    meter.max = stock.initial;
    meter.value = stock.balance;
    meter.setAttribute("aria-label", "Procent pozostałego zapasu");
    box.append(meter);
  }
  return box;
}

export function createInventoryModule({ db, firestore, registerSnapshot, reportListenerError }) {
  const { collection, onSnapshot } = firestore;
  const store = createInventoryStore(db, firestore);
  const collections = {};
  const panels = new Map();
  const changes = new Map();
  const orderSelections = new Set();
  const loaded = new Set();
  const subscribed = new Set();
  let stockById = new Map();
  let registryById = new Map();
  let visibleCard = "";
  let lots = [];
  let section = "registry";
  let refreshRegistry = () => {};

  const withStock = (lot) => ({ ...lot, stock: stockById.get(lot.id) });
  const allLots = () => lots.map(withStock);
  const lotsFor = (id) => allLots().filter((lot) => productId(lot) === id);
  const products = () => [...new Map(lots.map((lot) => [productId(lot), registryById.get(productId(lot)) || lot])).entries()];
  const productOptions = () => products().map(([id, lot]) => [id, batchLabel(lot)]);
  const rows = (key) => collections[key] || [];
  const ready = () => loaded.has("stock");

  function refresh() {
    changes.clear();
    if (section !== "registry") panels.get(section)?.(byId("inventorySection"));
  }

  function switchSection(key) {
    section = key;
    if (["history", "archive", "statistics"].includes(key)) subscribe("events");
    if (key === "statistics") subscribe("calculations");
    byId("inventoryRegistry").classList.toggle("hidden", key !== "registry");
    byId("inventorySection").classList.toggle("hidden", key === "registry");
    for (const child of byId("inventoryNav").children) child.setAttribute("aria-pressed", String(child.dataset.section === key));
    refresh();
  }

  function start() {
    loaded.clear();
    subscribed.clear();
    stockById.clear();
    orderSelections.clear();
    visibleCard = "";
    byId("inventoryAction").replaceChildren();
    for (const key of Object.keys(inventoryCollections)) delete collections[key];
    for (const key of ["stock", "recipes", "methods", "orders"]) subscribe(key);
    switchSection("registry");
  }

  function subscribe(key) {
    if (subscribed.has(key)) return;
    subscribed.add(key);
    registerSnapshot(onSnapshot(collection(db, inventoryCollections[key]), (snapshot) => {
        collections[key] = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
        loaded.add(key);
        if (key === "stock") stockById = new Map(collections.stock.map((item) => [item.id, item]));
        if (["stock", "recipes", "methods"].includes(key)) refreshRegistry();
        changes.get(key)?.();
        if (["history", "archive"].includes(section) && ["stock", "events"].includes(key)) refresh();
        if (visibleCard && ["stock", "events"].includes(key)) showCard(visibleCard, false);
    }, (error) => reportListenerError("Magazyn", error)));
  }

  function bind(rerender) {
    refreshRegistry = rerender;
    for (const [key, label] of sections) {
      const control = button(label, () => switchSection(key));
      control.dataset.section = key;
      byId("inventoryNav").append(control);
    }
    switchSection("registry");
  }

  function fields(lot = {}, editing = false) {
    const fieldGroup = createElement("div", "grid gap-2 sm:grid-cols-2 lg:grid-cols-4");
    const size = input("Wielkość opakowania", lot.packageAmount ? formatQuantity(lot.packageAmount, lot.packageUnit).split(/\s+(?=[^\s]+$)/)[0].replace(/\s/g, "") : "");
    const unit = unitSelect(lot.packageUnit);
    const count = input("Domyślna liczba opakowań", lot.orderPackages || 1, "number");
    const number = input("Numer partii", editing ? lot.lotNumber : "");
    const producer = input("Producent", lot.producer);
    const formula = input("Wzór chemiczny", lot.formula);
    const cas = input("CAS", lot.cas);
    const initial = input("Ilość początkowa", "");
    const usedAsProduct = rows("recipes").some((recipe) => recipe.ingredients.some((row) => row.productId === lot.id))
      || rows("methods").some((method) => method.usage.some((row) => row.key === lot.id))
      || lots.some((other) => other.productId === lot.id)
      || rows("orders").some((order) => order.lines.some((row) => row.productId === lot.id));
    const link = editing && ready() && !lot.productId && !withStock(lot).stock && !usedAsProduct
      ? select([["", "Osobna pozycja"], ...products()
        .filter(([id, other]) => id !== lot.id && (other.category === "Odczynniki") === (lot.category === "Odczynniki"))
        .map(([id, other]) => [id, batchLabel(other)])]) : null;
    count.min = "1";
    count.max = "10000";
    number.maxLength = 100;
    producer.maxLength = 200;
    formula.maxLength = 100;
    cas.maxLength = 40;
    const inputs = [["Wielkość opakowania", size], ["Jednostka opakowania", unit], ["Domyślna liczba opakowań", count], ["Numer partii", number],
      ["Producent", producer], ["Wzór chemiczny (opcjonalnie)", formula], ["CAS (opcjonalnie)", cas]];
    for (const [label, control] of inputs) fieldGroup.append(field(label, control));
    if (!editing) fieldGroup.append(field("Ilość początkowa (domyślnie pełne opakowanie)", initial));
    if (link) fieldGroup.append(field("Powiąż tylko z identycznym wariantem handlowym", link));
    return {
      node: fieldGroup,
      initial(packaging) {
        const value = initial.value.trim() ? quantity(initial.value, packaging.packageUnit) : packaging.packageAmount;
        if (value > packaging.packageAmount) throw new Error("Ilość początkowa przekracza wielkość opakowania.");
        return value;
      },
      read() {
        const orderPackages = Number(count.value);
        if (!Number.isInteger(orderPackages) || orderPackages < 1 || orderPackages > 10000) throw new Error("Podaj liczbę opakowań od 1 do 10 000.");
        const result = { lotNumber: number.value.trim(), producer: producer.value.trim(), formula: formula.value.trim(), cas: cas.value.trim(), orderPackages };
        if (!editing && !result.lotNumber) throw new Error("Podaj numer przyjmowanej partii.");
        if (size.value.trim() || unit.value || !editing) {
          result.packageUnit = unit.value;
          result.packageAmount = quantity(size.value, unit.value);
        }
        if (link?.value) result.productId = link.value;
        return result;
      },
    };
  }

  function actions(item) {
    const lot = withStock(item);
    if (!ready() || (lot.stock && lot.stock.status !== "active")) return [];
    const active = validLots([lot], lot.stock?.unit, formatLocalDate()).length > 0;
    return [
      ...(!lot.stock ? [button("Ustal stan", () => showAction(lot, "opening"))] : []),
      ...(active ? [button("Zużycie", () => showAction(lot, "withdrawal"))] : []),
      ...(!lot.expiry || lot.expiry >= formatLocalDate() ? [button("Oznacz jako zużyty", () => showAction(lot, "used"))] : []),
      button("Wycofaj", () => showAction(lot, "withdrawn")),
      button("Karta", () => showCard(productId(lot))),
    ];
  }

  function showAction(lot, kind) {
    visibleCard = "";
    const destination = byId("inventoryAction");
    const box = panel();
    const message = createElement("p", "text-xs text-red-700");
    message.setAttribute("role", "status");
    const labels = { opening: "Ustal stan początkowy", withdrawal: "Zużycie", used: "Oznacz jako zużyty", withdrawn: "Wycofaj partię" };
    box.append(createElement("h3", "font-bold", `${labels[kind]} — ${batchLabel(lot)}`));
    const choices = kind === "withdrawal" ? validLots(lotsFor(productId(lot)), lot.stock.unit, formatLocalDate()) : [lot];
    const selected = select(choices.map((batch) => [batch.id, `${batchLabel(batch)} · ${formatPolishDate(batch.expiry)}`]));
    const unit = unitSelect(lot.stock?.unit || lot.packageUnit);
    const amount = input("Ilość");
    const preview = createElement("p", "text-sm");
    const chosen = () => choices.find((batch) => batch.id === selected.value);
    const update = () => {
      const batch = chosen();
      if (!batch?.stock || kind !== "withdrawal") return;
      try {
        const remaining = batch.stock.balance - quantity(amount.value, batch.stock.unit);
        preview.textContent = remaining < 0 ? "Brak wystarczającego zapasu." : `Po pobraniu ${formatQuantity(remaining, batch.stock.unit)}`;
      } catch { preview.textContent = `Dostępne ${formatQuantity(batch.stock.balance, batch.stock.unit)}`; }
    };
    if (kind === "withdrawal") {
      box.append(field("Partia", selected), field("Ilość w jednostce partii", amount), preview);
      selected.addEventListener("change", update);
      amount.addEventListener("input", update);
      update();
    }
    if (kind === "opening") box.append(field("Rzeczywisty stan początkowy", amount), field("Jednostka", unit));
    if (["used", "withdrawn"].includes(kind)) box.append(createElement("p", "text-sm", "Partia zostanie zamknięta. Pozostały stan zostanie wyksięgowany, a historia zachowana."));
    const id = store.operationId();
    box.append(saveButton("Zatwierdź", async () => {
      if (kind === "opening") await store.establish(lot.id, quantity(amount.value, unit.value, { zero: true }), unit.value, id);
      else if (kind === "withdrawal") {
        const batch = chosen();
        await store.withdraw([{ lotId: batch.id, productId: productId(batch), quantity: quantity(amount.value, batch.stock.unit), unit: batch.stock.unit }], { id });
      } else await store.close(lot.id, kind, id);
      destination.replaceChildren();
    }, message), button("Anuluj", () => destination.replaceChildren()), message);
    destination.replaceChildren(box);
    box.scrollIntoView({ block: "nearest" });
  }

  function showCard(id, focus = true) {
    visibleCard = id;
    subscribe("events");
    const destination = byId("inventoryAction");
    const box = panel();
    box.append(createElement("h3", "font-bold", `Karta magazynowa — ${products().find(([key]) => key === id)?.[1]?.name || ""}`));
    panels.get("history")?.(box, id);
    box.append(button("Zamknij kartę", () => { visibleCard = ""; destination.replaceChildren(); }));
    destination.replaceChildren(box);
    if (focus) box.scrollIntoView({ block: "nearest" });
  }

  return {
    store, fields, start, bind, actions, withStock, allLots, lotsFor, products, productOptions, rows, ready, refresh, orderSelections,
    searchContext(lot) {
      const methods = new Map(rows("methods").map((method) => [method.id, method.name]));
      return rows("recipes").filter((recipe) => recipe.ingredients.some((ingredient) => ingredient.productId === productId(lot)))
        .flatMap((recipe) => [recipe.name, ...recipe.methods.map((id) => methods.get(id))]);
    },
    setLots(value) {
      lots = value;
      registryById = new Map(lots.map((item) => [item.id, item]));
    },
    mount(key, render) { panels.set(key, render); },
    onChange(key, callback) { changes.set(key, callback); },
    open: switchSection,
  };
}
