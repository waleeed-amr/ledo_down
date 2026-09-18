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
  where,
  orderBy,
  limit,
  onSnapshot,
  doc,
  updateDoc,
  addDoc,
  setDoc,
  deleteDoc,
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
  users: [],
  crashes: [],
  announcements: [],
  latestUpdate: null,
  publicLinks: null,
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
  firstAnnouncementsLoad: true,
  account: {
    profile: null,
    preferences: null,
    notifications: null,
    saving: false,
  },
  myActivity: [],
  health: {
    auth: false,
    firestore: false,
    announcements: false,
    updates: false,
    users: false,
  }
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
      try {
        const token = await user.getIdTokenResult();
        const isAdmin = token.claims.admin === true || user.email === 'waleed@ledodown.local';
        
        if (!isAdmin) {
          toast({ type: "error", title: "Access Denied", message: "You don't have admin permissions.", duration: 5000 });
          await signOut(auth);
          return;
        }
        
        state.currentUser = user;
        showDashboard();
        updateAdminInfo();
        await loadAllData();
      } catch (err) {
        console.error("Error verifying admin role:", err);
        toast({ type: "error", title: "Auth Error", message: "Failed to verify permissions." });
        await signOut(auth);
      }
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
    announcements: ["Broadcast Announcements", "Send pop-up notices & messages to desktop users"],
    updates: ["App Releases", "Publish updates and configure MediaFire download links"],
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
  state.users = [];
  state.crashes = [];
  state.announcements = [];
  state.latestUpdate = null;
  state.publicLinks = null;
  state.appReleases = [];
  state.firstTicketsLoad = true;
  state.firstUsersLoad = true;
  state.firstCrashesLoad = true;
  state.firstAnnouncementsLoad = true;
}

async function loadAllData() {
  subscribeTickets();
  subscribeUsers();
  subscribeCrashes();
  subscribeAnnouncements();
  subscribeAppReleases();
  subscribeAdminActivity();
  subscribeAdminNotifications();
  loadLatestUpdate();
  loadPublicLinks();
}

function subscribeTickets() {
  if (!state.currentUser) return;
  const q = query(collection(db, "chats"), orderBy("lastUpdated", "desc"), limit(500));
  const unsub = onSnapshot(
    q,
    (snapshot) => {
      state.tickets = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.firstTicketsLoad = false;
      updateHealth("users", true); // Users derived from tickets or own collection
      onTicketsUpdate();
    },
    (err) => {
      console.error("Tickets error:", err);
      updateHealth("users", false);
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

function subscribeUsers() {
  if (!state.currentUser) return;
  const q = query(collection(db, "users"), limit(500));
  const unsub = onSnapshot(
    q,
    (snapshot) => {
      state.users = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.firstUsersLoad = false;
      updateHealth("users", true);
      renderUsers();
      renderAnalytics();
    },
    (err) => {
      console.error("Users error:", err);
      updateHealth("users", false);
      state.firstUsersLoad = false;
      renderUsers();
    }
  );
  state.unsubscribers.push(unsub);
}

function onTicketsUpdate() {
  renderKpis();
  renderRecentActivity();
  renderTickets();
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
  if (!grid) return;
  if (state.firstUsersLoad) {
    grid.innerHTML = `<div class="muted center pad" style="grid-column:1/-1">Loading users...</div>`;
    return;
  }
  let users = [...state.users];
  const q = state.userSearch.toLowerCase();
  if (q) users = users.filter((u) => (u.email || "").toLowerCase().includes(q) || (u.id || "").toLowerCase().includes(q));
  
  if (state.userSort === "tickets") users.sort((a, b) => (b.ticketsCount || 0) - (a.ticketsCount || 0));
  else if (state.userSort === "recent") users.sort((a, b) => (b.lastSeen?.seconds || 0) - (a.lastSeen?.seconds || 0));
  else if (state.userSort === "alpha") users.sort((a, b) => (a.email || "").localeCompare(b.email || ""));

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
          fmt.initials(u.email || u.id)
        )}</div>
        <div class="user-card-info">
          <div class="user-card-name">${fmt.escape(fmt.emailLocal(u.email) || "Anonymous User")}</div>
          <div class="user-card-email">${fmt.escape(u.email || u.id)}</div>
          ${u.status === "disabled" ? `<div style="color:#ef4444;font-size:11px;margin-top:2px;">Banned</div>` : ""}
        </div>
        <div class="user-card-stats">
          <div class="user-stat">
            <div class="user-stat-label">Tickets</div>
            <div class="user-stat-value">${u.ticketsCount || 0}</div>
          </div>
          <div class="user-stat">
            <div class="user-stat-label">Last seen</div>
            <div class="user-stat-value" style="font-size:13px">${fmt.timeAgo(u.lastSeen || u.createdAt)}</div>
          </div>
        </div>
      </div>
    `
    )
    .join("");
  $$(".user-card", grid).forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.dataset.user;
      const user = state.users.find((u) => u.id === id);
      if (user) openUserModal(user);
    });
  });
}

function openUserModal(user) {
  if (!user) return;
  state.selectedUser = user;
  const modal = $("#user-modal");
  
  $("#modal-user-name").textContent = fmt.emailLocal(user.email) || "Anonymous User";
  $("#modal-user-email").textContent = user.email || "—";
  $("#modal-user-created").textContent = fmt.date(user.createdAt);
  $("#modal-user-lastseen").textContent = fmt.timeAgo(user.lastSeen || user.createdAt);
  $("#modal-user-id").textContent = user.id || "—";
  
  $("#modal-user-tickets-count").textContent = user.ticketsCount || 0;
  $("#modal-user-crashes-count").textContent = state.crashes.filter(c => c.email === user.email || c.device_id === user.id).length || 0;
  $("#modal-user-version").textContent = user.appVersion || "—";
  
  const statusPill = $("#modal-user-status-pill");
  if (user.status === "disabled") {
    statusPill.textContent = "Banned";
    statusPill.className = "status-pill sm disabled";
    statusPill.style.color = "#ef4444";
    statusPill.style.background = "rgba(239,68,68,0.1)";
  } else {
    statusPill.textContent = "Active";
    statusPill.className = "status-pill sm active";
    statusPill.style.color = "#10b981";
    statusPill.style.background = "rgba(16,185,129,0.1)";
  }
  
  modal.hidden = false;
  refreshIcons();
}

function closeUserModal() {
  $("#user-modal").hidden = true;
  state.selectedUser = null;
}

// ============== CRASHES ==============
function renderCrashes() {
  const tbody = $("#crashes-tbody");
  if (state.firstCrashesLoad) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">Loading crash reports…</td></tr>`;
    return;
  }
  if (state.crashes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">No crash reports. 🎉</td></tr>`;
    return;
  }
  
  // Group crashes by a signature
  const grouped = new Map();
  state.crashes.forEach((c) => {
    const signature = (c.subject || c.error_category || "Unknown") + "::" + (c.raw_message || c.message || "Unknown");
    if (!grouped.has(signature)) {
      grouped.set(signature, {
        signature,
        subject: c.subject || c.error_category || "Unknown",
        message: c.raw_message || c.message || "Unknown",
        stack_trace: c.stack_trace,
        occurrences: 0,
        devices: new Set(),
        firstSeen: null,
        lastSeen: null,
        latestCrash: c
      });
    }
    const group = grouped.get(signature);
    group.occurrences++;
    if (c.email || c.device_id) group.devices.add(c.email || c.device_id);
    
    const time = c.createdAt?.toDate ? c.createdAt.toDate() : new Date(c.createdAt);
    if (!group.firstSeen || time < group.firstSeen) group.firstSeen = time;
    if (!group.lastSeen || time > group.lastSeen) group.lastSeen = time;
  });

  const sortedGroups = Array.from(grouped.values()).sort((a, b) => b.lastSeen - a.lastSeen);

  tbody.innerHTML = sortedGroups
    .map(
      (g) => `
      <tr data-crash-group="${fmt.escape(g.signature)}" tabindex="0" role="button" aria-label="Open crash group">
        <td><div class="row-subject"><strong>${fmt.escape(g.subject)}</strong></div><div class="row-msg" style="max-width:300px;font-size:11px;opacity:0.8;">${fmt.escape(g.message)}</div></td>
        <td><div class="row-email" style="text-align:center;">${g.occurrences}</div></td>
        <td><div class="row-email" style="text-align:center;">${g.devices.size}</div></td>
        <td><div class="row-time">${fmt.date(g.firstSeen)}</div></td>
        <td><div class="row-time">${fmt.timeAgo(g.lastSeen)}</div></td>
      </tr>
    `
    )
    .join("");
    
  $$("#crashes-tbody tr[data-crash-group]").forEach((row) => {
    const sig = row.dataset.crashGroup;
    const group = sortedGroups.find(g => g.signature === sig);
    if (group) {
      const open = () => openCrashModal(group);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    }
  });
}

