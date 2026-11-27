import { loadExecution, loadExecutionHistory, savePlan } from "./api.js";
import { searchText } from "./model.js";
import { calendarDate, monthlyNames } from "./plan-model.js";
import { currentPeriod, deadlineWarnings, executionCounts, executionTiming, isOverdue } from "./execution-model.js";

const get = id => document.getElementById("exec-" + id);
const collator = new Intl.Collator("pl", { numeric: true });
const when = new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "short", timeStyle: "short" });
const dateText = value => value.split("-").reverse().join(".");
const monthText = (year, month) => monthlyNames[month - 1] + " " + year;
const actionNames = { complete: "Odhaczono", correct: "Skorygowano", undo: "Cofnięto odhaczenie" };
const actions = { complete: "Zapisz wykonanie", correct: "Zapisz korektę", undo: "Cofnij odhaczenie" };

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text, onClick) {
  const element = node("button", text);
  element.type = "button";
  element.onclick = onClick;
  return element;
}

function options(field, items, value) {
  field.replaceChildren(...items.map(([key, title]) => new Option(title, key)));
  field.value = value;
}

export function executionView() {
  let equipment = {};
  let assignments = {};
  let source;
  let plans = [];
  let current = currentPeriod();
  let selection = current;
  let followCurrent = true;
  let opened;
  let operation;
  let busy = false;
  let requestEpoch = 0;
  let loading = false;
  let loaded = false;
  let failed = false;
  let historyKey;
  const dialog = get("dialog");
  const history = get("history");
  options(get("month"), monthlyNames.map((month, i) => [i + 1, month]), selection.month);

  function equipmentText(device) {
    return device.name + (device.number ? " · " + device.number : "");
  }

  function deviceFor(item) {
    return equipment[item.deviceId] ?? { name: item.deviceName ?? "Sprzęt z historii", number: item.number };
  }

  function kindFor(item) {
    const activity = deviceFor(item).activities?.find(activity => activity.id === item.activityId);
    const kind = item.kind ?? activity?.kind ?? "Czynność";
    const label = item.label ?? activity?.label ?? "";
    return kind + (label ? " · " + label : "");
  }

  function report(text, error = false) {
    get("status").textContent = text;
    get("status").dataset.tone = error ? "error" : "";
  }

  function yearPlan(year) {
    return plans.find(plan => plan.year === year);
  }

  function syncYears() {
    const years = [...new Set([current.year, selection.year, ...plans.map(plan => plan.year)])].sort((a, b) => b - a);
    const select = get("year");
    if (years.join(",") !== select.dataset.years) {
      options(select, years.map(year => [year, year]), selection.year);
      select.dataset.years = years.join(",");
    } else select.value = selection.year;
    get("month").value = selection.month;
  }

  function setPeriod(year, month, follow = false) {
    followCurrent = follow;
    selection = { year, month };
    syncYears();
    render();
  }

  function renderCount(id, entries, label) {
    const { total, done } = executionCounts(entries);
    const percent = total ? Math.round(100 * done / total) : 0;
    get(id + "-total").textContent = label + " · " + done + " z " + total + " · " + percent + "%";
    get(id + "-progress").value = percent;
  }

  function sortByDevice(a, b) {
    return collator.compare(equipmentText(deviceFor(a)), equipmentText(deviceFor(b)))
      || collator.compare(kindFor(a), kindFor(b)) || a.id.localeCompare(b.id);
  }

  function termRow(entry) {
    const device = deviceFor(entry);
    const card = node("article", undefined, "card panel execution-row");
    card.dataset.execEntry = entry.id;
    const info = node("div", undefined, "stack");
    info.append(node("h3", equipmentText(device)), node("p", kindFor(entry), "muted"));
    const status = !entry.doneDate
      ? (isOverdue(entry, selection.year, current) ? "Zaległe" : "Do wykonania")
      : "Wykonano " + dateText(entry.doneDate) + " · " + executionTiming(entry, selection.year);
    info.append(node("span", status, "pill " + (entry.doneDate ? "approved" : isOverdue(entry, selection.year, current) ? "manual" : "")));
    if (device.status === "withdrawn") info.append(node("small", "Sprzęt wycofany"));
    if (entry.doneNotes) info.append(node("p", entry.doneNotes, "registry-notes"));
    const controls = node("div", undefined, "actions");
    if (entry.doneDate) {
      controls.append(button("Zmień wykonanie", () => openDialog(entry, "correct")), button("Cofnij odhaczenie", () => openDialog(entry, "undo")));
    } else controls.append(button("Odhacz", () => openDialog(entry, "complete")));
    card.append(info, controls);
    return card;
  }

  function renderWarnings() {
    const { current: due, overdue, upcoming, next } = deadlineWarnings(plans, current);
    const groups = [
      ["current", "Niewykonane w bieżącym miesiącu", due.sort(sortByDevice)],
      ["overdue", "Zaległe z wcześniejszych miesięcy i lat", overdue],
      ["upcoming", "Kolejny miesiąc · " + monthText(next.year, next.month), upcoming.sort(sortByDevice)],
    ];
    for (const [id, label, entries] of groups) {
      get(id + "-count").textContent = label + " (" + entries.length + ")";
      const holder = get(id + "-rows");
      holder.replaceChildren(...(entries.length ? entries.map(entry => {
        const control = button(equipmentText(deviceFor(entry)) + " · " + kindFor(entry), () => {
          get("query").value = "";
          get("filter").value = "all";
          setPeriod(entry.year, entry.month);
          const target = document.querySelector('[data-exec-entry="' + CSS.escape(entry.id) + '"]');
          if (target) {
            target.scrollIntoView({ block: "center" });
            target.querySelector("button")?.focus({ preventScroll: true });
          }
        });
        control.className = "warning-term";
        control.append(node("small", monthText(entry.year, entry.month) + (entry.doneDate ? " · Wykonano " + dateText(entry.doneDate) : "")));
        return control;
      }) : [node("p", "Brak pozycji.", "muted")]));
    }
  }

  function renderRows() {
    const entries = yearPlan(selection.year)?.entries ?? [];
    const month = entries.filter(entry => entry.month === selection.month);
    renderCount("month", month, monthText(selection.year, selection.month));
    renderCount("year", entries, "Rok " + selection.year);
    const query = searchText(get("query").value).trim().split(/\s+/).filter(Boolean);
    const status = get("filter").value;
    const matches = month.filter(entry => {
      const statusMatches = status === "all" || (status === "done" && entry.doneDate)
        || (status === "pending" && !entry.doneDate) || (status === "overdue" && isOverdue(entry, selection.year, current));
      return statusMatches && query.every(word => searchText(equipmentText(deviceFor(entry))).includes(word));
    });
    get("rows").replaceChildren(...(matches.length ? matches.sort(sortByDevice).map(termRow)
      : [node("p", month.length ? "Brak czynności dla wybranych filtrów." : "Brak zatwierdzonych terminów w wybranym miesiącu.", "card panel muted")]));
  }

  function renderHistoryOptions(chosen = get("history-device").value) {
    const devices = Object.values(equipment).sort((a, b) => collator.compare(equipmentText(a), equipmentText(b)) || collator.compare(a.id, b.id));
    options(get("history-device"), [["", "Wszystkie urządzenia w wybranym roku"],
      ...devices.map(device => [device.id, equipmentText(device) + (device.status === "withdrawn" ? " · wycofany" : "")])], equipment[chosen] ? chosen : "");
  }

  function render() {
    syncYears();
    renderRows();
    renderWarnings();
    if (history.open) refreshHistory();
  }

  function historyCard(event) {
    const card = node("article", undefined, "entry stack");
    const original = event.deviceName ? equipmentText({ name: event.deviceName, number: event.number }) : equipmentText(deviceFor(event));
    card.append(node("h3", actionNames[event.action] + " · " + original),
      node("p", kindFor(event) + " · Plan: " + monthText(event.year, event.month) + " · " + when.format(new Date(event.savedAt)), "muted"));
    if (event.before) card.append(node("p", "Poprzednie wykonanie · " + dateText(event.before.date) + (event.before.notes ? " · " + event.before.notes : ""), "registry-notes"));
    if (event.after) card.append(node("p", "Zapisane wykonanie · " + dateText(event.after.date) + (event.after.notes ? " · " + event.after.notes : ""), "registry-notes"));
    return card;
  }

  async function renderSourceHistory(deviceId, sourceIds, key) {
    const holder = get("history-source");
    holder.hidden = true;
    if (!sourceIds.size) return;
    try {
      source ??= fetch("/source.json").then(response => {
        if (!response.ok) throw new Error("Nie można odczytać kopii źródłowej.");
        return response.json();
      });
      const rows = (await source).sources.filter(row => row.doneDate && sourceIds.has(row.id))
        .sort((a, b) => b.doneDate.localeCompare(a.doneDate));
      if (historyKey !== key || !rows.length) return;
      holder.replaceChildren(node("h3", "Wykonania źródłowe · rok planu nieustalony"));
      if (!equipment[deviceId]?.verified) holder.append(node("p", "Powiązanie robocze z rejestru sprzętu.", "muted"));
      for (const row of rows) {
        const item = node("article", undefined, "entry");
        item.append(node("h3", row.name), node("p", (row.type ?? "Rodzaj niepodany") + " · Planowany miesiąc: "
          + monthlyNames[Number(row.month) - 1] + " · Wykonano " + dateText(row.doneDate), "muted"));
        holder.append(item);
      }
      holder.hidden = false;
    } catch (error) {
      source = undefined;
      if (historyKey !== key) return;
      holder.replaceChildren(node("p", error.message, "form-error"));
      holder.hidden = false;
    }
  }

  async function refreshHistory() {
    const deviceId = get("history-device").value;
    const sourceIds = new Set(Object.entries(assignments).filter(([, value]) => value.groupId === deviceId).map(([id]) => id));
    const relevant = deviceId ? plans : plans.filter(plan => plan.year === selection.year);
    const key = JSON.stringify([deviceId, selection.year, relevant.map(plan => [plan.year, plan.revision]),
      [...sourceIds], equipment[deviceId]?.verified]);
    if (key === historyKey) return;
    historyKey = key;
    get("history-scope").textContent = deviceId ? "Wybrane urządzenie · wszystkie zatwierdzone lata" : "Historia roku " + selection.year;
    get("history-rows").textContent = "Wczytywanie historii…";
    const sourceHistory = renderSourceHistory(deviceId, sourceIds, key);
    try {
      const entries = (await Promise.all(relevant.map(async plan =>
        (await loadExecutionHistory(plan.year)).map(event => ({ ...event, year: plan.year }))))).flat()
        .filter(event => !deviceId || event.deviceId === deviceId)
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.revision - a.revision);
      if (historyKey !== key) return;
      get("history-rows").replaceChildren(...(entries.length ? entries.map(historyCard) : [node("p", "Brak zapisów wykonania.", "muted")]));
    } catch (error) {
      if (historyKey !== key) return;
      historyKey = undefined;
      get("history-rows").textContent = error.message;
    }
    await sourceHistory;
  }

  async function refresh() {
    if (loading || busy) return;
    const epoch = requestEpoch;
    loading = true;
    try {
      const latest = await loadExecution();
      if (epoch !== requestEpoch) return;
      const next = currentPeriod();
      const changed = next.year !== current.year || next.month !== current.month
        || latest.map(plan => plan.year + ":" + plan.revision).join() !== plans.map(plan => plan.year + ":" + plan.revision).join();
      current = next;
      if (followCurrent) selection = current;
      if (changed || !loaded) {
        plans = latest;
        render();
      } else if (history.open) refreshHistory();
      if (failed || !loaded) report("");
      loaded = true;
      failed = false;
      if (dialog.open && yearPlan(opened.year)?.revision !== opened.revision && !get("error").textContent) {
        get("error").textContent = "Plan zmienił się w innym oknie. Wpisane dane zostały zachowane.";
      }
    } catch (error) {
      if (epoch !== requestEpoch) return;
      failed = true;
      report(error.message, true);
    } finally {
      loading = false;
    }
  }

  function openDialog(entry, action) {
    if (busy) return;
    opened = { year: selection.year, revision: yearPlan(selection.year).revision, entryId: entry.id, action };
    operation = undefined;
    get("dialog-title").textContent = actions[action];
    get("dialog-term").textContent = equipmentText(deviceFor(entry)) + " · " + kindFor(entry) + " · " + monthText(selection.year, entry.month);
    get("date").max = calendarDate();
    get("date").value = entry.doneDate ?? calendarDate();
    get("notes").value = entry.doneNotes ?? "";
    get("date-field").hidden = get("notes-field").hidden = get("date").disabled = get("notes").disabled = action === "undo";
    get("undo-text").hidden = action !== "undo";
    get("error").textContent = "";
    get("save").textContent = actions[action];
    dialog.showModal();
  }

  get("year").onchange = () => setPeriod(Number(get("year").value), selection.month);
  get("month").onchange = () => setPeriod(selection.year, Number(get("month").value));
  get("today").onclick = () => setPeriod(current.year, current.month, true);
  get("query").oninput = get("filter").onchange = renderRows;
  history.ontoggle = () => {
    if (history.open && !source) historyKey = undefined;
    if (history.open) refreshHistory();
  };
  get("history-device").onchange = refreshHistory;
  get("cancel").onclick = () => { if (!busy) dialog.close(); };
  dialog.oncancel = event => { if (busy) event.preventDefault(); };

  get("form").onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    const { year, revision, entryId, action } = opened;
    const command = action === "undo" ? { action, entryId } : { action, entryId, doneDate: get("date").value, doneNotes: get("notes").value };
    const signature = JSON.stringify(command);
    if (operation?.signature !== signature) operation = { signature, id: crypto.randomUUID() };
    busy = true;
    requestEpoch++;
    get("save").disabled = get("cancel").disabled = true;
    try {
      const next = await savePlan(year, revision, command, operation.id);
      plans = plans.map(plan => plan.year === year ? { year, revision: next.revision, entries: next.state.approved.entries } : plan);
      dialog.close();
      report(actionNames[action] + ".");
      render();
    } catch (error) {
      get("error").textContent = error.status === 409
        ? "Plan zmienił się w innym oknie. Wpisane dane zachowano. Zamknij formularz i sprawdź aktualny termin przed ponownym zapisem."
        : error.message;
    } finally {
      get("save").disabled = get("cancel").disabled = false;
      busy = false;
      refresh();
    }
  };

  return {
    show(registry) {
      equipment = registry.equipment;
      assignments = registry.mapping.assignments;
      renderHistoryOptions();
      render();
    },
    refresh,
    showHistory(deviceId) {
      renderHistoryOptions(deviceId);
      history.open = true;
      refreshHistory();
      history.scrollIntoView({ block: "start" });
    },
  };
}
