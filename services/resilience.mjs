// Process-local protection for a single upstream provider. No automatic retries.
export function failure(message, status = 503, code = 'UPSTREAM_BUSY') {
  return Object.assign(new Error(message), { status, code });
}

class Breaker {
  constructor(threshold, cooldownMs, now) {
    Object.assign(this, { threshold, cooldownMs, now, failures: 0, openUntil: 0, probing: false });
  }
  enter() {
    if (this.openUntil) {
      if (this.now() < this.openUntil || this.probing) {
        const error = failure('External service temporarily unavailable', 503, 'CIRCUIT_OPEN');
        error.retryAfter = Math.max(1, Math.ceil((this.openUntil - this.now()) / 1000));
        throw error;
      }
      this.probing = true;
    }
    const probe = this.probing;
    return (outcome) => {
      if (probe) this.probing = false;
      if (outcome === 'cancel') return;
      // Requests started before the circuit opened cannot prematurely close it.
      if (this.openUntil && !probe) return;
      if (outcome === 'success') {
        this.failures = 0;
        this.openUntil = 0;
      } else if (probe || ++this.failures >= this.threshold) {
        this.openUntil = this.now() + this.cooldownMs;
      }
    };
  }
}

export class Resilience {
  constructor({ max = 4, backgroundMax = 1, perReportMax = 2, queueMax = 24, queueWaitMs = 1500,
    threshold = 5, cooldownMs = 15000, now = Date.now, onEvent = () => {} } = {}) {
    Object.assign(this, { max, backgroundMax, perReportMax, queueMax, queueWaitMs, threshold, cooldownMs, now, onEvent });
    this.activeByReport = new Map();
    this.active = 0;
    this.heavy = 0;
    this.background = 0;
    this.queue = [];
    this.reports = new Map();
    this.provider = new Breaker(threshold, cooldownMs, now);
    this.inflight = new Map();
  }
  stats() {
    return { activeUpstreamRequests: this.active, activeBackgroundRequests: this.background,
      activeHeavyRequests: this.heavy, interactiveWaiting: this.queue.filter(w => w.lane !== 'background').length,
      backgroundWaiting: this.queue.filter(w => w.lane === 'background').length,
      activeByReport: Object.fromEntries(this.activeByReport),
      inflightKeys: this.inflight.size, providerCircuitOpen: Boolean(this.provider.openUntil),
      openReportCircuits: [...this.reports].filter(([, b]) => b.openUntil).map(([key]) => key) };
  }
  canStart(lane, report) {
    // Reserve one slot for essential interactive requests. Heavy includes background.
    return this.active < this.max && (this.activeByReport.get(report) || 0) < this.perReportMax
      && (lane === 'essential' || this.heavy < Math.max(1, this.max - 1))
      && (lane !== 'background' || this.background < this.backgroundMax);
  }
  reserve(lane, report) {
    this.active++;
    this.activeByReport.set(report, (this.activeByReport.get(report) || 0) + 1);
    if (lane !== 'essential') this.heavy++;
    if (lane === 'background') this.background++;
    return () => {
      this.active--;
      const remaining = this.activeByReport.get(report) - 1;
      if (remaining) this.activeByReport.set(report, remaining); else this.activeByReport.delete(report);
      if (lane !== 'essential') this.heavy--;
      if (lane === 'background') this.background--;
      this.drain();
    };
  }
  drain() {
    // FIFO within each priority; skip blocked lanes rather than blocking all traffic.
    for (const lane of ['essential', 'interactive', 'background']) {
      for (const waiter of [...this.queue]) {
        if (waiter.lane === lane && this.canStart(lane, waiter.report)) waiter.grant();
      }
    }
  }
  acquire(lane, report, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.canStart(lane, report)) return Promise.resolve(this.reserve(lane, report));
    if (this.queue.length >= this.queueMax) return Promise.reject(failure('External request queue full'));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const abort = () => { cleanup(); reject(signal.reason); };
      const waiter = { lane, report, grant: () => { cleanup(); resolve(this.reserve(lane, report)); } };
      // Background waits use the existing run() deadline, not the interactive queue cap.
      const timer = lane === 'background' ? null : setTimeout(() => {
        cleanup(); reject(failure('External request queue wait exceeded'));
      }, this.queueWaitMs);
      signal.addEventListener('abort', abort, { once: true });
      this.queue.push(waiter);
    });
  }
  async execute(report, lane, signal, operation) {
    const start = this.now();
    let release;
    let providerDone;
    let reportDone;
    let providerStarted;
    let outcome = 'rejected';
    const circuit = this.reports.get(report) || new Breaker(this.threshold, this.cooldownMs, this.now);
    this.reports.set(report, circuit);
    try {
      // Check before queueing, and again after admission in case another call opened it.
      const checkProvider = this.provider.enter();
      checkProvider('cancel');
      const checkReport = circuit.enter();
      checkReport('cancel');
      release = await this.acquire(lane, report, signal);
      signal.throwIfAborted();
      providerDone = this.provider.enter();
      reportDone = circuit.enter();
      providerStarted = this.now();
      const result = await operation(signal);
      signal.throwIfAborted();
      providerDone('success');
      reportDone('success');
      outcome = 'success';
      return result;
    } catch (error) {
      const cancelled = signal.aborted && signal.reason?.code !== 'UPSTREAM_DEADLINE';
      const connectivity = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code);
      const reportFailure = connectivity || ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'UPSTREAM_DEADLINE'].includes(error.code)
        || error.response?.status >= 500 || error.response?.status === 429 || signal.reason?.code === 'UPSTREAM_DEADLINE';
      outcome = cancelled ? 'cancelled' : (reportFailure ? 'failure' : 'rejected');
      // Cancellation and local admission rejection must not count as provider failures.
      providerDone?.(cancelled || providerStarted === undefined ? 'cancel' : connectivity ? 'failure' : 'success');
      reportDone?.(cancelled || providerStarted === undefined ? 'cancel' : reportFailure ? 'failure' : 'success');
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      release?.();
      try { this.onEvent({ reportType: report, lane, outcome, queueWaitMs: (providerStarted ?? this.now()) - start,
        providerMs: providerStarted === undefined ? 0 : this.now() - providerStarted, ...this.stats() }); } catch { /* telemetry is noncritical */ }
    }
  }
  run(key, { report, lane = 'interactive', signal, timeoutMs }, operation) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (timeoutMs <= 0) return Promise.reject(failure('External request deadline exceeded', 504, 'UPSTREAM_DEADLINE'));
    let entry = this.inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, users: 0, settled: false };
      const timer = setTimeout(() => controller.abort(failure('External request deadline exceeded', 504, 'UPSTREAM_DEADLINE')), timeoutMs);
      entry.promise = this.execute(String(report), lane, controller.signal, operation).finally(() => {
        entry.settled = true;
        clearTimeout(timer);
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      });
      this.inflight.set(key, entry);
    }
    entry.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (--entry.users === 0 && !entry.settled) {
          // Do not attach a new caller to work already abandoned by all consumers.
          if (this.inflight.get(key) === entry) this.inflight.delete(key);
          entry.controller.abort(error || failure('Request abandoned', 499, 'CLIENT_CANCELLED'));
        }
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(signal.reason || failure('Request abandoned', 499, 'CLIENT_CANCELLED'));
      const timer = setTimeout(() => finish(failure('External request deadline exceeded', 504, 'UPSTREAM_DEADLINE')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(result => finish(null, result), error => finish(error));
    });
  }
}
