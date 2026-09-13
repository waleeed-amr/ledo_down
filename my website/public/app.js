// =============================================================
// LEDO · COMMAND CENTER
// Premium admin dashboard application
// =============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  setPersistence,
  browserLocalPersistence,
  inMemoryPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  doc,
  updateDoc,
  addDoc,
  setDoc,
  serverTimestamp,
  getDocs,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ============== CONFIG ==============
const firebaseConfig = {
  apiKey: "AIzaSyBWZx5WdJ8dJoI8nZlU1eA-OnOk91gj8Xk",
  authDomain: "group-a0ee4.firebaseapp.com",
  projectId: "group-a0ee4",
  storageBucket: "group-a0ee4.firebasestorage.app",
  messagingSenderId: "519444570577",
  appId: "1:519444570577:web:3a55d7010192e2ac2740f0",
  measurementId: "G-9TXCQ06MJM",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ============== STATE ==============
const state = {
  tickets: [],
  crashes: [],
  currentUser: null,
  currentRoute: "overview",
  statusFilter: "all",
  searchQuery: "",
  userSort: "tickets",
  userSearch: "",
  ticketsRange: 14,
  selectedTicket: null,
  charts: {},
  unsubscribers: [],
  firstTicketsLoad: true,
  firstCrashesLoad: true,
  account: {
    profile: null,
    preferences: null,
    notifications: null,
    saving: false,
  },
  myActivity: [],
};

// ============== DOM HELPERS ==============
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmt = {
  date(ts) {
    if (!ts) return "—";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  },
  timeAgo(ts) {
    if (!ts) return "—";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString();
  },
  initials(str) {
    if (!str) return "?";
    const parts = str.split(/[\s@.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return str.slice(0, 2).toUpperCase();
  },
  emailLocal(email) {
    if (!email) return "—";
    return email.split("@")[0] || email;
  },
  escape(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },
};

// ============== TOAST ==============
const TOAST_ICONS = {
  success: "check",
  error: "alert-circle",
  warning: "alert-triangle",
  info: "info",
};

function toast({ title = "", message = "", type = "info", duration = 3500 }) {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `
    <div class="toast-icon"><i data-lucide="${TOAST_ICONS[type] || "info"}"></i></div>
    <div class="toast-body">
      ${title ? `<div class="toast-title">${fmt.escape(title)}</div>` : ""}
      ${message ? `<div class="toast-msg">${fmt.escape(message)}</div>` : ""}
    </div>
    <button class="toast-close" aria-label="Dismiss"><i data-lucide="x"></i></button>
  `;
  root.appendChild(el);
  refreshIcons();
  const remove = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 300);
  };
  $(".toast-close", el).addEventListener("click", remove);
  setTimeout(remove, duration);
}

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

// ============== ICONS ==============
function initIcons() {
  refreshIcons();
}

// ============== THEME ==============
function initTheme() {
  const saved = localStorage.getItem("ledo-theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  updateThemeUI(saved);
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("ledo-theme", theme);
  updateThemeUI(theme);
  // Re-render charts with new colors
  renderAllCharts();
}

function updateThemeUI(theme) {
  $$("#theme-seg .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.theme === theme);
  });
  const icon = $("#theme-toggle i");
  if (icon) {
    icon.setAttribute("data-lucide", theme === "dark" ? "sun" : "moon");
    refreshIcons();
  }
}

// ============== COMPACT / ANIM ==============
function initPrefs() {
  const compact = localStorage.getItem("ledo-compact") === "1";
  const anim = localStorage.getItem("ledo-anim") !== "0";
  if (compact) {
    document.body.classList.add("compact");
    $("#compact-mode").checked = true;
  }
  if (!anim) {
    document.body.classList.add("no-anim");
    $("#anim-toggle").checked = false;
  }
}

// ============== AUTH ==============
async function initAuth() {
  // Use in-memory persistence if "remember me" is unchecked
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      state.currentUser = user;
      showDashboard();
      updateAdminInfo();
      await loadAllData();
    } else {
      state.currentUser = null;
      showLogin();
      cleanupListeners();
    }
  });
}

function showLogin() {
  $("#login-view").hidden = false;
  $("#dashboard-view").hidden = true;
  setTimeout(() => $("#admin-email")?.focus(), 100);
}

function showDashboard() {
  $("#login-view").hidden = true;
  $("#dashboard-view").hidden = false;
  refreshIcons();
  navigateTo(state.currentRoute);
  setupAccount();
}

function updateAdminInfo() {
  if (!state.currentUser) return;
  const name = state.currentUser.displayName || fmt.emailLocal(state.currentUser.email) || "Admin";
  const initial = name.charAt(0).toUpperCase();
  $("#admin-avatar").textContent = initial;
  $("#admin-name").textContent = name;
  $("#admin-role").textContent = state.currentUser.email || "Administrator";
  $("#settings-avatar").textContent = initial;
  $("#settings-name").textContent = name;
  $("#settings-email").textContent = state.currentUser.email || "—";
}

async function login(email, password, remember) {
  try {
    await setPersistence(auth, remember ? browserLocalPersistence : inMemoryPersistence);
    await signInWithEmailAndPassword(auth, email, password);
    toast({ type: "success", title: "Welcome back", message: "Signed in successfully" });
  } catch (e) {
    let msg = "Invalid email or password.";
    if (e.code === "auth/invalid-email") msg = "Please enter a valid email.";
    if (e.code === "auth/too-many-requests") msg = "Too many attempts. Try again later.";
    if (e.code === "auth/network-request-failed") msg = "Network error. Check your connection.";
    toast({ type: "error", title: "Sign in failed", message: msg });
    throw e;
  }
}

async function logout() {
  try {
    cleanupListeners();
    await signOut(auth);
    toast({ type: "info", title: "Signed out", message: "See you soon!" });
  } catch (e) {
    console.error(e);
    toast({ type: "error", title: "Sign out failed", message: e.message });
  }
}

// ============== ROUTER ==============
function navigateTo(route) {
  state.currentRoute = route;
  $$(".route").forEach((el) => {
    el.hidden = el.dataset.route !== route;
  });
  $$(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.route === route);
  });
  const titles = {
    overview: ["Overview", "Welcome back — here's what's happening today"],
    tickets: ["Tickets", "Manage and respond to user support tickets"],
    users: ["Users", "All users who have contacted support"],
    crashes: ["Crash Reports", "Application crash telemetry"],
    analytics: ["Analytics", "Insights and platform performance"],
    account: ["My Account", "Manage your profile, security, and preferences"],
    settings: ["Settings", "Customize your admin experience"],
  };
  const [t, s] = titles[route] || ["Ledo", ""];
  $("#page-title").textContent = t;
  $("#page-sub").textContent = s;
  if (location.hash !== `#${route}`) {
    history.replaceState(null, "", `#${route}`);
  }
  // Close mobile sidebar
  $("#sidebar")?.classList.remove("open");
}

function initRouter() {
  $$(".nav-item, [data-route]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const route = el.dataset.route;
      if (!route) return;
      e.preventDefault();
      navigateTo(route);
    });
  });
  window.addEventListener("hashchange", () => {
    const route = location.hash.replace("#", "") || "overview";
    navigateTo(route);
  });
  const initial = location.hash.replace("#", "") || "overview";
  navigateTo(initial);
}

