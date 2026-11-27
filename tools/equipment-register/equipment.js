
import { loadRegistry, saveRegistry } from "./api.js";
import { searchText } from "./model.js";
import { needsDetails } from "./registry-model.js";
import { annualPlanner } from "./planner.js";

const byId = id => document.getElementById(id);
const dialog = byId("device-dialog");
const feedback = byId("message");
const collator = new Intl.Collator("pl", { numeric: true });
let registry;
let currentPanel = "registry";
let editor;
let busy = false;
let failedRefresh = false;
let operation;
const planner = annualPlanner();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function label(text, field, className) {
  const node = element("label", text, className);
  node.append(field);
  return node;
}

function notify(text, error = false) {
  feedback.textContent = text;
  feedback.dataset.tone = error ? "error" : "";
}

function action(labelText, onClick) {
  const button = element("button", labelText);
  button.type = "button";
  button.onclick = onClick;
  return button;
}

function sorted(devices) {
  return devices.sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.number, b.number) || collator.compare(a.id, b.id));
}

function activityList(activities) {
  const list = element("ul", undefined, "activity-list");
  for (const row of activities) list.append(element("li", row.kind + (row.label ? " · " + row.label : "")));
  return activities.length ? list : element("p", "Brak aktywnych czynności.", "muted");
}

function statusChip(text, type = "") {
  return element("span", text, "pill " + type);
}

function deviceCard(device) {
  const card = element("article", undefined, "card panel device-card");
  card.dataset.deviceId = device.id;
  const title = element("div");
  const heading = element("div", undefined, "editor-heading");
  const statuses = element("div", undefined, "actions");
  statuses.append(statusChip(device.status === "active" ? "Aktywny" : "Wycofany", device.status === "active" ? "approved" : ""));
  if (needsDetails(device)) statuses.append(statusChip("Do uzupełnienia", "manual"));
  heading.append(element("h3", device.name), statuses);
  title.append(heading, element("p", device.number || "Brak numeru ewidencyjnego", "muted"));
  if (device.notes) title.append(element("p", device.notes, "registry-notes"));
  if (device.mergedInto) {
    title.append(element("p", "Powiązany po połączeniu: " + (registry.state.equipment[device.mergedInto]?.name ?? device.mergedInto), "muted"));
  }
  title.append(activityList(device.activities.filter(activity => activity.active)));
  const controls = element("div", undefined, "actions");
  controls.append(action("Edytuj", () => openEditor(device)),
    action(device.status === "active" ? "Wycofaj" : "Przywróć", () => changeStatus(device)));
  card.append(title, controls);
  return card;
}

function renderRegistry() {
  const devices = Object.values(registry.state.equipment);
  const query = searchText(byId("query").value.trim()).split(/\s+/).filter(Boolean);
  const filter = byId("filter").value;
  const matches = sorted(devices.filter(device => (filter === "all"
    || (filter === "needs" ? needsDetails(device) : device.status === filter))
    && query.every(word => searchText(device.name + " " + device.number).includes(word))));
  byId("shown-count").textContent = matches.length + " z " + devices.length;
  byId("devices").replaceChildren(...(matches.length ? matches.map(deviceCard)
    : [element("p", "Brak urządzeń dla wybranych filtrów.", "empty card panel")]));
}

function render() {
  const mapped = Object.keys(registry.state.mapping.assignments).length;
  byId("overview").textContent = "Rejestr lokalny · " + mapped + " zachowanych pozycji źródłowych";
  if (currentPanel === "registry") renderRegistry();
  else planner.show(registry.state.equipment);
}

function appendActivity(activity) {
  const card = element("div", undefined, "entry activity-row");
  card.dataset.activityId = activity?.id ?? "";
  const controls = element("div", undefined, "fields");
  const kind = element("input");
  kind.type = "text";
  kind.setAttribute("list", "activity-kinds");
  kind.maxLength = 80;
  kind.value = activity?.kind ?? "";
  kind.placeholder = "Wybierz lub wpisz własny rodzaj";
  kind.required = true;
  const detail = element("input");
  detail.type = "text";
  detail.maxLength = 150;
  detail.value = activity?.label ?? "";
  detail.placeholder = "Np. tor przewodności";
  controls.append(label("Rodzaj czynności", kind), label("Szczegóły (opcjonalnie)", detail));
  const active = element("input");
  active.type = "checkbox";
  active.checked = activity?.active ?? true;
  card.append(controls);
  if (activity?.id) {
    card.append(label("Aktywna w planowaniu", active, "check"));
  } else {
    card.append(active);
    active.hidden = true;
    card.append(action("Usuń pusty wiersz", () => card.remove()));
  }
  byId("activity-rows").append(card);
}

