import { taskCategories, taskLabs } from "./constants.js?v=10";
import { byId, createButton, createElement } from "./ui.js?v=10";
import { formatLocalDate, parseLocalDate } from "../utils.js?v=10";

export function createScheduleModule({ db, firestore, registerSnapshot, reportListenerError }) {
  const { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc } = firestore;

  function switchSubTab(lab, target) {
    taskCategories.forEach((category) => {
      const capitalizedLab = lab.charAt(0).toUpperCase() + lab.slice(1);
      byId(`subContent${capitalizedLab}${category}`)?.classList.add("hidden");
      const button = byId(`subBtn${capitalizedLab}${category}`);
      if (button) button.className = "px-2 py-2 border rounded text-[9px] font-bold uppercase bg-white text-gray-500 text-center min-w-[120px]";
    });

    const capitalizedLab = lab.charAt(0).toUpperCase() + lab.slice(1);
    byId(`subContent${capitalizedLab}${target}`)?.classList.remove("hidden");
    const activeButton = byId(`subBtn${capitalizedLab}${target}`);
    if (activeButton) activeButton.className = `px-2 py-2 border rounded text-[9px] font-bold uppercase active-sub-tab-${lab} text-center min-w-[120px]`;
  }

  async function addTask(lab, category) {
    const input = byId(`taskInput${lab.charAt(0).toUpperCase() + lab.slice(1)}${category}`);
    const name = input.value.trim();
    if (!name) return;
    await addDoc(collection(db, "harmonogram"), { name, lab, category, doneDate: null, timestamp: Date.now() });
    input.value = "";
  }

  function start() {
    registerSnapshot(onSnapshot(
      query(collection(db, "harmonogram"), orderBy("timestamp", "asc")),
      (snapshot) => {
        const stats = {};
        taskLabs.forEach((lab) => taskCategories.forEach((category) => {
          const key = `${lab}${category}`;
          stats[key] = { total: 0, doneThisYear: 0, doneThisMonth: false };
          byId(`taskList${lab.charAt(0).toUpperCase() + lab.slice(1)}${category}`)?.replaceChildren();
        }));

        const currentYear = new Date().getFullYear();
        const currentMonth = new Date().getMonth();
        snapshot.docs.forEach((documentSnapshot) => {
          const task = documentSnapshot.data();
          const category = task.category || "Archiwalna";
          const key = `${task.lab}${category}`;
          if (!stats[key]) return;
          const doneDate = parseLocalDate(task.doneDate);
          const doneThisYear = Boolean(doneDate && doneDate.getFullYear() === currentYear);
          const doneThisMonth = doneThisYear && doneDate.getMonth() === currentMonth;
          stats[key].total += 1;
          if (doneThisYear) stats[key].doneThisYear += 1;
          if (doneThisMonth) stats[key].doneThisMonth = true;

          const row = createElement("div", `flex justify-between items-center p-3 border rounded-lg ${doneThisYear ? "task-done" : "bg-white shadow-sm"} mb-2 text-[11px] text-black`);
          const description = createElement("div", "flex flex-col");
          description.append(createElement("span", "font-bold text-black", task.name || "Bez nazwy"));
          if (doneThisYear) description.append(createElement("span", "text-[9px] text-green-600 font-bold uppercase mt-1", `Wykonano: ${task.doneDate}`));
          const actions = createElement("div", "flex gap-4");
          actions.append(
            createButton(doneThisYear ? "✅" : "⬜", doneThisYear ? "Oznacz jako niewykonane" : "Oznacz jako wykonane", () => updateDoc(doc(db, "harmonogram", documentSnapshot.id), { doneDate: doneThisYear ? null : formatLocalDate() }), "text-xl"),
            createButton("✕", "Usuń zadanie", async () => {
              if (confirm(`Usunąć „${task.name}”?`)) await deleteDoc(doc(db, "harmonogram", documentSnapshot.id));
            }, "text-red-600"),
          );
          row.append(description, actions);
          byId(`taskList${task.lab.charAt(0).toUpperCase() + task.lab.slice(1)}${category}`)?.append(row);
        });

        Object.entries(stats).forEach(([key, stat]) => {
          const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
          const monthStatus = byId(`mStatus${capitalizedKey}`);
          const yearStatus = byId(`yStatus${capitalizedKey}`);
          if (!monthStatus || !yearStatus) return;
          monthStatus.className = `p-2 rounded-lg text-[9px] font-bold border text-center mb-1 ${stat.doneThisMonth ? "bg-green-50 text-green-700" : "bg-orange-50 text-orange-800 animate-pulse"}`;
          monthStatus.textContent = stat.doneThisMonth ? "✅ Wykonano w tym miesiącu" : "⚠️ Brak zadania w tym miesiącu!";
          yearStatus.className = "p-2 rounded-lg text-[9px] font-bold border text-center mb-2 bg-gray-50 text-gray-500 uppercase";
          yearStatus.textContent = stat.doneThisYear === stat.total && stat.total > 0 ? "⭐ Plan roczny zakończony!" : `Plan roczny: ${stat.doneThisYear} / ${stat.total} zrobione`;
        });
      },
      (error) => reportListenerError("Harmonogram", error),
    ));
  }

  return { addTask, start, switchSubTab };
}
