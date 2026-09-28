# Changelog

Every entry says what was wrong, because that is the useful half. Numbers are from
`npm run bench` on the day, against the snapshot Playwright's MCP server sends.

## 0.7.3

- **A control whose accessible name pointed at a missing or empty node came back nameless.**
  `aria-labelledby` and `label[for=…]` were trusted even when they resolved to nothing — a typo in
  an id, or a label node rendered conditionally and then removed — so the snapshot returned an empty
  name (`[e1] button ""`), leaving a control an agent could neither read nor address by name when the
  element's own visible text or placeholder was sitting right there (it even leaked into the prose
  tail). When the reference resolves to an empty string the name now falls through to the element's
  own text, the way the wrapping-`<label>` case already did; a reference that *does* resolve still
  wins, so a button labelled by a separate heading is unchanged. Found by reading the fallback chain.
  Benchmark re-run and unchanged — the five pages resolve their references, so the snapshot format
  did not move on them.

## 0.7.2

- **A navigation that failed came back wearing the previous page.** When `open()`'s `page.goto`
  threw — a URL that is really a file download (a PDF, a CSV, a zip) aborts the navigation, and an
  invalid or dead URL is rejected outright — the browser stayed on whatever it was already showing,
  and `open()` appended a full snapshot of *that* page anyway. So opening a PDF answered with the
  last site's form, its refs and its "login page" flag under the URL you had just asked for, and an
  agent would go on to fill a login form belonging to a page it never left. `open()` now, on a thrown
  navigation, says what failed, names a download for what it is, and states where the browser really
  still is — and shows no snapshot, because no new page loaded to describe. An HTTP 403/404 is
  unchanged: it resolves with a response rather than throwing, so a served block or error page still
  comes back with its content, which is where that belongs. Found by dogfooding: opening a `.pdf`
  returned the previous site's block page as though it were the PDF. Benchmark re-run and unchanged
  (this is the error path; the snapshot format did not move).

## 0.7.1

- **A `mailto:` or `tel:` link read as an ordinary link, so an agent would click it and get nothing.**
  Those schemes do not navigate — in a headless browser the click opens no mail client and no dialer,
  it is a dead action, and the real move is to read the address off the label. The snapshot now marks
  them, `[e6] "Email the studio" → email` and `… → phone`, so the agent knows not to click into a void.
  External `http(s)` links are left unmarked on purpose: they *do* navigate, so a click still works, and
  flagging every one of them measured **+5%** on the benchmark (44.1x → 41.9x) whose ratio the README,
  the landing page and the store listing all quote — that is a positioning change, not a bug fix.
  Found by dogfooding: a page's `mailto:` contact link looked identical to a real page link. Benchmark
  re-run after the change: unchanged at **44.1x** (mailto/tel are ~absent on the five pages).

## 0.7.0

Both of these were found by the directory's own validator during submission, which saw things no
test here would have.

- **A top-level `bin/` directory made the plugin uninstallable on Cowork and the Claude web,
  desktop and mobile apps** — most of the reach, lost to a directory name. It is `cli/` now. npm's
  `bin` field can point anywhere, so nothing about the `npx` entry point changed.
- **No icon.** The artwork existed in `art/` but the directory looks in the manifest or
  `.claude-plugin/icon.*`, so the listing would have fallen back to a GitHub avatar. The icon is
  where it is looked for, and named in `plugin.json`.

## 0.6.1

- **WebKit runs on distros that are not Ubuntu 24.04.** `npx playwright install-deps webkit`
  apt-gets Ubuntu package names that do not exist on Kali or Debian testing (`libicu74`,
  `libjpeg-turbo8`). `cli/webkit-deps.mjs` fetches just the shared objects WebKit actually links and
  puts them in the bundle's own lib directory — no sudo, nothing outside `~/.cache`. Symlinking a
  newer ICU does not work: its symbols carry the major version, so the library loads and every
  symbol is missing. All 25 browser tests now pass on WebKit, so all three engines are verified.
- The first version of that installer probed `WebKitWebProcess`, which does not link ICU —
  `MiniBrowser` does — so it reported "nothing to do" about a WebKit that could not start. Its
  verdict is now a real launch rather than an `ldd` listing.

## 0.6.0

