const API_URL = 'http://127.0.0.1:8000/api';
const appApi = window.electronAPI;
const os = { homedir: appApi.osHomedir };
const path = {
    basename: appApi.pathBasename,
    dirname: appApi.pathDirname,
    extname: appApi.pathExtname,
    join: appApi.pathJoin
};
const fs = { existsSync: appApi.fsExistsSync, mkdirSync: appApi.fsMkdirSync };

// DOM Elements
const windowContainer = document.getElementById('window-container');
const filenameInput = document.getElementById('filename-input');
const urlInput = document.getElementById('url-input');
const domainBadge = document.getElementById('domain-badge');
const domainText = document.getElementById('domain-text');
const fileSizeDisplay = document.getElementById('file-size-display');
const categoryChipText = document.getElementById('category-chip-text');

const categorySelect = document.getElementById('category-select');
const qualityRow = document.getElementById('quality-row');
const qualitySelect = document.getElementById('quality-select');
const savePathInput = document.getElementById('save-path-input');
const rememberPath = document.getElementById('remember-path');
const lblCategory = document.getElementById('lbl-category');
const threadsSelect = document.getElementById('threads-select');

const sniffingLoader = document.getElementById('sniffing-loader');
const errorBanner = document.getElementById('error-banner');
const errorText = document.getElementById('error-text');
const btnRetry = document.getElementById('btn-retry');

const btnClose = document.getElementById('btn-close');
const btnCancel = document.getElementById('btn-cancel');
const btnStartDownload = document.getElementById('btn-start-download');
const btnStartText = document.getElementById('btn-start-text');
const btnDownloadLater = document.getElementById('btn-download-later');
const btnBrowse = document.getElementById('btn-browse');
const btnCopyUrl = document.getElementById('btn-copy-url');
const btnPasteUrl = document.getElementById('btn-paste-url');
const btnAnalyzeUrl = document.getElementById('btn-analyze-url');
const btnSkipSniff = document.getElementById('btn-skip-sniff');

let currentMetadata = {
    url: '',
    filename: '',
    file_size: null,
    sizes: null,
    mime_type: '',
    native_browser_download: false,
    native_download_paused: true,
    native_download_id: null,
    cookies: null,
    user_agent: null,
    type: 'unknown'
};
let sniffTimer = null;
let sniffRequestId = 0;
let sniffAbortController = null;
let userSelectedSavePath = false;

const CATEGORIES = {
    'Programs': ['.exe', '.msi', '.msix', '.appx', '.apk', '.aab', '.xapk', '.dmg', '.pkg', '.deb', '.rpm', '.appimage', '.snap', '.flatpak', '.jar', '.run', '.bin', '.iso'],
    'Compressed': ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.zst', '.tgz', '.tbz2', '.txz', '.cab', '.img', '.vhd', '.vmdk', '.wim'],
    'Video': ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.flv', '.wmv', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts', '.vob', '.ogv', '.mpg', '.mpeg'],
    'Audio': ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma', '.opus', '.aiff', '.aif', '.mid', '.midi', '.ape', '.alac'],
    'Documents': ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.tsv', '.epub', '.mobi', '.rtf', '.odt', '.ods', '.odp']
};

