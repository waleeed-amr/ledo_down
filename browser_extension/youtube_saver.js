(() => {
    if (window.top !== window || !location.hostname.endsWith('youtube.com')) return;

    const STORAGE_KEY = 'ledo_youtube_saver_stats';
    const STYLE_ID = 'ledo-audio-focus-style';
    const BUTTON_ID = 'ledo-audio-focus-button';
    const videoBitrates = { 144: 0.12, 240: 0.25, 360: 0.45, 480: 0.8, 720: 1.8, 1080: 3.5, 1440: 6.5, 2160: 12 };
    let enabled = false;
    let busy = false;
    let sessionId = null;
    let audioElement = null;
    let originalVideo = null;
    let originalTime = 0;
    let wasPlaying = false;
    let originalVolume = 1;
    let originalMuted = false;
    let originalPlaybackRate = 1;
    let navigationVersion = 0;
    let lastTick = 0;
    let audioBitrateMbps = 0.128;
    let videoBaselineMbps = 1.8;
    let stats = { seconds: 0, bytesServed: 0, estimatedAvoidedBytes: 0, sessions: 0, startedAt: Date.now() };

    chrome.storage.local.get(STORAGE_KEY, data => {
        if (data[STORAGE_KEY] && typeof data[STORAGE_KEY] === 'object') stats = { ...stats, ...data[STORAGE_KEY] };
        install();
    });

    function player() { return document.getElementById('movie_player'); }
    function video() { return player()?.querySelector('video'); }
    function currentVideoId() { return new URLSearchParams(location.search).get('v') || location.pathname; }

    function install() {
        const controls = player()?.querySelector('.ytp-right-controls');
        if (!controls || document.getElementById(BUTTON_ID)) return;
        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.className = 'ytp-button';
        button.type = 'button';
        button.title = 'Listen with LEDO Audio Focus';
        button.setAttribute('aria-label', button.title);
        button.innerHTML = '<span style="font-size:16px;font-weight:800;letter-spacing:-1px">L</span>';
        button.style.cssText = 'width:44px;color:#a78bfa;display:inline-flex;align-items:center;justify-content:center';
        button.addEventListener('click', () => enabled ? stopAudioMode(true) : startAudioMode());
        controls.insertBefore(button, controls.firstChild);
        syncButton();
    }

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .ledo-audio-focus-active video { opacity: 0 !important; }
            .ledo-audio-focus-overlay { position:absolute; inset:0; z-index:40; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; pointer-events:auto; color:#fff; font:800 clamp(22px,5vw,56px)/1.1 system-ui,sans-serif; letter-spacing:.08em; background:radial-gradient(ellipse at center,rgba(24,18,48,.94),rgba(5,5,10,.99)); text-shadow:0 0 28px rgba(139,92,246,.8); }
            .ledo-audio-focus-overlay small { color:#c4b5fd; font-size:clamp(10px,1.3vw,14px); letter-spacing:.18em; text-shadow:none; }
            .ledo-audio-focus-overlay .ledo-audio-title { max-width:82%; overflow:hidden; color:#cbd5e1; font-size:clamp(11px,1.4vw,15px); font-weight:500; letter-spacing:0; text-overflow:ellipsis; white-space:nowrap; text-shadow:none; }
            .ledo-audio-focus-controls { width:min(560px,78%); height:42px; }
            .ledo-audio-focus-loading { color:#cbd5e1; font-size:12px; font-weight:500; letter-spacing:0; text-shadow:none; }
            .ledo-audio-focus-restore { padding:8px 13px; border:1px solid rgba(196,181,253,.45); border-radius:7px; background:rgba(139,92,246,.18); color:#e9d5ff; font:600 12px system-ui,sans-serif; cursor:pointer; }
        `;
        document.documentElement.appendChild(style);
    }

    function showBrand(title = '', message = '') {
        const host = player();
        if (!host) return;
        ensureStyles();
        host.classList.add('ledo-audio-focus-active');
        let overlay = host.querySelector('.ledo-audio-focus-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'ledo-audio-focus-overlay';
            overlay.innerHTML = '<div>LEDO IS ON</div><small>RADIO MODE · AUDIO ONLY</small><div class="ledo-audio-title"></div><div class="ledo-audio-focus-loading"></div><button type="button" class="ledo-audio-focus-restore">Restore YouTube video</button>';
            overlay.querySelector('.ledo-audio-focus-restore').addEventListener('click', event => {
                event.stopPropagation();
                stopAudioMode(true);
            });
            host.appendChild(overlay);
        }
        overlay.querySelector('.ledo-audio-title').textContent = title;
        overlay.querySelector('.ledo-audio-focus-loading').textContent = message;
        if (audioElement && !audioElement.isConnected) overlay.appendChild(audioElement);
    }

    function clearBrand() {
        player()?.classList.remove('ledo-audio-focus-active');
        player()?.querySelector('.ledo-audio-focus-overlay')?.remove();
    }

    function setBusy(value, message = '') {
        busy = value;
        const button = document.getElementById(BUTTON_ID);
        if (button) {
            button.disabled = value;
            button.style.opacity = value ? '0.65' : '1';
        }
        const restoreButton = player()?.querySelector('.ledo-audio-focus-restore');
        if (restoreButton) restoreButton.disabled = value;
        if (value) showBrand('', message);
        syncButton();
    }

    async function startAudioMode() {
        if (busy || enabled) return;
        const sourceVideo = video();
        if (!sourceVideo) return;
        const requestedUrl = location.href;
        const requestedVideoId = currentVideoId();
        const requestNavigationVersion = navigationVersion;
        originalVideo = sourceVideo;
        originalTime = Number.isFinite(sourceVideo.currentTime) ? sourceVideo.currentTime : 0;
        wasPlaying = !sourceVideo.paused;
        originalVolume = sourceVideo.volume;
        originalMuted = sourceVideo.muted;
        originalPlaybackRate = sourceVideo.playbackRate || 1;
        const height = sourceVideo.videoHeight || 720;
        videoBaselineMbps = videoBitrates[height] || (height < 720 ? 0.8 : height < 1080 ? 1.8 : 3.5);
        sourceVideo.pause();
        setBusy(true, 'Preparing an audio-only stream…');
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'createYouTubeAudioSession',
                url: requestedUrl
            });
            if (!response?.success) throw new Error(response?.error || 'Ledo Desktop is unavailable.');

            const data = response.data;
            if (requestNavigationVersion !== navigationVersion || requestedVideoId !== currentVideoId()) {
                chrome.runtime.sendMessage({ action: 'closeYouTubeAudioSession', sessionId: data.session_id }, () => void chrome.runtime.lastError);
                return;
            }
            sessionId = data.session_id;
            audioBitrateMbps = Math.max(0.032, Number(data.audio_bitrate_kbps) / 1000 || 0.128);
            const blocking = await chrome.runtime.sendMessage({
                action: 'startYouTubeAudioTrafficTracking',
                sessionId,
                formatId: data.format_id,
                videoItags: data.video_itags
            });
            if (!blocking?.success) throw new Error(blocking?.error || 'Could not pause YouTube video requests.');
            audioElement = document.createElement('audio');
            audioElement.className = 'ledo-audio-focus-controls';
            audioElement.controls = true;
            audioElement.preload = 'none';
            audioElement.volume = originalVolume;
            audioElement.muted = originalMuted;
            audioElement.playbackRate = originalPlaybackRate;
            audioElement.src = data.stream_url;
            audioElement.setAttribute('aria-label', 'LEDO audio-only player');
            audioElement.addEventListener('timeupdate', trackPlayback);
            audioElement.addEventListener('play', () => { lastTick = Date.now(); });
            audioElement.addEventListener('pause', () => { lastTick = 0; });
            audioElement.addEventListener('ended', () => { lastTick = 0; persistStats(); });
            audioElement.addEventListener('error', () => {
                if (!enabled || audioElement?.src !== data.stream_url) return;
                showBrand(data.title, 'Audio stream failed. Restoring YouTube video…');
                setTimeout(() => { if (enabled) stopAudioMode(true); }, 900);
            }, { once: true });
            audioElement.addEventListener('loadedmetadata', () => {
                if (originalTime > 0 && Number.isFinite(audioElement.duration) && originalTime < audioElement.duration) {
                    try { audioElement.currentTime = originalTime; } catch (_) { /* The player can seek after the first range loads. */ }
                }
                audioElement.play().catch(() => showBrand(data.title, 'Press play to start listening'));
            }, { once: true });

            enabled = true;
            stats.sessions += 1;
            stats.lastVideoId = currentVideoId();
            showBrand(data.title, '');
            chrome.storage.local.set({ ledo_audio_focus_enabled: true });
            syncButton();
            audioElement.load();
            audioElement.play().catch(() => {});
            persistStats();
        } catch (error) {
            if (sessionId) {
                await chrome.runtime.sendMessage({ action: 'stopYouTubeAudioTrafficTracking', sessionId }).catch(() => null);
            }
            if (originalVideo && wasPlaying) originalVideo.play().catch(() => {});
            closeSession();
            clearBrand();
            showToast(error.message || 'Could not start LEDO Audio Focus.');
        } finally {
            setBusy(false);
            syncButton();
        }
    }

    async function stopAudioMode(restoreVideo) {
        if (!enabled || busy) return;
        const resumeAt = audioElement && Number.isFinite(audioElement.currentTime) ? audioElement.currentTime : originalTime;
        enabled = false;
        const activeSessionId = sessionId;
        sessionId = null;
        audioElement?.pause();
        audioElement?.remove();
        audioElement = null;
        clearBrand();
        if (activeSessionId) {
            const restored = await chrome.runtime.sendMessage({ action: 'stopYouTubeAudioTrafficTracking', sessionId: activeSessionId }).catch(() => null);
            if (!restored?.success) showToast('Could not release YouTube video requests. Reload the YouTube tab if playback does not resume.');
        }
        if (restoreVideo && originalVideo?.isConnected) {
            try { originalVideo.currentTime = resumeAt; } catch (_) { /* YouTube may still be swapping its media source. */ }
            if (wasPlaying) originalVideo.play().catch(() => {});
        }
        originalVideo = null;
        chrome.storage.local.set({ ledo_audio_focus_enabled: false });
        await closeSession(activeSessionId);
        persistStats();
        syncButton();
    }

    function closeSession(id = sessionId) {
        if (sessionId === id) sessionId = null;
        if (id && chrome.runtime?.id) {
            chrome.runtime.sendMessage({ action: 'closeYouTubeAudioSession', sessionId: id }, () => void chrome.runtime.lastError);
        }
    }

    function trackPlayback() {
        const now = Date.now();
        if (enabled && audioElement && !audioElement.paused && !audioElement.ended) {
            if (lastTick && now - lastTick < 5000) {
                const elapsed = (now - lastTick) / 1000;
                stats.seconds += elapsed;
                stats.estimatedAvoidedBytes += Math.max(0, videoBaselineMbps - audioBitrateMbps) * 125000 * elapsed;
            }
            lastTick = now;
            if (now - (stats.updatedAt || 0) > 10000) persistStats();
        } else lastTick = 0;
    }

    function persistStats() {
        stats.updatedAt = Date.now();
        chrome.storage.local.set({ ledo_youtube_saver_stats: stats });
    }

    function syncButton() {
        const button = document.getElementById(BUTTON_ID);
        if (!button) return;
        button.style.color = enabled ? '#34d399' : '#a78bfa';
        button.title = busy ? 'Preparing LEDO Audio Focus…' : enabled ? 'LEDO Radio Mode is on — click to restore YouTube video' : 'Listen with LEDO Radio Mode';
        button.setAttribute('aria-pressed', String(enabled));
    }

    function showToast(message) {
        let toast = document.getElementById('ledo-audio-focus-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'ledo-audio-focus-toast';
            toast.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:20px;transform:translateX(-50%);padding:11px 16px;border-radius:8px;background:#17152a;color:#fff;border:1px solid #8b5cf6;font:13px system-ui;box-shadow:0 8px 24px #0008';
            document.documentElement.appendChild(toast);
        }
        toast.textContent = message;
        setTimeout(() => toast.remove(), 4500);
    }

    new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('yt-navigate-finish', () => {
        navigationVersion += 1;
        if (enabled) stopAudioMode(false);
        clearBrand();
        install();
    });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.action === 'getLedoAudioFocusState') {
            sendResponse({ success: true, enabled, busy });
            return false;
        }
        if (message?.action !== 'toggleLedoAudioFocus') return false;
        if (enabled) stopAudioMode(true).then(() => sendResponse({ success: true, enabled: false }));
        else startAudioMode().then(() => sendResponse({ success: enabled, enabled, error: enabled ? undefined : 'Could not start audio mode.' }));
        return true;
    });
    window.addEventListener('pagehide', () => {
        persistStats();
        if (sessionId) chrome.runtime.sendMessage({ action: 'stopYouTubeAudioTrafficTracking', sessionId }).catch(() => {});
        closeSession();
    });
    setInterval(install, 1500);
})();
