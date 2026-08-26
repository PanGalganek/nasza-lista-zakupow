const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function directChildren(element, localName) {
  return [...element.childNodes].filter((node) => node.nodeType === 1 && node.localName === localName);
}

function cellText(cell) {
  const paragraphs = [...cell.getElementsByTagNameNS(WORD_NAMESPACE, "p")];
  return cleanText(paragraphs.map((paragraph) => (
    [...paragraph.getElementsByTagNameNS(WORD_NAMESPACE, "t")].map((node) => node.textContent || "").join("")
  )).join(" "));
}

function isValidCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isoDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseExpiryDate(value) {
  const text = cleanText(value);
  const fullDate = text.match(/\b(0?[1-9]|[12]\d|3[01])[./-](0?[1-9]|1[0-2])[./-](\d{4})\b/);
  if (fullDate) {
    const [, dayText, monthText, yearText] = fullDate;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (isValidCalendarDate(year, month, day)) return { value: isoDate(year, month, day), precision: "day" };
  }

  const monthDate = text.match(/\b(0?[1-9]|1[0-2])[./-](\d{4})\b/);
  if (monthDate) {
    const month = Number(monthDate[1]);
    const year = Number(monthDate[2]);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { value: isoDate(year, month, lastDay), precision: "month" };
  }

  return { value: "", precision: "missing" };
}

export function cleanChemicalName(value) {
  const text = cleanText(value);
  const markers = [
    /\bdata\s+ważności\b/i,
    /\bważn(?:y|a|e)\b/i,
    /\bnr\.?\s*lot\b/i,
    /\blot(?:\s+nr\.?)?\b/i,
    /\bnr\s+serii\b/i,
  ];
  const cutAt = markers
    .map((pattern) => text.search(pattern))
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0];
  return cleanText((cutAt === undefined ? text : text.slice(0, cutAt)).replace(/[\s,;–-]+$/g, ""));
}

export function rowsToChemicalDrafts(rows, { category, received }) {
  return rows.flatMap((cells) => {
    if (cells.length < 4) return [];
    const group = cleanText(cells[1]);
    const sourceName = cleanText(cells[2]);
    const usage = cleanText(cells[3]);
    if (!/^[IVXLCDM]+\s*-\s*\d/i.test(group) || !sourceName) return [];

    const expiry = parseExpiryDate(sourceName);
    const warnings = [];
    if (!expiry.value) warnings.push("Nie rozpoznano daty ważności");
    if (expiry.precision === "month") warnings.push("Podano tylko miesiąc — ustawiono jego ostatni dzień");
    if ((group.match(/[IVXLCDM]+\s*-\s*\d/gi) || []).length > 1) warnings.push("Komórka zawiera kilka numerów grupy");

    return [{
      name: cleanChemicalName(sourceName),
      group,
      usage,
      received,
      expiry: expiry.value,
      category,
      sourceName,
      warnings,
    }];
  });
}

export async function readChemicalRowsFromDocx(arrayBuffer, zipLibrary = globalThis.JSZip) {
  if (!zipLibrary) throw new Error("Nie załadowano modułu odczytu DOCX.");
  const archive = await zipLibrary.loadAsync(arrayBuffer);
  const documentEntry = archive.file("word/document.xml");
  if (!documentEntry) throw new Error("Plik nie zawiera dokumentu Word.");
  const xmlText = await documentEntry.async("text");
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("Nie udało się odczytać struktury dokumentu.");

  return [...xml.getElementsByTagNameNS(WORD_NAMESPACE, "tbl")].flatMap((table) => (
    directChildren(table, "tr").map((row) => directChildren(row, "tc").map(cellText))
  ));
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function chemicalsToCsv(items) {
  const header = ["Kategoria", "Grupa", "Nazwa", "Zastosowanie", "Data przyjęcia", "Data ważności", "Zamówiono"];
  const rows = items.map((item) => [
    item.category || "Wzorce",
    item.group,
    item.name,
    item.usage,
    item.received,
    item.expiry,
    item.ordered ? "tak" : "nie",
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
}

export function createChemicalBackup(items, exportedAt = new Date().toISOString()) {
  return {
    format: "e-laboratorium-odczynniki",
    version: 1,
    exportedAt,
    items: items.map(({ id, ...item }) => ({ id, ...item })),
  };
}

