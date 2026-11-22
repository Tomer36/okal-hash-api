import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTemplates } from '../services/templateContract.mjs';

const filter = (name, origin, defVal, extra = {}) => ({ id: name + origin, type: 'long', name: `שדה/${name}`, opName: 'מ..עד', opOrigin: origin, defVal, ...extra });
const client = { id: 'c', type: 'txt', name: 'פרטי חשבון/מפתח חשבון', opName: 'שווה', opOrigin: '', defVal: '' };
const template = (...params) => ({ encrypt_reportData: 'x', params_data: params });

test('the plan lists added, removed and changed filters, by filter rather than id', () => {
  const current = template(filter('קוד מיון', 'from', '300'), filter('קוד מיון', 'to', '301'), filter('מספר כותרת', 'from', '1'));
  const next = template({ ...filter('קוד מיון', 'from', '300'), id: 'other' }, filter('קוד מיון', 'to', '999'), filter('מפתח חשבון', 'from', '1'));
  const plan = compareTemplates(current, next, '999');
  assert.deepEqual(plan.added, [{ filter: 'מפתח חשבון מ', value: '1', client: false }]);
  assert.deepEqual(plan.removed, [{ filter: 'מספר כותרת מ', value: '1', client: false }]);
  assert.deepEqual(plan.changed, [{ filter: 'קוד מיון עד', from: '301', to: '999' }]);
  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.blocked, false);
});

test('a single-customer report that loses its customer filter is blocked', () => {
  const plan = compareTemplates(template(client, filter('קוד מיון', 'from', '300')), template(filter('קוד מיון', 'from', '300')), '181');
  assert.equal(plan.blocked, true);
  assert.match(plan.problems[0].message, /אין סינון לקוח: הדוח של לקוח אחד יחזיר את כל הלקוחות/);
  assert.equal(compareTemplates(template(client), template(client), '181').blocked, false);
});

test('filters the system relies on block the change; a filter behind a page field warns', () => {
  const plan198 = compareTemplates(template(filter('מספר כרטיס חשבון', 'from', '0'), filter('קוד מיון', 'from', '300')), template(filter('קוד מיון', 'from', '300')), '198');
  assert.equal(plan198.blocked, true);
  assert.match(plan198.problems.find(problem => problem.level === 'error').message, /מספר כרטיס חשבון מ.*בדיקת הכרטיסים החדשים/);

  const plan174 = compareTemplates(template(filter('מספר כותרת', 'from', '1')), template(filter('תאריך', 'from', '1')), '174');
  assert.equal(plan174.blocked, false, 'a warning does not block');
  assert.deepEqual(plan174.problems.map(problem => problem.level), ['warning']);
  assert.match(plan174.problems[0].message, /מספר כותרת.*לא ישפיע/);
});

test('a new file without any filter warns; a new report has nothing to compare with', () => {
  const plan = compareTemplates(template(filter('קוד מיון', 'from', '300')), template(), '226');
  assert.ok(plan.problems.some(problem => problem.level === 'warning' && /אין סינונים בכלל/.test(problem.message)));
  const fresh = compareTemplates(null, template(client), '999');
  assert.equal(fresh.added.length, 1);
  assert.deepEqual(fresh.problems, []);
});

test('a single-customer report keeps its customer filter even when the file in use cannot be read', () => {
  const plan = compareTemplates(null, template(filter('קוד מיון', 'from', '300')), '181');
  assert.equal(plan.blocked, true);
  assert.match(plan.problems[0].message, /אין סינון לקוח/);
});

test('every report file in git passes its own rules, so no real report is blocked or warned by mistake', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { parseTemplateText } = await import('../services/reportTemplates.mjs');
  for (const file of fs.readdirSync(path.resolve('reports')).filter(name => name.endsWith('.txt'))) {
    const parsed = parseTemplateText(fs.readFileSync(path.resolve('reports', file), 'utf8'));
    assert.deepEqual(compareTemplates(parsed, parsed, file.slice(0, -4)).problems, [], file);
  }
});
