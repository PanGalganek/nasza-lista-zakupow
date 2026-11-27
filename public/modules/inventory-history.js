import { chemicalRegistryNumbers, formatLocalDate, formatPolishDate } from "../utils.js?v=32";
import { icon } from "./icons.js?v=32";
import { createElement } from "./ui.js?v=32";
import { formatQuantity, matchesInventorySearch, units, validLots } from "./inventory-quantity.js?v=32";
import { productId } from "./inventory-store.js?v=32";
import { batchLabel, details, field, input, panel, saveButton, select, showStock } from "./inventory-ui.js?v=32";
import { lotDescription } from "./inventory-items.js?v=32";

const operationNames = {
  receipt: "Przychód", opening: "Ustalenie stanu", opening_correction: "Korekta ilości początkowej", withdrawal: "Rozchód", preparation: "Przygotowanie",
  used: "Zamknięcie zużytej partii", withdrawn: "Wycofanie", reversal: "Korekta",
};
const text = (node, value) => node.append(createElement("p", "text-sm", value));
const dateOf = (event) => event.createdAt?.toDate?.();
const sorted = (events) => [...events].sort((a, b) => (dateOf(b)?.getTime() || 0) - (dateOf(a)?.getTime() || 0));
const amountOf = (entry) => entry.before === null ? null : Math.abs(entry.after - entry.before);
const receiptAmount = (event, row) => event.kind === "receipt" || (event.kind === "opening_correction" && event.details.sourceKind === "receipt")
  ? row.after - row.before : null;
const openingAmount = (event, row) => event.kind === "opening" ? row.initial
  : event.kind === "opening_correction" && event.details.sourceKind === "opening" ? row.after - row.before : null;

export function outgoingAmount(event, row) {
  if (!["used", "withdrawn", "withdrawal", "preparation", "reversal"].includes(event.kind) || row.before === null) return null;
  return row.before - row.after;
}

function addTotal(totals, unit, amount) {
  if (amount === null || !units[unit]) return;
  const kind = units[unit][0];
  const bucket = totals.get(kind) || { amount: 0n, unit };
  bucket.amount += BigInt(amount);
  totals.set(kind, bucket);
}

export const totalsText = (totals) => [...totals.values()].map(({ amount, unit }) => formatQuantity(amount, unit)).join(" · ") || "—";

export function availability(lots, today = formatLocalDate()) {
  const totals = new Map();
  for (const lot of lots) {
    if (lot.stock && validLots([lot], lot.stock.unit, today).length) addTotal(totals, lot.stock.unit, lot.stock.balance);
  }
  return totalsText(totals);
}

function materialRows(events, matches = () => true) {
  return sorted(events).flatMap((event) => Object.entries(event.changes).filter(([, row]) => matches(row.productId))
    .map(([lotId, row]) => ({ event, row, lotId })));
}

function addTable(container, rows, lots) {
  const table = createElement("table", "lab-history-table");
  const labels = ["Data i godzina", "Odczynnik / nr partii", "Rodzaj", "Ilość", "Stan po operacji", "Receptura"];
  const header = createElement("tr");
  for (const label of labels) {
    const cell = createElement("th", "", label);
    cell.scope = "col";
    header.append(cell);
  }
  const head = createElement("thead");
  head.append(header);
  table.append(head);
  const body = createElement("tbody");
  for (const { event, row, lotId } of rows) {
    const tr = createElement("tr");
    const amount = event.kind === "opening" ? row.initial : amountOf(row);
    const quantityText = event.kind === "opening_correction" ? `${formatQuantity(row.before, row.unit)} → ${formatQuantity(row.after, row.unit)}`
      : amount === null ? "Stan nieustalony" : formatQuantity(amount, row.unit);
    const lot = lots.get(lotId);
    const values = [dateOf(event)?.toLocaleString("pl-PL") || "Zapisywanie",
      `${row.name} · ${lot ? lotDescription({ ...lot, lotNumber: row.number || lot.lotNumber }) : row.number || "Partia bez numeru"}`, operationNames[event.kind],
      quantityText,
      row.after === null ? "Stan nieustalony" : formatQuantity(row.after, row.unit), event.details.recipeName || ""];
    values.forEach((value, index) => {
      const cell = createElement("td", "", value || "—");
      cell.dataset.label = labels[index];
      tr.append(cell);
    });
    body.append(tr);
  }
  table.append(body);
  container.append(table);
}

