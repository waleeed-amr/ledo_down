// Deeper analysis: confirm dead IDs and find inline data flows
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "public");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

const deadIds = [
  "account-verified", "acct-preview-bio", "acct-preview-handle", "acct-preview-handled",
  "acct-preview-name", "acct-preview-rating", "acct-preview-resolved", "avatar-upload-btn",
  "email-verified-pill", "g", "health-announcements", "health-auth", "health-firestore",
  "health-updates", "health-users", "login-error", "profile-email", "profile-location",
  "profile-name", "profile-phone", "profile-timezone", "profile-username", "profile-website",
  "pwd-strength", "range-seg", "sessions-list", "social-discord", "social-github",
  "social-instagram", "social-linkedin", "social-twitter", "social-youtube",
  "status-filters", "theme-seg", "tickets-table", "tokens-list",
];

// Look for each ID with various reference patterns
const verifyDead = {};
deadIds.forEach((id) => {
  const patterns = [
    new RegExp('\\b' + id.replace(/[-]/g, "[-]") + '\\b', 'g'),
    new RegExp('id\\s*=\\s*["\']' + id + '["\']', 'g'),
  ];
  const jsMatches = [];
  patterns.forEach((p) => {
    let m;
    while ((m = p.exec(js)) !== null) {
      const start = Math.max(0, m.index - 40);
      const end = Math.min(js.length, m.index + 80);
      jsMatches.push(js.substring(start, end).replace(/\s+/g, " ").trim());
    }
  });
  verifyDead[id] = {
    jsRefCount: jsMatches.length,
    samples: [...new Set(jsMatches)].slice(0, 3),
  };
});

// Also check for HTML element usage patterns I might have missed
// e.g. `input[id*="profile-"]`, querySelectorAll on form children, etc.
const loosePatterns = [
  /\[\w+\*\s*=\s*["'][^"']*["']\]/g,           // attribute wildcards
  /getElementsByTagName\s*\(\s*["']\w+["']/g,  // tag-based selection
  /closest\s*\(\s*["'][^"']+["']\)/g,           // closest selectors
  /\$\([^)]+\)\.find\s*\(\s*["'][^"']+["']/g,  // .find selectors
  /elements\s*\[\s*["'][^"']+["']\s*\]/g,      // elements["x"]
];

const looseMatches = {};
loosePatterns.forEach((p) => {
  let m;
  while ((m = p.exec(js)) !== null) {
    const match = m[0];
    Object.keys(looseMatches).length < 30 && (looseMatches[m.index] = match);
  }
});

// Find HTML form structure - any inputs in <form id="..."> that get submitted?
const formStructure = [];
const formRegex = /<form[^>]*id\s*=\s*["']([\w-]+)["'][^>]*>([\s\S]*?)<\/form>/g;
let m;
while ((m = formRegex.exec(html)) !== null) {
  const formId = m[1];
  const inner = m[2];
  const inputIds = [];
  const inputRegex = /\bid\s*=\s*["']([\w-]+)["']/g;
  let im;
  while ((im = inputRegex.exec(inner)) !== null) inputIds.push(im[1]);
  formStructure.push({ formId, inputIds });
}

// Find HTML elements that look like data-bind targets but are never updated
const dataBindCandidates = [
  "bio-count", "week-handled", "week-resolved", "week-replies", "week-avg",
  "perf-response", "perf-resolve", "perf-users", "perf-today",
  "account-display-name", "account-email-display", "account-joined",
  "account-location", "save-indicator", "my-activity-feed",
  "top-subjects", "modal-status-pill", "modal-subject", "modal-email",
  "modal-time", "modal-userid", "modal-chat-history", "modal-reply",
  "modal-user-name", "modal-user-email", "modal-user-created",
  "modal-user-lastseen", "modal-user-id", "modal-user-tickets-count",
  "modal-user-crashes-count", "modal-user-version", "modal-user-status-pill",
  "admin-avatar", "admin-name", "admin-role", "tickets-count",
  "tickets-summary", "live-update-preview", "release-history-list",
  "public-website-url", "public-support-url", "public-privacy-url",
  "public-terms-url", "announcements-list", "crash-modal-title",
  "crash-modal-time", "crash-modal-device", "crash-modal-domain",
  "crash-modal-message", "crash-modal-stack", "crash-modal-context",
  "users-grid", "recent-activity",
];

const dataBindStatus = {};
dataBindCandidates.forEach((id) => {
  const re = new RegExp('\\b' + id.replace(/[-]/g, "[-]") + '\\b', 'g');
  const matches = (js.match(re) || []).length;
  dataBindStatus[id] = { jsRefCount: matches };
});

const result = {
  deadIdsVerification: verifyDead,
  formStructure,
  dataBindStatus,
};
console.log(JSON.stringify(result, null, 2));
