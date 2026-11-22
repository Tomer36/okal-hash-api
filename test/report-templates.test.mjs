import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyFilterValues, createTemplateStore, parseTemplateText, summarizeParams } from '../services/reportTemplates.mjs';

const reportsDir = path.resolve('reports');
const read = file => fs.readFileSync(path.join(reportsDir, file), 'utf8');

function temporaryStore(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-templates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-21T08:00:00.000Z');
  const store = createTemplateStore({
    builtInDir: reportsDir,
    overrideDir: path.join(root, 'overrides'),
    now: () => new Date(clock += 1000),
    warn: () => {},
    ...options
  });
  return { store, root };
}

test('every template in reports/ passes the check, so the check is not stricter than real files', () => {
  for (const file of fs.readdirSync(reportsDir).filter(name => name.endsWith('.txt'))) {
    assert.doesNotThrow(() => parseTemplateText(read(file)), file);
  }
});

test('hrep output with console noise around the JSON is accepted', () => {
  const output = `\r\nC:\\Hash7>hrep 3 198\r\n\r\n${JSON.stringify(parseTemplateText(read('198.txt')))}\r\nC:\\Hash7>`;
  const template = parseTemplateText(output);
  assert.ok(template.encrypt_reportData);
  assert.ok(summarizeParams(template).some(param => param.field === 'מספר כרטיס חשבון'));
});

test('broken output is rejected with a reason', () => {
  const good = parseTemplateText(read('198.txt'));
  const garbled = { ...good, params_data: good.params_data.map(p => ({ ...p, name: p.name.replace(/[֐-׿]/g, '?') })) };
  const replaced = { ...good, params_data: [{ ...good.params_data[0], name: `${good.params_data[0].name}�` }] };
  assert.throws(() => parseTemplateText(JSON.stringify(garbled)), /קידוד/);
  assert.throws(() => parseTemplateText(JSON.stringify(replaced)), /קידוד/);
  assert.throws(() => parseTemplateText('Access denied'), /לא נמצא JSON/);
  assert.throws(() => parseTemplateText('{"encrypt_reportData": "x",'), /לא נמצא JSON|אינו JSON/);
  assert.throws(() => parseTemplateText(JSON.stringify({ params_data: [] })), /encrypt_reportData/);
  assert.throws(() => parseTemplateText(JSON.stringify({ encrypt_reportData: 'x' })), /params_data/);
});

test('versions switch the file in use and back to git, without touching reports/', (t) => {
  const { store } = temporaryStore(t);
  const gitFile = path.join(reportsDir, '198.txt');
  const before = read('198.txt');
  assert.equal(store.resolve('198'), gitFile);

  const template = { ...parseTemplateText(before), encrypt_reportData: 'new' };
  const first = store.saveVersion('198', template);
  assert.equal(store.resolve('198'), gitFile, 'a saved version is not used until activated');
  store.activate('198', first);
  assert.equal(parseTemplateText(fs.readFileSync(store.resolve('198'), 'utf8')).encrypt_reportData, 'new');

  const second = store.saveVersion('198', { ...template, encrypt_reportData: 'newer' });
  store.activate('198', second);
  assert.deepEqual(store.versions('198'), [first, second]);
  store.activate('198', first);
  assert.equal(store.activeVersion('198'), first);
  store.activate('198', null);
  assert.equal(store.resolve('198'), gitFile);
  assert.equal(read('198.txt'), before);
});

test('a new report number can exist only as a version', (t) => {
  const { store } = temporaryStore(t);
  assert.equal(store.resolve('999'), null);
  const version = store.saveVersion('999', parseTemplateText(read('198.txt')));
  store.activate('999', version);
  assert.ok(store.resolve('999'));
  assert.ok(store.list().some(item => item.type === '999' && !item.inGit && item.version === version));
  assert.throws(() => store.activate('999', null), /אין קובץ מקורי/);
});

test('unsafe names are refused and a damaged state file falls back to git', (t) => {
  const warnings = [];
  const { store, root } = temporaryStore(t, { warn: message => warnings.push(message) });
  assert.equal(store.resolve('../config/default'), null);
  assert.throws(() => store.activate('198', '../../config/default'), /לא נמצאה/);
  fs.mkdirSync(path.join(root, 'overrides'), { recursive: true });
  fs.writeFileSync(path.join(root, 'overrides', 'active.json'), '{ broken');
  assert.equal(store.resolve('198'), path.join(reportsDir, '198.txt'));
  assert.equal(warnings.length, 1);
});

test('filter values go in by filter, never into dates or the customer, and a removed filter is skipped only on request', () => {
  const template = {
    encrypt_reportData: 'x',
    params_data: [
      { id: '0', type: 'long', name: 'שדה/קוד מיון', defVal: '300', opName: 'מ..עד', opOrigin: 'from' },
      { id: '1', type: 'date', name: 'שדה/תאריך', defVal: '01/01/2020', opName: 'מ..עד', opOrigin: 'from' },
      { id: '2', type: 'txt', name: 'שדה/מפתח חשבון', defVal: '', opName: 'שווה', opOrigin: '' }
    ]
  };
  const changed = applyFilterValues(template, { 0: ' 310 ' });
  assert.equal(changed.params_data[0].defVal, '310');
  assert.equal(template.params_data[0].defVal, '300', 'the original is not changed');
  assert.throws(() => applyFilterValues(template, { 1: '02/02/2024' }), /תאריכים נקבעים בכל הרצה/);
  assert.throws(() => applyFilterValues(template, { 2: '5' }), /סינון הלקוח/);
  assert.throws(() => applyFilterValues(template, { 0: '3a' }), /מספר לא תקין/);
  assert.throws(() => applyFilterValues(template, { 9: '1' }), /סינון לא מוכר/);
  const fresh = { ...template, params_data: template.params_data.slice(1) };
  assert.throws(() => applyFilterValues(fresh, { 0: '310' }, template), /חסר סינון/);
  assert.deepEqual(applyFilterValues(fresh, { 0: '310' }, template, { ignoreMissing: true }).params_data, fresh.params_data);
});
