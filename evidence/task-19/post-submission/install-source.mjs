import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(process.argv[2]??'.');
assert.ok(fs.existsSync(path.join(root,'packages/api/src/tasks/list-projection.ts')),'Apply the original optional projection patch first');
const manifest=JSON.parse(fs.readFileSync(path.join(here,'manifest.json'),'utf8'));
let count=0;
for(const entry of manifest.files.filter(f=>f.file.startsWith('source/'))){
 const relative=entry.file.slice('source/'.length);
 const target=path.resolve(root,relative);
 assert.ok(target.startsWith(root+path.sep));
 const bytes=fs.readFileSync(path.join(here,entry.file));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256,relative);
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);count++;
}
console.log(`Installed ${count} hash-verified measured source files.`);
