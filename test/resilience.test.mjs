import test from 'node:test';
import assert from 'node:assert/strict';
import { Resilience, failure } from '../services/resilience.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const options = (report = '183', extra = {}) => ({ report, timeoutMs: 2000, ...extra });
const hang = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('heavy requests cannot consume essential reserved capacity', async () => {
  const r = new Resilience({ max: 2, queueWaitMs: 20 });
  const c = new AbortController();
  const heavy = r.run('a', options('183', { signal: c.signal }), hang);
  const heavyCheck = assert.rejects(heavy);
  await turn();
  const queued = r.run('b', options(), hang);
  const queueCheck = assert.rejects(queued, { code: 'UPSTREAM_BUSY' });
  assert.equal(await r.run('c', options('181', { lane: 'essential' }), async () => 42), 42);
  await queueCheck;
  c.abort();
  await heavyCheck;
  await turn();
  assert.equal(r.stats().activeUpstreamRequests, 0);
});

test('cancelling queued work removes it without invoking the provider', async () => {
  const r = new Resilience({ max: 1 });
  const a = new AbortController();
  const b = new AbortController();
  const running = assert.rejects(r.run('a', options('183', { signal: a.signal }), hang));
  await turn();
  let called = false;
  const waiting = assert.rejects(r.run('b', options('177', { signal: b.signal }), async () => { called = true; }));
  b.abort();
  await waiting;
  a.abort();
  await running;
  await turn();
  assert.equal(called, false);
  assert.equal(r.stats().interactiveWaiting, 0);
  assert.equal(r.stats().activeUpstreamRequests, 0);
});

test('queue capacity is bounded', async () => {
  const r = new Resilience({ max: 1, queueMax: 1 });
  const c = new AbortController();
  const a = assert.rejects(r.run('a', options('183', { signal: c.signal }), hang));
  const b = assert.rejects(r.run('b', options('183', { signal: c.signal }), hang));
  await assert.rejects(r.run('c', options(), hang), { code: 'UPSTREAM_BUSY' });
  c.abort();
  await Promise.all([a, b]);
});

test('deadline cancels provider work and releases its slot', async () => {
  const r = new Resilience();
  await assert.rejects(r.run('a', options('183', { timeoutMs: 15 }), hang), { code: 'UPSTREAM_DEADLINE' });
  await turn();
  assert.equal(r.stats().activeUpstreamRequests, 0);
  assert.equal(r.inflight.size, 0);
});

test('identical requests share work, one cancellation does not cancel the other consumer', async () => {
  const r = new Resilience();
  const c = new AbortController();
  let resolve;
  let calls = 0;
  const operation = () => { calls++; return new Promise(done => { resolve = done; }); };
  const a = assert.rejects(r.run('same', options('183', { signal: c.signal }), operation));
  const b = r.run('same', options(), operation);
  await turn();
  c.abort();
  await a;
  assert.equal(r.stats().activeUpstreamRequests, 1);
  resolve('result');
  assert.equal(await b, 'result');
  assert.equal(calls, 1);
});

test('last consumer cancellation aborts shared work and fresh requests can start', async () => {
  const r = new Resilience();
  const c = new AbortController();
  const a = assert.rejects(r.run('same', options('183', { signal: c.signal }), hang));
  await turn();
  c.abort();
  await a;
  assert.equal(await r.run('same', options(), async () => 7), 7);
  assert.deepEqual(r.stats().openReportCircuits, []);
});

test('report failure opens only its own circuit and recovery allows one probe', async () => {
  let now = 100;
  const r = new Resilience({ threshold: 2, cooldownMs: 50, now: () => now });
  const fail = async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); };
  await assert.rejects(r.run('a', options(), fail));
  await assert.rejects(r.run('b', options(), fail));
  await assert.rejects(r.run('c', options(), fail), { code: 'CIRCUIT_OPEN' });
  assert.equal(await r.run('d', options('181', { lane: 'essential' }), async () => 1), 1);
  now += 51;
  let resolve;
  const probe = r.run('probe', options(), () => new Promise(done => { resolve = done; }));
  await turn();
  await assert.rejects(r.run('probe2', options(), fail), { code: 'CIRCUIT_OPEN' });
  resolve('recovered');
  assert.equal(await probe, 'recovered');
  assert.equal(await r.run('after', options(), async () => 2), 2);
});

