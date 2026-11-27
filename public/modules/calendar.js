import { monthNames } from "./constants.js?v=32";
import { byId, createElement, iconButton, notify } from "./ui.js?v=32";
import { formatLocalDate, formatPolishDate, shiftCalendarMonth } from "../utils.js?v=32";

export function createCalendarModule({ db, firestore, registerSnapshot, reportListenerError, navigation }) {
  const { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query } = firestore;
  let events = [];
  let calendarDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let selectedDay = formatLocalDate();
  let eventDate;
  let pending = false;

  function selectDay(date) {
    selectedDay = date;
    render();
  }

  function changeMonth(offset) {
    calendarDate = shiftCalendarMonth(calendarDate, offset);
    selectedDay = formatLocalDate(calendarDate);
    render();
  }

  function openForm() {
    eventDate = selectedDay;
    byId("eventFormDate").textContent = formatPolishDate(eventDate);
    byId("eventTitle").value = "";
    navigation.show(byId("eventForm"), "Dodaj wydarzenie", { busy: () => pending });
  }

  async function addEvent() {
    const title = byId("eventTitle").value.trim();
    if (!title || pending || !eventDate) return;
    const submit = byId("eventForm").querySelector("[type=submit]");
    submit.disabled = pending = true;
    try {
      await addDoc(collection(db, "wydarzenia"), { title, date: eventDate, timestamp: Date.now() });
      navigation.close(true);
      notify("Zapisano wydarzenie.");
    } finally { submit.disabled = pending = false; }
  }

  function renderEventList(container, selectedEvents, emptyText, showDay = false) {
    container.replaceChildren();
    if (selectedEvents.length === 0) {
      container.append(createElement("p", "lab-empty", emptyText));
      return;
    }
    selectedEvents.forEach((event) => {
      const row = createElement("div", "lab-data-row");
      const label = showDay ? `${formatPolishDate(event.date)} — ${event.title || "Bez nazwy"}` : event.title || "Bez nazwy";
      row.append(
        createElement("span", "", label),
        iconButton("trash", "Usuń wydarzenie", async () => {
          if (confirm(`Usunąć „${event.title}”?`)) await deleteDoc(doc(db, "wydarzenia", event.id));
        }, "lab-button-danger"),
      );
      container.append(row);
    });
  }

  function render() {
    const grid = byId("calendarDays");
    const monthId = String(calendarDate.getMonth() + 1).padStart(2, "0");
    byId("calendarMonthYear").textContent = `${monthNames[monthId]} ${calendarDate.getFullYear()}`;
    grid.replaceChildren();
    const firstWeekday = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), 1).getDay();
    const daysInMonth = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 0).getDate();
    const offset = firstWeekday === 0 ? 6 : firstWeekday - 1;
    for (let index = 0; index < offset; index += 1) grid.append(createElement("div"));

    const today = formatLocalDate();
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${calendarDate.getFullYear()}-${monthId}-${String(day).padStart(2, "0")}`;
      const hasEvent = events.some((event) => event.date === date);
      const cell = createElement("button", `calendar-day ${date === today ? "today" : ""} ${date === selectedDay ? "selected" : ""} ${hasEvent ? "has-event" : ""}`, day);
      cell.type = "button";
      cell.setAttribute("aria-label", `Wybierz ${formatPolishDate(date)}${hasEvent ? ", zaplanowane wydarzenia" : ""}`);
      cell.setAttribute("aria-pressed", String(date === selectedDay));
      if (date === today) cell.setAttribute("aria-current", "date");
      cell.addEventListener("click", () => selectDay(date));
      grid.append(cell);
    }

    byId("selectedDateLabel").textContent = `Dzień: ${formatPolishDate(selectedDay)}`;
    renderEventList(byId("dayEventsList"), events.filter((event) => event.date === selectedDay), "Brak wydarzeń.");
    const monthPrefix = `${calendarDate.getFullYear()}-${monthId}`;
    const monthEvents = events.filter((event) => typeof event.date === "string" && event.date.startsWith(monthPrefix)).sort((a, b) => a.date.localeCompare(b.date));
    renderEventList(byId("monthEventsList"), monthEvents, "Brak wydarzeń w miesiącu.", true);
  }

  function start() {
    registerSnapshot(onSnapshot(
      query(collection(db, "wydarzenia"), orderBy("timestamp", "asc")),
      (snapshot) => {
        events = snapshot.docs.map((documentSnapshot) => ({ id: documentSnapshot.id, ...documentSnapshot.data() }));
        render();
      },
      (error) => reportListenerError("Kalendarz", error),
    ));
  }

  return { addEvent, changeMonth, openForm, render, start };
}
