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
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((endUtc - startUtc) / 86_400_000);
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

