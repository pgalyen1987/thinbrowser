#!/usr/bin/env node
// Make Playwright's WebKit run on a distro that is not Ubuntu 24.04, without sudo.
//
// THE PROBLEM. Playwright builds WebKit against Ubuntu 24.04 and links it to that release's exact
// library sonames. `npx playwright install-deps webkit` then tries to apt-get Ubuntu package names,
// which on Kali, Debian testing or anything else simply do not exist:
//
//     E: Package 'libicu74' has no installation candidate
//     E: Package 'libjpeg-turbo8' has no installation candidate
//
// Kali, for instance, ships libicu 72, 76 and 78 — every version except the one WebKit wants. And
// ICU symbols carry their major version (`ucnv_open_74`), so symlinking 76 to 74 does not work
// either: the library loads and then every symbol is missing.
//
// THE FIX. Fetch the four shared objects WebKit actually asks for, and put them in the bundle's own
// lib directory — the one its launcher already searches. Nothing outside ~/.cache is touched, no
// package manager is involved, and the system's own ICU is left exactly where it was.
//
//     node cli/webkit-deps.mjs
//
// Verified 2026-09-25 on Kali (ICU 72/76/78, libjpeg 62): all 25 browser tests pass on WebKit after.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, copyFileSync, lstatSync, symlinkSync, readlinkSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Ubuntu 24.04 (noble) is what Playwright's WebKit is built against, so these are its libraries.
const DEBS = [
  "http://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu74_74.2-1ubuntu3.1_amd64.deb",
  "http://archive.ubuntu.com/ubuntu/pool/main/libj/libjpeg-turbo/libjpeg-turbo8_2.1.5-2ubuntu2_amd64.deb",
];
const WANTED = [/^libicudata\.so\.74/, /^libicui18n\.so\.74/, /^libicuuc\.so\.74/, /^libjpeg\.so\.8/];

const cache = join(homedir(), ".cache/ms-playwright");
const bundles = existsSync(cache)
  ? readdirSync(cache).filter((d) => d.startsWith("webkit-")).map((d) => join(cache, d))
  : [];
if (!bundles.length) {
  console.error("no WebKit bundle found. Run `npx playwright install webkit` first.");
  process.exit(1);
}

// Ask the BUNDLE what is missing, rather than trusting a package list — that list is the thing
// that was wrong in the first place.
//
// Two details this got wrong before and now does not: it is MiniBrowser that links ICU, not
// WebKitWebProcess (probing the latter reported "nothing to do" on a WebKit that could not start);
// and ldd must run with the bundle's own lib directory on the path, or every internal library
// (libWPEWebKit, libwpe, libjxl) reports as missing and buries the four that genuinely are.
const probe = (bundle) => {
  const flavour = join(bundle, "minibrowser-wpe");
  const lib = join(flavour, "lib");
  const bins = ["MiniBrowser", "WPEWebProcess", "WPENetworkProcess", "WPEWebDriver"]
    .map((n) => join(flavour, "bin", n)).filter(existsSync);
  const missing = new Set();
  for (const bin of bins) {
    try {
      const out = execFileSync("ldd", [bin], {
        encoding: "utf8",
        env: { ...process.env, LD_LIBRARY_PATH: [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") },
      });
      for (const l of out.split("\n")) {
        if (l.includes("not found")) missing.add(l.trim().split(" ")[0]);
      }
    } catch { /* a binary we cannot read tells us nothing either way */ }
  }
  return [...missing];
};

const before = probe(bundles[0]);
if (!before.length) { console.log("WebKit already has everything it needs — nothing to do."); process.exit(0); }
console.log(`WebKit is missing ${before.length}: ${before.join(", ")}`);

const work = join(tmpdir(), "ab-webkit-deps");
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "ext"), { recursive: true });

for (const url of DEBS) {
  const name = url.split("/").pop();
  console.log(`  fetching ${name}`);
  execFileSync("curl", ["-sSL", "--max-time", "180", "-o", join(work, name), url]);
  execFileSync("dpkg-deb", ["-x", join(work, name), join(work, "ext")]);
}

const src = join(work, "ext/usr/lib/x86_64-linux-gnu");
let staged = 0;
for (const bundle of bundles) {
  for (const flavour of ["minibrowser-wpe", "minibrowser-gtk"]) {
    const dest = join(bundle, flavour, "lib");
    if (!existsSync(dest)) continue;
    for (const f of readdirSync(src)) {
      if (!WANTED.some((re) => re.test(f))) continue;
      const from = join(src, f), to = join(dest, f);
      // Preserve the soname symlinks: the loader asks for libicuuc.so.74, which is a link.
      if (lstatSync(from).isSymbolicLink()) {
        try { rmSync(to, { force: true }); symlinkSync(readlinkSync(from), to); staged++; } catch {}
      } else {
        copyFileSync(from, to); staged++;
      }
    }
  }
}
rmSync(work, { recursive: true, force: true });

const after = probe(bundles[0]);
console.log(`staged ${staged} files.`);

// THE VERDICT IS A LAUNCH, NOT AN ldd LISTING. libjxl.so.0.8 stays "not found" on this machine and
// WebKit runs perfectly well without it — JPEG XL is optional, and failing the script over an
// unresolved name that does not matter would send someone chasing a library they do not need.
// Whether the browser starts is the only question worth answering.
let ok = false, why = "";
try {
  const { webkit } = await import("playwright");
  const browser = await webkit.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("https://example.com/", { timeout: 30000 });
  ok = true;
  await browser.close();
} catch (e) {
  why = (String(e.message).match(/error while loading shared libraries: [^\s]+/) || [String(e.message).split("\n")[0]])[0];
}

if (ok) {
  console.log("WebKit launches and loads a page.");
  if (after.length) console.log(`(ldd still lists ${after.join(", ")} — optional, and evidently not needed.)`);
  console.log("\nUse it with:  TB_BROWSER=webkit");
} else {
  console.error(`WebKit still will not start: ${why}`);
  if (after.length) console.error(`unresolved: ${after.join(", ")}`);
  process.exit(1);
}