// ============== DATA ==============
function cleanupListeners() {
  state.unsubscribers.forEach((u) => u && u());
  state.unsubscribers = [];
  state.tickets = [];
  state.crashes = [];
  state.firstTicketsLoad = true;
  state.firstCrashesLoad = true;
}

async function loadAllData() {
  subscribeTickets();
  subscribeCrashes();
}

function subscribeTickets() {
  if (!state.currentUser) return;
  const q = query(collection(db, "chats"), orderBy("lastUpdated", "desc"), limit(500));
  const unsub = onSnapshot(
    q,
    (snapshot) => {
      state.tickets = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.firstTicketsLoad = false;
      onTicketsUpdate();
    },
    (err) => {
      console.error("Tickets error:", err);
      if (err.code === "permission-denied") {
        toast({
          type: "error",
          title: "Permission denied",
          message: "Your account doesn't have admin access. Update Firestore rules or sign in as admin.",
          duration: 7000,
        });
      } else {
        toast({ type: "error", title: "Failed to load tickets", message: err.message });
      }
      state.firstTicketsLoad = false;
      onTicketsUpdate();
    }
  );
  state.unsubscribers.push(unsub);
}

function subscribeCrashes() {
  if (!state.currentUser) return;
  const q = query(collection(db, "crash_reports"), orderBy("createdAt", "desc"), limit(200));
  const unsub = onSnapshot(
    q,
    (snapshot) => {
      state.crashes = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.firstCrashesLoad = false;
      onCrashesUpdate();
    },
    (err) => {
      console.error("Crashes error:", err);
      state.firstCrashesLoad = false;
      onCrashesUpdate();
    }
  );
  state.unsubscribers.push(unsub);
}

function onTicketsUpdate() {
  renderKpis();
  renderRecentActivity();
  renderTickets();
  renderUsers();
  renderAnalytics();
  renderTopSubjects();
  renderNotifications();
  renderPersonalStats();
  if (state.currentRoute === "activity" || state.currentRoute === "account") {
    loadMyActivity();
    renderMyActivity();
  }
  if (state.charts.timeline) updateTimelineChart();
  if (state.charts.status) updateStatusChart();
  if (state.charts.daily) updateDailyChart();
  if (state.charts.myActivity) renderMyActivityChart();
}

function onCrashesUpdate() {
  renderCrashes();
}

// ============== KPIs ==============
function renderKpis() {
  const stats = {
    total: state.tickets.length,
    open: state.tickets.filter((t) => (t.status || "open") === "open").length,
    progress: state.tickets.filter((t) => t.status === "in_progress").length,
    resolved: state.tickets.filter((t) => t.status === "resolved").length,
  };
  $$("[data-kpi]").forEach((el) => {
    const key = el.dataset.kpi;
    animateNumber(el, stats[key] || 0);
  });
  // Update chip counts
  $$("[data-count]").forEach((el) => {
    const key = el.dataset.count;
    el.textContent = stats[key] || 0;
  });
  $("#tickets-count").textContent = stats.open;
}

function animateNumber(el, target) {
  const current = parseInt(el.textContent.replace(/\D/g, "")) || 0;
  if (current === target) return;
  const duration = 600;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(current + (target - current) * eased);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = target;
  };
  requestAnimationFrame(step);
}

// ============== RECENT ACTIVITY ==============
function renderRecentActivity() {
  const root = $("#recent-activity");
  if (state.firstTicketsLoad) return;
  const recent = state.tickets.slice(0, 5);
  if (recent.length === 0) {
    root.innerHTML = `<div class="muted center pad">No tickets yet. They'll appear here when users reach out.</div>`;
    return;
  }
  root.innerHTML = recent
    .map(
      (t) => `
      <div class="activity-row" data-ticket="${t.id}">
        <div class="activity-avatar">${fmt.escape(fmt.initials(t.email || "U"))}</div>
        <div class="activity-body">
          <div class="activity-title">${fmt.escape(t.subject || "Untitled")}</div>
          <div class="activity-meta">
            <span>${fmt.escape(t.email || "Anonymous")}</span>
            <span class="dot"></span>
            <span>${fmt.timeAgo(t.createdAt)}</span>
            <span class="dot"></span>
            <span class="status-badge ${fmt.escape(t.status || "open")}">${fmt.escape(
        (t.status || "open").replace("_", " ")
      )}</span>
          </div>
        </div>
        <i data-lucide="chevron-right" style="color:var(--muted)"></i>
      </div>
    `
    )
    .join("");
  refreshIcons();
  $$(".activity-row", root).forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.ticket;
      const ticket = state.tickets.find((t) => t.id === id);
      if (ticket) openTicketModal(ticket);
    });
  });
}

