import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateReportNumbers } from '../services/reportNumberMigration.mjs';

const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-renumber-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'report-templates');
  for (const [type, version, text] of [['198', 'v198', 'a'], ['280', 'v280', 'kartest'], ['227', 'v227', 'old 227'], ['225', 'v225', 'old 225']]) {
    fs.mkdirSync(path.join(dir, 'versions', type), { recursive: true });
    fs.writeFileSync(path.join(dir, 'versions', type, `${version}.txt`), text);
  }
  fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ 198: 'v198', 280: 'v280', 227: 'v227' }));
  fs.writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ 280: 'כרטסת API' }));
  fs.writeFileSync(path.join(dir, 'hrep-ids.json'), JSON.stringify({ 280: '229', 999: '231' }));
  fs.writeFileSync(path.join(dir, 'git-hashes.json'), JSON.stringify({ 280: 'h280' }));
  fs.writeFileSync(path.join(dir, 'updates.log'), [
    JSON.stringify({ type: '280', action: 'update', ok: true, version: 'v280' }),
    JSON.stringify({ type: '198', action: 'update', ok: true, version: 'v198' }),
    ''
  ].join('\n'));
  return { root, dir, backups: path.join(root, 'backups') };
}

test('the folder moves from the number in the name to the מזהה, all at once, with a copy first', (t) => {
  const { dir, backups } = folder(t);
  const result = migrateReportNumbers({ dir, backupDir: backups, now: () => new Date('2026-11-23T08:00:00Z'), log: () => {} });
  assert.deepEqual(result.moved.sort(), ['225', '227', '280']);

  const read = (type, version) => fs.readFileSync(path.join(dir, 'versions', type, `${version}.txt`), 'utf8');
  assert.equal(read('229', 'v280'), 'kartest', '280 is now 229');
  assert.equal(read('228', 'v227'), 'old 227', 'old 227 is now 228');
  assert.equal(read('227', 'v225'), 'old 225', 'old 225 is now 227, without taking the place of old 227');
  assert.equal(read('198', 'v198'), 'a', 'other reports stay');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'versions')).sort(), ['198', '227', '228', '229']);

  assert.deepEqual(json(path.join(dir, 'active.json')), { 198: 'v198', 229: 'v280', 228: 'v227' });
  assert.deepEqual(json(path.join(dir, 'names.json')), { 229: 'כרטסת API' });
  assert.deepEqual(json(path.join(dir, 'hrep-ids.json')), { 999: '231' }, 'a מזהה equal to the report number is dropped');
  assert.deepEqual(json(path.join(dir, 'git-hashes.json')), { 229: 'h280' });
  const log = fs.readFileSync(path.join(dir, 'updates.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(log.map(entry => [entry.type, entry.movedFrom]), [['229', '280'], ['198', undefined]]);

  assert.ok(fs.existsSync(path.join(backups, 'before-report-numbers-2026-11-23', 'versions', '280', 'v280.txt')), 'the copy before the move');
  assert.deepEqual(migrateReportNumbers({ dir, backupDir: backups, log: () => {} }), { skipped: 'done before' }, 'it runs once');
});

test('nothing moves when a target number already has versions of its own', (t) => {
  const { dir, backups } = folder(t);
  fs.mkdirSync(path.join(dir, 'versions', '229'));
  const result = migrateReportNumbers({ dir, backupDir: backups, log: () => {} });
  assert.deepEqual(result, { skipped: 'clash', clashes: ['229'] });
  assert.ok(fs.existsSync(path.join(dir, 'versions', '280')), 'the folder is left as it was');
  assert.equal(migrateReportNumbers({ dir: path.join(dir, 'missing'), log: () => {} }).skipped, 'no folder');
});
