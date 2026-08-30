chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "download_with_ledo",
        title: "Download with Ledo",
        contexts: ["link", "video", "audio"]
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "download_with_ledo") {
        const urlToDownload = info.linkUrl || info.srcUrl;

        if (urlToDownload) {
            sendToLedoApp(urlToDownload);
        }
    }
});

// Handle messages from content_script.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) {
        sendResponse({ success: false, error: "Invalid message" });
        return false;
    }

    if (message.action === "directDownload") {
        const payload = {
            url: message.url,
            is_yt_dlp: true
        };
        if (message.quality) payload.quality = message.quality;
        sendToLedoApp(message.url, payload).then((data) => {
            sendResponse({ success: true, data });
        }).catch((err) => {
            sendResponse({ success: false, error: String(err) });
        });
        return true; // Keep the message channel open for async response
    }

    if (message.action === "downloadUrl") {
        // Quick Add - sends the URL to the desktop app's Quick Add window
        sendQuickAdd(message.url).then(() => {
            sendResponse({ success: true });
        }).catch((err) => {
            sendResponse({ success: false, error: String(err) });
        });
        return true;
    }

    sendResponse({ success: false, error: "Unknown action" });
    return false;
});

async function sendToLedoApp(url, extra = {}) {
    const body = { url, ...extra };
    const resp = await fetch('http://127.0.0.1:8000/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error(data.message || `HTTP ${resp.status}`);
    }
    return data;
}

async function sendQuickAdd(url) {
    const body = { url };
    const resp = await fetch('http://127.0.0.1:8000/api/quick-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error(data.message || `HTTP ${resp.status}`);
    }
    return data;
}
