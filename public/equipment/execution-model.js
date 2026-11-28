import { calendarDate, executionActions } from "./plan-model.js?v=38.1";

export function currentPeriod(now = new Date()) {
  const [year, month] = calendarDate(now).split("-").map(Number);
  return { year, month };
}

const periodIndex = (year, month) => year * 12 + month - 1;

export function isOverdue(entry, year, current) {
  return !entry.doneDate && periodIndex(year, entry.month) < periodIndex(current.year, current.month);
}

export function executionTiming(entry, year) {
  if (!entry.doneDate) return null;
  const [doneYear, doneMonth] = entry.doneDate.split("-").map(Number);
  const difference = periodIndex(doneYear, doneMonth) - periodIndex(year, entry.month);
  return difference < 0 ? "Przed terminem" : difference > 0 ? "Po terminie" : "W terminie";
}

export function executionCounts(entries) {
  return { total: entries.length, done: entries.filter(entry => entry.doneDate).length };
}

export function deadlineWarnings(plans, current) {
  const next = current.month === 12 ? { year: current.year + 1, month: 1 } : { year: current.year, month: current.month + 1 };
  const groups = { current: [], overdue: [], upcoming: [], next };
  for (const plan of plans) {
    for (const entry of plan.entries) {
      const item = { ...entry, year: plan.year };
      if (isOverdue(entry, plan.year, current)) groups.overdue.push(item);
      else if (!entry.doneDate && plan.year === current.year && entry.month === current.month) groups.current.push(item);
      else if (plan.year === next.year && entry.month === next.month) groups.upcoming.push(item);
    }
  }
  groups.overdue.sort((a, b) => periodIndex(a.year, a.month) - periodIndex(b.year, b.month));
  return groups;
}

function completion(entry) {
  return entry?.doneDate ? { date: entry.doneDate, notes: entry.doneNotes ?? "" } : null;
}

export function executionEvent(action, before, after, equipment = {}) {
  const device = equipment[after.deviceId];
  const activity = device?.activities.find(item => item.id === after.activityId);
  return {
    action, entryId: after.id, deviceId: after.deviceId, activityId: after.activityId, month: after.month,
    ...(device && { deviceName: device.name, number: device.number }),
    ...(activity && { kind: activity.kind, label: activity.label }),
    before: completion(before), after: completion(after),
  };
}

export function executionHistory(journal, current) {
  const records = [...journal].sort((a, b) => a.revision - b.revision);
  return records.flatMap((record, i) => {
    if (!executionActions.has(record.action)) return [];
    const metadata = { revision: record.revision, savedAt: record.savedAt };
    if (record.event) return [{ ...record.event, ...metadata }];
    // Older local versions recorded completion in the annual revision journal.
    if (record.action !== "complete") return [];
    const previous = new Map((record.previous.approved?.entries ?? []).map(entry => [entry.id, entry]));
    const next = records[i + 1]?.previous ?? current;
    const completed = next.approved?.entries.find(entry => entry.doneDate && previous.has(entry.id) && !previous.get(entry.id).doneDate);
    return completed ? [{ ...executionEvent(record.action, previous.get(completed.id), completed), ...metadata }] : [];
  }).reverse();
}