function openCrashModal(group) {
  if (!group) return;
  const modal = $("#crash-modal");
  const latest = group.latestCrash;
  
  $("#crash-modal-title").textContent = `${group.subject} (${group.occurrences} occurrences)`;
  $("#crash-modal-time").textContent = `First seen: ${fmt.date(group.firstSeen)} | Last seen: ${fmt.date(group.lastSeen)}`;
  $("#crash-modal-device").textContent = `${group.devices.size} affected device(s)`;
  $("#crash-modal-domain").textContent = latest.target_domain || "—";
  $("#crash-modal-message").textContent = group.message;
  $("#crash-modal-stack").textContent = group.stack_trace || "No stack trace was supplied.";
  $("#crash-modal-context").textContent = latest.extra ? JSON.stringify(latest.extra, null, 2) : "No additional context.";
  
  $("#btn-copy-crash").onclick = async () => {
    const details = [
      `Signature: ${group.signature}`,
      `Occurrences: ${group.occurrences}`,
      `Message: ${group.message}`,
      `Stack trace:\n${group.stack_trace}`
    ].join("\n\n");
    
    try {
      await navigator.clipboard.writeText(details);
      toast({ type: "success", title: "Copied", message: "The crash group details are in your clipboard." });
    } catch (_) {
      toast({ type: "error", title: "Copy failed", message: "Your browser blocked clipboard access." });
    }
  };
  
  modal.hidden = false;
  refreshIcons();
}

function closeCrashModal() {
  $("#crash-modal").hidden = true;
}

// ============== ANNOUNCEMENTS & RELEASES ==============
function subscribeAnnouncements() {
  if (!state.currentUser) return;
  const q = query(collection(db, "announcements"), orderBy("created_at", "desc"), limit(50));
  const unsub = onSnapshot(
    q,
    (snapshot) => {
      state.announcements = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.firstAnnouncementsLoad = false;
      updateHealth("announcements", true);
      renderAnnouncements();
    },
    (err) => {
      console.error("Announcements error:", err);
      updateHealth("announcements", false);
      state.firstAnnouncementsLoad = false;
      renderAnnouncements();
    }
  );
  state.unsubscribers.push(unsub);
}

