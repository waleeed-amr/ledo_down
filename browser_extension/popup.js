const API_BASE = 'http://127.0.0.1:8000/api';

// DOM Elements
const statusIndicator = document.getElementById('app-status');
const appStatusText = document.getElementById('app-status-text');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');
const currentUrlInput = document.getElementById('current-url');
const toastEl = document.getElementById('toast');

// State
let isAppOnline = false;
let currentTabId = null;
let currentTabUrl = '';
let currentTabTitle = '';
let currentSiteHost = '';
let adBlockEnabled = true;
let allowedSites = [];
let currentFilteringMode = 2;
let foundMediaItems = [];

const FILTERING_MODES = {
    0: {
        id: 0,
        label: 'إيقاف',
        title: 'الحماية متوقفة على هذا الموقع',
        desc: 'يتم السماح بكافة الإعلانات وعناصر التتبع في هذا الموقع بدون أي تدخل.'
    },
    1: {
        id: 1,
        label: 'خفيف',
        title: 'خفيف (حظر الإعلانات المعروفة)',
        desc: 'حظر النطاقات الإعلانية وشبكات التتبع المعروفة على مستوى الشبكة فقط.'
    },
    2: {
        id: 2,
        label: 'موصى به',
        title: 'متوازن (الوضع الموصى به)',
        desc: 'حظر الإعلانات والتعقب، مع تحسينات حظر الإعلانات المرئية في المواقع المدعومة.'
    },
    3: {
        id: 3,
        label: 'شامل',
        title: 'شامل (قد يؤثر في بعض عناصر المواقع)',
        desc: 'يحظر السكربتات والإطارات وطلبات البيانات والصور والخطوط الخارجية؛ قد تتعطل بعض الصور أو التضمينات.'
    }
};

// Logger State
let activeLoggerFilter = 'all';
let loggerSearchQuery = '';
let tabRequestsData = [];
let tabRequestsStats = { total: 0, blocked: 0, allowed: 0, thirdParty: 0, blockedPercent: 0 };
let loggerPollInterval = null;

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    initCurrentTab();
    checkAppStatus();
    setupSettings();
    setupBadgerTab();
    
    // Poll desktop status every 3 seconds
    setInterval(checkAppStatus, 3000);
});

// --- Tab Logic ---
function setupTabs() {
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            setActiveSection(btn.dataset.section);
        });
    });

    document.querySelectorAll('.subtab-btn').forEach(btn => {
        btn.addEventListener('click', () => activatePane(btn.dataset.pane));
    });

    document.querySelectorAll('[data-open-pane]').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.openPane;
            const section = ['tab-adblock', 'tab-badger'].includes(target) ? 'protection'
                : ['tab-smart', 'tab-current', 'tab-status'].includes(target) ? 'downloads' : 'home';
            setActiveSection(section, target);
        });
    });
}

function setActiveSection(section, requestedPane = '') {
    const defaults = {
        home: 'tab-home', protection: 'tab-adblock', downloads: 'tab-smart', settings: 'tab-settings'
    };
    tabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.section === section));
    document.getElementById('protection-subnav').hidden = section !== 'protection';
    document.getElementById('downloads-subnav').hidden = section !== 'downloads';
    activatePane(requestedPane || defaults[section] || 'tab-home');
}

function activatePane(target) {
    tabPanes.forEach(pane => pane.classList.toggle('active', pane.id === target));
    document.querySelectorAll('.subtab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.pane === target));
    if (target === 'tab-smart') sniffMedia(currentTabId);
    if (target === 'tab-adblock') refreshTabRequests();
    if (target === 'tab-badger') {
        refreshBadgerData();
        if (!badgerPollInterval) badgerPollInterval = setInterval(refreshBadgerData, 2500);
    } else if (badgerPollInterval) {
        clearInterval(badgerPollInterval);
        badgerPollInterval = null;
    }
}

// --- Active Tab Initializer ---
function initCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs.length > 0) {
            const activeTab = tabs[0];
            currentTabId = activeTab.id;
            currentTabUrl = activeTab.url || '';
            currentTabTitle = activeTab.title || '';

            if (currentUrlInput) currentUrlInput.value = currentTabUrl;

            try {
                currentSiteHost = new URL(currentTabUrl).hostname.toLowerCase();
            } catch (_) {
                currentSiteHost = '';
            }

            setupAdBlockControls();
            refreshBadgerData();
            setupRadioModeShortcut();

            // Disable downloader if it's an internal url
            if (currentTabUrl.startsWith('chrome://') || currentTabUrl.startsWith('edge://')) {
                document.querySelectorAll('.current-quality-btn').forEach(b => b.disabled = true);
                if (currentUrlInput) currentUrlInput.value = "لا يمكن التنزيل من صفحات المتصفح الداخلية";
            }
        } else {
            setupAdBlockControls();
            setupRadioModeShortcut();
        }
    });
}

function setupRadioModeShortcut() {
    const button = document.getElementById('radio-mode-launch');
    if (!button) return;
    const isYouTube = /^https:\/\/(www\.|m\.|music\.)?youtube\.com\//i.test(currentTabUrl) || /^https:\/\/youtu\.be\//i.test(currentTabUrl);
    button.disabled = !isYouTube;
    button.title = isYouTube ? 'تبديل وضع الصوت في تبويب يوتيوب الحالي' : 'افتح فيديو يوتيوب أولاً';
    button.textContent = isYouTube ? 'ابدأ الاستماع' : 'افتح يوتيوب';
    if (isYouTube && currentTabId) {
        chrome.tabs.sendMessage(currentTabId, { action: 'getLedoAudioFocusState' }, state => {
            if (!chrome.runtime.lastError && state?.success) {
                button.textContent = state.enabled ? 'أوقف وضع الصوت' : state.busy ? 'جارٍ التجهيز…' : 'ابدأ الاستماع';
            }
        });
    }
    button.onclick = async () => {
        if (!isYouTube || !currentTabId) return;
        button.disabled = true;
        try {
            const result = await chrome.tabs.sendMessage(currentTabId, { action: 'toggleLedoAudioFocus' });
            if (!result?.success) showToast(result?.error || 'تعذر تشغيل وضع الصوت. حدّث صفحة يوتيوب ثم جرّب مرة أخرى.', true);
            else button.textContent = result.enabled ? 'أوقف وضع الصوت' : 'ابدأ الاستماع';
        } catch (_) {
            showToast('حدّث صفحة يوتيوب أولاً لتفعيل زر LEDO Radio Mode.', true);
        } finally {
            button.disabled = false;
        }
    };
    refreshRadioDashboard();
}

async function refreshRadioDashboard() {
    const data = await chrome.storage.local.get('ledo_youtube_saver_stats');
    const stats = data.ledo_youtube_saver_stats || {};
    const saved = document.getElementById('radio-saved-data');
    const time = document.getElementById('radio-listening-time');
    const sessions = document.getElementById('radio-sessions');
    if (saved) saved.textContent = formatBytes(stats.estimatedAvoidedBytes || 0);
    if (time) time.textContent = `${Math.floor((stats.seconds || 0) / 60)} د`;
    if (sessions) sessions.textContent = String(Math.max(0, Math.floor(stats.sessions || 0)));
}

