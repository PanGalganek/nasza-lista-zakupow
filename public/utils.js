export function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseLocalDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

export function calculateCalendarDays(startDate, endDate) {
  if (startDate == null || endDate == null) {
    return null;
  }
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((endUtc - startUtc) / 86_400_000);
}

export function groupChemicalItems(items) {
  const groups = new Map();
  items.forEach((item) => {
    const prefix = String(item.group || "Inne").split("/")[0];
    const name = String(item.name || "Bez nazwy");
    const key = `${prefix}\u0000${name.toLocaleLowerCase("pl")}`;
    if (!groups.has(key)) groups.set(key, { key, prefix, name, items: [] });
    groups.get(key).items.push(item);
  });
  return [...groups.values()];
}

export function buildChemicalAlerts(items, threshold, today = new Date()) {
  const alerts = [];
  groupChemicalItems(items).forEach((group) => {
    const withDays = group.items.map((item) => ({
      item,
      days: calculateCalendarDays(today, parseLocalDate(item.expiry)),
    }));
    const expiring = withDays.filter(({ days }) => days !== null && days <= threshold);
    const backups = withDays.filter(({ days }) => days !== null && days > threshold);
    if (expiring.length === 0) return;

    const byExpiry = (a, b) => String(a.item.expiry).localeCompare(String(b.item.expiry));
    if (backups.length > 0) {
      const best = [...backups].sort((a, b) => byExpiry(b, a))[0].item;
      const candidate = [...expiring].sort(byExpiry)[0].item;
      alerts.push({ prefix: group.prefix, name: group.name, type: "backup", date: best.expiry, item: candidate });
      return;
    }

    const expired = expiring.filter(({ days }) => days < 0);
    const ordered = expiring.filter(({ item }) => item.ordered);
    const type = expired.length ? "expired" : ordered.length ? "ordered" : "warning";
    const candidates = expired.length ? expired : ordered.length ? ordered : expiring;
    const candidate = [...candidates].sort(byExpiry)[0].item;
    alerts.push({ prefix: group.prefix, name: group.name, type, date: candidate.expiry, item: candidate });
  });
  return alerts;
}

export function shiftCalendarMonth(date, offset) {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

export function isDoneInYear(dateValue, year) {
  const date = parseLocalDate(dateValue);
  return Boolean(date && date.getFullYear() === year);
}

export function suggestNextGroupValue(items, prefix) {
  const values = items.map((item) => String(item.group || ""));
  const numericSuffixes = values
    .filter((value) => value.startsWith(`${prefix}/`))
    .map((value) => value.slice(prefix.length + 1))
    .filter((suffix) => /^\d+$/.test(suffix))
    .map(Number);

  if (numericSuffixes.length > 0) {
    return `${prefix}/${Math.max(...numericSuffixes) + 1}`;
  }
  if (values.some((value) => value.includes("/"))) {
    return `${prefix}/`;
  }
  return values.find(Boolean) || (prefix === "Inne" ? "" : prefix);
}

