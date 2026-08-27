import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import {
  calculateCalendarDays,
  formatLocalDate,
  isDoneInYear,
  parseLocalDate,
  shiftCalendarMonth,
  suggestNextGroupValue,
} from "./utils.js";
import {
  classifyChemicalDrafts,
  chemicalsToCsv,
  createChemicalBackup,
  readChemicalRowsFromDocx,
  rowsToChemicalDrafts,
} from "./import-export.js";

const firebaseConfig = {
  apiKey: "AIzaSyANS8FT-mgc8D1kR-WXlhzjEvufveMMeM8",
  authDomain: "nasza-lista-zakupow.firebaseapp.com",
  projectId: "nasza-lista-zakupow",
  storageBucket: "nasza-lista-zakupow.firebasestorage.app",
  messagingSenderId: "516283526174",
  appId: "1:516283526174:web:f42c9c38333e821da5520f",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const taskLabs = ["woda", "scieki"];
const taskCategories = ["Archiwalna", "Slepa", "Probkobranie", "Porownania"];
const monthNames = {
  "01": "Styczeń",
  "02": "Luty",
  "03": "Marzec",
  "04": "Kwiecień",
  "05": "Maj",
  "06": "Czerwiec",
  "07": "Lipiec",
  "08": "Sierpień",
  "09": "Wrzesień",
  "10": "Październik",
  "11": "Listopad",
  "12": "Grudzień",
};

let odczynnikiCache = [];
let eventsCache = [];
let wzorcowanieCache = [];
let currentOdczynnikiSubTab = "Wzorce";
let selectedWMonth = String(new Date().getMonth() + 1).padStart(2, "0");
let calDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedDayStr = formatLocalDate();
let formRowCount = 0;
let openInlineGroupKey = null;
let wordImportDrafts = [];
let snapshotUnsubscribers = [];
const reportedListenerErrors = new Set();

const byId = (id) => document.getElementById(id);

function createElement(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = String(text);
  return element;
}

function createButton(text, title, handler, className = "") {
  const button = createElement("button", className, text);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", () => runSafely(handler, "Nie udało się wykonać operacji."));
  return button;
}

async function runSafely(action, userMessage) {
  try {
    await action();
  } catch (error) {
    console.error(error);
    alert(userMessage);
  }
}

function reportListenerError(area, error) {
  console.error(`Błąd synchronizacji: ${area}`, error);
  if (!reportedListenerErrors.has(area)) {
    reportedListenerErrors.add(area);
    alert(`Nie udało się zsynchronizować sekcji „${area}”. Odśwież stronę lub zaloguj się ponownie.`);
  }
}

function setLoginError(message = "") {
  const errorBox = byId("loginError");
  errorBox.textContent = message;
  errorBox.classList.toggle("hidden", !message);
}

function clearSnapshots() {
  snapshotUnsubscribers.forEach((unsubscribe) => unsubscribe());
  snapshotUnsubscribers = [];
  reportedListenerErrors.clear();
}

function switchTab(target) {
  ["odczynniki", "woda", "scieki", "wzorcowanie", "kalendarz"].forEach((tab) => {
    const capitalized = tab.charAt(0).toUpperCase() + tab.slice(1);
    const content = byId(`tabContent${capitalized}`);
    const button = byId(`btn${capitalized}`);
    const isActive = tab === target;
    content?.classList.toggle("hidden", !isActive);
    button?.classList.toggle("active-tab", isActive);
    button?.classList.toggle("text-gray-400", !isActive);
  });

  if (target === "kalendarz") renderCalendar();
  if (target === "wzorcowanie") updateWzorcowanieUI();
}

function switchOdczynnikiSubTab(target) {
  currentOdczynnikiSubTab = target;
  openInlineGroupKey = null;
  ["Wzorce", "Odczynniki"].forEach((tab) => {
    const button = byId(`subBtnOdczynniki${tab}`);
    button.className = `px-4 py-2 border rounded text-[9px] font-bold uppercase whitespace-nowrap ${
      target === tab ? "active-sub-tab-odczynniki" : "bg-white text-gray-500"
    }`;
  });
  renderOdczynniki();
}

function switchTaskSubTab(lab, target) {
  taskCategories.forEach((category) => {
    const capitalizedLab = lab.charAt(0).toUpperCase() + lab.slice(1);
    byId(`subContent${capitalizedLab}${category}`)?.classList.add("hidden");
    const button = byId(`subBtn${capitalizedLab}${category}`);
    if (button) {
      button.className = "px-2 py-2 border rounded text-[9px] font-bold uppercase bg-white text-gray-500 text-center min-w-[120px]";
    }
  });

  const capitalizedLab = lab.charAt(0).toUpperCase() + lab.slice(1);
  byId(`subContent${capitalizedLab}${target}`)?.classList.remove("hidden");
  const activeButton = byId(`subBtn${capitalizedLab}${target}`);
  if (activeButton) {
    activeButton.className = `px-2 py-2 border rounded text-[9px] font-bold uppercase active-sub-tab-${lab} text-center min-w-[120px]`;
  }
}

function createInput(className, placeholder, value = "", type = "text") {
  const input = createElement("input", className);
  input.type = type;
  input.placeholder = placeholder;
  input.value = value ?? "";
  return input;
}

function addFormRow(data = null) {
  formRowCount += 1;
  const container = byId("dynamicItemsContainer");
  const row = createElement("div", "p-4 bg-white rounded-lg border border-blue-200 shadow-sm space-y-3 relative animate-fadeIn text-black");
  row.dataset.rowId = String(formRowCount);

  const header = createElement("div", "flex justify-between items-center border-b pb-1 text-black");
  header.append(createElement("span", "text-[9px] font-bold text-blue-400 uppercase", `Pozycja #${formRowCount}`));
  if (container.children.length > 0) {
    header.append(createButton("USUŃ", "Usuń pozycję z formularza", () => row.remove(), "text-red-500 text-[9px] font-bold"));
  }

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
  const received = createInput("chem-received border p-2 rounded text-sm w-full text-black", "", data?.received || formatLocalDate(), "date");
  receivedWrapper.append(received);
  const expiryWrapper = createElement("div");
  expiryWrapper.append(createElement("label", "text-[8px] font-bold text-red-400 uppercase", "Ważność:"));
  const expiry = createInput("chem-expiry border p-2 rounded text-sm w-full text-black", "", data?.expiry, "date");
  expiryWrapper.append(expiry);
  dateRow.append(receivedWrapper, expiryWrapper);

  row.append(header, name, groupRow, dateRow);
  container.append(row);
}

function chemicalPayloadFromRow(row) {
  return {
    name: row.querySelector(".chem-name").value.trim(),
    group: row.querySelector(".chem-group").value.trim(),
    usage: row.querySelector(".chem-usage").value.trim(),
    received: row.querySelector(".chem-received").value,
    expiry: row.querySelector(".chem-expiry").value,
    category: currentOdczynnikiSubTab,
  };
}

async function saveItems() {
  const rows = [...byId("dynamicItemsContainer").children];
  const items = rows.map(chemicalPayloadFromRow).filter((item) => item.name);
  if (items.length === 0) {
    alert("Podaj nazwę co najmniej jednej pozycji.");
    return;
  }

  const editId = byId("editId").value;
  if (editId) {
    if (items.length !== 1) throw new Error("Edycja wymaga dokładnie jednego wiersza.");
    await updateDoc(doc(db, "odczynniki", editId), items[0]);
  } else {
    const batch = writeBatch(db);
    items.forEach((item, index) => {
      const reference = doc(collection(db, "odczynniki"));
      batch.set(reference, { ...item, timestamp: Date.now() + index, ordered: false });
    });
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
  window.scrollTo({ top: 0, behavior: "smooth" });
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

function createImportInput(labelText, value, onInput, { type = "text", maxLength, onChange } = {}) {
  const input = createInput("w-full rounded border bg-white p-2 text-xs text-black", "", value, type);
  if (maxLength) input.maxLength = maxLength;
  input.addEventListener("input", () => onInput(input.value));
  if (onChange) input.addEventListener("change", onChange);
  return createInlineField(labelText, input);
}

function importActionsFor(draft) {
  if (draft.status === "changed") return [["skip", "Pomiń"], ["update", "Zaktualizuj istniejącą"], ["add", "Dodaj jako nową"]];
  if (draft.status === "new") return [["skip", "Pomiń"], ["add", "Dodaj jako nową"]];
  if (draft.status === "ambiguous") return [["skip", "Pomiń"], ["add", "Dodaj jako nową"]];
  return [["skip", "Pomiń — bez zmian"]];
}

function updateWordImportSummary() {
  const counts = { new: 0, changed: 0, unchanged: 0, ambiguous: 0, add: 0, update: 0 };
  wordImportDrafts.forEach((draft) => {
    counts[draft.status] += 1;
    if (draft.action === "add" || draft.action === "update") counts[draft.action] += 1;
  });
  byId("wordImportStatus").textContent = `Rozpoznano: ${wordImportDrafts.length} • nowe: ${counts.new} • zmienione: ${counts.changed} • bez zmian: ${counts.unchanged} • do sprawdzenia: ${counts.ambiguous} • wybrano: ${counts.add} dodaj, ${counts.update} aktualizuj`;
}

function reclassifyWordImportDrafts(changedImportIndex = null, preserveOtherActions = true) {
  const previousActions = new Map(wordImportDrafts.map((draft) => [draft.importIndex, draft.action]));
  wordImportDrafts = classifyChemicalDrafts(wordImportDrafts, odczynnikiCache);
  if (preserveOtherActions) {
    wordImportDrafts.forEach((draft) => {
      if (draft.importIndex === changedImportIndex) return;
      const previous = previousActions.get(draft.importIndex);
      if (importActionsFor(draft).some(([value]) => value === previous)) draft.action = previous;
    });
  }
  renderWordImportPreview();
}

function renderWordImportPreview() {
  const preview = byId("wordImportPreview");
  preview.replaceChildren();
  updateWordImportSummary();
  byId("wordImportActions").classList.toggle("hidden", wordImportDrafts.length === 0);

  wordImportDrafts.forEach((draft, index) => {
    const statusConfig = {
      new: { label: "Nowa pozycja", classes: "border-green-200 bg-green-50 text-green-800" },
      changed: { label: "Wykryto zmianę", classes: "border-blue-200 bg-blue-50 text-blue-800" },
      unchanged: { label: "Bez zmian", classes: "border-gray-200 bg-gray-50 text-gray-700" },
      ambiguous: { label: "Wymaga sprawdzenia", classes: "border-orange-300 bg-orange-50 text-orange-800" },
    }[draft.status];
    const card = createElement("article", `rounded-lg border p-3 ${statusConfig.classes}`);
    const heading = createElement("div", "mb-3 flex items-start gap-2");
    const title = createElement("div", "flex-1");
    title.append(createElement("p", "text-[10px] font-black uppercase", `Pozycja ${index + 1} • ${statusConfig.label}`));
    if (draft.existing) title.append(createElement("p", "mt-1 text-[9px] font-bold", `Dopasowano do: ${draft.existing.group} — ${draft.existing.name}`));
    const warnings = [...draft.warnings];
    if (draft.status === "ambiguous") warnings.push("Nie znaleziono jednego pewnego rekordu do aktualizacji");
    if (warnings.length) title.append(createElement("p", "mt-1 text-[9px] font-bold text-orange-700", warnings.join(" • ")));
    const action = createElement("select", "rounded border bg-white p-2 text-xs font-bold text-black");
    action.setAttribute("aria-label", `Działanie dla pozycji ${index + 1}`);
    importActionsFor(draft).forEach(([value, label]) => {
      const option = createElement("option", "", label);
      option.value = value;
      action.append(option);
    });
    action.value = draft.action;
    action.addEventListener("change", () => {
      draft.action = action.value;
      updateWordImportSummary();
    });
    heading.append(title, action);

    if (draft.changes.length) {
      const changes = createElement("div", "mb-3 rounded border border-blue-200 bg-white p-2 text-[10px] text-black");
      changes.append(createElement("p", "mb-1 font-black uppercase text-blue-800", "Proponowane zmiany"));
      draft.changes.forEach((change) => {
        changes.append(createElement("p", "", `${change.label}: ${change.before} → ${change.after}`));
      });
      card.append(heading, changes);
    } else {
      card.append(heading);
    }

    const fields = createElement("div", "grid grid-cols-1 gap-2 md:grid-cols-2");
    const refreshMatch = () => reclassifyWordImportDrafts(draft.importIndex);
    fields.append(
      createImportInput("Grupa", draft.group, (value) => { draft.group = value.trim(); }, { maxLength: 100, onChange: refreshMatch }),
      createImportInput("Data ważności", draft.expiry, (value) => { draft.expiry = value; }, { type: "date", onChange: refreshMatch }),
      createImportInput("Nazwa", draft.name, (value) => { draft.name = value.trim(); }, { maxLength: 200, onChange: refreshMatch }),
      createImportInput("Zastosowanie", draft.usage, (value) => { draft.usage = value.trim(); }, { maxLength: 500, onChange: refreshMatch }),
    );
    const source = createElement("details", "word-import-source mt-2 text-[9px] text-gray-500");
    source.append(createElement("summary", "font-bold", "Pokaż oryginalny opis z Worda"), createElement("p", "mt-1", draft.sourceName));
    card.append(fields, source);
    preview.append(card);
  });
}

function closeWordImport() {
  wordImportDrafts = [];
  byId("wordImportFile").value = "";
  byId("wordImportPreview").replaceChildren();
  byId("wordImportActions").classList.add("hidden");
  byId("wordImportPanel").classList.add("hidden");
}

function chooseWordFile() {
  byId("wordImportFile").value = "";
  byId("wordImportFile").click();
}

function openWordImport() {
  byId("wordImportCategory").value = currentOdczynnikiSubTab;
  byId("wordImportReceived").value = formatLocalDate();
  byId("wordImportStatus").textContent = "Wybierz dokument DOCX. Starszy format DOC zapisz najpierw w Wordzie jako DOCX.";
  byId("wordImportPanel").classList.remove("hidden");
  chooseWordFile();
}

async function handleWordImportFile(file) {
  if (!file) return;
  const extension = file.name.toLocaleLowerCase("pl").split(".").pop();
  if (extension === "doc") {
    wordImportDrafts = [];
    byId("wordImportPreview").replaceChildren();
    byId("wordImportActions").classList.add("hidden");
    byId("wordImportStatus").textContent = "To jest format DOC (Word 97–2003). Otwórz plik w Wordzie, wybierz „Zapisz jako” → „Dokument programu Word (*.docx)” i wskaż nowy plik.";
    return;
  }
  if (extension !== "docx") throw new Error("Obsługiwane są dokumenty DOCX.");

  byId("wordImportStatus").textContent = `Odczytuję „${file.name}”…`;
  const rows = await readChemicalRowsFromDocx(await file.arrayBuffer());
  wordImportDrafts = rowsToChemicalDrafts(rows, {
    category: byId("wordImportCategory").value,
    received: byId("wordImportReceived").value,
  }).map((draft, importIndex) => ({ ...draft, importIndex }));
  if (wordImportDrafts.length === 0) throw new Error("Nie znaleziono tabeli z kolumnami Grupa, Nazwa i Zastosowanie.");
  reclassifyWordImportDrafts(null, false);
}

function isIsoDate(value, allowEmpty = false) {
  if (allowEmpty && value === "") return true;
  return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value);
}

async function confirmWordImport() {
  const selected = wordImportDrafts.filter((draft) => draft.action !== "skip");
  if (selected.length === 0) {
    alert("Wybierz co najmniej jedną pozycję do dodania lub aktualizacji.");
    return;
  }
  const invalid = selected.find((draft) => !draft.name || !draft.group || !isIsoDate(draft.received) || !isIsoDate(draft.expiry, true));
  if (invalid) {
    alert(`Uzupełnij nazwę, grupę i poprawne daty dla pozycji „${invalid.group || invalid.name || "bez nazwy"}”.`);
    return;
  }
  const invalidUpdate = selected.find((draft) => draft.action === "update" && !draft.matchId);
  if (invalidUpdate) {
    alert(`Nie można jednoznacznie wskazać rekordu do aktualizacji dla „${invalidUpdate.group}”. Wybierz „Dodaj jako nową” albo „Pomiń”.`);
    return;
  }
  const additions = selected.filter((draft) => draft.action === "add").length;
  const updates = selected.filter((draft) => draft.action === "update").length;
  if (!confirm(`Zastosować wybrane działania? Nowe pozycje: ${additions}, aktualizacje: ${updates}. Pozostałe dane nie zostaną zmienione.`)) return;

  const button = byId("confirmWordImportBtn");
  button.disabled = true;
  try {
    const batch = writeBatch(db);
    selected.forEach((draft, index) => {
      const payload = {
        name: draft.name.slice(0, 200),
        group: draft.group.slice(0, 100),
        usage: draft.usage.slice(0, 500),
        expiry: draft.expiry,
        category: draft.category,
        ordered: false,
      };
      if (draft.action === "update") {
        const groupChanged = draft.changes.some((change) => change.field === "group");
        batch.update(doc(db, "odczynniki", draft.matchId), {
          ...payload,
          received: groupChanged ? draft.received : (draft.existing.received || draft.received),
        });
      } else {
        const reference = doc(collection(db, "odczynniki"));
        batch.set(reference, {
          ...payload,
          received: draft.received,
          timestamp: Date.now() + index,
        });
      }
    });
    await batch.commit();
    closeWordImport();
    alert(`Import zakończony. Dodano: ${additions}, zaktualizowano: ${updates}.`);
  } finally {
    button.disabled = false;
  }
}

function downloadFile(filename, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportChemicalsCsv() {
  downloadFile(`e-laboratorium-${formatLocalDate()}.csv`, chemicalsToCsv(odczynnikiCache), "text/csv;charset=utf-8");
}

function exportChemicalsJson() {
  const backup = createChemicalBackup(odczynnikiCache);
  downloadFile(`e-laboratorium-kopia-${formatLocalDate()}.json`, JSON.stringify(backup, null, 2), "application/json;charset=utf-8");
}

function renderChemicalAlert(alertData) {
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
  row.append(createElement("span", "text-[14px]", icons[alertData.type]), createElement("span", "", message));
  return row;
}

function createInlineField(labelText, input, className = "") {
  const label = createElement("label", className || "flex flex-col gap-1");
  label.append(createElement("span", "text-[9px] font-bold uppercase text-gray-500", labelText), input);
  return label;
}

function createInlineChemicalForm(group) {
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
  fields.append(
    createInlineField("Grupa / numer", groupInput),
    createInlineField("Zastosowanie", usageInput),
    createInlineField("Data przyjęcia", receivedInput),
    createInlineField("Data ważności", expiryInput),
  );

  const actions = createElement("div", "mt-3 flex justify-end gap-2");
  const cancelButton = createElement("button", "rounded bg-gray-200 px-4 py-2 text-[10px] font-bold uppercase text-gray-700", "Anuluj");
  cancelButton.type = "button";
  cancelButton.addEventListener("click", () => {
    openInlineGroupKey = null;
    renderOdczynniki();
  });
  const submitButton = createElement("button", "rounded bg-blue-600 px-4 py-2 text-[10px] font-bold uppercase text-white", "Zapisz pozycję");
  submitButton.type = "submit";
  actions.append(cancelButton, submitButton);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    runSafely(async () => {
      submitButton.disabled = true;
      try {
        await addDoc(collection(db, "odczynniki"), {
          name: group.name,
          group: groupInput.value.trim(),
          usage: usageInput.value.trim(),
          received: receivedInput.value,
          expiry: expiryInput.value,
          category: currentOdczynnikiSubTab,
          timestamp: Date.now(),
          ordered: false,
        });
        openInlineGroupKey = null;
        renderOdczynniki();
      } finally {
        submitButton.disabled = false;
      }
    }, "Nie udało się dodać nowej pozycji.");
  });

  form.append(title, fields, actions);
  return form;
}

function groupChemicalItems(items) {
  const groups = new Map();
  items.forEach((item) => {
    const prefix = String(item.group || "Inne").split("/")[0];
    const name = String(item.name || "Bez nazwy");
    const key = `${prefix}\u0000${name.toLocaleLowerCase("pl")}`;
    if (!groups.has(key)) groups.set(key, { key, prefix, name, items: [] });
    groups.get(key).items.push(item);
  });
  return [...groups.values()];
}

function earliestGroupExpiry(group) {
  return group.items
    .map((item) => String(item.expiry || ""))
    .filter(Boolean)
    .sort()[0] || "9999-12-31";
}

function normalizeSearchValue(value) {
  return String(value || "")
    .toLocaleLowerCase("pl")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l");
}

function renderOdczynniki() {
  const container = byId("chemicalListGrouped");
  const alertBox = byId("alertBox");
  container.replaceChildren();
  alertBox.replaceChildren();

  const categoryItems = odczynnikiCache.filter((item) => {
    const category = item.category || "Wzorce";
    return category === currentOdczynnikiSubTab || (currentOdczynnikiSubTab === "Wzorce" && category === "Standardowe");
  });
  const threshold = currentOdczynnikiSubTab === "Odczynniki" ? 70 : 40;
  const searchQuery = normalizeSearchValue(byId("chemicalSearch").value.trim());
  const statusFilter = byId("chemicalStatusFilter").value;
  const sortMode = byId("chemicalSort").value;
  const filtered = categoryItems.filter((item) => {
    const searchableText = normalizeSearchValue([item.name, item.group, item.usage].join(" "));
    if (searchQuery && !searchableText.includes(searchQuery)) return false;

    const expiryDate = item.expiry ? parseLocalDate(item.expiry) : null;
    const days = expiryDate ? calculateCalendarDays(new Date(), expiryDate) : null;
    if (statusFilter === "attention") return days !== null && days <= threshold;
    if (statusFilter === "ordered") return item.ordered === true;
    if (statusFilter === "expired") return days !== null && days < 0;
    return true;
  });

  const sortedGroups = groupChemicalItems(filtered).sort((a, b) => {
    if (sortMode === "name") {
      return a.name.localeCompare(b.name, "pl", { sensitivity: "base" })
        || a.prefix.localeCompare(b.prefix, "pl", { numeric: true, sensitivity: "base" });
    }
    if (sortMode === "expiry") {
      return earliestGroupExpiry(a).localeCompare(earliestGroupExpiry(b))
        || a.name.localeCompare(b.name, "pl", { sensitivity: "base" });
    }
    const prefixOrder = a.prefix.localeCompare(b.prefix, "pl", { numeric: true, sensitivity: "base" });
    return prefixOrder || a.name.localeCompare(b.name, "pl", { sensitivity: "base" });
  });
  const groupAlerts = [];

  groupChemicalItems(categoryItems).forEach((group) => {
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
        const bestBackup = [...backups].sort((a, b) => String(b.expiry).localeCompare(String(a.expiry)))[0];
        groupAlerts.push({ prefix: group.prefix, name: group.name, type: "backup", date: bestBackup.expiry });
      } else {
        const expired = expiring.filter((item) => calculateCalendarDays(new Date(), parseLocalDate(item.expiry)) < 0);
        const candidate = [...(expired.length ? expired : expiring)].sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)))[0];
        const type = expired.length ? "expired" : expiring.some((item) => item.ordered) ? "ordered" : "warning";
        groupAlerts.push({ prefix: group.prefix, name: group.name, type, date: candidate.expiry });
      }
    }
  });

  sortedGroups.forEach((group, groupIndex) => {
    group.items.sort((a, b) => {
      if (sortMode === "expiry") return String(a.expiry || "9999-12-31").localeCompare(String(b.expiry || "9999-12-31"));
      return String(a.group || "").localeCompare(String(b.group || ""), "pl", { numeric: true });
    });

    const card = createElement("section", "bg-white rounded-xl border shadow-sm mb-3 overflow-hidden text-black");
    const header = createElement("div", "bg-gray-100 px-4 py-2 border-b flex items-center gap-3");
    header.append(createElement("span", "bg-blue-600 text-white text-[10px] px-2 py-0.5 rounded-full font-bold", `LP ${groupIndex + 1}`));
    const headingText = createElement("div", "flex flex-1 items-center gap-2 overflow-hidden text-black");
    headingText.append(
      createElement("span", "font-black uppercase text-xs truncate", group.name),
      createElement("span", "font-bold text-gray-500 text-[10px] uppercase border-l pl-2 leading-none border-gray-300", group.prefix),
    );
    const isInlineFormOpen = openInlineGroupKey === group.key;
    const addButton = createButton(
      isInlineFormOpen ? "−" : "+",
      isInlineFormOpen ? `Zamknij formularz dla ${group.name}` : `Dodaj nową pozycję do ${group.name}`,
      () => {
        openInlineGroupKey = isInlineFormOpen ? null : group.key;
        renderOdczynniki();
        if (!isInlineFormOpen) {
          queueMicrotask(() => document.querySelector("[data-inline-chemical-form] .inline-group")?.focus());
        }
      },
      "ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-lg font-black text-white shadow-sm hover:bg-blue-700",
    );
    header.append(headingText, addButton);
    card.append(header);
    if (isInlineFormOpen) card.append(createInlineChemicalForm(group));

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
        createButton("✕", "Usuń pozycję", async () => {
          if (confirm(`Usunąć „${item.name}”?`)) await deleteDoc(doc(db, "odczynniki", item.id));
        }, "text-red-600"),
      );
      row.append(info, actions);
      card.append(row);
    });

    container.append(card);
  });

  byId("chemicalResultSummary").textContent = `Pozycje: ${filtered.length} • Grupy: ${sortedGroups.length}`;
  if (sortedGroups.length === 0) {
    container.append(createElement("p", "rounded-lg border border-dashed bg-gray-50 p-6 text-center text-sm text-gray-500", "Brak pozycji spełniających kryteria."));
  }

  groupAlerts.forEach((alertData) => alertBox.append(renderChemicalAlert(alertData)));
  alertBox.classList.toggle("hidden", groupAlerts.length === 0);
}

