// One browser session and the actions an agent needs, each answering in words about what happened
// rather than throwing on the first surprise. Targets are refs from a snapshot ("e12") or a short
// description: 'button "Next"', 'link Pricing', or plain text.
import { chromium, firefox, webkit } from "playwright";
import { readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { collect, render } from "./snapshot.mjs";

const PROFILE = process.env.AB_PROFILE || join(homedir(), ".cache/agent-browser/profile");
// AB_BROWSER picks the engine. Chromium is the default because it is what most sites are built
// against and what CDP attach needs, but nothing here is Chromium-specific: the snapshot runs in
// the page, and every action goes through Playwright's own API.
const ENGINES = { chromium, firefox, webkit };
// AB_CHANNEL="chrome" launches the REAL Google Chrome that is installed, rather than the Chromium
// build Playwright ships. That is not a disguise - it is a genuinely different, genuinely normal
// browser - and it matters because Cloudflare's strict mode rejects Playwright's build outright,
// looping its challenge forever so that even a human at a visible window cannot clear it.
const CHANNEL = process.env.AB_CHANNEL || null;
const ENGINE_NAME = (process.env.AB_BROWSER || "chromium").toLowerCase();
const ENGINE = ENGINES[ENGINE_NAME] || chromium;
const CREDS = process.env.AB_CREDS || join(homedir(), ".config/rebel-studios/creds.env");
// Downloads have to be accepted and given somewhere to go, or Playwright throws them away and a
// click on "Export" looks like it did nothing.
const DOWNLOAD_DIR = process.env.AB_DOWNLOADS || join(homedir(), ".cache/agent-browser/downloads");
// AB_CDP drives a browser that is ALREADY RUNNING AND ALREADY SIGNED IN, instead of launching a
// fresh one. This is the difference between being able to work someone's Play Console, Google
// Groups or Kaggle and not: those need a real session, and automating the login is neither
// possible (2FA) nor something to do on someone's behalf.
//
// Set it to a port or a full URL. The browser has to have been started with the matching flag:
//   google-chrome --remote-debugging-port=9224
// cli/attach.mjs did this for one-off scripts; this makes every tool work the same way.
const CDP = process.env.AB_CDP ? (/^\d+$/.test(process.env.AB_CDP)
  ? `http://127.0.0.1:${process.env.AB_CDP}` : process.env.AB_CDP) : null;
let attached = false; // when true, close() detaches and leaves the owner's browser running
const downloaded = [];

let ctx = null;
let browser = null; // only in ephemeral mode, where the context doesn't own the browser
let page = null;
let inflight = 0;
let lastReq = 0;
let reqCount = 0; // monotonic: settle uses it to tell whether the page has fetched for itself yet
// DevTools signals an agent cannot get from the DOM. Bounded, because a chatty page would
// otherwise grow these without limit over a long session, and cleared on navigation so
// "errors on this page" means THIS page rather than everything since the server started.
const LOG_CAP = { console: 200, network: 400 };
let consoleLog = [];
let netLog = [];
// Request object -> its log entry, so an outcome can be filled in later. Weak: when Playwright
// drops the Request, the mapping goes with it.
let netIndex = new WeakMap();

/** A persistent context, so a login made once survives between sessions. Headless unless AB_HEADED=1. */
export async function session({ fresh = false } = {}) {
  if (ctx && !fresh) {
    // A CONTEXT CAN DIE UNDER US and the old code handed the dead handle back regardless, so
    // every later call failed with "Target page, context or browser has been closed" - forever,
    // with no recovery short of restarting the server. It happens for ordinary reasons: the
    // browser crashes, another process takes the persistent profile, or anything calls close().
    // Check the handle is alive, reuse a live tab if there is one, and only rebuild if not.
    try {
      if (page && !page.isClosed()) return page;
      const live = ctx.pages().find((q) => !q.isClosed());
      page = live || (await ctx.newPage());
      watch(page);
      return page;
    } catch {
      ctx = null;           // the context itself is gone; fall through and relaunch below
      page = null;
    }
  }
  if (ctx && !attached) await ctx.close().catch(() => {});
  const opts = { headless: process.env.AB_HEADED !== "1", viewport: { width: 1280, height: 900 }, acceptDownloads: true };
  if (CHANNEL && ENGINE_NAME === "chromium") opts.channel = CHANNEL;

  if (CDP) {
    // Its own page, never one of theirs: navigating a tab out from under someone loses whatever
    // they were doing in it.
    browser = await chromium.connectOverCDP(CDP);
    ctx = browser.contexts()[0];
    if (!ctx) throw new Error(`nothing to attach to at ${CDP} — is the browser running with --remote-debugging-port?`);
    attached = true;
    // REUSE A BLANK TAB RATHER THAN ADDING ONE. Every fresh process attaches, and the old code
    // opened a page each time — driving one flow across a handful of script runs left a row of
    // empty tabs in someone's real browser, which is its own small rudeness.
    //
    // Only a blank tab qualifies. Anything with a URL is work in progress, possibly theirs, and
    // the promise this feature makes is that it never navigates one of those. A page sitting on
    // about:blank has nothing to lose.
    const spare = ctx.pages().find((q) => !q.isClosed() && /^about:blank$/.test(q.url()));
    page = spare || (await ctx.newPage());
    watch(page);
    ctx.on("page", (q) => { page = q; watch(q); });
    return page;
  }

  if (process.env.AB_EPHEMERAL === "1") {
    browser = await ENGINE.launch({ headless: opts.headless });
    ctx = await browser.newContext({ viewport: opts.viewport });
  } else {
    // Each engine gets its own profile directory: they are not interchangeable on disk, and
    // pointing Firefox at a Chromium profile fails in ways that look like a bug in this tool.
    ctx = await ENGINE.launchPersistentContext(
      ENGINE_NAME === "chromium" ? PROFILE : `${PROFILE}-${ENGINE_NAME}`, opts);
  }
  page = ctx.pages()[0] || (await ctx.newPage());
  watch(page);
  ctx.on("page", (p) => { page = p; watch(p); }); // a link that opens a tab: follow it
  return page;
}

// Dialogs would block the page. Alerts are acknowledged. A confirm is how a page asks "are you
// sure?" before something destructive, so it is DISMISSED unless the click said confirm: true;
// either way the reply says what it asked.
const dialogs = [];
let acceptNextConfirm = false;
export const takeDialogs = () => dialogs.splice(0).map((d) => `a ${d.type} said: "${d.message}" (${d.outcome})`);

/** Append to a bounded log, dropping the oldest. An unbounded one grows for the whole session. */
function push(log, kind, entry) {
  log.push(entry);
  if (log.length > LOG_CAP[kind]) log.splice(0, log.length - LOG_CAP[kind]);
}

function watch(p) {
  p.on("download", async (d) => {
    try {
      await mkdir(DOWNLOAD_DIR, { recursive: true });
      const name = d.suggestedFilename() || `download-${Date.now()}`;
      const to = join(DOWNLOAD_DIR, name);
      await d.saveAs(to);
      const { size } = await import("node:fs").then((fs) => fs.promises.stat(to)).catch(() => ({ size: null }));
      downloaded.push({ name, path: to, bytes: size });
    } catch (e) {
      downloaded.push({ name: "(failed)", path: String(e.message || e).slice(0, 120), bytes: null });
    }
  });
  p.on("dialog", async (d) => {
    const type = d.type();
    const accept = type === "alert" || type === "beforeunload" || (type === "confirm" && acceptNextConfirm);
    if (type === "confirm") acceptNextConfirm = false;
    dialogs.push({ type, message: d.message().slice(0, 200), outcome: accept ? "accepted" : "dismissed; click again with confirm: true to accept it" });
    await (accept ? d.accept() : d.dismiss()).catch(() => {});
  });
  // lastReq, not just the counter: a request cancelled by a navigation fires neither
  // requestfinished nor requestfailed, so `inflight` leaks upward and never returns to 0 -
  // measured, after a settle() keyed on `inflight === 0` hit its cap on every page including
  // example.com. A timestamp cannot leak.
  p.on("request", () => { inflight++; reqCount++; lastReq = Date.now(); });
  const done = () => { inflight = Math.max(0, inflight - 1); };
  p.on("requestfinished", done);
  p.on("requestfailed", done);
  // CONSOLE AND NETWORK, the two things a page will not tell you through the DOM. A tracker that
  // fires, a 500 on an XHR and a thrown error are all invisible to a snapshot: the Apollo pixel on
  // trade-guard.pro was only provable from the network log, because it is injected after hydration
  // and leaves nothing in the served HTML.
  p.on("console", (m) => {
    const type = m.type();
    if (type !== "error" && type !== "warning" && type !== "log") return;
    push(consoleLog, "console", { type, text: m.text().slice(0, 300), at: Date.now() });
  });
  p.on("pageerror", (e) => push(consoleLog, "console", { type: "pageerror", text: String(e.message || e).split("\n")[0].slice(0, 300), at: Date.now() }));
  // Logged when the request is MADE, then updated with its outcome.
  //
  // Recording only on response/requestfailed made a request that had not finished invisible, which
  // hides the two cases you most want to see: a call still hanging, and a tracker whose DNS is
  // slow. It also made the test for third-party requests flaky, because whether the cross-origin
  // fetch had failed yet by the time the page settled was a race.
  p.on("response", (r) => {
    const e = netIndex.get(r.request());
    if (e) e.status = r.status();
  });
  p.on("requestfailed", (r) => {
    const e = netIndex.get(r);
    if (e) { e.status = 0; e.failure = (r.failure()?.errorText || "failed").slice(0, 80); }
  });
  // A new document means a new page's worth of errors; keeping the old ones makes a clean page
  // look broken. Only the main frame counts - an iframe navigating is not a new page.
  //
  // CLEARED WHEN THE NAVIGATION IS REQUESTED, not on framenavigated. framenavigated fires after
  // the new document has committed, which is after its OWN response event, so clearing there
  // deleted the main document's entry - the log read "no requests recorded for this page" on a
  // page that had just served one. Caught by using this on trade-guard.pro while it was 502ing:
  // the 502 itself had vanished from the log.
  p.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === p.mainFrame()) { consoleLog = []; netLog = []; }
    const e = { url: r.url().slice(0, 300), method: r.method(), status: null, type: r.resourceType(), at: Date.now() };
    netIndex.set(r, e);
    push(netLog, "network", e);
  });
  // when the DOM last changed, so "still loading" can be told from "not there"
  p.addInitScript(() => {
    window.__abMut = Date.now();
    new MutationObserver(() => { window.__abMut = Date.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }).catch(() => {});
}

/**
 * The open tabs, and switching between them.
 *
 * A link that opens a tab was already followed, but there was no way back and no way to see what
 * else was open — so a flow that opens a receipt in a new tab left the original page unreachable.
 * `to` switches by index or by a substring of the title or URL; `shut` closes one.
 */
export async function tabs({ to, shut } = {}) {
  const p = await session();
  const all = ctx.pages().filter((q) => !q.isClosed());
  const describe = async (q, i) =>
    `${i + 1}${q === page ? " *" : "  "} ${(await q.title().catch(() => "")) || "(untitled)"} — ${q.url()}`;

  const pick = (spec) => {
    if (typeof spec === "number" || /^\d+$/.test(String(spec))) return all[Number(spec) - 1];
    const q = String(spec).toLowerCase();
    return all.find((x) => x.url().toLowerCase().includes(q));
  };

  if (shut !== undefined) {
    const target = pick(shut);
    if (!target) return `no tab matches ${JSON.stringify(shut)}\n` + (await Promise.all(all.map(describe))).join("\n");
    if (all.length === 1) return "that is the only tab; use close to end the session instead";
    const wasCurrent = target === page;
    await target.close().catch(() => {});
    const left = ctx.pages().filter((q) => !q.isClosed());
    if (wasCurrent) { page = left[left.length - 1]; watch(page); lastSnap = null; }
    return `closed it; ${left.length} tab${left.length === 1 ? "" : "s"} left\n` +
      (await Promise.all(left.map(describe))).join("\n");
  }

  if (to !== undefined) {
    const target = pick(to);
    if (!target) return `no tab matches ${JSON.stringify(to)}\n` + (await Promise.all(all.map(describe))).join("\n");
    page = target;
    watch(page);
    lastSnap = null; // a different page is a different baseline; the next reply is a full snapshot
    await page.bringToFront().catch(() => {});
    return `switched to it\n\n` + (await snapshot());
  }

  // The current tab is marked, because "which one am I driving" is the question this usually answers.
  return (await Promise.all(all.map(describe))).join("\n") + `\n(* is the one being driven)`;
}

/**
 * Files the page downloaded since the session started, saved to disk.
 *
 * A download used to go nowhere: Playwright discards it unless something asks for it, so clicking
 * "Export CSV" appeared to do nothing at all. They now land in a directory and this lists them.
 */
export async function downloads({ waitSeconds = 0 } = {}) {
  await session();
  // A DOWNLOAD LANDS AFTER THE CLICK RETURNS, so asking straight away often finds nothing and the
  // caller has to invent a sleep. My own test had to swallow a bogus `wait` for exactly this.
  // `waitSeconds` waits for the count to grow, and returns the moment it does.
  if (waitSeconds > 0) {
    const had = downloaded.length;
    const until = Date.now() + waitSeconds * 1000;
    while (Date.now() < until && downloaded.length === had) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (downloaded.length === had) {
      return `nothing downloaded in ${waitSeconds}s.` +
        (downloaded.length ? ` ${downloaded.length} from earlier:\n` +
          downloaded.map((d) => `${d.name} — ${d.path}`).join("\n") : ` (they save to ${DOWNLOAD_DIR})`);
    }
  }
  if (!downloaded.length) return `no downloads yet (they save to ${DOWNLOAD_DIR})`;
  return downloaded.map((d) => `${d.name} — ${d.path}${d.bytes != null ? ` (${d.bytes} bytes)` : ""}`).join("\n");
}

/**
 * Hand a bot wall to the person sitting there, then carry on.
 *
 * This is the honest way past a challenge, and the only one this tool will do. A CAPTCHA exists to
 * ask whether a human is present; if one is, the answer is yes and they can say so themselves. What
 * it refuses to do is *pretend* — spoofing a fingerprint is a race lost on the next update, breaks
 * the terms of most sites worth visiting, and would get the plugin delisted.
 *
 * It works because the profile is persistent: the browser reopens at the same URL with a visible
 * window, the person clears the challenge once, and the cookie that buys stays bought. Later runs
 * go straight through, headless, with no challenge at all.
 *
 * Returns when the wall is gone, or says plainly that it is still there.
 */
export async function solve({ seconds = 180 } = {}) {
  const p = await session();
  const url = p.url();
  if (!url || url === "about:blank") return "no page open to solve";
  if (process.env.AB_EPHEMERAL === "1") {
    return "AB_EPHEMERAL=1 throws the profile away, so solving a challenge here buys nothing that survives. Unset it and try again.";
  }
  if (!process.env.DISPLAY && process.platform === "linux") {
    return "no DISPLAY, so a window cannot be shown. Run this where there is a desktop, or attach to a browser you are already signed into with AB_CDP.";
  }
  if (attached) return "already driving your own browser — clear the challenge in the window you can see, then carry on.";

  // Relaunch visible, on the same persistent profile, at the same page.
  const wasHeaded = process.env.AB_HEADED;
  process.env.AB_HEADED = "1";
  // Not just visible - a REAL browser. Cloudflare's strict mode loops its challenge against
  // Playwright's Chromium build however long a human stares at it, so a visible window alone is
  // not enough. Measured on claude.ai: 170 seconds of a person clicking, still challenged.
  const wasChannel = process.env.AB_CHANNEL;
  if (!wasChannel && ENGINE_NAME === "chromium") process.env.AB_CHANNEL = "chrome";
  try {
    await close();
    const q = await session();
    await q.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    const deadline = Date.now() + seconds * 1000;
    // Poll the page's own verdict rather than a clock: the challenge is gone when the snapshot
    // stops saying it is there.
    while (Date.now() < deadline) {
      await q.waitForTimeout(1500);
      const state = await q.evaluate(collect, { limit: 5 }).catch(() => null);
      if (state && !state.challenge) {
        await settle(q);
        return `the challenge is cleared, and the profile keeps it — later runs should go straight through.\n\n${await snapshot()}`;
      }
    }
    // STILL CHALLENGED AFTER A PERSON SAT THERE means this is not a CAPTCHA a human can clear here:
    // Cloudflare's strict mode rejects a Playwright-driven browser on sight and loops the challenge
    // forever. Measured on claude.ai 2026-09-25 — 170s of clicking, headed, and again with the real
    // Google Chrome binary. Saying "try again" to that wastes another three minutes, so say the
    // thing that actually works instead.
    return [
      `still challenged after ${seconds}s, which means this site is refusing the automation itself`,
      `rather than asking a question you can answer. Clicking for longer will not change it.`,
      ``,
      `The way in is a browser THIS TOOL DID NOT LAUNCH — one you started yourself, already signed`,
      `in, where the site has already cleared you:`,
      ``,
      `  1. close Chrome, then start it with:  google-chrome --remote-debugging-port=9224`,
      `  2. run this tool with:                AB_CDP=9224`,
      ``,
      `Every tool then drives that session, and close() detaches instead of shutting your browser.`,
    ].join("\n");
  } finally {
    if (wasHeaded === undefined) delete process.env.AB_HEADED; else process.env.AB_HEADED = wasHeaded;
    if (wasChannel === undefined) delete process.env.AB_CHANNEL; else process.env.AB_CHANNEL = wasChannel;
  }
}

/**
 * The page as prose, for when the answer is in the writing rather than the controls.
 *
 * The snapshot describes what you can DO with a page; it deliberately says almost nothing about
 * what the page SAYS, because an outline of a hundred controls plus the full article would be the
 * dump this tool exists to avoid. That left "read the page" going through the `js` escape hatch,
 * which is a gap with a workaround rather than a feature.
 *
 * Takes the main content, drops the furniture (nav, header, footer, script, style, aside), and
 * returns it in slices so a long article can be walked rather than swallowed. `find` jumps to the
 * first slice containing a phrase, which is usually what you actually wanted.
 */
export async function read({ chars = 3000, slice = 1, find = "" } = {}) {
  const p = await session();
  const text = await p.evaluate(({ find }) => {
    const root = document.querySelector("main, [role=main], article") || document.body;
    const copy = root.cloneNode(true);
    for (const el of copy.querySelectorAll("nav, header, footer, aside, script, style, noscript, [role=navigation], [role=contentinfo], [role=banner]")) el.remove();
    return (copy.innerText || "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
  }, { find }).catch(() => "");
  if (!text) return "no readable text on this page (it may be an app rather than a document — try snapshot)";

  const total = Math.max(1, Math.ceil(text.length / chars));

  if (find) {
    const at = text.toLowerCase().indexOf(String(find).toLowerCase());
    if (at < 0) return `"${find}" is not in the ${text.length} characters of this page (${total} slices)`;
    // CENTRED ON THE MATCH, not "whichever slice the match happens to start in". Snapping to a
    // fixed grid cuts the phrase in half whenever it straddles a boundary — which is most of the
    // time with a small window, and is useless exactly when someone is looking for something.
    const from = Math.max(0, at - Math.floor((chars - find.length) / 2));
    const to = Math.min(text.length, from + chars);
    const lead = from > 0 ? "…" : "";
    const tail = to < text.length ? "…" : "";
    return `around "${find}" (character ${at} of ${text.length})\n\n${lead}${text.slice(from, to)}${tail}`;
  }

  const n = Math.min(Math.max(1, slice), total);
  const body = text.slice((n - 1) * chars, n * chars);
  const head = total > 1 ? `slice ${n} of ${total} (${text.length} characters in all)\n\n` : "";
  return head + body;
}

export async function close() {
  // ATTACHED MEANS BORROWED. Closing the context would shut the owner's browser and every tab in
  // it, so only the page we opened goes, and the connection is dropped.
  if (attached) {
    if (page && !page.isClosed()) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {}); // disconnects; does not kill the browser
    ctx = null; browser = null; page = null; attached = false;
    return;
  }
  if (ctx) await ctx.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  ctx = null;
  browser = null;
  page = null;
}

/**
 * The page, INCLUDING WHAT IS INSIDE ITS IFRAMES.
 *
 * `collect` runs inside one document, so it could only ever see the main frame — and an iframe is
 * where the interesting controls often live: a payment form, an embedded editor, a consent dialog,
 * a sign-in widget. Those came back as nothing at all, which is the worst kind of failure because
 * the page looked empty rather than looked wrong, and the caller went hunting for a selector that
 * was never going to exist in the document being searched.
 *
 * Each child frame is collected separately and its refs are prefixed — `f2e7` is element 7 in frame
 * 2 — so a ref still addresses exactly one element and `locate` knows which document to look in.
 * Frames that are blank, tiny or cross-origin-unreadable are skipped rather than reported as empty.
 */
async function collectFrames(p, opts) {
  const frames = p.frames().filter((f) => f !== p.mainFrame());
  const out = [];
  let n = 0;
  for (const f of frames) {
    n++;
    if (n > 8) break; // an ad-heavy page can carry dozens; past a handful this stops being useful
    try {
      const url = f.url();
      if (!url || url === "about:blank") continue;
      const got = await f.evaluate(collect, { ...opts, limit: Math.min(opts.limit ?? 60, 25) });
      if (!got.lines.length) continue;
      const label = `frame f${n}: ${got.title || new URL(url).host}`;
      // Prefix the refs so they stay unique across documents.
      const body = render(got, { ...opts, withText: false })
        .split("\n").slice(2)
        .map((l) => l.replace(/\[e(\d+)\]/g, `[f${n}e$1]`))
        .filter(Boolean);
      if (body.length) out.push("", label, ...body.map((l) => "  " + l));
    } catch {
      // A cross-origin frame we cannot read is named, not silently dropped: knowing it is there and
      // unreadable is what tells a caller to look for another way in.
      out.push("", `frame f${n}: (a different origin; its contents cannot be read from here)`);
    }
  }
  return out;
}

export async function snapshot(opts = {}) {
  const p = await session();
  const main = render(await p.evaluate(collect, opts), opts);
  const frames = await collectFrames(p, opts);
  const out = frames.length ? main + "\n" + frames.join("\n") : main;
  // Asking for the page in full resets what "changed" is measured against, so an explicit
  // snapshot always tells the whole truth and the next diff is honest about the same baseline.
  if (!opts.find && !opts.scope) lastSnap = out;
  return out;
}

/**
 * Wait until the page is usable, which is NOT the same as networkidle.
 *
 * networkidle needs 500ms with no requests at all, so a page that polls, beacons analytics or
 * holds a socket open never reaches it and burns the whole timeout every single navigation.
 * Measured 2026-09-24: the boss dashboard finishes domcontentloaded in 116ms and then waits the
 * full 4000ms for a silence that never arrives - a 34x tax - and docs.stripe.com does the same.
 * Two of four real pages timed out; the two that did not still paid 500-1500ms, because 500ms of
 * enforced silence is networkidle's floor by definition.
 *
 * So ask the two questions that actually decide whether a page can be driven: has the DOM
 * stopped changing, and is anything still in flight. Both signals already exist (__abMut is set
 * by a MutationObserver in the init script, inflight by the request hooks above). Returns as soon
 * as they agree, rather than waiting out a clock.
 */
async function settle(p, ms = 2000) {
  await p.waitForLoadState("domcontentloaded", { timeout: ms }).catch(() => {});
  const start = Date.now(), end = start + ms;
  // A GATE BEFORE THE EARLY EXIT CAN FIRE. Straight after first paint there is a window where the
  // DOM is quiet and nothing has been requested yet, because the page's own script has not run its
  // fetches. Exiting there returns a shell: the boss dashboard came back reading "Scanning ~ ..."
  // with every data card still empty.
  //
  // This used to be a flat 400ms wait, and that turned out to be the binding constraint on most
  // pages rather than the page itself: measured 2026-09-25, settle exited at 426-430ms on three of
  // four real pages — the floor plus one poll tick — while the page had been ready earlier.
  //
  // So the gate now opens on the SIGNAL rather than the clock: once the page has issued a request
  // of its own since navigation, its script is demonstrably running and the quiet checks below can
  // be trusted. The 150ms is only a backstop for a page that never fetches anything at all.
  //
  // Verified to change the waiting and not the answer: identical snapshots on five live pages, and
  // on the boss dashboard — the page this floor was written for — it is both faster (2370ms ->
  // 1400ms) and MORE consistent, returning the same 2605 characters on every run where the old
  // floor returned 2578/2603/2605 and so was sometimes catching the page mid-render.
  const FLOOR = 150;
  const reqAtStart = reqCount;
  while (Date.now() < end) {
    const elapsed = Date.now() - start;
    if (elapsed < FLOOR && reqCount === reqAtStart) { await p.waitForTimeout(40); continue; }
    const quiet = await p.evaluate(() => Date.now() - (window.__abMut || 0)).catch(() => 9999);
    // 250ms since the last DOM change AND since the last request STARTED. Both are timestamps,
    // so neither can get stuck the way a counter does; a page with a heartbeat settles between
    // beats instead of never settling at all.
    if (quiet >= 250 && Date.now() - lastReq >= 250) return;
    await p.waitForTimeout(40);
  }
}

// Two URLs pointing at the same page, hash aside. Used after a failed navigation to tell "the
// browser is still on the page it was already on" from "it actually moved".
function sameLocation(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
  } catch {
    return a === b;
  }
}

