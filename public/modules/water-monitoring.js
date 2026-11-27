import { formatPolishDate } from "../utils.js?v=37";
import { warsawDate } from "./inventory-alerts.js?v=37";
import { matchesInventorySearch } from "./inventory-quantity.js?v=37";
import { button, details, field, input } from "./inventory-ui.js?v=37";
import { byId, createElement, notify, setPositionOptions } from "./ui.js?v=37";
import { createWaterStore } from "./water-store.js?v=37";
import {
  firstWaterYear, waterAnnualId, waterCategory, waterCompleted, waterMeasurementTarget,
  waterPlan, waterSamplingLabel, waterUsesMeasurements,
} from "./water-plan.js?v=37";

const categories = {
  Archiwalna: "Próbki archiwalne",
  Slepa: "Próbki ślepe nieznane dla analityka",
  Porownania: "Porównania wewnątrzlaboratoryjne",
  Granice: "Granice oznaczalności i zakresu",
  Probkobranie: "Próbkobranie",
};
const currentYear = () => Number(warsawDate().slice(0, 4));
const dateLabel = (date) => formatPolishDate(date);
const percent = (done, total) => total ? Math.round(100 * done / total) : 0;

function controlLabel({ category, boundary, limit, matrix }) {
  if (category === "Probkobranie") return waterSamplingLabel(matrix);
  if (!boundary) return categories[category];
  const label = boundary === "gor" ? "Górna granica" : limit.includes("LOQ") ? "Granica oznaczalności" : "Dolna granica";
  return label + " · " + limit.replace(" (LOQ)", "");
}

