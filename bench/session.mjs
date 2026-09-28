// What a TASK costs, not what a page costs.
//
// bench/compare.mjs measures one page load, which is the fair comparison for a snapshot format but
// not what an agent actually spends. An agent takes ten actions, and until now every one of them
// answered with a full fresh snapshot — so a ten-step task paid for the page ten times, even though
// clicking "Next" in a wizard changes a handful of lines and repeats sixty.
//
// This walks a real page, takes a run of actions, and sums every character handed back. Then it
// does the same with diffs turned off, so the saving is measured rather than asserted.
//
//   node bench/session.mjs
import * as ab from "../src/browser.mjs";

process.env.TB_EPHEMERAL = "1";

// TWO TASKS, because the saving depends entirely on how much the page moves and one number would
// hide that. Filling a form is the common shape of agent work -- each step changes one line out of
// a hundred. Collapsing a page's navigation is the opposite, and the diff correctly refuses to be
// used there, so it is kept in as the honest worst case.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const FORM = pathToFileURL(join(import.meta.dirname, "..", "test", "fixtures", "form.html")).href;
const TASKS = [
  {
    name: "fill a form (a page with 150 nav links, one field at a time)",
    page: FORM,
    steps: [
      ["fill", "Email", "pat@example.com"],
      ["fill", "API key", "not-a-secret"],
      ["select", "Plan", "Pro"],
      ["fill", "Email", "other@example.com"],
      ["fill", "API key", "changed-again"],
      ["select", "Plan", "Free"],
    ],
  },
  {
    name: "collapse and expand a page's contents (the worst case)",
    page: "https://en.wikipedia.org/wiki/Accessibility",
    steps: [
      ["click", "Hide Contents"], ["click", "Show Contents"], ["click", "Hide Contents"],
      ["click", "Show Contents"], ["click", "Hide Contents"], ["click", "Show Contents"],
    ],
  },
];

async function run(task, diffs) {
  ab.setDiffs(diffs);
  const first = (await ab.open(task.page)).length;
  let after = 0;
  const perStep = [];
  for (const [verb, target, value] of task.steps) {
    const out = verb === "click" ? await ab.click(target)
      : verb === "select" ? await ab.select(target, value)
      : await ab.fill(target, value);
    after += out.length;
    perStep.push(out.length);
  }
  return { first, after, total: first + after, perStep };
}

const fmt = (n) => n.toLocaleString();
for (const task of TASKS) {
  const off = await run(task, false);
  const on = await run(task, true);
  console.log(`\n${task.name}`);
  console.log(`  first load, both ways      ${fmt(on.first)}`);
  console.log(`  ${task.steps.length} actions, full snapshots   ${fmt(off.after)}   ${off.perStep.map(fmt).join(", ")}`);
  console.log(`  ${task.steps.length} actions, diffs           ${fmt(on.after)}   ${on.perStep.map(fmt).join(", ")}`);
  console.log(`  ACTIONS  ${(off.after / on.after).toFixed(1)}x cheaper   whole task ${(off.total / on.total).toFixed(1)}x`);
}
await ab.close();
console.log(`\nThe first load is identical either way; the saving is all in what follows it.`);