export async function open(url) {
  const p = await session();
  const res = await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => ({ error: e.message }));
  await settle(p);
  // Describe the tab we actually navigated. open() is an explicit navigation, so if a popup opens
  // while the page loads (or a stray one from an earlier action arrives late), its "page" event
  // must not swing the current tab out from under us and make snapshot() report the popup instead.
  // That is the WebKit-CI flake of 2026-09-25: a receipt tab opened by the previous test landed
  // mid-open and open() snapshotted it rather than the page it had just loaded. Switching to a
  // popup is the tabs tool's job, never a silent side effect of open().
  page = p;
  // A goto that THREW never arrived. A download aborts the navigation and leaves the old page in
  // place; an invalid or dead URL is rejected before anything moves. Either way the browser is still
  // on whatever it showed before, so snapshotting now would describe that PREVIOUS page -- its refs,
  // its login flag, its form -- under the URL the caller just asked for, and an agent would go on to
  // fill a "login form" that belongs to a page it never left. Report the failure and where the
  // browser really is instead of dressing up the last page as this one. (An HTTP 403/404 does NOT
  // throw -- it resolves with a response -- so a served error or block page still comes through the
  // branch below, which is exactly where that content belongs.)
  if (res?.error) {
    const msg = res.error.split("\n")[0];
    const at = p.url();
    const stale = at && !/^(about:|chrome-error:)/.test(at) && !sameLocation(at, url);
    return `could not load ${url}: ${msg}`
      + (/download is starting/i.test(msg) ? "\nThat URL is a file download, not a page — fetch it directly rather than opening it." : "")
      + (stale ? `\nThe browser did not move; it is still on ${at}, so a snapshot now would describe that page, not this URL.` : "");
  }
  // res IS NULLABLE. Playwright returns null from goto() when the navigation produced no response
  // of its own — a same-document jump, and on Firefox a file:// load. An earlier version of this
  // line had a `res &&` guard, a rewrite dropped it, and the result was a null dereference that
  // Chromium never hit and Firefox hit on every single test: 25 of 44 red, from one missing guard.
  const status = res && res.status() >= 400 ? `HTTP ${res.status()}\n` : "";
  return status + (await snapshot());
}

