// ============================================
// Ledo Downloader Mobile — Capacitor Bridge
// ============================================
// Intercepts axios + WebSocket so the desktop's
// renderer.js (which expects a local Python API)
// works on Android. Routes downloads to either the
// native Downloader plugin (direct files) or the
// YtDlp plugin (media URLs).
//
// Depends on: url-detector.js (loaded before this file)
// ============================================

'use strict';

window.capacitorDownloads = new Map();

// ----- Persistence helpers -----
// The native plugins keep their own state across app restarts, but the
// JS-side mirror (`capacitorDownloads`) starts empty each launch. Persist
// the latest known state to localStorage so the UI can show a populated
// list on cold start before the next plugin event arrives.
const PERSIST_KEY = 'ledo_mobile_state_v1';
const STATE_VERSION = 1;

function saveLocalState() {
    try {
        const arr = Array.from(window.capacitorDownloads.values());
        localStorage.setItem(PERSIST_KEY, JSON.stringify({ v: STATE_VERSION, items: arr }));
    } catch (e) { /* localStorage may be full or unavailable; ignore */ }
}

function loadLocalState() {
    try {
        const raw = localStorage.getItem(PERSIST_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.v !== STATE_VERSION || !Array.isArray(parsed.items)) return;
        for (const item of parsed.items) {
            if (item && item.id) {
                // Trust persisted state only as a UI hint — plugin will overwrite with truth
                window.capacitorDownloads.set(item.id, item);
            }
        }
    } catch (e) { /* corrupted blob; ignore */ }
}

loadLocalState();

// ----- ID generation -----
// Use crypto.randomUUID when available so concurrent taps can't collide.
// Falls back to time + random for ancient WebViews.
function makeTaskId() {
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return 'mobile-' + crypto.randomUUID();
        }
    } catch (e) { /* fall through */ }
    return 'mobile-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

// ============================================
// Mock WebSocket (renderer uses it for live updates)
// ============================================
class MockWebSocket {
    constructor(url) {
        this.url = url;
        window.activeWs = this;
        // Simulate immediate open
        setTimeout(() => {
            if (this.onopen) {
                try { this.onopen(); } catch (e) { /* swallow */ }
            }
        }, 50);
    }
    close() {}
    send() {}
}

window.mockServerUpdate = function () {
    saveLocalState();
    if (window.activeWs && window.activeWs.onmessage) {
        const downloadsArray = Array.from(window.capacitorDownloads.values());
        try {
            window.activeWs.onmessage({
                data: JSON.stringify({ type: 'downloads', downloads: downloadsArray })
            });
        } catch (e) { /* swallow */ }
    }
};

window.WebSocket = MockWebSocket;

// ============================================
// Local Notifications
// ============================================

// -----------------------------------------------------------
// Mobile settings: rewrite the default save path to Android
// -----------------------------------------------------------
// The renderer's DEFAULT_SETTINGS has a Windows path baked in
// (Loading...). On Android that's nonsense — files are
// always saved by the native plugin under /storage/emulated/0/...
// We must patch localStorage BEFORE the renderer reads it,
// because the renderer calls `loadSettings()` at module init
// (i.e. as soon as the script tag is parsed).
// -----------------------------------------------------------
(function patchMobileSettings() {
    const ANDROID_SAVE_PATH = '/storage/emulated/0/Download/Ledo';
    try {
        const stored = localStorage.getItem('ledo_settings');
        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                if (parsed && parsed.defaultSavePath && /^[a-z]:\\/i.test(parsed.defaultSavePath)) {
                    parsed.defaultSavePath = ANDROID_SAVE_PATH;
                    localStorage.setItem('ledo_settings', JSON.stringify(parsed));
                }
            } catch (e) { /* malformed storage: leave alone */ }
        }
    } catch (e) { /* localStorage unavailable */ }
})();

async function triggerNotification(title, body) {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) {
        try {
            await window.Capacitor.Plugins.LocalNotifications.schedule({
                notifications: [
                    {
                        title: title,
                        body: body,
                        id: Math.floor(Math.random() * 100000),
                        schedule: { at: new Date(Date.now() + 500) }
                    }
                ]
            });
        } catch (e) {
            console.error('Notification failed', e);
        }
    }
}

if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) {
    try { window.Capacitor.Plugins.LocalNotifications.requestPermissions(); } catch (e) { /* swallow */ }
}

// ============================================
// Helpers
// ============================================
function getPlugin(name) {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) {
        return window.Capacitor.Plugins[name];
    }
    return null;
}