// ============== TICKETS ==============
function renderTickets() {
  const tbody = $("#tickets-tbody");
  if (state.firstTicketsLoad) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">Loading tickets…</td></tr>`;
    return;
  }
  const filter = state.statusFilter;
  const q = state.searchQuery.toLowerCase();
  let list = state.tickets.filter((t) => {
    if (filter !== "all" && (t.status || "open") !== filter) return false;
    if (!q) return true;
    return (
      (t.subject || "").toLowerCase().includes(q) ||
      (t.email || "").toLowerCase().includes(q) ||
      (t.message || "").toLowerCase().includes(q)
    );
  });
  $("#tickets-summary").textContent = `Showing ${list.length} of ${state.tickets.length} tickets`;

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">${
      state.tickets.length === 0
        ? "No tickets yet."
        : "No tickets match the current filters."
    }</td></tr>`;
    return;
  }

  tbody.innerHTML = list
    .map(
      (t) => `
      <tr data-ticket="${t.id}">
        <td><span class="status-badge ${fmt.escape(t.status || "open")}">
          <span class="dot dot-${getStatusDot(t.status)}"></span>
          ${fmt.escape((t.status || "open").replace("_", " "))}
        </span></td>
        <td>
          <div class="row-subject">${fmt.escape(t.subject || "Untitled")}</div>
          <div class="row-msg">${fmt.escape(t.message || "")}</div>
        </td>
        <td>
          <div class="row-user">
            <div class="row-avatar">${fmt.escape(fmt.initials(t.email || "U"))}</div>
            <div class="row-email">${fmt.escape(t.email || "—")}</div>
          </div>
        </td>
        <td><div class="row-time">${fmt.timeAgo(t.createdAt)}</div></td>
        <td class="t-right">
          <div class="row-actions">
            <button class="row-btn" data-action="view" title="View">
              <i data-lucide="eye"></i>
            </button>
            <button class="row-btn" data-action="reply" title="Reply">
              <i data-lucide="message-square"></i>
            </button>
          </div>
        </td>
      </tr>
    `
    )
    .join("");
  refreshIcons();

  $$("#tickets-tbody tr[data-ticket]").forEach((row) => {
    const id = row.dataset.ticket;
    const ticket = state.tickets.find((t) => t.id === id);
    if (!ticket) return;
    row.addEventListener("click", (e) => {
      const action = e.target.closest("[data-action]")?.dataset.action;
      if (action === "reply") {
        // focus reply
        openTicketModal(ticket, true);
      } else {
        openTicketModal(ticket);
      }
    });
  });
}

function getStatusDot(status) {
  if (status === "in_progress") return "progress";
  if (status === "resolved") return "resolved";
  return "open";
}

// ============== USERS ==============
function renderUsers() {
  const grid = $("#users-grid");
  if (state.firstTicketsLoad) return;
  const map = new Map();
  state.tickets.forEach((t) => {
    const key = t.userId || t.email || "anonymous";
    if (!map.has(key)) {
      map.set(key, {
        id: key,
        email: t.email || "Anonymous",
        tickets: 0,
        lastActivity: t.createdAt,
      });
    }
    const u = map.get(key);
    u.tickets++;
    if (t.createdAt && (!u.lastActivity || (t.createdAt.seconds || 0) > (u.lastActivity.seconds || 0))) {
      u.lastActivity = t.createdAt;
    }
  });
  let users = Array.from(map.values());
  const q = state.userSearch.toLowerCase();
  if (q) users = users.filter((u) => (u.email || "").toLowerCase().includes(q));
  if (state.userSort === "tickets") users.sort((a, b) => b.tickets - a.tickets);
  else if (state.userSort === "recent")
    users.sort(
      (a, b) => (b.lastActivity?.seconds || 0) - (a.lastActivity?.seconds || 0)
    );
  else if (state.userSort === "alpha")
    users.sort((a, b) => (a.email || "").localeCompare(b.email || ""));

  if (users.length === 0) {
    grid.innerHTML = `<div class="muted center pad" style="grid-column:1/-1">${
      state.tickets.length === 0
        ? "No users yet."
        : "No users match the current search."
    }</div>`;
    return;
  }

  grid.innerHTML = users
    .map(
      (u) => `
      <div class="user-card" data-user="${fmt.escape(u.id)}">
        <div class="row-avatar" style="width:50px;height:50px;font-size:18px;border-radius:14px">${fmt.escape(
          fmt.initials(u.email)
        )}</div>
        <div class="user-card-info">
          <div class="user-card-name">${fmt.escape(fmt.emailLocal(u.email))}</div>
          <div class="user-card-email">${fmt.escape(u.email)}</div>
        </div>
        <div class="user-card-stats">
          <div class="user-stat">
            <div class="user-stat-label">Tickets</div>
            <div class="user-stat-value">${u.tickets}</div>
          </div>
          <div class="user-stat">
            <div class="user-stat-label">Last seen</div>
            <div class="user-stat-value" style="font-size:13px">${fmt.timeAgo(u.lastActivity)}</div>
          </div>
        </div>
      </div>
    `
    )
    .join("");
  $$(".user-card", grid).forEach((card) => {
    card.addEventListener("click", () => {
      navigateTo("tickets");
    });
  });
}

// ============== CRASHES ==============
function renderCrashes() {
  const tbody = $("#crashes-tbody");
  if (state.firstCrashesLoad) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">Loading crash reports…</td></tr>`;
    return;
  }
  if (state.crashes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">No crash reports. 🎉</td></tr>`;
    return;
  }
  tbody.innerHTML = state.crashes
    .map(
      (c) => `
      <tr>
        <td><div class="row-time">${fmt.timeAgo(c.createdAt)}</div></td>
        <td><div class="row-email">${fmt.escape(c.email || "—")}</div></td>
        <td><div class="row-subject">${fmt.escape(c.subject || "—")}</div></td>
        <td><div class="row-msg" style="max-width:340px; cursor:pointer; transition: all 0.2s;" title="Click to expand/collapse" onclick="if(this.style.whiteSpace==='pre-wrap'){this.style.whiteSpace='nowrap';this.style.maxWidth='340px'}else{this.style.whiteSpace='pre-wrap';this.style.maxWidth='none'}">${fmt.escape(c.message || "—")}</div></td>
      </tr>
    `
    )
    .join("");
}

// ============== ANALYTICS ==============
function renderAnalytics() {
  // resolution rate
  const total = state.tickets.length;
  const resolved = state.tickets.filter((t) => t.status === "resolved").length;
  const rate = total ? Math.round((resolved / total) * 100) : 0;
  $("#perf-resolve").textContent = `${rate}%`;
  // unique users
  const users = new Set(state.tickets.map((t) => t.userId || t.email).filter(Boolean));
  $("#perf-users").textContent = users.size;
  // tickets today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = state.tickets.filter((t) => {
    const d = t.createdAt?.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
    return d >= todayStart;
  }).length;
  $("#perf-today").textContent = today;
  // response time (avg from open to first reply / status change) — placeholder
  $("#perf-response").textContent = "—";
}

function renderTopSubjects() {
  const root = $("#top-subjects");
  if (!root) return;
  if (state.firstTicketsLoad) return;
  const counts = new Map();
  state.tickets.forEach((t) => {
    const sub = (t.subject || "Untitled").trim();
    counts.set(sub, (counts.get(sub) || 0) + 1);
  });
  const top = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const max = top[0]?.[1] || 1;
  if (top.length === 0) {
    root.innerHTML = `<div class="muted center pad">No data yet</div>`;
    return;
  }
  root.innerHTML = top
    .map(
      ([sub, count]) => `
      <div class="bar-item">
        <div class="bar-head">
          <div class="bar-name">${fmt.escape(sub)}</div>
          <div class="bar-val">${count}</div>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width: ${(count / max) * 100}%"></div></div>
      </div>
    `
    )
    .join("");
}

// ============== CHARTS ==============
function getChartTheme() {
  const theme = document.documentElement.getAttribute("data-theme");
  if (theme === "light") {
    return {
      text: "#475569",
      grid: "rgba(15,23,42,0.08)",
      bg: "transparent",
    };
  }
  return {
    text: "#8b91a7",
    grid: "rgba(255,255,255,0.06)",
    bg: "transparent",
  };
}

function getGradient(ctx, color1, color2) {
  const gradient = ctx.createLinearGradient(0, 0, 0, 280);
  gradient.addColorStop(0, color1);
  gradient.addColorStop(1, color2);
  return gradient;
}

function buildTimelineData(range) {
  const days = range;
  const buckets = new Array(days).fill(0);
  const labels = [];
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    labels.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  }
  state.tickets.forEach((t) => {
    if (!t.createdAt) return;
    const d = t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
    const daysAgo = Math.floor((now - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (daysAgo >= 0 && daysAgo < days) {
      buckets[days - 1 - daysAgo]++;
    }
  });
  return { labels, data: buckets };
}

function renderTimelineChart() {
  const ctx = $("#chart-timeline")?.getContext("2d");
  if (!ctx) return;
  const theme = getChartTheme();
  const { labels, data } = buildTimelineData(state.ticketsRange);
  const gradient = getGradient(ctx, "rgba(99,102,241,0.4)", "rgba(99,102,241,0)");
  const gradient2 = getGradient(ctx, "rgba(236,72,153,0.4)", "rgba(236,72,153,0)");
  if (state.charts.timeline) state.charts.timeline.destroy();
  state.charts.timeline = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Open",
          data,
          borderColor: "#6366f1",
          backgroundColor: gradient,
          borderWidth: 2.5,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: "#6366f1",
          pointHoverBorderColor: "#fff",
          pointHoverBorderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0b0d1a",
          titleColor: "#f1f3f9",
          bodyColor: "#c6cad8",
          borderColor: "rgba(255,255,255,0.1)",
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          displayColors: false,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: theme.text, font: { size: 11 } },
          border: { display: false },
        },
        y: {
          grid: { color: theme.grid, drawBorder: false },
          ticks: { color: theme.text, font: { size: 11 }, stepSize: 1 },
          border: { display: false },
          beginAtZero: true,
        },
      },
    },
  });
}

