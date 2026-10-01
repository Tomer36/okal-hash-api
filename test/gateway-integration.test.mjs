import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

test('real HTTP gateway: deduplication, deadlines, disconnects and isolated circuit recovery', async (t) => {
  let mode = 'success';
  let hits = 0;
  let closed = 0;
  const provider = http.createServer((req, res) => {
    if (req.url === '/logs') { res.end(); return; }
    hits++;
    res.on('close', () => { closed++; });
    req.resume();
    if (mode === 'hang') return;
    if (mode === 'fail') { res.writeHead(500); res.end('unavailable'); return; }
    setTimeout(() => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ apiRes: { data: [{ value: '1' }] } }));
    }, 30);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  process.env.NODE_CONFIG = JSON.stringify({ configs: {
    API_URL: providerUrl, TOKEN: 'test', STATION: 'test', COMPANY: 'test', NET_PASSPORT_ID: 'test'
  } });
  process.env.AUTH_SERVICE_LOG_URL = `${providerUrl}/logs`;
  process.env.HASH_INTERACTIVE_UPSTREAM_TIMEOUT_MS = '500';
  process.env.HASH_BREAKER_FAILURE_THRESHOLD = '3';
  process.env.HASH_BREAKER_COOLDOWN_MS = '80';
  const { default: router } = await import('../routes/reportRoutes.js');
  const app = express();
  app.use(express.json());
  app.use('/reports', router);
  const gateway = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => {
    gateway.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  });
  const call = (type, extra = {}) => fetch(`http://127.0.0.1:${gateway.address().port}/reports/${type}`, {
    method: 'POST', body: JSON.stringify({ clientNumber: 'test-customer' }),
    ...extra, headers: { 'Content-Type': 'application/json', ...extra.headers }
  });
  const until = async predicate => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate());
  };

  const before = hits;
  const replies = await Promise.all([call('183'), call('183')]);
  assert.deepEqual(replies.map(r => r.status), [200, 200]);
  await Promise.all(replies.map(r => r.text()));
  assert.equal(hits - before, 1, 'one provider call for identical HTTP requests');

  mode = 'hang';
  const beforeClose = closed;
  const expired = await call('183', { headers: { 'X-Hash-Deadline': String(Date.now() + 80) } });
  assert.equal(expired.status, 504);
  await expired.text();
  await until(() => closed > beforeClose);

  const controller = new AbortController();
  const beforeCancelHits = hits;
  const beforeCancelClosed = closed;
  const cancelled = assert.rejects(call('177', { signal: controller.signal }));
  await until(() => hits > beforeCancelHits);
  controller.abort();
  await cancelled;
  await until(() => closed > beforeCancelClosed);

  mode = 'fail';
  for (let i = 0; i < 3; i++) { const r = await call('180'); assert.equal(r.status, 502); await r.text(); }
  const blocked = await call('180');
  assert.equal(blocked.status, 503);
  assert.ok(blocked.headers.get('retry-after'));
  await blocked.text();
  mode = 'success';
  const unrelated = await call('181');
  assert.equal(unrelated.status, 200);
  await unrelated.text();
  await new Promise(resolve => setTimeout(resolve, 90));
  const recovered = await call('180');
  assert.equal(recovered.status, 200);
  await recovered.text();
});