// Surface a non-blocking error toast to the user. Safe to call before
// the renderer is ready (it just logs). The renderer.js also defines
// showToast; we prefer the global one when available so errors raised
// during initial fetch are visible to the user.
function surfaceError(prefix, err) {
    const msg = (err && err.message) ? err.message : (typeof err === 'string' ? err : String(err));
    const text = (prefix ? prefix + ': ' : '') + msg;
    console.error('[mobile-bridge]', text);
    try {
        if (typeof window.showToast === 'function') {
            window.showToast(text, '#ef4444');
        }
    } catch (e) { /* renderer not ready yet */ }
}

function safeFilename(name, fallbackExt) {
    if (!name) return 'download_' + Date.now() + (fallbackExt ? ('.' + fallbackExt) : '.bin');
    // Strip path separators that could escape the download dir
    return String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || ('download_' + Date.now());
}

/**
 * Try to determine the file size for a direct URL by doing a
 * Range request from the WebView. Returns 0 on any failure.
 */
async function probeDirectFileSize(url) {
    if (!url) return 0;
    try {
        const resp = await fetch(url, {
            method: 'GET',
            headers: { 'Range': 'bytes=0-0' },
            redirect: 'follow'
        });
        if (resp.status === 206) {
            // Partial content: total size is in Content-Range
            const cr = resp.headers.get('content-range') || resp.headers.get('Content-Range') || '';
            const m = /\/(\d+)\s*$/.exec(cr);
            if (m) return parseInt(m[1], 10) || 0;
            return 0;
        }
        if (resp.ok) {
            // Server ignored Range: read Content-Length
            const cl = resp.headers.get('content-length') || resp.headers.get('Content-Length');
            if (cl) return parseInt(cl, 10) || 0;
        }
    } catch (e) {
        // CORS or network error — that's fine, size stays 0
    }
    return 0;
}

/**
 * Pick the best representative size from a yt-dlp VideoInfo result.
 * yt-dlp returns a `formats` array; we look for the largest progressive
 * or video-only entry to show as "best". For per-quality buckets we
 * pick the closest format matching the height.
 */
function pickYtdlpSizes(info) {
    const sizes = { best: 0, '720p': 0, '480p': 0, '360p': 0, audio: 0 };
    if (!info) return sizes;
    const formats = info.formats || [];

    // Pick the largest overall size for "best"
    let bestSize = 0;
    for (const f of formats) {
        const sz = Number(f.filesize || f.filesize_approx || 0) || 0;
        if (sz > bestSize) bestSize = sz;
    }
    sizes.best = bestSize;

    // Try to match by height (some formats include "1080p" in the format string
    // or have height info we don't see here — be conservative).
    const wantHeights = { '720p': 720, '480p': 480, '360p': 360 };
    for (const [key, h] of Object.entries(wantHeights)) {
        let best = 0;
        for (const f of formats) {
            // yt-dlp format strings look like "303 - 1920x1080 (1080p)"
            const fmtStr = String(f.format || '').toLowerCase();
            let fmtH = 0;
            const hMatch = fmtStr.match(/(\d{3,4})p/);
            if (hMatch) fmtH = parseInt(hMatch[1], 10);
            // Only count formats that have a size and match the height (or smaller)
            const sz = Number(f.filesize || f.filesize_approx || 0) || 0;
            if (sz > 0 && (fmtH === 0 || fmtH === h || fmtH < h)) {
                if (sz > best) best = sz;
            }
        }
        sizes[key] = best || bestSize; // fall back to bestSize so the option isn't 0
    }

    // Audio
    let audioSize = 0;
    for (const f of formats) {
        const acodec = String(f.acodec || '').toLowerCase();
        const vcodec = String(f.vcodec || 'none').toLowerCase();
        const sz = Number(f.filesize || f.filesize_approx || 0) || 0;
        if (sz > audioSize && acodec && acodec !== 'none' && (vcodec === 'none' || !vcodec)) {
            audioSize = sz;
        }
    }
    sizes.audio = audioSize || bestSize;

    return sizes;
}

