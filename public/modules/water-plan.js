import { parseLocalDate } from "../utils.js?v=38";

export const waterCategory = "WodaRoczna";
export const firstWaterYear = 2026;
export const waterMeasurementTarget = 6;
export const waterUsesMeasurements = (key) => key === "siar-g-dol" || key === "siar-g-gor";
export const waterMatrices = { spo: "Woda do spożycia", pod: "Woda podziemna", pow: "Woda powierzchniowa", sc: "Ścieki" };
const matrixGroups = { spo: "spo", pod: "pod", stud: "pod", pow: "pow", sc: "sc", przem: "sc" };

export function waterSamplingLabel(matrix) {
  const name = waterMatrices[matrixGroups[matrix]];
  return matrix === "przem" ? `${name} – SUW Jutrzkowicka` : name;
}

// The September conductivity programme was supplied as a paper reference.
const methods = [
  ["barwa","Barwa","2025-04-28","SP","","70 mg/l Pt","spo pod"],
  ["chlor","Chlor wolny i ogólny","2025-04-28","SP","","","spo"],
  ["chlorki","Chlorki","2026-02-23","ASP","2 mg/l (LOQ)","500 mg/l","spo pod pow"],
  ["glin","Glin","2025-04-28","ASP","0,05 mg/l (dolny zakres)","1,0 mg/l",""],
  ["indeks","Indeks nadmanganianowy","2026-02-23","ASP","0,5 mg/l O₂ (LOQ)","10 mg/l O₂","spo pod pow"],
  ["magnez","Magnez","2025-04-28","SP","1 mg/l (LOQ)","",""],
  ["mangan","Mangan","2025-04-28","ASP","","1 mg/l","spo pod"],
  ["amon","Azot amonowy","2025-04-28","ASP","","","spo stud"],
  ["azotyny","Azotyny","2026-02-23","ASP","0,8 µg/próbkę (0,02 mg/l N-NO₂, LOQ)","1 mg/l NO₂","spo stud pow sc"],
  ["azotany","Azotany","2026-02-23","SP","","100 mg/l NO₃","spo stud pow sc"],
  ["ph","Odczyn pH","2026-02-23","SP","","","spo stud pow sc"],
  ["przewod","Przewodność","2026-09-16","SP","","","spo stud pow"],
  ["siar-g","Siarczany grawimetryczne","2026-02-23","ASP","10 mg/l (LOQ)","1000 mg/l","pod pow"],
  ["siar-t","Siarczany turbidymetryczne","2025-04-28","ASP","","250 mg/l","spo"],
  ["twardosc","Twardość","2025-04-28","SP","0,05 mmol/l CaCO₃ (5 mg/l CaCO₃, LOQ)","1000 mg/l CaCO₃","spo pod"],
  ["wapn","Wapń","2025-04-28","SP","2 mg/l (0,05 mmol/l, LOQ)","300 mg/l (7,5 mmol/l)","spo"],
  ["zelazo","Żelazo","2025-04-28","ASP","","15 mg/l","spo pod przem"],
];

const baseTypes = [["A", "Archiwalna", "arch"], ["S", "Slepa", "slepa"], ["P", "Porownania", "por"]];
const originalVersion = "woda-2026.1";
const revisedVersion = "woda-2026.2";
const baseControls = methods.flatMap(([method, , , types, lower, upper, matrices]) => [
  ...baseTypes.filter(([flag]) => types.includes(flag)).map(([, category, suffix]) => ({ category, key: method + "-" + suffix })),
  ...[[lower, "dol"], [upper, "gor"]].filter(([limit]) => limit).map(([limit, suffix]) =>
    ({ category: "Granice", key: method + "-" + suffix, limit, boundary: suffix })),
  ...matrices.split(" ").filter(Boolean).map((matrix) => ({ category: "Probkobranie", key: method + "-" + matrix, matrix })),
].map((control) => ({ ...control, method, planVersion: originalVersion })));

const version2026 = {
  year: firstWaterYear,
  version: revisedVersion,
  methods: methods.map(([key, name, approvedOn]) => ({ key, name, approvedOn })),
  controls: [...baseControls, {
    key: "przewod-sc", method: "przewod", category: "Probkobranie", matrix: "sc", planVersion: revisedVersion,
  }],
};
// A new catalogue starts in its effective year. Unchanged controls retain their stored version.
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

export const waterCompleted = (key, row) => Boolean(row?.doneDate || (waterUsesMeasurements(key) && Object.keys(row?.measurements || {}).length === waterMeasurementTarget));
