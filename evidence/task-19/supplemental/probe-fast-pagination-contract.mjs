import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [repository,destination]=process.argv.slice(2);
assert.ok(repository&&destination&&!fs.existsSync(destination));
const source=f=>import(pathToFileURL(path.resolve(repository,'packages/api/src',f)));
const {initDatabase,closeDatabase}=await source('db/index.ts');
const {runnerMigrationFiles,RUNNER_LOCAL_STATEMENTS}=await source('db/migration-list.ts');
const {SQLiteAdapter}=await source('db/sqlite-adapter.ts');
const {createTestApp}=await source('test-helpers.ts');
globalThis.fetch=async()=>{throw new Error('External fetch disabled');};
const results=[];
const filters=[{}, {category:'code'}, {capability:'analysis'}, {creator:'ag_contract_0'}, {claimer:'ag_contract_1'}, {min_usdc:'1'}, {category:'code',creator:'ag_contract_0'}, {category:'code',claimer:'ag_contract_1'}, {capability:'analysis',min_usdc:'1'}];
const matches=(row,filter)=>Object.entries(filter).every(([key,v])=>{
  if(key==='status')return v==='all'||row.status===v;
  if(key==='capability')return JSON.parse(row.required_capabilities).includes(v);
  if(key==='creator')return row.creator_agent_id===v;
  if(key==='claimer')return row.claimed_by_agent_id===v;
  if(key==='min_usdc')return row.bounty_amount!==null&&Number(row.bounty_amount)>=Number(v)*1e6;
  return row[key]===v;
});
for(const datePattern of ['all-equal','three-date-groups'])for(const insertion of ['forward','permuted']){
  const db=initDatabase(':memory:');
  for(const name of runnerMigrationFiles(path.resolve(repository,'packages/api/migrations')))db.transaction(()=>db.exec(fs.readFileSync(path.resolve(repository,'packages/api/migrations',name),'utf8')))();
  for(const sql of RUNNER_LOCAL_STATEMENTS)db.exec(sql);
  for(let i=0;i<2;i++)db.prepare('INSERT INTO agents (id,public_key,name,description,capabilities,protocols) VALUES (?,?,?,?,?,?)').run(`ag_contract_${i}`,Buffer.alloc(32,i+1),`Contract ${i}`,'Synthetic local fixture','[]','[]');
  const rows=Array.from({length:240},(_,i)=>({task_id:`task_contract_${i}`,creator_agent_id:`ag_contract_${i%2}`,creator_kind:'agent',title:`Task ${i}`,description:'Fixed pagination fixture',status:i<120?'open':'verified',created_at:new Date(Date.UTC(2026,0,1)+(datePattern==='all-equal'?0:i%3)*1000).toISOString(),expires_at:new Date(Date.UTC(2030,0,1)+((i*13)%240)*1000).toISOString(),category:i%3?'code':'research',required_capabilities:i%4?'["analysis"]':'["code"]',claimed_by_agent_id:i%3?null:'ag_contract_1',bounty_amount:i%5?'2000000':null,bounty_network:i%5?'eip155:8453':null}));
  const columns=Object.keys(rows[0]);
  const insert=db.prepare(`INSERT INTO tasks (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
  for(let n=0;n<240;n++){const row=rows[insertion==='forward'?n:n*17%240];insert.run(...columns.map(k=>row[k]));}
  const app=createTestApp(new SQLiteAdapter(db));
  const byId=new Map();
  for(const mutation of ['initial','after-update-delete']){
    if(mutation!=='initial'){
      db.prepare("UPDATE tasks SET status='verified',created_at='2027-01-01T00:00:00.000Z',category='research' WHERE task_id='task_contract_0'").run();
      Object.assign(rows[0],{status:'verified',created_at:'2027-01-01T00:00:00.000Z',category:'research'});
      db.prepare("DELETE FROM tasks WHERE task_id='task_contract_1'").run();
      rows[1].deleted=true;
    }
    for(const variant of ['without-index','fast-index']){
      db.exec('DROP INDEX IF EXISTS idx_tasks_status_created');
      if(variant==='fast-index')db.exec('CREATE INDEX idx_tasks_status_created ON tasks(status,created_at DESC)');
      for(const status of ['open','verified','all',''])for(const filter0 of filters){
        const filter={...filter0,...(status?{status}:{})};
        const eligible=rows.filter(r=>!r.deleted&&matches(r,filter)&& (status||!['cancelled','expired'].includes(r.status)));
        const expectedIds=eligible.map(r=>r.task_id).sort();
        for(const limit of [7,100]){
          const ids=[],dates=[],pages=[];
          for(let offset=0;offset<=eligible.length;offset+=limit){
            const route='/v1/tasks?'+new URLSearchParams({...filter,limit:String(limit),offset:String(offset)});
            const response=await app.request(route);assert.equal(response.status,200,route);
            const body=await response.json();assert.ok(body.ok);assert.equal(body.tasks.length,Math.min(limit,Math.max(0,eligible.length-offset)),route);
            for(const task of body.tasks){
              const row=eligible.find(r=>r.task_id===task.task_id);assert.ok(row,`unexpected ID ${task.task_id}`);
              for(const key of ['title','description','created_at','category','status','bounty_amount'])assert.equal(task[key],row[key]);
              assert.deepEqual(task.required_capabilities,JSON.parse(row.required_capabilities));
              const oracleKey=mutation+':'+task.task_id;
              if(variant==='without-index')byId.set(oracleKey,task);else assert.deepEqual(task,byId.get(oracleKey));
              ids.push(task.task_id);dates.push(task.created_at);
            }
            pages.push({offset,count:body.tasks.length});
          }
          assert.equal(new Set(ids).size,ids.length);
          assert.deepEqual([...ids].sort(),expectedIds);
          assert.ok(dates.every((v,i)=>i===0||dates[i-1]>=v));
          results.push({datePattern,insertion,mutation,variant,filter,limit,pages,eligibleCount:eligible.length,total:ids.length,unique:new Set(ids).size,ordered:true,idSetSha256:createHash('sha256').update(JSON.stringify(expectedIds)).digest('hex')});
        }
      }
    }
  }
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  closeDatabase();
}
const report={scope:'Actual API semantics on static snapshots: independent eligibility, created_at descending, complete adjacent pages, unique IDs and per-ID public values. Equal timestamp order is deliberately unspecified; this is not a performance measurement or concurrent snapshot guarantee.',head:execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),node:process.version,results,summary:{checks:results.length,passed:results.length,failed:0,complete120TiePages:results.filter(r=>r.datePattern==='all-equal'&&r.mutation==='initial'&&r.variant==='fast-index'&&r.limit===100&&r.filter.status==='open'&&Object.keys(r.filter).length===1).map(r=>({insertion:r.insertion,pages:r.pages,total:r.total,unique:r.unique}))}};
fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.summary));
