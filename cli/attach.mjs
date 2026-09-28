#!/usr/bin/env node
// Drive a browser the OWNER is already signed into, instead of asking them to log in again.
//
// WHY THIS EXISTS. thinbrowser keeps its own persistent profile
// (~/.cache/thinbrowser/profile), which is right for most work but means it has no session for
// anything the owner logged into by hand. Play Console is exactly that case: the profile had 11
// Google cookies against 79 in ~/.cache/shared-browser, so every visit hit the sign-in wall, and
// logging in as them is not something to automate - it needs their 2FA and their consent.
//
// Their Chrome already exposes a DevTools port, so this attaches over CDP and uses the session
// that is already there. Nothing is stored, no password is typed, and it works only while that
// browser is running.
//
// It opens its OWN page and closes it afterwards. It never touches the owner's existing tabs:
// navigating one out from under them would lose whatever they were doing.
//
//   node cli/attach.mjs apps                      list Play Console apps with their ids
//   node cli/attach.mjs snap <url>                open a url and print headings + fields
//   node cli/attach.mjs shot <url> <out.png>      screenshot it
import { chromium } from "playwright";

const PORT = process.env.TB_CDP_PORT || 9224;

export async function attach() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("no browser context on the CDP endpoint");
  return { browser, ctx };
}

/** A fresh page we own, so the owner's tabs are never navigated. */
export async function newPage(ctx) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);
  return page;
}

async function settle(page, ms = 3500) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const busy = await page.evaluate(() => document.querySelectorAll('[role="progressbar"]').length)
      .catch(() => 0);
    if (!busy) break;
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { browser, ctx } = await attach();
  const page = await newPage(ctx);
  try {
    if (cmd === "apps") {
      await page.goto("https://play.google.com/console/u/0/developers/6852517119664371344/app-list",
                      { waitUntil: "domcontentloaded" });
      await settle(page, 6000);
      if (/accounts\.google\.com/.test(page.url())) { console.log("STILL SIGNED OUT:", page.url()); return; }
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('a[href*="/app/"]')]
          .map((a) => ({ href: a.getAttribute("href"), text: (a.innerText || "").trim().split("\n")[0] }))
          .filter((r) => /\/app\/\d+/.test(r.href)));
      const seen = new Set();
      for (const r of rows) {
        const id = (r.href.match(/\/app\/(\d+)/) || [])[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        console.log(`  ${id}  ${r.text || "(no label)"}`);
      }
      if (!seen.size) console.log("  no app links found; page title:", await page.title());
    } else if (cmd === "snap") {
      await page.goto(rest[0], { waitUntil: "domcontentloaded" });
      await settle(page, 6000);
      console.log("url:", page.url());
      console.log("title:", await page.title());
      const info = await page.evaluate(() => ({
        headings: [...document.querySelectorAll("h1,h2,h3")].map((h) => h.innerText.trim()).filter(Boolean).slice(0, 12),
        fields: [...document.querySelectorAll("input[type=text],textarea")].map((el) => ({
          label: (el.getAttribute("aria-label") || el.getAttribute("name") || el.id || "").slice(0, 60),
          value: (el.value || "").slice(0, 120), max: el.getAttribute("maxlength"),
        })).slice(0, 14),
      }));
      console.log(JSON.stringify(info, null, 1));
    } else if (cmd === "shot") {
      await page.goto(rest[0], { waitUntil: "domcontentloaded" });
      await settle(page, 6000);
      await page.screenshot({ path: rest[1], fullPage: false });
      console.log("saved", rest[1], "| url:", page.url());
    } else {
      console.log("usage: attach.mjs apps | snap <url> | shot <url> <out.png>");
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});   // detaches; does NOT close the owner's browser
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