function openEditor(device) {
  editor = { revision: registry.revision, id: device?.id ?? null };
  operation = undefined;
  byId("dialog-title").textContent = device ? "Edytuj urządzenie" : "Dodaj sprzęt";
  byId("device-id").textContent = device ? "ID " + device.id : "";
  byId("device-name").value = device?.name ?? "";
  byId("device-number").value = device?.number ?? "";
  byId("device-notes").value = device?.notes ?? "";
  byId("form-error").textContent = "";
  byId("activity-rows").replaceChildren();
  for (const activity of device?.activities ?? []) appendActivity(activity);
  dialog.showModal();
}

function closeEditor() {
  if (!busy) dialog.close();
}

async function refresh() {
  try {
    const updated = await loadRegistry();
    if (!busy && (!registry || updated.revision > registry.revision)) {
      registry = updated;
      render();
      if (dialog.open && editor.revision !== updated.revision) {
        byId("form-error").textContent = "W rejestrze są nowsze zmiany. Wpisane pola zachowano. Przed ponownym zapisem porównaj je z aktualnymi danymi.";
      }
    }
    if (failedRefresh) notify("Przywrócono połączenie z lokalnym rejestrem.");
    failedRefresh = false;
    return true;
  } catch (error) {
    if (!failedRefresh) notify(error.message, true);
    failedRefresh = true;
    return false;
  }
}

async function changeStatus(device) {
  if (busy) return;
  const status = device.status === "active" ? "withdrawn" : "active";
  if (status === "withdrawn" && !confirm("Wycofać urządzenie „" + device.name + "”?")) return;
  busy = true;
  try {
    registry = await saveRegistry(registry.revision, { action: "status", deviceId: device.id, status });
    notify(status === "withdrawn" ? "Wycofano urządzenie do archiwum." : "Przywrócono urządzenie.");
    render();
  } catch (error) {
    notify(error.message, true);
  } finally {
    busy = false;
  }
}

byId("device-form").onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  const command = {
    action: "upsert", deviceId: editor.id,
    name: byId("device-name").value, number: byId("device-number").value, notes: byId("device-notes").value,
    activities: [...document.querySelectorAll(".activity-row")].map(row => ({
      id: row.dataset.activityId || null, kind: row.querySelector("input[list]").value,
      label: row.querySelector("input[type=text]:not([list])").value,
      active: row.querySelector("input[type=checkbox]").checked,
    })),
  };
  const signature = JSON.stringify(command);
  if (operation?.signature !== signature) operation = { signature, id: crypto.randomUUID() };
  busy = true;
  const controls = document.querySelectorAll("#device-form button, #device-form input, #device-form textarea");
  for (const control of controls) control.disabled = true;
  try {
    registry = await saveRegistry(editor.revision, command, operation.id);
    dialog.close();
    notify("Zapisano urządzenie.");
    render();
  } catch (error) {
    byId("form-error").textContent = error.status === 409
      ? "Rejestr zmienił się od otwarcia formularza. Wpisane pola zachowano. Skopiuj zmiany i otwórz aktualną kartę albo anuluj zapis."
      : error.message;
  } finally {
    busy = false;
    for (const control of controls) control.disabled = false;
  }
};

byId("add-device").onclick = () => openEditor();
byId("add-activity").onclick = () => {
  appendActivity();
  byId("activity-rows").lastElementChild.querySelector("input").focus();
};
byId("close-dialog").onclick = closeEditor;
byId("cancel-device").onclick = closeEditor;
dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
byId("query").oninput = renderRegistry;
byId("filter").onchange = renderRegistry;
for (const control of document.querySelectorAll("[data-panel]")) {
  control.onclick = () => {
    currentPanel = control.dataset.panel;
    for (const tab of document.querySelectorAll("[data-panel]")) {
      tab.setAttribute("aria-pressed", String(tab === control));
      byId(tab.dataset.panel + "-panel").hidden = tab !== control;
    }
    render();
    if (currentPanel === "schedule") planner.refresh();
  };
}

if (await refresh()) byId("workspace").hidden = false;
setInterval(async () => {
  if (document.visibilityState !== "visible") return;
  if (await refresh()) byId("workspace").hidden = false;
  if (currentPanel === "schedule") await planner.refresh();
}, 3000);
