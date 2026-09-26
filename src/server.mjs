#!/usr/bin/env node
// agent-browser: an MCP server that drives Chromium for an agent. Every answer is a compact snapshot
// or a sentence about what happened, never a whole-page accessibility dump.
//
//   claude mcp add agent-browser -- node ~/agent-browser/src/server.mjs
//
// AB_HEADED=1 shows the window; AB_EPHEMERAL=1 skips the saved profile (~/.cache/agent-browser).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as b from "./browser.mjs";
import { readFileSync } from "node:fs";

// The version comes from package.json rather than a string typed here, which had already drifted a
// release behind by the time anyone noticed.
const pkgPath = new URL("../package.json", import.meta.url);
const readVersion = () => { try { return JSON.parse(readFileSync(pkgPath, "utf8")).version; } catch { return null; } };

// AN MCP SERVER OUTLIVES ITS OWN SOURCE, and that is worth saying out loud because it cost us a
// whole session. The client starts this process once and keeps it; upgrading the package rewrites
// the files on disk but the running process keeps the modules it imported at startup. So an agent
// goes on calling code from before the upgrade, gets the old behaviour, and nothing anywhere says
// so -- found by dogfooding, where a server started three hours before the diff feature landed
// answered every action with a full snapshot and looked like a bug in the feature.
//
// Detecting it is cheap: the version imported at startup is frozen in this process, while
// package.json on disk moves with the upgrade. If they differ, this process is stale.
// Checked on every call, not on a timer: reading one small JSON file is nothing beside the browser
// round trip each of these tools already makes, and a cache here only bought a slower test.
const LOADED = readVersion();
function staleness() {
  const onDisk = readVersion();
  return onDisk && LOADED && onDisk !== LOADED
    ? `note: this server is running agent-browser ${LOADED} but ${onDisk} is installed — restart your MCP client to pick it up.\n\n`
    : "";
}

const server = new McpServer({ name: "agent-browser", version: LOADED ?? "0.0.0" });
const text = (s) => ({ content: [{ type: "text", text: String(s) }] });
const safe = (fn) => async (args) => {
  try { return text(staleness() + (await fn(args || {}))); } catch (e) { return { ...text(`error: ${String(e.message || e).split("\n")[0]}`), isError: true }; }
};
const target = z.string().describe('A ref from a snapshot ("e12") or a description: \'button "Next"\', \'link Pricing\', a field label, or visible text');

server.registerTool("open", {
  description: "Go to a URL and return a compact snapshot: headings, forms and interactive elements with refs (e1, e2...), then a short run of the page text. Flags login pages and overlays.",
  inputSchema: { url: z.string() },
}, safe(({ url }) => b.open(url)));

server.registerTool("snapshot", {
  description: "The current page as a compact snapshot. Narrow it with find (text to match in labels) or scope (a ref or CSS selector); limit caps the elements (default 60).",
  inputSchema: { find: z.string().optional(), scope: z.string().optional(), limit: z.number().int().optional(), withText: z.boolean().optional() },
}, safe((o) => b.snapshot(o)));

server.registerTool("click", {
  description: "Click an element. Scrolls to it, and if an overlay (cookie bar, chat widget, sticky footer) covers it, dismisses or hides that first and says so. Returns what changed and a fresh snapshot.",
  inputSchema: { target, snap: z.boolean().optional().describe("include the snapshot after (default true)"), confirm: z.boolean().optional().describe("accept an \"are you sure?\" confirm this click raises (dismissed by default)") },
}, safe(({ target: t, snap, confirm }) => b.click(t, { snap: snap !== false, confirm })));

server.registerTool("fill", {
  description: "Type into a field, or fill a whole form in ONE call with `fields`. Prefer `fields` for anything with more than one input: six separate calls cost six round-trips, and the round-trip is the slow part, not the typing. submit presses Enter after the last field.",
  inputSchema: {
    target: target.optional(),
    value: z.string().optional(),
    fields: z.array(z.object({
      target: z.string().describe("a ref like e12, or a description like 'textbox \"Email\"'"),
      value: z.string(),
    })).optional().describe("fill many fields in one call, in order"),
    submit: z.boolean().optional(),
  },
}, safe(({ target: t, value, submit, fields }) => b.fill(t, value, { submit, fields })));

server.registerTool("fill_secret", {
  description: "Type a credential into a field by its NAME in ~/.config/rebel-studios/creds.env (e.g. STRIPE_SECRET_KEY). The value never appears in this conversation; later snapshots show the field as (secret).",
  inputSchema: { target, key: z.string() },
}, safe(({ target: t, key }) => b.fillSecret(t, key)));

