
import { evolveRegistry, makeInitialRegistry, RegistryError } from "./registry-model.js";

export const emulatorProject = "demo-elab-equipment-register";
const operationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function emulatorStore(dataset, { GCLOUD_PROJECT: project, FIRESTORE_EMULATOR_HOST: host } = process.env) {
  if (project !== emulatorProject || !/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(host ?? "")) {
    throw new Error("Uruchom kreator z lokalnym emulatorem Firestore projektu " + emulatorProject + ".");
  }

  const database = "projects/" + emulatorProject + "/databases/(default)/documents";
  const baseUrl = "http://" + host + "/v1/" + database;
  const path = "/lokalneRejestrySprzetu/" + dataset.fingerprint;
  const historyPath = id => path + "/historia/" + id;

  async function request(suffix, body) {
    let response;
    try {
      response = await fetch(baseUrl + suffix, {
        method: body ? "POST" : "GET",
        headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(7000),
        redirect: "error",
      });
    } catch {
      throw new RegistryError("Lokalny emulator Firestore jest niedostępny.", 503);
    }
    const data = await response.json();
    if (response.status === 404) return null;
    if (!response.ok) {
      const conflict = ["ABORTED", "ALREADY_EXISTS", "FAILED_PRECONDITION"].includes(data.error?.status);
      throw new RegistryError(conflict ? "Rejestr zmienił się podczas zapisu." : "Emulator odrzucił operację.", conflict ? 409 : 503);
    }
    return data;
  }

  function encoded(state, revision) {
    return { revision: { integerValue: String(revision) }, state: { stringValue: JSON.stringify(state) } };
  }

  const write = (suffix, fields, precondition) => ({ update: { name: database + suffix, fields }, currentDocument: precondition });

  async function load() {
    let row = await request(path);
    if (!row) {
      try {
        const state = makeInitialRegistry(dataset.sources);
        await request(":commit", { writes: [write(path, encoded(state, 0), { exists: false })] });
      } catch (error) {
        if (error.status !== 409) throw error;
      }
      row = await request(path);
    }
    return {
      revision: Number(row.fields.revision.integerValue),
      state: JSON.parse(row.fields.state.stringValue),
      updateTime: row.updateTime,
    };
  }

  const publicState = ({ revision, state }) => ({ revision, state });

  async function save({ revision, operationId, command } = {}) {
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof operationId !== "string" || !operationPattern.test(operationId)) {
      throw new RegistryError("Nieprawidłowe żądanie zapisu.");
    }
    const journal = historyPath(operationId);
    const current = await load();
    if (await request(journal)) return publicState(await load());
    if (revision !== current.revision) throw new RegistryError("Rejestr zmienił się w innym oknie. Wczytaj aktualne dane przed zapisem.", 409);
    const { state, affectedId } = evolveRegistry(current.state, command, dataset.sources, operationId);
    const next = revision + 1;
    try {
      await request(":commit", { writes: [
        write(path, encoded(state, next), { updateTime: current.updateTime }),
        write(journal, {
          revision: { integerValue: String(next) },
          savedAt: { timestampValue: new Date().toISOString() },
          action: { stringValue: command.action },
          affectedId: { stringValue: affectedId ?? "" },
          previous: { stringValue: JSON.stringify(current.state) },
        }, { exists: false }),
      ] });
    } catch (error) {
      if (error.status === 409 && await request(journal)) return publicState(await load());
      throw error;
    }
    return { revision: next, state, affectedId };
  }

  return { load: async () => publicState(await load()), save };
}
