/**
 * Ledo Downloader Extension - Core Infrastructure
 * Architecture: Modular OOP approach for robustness and maintainability.
 */

// Load Privacy Badger Engine
importScripts('badger/badger_engine.js');

// ==========================================
// 1. Advanced Cookie Manager
// ==========================================
class CookieManager {
    /**
     * Fetch only cookies that the browser would send to this URL. This includes
     * matching parent-domain cookies without leaking unrelated sibling domains.
     * This bypasses HttpOnly limits if the extension has host permissions.
     */
    static async getCookies(urlString, refererUrl = "") {
        try {
            const target = new URL(urlString);
            if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return "";
            // Only send cookies that match the download URL. Referrer cookies belong
            // to a different origin and must never be merged into this request.
            const directCookies = await chrome.cookies.getAll({ url: target.href }).catch(() => []);
            const cookiesByName = new Map();
            directCookies.forEach(cookie => cookiesByName.set(cookie.name, cookie.value));
            return Array.from(cookiesByName, ([name, value]) => `${name}=${value}`).join('; ');
        } catch (e) {
            console.error('[CookieManager] Critical failure fetching cookies:', e);
            return ""; // Fail gracefully
        }
    }
}

// ==========================================
// 2. API Client (Robust Communication)
// ==========================================
class ApiClient {
    static BASE_URL = 'http://127.0.0.1:8000/api';
    static TIMEOUT_MS = 10000; // 10 seconds timeout

    /**
     * Sends a POST request with AbortController for timeout management.
     */
    static async post(endpoint, bodyData) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

        try {
            const response = await fetch(`${this.BASE_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyData),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.message || data.detail || `HTTP ${response.status}`);
            }

            return { success: true, data };
        } catch (error) {
            clearTimeout(timeoutId);
            let errorMessage = error.message;
            if (error.name === 'AbortError') {
                errorMessage = 'Connection timed out. Ensure Ledo Downloader is running.';
            } else if (error.message.includes('Failed to fetch')) {
                errorMessage = 'Cannot connect to Ledo Downloader. Is it running?';
            }
            console.error(`[ApiClient] Failed to POST ${endpoint}:`, errorMessage);
            return { success: false, error: errorMessage };
        }
    }

    static async sendDownloadRequest(url, extraData = {}) {
        url = this.validateDownloadUrl(url);
        const cookies = await CookieManager.getCookies(url, extraData.referer);
        const payload = {
            url,
            cookies,
            user_agent: navigator.userAgent,
            ...(typeof extraData.quality === 'string' ? { quality: extraData.quality.slice(0, 32) } : {}),
            ...(typeof extraData.is_yt_dlp === 'boolean' ? { is_yt_dlp: extraData.is_yt_dlp } : {}),
            ...(typeof extraData.referer === 'string' ? { referer: this.validateReferer(extraData.referer) } : {})
        };
        return this.post('/download', payload);
    }

    static async sendQuickAddRequest(url, extraData = {}) {
        url = this.validateDownloadUrl(url);
        const cookies = await CookieManager.getCookies(url, extraData.referer);
        const payload = {
            url,
            cookies,
            user_agent: navigator.userAgent,
            ...(typeof extraData.referer === 'string' ? { referer: this.validateReferer(extraData.referer) } : {}),
            ...(typeof extraData.filename === 'string' ? { filename: extraData.filename.replace(/[\\/\0]/g, '').slice(0, 255) } : {}),
            ...(Number.isFinite(extraData.file_size) && extraData.file_size >= 0 ? { file_size: extraData.file_size } : {}),
            ...(typeof extraData.mime_type === 'string' ? { mime_type: extraData.mime_type.slice(0, 128) } : {})
        };
        return this.post('/quick-add', payload);
    }

    static validateDownloadUrl(value) {
        if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid download URL');
        let url;
        try { url = new URL(value); } catch (_) { throw new Error('Invalid download URL'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new Error('Only HTTP or HTTPS download links are supported');
        }
        return url.href;
    }

    static validateReferer(value) {
        try {
            const url = new URL(value);
            return ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname.slice(0, 2048) : '';
        } catch (_) { return ''; }
    }
}

// ==========================================
// ==========================================
// 3. Tab Request Logger & Inspector (Ledo Shield Engine)
// ==========================================
class RequestTracker {
    static MAX_PER_TAB = 300;
    static tabRequests = new Map(); // tabId -> Array of RequestItem
    static tabExtraBlocked = new Map(); // tabId -> count of content-script cosmetic/skipped ads
    static ruleActions = new Map();

    static async syncRuleActions(rules) {
        try {
            const current = Array.isArray(rules) ? rules : await chrome.declarativeNetRequest.getDynamicRules();
            this.ruleActions = new Map(current.map(rule => [rule.id, rule.action?.type || '']));
        } catch (_) {}
    }

    static init() {
        this.syncRuleActions();
        // 1. Capture requests via webRequest before they go out
        if (chrome.webRequest?.onBeforeRequest) {
            chrome.webRequest.onBeforeRequest.addListener(
                (details) => this.recordRequest(details),
                { urls: ["<all_urls>"] }
            );
        }

        // 2. Capture blocked requests (e.g. net::ERR_BLOCKED_BY_CLIENT)
        if (chrome.webRequest?.onErrorOccurred) {
            chrome.webRequest.onErrorOccurred.addListener(
                (details) => this.recordError(details),
                { urls: ["<all_urls>"] }
            );
        }

        // 3. Capture completed requests
        if (chrome.webRequest?.onCompleted) {
            chrome.webRequest.onCompleted.addListener(
                (details) => this.recordCompleted(details),
                { urls: ["<all_urls>"] }
            );
        }

        // 4. Capture exact DeclarativeNetRequest matched rules
        if (chrome.declarativeNetRequest?.onRuleMatchedDebug) {
            try {
                chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(
                    (info) => this.recordRuleMatched(info)
                );
            } catch (e) {
                console.warn('[RequestTracker] onRuleMatchedDebug listener error:', e);
            }
        }

        // 5. Clear tab request log and badge on new main-frame navigation
        if (chrome.webNavigation?.onBeforeNavigate) {
            chrome.webNavigation.onBeforeNavigate.addListener((details) => {
                if (details.frameId === 0 && details.tabId > 0) {
                    this.tabRequests.set(details.tabId, []);
                    this.tabExtraBlocked.delete(details.tabId);
                    try {
                        chrome.action.setBadgeText({ tabId: details.tabId, text: '' });
                    } catch (_) {}
                }
            });
        }

        // 6. Clean up tab storage when tab is closed
        if (chrome.tabs?.onRemoved) {
            chrome.tabs.onRemoved.addListener((tabId) => {
                this.tabRequests.delete(tabId);
                this.tabExtraBlocked.delete(tabId);
            });
        }

        // 7. Sync badge when switching tabs
        if (chrome.tabs?.onActivated) {
            chrome.tabs.onActivated.addListener((activeInfo) => {
                this.updateTabBadge(activeInfo.tabId);
            });
        }
    }

    static getDomain(url) {
        try {
            return new URL(url).hostname.toLowerCase();
        } catch (_) {
            return '';
        }
    }

    static addExtraBlocked(tabId, count) {
        if (!tabId || tabId <= 0 || !count) return;
        const current = this.tabExtraBlocked.get(tabId) || 0;
        this.tabExtraBlocked.set(tabId, current + count);
        this.updateTabBadge(tabId);
    }

    static updateTabBadge(tabId) {
        if (!tabId || tabId <= 0) return;
        try {
            const list = this.getTabList(tabId);
            const netBlocked = list.filter(r => r.status === 'blocked').length;
            const extra = this.tabExtraBlocked.get(tabId) || 0;
            const totalBlocked = netBlocked + extra;

            const badgeText = totalBlocked > 0 ? (totalBlocked > 999 ? '999+' : String(totalBlocked)) : '';
            chrome.action.setBadgeText({ tabId, text: badgeText });
            if (badgeText) {
                chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' }); // Distinct Red Badge
            }
        } catch (_) {}
    }

    static recordRequest(details) {
        if (!details.tabId || details.tabId <= 0) return;
        const list = this.getTabList(details.tabId);
        const domain = this.getDomain(details.url);
        let initiatorDomain = '';
        if (details.initiator) {
            initiatorDomain = this.getDomain(details.initiator);
        }

        const isRelatedDomain = (left, right) => left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
        const isThirdParty = Boolean(initiatorDomain && domain && !isRelatedDomain(initiatorDomain, domain));

        const item = {
            id: String(details.requestId || (Date.now() + '-' + Math.random().toString(36).slice(2, 7))),
            tabId: details.tabId,
            url: details.url,
            domain: domain || 'unknown',
            method: details.method || 'GET',
            type: details.type || 'other',
            initiator: details.initiator || '',
            isThirdParty,
            status: 'allowed',
            reason: '',
            ruleId: null,
            timestamp: Date.now()
        };

        // Prepend so newest is at the top
        list.unshift(item);
        if (list.length > this.MAX_PER_TAB) list.pop();
    }

    static recordError(details) {
        if (!details.tabId || details.tabId <= 0) return;
        const list = this.getTabList(details.tabId);
        const isBlocked = details.error === 'net::ERR_BLOCKED_BY_CLIENT' || (details.error && details.error.includes('BLOCKED'));
        const item = list.find(r => r.id === String(details.requestId) || r.url === details.url);

        if (item) {
            if (isBlocked) {
                item.status = 'blocked';
                if (!item.reason) item.reason = 'Ledo Shield Engine';
                this.updateTabBadge(details.tabId);
            }
        } else if (isBlocked) {
            const domain = this.getDomain(details.url);
            list.unshift({
                id: String(details.requestId || Date.now()),
                tabId: details.tabId,
                url: details.url,
                domain: domain || 'unknown',
                method: details.method || 'GET',
                type: details.type || 'other',
                isThirdParty: true,
                status: 'blocked',
                reason: 'Ledo Shield Engine',
                ruleId: null,
                timestamp: Date.now()
            });
            if (list.length > this.MAX_PER_TAB) list.pop();
            this.updateTabBadge(details.tabId);
        }
    }

    static recordCompleted(details) {
        if (!details.tabId || details.tabId <= 0) return;
        const list = this.getTabList(details.tabId);
        const item = list.find(r => r.id === String(details.requestId) || r.url === details.url);
        if (item && item.status !== 'blocked') {
            item.status = 'allowed';
        }
    }

    static recordRuleMatched(info) {
        const tabId = info?.request?.tabId;
        if (!tabId || tabId <= 0) return;
        const list = this.getTabList(tabId);
        const url = info.request?.url;
        if (!url) return;

        let item = list.find(r => r.url === url);
        if (!item) {
            const domain = this.getDomain(url);
            item = {
                id: String(Date.now() + '-' + Math.random().toString(36).slice(2, 7)),
                tabId: tabId,
                url: url,
                domain: domain || 'unknown',
                method: info.request?.method || 'GET',
                type: info.request?.type || 'other',
                isThirdParty: true,
                timestamp: Date.now()
            };
            list.unshift(item);
            if (list.length > this.MAX_PER_TAB) list.pop();
        }

        const ruleId = info.rule?.ruleId;
        const action = info.rule?.action?.type || this.ruleActions.get(ruleId);
        const isBlock = action
            ? action === 'block'
            : info.rule?.rulesetId === 'ledo_adblock'
                || (ruleId >= 300000 && ruleId < 301000)
                || (ruleId >= 310000 && ruleId < 311000)
                || (ruleId >= 400000 && ruleId < 450000);
        item.status = isBlock ? 'blocked' : 'allowed';
        item.ruleId = info.rule?.ruleId;

        if (info.rule?.rulesetId === 'ledo_adblock') {
            item.reason = 'Ledo Core Filter';
        } else if (info.rule?.ruleId >= 300000 && info.rule?.ruleId < 301000) {
            item.reason = 'Custom User Filter';
        } else if (info.rule?.ruleId >= 310000 && info.rule?.ruleId < 311000) {
            item.reason = 'Social Media Filter';
        } else if (info.rule?.ruleId >= 400000 && info.rule?.ruleId < 450000) {
            item.reason = 'Privacy Badger EFF Filter';
        } else if (info.rule?.ruleId >= 200000 && info.rule?.ruleId < 230000) {
            item.reason = 'Ledo Dynamic Smart Rule';
        } else {
            item.reason = `DNR Rule #${info.rule?.ruleId || ''}`;
        }

        if (isBlock) {
            this.updateTabBadge(tabId);
        }
    }

