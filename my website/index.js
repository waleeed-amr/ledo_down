import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getAuth, signInWithEmailAndPassword,
    sendPasswordResetEmail, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    getFirestore, collection, getDocs, addDoc, doc, setDoc, getDoc,
    serverTimestamp, query, orderBy, limit, onSnapshot, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ─── Firebase Config (from your project) ───
const firebaseConfig = {
    apiKey: "AIzaSyBWZx5WdJ8dJoI8nZlU1eA-OnOk91gj8Xk",
    authDomain: "group-a0ee4.firebaseapp.com",
    projectId: "group-a0ee4",
    storageBucket: "group-a0ee4.firebasestorage.app",
    messagingSenderId: "519444570577",
    appId: "1:519444570577:web:3a55d7010192e2ac2740f0",
    measurementId: "G-9TXCQ06MJM"
};

const VIRTUAL_DOMAIN = "@ledodown.local";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ─── DOM REFERENCES ───
const authView = document.getElementById('auth-view');
const dashboardView = document.getElementById('dashboard-view');
const authForm = document.getElementById('auth-form');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const authError = document.getElementById('auth-error');
const authSuccess = document.getElementById('auth-success');
const btnSubmitText = document.getElementById('btn-submit-text');
const btnSignIn = document.getElementById('btn-signin');
const btnForgotPassword = document.getElementById('btn-forgot-password');
const authSubtitle = document.getElementById('auth-subtitle');
const adminEmailDisplay = document.getElementById('admin-email-display');
const btnSignOut = document.getElementById('btn-signout');

const navItems = document.querySelectorAll('.nav-item');
const panels = document.querySelectorAll('.panel');

let cachedUsers = [];

// ─── SIDEBAR NAVIGATION ───
navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const targetId = item.dataset.target;
        if (!targetId) return;

        // Update active nav item
        navItems.forEach(n => n.classList.remove('active'));
        item.classList.add('active');

        // Show target panel, hide others
        panels.forEach(p => {
            if (p.id === targetId) {
                p.classList.remove('hidden');
                p.classList.add('active');
            } else {
                p.classList.add('hidden');
                p.classList.remove('active');
            }
        });

        // Update URL hash
        window.location.hash = targetId;

        // Load data for the target panel
        switch (targetId) {
            case 'panel-overview':
                loadOverviewStats();
                break;
            case 'panel-users':
                loadUsers();
                break;
            case 'panel-notifications':
                populateUserDropdown();
                break;
            case 'panel-chats':
                loadChats();
                break;
            case 'panel-crashes':
                loadCrashes();
                break;
            case 'panel-config':
                loadAppConfig();
                break;
        }
    });
});

// Handle URL hash on page load
function navigateToHash() {
    const hash = window.location.hash.replace('#', '');
    if (hash) {
        const targetNav = document.querySelector(`.nav-item[data-target="${hash}"]`);
        if (targetNav) {
            targetNav.click();
            return;
        }
    }
}

// Registration removed — admin accounts are created only from the database

function resolveEmail(input) {
    const clean = input.trim().toLowerCase();
    if (clean.includes('@')) {
        return clean;
    }
    return clean + VIRTUAL_DOMAIN;
}

// ─── AUTH ───
onAuthStateChanged(auth, (user) => {
    if (user) {
        authView.classList.add('hidden');
        dashboardView.classList.remove('hidden');
        const displayName = user.email ? user.email.replace(VIRTUAL_DOMAIN, '') : (user.displayName || 'admin');
        adminEmailDisplay.textContent = displayName;
        loadOverviewStats();
        // Navigate to hash if present
        navigateToHash();
    } else {
        authView.classList.remove('hidden');
        dashboardView.classList.add('hidden');
    }
});

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    authSuccess.style.display = 'none';

    const inputVal = loginUsername.value.trim();
    const password = loginPassword.value;

    if (!inputVal || !password) {
        authError.textContent = 'يرجى إدخال اسم المستخدم/البريد وكلمة المرور';
        return;
    }

    const email = resolveEmail(inputVal);

    btnSignIn.disabled = true;
    const origBtnText = btnSubmitText.textContent;
    btnSubmitText.textContent = 'جارِ التحقق...';

    try {
        await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
        authError.textContent = getAuthErrorMsg(err, email);
    } finally {
        btnSignIn.disabled = false;
        btnSubmitText.textContent = origBtnText;
    }
});

