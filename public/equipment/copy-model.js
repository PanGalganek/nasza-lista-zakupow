import { evolvePlan } from "./plan-model.js?v=38.1";
import { RegistryError } from "./registry-model.js?v=38.1";

export function copyCandidates(approved, equipment) {
  return (approved?.entries ?? []).filter(({ deviceId, activityId }) => {
    const device = Object.hasOwn(equipment, deviceId) ? equipment[deviceId] : undefined;
    return device?.status === "active" && device.activities.some(activity => activity.id === activityId && activity.active);
  }).map(({ id, deviceId, activityId, month }) => ({ id, deviceId, activityId, month }));
}

export function copyDraft(approved, equipment, selectedIds, newId) {
  if (!approved) throw new RegistryError("Wybierz rok z zatwierdzonym harmonogramem.", 409);
  if (!Array.isArray(selectedIds) || !selectedIds.length || new Set(selectedIds).size !== selectedIds.length) {
    throw new RegistryError("Wybierz przynajmniej jeden termin. Każdy termin można skopiować tylko raz.");
  }
  const candidates = new Map(copyCandidates(approved, equipment).map(term => [term.id, term]));
  const entries = selectedIds.map(id => {
    const term = candidates.get(id);
    if (!term) throw new RegistryError("Część wybranych terminów jest już niedostępna. Odśwież podgląd.", 409);
    return { ...term, id: newId() };
  });
  return evolvePlan({ draft: null, approved: null }, { action: "draft", entries }, equipment);
}
