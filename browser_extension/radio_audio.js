(() => {
    const audio = document.getElementById('radio-audio');
    let port = null;
    let lastStateAt = 0;

    function state() {
        return {
            currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
            duration: Number.isFinite(audio.duration) ? audio.duration : 0,
            paused: audio.paused,
            ended: audio.ended,
            volume: audio.volume,
            muted: audio.muted,
            playbackRate: audio.playbackRate,
            error: audio.error ? `Audio stream error (${audio.error.code}).` : ''
        };
    }

    function reportState(force = false) {
        const now = Date.now();
        if (!force && now - lastStateAt < 350) return;
        lastStateAt = now;
        port?.postMessage({ type: 'state', state: state() });
    }

    async function run(message) {
        switch (message.action) {
            case 'load':
                audio.pause();
                audio.src = message.streamUrl;
                audio.volume = Math.max(0, Math.min(1, Number(message.volume) || 0));
                audio.muted = Boolean(message.muted);
                audio.playbackRate = Math.max(0.25, Math.min(4, Number(message.playbackRate) || 1));
                audio.load();
                if (message.currentTime > 0) {
                    audio.addEventListener('loadedmetadata', () => {
                        if (Number.isFinite(audio.duration) && message.currentTime < audio.duration) audio.currentTime = message.currentTime;
                        audio.play().catch(() => reportState(true));
                    }, { once: true });
                } else {
                    await audio.play().catch(() => {});
                }
                reportState(true);
                return state();
            case 'play':
                await audio.play();
                reportState(true);
                return state();
            case 'pause':
                audio.pause();
                reportState(true);
                return state();
            case 'seek':
                if (!Number.isFinite(audio.duration) || !Number.isFinite(Number(message.value))) throw new Error('Audio duration is not available yet.');
                audio.currentTime = Math.max(0, Math.min(audio.duration, Number(message.value)));
                reportState(true);
                return state();
            case 'volume':
                audio.volume = Math.max(0, Math.min(1, Number(message.value) || 0));
                reportState(true);
                return state();
            case 'mute':
                audio.muted = Boolean(message.value);
                reportState(true);
                return state();
            case 'getState':
                return state();
            case 'stop':
                audio.pause();
                audio.removeAttribute('src');
                audio.load();
                reportState(true);
                return { stopped: true };
            default:
                throw new Error('Unknown radio audio command.');
        }
    }

    function connect() {
        port = chrome.runtime.connect({ name: 'ledo-radio-audio' });
        port.onMessage.addListener(message => {
            if (message?.type !== 'command' || typeof message.requestId !== 'string') return;
            run(message).then(result => {
                port?.postMessage({ type: 'response', requestId: message.requestId, success: true, result });
            }).catch(error => {
                port?.postMessage({ type: 'response', requestId: message.requestId, success: false, error: error.message });
            });
        });
        port.onDisconnect.addListener(() => {
            port = null;
            setTimeout(connect, 250);
        });
    }

    for (const event of ['play', 'pause', 'playing', 'waiting', 'ended', 'error', 'loadedmetadata', 'timeupdate', 'durationchange']) {
        audio.addEventListener(event, () => reportState(event !== 'timeupdate'));
    }
    connect();
})();
