import { evolveRegistry, makeInitialRegistry, RegistryError } from "./registry-model.js";
import { evolvePlan } from "./plan-model.js";

export const emulatorProject = "demo-elab-equipment-register";
const operationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function emulatorStore(dataset, { GCLOUD_PROJECT: project, FIRESTORE_EMULATOR_HOST: host } = process.env) {
  if (project !== emulatorProject || !/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(host ?? "")) {
    throw new Error("Uruchom kreator z lokalnym emulatorem Firestore projektu " + emulatorProject + ".");
  }

  const database = "projects/" + emulatorProject + "/databases/(default)/documents";
  const baseUrl = "http://" + host + "/v1/" + database;
  const root = "/lokalneRejestrySprzetu/" + dataset.fingerprint;

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
      throw new RegistryError(conflict ? "Dane zmieniły się podczas zapisu." : "Emulator odrzucił operację.", conflict ? 409 : 503);
    }
    return data;
  }

  const encoded = (state, revision) => ({ revision: { integerValue: String(revision) }, state: { stringValue: JSON.stringify(state) } });
  const write = (suffix, fields, precondition) => ({ update: { name: database + suffix, fields }, currentDocument: precondition });
  const publicState = ({ revision, state }) => ({ revision, state });

  async function load(path, initial, initialize = false) {
    let row = await request(path);
    if (!row) {
      const state = initial();
      if (!initialize) return { revision: 0, state, updateTime: null };
      try {
        await request(":commit", { writes: [write(path, encoded(state, 0), { exists: false })] });
      } catch (error) {
        if (error.status !== 409) throw error;
      }
      row = await request(path);
    }
    return { revision: Number(row.fields.revision.integerValue), state: JSON.parse(row.fields.state.stringValue), updateTime: row.updateTime };
  }

  const loadRegistry = () => load(root, () => makeInitialRegistry(dataset.sources), true);
  const planPath = year => root + "/plany/" + year;
  const loadPlan = year => load(planPath(year), () => ({ draft: null, approved: null }));

  async function saveVersion(path, read, apply, { revision, operationId, command }) {
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof operationId !== "string" || !operationPattern.test(operationId)) {
      throw new RegistryError("Nieprawidłowe żądanie zapisu.");
    }
    const journal = path + "/historia/" + operationId;
    const current = await read();
    if (await request(journal)) return publicState(await read());
    if (revision !== current.revision) throw new RegistryError("Dane zmieniły się w innym oknie. Wczytaj aktualny stan przed zapisem.", 409);
    const { state, affectedId } = await apply(current.state, command, operationId);
    const next = revision + 1;
    try {
      await request(":commit", { writes: [
        write(path, encoded(state, next), current.updateTime ? { updateTime: current.updateTime } : { exists: false }),
        write(journal, {
          revision: { integerValue: String(next) },
          savedAt: { timestampValue: new Date().toISOString() },
          action: { stringValue: command.action },
          affectedId: { stringValue: affectedId ?? "" },
          previous: { stringValue: JSON.stringify(current.state) },
        }, { exists: false }),
      ] });
    } catch (error) {
      if (error.status === 409 && await request(journal)) return publicState(await read());
      throw error;
    }
    return { revision: next, state, affectedId };
  }

  return {
    load: async () => publicState(await loadRegistry()),
    save: input => saveVersion(root, loadRegistry, (previous, command, id) => evolveRegistry(previous, command, dataset.sources, id), input ?? {}),
    loadPlan: async year => publicState(await loadPlan(year)),
    savePlan: (year, input) => saveVersion(planPath(year), () => loadPlan(year), async (previous, command) => ({
      state: evolvePlan(previous, command, (await loadRegistry()).state.equipment),
    }), input ?? {}),
  };
}