function metrics(values) {
  const list = createElement("dl", "lab-metrics");
  for (const [label, value] of values) {
    const item = createElement("div", "lab-panel lab-metric");
    item.append(createElement("dt", "", label), createElement("dd", "", value));
    list.append(item);
  }
  return list;
}

export function mountInventoryHistory(inventory) {
  const allProducts = "*";
  let historyProduct = "";
  let historyQuery = "";
  let archiveQuery = "";
  const openedHistory = new Set();

  function renderHistory(container, selected, opened = new Set()) {
    inventory.ensureHistory();
    const box = panel();
    const events = inventory.rows("events");
    const all = selected === allProducts;
    const matches = (id) => all || inventory.catalogId(id) === selected;
    const matchesEvent = (event) => Object.values(event.changes).some((row) => matches(row.productId));
    const results = materialRows(events, matches);
    const totals = { receipt: new Map(), withdrawal: new Map(), opening: new Map(), balance: new Map() };
    for (const { event, row } of results) {
      addTotal(totals.receipt, row.unit, receiptAmount(event, row));
      addTotal(totals.withdrawal, row.unit, outgoingAmount(event, row));
      addTotal(totals.opening, row.unit, openingAmount(event, row));
    }
    const lots = all ? inventory.allLots() : inventory.productLots(selected);
    for (const { stock } of lots) if (stock) addTotal(totals.balance, stock.unit, stock.balance);
    const values = [["Przychód netto", totalsText(totals.receipt)], ["Rozchód netto", totalsText(totals.withdrawal)],
      ["Stan magazynowy", totalsText(totals.balance)]];
    if (totals.opening.size) values.push(["Stan początkowy starszych partii", totalsText(totals.opening)]);
    box.append(metrics(values));
    for (const lot of all ? [] : lots) {
      const row = createElement("div", "lab-data-row");
      row.append(createElement("p", "", lotDescription(lot)), showStock(lot));
      box.append(row);
    }
    const byId = new Map(lots.map((lot) => [lot.id, lot]));
    const reversals = new Set(events.filter((event) => event.kind === "reversal").map((event) => event.details.originalId));
    const candidates = sorted(events).filter((event) => ["preparation", "withdrawal"].includes(event.kind) && !reversals.has(event.id)
      && (all || matchesEvent(event)));
    function appendHistory(key, label, count, draw) {
      const group = details(`${label} (${count})`);
      let rendered = false;
      const update = () => {
        if (group.open) {
          opened.add(key);
          if (!rendered) { draw(group); rendered = true; }
        } else opened.delete(key);
      };
      group.open = opened.has(key);
      if (group.open) update();
      group.addEventListener("toggle", update);
      box.append(group);
    }
    appendHistory("operations", "Historia operacji", results.length, (group) => {
      if (results.length) addTable(group, results, byId);
      else group.append(createElement("p", "lab-empty", "Brak operacji magazynowych."));
      if (!candidates.length) return;
      const corrections = details("Cofanie zarejestrowanej operacji");
      for (const event of candidates) {
        const line = createElement("div", "mt-2 flex flex-wrap items-center gap-2 text-sm");
        const status = createElement("span", "text-xs text-red-700");
        line.append(createElement("span", "", `${dateOf(event)?.toLocaleString("pl-PL") || "—"} · ${event.details.recipeName || Object.values(event.changes)[0]?.name}`),
          saveButton("Cofnij operację", async () => {
            if (confirm("Czy zapisać korektę przywracającą zapas?")) {
              await inventory.store.reverse(event.id);
              status.textContent = "Zapisano korektę.";
            }
          }, status), status);
        corrections.append(line);
      }
      group.append(corrections);
    });
    const preparations = sorted(events).filter((event) => event.kind === "preparation" && (all || matchesEvent(event)));
    appendHistory("preparations", "Historia przygotowania roztworów", preparations.length, (group) => {
      if (!preparations.length) text(group, "Brak przygotowań dla wybranych pozycji.");
      for (const event of preparations)
        text(group, `${dateOf(event)?.toLocaleString("pl-PL") || "—"} · ${event.details.recipeName} · ${event.details.volume} ml${reversals.has(event.id) ? " · cofnięto" : ""}`);
    });
    container.append(box);
  }

  inventory.mount("history", (container, fixedProduct, entering) => {
    if (fixedProduct) return renderHistory(container, inventory.catalogId(fixedProduct));
    if (entering) {
      historyProduct = "";
      historyQuery = "";
      openedHistory.clear();
    }

    const lots = inventory.allLots();
    const numbers = chemicalRegistryNumbers(lots.filter((lot) => ["active", undefined].includes(lot.stock?.status)));
    const entries = inventory.catalogProducts().map(([id, product]) => ({
      id,
      label: batchLabel(product),
      lots: inventory.productLots(id),
    }));
    const search = input("Szukaj nazwy, LP lub partii", historyQuery, "search");
    search.maxLength = 200;
    search.autocomplete = "off";
    const searchLabel = createElement("label", "lab-search");
    const searchIcon = createElement("span", "lab-icon-slot");
    searchIcon.append(icon("search"));
    searchLabel.append(searchIcon, createElement("span", "sr-only", "Szukaj w przychodach i rozchodach"), search);
    const toolbar = panel();
    const product = select([]);
    const results = createElement("div", "lab-stack");
    toolbar.append(searchLabel, field("Karta pozycji", product));
    container.replaceChildren(toolbar, results);

    const show = (matches) => {
      results.replaceChildren();
      if (!historyProduct) {
        const empty = createElement("p", "lab-empty", matches
          ? "Wybierz odczynnik lub wzorzec, aby wyświetlić kartę magazynową" : "Brak pozycji spełniających kryteria.");
        empty.setAttribute("role", "status");
        results.append(empty);
      } else renderHistory(results, historyProduct, openedHistory);
    };
    let matchCount;
    function filterProducts(autoSelect = true) {
      const query = historyQuery.trim();
      const lp = /(?:^|\s)lp\s*(\d+)(?=\s|$)/i.exec(query);
      const searchText = lp ? query.replace(lp[0], " ") : query;
      const matches = entries.filter((entry) => entry.lots.some((lot) =>
        (!lp || numbers.get(lot.id) === Number(lp[1]))
        && matchesInventorySearch(searchText, entry.label, lot.name, lot.group, lot.lotNumber, numbers.get(lot.id))));
      matchCount = matches.length;
      if (query && !matches.some(({ id }) => id === historyProduct)) historyProduct = "";
      if (autoSelect && query && matches.length === 1) historyProduct = matches[0].id;
      const options = [["", "Wybierz pozycję"], ...(!query ? [[allProducts, "Wszystkie pozycje"]] : []),
        ...matches.map(({ id, label }) => [id, label])];
      product.replaceChildren(...select(options).children);
      product.value = historyProduct;
      product.disabled = !matchCount;
      show(matchCount);
    }
    search.addEventListener("input", () => { historyQuery = search.value; historyProduct = ""; openedHistory.clear(); filterProducts(); });
    product.addEventListener("change", () => { historyProduct = product.value; openedHistory.clear(); show(matchCount); });
    filterProducts(false);
  });

  inventory.mount("archive", (container) => {
    const search = input("Nazwa, oznaczenie lub partia", archiveQuery, "search");
    const list = createElement("div", "lab-list");
    container.replaceChildren(field("Szukaj w archiwum", search), list);
    const archive = inventory.allLots().filter((lot) => lot.stock && lot.stock.status !== "active");
    const opened = new Set();
    const draw = () => {
      list.replaceChildren();
      for (const lot of archive) {
        if (!matchesInventorySearch(archiveQuery, lot.name, lot.group, lot.lotNumber, lot.producer)) continue;
        const item = details(`${batchLabel(lot)} · ${lot.stock.status === "used" ? "Zużyta" : "Wycofana"}`);
        item.open = opened.has(lot.id);
        item.addEventListener("toggle", () => item.open ? opened.add(lot.id) : opened.delete(lot.id));
        text(item, `Termin ważności ${formatPolishDate(lot.expiry)}`);
        item.append(showStock(lot));
        addTable(item, materialRows(inventory.rows("events"), (id) => id === productId(lot))
          .filter((entry) => entry.lotId === lot.id), new Map([[lot.id, lot]]));
        list.append(item);
      }
      if (!list.childElementCount) list.append(createElement("p", "lab-empty", "Brak zamkniętych partii spełniających kryteria."));
    };
    search.addEventListener("input", () => { archiveQuery = search.value; draw(); });
    draw();
  });
}
