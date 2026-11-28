import assert from "node:assert/strict";
import { readFile,writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const repo=process.cwd();
const req=createRequire(resolve(repo,"package.json"));
const sdk=req("firebase/firestore");
const {initializeTestEnvironment,assertFails}=req("@firebase/rules-unit-testing");
const {migrationClient}=await import(pathToFileURL(resolve("scripts/equipment-v38-migrate.mjs")));
const {readDataset}=await import(pathToFileURL(resolve("tools/equipment-register/server.mjs")));
const {equipmentStore}=await import(pathToFileURL(resolve("public/equipment/firestore-store.js")));
const [file,oldFile,out]=process.argv.slice(2);
const projectId="demo-elab-ui";
const host=process.env.FIRESTORE_EMULATOR_HOST;
assert.match(host,/^127\.0\.0\.1:[1-9]\d{0,4}$/);
assert.equal(process.env.GCLOUD_PROJECT,projectId);
const backup=JSON.parse(await readFile(file,"utf8"));
const old=JSON.parse(await readFile(oldFile,"utf8"));
assert.equal(backup.projectId,"nasza-lista-zakupow");
const dataset=readDataset(backup);
const {getDoc,collection,getDocs,doc,updateDoc,deleteDoc,setDoc,disableNetwork,enableNetwork}=sdk;
const env=await initializeTestEnvironment({projectId,firestore:{host:"127.0.0.1",port:Number(host.split(":")[1]),rules:await readFile("firestore.rules","utf8")}});
const uid="v38-release-audit-operator";
const db=env.authenticatedContext(uid).firestore();
const db2=env.authenticatedContext(uid).firestore();
const api=equipmentStore({db,firestore:sdk,userId:()=>uid,canWrite:()=>true});
const api2=equipmentStore({db:db2,firestore:sdk,userId:()=>uid,canWrite:()=>true});
const root="projects/"+projectId+"/databases/(default)/documents";
const base="http://"+host+"/v1/"+root;
const headers={Authorization:"Bearer owner","Content-Type":"application/json"};
const localFetch=fetch;
async function rest(path,body){
  const r=await localFetch(base+path,{headers,redirect:"error",method:body?"POST":"GET",body:body?JSON.stringify(body):undefined});
  if(r.status===404) return null;
  assert.ok(r.ok,"HTTP "+r.status);
  return r.json();
}
const enc=part=>part.split("/").map(encodeURIComponent).join("/");
const sourcePath=name=>name.split("/documents/")[1];
const payload=(path,fields)=>({update:{name:root+"/"+path,fields},currentDocument:{exists:false}});
function canon(v){
  if(Array.isArray(v))return v.map(canon);
  if(v&&typeof v==="object")return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])]));
  return v;
}
const values=(records)=>Object.fromEntries(records.map(d=>[sourcePath(d.name),canon(d.fields??{})]));
const flat=Object.values(backup.collections).flat();
async function assertSource(){
  for(const [col,docs] of Object.entries(backup.collections)){
    const current=[];
    let next;
    do {
      const page=await rest("/"+enc(col)+"?pageSize=100"+(next?"&pageToken="+encodeURIComponent(next):""));
      current.push(...(page?.documents??[]).filter(row=>!row.name.endsWith("/"+uid)));
      next=page?.nextPageToken;
    } while(next);
    assert.ok(JSON.stringify(Object.keys(values(current)).sort())===JSON.stringify(Object.keys(values(docs)).sort()),col+" paths "+current.length+" / "+docs.length);
    const actual=values(current);
    for(const [key,fields] of Object.entries(values(docs))) {
      assert.ok(JSON.stringify(actual[key])===JSON.stringify(fields),"Mismatch in "+col);
    }
  }
}
const migration = migrationClient({project:projectId,confirm:projectId,host});
const run = (action,backup) => migration.run(action,{backup});
const point=async (name,db=db2)=>(await getDoc(doc(db,...name.split("/")))).data();
async function verifyOtherModules() {
  for (const lab of ["woda", "scieki"]) {
    const task = doc(db,"harmonogram","rehearsal-"+lab);
    await setDoc(task,{name:"Audyt emulatora",lab,category:"Archiwalna",doneDate:null,timestamp:1});
    await updateDoc(task,{doneDate:"2026-11-27"});
    await deleteDoc(task);
  }
  const calendar = doc(db,"wydarzenia","rehearsal-calendar");
  await setDoc(calendar,{title:"Audyt emulatora",date:"2026-11-27",timestamp:1});
  await updateDoc(calendar,{title:"Audyt kalendarza"});
  await deleteDoc(calendar);
  assert.ok((await getDocs(collection(db,"odczynniki"))).size>0);
}
const summaries={};
try{
  for(let i=0;i<flat.length;i+=40)await rest(":commit",{writes:flat.slice(i,i+40).map(row=>payload(sourcePath(row.name),row.fields??{}))});
  await assertSource();
  await env.withSecurityRulesDisabled(ctx=>setDoc(doc(ctx.firestore(),"app_users",uid),{active:true,role:"operator"}));
  assert.equal((await migration.run("dry-run",{backup,backupProject:backup.projectId})).mode,"legacy");
  assert.equal(await point("equipmentState/cutover"),undefined);
  const row=dataset.sources.find(row=>!row.doneDate&&row.type);
  const legacy=doc(db,"wzorcowanie",row.id);
  await updateDoc(legacy,{doneDate:"2026-11-27"});
  await disableNetwork(db2);
  const delayedLegacy = assertFails(updateDoc(doc(db2,"wzorcowanie",row.id),{doneDate:"2026-11-26"}));
  await run("freeze");
  await enableNetwork(db2);
  await delayedLegacy;
  await assertFails(updateDoc(legacy,{doneDate:null}));
  await assertFails(deleteDoc(legacy));
  await assertFails(setDoc(doc(db,"wzorcowanie","control"),{name:"Kontrola",type:"Sprawdzenie",doneDate:null,month:"01",timestamp:0}));
  await assert.rejects(migration.run("stage",{backup,backupProject:backup.projectId}),/różnią się/);
  assert.equal((await point("equipmentState/cutover")).mode,"preparing");
  await env.withSecurityRulesDisabled(ctx=>updateDoc(doc(ctx.firestore(),"wzorcowanie",row.id),{doneDate:row.doneDate}));
  await verifyOtherModules();
  const frozen = await run("capture");
  await assert.rejects(run("activate",frozen),/Brak zakończonego/);
  let broken=false;
  globalThis.fetch=async (url,options)=>{
    const response=await localFetch(url,options);
    if(!broken&&String(url)===base+":commit"&&response.ok&&options?.body?.includes("/equipmentDevices/")){
      broken=true;
      throw new Error("Kontrolowane przerwanie po potwierdzonej porcji zapisu");
    }
    return response;
  };
  await assert.rejects(run("stage",frozen),/Kontrolowane przerwanie/);
  globalThis.fetch=localFetch;
  const partial=(await rest("/equipmentDevices?pageSize=100"))?.documents?.length??0;
  assert.ok(partial>0&&partial<77);
  assert.equal((await point("equipmentState/cutover")).mode,"preparing");
  const prepared=await run("stage",frozen);
  await run("stage",frozen);
  assert.equal((await point("equipmentState/cutover")).mode,"preparing");
  assert.equal(prepared.differences.wzorcowanie.unchanged,86);
  await run("activate",frozen);
  await verifyOtherModules();
  assert.equal((await point("equipmentState/cutover")).mode,"active");
  assert.equal((await rest("/equipmentYears")).documents?.length??0,0);
  await assertSource();
  const cards=await api.loadRegistry();
  const devices=Object.values(cards.state.equipment);
  const acts=devices.flatMap(d=>d.activities.map(a=>({deviceId:d.id,activityId:a.id})));
  const assigned=new Map();
  for(const row of dataset.sources){
    const item=cards.state.mapping.assignments[row.id];
    const key=item.groupId+":"+item.activityId+":"+row.month;
    if(!assigned.has(key))assigned.set(key,[]);
    assigned.get(key).push(row.id);
  }
  const variant={sourcePositions:dataset.sources.length, sourceExecutions:dataset.sources.filter(row=>row.doneDate).length,
    distinctSlots:assigned.size, ambiguities:[...assigned.values()].filter(rows=>rows.length!==1).map(rows=>rows.length),
    executionMonthDiffers:dataset.sources.filter(row=>row.doneDate&&row.doneDate.slice(5,7)!==row.month).length};
  assert.equal(Object.keys(cards.state.mapping.assignments).length,dataset.sources.length);
  const entries=acts.flatMap(row=>Array.from({length:12},(_,i)=>({id:randomUUID(),...row,month:i+1})));
  let time=Date.now();
  const operation=randomUUID();
  let stagedRows=0;
  const interrupted=equipmentStore({db,firestore:{...sdk,writeBatch(...args){
    const batch=sdk.writeBatch(...args), commit=batch.commit.bind(batch);
    batch.commit=async()=>{ await commit(); if(++stagedRows===23) throw new Error("Przerwany zapis planu"); };
    return batch;
  }},userId:()=>uid,canWrite:()=>true});
  await assert.rejects(interrupted.savePlan(2026,0,{action:"draft",entries},operation),/Przerwany zapis planu/);
  assert.equal((await api2.loadPlan(2026)).revision,0);
  assert.equal((await point("equipmentYears/2026/versions/"+operation)).written,23);
  const draft=await api.savePlan(2026,0,{action:"draft",entries},operation);
  assert.equal(draft.state.draft.entries.length,1020);
  const draftMs=Date.now()-time;
  time=Date.now();
  const published=await api.savePlan(2026,draft.revision,{action:"approve",entries:draft.state.draft.entries},randomUUID());
  const approveMs=Date.now()-time;
  const sourceIds=published.state.approved.entries.map(r=>r.id);
  const cmd={action:"copy",sourceYear:2026,sourceRevision:published.revision,registryRevision:cards.revision,selectedIds:sourceIds};
  time=Date.now();
  const race=await Promise.allSettled([api.savePlan(2027,0,cmd,randomUUID()),api2.savePlan(2027,0,cmd,randomUUID())]);
  assert.equal(race.filter(result=>result.status==="fulfilled").length,1);
  const copied=await api2.loadPlan(2027);
  const copyMs=Date.now()-time;
  assert.equal(copied.state.draft.entries.length,sourceIds.length);
  assert.ok(copied.state.draft.entries.every(item=>!item.doneDate&&!sourceIds.includes(item.id)));
  await assert.rejects(api.savePlan(2027,0,cmd,randomUUID()),/docelowy/);
  time=Date.now();
  const first=published.state.approved.entries[0];
  const edited=await api.savePlan(2026,published.revision,{action:"approve",entries:published.state.approved.entries.filter(r=>r.id!==first.id)},randomUUID());
  const editMs=Date.now()-time;
  const saved=edited.state.approved.entries[0];
  const done=await api.savePlan(2026,edited.revision,{action:"complete",entryId:saved.id,doneDate:"2026-11-27",doneNotes:"Próba emulatora"},randomUUID());
  const event=(await api.historyPage({year:2026})).entries;
  assert.equal(event.length,1);
  await assertFails(updateDoc(legacy,{doneDate:"2026-10-30"}));
  await run("pause");
  await verifyOtherModules();
  await assertFails(updateDoc(legacy,{doneDate:"2026-10-30"}));
  await assertFails(updateDoc(doc(db,"equipmentDevices",devices[0].id),{revision:2,notes:"Test blokady"}));
  assert.deepEqual(await api2.loadPlan(2026),{revision:done.revision,state:done.state});
  assert.deepEqual((await api2.historyPage({year:2026})).entries,event);
  await run("resume");
  assert.deepEqual((await api2.historyPage({year:2026})).entries,event);
  await assertSource();
  const audit=await run("audit",frozen);
  assert.equal(audit.differences.wzorcowanie.unchanged,86);
  assert.equal(audit.differences.equipmentHistory.added,1);
  await assertSource();
  const diff={};
  for(const [name,docs] of Object.entries(backup.collections)){
    const b=values(old.collections[name]??[]), a=values(docs);
    const changed=Object.keys(a).filter(id=>Object.hasOwn(b,id)&&JSON.stringify(a[id])!==JSON.stringify(b[id])).length;
    diff[name]={before:Object.keys(b).length,after:Object.keys(a).length,changed,added:Object.keys(a).filter(id=>!Object.hasOwn(b,id)).length,removed:Object.keys(b).filter(id=>!Object.hasOwn(a,id)).length};
  }
  Object.assign(summaries,{documents:flat.length, variant, devices:devices.length, activities:acts.length, stagedBeforeInterrupt:partial,
    restoreAndPreserve:true, rejectionConcurrentLegacyChange:true, resumedTwice:true, previousPwaFrozen:true, rollbackWithData:true, offlineLegacyRejected:true, resumePlanAfter23Rows:true, moduleSmoke:true, diff,
    fullPlan:{rows:acts.length,terms:entries.length,copied:sourceIds.length,draftMs,approveMs,editMs,copyMs}});
  await writeFile(out,JSON.stringify(summaries,null,2));
  console.log(JSON.stringify(summaries));
}finally{
  globalThis.fetch=localFetch;
  await env.cleanup();
}
