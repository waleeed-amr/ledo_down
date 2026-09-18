const { ipcRenderer } = require('electron');
const path = require('path');
const os = require('os');

const WS_URL = 'ws://127.0.0.1:8000/ws';
const API_URL = 'http://127.0.0.1:8000/api';

let ws;
let hideTimeout = null;
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

function connectWebSocket() {
    try {
        ws = new WebSocket(WS_URL);
        
        ws.onmessage = function(event) {
            try {
                const payload = JSON.parse(event.data);
                if (payload.type === 'downloads') {
                    handleDownloadsUpdate(payload.downloads || []);
                }
            } catch (e) {}
        };
        
        ws.onclose = function() {
            setTimeout(connectWebSocket, 2500);
        };
        
        ws.onerror = function() {
            try { ws.close(); } catch(e){}
        };
    } catch(e) {
        setTimeout(connectWebSocket, 2500);
    }
}

function handleDownloadsUpdate(allDownloads) {
    latestDownloads = allDownloads;

    // Filter active, paused, errored and recently completed downloads
    const active = allDownloads.filter(dl => ['downloading', 'starting', 'processing', 'paused', 'error'].includes(dl.status));
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
    let totalProgressSum = 0;
    
    // Remove stale items
    const currentIds = downloads.map(dl => `mini-dl-${dl.id}`);
    Array.from(downloadsContainer.children).forEach(child => {
        if (!currentIds.includes(child.id)) {
            child.remove();
        }
    });

    downloads.forEach(dl => {
        const speed = dl.speed || 0;
        totalSpeed += speed;
        const prog = dl.progress || 0;
        totalProgressSum += prog;

        const name = dl.filename || dl.url || 'Downloading file...';
        const ext = getFileExt(dl.filename);
        const speedStr = formatSpeed(speed);
        const sizeStr = dl.total_size ? formatSize(dl.total_size) : 'Unknown';
        const downStr = formatSize(dl.downloaded);
        const etaStr = calculateETA(dl.downloaded, dl.total_size, speed);
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
                        <span class="dl-name" title="${name.replace(/"/g, '&quot;')}">${name}</span>
                    </div>
                    <div class="dl-actions-row">
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
                    </div>
                </div>
                <div class="progress-track">
                    <div class="progress-fill" style="width: ${prog}%"></div>
                </div>
                <div class="dl-bottom">
                    <div class="dl-stats">
                        <span>${downStr} / ${sizeStr}</span>
                        ${etaStr !== '--' ? `<span>• ${etaStr}</span>` : ''}
                    </div>
                    <div>
                        <span class="dl-speed-val">${speedStr}</span>
                        <span class="dl-percent-val" style="margin-left: 6px;">${prog.toFixed(1)}%</span>
                    </div>
                </div>
            `;
            downloadsContainer.appendChild(item);
        } else {
            // In-place update
            const nameEl = item.querySelector('.dl-name');
            if (nameEl && nameEl.textContent !== name) {
                nameEl.textContent = name;
                nameEl.title = name;
            }
            
            const fill = item.querySelector('.progress-fill');
            if (fill) fill.style.width = `${prog}%`;
            
            const stats = item.querySelector('.dl-stats');
            if (stats) {
                stats.innerHTML = `<span>${downStr} / ${sizeStr}</span>${etaStr !== '--' ? `<span>• ${etaStr}</span>` : ''}`;
            }
            
            const speedEl = item.querySelector('.dl-speed-val');
            if (speedEl) speedEl.textContent = speedStr;
            
            const pctEl = item.querySelector('.dl-percent-val');
            if (pctEl) pctEl.textContent = `${prog.toFixed(1)}%`;
            
            if (item.dataset.status !== dl.status) {
                item.dataset.status = dl.status;
                const actionsRow = item.querySelector('.dl-actions-row');
                if (actionsRow) {
                    actionsRow.innerHTML = `
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
    headerTitle.innerText = downloads.length === 1 ? '1 Download' : `${downloads.length} Downloads`;
    totalSpeedBadge.innerText = formatSpeed(totalSpeed);

    // Update mini pill view
    const avgProg = downloads.length > 0 ? (totalProgressSum / downloads.length).toFixed(0) : 0;
    pillText.innerText = `${avgProg}%`;
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

// Window actions
window.togglePause = async function(downloadId, isPaused) {
    try {
        if (isPaused) {
            await fetch(`${API_URL}/resume/${downloadId}`, { method: 'POST' }).catch(() => {});
        } else {
            await fetch(`${API_URL}/pause/${downloadId}`, { method: 'POST' }).catch(() => {});
        }
    } catch(e) {}
};

window.retryDl = async function(downloadId) {
    try {
        await fetch(`${API_URL}/retry/${downloadId}`, { method: 'POST' }).catch(() => {});
    } catch(e) {}
};

window.cancelDl = async function(downloadId) {
    try {
        await fetch(`${API_URL}/cancel/${downloadId}`, { method: 'DELETE' }).catch(() => {});
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
    const active = latestDownloads.filter(dl => ['downloading', 'starting', 'processing', 'paused', 'error'].includes(dl.status));
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
    if (isVisible && latestDownloads.filter(dl => ['downloading', 'starting'].includes(dl.status)).length === 0) {
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
