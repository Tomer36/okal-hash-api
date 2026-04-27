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
function parseReportFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return JSON.parse(raw);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

const CLIENT_OP_NAME = "שווה";
const SORT_CODE_FIELD_NAME = "קוד מיון";
const HEADER_NUMBER_FIELD_NAME = "מספר כותרת";

function loadReportTemplate(filePath, input, reportType) {
  const report = parseReportFile(filePath);

  if (!Array.isArray(report.params_data)) {
    return report;
  }

  const today = new Date().toLocaleDateString("en-US");
  const dateFrom = input?.dateFrom || today;
  const dateTo = input?.dateTo || today;

  report.params_data = report.params_data.map((param) => {
    if (
      param?.type === "txt" && param?.opName === CLIENT_OP_NAME
    ) {
      return { ...param, defVal: String(input.ID) };
    }

    if (
      reportType === "200" &&
      input?.invoiceNumber &&
      param?.type === "long" &&
      param?.name?.includes("מספר מסמך")
    ) {
      return { ...param, defVal: String(input.invoiceNumber) };
    }

    if (
      reportType === "175" &&
      param?.type === "long" &&
      param?.name?.includes(SORT_CODE_FIELD_NAME)
    ) {
      if (param?.opOrigin === "from" && input?.sortCodeFrom) {
        return { ...param, defVal: String(input.sortCodeFrom) };
      }
      if (param?.opOrigin === "to" && input?.sortCodeTo) {
        return { ...param, defVal: String(input.sortCodeTo) };
      }
    }

    if (
      reportType === "174" &&
      input?.headerNumber &&
      param?.type === "long" &&
      param?.name?.includes(HEADER_NUMBER_FIELD_NAME)
    ) {
      return { ...param, defVal: String(input.headerNumber) };
    }

    if (param?.type === "date") {
      if (param?.opOrigin === "from") {
        return { ...param, defVal: dateFrom };
      }
      if (param?.opOrigin === "to") {
        return { ...param, defVal: dateTo };
      }
      return { ...param, defVal: today };
    }

    return param;
  });

  return report;
}

function reportNeedsClient(report) {
  if (!Array.isArray(report?.params_data)) {
    return false;
  }

  return report.params_data.some(
    (param) => param?.type === "txt" && param?.opName === CLIENT_OP_NAME
  );
}

function createSignature(data) {
  return crypto.createHash("md5").update(data + TOKEN).digest("hex");
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DECIMAL_RE = /^-?\d+\.\d+$/;

function formatDateString(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatNumberValue(value) {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || Number.isInteger(num)) {
    return value;
  }
  return num.toFixed(2);
}

function normalizeReportData(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeReportData);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        normalizeReportData(val),
      ])
    );
  }

  if (typeof value === "string") {
    if (ISO_DATE_RE.test(value)) {
      return formatDateString(value);
    }
    if (DECIMAL_RE.test(value)) {
      return formatNumberValue(value);
    }
    return value;
  }

  if (typeof value === "number") {
    return formatNumberValue(value);
  }

  return value;
}

const MOVEMENT_FIELD = 'סה"כ בתנועה';
const VAT_FIELD = 'סה"כ בתנועה כולל מע"מ';
const INVENTORY_FIELD = "מזהה מלאי בסיס";

function processReport200(data) {
  if (!Array.isArray(data)) return data;

  let total = 0;

  const rows = data.map((row) => {
    const { [INVENTORY_FIELD]: _removed, ...rest } = row;
    const base = Number(rest[MOVEMENT_FIELD]) || 0;
    const withVat = parseFloat((base * 1.18).toFixed(2));
    total += withVat;
    return { ...rest, [VAT_FIELD]: withVat };
  });

  rows.push({
    'מס חשבונית': 'סה"כ',
    [VAT_FIELD]: parseFloat(total.toFixed(2)),
  });

  return rows;
}

/* -------------------- MAIN SERVICE -------------------- */
export async function getReport(type, payload) {
  const templatePath = `./reports/${type}.txt`;

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Report '${type}' is not supported`);
  }

  const reportTemplateRaw = parseReportFile(templatePath);
  const needsClient = reportNeedsClient(reportTemplateRaw);

  if (needsClient && !payload?.clientNumber) {
    throw new Error("clientNumber is required for this report");
  }

  const reportTemplate = loadReportTemplate(
    templatePath,
    {
    ID: payload?.clientNumber,
    dateFrom: payload?.dateFrom,
    dateTo: payload?.dateTo,
    invoiceNumber: payload?.invoiceNumber,
    sortCodeFrom: payload?.sortCodeFrom,
    sortCodeTo: payload?.sortCodeTo,
    headerNumber: payload?.headerNumber,
    },
    type
  );
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

  const normalized = normalizeReportData(result);
  if (type === "200") return processReport200(normalized);
  return normalized;
}
