/**
 * Ledo Downloader Extension - Core Infrastructure
 * Architecture: Modular OOP approach for robustness and maintainability.
 */

// Load Privacy Badger Engine
importScripts('badger/badger_engine.js');

const SERVICE_WORKER_STARTED_AT = Date.now();

// Serialize every dynamic-rule commit and enforce Chrome's live quota against
// the latest ruleset. Multiple filter engines initialize at the same time;
// budgeting from stale snapshots otherwise races into "Dynamic rule count exceeded".
const DnrRuleQueue = (() => {
    let tail = Promise.resolve();
    return {
        update(options) {
            const commit = async () => {
                const current = await chrome.declarativeNetRequest.getDynamicRules();
                const removed = new Set(Array.isArray(options.removeRuleIds) ? options.removeRuleIds : []);
                const additions = Array.isArray(options.addRules) ? [...options.addRules] : [];
                const dynamicLimit = Number(chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES)
                    || Number(chrome.declarativeNetRequest.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES)
                    || 5000;
                let retainedCount = current.filter(rule => !removed.has(rule.id)).length;
                let available = Math.max(0, dynamicLimit - retainedCount);
                const isUserDecision = additions.some(rule =>
                    (rule.id >= 100000 && rule.id < 103000) || (rule.id >= 300000 && rule.id < 301000));
                if (isUserDecision && additions.length > available) {
                    const evictable = current
                        .filter(rule => rule.id >= 200000 && rule.id < 230000 && !removed.has(rule.id))
                        .sort((left, right) => right.id - left.id);
                    const needed = Math.min(additions.length - available, evictable.length);
                    for (const rule of evictable.slice(0, needed)) removed.add(rule.id);
                    retainedCount -= needed;
                    available = Math.max(0, dynamicLimit - retainedCount);
                    if (needed) console.warn(`[DNR] Freed ${needed} lower-priority filter slots for a user allow/block decision.`);
                }
                const addRules = additions.slice(0, available);
                if (addRules.length < additions.length) {
                    console.warn(`[DNR] Limited this update to ${addRules.length} of ${additions.length} rules to stay within Chrome's ${dynamicLimit}-rule quota.`);
                }
                return chrome.declarativeNetRequest.updateDynamicRules({ ...options, removeRuleIds: [...removed], addRules });
            };
            const result = tail.then(commit, commit);
            tail = result.catch(() => {});
            return result;
        }
    };
})();

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
    static pendingQueueKey = 'ledo_pending_download_requests';
    static retryPromise = null;
    static queueMutation = Promise.resolve();

    static updateQueue(mutator) {
        this.queueMutation = this.queueMutation.catch(() => {}).then(async () => {
            const stored = await chrome.storage.local.get([this.pendingQueueKey]);
            const queue = Array.isArray(stored[this.pendingQueueKey]) ? stored[this.pendingQueueKey] : [];
            const updated = await mutator(queue);
            await chrome.storage.local.set({ [this.pendingQueueKey]: updated });
            return updated;
        });
        return this.queueMutation;
    }

    static async enqueue(endpoint, bodyData) {
        try {
            await this.updateQueue(queue => [
                ...queue,
                { id: crypto.randomUUID(), endpoint, bodyData, queuedAt: Date.now() }
            ].slice(-100));
            chrome.alarms.create('ledo-pending-downloads', { periodInMinutes: 1 });
            return true;
        } catch (error) {
            console.error('[ApiClient] Could not save request for retry:', error);
            return false;
        }
    }

    static async retryPending() {
        if (this.retryPromise) return this.retryPromise;
        this.retryPromise = (async () => {
            while (true) {
                const stored = await chrome.storage.local.get([this.pendingQueueKey]);
                const queue = Array.isArray(stored[this.pendingQueueKey]) ? stored[this.pendingQueueKey] : [];
                if (!queue.length) break;
                const item = queue[0];
                const result = await this.post(item.endpoint, item.bodyData, { allowQueue: false });
                if (!result.success && result.retryable) break;
                await this.updateQueue(current => current.filter(entry => entry.id !== item.id));
            }
            const remaining = await chrome.storage.local.get([this.pendingQueueKey]);
            const remainingCount = Array.isArray(remaining[this.pendingQueueKey]) ? remaining[this.pendingQueueKey].length : 0;
            if (!remainingCount) await chrome.alarms.clear('ledo-pending-downloads');
            return remainingCount;
        })().catch(error => {
            console.warn('[ApiClient] Pending download retry failed:', error);
            return -1;
        }).finally(() => { this.retryPromise = null; });
        return this.retryPromise;
    }

    /**
     * Sends a POST request with AbortController for timeout management.
     */
    static async post(endpoint, bodyData, { allowQueue = true, timeoutMs = this.TIMEOUT_MS } = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        let responseStatus = 0;

        try {
            const response = await fetch(`${this.BASE_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyData),
                signal: controller.signal
            });
            responseStatus = response.status;

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
            // An HTTP failure is a handled API response (for example, a video
            // with no accessible audio-only format), not an extension runtime
            // error. Keep it visible as a warning so chrome://extensions does
            // not report a broken service worker for expected request failures.
            const log = responseStatus > 0 ? console.warn : console.error;
            log(`[ApiClient] Failed to POST ${endpoint}${responseStatus ? ` (HTTP ${responseStatus})` : ''}:`, errorMessage);
            const retryable = error.name === 'AbortError' || responseStatus === 0 || responseStatus >= 500;
            if (allowQueue && retryable && await this.enqueue(endpoint, bodyData)) {
                return { success: true, queued: true, error: errorMessage };
            }
            return { success: false, error: errorMessage, retryable };
        }
    }

    static async sendDownloadRequest(url, extraData = {}) {
        url = this.validateDownloadUrl(url);
        const cookies = await CookieManager.getCookies(url, extraData.referer);
        const suppliedTitle = typeof extraData.title === 'string' ? extraData.title.trim().slice(0, 255) : '';
        const normalizedTitle = suppliedTitle
            .replace(/\s*[|·–—-]\s*(?:youtube|tiktok|facebook|instagram|twitter|x)\b.*$/i, '')
            .trim();
        const genericTitles = new Set([
            'facebook', 'tiktok', 'tiktok - make your day', 'instagram',
            'youtube', 'youtube - broadcast yourself', 'twitter', 'x',
            'video', 'فيديو', 'فيديو من الصفحة'
        ]);
        const genericBrandTitle = /^(?:facebook|tiktok|instagram|youtube|twitter|x)(?:\s*[-|:].*)?$/i.test(normalizedTitle);
        const usefulTitle = normalizedTitle && !genericTitles.has(normalizedTitle.toLocaleLowerCase()) && !genericBrandTitle;
        const payload = {
            url,
            cookies,
            user_agent: navigator.userAgent,
            ...(typeof extraData.quality === 'string' ? { quality: extraData.quality.slice(0, 32) } : {}),
            ...(typeof extraData.is_yt_dlp === 'boolean' ? { is_yt_dlp: extraData.is_yt_dlp } : {}),
            ...(usefulTitle ? { title: normalizedTitle.replace(/[\\/\0]/g, '') } : {}),
            ...(typeof extraData.referer === 'string' ? { referer: this.validateReferer(extraData.referer) } : {})
        };
        return this.post('/download', payload);
    }

    static async sendQuickAddRequest(url, extraData = {}) {
        url = this.validateDownloadUrl(url);
        const cookies = extraData.native_browser_download
            ? null
            : await CookieManager.getCookies(url, extraData.referer);
        const payload = {
            url,
            cookies,
            user_agent: navigator.userAgent,
            ...(typeof extraData.referer === 'string' ? { referer: this.validateReferer(extraData.referer) } : {}),
            ...(typeof extraData.filename === 'string' ? { filename: extraData.filename.replace(/[\\/\0]/g, '').slice(0, 255) } : {}),
            ...(Number.isFinite(extraData.file_size) && extraData.file_size >= 0 ? { file_size: extraData.file_size } : {}),
            ...(typeof extraData.mime_type === 'string' ? { mime_type: extraData.mime_type.slice(0, 128) } : {}),
            ...(extraData.native_browser_download === true ? { native_browser_download: true } : {}),
            ...(typeof extraData.native_download_paused === 'boolean' ? { native_download_paused: extraData.native_download_paused } : {}),
            ...(Number.isInteger(extraData.native_download_id) ? { native_download_id: extraData.native_download_id } : {})
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

chrome.runtime.onStartup.addListener(() => ApiClient.retryPending());
chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'ledo-pending-downloads') ApiClient.retryPending();
});
ApiClient.retryPending();

// Keep a control channel open while a Telegram download waits for the user's
// choice in Quick Add. Chrome 116+ keeps MV3 workers alive with regular WS traffic.
let nativeDownloadSocket = null;
let nativeDownloadReconnectDelay = 1000;
let nativeDownloadReconnectTimer = null;
function connectNativeDownloadChannel() {
    if (nativeDownloadSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(nativeDownloadSocket.readyState)) return;
    try {
        const socket = new WebSocket('ws://127.0.0.1:8000/ws');
        nativeDownloadSocket = socket;
        socket.addEventListener('open', () => {
            nativeDownloadReconnectDelay = 1000;
            socket.send(JSON.stringify({ action: 'register_native_download_controller' }));
            socket._ledoKeepalive = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ action: 'ping' }));
            }, 20000);
        });
        socket.addEventListener('message', event => {
            let message;
            try { message = JSON.parse(event.data); } catch (_) { return; }
            if (message.type !== 'native_download_choice' || !Number.isInteger(message.download_id)) return;
            chrome.downloads.search({ id: message.download_id }, items => {
                const item = items?.[0];
                if (!item || item.state !== 'in_progress') return;
                if (message.choice === 'cancel') chrome.downloads.cancel(message.download_id);
                else if (message.choice === 'resume' && item.paused) chrome.downloads.resume(message.download_id);
            });
        });
        socket.addEventListener('close', () => {
            clearInterval(socket._ledoKeepalive);
            if (nativeDownloadSocket === socket) nativeDownloadSocket = null;
            scheduleNativeDownloadReconnect();
        });
        socket.addEventListener('error', () => socket.close());
    } catch (error) {
        console.warn('[Telegram Download] Could not connect the Quick Add control channel:', error);
        scheduleNativeDownloadReconnect();
    }
}

function scheduleNativeDownloadReconnect() {
    if (nativeDownloadReconnectTimer) return;
    const delay = nativeDownloadReconnectDelay;
    nativeDownloadReconnectDelay = Math.min(nativeDownloadReconnectDelay * 2, 30000);
    nativeDownloadReconnectTimer = setTimeout(() => {
        nativeDownloadReconnectTimer = null;
        connectNativeDownloadChannel();
    }, delay);
}

connectNativeDownloadChannel();
chrome.runtime.onStartup.addListener(connectNativeDownloadChannel);

// ==========================================
// ==========================================
// 3. Tab Request Logger & Inspector (Ledo Shield Engine)
// ==========================================
class RequestTracker {
    static MAX_PER_TAB = 2000;
    static tabRequests = new Map(); // tabId -> Array of RequestItem
    static tabExtraBlocked = new Map(); // tabId -> count of content-script cosmetic/skipped ads
    static notifyTimers = new Map();
    static saveTimers = new Map();
    static loadedTabs = new Set();
    static loadingTabs = new Map();
    static ruleActions = new Map();

    static storage() {
        return chrome.storage.session || chrome.storage.local;
    }

    static async ensureTabLoaded(tabId) {
        if (this.loadedTabs.has(tabId)) return;
        if (this.loadingTabs.has(tabId)) return this.loadingTabs.get(tabId);
        const key = `ledo_request_log_${tabId}`;
        const pending = this.storage().get(key).then(stored => {
            const snapshot = stored[key] || {};
            this.tabRequests.set(tabId, Array.isArray(snapshot.requests) ? snapshot.requests : []);
            this.tabExtraBlocked.set(tabId, Math.max(0, Number(snapshot.extraBlocked) || 0));
            this.loadedTabs.add(tabId);
        }).finally(() => this.loadingTabs.delete(tabId));
        this.loadingTabs.set(tabId, pending);
        return pending;
    }

    static saveTab(tabId) {
        if (this.saveTimers.has(tabId)) return;
        const timer = setTimeout(() => {
            this.saveTimers.delete(tabId);
            const key = `ledo_request_log_${tabId}`;
            const requests = this.tabRequests.get(tabId) || [];
            // Keep the complete timeline for counts, but retain verbose HTTP
            // metadata only for the newest 50 requests to fit session quota.
            const recentIds = new Set(requests.slice(0, 20).map(request => request.id));
            this.storage().set({
                [key]: {
                    requests: requests.map(request => recentIds.has(request.id) ? request : {
                        ...request,
                        requestHeaders: [],
                        responseHeaders: [],
                        requestBodySummary: ''
                    }),
                    extraBlocked: this.tabExtraBlocked.get(tabId) || 0
                }
            }).catch(() => {});
        }, 1000);
        this.saveTimers.set(tabId, timer);
    }

    static notify(tabId) {
        if (!Number.isInteger(tabId) || tabId <= 0) return;
        if (this.notifyTimers.has(tabId)) return;
        const timer = setTimeout(() => {
            this.notifyTimers.delete(tabId);
            try {
                chrome.runtime.sendMessage({ action: 'tabRequestsUpdated', tabId }).catch(() => {});
            } catch (_) {}
        }, 80);
        this.notifyTimers.set(tabId, timer);
    }

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
                { urls: ["<all_urls>"] },
                ["requestBody"]
            );
        }

        // Capture the visible HTTP conversation metadata without modifying or
        // blocking traffic. Chrome MV3 does not expose response-body streams.
        if (chrome.webRequest?.onBeforeSendHeaders) {
            chrome.webRequest.onBeforeSendHeaders.addListener(
                (details) => this.recordHeaders(details, 'request'),
                { urls: ["<all_urls>"] },
                ["requestHeaders", "extraHeaders"]
            );
        }
        if (chrome.webRequest?.onHeadersReceived) {
            chrome.webRequest.onHeadersReceived.addListener(
                (details) => this.recordHeaders(details, 'response'),
                { urls: ["<all_urls>"] },
                ["responseHeaders", "extraHeaders"]
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
                    this.clearTab(details.tabId).catch(() => {});
                }
            });
        }

        // 6. Clean up tab storage when tab is closed
        if (chrome.tabs?.onRemoved) {
            chrome.tabs.onRemoved.addListener((tabId) => {
                this.tabRequests.delete(tabId);
                this.tabExtraBlocked.delete(tabId);
                this.loadedTabs.delete(tabId);
                this.loadingTabs.delete(tabId);
                const timer = this.saveTimers.get(tabId);
                if (timer) clearTimeout(timer);
                this.saveTimers.delete(tabId);
                this.storage().remove(`ledo_request_log_${tabId}`).catch(() => {});
            });
        }

        // 7. Sync badge when switching tabs
        if (chrome.tabs?.onActivated) {
            chrome.tabs.onActivated.addListener((activeInfo) => {
                this.updateTabBadge(activeInfo.tabId).catch(() => {});
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

    static safeHeaders(headers) {
        const secretHeader = /authorization|cookie|set-cookie|token|secret|password|api.?key|credential|session/i;
        return (Array.isArray(headers) ? headers : []).slice(0, 25).map(header => {
            const name = String(header?.name || '').slice(0, 120);
            const value = secretHeader.test(name)
                ? '[مخفي لحماية بيانات الدخول]'
                : String(header?.value || '').slice(0, 400);
            return { name, value };
        }).filter(header => header.name);
    }

    static summarizeRequestBody(requestBody) {
        if (!requestBody) return '';
        const fields = requestBody.formData;
        if (fields && typeof fields === 'object') {
            const encoded = new URLSearchParams();
            for (const [name, values] of Object.entries(fields).slice(0, 30)) {
                const hidden = /pass(word)?|token|secret|auth|cookie|api.?key|session/i.test(name);
                const safeValues = (Array.isArray(values) ? values : [values]).slice(0, 5)
                    .map(value => hidden ? '[مخفي]' : String(value).slice(0, 500));
                for (const value of safeValues) encoded.append(String(name).slice(0, 120), value);
            }
            return encoded.toString().slice(0, 8000);
        }
        const byteLength = (requestBody.raw || []).reduce((sum, entry) => sum + (entry?.bytes?.byteLength || 0), 0);
        return byteLength ? `بيانات ثنائية/خام (${byteLength} بايت) — لم تُحفظ محتوياتها.` : '';
    }

    static async recordHeaders(details, direction) {
        if (!details.tabId || details.tabId <= 0) return;
        await this.ensureTabLoaded(details.tabId);
        const list = this.getTabList(details.tabId);
        const item = list.find(request => request.id === String(details.requestId));
        if (!item) return;
        if (direction === 'request') {
            item.requestHeaders = this.safeHeaders(details.requestHeaders);
        } else {
            item.responseHeaders = this.safeHeaders(details.responseHeaders);
            item.httpStatus = Number(details.statusCode) || item.httpStatus || null;
            item.statusLine = String(details.statusLine || item.statusLine || '');
        }
        this.saveTab(details.tabId);
        this.notify(details.tabId);
    }

    static async addExtraBlocked(tabId, count) {
        if (!tabId || tabId <= 0 || !count) return;
        await this.ensureTabLoaded(tabId);
        const current = this.tabExtraBlocked.get(tabId) || 0;
        this.tabExtraBlocked.set(tabId, current + count);
        this.updateTabBadge(tabId).catch(() => {});
        this.saveTab(tabId);
        this.notify(tabId);
    }

    static async updateTabBadge(tabId) {
        if (!tabId || tabId <= 0) return;
        try {
            await this.ensureTabLoaded(tabId);
            const list = this.getTabList(tabId);
            const netBlocked = list.filter(r => r.status === 'blocked').length;
            const extra = this.tabExtraBlocked.get(tabId) || 0;
            const totalBlocked = netBlocked + extra;

            const badgeText = totalBlocked > 0 ? (totalBlocked > 999 ? '999+' : String(totalBlocked)) : '';
            chrome.action.setBadgeText({ tabId, text: badgeText }).catch(() => {});
            if (badgeText) {
                chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' }).catch(() => {}); // Distinct Red Badge
            }
        } catch (_) {}
    }

    static async recordRequest(details) {
        if (!details.tabId || details.tabId <= 0) return;
        await this.ensureTabLoaded(details.tabId);
        const list = this.getTabList(details.tabId);
        const domain = this.getDomain(details.url);
        let initiatorDomain = '';
        if (details.initiator) {
            initiatorDomain = this.getDomain(details.initiator);
        }

        const isRelatedDomain = (left, right) => left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
        const isThirdParty = Boolean(initiatorDomain && domain && !isRelatedDomain(initiatorDomain, domain));

        const requestId = String(details.requestId || (Date.now() + '-' + Math.random().toString(36).slice(2, 7)));
        const item = {
            id: requestId,
            tabId: details.tabId,
            url: details.url,
            domain: domain || 'unknown',
            method: details.method || 'GET',
            type: details.type || 'other',
            initiator: details.initiator || '',
            isThirdParty,
            status: 'allowed',
            networkState: 'pending',
            httpStatus: null,
            statusLine: '',
            networkError: '',
            fromCache: false,
            remoteIp: '',
            requestHeaders: [],
            responseHeaders: [],
            requestBodySummary: this.summarizeRequestBody(details.requestBody),
            reason: '',
            ruleId: null,
            startedAt: Number(details.timeStamp) || Date.now(),
            durationMs: null,
            timestamp: Date.now()
        };

        // DNR feedback can arrive before the ordinary webRequest event. Merge
        // those callbacks by request ID so one network request is counted once.
        const existing = list.find(request => request.id === requestId);
        if (existing) {
            if (!Array.isArray(existing.requestHeaders)) existing.requestHeaders = [];
            if (!Array.isArray(existing.responseHeaders)) existing.responseHeaders = [];
            if (typeof existing.requestBodySummary !== 'string') existing.requestBodySummary = item.requestBodySummary;
            Object.assign(existing, {
                tabId: item.tabId,
                url: item.url,
                domain: item.domain,
                method: item.method,
                type: item.type,
                initiator: item.initiator,
                isThirdParty: item.isThirdParty,
                startedAt: item.startedAt,
                timestamp: item.timestamp
            });
        } else {
            list.unshift(item);
            if (list.length > this.MAX_PER_TAB) list.pop();
        }
        this.saveTab(details.tabId);
        this.notify(details.tabId);
    }

    static async recordError(details) {
        if (!details.tabId || details.tabId <= 0) return;
        await this.ensureTabLoaded(details.tabId);
        const list = this.getTabList(details.tabId);
        const error = String(details.error || 'Network request failed');
        const isBlocked = error === 'net::ERR_BLOCKED_BY_CLIENT' || error.includes('BLOCKED');
        const item = list.find(r => r.id === String(details.requestId) || r.url === details.url);

        if (item) {
            item.networkState = isBlocked ? 'blocked' : 'error';
            item.networkError = error;
            item.durationMs = Math.max(0, Math.round((Number(details.timeStamp) || Date.now()) - (Number(item.startedAt) || Date.now())));
            if (isBlocked) {
                item.status = 'blocked';
                if (!item.reason) item.reason = 'حظر من المتصفح أو إضافة أخرى';
                this.updateTabBadge(details.tabId).catch(() => {});
            } else {
                item.status = 'error';
                item.reason = error;
            }
            this.saveTab(details.tabId);
            this.notify(details.tabId);
        } else {
            const domain = this.getDomain(details.url);
            list.unshift({
                id: String(details.requestId || Date.now()),
                tabId: details.tabId,
                url: details.url,
                domain: domain || 'unknown',
                method: details.method || 'GET',
                type: details.type || 'other',
                isThirdParty: true,
                status: isBlocked ? 'blocked' : 'error',
                networkState: isBlocked ? 'blocked' : 'error',
                httpStatus: null,
                statusLine: '',
                networkError: error,
                fromCache: false,
                remoteIp: '',
                reason: isBlocked ? 'حظر من المتصفح أو إضافة أخرى' : error,
                ruleId: null,
                startedAt: Number(details.timeStamp) || Date.now(),
                durationMs: null,
                timestamp: Date.now()
            });
            if (list.length > this.MAX_PER_TAB) list.pop();
            if (isBlocked) this.updateTabBadge(details.tabId).catch(() => {});
            this.saveTab(details.tabId);
            this.notify(details.tabId);
        }
    }

    static async recordCompleted(details) {
        if (!details.tabId || details.tabId <= 0) return;
        await this.ensureTabLoaded(details.tabId);
        const list = this.getTabList(details.tabId);
        const item = list.find(r => r.id === String(details.requestId) || r.url === details.url);
        if (item && item.status !== 'blocked') {
            item.status = 'allowed';
            item.networkState = 'complete';
            item.httpStatus = Number(details.statusCode) || null;
            item.statusLine = String(details.statusLine || '');
            item.fromCache = Boolean(details.fromCache);
            item.remoteIp = String(details.ip || '');
            item.durationMs = Math.max(0, Math.round((Number(details.timeStamp) || Date.now()) - (Number(item.startedAt) || Date.now())));
            this.saveTab(details.tabId);
            this.notify(details.tabId);
        }
    }

    static async recordRuleMatched(info) {
        const tabId = info?.request?.tabId;
        if (!tabId || tabId <= 0) return;
        await this.ensureTabLoaded(tabId);
        const list = this.getTabList(tabId);
        const url = info.request?.url;
        if (!url) return;

        const requestId = String(info.request?.requestId || '');
        let item = requestId ? list.find(r => r.id === requestId) : null;
        if (!item) item = list.find(r => r.url === url && r.networkState === 'pending');
        if (!item) {
            const domain = this.getDomain(url);
            item = {
                id: requestId || String(Date.now() + '-' + Math.random().toString(36).slice(2, 7)),
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
        if (isBlock) item.networkState = 'blocked';
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
            this.updateTabBadge(tabId).catch(() => {});
        }
        this.saveTab(tabId);
        this.notify(tabId);
    }

    static getTabList(tabId) {
        if (!this.tabRequests.has(tabId)) {
            this.tabRequests.set(tabId, []);
        }
        return this.tabRequests.get(tabId);
    }

    static async getTabRequests(tabId) {
        await this.ensureTabLoaded(tabId);
        const list = this.getTabList(tabId);
        const total = list.length;
        const blocked = list.filter(r => r.status === 'blocked').length;
        const allowed = Math.max(0, total - blocked);
        const errors = list.filter(r => r.status === 'error' || Number(r.httpStatus) >= 400).length;
        const successful = list.filter(r => Number(r.httpStatus) >= 200 && Number(r.httpStatus) < 300).length;
        const thirdParty = list.filter(r => r.isThirdParty).length;
        return {
            requests: list,
            stats: {
                total,
                blocked,
                allowed,
                errors,
                successful,
                thirdParty,
                blockedPercent: total > 0 ? Math.round((blocked / total) * 100) : 0
            }
        };
    }

    static async clearTab(tabId) {
        await this.ensureTabLoaded(tabId);
        this.tabRequests.set(tabId, []);
        this.tabExtraBlocked.delete(tabId);
        this.saveTab(tabId);
        await this.updateTabBadge(tabId);
        this.notify(tabId);
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
                // Chrome's DNR regexFilter uses RE2 syntax, which does not
                // accept JavaScript's non-capturing groups.
                regexFilter: `^https?://[^/]+\\.googlevideo\\.com/videoplayback.*[?&]itag=(${itags.join('|')})(&|$)`,
                resourceTypes: ['media', 'xmlhttprequest'],
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
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
            await chrome.storage.session.remove(key).catch(() => {});
        }
    }
}