function updateTimelineChart() {
  if (!state.charts.timeline) return;
  const { labels, data } = buildTimelineData(state.ticketsRange);
  state.charts.timeline.data.labels = labels;
  state.charts.timeline.data.datasets[0].data = data;
  state.charts.timeline.update("none");
}

function renderStatusChart() {
  const ctx = $("#chart-status")?.getContext("2d");
  if (!ctx) return;
  const theme = getChartTheme();
  const counts = {
    open: state.tickets.filter((t) => (t.status || "open") === "open").length,
    in_progress: state.tickets.filter((t) => t.status === "in_progress").length,
    resolved: state.tickets.filter((t) => t.status === "resolved").length,
  };
  if (state.charts.status) state.charts.status.destroy();
  state.charts.status = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Open", "In Progress", "Resolved"],
      datasets: [
        {
          data: [counts.open, counts.in_progress, counts.resolved],
          backgroundColor: ["#f59e0b", "#06b6d4", "#10b981"],
          borderColor: "transparent",
          borderWidth: 0,
          hoverOffset: 8,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "70%",
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: theme.text,
            padding: 14,
            usePointStyle: true,
            pointStyle: "circle",
            font: { size: 12, family: "Outfit" },
          },
        },
        tooltip: {
          backgroundColor: "#0b0d1a",
          titleColor: "#f1f3f9",
          bodyColor: "#c6cad8",
          borderColor: "rgba(255,255,255,0.1)",
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
        },
      },
    },
  });
}

function updateStatusChart() {
  if (!state.charts.status) return;
  const counts = {
    open: state.tickets.filter((t) => (t.status || "open") === "open").length,
    in_progress: state.tickets.filter((t) => t.status === "in_progress").length,
    resolved: state.tickets.filter((t) => t.status === "resolved").length,
  };
  state.charts.status.data.datasets[0].data = [counts.open, counts.in_progress, counts.resolved];
  state.charts.status.update("none");
}

function renderDailyChart() {
  const ctx = $("#chart-daily")?.getContext("2d");
  if (!ctx) return;
  const theme = getChartTheme();
  const { labels, data } = buildTimelineData(30);
  if (state.charts.daily) state.charts.daily.destroy();
  state.charts.daily = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Tickets",
          data,
          backgroundColor: (c) => {
            const { ctx } = c.chart;
            const g = ctx.createLinearGradient(0, 0, 0, 280);
            g.addColorStop(0, "#6366f1");
            g.addColorStop(1, "#8b5cf6");
            return g;
          },
          borderRadius: 6,
          borderSkipped: false,
          maxBarThickness: 18,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0b0d1a",
          titleColor: "#f1f3f9",
          bodyColor: "#c6cad8",
          borderColor: "rgba(255,255,255,0.1)",
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: theme.text, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
          border: { display: false },
        },
        y: {
          grid: { color: theme.grid, drawBorder: false },
          ticks: { color: theme.text, font: { size: 11 }, stepSize: 1 },
          border: { display: false },
          beginAtZero: true,
        },
      },
    },
  });
}

function updateDailyChart() {
  if (!state.charts.daily) return;
  const { labels, data } = buildTimelineData(30);
  state.charts.daily.data.labels = labels;
  state.charts.daily.data.datasets[0].data = data;
  state.charts.daily.update("none");
}

function renderAllCharts() {
  renderTimelineChart();
  renderStatusChart();
  renderDailyChart();
}

let chatUnsub = null;

// ============== TICKET MODAL ==============
function openTicketModal(ticket, focusReply = false) {
  state.selectedTicket = ticket;
  $("#modal-subject").textContent = ticket.subject || "Untitled";
  $("#modal-email").textContent = ticket.email || "—";
  $("#modal-time").textContent = fmt.date(ticket.createdAt);
  $("#modal-userid").textContent = ticket.userId || "guest";
  $("#reply-target").textContent = ticket.email || "user";
  $("#modal-reply").value = "";

  const chatContainer = $("#modal-chat-history");
  chatContainer.innerHTML = `<div class="muted center pad" style="flex:1;display:flex;align-items:center;justify-content:center;">Loading conversation...</div>`;

  if (chatUnsub) {
    chatUnsub();
    chatUnsub = null;
  }

  const userId = ticket.userId || ticket.id;
  chatUnsub = onSnapshot(
    query(collection(db, `chats/${userId}/messages`), orderBy("createdAt", "asc")),
    (snapshot) => {
      if (snapshot.empty) {
        chatContainer.innerHTML = `<div class="muted center pad" style="flex:1;display:flex;align-items:center;justify-content:center;">No messages found.</div>`;
        return;
      }
      chatContainer.innerHTML = snapshot.docs.map(doc => {
        const msg = doc.data();
        const type = msg.isAdmin ? "admin" : "user";
        const time = fmt.timeAgo(msg.createdAt);
        return `
          <div class="chat-msg ${type}">
            <div>${fmt.escape(msg.text || "")}</div>
            <div class="chat-msg-time">${time}</div>
          </div>
        `;
      }).join("");
      chatContainer.scrollTop = chatContainer.scrollHeight;
    },
    (err) => {
      console.error("Chat fetch error", err);
      chatContainer.innerHTML = `<div class="muted center pad" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--error);">Failed to load chat history.</div>`;
    }
  );

  // Status pill
  const status = ticket.status || "open";
  const pill = $("#modal-status-pill");
  pill.className = `status-pill sm status-${status}`;
  pill.innerHTML = `<span class="dot dot-${getStatusDot(status)}"></span><span>${status.replace(
    "_",
    " "
  )}</span>`;

  // Status buttons
  $$(".status-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.status === status);
  });

  $("#ticket-modal").hidden = false;
  setTimeout(() => {
    if (focusReply) $("#modal-reply").focus();
  }, 100);
}

function closeTicketModal() {
  if (chatUnsub) {
    chatUnsub();
    chatUnsub = null;
  }
  $("#ticket-modal").hidden = true;
  state.selectedTicket = null;
}

async function updateTicketStatus(status) {
  if (!state.selectedTicket) return;
  try {
    await updateDoc(doc(db, "chats", state.selectedTicket.id), {
      status,
      updatedAt: serverTimestamp(),
    });
    toast({ type: "success", title: "Status updated", message: `Ticket is now ${status.replace("_", " ")}` });
  } catch (e) {
    console.error(e);
    toast({ type: "error", title: "Update failed", message: e.message });
  }
}

