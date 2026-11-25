const API_URL = 'http://127.0.0.1:8000/api';
const WS_URL = 'ws://127.0.0.1:8000/ws';

// The window can render before the bundled Python service has finished starting.
// Share one readiness check and hold API traffic until the local engine is ready.
const backendReadyPromise = window.electronAPI?.ensureBackendReady
    ? window.electronAPI.ensureBackendReady().then(result => !!result?.success).catch(() => false)
    : Promise.resolve(true);

if (window.axios?.interceptors?.request) {
    axios.interceptors.request.use(async config => {
        const ready = await backendReadyPromise;
        if (!ready && /^https?:\/\/127\.0\.0\.1:8000\//.test(config.url || '')) {
            const error = new Error('محرك التحميل المحلي غير متاح. أعد تشغيل التطبيق وحاول مجددًا.');
            error.code = 'LOCAL_BACKEND_UNAVAILABLE';
            throw error;
        }
        return config;
    });
}

// Global Error Handlers for Crash Reporting
window.onerror = function(message, source, lineno, colno, error) {
    if (window.firebaseApp && window.firebaseApp.uploadCrashReport) {
        window.firebaseApp.uploadCrashReport(
            message.toString(),
            error ? error.stack : null,
            { source, lineno, colno }
        );
    }
};

window.addEventListener('unhandledrejection', function(event) {
    if (window.firebaseApp && window.firebaseApp.uploadCrashReport) {
        window.firebaseApp.uploadCrashReport(
            event.reason ? event.reason.toString() : 'Unhandled Rejection',
            event.reason && event.reason.stack ? event.reason.stack : null,
            { type: 'unhandledrejection' }
        );
    }
});

// WebSocket connection
let ws;

// Window focus tracking for notifications
let isAppFocused = true;
if (window.electronAPI && window.electronAPI.onWindowFocusChange) {
    window.electronAPI.onWindowFocusChange((focused) => {
        isAppFocused = focused;
    });
}

// Sync maximize button icon with actual window state
window.electronAPI?.onWindowMaximizedChange?.((isMaximized) => {
    const btn = document.getElementById('btn-maximize');
    if (!btn) return;
    const svg = btn.querySelector('svg');
    if (svg) {
        if (isMaximized) {
            // Restore icon (two overlapping squares)
            svg.innerHTML = '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
        } else {
            // Maximize icon (single square)
            svg.innerHTML = '<rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/>';
        }
    }
    btn.title = isMaximized ? 'Restore' : 'Maximize';
});

// ============================================
// SETTINGS MANAGEMENT
// ============================================
const DEFAULT_SETTINGS = {
    defaultSavePath: '',
    powerSaver: false,
    reduceHover: false,
    compactMode: false,
    theme: 'cyberpunk',
    customBackground: null,
    accentColor: '#3b82f6',
    defaultQuality: 'best',
    maxConcurrent: 3,
    speedLimit: 0,
    autoRetry: true,
    autoLaunch: true,
    smartClipboard: true,
    autoCategorize: true,
    completionNotif: true,
    completionSound: true,
    autoResume: true,
    closeToTray: true,
    openCompletedFolder: false
};

function loadSettings() {
    try {
        const saved = localStorage.getItem('ledo_settings');
        if (saved) {
            return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
        }
    } catch (e) {
        console.error('Failed to load settings', e);
    }
    return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
    try {
        localStorage.setItem('ledo_settings', JSON.stringify(settings));
    } catch (e) {
        console.error('Failed to save settings', e);
    }
}

let telegramPairingWatchTimer = null;

async function refreshTelegramSettings() {
    const status = document.getElementById('telegram-connection-status');
    if (!status || !window.electronAPI?.getTelegramConfig) return;
    const config = await window.electronAPI.getTelegramConfig().catch(() => null);
    if (!config) {
        status.textContent = 'تعذر قراءة حالة الربط.';
        return;
    }
    const disconnectButton = document.getElementById('btn-disconnect-telegram');
    if (disconnectButton) disconnectButton.hidden = !config.configured;
    const linkButton = document.getElementById('btn-auto-link-telegram');
    if (linkButton) linkButton.textContent = config.linked ? 'تغيير البوت' : 'ربط البوت وفتحه';
    if (!config.encryptionAvailable) {
        status.textContent = 'التخزين المشفّر غير متاح على هذا الجهاز؛ لن يُحفظ التوكن.';
        return;
    }
    status.textContent = config.awaitingPairing
        ? `افتح محادثة @${config.botUsername} واضغط «بدء» مرة واحدة لإكمال الربط.`
        : config.linked
            ? `@${config.botUsername} مربوط ومتاح لأي شخص يراسله في محادثة خاصة. شارك اسم البوت مع من تريد. ${config.pendingCount ? `يوجد ${config.pendingCount} ملف بانتظار الإرسال.` : 'أرسل /help لعرض الأوامر.'}`
            : config.configured
                ? 'التوكن محفوظ. اضغط «ربط البوت وفتحه» لإكمال الربط.'
                : 'الصق توكن البوت للبدء.';

    if (config.awaitingPairing && !telegramPairingWatchTimer) {
        telegramPairingWatchTimer = setInterval(async () => {
            const latest = await window.electronAPI.getTelegramConfig().catch(() => null);
            if (!latest?.awaitingPairing) {
                clearInterval(telegramPairingWatchTimer);
                telegramPairingWatchTimer = null;
                refreshTelegramSettings();
            }
        }, 2500);
    }
}

const TELEGRAM_ADMIN_DEFAULTS = {
    enabled: true, allowVideo: true, allowAudio: true, allowDirectFiles: true,
    allowMultipleLinks: true, maxLinks: 5, maxFileSizeMB: 50, pollIntervalSeconds: 3,
    videoQualities: ['best', '1080p', '720p', '480p', '360p'],
    audioFormats: ['audio-mp3', 'audio-m4a'], welcomeMessage: '', helpMessage: ''
};
let telegramAdminUnsubscribe = null;
let botActivityUnsubscribe = null;
let activeFirebaseUid = '';
let telegramUserReady = false;
const botActivityState = { items: [], unread: 0, lastSynced: new Map() };

