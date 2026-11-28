import { quantity } from "../public/modules/inventory-quantity.js";
import { formatLocalDate } from "../public/utils.js";

const account = { email: "demo@elab.test", password: "Laboratorium-2026", returnSecureToken: true };
export { account };

function encoded(value) {
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encoded) } };
  if (value === null) return { nullValue: null };
  if (typeof value === "number") return { integerValue: String(value) };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "string") return { stringValue: value };
  return { mapValue: { fields: fields(value) } };
}

const fields = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, encoded(value)]));
const days = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return formatLocalDate(date);
};

export async function seed(project, authHost, firestoreHost, { legacyEquipment = true } = {}) {
  const auth = async (operation) => fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:${operation}?key=fake-key`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(account), redirect: "error",
  });
  let userResponse = await auth("signUp");
  if (userResponse.status === 400) userResponse = await auth("signInWithPassword");
  if (!userResponse.ok) throw new Error("Nie można utworzyć konta demonstracyjnego.");
  const { localId } = await userResponse.json();
  const database = `projects/${project}/databases/(default)/documents`;
  const writes = [];
  const put = (name, value) => writes.push({ update: { name: `${database}/${name}`, fields: fields(value) } });
  put(`app_users/${localId}`, { role: "operator", active: true });
  const entries = [
    ["iron", "Siarczan żelaza (II) cz.d.a.", "VI-01/1", "LAB-FE-01", 500, 400, 180, "Odczynniki"],
    ["iron-reserve", "Siarczan żelaza (II) cz.d.a.", "VI-01/2", "LAB-FE-02", 500, 500, 240, "Odczynniki", "iron"],
    ["sodium", "Chlorek sodu cz.d.a.", "VI-02", "LAB-NA-11", 500, 250, 260, "Odczynniki"],
    ["calcium", "Węglan wapnia cz.d.a.", "VI-03", "LAB-CA-03", 500, 120, 45, "Odczynniki"],
    ["legacy", "Wodorowęglan sodu", "VI-04", "", null, null, -8, "Odczynniki"],
    ["opening", "Wodorotlenek wapnia", "VI-05", "LAB-OPEN", 500, 500, 220, "Odczynniki"],
    ["archived", "Sól buforowa do kontroli odczynu", "VI-06", "LAB-OLD", 100, 0, 365, "Odczynniki"],
    ["stock-std", "Wzorzec przewodności elektrolitycznej", "WZ-01", "LAB-WZ-01", 100, 80, 15, "Wzorce"],
    ["untracked-std", "Wzorzec kalibracyjny pH", "WZ-02", "", null, null, 190, "Wzorce"],
    ["long", "Certyfikowany materiał odniesienia do kontroli powtarzalności oznaczeń metodą spektrofotometryczną w próbkach wód powierzchniowych", "VI-07", "LAB-LONG", 250, 180, 450, "Odczynniki"],
  ];
  entries.forEach(([id, name, group, lotNumber, initial, balance, expires, category, root], index) => {
    const productId = root || id;
    const unit = category === "Wzorce" ? "ml" : "g";
    const packageAmount = initial === null ? null : quantity(String(initial), unit);
    const fields = { name, group, lotNumber, usage: "Kontrola laboratoryjna", received: days(-35), expiry: days(expires),
      category, timestamp: index + 1, ordered: false };
    if (packageAmount !== null) Object.assign(fields, { packageAmount, packageUnit: unit, orderPackages: 1, productId });
    put(`odczynniki/${id}`, fields);
    if (packageAmount === null) return;
    const starting = id === "opening" ? "opening" : "receipt";
    const state = id === "archived" ? "used" : "active";
    const endAmount = quantity(String(balance), unit, { zero: true });
    const startEvent = `demo-${id}-start`;
    const finalEvent = endAmount === packageAmount ? startEvent : `demo-${id}-change`;
    const row = { name, number: lotNumber, productId, unit, initial: packageAmount };
    const details = { intent: "0".repeat(64) };
    put(`magazyn_operacje/${startEvent}`, { kind: starting, anchor: id, details,
      createdAt: new Date(Date.now() - 86_400_000 * 8), changes: { [id]: { ...row, before: starting === "opening" ? packageAmount : 0, after: packageAmount, status: "active" } } });
    if (finalEvent !== startEvent) put(`magazyn_operacje/${finalEvent}`, { kind: state === "used" ? "used" : "withdrawal", anchor: id, details,
      createdAt: new Date(Date.now() - 86_400_000 * 2), changes: { [id]: { ...row, before: packageAmount, after: endAmount, status: state } } });
    put(`magazyn_partie/${id}`, { initial: packageAmount, balance: endAmount, unit, status: state, lastEvent: finalEvent });
  });
  for (let i = 1; i <= 180; i++) {
    const name = `Pozycja demonstracyjna ${String(i).padStart(3, "0")}`;
    put(`odczynniki/fixture-${i}`, { name, group: `X-${i}`, category: i % 3 ? "Odczynniki" : "Wzorce",
      received: "", expiry: days(110 + i), usage: "Ćwiczenia demonstracyjne", timestamp: i + 100, ordered: false });
  }
  put("magazyn_metody/iron-analysis", { name: "Oznaczanie żelaza", usage: [
    { target: "recipe", key: "control-iron", name: "Roztwór kontrolny żelaza", unit: "ml", quantity: quantity("1", "ml") },
  ] });
  put("magazyn_metody/quality-analysis", { name: "Kontrola jakości", usage: [] });
  put("magazyn_receptury/control-iron", { name: "Roztwór kontrolny żelaza", baseVolume: 100, defaultVolume: 100, scalable: true,
    methods: ["iron-analysis", "quality-analysis"], version: 1, instruction: "", ingredients: [
      { productId: "iron", name: "Siarczan żelaza (II) cz.d.a.", unit: "g", quantity: quantity("10", "g") },
      { productId: "sodium", name: "Chlorek sodu cz.d.a.", unit: "g", quantity: quantity("2", "g") },
    ] });
  put("magazyn_receptury/control-short", { name: "Receptura testowa — brak zapasu", baseVolume: 100, defaultVolume: 100, scalable: true,
    methods: ["quality-analysis"], version: 1, instruction: "", ingredients: [
      { productId: "calcium", name: "Węglan wapnia cz.d.a.", unit: "g", quantity: quantity("500", "g") },
    ] });
  for (const lab of ["woda", "scieki"]) {
    for (const [index, [category, name]] of [["Archiwalna", "Oznaczenie odczynu"], ["Slepa", "Kontrola próby ślepej"],
      ["Probkobranie", "Punkt poboru nr 2"], ["Porownania", "Przewodność elektrolityczna"]].entries()) {
      put(`harmonogram/${lab}-${category}`, { name, category, lab, doneDate: index === 1 ? days(0) : null, timestamp: index });
    }
  }
  const month = days(0).slice(5, 7);
  const nextMonth = String((Number(month) % 12) + 1).padStart(2, "0");
  if (legacyEquipment) {
    put("wzorcowanie/pehametr", { name: "pH-metr stanowiskowy", month, type: "Wzorcowanie", doneDate: null, timestamp: 1 });
    put("wzorcowanie/waga", { name: "Waga laboratoryjna", month, type: "Sprawdzenie", doneDate: days(0), timestamp: 2 });
    put("wzorcowanie/pipeta", { name: "Pipeta automatyczna", month: nextMonth, type: "Wzorcowanie", doneDate: null, timestamp: 3 });
  }
  put("wydarzenia/qa", { title: "Kontrola próbek referencyjnych", date: days(0), timestamp: 1 });
  put("wydarzenia/check", { title: "Sprawdzenie dokumentacji", date: days(3), timestamp: 2 });
  for (let offset = 0; offset < writes.length; offset += 100) {
    const response = await fetch(`http://${firestoreHost}/v1/${database}:commit`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
      body: JSON.stringify({ writes: writes.slice(offset, offset + 100) }), redirect: "error",
    });
    if (!response.ok) throw new Error(`Nie można zasilić emulatora: ${response.status} ${await response.text()}`);
  }
}
