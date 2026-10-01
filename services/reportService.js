import fs from "fs";
import https from "https";
import axios from "axios";
import crypto from "crypto";
import config from "config";
import { Resilience } from './resilience.mjs';

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
  4
);
const MAX_BACKGROUND_REQUESTS = Math.min(
  MAX_CONCURRENT_REQUESTS,
  positiveInteger(process.env.HASH_MAX_BACKGROUND_REQUESTS, 1)
);
// Bounds on waiting for one of the few upstream slots. Without these the wait queue had no
// ceiling and no way out: a slow upstream turned into an ever-growing backlog of callers that
// had long since timed out downstream. Failing fast with 503 is far better than queueing a
// request nobody is still waiting for.
const MAX_QUEUE_DEPTH = positiveInteger(process.env.HASH_MAX_QUEUE_DEPTH, 24);
const MAX_SLOT_WAIT_MS = positiveInteger(process.env.HASH_MAX_SLOT_WAIT_MS, 1500);
const AUTH_SERVICE_LOG_URL = process.env.AUTH_SERVICE_LOG_URL
  || "http://localhost:3000/api/internal/upstream-log";

// Fire-and-forget — surfaces slot-wait/slow-call events in the app's own
// /logs page instead of only this process's console. Never let a logging
// call add latency or fail the actual report request.
let pendingLogWrites = 0;
function postUpstreamLog(payload) {
  if (pendingLogWrites >= 8) return;
  pendingLogWrites++;
  axios.post(AUTH_SERVICE_LOG_URL, payload, { timeout: 3000 })
    .catch(() => {}).finally(() => { pendingLogWrites--; });
}

// Periodic health snapshot: in-app queue state plus the actual live socket
// count Node is holding open to Hashavshevet (via the default https agent —
// axios uses it since no custom agent is configured). If this climbs over a
// day and never drops back near zero between bursts, that's a real
// connection leak, confirmed directly instead of guessed from restart timing.
function logHealthSnapshot() {
  const socketCounts = Object.values(https.globalAgent.sockets || {})
    .reduce((sum, arr) => sum + arr.length, 0);
  const freeSocketCounts = Object.values(https.globalAgent.freeSockets || {})
    .reduce((sum, arr) => sum + arr.length, 0);
  postUpstreamLog({
    healthSnapshot: true,
    ...resilience.stats(),
    activeSockets: socketCounts,
    freeSockets: freeSocketCounts
  });
}
setInterval(logHealthSnapshot, 15 * 60 * 1000).unref?.();

const reportTemplateCache = new Map();
const ESSENTIAL_REPORT_TYPES = new Set(['181', '184', '185']);
const resilience = new Resilience({
  max: MAX_CONCURRENT_REQUESTS,
  backgroundMax: MAX_BACKGROUND_REQUESTS,
  perReportMax: positiveInteger(process.env.HASH_MAX_REQUESTS_PER_REPORT, 2),
  queueMax: MAX_QUEUE_DEPTH,
  queueWaitMs: MAX_SLOT_WAIT_MS,
  threshold: positiveInteger(process.env.HASH_BREAKER_FAILURE_THRESHOLD, 5),
  cooldownMs: positiveInteger(process.env.HASH_BREAKER_COOLDOWN_MS, 15000),
  onEvent: event => postUpstreamLog({ resilience: true, ...event })
});

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
      ["175", "226"].includes(reportType) &&
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
export async function getReport(type, payload, { priority = "interactive", signal, deadline } = {}) {
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

  const limit = priority === 'background' ? DEFAULT_UPSTREAM_TIMEOUT_MS : INTERACTIVE_UPSTREAM_TIMEOUT_MS;
  const upstreamTimeoutMs = Math.min(limit, Number.isFinite(deadline) ? deadline - Date.now() : limit);
  const lane = priority === 'background' ? 'background' : ESSENTIAL_REPORT_TYPES.has(String(type)) ? 'essential' : 'interactive';
  // Share only identical report work in the same priority class; never mix tenants/payloads.
  const key = crypto.createHash('sha256').update(JSON.stringify([type, priority, requestPayload])).digest('hex');
  const response = await resilience.run(key, { report: type, lane, signal, timeoutMs: upstreamTimeoutMs },
    upstreamSignal => axios.post(API_URL, requestPayload, {
      headers: { "Content-Type": "application/json" },
      timeout: Math.max(1, upstreamTimeoutMs),
      signal: upstreamSignal
    }));

  const durationMs = Date.now() - startedAt;
  if (durationMs >= 5000) {
    console.log(`[hashAPI] report ${type} completed in ${durationMs}ms`);
    postUpstreamLog({ reportType: type, priority, durationMs });
  }

  const result = response?.data?.apiRes?.data;

  if (!result) {
    throw new Error("No report data found");
  }

  const normalized = normalizeReportData(result);
  if (type === "200") return processReport200(normalized);
  return normalized;
}
