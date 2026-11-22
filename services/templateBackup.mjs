// A daily copy of the report-templates folder (versions, the version in use per report, names,
// מזהה numbers and the change log). It lives outside git on purpose, so nothing else copies it.
// One folder per day (YYYY-MM-DD; a second run on the same day replaces it), the newest `keep` days
// are kept. Point backupDir at another disk or a network share so a lost disk does not take both.
import fs from 'node:fs';
import path from 'node:path';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createTemplateBackup({ sourceDir, backupDir, keep = 14, now = () => new Date(), log = console.log, warn = console.error }) {
  // Copies the folder now; answers the folder written, or null when there was nothing to copy.
  function run() {
    if (!sourceDir || !backupDir || !fs.existsSync(sourceDir)) return null;
    const day = now().toISOString().slice(0, 10);
    const target = path.join(backupDir, day);
    const temporary = `${target}.tmp`;
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.mkdirSync(backupDir, { recursive: true });
    fs.cpSync(sourceDir, temporary, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(temporary, target);
    const days = fs.readdirSync(backupDir).filter(name => DAY_RE.test(name)).sort();
    for (const old of days.slice(0, Math.max(0, days.length - keep))) {
      fs.rmSync(path.join(backupDir, old), { recursive: true, force: true });
    }
    log(`[templates] backed up ${sourceDir} to ${target}`);
    return target;
  }

  const safeRun = () => {
    try {
      return run();
    } catch (error) {
      warn(`[templates] backup to ${backupDir} failed: ${error.message}`);
      return null;
    }
  };

  // Once now and then every day; the timer does not keep the process alive.
  function start() {
    safeRun();
    const timer = setInterval(safeRun, DAY_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { run, start };
}
