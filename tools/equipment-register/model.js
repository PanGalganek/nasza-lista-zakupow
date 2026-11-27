
export const activityKinds = ["Wzorcowanie", "Sprawdzenie", "Kalibracja", "Konserwacja"];
const explicitKind = { wzorcowanie: "Wzorcowanie", sprawdzenie: "Sprawdzenie", kalibracja: "Kalibracja" };
const codePattern = /\b(?:III|II|I)-\d+(?:\/\d+)?(?:\/[WKS])*\b/i;

function inferredCode(name) {
  return name.match(codePattern)?.[0].replace(/(?:\/[WKS])+$/i, "").toUpperCase() ?? "";
}

function proposedName(name) {
  return name.replace(/\s*\((?:sprawdzenie(?: wszystk(?:ie|ich))?|wzorcowanie|kalibracja|konserwacja[^)]*)\)\s*$/i, "")
    .replace(codePattern, "").replace(/\s+/g, " ").trim() || name;
}

export function searchText(value) {
  return value.toLocaleLowerCase("pl").normalize("NFD").replace(/\p{M}/gu, "").replaceAll("ł", "l");
}

function proposalFor(source) {
  const code = inferredCode(source.name);
  const kindInName = explicitKind[source.name.match(/\((wzorcowanie|sprawdzenie|kalibracja)\)$/i)?.[1].toLowerCase()]
    ?? (/\(konserwacja\b/i.test(source.name) ? "Konserwacja" : undefined);
  const kind = kindInName ?? source.type ?? "Wzorcowanie";
  const detail = source.name.match(/^Spektrofotometr \((?:K\/)?S - ([^)]+)\)$/i)?.[1] ?? "";
  let label = detail;
  const notes = [];
  if (!code) notes.push("Brak numeru ewidencyjnego w nazwie.");
  if (code === "I-52") {
    notes.push("Sprawdź, czy oba tory CPC 105 należą do jednego urządzenia.");
    label = /^pH-metr/i.test(source.name) ? "Tor pH" : "Tor przewodności";
  }
  if (detail) notes.push("Ustal aparat. Zachowaj oddzielną czynność dla każdego analitu.");
  if (/^(?:Konduktometr|pH-metr) \(sprawdzenie\)/i.test(source.name)) notes.push("Sprawdź powiązanie z CPC 105.");
  if (/Tlenomierz|Czujnik temperatury/i.test(source.name)) notes.push("Ustal powiązanie urządzenia, sondy lub czujnika.");
  if (/Termometry|Minutniki|Rejestratory/i.test(source.name)) notes.push("Sprawdź, czy wpis oznacza jedną sztukę, zestaw lub kilka urządzeń.");
  if (code === "I-17" || code === "I-17/05" || code === "I-22") notes.push("Zachowaj pełne oznaczenie do potwierdzenia ewidencji.");
  if (kindInName && kindInName !== (source.type ?? "Wzorcowanie")) {
    notes.push("Rodzaj podany w nazwie różni się od rodzaju wyświetlanego w v37.");
  }
  if (/Termohigroment/i.test(source.name)) notes.push("Sprawdź pisownię nazwy.");
  if (kind === "Konserwacja") {
    label = /zewnętrzn/i.test(source.name) ? "Serwis zewnętrzny" : "We własnym zakresie";
    notes.push("Potwierdź rodzaj konserwacji.");
  }
  return { code, name: proposedName(source.name), kind, label, notes };
}

export function createRegister(sources) {
  const proposals = Object.fromEntries(sources.map(source => [source.id, proposalFor(source)]));
  const namesByCode = new Map();
  const nameCounts = new Map();
  for (const source of sources) nameCounts.set(source.name, (nameCounts.get(source.name) ?? 0) + 1);
  for (const source of sources) {
    if (!proposals[source.id].code && nameCounts.get(source.name) > 1) {
      proposals[source.id].notes.push("W kopii są inne terminy pod tą samą nazwą. Potwierdź urządzenie przed połączeniem.");
    }
  }
  for (const proposal of Object.values(proposals)) {
    if (!proposal.code) continue;
    if (!namesByCode.has(proposal.code)) namesByCode.set(proposal.code, new Set());
    namesByCode.get(proposal.code).add(searchText(proposal.name));
  }
  for (const proposal of Object.values(proposals)) {
    if (proposal.code !== "I-52" && namesByCode.get(proposal.code)?.size > 1) {
      proposal.notes.push("Ten sam numer występuje przy różnych urządzeniach. Sprawdź ewidencję.");
    }
  }

  const draft = { groups: [], assignments: Object.create(null), nextGroup: 1 };
  const proposalsByKey = new Map();
  for (const source of sources) {
    const proposal = proposals[source.id];
    const groupable = proposal.code && (proposal.code === "I-52" || namesByCode.get(proposal.code).size === 1);
    const key = groupable ? "number:" + proposal.code : "source:" + source.id;
    if (!proposalsByKey.has(key)) {
      const group = newGroup(draft, proposal.code === "I-52" ? "CPC 105" : proposal.name, proposal.code);
      proposalsByKey.set(key, group.id);
    }
    draft.assignments[source.id] = { groupId: proposalsByKey.get(key), kind: proposal.kind, label: proposal.label };
  }
  return { draft, proposals };
}

function newGroup(draft, name, number = "") {
  const group = { id: "r" + draft.nextGroup++, name, number, approved: false };
  draft.groups.push(group);
  return group;
}

export function groupSources(draft, sources) {
  const grouped = new Map(draft.groups.map(group => [group.id, []]));
  for (const source of sources) grouped.get(draft.assignments[source.id].groupId).push(source);
  return grouped;
}

