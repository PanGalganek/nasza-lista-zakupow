import { RegistryError } from "./registry-model.js?v=38";

export const monthlyNames = ["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec",
  "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień"];
export const rowKey = (deviceId, activityId) => deviceId + ":" + activityId;
const slot = row => rowKey(row.deviceId, row.activityId) + ":" + row.month;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const warsawDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", dateStyle: "short" });
export const calendarDate = (now = new Date()) => warsawDate.format(now);
export const initialYear = () => Number(calendarDate().slice(0, 4));
export const validYear = year => Number.isInteger(year) && year >= 2000 && year <= 2199;
export const executionActions = new Set(["complete", "correct", "undo"]);

export function planRows(equipment, entries, editing) {
  const keys = new Set(entries.map(row => rowKey(row.deviceId, row.activityId)));
  return Object.values(equipment).flatMap(device => device.activities.flatMap(activity => {
    const key = rowKey(device.id, activity.id);
    const available = device.status === "active" && activity.active;
    return keys.has(key) || (editing && available) ? [{ key, device, activity, available }] : [];
  }));
}

export function planCounts(entries) {
  const months = Array(12).fill(0);
  for (const entry of entries) months[entry.month - 1]++;
  return { months, total: entries.length, completed: entries.filter(entry => entry.doneDate).length };
}

function validDate(value, today) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value <= today;
}

function validateEntries(input, plan, equipment) {
  if (!Array.isArray(input) || input.length > 2200) throw new RegistryError("Sprawdź liczbę terminów w harmonogramie.");
  const previous = new Map([...(plan.draft?.entries ?? []), ...(plan.approved?.entries ?? [])].map(row => [row.id, row]));
  const ids = new Set();
  const slots = new Set();
  const result = [];
  for (const row of input) {
    if (!row || typeof row.id !== "string" || (!uuid.test(row.id)
        && !(row.id.startsWith(rowKey(row.deviceId, row.activityId) + ":") && uuid.test(row.id.split(":").at(-1))))
        || ids.has(row.id)
        || typeof row.deviceId !== "string" || typeof row.activityId !== "string"
        || !Number.isInteger(row.month) || row.month < 1 || row.month > 12) {
      throw new RegistryError("Nieprawidłowy lub powtórzony termin.");
    }
    const device = Object.hasOwn(equipment, row.deviceId) ? equipment[row.deviceId] : null;
    const activity = device?.activities.find(item => item.id === row.activityId);
    const saved = previous.get(row.id);
    if (!activity || (saved && (saved.deviceId !== row.deviceId || saved.activityId !== row.activityId))
        || (!saved && (device.status !== "active" || !activity.active))) {
      throw new RegistryError("Sprzęt lub czynność nie są dostępne dla tego terminu.");
    }
    if (saved?.doneDate && saved.month !== row.month) throw new RegistryError("Wykonanego terminu nie można przesunąć.");
    const entry = { id: row.id, deviceId: row.deviceId, activityId: row.activityId, month: row.month, doneDate: saved?.doneDate ?? null };
    if (saved?.doneNotes) entry.doneNotes = saved.doneNotes;
    if (slots.has(slot(entry))) throw new RegistryError("Czynność może mieć jeden termin w danym miesiącu.");
    slots.add(slot(entry));
    ids.add(entry.id);
    result.push(entry);
  }
  if ([...previous.values()].some(row => row.doneDate && !ids.has(row.id))) {
    throw new RegistryError("Wykonany termin musi pozostać w planie.");
  }
  return result;
}

export function evolvePlan(previous, command, equipment, now = new Date().toISOString()) {
  if (command?.action === "draft" || command?.action === "approve") {
    const entries = validateEntries(command.entries, previous, equipment);
    if (command.action === "draft") return { ...previous, draft: { entries, savedAt: now } };
    return { draft: null, approved: { entries, approvedAt: now } };
  }
  if (executionActions.has(command?.action)) {
    const current = previous.approved?.entries.find(entry => entry.id === command.entryId);
    if (!current || Boolean(current.doneDate) !== (command.action !== "complete")) {
      throw new RegistryError(command.action === "complete" ? "Wybierz zatwierdzony termin bez daty wykonania." : "Wybierz wykonany termin.");
    }
    const undo = command.action === "undo";
    const notes = command.doneNotes ?? "";
    if (!undo && !validDate(command.doneDate, calendarDate(new Date(now)))) {
      throw new RegistryError("Wpisz poprawną datę wykonania, nie późniejszą niż dziś.");
    }
    if (!undo && (typeof notes !== "string" || notes.length > 500)) throw new RegistryError("Uwagi mogą mieć do 500 znaków.");
    const updated = { ...current, doneDate: undo ? null : command.doneDate };
    delete updated.doneNotes;
    if (!undo && notes.trim()) updated.doneNotes = notes.trim();
    const replace = row => row.id === updated.id ? updated : row;
    const approved = { ...previous.approved, entries: previous.approved.entries.map(replace) };
    const draft = previous.draft ? {
      ...previous.draft,
      entries: command.action === "complete"
        ? [...previous.draft.entries.filter(row => row.id !== updated.id && slot(row) !== slot(updated)), updated]
        : previous.draft.entries.map(replace),
    } : null;
    return { approved, draft };
  }
  throw new RegistryError("Nieznana operacja harmonogramu.");
}
