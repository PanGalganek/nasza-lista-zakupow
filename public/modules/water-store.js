import { sixMeasurementsKey, waterAnnualId, waterCategory, waterDateInYear, waterPlan } from "./water-plan.js?v=35";

export function createWaterStore(db, firestore, online = () => navigator.onLine) {
  const { doc, runTransaction } = firestore;
  const reference = (id) => doc(db, "harmonogram", id);

  async function save(selection, action) {
    if (!online()) throw new Error("Brak połączenia. Twoje zmiany pozostają w otwartym formularzu.");
    const { year, origin, itemKey, planVersion } = selection;
    const plan = waterPlan(year);
    const control = plan?.controls.find((control) => control.key === itemKey);
    if (!plan || (origin === "plan" && !control)) {
      throw new Error("Ta pozycja nie ma planu w wybranym roku.");
    }
    if (control && origin === "plan" && control.planVersion !== planVersion) {
      throw new Error("Odśwież aplikację, aby użyć właściwej wersji kontroli.");
    }
    if (action.date && !waterDateInYear(action.date, year)) throw new Error("Wybierz datę z wyświetlanego roku.");
    const target = reference(waterAnnualId(year, origin, itemKey));
    return runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(target);
      const existing = snapshot.data();
      // Only a new annual entry for a manual task needs its definition.
      const readSource = origin === "manual" && !existing;
      const sourceTask = readSource ? (await transaction.get(reference(itemKey))).data() : null;
      if (readSource && (sourceTask?.lab !== "woda" || sourceTask?.category === waterCategory)) {
        throw new Error("Źródłowe zadanie Wody jest niedostępne.");
      }
      const record = existing || {
        lab: "woda", category: waterCategory, year: String(year), origin, itemKey,
        planVersion: origin === "plan" ? planVersion : "", timestamp: Date.now(),
        doneDate: null, note: "", legacyTaskId: "", measurements: {},
        ...(origin === "manual" ? { taskName: sourceTask.name, taskCategory: sourceTask.category || "Archiwalna" } : {}),
      };
      if (origin === "plan" && record.planVersion !== planVersion) throw new Error("Odśwież aplikację, aby użyć właściwej wersji planu.");

      if (action.kind === "finish") {
        if ((record.doneDate ?? null) !== action.expectedDate || record.note !== action.expectedNote) {
          throw new Error("Zapis zmienił się na innym urządzeniu. Otwórz pozycję ponownie.");
        }
        record.doneDate = action.date;
        record.note = action.note;
      } else {
        if (origin !== "plan" || itemKey !== sixMeasurementsKey) throw new Error("Ta kontrola nie ma licznika oznaczeń.");
        const entries = { ...record.measurements };
        const previousDate = entries[action.id];
        if (action.kind === "add") {
          if (previousDate) return;
          if (Object.keys(entries).length === 6) throw new Error("Zapisano już sześć oznaczeń.");
          entries[action.id] = action.date;
        } else {
          if (!previousDate || previousDate !== action.expectedDate) {
            throw new Error("Oznaczenie zmieniło się na innym urządzeniu. Otwórz pozycję ponownie.");
          }
          if (action.kind === "remove") delete entries[action.id];
          else entries[action.id] = action.date;
        }
        record.measurements = entries;
      }
      if (!online()) throw new Error("Brak połączenia. Twoje zmiany pozostają w otwartym formularzu.");
      record.revision = (record.revision || 0) + 1;
      transaction.set(target, record);
    });
  }

  return { save };
}
