/**
 * Ledo Downloader Extension - Core Infrastructure
 * Architecture: Modular OOP approach for robustness and maintainability.
 */

// ==========================================
// 1. Advanced Cookie Manager
// ==========================================
class CookieManager {
    /**
     * Extracts the root domain from a given URL to fetch ALL related cookies.
     * e.g., 'https://m.facebook.com' -> '.facebook.com'
     */
    static getRootDomain(urlString) {
        try {
            const url = new URL(urlString);
            const hostname = url.hostname;
            const parts = hostname.split('.');
            if (parts.length > 2) {
                // Return something like '.facebook.com' or '.youtube.com'
                return '.' + parts.slice(-2).join('.');
            }
            return '.' + hostname;
        } catch (e) {
            console.error('[CookieManager] Invalid URL provided for domain extraction:', urlString);
            return null;
        }
    }

    /**
     * Fetches all cookies matching the root domain of the URL.
     * This bypasses HttpOnly limits if the extension has host permissions.
     */
    static async getCookies(urlString) {
        try {
            const rootDomain = this.getRootDomain(urlString);
            if (!rootDomain) {
                // Fallback to strict URL matching
                const cookies = await chrome.cookies.getAll({ url: urlString });
                return cookies.map(c => `${c.name}=${c.value}`).join('; ');
            }

            // Fetch ALL cookies for the root domain (includes subdomains)
            const cookies = await chrome.cookies.getAll({ domain: rootDomain });
            
            // Format for yt-dlp / curl (Key=Value format separated by semicolons)
            return cookies.map(c => `${c.name}=${c.value}`).join('; ');
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
                throw new Error(data.message || `HTTP ${response.status}`);
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
        const cookies = await CookieManager.getCookies(url);
        const payload = {
            url,
            cookies,
            user_agent: navigator.userAgent,
            ...extraData
        };
        return this.post('/download', payload);
    }

    static async sendQuickAddRequest(url, extraData = {}) {
        const cookies = await CookieManager.getCookies(url);
        const payload = {
            url,
            cookies,
            user_agent: navigator.userAgent,
            ...extraData
        };
        return this.post('/quick-add', payload);
    }
}

// ==========================================
// 3. Extension Controller
// ==========================================
class ExtensionController {
    static init() {
        this.setupContextMenus();
        this.listenToMessages();
        this.interceptDownloads();
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

                // Pause or cancel the download and send to Ledo
                chrome.downloads.cancel(downloadItem.id, () => {
                    ApiClient.sendQuickAddRequest(url, extraData).then(res => {
                        if (!res.success) {
                            console.warn('Download intercepted but Ledo is offline.');
                        }
                    });
                });
            });
        });
    }

    static setupContextMenus() {
        chrome.runtime.onInstalled.addListener(() => {
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

        chrome.contextMenus.onClicked.addListener((info) => {
            if (info.menuItemId.startsWith("download_with_ledo")) {
                const urlToDownload = info.linkUrl || info.srcUrl;
                if (urlToDownload) {
                    ApiClient.sendDownloadRequest(urlToDownload, { is_yt_dlp: true, referer: info.pageUrl });
                }
            }
        });
    }

    static listenToMessages() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (!message || !message.action) {
                sendResponse({ success: false, error: "Invalid message payload" });
                return false;
            }

            if (message.action === "directDownload") {
                const extraData = { is_yt_dlp: true };
                if (message.quality) extraData.quality = message.quality;
                
                ApiClient.sendDownloadRequest(message.url, extraData).then(sendResponse);
                return true; // Keep channel open for async response
            }

            if (message.action === "downloadUrl") {
                ApiClient.sendQuickAddRequest(message.url).then(sendResponse);
                return true; // Keep channel open for async response
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