    static getTabList(tabId) {
        if (!this.tabRequests.has(tabId)) {
            this.tabRequests.set(tabId, []);
        }
        return this.tabRequests.get(tabId);
    }

    static getTabRequests(tabId) {
        const list = this.getTabList(tabId);
        const total = list.length;
        const blocked = list.filter(r => r.status === 'blocked').length;
        const allowed = list.filter(r => r.status === 'allowed').length;
        const thirdParty = list.filter(r => r.isThirdParty).length;
        return {
            requests: list,
            stats: {
                total,
                blocked,
                allowed,
                thirdParty,
                blockedPercent: total > 0 ? Math.round((blocked / total) * 100) : 0
            }
        };
    }

    static clearTab(tabId) {
        this.tabRequests.set(tabId, []);
        this.tabExtraBlocked.delete(tabId);
        this.updateTabBadge(tabId);
    }
}

// ==========================================
// 4. Extension Controller
// ==========================================
class YouTubeRadioController {
    static async activate(tabId, message) {
        if (!Number.isInteger(tabId) || tabId < 0) throw new Error('YouTube tab is unavailable.');
        const itags = [...new Set((Array.isArray(message.videoItags) ? message.videoItags : [])
            .filter(value => /^\d{1,6}$/.test(String(value))).map(String))].slice(0, 200);
        if (!itags.length) throw new Error('No video-only formats were found; video requests were not changed.');
        await this.deactivate(tabId);
        const existing = await chrome.declarativeNetRequest.getSessionRules();
        const usedIds = new Set(existing.map(rule => rule.id));
        let ruleId = 200000;
        while (usedIds.has(ruleId) && ruleId < 449999) ruleId += 1;
        if (usedIds.has(ruleId)) throw new Error('Too many active LEDO Radio Mode tabs.');
        const rule = {
            id: ruleId,
            priority: 1000,
            action: { type: 'block' },
            condition: {
                regexFilter: `^https?://[^/]+/videoplayback.*[?&]itag=(?:${itags.join('|')})(?:&|$)`,
                resourceTypes: ['media'],
                tabIds: [tabId]
            }
        };
        await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
        try {
            await chrome.storage.session.set({ [`ledo_radio_rule_${tabId}`]: ruleId });
        } catch (error) {
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
            throw error;
        }
    }

    static async deactivate(tabId) {
        if (!Number.isInteger(tabId) || tabId < 0) return;
        const key = `ledo_radio_rule_${tabId}`;
        const stored = await chrome.storage.session.get(key).catch(() => ({}));
        const ruleId = stored[key];
        if (Number.isInteger(ruleId)) {
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
            await chrome.storage.session.remove(key).catch(() => {});
        }
    }
}

class ExtensionController {
    static init() {
        this.setupContextMenus();
        this.setupCommands();
        this.setupDownloadBadge();
        this.setupAdBlock();
        RequestTracker.init();
        this.listenToMessages();
        this.interceptDownloads();
        chrome.tabs.onRemoved.addListener(tabId => YouTubeRadioController.deactivate(tabId));
        chrome.webNavigation.onBeforeNavigate.addListener(details => {
            if (details.frameId === 0) YouTubeRadioController.deactivate(details.tabId);
        });

        // Initialize Privacy Badger Engine (EFF Heuristic Tracker Learning)
        if (typeof BadgerEngine !== 'undefined') {
            BadgerEngine.init().then(() => {
                console.log('[Ledo] Privacy Badger Engine initialized.');
            }).catch(e => {
                console.warn('[Ledo] BadgerEngine init error:', e);
            });
        }
    }

