// Each friction point from the notes (thinbrowser-idea), checked against a local page.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ab-"));
process.env.TB_EPHEMERAL = "1";
process.env.TB_CREDS = join(dir, "creds.env");
writeFileSync(process.env.TB_CREDS, 'OTHER=1\nexport FAKE_API_KEY="sk-super-secret-9f8e"\n');
const b = await import("../src/browser.mjs");
const page = (name, q = "") => pathToFileURL(join(import.meta.dirname, "fixtures", name)).href + q;
after(() => b.close());

test("a snapshot is compact: 150 nav links become a capped list with the form first", async () => {
  const s = await b.open(page("form.html"));
  assert.ok(s.length < 6000, `snapshot is ${s.length} chars`);
  assert.match(s, /form "Login":/);
  assert.match(s, /\[e\d+\] email "Email" \(required\)/);
  assert.match(s, /… 144 more links in this nav/);
  assert.match(s, /auth: this looks like a login page/);
});

test("refs stay the same across snapshots", async () => {
  const one = (await b.snapshot({ find: "Email" })).match(/\[(e\d+)\] email "Email"/)[1];
  const two = (await b.snapshot({ find: "Email" })).match(/\[(e\d+)\] email "Email"/)[1];
  assert.equal(one, two);
});

test("fill, select, submit through the form, and see the result", async () => {
  await b.fill("Email", "pat@example.com");
  assert.match(await b.select("Plan", "Pro"), /picked "Pro"/);
  const out = await b.next();
  assert.match(out, /clicked button "Next"/);
  assert.match(await b.fill("Email", "x@y.z"), /filled field "Email"/);
  assert.match(await b.js("document.getElementById('msg').textContent"), /Welcome pat@example.com/);
});

test("a secret goes into the page and never into the output", async () => {
  const out = await b.fillSecret("API key", "FAKE_API_KEY");
  assert.doesNotMatch(out, /sk-super-secret/);
  assert.equal(await b.js("document.querySelector('[name=key]').value"), "sk-super-secret-9f8e");
  const snap = await b.snapshot({ find: "API key" });
  assert.match(snap, /"API key" = \(secret\)/);
  assert.doesNotMatch(snap, /sk-super-secret/);
  assert.match(await b.fillSecret("API key", "NOPE_KEY"), /no NOPE_KEY/);
});

