import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { assertFails, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import * as firestore from "firebase/firestore";
import { encodeActivities } from "../public/equipment/activity-codec.js";
import { equipmentStore } from "../public/equipment/firestore-store.js";

const { doc, setDoc, updateDoc, getDoc, deleteDoc, serverTimestamp, writeBatch } = firestore;
const projectId = "demo-elab-equip-rules";
const operator = "equip-op";
let env;
const legacy = { name: "Miernik", month: "11", type: "Sprawdzenie", doneDate: "2026-10-04", timestamp: 1 };
const device = { name: "Miernik", number: "", notes: "", status: "active", verified: false, mergedInto: "", nextActivity: 2, registry: 0, revision: 1, activities: encodeActivities([{id:"a1",kind:"Sprawdzenie",label:"",active:true}]) };
const activity = { device: "r1", activity: "a1", kind: "Sprawdzenie", label: "", active: true, revision: 1 };
const op = () => env.authenticatedContext(operator).firestore();
const setMode = mode => env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), "equipmentState", "cutover"), { mode }));
const engine = db => equipmentStore({ db, firestore, userId: () => operator, canWrite: () => true });
const entry = (month, deviceId = "r1") => ({ id: randomUUID(), deviceId, activityId: "a1", month });
const termRow = id => ({ device: "r1", activity: "a1", slots: { "11": id }, position:1 });

before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8") } });
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await Promise.all([setDoc(doc(db,"app_users",operator),{active:true,role:"operator"}),
      setDoc(doc(db,"app_users","disabled"),{active:false,role:"admin"}),
      setDoc(doc(db,"wzorcowanie","old"),legacy),
      setDoc(doc(db,"equipmentDevices","r1"),device),
      setDoc(doc(db,"equipmentState","registry"),{revision:0,device:""}),
      setDoc(doc(db,"equipmentLinks","old"),{device:"r1",activity:"a1",revision:1}),
    ]);
  });
});
after(async () => { await env?.cleanup(); });

test("cutover freezes the legacy collection during preparation, active use and rollback, with protected configuration", async () => {
  const db = op();
  const old = doc(db,"wzorcowanie","old");
  await updateDoc(old,{doneDate:null});
  for (const mode of ["preparing","active","paused"]) {
    await setMode(mode);
    await assertFails(updateDoc(old,{doneDate:"2026-10-05"}));
    await assertFails(deleteDoc(old));
    await assertFails(setDoc(doc(db,"wzorcowanie","new"),legacy));
    assert.equal((await getDoc(old)).data().doneDate,null);
    await assertFails(updateDoc(doc(db,"equipmentState","cutover"),{mode:"legacy"}));
  }
  await assertFails(updateDoc(doc(db,"equipmentDevices","r1"),{revision:2,name:"Zmiana"}));
});

test("all new paths require active authorized users and registry records cannot be erased or malformed", async () => {
  await setMode("active");
  const db = op();
  for (const untrusted of [env.unauthenticatedContext().firestore(),env.authenticatedContext("disabled").firestore()]) {
    for (const path of ["equipmentState/cutover","equipmentDevices/r1","equipmentActivities/r1:a1","equipmentLinks/old",
      "equipmentYears/2026","equipmentYears/2026/versions/whatever","equipmentYears/2026/versions/whatever/rows/r1:a1",
      "equipmentYears/2026/results/one","equipmentHistory/one"]) await assertFails(getDoc(doc(untrusted,path)));
  }
  const card = doc(db,"equipmentDevices","r1");
  await assertFails(updateDoc(card,{name:"Zapis bez rewizji"}));
  await assertFails(updateDoc(card,{revision:2,number:"x".repeat(81)}));
  await assertFails(updateDoc(card,{revision:2,foreignField:true}));
  await assertFails(updateDoc(card,{revision:2,status:"withdrawn",mergedInto:"r1"}));
  await assertFails(updateDoc(card,{revision:2,status:"withdrawn",mergedInto:"brak"}));
  await assertFails(deleteDoc(card));
  await assertFails(setDoc(doc(db,"equipmentActivities","r2:a1"),{...activity,device:"r2"}));
  await assertFails(updateDoc(doc(db,"equipmentActivities","r1:a1"),{revision:2,activity:"a2"}));
  await assertFails(deleteDoc(doc(db,"equipmentActivities","r1:a1")));
  await assertFails(setDoc(doc(db,"equipmentLinks","not-source"),{device:"r1",activity:"a1",revision:1}));
  await assertFails(deleteDoc(doc(db,"equipmentLinks","old")));
  const api = engine(db);
  const before = (await api.loadRegistry()).state.equipment.r1;
  const updated = await api.saveDevice({...before,number:"I-1",nextActivity:3,
    activities:[...before.activities,{id:"a2",kind:"Konserwacja",label:"",active:true}]},before);
  await api.linkSource("old","r1","a2",1);
  assert.equal(updated.state.equipment.r1.activities.length,2);
  await assert.rejects(api.saveDevice({...before,name:"Stary zapis"},before), /zmieniły/);
});

