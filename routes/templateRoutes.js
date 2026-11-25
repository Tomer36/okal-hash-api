// The templates page (templates.html): update a report's template from hrep, test it against
// Hashavshevet before using it, and switch between its versions.
import fs from "fs";
import express from "express";
import { getReport, reportNeedsClient, templates, HREP_SETTINGS } from "../services/reportService.js";
import { runHrep as defaultRunHrep } from "../services/hrep.mjs";
import { applyFilterValues, isReportNumber, parseTemplateText, summarizeParams } from "../services/reportTemplates.mjs";
import { compareTemplates, requestFieldFor } from "../services/templateContract.mjs";

// Bulk reports (175, 176, the full 198) can take minutes; this matches the background limit.
const TEST_DEADLINE_MS = 175000;
// How many rows of a check go back for a look before the file is turned on.
const PREVIEW_ROWS = 20;

const badRequest = message => Object.assign(new Error(message), { status: 400 });

// The date range written in a template's own date filters, as a request would send it.
const fileDateRange = template => {
  const dates = (template?.params_data || []).filter(param => param?.type === "date" && param?.defVal);
  const from = dates.find(param => param.opOrigin === "from")?.defVal;
  const to = dates.find(param => param.opOrigin === "to")?.defVal;
  return { ...(from ? { dateFrom: String(from) } : {}), ...(to ? { dateTo: String(to) } : {}) };
};