async function sendReply() {
  if (!state.selectedTicket) return;
  const text = $("#modal-reply").value.trim();
  if (!text) {
    toast({ type: "warning", title: "Empty reply", message: "Write something to send." });
    return;
  }
  if (!state.selectedTicket.userId) {
    toast({
      type: "warning",
      title: "Cannot reply",
      message: "This ticket has no user ID (guest). Update Firestore rules to allow sending to anonymous users.",
    });
    return;
  }
  const btn = $("#btn-send-reply");
  btn.disabled = true;
  btn.querySelector("span").textContent = "Sending…";
  try {
    const userId = state.selectedTicket.userId || state.selectedTicket.id;
    await addDoc(collection(db, `chats/${userId}/messages`), {
      text,
      isAdmin: true,
      createdAt: serverTimestamp(),
    });
    // mark ticket as in_progress if open
    if ((state.selectedTicket.status || "open") === "open") {
      await updateDoc(doc(db, "chats", state.selectedTicket.id), {
        status: "in_progress",
        updatedAt: serverTimestamp(),
      });
    }
    toast({ type: "success", title: "Reply sent", message: "User will be notified in their inbox." });
    closeTicketModal();
  } catch (e) {
    console.error(e);
    toast({ type: "error", title: "Send failed", message: e.message });
  } finally {
    btn.disabled = false;
    btn.querySelector("span").textContent = "Send reply";
  }
}

// ============== NOTIFICATIONS ==============
function renderNotifications() {
  const list = $("#notif-list");
  const recent = state.tickets.slice(0, 8);
  if (recent.length === 0) {
    list.innerHTML = `<div class="muted center pad">No new notifications</div>`;
    $("#notif-dot").hidden = true;
    return;
  }
  $("#notif-dot").hidden = false;
  list.innerHTML = recent
    .map(
      (t) => `
      <div class="notif-item" data-ticket="${t.id}">
        <div class="notif-dot"></div>
        <div class="notif-body">
          <div class="notif-title">${fmt.escape(t.subject || "New ticket")}</div>
          <div class="notif-desc">${fmt.escape(t.email || "Anonymous")}</div>
          <div class="notif-time">${fmt.timeAgo(t.createdAt)}</div>
        </div>
      </div>
    `
    )
    .join("");
  $$(".notif-item", list).forEach((el) => {
    el.addEventListener("click", () => {
      const ticket = state.tickets.find((t) => t.id === el.dataset.ticket);
      if (ticket) {
        openTicketModal(ticket);
        closeDrawer();
      }
    });
  });
}

function openDrawer() {
  $("#notif-drawer").hidden = false;
  refreshIcons();
}
function closeDrawer() {
  $("#notif-drawer").hidden = true;
}

// ============== EVENT WIRING ==============
function wireEvents() {
  // Login
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#admin-email").value.trim();
    const pwd = $("#admin-password").value;
    const remember = $("#remember-me").checked;
    if (!email || !pwd) {
      toast({ type: "warning", title: "Missing fields", message: "Enter both email and password." });
      return;
    }
    const btn = $("#btn-login");
    btn.disabled = true;
    btn.querySelector("span").textContent = "Signing in…";
    try {
      await login(email, pwd, remember);
    } catch {
      // already toasted
    } finally {
      btn.disabled = false;
      btn.querySelector("span").textContent = "Sign in";
    }
  });

  // Password reveal
  $$("[data-toggle-pwd]").forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.dataset.togglePwd;
      const input = document.getElementById(id);
      const isPwd = input.type === "password";
      input.type = isPwd ? "text" : "password";
      b.querySelector("i").setAttribute("data-lucide", isPwd ? "eye-off" : "eye");
      refreshIcons();
    });
  });

  // Logout
  $("#btn-logout").addEventListener("click", logout);
  $("#btn-logout-2")?.addEventListener("click", logout);

  // Sidebar collapse
  $("#collapse-sidebar").addEventListener("click", () => {
    $("#dashboard-view").classList.toggle("collapsed");
  });
  // Mobile menu
  $("#mobile-menu").addEventListener("click", () => {
    $("#sidebar").classList.toggle("open");
  });

  // Theme toggle
  $("#theme-toggle").addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "dark" ? "light" : "dark");
  });
  $$("#theme-seg .seg-btn").forEach((b) => {
    b.addEventListener("click", () => setTheme(b.dataset.theme));
  });

  // Compact / anim
  $("#compact-mode").addEventListener("change", (e) => {
    document.body.classList.toggle("compact", e.target.checked);
    localStorage.setItem("ledo-compact", e.target.checked ? "1" : "0");
  });
  $("#anim-toggle").addEventListener("change", (e) => {
    document.body.classList.toggle("no-anim", !e.target.checked);
    localStorage.setItem("ledo-anim", e.target.checked ? "1" : "0");
  });

  // Filters
  $$("#status-filters .chip").forEach((c) => {
    c.addEventListener("click", () => {
      $$("#status-filters .chip").forEach((x) => x.classList.remove("active"));
      c.classList.add("active");
      state.statusFilter = c.dataset.filter;
      renderTickets();
    });
  });
  // User sort
  $$("[data-usersort]").forEach((c) => {
    c.addEventListener("click", () => {
      $$("[data-usersort]").forEach((x) => x.classList.remove("active"));
      c.classList.add("active");
      state.userSort = c.dataset.usersort;
      renderUsers();
    });
  });

  // Search
  $("#ticket-search").addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderTickets();
  });
  $("#user-search").addEventListener("input", (e) => {
    state.userSearch = e.target.value;
    renderUsers();
  });
  $("#global-search").addEventListener("input", (e) => {
    const v = e.target.value;
    state.searchQuery = v;
    state.userSearch = v;
    if (state.currentRoute !== "tickets" && state.currentRoute !== "users") {
      navigateTo("tickets");
    }
    renderTickets();
    renderUsers();
  });

  // Range
  $$("#range-seg .seg-btn").forEach((b) => {
    b.addEventListener("click", () => {
      $$("#range-seg .seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.ticketsRange = parseInt(b.dataset.range) || 14;
      renderTimelineChart();
    });
  });

  // Modal close
  $$("#ticket-modal [data-close]").forEach((el) =>
    el.addEventListener("click", closeTicketModal)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#ticket-modal").hidden) closeTicketModal();
      if (!$("#notif-drawer").hidden) closeDrawer();
    }
  });

  // Status update
  $$(".status-btn").forEach((b) => {
    b.addEventListener("click", () => updateTicketStatus(b.dataset.status));
  });

  // Reply
  $("#btn-send-reply").addEventListener("click", sendReply);
  $("#btn-reply-template").addEventListener("click", () => {
    const t = state.selectedTicket;
    if (!t) return;
    $("#modal-reply").value = `Hi,\n\nThanks for reaching out about "${t.subject || "your issue"}". We're looking into it and will get back to you shortly.\n\nBest,\nLedo Support`;
    $("#modal-reply").focus();
  });

  // Notifications drawer
  $("#notif-btn").addEventListener("click", openDrawer);
  $$("[data-close-drawer]").forEach((el) => el.addEventListener("click", closeDrawer));

  // Keyboard: Cmd/Ctrl+K to focus search
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      $("#global-search").focus();
    }
  });
}

// =============================================================
// MY ACCOUNT
// =============================================================

async function setupAccount() {
  if (!state.currentUser) return;
  renderAccountHero();
  wireAccountTabs();
  wireProfileForm();
  wireSecurityForm();
  wireNotificationsForm();
  wireIntegrations();
  wireDangerZone();
  await loadAccountData();
  await loadMyActivity();
  renderPersonalStats();
  renderMyActivity();
  setTimeout(renderMyActivityChart, 100);
}