test("splitting and merging preserve the source identity and use atomic registry updates", async () => {
  await setMode("active");
  const db = op(), api = engine(db);
  const split = await api.splitSource({ id:"old", name:legacy.name, type:legacy.type },1);
  const newId = split.state.mapping.assignments.old.groupId;
  assert.notEqual(newId,"r1");
  assert.deepEqual((await getDoc(doc(db,"wzorcowanie","old"))).data(),legacy);
  const merged = await api.mergeDevices(split.state.equipment[newId],split.state.equipment.r1);
  assert.equal(merged.state.equipment[newId].status,"withdrawn");
  assert.equal(merged.state.equipment[newId].mergedInto,"r1");
  assert.equal(merged.state.mapping.assignments.old.groupId,"r1");
  assert.equal((await getDoc(doc(db,"equipmentLinks","old"))).data().device,newId);
  assert.deepEqual((await getDoc(doc(db,"wzorcowanie","old"))).data(),legacy);
});

test("a staged version is private to publication, validated per row, and cannot change after sealing", async () => {
  await setMode("active");
  const db = op(), api = engine(db);
  const id = randomUUID();
  const version = doc(db,"equipmentYears","2026","versions",id);
  await setDoc(version,{author:operator,base:0,mode:"draft",sourceYear:"",sourceVersion:"",sourceRevision:0,priorPublished:"",priorDraft:"",registry:0,total:2,written:0,lastRow:"",state:"open",createdAt:serverTimestamp()});
  const row = doc(db,"equipmentYears","2026","versions",id,"rows","r1:a1");
  const token = randomUUID();
  await assertFails(setDoc(row,{...termRow(token),slots:{"13":token}}));
  await assertFails(setDoc(row,{...termRow(token),slots:{"11":token,"12":token}}));
  await assertFails(setDoc(doc(db,"equipmentYears","2026","versions",id,"rows","r1:a2"),{...termRow(token),activity:"a2"}));
  await assertFails(setDoc(row,termRow(token)));
  await assertFails(updateDoc(version,{written:1,lastRow:"r1:a1"}));
  const batch = writeBatch(db);
  batch.set(row,termRow(token));
  batch.update(version,{written:1,lastRow:"r1:a1"});
  await batch.commit();
  const premature = writeBatch(db);
  premature.update(version,{state:"sealed",sealedAt:serverTimestamp()});
  premature.set(doc(db,"equipmentYears","2026"),{revision:1,published:"",draft:id,last:id,slot:"",action:"draft"});
  await assertFails(premature.commit());
  assert.equal((await api.loadPlan(2026)).revision,0);
  await assertFails(updateDoc(version,{state:"sealed",sealedAt:serverTimestamp()}));
  await assertFails(setDoc(doc(db,"equipmentYears","2026"),{revision:1,published:id,draft:"",last:id,slot:"",action:"approve"}));
  const approved = await api.savePlan(2026,0,{action:"approve",entries:[entry(11)]},randomUUID());
  assert.equal(approved.state.approved.entries.length,1);
  const header = (await getDoc(doc(db,"equipmentYears","2026"))).data();
  const immutable = doc(db,"equipmentYears","2026","versions",header.published,"rows","r1:a1");
  await assertFails(updateDoc(immutable,{"slots.11":randomUUID()}));
  await assertFails(deleteDoc(immutable));
  await assertFails(deleteDoc(doc(db,"equipmentYears","2026")));
  await assert.rejects(api.savePlan(2026,0,{action:"approve",entries:[]},randomUUID()), /zmieniły/);
});