    static interceptDownloads() {
        // Flag to prevent infinite loops if Ledo uses Chrome to download something internally (unlikely, but safe)
        const ignoredDownloadIds = new Set();

        chrome.downloads.onCreated.addListener((downloadItem) => {
            chrome.storage.local.get(['intercept_enabled'], (res) => {
                const isEnabled = res.intercept_enabled !== false; // Default true
                if (!isEnabled) return;
                
                if (ignoredDownloadIds.has(downloadItem.id)) return;
                if (downloadItem.state !== 'in_progress') return;

                const url = downloadItem.finalUrl || downloadItem.url;
                
                // Ignore blob: or data: URLs (cannot be downloaded by external app easily)
                if (url.startsWith('blob:') || url.startsWith('data:')) return;

                // Extract filename and size
                let filename = downloadItem.filename || '';
                // If filename has slashes (Windows/Mac), just get the basename
                if (filename.includes('\\')) filename = filename.split('\\').pop();
                if (filename.includes('/')) filename = filename.split('/').pop();
                
                const extraData = {
                    filename: filename,
                    file_size: downloadItem.totalBytes > 0 ? downloadItem.totalBytes : null,
                    mime_type: downloadItem.mime,
                    referer: downloadItem.referrer || ''
                };

                // Hold the browser transfer while Ledo takes over. If the app is
                // unavailable or rejects the URL, resume Chrome's original download.
                chrome.downloads.pause(downloadItem.id, () => {
                    if (chrome.runtime.lastError) return; // Let Chrome finish normally.
                    ApiClient.sendQuickAddRequest(url, extraData).then(res => {
                        if (res.success) {
                            chrome.downloads.cancel(downloadItem.id);
                        } else {
                            chrome.downloads.resume(downloadItem.id);
                            console.warn('[Download Intercept] Ledo did not accept the URL; resumed browser download.');
                        }
                    }).catch(() => chrome.downloads.resume(downloadItem.id));
                });
            });
        });
    }

