// Diagnose "nothing happens" on GitHub Pages
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "public");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

const issues = [];

// Check 1: ES module + Firebase CDN imports
const usesESM = js.includes('import {') && js.includes('firebase');
const usesModule = html.includes('type="module"');
if (usesESM && !usesModule) {
  issues.push("🔴 CRITICAL: app.js uses ES module imports but index.html doesn't have type=\"module\" — script won't load");
} else if (usesESM && usesModule) {
  // OK
}

// Check 2: firebaseConfig
const cfgMatch = js.match(/firebaseConfig\s*=\s*\{[\s\S]*?\}/);
if (cfgMatch) {
  const cfg = cfgMatch[0];
  const projectId = cfg.match(/projectId:\s*["']([^"']+)["']/);
  const apiKey = cfg.match(/apiKey:\s*["']([^"']+)["']/);
  const authDomain = cfg.match(/authDomain:\s*["']([^"']+)["']/);
  issues.push(`Firebase config: projectId=${projectId ? projectId[1] : "MISSING"}, authDomain=${authDomain ? authDomain[1] : "MISSING"}, apiKey=${apiKey ? apiKey[1].slice(0, 10) + "..." : "MISSING"}`);
}

// Check 3: hardcoded admin fallback
const adminMatch = js.match(/user\.email\s*===\s*['"]([^'"]+)['"]/);
if (adminMatch) {
  issues.push(`🟡 Hardcoded admin email fallback: ${adminMatch[1]} — users with different emails get denied unless they have admin custom claim`);
}

// Check 4: isAdmin check
const isAdminFn = js.match(/isAdmin\s*=\s*([^=]+?)\s*===?\s*true/);
if (isAdminFn) {
  issues.push(`🟡 isAdmin requires: token.claims.admin === true — user needs Firebase custom claim set`);
}

// Check 5: Firestore rules
const rules = fs.readFileSync(path.resolve(__dirname, "..", "..", "firestore.rules"), "utf8");
const rulesAdmin = rules.match(/function\s+isAdmin\(\)\s*\{[\s\S]*?\}/);
if (rulesAdmin) {
  issues.push(`Firestore rules isAdmin: ${rulesAdmin[0].replace(/\s+/g, " ").trim()}`);
}

// Check 6: GitHub Pages deployment files
const ghDir = path.resolve(__dirname, "..", "..", ".github");
const ghWorkflows = fs.existsSync(ghDir) ? fs.readdirSync(path.join(ghDir, "workflows")) : [];
issues.push(`GitHub workflows present: ${ghWorkflows.join(", ") || "none"}`);

// Check 7: index.html on GitHub Pages
const htmlDir = path.resolve(__dirname, "..", "public");
const hasIndex = fs.existsSync(path.join(htmlDir, "index.html"));
const has404 = fs.existsSync(path.join(htmlDir, "404.html"));
issues.push(`index.html in public/: ${hasIndex ? "yes" : "NO"}, 404.html: ${has404 ? "yes" : "NO"}`);

// Check 8: ESM script
const scriptTag = html.match(/<script[^>]*src=["']app\.js["'][^>]*>/);
if (scriptTag) {
  issues.push(`App script tag: ${scriptTag[0]}`);
}

// Check 9: any obvious JS syntax issues
try {
  // Strip imports because they need module loader, then try to parse
  const stripped = js.replace(/import\s+[\s\S]*?from\s+["'][^"']+["'];/g, "");
  new Function(stripped);
  issues.push("✅ JS syntax: parses without errors");
} catch (e) {
  issues.push(`🔴 JS syntax error: ${e.message}`);
}

// Check 10: are there any required elements missing from HTML?
const requiredSelectors = ["#login-view", "#dashboard-view", "#login-form", "#admin-email", "#admin-password", "#btn-login"];
const missing = requiredSelectors.filter((sel) => !html.includes(sel));
if (missing.length > 0) {
  issues.push(`🔴 Missing required elements: ${missing.join(", ")}`);
} else {
  issues.push("✅ All required HTML elements present");
}

// Check 11: Chart.js & Lucide loaded?
const hasChart = html.includes("chart.js") || html.includes("Chart.js");
const hasLucide = html.includes("lucide");
issues.push(`Charts (Chart.js): ${hasChart ? "yes" : "NO"}, Icons (Lucide): ${hasLucide ? "yes" : "NO"}`);

console.log("=== DIAGNOSTIC REPORT ===\n");
issues.forEach((i) => console.log("• " + i));