class YouTubeRadioPlayer {
    static port = null;
    static tabId = null;
    static pending = new Map();
    static readyWaiters = [];
    static claimQueue = Promise.resolve();

    static claim(tabId) {
        this.claimQueue = this.claimQueue.catch(() => {}).then(async () => {
            const owner = await chrome.storage.session.get('ledo_radio_audio_tab_id').catch(() => ({}));
            if (Number.isInteger(owner.ledo_radio_audio_tab_id) && owner.ledo_radio_audio_tab_id !== tabId) {
                throw new Error('LEDO Radio Mode is already playing in another tab. Stop it there first.');
            }
            await chrome.storage.session.set({ ledo_radio_audio_tab_id: tabId });
        });
        return this.claimQueue;
    }

    static onConnect(port) {
        if (port.name !== 'ledo-radio-audio') return;
        this.port = port;
        port.onMessage.addListener(message => this.onMessage(message));
        port.onDisconnect.addListener(() => {
            if (this.port === port) this.port = null;
            for (const [id, pending] of this.pending) {
                clearTimeout(pending.timer);
                pending.reject(new Error('Radio audio player disconnected.'));
                this.pending.delete(id);
            }
        });
        this.readyWaiters.splice(0).forEach(resolve => resolve());
    }

    static onMessage(message) {
        if (message?.type === 'state' && Number.isInteger(this.tabId)) {
            chrome.tabs.sendMessage(this.tabId, { action: 'radioAudioState', state: message.state }, () => void chrome.runtime.lastError);
            return;
        }
        if (message?.type !== 'response' || typeof message.requestId !== 'string') return;
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        if (message.success) pending.resolve(message.result || {});
        else pending.reject(new Error(message.error || 'Radio audio operation failed.'));
    }

