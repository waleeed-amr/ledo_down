/**
 * Ledo Shield - YouTube Main World Defuser
 * Injected directly into the page's execution context (MAIN world)
 * Prunes ad metadata from ytInitialPlayerResponse, fetch(), and XMLHttpRequest before the player initializes.
 */
(function () {
    'use strict';

    if (window.__LEDO_YT_DEFUSER_ACTIVE__) return;
    window.__LEDO_YT_DEFUSER_ACTIVE__ = true;
    let enabled = false;
    let playerHookInterval = null;

    // ========================================================================
    // Ad Data Pruner
    // ========================================================================
    function pruneYouTubeAds(obj, returnChanged = false) {
        if (!enabled || !obj || typeof obj !== 'object') return returnChanged ? false : obj;

        try {
            let changed = false;
            // Direct ad placement metadata
            for (const key of ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams', 'adSignalsInfo', 'adParams', 'instreamAdPlayerConfig']) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    delete obj[key];
                    changed = true;
                }
            }

            // Nested player response
            if (obj.playerResponse && typeof obj.playerResponse === 'object') {
                changed = pruneYouTubeAds(obj.playerResponse, true) || changed;
            }

            // Remove ad tracking endpoints to prevent video ad tracking stalls
            if (obj.playbackTracking && typeof obj.playbackTracking === 'object') {
                const pt = obj.playbackTracking;
                for (const key of ['videostatsPlaybackUrl', 'videostatsDelayplayUrl', 'videostatsWatchtimeUrl']) {
                    if (Object.prototype.hasOwnProperty.call(pt, key)) {
                        delete pt[key];
                        changed = true;
                    }
                }
            }

            // Engagement panels (sidebar & watch-next promo cards)
            if (Array.isArray(obj.engagementPanels)) {
                const panels = obj.engagementPanels;
                const filtered = panels.filter(panel => {
                    const id = panel?.engagementPanelSectionListRenderer?.targetId || '';
                    if (id === 'engagement-panel-ads' || id.includes('ad')) return false;
                    const content = panel?.engagementPanelSectionListRenderer?.content;
                    if (content?.adsEngagementPanelContentRenderer) return false;
                    return true;
                });
                if (filtered.length !== panels.length) {
                    obj.engagementPanels = filtered;
                    changed = true;
                }
                return returnChanged ? changed : obj;
            }
            return returnChanged ? changed : obj;
        } catch (_) {}

        return returnChanged ? false : obj;
    }

    // ========================================================================
    // 1. Hook window.ytInitialPlayerResponse
    // ========================================================================
    try {
        let _ytResp = window.ytInitialPlayerResponse;
        if (_ytResp) {
            pruneYouTubeAds(_ytResp);
        }
        Object.defineProperty(window, 'ytInitialPlayerResponse', {
            get() { return _ytResp; },
            set(val) {
                _ytResp = pruneYouTubeAds(val);
            },
            configurable: true,
            enumerable: true
        });
    } catch (_) {}

    // ========================================================================
    // 2. Hook window.ytInitialData
    // ========================================================================
    try {
        let _ytData = window.ytInitialData;
        if (_ytData) {
            pruneYouTubeAds(_ytData);
        }
        Object.defineProperty(window, 'ytInitialData', {
            get() { return _ytData; },
            set(val) {
                _ytData = pruneYouTubeAds(val);
            },
            configurable: true,
            enumerable: true
        });
    } catch (_) {}

    // ========================================================================
    // 3. Hook window.fetch (Handles modern YouTube SPA navigation)
    // ========================================================================
    try {
        const origFetch = window.fetch;
        window.fetch = async function (...args) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            // Keep large browse/next/reel responses untouched. They contain
            // recommendations and are not needed for player ad metadata cleanup.
            const isPlayerOrAdReq = url.includes('/youtubei/v1/player') ||
                                    url.includes('get_midroll_info');

            const response = await origFetch.apply(this, args);
            if (!enabled || !isPlayerOrAdReq) return response;

            try {
                const clone = response.clone();
                const json = await clone.json();
                const changed = pruneYouTubeAds(json, true);
                if (!changed) return response;
                const bodyStr = JSON.stringify(json);
                return new Response(bodyStr, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                });
            } catch (_) {
                return response;
            }
        };
    } catch (_) {}

    // ========================================================================
    // 4. Hook window.XMLHttpRequest (Fallback for legacy YouTube endpoints)
    // ========================================================================
    try {
        const OrigXHR = window.XMLHttpRequest;
        const origOpen = OrigXHR.prototype.open;

        OrigXHR.prototype.open = function (method, url, ...rest) {
            this._ledoUrl = typeof url === 'string' ? url : '';
            return origOpen.apply(this, [method, url, ...rest]);
        };

        const xhrPrunedResponses = new WeakMap();
        const origResponseDesc = Object.getOwnPropertyDescriptor(OrigXHR.prototype, 'response');
        if (origResponseDesc && origResponseDesc.get) {
            Object.defineProperty(OrigXHR.prototype, 'response', {
                get() {
                    const resp = origResponseDesc.get.call(this);
                    if (!enabled || !this._ledoUrl || (!this._ledoUrl.includes('/youtubei/v1/player') && !this._ledoUrl.includes('get_midroll_info'))) {
                        return resp;
                    }
                    if (typeof resp === 'object') {
                        return pruneYouTubeAds(resp);
                    }
                    if (typeof resp === 'string') {
                        if (xhrPrunedResponses.has(this)) return xhrPrunedResponses.get(this);
                        try {
                            const parsed = JSON.parse(resp);
                            const pruned = pruneYouTubeAds(parsed, true) ? JSON.stringify(parsed) : resp;
                            xhrPrunedResponses.set(this, pruned);
                            return pruned;
                        } catch (_) {
                            return resp;
                        }
                    }
                    return resp;
                },
                configurable: true
            });
        }

        const origResponseTextDesc = Object.getOwnPropertyDescriptor(OrigXHR.prototype, 'responseText');
        if (origResponseTextDesc && origResponseTextDesc.get) {
            Object.defineProperty(OrigXHR.prototype, 'responseText', {
                get() {
                    const text = origResponseTextDesc.get.call(this);
                    if (!enabled || !this._ledoUrl || (!this._ledoUrl.includes('/youtubei/v1/player') && !this._ledoUrl.includes('get_midroll_info'))) {
                        return text;
                    }
                    try {
                        if (xhrPrunedResponses.has(this)) return xhrPrunedResponses.get(this);
                        const parsed = JSON.parse(text);
                        const pruned = pruneYouTubeAds(parsed, true) ? JSON.stringify(parsed) : text;
                        xhrPrunedResponses.set(this, pruned);
                        return pruned;
                    } catch (_) {
                        return text;
                    }
                },
                configurable: true
            });
        }
    } catch (_) {}

    // ========================================================================
    // 5. Hook JSON.parse as universal safety net
    // ========================================================================
    try {
        const origParse = JSON.parse;
        JSON.parse = function (text, reviver) {
            const res = origParse.apply(this, arguments);
            if (enabled && res && typeof res === 'object') {
                if (res.adPlacements || res.playerAds || res.adSlots) {
                    pruneYouTubeAds(res);
                }
            }
            return res;
        };
    } catch (_) {}

    // ========================================================================
    // 6. Hook YouTube Player Instance & Listen for Skip Commands
    // ========================================================================
    function hookMoviePlayer() {
        if (!enabled) return;
        const mp = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
        if (!mp || mp._ledoHooked) return;
        mp._ledoHooked = true;

        if (typeof mp.getAdState === 'function') {
            const originalGetAdState = mp.getAdState.bind(mp);
            mp.getAdState = function () {
                return enabled ? 0 : originalGetAdState();
            };
        }
    }

    window.addEventListener('message', (e) => {
        if (e.source !== window) return;
        if (e.data?.type === 'LEDO_ADBLOCK_STATE') {
            enabled = e.data.enabled === true;
            if (enabled) {
                pruneYouTubeAds(window.ytInitialPlayerResponse);
                pruneYouTubeAds(window.ytInitialData);
                hookMoviePlayer();
                if (!playerHookInterval) playerHookInterval = setInterval(hookMoviePlayer, 500);
            } else if (playerHookInterval) {
                clearInterval(playerHookInterval);
                playerHookInterval = null;
            }
        } else if (enabled && e.data?.type === 'LEDO_SKIP_AD') {
            const mp = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
            if (mp) {
                try {
                    if (typeof mp.skipAd === 'function') mp.skipAd();
                    if (typeof mp.cancelPlayback === 'function') mp.cancelPlayback();
                } catch (_) {}
            }
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', hookMoviePlayer, { once: true });
    }

})();
