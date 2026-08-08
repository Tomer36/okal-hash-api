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
    res.status(500).json({ error: err.message });
  }
});

export default router;