function renderBotActivity() {
    const list = document.getElementById('bot-activity-list');
    const badge = document.getElementById('bot-activity-badge');
    if (badge) {
        badge.hidden = botActivityState.unread <= 0;
        badge.textContent = botActivityState.unread > 99 ? '99+' : String(botActivityState.unread);
    }
    if (!list) return;
    list.replaceChildren();
    if (!botActivityState.items.length) {
        const empty = document.createElement('div');
        empty.className = 'bot-activity-empty';
        empty.textContent = 'لا توجد تنزيلات من البوت حتى الآن.';
        list.appendChild(empty);
        return;
    }
    for (const item of botActivityState.items.slice(0, 30)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bot-activity-item';
        const icon = document.createElement('span');
        icon.className = 'bot-activity-icon';
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg>';
        const copy = document.createElement('span');
        copy.className = 'bot-activity-copy';
        const title = document.createElement('span');
        title.className = 'bot-activity-title';
        title.textContent = item.title || 'تنزيل من بوت تيليجرام';
        const meta = document.createElement('span');
        meta.className = 'bot-activity-meta';
        const statusLabel = item.status === 'completed' ? 'اكتمل' : item.status === 'error' ? 'فشل' : `جارٍ التنزيل ${Math.round(Number(item.progress) || 0)}٪`;
        meta.textContent = `${statusLabel} · ${item.updatedAt || 'الآن'}`;
        copy.append(title, meta);
        button.append(icon, copy);
        button.addEventListener('click', () => {
            document.getElementById('btn-bot-activity')?.click();
            document.getElementById('nav-downloads')?.click();
            setTimeout(() => document.getElementById(`dl-card-${item.downloadId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250);
        });
        list.appendChild(button);
    }
}

function updateBotActivity(download, { notify = false, sync = true } = {}) {
    if (!download?.id) return;
    const id = String(download.id);
    const title = String(download.filename || download.title || 'تنزيل من بوت تيليجرام');
    const existingIndex = botActivityState.items.findIndex(item => String(item.downloadId) === id);
    const item = {
        downloadId: id, title, status: download.status || 'starting',
        progress: Number(download.progress) || 0, updatedMs: Date.now(),
        updatedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    if (existingIndex >= 0) botActivityState.items.splice(existingIndex, 1);
    botActivityState.items.unshift(item);
    botActivityState.items = botActivityState.items.slice(0, 30);
    if (notify) botActivityState.unread += 1;
    renderBotActivity();
    if (notify) {
        const label = item.status === 'completed' ? 'اكتمل تنزيل البوت' : item.status === 'error' ? 'فشل تنزيل البوت' : 'بدأ تنزيل من البوت';
        showToast(`${label}: ${title}`, item.status === 'error' ? '#ef4444' : item.status === 'completed' ? '#10b981' : '#3b82f6', 6500);
        if ((!windowIsVisible || !isAppFocused) && appSettings.completionNotif !== false) {
            window.electronAPI?.showNotification?.('Ledo · Telegram Bot', `${label}: ${title}`);
        }
    }
    if (!sync || !telegramUserReady || !window.firebaseApp?.syncBotActivity) return;
    const previous = botActivityState.lastSynced.get(id);
    const progressBucket = Math.floor(item.progress / 10);
    const shouldSync = !previous || previous.status !== item.status || previous.progressBucket !== progressBucket || Date.now() - previous.at > 20000;
    if (!shouldSync) return;
    botActivityState.lastSynced.set(id, { status: item.status, progressBucket, at: Date.now() });
    window.firebaseApp.syncBotActivity(download, item.progress).catch(error => {
        const syncStatus = document.getElementById('bot-activity-sync-status');
        if (syncStatus) syncStatus.textContent = 'المزامنة غير متاحة الآن؛ سيبقى التنزيل ظاهرًا على هذا الجهاز.';
        console.debug('Telegram activity cloud sync skipped:', error.message);
    });
}

function applyTelegramAdminForm(settings = TELEGRAM_ADMIN_DEFAULTS) {
    const data = { ...TELEGRAM_ADMIN_DEFAULTS, ...(settings || {}) };
    const setChecked = (id, value) => { const el = document.getElementById(id); if (el) el.checked = value !== false; };
    setChecked('admin-bot-enabled', data.enabled);
    setChecked('admin-bot-video', data.allowVideo);
    setChecked('admin-bot-audio', data.allowAudio);
    setChecked('admin-bot-direct', data.allowDirectFiles);
    setChecked('admin-bot-multiple', data.allowMultipleLinks);
    const maxLinks = document.getElementById('admin-bot-max-links'); if (maxLinks) maxLinks.value = String(data.maxLinks || 5);
    const maxSize = document.getElementById('admin-bot-max-size'); if (maxSize) maxSize.value = String(data.maxFileSizeMB || 50);
    const poll = document.getElementById('admin-bot-poll'); if (poll) poll.value = String(data.pollIntervalSeconds || 3);
    document.querySelectorAll('[data-video-quality]').forEach(el => { el.checked = (data.videoQualities || TELEGRAM_ADMIN_DEFAULTS.videoQualities).includes(el.dataset.videoQuality); });
    document.querySelectorAll('[data-audio-format]').forEach(el => { el.checked = (data.audioFormats || TELEGRAM_ADMIN_DEFAULTS.audioFormats).includes(el.dataset.audioFormat); });
    const welcome = document.getElementById('admin-bot-welcome'); if (welcome) welcome.value = data.welcomeMessage || '';
    const help = document.getElementById('admin-bot-help'); if (help) help.value = data.helpMessage || '';
}

function collectTelegramAdminForm() {
    const checked = id => !!document.getElementById(id)?.checked;
    return {
        enabled: checked('admin-bot-enabled'), allowVideo: checked('admin-bot-video'), allowAudio: checked('admin-bot-audio'),
        allowDirectFiles: checked('admin-bot-direct'), allowMultipleLinks: checked('admin-bot-multiple'),
        maxLinks: Number(document.getElementById('admin-bot-max-links')?.value || 5),
        maxFileSizeMB: Number(document.getElementById('admin-bot-max-size')?.value || 50),
        pollIntervalSeconds: Number(document.getElementById('admin-bot-poll')?.value || 3),
        videoQualities: Array.from(document.querySelectorAll('[data-video-quality]:checked'), el => el.dataset.videoQuality),
        audioFormats: Array.from(document.querySelectorAll('[data-audio-format]:checked'), el => el.dataset.audioFormat),
        welcomeMessage: document.getElementById('admin-bot-welcome')?.value || '',
        helpMessage: document.getElementById('admin-bot-help')?.value || ''
    };
}

async function bindFirebaseBotSync(user) {
    const uid = user?.uid || '';
    if (uid === activeFirebaseUid && (telegramAdminUnsubscribe || botActivityUnsubscribe)) return;
    activeFirebaseUid = uid;
    telegramAdminUnsubscribe?.(); telegramAdminUnsubscribe = null;
    botActivityUnsubscribe?.(); botActivityUnsubscribe = null;
    telegramUserReady = !!user && !!window.firebaseApp;
    if (!telegramUserReady) return;
    telegramAdminUnsubscribe = window.firebaseApp.listenTelegramAdminSettings(async cloudSettings => {
        const effectiveSettings = { ...TELEGRAM_ADMIN_DEFAULTS, ...(cloudSettings || {}) };
        applyTelegramAdminForm(effectiveSettings);
        await window.electronAPI?.applyTelegramAdminSettings?.(effectiveSettings).catch(() => {});
        const stamp = cloudSettings?.updatedAt?.toDate?.();
        const syncTime = document.getElementById('telegram-admin-sync-time');
        if (syncTime) syncTime.textContent = stamp ? stamp.toLocaleString() : 'تمت المزامنة';
        const activityStatus = document.getElementById('bot-activity-sync-status');
        if (activityStatus) activityStatus.textContent = 'إعداداتك وسجل تنزيلات بوتك يتزامنان في مساحة Firebase الخاصة بك.';
    }, error => {
        const activityStatus = document.getElementById('bot-activity-sync-status');
        if (activityStatus) activityStatus.textContent = 'تعذر الاتصال بالمزامنة السحابية.';
        console.debug('Telegram bot config sync unavailable:', error.message);
    });
    botActivityUnsubscribe = window.firebaseApp.listenBotActivity(items => {
        const local = botActivityState.items;
        const cloud = items.map(item => ({
            downloadId: item.downloadId, title: item.title, status: item.status, progress: item.progress,
            updatedMs: item.updatedAt?.toDate?.().getTime?.() || Number(item.createdAtMs) || 0,
            updatedAt: item.updatedAt?.toDate?.().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || ''
        }));
        const merged = new Map([...local, ...cloud].map(item => [String(item.downloadId), item]));
        botActivityState.items = Array.from(merged.values()).sort((a, b) => (b.updatedMs || 0) - (a.updatedMs || 0)).slice(0, 30);
        renderBotActivity();
    }, error => console.debug('Telegram activity sync unavailable:', error.message));
    for (const item of botActivityState.items) {
        window.firebaseApp.syncBotActivity({
            id: item.downloadId, filename: item.title, status: item.status, progress: item.progress
        }, item.progress).catch(error => console.debug('Could not sync existing Telegram activity:', error.message));
    }
}

async function initializeFirebaseBotSync() {
    if (!window.firebaseApp) return;
    try {
        await window.firebaseApp.ready;
        await bindFirebaseBotSync(window.firebaseApp.auth.currentUser);
        window.firebaseApp.auth.onAuthStateChanged(user => bindFirebaseBotSync(user).catch(error => console.debug('Firebase bot sync rebind failed:', error)));
    } catch (error) {
        const status = document.getElementById('bot-activity-sync-status');
        if (status) status.textContent = 'المزامنة السحابية غير متاحة؛ ستظل التنبيهات على هذا الجهاز.';
    }
}

document.getElementById('btn-save-telegram-admin-settings')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const status = document.getElementById('telegram-admin-save-status');
    const settings = collectTelegramAdminForm();
    button.disabled = true;
    if (status) status.textContent = 'جارٍ حفظ إعدادات بوتك ومزامنتها…';
    try {
        if (!window.electronAPI?.applyTelegramAdminSettings) throw new Error('تعذر حفظ الإعدادات على هذا الجهاز.');
        await window.electronAPI.applyTelegramAdminSettings(settings);
        try {
            if (!window.firebaseApp?.setTelegramAdminSettings) throw new Error('Firebase غير متصل.');
            await window.firebaseApp.setTelegramAdminSettings(settings);
            if (status) status.textContent = 'تم حفظ إعدادات بوتك ومزامنتها مع نسخ التطبيق المرتبطة بحسابك.';
        } catch (syncError) {
            if (status) status.textContent = `تم الحفظ على هذا الجهاز؛ تعذرت المزامنة السحابية الآن (${syncError.message || 'تحقق من الاتصال'}).`;
        }
    } catch (error) {
        if (status) status.textContent = error.message || 'تعذر حفظ إعدادات البوت.';
    } finally { button.disabled = false; }
});

document.getElementById('btn-bot-activity')?.addEventListener('click', event => {
    const button = event.currentTarget;
    const popover = document.getElementById('bot-activity-popover');
    const open = popover.hidden;
    popover.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) { botActivityState.unread = 0; renderBotActivity(); }
});
document.getElementById('btn-clear-bot-activity')?.addEventListener('click', () => { botActivityState.unread = 0; renderBotActivity(); });
document.addEventListener('click', event => {
    const menu = document.querySelector('.bot-activity-menu');
    if (menu && !menu.contains(event.target)) {
        const popover = document.getElementById('bot-activity-popover');
        popover.hidden = true;
        document.getElementById('btn-bot-activity')?.setAttribute('aria-expanded', 'false');
    }
});
initializeFirebaseBotSync();

document.getElementById('btn-auto-link-telegram')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const tokenInput = document.getElementById('telegram-bot-token');
    button.disabled = true;
    try {
        const result = await window.electronAPI?.beginTelegramPairing?.({ token: tokenInput?.value || '' });
        if (!result?.success) throw new Error(result?.error || 'تعذر بدء الربط التلقائي.');
        const opened = await window.electronAPI?.openExternal?.(result.link);
        if (!opened) throw new Error('تم حفظ التوكن، لكن تعذر فتح رابط البوت. افتح الرابط من تيليجرام يدويًا.');
        if (tokenInput) tokenInput.value = '';
        await refreshTelegramSettings();
        showToast('افتح محادثة البوت واضغط «بدء» لإكمال الربط.', '#10b981', 7000);
    } catch (error) {
        showToast(error.message || 'تعذر بدء الربط التلقائي.', '#ef4444', 7000);
    } finally { button.disabled = false; }
});

document.getElementById('btn-disconnect-telegram')?.addEventListener('click', async () => {
    await window.electronAPI?.disconnectTelegram?.();
    document.getElementById('telegram-bot-token').value = '';
    await refreshTelegramSettings();
    showToast('تم إلغاء ربط تيليجرام وحذف الطلبات المعلّقة.', '#f59e0b');
});

refreshTelegramSettings();

let appSettings = loadSettings();
if (!['light', 'cyberpunk'].includes(appSettings.theme)) {
    appSettings.theme = 'cyberpunk';
    saveSettings(appSettings);
}

window.electronAPI?.onSmartPasteDetected?.(async (rawUrl) => {
    const url = String(rawUrl || '').trim();
    if (!url) {
        window.electronAPI?.dismissSmartPaste?.();
        return;
    }

    try {
        const result = await Swal.fire({
            icon: 'question',
            title: 'رابط جاهز للتحميل',
            html: '<p class="smart-paste-copy">لقيت رابط وسائط في الحافظة. تحب أجهزهولك؟</p><div class="smart-paste-url"></div>',
            showCancelButton: true,
            confirmButtonText: 'جلب الرابط',
            cancelButtonText: 'مش دلوقتي',
            reverseButtons: true,
            buttonsStyling: false,
            heightAuto: false,
            customClass: {
                popup: 'premium-swal smart-paste-popup',
                title: 'smart-paste-title',
                confirmButton: 'btn-primary-swal',
                cancelButton: 'btn-danger-swal'
            },
            didOpen: (popup) => {
                const urlBox = popup.querySelector('.smart-paste-url');
                if (urlBox) urlBox.textContent = url;
            }
        });

        if (result.isConfirmed) {
            const input = document.getElementById('url-input');
            if (input) {
                input.value = url;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('btn-fetch-info')?.click();
            }
        }
    } finally {
        window.electronAPI?.dismissSmartPaste?.();
    }
});

function applySettings() {
    document.body.classList.toggle('power-saver', !!appSettings.powerSaver);
    document.body.classList.toggle('reduce-hover', !!appSettings.reduceHover);
    document.body.classList.toggle('compact-mode', !!appSettings.compactMode);
    // Checkboxes
    const cbPower = document.getElementById('checkbox-power-saver');
    const cbHover = document.getElementById('checkbox-reduce-hover');
    const cbCompact = document.getElementById('checkbox-compact-mode');
    if (cbPower) cbPower.checked = appSettings.powerSaver;
    if (cbHover) cbHover.checked = appSettings.reduceHover;
    if (cbCompact) cbCompact.checked = appSettings.compactMode;

    // Compact Mode
    if (appSettings.compactMode) {
        document.body.classList.add('compact-mode');
    } else {
        document.body.classList.remove('compact-mode');
    }

    // Only the two user-facing themes remain: the selected Cyberpunk theme and Light.
    document.body.classList.remove('theme-light', 'theme-amoled', 'theme-cyberpunk');
    document.body.classList.add(appSettings.theme === 'light' ? 'theme-light' : 'theme-cyberpunk');
    document.querySelectorAll('.theme-card-option').forEach(card => {
        card.classList.toggle('active', card.getAttribute('data-theme-val') === appSettings.theme);
    });
    const lightThemeButton = document.getElementById('btn-theme-light');
    const cyberpunkThemeButton = document.getElementById('btn-theme-cyberpunk');
    lightThemeButton?.classList.toggle('is-active', appSettings.theme === 'light');
    cyberpunkThemeButton?.classList.toggle('is-active', appSettings.theme === 'cyberpunk');
    lightThemeButton?.setAttribute('aria-pressed', appSettings.theme === 'light' ? 'true' : 'false');
    cyberpunkThemeButton?.setAttribute('aria-pressed', appSettings.theme === 'cyberpunk' ? 'true' : 'false');
    if (appSettings.accentColor) {
        document.documentElement.style.setProperty('--accent-primary', appSettings.accentColor);
    }

    // Custom Background
    const btnClearBg = document.getElementById('btn-settings-clear-bg');
    if (appSettings.customBackground) {
        const backgroundImage = `url("${appSettings.customBackground}")`;
        document.body.style.setProperty('background-image', backgroundImage, 'important');
        document.documentElement.style.setProperty('--app-background-image', backgroundImage);
        document.body.classList.add('has-custom-background');
        if (btnClearBg) btnClearBg.style.display = 'block';
    } else {
        document.body.style.backgroundImage = "url('vendor/bg.jpg')";
        document.documentElement.style.removeProperty('--app-background-image');
        document.body.classList.remove('has-custom-background');
        if (btnClearBg) btnClearBg.style.display = 'none';
    }

    // Settings path display
    const pathText = document.getElementById('settings-path-text');
    if (pathText) pathText.textContent = appSettings.defaultSavePath;

    // Update save path display in downloads view
    updateSavePathDisplay();
}

// Update the displayed active save path
function updateSavePathDisplay() {
    const display = document.getElementById('selected-path-display');
    const span = document.getElementById('active-save-path');
    if (display && span) {
        if (customSavePath) {
            span.textContent = customSavePath + '  (one-time override)';
        } else {
            span.textContent = appSettings.defaultSavePath;
        }
        display.style.display = 'block';
    }
}

// Initialize Vanta.js background (if not power saver)
let vantaEffect = null;
function initVanta() {
    // Disabled Vanta in favor of a static abstract background image
    // This saves significant CPU/GPU power and looks much better for glassmorphism
    if (vantaEffect) {
        try { vantaEffect.destroy(); } catch (e) { }
        vantaEffect = null;
    }
}

// Initialize settings on load
document.addEventListener('DOMContentLoaded', async () => {
    // Load default path dynamically if not set or if it's the old hardcoded value
    if (!appSettings.defaultSavePath || appSettings.defaultSavePath === 'C:\\Users\\z\\Desktop' || appSettings.defaultSavePath === 'C:\\Users\\walee\\Desktop') {
        try {
            if (window.electronAPI && window.electronAPI.getDefaultPath) {
                appSettings.defaultSavePath = await window.electronAPI.getDefaultPath();
                saveSettings(appSettings);
            }
        } catch (e) {
            console.error("Failed to fetch default path", e);
        }
    }

    applySettings();
    initVanta();

    // ── Startup overlay: hide smoothly once backend is ready ──
    const _startupOverlay = document.getElementById('startup-overlay');
    const _startupStatus = document.getElementById('startup-status-text');
    if (_startupOverlay) {
        window.electronAPI?.onBackendStartupProgress?.((data) => {
            if (_startupStatus) {
                if (data?.status === 'starting') _startupStatus.textContent = 'Starting download engine…';
                else if (data?.status === 'ready') _startupStatus.textContent = 'Ready!';
            }
        });
        backendReadyPromise.then(() => {
            if (_startupStatus) _startupStatus.textContent = 'Ready!';
            _startupOverlay.classList.add('backend-ready');
            setTimeout(() => {
                if (_startupOverlay) {
                    _startupOverlay.classList.add('hidden');
                    setTimeout(() => { if (_startupOverlay && _startupOverlay.parentNode) _startupOverlay.remove(); }, 500);
                }
            }, 300);
        }).catch(() => {
            if (_startupStatus) _startupStatus.textContent = 'Engine error — restart app';
            setTimeout(() => {
                if (_startupOverlay) _startupOverlay.classList.add('hidden');
            }, 3000);
        });
        if (!window.electronAPI) {
            _startupOverlay.classList.add('hidden');
        }
    }

    // Initialize Lucide Icons
    if (window.lucide) lucide.createIcons();

    // Initialize Tippy.js for Tooltips
    if (window.tippy) {
        tippy('[title]', {
            content(reference) {
                const title = reference.getAttribute('title');
                reference.removeAttribute('title');
                return title;
            },
            animation: 'scale',
            theme: 'translucent',
            arrow: true
        });
    }

    // Initialize SortableJS
    const listEl = document.getElementById('downloads-list');
    if (listEl && window.Sortable) {
        new Sortable(listEl, {
            animation: 150,
            handle: '.dl-header',
            ghostClass: 'sortable-ghost'
        });
    }

    // Fetch initial downloads state from backend
    refreshDownloads();
});

// Settings Event Listeners
document.getElementById('checkbox-power-saver')?.addEventListener('change', (e) => {
    appSettings.powerSaver = e.target.checked;
    saveSettings(appSettings);
    applySettings();
    showToast(
        e.target.checked
            ? 'تم تفعيل توفير الطاقة: أُوقفت تأثيرات الزجاج والحركة وخُفّض تحديث الرسوم.'
            : 'تم إيقاف وضع توفير الطاقة واستعادة تأثيرات الواجهة.',
        e.target.checked ? '#10b981' : '#6366f1',
        4500
    );
});

document.getElementById('checkbox-reduce-hover')?.addEventListener('change', (e) => {
    appSettings.reduceHover = e.target.checked;
    document.body.classList.toggle('reduce-hover', e.target.checked);
    saveSettings(appSettings);
    applySettings();
    showToast(e.target.checked ? 'Hover Effects: Reduced' : 'Hover Effects: Normal', '#6366f1');
});

document.getElementById('checkbox-compact-mode')?.addEventListener('change', (e) => {
    appSettings.compactMode = e.target.checked;
    document.body.classList.toggle('compact-mode', e.target.checked);
    saveSettings(appSettings);
    applySettings();
    showToast(e.target.checked ? 'Compact Mode: ON' : 'Compact Mode: OFF', '#3b82f6');
});

document.getElementById('btn-settings-theme')?.addEventListener('click', (e) => {
    e.preventDefault();
    appSettings.theme = appSettings.theme === 'dark' ? 'light' : 'dark';
    saveSettings(appSettings);
    applySettings();
    initVanta();
    showToast(`Theme changed to ${appSettings.theme}`, '#3b82f6');
});

document.getElementById('btn-settings-change-path')?.addEventListener('click', async () => {
    const path = await window.electronAPI.selectFolder();
    if (path) {
        appSettings.defaultSavePath = path;
        saveSettings(appSettings);
        applySettings();
        if (typeof syncSettingsWithBackend === 'function') {
            syncSettingsWithBackend();
        }
        showToast('Default save path updated!', '#10b981');
    }
});

document.getElementById('btn-restore-defaults')?.addEventListener('click', async () => {
    if (window.Swal) {
        Swal.fire({
            title: 'Are you sure?',
            text: "You want to restore all settings to default?",
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Yes, restore it!',
            customClass: { popup: 'premium-swal', confirmButton: 'btn-primary-swal', cancelButton: 'btn-danger-swal' },
            buttonsStyling: false
        }).then(async (result) => {
            if (result.isConfirmed) {
                const defaultPath = await window.electronAPI?.getDefaultPath?.().catch(() => '') || '';
                appSettings = { ...DEFAULT_SETTINGS, defaultSavePath: defaultPath };
                saveSettings(appSettings);
                customSavePath = null;
                applySettings();
                if (window.electronAPI?.setSmartClipboard) window.electronAPI.setSmartClipboard(true);
                if (window.electronAPI?.setAutoLaunch) await window.electronAPI.setAutoLaunch(true);
                if (window.electronAPI?.setCloseToTray) await window.electronAPI.setCloseToTray(true);
                syncSettingsUI();
                syncSettingsWithBackend();
                showToast('Settings restored to defaults!', '#f59e0b');
            }
        });
    } else {
        if (confirm('Are you sure you want to restore all settings to default?')) {
            const defaultPath = await window.electronAPI?.getDefaultPath?.().catch(() => '') || '';
            appSettings = { ...DEFAULT_SETTINGS, defaultSavePath: defaultPath };
            saveSettings(appSettings);
            customSavePath = null;
            applySettings();
            if (window.electronAPI?.setSmartClipboard) window.electronAPI.setSmartClipboard(true);
            if (window.electronAPI?.setAutoLaunch) await window.electronAPI.setAutoLaunch(true);
            if (window.electronAPI?.setCloseToTray) await window.electronAPI.setCloseToTray(true);
            syncSettingsUI();
            syncSettingsWithBackend();
            initVanta();
            showToast('Settings restored to defaults!', '#f59e0b');
        }
    }
});

// Custom Background Upload Logic
document.getElementById('btn-settings-upload-bg')?.addEventListener('click', () => {
    document.getElementById('bg-upload-input').click();
});

document.getElementById('bg-upload-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const imageData = event.target.result;
        const preview = new Image();
        preview.onload = () => {
            appSettings.customBackground = imageData; // base64 string
            saveSettings(appSettings);
            applySettings();
            showToast('Custom background updated!', '#10b981');
            e.target.value = '';
        };
        preview.onerror = () => {
            showToast('تعذر تحميل الصورة. اختار صورة بصيغة مدعومة.', '#ef4444');
            e.target.value = '';
        };
        preview.src = imageData;
    };
    reader.readAsDataURL(file);
});

document.getElementById('btn-settings-clear-bg')?.addEventListener('click', () => {
    appSettings.customBackground = null;
    saveSettings(appSettings);
    applySettings();
    showToast('Custom background cleared!', '#f59e0b');
});

// ============================================
// SETTINGS TAB SWITCHING
// ============================================
function activateSettingsTab(tabId) {
    // Toggle tab buttons
    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
        const isTarget = btn.getAttribute('data-settings-tab') === tabId;
        btn.classList.toggle('active', isTarget);
        btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
        btn.setAttribute('tabindex', isTarget ? '0' : '-1');
    });

    // Toggle tab pages
    document.querySelectorAll('.settings-tab-page').forEach(page => {
        page.classList.toggle('active', page.id === `tab-${tabId}`);
    });

    // Re-render icons in the newly visible tab
    if (window.lucide) lucide.createIcons();
}

// Attach click listeners to all settings tab buttons
document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tabId = btn.getAttribute('data-settings-tab');
        if (tabId) activateSettingsTab(tabId);
    });
});

// Keyboard accessibility for tab navigation (arrow keys)
document.querySelector('.settings-nav-tabs')?.addEventListener('keydown', (e) => {
    const tabs = Array.from(document.querySelectorAll('.settings-tab-btn'));
    const currentIdx = tabs.indexOf(document.activeElement);
    if (currentIdx === -1) return;

    let newIdx = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        // RTL layout: ArrowRight goes backwards, ArrowLeft goes forward
        const dir = e.key === 'ArrowRight' ? -1 : 1;
        newIdx = (currentIdx + dir + tabs.length) % tabs.length;
    }
    if (newIdx >= 0) {
        e.preventDefault();
        tabs[newIdx].focus();
        tabs[newIdx].click();
    }
});

// ============================================
// THEME CARD SELECTION
// ============================================
function setAppTheme(theme) {
    if (!['light', 'cyberpunk'].includes(theme)) return;
    appSettings.theme = theme;
    saveSettings(appSettings);
    applySettings();
    initVanta();
    showToast('تم تغيير الثيم', theme === 'light' ? '#2563eb' : '#a855f7');
}

document.querySelectorAll('.theme-card-option').forEach(card => {
    card.addEventListener('click', () => {
        const themeVal = card.getAttribute('data-theme-val');
        setAppTheme(themeVal);
    });
});

// ============================================
// ACCENT COLOR SELECTION
// ============================================
document.querySelectorAll('.accent-color-circle').forEach(circle => {
    circle.addEventListener('click', () => {
        const color = circle.getAttribute('data-color');
        if (!color) return;

        // Update active state
        document.querySelectorAll('.accent-color-circle').forEach(c => c.classList.remove('active'));
        circle.classList.add('active');

        // Apply accent color CSS variable
        document.documentElement.style.setProperty('--accent-primary', color);
        appSettings.accentColor = color;
        saveSettings(appSettings);

        showToast('تم تغيير اللون الأساسي', color);
    });
});

// ============================================
// BACKEND SETTINGS SYNC & NOTIFICATION SOUND
// ============================================
async function syncSettingsWithBackend() {
    try {
        const speedLimitKbps = (appSettings.speedLimit || 0) * 1024; // MB/s to KB/s
        const maxConcurrent = appSettings.maxConcurrent || 3;
        const autoCategorize = appSettings.autoCategorize !== false;
        const downloadPath = appSettings.defaultSavePath || null;
        await axios.post(`${API_URL}/settings`, {
            speed_limit_kbps: speedLimitKbps,
            max_concurrent: maxConcurrent,
            auto_categorize: autoCategorize,
            download_path: downloadPath
        }, { timeout: 3000 });
    } catch (e) {
        if (e.code !== 'LOCAL_BACKEND_UNAVAILABLE') {
            console.warn("Could not sync settings with backend:", e);
        }
    }
}

function playNotificationSound() {
    try {
        const audio = new Audio('vendor/notification.wav');
        audio.volume = 0.6;
        const playPromise = audio.play();
        if (playPromise === undefined) return Promise.resolve(true);
        return playPromise.then(() => true).catch(async (firstError) => {
            try {
                const audio2 = new Audio('vendor/notification.mp3');
                audio2.volume = 0.6;
                await audio2.play();
                return true;
            } catch (fallbackError) {
                console.warn('Notification sound playback failed:', firstError, fallbackError);
                return false;
            }
        });
    } catch (e) {
        console.warn("Notification audio error:", e);
        return Promise.resolve(false);
    }
}

// ============================================
// CONCURRENT DOWNLOADS PILLS
// ============================================
document.querySelectorAll('#pills-concurrent-downloads .segmented-pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#pills-concurrent-downloads .segmented-pill-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        appSettings.maxConcurrent = parseInt(btn.getAttribute('data-val')) || 3;
        saveSettings(appSettings);
        syncSettingsWithBackend();
        showToast(`أقصى عدد تحميلات متزامنة: ${appSettings.maxConcurrent}`, '#3b82f6');
    });
});

// ============================================
// DEFAULT QUALITY & SPEED LIMIT SELECTS
// ============================================
document.getElementById('settings-default-quality')?.addEventListener('change', (e) => {
    appSettings.defaultQuality = e.target.value;
    saveSettings(appSettings);
    showToast('تم تحديث جودة الفيديو الافتراضية', '#a855f7');
});

document.getElementById('settings-speed-limit')?.addEventListener('change', (e) => {
    appSettings.speedLimit = parseInt(e.target.value) || 0;
    saveSettings(appSettings);
    syncSettingsWithBackend();
    const label = e.target.value === '0' ? 'بلا حد' : `${e.target.value} ميجابايت/ث`;
    showToast(`حد السرعة: ${label}`, '#f59e0b');
});

// ============================================
// ADDITIONAL SETTINGS CHECKBOXES
// ============================================
const settingsCheckboxes = [
    { id: 'checkbox-auto-retry', key: 'autoRetry', msgOn: 'إعادة المحاولة التلقائية: مفعّلة', msgOff: 'إعادة المحاولة التلقائية: معطّلة' },
    { id: 'checkbox-auto-launch', key: 'autoLaunch', msgOn: 'التشغيل التلقائي: مفعّل', msgOff: 'التشغيل التلقائي: معطّل' },
    { id: 'checkbox-smart-clipboard', key: 'smartClipboard', msgOn: 'مراقب الحافظة الذكي: مفعّل', msgOff: 'مراقب الحافظة الذكي: معطّل' },
    { id: 'checkbox-auto-categorize', key: 'autoCategorize', msgOn: 'تنظيم الملفات تلقائياً: مفعّل', msgOff: 'تنظيم الملفات تلقائياً: معطّل' },
    { id: 'checkbox-completion-notif', key: 'completionNotif', msgOn: 'إشعارات الاكتمال: مفعّلة', msgOff: 'إشعارات الاكتمال: معطّلة' },
    { id: 'checkbox-completion-sound', key: 'completionSound', msgOn: 'نغمة الاكتمال: مفعّلة', msgOff: 'نغمة الاكتمال: معطّلة' },
    { id: 'checkbox-auto-resume', key: 'autoResume', msgOn: 'الاستئناف التلقائي: مفعّل', msgOff: 'الاستئناف التلقائي: معطّل' },
    { id: 'checkbox-close-to-tray', key: 'closeToTray', msgOn: 'زر الإغلاق يصغّر التطبيق إلى شريط المهام', msgOff: 'زر الإغلاق ينهي التطبيق' },
    { id: 'checkbox-open-completed-folder', key: 'openCompletedFolder', msgOn: 'سيتم فتح مكان الملف بعد اكتمال التنزيل', msgOff: 'فتح مكان الملف تلقائيًا: معطّل' }
];

settingsCheckboxes.forEach(({ id, key, msgOn, msgOff }) => {
    document.getElementById(id)?.addEventListener('change', async (e) => {
        const val = e.target.checked;
        appSettings[key] = val;
        saveSettings(appSettings);

        if (key === 'smartClipboard' && window.electronAPI && window.electronAPI.setSmartClipboard) {
            window.electronAPI.setSmartClipboard(val);
        }
        if (key === 'closeToTray' && window.electronAPI?.setCloseToTray) {
            try {
                const result = await window.electronAPI.setCloseToTray(val);
                if (!result?.success) throw new Error(result?.error || 'تعذر حفظ إعداد الإغلاق.');
            } catch (error) {
                e.target.checked = !val;
                appSettings.closeToTray = !val;
                saveSettings(appSettings);
                showToast(error.message || 'تعذر حفظ إعداد الإغلاق.', '#ef4444');
                return;
            }
        }
        if (key === 'autoLaunch' && window.electronAPI && window.electronAPI.setAutoLaunch) {
            try {
                const result = await window.electronAPI.setAutoLaunch(val);
                if (!result?.available || result.enabled !== val) {
                    const actual = !!result?.enabled;
                    e.target.checked = actual;
                    appSettings.autoLaunch = actual;
                    saveSettings(appSettings);
                    showToast('تعذر تغيير التشغيل التلقائي في هذه النسخة.', '#ef4444');
                    return;
                }
            } catch (error) {
                e.target.checked = !val;
                appSettings.autoLaunch = !val;
                saveSettings(appSettings);
                showToast('تعذر تغيير إعداد بدء التشغيل.', '#ef4444');
                return;
            }
        }
        if (key === 'autoCategorize') {
            syncSettingsWithBackend();
        }
        showToast(val ? msgOn : msgOff, '#6366f1');
    });
});

// ============================================
// OPEN FOLDER & EXTENSION BUTTONS
// ============================================
document.getElementById('btn-install-extension')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const oldHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader" class="spinner"></i> جاري فتح ملفات الإضافة...';
    if (window.lucide) lucide.createIcons();
    try {
        const result = await window.electronAPI?.openExtensionSetup?.();
        if (!result?.success) throw new Error(result?.error || 'تعذر فتح صفحة الإضافة أو مجلدها.');
        showToast(`فتح ${result.browser} ومجلد الإضافة. فعّل وضع المطوّر ثم اختر Load unpacked.`, '#10b981');
    } catch (error) {
        console.error('Extension setup failed:', error);
        showToast(error.message || 'تعذر إعداد الإضافة.', '#ef4444');
    } finally {
        btn.disabled = false;
        btn.innerHTML = oldHTML;
        if (window.lucide) lucide.createIcons();
    }
});

document.getElementById('btn-settings-open-folder')?.addEventListener('click', async () => {
    const folderPath = appSettings.defaultSavePath;
    if (!folderPath) {
        showToast('لم يتم تحديد مجلد التحميل بعد', '#f59e0b');
        return;
    }
    try {
        if (!window.electronAPI?.openPath) throw new Error('فتح المجلد غير متاح.');
        const error = await window.electronAPI.openPath(folderPath);
        if (error) throw new Error(error);
        showToast('تم فتح مجلد الحفظ.', '#10b981');
    } catch (error) {
        showToast(`تعذر فتح المجلد: ${error.message || error}`, '#ef4444');
    }
});

document.getElementById('btn-open-extension-folder')?.addEventListener('click', async () => {
    try {
        if (!window.electronAPI?.openExtensionFolder) throw new Error('فتح مجلد الإضافة غير متاح.');
        const result = await window.electronAPI.openExtensionFolder();
        if (!result?.success) throw new Error(result?.error || 'تعذر فتح مجلد الإضافة.');
        showToast('تم فتح مجلد الإضافة.', '#10b981');
    } catch (error) {
        showToast(error.message || 'تعذر فتح مجلد الإضافة.', '#ef4444');
    }
});

document.getElementById('btn-test-extension-conn')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-extension-conn');
    const oldHTML = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader" class="spinner"></i> جاري الفحص...';
    btn.disabled = true;
    if (window.lucide) lucide.createIcons();

    try {
        const extension = await window.electronAPI?.getExtensionPackageStatus?.();
        if (extension && !extension.available) {
            throw new Error(extension.error || 'ملفات الإضافة غير مكتملة.');
        }
        const backend = await window.electronAPI?.ensureBackendReady?.();
        if (backend && !backend.success) throw new Error('محرك التحميل لم يبدأ بنجاح.');
        const res = await axios.get('http://127.0.0.1:8000/api/health', { timeout: 5000 });
        if (res.status === 200 && res.data?.status === 'ok') {
            const diagnostics = res.data?.diagnostics || {};
            if (diagnostics.database === 'error' || diagnostics.download_storage === 'unavailable') {
                const issue = diagnostics.database === 'error'
                    ? 'قاعدة بيانات التحميلات لا تستجيب.'
                    : `مجلد الحفظ غير متاح: ${diagnostics.download_path || ''}`;
                showToast(`المحرك متصل، لكن ${issue}`, '#f59e0b', 6000);
            } else {
                const storageMessage = diagnostics.download_storage === 'will_create'
                    ? 'سيُنشأ مجلد الحفظ عند أول تنزيل.'
                    : 'مجلد الحفظ جاهز.';
                showToast(`المحرك وقاعدة البيانات يعملان. ${storageMessage} ${diagnostics.active_downloads || 0} تنزيل نشط.`, '#10b981', 6000);
            }
        } else {
            throw new Error('استجابة المحرك غير متوقعة.');
        }
    } catch (e) {
        showToast(`❌ ${e.message || 'فشل فحص الإضافة والمحرك.'}`, '#ef4444');
    } finally {
        btn.innerHTML = oldHTML;
        btn.disabled = false;
        if (window.lucide) lucide.createIcons();
    }
});

// Sound test button
document.getElementById('btn-test-sound')?.addEventListener('click', async () => {
    const played = await playNotificationSound();
    showToast(played ? 'تم تشغيل صوت الإشعار 🔔' : 'تعذر تشغيل الصوت؛ تحقق من مستوى الصوت.', played ? '#10b981' : '#ef4444');
});

// Paste / Clear URL shortcuts
document.getElementById('btn-paste-url')?.addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        const urlInput = document.getElementById('url-input');
        if (urlInput && text) {
            urlInput.value = text;
            urlInput.focus();
            showToast('تم لصق الرابط', '#10b981');
        }
    } catch (e) {
        showToast('لم يتم السماح بالوصول للحافظة', '#f59e0b');
    }
});

document.getElementById('btn-clear-url')?.addEventListener('click', () => {
    const urlInput = document.getElementById('url-input');
    if (urlInput) {
        urlInput.value = '';
        urlInput.focus();
    }
});

// ============================================
// ENHANCED applySettings: Sync all controls on load
// ============================================
function syncSettingsUI() {
    // Theme card highlight
    if (appSettings.theme) {
        document.querySelectorAll('.theme-card-option').forEach(card => {
            card.classList.toggle('active', card.getAttribute('data-theme-val') === appSettings.theme);
        });
    }

    // Accent color highlight
    if (appSettings.accentColor) {
        document.documentElement.style.setProperty('--accent-primary', appSettings.accentColor);
        document.querySelectorAll('.accent-color-circle').forEach(circle => {
            circle.classList.toggle('active', circle.getAttribute('data-color') === appSettings.accentColor);
        });
    }

    // Concurrent downloads pills
    if (appSettings.maxConcurrent) {
        document.querySelectorAll('#pills-concurrent-downloads .segmented-pill-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-val') === String(appSettings.maxConcurrent));
        });
    }

    // Default quality select
    const qualitySelect = document.getElementById('settings-default-quality');
    if (qualitySelect && appSettings.defaultQuality) {
        qualitySelect.value = appSettings.defaultQuality;
    }

    // Speed limit select
    const speedSelect = document.getElementById('settings-speed-limit');
    if (speedSelect && appSettings.speedLimit !== undefined) {
        speedSelect.value = String(appSettings.speedLimit);
    }

    // Sync all checkboxes
    settingsCheckboxes.forEach(({ id, key }) => {
        const cb = document.getElementById(id);
        if (cb && appSettings[key] !== undefined) {
            cb.checked = appSettings[key];
        }
    });

    // Sync system auto-launch status from Electron
    if (window.electronAPI && window.electronAPI.getAutoLaunch) {
        window.electronAPI.getAutoLaunch().then(res => {
            if (res && res.available !== false) {
                const cb = document.getElementById('checkbox-auto-launch');
                if (cb) cb.checked = !!res.enabled;
                appSettings.autoLaunch = !!res.enabled;
                saveSettings(appSettings);
            }
        }).catch(e => console.warn("Could not fetch auto launch setting:", e));
    }

    // Sync smart clipboard state to Electron
    if (window.electronAPI && window.electronAPI.setSmartClipboard) {
        window.electronAPI.setSmartClipboard(appSettings.smartClipboard !== false);
    }

    // Sync speed limit and concurrency to backend
    syncSettingsWithBackend();
}

// Run syncSettingsUI after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    syncSettingsUI();
});

// Auto-Resume on Startup logic
let hasCheckedAutoResume = false;
function handleAutoResume(downloads) {
    if (hasCheckedAutoResume || appSettings.autoResume === false) return;
    hasCheckedAutoResume = true;
    const interrupted = downloads.filter(d => ['downloading', 'starting', 'preparing'].includes(d.status));
    if (interrupted.length > 0) {
        showToast(`استئناف تلقائي لـ ${interrupted.length} تحميل...`, '#3b82f6');
        interrupted.forEach(d => {
            axios.post(`${API_URL}/resume/${d.id}`).catch(() => {});
        });
    }
}

const autoRetryAttempts = new Map();
const autoRetryTimers = new Map();
function scheduleAutomaticRetry(download) {
    if (appSettings.autoRetry === false || !download?.id || autoRetryTimers.has(download.id)) return;
    const message = String(download.error_message || '').toLowerCase();
    if (download.retryable === true) {
        // The backend has already classified this failure as safe to retry.
    } else {
        if (/\b(401|403|404)\b|expired|login|cookie|not found|unsupported|invalid url/.test(message)) return;
        if (!/network|timeout|timed out|connection|temporar|disconnected|http 5\d\d|http 429|status 0/.test(message)) return;
    }

    const attempts = autoRetryAttempts.get(download.id) || 0;
    if (attempts >= 3) return;
    const attemptNumber = attempts + 1;
    const timer = setTimeout(async () => {
        autoRetryTimers.delete(download.id);
        if (appSettings.autoRetry === false) return;
        autoRetryAttempts.set(download.id, attemptNumber);
        try {
            await axios.post(`${API_URL}/resume/${download.id}`, {}, { timeout: 10000 });
            showToast(`إعادة محاولة التحميل تلقائياً (${attemptNumber}/3)`, '#3b82f6');
        } catch (error) {
            console.warn(`Automatic retry ${attemptNumber} failed for ${download.id}:`, error);
        }
    }, attemptNumber * 3000);
    autoRetryTimers.set(download.id, timer);
}

// Local state for sorting/filtering
let rawDownloadsData = [];
let currentFilter = 'all';
let currentSort = 'date-desc';
let currentDownloadSearch = '';
const DOWNLOAD_HISTORY_PAGE_SIZE = 15;
let downloadHistoryLimit = DOWNLOAD_HISTORY_PAGE_SIZE;
let bulkDownloadActionPending = false;
window.speedHistory = {}; // { id: [speed_bytes_1, speed_bytes_2, ...] }
window.progressHistory = {}; // { id: [{ progress, at }, ...] }

function processDownloadsState(downloads) {
    if (!Array.isArray(downloads)) return;
    rawDownloadsData = downloads;
    window.LedoLibraryHub?.update(downloads);
    updateDownloadOverview(downloads);
    handleAutoResume(downloads);

    // Record speed history only for active downloads and clean up old ones to save RAM
    const activeIds = new Set();
    let hasActive = false;

    downloads.forEach(dl => {
        if (['downloading', 'starting', 'resolving', 'preparing', 'processing'].includes(dl.status)) {
            hasActive = true;
            activeIds.add(dl.id);
            if (!window.speedHistory[dl.id]) window.speedHistory[dl.id] = [];
            if (Number(dl.speed) > 0) window.speedHistory[dl.id].push(Number(dl.speed));
            if (window.speedHistory[dl.id].length > 20) window.speedHistory[dl.id].shift();

            if (dl.status === 'downloading' && Number(dl.progress) > 0) {
                if (!window.progressHistory[dl.id]) window.progressHistory[dl.id] = [];
                const samples = window.progressHistory[dl.id];
                const now = Date.now();
                const previous = samples[samples.length - 1];
                if (!previous || Number(dl.progress) > previous.progress + 0.05) {
                    samples.push({ progress: Number(dl.progress), at: now });
                }
                window.progressHistory[dl.id] = samples.filter(sample => now - sample.at <= 30000).slice(-20);
            }
        }
    });

    // Clean up memory for finished downloads from speedHistory
    for (const id in window.speedHistory) {
        if (!activeIds.has(id)) {
            delete window.speedHistory[id];
            delete window.progressHistory[id];
        }
    }

    updateRecentCompleted();
    applyFilterAndSort();
}

function updateDownloadOverview(downloads) {
    const active = downloads.filter(d => ['downloading', 'resolving', 'preparing', 'processing'].includes(d.status));
    const queued = downloads.filter(d => d.status === 'starting');
    const completed = downloads.filter(d => d.status === 'completed');
    const totalTransferred = downloads.reduce((sum, d) => sum + (Number(d.downloaded) || 0), 0);
    const currentSpeed = active.reduce((sum, d) => sum + (Number(d.speed) || 0), 0);

    const activeEl = document.getElementById('overview-active');
    const completedEl = document.getElementById('overview-completed');
    const transferredEl = document.getElementById('overview-transferred');
    const speedEl = document.getElementById('overview-speed');
    const queuedEl = document.getElementById('overview-queued');
    if (activeEl) activeEl.textContent = String(active.length);
    if (completedEl) completedEl.textContent = String(completed.length);
    if (transferredEl) transferredEl.textContent = formatBytes(totalTransferred);
    if (speedEl) speedEl.textContent = `${formatBytes(currentSpeed)}/s`;
    if (queuedEl) queuedEl.textContent = `${queued.length} waiting in queue`;

    const filterCounts = {
        all: downloads.length,
        downloading: downloads.filter(d => ['downloading', 'starting', 'resolving', 'preparing', 'processing'].includes(d.status)).length,
        completed: completed.length,
        error: downloads.filter(d => d.status === 'error').length
    };
    Object.entries(filterCounts).forEach(([filter, count]) => {
        const countEl = document.querySelector(`[data-count-for="${filter}"]`);
        if (countEl) countEl.textContent = String(count);
    });
}

function updateRecentCompleted() {
    const recentList = document.getElementById('recent-completed-list');
    if (!recentList) return;

    const completed = [...rawDownloadsData]
        .filter(d => d.status === 'completed')
        .sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0))
        .slice(0, 4);

    // Optimization: Create a state hash to prevent DOM thrashing
    const stateHash = completed.map(d => d.id).join(',');
    if (recentList.dataset.stateHash === stateHash) return;
    recentList.dataset.stateHash = stateHash;

    if (completed.length === 0) {
        recentList.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">No recent downloads</div>';
        return;
    }

    let html = '';
    completed.forEach(dl => {
        const name = dl.filename || dl.url || 'Unknown';
        const size = dl.total_size ? formatBytes(dl.total_size) : 'Unknown';
        html += `
            <div class="recent-item" onclick="openDetailsDrawer({id:'${dl.id}', filename:'${name.replace(/'/g, "\\'")}', status:'completed', total_size:${dl.total_size || 0}, url:'${(dl.url || '').replace(/'/g, "\\'")}'})">
                <div class="recent-thumb">
                    <i data-lucide="file" style="width:24px;height:24px;"></i>
                </div>
                <div class="recent-info">
                    <div class="recent-title" title="${name}">${name}</div>
                    <div class="recent-meta">${size}</div>
                </div>
                <div class="recent-status">
                    <i data-lucide="check" style="width:12px;height:12px;"></i>
                </div>
            </div>
        `;
    });
    recentList.innerHTML = html;
    if (window.lucide) lucide.createIcons({ root: recentList });
}

function applyFilterAndSort() {
    let result = [...rawDownloadsData];
    const toolsViewOpen = document.getElementById('view-tools')?.classList.contains('active');

    // Keep only live cards attached while the lightweight tools workspace is open.
    if (toolsViewOpen) {
        result = result.filter(d => ['downloading', 'starting', 'resolving', 'preparing', 'processing'].includes(d.status));
    } else if (currentFilter === 'downloading') {
        result = result.filter(d => ['downloading', 'starting', 'resolving', 'preparing', 'processing'].includes(d.status));
    } else if (currentFilter === 'completed') {
        result = result.filter(d => d.status === 'completed');
    } else if (currentFilter === 'error') {
        result = result.filter(d => d.status === 'error');
    }

    if (currentDownloadSearch) {
        result = result.filter(download => [download.filename, download.url, download.error_message]
            .some(value => String(value || '').toLocaleLowerCase().includes(currentDownloadSearch)));
    }

    // Sort once, then keep the live queue visible while paging through older history.
    const compareDownloads = (a, b) => {
        if (currentSort === 'size-desc') {
            return (b.total_size || 0) - (a.total_size || 0);
        } else if (currentSort === 'speed-desc') {
            return (b.speed || 0) - (a.speed || 0);
        } else if (currentSort === 'name-asc') {
            const nameA = (a.filename || a.url || '').toLowerCase();
            const nameB = (b.filename || b.url || '').toLowerCase();
            return nameA.localeCompare(nameB);
        }
        // date-desc (default: newest downloads first)
        return (Number(b.created_at) || 0) - (Number(a.created_at) || 0);
    };
    result.sort(compareDownloads);

    const liveStatuses = ['downloading', 'starting', 'resolving', 'preparing', 'processing'];
    const canPageHistory = !toolsViewOpen && currentFilter !== 'downloading';
    let pagination = null;
    if (canPageHistory) {
        const live = result.filter(download => liveStatuses.includes(download.status));
        const history = result.filter(download => !liveStatuses.includes(download.status));
        const visibleHistory = history.slice(0, downloadHistoryLimit);
        result = [...live, ...visibleHistory].sort(compareDownloads);
        pagination = {
            total: history.length,
            visible: visibleHistory.length,
            hasMore: history.length > visibleHistory.length
        };
    }

    renderDownloads(result, pagination);
}

const downloadsSearch = document.getElementById('downloads-search');
const downloadsSearchToggle = document.getElementById('btn-toggle-download-search');
const downloadsSearchInput = document.getElementById('downloads-search-input');

function setDownloadsSearchOpen(open) {
    if (!downloadsSearch || !downloadsSearchToggle || !downloadsSearchInput) return;
    downloadsSearch.classList.toggle('is-open', open);
    downloadsSearchToggle.setAttribute('aria-expanded', String(open));
    downloadsSearchInput.tabIndex = open ? 0 : -1;
    if (open) {
        downloadsSearchInput.focus();
    } else {
        downloadsSearchInput.value = '';
        currentDownloadSearch = '';
        downloadHistoryLimit = DOWNLOAD_HISTORY_PAGE_SIZE;
        applyFilterAndSort();
    }
}

downloadsSearchToggle?.addEventListener('click', () => {
    setDownloadsSearchOpen(!downloadsSearch?.classList.contains('is-open'));
});

downloadsSearchInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        setDownloadsSearchOpen(false);
        downloadsSearchToggle?.focus();
    }
});

downloadsSearchInput?.addEventListener('input', (event) => {
    currentDownloadSearch = event.target.value.trim().toLocaleLowerCase();
    downloadHistoryLimit = DOWNLOAD_HISTORY_PAGE_SIZE;
    applyFilterAndSort();
});

const downloadActionsMenu = document.querySelector('.download-actions-menu');
const downloadActionsToggle = document.getElementById('btn-toggle-download-actions');
const downloadActionsPopover = document.getElementById('download-actions-popover');

function setDownloadActionsOpen(open) {
    if (!downloadActionsPopover || !downloadActionsToggle) return;
    downloadActionsPopover.hidden = !open;
    downloadActionsToggle.setAttribute('aria-expanded', String(open));
}

downloadActionsToggle?.addEventListener('click', (event) => {
    event.stopPropagation();
    setDownloadActionsOpen(downloadActionsPopover?.hidden ?? true);
});

document.addEventListener('click', (event) => {
    if (downloadActionsMenu && !downloadActionsMenu.contains(event.target)) setDownloadActionsOpen(false);
});

document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !typing) {
        event.preventDefault();
        if (document.getElementById('view-downloads')?.classList.contains('active')) {
            setDownloadsSearchOpen(true);
        }
    }
    const inUrlEntry = target?.id === 'url-input' || target?.id === 'url-batch-input';
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && (!typing || inUrlEntry)
        && document.getElementById('view-downloads')?.classList.contains('active')) {
        event.preventDefault();
        document.getElementById('btn-fetch-info')?.click();
    }
    if (event.key === 'Escape' && downloadActionsPopover && !downloadActionsPopover.hidden) {
        setDownloadActionsOpen(false);
        downloadActionsToggle?.focus();
    }
});

// Filter Listeners
document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
    btn.addEventListener('click', (event) => {
        document.querySelectorAll('.filter-btn[data-filter]').forEach(button => button.classList.remove('active'));
        event.currentTarget.classList.add('active');
        currentFilter = event.currentTarget.getAttribute('data-filter');
        downloadHistoryLimit = DOWNLOAD_HISTORY_PAGE_SIZE;
        applyFilterAndSort();
    });
});

async function runBulkDownloadAction(action) {
    if (bulkDownloadActionPending) return;
    const isPause = action === 'pause';
    const isRetry = action === 'retry';
    const targets = rawDownloadsData.filter(download => isPause
        ? ['downloading', 'starting', 'preparing', 'processing'].includes(download.status)
        : isRetry ? download.status === 'error' : download.status === 'paused');
    if (!targets.length) {
        const emptyMessage = isPause ? 'لا توجد تحميلات نشطة لإيقافها مؤقتًا.'
            : isRetry ? 'لا توجد تحميلات فاشلة لإعادة المحاولة.'
                : 'لا توجد تحميلات متوقفة لاستئنافها.';
        showToast(emptyMessage, '#64748b');
        return;
    }

    const pauseButton = document.getElementById('btn-pause-all');
    const resumeButton = document.getElementById('btn-resume-all');
    const retryButton = document.getElementById('btn-retry-failed');
    bulkDownloadActionPending = true;
    if (pauseButton) pauseButton.disabled = true;
    if (resumeButton) resumeButton.disabled = true;
    if (retryButton) retryButton.disabled = true;
    try {
        if (isRetry) {
            targets.forEach(download => {
                const timer = autoRetryTimers.get(download.id);
                if (timer) clearTimeout(timer);
                autoRetryTimers.delete(download.id);
                autoRetryAttempts.delete(download.id);
            });
        }
        const endpoint = isPause ? 'pause' : 'resume';
        const results = await Promise.allSettled(targets.map(download =>
            axios.post(`${API_URL}/${endpoint}/${encodeURIComponent(download.id)}`, {}, { timeout: 15000 })
        ));
        const successful = results.filter(result => result.status === 'fulfilled'
            && ['pausing', 'resumed', 'already_running'].includes(result.value?.data?.status)).length;
        if (successful) {
            const successMessage = isPause ? `تم إرسال أمر الإيقاف المؤقت لـ ${successful} تحميل.`
                : isRetry ? `بدأت إعادة ${successful} تحميل فاشل.`
                    : `تم استئناف ${successful} تحميل.`;
            showToast(successMessage, '#10b981');
        }
        if (successful < targets.length) {
            showToast(`تعذر تنفيذ الإجراء على ${targets.length - successful} تحميل.`, '#f59e0b');
        }
        await refreshDownloads();
    } catch (error) {
        showToast(error.message || 'تعذر تنفيذ الإجراء على التحميلات.', '#ef4444');
    } finally {
        bulkDownloadActionPending = false;
        if (pauseButton) pauseButton.disabled = false;
        if (resumeButton) resumeButton.disabled = false;
        if (retryButton) retryButton.disabled = false;
    }
}

document.getElementById('btn-pause-all')?.addEventListener('click', () => {
    setDownloadActionsOpen(false);
    runBulkDownloadAction('pause');
});
document.getElementById('btn-resume-all')?.addEventListener('click', () => {
    setDownloadActionsOpen(false);
    runBulkDownloadAction('resume');
});
document.getElementById('btn-retry-failed')?.addEventListener('click', () => {
    setDownloadActionsOpen(false);
    runBulkDownloadAction('retry');
});

document.getElementById('sort-select')?.addEventListener('change', (e) => {
    currentSort = e.target.value;
    downloadHistoryLimit = DOWNLOAD_HISTORY_PAGE_SIZE;
    applyFilterAndSort();
});


let wsReconnectDelay = 2000;
let wsReconnectTimer = null;
let lastDownloadsMessageAt = 0;
let wsConnectPending = false;

async function connectWebSocket() {
    if (wsConnectPending || (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN))) return;
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
    }
    wsConnectPending = true;
    let token;
    try {
        token = await window.electronAPI?.getLocalWebSocketToken?.();
    } catch (_) {}
    wsConnectPending = false;
    if (!token) {
        wsReconnectTimer = setTimeout(connectWebSocket, wsReconnectDelay);
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, 60000);
        return;
    }
    ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);

    ws.onopen = function () {
        if (wsReconnectTimer) {
            clearTimeout(wsReconnectTimer);
            wsReconnectTimer = null;
        }
        wsReconnectDelay = 2000;
        syncSettingsWithBackend();
        refreshDownloads();
    };

    ws.onmessage = function (event) {
        try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'state' || payload.type === 'downloads') {
                lastDownloadsMessageAt = Date.now();
                // Only update the UI when window is visible — skip heavy DOM work when in tray
                const downloads = Array.isArray(payload.downloads) ? payload.downloads : [];
                if (windowIsVisible) {
                    const toolsOpen = document.getElementById('view-tools')?.classList.contains('active');
                    const hasActiveDownloads = downloads.some(isDownloadRunning);
                    if (toolsOpen && !hasActiveDownloads) {
                        rawDownloadsData = downloads;
                        suspendDownloadsUiIfIdle();
                        for (const id in window.speedHistory) delete window.speedHistory[id];
                        for (const id in window.progressHistory) delete window.progressHistory[id];
                    } else {
                        processDownloadsState(downloads);
                    }
                }

                // Always update tray tooltip with active download count (even when hidden in tray)
                const _activeCount = downloads.filter(d => ['downloading', 'starting', 'resolving', 'preparing'].includes(d.status)).length;
                window.electronAPI?.updateTrayStatus?.(_activeCount);

                // Track completions for notifications
                downloads.forEach(dl => {
                    if (!window.knownDownloads) window.knownDownloads = new Map();

                    const prevStatus = window.knownDownloads.get(dl.id);
                    if (dl.source === 'telegram') {
                        const botActive = ['starting', 'resolving', 'downloading', 'preparing', 'processing'].includes(dl.status);
                        const createdAt = Number(dl.created_at) || 0;
                        const isRecent = createdAt > 0 && Math.abs(Date.now() - createdAt) < 30000;
                        const isNewEvent = prevStatus === undefined && isRecent && (botActive || ['completed', 'error'].includes(dl.status));
                        const isBotFinish = ['completed', 'error'].includes(dl.status) && prevStatus !== undefined && prevStatus !== dl.status;
                        updateBotActivity(dl, { notify: isNewEvent || isBotFinish, sync: true });
                    }
                    if (dl.status === 'error') scheduleAutomaticRetry(dl);
                    if (dl.status === 'completed') {
                        const retryTimer = autoRetryTimers.get(dl.id);
                        if (retryTimer) clearTimeout(retryTimer);
                        autoRetryTimers.delete(dl.id);
                        autoRetryAttempts.delete(dl.id);
                    }
                    if (prevStatus !== dl.status) {
                        if (dl.status === 'completed' && prevStatus) {
                            const elapsedSeconds = dl.completed_at && dl.created_at
                                ? Math.max(0, Math.ceil((Number(dl.completed_at) - Number(dl.created_at)) / 1000))
                                : null;
                            const completedMessage = elapsedSeconds === null
                                ? `اكتمل التنزيل: ${dl.filename || 'File'}`
                                : `اكتمل التنزيل في ${formatDuration(elapsedSeconds)}: ${dl.filename || 'File'}`;
                            if (appSettings.openCompletedFolder && dl.save_path && window.electronAPI?.showItemInFolder) {
                                window.electronAPI.showItemInFolder(dl.save_path).then(opened => {
                                    if (!opened) showToast('اكتمل التنزيل، لكن تعذر فتح مكان الملف.', '#f59e0b');
                                }).catch(error => console.warn('Could not reveal completed download:', error));
                            }
                            if (appSettings.completionNotif !== false) {
                                showToast(completedMessage, '#10b981', 6000);
                                if (window.electronAPI && window.electronAPI.showNotification) {
                                    window.electronAPI.showNotification('Ledo Downloader', completedMessage);
                                } else if (window.Notification && Notification.permission === 'granted') {
                                    new Notification('Ledo Downloader', { body: completedMessage });
                                }
                            }
                            if (appSettings.completionSound !== false) {
                                playNotificationSound();
                            }
                            // Only run confetti if window is visible (no point animating a hidden window)
                            if (windowIsVisible && !appSettings.powerSaver && window.confetti) {
                                const duration = 2000;
                                const end = Date.now() + duration;
                                (function frame() {
                                    confetti({
                                        particleCount: 3,
                                        angle: 60,
                                        spread: 55,
                                        origin: { x: 0, y: 0.8 },
                                        colors: ['#3b82f6', '#10b981', '#a855f7'],
                                        zIndex: 99999
                                    });
                                    confetti({
                                        particleCount: 3,
                                        angle: 120,
                                        spread: 55,
                                        origin: { x: 1, y: 0.8 },
                                        colors: ['#3b82f6', '#10b981', '#a855f7'],
                                        zIndex: 99999
                                    });
                                    if (Date.now() < end) requestAnimationFrame(frame);
                                }());
                            }
                        } else if (dl.status === 'error' && prevStatus) {
                            if (appSettings.completionNotif !== false) {
                                showToast(`Download Failed: ${dl.filename || dl.url}`, '#ef4444');
                                if (window.electronAPI && window.electronAPI.showNotification) {
                                    window.electronAPI.showNotification('Ledo Downloader', `Download Failed: ${dl.filename || 'File'}`);
                                } else if (window.Notification && Notification.permission === 'granted') {
                                    new Notification('Ledo Downloader', { body: `Download Failed: ${dl.filename || 'File'}` });
                                }
                            }
                            // Report download errors to Firebase
                            if (window.firebaseApp && window.firebaseApp.uploadCrashReport) {
                                window.firebaseApp.uploadCrashReport(
                                    dl.error_message || 'Download Failed',
                                    null,
                                    { type: 'download_error', url: dl.url, filename: dl.filename, downloadId: dl.id }
                                );
                            }
                        }
                        window.knownDownloads.set(dl.id, dl.status);
                    }
                });
            } else if (payload.type === 'system' && payload.system) {
                // Skip expensive chart/DOM updates when hidden in tray
                if (!windowIsVisible) return;
                const renderNow = Date.now();
                if (appSettings.powerSaver && renderNow - lastSystemUiUpdateAt < 5000) return;
                lastSystemUiUpdateAt = renderNow;
                const cpuVal = Math.round(payload.system.cpu || 0);
                const ramVal = Math.round(payload.system.memory || 0);
                const netSpeed = payload.system.net_speed || 0;
                const diskSpeed = payload.system.disk_speed || 0;

                const meterCpuVal = document.getElementById('meter-cpu-val');
                const meterCpuBar = document.getElementById('meter-cpu-bar');
                if (meterCpuVal) meterCpuVal.innerText = `${cpuVal}%`;
                if (meterCpuBar) meterCpuBar.style.width = `${cpuVal}%`;

                const meterRamVal = document.getElementById('meter-ram-val');
                const meterRamBar = document.getElementById('meter-ram-bar');
                if (meterRamVal) meterRamVal.innerText = `${ramVal}%`;
                if (meterRamBar) meterRamBar.style.width = `${ramVal}%`;

                const cpuCirc = document.getElementById('stat-cpu-circle');
                const cpuText = document.getElementById('stat-cpu-val');
                if (cpuCirc) cpuCirc.setAttribute('stroke-dasharray', `${cpuVal}, 100`);
                if (cpuText) cpuText.innerText = `${cpuVal}%`;

                const ramCirc = document.getElementById('stat-ram-circle');
                const ramText = document.getElementById('stat-ram-val');
                if (ramCirc) ramCirc.setAttribute('stroke-dasharray', `${ramVal}, 100`);
                if (ramText) ramText.innerText = `${ramVal}%`;

                const netVal = document.getElementById('stat-net-val');
                if (netVal) netVal.innerText = netSpeed > 0 ? formatBytes(netSpeed) + '/s' : '0 B/s';
                
                const diskVal = document.getElementById('stat-disk-val');
                if (diskVal) diskVal.innerText = diskSpeed > 0 ? formatBytes(diskSpeed) + '/s' : '0 B/s';
                
                if (Array.isArray(netHistory)) {
                    netHistory.shift();
                    netHistory.push(netSpeed);
                    if (sysNetChartInstance) {
                        sysNetChartInstance.update();
                    }
                }
            }
        } catch (e) {
            console.error("Failed to parse WS data", e);
        }
    };

    ws.onclose = function () {
        // Keep the command channel alive while the main window is in the tray.
        // Browser-extension quick-add requests arrive over this socket.
        wsReconnectTimer = setTimeout(connectWebSocket, wsReconnectDelay);
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, 60000); // backoff up to 60s
    };

    ws.onerror = function (err) {
        // Suppressed to avoid ERR_NETWORK_IO_SUSPENDED console spam
        ws.close();
    };
}

// Track whether the main window is visible to skip heavy DOM updates when hidden
let windowIsVisible = true;
let lastSystemUiUpdateAt = 0;
if (window.electronAPI && window.electronAPI.onWindowFocusChange) {
    window.electronAPI.onWindowFocusChange((focused) => {
        // focused = false when blurred, but we really care about visibility
        // We'll use document.hidden (set by Electron when window is hidden)
    });
}
// Use Page Visibility API — Electron sets this when window is hidden via .hide()
document.addEventListener('visibilitychange', () => {
    windowIsVisible = document.visibilityState === 'visible';
    if (!windowIsVisible) {
        document.body.classList.add('app-hidden');
        // Release the large wallpaper/compositor layers while the window sits in the tray.
        document.body.style.setProperty('background-image', 'none', 'important');
        // Keep the lightweight WebSocket open so quick-add commands from the
        // browser extension are received even when the app is minimized to tray.
    } else {
        document.body.classList.remove('app-hidden');
        applySettings();
        refreshDownloads();
        connectWebSocket();
    }
});

// Connect only after the backend readiness check. This avoids noisy refused
// connections while the service is still booting.
backendReadyPromise.then(ready => {
    if (ready) connectWebSocket();
});

// customSavePath = one-time override from the folder picker next to URL bar
let customSavePath = null;
// selectedQuality = currently chosen quality in the quality modal
let selectedQuality = 'best';
window.isSpotifyMultiTrack = false;
window.selectedSpotifyTrackIndices = [];
window.spotifyTracks = [];
window.isYouTubePlaylist = false;
window.selectedYouTubeVideoIndices = [];
window.youtubeVideos = [];

function escapeSpotifyTrackText(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

function formatPlaylistVideoDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return '';
    const total = Math.floor(value);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    return hours
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
        : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function playlistQualityOptions(selected) {
    return [
        ['best', 'Best'], ['1080p', '1080p'], ['720p', '720p'],
        ['480p', '480p'], ['360p', '360p'], ['audio', 'Audio only']
    ].map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
}

function getYouTubePlaylistRequestVideos() {
    return window.youtubeVideos.map((video, index) => ({
        ...video,
        quality: document.querySelector(`.youtube-video-quality[data-video-index="${index}"]`)?.value || selectedQuality
    }));
}

function updateSpotifyTrackSelection() {
    const checkboxes = Array.from(document.querySelectorAll('.spotify-track-checkbox'));
    const selected = checkboxes.filter(input => input.checked).map(input => Number(input.value));
    if (window.isYouTubePlaylist) window.selectedYouTubeVideoIndices = selected;
    else window.selectedSpotifyTrackIndices = selected;

    const visibleRows = Array.from(document.querySelectorAll('.spotify-track-row')).filter(row => !row.hidden);
    const visibleSelected = visibleRows.filter(row => row.querySelector('.spotify-track-checkbox')?.checked).length;
    const selectVisible = document.getElementById('spotify-select-visible');
    if (selectVisible) {
        selectVisible.textContent = visibleRows.length && visibleSelected === visibleRows.length ? 'Clear visible' : 'Select visible';
        const itemName = window.isYouTubePlaylist ? 'videos' : 'tracks';
        selectVisible.setAttribute('aria-label', visibleRows.length && visibleSelected === visibleRows.length ? `Clear visible ${itemName}` : `Select visible ${itemName}`);
        selectVisible.disabled = visibleRows.length === 0;
    }

    const selectAll = document.getElementById('spotify-select-all');
    if (selectAll) {
        selectAll.checked = checkboxes.length > 0 && selected.length === checkboxes.length;
        selectAll.indeterminate = selected.length > 0 && selected.length < checkboxes.length;
    }

    const selectionCount = document.getElementById('spotify-selection-count');
    if (selectionCount) selectionCount.textContent = `${selected.length} of ${checkboxes.length} selected · ${visibleRows.length} shown`;

    checkboxes.forEach(input => {
        input.closest('.spotify-track-row')?.classList.toggle('selected', input.checked);
    });

    const downloadButton = document.getElementById('btn-start-download');
    if (downloadButton && (window.isSpotifyMultiTrack || window.isYouTubePlaylist)) {
        const itemName = window.isYouTubePlaylist ? 'video' : 'track';
        downloadButton.disabled = selected.length === 0;
        downloadButton.textContent = selected.length
            ? `Download selected (${selected.length})`
            : `Select at least one ${itemName}`;
    }
}

document.getElementById('btn-select-folder')?.addEventListener('click', async () => {
    const path = await window.electronAPI.selectFolder();
    if (path) {
        customSavePath = path;
        updateSavePathDisplay();
        showToast('Save path set for this download only', '#6366f1');
    }
});

let isBatchMode = false;
document.getElementById('btn-toggle-batch')?.addEventListener('click', () => {
    isBatchMode = !isBatchMode;
    const singleInput = document.getElementById('url-input');
    const batchInput = document.getElementById('url-batch-input');
    const btnText = document.getElementById('btn-fetch-text');
    const batchQualitySelect = document.getElementById('batch-quality-select');
    if (isBatchMode) {
        singleInput.style.display = 'none';
        batchInput.style.display = 'block';
        batchQualitySelect.style.display = 'block';
        btnText.innerText = 'Download All';
        document.getElementById('btn-toggle-batch').style.color = 'var(--accent-primary)';
    } else {
        singleInput.style.display = 'block';
        batchInput.style.display = 'none';
        batchQualitySelect.style.display = 'none';
        btnText.innerText = 'Fetch Info';
        document.getElementById('btn-toggle-batch').style.color = '';
    }
});

document.getElementById('btn-fetch-info')?.addEventListener('click', async () => {
    // 1. Maintenance Check
    if (window.appMaintenanceMode) {
        showToast(window.appMaintenanceMessage || 'نحن في صيانة حالياً، عد لاحقاً.', '#ef4444');
        return;
    }

    // URL to check feature toggles against
    let firstUrlToCheck = document.getElementById('url-input')?.value;
    if (isBatchMode) {
        firstUrlToCheck = document.getElementById('url-batch-input')?.value?.split(/[\r\n,]+/)[0];
    }
    
    // 2. Feature Toggles Check
    if (firstUrlToCheck && window.appFeatureToggles) {
        const u = firstUrlToCheck.toLowerCase();
        if (u.includes('youtube.com') || u.includes('youtu.be')) {
            if (window.appFeatureToggles.youtube_enabled === false) {
                showToast('تحميل اليوتيوب معطل حالياً من قِبل الإدارة.', '#ef4444');
                return;
            }
        } else if (u.includes('instagram.com')) {
            if (window.appFeatureToggles.instagram_enabled === false) {
                showToast('تحميل انستجرام معطل حالياً من قِبل الإدارة.', '#ef4444');
                return;
            }
        } else if (u.includes('tiktok.com')) {
            if (window.appFeatureToggles.tiktok_enabled === false) {
                showToast('تحميل تيك توك معطل حالياً من قِبل الإدارة.', '#ef4444');
                return;
            }
        }
    }

    if (isBatchMode) {
        const rawInput = document.getElementById('url-batch-input').value;
        const urls = rawInput.split(/[\r\n,]+/).map(u => u.trim()).filter(u => u.length > 3 && (u.startsWith('http://') || u.startsWith('https://') || u.includes('.')));
        if (urls.length === 0) return showToast("Enter at least one valid URL", "#f59e0b");
        const effectivePath = customSavePath || appSettings.defaultSavePath;
        const batchQuality = document.getElementById('batch-quality-select').value || 'best';
        let added = 0;

        const btn = document.getElementById('btn-fetch-info');
        btn.disabled = true;

        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            btn.innerHTML = `<i data-lucide="loader" class="spinner"></i> <span id="btn-fetch-text">Adding (${i + 1}/${urls.length})...</span>`;
            if (window.lucide) lucide.createIcons();

            try {
                await axios.post(`${API_URL}/download`, {
                    url: url,
                    save_path: effectivePath,
                    quality: batchQuality,
                    is_yt_dlp: null // auto detect
                });
                added++;
            } catch (e) {
                console.error("Batch error for", url, e);
            }
        }
        showToast(`Started ${added} of ${urls.length} downloads in batch!`, "#10b981");
        document.getElementById('url-batch-input').value = '';
        customSavePath = null;
        updateSavePathDisplay();

        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="download-cloud"></i> <span id="btn-fetch-text">Download All</span>`;
        if (window.lucide) lucide.createIcons();
        if (typeof loadStats === 'function') loadStats();
        return;
    }

    const url = document.getElementById('url-input').value;
    if (!url) return;

    showToast("Fetching video information...", "#6366f1");
    const btn = document.getElementById('btn-fetch-info');
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader" class="spinner"></i> <span id="btn-fetch-text">Fetching...</span>`;
    if (window.lucide) lucide.createIcons();

    try {
        window.resolvedDownloadUrl = null;
        const response = await axios.post(`${API_URL}/info`, { url: url }, { timeout: 30000 });
        const data = response.data;

        if (data.status === 'success') {
            const dlInfo = data.download_info || data;
            window.resolvedDownloadUrl = dlInfo.direct_url || url;
            document.getElementById('modal-title').innerText = dlInfo.title || 'Unknown Title';
            const optionsDiv = document.getElementById('quality-options');
            const sizes = dlInfo.sizes || {};
            const modalContent = document.querySelector('#quality-modal .modal-content');
            window.isSpotifyMultiTrack = false;
            window.selectedSpotifyTrackIndices = [];
            window.spotifyTracks = Array.isArray(dlInfo.tracks) ? dlInfo.tracks : [];
            window.isYouTubePlaylist = false;
            window.selectedYouTubeVideoIndices = [];
            window.youtubeVideos = [];
            modalContent?.classList.remove('spotify-picker-modal', 'youtube-picker-modal');
            const startButton = document.getElementById('btn-start-download');
            if (startButton) startButton.disabled = false;
            const scheduleToggle = document.getElementById('btn-schedule-toggle');
            if (scheduleToggle) scheduleToggle.style.display = '';

            if (dlInfo.is_direct) {
                window.isDirectFile = true;
                window.isSpotify = false;
                window.spotifyTracks = [];
                optionsDiv.innerHTML = `
                    <label class="quality-option active">
                        <input type="radio" name="quality" value="best" checked onchange="selectedQuality='best'; updateQualitySelection()">
                        <div class="q-info">
                            <span class="q-title">Direct File Download</span>
                            <span class="q-size">${sizes.best ? formatBytes(sizes.best) : 'Size Unknown'}</span>
                        </div>
                    </label>
                `;
            } else if (dlInfo.is_youtube_playlist && Array.isArray(dlInfo.videos) && dlInfo.videos.length) {
                window.isDirectFile = false;
                window.isSpotify = false;
                window.isYouTubePlaylist = true;
                window.youtubeVideos = dlInfo.videos;
                window.selectedYouTubeVideoIndices = dlInfo.videos.map((_, index) => index);
                modalContent?.classList.add('spotify-picker-modal', 'youtube-picker-modal');
                selectedQuality = ['best', '1080p', '720p', '480p', '360p', 'audio'].includes(appSettings.defaultQuality)
                    ? appSettings.defaultQuality : 'best';
                const videoRows = dlInfo.videos.map((video, index) => {
                    const title = escapeSpotifyTrackText(video.title || `Video ${index + 1}`);
                    const searchableText = escapeSpotifyTrackText(String(video.title || '').toLocaleLowerCase());
                    const playlistIndex = Number(video.playlist_index) || index + 1;
                    const duration = formatPlaylistVideoDuration(video.duration);
                    return `
                        <div class="spotify-track-row selected" data-search="${searchableText}">
                            <input id="spotify-track-${index}" class="spotify-track-checkbox" type="checkbox" value="${index}" checked>
                            <span class="spotify-track-number">${String(playlistIndex).padStart(2, '0')}</span>
                            <label class="spotify-track-copy" for="spotify-track-${index}">
                                <strong>${title}</strong>
                                ${duration ? `<small>${duration}</small>` : ''}
                            </label>
                            <select class="youtube-video-quality" data-video-index="${index}" aria-label="Quality for ${title}">
                                ${playlistQualityOptions(selectedQuality)}
                            </select>
                        </div>
                    `;
                }).join('');

                optionsDiv.innerHTML = `
                    <div class="spotify-picker-summary">
                        <span class="spotify-picker-icon"><i data-lucide="list-video"></i></span>
                        <span class="spotify-picker-copy">
                            <strong>Choose videos</strong>
                            <small>YouTube playlist · ${dlInfo.video_count || dlInfo.videos.length} videos</small>
                        </span>
                        <label class="spotify-select-all" for="spotify-select-all">
                            <input id="spotify-select-all" type="checkbox" checked>
                            <span>Select all</span>
                        </label>
                    </div>
                    <div class="spotify-selection-count" id="spotify-selection-count"></div>
                    <div class="spotify-track-tools">
                        <label class="spotify-track-search">
                            <i data-lucide="search" aria-hidden="true"></i>
                            <input id="spotify-track-search" type="search" placeholder="Search videos" autocomplete="off" aria-label="Search videos">
                        </label>
                        <button id="spotify-select-visible" class="spotify-tool-button" type="button">Select visible</button>
                    </div>
                    <div class="spotify-track-list" role="group" aria-label="Choose YouTube videos">
                        ${videoRows}
                    </div>
                    <div class="spotify-empty-filter" id="spotify-empty-filter" hidden>No videos match your search.</div>
                    <label class="youtube-playlist-quality">
                        <span>Apply quality to all videos</span>
                        <select id="youtube-playlist-quality" aria-label="Video quality">
                            ${playlistQualityOptions(selectedQuality)}
                        </select>
                    </label>
                `;

                const selectAll = document.getElementById('spotify-select-all');
                selectAll?.addEventListener('change', () => {
                    document.querySelectorAll('.spotify-track-checkbox').forEach(input => {
                        input.checked = selectAll.checked;
                    });
                    updateSpotifyTrackSelection();
                });
                document.querySelectorAll('.spotify-track-checkbox').forEach(input => {
                    input.addEventListener('change', updateSpotifyTrackSelection);
                });
                document.getElementById('spotify-track-search')?.addEventListener('input', (event) => {
                    const query = event.target.value.trim().toLocaleLowerCase();
                    let visibleCount = 0;
                    document.querySelectorAll('.spotify-track-row').forEach(row => {
                        row.hidden = !row.dataset.search.includes(query);
                        if (!row.hidden) visibleCount++;
                    });
                    const emptyState = document.getElementById('spotify-empty-filter');
                    if (emptyState) emptyState.hidden = visibleCount > 0;
                    updateSpotifyTrackSelection();
                });
                document.getElementById('spotify-select-visible')?.addEventListener('click', () => {
                    const visibleRows = Array.from(document.querySelectorAll('.spotify-track-row')).filter(row => !row.hidden);
                    const shouldSelect = visibleRows.some(row => !row.querySelector('.spotify-track-checkbox')?.checked);
                    visibleRows.forEach(row => {
                        const checkbox = row.querySelector('.spotify-track-checkbox');
                        if (checkbox) checkbox.checked = shouldSelect;
                    });
                    updateSpotifyTrackSelection();
                });
                document.getElementById('youtube-playlist-quality')?.addEventListener('change', event => {
                    selectedQuality = event.target.value;
                    document.querySelectorAll('.youtube-video-quality').forEach(select => {
                        select.value = selectedQuality;
                    });
                });
                document.querySelectorAll('.youtube-video-quality').forEach(select => {
                    select.addEventListener('click', event => event.stopPropagation());
                    select.addEventListener('change', event => event.stopPropagation());
                });
                if (scheduleToggle) {
                    scheduleToggle.style.display = 'inline-flex';
                    scheduleToggle.title = 'Schedule selected videos';
                }
                document.getElementById('schedule-picker-container').style.display = 'none';
                document.getElementById('schedule-time').value = '';
                updateSpotifyTrackSelection();
            } else if (dlInfo.is_spotify) {
                window.isDirectFile = false;
                window.isSpotify = true;
                selectedQuality = 'audio';

                if (dlInfo.is_multi_track && (dlInfo.tracks?.length || dlInfo.track_names?.length)) {
                    const tracks = Array.isArray(dlInfo.tracks) && dlInfo.tracks.length
                        ? dlInfo.tracks
                        : dlInfo.track_names.map(name => ({ title: name, artist: '' }));
                    window.isSpotifyMultiTrack = true;
                    window.selectedSpotifyTrackIndices = tracks.map((_, index) => index);
                    modalContent?.classList.add('spotify-picker-modal');

                    const trackRows = tracks.map((track, index) => {
                        const title = escapeSpotifyTrackText(track.title || `Track ${index + 1}`);
                        const artist = escapeSpotifyTrackText(track.artist || '');
                        const searchableText = escapeSpotifyTrackText(`${track.title || ''} ${track.artist || ''}`.toLocaleLowerCase());
                        return `
                            <label class="spotify-track-row selected" for="spotify-track-${index}" data-search="${searchableText}">
                                <input id="spotify-track-${index}" class="spotify-track-checkbox" type="checkbox" value="${index}" checked>
                                <span class="spotify-track-number">${String(index + 1).padStart(2, '0')}</span>
                                <span class="spotify-track-copy">
                                    <strong>${title}</strong>
                                    ${artist ? `<small>${artist}</small>` : ''}
                                </span>
                            </label>
                        `;
                    }).join('');

                    optionsDiv.innerHTML = `
                        <div class="spotify-picker-summary">
                            <span class="spotify-picker-icon"><i data-lucide="music-2"></i></span>
                            <span class="spotify-picker-copy">
                                <strong>Choose tracks</strong>
                                <small>Spotify audio · MP3</small>
                            </span>
                            <label class="spotify-select-all" for="spotify-select-all">
                                <input id="spotify-select-all" type="checkbox" checked>
                                <span>Select all</span>
                            </label>
                        </div>
                        <div class="spotify-selection-count" id="spotify-selection-count"></div>
                        <div class="spotify-track-tools">
                            <label class="spotify-track-search">
                                <i data-lucide="search" aria-hidden="true"></i>
                                <input id="spotify-track-search" type="search" placeholder="Search tracks or artists" autocomplete="off" aria-label="Search tracks or artists">
                            </label>
                            <button id="spotify-select-visible" class="spotify-tool-button" type="button">Select visible</button>
                            <button id="spotify-sort-order" class="spotify-tool-button" type="button" aria-pressed="false">Original order</button>
                        </div>
                        <div class="spotify-track-list" role="group" aria-label="Choose Spotify tracks">
                            ${trackRows}
                        </div>
                        <div class="spotify-empty-filter" id="spotify-empty-filter" hidden>No tracks match your search.</div>
                    `;

                    const selectAll = document.getElementById('spotify-select-all');
                    selectAll?.addEventListener('change', () => {
                        document.querySelectorAll('.spotify-track-checkbox').forEach(input => {
                            input.checked = selectAll.checked;
                        });
                        updateSpotifyTrackSelection();
                    });
                    document.querySelectorAll('.spotify-track-checkbox').forEach(input => {
                        input.addEventListener('change', updateSpotifyTrackSelection);
                    });
                    document.getElementById('spotify-track-search')?.addEventListener('input', (event) => {
                        const query = event.target.value.trim().toLocaleLowerCase();
                        let visibleCount = 0;
                        document.querySelectorAll('.spotify-track-row').forEach(row => {
                            row.hidden = !row.dataset.search.includes(query);
                            if (!row.hidden) visibleCount++;
                        });
                        const emptyState = document.getElementById('spotify-empty-filter');
                        if (emptyState) emptyState.hidden = visibleCount > 0;
                        updateSpotifyTrackSelection();
                    });
                    document.getElementById('spotify-select-visible')?.addEventListener('click', () => {
                        const visibleRows = Array.from(document.querySelectorAll('.spotify-track-row')).filter(row => !row.hidden);
                        const shouldSelect = visibleRows.some(row => !row.querySelector('.spotify-track-checkbox')?.checked);
                        visibleRows.forEach(row => {
                            const checkbox = row.querySelector('.spotify-track-checkbox');
                            if (checkbox) checkbox.checked = shouldSelect;
                        });
                        updateSpotifyTrackSelection();
                    });
                    document.getElementById('spotify-sort-order')?.addEventListener('click', (event) => {
                        const button = event.currentTarget;
                        const descending = button.getAttribute('aria-pressed') !== 'true';
                        button.setAttribute('aria-pressed', String(descending));
                        button.textContent = descending ? 'Reverse order' : 'Original order';
                        const list = document.querySelector('.spotify-track-list');
                        Array.from(list?.querySelectorAll('.spotify-track-row') || [])
                            .sort((a, b) => Number(a.querySelector('.spotify-track-checkbox').value) - Number(b.querySelector('.spotify-track-checkbox').value))
                            .forEach((row, index, rows) => list.appendChild(rows[descending ? rows.length - 1 - index : index]));
                    });
                    updateSpotifyTrackSelection();

                    if (dlInfo.track_count > tracks.length) {
                        const moreTracks = document.createElement('div');
                        moreTracks.className = 'spotify-more-tracks';
                        moreTracks.textContent = `${dlInfo.track_count - tracks.length} more tracks are not available in Spotify preview.`;
                        optionsDiv.appendChild(moreTracks);
                    }

                    // Playlist selections are supported by both immediate and scheduled downloads.
                    if (scheduleToggle) {
                        scheduleToggle.style.display = 'inline-flex';
                        scheduleToggle.title = 'Schedule selected tracks';
                    }
                } else {
                    // Single track
                    optionsDiv.innerHTML = `
                        <label class="quality-option active">
                            <input type="radio" name="quality" value="audio" checked onchange="selectedQuality='audio'; updateQualitySelection()">
                            <div class="q-info">
                                <span class="q-title">🎵 Audio (MP3)</span>
                                <span class="q-size">From Spotify via YouTube</span>
                            </div>
                        </label>
                    `;
                }
            } else {
                window.isDirectFile = false;
                window.isSpotify = false;

                const qualities = [
                    { id: 'best', title: 'Video (Max)' },
                    { id: '1080p', title: 'Video (1080p)' },
                    { id: '720p', title: 'Video (720p)' },
                    { id: '480p', title: 'Video (480p)' },
                    { id: '360p', title: 'Video (360p)' },
                    { id: 'audio', title: 'Audio (MP3)' }
                ];
                const preferredQuality = qualities.some(q => q.id === appSettings.defaultQuality)
                    ? appSettings.defaultQuality : 'best';

                let optionsHtml = '';
                qualities.forEach(q => {
                    const size = sizes[q.id];
                    const isSelected = q.id === preferredQuality;
                    // Always show them as requested by user, even if sizes are similar
                    optionsHtml += `
                        <label class="quality-option ${isSelected ? 'active' : ''}">
                            <input type="radio" name="quality" value="${q.id}" ${isSelected ? 'checked' : ''} onchange="selectedQuality='${q.id}'; updateQualitySelection()">
                            <div class="q-info">
                                <span class="q-title">${q.title}</span>
                                <span class="q-size">${size ? formatBytes(size) : 'Auto (Size Unknown)'}</span>
                            </div>
                        </label>
                    `;
                });
                optionsDiv.innerHTML = optionsHtml;
                selectedQuality = preferredQuality;
            }
            document.getElementById('quality-modal').style.display = 'flex';
        } else {
            showToast("Failed to fetch info: " + data.message, "#ef4444");
        }
    } catch (error) {
        console.error("Error fetching info", error);
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            showToast("Request timed out. Please try again.", "#ef4444");
        } else {
            showToast("Failed to connect to server", "#ef4444");
        }
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="download-cloud"></i> <span id="btn-fetch-text">Fetch Info</span>`;
        if (window.lucide) lucide.createIcons();
    }
});

function updateQualitySelection() {
    document.querySelectorAll('.quality-option').forEach(el => {
        el.classList.remove('active');
        if (el.querySelector('input').checked) {
            el.classList.add('active');
        }
    });
}

document.getElementById('btn-cancel-modal')?.addEventListener('click', () => {
    if (window.spotifyDownloadPending) return;
    document.getElementById('quality-modal').style.display = 'none';
    const container = document.getElementById('schedule-picker-container');
    if (container) container.style.display = 'none';
    const scheduleBtn = document.getElementById('btn-schedule-toggle');
    if (scheduleBtn) scheduleBtn.style.background = '';
    const startBtn = document.getElementById('btn-start-download');
    if (startBtn) {
        startBtn.innerText = 'Download';
        startBtn.disabled = false;
    }
});

document.getElementById('btn-schedule-toggle')?.addEventListener('click', () => {
    if (window.spotifyDownloadPending) return;
    const container = document.getElementById('schedule-picker-container');
    const scheduleBtn = document.getElementById('btn-schedule-toggle');
    const startBtn = document.getElementById('btn-start-download');
    const isHidden = container.style.display === 'none';
    
    if (isHidden) {
        container.style.display = 'block';
        if (scheduleBtn) scheduleBtn.style.background = 'rgba(59, 130, 246, 0.25)';
        if (startBtn) startBtn.innerText = 'Schedule Download';

        // Pre-fill schedule-time with 1 hour from now if empty
        const timeInput = document.getElementById('schedule-time');
        if (timeInput && !timeInput.value) {
            const oneHourLater = new Date(Date.now() + 60 * 60 * 1000);
            const localIso = new Date(oneHourLater.getTime() - oneHourLater.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
            timeInput.value = localIso;
            timeInput.min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        }
    } else {
        container.style.display = 'none';
        if (scheduleBtn) scheduleBtn.style.background = '';
        if (startBtn) startBtn.innerText = 'Download';
    }
});

document.getElementById('btn-start-download')?.addEventListener('click', async () => {
    if (window.spotifyDownloadPending) return;
    const url = document.getElementById('url-input').value;
    const downloadUrl = window.resolvedDownloadUrl || url;
    const isSpotifyRequest = window.isSpotify;
    const isYouTubePlaylistRequest = window.isYouTubePlaylist;
    const qualityModal = document.getElementById('quality-modal');
    if (!isSpotifyRequest) qualityModal.style.display = 'none';

    const scheduleTime = document.getElementById('schedule-time').value;
    const scheduleContainer = document.getElementById('schedule-picker-container');
    const scheduleBtn = document.getElementById('btn-schedule-toggle');
    const startBtn = document.getElementById('btn-start-download');

    if (isSpotifyRequest && !scheduleTime && startBtn) {
        window.spotifyDownloadPending = true;
        startBtn.disabled = true;
        qualityModal.style.display = 'none';
        const dlList = document.getElementById('downloads-list');
        if (dlList) dlList.scrollIntoView({ behavior: 'smooth', block: 'start' });
        showToast('جاري تجهيز تنزيل Spotify وإضافته لقائمة التنزيلات...', '#1db954');
    }

    if (scheduleContainer) scheduleContainer.style.display = 'none';
    if (scheduleBtn) scheduleBtn.style.background = '';
    if (startBtn && !window.spotifyDownloadPending) startBtn.innerText = 'Download';
    document.getElementById('schedule-time').value = '';

    // Determine save path: one-time override > settings default
    const effectivePath = customSavePath || appSettings.defaultSavePath;

    try {
        if (scheduleTime) {
            // Schedule the download
            const d = new Date(scheduleTime);
            if (isNaN(d.getTime()) || d <= new Date()) {
                showToast("Scheduled time must be in the future", "#ef4444");
                return;
            }
            await axios.post(`${API_URL}/schedule`, {
                url: downloadUrl,
                save_path: effectivePath,
                is_yt_dlp: window.isDirectFile ? false : true,
                quality: window.isSpotify ? 'audio' : selectedQuality,
                run_at: d.toISOString(),
                title: document.getElementById('modal-title').innerText,
                ...(window.isSpotifyMultiTrack ? { selected_track_indices: [...window.selectedSpotifyTrackIndices] } : {}),
                ...(isYouTubePlaylistRequest ? {
                    youtube_videos: getYouTubePlaylistRequestVideos(),
                    selected_video_indices: [...window.selectedYouTubeVideoIndices]
                } : {})
            });
            showToast(`Download scheduled for ${d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`, "#3b82f6");
            if (isSpotifyRequest) qualityModal.style.display = 'none';
        } else {
            // Start immediately
            const response = await axios.post(`${API_URL}/download`, {
                url: downloadUrl,
                save_path: effectivePath,
                is_yt_dlp: window.isDirectFile ? false : true,
                quality: window.isSpotify ? 'audio' : selectedQuality,
                title: document.getElementById('modal-title').innerText,
                ...(window.isSpotifyMultiTrack ? { selected_track_indices: [...window.selectedSpotifyTrackIndices] } : {}),
                ...(window.isSpotify && window.spotifyTracks?.length ? { spotify_tracks: window.spotifyTracks } : {}),
                ...(isYouTubePlaylistRequest ? {
                    youtube_videos: getYouTubePlaylistRequestVideos(),
                    selected_video_indices: [...window.selectedYouTubeVideoIndices]
                } : {})
            });
            if (response?.data?.status === 'error') {
                throw new Error(response.data.message || 'Could not start the selected downloads');
            }
            const trackCount = response?.data?.count;
            const skippedTrackCount = response?.data?.failed_tracks?.length || 0;
            if (window.isSpotify) {
                const skippedMessage = skippedTrackCount ? `; skipped ${skippedTrackCount} unmatched/duplicate track(s)` : '';
                showToast(`Starting ${trackCount || 0} Spotify download${trackCount === 1 ? '' : 's'}${skippedMessage}...`, "#1db954");
            } else if (isYouTubePlaylistRequest) {
                showToast(`Starting ${trackCount || 0} YouTube video download${trackCount === 1 ? '' : 's'}...`, "#6366f1");
            } else {
                showToast("Starting Download...", "#10b981");
            }
            qualityModal.style.display = 'none';
            // Auto-scroll to downloads list so the user sees the new download
            const dlList = document.getElementById('downloads-list');
            if (dlList) {
                dlList.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }

        document.getElementById('url-input').value = '';
        window.resolvedDownloadUrl = null;

        // Reset one-time override after use
        customSavePath = null;
        updateSavePathDisplay();
        if (typeof loadStats === 'function') loadStats();
    } catch (error) {
        console.error("Error adding download", error);
        showToast(error?.response?.data?.message || error.message || "Failed to start/schedule download", "#ef4444");
    } finally {
        if (isSpotifyRequest && !scheduleTime && startBtn) {
            window.spotifyDownloadPending = false;
            startBtn.disabled = false;
            startBtn.innerText = 'Download';
            if (window.lucide) lucide.createIcons();
        }
    }
});


let activeToast = null;
let activeToastText = '';
let activeToastTimer = null;
let lastToastText = '';
let lastToastAt = 0;

function showToast(text, color = '#6366f1', duration = 3000) {
    const message = String(text ?? '').trim();
    if (!message || !window.Toastify) return;

    const now = Date.now();
    if (message === activeToastText && activeToast) return;
    // Ignore a just-dismissed duplicate too, so repeated events do not flash.
    if (message === lastToastText && now - lastToastAt < 1400) return;

    if (activeToastTimer) clearTimeout(activeToastTimer);
    if (activeToast?.hideToast) activeToast.hideToast();
    document.querySelectorAll('.toastify.ledo-glass-toast').forEach(toast => toast.remove());

    activeToastText = message;
    lastToastText = message;
    lastToastAt = now;
    activeToast = Toastify({
        text: message,
        duration: Math.max(1200, Number(duration) || 3000),
        gravity: 'top',
        position: 'center',
        className: 'ledo-glass-toast',
        style: { '--toast-accent': color },
        close: true,
        stopOnFocus: true,
        onClick: () => activeToast?.hideToast?.()
    });
    activeToast.showToast();
    activeToast.toastElement?.style.setProperty('--toast-accent', color);

    const shownToast = activeToast;
    activeToastTimer = setTimeout(() => {
        if (activeToast === shownToast) {
            activeToast = null;
            activeToastText = '';
            activeToastTimer = null;
        }
    }, Math.max(1200, Number(duration) || 3000) + 450);
}
window.showToast = showToast;

window.copyDownloadSha256 = async function(downloadId) {
    showToast('جاري حساب بصمة SHA-256 للملف…', '#6366f1', 30000);
    try {
        const response = await axios.get(`${API_URL}/downloads/${encodeURIComponent(downloadId)}/sha256`, { timeout: 600000 });
        const digest = response.data?.sha256;
        if (!digest) throw new Error('لم يرجع المحرك بصمة الملف.');
        if (!window.electronAPI?.writeClipboardText) throw new Error('تعذر الوصول إلى الحافظة.');
        await window.electronAPI.writeClipboardText(digest);
        showToast(`تم نسخ بصمة SHA-256 للملف ${response.data.filename || ''}`, '#10b981', 5000);
    } catch (error) {
        showToast(error?.response?.data?.detail || error.message || 'تعذر حساب بصمة الملف.', '#ef4444', 5000);
    }
};

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m ${remainder}s`;
    return `${remainder}s`;
}

function getSmoothedDownloadSpeed(download) {
    const samples = (window.speedHistory[download.id] || [])
        .filter(speed => Number.isFinite(speed) && speed > 0)
        .slice(-9);
    if (!samples.length) return Number(download.speed) > 0 ? Number(download.speed) : 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function getDownloadEtaSeconds(download) {
    if (download.status !== 'downloading') return null;

    const total = Number(download.total_size) || 0;
    const downloaded = Number(download.downloaded) || 0;
    if (total > downloaded) {
        const speed = getSmoothedDownloadSpeed(download);
        if (speed > 0) return Math.ceil((total - downloaded) / speed);
    }

    // Some sites report percentage but not a known file size.
    const samples = window.progressHistory[download.id] || [];
    if (samples.length >= 2) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        const elapsedSeconds = (last.at - first.at) / 1000;
        if (elapsedSeconds > 0 && Date.now() - last.at <= 10000 && last.progress > first.progress) {
            const percentPerSecond = (last.progress - first.progress) / elapsedSeconds;
            return Math.ceil(Math.max(0, 100 - Number(download.progress || 0)) / percentPerSecond);
        }
    }
    return null;
}

function renderDownloads(downloads, pagination = null) {
    const listEl = document.getElementById('downloads-list');
    if (!listEl || !Array.isArray(downloads)) return;
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));

    // Remove cards that are no longer in the payload
    const currentIds = downloads.map(dl => `dl-card-${dl.id}`);
    Array.from(listEl.children).forEach(child => {
        if (!currentIds.includes(child.id) && child.id !== 'downloads-filter-empty' && child.id !== 'downloads-load-more') {
            child.remove();
        }
    });

    downloads.forEach((dl, index) => {
        let card = document.getElementById(`dl-card-${dl.id}`);

        const savedActiveSeconds = Number(dl.active_elapsed_seconds) || 0;
        const hasActiveElapsed = savedActiveSeconds > 0 || Boolean(dl.active_started_at);
        const elapsedDownloadSeconds = Math.max(0, hasActiveElapsed
            ? savedActiveSeconds
                + (dl.active_started_at && dl.status === 'downloading'
                    ? Math.max(0, Date.now() - Number(dl.active_started_at)) / 1000 : 0)
            : dl.completed_at && dl.created_at
                ? (Number(dl.completed_at) - Number(dl.created_at)) / 1000
                : 0);
        const averageSpeed = elapsedDownloadSeconds > 0 && Number(dl.downloaded) > 0
            ? formatBytes(Number(dl.downloaded) / elapsedDownloadSeconds) + '/s'
            : '--';
        const speed = dl.status === 'completed'
            ? averageSpeed
            : dl.speed ? formatBytes(dl.speed) + '/s' : '--';
        const size = dl.total_size ? formatBytes(dl.total_size) : 'Unknown';
        const etaSeconds = getDownloadEtaSeconds(dl);
        const elapsedSeconds = dl.completed_at
            ? (Number(dl.active_elapsed_seconds) > 0
                ? Math.max(0, Math.ceil(Number(dl.active_elapsed_seconds)))
                : dl.created_at ? Math.max(0, Math.ceil((Number(dl.completed_at) - Number(dl.created_at)) / 1000)) : null)
            : null;
        const eta = dl.status === 'completed'
            ? (elapsedSeconds === null ? 'Finished' : `Finished in ${formatDuration(elapsedSeconds)}`)
            : dl.status === 'processing'
                ? 'Finalizing…'
                : dl.status === 'paused'
                    ? 'Paused'
                    : etaSeconds === null ? 'ETA --' : `ETA ${formatDuration(etaSeconds)}`;
        const name = dl.filename || dl.url;
        const safeName = escapeHtml(name);
        const statusLabel = dl.status === 'resolving'
        ? 'جاري البحث عن بيانات الأغنية…'
            : dl.status === 'preparing'
            ? 'Preparing download…'
            : dl.status === 'starting'
            ? (dl.queue_position ? `Queued ${dl.queue_position}/${dl.queue_total}` : 'Starting')
            : dl.status;
        const statusTitle = dl.status === 'resolving'
        ? 'النسبة تقديرية للبحث عن بيانات الأغنية ومطابقتها على YouTube، وليست نسبة تنزيل الملف'
            : dl.status === 'preparing'
            ? 'Preparing the source and getting the first data ready'
            : dl.status === 'starting'
            ? (dl.queue_position
                ? `Waiting for a download slot · position ${dl.queue_position} of ${dl.queue_total}`
                : 'Waiting for a download slot')
            : '';

        let errorHtml = '';
        if (dl.status === 'error' && dl.error_message) {
            const isLinkIssue = dl.error_message.includes('404') || dl.error_message.includes('403') || dl.error_message.includes('expired') || dl.error_message.includes('session') || dl.error_message.includes('rejected');
            const updateLinkBtn = isLinkIssue ? `
                <div style="margin-top: 8px;">
                    <button class="btn-refresh-link-inline" onclick="openUpdateUrlModal('${dl.id}', '${safeName}')" style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: rgba(59, 130, 246, 0.2); border: 1px solid rgba(59, 130, 246, 0.4); border-radius: 6px; color: #60a5fa; cursor: pointer; font-size: 12px; font-weight: 500; transition: all 0.2s;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                        <span>تحديث الرابط واستئناف التحميل (Update Link)</span>
                    </button>
                </div>
            ` : '';
            errorHtml = `
                <div style="color: #ef4444; font-size: 13px; margin-top: 10px; background: rgba(239, 68, 68, 0.1); padding: 8px 12px; border-radius: 6px;">
                    ${escapeHtml(dl.error_message)}
                    ${dl.error_hint ? `<div style="margin-top: 5px; color: var(--text-muted); font-size: 12px;">${escapeHtml(dl.error_hint)}</div>` : ''}
                    ${updateLinkBtn}
                </div>
            `;
        }

        let actionBtnHtml = '';
        if (['downloading', 'starting', 'resolving', 'preparing'].includes(dl.status)) {
            actionBtnHtml = `
                ${dl.status !== 'resolving' ? `
                <button class="btn-action" onclick="pauseDownload('${dl.id}')" title="Pause Download" style="background: none; border: none; color: #f59e0b; cursor: pointer; padding: 4px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
                </button>
                ` : ''}
                <button class="btn-cancel-dl" onclick="cancelDownload('${dl.id}')" title="Cancel Download">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            `;
        } else if (dl.status === 'paused') {
            actionBtnHtml = `
                <button class="btn-action" onclick="resumeDownload('${dl.id}')" title="Resume Download" style="background: none; border: none; color: #10b981; cursor: pointer; padding: 4px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </button>
                <button class="btn-cancel-dl" onclick="cancelDownload('${dl.id}')" title="Cancel Download">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            `;
        } else if (dl.status === 'error') {
            actionBtnHtml = `
                <button class="btn-action" onclick="retryDownload('${dl.id}')" title="Retry Download" style="background: none; border: none; color: #3b82f6; cursor: pointer; padding: 4px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                </button>
                <button class="btn-action" onclick="openUpdateUrlModal('${dl.id}', '${safeName}')" title="Update Download Link (تحديث الرابط)" style="background: none; border: none; color: #a855f7; cursor: pointer; padding: 4px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                </button>
                <button class="btn-cancel-dl" onclick="cancelDownload('${dl.id}')" title="Cancel Download">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            `;
        }

        let playBtnHtml = '';

        const isIndeterminate = ['preparing', 'starting'].includes(dl.status)
            || (dl.status === 'resolving' && !(Number(dl.progress) > 0));
        const isWaitingForTransfer = ['resolving', 'preparing', 'starting'].includes(dl.status);
        const progressWidth = isIndeterminate ? '32%' : `${Math.max(0, Math.min(100, Number(dl.progress) || 0))}%`;
        const byteLabel = dl.status === 'resolving' ? 'بحث عن بيانات ومطابقة الأغنية — مش تنزيل الملف'
            : dl.status === 'preparing' ? 'Preparing source…'
                : dl.status === 'starting' ? 'Waiting for a download slot…'
                    : `${formatBytes(dl.downloaded)} / ${size}`;
        const speedHtml = dl.status === 'completed'
            ? `<span class="dl-average-speed" title="متوسط سرعة التنزيل خلال وقت التنزيل الفعلي، دون احتساب فترات الإيقاف والتجهيز">Avg ${averageSpeed}</span>`
            : dl.status === 'downloading' && Number(dl.speed) > 0
                ? `<span class="dl-speed-pill">▼ ${speed}</span>`
                : (dl.status === 'processing' || isWaitingForTransfer ? '—' : speed);
        const averageSpeedHtml = '';
        const etaHtml = dl.status === 'downloading' && etaSeconds !== null
            ? `<span class="dl-eta-pill">⏱ ${formatDuration(etaSeconds)}</span>`
            : (isWaitingForTransfer ? '—' : eta);
        const percentLabel = dl.status === 'resolving'
            ? `حوالي ${Math.round(Number(dl.progress) || 0)}% من البحث`
            : isWaitingForTransfer ? '—' : `${dl.progress.toFixed(1)}%`;
        const innerHTML = `
            <div class="dl-header" style="cursor: grab;">
                <div title="Drag to reorder" style="color: var(--text-muted); display: flex; align-items: center; margin-right: 8px;">
                    <i data-lucide="grip-vertical" style="width: 16px; height: 16px;"></i>
                </div>
                <div class="dl-title" title="${safeName}"><span class="dl-title-text">${safeName}</span>${dl.source === 'telegram' ? '<span class="dl-source-badge">from bot</span>' : ''}</div>
                <div class="dl-actions">
                    ${playBtnHtml}
            <div class="dl-status ${dl.status}" title="${statusTitle}">${statusLabel}</div>
                    ${actionBtnHtml}
                </div>
            </div>
            <div class="dl-error-box">${errorHtml}</div>
            <div class="progress-container">
            <div class="progress-bar${isIndeterminate ? ' is-resolving' : ''}" style="width: ${progressWidth}"></div>
            </div>
            <div class="dl-footer">
                <span>${byteLabel}</span>
                <span>${speedHtml}</span>
                ${averageSpeedHtml}
                <span>${percentLabel}</span>
                <span title="${dl.status === 'completed' ? 'Active download time, excluding pauses and processing' : 'Estimated time remaining'}">${etaHtml}</span>
            </div>
        `;

        if (!card) {
            card = document.createElement('div');
            card.id = `dl-card-${dl.id}`;
            card.className = `download-card status-${dl.status}`;
            card.dataset.status = dl.status;
            card.setAttribute('oncontextmenu', `showDownloadContextMenu(event, '${dl.id}', '${dl.status}')`);
            card.innerHTML = innerHTML;
            // We append below to reorder the DOM
            if (window.lucide) lucide.createIcons({ root: card });
            if (window.gsap && !appSettings.powerSaver) {
                gsap.fromTo(card, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" });
            }
            if (window.tippy) {
                tippy(card.querySelectorAll('[title]'), {
                    content(reference) { const title = reference.getAttribute('title'); reference.removeAttribute('title'); return title; },
                    animation: 'scale', theme: 'translucent', arrow: true,
                    onShow(instance) {
                        if (instance.reference.classList.contains('dl-average-speed')) {
                            instance.popper.querySelector('.tippy-box')?.setAttribute('dir', 'rtl');
                        }
                    }
                });
            }
        } else {
            // In-place update: avoids memory leaks, DOM rebuilding, and progress bar animation stutter
            if (card.dataset.status !== dl.status) {
                card.dataset.status = dl.status;
                card.className = `download-card status-${dl.status}`;
                card.setAttribute('oncontextmenu', `showDownloadContextMenu(event, '${dl.id}', '${dl.status}')`);
                const actionsBox = card.querySelector('.dl-actions');
                if (actionsBox) {
                    actionsBox.innerHTML = `${playBtnHtml}<div class="dl-status ${dl.status}">${statusLabel}</div>${actionBtnHtml}`;
                }
                const errorBox = card.querySelector('.dl-error-box');
                if (errorBox) {
                    errorBox.innerHTML = errorHtml;
                }
            }

            const titleEl = card.querySelector('.dl-title');
            if (titleEl && titleEl.textContent !== name) {
                titleEl.textContent = name;
                titleEl.title = name;
            }

            const bar = card.querySelector('.progress-bar');
            if (bar) {
                const indeterminate = ['resolving', 'preparing', 'starting'].includes(dl.status);
                bar.classList.toggle('is-resolving', indeterminate);
                bar.style.width = indeterminate ? '32%' : `${dl.progress}%`;
            }

            const statusEl = card.querySelector('.dl-status');
            if (statusEl && statusEl.textContent !== statusLabel) {
                statusEl.textContent = statusLabel;
            }
            if (statusEl && statusEl.title !== statusTitle) statusEl.title = statusTitle;

            const footer = card.querySelector('.dl-footer');
            if (footer) {
                footer.innerHTML = `<span>${byteLabel}</span><span>${speedHtml}</span>${averageSpeedHtml}<span>${percentLabel}</span><span title="${dl.status === 'completed' ? 'Active download time, excluding pauses and processing' : 'Estimated time remaining'}">${etaHtml}</span>`;
                // The footer is rebuilt during in-place updates, so attach the app-styled
                // tooltip to titles introduced after the card was first rendered.
                if (window.tippy) {
                    tippy(footer.querySelectorAll('[title]'), {
                        content(reference) { const title = reference.getAttribute('title'); reference.removeAttribute('title'); return title; },
                        animation: 'scale', theme: 'translucent', arrow: true,
                        onShow(instance) {
                            if (instance.reference.classList.contains('dl-average-speed')) {
                                instance.popper.querySelector('.tippy-box')?.setAttribute('dir', 'rtl');
                            }
                        }
                    });
                }
            }
        }

        // Force exact visual sorting without breaking DOM state
        card.style.order = index;

        if (!card.parentNode) {
            listEl.appendChild(card);
        }

        card.onclick = (e) => {
            if (e.target.closest('button') || e.target.closest('.dl-header i') || e.target.closest('.dl-header svg')) return;
            openDetailsDrawer(dl);
        };
    });

    let emptyState = document.getElementById('downloads-filter-empty');
    if (downloads.length === 0) {
        if (!emptyState) {
            emptyState = document.createElement('div');
            emptyState.id = 'downloads-filter-empty';
            emptyState.className = 'downloads-empty-state';
            listEl.appendChild(emptyState);
        }
        const hasDownloads = rawDownloadsData.length > 0;
        emptyState.innerHTML = `
            <div class="empty-state-icon"><i data-lucide="${hasDownloads ? 'search-x' : 'download-cloud'}"></i></div>
            <h2>${hasDownloads ? 'No matching downloads' : 'No downloads yet'}</h2>
            <p>${hasDownloads ? 'Try another search or choose a different filter.' : 'Paste a link above to start your next download.'}</p>
            ${hasDownloads ? '' : '<span><i data-lucide="sparkles"></i> Video, audio, and direct files · Ctrl+Space for Quick Add</span>'}
        `;
        if (window.lucide) lucide.createIcons({ root: emptyState });
    } else if (emptyState) {
        emptyState.remove();
    }

    let loadMore = document.getElementById('downloads-load-more');
    if (pagination?.hasMore) {
        if (!loadMore) {
            loadMore = document.createElement('button');
            loadMore.id = 'downloads-load-more';
            loadMore.type = 'button';
            loadMore.className = 'downloads-load-more';
            listEl.appendChild(loadMore);
        }
        const remaining = pagination.total - pagination.visible;
        const nextCount = Math.min(DOWNLOAD_HISTORY_PAGE_SIZE, remaining);
        loadMore.style.order = String(downloads.length);
        loadMore.textContent = `تحميل ${nextCount} تنزيل أقدم · ${remaining} متبقية`;
        loadMore.onclick = () => {
            downloadHistoryLimit += DOWNLOAD_HISTORY_PAGE_SIZE;
            applyFilterAndSort();
        };
    } else if (loadMore) {
        loadMore.remove();
    }

    // Keep an already-open detail panel in sync with the live download list.
    refreshOpenDetailsDrawer(rawDownloadsData);
}

// Proactive refresh on window focus / startup
let refreshInProgress = false;
let lastDownloadsFallbackAt = 0;
async function refreshDownloads() {
    if (refreshInProgress) return;
    refreshInProgress = true;
    try {
        const res = await axios.get(`${API_URL}/downloads`, { timeout: 3000 });
        if (res.data && Array.isArray(res.data)) {
            processDownloadsState(res.data);
        }
    } catch (e) {
        // The WebSocket remains the primary update path; this request is a recovery fallback.
    } finally {
        refreshInProgress = false;
    }
}

// The WebSocket is the normal update path. Poll only as a recovery path when
// it stops delivering download state, with a much longer idle retry interval.
setInterval(() => {
    if (!windowIsVisible) return;
    const now = Date.now();
    const hasActiveDownloads = rawDownloadsData.some(download =>
        ['downloading', 'starting', 'resolving', 'preparing', 'processing'].includes(download.status)
    );
    const socketOpen = ws?.readyState === WebSocket.OPEN;

    // Reconnects already request a fresh snapshot, so an idle disconnected
    // app does not need to keep querying and sorting the full history.
    if (!hasActiveDownloads && !socketOpen) return;

    const staleAfter = hasActiveDownloads ? 12000 : 60000;
    const minimumRefreshGap = appSettings.powerSaver ? 10000 : (hasActiveDownloads ? 5000 : 60000);
    if (socketOpen && now - lastDownloadsMessageAt < staleAfter) return;
    if (now - lastDownloadsFallbackAt < minimumRefreshGap) return;

    lastDownloadsFallbackAt = now;
    refreshDownloads();
}, 5000);

// Drawer Logic
let drawerChartInstance = null;
let activeDetailsDownloadId = null;
function openDetailsDrawer(dl) {
    activeDetailsDownloadId = dl.id || null;
    const drawer = document.getElementById('details-drawer');
    const content = drawer.querySelector('.drawer-content');

    // Format dates robustly
    let dateAdded = 'Unknown';
    if (dl.created_at) {
        if (window.dayjs) {
            dateAdded = dayjs(dl.created_at).format('DD MMM YYYY, hh:mm A');
        } else {
            const d = new Date(dl.created_at);
            dateAdded = isNaN(d.getTime()) ? 'Recently' : d.toLocaleString('en-US', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
        }
    }

    let html = `
        <div class="drawer-header-content">
            <div class="drawer-icon">
                <i data-lucide="file" style="width: 24px; height: 24px; color: var(--accent-primary);"></i>
            </div>
            <div class="drawer-title-group">
                <div id="drawer-filename" class="drawer-filename" title="${escapeDrawerText(dl.filename || 'Unknown')}">${escapeDrawerText(dl.filename || 'Unknown')}</div>
                <div id="drawer-status" class="drawer-status-badge ${dl.status}">${escapeDrawerText(dl.status.toUpperCase())}</div>
            </div>
        </div>
        
        <div class="drawer-stats-grid">
            <div class="drawer-stat-box">
                <div class="stat-lbl">FILE SIZE</div>
                <div id="drawer-size" class="stat-val">${formatBytes(dl.total_size)}</div>
            </div>
            <div class="drawer-stat-box">
                <div class="stat-lbl">DATE ADDED</div>
                <div id="drawer-date" class="stat-val">${dateAdded}</div>
            </div>
        </div>
        
        <div class="drawer-url-box">
            <div class="stat-lbl">SOURCE URL</div>
            <div id="drawer-url" class="url-val" title="${escapeDrawerText(dl.url || '')}">${escapeDrawerText(dl.url || '')}</div>
        </div>
        
        <div class="drawer-chart-section">
            <div class="chart-header">
                <span class="chart-title-lbl">NETWORK SPEED</span>
                <span id="drawer-live" class="live-indicator" style="display: ${dl.status === 'downloading' ? 'flex' : 'none'}"><span class="dot"></span>LIVE</span>
            </div>
            <div class="speed-chart-container-premium">
                <canvas id="drawerSpeedChart"></canvas>
            </div>
        </div>
    `;
    content.innerHTML = html;
    if (window.lucide) lucide.createIcons({ root: content });

    drawer.classList.add('open');
    if (window.gsap && !appSettings.powerSaver) {
        gsap.fromTo(content.children, { opacity: 0, y: 15 }, { opacity: 1, y: 0, duration: 0.3, stagger: 0.05, ease: "power2.out" });
    }
    // Draw speed chart — Binance style: green line, no fill, right axis, sharp
    setTimeout(() => {
        const ctx = document.getElementById('drawerSpeedChart');
        if (ctx) {
            if (drawerChartInstance) drawerChartInstance.destroy();
            const history = window.speedHistory[dl.id] || [];

            // For completed files with no speed history, generate a sample curve
            let plotData = history.length > 0 ? history : [0, 0, 0];
            if (dl.status === 'completed' && history.length === 0) {
                const avgSpeed = (dl.total_size || 10000000) / 10;
                plotData = [0, avgSpeed * 0.4, avgSpeed * 0.9, avgSpeed * 1.1, avgSpeed * 1.5, avgSpeed * 1.2, avgSpeed, avgSpeed * 0.8, avgSpeed * 0.3, 0];
            }

            drawerChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: plotData.map((_, i) => i),
                    datasets: [{
                        label: 'Speed',
                        data: plotData,
                        borderColor: '#0ecb81',
                        backgroundColor: 'transparent',
                        fill: false,
                        tension: 0.15,
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        pointBackgroundColor: '#0ecb81'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            mode: 'index',
                            intersect: false,
                            backgroundColor: 'rgba(11, 14, 17, 0.95)',
                            titleColor: '#848e9c',
                            bodyColor: '#eaecef',
                            borderColor: '#2b3139',
                            borderWidth: 1,
                            callbacks: {
                                label: function (context) {
                                    return formatBytes(context.raw) + '/s';
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            display: false,
                            grid: { display: false }
                        },
                        y: {
                            display: true,
                            position: 'right',
                            min: 0,
                            border: { display: false },
                            grid: {
                                color: 'rgba(43, 49, 57, 0.5)',
                                drawBorder: false,
                                lineWidth: 1
                            },
                            ticks: {
                                color: '#848e9c',
                                font: { size: 11, family: 'Inter' },
                                maxTicksLimit: 3,
                                padding: 8,
                                callback: function (value) {
                                    if (value === 0) return '0';
                                    return formatBytes(value);
                                }
                            }
                        }
                    },
                    interaction: {
                        mode: 'nearest',
                        axis: 'x',
                        intersect: false
                    }
                }
            });
        }
    }, 300);
}

function escapeDrawerText(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

function refreshOpenDetailsDrawer(downloads) {
    if (!activeDetailsDownloadId) return;
    const dl = downloads.find(item => item.id === activeDetailsDownloadId);
    const drawer = document.getElementById('details-drawer');
    if (!dl) {
        drawer?.classList.remove('open');
        activeDetailsDownloadId = null;
        return;
    }
    if (!drawer?.classList.contains('open')) return;

    const filename = dl.filename || 'Unknown';
    const filenameEl = document.getElementById('drawer-filename');
    if (filenameEl) {
        filenameEl.textContent = filename;
        filenameEl.title = filename;
    }
    const statusEl = document.getElementById('drawer-status');
    if (statusEl) {
        statusEl.textContent = String(dl.status || 'unknown').toUpperCase();
        statusEl.className = `drawer-status-badge ${dl.status || 'unknown'}`;
    }
    const sizeEl = document.getElementById('drawer-size');
    if (sizeEl) sizeEl.textContent = formatBytes(dl.total_size);
    const dateEl = document.getElementById('drawer-date');
    if (dateEl) {
        const timestamp = Number(dl.created_at);
        dateEl.textContent = timestamp > 0
            ? (window.dayjs ? dayjs(timestamp).format('DD MMM YYYY, hh:mm A') : new Date(timestamp).toLocaleString('en-US'))
            : 'Unknown';
    }
    const urlEl = document.getElementById('drawer-url');
    if (urlEl) {
        urlEl.textContent = dl.url || '';
        urlEl.title = dl.url || '';
    }
    const liveEl = document.getElementById('drawer-live');
    if (liveEl) liveEl.style.display = dl.status === 'downloading' ? 'flex' : 'none';

    const chart = drawerChartInstance;
    if (chart) {
        const history = window.speedHistory[dl.id] || [];
        let plotData = history.length ? history : [0, 0, 0];
        if (dl.status === 'completed' && !history.length) {
            const averageSpeed = (Number(dl.total_size) || 10000000) / 10;
            plotData = [0, averageSpeed * 0.4, averageSpeed * 0.9, averageSpeed * 1.1, averageSpeed * 1.5, averageSpeed * 1.2, averageSpeed, averageSpeed * 0.8, averageSpeed * 0.3, 0];
        }
        chart.data.labels = plotData.map((_, index) => index);
        chart.data.datasets[0].data = plotData;
        chart.update('none');
    }
}

document.getElementById('btn-close-drawer')?.addEventListener('click', () => {
    document.getElementById('details-drawer').classList.remove('open');
    activeDetailsDownloadId = null;
});

// Custom Context Menu
const contextMenu = document.createElement('div');
contextMenu.id = 'custom-context-menu';
contextMenu.style.cssText = `
    position: fixed;
    z-index: 10000;
    width: 220px;
    background: var(--surface-light);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 8px 0;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    display: none;
    flex-direction: column;
    backdrop-filter: blur(10px);
`;
document.body.appendChild(contextMenu);

document.addEventListener('click', (e) => {
    if (contextMenu.style.display === 'flex' && !contextMenu.contains(e.target)) {
        contextMenu.style.display = 'none';
    }
});

contextMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item) return;
    
    const action = item.dataset.action;
    const path = decodeURIComponent(item.dataset.path || '');
    const url = decodeURIComponent(item.dataset.url || '');
    const id = decodeURIComponent(item.dataset.id || '');
    const deleteFile = item.dataset.delete === 'true';

    if (action === 'open-file' && window.electronAPI && window.electronAPI.openPath) {
        window.electronAPI.openPath(path);
    } else if (action === 'open-folder') {
        if (window.electronAPI && window.electronAPI.showItemInFolder) {
            window.electronAPI.showItemInFolder(path);
        } else if (typeof openFolder === 'function') {
            openFolder(path);
        }
    } else if (action === 'copy-path' && window.electronAPI && window.electronAPI.writeClipboardText) {
        window.electronAPI.writeClipboardText(path);
    } else if (action === 'copy-url' && window.electronAPI && window.electronAPI.writeClipboardText) {
        window.electronAPI.writeClipboardText(url);
    } else if (action === 'copy-sha256') {
        if (typeof window.copyDownloadSha256 === 'function') window.copyDownloadSha256(id);
    } else if (action === 'cancel-download') {
        if (typeof cancelDownload === 'function') cancelDownload(id, deleteFile);
    } else if (action === 'pause-download') {
        if (typeof pauseDownload === 'function') pauseDownload(id);
    } else if (action === 'resume-download') {
        if (typeof resumeDownload === 'function') resumeDownload(id);
    } else if (action === 'retry-download') {
        if (typeof retryDownload === 'function') retryDownload(id);
    } else if (action === 'update-url') {
        const name = decodeURIComponent(item.dataset.name || '');
        if (typeof openUpdateUrlModal === 'function') openUpdateUrlModal(id, name);
    }
    
    contextMenu.style.display = 'none';
});