function renderAccountHero() {
  const u = state.currentUser;
  if (!u) return;
  const name = u.displayName || fmt.emailLocal(u.email) || "Admin";
  const initial = name.charAt(0).toUpperCase();
  $("#account-avatar").textContent = initial;
  $("#account-display-name").textContent = name;
  $("#account-email-display").textContent = u.email || "—";
  $("#account-joined").textContent = new Date().toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
  // browser detection
  const ua = navigator.userAgent;
  let browser = "Unknown";
  if (ua.includes("Chrome")) browser = "Chrome";
  else if (ua.includes("Firefox")) browser = "Firefox";
  else if (ua.includes("Safari")) browser = "Safari";
  else if (ua.includes("Edge")) browser = "Edge";
  const os = ua.includes("Win") ? "Windows" : ua.includes("Mac") ? "macOS" : ua.includes("Linux") ? "Linux" : "Device";
  $("#sess-browser").textContent = `${browser} on ${os}`;
  // location fallback
  const lang = (navigator.language || "en").split("-")[1] || "";
  $("#sess-location").textContent = lang ? `${lang.toUpperCase()} (approx)` : "Detecting…";
  $("#account-location").textContent = $("#account-location").textContent || "Earth";
}

function wireAccountTabs() {
  $$(".account-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const t = tab.dataset.accountTab;
      $$(".account-tab").forEach((x) => x.classList.remove("active"));
      tab.classList.add("active");
      $$(".account-pane").forEach((p) => {
        p.hidden = p.dataset.accountPane !== t;
      });
      if (t === "activity") {
        setTimeout(renderMyActivityChart, 50);
      }
    });
  });
}

function wireProfileForm() {
  // Bio char counter
  const bio = $("#profile-bio");
  const count = $("#bio-count");
  if (bio && count) {
    bio.addEventListener("input", () => {
      count.textContent = bio.value.length;
    });
  }
  // Auto-save on blur for each field
  const fields = [
    "profile-name", "profile-username", "profile-phone", "profile-location",
    "profile-website", "profile-timezone", "profile-bio",
    "social-github", "social-twitter", "social-discord",
    "social-instagram", "social-linkedin", "social-youtube",
  ];
  fields.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    let timer = null;
    const save = () => {
      clearTimeout(timer);
      timer = setTimeout(() => saveProfileField(id, el.value), 600);
    };
    el.addEventListener("input", save);
    el.addEventListener("change", save);
    el.addEventListener("blur", save);
  });

  // Live preview sync + completeness meter
  wireAccountPreview();
}

function wireAccountPreview() {
  const map = {
    "profile-name": ["#acct-preview-name", (v) => v || "Admin"],
    "profile-username": ["#acct-preview-handle", (v) => v ? `@${v}` : "@admin"],
    "profile-bio": ["#acct-preview-bio", (v) => v || "Tell others a bit about yourself…"],
  };
  Object.entries(map).forEach(([src, [sel, fmt]]) => {
    const el = document.getElementById(src);
    const target = document.querySelector(sel);
    if (!el || !target) return;
    const update = () => { target.textContent = fmt(el.value); };
    el.addEventListener("input", update);
    update();
  });

  // Sync preview avatar with account avatar
  const acctAvatar = document.getElementById("account-avatar");
  const previewAvatar = document.getElementById("acct-preview-avatar");
  if (acctAvatar && previewAvatar) {
    const updateAvatar = () => { previewAvatar.textContent = acctAvatar.textContent || "A"; };
    new MutationObserver(updateAvatar).observe(acctAvatar, { childList: true, characterData: true, subtree: true });
    updateAvatar();
  }

  // Stats sync
  const statMap = {
    handled: "#acct-preview-handled",
    resolved: "#acct-preview-resolved",
    rating: "#acct-preview-rating",
  };
  Object.entries(statMap).forEach(([key, sel]) => {
    const src = document.querySelector(`[data-personal-stat="${key}"]`);
    const tgt = document.querySelector(sel);
    if (!src || !tgt) return;
    const update = () => { tgt.textContent = src.textContent || "0"; };
    new MutationObserver(update).observe(src, { childList: true, characterData: true, subtree: true });
    update();
  });

  // Completeness meter
  const required = [
    { id: "profile-name", weight: 20 },
    { id: "profile-username", weight: 15 },
    { id: "profile-bio", weight: 20 },
    { id: "profile-phone", weight: 10 },
    { id: "profile-location", weight: 10 },
    { id: "profile-website", weight: 10 },
    { id: "profile-timezone", weight: 10 },
  ];
  const fill = document.getElementById("acct-progress-fill");
  const valEl = document.getElementById("acct-completeness-value");
  if (!fill || !valEl) return;

  const recompute = () => {
    let score = 0;
    let total = 0;
    required.forEach(({ id, weight }) => {
      total += weight;
      const el = document.getElementById(id);
      if (el && el.value && el.value.toString().trim()) score += weight;
    });
    const pct = total ? Math.round((score / total) * 100) : 0;
    fill.style.width = pct + "%";
    valEl.textContent = pct + "%";
  };
  required.forEach(({ id }) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", recompute);
  });
  recompute();
}

function wireSecurityForm() {
  // Password strength
  const newPwd = $("#pwd-new");
  if (newPwd) {
    newPwd.addEventListener("input", updatePasswordStrength);
  }
  // Password change
  $("#btn-change-password")?.addEventListener("click", changePassword);
  // Sign out all
  $("#btn-signout-all")?.addEventListener("click", signOutAllSessions);
  $("#btn-danger-signout-all")?.addEventListener("click", signOutAllSessions);
  // 2FA toggles
  ["tfa-app", "tfa-sms", "tfa-email"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      update2FAStatus();
      saveNotificationPreference("twoFactor", get2FAState());
    });
  });
  // New token
  $("#btn-new-token")?.addEventListener("click", () => {
    toast({ type: "info", title: "Coming soon", message: "API token generation will be available in the next release." });
  });
}

function wireNotificationsForm() {
  // Matrix toggles
  $$("[data-notif]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const notif = cb.dataset.notif;
      const chan = cb.dataset.chan;
      if (!state.account.notifications) state.account.notifications = {};
      if (!state.account.notifications[notif]) state.account.notifications[notif] = {};
      state.account.notifications[notif][chan] = cb.checked;
      showSaveIndicator("saving");
      debouncedSaveNotifications();
    });
  });
  // Quiet hours
  ["quiet-hours-toggle", "quiet-from", "quiet-to", "quiet-tz"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", debouncedSaveNotifications);
  });
}

function wireIntegrations() {
  $$("[data-integration-toggle]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const name = cb.dataset.integrationToggle;
      const card = cb.closest(".integration-card");
      if (cb.checked) {
        card.classList.add("connected");
        card.querySelector(".integration-status").textContent = "Connected";
        toast({ type: "success", title: `${name} connected`, message: "You will now receive updates via this integration." });
      } else {
        card.classList.remove("connected");
        card.querySelector(".integration-status").textContent = "Not connected";
        toast({ type: "info", title: `${name} disconnected` });
      }
    });
  });
}

