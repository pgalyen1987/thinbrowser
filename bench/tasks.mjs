#!/usr/bin/env node
// TASK-SUCCESS benchmark: does the *smaller* snapshot still contain what an agent needs?
//
// A character-count win is a vanity metric unless the compact snapshot still surfaces (a) the
// interactive element an agent must click, WITH a usable ref, and (b) the text it must read. This
// runs the SAME realistic tasks against thinbrowser and vercel-labs/agent-browser and scores
// coverage, alongside size. Honest by construction: a target our snapshot drops scores as a MISS.
//
//   node bench/tasks.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

// Each task: an ACTION target (must appear WITH a ref, i.e. be clickable) or an INFO target
// (text must be present to read). Targets chosen to be structurally reliable, not cherry-picked.
const TASKS = [
  { url: "https://example.com/", targets: [
      { kind: "action", text: "Learn more" },
      { kind: "info",   text: "Example Domain" } ] },
  { url: "https://developer.mozilla.org/en-US/docs/Web/API/fetch", targets: [
      { kind: "info",   text: "fetch" },
      { kind: "action", text: "Web APIs" } ] },
  { url: "https://news.ycombinator.com/", targets: [
      { kind: "info",   text: "Hacker News" },
      { kind: "action", text: "new" } ] },
  { url: "https://playwright.dev/docs/intro", targets: [
      { kind: "info",   text: "Playwright" },
      { kind: "action", text: "Installation" } ] },
  { url: "https://en.wikipedia.org/wiki/Accessibility", targets: [
      { kind: "info",   text: "Accessibility" },
      { kind: "action", text: "Search" } ] },
];

const REF = /(@e\d+|\[e\d+\]|\be\d+\b|ref[=:]?\s*["']?e?\d+)/i;

function score(snap, targets) {
  const lines = snap.split("\n");
  let pass = 0; const detail = [];
  for (const t of targets) {
    const rx = new RegExp(t.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    let ok;
    if (t.kind === "info") ok = rx.test(snap);
    else ok = lines.some((l) => rx.test(l) && REF.test(l));   // action needs a ref on the same line
    if (ok) pass++;
    detail.push(`${ok ? "✓" : "✗"} ${t.kind}:${t.text}`);
  }
  return { pass, total: targets.length, detail };
}

async function vercelSnap(url) {
  try {
    await run("agent-browser", ["open", url], { timeout: 90000, maxBuffer: 1 << 26 });
    const { stdout } = await run("agent-browser", ["snapshot"], { timeout: 90000, maxBuffer: 1 << 26 });
    return stdout;
  } catch (e) { return ""; }
}
async function ourSnap(url) {
  const b = await import("../src/browser.mjs");
  try { return await b.open(url); } catch { return ""; }
}

let ot = 0, oc = 0, vt = 0, vc = 0, osz = 0, vsz = 0;
console.log("page".padEnd(40), "vercel", "  thin", " v.tasks", "thin.tasks");
for (const task of TASKS) {
  const v = await vercelSnap(task.url);
  const o = await ourSnap(task.url);
  const vs = score(v, task.targets), os = score(o, task.targets);
  vt += vs.total; vc += vs.pass; ot += os.total; oc += os.pass; vsz += v.length; osz += o.length;
  const label = task.url.replace(/^https?:\/\//, "").slice(0, 38);
  console.log(label.padEnd(40), String(v.length).padStart(6), String(o.length).padStart(6),
    `   ${vs.pass}/${vs.total}`, `     ${os.pass}/${os.total}`, "  ", os.detail.join(" "));
}
console.log("-".repeat(90));
console.log(`TOTAL  size ${vsz} vs ${osz} (${(vsz/osz).toFixed(1)}x smaller)`);
console.log(`TASK COVERAGE  vercel ${vc}/${vt}   thinbrowser ${oc}/${ot}`);
try { (await import("../src/browser.mjs")).close(); } catch {}
