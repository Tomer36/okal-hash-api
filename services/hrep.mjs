// Runs Hashavshevet's hrep tool ("hrep <company> <report>"), which prints a report's encrypted
// template, and returns its output as text.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isReportNumber } from './reportTemplates.mjs';

function decode(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // Not UTF-8: read it as the Windows Hebrew code page. The template check catches a wrong guess.
    return new TextDecoder('windows-1255').decode(buffer);
  }
}

// hrep sits in the Hconnect folder. Call it by its full path there: Windows may be set not to
// run programs from the current folder. Otherwise rely on PATH.
function hrepCommand(dir) {
  for (const extension of ['.exe', '.bat', '.cmd']) {
    const file = path.join(dir, `hrep${extension}`);
    if (fs.existsSync(file)) return `"${file}"`;
  }
  return 'hrep';
}

const hrepError = message => Object.assign(new Error(message), { status: 502 });

export function runHrep({ dir, company, report, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    if (!isReportNumber(report) || !/^\d{1,4}$/.test(String(company ?? ''))) {
      reject(Object.assign(new Error('מספר דוח או חברה לא תקין'), { status: 400 }));
      return;
    }
    if (!fs.existsSync(dir)) {
      reject(hrepError(`התיקייה של hrep לא נמצאה בשרת: ${dir}`));
      return;
    }
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${hrepCommand(dir)} ${company} ${report}"`], {
      cwd: dir, windowsHide: true, windowsVerbatimArguments: true
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(hrepError(`hrep לא סיים תוך ${Math.round(timeoutMs / 1000)} שניות`));
    }, timeoutMs);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => {
      clearTimeout(timer);
      reject(hrepError(`לא ניתן להפעיל את hrep בתיקייה ${dir}: ${error.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      const output = decode(Buffer.concat(stdout));
      if (!output.includes('{')) {
        const details = decode(Buffer.concat(stderr)).trim() || output.trim() || `קוד יציאה ${code}`;
        reject(hrepError(`hrep לא החזיר תבנית: ${details.slice(0, 500)}`));
        return;
      }
      resolve(output);
    });
  });
}
