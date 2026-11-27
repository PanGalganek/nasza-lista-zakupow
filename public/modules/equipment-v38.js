import { createEquipmentModule as legacyModule } from "./equipment.js?v=38";
import { annualPlanner } from "../equipment/planner.js?v=38";
import { executionView } from "../equipment/execution.js?v=38";
import { registryPanel } from "../equipment/registry-ui.js?v=38";
import { equipmentStore } from "../equipment/firestore-store.js?v=38";
import { currentPeriod, deadlineWarnings } from "../equipment/execution-model.js?v=38";
import { monthlyNames } from "../equipment/plan-model.js?v=38";
import { byId } from "./ui.js?v=38";

export function createEquipmentV38(dependencies) {
  const { db, firestore, registerSnapshot, reportListenerError, navigation, userId } = dependencies;
  const { doc, collection, onSnapshot } = firestore;
  let mode, route, latestRegistry, legacyStop;
  let workspaceStops = [];
  let generation = 0;
  const enabled = () => mode === "active";
  const current = () => mode === "active" || mode === "paused";
  const legacy = legacyModule({ ...dependencies, equipmentReadOnly: () => mode !== "legacy",
    registerSnapshot: unsubscribe => { legacyStop = unsubscribe; } });
  const api = equipmentStore({ db, firestore, userId, canWrite: enabled });
  const plan = annualPlanner(api);
  const execution = executionView(api);
  const registry = registryPanel(api, id => {
    navigation.go("equipment/history");
    execution.showHistory(id);
  }, enabled);
  const panel = () => route?.split("/")[1] ?? "registry";
  const workspace = byId("equipmentV38");
  const failure = error => reportListenerError("Sprzęt", error);

  function release() {
    generation++;
    workspaceStops.forEach(stop => stop());
    workspaceStops = [];
  }

  async function warnings() {
    const key = generation;
    try {
      const data = await api.loadExecution();
      if (key !== generation || !route || !current()) return;
      const next = deadlineWarnings(data, currentPeriod());
      const banner = byId("upcomingWzorcowanieAlert");
      const text = [];
      if (next.current.length) text.push("Do wykonania w bieżącym miesiącu: " + next.current.length);
      if (next.overdue.length) text.push("Zaległe: " + next.overdue.length);
      if (next.upcoming.length) text.push("Kolejny miesiąc · " + monthlyNames[next.next.month - 1] + " " + next.next.year + ": " + next.upcoming.length);
      banner.textContent = text.join(" · ");
      banner.classList.toggle("hidden", !text.length || panel() === "execution");
    } catch (error) { if (key === generation) failure(error); }
  }

  function show() {
    if (!route || !current() || !latestRegistry) return;
    const chosen = panel();
    if (chosen === "registry") registry.show(latestRegistry.state);
    if (chosen === "schedule") {
      plan.show(latestRegistry.state.equipment);
      plan.refresh();
    }
    if (chosen === "execution" || chosen === "history") {
      execution.show(latestRegistry.state);
      execution.refresh();
    }
  }

  function watch() {
    if (workspaceStops.length) return;
    const calendar = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (panel() === "history" || panel() === "execution") execution.refresh();
      warnings();
    }, 60000);
    workspaceStops = [
      () => clearInterval(calendar),
      api.watchRegistry(value => { latestRegistry = value; show(); }, failure),
      onSnapshot(collection(db, "equipmentYears"), snapshot => {
        api.setHeaders(snapshot.docs.map(record => [Number(record.id), record.data()]));
        if (panel() === "schedule") plan.refresh();
        if (panel() === "history" || panel() === "execution") execution.refresh();
        warnings();
      }, failure),
    ];
  }

  function render(next = route) {
    if (route !== next) for (const dialog of workspace.querySelectorAll("dialog[open]")) dialog.close();
    route = next;
    if (!route) { release(); return; }
    const chosen = panel();
    byId("equipmentLegacy").hidden = mode !== "legacy" && mode !== "preparing";
    workspace.hidden = !current();
    byId("equipmentModeNotice").textContent = mode === "paused"
      ? "Moduł w trybie odczytu." : mode === "preparing" ? "Trwa przygotowanie rejestru. Dotychczasowy harmonogram jest w trybie odczytu."
        : mode == null ? "Wczytywanie modułu sprzętu…" : "";
    byId("addEquipment").hidden = mode !== "legacy" && !(enabled() && chosen === "registry");
    workspace.dataset.readonly = String(!enabled());
    for (const name of ["registry","schedule","execution","history"]) byId("equipment-" + name).hidden = name !== chosen;
    for (const button of workspace.querySelectorAll(".equipment-tabs [data-route]")) {
      button.setAttribute("aria-pressed", String(button.dataset.route === "equipment/" + chosen));
    }
    if (current()) { watch(); show(); warnings(); }
    else if (mode === "legacy" || mode === "preparing") legacy.render();
  }

  function start() {
    registerSnapshot(onSnapshot(doc(db, "equipmentState", "cutover"), snapshot => {
      mode = snapshot.data()?.mode ?? "legacy";
      if (mode === "legacy" || mode === "preparing") {
        if (!legacyStop) legacy.start();
        release();
      } else if (legacyStop) {
        legacyStop();
        legacyStop = undefined;
      }
      if (route) render();
    }, failure));
  }

  function stop() {
    release();
    if (legacyStop) legacyStop();
    mode = route = latestRegistry = legacyStop = undefined;
    for (const dialog of workspace.querySelectorAll("dialog[open]")) dialog.close();
    api.clear();
    plan.reset();
    execution.reset();
    registry.reset();
    workspace.hidden = byId("equipmentLegacy").hidden = true;
  }

  return {
    start, stop, render,
    openForm: () => mode === "legacy" ? legacy.openForm() : registry.edit(),
    save: () => mode === "legacy" ? legacy.save() : undefined,
  };
}
