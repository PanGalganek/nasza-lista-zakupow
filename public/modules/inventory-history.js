import { formatLocalDate, formatPolishDate } from "../utils.js?v=18";
import { createElement } from "./ui.js?v=18";
import { formatQuantity, matchesInventorySearch, units, validLots } from "./inventory-quantity.js?v=18";
import { productId } from "./inventory-store.js?v=18";
import { batchLabel, button, details, field, input, panel, saveButton, select, showStock } from "./inventory-ui.js?v=18";

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

function materialRows(events, id = "") {
  return sorted(events).flatMap((event) => Object.entries(event.changes).filter(([, row]) => !id || row.productId === id)
    .map(([lotId, row]) => ({ event, row, lotId })));
}

function addTable(container, rows) {
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
    const values = [dateOf(event)?.toLocaleString("pl-PL") || "Zapisywanie",
      `${row.name} · ${row.number || "bez numeru"} (${lotId})`, operationNames[event.kind],
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
  let historyProduct = "";
  let archiveQuery = "";
  inventory.mount("history", (container, fixedProduct) => {
    const box = panel();
    const events = inventory.rows("events");
    const selected = fixedProduct || historyProduct;
    const results = materialRows(events, selected);
    if (!fixedProduct) {
      container.replaceChildren();
      const product = select([["", "Wszystkie pozycje"], ...inventory.productOptions()], selected);
      product.addEventListener("change", () => { historyProduct = product.value; inventory.refresh(); });
      box.append(field("Karta pozycji", product));
    }
    const totals = { receipt: new Map(), withdrawal: new Map(), retired: new Map() };
    for (const { event, row } of results) {
      const kind = event.kind;
      addTotal(totals.receipt, row.unit, receiptAmount(event, row));
      if (["used", "withdrawn"].includes(kind)) addTotal(totals.retired, row.unit, amountOf(row));
      if (["withdrawal", "preparation", "reversal"].includes(kind)) addTotal(totals.withdrawal, row.unit, kind === "reversal" ? -amountOf(row) : amountOf(row));
    }
    const lots = selected ? inventory.lotsFor(selected) : [];
    const values = [["Przychód netto", totalsText(totals.receipt)], ["Rozchód netto", totalsText(totals.withdrawal)], ["Wyksięgowano", totalsText(totals.retired)]];
    if (selected) values.push(["Dostępny zapas", availability(lots)]);
    box.append(metrics(values));
    for (const lot of lots) {
      const row = createElement("div", "lab-data-row");
      row.append(createElement("p", "", batchLabel(lot)), showStock(lot));
      box.append(row);
    }
    box.append(createElement("h3", "", "Historia operacji"));
    if (results.length) addTable(box, results);
    else box.append(createElement("p", "lab-empty", "Brak operacji magazynowych."));
    const reversals = new Set(events.filter((event) => event.kind === "reversal").map((event) => event.details.originalId));
    const candidates = sorted(events).filter((event) => ["preparation", "withdrawal"].includes(event.kind) && !reversals.has(event.id)
      && (!selected || Object.values(event.changes).some((row) => row.productId === selected)));
    if (candidates.length) {
      const corrections = details("Cofanie zarejestrowanej operacji");
      for (const event of candidates) {
        const line = createElement("div", "mt-2 flex flex-wrap items-center gap-2 text-sm");
        const status = createElement("span", "text-xs text-red-700");
        line.append(createElement("span", "", `${dateOf(event)?.toLocaleString("pl-PL") || "—"} · ${event.details.recipeName || Object.values(event.changes)[0].name}`),
          saveButton("Cofnij operację", async () => {
            if (confirm("Czy zapisać korektę przywracającą zapas?")) {
              await inventory.store.reverse(event.id);
              status.textContent = "Zapisano korektę.";
            }
          }, status), status);
        corrections.append(line);
      }
      box.append(corrections);
    }
    if (!selected) {
      const preparations = details("Historia przygotowania roztworów");
      for (const event of sorted(events).filter((entry) => entry.kind === "preparation")) {
        text(preparations, `${dateOf(event)?.toLocaleString("pl-PL") || "—"} · ${event.details.recipeName} · ${event.details.volume} ml${reversals.has(event.id) ? " · cofnięto" : ""}`);
      }
      box.append(preparations);
    }
    container.append(box);
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
        addTable(item, materialRows(inventory.rows("events"), productId(lot)).filter((entry) => entry.lotId === lot.id));
        list.append(item);
      }
      if (!list.childElementCount) list.append(createElement("p", "lab-empty", "Brak zamkniętych partii spełniających kryteria."));
    };
    search.addEventListener("input", () => { archiveQuery = search.value; draw(); });
    draw();
  });
}

