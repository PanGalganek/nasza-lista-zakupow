import { formatPolishDate } from "../utils.js?v=34";

const widths = [454, 1417, 3855, 1247, 1106, 1389, 1247, 1049, 1219, 1162, 1191];
const encoder = new TextEncoder();
const xml = (text) => String(text ?? "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function orderColumns(row, date, requester = "") {
  const expiry = formatPolishDate(row.expiry, "");
  const kind = ["O", "B"].includes(row.standardKind) ? `(${row.standardKind})` : "";
  const end = row.expiry === undefined && row.standardKind === undefined ? row.notes || ""
    : [expiry ? "Do" : "", expiry, kind].filter(Boolean).join("\n");
  return ["", [requester, date].filter(Boolean).join("\n"), row.name, row.amount || "", "", "", "", "", "", "", end];
}

function documentXml(rows, date, requester) {
  const border = ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:color="000000"/>`).join("");
  const margins = [["top", 20], ["bottom", 20], ["left", 55], ["right", 55]]
    .map(([side, width]) => `<w:${side} w:w="${width}" w:type="dxa"/>`).join("");
  const typography = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="C00000"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>';
  const textRuns = (value) => String(value ?? "").split(/\r\n|\r|\n/)
    .map((line) => `<w:t xml:space="preserve">${xml(line)}</w:t>`).join("<w:br/>");
  const tableRow = (row) => {
    const description = String(row.name ?? "");
    const allowSplit = /[\r\n]/.test(description) || description.length > 900;
    const cells = orderColumns(row, date, requester).map((value, i) => {
      const keepLines = allowSplit && i === 2 ? "" : "<w:keepLines/>";
      return `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr>${keepLines}<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="${i === 2 ? "left" : "center"}"/>${typography}</w:pPr><w:r>${typography}${textRuns(value)}</w:r></w:p></w:tc>`;
    }).join("");
    return `<w:tr>${allowSplit ? "" : "<w:trPr><w:cantSplit/></w:trPr>"}${cells}</w:tr>`;
  };
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:tbl><w:tblPr><w:tblW w:type="auto" w:w="0"/><w:jc w:val="center"/><w:tblLayout w:type="fixed"/><w:tblBorders>${border}</w:tblBorders><w:tblCellMar>${margins}</w:tblCellMar></w:tblPr>
    <w:tblGrid>${widths.map((value) => `<w:gridCol w:w="${value}"/>`).join("")}</w:tblGrid>
    ${rows.map(tableRow).join("")}</w:tbl>
    <w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="850" w:right="709" w:bottom="850" w:left="709" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
    </w:body></w:document>`;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimalny ZIP bez kompresji. Pakiet DOCX zawiera wyłącznie zdefiniowane części.
function zip(parts) {
  const local = [];
  const central = [];
  let start = 0;
  let directoryLength = 0;
  for (const [path, content] of Object.entries(parts)) {
    const name = encoder.encode(path);
    const data = encoder.encode(content);
    const checksum = crc32(data);
    const fileHeader = new DataView(new ArrayBuffer(30));
    fileHeader.setUint32(0, 0x04034b50, true);
    fileHeader.setUint16(4, 20, true);
    fileHeader.setUint16(12, 33, true);
    fileHeader.setUint32(14, checksum, true);
    fileHeader.setUint32(18, data.length, true);
    fileHeader.setUint32(22, data.length, true);
    fileHeader.setUint16(26, name.length, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(14, 33, true);
    entry.setUint32(16, checksum, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, start, true);
    local.push(fileHeader.buffer, name, data);
    central.push(entry.buffer, name);
    start += 30 + name.length + data.length;
    directoryLength += 46 + name.length;
  }
  const count = Object.keys(parts).length;
  const directory = new DataView(new ArrayBuffer(22));
  directory.setUint32(0, 0x06054b50, true);
  directory.setUint16(8, count, true);
  directory.setUint16(10, count, true);
  directory.setUint32(12, directoryLength, true);
  directory.setUint32(16, start, true);
  return new Blob([...local, ...central, directory.buffer], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

export function createOrderDocx(rows, date, requester = "") {
  if (!rows.length) throw new Error("Wybierz co najmniej jedną pozycję zamówienia.");
  return zip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`,
    "word/document.xml": documentXml(rows, date, requester),
  });
}
