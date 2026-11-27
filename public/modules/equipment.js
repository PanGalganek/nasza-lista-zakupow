import { monthNames } from "./constants.js?v=34";
import { byId, createElement, iconButton, notify } from "./ui.js?v=34";
import { formatLocalDate, formatPolishDate, isDoneInYear, shiftCalendarMonth } from "../utils.js?v=34";

export function createEquipmentModule({ db, firestore, registerSnapshot, reportListenerError, navigation }) {
  const { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc } = firestore;
  let items = [];
  let selectedMonth = String(new Date().getMonth() + 1).padStart(2, "0");
  let pending = false;

  function cancelEdit() {
    byId("editIdEquip").value = "";
    byId("equipName").value = "";
    byId("equipType").selectedIndex = 0;
    byId("equipMonth").value = selectedMonth;
  }

  function startEdit(equipment) {
    byId("editIdEquip").value = equipment.id;
    byId("equipName").value = equipment.name || "";
    byId("equipMonth").value = equipment.month || selectedMonth;
    byId("equipType").value = equipment.type || "Wzorcowanie";
    navigation.show(byId("formWzorcowanie"), "Edytuj sprzęt", { busy: () => pending, onDismiss: cancelEdit });
  }

  function openForm() {
    cancelEdit();
    navigation.show(byId("formWzorcowanie"), "Dodaj sprzęt", { busy: () => pending, onDismiss: cancelEdit });
  }

  async function save() {
    const name = byId("equipName").value.trim();
    if (!name || pending) return;
    const data = { name, month: byId("equipMonth").value, type: byId("equipType").value };
    const editId = byId("editIdEquip").value;
    const submit = byId("formWzorcowanie").querySelector("[type=submit]");
    pending = true;
    submit.disabled = true;
    try {
      if (editId) await updateDoc(doc(db, "wzorcowanie", editId), data);
      else await addDoc(collection(db, "wzorcowanie"), { ...data, doneDate: null, timestamp: Date.now() });
      navigation.close(true);
      notify("Zapisano sprzęt.");
    } finally { pending = false; submit.disabled = false; }
  }

  function render() {
    const list = byId("equipmentList");
    if (!list) return;
    byId("equipmentMonthView").value = selectedMonth;

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
      const row = createElement("div", `lab-data-row ${doneThisYear ? "task-done" : ""}`);
      const info = createElement("div", "lab-lot-info");
      const heading = createElement("div", "lab-actions");
      heading.append(createElement("strong", "", equipment.name || "Bez nazwy"), createElement("span", "lab-chip", type));
      info.append(heading);
      if (doneThisYear) info.append(createElement("span", "text-sm text-green-800", `Wykonano: ${formatPolishDate(equipment.doneDate)}`));
      const actions = createElement("div", "lab-actions");
      actions.append(
        iconButton(doneThisYear ? "check" : "square", doneThisYear ? "Oznacz jako niewykonane" : "Oznacz jako wykonane", () => updateDoc(doc(db, "wzorcowanie", equipment.id), { doneDate: doneThisYear ? null : formatLocalDate() })),
        iconButton("edit", "Edytuj sprzęt", () => startEdit(equipment)),
        iconButton("trash", "Usuń sprzęt", async () => {
          if (confirm(`Usunąć „${equipment.name}”?`)) await deleteDoc(doc(db, "wzorcowanie", equipment.id));
        }, "lab-button-danger"),
      );
      row.append(info, actions);
      list.append(row);
    });

    if (!total) list.append(createElement("p", "lab-empty", "Brak sprzętu do obsługi w tym miesiącu."));
    byId("monthlyWzorcowanieCounter").textContent = `${monthNames[selectedMonth]}: wykonano ${done} z ${total}`;
    const alertBox = byId("upcomingWzorcowanieAlert");
    alertBox.textContent = upcoming.length ? `Planowane wzorcowania · ${monthNames[nextMonth]}: ${upcoming.join(", ")}` : "";
    alertBox.classList.toggle("hidden", upcoming.length === 0);
  }

  function start() {
    byId("equipmentMonthView").onchange = (event) => { selectedMonth = event.target.value; render(); };
    registerSnapshot(onSnapshot(
      query(collection(db, "wzorcowanie"), orderBy("timestamp", "asc")),
      (snapshot) => {
        items = snapshot.docs.map((documentSnapshot) => ({ id: documentSnapshot.id, ...documentSnapshot.data() }));
        render();
      },
      (error) => reportListenerError("Sprzęt", error),
    ));
  }

  return { openForm, render, save, start };
}