function wireDangerZone() {
  $("#btn-danger-reset")?.addEventListener("click", () => {
    if (!confirm("Reset all local preferences? This will not affect your account data.")) return;
    localStorage.removeItem("ledo-theme");
    localStorage.removeItem("ledo-compact");
    localStorage.removeItem("ledo-anim");
    document.body.classList.remove("compact", "no-anim");
    setTheme("dark");
    toast({ type: "success", title: "Preferences reset", message: "Local preferences cleared." });
  });

  const confirmInput = $("#delete-confirm");
  const deleteBtn = $("#btn-danger-delete");
  if (confirmInput && deleteBtn) {
    confirmInput.addEventListener("input", () => {
      deleteBtn.disabled = confirmInput.value !== "DELETE";
    });
    deleteBtn.addEventListener("click", () => {
      if (confirmInput.value !== "DELETE") return;
      if (!confirm("Are you absolutely sure? This action cannot be undone.")) return;
      toast({ type: "error", title: "Account deletion requested", message: "Please contact support to complete account deletion." });
    });
  }
}

async function loadAccountData() {
  if (!state.currentUser) return;
  const uid = state.currentUser.uid;
  // Load profile
  try {
    const profileDoc = await getDoc(doc(db, "users", uid, "account", "profile"));
    if (profileDoc.exists()) {
      state.account.profile = profileDoc.data();
      populateProfileForm();
    } else {
      populateProfileForm();
    }
  } catch (e) {
    console.warn("Profile load:", e.message);
  }
  // Load notifications
  try {
    const notifDoc = await getDoc(doc(db, "users", uid, "account", "notifications"));
    if (notifDoc.exists()) {
      state.account.notifications = notifDoc.data();
      populateNotificationsForm();
    }
  } catch (e) {
    console.warn("Notifications load:", e.message);
  }
}

function populateProfileForm() {
  const p = state.account.profile || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el != null && v != null) el.value = v; };
  set("profile-name", p.displayName || state.currentUser?.displayName || "");
  set("profile-username", p.username || "");
  set("profile-email", state.currentUser?.email || "");
  set("profile-phone", p.phone || "");
  set("profile-location", p.location || "");
  set("profile-website", p.website || "");
  set("profile-timezone", p.timezone || "Africa/Cairo");
  set("profile-bio", p.bio || "");
  if (p.bio) $("#bio-count").textContent = p.bio.length;
  // social
  const social = p.social || {};
  set("social-github", social.github || "");
  set("social-twitter", social.twitter || "");
  set("social-discord", social.discord || "");
  set("social-instagram", social.instagram || "");
  set("social-linkedin", social.linkedin || "");
  set("social-youtube", social.youtube || "");
}

function populateNotificationsForm() {
  const n = state.account.notifications || {};
  $$("[data-notif]").forEach((cb) => {
    const notif = cb.dataset.notif;
    const chan = cb.dataset.chan;
    const v = n[notif]?.[chan];
    if (typeof v === "boolean") cb.checked = v;
  });
  if (n.quietHours) {
    $("#quiet-hours-toggle").checked = n.quietHours.enabled !== false;
    $("#quiet-from").value = n.quietHours.from || "22:00";
    $("#quiet-to").value = n.quietHours.to || "08:00";
    $("#quiet-tz").value = n.quietHours.tz || "Local time";
  }
}

function get2FAState() {
  return {
    app: $("#tfa-app").checked,
    sms: $("#tfa-sms").checked,
    email: $("#tfa-email").checked,
  };
}

function update2FAStatus() {
  const state2 = get2FAState();
  const any = state2.app || state2.sms || state2.email;
  const pill = $("#tfa-status");
  if (any) {
    pill.classList.add("status-on");
    pill.classList.remove("status-off");
    pill.innerHTML = `<span class="dot"></span> Enabled`;
  } else {
    pill.classList.add("status-off");
    pill.classList.remove("status-on");
    pill.innerHTML = `<span class="dot"></span> Disabled`;
  }
}

function updatePasswordStrength() {
  const pwd = $("#pwd-new").value;
  const fill = $("#pwd-strength-fill");
  const label = $("#pwd-strength-label");
  let score = 0;
  if (pwd.length >= 8) score++;
  if (pwd.length >= 12) score++;
  if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) score++;
  if (/\d/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;
  fill.classList.remove("weak", "fair", "good", "strong");
  if (!pwd) {
    label.textContent = "Enter a password";
  } else if (score <= 2) {
    fill.classList.add("weak");
    label.textContent = "Weak";
  } else if (score === 3) {
    fill.classList.add("fair");
    label.textContent = "Fair";
  } else if (score === 4) {
    fill.classList.add("good");
    label.textContent = "Good";
  } else {
    fill.classList.add("strong");
    label.textContent = "Strong";
  }
}

async function changePassword() {
  const current = $("#pwd-current").value;
  const next = $("#pwd-new").value;
  const confirm = $("#pwd-confirm").value;
  if (!current || !next || !confirm) {
    toast({ type: "warning", title: "Missing fields", message: "Fill in all password fields." });
    return;
  }
  if (next !== confirm) {
    toast({ type: "error", title: "Mismatch", message: "New password and confirmation don't match." });
    return;
  }
  if (next.length < 8) {
    toast({ type: "error", title: "Too short", message: "Password must be at least 8 characters." });
    return;
  }
  const btn = $("#btn-change-password");
  btn.disabled = true;
  btn.querySelector("span").textContent = "Updating…";
  try {
    const { updatePassword, reauthenticateWithCredential, EmailAuthProvider } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
    const cred = EmailAuthProvider.credential(state.currentUser.email, current);
    await reauthenticateWithCredential(state.currentUser, cred);
    await updatePassword(state.currentUser, next);
    $("#pwd-current").value = "";
    $("#pwd-new").value = "";
    $("#pwd-confirm").value = "";
    updatePasswordStrength();
    $("#pwd-last-changed").textContent = "just now";
    toast({ type: "success", title: "Password updated", message: "Your account is now secured with the new password." });
  } catch (e) {
    let msg = e.message;
    if (e.code === "auth/wrong-password") msg = "Current password is incorrect.";
    if (e.code === "auth/weak-password") msg = "Choose a stronger password.";
    toast({ type: "error", title: "Update failed", message: msg });
  } finally {
    btn.disabled = false;
    btn.querySelector("span").textContent = "Update password";
  }
}

async function signOutAllSessions() {
  if (!confirm("Sign out of all devices?")) return;
  try {
    // In a real implementation this would call a server endpoint to revoke refresh tokens
    // For now we sign out the current session
    await logout();
    toast({ type: "info", title: "Signed out", message: "All sessions terminated. You can sign back in anytime." });
  } catch (e) {
    toast({ type: "error", title: "Failed", message: e.message });
  }
}

