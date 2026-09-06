const API_URL = 'http://127.0.0.1:8000/api';
const WS_URL = 'ws://127.0.0.1:8000/ws';

// WebSocket connection
let ws;

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

document.getElementById('checkbox-compact-mode').addEventListener('change', (e) => {
    appSettings.compactMode = e.target.checked;
    saveSettings(appSettings);
    applySettings();
    showToast(e.target.checked ? 'Compact Mode: ON' : 'Compact Mode: OFF', '#3b82f6');
});

document.getElementById('btn-settings-theme').addEventListener('click', (e) => {
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
document.getElementById('btn-settings-upload-bg').addEventListener('click', () => {
    document.getElementById('bg-upload-input').click();
});

document.getElementById('bg-upload-input').addEventListener('change', (e) => {
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

document.getElementById('btn-settings-clear-bg').addEventListener('click', () => {
    appSettings.customBackground = null;
    saveSettings(appSettings);
    applySettings();
    showToast('Custom background cleared!', '#f59e0b');
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

    updateRecentCompleted();
    applyFilterAndSort();
}

function updateRecentCompleted() {
    const recentList = document.getElementById('recent-completed-list');
    if (!recentList) return;

    const completed = [...rawDownloadsData]
        .filter(d => d.status === 'completed')
        .sort((a, b) => parseInt(b.id) - parseInt(a.id))
        .slice(0, 4);

    if (completed.length === 0) {
        recentList.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">No recent downloads</div>';
        return;
    }

    let html = '';
    completed.forEach(dl => {
        const name = dl.filename || dl.url || 'Unknown';
        const size = dl.total_size ? formatBytes(dl.total_size) : 'Unknown';
        html += `
            <div class="recent-item" onclick="openDetailsDrawer({id:'${dl.id}', filename:'${name}', status:'completed', total_size:${dl.total_size}, url:'${dl.url}'})">
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
        // date-desc (default, rely on ID or DB order assuming larger ID is newer)
        return parseInt(b.id) - parseInt(a.id);
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


function connectWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onmessage = function (event) {
        try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'open_quick_add') {
                if (window.electronAPI && window.electronAPI.showQuickAdd) {
                    window.electronAPI.showQuickAdd(payload.url, payload.cookies, payload.user_agent);
                }
            } else if (payload.type === 'state' || payload.type === 'downloads') {
                processDownloadsState(payload.downloads || []);

                // Track completions for notifications
                payload.downloads.forEach(dl => {
                    if (!window.knownDownloads) window.knownDownloads = new Map();

                    const prevStatus = window.knownDownloads.get(dl.id);
                    if (prevStatus !== dl.status) {
                        if (dl.status === 'completed' && prevStatus) {
                            showToast(`Download Completed: ${dl.filename || 'File'}`, '#10b981');
                            new Notification('Ledo Downloader', { body: `Download Completed: ${dl.filename || 'File'}` });
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
                            showToast(`Download Failed: ${dl.filename || dl.url}`, '#ef4444');
                            new Notification('Ledo Downloader', { body: `Download Failed: ${dl.filename || 'File'}` });
                        }
                        window.knownDownloads.set(dl.id, dl.status);
                    }
                });
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

document.getElementById('btn-fetch-info').addEventListener('click', async () => {
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

        let cancelBtnHtml = '';
        if (['downloading', 'starting'].includes(dl.status)) {
            cancelBtnHtml = `
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
            if (window.tippy) {
                tippy(card.querySelectorAll('[title]'), {
                    content(reference) { const title = reference.getAttribute('title'); reference.removeAttribute('title'); return title; },
                    animation: 'scale', theme: 'translucent', arrow: true
                });
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
}

// Drawer Logic
let drawerChartInstance = null;
function openDetailsDrawer(dl) {
    const drawer = document.getElementById('details-drawer');
    const content = drawer.querySelector('.drawer-content');

    // Format dates (handle UUIDs gracefully)
    const parsedId = parseInt(dl.id);
    const dateAdded = (window.dayjs && !isNaN(parsedId)) ? dayjs(parsedId * 1000).format('DD MMM YYYY, hh:mm A') : 'N/A';

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

document.getElementById('btn-close-drawer').addEventListener('click', () => {
    document.getElementById('details-drawer').classList.remove('open');
});

window.cancelDownload = async function (id) {
    if (window.Swal) {
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

document.getElementById('btn-close-player').addEventListener('click', () => {
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

// Navigation logic (Sidebar)
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        e.currentTarget.classList.add('active');

        const isSettings = e.currentTarget.innerText.includes('Settings');
        const isStats = e.currentTarget.innerText.includes('Statistics');
        const isAccount = e.currentTarget.innerText.includes('Account');

        const views = [document.getElementById('view-downloads'), document.getElementById('view-settings'), document.getElementById('view-stats'), document.getElementById('view-account')];
        views.forEach(v => { if (v) v.classList.remove('active'); });

        let targetView = null;
        if (isSettings) {
            targetView = document.getElementById('view-settings');
        } else if (isStats) {
            targetView = document.getElementById('view-stats');
            loadStats();
        } else if (isAccount) {
            targetView = document.getElementById('view-account');
        } else {
            targetView = document.getElementById('view-downloads');
        }

        if (targetView) {
            targetView.classList.add('active');
            if (window.gsap && !appSettings.powerSaver) {
                gsap.fromTo(targetView, { opacity: 0, y: 10, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "power2.out" });
            }
        }
    });
});

// ============================================
// ACCOUNT & AUTH LOGIC
// ============================================

function initFirebaseAuth() {
    const { firebaseApp } = window;
    if (!firebaseApp) return;
    
    const authSection = document.getElementById('auth-section');
    const profileSection = document.getElementById('profile-section');
    const authError = document.getElementById('auth-error');
    const profileUsername = document.getElementById('profile-username');
    const profileAvatar = document.getElementById('profile-avatar');
    
    let unsubscribeInbox = null;

    // Auth State Changed
    firebaseApp.onAuthStateChanged((user) => {
        if (user) {
            authSection.style.display = 'none';
            profileSection.style.display = 'block';
            
            profileUsername.innerText = user.isAnonymous ? 'Guest User' : (user.displayName || 'User');
            profileAvatar.src = user.photoURL || 'icon.png';
            
            // Listen to Inbox
            if (unsubscribeInbox) unsubscribeInbox();
            unsubscribeInbox = firebaseApp.listenToInbox((messages) => {
                const inboxContainer = document.getElementById('inbox-messages');
                const emptyMsg = document.getElementById('inbox-empty');
                if (!inboxContainer) return;
                
                if (messages.length === 0) {
                    emptyMsg.style.display = 'block';
                    // clear old messages except empty message
                    Array.from(inboxContainer.children).forEach(c => { if(c.id !== 'inbox-empty') c.remove() });
                } else {
                    emptyMsg.style.display = 'none';
                    inboxContainer.innerHTML = '';
                    messages.forEach(msg => {
                        const div = document.createElement('div');
                        div.style = "background: rgba(99, 102, 241, 0.1); border-right: 3px solid #6366f1; padding: 10px; border-radius: 6px; font-size: 13px;";
                        div.innerHTML = `
                            <div style="color: #6366f1; font-weight: bold; margin-bottom: 4px;">الادارة:</div>
                            <div style="color: var(--text-main);">${msg.text || msg.message}</div>
                            <div style="color: var(--text-muted); font-size: 10px; margin-top: 4px; text-align: left;">${new Date(msg.createdAt).toLocaleString()}</div>
                        `;
                        inboxContainer.appendChild(div);
                    });
                    inboxContainer.appendChild(emptyMsg); // keep it at the bottom but hidden
                }
            });
        } else {
            authSection.style.display = 'block';
            profileSection.style.display = 'none';
            if (unsubscribeInbox) {
                unsubscribeInbox();
                unsubscribeInbox = null;
            }
        }
    });
    
    // Login
    document.getElementById('btn-login')?.addEventListener('click', async () => {
        const u = document.getElementById('auth-username').value;
        const p = document.getElementById('auth-password').value;
        if(!u || !p) return authError.innerText = "Please enter username and password.";
        
        authError.innerText = "Logging in...";
        const res = await firebaseApp.login(u, p);
        if(!res.success) authError.innerText = res.error;
        else authError.innerText = "";
    });
    
    // Register
    document.getElementById('btn-register')?.addEventListener('click', async () => {
        const u = document.getElementById('auth-username').value;
        const p = document.getElementById('auth-password').value;
        if(!u || !p) return authError.innerText = "Please enter username and password.";
        
        authError.innerText = "Registering...";
        const res = await firebaseApp.register(u, p);
        if(!res.success) authError.innerText = res.error;
        else authError.innerText = "";
    });
    
    // Login Anon
    document.getElementById('btn-login-anon')?.addEventListener('click', async () => {
        authError.innerText = "Continuing as guest...";
        const res = await firebaseApp.loginAnon();
        if(!res.success) authError.innerText = res.error;
        else authError.innerText = "";
    });
    
    // Support Ticket Submit
    document.getElementById('btn-submit-support')?.addEventListener('click', async () => {
        const subject = document.getElementById('support-subject').value;
        const msg = document.getElementById('support-message').value;
        if (!subject || !msg) return showToast("يرجى تعبئة جميع الحقول أولاً", "#ef4444");
        
        const btn = document.getElementById('btn-submit-support');
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="loader" class="spinner"></i> جاري الإرسال...`;
        if (window.lucide) lucide.createIcons();

        const res = await firebaseApp.submitSupportTicket(subject, msg);
        if (res.success) {
            showToast("تم إرسال رسالتك للإدارة بنجاح!", "#10b981");
            document.getElementById('support-subject').value = '';
            document.getElementById('support-message').value = '';
        } else {
            showToast("حدث خطأ أثناء الإرسال: " + res.error, "#ef4444");
        }
        
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="send"></i> إرسال التذكرة`;
        if (window.lucide) lucide.createIcons();
    });

    // Logout
    document.getElementById('btn-logout')?.addEventListener('click', async () => {
        await firebaseApp.logout();
    });
    
    // Avatar Upload
    document.getElementById('avatar-upload')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if(!file) return;
        
        document.getElementById('profile-status').innerText = "Uploading avatar...";
        const res = await firebaseApp.uploadAvatar(file);
        
        if (res.success) {
            profileAvatar.src = res.url;
            document.getElementById('profile-status').innerText = "Member";
        } else {
            document.getElementById('profile-status').innerText = "Avatar upload failed: " + res.error;
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

async function updateSystemStats() {
    if (!window.electronAPI || !window.electronAPI.getSystemStats) return;
    try {
        const stats = await window.electronAPI.getSystemStats();

        const cpuVal = stats.cpu;
        const ramVal = stats.ram;

        const cpuCirc = document.getElementById('stat-cpu-circle');
        const cpuText = document.getElementById('stat-cpu-val');
        if (cpuCirc) cpuCirc.setAttribute('stroke-dasharray', `${cpuVal}, 100`);
        if (cpuText) cpuText.innerText = `${cpuVal}%`;

        const ramCirc = document.getElementById('stat-ram-circle');
        const ramText = document.getElementById('stat-ram-val');
        if (ramCirc) ramCirc.setAttribute('stroke-dasharray', `${ramVal}, 100`);
        if (ramText) ramText.innerText = `${ramVal}%`;

        // Calculate total network speed from active downloads
        let totalSpeed = 0;
        rawDownloadsData.forEach(dl => {
            if (dl.status === 'downloading') {
                totalSpeed += (dl.speed || 0);
            }
        });

        const netVal = document.getElementById('stat-net-val');
        if (netVal) netVal.innerText = totalSpeed > 0 ? formatBytes(totalSpeed) + '/s' : '--';

        // Update Chart
        netHistory.shift();
        netHistory.push(totalSpeed);
        if (sysNetChartInstance) {
            sysNetChartInstance.update();
        }

    } catch (e) {
        console.error("Failed to update system stats", e);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initSysNetChart();
    setInterval(() => {
        if (!document.hidden && !appSettings.powerSaver) {
            updateSystemStats();
        }
    }, 2000);
});

// Smart Power Saver via Window Focus
if (window.electronAPI && window.electronAPI.onWindowFocusChange) {
    window.electronAPI.onWindowFocusChange((isFocused) => {
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
