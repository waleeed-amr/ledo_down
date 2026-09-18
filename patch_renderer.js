const fs = require('fs');
let content = fs.readFileSync('frontend/renderer.js', 'utf-8');

const oldRender = `function renderDownloads(downloads) {
    const listEl = document.getElementById('downloads-list');

    // Remove cards that are no longer in the payload
    const currentIds = downloads.map(dl => \`dl-card-\${dl.id}\`);
    Array.from(listEl.children).forEach(child => {
        if (!currentIds.includes(child.id)) {
            child.remove();
        }
    });

    downloads.forEach(dl => {
        let card = document.getElementById(\`dl-card-\${dl.id}\`);

        const speed = dl.speed ? formatBytes(dl.speed) + '/s' : '--';
        const size = dl.total_size ? formatBytes(dl.total_size) : 'Unknown';
        const name = dl.filename || dl.url;

        let errorHtml = '';
        if (dl.status === 'error' && dl.error_message) {
            errorHtml = \`
                <div style="color: #ef4444; font-size: 13px; margin-top: 10px; background: rgba(239, 68, 68, 0.1); padding: 8px; border-radius: 6px;">
                    \${dl.error_message}
                </div>
            \`;
        }

        let actionBtnHtml = '';
        if (['downloading', 'starting'].includes(dl.status)) {
            actionBtnHtml = \`
                <button class="btn-action" onclick="pauseDownload('\${dl.id}')" title="Pause Download" style="background: none; border: none; color: #f59e0b; cursor: pointer; padding: 4px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
                </button>
                <button class="btn-cancel-dl" onclick="cancelDownload('\${dl.id}')" title="Cancel Download">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            \`;
        } else if (dl.status === 'paused') {
            actionBtnHtml = \`
                <button class="btn-action" onclick="resumeDownload('\${dl.id}')" title="Resume Download" style="background: none; border: none; color: #10b981; cursor: pointer; padding: 4px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </button>
                <button class="btn-cancel-dl" onclick="cancelDownload('\${dl.id}')" title="Cancel Download">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            \`;
        } else if (dl.status === 'error') {
            actionBtnHtml = \`
                <button class="btn-action" onclick="retryDownload('\${dl.id}')" title="Retry Download" style="background: none; border: none; color: #3b82f6; cursor: pointer; padding: 4px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                </button>
                <button class="btn-cancel-dl" onclick="cancelDownload('\${dl.id}')" title="Cancel Download">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            \`;
        }

        let playBtnHtml = '';

        const innerHTML = \`
            <div class="dl-header" style="cursor: grab;">
                <div title="Drag to reorder" style="color: var(--text-muted); display: flex; align-items: center; margin-right: 8px;">
                    <i data-lucide="grip-vertical" style="width: 16px; height: 16px;"></i>
                </div>
                <div class="dl-title" title="\${name}">\${name}</div>
                <div class="dl-actions">
                    \${playBtnHtml}
                    \${actionBtnHtml}
                </div>
            </div>
            <div class="dl-stats">
                <span style="color: var(--text-primary);">\${dl.status.toUpperCase()}</span>
                <span>\${speed}</span>
                <span>\${size}</span>
            </div>
            <div class="progress-bar-container">
                <div class="progress-bar-fill \${dl.status === 'paused' ? 'paused' : dl.status === 'error' ? 'error' : ''}" 
                     style="width: \${dl.progress}%;"></div>
            </div>
            \${errorHtml}
        \`;

        if (!card) {
            card = document.createElement('div');
            card.id = \`dl-card-\${dl.id}\`;
            card.className = 'download-card glass-panel glass-interactive fade-in';
            card.draggable = true;
            card.setAttribute('data-id', dl.id);
            card.innerHTML = innerHTML;
            listEl.appendChild(card);
            
            // Re-render lucide icons for this new card
            if (window.lucide) {
                lucide.createIcons({ root: card });
            }
        } else {
            // Update existing card
            card.innerHTML = innerHTML;
            // Only re-render icons if HTML changes, which it does here on every tick.
            // This is slightly inefficient but ensures play icons show up.
            if (window.lucide) {
                lucide.createIcons({ root: card });
            }
        }
    });

    initDragAndDrop();
}`;

