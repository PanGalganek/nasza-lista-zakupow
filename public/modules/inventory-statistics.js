import { chemicalRegistryNumbers, formatPolishDate } from "../utils.js?v=36";
import { icon } from "./icons.js?v=36";
import { warsawDate } from "./inventory-alerts.js?v=36";
import { matchesInventorySearch } from "./inventory-quantity.js?v=36";
import { productStatistics, statisticsQuantity, statisticsRange } from "./inventory-statistics-data.js?v=36";
import { details, field, input, panel, select } from "./inventory-ui.js?v=36";
import { createElement } from "./ui.js?v=36";

const decimal = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 });
const monthLabel = new Intl.DateTimeFormat("pl-PL", { month: "short", year: "numeric", timeZone: "UTC" });
const insufficient = "Za mało danych do wiarygodnej prognozy";

function statsMetrics(items) {
  const list = createElement("dl", "lab-metrics lab-stat-metrics");
  for (const [label, value] of items) {
    const card = createElement("div", "lab-panel lab-metric");
    card.append(createElement("dt", "", label), createElement("dd", "", value));
    list.append(card);
  }
  return list;
}

function showGroups(groups, valueOf) {
  return groups.map(valueOf).filter((value) => value != null).join(" · ") || "—";
}

function chart(groups, range) {
  const box = panel();
  box.append(createElement("h3", "", "Miesięczny rozchód netto"));
  const data = groups.filter((group) => group.months.length);
  if (!data.length) {
    box.append(createElement("p", "lab-empty", "Brak ewidencji magazynowej w wybranym okresie."));
    return box;
  }
  for (const { dimension, months, first } of data) {
    if (data.length > 1) box.append(createElement("h4", "", dimension));
    if (first > range.from) {
      box.append(createElement("p", "lab-muted", `Początek udokumentowanej ewidencji ${formatPolishDate(first)}.`));
    }
    const bars = createElement("ul", "lab-stat-bars");
    const maximum = Math.max(1, ...months.map((month) => Math.abs(Number(month.outgoing))));
    const hasNegative = months.some((month) => month.outgoing < 0n);
    bars.classList.toggle("lab-stat-signed", hasNegative);
    for (const { month, outgoing } of months) {
      const item = createElement("li", "");
      const amount = createElement("strong", "", statisticsQuantity(outgoing, dimension));
      const plot = createElement("span", "lab-stat-bar-plot");
      plot.setAttribute("aria-hidden", "true");
      // Each bar uses one scale for the entire unit dimension.
      for (const sign of hasNegative ? [1, -1] : [1]) {
        const meter = createElement("progress", sign < 0 ? "lab-stat-negative" : "");
        meter.max = maximum;
        meter.value = Math.max(0, sign * Number(outgoing));
        plot.append(meter);
      }
      item.append(amount, plot, createElement("span", "lab-muted", monthLabel.format(new Date(month + "-01T00:00:00Z"))));
      bars.append(item);
    }
    box.append(bars);
  }
  return box;
}

function forecastSection(groups, unknownStock) {
  const box = panel();
  box.append(createElement("h3", "", "Prognoza zapotrzebowania"));
  const forecasts = groups.filter((group) => group.horizons);
  if (!forecasts.length) {
    box.append(createElement("p", "lab-empty", insufficient));
  }
  for (const group of forecasts) {
    if (groups.length > 1) box.append(createElement("h4", "", group.dimension));
    const amount = (value) => statisticsQuantity(value, group.dimension);
    const list = createElement("div", "lab-stat-forecasts");
    for (const { months, demand, usable } of group.horizons) {
      const card = createElement("div", "lab-data-row lab-stat-forecast");
      const remaining = Math.max(0, demand - usable);
      card.append(createElement("strong", "", `${months} mies.`),
        createElement("p", "", `Potrzeba około ${amount(demand)}`));
      if (group.knownStock) {
        card.append(createElement("p", "lab-muted", `Możliwe do wykorzystania z obecnego zapasu ${amount(usable)}`));
        if (remaining >= 0.5) card.append(createElement("p", "lab-stat-shortage", `Brakuje około ${amount(remaining)}`));
        else card.append(createElement("p", "lab-stat-covered", "Obecny zapas pokrywa prognozę"));
      }
      list.append(card);
    }
    box.append(list);
  }
  if (forecasts.length && (unknownStock || forecasts.some((group) => !group.knownStock))) {
    box.append(createElement("p", "lab-muted", "Porównanie uwzględnia wyłącznie partie o ustalonym stanie."));
  }
  box.append(createElement("p", "lab-muted", "Prognoza wymaga co najmniej dwóch miesięcy ewidencji i rozchodu netto w dwóch różnych miesiącach. Szacunek zakłada stałe tempo i wykorzystanie w pierwszej kolejności zapasów z najbliższym terminem ważności."));
  return box;
}

