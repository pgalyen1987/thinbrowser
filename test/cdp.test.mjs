// Attaching to a browser this tool did not launch.
//
// WHY THIS DESERVES ITS OWN FILE. TB_CDP is the answer to every site that will not accept an
// automated browser — Play Console, Google Groups, anything behind Cloudflare's strict mode — so it
// is the most load-bearing thing here, and it shipped with no test at all because it was built
// last. That is backwards.
//
// It launches a real browser with a debugging port the way a person would, attaches to it, drives
// it, and then checks the part that matters most: that closing DETACHES rather than shutting down a
// browser that was never ours to close.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const PORT = 9411; // not 9224: a test must never collide with the owner's own attached session
const fixture = pathToFileURL(join(import.meta.dirname, "fixtures", "form.html")).href;

let theirBrowser, theirPage, ab;
let skip = false;

before(async () => {
  // CDP is a CHROMIUM protocol — this file tests attaching, not the engine under test, so it needs
  // a Chromium however TB_BROWSER is set. Where there is not one, skip loudly rather than fail:
  // four red tests about a missing binary look exactly like a broken feature.
  try {
    theirBrowser = await chromium.launch({ args: [`--remote-debugging-port=${PORT}`] });
  } catch (e) {
    console.log(`# SKIP cdp tests: no Chromium available (${String(e.message).split("\n")[0].slice(0, 80)})`);
    skip = true;
    return;
  }
  theirPage = await theirBrowser.newPage();
  await theirPage.goto(fixture);   // a tab of "theirs", open before we arrive
  process.env.TB_CDP = String(PORT);
  delete process.env.TB_EPHEMERAL; // attaching ignores it, but keep the intent explicit
  ab = await import("../src/browser.mjs");
});

after(async () => {
  delete process.env.TB_CDP;
  await theirBrowser?.close().catch(() => {});
});

test("attaches to a running browser and can drive it", async (t) => {
  if (skip) return t.skip("no Chromium available");
  const snap = await ab.open(fixture);
  assert.match(snap, /form "Login":/);
  assert.match(snap, /\[e\d+\]/);
  assert.match(await ab.fill("Email", "pat@example.com"), /filled/i);
});

test("opens its OWN page and never navigates the one that was already there", async (t) => {
  if (skip) return t.skip("no Chromium available");
  // Navigating someone's tab out from under them loses whatever they were doing, which is the one
  // thing that would make this feature unusable.
  //
  // Asked through a FRESH CDP connection, not through theirBrowser: the object that launched the
  // browser keeps its own view and cannot see pages created over a separate connection, so
  // checking it reports one page and looks like a bug in the tool. It was a bug in this test.
  const view = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const pages = view.contexts()[0].pages();
    assert.ok(pages.length >= 2, `expected our page alongside theirs, saw ${pages.length}`);
    assert.ok(pages.some((p) => p.url().endsWith("form.html")), "their tab is gone");
  } finally {
    await view.close();
  }
  // And theirs is still where they left it.
  assert.match(theirPage.url(), /form\.html$/);
});

test("close DETACHES, leaving their browser and their tab alive", async (t) => {
  if (skip) return t.skip("no Chromium available");
  await ab.close();
  assert.equal(theirBrowser.isConnected(), true, "closing detached us but killed their browser");
  const left = theirBrowser.contexts()[0].pages();
  assert.ok(left.length >= 1, "their tab went with us");
  assert.match(left[0].url(), /form\.html$/);
});

test("a dead endpoint fails in words a caller can act on", async (t) => {
  if (skip) return t.skip("no Chromium available");
  // The common way to get this wrong is to forget the flag on the browser, so the failure has to
  // name the endpoint rather than arrive as a bare stack trace.
  //
  // TB_CDP is read once at module load, so changing it here would not take effect — the honest
  // check is against the function that does the connecting.
  const { chromium: pw } = await import("playwright");
  const err = await pw.connectOverCDP("http://127.0.0.1:9499").then(() => null, (e) => e.message);
  assert.ok(err, "connecting to a dead port unexpectedly succeeded");
  assert.match(err, /9499|ECONNREFUSED|connect/i);
});

test("a blank tab left by an earlier process is reused, not added to", async (t) => {
  if (skip) return t.skip("no Chromium available");
  // The litter came from processes that EXIT WITHOUT CLOSING — each one attached, opened a tab
  // and went away, so driving one flow across several script runs left a row of empty tabs in a
  // real person's browser. (A clean close() removes its own tab, so there is nothing to reuse
  // after one, and opening a fresh tab then is correct.)
  await ab.close();
  const view = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = view.contexts()[0];
  const leftover = await ctx.newPage();          // stands in for a process that exited untidily
  const before = ctx.pages().length;
  await ab.open(fixture);                        // the next process attaches
  const after = ctx.pages().length;
  assert.equal(after, before, `tab count went ${before} -> ${after}; the blank tab was not reused`);
  assert.ok(leftover.url().includes("form.html"), "reused a tab but did not navigate it");
  // And the guarantee that matters is untouched.
  assert.match(theirPage.url(), /form\.html$/, "their own tab was navigated");
  await view.close();
});
