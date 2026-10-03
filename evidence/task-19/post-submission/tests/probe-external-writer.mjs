import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [rootArg, outputArg] = process.argv.slice(2);
const root=path.resolve(rootArg), output=path.resolve(outputArg);
assert.ok(!fs.existsSync(output),'Use a fresh evidence directory');
fs.mkdirSync(output,{recursive:true});
const require=createRequire(path.join(root,'package.json'));
const Database=require('better-sqlite3');
const {serve}=require('@hono/node-server');
const load=file=>import(pathToFileURL(path.join(root,file)).href);
const {initDatabase}=await load('packages/api/src/db/index.ts');
const {runnerMigrationFiles,RUNNER_LOCAL_STATEMENTS}=await load('packages/api/src/db/migration-list.ts');
const {SQLiteAdapter}=await load('packages/api/src/db/sqlite-adapter.ts');
const {default:app,setNodeAdapter}=await load('packages/api/src/index.ts');
const {installTaskProjectionModule,taskProjectionStats}=await load('packages/api/src/tasks/list-projection.ts');
const dbFile=path.join(output,'fixture.sqlite'),db=initDatabase(dbFile);
const migrations=path.join(root,'packages/api/migrations');
for(const name of runnerMigrationFiles(migrations)) db.transaction(()=>db.exec(fs.readFileSync(path.join(migrations,name),'utf8')))();
for(const sql of RUNNER_LOCAL_STATEMENTS) db.exec(sql);
db.transaction(()=>db.exec(fs.readFileSync(path.join(root,'optional/task-projection/install.sql'),'utf8')))();
db.prepare("INSERT INTO agents (id,public_key,name,description,capabilities,protocols) VALUES ('ag_probe',?,'Probe','synthetic','[]','[]')").run(Buffer.alloc(32,1));
const insert=db.prepare("INSERT INTO tasks (task_id,creator_agent_id,title,description,category,required_capabilities,status,created_at,expires_at) VALUES (?,'ag_probe',?,'Synthetic HTTP consistency probe','code','[]','open',?,'2099-01-01T00:00:00.000Z')");
for(let i=0;i<12;i++) insert.run(`task_probe_${i}`,`Original ${i}`,new Date(Date.UTC(2026,0,1)+i*1000).toISOString());
const moduleBytes=fs.readFileSync(path.join(root,'optional/task-projection/task_projection.wasm'));
installTaskProjectionModule(new WebAssembly.Module(moduleBytes));
const adapter=new SQLiteAdapter(db);setNodeAdapter(adapter);
const writer=new Database(dbFile);writer.pragma('busy_timeout=5000');
const modes=['off','rust-u128','rust-u128-etag'];
globalThis.fetch=async()=>{throw Error('External fetch disabled in this localhost probe');};
const events=[],agent=new http.Agent({keepAlive:true});
let server;
const port=await new Promise(resolve=>{server=serve({hostname:'127.0.0.1',port:0,fetch:req=>{
  const mode=req.headers.get('x-probe-mode');assert.ok(modes.includes(mode));
  return app.fetch(req,{TASK_PAYMENTS_ENABLED:'0',TASK_ESCROW_ENABLED:'0',TASK_LIST_PROJECTION_MODE:mode});
}},info=>resolve(info.port));});
const epoch=()=>db.prepare('SELECT incarnation,version FROM task_projection_epoch').get();
const stats=()=>structuredClone(taskProjectionStats(adapter));
const get=(mode,status)=>new Promise((resolve,reject)=>{
  const req=http.get({hostname:'127.0.0.1',port,path:`/v1/tasks?status=${status}&limit=100`,headers:{'x-probe-mode':mode},agent},res=>{
    const chunks=[];res.on('data',x=>chunks.push(x));res.on('error',reject);res.on('end',()=>{try{assert.equal(res.statusCode,200);resolve(JSON.parse(Buffer.concat(chunks)));}catch(e){reject(e);}});
  });req.setTimeout(30000,()=>req.destroy(Error('HTTP timeout')));req.on('error',reject);
});
async function compare(label,status,check){
  const reference=await get('off',status);assert.equal(reference.ok,true);check(reference);
  const responses={off:reference};
  for(const mode of modes.slice(1)){const actual=await get(mode,status);assert.deepEqual(actual,reference,`${label}:${mode}`);check(actual);responses[mode]=actual;}
  events.push({label,status,responses,projectionStats:stats()});return reference;
}
const target='task_probe_11';
const conditionalChecks=[];
const conditional=(tag)=>new Promise((resolve,reject)=>{
  const headers={'x-probe-mode':'rust-u128-etag'};if(tag)headers['If-None-Match']=tag;
  const req=http.get({hostname:'127.0.0.1',port,path:'/v1/tasks?status=open&limit=100',headers,agent},res=>{
    const chunks=[];res.on('data',x=>chunks.push(x));res.on('error',reject);
    res.on('end',()=>resolve({status:res.statusCode,etag:res.headers.etag,body:Buffer.concat(chunks).toString()}));
  });req.on('error',reject);
});
try{
  await compare('warm-open','open',body=>assert.equal(body.tasks.length,12));
  await compare('warm-open-hit','open',body=>assert.equal(body.tasks.length,12));
  await compare('warm-verified','verified',body=>assert.equal(body.tasks.length,0));
  const originalTag=await conditional();assert.equal(originalTag.status,200);assert.ok(originalTag.etag);
  const unchanged=await conditional(originalTag.etag);assert.equal(unchanged.status,304);assert.equal(unchanged.body,'');
  conditionalChecks.push({event:'unchanged',status:unchanged.status,etag:unchanged.etag});
  const beforeTitle={epoch:epoch(),stats:stats()};
  writer.transaction(()=>writer.prepare('UPDATE tasks SET title=? WHERE task_id=?').run('Committed external title',target))();
  assert.equal(epoch().version,beforeTitle.epoch.version+1);
  await compare('committed-title','open',body=>assert.equal(body.tasks.find(row=>row.task_id===target)?.title,'Committed external title'));
  const changed=await conditional(originalTag.etag);assert.equal(changed.status,200);assert.notEqual(changed.etag,originalTag.etag);
  assert.equal(JSON.parse(changed.body).tasks.find(row=>row.task_id===target).title,'Committed external title');
  conditionalChecks.push({event:'committed-update',status:changed.status,etag:changed.etag});
  for(const item of stats()){const before=beforeTitle.stats.find(x=>x.mode===item.mode);assert.equal(item.rebuilds,before.rebuilds+1);assert.equal(item.misses,before.misses+1);}
  writer.transaction(()=>writer.prepare("UPDATE tasks SET status='verified' WHERE task_id=?").run(target))();
  const open=await compare('committed-status-open','open',body=>{assert.equal(body.tasks.length,11);assert.ok(!body.tasks.some(row=>row.task_id===target));});
  const verified=await compare('committed-status-verified','verified',body=>{assert.equal(body.tasks.length,1);assert.equal(body.tasks[0].task_id,target);assert.equal(body.tasks[0].title,'Committed external title');});
  const beforeRollback={epoch:epoch(),stats:stats()};
  writer.exec('BEGIN IMMEDIATE');writer.prepare('UPDATE tasks SET title=? WHERE task_id=?').run('Must roll back',target);writer.exec('ROLLBACK');
  assert.deepEqual(epoch(),beforeRollback.epoch);
  await compare('rollback-open','open',body=>assert.deepEqual(body,open));
  await compare('rollback-verified','verified',body=>assert.deepEqual(body,verified));
  for(const item of stats())assert.equal(item.rebuilds,beforeRollback.stats.find(x=>x.mode===item.mode).rebuilds);
  const beforeMissing=stats();writer.exec('DROP TABLE task_projection_epoch');
  await compare('missing-epoch-open','open',body=>assert.deepEqual(body,open));
  await compare('missing-epoch-verified','verified',body=>assert.deepEqual(body,verified));
  for(const item of stats())assert.equal(item.unavailable,beforeMissing.find(x=>x.mode===item.mode).unavailable+2);
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
  const result={passed:true,at:new Date().toISOString(),scope:'Real localhost HTTP; file-backed SQLite; writer uses a distinct connection; GET starts after COMMIT or ROLLBACK. No in-flight freshness guarantee or performance measurement is asserted.',source:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),node:process.version,moduleSha256:sha(moduleBytes),probeSha256:sha(fs.readFileSync(new URL(import.meta.url))),modes,httpRequests:events.length*modes.length+3,conditionalChecks,events};
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({passed:true,modes:modes.length,httpRequests:result.httpRequests,source:result.source}));
}finally{writer.close();agent.destroy();await new Promise(resolve=>server.close(resolve));db.close();}