// ========================================================================
//  AD BLOCKER CONTROLS & LIVE LOGGER
// ========================================================================
async function setupAdBlockControls() {
    const toggle = document.getElementById('adblock-toggle');
    const homeToggle = document.getElementById('home-adblock-toggle');

    const [settings, rulesets, modeRes] = await Promise.all([
        chrome.storage.local.get([
            'adblock_enabled', 'adblock_allowlist', 'adblock_filter_lists',
            'adblock_filters_updated_at', 'adblock_filters_active_count',
            'adblock_filters_error', 'adblock_custom_domains',
            'adblock_cosmetic_enabled', 'adblock_cosmetic_count',
            'adblock_youtube_ads', 'adblock_social_ads', 'adblock_anti_adblock',
            'adblock_session_stats', 'site_filtering_modes'
        ]),
        chrome.declarativeNetRequest.getEnabledRulesets().catch(() => []),
        sendExtensionAction({ action: 'getFilteringMode', hostname: currentSiteHost }).catch(() => ({ mode: 2 }))
    ]);

    adBlockEnabled = settings.adblock_enabled !== false && rulesets.includes('ledo_adblock');
    allowedSites = Array.isArray(settings.adblock_allowlist) ? settings.adblock_allowlist : [];
    currentFilteringMode = (modeRes && typeof modeRes.mode === 'number') ? modeRes.mode : (allowedSites.includes(currentSiteHost) ? 0 : 2);

    updateAdBlockHeroUI();
    setupFilteringModeSlider();
    setupOnSiteTools();
    setupFilterListCheckboxes(settings);
    renderCustomDomains(settings.adblock_custom_domains || []);
    updateFilterStatusDisplay(settings);
    setupModuleToggles(settings);
    setupLoggerFiltersAndSearch();
    loadLifetimeStats(settings);

    // Initial fetch of requests on this tab
    refreshTabRequests();

    // Start polling requests every 2s while popup is open
    if (loggerPollInterval) clearInterval(loggerPollInterval);
    loggerPollInterval = setInterval(() => {
        const adBlockTab = document.getElementById('tab-adblock');
        const homeTab = document.getElementById('tab-home');
        if ((adBlockTab && adBlockTab.classList.contains('active')) || (homeTab && homeTab.classList.contains('active'))) {
            refreshTabRequests();
        }
    }, 2000);

    // Master Power Toggle
    if (toggle) {
        toggle.addEventListener('click', async () => {
            toggle.disabled = true;
            try {
                const nextState = !adBlockEnabled;
                const result = await sendExtensionAction({ action: 'setAdBlock', enabled: nextState });
                if (!result.success) throw new Error(result.error || 'فشل في تغيير حالة الدرع');
                adBlockEnabled = result.enabled;
                if (!adBlockEnabled) {
                    currentFilteringMode = 0;
                } else if (currentFilteringMode === 0) {
                    currentFilteringMode = 2;
                }
                updateAdBlockHeroUI();
                showToast(adBlockEnabled ? 'تم تفعيل حماية درع ليدو' : 'تم إيقاف حماية درع ليدو مؤقتاً');
            } catch (err) {
                showToast(err.message || 'خطأ في تحديث الدرع', true);
            } finally {
                toggle.disabled = false;
            }
        });
    }

    if (homeToggle) {
        homeToggle.addEventListener('click', async () => {
            homeToggle.disabled = true;
            try {
                if (!adBlockEnabled) {
                    const result = await sendExtensionAction({ action: 'setAdBlock', enabled: true });
                    if (!result.success) throw new Error(result.error || 'تعذر تشغيل الحماية');
                    adBlockEnabled = true;
                }
                await setFilteringMode(currentFilteringMode > 0 ? 0 : 2);
            } catch (err) {
                showToast(err.message || 'تعذر تغيير حماية هذا الموقع', true);
            } finally {
                homeToggle.disabled = false;
            }
        });
    }

    // Update Filter Lists Button
    const updateBtn = document.getElementById('btn-update-filters');
    if (updateBtn) {
        updateBtn.addEventListener('click', async () => {
            updateBtn.disabled = true;
            updateBtn.textContent = 'جاري التحديث…';
            setFilterStatusMessage('جاري تحميل وتجميع أحدث قواعد درع ليدو…');
            try {
                const result = await sendExtensionAction({ action: 'refreshAdFilters' });
                if (!result.success) throw new Error(result.error || 'فشل تحديث القوائم');
                const latest = await chrome.storage.local.get([
                    'adblock_filter_lists', 'adblock_filters_updated_at',
                    'adblock_filters_active_count', 'adblock_filters_error', 'adblock_cosmetic_count'
                ]);
                updateFilterStatusDisplay(latest);
                showToast(`تم تحديث ${formatCount(result.count)} قاعدة بنجاح`);
            } catch (err) {
                setFilterStatusMessage(err.message || 'تعذر تحديث القوائم', true);
                showToast(err.message || 'فشل تحديث القوائم', true);
            } finally {
                updateBtn.disabled = false;
                updateBtn.textContent = 'تحديث القوائم';
            }
        });
    }

    // Custom domain blocking
    const addDomainBtn = document.getElementById('btn-add-custom-domain');
    const domainInput = document.getElementById('custom-domain-input');
    if (addDomainBtn && domainInput) {
        addDomainBtn.addEventListener('click', () => addCustomDomainFromInput());
        domainInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addCustomDomainFromInput();
        });
    }

    const domainListEl = document.getElementById('custom-domain-list');
    if (domainListEl) {
        domainListEl.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-remove-domain]');
            if (!btn) return;
            btn.disabled = true;
            try {
                const result = await sendExtensionAction({
                    action: 'toggleCustomAdBlockDomain',
                    hostname: btn.dataset.removeDomain
                });
                if (!result.success) throw new Error(result.error || 'تعذر إزالة النطاق');
                renderCustomDomains(result.domains);
                showToast(`تم إلغاء حظر النطاق: ${result.domain}`);
            } catch (err) {
                showToast(err.message || 'حدث خطأ أثناء إزالة النطاق', true);
                btn.disabled = false;
            }
        });
    }
}

// 4-Stage Segmented Filtering Mode Controls
function setupFilteringModeSlider() {
    document.querySelectorAll('.mode-step-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const mode = Number(btn.dataset.mode);
            await setFilteringMode(mode);
        });
    });
}

async function setFilteringMode(mode) {
    if (!currentSiteHost) return;
    currentFilteringMode = mode;
    updateFilteringModeUI(mode);

    try {
        const result = await sendExtensionAction({
            action: 'setFilteringMode',
            hostname: currentSiteHost,
            mode: mode,
            tabId: currentTabId
        });
        if (result && result.allowlist) {
            allowedSites = result.allowlist;
        }
        if (mode === 0) {
            showToast(`تم إيقاف الحماية على: ${currentSiteHost}`);
        } else {
            const info = FILTERING_MODES[mode] || FILTERING_MODES[2];
            showToast(`وضع التصفية الحالي: ${info.label}`);
        }
        refreshTabRequests();
    } catch (err) {
        showToast(err.message || 'حدث خطأ في تطبيق وضع التصفية', true);
    }
}

function updateFilteringModeUI(mode) {
    const thumb = document.getElementById('mode-slider-thumb');
    const descEl = document.getElementById('filtering-mode-desc');

    if (thumb) {
        thumb.style.transform = `translateX(${mode * 100}%)`;
        if (mode === 0) {
            thumb.style.background = '#94a3b8';
        } else if (mode === 1) {
            thumb.style.background = 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)';
        } else if (mode === 2) {
            thumb.style.background = 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)';
        } else if (mode === 3) {
            thumb.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
        }
    }

    document.querySelectorAll('.mode-step-btn').forEach(btn => {
        const btnMode = Number(btn.dataset.mode);
        btn.classList.toggle('active', btnMode === mode);
    });

    if (descEl && FILTERING_MODES[mode]) {
        descEl.textContent = FILTERING_MODES[mode].title;
    }

    // Keep the simple power controls in sync.
    const toggle = document.getElementById('adblock-toggle');
    const isEffectivelyOn = adBlockEnabled && mode > 0;
    if (toggle) {
        toggle.textContent = isEffectivelyOn ? 'إيقاف الحماية' : 'تشغيل الحماية';
        toggle.classList.toggle('off', !isEffectivelyOn);
        toggle.setAttribute('aria-pressed', String(isEffectivelyOn));
    }
    const homeToggle = document.getElementById('home-adblock-toggle');
    if (homeToggle) {
        homeToggle.textContent = isEffectivelyOn ? 'الدرع يعمل' : 'الدرع متوقف';
        homeToggle.classList.toggle('off', !isEffectivelyOn);
        homeToggle.setAttribute('aria-pressed', String(isEffectivelyOn));
        homeToggle.title = isEffectivelyOn ? 'اضغط لإيقاف الدرع' : 'اضغط لتشغيل الدرع';
    }

    const iconBadge = document.getElementById('shield-icon-badge');
    if (iconBadge) {
        iconBadge.classList.toggle('off', !isEffectivelyOn);
        iconBadge.innerHTML = '<svg class="icon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
    }

    const statusTag = document.getElementById('shield-status-tag');
    if (statusTag) {
        statusTag.classList.toggle('off', !isEffectivelyOn);
        statusTag.innerHTML = isEffectivelyOn
            ? `<span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:currentColor;"></span><span>الحماية نشطة (${(FILTERING_MODES[mode] || {}).label || ''})</span>`
            : `<span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:currentColor;"></span><span>الحماية متوقفة</span>`;
    }
}

