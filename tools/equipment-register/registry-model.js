
import { activityKinds, createRegister, groupActivities, groupSources, restoreDraft } from "./model.js";

const deviceStatuses = new Set(["active", "withdrawn"]);
const activitySignature = ({ kind, label }) => JSON.stringify([kind, label]);
const idPattern = /^a[1-9]\d*$/;

export class RegistryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function text(value, max, label, required = false) {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw new RegistryError("Sprawdź pole „" + label + "”.");
  }
  return value.trim();
}

export function makeInitialRegistry(sources) {
  const { draft } = createRegister(sources);
  const state = { mapping: draft, equipment: {} };
  applyGrouping(state, draft, sources);
  return state;
}

function newDevice(id, name, number, verified) {
  return { id, name, number, verified, notes: "", status: "active", nextActivity: 1, activities: [], mergedInto: null };
}

function appendActivity(device, activity) {
  device.activities.push({ id: "a" + device.nextActivity++, ...activity });
}

function applyGrouping(state, mapping, sources) {
  restoreDraft(mapping, sources);
  const before = state.mapping;
  if (mapping.nextGroup < before.nextGroup) {
    throw new RegistryError("Przypisania są starsze niż zapisany stan. Otwórz bieżący rejestr.", 409);
  }
  const beforeGroups = groupSources(before, sources);
  const afterGroups = groupSources(mapping, sources);
  for (const group of mapping.groups) {
    const existing = state.equipment[group.id];
    if (existing && !beforeGroups.has(group.id)) {
      throw new RegistryError("Nie można ponownie nadać identyfikatora wcześniej istniejącego urządzenia.");
    }
    const device = existing ?? newDevice(group.id, "", "", group.approved);
    device.name = text(group.name, 200, "nazwa", true);
    device.number = text(group.number, 80, "numer ewidencyjny");
    device.verified = group.approved;
    for (const activity of groupActivities(mapping, afterGroups.get(group.id))) {
      if (!device.activities.some(saved => activitySignature(saved) === activitySignature(activity))) {
        appendActivity(device, { kind: activity.kind, label: activity.label, active: true });
      }
    }
    state.equipment[group.id] = device;
  }
  for (const group of before.groups) {
    if (afterGroups.has(group.id)) continue;
    const device = state.equipment[group.id];
    const targets = new Set(beforeGroups.get(group.id).map(source => mapping.assignments[source.id].groupId));
    device.status = "withdrawn";
    device.mergedInto = targets.size === 1 ? targets.values().next().value : null;
  }
  state.mapping = mapping;
}

function upsertDevice(state, command, operationId) {
  const previous = Object.hasOwn(state.equipment, command.deviceId) ? state.equipment[command.deviceId] : undefined;
  if (command.deviceId && !previous) throw new RegistryError("Nie znaleziono urządzenia.", 404);
  const device = previous ?? newDevice("eq-" + operationId, "", "", true);
  const name = text(command.name, 200, "nazwa", true);
  const number = text(command.number, 80, "numer ewidencyjny");
  const notes = text(command.notes, 500, "uwagi");
  if (!Array.isArray(command.activities) || command.activities.length > 100) {
    throw new RegistryError("Sprawdź listę rodzajów czynności.");
  }

  const savedById = new Map(device.activities.map(row => [row.id, row]));
  const editsById = new Map();
  const newActivities = [];
  for (const row of command.activities) {
    const activity = { kind: text(row?.kind, 80, "rodzaj czynności", true), label: text(row?.label, 150, "opis czynności"), active: row.active };
    if (typeof activity.active !== "boolean") throw new RegistryError("Nieprawidłowy status czynności.");
    if (row.id === null) {
      newActivities.push(activity);
      continue;
    }
    if (typeof row.id !== "string" || !idPattern.test(row.id) || !savedById.has(row.id) || editsById.has(row.id)) {
      throw new RegistryError("Nieprawidłowy identyfikator czynności.");
    }
    editsById.set(row.id, { id: row.id, ...activity });
  }
  if (editsById.size !== savedById.size) throw new RegistryError("Użyj wycofania czynności, aby zachować jej identyfikator.");
  const activities = [...editsById.values(), ...newActivities];
  if (new Set(activities.map(activitySignature)).size !== activities.length) {
    throw new RegistryError("Dwie czynności mają ten sam rodzaj i opis. Rozróżnij je lub użyj istniejącej.");
  }

  for (const assignment of Object.values(state.mapping.assignments)) {
    if (assignment.groupId !== device.id) continue;
    const saved = device.activities.find(activity => activitySignature(activity) === activitySignature(assignment));
    if (saved) {
      const updated = editsById.get(saved.id);
      assignment.kind = updated.kind;
      assignment.label = updated.label;
    }
  }
  Object.assign(device, { name, number, notes, activities: [...editsById.values()] });
  for (const activity of newActivities) appendActivity(device, activity);
  state.equipment[device.id] = device;
  const group = state.mapping.groups.find(row => row.id === device.id);
  if (group) Object.assign(group, { name, number });
  return device.id;
}

export function evolveRegistry(previous, command, sources, operationId) {
  const state = structuredClone(previous);
  if (command?.action === "upsert") {
    return { state, affectedId: upsertDevice(state, command, operationId) };
  }
  if (command?.action === "status") {
    const device = Object.hasOwn(state.equipment, command.deviceId) ? state.equipment[command.deviceId] : undefined;
    if (!device || !deviceStatuses.has(command.status)) throw new RegistryError("Nieprawidłowa zmiana statusu urządzenia.");
    device.status = command.status;
    if (device.status === "active") device.mergedInto = null;
    return { state, affectedId: device.id };
  }
  if (command?.action === "grouping") {
    try {
      applyGrouping(state, command.mapping, sources);
    } catch (error) {
      throw error instanceof RegistryError ? error : new RegistryError(error.message);
    }
    return { state, affectedId: null };
  }
  throw new RegistryError("Nieznana operacja.");
}

export function needsDetails(device) {
  return !device.number || !device.verified || !device.activities.some(activity => activity.active);
}

export function scheduleEquipment(equipment) {
  return Object.values(equipment).filter(device => device.status === "active").map(device => ({
    id: device.id, name: device.name, number: device.number, needsDetails: needsDetails(device),
    activities: device.activities.filter(activity => activity.active),
  }));
}
