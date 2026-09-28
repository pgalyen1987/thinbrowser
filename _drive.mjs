// Drive the owner's logged-in Chrome (CDP :9224) through thinbrowser. One-shot per invocation;
// browser state persists between runs. Actions: {"open":url} {"snap":{}} {"click":ref|desc}
// {"fill":{target,value,submit}} {"js":"expr"} {"shot":"path"} {"find":"text"}
process.env.TB_CDP = "9224";
const ab = await import("/home/me/thinbrowser/src/browser.mjs");
const actions = JSON.parse(process.argv[2] || "[]");
for (const a of actions) {
  try {
    if (a.open)  console.log("== open ==\n" + (await ab.open(a.open)).slice(0, 3500));
    else if (a.snap !== undefined) console.log("== snap ==\n" + (await ab.snapshot(a.snap || {})).slice(0, 3500));
    else if (a.click) console.log("== click ==\n" + (await ab.click(a.click, { snap: false })).slice(0, 800));
    else if (a.fill)  console.log("== fill ==\n" + (await ab.fill(a.fill.target, a.fill.value, { submit: !!a.fill.submit })).slice(0, 800));
    else if (a.js)    console.log("== js ==\n" + JSON.stringify(await ab.js(a.js)).slice(0, 2000));
    else if (a.shot)  console.log("== shot ==\n" + JSON.stringify(await ab.screenshot(a.shot)));
    else if (a.select) console.log("== select ==\n" + (await ab.select(a.select.target, a.select.value)).slice(0,600));
    else if (a.find)  console.log("== find ==\n" + (await ab.snapshot({ find: a.find })).slice(0, 2500));
  } catch (e) { console.log("!! " + (e && e.message ? e.message : String(e))); }
}
await ab.close();
