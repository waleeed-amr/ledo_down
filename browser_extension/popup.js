const API_BASE = 'http://127.0.0.1:8000/api';

// DOM Elements
const statusIndicator = document.getElementById('app-status');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');
const currentUrlInput = document.getElementById('current-url');
const toastEl = document.getElementById('toast');

// State
let isAppOnline = false;
let currentTabUrl = '';
let currentTabTitle = '';

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    checkAppStatus();
    setupTabs();
    getCurrentTabInfo();
    setupSettings();
    
    // Poll status every 3 seconds
    setInterval(checkAppStatus, 3000);
});

// --- Tab Logic ---
function setupTabs() {
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Remove active from all
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));
            
            // Add active to clicked
            btn.classList.add('active');
            const target = btn.getAttribute('data-target');
            document.getElementById(target).classList.add('active');

            // Specific tab logic
            if (target === 'tab-smart') {
                sniffMedia();
            }
        });
    });
}

// --- Status Check ---
async function checkAppStatus() {
    try {
        const response = await fetch(`${API_BASE}/health`, { method: 'GET', mode: 'cors' });
        if (response.ok) {
            setAppOnline(true);
            fetchActiveDownloads();
        } else {
            setAppOnline(false);
        }
    } catch (err) {
        setAppOnline(false);
    }
}

function setAppOnline(online) {
    isAppOnline = online;
    if (online) {
        statusIndicator.classList.add('online');
        statusIndicator.title = "Desktop App is Online";
        document.getElementById('status-offline').style.display = 'none';
        document.getElementById('status-stats').style.display = 'block';
    } else {
        statusIndicator.classList.remove('online');
        statusIndicator.title = "Desktop App is Offline";
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
            // Just count them
            document.getElementById('active-count').innerText = downloads.length || 0;
        }
    } catch (e) {
        console.error("Failed to fetch downloads list");
    }
}

// --- Toast Notifications ---
function showToast(message, isError = false) {
    toastEl.innerText = message;
    if (isError) {
        toastEl.classList.add('error');
    } else {
        toastEl.classList.remove('error');
    }
    toastEl.classList.add('show');
    
    setTimeout(() => {
        toastEl.classList.remove('show');
    }, 3000);
}

// --- URL Cleaner ---
function cleanUrl(url) {
    try {
        const urlObj = new URL(url);
        
        // Clean YouTube URLs
        if (urlObj.hostname.includes('youtube.com') && urlObj.pathname === '/watch') {
            const videoId = urlObj.searchParams.get('v');
            if (videoId) {
                return `https://www.youtube.com/watch?v=${videoId}`;
            }
        }
        
        // Clean Facebook URLs
        if (urlObj.hostname.includes('facebook.com')) {
            if (urlObj.pathname === '/watch' || urlObj.pathname === '/watch/') {
                const videoId = urlObj.searchParams.get('v');
                if (videoId) {
                    return `https://www.facebook.com/watch/?v=${videoId}`;
                }
            } else if (urlObj.pathname.includes('/videos/')) {
                return `${urlObj.origin}${urlObj.pathname}`;
            }
        }
        
        // Clean TikTok URLs
        if (urlObj.hostname.includes('tiktok.com') && urlObj.pathname.includes('/video/')) {
            return `${urlObj.origin}${urlObj.pathname}`;
        }
        
        // Clean Instagram URLs
        if (urlObj.hostname.includes('instagram.com') && (urlObj.pathname.includes('/p/') || urlObj.pathname.includes('/reel/'))) {
            return `${urlObj.origin}${urlObj.pathname}`;
        }
        
    } catch (e) {
        // ignore
    }
    return url;
}

