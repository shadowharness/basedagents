import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Run on Linux with Node 22.23.3 and the native build prerequisites in bench/README.md.
// Dependencies and public source are downloaded during setup; every benchmark is loopback-only.
const [destination, mode = 'full'] = process.argv.slice(2);
assert.ok(destination && ['full', 'smoke'].includes(mode), 'Use reproduce.mjs <new-parent-directory> [full|smoke]');
assert.equal(process.platform, 'linux', 'Recorded environment is Linux');
assert.equal(process.version, 'v22.23.3', 'Use the recorded Node version for comparison');
const parent = path.resolve(destination);
assert.equal(fs.existsSync(parent), false, 'Choose a new directory to preserve earlier evidence');
const evidence = path.dirname(fileURLToPath(import.meta.url));
const mapping = JSON.parse(fs.readFileSync(path.join(evidence, 'commit-map.json'), 'utf8'));
fs.mkdirSync(parent, { recursive: true });
const repository = path.join(parent, 'fork');
const command = (program, args, cwd = repository, capture = false) => execFileSync(program, args, {
  cwd, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8',
  env: { ...process.env, GIT_COMMITTER_NAME: 'Benchmark reproduction', GIT_COMMITTER_EMAIL: 'benchmark@example.invalid' },
});
command('git', ['clone', 'https://github.com/maxfain/basedagents.git', repository], parent);
command('git', ['checkout', '--detach', mapping.upstream]);
const revisions = [];
for (let i = 0; i < mapping.mapping.length; i++) {
  const entry = mapping.mapping[i];
  command('git', ['am', path.join(evidence, entry.patch)]);
  assert.equal(command('git', ['rev-parse', 'HEAD^{tree}'], repository, true).trim(), entry.tree);
  const revision = command('git', ['rev-parse', 'HEAD'], repository, true).trim();
  revisions.push(revision);
  if (i === 2) {
    command('npm', ['ci', '--no-audit', '--no-fund']);
    command('npm', ['run', 'build:dist', '--workspace=@basedagents/keyring']);
  }
  if (i >= 2) {
    command('npm', ['test']);
    command(process.execPath, ['bench/run.mjs', i === 2 ? 'replay-baseline' : `replay-opt${i-2}`, mode]);
  }
}
for (const [label, revision] of [['replay-baseline-control', revisions[2]], ['replay-optimized-control', revisions[5]]]) {
  command('git', ['checkout', '--detach', revision]);
  command(process.execPath, ['bench/run.mjs', label, mode]);
}
console.log(JSON.stringify({ mode, output: path.join(parent, 'runs'), performanceEvidence: mode === 'full' }));