server.registerTool("select", {
  description: "Pick an option in a select, by its visible label (or value).",
  inputSchema: { target, option: z.string() },
}, safe(({ target: t, option }) => b.select(t, option)));

server.registerTool("upload", {
  description: "Attach local file(s) to a file input, or to an Upload button that opens a file chooser.",
  inputSchema: { target, paths: z.array(z.string()).min(1) },
}, safe(({ target: t, paths }) => b.upload(t, paths)));

server.registerTool("press", {
  description: "Press a key on the page (Enter, Escape, Tab, ArrowDown, Control+A...).",
  inputSchema: { key: z.string() },
}, safe(({ key }) => b.press(key)));

server.registerTool("wait", {
  description: "Wait for an element or text to appear (or with gone, to disappear). If it times out, says whether the page is still loading or has gone idle without it, so absent and slow are never confused.",
  inputSchema: { target, gone: z.boolean().optional(), seconds: z.number().optional() },
}, safe(({ target: t, gone, seconds }) => b.wait(t, { gone, timeout: (seconds || 10) * 1000 })));

server.registerTool("next", {
  description: "Press the page's forward button (Next, Continue, Submit, Done...), preferring one inside a form or dialog. For wizards. Lists the page's buttons if there is none.",
  inputSchema: {},
}, safe(() => b.next()));

server.registerTool("back", {
  description: "Go back one page in history and return a fresh snapshot of where you land.",
  inputSchema: {},
}, safe(() => b.back()));

// The image comes back INLINE, so looking at a page is one call rather than screenshot-then-read.
// `path` is optional now: most looks want to see, not to keep a file.
server.registerTool("screenshot", {
  description: "See the page: returns the image itself. full: the whole scroll height. path: also save it to a file (optional).",
  inputSchema: { path: z.string().optional(), full: z.boolean().optional() },
}, async ({ path, full } = {}) => {
  try {
    const r = await b.screenshot(path, { full });
    return { content: [{ type: "image", data: r.image, mimeType: r.mime }, { type: "text", text: r.note }] };
  } catch (e) {
    return { ...text(`error: ${String(e.message || e).split("\n")[0]}`), isError: true };
  }
});

server.registerTool("console", {
  description: "The browser console for the current page: errors, warnings, uncaught exceptions. level: \"error\" for errors only, or a substring to match.",
  inputSchema: { level: z.string().optional(), limit: z.number().int().optional() },
}, safe((o) => b.consoleMessages(o)));

server.registerTool("network", {
  description: "The network log for the current page. failed: only failures and 4xx/5xx. thirdParty: only requests leaving the page's own domain (how you catch a tracker the page does not mention). match: a substring of the URL.",
  inputSchema: { failed: z.boolean().optional(), thirdParty: z.boolean().optional(), match: z.string().optional(), limit: z.number().int().optional() },
}, safe((o) => b.network(o)));

server.registerTool("solve", {
  description: "A bot wall is blocking the page: reopen it in a VISIBLE window so the person at the keyboard can clear the challenge themselves, then carry on. The profile is persistent, so later runs go straight through. This does not defeat or spoof anything — it asks the human who is already there.",
  inputSchema: { seconds: z.number().optional().describe("how long to wait for them (default 180)") },
}, safe((o) => b.solve(o || {})));

server.registerTool("tabs", {
  description: "List the open tabs, or switch to one with `to` (an index, or a substring of its URL), or close one with `shut`. A link that opens a tab is followed; this is how you get back.",
  inputSchema: { to: z.string().optional(), shut: z.string().optional() },
}, safe((o) => b.tabs(o || {})));

server.registerTool("downloads", {
  description: "Files the page has downloaded this session, saved to disk with their paths. A download is discarded by the browser unless something asks for it, so without this a click on Export appears to do nothing. waitSeconds waits for one to arrive, since a download lands after the click returns.",
  inputSchema: { waitSeconds: z.number().optional() },
}, safe((o) => b.downloads(o || {})));

server.registerTool("read", {
  description: "The page as prose, with the navigation and furniture stripped: for when the answer is in the writing rather than the controls. Long pages come in slices; `find` jumps to the slice containing a phrase. Use snapshot when you need to act on the page, this when you need to read it.",
  inputSchema: { chars: z.number().optional(), slice: z.number().optional(), find: z.string().optional() },
}, safe((o) => b.read(o || {})));

server.registerTool("js", {
  description: "Evaluate a JavaScript expression in the page and return the result (trimmed). The escape hatch.",
  inputSchema: { code: z.string() },
}, safe(({ code }) => b.js(code)));

server.registerTool("close", {
  description: "Close the browser. The saved profile stays, so a login made earlier survives to the next session.",
  inputSchema: {},
}, safe(async () => { await b.close(); return "closed"; }));

await server.connect(new StdioServerTransport());