/** A snapshot ref or a short description, as a Playwright locator for one visible element. */
export async function locate(target) {
  const p = await session();
  const t = String(target).trim();
  if (/^e\d+$/.test(t)) return p.locator(`[data-ab="${t}"]`).first();
  // A prefixed ref (f2e7) addresses an element inside the nth child frame.
  const inFrame = t.match(/^f(\d+)e(\d+)$/);
  if (inFrame) {
    const frames = p.frames().filter((f) => f !== p.mainFrame());
    const f = frames[Number(inFrame[1]) - 1];
    if (!f) return null;
    return f.locator(`[data-ab="e${inFrame[2]}"]`).first();
  }
  const m = t.match(/^(button|link|textbox|checkbox|radio|tab|menuitem|combobox|heading|option)\s+["“]?(.+?)["”]?$/i);
  const candidates = m
    ? [p.getByRole(m[1].toLowerCase(), { name: m[2] }), p.getByRole(m[1].toLowerCase(), { name: m[2], exact: false })]
    : [p.getByRole("button", { name: t }), p.getByRole("link", { name: t }), p.getByLabel(t), p.getByPlaceholder(t), p.getByText(t, { exact: false })];
  for (const c of candidates) {
    const n = await c.count().catch(() => 0);
    const visible = [];
    for (let i = 0; i < Math.min(n, 8); i++) if (await c.nth(i).isVisible().catch(() => false)) visible.push(c.nth(i));
    if (!visible.length) continue;
    // FIRST-MATCH-WINS WAS SILENTLY WRONG. On Google Groups "Create group" is both the sidebar
    // button and the wizard's submit; taking the first one reopened the sidebar instead of
    // creating the group, and nothing in the reply said a choice had been made. Still act on the
    // first (usually right, and stopping would be worse), but record it so the reply can say so.
    if (visible.length > 1) {
      const where = await Promise.all(visible.slice(0, 4).map(async (v) => {
        const d = await describe(v).catch(() => "element");
        const box = await v.boundingBox().catch(() => null);
        return box ? `${d} at ${Math.round(box.x)},${Math.round(box.y)}` : d;
      }));
      lastAmbiguity = `${visible.length} visible elements match ${JSON.stringify(t)} - used the first. Others: ${where.slice(1).join("; ")}. Pass a snapshot ref (e12) to be exact.`;
    }
    return visible[0];
  }
  return null;
}

