// A test runner for machines where `node --test` cannot start.
//
// WHY THIS EXISTS. `node --test test/*.test.mjs` hands every argument to Node's built-in glob,
// which lazy-loads `internal/deps/brace-expansion`. Some Node builds ship without that internal
// module (Kali's `nodejs` 22 is one), so `--test` throws `Missing internal module` before a single
// test runs — even when the path is a literal filename with no glob in it. The tests are fine; the
// runner is the thing that will not start. That is a trap: the suite is the release gate, so a box
// that cannot run it cannot verify a publish, and the failure reads like a broken test rather than
// a broken Node.
//
// This sidesteps the glob entirely: it lists the files with fs.readdir and runs each in its own
// `node` process, the same one-process-per-file isolation `--test` gives. A file that imports
// `node:test` runs its tests on exit and sets the exit code itself, so the child's status is the
// verdict. CI keeps using `npm test`; this is `npm run test:local` for everywhere else.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PER_FILE_TIMEOUT_MS = 300_000; // browser tests launch real engines; 300s is slack, not a target

const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

if (files.length === 0) {
  console.error("no *.test.mjs files found in", here);
  process.exit(1);
}

const failed = [];
for (const f of files) {
  console.log(`\n── ${f} ${"─".repeat(Math.max(0, 60 - f.length))}`);
  const r = spawnSync(process.execPath, [join(here, f)], {
    stdio: "inherit",
    env: process.env, // TB_BROWSER etc. pass straight through
    timeout: PER_FILE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  // status is null on timeout or signal; anything but a clean 0 is a failure.
  if (r.status !== 0) {
    failed.push(f + (r.signal ? ` (killed: ${r.signal})` : r.status === null ? " (no exit)" : ` (exit ${r.status})`));
  }
}

console.log(`\n${"═".repeat(64)}`);
if (failed.length) {
  console.log(`FAIL — ${failed.length} of ${files.length} test file(s) failed:`);
  for (const f of failed) console.log("  ✗ " + f);
  process.exit(1);
}
console.log(`PASS — all ${files.length} test file(s) green`);
