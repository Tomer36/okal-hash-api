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
    const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    res.status(statusCode).json({ error: err.message });
  }
});

export default router;