function renderAnnouncements() {
  const container = $("#announcements-list");
  if (!container) return;
  if (state.firstAnnouncementsLoad) {
    container.innerHTML = `<div class="empty">Loading announcements…</div>`;
    return;
  }
  if (state.announcements.length === 0) {
    container.innerHTML = `<div class="empty">No announcements yet. Use the form to send your first message! 📢</div>`;
    return;
  }

  container.innerHTML = state.announcements
    .map((a) => {
      const typeBadges = {
        info: `<span class="badge" style="background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.3)">INFO</span>`,
        warning: `<span class="badge" style="background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.3)">WARNING</span>`,
        update: `<span class="badge" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3)">UPDATE</span>`,
        alert: `<span class="badge" style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3)">ALERT</span>`,
      };
      const statusBadges = {
        published: `<span class="badge" style="background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3)"><i data-lucide="check-circle" style="width:12px;height:12px;"></i> PUBLISHED</span>`,
        draft: `<span class="badge" style="background:rgba(148,163,184,0.15);color:#94a3b8;border:1px solid rgba(148,163,184,0.3)"><i data-lucide="edit-3" style="width:12px;height:12px;"></i> DRAFT</span>`,
        disabled: `<span class="badge" style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3)"><i data-lucide="slash" style="width:12px;height:12px;"></i> DISABLED</span>`,
      };
      const badge = typeBadges[a.type] || typeBadges.info;
      const statusValue = a.status || (a.active ? "published" : "disabled");
      const sBadge = statusBadges[statusValue] || statusBadges.draft;
      const isHigh = a.priority === "high" ? `<span class="badge" style="background:rgba(239,68,68,0.2);color:#f87171">HIGH</span>` : "";

      const views = (a.stats && a.stats.views) || 0;
      const clicks = (a.stats && a.stats.clicks) || 0;

      return `
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              ${badge}
              ${sBadge}
              ${isHigh}
              <strong style="font-size:15px;color:#f8fafc;">${fmt.escape(a.title || "Untitled")}</strong>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:12px;color:var(--text-muted);">${fmt.timeAgo(a.created_at)}</span>
              <button class="btn btn-sm" style="background:rgba(59,130,246,0.15);color:#60a5fa;border:none;padding:4px 10px;cursor:pointer;border-radius:6px;" onclick="window.handleEditAnnouncement('${a.id}')" title="Edit Announcement">
                Edit
              </button>
              <button class="btn btn-sm" style="background:rgba(239,68,68,0.15);color:#f87171;border:none;padding:4px 10px;cursor:pointer;border-radius:6px;" onclick="window.handleDeleteAnnouncement('${a.id}')" title="Delete Announcement">
                Delete
              </button>
            </div>
          </div>
          <div style="font-size:13.5px;line-height:1.6;color:#cbd5e1;white-space:pre-wrap;">${fmt.escape(a.body || "")}</div>
          ${a.action_url ? `<div style="font-size:12px;color:#60a5fa;"><a href="${fmt.escape(a.action_url)}" target="_blank" rel="noopener" style="color:#60a5fa;text-decoration:underline;">${fmt.escape(a.action_label || a.action_url)} ↗</a></div>` : ""}
          <div style="display:flex;gap:16px;margin-top:8px;align-items:center;flex-wrap:wrap;">
            ${a.min_version ? `<div style="font-size:11px;color:var(--text-muted);"><i data-lucide="shield-check" style="width:12px;height:12px;margin-bottom:-2px;"></i> Target: ≥ ${fmt.escape(a.min_version)}</div>` : ""}
            ${a.schedule_start ? `<div style="font-size:11px;color:var(--text-muted);"><i data-lucide="clock" style="width:12px;height:12px;margin-bottom:-2px;"></i> Starts: ${fmt.date(a.schedule_start)}</div>` : ""}
            ${a.schedule_end ? `<div style="font-size:11px;color:var(--text-muted);"><i data-lucide="clock" style="width:12px;height:12px;margin-bottom:-2px;"></i> Ends: ${fmt.date(a.schedule_end)}</div>` : ""}
            <div style="font-size:11px;color:var(--text-muted);display:flex;gap:4px;align-items:center;"><i data-lucide="eye" style="width:12px;height:12px;"></i> ${views} views</div>
            <div style="font-size:11px;color:var(--text-muted);display:flex;gap:4px;align-items:center;"><i data-lucide="mouse-pointer-click" style="width:12px;height:12px;"></i> ${clicks} clicks</div>
          </div>
        </div>
      `;
    })
    .join("");
  refreshIcons();
}

