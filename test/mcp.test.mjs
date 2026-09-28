// The server speaks MCP over stdio: tools list, and a call returns text.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

test("tools are listed and open/click answer in text", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../src/server.mjs")], env: { ...process.env, TB_EPHEMERAL: "1" } });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    for (const t of ["open", "snapshot", "click", "fill", "fill_secret", "wait", "next", "js"]) assert.ok(tools.some((x) => x.name === t), t);
    const url = pathToFileURL(join(import.meta.dirname, "fixtures/overlay.html")).href;
    const opened = await client.callTool({ name: "open", arguments: { url } });
    assert.match(opened.content[0].text, /button "Continue to payment"/);
    const clicked = await client.callTool({ name: "click", arguments: { target: 'button "Continue to payment"', snap: false } });
    console.log(clicked.content[0].text);
    assert.match(clicked.content[0].text, /clicked button "Continue to payment"/);
  } finally {
    await client.callTool({ name: "close", arguments: {} }).catch(() => {});
    await client.close();
  }
});

// An MCP server is started once by the client and kept for the whole session, so upgrading the
// package on disk leaves the running process serving the modules it imported at startup. That is
// silent, and it cost a session: a server started three hours before the diff feature landed
// answered every action with a full snapshot, which read as the feature being broken.
test("a server outlived by its own package says so", async () => {
  const pkg = join(import.meta.dirname, "../package.json");
  const original = readFileSync(pkg, "utf8");
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../src/server.mjs")], env: { ...process.env, TB_EPHEMERAL: "1" } });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const url = pathToFileURL(join(import.meta.dirname, "fixtures/overlay.html")).href;
    const before = await client.callTool({ name: "open", arguments: { url } });
    assert.doesNotMatch(before.content[0].text, /restart your MCP client/, "a current server must not nag");

    // Upgrade the package under the running process, exactly as npm would.
    writeFileSync(pkg, original.replace(/"version": "[^"]+"/, '"version": "99.0.0"'));

    const after = await client.callTool({ name: "snapshot", arguments: { limit: 5 } });
    assert.match(after.content[0].text, /but 99\.0\.0 is installed — restart your MCP client/);
  } finally {
    writeFileSync(pkg, original); // never leave a bumped version behind, even on failure
    await client.callTool({ name: "close", arguments: {} }).catch(() => {});
    await client.close();
  }
});

// The plugin manifests carry their own copy of the version and the headline ratio, and a copy that
// nothing checks is a copy that drifts: plugin.json sat at 0.7.0 for two releases, and both
// manifests still advertised "37x less page" long after the benchmark reached 44x — underselling
// the product on the two surfaces a buyer actually reads.
test("the plugin manifests match the package they ship", () => {
  const read = (f) => JSON.parse(readFileSync(join(import.meta.dirname, "..", f), "utf8"));
  const pkg = read("package.json");
  const plugin = read(".claude-plugin/plugin.json");
  const market = read(".claude-plugin/marketplace.json");
  assert.equal(plugin.version, pkg.version, "plugin.json version is behind package.json");
  const listed = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(listed, "marketplace.json does not list this plugin");
  assert.equal(listed.version, pkg.version, "marketplace.json version is behind package.json");
  assert.equal(listed.description, plugin.description, "the two listings describe the plugin differently");

  // The ratio in the copy has to be the one the README publishes, rounded.
  const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");
  const claimed = Number((readme.match(/on five live pages:\s*([\d.]+)x/s) || [])[1]);
  assert.ok(claimed, "README no longer states the benchmark ratio");
  const advertised = Number((plugin.description.match(/(\d+)x less page/) || [])[1]);
  assert.equal(advertised, Math.round(claimed), `the listing advertises ${advertised}x but the README measures ${claimed}x`);
});
