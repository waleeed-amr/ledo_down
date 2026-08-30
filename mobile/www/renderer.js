const API_URL = 'http://127.0.0.1:8000/api';
const WS_URL = 'ws://127.0.0.1:8000/ws';

// WebSocket connection
let ws;

// ============================================
// Cross-platform notification helper
// ============================================
// Browser/Electron renderer: use the native `Notification` constructor.
// Android WebView (Capacitor): the browser Notification API is missing,
// so fall back to the bridge's `triggerNotification` which uses the
// Capacitor `LocalNotifications` plugin. Always swallow errors so a
// notification failure never breaks the WebSocket message handler.
function safeNotify(body) {
    try {
        if (typeof Notification === 'function') {
            new Notification('Ledo Downloader', { body: body });
        } else if (typeof window.triggerNotification === 'function') {
            window.triggerNotification('Ledo Downloader', body);
        }
    } catch (e) {
        // Notifications are best-effort; never let them break the app.
    }
}

// ============================================
// Defensive helpers
// ============================================
// Detects whether we're running inside the Android Capacitor WebView so
// we can tweak performance-sensitive behavior (animations, heavy libs).
function isMobileWebView() {
    try {
        return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    } catch (e) { return false; }
}

// Pull a millisecond timestamp out of any id format we use:
//   - "mobile-1719432000000-12345"  -> 1719432000000
//   - "1719432000000"               -> 1719432000000
//   - UUIDv1 "mobile-<uuid>"        ->  timestamp encoded in the uuid
//   - anything else                 -> null
function extractTimestamp(id) {
    if (id === null || id === undefined) return null;
    const s = String(id);
    // Pure numeric (legacy desktop ids)
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    // "mobile-<ts>-..." fallback we used before crypto.randomUUID
    const m1 = s.match(/^mobile-(\d{10,15})/);
    if (m1) return parseInt(m1[1], 10);
    // UUIDv1 (xxxxxxxx-xxxx-1xxx-xxxx-xxxxxxxxxxxx) — first 8 hex chars
    // encode big-endian ms-since-1582-10-15. We can decode it but it's
    // overkill; just return null and let the lexicographic fallback win.
    return null;
}

// Wrap risky library calls so a missing/broken dep doesn't kill the app.
function safeCall(name, fn, fallback) {
    try {
        return fn();
    } catch (e) {
        console.error('safeCall[' + name + '] failed:', e);
        return fallback;
    }
}

// ---- Axios resilience layer ----
// On mobile the axios object is a thin mock around the native plugins,
// so this layer is mostly a no-op there — but on desktop it adds:
//   * a default timeout for any request that didn't specify one
//   * 1 automatic retry on network errors (transient flakiness)
(function setupAxiosResilience() {
    if (typeof window === 'undefined' || !window.axios) return;
    const DEFAULT_TIMEOUT = 30000; // 30s
    const original = window.axios;
    if (original.__ledoResilience) return;
    original.__ledoResilience = true;

    function withDefaults(config) {
        const cfg = config || {};
        if (cfg.timeout == null) cfg.timeout = DEFAULT_TIMEOUT;
        return cfg;
    }

    function isRetryable(err) {
        if (!err) return false;
        const code = err.code || '';
        if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;
        if (err.message && /timeout/i.test(err.message)) return true;
        if (err.message && /network/i.test(err.message)) return true;
        return false;
    }

    function wrapRequest(name, fn) {
        return async function (url, dataOrConfig, maybeConfig) {
            // Normalize the (url, config) and (url, data, config) call shapes
            let data, config;
            if (name === 'get' || name === 'delete') {
                config = dataOrConfig;
            } else {
                data = dataOrConfig;
                config = maybeConfig;
            }
            config = withDefaults(config);
            let attempt = 0;
            while (true) {
                try {
                    return name === 'get' || name === 'delete'
                        ? await fn(url, config)
                        : await fn(url, data, config);
                } catch (e) {
                    if (attempt === 0 && isRetryable(e)) {
                        attempt++;
                        console.warn('axios.' + name + ' transient error, retrying once:', e.message);
                        continue;
                    }
                    throw e;
                }
            }
        };
    }

    window.axios = Object.assign({}, original, {
        get: wrapRequest('get', original.get.bind(original)),
        post: wrapRequest('post', original.post.bind(original)),
        delete: wrapRequest('delete', original.delete.bind(original))
    });
})();

