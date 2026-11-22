// What the rest of the system expects to find in a report's template, and how a new template
// differs from the one in use. A check shows the differences as a plan (added, removed, changed
// filters) with problems by level, as a deploy plan does: an "error" blocks the change, a
// "warning" may be accepted once it has been read.
import { isClientParam } from './reportTemplates.mjs';

// Filter names the report calls fill in (see loadReportTemplate in reportService.js).
export const SORT_CODE_FIELD_NAME = 'קוד מיון';
export const HEADER_NUMBER_FIELD_NAME = 'מספר כותרת';
export const ACCOUNT_CARD_NUMBER_FIELD_NAME = 'מספר כרטיס חשבון';
export const DOCUMENT_NUMBER_FIELD_NAME = 'מספר מסמך';

const fieldOf = param => String(param?.name ?? '').split('/').pop().trim();
const filterKey = param => `${param?.name}|${param?.opName}|${param?.opOrigin}`;
const sideLabel = origin => (origin === 'from' ? 'מ' : origin === 'to' ? 'עד' : '');
const describe = param => `${fieldOf(param)}${sideLabel(param?.opOrigin) ? ` ${sideLabel(param.opOrigin)}` : ''}`;
const hasFilter = (params, { type, name, origin }) => params.some(param =>
  (!type || param?.type === type) && String(param?.name ?? '').includes(name) && (!origin || param?.opOrigin === origin));

// The filters other parts of the system rely on, per report. "error": without it something breaks
// quietly (the new-cards check, the invoice copy). "warning": a field on the reports page would no
// longer do anything.
const REQUIRED = {
  198: [{ level: 'error', type: 'long', name: ACCOUNT_CARD_NUMBER_FIELD_NAME, origin: 'from', why: 'בדיקת הכרטיסים החדשים (כל 5 דקות) תמשוך את כל הכרטיסים' }],
  200: [{ level: 'error', type: 'long', name: DOCUMENT_NUMBER_FIELD_NAME, why: 'העתק החשבונית לפי מספר לא יעבוד' }],
  174: [{ level: 'warning', type: 'long', name: HEADER_NUMBER_FIELD_NAME, why: 'השדה "מספר כותרת החל מ" בעמוד הדוחות לא ישפיע' }],
  196: [{ level: 'warning', type: 'long', name: HEADER_NUMBER_FIELD_NAME, why: 'שדות מספר הכותרת בעמוד הדוחות לא ישפיעו' }],
  197: [{ level: 'warning', type: 'long', name: HEADER_NUMBER_FIELD_NAME, why: 'שדות מספר הכותרת בעמוד הדוחות לא ישפיעו' }]
};
for (const type of ['175', '198', '226', '228']) {
  REQUIRED[type] = [...(REQUIRED[type] || []), { level: 'warning', type: 'long', name: SORT_CODE_FIELD_NAME, why: 'שדות קוד המיון בעמוד הדוחות לא ישפיעו' }];
}

// The reports of one customer, by number: their customer filter is protected even when the file in
// use cannot be read to compare with.
export const SINGLE_CUSTOMER_REPORTS = new Set(['177', '180', '181', '183', '184', '185', '187', '188', '189']);

// The request field that fills a filter on every run, as loadReportTemplate (reportService.js)
// does; null for a filter that keeps the value in the file (a page may offer it as an extra field).
export function requestFieldFor(type, param) {
  const name = String(param?.name ?? '');
  const report = String(type);
  if (isClientParam(param)) return 'client';
  if (param?.type === 'date') return 'dates';
  if (param?.type !== 'long') return null;
  if (report === '200' && name.includes(DOCUMENT_NUMBER_FIELD_NAME)) return 'invoiceNumber';
  if (['175', '198', '226', '228'].includes(report) && name.includes(SORT_CODE_FIELD_NAME)) return 'sortCode';
  if (report === '198' && param?.opOrigin === 'from' && name.includes(ACCOUNT_CARD_NUMBER_FIELD_NAME)) return 'cardNumber';
  if (['174', '196', '197'].includes(report) && name.includes(HEADER_NUMBER_FIELD_NAME)) return 'headerNumber';
  return null;
}

// current: the template in use (null for a new report); next: the one about to be checked.
export function compareTemplates(current, next, type) {
  const before = Array.isArray(current?.params_data) ? current.params_data : [];
  const after = Array.isArray(next?.params_data) ? next.params_data : [];
  const beforeByKey = new Map(before.map(param => [filterKey(param), param]));
  const afterByKey = new Map(after.map(param => [filterKey(param), param]));

  const added = after.filter(param => !beforeByKey.has(filterKey(param))).map(param => ({ filter: describe(param), value: String(param?.defVal ?? ''), client: isClientParam(param) }));
  const removed = before.filter(param => !afterByKey.has(filterKey(param))).map(param => ({ filter: describe(param), value: String(param?.defVal ?? ''), client: isClientParam(param) }));
  const changed = after
    .filter(param => beforeByKey.has(filterKey(param)) && !isClientParam(param) && param?.type !== 'date')
    .filter(param => String(beforeByKey.get(filterKey(param))?.defVal ?? '') !== String(param?.defVal ?? ''))
    .map(param => ({ filter: describe(param), from: String(beforeByKey.get(filterKey(param))?.defVal ?? ''), to: String(param?.defVal ?? '') }));

  const problems = [];
  if ((before.some(isClientParam) || SINGLE_CUSTOMER_REPORTS.has(String(type))) && !after.some(isClientParam)) {
    problems.push({ level: 'error', message: 'בקובץ החדש אין סינון לקוח: הדוח של לקוח אחד יחזיר את כל הלקוחות' });
  }
  for (const rule of REQUIRED[String(type)] || []) {
    if (!hasFilter(after, rule)) {
      problems.push({ level: rule.level, message: `חסר הסינון "${rule.name}${rule.origin ? ` ${sideLabel(rule.origin)}` : ''}": ${rule.why}` });
    }
  }
  if (current && before.length > 0 && after.length === 0) {
    problems.push({ level: 'warning', message: 'בקובץ החדש אין סינונים בכלל: הדוח ירוץ על כל הנתונים' });
  }
  return {
    added, removed, changed,
    unchanged: after.length - added.length - changed.length,
    problems,
    blocked: problems.some(problem => problem.level === 'error')
  };
}
