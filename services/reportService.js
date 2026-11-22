import fs from "fs";
import https from "https";
import axios from "axios";
import crypto from "crypto";
import config from "config";
import { Resilience } from './resilience.mjs';
import { sendWithOneRetry } from './connectionRetry.mjs';
import { createTemplateStore, isClientParam } from './reportTemplates.mjs';
import path from "path";

/* -------------------- CONFIG -------------------- */
const API_URL = config.get("configs.API_URL");
const TOKEN = config.get("configs.TOKEN");
const STATION = config.get("configs.STATION");
const COMPANY = config.get("configs.COMPANY");
const NET_PASSPORT_ID = config.get("configs.NET_PASSPORT_ID");
// The Hashavshevet server in use (production or test), named in the service log.
export const PROVIDER_HOST = new URL(API_URL).host;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Defaults live in config/default.json ("resilience"); a HASH_* environment variable still
// overrides any of them (tests rely on this).
function resilienceSetting(envName, configKey, fallback) {
  const path = `resilience.${configKey}`;
  return positiveInteger(process.env[envName], config.has(path) ? config.get(path) : fallback);
}

const DEFAULT_UPSTREAM_TIMEOUT_MS = resilienceSetting("HASH_UPSTREAM_TIMEOUT_MS", "UPSTREAM_TIMEOUT_MS", 175000);
const INTERACTIVE_UPSTREAM_TIMEOUT_MS = resilienceSetting(
  "HASH_INTERACTIVE_UPSTREAM_TIMEOUT_MS",
  "INTERACTIVE_UPSTREAM_TIMEOUT_MS",
  25000
);
const MAX_CONCURRENT_REQUESTS = resilienceSetting("HASH_MAX_CONCURRENT_REQUESTS", "MAX_CONCURRENT_REQUESTS", 4);
const MAX_BACKGROUND_REQUESTS = Math.min(
  MAX_CONCURRENT_REQUESTS,
  resilienceSetting("HASH_MAX_BACKGROUND_REQUESTS", "MAX_BACKGROUND_REQUESTS", 1)
);
// Bounds on waiting for one of the few upstream slots. Without these the wait queue had no
// ceiling and no way out: a slow upstream turned into an ever-growing backlog of callers that
// had long since timed out downstream. Failing fast with 503 is far better than queueing a
// request nobody is still waiting for.
const MAX_QUEUE_DEPTH = resilienceSetting("HASH_MAX_QUEUE_DEPTH", "MAX_QUEUE_DEPTH", 24);
const MAX_SLOT_WAIT_MS = resilienceSetting("HASH_MAX_SLOT_WAIT_MS", "MAX_SLOT_WAIT_MS", 1500);
const AUTH_SERVICE_LOG_URL = process.env.AUTH_SERVICE_LOG_URL
  || (config.has("resilience.AUTH_SERVICE_LOG_URL") && config.get("resilience.AUTH_SERVICE_LOG_URL"))
  || "http://localhost:3000/api/internal/upstream-log";

// Fire-and-forget — surfaces slot-wait/slow-call events in the app's own
// /logs page instead of only this process's console. Never let a logging
// call add latency or fail the actual report request.
let pendingLogWrites = 0;
// Awaited, for the one startup message that must not be dropped silently.
export const postStartupLog = payload => axios.post(AUTH_SERVICE_LOG_URL, payload, { timeout: 3000 });

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
// Templates updated from the templates page live outside the repository (see reportTemplates.mjs).
export const templates = createTemplateStore({
  builtInDir: path.resolve("reports"),
  overrideDir: process.env.HASH_TEMPLATE_DIR
    || (config.has("templates.OVERRIDE_DIR") && config.get("templates.OVERRIDE_DIR"))
    || "C:\\okal-services\\report-templates",
  hrepIds: config.has("templates.HREP_IDS") ? config.get("templates.HREP_IDS") : {}
});
export const HREP_SETTINGS = {
  dir: config.has("templates.HREP_DIR") ? config.get("templates.HREP_DIR") : "C:\\Hash7\\H-Mobile\\H-Mobile-1.2.1\\Hconnect",
  company: config.has("templates.HREP_COMPANY") ? String(config.get("templates.HREP_COMPANY")) : "3"
};
const ESSENTIAL_REPORT_TYPES = new Set(['181', '184', '185']);
const resilience = new Resilience({
  max: MAX_CONCURRENT_REQUESTS,
  backgroundMax: MAX_BACKGROUND_REQUESTS,
  perReportMax: resilienceSetting("HASH_MAX_REQUESTS_PER_REPORT", "MAX_REQUESTS_PER_REPORT", 2),
  queueMax: MAX_QUEUE_DEPTH,
  queueWaitMs: MAX_SLOT_WAIT_MS,
  threshold: resilienceSetting("HASH_BREAKER_FAILURE_THRESHOLD", "BREAKER_FAILURE_THRESHOLD", 5),
  cooldownMs: resilienceSetting("HASH_BREAKER_COOLDOWN_MS", "BREAKER_COOLDOWN_MS", 15000),
  onEvent: event => postUpstreamLog({ resilience: true, ...event })
});
// The limits in effect, after any HASH_* environment override, for the startup log.
export const RESILIENCE_LIMITS = {
  max: resilience.max, background: resilience.backgroundMax, perReport: resilience.perReportMax,
  breakerThreshold: resilience.threshold
};

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


