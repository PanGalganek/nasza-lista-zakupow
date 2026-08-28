import { monthNames } from "./constants.js?v=11";
import { byId, createButton, createElement } from "./ui.js?v=11";
import { formatLocalDate, isDoneInYear, shiftCalendarMonth } from "../utils.js?v=11";

export function createEquipmentModule({ db, firestore, registerSnapshot, reportListenerError }) {
  const { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc } = firestore;
  let items = [];
  let selectedMonth = String(new Date().getMonth() + 1).padStart(2, "0");

  function cancelEdit() {
    byId("editIdEquip").value = "";
    byId("equipName").value = "";
    byId("cancelEquipBtn").classList.add("hidden");
  }

  function startEdit(equipment) {
    byId("editIdEquip").value = equipment.id;
    byId("equipName").value = equipment.name || "";
    byId("equipMonth").value = equipment.month || selectedMonth;
    byId("equipType").value = equipment.type || "Wzorcowanie";
    byId("cancelEquipBtn").classList.remove("hidden");
    byId("equipName").focus();
  }

  async function save() {
    const name = byId("equipName").value.trim();
    if (!name) return;
    const data = { name, month: byId("equipMonth").value, type: byId("equipType").value };
    const editId = byId("editIdEquip").value;
    if (editId) await updateDoc(doc(db, "wzorcowanie", editId), data);
    else await addDoc(collection(db, "wzorcowanie"), { ...data, doneDate: null, timestamp: Date.now() });
    cancelEdit();
  }

  function render() {
    const list = byId("equipmentList");
    if (!list) return;
    const nav = byId("monthsNav");
    nav.replaceChildren();
    for (let index = 1; index <= 12; index += 1) {
      const id = String(index).padStart(2, "0");
      nav.append(createButton(monthNames[id].slice(0, 3), `Pokaż ${monthNames[id]}`, () => {
        selectedMonth = id;
        render();
      }, `px-3 py-2 border rounded text-[9px] font-bold uppercase ${selectedMonth === id ? "active-month" : "bg-white text-gray-500"}`));
    }

    list.replaceChildren();
    let total = 0;
    let done = 0;
    const upcoming = [];
    const currentYear = new Date().getFullYear();
    const nextDate = shiftCalendarMonth(new Date(), 1);
    const nextMonth = String(nextDate.getMonth() + 1).padStart(2, "0");

    items.forEach((equipment) => {
      const doneThisYear = isDoneInYear(equipment.doneDate, currentYear);
      if ((equipment.type === "Wzorcowanie" || !equipment.type) && equipment.month === nextMonth && !doneThisYear) upcoming.push(equipment.name || "Bez nazwy");
      if (equipment.month !== selectedMonth) return;
      total += 1;
      if (doneThisYear) done += 1;
      const type = equipment.type || "Wzorcowanie";
      const colorClass = type === "Kalibracja" ? "bg-blue-100 text-blue-700" : type === "Sprawdzenie" ? "bg-green-100 text-green-700" : "bg-purple-100 text-purple-700";
      const row = createElement("div", `flex justify-between items-center p-3 border rounded-lg ${doneThisYear ? "task-done" : "bg-white shadow-sm"} mb-2 text-[11px] text-black`);
      const info = createElement("div");
      info.append(createElement("span", `${colorClass} px-1 rounded text-[8px] uppercase mr-2 font-bold`, type), createElement("span", "font-bold text-black", equipment.name || "Bez nazwy"));
      const actions = createElement("div", "flex gap-3");
      actions.append(
        createButton(doneThisYear ? "✅" : "⬜", doneThisYear ? "Oznacz jako niewykonane" : "Oznacz jako wykonane", () => updateDoc(doc(db, "wzorcowanie", equipment.id), { doneDate: doneThisYear ? null : formatLocalDate() }), "text-xl"),
        createButton("✏️", "Edytuj sprzęt", () => startEdit(equipment)),
        createButton("✕", "Usuń sprzęt", async () => {
          if (confirm(`Usunąć „${equipment.name}”?`)) await deleteDoc(doc(db, "wzorcowanie", equipment.id));
        }, "text-red-600"),
      );
      row.append(info, actions);
      list.append(row);
    });

    byId("monthlyWzorcowanieCounter").textContent = `${monthNames[selectedMonth]}: ${done} z ${total} zrobione`;
    const alertBox = byId("upcomingWzorcowanieAlert");
    alertBox.textContent = upcoming.length ? `📢 Planowane wzorcowania na ${monthNames[nextMonth]}: ${upcoming.join(", ")}` : "";
    alertBox.classList.toggle("hidden", upcoming.length === 0);
  }

  function start() {
    registerSnapshot(onSnapshot(
      query(collection(db, "wzorcowanie"), orderBy("timestamp", "asc")),
      (snapshot) => {
        items = snapshot.docs.map((documentSnapshot) => ({ id: documentSnapshot.id, ...documentSnapshot.data() }));
        render();
      },
      (error) => reportListenerError("Sprzęt", error),
    ));
  }

  return { cancelEdit, render, save, start };
}