test("a link that will not navigate is flagged; one that will is left lean", async () => {
  // mailto:/tel: are dead clicks in a headless browser — flagging them tells the agent to read the
  // address off the label instead of clicking into nothing. External http(s) links DO navigate, so
  // they stay unmarked on purpose: marking every one measured +5% on the benchmark whose ratio the
  // README, landing page and store listing all quote. This locks in both halves of that decision.
  // (Placed after the form.html tests above, which share this browser and expect to stay on it.)
  const s = await b.open(page("links.html"));
  assert.match(s, /"Email the studio" → email/);
  assert.match(s, /"Call us" → phone/);
  assert.match(s, /\[e\d+\] "Join the tester group"$/m); // external: present, but no destination tail
  assert.doesNotMatch(s, /Join the tester group" →/);
  assert.doesNotMatch(s, /About this studio" →/); // relative/same-site: no tail either
});

test("a control whose ARIA name reference resolves to nothing still gets a name", async () => {
  // Found by reading the accessible-name fallbacks: aria-labelledby and label[for] returned early
  // even when the reference resolved to an empty string (a dangling id, or an empty <label>), so
  // the element came back nameless — a button an agent could neither read nor address by name —
  // when its own visible text or placeholder was right there. The wrapping-<label> case already
  // fell through on empty; these two now match it. A resolving reference must still win.
  const s = await b.open(page("labels.html"));
  assert.match(s, /\[e\d+\] button "Save changes"/);    // dangling aria-labelledby → own text
  assert.match(s, /\[e\d+\] button "Pay the invoice"/); // resolving aria-labelledby → referenced text, not "X"
  assert.match(s, /\[e\d+\] email "Work email"/);       // empty label[for] → placeholder
  assert.doesNotMatch(s, /button ""/);                  // nothing renders nameless
});

test("a click under a cookie bar presses Accept; under a chat widget with no close button, hides it", async () => {
  await b.open(page("overlay.html"));
  const out = await b.click('button "Continue to payment"', { snap: false });
  assert.match(out, /pressed "Accept all" on an overlay/);
  assert.equal(await b.js("document.title"), "Paid");
  const help = await b.click('button "Help"', { snap: false });
  assert.match(help, /hid an overlay covering the target: "Chat with us/);
  assert.equal(await b.js("document.body.dataset.help"), "1");
});

test("wait tells there, still loading and absent apart", async () => {
  await b.open(page("slow.html", "?mode=late"));
  assert.match(await b.wait("Download report", { timeout: 5000 }), /is there/);
  await b.open(page("slow.html", "?mode=busy"));
  assert.match(await b.wait("Download report", { timeout: 1500 }), /still loading/);
  await b.open(page("slow.html"));
  assert.match(await b.wait("Download report", { timeout: 1500 }), /absent: the page is idle/);
});

test("a missing target answers in words with nearby options", async () => {
  await b.open(page("form.html"));
  assert.match(await b.click('button "Delete account"'), /no visible element matches/);
});

test("upload through a styled button; a confirm is dismissed unless the click says confirm: true", async () => {
  await b.open(page("upload.html"));
  const f = join(dir, "bundle.zip");
  writeFileSync(f, "zip");
  assert.match(await b.upload('button "Upload a file"', [f]), /attached bundle.zip/);
  assert.equal(await b.js("document.getElementById('name').textContent"), "bundle.zip");
  const no = await b.click('button "Replace"', { snap: false });
  assert.match(no, /a confirm said: "Replace the current file\?" \(dismissed; click again with confirm: true/);
  assert.notEqual(await b.js("document.title"), "Replaced");
  const yes = await b.click('button "Replace"', { snap: false, confirm: true });
  assert.match(yes, /\(accepted\)/);
  assert.equal(await b.js("document.title"), "Replaced");
});

// ── The devtools tools, and the two traps that cost a live afternoon on 2026-09-25 ──

test("the console reports errors, warnings and uncaught exceptions for THIS page", async () => {
  await b.open(page("devtools.html"));
  const all = await b.consoleMessages();
  assert.match(all, /a real error in the page/);
  assert.match(all, /a warning about something/);
  const errs = await b.consoleMessages({ level: "error" });
  assert.match(errs, /a real error in the page/);
  // level:"error" means errors and uncaught exceptions, not warnings.
  assert.doesNotMatch(errs, /a warning about something/);
});

test("the network log keeps the page's OWN request, and finds a third-party call", async () => {
  // Regression: clearing on framenavigated ran AFTER the document's own response event, so the
  // main document vanished from its own log and it read "no requests recorded for this page".
  const all = await b.network();
  assert.doesNotMatch(all, /no requests recorded/);
  // The fixture fires one cross-origin request, which is how a tracker pixel shows up.
  const third = await b.network({ thirdParty: true });
  assert.match(third, /invalid-test-domain/);
});

test("select works on an ARIA listbox, not just a <select>", async () => {
  // Real design systems build dropdowns from [role=listbox] + [role=option]; Playwright's
  // selectOption throws on all of them. Hit on Google Groups' privacy settings.
  const out = await b.select('Who can join group', "Anyone can join");
  assert.match(out, /picked "Anyone can join"/);
  assert.doesNotMatch(out, /did not report itself selected/);
  assert.equal(
    await b.js(`document.querySelector('#who [role=option][aria-selected=true]').textContent.trim()`),
    "Anyone can join",
  );
});

test("an ambiguous target says so instead of silently taking the first", async () => {
  // Two visible "Save" controls. Acting on the first is fine; doing it silently is not - that is
  // how a click meant for a wizard's submit reopened a sidebar instead.
  const out = await b.click("Save");
  assert.match(out, /clicked/);
  assert.match(out, /2 visible elements match "Save"/);
  assert.match(out, /Pass a snapshot ref/);
});

test("a bot wall is named, not snapshotted as an empty page", async () => {
  // Reddit answers a blocked request with a styled page carrying almost no interactive elements,
  // so the snapshot read like a site with nothing on it and the caller went hunting for selectors
  // that were never going to exist. This REPORTS the wall; it does not get around it.
  const s = await b.open(page("blocked.html"));
  assert.match(s, /^blocked: this is an interstitial bot check/m);
  assert.match(s, /Cloudflare/);
  assert.match(s, /already signed in to/);
});

test("an ordinary page is not mistaken for a bot wall", async () => {
  const s = await b.open(page("form.html"));
  assert.doesNotMatch(s, /^blocked:/m);
});

test("after an action the page comes back as a diff, naming what moved", async () => {
  // A page costs thousands of characters and re-sending all of it after a click that moved two
  // lines is most of what a multi-step task used to spend.
  await b.open(page("form.html"));
  await b.fill("Email", "pat@example.com");
  const out = await b.click("Next");
  assert.match(out, /clicked/);
  assert.match(out, /changed: \+\d+ -\d+, \d+ unchanged/);
  assert.match(out, /\+ \[e\d+\] email "Email" \(required\) = "pat@example.com"/);
  assert.match(out, /Welcome pat@example.com/); // the thing the click actually did
});

test("an action that changes nothing says so, rather than inventing a change", async () => {
  // The other half of the contract. This caught a real bug: the baseline was read AFTER the fresh
  // snapshot had already overwritten it, so every action compared the page against a copy of
  // itself and answered "unchanged" however much had moved — wrong, and short enough to look like
  // a saving in the benchmark.
  await b.open(page("form.html"));
  // "Terms" and the nav links all carry href="#", which changes the URL and so honestly returns a
  // full snapshot. #inert is the only control on the page that truly does nothing.
  const out = await b.click("Does nothing");
  assert.match(out, /the page is unchanged \(\d+ elements\)/);
});

test("asking for a snapshot resets what 'changed' is measured against", async () => {
  // Without this an explicit snapshot would be compared against a baseline the caller never saw.
  await b.open(page("form.html"));
  const full = await b.snapshot();
  assert.match(full, /\[e\d+\]/);
  const again = await b.snapshot();
  assert.match(again, /\[e\d+\]/); // a snapshot is always the whole truth, never a diff
});

test("controls inside an iframe are in the snapshot, with refs that work", async () => {
  // This used to come back as a page with one button on it. A card form, a consent dialog and an
  // embedded editor are all iframes, so "the page looks empty" was a silent, common failure.
  const s = await b.open(page("framed.html"));
  assert.match(s, /\[e\d+\] button "Review order"/);   // the outer page
  assert.match(s, /frame f1: Card details/);            // the frame is named
  assert.match(s, /\[f1e\d+\] textbox "Card number"/);  // and its contents are there
  assert.match(s, /\[f1e\d+\] button "Pay now"/);

  // A prefixed ref must address the element inside that frame, not fail or hit the wrong document.
  const ref = s.match(/\[(f1e\d+)\] textbox "Card number"/)[1];
  const out = await b.fill(ref, "4242424242424242");
  assert.match(out, /filled/i);
  // Verified through a fresh snapshot rather than contentDocument: a file:// iframe is cross-origin
  // to its file:// parent, so reaching into it from the outer document returns null — which is the
  // whole reason frames need their own collection pass.
  const after = await b.snapshot();
  assert.match(after, /\[f1e\d+\] textbox "Card number" \(required\) = "4242424242424242"/);
});

test("a download is saved and listed, instead of vanishing", async () => {
  // Playwright discards a download unless something asks for it, so "Export CSV" used to appear
  // to do nothing at all.
  await b.open(page("downloads.html"));
  await b.click("Export CSV");
  // waitSeconds, instead of the sleep-shaped `wait` this used to need: a download lands after the
  // click returns, and having to swallow an unrelated wait was the API being awkward at exactly
  // the moment it mattered.
  const list = await b.downloads({ waitSeconds: 5 });
  assert.match(list, /report\.csv/);
  assert.doesNotMatch(list, /no downloads yet/);
});

test("tabs can be listed and switched, so a new tab is not a dead end", async () => {
  await b.open(page("downloads.html"));
  await b.click("Open the receipt");
  const list = await b.tabs();
  assert.match(list, /downloads\.html/);
  assert.match(list, /\* /); // the one being driven is always marked

  // WHETHER A SECOND TAB EXISTS IS THE ENGINE'S CALL, NOT OURS. A headless WebKit on a CI runner
  // opens no popup window at all, where the same WebKit locally opens one — so asserting the tab
  // appeared tests the browser's popup policy rather than this tool, and fails somewhere the
  // feature is fine. What IS ours: listing what is open, marking the driven one, and switching.
  if (/framed\.html/.test(list)) {
    const back = await b.tabs({ to: "downloads.html" });
    assert.match(back, /switched to it/);
    assert.match(back, /Export CSV/); // and we are really on that page again
  } else {
    // Switching to the only tab still has to work and still has to say so.
    const same = await b.tabs({ to: "downloads.html" });
    assert.match(same, /switched to it/);
    assert.match(same, /Export CSV/);
  }
  // A target that matches nothing is reported, not silently ignored — true on every engine.
  assert.match(await b.tabs({ to: "no-such-tab-anywhere" }), /no tab matches/);
});

test("open() describes the page it navigated, not a popup that page spawns", async () => {
  // Regression for the WebKit-CI flake of 2026-09-25. A receipt tab opened by the previous test
  // arrived late; its "page" event swung the current tab mid-open, so open() snapshotted the popup
  // (a framed.html checkout) instead of the CAPTCHA page it had just loaded. Deterministic here:
  // the fixture opens a popup as it loads, so the event always lands during open()'s settle.
  const s = await b.open(page("popup-on-load.html"));
  assert.match(s, /Opener page loaded/);   // the page open() was told to load
  assert.doesNotMatch(s, /Card details/);  // not the popup it spawned
  // The popup is not lost — switching to it is the tabs tool's job, not a silent hijack of open().
  assert.match(await b.tabs({ to: "framed.html" }), /switched to it/);
  await b.tabs({ shut: "framed.html" });   // leave a single tab for the next test
});

test("open() that fails to navigate does not pass the previous page off as the target", async () => {
  // Found by dogfooding: opening a PDF made page.goto throw "Download is starting", the browser
  // stayed on the last site, and open() appended that page's snapshot anyway — so the PDF's URL came
  // back carrying the previous page's form, refs and login flag, and an agent would then fill a
  // login form belonging to a page it never left. An invalid URL fails the same way on every engine
  // (Playwright rejects it before it navigates, so the current page is left in place) without
  // leaning on engine-specific download behaviour or its wording.
  await b.open(page("form.html"));            // a real page to be left on
  const s = await b.open("http://");          // rejected before navigation; the browser does not move
  assert.match(s, /could not load/);          // the failure is stated
  assert.doesNotMatch(s, /form "Login"/);     // NOT the previous page's content
  assert.doesNotMatch(s, /\[e\d+\]/);         // and none of its refs leaked through
  assert.match(s, /still on .*form\.html/);   // it says where the browser actually is, so a stale
                                              // snapshot is not mistaken for the page just requested
});

test("a politely worded CAPTCHA is still named as a wall", async () => {
  // Hit for real on DuckDuckGo: none of the "just a moment" phrasings appear, so it read as an
  // ordinary page with one button and the empty result looked like "no matches".
  const s = await b.open(page("captcha.html"));
  assert.match(s, /^blocked: this is a CAPTCHA/m);
});

test("a wall named only in the page TITLE is still caught", async () => {
  // Cloudflare's interstitial on claude.ai puts "Just a moment..." in the title and only
  // "Performing security verification" in the body, so a body-only check read it as an ordinary
  // page. Third time this detector has been too literal about wording; the title counts now.
  const s = await b.open(page("title-wall.html"));
  assert.match(s, /^blocked: this is an interstitial bot check/m);
});

test("solve refuses honestly when it cannot help, rather than pretending", async () => {
  // The tests run with TB_EPHEMERAL=1, where clearing a challenge buys nothing that survives —
  // so it says that instead of opening a window and wasting someone's time on it.
  await b.open(page("blocked.html"));
  const out = await b.solve({ seconds: 1 });
  assert.match(out, /TB_EPHEMERAL=1 throws the profile away/);
});

test("read gives the page as prose, without the navigation", async () => {
  // The snapshot says what you can DO with a page and almost nothing about what it SAYS, which
  // left "read this page" going through the js escape hatch — a gap with a workaround.
  await b.open(page("form.html"));
  const out = await b.read();
  assert.match(out, /Sign in/);
  assert.doesNotMatch(out, /Link 7/); // the 150 nav links are furniture, not content
});

test("read slices a long page and find jumps to the right slice", async () => {
  await b.open(page("framed.html"));
  const whole = await b.read({ chars: 100000 });
  assert.ok(whole.length > 0);
  const sliced = await b.read({ chars: 20 });
  assert.match(sliced, /slice 1 of \d+/);
  // A small window on purpose: the match must survive it, which it did not when find snapped to a
  // fixed slice grid and cut the phrase in half.
  const found = await b.read({ chars: 20, find: "Review order" });
  assert.match(found, /Review order/);
  assert.match(found, /around "Review order" \(character \d+ of \d+\)/);
  assert.match(await b.read({ find: "nothing like this exists here" }), /is not in the/);
});

test("open survives a navigation that returns no response object", async () => {
  // goto() returns null when the navigation produced no response of its own — a same-document
  // jump, and on Firefox a plain file:// load. A rewrite dropped the `res &&` guard on the status
  // check, and the null dereference that followed failed 25 of 44 tests on Firefox while Chromium
  // stayed green. A cross-engine gap this wide deserves a test that names it.
  const s = await b.open(page("form.html"));
  assert.match(s, /\[e\d+\]/);
  // Same-document navigation: res is null here on every engine.
  const again = await b.open(page("form.html") + "#section");
  assert.doesNotMatch(again, /Cannot read properties/);
  assert.ok(again.length > 0);
});