test("execution, correction and undo update three documents atomically and keep immutable history", async () => {
  await setMode("active");
  const db = op(), api = engine(db);
  const approved = await api.savePlan(2026,0,{action:"approve",entries:[entry(11)]},randomUUID());
  const id = approved.state.approved.entries[0].id;
  const first = randomUUID();
  const done = await api.savePlan(2026,1,{action:"complete",entryId:id,doneDate:"2026-10-03",doneNotes:"Pierwszy"},first);
  assert.equal(done.state.approved.entries[0].doneNotes,"Pierwszy");
  const result = doc(db,"equipmentYears","2026","results",id);
  const history = doc(db,"equipmentHistory",first);
  await assertFails(updateDoc(result,{date:"2026-10-05",revision:2,event:randomUUID()}));
  await assertFails(deleteDoc(result));
  await assertFails(updateDoc(history,{notes:"Nadpisano"}));
  await assertFails(deleteDoc(history));
  await assertFails(setDoc(doc(db,"equipmentHistory",randomUUID()),(await getDoc(history)).data()));
  await assert.rejects(api.savePlan(2026,1,{action:"approve",entries:[]},randomUUID()), /zmieniły/);
  await assert.rejects(api.savePlan(2026,2,{action:"approve",entries:[]},randomUUID()), /musi pozostać/);
  const corrected = await api.savePlan(2026,2,{action:"correct",entryId:id,doneDate:"2026-11-04",doneNotes:"Korekta"},randomUUID());
  const undone = await api.savePlan(2026,corrected.revision,{action:"undo",entryId:id},randomUUID());
  assert.equal(undone.state.approved.entries[0].doneDate,null);
  assert.equal(undone.state.approved.entries[0].month,11);
  const page = await api.historyPage({ year:2026 });
  assert.deepEqual(page.entries.map(row=>row.action),["undo","correct","complete"]);
  assert.equal(page.entries[0].before.notes,"Korekta");
  assert.equal((await api.historyPage({year:2027})).entries.length,0);
  await setMode("paused");
  await assertFails(updateDoc(doc(db,"wzorcowanie","old"),{doneDate:null}));
  await assert.rejects(api.savePlan(2026,undone.revision,{action:"complete",entryId:id,doneDate:"2026-11-04"},randomUUID()));
  assert.deepEqual((await api.historyPage({year:2026})).entries,page.entries);
});

test("copy and execution revisions serialize concurrent clients without overwriting a plan or carrying execution into a new year", async () => {
  await setMode("active");
  const a = engine(op()), b = engine(op());
  const approved = await a.savePlan(2026,0,{action:"approve",entries:[entry(11)]},randomUUID());
  const id = approved.state.approved.entries[0].id;
  const done = await a.savePlan(2026,1,{action:"complete",entryId:id,doneDate:"2026-11-04"},randomUUID());
  const registry = await a.loadRegistry();
  const command = {action:"copy",sourceYear:2026,sourceRevision:done.revision,registryRevision:registry.revision,selectedIds:[id]};
  const race = await Promise.allSettled([a.savePlan(2027,0,command,randomUUID()),b.savePlan(2027,0,command,randomUUID())]);
  assert.equal(race.filter(row=>row.status==="fulfilled").length,1);
  const target = await b.loadPlan(2027);
  assert.equal(target.revision,1);
  assert.equal(target.state.approved,null);
  assert.equal(target.state.draft.entries[0].doneDate,null);
  assert.notEqual(target.state.draft.entries[0].id,id);
  assert.equal((await a.loadPlan(2026)).state.approved.entries[0].doneDate,"2026-11-04");
});

