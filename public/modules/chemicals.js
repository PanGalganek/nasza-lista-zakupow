import { calculateCalendarDays, formatLocalDate, parseLocalDate, suggestNextGroupValue } from "../utils.js";
import { createChemicalTransferModule } from "./chemical-transfer.js";
import { byId, createButton, createElement, createInput, runSafely } from "./ui.js";

export function createChemicalsModule({ db, firestore, registerSnapshot, reportListenerError }) {
  const { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc, writeBatch } = firestore;
  let items = [];
  let category = "Wzorce";
  let formRowCount = 0;
  let openInlineGroupKey = null;

  function createInlineField(labelText, input, className = "") {
    const label = createElement("label", className || "flex flex-col gap-1");
    label.append(createElement("span", "text-[9px] font-bold uppercase text-gray-500", labelText), input);
    return label;
  }

  const transfer = createChemicalTransferModule({
    db, firestore, getItems: () => items, getCategory: () => category, createInlineField,
  });

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
    receivedWrapper.append(createInput("chem-received border p-2 rounded text-sm w-full text-black", "", data?.received || formatLocalDate(), "date"));
    const expiryWrapper = createElement("div");
    expiryWrapper.append(createElement("label", "text-[8px] font-bold text-red-400 uppercase", "Ważność:"));
    expiryWrapper.append(createInput("chem-expiry border p-2 rounded text-sm w-full text-black", "", data?.expiry, "date"));
    dateRow.append(receivedWrapper, expiryWrapper);
    row.append(header, name, groupRow, dateRow);
    container.append(row);
  }

  function payloadFromRow(row) {
    return {
      name: row.querySelector(".chem-name").value.trim(), group: row.querySelector(".chem-group").value.trim(),
      usage: row.querySelector(".chem-usage").value.trim(), received: row.querySelector(".chem-received").value,
      expiry: row.querySelector(".chem-expiry").value, category,
    };
  }

  async function saveItems() {
    const selectedItems = [...byId("dynamicItemsContainer").children].map(payloadFromRow).filter((item) => item.name);
    if (selectedItems.length === 0) {
      alert("Podaj nazwę co najmniej jednej pozycji.");
      return;
    }
    const editId = byId("editId").value;
    if (editId) {
      if (selectedItems.length !== 1) throw new Error("Edycja wymaga dokładnie jednego wiersza.");
      await updateDoc(doc(db, "odczynniki", editId), selectedItems[0]);
    } else {
      const batch = writeBatch(db);
      selectedItems.forEach((item, index) => batch.set(doc(collection(db, "odczynniki")), { ...item, timestamp: Date.now() + index, ordered: false }));
      await batch.commit();
    }
    cancelEdit();
  }

  function startEdit(item) {
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
    if (alertData.type === "backup") message += ` — jest zapasowa pozycja ważna do ${alertData.date}`;
    if (alertData.type === "ordered") message += " — ZAMÓWIONO";
    if (alertData.type === "expired") message += ` — TERMIN MINĄŁ ${alertData.date}`;
    if (alertData.type === "warning") message += ` — ważny do ${alertData.date}`;
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
    const actions = createElement("div", "mt-3 flex justify-end gap-2");
    const cancelButton = createElement("button", "rounded bg-gray-200 px-4 py-2 text-[10px] font-bold uppercase text-gray-700", "Anuluj");
    cancelButton.type = "button";
    cancelButton.addEventListener("click", () => { openInlineGroupKey = null; render(); });
    const submitButton = createElement("button", "rounded bg-blue-600 px-4 py-2 text-[10px] font-bold uppercase text-white", "Zapisz pozycję");
    submitButton.type = "submit";
    actions.append(cancelButton, submitButton);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      runSafely(async () => {
        submitButton.disabled = true;
        try {
          await addDoc(collection(db, "odczynniki"), {
            name: group.name, group: groupInput.value.trim(), usage: usageInput.value.trim(), received: receivedInput.value,
            expiry: expiryInput.value, category, timestamp: Date.now(), ordered: false,
          });
          openInlineGroupKey = null;
          render();
        } finally { submitButton.disabled = false; }
      }, "Nie udało się dodać nowej pozycji.");
    });
    form.append(title, fields, actions);
    return form;
  }

  function groupItems(selectedItems) {
    const groups = new Map();
    selectedItems.forEach((item) => {
      const prefix = String(item.group || "Inne").split("/")[0];
      const name = String(item.name || "Bez nazwy");
      const key = `${prefix}\u0000${name.toLocaleLowerCase("pl")}`;
      if (!groups.has(key)) groups.set(key, { key, prefix, name, items: [] });
      groups.get(key).items.push(item);
    });
    return [...groups.values()];
  }

  function earliestExpiry(group) {
    return group.items.map((item) => String(item.expiry || "")).filter(Boolean).sort()[0] || "9999-12-31";
  }

  function normalizeSearch(value) {
    return String(value || "").toLocaleLowerCase("pl").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l");
  }

  function render() {
    const container = byId("chemicalListGrouped");
    const alertBox = byId("alertBox");
    container.replaceChildren();
    alertBox.replaceChildren();
    const categoryItems = items.filter((item) => {
      const itemCategory = item.category || "Wzorce";
      return itemCategory === category || (category === "Wzorce" && itemCategory === "Standardowe");
    });
    const threshold = category === "Odczynniki" ? 70 : 40;
    const searchQuery = normalizeSearch(byId("chemicalSearch").value.trim());
    const statusFilter = byId("chemicalStatusFilter").value;
    const sortMode = byId("chemicalSort").value;
    const filtered = categoryItems.filter((item) => {
      if (searchQuery && !normalizeSearch([item.name, item.group, item.usage].join(" ")).includes(searchQuery)) return false;
      const expiryDate = item.expiry ? parseLocalDate(item.expiry) : null;
      const days = expiryDate ? calculateCalendarDays(new Date(), expiryDate) : null;
      if (statusFilter === "attention") return days !== null && days <= threshold;
      if (statusFilter === "ordered") return item.ordered === true;
      if (statusFilter === "expired") return days !== null && days < 0;
      return true;
    });

    const sortedGroups = groupItems(filtered).sort((a, b) => {
      if (sortMode === "name") return a.name.localeCompare(b.name, "pl", { sensitivity: "base" }) || a.prefix.localeCompare(b.prefix, "pl", { numeric: true, sensitivity: "base" });
      if (sortMode === "expiry") return earliestExpiry(a).localeCompare(earliestExpiry(b)) || a.name.localeCompare(b.name, "pl", { sensitivity: "base" });
      return a.prefix.localeCompare(b.prefix, "pl", { numeric: true, sensitivity: "base" }) || a.name.localeCompare(b.name, "pl", { sensitivity: "base" });
    });
    const alerts = [];
    groupItems(categoryItems).forEach((group) => {
      const expiring = group.items.filter((item) => {
        if (!item.expiry) return false;
        const days = calculateCalendarDays(new Date(), parseLocalDate(item.expiry));
        return days !== null && days <= threshold;
      });
      const backups = group.items.filter((item) => {
        if (!item.expiry) return false;
        const days = calculateCalendarDays(new Date(), parseLocalDate(item.expiry));
        return days !== null && days > threshold;
      });
      if (expiring.length > 0) {
        if (backups.length > 0) {
          const best = [...backups].sort((a, b) => String(b.expiry).localeCompare(String(a.expiry)))[0];
          const candidate = [...expiring].sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)))[0];
          alerts.push({ prefix: group.prefix, name: group.name, type: "backup", date: best.expiry, item: candidate });
        } else {
          const expired = expiring.filter((item) => calculateCalendarDays(new Date(), parseLocalDate(item.expiry)) < 0);
          const ordered = expiring.filter((item) => item.ordered);
          const type = expired.length ? "expired" : ordered.length ? "ordered" : "warning";
          const candidates = expired.length ? expired : ordered.length ? ordered : expiring;
          const candidate = [...candidates].sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)))[0];
          alerts.push({ prefix: group.prefix, name: group.name, type, date: candidate.expiry, item: candidate });
        }
      }
    });

    sortedGroups.forEach((group, groupIndex) => {
      group.items.sort((a, b) => sortMode === "expiry" ? String(a.expiry || "9999-12-31").localeCompare(String(b.expiry || "9999-12-31")) : String(a.group || "").localeCompare(String(b.group || ""), "pl", { numeric: true }));
      const card = createElement("section", "bg-white rounded-xl border shadow-sm mb-3 overflow-hidden text-black");
      const header = createElement("div", "bg-gray-100 px-4 py-2 border-b flex items-center gap-3");
      header.append(createElement("span", "bg-blue-600 text-white text-[10px] px-2 py-0.5 rounded-full font-bold", `LP ${groupIndex + 1}`));
      const headingText = createElement("div", "flex flex-1 items-center gap-2 overflow-hidden text-black");
      headingText.append(createElement("span", "font-black uppercase text-xs truncate", group.name), createElement("span", "font-bold text-gray-500 text-[10px] uppercase border-l pl-2 leading-none border-gray-300", group.prefix));
      const isOpen = openInlineGroupKey === group.key;
      const addButton = createButton(isOpen ? "−" : "+", isOpen ? `Zamknij formularz dla ${group.name}` : `Dodaj nową pozycję do ${group.name}`, () => {
        openInlineGroupKey = isOpen ? null : group.key;
        render();
        if (!isOpen) queueMicrotask(() => document.querySelector("[data-inline-chemical-form] .inline-group")?.focus());
      }, "ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-lg font-black text-white shadow-sm hover:bg-blue-700");
      header.append(headingText, addButton);
      card.append(header);
      if (isOpen) card.append(createInlineForm(group));

      group.items.forEach((item) => {
        const expiryDate = item.expiry ? parseLocalDate(item.expiry) : null;
        const days = expiryDate ? calculateCalendarDays(new Date(), expiryDate) : null;
        const color = days !== null && days < 0 ? "text-red-600 font-bold" : days !== null && days <= threshold ? "text-orange-500 font-bold" : "text-black font-semibold";
        const suffix = String(item.group || "").includes("/") ? `/${String(item.group).split("/")[1]}` : "•";
        const row = createElement("div", `${item.ordered ? "ordered-row " : ""}flex items-center justify-between p-3 border-t text-[11px] text-black`);
        const info = createElement("div", "flex items-center gap-3");
        info.append(createElement("span", "font-black text-blue-400 w-8", suffix));
        const details = createElement("div", "flex flex-col text-black");
        const expiryLine = createElement("span", "uppercase");
        expiryLine.append(document.createTextNode("Ważność: "), createElement("span", color, item.expiry || "--"));
        const dayText = days !== null && days < 0 ? "PO TERMINIE" : days === null ? "brak daty" : `${days} dni`;
        expiryLine.append(document.createTextNode(" "), createElement("span", "text-[8px] text-gray-400", `(${dayText})`));
        details.append(expiryLine, createElement("span", "text-[8px] italic text-gray-500", item.usage || ""));
        info.append(details);
        const actions = createElement("div", "flex gap-4");
        actions.append(
          createButton(item.ordered ? "✅" : "🛒", item.ordered ? "Cofnij oznaczenie zamówienia" : "Oznacz jako zamówione", () => updateDoc(doc(db, "odczynniki", item.id), { ordered: !item.ordered })),
          createButton("✏️", "Edytuj pozycję", () => startEdit(item)),
          createButton("✕", "Usuń pozycję", async () => { if (confirm(`Usunąć „${item.name}”?`)) await deleteDoc(doc(db, "odczynniki", item.id)); }, "text-red-600"),
        );
        row.append(info, actions);
        card.append(row);
      });
      container.append(card);
    });
    byId("chemicalResultSummary").textContent = `Pozycje: ${filtered.length} • Grupy: ${sortedGroups.length}`;
    if (sortedGroups.length === 0) container.append(createElement("p", "rounded-lg border border-dashed bg-gray-50 p-6 text-center text-sm text-gray-500", "Brak pozycji spełniających kryteria."));
    alerts.forEach((alertData) => alertBox.append(renderAlert(alertData)));
    alertBox.classList.toggle("hidden", alerts.length === 0);
  }

  function switchSubTab(target) {
    category = target;
    openInlineGroupKey = null;
    ["Wzorce", "Odczynniki"].forEach((tab) => {
      const button = byId(`subBtnOdczynniki${tab}`);
      button.className = `px-4 py-2 border rounded text-[9px] font-bold uppercase whitespace-nowrap ${target === tab ? "active-sub-tab-odczynniki" : "bg-white text-gray-500"}`;
    });
    render();
  }

  function start() {
    registerSnapshot(onSnapshot(
      query(collection(db, "odczynniki"), orderBy("timestamp", "asc")),
      (snapshot) => { items = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })); render(); },
      (error) => reportListenerError("Odczynniki", error),
    ));
  }

  function initializeForm() {
    formRowCount = 0;
    byId("dynamicItemsContainer").replaceChildren();
    addFormRow();
  }

  function bind() {
    byId("chemicalSearch").addEventListener("input", render);
    byId("chemicalStatusFilter").addEventListener("change", render);
    byId("chemicalSort").addEventListener("change", render);
    transfer.bind();
  }

  return {
    actions: {
      addFormRow, cancelEdit, saveItems, switchSubTab,
      openImport: transfer.open, chooseImportFile: transfer.chooseFile, closeImport: transfer.close,
      confirmImport: transfer.confirmImport, exportCsv: transfer.exportCsv, exportJson: transfer.exportJson,
    },
    bind, initializeForm, start,
  };
}