export function createTemplateRouter({
  store = templates,
  runHrep = defaultRunHrep,
  runReport = getReport,
  hrep = HREP_SETTINGS
} = {}) {
  const router = express.Router();
  let updating = null;

  const readParams = type => {
    const file = store.resolve(type);
    if (!file) return null;
    try {
      const template = parseTemplateText(fs.readFileSync(file, "utf8"));
      return summarizeParams(template).map((param, index) => ({ ...param, filledBy: requestFieldFor(type, template.params_data[index]) }));
    } catch {
      return null;
    }
  };

  const requireType = type => {
    if (!isReportNumber(type)) throw badRequest("מספר דוח לא תקין");
    return type;
  };
  const requireName = body => {
    const by = String(body?.by ?? "").trim().slice(0, 60);
    if (!by) throw badRequest("נא למלא שם");
    return by;
  };
  const sendError = (res, error) => {
    res.status(error.status || 500).json({ error: error.message, ...(error.changes ? { changes: error.changes } : {}) });
  };

  router.get("/", (req, res) => {
    try {
      res.json({ reports: store.list(), updating });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/:type", (req, res) => {
    try {
      const type = requireType(req.params.type);
      res.json({
        type,
        name: store.list().find(item => item.type === type)?.name || "",
        hrepId: store.hrepId(type),
        gitNewer: store.gitNewer?.(type) || false,
        inGit: Boolean(store.gitFile?.(type)),
        version: store.activeVersion(type),
        exists: Boolean(store.resolve(type)),
        params: readParams(type),
        versions: store.versions(type),
        history: store.history(type)
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // The template in use, or null when the report has none yet (a new report).
  const readTemplateIfAny = type => {
    const file = store.resolve(type);
    if (!file) return null;
    try {
      return parseTemplateText(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };

  const readCurrentTemplate = type => {
    const file = store.resolve(type);
    if (!file) throw badRequest("אין קובץ לדוח הזה");
    return parseTemplateText(fs.readFileSync(file, "utf8"));
  };

  // One change at a time: build the new template, test it against Hashavshevet, and only then
  // save it as a new version and use it. The test is not tied to the browser: closing the page
  // does not cancel it. build(type, body, setStage) answers the template to test.
  const testAndSave = (action, build) => async (req, res) => {
    let type;
    let by;
    try {
      type = requireType(req.params.type);
      by = requireName(req.body);
    } catch (error) {
      sendError(res, error);
      return;
    }
    if (updating) {
      res.status(409).json({ error: `עדכון של דוח ${updating} רץ כרגע, נסה שוב בעוד דקה` });
      return;
    }
    updating = type;
    const clientNumber = String(req.body?.clientNumber ?? "").trim();
    // The number hrep encrypts by ("מזהה"): sent with the update, else the one kept for the report.
    const requestedHrepId = String(req.body?.hrepId ?? "").trim();
    if (requestedHrepId && !isReportNumber(requestedHrepId)) {
      updating = null;
      sendError(res, badRequest("מזהה להצפנה לא תקין"));
      return;
    }
    const hrepId = action === "update" ? (requestedHrepId || store.hrepId(type)) : null;
    let stage = action === "update" ? "hrep" : action === "values" ? "values" : "read";
    try {
      const built = await build(type, req.body, next => { stage = next; }, hrepId);
      // A build answers a template, or { template, existing } for a file that already exists (the
      // git file: null; a saved version: its name), which is tested and turned on but not saved again.
      const template = built?.template || built;
      const existing = built?.template ? built.existing : undefined;
      // The plan: how the filters differ from the file in use, and what that would break. A change
      // that would break something (an "error") is refused before Hashavshevet is called.
      stage = "plan";
      const changes = compareTemplates(readTemplateIfAny(type), template, type);
      if (changes.blocked) {
        throw Object.assign(new Error(changes.problems.filter(problem => problem.level === "error").map(problem => problem.message).join("; ")), { status: 422, changes });
      }
      if (reportNeedsClient(template) && !clientNumber) {
        // The new file can be of one customer while the file in use is not (it gained a customer
        // filter): the answer says so, so the page asks for a customer number.
        throw Object.assign(badRequest("הקובץ החדש הוא של לקוח אחד: נא למלא מספר לקוח לבדיקה"), { needsClient: true });
      }
      stage = "test";
      // Every run sets the date filters from the request, or to today without one; a check runs
      // with the file's own date range, or a report filtered by dates (198: accounts opened
      // 2020-2194) would be checked for today only and come back empty.
      const data = await runReport(type, { clientNumber, ...fileDateRange(template) }, {
        priority: "background",
        template,
        deadline: Date.now() + TEST_DEADLINE_MS
      });
      const rows = Array.isArray(data) ? data.length : null;
      stage = "save";
      // activate: false is a check only: the tested file is kept as a version that is not in use,
      // and the first rows of the test go back so they can be looked at before it is turned on
      // (POST /:type/activate with that version).
      const activateNow = req.body?.activate !== false;
      const previous = store.activeVersion(type);
      const version = existing !== undefined ? existing : store.saveVersion(type, template);
      if (activateNow) store.activate(type, version);
      const name = action === "update" ? String(req.body?.name ?? "").trim() : "";
      if (name && activateNow) store.setName(type, name);
      if (hrepId && hrepId !== store.hrepId(type)) store.setHrepId(type, hrepId);
      const changed = Object.keys(req.body?.values || {}).length;
      store.appendLog({ type, action, ok: true, by, version, previous, rows, activated: activateNow, ...(name ? { name } : {}), ...(hrepId ? { hrepId } : {}), ...(changed ? { values: changed } : {}) });
      res.json({
        ok: true, version, rows, activated: activateNow, params: summarizeParams(template), changes,
        ...(activateNow ? {} : { preview: Array.isArray(data) ? data.slice(0, PREVIEW_ROWS) : [] })
      });
    } catch (error) {
      const message = stage === "test"
        ? `הבדיקה מול חשבשבת נכשלה, הקובץ הקודם נשאר בשימוש: ${error.message}`
        : error.message;
      try {
        store.appendLog({ type, action, ok: false, by, stage, error: message, ...(hrepId ? { hrepId } : {}) });
      } catch { /* the reply below still reports the failure */ }
      res.status(error.status && error.status < 500 ? error.status : 502).json({ error: message, stage, ...(error.changes ? { changes: error.changes } : {}), ...(error.needsClient ? { needsClient: true } : {}) });
    } finally {
      updating = null;
    }
  };

  // A report's filters as hrep gives them now, read before anything is checked, so their values can
  // be filled first (a new report, or an update of one in use). Nothing is saved or tested; the check (update) runs hrep again with those values.
  router.post("/:type/read", async (req, res) => {
    let type;
    let hrepId;
    try {
      type = requireType(req.params.type);
      requireName(req.body);
      hrepId = String(req.body?.hrepId ?? "").trim() || store.hrepId(type);
      if (!isReportNumber(hrepId)) throw badRequest("מזהה להצפנה לא תקין");
    } catch (error) {
      sendError(res, error);
      return;
    }
    if (updating) {
      res.status(409).json({ error: `עדכון של דוח ${updating} רץ כרגע, נסה שוב בעוד דקה` });
      return;
    }
    updating = type;
    try {
      const template = parseTemplateText(await runHrep({ ...hrep, report: hrepId }));
      res.json({
        type,
        hrepId,
        exists: Boolean(store.resolve(type)),
        params: summarizeParams(template).map((param, index) => ({ ...param, filledBy: requestFieldFor(type, template.params_data[index]) }))
      });
    } catch (error) {
      res.status(error.status && error.status < 500 ? error.status : 502).json({ error: error.message, stage: "hrep" });
    } finally {
      updating = null;
    }
  });

  // A fresh template from hrep. Filter values changed on the page go into it before the test, so
  // what is tested is what will be used: by the ids of hrep's own output when the page read its
  // filters first with /read (valuesFrom: "hrep", and always for a report with no file yet), else by
  // the ids of the file in use.
  router.post("/:type/update", testAndSave("update", async (type, body, setStage, hrepId) => {
    const values = body?.values || {};
    const hasValues = Object.keys(values).length > 0;
    const fromHrep = body?.valuesFrom === "hrep";
    const current = hasValues && !fromHrep && store.resolve(type) ? readCurrentTemplate(type) : null;
    const template = parseTemplateText(await runHrep({ ...hrep, report: hrepId }));
    if (!hasValues) return template;
    setStage("values");
    if (!current) return applyFilterValues(template, values);
    // The values shown on the page go into the fresh output; a filter Hashavshevet no longer has is left out.
    return applyFilterValues(template, values, current, { ignoreMissing: true });
  }));

  // A newer file committed to git, or an older version from the list: checked like any change
  // (plan, test call, rows) before it is turned on.
  router.post("/:type/check-git", testAndSave("git", async type => {
    const file = store.gitFile(type);
    if (!file) throw badRequest("לדוח הזה אין קובץ ב-git");
    return { template: parseTemplateText(fs.readFileSync(file, "utf8")), existing: null };
  }));
  router.post("/:type/check-version", testAndSave("version", async (type, body) => {
    const version = String(body?.version ?? "");
    const file = store.versionFile(type, version);
    if (!file) throw badRequest("הגרסה לא נמצאה");
    return { template: parseTemplateText(fs.readFileSync(file, "utf8")), existing: version };
  }));

  // Only the filter values of the file in use, without hrep.
  router.post("/:type/values", testAndSave("values", async (type, body) => {
    const values = body?.values || {};
    if (!Object.keys(values).length) throw badRequest("לא שונו ערכים");
    const current = readCurrentTemplate(type);
    return applyFilterValues(current, values);
  }));

  router.post("/:type/activate", (req, res) => {
    try {
      const type = requireType(req.params.type);
      const by = requireName(req.body);
      const version = req.body?.version ?? null;
      if (version !== null && typeof version !== "string") throw badRequest("גרסה לא תקינה");
      // The same rules as a check: a version that would break something is not turned on.
      if (version !== null && store.versionFile?.(type, version)) {
        const changes = compareTemplates(readTemplateIfAny(type), parseTemplateText(fs.readFileSync(store.versionFile(type, version), "utf8")), type);
        if (changes.blocked) {
          throw Object.assign(new Error(changes.problems.filter(problem => problem.level === "error").map(problem => problem.message).join("; ")), { status: 422, changes });
        }
      }
      const previous = store.activeVersion(type);
      store.activate(type, version);
      // A report added by a check gets its name when it is turned on.
      const name = String(req.body?.name ?? "").trim();
      if (name) store.setName(type, name);
      store.appendLog({ type, action: "activate", ok: true, by, version, previous, ...(name ? { name } : {}) });
      res.json({ ok: true, version });
    } catch (error) {
      sendError(res, error);
    }
  });

  // The name the viewer shows for the report.
  router.post("/:type/name", (req, res) => {
    try {
      const type = requireType(req.params.type);
      const by = requireName(req.body);
      if (!store.resolve(type)) throw badRequest("אין קובץ לדוח הזה");
      const name = String(req.body?.name ?? "").trim();
      store.setName(type, name);
      store.appendLog({ type, action: "name", ok: true, by, name });
      res.json({ ok: true, name });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

export default createTemplateRouter();
