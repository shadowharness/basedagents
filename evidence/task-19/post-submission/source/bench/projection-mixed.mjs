import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode, label] = process.argv.slice(2);
if (!['off','js','rust-fresh','rust-reuse','rust-u128'].includes(mode) || !/^[a-z0-9-]+$/.test(label ?? '')) throw Error('Use mode label');
const output = path.resolve(root, '../runs', label);
fs.mkdirSync(output, { recursive:true });
const hash = value => createHash('sha256').update(value).digest('hex');
const log = fs.openSync(path.join(output,'server.log'),'wx');
const child = spawn(process.execPath, ['--import','tsx','bench/server.ts'], { cwd:root, stdio:['ignore',log,log,'ipc'],
  env: { PATH:process.env.PATH, HOME:process.env.HOME, NODE_ENV:'production', BENCH_OUTPUT:output, TASK_LIST_PROJECTION_MODE:mode } });
function waitFor(type) {
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => { clean(); reject(Error(`Timeout ${type}`)); },120000);
    const exit = code => { clean(); reject(Error(`Server exit ${code}`)); };
    const message = data => { if(data.type === type) { clean(); resolve(data); } else if(data.type === 'error') { clean(); reject(Error(data.message)); } };
    function clean() { clearTimeout(timer); child.off('exit',exit); child.off('message',message); }
    child.on('exit',exit); child.on('message',message);
  });
}
const agent = new http.Agent({keepAlive:true,maxSockets:4});
let port, db;
const fingerprints = {}, results = [], writes = [];
function request(url) {
  const start = performance.now();
  return new Promise((resolve,reject) => {
    const req = http.get({hostname:'127.0.0.1',port,path:url,agent}, res => {
      const chunks=[]; res.on('data',chunk=>chunks.push(chunk)); res.on('error',reject);
      res.on('end',()=>{
        const elapsed=performance.now()-start, body=Buffer.concat(chunks);
        try {
          if(res.statusCode!==200) throw Error(`HTTP ${res.statusCode}`);
          const value=JSON.parse(body), digest=hash(JSON.stringify(value));
          if(fingerprints[url] && fingerprints[url]!==digest) throw Error(`Changed response: ${url}`);
          fingerprints[url]=digest; resolve(elapsed);
        } catch(e) { reject(e); }
      });
    }); req.setTimeout(30000,()=>req.destroy(Error('HTTP timeout'))); req.on('error',reject);
  });
}
async function load(urls, count, writeEvery=0) {
  let next=0; const times=[], start=performance.now();
  await Promise.all(Array.from({length:4},async()=>{
    while(next<count) {
      const i=next++;
      if(writeEvery && i%writeEvery===0) {
        const began=performance.now();
        // Oldest row is outside all measured pages. This is a real committed
        // public-field change through an independent SQL connection; it
        // invalidates snapshots without changing the compared page bodies.
        db.prepare("UPDATE tasks SET title=? WHERE task_id='task_benchmark_000000'").run(`write-${writes.length}`);
        writes.push(performance.now()-began);
      }
      times.push(await request(urls[i%urls.length]));
    }
  }));
  const sorted=[...times].sort((a,b)=>a-b);
  return {count:times.length,elapsedMs:performance.now()-start,p50:sorted[Math.ceil(sorted.length*.5)-1],p99:sorted[Math.ceil(sorted.length*.99)-1],timesMs:times};
}
try {
  ({port}=await waitFor('ready'));
  db = new Database(path.join(output,'fixture.sqlite')); db.pragma('busy_timeout=5000');
  const urls=(n,step,extra='')=>Array.from({length:n},(_,i)=>`/v1/tasks?status=open&limit=100&offset=${i*step}${extra}`);
  // Every URL is new in this stage; first-build costs are retained separately.
  results.push({scenario:'cold-distinct-pages',runs:[await load(urls(40,137),40)]});
  for(const [name, paths, writeEvery] of [
    ['hot-eight-pages',urls(8,100),0], ['churn-128-pages',urls(128,50),0], ['read-write-eight-pages',urls(8,100),20],
  ]) {
    await load(paths,128);
    const runs=[];
    for(let i=0;i<5;i++) runs.push(await load(paths,400,writeEvery));
    const started=waitFor('profile-started'); child.send({type:'profile-start'}); await started;
    const profilePass=await load(paths,400,writeEvery);
    const stopped=waitFor('profile-stopped'); child.send({type:'profile-stop',name}); await stopped;
    results.push({scenario:name,runs,profilePass});
  }
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
  fs.writeFileSync(path.join(output,'responses.json'),JSON.stringify(fingerprints,null,2));
  fs.writeFileSync(path.join(output,'writes.json'),JSON.stringify({count:writes.length,timesMs:writes},null,2));
  fs.writeFileSync(path.join(output,'metadata.json'),JSON.stringify({mode,node:process.version,cpu:os.cpus()[0].model,availableParallelism:os.availableParallelism(),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),scriptSha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),serverSha256:hash(fs.readFileSync(path.join(root,'bench/server.ts'))),dataset:JSON.parse(fs.readFileSync(path.join(root,'bench/workload.json'))).dataset},null,2));
  fs.writeFileSync(path.join(output,'complete.json'),JSON.stringify({at:new Date().toISOString(),requestsFailed:0}));
  console.log(JSON.stringify({mode,label,scenarios:results.map(r=>({name:r.scenario,p50:r.runs.map(x=>x.p50),p99:r.runs.map(x=>x.p99)})),writes:writes.length}));
} finally {
  db?.close(); agent.destroy(); child.send({type:'stop'}); setTimeout(()=>child.kill('SIGTERM'),5000).unref();
}
