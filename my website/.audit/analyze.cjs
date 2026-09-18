// Audit script: find dead UI, mock data, unused code in my website
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "public");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");

const out = {};

// 1) IDs declared in HTML
const htmlIds = new Set();
const idRegex = /\bid\s*=\s*["']([^"']+)["']/g;
let m;
while ((m = idRegex.exec(html)) !== null) htmlIds.add(m[1]);
out.htmlIdCount = htmlIds.size;

// 2) class= attribute usage in HTML (unique classes)
const htmlClasses = new Set();
const classRegex = /\bclass\s*=\s*["']([^"']+)["']/g;
while ((m = classRegex.exec(html)) !== null) {
  m[1].split(/\s+/).filter(Boolean).forEach((c) => htmlClasses.add(c));
}
out.htmlClassCount = htmlClasses.size;

// 3) data-* attribute usage in HTML
const htmlDataAttrs = new Set();
const dataRegex = /\bdata-([a-zA-Z0-9-]+)(?:\s*=\s*["']([^"']*)["'])?/g;
while ((m = dataRegex.exec(html)) !== null) htmlDataAttrs.add(m[1] + (m[2] !== undefined ? "=" + m[2] : ""));
out.htmlDataAttrsCount = htmlDataAttrs.size;

// 4) IDs referenced from JS (covers $("#x"), $$("..."), getElementById, querySelector)
const jsIds = new Set();
const refs = [
  /\$\(\s*["']#([\w-]+)["']/g,
  /\$\$\(\s*["']#([\w-]+)["']/g,
  /getElementById\(\s*["']([\w-]+)["']/g,
  /querySelector(?:All)?\(\s*["'][^"']*#([\w-]+)/g,
];
refs.forEach((r) => {
  while ((m = r.exec(js)) !== null) jsIds.add(m[1]);
});
out.jsIdRefCount = jsIds.size;

// 5) classes referenced from JS
const jsClasses = new Set();
const classRefs = [
  /\$\(\s*["']\.([\w-]+)/g,
  /\$\$\(\s*["']\.([\w-]+)/g,
  /querySelector(?:All)?\(\s*["'][^"']*\.([\w-]+)/g,
];
classRefs.forEach((r) => {
  while ((m = r.exec(js)) !== null) jsClasses.add(m[1]);
});
out.jsClassRefCount = jsClasses.size;

// 6) event handlers referenced from JS
const jsEvents = new Set();
const evRegex = /\$\(\s*["']#([\w-]+)["'][^)]*\)\.on(?:ce)?\s*=\s*["']?(\w+)/g;
while ((m = evRegex.exec(js)) !== null) jsEvents.add(m[1] + ":" + m[2]);

const addEvId = /\$\(\s*["']#([\w-]+)["'][^)]*\)\s*\.addEventListener\(\s*["'](\w+)/g;
while ((m = addEvId.exec(js)) !== null) jsEvents.add(m[1] + ":" + m[2]);

const addEvClass = /\$\(\s*["']\.([\w-]+)["'][^)]*\)\s*\.addEventListener\(\s*["'](\w+)/g;
const jsClassEvents = new Set();
while ((m = addEvClass.exec(js)) !== null) jsClassEvents.add(m[1] + ":" + m[2]);

// 7) data- attribute referenced from JS
const jsDataAttrs = new Set();
const dataRefs = [
  /\$\(\s*["']\[data-([\w-]+)/g,
  /\$\(\s*["']\[data-([\w-]+)=["']([^"']*)["']/g,
  /dataset\.([\w-]+)/g,
];
dataRefs.forEach((r) => {
  while ((m = r.exec(js)) !== null) jsDataAttrs.add(m[1] + (m[2] !== undefined ? "=" + m[2] : ""));
});

// 8) HTML inline event handlers
const htmlEvents = new Set();
const htmlEvRegex = /\bon([a-z]+)\s*=\s*["']([^"']*)["']/g;
while ((m = htmlEvRegex.exec(html)) !== null) htmlEvents.add(m[1] + ":" + m[2]);

// 9) HTML buttons/inputs/forms with no JS handler bound (just declared)
const htmlButtons = new Set();
const btnRegex = /<(button|input|select|textarea|form|a)\b[^>]*\bid\s*=\s*["']([\w-]+)["'][^>]*/g;
while ((m = btnRegex.exec(html)) !== null) {
  htmlButtons.add(m[2] + ":" + m[1]);
}

// === DIFFS ===
// IDs in HTML but NEVER referenced in JS
const deadIds = [...htmlIds].filter((id) => !jsIds.has(id)).sort();

// IDs in JS but NOT in HTML
const orphanIds = [...jsIds].filter((id) => !htmlIds.has(id)).sort();

// Classes in HTML but NOT in JS AND NOT in CSS
const cssClasses = new Set();
const cssClassRegex = /\.([a-zA-Z][\w-]*)/g;
while ((m = cssClassRegex.exec(css)) !== null) cssClasses.add(m[1]);

const deadClasses = [...htmlClasses].filter((c) => !jsClasses.has(c) && !cssClasses.has(c)).sort();

// === MOCK / SAMPLE / DEMO DATA ===
// Look for arrays/objects with realistic-looking fake data
const fakePatterns = [
  /\b(MOCK|mock|DUMMY|dummy|FAKE|fake|SAMPLE|sample|DEMO|demo|PLACEHOLDER|placeholder|TEMP|temp)[\w]*\s*[=:]/g,
  /const\s+(?:MOCK|FAKE|SAMPLE|DEMO|PLACEHOLDER)[\w]*\s*=\s*[\[\{]/g,
  /\/\/\s*(?:TODO|FIXME|HACK|XXX|MOCK|REMOVE|DEAD)/gi,
];

const mockHits = [];
fakePatterns.forEach((r) => {
  while ((m = r.exec(js)) !== null) {
    const start = Math.max(0, m.index - 30);
    const end = Math.min(js.length, m.index + 100);
    mockHits.push({
      pattern: r.source,
      snippet: js.substring(start, end).replace(/\s+/g, " ").trim(),
    });
  }
});

// Suspicious hardcoded data patterns
const hardcoded = [];

// Strings that look like real names
const nameMatches = js.match(/\b(?:Ahmed|Mohamed|Mostafa|Sara|Waleed|Fatma|Aisha|admin|Admin)\b/g) || [];
if (nameMatches.length > 0) hardcoded.push({ kind: "names", count: nameMatches.length, samples: [...new Set(nameMatches)].slice(0, 5) });

// Fake email patterns
const emailMatches = js.match(/["'][a-zA-Z0-9._-]+@(?:example|gmail|yahoo|hotmail|ledo)[a-zA-Z0-9._-]*\.[a-z]{2,}["']/g) || [];
if (emailMatches.length > 0) hardcoded.push({ kind: "emails", count: emailMatches.length, samples: [...new Set(emailMatches)].slice(0, 5) });

// Demo subject lines / ticket messages
const subjMatches = js.match(/["'](?:[Tt]icket [Tt]est|Sample ticket|Demo ticket|Test ticket|Lorem ipsum)[^"']*["']/g) || [];
if (subjMatches.length > 0) hardcoded.push({ kind: "ticket-subjects", count: subjMatches.length, samples: [...new Set(subjMatches)].slice(0, 5) });

// Numeric demo stats
const numDemoMatches = js.match(/\b(?:1[0-9]{2,3}|9[0-9]{2})\s*(?:users|tickets|crashes|reports)\b/gi) || [];
if (numDemoMatches.length > 0) hardcoded.push({ kind: "demo-numbers", count: numDemoMatches.length, samples: [...new Set(numDemoMatches)].slice(0, 5) });

// Lorem ipsum
const lorem = (html + js + css).match(/lorem ipsum/gi) || [];
if (lorem.length > 0) hardcoded.push({ kind: "lorem", count: lorem.length });

// === UNUSED JS FUNCTIONS (declared but never called) ===
// Crude: extract `function name(` and `const name = (...)` and check occurrence count
const fnNames = new Set();
const fnRegex = /\bfunction\s+([a-zA-Z_]\w*)\s*\(/g;
while ((m = fnRegex.exec(js)) !== null) fnNames.add(m[1]);

const arrowFnNames = new Set();
const arrowRegex = /\bconst\s+([a-zA-Z_]\w*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g;
while ((m = arrowRegex.exec(js)) !== null) arrowFnNames.add(m[1]);

const unusedFunctions = [];
[...fnNames, ...arrowFnNames].forEach((n) => {
  // Skip common false-positive names
  if (["refreshIcons", "initIcons", "initTheme", "initPrefs", "initAuth", "showLogin", "showDashboard", "navigateTo"].includes(n)) return;
  // Count occurrences (definition + calls)
  const defRegex = new RegExp("\\b" + n.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "\\b", "g");
  const count = (js.match(defRegex) || []).length;
  if (count <= 1) {
    unusedFunctions.push({ name: n, kind: fnNames.has(n) ? "function" : "arrow" });
  }
});

// === UNUSED CSS CLASSES (declared in CSS but not used in HTML or JS) ===
const unusedCssClasses = [...cssClasses].filter((c) => !htmlClasses.has(c) && !jsClasses.has(c)).sort();

// === REPORT ===
out.summary = {
  htmlIds: htmlIds.size,
  jsIdRefs: jsIds.size,
  deadIdsCount: deadIds.length,
  orphanIdsCount: orphanIds.length,
  htmlClasses: htmlClasses.size,
  cssClasses: cssClasses.size,
  deadClassesCount: deadClasses.length,
  unusedCssClassesCount: unusedCssClasses.length,
  unusedFunctionsCount: unusedFunctions.length,
  mockHitsCount: mockHits.length,
  hardcodedKinds: hardcoded.length,
};

out.deadIds = deadIds;
out.orphanIds = orphanIds;
out.deadClasses = deadClasses;
out.unusedCssClasses = unusedCssClasses.slice(0, 50); // cap
out.unusedFunctions = unusedFunctions;
out.mockHits = mockHits.slice(0, 30);
out.hardcoded = hardcoded;
out.htmlButtonsCount = htmlButtons.size;
out.htmlEvents = [...htmlEvents];
out.jsClassEvents = [...jsClassEvents];

console.log(JSON.stringify(out, null, 2));