function loadOdczynniki() {
  const unsubscribe = onSnapshot(
    query(collection(db, "odczynniki"), orderBy("timestamp", "asc")),
    (snapshot) => {
      odczynnikiCache = snapshot.docs.map((documentSnapshot) => ({ id: documentSnapshot.id, ...documentSnapshot.data() }));
      renderOdczynniki();
    },
    (error) => reportListenerError("Odczynniki", error),
  );
  snapshotUnsubscribers.push(unsubscribe);
}

async function addTask(lab, category) {
  const input = byId(`taskInput${lab.charAt(0).toUpperCase() + lab.slice(1)}${category}`);
  const name = input.value.trim();
  if (!name) return;
  await addDoc(collection(db, "harmonogram"), { name, lab, category, doneDate: null, timestamp: Date.now() });
  input.value = "";
}

function loadTasks() {
  const unsubscribe = onSnapshot(
    query(collection(db, "harmonogram"), orderBy("timestamp", "asc")),
    (snapshot) => {
      const stats = {};
      taskLabs.forEach((lab) => taskCategories.forEach((category) => {
        const key = `${lab}${category}`;
        stats[key] = { total: 0, doneThisYear: 0, doneThisMonth: false };
        byId(`taskList${lab.charAt(0).toUpperCase() + lab.slice(1)}${category}`)?.replaceChildren();
      }));

      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth();
      snapshot.docs.forEach((documentSnapshot) => {
        const task = documentSnapshot.data();
        const category = task.category || "Archiwalna";
        const key = `${task.lab}${category}`;
        if (!stats[key]) return;
        const doneDate = parseLocalDate(task.doneDate);
        const doneThisYear = Boolean(doneDate && doneDate.getFullYear() === currentYear);
        const doneThisMonth = doneThisYear && doneDate.getMonth() === currentMonth;
        stats[key].total += 1;
        if (doneThisYear) stats[key].doneThisYear += 1;
        if (doneThisMonth) stats[key].doneThisMonth = true;

        const row = createElement("div", `flex justify-between items-center p-3 border rounded-lg ${doneThisYear ? "task-done" : "bg-white shadow-sm"} mb-2 text-[11px] text-black`);
        const description = createElement("div", "flex flex-col");
        description.append(createElement("span", "font-bold text-black", task.name || "Bez nazwy"));
        if (doneThisYear) description.append(createElement("span", "text-[9px] text-green-600 font-bold uppercase mt-1", `Wykonano: ${task.doneDate}`));
        const actions = createElement("div", "flex gap-4");
        actions.append(
          createButton(doneThisYear ? "✅" : "⬜", doneThisYear ? "Oznacz jako niewykonane" : "Oznacz jako wykonane", () => updateDoc(doc(db, "harmonogram", documentSnapshot.id), { doneDate: doneThisYear ? null : formatLocalDate() }), "text-xl"),
          createButton("✕", "Usuń zadanie", async () => {
            if (confirm(`Usunąć „${task.name}”?`)) await deleteDoc(doc(db, "harmonogram", documentSnapshot.id));
          }, "text-red-600"),
        );
        row.append(description, actions);
        byId(`taskList${task.lab.charAt(0).toUpperCase() + task.lab.slice(1)}${category}`)?.append(row);
      });

      Object.entries(stats).forEach(([key, stat]) => {
        const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
        const monthStatus = byId(`mStatus${capitalizedKey}`);
        const yearStatus = byId(`yStatus${capitalizedKey}`);
        if (!monthStatus || !yearStatus) return;
        monthStatus.className = `p-2 rounded-lg text-[9px] font-bold border text-center mb-1 ${stat.doneThisMonth ? "bg-green-50 text-green-700" : "bg-orange-50 text-orange-800 animate-pulse"}`;
        monthStatus.textContent = stat.doneThisMonth ? "✅ Wykonano w tym miesiącu" : "⚠️ Brak zadania w tym miesiącu!";
        yearStatus.className = "p-2 rounded-lg text-[9px] font-bold border text-center mb-2 bg-gray-50 text-gray-500 uppercase";
        yearStatus.textContent = stat.doneThisYear === stat.total && stat.total > 0 ? "⭐ Plan roczny zakończony!" : `Plan roczny: ${stat.doneThisYear} / ${stat.total} zrobione`;
      });
    },
    (error) => reportListenerError("Harmonogram", error),
  );
  snapshotUnsubscribers.push(unsubscribe);
}

