import fs from "fs";
import path from "path";

// The commit this folder is checked out at (the deploy checks out the production branch), read
// from .git without running git. "unknown" when it cannot be read.
export function readCommit(root = ".") {
  try {
    const gitDir = path.join(root, ".git");
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head.slice(0, 7);
    const ref = head.slice(4).trim();
    const refFile = path.join(gitDir, ref);
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, "utf8").trim().slice(0, 7);
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8")
      .split("\n").find(line => line.trim().endsWith(` ${ref}`));
    return packed ? packed.slice(0, 7) : "unknown";
  } catch {
    return "unknown";
  }
}

// Tells the app's logs page that the gateway started, with its server, limits and commit. The app
// may itself be restarting, so a failed post is tried again a few times; it never throws.
export async function reportStartup({ post, details, attempts = 3, waitMs = 20000, sleep = ms => new Promise(r => setTimeout(r, ms).unref?.()) }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await post({ started: true, ...details });
      return true;
    } catch {
      if (attempt < attempts) await sleep(waitMs);
    }
  }
  return false;
}