// Make showToast resilient if Toastify failed to load.
function showToast(text, color) {
    try {
        if (typeof Toastify === 'function') {
            Toastify({
                text: text,
                duration: 3000,
                gravity: 'bottom',
                position: 'right',
                style: {
                    background: color,
                    borderRadius: '12px',
                    fontFamily: 'Outfit',
                    boxShadow: '0 4px 15px ' + (color || '#000') + '66'
                }
            }).showToast();
        } else {
            // last-ditch: console + brief inline toast
            console.log('[toast]', text);
        }
    } catch (e) { /* never crash on a toast */ }
}

// ============================================
// SETTINGS MANAGEMENT
// ============================================
const DEFAULT_SETTINGS = {
    defaultSavePath: 'C:\\Users\\z\\Desktop',
    powerSaver: false,
    reduceHover: false,
    theme: 'dark'
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
    if (cbPower) cbPower.checked = appSettings.powerSaver;
    if (cbHover) cbHover.checked = appSettings.reduceHover;

    // Theme
    if (appSettings.theme === 'light') {
        document.body.classList.add('theme-light');
    } else {
        document.body.classList.remove('theme-light');
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
    if (window.VANTA && !appSettings.powerSaver) {
        if (vantaEffect) vantaEffect.destroy();
        vantaEffect = VANTA.HALO({
            el: ".app-container",
            mouseControls: true,
            touchControls: true,
            gyroControls: false,
            minHeight: 200.00,
            minWidth: 200.00,
            amplitudeFactor: 0,
            size: 1.5,
            baseColor: appSettings.theme === 'light' ? 0xe2e8f0 : 0x18181b,
            backgroundColor: appSettings.theme === 'light' ? 0xf8fafc : 0x09090b
        });
    } else if (vantaEffect) {
        vantaEffect.destroy();
        vantaEffect = null;
    }
}

// Initialize settings on load
document.addEventListener('DOMContentLoaded', () => {
    // On mobile, force-enable Power Saver by default to save battery.
    // (User can still turn it off in settings — the persisted value wins
    // on subsequent launches.)
    if (isMobileWebView() && appSettings.powerSaver === false) {
        appSettings.powerSaver = true;
        try { saveSettings(appSettings); } catch (e) { /* ignore */ }
    }

    applySettings();
    // Vanta HALO is a heavy 3D WebGL animation — skip it on the mobile
    // WebView to save battery and GPU. Power-saver users already get
    // this for free, but a phone in dark mode with Vanta running drains
    // visibly fast.
    if (!isMobileWebView()) {
        try { initVanta(); } catch (e) { console.error('Vanta init failed', e); }
    }

    // Initialize Lucide Icons
    if (window.lucide) lucide.createIcons();

    // Tippy tooltips are nice on desktop but can interfere with mobile
    // touch targets. Skip them on phones to keep the UI snappy.
    if (window.tippy && !isMobileWebView()) {
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

    // Initialize SortableJS — disabled on small mobile screens because
    // drag-to-reorder doesn't play well with touch scrolling.
    const listEl = document.getElementById('downloads-list');
    const isSmallScreen = window.matchMedia && window.matchMedia('(max-width: 600px)').matches;
    if (listEl && window.Sortable && !isSmallScreen) {
        new Sortable(listEl, {
            animation: 150,
            handle: '.dl-header',
            ghostClass: 'sortable-ghost'
        });
    }

    // Show empty state on first paint
    ensureEmptyState();

    // Hide desktop-specific UI elements when running on mobile
    if (isMobileWebView()) {
        const hideEls = [
            'btn-select-folder',
            'btn-toggle-batch',
            'batch-quality-select',
            'btn-settings-change-path',
            'toggle-reduce-hover'
        ];
        hideEls.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                if (id === 'toggle-reduce-hover') {
                    const row = el.closest('.settings-toggle-row');
                    if (row) row.style.display = 'none';
                } else {
                    el.style.display = 'none';
                }
            }
        });

        // Ensure URL input has normal border radius if right-side buttons are hidden
        const urlInput = document.getElementById('url-input');
        if (urlInput) {
            urlInput.style.borderTopRightRadius = '8px';
            urlInput.style.borderBottomRightRadius = '8px';
        }
    }
});

// Settings Event Listeners
document.getElementById('checkbox-power-saver').addEventListener('change', (e) => {
    appSettings.powerSaver = e.target.checked;
    saveSettings(appSettings);
    applySettings();
    initVanta();
    showToast(e.target.checked ? 'Power Saver Mode: ON' : 'Power Saver Mode: OFF', e.target.checked ? '#10b981' : '#6366f1');
});

