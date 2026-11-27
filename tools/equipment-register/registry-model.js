
import { createRegister, groupActivities, groupSources, restoreDraft } from "./model.js";

import { activitySignature, appendActivity, editDevice, equipmentText as text, newDevice, RegistryError } from "../../public/equipment/registry-model.js?v=38";
export { needsDetails, scheduleEquipment, RegistryError } from "../../public/equipment/registry-model.js?v=38";

const deviceStatuses = new Set(["active", "withdrawn"]);

export function makeInitialRegistry(sources) {
  const { draft } = createRegister(sources);
  const state = { mapping: draft, equipment: {} };
  applyGrouping(state, draft, sources);
  return state;
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
  const device = editDevice(previous, command, operationId);
  const editsById = new Map(device.activities.map(row => [row.id, row]));

  for (const assignment of Object.values(state.mapping.assignments)) {
    if (assignment.groupId !== device.id) continue;
    const saved = previous?.activities.find(activity => activitySignature(activity) === activitySignature(assignment));
    if (saved) {
      const updated = editsById.get(saved.id);
      assignment.kind = updated.kind;
      assignment.label = updated.label;
    }
  }
  state.equipment[device.id] = device;
  const group = state.mapping.groups.find(row => row.id === device.id);
  if (group) Object.assign(group, { name: device.name, number: device.number });
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