const newRender = `function renderDownloads(downloads) {
    const listEl = document.getElementById('downloads-list');

    // Remove cards that are no longer in the payload
    const currentIds = downloads.map(dl => \`dl-card-\${dl.id}\`);
    Array.from(listEl.children).forEach(child => {
        if (!currentIds.includes(child.id)) {
            child.remove();
        }
    });

    downloads.forEach(dl => {
        let card = document.getElementById(\`dl-card-\${dl.id}\`);

        const speed = dl.speed ? formatBytes(dl.speed) + '/s' : '--';
        const size = dl.total_size ? formatBytes(dl.total_size) : 'Unknown';
        const name = dl.filename || dl.url;

        let errorHtml = '';
        if (dl.status === 'error' && dl.error_message) {
            errorHtml = \`
                <div id="error-\${dl.id}" style="color: #ef4444; font-size: 13px; margin-top: 10px; background: rgba(239, 68, 68, 0.1); padding: 8px; border-radius: 6px;">
                    \${dl.error_message}
                </div>
            \`;
        }

        let actionBtnHtml = '';
        if (['downloading', 'starting'].includes(dl.status)) {
            actionBtnHtml = \`
                <button class="btn-action" onclick="pauseDownload('\${dl.id}')" title="Pause Download" style="background: none; border: none; color: #f59e0b; cursor: pointer; padding: 4px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
                </button>
                <button class="btn-cancel-dl" onclick="cancelDownload('\${dl.id}')" title="Cancel Download">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            \`;
        } else if (dl.status === 'paused') {
            actionBtnHtml = \`
                <button class="btn-action" onclick="resumeDownload('\${dl.id}')" title="Resume Download" style="background: none; border: none; color: #10b981; cursor: pointer; padding: 4px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </button>
                <button class="btn-cancel-dl" onclick="cancelDownload('\${dl.id}')" title="Cancel Download">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            \`;
        } else if (dl.status === 'error') {
            actionBtnHtml = \`
                <button class="btn-action" onclick="retryDownload('\${dl.id}')" title="Retry Download" style="background: none; border: none; color: #3b82f6; cursor: pointer; padding: 4px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                </button>
                <button class="btn-cancel-dl" onclick="cancelDownload('\${dl.id}')" title="Cancel Download">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            \`;
        }

        let playBtnHtml = '';

        if (!card) {
            const innerHTML = \`
                <div class="dl-header" style="cursor: grab;">
                    <div title="Drag to reorder" style="color: var(--text-muted); display: flex; align-items: center; margin-right: 8px;">
                        <i data-lucide="grip-vertical" style="width: 16px; height: 16px;"></i>
                    </div>
                    <div class="dl-title" id="title-\${dl.id}" title="\${name}">\${name}</div>
                    <div class="dl-actions" id="actions-\${dl.id}" data-status="\${dl.status}">
                        \${playBtnHtml}
                        \${actionBtnHtml}
                    </div>
                </div>
                <div class="dl-stats">
                    <span id="status-\${dl.id}" style="color: var(--text-primary);">\${dl.status.toUpperCase()}</span>
                    <span id="speed-\${dl.id}">\${speed}</span>
                    <span id="size-\${dl.id}">\${size}</span>
                </div>
                <div class="progress-bar-container">
                    <div id="prog-\${dl.id}" class="progress-bar-fill \${dl.status === 'paused' ? 'paused' : dl.status === 'error' ? 'error' : ''}" 
                         style="width: \${dl.progress}%; transition: width 0.1s linear;"></div>
                </div>
                <div id="error-container-\${dl.id}">\${errorHtml}</div>
            \`;
            
            card = document.createElement('div');
            card.id = \`dl-card-\${dl.id}\`;
            card.className = 'download-card glass-panel glass-interactive fade-in';
            card.draggable = true;
            card.setAttribute('data-id', dl.id);
            card.innerHTML = innerHTML;
            listEl.appendChild(card);
            
            if (window.lucide) {
                lucide.createIcons({ root: card });
            }
        } else {
            // HIGH-PERFORMANCE DOM DIFFING
            
            // Only update nodes if values changed
            const titleEl = document.getElementById(\`title-\${dl.id}\`);
            if (titleEl && titleEl.textContent !== name) {
                titleEl.textContent = name;
                titleEl.title = name;
            }
            
            const speedEl = document.getElementById(\`speed-\${dl.id}\`);
            if (speedEl && speedEl.textContent !== speed) speedEl.textContent = speed;
            
            const sizeEl = document.getElementById(\`size-\${dl.id}\`);
            if (sizeEl && sizeEl.textContent !== size) sizeEl.textContent = size;
            
            const statusEl = document.getElementById(\`status-\${dl.id}\`);
            if (statusEl) statusEl.textContent = dl.status.toUpperCase();
            
            const progEl = document.getElementById(\`prog-\${dl.id}\`);
            if (progEl) {
                progEl.style.width = \`\${dl.progress}%\`;
                progEl.className = \`progress-bar-fill \${dl.status === 'paused' ? 'paused' : dl.status === 'error' ? 'error' : ''}\`;
            }
            
            const actionsEl = document.getElementById(\`actions-\${dl.id}\`);
            if (actionsEl && actionsEl.getAttribute('data-status') !== dl.status) {
                actionsEl.innerHTML = playBtnHtml + actionBtnHtml;
                actionsEl.setAttribute('data-status', dl.status);
                if (window.lucide) lucide.createIcons({ root: actionsEl });
            }
            
            const errCont = document.getElementById(\`error-container-\${dl.id}\`);
            if (errCont && dl.status === 'error' && dl.error_message) {
                const errDiv = document.getElementById(\`error-\${dl.id}\`);
                if (!errDiv || errDiv.textContent.trim() !== dl.error_message) {
                    errCont.innerHTML = errorHtml;
                }
            } else if (errCont) {
                errCont.innerHTML = '';
            }
        }
    });

    initDragAndDrop();
}`;
content = content.replace(oldRender, newRender);
fs.writeFileSync('frontend/renderer.js', content, 'utf-8');
console.log('renderer.js updated successfully!');
