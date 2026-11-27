import { parseLocalDate } from "../utils.js?v=32";
import { normalizeInventorySearch } from "./inventory-quantity.js?v=32";

export const waterCategory = "WodaRoczna";
export const waterManualPrefix = "woda_reczne_";
export const firstWaterYear = 2026;
export const sixMeasurementsKey = "siar-g-dol";
export const waterMatrices = {"spo":"Woda do spożycia","pod":"Woda podziemna","pow":"Woda powierzchniowa","stud":"Woda ze studni","sc":"Ścieki","przem":"Ścieki przemysłowe SUW Jutrzkowicka"};
const methods = [
  ["barwa","Barwa","SP","","70 mg/l Pt","spo pod"],
  ["chlor","Chlor wolny i ogólny","SP","","","spo"],
  ["chlorki","Chlorki, metoda Mohra","ASP","2 mg/l (LOQ)","500 mg/l","spo pod pow"],
  ["glin","Glin","ASP","0,05 mg/l (dolny zakres)","1,0 mg/l",""],
  ["indeks","Indeks nadmanganianowy","ASP","0,5 mg/l O₂ (LOQ)","10 mg/l O₂","spo pod pow"],
  ["magnez","Magnez","SP","1 mg/l (LOQ)","",""],
  ["mangan","Mangan","ASP","","1 mg/l","spo pod"],
  ["amon","Azot amonowy","ASP","","","spo stud"],
  ["azotyny","Azotyny","ASP","0,8 µg/próbkę (0,02 mg/l N-NO₂, LOQ)","1 mg/l NO₂","spo stud pow sc"],
  ["azotany","Azotany","SP","","100 mg/l NO₃","spo stud pow sc"],
  ["ph","Odczyn pH","SP","","","spo stud pow sc"],
  ["przewod","Przewodność","SP","","","spo stud pow"],
  ["siar-g","Siarczany grawimetryczne","ASP","10 mg/l (LOQ)","1000 mg/l","pod pow"],
  ["siar-t","Siarczany turbidymetryczne","ASP","","250 mg/l","spo"],
  ["twardosc","Twardość","SP","0,05 mmol/l CaCO₃ (5 mg/l CaCO₃, LOQ)","1000 mg/l CaCO₃","spo pod"],
  ["wapn","Wapń","SP","2 mg/l (0,05 mmol/l, LOQ)","300 mg/l (7,5 mmol/l)","spo"],
  ["zelazo","Żelazo","ASP","","15 mg/l","spo pod przem"],
];

const baseTypes = [["A", "Archiwalna", "arch"], ["S", "Slepa", "slepa"], ["P", "Porownania", "por"]];
const version2026 = {
  year: firstWaterYear,
  version: "woda-2026.1",
  controls: methods.flatMap(([method, name, types, lower, upper, matrices]) => [
    ...baseTypes.filter(([flag]) => types.includes(flag)).map(([, category, suffix]) => ({ category, key: method + "-" + suffix })),
    ...[[lower, "dol"], [upper, "gor"]].filter(([limit]) => limit).map(([limit, suffix]) =>
      ({ category: "Granice", key: method + "-" + suffix, limit, boundary: suffix })),
    ...matrices.split(" ").filter(Boolean).map((matrix) => ({ category: "Probkobranie", key: method + "-" + matrix, matrix })),
  ].map((control) => ({ ...control, method, name }))),
};
// Retain each released catalogue and append revisions with a new effective year.
const catalogues = [version2026];

export function waterPlan(year) {
  return catalogues.findLast((catalogue) => catalogue.year <= Number(year));
}

export function waterDateInYear(date, year) {
  return Boolean(parseLocalDate(date) && date.slice(0, 4) === String(year));
}

export function waterAnnualId(year, origin, key) {
  return `woda_roczna_${year}_${origin}_${key}`;
}

export const waterCompleted = (key, row) => Boolean(row?.doneDate || (key === sixMeasurementsKey && Object.keys(row?.measurements || {}).length === 6));

const aliases = new Map(methods.map(([id, name]) => [normalizeInventorySearch(name), id]));
for (const [alias, method] of [
  ["chlor wolny", "chlor"], ["chlorki", "chlorki"], ["azot azotanowy", "azotany"], ["azot azotynowy", "azotyny"],
  ["przewodnosc elektryczna", "przewod"], ["twardosc ogolna", "twardosc"], ["ph", "ph"],
]) aliases.set(alias, method);

function candidateFor(task, controls) {
  if (task.id.startsWith(waterManualPrefix)) return null;
  const category = task.category || "Archiwalna";
  let name = normalizeInventorySearch(task.name).replace(/\s+/g, " ");
  let matrix;
  let reason = "";
  if (category === "Probkobranie") {
    const suffix = / (woda do spozycia|woda podziemna|woda ze studni|rzeka|woda powierzchniowa|scieki|popluczne suw jutrzkowice)$/.exec(name);
    if (!suffix) return null;
    matrix = {
      "woda do spozycia": "spo", "woda podziemna": "pod", "woda ze studni": "stud",
      rzeka: "pow", "woda powierzchniowa": "pow", scieki: "sc", "popluczne suw jutrzkowice": "przem",
    }[suffix[1]];
    name = name.slice(0, suffix.index);
    if (matrix === "przem") reason = "Potwierdź, czy popłuczyny dotyczą tej samej matrycy i SUW.";
  }
  const method = aliases.get(name);
  const relevant = controls.filter((control) => control.method === method && control.category === category);
  let control = relevant.find((item) => item.matrix === matrix);
  if (!control && matrix === "pod") {
    control = relevant.find((item) => item.matrix === "stud");
    if (control) reason = "Potwierdź, że próbka pochodziła ze studni.";
  }
  if (!control) return null;
  if (name === "chlor wolny") reason = "Potwierdź zakres programu chloru wolnego i ogólnego.";
  return { control, reason };
}

export function matchWaterTasks(legacy, annual, year, controls) {
  const candidates = new Map();
  const byControl = new Map();
  for (const task of legacy) {
    const match = candidateFor(task, controls);
    if (!match) continue;
    candidates.set(task.id, match);
    if (!byControl.has(match.control.key)) byControl.set(match.control.key, []);
    byControl.get(match.control.key).push(task);
  }

  const linked = new Map();
  const used = new Set();
  const sorted = annual.filter((record) => record.origin === "plan" && Number(record.year) <= Number(year) && record.legacyTaskId)
    .sort((first, second) => Number(second.year) - Number(first.year));
  const byId = new Map(legacy.map((task) => [task.id, task]));
  for (const record of sorted) {
    const task = byId.get(record.legacyTaskId);
    if (task && candidates.get(task.id)?.control.key === record.itemKey && !used.has(task.id) && !linked.has(record.itemKey)) {
      linked.set(record.itemKey, task);
      used.add(task.id);
    }
  }
  for (const [key, tasks] of byControl) {
    if (tasks.length > 1) {
      for (const task of tasks) candidates.get(task.id).reason ||= "Kilka starszych zadań odpowiada tej kontroli.";
    }
    const task = tasks[0];
    if (!linked.has(key) && tasks.length === 1 && !candidates.get(task.id).reason) {
      linked.set(key, task);
      used.add(task.id);
    }
  }
  return { linked, used, candidates };
}
