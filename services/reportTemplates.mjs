// Report templates: the files in reports/ (from git) plus versions made from the templates page.
// Versions live outside the repository, so updating a template never leaves local changes that
// would block a deploy. One small state file names the version in use for each report; without
// an entry, the git file is used.
import fs from 'node:fs';
import path from 'node:path';

const REPORT_NUMBER_RE = /^\d{1,6}$/;
const VERSION_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const HEBREW_RE = /[֐-׿]/;

export const isReportNumber = value => REPORT_NUMBER_RE.test(String(value ?? ''));

function templateError(message) {
  return Object.assign(new Error(message), { status: 422 });
}

// Cuts the JSON out of hrep's output (or a saved file) and checks it can be sent as it is.
// The Hebrew field names are what the gateway matches on, so a name that lost its Hebrew
// (an encoding problem on the way) rejects the whole template.
export function parseTemplateText(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw templateError('לא נמצא JSON בפלט של hrep');
  let template;
  try {
    template = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw templateError('הפלט של hrep אינו JSON תקין');
  }
  if (typeof template?.encrypt_reportData !== 'string' || !template.encrypt_reportData.trim()) {
    throw templateError('חסר encrypt_reportData בפלט');
  }
  if (!Array.isArray(template.params_data)) throw templateError('חסר params_data בפלט');
  for (const param of template.params_data) {
    const name = String(param?.name ?? '');
    if (name.includes('�') || !HEBREW_RE.test(name)) {
      throw templateError(`שם שדה לא קריא (בעיית קידוד): ${name || '(ריק)'}`);
    }
  }
  return template;
}

// The customer number goes only into an "equals" filter on the account key. Other "equals" text
// filters (e.g. report 187's fixed counter account) keep the value set in the template.
export function isClientParam(param) {
  return (
    param?.type === 'txt' &&
    param?.opName === 'שווה' &&
    String(param?.name ?? '').endsWith('מפתח חשבון')
  );
}

// The filters a template carries: shown on the templates page, and the viewer builds its form
// from them for a report it has no fixed form for (values go back by id, see getReport).
export function summarizeParams(template) {
  return (template?.params_data || []).map(param => ({
    id: String(param?.id ?? ''),
    type: param?.type ?? '',
    field: String(param?.name ?? '').split('/').pop().trim(),
    op: param?.opName ?? '',
    origin: param?.opOrigin ?? '',
    value: param?.defVal ?? '',
    client: isClientParam(param)
  }));
}

const filterKey = param => `${param?.name}|${param?.opName}|${param?.opOrigin}`;

// A template with changed filter values (defVal). values is { [filter id]: value }, by the ids of
// the template they were read from (source, the file in use). They go into the target by the same
// filter (full name, operation and side), so they also apply to a fresh hrep output. The customer
// filter is filled per request and is never set here, and neither are dates (see below).
export function applyFilterValues(target, values, source = target, { ignoreMissing = false } = {}) {
  const entries = Object.entries(values || {});
  if (entries.length === 0) return target;
  if (entries.length > 100) throw templateError('יותר מדי סינונים');
  const sourceById = new Map((source?.params_data || []).map(param => [String(param?.id ?? ''), param]));
  const wanted = new Map();
  for (const [id, raw] of entries) {
    const param = sourceById.get(String(id));
    if (!param) throw templateError(`סינון לא מוכר: ${id}`);
    if (isClientParam(param)) throw templateError('את סינון הלקוח לא משנים כאן');
    // Every run sets the date filters (the dates sent, or today), so a date in the file changes nothing.
    if (param.type === 'date') throw templateError('תאריכים נקבעים בכל הרצה של הדוח, לא בקובץ');
    const field = String(param.name ?? '').split('/').pop().trim();
    const value = String(raw ?? '').trim();
    if (!value || value.length > 200) throw templateError(`ערך לא תקין ב${field}`);
    if (param.type === 'long' && !/^-?\d+$/.test(value)) throw templateError(`מספר לא תקין ב${field}: ${value}`);
    wanted.set(filterKey(param), value);
  }
  const missing = [...wanted.keys()].filter(key => !target.params_data.some(param => filterKey(param) === key));
  if (missing.length && !ignoreMissing) throw templateError(`בקובץ החדש חסר סינון שנערך: ${missing.map(key => key.split('|')[0].split('/').pop().trim()).join(', ')}`);
  return {
    ...target,
    params_data: target.params_data.map(param => (wanted.has(filterKey(param)) ? { ...param, defVal: wanted.get(filterKey(param)) } : param))
  };
}

