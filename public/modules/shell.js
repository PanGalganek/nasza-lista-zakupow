import { icon, fillIcons } from "./icons.js?v=38.1";
import { byId, createElement } from "./ui.js?v=38.1";

const top = [
  ["inventory", "Odczynniki i wzorce", "Rejestr, magazyn i receptury", "flask", "blue", "Odczynniki"],
  ["water", "Woda", "Harmonogram i kontrola badań", "drop", "cyan", "Woda"],
  ["waste", "Ścieki", "Harmonogram i kontrola badań", "waves", "teal", "Scieki"],
  ["equipment", "Sprzęt laboratoryjny", "Wzorcowania, sprawdzenia i kalibracje", "equipment", "violet", "Wzorcowanie"],
  ["calendar", "Kalendarz", "Harmonogram i nadchodzące terminy", "calendar", "slate", "Kalendarz"],
];

const stock = [
  ["chemicals", "Odczynniki", "Pozycje, partie i stan magazynowy", "bottle", "blue", "registry"],
  ["standards", "Wzorce", "Rejestr i ważność partii", "target", "cyan", "registry"],
  ["preparation", "Przygotowanie roztworów", "Metody, składniki i objętości", "tubes", "blue", "preparation"],
  ["recipes", "Baza receptur", "Receptury i metody badawcze", "book", "violet", "recipes"],
  ["history", "Przychody i rozchody", "Karty i historia operacji", "arrows", "slate", "history"],
  ["theory", "Zużycie teoretyczne", "Kalkulator według oznaczeń", "calc", "cyan", "theory"],
  ["orders", "Zamówienia", "Lista zakupów i eksport do Worda", "cart", "blue", "orders"],
  ["statistics", "Statystyki", "Podsumowania i prognozy", "chart", "teal", "statistics"],
  ["archive", "Archiwum", "Zamknięte i wycofane partie", "archive", "slate", "archive"],
];

const work = [
  ["Archiwalna", "Próba archiwalna", "Kontrola i harmonogram prób", "archive", "slate"],
  ["Slepa", "Próba ślepa", "Harmonogram prób ślepych", "flask", "blue"],
  ["Probkobranie", "Próbkobranie", "Miejsca i terminy pobrania", "drop", "cyan"],
  ["Porownania", "Porównanie wewnątrzlaboratoryjne", "Parametry i wykonanie", "arrows", "violet"],
];

export const routes = new Map([
  ["home", { title: "e-Laboratorium", screen: "home" }],
  ["alerts", { title: "Centrum ostrzeżeń", screen: "alerts" }],
]);
for (const [route, title, description, symbol, tone, screen] of top) {
  routes.set(route, { title, description, symbol, tone, screen });
}
for (const [key, title, description, symbol, tone, section] of stock) {
  routes.set("inventory/" + key, { title, description, symbol, tone, screen: "Odczynniki", section });
}
for (const [key, title] of [["registry","Rejestr sprzętu"],["schedule","Harmonogram sprzętu"],["execution","Realizacja harmonogramu"],["history","Historia sprzętu"]]) {
  routes.set("equipment/" + key, { title, screen: "Wzorcowanie" });
}
for (const [key, title, description, symbol, tone] of work) {
  routes.set("waste/" + key, { title, description, symbol, tone, screen: "Scieki", lab: "scieki", category: key });
}
// Keep old Water bookmarks working with the method view.
for (const key of ["Archiwalna", "Slepa", "Porownania", "Probkobranie", "Granice"]) {
  routes.set("water/" + key, routes.get("water"));
}

function routeButton(route, className) {
  const { title, description, symbol, tone } = routes.get(route);
  const control = createElement("button", className);
  control.type = "button";
  control.dataset.route = route;
  if (tone) control.dataset.tone = tone;
  if (className === "lab-side-link") {
    control.append(icon(symbol || "home"), createElement("span", "", route === "home" ? "Pulpit" : title));
  } else {
    const badge = createElement("span", "lab-tile-icon");
    badge.append(icon(symbol));
    const arrow = createElement("span", "lab-tile-arrow");
    arrow.append(icon("chevron"));
    control.append(badge, createElement("span", "lab-tile-title", title), createElement("span", "lab-tile-description", description), arrow);
  }
  return control;
}

export function buildShell() {
  fillIcons();
  byId("labSidebar").append(...["home", ...top.map(([route]) => route)].map((key) => routeButton(key, "lab-side-link")));
  byId("homeTiles").append(...top.map(([route]) => routeButton(route, "lab-tile lab-tile-main")));
  byId("inventoryNav").append(...stock.map(([key]) => routeButton("inventory/" + key, "lab-tile")));
  byId("wasteMenu").append(...work.map(([key]) => routeButton("waste/" + key, "lab-tile")));
}

export function syncFilters() {
  const status = byId("chemicalStatusFilter");
  const sort = byId("chemicalSort");
  const labels = [];
  if (status.selectedIndex > 0) labels.push(status.selectedOptions[0].textContent);
  if (sort.selectedIndex > 0) labels.push(sort.selectedOptions[0].textContent);
  const summary = byId("filterSummary");
  summary.textContent = labels.length ? labels.join(" · ") : "";
  summary.hidden = labels.length === 0;
  byId("clearFilters").hidden = labels.length === 0;
}

export function renderShell(route, { inventory, chemicals, schedule, calendar, equipment }, { lotId, restoreWarnings } = {}) {
  const view = routes.get(route);
  const top = route.split("/")[0];
  for (const section of document.querySelectorAll("[data-app-screen]")) section.hidden = section.dataset.appScreen !== view.screen;
  for (const control of byId("labSidebar").children) {
    if (control.dataset.route === top) control.setAttribute("aria-current", "page");
    else control.removeAttribute("aria-current");
  }
  byId("workspaceHeader").hidden = route === "home";
  byId("viewTitle").textContent = view.title;
  byId("routeContext").textContent = route.includes("/") ? "Pulpit / " + routes.get(top).title : "Pulpit";
  byId("addChemical").hidden = view.section !== "registry";
  byId("addEquipment").hidden = route !== "equipment";
  chemicals.actions.showWarnings(route === "alerts", restoreWarnings);
  if (top === "inventory") {
    if (route === "inventory") inventory.switchSection("menu");
    else if (view.section === "registry") {
      const category = route === "inventory/chemicals" ? "Odczynniki" : "Wzorce";
      byId("addChemical").querySelector("span:last-child").textContent = category === "Odczynniki" ? "Dodaj odczynnik" : "Dodaj wzorzec";
      chemicals.actions.switchSubTab(category, lotId);
      if (lotId) syncFilters();
      inventory.switchSection(view.section);
    } else inventory.switchSection(view.section);
  }
  if (top === "waste") {
    byId("wasteMenu").hidden = route !== top;
    schedule.switchSubTab("scieki", view.category);
  }
  if (route === "calendar") calendar.render();
  equipment.render(top === "equipment" ? route : null);
}

export function bindShell() {
  byId("chemicalStatusFilter").addEventListener("change", syncFilters);
  byId("chemicalSort").addEventListener("change", syncFilters);
  const updateConnection = () => { byId("offlineNotice").hidden = navigator.onLine; };
  window.addEventListener("online", updateConnection);
  window.addEventListener("offline", updateConnection);
  updateConnection();
}
