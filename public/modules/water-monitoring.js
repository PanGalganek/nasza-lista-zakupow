import { formatPolishDate } from "../utils.js?v=32";
import { warsawDate } from "./inventory-alerts.js?v=32";
import { button, details, field, input } from "./inventory-ui.js?v=32";
import { byId, createElement, notify } from "./ui.js?v=32";
import { createWaterStore } from "./water-store.js?v=32";
import {
  firstWaterYear, matchWaterTasks, sixMeasurementsKey, waterAnnualId, waterCategory,
  waterCompleted, waterDateInYear, waterMatrices, waterPlan,
} from "./water-plan.js?v=32";

const categories = ["Archiwalna", "Slepa", "Porownania", "Probkobranie", "Granice"];
const dateLabel = (date) => formatPolishDate(date);
const currentYear = () => Number(warsawDate().slice(0, 4));
const categoryOf = (task) => task.category || "Archiwalna";

export function createWaterMonitoring({ db, firestore, navigation }) {
  const store = createWaterStore(db, firestore);
  const openGroups = new Set();
  let year;
  let records = [];
  let loaded = false;
  let selectedCategory;

  function reset() {
    year = currentYear();
    records = [];
    loaded = false;
    openGroups.clear();
    const select = byId("waterYear");
    select.onchange = () => {
      year = Number(select.value);
      openGroups.clear();
      render();
    };
    render();
  }

  function update(data) {
    records = data.filter((record) => record.lab === "woda");
    loaded = true;
    render();
  }

  function selectCategory(category) {
    if (year > currentYear()) year = currentYear();
    selectedCategory = category;
    for (const key of categories) byId("subContentWoda" + key).classList.toggle("hidden", key !== category);
    render();
  }

  function panelGroup(title, key) {
    const group = details(title);
    group.open = openGroups.has(key);
    group.addEventListener("toggle", () => {
      if (!group.isConnected) return;
      if (group.open) openGroups.add(key);
      else openGroups.delete(key);
    });
    return group;
  }

  function edit(title, selection, action, { showDate = true, withNote = false, clear } = {}) {
    const form = createElement("form", "lab-stack");
    const now = warsawDate();
    const date = input("Data", action.date || (year === currentYear() ? now : ""), "date");
    date.required = showDate;
    date.min = year + "-01-01";
    date.max = year === currentYear() ? now : year + "-12-31";
    if (showDate) form.append(field("Data wykonania", date));
    const note = createElement("textarea", "");
    note.value = action.note ?? "";
    note.maxLength = 300;
    if (withNote) form.append(field("Uwagi (opcjonalnie)", note));
    const feedback = createElement("p", "text-sm lab-muted");
    feedback.setAttribute("role", "status");
    const footer = createElement("div", "lab-dialog-actions");
    const submit = createElement("button", "lab-button lab-button-primary", "Zapisz");
    submit.type = "submit";
    let pending = false;
    const cancel = button("Anuluj", () => navigation.close());
    async function commit(next) {
      if (pending) return;
      pending = true;
      for (const control of form.querySelectorAll("button")) control.disabled = true;
      feedback.textContent = "Zapisywanie…";
      try {
        await store.save(selection, next);
        navigation.close(true);
        notify("Zapisano kontrolę.");
      } catch (error) {
        feedback.textContent = error.code && globalThis.navigator.onLine
          ? "Zapis nie został potwierdzony. Sprawdź połączenie lub odśwież dane i spróbuj ponownie."
          : error.message;
      } finally {
        pending = false;
        for (const control of form.querySelectorAll("button")) control.disabled = false;
      }
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (form.reportValidity()) commit({ ...action, date: showDate ? date.value : null, note: note.value.trim() });
    });
    if (clear) footer.append(button(clear.label, () => commit(clear.action)));
    footer.append(cancel, submit);
    form.append(feedback, footer);
    navigation.show(form, title, { busy: () => pending });
  }

  function finishButton(name, selection, state, alternate = false) {
    const expectedDate = state?.doneDate ?? null;
    const expectedNote = state?.note || "";
    const action = { kind: "finish", expectedDate, expectedNote, date: expectedDate, note: expectedNote };
    const label = expectedDate ? "Zmień datę" : alternate ? "Potwierdź kontrolę roczną" : "Oznacz wykonanie";
    return button(label, () => edit(name, selection, action, {
      withNote: true,
      clear: expectedDate ? { label: "Cofnij wykonanie", action: { ...action, date: null } } : null,
    }));
  }

  function status(done) {
    const label = done ? "Wykonano" : year < currentYear() ? "Niezrealizowane" : "Do wykonania";
    return createElement("span", "lab-water-status " + (done ? "lab-notice-ok" : year < currentYear() ? "lab-notice-danger" : "lab-notice-warning"), label);
  }

  function measurementList(state, selection) {
    const rows = Object.entries(state?.measurements || {}).map(([id, date]) => ({ id, date }))
      .sort((first, second) => first.date.localeCompare(second.date) || first.id.localeCompare(second.id));
    const group = panelGroup(`Oznaczenia wzorca 10 mg/l (${rows.length}/6)`, "water-measurements");
    group.append(createElement("p", "lab-muted", "Sześć oznaczeń albo odrębna kontrola roczna zaliczają tę pozycję."));
    if (rows.length < 6) {
      group.append(button("Dodaj oznaczenie", () => edit("Oznaczenie wzorca 10 mg/l", selection, { kind: "add", id: crypto.randomUUID() })));
    }
    for (const [index, entry] of rows.entries()) {
      const row = createElement("div", "lab-data-row");
      const action = { kind: "edit", id: entry.id, date: entry.date, expectedDate: entry.date };
      row.append(createElement("span", "", `${index + 1}. ${dateLabel(entry.date)}`),
        button("Koryguj", () => edit("Korekta oznaczenia", selection, action,
          { clear: { label: "Usuń oznaczenie", action: { ...action, kind: "remove" } } })));
      group.append(row);
    }
    return group;
  }

  function render() {
    if (!year) return;
    const plan = waterPlan(year);
    const controls = plan?.controls || [];
    const annual = records.filter((record) => record.category === waterCategory);
    const legacy = records.filter((record) => record.category !== waterCategory);
    const yearRows = new Map(annual.filter((record) => Number(record.year) === year).map((record) => [record.id, record]));
    const { linked, used, candidates } = matchWaterTasks(legacy, annual, year, controls);
    const stateFor = (origin, key, task) => yearRows.get(waterAnnualId(year, origin, key))
      || (waterDateInYear(task?.doneDate, year) ? { doneDate: task.doneDate } : null);
    const selected = byId("waterYear");
    const oldest = Math.min(firstWaterYear, ...legacy.map((task) => Number(task.doneDate?.slice(0,4)) || firstWaterYear));
    if (selected.options.length !== currentYear() - oldest + 1) {
      selected.replaceChildren();
      for (let value = currentYear(); value >= oldest; value--) {
        const option = createElement("option", "", value);
        option.value = value;
        selected.append(option);
      }
    }
    selected.value = year;
    for (const category of categories) {
      const entries = controls.filter((control) => control.category === category);
      const completion = entries.filter(({ key }) => waterCompleted(key, stateFor("plan", key, linked.get(key)))).length;
      const meter = document.querySelector(`[data-water-progress="${category}"]`);
      meter.textContent = !loaded ? "Wczytywanie…" : entries.length ? `Wykonano ${completion} z ${entries.length}` : "Nie dotyczy planu";
      meter.className = "lab-water-status " + (!loaded || !entries.length ? "lab-water-neutral"
        : completion === entries.length ? "lab-notice-ok" : year < currentYear() ? "lab-notice-danger" : "lab-notice-warning");
    }
    if (!selectedCategory) return;
    const container = byId("waterPlan" + selectedCategory);
    container.replaceChildren();
    const entries = controls.filter((control) => control.category === selectedCategory);
    const taskList = byId("taskListWoda" + selectedCategory);
    const manualForm = byId("taskInputWoda" + selectedCategory)?.form;
    taskList?.replaceChildren();
    if (manualForm) manualForm.hidden = !loaded || !plan;
    if (!loaded) {
      container.append(createElement("p", "lab-empty", "Wczytywanie harmonogramu…"));
      return;
    }
    if (!entries.length) container.append(createElement("p", "lab-empty", "Brak planu dla wybranego roku."));
    const groups = new Map();
    for (const control of entries) {
      const groupKey = control.matrix || (control.category === "Granice" ? control.method : "");
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(control);
    }
    for (const [groupKey, groupControls] of groups) {
      const complete = groupControls.filter(({ key }) => waterCompleted(key, stateFor("plan", key, linked.get(key)))).length;
      const block = groupKey ? panelGroup(`${waterMatrices[groupKey] || groupControls[0].name} · ${complete}/${groupControls.length}`,
        selectedCategory + "-" + groupKey) : container;
      for (const control of groupControls) {
        const { key, name, boundary, limit } = control;
        const source = linked.get(key);
        const state = stateFor("plan", key, source);
        const label = boundary ? `${boundary === "dol" ? (limit.includes("LOQ") || key === sixMeasurementsKey ? "Granica oznaczalności" : "Dolna granica") : "Górna granica"} · ${limit.replace(" (LOQ)", "")}` : name;
        const choose = { year, itemKey: key, planVersion: plan.version, origin: "plan", legacyTaskId: source?.id };
        const row = createElement("div", "lab-data-row lab-water-control");
        row.dataset.waterControl = key;
        const caption = createElement("div", "lab-stack");
        caption.append(createElement("strong", "", label));
        if (state?.doneDate) caption.append(createElement("span", "lab-muted", dateLabel(state.doneDate)));
        if (state?.note) caption.append(createElement("span", "lab-muted whitespace-pre-wrap", state.note));
        row.append(caption, status(waterCompleted(key, state)), finishButton(name, choose, state, key === sixMeasurementsKey));
        block.append(row);
        if (key === sixMeasurementsKey) block.append(measurementList(state, choose));
      }
      if (groupKey) container.append(block);
    }

    if (!taskList) return;
    const legacyIds = new Set(legacy.map(({ id }) => id));
    const linkedIds = new Set(annual.filter((record) => record.origin === "plan" && Number(record.year) <= year)
      .map((record) => record.legacyTaskId).filter(Boolean));
    const archived = [...yearRows.values()]
      .filter((record) => record.origin === "manual" && record.taskName && !legacyIds.has(record.itemKey))
      .map((record) => ({ id: record.itemKey, name: record.taskName, category: record.taskCategory, sourceRemoved: true }));
    const rows = [...legacy, ...archived].filter((task) => categoryOf(task) === selectedCategory
      && (plan || waterDateInYear(task.doneDate, year)));
    if (!rows.length) taskList.append(createElement("p", "lab-empty", "Brak zapisanych zadań dla tego widoku."));
    for (const task of rows) {
      const linkedTask = used.has(task.id) || (task.sourceRemoved && linkedIds.has(task.id));
      const candidate = candidates.get(task.id);
      const historicalOnly = candidate?.reason && task.doneDate && Number(task.doneDate.slice(0, 4)) < firstWaterYear;
      const state = stateFor("manual", task.id, task);
      const row = createElement("div", "lab-data-row lab-water-manual");
      const caption = createElement("div", "lab-stack");
      caption.append(createElement("strong", "", task.name));
      if (task.sourceRemoved) caption.append(createElement("span", "lab-muted", "Zapis roczny zachowany po usunięciu zadania źródłowego."));
      if (task.doneDate) caption.append(createElement("span", "lab-muted", `Data w oryginalnym zadaniu ${dateLabel(task.doneDate)}`));
      if (!linkedTask && state?.doneDate && state.doneDate !== task.doneDate) caption.append(createElement("span", "", dateLabel(state.doneDate)));
      if (state?.note) caption.append(createElement("span", "lab-muted whitespace-pre-wrap", state.note));
      row.append(caption);
      if (plan && linkedTask) row.append(createElement("span", "lab-water-status lab-water-neutral", "Powiązano z planem"));
      else if (historicalOnly && plan) row.append(createElement("span", "lab-water-status lab-water-neutral", "Historia sprzed 2026 r."));
      else if (plan) {
        row.append(status(Boolean(state?.doneDate)), finishButton(task.name, { year, origin: "manual", itemKey: task.id }, state));
        if (candidate && !linked.has(candidate.control.key) && (!task.doneDate || task.doneDate.slice(0, 4) >= String(firstWaterYear))) {
          const target = candidate.control;
          caption.append(createElement("span", "lab-muted", candidate.reason || "Zadanie wymaga powiązania."));
          row.append(button("Powiąż z planem", () => {
            const destination = [target.name, waterMatrices[target.matrix]].filter(Boolean).join(" · ");
            if (!confirm(`Powiązać „${task.name}” z kontrolą „${destination}” w roku ${year}?`)) return;
            return store.save({ year, origin: "plan", itemKey: target.key, planVersion: plan.version, legacyTaskId: task.id }, { kind: "link" })
              .then(() => notify("Powiązano zadanie."));
          }));
        }
      }
      taskList.append(row);
    }
  }

  return { reset, update, selectCategory };
}
