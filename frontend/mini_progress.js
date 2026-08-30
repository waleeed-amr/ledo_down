const { ipcRenderer } = require('electron');

const WS_URL = 'ws://127.0.0.1:8000/ws';
let ws;
let hideTimeout = null;
let isVisible = false;

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}/s`;
}

function formatSize(bytes) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function connectWebSocket() {
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
        setTimeout(connectWebSocket, 2000);
    };
}

let manuallyClosed = false;

function handleDownloadsUpdate(allDownloads) {
    if (manuallyClosed) return;

    // Filter active ones
    const active = allDownloads.filter(dl => dl.status === 'downloading' || dl.status === 'starting');
    
    if (active.length > 0) {
        renderDownloads(active);
        
        // Show window if not visible
        if (!isVisible) {
            clearTimeout(hideTimeout);
            ipcRenderer.send('mini-progress-action', 'show');
            isVisible = true;
        }
    } else {
        // If it was visible, hide it after a short delay so user can see it finished
        if (isVisible) {
            if (!hideTimeout) {
                hideTimeout = setTimeout(() => {
                    ipcRenderer.send('mini-progress-action', 'hide');
                    isVisible = false;
                    hideTimeout = null;
                    document.getElementById('mini-downloads-list').innerHTML = ''; // Clear
                }, 3000); // Wait 3 seconds before hiding
            }
        }
    }
}

function renderDownloads(downloads) {
    const list = document.getElementById('mini-downloads-list');
    
    let html = '';
    downloads.forEach(dl => {
        const name = dl.filename || dl.url || 'Downloading...';
        const speedStr = dl.speed ? formatBytes(dl.speed) : '--';
        const sizeStr = dl.total_size ? formatSize(dl.total_size) : 'Unknown';
        const downStr = formatSize(dl.downloaded);
        const prog = dl.progress || 0;
        
        html += `
            <div class="dl-item">
                <div class="dl-top">
                    <span class="dl-name" title="${name}">${name}</span>
                    <span class="dl-speed">${speedStr}</span>
                </div>
                <div class="progress-bg">
                    <div class="progress-fill" style="width: ${prog}%"></div>
                </div>
                <div class="dl-bottom">
                    <span>${downStr} / ${sizeStr}</span>
                    <span>${prog.toFixed(1)}%</span>
                </div>
            </div>
        `;
    });
    
    list.innerHTML = html;
    
    // Auto-resize window height based on items (min 100, max 350)
    const itemHeight = 60;
    const headerHeight = 35;
    const padding = 45;
    let targetHeight = headerHeight + (downloads.length * itemHeight) + padding;
    if (targetHeight > 400) targetHeight = 400;
    
    ipcRenderer.send('mini-progress-resize', targetHeight);
}

document.getElementById('btn-close').addEventListener('click', () => {
    ipcRenderer.send('mini-progress-action', 'hide');
    isVisible = false;
    manuallyClosed = true;
    setTimeout(() => { manuallyClosed = false; }, 10000); // Block re-show for 10s
});

connectWebSocket();