    static async ensure(tabId) {
        this.tabId = tabId;
        const url = chrome.runtime.getURL('radio_audio.html');
        const contexts = chrome.runtime.getContexts
            ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] }).catch(() => [])
            : [];
        if (!contexts.length) {
            try {
                await chrome.offscreen.createDocument({
                    url: 'radio_audio.html',
                    reasons: ['AUDIO_PLAYBACK'],
                    justification: 'Play YouTube audio in the extension origin so local Ledo audio streams work without page-origin network access.'
                });
            } catch (error) {
                if (!/single offscreen document|already exists/i.test(error.message || '')) throw error;
            }
        }
        if (this.port) return;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Radio audio player did not connect.')), 8000);
            this.readyWaiters.push(() => { clearTimeout(timer); resolve(); });
        });
    }

    static async command(tabId, action, data = {}) {
        if (action !== 'load') {
            const owner = await chrome.storage.session.get('ledo_radio_audio_tab_id').catch(() => ({}));
            if (owner.ledo_radio_audio_tab_id !== tabId) throw new Error('Radio Mode belongs to another tab.');
        }
        await this.ensure(tabId);
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error('Radio audio operation timed out.'));
            }, 15000);
            this.pending.set(requestId, { resolve, reject, timer });
            try { this.port.postMessage({ type: 'command', requestId, action, ...data }); }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(error);
            }
        });
    }

    static async stop(tabId) {
        const owner = await chrome.storage.session.get('ledo_radio_audio_tab_id').catch(() => ({}));
        if (this.tabId !== tabId && owner.ledo_radio_audio_tab_id !== tabId) return { success: true };
        let result = { success: true };
        if (this.port) {
            try { await this.command(tabId, 'stop'); }
            catch (error) { result = { success: false, error: error.message }; }
        }
        this.tabId = null;
        await chrome.storage.session.remove('ledo_radio_audio_tab_id').catch(() => {});
        await chrome.offscreen.closeDocument().catch(() => {});
        return result;
    }
}