function historyBreakdown(groups) {
  const box = details("Zestawienie przychodów i rozchodów");
  const interval = select([["month", "Miesiące"], ["year", "Lata"]]);
  const rows = createElement("div", "lab-stack");
  function draw() {
    const periods = new Map();
    for (const { dimension, months } of groups) {
      for (const month of months) {
        const key = interval.value === "year" ? month.month.slice(0, 4) : month.month;
        if (!periods.has(key)) periods.set(key, new Map());
        const totals = periods.get(key);
        const value = totals.get(dimension) || { dimension, incoming: 0n, outgoing: 0n };
        value.incoming += month.incoming;
        value.outgoing += month.outgoing;
        totals.set(dimension, value);
      }
    }
    rows.replaceChildren(...[...periods].sort(([first], [second]) => first.localeCompare(second)).map(([key, totals]) => {
      const row = createElement("div", "lab-data-row");
      const values = [...totals.values()];
      row.append(createElement("strong", "", key.length === 4 ? key : monthLabel.format(new Date(key + "-01T00:00:00Z"))),
        createElement("span", "", `Przychód ${showGroups(values, (group) => statisticsQuantity(group.incoming, group.dimension))} · Rozchód ${showGroups(values, (group) => statisticsQuantity(group.outgoing, group.dimension))}`));
      return row;
    }));
  }
  interval.addEventListener("change", draw);
  box.addEventListener("toggle", () => { if (box.open && !rows.childElementCount) draw(); });
  box.append(field("Zestawienie", interval), rows);
  return box;
}

