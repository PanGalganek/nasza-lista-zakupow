import {
  classifyChemicalDrafts,
  chemicalsToCsv,
  createChemicalBackup,
  readChemicalRowsFromDocx,
  rowsToChemicalDrafts,
} from "../import-export.js";
import { formatLocalDate } from "../utils.js";
import { byId, createElement, createInput, runSafely } from "./ui.js";

export function createChemicalTransferModule({ db, firestore, getItems, getCategory, createInlineField }) {
  const { collection, doc, writeBatch } = firestore;
  let drafts = [];

  function createImportInput(labelText, value, onInput, { type = "text", maxLength, onChange } = {}) {
    const input = createInput("w-full rounded border bg-white p-2 text-xs text-black", "", value, type);
    if (maxLength) input.maxLength = maxLength;
    input.addEventListener("input", () => onInput(input.value));
    if (onChange) input.addEventListener("change", onChange);
    return createInlineField(labelText, input);
  }

  function actionsFor(draft) {
    if (draft.status === "changed") return [["skip", "Pomiń"], ["update", "Zaktualizuj istniejącą"], ["add", "Dodaj jako nową"]];
    if (draft.status === "new" || draft.status === "ambiguous") return [["skip", "Pomiń"], ["add", "Dodaj jako nową"]];
    return [["skip", "Pomiń — bez zmian"]];
  }

  function updateSummary() {
    const counts = { new: 0, changed: 0, unchanged: 0, ambiguous: 0, add: 0, update: 0 };
    drafts.forEach((draft) => {
      counts[draft.status] += 1;
      if (draft.action === "add" || draft.action === "update") counts[draft.action] += 1;
    });
    byId("wordImportStatus").textContent = `Rozpoznano: ${drafts.length} • nowe: ${counts.new} • zmienione: ${counts.changed} • bez zmian: ${counts.unchanged} • do sprawdzenia: ${counts.ambiguous} • wybrano: ${counts.add} dodaj, ${counts.update} aktualizuj`;
  }

  function reclassify(changedImportIndex = null, preserveOtherActions = true) {
    const previousActions = new Map(drafts.map((draft) => [draft.importIndex, draft.action]));
    drafts = classifyChemicalDrafts(drafts, getItems());
    if (preserveOtherActions) {
      drafts.forEach((draft) => {
        if (draft.importIndex === changedImportIndex) return;
        const previous = previousActions.get(draft.importIndex);
        if (actionsFor(draft).some(([value]) => value === previous)) draft.action = previous;
      });
    }
    renderPreview();
  }

  function renderPreview() {
    const preview = byId("wordImportPreview");
    preview.replaceChildren();
    updateSummary();
    byId("wordImportActions").classList.toggle("hidden", drafts.length === 0);

    drafts.forEach((draft, index) => {
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
      actionsFor(draft).forEach(([value, label]) => {
        const option = createElement("option", "", label);
        option.value = value;
        action.append(option);
      });
      action.value = draft.action;
      action.addEventListener("change", () => {
        draft.action = action.value;
        updateSummary();
      });
      heading.append(title, action);

      if (draft.changes.length) {
        const changes = createElement("div", "mb-3 rounded border border-blue-200 bg-white p-2 text-[10px] text-black");
        changes.append(createElement("p", "mb-1 font-black uppercase text-blue-800", "Proponowane zmiany"));
        draft.changes.forEach((change) => changes.append(createElement("p", "", `${change.label}: ${change.before} → ${change.after}`)));
        card.append(heading, changes);
      } else card.append(heading);

      const fields = createElement("div", "grid grid-cols-1 gap-2 md:grid-cols-2");
      const refreshMatch = () => reclassify(draft.importIndex);
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

  function close() {
    drafts = [];
    byId("wordImportFile").value = "";
    byId("wordImportPreview").replaceChildren();
    byId("wordImportActions").classList.add("hidden");
    byId("wordImportPanel").classList.add("hidden");
  }

  function chooseFile() {
    byId("wordImportFile").value = "";
    byId("wordImportFile").click();
  }

  function open() {
    byId("wordImportCategory").value = getCategory();
    byId("wordImportReceived").value = formatLocalDate();
    byId("wordImportStatus").textContent = "Wybierz dokument DOCX. Starszy format DOC zapisz najpierw w Wordzie jako DOCX.";
    byId("wordImportPanel").classList.remove("hidden");
    chooseFile();
  }

  async function handleFile(file) {
    if (!file) return;
    const extension = file.name.toLocaleLowerCase("pl").split(".").pop();
    if (extension === "doc") {
      drafts = [];
      byId("wordImportPreview").replaceChildren();
      byId("wordImportActions").classList.add("hidden");
      byId("wordImportStatus").textContent = "To jest format DOC (Word 97–2003). Otwórz plik w Wordzie, wybierz „Zapisz jako” → „Dokument programu Word (*.docx)” i wskaż nowy plik.";
      return;
    }
    if (extension !== "docx") throw new Error("Obsługiwane są dokumenty DOCX.");
    byId("wordImportStatus").textContent = `Odczytuję „${file.name}”…`;
    const rows = await readChemicalRowsFromDocx(await file.arrayBuffer());
    drafts = rowsToChemicalDrafts(rows, {
      category: byId("wordImportCategory").value,
      received: byId("wordImportReceived").value,
    }).map((draft, importIndex) => ({ ...draft, importIndex }));
    if (drafts.length === 0) throw new Error("Nie znaleziono tabeli z kolumnami Grupa, Nazwa i Zastosowanie.");
    reclassify(null, false);
  }

  function isIsoDate(value, allowEmpty = false) {
    if (allowEmpty && value === "") return true;
    return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value);
  }

  async function confirmImport() {
    const selected = drafts.filter((draft) => draft.action !== "skip");
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
          name: draft.name.slice(0, 200), group: draft.group.slice(0, 100), usage: draft.usage.slice(0, 500),
          expiry: draft.expiry, category: draft.category, ordered: false,
        };
        if (draft.action === "update") {
          const groupChanged = draft.changes.some((change) => change.field === "group");
          batch.update(doc(db, "odczynniki", draft.matchId), { ...payload, received: groupChanged ? draft.received : (draft.existing.received || draft.received) });
        } else {
          batch.set(doc(collection(db, "odczynniki")), { ...payload, received: draft.received, timestamp: Date.now() + index });
        }
      });
      await batch.commit();
      close();
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

  function exportCsv() {
    downloadFile(`e-laboratorium-${formatLocalDate()}.csv`, chemicalsToCsv(getItems()), "text/csv;charset=utf-8");
  }

  function exportJson() {
    downloadFile(`e-laboratorium-kopia-${formatLocalDate()}.json`, JSON.stringify(createChemicalBackup(getItems()), null, 2), "application/json;charset=utf-8");
  }

  function bind() {
    byId("wordImportFile").addEventListener("change", (event) => {
      runSafely(() => handleFile(event.target.files?.[0]), "Nie udało się odczytać dokumentu Word.");
    });
    byId("wordImportCategory").addEventListener("change", () => {
      drafts.forEach((draft) => { draft.category = byId("wordImportCategory").value; });
      if (drafts.length) reclassify(null, false);
    });
    byId("wordImportReceived").addEventListener("change", () => {
      drafts.forEach((draft) => { draft.received = byId("wordImportReceived").value; });
    });
  }

  return { bind, chooseFile, close, confirmImport, exportCsv, exportJson, open };
}