export function mountInventoryStatistics(inventory) {
  inventory.mount("statistics", (container) => {
    container.replaceChildren();
    const box = panel();
    const result = createElement("div", "lab-list");
    const product = select([["", "Wszystkie pozycje"], ...inventory.productOptions()]);
    const category = select([["", "Odczynniki i wzorce"], ["Odczynniki", "Odczynniki"], ["Wzorce", "Wzorce"]]);
    const method = select([["", "Wszystkie metody"], ...inventory.rows("methods").map((row) => [row.id, row.name])]);
    const from = input("Od", `${new Date().getFullYear()}-01-01`, "date");
    const to = input("Do", formatLocalDate(), "date");
    const interval = select([["month", "Miesiące"], ["year", "Lata"]]);
    const forecast = input("Miesiące prognozy", 3, "number");
    const display = () => {
      result.replaceChildren();
      if (!from.value || !to.value || from.value > to.value) { text(result, "Wybierz prawidłowy okres."); return; }
      const days = Math.round((Date.parse(to.value) - Date.parse(from.value)) / 86400000) + 1;
      const products = new Map(inventory.products());
      const belongs = (id) => !category.value || (products.get(id)?.category === "Odczynniki" ? "Odczynniki" : "Wzorce") === category.value;
      const periods = new Map();
      const actual = new Map();
      const theoretical = new Map();
      const differences = new Map();
      const buckets = (key) => {
        if (!periods.has(key)) periods.set(key, { in: new Map(), out: new Map(), retired: new Map() });
        return periods.get(key);
      };
      for (const { event, row } of materialRows(inventory.rows("events"), product.value)) {
        const date = dateOf(event) && formatLocalDate(dateOf(event));
        const original = event.kind === "reversal" ? inventory.rows("events").find((entry) => entry.id === event.details.originalId) : event;
        if (!date || date < from.value || date > to.value || !belongs(row.productId)
          || (method.value && original?.details.methodId !== method.value)) continue;
        const entry = buckets(date.slice(0, interval.value === "year" ? 4 : 7));
        addTotal(entry.in, row.unit, receiptAmount(event, row));
        if (["used", "withdrawn"].includes(event.kind)) addTotal(entry.retired, row.unit, amountOf(row));
        if (["preparation", "withdrawal", "reversal"].includes(event.kind)) {
          const amount = event.kind === "reversal" ? -amountOf(row) : amountOf(row);
          addTotal(entry.out, row.unit, amount);
          addTotal(actual, row.unit, amount);
          addTotal(differences, row.unit, amount);
        }
      }
      for (const record of inventory.rows("calculations")) {
        const date = record.date;
        if (date < from.value || date > to.value || (method.value && record.methodId !== method.value)) continue;
        for (const row of record.commercial || []) {
          if (!row.productId || (product.value && row.productId !== product.value) || !belongs(row.productId)) continue;
          addTotal(theoretical, row.unit, row.quantity);
          addTotal(differences, row.unit, -row.quantity);
        }
      }
      result.append(metrics([["Zużycie teoretyczne", totalsText(theoretical)], ["Rzeczywisty rozchód", totalsText(actual)], ["Różnica", totalsText(differences)]]));
      for (const [period, entry] of [...periods].sort()) {
        const row = createElement("div", "lab-data-row");
        row.append(createElement("strong", "", period), createElement("span", "", `Przychód ${totalsText(entry.in)} · Rozchód ${totalsText(entry.out)} · Wycofano ${totalsText(entry.retired)}`));
        result.append(row);
      }
      if (!periods.size) result.append(createElement("p", "lab-empty", "Brak operacji w wybranym okresie."));
      const divisor = BigInt(days);
      const months = BigInt(Math.floor(Math.max(1, Math.min(24, Number(forecast.value) || 1))));
      const extrapolate = (factor) => new Map([...actual].map(([key, entry]) => [key, {
        ...entry, amount: ((entry.amount > 0n ? entry.amount : 0n) * 30n * factor + divisor / 2n) / divisor,
      }]));
      const monthly = extrapolate(1n);
      const projected = extrapolate(months);
      result.append(metrics([["Średnio na 30 dni", totalsText(monthly)], ["Orientacyjna prognoza", totalsText(projected)]]));
    };
    box.classList.add("lab-fields");
    box.append(field("Pozycja", product), field("Typ pozycji", category), field("Metoda", method), field("Od", from), field("Do", to),
      field("Zestawienie", interval), field("Miesiące prognozy (1–24)", forecast), button("Przelicz", display, "lab-button-primary"));
    container.append(box, result);
    display();
    inventory.onChange("events", display);
    inventory.onChange("calculations", display);
  });
}