// --- Send to Desktop App ---
async function sendToDesktop(rawUrl, quality = 'best') {
    if (!isAppOnline) {
        showToast("Cannot connect to Ledo Desktop App", true);
        return;
    }
    
    const url = cleanUrl(rawUrl);
    
    try {
        const response = await fetch(`${API_BASE}/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url, quality: quality })
        });
        
        if (response.ok) {
            showToast("Successfully sent to Ledo!");
        } else {
            showToast("Error adding download", true);
        }
    } catch (err) {
        showToast("Connection failed", true);
    }
}

// --- Current Tab Logic ---
function getCurrentTabInfo() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs.length > 0) {
            currentTabUrl = tabs[0].url;
            currentTabTitle = tabs[0].title;
            currentUrlInput.value = currentTabUrl;
            
            // Disable if it's a chrome internal url
            if (currentTabUrl.startsWith('chrome://') || currentTabUrl.startsWith('edge://')) {
                document.querySelectorAll('.current-quality-btn').forEach(b => b.disabled = true);
                currentUrlInput.value = "Cannot download from internal pages";
            } else {
                // Auto-sniff on open (since Smart tab is default)
                sniffMedia(tabs[0].id);
            }
        }
    });
}

document.querySelectorAll('.current-quality-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (!currentTabUrl || btn.disabled) return;
        const quality = btn.getAttribute('data-quality');
        sendToDesktop(currentTabUrl, quality);
        
        const originalText = btn.innerHTML;
        btn.innerHTML = '✔ Added';
        btn.style.opacity = '0.8';
        
        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.style.opacity = '1';
        }, 2000);
    });
});

// --- Smart Sniffer Logic ---
let hasSniffed = false;

function sniffMedia(tabIdOverride = null) {
    if (hasSniffed) return;
    
    document.getElementById('sniffer-loader').style.display = 'block';
    document.getElementById('sniffer-empty').style.display = 'none';
    document.getElementById('media-list').innerHTML = '';

    const executeSniff = (tabId) => {
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: detectMediaOnPage
        }, (results) => {
            hasSniffed = true;
            document.getElementById('sniffer-loader').style.display = 'none';
            
            if (chrome.runtime.lastError || !results || !results[0].result || results[0].result.length === 0) {
                document.getElementById('sniffer-empty').style.display = 'flex';
                return;
            }

            renderSniffedMedia(results[0].result);
        });
    };

    if (tabIdOverride) {
        executeSniff(tabIdOverride);
    } else {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs.length > 0 && !tabs[0].url.startsWith('chrome://')) {
                executeSniff(tabs[0].id);
            } else {
                document.getElementById('sniffer-loader').style.display = 'none';
                document.getElementById('sniffer-empty').style.display = 'flex';
            }
        });
    }
}

// This function runs INSIDE the webpage context!
function detectMediaOnPage() {
    const mediaList = [];
    
    // 1. Find Video elements
    const videos = document.querySelectorAll('video');
    videos.forEach((vid, index) => {
        if (vid.src) {
            mediaList.push({
                url: vid.src,
                type: 'video',
                title: document.title || `Video Element ${index + 1}`
            });
        }
        // Check source tags inside video
        const sources = vid.querySelectorAll('source');
        sources.forEach(src => {
            if (src.src) {
                mediaList.push({
                    url: src.src,
                    type: 'video',
                    title: document.title || `Video Source ${index + 1}`
                });
            }
        });
    });

    // 2. Find Audio elements
    const audios = document.querySelectorAll('audio');
    audios.forEach((aud, index) => {
        if (aud.src) {
            mediaList.push({
                url: aud.src,
                type: 'audio',
                title: document.title || `Audio Element ${index + 1}`
            });
        }
    });

    // 3. Find common direct download links (.mp4, .mp3, .mkv, .avi)
    const links = document.querySelectorAll('a');
    links.forEach(a => {
        if (a.href) {
            const urlLower = a.href.toLowerCase();
            if (urlLower.match(/\.(mp4|webm|mkv|avi|mov)$/)) {
                mediaList.push({
                    url: a.href,
                    type: 'video',
                    title: a.innerText || 'Direct Video Link'
                });
            } else if (urlLower.match(/\.(mp3|wav|ogg|flac|m4a)$/)) {
                mediaList.push({
                    url: a.href,
                    type: 'audio',
                    title: a.innerText || 'Direct Audio Link'
                });
            }
        }
    });

    // Remove duplicates based on URL
    const unique = [];
    const seenUrls = new Set();
    
    // Prioritize the page URL itself if it's a known video site like youtube
    if (window.location.hostname.includes('youtube.com') || window.location.hostname.includes('vimeo.com')) {
         unique.push({
             url: window.location.href,
             type: 'video',
             title: 'Main Page Video (YouTube/Vimeo)'
         });
    }

    mediaList.forEach(item => {
        if (!seenUrls.has(item.url) && !item.url.startsWith('blob:')) {
            seenUrls.add(item.url);
            unique.push(item);
        }
    });

    return unique.slice(0, 10); // Limit to top 10
}

function renderSniffedMedia(mediaItems) {
    const listEl = document.getElementById('media-list');
    
    mediaItems.forEach(item => {
        const div = document.createElement('div');
        div.className = 'media-item';
        
        const typeColor = item.type === 'video' ? '#3b82f6' : '#10b981';
        
        div.innerHTML = `
            <div class="media-title" title="${item.url}">${item.title}</div>
            <div class="media-meta">
                <span class="badge" style="color: ${typeColor}; background: ${typeColor}22;">${item.type.toUpperCase()}</span>
                <span style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${item.url}">${item.url}</span>
            </div>
            <div class="quality-picker" style="display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap;">
                <button class="btn quality-btn" data-quality="best" style="flex: 1; padding: 6px 4px; font-size: 10px; min-width: 0; background: linear-gradient(135deg, #7c3aed, #6d28d9);">⚡ MAX</button>
                <button class="btn quality-btn" data-quality="720p" style="flex: 1; padding: 6px 4px; font-size: 10px; min-width: 0; background: var(--surface); border: 1px solid var(--border);">720p</button>
                <button class="btn quality-btn" data-quality="480p" style="flex: 1; padding: 6px 4px; font-size: 10px; min-width: 0; background: var(--surface); border: 1px solid var(--border);">480p</button>
                <button class="btn quality-btn" data-quality="360p" style="flex: 1; padding: 6px 4px; font-size: 10px; min-width: 0; background: var(--surface); border: 1px solid var(--border);">360p</button>
                <button class="btn quality-btn" data-quality="audio" style="flex: 1; padding: 6px 4px; font-size: 10px; min-width: 0; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3);">🎵 MP3</button>
                <button class="btn quality-btn" data-quality="best" title="For Direct Files" style="flex: 1; padding: 6px 4px; font-size: 10px; min-width: 0; background: var(--surface); border: 1px solid var(--border);">📄 FILE</button>
            </div>
        `;
        
        div.querySelectorAll('.quality-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const quality = btn.getAttribute('data-quality');
                sendToDesktop(item.url, quality);
                
                // Disable all buttons in this item and show feedback
                div.querySelectorAll('.quality-btn').forEach(b => {
                    b.disabled = true;
                    b.style.opacity = '0.5';
                });
                btn.innerHTML = '✔ Sent!';
                btn.style.background = 'var(--success)';
                btn.style.opacity = '1';
                
                setTimeout(() => {
                    div.querySelectorAll('.quality-btn').forEach(b => {
                        b.disabled = false;
                        b.style.opacity = '1';
                    });
                    btn.innerHTML = btn.getAttribute('data-quality') === 'best' && !btn.title ? '⚡ MAX' : 
                                    btn.getAttribute('data-quality') === 'audio' ? '🎵 MP3' : 
                                    btn.title ? '📄 FILE' : btn.getAttribute('data-quality');
                    btn.style.background = btn.getAttribute('data-quality') === 'best' && !btn.title ? 'linear-gradient(135deg, #7c3aed, #6d28d9)' :
                                           btn.getAttribute('data-quality') === 'audio' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)';
                }, 2000);
            });
        });
        
        listEl.appendChild(div);
    });
}

// --- Settings Logic ---
function setupSettings() {
    const toggle = document.getElementById('toggle-intercept');
    const slider = document.getElementById('toggle-slider');
    
    chrome.storage.local.get(['intercept_enabled'], (res) => {
        const isEnabled = res.intercept_enabled !== false; // Default true
        toggle.checked = isEnabled;
        updateSlider(isEnabled);
    });
    
    toggle.addEventListener('change', (e) => {
        const isEnabled = e.target.checked;
        chrome.storage.local.set({ intercept_enabled: isEnabled }, () => {
            updateSlider(isEnabled);
            showToast(isEnabled ? "Interception Enabled" : "Interception Disabled");
        });
    });
    
    function updateSlider(isEnabled) {
        if (isEnabled) {
            slider.style.transform = 'translateX(18px)';
            slider.style.backgroundColor = 'var(--primary)';
        } else {
            slider.style.transform = 'translateX(0)';
            slider.style.backgroundColor = 'var(--text-muted)';
        }
    }
}