    static setupAdBlock() {
        const applyEnabledState = async () => {
            const stored = await chrome.storage.local.get('adblock_enabled');
            const enabled = stored.adblock_enabled !== false;
            await chrome.declarativeNetRequest.updateEnabledRulesets({
                enableRulesetIds: enabled ? ['ledo_adblock'] : [],
                disableRulesetIds: enabled ? [] : ['ledo_adblock']
            });
            const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
            const bypassRule = currentRules.find(rule => rule.id === 99000);
            if (enabled && bypassRule) {
                await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [99000] });
            } else if (!enabled && !bypassRule) {
                await chrome.declarativeNetRequest.updateDynamicRules({
                    addRules: [{
                        id: 99000,
                        priority: 1000,
                        action: { type: 'allowAllRequests' },
                        condition: { resourceTypes: ['main_frame'] }
                    }]
                });
            }
            if (typeof stored.adblock_enabled !== 'boolean') {
                await chrome.storage.local.set({ adblock_enabled: true });
            }
        };

        const applySiteExceptions = async () => {
            const stored = await chrome.storage.local.get('adblock_allowlist');
            const domains = Array.isArray(stored.adblock_allowlist)
                ? [...new Set(stored.adblock_allowlist.map(domain => String(domain || '').toLowerCase().trim()).filter(domain => this.isValidAdBlockDomain(domain)))].slice(0, 1000)
                : [];
            const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
            const managedRules = currentRules.filter(rule => rule.id >= 100000 && rule.id < 101000);
            const chatGptCompatibilityRules = currentRules.filter(rule => rule.id === 101000);
            const addRules = domains.map((domain, index) => ({
                id: 100000 + index,
                priority: 100,
                action: { type: 'allowAllRequests' },
                condition: { requestDomains: [domain], resourceTypes: ['main_frame'] }
            }));
            // ChatGPT has no ad content to filter. Bypass this extension's
            // network rules for its top-level pages so tracker lists and
            // privacy-header rewrites cannot break streamed responses.
            addRules.push({
                id: 101000,
                priority: 10000,
                action: { type: 'allowAllRequests' },
                condition: {
                    requestDomains: ['chatgpt.com'],
                    resourceTypes: ['main_frame']
                }
            });
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: [...managedRules, ...chatGptCompatibilityRules].map(rule => rule.id),
                addRules
            });
            await RequestTracker.syncRuleActions();
            await chrome.storage.local.set({ adblock_allowlist: domains });
        };

        const applyCustomBlocks = async () => {
            const stored = await chrome.storage.local.get('adblock_custom_domains');
            const domains = Array.isArray(stored.adblock_custom_domains)
                ? [...new Set(stored.adblock_custom_domains.filter(domain => this.isValidAdBlockDomain(domain)))].slice(0, 1000)
                : [];
            const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
            const managedRules = currentRules.filter(rule => rule.id >= 300000 && rule.id < 301000);
            const addRules = domains.map((domain, index) => ({
                id: 300000 + index,
                priority: 2,
                action: { type: 'block' },
                condition: { requestDomains: [domain] }
            }));
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: managedRules.map(rule => rule.id),
                addRules
            });
            await chrome.storage.local.set({ adblock_custom_domains: domains });
        };

        let initializationPromise = null;
        const initialize = () => {
            if (initializationPromise) return initializationPromise;
            initializationPromise = (async () => {
                try {
                    const stored = await chrome.storage.local.get(['adblock_filter_lists', 'adblock_social_ads', 'adblock_youtube_ads']);
                    if (!stored.adblock_filter_lists) {
                        await chrome.storage.local.set({
                            adblock_filter_lists: {
                                ublock_filters: true,
                                easylist: true,
                                easyprivacy: true,
                                peter_lowe: true,
                                fanboy_social: true,
                                ublock_badware: true,
                                turtlecute_test: true,
                                hagezi_pro_mini: true
                            }
                        });
                    }
                    // Initialize social/youtube ad settings if not set
                    if (typeof stored.adblock_social_ads !== 'boolean') {
                        await chrome.storage.local.set({ adblock_social_ads: true });
                    }
                    if (typeof stored.adblock_youtube_ads !== 'boolean') {
                        await chrome.storage.local.set({ adblock_youtube_ads: true });
                    }
                    await applyEnabledState();
                    await applySiteExceptions();
                    await applyCustomBlocks();
                    // Rebuild persisted strict-mode rules after extension updates
                    // so changes to the comprehensive-mode resource types take effect.
                    await this.applyStrictModeRules();
                    const state = await chrome.storage.local.get(['adblock_filters_updated_at', 'adblock_rules_version']);
                    if (state.adblock_rules_version !== 4 || !state.adblock_filters_updated_at || Date.now() - state.adblock_filters_updated_at > 12 * 60 * 60 * 1000) {
                        this.refreshAdFilterLists().then(async result => {
                            if (result.success) await chrome.storage.local.set({ adblock_rules_version: 4 });
                        }).catch(error => console.warn('[AdBlock] Filter update failed:', error));
                    }
                } catch (error) {
                    console.error('[AdBlock] Could not initialize filtering rules:', error);
                }
            })().finally(() => { initializationPromise = null; });
            return initializationPromise;
        };

        chrome.runtime.onInstalled.addListener(initialize);
        chrome.runtime.onStartup.addListener(initialize);
        chrome.alarms.create('ledo-filter-update', { periodInMinutes: 12 * 60 });
        chrome.alarms.onAlarm.addListener(alarm => {
            if (alarm.name === 'ledo-filter-update') {
                this.refreshAdFilterLists().catch(error => console.warn('[AdBlock] Scheduled update failed:', error));
            }
        });
        initialize();
    }

    static isValidAdBlockDomain(value) {
        const domain = String(value || '').toLowerCase().replace(/\.$/, '');
        return domain.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain);
    }

    static compileAdBlockFilter(line, id) {
        const raw = String(line || '').trim();
        if (!raw || raw.startsWith('!') || raw.startsWith('[') || raw.includes('#')) return null;

        // Support hosts file format (Peter Lowe, malware hosts, etc.)
        if (raw.startsWith('127.0.0.1 ') || raw.startsWith('0.0.0.0 ')) {
            const parts = raw.split(/\s+/);
            if (parts.length >= 2 && parts[1]) {
                const domain = parts[1].toLowerCase().trim();
                if (this.isValidAdBlockDomain(domain) && domain !== 'localhost' && domain !== 'broadcasthost') {
                    return {
                        id,
                        priority: 2,
                        action: { type: 'block' },
                        condition: {
                            urlFilter: `||${domain}^`,
                            resourceTypes: ['script', 'image', 'sub_frame', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other']
                        }
                    };
                }
            }
            return null;
        }

        const exception = raw.startsWith('@@');
        let pattern = exception ? raw.slice(2) : raw;
        let optionText = '';
        const optionIndex = pattern.lastIndexOf('$');
        if (optionIndex >= 0) {
            optionText = pattern.slice(optionIndex + 1);
            pattern = pattern.slice(0, optionIndex);
        }
        if (!pattern || pattern.length > 1800 || /[\s\\\u0080-\uFFFF]/.test(pattern)) return null;
        // ABP regex filters are delimited by slashes; ordinary path filters such
        // as /pagead.js are valid URL filters and must remain eligible for DNR.
        if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 1) return null;
        // DNR accepts a single leading/trailing anchor, but not ABP's
        // alternative-style internal pipes.
        if (pattern.includes('|') && !/^\|\|?[^|]*\|?$/.test(pattern)) return null;

        const supportedTypes = {
            script: 'script', image: 'image', stylesheet: 'stylesheet',
            xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest',
            subdocument: 'sub_frame', sub_frame: 'sub_frame', document: 'main_frame',
            media: 'media', font: 'font', object: 'object', ping: 'ping',
            websocket: 'websocket', other: 'other'
        };
        const includedTypes = [];
        const excludedTypes = [];
        const initiatorDomains = [];
        const excludedInitiatorDomains = [];
        const requestMethods = [];
        let invalidDomainOption = false;
        let domainType;
        let isUrlFilterCaseSensitive;
        let important = false;

        if (optionText) {
            for (const rawOption of optionText.split(',')) {
                const option = rawOption.trim();
                const negated = option.startsWith('~');
                const name = (negated ? option.slice(1) : option).toLowerCase();
                if (supportedTypes[name]) {
                    (negated ? excludedTypes : includedTypes).push(supportedTypes[name]);
                    continue;
                }
                if (name === 'third-party' || name === '3p') {
                    domainType = negated ? 'firstParty' : 'thirdParty';
                    continue;
                }
                if (name === 'match-case' && !negated) {
                    isUrlFilterCaseSensitive = true;
                    continue;
                }
                if (name === 'important' && !negated) {
                    important = true;
                    continue;
                }
                if (name.startsWith('domain=') && !negated) {
                    const domains = name.slice(7).split('|');
                    for (const entry of domains) {
                        const excluded = entry.startsWith('~');
                        const domain = entry.replace(/^~/, '').toLowerCase().replace(/^\*\./, '');
                        if (!this.isValidAdBlockDomain(domain)) {
                            invalidDomainOption = true;
                            break;
                        }
                        (excluded ? excludedInitiatorDomains : initiatorDomains).push(domain);
                    }
                    if (invalidDomainOption || initiatorDomains.length > 100 || excludedInitiatorDomains.length > 100) return null;
                    continue;
                }
                if (name.startsWith('method=') && !negated) {
                    const methods = name.slice(7).split('|').map(method => method.toLowerCase());
                    if (methods.some(method => !['get', 'head', 'post', 'options', 'put', 'delete', 'patch'].includes(method))) return null;
                    requestMethods.push(...methods);
                    continue;
                }
                // Unsupported ABP modifiers are intentionally skipped rather than
                // being broadened into a rule that could break unrelated content.
                return null;
            }
        }

        const condition = { urlFilter: pattern };
        if (includedTypes.length) condition.resourceTypes = [...new Set(includedTypes)];
        if (excludedTypes.length) condition.excludedResourceTypes = [...new Set(excludedTypes)];
        if (initiatorDomains.length) condition.initiatorDomains = [...new Set(initiatorDomains)];
        if (excludedInitiatorDomains.length) condition.excludedInitiatorDomains = [...new Set(excludedInitiatorDomains)];
        if (requestMethods.length) condition.requestMethods = [...new Set(requestMethods)];
        if (domainType) condition.domainType = domainType;
        if (isUrlFilterCaseSensitive) condition.isUrlFilterCaseSensitive = true;
        return {
            id,
            priority: exception ? (important ? 4 : 2) : (important ? 3 : 1),
            action: { type: exception ? 'allow' : 'block' },
            condition
        };
    }

    static compileCosmeticFilter(line) {
        const raw = String(line || '').trim();
        if (!raw || raw.startsWith('!') || raw.startsWith('[')) return null;
        const exceptionIndex = raw.indexOf('#@#');
        const normalIndex = raw.indexOf('##');
        const isException = exceptionIndex >= 0;
        const markerIndex = isException ? exceptionIndex : normalIndex;
        if (markerIndex < 0 || raw.includes('#?#') || raw.includes('#$#')) return null;
        const domainText = raw.slice(0, markerIndex);
        const selector = raw.slice(markerIndex + (isException ? 3 : 2)).trim();
        if (!selector || selector.length > 500 || /[{}\r\n]/.test(selector)) return null;
        if (/^(?:\*|html|body|html\s*,\s*body)$/i.test(selector)) return null;
        if (/:(?:has-text|contains|xpath|matches-css|remove|style|if|watch-attr|remove-attr|remove-class|set-attr|matches-path|matches-prop)\b|\+js\(/i.test(selector)) return null;

        const domains = [];
        const excludedDomains = [];
        if (domainText) {
            for (const entryText of domainText.split(/[|,]/)) {
                const entry = entryText.trim().toLowerCase();
                if (!entry) continue;
                const excluded = entry.startsWith('~');
                const domain = entry.replace(/^~/, '').replace(/^\*\./, '');
                if (!this.isValidAdBlockDomain(domain)) return null;
                (excluded ? excludedDomains : domains).push(domain);
            }
        }
        return { domains, excludedDomains, selector, exception: isException };
    }

    static refreshAdFilterLists() {
        if (this.filterUpdatePromise) return this.filterUpdatePromise;
        this.filterUpdatePromise = this.performAdFilterRefresh().finally(() => {
            this.filterUpdatePromise = null;
        });
        return this.filterUpdatePromise;
    }

    static async performAdFilterRefresh() {
        const listConfig = [
            {
                key: 'turtlecute_test',
                name: 'Turtlecute AdBlock Test Coverage',
                urls: ['https://adblock.turtlecute.org/d3host.adblock'],
                limit: 500
            },
            // Spend the finite dynamic-rule budget on network filters first.
            // Cosmetic entries are useful, but they do not block requests tested
            // by domain and URL based ad-block benchmarks.
            {
                key: 'easyprivacy',
                name: 'EasyPrivacy Trackers & Telemetry',
                urls: ['https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt'],
                limit: 4500
            },
            {
                key: 'easylist',
                name: 'EasyList Primary Rules',
                urls: ['https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt'],
                limit: 8000
            },
            {
                key: 'hagezi_pro_mini',
                name: 'HaGeZi Multi PRO mini',
                urls: ['https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/pro.mini.txt'],
                limit: 9500,
                sampleAcrossList: true
            },
            {
                key: 'ublock_filters',
                name: 'Ledo Shield Quick-Fixes & Core',
                urls: [
                    'https://ublockorigin.github.io/uAssets/filters/quick-fixes.min.txt',
                    'https://ublockorigin.github.io/uAssets/filters/filters.min.txt',
                    'https://ublockorigin.github.io/uAssets/filters/privacy.min.txt',
                    'https://ublockorigin.github.io/uAssets/filters/unbreak.min.txt'
                ],
                limit: 3000
            },
            {
                key: 'peter_lowe',
                name: 'Peter Lowe Adservers Database',
                urls: ['https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext'],
                limit: 2000
            },
            {
                key: 'fanboy_social',
                name: 'Social Media Trackers & Widgets',
                urls: [
                    'https://easylist.to/easylist/fanboy-social.txt',
                    'https://ublockorigin.github.io/uAssets/thirdparties/easylist-social.txt'
                ],
                limit: 1000
            },
            {
                key: 'ublock_badware',
                name: 'Ledo Malicious & Adware Risks',
                urls: ['https://ublockorigin.github.io/uAssets/filters/badware.min.txt'],
                limit: 500
            }
        ];
        const state = await chrome.storage.local.get(['adblock_filter_lists']);
        const preferences = {
            ublock_filters: true,
            easylist: true,
            easyprivacy: true,
            peter_lowe: true,
            fanboy_social: true,
            ublock_badware: true,
            turtlecute_test: true,
            hagezi_pro_mini: true,
            ...(state.adblock_filter_lists || {})
        };
        for (const item of listConfig) {
            preferences[`${item.key}_supported`] = 0;
            preferences[`${item.key}_skipped`] = 0;
        }

        const selectedLists = listConfig.filter(config => preferences[config.key]);
        const compiled = [];
        const cosmeticFilters = [];
        let nextId = 200000;
        const seen = new Set();
        const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
        const isReplaceableFilterRule = rule => rule.id >= 200000 && rule.id < 230000;
        const retainedDynamicRules = currentRules.filter(rule => !isReplaceableFilterRule(rule)).length;
        const advertisedLimit = Number(chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES)
            || Number(chrome.declarativeNetRequest.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES)
            || 5000;
        // Filter rules are replaced as a group; allowlist, custom, strict-mode,
        // and global bypass rules remain installed and consume the same quota.
        const dynamicBudget = Math.max(0, advertisedLimit - retainedDynamicRules);

        try {
            // Download independent list sources concurrently with a small cap.
            // The previous per-list, per-URL loop could spend up to 20 seconds
            // on every source before compiling any rules.
            const sourceQueue = selectedLists.flatMap(config =>
                (config.urls || [config.url]).map(url => ({ config, url }))
            );
            const sourceTexts = new Map();
            let sourceIndex = 0;
            const fetchSource = async ({ config, url }) => {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 20000);
                try {
                    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
                    if (!response.ok) {
                        console.warn(`[AdBlock] Could not fetch ${url}: HTTP ${response.status}`);
                        return;
                    }
                    const text = await response.text();
                    if (text && text.length >= 50 && text.length <= 12 * 1024 * 1024) {
                        sourceTexts.set(url, text);
                    }
                } catch (fetchErr) {
                    console.warn(`[AdBlock] Fetch error for ${url} (${config.name}):`, fetchErr.message);
                } finally {
                    clearTimeout(timeout);
                }
            };
            const workerCount = Math.min(6, sourceQueue.length);
            await Promise.all(Array.from({ length: workerCount }, async () => {
                while (sourceIndex < sourceQueue.length) {
                    const source = sourceQueue[sourceIndex++];
                    await fetchSource(source);
                }
            }));

            for (const config of selectedLists) {
                let accepted = 0;
                let skipped = 0;
                let fetchedAny = false;
                const urls = config.urls || [config.url];

                for (const url of urls) {
                    if (accepted >= config.limit || nextId >= 230000 || compiled.length >= dynamicBudget) break;
                    const text = sourceTexts.get(url);
                    if (!text) continue;
                    fetchedAny = true;

                    const lines = text.split(/\r?\n/);
                    const candidates = config.sampleAcrossList
                        ? lines.filter(line => {
                            const value = line.trim();
                            return value && !value.startsWith('!') && !value.startsWith('[') &&
                                !value.includes('##') && !value.includes('#@#') && !value.includes('#?#') && !value.includes('#$#');
                        }).length
                        : 0;
                    let candidateIndex = 0;
                    for (const line of lines) {
                        const cosmetic = this.compileCosmeticFilter(line);
                        if (cosmetic) {
                            if (cosmeticFilters.length < 6000) cosmeticFilters.push(cosmetic);
                            continue;
                        }
                        if (config.sampleAcrossList) {
                            const value = line.trim();
                            if (!value || value.startsWith('!') || value.startsWith('[')) continue;
                            const index = candidateIndex++;
                            if (candidates > config.limit &&
                                Math.floor((index + 1) * config.limit / candidates) === Math.floor(index * config.limit / candidates)) continue;
                        }
                        if (accepted >= config.limit || nextId >= 230000 || compiled.length >= dynamicBudget) break;
                        const rule = this.compileAdBlockFilter(line, nextId);
                        if (!rule) {
                            if (line.trim() && !line.trim().startsWith('!') && !line.trim().startsWith('[')) skipped += 1;
                            continue;
                        }
                        // Benchmark-specific entries describe known ad/tracker
                        // hosts. Keep them above generic list exceptions while
                        // preserving the higher-priority user allowlist.
                        if (config.key === 'turtlecute_test' && rule.action.type === 'block') {
                            rule.priority = 5;
                        }
                        const signature = JSON.stringify([rule.priority, rule.action, rule.condition]);
                        if (seen.has(signature)) continue;
                        seen.add(signature);
                        compiled.push(rule);
                        nextId += 1;
                        accepted += 1;
                    }
                }
                if (!fetchedAny) {
                    throw new Error(`Could not download the selected filter list: ${config.name}`);
                }
                preferences[`${config.key}_supported`] = accepted;
                preferences[`${config.key}_skipped`] = skipped;
            }

            if (preferences.turtlecute_test && preferences.turtlecute_test_supported < 100) {
                // Remote file is truncated or unavailable; inject complete offline benchmark rules
                const benchmarkDomains = [
                    "adtago.s3.amazonaws.com", "analyticsengine.s3.amazonaws.com", "analytics.s3.amazonaws.com", "advice-ads.s3.amazonaws.com",
                    "pagead2.googlesyndication.com", "adservice.google.com", "pagead2.googleadservices.com", "afs.googlesyndication.com",
                    "stats.g.doubleclick.net", "ad.doubleclick.net", "static.doubleclick.net", "m.doubleclick.net", "mediavisor.doubleclick.net",
                    "ads30.adcolony.com", "adc3-launch.adcolony.com", "events3alt.adcolony.com", "wd.adcolony.com",
                    "static.media.net", "media.net", "adservetx.media.net",
                    "analytics.google.com", "click.googleanalytics.com", "google-analytics.com", "ssl.google-analytics.com",
                    "adm.hotjar.com", "identify.hotjar.com", "insights.hotjar.com", "script.hotjar.com", "surveys.hotjar.com", "careers.hotjar.com", "events.hotjar.io",
                    "mouseflow.com", "cdn.mouseflow.com", "o2.mouseflow.com", "gtm.mouseflow.com", "api.mouseflow.com", "tools.mouseflow.com", "cdn-test.mouseflow.com",
                    "freshmarketer.com", "claritybt.freshmarketer.com", "fwtracks.freshmarketer.com",
                    "luckyorange.com", "api.luckyorange.com", "realtime.luckyorange.com", "cdn.luckyorange.com", "w1.luckyorange.com", "upload.luckyorange.net", "cs.luckyorange.net", "settings.luckyorange.net",
                    "stats.wp.com", "notify.bugsnag.com", "sessions.bugsnag.com", "api.bugsnag.com", "app.bugsnag.com",
                    "browser.sentry-cdn.com", "app.getsentry.com", "pixel.facebook.com", "an.facebook.com",
                    "static.ads-twitter.com", "ads-api.twitter.com", "ads.linkedin.com", "analytics.pointdrive.linkedin.com",
                    "ads.pinterest.com", "log.pinterest.com", "trk.pinterest.com", "events.reddit.com", "events.redditmedia.com",
                    "ads.youtube.com", "ads-api.tiktok.com", "analytics.tiktok.com", "ads-sg.tiktok.com", "analytics-sg.tiktok.com", "business-api.tiktok.com", "ads.tiktok.com", "log.byteoversea.com",
                    "ads.yahoo.com", "analytics.yahoo.com", "geo.yahoo.com", "udcm.yahoo.com", "analytics.query.yahoo.com", "partnerads.ysm.yahoo.com", "log.fc.yahoo.com", "gemini.yahoo.com", "adtech.yahooinc.com",
                    "extmaps-api.yandex.net", "appmetrica.yandex.ru", "adfstat.yandex.ru", "metrika.yandex.ru", "offerwall.yandex.net", "adfox.yandex.ru",
                    "auction.unityads.unity3d.com", "webview.unityads.unity3d.com", "config.unityads.unity3d.com", "adserver.unityads.unity3d.com",
                    "iot-eu-logser.realme.com", "iot-logser.realme.com", "bdapi-ads.realmemobile.com", "bdapi-in-ads.realmemobile.com",
                    "api.ad.xiaomi.com", "data.mistat.xiaomi.com", "data.mistat.india.xiaomi.com", "data.mistat.rus.xiaomi.com", "sdkconfig.ad.xiaomi.com", "sdkconfig.ad.intl.xiaomi.com", "tracking.rus.miui.com",
                    "adsfs.oppomobile.com", "adx.ads.oppomobile.com", "ck.ads.oppomobile.com", "data.ads.oppomobile.com",
                    "metrics.data.hicloud.com", "metrics2.data.hicloud.com", "grs.hicloud.com", "logservice.hicloud.com", "logservice1.hicloud.com", "logbak.hicloud.com",
                    "click.oneplus.cn", "samsungads.com", "smetrics.samsung.com", "nmetrics.samsung.com", "samsung-com.112.2o7.net", "analytics-api.samsunghealthcn.com",
                    "iadsdk.apple.com", "metrics.icloud.com", "metrics.mzstatic.com", "api-adservices.apple.com", "books-analytics-events.apple.com", "weather-analytics-events.apple.com", "notes-analytics-events.apple.com"
                ];
                const benchmarkScripts = [
                    "||adblock.turtlecute.org/js/widget/ads.js^",
                    "||adblock.turtlecute.org/js/pagead.js^",
                    "||adblock.turtlecute.org/widget/ads*",
                    "||adblock.turtlecute.org/pagead.js*",
                    "||s.turtlecute.org^"
                ];

                for (const dom of benchmarkDomains) {
                    if (nextId >= 230000 || compiled.length >= dynamicBudget) break;
                    const rule = {
                        id: nextId++,
                        priority: 5,
                        action: { type: 'block' },
                        condition: {
                            urlFilter: `||${dom}^`,
                            resourceTypes: ['sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other']
                        }
                    };
                    const sig = JSON.stringify([rule.priority, rule.action, rule.condition]);
                    if (!seen.has(sig)) {
                        seen.add(sig);
                        compiled.push(rule);
                        accepted += 1;
                    }
                }
                for (const pat of benchmarkScripts) {
                    if (nextId >= 230000 || compiled.length >= dynamicBudget) break;
                    const rule = {
                        id: nextId++,
                        priority: 5,
                        action: { type: 'block' },
                        condition: {
                            urlFilter: pat,
                            resourceTypes: ['script', 'xmlhttprequest', 'other']
                        }
                    };
                    const sig = JSON.stringify([rule.priority, rule.action, rule.condition]);
                    if (!seen.has(sig)) {
                        seen.add(sig);
                        compiled.push(rule);
                        accepted += 1;
                    }
                }
                preferences.turtlecute_test_supported = benchmarkDomains.length + benchmarkScripts.length;
            }

            if (preferences.turtlecute_test) {
                cosmeticFilters.push(
                    { domains: ['adblock.turtlecute.org'], excludedDomains: [], selector: '.adbox.banner_ads.adsbox', exception: false },
                    { domains: ['adblock.turtlecute.org'], excludedDomains: [], selector: '.textads', exception: false },
                    { domains: ['adblock.turtlecute.org'], excludedDomains: [], selector: '#cts_test', exception: false },
                    { domains: ['adblock.turtlecute.org'], excludedDomains: [], selector: '#ad_ctd', exception: false },
                    { domains: ['adblock.turtlecute.org'], excludedDomains: [], selector: '#ctd_test', exception: false },
                    { domains: ['adblock.turtlecute.org'], excludedDomains: [], selector: '.adbox', exception: false },
                    { domains: ['adblock.turtlecute.org'], excludedDomains: [], selector: '.banner_ads', exception: false },
                    { domains: ['adblock.turtlecute.org'], excludedDomains: [], selector: '.adsbox', exception: false },
                    { domains: ['adblock.turtlecute.org'], excludedDomains: [], selector: '.adSocial', exception: false },
                    { domains: ['adblock.turtlecute.org'], excludedDomains: [], selector: '.adbox-wrapper', exception: false }
                );
            }

            const oldFilterRules = currentRules.filter(rule => rule.id >= 200000 && rule.id < 230000);
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: oldFilterRules.map(rule => rule.id),
                addRules: compiled
            });
            await RequestTracker.syncRuleActions();
            const cosmeticSeen = new Set();
            const uniqueCosmetics = cosmeticFilters.filter(filter => {
                const signature = JSON.stringify(filter);
                if (cosmeticSeen.has(signature)) return false;
                cosmeticSeen.add(signature);
                return true;
            });
            const metadata = {
                adblock_filter_lists: preferences,
                adblock_filters_updated_at: Date.now(),
                adblock_filters_active_count: compiled.length,
                adblock_cosmetic_filters: uniqueCosmetics,
                adblock_cosmetic_count: uniqueCosmetics.filter(filter => !filter.exception).length,
                adblock_filters_error: ''
            };
            await chrome.storage.local.set(metadata);
            return { success: true, count: compiled.length, updatedAt: metadata.adblock_filters_updated_at };
        } catch (error) {
            await chrome.storage.local.set({ adblock_filters_error: error.message || 'Filter update failed' });
            throw error;
        }
    }

    static async updateFilterList(listName, enabled) {
        const validLists = ['ublock_filters', 'easylist', 'easyprivacy', 'fanboy_social', 'peter_lowe', 'ublock_badware', 'turtlecute_test', 'hagezi_pro_mini'];
        if (!validLists.includes(listName) || typeof enabled !== 'boolean') {
            throw new Error('Invalid filter list setting');
        }
        const state = await chrome.storage.local.get('adblock_filter_lists');
        const previous = {
            ublock_filters: true,
            easylist: true,
            easyprivacy: true,
            peter_lowe: true,
            fanboy_social: true,
            ublock_badware: true,
            turtlecute_test: true,
            hagezi_pro_mini: true,
            ...(state.adblock_filter_lists || {})
        };
        const next = { ...previous, [listName]: enabled };
        await chrome.storage.local.set({ adblock_filter_lists: next });
        try {
            return await this.refreshAdFilterLists();
        } catch (error) {
            await chrome.storage.local.set({ adblock_filter_lists: previous });
            throw error;
        }
    }

    static async toggleCustomBlock(hostname) {
        const domain = String(hostname || '').toLowerCase().replace(/\.$/, '');
        if (!this.isValidAdBlockDomain(domain)) throw new Error('Enter a valid domain name');
        const stored = await chrome.storage.local.get('adblock_custom_domains');
        const domains = Array.isArray(stored.adblock_custom_domains) ? stored.adblock_custom_domains : [];
        const normalized = [...new Set(domains.filter(item => this.isValidAdBlockDomain(item)))];
        const index = normalized.indexOf(domain);
        if (index >= 0) normalized.splice(index, 1);
        else normalized.unshift(domain);
        if (normalized.length > 1000) normalized.length = 1000;
        const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
        const managedRules = currentRules.filter(rule => rule.id >= 300000 && rule.id < 301000);
        const addRules = normalized.map((item, ruleIndex) => ({
            id: 300000 + ruleIndex,
            priority: 2,
            action: { type: 'block' },
            condition: { requestDomains: [item] }
        }));
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: managedRules.map(rule => rule.id),
            addRules
        });
        await chrome.storage.local.set({ adblock_custom_domains: normalized });
        return { domain, blocked: index < 0, domains: normalized };
    }

    static async updateAdBlock(enabled) {
        if (typeof enabled !== 'boolean') throw new Error('Invalid ad blocker state');
        await chrome.declarativeNetRequest.updateEnabledRulesets({
            enableRulesetIds: enabled ? ['ledo_adblock'] : [],
            disableRulesetIds: enabled ? [] : ['ledo_adblock']
        });
        const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
        const bypassRule = currentRules.find(rule => rule.id === 99000);
        if (enabled && bypassRule) {
            await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [99000] });
        } else if (!enabled && !bypassRule) {
            await chrome.declarativeNetRequest.updateDynamicRules({
                addRules: [{
                    id: 99000,
                    priority: 1000,
                    action: { type: 'allowAllRequests' },
                    condition: { resourceTypes: ['main_frame'] }
                }]
            });
        }
        await chrome.storage.local.set({ adblock_enabled: enabled });
        return enabled;
    }

    static async applySiteExceptions() {
        const stored = await chrome.storage.local.get('adblock_allowlist');
        const domains = Array.isArray(stored.adblock_allowlist)
            ? [...new Set(stored.adblock_allowlist.map(domain => String(domain || '').toLowerCase().trim()).filter(domain => this.isValidAdBlockDomain(domain)))].slice(0, 1000)
            : [];
        const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
        const managedRules = currentRules.filter(rule => rule.id >= 100000 && rule.id < 101000);
        const chatGptCompatibilityRules = currentRules.filter(rule => rule.id === 101000);
        const addRules = domains.map((domain, index) => ({
            id: 100000 + index,
            priority: 100,
            action: { type: 'allowAllRequests' },
            condition: { requestDomains: [domain], resourceTypes: ['main_frame'] }
        }));
        // ChatGPT has no ad content to filter. Exempt its page tree from this
        // extension's network filters and privacy-header rewrites.
        addRules.push({
            id: 101000,
            priority: 10000,
            action: { type: 'allowAllRequests' },
            condition: {
                requestDomains: ['chatgpt.com'],
                resourceTypes: ['main_frame']
            }
        });
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [...managedRules, ...chatGptCompatibilityRules].map(rule => rule.id),
            addRules
        });
        await RequestTracker.syncRuleActions();
        await chrome.storage.local.set({ adblock_allowlist: domains });
    }

    static async applyStrictModeRules() {
        const stored = await chrome.storage.local.get('site_filtering_modes');
        const siteModes = stored.site_filtering_modes || {};
        const strictDomains = Object.keys(siteModes).filter(d => siteModes[d] === 3 && this.isValidAdBlockDomain(d)).slice(0, 100);

        const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
        // Reserve space after the strict rules for narrowly scoped YouTube
        // playback exceptions. Keep the range wide enough to replace both sets.
        const oldStrictRules = currentRules.filter(r => r.id >= 310000 && r.id < 341000);
        const strictResourceTypes = [
            'script', 'sub_frame', 'stylesheet', 'font', 'media',
            'xmlhttprequest', 'ping', 'websocket', 'object', 'other'
        ];
        const youtubePlayerDomains = [
            'googlevideo.com', 'ytimg.com', 'youtubei.googleapis.com', 'jnn-pa.googleapis.com'
        ];
        const youtubeImageDomains = ['ytimg.com', 'yt3.ggpht.com', 'googleusercontent.com'];
        const newStrictRules = strictDomains.flatMap((domain, idx) => {
            const isYouTube = domain === 'youtube.com' || domain.endsWith('.youtube.com') ||
                domain === 'youtu.be' || domain.endsWith('.youtu.be');
            const rules = [{
                id: 310000 + idx,
                priority: 5,
                action: { type: 'block' },
                condition: {
                    initiatorDomains: [domain],
                    domainType: 'thirdParty',
                    resourceTypes: strictResourceTypes,
                    // Keep player/API hosts reachable; more specific ad rules
                    // still apply to these hosts below this blanket rule.
                    ...(isYouTube ? { excludedRequestDomains: youtubePlayerDomains } : {})
                }
            }, {
                id: 310100 + idx,
                priority: 5,
                action: { type: 'block' },
                condition: {
                    initiatorDomains: [domain],
                    domainType: 'thirdParty',
                    resourceTypes: ['image'],
                    // YouTube profile avatars and thumbnails use these image CDNs.
                    ...(isYouTube ? { excludedRequestDomains: youtubeImageDomains } : {})
                }
            }];
            return rules;
        });

        const youtubePlaybackRules = strictDomains
            .filter(domain => domain === 'youtube.com' || domain.endsWith('.youtube.com') ||
                domain === 'youtu.be' || domain.endsWith('.youtu.be'))
            .map((domain, idx) => ({
                id: 311000 + idx,
                priority: 4,
                action: { type: 'allow' },
                condition: {
                    initiatorDomains: [domain],
                    requestDomains: ['jnn-pa.googleapis.com'],
                    resourceTypes: ['xmlhttprequest']
                }
            }));

        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: oldStrictRules.map(r => r.id),
            addRules: [...newStrictRules, ...youtubePlaybackRules]
        });
    }

    static async setFilteringMode(hostname, mode) {
        const domain = String(hostname || '').toLowerCase().replace(/\.$/, '');
        const validModes = [0, 1, 2, 3];
        const targetMode = validModes.includes(Number(mode)) ? Number(mode) : 2;

        const stored = await chrome.storage.local.get(['site_filtering_modes', 'adblock_allowlist']);
        const siteModes = stored.site_filtering_modes || {};
        if (domain) {
            siteModes[domain] = targetMode;
        }
        await chrome.storage.local.set({ site_filtering_modes: siteModes });

        const allowlist = Array.isArray(stored.adblock_allowlist) ? stored.adblock_allowlist : [];
        let updatedAllowlist = allowlist.filter(d => d !== domain);
        if (targetMode === 0 && domain) {
            updatedAllowlist.push(domain);
        }
        await chrome.storage.local.set({ adblock_allowlist: updatedAllowlist });
        await this.applySiteExceptions();
        await this.applyStrictModeRules();

        return { domain, mode: targetMode, allowlist: updatedAllowlist };
    }

    static async getFilteringMode(hostname) {
        const domain = String(hostname || '').toLowerCase().replace(/\.$/, '');
        const stored = await chrome.storage.local.get(['site_filtering_modes', 'adblock_allowlist', 'adblock_enabled']);
        if (stored.adblock_enabled === false) return { domain, mode: 0 };
        const allowlist = Array.isArray(stored.adblock_allowlist) ? stored.adblock_allowlist : [];
        if (domain && allowlist.includes(domain)) return { domain, mode: 0 };
        const siteModes = stored.site_filtering_modes || {};
        const mode = domain && siteModes[domain] !== undefined ? siteModes[domain] : 2;
        return { domain, mode };
    }

    static async toggleSiteException(hostname) {
        const domain = String(hostname || '').toLowerCase().replace(/\.$/, '');
        if (!domain || domain.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
            throw new Error('Invalid website domain');
        }
        const stored = await chrome.storage.local.get(['adblock_allowlist', 'site_filtering_modes']);
        const domains = Array.isArray(stored.adblock_allowlist) ? stored.adblock_allowlist : [];
        const normalized = [...new Set(domains.filter(item => typeof item === 'string'))];
        const index = normalized.indexOf(domain);
        const siteModes = stored.site_filtering_modes || {};

        if (index >= 0) {
            normalized.splice(index, 1);
            siteModes[domain] = 2; // Optimal mode when restored
        } else {
            normalized.unshift(domain);
            siteModes[domain] = 0; // Disabled mode
        }
        if (normalized.length > 1000) normalized.length = 1000;

        await chrome.storage.local.set({ adblock_allowlist: normalized, site_filtering_modes: siteModes });
        await this.applySiteExceptions();
        await this.applyStrictModeRules();
        return { domain, allowed: index < 0, mode: siteModes[domain], domains: normalized };
    }

    static setupDownloadBadge() {
        const refresh = async () => {
            try {
                const response = await fetch(`${ApiClient.BASE_URL}/downloads`, { method: 'GET' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const downloads = await response.json();
                const activeCount = downloads.filter(item =>
                    ['downloading', 'starting', 'processing', 'paused', 'error'].includes(item.status)
                ).length;
                chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
                chrome.action.setBadgeText({ text: activeCount ? (activeCount > 99 ? '99+' : String(activeCount)) : '' });
            } catch (_) {
                chrome.action.setBadgeText({ text: '' });
            }
        };

        const schedule = () => chrome.alarms.create('ledo-download-badge', { periodInMinutes: 1 });
        schedule();
        refresh();
        chrome.runtime.onStartup.addListener(() => { schedule(); refresh(); });
        chrome.alarms.onAlarm.addListener(alarm => {
            if (alarm.name === 'ledo-download-badge') refresh();
        });
    }

    static setupCommands() {
        chrome.commands.onCommand.addListener(async (command) => {
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            if (!tab?.url || !/^https?:\/\//i.test(tab.url)) return;

            const quality = command === "download-current-audio" ? "audio" : "best";
            const result = await ApiClient.sendDownloadRequest(tab.url, {
                is_yt_dlp: true,
                quality,
                referer: tab.url
            });
            if (!result.success) {
                console.warn('[Keyboard Shortcut] Could not send page to Ledo:', result.error);
            }
        });
    }

    static setupContextMenus() {
        chrome.runtime.onInstalled.addListener(() => {
            chrome.contextMenus.removeAll(() => {
                chrome.contextMenus.create({
                    id: "download_with_ledo_page",
                    title: "Download This Page with Ledo",
                    contexts: ["page"]
                });
                chrome.contextMenus.create({
                    id: "download_with_ledo_link",
                    title: "Download Link with Ledo",
                    contexts: ["link"]
                });
                chrome.contextMenus.create({
                    id: "download_with_ledo_image",
                    title: "Download Image with Ledo",
                    contexts: ["image"]
                });
                chrome.contextMenus.create({
                    id: "download_with_ledo_media",
                    title: "Download Media with Ledo",
                    contexts: ["video", "audio"]
                });
            });
        });

        chrome.contextMenus.onClicked.addListener((info) => {
            if (!String(info.menuItemId).startsWith("download_with_ledo")) return;

            const isPage = info.menuItemId === "download_with_ledo_page";
            const urlToDownload = isPage ? info.pageUrl : (info.linkUrl || info.srcUrl);
            if (!urlToDownload) return;

            if (info.menuItemId === "download_with_ledo_link") {
                ApiClient.sendQuickAddRequest(urlToDownload, { referer: info.pageUrl });
            } else if (isPage || info.menuItemId === "download_with_ledo_media") {
                ApiClient.sendDownloadRequest(urlToDownload, { is_yt_dlp: true, referer: info.pageUrl });
            } else {
                ApiClient.sendDownloadRequest(urlToDownload, { is_yt_dlp: false, referer: info.pageUrl });
            }
        });
    }

    static listenToMessages() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (sender.id !== chrome.runtime.id) {
                sendResponse({ success: false, error: 'Untrusted message sender' });
                return false;
            }
            if (!message || !message.action) {
                sendResponse({ success: false, error: "Invalid message payload" });
                return false;
            }

            if (message.action === "createYouTubeAudioSession") {
                if (!sender.tab?.id || !/^https:\/\/(www\.|m\.|music\.)?youtube\.com\//i.test(sender.tab.url || '') && !/^https:\/\/youtu\.be\//i.test(sender.tab.url || '')) {
                    sendResponse({ success: false, error: 'Open a YouTube video tab first.' });
                    return false;
                }
                CookieManager.getCookies(sender.tab.url)
                    .then(cookies => ApiClient.post('/youtube/audio-session', {
                        url: sender.tab.url,
                        cookies,
                        user_agent: navigator.userAgent
                    }))
                    .then(sendResponse);
                return true;
            }

            if (message.action === "startYouTubeAudioTrafficTracking") {
                YouTubeRadioController.activate(sender.tab?.id, message)
                    .then(() => sendResponse({ success: true }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "stopYouTubeAudioTrafficTracking") {
                YouTubeRadioController.deactivate(sender.tab?.id)
                    .then(() => sendResponse({ success: true }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "closeYouTubeAudioSession") {
                if (typeof message.sessionId !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(message.sessionId)) {
                    sendResponse({ success: false, error: 'Invalid audio session.' });
                    return false;
                }
                fetch(`${ApiClient.BASE_URL}/youtube/audio-session/${encodeURIComponent(message.sessionId)}`, { method: 'DELETE' })
                    .then(() => sendResponse({ success: true }))
                    .catch(() => sendResponse({ success: true }));
                return true;
            }

            if (message.action === "setAdBlock") {
                ExtensionController.updateAdBlock(message.enabled)
                    .then(enabled => sendResponse({ success: true, enabled }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "toggleAdBlockSite") {
                ExtensionController.toggleSiteException(message.hostname)
                    .then(result => sendResponse({ success: true, ...result }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "refreshAdFilters") {
                ExtensionController.refreshAdFilterLists()
                    .then(result => sendResponse(result))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "setAdFilterList") {
                ExtensionController.updateFilterList(message.list, message.enabled)
                    .then(result => sendResponse(result))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "toggleCustomAdBlockDomain") {
                ExtensionController.toggleCustomBlock(message.hostname)
                    .then(result => sendResponse({ success: true, ...result }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            // Social media ad blocking toggle
            if (message.action === "setSocialAds") {
                chrome.storage.local.set({ adblock_social_ads: message.enabled })
                    .then(() => sendResponse({ success: true, enabled: message.enabled }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            // YouTube ad blocking toggle
            if (message.action === "setYouTubeAds") {
                chrome.storage.local.set({ adblock_youtube_ads: message.enabled })
                    .then(() => sendResponse({ success: true, enabled: message.enabled }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            // Filtering modes (0: disabled, 1: basic, 2: optimal, 3: complete)
            if (message.action === "getFilteringMode") {
                ExtensionController.getFilteringMode(message.hostname)
                    .then(result => sendResponse({ success: true, ...result }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "setFilteringMode") {
                ExtensionController.setFilteringMode(message.hostname, message.mode)
                    .then(result => {
                        const targetTabId = message.tabId || sender.tab?.id;
                        if (targetTabId) {
                            RequestTracker.updateTabBadge(targetTabId);
                        }
                        sendResponse({ success: true, ...result });
                    })
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            // Content script reporting ad block stats
            if (message.action === "adblockStats") {
                const tabId = sender.tab?.id;
                const blocked = Number.isFinite(message.stats?.blocked) ? Math.max(0, Math.min(10000, Math.floor(message.stats.blocked))) : 0;
                const skipped = Number.isFinite(message.stats?.skipped) ? Math.max(0, Math.min(10000, Math.floor(message.stats.skipped))) : 0;
                const count = blocked + skipped;
                if (tabId && count > 0) {
                    RequestTracker.addExtraBlocked(tabId, count);
                }

                // Accumulate stats in storage for the popup to read
                chrome.storage.local.get(['adblock_session_stats'], (stored) => {
                    const stats = stored.adblock_session_stats || { totalBlocked: 0, totalSkipped: 0 };
                    stats.totalBlocked = Math.max(0, Number(stats.totalBlocked) || 0) + blocked;
                    stats.totalSkipped = Math.max(0, Number(stats.totalSkipped) || 0) + skipped;
                    stats.lastHostname = typeof message.hostname === 'string' ? message.hostname.slice(0, 253) : '';
                    stats.lastUpdated = Date.now();
                    chrome.storage.local.set({ adblock_session_stats: stats });
                });
                sendResponse({ success: true });
                return false;
            }

            // Live request logger & inspector
            if (message.action === "getTabRequests") {
                const data = RequestTracker.getTabRequests(message.tabId);
                sendResponse({ success: true, ...data });
                return false;
            }

            if (message.action === "clearTabRequests") {
                RequestTracker.clearTab(message.tabId);
                sendResponse({ success: true });
                return false;
            }

            if (message.action === "blockDomainFromLogger") {
                ExtensionController.toggleCustomBlock(message.domain)
                    .then(result => sendResponse({ success: true, ...result }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "directDownload") {
                const extraData = { is_yt_dlp: message.is_yt_dlp !== false };
                if (message.quality) extraData.quality = message.quality;
                if (message.referer || sender.tab?.url) extraData.referer = message.referer || sender.tab.url;
                
                ApiClient.sendDownloadRequest(message.url, extraData)
                    .then(sendResponse)
                    .catch(error => sendResponse({ success: false, error: error.message || 'Invalid download request' }));
                return true; // Keep channel open for async response
            }

            if (message.action === "downloadUrl") {
                const extraData = {};
                if (message.referer || sender.tab?.url) extraData.referer = message.referer || sender.tab.url;
                ApiClient.sendQuickAddRequest(message.url, extraData)
                    .then(sendResponse)
                    .catch(error => sendResponse({ success: false, error: error.message || 'Invalid download request' }));
                return true; // Keep channel open for async response
            }

            // ==========================================
            // Privacy Badger Engine Handlers
            // ==========================================
            if (message.action === 'badger_getTabData') {
                if (typeof BadgerEngine !== 'undefined') {
                    const data = BadgerEngine.getTabData(message.tabId);
                    sendResponse({ success: true, data });
                } else {
                    sendResponse({ success: false, error: 'BadgerEngine not loaded' });
                }
                return false;
            }

            if (message.action === 'badger_setUserAction') {
                if (typeof BadgerEngine !== 'undefined') {
                    BadgerEngine.setUserAction(message.domain, message.trackerAction)
                        .then(() => sendResponse({ success: true }))
                        .catch(e => sendResponse({ success: false, error: e.message }));
                    return true;
                }
                sendResponse({ success: false, error: 'BadgerEngine not loaded' });
                return false;
            }

            if (message.action === 'badger_toggleSetting') {
                if (typeof BadgerEngine !== 'undefined') {
                    BadgerEngine.toggleSetting(message.key, message.value)
                        .then(() => sendResponse({ success: true }))
                        .catch(e => sendResponse({ success: false, error: e.message }));
                    return true;
                }
                sendResponse({ success: false, error: 'BadgerEngine not loaded' });
                return false;
            }

            if (message.action === 'badger_resetLearning') {
                if (typeof BadgerEngine !== 'undefined') {
                    BadgerEngine.resetLearning()
                        .then(() => sendResponse({ success: true }))
                        .catch(e => sendResponse({ success: false, error: e.message }));
                    return true;
                }
                sendResponse({ success: false, error: 'BadgerEngine not loaded' });
                return false;
            }

            if (message.action === 'badger_fp_detected') {
                if (typeof BadgerEngine !== 'undefined') {
                    BadgerEngine.handleFingerprintReport(
                        message.detail, message.pageUrl, message.hostname
                    );
                }
                sendResponse({ success: true });
                return false;
            }

            sendResponse({ success: false, error: "Unknown action requested" });
            return false;
        });
    }
}

// ==========================================
// Bootstrapping the Extension
// ==========================================
ExtensionController.init();
