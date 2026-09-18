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
        } catch (err) {
            console.debug('Firebase update check error:', err);
        }
    }

    // ─── electron-updater UI handler (listens for update-status from main) ───
    function setupElectronUpdaterUI() {
        if (!window.electronAPI || !window.electronAPI.onUpdateStatus) return;

        window.electronAPI.onUpdateStatus((data) => {
            const checkBtn = document.getElementById('btn-manual-check-update');
            const statusEl = document.getElementById('update-check-status');
            const progressContainer = document.getElementById('update-progress-container');
            const progressBar = document.getElementById('update-progress-bar');
            const progressText = document.getElementById('update-progress-text');
            const installBtn = document.getElementById('btn-install-update');

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
                        statusEl.textContent = '🎉 تحديث جديد متوفر: v' + data.version;
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
                    if (window.Toastify) {
                        window.Toastify({
                            text: '🚀 تم تحميل التحديث v' + data.version + '! اضغط "تثبيت الآن" لتحديث البرنامج.',
                            duration: 8000,
                            gravity: 'top',
                            position: 'center',
                            style: {
                                background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                                borderRadius: '10px',
                                fontWeight: '600'
                            }
                        }).showToast();
                    }
                    break;

                case 'not-available':
                    if (statusEl) {
                        statusEl.textContent = '✨ أنت تستخدم أحدث إصدار!';
                        statusEl.style.color = '#10b981';
                    }
                    if (checkBtn) {
                        checkBtn.disabled = false;
                        checkBtn.innerHTML = '<i data-lucide="refresh-cw"></i> التحقق من التحديثات';
                    }
                    if (progressContainer) progressContainer.style.display = 'none';
                    setTimeout(function() {
                        if (statusEl && statusEl.textContent.indexOf('أحدث إصدار') !== -1) {
                            statusEl.textContent = '';
                        }
                    }, 5000);
                    break;

                case 'error':
                    if (statusEl) {
                        statusEl.textContent = 'تعذر التحقق من التحديثات حالياً';
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
        setTimeout(() => {
            fetchAndShowAnnouncements();
            checkForAppUpdates(false);
            loadPublicLinks();
        }, 1200);
    }
})();
