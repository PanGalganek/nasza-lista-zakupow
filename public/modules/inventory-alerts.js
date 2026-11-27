import { calculateCalendarDays, formatPolishDate, groupChemicalItems, parseLocalDate } from "../utils.js?v=32";
import { createButton, createElement } from "./ui.js?v=32";
import { stockLevel } from "./inventory-quantity.js?v=32";
import { productId } from "./inventory-store.js?v=32";
import { indexCatalog, orderItemKey, standardKind } from "./inventory-items.js?v=32";
import { batchLabel, button, details, orderBadge } from "./inventory-ui.js?v=32";

const categories = [
  ["expired", "Przekroczony termin ważności"],
  ["expiring", "Kończący się termin ważności"],
  ["low", "Niski stan magazynowy"],
  ["warning", "Ostrzegawczy stan magazynowy"],
];

const warsawCalendar = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" });
export const warsawDate = (now = new Date()) => warsawCalendar.format(now);
const backupLabel = (part) => `${part.lotNumber || part.group || "bez numeru"} · ${part.expiry ? `ważna do ${formatPolishDate(part.expiry)}` : "brak terminu ważności"}`;

export function expiryDaysLabel(days) {
  const amount = Math.abs(days);
  const duration = `${amount} ${amount === 1 ? "dzień" : "dni"}`;
  if (days === 0) return "Termin upływa dzisiaj";
  return days < 0 ? `Po terminie o ${duration}` : `Pozostało ${duration}`;
}

export function warningGroups(lots, threshold, today = new Date()) {
  const result = Object.fromEntries(categories.map(([key]) => [key, []]));
  const legacy = groupChemicalItems(lots.filter((lot) => !lot.productId && !lot.stock));
  const legacyById = new Map(legacy.flatMap((group) => group.items.map((lot) => [lot.id, group.items])));
  const byProduct = new Map();
  const catalog = indexCatalog(lots);
  const daysLeft = new Map();
  const current = warsawDate(today);
  const calendarDay = parseLocalDate(current);
  for (const lot of lots) {
    const id = catalog.aliases.get(productId(lot)) || productId(lot);
    if (!byProduct.has(id)) byProduct.set(id, []);
    byProduct.get(id).push(lot);
    daysLeft.set(lot.id, calculateCalendarDays(calendarDay, parseLocalDate(lot.expiry)));
  }
  for (const lot of lots) {
    const cutoff = typeof threshold === "function" ? threshold(lot) : threshold;
    const days = daysLeft.get(lot.id);
    const level = stockLevel(lot.stock);
    const canonical = catalog.aliases.get(productId(lot));
    const candidates = lot.productId || lot.stock || canonical
      ? byProduct.get(canonical || productId(lot))
      : legacyById.get(lot.id) || [];
    const validAlternatives = candidates.filter((other) => other.id !== lot.id && standardKind(other) === standardKind(lot)
      && (other.category === "Odczynniki") === (lot.category === "Odczynniki")
      && (!other.expiry || (daysLeft.get(other.id) !== null && other.expiry >= current))
      && (!other.stock || (other.stock.status === "active" && other.stock.balance > 0)));
    const later = validAlternatives.filter((other) => daysLeft.get(other.id) > cutoff);
    const expiryBackup = later.find((other) => other.stock?.balance > 0);
    const possibleBackup = later.find((other) => !other.stock);
    const stockBackup = validAlternatives.find((other) => other.stock?.balance > 0);
    if (days !== null && days < 0) result.expired.push({ lot, days, backup: expiryBackup, possibleBackup, otherBackup: stockBackup, retire: true });
    else if (days !== null && days <= cutoff) result.expiring.push({ lot, days, backup: expiryBackup, possibleBackup, otherBackup: stockBackup });
    if (level?.color === "red") result.low.push({ lot, backup: stockBackup, retire: lot.stock.balance === 0 });
    if (level?.color === "yellow") result.warning.push({ lot, backup: stockBackup });
  }
  for (const group of [result.expired, result.expiring]) group.sort((a, b) => a.days - b.days);
  return result;
}

export function renderInventoryAlerts(container, lots, threshold, inventory, newLot, lpByItem, openPosition) {
  const open = new Map([...container.children].map((element) => [element.dataset.warning, element.open]));
  const result = warningGroups(lots, threshold);
  container.replaceChildren();
  const total = Object.values(result).reduce((sum, items) => sum + items.length, 0);
  for (const number of document.querySelectorAll("[data-warning-number]")) number.textContent = String(total);
  document.querySelector("[data-warning-count]").hidden = total === 0;
  if (!total) container.append(createElement("p", "lab-empty", "Brak ostrzeżeń."));
  const checked = new Map();
  const sync = () => {
    for (const [key, inputs] of checked) {
      for (const [input, lotId] of inputs) input.checked = inventory.orderSelections.get(key) === lotId;
    }
  };
  for (const [key, label] of categories) {
    const items = result[key];
    if (!items.length) continue;
    const section = details(`${label} (${items.length})`);
    section.classList.add("lab-alert-category");
    section.dataset.warning = key;
    section.open = open.get(key) ?? container.parentElement?.id === "warningScreen";
    section.append(button("Zaznacz wszystkie", () => {
      for (const { lot } of items) {
        const itemKey = orderItemKey(lot);
        if (!inventory.orderSelections.has(itemKey)) inventory.orderSelections.set(itemKey, lot.id);
      }
      sync();
    }));
    for (const { lot, days, backup, possibleBackup, otherBackup, retire } of items) {
      const itemKey = orderItemKey(lot);
      const row = createElement("div", "lab-alert-row");
      const checkbox = createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = inventory.orderSelections.get(itemKey) === lot.id;
      checkbox.setAttribute("aria-label", `Dodaj do zamówienia: ${batchLabel(lot)}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) inventory.orderSelections.set(itemKey, lot.id);
        else if (inventory.orderSelections.get(itemKey) === lot.id) inventory.orderSelections.delete(itemKey);
        sync();
      });
      if (!checked.has(itemKey)) checked.set(itemKey, []);
      checked.get(itemKey).push([checkbox, lot.id]);
      const availability = backup
        ? `Partia zapasowa ${backupLabel(backup)}`
        : possibleBackup ? "Możliwa partia zapasowa. Ustal jej stan i sprawdź potrzebę zakupu." : "";
      const state = inventory.orderStatus(lot);
      const purchase = availability || (state.state === "idle" ? "Sprawdź potrzebę zakupu" : "");
      const body = createElement("span", "lab-alert-info");
      if (days !== undefined) {
        const name = createElement("strong", "", `LP ${lpByItem.get(lot.id)} · ${batchLabel(lot)}`);
        body.append(name, createElement("span", "", `Ważność do ${formatPolishDate(lot.expiry)} · ${expiryDaysLabel(days)}`));
      } else body.append(createElement("strong", "", batchLabel(lot)));
      const action = [retire ? "Zamknij lub wycofaj partię" : "", purchase].filter(Boolean).join(" · ");
      if (action) body.append(createElement("span", "lab-muted", action));
      if (otherBackup && !backup) body.append(createElement("span", "lab-muted", `Dostępna inna partia ${backupLabel(otherBackup)}`));
      body.append(orderBadge(state, null, { showStatusText: true }));
      const actions = createElement("div", "lab-alert-actions");
      actions.append(
        createButton("Nowa partia", `Nowa partia: ${lot.group || lot.name}`, () => newLot(lot), "lab-button"),
        createButton("Otwórz pozycję", `Otwórz pozycję: ${batchLabel(lot)}`, () => openPosition(lot), "lab-button"),
      );
      row.append(checkbox, body, actions);
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