async function saveProfileField(fieldId, value) {
  if (!state.currentUser) return;
  const uid = state.currentUser.uid;
  showSaveIndicator("saving");
  try {
    const updates = {};
    // Map field IDs to nested paths
    const profileMap = {
      "profile-name": "displayName",
      "profile-username": "username",
      "profile-phone": "phone",
      "profile-location": "location",
      "profile-website": "website",
      "profile-timezone": "timezone",
      "profile-bio": "bio",
      "social-github": "social.github",
      "social-twitter": "social.twitter",
      "social-discord": "social.discord",
      "social-instagram": "social.instagram",
      "social-linkedin": "social.linkedin",
      "social-youtube": "social.youtube",
    };
    const path = profileMap[fieldId];
    if (!path) return;
    const newProfile = JSON.parse(JSON.stringify(state.account.profile || {}));
    if (path.includes(".")) {
      const [parent, child] = path.split(".");
      newProfile[parent] = newProfile[parent] || {};
      newProfile[parent][child] = value;
    } else {
      newProfile[path] = value;
    }
    newProfile.updatedAt = new Date().toISOString();
    newProfile.uid = uid;
    await setDocIfAllowed(doc(db, "users", uid, "account", "profile"), newProfile);
    state.account.profile = newProfile;
    showSaveIndicator("saved");
  } catch (e) {
    console.error("Save error:", e);
    showSaveIndicator("error");
    toast({ type: "error", title: "Save failed", message: e.message });
  }
}

async function setDocIfAllowed(docRef, data) {
  // Use setDoc with merge: true
  const { setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  await setDoc(docRef, data, { merge: true });
}

let saveNotificationsTimer = null;
function debouncedSaveNotifications() {
  clearTimeout(saveNotificationsTimer);
  saveNotificationsTimer = setTimeout(saveNotifications, 800);
}

async function saveNotifications() {
  if (!state.currentUser) return;
  const uid = state.currentUser.uid;
  const data = {
    ...(state.account.notifications || {}),
    quietHours: {
      enabled: $("#quiet-hours-toggle").checked,
      from: $("#quiet-from").value,
      to: $("#quiet-to").value,
      tz: $("#quiet-tz").value,
    },
  };
  try {
    await setDocIfAllowed(doc(db, "users", uid, "account", "notifications"), data);
    state.account.notifications = data;
    showSaveIndicator("saved");
  } catch (e) {
    console.error("Notif save:", e);
    showSaveIndicator("error");
  }
}

async function saveNotificationPreference(key, value) {
  if (!state.currentUser) return;
  const uid = state.currentUser.uid;
  try {
    await setDocIfAllowed(doc(db, "users", uid, "account", "notifications"), {
      [key]: value,
    });
  } catch (e) {
    console.warn("Preference save:", e.message);
  }
}

let saveIndicatorTimer = null;
function showSaveIndicator(state) {
  const el = $("#save-indicator");
  if (!el) return;
  el.classList.remove("saving", "error");
  clearTimeout(saveIndicatorTimer);
  if (state === "saving") {
    el.classList.add("saving");
    el.innerHTML = `<i data-lucide="loader"></i><span>Saving…</span>`;
  } else if (state === "error") {
    el.classList.add("error");
    el.innerHTML = `<i data-lucide="alert-circle"></i><span>Save failed</span>`;
  } else {
    el.innerHTML = `<i data-lucide="check-circle-2"></i><span>All changes saved</span>`;
  }
  refreshIcons();
  saveIndicatorTimer = setTimeout(() => {
    if (state === "saved") {
      el.innerHTML = `<i data-lucide="check-circle-2"></i><span>All changes saved</span>`;
      refreshIcons();
    }
  }, 2500);
}

// ============== MY ACTIVITY ==============
async function loadMyActivity() {
  if (!state.currentUser) return;
  // In a real implementation, load from `users/{uid}/activity_log`
  // For now, derive from current state
  const myActions = [];
  state.tickets.slice(0, 10).forEach((t) => {
    if (t.status === "resolved") {
      myActions.push({
        type: "resolve",
        title: `Resolved "${t.subject || "Untitled"}"`,
        meta: `${t.email || "User"} • ${fmt.timeAgo(t.updatedAt || t.createdAt)}`,
        time: t.updatedAt || t.createdAt,
      });
    }
  });
  state.myActivity = myActions.sort(
    (a, b) => (b.time?.seconds || 0) - (a.time?.seconds || 0)
  );
}

function renderMyActivity() {
  const root = $("#my-activity-feed");
  if (!root) return;
  const items = state.myActivity;
  if (items.length === 0) {
    root.innerHTML = `<div class="muted center pad">No recent activity yet. Start by resolving tickets.</div>`;
    return;
  }
  root.innerHTML = items
    .map(
      (a) => `
      <div class="activity-feed-item">
        <div class="activity-feed-icon ${a.type}">
          <i data-lucide="${a.type === "resolve" ? "check" : a.type === "reply" ? "message-square" : a.type === "update" ? "edit" : "log-in"}"></i>
        </div>
        <div class="activity-feed-body">
          <div class="activity-feed-title">${fmt.escape(a.title)}</div>
          <div class="activity-feed-meta">${fmt.escape(a.meta)}</div>
        </div>
      </div>
    `
    )
    .join("");
  refreshIcons();
}

function renderPersonalStats() {
  const handled = state.tickets.filter((t) => t.status === "resolved" || t.status === "in_progress").length;
  const resolved = state.tickets.filter((t) => t.status === "resolved").length;
  const replies = state.myActivity.filter((a) => a.type === "reply").length;
  $$("[data-personal-stat]").forEach((el) => {
    const key = el.dataset.personalStat;
    if (key === "handled") animateNumber(el, handled);
    else if (key === "resolved") animateNumber(el, resolved);
    else if (key === "replies") animateNumber(el, replies);
    else if (key === "rating") el.textContent = "—";
  });
  // week stats
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekTickets = state.tickets.filter((t) => {
    const d = t.createdAt?.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
    return d >= weekAgo;
  });
  $("#week-handled").textContent = weekTickets.length;
  $("#week-resolved").textContent = weekTickets.filter((t) => t.status === "resolved").length;
  $("#week-replies").textContent = state.myActivity.length;
  $("#week-avg").textContent = "—";
}

function renderMyActivityChart() {
  const ctx = $("#chart-my-activity")?.getContext("2d");
  if (!ctx) return;
  const theme = getChartTheme();
  const days = 7;
  const labels = [];
  const data = [];
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    labels.push(d.toLocaleDateString("en-US", { weekday: "short" }));
    const count = state.tickets.filter((t) => {
      const td = t.createdAt?.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
      return td >= d && td < new Date(d.getTime() + 86400000);
    }).length;
    data.push(count);
  }
  if (state.charts.myActivity) state.charts.myActivity.destroy();
  state.charts.myActivity = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Activity",
          data,
          backgroundColor: (c) => {
            const { ctx } = c.chart;
            const g = ctx.createLinearGradient(0, 0, 0, 200);
            g.addColorStop(0, "#6366f1");
            g.addColorStop(1, "#8b5cf6");
            return g;
          },
          borderRadius: 6,
          maxBarThickness: 26,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: theme.text, font: { size: 11 } }, border: { display: false } },
        y: { grid: { color: theme.grid }, ticks: { color: theme.text, font: { size: 11 }, stepSize: 1 }, border: { display: false }, beginAtZero: true },
      },
    },
  });
}

// ============== INIT ==============
function init() {
  initTheme();
  initPrefs();
  initIcons();
  initRouter();
  wireEvents();
  initAuth();
}

document.addEventListener("DOMContentLoaded", init);

// Expose for debugging
window.__ledo = { state, db, auth };
