import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

test('templates page: update tests against Hashavshevet before use, and versions can be switched', async (t) => {
  let fail = false;
  const sent = [];
  const sentParams = [];
  const provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/logs') { res.end(); return; }
      const plugin = JSON.parse(JSON.parse(body).message.pluginData);
      sent.push(plugin.encrypt_reportData);
      sentParams.push(plugin.params_data);
      if (fail) { res.writeHead(500); res.end('bad template'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ apiRes: { data: [{ a: '1' }, { a: '2' }] } }));
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-templates-'));
  process.env.NODE_CONFIG = JSON.stringify({ configs: {
    API_URL: providerUrl, TOKEN: 'test', STATION: 'test', COMPANY: 'test', NET_PASSPORT_ID: 'test'
  } });
  process.env.AUTH_SERVICE_LOG_URL = `${providerUrl}/logs`;
  process.env.HASH_TEMPLATE_DIR = overrideDir;

  const { parseTemplateText } = await import('../services/reportTemplates.mjs');
  const gitTemplate = name => parseTemplateText(fs.readFileSync(path.resolve('reports', `${name}.txt`), 'utf8'));
  let hrepOutput = '';
  const hrepCalls = [];
  const { createTemplateRouter } = await import('../routes/templateRoutes.js');
  const { default: reportRouter } = await import('../routes/reportRoutes.js');
  const app = express();
  app.use(express.json());
  app.use('/reports', reportRouter);
  app.use('/templates', createTemplateRouter({
    runHrep: async (options) => { hrepCalls.push(options); return hrepOutput; },
    hrep: { dir: 'C:\\Hconnect', company: '3' }
  }));
  const gateway = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => {
    gateway.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    fs.rmSync(overrideDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const post = async (url, body) => {
    const response = await fetch(`${base}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const get = async url => (await fetch(`${base}${url}`)).json();
  const encryptInUse = async () => {
    const before = sent.length;
    assert.equal((await post('/reports/198', {})).status, 200);
    return sent[before];
  };
  const originalEncrypt = gitTemplate('198').encrypt_reportData;

  // A good update: hrep runs with the configured company, Hashavshevet accepts it, it is used.
  hrepOutput = `C:\\Hconnect>hrep 3 198\r\n\r\n${JSON.stringify({ ...gitTemplate('198'), encrypt_reportData: 'v1' })}\r\n`;
  const updated = await post('/templates/198/update', { by: 'בודק' });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.rows, 2);
  assert.deepEqual(hrepCalls.at(-1), { dir: 'C:\\Hconnect', company: '3', report: '198' });
  assert.equal(sent.at(-1), 'v1', 'the test call sent the new template');
  assert.equal(await encryptInUse(), 'v1');
  const firstVersion = updated.body.version;

  // Hashavshevet rejects the next one: nothing changes.
  fail = true;
  hrepOutput = JSON.stringify({ ...gitTemplate('198'), encrypt_reportData: 'v2' });
  const rejected = await post('/templates/198/update', { by: 'בודק' });
  assert.equal(rejected.status, 502);
  assert.equal(rejected.body.stage, 'test');
  fail = false;
  assert.equal(await encryptInUse(), 'v1');

  // Garbled Hebrew never reaches Hashavshevet.
  const callsBefore = sent.length;
  hrepOutput = JSON.stringify({ ...gitTemplate('198'), params_data: [{ name: '???/???', type: 'long' }] });
  const garbled = await post('/templates/198/update', { by: 'בודק' });
  assert.equal(garbled.status, 422);
  assert.equal(sent.length, callsBefore);

  // A single-customer report needs a customer to test with.
  hrepOutput = JSON.stringify(gitTemplate('181'));
  assert.equal((await post('/templates/181/update', { by: 'בודק' })).status, 400);
  assert.equal((await post('/templates/181/update', { by: 'בודק', clientNumber: '12345' })).status, 200);

  // A name is required, and the report number must be a number.
  assert.equal((await post('/templates/198/update', {})).status, 400);
  assert.equal((await post('/templates/abc/update', { by: 'בודק' })).status, 400);

  const details = await get('/templates/198');
  assert.equal(details.version, firstVersion);
  assert.deepEqual(details.versions, [firstVersion]);
  assert.equal(details.history[0].ok, false, 'failed attempts are logged too');
  const listed = (await get('/templates')).reports.find(item => item.type === '198');
  assert.equal(listed.lastChange.by, 'בודק');

  // Back to the git file, then forward to the saved version again.
  assert.equal((await post('/templates/198/activate', { by: 'בודק', version: null })).status, 200);
  assert.equal(await encryptInUse(), originalEncrypt);
  assert.equal((await post('/templates/198/activate', { by: 'בודק', version: firstVersion })).status, 200);
  assert.equal(await encryptInUse(), 'v1');
  assert.equal((await post('/templates/198/activate', { by: 'בודק', version: 'nope' })).status, 422);

  // A report number that is not in git: added with a name, listed for the viewer with its
  // filters, and run with the values the viewer's form sends by filter id.
  const custom = {
    encrypt_reportData: 'custom',
    params_data: [
      { p_name: '__MUSTACH_P0__', id: '0', type: 'long', name: 'שדה/קוד מיון', defVal: '300', opName: 'מ..עד', opOrigin: 'from' },
      { p_name: '__MUSTACH_P1__', id: '500', type: 'long', name: 'שדה/קוד מיון', defVal: '301', opName: 'מ..עד', opOrigin: 'to' },
      { p_name: '__MUSTACH_P2__', id: '1', type: 'date', name: 'שדה/תאריך', defVal: '01/01/2020', opName: 'מ..עד', opOrigin: 'from' },
      { p_name: '__MUSTACH_P3__', id: '2', type: 'txt', name: 'שדה/מפתח חשבון', defVal: '', opName: 'שווה', opOrigin: '' }
    ]
  };
  hrepOutput = JSON.stringify(custom);
  assert.equal((await post('/templates/999/update', { by: 'בודק', name: 'דוח חדש', clientNumber: '777' })).status, 200);
  const listedCustom = (await get('/templates')).reports.find(item => item.type === '999');
  assert.equal(listedCustom.name, 'דוח חדש');
  const form = (await get('/templates/999')).params;
  assert.deepEqual(form.map(param => [param.id, param.type, param.client]),
    [['0', 'long', false], ['500', 'long', false], ['1', 'date', false], ['2', 'txt', true]]);

  const ran = await post('/reports/999', { clientNumber: '777', params: { 0: '310', 1: '02/15/2025', 2: 'not-the-client' } });
  assert.equal(ran.status, 200);
  const values = Object.fromEntries(sentParams.at(-1).map(param => [param.id, param.defVal]));
  assert.deepEqual(values, { 0: '310', 500: '301', 1: '02/15/2025', 2: '777' },
    'sent values win, untouched filters keep the template value, the customer filter stays clientNumber');

  assert.equal((await post('/templates/999/name', { by: 'בודק', name: 'שם אחר' })).status, 200);
  assert.equal((await get('/templates/999')).name, 'שם אחר');
  assert.equal((await post('/templates/12345/name', { by: 'בודק', name: 'x' })).status, 400, 'no name without a template');

  // Filter values changed on the page: tested, saved as a new version and used, without hrep.
  const hrepBefore = hrepCalls.length;
  const changed = await post('/templates/999/values', { by: 'בודק', clientNumber: '777', values: { 0: '320', 500: '305' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(hrepCalls.length, hrepBefore, 'no hrep for a values change');
  const tested = Object.fromEntries(sentParams.at(-1).map(param => [param.id, param.defVal]));
  assert.deepEqual([tested[0], tested[500], tested[2]], ['320', '305', '777'], 'the test used the new values');
  assert.deepEqual((await get('/templates/999')).params.map(param => param.value), ['320', '305', '01/01/2020', '']);
  assert.equal((await get('/templates/999')).history[0].action, 'values');
  assert.equal((await post('/templates/999/values', { by: 'בודק', clientNumber: '777', values: { 1: '03/01/2024' } })).status, 422, 'dates are set on every run, not in the file');
  assert.equal((await post('/templates/999/values', { by: 'בודק', clientNumber: '777', values: { 0: 'abc' } })).status, 422, 'a number filter takes a number');
  assert.equal((await post('/templates/999/values', { by: 'בודק', clientNumber: '777', values: { 2: '1' } })).status, 422, 'the customer filter is not set here');
  assert.equal((await post('/templates/999/values', { by: 'בודק', clientNumber: '777', values: {} })).status, 400);

  // An update from hrep keeps the values changed on the page: they go into the new output by filter.
  hrepOutput = JSON.stringify({ ...custom, encrypt_reportData: 'custom-2', params_data: custom.params_data.map(param => ({ ...param, id: `n${param.id}` })) });
  const refreshed = await post('/templates/999/update', { by: 'בודק', clientNumber: '777', values: { 0: '330' } });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.deepEqual(refreshed.body.params.map(param => [param.id, param.value]), [['n0', '330'], ['n500', '301'], ['n1', '01/01/2020'], ['n2', '']],
    'the edited value went into the fresh hrep output, matched by filter rather than id');

  // hrep encrypts by the report's "מזהה", which differs from the report number for some reports.
  assert.equal((await get('/templates/280')).hrepId, '229', 'the configured מזהה');
  assert.equal((await get('/templates/198')).hrepId, '198', 'the report number when they are the same');
  hrepOutput = JSON.stringify(gitTemplate('280'));
  assert.equal((await post('/templates/280/update', { by: 'בודק' })).status, 200);
  assert.equal(hrepCalls.at(-1).report, '229', 'hrep ran with the מזהה, not the report number');
  hrepOutput = JSON.stringify(custom);
  assert.equal((await post('/templates/999/update', { by: 'בודק', clientNumber: '777', hrepId: '231' })).status, 200);
  assert.equal(hrepCalls.at(-1).report, '231');
  assert.equal((await get('/templates/999')).hrepId, '231', 'a מזהה given on the page is kept for the next update');
  assert.equal((await get('/templates')).reports.find(item => item.type === '999').hrepId, '231');
  assert.equal((await post('/templates/999/update', { by: 'בודק', clientNumber: '777', hrepId: '23a' })).status, 400);

  // A check only (activate: false): tested and kept as a version, not used, with the first rows
  // of the test to look at; turning it on is a separate step.
  const inUseBefore = (await get('/templates/198')).version;
  hrepOutput = JSON.stringify({ ...gitTemplate('198'), encrypt_reportData: 'checked' });
  const checked = await post('/templates/198/update', { by: 'בודק', activate: false });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.activated, false);
  assert.deepEqual(checked.body.preview, [{ a: '1' }, { a: '2' }], 'the rows the test returned');
  const testedDates = sentParams.at(-1).filter(param => param.type === 'date').map(param => param.defVal);
  assert.deepEqual(testedDates, ['01/01/2020', '12/31/2194'], 'the check runs with the dates of the file, not today (198 would come back empty)');
  const afterCheck = await get('/templates/198');
  assert.equal(afterCheck.version, inUseBefore, 'the file in use did not change');
  assert.ok(afterCheck.versions.includes(checked.body.version), 'the checked file is kept as a version');
  assert.equal(afterCheck.history[0].activated, false);
  assert.notEqual(await encryptInUse(), 'checked');
  assert.equal((await post('/templates/198/activate', { by: 'בודק', version: checked.body.version })).status, 200);
  assert.equal(await encryptInUse(), 'checked', 'turned on as a separate step');

  // A new report added by a check gets its name when it is turned on.
  hrepOutput = JSON.stringify(custom);
  const newCheck = await post('/templates/998/update', { by: 'בודק', clientNumber: '777', name: 'נבדק', activate: false });
  assert.equal(newCheck.status, 200);
  assert.equal((await get('/templates')).reports.some(item => item.type === '998'), false, 'not listed before it is turned on');
  assert.equal((await post('/templates/998/activate', { by: 'בודק', version: newCheck.body.version, name: 'נבדק' })).status, 200);
  assert.equal((await get('/templates')).reports.find(item => item.type === '998').name, 'נבדק');

  // The plan: a check says how the filters change; a change that would break something is refused
  // before Hashavshevet is called, and the file in use stays.
  hrepOutput = JSON.stringify({ ...custom, params_data: custom.params_data.map(param => (param.id === '500' ? { ...param, defVal: '305' } : param)) });
  const planned = await post('/templates/998/update', { by: 'בודק', clientNumber: '777', activate: false });
  assert.deepEqual(planned.body.changes.changed, [{ filter: 'קוד מיון עד', from: '301', to: '305' }]);
  assert.deepEqual(planned.body.changes.problems, []);

  const sentBeforeBlocked = sent.length;
  hrepOutput = JSON.stringify({ ...custom, params_data: custom.params_data.filter(param => param.id !== '2') });
  const blocked = await post('/templates/998/update', { by: 'בודק', clientNumber: '777' });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.stage, 'plan');
  assert.match(blocked.body.error, /אין סינון לקוח/);
  assert.equal(blocked.body.changes.removed[0].client, true);
  assert.equal(sent.length, sentBeforeBlocked, 'Hashavshevet was not called for a blocked change');

  // Turning on an older version from the list goes through the same rules: one without the customer
  // filter (saved before these rules existed) is not turned on.
  const oldVersion = '2026-01-01T00-00-00-000Z';
  fs.mkdirSync(path.join(overrideDir, 'versions', '181'), { recursive: true });
  fs.writeFileSync(path.join(overrideDir, 'versions', '181', `${oldVersion}.txt`), JSON.stringify({ ...gitTemplate('181'), params_data: gitTemplate('181').params_data.filter(param => !(param.type === 'txt' && param.opName === 'שווה')) }));
  const inUse181 = (await get('/templates/181')).version;
  const refusedSwitch = await post('/templates/181/activate', { by: 'בודק', version: oldVersion });
  assert.equal(refusedSwitch.status, 422);
  assert.match(refusedSwitch.body.error, /אין סינון לקוח/);
  assert.equal(refusedSwitch.body.changes.blocked, true);
  assert.equal((await get('/templates/181')).version, inUse181, 'the file in use did not change');

  // An older version, and the git file, are checked like any change before they are turned on.
  const versionCheck = await post('/templates/198/check-version', { by: 'בודק', version: firstVersion, activate: false });
  assert.equal(versionCheck.status, 200, JSON.stringify(versionCheck.body));
  assert.equal(versionCheck.body.version, firstVersion, 'the existing version is tested, not saved again');
  assert.equal(versionCheck.body.activated, false);
  assert.ok(Array.isArray(versionCheck.body.preview));
  const versionsBefore = (await get('/templates/198')).versions.length;
  const gitCheck = await post('/templates/198/check-git', { by: 'בודק', activate: false });
  assert.equal(gitCheck.status, 200, JSON.stringify(gitCheck.body));
  assert.equal(gitCheck.body.version, null, 'the git file is turned on as itself');
  assert.equal((await get('/templates/198')).versions.length, versionsBefore, 'no copy is saved');
  assert.equal((await post('/templates/198/check-version', { by: 'בודק', version: 'nope' })).status, 400);
  assert.equal((await post('/templates/999/check-git', { by: 'בודק', clientNumber: '777' })).status, 400, 'a report without a git file');

  // Each filter says which request field fills it on every run.
  const filled = Object.fromEntries((await get('/templates/999')).params.map(param => [param.id, param.filledBy]));
  assert.equal(filled['1'], 'dates');
  assert.equal(filled['2'], 'client');
  assert.equal(filled['0'], null, 'a filter that keeps its value in the file');
});