/**
 * How much of a page is actually THERE right now: visible interactive controls, and how much text.
 * Cheap enough to call on a miss, and it is what separates "no such button" from "nothing has
 * rendered yet", which read identically to a caller and are opposite instructions.
 */
async function pageSubstance(p) {
  return p.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
    };
    const controls = [...document.querySelectorAll(
      'a,button,input,select,textarea,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]')]
      .filter(vis).length;
    const text = (document.body?.innerText || "").trim().length;
    // The usual "still working" tells, so a spinner is not mistaken for a finished empty page.
    const busy = Boolean(
      document.querySelector('[aria-busy="true"],[role="progressbar"],.loading,.spinner,.skeleton')
      || /\bloading\b|\bplease wait\b/i.test((document.body?.innerText || "").slice(0, 400)));
    return { controls, text, busy };
  }).catch(() => ({ controls: 0, text: 0, busy: false }));
}

/** A page with almost nothing on it has not finished, whatever the load event said. */
const looksUnrendered = (s) => s.busy || (s.controls <= 2 && s.text < 120);

/**
 * locate(), but a miss is investigated rather than reported flat.
 *
 * WHY. A miss has two causes that look identical and mean opposite things: the element is not on
 * this page, or the page has not drawn it yet. Single-page apps produce the second constantly --
 * the content arrives after navigation has long since settled. Treating that as "not there" is the
 * expensive direction: it cost a real duplicate-send scare on 2026-09-28, where a Gmail Sent
 * search rendered zero rows and the honest answer "I cannot tell" was reported as "it did not
 * send".
 *
 * So: on a miss, if the page looks unrendered, wait for it and try again; and either way record
 * WHICH of the two it was, so the reply can say "not on this page" or "the page had not rendered".
 */
