import fs from "fs";
import axios from "axios";
import crypto from "crypto";
import config from "config";

/* -------------------- CONFIG -------------------- */
const API_URL = config.get("configs.API_URL");
const TOKEN = config.get("configs.TOKEN");
const STATION = config.get("configs.STATION");
const COMPANY = config.get("configs.COMPANY");
const NET_PASSPORT_ID = config.get("configs.NET_PASSPORT_ID");

/* -------------------- HELPERS -------------------- */
function applyTemplate(template, variables) {
  let result = template;

  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }

  return result;
}

function createSignature(data) {
  return crypto.createHash("md5").update(data + TOKEN).digest("hex");
}

/* -------------------- MAIN SERVICE -------------------- */
export async function getReport(type, payload) {
  const templatePath = `./reports/${type}.txt`;

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Report '${type}' is not supported`);
  }

  const template = fs.readFileSync(templatePath, "utf8");

  // Base variables (always available)
  const variables = {
    ID: payload.clientNumber,
    DATE: new Date().toLocaleDateString("en-US"),
    ...payload, // allow custom fields (FROM_DATE, TO_DATE, etc.)
  };

  const encryptedData = applyTemplate(template, variables);
  const signature = createSignature(encryptedData);

  const requestPayload = {
    station: STATION,
    plugin: "reports",
    company: COMPANY,
    message: {
      netPassportID: NET_PASSPORT_ID,
      pluginData: encryptedData,
    },
    signature,
  };

  const response = await axios.post(API_URL, requestPayload, {
    headers: { "Content-Type": "application/json" },
  });

  const result = response?.data?.apiRes?.data;

  if (!result) {
    throw new Error("No report data found");
  }

  return result;
}