// On-Site Tools Setup (⚡ Remove element, 🛡️ Custom filter, 💬 Report)
function setupOnSiteTools() {
    const zapperBtn = document.getElementById('btn-zapper-tool');
    if (zapperBtn) {
        zapperBtn.addEventListener('click', () => {
            if (!currentTabId) return;
            chrome.tabs.sendMessage(currentTabId, { action: 'startElementZapper' }, () => {
                window.close(); // Close popup so user can immediately click on any element
            });
        });
    }

    const customFilterBtn = document.getElementById('btn-custom-filter-tool');
    if (customFilterBtn) {
        customFilterBtn.addEventListener('click', () => {
            const input = document.getElementById('custom-domain-input');
            if (input) {
                input.value = currentSiteHost || '';
                input.focus();
                input.scrollIntoView({ behavior: 'smooth' });
            }
        });
    }

    const reportBtn = document.getElementById('btn-report-tool');
    if (reportBtn) {
        reportBtn.addEventListener('click', () => {
            showToast(`تم تسجيل فحص الموقع: ${currentSiteHost || 'الموقع الحالي'}`);
        });
    }
}

function updateAdBlockHeroUI() {
    const hostEl = document.getElementById('current-site-host');
    if (hostEl) {
        hostEl.textContent = currentSiteHost || 'لا توجد صفحة نشطة';
        hostEl.title = currentSiteHost;
    }
    const homeHost = document.getElementById('home-site-host');
    if (homeHost) homeHost.textContent = currentSiteHost || 'لا توجد صفحة نشطة';
    const homeState = document.getElementById('home-adblock-toggle');
    const protectionOn = adBlockEnabled && currentFilteringMode > 0;
    if (homeState) {
        homeState.textContent = protectionOn ? 'الدرع يعمل' : 'الدرع متوقف';
        homeState.classList.toggle('off', !protectionOn);
        homeState.setAttribute('aria-pressed', String(protectionOn));
        homeState.title = protectionOn ? 'اضغط لإيقاف الدرع' : 'اضغط لتشغيل الدرع';
    }
    updateFilteringModeUI(currentFilteringMode);
}

// --- Live Request Logger & Inspector ---
async function refreshTabRequests() {
    if (!currentTabId || currentTabId <= 0) return;

    try {
        const response = await sendExtensionAction({
            action: 'getTabRequests',
            tabId: currentTabId
        });

        if (response && response.success) {
            tabRequestsData = response.requests || [];
            tabRequestsStats = response.stats || { total: 0, blocked: 0, allowed: 0, thirdParty: 0 };

            const homeBlocked = document.getElementById('home-blocked-count');
            if (homeBlocked) homeBlocked.textContent = formatCount(tabRequestsStats.blocked);

            // Update stats grid
            const blockedVal = document.getElementById('page-blocked-count');
            const allowedVal = document.getElementById('page-allowed-count');
            const skippedVal = document.getElementById('page-skipped-count');

            if (blockedVal) blockedVal.textContent = formatCount(tabRequestsStats.blocked);
            if (allowedVal) allowedVal.textContent = formatCount(tabRequestsStats.allowed);

            // Fetch video ads skipped count from session
            chrome.storage.local.get(['adblock_session_stats'], (data) => {
                const s = data.adblock_session_stats || {};
                if (skippedVal) skippedVal.textContent = formatCount(s.totalSkipped || 0);
            });

            // Update filter pill counts
            const pillAll = document.getElementById('pill-all');
            const pillBlocked = document.getElementById('pill-blocked');
            const pillAllowed = document.getElementById('pill-allowed');
            const pill3p = document.getElementById('pill-3p');

            if (pillAll) pillAll.textContent = `الكل (${formatCount(tabRequestsStats.total)})`;
            if (pillBlocked) pillBlocked.textContent = `محظور (${formatCount(tabRequestsStats.blocked)})`;
            if (pillAllowed) pillAllowed.textContent = `مسموح (${formatCount(tabRequestsStats.allowed)})`;
            if (pill3p) pill3p.textContent = `طرف ثالث (${formatCount(tabRequestsStats.thirdParty)})`;

            renderRequestLogger();
        }
    } catch (_) {
        // Tab might not be accessible
    }
}

function setupLoggerFiltersAndSearch() {
    // Filter Pills
    document.querySelectorAll('.filter-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            activeLoggerFilter = pill.dataset.filter || 'all';
            renderRequestLogger();
        });
    });

    // Search input
    const searchInput = document.getElementById('logger-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            loggerSearchQuery = e.target.value.toLowerCase().trim();
            renderRequestLogger();
        });
    }

    // Refresh & Clear
    const refreshBtn = document.getElementById('btn-refresh-logger');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            refreshTabRequests();
            showToast('تم تحديث سجل الطلبات');
        });
    }

    const clearBtn = document.getElementById('btn-clear-logger');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            if (!currentTabId) return;
            await sendExtensionAction({ action: 'clearTabRequests', tabId: currentTabId });
            tabRequestsData = [];
            tabRequestsStats = { total: 0, blocked: 0, allowed: 0, thirdParty: 0 };
            renderRequestLogger();
            showToast('تم مسح سجل طلبات الصفحة');
        });
    }

    // Block Domain click inside logger
    const listEl = document.getElementById('logger-request-list');
    if (listEl) {
        listEl.addEventListener('click', async (e) => {
            const blockBtn = e.target.closest('[data-block-domain]');
            if (!blockBtn) return;
            const domain = blockBtn.dataset.blockDomain;
            if (!domain) return;
            blockBtn.disabled = true;
            blockBtn.textContent = 'جارٍ الحظر…';
            try {
                const res = await sendExtensionAction({ action: 'blockDomainFromLogger', domain });
                if (!res.success) throw new Error(res.error || 'تعذر حظر النطاق');
                renderCustomDomains(res.domains);
                showToast(`تم حظر النطاق: ${domain}`);
                refreshTabRequests();
            } catch (err) {
                showToast(err.message || 'حدث خطأ أثناء حظر النطاق', true);
                blockBtn.disabled = false;
                blockBtn.textContent = '+ حظر';
            }
        });
    }
}

