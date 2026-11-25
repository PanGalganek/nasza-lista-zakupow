import { buildChemicalAlerts, calculateCalendarDays, formatLocalDate, formatPolishDate, groupChemicalItems, parseLocalDate, suggestNextGroupValue } from "../utils.js?v=16";
import { byId, createButton, createElement, createInput, runSafely } from "./ui.js?v=16";
import { batchLabel, field, select, showStock } from "./inventory-ui.js?v=16";
import { productId, requireInventoryConnection } from "./inventory-store.js?v=16";
import { availability } from "./inventory-history.js?v=16";
import { matchesInventorySearch } from "./inventory-quantity.js?v=16";
import { renderInventoryAlerts } from "./inventory-alerts.js?v=16";

export function createChemicalsModule({ db, firestore, registerSnapshot, reportListenerError, inventory }) {
  const { addDoc, collection, doc, onSnapshot, orderBy, query, updateDoc, writeBatch } = firestore;
  let items = [];
  let category = "Wzorce";
  let editCategory = null;
  let formRowCount = 0;
  let openInlineGroupKey = null;
  const packageFields = new WeakMap();
  let receiptDraft;
  let inlineForm;
  let inlinePending = false;

  function createInlineField(labelText, input, className = "") {
    const label = createElement("label", className || "flex flex-col gap-1");
    label.append(createElement("span", "text-[9px] font-bold uppercase text-gray-500", labelText), input);
    return label;
  }

  function addFormRow(data = null) {
    formRowCount += 1;
    const container = byId("dynamicItemsContainer");
    const row = createElement("div", "p-4 bg-white rounded-lg border border-blue-200 shadow-sm space-y-3 relative animate-fadeIn text-black");
    row.dataset.rowId = String(formRowCount);
    const header = createElement("div", "flex justify-between items-center border-b pb-1 text-black");
    header.append(createElement("span", "text-[9px] font-bold text-blue-400 uppercase", `Pozycja #${formRowCount}`));
    if (container.children.length > 0) header.append(createButton("USUŃ", "Usuń pozycję z formularza", () => row.remove(), "text-red-500 text-[9px] font-bold"));

    const name = createInput("chem-name w-full border p-2 rounded text-sm outline-none text-black", "Nazwa", data?.name);
    name.maxLength = 200;
    const groupRow = createElement("div", "grid grid-cols-2 gap-2 text-black");
    const group = createInput("chem-group border p-2 rounded text-sm text-black", "Grupa (np. II-4/31)", data?.group);
    group.maxLength = 100;
    const usage = createInput("chem-usage border p-2 rounded text-sm text-black", "Zastosowanie", data?.usage);
    usage.maxLength = 500;
    groupRow.append(group, usage);
    const dateRow = createElement("div", "grid grid-cols-2 gap-2 text-black");
    const receivedWrapper = createElement("div");
    receivedWrapper.append(createElement("label", "text-[8px] font-bold text-gray-400 uppercase", "Przyjęcie:"));
    receivedWrapper.append(createInput("chem-received border p-2 rounded text-sm w-full text-black", "", data?.received ?? formatLocalDate(), "date"));
    const expiryWrapper = createElement("div");
    expiryWrapper.append(createElement("label", "text-[8px] font-bold text-red-400 uppercase", "Ważność:"));
    expiryWrapper.append(createInput("chem-expiry border p-2 rounded text-sm w-full text-black", "", data?.expiry, "date"));
    dateRow.append(receivedWrapper, expiryWrapper);
    row.append(header, name, groupRow, dateRow);
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
      alert("Podaj nazwę co najmniej jednej pozycji.");
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
      cancelEdit();
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
    byId("formContainer").classList.add("editing-mode");
    byId("cancelEditBtn").classList.remove("hidden");
    byId("submitBtn").textContent = "Zaktualizuj wybraną butelkę";
    queueMicrotask(() => {
      byId("formContainer").scrollIntoView({ behavior: "smooth", block: "start" });
      byId("formContainer").querySelector(".chem-name")?.focus({ preventScroll: true });
    });
  }

  function cancelEdit() {
    receiptDraft = null;
    editCategory = null;
    byId("editId").value = "";
    byId("formContainer").classList.remove("editing-mode");
    byId("cancelEditBtn").classList.add("hidden");
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
      "ml-auto shrink-0 rounded border border-current bg-white px-2 py-1 text-[9px] font-black uppercase shadow-sm",
    );
    row.append(
      createElement("span", "text-[14px]", icons[alertData.type]),
      createElement("span", "min-w-0 flex-1", message),
      editButton,
    );
    return row;
  }

  function createInlineForm(group) {
    const form = createElement("form", "border-b border-blue-100 bg-blue-50 p-3 text-left");
    form.dataset.inlineChemicalForm = group.key;
    const title = createElement("p", "mb-3 text-[10px] font-black uppercase text-blue-800", `Dodaj nową pozycję do: ${group.name}`);
    const fields = createElement("div", "grid grid-cols-1 gap-2 md:grid-cols-2");
    const groupInput = createInput("inline-group w-full rounded border p-2 text-sm text-black", "Grupa / numer", suggestNextGroupValue(group.items, group.prefix));
    groupInput.maxLength = 100;
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
      const box = createElement("div");
      const suggest = () => {
        packaging = inventory.fields(representatives.find(([key]) => key === source.value)?.[1] || {});
        box.replaceChildren(packaging.node);
      };
      source.addEventListener("change", suggest);
      suggest();
      fields.append(field("Pozycja handlowa", source), box);
    }
    const actions = createElement("div", "mt-3 flex justify-end gap-2");
    const cancelButton = createElement("button", "rounded bg-gray-200 px-4 py-2 text-[10px] font-bold uppercase text-gray-700", "Anuluj");
    cancelButton.type = "button";
    cancelButton.addEventListener("click", () => { if (!inlinePending) { openInlineGroupKey = null; inlineForm = null; render(); } });
    const submitButton = createElement("button", "rounded bg-blue-600 px-4 py-2 text-[10px] font-bold uppercase text-white", "Zapisz pozycję");
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
          openInlineGroupKey = null;
          inlineForm = null;
          render();
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
    const categoryOf = (item) => item.category === "Odczynniki" ? "Odczynniki" : "Wzorce";
    const categoryItems = activeItems.filter((item) => {
      const itemCategory = item.category || "Wzorce";
      return searchQuery || itemCategory === category || (category === "Wzorce" && itemCategory === "Standardowe");
    });
    const threshold = category === "Odczynniki" ? 70 : 40;
    const statusFilter = byId("chemicalStatusFilter").value;
    const sortMode = byId("chemicalSort").value;
    const byPrefix = (a, b) => a.prefix.localeCompare(b.prefix, "pl", { numeric: true, sensitivity: "base" }) || a.name.localeCompare(b.name, "pl", { sensitivity: "base" });
    const partition = (list, kind) => groupChemicalItems(list.filter((item) => categoryOf(item) === kind))
      .map((group) => ({ ...group, category: kind, key: `${kind}:${group.key}` }));
    const categories = ["Wzorce", "Odczynniki"];
    const lpByItem = new Map();
    for (const kind of categories) partition(activeItems, kind).sort(byPrefix)
      .forEach((group, index) => group.items.forEach((item) => lpByItem.set(item.id, index + 1)));
    const filtered = categoryItems.filter((item) => {
      if (searchQuery && !matchesInventorySearch(searchQuery, item.name, item.group, item.usage, item.lotNumber, `LP ${lpByItem.get(item.id)}`,
        item.producer, item.formula, item.cas, ...(inventory?.searchContext(item) || []))) return false;
      const expiryDate = item.expiry ? parseLocalDate(item.expiry) : null;
      const days = expiryDate ? calculateCalendarDays(new Date(), expiryDate) : null;
      if (statusFilter === "attention") return days !== null && days <= (categoryOf(item) === "Odczynniki" ? 70 : 40);
      if (statusFilter === "ordered") return item.ordered === true;
      if (statusFilter === "expired") return days !== null && days < 0;
      return true;
    });

    const sortedGroups = categories.flatMap((kind) => partition(filtered, kind)).sort((a, b) => {
      if (sortMode === "name") return a.name.localeCompare(b.name, "pl", { sensitivity: "base" }) || a.prefix.localeCompare(b.prefix, "pl", { numeric: true, sensitivity: "base" });
      if (sortMode === "expiry") return earliestExpiry(a).localeCompare(earliestExpiry(b)) || a.name.localeCompare(b.name, "pl", { sensitivity: "base" });
      return byPrefix(a, b);
    });

    sortedGroups.forEach((group) => {
      group.items.sort((a, b) => sortMode === "expiry" ? String(a.expiry || "9999-12-31").localeCompare(String(b.expiry || "9999-12-31")) : String(a.group || "").localeCompare(String(b.group || ""), "pl", { numeric: true }));
      const card = createElement("section", "bg-white rounded-xl border shadow-sm mb-3 overflow-hidden text-black");
      const header = createElement("div", "bg-gray-100 px-4 py-2 border-b flex items-center gap-3");
      header.append(createElement("span", "bg-blue-600 text-white text-[10px] px-2 py-0.5 rounded-full font-bold", `LP ${lpByItem.get(group.items[0].id)}`));
      const headingText = createElement("div", "flex flex-1 items-center gap-2 overflow-hidden text-black");
      headingText.append(createElement("span", "font-black uppercase text-xs truncate", group.name), createElement("span", "font-bold text-gray-500 text-[10px] uppercase border-l pl-2 leading-none border-gray-300", group.prefix));
      const isOpen = openInlineGroupKey === group.key;
      const addButton = createButton(isOpen ? "−" : "+", isOpen ? `Zamknij formularz dla ${group.name}` : `Dodaj nową pozycję do ${group.name}`, () => {
        if (inlinePending) return;
        openInlineGroupKey = isOpen ? null : group.key;
        inlineForm = null;
        render();
        if (!isOpen) queueMicrotask(() => document.querySelector("[data-inline-chemical-form] .inline-group")?.focus());
      }, "ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-lg font-black text-white shadow-sm hover:bg-blue-700");
      header.append(headingText, addButton);
      card.append(header);
      if (inventory) {
        for (const id of new Set(group.items.map(productId))) {
          const related = inventory.lotsFor(id);
          const total = availability(related);
          if (total !== "—") card.append(createElement("p", "px-3 pt-2 text-xs text-gray-600",
            `Dostępny zapas ${related.length > 1 ? `(${related.length} partii) ` : ""}${total}`));
        }
      }
      if (isOpen) {
        inlineForm ??= createInlineForm(group);
        card.append(inlineForm);
      }

      group.items.forEach((item) => {
        const expiryDate = item.expiry ? parseLocalDate(item.expiry) : null;
        const days = expiryDate ? calculateCalendarDays(new Date(), expiryDate) : null;
        const color = days !== null && days < 0 ? "text-red-600 font-bold" : days !== null && days <= (categoryOf(item) === "Odczynniki" ? 70 : 40) ? "text-orange-500 font-bold" : "text-black font-semibold";
        const suffix = String(item.group || "").includes("/") ? `/${String(item.group).split("/")[1]}` : "•";
        const row = createElement("div", `${item.ordered ? "ordered-row " : ""}flex flex-wrap items-center justify-between gap-2 p-3 border-t text-[11px] text-black`);
        const info = createElement("div", "flex min-w-0 items-center gap-3");
        info.append(createElement("span", "font-black text-blue-400 w-8", suffix));
        const details = createElement("div", "flex min-w-0 flex-col text-black [overflow-wrap:anywhere]");
        const expiryLine = createElement("span", "uppercase");
        expiryLine.append(document.createTextNode("Ważność: "), createElement("span", color, formatPolishDate(item.expiry)));
        const dayText = days !== null && days < 0 ? "PO TERMINIE" : days === null ? "brak daty" : `${days} dni`;
        expiryLine.append(document.createTextNode(" "), createElement("span", "text-[8px] text-gray-400", `(${dayText})`));
        details.append(expiryLine, createElement("span", "text-[8px] italic text-gray-500", item.usage || ""));
        if (inventory) {
          if (item.lotNumber) details.append(createElement("span", "", `Partia ${item.lotNumber}`));
          details.append(inventory.ready() ? showStock(inventory.withStock(item)) : createElement("span", "", "Odczyt stanu…"));
        }
        info.append(details);
        const actions = createElement("div", "flex flex-wrap justify-end gap-2");
        actions.append(
          createButton(item.ordered ? "✅" : "🛒", item.ordered ? "Cofnij oznaczenie zamówienia" : "Oznacz jako zamówione", () => {
            if (inventory) requireInventoryConnection();
            return updateDoc(doc(db, "odczynniki", item.id), { ordered: !item.ordered });
          }),
          createButton("✏️", "Edytuj pozycję", () => startEdit(item)),
          ...(inventory?.actions(item) || []),
        );
        row.append(info, actions);
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
    openInlineGroupKey = null;
    inlineForm = null;
    ["Wzorce", "Odczynniki"].forEach((tab) => {
      const button = byId(`subBtnOdczynniki${tab}`);
      button.className = `px-4 py-2 border rounded text-[9px] font-bold uppercase whitespace-nowrap ${target === tab ? "active-sub-tab-odczynniki" : "bg-white text-gray-500"}`;
    });
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
      addFormRow, cancelEdit, saveItems, switchSubTab,
    },
    bind, initializeForm: cancelEdit, start,
  };
}