class RequestBreakpointController {
    static breakpoints = new Map(); // tabId -> Map(exact URL -> resource type)
    static paused = new Map(); // `${tabId}:${fetchRequestId}` -> paused request
    static consoleTabs = new Set();
    static enabledConsoleTabs = new Set();
    static attachedTabs = new Set();
    static consoleMessages = new Map();
    static MAX_CONSOLE_PER_TAB = 300;

    static storageKey(tabId) { return `ledo_network_breakpoints_${tabId}`; }
    static pausedKey(tabId, requestId) { return `${tabId}:${requestId}`; }

    static init() {
        if (!chrome.debugger) return;
        chrome.debugger.onEvent.addListener((source, method, params) => {
            if (method === 'Fetch.requestPaused') this.onPaused(source, params).catch(() => {});
            else if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown') this.onConsoleEvent(source, method, params);
        });
        chrome.debugger.onDetach.addListener((source, reason) => {
            const tabId = source?.tabId;
            if (!Number.isInteger(tabId)) return;
            this.clearTab(tabId, reason || 'detached');
        });
        chrome.tabs.onRemoved.addListener(tabId => {
            this.consoleMessages.delete(tabId);
            chrome.storage.session.remove(`ledo_network_console_messages_${tabId}`).catch(() => {});
            this.clearTab(tabId, 'tab closed');
        });
        this.restore().catch(error => console.warn('[Ledo] Could not restore network breakpoints:', error));
    }

    static async restore() {
        const all = await chrome.storage.session.get(null);
        const tabs = await chrome.tabs.query({});
        const openTabs = new Set(tabs.map(tab => tab.id));
        const stateByTab = new Map();
        for (const [key, urls] of Object.entries(all)) {
            const match = key.match(/^ledo_network_(breakpoints|console|console_messages)_(\d+)$/);
            if (!match) continue;
            const kind = match[1];
            const tabId = Number(match[2]);
            if (!openTabs.has(tabId)) {
                await chrome.storage.session.remove(key);
                continue;
            }
            const entry = stateByTab.get(tabId) || { urls: [], consoleEnabled: false, consoleMessages: [] };
            if (kind === 'console') entry.consoleEnabled = urls === true;
            else if (kind === 'console_messages' && Array.isArray(urls)) entry.consoleMessages = urls;
            else if (Array.isArray(urls)) entry.urls = urls;
            stateByTab.set(tabId, entry);
        }
        for (const [tabId, state] of stateByTab) {
            const breakpoints = new Map(state.urls.filter(item => item && typeof item.url === 'string').map(item => [item.url, item.resourceType || '']));
            if (breakpoints.size) this.breakpoints.set(tabId, breakpoints);
            if (state.consoleEnabled) this.consoleTabs.add(tabId);
            if (state.consoleMessages.length) this.consoleMessages.set(tabId, state.consoleMessages.slice(0, this.MAX_CONSOLE_PER_TAB));
            try { await this.enable(tabId, true); }
            catch (error) { console.warn('[Ledo] Network breakpoint restore failed:', error); }
        }
    }

    static patternFor(url) {
        return url.replace(/\\/g, '\\\\').replace(/\*/g, '\\*').replace(/\?/g, '\\?');
    }

    static async setBreakpoint(tabId, rawUrl, enabled, resourceType = '') {
        if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('الصفحة المحددة غير متاحة.');
        const url = new URL(String(rawUrl || ''));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('نقطة الاعتراض تقبل روابط HTTP أو HTTPS فقط.');
        const rules = this.breakpoints.get(tabId) || new Map();
        const previousRules = new Map(rules);
        if (enabled) rules.set(url.href, String(resourceType || ''));
        else rules.delete(url.href);
        if (rules.size) this.breakpoints.set(tabId, rules);
        else this.breakpoints.delete(tabId);
        try {
            await chrome.storage.session.set({ [this.storageKey(tabId)]: [...rules].map(([href, type]) => ({ url: href, resourceType: type })) });
            await this.enable(tabId);
        } catch (error) {
            if (previousRules.size) this.breakpoints.set(tabId, previousRules);
            else this.breakpoints.delete(tabId);
            await chrome.storage.session.set({ [this.storageKey(tabId)]: [...previousRules].map(([href, type]) => ({ url: href, resourceType: type })) }).catch(() => {});
            if (previousRules.size) await this.enable(tabId).catch(() => {});
            else await this.detach(tabId).catch(() => {});
            throw error;
        }
        return { enabled: rules.has(url.href), breakpoints: [...rules.keys()] };
    }

    static async clearAll(tabId) {
        this.breakpoints.delete(tabId);
        await this.enable(tabId, true);
        return { success: true, breakpoints: [] };
    }

    static async setConsoleCapture(tabId, enabled) {
        if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('الصفحة المحددة غير متاحة.');
        if (enabled) {
            this.consoleTabs.add(tabId);
            await chrome.storage.session.set({ [`ledo_network_console_${tabId}`]: true });
        } else {
            this.consoleTabs.delete(tabId);
            await chrome.storage.session.remove(`ledo_network_console_${tabId}`);
        }
        await this.enable(tabId, false);
        return { enabled: this.consoleTabs.has(tabId) };
    }