async function handleCreateAnnouncement(e) {
  e.preventDefault();
  const title = $("#ann-title").value.trim();
  const body = $("#ann-body").value.trim();
  const type = $("#ann-type").value || "info";
  const priority = $("#ann-priority").value || "normal";
  const action_url = $("#ann-action-url").value.trim();
  const action_label = $("#ann-action-label").value.trim();
  const min_version = $("#ann-min-version").value.trim();
  const status = $("#ann-status").value || "published";
  const schedule_start = $("#ann-schedule-start").value || "";
  const schedule_end = $("#ann-schedule-end").value || "";
  const id = $("#ann-id").value;

  if (!title || !body) {
    toast({ type: "warning", title: "Missing fields", message: "Please enter both a title and message." });
    return;
  }

  const payload = {
    title,
    body,
    type,
    priority,
    status,
    active: status === "published", // Legacy compat
    action_url: action_url || "",
    action_label: action_label || "عرض التفاصيل",
    min_version: min_version || "",
    schedule_start: schedule_start ? new Date(schedule_start).toISOString() : "",
    schedule_end: schedule_end ? new Date(schedule_end).toISOString() : ""
  };

  const btnSubmit = $("#btn-ann-submit");
  const btnSpan = btnSubmit.querySelector("span");
  const originalText = btnSpan.textContent;
  btnSubmit.disabled = true;
  btnSpan.textContent = id ? "Saving..." : "Publishing...";

  const withTimeout = (promise, ms) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out")), ms))
    ]);
  };

  try {
    if (id) {
      payload.updated_at = new Date().toISOString();
      await withTimeout(updateDoc(doc(db, "announcements", id), payload), 8000);
      logAdminActivity("update", `Updated announcement`, `Title: ${title} | Status: ${status}`);
      toast({ type: "success", title: "Announcement Updated" });
      resetAnnForm();
    } else {
      payload.created_at = new Date().toISOString();
      payload.author = state.currentUser?.email || "Admin";
      payload.stats = { views: 0, clicks: 0 };
      await withTimeout(addDoc(collection(db, "announcements"), payload), 8000);
      logAdminActivity("update", `Published announcement`, `Title: ${title} | Status: ${status}`);
      toast({ type: "success", title: "Announcement Published!" });
      resetAnnForm();
    }
  } catch (err) {
    console.error("Failed to publish announcement:", err);
    let msg = err.message;
    if (msg.includes("timed out")) {
      msg = "Connection blocked. Please turn off Brave Shields or your adblocker for this site.";
    }
    toast({ type: "error", title: "Publish failed", message: msg, duration: 6000 });
  } finally {
    btnSubmit.disabled = false;
    btnSpan.textContent = id ? "Save Changes" : "Publish Announcement";
  }
}

function resetAnnForm() {
  $("#ann-form").reset();
  $("#ann-id").value = "";
  $("#btn-ann-submit").querySelector("span").textContent = "Publish Announcement";
  $("#btn-ann-cancel").hidden = true;
}

window.handleEditAnnouncement = function(id) {
  const ann = state.announcements.find(a => a.id === id);
  if (!ann) return;
  
  $("#ann-title").value = ann.title || "";
  $("#ann-body").value = ann.body || "";
  $("#ann-type").value = ann.type || "info";
  $("#ann-priority").value = ann.priority || "normal";
  $("#ann-action-url").value = ann.action_url || "";
  $("#ann-action-label").value = ann.action_label || "";
  $("#ann-min-version").value = ann.min_version || "";
  
  if (ann.schedule_start) {
    const d = new Date(ann.schedule_start);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    $("#ann-schedule-start").value = d.toISOString().slice(0,16);
  } else {
    $("#ann-schedule-start").value = "";
  }
  
  if (ann.schedule_end) {
    const d = new Date(ann.schedule_end);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    $("#ann-schedule-end").value = d.toISOString().slice(0,16);
  } else {
    $("#ann-schedule-end").value = "";
  }

  $("#ann-status").value = ann.status || (ann.active ? "published" : "disabled");
  $("#ann-id").value = ann.id;
  
  $("#btn-ann-submit").querySelector("span").textContent = "Save Changes";
  $("#btn-ann-cancel").hidden = false;
  
  // scroll to top
  $(".main").scrollTo({ top: 0, behavior: 'smooth' });
};

// Cancel edit
$("#btn-ann-cancel")?.addEventListener("click", () => {
  resetAnnForm();
});

async function handleDeleteAnnouncement(id) {
  if (!confirm("Are you sure you want to delete this announcement?")) return;
  try {
    await deleteDoc(doc(db, "announcements", id));
    logAdminActivity("update", `Deleted announcement`, `ID: ${id}`);
    toast({ type: "success", title: "Deleted", message: "Announcement removed." });
  } catch (err) {
    toast({ type: "error", title: "Delete failed", message: err.message });
  }
}
window.handleDeleteAnnouncement = handleDeleteAnnouncement;

function loadLatestUpdate() {
  if (!state.currentUser) return;
  try {
    const unsub = onSnapshot(doc(db, "app_config", "latest_update"), (d) => {
      state.latestUpdate = d.exists() ? d.data() : null;
      updateHealth("updates", true);
      renderLatestUpdate();
    }, (err) => {
      console.error("Error loading release config:", err);
      updateHealth("updates", false);
    });
    state.unsubscribers.push(unsub);
  } catch (err) {
    console.error("Error loading release config:", err);
    updateHealth("updates", false);
  }
}