export async function locateOrExplain(target, { waitMs = 4000 } = {}) {
  let loc = await locate(target).catch(() => null);
  if (loc) return loc;
  const p = await session();
  let sub = await pageSubstance(p);
  if (looksUnrendered(sub)) {
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
      await p.waitForTimeout(250);
      loc = await locate(target).catch(() => null);
      if (loc) { lastMiss = null; return loc; }
      sub = await pageSubstance(p);
      if (!looksUnrendered(sub)) break;        // it filled in, and the target still is not there
    }
    loc = await locate(target).catch(() => null);
    if (loc) { lastMiss = null; return loc; }
  }
  lastMiss = looksUnrendered(sub)
    ? `the page still looks unrendered after waiting (${sub.controls} visible controls, `
      + `${sub.text} chars of text${sub.busy ? ", and it reports itself busy" : ""}), so this is `
      + `"cannot tell yet", NOT "not present" -- do not conclude the thing is absent`
    : `the page is populated (${sub.controls} visible controls, ${sub.text} chars) and still has `
      + `no match, so it is genuinely not on this page`;
  return null;
}

// Set by locate() when a target was ambiguous; drained by whatever acted, so the reply can admit
// that it picked one of several rather than leaving the caller to find out from the result.
let lastAmbiguity = null;
export const takeAmbiguity = () => { const a = lastAmbiguity; lastAmbiguity = null; return a; };