export function duplicateNumbers(draft) {
  const records = new Map();
  for (const group of draft.groups) {
    const number = searchText(group.number).replace(/\s+/gu, "");
    if (!number) continue;
    if (!records.has(number)) records.set(number, []);
    records.get(number).push(group.id);
  }
  return new Set([...records.values()].filter(ids => ids.length > 1).flat());
}

export function reviseGroup(draft, groupId, fields) {
  const group = draft.groups.find(item => item.id === groupId);
  const updated = { name: fields.name.trim(), number: fields.number.trim() };
  if (group.name === updated.name && group.number === updated.number) return false;
  Object.assign(group, updated, { approved: false });
  return true;
}

export function reviseActivity(draft, sourceId, kind, label) {
  if (!activityKinds.includes(kind)) throw new Error("Wybierz rodzaj czynności.");
  const assignment = draft.assignments[sourceId];
  const trimmedLabel = label.trim();
  if (assignment.kind === kind && assignment.label === trimmedLabel) return false;
  Object.assign(assignment, { kind, label: trimmedLabel });
  draft.groups.find(group => group.id === assignment.groupId).approved = false;
  return true;
}

export function moveSources(draft, fromId, sourceIds, targetId) {
  const from = draft.groups.find(group => group.id === fromId);
  const selected = [...new Set(sourceIds)];
  const groupCount = Object.values(draft.assignments).filter(row => row.groupId === fromId).length;
  if (!from || !selected.length || selected.some(id => draft.assignments[id]?.groupId !== fromId)) {
    throw new Error("Zaznacz pozycje należące do tej grupy.");
  }
  if (!targetId && selected.length === groupCount) {
    throw new Error("Przy podziale zostaw co najmniej jedną pozycję w dotychczasowej grupie.");
  }
  const target = targetId
    ? draft.groups.find(group => group.id === targetId)
    : newGroup(draft, from.name);
  if (!target || target.id === fromId) throw new Error("Wybierz inną grupę docelową.");
  for (const id of selected) draft.assignments[id].groupId = target.id;
  target.approved = false;
  from.approved = false;
  if (selected.length === groupCount) draft.groups = draft.groups.filter(group => group.id !== fromId);
  return target.id;
}

export function setApproval(draft, groupId, approved) {
  const group = draft.groups.find(item => item.id === groupId);
  if (approved && (!group.name.trim() || duplicateNumbers(draft).has(groupId))) {
    throw new Error("Uzupełnij nazwę i rozstrzygnij powtórzony numer ewidencyjny przed zatwierdzeniem.");
  }
  group.approved = approved;
}

export function groupActivities(draft, sources) {
  const activities = new Map();
  for (const source of sources) {
    const { kind, label } = draft.assignments[source.id];
    const key = JSON.stringify([kind, label]);
    if (!activities.has(key)) activities.set(key, { kind, label, sourceIds: [] });
    activities.get(key).sourceIds.push(source.id);
  }
  return [...activities.values()];
}

export function restoreDraft(value, sources) {
  const ids = new Set(sources.map(source => source.id));
  const { groups, assignments, nextGroup } = value ?? {};
  if (!Array.isArray(groups) || !assignments || Array.isArray(assignments) || typeof assignments !== "object"
      || !Number.isSafeInteger(nextGroup) || nextGroup <= 0 || Object.keys(assignments).length !== ids.size) {
    throw new Error("Zapis szkicu ma nieoczekiwany format.");
  }
  const groupIds = new Set();
  for (const group of groups) {
    if (typeof group?.id !== "string" || !/^r[1-9]\d*$/.test(group.id) || Number(group.id.slice(1)) >= nextGroup
        || groupIds.has(group.id) || typeof group.name !== "string" || group.name.length > 200
        || typeof group.number !== "string" || group.number.length > 80
        || typeof group.approved !== "boolean" || (group.approved && !group.name.trim())) {
      throw new Error("Zapis szkicu ma niepoprawną grupę.");
    }
    groupIds.add(group.id);
  }
  const used = new Set();
  for (const [id, assignment] of Object.entries(assignments)) {
    if (!ids.has(id) || !groupIds.has(assignment?.groupId)
        || !activityKinds.includes(assignment.kind) || typeof assignment.label !== "string" || assignment.label.length > 150) {
      throw new Error("Zapis szkicu ma niepoprawne przypisanie.");
    }
    used.add(assignment.groupId);
  }
  if (used.size !== groups.length) throw new Error("Zapis szkicu zawiera pustą grupę.");
  return value;
}

export function createExport(draft, dataset) {
  restoreDraft(draft, dataset.sources);
  if (draft.groups.some(group => !group.approved) || duplicateNumbers(draft).size) {
    throw new Error("Przed eksportem zatwierdź wszystkie pozycje i rozstrzygnij powtórzone numery.");
  }
  const grouped = groupSources(draft, dataset.sources);
  return {
    schemaVersion: 1,
    source: { collection: "wzorcowanie", readTime: dataset.readTime, fingerprint: dataset.fingerprint },
    summary: { sourcePositions: dataset.sources.length, devices: draft.groups.length,
      completedSourcePositions: dataset.sources.filter(source => source.doneDate).length },
    devices: draft.groups.map(group => ({
      localId: group.id, name: group.name, inventoryNumber: group.number || null,
      activities: groupActivities(draft, grouped.get(group.id)),
    })),
    originalPositions: dataset.sources.map(source => ({ ...source })),
  };
}
