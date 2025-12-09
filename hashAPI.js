import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import config from "config";
import fs from "fs";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(bodyParser.json());

/* -------------------- CONFIG -------------------- */
const API_URL = config.get("configs.API_URL");
const TOKEN = config.get("configs.TOKEN");
const STATION = config.get("configs.STATION");
const COMPANY = config.get("configs.COMPANY");
const NET_PASSPORT_ID = config.get("configs.NET_PASSPORT_ID");
const TEMPLATE_FILE = "./reports/individual_obligo.txt";
const PORT = config.get("configs.HASH_PORT");

/* -------------------- HELPERS -------------------- */
function loadEncrypted(defVal) {
  let template = fs.readFileSync(TEMPLATE_FILE, "utf8");

  const today = new Date();
  const formattedDate = today.toLocaleDateString("en-US");

  let finalTemplate = template.replace("{{ID}}", defVal);
  finalTemplate = finalTemplate.replace("{{DATE}}", formattedDate);

  return finalTemplate;
}

function createSignature(data) {
  return crypto.createHash("md5").update(data + TOKEN).digest("hex");
}

async function getReport(defVal) {
  const ENCRYPTED_DATA_STRING = loadEncrypted(defVal);
  const signature = createSignature(ENCRYPTED_DATA_STRING);

  const payload = {
    station: STATION,
    plugin: "reports",
    company: COMPANY,
    message: {
      netPassportID: NET_PASSPORT_ID,
      pluginData: ENCRYPTED_DATA_STRING,
    },
    signature,
  };

  const response = await axios.post(API_URL, payload, {
    headers: { "Content-Type": "application/json" },
  });

  const result =
    response?.data?.apiRes?.data && response.data.apiRes.data.length > 0
      ? response.data.apiRes.data[0]
      : null;

  if (!result) {
    throw new Error("No report data found");
  }

  return result;
}

/* -------------------- ROUTE -------------------- */
app.post("/obligo", async (req, res) => {
  const { clientNumber } = req.body;

  if (!clientNumber) {
    return res.status(400).json({ error: "Client number is required" });
  }

  try {
    const data = await getReport(clientNumber);
    res.json(data);
  } catch (err) {
    console.error("❌ Hash Service Error:", err.message);
    res.status(500).json({ error: "Failed to fetch report" });
  }
});

/* -------------------- START SERVER -------------------- */
app.listen(PORT, () => {
  console.log(`✅ Hash microservice running on port ${PORT}`);
});
