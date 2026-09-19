import express from "express";
import { getReport } from "../services/reportService.js";

const router = express.Router();

router.post("/:type", async (req, res) => {
  const { type } = req.params;
  const priority = String(req.get("x-hash-priority") || "interactive").toLowerCase() === "background"
    ? "background"
    : "interactive";

  try {
    const data = await getReport(type, req.body, { priority });
    res.json(data);
  } catch (err) {
    console.error("❌ Report Error:", err.message);
    // Load shedding from the upstream queue sets err.status = 503: that is "we are saturated,
    // retry later", not "this request is broken". Callers can only back off sensibly if the
    // distinction survives to them instead of being flattened into a blanket 500.
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
