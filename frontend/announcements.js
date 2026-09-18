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

            const snapshot = await window.firebaseApp.db.collection("announcements")
                .where("active", "==", true)
                .orderBy("created_at", "desc")
                .limit(5)
                .get();

            const list = [];
            snapshot.forEach(doc => {
                list.push({ id: doc.id, ...doc.data() });
            });

            // Filter out announcements the user already dismissed using localStorage
            const now = new Date();
            const currentAppVersion = window.ledoAppVersion || "0.0.0"; // Assume app injects this, or fallback
            
            const activeList = list.filter(ann => {
                if (dismissed.includes(ann.id)) return false;
                
                // Check schedule
                if (ann.schedule_start && new Date(ann.schedule_start) > now) return false;
                if (ann.schedule_end && new Date(ann.schedule_end) < now) return false;
                
                // Check min version (if any)
                // Note: simplistic version check assuming standard x.y.z
                if (ann.min_version) {
                    const annParts = ann.min_version.split('.').map(Number);
                    const appParts = currentAppVersion.split('.').map(Number);
                    for (let i = 0; i < 3; i++) {
                        const a = annParts[i] || 0;
                        const b = appParts[i] || 0;
                        if (b < a) return false; // App version is older
                        if (b > a) break; // App version is newer
                    }
                }
                
                return true;
            });

            if (activeList.length > 0) {
                pendingAnnouncements = activeList;
                showNextAnnouncement();
            }
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

    // ─── 3. App Update System (MediaFire / External Download) ─────────────────
    async function checkForAppUpdates(manual = false) {
        const checkBtn = document.getElementById('btn-manual-check-update');
        if (manual && checkBtn) {
            checkBtn.disabled = true;
            checkBtn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> جارِ الفحص...';
            if (window.lucide) window.lucide.createIcons();
        }

        try {
            if (!window.firebaseApp || !window.firebaseApp.db) {
                throw new Error("Firebase not ready");
            }
            
            const docRef = await window.firebaseApp.db.collection('app_config').doc('latest_update').get();
            if (docRef.exists) {
                const data = docRef.data();
                // Compare versions. For simplicity, just show if available.
                // In a real app, compare 'data.version' with 'app.getVersion()'
                
                // You can get current version from electronAPI if available
                let currentVer = '3.9.0';
                if (window.electronAPI && window.electronAPI.getVersion) {
                    try { currentVer = await window.electronAPI.getVersion(); } catch(e){}
                }
                
                // Basic check if versions differ
                if (data.version && data.version !== currentVer && data.version !== 'v' + currentVer) {
                    showUpdateModal({
                        available: true,
                        version: data.version,
                        current_version: currentVer,
                        download_url: data.download_url,
                        changelog: data.changelog,
                        required: data.required
                    });
                } else if (manual) {
                    if (window.Toastify) {
                        window.Toastify({
                            text: '✨ أنت تستخدم أحدث إصدار بالفعل!',
                            duration: 3500,
                            gravity: 'top',
                            position: 'center',
                            style: {
                                background: 'linear-gradient(135deg, #10b981, #059669)',
                                borderRadius: '10px',
                                fontWeight: '600'
                            }
                        }).showToast();
                    }
                }
            } else if (manual) {
                throw new Error("No update info");
            }
        } catch (err) {
            console.debug('Check update error:', err);
            if (manual && window.Toastify) {
                window.Toastify({
                    text: 'تعذر الاتصال بخادم التحديثات حالياً',
                    duration: 3000,
                    gravity: 'top',
                    position: 'center',
                    style: {
                        background: 'linear-gradient(135deg, #ef4444, #b91c1c)',
                        borderRadius: '10px'
                    }
                }).showToast();
            }
        } finally {
            if (manual && checkBtn) {
                checkBtn.disabled = false;
                checkBtn.innerHTML = '<i data-lucide="refresh-cw"></i> التحقق من التحديثات';
                if (window.lucide) window.lucide.createIcons();
            }
        }
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
            // Slight delay so the UI finishes painting before modals pop
            setTimeout(() => {
                fetchAndShowAnnouncements();
                checkForAppUpdates(false);
                loadPublicLinks();
            }, 1200);
        });
    } else {
        initUI();
        setTimeout(() => {
            fetchAndShowAnnouncements();
            checkForAppUpdates(false);
            loadPublicLinks();
        }, 1200);
    }
})();
