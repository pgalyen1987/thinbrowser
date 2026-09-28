// The store artwork, drawn in code.
//
// THE MARK IS THE PRODUCT: a dense field of lines on the left collapsing into a handful of solid
// ones on the right. That is literally what the tool does to a page — 246,434 characters becoming
// 4,557 — so the icon argues the pitch instead of decorating it, and it still reads at 32px because
// the only thing it has to say at that size is "many becomes few".
//
// No image API is used. These are SVGs rendered to PNG by the browser this package already drives,
// which costs nothing and keeps the mark editable as text.
//
//   node art/make.mjs        writes art/*.svg and art/*.png
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(here, { recursive: true });

// The landing page's palette, so the store listing and the site are one thing.
const INK = "#0E1316";
const SIGNAL = "#2ED3B2";
const NOISE = "#3D4C54";
const NOISE_SMALL = "#5C6E78"; // the field needs more contrast when there are fewer, fatter lines
const PAPER = "#F4F6F7";

/**
 * The mark. `s` is the square's side; everything else is derived from it, so it scales exactly.
 *
 * Left: 26 hairlines at 1/26 spacing — deliberately more than the eye can count, which is the point.
 * Right: 4 bars on the golden-ratio grid, each the height of roughly six hairlines.
 */
function mark(s, { bg = INK, noise = NOISE, signal = SIGNAL, pad = 0.17, small = false } = {}) {
  const P = s * pad;
  const W = s - P * 2;              // drawable width
  const midX = P + W * 0.472;       // the collapse point, just left of centre so the bars breathe
  const lines = [];

  // OPTICAL SIZING. At 32px, 26 hairlines render as one dark smudge and the "many becomes few"
  // reading is lost — checked, not assumed. Below 64px the field drops to 9 thicker lines, which
  // survives the pixel grid and keeps the idea legible at the size it is most often seen.
  const N = small ? 9 : 26;
  const gap = W / (N + 6);
  for (let i = 0; i < N; i++) {
    const y = P + gap * 3 + i * gap;
    if (y > s - P) break;
    // Lines nearer the vertical middle reach further right, so the field reads as funnelling.
    const t = 1 - Math.abs(i - (N - 1) / 2) / ((N - 1) / 2);
    const x2 = P + (midX - P) * (0.42 + 0.58 * t);
    lines.push(
      `<line x1="${P.toFixed(2)}" y1="${y.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y.toFixed(2)}" ` +
      `stroke="${noise}" stroke-width="${(s * (small ? 0.034 : 0.011)).toFixed(2)}" stroke-linecap="round"/>`,
    );
  }

  // The result: four solid bars, phi-spaced, in the signal colour.
  const barH = s * (small ? 0.105 : 0.062);
  const barGap = barH * 1.618;
  const bars = small ? [0.6, 1.0, 0.75] : [0.42, 0.78, 0.62, 0.3]; // varied: a real page is not equal rows
  const blockH = bars.length * barH + (bars.length - 1) * (barGap - barH);
  let by = (s - blockH) / 2;
  const right = [];
  for (const w of bars) {
    right.push(
      `<rect x="${(midX + s * 0.055).toFixed(2)}" y="${by.toFixed(2)}" ` +
      `width="${(W * w * 0.52).toFixed(2)}" height="${barH.toFixed(2)}" rx="${(barH / 2).toFixed(2)}" fill="${signal}"/>`,
    );
    by += barGap;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" rx="${(s * 0.2).toFixed(2)}" fill="${bg}"/>
  ${lines.join("\n  ")}
  ${right.join("\n  ")}
</svg>`;
}

/** The wide listing banner: the mark, the name, and the one number worth leading with. */
function banner(w = 1280, h = 640) {
  const s = Math.round(h * 0.42);
  const inner = mark(s, { bg: "none", pad: 0.06 })
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>$/, "")
    .replace(`<rect width="${s}" height="${s}" rx="${(s * 0.2).toFixed(2)}" fill="none"/>`, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${INK}"/>
  <g transform="translate(${Math.round(w * 0.072)}, ${Math.round((h - s) / 2)})">${inner}</g>
  <g transform="translate(${Math.round(w * 0.072 + s + w * 0.045)}, ${Math.round(h / 2)})" font-family="IBM Plex Sans, Segoe UI, Helvetica, Arial, sans-serif">
    <text x="0" y="-58" fill="${PAPER}" font-size="62" font-weight="600" letter-spacing="-1.6">thinbrowser</text>
    <text x="0" y="6" fill="${SIGNAL}" font-size="40" font-weight="500" letter-spacing="-0.6">37&#215; less page, same answer</text>
    <text x="0" y="62" fill="#93A1A9" font-size="26" font-weight="400">A browser an agent can actually drive. MCP, any client.</text>
    <text x="0" y="104" fill="#6B7880" font-size="21" font-family="IBM Plex Mono, ui-monospace, monospace">246,434 chars &#8594; 4,557 &#183; measured, reproducible</text>
  </g>
</svg>`;
}

const files = [];
for (const s of [512, 256, 128, 64, 32]) {
  const f = join(here, `icon-${s}.svg`);
  const small = s <= 64;
  writeFileSync(f, mark(s, small ? { small: true, noise: NOISE_SMALL, pad: 0.15 } : {}));
  files.push({ svg: f, png: join(here, `icon-${s}.png`), w: s, h: s });
}
const bf = join(here, "banner.svg");
writeFileSync(bf, banner());
files.push({ svg: bf, png: join(here, "banner.png"), w: 1280, h: 640 });

// Render each SVG to PNG with the browser this package already ships with.
const browser = await chromium.launch({ headless: true });
for (const f of files) {
  const page = await browser.newPage({ viewport: { width: f.w, height: f.h }, deviceScaleFactor: 1 });
  await page.goto("file://" + f.svg);
  await page.screenshot({ path: f.png, omitBackground: true });
  await page.close();
  console.log(`  ${f.png.split("/").pop()}  ${f.w}x${f.h}`);
}
await browser.close();
console.log(`\n${files.length} SVGs and PNGs written to art/`);