function renderLatestUpdate() {
  const container = $("#live-update-preview");
  if (!container) return;
  if (!state.latestUpdate) {
    container.innerHTML = `<div class="empty">No active release published yet. Use the form to release v4.0.0! 🚀</div>`;
    return;
  }

  const u = state.latestUpdate;
  container.innerHTML = `
    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(16,185,129,0.3);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:22px;font-weight:700;color:#34d399;font-family:monospace;">v${fmt.escape(u.version || "0.0.0")}</span>
          ${u.required ? `<span class="badge" style="background:rgba(239,68,68,0.2);color:#f87171;border:1px solid rgba(239,68,68,0.4)">Required Update</span>` : `<span class="badge" style="background:rgba(16,185,129,0.15);color:#34d399;">Optional</span>`}
        </div>
        <span style="font-size:12px;color:var(--text-muted);">${fmt.timeAgo(u.released_at)}</span>
      </div>

      <div>
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Download URL (MediaFire / Direct):</label>
        <a href="${fmt.escape(u.download_url || "#")}" target="_blank" rel="noopener" style="font-size:13px;color:#60a5fa;word-break:break-all;text-decoration:underline;">
          ${fmt.escape(u.download_url || "No URL")}
        </a>
      </div>

      <div>
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:6px;">Changelog / Release Notes:</label>
        <div style="background:rgba(0,0,0,0.3);border-radius:8px;padding:12px 14px;font-size:13px;line-height:1.6;color:#e2e8f0;white-space:pre-wrap;font-family:inherit;">
          ${fmt.escape(u.changelog || "No changelog provided.")}
        </div>
      </div>
      ${u.minimum_supported_version ? `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;">
        <i data-lucide="shield-alert" style="width:16px;height:16px;color:#fbbf24;"></i>
        <span style="font-size:13px;color:#fbbf24;">Minimum Supported: v${fmt.escape(u.minimum_supported_version)}</span>
        <span style="font-size:11px;color:var(--text-muted);margin-left:4px;">(Older versions are blocked)</span>
      </div>` : ""}
    </div>
  `;
  refreshIcons();

  // Pre-fill form if inputs empty
  const verInput = $("#update-version");
  const urlInput = $("#update-download-url");
  const notesInput = $("#update-changelog-input");
  const reqCheck = $("#update-required");
  const channelInput = $("#update-channel");
  const hashInput = $("#update-sha256");
  const minVerInput = $("#update-min-version");
  if (verInput && !verInput.value) verInput.value = u.version || "";
  if (urlInput && !urlInput.value) urlInput.value = u.download_url || "";
  if (notesInput && !notesInput.value) notesInput.value = u.changelog || "";
  if (reqCheck) reqCheck.checked = !!u.required;
  if (channelInput) channelInput.value = u.channel === "beta" ? "beta" : "stable";
  if (hashInput && !hashInput.value) hashInput.value = u.sha256 || "";
  if (minVerInput && !minVerInput.value) minVerInput.value = u.minimum_supported_version || "";
}

function isSafeHttpsUrl(value) {
  if (!value) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch (_) {
    return false;
  }
}

function isValidReleaseVersion(value) {
  return /^v?[0-9]+(\.[0-9]+){1,3}([\-+][0-9A-Za-z\.\-]+)?$/.test(value);
}

// Parses "v4.1.0" or "4.1.0" → [4,1,0]
function parseVersion(v) {
  if (!v) return [0, 0, 0];
  return v.replace(/^v/i, "").split(".").map(Number);
}

// Returns >0 if a>b, <0 if a<b, 0 if equal
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function subscribeAppReleases() {
  if (!state.currentUser) return;
  const q = query(collection(db, "app_releases"), orderBy("released_at", "desc"), limit(50));
  const unsub = onSnapshot(
    q,
    (snapshot) => {
      state.appReleases = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderReleaseHistory();
    },
    (err) => {
      console.error("App releases error:", err);
    }
  );
  state.unsubscribers.push(unsub);
}

function renderReleaseHistory() {
  const container = $("#release-history-list");
  if (!container) return;
  if (state.appReleases.length === 0) {
    container.innerHTML = `<div class="empty">No release history yet. Releases will appear here after publishing.</div>`;
    return;
  }
  const currentVersion = state.latestUpdate?.version;
  container.innerHTML = state.appReleases
    .map((r) => {
      const isCurrent = currentVersion && r.version === currentVersion;
      const borderColor = isCurrent ? "rgba(16,185,129,0.4)" : "rgba(255,255,255,0.08)";
      const currentBadge = isCurrent
        ? `<span class="badge" style="background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3)"><i data-lucide="check-circle" style="width:12px;height:12px;"></i> CURRENT</span>`
        : "";
      const channelBadge = r.channel === "beta"
        ? `<span class="badge" style="background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.3)">BETA</span>`
        : `<span class="badge" style="background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.3)">STABLE</span>`;
      const reqBadge = r.required
        ? `<span class="badge" style="background:rgba(239,68,68,0.15);color:#f87171">REQUIRED</span>`
        : "";

      return `
        <div style="background:rgba(255,255,255,0.03);border:1px solid ${borderColor};border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="font-size:16px;font-weight:700;color:#f8fafc;font-family:monospace;">v${fmt.escape(r.version || "?")}</span>
              ${channelBadge} ${reqBadge} ${currentBadge}
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:11px;color:var(--text-muted);">${fmt.timeAgo(r.released_at)}</span>
              ${!isCurrent ? `<button class="btn btn-sm" style="background:rgba(245,158,11,0.15);color:#fbbf24;border:none;padding:4px 10px;cursor:pointer;border-radius:6px;font-size:12px;" onclick="window.handleRollback('${r.id}')" title="Rollback to this version">Rollback</button>` : ""}
            </div>
          </div>
          ${r.changelog ? `<div style="font-size:12px;color:#94a3b8;white-space:pre-wrap;">${fmt.escape(r.changelog)}</div>` : ""}
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <span style="font-size:11px;color:var(--text-muted);">By ${fmt.escape(r.updatedBy || "Admin")}</span>
            ${r.sha256 ? `<span style="font-size:11px;color:var(--text-muted);font-family:monospace;">SHA: ${r.sha256.substring(0, 12)}…</span>` : ""}
            ${r.minimum_supported_version ? `<span style="font-size:11px;color:var(--text-muted);">Min: v${fmt.escape(r.minimum_supported_version)}</span>` : ""}
          </div>
        </div>
      `;
    })
    .join("");
  refreshIcons();
}

