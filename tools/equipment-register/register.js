
import {
  activityKinds, createExport, createRegister, duplicateNumbers, groupActivities, groupSources,
  moveSources, restoreDraft, reviseActivity, reviseGroup, searchText, setApproval,
} from "./model.js";
import { loadRegistry, saveRegistry } from "./api.js";

const byId = id => document.getElementById(id);
const message = byId("message");
const monthNames = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec",
  "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
const nameSort = (a, b) => a.localeCompare(b, "pl", { numeric: true });
const dateLabel = date => date?.split("-").reverse().join(".") || "brak daty wykonania";

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function field(label, control) {
  const node = element("label", label);
  node.append(control);
  return node;
}

function notify(text, tone = "") {
  message.textContent = text;
  message.dataset.tone = tone;
}

async function start() {
  const result = await fetch("/source.json");
  if (!result.ok) throw new Error("Nie udało się odczytać kopii harmonogramu.");
  const dataset = await result.json();
  const sources = [...dataset.sources].sort((a, b) => nameSort(a.name, b.name) || a.month.localeCompare(b.month));
  const { proposals } = createRegister(sources);
  const key = "e-lab-equipment-draft-v1:" + dataset.fingerprint;
  let current = await loadRegistry();
  let draft = restoreDraft(current.state.mapping, sources);
  let dirty = false;
  let busy = false;
  let operation;
  let previousDraft;
  try {
    const localDraft = localStorage.getItem(key);
    if (localDraft) previousDraft = restoreDraft(JSON.parse(localDraft), sources);
  } catch {
    notify("Nie udało się odczytać wcześniejszego szkicu.", "error");
  }

  const completeCount = sources.filter(source => source.doneDate).length;
  const order = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });
  byId("source-info").textContent = sources.length + " pozycji z kopii · " + order.format(new Date(dataset.readTime));
  byId("completed-count").textContent = completeCount;

  const picker = byId("target-group");
  const nameField = byId("device-name");
  const numberField = byId("device-number");
  const approval = byId("approve-group");
  const pending = byId("pending-only");
  const search = byId("search");
  const selection = new Set();
  let active;
  let currentView = "assignments";
  let grouped;
  let duplicates;
  let visibleGroups;

  function positionText(source) {
    return [monthNames[Number(source.month) - 1], source.type ?? "brak typu w bazie · v37: Wzorcowanie",
      source.doneDate ? "Wykonano " + dateLabel(source.doneDate) : "Brak daty wykonania"].join(" · ");
  }

  function groupStatus(group) {
    if (duplicates.has(group.id)) return ["Powtórzony numer", "manual"];
    if (group.approved) return ["Zatwierdzona", "approved"];
    if (grouped.get(group.id).some(source => proposals[source.id].notes.length)) return ["Wymaga weryfikacji", "manual"];
    return ["Zgodny numer", ""];
  }

  function summary() {
    grouped = groupSources(draft, sources);
    duplicates = duplicateNumbers(draft);
    const verified = draft.groups.reduce((count, group) =>
      count + (group.approved && !duplicates.has(group.id) ? grouped.get(group.id).length : 0), 0);
    byId("approved-count").textContent = verified + " z " + sources.length;
    byId("groups-count").textContent = draft.groups.length;
    byId("pending-count").textContent = (sources.length - verified) + " pozycji do zatwierdzenia";
    byId("approval-progress").max = sources.length;
    byId("approval-progress").value = verified;
    byId("save-draft").disabled = !dirty || busy;
    byId("reload-register").disabled = busy;
    byId("legacy-draft").hidden = !previousDraft || current.revision !== 0;
    byId("legacy-draft").disabled = busy;
    byId("export-register").disabled = false;
    const query = searchText(search.value.trim()).split(/\s+/u).filter(Boolean);
    visibleGroups = draft.groups.filter(group => {
      if (pending.checked && group.approved && !duplicates.has(group.id)) return false;
      const rows = grouped.get(group.id);
      const contents = [group.name, group.number, ...rows.flatMap(source => [
        source.name, source.id, source.type ?? "", draft.assignments[source.id].kind, draft.assignments[source.id].label,
      ])].join(" ");
      return query.every(word => searchText(contents).includes(word));
    }).sort((a, b) => nameSort(a.name, b.name) || nameSort(a.number, b.number) || nameSort(a.id, b.id));
  }

  function groupTitle(group) {
    return group.name || "Urządzenie bez nazwy";
  }

  function groupOption(group) {
    const entries = grouped.get(group.id);
    const rest = group.number || [...new Set(entries.map(row => monthNames[Number(row.month) - 1]))].join(", ");
    return groupTitle(group) + " · " + rest + " · " + entries.length + " poz.";
  }

  function renderGroups() {
    const container = byId("group-list");
    container.replaceChildren();
    byId("visible-groups").textContent = "(" + visibleGroups.length + ")";
    if (!visibleGroups.length) container.append(element("p", "Brak grup dla wybranych filtrów.", "empty"));
    for (const group of visibleGroups) {
      const button = element("button", undefined, "group-button");
      button.type = "button";
      button.dataset.group = group.id;
      button.setAttribute("aria-pressed", String(group.id === active));
      const [label, style] = groupStatus(group);
      button.append(element("strong", groupTitle(group)),
        element("small", (group.number || [...new Set(grouped.get(group.id).map(source => monthNames[Number(source.month) - 1]))].join(", ")) + " · " + grouped.get(group.id).length + " poz."),
        element("small", label, "pill " + style));
      button.addEventListener("click", () => selectGroup(group.id, true));
      container.append(button);
    }
  }

  function updateButtons(group) {
    const rows = grouped.get(group.id);
    byId("active-name").textContent = groupTitle(group);
    byId("active-description").textContent = rows.length + " poz. · " + groupStatus(group)[0];
    byId("duplicate-note").hidden = !duplicates.has(group.id);
    approval.textContent = group.approved ? "Cofnij zatwierdzenie" : "Zatwierdź grupę";
    approval.classList.toggle("primary", !group.approved);
    approval.disabled = !group.approved && (!group.name.trim() || duplicates.has(group.id));
    byId("selection-info").textContent = "Zaznaczono " + selection.size + " z " + rows.length + " pozycji";
    byId("merge-group").disabled = !picker.value;
    byId("move-selected").disabled = !picker.value || selection.size === 0;
    byId("split-selected").disabled = selection.size === 0 || selection.size === rows.length;
  }

  function sourceCard(source, editingGroup) {
    const article = element("article", undefined, "entry");
    article.dataset.position = source.id;
    const heading = element("div", undefined, "entry-heading");
    if (editingGroup) {
      const check = element("input");
      check.type = "checkbox";
      check.checked = selection.has(source.id);
      check.setAttribute("aria-label", "Zaznacz do przeniesienia: " + source.name + ", " + monthNames[Number(source.month) - 1]);
      check.onchange = () => {
        if (check.checked) selection.add(source.id);
        else selection.delete(source.id);
        updateButtons(editingGroup);
      };
      const label = element("label", undefined, "check");
      label.append(check);
      heading.append(label);
    }
    const original = element("div");
    original.append(element("h3", source.name), element("p", positionText(source), "source-meta"),
      element("p", "ID " + source.id, "source-id"));
    const notes = proposals[source.id].notes;
    if (notes.length) original.append(element("p", notes.join(" "), "notes"));
    heading.append(original);
    article.append(heading);
    const assignment = draft.assignments[source.id];
    if (!editingGroup) {
      article.append(element("p", "Grupa: " + groupTitle(draft.groups.find(group => group.id === assignment.groupId)), "source-meta"));
      return article;
    }
    const kind = element("select");
    for (const option of new Set([...activityKinds, assignment.kind])) kind.append(new Option(option, option));
    kind.value = assignment.kind;
    const detail = element("input");
    detail.type = "text";
    detail.maxLength = 150;
    detail.value = assignment.label;
    detail.placeholder = "Np. tor pH";
    const revise = () => {
      if (!reviseActivity(draft, source.id, kind.value, detail.value)) return;
      dirty = true;
      summary();
      renderGroups();
      updateButtons(editingGroup);
    };
    kind.onchange = revise;
    detail.oninput = revise;
    const fields = element("div", undefined, "fields");
    fields.append(field("Rodzaj w rejestrze", kind), field("Szczegóły czynności (opcjonalnie)", detail));
    article.append(fields);
    return article;
  }

  function showEditor() {
    const group = draft.groups.find(item => item.id === active);
    byId("empty-editor").hidden = Boolean(group);
    byId("group-editor").hidden = !group;
    if (!group) return;
    nameField.value = group.name;
    numberField.value = group.number;
    const previousTarget = picker.value;
    picker.replaceChildren(new Option("Wybierz grupę docelową", ""));
    const targets = draft.groups.filter(item => item.id !== group.id).sort((a, b) => nameSort(a.name, b.name));
    for (const target of targets) picker.append(new Option(groupOption(target), target.id));
    if (targets.some(target => target.id === previousTarget)) picker.value = previousTarget;
    byId("source-cards").replaceChildren(...grouped.get(group.id).map(source => sourceCard(source, group)));
    updateButtons(group);
  }

  function renderPreview() {
    byId("preview-summary").textContent = draft.groups.length + " grup · " + sources.length + " przypisanych pozycji";
    const cards = visibleGroups.map(group => {
      const [label, tone] = groupStatus(group);
      const rows = grouped.get(group.id);
      const card = element("article", undefined, "card panel");
      const list = element("ul");
      for (const activity of groupActivities(draft, rows)) {
        list.append(element("li", activity.kind + (activity.label ? " · " + activity.label : "") + " · " + activity.sourceIds.length + " poz."));
      }
      card.append(element("h3", groupTitle(group)), element("p", group.number || "Brak numeru ewidencyjnego", "muted"),
        element("span", label, "pill " + tone), list);
      return card;
    });
    byId("device-preview").replaceChildren(...(cards.length ? cards : [element("p", "Brak urządzeń dla wybranych filtrów.", "empty")]));
  }

  function render() {
    summary();
    if (currentView === "assignments") {
      if (!visibleGroups.some(group => group.id === active)) {
        active = visibleGroups[0]?.id;
        selection.clear();
        byId("group-operations").open = false;
      }
      renderGroups();
      showEditor();
    } else if (currentView === "sources") {
      const visible = new Set(visibleGroups.map(group => group.id));
      const cards = sources.filter(source => visible.has(draft.assignments[source.id].groupId)).map(source => sourceCard(source));
      byId("source-list").replaceChildren(...(cards.length ? cards : [element("p", "Brak pozycji dla wybranych filtrów.", "empty")]));
    } else {
      renderPreview();
    }
  }

  function selectGroup(id, focus) {
    if (id !== active) {
      active = id;
      selection.clear();
      picker.value = "";
      byId("group-operations").open = false;
    }
    render();
    if (focus) byId("active-name").focus({ preventScroll: false });
  }

  function run(action) {
    try {
      action();
    } catch (error) {
      notify(error.message, "error");
    }
  }

  function relocate(whole, split) {
    run(() => {
      const ids = whole ? grouped.get(active).map(source => source.id) : [...selection];
      const target = moveSources(draft, active, ids, split ? "" : picker.value);
      dirty = true;
      selectGroup(target, true);
      notify("Przeniesiono " + ids.length + " poz. Sprawdź i zatwierdź zmienione grupy.");
    });
  }

  const reviseDevice = () => {
    if (!reviseGroup(draft, active, { name: nameField.value, number: numberField.value })) return;
    dirty = true;
    summary();
    renderGroups();
    updateButtons(draft.groups.find(group => group.id === active));
  };
  nameField.oninput = reviseDevice;
  numberField.oninput = reviseDevice;
  picker.onchange = () => updateButtons(draft.groups.find(group => group.id === active));
  byId("merge-group").onclick = () => relocate(true, false);
  byId("move-selected").onclick = () => relocate(false, false);
  byId("split-selected").onclick = () => relocate(false, true);
  approval.onclick = () => run(() => {
    const group = draft.groups.find(item => item.id === active);
    setApproval(draft, active, !group.approved);
    dirty = true;
    render();
    notify(group.approved ? "Zatwierdzono grupę." : "Przywrócono grupę do weryfikacji.");
  });
  function loadShared(snapshot) {
    current = snapshot;
    draft = restoreDraft(snapshot.state.mapping, sources);
    selection.clear();
    dirty = false;
    operation = undefined;
    render();
  }
  byId("legacy-draft").onclick = () => {
    if (dirty && !confirm("Zastąpić otwarte przypisania wcześniejszym szkicem?")) return;
    draft = structuredClone(previousDraft);
    selection.clear();
    dirty = true;
    render();
    notify("Wczytano lokalny szkic. Zapisz przypisania, aby zastosować go w rejestrze.");
  };
  byId("reload-register").onclick = async () => {
    if (dirty && !confirm("Wczytać aktualny rejestr i pominąć niezapisane zmiany przypisań?")) return;
    try {
      loadShared(await loadRegistry());
      notify("Wczytano bieżące przypisania.");
    } catch (error) {
      notify(error.message, "error");
    }
  };
  byId("save-draft").onclick = async () => {
    if (busy) return;
    busy = true;
    summary();
    const mapping = structuredClone(draft);
    const signature = JSON.stringify(mapping);
    if (operation?.signature !== signature) operation = { signature, id: crypto.randomUUID() };
    try {
      const saved = await saveRegistry(current.revision, { action: "grouping", mapping }, operation.id);
      if (JSON.stringify(draft) === signature) {
        loadShared(saved);
        notify("Zapisano przypisania w lokalnym rejestrze.");
      } else {
        current = saved;
        notify("Zapisano poprzednią wersję przypisań. Najnowsze poprawki pozostają otwarte.");
      }
    } catch (error) {
      notify(error.message, "error");
    } finally {
      busy = false;
      summary();
    }
  };
  byId("export-register").onclick = () => run(() => {
    const data = createExport(draft, dataset);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
    const link = element("a");
    link.href = url;
    link.download = "przypisanie-sprzetu.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Wyeksportowano przypisania wraz ze statusem weryfikacji.");
  });
  for (const control of document.querySelectorAll("[data-view]")) {
    control.onclick = () => {
      currentView = control.dataset.view;
      for (const node of document.querySelectorAll("[data-view]")) {
        node.setAttribute("aria-pressed", String(node.dataset.view === currentView));
        byId(node.dataset.view + "-view").hidden = node.dataset.view !== currentView;
      }
      render();
    };
  }
  search.oninput = render;
  pending.onchange = render;
  window.addEventListener("beforeunload", event => {
    if (dirty) event.preventDefault();
  });
  byId("workspace").hidden = false;
  render();
}

start().catch(error => notify(error.message, "error"));
