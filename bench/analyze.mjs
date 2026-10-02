import fs from 'node:fs';
import path from 'node:path';
const directory = process.argv[2];
if (!directory) throw new Error('Use analyze.mjs <completed-run-directory>');
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
const complete = read('complete.json');
const metadata = read('metadata.json');
const results = read('results.json');
if (complete.endpoints !== results.length || complete.requestsFailed !== 0) throw new Error('Incomplete run');
const span = values => ({ min: Math.min(...values), max: Math.max(...values) });
const endpoints = results.map(result => {
  const name = result.endpoint.name;
  const queries = read(`${name}.sql.json`);
  const profile = read(`${name}.cpuprofile`);
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const times = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const frame = nodes.get(profile.samples[i]).callFrame;
    const key = `${frame.functionName || '(anonymous)'} ${frame.url || ''}:${frame.lineNumber + 1}`;
    times.set(key, (times.get(key) || 0) + profile.timeDeltas[i] / 1000);
  }
  return {
    name, responseSha256: result.responseSha256,
    medianP50: result.medianP50, medianP99: result.medianP99,
    p50Range: span(result.runs.map(run => run.p50)),
    p99Range: span(result.runs.map(run => run.p99)),
    throughputRange: span(result.runs.map(run => run.requestsPerSecond)),
    sqlTotalMs: queries.reduce((sum, query) => sum + query.totalMs, 0),
    queries: queries.map(query => ({ sql: query.sql, count: query.count, totalMs: query.totalMs,
      perRequestMs: query.totalMs / metadata.workload.profileRequests, plan: query.plan })),
    cpuSelfMs: [...times].sort((a, b) => b[1] - a[1]).slice(0, 15),
  };
});
console.log(JSON.stringify({ metadata, complete, endpoints }, null, 2));