test("large card edits and merges have a fixed write set and never truncate a stable activity ID", async () => {
  await setMode("active");
  const api = engine(op()), other = engine(op());
  const registry = await api.loadRegistry();
  const source = registry.state.equipment.r1;
  const kinds = Array.from({ length: 99 }, (_, index) =>
    ({ id: "a" + (index + 2), kind: "Kontrola " + index, label: "Opis · A", active: index % 2 === 0 }));
  let plan = await api.saveDevice({ ...source, activities: [...source.activities, ...kinds] }, source);
  const full = plan.state.equipment.r1;
  assert.equal(full.activities.length, 100);
  assert.equal(full.activities.at(-1).id, "a100");
  const second = { ...source, id: "r2", name: "Karta docelowa" };
  plan = await api.saveDevice(second);
  const merged = await api.mergeDevices(full, plan.state.equipment.r2);
  assert.equal(merged.state.equipment.r2.activities.length, 100);
  assert.equal(merged.state.equipment.r1.activities.length, 100);
  assert.equal(merged.state.equipment.r1.mergedInto, "r2");
  await assert.rejects(other.saveDevice({ ...full, name: "Stare dane" }, full), /zmieniły/);
  const archived = merged.state.equipment.r1;
  await assert.rejects(api.saveDevice({ ...archived, activities: archived.activities.slice(0, 15) }, archived));
  const restored = await api.saveDevice({ ...archived, status: "active", mergedInto: null }, archived);
  assert.equal(restored.state.equipment.r1.activities.at(-1).id, "a100");
});

test("staging keeps a withdrawn planned activity when the same ID belongs to the older draft", async () => {
  await setMode("active");
  const api = engine(op());
  const approved = await api.savePlan(2026,0,{action:"approve",entries:[entry(11)]},randomUUID());
  const planned = await api.savePlan(2026,1,{action:"draft",entries:[...approved.state.approved.entries, entry(12)]},randomUUID());
  const device = (await api.loadRegistry()).state.equipment.r1;
  await api.saveDevice({ ...device, status:"withdrawn" }, device);
  const summarized = await api.savePlan(2026,2,{action:"approve",entries:planned.state.draft.entries},randomUUID());
  assert.deepEqual(summarized.state.approved.entries.map(row=>row.month).sort(),[11,12]);
});

test("capture of registry revision covers edits during copy and rejects an unbound revision advance", async () => {
  await setMode("active");
  const db=op(), api=engine(db);
  const original = await api.savePlan(2026,0,{action:"approve",entries:[entry(11)]},randomUUID());
  const registry = await api.loadRegistry();
  await assertFails(updateDoc(doc(db,"equipmentState","registry"),{revision:1,device:"r1"}));
  const card = registry.state.equipment.r1;
  await api.saveDevice({ ...card, status:"withdrawn" }, card);
  await assert.rejects(api.savePlan(2027,0,{
    action:"copy",sourceYear:2026,sourceRevision:original.revision,
    registryRevision:registry.revision,selectedIds:[original.state.approved.entries[0].id],
  },randomUUID()), /zmieniły/);
  assert.equal((await api.loadPlan(2027)).revision,0);
});


test("copy cannot seal after a separate client edits the registry during staging", async () => {
  await setMode("active");
  const db = op(), api = engine(db), other = engine(op());
  const source = await api.savePlan(2026,0,{action:"approve",entries:[entry(11)]},randomUUID());
  const registration = await api.loadRegistry();
  const card = registration.state.equipment.r1;
  let changed = false;
  const copying = equipmentStore({
    db, userId: () => operator, canWrite: () => true,
    firestore: { ...firestore, writeBatch(...args) {
      const batch = firestore.writeBatch(...args);
      const commit = batch.commit.bind(batch);
      batch.commit = async () => {
        await commit();
        if (!changed) {
          changed = true;
          await other.saveDevice({ ...card, status: "withdrawn" }, card);
        }
      };
      return batch;
    } },
  });
  await assert.rejects(copying.savePlan(2027,0,{
    action:"copy",sourceYear:2026,sourceRevision:source.revision,
    registryRevision:registration.revision,selectedIds:[source.state.approved.entries[0].id],
  },randomUUID()), /zmieniły/);
  assert.ok(changed);
  assert.equal((await other.loadPlan(2027)).revision,0);
  assert.equal((await other.loadPlan(2026)).revision,source.revision);
});