window.showDownloadContextMenu = function(e, id, status) {
    e.preventDefault();
    const dl = rawDownloadsData.find(d => d.id === id);
    if (!dl) return;
    
    let menuHtml = '';
    const encPath = encodeURIComponent(dl.save_path || '');
    const encUrl = encodeURIComponent(dl.url || '');
    const encId = encodeURIComponent(dl.id);
    // Use the freshest state we have; cards can receive a contextmenu event
    // before their inline handler has been refreshed with the latest status.
    status = dl.status || status;
    
    if (status === 'completed') {
        if (dl.save_path) {
            menuHtml += `<div class="ctx-item" data-action="open-file" data-path="${encPath}"><i data-lucide="play-circle"></i> Open File</div>`;
            menuHtml += `<div class="ctx-item" data-action="open-folder" data-path="${encPath}"><i data-lucide="folder-open"></i> Open Folder</div>`;
            menuHtml += `<div class="ctx-item" data-action="copy-path" data-path="${encPath}"><i data-lucide="copy"></i> Copy File Path</div>`;
        }
        if (dl.url) menuHtml += `<div class="ctx-item" data-action="copy-url" data-url="${encUrl}"><i data-lucide="link"></i> Copy Source URL</div>`;
        menuHtml += `<div class="ctx-item" data-action="copy-sha256" data-id="${encId}"><i data-lucide="fingerprint"></i> Calculate & Copy SHA-256</div>`;
        menuHtml += `<div class="ctx-separator"></div>`;
        menuHtml += `<div class="ctx-item ctx-danger" data-action="cancel-download" data-id="${encId}" data-delete="false"><i data-lucide="trash"></i> Remove from list</div>`;
        if (dl.save_path) menuHtml += `<div class="ctx-item ctx-danger" data-action="cancel-download" data-id="${encId}" data-delete="true"><i data-lucide="trash-2"></i> Delete File & Remove</div>`;
    } else if (status === 'downloading' || status === 'starting' || status === 'resolving' || status === 'preparing' || status === 'processing') {
        if (status === 'downloading' || status === 'starting' || status === 'preparing') {
            menuHtml += `<div class="ctx-item" data-action="pause-download" data-id="${encId}"><i data-lucide="pause"></i> Pause</div>`;
        }
        if (dl.url) menuHtml += `<div class="ctx-item" data-action="copy-url" data-url="${encUrl}"><i data-lucide="link"></i> Copy Source URL</div>`;
        menuHtml += `<div class="ctx-separator"></div>`;
        menuHtml += `<div class="ctx-item ctx-danger" data-action="cancel-download" data-id="${encId}" data-delete="false"><i data-lucide="x"></i> Cancel</div>`;
    } else if (status === 'paused') {
        menuHtml += `<div class="ctx-item" data-action="resume-download" data-id="${encId}"><i data-lucide="play"></i> Resume</div>`;
        if (dl.url) menuHtml += `<div class="ctx-item" data-action="copy-url" data-url="${encUrl}"><i data-lucide="link"></i> Copy Source URL</div>`;
        menuHtml += `<div class="ctx-separator"></div>`;
        menuHtml += `<div class="ctx-item ctx-danger" data-action="cancel-download" data-id="${encId}" data-delete="false"><i data-lucide="x"></i> Cancel</div>`;
    } else if (status === 'error') {
        menuHtml += `<div class="ctx-item" data-action="retry-download" data-id="${encId}"><i data-lucide="refresh-cw"></i> Retry</div>`;
        menuHtml += `<div class="ctx-item" data-action="update-url" data-id="${encId}" data-name="${encodeURIComponent(dl.filename || dl.url || '')}"><i data-lucide="link-2"></i> Update Download Link (تحديث الرابط)</div>`;
        if (dl.url) menuHtml += `<div class="ctx-item" data-action="copy-url" data-url="${encUrl}"><i data-lucide="link"></i> Copy Source URL</div>`;
        menuHtml += `<div class="ctx-separator"></div>`;
        menuHtml += `<div class="ctx-item ctx-danger" data-action="cancel-download" data-id="${encId}" data-delete="false"><i data-lucide="trash"></i> Remove from list</div>`;
    } else {
        // Keep a functional menu available for queued or future backend states.
        if (dl.url) menuHtml += `<div class="ctx-item" data-action="copy-url" data-url="${encUrl}"><i data-lucide="link"></i> Copy Source URL</div>`;
        menuHtml += `<div class="ctx-separator"></div>`;
        menuHtml += `<div class="ctx-item ctx-danger" data-action="cancel-download" data-id="${encId}" data-delete="false"><i data-lucide="trash"></i> Remove from list</div>`;
    }

    contextMenu.innerHTML = menuHtml;
    if (window.lucide) lucide.createIcons();
    
    contextMenu.style.display = 'flex';
    let x = e.clientX;
    let y = e.clientY;
    
    if (x + 220 > window.innerWidth) x = window.innerWidth - 220 - 10;
    if (y + contextMenu.offsetHeight > window.innerHeight) y = window.innerHeight - contextMenu.offsetHeight - 10;
    
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
}

