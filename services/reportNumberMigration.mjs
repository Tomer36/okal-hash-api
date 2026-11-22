// One-time move of the report-templates folder from the number in a report's name to its "מזהה"
// (the number Hashavshevet and hrep know it by), which is now the report's number everywhere.
// The old numbers are mapped all at once (old 225 is now 227 while old 227 is now 228), so no
// report takes another's place. A copy of the whole folder is kept first; a marker in
// migrations.json makes it run once. If a target number already holds versions, nothing is moved.
import fs from 'node:fs';
import path from 'node:path';

export const REPORT_NUMBER_MOVES = Object.freeze({ 225: '227', 227: '228', 280: '229', 276: '230', 285: '231' });
const MARKER = 'report-numbers-to-hrep-id';

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
};
const writeJson = (file, value) => {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
};
const moveKey = key => REPORT_NUMBER_MOVES[key] || key;
const moveKeys = map => Object.fromEntries(Object.entries(map || {}).map(([key, value]) => [moveKey(key), value]));

// dir: the report-templates folder; backupDir: where the copy goes. Answers what was done.
export function migrateReportNumbers({ dir, backupDir, now = () => new Date(), log = console.log }) {
  if (!dir || !fs.existsSync(dir)) return { skipped: 'no folder' };
  const markerFile = path.join(dir, 'migrations.json');
  const markers = readJson(markerFile, {});
  if (markers[MARKER]) return { skipped: 'done before' };

  const versionsDir = path.join(dir, 'versions');
  const oldFolders = fs.existsSync(versionsDir)
    ? fs.readdirSync(versionsDir).filter(name => REPORT_NUMBER_MOVES[name])
    : [];
  const clashes = oldFolders
    .map(name => REPORT_NUMBER_MOVES[name])
    .filter(target => fs.existsSync(path.join(versionsDir, target)) && !REPORT_NUMBER_MOVES[target]);
  if (clashes.length) {
    log(`[templates] report numbers not moved: versions already exist for ${clashes.join(', ')}`);
    return { skipped: 'clash', clashes };
  }

  const copy = path.join(backupDir || path.dirname(dir), `before-report-numbers-${now().toISOString().slice(0, 10)}`);
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(dir, copy, { recursive: true });

  // Version folders: to temporary names first, then to the new numbers (227 is both an old and a new number).
  for (const name of oldFolders) fs.renameSync(path.join(versionsDir, name), path.join(versionsDir, `${name}.moving`));
  for (const name of oldFolders) fs.renameSync(path.join(versionsDir, `${name}.moving`), path.join(versionsDir, REPORT_NUMBER_MOVES[name]));

  for (const file of ['active.json', 'names.json', 'git-hashes.json']) {
    const full = path.join(dir, file);
    if (fs.existsSync(full)) writeJson(full, moveKeys(readJson(full, {})));
  }
  // The מזהה is now the report's number, so the moved reports need no separate one.
  const hrepIdsFile = path.join(dir, 'hrep-ids.json');
  if (fs.existsSync(hrepIdsFile)) {
    const ids = moveKeys(readJson(hrepIdsFile, {}));
    for (const [key, value] of Object.entries(ids)) if (String(value) === String(key)) delete ids[key];
    writeJson(hrepIdsFile, ids);
  }
  const logFile = path.join(dir, 'updates.log');
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').map(line => {
      if (!line.trim()) return line;
      try {
        const entry = JSON.parse(line);
        return REPORT_NUMBER_MOVES[entry.type] ? JSON.stringify({ ...entry, type: REPORT_NUMBER_MOVES[entry.type], movedFrom: entry.type }) : line;
      } catch {
        return line;
      }
    });
    fs.writeFileSync(logFile, lines.join('\n'));
  }

  writeJson(markerFile, { ...markers, [MARKER]: now().toISOString() });
  log(`[templates] report numbers moved to their מזהה (${oldFolders.join(', ') || 'no versions'}); copy before: ${copy}`);
  return { moved: oldFolders, copy };
}
