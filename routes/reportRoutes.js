import express from "express";
import { getReport } from "../services/reportService.js";

const router = express.Router();

router.post("/:type", async (req, res) => {
  const { type } = req.params;

  if (!req.body.clientNumber) {
    return res.status(400).json({ error: "clientNumber is required" });
  }

  try {
    const data = await getReport(type, req.body);
    res.json(data);
  } catch (err) {
    console.error("❌ Report Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;