test('DNS failures open the provider-wide circuit across reports', async () => {
  const r = new Resilience({ threshold: 2 });
  const fail = async () => { throw Object.assign(new Error('DNS failed'), { code: 'ENOTFOUND' }); };
  await assert.rejects(r.run('a', options('183'), fail));
  await assert.rejects(r.run('b', options('177'), fail));
  await assert.rejects(r.run('c', options('181'), async () => 1), { code: 'CIRCUIT_OPEN' });
});

test('validation errors and caller cancellations do not open circuits', async () => {
  const r = new Resilience({ threshold: 1 });
  await assert.rejects(r.run('a', options(), async () => { throw { response: { status: 400 } }; }));
  const c = new AbortController();
  const promise = assert.rejects(r.run('b', options('183', { signal: c.signal }), hang));
  await turn();
  c.abort(failure('cancelled', 499, 'CLIENT_CANCELLED'));
  await promise;
  assert.equal(await r.run('c', options(), async () => 'ok'), 'ok');
});

test('expired and already-cancelled requests never invoke provider', async () => {
  const r = new Resilience();
  const operation = () => assert.fail('must not run');
  await assert.rejects(r.run('a', options('183', { timeoutMs: 0 }), operation));
  const c = new AbortController();
  c.abort();
  await assert.rejects(r.run('b', options('183', { signal: c.signal }), operation));
  assert.equal(r.stats().activeUpstreamRequests, 0);
});

test('one essential report cannot occupy every slot, even across customers', async () => {
  const r = new Resilience({ max: 4, perReportMax: 2, queueWaitMs: 20 });
  const c = new AbortController();
  const opts = options('181', { lane: 'essential', signal: c.signal });
  const a = assert.rejects(r.run('account-a', opts, hang));
  const b = assert.rejects(r.run('account-b', opts, hang));
  await turn();
  const third = assert.rejects(r.run('account-c', opts, hang), { code: 'UPSTREAM_BUSY' });
  assert.equal(await r.run('other-report', options('184', { lane: 'essential' }), async () => 'ok'), 'ok');
  await third;
  c.abort();
  await Promise.all([a, b]);
});

test('background work obeys its own cap without blocking interactive reports', async () => {
  const r = new Resilience({ queueWaitMs: 20 });
  const c = new AbortController();
  const a = assert.rejects(r.run('bg1', options('174', { lane: 'background', signal: c.signal }), hang));
  const b = assert.rejects(r.run('bg2', options('198', { lane: 'background', timeoutMs: 50 }), hang), { code: 'UPSTREAM_DEADLINE' });
  assert.equal(await r.run('interactive', options('183'), async () => 1), 1);
  await b;
  c.abort();
  await a;
});

test('failed recovery probe reopens the circuit until the next cooldown', async () => {
  let now = 100;
  const r = new Resilience({ threshold: 1, cooldownMs: 50, now: () => now });
  const fail = async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); };
  await assert.rejects(r.run('first', options(), fail));
  now += 51;
  await assert.rejects(r.run('probe', options(), fail));
  await assert.rejects(r.run('early', options(), async () => 'ok'), { code: 'CIRCUIT_OPEN' });
  now += 51;
  assert.equal(await r.run('recovery', options(), async () => 'ok'), 'ok');
});

test('background work waits beyond the interactive queue cap and then succeeds', async () => {
  const r = new Resilience({ queueWaitMs: 10 });
  const first = r.run('198', options('198', { lane: 'background' }), async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return 'directory';
  });
  const second = r.run('176', options('176', { lane: 'background' }), async () => 'contacts');
  assert.deepEqual(await Promise.all([first, second]), ['directory', 'contacts']);
  assert.equal(r.stats().backgroundWaiting, 0);
});

test('cancelling a queued background request removes it before provider execution', async () => {
  const r = new Resilience();
  const a = new AbortController();
  const b = new AbortController();
  const first = assert.rejects(r.run('198', options('198', { lane: 'background', signal: a.signal }), hang));
  const second = assert.rejects(r.run('176', options('176', { lane: 'background', signal: b.signal }), () => assert.fail('abandoned work')));
  b.abort();
  await second;
  await turn();
  assert.equal(r.stats().backgroundWaiting, 0);
  a.abort();
  await first;
});
