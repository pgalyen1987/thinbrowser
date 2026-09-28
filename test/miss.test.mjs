// A MISS HAS TWO CAUSES AND THEY MEAN OPPOSITE THINGS.
//
// "no visible element matches X" is returned both when X is not on the page and when the page has
// not drawn it yet. Single-page apps produce the second constantly: content arrives long after
// navigation settled. An agent that reads "not found" as "not present" then acts on it -- which on
// 2026-09-28 nearly meant sending a duplicate email, because a Gmail Sent search rendered zero rows
// and "I cannot tell yet" was reported as "it did not send".
//
// So these two tests are the whole point of locateOrExplain: the same miss, on two pages, has to
// come back with two different explanations.
import { test } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { open, click, close } from "../src/browser.mjs";

function serve(html) {
  const s = createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(html); });
  return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}/` })));
}

test("a populated page that lacks the element says so plainly", async () => {
  const { s, url } = await serve(`<!doctype html><title>full</title><body>
    <h1>A page with plenty on it</h1>
    <p>${"Real content that a person would read. ".repeat(12)}</p>
    <a href="#a">one</a> <a href="#b">two</a> <button>Save</button>
    <button>Cancel</button> <input placeholder="search"> <textarea></textarea>
  </body>`);
  try {
    await open(url);
    const out = await click("Publish to production");
    assert.match(out, /no visible element matches/i);
    assert.match(out, /genuinely not on this page/i,
      "a full page should be reported as a real absence:\n" + out);
    assert.doesNotMatch(out, /cannot tell yet/i);
  } finally { await close().catch(() => {}); s.close(); }
});

test("an empty, still-loading page says 'cannot tell', not 'not present'", async () => {
  // A shell that renders nothing for longer than locateOrExplain is willing to wait: exactly the
  // shape of an app that paints late.
  const { s, url } = await serve(`<!doctype html><title>shell</title><body aria-busy="true">
    <div class="spinner">Loading</div>
    <script>setTimeout(() => {
      document.body.removeAttribute("aria-busy");
      document.body.innerHTML = "<button>Publish to production</button>";
    }, 30000)</script>
  </body>`);
  try {
    await open(url);
    const out = await click("Publish to production");
    assert.match(out, /no visible element matches/i);
    assert.match(out, /cannot tell yet/i,
      "an unrendered page must NOT be reported as a real absence:\n" + out);
    assert.match(out, /do not conclude the thing is absent/i);
  } finally { await close().catch(() => {}); s.close(); }
});

test("a late-rendering element is waited for, not missed", async () => {
  // The other half: if it does arrive within the window, the action should just work rather than
  // making the caller retry.
  const { s, url } = await serve(`<!doctype html><title>late</title><body aria-busy="true">
    <div class="spinner">Loading</div>
    <script>setTimeout(() => {
      document.body.removeAttribute("aria-busy");
      document.body.innerHTML = "<button id='go' onclick=\\"document.title='clicked'\\">Publish to production</button>";
    }, 1200)</script>
  </body>`);
  try {
    await open(url);
    const out = await click("Publish to production");
    assert.doesNotMatch(out, /no visible element matches/i,
      "the button arrives after 1.2s and should have been waited for:\n" + out);
  } finally { await close().catch(() => {}); s.close(); }
});