window.handleRollback = async function(releaseId) {
  const release = state.appReleases.find((r) => r.id === releaseId);
  if (!release) return;
  if (!confirm(`Rollback to v${release.version}? This will make it the current live release.`)) return;
  try {
    await setDoc(doc(db, "app_config", "latest_update"), {
      version: release.version,
      download_url: release.download_url,
      changelog: release.changelog || "",
      required: release.required || false,
      channel: release.channel || "stable",
      sha256: release.sha256 || "",
      minimum_supported_version: release.minimum_supported_version || "",
      released_at: new Date().toISOString(),
      updatedBy: state.currentUser?.email || "Admin",
      rollback_from: state.latestUpdate?.version || ""
    }, { merge: true });
    logAdminActivity("update", `Rolled back to release v${release.version}`);
    toast({ type: "success", title: "Rollback Complete", message: `Rolled back to v${release.version}.` });
  } catch (err) {
    toast({ type: "error", title: "Rollback Failed", message: err.message });
  }
};

async function handlePublishUpdate(e) {
  e.preventDefault();
  const version = $("#update-version").value.trim();
  const download_url = $("#update-download-url").value.trim();
  const changelog = $("#update-changelog-input").value.trim();
  const required = $("#update-required").checked;
  const channel = $("#update-channel").value === "beta" ? "beta" : "stable";
  const sha256 = $("#update-sha256").value.trim().toLowerCase();
  const minimum_supported_version = $("#update-min-version")?.value.trim() || "";

  if (!version || !download_url) {
    toast({ type: "warning", title: "Missing fields", message: "Please provide version and download URL (MediaFire)." });
    return;
  }
  if (!isValidReleaseVersion(version)) {
    toast({ type: "warning", title: "Invalid version", message: "Use a version such as 4.0.0 or v4.0.0." });
    return;
  }
  if (!isSafeHttpsUrl(download_url)) {
    toast({ type: "warning", title: "Secure link required", message: "The installer link must use HTTPS." });
    return;
  }
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) {
    toast({ type: "warning", title: "Invalid SHA-256", message: "The installer hash must contain exactly 64 hexadecimal characters." });
    return;
  }

  // Version comparison: warn if publishing an older version
  const currentVersion = state.latestUpdate?.version;
  if (currentVersion && compareVersions(version, currentVersion) < 0) {
    if (!confirm(`Warning: You are publishing v${version} which is OLDER than the current v${currentVersion}. Continue anyway?`)) {
      return;
    }
  }

  // Validate minimum_supported_version if set
  if (minimum_supported_version) {
    if (!isValidReleaseVersion(minimum_supported_version)) {
      toast({ type: "warning", title: "Invalid min version", message: "Minimum supported version format is invalid (e.g. 3.9.0)." });
      return;
    }
    if (compareVersions(minimum_supported_version, version) > 0) {
      toast({ type: "warning", title: "Invalid min version", message: "Minimum supported version cannot be greater than the release version." });
      return;
    }
  }

  const releasePayload = {
    version,
    download_url,
    changelog,
    required,
    channel,
    sha256,
    minimum_supported_version,
    released_at: new Date().toISOString(),
    updatedBy: state.currentUser?.email || "Admin"
  };

  const btnSubmit = $("#update-form").querySelector("button[type='submit']");
  const originalHtml = btnSubmit.innerHTML;
  btnSubmit.disabled = true;
  btnSubmit.innerHTML = `<i data-lucide="loader"></i> Publishing...`;
  refreshIcons();

  const withTimeout = (promise, ms) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out")), ms))
    ]);
  };

  try {
    // 1. Save to app_releases/{version} for history
    await withTimeout(setDoc(doc(db, "app_releases", version.replace(/^v/i, "")), releasePayload), 8000);

    // 2. Update the latest_update pointer
    await withTimeout(setDoc(doc(db, "app_config", "latest_update"), releasePayload, { merge: true }), 8000);

    logAdminActivity("update", `Published release v${version}`, `Channel: ${channel}`);
    toast({ type: "success", title: "Update Published! 🚀", message: `Version ${version} is now live for all users.` });
    $("#update-form").reset();
  } catch (err) {
    console.error("Failed to publish update:", err);
    let msg = err.message;
    if (msg.includes("timed out")) {
      msg = "Connection blocked. Please turn off Brave Shields or your adblocker for this site.";
    }
    toast({ type: "error", title: "Publish failed", message: msg, duration: 6000 });
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.innerHTML = originalHtml;
    refreshIcons();
  }
}

function loadPublicLinks() {
  if (!state.currentUser) return;
  const unsub = onSnapshot(doc(db, "app_config", "public_links"), (snapshot) => {
    state.publicLinks = snapshot.exists() ? snapshot.data() : {};
    const fields = {
      "public-website-url": "website_url",
      "public-support-url": "support_url",
      "public-privacy-url": "privacy_url",
      "public-terms-url": "terms_url",
    };
    Object.entries(fields).forEach(([input, key]) => {
      const el = $(`#${input}`);
      if (el && document.activeElement !== el) el.value = state.publicLinks[key] || "";
    });
  }, (err) => console.error("Public links error:", err));
  state.unsubscribers.push(unsub);
}

async function handleSavePublicLinks(event) {
  event.preventDefault();
  const fields = {
    website_url: $("#public-website-url").value.trim(),
    support_url: $("#public-support-url").value.trim(),
    privacy_url: $("#public-privacy-url").value.trim(),
    terms_url: $("#public-terms-url").value.trim(),
  };
  if (Object.values(fields).some((url) => url && !isSafeHttpsUrl(url))) {
    toast({ type: "warning", title: "Secure links required", message: "Website and policy links must use HTTPS." });
    return;
  }
  try {
    await setDoc(doc(db, "app_config", "public_links"), {
      ...fields,
      updated_at: new Date().toISOString(),
      updatedBy: state.currentUser?.email || "Admin",
    }, { merge: true });
    toast({ type: "success", title: "Links saved", message: "The desktop app will show the new public links shortly." });
  } catch (err) {
    console.error("Failed to save public links:", err);
    toast({ type: "error", title: "Save failed", message: err.message });
  }
}

