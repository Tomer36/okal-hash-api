import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { readCommit, reportStartup } from "../services/startupReport.mjs";

const details = { provider: "ws.wizground.com", limits: { max: 4, background: 1, perReport: 2, breakerThreshold: 5 }, version: "737f5b8" };

test("the start is posted once with the server, limits and commit", async () => {
  const posted = [];
  assert.equal(await reportStartup({ post: async body => posted.push(body), details }), true);
  assert.deepEqual(posted, [{ started: true, ...details }]);
});

test("a restarting app gets the start a few more times, and a lasting failure never throws", async () => {
  let calls = 0;
  const waits = [];
  const sleep = async ms => waits.push(ms);
  assert.equal(await reportStartup({ post: async () => { if (++calls < 3) throw new Error("ECONNREFUSED"); }, details, sleep, waitMs: 5 }), true);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5, 5]);

  calls = 0;
  assert.equal(await reportStartup({ post: async () => { calls++; throw new Error("down"); }, details, sleep, attempts: 3 }), false);
  assert.equal(calls, 3);
});

test("the commit is read from the branch file, from packed refs, or is unknown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-report-"));
  const git = path.join(root, ".git");
  fs.mkdirSync(path.join(git, "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/production\n");
  fs.writeFileSync(path.join(git, "packed-refs"), "# pack-refs\nabcdef1234567890 refs/heads/production\n");
  assert.equal(readCommit(root), "abcdef1");
  fs.writeFileSync(path.join(git, "refs", "heads", "production"), "737f5b8aaaaaaaa\n");
  assert.equal(readCommit(root), "737f5b8");
  fs.writeFileSync(path.join(git, "HEAD"), "1234567deadbeef\n");
  assert.equal(readCommit(root), "1234567");
  assert.equal(readCommit(path.join(root, "missing")), "unknown");
  fs.rmSync(root, { recursive: true, force: true });
});
