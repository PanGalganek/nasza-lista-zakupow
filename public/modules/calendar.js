import { monthNames } from "./constants.js";
import { byId, createButton, createElement } from "./ui.js";
import { formatLocalDate, shiftCalendarMonth } from "../utils.js";

export function createCalendarModule({ db, firestore, registerSnapshot, reportListenerError }) {
  const { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query } = firestore;
  let events = [];
  let calendarDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let selectedDay = formatLocalDate();

  function selectDay(date) {
    selectedDay = date;
    render();
  }

  function changeMonth(offset) {
    calendarDate = shiftCalendarMonth(calendarDate, offset);
    selectedDay = formatLocalDate(calendarDate);
    render();
  }

  async function addEvent() {
    const title = prompt("Nazwa wydarzenia:")?.trim();
    if (!title) return;
    await addDoc(collection(db, "wydarzenia"), { title, date: selectedDay, timestamp: Date.now() });
  }

  function renderEventList(container, selectedEvents, emptyText, showDay = false) {
    container.replaceChildren();
    if (selectedEvents.length === 0) {
      container.append(createElement("p", "text-[10px] text-gray-400 italic", emptyText));
      return;
    }
    selectedEvents.forEach((event) => {
      const row = createElement("div", showDay ? "flex justify-between items-center bg-white p-2 rounded border-l-4 border-blue-400 shadow-sm text-[10px] mb-1 text-black font-bold" : "flex justify-between bg-white p-2 rounded shadow-sm text-[11px] font-semibold text-black");
      const label = showDay ? `${String(event.date || "").split("-")[2] || "--"} ${event.title || "Bez nazwy"}` : event.title || "Bez nazwy";
      row.append(
        createElement("span", "", label),
        createButton("✕", "Usuń wydarzenie", async () => {
          if (confirm(`Usunąć „${event.title}”?`)) await deleteDoc(doc(db, "wydarzenia", event.id));
        }, "text-red-600"),
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
    for (let index = 0; index < offset; index += 1) grid.append(createElement("div", "calendar-day opacity-0"));

    const today = formatLocalDate();
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${calendarDate.getFullYear()}-${monthId}-${String(day).padStart(2, "0")}`;
      const hasEvent = events.some((event) => event.date === date);
      const cell = createElement("button", `calendar-day ${date === today ? "today" : ""} ${date === selectedDay ? "selected" : ""} ${hasEvent ? "has-event" : ""}`, day);
      cell.type = "button";
      cell.setAttribute("aria-label", `Wybierz ${date}`);
      cell.addEventListener("click", () => selectDay(date));
      grid.append(cell);
    }

    byId("selectedDateLabel").textContent = `Dzień: ${selectedDay}`;
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

  return { addEvent, changeMonth, render, start };
}
