// The templates page (templates.html): update a report's template from hrep, test it against
// Hashavshevet before using it, and switch between its versions.
import fs from "fs";
import express from "express";
import { getReport, reportNeedsClient, templates, HREP_SETTINGS } from "../services/reportService.js";
import { runHrep as defaultRunHrep } from "../services/hrep.mjs";
import { applyFilterValues, isReportNumber, parseTemplateText, summarizeParams } from "../services/reportTemplates.mjs";

// Bulk reports (175, 176, the full 198) can take minutes; this matches the background limit.
const TEST_DEADLINE_MS = 175000;
// How many rows of a check go back for a look before the file is turned on.
const PREVIEW_ROWS = 20;

const badRequest = message => Object.assign(new Error(message), { status: 400 });

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
      return summarizeParams(parseTemplateText(fs.readFileSync(file, "utf8")));
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
    res.status(error.status || 500).json({ error: error.message });
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
    let stage = action === "update" ? "hrep" : "values";
    try {
      const template = await build(type, req.body, next => { stage = next; }, hrepId);
      if (reportNeedsClient(template) && !clientNumber) {
        throw badRequest("הדוח הזה הוא של לקוח אחד: נא למלא מספר לקוח לבדיקה");
      }
      stage = "test";
      const data = await runReport(type, { clientNumber }, {
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
      const version = store.saveVersion(type, template);
      if (activateNow) store.activate(type, version);
      const name = action === "update" ? String(req.body?.name ?? "").trim() : "";
      if (name && activateNow) store.setName(type, name);
      if (hrepId && hrepId !== store.hrepId(type)) store.setHrepId(type, hrepId);
      const changed = Object.keys(req.body?.values || {}).length;
      store.appendLog({ type, action, ok: true, by, version, previous, rows, activated: activateNow, ...(name ? { name } : {}), ...(hrepId ? { hrepId } : {}), ...(changed ? { values: changed } : {}) });
      res.json({
        ok: true, version, rows, activated: activateNow, params: summarizeParams(template),
        ...(activateNow ? {} : { preview: Array.isArray(data) ? data.slice(0, PREVIEW_ROWS) : [] })
      });
    } catch (error) {
      const message = stage === "test"
        ? `הבדיקה מול חשבשבת נכשלה, הקובץ הקודם נשאר בשימוש: ${error.message}`
        : error.message;
      try {
        store.appendLog({ type, action, ok: false, by, stage, error: message, ...(hrepId ? { hrepId } : {}) });
      } catch { /* the reply below still reports the failure */ }
      res.status(error.status && error.status < 500 ? error.status : 502).json({ error: message, stage });
    } finally {
      updating = null;
    }
  };

  // A fresh template from hrep. Filter values changed on the page (by the ids of the file in use)
  // go into it before the test, so what is tested is what will be used.
  router.post("/:type/update", testAndSave("update", async (type, body, setStage, hrepId) => {
    const values = body?.values || {};
    const current = Object.keys(values).length ? readCurrentTemplate(type) : null;
    const template = parseTemplateText(await runHrep({ ...hrep, report: hrepId }));
    if (!current) return template;
    setStage("values");
    // The values shown on the page go into the fresh output; a filter Hashavshevet no longer has is left out.
    return applyFilterValues(template, values, current, { ignoreMissing: true });
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