- **`read`**: the page as prose with the navigation stripped, in slices for a long page. "Not a
  reader" had been a gap with a workaround (the `js` escape hatch) rather than a feature. `find`
  returns a window **centred** on the phrase; snapping to a fixed slice grid cut the match in half
  whenever it straddled a boundary.
- **`downloads({ waitSeconds })`**: a download lands after the click returns, so asking immediately
  usually found nothing.
- **`TB_CDP` finally has a test**, which was overdue — it is the answer to every site that refuses
  an automated browser, and it had shipped untested because it was built last.

## 0.5.1

- `solve` cannot beat Cloudflare's strict mode and now says so. Measured on claude.ai: 170 seconds
  of a person clicking, headed, and again with the real Google Chrome binary — still challenged.
  Telling someone to try again wastes another three minutes on something that cannot work, so it
  names what is happening and gives the instruction that does (`TB_CDP`).
- `TB_CHANNEL=chrome` uses the installed Google Chrome rather than Playwright's build. Worth having
  for fidelity; measured, it makes no difference to bot protection, and the README says so.

## 0.5.0

- **`solve`**: reopens a blocked page in a visible window and waits while the person at the keyboard
  clears the challenge. A CAPTCHA asks whether a human is present; if one is, they can answer it.
  The persistent profile keeps the cookie, so later runs go through headless. It refuses honestly
  when it cannot help rather than wasting someone's time.

## 0.4.3

- A bot wall named only in the page **title** is caught. Cloudflare's interstitial on claude.ai puts
  "Just a moment..." in the title and only "Performing security verification" in the body, so a
  body-only check read it as an ordinary page. Third miss from this detector, all found by hitting
  them during real work.

## 0.4.1

- A politely worded CAPTCHA is still a wall. DuckDuckGo answers a suspected bot with "bots use
  DuckDuckGo too… select all squares", which matched none of the shipped phrasings — so it
  snapshotted as an ordinary page and an empty search read as "no matches".

## 0.4.0

- **iframes**: child frames are collected, refs prefixed `[f1e3]`, cross-origin frames named as
  unreadable rather than dropped. This was the worst gap because it was silent — a card form or a
  consent dialog made the page look *empty* rather than look wrong.
- **tabs**: list, switch by index or URL, close one. A link that opened a tab used to be a dead end.
- **downloads**: saved to disk and listed. The browser discards them unless something asks, so
  "Export CSV" did nothing at all.
- **`TB_CDP`**: attaches the whole server to a browser already running and signed in. `close`
  detaches instead of shutting it down.
- **Firefox**: `TB_BROWSER=firefox`, its own profile directory, whole suite passing.
- Diff replies after an action (`changed: +2 -2, 17 unchanged`). Measured: 1.7x cheaper across a
  click-heavy task and **nothing at all** on form filling, because `fill` already answers in twenty
  characters. `bench/session.mjs` prints both; a benchmark that only shows the flattering task is
  not one.
- The diff had a bug caught by writing its test: the baseline was read *after* the fresh snapshot had
  overwritten it, so every action answered "the page is unchanged" however much had moved.
- `npm test` was exiting 1 while every assertion passed — the smoke file needed longer than the
  script's 60s timeout.
- **37.2x → 44.3x smaller**, by deleting waste rather than showing less: the word "link" was 12.4% of
  every snapshot (88 of 103 elements on Wikipedia), and the prose tail duplicated headings the page
  had already given.

## 0.2.1

- `package.json` still said `"license": "SEE LICENSE IN LICENSE"` after the core went MIT, so npm
  advertised a bespoke licence for an MIT project. That is the field people filter on.
- The launcher re-installed 96 packages it already had: it looked for `<root>/node_modules/<pkg>`,
  but npm hoists dependencies to the installing project's top level.

## 0.2.0

- First public release. Compact snapshots, stable refs, overlay-proof clicks, three-state `wait`,
  `fill_secret`, ARIA dropdowns, ambiguity reporting, `console` and `network`, inline `screenshot`,
  bot-wall naming, and the benchmark.
- **The benchmark was measuring the wrong thing and undersold the product by half.**
  `ariaSnapshot()` is not what Playwright's MCP server sends — it omits the `[ref=e1]` annotations
  MCP adds, which are most of the bytes. Against the real format the ratio was 37.6x, not 19.9x.
