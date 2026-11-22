// A report file changed directly in git (reports/<n>.txt, e.g. hrep run by hand and committed) goes
// through the same rules as a change made from Rivo: each changed file must be readable, and its
// filters are compared with the previous version of the same file. Used by the pipeline before a
// deploy (scripts/check-template-changes.mjs).
import { parseTemplateText } from './reportTemplates.mjs';
import { compareTemplates } from './templateContract.mjs';

// changes: [{ type, before (text or null for a new file), after (text or null for a removed file) }].
// Answers one result per file and whether any of them must stop the deploy.
export function checkTemplateChanges(changes) {
  const results = (changes || []).map(({ type, before, after }) => {
    if (after == null) {
      return { type, ok: true, notes: ['הקובץ נמחק מ-git: הדוח ישתמש בגרסה שהופעלה מ-Rivo, אם יש, או לא יעבוד'] };
    }
    let next;
    try {
      next = parseTemplateText(after);
    } catch (error) {
      return { type, ok: false, errors: [`הקובץ אינו תקין: ${error.message}`] };
    }
    let previous = null;
    if (before != null) {
      try {
        previous = parseTemplateText(before);
      } catch {
        previous = null;
      }
    }
    const plan = compareTemplates(previous, next, type);
    return {
      type,
      ok: !plan.blocked,
      errors: plan.problems.filter(problem => problem.level === 'error').map(problem => problem.message),
      warnings: plan.problems.filter(problem => problem.level === 'warning').map(problem => problem.message),
      plan
    };
  });
  return { results, failed: results.some(result => !result.ok) };
}