document.getElementById('checkbox-reduce-hover').addEventListener('change', (e) => {
    appSettings.reduceHover = e.target.checked;
    saveSettings(appSettings);
    applySettings();
    showToast(e.target.checked ? 'Hover Effects: Reduced' : 'Hover Effects: Normal', '#6366f1');
});

document.getElementById('btn-theme-toggle').addEventListener('click', (e) => {
    e.preventDefault();
    appSettings.theme = appSettings.theme === 'dark' ? 'light' : 'dark';
    saveSettings(appSettings);
    applySettings();
    initVanta();
    showToast(`Theme changed to ${appSettings.theme}`, '#3b82f6');
});

document.getElementById('btn-settings-change-path').addEventListener('click', async () => {
    const path = await window.electronAPI.selectFolder();
    if (path) {
        appSettings.defaultSavePath = path;
        saveSettings(appSettings);
        applySettings();
        showToast('Default save path updated!', '#10b981');
    }
});

document.getElementById('btn-restore-defaults').addEventListener('click', () => {
    if (window.Swal) {
        Swal.fire({
            title: 'Are you sure?',
            text: "You want to restore all settings to default?",
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#3b82f6',
            cancelButtonColor: '#ef4444',
            confirmButtonText: 'Yes, restore it!',
            background: '#1a1a24',
            color: '#fff'
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

// Local state for sorting/filtering
let rawDownloadsData = [];
let currentFilter = 'all';
let currentSort = 'date-desc';
window.speedHistory = {}; // { id: [speed_bytes_1, speed_bytes_2, ...] }

function processDownloadsState(downloads) {
    rawDownloadsData = downloads;
    
    // Record speed history
    downloads.forEach(dl => {
        if (!window.speedHistory[dl.id]) window.speedHistory[dl.id] = [];
        if (dl.status === 'downloading') {
            window.speedHistory[dl.id].push(dl.speed || 0);
            if (window.speedHistory[dl.id].length > 20) window.speedHistory[dl.id].shift(); // Keep last 20 ticks
        }
    });

    applyFilterAndSort();
}

function applyFilterAndSort() {
    let result = [...rawDownloadsData];

    // Filter
    if (currentFilter === 'downloading') {
        result = result.filter(d => ['downloading', 'starting'].includes(d.status));
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
            const nameA = (a.filename || a.url).toLowerCase();
            const nameB = (b.filename || b.url).toLowerCase();
            return nameA.localeCompare(nameB);
        }
        // date-desc (default): extract a numeric timestamp from the id.
        // Mobile ids look like "mobile-<uuid>" — we can pull the embedded
        // ms timestamp from a UUIDv1 or use a fallback to lexicographic
        // compare which is stable for the same prefix.
        const tsA = extractTimestamp(a.id);
        const tsB = extractTimestamp(b.id);
        if (tsA !== null && tsB !== null) return tsB - tsA;
        return String(b.id || '').localeCompare(String(a.id || ''));
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
document.getElementById('sort-select').addEventListener('change', (e) => {
    currentSort = e.target.value;
    applyFilterAndSort();
});


// ---- Connection status indicator ----
// State is one of: 'connected' | 'reconnecting' | 'offline'
let connectionState = 'reconnecting';
let connectionBannerEl = null;
let wsReconnectDelay = 2000; // exponential backoff: 2s, 4s, 8s, 16s, 30s (capped)
let wsReconnectTimer = null;
let wsReconnectAttempts = 0;

function ensureConnectionBanner() {
    if (connectionBannerEl && document.body.contains(connectionBannerEl)) return connectionBannerEl;
    const el = document.createElement('div');
    el.id = 'connection-banner';
    el.className = 'connection-banner';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    connectionBannerEl = el;
    return el;
}

function setConnectionState(state, message) {
    connectionState = state;
    const el = ensureConnectionBanner();
    if (state === 'connected') {
        el.className = 'connection-banner connection-connected';
        el.textContent = message || 'Connected';
        // Auto-hide after 2.5s when we're back online
        setTimeout(() => {
            if (connectionState === 'connected' && connectionBannerEl === el) {
                el.classList.add('connection-hidden');
            }
        }, 2500);
    } else {
        el.classList.remove('connection-hidden');
        el.className = 'connection-banner connection-' + state;
        el.textContent = message || (state === 'offline' ? 'No internet connection' : 'Reconnecting...');
    }
}

window.addEventListener('online', () => {
    wsReconnectDelay = 2000;
    wsReconnectAttempts = 0;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    setConnectionState('reconnecting', 'Network back — reconnecting...');
    try { connectWebSocket(); } catch (e) { /* swallow */ }
});

window.addEventListener('offline', () => {
    setConnectionState('offline', 'No internet connection');
});

function connectWebSocket() {
    // The mobile bridge replaces `WebSocket` with a MockWebSocket that
    // fires onopen after 50ms. On desktop this is a real WebSocket.
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    try {
        ws = new WebSocket(WS_URL);
    } catch (e) {
        console.error('Failed to construct WebSocket', e);
        scheduleReconnect();
        return;
    }

    ws.onopen = function() {
        wsReconnectDelay = 2000;
        wsReconnectAttempts = 0;
        setConnectionState('connected', 'Connected');
    };

    ws.onmessage = function(event) {
        try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'open_quick_add') {
                if (window.electronAPI && window.electronAPI.showQuickAdd) {
                    window.electronAPI.showQuickAdd(payload.url, payload.cookies, payload.user_agent);
                }
            } else if (payload.type === 'state' || payload.type === 'downloads') {
                try { processDownloadsState(payload.downloads || []); } catch (e) { console.error('processDownloadsState failed', e); }

                // Track completions for notifications
                payload.downloads.forEach(dl => {
                    try {
                        if (!window.knownDownloads) window.knownDownloads = new Map();

                        const prevStatus = window.knownDownloads.get(dl.id);
                        if (prevStatus !== dl.status) {
                            if (dl.status === 'completed' && prevStatus) {
                                showToast(`Download Completed: ${dl.filename || 'File'}`, '#10b981');
                                safeNotify('Download Completed: ' + (dl.filename || 'File'));
                                // Confetti is heavy on mobile — only run if not in WebView
                                if (window.confetti && !isMobileWebView()) {
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
                                showToast(`Download Failed: ${dl.filename || dl.url}`, '#ef4444');
                                safeNotify('Download Failed: ' + (dl.filename || 'File'));
                            }
                            window.knownDownloads.set(dl.id, dl.status);
                        }
                    } catch (e) {
                        // Never let a single bad download break the rest of the WS stream
                        console.error('WS update handler error for', dl && dl.id, e);
                    }
                });
            }
        } catch (e) {
            console.error("Failed to parse WS data", e);
        }
    };

    ws.onclose = function() {
        scheduleReconnect();
    };

    ws.onerror = function(err) {
        // onclose will fire right after; reconnect happens there.
        console.error("WebSocket Error: ", err);
        try { ws.close(); } catch (e) { /* already closed */ }
    };
}

function scheduleReconnect() {
    wsReconnectAttempts++;
    // Cap the backoff so we don't sleep for minutes
    const delay = Math.min(wsReconnectDelay, 30000);
    const msg = wsReconnectAttempts > 1
        ? 'Reconnecting in ' + Math.round(delay / 1000) + 's... (attempt ' + wsReconnectAttempts + ')'
        : 'Reconnecting...';
    setConnectionState('reconnecting', msg);
    wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        try { connectWebSocket(); } catch (e) { scheduleReconnect(); }
    }, delay);
    // Exponential backoff: 2s, 4s, 8s, 16s, 30s
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
}

// Initial connection
connectWebSocket();

// customSavePath = one-time override from the folder picker next to URL bar
let customSavePath = null;

document.getElementById('btn-select-folder').addEventListener('click', async () => {
    const path = await window.electronAPI.selectFolder();
    if (path) {
        customSavePath = path;
        updateSavePathDisplay();
        showToast('Save path set for this download only', '#6366f1');
    }
});

let isBatchMode = false;
document.getElementById('btn-toggle-batch').addEventListener('click', () => {
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

// Debounce the fetch button so a double-tap doesn't enqueue two
// separate "Fetch Info" requests for the same URL.
let _fetchBusy = false;
document.getElementById('btn-fetch-info').addEventListener('click', async () => {
    if (_fetchBusy) return;
    _fetchBusy = true;
    try {
        await handleFetchClick();
    } finally {
        _fetchBusy = false;
    }
});

async function handleFetchClick() {
    if (isBatchMode) {
        const urls = document.getElementById('url-batch-input').value.split('\n').map(u => u.trim()).filter(u => u);
        if (urls.length === 0) return showToast("Enter at least one URL", "#f59e0b");
        const effectivePath = customSavePath || appSettings.defaultSavePath;
        const batchQuality = document.getElementById('batch-quality-select').value || 'best';
        let added = 0;
        
        const btn = document.getElementById('btn-fetch-info');
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="loader" class="spinner"></i> <span id="btn-fetch-text">Adding...</span>`;
        if (window.lucide) lucide.createIcons();

        for (const url of urls) {
            try {
                await axios.post(`${API_URL}/download`, { 
                    url: url, 
                    save_path: effectivePath, 
                    quality: batchQuality,
                    is_yt_dlp: null // auto detect
                });
                added++;
            } catch (e) {
                console.error("Batch error for", url);
            }
        }
        showToast(`Started ${added} downloads in batch`, "#10b981");
        document.getElementById('url-batch-input').value = '';
        customSavePath = null;
        updateSavePathDisplay();
        
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="download-cloud"></i> <span id="btn-fetch-text">Download All</span>`;
        if (window.lucide) lucide.createIcons();
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
        const response = await axios.post(`${API_URL}/info`, { url: url }, { timeout: 60000 });
        const data = response.data;
        
        if (data.status === 'success') {
            document.getElementById('modal-title').innerText = data.title;
            const optionsDiv = document.getElementById('quality-options');
            
            if (data.is_direct) {
                window.isDirectFile = true;
                optionsDiv.innerHTML = `
                    <label class="quality-option active">
                        <input type="radio" name="quality" value="best" checked onchange="selectedQuality='best'; updateQualitySelection()">
                        <div class="q-info">
                            <span class="q-title">Direct File Download</span>
                            <span class="q-size">${data.sizes.best ? formatBytes(data.sizes.best) : 'Size Unknown'}</span>
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
                    const size = data.sizes[q.id];
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
            // Bridge now returns { status: 'error', error: '<reason>' } when
            // the native plugin fails (e.g. yt-dlp not yet initialized).
            // Show the real reason instead of a generic toast.
            const reason = data.error || data.message || 'Unknown error';
            showToast("Failed to fetch info: " + reason, "#ef4444");
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
}

function updateQualitySelection() {
    document.querySelectorAll('.quality-option').forEach(el => {
        el.classList.remove('active');
        if(el.querySelector('input').checked) {
            el.classList.add('active');
        }
    });
}

document.getElementById('btn-cancel-modal').addEventListener('click', () => {
    document.getElementById('quality-modal').style.display = 'none';
    document.getElementById('schedule-picker-container').style.display = 'none';
});

document.getElementById('btn-schedule-toggle').addEventListener('click', () => {
    const container = document.getElementById('schedule-picker-container');
    container.style.display = container.style.display === 'none' ? 'block' : 'none';
});

document.getElementById('btn-start-download').addEventListener('click', async () => {
    const url = document.getElementById('url-input').value;
    document.getElementById('quality-modal').style.display = 'none';
    
    const scheduleTime = document.getElementById('schedule-time').value;
    document.getElementById('schedule-picker-container').style.display = 'none';
    document.getElementById('schedule-time').value = '';
    
    // Determine save path: one-time override > settings default
    const effectivePath = customSavePath || appSettings.defaultSavePath;
    
    try {
        if (scheduleTime) {
            // Schedule the download
            const d = new Date(scheduleTime);
            if (d <= new Date()) {
                showToast("Scheduled time must be in the future", "#ef4444");
                return;
            }
            await axios.post(`${API_URL}/schedule`, {
                url: url,
                save_path: effectivePath,
                quality: selectedQuality,
                is_yt_dlp: window.isDirectFile ? false : true,
                run_at: d.toISOString()
            });
            showToast(`Download scheduled for ${d.toLocaleTimeString()}`, "#3b82f6");
        } else {
            // Start immediately
            await axios.post(`${API_URL}/download`, { 
                url: url, 
                save_path: effectivePath, 
                quality: selectedQuality,
                is_yt_dlp: window.isDirectFile ? false : true
            });
            showToast("Starting Download...", "#10b981");
        }
        
        document.getElementById('url-input').value = '';
        
        // Reset one-time override after use
        customSavePath = null;
        updateSavePathDisplay();
    } catch (error) {
        console.error("Error adding download", error);
        showToast("Failed to start/schedule download", "#ef4444");
    }
});


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
    if (!listEl) return;

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

        let cancelBtnHtml = '';
        if (['downloading', 'starting'].includes(dl.status)) {
            cancelBtnHtml = `
                <button class="btn-cancel-dl" onclick="cancelDownload('${dl.id}')" title="Cancel Download">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            `;
        }

        let playBtnHtml = '';
        if (dl.status === 'completed' && dl.filename) {
            const lname = (dl.filename || '').toLowerCase();
            const isPlayable = /\.(mp4|mkv|webm|mov|avi|flv|wmv|m4v|mp3|m4a|wav|flac|ogg|opus|aac)$/.test(lname);
            if (isPlayable) {
                const safeId = String(dl.id).replace(/'/g, "\\'");
                const safeName = (dl.filename || '').replace(/'/g, "\\'");
                playBtnHtml = `
                    <button class="btn-play-dl" onclick="playMedia('${safeId}', '${safeName}')" title="Play" aria-label="Play">
                        <i data-lucide="play"></i>
                    </button>
                `;
            }
        }

        let retryBtnHtml = '';
        if (dl.status === 'error' && dl.url) {
            const safeUrl = String(dl.url).replace(/'/g, "\\'").replace(/"/g, '&quot;');
            retryBtnHtml = `
                <button class="btn-retry-dl" onclick="retryDownload('${safeUrl}')" title="Retry download" aria-label="Retry">
                    <i data-lucide="rotate-cw"></i>
                </button>
            `;
        }

        const innerHTML = `
            <div class="dl-header" style="cursor: grab;">
                <div title="Drag to reorder" style="color: var(--text-muted); display: flex; align-items: center; margin-right: 8px;">
                    <i data-lucide="grip-vertical" style="width: 16px; height: 16px;"></i>
                </div>
                <div class="dl-title" title="${name}">${name}</div>
                <div class="dl-actions">
                    ${playBtnHtml}
                    ${retryBtnHtml}
                    <div class="dl-status ${dl.status}">${dl.status}</div>
                    ${cancelBtnHtml}
                </div>
            </div>
            ${errorHtml}
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
            card.innerHTML = innerHTML;
            if (dl.status === 'starting' || dl.status === 'downloading') {
                listEl.prepend(card);
            } else {
                listEl.appendChild(card);
            }
            if (window.lucide) lucide.createIcons({ root: card });
            if (window.gsap && !appSettings.powerSaver) {
                gsap.fromTo(card, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" });
            }
        } else {
            if (card.className !== `download-card status-${dl.status}`) {
                card.className = `download-card status-${dl.status}`;
            }
            if (card.innerHTML !== innerHTML) {
                card.innerHTML = innerHTML;
                if (window.lucide) lucide.createIcons({ root: card });
            }
        }
        
        card.onclick = (e) => {
            if (e.target.closest('button') || e.target.closest('.dl-header i') || e.target.closest('.dl-header svg')) return;
            openDetailsDrawer(dl);
        };
    });

    // Empty state — only when there's truly nothing to show
    ensureEmptyState(downloads.length === 0);
}

// Show a friendly empty state when there are no downloads to render.
// We toggle a single placeholder element instead of recreating it each
// paint, so lucide.createIcons() doesn't have to re-run unnecessarily.
function ensureEmptyState(show) {
    const listEl = document.getElementById('downloads-list');
    if (!listEl) return;
    let empty = document.getElementById('downloads-empty-state');
    if (show) {
        if (empty) return;
        empty = document.createElement('div');
        empty.id = 'downloads-empty-state';
        empty.className = 'empty-state';
        empty.innerHTML = `
            <div class="empty-state-icon">
                <i data-lucide="inbox"></i>
            </div>
            <div class="empty-state-title">No downloads yet</div>
            <div class="empty-state-sub">Paste a URL above to start. YouTube, direct files, anything.</div>
        `;
        listEl.appendChild(empty);
        if (window.lucide) lucide.createIcons({ root: empty });
    } else if (empty) {
        empty.remove();
    }
}

// Drawer Logic
let drawerChartInstance = null;
function openDetailsDrawer(dl) {
    const drawer = document.getElementById('details-drawer');
    if (!drawer) return;
    const content = drawer.querySelector('.drawer-content');
    if (!content) return;

    // Format dates — try to recover a real timestamp from the id.
    // Fall back to "just now" if the id has no embedded timestamp.
    let dateAdded = dl.id;
    const ts = extractTimestamp(dl.id);
    if (ts && window.dayjs) {
        dateAdded = dayjs(ts).format('DD MMM YYYY, hh:mm A');
    } else if (ts) {
        try { dateAdded = new Date(ts).toLocaleString(); } catch (e) { /* keep id */ }
    }
    
    let html = `
        <div class="detail-item">
            <span class="detail-label">Filename</span>
            <span class="detail-value" style="font-weight: 600;">${dl.filename || 'Unknown'}</span>
        </div>
        <div class="detail-item">
            <span class="detail-label">Status</span>
            <span class="detail-value" style="text-transform: capitalize; color: var(--accent-primary);">${dl.status}</span>
        </div>
        <div class="detail-item">
            <span class="detail-label">Original URL</span>
            <span class="detail-value" style="word-break: break-all; font-size: 12px;">${dl.url}</span>
        </div>
        <div class="detail-item">
            <span class="detail-label">Size</span>
            <span class="detail-value">${formatBytes(dl.total_size)}</span>
        </div>
        <div class="detail-item">
            <span class="detail-label">Added</span>
            <span class="detail-value">${dateAdded}</span>
        </div>
        <div class="detail-item">
            <span class="detail-label">Speed History</span>
            <div class="speed-chart-container">
                <canvas id="drawerSpeedChart"></canvas>
            </div>
        </div>
    `;
    content.innerHTML = html;
    
    drawer.classList.add('open');
    
    // Draw speed chart
    setTimeout(() => {
        const ctx = document.getElementById('drawerSpeedChart');
        if (ctx) {
            if (drawerChartInstance) drawerChartInstance.destroy();
            const history = window.speedHistory[dl.id] || [];
            drawerChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: history.map((_, i) => i),
                    datasets: [{
                        label: 'Speed (B/s)',
                        data: history,
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59, 130, 246, 0.2)',
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
                    }
                }
            });
        }
    }, 300);
}

document.getElementById('btn-close-drawer').addEventListener('click', () => {
    document.getElementById('details-drawer').classList.remove('open');
});

// Re-queue a failed download with the same URL + auto-detected quality.
window.retryDownload = async function(url) {
    if (!url) return;
    showToast('Retrying download...', '#6366f1');
    try {
        // Drop the failed record so the UI doesn't show two of the same URL.
        try {
            const arr = window.capacitorDownloads ? Array.from(window.capacitorDownloads.entries()) : [];
            for (const [id, dl] of arr) {
                if (dl && dl.url === url) {
                    window.capacitorDownloads.delete(id);
                }
            }
        } catch (e) { /* not critical */ }
        if (window.mockServerUpdate) window.mockServerUpdate();

        const effectivePath = customSavePath || appSettings.defaultSavePath;
        const response = await axios.post(`${API_URL}/info`, { url: url }, { timeout: 60000 });
        const data = response.data;
        if (data && data.status === 'success') {
            // Re-fetch quality options and immediately start with "best"
            window.isDirectFile = !!data.is_direct;
            const q = data.is_direct ? 'best' : 'best';
            await axios.post(`${API_URL}/download`, {
                url: url,
                save_path: effectivePath,
                quality: q,
                is_yt_dlp: data.is_direct ? false : true
            });
            showToast('Retrying...', '#10b981');
        } else {
            showToast('Could not fetch info to retry.', '#ef4444');
        }
    } catch (e) {
        console.error('retry failed', e);
        showToast('Retry failed: ' + (e.message || 'unknown error'), '#ef4444');
    }
};

window.cancelDownload = async function(id) {
    if (window.Swal) {
        Swal.fire({
            title: 'Cancel Download?',
            text: "Are you sure you want to cancel this download?",
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            cancelButtonColor: '#3f3f46',
            confirmButtonText: 'Yes, cancel it',
            background: '#1a1a24',
            color: '#fff'
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
    } else {
        if (confirm("Are you sure you want to cancel this download?")) {
            try {
                await axios.delete(`${API_URL}/cancel/${id}`);
                showToast("Download canceled.", "#ef4444");
            } catch (e) {
                console.error("Cancel failed", e);
                showToast("Failed to cancel download.", "#ef4444");
            }
        }
    }
}

// Media Player Logic
let myPlayer = null;
window.playMedia = async function(id, filename) {
    const isAudio = filename && (filename.endsWith('.mp3') || filename.endsWith('.m4a') || filename.endsWith('.wav'));
    
    // Destroy existing player cleanly
    if (myPlayer) {
        try {
            myPlayer.destroy();
        } catch (e) {}
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
            p.catch(() => {}); // Silently handle if interrupted
        }
    });
    
    myPlayer.source = {
        type: isAudio ? 'audio' : 'video',
        sources: [
            {
                src: '',
                provider: 'html5',
            },
        ],
    };

    // Resolve the local file URL via the bridge (axios.get intercepts
    // `/stream/{id}` on mobile and returns a `data: { url }` payload).
    try {
        const resp = await axios.get(`${API_URL}/stream/${id}`, { timeout: 10000 });
        const srcUrl = (resp && resp.data && resp.data.url) || '';
        if (!srcUrl) {
            showToast('File path is not available yet. Try again after the download finishes.', '#ef4444');
            return;
        }
        myPlayer.source = {
            type: isAudio ? 'audio' : 'video',
            sources: [{ src: srcUrl, provider: 'html5' }],
        };
    } catch (e) {
        console.error('stream lookup failed', e);
        showToast('Could not open the file for playback.', '#ef4444');
    }
};

document.getElementById('btn-close-player').addEventListener('click', () => {
    if (myPlayer) {
        try {
            myPlayer.pause();
            myPlayer.destroy();
        } catch (e) {}
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
        const data = res.data;
        
        document.getElementById('stat-total-files').innerText = data.total_files;
        document.getElementById('stat-total-bytes').innerText = formatBytes(data.total_downloaded_bytes);
        document.getElementById('stat-completed').innerText = data.completed;
        document.getElementById('stat-errors').innerText = data.errors;
        
        // Populate new video/audio counters
        const videosEl = document.getElementById('stat-videos');
        const audiosEl = document.getElementById('stat-audios');
        if (videosEl) videosEl.innerText = data.videos || 0;
        if (audiosEl) audiosEl.innerText = data.audios || 0;
        
        const ctx = document.getElementById('downloadsChart').getContext('2d');
        if (statsChartInstance) {
            statsChartInstance.destroy();
        }
        
        const otherCount = Math.max(0, data.total_files - (data.videos || 0) - (data.audios || 0));
        
        statsChartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Videos', 'Audio', 'Other'],
                datasets: [{
                    data: [data.videos || 0, data.audios || 0, otherCount],
                    backgroundColor: ['#c084fc', '#fbbf24', '#64748b'],
                    borderWidth: 0,
                    hoverOffset: 8,
                    borderRadius: 4,
                    spacing: 3
                }]
            },
            options: {
                responsive: true,
                cutout: '65%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { 
                            color: '#a1a1aa',
                            padding: 16,
                            usePointStyle: true,
                            pointStyleWidth: 12,
                            font: { size: 13, weight: '500' }
                        }
                    }
                }
            }
        });
        
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
        if (!confirm("Are you sure you want to clear all download history? This cannot be undone.")) return;
        try {
            await axios.delete(`${API_URL}/clear-history`);
            showToast("Download history cleared!", "#10b981");
            loadStats();
        } catch (e) {
            showToast("Failed to clear history", "#ef4444");
        }
    });
}