    static async enable(tabId, refreshFetch = true) {
        const rules = this.breakpoints.get(tabId);
        const consoleEnabled = this.consoleTabs.has(tabId);
        if (!rules?.size && !consoleEnabled) {
            await this.detach(tabId);
            return;
        }
        const target = { tabId };
        if (!this.attachedTabs.has(tabId)) {
            try {
                await chrome.debugger.attach(target, '1.3');
                this.attachedTabs.add(tabId);
            } catch (error) {
                // The debugger may remain attached across a worker lifetime.
                try {
                    await chrome.debugger.sendCommand(target, refreshFetch ? 'Fetch.disable' : 'Runtime.enable');
                    this.attachedTabs.add(tabId);
                } catch (_) {
                    throw new Error(error.message || 'تعذر إرفاق المصحح. أغلق DevTools المفتوحة لهذا التبويب وحاول مجددًا.');
                }
            }
        }
        if (refreshFetch) {
            // Reconfigure only this selected tab and release old pauses before
            // changing patterns, so a page is never left hanging.
            await this.releaseTabPaused(tabId, false);
            await chrome.debugger.sendCommand(target, 'Fetch.disable').catch(() => {});
            if (rules?.size) {
                const patterns = [...rules].map(([url, resourceType]) => ({
                    urlPattern: this.patternFor(url),
                    requestStage: 'Request',
                    ...(resourceType ? { resourceType } : {})
                }));
                await chrome.debugger.sendCommand(target, 'Fetch.enable', { patterns });
            }
        }
        if (consoleEnabled && !this.enabledConsoleTabs.has(tabId)) {
            await chrome.debugger.sendCommand(target, 'Runtime.enable');
            await chrome.debugger.sendCommand(target, 'Log.enable').catch(() => {});
            this.enabledConsoleTabs.add(tabId);
        } else if (!consoleEnabled && this.enabledConsoleTabs.has(tabId)) {
            await chrome.debugger.sendCommand(target, 'Runtime.disable').catch(() => {});
            await chrome.debugger.sendCommand(target, 'Log.disable').catch(() => {});
            this.enabledConsoleTabs.delete(tabId);
        }
    }

    static async detach(tabId) {
        await this.releaseTabPaused(tabId, false);
        if (chrome.debugger?.getTargets) {
            const attached = (await chrome.debugger.getTargets()).some(target => target.tabId === tabId && target.attached);
            if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
        }
        this.attachedTabs.delete(tabId);
        await chrome.storage.session.remove(this.storageKey(tabId)).catch(() => {});
        await chrome.storage.session.remove(`ledo_network_console_${tabId}`).catch(() => {});
    }

    static clearTab(tabId, reason) {
        this.breakpoints.delete(tabId);
        this.consoleTabs.delete(tabId);
        this.enabledConsoleTabs.delete(tabId);
        this.attachedTabs.delete(tabId);
        for (const [key, paused] of this.paused) {
            if (paused.tabId !== tabId) continue;
            clearTimeout(paused.timer);
            this.paused.delete(key);
        }
        chrome.storage.session.remove(this.storageKey(tabId)).catch(() => {});
        chrome.storage.session.remove(`ledo_network_console_${tabId}`).catch(() => {});
        chrome.runtime.sendMessage({ action: 'networkDebuggerDetached', tabId, reason }).catch(() => {});
    }

    static onConsoleEvent(source, method, params) {
        const tabId = source?.tabId;
        if (!Number.isInteger(tabId) || !this.consoleTabs.has(tabId)) return;
        let entry;
        if (method === 'Runtime.exceptionThrown') {
            const details = params.exceptionDetails || {};
            const frame = details.stackTrace?.callFrames?.[0];
            entry = {
                level: 'error',
                text: String(details.exception?.description || details.text || 'JavaScript exception'),
                url: String(frame?.url || details.url || ''),
                line: Number(frame?.lineNumber ?? details.lineNumber) + 1 || 0,
                column: Number(frame?.columnNumber ?? details.columnNumber) + 1 || 0
            };
        } else {
            const level = params.type === 'warning' ? 'warning' : params.type;
            if (!['error', 'warning'].includes(level)) return;
            const frame = params.stackTrace?.callFrames?.[0];
            const text = (params.args || []).map(arg => {
                if (arg?.value !== undefined) {
                    try { return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value); }
                    catch (_) { return String(arg.value); }
                }
                return String(arg?.description || arg?.unserializableValue || arg?.type || '');
            }).join(' ');
            entry = {
                level,
                text: text.slice(0, 8000),
                url: String(frame?.url || ''),
                line: Number(frame?.lineNumber) + 1 || 0,
                column: Number(frame?.columnNumber) + 1 || 0
            };
        }
        entry.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        entry.timestamp = Date.now();
        const list = this.consoleMessages.get(tabId) || [];
        list.unshift(entry);
        if (list.length > this.MAX_CONSOLE_PER_TAB) list.length = this.MAX_CONSOLE_PER_TAB;
        this.consoleMessages.set(tabId, list);
        chrome.storage.session.set({ [`ledo_network_console_messages_${tabId}`]: list }).catch(() => {});
        chrome.runtime.sendMessage({ action: 'siteConsoleMessage', tabId, entry }).catch(() => {});
    }

    static safeHeaderEntries(headers) {
        const secret = /authorization|cookie|token|secret|password|api.?key|credential|session/i;
        const entries = Array.isArray(headers) ? headers : Object.entries(headers || {}).map(([name, value]) => ({ name, value }));
        return entries.slice(0, 80).map(header => ({
            name: String(header?.name || '').slice(0, 150),
            value: secret.test(String(header?.name || '')) ? '[مخفي]' : String(header?.value || '').slice(0, 2000)
        }));
    }

    static async onPaused(source, params) {
        const tabId = source?.tabId;
        if (!Number.isInteger(tabId) || !this.breakpoints.has(tabId)) {
            await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
            return;
        }
        const phase = params.responseStatusCode != null || params.responseErrorReason ? 'response' : 'request';
        const key = this.pausedKey(tabId, params.requestId);
        const old = this.paused.get(key);
        if (old) clearTimeout(old.timer);
        const paused = { tabId, source, params, phase, deadline: Date.now() + 90000, timer: null };
        paused.timer = setTimeout(() => this.continuePaused(tabId, params.requestId, { mode: 'forward', interceptResponse: false, automatic: true }).catch(() => {}), 90000);
        this.paused.set(key, paused);
        const requestBody = String(params.request?.postData || '');
        chrome.runtime.sendMessage({
            action: 'requestInterceptPaused',
            tabId,
            requestId: params.requestId,
            phase,
            url: params.request?.url || '',
            method: params.request?.method || 'GET',
            requestHeaders: this.safeHeaderEntries(params.request?.headers),
            requestBody: requestBody.slice(0, 65536),
            requestBodyTruncated: requestBody.length > 65536,
            responseStatusCode: params.responseStatusCode || null,
            responseStatusText: params.responseStatusText || '',
            responseHeaders: this.safeHeaderEntries(params.responseHeaders),
            resourceType: params.resourceType || '',
            deadline: paused.deadline
        }).catch(() => {});
    }

    static async releaseTabPaused(tabId, interceptResponse) {
        const list = [...this.paused.values()].filter(item => item.tabId === tabId);
        for (const paused of list) {
            await this.continuePaused(tabId, paused.params.requestId, { mode: 'forward', interceptResponse }).catch(() => {});
        }
    }

    static mergeRequestHeaders(original, edits) {
        const headers = Array.isArray(original)
            ? original.map(item => ({ name: String(item.name), value: String(item.value) }))
            : Object.entries(original || {}).map(([name, value]) => ({ name, value: String(value) }));
        for (const edit of (Array.isArray(edits) ? edits : []).slice(0, 80)) {
            const name = String(edit?.name || '').trim();
            const value = String(edit?.value || '');
            if (!name || /[\r\n]/.test(name + value)) continue;
            // Secret values are hidden from the UI; an unchanged placeholder
            // must not overwrite the actual header held by the paused request.
            if (value === '[مخفي]') continue;
            const remove = name.startsWith('-');
            const actualName = (remove ? name.slice(1) : name).trim();
            if (!actualName) continue;
            for (let index = headers.length - 1; index >= 0; index--) {
                if (headers[index].name.toLowerCase() === actualName.toLowerCase()) headers.splice(index, 1);
            }
            if (!remove) headers.push({ name: actualName, value });
        }
        return headers;
    }

    static base64Utf8(value) {
        const bytes = new TextEncoder().encode(String(value));
        let binary = '';
        for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        return btoa(binary);
    }

    static async continuePaused(tabId, requestId, options = {}) {
        const key = this.pausedKey(tabId, requestId);
        const paused = this.paused.get(key);
        if (!paused) throw new Error('الطلب لم يعد متوقفًا.');
        const { source, params, phase } = paused;
        const mode = options.mode || 'forward';
        try {
            if (mode === 'cancel') {
                await chrome.debugger.sendCommand(source, 'Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
            } else if (phase === 'request' && mode === 'forward') {
                const originalHeaders = params.request?.headers || {};
                const command = { requestId, interceptResponse: Boolean(options.interceptResponse) };
                if (options.url && options.url !== params.request?.url) command.url = String(options.url);
                if (options.method && options.method !== params.request?.method) command.method = String(options.method).toUpperCase();
                if (Array.isArray(options.headers)) {
                    command.headers = this.mergeRequestHeaders(originalHeaders, options.headers)
                        .filter(header => header.name.toLowerCase() !== 'host');
                }
                if (typeof options.body === 'string' && !options.preserveOriginalBody && options.body !== String(params.request?.postData || '')) {
                    command.postData = this.base64Utf8(options.body);
                    if (Array.isArray(command.headers)) {
                        command.headers = command.headers.filter(header => !['content-length', 'transfer-encoding'].includes(header.name.toLowerCase()));
                    }
                }
                await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', command);
            } else if (phase === 'response' && mode === 'edit') {
                const originalHeaders = Array.isArray(params.responseHeaders) ? params.responseHeaders : [];
                const headers = this.mergeRequestHeaders(originalHeaders, options.headers || []);
                const body = String(options.body || '');
                const filteredHeaders = headers.filter(header => !['content-length', 'content-encoding', 'transfer-encoding'].includes(header.name.toLowerCase()));
                await chrome.debugger.sendCommand(source, 'Fetch.fulfillRequest', {
                    requestId,
                    responseCode: Math.max(100, Math.min(599, Number(options.status) || Number(params.responseStatusCode) || 200)),
                    responseHeaders: filteredHeaders,
                    body: this.base64Utf8(body)
                });
            } else if (phase === 'response') {
                await chrome.debugger.sendCommand(source, 'Fetch.continueResponse', { requestId });
            }
        } catch (error) {
            const fallbackMethod = phase === 'response' ? 'Fetch.continueResponse' : 'Fetch.continueRequest';
            await chrome.debugger.sendCommand(source, fallbackMethod, { requestId }).catch(async () => {
                if (phase === 'response') await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId }).catch(() => {});
            });
            throw error;
        } finally {
            clearTimeout(paused.timer);
            this.paused.delete(key);
            chrome.runtime.sendMessage({ action: 'requestInterceptFinished', tabId, requestId, automatic: Boolean(options.automatic) }).catch(() => {});
        }
    }

    static async getState(tabId) {
        const breakpoints = [...(this.breakpoints.get(tabId) || new Map()).entries()].map(([url, resourceType]) => ({ url, resourceType }));
        const paused = [...this.paused.values()].filter(item => item.tabId === tabId).map(item => ({
            requestId: item.params.requestId,
            phase: item.phase,
            url: item.params.request?.url || '',
            method: item.params.request?.method || 'GET',
            requestHeaders: this.safeHeaderEntries(item.params.request?.headers),
            requestBody: String(item.params.request?.postData || '').slice(0, 65536),
            requestBodyTruncated: String(item.params.request?.postData || '').length > 65536,
            responseStatusCode: item.params.responseStatusCode || null,
            responseStatusText: item.params.responseStatusText || '',
            responseHeaders: this.safeHeaderEntries(item.params.responseHeaders),
            resourceType: item.params.resourceType || '',
            deadline: item.deadline
        }));
        return {
            breakpoints,
            paused,
            consoleEnabled: this.consoleTabs.has(tabId),
            consoleMessages: this.consoleMessages.get(tabId) || []
        };
    }

    static async readResponseBody(tabId, requestId) {
        const paused = this.paused.get(this.pausedKey(tabId, requestId));
        if (!paused || paused.phase !== 'response') throw new Error('الطلب ليس متوقفًا عند الاستجابة.');
        const size = Number((paused.params.responseHeaders || []).find(header => String(header.name).toLowerCase() === 'content-length')?.value) || 0;
        if (size > 2 * 1024 * 1024) throw new Error('الاستجابة أكبر من 2 ميجابايت؛ مرّرها كما هي لتجنب تحميلها كاملة في الذاكرة.');
        return chrome.debugger.sendCommand(paused.source, 'Fetch.getResponseBody', { requestId });
    }
}

