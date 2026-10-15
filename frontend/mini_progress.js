const { ipcRenderer } = require('electron');
const path = require('path');
const os = require('os');

const WS_URL = 'ws://127.0.0.1:8000/ws';
const API_URL = 'http://127.0.0.1:8000/api';

let ws;
let hideTimeout = null;
let wsReconnectTimer = null;
let fallbackPollTimer = null;
let wsUpdateVersion = 0;
let snapshotRequest = 0;
let isVisible = false;
let isCollapsed = false;
let isHovered = false;
let manuallyClosed = false;
let closedDownloadIds = new Set();
let latestDownloads = [];

// DOM Elements
const miniCard = document.getElementById('mini-card');
const miniPill = document.getElementById('mini-pill');
const downloadsContainer = document.getElementById('downloads-container');
const headerTitle = document.getElementById('header-title');
const totalSpeedBadge = document.getElementById('total-speed-badge');
const statusPulse = document.getElementById('status-pulse');
const completionBanner = document.getElementById('completion-banner');
const pillText = document.getElementById('pill-text');
const pillSpeed = document.getElementById('pill-speed');

const btnClose = document.getElementById('btn-close');
const btnCollapse = document.getElementById('btn-collapse');
const btnPillExpand = document.getElementById('btn-pill-expand');
const btnOpenApp = document.getElementById('btn-open-app');
const btnOpenDefaultFolder = document.getElementById('btn-open-default-folder');
const btnBulkToggle = document.getElementById('btn-bulk-toggle');

