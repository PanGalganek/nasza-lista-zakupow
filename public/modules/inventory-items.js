import { chemicalCategory, formatPolishDate } from "../utils.js?v=23";
import { formatQuantity, normalizeInventorySearch } from "./inventory-quantity.js?v=23";

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