function cancelEquipmentEdit() {
  byId("editIdEquip").value = "";
  byId("equipName").value = "";
  byId("cancelEquipBtn").classList.add("hidden");
}

function startEquipmentEdit(equipment) {
  byId("editIdEquip").value = equipment.id;
  byId("equipName").value = equipment.name || "";
  byId("equipMonth").value = equipment.month || selectedWMonth;
  byId("equipType").value = equipment.type || "Wzorcowanie";
  byId("cancelEquipBtn").classList.remove("hidden");
  byId("equipName").focus();
}

async function saveEquipment() {
  const nameInput = byId("equipName");
  const name = nameInput.value.trim();
  if (!name) return;
  const data = { name, month: byId("equipMonth").value, type: byId("equipType").value };
  const editId = byId("editIdEquip").value;
  if (editId) {
    await updateDoc(doc(db, "wzorcowanie", editId), data);
  } else {
    await addDoc(collection(db, "wzorcowanie"), { ...data, doneDate: null, timestamp: Date.now() });
  }
  cancelEquipmentEdit();
}

function updateWzorcowanieUI() {
  const list = byId("equipmentList");
  if (!list) return;
  const nav = byId("monthsNav");
  nav.replaceChildren();
  for (let index = 1; index <= 12; index += 1) {
    const id = String(index).padStart(2, "0");
    const button = createButton(monthNames[id].slice(0, 3), `Pokaż ${monthNames[id]}`, () => {
      selectedWMonth = id;
      updateWzorcowanieUI();
    }, `px-3 py-2 border rounded text-[9px] font-bold uppercase ${selectedWMonth === id ? "active-month" : "bg-white text-gray-500"}`);
    nav.append(button);
  }

  list.replaceChildren();
  let total = 0;
  let done = 0;
  const upcoming = [];
  const currentYear = new Date().getFullYear();
  const nextDate = shiftCalendarMonth(new Date(), 1);
  const nextMonth = String(nextDate.getMonth() + 1).padStart(2, "0");

  wzorcowanieCache.forEach((equipment) => {
    const doneThisYear = isDoneInYear(equipment.doneDate, currentYear);
    if ((equipment.type === "Wzorcowanie" || !equipment.type) && equipment.month === nextMonth && !doneThisYear) upcoming.push(equipment.name || "Bez nazwy");
    if (equipment.month !== selectedWMonth) return;
    total += 1;
    if (doneThisYear) done += 1;
    const type = equipment.type || "Wzorcowanie";
    const colorClass = type === "Kalibracja" ? "bg-blue-100 text-blue-700" : type === "Sprawdzenie" ? "bg-green-100 text-green-700" : "bg-purple-100 text-purple-700";
    const row = createElement("div", `flex justify-between items-center p-3 border rounded-lg ${doneThisYear ? "task-done" : "bg-white shadow-sm"} mb-2 text-[11px] text-black`);
    const info = createElement("div");
    info.append(createElement("span", `${colorClass} px-1 rounded text-[8px] uppercase mr-2 font-bold`, type), createElement("span", "font-bold text-black", equipment.name || "Bez nazwy"));
    const actions = createElement("div", "flex gap-3");
    actions.append(
      createButton(doneThisYear ? "✅" : "⬜", doneThisYear ? "Oznacz jako niewykonane" : "Oznacz jako wykonane", () => updateDoc(doc(db, "wzorcowanie", equipment.id), { doneDate: doneThisYear ? null : formatLocalDate() }), "text-xl"),
      createButton("✏️", "Edytuj sprzęt", () => startEquipmentEdit(equipment)),
      createButton("✕", "Usuń sprzęt", async () => {
        if (confirm(`Usunąć „${equipment.name}”?`)) await deleteDoc(doc(db, "wzorcowanie", equipment.id));
      }, "text-red-600"),
    );
    row.append(info, actions);
    list.append(row);
  });

  byId("monthlyWzorcowanieCounter").textContent = `${monthNames[selectedWMonth]}: ${done} z ${total} zrobione`;
  const alertBox = byId("upcomingWzorcowanieAlert");
  alertBox.textContent = upcoming.length ? `📢 Planowane wzorcowania na ${monthNames[nextMonth]}: ${upcoming.join(", ")}` : "";
  alertBox.classList.toggle("hidden", upcoming.length === 0);
}