// Forgot Password
if (btnForgotPassword) {
    btnForgotPassword.addEventListener('click', async (e) => {
        e.preventDefault();
        authError.textContent = '';
        authSuccess.style.display = 'none';

        const inputVal = loginUsername.value.trim();
        if (!inputVal) {
            authError.textContent = 'اكتب اسم المستخدم أو البريد الإلكتروني أولاً في الحقل أعلاه';
            return;
        }

        const email = resolveEmail(inputVal);

        if (email.endsWith(VIRTUAL_DOMAIN)) {
            authError.textContent = 'حساب (@ledodown.local) ليس له بريد إلكتروني خارجي. تواصل مع مسؤول النظام لإعادة تعيين كلمة المرور.';
            return;
        }

        try {
            await sendPasswordResetEmail(auth, email);
            authSuccess.textContent = `تم إرسال رابط إعادة تعيين كلمة المرور إلى: ${email}`;
            authSuccess.style.display = 'block';
        } catch (err) {
            authError.textContent = getAuthErrorMsg(err, email);
        }
    });
}

btnSignOut.addEventListener('click', () => signOut(auth));

function getAuthErrorMsg(err, attemptedEmail) {
    const code = err.code || '';
    if (code.includes('user-not-found')) {
        return 'المستخدم غير موجود. تواصل مع مسؤول النظام لإنشاء حساب.';
    }
    if (code.includes('wrong-password') || code.includes('invalid-credential')) {
        return 'بيانات الدخول غير صحيحة (تأكد من اسم المستخدم وكلمة المرور).';
    }
    if (code.includes('too-many-requests')) {
        return 'تم حظر المحاولات مؤقتاً لكثرة المحاولات الخاطئة. انتظر دقيقة وحاول لاحقاً.';
    }
    if (code.includes('invalid-email')) {
        return 'صيغة البريد الإلكتروني غير صالحة.';
    }
    return err.message || 'حدث خطأ أثناء المصادقة.';
}

// ─── OVERVIEW STATS ───
async function loadOverviewStats() {
    try {
        const [usersSnap, crashesSnap, chatsSnap, heartbeatsSnap] = await Promise.all([
            getDocs(collection(db, "users")),
            getDocs(collection(db, "crash_reports")),
            getDocs(collection(db, "chats")),
            getDocs(collection(db, "heartbeats")),
        ]);
        document.getElementById('stat-users').textContent = usersSnap.size;
        document.getElementById('stat-crashes').textContent = crashesSnap.size;
        document.getElementById('stat-chats').textContent = chatsSnap.size;
        document.getElementById('stat-heartbeats').textContent = heartbeatsSnap.size;
    } catch (e) {
        console.error("Stats error:", e);
    }
}

