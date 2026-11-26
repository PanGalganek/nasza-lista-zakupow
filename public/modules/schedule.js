import { taskCategories, taskLabs } from "./constants.js?v=18";
import { byId, createElement, iconButton, notify } from "./ui.js?v=18";
import { formatLocalDate, formatPolishDate, parseLocalDate } from "../utils.js?v=18";

export function createScheduleModule({ db, firestore, registerSnapshot, reportListenerError }) {
  const { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc } = firestore;
  const pending = new Set();

  function switchSubTab(lab, target) {
    const capitalizedLab = lab.charAt(0).toUpperCase() + lab.slice(1);
    for (const category of taskCategories) {
      byId(`subContent${capitalizedLab}${category}`)?.classList.toggle("hidden", category !== target);
    }
  }

  async function addTask(lab, category) {
    const input = byId(`taskInput${lab.charAt(0).toUpperCase() + lab.slice(1)}${category}`);
    const name = input.value.trim();
    if (!name || pending.has(input)) return;
    const submit = input.form.querySelector("button");
    pending.add(input);
    submit.disabled = true;
    try {
      await addDoc(collection(db, "harmonogram"), { name, lab, category, doneDate: null, timestamp: Date.now() });
      input.value = "";
      notify("Dodano zadanie.");
    } finally { pending.delete(input); submit.disabled = false; }
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

          const row = createElement("div", `lab-data-row ${doneThisYear ? "task-done" : ""}`);
          const description = createElement("div", "flex flex-col");
          description.append(createElement("span", "font-bold text-black", task.name || "Bez nazwy"));
          if (doneThisYear) description.append(createElement("span", "text-sm text-green-800", `Wykonano: ${formatPolishDate(task.doneDate)}`));
          const actions = createElement("div", "lab-actions");
          actions.append(
            iconButton(doneThisYear ? "check" : "square", doneThisYear ? "Oznacz jako niewykonane" : "Oznacz jako wykonane", () => updateDoc(doc(db, "harmonogram", documentSnapshot.id), { doneDate: doneThisYear ? null : formatLocalDate() })),
            iconButton("trash", "Usuń zadanie", async () => {
              if (confirm(`Usunąć „${task.name}”?`)) await deleteDoc(doc(db, "harmonogram", documentSnapshot.id));
            }, "lab-button-danger"),
          );
          row.append(description, actions);
          byId(`taskList${task.lab.charAt(0).toUpperCase() + task.lab.slice(1)}${category}`)?.append(row);
        });

        Object.entries(stats).forEach(([key, stat]) => {
          const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
          const monthStatus = byId(`mStatus${capitalizedKey}`);
          const yearStatus = byId(`yStatus${capitalizedKey}`);
          if (!monthStatus || !yearStatus) return;
          monthStatus.className = `lab-notice ${stat.doneThisMonth ? "lab-notice-ok" : "lab-notice-warning"}`;
          monthStatus.textContent = stat.doneThisMonth ? "Wykonano w tym miesiącu" : "Brak wykonanego zadania w tym miesiącu";
          yearStatus.className = "lab-notice";
          yearStatus.textContent = stat.doneThisYear === stat.total && stat.total > 0 ? "Plan roczny zakończony" : `Plan roczny: ${stat.doneThisYear} z ${stat.total}`;
          if (!stat.total) byId(`taskList${capitalizedKey}`)?.append(createElement("p", "lab-empty", "Brak zadań w tej kategorii."));
        });
      },
      (error) => reportListenerError("Harmonogram", error),
    ));
  }

  return { addTask, start, switchSubTab };
}