const KNOWN_EXTENSIONS = new Set([
    // Programs & Installers
    '.exe', '.msi', '.msix', '.appx', '.appimage', '.dmg', '.pkg', '.deb',
    '.rpm', '.apk', '.aab', '.xapk', '.snap', '.flatpak', '.run', '.bin',
    '.jar', '.war', '.ear',
    // Archives & Compressed
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.zst', '.lz',
    '.lzma', '.tgz', '.tbz2', '.txz', '.cab', '.iso', '.img', '.vhd',
    '.vmdk', '.ova', '.qcow2', '.wim', '.z', '.lz4', '.br', '.zstd',
    // Documents
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
    '.ods', '.odp', '.rtf', '.txt', '.csv', '.tsv', '.epub', '.mobi',
    '.azw3', '.djvu', '.xps', '.pages', '.numbers', '.key',
    // Video
    '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
    '.3gp', '.3g2', '.ts', '.mts', '.m2ts', '.vob', '.ogv', '.mpg',
    '.mpeg', '.divx', '.asf', '.rm', '.rmvb', '.f4v',
    // Audio
    '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.opus',
    '.aiff', '.aif', '.mid', '.midi', '.ape', '.alac', '.dsf', '.dff',
    '.tak', '.tta', '.mka', '.ac3', '.dts', '.pcm',
    // Images
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico',
    '.tiff', '.tif', '.psd', '.ai', '.eps', '.raw', '.cr2', '.nef',
    '.arw', '.dng', '.heic', '.heif', '.avif', '.jxl',
    // Fonts
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    // Data & Config
    '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
    '.sql', '.db', '.sqlite', '.sqlite3', '.bak', '.dat', '.log',
    // Misc
    '.torrent', '.nfo', '.srt', '.sub', '.ass', '.vtt', '.ics',
    '.vcf', '.gpx', '.kml', '.kmz'
]);

const SERVER_SCRIPT_EXTENSIONS = new Set([
    '.php', '.asp', '.aspx', '.jsp', '.jspx', '.do', '.action', '.cgi',
    '.pl', '.cfm', '.html', '.htm', '.shtml', '.xhtml'
]);

function looksLikeFilename(val) {
    if (!val || typeof val !== 'string' || val.length < 3) return false;
    const clean = val.split('?')[0].split('#')[0];
    const base = path.basename(clean);
    if (!base || base.length < 3) return false;
    const ext = path.extname(base).toLowerCase();
    return KNOWN_EXTENSIONS.has(ext) && !SERVER_SCRIPT_EXTENSIONS.has(ext);
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes || bytes <= 0) return 'Unknown Size';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function extractDomain(urlString) {
    try {
        const parsed = new URL(urlString);
        return parsed.hostname.replace(/^www\./, '');
    } catch (e) {
        return '';
    }
}

function determineCategory(filename, url = '') {
    const ext = path.extname(filename || url).toLowerCase();
    for (const [cat, extensions] of Object.entries(CATEGORIES)) {
        if (extensions.includes(ext)) return cat;
    }
    // Check if it's a known video domain
    if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('tiktok.com') || url.includes('instagram.com') || url.includes('facebook.com') || url.includes('fb.watch')) {
        return 'Video';
    }
    return 'General';
}

function getCategorySaveDir(category) {
    // Check remembered custom path from localStorage
    const savedCustomPaths = JSON.parse(localStorage.getItem('ledo_category_paths') || '{}');
    if (savedCustomPaths[category] && fs.existsSync(savedCustomPaths[category])) {
        return savedCustomPaths[category];
    }

    // Read user settings for base download path and autoCategorize
    let settings = {};
    try { settings = JSON.parse(localStorage.getItem('ledo_settings') || '{}'); } catch(e) {}
    
    const baseDir = settings.defaultSavePath || path.join(os.homedir(), 'Downloads', 'Ledo Downloader');
    const autoCategorize = settings.autoCategorize !== false; // default true

    // If auto-categorize is disabled, always return base dir
    if (!autoCategorize) {
        if (!fs.existsSync(baseDir)) {
            try { fs.mkdirSync(baseDir, { recursive: true }); } catch(e){}
        }
        return baseDir;
    }

    // Category folder names aligned with backend (downloader.py CATEGORIES)
    const categoryFolders = {
        'Programs': 'Programs',
        'Compressed': 'Archives',
        'Video': 'Videos',
        'Audio': 'Audio',
        'Documents': 'Documents',
        'General': ''
    };
    const folder = categoryFolders[category] || '';
    const targetPath = folder ? path.join(baseDir, folder) : baseDir;
    
    if (!fs.existsSync(targetPath)) {
        try { fs.mkdirSync(targetPath, { recursive: true }); } catch(e){}
    }
    return targetPath;
}

