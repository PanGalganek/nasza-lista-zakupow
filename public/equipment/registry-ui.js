import { searchText } from "./model.js?v=38";
import { editDevice, needsDetails } from "./registry-model.js?v=38";

const get = id => document.getElementById(id);
const sort = new Intl.Collator("pl", { numeric: true });
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function btn(text, action) {
  const control = el("button", text, "lab-button");
  control.type = "button";
  control.onclick = action;
  return control;
}
function field(label, input) {
  const control = el("label", label);
  control.append(input);
  return control;
}

export function registryPanel(api, openHistory, canWrite) {
  let state = { equipment: {}, mapping: { assignments: {} } };
  let opened, pending = false;
  const dialog = get("device-dialog");
  const message = get("eq-message");

  function report(text, error = false) {
    message.textContent = text;
    message.dataset.tone = error ? "error" : "";
  }

  function sorted() {
    return Object.values(state.equipment).sort((a, b) => sort.compare(a.name, b.name) || sort.compare(a.number, b.number));
  }

  function render() {
    const query = searchText(get("query").value);
    const filter = get("filter").value;
    const all = sorted();
    const rows = all.filter(d => searchText(d.name + " " + d.number).includes(query)
      && (filter === "all" || (filter === "needs" ? needsDetails(d) : d.status === filter)));
    get("shown-count").textContent = rows.length + " z " + Object.keys(state.equipment).length;
    get("devices").replaceChildren(...rows.map(device => {
      const article = el("article", "", "card panel device-card");
      article.dataset.deviceId = device.id;
      const info = el("div", "", "lab-stack");
      const header = el("div", "", "lab-actions");
      header.append(el("h3", device.name), el("span", device.status === "active" ? "Aktywny" : "Wycofany", "lab-chip"));
      if (needsDetails(device)) header.append(el("span", "Do uzupełnienia", "lab-chip"));
      info.append(header, el("p", device.number || "Brak numeru ewidencyjnego", "muted"));
      if (device.notes) info.append(el("p", device.notes, "registry-notes"));
      if (device.mergedInto && state.equipment[device.mergedInto]) info.append(el("p", "Połączono z: " + state.equipment[device.mergedInto].name, "muted"));
      const activities = el("ul", "", "activity-list");
      for (const row of device.activities) activities.append(el("li", row.kind + (row.label ? " · " + row.label : "") + (row.active ? "" : " · Nieaktywna")));
      info.append(activities);
      const actions = el("div", "", "lab-actions");
      actions.append(btn("Historia", () => openHistory(device.id)));
      if (canWrite()) {
        actions.append(btn("Edytuj", () => edit(device)),
          btn(device.status === "active" ? "Wycofaj" : "Przywróć", () => changeStatus(device)));
        if (device.status === "active" && all.some(row => row.id !== device.id && row.status === "active")) {
          actions.append(btn("Połącz", () => merge(device)));
        }
      }
      article.append(info, actions);
      return article;
    }));
    if (!rows.length) get("devices").append(el("p", "Brak urządzeń dla wybranych filtrów.", "lab-empty"));
  }

  async function changeStatus(device) {
    if (pending || (device.status === "active" && !confirm("Wycofać urządzenie „" + device.name + "”?"))) return;
    pending = true;
    try {
      const status = device.status === "active" ? "withdrawn" : "active";
      await api.saveDevice({ ...device, status, mergedInto: status === "active" ? "" : device.mergedInto }, device);
      report(status === "withdrawn" ? "Wycofano urządzenie." : "Przywrócono urządzenie.");
    } catch (error) { report(error.message, true); }
    finally { pending = false; }
  }

  function append(row) {
    const item = el("div", "", "entry activity-row");
    item.dataset.activityId = row?.id ?? "";
    const inputs = el("div", "", "fields");
    const kind = el("input");
    kind.setAttribute("list", "activity-kinds");
    kind.value = row?.kind ?? "";
    kind.required = true;
    kind.maxLength = 80;
    const label = el("input");
    label.type = "text";
    label.value = row?.label ?? "";
    label.maxLength = 150;
    inputs.append(field("Rodzaj czynności", kind), field("Opis (opcjonalnie)", label));
    item.append(inputs);
    const active = el("input");
    active.type = "checkbox";
    active.checked = row?.active ?? true;
    const check = field("Aktywna", active);
    check.className = "check";
    item.append(check);
    if (!row) item.append(btn("Usuń wiersz", () => item.remove()));
    get("activity-rows").append(item);
  }

  function edit(device) {
    if (!canWrite()) return;
    opened = device;
    get("dialog-title").textContent = device ? "Edytuj sprzęt" : "Dodaj sprzęt";
    get("device-id").textContent = "";
    for (const key of ["name", "number", "notes"]) get("device-" + key).value = device?.[key] ?? "";
    get("activity-rows").replaceChildren();
    for (const row of device?.activities ?? []) append(row);
    get("form-error").textContent = "";
    dialog.showModal();
  }

  get("add-activity").onclick = () => append();
  get("cancel-device").onclick = get("close-dialog").onclick = () => { if (!pending) dialog.close(); };
  get("query").oninput = get("filter").onchange = render;
  dialog.oncancel = event => { if (pending) event.preventDefault(); };
  get("device-form").onsubmit = async event => {
    event.preventDefault();
    if (pending) return;
    pending = get("save-device").disabled = true;
    const input = { action: "upsert", deviceId: opened?.id ?? null };
    for (const key of ["name","number","notes"]) input[key] = get("device-" + key).value;
    input.activities = [...get("activity-rows").children].map(row => {
      const [kind, label, active] = row.querySelectorAll("input");
      return { id: row.dataset.activityId || null, kind: kind.value, label: label.value, active: active.checked };
    });
    try {
      await api.saveDevice(editDevice(opened, input, crypto.randomUUID()), opened);
      dialog.close();
      report("Zapisano sprzęt.");
    } catch (error) { get("form-error").textContent = error.message; }
    finally { pending = get("save-device").disabled = false; }
  };

  function selectOptions(select, items, previous) {
    select.replaceChildren(...items.map(([value, label]) => new Option(label, value)));
    if (items.some(([key]) => key === previous)) select.value = previous;
  }

  function picker(title, build) {
    const prompt = el("dialog", "", "lab-dialog");
    const content = el("div", "", "lab-stack panel");
    const error = el("p", "", "form-error");
    content.append(el("h2", title));
    const footer = el("div", "", "lab-actions");
    let writing = false;
    const run = async action => {
      if (writing) return;
      writing = true;
      const controls = [...prompt.querySelectorAll("button,select")];
      controls.forEach(control => control.disabled = true);
      try { await action(); prompt.close(); }
      catch (e) { error.textContent = e.message; }
      finally { writing = false; controls.forEach(control => control.disabled = false); }
    };
    build(content, footer, run, error);
    footer.append(btn("Anuluj", () => { if (!writing) prompt.close(); }));
    content.append(error, footer);
    prompt.append(content);
    get("equipmentV38").append(prompt);
    prompt.oncancel = event => { if (writing) event.preventDefault(); };
    prompt.onclose = () => prompt.remove();
    prompt.showModal();
  }

  function merge(source) {
    picker("Połącz karty sprzętu", (content, footer, run) => {
      const target = el("select");
      selectOptions(target, sorted().filter(row => row.id !== source.id && row.status === "active")
        .map(row => [row.id, row.name + (row.number ? " · " + row.number : "")]));
      content.append(el("p", "Karta „" + source.name + "” trafi do archiwum. Jej dotychczasowe terminy i wykonania zachowają powiązania."), field("Karta docelowa", target));
      footer.append(btn("Połącz", () => run(() => api.mergeDevices(source, state.equipment[target.value]))));
    });
  }

  get("equipmentLinksButton").onclick = async () => {
    try {
      const { sources } = await api.loadSource();
      if (!sources.length) { report("Brak pozycji źródłowych."); return; }
      picker("Przypisania pozycji źródłowych", (content, footer, run) => {
        const source = el("select");
        const device = el("select");
        const activity = el("select");
        const original = el("p", "", "lab-muted");
        const rows = [...sources].sort((a, b) => sort.compare(a.name, b.name));
        const reference = () => state.mapping.assignments[source.value];
        selectOptions(source, rows.map(row => [row.id, row.name + " · " + row.month]));
        function listActivities() {
          const target = state.equipment[device.value];
          selectOptions(activity, target?.activities.map(row => [row.id, row.kind + (row.label ? " · " + row.label : "")]) ?? [], reference()?.activityId);
        }
        function selectedSource() {
          const row = rows.find(row => row.id === source.value);
          original.textContent = "Miesiąc planowany: " + row.month + " · wykonanie: " + (row.doneDate || "brak daty");
          selectOptions(device, sorted().filter(row => row.status === "active" || row.id === reference()?.groupId)
            .map(row => [row.id, row.name + (row.number ? " · " + row.number : "")]), reference()?.groupId);
          listActivities();
        }
        source.onchange = selectedSource;
        device.onchange = listActivities;
        selectedSource();
        content.append(field("Pozycja źródłowa", source), original, field("Urządzenie", device), field("Czynność", activity));
        if (canWrite()) footer.append(
          btn("Zapisz przypisanie", () => run(() => {
            if (!device.value || !activity.value) throw new Error("Wybierz urządzenie i czynność.");
            return api.linkSource(source.value, device.value, activity.value, reference()?.revision ?? 0);
          })),
          btn("Rozdziel do nowej karty", () => run(() => api.splitSource(rows.find(row => row.id === source.value), reference()?.revision ?? 0))),
        );
      });
    } catch (error) { report(error.message, true); }
  };

  return { show(value) { state = value; render(); }, edit, reset() { state = { equipment: {}, mapping: { assignments: {} } }; if (dialog.open) dialog.close(); } };
}
