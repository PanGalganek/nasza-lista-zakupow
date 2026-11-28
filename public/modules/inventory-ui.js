import { formatLocalDate, formatPolishDate } from "../utils.js?v=38.1";
import { byId, createButton, createElement, createInput, notify } from "./ui.js?v=38.1";
import { compatibleUnits, formatQuantity, quantity, stockLevel, units, validLots } from "./inventory-quantity.js?v=38.1";
import { createInventoryStore, inventoryCollections, openingSource, productId, requireInventoryConnection } from "./inventory-store.js?v=38.1";
import { indexCatalog, orderLineMatches, orderLineProgress, orderRecordedDate, orderStatus } from "./inventory-items.js?v=38.1";
import { icon } from "./icons.js?v=38.1";

const textValue = (value) => typeof value === "string";
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const material = (row) => row && textValue(row.name) && Object.hasOwn(units, row.unit) && integer(row.quantity);
const materials = (value) => Array.isArray(value) && value.every(material);
const inventoryRecords = {
  recipes: (row) => textValue(row.name) && Array.isArray(row.methods) && row.methods.every(textValue)
    && materials(row.ingredients) && row.ingredients.every((item) => textValue(item.productId)),
  methods: (row) => textValue(row.name) && materials(row.usage)
    && row.usage.every((item) => ["recipe", "product"].includes(item.target) && textValue(item.key)),
  orders: (row) => textValue(row.date) && Array.isArray(row.lines) && row.lines.every((item) =>
    item && [item.productId, item.name, item.amount, item.notes].every(textValue)),
  calculations: (row) => textValue(row.date) && materials(row.commercial)
    && row.commercial.every((item) => textValue(item.productId)),
};
export function field(labelText, input) {
  const label = createElement("label", "lab-field");
  label.append(createElement("span", "", labelText), input);
  return label;
}

export function input(label, value = "", type = "text") {
  return createInput("", label, value, type);
}

export function select(options, value = "") {
  const element = createElement("select");
  for (const [key, label] of options) {
    const option = createElement("option", "", label);
    option.value = key;
    element.append(option);
  }
  if (value !== "") element.value = value;
  return element;
}

export const unitSelect = (value) => select([["", "—"], ...Object.keys(units).map((unit) => [unit, unit])], value);
export const button = (label, action, variant = "") => createButton(label, label, action, `lab-button ${variant}`);
export const panel = () => createElement("div", "lab-panel lab-stack");
export const orderDescriptionLimit = 4000;

export function details(label) {
  const box = createElement("details", "lab-accordion");
  box.append(createElement("summary", "", label));
  return box;
}

export function saveButton(label, action, message, { online = true, danger = false } = {}) {
  message.setAttribute("aria-live", "polite");
  const control = button(label, async () => {
    if (control.disabled) return;
    control.disabled = true;
    control.setAttribute("aria-busy", "true");
    message.textContent = "";
    try {
      if (online) requireInventoryConnection();
      await action();
    } catch (error) { message.textContent = error.message; }
    finally { control.disabled = false; control.removeAttribute("aria-busy"); }
  }, danger ? "lab-button-danger" : "lab-button-primary");
  return control;
}

export function batchLabel(lot) {
  return [lot.name, lot.lotNumber || lot.group, lot.producer].filter(Boolean).join(" · ");
}

