(function () {
    const API_BASE = 'http://127.0.0.1:8000/api';

    // ─── 1. Frontend Uncaught Error Reporting ────────────────────────────────
    function reportFrontendError(category, message, stackTrace = '', extra = null) {
        try {
            // Write directly to Firestore if available
            if (window.firebaseApp && window.firebaseApp.db) {
                window.firebaseApp.db.collection('crash_reports').add({
                    error_category: category,
                    message: String(message),
                    target_domain: window.location.pathname || 'renderer',
                    stack_trace: String(stackTrace || ''),
                    extra: extra || { userAgent: navigator.userAgent },
                    createdAt: window.firebaseApp.serverTimestamp ? window.firebaseApp.serverTimestamp() : new Date(),
                    device_id: localStorage.getItem('device_id') || 'unknown'
                }).catch(() => {});
            } else {
                // Fallback to local backend if Firebase is not yet ready
                fetch(`${API_BASE}/report-error`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        category: category,
                        message: String(message),
                        domain: window.location.pathname || 'renderer',
                        stack_trace: String(stackTrace || ''),
                        extra: extra || { userAgent: navigator.userAgent }
                    })
                }).catch(() => { }); // Silent fail
            }
        } catch (_) { }
    }

    // Capture global JS exceptions
    window.addEventListener('error', function (event) {
        try {
            const errorObj = event.error || {};
            reportFrontendError(
                'frontend_unhandled_error',
                event.message || 'Script error',
                errorObj.stack || `${event.filename}:${event.lineno}:${event.colno}`,
                { file: event.filename, line: event.lineno, col: event.colno }
            );
        } catch (_) { }
    });

    // Capture unhandled Promise rejections
    window.addEventListener('unhandledrejection', function (event) {
        try {
            const reason = event.reason || {};
            reportFrontendError(
                'frontend_unhandled_promise',
                reason.message || String(reason),
                reason.stack || '',
                { reason: String(reason) }
            );
        } catch (_) { }
    });

    // ─── 2. Announcements System ─────────────────────────────────────────────
    let pendingAnnouncements = [];
    let currentAnnouncement = null;
    const requestOptions = { cache: 'no-store' };

    async function fetchAndShowAnnouncements() {
        try {
            if (!window.firebaseApp || !window.firebaseApp.db) {
                console.debug('Firebase not initialized yet, retrying...');
                setTimeout(fetchAndShowAnnouncements, 1000);
                return;
            }
            await window.firebaseApp.ready;

            let isInitial = true;
            window.firebaseApp.db.collection("announcements")
                .orderBy("created_at", "desc")
                .limit(10)
                .onSnapshot((snapshot) => {
                    const list = [];
                    snapshot.forEach(doc => {
                        const data = doc.data();
                        if (data.active === true) {
                            list.push({ id: doc.id, ...data });
                        }
                    });

                    const dismissed = JSON.parse(localStorage.getItem('ledo_dismissed_anns') || '[]');
                    const now = new Date();
                    const currentAppVersion = window.ledoAppVersion || "0.0.0";
                    
                    const activeList = list.filter(ann => {
                        if (dismissed.includes(ann.id)) return false;
                        if (ann.schedule_start && new Date(ann.schedule_start) > now) return false;
                        if (ann.schedule_end && new Date(ann.schedule_end) < now) return false;
                        if (ann.min_version) {
                            const annParts = ann.min_version.split('.').map(Number);
                            const appParts = currentAppVersion.split('.').map(Number);
                            for (let i = 0; i < 3; i++) {
                                const a = annParts[i] || 0;
                                const b = appParts[i] || 0;
                                if (b < a) return false; 
                                if (b > a) break; 
                            }
                        }
                        return true;
                    });

                    if (activeList.length > 0) {
                        const newAnns = activeList.filter(a => !pendingAnnouncements.find(p => p.id === a.id) && (!currentAnnouncement || currentAnnouncement.id !== a.id));
                        
                        if (newAnns.length > 0) {
                            pendingAnnouncements.push(...newAnns);

                            if (!isInitial) {
                                newAnns.forEach(ann => {
                                    if (window.electronAPI && window.electronAPI.showNotification) {
                                        window.electronAPI.showNotification(ann.title || 'إشعار للجميع', ann.body || '');
                                    } else if (window.Notification && Notification.permission === 'granted') {
                                        new Notification(ann.title || 'إشعار للجميع', { body: ann.body || '' });
                                    }
                                });
                            }

                            if (!currentAnnouncement) {
                                showNextAnnouncement();
                            } else {
                                const countEl = document.getElementById('announcement-remaining');
                                if (countEl && pendingAnnouncements.length > 0) {
                                    countEl.textContent = `(متبقي ${pendingAnnouncements.length + 1} إشعارات)`;
                                    countEl.style.display = 'inline';
                                }
                            }
                        }
                    }
                    isInitial = false;
                }, (err) => {
                    console.debug('Failed to fetch announcements:', err);
                });
        } catch (err) {
            console.debug('Failed to fetch announcements from Firestore:', err);
        }
    }

    function showNextAnnouncement() {
        if (!pendingAnnouncements.length) {
            hideAnnouncementModal();
            return;
        }

        currentAnnouncement = pendingAnnouncements.shift();
        const modal = document.getElementById('announcement-modal');
        if (!modal) return;

        // Elements
        const titleEl = document.getElementById('announcement-title');
        const bodyEl = document.getElementById('announcement-body');
        const badgeEl = document.getElementById('announcement-badge');
        const iconEl = document.getElementById('announcement-icon');
        const actionBtn = document.getElementById('announcement-action-btn');
        const countEl = document.getElementById('announcement-remaining');

        const type = (currentAnnouncement.type || 'info').toLowerCase();
        const priority = (currentAnnouncement.priority || 'normal').toLowerCase();

        // Update badge and icon based on type / priority
        if (badgeEl) {
            badgeEl.className = `ann-badge ann-badge-${type} ${priority === 'high' ? 'priority-high' : ''}`;
            const typeLabels = {
                info: 'إشعار إداري',
                warning: 'تنبيه هام',
                update: 'تحديث جديد',
                alert: 'إعلان عاجل'
            };
            badgeEl.textContent = typeLabels[type] || 'إشعار';
        }

        if (iconEl) {
            let iconClass = 'info';
            if (type === 'warning') iconClass = 'alert-triangle';
            else if (type === 'update') iconClass = 'sparkles';
            else if (type === 'alert') iconClass = 'bell-ring';
            iconEl.setAttribute('data-lucide', iconClass);
            if (window.lucide) window.lucide.createIcons();
        }

        if (titleEl) {
            titleEl.textContent = currentAnnouncement.title || 'رسالة من إدارة البرنامج';
        }

        if (bodyEl) {
            // Render text with line breaks preserved
            bodyEl.innerHTML = escapeHtml(currentAnnouncement.body || '').replace(/\n/g, '<br>');
        }

        // Optional external link button
        if (actionBtn) {
            if (currentAnnouncement.action_url) {
                actionBtn.style.display = 'inline-flex';
                actionBtn.textContent = currentAnnouncement.action_label || 'عرض التفاصيل';
                actionBtn.onclick = () => {
                    openExternalLink(currentAnnouncement.action_url);
                };
            } else {
                actionBtn.style.display = 'none';
            }
        }

        // Remaining queue indicator
        if (countEl) {
            if (pendingAnnouncements.length > 0) {
                countEl.textContent = `(متبقي ${pendingAnnouncements.length + 1} إشعارات)`;
                countEl.style.display = 'inline';
            } else {
                countEl.style.display = 'none';
            }
        }

        modal.style.display = 'flex';
        modal.classList.add('active');
    }

    async function dismissCurrentAnnouncement() {
        if (!currentAnnouncement) {
            hideAnnouncementModal();
            return;
        }

        const annId = currentAnnouncement.id;
        
        // Save to local storage so it doesn't show again on next startup
        const dismissed = JSON.parse(localStorage.getItem('ledo_dismissed_anns') || '[]');
        if (!dismissed.includes(annId)) {
            dismissed.push(annId);
            // keep array small
            if (dismissed.length > 50) dismissed.shift();
            localStorage.setItem('ledo_dismissed_anns', JSON.stringify(dismissed));
        }

        // Check if there are more announcements in queue
        if (pendingAnnouncements.length > 0) {
            showNextAnnouncement();
        } else {
            hideAnnouncementModal();
        }
    }

    function hideAnnouncementModal() {
        const modal = document.getElementById('announcement-modal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 250);
        }
    }

    // ─── 3. App Update System (GitHub Releases via electron-updater) ───────────
    async function checkForAppUpdates(manual = false) {
        const checkBtn = document.getElementById('btn-manual-check-update');
        const statusEl = document.getElementById('update-check-status');

        if (manual) {
            // Use electron-updater for manual checks (GitHub Releases)
            if (window.electronAPI && window.electronAPI.checkForUpdate) {
                if (checkBtn) {
                    checkBtn.disabled = true;
                    checkBtn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> جارِ الفحص...';
                    if (window.lucide) window.lucide.createIcons();
                }
                try {
                    await window.electronAPI.checkForUpdate();
                    // Results will come through onUpdateStatus listener
                } catch (err) {
                    console.debug('Manual check update error:', err);
                    if (statusEl) statusEl.textContent = 'تعذر الاتصال بخادم التحديثات';
                    if (checkBtn) {
                        checkBtn.disabled = false;
                        checkBtn.innerHTML = '<i data-lucide="refresh-cw"></i> التحقق من التحديثات';
                        if (window.lucide) window.lucide.createIcons();
                    }
                }
                return;
            }
        }

        // Firebase realtime listener for update-type announcements (fallback / supplementary)
        try {
            if (!window.firebaseApp || !window.firebaseApp.db) return;
            await window.firebaseApp.ready;
            
            if (!window.unsubscribeUpdates) {
                window.unsubscribeUpdates = window.firebaseApp.db.collection('app_config').doc('latest_update')
                    .onSnapshot(async (docRef) => {
                        if (docRef.exists) {
                            const data = docRef.data();
                            let currentVer = '3.9.0';
                            if (window.electronAPI && window.electronAPI.getVersion) {
                                try { currentVer = await window.electronAPI.getVersion(); } catch(e){}
                            }
                            
                            if (data.version && data.version !== currentVer && data.version !== 'v' + currentVer) {
                                showUpdateModal({
                                    available: true,
                                    version: data.version,
                                    current_version: currentVer,
                                    download_url: data.download_url,
                                    changelog: data.changelog,
                                    required: data.required
                                });
                            }
                        }
                    }, (err) => {
                        console.debug('Check update listener error:', err);
                    });
            }

            // Listen for Maintenance Mode
            if (!window.unsubscribeStatus) {
                window.unsubscribeStatus = window.firebaseApp.db.collection('app_config').doc('status')
                    .onSnapshot((docRef) => {
                        if (docRef.exists) {
                            const data = docRef.data();
                            window.appMaintenanceMode = data.maintenance || false;
                            window.appMaintenanceMessage = data.message || 'نحن في صيانة حالياً، يرجى المحاولة لاحقاً.';
                            
                            if (window.appMaintenanceMode) {
                                if (typeof showToast === 'function') showToast(window.appMaintenanceMessage, '#ef4444');
                            }
                        }
                    });
            }

            // Listen for Feature Toggles
            if (!window.unsubscribeFeatures) {
                window.unsubscribeFeatures = window.firebaseApp.db.collection('app_config').doc('features')
                    .onSnapshot((docRef) => {
                        if (docRef.exists) {
                            window.appFeatureToggles = docRef.data();
                        } else {
                            window.appFeatureToggles = {};
                        }
                    });
            }
        } catch (err) {
            console.debug('Firebase config check error:', err);
        }
    }

    // ─── electron-updater UI handler (listens for update-status from main) ───
    function setupElectronUpdaterUI() {
        if (!window.electronAPI || !window.electronAPI.onUpdateStatus) return;

        const updateReportKey = 'ledo_last_app_update_check';
        const displayCheckTime = value => {
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('ar-EG', { dateStyle: 'short', timeStyle: 'short' }).format(date);
        };
        try {
            const previous = JSON.parse(localStorage.getItem(updateReportKey) || 'null');
            const statusEl = document.getElementById('update-check-status');
            if (statusEl) statusEl.textContent = 'لم تُسجّل نتيجة فحص سابقة بعد.';
            if (previous && statusEl) {
                const checked = displayCheckTime(previous.checkedAt);
                statusEl.textContent = previous.status === 'not-available'
                    ? `آخر فحص ${checked} · لا يوجد إصدار أحدث${previous.version ? ` (v${previous.version})` : ''}.`
                    : previous.status === 'available'
                        ? `آخر فحص ${checked} · الإصدار v${previous.version} متاح.`
                        : `آخر محاولة فحص ${checked} · تعذر الاتصال بخادم التحديثات.`;
                statusEl.style.color = previous.status === 'error' ? '#ef4444' : '#10b981';
            }
        } catch (_) {}

        window.electronAPI.onUpdateStatus((data) => {
            const checkBtn = document.getElementById('btn-manual-check-update');
            const statusEl = document.getElementById('update-check-status');
            const progressContainer = document.getElementById('update-progress-container');
            const progressBar = document.getElementById('update-progress-bar');
            const progressText = document.getElementById('update-progress-text');
            const installBtn = document.getElementById('btn-install-update');
            const checkedAt = data.checkedAt || new Date().toISOString();

            if (['not-available', 'available', 'error'].includes(data.status)) {
                try { localStorage.setItem(updateReportKey, JSON.stringify({ status: data.status, version: data.version || '', checkedAt, message: data.message || '' })); } catch (_) {}
            }

            switch (data.status) {
                case 'checking':
                    if (statusEl) statusEl.textContent = 'جارِ التحقق من التحديثات...';
                    if (checkBtn) {
                        checkBtn.disabled = true;
                        checkBtn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> جارِ الفحص...';
                    }
                    if (installBtn) installBtn.style.display = 'none';
                    break;

                case 'available':
                    if (statusEl) {
                        statusEl.textContent = `🎉 إصدار جديد متوفر: v${data.version} · آخر فحص ${displayCheckTime(checkedAt)}`;
                        statusEl.style.color = '#818cf8';
                    }
                    if (checkBtn) {
                        checkBtn.disabled = true;
                        checkBtn.innerHTML = '<i data-lucide="download"></i> جارِ التحميل...';
                    }
                    if (progressContainer) progressContainer.style.display = 'block';
                    break;

                case 'downloading':
                    if (progressBar) progressBar.style.width = data.percent.toFixed(1) + '%';
                    var speed = data.bytesPerSecond > 1048576
                        ? (data.bytesPerSecond / 1048576).toFixed(1) + ' MB/s'
                        : (data.bytesPerSecond / 1024).toFixed(0) + ' KB/s';
                    var downloaded = (data.transferred / 1048576).toFixed(1);
                    var total = (data.total / 1048576).toFixed(1);
                    if (progressText) {
                        progressText.textContent = data.percent.toFixed(0) + '% — ' + downloaded + '/' + total + ' MB (' + speed + ')';
                    }
                    if (statusEl) statusEl.textContent = 'جارِ تحميل التحديث... ' + data.percent.toFixed(0) + '%';
                    break;

                case 'downloaded':
                    if (statusEl) {
                        statusEl.textContent = '✅ تم تحميل التحديث v' + data.version + ' — جاهز للتثبيت!';
                        statusEl.style.color = '#10b981';
                    }
                    if (progressContainer) progressContainer.style.display = 'none';
                    if (checkBtn) {
                        checkBtn.disabled = false;
                        checkBtn.innerHTML = '<i data-lucide="refresh-cw"></i> التحقق من التحديثات';
                    }
                    if (installBtn) {
                        installBtn.style.display = 'inline-flex';
                        installBtn.onclick = function() {
                            if (window.electronAPI && window.electronAPI.installUpdate) {
                                window.electronAPI.installUpdate();
                            }
                        };
                    }
                    window.showToast?.('🚀 تم تحميل التحديث v' + data.version + '! اضغط "تثبيت الآن" لتحديث البرنامج.', '#6366f1', 8000);
                    break;

                case 'not-available':
                    if (statusEl) {
                        statusEl.textContent = `✨ لا يوجد إصدار أحدث · آخر فحص ${displayCheckTime(checkedAt)}${data.version ? ` (v${data.version})` : ''}`;
                        statusEl.style.color = '#10b981';
                    }
                    if (checkBtn) {
                        checkBtn.disabled = false;
                        checkBtn.innerHTML = '<i data-lucide="refresh-cw"></i> التحقق من التحديثات';
                    }
                    if (progressContainer) progressContainer.style.display = 'none';
                    break;

                case 'error':
                    if (statusEl) {
                        statusEl.textContent = `تعذر التحقق من التحديثات · آخر محاولة ${displayCheckTime(checkedAt)}${data.message ? ` · ${data.message}` : ''}`;
                        statusEl.style.color = '#ef4444';
                    }
                    if (checkBtn) {
                        checkBtn.disabled = false;
                        checkBtn.innerHTML = '<i data-lucide="refresh-cw"></i> إعادة المحاولة';
                    }
                    if (progressContainer) progressContainer.style.display = 'none';
                    console.debug('Update error:', data.message);
                    break;
            }

            if (window.lucide) window.lucide.createIcons();
        });
    }

    function setupEngineUpdaterUI() {
        const button = document.getElementById('btn-check-engine-updates');
        const status = document.getElementById('engine-update-status');
        const progressContainer = document.getElementById('engine-update-progress-container');
        const progressBar = document.getElementById('engine-update-progress-bar');
        const progressText = document.getElementById('engine-update-progress-text');
        const powerShellButton = document.getElementById('btn-engine-update-powershell');
        const details = document.getElementById('engine-update-details');
        const detailsContent = document.getElementById('engine-update-details-content');
        if (!button || !window.electronAPI) return;
        if (status) status.textContent = 'لم يُسجّل فحص سابق لمكتبات المحرك على هذا الجهاز.';

        const updateTime = value => {
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('ar-EG', { dateStyle: 'short', timeStyle: 'short' }).format(date);
        };
        const renderEngineReport = report => {
            if (!report) return;
            const checked = updateTime(report.checkedAt);
            const changes = Array.isArray(report.changes) ? report.changes : [];
            const versions = report.packageVersions && typeof report.packageVersions === 'object' ? Object.entries(report.packageVersions) : [];
            if (status) {
                if (report.status === 'staged') {
                    status.textContent = changes.length
                        ? `آخر تحديث ${checked} · تغيّرت ${changes.length} مكتبة من ${report.packageCount || versions.length}. أعد تشغيل التطبيق لتطبيقها.`
                        : `تحديث المكتبات جاهز للتطبيق بعد إعادة التشغيل · آخر فحص ${checked}.`;
                    status.style.color = '#10b981';
                } else if (report.status === 'applied') {
                    status.textContent = `تم تطبيق تحديث المكتبات بعد إعادة التشغيل · ${checked} · ${report.packageCount || versions.length} حزمة.`;
                    status.style.color = '#10b981';
                } else if (report.status === 'up-to-date' && report.restartRequired) {
                    status.textContent = `المكتبات محدّثة، لكن التحديث لم يُحمّل في المحرك بعد. أعد التشغيل · آخر فحص ${checked}.`;
                    status.style.color = '#f59e0b';
                } else if (report.status === 'up-to-date') {
                    status.textContent = `آخر فحص ${checked} · لم تتغير المكتبات (${report.packageCount || versions.length} حزمة؛ yt-dlp ${report.currentVersion || '—'}).`;
                    status.style.color = '#10b981';
                } else if (report.status === 'error') {
                    status.textContent = `فشل آخر فحص ${checked} · ${report.error || 'تعذر التحقق من المكتبات.'}`;
                    status.style.color = '#ef4444';
                }
            }
            if (details && detailsContent && (changes.length || versions.length)) {
                details.hidden = false;
                const rows = changes.length
                    ? changes.map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.from || 'تثبيت جديد')}</td><td>${escapeHtml(item.to || '—')}</td></tr>`)
                    : versions.map(([name, version]) => `<tr><td>${escapeHtml(name)}</td><td>—</td><td>${escapeHtml(version)}</td></tr>`);
                details.querySelector('summary').textContent = changes.length
                    ? `المكتبات التي تغيّرت (${changes.length})`
                    : `الإصدارات الحالية (${versions.length})`;
                detailsContent.innerHTML = `<div style="max-height:260px;overflow:auto;border:1px solid var(--border-color);border-radius:8px;"><table style="width:100%;border-collapse:collapse;font-size:11px;text-align:right;"><thead><tr><th style="padding:7px;">المكتبة</th><th style="padding:7px;">الإصدار السابق</th><th style="padding:7px;">الإصدار الجديد</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
            }
        };

        window.electronAPI.getEngineUpdateReport?.().then(renderEngineReport).catch(() => {});

        powerShellButton?.addEventListener('click', async () => {
            const result = await window.electronAPI.openEngineUpdatePowerShell?.();
            if (status) {
                status.textContent = result?.success
                    ? 'تم فتح PowerShell. اتبع التعليمات، وبعد نجاح التحديث أغلق Ledo Downloader وافتحه مجددًا.'
                    : (result?.error || 'تعذر فتح PowerShell.');
                status.style.color = result?.success ? '#fbbf24' : '#ef4444';
            }
        });

        button.addEventListener('click', async () => {
            button.disabled = true;
            if (status) {
                status.textContent = 'جارٍ فحص Python 3.13 ومكتبات requirements.txt...';
                status.style.color = 'var(--text-muted)';
            }
            try {
                const result = await window.electronAPI.checkEngineUpdates();
                if (!result?.success && status) {
                    status.textContent = result?.error || 'تعذر فحص تحديثات المكتبات.';
                    status.style.color = '#ef4444';
                }
            } catch (error) {
                if (status) {
                    status.textContent = error?.message || 'تعذر فحص تحديثات المكتبات.';
                    status.style.color = '#ef4444';
                }
                button.disabled = false;
            }
        });

        window.electronAPI.onEngineUpdateStatus?.((data) => {
            switch (data.status) {
                case 'checking':
                    button.disabled = true;
                    if (powerShellButton) powerShellButton.hidden = true;
                    if (status) status.textContent = data.detail || 'جارٍ فحص Python 3.13 ومكتبات requirements.txt...';
                    break;
                case 'downloading':
                    button.disabled = true;
                    if (status) status.textContent = data.detail || 'جارٍ تنزيل وتثبيت أحدث الإصدارات المتوافقة من requirements.txt...';
                    if (progressContainer) progressContainer.style.display = 'block';
                    if (progressBar && Number.isFinite(data.percent)) progressBar.style.width = `${data.percent.toFixed(1)}%`;
                    if (progressText) progressText.textContent = Number.isFinite(data.percent) ? `${data.percent.toFixed(0)}%` : '…';
                    break;
                case 'validating':
                    button.disabled = true;
                    if (status) status.textContent = 'جارٍ التحقق من توافق المكتبات مع محرك التحميل قبل تفعيلها...';
                    if (progressContainer) progressContainer.style.display = 'none';
                    break;
                case 'up-to-date':
                    button.disabled = false;
                    renderEngineReport(data);
                    if (progressContainer) progressContainer.style.display = 'none';
                    break;
                case 'staged':
                    button.disabled = false;
                    if (powerShellButton) powerShellButton.hidden = true;
                    renderEngineReport(data);
                    if (progressContainer) progressContainer.style.display = 'none';
                    window.showToast?.(data.changes?.length
                        ? `تغيّرت ${data.changes.length} مكتبة. أعد تشغيل Ledo Downloader لتطبيقها.`
                        : 'تحديث المكتبات جاهز. أعد تشغيل Ledo Downloader لتطبيقه.', '#10b981', 7000);
                    break;
                case 'applied':
                    button.disabled = false;
                    renderEngineReport(data);
                    if (progressContainer) progressContainer.style.display = 'none';
                    break;
                case 'error':
                    button.disabled = false;
                    if (powerShellButton) powerShellButton.hidden = !data.powerShellFallback;
                    if (status) {
                        status.textContent = `${data.error || 'فشل تحديث المكتبات.'}${data.powerShellFallback ? ' إذا منعت حماية Windows التحديث، افتح PowerShell لإعادة المحاولة.' : ''}`;
                        status.style.color = '#ef4444';
                    }
                    renderEngineReport(data);
                    if (progressContainer) progressContainer.style.display = 'none';
                    break;
            }
            if (window.lucide) window.lucide.createIcons();
        });
    }

    function showUpdateModal(updateData) {
        const modal = document.getElementById('update-modal');
        if (!modal) return;

        const newVerEl = document.getElementById('update-new-version');
        const curVerEl = document.getElementById('update-current-version');
        const changelogEl = document.getElementById('update-changelog');
        const downloadBtn = document.getElementById('update-download-btn');
        const laterBtn = document.getElementById('update-later-btn');
        const closeBtn = document.getElementById('btn-close-update-modal');
        const badgeEl = document.getElementById('update-required-badge');

        if (newVerEl) newVerEl.textContent = `v${updateData.version || '4.0.0'}`;
        if (curVerEl) curVerEl.textContent = `الإصدار الحالي: v${updateData.current_version || '3.9.0'}`;

        if (changelogEl) {
            const rawNotes = updateData.changelog || 'تحسينات عامة على الأداء وسرعة التحميل واستقرار البرنامج.';
            changelogEl.innerHTML = escapeHtml(rawNotes).replace(/\n/g, '<br>');
        }

        // Required update handling
        const isRequired = !!updateData.required;
        if (badgeEl) {
            badgeEl.style.display = isRequired ? 'inline-block' : 'none';
        }
        if (laterBtn) {
            laterBtn.style.display = isRequired ? 'none' : 'inline-block';
        }
        if (closeBtn) {
            closeBtn.style.display = isRequired ? 'none' : 'flex';
        }

        if (downloadBtn) {
            downloadBtn.onclick = () => {
                const url = updateData.download_url;
                if (url) {
                    openExternalLink(url);
                    if (!isRequired) {
                        hideUpdateModal();
                    }
                } else {
                    alert('رابط التحميل غير متوفر حالياً');
                }
            };
        }

        modal.style.display = 'flex';
        modal.classList.add('active');
        if (window.lucide) window.lucide.createIcons();
    }

    function hideUpdateModal() {
        const modal = document.getElementById('update-modal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 250);
        }
    }

    async function loadPublicLinks() {
        const root = document.getElementById('public-links');
        if (!root) return;
        try {
            if (!window.firebaseApp || !window.firebaseApp.db) return;
            await window.firebaseApp.ready;
            
            const docRef = await window.firebaseApp.db.collection('app_config').doc('public_links').get();
            if (!docRef.exists) return;
            const links = docRef.data() || {};
            
            const items = [
                ['website_url', 'globe-2', 'الموقع الرسمي'],
                ['privacy_url', 'shield-check', 'سياسة الخصوصية'],
                ['terms_url', 'file-text', 'الشروط والأحكام'],
                ['support_url', 'life-buoy', 'الدعم والمساعدة']
            ].filter(([key]) => /^https:\/\//i.test(links[key] || ''));
            
            if (!items.length) return;
            
            root.innerHTML = items.map(([key, icon, label]) =>
                `<button class="btn-settings-action" type="button" data-public-link="${key}"><i data-lucide="${icon}"></i>${label}</button>`
            ).join('');
            root.hidden = false;
            
            root.querySelectorAll('[data-public-link]').forEach((button) => {
                button.addEventListener('click', () => openExternalLink(links[button.dataset.publicLink]));
            });
            if (window.lucide) window.lucide.createIcons();
        } catch (err) {
            console.debug('Failed to load public links:', err);
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────
    function openExternalLink(url) {
        if (!url) return;
        if (window.electronAPI && window.electronAPI.openExternal) {
            window.electronAPI.openExternal(url);
        } else {
            window.open(url, '_blank');
        }
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ─── Event Binding ───────────────────────────────────────────────────────
    function initUI() {
        // Announcement modal dismiss button
        const btnDismiss = document.getElementById('btn-dismiss-announcement');
        if (btnDismiss) {
            btnDismiss.addEventListener('click', dismissCurrentAnnouncement);
        }

        const btnCloseAnn = document.getElementById('btn-close-announcement-modal');
        if (btnCloseAnn) {
            btnCloseAnn.addEventListener('click', dismissCurrentAnnouncement);
        }

        // Update modal close/later buttons
        const btnLater = document.getElementById('update-later-btn');
        if (btnLater) {
            btnLater.addEventListener('click', hideUpdateModal);
        }

        const btnCloseUpdate = document.getElementById('btn-close-update-modal');
        if (btnCloseUpdate) {
            btnCloseUpdate.addEventListener('click', hideUpdateModal);
        }

        // Manual check button in settings
        const btnManualCheck = document.getElementById('btn-manual-check-update');
        if (btnManualCheck) {
            btnManualCheck.addEventListener('click', () => checkForAppUpdates(true));
        }

        // Close on background click (unless required update)
        const annModal = document.getElementById('announcement-modal');
        if (annModal) {
            annModal.addEventListener('click', (e) => {
                if (e.target === annModal) dismissCurrentAnnouncement();
            });
        }

        const updateModal = document.getElementById('update-modal');
        if (updateModal) {
            updateModal.addEventListener('click', (e) => {
                if (e.target === updateModal) {
                    const badge = document.getElementById('update-required-badge');
                    const isRequired = badge && badge.style.display !== 'none';
                    if (!isRequired) hideUpdateModal();
                }
            });
        }
    }

    // Expose functions globally
    window.checkForAppUpdates = checkForAppUpdates;
    window.fetchAndShowAnnouncements = fetchAndShowAnnouncements;
    window.loadPublicLinks = loadPublicLinks;

    // Boot on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initUI();
            setupElectronUpdaterUI();
            setupEngineUpdaterUI();
            // Slight delay so the UI finishes painting before modals pop
            setTimeout(() => {
                fetchAndShowAnnouncements();
                checkForAppUpdates(false);
                loadPublicLinks();
            }, 1200);
        });
    } else {
        initUI();
        setupElectronUpdaterUI();
        setupEngineUpdaterUI();
        setTimeout(() => {
            fetchAndShowAnnouncements();
            checkForAppUpdates(false);
            loadPublicLinks();
        }, 1200);
    }
})();
