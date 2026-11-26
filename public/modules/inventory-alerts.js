import { calculateCalendarDays, formatLocalDate, formatPolishDate, groupChemicalItems, parseLocalDate } from "../utils.js?v=17";
import { createButton, createElement } from "./ui.js?v=17";
import { stockLevel } from "./inventory-quantity.js?v=17";
import { productId } from "./inventory-store.js?v=17";
import { batchLabel, button, details } from "./inventory-ui.js?v=17";

const categories = [
  ["expired", "Przekroczony termin ważności"],
  ["expiring", "Kończący się termin ważności"],
  ["low", "Niski stan magazynowy"],
  ["warning", "Ostrzegawczy stan magazynowy"],
];

export function warningGroups(lots, threshold, today = new Date()) {
  const result = Object.fromEntries(categories.map(([key]) => [key, []]));
  const legacy = groupChemicalItems(lots.filter((lot) => !lot.productId && !lot.stock));
  const legacyById = new Map(legacy.flatMap((group) => group.items.map((lot) => [lot.id, group.items])));
  const byProduct = new Map();
  const daysLeft = new Map();
  const current = formatLocalDate(today);
  for (const lot of lots) {
    const id = productId(lot);
    if (!byProduct.has(id)) byProduct.set(id, []);
    byProduct.get(id).push(lot);
    daysLeft.set(lot.id, calculateCalendarDays(today, parseLocalDate(lot.expiry)));
  }
  for (const lot of lots) {
    const cutoff = typeof threshold === "function" ? threshold(lot) : threshold;
    const days = daysLeft.get(lot.id);
    const level = stockLevel(lot.stock);
    const candidates = lot.productId || lot.stock
      ? byProduct.get(productId(lot))
      : legacyById.get(lot.id) || [];
    const validAlternatives = candidates.filter((other) => other.id !== lot.id && (other.category === "Odczynniki") === (lot.category === "Odczynniki")
      && (!other.expiry || (daysLeft.get(other.id) !== null && other.expiry >= current))
      && (!other.stock || (other.stock.status === "active" && other.stock.balance > 0)));
    const later = validAlternatives.filter((other) => daysLeft.get(other.id) > cutoff);
    const expiryBackup = later.find((other) => other.stock?.balance > 0);
    const possibleBackup = later.find((other) => !other.stock);
    const stockBackup = validAlternatives.find((other) => other.stock?.balance > 0);
    if (days !== null && days < 0) result.expired.push({ lot, backup: expiryBackup, possibleBackup, retire: true });
    else if (days !== null && days <= cutoff) result.expiring.push({ lot, backup: expiryBackup, possibleBackup });
    if (level?.color === "red") result.low.push({ lot, backup: stockBackup, retire: lot.stock.balance === 0 });
    if (level?.color === "yellow") result.warning.push({ lot, backup: stockBackup });
  }
  return result;
}

export function renderInventoryAlerts(container, lots, threshold, inventory, edit) {
  const open = new Set([...container.children].filter((element) => element.open).map((element) => element.dataset.warning));
  const result = warningGroups(lots, threshold);
  container.replaceChildren();
  const total = Object.values(result).reduce((sum, items) => sum + items.length, 0);
  for (const number of document.querySelectorAll("[data-warning-number]")) number.textContent = String(total);
  document.querySelector("[data-warning-count]").hidden = total === 0;
  if (!total) container.append(createElement("p", "lab-empty", "Brak ostrzeżeń."));
  const checked = new Map();
  const sync = () => {
    for (const [id, inputs] of checked) for (const input of inputs) input.checked = inventory.orderSelections.has(id);
  };
  for (const [key, label] of categories) {
    const items = result[key];
    if (!items.length) continue;
    const section = details(`${label} (${items.length})`);
    section.classList.add("lab-alert-category");
    section.dataset.warning = key;
    section.open = open.has(key);
    section.append(button("Zaznacz wszystkie", () => {
      items.forEach(({ lot }) => inventory.orderSelections.add(productId(lot)));
      sync();
    }));
    for (const { lot, backup, possibleBackup, retire } of items) {
      const id = productId(lot);
      const row = createElement("div", "lab-alert-row");
      const checkbox = createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = inventory.orderSelections.has(id);
      checkbox.setAttribute("aria-label", `Dodaj do zamówienia: ${batchLabel(lot)}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) inventory.orderSelections.add(id);
        else inventory.orderSelections.delete(id);
        sync();
      });
      if (!checked.has(id)) checked.set(id, []);
      checked.get(id).push(checkbox);
      const purchase = lot.ordered ? "Zamówiono" : backup
        ? `Partia zapasowa ${backup.lotNumber || backup.group || ""} · ${backup.expiry ? `ważna do ${formatPolishDate(backup.expiry)}` : "brak terminu ważności"}`
        : possibleBackup ? "Możliwa partia zapasowa. Ustal jej stan i sprawdź potrzebę zakupu." : "Sprawdź potrzebę zakupu";
      row.append(checkbox, createElement("span", "flex-1", `${batchLabel(lot)} · ${retire ? "Zamknij lub wycofaj partię · " : ""}${purchase}`),
        createButton("Edytuj", `Edytuj pozycję ${lot.group || lot.name}`, () => edit(lot), "lab-button"));
      section.append(row);
    }
    container.append(section);
  }
  if (total) {
    const orders = createElement("button", "lab-button", "Przejdź do zamówień");
    orders.type = "button";
    orders.dataset.route = "inventory/orders";
    container.append(orders);
  }
  container.classList.remove("hidden");
}
