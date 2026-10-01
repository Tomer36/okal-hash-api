import express from "express";
import { getReport } from "../services/reportService.js";
import { failure } from '../services/resilience.mjs';

const router = express.Router();

router.post("/:type", async (req, res) => {
  const { type } = req.params;
  const priority = String(req.get("x-hash-priority") || "interactive").toLowerCase() === "background"
    ? "background"
    : "interactive";

  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded) controller.abort(failure('Caller disconnected', 499, 'CLIENT_CANCELLED'));
  };
  req.on('aborted', abort);
  res.on('close', abort);
  const headerDeadline = Number(req.get('x-hash-deadline'));
  const deadline = Number.isFinite(headerDeadline) && headerDeadline > 0 ? headerDeadline : undefined;
  try {
    const data = await getReport(type, req.body, { priority, signal: controller.signal, deadline });
    if (!res.destroyed) res.json(data);
  } catch (err) {
    console.error("❌ Report Error:", err.message);
    // Load shedding from the upstream queue sets err.status = 503: that is "we are saturated,
    // retry later", not "this request is broken". Callers can only back off sensibly if the
    // distinction survives to them instead of being flattened into a blanket 500.
    if (!res.destroyed) {
      const status = err.response
        ? (err.response.status === 429 || err.response.status === 503 ? 503 : 502)
        : (err.status || 502);
      if (status === 503) res.set('Retry-After', String(err.retryAfter || 2));
      res.status(status).json({ error: err.message, code: err.code || 'UPSTREAM_ERROR' });
    }
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
  }
});

export default router;