export function orderBadge({ state, order, history }, toggleLegacy, { showStatusText = false } = {}) {
  const label = state === "generated" ? "Wygenerowano Word" : state === "ordered" ? "Zamówiono · oczekuje na dostawę" : "Niezamówione";
  const symbol = icon(state === "generated" ? "document" : "cart");
  const className = `lab-order-badge lab-order-${state}`;
  if (state === "idle") {
    const control = toggleLegacy && !history
      ? createButton("", "Oznacz jako zamówione", toggleLegacy, className)
      : createElement("span", className);
    control.title = label;
    if (control.tagName === "SPAN") { control.setAttribute("role", "img"); control.setAttribute("aria-label", label); }
    control.append(symbol);
    if (showStatusText) control.append(createElement("span", "", label));
    return control;
  }
  const date = order && (state === "generated" ? orderRecordedDate(order, "createdAt") : formatPolishDate(order.date, ""));
  const caption = state === "generated" && date ? `${label} – ${date}` : label;
  const box = createElement("details", "lab-order-status");
  const summary = createElement("summary", className);
  summary.title = caption;
  summary.setAttribute("aria-label", caption);
  summary.append(symbol);
  if (showStatusText) summary.append(createElement("span", "", state === "ordered" ? "Oczekuje na dostawę" : caption));
  const description = createElement("div", "lab-order-description");
  description.append(createElement("p", "", state === "ordered" && date ? `Zamówiono – ${date}` : caption));
  if (order?.requester) description.append(createElement("p", "", `Zamawia: ${order.requester}`));
  if (state === "ordered" && order) description.append(createElement("p", "", `Wygenerowano Word – ${orderRecordedDate(order, "createdAt")}`));
  if (!order && toggleLegacy) description.append(button("Cofnij oznaczenie zamówienia", toggleLegacy));
  box.append(summary, description);
  return box;
}