function renderRequestLogger() {
    const listEl = document.getElementById('logger-request-list');
    if (!listEl) return;

    let filtered = tabRequestsData.slice();

    // 1. Filter by status / 3p
    if (activeLoggerFilter === 'blocked') {
        filtered = filtered.filter(r => r.status === 'blocked');
    } else if (activeLoggerFilter === 'allowed') {
        filtered = filtered.filter(r => r.status === 'allowed');
    } else if (activeLoggerFilter === '3p') {
        filtered = filtered.filter(r => r.isThirdParty);
    }

    // 2. Filter by search query
    if (loggerSearchQuery) {
        filtered = filtered.filter(r => {
            return (r.domain && r.domain.includes(loggerSearchQuery)) ||
                   (r.url && r.url.toLowerCase().includes(loggerSearchQuery)) ||
                   (r.type && r.type.toLowerCase().includes(loggerSearchQuery));
        });
    }

    listEl.replaceChildren();

    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'logger-empty-msg';
        empty.innerHTML = tabRequestsData.length === 0
            ? `جارٍ رصد طلبات الشبكة…<br><small style="color:var(--text-sub); display:block; margin-top:4px;">أعد تحميل الصفحة لرصد الطلبات منذ بدايتها</small>`
            : `لا توجد طلبات تطابق التصفية الحالية.`;
        listEl.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();

    filtered.slice(0, 150).forEach(req => {
        const row = document.createElement('div');
        row.className = 'req-row';

        const isBlocked = req.status === 'blocked';
        const statusBadgeClass = isBlocked ? 'blocked' : 'allowed';
        const statusLabel = isBlocked ? 'محظور' : 'مسموح';

        let pathDisplay = '';
        try {
            const u = new URL(req.url);
            pathDisplay = u.pathname + u.search;
        } catch (_) {
            pathDisplay = req.url;
        }

        row.innerHTML = `
            <div class="req-top-line">
                <div class="req-badges">
                    <span class="req-status-badge ${statusBadgeClass}">${statusLabel}</span>
                    <span class="req-type-badge">${escapeHtml(translateRequestType(req.type))}</span>
                    ${req.isThirdParty ? '<span class="req-3p-badge">طرف ثالث</span>' : ''}
                </div>
                ${!isBlocked && req.isThirdParty && req.domain ? `
                    <button type="button" class="req-block-btn" data-block-domain="${escapeHtml(req.domain)}" title="حظر النطاق ${escapeHtml(req.domain)}">+ حظر النطاق</button>
                ` : ''}
            </div>
            <div class="req-domain" title="${escapeHtml(req.url)}">${escapeHtml(req.domain || 'غير معروف')}</div>
            <div class="req-url-snippet" title="${escapeHtml(req.url)}">${escapeHtml(pathDisplay)}</div>
            <div class="req-bottom-line">
                <span class="req-reason">${escapeHtml(req.reason === 'Ledo Shield Engine' ? 'محرك درع ليدو' : (req.reason || (isBlocked ? 'قواعد درع ليدو' : 'طلب مسموح به')))}</span>
                <span>${escapeHtml(req.method || 'GET')}</span>
            </div>
        `;

        fragment.appendChild(row);
    });

    listEl.appendChild(fragment);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function translateRequestType(type) {
    const labels = {
        main_frame: 'الصفحة', sub_frame: 'إطار', script: 'سكريبت', image: 'صورة',
        stylesheet: 'تنسيق', xmlhttprequest: 'طلب بيانات', ping: 'إشارة تتبع',
        media: 'وسائط', font: 'خط', object: 'عنصر', websocket: 'اتصال مباشر', other: 'أخرى'
    };
    return labels[String(type || '').toLowerCase()] || String(type || 'أخرى');
}

function translateMediaType(type) {
    return ({ video: 'فيديو', audio: 'صوت', file: 'ملف' })[String(type || '').toLowerCase()] || 'وسائط';
}

// --- Module Toggles ---
function setupModuleToggles(settings) {
    // YouTube Ads Toggle
    const ytToggle = document.getElementById('toggle-youtube-ads');
    if (ytToggle) {
        ytToggle.checked = settings.adblock_youtube_ads !== false;
        ytToggle.addEventListener('change', async () => {
            await sendExtensionAction({ action: 'setYouTubeAds', enabled: ytToggle.checked });
            showToast(ytToggle.checked ? 'تم تفعيل تجاوز إعلانات يوتيوب' : 'تم إيقاف تجاوز إعلانات يوتيوب');
        });
    }

    // Social Media Ads Toggle
    const socialToggle = document.getElementById('toggle-social-ads');
    if (socialToggle) {
        socialToggle.checked = settings.adblock_social_ads !== false;
        socialToggle.addEventListener('change', async () => {
            await sendExtensionAction({ action: 'setSocialAds', enabled: socialToggle.checked });
            showToast(socialToggle.checked ? 'تم تفعيل تنظيف خلاصات التواصل' : 'تم إيقاف تنظيف خلاصات التواصل');
        });
    }

    // Cosmetic Elements Toggle
    const cosmeticToggle = document.getElementById('cosmetic-filter-toggle');
    if (cosmeticToggle) {
        cosmeticToggle.checked = settings.adblock_cosmetic_enabled !== false;
        cosmeticToggle.addEventListener('change', async () => {
            await chrome.storage.local.set({ adblock_cosmetic_enabled: cosmeticToggle.checked });
            showToast(cosmeticToggle.checked ? 'تم تفعيل إخفاء مساحات الإعلانات' : 'تم إيقاف إخفاء مساحات الإعلانات');
        });
    }

    // Anti-Adblock Defuser Toggle
    const antiToggle = document.getElementById('toggle-anti-adblock');
    if (antiToggle) {
        antiToggle.checked = settings.adblock_anti_adblock !== false;
        antiToggle.addEventListener('change', async () => {
            await chrome.storage.local.set({ adblock_anti_adblock: antiToggle.checked });
            showToast(antiToggle.checked ? 'تم تفعيل التعامل مع تنبيهات الحظر' : 'تم إيقاف التعامل مع تنبيهات الحظر');
        });
    }
}

// --- Filter Lists Management (uBlock + EasyList) ---
function setupFilterListCheckboxes(settings) {
    const current = {
        ublock_filters: true,
        easylist: true,
        easyprivacy: true,
        peter_lowe: true,
        fanboy_social: true,
        ublock_badware: true,
        turtlecute_test: true,
        hagezi_pro_mini: true,
        ...(settings.adblock_filter_lists || {})
    };

    const controls = [
        ['ublock_filters', document.getElementById('filter-ublock-filters'), 'قواعد درع ليدو الفورية'],
        ['easylist', document.getElementById('filter-easylist'), 'قواعد التصفية العامة'],
        ['easyprivacy', document.getElementById('filter-easyprivacy'), 'قواعد حماية الخصوصية'],
        ['peter_lowe', document.getElementById('filter-peter-lowe'), 'قاعدة خوادم الإعلانات'],
        ['fanboy_social', document.getElementById('filter-fanboy-social'), 'حظر عناصر التواصل'],
        ['ublock_badware', document.getElementById('filter-ublock-badware'), 'قواعد البرمجيات الخبيثة'],
        ['turtlecute_test', document.getElementById('filter-turtlecute-test'), 'قائمة اختبار Turtlecute'],
        ['hagezi_pro_mini', document.getElementById('filter-hagezi-pro-mini'), 'HaGeZi Multi PRO mini']
    ];

    controls.forEach(([listKey, checkbox, displayName]) => {
        if (!checkbox) return;
        checkbox.checked = current[listKey] !== false;
        checkbox.addEventListener('change', async () => {
            checkbox.disabled = true;
            setFilterStatusMessage(`جارٍ تطبيق ${displayName}…`);
            try {
                const res = await sendExtensionAction({
                    action: 'setAdFilterList',
                    list: listKey,
                    enabled: checkbox.checked
                });
                if (!res.success) throw new Error(res.error || 'تعذر تحديث قائمة القواعد');
                const latest = await chrome.storage.local.get([
                    'adblock_filter_lists', 'adblock_filters_updated_at',
                    'adblock_filters_active_count', 'adblock_filters_error', 'adblock_cosmetic_count'
                ]);
                updateFilterStatusDisplay(latest);
                showToast(`${displayName}: ${checkbox.checked ? 'مفعّلة' : 'متوقفة'}`);
            } catch (err) {
                checkbox.checked = !checkbox.checked;
                setFilterStatusMessage(err.message || 'حدث خطأ أثناء تحديث القائمة', true);
                showToast(err.message || 'حدث خطأ أثناء تحديث القائمة', true);
            } finally {
                checkbox.disabled = false;
            }
        });
    });
}

function updateFilterStatusDisplay(settings) {
    const count = Number(settings.adblock_filters_active_count);
    const updated = settings.adblock_filters_updated_at
        ? new Date(settings.adblock_filters_updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : 'القواعد المدمجة';

    const error = settings.adblock_filters_error ? ` · خطأ تحديث: ${settings.adblock_filters_error}` : '';
    const networkCount = Number.isFinite(count) && count >= 0 ? formatCount(count) : 'لم تُحمّل بعد';
    const cosmeticCount = Number(settings.adblock_cosmetic_count);
    const cosmeticLabel = Number.isFinite(cosmeticCount) ? ` · ${formatCount(cosmeticCount)} قاعدة لإخفاء العناصر` : '';
    setFilterStatusMessage(`نشطة: ${networkCount} قاعدة شبكية${cosmeticLabel} · آخر تحديث ${updated}${error}`, Boolean(settings.adblock_filters_error));

    // Settings session count
    const filtersCountEl = document.getElementById('session-filters-count');
    if (filtersCountEl) filtersCountEl.textContent = Number.isFinite(count) ? formatCount(count) : '—';
    const homeRulesCount = document.getElementById('home-rules-count');
    if (homeRulesCount) homeRulesCount.textContent = Number.isFinite(count) ? formatCount(count) : '—';
}

function setFilterStatusMessage(text, isError = false) {
    const status = document.getElementById('filter-update-status');
    if (!status) return;
    status.textContent = text;
    status.style.color = isError ? 'var(--danger)' : 'var(--text-muted)';
}

// --- Custom Blocked Domains ---
async function addCustomDomainFromInput() {
    const input = document.getElementById('custom-domain-input');
    const button = document.getElementById('btn-add-custom-domain');
    if (!input || !button) return;

    const domain = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[\/:?#]/)[0];
    if (!domain) return;

    const stored = await chrome.storage.local.get('adblock_custom_domains');
    const existing = Array.isArray(stored.adblock_custom_domains) ? stored.adblock_custom_domains : [];
    if (existing.includes(domain)) {
        showToast(`النطاق ${domain} موجود بالفعل في قائمة الحظر`);
        return;
    }

    button.disabled = true;
    try {
        const result = await sendExtensionAction({ action: 'toggleCustomAdBlockDomain', hostname: domain });
        if (!result.success) throw new Error(result.error || 'تعذرت إضافة النطاق');
        renderCustomDomains(result.domains);
        input.value = '';
        showToast(`تم حظر النطاق: ${result.domain}`);
        refreshTabRequests();
    } catch (err) {
        showToast(err.message || 'أدخل اسم نطاق صالحاً', true);
    } finally {
        button.disabled = false;
    }
}

function renderCustomDomains(domains) {
    const list = document.getElementById('custom-domain-list');
    if (!list) return;
    list.replaceChildren();

    if (!domains.length) {
        const empty = document.createElement('div');
        empty.style.fontSize = '10px';
        empty.style.color = 'var(--text-sub)';
        empty.style.padding = '4px 0';
        empty.textContent = 'لا توجد نطاقات مضافة للحظر.';
        list.appendChild(empty);
        return;
    }

    domains.forEach(domain => {
        const row = document.createElement('div');
        row.className = 'custom-domain-row';
        row.innerHTML = `
            <span>${escapeHtml(domain)}</span>
            <button type="button" data-remove-domain="${escapeHtml(domain)}">إزالة</button>
        `;
        list.appendChild(row);
    });
}

function loadLifetimeStats(settings) {
    const stats = settings.adblock_session_stats || { totalBlocked: 0, totalSkipped: 0 };
    const totalBlocked = Math.max(0, Number(stats.totalBlocked) || 0);
    const totalSkipped = Math.max(0, Number(stats.totalSkipped) || 0);
    const blockedEl = document.getElementById('session-blocked-count');
    const skippedEl = document.getElementById('session-skipped-count');
    if (blockedEl) blockedEl.textContent = formatCount(totalBlocked);
    if (skippedEl) skippedEl.textContent = formatCount(totalSkipped);

    // Estimates are intentionally disclosed in the UI; the extension does not
    // receive byte-size metadata for requests blocked before download.
    const dataSavedEl = document.getElementById('estimated-data-saved');
    const timeSavedEl = document.getElementById('estimated-time-saved');
    if (dataSavedEl) {
        const estimatedMb = totalBlocked * 0.25;
        dataSavedEl.textContent = `${estimatedMb < 10 ? estimatedMb.toFixed(2) : Math.round(estimatedMb).toLocaleString()} MB`;
    }
    if (timeSavedEl) {
        const seconds = totalSkipped * 15;
        if (seconds < 60) timeSavedEl.textContent = `${formatCount(seconds)} ث`;
        else if (seconds < 3600) timeSavedEl.textContent = `${Math.floor(seconds / 60)} د ${seconds % 60} ث`;
        else timeSavedEl.textContent = `${Math.floor(seconds / 3600)} س ${Math.floor((seconds % 3600) / 60)} د`;
    }

    const achievementList = document.getElementById('achievement-list');
    if (achievementList) {
        const achievements = [
            { icon: '🛡️', name: 'بداية الحماية', detail: 'حظر 10 عناصر', value: totalBlocked, target: 10 },
            { icon: '🎯', name: 'صائد الإعلانات', detail: 'حظر 100 عنصر', value: totalBlocked, target: 100 },
            { icon: '🏅', name: 'درع ليدو', detail: 'حظر 1,000 عنصر', value: totalBlocked, target: 1000 },
            { icon: '⏭️', name: 'أول تخطٍ', detail: 'تجاوز إعلان فيديو', value: totalSkipped, target: 1 },
            { icon: '🚀', name: 'قاهر الإعلانات', detail: 'تجاوز 25 إعلان فيديو', value: totalSkipped, target: 25 }
        ];
        achievementList.innerHTML = achievements.map(item => {
            const progress = Math.min(100, (item.value / item.target) * 100);
            const earned = item.value >= item.target;
            return `<div class="achievement-item${earned ? '' : ' locked'}">
                <span class="achievement-icon" aria-hidden="true">${item.icon}</span>
                <div class="achievement-copy"><strong>${item.name}</strong><small>${item.detail} · ${formatCount(Math.min(item.value, item.target))}/${formatCount(item.target)}</small>
                    <div class="achievement-progress" aria-label="التقدم ${Math.round(progress)} بالمئة"><span style="width:${progress}%"></span></div>
                </div>
                <span class="achievement-state">${earned ? 'مكتمل ✓' : 'قيد التقدم'}</span>
            </div>`;
        }).join('');
    }
}

document.getElementById('achievement-toggle')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    const list = document.getElementById('achievement-list');
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    list.hidden = expanded;
    button.textContent = expanded ? '🏆 عرض الإنجازات' : '🏆 إخفاء الإنجازات';
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.adblock_session_stats) {
        loadLifetimeStats({ adblock_session_stats: changes.adblock_session_stats.newValue });
    }
});

