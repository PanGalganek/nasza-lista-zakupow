import { chemicalCategory, formatPolishDate } from "../utils.js?v=30";
import { formatQuantity, normalizeInventorySearch, units } from "./inventory-quantity.js?v=30";

export function standardKind(item) {
  if (chemicalCategory(item) === "Odczynniki") return "";
  const read = (value) => {
    const text = normalizeInventorySearch(value);
    const periodic = /\bokresow(?:y|a|e|ego|ej|ych|ymi)?\b|\(o\)/.test(text);
    const regular = /\bbiezac(?:y|a|e|ego|ej|ych|ymi)?\b|\(b\)/.test(text);
    return { periodic, regular };
  };
  const usage = read(item.usage);
  const { periodic, regular } = usage.periodic || usage.regular ? usage : read(`${item.name || ""} ${item.group || ""}`);
  return periodic === regular ? "" : periodic ? "O" : "B";
}

export function legacyCatalogKey(item) {
  const prefix = String(item.group || "").split("/")[0].trim();
  if (!prefix || !item.name?.trim()) return "";
  const normal = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("pl");
  return JSON.stringify([chemicalCategory(item), standardKind(item), prefix, item.name,
    item.producer, item.cas, item.formula, item.orderDescription,
    item.packageAmount, item.packageUnit, item.orderPackaging?.amount, item.orderPackaging?.unit, item.orderPackages].map(normal));
}

export function orderItemKey(lot) {
  const legacy = !lot.productId && legacyCatalogKey(lot);
  return legacy ? `legacy:${legacy}` : `product:${lot.productId || lot.id}:${standardKind(lot)}`;
}

const catalogText = (value) => String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pl");

export function indexCatalog(lots) {
  const records = new Map(lots.map((lot) => [lot.id, lot]));
  const rawGroups = new Map();
  for (const lot of lots) {
    const id = lot.productId || lot.id;
    if (!rawGroups.has(id)) rawGroups.set(id, []);
    rawGroups.get(id).push(lot);
  }
  const candidates = new Map();
  for (const [id, parts] of rawGroups) {
    const root = records.get(id) || parts[0];
    const group = catalogText(String(root.group || "").split("/")[0]);
    const name = catalogText(root.name);
    if (!group || !name) continue;
    const key = JSON.stringify([chemicalCategory(root), standardKind(root), group, name]);
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push({ id, root, explicit: parts.some((part) => part.productId === id) });
  }
  const aliases = new Map();
  for (const group of candidates.values()) {
    if (group.length < 2 || group.filter(({ explicit }) => explicit).length > 1) continue;
    const conflicting = ["producer", "formula", "cas", "orderDescription", "packageDimension"].some((field) => {
      const values = group.map(({ root }) => field === "packageDimension" ? units[root.packageUnit]?.[0] : catalogText(root[field]));
      return new Set(values.filter(Boolean)).size > 1;
    });
    if (conflicting) continue;
    group.sort((a, b) => Number(b.explicit) - Number(a.explicit)
      || (a.root.timestamp || 0) - (b.root.timestamp || 0) || a.id.localeCompare(b.id));
    for (const entry of group) aliases.set(entry.id, group[0].id);
  }
  const products = new Map();
  for (const [id, parts] of rawGroups) {
    const key = aliases.get(id) || id;
    if (!products.has(key)) products.set(key, { product: records.get(key) || parts[0], lots: [] });
    products.get(key).lots.push(...parts);
  }
  return { aliases, products };
}

export function lotDescription(lot) {
  return [lot.group, lot.lotNumber ? `Partia ${lot.lotNumber}` : "Partia bez numeru",
    lot.expiry ? `Ważność do ${formatPolishDate(lot.expiry)}` : "Bez daty ważności",
    lot.received && `Przyjęto ${formatPolishDate(lot.received)}`].filter(Boolean).join(" · ");
}

export function readableLotNames(lots) {
  const names = new Map();
  const uniqueLabels = new Map();
  const ordered = [...lots].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || a.id.localeCompare(b.id));
  for (const lot of ordered) {
    const label = lotDescription(lot);
    if (!uniqueLabels.has(label)) uniqueLabels.set(label, []);
    uniqueLabels.get(label).push(lot.id);
  }
  for (const [label, ids] of uniqueLabels) {
    ids.forEach((id, i) => names.set(id, ids.length > 1 ? `${label} · Opakowanie ${i + 1}` : label));
  }
  return names;
}

export function orderPackageCount(line) {
  if (Number.isSafeInteger(line.packages) && line.packages >= 1 && line.packages <= 10000) return line.packages;
  if (!line.amount?.trim()) return null;
  const match = line.amount.match(/^(\d+)\s*×/);
  return match ? Number(match[1]) || null : 1;
}

export function orderLineMatches(line, lot) {
  const kind = standardKind(lot);
  return line.productId === (lot.productId || lot.id)
    && (!line.standardKind || !kind || line.standardKind === kind);
}

export function orderLineProgress(order, index) {
  return order.deliveries?.[index] || { received: 0, complete: false };
}

const polishOrderCalendar = new Intl.DateTimeFormat("pl-PL", {
  timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
});

export function orderRecordedDate(order, field) {
  const time = order[field]?.toDate?.();
  return time ? polishOrderCalendar.format(time) : formatPolishDate(order.date, "");
}

export function orderStatus(entries, lot) {
  const newest = (field) => (a, b) => (b.order[field]?.seconds || 0) - (a.order[field]?.seconds || 0)
    || (b.order[field]?.nanoseconds || 0) - (a.order[field]?.nanoseconds || 0)
    || b.order.date.localeCompare(a.order.date);
  const confirmed = entries.filter(({ order }) => order.status === "ordered");
  const pending = confirmed.filter(({ order, index }) => !orderLineProgress(order, index).complete).sort(newest("orderedAt"))[0];
  if (pending) return { state: "ordered", order: pending.order };
  if (lot.ordered && confirmed.length === 0) return { state: "ordered" };
  const generated = entries.filter(({ order }) => order.status === "generated").sort(newest("createdAt"))[0];
  return generated ? { state: "generated", order: generated.order } : { state: "idle", history: confirmed.length > 0 };
}

export function lotOptions(lots) {
  const labels = lots.map((lot) => {
    const stock = lot.stock;
    const kind = standardKind(lot);
    const availability = !stock || stock.initial === null ? "stan nieustalony"
      : stock.status !== "active" ? "partia zamknięta" : `dostępne ${formatQuantity(stock.balance, stock.unit)}`;
    return [
      lot.lotNumber ? `Partia ${lot.lotNumber}` : "Partia bez numeru",
      lot.group && lot.group !== lot.lotNumber ? lot.group : "",
      kind ? `(${kind})` : "",
      `ważność ${formatPolishDate(lot.expiry, "nieznana")}`,
      availability,
    ].filter(Boolean).join(" · ");
  });
  const counts = new Map();
  for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);
  return lots.map((lot, i) => [lot.id, counts.get(labels[i]) > 1 ? `${labels[i]} · ID ${lot.id}` : labels[i]]);
}