// Add context menu CSS
const ctxStyle = document.createElement('style');
ctxStyle.innerHTML = `
    @keyframes ctxMenuPop {
        0% { opacity: 0; transform: scale(0.95); }
        100% { opacity: 1; transform: scale(1); }
    }
    #custom-context-menu {
        animation: ctxMenuPop 0.15s cubic-bezier(0.2, 0.8, 0.2, 1);
        transform-origin: top left;
    }
    .ctx-item {
        padding: 10px 16px;
        color: var(--text-color);
        font-size: 14px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 12px;
        transition: all 0.2s ease;
    }
    .ctx-item:hover {
        background: var(--surface-hover);
        color: var(--primary-color);
    }
    .ctx-item.ctx-danger:hover {
        background: rgba(239, 68, 68, 0.1);
        color: var(--danger-color);
    }
    .ctx-separator {
        height: 1px;
        background: var(--border-color);
        margin: 6px 0;
    }
    .ctx-item svg {
        width: 16px;
        height: 16px;
    }
`;
document.head.appendChild(ctxStyle);

window.cancelDownload = async function (id, forceDeleteFile = false) {
    contextMenu.style.display = 'none'; // hide context menu
    const dl = rawDownloadsData.find(d => d.id === id);
    const isCompleted = dl && dl.status === 'completed';
    
    if (window.Swal) {
        if (isCompleted) {
            if (forceDeleteFile) {
                Swal.fire({
                    title: 'Delete from Disk?',
                    text: "This will permanently delete the downloaded file from your computer.",
                    icon: 'warning',
                    showCancelButton: true,
                    confirmButtonText: 'Yes, delete file',
                    customClass: { popup: 'premium-swal', confirmButton: 'btn-danger-swal', cancelButton: 'btn-primary-swal' },
                    buttonsStyling: false
                }).then(async (result) => {
                    if (result.isConfirmed) {
                        try {
                            await axios.delete(`${API_URL}/cancel/${id}?delete_file=true`);
                            showToast("File deleted from disk and list.", "#ef4444");
                        } catch (e) {
                            showToast("Failed to delete file.", "#ef4444");
                        }
                    }
                });
            } else {
                try {
                    await axios.delete(`${API_URL}/cancel/${id}?delete_file=false`);
                    showToast("Removed from interface.", "#ef4444");
                } catch (e) {
                    showToast("Failed to remove from list.", "#ef4444");
                }
            }
        } else {
            Swal.fire({
                title: 'Cancel Download?',
                text: "Are you sure you want to cancel this download?",
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Yes, cancel it',
                customClass: { popup: 'premium-swal', confirmButton: 'btn-danger-swal', cancelButton: 'btn-primary-swal' },
                buttonsStyling: false
            }).then(async (result) => {
                if (result.isConfirmed) {
                    try {
                        await axios.delete(`${API_URL}/cancel/${id}`);
                        showToast("Download canceled.", "#ef4444");
                    } catch (e) {
                        console.error("Cancel failed", e);
                        showToast("Failed to cancel download.", "#ef4444");
                    }
                }
            });
        }
    } else {
        if (confirm("Are you sure?")) {
            try {
                await axios.delete(`${API_URL}/cancel/${id}?delete_file=${forceDeleteFile}`);
                showToast("Action completed.", "#ef4444");
            } catch (e) {
                console.error("Action failed", e);
                showToast("Failed to complete action.", "#ef4444");
            }
        }
    }
}

