
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { emulatorStore } from "./emulator-store.mjs";
import { RegistryError } from "./registry-model.js";
import { validYear } from "./plan-model.js";

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
  "/": ["equipment.html", "text/html"],
  "/przypisania": ["index.html", "text/html"],
  "/equipment.js": ["equipment.js", "text/javascript"],
  "/api.js": ["api.js", "text/javascript"],
  "/registry-model.js": ["registry-model.js", "text/javascript"],
  "/plan-model.js": ["plan-model.js", "text/javascript"],
  "/planner.js": ["planner.js", "text/javascript"],
  "/execution-model.js": ["execution-model.js", "text/javascript"],
  "/execution.js": ["execution.js", "text/javascript"],
  "/register.js": ["register.js", "text/javascript"],
  "/model.js": ["model.js", "text/javascript"],
  "/style.css": ["style.css", "text/css"],
};

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(data));
}

async function readCommand(request, limit) {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new RegistryError("Oczekiwano danych JSON.", 415);
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > limit) throw new RegistryError("Żądanie zapisu jest zbyt duże.", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RegistryError("Nie udało się odczytać żądania zapisu.");
  }
}

async function run(path, rawPort = "4388") {
  const port = Number(rawPort);
  if (!path || !/^\d+$/.test(rawPort) || port < 1024 || port > 65535) {
    throw new Error('Użycie: node tools/equipment-register/server.mjs "<lokalna kopia .json>" [port]');
  }
  const copy = JSON.parse(await readFile(resolve(path), "utf8"));
  const dataset = readDataset(copy);
  const payload = JSON.stringify(dataset);
  const store = emulatorStore(dataset);
  await store.load();
  const staticFiles = new Map(await Promise.all(Object.entries(assets).map(async ([url, [file, type]]) => [
    url, { body: await readFile(new URL(file, import.meta.url)), type },
  ])));
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", csp);
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.headers.host !== "127.0.0.1:" + port || request.headers["sec-fetch-site"] === "cross-site") {
      response.writeHead(403).end();
      return;
    }
    const relative = request.url.split("?")[0];
    const planRoute = relative.match(/^\/plans\/(\d{4})\.json$/);
    const historyRoute = relative.match(/^\/plans\/(\d{4})\/history\.json$/);
    const year = Number((planRoute ?? historyRoute)?.[1]);
    if ((planRoute || historyRoute) && !validYear(year)) {
      sendJson(response, 400, { message: "Nieprawidłowy rok harmonogramu." });
      return;
    }
    const overview = relative === "/execution.json";
    const readOnly = overview || Boolean(historyRoute);
    if (relative === "/registry.json" || planRoute || readOnly) {
      if (request.method === "GET" || (request.method === "POST" && !readOnly)) {
        if (request.method === "POST" && request.headers.origin !== "http://127.0.0.1:" + port) {
          response.writeHead(403).end();
          return;
        }
        try {
          let load = store.load;
          if (planRoute) load = () => store.loadPlan(year);
          if (historyRoute) load = () => store.loadHistory(year);
          if (overview) load = store.loadSchedule;
          const save = planRoute ? input => store.savePlan(year, input) : store.save;
          const state = request.method === "GET" ? await load() : await save(await readCommand(request, planRoute ? 450_000 : 200_000));
          sendJson(response, 200, state);
        } catch (error) {
          if (error instanceof RegistryError) sendJson(response, error.status, { message: error.message });
          else {
            console.error(error.message);
            sendJson(response, 503, { message: "Lokalny zapis danych jest niedostępny." });
          }
        }
        return;
      }
      response.writeHead(405, { Allow: readOnly ? "GET" : "GET, POST" }).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
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
  server.listen(port, "127.0.0.1", () => console.log("Lokalny rejestr sprzętu (" + dataset.sources.length + " pozycji): http://127.0.0.1:" + port + "/"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(...process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
