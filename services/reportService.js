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
function loadReportTemplate(filePath, input) {
  const raw = fs.readFileSync(filePath, "utf8");
  const report = JSON.parse(raw);

  if (!Array.isArray(report.params_data)) {
    return report;
  }

  const today = new Date().toLocaleDateString("en-US");

  report.params_data = report.params_data.map((param) => {
    if (param?.type === "txt" && param?.opName === "שווה") {
      return { ...param, defVal: String(input.ID) };
    }

    if (param?.type === "date") {
      return { ...param, defVal: today };
    }

    return param;
  });

  return report;
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

  const reportTemplate = loadReportTemplate(templatePath, {
    ID: payload.clientNumber,
  });
  const pluginData = JSON.stringify(reportTemplate);
  const signature = createSignature(pluginData);

  const requestPayload = {
    station: STATION,
    plugin: "reports",
    company: COMPANY,
    message: {
      netPassportID: NET_PASSPORT_ID,
      pluginData,
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