window.pauseDownload = async function(id) {
    try {
        await axios.post(`${API_URL}/pause/${id}`);
        showToast("Pausing download...", "#f59e0b");
    } catch (e) {
        console.error("Pause failed", e);
        showToast("Failed to pause download.", "#ef4444");
    }
}

window.resumeDownload = async function(id) {
    try {
        await axios.post(`${API_URL}/resume/${id}`);
        showToast("Resuming download...", "#10b981");
    } catch (e) {
        console.error("Resume failed", e);
        showToast("Failed to resume download.", "#ef4444");
    }
}

window.retryDownload = async function(id) {
    try {
        const pendingRetry = autoRetryTimers.get(id);
        if (pendingRetry) clearTimeout(pendingRetry);
        autoRetryTimers.delete(id);
        autoRetryAttempts.delete(id);
        await axios.post(`${API_URL}/resume/${id}`);
        showToast("Retrying download...", "#3b82f6");
    } catch (e) {
        console.error("Retry failed", e);
        showToast("Failed to retry download.", "#ef4444");
    }
}

// Update Download Link Logic (تحديث رابط التحميل)
let currentUpdateUrlDownloadId = null;

window.openUpdateUrlModal = async function(id, filename) {
    currentUpdateUrlDownloadId = id;
    const modal = document.getElementById('update-url-modal');
    const nameEl = document.getElementById('update-url-filename');
    const inputEl = document.getElementById('input-new-download-url');
    const errorEl = document.getElementById('update-url-error');
    
    if (!modal) return;
    
    if (nameEl) nameEl.textContent = filename || 'File';
    if (errorEl) {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
    }
    if (inputEl) {
        inputEl.value = '';
        inputEl.style.borderColor = '';
        
        try {
            let clipText = '';
            if (window.electronAPI && window.electronAPI.readClipboardText) {
                clipText = await window.electronAPI.readClipboardText();
            } else if (navigator.clipboard && navigator.clipboard.readText) {
                clipText = await navigator.clipboard.readText();
            }
            if (clipText && (clipText.startsWith('http://') || clipText.startsWith('https://'))) {
                inputEl.value = clipText.trim();
            }
        } catch (e) {
            // Ignore clipboard errors
        }
    }
    
    modal.style.display = 'flex';
    if (inputEl) {
        inputEl.focus();
        inputEl.select();
    }
    if (window.lucide) lucide.createIcons();
};

