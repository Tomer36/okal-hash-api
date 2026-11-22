// Run by the pipeline before tests: the report files changed in this push, checked against the
// rules a change from Rivo goes through (services/templateChanges.mjs). Exits 1 when a change
// would break something, so the deploy does not run.
// BASE_SHA: the commit before this push (github.event.before); without one, the previous commit.
import { execFileSync } from 'node:child_process';
import { checkTemplateChanges } from '../services/templateChanges.mjs';

// Quiet: a file that is new or removed in this push is simply not in one of the two commits.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const exists = (ref) => {
  try {
    git('cat-file', '-e', `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
};
const showOrNull = (ref, file) => {
  try {
    return git('show', `${ref}:${file}`);
  } catch {
    return null;
  }
};

const requested = String(process.env.BASE_SHA || '').trim();
const base = requested && !/^0+$/.test(requested) && exists(requested) ? requested : (exists('HEAD~1') ? 'HEAD~1' : null);
if (!base) {
  console.log('No previous commit to compare with; nothing to check.');
  process.exit(0);
}

const changed = git('diff', '--name-only', base, 'HEAD', '--', 'reports/')
  .split('\n').map(line => line.trim()).filter(line => /^reports\/\d{1,6}\.txt$/.test(line));
if (changed.length === 0) {
  console.log(`No report files changed since ${base.slice(0, 12)}.`);
  process.exit(0);
}

const { results, failed } = checkTemplateChanges(changed.map(file => ({
  type: file.slice('reports/'.length, -'.txt'.length),
  before: showOrNull(base, file),
  after: showOrNull('HEAD', file)
})));
for (const result of results) {
  console.log(`\nReport ${result.type}: ${result.ok ? 'OK' : 'BLOCKED'}`);
  for (const message of result.errors || []) console.log(`  error: ${message}`);
  for (const message of result.warnings || []) console.log(`  warning: ${message}`);
  for (const message of result.notes || []) console.log(`  note: ${message}`);
  const plan = result.plan;
  if (plan) {
    for (const item of plan.added) console.log(`  added: ${item.filter}${item.value ? ` = ${item.value}` : ''}`);
    for (const item of plan.removed) console.log(`  removed: ${item.filter}`);
    for (const item of plan.changed) console.log(`  changed: ${item.filter}: ${item.from} -> ${item.to}`);
  }
}
if (failed) {
  console.error('\nA report file change would break something; fix it or change it from Rivo instead.');
  process.exit(1);
}