function formatSpeed(bytesPerSec) {
    if (!+bytesPerSec || bytesPerSec <= 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
    return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatSize(bytes) {
    if (!+bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function calculateETA(downloaded, total, speed) {
    if (!speed || speed <= 0 || !total || total <= downloaded) return '--';
    const remainingBytes = total - downloaded;
    const seconds = Math.ceil(remainingBytes / speed);
    if (seconds < 60) return `${seconds}s left`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return `${mins}m ${secs}s`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
}

function getFileExt(filename) {
    if (!filename) return 'FILE';
    const ext = path.extname(filename).replace('.', '').toUpperCase();
    return ext ? ext.substring(0, 4) : 'FILE';
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

function getStatusLabel(download) {
    if (download.status === 'preparing') return 'Preparing…';
    if (download.status === 'resolving') return 'جاري البحث عن بيانات الأغنية…';
    if (download.status === 'starting') {
        return download.queue_position
            ? `Queued ${download.queue_position}/${download.queue_total}`
            : 'Starting';
    }
    if (download.status === 'processing') return 'Finishing';
    return download.status.charAt(0).toUpperCase() + download.status.slice(1);
}

let miniWsReconnectDelay = 2500;

async function syncDownloadsFromApi() {
    const requestId = ++snapshotRequest;
    const versionAtStart = wsUpdateVersion;
    try {
        const response = await fetch(`${API_URL}/downloads`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const downloads = await response.json();
        // A live WebSocket update is newer than a snapshot request that was
        // already in flight, so never let that older response roll the UI back.
        if (requestId === snapshotRequest && versionAtStart === wsUpdateVersion && Array.isArray(downloads)) {
            handleDownloadsUpdate(downloads);
        }
        return true;
    } catch (_) {
        return false;
    }
}

function startFallbackPolling() {
    if (fallbackPollTimer) return;
    statusPulse.classList.add('offline');
    statusPulse.title = 'Live connection lost; syncing with the app';
    fallbackPollTimer = setInterval(syncDownloadsFromApi, 5000);
    syncDownloadsFromApi();
}

function stopFallbackPolling() {
    if (!fallbackPollTimer) return;
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = null;
}

function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    try {
        ws = new WebSocket(WS_URL);
        
        ws.onopen = function() {
            miniWsReconnectDelay = 2500;
            stopFallbackPolling();
            statusPulse.classList.remove('offline');
            statusPulse.title = 'Connected to Ledo';
            syncDownloadsFromApi();
        };

        ws.onmessage = function(event) {
            try {
                const payload = JSON.parse(event.data);
                if (payload.type === 'downloads') {
                    wsUpdateVersion += 1;
                    handleDownloadsUpdate(payload.downloads || []);
                }
            } catch (e) {}
        };
        
        ws.onclose = function() {
            ws = null;
            startFallbackPolling();
            clearTimeout(wsReconnectTimer);
            wsReconnectTimer = setTimeout(() => {
                wsReconnectTimer = null;
                connectWebSocket();
            }, miniWsReconnectDelay);
            miniWsReconnectDelay = Math.min(miniWsReconnectDelay * 2, 60000);
        };
        
        ws.onerror = function() {
            try { ws.close(); } catch(e){}
        };
    } catch(e) {
        ws = null;
        startFallbackPolling();
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(() => {
            wsReconnectTimer = null;
            connectWebSocket();
        }, miniWsReconnectDelay);
        miniWsReconnectDelay = Math.min(miniWsReconnectDelay * 2, 60000);
    }
}

function handleDownloadsUpdate(allDownloads) {
    latestDownloads = allDownloads;

    // Filter active, paused, errored and recently completed downloads
    const active = allDownloads.filter(dl => ['downloading', 'starting', 'preparing', 'resolving', 'processing', 'paused', 'error'].includes(dl.status));
    const completed = allDownloads.filter(dl => dl.status === 'completed');

    if (active.length === 0) {
        manuallyClosed = false;
        closedDownloadIds.clear();
    } else if (manuallyClosed) {
        const hasNewDownload = active.some(dl => !closedDownloadIds.has(dl.id));
        if (hasNewDownload) {
            manuallyClosed = false;
            closedDownloadIds.clear();
        } else {
            return;
        }
    }

    if (active.length > 0) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
        completionBanner.style.display = 'none';

        renderDownloads(active);

        // Show window if not visible
        if (!isVisible) {
            ipcRenderer.send('mini-progress-action', 'show');
            isVisible = true;
        }
    } else {
        // No active downloads currently
        if (isVisible) {
            if (completed.length > 0) {
                // Show completion banner
                downloadsContainer.innerHTML = '';
                completionBanner.style.display = 'flex';
                statusPulse.className = 'status-pulse';
                headerTitle.innerText = 'Completed';
                totalSpeedBadge.innerText = '0 B/s';
                adjustWindowHeight(110);
            }

            // Auto-hide timer if not hovered
            if (!hideTimeout && !isHovered) {
                hideTimeout = setTimeout(() => {
                    if (!isHovered) {
                        ipcRenderer.send('mini-progress-action', 'hide');
                        isVisible = false;
                        hideTimeout = null;
                        downloadsContainer.innerHTML = '';
                        completionBanner.style.display = 'none';
                    }
                }, 4000);
            }
        }
    }
}

function renderDownloads(downloads) {
    let totalSpeed = 0;
    let totalDownloaded = 0;
    let totalKnownSize = 0;
    let allSizesKnown = downloads.length > 0;
    
    // Remove stale items
    const currentIds = downloads.map(dl => `mini-dl-${dl.id}`);
    Array.from(downloadsContainer.children).forEach(child => {
        if (!currentIds.includes(child.id)) {
            child.remove();
        }
    });

    downloads.forEach(dl => {
        const speed = ['downloading', 'processing'].includes(dl.status) ? (dl.speed || 0) : 0;
        totalSpeed += speed;
        const prog = Math.max(0, Math.min(100, Number(dl.progress) || 0));
        const downloaded = Math.max(0, Number(dl.downloaded) || 0);
        const totalSize = Math.max(0, Number(dl.total_size) || 0);
        totalDownloaded += totalSize > 0 ? Math.min(downloaded, totalSize) : 0;
        totalKnownSize += totalSize;
        if (totalSize <= 0) allSizesKnown = false;

        const name = dl.filename || dl.url || 'Downloading file...';
        const safeName = escapeHtml(name);
        const stateLabel = getStatusLabel(dl);
        const ext = getFileExt(dl.filename);
        const waitingForTransfer = ['preparing', 'resolving', 'starting'].includes(dl.status);
        const speedStr = waitingForTransfer ? 'Waiting…' : formatSpeed(speed);
        const sizeStr = dl.total_size ? formatSize(dl.total_size) : 'Unknown';
        const downStr = dl.status === 'preparing' ? 'Preparing source…'
            : dl.status === 'resolving' ? 'بحث معلومات الأغنية — مش تنزيل الملف'
                : dl.status === 'starting' ? 'Waiting for a download slot…'
                    : formatSize(dl.downloaded);
        const etaStr = calculateETA(dl.downloaded, dl.total_size, speed);
        const percentStr = dl.status === 'resolving'
            ? `حوالي ${Math.round(prog)}% من البحث`
            : waitingForTransfer ? '—' : `${prog.toFixed(1)}%`;
        const indeterminate = ['preparing', 'starting'].includes(dl.status)
            || (dl.status === 'resolving' && !(prog > 0));
        const isPaused = dl.status === 'paused';
        const isError = dl.status === 'error';
        
        let item = document.getElementById(`mini-dl-${dl.id}`);
        
        if (!item) {
            item = document.createElement('div');
            item.className = 'dl-item';
            item.id = `mini-dl-${dl.id}`;
            item.dataset.status = dl.status;
            item.innerHTML = `
                <div class="dl-top">
                    <div class="dl-left">
                        <span class="dl-type-badge">${ext}</span>
                        <span class="dl-name" title="${escapeHtml(dl.error_message || name)}">${safeName}</span>
                    </div>
                    <div class="dl-actions-row">
                        <span class="dl-state ${dl.status}">${escapeHtml(stateLabel)}</span>
                        ${dl.status === 'resolving' ? '' : isError ? `
                        <button type="button" class="dl-btn" onclick="retryDl('${dl.id}')" title="Retry" style="color: #ef4444;">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                        </button>
                        ` : `
                        <button type="button" class="dl-btn" onclick="togglePause('${dl.id}', ${isPaused})" title="${isPaused ? 'Resume' : 'Pause'}">
                            ${isPaused 
                                ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`
                                : `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`
                            }
                        </button>
                        `}
                        <button type="button" class="dl-btn cancel-btn" onclick="cancelDl('${dl.id}')" title="Cancel">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                </div>
                <div class="progress-track${indeterminate ? ' is-indeterminate' : ''}">
                    <div class="progress-fill${indeterminate ? ' is-indeterminate' : ''}" style="width: ${indeterminate ? 32 : prog}%"></div>
                </div>
                <div class="dl-bottom">
                    <div class="dl-stats">
                        <span>${downStr}${waitingForTransfer ? '' : ` / ${sizeStr}`}</span>
                        ${waitingForTransfer ? '' : etaStr !== '--' ? `<span>• ${etaStr}</span>` : ''}
                    </div>
                    <div>
                        <span class="dl-speed-val">${speedStr}</span>
                        <span class="dl-percent-val" style="margin-left: 6px;">${percentStr}</span>
                    </div>
                </div>
            `;
            downloadsContainer.appendChild(item);
        } else {
            // In-place update
            const nameEl = item.querySelector('.dl-name');
            if (nameEl) nameEl.title = dl.error_message || name;
            if (nameEl && nameEl.textContent !== name) {
                nameEl.textContent = name;
            }
            
            const fill = item.querySelector('.progress-fill');
            if (fill) {
                fill.classList.toggle('is-indeterminate', indeterminate);
                fill.style.width = `${indeterminate ? 32 : prog}%`;
            }
            item.querySelector('.progress-track')?.classList.toggle('is-indeterminate', indeterminate);
            
            const stats = item.querySelector('.dl-stats');
            if (stats) {
                stats.innerHTML = `<span>${downStr}${waitingForTransfer ? '' : ` / ${sizeStr}`}</span>${!waitingForTransfer && etaStr !== '--' ? `<span>• ${etaStr}</span>` : ''}`;
            }
            
            const speedEl = item.querySelector('.dl-speed-val');
            if (speedEl) speedEl.textContent = speedStr;
            
            const pctEl = item.querySelector('.dl-percent-val');
            if (pctEl) pctEl.textContent = percentStr;

            const stateEl = item.querySelector('.dl-state');
            if (stateEl) {
                stateEl.className = `dl-state ${dl.status}`;
                stateEl.textContent = stateLabel;
            }
            
            if (item.dataset.status !== dl.status) {
                item.dataset.status = dl.status;
                const actionsRow = item.querySelector('.dl-actions-row');
                if (actionsRow) {
                    actionsRow.innerHTML = `
                        <span class="dl-state ${dl.status}">${escapeHtml(stateLabel)}</span>
                        ${isError ? `
                        <button type="button" class="dl-btn" onclick="retryDl('${dl.id}')" title="Retry" style="color: #ef4444;">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                        </button>
                        ` : `
                        <button type="button" class="dl-btn" onclick="togglePause('${dl.id}', ${isPaused})" title="${isPaused ? 'Resume' : 'Pause'}">
                            ${isPaused 
                                ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`
                                : `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`
                            }
                        </button>
                        `}
                        <button type="button" class="dl-btn cancel-btn" onclick="cancelDl('${dl.id}')" title="Cancel">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    `;
                }
            }
        }
    });

    // Header info
    const queuedCount = downloads.filter(dl => dl.status === 'starting').length;
    headerTitle.innerText = downloads.length === 1 ? '1 Download' : `${downloads.length} Downloads`;
    if (queuedCount) headerTitle.innerText += ` · ${queuedCount} queued`;
    totalSpeedBadge.innerText = formatSpeed(totalSpeed);
    const hasRunning = downloads.some(dl => ['downloading', 'starting', 'preparing', 'processing'].includes(dl.status));
    btnBulkToggle.textContent = hasRunning ? 'Pause all' : 'Resume all';
    btnBulkToggle.title = hasRunning ? 'Pause all active downloads' : 'Resume all paused downloads';
    btnBulkToggle.disabled = !downloads.some(dl => ['downloading', 'starting', 'preparing', 'processing', 'paused'].includes(dl.status));

    // Use byte-weighted progress so large downloads count proportionally.
    const transferring = downloads.filter(dl => ['downloading', 'processing'].includes(dl.status));
    const weightedProgress = allSizesKnown && totalKnownSize > 0
        ? Math.min(100, (totalDownloaded / totalKnownSize) * 100)
        : (transferring.length ? transferring.reduce((sum, dl) => sum + (Number(dl.progress) || 0), 0) / transferring.length : 0);
    pillText.innerText = `${weightedProgress.toFixed(0)}%`;
    pillSpeed.innerText = formatSpeed(totalSpeed);

    // Auto-adjust window height
    if (!isCollapsed) {
        const itemHeight = 68;
        const headerHeight = 44;
        const padding = 20;
        const targetHeight = Math.min(380, headerHeight + (downloads.length * itemHeight) + padding);
        adjustWindowHeight(targetHeight);
    }
}

function adjustWindowHeight(targetHeight) {
    ipcRenderer.send('mini-progress-resize', targetHeight);
}

btnBulkToggle.addEventListener('click', async () => {
    const canPause = latestDownloads.some(dl => ['downloading', 'starting', 'preparing', 'processing'].includes(dl.status));
    const targets = latestDownloads.filter(dl => canPause
        ? ['downloading', 'starting', 'preparing', 'processing'].includes(dl.status)
        : dl.status === 'paused');
    if (!targets.length) return;

    btnBulkToggle.disabled = true;
    try {
        const results = await Promise.allSettled(targets.map(dl => sendDownloadAction(
            canPause ? 'pause' : 'resume', dl.id, false
        )));
        if (results.some(result => result.status === 'fulfilled')) await syncDownloadsFromApi();
        if (results.some(result => result.status === 'rejected')) {
            btnBulkToggle.title = 'Some downloads could not be updated';
        } else {
            btnBulkToggle.title = canPause ? 'Pause all active downloads' : 'Resume all paused downloads';
        }
    } finally {
        btnBulkToggle.disabled = false;
    }
});

async function sendDownloadAction(action, downloadId, syncAfter = true) {
    // The backend exposes retry as resume for failed records.
    const endpointAction = action === 'retry' ? 'resume' : action;
    const response = await fetch(`${API_URL}/${endpointAction}/${encodeURIComponent(downloadId)}`, {
        method: endpointAction === 'cancel' ? 'DELETE' : 'POST'
    });
    if (!response.ok) throw new Error(`Download action failed (${response.status})`);
    const result = await response.json().catch(() => ({}));
    const successfulStatuses = {
        pause: ['pausing'],
        resume: ['resumed', 'already_running'],
        retry: ['resumed', 'already_running'],
        cancel: ['canceled']
    };
    if (result.status && !successfulStatuses[action]?.includes(result.status)) {
        throw new Error(result.message || `Download action failed (${result.status})`);
    }
    if (syncAfter) await syncDownloadsFromApi();
    return true;
}

// Window actions
window.togglePause = async function(downloadId, isPaused) {
    try {
        await sendDownloadAction(isPaused ? 'resume' : 'pause', downloadId);
    } catch(e) {}
};

window.retryDl = async function(downloadId) {
    try {
        await sendDownloadAction('retry', downloadId);
    } catch(e) {}
};

window.cancelDl = async function(downloadId) {
    try {
        await sendDownloadAction('cancel', downloadId);
    } catch(e) {}
};

btnOpenApp.addEventListener('click', () => {
    ipcRenderer.send('show-main-window');
});

btnCollapse.addEventListener('click', () => {
    isCollapsed = true;
    miniCard.style.display = 'none';
    miniPill.style.display = 'flex';
    adjustWindowHeight(52);
});

btnPillExpand.addEventListener('click', (e) => {
    e.stopPropagation();
    isCollapsed = false;
    miniPill.style.display = 'none';
    miniCard.style.display = 'flex';
    handleDownloadsUpdate(latestDownloads);
});

miniPill.addEventListener('click', () => {
    isCollapsed = false;
    miniPill.style.display = 'none';
    miniCard.style.display = 'flex';
    handleDownloadsUpdate(latestDownloads);
});

btnClose.addEventListener('click', () => {
    ipcRenderer.send('mini-progress-action', 'hide');
    isVisible = false;
    manuallyClosed = true;
    closedDownloadIds.clear();
    const active = latestDownloads.filter(dl => ['downloading', 'starting', 'preparing', 'resolving', 'processing', 'paused', 'error'].includes(dl.status));
    active.forEach(dl => closedDownloadIds.add(dl.id));
});

btnOpenDefaultFolder.addEventListener('click', async () => {
    const defaultDownloads = path.join(os.homedir(), 'Downloads', 'Ledo Downloader');
    await ipcRenderer.invoke('open-path', defaultDownloads);
});

// Hover handlers to prevent auto-hide when user is interacting
document.body.addEventListener('mouseenter', () => {
    isHovered = true;
    if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
    }
});

document.body.addEventListener('mouseleave', () => {
    isHovered = false;
    if (isVisible && latestDownloads.filter(dl => ['downloading', 'starting', 'preparing', 'resolving'].includes(dl.status)).length === 0) {
        hideTimeout = setTimeout(() => {
            if (!isHovered) {
                ipcRenderer.send('mini-progress-action', 'hide');
                isVisible = false;
                hideTimeout = null;
            }
        }, 3000);
    }
});

// Initialize WebSocket connection
connectWebSocket();