function loadWzorcowanie() {
  const unsubscribe = onSnapshot(
    query(collection(db, "wzorcowanie"), orderBy("timestamp", "asc")),
    (snapshot) => {
      wzorcowanieCache = snapshot.docs.map((documentSnapshot) => ({ id: documentSnapshot.id, ...documentSnapshot.data() }));
      updateWzorcowanieUI();
    },
    (error) => reportListenerError("Sprzęt", error),
  );
  snapshotUnsubscribers.push(unsubscribe);
}

function selectDay(date) {
  selectedDayStr = date;
  renderCalendar();
}

function changeMonth(offset) {
  calDate = shiftCalendarMonth(calDate, offset);
  selectedDayStr = formatLocalDate(calDate);
  renderCalendar();
}

async function addEvent() {
  const title = prompt("Nazwa wydarzenia:")?.trim();
  if (!title) return;
  await addDoc(collection(db, "wydarzenia"), { title, date: selectedDayStr, timestamp: Date.now() });
}

function renderEventList(container, events, emptyText, showDay = false) {
  container.replaceChildren();
  if (events.length === 0) {
    container.append(createElement("p", "text-[10px] text-gray-400 italic", emptyText));
    return;
  }

  events.forEach((event) => {
    const row = createElement("div", showDay ? "flex justify-between items-center bg-white p-2 rounded border-l-4 border-blue-400 shadow-sm text-[10px] mb-1 text-black font-bold" : "flex justify-between bg-white p-2 rounded shadow-sm text-[11px] font-semibold text-black");
    const label = showDay ? `${String(event.date || "").split("-")[2] || "--"} ${event.title || "Bez nazwy"}` : event.title || "Bez nazwy";
    row.append(
      createElement("span", "", label),
      createButton("✕", "Usuń wydarzenie", async () => {
        if (confirm(`Usunąć „${event.title}”?`)) await deleteDoc(doc(db, "wydarzenia", event.id));
      }, "text-red-600"),
    );
    container.append(row);
  });
}

