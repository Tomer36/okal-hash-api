import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTemplateBackup } from '../services/templateBackup.mjs';

test('the report-templates folder is copied once a day, a day folder replaced, old days removed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-template-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'report-templates');
  const backups = path.join(root, 'backups');
  fs.mkdirSync(path.join(source, 'versions', '198'), { recursive: true });
  fs.writeFileSync(path.join(source, 'active.json'), '{"198":"v1"}');
  fs.writeFileSync(path.join(source, 'versions', '198', 'v1.txt'), 'template');

  let today = new Date('2026-11-20T10:00:00Z');
  const backup = createTemplateBackup({ sourceDir: source, backupDir: backups, keep: 2, now: () => today, log: () => {} });
  assert.equal(backup.run(), path.join(backups, '2026-11-20'));
  assert.equal(fs.readFileSync(path.join(backups, '2026-11-20', 'versions', '198', 'v1.txt'), 'utf8'), 'template');

  fs.writeFileSync(path.join(source, 'active.json'), '{"198":"v2"}');
  backup.run();
  assert.equal(fs.readFileSync(path.join(backups, '2026-11-20', 'active.json'), 'utf8'), '{"198":"v2"}', 'the same day is replaced');

  today = new Date('2026-11-21T10:00:00Z');
  backup.run();
  today = new Date('2026-11-22T10:00:00Z');
  backup.run();
  assert.deepEqual(fs.readdirSync(backups).sort(), ['2026-11-21', '2026-11-22'], 'only the newest days are kept');
});

test('nothing to copy before the folder exists; a failing copy is reported, not thrown', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-template-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(createTemplateBackup({ sourceDir: path.join(root, 'missing'), backupDir: path.join(root, 'b'), log: () => {} }).run(), null);

  const source = path.join(root, 'src');
  fs.mkdirSync(source);
  const blocker = path.join(root, 'not-a-folder');
  fs.writeFileSync(blocker, 'x');
  const warnings = [];
  const stop = createTemplateBackup({ sourceDir: source, backupDir: path.join(blocker, 'inside'), log: () => {}, warn: message => warnings.push(message) }).start();
  stop();
  assert.match(warnings[0], /backup to .* failed/);
});