// ─── USERS ───
async function loadUsers() {
    const tbody = document.getElementById('users-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">جارِ التحميل...</td></tr>';
    try {
        const snap = await getDocs(collection(db, "users"));
        cachedUsers = [];
        tbody.innerHTML = '';
        if (snap.empty) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-state">لا يوجد مستخدمين</td></tr>';
            return;
        }
        snap.forEach(docSnap => {
            const data = docSnap.data();
            const uid = docSnap.id;
            const username = data.username || data.email || uid.slice(0, 8);
            cachedUsers.push({ uid, username, data });

            const tr = document.createElement('tr');
            const avatarHtml = data.photoURL
                ? `<img src="${data.photoURL}" class="user-avatar" alt="avatar">`
                : `<div class="avatar-placeholder"><i class='bx bx-user'></i></div>`;
            tr.innerHTML = `
                <td>${escapeHtml(username)}</td>
                <td>${avatarHtml}</td>
                <td>${formatDate(data.createdAt)}</td>
                <td>
                    <button class="btn outline btn-sm btn-msg-user" data-uid="${uid}" data-name="${escapeHtml(username)}">
                        <i class='bx bx-envelope'></i> رسالة
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        // Attach per-user message button handlers
        document.querySelectorAll('.btn-msg-user').forEach(btn => {
            btn.addEventListener('click', () => {
                openSendUserMsgModal(btn.dataset.uid, btn.dataset.name);
            });
        });
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" class="error-text">خطأ في تحميل المستخدمين — تأكد من صلاحيات الأدمن</td></tr>';
        console.error(e);
    }
}

document.getElementById('btn-refresh-users').addEventListener('click', loadUsers);

// ─── SEND NOTIFICATION TO ALL USERS (as announcement) ───
const btnSendAll = document.getElementById('btn-send-all-notification');
const formSendAll = document.getElementById('form-send-all');
const btnCancelAll = document.getElementById('btn-cancel-all-notif');
const btnPublishAll = document.getElementById('btn-publish-all-notif');

btnSendAll.addEventListener('click', () => formSendAll.classList.toggle('hidden'));
btnCancelAll.addEventListener('click', () => formSendAll.classList.add('hidden'));

btnPublishAll.addEventListener('click', async () => {
    const title = document.getElementById('all-notif-title').value.trim();
    const body = document.getElementById('all-notif-body').value.trim();
    const type = document.getElementById('all-notif-type').value;
    const priority = document.getElementById('all-notif-priority').value;
    const actionUrl = document.getElementById('all-notif-url').value.trim();
    const statusEl = document.getElementById('all-notif-status');

    if (!title || !body) {
        statusEl.textContent = 'يرجى ملء العنوان والرسالة';
        statusEl.style.color = 'var(--error)';
        return;
    }

    btnPublishAll.disabled = true;
    statusEl.textContent = 'جارِ الإرسال...';
    statusEl.style.color = 'var(--text-muted)';

    try {
        // This creates an announcement that ALL users will see when they open the app
        // The app's announcements.js fetches from "announcements" collection with active=true
        await addDoc(collection(db, "announcements"), {
            title: title,
            body: body,
            type: type,
            priority: priority,
            active: true,
            action_url: actionUrl || null,
            action_label: actionUrl ? 'عرض التفاصيل' : null,
            created_at: new Date().toISOString(),
            createdAt: serverTimestamp()
        });

        statusEl.textContent = '✅ تم إرسال الإشعار لكل المستخدمين بنجاح!';
        statusEl.style.color = 'var(--success)';
        document.getElementById('all-notif-title').value = '';
        document.getElementById('all-notif-body').value = '';
        document.getElementById('all-notif-url').value = '';
        setTimeout(() => {
            statusEl.textContent = '';
            formSendAll.classList.add('hidden');
        }, 3000);
    } catch (e) {
        statusEl.textContent = 'خطأ: ' + e.message;
        statusEl.style.color = 'var(--error)';
    } finally {
        btnPublishAll.disabled = false;
    }
});

// ─── PER-USER MESSAGE (via users/{uid}/messages) ───
function openSendUserMsgModal(uid, name) {
    document.getElementById('modal-send-user-msg').classList.remove('hidden');
    document.getElementById('modal-user-name').textContent = `إرسال رسالة لـ: ${name}`;
    document.getElementById('modal-msg-uid').value = uid;
    document.getElementById('modal-msg-title').value = '';
    document.getElementById('modal-msg-body').value = '';
    document.getElementById('modal-msg-status').textContent = '';
}

document.getElementById('btn-modal-cancel').addEventListener('click', () => {
    document.getElementById('modal-send-user-msg').classList.add('hidden');
});

document.getElementById('btn-modal-send').addEventListener('click', async () => {
    const uid = document.getElementById('modal-msg-uid').value;
    const title = document.getElementById('modal-msg-title').value.trim();
    const body = document.getElementById('modal-msg-body').value.trim();
    const statusEl = document.getElementById('modal-msg-status');

    if (!title || !body) {
        statusEl.textContent = 'يرجى ملء العنوان والرسالة';
        statusEl.style.color = 'var(--error)';
        return;
    }

    try {
        // Write to users/{uid}/messages — this is the inbox that the app reads
        await addDoc(collection(db, "users", uid, "messages"), {
            title: title,
            body: body,
            createdAt: serverTimestamp(),
            read: false,
            from: 'admin'
        });

        statusEl.textContent = '✅ تم الإرسال بنجاح!';
        statusEl.style.color = 'var(--success)';
        setTimeout(() => {
            document.getElementById('modal-send-user-msg').classList.add('hidden');
        }, 1500);
    } catch (e) {
        statusEl.textContent = 'خطأ: ' + e.message;
        statusEl.style.color = 'var(--error)';
    }
});

// ─── NOTIFICATIONS PANEL (per-user dropdown) ───
function populateUserDropdown() {
    const select = document.getElementById('notif-user-select');
    select.innerHTML = '<option value="">-- اختر مستخدم --</option>';
    cachedUsers.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u.uid;
        opt.textContent = u.username;
        select.appendChild(opt);
    });
    // If users not loaded yet, load them first
    if (cachedUsers.length === 0) {
        loadUsers().then(() => populateUserDropdown());
    }
}

document.getElementById('btn-send-notif').addEventListener('click', async () => {
    const uid = document.getElementById('notif-user-select').value;
    const title = document.getElementById('notif-title').value.trim();
    const body = document.getElementById('notif-body').value.trim();
    const statusEl = document.getElementById('notif-status');

    if (!uid) { statusEl.textContent = 'اختر مستخدم'; statusEl.style.color = 'var(--error)'; return; }
    if (!title || !body) { statusEl.textContent = 'املأ العنوان والرسالة'; statusEl.style.color = 'var(--error)'; return; }

    try {
        await addDoc(collection(db, "users", uid, "messages"), {
            title, body,
            createdAt: serverTimestamp(),
            read: false,
            from: 'admin'
        });
        statusEl.textContent = '✅ تم إرسال الإشعار!';
        statusEl.style.color = 'var(--success)';
        document.getElementById('notif-title').value = '';
        document.getElementById('notif-body').value = '';
        setTimeout(() => statusEl.textContent = '', 3000);
    } catch (e) {
        statusEl.textContent = 'خطأ: ' + e.message;
        statusEl.style.color = 'var(--error)';
    }
});

// ─── SUPPORT CHATS ───
let activeChatUid = null;
let chatMessagesUnsubscribe = null;

async function loadChats() {
    const chatList = document.getElementById('chat-list');
    chatList.innerHTML = '<p class="empty-state">جارِ التحميل...</p>';
    try {
        const q = query(collection(db, "chats"), orderBy("lastUpdated", "desc"));
        const snap = await getDocs(q);
        chatList.innerHTML = '';
        if (snap.empty) {
            chatList.innerHTML = '<p class="empty-state">لا توجد محادثات</p>';
            return;
        }
        snap.forEach(docSnap => {
            const data = docSnap.data();
            const uid = docSnap.id;
            const div = document.createElement('div');
            div.className = 'chat-list-item';
            div.dataset.uid = uid;
            const email = data.email || uid.slice(0, 8);
            const displayName = email.replace(VIRTUAL_DOMAIN, '');
            const unread = data.unreadAdmin ? '<span class="chat-unread-dot"></span>' : '';
            div.innerHTML = `
                <h4>${escapeHtml(displayName)} ${unread}</h4>
                <p>${escapeHtml(data.lastMessage || '...')}</p>
            `;
            div.addEventListener('click', () => openChat(uid, displayName));
            chatList.appendChild(div);
        });
    } catch (e) {
        chatList.innerHTML = '<p class="error-text">خطأ في تحميل المحادثات</p>';
        console.error(e);
    }
}

document.getElementById('btn-refresh-chats').addEventListener('click', loadChats);

function openChat(uid, displayName) {
    activeChatUid = uid;

    // Highlight active
    document.querySelectorAll('.chat-list-item').forEach(item => {
        item.classList.toggle('active', item.dataset.uid === uid);
    });

    const messagesEl = document.getElementById('chat-messages');
    const inputArea = document.getElementById('chat-input-area');
    messagesEl.innerHTML = '<p class="empty-state">جارِ التحميل...</p>';
    inputArea.classList.remove('hidden');

    // Unsubscribe from previous listener
    if (chatMessagesUnsubscribe) chatMessagesUnsubscribe();

    // Real-time listener on messages subcollection
    const q = query(collection(db, "chats", uid, "messages"), orderBy("createdAt", "asc"));
    chatMessagesUnsubscribe = onSnapshot(q, (snapshot) => {
        messagesEl.innerHTML = '';
        if (snapshot.empty) {
            messagesEl.innerHTML = '<p class="empty-state">لا توجد رسائل</p>';
            return;
        }
        snapshot.forEach(docSnap => {
            const msg = docSnap.data();
            const isAdmin = msg.isAdmin === true;
            const bubble = document.createElement('div');
            bubble.className = `chat-bubble ${isAdmin ? 'admin' : 'user'}`;
            const time = msg.createdAt ? formatDate(msg.createdAt) : '';
            bubble.innerHTML = `
                <div>${escapeHtml(msg.text || '')}</div>
                <div class="bubble-time">${time}</div>
            `;
            messagesEl.appendChild(bubble);
        });
        messagesEl.scrollTop = messagesEl.scrollHeight;
    });

    // Mark as read by admin
    setDoc(doc(db, "chats", uid), { unreadAdmin: false }, { merge: true }).catch(() => {});
}

document.getElementById('btn-send-reply').addEventListener('click', sendChatReply);
document.getElementById('chat-reply-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatReply();
});

async function sendChatReply() {
    if (!activeChatUid) return;
    const input = document.getElementById('chat-reply-input');
    const text = input.value.trim();
    if (!text) return;

    try {
        await addDoc(collection(db, "chats", activeChatUid, "messages"), {
            text: text,
            sender: 'admin',
            isAdmin: true,
            createdAt: serverTimestamp()
        });

        // Update chat metadata
        await setDoc(doc(db, "chats", activeChatUid), {
            lastMessage: text,
            lastSender: 'admin',
            lastUpdated: serverTimestamp(),
            unreadUser: true,
            unreadAdmin: false
        }, { merge: true });

        input.value = '';
    } catch (e) {
        console.error("Reply error:", e);
    }
}

// ─── CRASH REPORTS ───
async function loadCrashes() {
    const tbody = document.getElementById('crashes-table-body');
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">جارِ التحميل...</td></tr>';
    try {
        const q = query(collection(db, "crash_reports"), orderBy("createdAt", "desc"), limit(100));
        const snap = await getDocs(q);
        tbody.innerHTML = '';
        if (snap.empty) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-state">لا توجد تقارير</td></tr>';
            return;
        }
        snap.forEach(docSnap => {
            const data = docSnap.data();
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${formatDate(data.createdAt)}</td>
                <td title="${escapeHtml(data.message || '')}">${escapeHtml((data.message || '').slice(0, 80))}</td>
                <td>${escapeHtml(data.error_category || data.category || '—')}</td>
                <td>
                    <button class="btn danger btn-sm btn-delete-crash" data-id="${docSnap.id}">
                        <i class='bx bx-trash'></i>
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        document.querySelectorAll('.btn-delete-crash').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (confirm('حذف هذا التقرير؟')) {
                    try {
                        await deleteDoc(doc(db, "crash_reports", btn.dataset.id));
                        loadCrashes();
                    } catch (e) { alert('خطأ: ' + e.message); }
                }
            });
        });
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" class="error-text">خطأ في تحميل التقارير</td></tr>';
        console.error(e);
    }
}

document.getElementById('btn-refresh-crashes').addEventListener('click', loadCrashes);

// ─── APP CONFIG ───
async function loadAppConfig() {
    try {
        // latest_update config
        const updateDoc = await getDoc(doc(db, "app_config", "latest_update"));
        if (updateDoc.exists()) {
            const d = updateDoc.data();
            document.getElementById('config-version').value = d.version || '';
            document.getElementById('config-download-url').value = d.download_url || '';
            document.getElementById('config-changelog').value = d.changelog || '';
            document.getElementById('config-required').checked = !!d.required;
        }

        // public_links config
        const linksDoc = await getDoc(doc(db, "app_config", "public_links"));
        if (linksDoc.exists()) {
            const l = linksDoc.data();
            document.getElementById('config-website-url').value = l.website_url || '';
            document.getElementById('config-privacy-url').value = l.privacy_url || '';
            document.getElementById('config-terms-url').value = l.terms_url || '';
            document.getElementById('config-support-url').value = l.support_url || '';
        }
    } catch (e) {
        console.error("Config load error:", e);
    }
}

document.getElementById('btn-save-config').addEventListener('click', async () => {
    const statusEl = document.getElementById('config-status');
    try {
        await setDoc(doc(db, "app_config", "latest_update"), {
            version: document.getElementById('config-version').value.trim(),
            download_url: document.getElementById('config-download-url').value.trim(),
            changelog: document.getElementById('config-changelog').value.trim(),
            required: document.getElementById('config-required').checked,
            updatedAt: serverTimestamp()
        }, { merge: true });
        statusEl.textContent = '✅ تم حفظ إعدادات التحديث';
        statusEl.style.color = 'var(--success)';
        setTimeout(() => statusEl.textContent = '', 3000);
    } catch (e) {
        statusEl.textContent = 'خطأ: ' + e.message;
        statusEl.style.color = 'var(--error)';
    }
});

document.getElementById('btn-save-links').addEventListener('click', async () => {
    const statusEl = document.getElementById('links-status');
    try {
        await setDoc(doc(db, "app_config", "public_links"), {
            website_url: document.getElementById('config-website-url').value.trim(),
            privacy_url: document.getElementById('config-privacy-url').value.trim(),
            terms_url: document.getElementById('config-terms-url').value.trim(),
            support_url: document.getElementById('config-support-url').value.trim(),
            updatedAt: serverTimestamp()
        }, { merge: true });
        statusEl.textContent = '✅ تم حفظ الروابط';
        statusEl.style.color = 'var(--success)';
        setTimeout(() => statusEl.textContent = '', 3000);
    } catch (e) {
        statusEl.textContent = 'خطأ: ' + e.message;
        statusEl.style.color = 'var(--error)';
    }
});

// ─── HELPERS ───
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

function formatDate(val) {
    if (!val) return '—';
    if (typeof val.toDate === 'function') return val.toDate().toLocaleString('ar-EG');
    if (val.seconds) return new Date(val.seconds * 1000).toLocaleString('ar-EG');
    const d = new Date(val);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('ar-EG');
}
