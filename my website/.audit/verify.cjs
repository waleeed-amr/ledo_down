// Better audit: account for template literals, string concatenation
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "public");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

const htmlIds = new Set();
const idRegex = /\bid\s*=\s*["']([^"']+)["']/g;
let m;
while ((m = idRegex.exec(html)) !== null) htmlIds.add(m[1]);

// Strip comments and strings, then look for ID usage in templates
const jsStripped = js
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/.*$/gm, " ")
  .replace(/`(?:\\.|[^`\\])*`/g, (s) => " " + s.replace(/[a-zA-Z][\w-]*/g, " ") + " ");

function refedByJs(id) {
  // Direct lookup
  const direct = new RegExp(`\\$\\(\\s*["']#${id.replace(/[-]/g, "[-]")}["']`, "g");
  if (direct.test(js)) return "direct";
  const direct2 = new RegExp(`getElementById\\(\\s*["']${id.replace(/[-]/g, "[-]")}["']`, "g");
  if (direct2.test(js)) return "getElementById";
  // In CSS selector pattern
  const inSel = new RegExp(`["'][^"']*#${id.replace(/[-]/g, "[-]")}`, "g");
  if (inSel.test(js)) return "in-selector";
  // Template literal `#{...}` or "+#" + id
  const templ = new RegExp(`[#]\\$\\{[^}]*${id.replace(/[-]/g, "[-]")}`, "g");
  if (templ.test(js)) return "template-var";
  const concat = new RegExp(`["']\\s*\\+\\s*["']${id.replace(/[-]/g, "[-]")}|["']${id.replace(/[-]/g, "[-]")}["']\\s*\\+`, "g");
  if (concat.test(js)) return "concat";
  // attribute selector with data-
  const dataRef = new RegExp(`data-${id.replace(/[-]/g, "[-]")}|${id.replace(/[-]/g, "[-]")}\\s*:`, "g");
  if (dataRef.test(js)) return "data-attr";
  // querySelector / closest / find
  const sel = new RegExp(`["'][^"']*[#.]${id.replace(/[-]/g, "[-]")}`, "g");
  if (sel.test(js)) return "querySelector";
  return null;
}

const deadIds = [];
const aliveIds = [];
htmlIds.forEach((id) => {
  const ref = refedByJs(id);
  if (ref) aliveIds.push({ id, ref });
  else deadIds.push(id);
});

console.log("=== TRULY DEAD IDs (HTML only, no JS reference) ===");
deadIds.sort().forEach((id) => console.log("  - " + id));

console.log("\n=== ALIVE IDs (referenced from JS) ===");
aliveIds.sort((a, b) => a.id.localeCompare(b.id)).forEach(({ id, ref }) => console.log(`  ✓ ${id}  (${ref})`));

console.log("\n=== TOTAL ===");
console.log(`Dead: ${deadIds.length}`);
console.log(`Alive: ${aliveIds.length}`);