// ============================================
// Capacitor Plugin Listeners
// ============================================
(function attachPluginListeners() {
    if (!window.Capacitor || !window.Capacitor.Plugins) return;

    const YtDlp = getPlugin('YtDlp');
    const Downloader = getPlugin('Downloader');

    function ensureRecord(taskId, defaults) {
        if (!window.capacitorDownloads.has(taskId)) {
            window.capacitorDownloads.set(taskId, Object.assign({
                id: taskId,
                filename: 'Download',
                url: '',
                status: 'starting',
                progress: 0,
                downloaded: 0,
                total_size: 0,
                speed: 0
            }, defaults || {}));
        }
        return window.capacitorDownloads.get(taskId);
    }

    if (YtDlp) {
        // safeListener wraps every callback so a thrown error in one
        // event doesn't kill the plugin's event channel.
        const safeListener = (name, fn) => {
            try {
                YtDlp.addListener(name, (data) => {
                    try { fn(data); } catch (e) { console.error('YtDlp', name, 'handler failed', e); }
                });
            } catch (e) { console.error('YtDlp addListener', name, 'failed', e); }
        };

        safeListener('downloadStatus', (data) => {
            if (!data || !data.taskId) return;
            const dl = ensureRecord(data.taskId, {});
            dl.status = (data.status || 'starting').toLowerCase();
            window.mockServerUpdate();
        });

        safeListener('downloadProgress', (data) => {
            if (!data || !data.taskId) return;
            const dl = ensureRecord(data.taskId, {});
            dl.progress = data.percent;
            dl.status = 'downloading';
            window.mockServerUpdate();
        });

        safeListener('downloadComplete', (data) => {
            if (!data || !data.taskId) return;
            const dl = ensureRecord(data.taskId, {});
            dl.status = 'completed';
            dl.progress = 100;
            window.mockServerUpdate();
            triggerNotification('Download Completed', dl.filename);
        });

        safeListener('downloadError', (data) => {
            if (!data || !data.taskId) return;
            const dl = ensureRecord(data.taskId, {});
            dl.status = 'error';
            dl.error_message = data.error;
            window.mockServerUpdate();
            triggerNotification('Download Failed', dl.filename || 'Media file');
        });
    }

    if (Downloader) {
        const safeListener = (name, fn) => {
            try {
                Downloader.addListener(name, (data) => {
                    try { fn(data); } catch (e) { console.error('Downloader', name, 'handler failed', e); }
                });
            } catch (e) { console.error('Downloader addListener', name, 'failed', e); }
        };

        safeListener('downloadProgress', (data) => {
            if (!data || !data.taskId) return;
            const dl = ensureRecord(data.taskId, {});
            dl.progress = data.percent;
            dl.downloaded = data.downloaded;
            dl.total_size = data.total;
            dl.speed = data.speedBps;
            dl.status = 'downloading';
            window.mockServerUpdate();
        });

        safeListener('downloadComplete', (data) => {
            if (!data || !data.taskId) return;
            const dl = ensureRecord(data.taskId, {});
            dl.status = 'completed';
            dl.progress = 100;
            if (data.path) dl.local_path = data.path; // remember absolute path for the in-app player
            if (data.filename) dl.filename = data.filename;
            window.mockServerUpdate();
            triggerNotification('Download Completed', dl.filename);
        });

        safeListener('downloadError', (data) => {
            if (!data || !data.taskId) return;
            const dl = ensureRecord(data.taskId, {});
            dl.status = 'error';
            dl.error_message = (data && data.error) || 'Download failed';
            window.mockServerUpdate();
            triggerNotification('Download Failed', dl.filename || 'File');
        });

        safeListener('downloadStatus', (data) => {
            if (!data || !data.taskId) return;
            const dl = ensureRecord(data.taskId, {});
            dl.status = (data.status || 'starting').toLowerCase();
            window.mockServerUpdate();
        });
    }
})();