// hrepIds: the number hrep encrypts a report by (its "מזהה" in Hashavshevet's list of API reports)
// where it differs from the report number, e.g. report 280 is מזהה 229. Changes made on the page
// are kept in hrep-ids.json and win over these.
export function createTemplateStore({ builtInDir, overrideDir, hrepIds = {}, now = () => new Date(), warn = console.error }) {
  const statePath = path.join(overrideDir, 'active.json');
  const namesPath = path.join(overrideDir, 'names.json');
  const hrepIdsPath = path.join(overrideDir, 'hrep-ids.json');
  const logPath = path.join(overrideDir, 'updates.log');
  const versionDir = type => path.join(overrideDir, 'versions', type);
  const versionPath = (type, version) => path.join(versionDir(type), `${version}.txt`);
  const builtInPath = type => path.join(builtInDir, `${type}.txt`);
  let cached = { modifiedAt: null, state: {} };

  function readStateStrict() {
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  // Read on every report call, so it is cached by modified time. A damaged state file must not
  // stop the reports: they fall back to the git files and the problem is logged.
  function readState() {
    let modifiedAt;
    try {
      modifiedAt = fs.statSync(statePath).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    if (cached.modifiedAt === modifiedAt) return cached.state;
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (error) {
      warn(`[templates] ${statePath} is unreadable, using the git templates: ${error.message}`);
    }
    cached = { modifiedAt, state };
    return state;
  }

  function writeState(state) {
    fs.mkdirSync(overrideDir, { recursive: true });
    const temporary = `${statePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
    fs.renameSync(temporary, statePath);
  }

  function versions(type) {
    if (!isReportNumber(type)) return [];
    try {
      return fs.readdirSync(versionDir(type))
        .filter(file => file.endsWith('.txt'))
        .map(file => file.slice(0, -4))
        .filter(version => VERSION_RE.test(version))
        .sort();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  // The file to send for a report, or null when the report is unknown.
  function resolve(type) {
    if (!isReportNumber(type)) return null;
    const version = readState()[type];
    if (version && VERSION_RE.test(version)) {
      const file = versionPath(type, version);
      if (fs.existsSync(file)) return file;
      warn(`[templates] version ${version} of report ${type} is missing, using the git template`);
    }
    const file = builtInPath(type);
    return fs.existsSync(file) ? file : null;
  }

  function activeVersion(type) {
    const version = readState()[type];
    return version && fs.existsSync(versionPath(type, version)) ? version : null;
  }

  // Stores a checked template as a new version. It is not used until activated.
  function saveVersion(type, template) {
    if (!isReportNumber(type)) throw templateError('מספר דוח לא תקין');
    const version = now().toISOString().replace(/[:.]/g, '-');
    fs.mkdirSync(versionDir(type), { recursive: true });
    fs.writeFileSync(versionPath(type, version), JSON.stringify(template, null, 4), { encoding: 'utf8', flag: 'wx' });
    return version;
  }

  // Switches a report to one of its versions, or back to the git file with null.
  function activate(type, version) {
    if (!isReportNumber(type)) throw templateError('מספר דוח לא תקין');
    if (version !== null && !versions(type).includes(version)) throw templateError('הגרסה לא נמצאה');
    if (version === null && !fs.existsSync(builtInPath(type))) {
      throw templateError('לדוח הזה אין קובץ מקורי ב-git');
    }
    const state = readStateStrict();
    if (version === null) delete state[type];
    else state[type] = version;
    writeState(state);
  }

  // Display names for the viewer, given on the templates page.
  function readNames() {
    try {
      return JSON.parse(fs.readFileSync(namesPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') warn(`[templates] ${namesPath} is unreadable: ${error.message}`);
      return {};
    }
  }

  function setName(type, name) {
    if (!isReportNumber(type)) throw templateError('מספר דוח לא תקין');
    const names = readNames();
    const clean = String(name ?? '').trim().slice(0, 80);
    if (clean) names[type] = clean;
    else delete names[type];
    fs.mkdirSync(overrideDir, { recursive: true });
    const temporary = `${namesPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(names, null, 2));
    fs.renameSync(temporary, namesPath);
  }

  function readHrepIds() {
    try {
      return JSON.parse(fs.readFileSync(hrepIdsPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') warn(`[templates] ${hrepIdsPath} is unreadable: ${error.message}`);
      return {};
    }
  }

  // The number hrep runs with for a report: set on the page, else the configured one, else the
  // report number itself.
  function hrepId(type) {
    const id = readHrepIds()[type] ?? hrepIds[type];
    return isReportNumber(id) ? String(id) : String(type);
  }

  function setHrepId(type, id) {
    if (!isReportNumber(type) || !isReportNumber(id)) throw templateError('מזהה לא תקין');
    const ids = readHrepIds();
    ids[type] = String(id);
    fs.mkdirSync(overrideDir, { recursive: true });
    const temporary = `${hrepIdsPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(ids, null, 2));
    fs.renameSync(temporary, hrepIdsPath);
  }

  function appendLog(entry) {
    fs.mkdirSync(overrideDir, { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`);
  }

  function history(type, limit = 50) {
    let lines;
    try {
      lines = fs.readFileSync(logPath, 'utf8').split('\n');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const entries = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (type === undefined || entry.type === type) entries.push(entry);
      } catch { /* a torn line from a crash; skip it */ }
    }
    return entries.slice(-limit).reverse();
  }

  function list() {
    const numbers = new Set();
    try {
      for (const file of fs.readdirSync(builtInDir)) {
        const type = file.endsWith('.txt') ? file.slice(0, -4) : '';
        if (isReportNumber(type)) numbers.add(type);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const type of Object.keys(readState())) if (isReportNumber(type)) numbers.add(type);
    const lastChange = new Map();
    for (const entry of history(undefined, 10000)) {
      if (!lastChange.has(entry.type) && entry.ok) lastChange.set(entry.type, entry);
    }
    const names = readNames();
    for (const type of Object.keys(names)) if (isReportNumber(type)) numbers.add(type);
    return [...numbers].sort((a, b) => Number(a) - Number(b)).map(type => ({
      type,
      name: names[type] || '',
      hrepId: hrepId(type),
      version: activeVersion(type),
      inGit: fs.existsSync(builtInPath(type)),
      lastChange: lastChange.get(type) || null
    }));
  }

  return { resolve, activeVersion, versions, saveVersion, activate, setName, hrepId, setHrepId, appendLog, history, list };
}
