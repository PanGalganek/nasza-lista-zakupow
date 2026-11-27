import { loadPlan, savePlan } from "./api.js";
import { searchText } from "./model.js";
import { copyDialog } from "./plan-copy.js";
import { calendarDate, initialYear, monthlyNames, planCounts, planRows, rowKey, validYear } from "./plan-model.js";

const get = id => document.getElementById("plan-" + id);
const collator = new Intl.Collator("pl", { numeric: true });
const short = ["Sty", "Lut", "Mar", "Kwi", "Maj", "Cze", "Lip", "Sie", "Wrz", "Paź", "Lis", "Gru"];
const dateLabel = value => value.split("-").reverse().join(".");
const kindLabel = activity => activity.kind + (activity.label ? " · " + activity.label : "");
const equipmentLabel = device => device.name + (device.number ? " · " + device.number : "");

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text, action, title) {
  const element = node("button", text);
  element.type = "button";
  if (title) element.setAttribute("aria-label", title);
  element.onclick = action;
  return element;
}

function options(select, items, defaultValue = select.value) {
  select.replaceChildren(...items.map(([value, label]) => new Option(label, value)));
  if (items.some(([value]) => String(value) === String(defaultValue))) select.value = defaultValue;
}

export function annualPlanner() {
  let year = initialYear();
  let equipment = {};
  let snapshot, entries, operation, dialogState;
  let dirty = false;
  let busy = false;
  let conflict = false;
  let refreshFailed = false;
  let sourceLoaded = false;
  const dialog = get("dialog");
  const copy = copyDialog((target, saved) => {
    year = target;
    get("year").value = target;
    snapshot = saved;
    entries = saved.state.draft?.entries;
    dirty = conflict = refreshFailed = false;
    get("query").value = get("kind").value = "";
    message("Skopiowano harmonogram na " + target + ". Szkic jest gotowy do edycji.");
    render();
    get("query").focus({ preventScroll: true });
  });
  get("year").value = year;

  function message(text, error = false) {
    get("feedback").textContent = text;
    get("feedback").dataset.tone = error ? "error" : "";
  }

  function visibleEntries() {
    return entries ?? snapshot?.state.approved?.entries ?? snapshot?.state.draft?.entries ?? [];
  }

  function renderButtons() {
    const { approved, draft } = snapshot?.state ?? {};
    const editing = Boolean(entries);
    get("status").textContent = !snapshot ? "Wczytywanie planu na " + year + "…"
      : (approved ? "Plan zatwierdzony" : draft ? "Szkic harmonogramu" : "Brak planu") + " · " + year
      + (approved && draft ? " · Są zapisane zmiany w szkicu" : "") + (dirty ? " · Niezapisane zmiany" : "");
    get("start").hidden = !snapshot || editing || Boolean(approved || draft);
    get("edit").hidden = !snapshot || editing || !(approved || draft);
    get("copy").hidden = !snapshot;
    get("copy").disabled = busy || editing;
    get("copy").title = editing ? "Zakończ edycję, aby skopiować harmonogram" : "";
    get("save").hidden = get("approve").hidden = get("close").hidden = !editing;
    get("reload").hidden = !conflict && !refreshFailed;
    for (const id of ["start", "edit", "save", "approve", "close", "reload"]) get(id).disabled = busy;
    get("save").disabled ||= conflict;
    get("approve").disabled ||= conflict;
    get("year").disabled = busy;
    get("year-form").querySelector("button").disabled = busy;
  }

  function render() {
    renderButtons();
    get("content").hidden = !snapshot || (!entries && !snapshot.state.approved && !snapshot.state.draft);
    if (get("content").hidden) return;
    const current = visibleEntries();
    const counts = planCounts(current);
    get("total").textContent = "Rok " + year + " · " + counts.total + " zaplanowanych · " + counts.completed + " wykonanych";
    get("months").replaceChildren(...counts.months.map((count, month) => {
      const item = node("li");
      item.title = monthlyNames[month];
      item.append(node("span", short[month]), node("strong", count));
      return item;
    }));
    const rows = planRows(equipment, current, Boolean(entries))
      .sort((a, b) => collator.compare(equipmentLabel(a.device), equipmentLabel(b.device))
        || collator.compare(kindLabel(a.activity), kindLabel(b.activity)) || collator.compare(a.key, b.key));
    options(get("kind"), [["", "Wszystkie czynności"], ...[...new Set(rows.map(row => row.activity.kind))]
      .sort(collator.compare).map(kind => [kind, kind])]);
    const query = searchText(get("query").value).trim().split(/\s+/).filter(Boolean);
    const matches = rows.filter(row => (!get("kind").value || get("kind").value === row.activity.kind)
      && query.every(word => searchText(equipmentLabel(row.device)).includes(word)));
    const terms = new Map();
    for (const entry of current) {
      const key = rowKey(entry.deviceId, entry.activityId);
      if (!terms.has(key)) terms.set(key, new Map());
      terms.get(key).set(entry.month, entry);
    }
    renderTable(matches, terms, counts.months);
    const devices = new Map(matches.map(row => [row.device.id, equipmentLabel(row.device)]));
    options(get("device"), [...devices]);
    const selected = matches.filter(row => row.device.id === get("device").value);
    get("mobile-rows").replaceChildren(...(selected.length ? selected.map(row => mobileRow(row, terms.get(row.key) ?? new Map()))
      : [node("p", "Brak pozycji dla wybranych filtrów.", "card panel muted")]));
  }

  function change(changeEntries, focus) {
    if (!entries || busy) return;
    const next = changeEntries(entries);
    if (next === entries) return;
    entries = next;
    dirty = true;
    render();
    if (focus) {
      const table = focus.closest("#plan-desktop") ? get("desktop") : get("mobile");
      [...table.querySelectorAll("[data-focus]")].find(control => control.dataset.focus === focus.dataset.focus)?.focus();
    }
  }

  function newTerm(row, month) {
    return { id: crypto.randomUUID(), deviceId: row.device.id, activityId: row.activity.id, month, doneDate: null };
  }

  function monthControl(row, month, term, mobile) {
    const title = monthlyNames[month - 1];
    const cell = node(entries ? "label" : "span", undefined, "plan-month");
    if (mobile) cell.append(node("span", short[month - 1]));
    const description = term?.doneDate ? "Wykonano " + dateLabel(term.doneDate) : term ? "Zaplanowano" : "Brak terminu";
    cell.title = title + " · " + description;
    if (entries) {
      const input = node("input");
      input.type = "checkbox";
      input.checked = Boolean(term);
      input.disabled = busy || Boolean(term?.doneDate) || (!row.available && !term);
      input.dataset.focus = row.key + ":" + month;
      input.setAttribute("aria-label", equipmentLabel(row.device) + " · " + kindLabel(row.activity) + " · " + title
        + (term?.doneDate ? " · " + description : ""));
      input.onchange = () => change(list => input.checked ? [...list, newTerm(row, month)]
        : list.filter(item => item.id !== term.id), input);
      cell.append(input);
      if (term?.doneDate) cell.append(node("small", dateLabel(term.doneDate), "plan-done-date"));
    } else if (term) {
      cell.append(node("strong", term.doneDate ? "✓" : "●", term.doneDate ? "plan-done" : "plan-mark"));
      if (term.doneDate) cell.append(node("small", dateLabel(term.doneDate), "plan-done-date"));
    } else cell.append(node("span", "–", "muted"));
    return cell;
  }

  function rowActions(row, terms) {
    const actions = node("div", undefined, "plan-row-actions");
    const pending = [...terms.values()].filter(term => !term.doneDate);
    if (entries) {
      if (row.available && terms.size < 12) {
        const all = button("12 mies.", () => change(list => [...list,
          ...monthlyNames.flatMap((_, index) => terms.has(index + 1) ? [] : [newTerm(row, index + 1)])]), "Zaznacz wszystkie 12 miesięcy");
        all.disabled = busy;
        actions.append(all);
      }
      if (pending.length) {
        const ids = new Set(pending.map(term => term.id));
        const clear = button("Wyczyść", () => change(list => list.filter(term => !ids.has(term.id))), "Wyczyść niewykonane terminy wiersza");
        clear.disabled = busy;
        actions.append(clear);
        if (terms.size < 12) actions.append(button("Przesuń", () => openDialog(row, pending, true)));
      }
    } else if (snapshot.state.approved && pending.length) {
      actions.append(button("Wpisz wykonanie", () => openDialog(row, pending, false)));
    }
    return actions;
  }

  function deviceHeading(row) {
    const fragment = document.createDocumentFragment();
    fragment.append(node("strong", row.device.name));
    if (row.device.number) fragment.append(node("small", row.device.number));
    if (!row.available) fragment.append(node("small", row.device.status === "withdrawn" ? "Sprzęt wycofany" : "Czynność nieaktywna"));
    return fragment;
  }

  function renderTable(rows, terms, counts) {
    const desktop = get("desktop");
    if (!rows.length) {
      desktop.replaceChildren(node("p", "Brak pozycji dla wybranych filtrów.", "panel muted"));
      return;
    }
    const table = node("table", undefined, "plan-table");
    table.setAttribute("aria-label", "Miesięczny plan sprzętu na " + year);
    const headings = table.createTHead().insertRow();
    for (const title of ["Urządzenie", "Czynność", ...short, "Operacje"]) {
      const th = node("th", title);
      th.scope = "col";
      headings.append(th);
    }
    for (let i = 0; i < 12; i++) {
      headings.cells[i + 2].title = monthlyNames[i];
      headings.cells[i + 2].append(node("small", counts[i]));
    }
    const body = table.createTBody();
    for (const row of rows) {
      const cells = body.insertRow();
      cells.dataset.planRow = row.key;
      const source = terms.get(row.key) ?? new Map();
      const deviceCell = node("th");
      deviceCell.scope = "row";
      deviceCell.append(deviceHeading(row));
      cells.append(deviceCell);
      cells.insertCell().textContent = kindLabel(row.activity);
      for (let month = 1; month <= 12; month++) cells.insertCell().append(monthControl(row, month, source.get(month), false));
      cells.insertCell().append(rowActions(row, source));
    }
    const scroll = desktop.scrollTop;
    desktop.replaceChildren(table);
    desktop.scrollTop = scroll;
  }

  function mobileRow(row, terms) {
    const card = node("article", undefined, "card panel stack");
    card.append(node("h3", kindLabel(row.activity)));
    if (!row.available) card.append(node("p", "Pozycja nieaktywna w rejestrze", "muted"));
    const months = node("div", undefined, "plan-grid");
    for (let month = 1; month <= 12; month++) months.append(monthControl(row, month, terms.get(month), true));
    card.append(months, rowActions(row, terms));
    return card;
  }

  function openDialog(row, candidates, move) {
    if (busy || conflict) return;
    dialogState = { move };
    get("dialog-title").textContent = move ? "Przesuń termin" : "Wpisz wykonanie";
    get("dialog-item").textContent = equipmentLabel(row.device) + " · " + kindLabel(row.activity);
    const used = new Set(visibleEntries().filter(item => row.key === rowKey(item.deviceId, item.activityId)).map(item => item.month));
    options(get("dialog-from"), [...candidates].sort((a, b) => a.month - b.month).map(item => [item.id, monthlyNames[item.month - 1]]), "");
    options(get("dialog-to"), monthlyNames.flatMap((name, i) => used.has(i + 1) ? [] : [[i + 1, name]]), "");
    get("dialog-target").hidden = !move;
    get("dialog-to").disabled = !move;
    get("dialog-date-field").hidden = move;
    get("dialog-date").disabled = move;
    get("dialog-date").value = calendarDate();
    get("dialog-date").max = calendarDate();
    get("dialog-error").textContent = "";
    get("dialog-save").textContent = move ? "Przesuń" : "Zapisz wykonanie";
    dialog.showModal();
  }

  async function refresh({ reset = false } = {}) {
    if (busy) return;
    const loadingYear = year;
    try {
      const latest = await loadPlan(loadingYear);
      if (year !== loadingYear || busy || (snapshot && latest.revision < snapshot.revision)) return;
      refreshFailed = false;
      if (reset || !snapshot || latest.revision > snapshot.revision) {
        if (!reset && entries) {
          if (!conflict) {
            conflict = true;
            message("Plan zmienił się w innym oknie. Zachowano wpisane zmiany. Możesz otworzyć aktualną wersję, aby porównać terminy.", true);
          }
          renderButtons();
          return;
        } else {
          snapshot = latest;
          conflict = false;
          if (reset) message("");
        }
        render();
      } else renderButtons();
    } catch (error) {
      if (year !== loadingYear) return;
      refreshFailed = true;
      message(error.message, true);
      renderButtons();
    }
  }

  async function persist(command) {
    if (busy || conflict) return false;
    const signature = JSON.stringify([year, snapshot.revision, command]);
    if (operation?.signature !== signature) operation = { signature, id: crypto.randomUUID() };
    busy = true;
    render();
    get("dialog-save").disabled = true;
    get("dialog-cancel").disabled = true;
    try {
      snapshot = await savePlan(year, snapshot.revision, command, operation.id);
      if (command.action === "draft") entries = snapshot.state.draft?.entries ?? snapshot.state.approved?.entries ?? [];
      else entries = undefined;
      dirty = false;
      refreshFailed = false;
      message({ draft: "Zapisano szkic.", approve: "Zatwierdzono harmonogram.", complete: "Zapisano datę wykonania." }[command.action]);
      return true;
    } catch (error) {
      conflict = error.status === 409;
      message(error.message, true);
      if (dialog.open) get("dialog-error").textContent = error.message;
      return false;
    } finally {
      busy = false;
      get("dialog-save").disabled = false;
      get("dialog-cancel").disabled = false;
      render();
    }
  }

  function edit() {
    entries = snapshot.state.draft?.entries ?? snapshot.state.approved?.entries ?? [];
    dirty = false;
    render();
  }

  const discard = () => !dirty || confirm("Odrzucić niezapisane zmiany harmonogramu? Zapisany szkic pozostanie dostępny.");
  get("start").onclick = get("edit").onclick = edit;
  get("copy").onclick = () => copy.open(year);
  get("close").onclick = () => {
    if (!discard()) return;
    entries = undefined;
    dirty = false;
    if (conflict) refresh({ reset: true });
    else render();
  };
  get("reload").onclick = () => {
    if (!discard()) return;
    entries = undefined;
    dirty = false;
    refresh({ reset: true });
  };
  get("year-form").onsubmit = event => {
    event.preventDefault();
    const next = Number(get("year").value);
    if (!validYear(next) || next === year || busy || !discard()) {
      get("year").value = year;
      return;
    }
    year = next;
    snapshot = entries = undefined;
    dirty = conflict = refreshFailed = false;
    message("");
    render();
    refresh();
  };
  get("query").oninput = get("kind").onchange = get("device").onchange = render;
  get("save").onclick = () => persist({ action: "draft", entries });
  get("approve").onclick = () => persist({ action: "approve", entries });
  get("dialog-cancel").onclick = () => dialog.close();
  dialog.oncancel = event => { if (busy) event.preventDefault(); };
  get("dialog-form").onsubmit = async event => {
    event.preventDefault();
    const entryId = get("dialog-from").value;
    if (dialogState.move) {
      const month = Number(get("dialog-to").value);
      change(list => list.map(item => item.id === entryId ? { ...item, month } : item));
      dialog.close();
    } else if (await persist({ action: "complete", entryId, doneDate: get("dialog-date").value })) dialog.close();
  };
  document.querySelector(".plan-source").addEventListener("toggle", async event => {
    if (!event.target.open || sourceLoaded) return;
    try {
      const response = await fetch("/source.json");
      if (!response.ok) throw new Error("Nie można odczytać kopii źródłowej.");
      const { sources } = await response.json();
      sources.sort((a, b) => a.month.localeCompare(b.month) || collator.compare(a.name, b.name));
      get("source-title").textContent = "Harmonogram źródłowy · " + sources.length + " pozycji · " + sources.filter(row => row.doneDate).length + " wykonań";
      get("source-rows").replaceChildren(...sources.map(row => {
        const item = node("article", undefined, "entry");
        item.append(node("h3", row.name), node("p", monthlyNames[Number(row.month) - 1] + " · " + (row.type ?? "Rodzaj niepodany")
          + (row.doneDate ? " · Wykonano " + dateLabel(row.doneDate) : ""), "muted"));
        return item;
      }));
      sourceLoaded = true;
    } catch (error) {
      get("source-rows").textContent = error.message;
    }
  });
  window.addEventListener("beforeunload", event => {
    if (dirty) event.preventDefault();
  });

  return {
    show(nextEquipment) {
      equipment = nextEquipment;
      render();
    },
    refresh,
  };
}
