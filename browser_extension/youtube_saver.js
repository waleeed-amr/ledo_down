(() => {
    if (window.top !== window || !/(^|\.)youtube\.com$/i.test(location.hostname)) return;
    if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.storage?.local) return;

    const STATS_KEY = 'ledo_youtube_saver_stats';
    const BUTTON_ID = 'ledo-audio-focus-button';
    const STYLE_ID = 'ledo-radio-mode-style';
    const PHASES = new Set(['idle', 'preparing', 'playing', 'stopping']);
    const bitrateByHeight = { 144: 0.12, 240: 0.25, 360: 0.45, 480: 0.8, 720: 1.8, 1080: 3.5, 1440: 6.5, 2160: 12 };
    const mode = {
        phase: 'idle', generation: 0, sessionId: null, tracking: false,
        remoteState: null, video: null, videoId: null, startAt: 0,
        originalTime: 0, wasPlaying: false, volume: 1, muted: false, rate: 1,
        audioMbps: 0.128, videoMbps: 1.8, lastTick: 0,
        stats: { seconds: 0, estimatedAvoidedBytes: 0, sessions: 0, startedAt: Date.now() }
    };

    chrome.storage.local.get(STATS_KEY, result => {
        if (result?.[STATS_KEY] && typeof result[STATS_KEY] === 'object') {
            mode.stats = { ...mode.stats, ...result[STATS_KEY] };
        }
        install();
    });

    function player() { return document.getElementById('movie_player'); }
    function currentVideo() { return player()?.querySelector('video'); }
    function currentId() { return new URLSearchParams(location.search).get('v') || location.pathname; }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .ledo-radio-active video { opacity:0!important; }
            .ledo-radio-panel { position:absolute; inset:0; z-index:80; display:flex; align-items:center; justify-content:center; padding:24px; box-sizing:border-box; color:#f8fafc; background:radial-gradient(ellipse at 50% 38%,#251d48 0,#11111d 56%,#09090e 100%); font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif; }
            .ledo-radio-card { width:min(460px,100%); display:flex; flex-direction:column; align-items:center; gap:14px; text-align:center; }
            .ledo-radio-mark { width:58px;height:58px;border:1px solid #8b5cf6;border-radius:18px;display:grid;place-items:center;color:#c4b5fd;background:#8b5cf622;font-size:22px;font-weight:800;box-shadow:0 0 44px #8b5cf633; }
            .ledo-radio-eq { height:22px;display:flex;align-items:center;gap:4px; }
            .ledo-radio-eq i { width:3px;height:7px;border-radius:3px;background:#a78bfa;animation:ledo-radio-wave .82s ease-in-out infinite alternate; }
            .ledo-radio-eq i:nth-child(2){animation-delay:.13s}.ledo-radio-eq i:nth-child(3){animation-delay:.27s}.ledo-radio-eq i:nth-child(4){animation-delay:.4s}.ledo-radio-eq i:nth-child(5){animation-delay:.53s}
            .ledo-radio-panel[data-phase="preparing"] .ledo-radio-eq i,.ledo-radio-panel[data-phase="idle"] .ledo-radio-eq i {animation-play-state:paused;opacity:.45}
            @keyframes ledo-radio-wave { to { height:21px; } }
            .ledo-radio-title { max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e2e8f0;font-size:14px;font-weight:600; }
            .ledo-radio-status { min-height:20px;color:#a1a1aa;font-size:12px; }
            .ledo-radio-controls { width:min(420px,100%);display:flex;align-items:center;gap:10px; }
            .ledo-radio-play { flex:none;width:38px;height:38px;border:1px solid #a78bfa66;border-radius:50%;background:#8b5cf633;color:#f5f3ff;font-size:14px;cursor:pointer; }
            .ledo-radio-seek { min-width:0;flex:1;accent-color:#a78bfa; }
            .ledo-radio-time { min-width:75px;color:#a1a1aa;font:11px ui-monospace,monospace;text-align:right; }
            .ledo-radio-mute { flex:none;border:0;background:transparent;color:#c4b5fd;font-size:18px;cursor:pointer; }
            .ledo-radio-volume { width:72px;accent-color:#a78bfa; }
            .ledo-radio-restore { border:1px solid #ffffff26;border-radius:999px;padding:9px 16px;background:#ffffff0d;color:#e9d5ff;font:600 12px system-ui,sans-serif;cursor:pointer; }
            .ledo-radio-restore:hover { background:#8b5cf633;border-color:#a78bfa88; }
            .ledo-radio-restore:disabled { opacity:.55;cursor:wait; }
        `;
        document.documentElement.appendChild(style);
    }

    function createPanel() {
        const host = player();
        if (!host) return null;
        injectStyles();
        host.classList.add('ledo-radio-active');
        let panel = host.querySelector('.ledo-radio-panel');
        if (!panel) {
            panel = document.createElement('section');
            panel.className = 'ledo-radio-panel';
            panel.setAttribute('aria-label', 'LEDO Radio Mode');
            panel.innerHTML = '<div class="ledo-radio-card"><div class="ledo-radio-mark">L</div><div class="ledo-radio-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><strong class="ledo-radio-title">LEDO RADIO MODE</strong><div class="ledo-radio-status" role="status" aria-live="polite"></div><div class="ledo-radio-controls"><button type="button" class="ledo-radio-play" aria-label="تشغيل الصوت">▶</button><input class="ledo-radio-seek" type="range" min="0" max="100" value="0" aria-label="موضع التشغيل"><span class="ledo-radio-time">0:00 / 0:00</span><button type="button" class="ledo-radio-mute" aria-label="كتم الصوت">◖</button><input class="ledo-radio-volume" type="range" min="0" max="1" step="0.02" value="1" aria-label="مستوى الصوت"></div><button type="button" class="ledo-radio-restore">رجوع لفيديو يوتيوب</button></div>';
            panel.querySelector('.ledo-radio-restore').addEventListener('click', () => stop(true));
            panel.querySelector('.ledo-radio-play').addEventListener('click', () => control(mode.remoteState?.paused ? 'play' : 'pause'));
            panel.querySelector('.ledo-radio-seek').addEventListener('change', event => {
                const duration = mode.remoteState?.duration || 0;
                if (duration > 0) control('seek', duration * Number(event.currentTarget.value) / 100);
            });
            panel.querySelector('.ledo-radio-volume').addEventListener('input', event => control('volume', Number(event.currentTarget.value)));
            panel.querySelector('.ledo-radio-mute').addEventListener('click', () => control('mute', !mode.remoteState?.muted));
            host.appendChild(panel);
        }
        return panel;
    }

    function render(message = '') {
        const button = document.getElementById(BUTTON_ID);
        if (button) {
            const active = mode.phase === 'playing';
            const busy = mode.phase === 'preparing' || mode.phase === 'stopping';
            button.disabled = busy;
            button.style.color = active ? '#34d399' : '#c4b5fd';
            button.title = busy ? 'LEDO Radio Mode is preparing…' : active ? 'Stop LEDO Radio Mode' : 'Listen with LEDO Radio Mode';
            button.setAttribute('aria-label', button.title);
            button.setAttribute('aria-pressed', String(active));
        }
        const panel = player()?.querySelector('.ledo-radio-panel');
        if (panel) {
            panel.dataset.phase = mode.phase;
            const status = panel.querySelector('.ledo-radio-status');
            if (status) status.textContent = message || ({
                preparing: 'جاري تجهيز الصوت وإيقاف مسارات الفيديو…',
                playing: 'الصوت يعمل · الفيديو متوقف لهذا التبويب',
                stopping: 'جاري استعادة تشغيل يوتيوب…'
            }[mode.phase] || '');
            const restore = panel.querySelector('.ledo-radio-restore');
            if (restore) restore.disabled = mode.phase === 'preparing' || mode.phase === 'stopping';
            const play = panel.querySelector('.ledo-radio-play');
            const seek = panel.querySelector('.ledo-radio-seek');
            const time = panel.querySelector('.ledo-radio-time');
            const volume = panel.querySelector('.ledo-radio-volume');
            const mute = panel.querySelector('.ledo-radio-mute');
            const remote = mode.remoteState;
            if (play) {
                play.disabled = mode.phase !== 'playing';
                play.textContent = remote?.paused ? '▶' : 'Ⅱ';
                play.setAttribute('aria-label', remote?.paused ? 'تشغيل الصوت' : 'إيقاف الصوت مؤقتاً');
            }
            if (seek && document.activeElement !== seek) {
                seek.disabled = !remote?.duration || mode.phase !== 'playing';
                seek.value = remote?.duration ? String(Math.round((remote.currentTime / remote.duration) * 100)) : '0';
            }
            if (time) time.textContent = `${formatTime(remote?.currentTime)} / ${formatTime(remote?.duration)}`;
            if (volume) {
                volume.disabled = mode.phase !== 'playing';
                if (document.activeElement !== volume && remote) volume.value = String(remote.volume);
            }
            if (mute) {
                mute.disabled = mode.phase !== 'playing';
                mute.textContent = remote?.muted ? '×' : '◖';
                mute.setAttribute('aria-label', remote?.muted ? 'إلغاء كتم الصوت' : 'كتم الصوت');
            }
        }
    }

    function formatTime(value) {
        const seconds = Math.max(0, Math.floor(Number(value) || 0));
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }

    async function control(command, value) {
        const result = await send('controlYouTubeAudioPlayback', { command, value });
        if (!result?.success) toast(result?.error || 'تعذر التحكم في الصوت.');
        else if (result.state) applyPlaybackState(result.state);
    }

    function install() {
        const controls = player()?.querySelector('.ytp-right-controls');
        if (!controls || document.getElementById(BUTTON_ID)) return;
        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.className = 'ytp-button';
        button.type = 'button';
        button.textContent = 'L';
        button.style.cssText = 'width:42px;color:#c4b5fd;font-size:16px;font-weight:800;display:inline-flex;align-items:center;justify-content:center';
        button.addEventListener('click', () => mode.phase === 'playing' ? stop(true) : start());
        controls.insertBefore(button, controls.firstChild);
        render();
    }

    function send(action, fields = {}) {
        return chrome.runtime.sendMessage({ action, ...fields }).catch(error => ({ success: false, error: error.message }));
    }

    async function start() {
        if (mode.phase !== 'idle') return mode.phase === 'playing';
        const video = currentVideo();
        if (!video) {
            toast('شغّل فيديو يوتيوب أولاً، ثم جرّب Radio Mode.');
            return false;
        }

        const generation = ++mode.generation;
        mode.phase = 'preparing';
        mode.video = video;
        mode.videoId = currentId();
        mode.originalTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        mode.wasPlaying = !video.paused;
        mode.volume = video.volume;
        mode.muted = video.muted;
        mode.rate = video.playbackRate || 1;
        const height = video.videoHeight || 720;
        mode.videoMbps = bitrateByHeight[height] || (height < 720 ? 0.8 : height < 1080 ? 1.8 : 3.5);
        createPanel();
        render();

        try {
            const result = await send('createYouTubeAudioSession', { url: location.href });
            if (!isCurrent(generation)) {
                if (result?.data?.session_id) await send('closeYouTubeAudioSession', { sessionId: result.data.session_id });
                return false;
            }
            if (!result?.success || !result.data?.session_id || !result.data?.stream_url) {
                throw new Error(result?.error || 'تعذر تجهيز بث الصوت. تأكد أن Ledo Desktop يعمل.');
            }

            mode.sessionId = result.data.session_id;
            mode.audioMbps = Math.max(0.032, Number(result.data.audio_bitrate_kbps) / 1000 || 0.128);
            const blocked = await send('startYouTubeAudioTrafficTracking', {
                sessionId: mode.sessionId,
                videoItags: result.data.video_itags
            });
            if (!isCurrent(generation)) {
                await releaseSession(true);
                return false;
            }
            if (!blocked?.success) throw new Error(blocked?.error || 'تعذر إيقاف تنزيل مسارات الفيديو.');
            mode.tracking = true;

            mode.video.pause();
            const panel = createPanel();
            panel?.querySelector('.ledo-radio-title') && (panel.querySelector('.ledo-radio-title').textContent = result.data.title || 'YouTube audio');
            render();
            const playback = await send('startYouTubeAudioPlayback', {
                sessionId: mode.sessionId,
                currentTime: mode.originalTime,
                volume: mode.volume,
                muted: mode.muted,
                playbackRate: mode.rate
            });
            if (!playback?.success) throw new Error(playback?.error || 'تعذر بدء مشغّل الصوت.');
            if (!isCurrent(generation)) return false;
            if (playback.state) applyPlaybackState(playback.state);
            if (mode.remoteState?.error) throw new Error(mode.remoteState.error);
            mode.phase = 'playing';
            mode.stats.sessions += 1;
            mode.stats.lastVideoId = mode.videoId;
            mode.stats.updatedAt = Date.now();
            chrome.storage.local.set({ ledo_audio_focus_enabled: true });
            persistStats();
            render(mode.remoteState?.paused ? 'اضغط تشغيل لبدء الاستماع.' : 'الصوت يعمل · الفيديو متوقف لهذا التبويب');
            return true;
        } catch (error) {
            await releaseSession(true);
            mode.phase = 'idle';
            clearPanel();
            restoreVideo(mode.originalTime, mode.wasPlaying);
            clearSnapshot();
            render();
            toast(error.message || 'تعذر تشغيل LEDO Radio Mode.');
            return false;
        }
    }

    async function stop(restore) {
        if (mode.phase === 'idle' || mode.phase === 'stopping') return true;
        ++mode.generation;
        mode.phase = 'stopping';
        const resumeTime = mode.remoteState && Number.isFinite(mode.remoteState.currentTime) ? mode.remoteState.currentTime : mode.originalTime;
        render();
        let released = true;
        try {
            released = await releaseSession(true);
        } finally {
            if (restore) restoreVideo(resumeTime, mode.wasPlaying);
            chrome.storage.local.set({ ledo_audio_focus_enabled: false });
            persistStats();
            clearSnapshot();
            clearPanel();
            mode.phase = 'idle';
            render();
        }
        if (!released) toast('تعذر تحرير مسارات الفيديو. حدّث صفحة يوتيوب إذا لم يعد الفيديو للعمل.');
        return released;
    }

    async function releaseSession(close) {
        let released = true;
        const playback = await send('stopYouTubeAudioPlayback');
        if (!playback?.success) released = false;
        if (mode.tracking) {
            const result = await send('stopYouTubeAudioTrafficTracking', { sessionId: mode.sessionId });
            released = Boolean(result?.success) && released;
        }
        mode.tracking = false;
        if (close && mode.sessionId) await send('closeYouTubeAudioSession', { sessionId: mode.sessionId });
        mode.sessionId = null;
        mode.remoteState = null;
        return released;
    }

    function isCurrent(generation) {
        return generation === mode.generation && mode.phase === 'preparing' && mode.videoId === currentId();
    }

    function restoreVideo(time, shouldPlay) {
        if (!mode.video?.isConnected) return;
        try { mode.video.currentTime = Math.max(0, Number(time) || 0); } catch (_) { /* YouTube may still be replacing its media source. */ }
        if (shouldPlay) mode.video.play().catch(() => {});
    }

    function clearSnapshot() {
        mode.video = null;
        mode.videoId = null;
        mode.originalTime = 0;
        mode.wasPlaying = false;
    }

    function clearPanel() {
        player()?.classList.remove('ledo-radio-active');
        player()?.querySelector('.ledo-radio-panel')?.remove();
    }

    function applyPlaybackState(state) {
        if (!state || typeof state !== 'object') return;
        if (state.error && mode.phase === 'playing') {
            stop(true).then(() => toast('انقطع بث الصوت. رجّعنا تشغيل الفيديو؛ جرّب Radio Mode مرة أخرى.'));
            return;
        }
        const previous = mode.remoteState;
        mode.remoteState = state;
        if (mode.phase === 'playing' && previous && !state.paused && !state.ended) {
            const elapsed = Number(state.currentTime) - Number(previous.currentTime);
            if (elapsed > 0 && elapsed < 5) {
                mode.stats.seconds += elapsed;
                mode.stats.estimatedAvoidedBytes += Math.max(0, mode.videoMbps - mode.audioMbps) * 125000 * elapsed;
            }
            if (Date.now() - (mode.stats.updatedAt || 0) > 10000) persistStats();
        }
        render(state.ended ? 'انتهى الفيديو الصوتي.' : state.paused ? 'الصوت متوقف مؤقتاً.' : 'الصوت يعمل · الفيديو متوقف لهذا التبويب');
    }

    function persistStats() {
        mode.stats.updatedAt = Date.now();
        chrome.storage.local.set({ [STATS_KEY]: mode.stats });
    }

    function toast(message) {
        let node = document.getElementById('ledo-audio-focus-toast');
        if (!node) {
            node = document.createElement('div');
            node.id = 'ledo-audio-focus-toast';
            node.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:20px;transform:translateX(-50%);padding:11px 16px;border-radius:10px;background:#17152a;color:#fff;border:1px solid #8b5cf6;font:13px system-ui;box-shadow:0 8px 24px #0008';
            document.documentElement.appendChild(node);
        }
        node.textContent = message;
        setTimeout(() => node.remove(), 4500);
    }

    const observer = new MutationObserver(install);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('yt-navigate-finish', () => {
        if (mode.phase !== 'idle') stop(false);
        clearPanel();
        install();
    });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.action === 'radioAudioState') {
            applyPlaybackState(message.state);
            return false;
        }
        if (message?.action === 'getLedoAudioFocusState') {
            sendResponse({ success: true, enabled: mode.phase === 'playing', busy: mode.phase === 'preparing' || mode.phase === 'stopping', phase: mode.phase });
            return false;
        }
        if (message?.action !== 'toggleLedoAudioFocus') return false;
        const operation = mode.phase === 'playing' ? stop(true) : start();
        operation.then(success => sendResponse({ success, enabled: mode.phase === 'playing', error: success ? undefined : 'تعذر تشغيل Radio Mode.' }));
        return true;
    });
    window.addEventListener('pagehide', () => {
        persistStats();
        send('stopYouTubeAudioPlayback');
        if (mode.tracking) send('stopYouTubeAudioTrafficTracking', { sessionId: mode.sessionId });
        if (mode.sessionId) send('closeYouTubeAudioSession', { sessionId: mode.sessionId });
    });
    setInterval(install, 1200);
})();