function closeUpdateUrlModal() {
    const modal = document.getElementById('update-url-modal');
    if (modal) modal.style.display = 'none';
    currentUpdateUrlDownloadId = null;
}

document.getElementById('btn-cancel-update-url')?.addEventListener('click', closeUpdateUrlModal);

document.getElementById('btn-paste-new-url')?.addEventListener('click', async () => {
    const inputEl = document.getElementById('input-new-download-url');
    if (!inputEl) return;
    try {
        let clipText = '';
        if (window.electronAPI && window.electronAPI.readClipboardText) {
            clipText = await window.electronAPI.readClipboardText();
        } else if (navigator.clipboard && navigator.clipboard.readText) {
            clipText = await navigator.clipboard.readText();
        }
        if (clipText) {
            inputEl.value = clipText.trim();
            inputEl.focus();
        }
    } catch (e) {
        showToast('Could not read clipboard', '#ef4444');
    }
});

document.getElementById('btn-confirm-update-url')?.addEventListener('click', async () => {
    if (!currentUpdateUrlDownloadId) return;
    const inputEl = document.getElementById('input-new-download-url');
    const errorEl = document.getElementById('update-url-error');
    const btnConfirm = document.getElementById('btn-confirm-update-url');
    const newUrl = inputEl?.value?.trim();
    
    if (!newUrl || (!newUrl.startsWith('http://') && !newUrl.startsWith('https://'))) {
        if (errorEl) {
            errorEl.textContent = 'يرجى إدخال رابط تحميل صحيح يبدأ بـ http:// أو https://';
            errorEl.style.display = 'block';
        }
        if (inputEl) inputEl.style.borderColor = '#ef4444';
        return;
    }
    
    try {
        if (btnConfirm) {
            btnConfirm.disabled = true;
            btnConfirm.innerHTML = '<span>جاري التحديث...</span>';
        }
        
        const res = await axios.post(`${API_URL}/update-url`, {
            id: currentUpdateUrlDownloadId,
            new_url: newUrl,
            user_agent: navigator.userAgent
        }, { timeout: 15000 });
        
        if (res.data && res.data.status === 'updated') {
            showToast('تم تحديث الرابط بنجاح! جاري استئناف التحميل...', '#10b981');
            closeUpdateUrlModal();
        } else {
            throw new Error(res.data?.message || 'فشل تحديث الرابط');
        }
    } catch (err) {
        console.error('Update URL failed:', err);
        if (errorEl) {
            errorEl.textContent = err.response?.data?.detail || err.message || 'فشل تحديث الرابط';
            errorEl.style.display = 'block';
        }
        showToast('فشل تحديث الرابط', '#ef4444');
    } finally {
        if (btnConfirm) {
            btnConfirm.disabled = false;
            btnConfirm.innerHTML = '<i data-lucide="play" style="width: 15px; height: 15px;"></i> <span>تحديث واستئناف</span>';
            if (window.lucide) lucide.createIcons();
        }
    }
});