export function mountInventoryStatistics(inventory) {
  let query = "";
  let selected = "";
  let period = "6";
  let from = "";
  let to = "";
  let method = "";
  let comparisonOpen = false;

  inventory.mount("statistics", (container, _fixedProduct, entering) => {
    if (entering) {
      query = selected = from = to = method = "";
      period = "6";
      comparisonOpen = false;
    }
    const search = input("Szukaj nazwy, LP lub oznaczenia", query, "search");
    search.maxLength = 200;
    search.autocomplete = "off";
    const searchLabel = createElement("label", "lab-search");
    const searchIcon = createElement("span", "lab-icon-slot");
    searchIcon.append(icon("search"));
    searchLabel.append(searchIcon, createElement("span", "sr-only", "Szukaj produktu w statystykach"), search);
    const product = select([]);
    const toolbar = panel();
    toolbar.classList.add("lab-stat-toolbar");
    toolbar.append(searchLabel, field("Pozycja", product));

    const periods = select([["3", "Ostatnie 3 miesiące"], ["6", "Ostatnie 6 miesięcy"], ["12", "Ostatnie 12 miesięcy"],
      ["custom", "Własny zakres dat"]], period);
    const dateFrom = input("Od", from, "date");
    const dateTo = input("Do", to, "date");
    const rangeControls = panel();
    rangeControls.classList.add("lab-fields");
    const customFields = [field("Od", dateFrom), field("Do", dateTo)];
    rangeControls.append(field("Okres analizy", periods), ...customFields);
    const result = createElement("div", "lab-stack");
    container.replaceChildren(toolbar, rangeControls, result);

    function show() {
      rangeControls.hidden = !selected;
      result.replaceChildren();
      if (!selected) {
        const message = createElement("p", "lab-empty", product.disabled && query.trim() ? "Brak pozycji spełniających kryteria."
          : "Wybierz odczynnik lub wzorzec, aby wyświetlić statystyki.");
        message.setAttribute("role", "status");
        result.append(message);
        return;
      }
      const today = warsawDate();
      dateFrom.max = dateTo.max = today;
      for (const control of customFields) control.hidden = period !== "custom";
      const range = statisticsRange(period, today, from, to);
      if (!range) {
        result.append(createElement("p", "lab-empty", "Podaj poprawny zakres kończący się najpóźniej dzisiaj."));
        return;
      }
      if (!inventory.loaded("stock") || !inventory.loaded("events")) {
        const loading = createElement("p", "lab-empty", "Wczytywanie danych magazynowych…");
        loading.setAttribute("role", "status");
        result.append(loading);
        return;
      }
      const { groups, unknownStock } = productStatistics({
        lots: inventory.productLots(selected), events: inventory.rows("events"), calculations: inventory.rows("calculations"),
        matches: (id) => inventory.catalogId(id) === selected, range, today, method,
      });
      const stock = showGroups(groups, (group) => group.knownStock ? statisticsQuantity(group.stock, group.dimension) : null);
      const datedAmount = (group, amount) => group.months.length ? statisticsQuantity(amount, group.dimension) : null;
      const runway = showGroups(groups, (group) => group.knownStock && group.runway != null
        ? `${group.runway > 0 && group.runway < 0.1 ? "< 0,1" : decimal.format(group.runway)} mies.${groups.length > 1 ? " (" + group.dimension + ")" : ""}` : null);
      result.append(statsMetrics([
        ["Aktualny dostępny zapas", stock === "—" && unknownStock ? "Stan nieustalony" : stock],
        ["Całkowity rozchód w okresie", showGroups(groups, (group) => datedAmount(group, group.outgoing))],
        ["Średni rozchód miesięczny", showGroups(groups, (group) => datedAmount(group, group.average))],
        ["Wystarczalność zapasu", runway],
      ]));
      if (unknownStock && stock !== "—") result.append(createElement("p", "lab-muted", "Część ważnych opakowań ma nieustalony stan."));
      result.append(chart(groups, range), forecastSection(groups, unknownStock));

      const comparison = details("Zużycie teoretyczne a rzeczywisty rozchód");
      const methods = inventory.rows("methods");
      const methodSelect = select([["", "Wszystkie metody"], ...methods.map((row) => [row.id, row.name])], method);
      comparison.open = comparisonOpen;
      comparison.addEventListener("toggle", () => { if (comparison.isConnected) comparisonOpen = comparison.open; });
      methodSelect.addEventListener("change", () => {
        method = methodSelect.value;
        comparisonOpen = true;
        show();
        result.querySelector("details select")?.focus();
      });
      comparison.append(field("Metoda badawcza", methodSelect));
      const withTheoretical = groups.filter((group) => group.theoretical !== null);
      if (!withTheoretical.length) {
        comparison.append(createElement("p", "lab-empty", inventory.loaded("calculations")
          ? "Brak zapisanych danych teoretycznych w wybranym okresie." : "Wczytywanie danych teoretycznych…"));
      } else {
        comparison.append(statsMetrics([
          ["Zużycie teoretyczne", showGroups(withTheoretical, (group) => statisticsQuantity(group.theoretical, group.dimension))],
          ["Rzeczywisty rozchód", showGroups(withTheoretical, (group) => datedAmount(group, group.comparisonActual))],
          ["Różnica", showGroups(withTheoretical, (group) => datedAmount(group, group.comparisonActual - group.theoretical))],
        ]));
      }
      result.append(comparison);
      if (groups.some((group) => group.months.length)) result.append(historyBreakdown(groups));
    }

    function filter() {
      const numbers = chemicalRegistryNumbers(inventory.allLots().filter((lot) => ["active", undefined].includes(lot.stock?.status)));
      const term = query.trim();
      const lp = /(?:^|\s)lp\s*(\d+)(?=\s|$)/i.exec(term);
      const words = lp ? term.replace(lp[0], " ") : term;
      const options = [];
      for (const [id, lot] of inventory.catalogProducts()) {
        const lots = inventory.productLots(id);
        if (!lots.some((item) => (!lp || numbers.get(item.id) === Number(lp[1]))
          && matchesInventorySearch(words, item.name, item.group, numbers.get(item.id)))) continue;
        const number = lots.map((item) => numbers.get(item.id)).find(Boolean);
        options.push([id, [lot.name, lot.group, number && `LP ${number}`].filter(Boolean).join(" · ")]);
      }
      options.sort((first, second) => first[1].localeCompare(second[1], "pl"));
      if (!options.some(([id]) => id === selected)) selected = "";
      product.replaceChildren(...select([["", "Wybierz odczynnik lub wzorzec"], ...options]).children);
      product.value = selected;
      product.disabled = !options.length;
      show();
    }
    search.addEventListener("input", () => { query = search.value; selected = ""; comparisonOpen = false; filter(); });
    product.addEventListener("change", () => { selected = product.value; comparisonOpen = false; show(); });
    periods.addEventListener("change", () => {
      period = periods.value;
      if (period === "custom" && !from && !to) {
        const current = statisticsRange("6", warsawDate());
        dateFrom.value = from = current.from;
        dateTo.value = to = current.to;
      }
      show();
    });
    for (const date of [dateFrom, dateTo]) date.addEventListener("change", () => { from = dateFrom.value; to = dateTo.value; show(); });
    for (const key of ["stock", "catalog"]) inventory.onChange(key, filter);
    for (const key of ["events", "calculations", "methods"]) inventory.onChange(key, show);
    filter();
  });
}