const SORT_CODE_FIELD_NAME = "קוד מיון";
const HEADER_NUMBER_FIELD_NAME = "מספר כותרת";
const ACCOUNT_CARD_NUMBER_FIELD_NAME = "מספר כרטיס חשבון";

// Values for single filters by their id in params_data, as the viewer sends them for a report
// it has no fixed form for. Applied last, so they win; the customer filter stays clientNumber's.
function applyParamValues(params, values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return params;
  return params.map((param) => {
    const id = String(param?.id ?? "");
    if (!id || !Object.hasOwn(values, id) || isClientParam(param)) return param;
    const value = values[id];
    if (value === null || value === undefined || typeof value === "object") return param;
    return { ...param, defVal: String(value).slice(0, 200) };
  });
}

// report: a fresh copy of the template, filled in place.
function loadReportTemplate(report, input, reportType) {

  if (!Array.isArray(report.params_data)) {
    return report;
  }

  const today = new Date().toLocaleDateString("en-US");
  const dateFrom = input?.dateFrom || today;
  const dateTo = input?.dateTo || today;

  report.params_data = report.params_data.map((param) => {
    if (isClientParam(param)) {
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
      ["175", "198", "226", "227"].includes(reportType) &&
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

    // Report 198 from a given internal card number onward: only the cards opened since then,
    // instead of the full customer index.
    if (
      reportType === "198" &&
      param?.type === "long" &&
      param?.opOrigin === "from" &&
      param?.name?.includes(ACCOUNT_CARD_NUMBER_FIELD_NAME) &&
      /^\d+$/.test(String(input?.cardNumberFrom ?? ""))
    ) {
      return { ...param, defVal: String(input.cardNumberFrom) };
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
      ["196", "197"].includes(reportType) &&
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
  report.params_data = applyParamValues(report.params_data, input?.params);

  return report;
}

export function reportNeedsClient(report) {
  if (!Array.isArray(report?.params_data)) {
    return false;
  }

  return report.params_data.some(isClientParam);
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
// template: send this template instead of the saved one (the templates page tests a new one).
export async function getReport(type, payload, { priority = "interactive", signal, deadline, template } = {}) {
  const startedAt = Date.now();
  const templatePath = template ? null : templates.resolve(type);

  if (!templatePath && !template) {
    throw new Error(`Report '${type}' is not supported`);
  }

  const reportTemplateRaw = template ? JSON.parse(JSON.stringify(template)) : parseReportFile(templatePath);
  const needsClient = reportNeedsClient(reportTemplateRaw);

  if (needsClient && !payload?.clientNumber) {
    throw new Error("clientNumber is required for this report");
  }

  const reportTemplate = loadReportTemplate(
    reportTemplateRaw,
    {
      ID: payload?.clientNumber,
      dateFrom: payload?.dateFrom,
      dateTo: payload?.dateTo,
      invoiceNumber: payload?.invoiceNumber,
      sortCodeFrom: payload?.sortCodeFrom,
      sortCodeTo: payload?.sortCodeTo,
      headerNumberFrom: payload?.headerNumberFrom || payload?.headerNumber,
      headerNumberTo: payload?.headerNumberTo,
      cardNumberFrom: payload?.cardNumberFrom,
      params: payload?.params,
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
    upstreamSignal => sendWithOneRetry(
      (requestOptions) => axios.post(API_URL, requestPayload, {
        headers: { "Content-Type": "application/json" },
        signal: upstreamSignal,
        ...requestOptions
      }),
      {
        timeoutMs: upstreamTimeoutMs,
        signal: upstreamSignal,
        // Kept in the service log and the app's logs page, so dropped connections stay visible
        // after a successful retry.
        onRetry: (error) => {
          const reason = error.code || error.message;
          console.warn(`[hashAPI] ${new Date().toISOString()} report ${type} (${PROVIDER_HOST}): connection dropped (${reason}), sending once more`);
          postUpstreamLog({ retry: true, reportType: type, priority, provider: PROVIDER_HOST, error: reason });
        }
      }
    ));

  const durationMs = Date.now() - startedAt;
  if (durationMs >= 5000) {
    console.log(`[hashAPI] report ${type} (${PROVIDER_HOST}) completed in ${durationMs}ms`);
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