function renderCalendar() {
  const grid = byId("calendarDays");
  const monthId = String(calDate.getMonth() + 1).padStart(2, "0");
  byId("calendarMonthYear").textContent = `${monthNames[monthId]} ${calDate.getFullYear()}`;
  grid.replaceChildren();
  const firstWeekday = new Date(calDate.getFullYear(), calDate.getMonth(), 1).getDay();
  const daysInMonth = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 0).getDate();
  const offset = firstWeekday === 0 ? 6 : firstWeekday - 1;
  for (let index = 0; index < offset; index += 1) grid.append(createElement("div", "calendar-day opacity-0"));

  const today = formatLocalDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${calDate.getFullYear()}-${monthId}-${String(day).padStart(2, "0")}`;
    const hasEvent = eventsCache.some((event) => event.date === date);
    const cell = createElement("button", `calendar-day ${date === today ? "today" : ""} ${date === selectedDayStr ? "selected" : ""} ${hasEvent ? "has-event" : ""}`, day);
    cell.type = "button";
    cell.setAttribute("aria-label", `Wybierz ${date}`);
    cell.addEventListener("click", () => selectDay(date));
    grid.append(cell);
  }

  byId("selectedDateLabel").textContent = `Dzień: ${selectedDayStr}`;
  const dayEvents = eventsCache.filter((event) => event.date === selectedDayStr);
  renderEventList(byId("dayEventsList"), dayEvents, "Brak wydarzeń.");
  const monthPrefix = `${calDate.getFullYear()}-${monthId}`;
  const monthEvents = eventsCache.filter((event) => typeof event.date === "string" && event.date.startsWith(monthPrefix)).sort((a, b) => a.date.localeCompare(b.date));
  renderEventList(byId("monthEventsList"), monthEvents, "Brak wydarzeń w miesiącu.", true);
}

function loadEvents() {
  const unsubscribe = onSnapshot(
    query(collection(db, "wydarzenia"), orderBy("timestamp", "asc")),
    (snapshot) => {
      eventsCache = snapshot.docs.map((documentSnapshot) => ({ id: documentSnapshot.id, ...documentSnapshot.data() }));
      renderCalendar();
    },
    (error) => reportListenerError("Kalendarz", error),
  );
  snapshotUnsubscribers.push(unsubscribe);
}

function startDataListeners() {
  clearSnapshots();
  loadOdczynniki();
  loadTasks();
  loadWzorcowanie();
  loadEvents();
}

async function handleLogin() {
  setLoginError();
  const email = byId("loginEmail").value.trim();
  const password = byId("loginPassword").value;
  if (!email || !password) {
    setLoginError("Podaj adres e-mail i hasło.");
    return;
  }

  try {
    await setPersistence(auth, browserLocalPersistence);
    await signInWithEmailAndPassword(auth, email, password);
    byId("loginPassword").value = "";
  } catch (error) {
    console.error(error);
    setLoginError("Logowanie nie powiodło się. Sprawdź e-mail i hasło.");
  }
}

async function handleAuthChange(user) {
  clearSnapshots();
  if (!user) {
    byId("loginSection").classList.remove("hidden");
    byId("appSection").classList.add("hidden");
    return;
  }

  try {
    const access = await getDoc(doc(db, "app_users", user.uid));
    const accessData = access.exists() ? access.data() : null;
    if (
      !accessData
      || accessData.active !== true
      || !["admin", "operator"].includes(accessData.role)
    ) {
      await signOut(auth);
      setLoginError("To konto nie ma dostępu do aplikacji.");
      return;
    }
  } catch (error) {
    console.error(error);
    await signOut(auth);
    setLoginError("Nie udało się potwierdzić dostępu do aplikacji.");
    return;
  }

  setLoginError();
  byId("loginSection").classList.add("hidden");
  byId("appSection").classList.remove("hidden");
  formRowCount = 0;
  byId("dynamicItemsContainer").replaceChildren();
  addFormRow();
  startDataListeners();
}

const delegatedActions = {
  login: () => handleLogin(),
  logout: () => signOut(auth),
  "switch-tab": (button) => switchTab(button.dataset.tab),
  "switch-chemical-tab": (button) => switchOdczynnikiSubTab(button.dataset.tab),
  "switch-task-tab": (button) => switchTaskSubTab(button.dataset.lab, button.dataset.category),
  "add-form-row": () => addFormRow(),
  "save-items": () => saveItems(),
  "cancel-edit": () => cancelEdit(),
  "open-word-import": () => openWordImport(),
  "choose-word-file": () => chooseWordFile(),
  "close-word-import": () => closeWordImport(),
  "confirm-word-import": () => confirmWordImport(),
  "export-chemicals-csv": () => exportChemicalsCsv(),
  "export-chemicals-json": () => exportChemicalsJson(),
  "add-task": (button) => addTask(button.dataset.lab, button.dataset.category),
  "add-equipment": () => saveEquipment(),
  "cancel-equipment-edit": () => cancelEquipmentEdit(),
  "change-month": (button) => changeMonth(Number(button.dataset.offset)),
  "add-event": () => addEvent(),
};

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = delegatedActions[button.dataset.action];
  if (!action) return;
  runSafely(() => action(button), "Nie udało się wykonać operacji.");
});

byId("chemicalSearch").addEventListener("input", renderOdczynniki);
byId("chemicalStatusFilter").addEventListener("change", renderOdczynniki);
byId("chemicalSort").addEventListener("change", renderOdczynniki);
byId("wordImportFile").addEventListener("change", (event) => {
  runSafely(() => handleWordImportFile(event.target.files?.[0]), "Nie udało się odczytać dokumentu Word.");
});
byId("wordImportCategory").addEventListener("change", () => {
  wordImportDrafts.forEach((draft) => { draft.category = byId("wordImportCategory").value; });
  if (wordImportDrafts.length) reclassifyWordImportDrafts(null, false);
});
byId("wordImportReceived").addEventListener("change", () => {
  wordImportDrafts.forEach((draft) => { draft.received = byId("wordImportReceived").value; });
});

byId("loginPassword").addEventListener("keydown", (event) => {
  if (event.key === "Enter") runSafely(handleLogin, "Logowanie nie powiodło się.");
});

onAuthStateChanged(auth, (user) => runSafely(() => handleAuthChange(user), "Nie udało się uruchomić aplikacji."));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker nie został uruchomiony.", error));
}

