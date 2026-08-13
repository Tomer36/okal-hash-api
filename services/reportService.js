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

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_UPSTREAM_TIMEOUT_MS = positiveInteger(
  process.env.HASH_UPSTREAM_TIMEOUT_MS,
  175000
);
const INTERACTIVE_UPSTREAM_TIMEOUT_MS = positiveInteger(
  process.env.HASH_INTERACTIVE_UPSTREAM_TIMEOUT_MS,
  25000
);
const MAX_CONCURRENT_REQUESTS = positiveInteger(
  process.env.HASH_MAX_CONCURRENT_REQUESTS,
  7
);
const MAX_BACKGROUND_REQUESTS = Math.min(
  MAX_CONCURRENT_REQUESTS,
  positiveInteger(process.env.HASH_MAX_BACKGROUND_REQUESTS, 3)
);

const reportTemplateCache = new Map();
let activeUpstreamRequests = 0;
let activeBackgroundRequests = 0;
const interactiveWaiters = [];
const backgroundWaiters = [];
const SHORT_TIMEOUT_REPORT_TYPES = new Set(["175", "176", "181", "184", "185"]);

/* -------------------- HELPERS -------------------- */
function parseReportFile(filePath) {
  const modifiedAt = fs.statSync(filePath).mtimeMs;
  const cached = reportTemplateCache.get(filePath);
  if (cached?.modifiedAt === modifiedAt) {
    return JSON.parse(JSON.stringify(cached.template));
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const template = start === -1 || end === -1 || end <= start
    ? JSON.parse(raw)
    : JSON.parse(raw.slice(start, end + 1));
  reportTemplateCache.set(filePath, { modifiedAt, template });
  return JSON.parse(JSON.stringify(template));
}

function reserveUpstreamSlot(isBackground) {
  activeUpstreamRequests += 1;
  if (isBackground) activeBackgroundRequests += 1;
}

function canReserveUpstreamSlot(isBackground) {
  return activeUpstreamRequests < MAX_CONCURRENT_REQUESTS
    && (!isBackground || activeBackgroundRequests < MAX_BACKGROUND_REQUESTS);
}

function drainUpstreamQueue() {
  while (activeUpstreamRequests < MAX_CONCURRENT_REQUESTS) {
    let next = null;
    if (interactiveWaiters.length > 0) {
      next = interactiveWaiters.shift();
    } else if (
      backgroundWaiters.length > 0
      && activeBackgroundRequests < MAX_BACKGROUND_REQUESTS
    ) {
      next = backgroundWaiters.shift();
    }

    if (!next) return;
    reserveUpstreamSlot(next.isBackground);
    next.resolve();
  }
}

async function withUpstreamSlot(operation, reportType, priority = "interactive") {
  const queuedAt = Date.now();
  const isBackground = priority === "background";
  let waitedForSlot = false;
  if (!canReserveUpstreamSlot(isBackground)) {
    waitedForSlot = true;
    await new Promise((resolve) => {
      const waiter = { resolve, isBackground };
      (isBackground ? backgroundWaiters : interactiveWaiters).push(waiter);
    });
  } else {
    reserveUpstreamSlot(isBackground);
  }

  const queueWaitMs = Date.now() - queuedAt;
  if (waitedForSlot && queueWaitMs >= 1000) {
    console.warn(
      `[hashAPI] ${priority} report ${reportType} waited ${queueWaitMs}ms for an upstream slot`
    );
  }

  try {
    return await operation();
  } finally {
    activeUpstreamRequests -= 1;
    if (isBackground) activeBackgroundRequests -= 1;
    drainUpstreamQueue();
  }
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
    if (param?.type === "txt" && param?.opName === CLIENT_OP_NAME) {
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
      input?.headerNumberFrom &&
      param?.type === "long" &&
      param?.name?.includes(HEADER_NUMBER_FIELD_NAME)
    ) {
      return { ...param, defVal: String(input.headerNumberFrom) };
    }

    if (
      reportType === "197" &&
      param?.type === "long" &&
      param?.name?.includes(HEADER_NUMBER_FIELD_NAME)
    ) {
      if (param?.opOrigin === "from" && input?.headerNumberFrom) {
        return { ...param, defVal: String(input.headerNumberFrom) };
      }
      if (param?.opOrigin === "to" && input?.headerNumberTo) {
        return { ...param, defVal: String(input.headerNumberTo) };
      }
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
const REPORT_200_TOTAL_LABEL_FIELD = "מס חשבונית";
const REPORT_200_VAT_AMOUNT_FIELD = 'מע"מ';
const REPORT_200_VAT_RATE = 0.18;

function roundCurrencyValue(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function processReport200(data) {
  if (!Array.isArray(data)) return data;

  const grossAmountFieldCandidates = [
    'כולל מע"מ',
    "כולל מעמ",
    VAT_FIELD,
    MOVEMENT_FIELD,
  ];
  let totalBeforeVat = 0;
  let totalVat = 0;
  let totalGross = 0;

  const rows = data.map((row) => {
    const { [INVENTORY_FIELD]: _removed, ...rest } = row;
    const grossField = grossAmountFieldCandidates.find(
      (field) => field in rest && rest[field] !== null && rest[field] !== ""
    );
    const gross = Number(grossField ? rest[grossField] : 0) || 0;
    const base = roundCurrencyValue(gross / (1 + REPORT_200_VAT_RATE));
    const vatAmount = roundCurrencyValue(gross - base);
    totalBeforeVat += base;
    totalVat += vatAmount;
    totalGross += gross;
    if (grossField && grossField !== VAT_FIELD) {
      delete rest[grossField];
    }
    return {
      ...rest,
      [VAT_FIELD]: gross,
    };
  });

  rows.push(
    {
      [REPORT_200_TOTAL_LABEL_FIELD]: 'סה"כ',
      [VAT_FIELD]: roundCurrencyValue(totalGross),
      __isTotalRow: true,
      __isTableTotal: true,
    },
    {
      [REPORT_200_TOTAL_LABEL_FIELD]: 'סה"כ לפני מע"מ',
      [MOVEMENT_FIELD]: roundCurrencyValue(totalBeforeVat),
      __isTotalRow: true,
    },
    {
      [REPORT_200_TOTAL_LABEL_FIELD]: 'מע"מ 18%',
      [REPORT_200_VAT_AMOUNT_FIELD]: roundCurrencyValue(totalVat),
      __isTotalRow: true,
    },
    {
      [REPORT_200_TOTAL_LABEL_FIELD]: 'סה"כ לתשלום',
      [VAT_FIELD]: roundCurrencyValue(totalGross),
      __isTotalRow: true,
    }
  );

  return rows;
}

/* -------------------- MAIN SERVICE -------------------- */
export async function getReport(type, payload, { priority = "interactive" } = {}) {
  const startedAt = Date.now();
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
      headerNumberFrom: payload?.headerNumberFrom || payload?.headerNumber,
      headerNumberTo: payload?.headerNumberTo,
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

  const upstreamTimeoutMs = SHORT_TIMEOUT_REPORT_TYPES.has(String(type))
    ? INTERACTIVE_UPSTREAM_TIMEOUT_MS
    : DEFAULT_UPSTREAM_TIMEOUT_MS;
  const response = await withUpstreamSlot(() => axios.post(API_URL, requestPayload, {
    headers: { "Content-Type": "application/json" },
    timeout: upstreamTimeoutMs,
  }), type, priority);

  const durationMs = Date.now() - startedAt;
  if (durationMs >= 5000) {
    console.log(`[hashAPI] report ${type} completed in ${durationMs}ms`);
  }

  const result = response?.data?.apiRes?.data;

  if (!result) {
    throw new Error("No report data found");
  }

  const normalized = normalizeReportData(result);
  if (type === "200") return processReport200(normalized);
  return normalized;
}