export function createWaterMonitoring({ db, firestore, navigation }) {
  const store = createWaterStore(db, firestore);
  const methods = byId("waterMethods");
  const yearField = byId("waterYear");
  const searchField = byId("waterSearch");
  const position = byId("waterPosition");
  const categoryFilter = byId("waterFilter");
  const outstanding = byId("waterOutstanding");
  let year;
  let records = [];
  let loaded = false;
  let catalogue;
  let cards = [];
  let selectedMethod = "";

  function reset() {
    year = currentYear();
    records = [];
    loaded = false;
    catalogue = undefined;
    cards = [];
    selectedMethod = "";
    methods.replaceChildren();
    searchField.value = "";
    categoryFilter.value = "";
    outstanding.checked = false;
    yearField.onchange = () => {
      year = Number(yearField.value);
      render();
    };
    searchField.oninput = applyFilters;
    categoryFilter.onchange = applyFilters;
    outstanding.onchange = applyFilters;
    position.onchange = () => selectMethod(position.value);
    byId("clearWaterPosition").onclick = () => {
      selectMethod("");
      position.focus();
    };
    render();
  }

  function update(data) {
    records = data.filter((record) => record.lab === "woda" && record.category === waterCategory && record.origin === "plan");
    loaded = true;
    const scrollPosition = window.scrollY;
    render();
    if (!byId("tabContentWoda").hidden && window.scrollY !== scrollPosition) {
      window.scrollTo({ top: scrollPosition, behavior: "instant" });
    }
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

  function finishButton(name, selection, state, annual = false) {
    const expectedDate = state?.doneDate ?? null;
    const expectedNote = state?.note || "";
    const action = { kind: "finish", expectedDate, expectedNote, date: expectedDate, note: expectedNote };
    const label = expectedDate ? (annual ? "Edytuj kontrolę roczną" : "Zmień datę")
      : annual ? "Potwierdź kontrolę roczną" : "Oznacz wykonanie";
    return button(label, () => edit(name, selection, action, {
      withNote: true,
      clear: expectedDate ? { label: "Cofnij wykonanie", action: { ...action, date: null } } : null,
    }));
  }

  function measurementHistory(rows, selection, title, open) {
    const history = details("Historia oznaczeń (" + rows.length + ")");
    history.open = open;
    if (!rows.length) history.append(createElement("p", "lab-muted", "Brak zapisanych oznaczeń."));
    for (const [index, entry] of rows.entries()) {
      const row = createElement("div", "lab-data-row");
      const action = { kind: "edit", id: entry.id, date: entry.date, expectedDate: entry.date };
      row.append(createElement("span", "", (index + 1) + ". " + dateLabel(entry.date)),
        button("Koryguj", () => edit("Korekta · " + title, selection, action,
          { clear: { label: "Cofnij oznaczenie", action: { ...action, kind: "remove" } } })));
      history.append(row);
    }
    return history;
  }

  function styleStatus(element, done) {
    const finishedYear = year < currentYear();
    element.textContent = done ? "Wykonano" : finishedYear ? "Niezrealizowane" : "Do wykonania";
    element.className = "lab-water-status lab-notice-" + (done ? "ok" : finishedYear ? "danger" : "warning");
  }

  function paintRow(row, control, methodName, selection, state, completed, openHistory) {
    const label = controlLabel(control);
    const title = methodName + " · " + label;
    const caption = createElement("div", "lab-stack");
    const measured = waterUsesMeasurements(selection.itemKey);
    caption.append(createElement("strong", "", label));
    if (state?.doneDate) {
      caption.append(createElement("span", "lab-muted", (measured ? "Kontrola roczna · " : "") + dateLabel(state.doneDate)));
    }
    if (state?.note) caption.append(createElement("span", "lab-muted whitespace-pre-wrap", state.note));
    const status = createElement("span");
    styleStatus(status, completed);
    if (!measured) {
      row.replaceChildren(caption, status, finishButton(title, selection, state));
      return;
    }

    const rows = Object.entries(state?.measurements || {}).map(([id, date]) => ({ id, date }))
      .sort((first, second) => first.date.localeCompare(second.date) || first.id.localeCompare(second.id));
    const concentration = control.limit.replace(" (LOQ)", "");
    const measurementTitle = "Oznaczenie wzorca " + concentration;
    const heading = createElement("div", "lab-actions");
    heading.append(caption, status);
    const counter = createElement("span", "lab-water-method-count", "Oznaczenia wzorca · " + rows.length + "/" + waterMeasurementTarget);
    const progress = createElement("progress", "lab-water-progress");
    progress.max = waterMeasurementTarget;
    progress.value = rows.length;
    progress.dataset.tone = rows.length === waterMeasurementTarget ? "complete" : year < currentYear() ? "past" : "current";
    progress.setAttribute("aria-label", "Oznaczenia wzorca " + concentration);
    const actions = createElement("div", "lab-actions");
    if (rows.length < waterMeasurementTarget) {
      actions.append(button("Dodaj oznaczenie", () => edit(measurementTitle, selection, { kind: "add", id: crypto.randomUUID() })));
    }
    // The source programme explicitly allows the annual alternative at 10 mg/l.
    // Existing confirmations for the upper limit remain editable.
    if (selection.itemKey === "siar-g-dol" || state?.doneDate) {
      actions.append(finishButton(title, selection, state, true));
    }
    row.replaceChildren(heading, counter, progress);
    if (actions.childElementCount) row.append(actions);
    row.append(measurementHistory(rows, selection, measurementTitle, openHistory));
  }

  function buildMethod(method, controls) {
    const box = details("");
    box.classList.add("lab-water-method");
    box.dataset.waterMethod = method.key;
    const summary = box.firstElementChild;
    const info = createElement("span", "lab-water-method-info");
    const header = createElement("span", "lab-water-method-heading");
    const count = createElement("span", "lab-water-method-count");
    const status = createElement("span");
    header.append(createElement("strong", "", method.name), count, status);
    const sourceDate = createElement("time", "lab-muted", dateLabel(method.approvedOn));
    sourceDate.dateTime = method.approvedOn;
    const source = createElement("span", "lab-water-source lab-muted", "Data zatwierdzenia programu źródłowego ");
    source.append(sourceDate);
    const progress = createElement("progress", "lab-water-progress");
    progress.max = 100;
    progress.value = 0;
    progress.setAttribute("aria-label", "Realizacja: " + method.name);
    info.append(header, source, progress);
    summary.append(info);
    const body = createElement("div", "lab-stack lab-water-method-body");
    const groups = [];
    for (const [category, label] of Object.entries(categories)) {
      const entries = controls.filter((item) => item.category === category);
      if (!entries.length) continue;
      const section = createElement("section", "lab-stack lab-water-group");
      section.dataset.waterCategory = category;
      if (category === "Granice" || category === "Probkobranie") section.append(createElement("h3", "", label));
      const rows = entries.map((control) => {
        const row = createElement("div", "lab-data-row lab-water-control");
        row.classList.toggle("lab-water-measured", waterUsesMeasurements(control.key));
        row.dataset.waterControl = control.key;
        section.append(row);
        return { control, row };
      });
      groups.push({ category, rows });
      body.append(section);
    }
    box.append(body);
    return { box, key: method.key, name: method.name, count, status, progress, groups, total: controls.length };
  }

  function selectMethod(key) {
    selectedMethod = key;
    const selected = cards.find((card) => card.key === key);
    if (selected) selected.box.open = true;
    applyFilters();
  }

  function applyFilters() {
    const selected = cards.find(({ key }) => key === selectedMethod);
    const available = cards.filter(({ name, groups }) => matchesInventorySearch(searchField.value, name)
      && groups.some(({ category, rows }) => (!categoryFilter.value || categoryFilter.value === category)
        && (!outstanding.checked || rows.some(({ done }) => !done))));
    const option = ({ key, name }) => ({ value: key, label: name });
    setPositionOptions(position, available.map(option), selected ? option(selected) : null, "Wybierz oznaczenie");
    if (methods.firstElementChild !== (selected?.box || null)) {
      methods.replaceChildren(...(selected ? [selected.box] : []));
    }
    byId("clearWaterPosition").disabled = !selected;
    byId("waterNoMatches").hidden = !loaded || available.length > 0;
    byId("waterNoSelection").hidden = !loaded || Boolean(selected) || available.length === 0;
  }

  function updateControl(entry, name, yearRows, latestYear) {
    const { control, row } = entry;
    const state = yearRows.get(waterAnnualId(year, "plan", control.key));
    entry.done = waterCompleted(control.key, state);
    const revision = state?.revision ?? 0;
    if (entry.year !== year || entry.revision !== revision || entry.latestYear !== latestYear) {
      const openHistory = entry.year === year && Boolean(row.querySelector("details")?.open);
      entry.year = year;
      entry.revision = revision;
      entry.latestYear = latestYear;
      const selection = { year, origin: "plan", itemKey: control.key, planVersion: control.planVersion };
      paintRow(row, control, name, selection, state, entry.done, openHistory);
    }
    return Number(entry.done);
  }

  function render() {
    const latestYear = currentYear();
    if (yearField.options.length !== latestYear - firstWaterYear + 1) {
      yearField.replaceChildren();
      for (let value = latestYear; value >= firstWaterYear; value--) {
        const option = createElement("option", "", value);
        option.value = value;
        yearField.append(option);
      }
    }
    yearField.value = year;
    if (!loaded) {
      byId("waterTotal").textContent = "Wczytywanie harmonogramu…";
      byId("waterProgress").value = 0;
      applyFilters();
      return;
    }
    const plan = waterPlan(year);
    if (catalogue !== plan) {
      catalogue = plan;
      cards = [...plan.methods].sort((a, b) => a.name.localeCompare(b.name, "pl"))
        .map((method) => buildMethod(method, plan.controls.filter((control) => control.method === method.key)));
      const selected = cards.find(({ key }) => key === selectedMethod);
      if (selected) selected.box.open = true;
    }
    const yearRows = new Map(records.filter((record) => Number(record.year) === year)
      .map((record) => [record.id, record]));
    let done = 0;
    for (const card of cards) {
      let completed = 0;
      for (const { rows } of card.groups) {
        for (const entry of rows) completed += updateControl(entry, card.name, yearRows, latestYear);
      }
      done += completed;
      const progress = percent(completed, card.total);
      card.count.textContent = completed + "/" + card.total + " · " + progress + "%";
      styleStatus(card.status, completed === card.total);
      card.progress.value = progress;
      card.progress.dataset.tone = completed === card.total ? "complete" : year < latestYear ? "past" : "current";
    }
    const total = plan.controls.length;
    byId("waterTotal").textContent = "Wykonano " + done + " z " + total + " kontroli · " + percent(done, total) + "%";
    byId("waterProgress").value = percent(done, total);
    applyFilters();
  }

  return { reset, update };
}