document.getElementById('input-new-download-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        document.getElementById('btn-confirm-update-url')?.click();
    } else if (e.key === 'Escape') {
        closeUpdateUrlModal();
    }
});

// Media Player Logic
let myPlayer = null;
window.playMedia = function (id, filename) {
    const isAudio = filename && (filename.endsWith('.mp3') || filename.endsWith('.m4a') || filename.endsWith('.wav'));

    // Destroy existing player cleanly
    if (myPlayer) {
        try {
            myPlayer.destroy();
        } catch (e) { }
        myPlayer = null;
    }

    // Replace the media element in the DOM dynamically
    const container = document.getElementById('player-modal').querySelector('.modal-content');
    const closeBtn = document.getElementById('btn-close-player');
    const oldMedia = document.getElementById('player');
    if (oldMedia) oldMedia.remove();

    const mediaEl = document.createElement(isAudio ? 'audio' : 'video');
    mediaEl.id = 'player';
    mediaEl.controls = true;
    mediaEl.playsInline = true;
    // Insert before close button so button stays accessible
    if (closeBtn) {
        container.insertBefore(mediaEl, closeBtn.nextSibling);
    } else {
        container.appendChild(mediaEl);
    }

    myPlayer = new Plyr('#player', {
        controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'fullscreen']
    });

    const playerModal = document.getElementById('player-modal');
    playerModal.style.display = 'flex';

    // Use Plyr 'ready' event to auto-play only after source is fully loaded
    myPlayer.once('ready', () => {
        const p = myPlayer.play();
        if (p !== undefined) {
            p.catch(() => { }); // Silently handle if interrupted
        }
    });

    myPlayer.source = {
        type: isAudio ? 'audio' : 'video',
        sources: [
            {
                src: `${API_URL}/stream/${id}`,
                provider: 'html5',
            },
        ],
    };
};