function formatCount(value) {
    return (Number(value) || 0).toLocaleString();
}

function sendExtensionAction(payload) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(payload, response => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(response || { success: false, error: 'لا توجد استجابة من خدمة الإضافة' });
        });
    });
}

// ========================================================================
//  DOWNLOADER APP INTEGRATION & MEDIA SNIFFER
// ========================================================================
async function checkAppStatus() {
    try {
        const response = await fetch(`${API_BASE}/health`, { method: 'GET', mode: 'cors' });
        if (response.ok) {
            setAppOnline(true);
            fetchActiveDownloads();
        } else {
            setAppOnline(false);
        }
    } catch (_) {
        setAppOnline(false);
    }
}

function setAppOnline(online) {
    isAppOnline = online;
    if (online) {
        statusIndicator.classList.add('online');
        if (appStatusText) appStatusText.textContent = 'متصل';
        document.getElementById('status-offline').style.display = 'none';
        document.getElementById('status-stats').style.display = 'block';
    } else {
        chrome.action.setBadgeText({ text: '' });
        statusIndicator.classList.remove('online');
        if (appStatusText) appStatusText.textContent = 'غير متصل';
        document.getElementById('status-offline').style.display = 'flex';
        document.getElementById('status-stats').style.display = 'none';
    }
}

