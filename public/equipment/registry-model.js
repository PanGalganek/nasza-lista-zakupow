const idPattern = /^a[1-9]\d*$/;

export const activitySignature = ({ kind, label }) => JSON.stringify([kind, label]);

export class RegistryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function equipmentText(value, max, label, required = false) {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw new RegistryError("Sprawdź pole „" + label + "”.");
  }
  return value.trim();
}

export function newDevice(id, name, number, verified) {
  return { id, name, number, verified, notes: "", status: "active", nextActivity: 1, activities: [], mergedInto: null };
}

export function appendActivity(device, activity) {
  if (device.nextActivity > 100) throw new RegistryError("Jedna karta może zawierać do 100 czynności.");
  device.activities.push({ id: "a" + device.nextActivity++, ...activity });
}

export function editDevice(previous, command, operationId) {
  const device = previous ?? newDevice("eq-" + operationId, "", "", true);
  const name = equipmentText(command.name, 200, "nazwa", true);
  const number = equipmentText(command.number, 80, "numer ewidencyjny");
  const notes = equipmentText(command.notes, 500, "uwagi");
  if (!Array.isArray(command.activities) || command.activities.length > 100) {
    throw new RegistryError("Sprawdź listę rodzajów czynności.");
  }
  const saved = new Map(device.activities.map(row => [row.id, row]));
  const edits = new Map();
  const added = [];
  for (const row of command.activities) {
    const activity = { kind: equipmentText(row?.kind, 80, "rodzaj czynności", true),
      label: equipmentText(row?.label, 150, "opis czynności"), active: row.active };
    if (typeof activity.active !== "boolean") throw new RegistryError("Nieprawidłowy status czynności.");
    if (row.id === null) { added.push(activity); continue; }
    if (typeof row.id !== "string" || !idPattern.test(row.id) || !saved.has(row.id) || edits.has(row.id)) {
      throw new RegistryError("Nieprawidłowy identyfikator czynności.");
    }
    edits.set(row.id, { id: row.id, ...activity });
  }
  if (edits.size !== saved.size) throw new RegistryError("Użyj wycofania czynności, aby zachować jej identyfikator.");
  const activities = [...edits.values(), ...added];
  if (new Set(activities.map(activitySignature)).size !== activities.length) {
    throw new RegistryError("Dwie czynności mają ten sam rodzaj i opis. Rozróżnij je lub użyj istniejącej.");
  }
  const updated = { ...device, name, number, notes, activities: [...edits.values()] };
  for (const activity of added) appendActivity(updated, activity);
  return updated;
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
