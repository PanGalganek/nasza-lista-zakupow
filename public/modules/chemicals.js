import { buildChemicalAlerts, calculateCalendarDays, chemicalCategory, chemicalRegistryNumbers, compareChemicalGroups, formatLocalDate, formatPolishDate, groupChemicalItems, parseLocalDate, suggestNextGroupValue } from "../utils.js?v=21";
import { byId, createButton, createElement, createInput, iconButton, notify, runSafely } from "./ui.js?v=21";
import { batchLabel, field, select, showStock } from "./inventory-ui.js?v=21";
import { productId, requireInventoryConnection } from "./inventory-store.js?v=21";
import { availability } from "./inventory-history.js?v=21";
import { matchesInventorySearch } from "./inventory-quantity.js?v=21";
import { renderInventoryAlerts } from "./inventory-alerts.js?v=21";

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
        if (inventory && selectedItems[0].productId) await inventory.store.linkLot(editId, selectedItems[0]);
        else await updateDoc(doc(db, "odczynniki", editId), selectedItems[0]);
      } else if (inventory) {
        const payload = filled.map(([row, fields]) => ({ fields, initial: packageFields.get(row).initial(fields) }));
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

  function createInlineForm(group) {
    const form = createElement("form", "lab-stack");
    form.dataset.inlineChemicalForm = group.key;
    const title = createElement("p", "lab-muted", group.name);
    const fields = createElement("div", "lab-fields");
    const groupInput = createInput("inline-group w-full rounded border p-2 text-sm text-black", "Grupa / numer", suggestNextGroupValue(group.items, group.prefix));
    groupInput.maxLength = 100;
    groupInput.setAttribute("data-form-focus", "");
    const usageInput = createInput("inline-usage w-full rounded border p-2 text-sm text-black", "Zastosowanie", group.items.find((item) => item.usage)?.usage || "");
    usageInput.maxLength = 500;
    const receivedInput = createInput("inline-received w-full rounded border p-2 text-sm text-black", "", formatLocalDate(), "date");
    const expiryInput = createInput("inline-expiry w-full rounded border p-2 text-sm text-black", "", "", "date");
    fields.append(createInlineField("Grupa / numer", groupInput), createInlineField("Zastosowanie", usageInput), createInlineField("Data przyjęcia", receivedInput), createInlineField("Data ważności", expiryInput));
    let packaging;
    let source;
    let receipt;
    if (inventory) {
      const representatives = [...new Map(group.items.slice().sort((a, b) => a.timestamp - b.timestamp).map((item) => [productId(item), item])).entries()];
      source = select(representatives.map(([id, item]) => [id, batchLabel(item)]));
      const box = createElement("div", "lab-field-wide");
      const suggest = () => {
        packaging = inventory.fields(representatives.find(([key]) => key === source.value)?.[1] || {});
        box.replaceChildren(packaging.node);
      };
      source.addEventListener("change", suggest);
      suggest();
      fields.append(field("Pozycja handlowa", source), box);
    }
    const actions = createElement("div", "lab-dialog-actions");
    const cancelButton = createElement("button", "lab-button lab-button-cancel", "Anuluj");
    cancelButton.type = "button";
    cancelButton.addEventListener("click", () => navigation?.close());
    const submitButton = createElement("button", "lab-button lab-button-primary", "Zapisz partię");
    submitButton.type = "submit";
    actions.append(cancelButton, submitButton);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (inlinePending) return;
      runSafely(async () => {
        inlinePending = true;
        submitButton.disabled = true;
        try {
          const data = {
            name: group.name, group: groupInput.value.trim(), usage: usageInput.value.trim(), received: receivedInput.value,
            expiry: expiryInput.value, category: group.category || category, timestamp: Date.now(), ordered: false,
          };
          if (inventory) {
            const values = packaging.read();
            const initial = packaging.initial(values);
            const fingerprint = JSON.stringify([data.name, data.group, data.usage, data.received, data.expiry, data.category, values, source.value, initial]);
            if (receipt?.fingerprint !== fingerprint) receipt = { fingerprint, id: inventory.store.operationId() };
            await inventory.store.receive([{ fields: { ...data, ...values, productId: source.value }, initial }], receipt.id);
          } else await addDoc(collection(db, "odczynniki"), data);
          navigation?.close(true);
          notify("Zapisano nową partię.");
        } finally { submitButton.disabled = false; inlinePending = false; }
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
      if (statusFilter === "ordered") return item.ordered === true;
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
      const wasOpen = expanded.has(group.key);
      card.open = wasOpen;
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
      controls.append(createButton("Nowa partia", `Dodaj nową pozycję do ${group.name}`, () => {
        if (inlinePending) return;
        const form = createInlineForm(group);
        navigation?.show(form, "Nowa partia", { busy: () => inlinePending });
      }, "lab-button lab-button-primary"));
      card.append(controls);

      group.items.forEach((item) => {
        const expiryDate = item.expiry ? parseLocalDate(item.expiry) : null;
        const days = expiryDate ? calculateCalendarDays(new Date(), expiryDate) : null;
        const color = days !== null && days < 0 ? "text-red-700 font-semibold"
          : days !== null && days <= (chemicalCategory(item) === "Odczynniki" ? 70 : 40) ? "text-amber-800 font-semibold" : "lab-muted";
        const row = createElement("div", `${item.ordered ? "ordered-row " : ""}lab-lot`);
        const info = createElement("div", "lab-lot-info");
        info.append(createElement("strong", "", item.lotNumber ? `Partia ${item.lotNumber}` : item.group || "Partia bez numeru"));
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
          navigation ? iconButton(item.ordered ? "check" : "cart", orderLabel, order) : createButton("Zamówienie", orderLabel, order));
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
        (item) => item.category === "Odczynniki" ? 70 : 40, inventory, editFromAlert);
    }
    else {
      const alerts = buildChemicalAlerts(categoryItems, threshold);
      alerts.forEach((alertData) => alertBox.append(renderAlert(alertData)));
      alertBox.classList.toggle("hidden", alerts.length === 0);
    }
  }

  function editFromAlert(item) {
    const target = item.category === "Odczynniki" ? "Odczynniki" : "Wzorce";
    if (category !== target) switchSubTab(target);
    startEdit(item);
  }

  function switchSubTab(target) {
    category = target;
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
  }

  return {
    actions: {
      addFormRow, cancelEdit, openForm, saveItems, switchSubTab,
    },
    bind, initializeForm: cancelEdit, start,
  };
}