function saveCategoryPath(category, dirPath) {
    try {
        const savedCustomPaths = JSON.parse(localStorage.getItem('ledo_category_paths') || '{}');
        savedCustomPaths[category] = dirPath;
        localStorage.setItem('ledo_category_paths', JSON.stringify(savedCustomPaths));
    } catch(e) {}
}

function sanitizeFilename(name) {
    if (!name) return 'downloaded_file';
    return name.replace(/[<>:"/\\|?*]/g, '_').trim();
}

function normaliseUrl(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const parsed = new URL(candidate);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
    } catch (e) {
        return '';
    }
}

const STREAMING_DOMAINS = new Set([
    'youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com', 'facebook.com',
    'fb.watch', 'twitter.com', 'x.com', 'twitch.tv', 'vimeo.com',
    'dailymotion.com', 'soundcloud.com', 'reddit.com'
]);

function filenameFromUrl(url) {
    try {
        const parsed = new URL(url);
        const hostname = (parsed.hostname || '').toLowerCase();
        const isStreaming = Array.from(STREAMING_DOMAINS).some(d => hostname.includes(d));
        if (isStreaming) {
            // Streaming media URLs must wait for yt-dlp sniffer for proper video title
            return '';
        }

        const candidates = [];

        // 1. Scan ALL query parameters for filenames (Broadcom, S3, Azure, Google Cloud, CDN, etc.)
        for (const [key, rawVal] of parsed.searchParams.entries()) {
            if (!rawVal || rawVal.length < 3) continue;
            const keyLower = key.toLowerCase();

            // Check for embedded Content-Disposition (e.g. S3 response-content-disposition)
            const utfMatch = rawVal.match(/filename\*=UTF-8''(.+?)(?:;|$|&)/i);
            if (utfMatch) {
                const decoded = decodeURIComponent(utfMatch[1]).replace(/["']/g, '').trim();
                if (looksLikeFilename(decoded)) {
                    candidates.push({ score: 200, name: decoded });
                    continue;
                }
            }
            const regMatch = rawVal.match(/filename="?([^";&]+)"?/i);
            if (regMatch) {
                const decoded = decodeURIComponent(regMatch[1]).replace(/["']/g, '').trim();
                if (looksLikeFilename(decoded)) {
                    candidates.push({ score: 200, name: decoded });
                    continue;
                }
            }

            // Decode value and strip secondary query string
            let decoded = '';
            try { decoded = decodeURIComponent(rawVal); } catch(e) { decoded = rawVal; }
            const cleanVal = decoded.split('?')[0].split('#')[0];
            const base = path.basename(cleanVal);

            if (base && base.length >= 3 && looksLikeFilename(base)) {
                let score = 10;
                if (['file', 'filename', 'name', 'dl', 'download', 'package', 'asset', 'path'].some(k => keyLower.includes(k))) {
                    score += 50;
                }
                const ext = path.extname(base).toLowerCase();
                if (CATEGORIES['Programs'].includes(ext) || CATEGORIES['Compressed'].includes(ext)) {
                    score += 30;
                }
                score += Math.min(base.length, 30);
                candidates.push({ score, name: base });
            }
        }

        // 2. Inspect path basename
        let pathnameBase = '';
        try {
            const decPath = decodeURIComponent(parsed.pathname);
            pathnameBase = path.basename(decPath);
        } catch(e) {
            pathnameBase = path.basename(parsed.pathname);
        }

        const pathExt = path.extname(pathnameBase).toLowerCase();
        if (pathnameBase && pathnameBase.length >= 3 && !SERVER_SCRIPT_EXTENSIONS.has(pathExt)) {
            if (KNOWN_EXTENSIONS.has(pathExt)) {
                // Real file in URL path
                candidates.push({ score: 60 + Math.min(pathnameBase.length, 20), name: pathnameBase });
            }
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => b.score - a.score);
            return sanitizeFilename(candidates[0].name);
        }

        // Fallback: If path has any name and is not a script or generic keyword
        const genericWords = new Set(['download', 'file', 'get', 'index', 'view', 'watch', 'api', 'v1', 'v2', 'stream', 'play']);
        if (pathnameBase && pathnameBase !== '/' && pathnameBase.length > 1 && !SERVER_SCRIPT_EXTENSIONS.has(pathExt) && !genericWords.has(pathnameBase.toLowerCase())) {
            return sanitizeFilename(pathnameBase);
        }

        return '';
    } catch (e) {
        return '';
    }
}

function setAnalyzing(isAnalyzing) {
    sniffingLoader.style.display = isAnalyzing ? 'flex' : 'none';
    if (btnAnalyzeUrl) btnAnalyzeUrl.disabled = isAnalyzing;
    if (btnPasteUrl) btnPasteUrl.disabled = isAnalyzing;
}

function skipInfoFetch() {
    ++sniffRequestId;
    clearTimeout(sniffTimer);
    if (sniffAbortController) {
        sniffAbortController.abort();
        sniffAbortController = null;
    }
    setAnalyzing(false);
}

async function analyzeUrl(value = urlInput.value) {
    const url = normaliseUrl(value);
    if (!url) {
        errorText.innerText = 'Paste a valid http or https link first.';
        errorBanner.style.display = 'flex';
        return false;
    }

    if (sniffAbortController) sniffAbortController.abort();
    const requestId = ++sniffRequestId;
    sniffAbortController = new AbortController();
    const abortController = sniffAbortController;
    errorBanner.style.display = 'none';
    userSelectedSavePath = false;
    currentMetadata = {
        url,
        filename: filenameFromUrl(url),
        file_size: null,
        sizes: null,
        mime_type: '',
        cookies: null,
        user_agent: null,
        type: 'unknown'
    };
    updateUI();
    setAnalyzing(true);

    try {
        const res = await axios.post(`${API_URL}/sniff`, { 
            url,
            cookies: currentMetadata.cookies || null,
            user_agent: currentMetadata.user_agent || null,
            referer: currentMetadata.referer || null
        }, { timeout: 15000, signal: abortController.signal });
        if (requestId !== sniffRequestId) return false;
        const info = res.data || {};
        if (info.title && info.title !== 'Unknown File') currentMetadata.filename = info.title;
        currentMetadata.file_size = info.size || null;
        currentMetadata.sizes = info.sizes || null;
        currentMetadata.mime_type = info.mime_type || '';
        currentMetadata.type = info.type || 'file';
        updateUI();
        return true;
    } catch (e) {
        if (requestId === sniffRequestId) {
            // A direct link can still be downloaded even when its server does
            // not expose metadata, so keep the form usable and explain why.
            errorText.innerText = 'Could not read details. You can still start this direct download.';
            errorBanner.style.display = 'flex';
        }
        return false;
    } finally {
        if (requestId === sniffRequestId) {
            sniffAbortController = null;
            setAnalyzing(false);
        }
    }
}

function scheduleUrlAnalysis() {
    clearTimeout(sniffTimer);
    const rawUrl = urlInput.value.trim();
    if (!rawUrl) return;
    sniffTimer = setTimeout(() => analyzeUrl(rawUrl), 650);
}

function resetFormState() {
    // Reset buttons
    btnStartDownload.disabled = false;
    btnStartDownload.innerHTML = `
        <svg class="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
        <span id="btn-start-text">Start Download</span>
    `;
    btnDownloadLater.disabled = false;
    btnDownloadLater.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
        <span>Download Later</span>
    `;
    btnRetry.style.display = '';
    errorBanner.classList.remove('native-download-notice');
    filenameInput.disabled = false;
    categorySelect.disabled = false;
    savePathInput.closest('.form-group').style.display = '';
    rememberPath.closest('.checkbox-container').style.display = '';
    threadsSelect.closest('.threads-selector').style.display = '';

    // Hide banners and loaders
    errorBanner.style.display = 'none';
    sniffingLoader.style.display = 'none';
}

function updateUI() {
    urlInput.value = currentMetadata.url || '';
    
    const domain = extractDomain(currentMetadata.url);
    if (domain) {
        domainText.innerText = domain;
        domainBadge.style.display = 'inline-flex';
    } else {
        domainBadge.style.display = 'none';
    }

    const filename = sanitizeFilename(currentMetadata.filename || filenameFromUrl(currentMetadata.url) || 'downloaded_file');
    filenameInput.value = filename;

    // Determine category
    const cat = determineCategory(filename, currentMetadata.url);
    categorySelect.value = cat;
    lblCategory.innerText = cat;
    categoryChipText.innerText = cat;

    // Update container theme class
    windowContainer.className = `window-container cat-${cat.toLowerCase()}`;

    // Update size
    let sizeToShow = currentMetadata.file_size;
    if (currentMetadata.sizes && (cat === 'Video' || cat === 'Audio')) {
        sizeToShow = currentMetadata.sizes[qualitySelect.value] || currentMetadata.file_size;
    }
    fileSizeDisplay.innerText = formatBytes(sizeToShow);

    // Update Save Path
    if (!userSelectedSavePath) {
        const targetDir = getCategorySaveDir(cat);
        savePathInput.value = path.join(targetDir, filename);
    }

    // Media quality row visibility
    const isMedia = (cat === 'Video' || cat === 'Audio' || currentMetadata.type === 'media');
    qualityRow.style.display = isMedia ? 'flex' : 'none';
    if (cat === 'Audio') {
        qualitySelect.value = 'audio';
    } else if (cat === 'Video' && qualitySelect.value === 'audio') {
        qualitySelect.value = 'best';
    }
}

// Category Change Listener
categorySelect.addEventListener('change', (e) => {
    const cat = e.target.value;
    lblCategory.innerText = cat;
    categoryChipText.innerText = cat;
    windowContainer.className = `window-container cat-${cat.toLowerCase()}`;
    const filename = filenameInput.value || 'downloaded_file';
    if (!userSelectedSavePath) {
        const targetDir = getCategorySaveDir(cat);
        savePathInput.value = path.join(targetDir, filename);
    }

    const isMedia = (cat === 'Video' || cat === 'Audio');
    qualityRow.style.display = isMedia ? 'flex' : 'none';
    if (cat === 'Audio') {
        qualitySelect.value = 'audio';
    } else if (cat === 'Video' && qualitySelect.value === 'audio') {
        qualitySelect.value = 'best';
    }

    if (currentMetadata.sizes && isMedia) {
        const sz = currentMetadata.sizes[qualitySelect.value] || currentMetadata.file_size;
        fileSizeDisplay.innerText = formatBytes(sz);
    } else {
        fileSizeDisplay.innerText = formatBytes(currentMetadata.file_size);
    }
});

// Quality Change Listener
qualitySelect.addEventListener('change', (e) => {
    if (currentMetadata.sizes) {
        const sz = currentMetadata.sizes[e.target.value] || currentMetadata.file_size;
        fileSizeDisplay.innerText = formatBytes(sz);
    }
});

// Filename edit sync with save path
filenameInput.addEventListener('input', () => {
    const fn = sanitizeFilename(filenameInput.value);
    const currentDir = path.dirname(savePathInput.value) || getCategorySaveDir(categorySelect.value);
    savePathInput.value = path.join(currentDir, fn);
});

savePathInput.addEventListener('input', () => {
    userSelectedSavePath = true;
});

// Browse folder
btnBrowse.addEventListener('click', async () => {
    const res = await appApi.selectFolder();
    if (res && typeof res === 'string' && res.length > 0) {
        const selectedDir = res;
        const fn = sanitizeFilename(filenameInput.value);
        savePathInput.value = path.join(selectedDir, fn);
        userSelectedSavePath = true;
        if (rememberPath.checked) {
            saveCategoryPath(categorySelect.value, selectedDir);
        }
    }
});

urlInput.addEventListener('input', scheduleUrlAnalysis);
urlInput.addEventListener('paste', () => setTimeout(scheduleUrlAnalysis, 0));
urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(sniffTimer);
        analyzeUrl();
    }
});

btnPasteUrl.addEventListener('click', async () => {
    const text = (await appApi.readClipboardText()).trim();
    if (!text) return;
    urlInput.value = text;
    analyzeUrl(text);
});

btnAnalyzeUrl.addEventListener('click', () => {
    clearTimeout(sniffTimer);
    analyzeUrl();
});

// Copy URL Button
btnCopyUrl.addEventListener('click', async () => {
    if (currentMetadata.url) {
        await appApi.writeClipboardText(currentMetadata.url);
        btnCopyUrl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        setTimeout(() => {
            btnCopyUrl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
        }, 1500);
    }
});

function closeWindow() {
    appApi.hideQuickAdd();
}

btnClose.addEventListener('click', closeWindow);
btnCancel.addEventListener('click', () => {
    if (currentMetadata.native_browser_download) {
        handleNativeTelegramChoice('cancel');
        return;
    }
    closeWindow();
});

async function handleNativeTelegramChoice(choice) {
    const downloadId = currentMetadata.native_download_id;
    if (!Number.isInteger(downloadId)) {
        errorBanner.classList.add('native-download-notice');
        errorText.innerText = 'Quick Add could not control this Telegram transfer. Cancel it in Chrome and try again.';
        errorBanner.style.display = 'flex';
        return;
    }

    btnStartDownload.disabled = true;
    btnDownloadLater.disabled = true;
    btnCancel.disabled = true;
    btnClose.disabled = true;
    errorBanner.style.display = 'none';
    const statusText = choice === 'resume' ? 'Starting in browser…' : 'Canceling…';
    btnStartDownload.innerHTML = `<span class="sniff-spinner"></span><span>${statusText}</span>`;

    try {
        await axios.post(`${API_URL}/quick-add/native-download-choice`, {
            download_id: downloadId,
            choice
        }, { timeout: 8000 });

        if (choice === 'resume') {
            btnStartDownload.innerHTML = '<span>Started in browser</span>';
            errorBanner.classList.add('native-download-notice');
            errorText.innerText = 'Telegram is transferring the file through its signed-in browser session. Check Chrome Downloads for progress.';
            errorBanner.style.display = 'flex';
            setTimeout(closeWindow, 1500);
        } else {
            closeWindow();
        }
    } catch (err) {
        btnStartDownload.disabled = false;
        btnDownloadLater.disabled = false;
        btnCancel.disabled = false;
        btnClose.disabled = false;
        btnStartDownload.innerHTML = '<span id="btn-start-text">Start in Browser</span>';
        errorBanner.classList.add('native-download-notice');
        errorText.innerText = err.response?.data?.detail || 'Could not reach the browser extension. The Telegram transfer is still paused.';
        errorBanner.style.display = 'flex';
    }
}

// Start Download Logic
async function handleStartDownload(isLater = false) {
    if (!currentMetadata.url) return;

    if (currentMetadata.native_browser_download) {
        if (isLater) {
            closeWindow(); // Leave the native browser transfer paused.
            return;
        }
        await handleNativeTelegramChoice('resume');
        return;
    }

    if (rememberPath.checked) {
        saveCategoryPath(categorySelect.value, path.dirname(savePathInput.value));
    }

    btnStartDownload.disabled = true;
    btnDownloadLater.disabled = true;
    errorBanner.style.display = 'none';

    if (isLater) {
        btnDownloadLater.innerHTML = `<span class="sniff-spinner"></span> <span>Queueing...</span>`;
    } else {
        btnStartDownload.innerHTML = `<span class="sniff-spinner"></span> <span>Starting...</span>`;
    }

    let quality = null;
    const cat = categorySelect.value;
    if (cat === 'Video' || cat === 'Audio' || currentMetadata.type === 'media') {
        quality = qualitySelect.value;
    }

    const isDirect = (cat === 'Programs' || cat === 'Compressed' || cat === 'Documents' || currentMetadata.type === 'file');
    const payload = {
        url: currentMetadata.url,
        save_path: path.dirname(savePathInput.value),
        title: filenameInput.value.trim(),
        quality: quality,
        is_yt_dlp: isDirect ? false : (cat === 'Video' || cat === 'Audio' ? null : false),
        cookies: currentMetadata.cookies || null,
        user_agent: currentMetadata.user_agent || null,
        referer: currentMetadata.referer || null
    };

    try {
        const res = await axios.post(`${API_URL}/download`, payload, { timeout: 15000 });
        
        if (res.data && res.data.status === 'error') {
            throw new Error(res.data.message || 'Backend error');
        }

        const downloadId = res.data.id;

        // If Download Later was selected, pause it right away
        if (isLater && downloadId) {
            try {
                await axios.post(`${API_URL}/pause/${downloadId}`);
            } catch (e) {}
        }

        // Show brief success feedback
        if (!isLater) {
            btnStartDownload.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> <span>Started!</span>`;
        } else {
            btnDownloadLater.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> <span>Queued!</span>`;
        }

        setTimeout(() => {
            resetFormState();
            closeWindow();
        }, 400);

    } catch (err) {
        console.error('Download start failed:', err);
        resetFormState();
        errorText.innerText = err.response?.data?.detail || err.message || 'Failed to start download.';
        errorBanner.style.display = 'flex';
        btnStartDownload.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5"></path><path d="M4 17v-5h5"></path><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"></path></svg><span>Retry Download</span>`;
    }
}

btnStartDownload.addEventListener('click', () => handleStartDownload(false));
btnDownloadLater.addEventListener('click', () => handleStartDownload(true));
btnRetry.addEventListener('click', () => handleStartDownload(false));
btnSkipSniff.addEventListener('click', skipInfoFetch);

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeWindow();
    } else if (e.key === 'Enter' && !btnStartDownload.disabled) {
        handleStartDownload(false);
    }
});