async function fetchActiveDownloads() {
    if (!isAppOnline) return;
    try {
        const response = await fetch(`${API_BASE}/downloads`);
        if (response.ok) {
            const downloads = await response.json();
            renderActiveDownloads(downloads.filter(item =>
                ['downloading', 'starting', 'processing', 'paused', 'error'].includes(item.status)
            ));
        }
    } catch (_) {}
}

function formatBytes(bytes) {
    if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(Number(bytes)) / Math.log(1024)), units.length - 1);
    return `${(Number(bytes) / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function renderActiveDownloads(downloads) {
    const list = document.getElementById('active-list');
    if (!list) return;

    const speed = downloads
        .filter(item => ['downloading', 'processing'].includes(item.status))
        .reduce((sum, item) => sum + (Number(item.speed) || 0), 0);
    const activeCount = downloads.filter(item => ['downloading', 'processing'].includes(item.status)).length;
    const queuedCount = downloads.filter(item => item.status === 'starting').length;

    const summaryEl = document.getElementById('active-summary');
    const speedEl = document.getElementById('total-speed');
    if (summaryEl) summaryEl.textContent = `${activeCount} نشط · ${queuedCount} في الانتظار`;
    if (speedEl) speedEl.textContent = `${formatBytes(speed)}/s`;

    chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
    chrome.action.setBadgeText({ text: downloads.length ? (downloads.length > 99 ? '99+' : String(downloads.length)) : '' });
    list.replaceChildren();

    if (!downloads.length) {
        const empty = document.createElement('div');
        empty.style.padding = '20px 8px';
        empty.style.textAlign = 'center';
        empty.style.color = 'var(--text-muted)';
        empty.style.fontSize = '11px';
        empty.textContent = 'لا توجد تنزيلات نشطة حالياً.';
        list.appendChild(empty);
        return;
    }

    downloads.slice(0, 10).forEach(download => {
        const item = document.createElement('article');
        item.className = 'task-item';

        const head = document.createElement('div');
        head.className = 'task-head';
        const name = document.createElement('span');
        name.className = 'task-name';
        name.textContent = download.filename || download.url || 'تنزيل';
        name.title = name.textContent;
        const state = document.createElement('span');
        state.className = `task-state ${download.status}`;
        state.textContent = ({ downloading: 'جارٍ التنزيل', starting: 'قيد التجهيز', processing: 'جارٍ المعالجة', paused: 'متوقف مؤقتاً', error: 'حدث خطأ', completed: 'اكتمل' })[download.status] || 'غير معروف';
        head.append(name, state);

        const progress = document.createElement('div');
        progress.className = 'task-progress';
        const fill = document.createElement('span');
        fill.style.width = `${Math.max(0, Math.min(100, Number(download.progress) || 0))}%`;
        progress.appendChild(fill);

        const meta = document.createElement('div');
        meta.className = 'task-meta';
        const byteText = document.createElement('span');
        byteText.textContent = `${formatBytes(download.downloaded)} / ${download.total_size ? formatBytes(download.total_size) : 'غير معروف'}`;
        const pctText = document.createElement('span');
        pctText.textContent = `${(Number(download.progress) || 0).toFixed(1)}% · ${formatBytes(download.speed)}/s`;
        meta.append(byteText, pctText);

        const actions = document.createElement('div');
        actions.className = 'task-actions';
        if (download.status === 'error' || download.status === 'paused') {
            actions.appendChild(createTaskAction('استئناف', 'resume', download.id));
        } else if (['downloading', 'starting'].includes(download.status)) {
            actions.appendChild(createTaskAction('إيقاف مؤقت', 'pause', download.id));
        }
        actions.appendChild(createTaskAction('إلغاء', 'cancel', download.id, true));
        item.append(head, progress, meta, actions);
        list.appendChild(item);
    });
}

function createTaskAction(label, action, id, isDanger = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `task-action${isDanger ? ' danger' : ''}`;
    button.dataset.action = action;
    button.dataset.id = id;
    button.textContent = label;
    return button;
}

document.getElementById('active-list')?.addEventListener('click', async event => {
    const button = event.target.closest('.task-action');
    if (!button) return;
    button.disabled = true;
    const endpoint = button.dataset.action === 'cancel'
        ? `${API_BASE}/cancel/${encodeURIComponent(button.dataset.id)}`
        : `${API_BASE}/${button.dataset.action}/${encodeURIComponent(button.dataset.id)}`;
    try {
        const response = await fetch(endpoint, { method: button.dataset.action === 'cancel' ? 'DELETE' : 'POST' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        showToast(`تم تنفيذ: ${button.textContent}`);
        setTimeout(fetchActiveDownloads, 500);
    } catch (_) {
        showToast('تعذر تحديث التنزيل', true);
        button.disabled = false;
    }
});

// --- Toast Feedback ---
function showToast(message, isError = false) {
    if (!toastEl) return;
    toastEl.innerText = message;
    toastEl.classList.toggle('error', isError);
    toastEl.classList.add('show');
    setTimeout(() => {
        toastEl.classList.remove('show');
    }, 2800);
}

// --- Send Download Request ---
function cleanUrl(url) {
    try {
        const urlObj = new URL(url);
        if (urlObj.hostname.includes('youtube.com') && urlObj.pathname === '/watch') {
            const videoId = urlObj.searchParams.get('v');
            if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
        }
        if (urlObj.hostname.includes('facebook.com') && (urlObj.pathname.includes('/watch') || urlObj.pathname.includes('/videos/'))) {
            return `${urlObj.origin}${urlObj.pathname}`;
        }
        if (urlObj.hostname.includes('tiktok.com') && urlObj.pathname.includes('/video/')) {
            return `${urlObj.origin}${urlObj.pathname}`;
        }
    } catch (_) {}
    return url;
}

async function sendToDesktop(rawUrl, quality = 'best', isYtDlp = true, quiet = false) {
    if (!isAppOnline) {
        showToast("تعذر الاتصال بتطبيق ليدو", true);
        return false;
    }
    const url = cleanUrl(rawUrl);
    try {
        const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                action: 'directDownload',
                url,
                quality,
                is_yt_dlp: isYtDlp,
                referer: currentTabUrl
            }, res => {
                if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                else resolve(res);
            });
        });
        if (!response?.success) throw new Error(response?.error || 'تعذرت إضافة التنزيل إلى القائمة');
        if (!quiet) showToast("تمت إضافة التنزيل إلى ليدو");
        return true;
    } catch (err) {
        if (!quiet) showToast(err.message || "فشل الاتصال", true);
        return false;
    }
}

// Quality Pickers on Current Tab
document.querySelectorAll('.current-quality-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        if (!currentTabUrl || btn.disabled) return;
        const quality = btn.getAttribute('data-quality');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.textContent = 'جارٍ الإرسال…';
        const sent = await sendToDesktop(currentTabUrl, quality);
        if (!sent) {
            btn.innerHTML = originalText;
            btn.disabled = false;
            return;
        }
        btn.innerHTML = 'تمت الإضافة';
        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }, 1800);
    });
});

// --- Media Sniffer ---
let hasSniffed = false;

function sniffMedia(tabIdOverride = null, force = false) {
    if (hasSniffed && !force) return;
    if (force) hasSniffed = false;

    const loader = document.getElementById('sniffer-loader');
    const empty = document.getElementById('sniffer-empty');
    const mediaListEl = document.getElementById('media-list');
    const downloadAllBtn = document.getElementById('btn-download-all');

    if (loader) loader.style.display = 'block';
    if (empty) empty.style.display = 'none';
    if (mediaListEl) mediaListEl.replaceChildren();
    if (downloadAllBtn) downloadAllBtn.disabled = true;

    const executeSniff = (tabId) => {
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: detectMediaOnPage,
            args: [currentTabUrl || '']
        }, (results) => {
            hasSniffed = true;
            if (loader) loader.style.display = 'none';

            if (chrome.runtime.lastError || !results || !results[0].result || results[0].result.length === 0) {
                foundMediaItems = [];
                if (downloadAllBtn) downloadAllBtn.disabled = true;
                if (empty) empty.style.display = 'block';
                return;
            }

            foundMediaItems = results[0].result;
            if (downloadAllBtn) downloadAllBtn.disabled = false;
            renderSniffedMedia(foundMediaItems);
        });
    };

    if (tabIdOverride) {
        executeSniff(tabIdOverride);
    } else {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs.length > 0 && !tabs[0].url.startsWith('chrome://')) {
                executeSniff(tabs[0].id);
            } else {
                if (loader) loader.style.display = 'none';
                if (empty) empty.style.display = 'block';
            }
        });
    }
}

document.getElementById('btn-rescan')?.addEventListener('click', () => {
    if (currentTabId) sniffMedia(currentTabId, true);
});

document.getElementById('btn-download-all')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!foundMediaItems.length) return;
    btn.disabled = true;
    const originalText = btn.textContent;
    let sentCount = 0;
    for (const item of foundMediaItems) {
        const directFile = item.type === 'file';
        if (await sendToDesktop(item.url, 'best', !directFile, true)) sentCount += 1;
        await new Promise(r => setTimeout(r, 150));
    }
    showToast(`تمت إضافة ${sentCount} من أصل ${foundMediaItems.length} وسائط إلى قائمة التنزيل`);
    btn.textContent = `${sentCount}/${foundMediaItems.length} تم إرسالها`;
    setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
    }, 2000);
});

// Executed in webpage context
function detectMediaOnPage(pageUrl = '') {
    const list = [];
    document.querySelectorAll('video').forEach((vid, i) => {
        const src = vid.currentSrc || vid.src;
        if (src && !src.startsWith('blob:')) {
            list.push({ url: src, type: 'video', title: document.title || `فيديو ${i + 1}` });
        }
        vid.querySelectorAll('source').forEach(s => {
            if (s.src) list.push({ url: s.src, type: 'video', title: document.title || `مصدر فيديو ${i + 1}` });
        });
    });

    document.querySelectorAll('audio').forEach((aud, i) => {
        const src = aud.currentSrc || aud.src;
        if (src && !src.startsWith('blob:')) {
            list.push({ url: src, type: 'audio', title: document.title || `صوت ${i + 1}` });
        }
    });

    document.querySelectorAll('a[href]').forEach(a => {
        try {
            const p = new URL(a.href).pathname.toLowerCase();
            if (p.match(/\.(mp4|webm|mkv|avi|mov|m3u8|mpd)$/)) {
                list.push({ url: a.href, type: 'video', title: a.innerText || 'رابط فيديو' });
            } else if (p.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/)) {
                list.push({ url: a.href, type: 'audio', title: a.innerText || 'رابط صوت' });
            } else if (p.match(/\.(zip|rar|7z|tar|gz|exe|msi|dmg|apk|pdf)$/)) {
                list.push({ url: a.href, type: 'file', title: a.innerText || 'رابط ملف' });
            }
        } catch (_) {}
    });

    // Stream players (including YouTube) commonly expose only a blob: currentSrc.
    // Ask yt-dlp to resolve the page URL instead of trying to download that blob.
    try {
        const page = new URL(pageUrl || location.href);
        const host = page.hostname.toLowerCase();
        const supportedPage = /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$|(^|\.)facebook\.com$|(^|\.)fb\.watch$|(^|\.)tiktok\.com$|(^|\.)vimeo\.com$|(^|\.)instagram\.com$|(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host);
        if (supportedPage && (document.querySelector('video, ytd-player, #movie_player, [data-testid="video-player"]') || /youtube|youtu\.be|fb\.watch|tiktok|vimeo|instagram|\/watch|\/videos?\//i.test(page.href))) {
            list.unshift({ url: page.href, type: 'video', title: document.title || 'فيديو من الصفحة', isPage: true });
        }
    } catch (_) {}

    const unique = [];
    const seen = new Set();
    list.forEach(item => {
        if (!seen.has(item.url) && !item.url.startsWith('blob:')) {
            seen.add(item.url);
            unique.push(item);
        }
    });
    return unique.slice(0, 15);
}

function renderSniffedMedia(items) {
    const container = document.getElementById('media-list');
    if (!container) return;
    container.replaceChildren();

    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'media-item';
        div.innerHTML = `
            <div class="media-title">${escapeHtml(item.title)}</div>
            <div class="media-meta">
                <span class="badge">${item.isPage ? 'فيديو · رابط الصفحة' : translateMediaType(item.type)}</span>
                <span style="font-family:monospace; font-size:9px; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(item.url)}</span>
            </div>
            <div style="display:flex; gap:4px; margin-top:4px;">
                <button class="btn sniffer-send-btn" data-quality="best" style="flex:1; padding:6px 4px; font-size:10px;">الأعلى</button>
                <button class="btn btn-secondary sniffer-send-btn" data-quality="720p" style="flex:1; padding:6px 4px; font-size:10px;">720p</button>
                <button class="btn btn-secondary sniffer-send-btn" data-quality="480p" style="flex:1; padding:6px 4px; font-size:10px;">480p</button>
                <button class="btn btn-secondary sniffer-send-btn" data-quality="360p" style="flex:1; padding:6px 4px; font-size:10px;">360p</button>
                <button class="btn btn-secondary sniffer-send-btn" data-quality="audio" style="flex:1; padding:6px 4px; font-size:10px; color:var(--success);">صوت فقط</button>
            </div>
        `;

        div.querySelectorAll('.sniffer-send-btn').forEach(b => {
            b.addEventListener('click', async () => {
                const q = b.dataset.quality;
                b.disabled = true;
                b.textContent = '…';
                const success = await sendToDesktop(item.url, q, item.type !== 'file');
                if (success) {
                    b.textContent = 'تم الإرسال';
                } else {
                    b.textContent = 'فشل الإرسال';
                }
                setTimeout(() => {
                    b.disabled = false;
                    b.textContent = ({ best: 'الأعلى', audio: 'صوت فقط', '720p': '720p', '480p': '480p', '360p': '360p' })[q] || q;
                }, 1600);
            });
        });

        container.appendChild(div);
    });
}

// --- Settings Logic ---
function setupSettings() {
    const toggle = document.getElementById('toggle-intercept');
    const floatingToggle = document.getElementById('toggle-floating');

    chrome.storage.local.get(['intercept_enabled', 'floating_enabled'], (res) => {
        if (toggle) toggle.checked = res.intercept_enabled !== false;
        if (floatingToggle) floatingToggle.checked = res.floating_enabled !== false;
    });

    if (toggle) {
        toggle.addEventListener('change', (e) => {
            chrome.storage.local.set({ intercept_enabled: e.target.checked }, () => {
                showToast(e.target.checked ? "تم تفعيل تحويل التنزيلات" : "تم إيقاف تحويل التنزيلات");
            });
        });
    }

    if (floatingToggle) {
        floatingToggle.addEventListener('change', (e) => {
            chrome.storage.local.set({ floating_enabled: e.target.checked }, () => {
                showToast(e.target.checked ? "تم تفعيل زر التنزيل العائم" : "تم إيقاف زر التنزيل العائم");
            });
        });
    }
}

// ==========================================
// Privacy Badger Tab Logic
// ==========================================
let badgerPollInterval = null;

function setupBadgerTab() {
    // Master toggle
    const masterToggle = document.getElementById('badger-master-toggle');
    if (masterToggle) {
        masterToggle.addEventListener('change', (e) => {
            chrome.runtime.sendMessage({
                action: 'badger_toggleSetting',
                key: 'enabled',
                value: e.target.checked
            }).catch(() => {});
            showToast(e.target.checked ? 'تم تفعيل حماية الخصوصية' : 'تم إيقاف حماية الخصوصية');
        });
    }

    // Feature toggles
    const toggleMap = {
        'badger-learning-toggle': 'learningEnabled',
        'badger-fp-toggle': 'fingerprintingEnabled',
        'badger-widgets-toggle': 'widgetsEnabled',
        'badger-gpc-toggle': 'gpcEnabled'
    };

    for (const [elId, settingKey] of Object.entries(toggleMap)) {
        const el = document.getElementById(elId);
        if (el) {
            el.addEventListener('change', (e) => {
                chrome.runtime.sendMessage({
                    action: 'badger_toggleSetting',
                    key: settingKey,
                    value: e.target.checked
                }).catch(() => {});
            });
        }
    }

    // Refresh button
    const refreshBtn = document.getElementById('badger-refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => refreshBadgerData());
    }

    // Reset learning button
    const resetBtn = document.getElementById('badger-reset-learning');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (confirm('هل تريد مسح كل بيانات التعلم الذاتي للمتتبعين؟')) {
                chrome.runtime.sendMessage({ action: 'badger_resetLearning' }, (resp) => {
                    if (resp?.success) {
                        showToast('تم مسح بيانات التعلم بنجاح');
                        refreshBadgerData();
                    }
                });
            }
        });
    }

    // Load initial toggle state from storage
    chrome.storage.local.get([
        'badger_enabled', 'badger_learning_enabled',
        'badger_fingerprinting_enabled', 'badger_widgets_enabled',
        'badger_gpc_enabled'
    ], (res) => {
        if (masterToggle) masterToggle.checked = res.badger_enabled !== false;
        const lToggle = document.getElementById('badger-learning-toggle');
        if (lToggle) lToggle.checked = res.badger_learning_enabled !== false;
        const fpToggle = document.getElementById('badger-fp-toggle');
        if (fpToggle) fpToggle.checked = res.badger_fingerprinting_enabled !== false;
        const wToggle = document.getElementById('badger-widgets-toggle');
        if (wToggle) wToggle.checked = res.badger_widgets_enabled !== false;
        const gToggle = document.getElementById('badger-gpc-toggle');
        if (gToggle) gToggle.checked = res.badger_gpc_enabled !== false;
    });
}

function refreshBadgerData() {
    if (!currentTabId) return;
    chrome.runtime.sendMessage({ action: 'badger_getTabData', tabId: currentTabId }, (resp) => {
        if (!resp?.success || !resp.data) return;
        const data = resp.data;

        // Update stats counters
        const blockedEl = document.getElementById('badger-blocked-count');
        const cookieEl = document.getElementById('badger-cookie-count');
        const allowedEl = document.getElementById('badger-allowed-count');
        if (blockedEl) blockedEl.textContent = data.tabStats?.blocked || 0;
        if (cookieEl) cookieEl.textContent = data.tabStats?.cookieblocked || 0;
        if (allowedEl) allowedEl.textContent = data.tabStats?.notBlocked || 0;

        // Seed stats
        const seedBlocked = document.getElementById('badger-seed-blocked');
        const seedCookie = document.getElementById('badger-seed-cookie');
        const seedLearned = document.getElementById('badger-seed-learned');
        if (seedBlocked) seedBlocked.textContent = data.seedStats?.blocked?.toLocaleString() || '0';
        if (seedCookie) seedCookie.textContent = data.seedStats?.cookieblocked?.toLocaleString() || '0';
        if (seedLearned) seedLearned.textContent = data.totalLearned || 0;

        // Render tracker list
        renderBadgerTrackerList(data.trackers || []);
    });
}

function renderBadgerTrackerList(trackers) {
    const container = document.getElementById('badger-tracker-list');
    if (!container) return;

    if (!trackers.length) {
        container.innerHTML = `
            <div style="text-align: center; padding: 20px 10px; color: var(--text-muted); font-size: 11px;">
                <svg style="width:25px;height:25px;margin-bottom:6px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9 2 5l5 1 5-3 5 3 5-1-2 4 1 6-4 5H7l-4-5z"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/></svg>
                <div style="font-weight: 600;">لا توجد اتصالات طرف ثالث مرصودة حتى الآن</div>
                <div style="font-size: 10px; margin-top: 4px;">قد تتغير النتيجة بعد إعادة تحميل الصفحة</div>
            </div>
        `;
        return;
    }

    // Sort: blocked first, then cookieblock, then allowed
    const order = { block: 0, cookieblock: 1, allow: 2, noaction: 3 };
    trackers.sort((a, b) => (order[a.action] ?? 3) - (order[b.action] ?? 3));

    container.innerHTML = trackers.map(t => {
        const actionColors = {
            block: { bg: '#fef2f2', border: '#fecaca', text: '#dc2626', label: 'محظور' },
            cookieblock: { bg: '#fffbeb', border: '#fde68a', text: '#f59e0b', label: 'ملفات ارتباط مقيّدة' },
            allow: { bg: '#ecfdf5', border: '#a7f3d0', text: '#10b981', label: 'مسموح' },
            noaction: { bg: '#f8fafc', border: '#e2e8f0', text: '#64748b', label: 'تلقائي' }
        };
        const style = actionColors[t.action] || actionColors.noaction;

        return `
            <div class="badger-tracker-item" style="display: flex; align-items: center; justify-content: space-between; padding: 7px 10px; margin-bottom: 4px; background: ${style.bg}; border: 1px solid ${style.border}; border-radius: 6px; font-size: 10px;">
                <div style="flex: 1; min-width: 0;">
                    <div style="display: flex; align-items: center; gap: 5px;">
                        <span aria-hidden="true" style="width:8px;height:8px;border-radius:50%;background:${style.text};display:inline-block"></span>
                    <strong style="color: var(--text-main); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(t.domain)}</strong>
                    </div>
                    <div style="color: var(--text-muted); font-size: 9px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(t.reason || '')}</div>
                </div>
                <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
                    <select class="badger-action-select" data-domain="${escapeHtml(t.domain)}" style="font-size: 9px; padding: 2px 4px; border-radius: 4px; border: 1px solid ${style.border}; background: #ffffff; color: ${style.text}; cursor: pointer; outline: none;">
                        <option value="block"${t.action === 'block' ? ' selected' : ''}>حظر</option>
                        <option value="cookieblock"${t.action === 'cookieblock' ? ' selected' : ''}>تقييد ملفات الارتباط</option>
                        <option value="allow"${t.action === 'allow' ? ' selected' : ''}>سماح</option>
                        <option value="noaction"${t.action === 'noaction' ? ' selected' : ''}>تلقائي</option>
                    </select>
                </div>
            </div>
        `;
    }).join('');

    // Attach change handlers for per-tracker action selects
    container.querySelectorAll('.badger-action-select').forEach(select => {
        select.addEventListener('change', (e) => {
            const domain = e.target.dataset.domain;
            const action = e.target.value;
            chrome.runtime.sendMessage({
                action: 'badger_setUserAction',
                domain: domain,
                trackerAction: action
            }, (resp) => {
                if (resp?.success) {
                    showToast(`تم تحديث إعداد ${domain}`);
                    setTimeout(() => refreshBadgerData(), 500);
                }
            });
        });
    });
}