document.getElementById('btn-close-player')?.addEventListener('click', () => {
    if (myPlayer) {
        try {
            myPlayer.pause();
            myPlayer.destroy();
        } catch (e) { }
        myPlayer = null;
    }
    // Remove the media element to fully stop any loading/playback
    const mediaEl = document.getElementById('player');
    if (mediaEl) mediaEl.remove();
    document.getElementById('player-modal').style.display = 'none';
});

// Chart.js Stats Logic
let statsChartInstance = null;

async function loadStats() {
    try {
        await refreshDownloads();
        const res = await axios.get(`${API_URL}/stats`);
        const data = res.data || {};

        const totalFiles = data.total_files || 0;
        const totalBytes = data.total_downloaded_bytes || 0;
        const completed = data.completed || 0;
        const errors = data.errors || 0;
        const videos = data.videos || 0;
        const audios = data.audios || 0;

        const elTotal = document.getElementById('stat-total-files');
        const elBytes = document.getElementById('stat-total-bytes');
        const elComp = document.getElementById('stat-completed');
        const elErr = document.getElementById('stat-errors');
        const elVid = document.getElementById('stat-videos');
        const elAud = document.getElementById('stat-audios');
        const elOth = document.getElementById('stat-others');
        const elSucc = document.getElementById('stat-success-rate');

        const otherCount = Math.max(0, totalFiles - videos - audios);
        const successRate = (completed + errors) > 0 ? Math.round((completed / (completed + errors)) * 100) : 0;

        if (elTotal) elTotal.innerText = totalFiles;
        if (elBytes) elBytes.innerText = formatBytes(totalBytes);
        if (elComp) elComp.innerText = completed;
        if (elErr) elErr.innerText = errors;
        if (elVid) elVid.innerText = videos;
        if (elAud) elAud.innerText = audios;
        if (elOth) elOth.innerText = otherCount;
        if (elSucc) elSucc.innerText = successRate + '%';

        const sevenDayCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
        const recentDownloads = rawDownloadsData.filter(download => Number(download.created_at) >= sevenDayCutoff).length;
        const elRecent = document.getElementById('stat-last-seven-days');
        if (elRecent) elRecent.innerText = String(recentDownloads);

        const chartCanvas = document.getElementById('downloadsChart');
        if (chartCanvas && window.Chart) {
            const ctx = chartCanvas.getContext('2d');
            if (statsChartInstance) {
                statsChartInstance.destroy();
            }

            const hasData = totalFiles > 0;
            const chartData = hasData ? [videos, audios, otherCount] : [1];
            const chartLabels = hasData ? ['Videos', 'Audio', 'Other Files'] : ['No Downloads Yet'];
            const chartColors = hasData ? ['#c084fc', '#fbbf24', '#60a5fa'] : ['rgba(255, 255, 255, 0.12)'];

            statsChartInstance = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: chartLabels,
                    datasets: [{
                        data: chartData,
                        backgroundColor: chartColors,
                        borderWidth: 0,
                        hoverOffset: hasData ? 8 : 0,
                        borderRadius: 4,
                        spacing: hasData ? 3 : 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '68%',
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                color: '#a1a1aa',
                                padding: 16,
                                usePointStyle: true,
                                pointStyleWidth: 10,
                                font: { family: 'Outfit, sans-serif', size: 12, weight: '500' }
                            }
                        },
                        tooltip: {
                            enabled: hasData
                        }
                    }
                }
            });
        }

        // Re-render lucide icons for the stats page and refresh the cleanup preview.
        if (window.lucide) lucide.createIcons();
        await loadCleanupPreview();
        return true;
    } catch (e) {
        console.error("Failed to load stats", e);
        return false;
    }
}

function formatStatsBytes(bytes) {
    const value = Number(bytes) || 0;
    return value < 1024 ? `${value} B` : formatBytes(value);
}

async function loadCleanupPreview() {
    const countEl = document.getElementById('cleanup-preview-count');
    const sizeEl = document.getElementById('cleanup-preview-size');
    const noteEl = document.getElementById('cleanup-preview-note');
    const filesEl = document.getElementById('cleanup-preview-files');
    const button = document.getElementById('btn-cleanup-temps');
    if (!countEl || !sizeEl || !button) return;
    try {
        const { data } = await axios.get(`${API_URL}/cleanup-preview`, { timeout: 15000 });
        const count = Number(data?.count) || 0;
        countEl.textContent = `${count} ${count === 1 ? 'file' : 'files'}`;
        sizeEl.textContent = formatStatsBytes(data?.bytes);
        noteEl.textContent = count
            ? 'These incomplete download fragments can be removed. Active downloads are protected.'
            : 'No removable temporary files found. Active downloads are protected.';
        filesEl.replaceChildren();
        (data?.files || []).forEach(file => {
            const item = document.createElement('li');
            const name = document.createElement('span');
            const size = document.createElement('small');
            name.textContent = file.name;
            size.textContent = formatStatsBytes(file.size);
            item.append(name, size);
            filesEl.appendChild(item);
        });
        if (data?.truncated) {
            const more = document.createElement('li');
            more.className = 'cleanup-preview-more';
            more.textContent = 'More files not shown';
            filesEl.appendChild(more);
        }
        button.disabled = count === 0;
        button.querySelector('span').textContent = count ? 'Clean temporary files' : 'Nothing to clean';
    } catch (error) {
        countEl.textContent = 'Unavailable';
        sizeEl.textContent = '—';
        noteEl.textContent = 'Could not scan temporary files. Refresh and try again.';
        filesEl.replaceChildren();
        button.disabled = true;
        button.querySelector('span').textContent = 'Preview unavailable';
    }
}

async function confirmHistoryAction(title, text, confirmText) {
    if (window.Swal) {
        const result = await Swal.fire({
            title, text, icon: 'warning', showCancelButton: true,
            confirmButtonText: confirmText, cancelButtonText: 'Cancel',
            customClass: { popup: 'premium-swal', confirmButton: 'btn-danger-swal', cancelButton: 'btn-primary-swal' },
            buttonsStyling: false
        });
        return result.isConfirmed;
    }
    return window.confirm(`${title}\n\n${text}`);
}

document.getElementById('btn-refresh-stats')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.classList.add('is-refreshing');
    try {
        if (!await loadStats()) throw new Error('Could not refresh statistics.');
        const status = document.querySelector('.stats-live-indicator');
        if (status) status.innerHTML = '<span></span>Updated just now';
        showToast('Statistics refreshed.', '#10b981');
    } finally {
        button.disabled = false;
        button.classList.remove('is-refreshing');
    }
});

// Preview eligible partials before cleaning them.
const btnCleanupTemps = document.getElementById('btn-cleanup-temps');
if (btnCleanupTemps) {
    btnCleanupTemps.addEventListener('click', async () => {
        const count = document.getElementById('cleanup-preview-count')?.textContent || 'temporary files';
        const size = document.getElementById('cleanup-preview-size')?.textContent || 'unknown size';
        if (!await confirmHistoryAction('Clean temporary files?', `Remove ${count} (${size}) of incomplete download fragments? Downloaded media files are not included.`, 'Clean files')) return;
        try {
            btnCleanupTemps.disabled = true;
            btnCleanupTemps.innerHTML = '<i data-lucide="loader-circle" class="spinner"></i><span>Cleaning…</span>';
            if (window.lucide) lucide.createIcons();

            const response = await axios.post(`${API_URL}/cleanup-temps`);
            if (response?.data?.status !== 'cleaned') throw new Error(response?.data?.message || 'Cleanup did not complete');
            showToast(`Removed ${response.data.count || 0} files · Freed ${formatStatsBytes(response.data.bytes_freed)}`, '#10b981');
        } catch (e) {
            showToast(e?.response?.data?.detail || e.message || 'Failed to clean temporary files', '#ef4444');
        } finally {
            btnCleanupTemps.innerHTML = '<i data-lucide="sparkles"></i><span>Clean temporary files</span>';
            if (window.lucide) lucide.createIcons();
            await loadCleanupPreview();
        }
    });
}

document.getElementById('btn-export-history')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    try {
        button.disabled = true;
        const latestDownloads = await axios.get(`${API_URL}/downloads`, { timeout: 10000 });
        if (!Array.isArray(latestDownloads.data)) throw new Error('Could not load the latest download history.');
        processDownloadsState(latestDownloads.data);
        if (!rawDownloadsData.length) {
            showToast('There is no download history to export.', '#f59e0b');
            return;
        }

        const columns = [
            ['File name', 'filename'], ['Status', 'status'], ['URL', 'url'],
            ['Downloaded bytes', 'downloaded'], ['Total bytes', 'total_size'],
            ['Created at', 'created_at'], ['Error', 'error_message']
        ];
        const escapeCsv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const csv = [columns.map(([label]) => escapeCsv(label)).join(','), ...rawDownloadsData.map(download =>
            columns.map(([, key]) => {
                const value = key === 'created_at' && download[key]
                    ? new Date(Number(download[key])).toISOString()
                    : download[key];
                return escapeCsv(value);
            }).join(',')
        )].join('\r\n');
        const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `ledo-download-history-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        showToast(`Exported ${rawDownloadsData.length} history records.`, '#10b981');
    } catch (error) {
        showToast(error?.message || 'Could not export download history.', '#ef4444');
    } finally {
        button.disabled = false;
    }
});

async function clearHistoryRecords({ completedOnly }) {
    const endpoint = completedOnly ? '/clear-completed' : '/clear-history';
    const title = completedOnly ? 'Clear completed history?' : 'Clear all download history?';
    const description = completedOnly
        ? 'Completed download records will be removed from the app. Downloaded files stay on your device.'
        : 'All download records will be removed from the app. Downloaded files stay on your device.';
    if (!await confirmHistoryAction(title, description, 'Clear history')) return;
    try {
        const response = completedOnly
            ? await axios.post(`${API_URL}${endpoint}`)
            : await axios.delete(`${API_URL}${endpoint}`);
        const count = Number(response?.data?.count) || 0;
        showToast(`Removed ${count} ${count === 1 ? 'record' : 'records'}. Your media files are untouched.`, '#10b981');
        await refreshDownloads();
        await loadStats();
    } catch (error) {
        showToast(error?.response?.data?.detail || error.message || 'Could not clear download history.', '#ef4444');
    }
}

document.getElementById('btn-clear-history')?.addEventListener('click', () => clearHistoryRecords({ completedOnly: false }));
document.getElementById('btn-clear-completed-history')?.addEventListener('click', () => clearHistoryRecords({ completedOnly: true }));

// Titlebar Window Controls
document.getElementById('btn-minimize')?.addEventListener('click', () => {
    window.electronAPI.windowControl('minimize');
});
document.getElementById('btn-maximize')?.addEventListener('click', () => {
    window.electronAPI.windowControl('maximize');
});
document.getElementById('btn-close')?.addEventListener('click', () => {
    window.electronAPI.windowControl('close');
});

const navigationSidebar = document.querySelector('.sidebar');
const navigationSidebarToggle = document.getElementById('btn-toggle-nav-sidebar');
function setNavigationSidebarCollapsed(collapsed, persist = false) {
    if (!navigationSidebar) return;
    navigationSidebar.classList.toggle('is-collapsed', collapsed);
    if (navigationSidebarToggle) {
        const label = collapsed ? 'Expand navigation' : 'Collapse navigation';
        if (navigationSidebarToggle._tippy) navigationSidebarToggle._tippy.setContent(label);
        else navigationSidebarToggle.title = label;
        navigationSidebarToggle.setAttribute('aria-label', label);
        navigationSidebarToggle.setAttribute('aria-expanded', String(!collapsed));
        navigationSidebarToggle.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M9 4v16${collapsed ? '' : 'M15 9l-3 3 3 3'}${collapsed ? 'M12 9l3 3-3 3' : ''}"></path></svg>`;
    }
    if (persist) localStorage.setItem('ledo_nav_collapsed', String(collapsed));
}

setNavigationSidebarCollapsed(localStorage.getItem('ledo_nav_collapsed') === 'true');
navigationSidebarToggle?.addEventListener('click', () => {
    setNavigationSidebarCollapsed(!navigationSidebar?.classList.contains('is-collapsed'), true);
});

// Navigation logic (Sidebar)
const isDownloadRunning = download => ['downloading', 'starting', 'resolving', 'preparing', 'processing'].includes(download?.status);
function suspendDownloadsUiIfIdle() {
    if (rawDownloadsData.some(isDownloadRunning)) return;
    const list = document.getElementById('downloads-list');
    if (!list) return;
    list.replaceChildren();
    list.dataset.suspendedForTools = 'true';
}

let mediaToolsLoadPromise = null;
function enterMediaTools() {
    const host = document.getElementById('view-tools');
    if (!host) return;
    if (window.LedoMediaTools) {
        window.LedoMediaTools.mount(host);
        return;
    }
    host.innerHTML = '<div class="media-lazy-state" dir="rtl"><span class="media-lazy-spinner"></span><span>جارٍ تجهيز الأدوات…</span></div>';
    if (!mediaToolsLoadPromise) {
        mediaToolsLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'media-tools.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('تعذّر تحميل قسم الأدوات.'));
            document.body.appendChild(script);
        }).catch(error => {
            mediaToolsLoadPromise = null;
            host.innerHTML = `<div class="media-lazy-error" dir="rtl">${error.message} <button type="button" onclick="window.dispatchEvent(new Event('ledo-open-tools'))">إعادة المحاولة</button></div>`;
        });
    }
    mediaToolsLoadPromise.then(() => {
        if (document.getElementById('view-tools')?.classList.contains('active')) window.LedoMediaTools?.mount(host);
    });
}
window.addEventListener('ledo-open-tools', enterMediaTools);

document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        e.currentTarget.classList.add('active');

        const id = e.currentTarget.id || '';
        const text = e.currentTarget.innerText || '';
        const isSettings = id === 'nav-settings' || text.includes('Settings');
        const isStats = id === 'nav-stats' || text.includes('Statistics');
        const isMedia = id === 'nav-tools' || text.includes('الأدوات') || text.includes('Media Tools');
        const isLibraryHub = id === 'nav-library-hub';
        if (!isMedia) window.LedoMediaTools?.leave();
        const views = [
            document.getElementById('view-downloads'), 
            document.getElementById('view-settings'), 
            document.getElementById('view-stats'),
            document.getElementById('view-tools'),
            document.getElementById('view-library-hub')
        ];
        views.forEach(v => { if (v) v.classList.remove('active'); });

        let targetView = null;
        if (isSettings) {
            targetView = document.getElementById('view-settings');
        } else if (isStats) {
            targetView = document.getElementById('view-stats');
            loadStats();
        } else if (isMedia) {
            targetView = document.getElementById('view-tools');
        } else if (isLibraryHub) {
            targetView = document.getElementById('view-library-hub');
        } else {
            targetView = document.getElementById('view-downloads');
        }

        if (targetView) {
            targetView.classList.add('active');
            if (window.gsap && !appSettings.powerSaver) {
                gsap.fromTo(targetView, { opacity: 0, y: 10, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "power2.out" });
            }
            if (window.lucide) {
                lucide.createIcons({ root: targetView });
            }
        }
        if (isMedia) {
            suspendDownloadsUiIfIdle();
            enterMediaTools();
        } else if (isLibraryHub) {
            window.LedoLibraryHub?.mount(targetView, rawDownloadsData);
        } else if (id === 'nav-downloads') {
            if (rawDownloadsData.length) processDownloadsState(rawDownloadsData);
            refreshDownloads();
        }
    });
});

// "See all" history button in right sidebar
const btnSeeAllHistory = document.getElementById('btn-see-all-history');
if (btnSeeAllHistory) {
    btnSeeAllHistory.addEventListener('click', (e) => {
        e.preventDefault();
        const navDownloads = document.getElementById('nav-downloads');
        if (navDownloads) navDownloads.click();
        const filterCompleted = document.querySelector('.filter-btn[data-filter="completed"]') || document.querySelector('.filter-btn[data-filter="all"]');
        if (filterCompleted) filterCompleted.click();
    });
}

// ============================================
// RIGHT SIDEBAR TOGGLE
// ============================================
const sidebarToggleBtn = document.getElementById('btn-toggle-sidebar');
const rightSidebar = document.getElementById('right-sidebar');

if (sidebarToggleBtn && rightSidebar) {
    // Restore saved state
    // On desktop-sized windows, keep the existing overview panel in use by default.
    // Preserve the user's collapsed choice on narrower windows where space is limited.
    const sidebarHidden = localStorage.getItem('ledo_sidebar_collapsed') === 'true' && window.innerWidth < 1440;
    if (!sidebarHidden) localStorage.setItem('ledo_sidebar_collapsed', 'false');
    if (sidebarHidden) {
        rightSidebar.classList.add('collapsed');
        sidebarToggleBtn.classList.add('sidebar-closed');
        sidebarToggleBtn.classList.remove('sidebar-open');
    } else {
        sidebarToggleBtn.classList.add('sidebar-open');
    }

    sidebarToggleBtn.addEventListener('click', () => {
        const isCollapsed = rightSidebar.classList.toggle('collapsed');
        if (isCollapsed) {
            sidebarToggleBtn.classList.remove('sidebar-open');
            sidebarToggleBtn.classList.add('sidebar-closed');
        } else {
            sidebarToggleBtn.classList.remove('sidebar-closed');
            sidebarToggleBtn.classList.add('sidebar-open');
        }
        localStorage.setItem('ledo_sidebar_collapsed', isCollapsed);
    });
}

// ============================================
// NEW FEATURES: SYSTEM STATS & POWER SAVING
// ============================================
let sysNetChartInstance = null;
const netHistory = Array(20).fill(0);

function initSysNetChart() {
    const ctx = document.getElementById('sys-net-chart');
    if (!ctx) return;
    sysNetChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: Array(20).fill(''),
            datasets: [{
                data: netHistory,
                borderColor: '#8b5cf6',
                backgroundColor: 'rgba(139, 92, 246, 0.1)',
                fill: true,
                tension: 0.4,
                borderWidth: 2,
                pointRadius: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
                x: { display: false },
                y: { display: false, min: 0 }
            },
            animation: false
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initSysNetChart();
});

// Smart Power Saver via Window Focus & state sync
if (window.electronAPI && window.electronAPI.onWindowFocusChange) {
    window.electronAPI.onWindowFocusChange((isFocused) => {
        if (isFocused) {
            refreshDownloads();
        }
        // Only apply smart power saver if manual mode is OFF
        if (!appSettings.powerSaver) {
            if (!isFocused) {
                document.body.classList.add('power-saving');
            } else {
                document.body.classList.remove('power-saving');
            }
        }
    });
}

// Theme buttons in footer
const btnLight = document.getElementById('btn-theme-light');
const btnCyberpunk = document.getElementById('btn-theme-cyberpunk');
btnLight?.addEventListener('click', () => setAppTheme('light'));
btnCyberpunk?.addEventListener('click', () => setAppTheme('cyberpunk'));


// Drag and Drop Logic
let dragCounter = 0;
document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (document.getElementById('view-tools')?.classList.contains('active') && e.dataTransfer?.types?.includes('Files')) return;
    dragCounter++;
    const overlay = document.getElementById('drag-drop-overlay');
    if (overlay) overlay.style.display = 'flex';
});
document.addEventListener('dragover', (e) => {
    e.preventDefault();
});
document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (document.getElementById('view-tools')?.classList.contains('active') && e.dataTransfer?.types?.includes('Files')) return;
    dragCounter--;
    if (dragCounter === 0) {
        const overlay = document.getElementById('drag-drop-overlay');
        if (overlay) overlay.style.display = 'none';
    }
});
document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (document.getElementById('view-tools')?.classList.contains('active') && e.dataTransfer?.types?.includes('Files')) return;
    dragCounter = 0;
    const overlay = document.getElementById('drag-drop-overlay');
    if (overlay) overlay.style.display = 'none';
    let url = '';
    const textData = e.dataTransfer.getData('text/plain');
    const urlData = e.dataTransfer.getData('text/uri-list');
    if (urlData) {
        url = urlData.split('\n')[0].trim();
    } else if (textData && /^https?:\/\//i.test(textData)) {
        url = textData.trim();
    }
    if (url && window.electronAPI && window.electronAPI.showQuickAdd) {
        window.electronAPI.showQuickAdd({ url });
    }
});

// Clear Completed Logic
document.getElementById('btn-clear-completed')?.addEventListener('click', () => {
    if (confirm('هل تريد حذف جميع التحميلات المكتملة من القائمة؟')) {
        axios.post(API_URL + '/clear-completed')
            .then(() => refreshDownloads())
            .catch(e => console.error(e));
    }
});
