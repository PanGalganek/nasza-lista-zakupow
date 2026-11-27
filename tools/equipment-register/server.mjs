
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const collection = "wzorcowanie";
const types = new Set(["Wzorcowanie", "Sprawdzenie", "Kalibracja"]);

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function readDataset(copy) {
  const documents = copy?.collections?.[collection];
  if (!Array.isArray(documents) || documents.length === 0 || typeof copy.readTime !== "string"
      || !Number.isFinite(Date.parse(copy.readTime))) {
    throw new Error("Wybierz istniejącą kopię Firestore zawierającą kolekcję „wzorcowanie” i czas odczytu.");
  }
  const seen = new Set();
  const sources = documents.map(document => {
    const id = document.name?.match(/\/wzorcowanie\/([^/]+)$/)?.[1];
    const fields = document.fields;
    const name = fields?.name?.stringValue;
    const month = fields?.month?.stringValue;
    const dateField = fields?.doneDate;
    const doneDate = dateField?.stringValue ?? null;
    const hasType = Object.hasOwn(fields ?? {}, "type");
    const type = fields?.type?.stringValue;
    if (!id || seen.has(id) || typeof name !== "string" || !name.trim()
        || !/^(0[1-9]|1[0-2])$/.test(month) || !dateField
        || (doneDate === null ? dateField.nullValue !== null : doneDate !== "" && !validDate(doneDate))
        || (hasType && !types.has(type))) {
      throw new Error("Nieprawidłowa pozycja „wzorcowanie” w kopii: " + (id ?? "bez identyfikatora"));
    }
    seen.add(id);
    return { id, name, month, ...(hasType ? { type } : {}), doneDate };
  }).sort((a, b) => a.id.localeCompare(b.id, "en"));
  return {
    readTime: copy.readTime,
    fingerprint: createHash("sha256").update(JSON.stringify(sources)).digest("hex"),
    sources,
  };
}

const assets = {
  "/": ["index.html", "text/html"],
  "/register.js": ["register.js", "text/javascript"],
  "/model.js": ["model.js", "text/javascript"],
  "/style.css": ["style.css", "text/css"],
};

async function run(path, rawPort = "4388") {
  const port = Number(rawPort);
  if (!path || !/^\d+$/.test(rawPort) || port < 1024 || port > 65535) {
    throw new Error('Użycie: node tools/equipment-register/server.mjs "<lokalna kopia .json>" [port]');
  }
  const copy = JSON.parse(await readFile(resolve(path), "utf8"));
  const dataset = readDataset(copy);
  const payload = JSON.stringify(dataset);
  const staticFiles = new Map(await Promise.all(Object.entries(assets).map(async ([url, [file, type]]) => [
    url, { body: await readFile(new URL(file, import.meta.url)), type },
  ])));
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", csp);
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.headers.host !== "127.0.0.1:" + port || request.headers["sec-fetch-site"] === "cross-site") {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    const relative = request.url.split("?")[0];
    const asset = relative === "/source.json" ? { body: payload, type: "application/json" } : staticFiles.get(relative);
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": asset.type + "; charset=utf-8" }).end(asset.body);
  });
  server.on("error", error => {
    console.error("Nie udało się uruchomić lokalnego kreatora: " + error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => console.log("Kreator sprzętu (" + dataset.sources.length + " pozycji): http://127.0.0.1:" + port + "/"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(...process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