export function showStock(lot, { compact = false } = {}) {
  const stock = lot.stock;
  const box = createElement(compact ? "span" : "div", "lab-stock");
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

export function createInventoryModule({ db, firestore, registerSnapshot, reportListenerError, navigation }) {
  const { collection, onSnapshot } = firestore;
  const store = createInventoryStore(db, firestore);
  const collections = {};
  const panels = new Map();
  const changes = new Map();
  const orderSelections = new Map();
  const loaded = new Set();
  const subscribed = new Set();
  let stockById = new Map();
  let registryById = new Map();
  let byProduct = new Map();
  let catalog = indexCatalog([]);
  let orderLinesByLot = new Map();
  let orderLinesByProduct = new Map();
  let visibleCard = "";
  let pendingAction = false;
  let refreshWithdrawal;
  let lots = [];
  let section = "menu";
  let refreshRegistry = () => {};

  const withStock = (lot) => ({ ...lot, stock: stockById.get(lot.id) });
  const allLots = () => lots.map(withStock);
  const lotsFor = (id) => (byProduct.get(id) || []).map(withStock);
  const products = () => [...new Map(lots.map((lot) => [productId(lot), registryById.get(productId(lot)) || lot])).entries()];
  const productOptions = () => products().map(([id, lot]) => [id, batchLabel(lot)]);
  const catalogId = (id) => catalog.aliases.get(id) || id;
  const productLots = (id) => (catalog.products.get(catalogId(id))?.lots || []).map(withStock);
  const rows = (key) => collections[key] || [];
  const ready = () => loaded.has("stock");
  const legacyOrderEntries = (lot) => (orderLinesByProduct.get(productId(lot)) || [])
    .filter(({ line }) => !line.lotId && orderLineMatches(line, lot));

  function indexOrders() {
    orderLinesByLot = new Map();
    orderLinesByProduct = new Map();
    for (const order of rows("orders")) {
      order.lines.forEach((line, index) => {
        const entry = { order, line, index };
        for (const [indexMap, key] of [[orderLinesByLot, line.lotId], [orderLinesByProduct, line.productId]]) {
          if (!key) continue;
          if (!indexMap.has(key)) indexMap.set(key, []);
          indexMap.get(key).push(entry);
        }
      });
    }
  }

  function refresh(entering = false) {
    changes.clear();
    if (panels.has(section)) panels.get(section)(byId("inventorySection"), "", entering);
  }

  function switchSection(key) {
    const entering = key !== section;
    section = key;
    if (["archive", "statistics", "preparation"].includes(key)) subscribe("events");
    if (key === "statistics") subscribe("calculations");
    byId("inventoryMenu").hidden = key !== "menu";
    byId("inventoryRegistry").classList.toggle("hidden", key !== "registry");
    byId("inventorySection").classList.toggle("hidden", !panels.has(key));
    refresh(entering);
  }

  function start() {
    loaded.clear();
    subscribed.clear();
    stockById.clear();
    orderSelections.clear();
    visibleCard = "";
    refreshWithdrawal = undefined;
    byId("inventoryAction").replaceChildren();
    for (const key of Object.keys(inventoryCollections)) delete collections[key];
    indexOrders();
    for (const key of ["stock", "recipes", "methods", "orders"]) subscribe(key);
    switchSection("menu");
  }

  function subscribe(key) {
    if (subscribed.has(key)) return;
    subscribed.add(key);
    registerSnapshot(onSnapshot(collection(db, inventoryCollections[key]), { includeMetadataChanges: true }, (snapshot) => {
        const wasLoaded = loaded.has(key);
        if (!wasLoaded && snapshot.metadata.fromCache) return;
        if (wasLoaded && !snapshot.docChanges().length) return;
        const data = snapshot.docs.map((entry) => ({ ...entry.data(), id: entry.id }));
        collections[key] = inventoryRecords[key] ? data.filter(inventoryRecords[key]) : data;
        if (collections[key].length !== data.length) reportListenerError("Niepoprawne dokumenty magazynowe", new Error(key));
        loaded.add(key);
        if (key === "stock") {
          stockById = new Map(collections.stock.map((item) => [item.id, item]));
          refreshWithdrawal?.();
        }
        if (key === "orders") indexOrders();
        if (["stock", "recipes", "methods", "orders"].includes(key)) refreshRegistry();
        changes.get(key)?.();
        if (["history", "archive"].includes(section) && ["stock", "events"].includes(key)) refresh();
        if (visibleCard && ["stock", "events"].includes(key)) showCard(visibleCard, false);
    }, (error) => reportListenerError("Magazyn", error)));
  }

  function bind(rerender) {
    refreshRegistry = rerender;
  }

  function fields(lot = {}, editing = false, linkedReceipt = false) {
    const fieldGroup = createElement("div", "lab-stack");
    const size = input("Wielkość opakowania", lot.packageAmount ? formatQuantity(lot.packageAmount, lot.packageUnit).split(/\s+(?=[^\s]+$)/)[0].replace(/\s/g, "") : "");
    const unit = unitSelect(lot.packageUnit);
    const number = input("Numer partii", editing ? lot.lotNumber : "");
    const producer = input("Producent", lot.producer);
    const formula = input("Wzór chemiczny", lot.formula);
    const cas = input("CAS", lot.cas);
    const initial = input("Ilość początkowa", "");
    const usedAsProduct = () => Boolean(lot.orderDescription || lot.orderPackaging)
      || rows("recipes").some((recipe) => recipe.ingredients.some((row) => row.productId === lot.id))
      || rows("methods").some((method) => method.usage.some((row) => row.key === lot.id))
      || lots.some((other) => other.productId === lot.id)
      || rows("orders").some((order) => order.lines.some((row) => row.productId === lot.id));
    const mayLink = editing && ready() && !lot.productId && !withStock(lot).stock && !usedAsProduct();
    if (mayLink) subscribe("orders");
    const link = mayLink ? select([["", "Osobna pozycja"], ...products()
      .filter(([id, other]) => id !== lot.id && (other.category === "Odczynniki") === (lot.category === "Odczynniki"))
      .map(([id, other]) => [id, batchLabel(other)])]) : null;
    number.maxLength = 100;
    producer.maxLength = 200;
    formula.maxLength = 100;
    cas.maxLength = 40;
    const packageFields = createElement("div", "lab-fields");
    packageFields.append(field("Numer partii", number), field("Wielkość opakowania", size), field("Jednostka opakowania", unit));
    fieldGroup.append(createElement("h4", "lab-section-title", "Partia i opakowanie"), packageFields);
    if (!editing) packageFields.append(field("Ilość początkowa (domyślnie pełne opakowanie)", initial));
    else if (withStock(lot).stock) {
      fieldGroup.append(createElement("p", "lab-muted",
        "Stan magazynowy i jego historię znajdziesz w karcie partii."));
    }
    const extra = details("Dane dodatkowe");
    const extraFields = createElement("div", "lab-fields");
    extraFields.append(field("Producent", producer),
      field("Wzór chemiczny", formula), field("CAS", cas));
    if (link) extraFields.append(field("Powiąż tylko z identycznym wariantem handlowym", link));
    extra.append(extraFields);
    fieldGroup.append(extra);
    const orderRootId = lot.id ? productId(lot) : "";
    const orderProduct = registryById.get(orderRootId) || lot;
    const order = details("Dane do zamówienia");
    const description = createElement("textarea");
    description.rows = 5;
    description.maxLength = orderDescriptionLimit;
    description.value = orderProduct.orderDescription || "";
    const orderPackage = orderProduct.orderPackaging;
    const orderSize = input("Wielkość zamawianego opakowania",
      orderPackage ? formatQuantity(orderPackage.amount, orderPackage.unit).split(/\s+(?=[^\s]+$)/)[0].replace(/\s/g, "") : "");
    orderSize.inputMode = "decimal";
    const orderUnit = unitSelect(orderPackage?.unit);
    const orderCount = input("Domyślna liczba zamawianych opakowań", orderProduct.orderPackages || 1, "number");
    orderCount.min = "1";
    orderCount.max = "10000";
    const originalOrder = [description.value, orderSize.value, orderUnit.value, orderCount.value];
    const orderFields = createElement("div", "lab-fields");
    orderFields.append(field("Wielkość zamawianego opakowania", orderSize), field("Jednostka", orderUnit),
      field("Domyślna liczba zamawianych opakowań", orderCount));
    order.append(field("Pełna nazwa i specyfikacja zamówieniowa", description), orderFields,
      createElement("p", "lab-muted", "Dane wspólne dla wszystkich partii produktu. Jeśli nie podasz rozmiaru zakupu, użyjemy zapisanego rozmiaru opakowania z magazynu."));
    if (!linkedReceipt) fieldGroup.append(order);
    link?.addEventListener("change", () => { order.hidden = Boolean(link.value); });
    return {
      node: fieldGroup,
      orderRootId,
      readOrder() {
        if (linkedReceipt || link?.value) return {};
        const result = {};
        const value = description.value.trim();
        if (value !== originalOrder[0]) {
          if (value.length > orderDescriptionLimit) throw new Error("Opis zamówieniowy jest zbyt długi.");
          result.orderDescription = value;
        }
        if (orderSize.value !== originalOrder[1] || orderUnit.value !== originalOrder[2]) {
          if (!orderSize.value.trim() && !orderUnit.value) result.orderPackaging = null;
          else result.orderPackaging = { amount: quantity(orderSize.value, orderUnit.value), unit: orderUnit.value };
        }
        if (orderCount.value !== originalOrder[3]) {
          const count = Number(orderCount.value);
          if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error("Podaj liczbę opakowań od 1 do 10 000.");
          result.orderPackages = count;
        }
        return result;
      },
      initial(packaging) {
        const value = initial.value.trim() ? quantity(initial.value, packaging.packageUnit) : packaging.packageAmount;
        if (value > packaging.packageAmount) throw new Error("Ilość początkowa przekracza wielkość opakowania.");
        return value;
      },
      read() {
        const result = { lotNumber: number.value.trim(), producer: producer.value.trim(), formula: formula.value.trim(), cas: cas.value.trim() };
        if (!editing && !result.lotNumber) throw new Error("Podaj numer przyjmowanej partii.");
        if (size.value.trim() || unit.value || !editing) {
          result.packageUnit = unit.value;
          result.packageAmount = quantity(size.value, unit.value);
        }
        if (link?.value) {
          if (!loaded.has("orders")) throw new Error("Poczekaj na sprawdzenie historii zamówień i ponów zapis.");
          if (usedAsProduct()) throw new Error("Ta pozycja jest już używana jako główny wariant handlowy.");
          result.productId = link.value;
        }
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
      button("Historia", () => showCard(productId(lot))),
    ];
  }

  function archiveActions(item) {
    const lot = withStock(item);
    if (!ready() || (lot.stock && lot.stock.status !== "active")) return [];
    return [
      ...(!lot.expiry || lot.expiry >= formatLocalDate()
        ? [button("Oznacz jako zużyty", () => showAction(lot, "used"), "lab-button-danger")] : []),
      button("Wycofaj", () => showAction(lot, "withdrawn"), "lab-button-danger"),
    ];
  }

  function dismissAction() {
    visibleCard = "";
    refreshWithdrawal = undefined;
    byId("inventoryAction").replaceChildren();
  }

  function showAction(lot, kind, returnToPreparation) {
    if (pendingAction) return;
    visibleCard = "";
    refreshWithdrawal = undefined;
    const destination = byId("inventoryAction");
    const box = createElement("div", "lab-stack");
    const message = createElement("p", "text-xs text-red-700");
    message.setAttribute("role", "status");
    const labels = { opening: "Ustal stan początkowy", opening_correction: "Skoryguj ilość początkową",
      withdrawal: "Zużycie", used: "Oznacz jako zużyty", withdrawn: "Wycofaj partię" };
    box.append(createElement("p", "lab-muted", batchLabel(lot)));
    const choices = kind === "withdrawal" ? validLots(productLots(productId(lot)), lot.stock.unit, formatLocalDate()) : [lot];
    const selected = select(choices.map((batch) => [batch.id, `${batchLabel(batch)} · ${formatPolishDate(batch.expiry)}`]));
    const unit = unitSelect(lot.stock?.unit || lot.packageUnit);
    const amount = input("Ilość");
    amount.inputMode = "decimal";
    const withdrawalUnit = select(Object.keys(units).filter((value) => compatibleUnits(value, lot.stock?.unit))
      .map((value) => [value, value]), lot.stock?.unit);
    const preview = createElement("p", "text-sm");
    preview.setAttribute("role", "status");
    const chosen = () => {
      const item = registryById.get(selected.value);
      const batch = item && withStock(item);
      return batch && validLots([batch], withdrawalUnit.value, formatLocalDate())[0];
    };
    const update = () => {
      const batch = chosen();
      if (!batch) {
        preview.textContent = "Wybrana partia nie jest dostępna. Wybierz inną ważną partię.";
        return;
      }
      try {
        const requested = quantity(amount.value, withdrawalUnit.value);
        const remaining = batch.stock.balance - requested;
        preview.textContent = remaining < 0 ? "Brak wystarczającego zapasu."
          : `Pobranie ${formatQuantity(requested, withdrawalUnit.value)} · po pobraniu ${formatQuantity(remaining, batch.stock.unit)}`;
      } catch { preview.textContent = amount.value.trim() ? "Podaj prawidłową ilość." : `Dostępne ${formatQuantity(batch.stock.balance, batch.stock.unit)}`; }
    };
    if (kind === "withdrawal") {
      const fields = createElement("div", "lab-fields");
      fields.append(field("Ilość pobrania", amount), field("Jednostka pobrania", withdrawalUnit));
      box.append(field("Partia", selected), fields, preview);
      selected.addEventListener("change", update);
      amount.addEventListener("input", update);
      withdrawalUnit.addEventListener("change", update);
      refreshWithdrawal = update;
      update();
    }
    if (kind === "opening") box.append(field("Rzeczywisty stan początkowy", amount), field("Jednostka", unit));
    if (kind === "opening_correction") {
      box.append(createElement("p", "text-sm", `Zapisana ilość początkowa: ${formatQuantity(lot.stock.initial, lot.stock.unit)}. Korekta pojawi się w historii partii.`),
        field(`Prawidłowa ilość początkowa (${lot.stock.unit})`, amount));
    }
    if (["used", "withdrawn"].includes(kind)) box.append(createElement("p", "text-sm", "Partia zostanie zamknięta. Pozostały stan zostanie wyksięgowany, a historia zachowana."));
    const id = store.operationId();
    const footer = createElement("div", "lab-dialog-actions");
    const danger = ["used", "withdrawn"].includes(kind);
    footer.append(button("Anuluj", () => navigation.close(), "lab-button-cancel"), saveButton(danger ? labels[kind] : "Zatwierdź", async () => {
      if (pendingAction) return;
      pendingAction = true;
      try {
        if (kind === "opening") await store.establish(lot.id, quantity(amount.value, unit.value, { zero: true }), unit.value, id);
        else if (kind === "opening_correction") {
          await store.correctOpening(lot.id, quantity(amount.value, lot.stock.unit, { zero: true }), lot.stock.lastEvent, id);
        } else if (kind === "withdrawal") {
          const batch = chosen();
          if (!batch) throw new Error("Wybrana partia nie jest dostępna. Wybierz inną ważną partię.");
          const requested = quantity(amount.value, withdrawalUnit.value);
          if (requested > batch.stock.balance) throw new Error("Brak wystarczającego zapasu.");
          await store.withdraw([{ lotId: batch.id, productId: productId(batch), quantity: requested, unit: withdrawalUnit.value }], { id });
        } else await store.close(lot.id, kind, id);
        navigation.close(true);
        notify("Zapisano operację magazynową.");
      } finally { pendingAction = false; }
    }, message, { danger }));
    box.append(message, footer);
    destination.replaceChildren(box);
    navigation.show(destination, labels[kind], { busy: () => pendingAction, onDismiss: () => {
      dismissAction();
      if (returnToPreparation) queueMicrotask(returnToPreparation);
    } });
  }

  function showCard(id, focus = true) {
    if (pendingAction) return;
    visibleCard = id;
    subscribe("events");
    const destination = byId("inventoryAction");
    const box = createElement("div", "lab-stack");
    const name = products().find(([key]) => key === id)?.[1]?.name || "Karta magazynowa";
    const events = new Map(rows("events").map((event) => [event.id, event]));
    for (const lot of lotsFor(id)) {
      const stock = lot.stock;
      if (stock?.status === "active" && stock.balance === stock.initial && openingSource(events.get(stock.lastEvent))) {
        const correction = createElement("div", "flex flex-wrap items-center gap-2 text-sm");
        correction.append(createElement("span", "", `${batchLabel(lot)} · ważność ${formatPolishDate(lot.expiry)} · ${formatQuantity(stock.initial, stock.unit)}`),
          button("Skoryguj ilość początkową", () => showAction(lot, "opening_correction")));
        box.append(correction);
      }
    }
    panels.get("history")?.(box, id);
    destination.replaceChildren(box);
    if (focus) navigation.show(destination, name, { wide: true, watch: false, onDismiss: dismissAction });
  }

  return {
    store, fields, start, bind, actions, archiveActions, withStock, allLots, lotsFor, products, productOptions, rows, ready, refresh, orderSelections,
    loaded: (key) => loaded.has(key),
    ordersReady: () => loaded.has("orders"),
    activeOrdersFor(lot) {
      const ids = new Set(productLots(productId(lot)).map(productId));
      return [...ids].flatMap((id) => (orderLinesByProduct.get(id) || []).filter(({ line, order, index }) =>
        orderLineMatches(line, { ...lot, productId: id }) && order.status === "ordered" && !orderLineProgress(order, index).complete));
    },
    orderStatus: (lot) => orderStatus([...(orderLinesByLot.get(lot.id) || []), ...legacyOrderEntries(lot)], lot),
    catalogId, productLots, catalogProducts: () => [...catalog.products].map(([id, { product }]) => [id, product]),
    ensureHistory: () => subscribe("events"),
    showOpening: (lot, onSaved) => showAction(lot, "opening", onSaved),
    searchContext(lot) {
      const methods = new Map(rows("methods").map((method) => [method.id, method.name]));
      return rows("recipes").filter((recipe) => recipe.ingredients.some((ingredient) => ingredient.productId === productId(lot)))
        .flatMap((recipe) => [recipe.name, ...recipe.methods.map((id) => methods.get(id))]);
    },
    setLots(value) {
      lots = value;
      registryById = new Map(lots.map((item) => [item.id, item]));
      catalog = indexCatalog(lots);
      byProduct = new Map();
      for (const lot of lots) {
        const key = productId(lot);
        if (!byProduct.has(key)) byProduct.set(key, []);
        byProduct.get(key).push(lot);
      }
      if (section === "history") refresh();
      changes.get("catalog")?.();
    },
    mount(key, render) { panels.set(key, render); },
    onChange(key, callback) { changes.set(key, callback); },
    switchSection,
  };
}