// ============================================
// Axios override (replaces desktop's HTTP calls)
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    const originalAxios = window.axios;

    if (!originalAxios) {
        console.error('mobile-bridge: window.axios missing — bridge disabled');
        return;
    }

    window.axios = {
        get: async (url, config) => {
            if (typeof url === 'string' && url.endsWith('/stats')) {
                const arr = Array.from(window.capacitorDownloads.values());
                const stats = {
                    total_files: arr.length,
                    completed: arr.filter(d => d.status === 'completed').length,
                    errors: arr.filter(d => d.status === 'error').length,
                    total_downloaded_bytes: arr.reduce((s, d) => s + (Number(d.downloaded) || 0), 0),
                    videos: arr.filter(d => /\.(mp4|mkv|webm|mov|avi|flv|wmv|m4v)$/i.test(d.filename || '')).length,
                    audios: arr.filter(d => /\.(mp3|m4a|wav|flac|ogg|opus|aac|aiff)$/i.test(d.filename || '')).length
                };
                return { data: stats };
            }
            // /api/stream/{id} — used by the in-app video player.
            // We need to return a URL the WebView can actually <video src=...>.
            // Strategy:
            //   1) If the record has a `local_path`, hand it through Capacitor's
            //      convertFileSrc so the WebView serves it as a file:// URL.
            //   2) Otherwise return an empty string — the player shows an error
            //      toast and we never crash.
            if (typeof url === 'string' && url.includes('/stream/')) {
                const id = url.split('/stream/').pop().split('?')[0].split('#')[0];
                const dl = window.capacitorDownloads.get(id);
                let src = '';
                if (dl && dl.local_path) {
                    try {
                        if (window.Capacitor && typeof window.Capacitor.convertFileSrc === 'function') {
                            src = window.Capacitor.convertFileSrc(dl.local_path);
                        } else {
                            src = 'file://' + dl.local_path;
                        }
                    } catch (e) {
                        console.error('convertFileSrc failed', e);
                    }
                }
                return { data: { url: src } };
            }
            return originalAxios.get(url, config);
        },

        post: async (url, data, config) => {
            // ---------- /api/info ----------
            if (typeof url === 'string' && url.endsWith('/info')) {
                const targetUrl = (data && data.url) || '';
                const classification = (window.UrlDetector && window.UrlDetector.classify)
                    ? window.UrlDetector.classify(targetUrl)
                    : { type: 'unknown', filename: '', ext: '' };

                if (classification.type === 'direct') {
                    // Direct file — let Downloader handle it. Probe size from WebView.
                    const size = await probeDirectFileSize(targetUrl);
                    return {
                        data: {
                            status: 'success',
                            title: classification.filename || (window.UrlDetector ? window.UrlDetector.guessTitle(targetUrl) : 'download'),
                            is_direct: true,
                            thumbnail: '',
                            sizes: { best: size, medium: size, low: size }
                        }
                    };
                }

                if (classification.type === 'media') {
                    const YtDlp = getPlugin('YtDlp');
                    if (YtDlp) {
                        try {
                            const info = await YtDlp.fetchInfo({ url: targetUrl });
                            const sizes = pickYtdlpSizes(info);
                            return {
                                data: {
                                    status: 'success',
                                    title: info.title || targetUrl,
                                    is_direct: false,
                                    thumbnail: info.thumbnail || '',
                                    sizes: sizes
                                }
                            };
                        } catch (e) {
                            // Surface the real reason to the user — the silent
                            // fallback was hiding "instance not initialized" and
                            // leaving every quality at "Size Unknown".
                            surfaceError('Cannot fetch video info', e);
                            return {
                                data: {
                                    status: 'error',
                                    error: (e && e.message) ? e.message : String(e),
                                    title: targetUrl,
                                    is_direct: false,
                                    thumbnail: '',
                                    sizes: { best: 0, '720p': 0, '480p': 0, '360p': 0, audio: 0 }
                                }
                            };
                        }
                    }
                    // No YtDlp plugin: can't extract media info, but we still
                    // don't want to error — let the user try direct download.
                    return {
                        data: {
                            status: 'success',
                            title: targetUrl,
                            is_direct: true,
                            thumbnail: '',
                            sizes: { best: 0, medium: 0, low: 0 }
                        }
                    };
                }

                // Unknown type — try as direct file. The Downloader will
                // succeed if it's a real file, or fail with a clear error.
                const size = await probeDirectFileSize(targetUrl);
                return {
                    data: {
                        status: 'success',
                        title: (window.UrlDetector ? window.UrlDetector.guessTitle(targetUrl) : 'download'),
                        is_direct: true,
                        thumbnail: '',
                        sizes: { best: size, medium: size, low: size }
                    }
                };
            }

            // ---------- /api/download ----------
            if (typeof url === 'string' && url.endsWith('/download')) {
                const payload = data || {};
                const targetUrl = payload.url || '';
                const isDirectFile = !!window.isDirectFile;
                const quality = payload.quality || 'best';

                const classification = (window.UrlDetector && window.UrlDetector.classify)
                    ? window.UrlDetector.classify(targetUrl)
                    : { type: 'unknown', filename: '', ext: '' };

                const filename = safeFilename(
                    classification.filename || (window.UrlDetector ? window.UrlDetector.guessTitle(targetUrl) : 'download'),
                    classification.ext
                );

                const taskIdPlaceholder = makeTaskId();
                const dl = ensureRecord(taskIdPlaceholder, {
                    id: taskIdPlaceholder,
                    filename: filename,
                    url: targetUrl,
                    status: 'starting',
                    progress: 0,
                    downloaded: 0,
                    total_size: 0,
                    speed: 0
                });
                window.mockServerUpdate();

                let taskId = taskIdPlaceholder;
                try {
                    if (isDirectFile || classification.type === 'direct' || classification.type === 'unknown') {
                        const Downloader = getPlugin('Downloader');
                        if (Downloader) {
                            const res = await Downloader.addDownload({
                                url: targetUrl,
                                filename: filename,
                                threads: 8
                            });
                            if (res && res.taskId) {
                                taskId = res.taskId;
                                const real = ensureRecord(taskId, {
                                    id: taskId,
                                    filename: filename,
                                    url: targetUrl
                                });
                                // Migrate the placeholder's progress to the real record
                                real.progress = dl.progress;
                                real.downloaded = dl.downloaded;
                                real.total_size = dl.total_size;
                                real.speed = dl.speed;
                                real.status = dl.status;
                                window.capacitorDownloads.delete(taskIdPlaceholder);
                            }
                        } else {
                            dl.status = 'error';
                            dl.error_message = 'Downloader plugin unavailable';
                            window.mockServerUpdate();
                        }
                    } else {
                        // media → YtDlp
                        const YtDlp = getPlugin('YtDlp');
                        if (YtDlp) {
                            const formatId = (window.UrlDetector && window.UrlDetector.qualityToYtdlpFormat)
                                ? window.UrlDetector.qualityToYtdlpFormat(quality)
                                : (quality === 'best' ? '' : quality);
                            const res = await YtDlp.startDownload({ url: targetUrl, formatId: formatId });
                            if (res && res.taskId) {
                                taskId = res.taskId;
                                const real = ensureRecord(taskId, {
                                    id: taskId,
                                    filename: filename,
                                    url: targetUrl
                                });
                                real.progress = dl.progress;
                                real.downloaded = dl.downloaded;
                                real.total_size = dl.total_size;
                                real.speed = dl.speed;
                                real.status = dl.status;
                                window.capacitorDownloads.delete(taskIdPlaceholder);
                            }
                        } else {
                            dl.status = 'error';
                            dl.error_message = 'YtDlp plugin unavailable';
                            window.mockServerUpdate();
                        }
                    }
                } catch (e) {
                    dl.status = 'error';
                    const msg = (e && e.message) ? e.message : String(e);
                    dl.error_message = msg;
                    // Surface to a toast so the user understands the card failure
                    // isn't a network blip — it's the real plugin error.
                    surfaceError('Download failed to start', e);
                    window.mockServerUpdate();
                }

                return { data: { status: 'success', task_id: taskId } };
            }

            // ---------- /api/schedule, /api/cleanup-temps ----------
            if (typeof url === 'string' && (url.endsWith('/schedule') || url.endsWith('/cleanup-temps'))) {
                return { data: { status: 'success' } };
            }

            return originalAxios.post(url, data, config);
        },

        delete: async (url, config) => {
            if (typeof url === 'string') {
                if (url.includes('/cancel/')) {
                    const id = url.split('/').pop();
                    const dl = window.capacitorDownloads.get(id);
                    if (dl) {
                        dl.status = 'error';
                        dl.error_message = 'Canceled';
                        window.mockServerUpdate();
                    }
                    // Also notify the native plugin
                    try {
                        const Downloader = getPlugin('Downloader');
                        if (Downloader && Downloader.cancelDownload) {
                            await Downloader.cancelDownload({ taskId: id });
                        }
                    } catch (e) { /* swallow */ }
                    return { data: { status: 'success' } };
                }
                if (url.endsWith('/clear-history')) {
                    window.capacitorDownloads.clear();
                    window.mockServerUpdate();
                    return { data: { status: 'success' } };
                }
            }
            return originalAxios.delete(url, config);
        }
    };

    // Stub electronAPI so the renderer doesn't blow up on desktop-only hooks
    window.electronAPI = {
        selectFolder: async () => null,
        openFolder: async () => {},
        showQuickAdd: () => {}
    };
});

// Helper used inside the post override above
function ensureRecord(taskId, defaults) {
    if (!window.capacitorDownloads.has(taskId)) {
        window.capacitorDownloads.set(taskId, Object.assign({
            id: taskId,
            filename: 'Download',
            url: '',
            status: 'starting',
            progress: 0,
            downloaded: 0,
            total_size: 0,
            speed: 0
        }, defaults || {}));
    }
    return window.capacitorDownloads.get(taskId);
}