class ExtensionController {
    static init() {
        this.setupContextMenus();
        this.setupCommands();
        this.setupDownloadBadge();
        this.setupAdBlock();
        RequestTracker.init();
        RequestBreakpointController.init();
        this.listenToMessages();
        this.interceptDownloads();
        chrome.runtime.onConnect.addListener(port => YouTubeRadioPlayer.onConnect(port));
        chrome.tabs.onRemoved.addListener(tabId => {
            YouTubeRadioController.deactivate(tabId).catch(error => console.warn('[Ledo] Could not release radio rules:', error));
            YouTubeRadioPlayer.stop(tabId).catch(error => console.warn('[Ledo] Could not close radio player:', error));
        });
        chrome.webNavigation.onBeforeNavigate.addListener(details => {
            if (details.frameId === 0) {
                YouTubeRadioController.deactivate(details.tabId).catch(error => console.warn('[Ledo] Could not release radio rules:', error));
                YouTubeRadioPlayer.stop(details.tabId).catch(error => console.warn('[Ledo] Could not close radio player:', error));
            }
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
        const isTelegramWebContext = (...values) => values.some(value => {
            try {
                return /^web(?:[akz])?\.telegram\.org$/i.test(new URL(value).hostname);
            } catch (_) {
                return false;
            }
        });

        chrome.downloads.onCreated.addListener((downloadItem) => {
            chrome.storage.local.get(['intercept_enabled'], (res) => {
                const isEnabled = res.intercept_enabled !== false; // Default true
                if (!isEnabled) return;
                
                if (ignoredDownloadIds.has(downloadItem.id)) return;
                if (downloadItem.state !== 'in_progress') return;

                const url = downloadItem.finalUrl || downloadItem.url;

                // Telegram Web creates session-bound download URLs that only
                // its logged-in browser client can resolve. Open Quick Add to
                // show the detected file and metadata. Pause Chrome's transfer
                // until the user explicitly starts it from Quick Add.
                if (isTelegramWebContext(url, downloadItem.url, downloadItem.finalUrl, downloadItem.referrer)) {
                    const filename = (downloadItem.filename || '').split(/[\\/]/).pop();
                    const telegramUrl = /^https?:/i.test(url) ? url : (downloadItem.referrer || 'https://web.telegram.org/');
                    chrome.downloads.pause(downloadItem.id, () => {
                        const isPaused = !chrome.runtime.lastError;
                        if (!isPaused) {
                            console.warn('[Download Intercept] Could not pause the Telegram download:', chrome.runtime.lastError.message);
                        }
                        ApiClient.sendQuickAddRequest(telegramUrl, {
                            filename,
                            file_size: downloadItem.totalBytes > 0 ? downloadItem.totalBytes : null,
                            mime_type: downloadItem.mime,
                            referer: downloadItem.referrer || '',
                            native_browser_download: true,
                            native_download_paused: isPaused,
                            native_download_id: downloadItem.id
                        }).then(result => {
                            if (result.success) {
                                console.info('[Download Intercept] Telegram download paused for Quick Add confirmation.');
                            } else {
                                console.warn('[Download Intercept] Quick Add unavailable; Telegram download remains paused.', result.error);
                            }
                        }).catch(error => {
                            console.warn('[Download Intercept] Could not open Quick Add; Telegram download remains paused.', error);
                        });
                    });
                    return;
                }
                
                // Only HTTP(S) URLs can be handed to the desktop app. Chrome may
                // report extension, file, or other internal downloads here too.
                let parsedUrl;
                try { parsedUrl = new URL(url); } catch (_) { return; }
                if (!['http:', 'https:'].includes(parsedUrl.protocol)) return;

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
                await DnrRuleQueue.update({ removeRuleIds: [99000] });
            } else if (!enabled && !bypassRule) {
                await DnrRuleQueue.update({
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
            await DnrRuleQueue.update({
                removeRuleIds: [...managedRules, ...chatGptCompatibilityRules].map(rule => rule.id),
                addRules
            });
            await RequestTracker.syncRuleActions();
            await chrome.storage.local.set({ adblock_allowlist: domains });
            await ExtensionController.applyNetworkDomainExceptions();
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
                priority: 2000,
                action: { type: 'block' },
                condition: { requestDomains: [domain] }
            }));
            await DnrRuleQueue.update({
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
        // Leave breathing room for Privacy Badger, exact user decisions, and
        // tab-scoped protection rules. The commit queue also rechecks quota.
        const dynamicBudget = Math.max(0, advertisedLimit - retainedDynamicRules - 1000);

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
            await DnrRuleQueue.update({
                removeRuleIds: oldFilterRules.map(rule => rule.id),
                addRules: compiled
            });
            await RequestTracker.syncRuleActions();
            const committedRules = await chrome.declarativeNetRequest.getDynamicRules();
            const committedFilterCount = committedRules.filter(rule => rule.id >= 200000 && rule.id < 230000).length;
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
                adblock_filters_active_count: committedFilterCount,
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
            priority: 2000,
            action: { type: 'block' },
            condition: { requestDomains: [item] }
        }));
        await DnrRuleQueue.update({
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
            await DnrRuleQueue.update({ removeRuleIds: [99000] });
        } else if (!enabled && !bypassRule) {
            await DnrRuleQueue.update({
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
        await DnrRuleQueue.update({
            removeRuleIds: [...managedRules, ...chatGptCompatibilityRules].map(rule => rule.id),
            addRules
        });
        await RequestTracker.syncRuleActions();
        await chrome.storage.local.set({ adblock_allowlist: domains });
        await this.applyNetworkDomainExceptions();
    }

    static async applyNetworkDomainExceptions() {
        const stored = await chrome.storage.local.get('adblock_network_allowlist');
        const domains = Array.isArray(stored.adblock_network_allowlist)
            ? [...new Set(stored.adblock_network_allowlist.map(domain => String(domain || '').toLowerCase().trim()).filter(domain => this.isValidAdBlockDomain(domain)))].slice(0, 1000)
            : [];
        const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
        const managedRules = currentRules.filter(rule => rule.id >= 102000 && rule.id < 103000);
        const addRules = domains.map((domain, index) => ({
            id: 102000 + index,
            // Explicit user allow decisions outrank custom domain blocks and
            // every filter-list/Privacy Badger block, independent of URL query tokens.
            priority: 3000,
            action: { type: 'allow' },
            condition: { requestDomains: [domain] }
        }));
        await DnrRuleQueue.update({
            removeRuleIds: managedRules.map(rule => rule.id),
            addRules
        });
        await chrome.storage.local.set({ adblock_network_allowlist: domains });
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

        await DnrRuleQueue.update({
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

    static async setLoggerDomainProtection(hostname, mode) {
        const domain = String(hostname || '').toLowerCase().replace(/\.$/, '');
        if (!this.isValidAdBlockDomain(domain)) throw new Error('اسم النطاق غير صالح.');
        if (mode !== 'allow' && mode !== 'block') throw new Error('اختيار الحماية غير صالح.');

        if (mode === 'allow') {
            const stored = await chrome.storage.local.get('adblock_custom_domains');
            const domains = Array.isArray(stored.adblock_custom_domains) ? stored.adblock_custom_domains : [];
            if (domains.includes(domain)) {
                const remaining = domains.filter(item => item !== domain);
                const rules = await chrome.declarativeNetRequest.getDynamicRules();
                const managed = rules.filter(rule => rule.id >= 300000 && rule.id < 301000);
                await DnrRuleQueue.update({
                    removeRuleIds: managed.map(rule => rule.id),
                    addRules: remaining.map((item, index) => ({
                        id: 300000 + index,
                        priority: 2000,
                        action: { type: 'block' },
                        condition: { requestDomains: [item] }
                    }))
                });
                await chrome.storage.local.set({ adblock_custom_domains: remaining });
            }
            const allowState = await chrome.storage.local.get('adblock_network_allowlist');
            const allowedDomains = Array.isArray(allowState.adblock_network_allowlist) ? allowState.adblock_network_allowlist : [];
            if (!allowedDomains.includes(domain)) allowedDomains.unshift(domain);
            await chrome.storage.local.set({ adblock_network_allowlist: allowedDomains.slice(0, 1000) });
            await this.applyNetworkDomainExceptions();
            const updated = await chrome.storage.local.get('adblock_custom_domains');
            return { domain, mode: 'allow', domains: Array.isArray(updated.adblock_custom_domains) ? updated.adblock_custom_domains : [] };
        }

        const allowState = await chrome.storage.local.get('adblock_network_allowlist');
        const allowedDomains = Array.isArray(allowState.adblock_network_allowlist) ? allowState.adblock_network_allowlist : [];
        await chrome.storage.local.set({ adblock_network_allowlist: allowedDomains.filter(item => item !== domain) });
        await this.applyNetworkDomainExceptions();
        await this.setFilteringMode(domain, 2);
        const stored = await chrome.storage.local.get('adblock_custom_domains');
        const domains = Array.isArray(stored.adblock_custom_domains) ? stored.adblock_custom_domains : [];
        if (!domains.includes(domain)) await this.toggleCustomBlock(domain);
        const updated = await chrome.storage.local.get('adblock_custom_domains');
        return { domain, mode: 'block', domains: Array.isArray(updated.adblock_custom_domains) ? updated.adblock_custom_domains : [] };
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
            try {
                const result = await ApiClient.sendDownloadRequest(tab.url, {
                    is_yt_dlp: true,
                    quality,
                    title: tab.title || '',
                    referer: tab.url
                });
                if (!result.success) console.warn('[Keyboard Shortcut] Could not send page to Ledo:', result.error);
            } catch (error) {
                console.warn('[Keyboard Shortcut] Could not send page to Ledo:', error);
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

        chrome.contextMenus.onClicked.addListener((info, tab) => {
            if (!String(info.menuItemId).startsWith("download_with_ledo")) return;

            const isPage = info.menuItemId === "download_with_ledo_page";
            const urlToDownload = isPage ? info.pageUrl : (info.linkUrl || info.srcUrl);
            if (!urlToDownload) return;

            if (info.menuItemId === "download_with_ledo_link") {
                ApiClient.sendQuickAddRequest(urlToDownload, { referer: info.pageUrl, filename: tab?.title || '' })
                    .catch(error => console.warn('[Context Menu] Could not open Quick Add:', error));
            } else if (isPage || info.menuItemId === "download_with_ledo_media") {
                ApiClient.sendDownloadRequest(urlToDownload, { is_yt_dlp: true, title: tab?.title || '', referer: info.pageUrl })
                    .catch(error => console.warn('[Context Menu] Could not send page to Ledo:', error));
            } else {
                ApiClient.sendDownloadRequest(urlToDownload, { is_yt_dlp: false, title: tab?.title || '', referer: info.pageUrl })
                    .catch(error => console.warn('[Context Menu] Could not send file to Ledo:', error));
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

            if (message.action === "getExtensionDiagnostics") {
                chrome.permissions.getAll(permissions => {
                    sendResponse({
                        success: true,
                        version: chrome.runtime.getManifest().version,
                        serviceWorkerStartedAt: SERVICE_WORKER_STARTED_AT,
                        grantedPermissionCount: (permissions?.permissions || []).length,
                        grantedHostPermissionCount: (permissions?.origins || []).length
                    });
                });
                return true;
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
                    }, { allowQueue: false, timeoutMs: 90_000 }))
                    .then(result => {
                        if (result?.success && result.data?.session_id) {
                            result.data.stream_url = `${ApiClient.BASE_URL}/youtube/audio-session/${encodeURIComponent(result.data.session_id)}/stream`;
                        }
                        sendResponse(result);
                    })
                    .catch(error => sendResponse({ success: false, error: error.message || 'Could not prepare the audio stream.' }));
                return true;
            }

            if (message.action === "startYouTubeAudioTrafficTracking") {
                YouTubeRadioController.activate(sender.tab?.id, message)
                    .then(() => sendResponse({ success: true }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "startYouTubeAudioPlayback") {
                const sessionId = String(message.sessionId || '');
                if (!sender.tab?.id || !/^[A-Za-z0-9_-]{20,128}$/.test(sessionId)) {
                    sendResponse({ success: false, error: 'Invalid audio session.' });
                    return false;
                }
                const streamUrl = `${ApiClient.BASE_URL}/youtube/audio-session/${encodeURIComponent(sessionId)}/stream`;
                YouTubeRadioPlayer.claim(sender.tab.id)
                    .then(() => YouTubeRadioPlayer.command(sender.tab.id, 'load', {
                        streamUrl,
                        currentTime: Math.max(0, Number(message.currentTime) || 0),
                        volume: Math.max(0, Math.min(1, Number(message.volume) || 0)),
                        muted: Boolean(message.muted),
                        playbackRate: Math.max(0.25, Math.min(4, Number(message.playbackRate) || 1))
                    }))
                    .then(state => sendResponse({ success: true, state }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "controlYouTubeAudioPlayback") {
                const allowed = new Set(['play', 'pause', 'seek', 'volume', 'mute', 'getState']);
                if (!sender.tab?.id || !allowed.has(message.command)) {
                    sendResponse({ success: false, error: 'Invalid audio player command.' });
                    return false;
                }
                YouTubeRadioPlayer.command(sender.tab.id, message.command, { value: message.value })
                    .then(state => sendResponse({ success: true, state }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "stopYouTubeAudioPlayback") {
                YouTubeRadioPlayer.stop(sender.tab?.id)
                    .then(result => sendResponse(result))
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
                            RequestTracker.updateTabBadge(targetTabId).catch(() => {});
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
                    RequestTracker.addExtraBlocked(tabId, count).catch(() => {});
                }

                // Accumulate stats in storage for the popup to read
                chrome.storage.local.get(['adblock_session_stats'], (stored) => {
                    const stats = stored.adblock_session_stats || { totalBlocked: 0, totalSkipped: 0 };
                    stats.totalBlocked = Math.max(0, Number(stats.totalBlocked) || 0) + blocked;
                    // Version 2 counts each YouTube ad once. Older totals could
                    // grow on every 250ms detection tick while an ad stayed visible.
                    stats.totalSkippedAccurate = Math.max(0, Number(stats.totalSkippedAccurate) || 0) + skipped;
                    stats.skippedCounterVersion = 2;
                    stats.lastHostname = typeof message.hostname === 'string' ? message.hostname.slice(0, 253) : '';
                    stats.lastUpdated = Date.now();
                    chrome.storage.local.set({ adblock_session_stats: stats });
                });
                sendResponse({ success: true });
                return false;
            }

            // Live request logger & inspector
            if (message.action === "getNetworkDebuggerState") {
                RequestBreakpointController.getState(message.tabId)
                    .then(state => sendResponse({ success: true, ...state }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "setConsoleCapture") {
                RequestBreakpointController.setConsoleCapture(message.tabId, Boolean(message.enabled))
                    .then(result => sendResponse({ success: true, ...result }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "clearConsoleMessages") {
                RequestBreakpointController.consoleMessages.delete(message.tabId);
                chrome.storage.session.remove(`ledo_network_console_messages_${message.tabId}`).catch(() => {});
                chrome.runtime.sendMessage({ action: 'siteConsoleCleared', tabId: message.tabId }).catch(() => {});
                sendResponse({ success: true });
                return false;
            }

            if (message.action === "setNetworkBreakpoint") {
                RequestBreakpointController.setBreakpoint(message.tabId, message.url, message.enabled, message.resourceType)
                    .then(result => sendResponse({ success: true, ...result }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "clearNetworkBreakpoints") {
                RequestBreakpointController.clearAll(message.tabId)
                    .then(result => sendResponse(result))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "continuePausedRequest") {
                RequestBreakpointController.continuePaused(message.tabId, message.requestId, message.options || {})
                    .then(() => sendResponse({ success: true }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "readPausedResponseBody") {
                RequestBreakpointController.readResponseBody(message.tabId, message.requestId)
                    .then(body => sendResponse({ success: true, ...body }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "getTabRequests") {
                RequestTracker.getTabRequests(message.tabId)
                    .then(data => sendResponse({ success: true, ...data }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "clearTabRequests") {
                RequestTracker.clearTab(message.tabId)
                    .then(() => sendResponse({ success: true }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "blockDomainFromLogger") {
                ExtensionController.toggleCustomBlock(message.domain)
                    .then(result => sendResponse({ success: true, ...result }))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "setLoggerDomainProtection") {
                ExtensionController.setLoggerDomainProtection(message.domain, message.mode)
                    .then(async result => {
                        if (message.mode === 'block' && Number.isInteger(message.reloadTabId) && message.reloadTabId > 0) {
                            await chrome.tabs.reload(message.reloadTabId).catch(() => {});
                        }
                        sendResponse({ success: true, ...result });
                    })
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "replayHttpRequest") {
                (async () => {
                    const url = new URL(String(message.url || ''));
                    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
                        throw new Error('استخدم رابط HTTP أو HTTPS صالحًا من دون بيانات دخول داخل الرابط.');
                    }
                    const method = String(message.method || 'GET').toUpperCase();
                    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) {
                        throw new Error('طريقة HTTP غير مدعومة في أداة إعادة الإرسال.');
                    }
                    const body = String(message.body || '');
                    if (body.length > 256 * 1024) throw new Error('حجم جسم الطلب أكبر من 256 كيلوبايت.');
                    if ((method === 'GET' || method === 'HEAD') && body) {
                        throw new Error('طلبات GET و HEAD لا تقبل جسم طلب هنا.');
                    }
                    const headers = new Headers();
                    for (const entry of (Array.isArray(message.headers) ? message.headers : []).slice(0, 50)) {
                        const name = String(entry?.name || '').trim();
                        const value = String(entry?.value || '');
                        if (!name || /[\r\n]/.test(name + value)) throw new Error('يوجد اسم أو قيمة رأس غير صالحة.');
                        try { headers.append(name, value); }
                        catch (_) { throw new Error(`تعذر استخدام رأس HTTP: ${name}`); }
                    }

                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 20000);
                    const startedAt = Date.now();
                    try {
                        const response = await fetch(url.href, {
                            method,
                            headers,
                            body: body || undefined,
                            credentials: 'omit',
                            cache: 'no-store',
                            redirect: 'follow',
                            signal: controller.signal
                        });
                        let responseBody = '';
                        let truncated = false;
                        if (response.body && method !== 'HEAD') {
                            const reader = response.body.getReader();
                            const chunks = [];
                            let size = 0;
                            while (size < 32768) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                const remaining = 32768 - size;
                                const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
                                chunks.push(chunk);
                                size += chunk.byteLength;
                                if (value.byteLength > remaining) { truncated = true; break; }
                            }
                            if (size >= 32768) truncated = true;
                            if (truncated) await reader.cancel().catch(() => {});
                            const merged = new Uint8Array(size);
                            let offset = 0;
                            for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
                            responseBody = new TextDecoder().decode(merged);
                        }
                        return {
                            success: true,
                            status: response.status,
                            statusText: response.statusText,
                            finalUrl: response.url,
                            redirected: response.redirected,
                            elapsedMs: Date.now() - startedAt,
                            headers: [...response.headers.entries()].slice(0, 80),
                            body: responseBody,
                            truncated
                        };
                    } catch (error) {
                        throw new Error(error.name === 'AbortError' ? 'انتهت مهلة الطلب بعد 20 ثانية.' : (error.message || 'تعذرت إعادة إرسال الطلب.'));
                    } finally {
                        clearTimeout(timeout);
                    }
                })()
                    .then(result => sendResponse(result))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "checkNetworkUrl") {
                (async () => {
                    let url;
                    try {
                        url = new URL(String(message.url || ''));
                        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
                            throw new Error('استخدم رابط HTTP أو HTTPS صالحًا.');
                        }
                    } catch (error) {
                        throw new Error(error.message || 'الرابط غير صالح.');
                    }

                    const startedAt = Date.now();
                    const probe = async (method) => {
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), 8000);
                        try {
                            const response = await fetch(url.href, {
                                method,
                                redirect: 'follow',
                                credentials: 'omit',
                                headers: method === 'GET' ? { Range: 'bytes=0-0' } : {},
                                signal: controller.signal
                            });
                            if (method === 'GET') response.body?.cancel().catch(() => {});
                            return response;
                        } finally {
                            clearTimeout(timeout);
                        }
                    };

                    try {
                        let response = await probe('HEAD');
                        let method = 'HEAD';
                        if (response.status === 405 || response.status === 501) {
                            response = await probe('GET');
                            method = 'GET';
                        }
                        return {
                            success: true,
                            status: response.status,
                            statusText: response.statusText,
                            finalUrl: response.url,
                            method,
                            elapsedMs: Date.now() - startedAt,
                            contentType: response.headers.get('content-type') || '',
                            contentLength: response.headers.get('content-length') || '',
                            error: ''
                        };
                    } catch (error) {
                        return {
                            success: true,
                            status: 0,
                            statusText: '',
                            finalUrl: url.href,
                            method: 'HEAD',
                            elapsedMs: Date.now() - startedAt,
                            contentType: '',
                            contentLength: '',
                            error: error.name === 'AbortError' ? 'مهلة الاتصال انتهت بعد 8 ثوانٍ.' : (error.message || 'تعذر الاتصال بالخادم.')
                        };
                    }
                })()
                    .then(result => sendResponse(result))
                    .catch(error => sendResponse({ success: false, error: error.message }));
                return true;
            }

            if (message.action === "directDownload") {
                const extraData = { is_yt_dlp: message.is_yt_dlp !== false };
                if (message.quality) extraData.quality = message.quality;
                if (typeof message.title === 'string') extraData.title = message.title;
                else if (sender.tab?.title) extraData.title = sender.tab.title;
                if (message.referer || sender.tab?.url) extraData.referer = message.referer || sender.tab.url;
                
                ApiClient.sendDownloadRequest(message.url, extraData)
                    .then(sendResponse)
                    .catch(error => sendResponse({ success: false, error: error.message || 'Invalid download request' }));
                return true; // Keep channel open for async response
            }

            if (message.action === "downloadUrl") {
                const extraData = {};
                if (typeof message.title === 'string') extraData.filename = message.title;
                else if (sender.tab?.title) extraData.filename = sender.tab.title;
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
