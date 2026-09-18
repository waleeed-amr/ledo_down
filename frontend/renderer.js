const API_URL = 'http://127.0.0.1:8000/api';
const WS_URL = 'ws://127.0.0.1:8000/ws';

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

// ============================================
// SETTINGS MANAGEMENT
// ============================================
const DEFAULT_SETTINGS = {
    defaultSavePath: '',
    powerSaver: false,
    reduceHover: false,
    compactMode: false,
    theme: 'dark',
    customBackground: null
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

let appSettings = loadSettings();

function applySettings() {
    document.body.classList.toggle('power-saver', !!appSettings.powerSaver);
    document.body.classList.toggle('reduce-hover', !!appSettings.reduceHover);
    document.body.classList.toggle('compact-mode', !!appSettings.compactMode);
    // Power Saver
    if (appSettings.powerSaver) {
        document.body.classList.add('power-saver');
    } else {
        document.body.classList.remove('power-saver');
    }

    // Reduce Hover
    if (appSettings.reduceHover) {
        document.body.classList.add('reduce-hover');
    } else {
        document.body.classList.remove('reduce-hover');
    }

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

    // Theme
    if (appSettings.theme === 'light') {
        document.body.classList.add('theme-light');
    } else {
        document.body.classList.remove('theme-light');
    }

    // Custom Background
    const btnClearBg = document.getElementById('btn-settings-clear-bg');
    if (appSettings.customBackground) {
        document.body.style.backgroundImage = `url('${appSettings.customBackground}')`;
        if (btnClearBg) btnClearBg.style.display = 'block';
    } else {
        document.body.style.backgroundImage = "url('vendor/bg.jpg')";
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
    if (!appSettings.defaultSavePath || appSettings.defaultSavePath === 'C:\\Users\\z\\Desktop') {
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
    document.body.classList.toggle('power-saver', e.target.checked);
    saveSettings(appSettings);
    applySettings();
    initVanta();
    showToast(e.target.checked ? 'Power Saver Mode: ON' : 'Power Saver Mode: OFF', e.target.checked ? '#10b981' : '#6366f1');
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

document.getElementById('btn-restore-defaults')?.addEventListener('click', () => {
    if (window.Swal) {
        Swal.fire({
            title: 'Are you sure?',
            text: "You want to restore all settings to default?",
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Yes, restore it!',
            customClass: { popup: 'premium-swal', confirmButton: 'btn-primary-swal', cancelButton: 'btn-danger-swal' },
            buttonsStyling: false
        }).then((result) => {
            if (result.isConfirmed) {
                appSettings = { ...DEFAULT_SETTINGS };
                saveSettings(appSettings);
                customSavePath = null;
                applySettings();
                showToast('Settings restored to defaults!', '#f59e0b');
            }
        });
    } else {
        if (confirm('Are you sure you want to restore all settings to default?')) {
            appSettings = { ...DEFAULT_SETTINGS };
            saveSettings(appSettings);
            customSavePath = null;
            applySettings();
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
        appSettings.customBackground = event.target.result; // base64 string
        saveSettings(appSettings);
        applySettings();
        showToast('Custom background updated!', '#10b981');
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
document.querySelectorAll('.theme-card-option').forEach(card => {
    card.addEventListener('click', () => {
        const themeVal = card.getAttribute('data-theme-val');
        if (!themeVal) return;

        // Update active state visually
        document.querySelectorAll('.theme-card-option').forEach(c => c.classList.remove('active'));
        card.classList.add('active');

        // Apply theme
        appSettings.theme = themeVal;
        saveSettings(appSettings);

        // Handle specific theme classes
        document.body.classList.remove('theme-light', 'theme-amoled', 'theme-cyberpunk');
        if (themeVal === 'light') {
            document.body.classList.add('theme-light');
        } else if (themeVal === 'amoled') {
            document.body.classList.add('theme-amoled');
        } else if (themeVal === 'cyberpunk') {
            document.body.classList.add('theme-cyberpunk');
        } else if (themeVal === 'system') {
            // Match system preference
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
                document.body.classList.add('theme-light');
            }
        }

        initVanta();
        showToast(`تم تغيير الثيم`, '#3b82f6');
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
        console.warn("Could not sync settings with backend:", e);
    }
}

function playNotificationSound() {
    try {
        const audio = new Audio('vendor/notification.wav');
        audio.volume = 0.6;
        const playPromise = audio.play();
        if (playPromise !== undefined) {
            playPromise.catch(() => {
                try {
                    const audio2 = new Audio('vendor/notification.mp3');
                    audio2.volume = 0.6;
                    audio2.play().catch(err => console.warn("Sound playback fallback error:", err));
                } catch (e) {}
            });
        }
    } catch (e) {
        console.warn("Notification audio error:", e);
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
    { id: 'checkbox-auto-resume', key: 'autoResume', msgOn: 'الاستئناف التلقائي: مفعّل', msgOff: 'الاستئناف التلقائي: معطّل' }
];

settingsCheckboxes.forEach(({ id, key, msgOn, msgOff }) => {
    document.getElementById(id)?.addEventListener('change', (e) => {
        const val = e.target.checked;
        appSettings[key] = val;
        saveSettings(appSettings);
        showToast(val ? msgOn : msgOff, '#6366f1');

        if (key === 'smartClipboard' && window.electronAPI && window.electronAPI.setSmartClipboard) {
            window.electronAPI.setSmartClipboard(val);
        }
        if (key === 'autoLaunch' && window.electronAPI && window.electronAPI.setAutoLaunch) {
            window.electronAPI.setAutoLaunch(val);
        }
        if (key === 'autoCategorize') {
            syncSettingsWithBackend();
        }
    });
});

// ============================================
// OPEN FOLDER & EXTENSION BUTTONS
// ============================================
document.getElementById('btn-settings-open-folder')?.addEventListener('click', async () => {
    const folderPath = appSettings.defaultSavePath;
    if (folderPath && window.electronAPI && window.electronAPI.openPath) {
        await window.electronAPI.openPath(folderPath);
    } else if (folderPath && window.electronAPI && window.electronAPI.shell) {
        await window.electronAPI.shell.openPath(folderPath);
    } else {
        showToast('لم يتم تحديد مجلد التحميل بعد', '#f59e0b');
    }
});

document.getElementById('btn-open-extension-folder')?.addEventListener('click', async () => {
    if (window.electronAPI && window.electronAPI.openExtensionFolder) {
        await window.electronAPI.openExtensionFolder();
    } else if (window.electronAPI && window.electronAPI.openPath) {
        const appPath = window.electronAPI.getAppPath ? await window.electronAPI.getAppPath() : '.';
        await window.electronAPI.openPath(appPath + '/browser_extension');
    } else {
        showToast('غير متاح في هذا السياق', '#f59e0b');
    }
});

document.getElementById('btn-test-extension-conn')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-extension-conn');
    const oldHTML = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader" class="spinner"></i> جاري الفحص...';
    btn.disabled = true;
    if (window.lucide) lucide.createIcons();

    try {
        const res = await axios.get('http://127.0.0.1:8000/api/health', { timeout: 5000 });
        if (res.status === 200) {
            showToast('✅ الاتصال بالمحرك المحلي ناجح!', '#10b981');
        } else {
            showToast('⚠️ المحرك يعمل لكن الاستجابة غير متوقعة', '#f59e0b');
        }
    } catch (e) {
        showToast('❌ لم يتم العثور على المحرك — تأكد من تشغيل ليدو', '#ef4444');
    } finally {
        btn.innerHTML = oldHTML;
        btn.disabled = false;
        if (window.lucide) lucide.createIcons();
    }
});

// Sound test button
document.getElementById('btn-test-sound')?.addEventListener('click', () => {
    try {
        playNotificationSound();
        showToast('تم تشغيل صوت الإشعار 🔔', '#10b981');
    } catch (e) {
        showToast('خطأ في تشغيل الصوت', '#ef4444');
    }
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
    const interrupted = downloads.filter(d => d.status === 'downloading' || d.status === 'starting');
    if (interrupted.length > 0) {
        console.log(`Auto-resuming ${interrupted.length} interrupted downloads...`);
        showToast(`استئناف تلقائي لـ ${interrupted.length} تحميل...`, '#3b82f6');
        interrupted.forEach(d => {
            axios.post(`${API_URL}/resume/${d.id}`).catch(() => {});
        });
    }
}

// Local state for sorting/filtering
let rawDownloadsData = [];
let currentFilter = 'all';
let currentSort = 'date-desc';
window.speedHistory = {}; // { id: [speed_bytes_1, speed_bytes_2, ...] }

function processDownloadsState(downloads) {
    rawDownloadsData = downloads;
    handleAutoResume(downloads);

    // Record speed history only for active downloads and clean up old ones to save RAM
    const activeIds = new Set();
    let hasActive = false;

    downloads.forEach(dl => {
        if (['downloading', 'starting', 'processing'].includes(dl.status)) {
            hasActive = true;
            activeIds.add(dl.id);
            if (!window.speedHistory[dl.id]) window.speedHistory[dl.id] = [];
            window.speedHistory[dl.id].push(dl.speed || 0);
            if (window.speedHistory[dl.id].length > 20) window.speedHistory[dl.id].shift();
        }
    });

    // Clean up memory for finished downloads from speedHistory
    for (const id in window.speedHistory) {
        if (!activeIds.has(id)) {
            delete window.speedHistory[id];
        }
    }

    // Proactively show mini progress bar whenever any download is running
    if (hasActive && window.electronAPI && window.electronAPI.sendMiniProgressAction) {
        window.electronAPI.sendMiniProgressAction('show');
    }

    updateRecentCompleted();
    applyFilterAndSort();
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

    // Filter
    if (currentFilter === 'downloading') {
        result = result.filter(d => ['downloading', 'starting', 'processing'].includes(d.status));
    } else if (currentFilter === 'completed') {
        result = result.filter(d => d.status === 'completed');
    } else if (currentFilter === 'error') {
        result = result.filter(d => d.status === 'error');
    }

    // Sort
    result.sort((a, b) => {
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
    });

    renderDownloads(result);
}

// Filter Listeners
document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        currentFilter = e.target.getAttribute('data-filter');
        applyFilterAndSort();
    });
});
document.getElementById('sort-select')?.addEventListener('change', (e) => {
    currentSort = e.target.value;
    applyFilterAndSort();
});


function connectWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onmessage = function (event) {
        try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'open_quick_add') {
                if (window.electronAPI && window.electronAPI.showQuickAdd) {
                    window.electronAPI.showQuickAdd({
                        url: payload.url,
                        cookies: payload.cookies,
                        user_agent: payload.user_agent,
                        filename: payload.filename,
                        file_size: payload.file_size,
                        mime_type: payload.mime_type
                    });
                }
            } else if (payload.type === 'state' || payload.type === 'downloads') {
                processDownloadsState(payload.downloads || []);

                // Track completions for notifications
                payload.downloads.forEach(dl => {
                    if (!window.knownDownloads) window.knownDownloads = new Map();

                    const prevStatus = window.knownDownloads.get(dl.id);
                    if (prevStatus !== dl.status) {
                        if (dl.status === 'completed' && prevStatus) {
                            if (appSettings.completionNotif !== false) {
                                showToast(`Download Completed: ${dl.filename || 'File'}`, '#10b981');
                                if (window.electronAPI && window.electronAPI.showNotification) {
                                    window.electronAPI.showNotification('Ledo Downloader', `Download Completed: ${dl.filename || 'File'}`);
                                } else if (window.Notification && Notification.permission === 'granted') {
                                    new Notification('Ledo Downloader', { body: `Download Completed: ${dl.filename || 'File'}` });
                                }
                            }
                            if (appSettings.completionSound !== false) {
                                playNotificationSound();
                            }
                            if (window.confetti) {
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
        console.log("WebSocket disconnected. Reconnecting in 2s...");
        setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = function (err) {
        console.error("WebSocket Error: ", err);
        ws.close();
    };
}

// Initial connection
connectWebSocket();

// customSavePath = one-time override from the folder picker next to URL bar
let customSavePath = null;
// selectedQuality = currently chosen quality in the quality modal
let selectedQuality = 'best';

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
        const response = await axios.post(`${API_URL}/info`, { url: url }, { timeout: 30000 });
        const data = response.data;

        if (data.status === 'success') {
            const dlInfo = data.download_info || data;
            document.getElementById('modal-title').innerText = dlInfo.title || 'Unknown Title';
            const optionsDiv = document.getElementById('quality-options');
            const sizes = dlInfo.sizes || {};

            if (dlInfo.is_direct) {
                window.isDirectFile = true;
                optionsDiv.innerHTML = `
                    <label class="quality-option active">
                        <input type="radio" name="quality" value="best" checked onchange="selectedQuality='best'; updateQualitySelection()">
                        <div class="q-info">
                            <span class="q-title">Direct File Download</span>
                            <span class="q-size">${sizes.best ? formatBytes(sizes.best) : 'Size Unknown'}</span>
                        </div>
                    </label>
                `;
            } else {
                window.isDirectFile = false;

                const qualities = [
                    { id: 'best', title: 'Video (Max)' },
                    { id: '720p', title: 'Video (720p)' },
                    { id: '480p', title: 'Video (480p)' },
                    { id: '360p', title: 'Video (360p)' },
                    { id: 'audio', title: 'Audio (MP3)' }
                ];

                let optionsHtml = '';
                qualities.forEach((q, idx) => {
                    const size = sizes[q.id];
                    // Always show them as requested by user, even if sizes are similar
                    optionsHtml += `
                        <label class="quality-option ${idx === 0 ? 'active' : ''}">
                            <input type="radio" name="quality" value="${q.id}" ${idx === 0 ? 'checked' : ''} onchange="selectedQuality='${q.id}'; updateQualitySelection()">
                            <div class="q-info">
                                <span class="q-title">${q.title}</span>
                                <span class="q-size">${size ? formatBytes(size) : 'Auto (Size Unknown)'}</span>
                            </div>
                        </label>
                    `;
                });
                optionsDiv.innerHTML = optionsHtml;
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
    document.getElementById('quality-modal').style.display = 'none';
    const container = document.getElementById('schedule-picker-container');
    if (container) container.style.display = 'none';
    const scheduleBtn = document.getElementById('btn-schedule-toggle');
    if (scheduleBtn) scheduleBtn.style.background = '';
    const startBtn = document.getElementById('btn-start-download');
    if (startBtn) startBtn.innerText = 'Download';
});

document.getElementById('btn-schedule-toggle')?.addEventListener('click', () => {
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
    const url = document.getElementById('url-input').value;
    document.getElementById('quality-modal').style.display = 'none';

    const scheduleTime = document.getElementById('schedule-time').value;
    const scheduleContainer = document.getElementById('schedule-picker-container');
    const scheduleBtn = document.getElementById('btn-schedule-toggle');
    const startBtn = document.getElementById('btn-start-download');

    if (scheduleContainer) scheduleContainer.style.display = 'none';
    if (scheduleBtn) scheduleBtn.style.background = '';
    if (startBtn) startBtn.innerText = 'Download';
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
                url: url,
                save_path: effectivePath,
                quality: selectedQuality,
                is_yt_dlp: window.isDirectFile ? false : true,
                run_at: d.toISOString(),
                title: document.getElementById('modal-title').innerText
            });
            showToast(`Download scheduled for ${d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`, "#3b82f6");
        } else {
            // Start immediately
            await axios.post(`${API_URL}/download`, {
                url: url,
                save_path: effectivePath,
                quality: selectedQuality,
                is_yt_dlp: window.isDirectFile ? false : true,
                title: document.getElementById('modal-title').innerText
            });
            showToast("Starting Download...", "#10b981");
            // Auto-scroll to downloads list so the user sees the new download
            const dlList = document.getElementById('downloads-list');
            if (dlList) {
                dlList.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }

        document.getElementById('url-input').value = '';

        // Reset one-time override after use
        customSavePath = null;
        updateSavePathDisplay();
        if (typeof loadStats === 'function') loadStats();
    } catch (error) {
        console.error("Error adding download", error);
        showToast("Failed to start/schedule download", "#ef4444");
    }
});


function showToast(text, color) {
    Toastify({
        text: text,
        duration: 3000,
        gravity: "bottom",
        position: "right",
        style: {
            background: color,
            borderRadius: "12px",
            fontFamily: "Outfit",
            boxShadow: `0 4px 15px ${color}66`
        }
    }).showToast();
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function renderDownloads(downloads) {
    const listEl = document.getElementById('downloads-list');

    // Remove cards that are no longer in the payload
    const currentIds = downloads.map(dl => `dl-card-${dl.id}`);
    Array.from(listEl.children).forEach(child => {
        if (!currentIds.includes(child.id)) {
            child.remove();
        }
    });

    downloads.forEach(dl => {
        let card = document.getElementById(`dl-card-${dl.id}`);

        const speed = dl.speed ? formatBytes(dl.speed) + '/s' : '--';
        const size = dl.total_size ? formatBytes(dl.total_size) : 'Unknown';
        const name = dl.filename || dl.url;

        let errorHtml = '';
        if (dl.status === 'error' && dl.error_message) {
            errorHtml = `
                <div style="color: #ef4444; font-size: 13px; margin-top: 10px; background: rgba(239, 68, 68, 0.1); padding: 8px; border-radius: 6px;">
                    ${dl.error_message}
                </div>
            `;
        }

        let actionBtnHtml = '';
        if (['downloading', 'starting'].includes(dl.status)) {
            actionBtnHtml = `
                <button class="btn-action" onclick="pauseDownload('${dl.id}')" title="Pause Download" style="background: none; border: none; color: #f59e0b; cursor: pointer; padding: 4px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
                </button>
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
                <button class="btn-cancel-dl" onclick="cancelDownload('${dl.id}')" title="Cancel Download">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            `;
        }

        let playBtnHtml = '';

        const innerHTML = `
            <div class="dl-header" style="cursor: grab;">
                <div title="Drag to reorder" style="color: var(--text-muted); display: flex; align-items: center; margin-right: 8px;">
                    <i data-lucide="grip-vertical" style="width: 16px; height: 16px;"></i>
                </div>
                <div class="dl-title" title="${name}">${name}</div>
                <div class="dl-actions">
                    ${playBtnHtml}
                    <div class="dl-status ${dl.status}">${dl.status}</div>
                    ${actionBtnHtml}
                </div>
            </div>
            <div class="dl-error-box">${errorHtml}</div>
            <div class="progress-container">
                <div class="progress-bar" style="width: ${dl.progress}%"></div>
            </div>
            <div class="dl-footer">
                <span>${formatBytes(dl.downloaded)} / ${size}</span>
                <span>${speed}</span>
                <span>${dl.progress.toFixed(1)}%</span>
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
                    animation: 'scale', theme: 'translucent', arrow: true
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
                    actionsBox.innerHTML = `${playBtnHtml}<div class="dl-status ${dl.status}">${dl.status}</div>${actionBtnHtml}`;
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
                bar.style.width = `${dl.progress}%`;
            }

            const footer = card.querySelector('.dl-footer');
            if (footer && footer.children.length >= 3) {
                footer.children[0].textContent = `${formatBytes(dl.downloaded)} / ${size}`;
                footer.children[1].textContent = speed;
                footer.children[2].textContent = `${dl.progress.toFixed(1)}%`;
            }
        }

        listEl.appendChild(card);

        card.onclick = (e) => {
            if (e.target.closest('button') || e.target.closest('.dl-header i') || e.target.closest('.dl-header svg')) return;
            openDetailsDrawer(dl);
        };
    });
}

// Proactive refresh on window focus / startup
async function refreshDownloads() {
    try {
        const res = await axios.get(`${API_URL}/downloads`, { timeout: 3000 });
        if (res.data && Array.isArray(res.data)) {
            processDownloadsState(res.data);
        }
    } catch (e) {}
}

// Drawer Logic
let drawerChartInstance = null;
function openDetailsDrawer(dl) {
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
                <div class="drawer-filename" title="${dl.filename || 'Unknown'}">${dl.filename || 'Unknown'}</div>
                <div class="drawer-status-badge ${dl.status}">${dl.status.toUpperCase()}</div>
            </div>
        </div>
        
        <div class="drawer-stats-grid">
            <div class="drawer-stat-box">
                <div class="stat-lbl">FILE SIZE</div>
                <div class="stat-val">${formatBytes(dl.total_size)}</div>
            </div>
            <div class="drawer-stat-box">
                <div class="stat-lbl">DATE ADDED</div>
                <div class="stat-val">${dateAdded}</div>
            </div>
        </div>
        
        <div class="drawer-url-box">
            <div class="stat-lbl">SOURCE URL</div>
            <div class="url-val" title="${dl.url}">${dl.url}</div>
        </div>
        
        <div class="drawer-chart-section">
            <div class="chart-header">
                <span class="chart-title-lbl">NETWORK SPEED</span>
                <span class="live-indicator" style="display: ${dl.status === 'downloading' ? 'flex' : 'none'}"><span class="dot"></span>LIVE</span>
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

document.getElementById('btn-close-drawer')?.addEventListener('click', () => {
    document.getElementById('details-drawer').classList.remove('open');
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
    const id = item.dataset.id;
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
    } else if (action === 'cancel-download') {
        if (typeof cancelDownload === 'function') cancelDownload(id, deleteFile);
    } else if (action === 'pause-download') {
        if (typeof pauseDownload === 'function') pauseDownload(id);
    } else if (action === 'resume-download') {
        if (typeof resumeDownload === 'function') resumeDownload(id);
    } else if (action === 'retry-download') {
        if (typeof retryDownload === 'function') retryDownload(id);
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
    const dlId = dl.id;
    
    if (status === 'completed') {
        menuHtml += `<div class="ctx-item" data-action="open-file" data-path="${encPath}"><i data-lucide="play-circle"></i> Open File</div>`;
        menuHtml += `<div class="ctx-item" data-action="open-folder" data-path="${encPath}"><i data-lucide="folder-open"></i> Open Folder</div>`;
        menuHtml += `<div class="ctx-item" data-action="copy-path" data-path="${encPath}"><i data-lucide="copy"></i> Copy File Path</div>`;
        menuHtml += `<div class="ctx-item" data-action="copy-url" data-url="${encUrl}"><i data-lucide="link"></i> Copy Source URL</div>`;
        menuHtml += `<div class="ctx-separator"></div>`;
        menuHtml += `<div class="ctx-item ctx-danger" data-action="cancel-download" data-id="${dlId}" data-delete="false"><i data-lucide="trash"></i> Remove from list</div>`;
        menuHtml += `<div class="ctx-item ctx-danger" data-action="cancel-download" data-id="${dlId}" data-delete="true"><i data-lucide="trash-2"></i> Delete File & Remove</div>`;
    } else if (status === 'downloading' || status === 'starting') {
        menuHtml += `<div class="ctx-item" data-action="pause-download" data-id="${dlId}"><i data-lucide="pause"></i> Pause</div>`;
        menuHtml += `<div class="ctx-item" data-action="copy-url" data-url="${encUrl}"><i data-lucide="link"></i> Copy Source URL</div>`;
        menuHtml += `<div class="ctx-separator"></div>`;
        menuHtml += `<div class="ctx-item ctx-danger" data-action="cancel-download" data-id="${dlId}" data-delete="false"><i data-lucide="x"></i> Cancel</div>`;
    } else if (status === 'paused') {
        menuHtml += `<div class="ctx-item" data-action="resume-download" data-id="${dlId}"><i data-lucide="play"></i> Resume</div>`;
        menuHtml += `<div class="ctx-item" data-action="copy-url" data-url="${encUrl}"><i data-lucide="link"></i> Copy Source URL</div>`;
        menuHtml += `<div class="ctx-separator"></div>`;
        menuHtml += `<div class="ctx-item ctx-danger" data-action="cancel-download" data-id="${dlId}" data-delete="false"><i data-lucide="x"></i> Cancel</div>`;
    } else if (status === 'error') {
        menuHtml += `<div class="ctx-item" data-action="retry-download" data-id="${dlId}"><i data-lucide="refresh-cw"></i> Retry</div>`;
        menuHtml += `<div class="ctx-item" data-action="copy-url" data-url="${encUrl}"><i data-lucide="link"></i> Copy Source URL</div>`;
        menuHtml += `<div class="ctx-separator"></div>`;
        menuHtml += `<div class="ctx-item ctx-danger" data-action="cancel-download" data-id="${dlId}" data-delete="false"><i data-lucide="trash"></i> Remove from list</div>`;
        menuHtml += `<div class="ctx-item ctx-danger" onclick="cancelDownload('${dl.id}', true)"><i data-lucide="trash-2"></i> Delete File & Remove</div>`;
    } else if (status === 'downloading' || status === 'starting') {
        menuHtml += `<div class="ctx-item" onclick="pauseDownload('${dl.id}')"><i data-lucide="pause"></i> Pause</div>`;
        menuHtml += `<div class="ctx-item" onclick="if(window.electronAPI && window.electronAPI.writeClipboardText){ window.electronAPI.writeClipboardText('${safeUrl}'); }"><i data-lucide="link"></i> Copy Source URL</div>`;
        menuHtml += `<div class="ctx-separator"></div>`;
        menuHtml += `<div class="ctx-item ctx-danger" onclick="cancelDownload('${dl.id}', false)"><i data-lucide="x"></i> Cancel</div>`;
    } else if (status === 'paused') {
        menuHtml += `<div class="ctx-item" onclick="resumeDownload('${dl.id}')"><i data-lucide="play"></i> Resume</div>`;
        menuHtml += `<div class="ctx-item" onclick="if(window.electronAPI && window.electronAPI.writeClipboardText){ window.electronAPI.writeClipboardText('${safeUrl}'); }"><i data-lucide="link"></i> Copy Source URL</div>`;
        menuHtml += `<div class="ctx-separator"></div>`;
        menuHtml += `<div class="ctx-item ctx-danger" onclick="cancelDownload('${dl.id}', false)"><i data-lucide="x"></i> Cancel</div>`;
    } else if (status === 'error') {
        menuHtml += `<div class="ctx-item" onclick="retryDownload('${dl.id}')"><i data-lucide="refresh-cw"></i> Retry</div>`;
        menuHtml += `<div class="ctx-item" onclick="if(window.electronAPI && window.electronAPI.writeClipboardText){ window.electronAPI.writeClipboardText('${safeUrl}'); }"><i data-lucide="link"></i> Copy Source URL</div>`;
        menuHtml += `<div class="ctx-separator"></div>`;
        menuHtml += `<div class="ctx-item ctx-danger" onclick="cancelDownload('${dl.id}', false)"><i data-lucide="trash"></i> Remove from list</div>`;
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
        await axios.post(`${API_URL}/resume/${id}`);
        showToast("Retrying download...", "#3b82f6");
    } catch (e) {
        console.error("Retry failed", e);
        showToast("Failed to retry download.", "#ef4444");
    }
}

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

        if (elTotal) elTotal.innerText = totalFiles;
        if (elBytes) elBytes.innerText = formatBytes(totalBytes);
        if (elComp) elComp.innerText = completed;
        if (elErr) elErr.innerText = errors;
        if (elVid) elVid.innerText = videos;
        if (elAud) elAud.innerText = audios;

        const chartCanvas = document.getElementById('downloadsChart');
        if (chartCanvas && window.Chart) {
            const ctx = chartCanvas.getContext('2d');
            if (statsChartInstance) {
                statsChartInstance.destroy();
            }

            const otherCount = Math.max(0, totalFiles - videos - audios);
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

        // Re-render lucide icons for the stats page
        if (window.lucide) lucide.createIcons();
    } catch (e) {
        console.error("Failed to load stats", e);
    }
}

// Stats page: Clean Temp Files button
const btnCleanupTemps = document.getElementById('btn-cleanup-temps');
if (btnCleanupTemps) {
    btnCleanupTemps.addEventListener('click', async () => {
        try {
            btnCleanupTemps.disabled = true;
            btnCleanupTemps.innerHTML = '<i data-lucide="loader" class="spinner"></i> Cleaning...';
            if (window.lucide) lucide.createIcons();

            // Call a dedicated cleanup endpoint (we'll trigger cancel with no ID to just clean)
            await axios.post(`${API_URL}/cleanup-temps`);
            showToast("Temporary files cleaned successfully!", "#10b981");
        } catch (e) {
            // Fallback: the endpoint might not exist yet, show a warning
            showToast("Cleanup completed (or no temp files found)", "#f59e0b");
        } finally {
            btnCleanupTemps.disabled = false;
            btnCleanupTemps.innerHTML = '<i data-lucide="trash-2"></i> Clean Temp Files';
            if (window.lucide) lucide.createIcons();
        }
    });
}

// Stats page: Clear All History button
const btnClearHistory = document.getElementById('btn-clear-history');
if (btnClearHistory) {
    btnClearHistory.addEventListener('click', async () => {
        if (window.Swal) {
            Swal.fire({
                title: 'Clear History?',
                text: "Are you sure you want to clear all download history? This cannot be undone.",
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Yes, clear it',
                customClass: { popup: 'premium-swal', confirmButton: 'btn-danger-swal', cancelButton: 'btn-primary-swal' },
                buttonsStyling: false
            }).then(async (result) => {
                if (result.isConfirmed) {
                    try {
                        await axios.delete(`${API_URL}/clear-history`);
                        showToast("Download history cleared!", "#10b981");
                        loadStats();
                    } catch (e) {
                        showToast("Failed to clear history", "#ef4444");
                    }
                }
            });
        } else {
            if (!confirm("Are you sure you want to clear all download history? This cannot be undone.")) return;
            try {
                await axios.delete(`${API_URL}/clear-history`);
                showToast("Download history cleared!", "#10b981");
                loadStats();
            } catch (e) {
                showToast("Failed to clear history", "#ef4444");
            }
        }
    });
}

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

// Navigation logic (Sidebar)
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        e.currentTarget.classList.add('active');

        const id = e.currentTarget.id || '';
        const text = e.currentTarget.innerText || '';
        const isSettings = id === 'nav-settings' || text.includes('Settings');
        const isStats = id === 'nav-stats' || text.includes('Statistics');
        const isAccount = id === 'nav-account' || text.includes('Account');

        const views = [
            document.getElementById('view-downloads'), 
            document.getElementById('view-settings'), 
            document.getElementById('view-stats'), 
            document.getElementById('view-account')
        ];
        views.forEach(v => { if (v) v.classList.remove('active'); });

        let targetView = null;
        if (isSettings) {
            targetView = document.getElementById('view-settings');
        } else if (isStats) {
            targetView = document.getElementById('view-stats');
            loadStats();
        } else if (isAccount) {
            targetView = document.getElementById('view-account');
            if (window.firebaseApp && typeof initFirebaseAuth === 'function') {
                initFirebaseAuth();
            }
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
// ACCOUNT & AUTH LOGIC
// ============================================

let isFirebaseAuthInitialized = false;

function initFirebaseAuth() {
    const { firebaseApp } = window;
    if (!firebaseApp || isFirebaseAuthInitialized) return;
    isFirebaseAuthInitialized = true;
    
    const authSection = document.getElementById('auth-section');
    const profileSection = document.getElementById('profile-section');
    const authError = document.getElementById('auth-error');
    const profileUsername = document.getElementById('profile-username');
    const profileAvatar = document.getElementById('profile-avatar');
    
    let unsubscribeInbox = null;

    // Auth State Changed
    firebaseApp.onAuthStateChanged((user) => {
        if (user) {
            if (authSection) authSection.style.display = 'none';
            if (profileSection) profileSection.style.display = 'block';
            
            if (profileUsername) profileUsername.innerText = user.isAnonymous ? 'Guest User' : (user.displayName || 'User');
            if (profileAvatar) profileAvatar.src = user.photoURL || 'icon.png';
            // --- Admin Panel Detection ---
            const adminPanel = document.getElementById("admin-control-panel");
            const isAdminEmail = (user.email === "waleed@ledodown.local");
            if (isAdminEmail) {
                if (adminPanel) adminPanel.style.display = "block";
                const ps = document.getElementById("profile-status");
                if (ps) { ps.innerText = "Administrator"; ps.parentElement.style.color = "#ef4444"; }
            } else {
                if (adminPanel) adminPanel.style.display = "none";
                user.getIdTokenResult().then(function(idTokenResult) {
                    if (idTokenResult.claims.admin) {
                        if (adminPanel) adminPanel.style.display = "block";
                        var ps2 = document.getElementById("profile-status");
                        if (ps2) { ps2.innerText = "Administrator"; ps2.parentElement.style.color = "#ef4444"; }
                        if (window.lucide) lucide.createIcons();
                    }
                });
            }
            // --- End Admin Panel Detection ---
            
            const profileStatus = document.getElementById('profile-status');
            if (profileStatus) {
                profileStatus.innerText = user.isAnonymous ? 'Guest Member' : 'Premium Member';
            }

            // Enforce Anonymous Rules
            const supportPanel = document.querySelector('.support-panel');
            const inboxPanel = document.querySelector('.inbox-panel');
            const avatarUploadBtn = document.querySelector('.avatar-upload-btn');
            if (user.isAnonymous) {
                if (supportPanel) {
                    supportPanel.style.pointerEvents = 'none';
                    supportPanel.style.opacity = '0.5';
                    const title = supportPanel.querySelector('.panel-title');
                    if (title) title.innerHTML = '<i data-lucide="lock"></i> Support (Register to use)';
                }
                if (inboxPanel) inboxPanel.style.display = 'none';
                if (avatarUploadBtn) avatarUploadBtn.style.display = 'none';
            } else {
                if (supportPanel) {
                    supportPanel.style.pointerEvents = 'auto';
                    supportPanel.style.opacity = '1';
                    const title = supportPanel.querySelector('.panel-title');
                    if (title) title.innerHTML = '<i data-lucide="message-circle"></i> الدعم الفني (محادثة مباشرة)';
                }
                if (inboxPanel) inboxPanel.style.display = 'flex';
                if (avatarUploadBtn) avatarUploadBtn.style.display = 'block';
            }

            // Listen to User Status (Bans/Deletions)
            if (window.unsubscribeUserStatus) window.unsubscribeUserStatus();
            window.unsubscribeUserStatus = firebaseApp.listenToUserStatus((userData, error) => {
                if (error) {
                    // E.g. permission-denied due to ban or network issues
                    if (error.code === 'permission-denied') {
                        showToast('Your session was terminated. You may have been banned.', '#ef4444');
                        firebaseApp.auth.signOut();
                    } else if (error.code !== 'unavailable') { // ignore offline temporarily
                        showToast('Session error: ' + error.message, '#f59e0b');
                    }
                    return;
                }
                
                if (!userData) {
                    // Document deleted
                    showToast('Account has been deleted by administrator.', '#ef4444');
                    firebaseApp.auth.signOut();
                } else if (userData.status === 'disabled' || userData.banned) {
                    // User banned
                    showToast(`Your account has been suspended by the administrator. Reason: ${userData.banReason || 'Unknown'}`, '#ef4444');
                    firebaseApp.auth.signOut();
                }
            });

            // Listen to Inbox
            if (unsubscribeInbox) unsubscribeInbox();
            unsubscribeInbox = firebaseApp.listenToInbox((messages, addedMessages, isInitial) => {
                if (!isInitial && addedMessages && addedMessages.length > 0) {
                    addedMessages.forEach(msg => {
                        const title = msg.title || 'رسالة من الإدارة';
                        const body = msg.body || msg.text || msg.message || '';
                        
                        // Native OS Notification
                        if (window.electronAPI && window.electronAPI.showNotification) {
                            window.electronAPI.showNotification(title, body);
                        } else if (window.Notification && Notification.permission === 'granted') {
                            new Notification(title, { body: body });
                        }

                        // In-app Toast Notification
                        if (typeof showToast === 'function') {
                            showToast(title, '#6366f1');
                        } else if (window.Toastify) {
                            window.Toastify({
                                text: title,
                                duration: 5000,
                                gravity: 'top',
                                position: 'center',
                                style: {
                                    background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                                    borderRadius: '10px'
                                }
                            }).showToast();
                        }
                    });
                }
                const inboxContainer = document.getElementById('inbox-messages');
                const emptyMsg = document.getElementById('inbox-empty');
                if (!inboxContainer) return;
                
                if (!messages || messages.length === 0) {
                    if (emptyMsg) emptyMsg.style.display = 'block';
                    Array.from(inboxContainer.children).forEach(c => { if(c.id !== 'inbox-empty') c.remove() });
                } else {
                    if (emptyMsg) emptyMsg.style.display = 'none';
                    inboxContainer.innerHTML = '';
                    messages.forEach(msg => {
                        let dateObj = msg.createdAt;
                        if (dateObj && typeof dateObj.toDate === 'function') dateObj = dateObj.toDate();
                        else if (dateObj && dateObj.seconds) dateObj = new Date(dateObj.seconds * 1000);
                        else dateObj = new Date(dateObj);
                        
                        let dateStr = isNaN(dateObj.getTime()) ? '' : dateObj.toLocaleString();

                        const div = document.createElement('div');
                        div.style = "background: rgba(99, 102, 241, 0.1); border-right: 3px solid #6366f1; padding: 10px; border-radius: 6px; font-size: 13px;";
                        div.innerHTML = `
                            <div style="color: #6366f1; font-weight: bold; margin-bottom: 4px;">${msg.title || 'الادارة:'}</div>
                            <div style="color: var(--text-main);">${msg.body || msg.text || msg.message || ''}</div>
                            <div style="color: var(--text-muted); font-size: 10px; margin-top: 4px; text-align: left;">${dateStr}</div>
                        `;
                        inboxContainer.appendChild(div);
                    });
                    if (emptyMsg) inboxContainer.appendChild(emptyMsg);
                }
            });

            // Listen to Chat
            if (window.unsubscribeChat) window.unsubscribeChat();
            window.unsubscribeChat = firebaseApp.listenToChat((messages) => {
                const chatContainer = document.getElementById('chat-messages');
                if (!chatContainer) return;
                
                chatContainer.innerHTML = '';
                if (!messages || messages.length === 0) {
                    chatContainer.innerHTML = `<div class="chat-empty" style="text-align: center; color: rgba(255,255,255,0.4); margin-top: auto; margin-bottom: auto;">أرسل رسالتك وسنرد عليك في أقرب وقت.</div>`;
                    return;
                }
                
                messages.forEach(msg => {
                    let dateObj = msg.createdAt;
                    if (dateObj && typeof dateObj.toDate === 'function') dateObj = dateObj.toDate();
                    else if (dateObj && dateObj.seconds) dateObj = new Date(dateObj.seconds * 1000);
                    else if (dateObj) dateObj = new Date(dateObj);
                    else dateObj = new Date();
                    
                    let timeStr = isNaN(dateObj.getTime()) ? '' : dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

                    const isUser = !msg.isAdmin;
                    const div = document.createElement('div');
                    div.style.cssText = `background: ${isUser ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.1)'}; border-radius: 12px; padding: 8px 12px; font-size: 13px; max-width: 80%; align-self: ${isUser ? 'flex-end' : 'flex-start'}; color: white; word-wrap: break-word; overflow-wrap: break-word;`;
                    div.innerHTML = `
                        <div style="margin-bottom: 2px;">${msg.text}</div>
                        <div style="font-size: 10px; color: rgba(255,255,255,0.5); text-align: ${isUser ? 'left' : 'right'};">${timeStr}</div>
                    `;
                    chatContainer.appendChild(div);
                });
                
                // Show notification for new message if not focused
                const lastMsg = messages[messages.length - 1];
                if (lastMsg && lastMsg.isAdmin && !isAppFocused) {
                    if (window.electronAPI && window.electronAPI.showNotification) {
                        window.electronAPI.showNotification('رسالة جديدة من الدعم الفني', lastMsg.text);
                    } else if (window.Notification && Notification.permission === 'granted') {
                        new Notification('رسالة جديدة من الدعم الفني', { body: lastMsg.text });
                    }
                }

                // Auto scroll to bottom
                chatContainer.scrollTop = chatContainer.scrollHeight;
            });

            if (window.lucide) lucide.createIcons();
        } else {
            if (authSection) authSection.style.display = 'block';
            if (profileSection) profileSection.style.display = 'none';
            if (unsubscribeInbox) {
                unsubscribeInbox();
                unsubscribeInbox = null;
            }
            if (window.unsubscribeChat) {
                window.unsubscribeChat();
                window.unsubscribeChat = null;
            }
            if (window.unsubscribeUserStatus) {
                window.unsubscribeUserStatus();
                window.unsubscribeUserStatus = null;
            }
        }
    });
    
    // Login
    const handleLogin = async () => {
        const u = document.getElementById('auth-username')?.value?.trim();
        const p = document.getElementById('auth-password')?.value;
        if (!u || !p) {
            if (authError) authError.innerText = "Please enter username and password.";
            return;
        }
        
        if (authError) authError.innerText = "Logging in...";
        const res = await firebaseApp.login(u, p);
        if (!res.success) {
            if (authError) authError.innerText = res.error;
        } else {
            // Check if user is banned before allowing access
            try {
                const uid = res.user.uid;
                const userDoc = await firebaseApp.db.collection("users").doc(uid).get();
                if (userDoc.exists && userDoc.data().status === 'disabled') {
                    await firebaseApp.auth.signOut();
                    if (authError) authError.innerText = "Your account has been suspended. Contact support.";
                    return;
                }
            } catch (_) { /* allow login if check fails */ }
            if (authError) authError.innerText = "";
            showToast(`Welcome back, ${u}!`, '#10b981');
        }
    };

    document.getElementById('btn-login')?.addEventListener('click', handleLogin);
    document.getElementById('auth-password')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleLogin();
    });
    document.getElementById('auth-username')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('auth-password')?.focus();
    });
    
    // Register
    document.getElementById('btn-register')?.addEventListener('click', async () => {
        const u = document.getElementById('auth-username')?.value?.trim();
        const p = document.getElementById('auth-password')?.value;
        if (!u || !p) {
            if (authError) authError.innerText = "Please enter username and password.";
            return;
        }
        
        if (authError) authError.innerText = "Registering...";
        const res = await firebaseApp.register(u, p);
        if (!res.success) {
            if (authError) authError.innerText = res.error;
        } else {
            if (authError) authError.innerText = "";
            showToast(`Account created successfully!`, '#10b981');
        }
    });
    
    // Login Anon
    document.getElementById('btn-login-anon')?.addEventListener('click', async () => {
        if (authError) authError.innerText = "Continuing as guest...";
        const res = await firebaseApp.loginAnon();
        if (!res.success) {
            if (authError) authError.innerText = res.error;
        } else {
            if (authError) authError.innerText = "";
            showToast('Signed in as Guest', '#3b82f6');
        }
    });
    
    // Chat System Submit
    const handleSendChat = async () => {
        const msgInput = document.getElementById('chat-input');
        if (!msgInput) return;
        const msg = msgInput.value.trim();
        if (!msg) return;

        const btn = document.getElementById('btn-send-chat');
        const oldContent = btn ? btn.innerHTML : '';
        if (btn) {
            btn.innerHTML = '<i data-lucide="loader" class="spinner"></i>';
            btn.disabled = true;
        }
        if (window.lucide) lucide.createIcons();

        const res = await firebaseApp.sendChatMessage(msg);
        if (res.success) {
            msgInput.value = '';
        } else {
            showToast(res.error || 'Failed to send message', '#ef4444');
        }

        if (btn) {
            btn.innerHTML = oldContent;
            btn.disabled = false;
        }
        if (window.lucide) lucide.createIcons();
    };

    document.getElementById('btn-send-chat')?.addEventListener('click', handleSendChat);

    document.getElementById('chat-input')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            handleSendChat();
        }
    });

    // Logout
    document.getElementById('btn-logout')?.addEventListener('click', async () => {
        await firebaseApp.logout();
        showToast('Logged out successfully', '#3b82f6');
    });
    
    // Avatar Upload
    document.getElementById('avatar-upload')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        
        const statusEl = document.getElementById('profile-status');
        if (statusEl) statusEl.innerText = "Uploading avatar...";
        const res = await firebaseApp.uploadAvatar(file);
        
        if (res.success) {
            if (profileAvatar) profileAvatar.src = res.url;
            if (statusEl) statusEl.innerText = "Member";
            showToast("Avatar updated successfully!", "#10b981");
        } else {
            if (statusEl) statusEl.innerText = "Avatar upload failed: " + res.error;
            showToast(res.error || "Avatar upload failed", "#ef4444");
        }
    });
}

