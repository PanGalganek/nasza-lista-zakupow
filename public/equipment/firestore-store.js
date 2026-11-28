import { decodeActivities, encodeActivities } from "./activity-codec.js?v=38.1";
import { evolvePlan, executionActions, rowKey, validYear } from "./plan-model.js?v=38.1";
import { copyDraft } from "./copy-model.js?v=38.1";
import { executionEvent } from "./execution-model.js?v=38.1";
import { RegistryError } from "./registry-model.js?v=38.1";

const blank = { revision: 0, published: "", draft: "" };
const slot = value => String(value).padStart(2, "0");
const token = id => id.split(":").at(-1);
const keyFor = row => rowKey(row.deviceId, row.activityId);
const executionKey = row => keyFor(row) + ":" + token(row.id);
const stale = () => new RegistryError("Dane zmieniły się w innym oknie. Odśwież widok przed zapisem.", 409);
const occupied = () => new RegistryError("Rok docelowy ma już plan lub szkic. Wybierz inny rok albo anuluj.", 409);

function pack(entries) {
  const rows = new Map();
  for (const { id, deviceId: device, activityId: activity, month } of entries) {
    const key = rowKey(device, activity);
    if (!rows.has(key)) rows.set(key, { device, activity, slots: {} });
    rows.get(key).slots[slot(month)] = token(id);
  }
  return rows;
}

function unpack(documents) {
  return documents.flatMap(({ device, activity, slots }) => Object.entries(slots).map(([month, id]) => ({
    id: rowKey(device, activity) + ":" + id, deviceId: device, activityId: activity, month: Number(month), doneDate: null,
  })));
}

function withResults(entries, results) {
  const completed = new Set(results.filter(row => row.date).map(row => rowKey(row.device, row.activity) + ":" + row.term));
  const map = new Map(entries.filter(entry => !completed.has(entry.id)).map(entry => [keyFor(entry) + ":" + slot(entry.month), entry]));
  for (const result of results) {
    if (!result.date) continue;
    const { device, activity, term, month, date, notes } = result;
    map.set(rowKey(device, activity) + ":" + month, { id: rowKey(device, activity) + ":" + term,
      deviceId: device, activityId: activity, month: Number(month), doneDate: date, ...(notes ? { doneNotes: notes } : {}) });
  }
  return [...map.values()];
}

async function copiedToken(operationId, entryId) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(operationId + ":" + entryId)));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
}

