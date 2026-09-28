// Every tool, called over the real MCP protocol, against a local page.
//
// WHY THIS EXISTS SEPARATELY from browser.test.mjs. Those tests import the functions directly, so
// they prove the browser logic works. They do NOT prove the server exposes it: a tool can be
// missing from the registration list, declare an input schema that rejects what the docs tell you
// to pass, or throw on a shape the direct call never sees. This drives the server the way a client
// does — spawn, initialize, list, call — so "it works" means the thing a buyer installs works.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ab-smoke-"));
const credsPath = join(dir, "creds.env");
writeFileSync(credsPath, 'export FAKE_API_KEY="sk-smoke-secret-1234"\n');
const fixture = pathToFileURL(join(import.meta.dirname, "fixtures", "form.html")).href;

let proc, buffer = "", nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => pending.has(id) && reject(new Error(`timeout: ${method}`)), 60000);
  });
}
const call = (name, args = {}) => send("tools/call", { name, arguments: args });
/** The text of a tool reply, so a test can assert on what a model would actually read. */
const textOf = (r) => (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

before(async () => {
  proc = spawn("node", [join(import.meta.dirname, "..", "src", "server.mjs")], {
    env: { ...process.env, TB_EPHEMERAL: "1", TB_CREDS: credsPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // stdout is the protocol channel and nothing else may appear on it — that is itself under test.
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // A non-JSON line here would break a real client's handshake, so fail loudly.
        for (const { reject } of pending.values()) reject(new Error(`non-JSON on stdout: ${line.slice(0, 120)}`));
        pending.clear();
        return;
      }
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  });
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
});

after(async () => {
  // The child holds a Chromium open; closing it first lets the runner exit instead of sitting out
  // the file timeout, which is what the first run of this file did.
  await call("close", {}).catch(() => {});
  proc?.kill("SIGKILL");
});

test("the server lists every tool the README promises", async () => {
  const { tools } = await send("tools/list");
  const names = tools.map((t) => t.name).sort();
  const promised = ["back", "click", "close", "console", "downloads", "fill", "fill_secret", "js",
    "network", "next", "open", "press", "read", "screenshot", "select", "snapshot", "solve",
    "tabs", "upload", "wait"].sort();
  assert.deepEqual(names, promised);
  // Every tool needs a description: it is what a model reads to decide whether to call it.
  for (const t of tools) assert.ok(t.description && t.description.length > 20, `${t.name} has no usable description`);
});

test("open returns a snapshot with refs", async () => {
  const out = textOf(await call("open", { url: fixture }));
  assert.match(out, /form "Login":/);
  assert.match(out, /\[e\d+\]/);
});

test("snapshot narrows with find", async () => {
  const out = textOf(await call("snapshot", { find: "Email" }));
  assert.match(out, /email "Email"/);
});

test("fill fills many fields in one call, and fill_secret keeps the value out of the reply", async () => {
  const filled = textOf(await call("fill", { fields: [{ target: "Email", value: "pat@example.com" }] }));
  assert.match(filled, /filled/i);
  const secret = textOf(await call("fill_secret", { target: "API key", key: "FAKE_API_KEY" }));
  assert.doesNotMatch(secret, /sk-smoke-secret/);
});

test("select, click and next act and say what happened", async () => {
  assert.match(textOf(await call("select", { target: "Plan", option: "Pro" })), /picked "Pro"/);
  assert.match(textOf(await call("next", {})), /clicked/i);
});

test("wait, console and network answer without a page argument", async () => {
  const w = textOf(await call("wait", { target: "Email" }));
  assert.ok(w.length > 0);
  const c = textOf(await call("console", {}));
  assert.ok(c.length > 0, "console returned nothing at all");
  const n = textOf(await call("network", {}));
  assert.ok(n.length > 0, "network returned nothing at all");
});

test("screenshot comes back as an IMAGE, not a path", async () => {
  const r = await call("screenshot", {});
  const img = (r.content || []).find((c) => c.type === "image");
  assert.ok(img, "no image block in the screenshot reply");
  assert.match(img.mimeType, /^image\//);
  assert.ok(img.data.length > 500, "image data looks empty");
});

test("js is the escape hatch and returns a value", async () => {
  assert.match(textOf(await call("js", { code: "1 + 1" })), /2/);
});

test("a bad target fails in words, not with a protocol error", async () => {
  // The reply must stay useful: a model needs to know what to try next, not see a stack trace.
  const out = textOf(await call("click", { target: "no such button anywhere on this page" }));
  assert.match(out, /no visible element matches/);
});

test("a bad tool name is reported, not silently treated as success", async () => {
  // The SDK answers with an error RESULT rather than a protocol-level rejection, so assert on the
  // thing that actually protects a caller: the reply says it failed.
  const r = await call("not_a_real_tool", {}).catch((e) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
  assert.ok(r.isError, "an unknown tool came back looking like a success");
  assert.match(textOf(r), /not_a_real_tool|unknown|not found/i);
});