// Navigation logic (Sidebar)
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        e.currentTarget.classList.add('active');
        
        const isSettings = e.currentTarget.innerText.includes('Settings');
        const isStats = e.currentTarget.innerText.includes('Statistics');
        
        document.getElementById('view-downloads').classList.remove('active');
        if (document.getElementById('view-settings')) document.getElementById('view-settings').classList.remove('active');
        if (document.getElementById('view-stats')) document.getElementById('view-stats').classList.remove('active');
        
        if (isSettings) {
            if (document.getElementById('view-settings')) document.getElementById('view-settings').classList.add('active');
        } else if (isStats) {
            if (document.getElementById('view-stats')) document.getElementById('view-stats').classList.add('active');
            loadStats();
        } else {
            document.getElementById('view-downloads').classList.add('active');
        }
    });
});

// Developer Tools (F12) via Eruda
document.addEventListener('keydown', (e) => {
    if (e.key === 'F12') {
        e.preventDefault();
        if (!window.eruda) {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/eruda';
            script.onload = () => {
                eruda.init();
                eruda.show();
            };
            document.head.appendChild(script);
        } else {
            // Toggle visibility
            const erudaRoot = document.querySelector('#eruda');
            if (erudaRoot && erudaRoot.shadowRoot) {
                const display = erudaRoot.shadowRoot.querySelector('.eruda-dev-tools').style.display;
                if (display === 'none' || !display) {
                    eruda.show();
                } else {
                    eruda.hide();
                }
            } else {
                eruda.show();
            }
        }
    }
});
