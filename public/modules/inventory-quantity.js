import { parseLocalDate } from "../utils.js?v=38";

export const units = {
  mg: ["masa", 1_000], g: ["masa", 1_000_000], kg: ["masa", 1_000_000_000],
  "µl": ["objętość", 1_000], ml: ["objętość", 1_000_000], l: ["objętość", 1_000_000_000],
  "szt.": ["szt.", 1], "testów": ["testów", 1],
};
export const flaskVolumes = [50, 100, 250, 500, 1000];
export const maxQuantity = 1_000_000_000_000;

export function compatibleUnits(a, b) {
  return Boolean(units[a] && units[b] && units[a][0] === units[b][0]);
}

export function quantity(value, unit, { zero = false } = {}) {
  const match = /^(\d{1,13})(?:[.,](\d{1,9}))?$/.exec(String(value).trim());
  if (!match || !units[unit]) throw new Error("Podaj poprawną ilość i jednostkę.");
  const fraction = match[2] || "";
  const denominator = 10n ** BigInt(fraction.length);
  const amount = BigInt(match[1] + fraction) * BigInt(units[unit][1]);
  if (amount % denominator || amount / denominator > BigInt(maxQuantity) || (!zero && !amount)) {
    throw new Error("Ilość przekracza zakres lub dokładność tej jednostki.");
  }
  return Number(amount / denominator);
}

export function scaledQuantity(amount, numerator, denominator) {
  const scaled = BigInt(amount) * BigInt(numerator);
  const divisor = BigInt(denominator);
  if (divisor <= 0n || scaled % divisor || scaled / divisor > BigInt(maxQuantity) || scaled <= 0n) {
    throw new Error("Wybranej ilości nie można zapisać z dokładnością jednostki magazynowej.");
  }
  return Number(scaled / divisor);
}

export function formatQuantity(amount, unit) {
  const value = BigInt(amount);
  const factor = BigInt(units[unit][1]);
  const absolute = value < 0n ? -value : value;
  const remainder = (absolute % factor).toString().padStart(String(factor).length - 1, "0").replace(/0+$/, "");
  return `${value < 0n ? "−" : ""}${(absolute / factor).toLocaleString("pl-PL")}${remainder ? `,${remainder}` : ""} ${unit}`;
}

export function stockLevel(stock) {
  if (!stock || stock.initial === 0) return null;
  const percent = stock.balance * 100 / stock.initial;
  return { percent, color: stock.balance * 4 <= stock.initial ? "red" : stock.balance * 2 <= stock.initial ? "yellow" : "green" };
}

export function validLots(lots, unit, today) {
  return lots.filter((lot) => lot.stock?.status === "active" && lot.stock.balance > 0
    && compatibleUnits(unit, lot.stock.unit) && (!lot.expiry || (parseLocalDate(lot.expiry) && lot.expiry >= today)))
    .sort((a, b) => (a.expiry || "9999").localeCompare(b.expiry || "9999") || a.timestamp - b.timestamp);
}

export function normalizeInventorySearch(value) {
  return String(value ?? "").normalize("NFKD").toLocaleLowerCase("pl")
    .replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").trim();
}

export function matchesInventorySearch(query, ...values) {
  const haystack = normalizeInventorySearch(values.filter(Boolean).join(" "));
  return normalizeInventorySearch(query).split(/\s+/).every((term) => haystack.includes(term));
}