// Set by locateOrExplain() when nothing matched, saying WHICH kind of miss it was.
let lastMiss = null;
export const takeMiss = () => { const m = lastMiss; lastMiss = null; return m; };

/** Formats the miss reason for a reply, or nothing when there is none to add. */
function missNote() {
  const m = takeMiss();
  return m ? `\n  (${m})` : "";
}

/**
 * How an element is named in replies: its label, never a field's value. (A value can be a secret
 * just typed by fill_secret; the first version of this read it back into the transcript.)
 */
const describe = async (loc) => loc.evaluate((el) => {
  const tag = el.tagName.toLowerCase();
  const isButton = tag === "input" && ["submit", "button", "reset"].includes(el.type);
  const lab = () => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText; }
    const w = el.closest("label");
    if (!w) return "";
    const c = w.cloneNode(true);
    c.querySelectorAll("select, textarea, input, button").forEach((x) => x.remove());
    return c.textContent;
  };
  const field = ["input", "textarea", "select"].includes(tag) && !isButton;
  const txt = el.getAttribute("aria-label") || (field ? lab() || el.getAttribute("placeholder") || el.getAttribute("name") : isButton ? el.value : el.innerText) || "";
  return `${field ? "field" : tag} "${txt.replace(/\s+/g, " ").trim().slice(0, 60)}"`;
}).catch(() => "element");

/**
 * Make sure a click lands on the target: scroll it into view, and if something else sits on top
 * (a cookie bar, a chat bubble, a sticky footer), press its dismiss button or hide it. Returns a
 * note for each thing moved out of the way.
 */