// Exposed function called by main.js
window.updateQuickAddInfo = async function(metadata) {
    if (sniffAbortController) sniffAbortController.abort();
    const requestId = ++sniffRequestId;
    sniffAbortController = null;
    // Retrigger popup animation for a snappy feel
    windowContainer.style.animation = 'none';
    windowContainer.offsetHeight;
    windowContainer.style.animation = 'windowPop 0.2s cubic-bezier(0.16, 1, 0.3, 1)';

    // 1. Full State Reset
    resetFormState();

    // 2. Clear old metadata completely and set new payload
    currentMetadata = {
        url: metadata.url || '',
        filename: metadata.filename || '',
        file_size: metadata.file_size || null,
        sizes: null,
        mime_type: metadata.mime_type || '',
        native_browser_download: metadata.native_browser_download === true,
        native_download_paused: metadata.native_download_paused === true,
        native_download_id: Number.isInteger(metadata.native_download_id) ? metadata.native_download_id : null,
        cookies: metadata.cookies || null,
        user_agent: metadata.user_agent || null,
        referer: metadata.referer || null,
        type: 'unknown'
    };
    userSelectedSavePath = false;

    if (currentMetadata.native_browser_download) {
        updateUI();
        sniffingLoader.style.display = 'none';
        errorBanner.style.display = 'flex';
        errorBanner.classList.add('native-download-notice');
        errorText.innerText = currentMetadata.native_download_paused
            ? 'Telegram Web only gives this file to your signed-in browser. It is paused now. Start via Browser resumes it; Chrome handles the transfer, save location, and progress. Ledo cannot run this URL through its own download engine.'
            : 'Chrome could not pause this Telegram transfer, so it may already be downloading. Ledo cannot take over this session-only URL; use Cancel to stop the browser transfer.';
        btnRetry.style.display = 'none';
        filenameInput.disabled = true;
        categorySelect.disabled = true;
        savePathInput.closest('.form-group').style.display = 'none';
        rememberPath.closest('.checkbox-container').style.display = 'none';
        threadsSelect.closest('.threads-selector').style.display = 'none';
        const startText = btnStartDownload.querySelector('#btn-start-text');
        if (startText) startText.textContent = currentMetadata.native_download_paused ? 'Start in Browser' : 'Already Downloading';
        const laterText = btnDownloadLater.querySelector('span');
        if (laterText) laterText.textContent = 'Keep Paused';
        if (!currentMetadata.native_download_paused) {
            btnStartDownload.disabled = true;
            btnDownloadLater.disabled = true;
        }
        return;
    }

    if (!currentMetadata.url) {
        updateUI();
        sniffingLoader.style.display = 'none';
        urlInput.focus();
        return;
    }

    // If filename is missing, attempt to extract from URL (including query params)
    if (!currentMetadata.filename && currentMetadata.url) {
        const extracted = filenameFromUrl(currentMetadata.url);
        if (extracted && extracted.length > 1) {
            currentMetadata.filename = extracted;
        }
    }

    // 3. If extension already gave filename and size, update UI immediately
    if (currentMetadata.filename && currentMetadata.file_size) {
        updateUI();
        sniffingLoader.style.display = 'none';
        return;
    }

    // 4. Otherwise, sniff the URL from backend
    updateUI();
    sniffingLoader.style.display = 'flex';
    sniffAbortController = new AbortController();
    const abortController = sniffAbortController;
    
    try {
        const res = await axios.post(`${API_URL}/sniff`, { 
            url: currentMetadata.url,
            cookies: currentMetadata.cookies || null,
            user_agent: currentMetadata.user_agent || null,
            referer: currentMetadata.referer || null
        }, { timeout: 30000, signal: abortController.signal });
        if (requestId !== sniffRequestId) return;
        const info = res.data;
        if (info && info.title && info.title !== 'Unknown File') {
            currentMetadata.filename = info.title;
            currentMetadata.file_size = info.size || currentMetadata.file_size;
            currentMetadata.sizes = info.sizes || null;
            currentMetadata.type = info.type || 'file';
        }
    } catch (e) {
        if (requestId === sniffRequestId) {
            console.warn('Sniff failed or timed out:', e);
        }
    } finally {
        if (requestId === sniffRequestId) {
            sniffAbortController = null;
            sniffingLoader.style.display = 'none';
            updateUI();
        }
    }
};

appApi.onQuickAddPayload((metadata) => {
    if (typeof window.updateQuickAddInfo === 'function') {
        window.updateQuickAddInfo(metadata || {});
    }
});

appApi.onQuickAddFocusUrl(() => {
    urlInput.focus();
    urlInput.setSelectionRange(urlInput.value.length, urlInput.value.length);
});

// Auto-select filename on focus for fast renaming
filenameInput.addEventListener('focus', () => {
    const fn = filenameInput.value;
    const dotIdx = fn.lastIndexOf('.');
    if (dotIdx > 0) {
        filenameInput.setSelectionRange(0, dotIdx);
    } else {
        filenameInput.select();
    }
});

// Legacy fallback execution
setTimeout(() => {
    if (window.tempMetadata) {
        window.updateQuickAddInfo(window.tempMetadata);
        window.tempMetadata = null;
    }
}, 100);