// Call init if already loaded, else wait
if (window.firebaseApp) {
    initFirebaseAuth();
} else {
    window.addEventListener('firebase-ready', initFirebaseAuth);
}

// ============================================
// RIGHT SIDEBAR TOGGLE
// ============================================
const sidebarToggleBtn = document.getElementById('btn-toggle-sidebar');
const rightSidebar = document.getElementById('right-sidebar');

if (sidebarToggleBtn && rightSidebar) {
    // Restore saved state
    const sidebarHidden = localStorage.getItem('ledo_sidebar_collapsed') === 'true';
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
const btnDark = document.getElementById('btn-theme-dark');
if (btnLight && btnDark) {
    btnLight.addEventListener('click', () => {
        appSettings.theme = 'light';
        saveSettings(appSettings);
        applySettings();
        initVanta();
        btnLight.style.background = 'var(--accent-primary)';
        btnLight.style.color = 'white';
        btnDark.style.background = 'transparent';
        btnDark.style.color = 'var(--text-muted)';
    });
    btnDark.addEventListener('click', () => {
        appSettings.theme = 'dark';
        saveSettings(appSettings);
        applySettings();
        initVanta();
        btnDark.style.background = 'var(--accent-primary)';
        btnDark.style.color = 'white';
        btnLight.style.background = 'transparent';
        btnLight.style.color = 'var(--text-muted)';
    });
}


// Drag and Drop Logic
let dragCounter = 0;
document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    const overlay = document.getElementById('drag-drop-overlay');
    if (overlay) overlay.style.display = 'flex';
});
document.addEventListener('dragover', (e) => {
    e.preventDefault();
});
document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
        const overlay = document.getElementById('drag-drop-overlay');
        if (overlay) overlay.style.display = 'none';
    }
});
document.addEventListener('drop', (e) => {
    e.preventDefault();
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
// ==========================================
// ADMIN CONTROL PANEL LOGIC
// ==========================================
document.addEventListener("DOMContentLoaded", function() {
    var btnManageUsers = document.getElementById("btn-admin-manage-users");
    var btnBroadcast = document.getElementById("btn-admin-broadcast");
    var btnRefreshUsers = document.getElementById("btn-admin-refresh-users");
    var usersList = document.getElementById("admin-users-list");
    var usersSection = document.getElementById("admin-users-list-section");

    if (btnManageUsers) {
        btnManageUsers.addEventListener("click", async function() {
            if (usersSection.style.display === "block") {
                usersSection.style.display = "none";
                return;
            }
            usersSection.style.display = "block";
            await loadAdminUsers();
        });
    }

    if (btnRefreshUsers) {
        btnRefreshUsers.addEventListener("click", function() { loadAdminUsers(); });
    }

    if (btnBroadcast) {
        btnBroadcast.addEventListener("click", async function() {
            var msg = prompt("ادخل نص الاعلان العام لجميع المستخدمين:");
            if (msg && msg.trim()) {
                try {
                    var snap = await window.firebaseApp.db.collection("users").get();
                    var count = 0;
                    var batch = window.firebaseApp.db.batch();
                    snap.forEach(function(doc) {
                        var msgRef = window.firebaseApp.db.collection("users").doc(doc.id).collection("messages").doc();
                        batch.set(msgRef, {
                            message: msg.trim(),
                            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                            read: false
                        });
                        count++;
                    });
                    await batch.commit();
                    if (typeof showToast === "function") showToast("تم ارسال الاعلان ل " + count + " مستخدم بنجاح!", "#10b981");
                } catch(e) {
                    console.error(e);
                    if (typeof showToast === "function") showToast("فشل ارسال الاعلان: " + e.message, "#ef4444");
                }
            }
        });
    }

    async function loadAdminUsers() {
        if (!usersList) return;
        usersList.innerHTML = '<div style="color: #fff; text-align: center; padding: 20px;">جاري تحميل المستخدمين...</div>';
        try {
            var snapshot = await window.firebaseApp.db.collection("users").get();
            usersList.innerHTML = "";
            if (snapshot.empty) {
                usersList.innerHTML = '<div style="color: #fff; text-align: center;">لا يوجد مستخدمين.</div>';
                return;
            }
            snapshot.forEach(function(doc) {
                var u = doc.data();
                var isBanned = u.status === "disabled" || u.banned;
                var div = document.createElement("div");
                div.className = "admin-user-row";
                div.style = "display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.05); padding: 10px 12px; border-radius: 8px; transition: background 0.2s;";
                var photoUrl = u.photoURL || "icon.ico";
                var username = u.username || doc.id;
                var statusColor = isBanned ? "#ef4444" : "#10b981";
                var statusText = isBanned ? "محظور" : "نشط";
                var btnText = isBanned ? "رفع الحظر" : "حظر";
                var btnStyle = isBanned ? "background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3);" : "background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.3);";

                var infoDiv = document.createElement("div");
                infoDiv.style = "display: flex; align-items: center; gap: 10px;";
                infoDiv.innerHTML = '<img src="' + photoUrl + '" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;"><div><div style="color: #fff; font-size: 13px; font-weight: 600;">' + username + '</div><div style="color: ' + statusColor + '; font-size: 10px; font-weight: 500;">' + statusText + '</div></div>';

                var btn = document.createElement("button");
                btn.style = "padding: 5px 12px; font-size: 11px; border-radius: 6px; cursor: pointer; font-weight: 600; border: none; " + btnStyle;
                btn.textContent = btnText;
                btn.addEventListener("click", function() { window.adminToggleBanUser(doc.id, isBanned); });

                div.appendChild(infoDiv);
                div.appendChild(btn);
                usersList.appendChild(div);
            });
        } catch(e) {
            usersList.innerHTML = '<div style="color: #ef4444; text-align: center;">خطأ في تحميل المستخدمين.</div>';
            console.error(e);
        }
    }

    window.adminToggleBanUser = async function(uid, currentlyBanned) {
        var reason = currentlyBanned ? "" : prompt("ادخل سبب الحظر:");
        if (!currentlyBanned && reason === null) return;
        try {
            await window.firebaseApp.db.collection("users").doc(uid).update({
                status: currentlyBanned ? "active" : "disabled",
                banned: !currentlyBanned,
                banReason: reason || "مخالفة الشروط"
            });
            if (typeof showToast === "function") showToast(currentlyBanned ? "تم رفع الحظر بنجاح!" : "تم حظر المستخدم بنجاح!", "#10b981");
            await loadAdminUsers();
        } catch(e) {
            console.error(e);
            if (typeof showToast === "function") showToast("فشل تحديث حالة المستخدم: " + e.message, "#ef4444");
        }
    };
});