async function clearPath(p, loc) {
  const notes = [];
  for (let round = 0; round < 3; round++) {
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    const box = await loc.boundingBox().catch(() => null);
    if (!box) return notes;
    const note = await loc.evaluate((target, pt) => {
      const hit = document.elementFromPoint(pt.x, pt.y);
      if (!hit || target === hit || target.contains(hit) || hit.contains(target)) return null;
      let layer = hit;
      for (let n = hit; n && n !== document.body; n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === "fixed" || pos === "sticky") { layer = n; break; }
      }
      const say = (el) => `"${(el.innerText || el.getAttribute("aria-label") || el.tagName).replace(/\s+/g, " ").trim().slice(0, 60)}"`;
      const dismiss = [...layer.querySelectorAll('button, a, [role="button"]')].find((b) =>
        /^(accept( all)?( cookies)?|agree|i agree|got it|ok(ay)?|close|dismiss|no,? thanks|reject( all)?|decline|continue without accepting|×|✕|x)$/i.test((b.innerText || b.getAttribute("aria-label") || "").trim()));
      if (dismiss) { dismiss.click(); return `pressed ${say(dismiss)} on an overlay ${say(layer)}`; }
      const what = say(layer); // before hiding: a hidden element has no innerText
      layer.style.setProperty("visibility", "hidden", "important");
      layer.dataset.abHidden = "1";
      return `hid an overlay covering the target: ${what}`;
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    if (!note) return notes;
    notes.push(note);
    await p.waitForTimeout(300);
  }
  return notes;
}

// The last snapshot we handed back, so the next one can say what CHANGED instead of repeating it.
// Reset on navigation, where "changed" stops being meaningful.
let lastSnap = null;
let diffsOn = true;
/** Turn diff replies off (the benchmark measures both routes; callers who want every reply in full). */
export function setDiffs(on) { diffsOn = !!on; lastSnap = null; }

/**
 * What an action returns: what happened, then the page.
 *
 * THE PAGE IS SENT AS A DIFF WHERE THAT IS HONEST, and this is the single biggest saving in real
 * use. A page costs ~3,000 characters; a ten-step task used to cost ten of those, even though
 * steps two through ten mostly re-sent what step one already said. Clicking "Next" in a wizard
 * changes a handful of lines and repeats sixty.
 *
 * So after an action on the SAME page, only the added, removed and changed lines go back, with a
 * count of what held still. The full snapshot is still sent when it is the honest answer: on a new
 * URL, when there is nothing to compare against, or when more than half the page moved — past that
 * point a diff is both longer and harder to read than simply saying what is there now.
 *
 * Refs survive a re-render (they live on the element), which is what makes the comparison mean
 * something: a line that is "unchanged" really is the same element, not a coincidence of text.
 */
function diffSnap(prev, next) {
  if (!prev) return { text: next, full: true };
  const line = (l) => l.trim();
  const prevLines = prev.split("\n").map(line);
  const nextLines = next.split("\n").map(line);
  const prevSet = new Set(prevLines);
  const nextSet = new Set(nextLines);
  const added = nextLines.filter((l) => l && !prevSet.has(l));
  const gone = prevLines.filter((l) => l && !nextSet.has(l));
  const held = nextLines.filter((l) => l && nextSet.has(l) && prevSet.has(l)).length;
  if (!added.length && !gone.length) return { text: `the page is unchanged (${held} elements)`, full: false };
  // More than half the page moved: a diff stops being the shorter or clearer answer.
  if (added.length + gone.length > held) return { text: next, full: true };
  const body = [
    `changed: +${added.length} -${gone.length}, ${held} unchanged`,
    ...added.slice(0, 30).map((l) => `+ ${l}`),
    ...gone.slice(0, 10).map((l) => `- ${l}`),
  ];
  if (added.length > 30) body.push(`… ${added.length - 30} more added (ask for a snapshot to see all)`);
  return { text: body.join("\n"), full: false };
}

async function after(p, before, notes, { snap = true } = {}) {
  await settle(p, 3000);
  const out = [...notes, ...takeDialogs()];
  const moved = p.url() !== before;
  if (moved) out.push(`now at ${p.url()}`);
  if (snap) {
    // THE BASELINE IS TAKEN BEFORE THE FRESH SNAPSHOT, because snapshot() updates lastSnap itself.
    // Reading it afterwards compared the page against a copy of itself and answered "the page is
    // unchanged" to every action, however much had moved -- a wrong answer that was also short,
    // so it looked like a saving in the benchmark right up until a test asked what it actually said.
    const baseline = lastSnap;
    const fresh = await snapshot({ limit: 40 });
    // A new document is a new page; there is nothing meaningful to diff against.
    const d = moved || !diffsOn ? { text: fresh, full: true } : diffSnap(baseline, fresh);
    lastSnap = fresh;
    out.push("", d.text);
  }
  return out.join("\n");
}

export async function click(target, opts = {}) {
  const p = await session();
  acceptNextConfirm = !!opts.confirm;
  const loc = await locateOrExplain(target);
  if (!loc) return `no visible element matches ${JSON.stringify(target)}${missNote()}\n\n${await snapshot({ find: /^e\d+$/.test(target) ? "" : String(target).split(/\s+/).pop(), limit: 20 })}`;
  const what = await describe(loc);
  const ambiguous = takeAmbiguity();
  if (await loc.isDisabled().catch(() => false)) return `${what} is disabled`;
  const notes = await clearPath(p, loc);
  if (ambiguous) notes.push(ambiguous);
  const before = p.url();
  try {
    await loc.click({ timeout: 5000 });
  } catch (e) {
    // last resort: the DOM click, which no overlay can intercept
    await loc.evaluate((el) => el.click()).catch(() => {});
    notes.push(`regular click failed (${e.message.split("\n")[0].slice(0, 80)}); used a DOM click`);
  }
  return after(p, before, [`clicked ${what}`, ...notes], opts);
}

/**
 * Type into one field, or into many in a single call.
 *
 * `fields` is the reason this exists. A six-field form used to cost six MCP round-trips, and the
 * round-trip - model turn, transport, tool dispatch - dwarfs the typing. Filling them in one call
 * turns a sign-up form from six exchanges into one. Each field is still located and cleared
 * individually, so a batch behaves exactly like the single calls it replaces; the only thing
 * removed is the waiting in between.
 *
 * A field that cannot be found does not abort the rest: the reply names which ones missed, so a
 * partly-filled form can be finished rather than started over.
 */
export async function fill(target, value, { submit = false, fields = null } = {}) {
  const p = await session();

  if (Array.isArray(fields) && fields.length) {
    const done = [], missed = [];
    for (const f of fields) {
      const loc = await locate(f.target).catch(() => null);
      if (!loc) { missed.push(f.target); continue; }
      await clearPath(p, loc);
      await loc.fill(String(f.value ?? "")).catch(() => missed.push(f.target));
      done.push(await describe(loc));
    }
    const lines = [];
    if (done.length) lines.push(`filled ${done.length}: ${done.join(", ")}`);
    if (missed.length) lines.push(`no visible field matched: ${missed.map((m) => JSON.stringify(m)).join(", ")}`);
    if (!submit) return lines.join("\n") || "nothing to fill";
    const before = p.url();
    const last = done.length ? await locate(fields[fields.length - 1].target).catch(() => null) : null;
    if (last) await last.press("Enter");
    return after(p, before, [...lines, "pressed Enter"]);
  }

  const loc = await locateOrExplain(target);
  if (!loc) return `no visible field matches ${JSON.stringify(target)}${missNote()}`;
  await clearPath(p, loc);
  await loc.fill(String(value));
  const what = await describe(loc);
  if (!submit) return `filled ${what}`;
  const before = p.url();
  await loc.press("Enter");
  return after(p, before, [`filled ${what} and pressed Enter`]);
}

/** Read one key from the creds store. The value goes to the page and nowhere else. */
function secretValue(key) {
  const raw = readFileSync(CREDS, "utf8");
  const line = raw.split("\n").find((l) => l.replace(/^export\s+/, "").startsWith(`${key}=`));
  if (!line) return null;
  return line.replace(/^export\s+/, "").slice(key.length + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
}

export async function fillSecret(target, key) {
  if (!/^[A-Z0-9_]+$/.test(key)) return "key must be an env-style name like STRIPE_SECRET_KEY";
  const value = secretValue(key);
  if (value == null) return `no ${key} in the creds store`;
  const p = await session();
  const loc = await locateOrExplain(target);
  if (!loc) return `no visible field matches ${JSON.stringify(target)}${missNote()}`;
  await clearPath(p, loc);
  await loc.evaluate((el) => { el.dataset.abSecret = "1"; });
  await loc.fill(value);
  return `filled ${await describe(loc)} from ${key} (value not shown; snapshots show it as (secret))`;
}

export async function select(target, option) {
  const p = await session();
  const loc = await locateOrExplain(target);
  if (!loc) return `no visible dropdown matches ${JSON.stringify(target)}${missNote()}`;
  const native = await loc.evaluate((el) => el.tagName === "SELECT").catch(() => false);
  if (native) {
    const picked = await loc.selectOption({ label: option }).catch(() => loc.selectOption(option)).catch((e) => e);
    return picked instanceof Error
      ? `could not pick ${JSON.stringify(option)}: ${picked.message.split("\n")[0]}`
      : `picked ${JSON.stringify(option)} in ${await describe(loc)}`;
  }
  // NOT A <select>, WHICH IS THE COMMON CASE ON A REAL APP. Material, Angular and every design
  // system build dropdowns from [role=listbox]/[role=combobox] with [role=option] children, and
  // selectOption throws "Element is not a <select> element" on all of them - hit on Google Groups,
  // where picking "Anyone can join" took a click on the box and a click on the option.
  await loc.click({ timeout: 5000 }).catch(() => {});
  const opt = p.getByRole("option", { name: option, exact: false });
  const n = await opt.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 8); i++) {
    const cand = opt.nth(i);
    if (!(await cand.isVisible().catch(() => false))) continue;
    await cand.click({ timeout: 5000 }).catch(() => {});
    // Confirm from the page, not from the click landing: aria-selected is the dropdown's own
    // answer, and a click that looked fine but did not register is the failure mode that matters.
    const ok = await cand.evaluate((el) => el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true").catch(() => false);
    return `picked ${JSON.stringify(option)} in ${await describe(loc)}${ok ? "" : " (the option did not report itself selected - check with a snapshot)"}`;
  }
  const names = await opt.evaluateAll((els) => els.slice(0, 8).map((e) => e.innerText.trim().slice(0, 40))).catch(() => []);
  return `no option matching ${JSON.stringify(option)} appeared after opening ${await describe(loc)}${names.length ? `. Options offered: ${names.join(", ")}` : ""}`;
}

/** Attach local files to a file input (or the input behind an "Upload" button). */
export async function upload(target, paths) {
  const p = await session();
  let loc = await locate(target);
  if (!loc) return `no visible element matches ${JSON.stringify(target)}${missNote()}`;
  const isFile = await loc.evaluate((el) => el.tagName === "INPUT" && el.type === "file").catch(() => false);
  if (!isFile) {
    // a styled button: the real input is usually hidden next to it, or opens a chooser on click
    const chooser = p.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
    await loc.click().catch(() => {});
    const fc = await chooser;
    if (!fc) return `${await describe(loc)} is not a file input and didn't open a file chooser`;
    await fc.setFiles(paths);
  } else {
    await loc.setInputFiles(paths);
  }
  await settle(p, 3000);
  return `attached ${paths.map((x) => x.split("/").pop()).join(", ")}`;
}

export async function press(key) {
  const p = await session();
  const before = p.url();
  await p.keyboard.press(key);
  return after(p, before, [`pressed ${key}`]);
}

/**
 * Wait for something to appear (or, with gone, to disappear). At the deadline it says which of
 * three things is true: there, still loading (requests in flight or the page still changing), or
 * absent on a page that has gone quiet.
 */
export async function wait(target, { gone = false, timeout = 10000 } = {}) {
  const p = await session();
  const end = Date.now() + timeout;
  const present = async () => {
    const loc = await locateOrExplain(target).catch(() => null);
    return !!loc;
  };
  while (Date.now() < end) {
    if ((await present()) !== gone) return gone ? `${JSON.stringify(target)} is gone` : `${JSON.stringify(target)} is there`;
    await p.waitForTimeout(250);
  }
  const quietFor = await p.evaluate(() => Date.now() - (window.__abMut || 0)).catch(() => 99999);
  if (inflight > 0 || quietFor < 800) {
    return `still loading after ${timeout / 1000}s: ${inflight} request(s) in flight, page last changed ${Math.round(quietFor)}ms ago; ${JSON.stringify(target)} ${gone ? "still there" : "not there yet"}`;
  }
  return gone ? `${JSON.stringify(target)} is still there and the page is idle` : `absent: the page is idle (no requests, no changes for ${Math.round(quietFor / 100) / 10}s) and nothing matches ${JSON.stringify(target)}`;
}

const FORWARD = /^(next|continue|proceed|save (and|&) continue|save and next|submit|done|finish|confirm|review|get started|continue to .+|next step)\b/i;

/** Press the page's forward button (Next, Continue, Submit...), preferring one in a form or dialog. */
export async function next(opts = {}) {
  const p = await session();
  const found = await p.evaluate((src) => {
    const re = new RegExp(src, "i");
    const els = [...document.querySelectorAll('button, input[type="submit"], a[role="button"], [role="button"], a')];
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
    const name = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    const hits = els.filter((el) => vis(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && re.test(name(el)));
    const score = (el) => (el.closest("form, [role=dialog], dialog, main") ? 2 : 0) - (el.closest("nav, header, footer") ? 3 : 0) + (el.tagName === "BUTTON" || el.type === "submit" ? 1 : 0);
    hits.sort((a, b) => score(b) - score(a));
    if (!hits.length) return { none: els.filter(vis).map(name).filter(Boolean).slice(0, 15) };
    window.__abN = window.__abN || 0;
    const el = hits[0];
    return { ref: el.dataset.ab || (el.dataset.ab = "e" + ++window.__abN) };
  }, FORWARD.source);
  if (found.none) return `no Next/Continue/Submit-style button here. Buttons on the page: ${found.none.map((s) => JSON.stringify(s)).join(", ")}`;
  return click(found.ref, opts);
}

export async function back() {
  const p = await session();
  await p.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  await settle(p);
  return snapshot();
}

/**
 * A picture the model can actually SEE, in one call.
 *
 * The old version wrote a PNG and returned "saved /tmp/x.png", which is not seeing anything: the
 * agent then had to read the file back, so every look at a page cost two round-trips and the
 * caller had to invent a path it did not want. Now the image comes back inline and `path` is
 * optional, for when a file is genuinely wanted (a report, a diff against a later shot).
 *
 * JPEG rather than PNG because the job is reading a layout, not archiving pixels: q72 is visually
 * the same at reading size and roughly a fifth of the bytes of the PNG.
 */
export async function screenshot(path, { full = false } = {}) {
  const p = await session();
  const buf = await p.screenshot({ fullPage: full, type: "jpeg", quality: 72 });
  if (path) await writeFile(path, buf).catch(() => {});
  return {
    image: buf.toString("base64"),
    mime: "image/jpeg",
    note: `${full ? "full page" : "viewport"}, ${Math.round(buf.length / 1024)} KB${path ? `, also saved to ${path}` : ""}`,
  };
}

/**
 * The console, which is where a page admits what went wrong. `level` narrows to
 * "error" (errors and uncaught exceptions only) or a substring to match.
 */
export async function consoleMessages({ level, limit = 40 } = {}) {
  await session();
  let rows = consoleLog;
  if (level === "error") rows = rows.filter((r) => r.type === "error" || r.type === "pageerror");
  else if (level) rows = rows.filter((r) => r.type === level || r.text.toLowerCase().includes(String(level).toLowerCase()));
  if (!rows.length) return consoleLog.length ? `no console messages match; ${consoleLog.length} in total on this page` : "the console is clean on this page";
  const shown = rows.slice(-limit);
  const head = `${rows.length} console message${rows.length === 1 ? "" : "s"}${rows.length > shown.length ? `, last ${shown.length}` : ""}:`;
  return [head, ...shown.map((r) => `  [${r.type}] ${r.text}`)].join("\n");
}

/**
 * The network log. `failed` keeps only failures and 4xx/5xx; `thirdParty` keeps only requests to a
 * different registrable domain than the page (how you catch a tracker the page never mentions);
 * `match` is a substring of the URL.
 */
export async function network({ failed = false, thirdParty = false, match, limit = 40 } = {}) {
  const p = await session();
  const host = await p.evaluate(() => location.hostname).catch(() => "");
  // Compare the last two labels, so cdn.example.com counts as the same site as example.com but
  // aplo-evnt.com does not. Good enough without shipping a public-suffix list.
  const site = (h) => h.split(".").slice(-2).join(".");
  let rows = netLog;
  if (failed) rows = rows.filter((r) => r.status === 0 || (r.status !== null && r.status >= 400));
  if (thirdParty) rows = rows.filter((r) => { try { return site(new URL(r.url).hostname) !== site(host); } catch { return false; } });
  if (match) rows = rows.filter((r) => r.url.toLowerCase().includes(String(match).toLowerCase()));
  if (!rows.length) return netLog.length ? `no requests match; ${netLog.length} on this page` : "no requests recorded for this page";
  const shown = rows.slice(-limit);
  const head = `${rows.length} request${rows.length === 1 ? "" : "s"}${rows.length > shown.length ? `, last ${shown.length}` : ""}:`;
  const line = (r) => `  ${r.failure ? "FAILED" : r.status === null ? "pending" : r.status} ${r.method} ${r.type === "document" ? "" : r.type + " "}${r.url}${r.failure ? ` (${r.failure})` : ""}`;
  // Third-party domains summarised too: the question is usually "who else is this page talking to",
  // and a list of 40 URLs answers it worse than a list of hosts.
  const hosts = [...new Set(shown.map((r) => { try { return new URL(r.url).hostname; } catch { return "?"; } }))];
  const tail = hosts.length > 1 ? [`hosts: ${hosts.join(", ")}`] : [];
  return [head, ...shown.map(line), ...tail].join("\n");
}

export async function js(code) {
  const p = await session();
  const v = await p.evaluate(code).catch((e) => `error: ${e.message.split("\n")[0]}`);
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s ?? "undefined").slice(0, 4000);
}
