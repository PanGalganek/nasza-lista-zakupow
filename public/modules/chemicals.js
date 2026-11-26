import { buildChemicalAlerts, calculateCalendarDays, chemicalCategory, chemicalRegistryNumbers, compareChemicalGroups, formatLocalDate, formatPolishDate, groupChemicalItems, parseLocalDate, suggestNextGroupValue, suggestStandardNumber } from "../utils.js?v=31";
import { byId, createButton, createElement, createInput, iconButton, notify, runSafely } from "./ui.js?v=31";
import { batchLabel, field, orderBadge, select, showStock } from "./inventory-ui.js?v=31";
import { productId, requireInventoryConnection } from "./inventory-store.js?v=31";
import { availability } from "./inventory-history.js?v=31";
import { matchesInventorySearch } from "./inventory-quantity.js?v=31";
import { renderInventoryAlerts, warsawDate } from "./inventory-alerts.js?v=31";
import { orderPackageCount, orderLineProgress, orderRecordedDate, standardKind } from "./inventory-items.js?v=31";

export function createChemicalsModule({ db, firestore, registerSnapshot, reportListenerError, inventory, navigation }) {
  const { addDoc, collection, doc, onSnapshot, orderBy, query, updateDoc, writeBatch } = firestore;
  let items = [];
  let category = "Wzorce";
  let editCategory = null;
  let formRowCount = 0;
  const packageFields = new WeakMap();
  const expanded = new Set();
  let receiptDraft;
  let inlinePending = false;
  let updateDeliveryForm;
  let highlightedLot = "";
  let pendingLotFocus = false;
  let warningPosition;

  function createInlineField(labelText, input, className = "") {
    const label = createElement("label", className || "lab-field");
    label.append(createElement("span", "", labelText), input);
    return label;
  }

  function addFormRow(data = null) {
    formRowCount += 1;
    const container = byId("dynamicItemsContainer");
    const row = createElement("div", "lab-panel lab-registration");
    row.dataset.rowId = String(formRowCount);
    const header = createElement("div", "lab-inline-header");
    header.append(createElement("h3", "", `Pozycja ${formRowCount}`));
    if (container.children.length > 0) header.append(createButton("Usuń", "Usuń pozycję z formularza", () => row.remove(), "lab-button lab-button-danger"));

    const name = createInput("chem-name", "Nazwa", data?.name);
    name.setAttribute("data-form-focus", "");
    name.maxLength = 200;
    const groupRow = createElement("div", "lab-fields");
    const group = createInput("chem-group", "Grupa (np. II-4/31)", data?.group);
    group.maxLength = 100;
    const usage = createInput("chem-usage", "Zastosowanie", data?.usage);
    usage.maxLength = 500;
    groupRow.append(createInlineField("Grupa / oznaczenie", group), createInlineField("Zastosowanie", usage));
    const dateRow = createElement("div", "lab-fields");
    dateRow.append(createInlineField("Data przyjęcia", createInput("chem-received", "", data?.received ?? formatLocalDate(), "date")),
      createInlineField("Termin ważności", createInput("chem-expiry", "", data?.expiry, "date")));
    row.append(header, createElement("h4", "lab-section-title", "Dane podstawowe"), createInlineField("Nazwa", name), groupRow,
      createElement("h4", "lab-section-title", "Daty partii"), dateRow);
    if (inventory) {
      const packaging = inventory.fields(data || {}, Boolean(data));
      packageFields.set(row, packaging);
      row.append(packaging.node);
    }
    container.append(row);
  }

  function payloadFromRow(row) {
    const fields = {
      name: row.querySelector(".chem-name").value.trim(), group: row.querySelector(".chem-group").value.trim(),
      usage: row.querySelector(".chem-usage").value.trim(), received: row.querySelector(".chem-received").value,
      expiry: row.querySelector(".chem-expiry").value, category: editCategory ?? category,
    };
    if (fields.name && inventory) Object.assign(fields, packageFields.get(row).read());
    return fields;
  }

  async function saveItems() {
    const submitButton = byId("submitBtn");
    if (submitButton.disabled) return;

    const filled = [...byId("dynamicItemsContainer").children].map((row) => [row, payloadFromRow(row)]).filter(([, item]) => item.name);
    const selectedItems = filled.map(([, item]) => item);
    if (selectedItems.length === 0) {
      notify("Podaj nazwę co najmniej jednej pozycji.", true);
      return;
    }
    const editId = byId("editId").value;
    submitButton.disabled = true;
    try {
      if (editId) {
        if (selectedItems.length !== 1) throw new Error("Edycja wymaga dokładnie jednego wiersza.");
        if (inventory) requireInventoryConnection();
        const packaging = packageFields.get(filled[0][0]);
        const order = packaging?.readOrder() || {};
        const orderRoot = packaging?.orderRootId;
        if (inventory && selectedItems[0].productId) await inventory.store.linkLot(editId, selectedItems[0]);
        else if (orderRoot && orderRoot !== editId && Object.keys(order).length) {
          const batch = writeBatch(db);
          batch.update(doc(db, "odczynniki", editId), selectedItems[0]);
          batch.update(doc(db, "odczynniki", orderRoot), order);
          await batch.commit();
        } else {
          Object.assign(selectedItems[0], order);
          await updateDoc(doc(db, "odczynniki", editId), selectedItems[0]);
        }
      } else if (inventory) {
        const payload = filled.map(([row, fields]) => {
          const packaging = packageFields.get(row);
          return { fields: { ...fields, ...packaging.readOrder() }, initial: packaging.initial(fields) };
        });
        const fingerprint = JSON.stringify(payload);
        if (receiptDraft?.fingerprint !== fingerprint) receiptDraft = { fingerprint, id: inventory.store.operationId() };
        await inventory.store.receive(payload.map(({ fields, initial }, index) => ({
          fields: { ...fields, timestamp: Date.now() + index, ordered: false }, initial,
        })), receiptDraft.id);
      } else {
        const batch = writeBatch(db);
        selectedItems.forEach((item, index) => batch.set(doc(collection(db, "odczynniki")), { ...item, timestamp: Date.now() + index, ordered: false }));
        await batch.commit();
      }
      if (navigation) { navigation.close(true); notify("Zapisano pozycję."); }
      else cancelEdit();
    } finally {
      submitButton.disabled = false;
    }
  }

  function startEdit(item) {
    editCategory = item.category || "Wzorce";
    byId("editId").value = item.id;
    byId("dynamicItemsContainer").replaceChildren();
    formRowCount = 0;
    addFormRow(item);
    byId("addFormRowBtn").classList.add("hidden");
    byId("submitBtn").textContent = "Zapisz zmiany";
    presentForm("Edytuj partię");
  }

  function presentForm(title) {
    navigation?.show(byId("formContainer"), title, { onDismiss: cancelEdit, busy: () => byId("submitBtn").disabled });
  }

  function openForm() {
    cancelEdit();
    presentForm(category === "Odczynniki" ? "Dodaj odczynnik" : "Dodaj wzorzec");
  }

  function cancelEdit() {
    receiptDraft = null;
    editCategory = null;
    byId("editId").value = "";
    byId("addFormRowBtn").classList.remove("hidden");
    byId("submitBtn").textContent = "Zapisz wszystko";
    byId("dynamicItemsContainer").replaceChildren();
    formRowCount = 0;
    addFormRow();
  }

  function renderAlert(alertData) {
    const styles = {
      backup: "bg-green-50 border border-green-200 text-green-800 p-2 rounded shadow-sm flex items-center gap-2 font-bold",
      ordered: "bg-green-100 border border-green-200 text-green-800 p-2 rounded shadow-sm flex items-center gap-2 font-bold",
      expired: "bg-red-100 border border-red-200 text-red-800 p-2 rounded shadow-sm flex items-center gap-2 font-bold",
      warning: "bg-orange-100 border border-orange-200 text-orange-800 p-2 rounded shadow-sm flex items-center gap-2 font-bold",
    };
    const icons = { backup: "🛡️", ordered: "✅", expired: "⛔", warning: "⚠️" };
    let message = `[${alertData.prefix}] ${alertData.name}`;
    if (alertData.type === "backup") message += ` — jest zapasowa pozycja ważna do ${formatPolishDate(alertData.date)}`;
    if (alertData.type === "ordered") message += " — ZAMÓWIONO";
    if (alertData.type === "expired") message += ` — TERMIN MINĄŁ ${formatPolishDate(alertData.date)}`;
    if (alertData.type === "warning") message += ` — ważny do ${formatPolishDate(alertData.date)}`;
    const row = createElement("div", styles[alertData.type]);
    const editButton = createButton(
      "✏️ Edytuj",
      `Edytuj pozycję ${alertData.item.group || alertData.name}`,
      () => startEdit(alertData.item),
      "lab-button",
    );
    row.append(
      createElement("span", "text-[14px]", icons[alertData.type]),
      createElement("span", "min-w-0 flex-1", message),
      editButton,
    );
    return row;
  }

  function openNewLot(group, sourceLot) {
    if (inlinePending) return;
    navigation?.show(createInlineForm(group, sourceLot), "Nowa partia", {
      busy: () => inlinePending, onDismiss: () => { updateDeliveryForm = undefined; },
    });
  }

  function createInlineForm(group, sourceLot) {
    const form = createElement("form", "lab-stack");
    form.dataset.inlineChemicalForm = group.key;
    const title = createElement("p", "lab-muted", [group.lp && `LP ${group.lp}`, group.name].filter(Boolean).join(" · "));
    const fields = createElement("div", "lab-fields");
    const isStandard = (group.category || category) !== "Odczynniki";
    const groupInput = createInput("inline-group w-full rounded border p-2 text-sm text-black", "Grupa / numer",
      isStandard ? "" : (sourceLot?.group ?? suggestNextGroupValue(group.items, group.prefix)));
    groupInput.maxLength = 100;
    groupInput.setAttribute("data-form-focus", "");
    const priorNumber = createElement("strong");
    const numberHelp = createElement("p", "lab-muted lab-field-wide");
    numberHelp.id = "standardNumberHelp";
    let proposedNumber = "";
    let proposalMessage = "";
    const setStandardNumber = (part) => {
      priorNumber.textContent = part?.group || "Brak numeru";
      const { value, mode } = suggestStandardNumber(part?.group, items.filter((item) => chemicalCategory(item) === "Wzorce"));
      proposedNumber = value;
      groupInput.value = proposedNumber;
      proposalMessage = {
        incremented: "Numer automatycznie zwiększony o 1. Możesz go zmienić.",
        afterHighest: "Numer automatycznie zwiększony o 1 względem najwyższego numeru w tej serii. Możesz go zmienić.",
        copied: "Oznaczenie skopiowane jako numer grupy. Możesz je zmienić.",
        manual: "Brak jednoznacznej propozycji. Wpisz numer ręcznie.",
      }[mode];
      numberHelp.textContent = proposalMessage;
    };
    if (isStandard) {
      const number = createElement("div", "lab-field");
      number.append(createElement("span", "", "Dotychczasowy numer wzorca"), priorNumber);
      groupInput.setAttribute("aria-describedby", numberHelp.id);
      numberHelp.setAttribute("aria-live", "polite");
      groupInput.addEventListener("input", () => {
        numberHelp.textContent = groupInput.value.trim() === proposedNumber
          ? proposalMessage : "Numer wprowadzono ręcznie.";
      });
      fields.append(number, createInlineField("Proponowany numer nowego wzorca", groupInput), numberHelp);
      if (!inventory) setStandardNumber(sourceLot || group.items[0]);
    } else fields.append(createInlineField("Grupa / numer", groupInput));
    const usageInput = createInput("inline-usage w-full rounded border p-2 text-sm text-black", "Zastosowanie",
      sourceLot?.usage ?? group.items.find((item) => item.usage)?.usage ?? "");
    usageInput.maxLength = 500;
    const receivedInput = createInput("inline-received w-full rounded border p-2 text-sm text-black", "", formatLocalDate(), "date");
    const expiryInput = createInput("inline-expiry w-full rounded border p-2 text-sm text-black", "", "", "date");
    fields.append(createInlineField("Zastosowanie", usageInput), createInlineField("Data przyjęcia", receivedInput), createInlineField("Data ważności", expiryInput));
    let packaging;
    let source;
    let receipt;
    let readDelivery = () => null;
    const submitButton = createElement("button", "lab-button lab-button-primary", "Zapisz partię");
    submitButton.type = "submit";
    if (inventory) {
      const representatives = new Map();
      for (const part of sourceLot ? [sourceLot] : [...group.items].sort((a, b) => b.timestamp - a.timestamp)) {
        const key = JSON.stringify([inventory.catalogId(productId(part)), standardKind(part)]);
        if (!representatives.has(key)) representatives.set(key, part);
      }
      source = select([...representatives].map(([key, item]) => [key, batchLabel(item)]));
      const box = createElement("div", "lab-field-wide");
      const deliveryBox = createElement("div", "lab-field-wide lab-stack");
      const noOrder = "Bez powiązania z zamówieniem";
      const orderChoice = select([["", noOrder]]);
      const keyFor = ({ order, index }) => JSON.stringify([order.id, index]);
      let selectedKey = "";
      let retained;
      let delivery;
      let optionSignature;
      let independent = false;
      const complete = createInput("", "", "", "checkbox");
      const completeField = field("To ostatnie opakowanie z tej pozycji zamówienia", complete);
      const progress = createElement("p", "lab-muted");
      progress.setAttribute("role", "status");
      const connection = createElement("p", "lab-muted", "Brak połączenia. Zapis będzie dostępny po ponownym połączeniu.");
      connection.setAttribute("role", "status");
      const choiceField = field("Powiąż dostawę z zamówieniem", orderChoice);
      const unlink = createButton("Potwierdź dodanie bez zamówienia", "Potwierdź dodanie bez zamówienia", () => {
        selectedKey = "";
        retained = undefined;
        independent = true;
        complete.checked = false;
        updateChoices();
      }, "lab-button");
      deliveryBox.append(choiceField, progress, completeField, unlink, connection);

      function updateChoices() {
        const ready = inventory.ordersReady();
        const online = navigator.onLine;
        const part = representatives.get(source.value);
        const orders = ready ? inventory.activeOrdersFor(part).sort((a, b) => (b.order.orderedAt?.seconds || 0) - (a.order.orderedAt?.seconds || 0)
          || a.order.id.localeCompare(b.order.id) || a.index - b.index) : [];
        delivery = orders.find((entry) => keyFor(entry) === selectedKey);
        if (delivery) retained = delivery;
        const blocked = Boolean(selectedKey && !delivery);
        const latest = blocked && retained && inventory.rows("orders").find((order) => order.id === retained.order.id);
        const fulfilled = latest && orderLineProgress(latest, retained.index).complete;
        const options = [["", noOrder], ...orders.map((entry, i) => [keyFor(entry), [
          orderRecordedDate(entry.order, "orderedAt"), entry.order.requester,
          entry.line.standardKind ? `(${entry.line.standardKind})` : "",
          `zamówienie ${i + 1}, poz. ${entry.index + 1}`,
        ].filter(Boolean).join(" · ")])];
        if (blocked) options.push([selectedKey, fulfilled ? "Zamówienie zrealizowane" : "Wybrane zamówienie niedostępne"]);
        const signature = JSON.stringify(options);
        if (signature !== optionSignature) {
          orderChoice.replaceChildren(...select(options).children);
          optionSignature = signature;
        }
        orderChoice.options[0].disabled = blocked;
        if (blocked) orderChoice.options[orderChoice.options.length - 1].disabled = true;
        if (orderChoice.value !== selectedKey) orderChoice.value = selectedKey;
        const expected = delivery && orderPackageCount(delivery.line);
        const received = delivery ? orderLineProgress(delivery.order, delivery.index).received : 0;
        choiceField.hidden = !orders.length && !blocked;
        completeField.hidden = !delivery || expected !== null;
        unlink.hidden = !blocked;
        unlink.disabled = inlinePending;
        connection.hidden = online;
        let message = "";
        if (!ready) message = "Wczytywanie aktywnych zamówień…";
        else if (blocked) message = fulfilled ? "Zamówienie zostało już zrealizowane" : "Wybrana pozycja zamówienia jest niedostępna.";
        else if (delivery) message = expected === null
          ? `Przyjęto opakowań: ${received}. Zamówienie nie zawiera liczby opakowań.`
          : `Przyjęto ${received} z ${expected} opakowań. Zapis przyjmie kolejne opakowanie.`;
        else if (independent) message = "Partia zostanie zapisana bez powiązania z zamówieniem.";
        if (progress.textContent !== message) progress.textContent = message;
        progress.hidden = !message;
        deliveryBox.hidden = choiceField.hidden && progress.hidden && connection.hidden;
        submitButton.disabled = inlinePending || blocked || !ready || !online;
      }

      orderChoice.addEventListener("change", () => {
        if (!selectedKey || orderChoice.value || !orderChoice.options[0].disabled) {
          selectedKey = orderChoice.value;
          retained = undefined;
          independent = false;
          complete.checked = false;
        }
        updateChoices();
      });
      const suggest = () => {
        const part = representatives.get(source.value);
        if (isStandard) setStandardNumber(part);
        const history = inventory.productLots(productId(part)).filter((lot) => standardKind(lot) === standardKind(part));
        const previous = history.filter((lot) => lot.packageAmount).sort((a, b) => b.timestamp - a.timestamp)[0];
        const root = history.find((lot) => lot.id === inventory.catalogId(productId(part)));
        const pack = part.packageAmount ? part : previous;
        packaging = inventory.fields({ ...part, packageAmount: pack?.packageAmount, packageUnit: pack?.packageUnit,
          producer: part.producer || root?.producer, formula: part.formula || root?.formula, cas: part.cas || root?.cas }, false, true);
        box.replaceChildren(packaging.node);
        if (!sourceLot) usageInput.value = part.usage || "";
        selectedKey = "";
        retained = undefined;
        independent = false;
        complete.checked = false;
        updateChoices();
      };
      source.addEventListener("change", suggest);
      updateDeliveryForm = updateChoices;
      suggest();
      if (representatives.size > 1) fields.append(field("Pozycja handlowa", source));
      fields.append(box, deliveryBox);
      readDelivery = () => delivery ? { orderId: delivery.order.id, lineIndex: delivery.index, complete: complete.checked,
        kind: standardKind(representatives.get(source.value)) } : null;
    }
    const actions = createElement("div", "lab-dialog-actions");
    const cancelButton = createElement("button", "lab-button lab-button-cancel", "Anuluj");
    cancelButton.type = "button";
    cancelButton.addEventListener("click", () => navigation?.close());
    actions.append(cancelButton, submitButton);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (inlinePending || submitButton.disabled) return;
      runSafely(async () => {
        inlinePending = true;
        submitButton.disabled = true;
        try {
          const data = {
            name: group.name, group: groupInput.value.trim(), usage: usageInput.value.trim(), received: receivedInput.value,
            expiry: expiryInput.value, category: group.category || category, timestamp: Date.now(), ordered: false,
          };
          if (inventory) {
            requireInventoryConnection();
            if (!inventory.ordersReady()) throw new Error("Poczekaj na wczytanie aktywnych zamówień i ponów zapis.");
            const values = packaging.read();
            const initial = packaging.initial(values);
            const [product] = JSON.parse(source.value);
            const deliveryLink = readDelivery();
            const fingerprint = JSON.stringify([data.name, data.group, data.usage, data.received, data.expiry, data.category, values, source.value, initial, deliveryLink]);
            if (receipt?.fingerprint !== fingerprint) receipt = { fingerprint, id: inventory.store.operationId() };
            await inventory.store.receive([{ fields: { ...data, ...values, productId: inventory.catalogId(product) }, initial }], receipt.id, deliveryLink);
          } else await addDoc(collection(db, "odczynniki"), data);
          navigation?.close(true);
          notify("Zapisano nową partię.");
        } finally {
          inlinePending = false;
          submitButton.disabled = false;
          updateDeliveryForm?.();
        }
      }, "Nie udało się dodać nowej pozycji.");
    });
    form.append(title, fields, actions);
    return form;
  }

  function earliestExpiry(group) {
    return group.items.map((item) => String(item.expiry || "")).filter(Boolean).sort()[0] || "9999-12-31";
  }

  function normalizeSearch(value) {
    return String(value || "").toLocaleLowerCase("pl").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l");
  }

  function render(refreshWarnings = true) {
    const container = byId("chemicalListGrouped");
    const alertBox = byId("alertBox");
    updateDeliveryForm?.();
    container.replaceChildren();
    if (!inventory) alertBox.replaceChildren();
    const activeItems = items.filter((item) => !inventory || ["active", undefined].includes(inventory.withStock(item).stock?.status));
    const searchQuery = normalizeSearch(byId("chemicalSearch").value.trim());
    const categoryItems = activeItems.filter((item) => {
      const itemCategory = item.category || "Wzorce";
      return searchQuery || itemCategory === category || (category === "Wzorce" && itemCategory === "Standardowe");
    });
    const threshold = category === "Odczynniki" ? 70 : 40;
    const statusFilter = byId("chemicalStatusFilter").value;
    const sortMode = byId("chemicalSort").value;
    const partition = (list, kind) => groupChemicalItems(list.filter((item) => chemicalCategory(item) === kind))
      .map((group) => ({ ...group, category: kind, key: `${kind}:${group.key}` }));
    const categories = ["Wzorce", "Odczynniki"];
    const lpByItem = chemicalRegistryNumbers(activeItems);
    const filtered = categoryItems.filter((item) => {
      if (searchQuery && !matchesInventorySearch(searchQuery, item.name, item.group, item.usage, item.lotNumber, `LP ${lpByItem.get(item.id)}`,
        item.producer, item.formula, item.cas, ...(inventory?.searchContext(item) || []))) return false;
      const expiryDate = item.expiry ? parseLocalDate(item.expiry) : null;
      const days = expiryDate ? calculateCalendarDays(new Date(), expiryDate) : null;
      if (statusFilter === "attention") return days !== null && days <= (chemicalCategory(item) === "Odczynniki" ? 70 : 40);
      if (statusFilter === "ordered") return inventory ? inventory.orderStatus(item).state === "ordered" : item.ordered === true;
      if (statusFilter === "expired") return days !== null && days < 0;
      return true;
    });

    const sortedGroups = categories.flatMap((kind) => partition(filtered, kind)).sort((a, b) => {
      if (sortMode === "name") return a.name.localeCompare(b.name, "pl", { sensitivity: "base" }) || a.prefix.localeCompare(b.prefix, "pl", { numeric: true, sensitivity: "base" });
      if (sortMode === "expiry") return earliestExpiry(a).localeCompare(earliestExpiry(b)) || a.name.localeCompare(b.name, "pl", { sensitivity: "base" });
      return compareChemicalGroups(a, b);
    });

    sortedGroups.forEach((group) => {
      group.items.sort((a, b) => sortMode === "expiry" ? String(a.expiry || "9999-12-31").localeCompare(String(b.expiry || "9999-12-31")) : String(a.group || "").localeCompare(String(b.group || ""), "pl", { numeric: true }));
      const card = createElement("details", "lab-accordion lab-product");
      if (pendingLotFocus && group.items.some((item) => item.id === highlightedLot)) expanded.add(group.key);
      card.open = expanded.has(group.key);
      card.addEventListener("toggle", () => {
        if (card.open) expanded.add(group.key);
        else expanded.delete(group.key);
      });
      const primary = group.items[0];
      const summary = createElement("summary", "lab-product-summary");
      const name = createElement("span", "lab-product-name");
      name.append(createElement("span", "lab-chip", `LP ${lpByItem.get(primary.id)}`), createElement("span", "", group.name));
      const sub = createElement("span", "lab-product-summary-info");
      const expiry = earliestExpiry(group);
      const identifiers = [group.items.length === 1 ? primary.group : group.prefix, expiry === "9999-12-31" ? "Brak terminu" : `Ważność: ${formatPolishDate(expiry)}`];
      if (group.items.length > 1) identifiers.push(`${group.items.length} partie`);
      if (searchQuery) identifiers.push(group.category);
      sub.append(createElement("span", "", identifiers.filter(Boolean).join(" · ")));
      if (expiry < formatLocalDate()) sub.append(createElement("span", "text-red-700 font-semibold", "Po terminie"));
      const productIds = [...new Set(group.items.map(productId))];
      if (inventory) {
        if (!inventory.ready()) sub.append(createElement("span", "", "Wczytywanie stanu…"));
        else if (group.items.length === 1) sub.append(showStock(inventory.withStock(primary), { compact: true }));
        else if (productIds.length === 1) {
          const total = availability(inventory.lotsFor(productIds[0]));
          sub.append(createElement("span", "", total === "—" ? "Zapas w szczegółach partii" : `Dostępny zapas ${total}`));
        }
      }
      summary.append(name, sub);
      card.append(summary);
      const controls = createElement("div", "lab-actions");
      controls.append(createButton("Nowa partia", `Dodaj nową pozycję do ${group.name}`, () => openNewLot(group), "lab-button lab-button-primary"));
      card.append(controls);

      group.items.forEach((item) => {
        const expiryDate = item.expiry ? parseLocalDate(item.expiry) : null;
        const days = expiryDate ? calculateCalendarDays(new Date(), expiryDate) : null;
        const color = days !== null && days < 0 ? "text-red-700 font-semibold"
          : days !== null && days <= (chemicalCategory(item) === "Odczynniki" ? 70 : 40) ? "text-amber-800 font-semibold" : "lab-muted";
        const state = inventory?.orderStatus(item);
        const row = createElement("div", `${(state ? state.state === "ordered" : item.ordered) ? "ordered-row " : ""}lab-lot`);
        const info = createElement("div", "lab-lot-info");
        info.append(createElement("strong", "", item.lotNumber ? `Partia ${item.lotNumber}` : item.group || "Partia bez numeru"));
        if (item.id === highlightedLot) {
          row.classList.add("lab-lot-highlighted");
          row.tabIndex = -1;
          row.setAttribute("role", "group");
          row.setAttribute("aria-label", `Partia z ostrzeżenia: ${batchLabel(item)}`);
          info.append(createElement("span", "lab-chip", "Partia z ostrzeżenia"));
          if (pendingLotFocus) {
            requestAnimationFrame(() => {
              if (!pendingLotFocus || !row.getClientRects().length || highlightedLot !== item.id) return;
              pendingLotFocus = false;
              row.focus({ preventScroll: true });
              row.scrollIntoView({ block: "center", behavior: "instant" });
            });
          }
        }
        const expiryLine = createElement("span", color);
        expiryLine.append(document.createTextNode("Ważność: "), createElement("span", "", formatPolishDate(item.expiry)));
        if (days !== null) expiryLine.append(document.createTextNode(days < 0 ? " · po terminie" : ` · ${days} dni`));
        info.append(expiryLine);
        if (item.usage) info.append(createElement("span", "lab-muted", item.usage));
        if (inventory) info.append(inventory.ready() ? showStock(inventory.withStock(item)) : createElement("span", "", "Wczytywanie stanu…"));
        const actions = createElement("div", "lab-lot-actions");
        const orderLabel = item.ordered ? "Cofnij oznaczenie zamówienia" : "Oznacz jako zamówione";
        const order = async () => {
          if (inventory) requireInventoryConnection();
          await updateDoc(doc(db, "odczynniki", item.id), { ordered: !item.ordered });
          notify(item.ordered ? "Cofnięto oznaczenie zamówienia." : "Oznaczono jako zamówione.");
        };
        const edit = () => startEdit(item);
        actions.append(...(inventory?.actions(item) || []),
          createButton("Edytuj", "Edytuj pozycję", edit, "lab-button"),
          state ? orderBadge(state, () => runSafely(order, "Nie udało się zmienić statusu zamówienia."))
            : navigation ? iconButton(item.ordered ? "check" : "cart", orderLabel, order) : createButton("Zamówienie", orderLabel, order));
        row.append(info, actions);
        const archive = inventory?.archiveActions(item) || [];
        if (archive.length) {
          const advanced = createElement("details", "lab-lot-danger");
          advanced.append(createElement("summary", "", "Zamknięcie partii"));
          const buttons = createElement("div", "lab-actions");
          buttons.append(...archive);
          advanced.append(buttons);
          row.append(advanced);
        }
        card.append(row);
      });
      container.append(card);
    });
    byId("chemicalResultSummary").textContent = `Pozycje: ${filtered.length} • Grupy: ${sortedGroups.length}`;
    if (sortedGroups.length === 0) container.append(createElement("p", "rounded-lg border border-dashed bg-gray-50 p-6 text-center text-sm text-gray-500", "Brak pozycji spełniających kryteria."));
    if (inventory) {
      if (refreshWarnings) renderInventoryAlerts(alertBox, activeItems.map(inventory.withStock),
        (item) => item.category === "Odczynniki" ? 70 : 40, inventory, (item) => newLotFromAlert(item, lpByItem.get(item.id)), lpByItem,
        openPositionFromAlert);
    }
    else {
      const alerts = buildChemicalAlerts(categoryItems, threshold);
      alerts.forEach((alertData) => alertBox.append(renderAlert(alertData)));
      alertBox.classList.toggle("hidden", alerts.length === 0);
    }
  }

  function newLotFromAlert(item, lp) {
    openNewLot({ name: item.name, category: chemicalCategory(item), items: [item], lp }, item);
  }

  function openPositionFromAlert(item) {
    const box = byId("alertBox");
    warningPosition = {
      menuOpen: byId("warningCenter").open,
      categories: new Map([...box.querySelectorAll("details[data-warning]")].map((element) => [element.dataset.warning, element.open])),
    };
    navigation.go(chemicalCategory(item) === "Odczynniki" ? "inventory/chemicals" : "inventory/standards", item.id);
  }

  function showWarnings(dedicated, restore) {
    const box = byId("alertBox");
    const destination = byId(dedicated ? "warningScreen" : "warningCenter");
    const moved = box.parentElement !== destination;
    if (moved) destination.append(box);
    if (!moved && !restore) return;
    for (const category of box.querySelectorAll("details[data-warning]")) {
      category.open = (restore ? warningPosition?.categories.get(category.dataset.warning) : undefined) ?? dedicated;
    }
    if (!dedicated) destination.open = Boolean(restore && warningPosition?.menuOpen);
  }

  function switchSubTab(target, lotId = "") {
    category = target;
    highlightedLot = lotId;
    pendingLotFocus = Boolean(lotId);
    if (lotId) {
      byId("chemicalSearch").value = "";
      byId("chemicalStatusFilter").value = "all";
    }
    render();
  }

  function start() {
    registerSnapshot(onSnapshot(
      query(collection(db, "odczynniki"), orderBy("timestamp", "asc")),
      (snapshot) => {
        items = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
        inventory?.setLots(items);
        render();
      },
      (error) => reportListenerError("Odczynniki", error),
    ));
  }

  function bind() {
    inventory?.bind(render);
    byId("chemicalSearch").addEventListener("input", () => render(false));
    byId("chemicalStatusFilter").addEventListener("change", () => render(false));
    byId("chemicalSort").addEventListener("change", () => render(false));
    if (inventory) {
      for (const event of ["online", "offline"]) window.addEventListener(event, () => updateDeliveryForm?.());
      let day = warsawDate();
      const refreshDate = () => {
        const current = warsawDate();
        if (document.hidden || byId("appSection").classList.contains("hidden") || current === day) return;
        day = current;
        render();
      };
      document.addEventListener("visibilitychange", refreshDate);
      setInterval(refreshDate, 30_000);
    }
  }

  return {
    actions: {
      addFormRow, cancelEdit, openForm, saveItems, switchSubTab, showWarnings,
    },
    bind, initializeForm: cancelEdit, start,
  };
}
