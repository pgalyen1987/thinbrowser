# thinbrowser — launch copy

Honest, verified numbers as of 2026-09-29. Re-run `node bench/tasks.mjs` and `node bench/vercel.mjs`
before posting; live pages change, so refresh the figures rather than trusting these.

Two comparisons, both real, kept separate on purpose:
- **vs Vercel's agent-browser** (the direct competitor, 43k stars): **28x smaller** across 5 live
  pages (42x on a large one), and **10/10 task coverage vs its 9/10** — the compaction costs no
  ability to act. Reproducible: `bench/tasks.mjs`, `bench/vercel.mjs`.
- **vs Playwright's own MCP server** (the default an agent is handed): ~**43.5x smaller**.

About as fast after the 2026-09-29 settle trim (~parity, thinbrowser waits for dynamic content so it stays marginally behind on some pages). Stand behind size + task coverage, not a speed win.

---

## Show HN

**Title** (pick one; keep it factual, HN punishes hype):
> Show HN: thinbrowser – compact browser snapshots for AI agents, 28x smaller than agent-browser

**Body:**

I build agent tooling and kept hitting the same wall: handing an LLM a full accessibility-tree
snapshot of a page burns thousands of tokens to describe one screen. Vercel's agent-browser and
Playwright's MCP server both do this well, but the snapshots are large.

thinbrowser returns a compact snapshot instead — headings, forms, and interactive elements with
stable refs (`[e12]`), then a short run of the page's text — and drops the rest.

The obvious objection is "sure it's smaller, but does the agent still have what it needs to act?"
So I wrote a task benchmark ([bench/tasks.mjs](https://github.com/pgalyen1987/thinbrowser/blob/main/bench/tasks.mjs)):
the same realistic tasks on both tools — click element X (must appear with a usable ref), read
value Y — scored for coverage next to size. On five live pages:

- thinbrowser: **10/10 tasks**, 11,690 chars total
- vercel-labs/agent-browser: 9/10 tasks, 328,390 chars total
- → **28x smaller, and it didn't drop anything the tasks needed.** (Vercel's one miss was real —
  its a11y snapshot omits example.com's page heading.)

Honest caveats: the size win is from returning *less*, which is easy — the benchmark exists so you
can check it doesn't come at the cost of task coverage. It is about as fast (a settle-time trim on 2026-09-29 brought it to ~parity; do not claim a speed win). MIT, Node 20+, works as an MCP server or a CLI.

Install: `claude mcp add thinbrowser -- npx -y thinbrowser`
Repo + benchmarks: https://github.com/pgalyen1987/thinbrowser

Happy to run the benchmark against any page or task you throw at it in the comments.

---

## Product Hunt

**Name:** thinbrowser
**Tagline:** Browser snapshots for AI agents, 28x smaller — without dropping what they need
**Topics:** Artificial Intelligence, Developer Tools, Open Source

**Description:**
Feeding an AI agent a full page snapshot wastes thousands of tokens. thinbrowser returns a compact
snapshot — headings, forms, and interactive elements with stable refs, plus a short run of text —
that's ~28x smaller than vercel-labs/agent-browser across five live pages, while completing 10/10 of
the same agent tasks (it 9/10). Free, MIT, MCP server or CLI. The task benchmark is in the repo so
you can check the smaller snapshot still works.

**First comment (maker's note):**
Hi PH — I made this because every agent I built spent most of its context budget re-reading pages.
The trap with "smaller snapshot" is dropping the button the agent needed to click, so I shipped a
task benchmark alongside the size one: same tasks on thinbrowser and agent-browser, scored for
whether the element is actually there with a ref. 28x smaller, 10/10 vs 9/10 coverage, reproducible.
It's not faster, and the size win is just returning less — the benchmark is there to prove that's
safe. Install is one line: `claude mcp add thinbrowser -- npx -y thinbrowser`. Repo:
https://github.com/pgalyen1987/thinbrowser — feedback welcome, especially pages where it drops
something it shouldn't.
