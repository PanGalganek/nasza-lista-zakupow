import { parseLocalDate } from "../utils.js?v=33";

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
