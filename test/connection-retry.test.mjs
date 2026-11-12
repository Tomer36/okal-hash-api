import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isDroppedConnection, sendWithOneRetry, MIN_RETRY_TIME_MS } from '../services/connectionRetry.mjs';

const dropped = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

test('only a connection closed before any answer counts as dropped', () => {
  assert.equal(isDroppedConnection(dropped()), true);
  assert.equal(isDroppedConnection(Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' })), true);
  assert.equal(isDroppedConnection(Object.assign(new Error('timeout of 25000ms exceeded'), { code: 'ECONNABORTED' })), false);
  assert.equal(isDroppedConnection(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED', name: 'CanceledError' })), false);
  assert.equal(isDroppedConnection(Object.assign(dropped(), { response: { status: 502 } })), false, 'an answer from the provider is not retried');
  assert.equal(isDroppedConnection(null), false);
});

test('a dropped connection is sent once more, on a new connection, within the time left', async () => {
  const calls = [];
  const retried = [];
  let clock = 0;
  const result = await sendWithOneRetry(async (options) => {
    calls.push(options);
    if (calls.length === 1) { clock += 1000; throw dropped(); }
    return 'answer';
  }, { timeoutMs: 25000, now: () => clock, onRetry: (error) => retried.push(error.code) });
  assert.equal(result, 'answer');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].timeout, 25000);
  assert.equal(calls[0].httpsAgent, undefined, 'the first try uses the usual connections');
  assert.equal(calls[1].timeout, 24000, 'the second try gets only the time that is left');
  assert.equal(calls[1].httpsAgent.keepAlive, false, 'the second try opens a new connection');
  assert.deepEqual(retried, ['ECONNRESET']);
});

test('no second try for other failures, a cancelled request, too little time, or a second drop', async () => {
  const run = async (error, extra = {}) => {
    let calls = 0;
    await assert.rejects(sendWithOneRetry(async () => { calls++; throw error; }, { timeoutMs: 25000, ...extra }));
    return calls;
  };
  assert.equal(await run(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })), 1);
  assert.equal(await run(Object.assign(dropped(), { response: { status: 500 } })), 1);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await run(dropped(), { signal: controller.signal }), 1);
  assert.equal(await run(dropped(), { timeoutMs: MIN_RETRY_TIME_MS - 1 }), 1);
  assert.equal(await run(dropped()), 2, 'a second drop is reported, not retried again');
});

test('a report whose connection the provider drops once still gets its answer', async (t) => {
  let hits = 0;
  const provider = http.createServer((req, res) => {
    if (req.url === '/logs') { req.resume(); res.end(); return; }
    hits++;
    req.resume();
    if (hits === 1) { req.socket.destroy(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ apiRes: { data: [{ value: '1' }] } }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  process.env.NODE_CONFIG = JSON.stringify({ configs: {
    API_URL: providerUrl, TOKEN: 'test', STATION: 'test', COMPANY: 'test', NET_PASSPORT_ID: 'test'
  } });
  process.env.AUTH_SERVICE_LOG_URL = `${providerUrl}/logs`;
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  t.after(() => { console.warn = warn; });
  const { getReport } = await import('../services/reportService.js');
  const result = await getReport('183', { clientNumber: 'test-customer' });
  assert.ok(result, 'the report answered');
  assert.equal(hits, 2);
  assert.match(warnings.join('\n'), /report 183: connection dropped \(ECONNRESET\), sending once more/);
});
