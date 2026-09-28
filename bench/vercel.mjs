#!/usr/bin/env node
// Head to head against vercel-labs/agent-browser — the 43k-star incumbent, and the reason
// this project is no longer called agent-browser too.
//
//   npx agent-browser@latest --version   # the thing being measured
//   node bench/vercel.mjs
//
// NOTE FOR ANYONE EDITING: "agent-browser" in this file means VERCEL'S tool, not ours. Ours was
// renamed to thinbrowser on 2026-09-28, and a blind find-and-replace across the repo rewrote the
// competitor's name here too -- which quietly turned the benchmark into this tool measured
// against itself, reporting a meaningless 1.0x. Leave these strings alone.
//
// WHY THIS EXISTS. compare.mjs measures against Playwright's MCP server, which was the wrong
// competitor to obsess over. vercel-labs/agent-browser is a native Rust CLI *and* an MCP server,
// shipped 2026-01-11, 43k GitHub stars, ~2M npm downloads a week, and it occupies the bare npm
// name. It solves the same problem with the same idea: a compact snapshot with stable element
// refs (@e1 there, [e12] here). Benchmarking against Microsoft while THAT exists is measuring the
// wrong thing.
//
// Vercel publish no comparative numbers of their own. The "93% less than Playwright MCP" figure
// circulating is a blog author's framing, not a claim from their docs. So this is the first
// like-for-like measurement either way, which means it has to be scrupulous:
//
//   * Same URLs as compare.mjs, so the three routes are directly comparable.
//   * Each tool does its OWN navigation and its OWN wait. Handing one tool another's timing would
//     flatter whichever waits less.
//   * Fresh process per page for the CLI, so nothing is warmed between pages.
//   * Characters, not tokens. Tokens are a model-specific estimate; characters are what both
//     tools actually emit, and the ratio is what matters.
//
// If this tool loses, that is the answer and the project needs rethinking. Publishing a number
// that only holds against the competitor we chose is how a benchmark becomes marketing.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const PAGES = [
  "https://example.com/",
  "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
  "https://news.ycombinator.com/",
  "https://playwright.dev/docs/intro",
  "https://en.wikipedia.org/wiki/Accessibility",
];

/** Vercel's CLI: open, then snapshot. Their own commands, their own waiting. */
async function vercel(url) {
  const t0 = Date.now();
  try {
    await run("agent-browser", ["open", url], { timeout: 90000, maxBuffer: 1 << 26 });
    const { stdout } = await run("agent-browser", ["snapshot"], { timeout: 90000, maxBuffer: 1 << 26 });
    return { chars: stdout.length, ms: Date.now() - t0 };
  } catch (e) {
    return { chars: null, ms: Date.now() - t0, err: String(e.message).slice(0, 60) };
  }
}

/** This tool, through its own public entry point, same as compare.mjs uses. */
async function ours(url) {
  const t0 = Date.now();
  const b = await import("../src/browser.mjs");
  try {
    const out = await b.open(url);
    return { chars: out.length, ms: Date.now() - t0 };
  } catch (e) {
    return { chars: null, ms: Date.now() - t0, err: String(e.message).slice(0, 60) };
  }
}

const rows = [];
for (const url of PAGES) {
  const v = await vercel(url);
  const o = await ours(url);
  rows.push({ url, v, o });
  const label = url.replace(/^https?:\/\//, "").slice(0, 42);
  const ratio = v.chars && o.chars ? (v.chars / o.chars).toFixed(1) + "x" : "-";
  console.log(
    `${label.padEnd(44)} ${String(v.chars ?? v.err).padStart(9)} ${String(o.chars ?? o.err).padStart(8)} ${ratio.padStart(7)}`
  );
}

const vt = rows.reduce((a, r) => a + (r.v.chars || 0), 0);
const ot = rows.reduce((a, r) => a + (r.o.chars || 0), 0);
const vms = rows.reduce((a, r) => a + r.v.ms, 0);
const oms = rows.reduce((a, r) => a + r.o.ms, 0);
console.log("-".repeat(72));
console.log(`${"total, " + rows.length + " pages"}`.padEnd(44) +
  `${String(vt).padStart(9)} ${String(ot).padStart(8)} ${(ot ? (vt / ot).toFixed(1) + "x" : "-").padStart(7)}`);
console.log(`\ncolumns: vercel-labs/agent-browser, this tool, and how many times larger theirs is.`);
console.log(`time    ${(vms / 1000).toFixed(1)}s vs ${(oms / 1000).toFixed(1)}s across the run.`);
console.log(`\nMeasured ${new Date().toISOString().slice(0, 10)}. Live pages change; re-run rather than trusting this.`);

try { (await import("../src/browser.mjs")).close(); } catch {}