export function equipmentStore({ db, firestore, userId, canWrite }) {
  const { collection, doc, getDoc, getDocFromServer, getDocs, getDocsFromServer, limit, onSnapshot, orderBy, query, runTransaction, serverTimestamp, setDoc, startAfter, where, writeBatch } = firestore;
  const ref = (...path) => doc(db, ...path.map(String));
  const col = (...path) => collection(db, ...path.map(String));
  const yearRef = year => ref("equipmentYears", year);
  const planRef = (year, version) => ref("equipmentYears", year, "versions", version);
  const rows = (year, version) => col("equipmentYears", year, "versions", version, "rows");
  const results = year => col("equipmentYears", year, "results");
  const clock = ref("equipmentState", "registry");
  const versions = new Map();
  const realizations = new Map();
  let registryCache;
  let legacyCache;
  let headers = [];

  function clear() {
    versions.clear();
    realizations.clear();
    registryCache = legacyCache = undefined;
    headers = [];
  }

  function registryFrom(devices, links, clockSnapshot) {
    const equipment = Object.fromEntries(devices.docs.map(document => {
      const value = document.data();
      return [document.id, { ...value, id: document.id, activities: decodeActivities(value.activities) }];
    }));
    const assignments = Object.fromEntries(links.docs.map(doc => {
      const { device, activity, revision } = doc.data();
      let current = equipment[device];
      const original = current?.activities.find(row => row.id === activity);
      const seen = new Set();
      while (current?.mergedInto && equipment[current.mergedInto] && !seen.has(current.id)) {
        seen.add(current.id);
        current = equipment[current.mergedInto];
      }
      const effective = current?.activities.find(row => original && row.kind === original.kind && row.label === original.label);
      return [doc.id, { groupId: current?.id ?? device, activityId: effective?.id ?? activity, revision }];
    }));
    registryCache = { revision: clockSnapshot.data()?.revision, state: { equipment, mapping: { assignments } } };
    return registryCache;
  }

  async function registry() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await getDocFromServer(clock);
      const [devices, links] = await Promise.all([getDocsFromServer(col("equipmentDevices")), getDocsFromServer(col("equipmentLinks"))]);
      const after = await getDocFromServer(clock);
      if (before.data()?.revision === after.data()?.revision) return registryFrom(devices, links, after);
    }
    throw stale();
  }

  function watchRegistry(draw, error) {
    const snapshots = new Map();
    const sources = [col("equipmentDevices"), col("equipmentLinks"), clock];
    const stops = sources.map((source, index) => onSnapshot(source, snapshot => {
      snapshots.set(index, snapshot);
      if (snapshots.size === sources.length) draw(registryFrom(...sources.map((_, key) => snapshots.get(key))));
    }, error));
    return () => stops.forEach(stop => stop());
  }

  function assertWritable() {
    if (!canWrite()) throw new RegistryError("Moduł sprzętu jest dostępny w trybie odczytu.");
  }

  async function legacy() {
    legacyCache ??= getDocs(col("wzorcowanie")).then(result => ({
      sources: result.docs.map(item => {
        const { name, month, type, doneDate } = item.data();
        return { id: item.id, name, month, type, doneDate };
      }),
    })).catch(error => { legacyCache = undefined; throw error; });
    return legacyCache;
  }

  function setHeaders(next) { headers = next; }

  async function readRows(year, version) {
    if (!version) return [];
    const key = year + ":" + version;
    if (!versions.has(key)) {
      versions.set(key, getDocs(rows(year, version)).then(result => unpack(result.docs.map(doc => doc.data())))
        .catch(error => { versions.delete(key); throw error; }));
    }
    return versions.get(key);
  }

  async function stateFor(year, header) {
    const [approved, draft, completed] = await Promise.all([readRows(year, header.published), readRows(year, header.draft), readResults(year, header)]);
    return { approved: header.published ? { entries: withResults(approved, completed) } : null,
      draft: header.draft ? { entries: withResults(draft, completed) } : null };
  }

  function readResults(year, header) {
    if (!header.published) return [];
    const cached = realizations.get(year);
    if (cached?.revision === header.revision) return cached.rows;
    const result = getDocs(results(year)).then(snapshot => snapshot.docs.map(doc => doc.data())).catch(error => {
      if (realizations.get(year)?.rows === result) realizations.delete(year);
      throw error;
    });
    realizations.set(year, { revision: header.revision, rows: result });
    return result;
  }

  async function loadPlan(year) {
    const header = (await getDoc(yearRef(year))).data() ?? blank;
    return { revision: header.revision, state: await stateFor(year, header) };
  }

  async function loadExecution() {
    return Promise.all(headers.filter(([, h]) => h.published).map(async ([year, h]) => ({
      year, revision: h.revision,
      entries: withResults(await readRows(year, h.published), await readResults(year, h)),
    })));
  }

  async function historyPage({ year, deviceId, cursor }) {
    const constraints = [where(deviceId ? "device" : "year", "==", deviceId || String(year)), orderBy("at", "desc"), limit(40)];
    if (cursor) constraints.push(startAfter(cursor));
    const snapshot = await getDocs(query(col("equipmentHistory"), ...constraints));
    return { cursor: snapshot.size === 40 ? snapshot.docs.at(-1) : null, entries: snapshot.docs.map(doc => {
      const event = doc.data();
      return {
        year: Number(event.year), entryId: event.key, deviceId: event.device, activityId: event.activity, month: Number(event.month),
        action: event.action, revision: event.revision, savedAt: event.at.toDate().toISOString(),
        deviceName: event.name, number: event.number, kind: event.kind, label: event.label,
        before: event.beforeDate ? { date: event.beforeDate, notes: event.beforeNotes } : null,
        after: event.date ? { date: event.date, notes: event.notes } : null,
      };
    }) };
  }

  async function stage(year, version, record, packed) {
    const versionRef = planRef(year, version);
    const docState = await getDoc(versionRef);
    const planned = [...packed].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const metadata = { ...record, total: planned.length };
    let written = 0;
    if (!docState.exists()) {
      await setDoc(versionRef, { ...metadata, written, lastRow: "", state: "open", createdAt: serverTimestamp() });
    } else {
      const found = docState.data();
      if (found.state !== "open" || Object.keys(metadata).some(key => found[key] !== metadata[key])) throw stale();
      written = found.written;
      const existing = await getDocs(rows(year, version));
      if (existing.size !== written || found.lastRow !== (planned[written - 1]?.[0] ?? "")) throw stale();
      for (const document of existing.docs) {
        const value = document.data();
        const expected = planned[value.position - 1];
        if (!expected || value.position > written || document.id !== expected[0]
            || value.device !== expected[1].device || value.activity !== expected[1].activity
            || JSON.stringify(Object.entries(value.slots).sort()) !== JSON.stringify(Object.entries(expected[1].slots).sort())) throw stale();
      }
    }
    for (const [rowKey, row] of planned.slice(written)) {
      written++;
      const batch = writeBatch(db);
      batch.set(ref("equipmentYears", year, "versions", version, "rows", rowKey), { ...row, position: written });
      batch.update(versionRef, { written, lastRow: rowKey });
      await batch.commit();
    }
  }

  async function savePlan(year, revision, command, id) {
    assertWritable();
    if (!validYear(year)) throw new RegistryError("Nieprawidłowy rok planu.");
    if (executionActions.has(command.action)) return saveExecution(year, revision, command, id);
    const header = (await getDoc(yearRef(year))).data() ?? blank;
    if (header.last === id) return loadPlan(year);
    if ((await getDoc(planRef(year, id))).data()?.state === "sealed") return loadPlan(year);
    if (command.action === "copy" && header.revision !== 0) throw occupied();
    if (header.revision !== revision) throw stale();
    const activeRegistry = await registry();
    const { equipment } = activeRegistry.state;
    const record = { author: userId(), base: revision, mode: command.action, sourceYear: "", sourceVersion: "", sourceRevision: 0,
      priorPublished: header.published, priorDraft: header.draft, registry: activeRegistry.revision };
    let pending;
    if (command.action === "copy") {
      if (!validYear(command.sourceYear) || command.sourceYear === year) throw new RegistryError("Wybierz dwa różne lata.");
      const source = (await getDoc(yearRef(command.sourceYear))).data() ?? blank;
      if (!source.published || source.revision !== command.sourceRevision || activeRegistry.revision !== command.registryRevision) throw stale();
      const ids = await Promise.all(command.selectedIds.map(entryId => copiedToken(id, entryId)));
      let i = 0;
      const approved = { entries: await readRows(command.sourceYear, source.published) };
      pending = copyDraft(approved, equipment, command.selectedIds, () => ids[i++]).draft;
      Object.assign(record, { sourceYear: String(command.sourceYear), sourceVersion: source.published, sourceRevision: source.revision });
    } else {
      const evolved = evolvePlan(await stateFor(year, header), command, equipment);
      pending = evolved.approved && command.action === "approve" ? evolved.approved : evolved.draft;
    }
    const packed = pack(pending.entries);
    try {
      await stage(year, id, record, packed);
      await runTransaction(db, async transaction => {
        const present = (await transaction.get(yearRef(year))).data() ?? blank;
        if (present.last === id) return;
        if (command.action === "copy" && present.revision !== 0) throw occupied();
        if (present.revision !== revision) throw stale();
        const staged = await transaction.get(planRef(year, id));
        if (staged.data()?.state !== "open" || staged.data().written !== packed.size) throw stale();
        if ((await transaction.get(clock)).data()?.revision !== record.registry) throw stale();
        if (record.sourceYear) {
          const current = (await transaction.get(yearRef(record.sourceYear))).data();
          if (current?.published !== record.sourceVersion || current.revision !== record.sourceRevision) throw stale();
        }
        transaction.update(planRef(year, id), { state: "sealed", sealedAt: serverTimestamp() });
        transaction.set(yearRef(year), { revision: revision + 1, published: command.action === "approve" ? id : header.published,
          draft: command.action === "approve" ? "" : id, last: id, slot: "", action: command.action });
      });
    } catch (error) {
      if ((await getDoc(yearRef(year))).data()?.last === id) return loadPlan(year);
      if (command.action === "copy" && (await getDoc(yearRef(year))).exists()) throw occupied();
      if (error.code === "permission-denied" || error.code === "aborted") throw stale();
      throw error;
    }
    return loadPlan(year);
  }

  async function saveExecution(year, revision, command, id) {
    const header = (await getDoc(yearRef(year))).data() ?? blank;
    if (await getDoc(ref("equipmentHistory", id)).then(doc => doc.exists())) return loadPlan(year);
    if (header.revision !== revision) throw stale();
    const activeRegistry = registryCache ?? await registry();
    const data = await stateFor(year, header);
    const current = data.approved?.entries.find(row => row.id === command.entryId);
    const after = evolvePlan(data, command, activeRegistry.state.equipment).approved.entries.find(row => row.id === command.entryId);
    const key = executionKey(current);
    const device = (await getDocFromServer(ref("equipmentDevices", current.deviceId))).data();
    const activity = decodeActivities(device.activities).find(row => row.id === current.activityId);
    await runTransaction(db, async transaction => {
      const eventRef = ref("equipmentHistory", id);
      const resultRef = ref("equipmentYears", year, "results", key);
      const [annual, event, result] = await Promise.all([
        transaction.get(yearRef(year)), transaction.get(eventRef), transaction.get(resultRef),
      ]);
      if (event.exists()) return;
      if (annual.data()?.revision !== revision) throw stale();
      const next = (result.data()?.revision ?? 0) + 1;
      const execution = executionEvent(command.action, current, after);
      const location = { device: current.deviceId, activity: current.activityId, term: token(current.id), month: slot(current.month) };
      transaction.set(resultRef, { ...location, date: after.doneDate ?? "", notes: after.doneNotes ?? "", revision: next, event: id });
      transaction.set(eventRef, { ...location, year: String(year), key, action: execution.action, revision: next, at: serverTimestamp(),
        beforeDate: execution.before?.date ?? "", beforeNotes: execution.before?.notes ?? "",
        date: execution.after?.date ?? "", notes: execution.after?.notes ?? "",
        name: device.name, number: device.number, kind: activity.kind, label: activity.label });
      transaction.set(yearRef(year), { ...annual.data(), revision: revision + 1, last: id, slot: key, action: "execute" });
    });
    return loadPlan(year);
  }

  function cardFields({ name, number, notes, status, verified, mergedInto, activities }, revision, registry) {
    return { name, number, notes, status, verified, mergedInto: mergedInto ?? "", activities: encodeActivities(activities),
      revision, registry, nextActivity: activities.length + 1 };
  }

  async function saveDevice(value, previous) {
    assertWritable();
    await runTransaction(db, async transaction => {
      const deviceRef = ref("equipmentDevices", value.id);
      const [card, version] = await Promise.all([transaction.get(deviceRef), transaction.get(clock)]);
      if ((card.data()?.revision ?? 0) !== (previous?.revision ?? 0)) throw stale();
      const next = version.data().revision + 1;
      transaction.set(deviceRef, cardFields(value, (previous?.revision ?? 0) + 1, next));
      transaction.update(clock, { revision: next, device: value.id });
    });
    return registry();
  }

  async function linkSource(id, device, activity, revision) {
    assertWritable();
    const reference = ref("equipmentLinks", id);
    await runTransaction(db, async transaction => {
      const current = await transaction.get(reference);
      if ((current.data()?.revision ?? 0) !== revision) throw stale();
      transaction.set(reference, { device, activity, revision: revision + 1 });
    });
    return registry();
  }

  async function splitSource(source, revision) {
    assertWritable();
    const link = ref("equipmentLinks", source.id);
    const id = "eq-" + crypto.randomUUID();
    await runTransaction(db, async transaction => {
      const [current, version] = await Promise.all([transaction.get(link), transaction.get(clock)]);
      if ((current.data()?.revision ?? 0) !== revision) throw stale();
      const next = version.data().revision + 1;
      const value = { name: source.name, number: "", notes: "", status: "active", verified: false,
        activities: [{ id: "a1", kind: source.type ?? "Wzorcowanie", label: "", active: true }] };
      transaction.set(ref("equipmentDevices", id), cardFields(value, 1, next));
      transaction.update(clock, { revision: next, device: id });
      transaction.set(link, { device: id, activity: "a1", revision: revision + 1 });
    });
    return registry();
  }

  async function mergeDevices(source, target) {
    assertWritable();
    if (source.id === target.id || source.status !== "active" || target.status !== "active") throw stale();
    const matches = (a, b) => a.kind === b.kind && a.label === b.label;
    const missing = source.activities.filter(row => !target.activities.some(candidate => matches(row, candidate)));
    if (target.nextActivity + missing.length > 101) throw new RegistryError("Karta docelowa osiągnęła limit 100 czynności.");
    await runTransaction(db, async transaction => {
      const a = ref("equipmentDevices", source.id);
      const b = ref("equipmentDevices", target.id);
      const [before, after, version] = await Promise.all([transaction.get(a), transaction.get(b), transaction.get(clock)]);
      if (before.data()?.revision !== source.revision || after.data()?.revision !== target.revision) throw stale();
      const next = version.data().revision + 1;
      const activities = [...target.activities, ...missing.map((row, index) => ({ ...row, id: "a" + (target.nextActivity + index) }))];
      transaction.set(a, cardFields({ ...source, status: "withdrawn", mergedInto: target.id }, source.revision + 1, next));
      transaction.set(b, cardFields({ ...target, activities }, target.revision + 1, next));
      transaction.update(clock, { revision: next, device: source.id });
    });
    return registry();
  }

  return { clear, setHeaders, watchRegistry, loadRegistry: registry, loadSource: legacy, loadPlan, loadExecution, historyPage,
    savePlan, saveDevice, linkSource, splitSource, mergeDevices };
}
