"""What browser-use sends a model for a page, in characters.

WHY THIS IS HERE. bench/compare.mjs measures us against Playwright's MCP server, which is the
default an agent gets handed. It is not the closest competitor: browser-use is far more widely
adopted and already builds a compact representation of its own, so a claim of "smaller" that only
beats Playwright is a claim that has not been tested against the field.

This calls browser-use's own `llm_representation()` through its own BrowserSession — the exact
string its agent puts in the prompt — on the same five pages, at the same viewport, with the same
settle allowance. It is its real output, not a reconstruction.

No LLM key is needed: only the DOM serialisation runs, never the agent loop.

    python3 -m venv /tmp/bu && /tmp/bu/bin/pip install browser-use
    /tmp/bu/bin/python bench/browser-use.py

MEASURED 2026-09-25, characters, same pages as bench/compare.mjs:

    page                    Playwright MCP   thinbrowser   browser-use
    example.com                        315             213           138
    developer.mozilla.org          167,609           3,307         9,350
    news.ycombinator.com            57,480           2,071        13,903
    playwright.dev/docs              37,296           3,410         4,641
    en.wikipedia.org               241,988           4,557        10,069
    total                          504,688          13,558        38,101

So ~37x smaller than Playwright MCP and ~2.8x smaller than browser-use. The second number is the
honest one to lead with against a reader who knows the field, and browser-use WINS on example.com
(138 vs 213) — on a page with almost nothing on it, our header and URL line cost more than the
whole page does.

Stagehand is not measured here: v4 depends on @browserbasehq/sdk and expects a Browserbase account,
so measuring it means paying for a cloud service. An unmeasured competitor is left unmeasured
rather than estimated.
"""

import asyncio
import json
import sys

PAGES = [
    "https://example.com/",
    "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
    "https://news.ycombinator.com/",
    "https://playwright.dev/docs/intro",
    "https://en.wikipedia.org/wiki/Accessibility",
]


async def main() -> None:
    from browser_use.browser.profile import BrowserProfile
    from browser_use.browser.session import BrowserSession

    session = BrowserSession(
        browser_profile=BrowserProfile(headless=True, window_size={"width": 1280, "height": 900})
    )
    await session.start()

    rows = []
    for url in PAGES:
        try:
            await session.navigate_to(url)
            await asyncio.sleep(1.5)
            state = await session.get_browser_state_summary()
            rows.append({"url": url, "chars": len(state.dom_state.llm_representation())})
        except Exception as e:  # noqa: BLE001 — one bad page should not lose the whole run
            rows.append({"url": url, "error": f"{type(e).__name__}: {e}"[:160]})
    await session.kill()

    width = max(len(r["url"]) for r in rows)
    total = 0
    for r in rows:
        if "error" in r:
            print(f"{r['url']:<{width}}  {r['error']}")
            continue
        total += r["chars"]
        print(f"{r['url']:<{width}}  {r['chars']:>8,}")
    print(f"{'total':<{width}}  {total:>8,}")
    print(f"\n(compare with `npm run bench` in this repo, measured the same day)")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:  # noqa: BLE001
        print(f"failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