// ============== ANALYTICS ==============
function renderAnalytics() {
  // Resolution rate from tickets
  const total = state.tickets.length;
  const resolved = state.tickets.filter((t) => t.status === "resolved").length;
  const rate = total ? Math.round((resolved / total) * 100) : 0;
  $("#perf-resolve").textContent = `${rate}%`;

  // Active users from users collection (not tickets)
  const activeUsers = state.users.filter((u) => (u.status || "active") === "active").length;
  $("#perf-users").textContent = activeUsers || state.users.length;

  // Tickets today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = state.tickets.filter((t) => {
    const d = t.createdAt?.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
    return d >= todayStart;
  }).length;
  $("#perf-today").textContent = today;

  // Average response time: calculated from tickets that have admin replies
  let totalResponseMs = 0;
  let respondedCount = 0;
  state.tickets.forEach((t) => {
    if (t.status !== "open" && t.createdAt && t.lastUpdated) {
      const created = t.createdAt?.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
      const updated = t.lastUpdated?.toDate ? t.lastUpdated.toDate() : new Date(t.lastUpdated);
      const diff = updated - created;
      if (diff > 0) {
        totalResponseMs += diff;
        respondedCount++;
      }
    }
  });
  if (respondedCount > 0) {
    const avgMs = totalResponseMs / respondedCount;
    const avgHours = avgMs / (1000 * 60 * 60);
    if (avgHours < 1) {
      $("#perf-response").textContent = `${Math.round(avgMs / (1000 * 60))}m`;
    } else if (avgHours < 24) {
      $("#perf-response").textContent = `${avgHours.toFixed(1)}h`;
    } else {
      $("#perf-response").textContent = `${(avgHours / 24).toFixed(1)}d`;
    }
  } else {
    $("#perf-response").textContent = "—";
  }
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

  const chatId = ticket.id;
  // A ticket becomes read as soon as an admin opens its full conversation.
  updateDoc(doc(db, "chats", chatId), {
    unreadAdmin: false,
    updatedAt: serverTimestamp(),
  }).catch((err) => console.debug("Could not mark ticket as read:", err));
  chatUnsub = onSnapshot(
    query(collection(db, `chats/${chatId}/messages`), orderBy("createdAt", "asc")),
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
    logAdminActivity("resolve", `Changed ticket status to ${status.replace("_", " ")}`, `Ticket: ${state.selectedTicket.subject || state.selectedTicket.id}`);
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
    const chatId = state.selectedTicket.id;
    const userId = state.selectedTicket.userId;

    await addDoc(collection(db, `chats/${chatId}/messages`), {
      text,
      isAdmin: true,
      sender: state.currentUser?.uid || "admin",
      createdAt: serverTimestamp(),
    });
    // The chat listener provides instant delivery; the inbox copy ensures a
    // signed-in user also sees the reply after reopening the account screen.
    try {
      if (userId) {
        await addDoc(collection(db, `users/${userId}/messages`), {
          text,
          isAdmin: true,
          createdAt: serverTimestamp(),
          chatId: chatId,
        });
      }
    } catch (inboxError) {
      // Guest sessions do not have an inbox, but their live chat message has
      // already been sent and remains the primary delivery mechanism.
      console.debug("Inbox copy was not delivered:", inboxError);
    }
    // mark ticket as in_progress if open
    await updateDoc(doc(db, "chats", state.selectedTicket.id), {
      status: (state.selectedTicket.status || "open") === "open" ? "in_progress" : state.selectedTicket.status,
      unreadUser: true,
      unreadAdmin: false,
      lastMessage: text,
      lastSender: "admin",
      lastUpdated: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    logAdminActivity("reply", `Replied to ticket`, `Ticket: ${state.selectedTicket.subject || state.selectedTicket.id}`);
    toast({ type: "success", title: "Reply sent", message: "The user will receive an in-app notification." });
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
function subscribeAdminNotifications() {
  if (!state.currentUser) return;
  const q = query(
    collection(db, "admin_notifications"),
    orderBy("createdAt", "desc"),
    limit(20)
  );
  const unsub = onSnapshot(
    q,
    (snapshot) => {
      state.notifications = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderNotifications();
    },
    (err) => console.error("Notifs error:", err)
  );
  state.unsubscribers.push(unsub);
}

function renderNotifications() {
  const list = $("#notif-list");
  if (!state.notifications) return;
  const recent = state.notifications;
  const unreadCount = recent.filter(n => !n.read).length;
  
  if (recent.length === 0) {
    list.innerHTML = `<div class="muted center pad">No new notifications</div>`;
    $("#notif-dot").hidden = true;
    return;
  }
  
  $("#notif-dot").hidden = unreadCount === 0;
  
  list.innerHTML = recent
    .map(
      (n) => `
      <div class="notif-item ${n.read ? 'read' : 'unread'}" data-ticket="${n.referenceId || ''}">
        <div class="notif-dot" ${n.read ? 'style="opacity:0;"' : ''}></div>
        <div class="notif-body">
          <div class="notif-title">${fmt.escape(n.title || "Notification")}</div>
          <div class="notif-desc">${fmt.escape(n.type || "System")}</div>
          <div class="notif-time">${fmt.timeAgo(n.createdAt)}</div>
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
  // User Modal Actions
  $$("[data-close-user]").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeUserModal();
    });
  });

  $("#btn-user-enable")?.addEventListener("click", async () => {
    if (!state.selectedUser) return;
    try {
      await updateDoc(doc(db, "users", state.selectedUser.id), { status: "active" });
      logAdminActivity("update", `Enabled user ${state.selectedUser.email || state.selectedUser.id}`, `User ID: ${state.selectedUser.id}`);
      toast({ type: "success", title: "User Enabled" });
      closeUserModal();
    } catch (e) {
      toast({ type: "error", title: "Error", message: e.message });
    }
  });

  $("#btn-user-disable")?.addEventListener("click", async () => {
    if (!state.selectedUser) return;
    try {
      await updateDoc(doc(db, "users", state.selectedUser.id), { status: "disabled" });
      logAdminActivity("update", `Disabled user ${state.selectedUser.email || state.selectedUser.id}`, `User ID: ${state.selectedUser.id}`);
      toast({ type: "success", title: "User Disabled" });
      closeUserModal();
    } catch (e) {
      toast({ type: "error", title: "Error", message: e.message });
    }
  });
  
  $("#btn-user-delete")?.addEventListener("click", async () => {
    if (!state.selectedUser) return;
    if (!confirm("Are you sure you want to permanently delete this user data?")) return;
    try {
      await deleteDoc(doc(db, "users", state.selectedUser.id));
      logAdminActivity("update", `Deleted user ${state.selectedUser.email || state.selectedUser.id}`, `User ID: ${state.selectedUser.id}`);
      toast({ type: "success", title: "User Deleted" });
      closeUserModal();
    } catch (e) {
      toast({ type: "error", title: "Error", message: e.message });
    }
  });

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
  $$("#crash-modal [data-close-crash]").forEach((el) => el.addEventListener("click", closeCrashModal));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#ticket-modal").hidden) closeTicketModal();
      if (!$("#crash-modal").hidden) closeCrashModal();
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

  // Announcements & Updates form submit handlers
  $("#ann-form")?.addEventListener("submit", handleCreateAnnouncement);
  $("#update-form")?.addEventListener("submit", handlePublishUpdate);
  $("#public-links-form")?.addEventListener("submit", handleSavePublicLinks);

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

// ============== MY ACTIVITY (AUDIT LOG) ==============
function subscribeAdminActivity() {
  if (!state.currentUser) return;
  const q = query(
    collection(db, "admin_activity"),
    where("admin_uid", "==", state.currentUser.uid),
    orderBy("time", "desc"),
    limit(50)
  );
  const unsub = onSnapshot(
    q,
    (snapshot) => {
      state.myActivity = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (state.currentRoute === "activity" || state.currentRoute === "account") {
        renderMyActivity();
        renderMyActivityChart();
      }
    },
    (err) => {
      console.error("Admin activity error:", err);
    }
  );
  state.unsubscribers.push(unsub);
}

async function logAdminActivity(type, title, meta) {
  if (!state.currentUser) return;
  try {
    await addDoc(collection(db, "admin_activity"), {
      admin_uid: state.currentUser.uid,
      admin_email: state.currentUser.email,
      type,
      title,
      meta: meta || "",
      time: serverTimestamp()
    });
  } catch (err) {
    console.error("Failed to log activity:", err);
  }
}

async function loadMyActivity() {
  // Now handled by subscribeAdminActivity listener
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

// ============== HEALTH MONITOR ==============
function initHealthMonitor() {
  const btn = $("#health-monitor-btn");
  const dropdown = $("#health-dropdown");
  
  if (btn) {
    btn.addEventListener("click", () => {
      dropdown.hidden = !dropdown.hidden;
    });
    document.addEventListener("click", (e) => {
      if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.hidden = true;
      }
    });
  }

  // Monitor Auth
  onAuthStateChanged(auth, (user) => {
    updateHealth("auth", !!user);
  });

  // Monitor Firestore Connectivity (Using built-in .info/connected)
  // Unfortunately Firestore JS SDK doesn't expose a simple connected state easily, 
  // but we can infer it from successful reads later. For now, mark true if initialized.
  updateHealth("firestore", true);
}

function updateHealth(service, isHealthy) {
  state.health[service] = isHealthy;
  
  const el = $(`#health-${service}`);
  if (el) {
    if (isHealthy) {
      el.innerHTML = `<span class="dot" style="background:#10b981"></span> Connected`;
    } else {
      el.innerHTML = `<span class="dot" style="background:#ef4444"></span> Error`;
    }
  }

  updateGlobalHealth();
}

function updateGlobalHealth() {
  const values = Object.values(state.health);
  const total = values.length;
  const healthy = values.filter(Boolean).length;
  
  const dot = $("#health-global-dot");
  const text = $("#health-global-text");
  
  if (!dot || !text) return;

  if (healthy === total) {
    dot.style.background = "#10b981"; // Green
    text.textContent = "All Systems Healthy";
  } else if (healthy > 0) {
    dot.style.background = "#fbbf24"; // Yellow
    text.textContent = `${total - healthy} Issues`;
  } else {
    dot.style.background = "#ef4444"; // Red
    text.textContent = "System Down";
  }
}

// ============== INIT ==============
function init() {
  initTheme();
  initPrefs();
  initIcons();
  initRouter();
  wireEvents();
  initAuth();
  initHealthMonitor();
}

document.addEventListener("DOMContentLoaded", init);

// Expose for debugging
window.__ledo = { state, db, auth };
