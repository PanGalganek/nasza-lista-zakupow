import { parseLocalDate } from "../utils.js?v=33";
import { warsawDate } from "./inventory-alerts.js?v=33";
import { outgoingAmount } from "./inventory-history.js?v=33";
import { units, validLots } from "./inventory-quantity.js?v=33";

const dayMs = 86_400_000;
const dayNumber = (date) => Date.parse(date) / dayMs;
const iso = (date) => date.toISOString().slice(0, 10);
const later = (first, second) => first > second ? first : second;

function shiftMonth(date, offset) {
  const shifted = new Date(date + "T00:00:00Z");
  const day = shifted.getUTCDate();
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() + offset + 1, 0);
  shifted.setUTCDate(Math.min(day, shifted.getUTCDate()));
  return iso(shifted);
}

export function statisticsRange(period, today, from, to) {
  if (period !== "custom") return { from: shiftMonth(today.slice(0, 7) + "-01", 1 - Number(period)), to: today };
  if (!parseLocalDate(from) || !parseLocalDate(to) || from > to || to > today) return null;
  return { from, to };
}

function calendarMonths(from, to) {
  const months = [];
  for (let first = from.slice(0, 7) + "-01"; first <= to; first = shiftMonth(first, 1)) {
    const next = shiftMonth(first, 1);
    const includedDays = Math.min(dayNumber(next), dayNumber(to) + 1) - dayNumber(later(first, from));
    months.push({ month: first.slice(0, 7), fraction: includedDays / (dayNumber(next) - dayNumber(first)), outgoing: 0n, incoming: 0n });
  }
  return months;
}

function monthPosition(date, includeDay = false) {
  const [year, month, day] = date.split("-").map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return year * 12 + month - 1 + (day - Number(!includeDay)) / days;
}

function forecast({ months, outgoing, available }, today) {
  const exposure = months.reduce((sum, row) => sum + row.fraction, 0);
  const average = exposure ? Number(outgoing) / exposure : null;
  if (exposure < 2 || average <= 0 || months.filter((row) => row.outgoing > 0n).length < 2) return { average };
  const lots = [...available].sort((first, second) => (first.expiry || "9999").localeCompare(second.expiry || "9999"));
  // Inclusive expiry day, with demand spread evenly within each calendar month.
  const start = monthPosition(today);
  const lotsWithExpiry = lots.map((lot) => ({
    amount: lot.stock.balance,
    capacity: lot.expiry ? average * (monthPosition(lot.expiry, true) - start) : Infinity,
  }));
  function usable(demand) {
    let covered = 0;
    for (const lot of lotsWithExpiry) covered += Math.min(lot.amount, Math.max(0, Math.min(demand, lot.capacity) - covered));
    return covered;
  }
  return {
    average,
    runway: usable(Infinity) / average,
    horizons: [3, 6, 12].map((months) => {
      const demand = average * months;
      return { months, demand, usable: usable(demand) };
    }),
  };
}

export function productStatistics({ lots, events, calculations, matches, range, today, method = "" }) {
  const values = new Map();
  const byId = new Map(events.map((event) => [event.id, event]));
  const lotIds = new Set(lots.map((lot) => lot.id));
  function bucket(unit) {
    const dimension = units[unit]?.[0];
    if (!dimension) return null;
    if (!values.has(dimension)) values.set(dimension, {
      dimension, knownStock: false, daysOfEvidence: new Map(), available: [], stock: 0n, theoretical: null, comparisonActual: 0n,
    });
    return values.get(dimension);
  }
  for (const lot of lots) {
    if (!lot.stock || lot.stock.initial === null) continue;
    const group = bucket(lot.stock.unit);
    if (!group) continue;
    group.knownStock = true;
    if (validLots([lot], lot.stock.unit, today).length) {
      group.available.push(lot);
      group.stock += BigInt(lot.stock.balance);
    }
  }
  for (const event of events) {
    const date = event.createdAt?.toDate?.();
    if (!date || !Number.isFinite(+date)) continue;
    const day = warsawDate(date);
    if (day > range.to) continue;
    const linked = event.kind === "reversal" ? byId.get(event.details?.originalId) : event;
    for (const [lotId, row] of Object.entries(event.changes || {})) {
      if (!lotIds.has(lotId) && !matches(row.productId)) continue;
      const group = bucket(row.unit);
      if (!group || (row.before === null && event.kind !== "opening")) continue;
      const entry = group.daysOfEvidence.get(day) || { incoming: 0n, outgoing: 0n };
      if (event.kind === "receipt" || (event.kind === "opening_correction" && event.details?.sourceKind === "receipt")) {
        entry.incoming += BigInt(row.after - row.before);
      }
      const outgoing = BigInt(outgoingAmount(event, row) ?? 0);
      entry.outgoing += outgoing;
      group.daysOfEvidence.set(day, entry);
      if (day >= range.from && (!method || linked?.details?.methodId === method)) group.comparisonActual += outgoing;
    }
  }
  for (const record of calculations) {
    if (record.date < range.from || record.date > range.to || (method && record.methodId !== method)) continue;
    for (const row of record.commercial || []) {
      if (!matches(row.productId)) continue;
      const group = bucket(row.unit);
      if (group) group.theoretical = (group.theoretical ?? 0n) + BigInt(row.quantity);
    }
  }
  const unknownStock = lots.some((lot) => [undefined, "active"].includes(lot.stock?.status)
    && (!lot.expiry || (parseLocalDate(lot.expiry) && lot.expiry >= today)) && (!lot.stock || lot.stock.initial === null));
  return {
    unknownStock,
    groups: [...values.values()].map(({ daysOfEvidence, ...group }) => {
      const first = [...daysOfEvidence.keys()].sort()[0];
      const months = first ? calendarMonths(later(first, range.from), range.to) : [];
      const byMonth = new Map(months.map((entry) => [entry.month, entry]));
      for (const [day, entry] of daysOfEvidence) {
        if (day < range.from) continue;
        const month = byMonth.get(day.slice(0, 7));
        month.incoming += entry.incoming;
        month.outgoing += entry.outgoing;
      }
      const outgoing = months.reduce((sum, month) => sum + month.outgoing, 0n);
      const prediction = forecast({ ...group, months, outgoing }, today);
      return { ...group, first, months, outgoing, ...prediction };
    }),
  };
}

const normalAmount = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 });
const smallAmount = new Intl.NumberFormat("pl-PL", { maximumSignificantDigits: 3 });

export function statisticsQuantity(amount, dimension) {
  const value = Number(amount);
  const absolute = Math.abs(value);
  const unit = {
    masa: absolute >= units.kg[1] ? "kg" : absolute > 0 && absolute < units.g[1] ? "mg" : "g",
    objętość: absolute >= units.l[1] ? "l" : absolute > 0 && absolute < units.ml[1] ? "µl" : "ml",
  }[dimension] || dimension;
  const scaled = value / units[unit][1];
  return `${(scaled && Math.abs(scaled) < 1 ? smallAmount : normalAmount).format(scaled)} ${unit}`;
}
