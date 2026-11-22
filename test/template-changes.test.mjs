import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkTemplateChanges } from '../services/templateChanges.mjs';

const real181 = fs.readFileSync(path.resolve('reports', '181.txt'), 'utf8');
const without181Customer = () => {
  const parsed = JSON.parse(real181.slice(real181.indexOf('{'), real181.lastIndexOf('}') + 1));
  return JSON.stringify({ ...parsed, params_data: parsed.params_data.filter(param => !(param.type === 'txt' && param.opName === 'שווה')) });
};

test('a file changed in git is checked like a change from Rivo', () => {
  assert.equal(checkTemplateChanges([{ type: '181', before: real181, after: real181 }]).failed, false, 'the same file passes');
  const broken = checkTemplateChanges([{ type: '181', before: real181, after: without181Customer() }]);
  assert.equal(broken.failed, true);
  assert.match(broken.results[0].errors[0], /אין סינון לקוח/);
  const garbled = checkTemplateChanges([{ type: '226', before: null, after: 'not a template' }]);
  assert.equal(garbled.failed, true);
  assert.match(garbled.results[0].errors[0], /אינו תקין/);
  const removed = checkTemplateChanges([{ type: '226', before: real181, after: null }]);
  assert.equal(removed.failed, false, 'a removed file is noted, not blocked');
});

test('the pipeline script stops a push whose report file would break something', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-template-changes-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'reports'));
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'reports', '181.txt'), real181);
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  const script = path.resolve('scripts', 'check-template-changes.mjs');
  const run = () => spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8', env: { ...process.env, BASE_SHA: '' } });

  fs.writeFileSync(path.join(repo, 'README'), 'no report change');
  git('add', '.');
  git('commit', '-q', '-m', 'two');
  assert.equal(run().status, 0, 'a push without report changes passes');

  fs.writeFileSync(path.join(repo, 'reports', '181.txt'), without181Customer());
  git('add', '.');
  git('commit', '-q', '-m', 'three');
  const stopped = run();
  assert.equal(stopped.status, 1, stopped.stdout + stopped.stderr);
  assert.match(stopped.stdout, /Report 181: BLOCKED/);
  assert.match(stopped.stdout, /removed: מפתח חשבון/);
});
