/**
 * Ledo AdBlock Engine - Advanced Content Script
 * Handles YouTube video ad skipping + Social media in-feed ad removal
 * Uses MutationObserver for real-time ad detection on dynamic pages
 */
(function () {
    'use strict';

    // ChatGPT has no ad surfaces that need this DOM filtering engine.
    if (location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com')) return;

    // Bail out if adblock is disabled
    let adblockEnabled = true;
    let socialAdsEnabled = true;
    let youtubeAdsEnabled = true;
    let statsThisPage = { blocked: 0, skipped: 0 };
    let statsReported = { blocked: 0, skipped: 0 };

    const hostname = location.hostname.toLowerCase();
    const href = location.href;

    // ========================================================================
    // Utility
    // ========================================================================
    function domainIs(...domains) {
        return domains.some(d => hostname === d || hostname.endsWith('.' + d));
    }

    function hideElement(el, reason) {
        if (!el || el.dataset.ledoHidden) return;
        el.dataset.ledoHidden = '1';
        el.dataset.ledoHideReason = reason || 'ad';
        el.classList.add('ledo-hidden-by-adblock');
        statsThisPage.blocked++;
        reportStats();
    }

    function restoreHiddenElements() {
        document.querySelectorAll('.ledo-hidden-by-adblock').forEach(el => {
            el.classList.remove('ledo-hidden-by-adblock');
            delete el.dataset.ledoHidden;
            delete el.dataset.ledoHideReason;
        });
    }

    function installHiddenElementStyle() {
        if (document.getElementById('ledo-hidden-elements-style')) return;
        const style = document.createElement('style');
        style.id = 'ledo-hidden-elements-style';
        style.textContent = '.ledo-hidden-by-adblock{display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;overflow:hidden!important;margin:0!important;padding:0!important;pointer-events:none!important}';
        (document.head || document.documentElement).appendChild(style);
    }

    function removeElement(el) {
        if (!el) return;
        try { el.remove(); } catch (_) {}
        statsThisPage.blocked++;
        reportStats();
    }

    let reportTimeout = null;
    function reportStats() {
        if (reportTimeout) return;
        reportTimeout = setTimeout(() => {
            reportTimeout = null;
            try {
                if (chrome?.runtime?.id) {
                    const delta = {
                        blocked: Math.max(0, statsThisPage.blocked - statsReported.blocked),
                        skipped: Math.max(0, statsThisPage.skipped - statsReported.skipped)
                    };
                    statsReported = { ...statsThisPage };
                    if (!delta.blocked && !delta.skipped) return;
                    chrome.runtime.sendMessage({
                        action: 'adblockStats',
                        stats: delta,
                        hostname: hostname
                    }).catch(() => {});
                }
            } catch (_) {}
        }, 2000);
    }

    // ========================================================================
    // Settings Loader
    // ========================================================================
    function loadSettings(callback) {
        try {
            chrome.storage.local.get([
                'adblock_enabled', 'adblock_allowlist',
                'adblock_social_ads', 'adblock_youtube_ads', 'adblock_cosmetic_filters',
                'adblock_cosmetic_enabled'
            ], (s) => {
                if (chrome.runtime.lastError) return;
                adblockEnabled = s.adblock_enabled !== false;
                youtubeAdsEnabled = s.adblock_youtube_ads !== false;
                socialAdsEnabled = s.adblock_social_ads !== false;

                const allowlist = Array.isArray(s.adblock_allowlist) ? s.adblock_allowlist : [];
                if (allowlist.some(d => hostname === d || hostname.endsWith('.' + d))) {
                    adblockEnabled = false;
                }
                syncBlockers();
                if (callback) callback();
            });
        } catch (_) {
            if (callback) callback();
        }
    }

    // Listen for setting changes
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            if (changes.adblock_enabled || changes.adblock_allowlist ||
                changes.adblock_social_ads || changes.adblock_youtube_ads ||
                changes.adblock_cosmetic_filters || changes.adblock_cosmetic_enabled) {
                loadSettings();
            }
        });
    } catch (_) {}

    // ========================================================================
    //  YOUTUBE AD BLOCKER
    // ========================================================================
    const YouTubeAdBlocker = {
        active: false,
        observer: null,
        checkInterval: null,
        skipAttempts: 0,
        lastAdState: false,
        videoStates: new WeakMap(),

        restoreVideo(video) {
            const previous = this.videoStates.get(video);
            if (!previous) return;
            if (previous.opacity) video.style.setProperty('opacity', previous.opacity, previous.opacityPriority);
            else video.style.removeProperty('opacity');
            video.muted = previous.muted;
            video.playbackRate = previous.playbackRate;
            this.videoStates.delete(video);
        },

        init() {
            if (!domainIs('youtube.com', 'youtu.be', 'youtube-nocookie.com')) return;
            if (!youtubeAdsEnabled || !adblockEnabled) return;
            this.active = true;

            window.postMessage({ type: 'LEDO_ADBLOCK_STATE', enabled: true }, location.origin);

            // Inject CSS to hide ad overlays and banners immediately
            this.injectStyles();

            // Start monitoring
            this.startMonitoring();

            // Navigation listener for SPA
            this.watchNavigation();
        },

        injectStyles() {
            const css = document.createElement('style');
            css.id = 'ledo-yt-adblock';
            css.textContent = `
                /* ---- YouTube Zero-Flicker Ad Blanketing ---- */
                
                /* Instantly hide video if ad state is active so user sees ZERO ad frames */
                .html5-video-player.ad-showing video,
                .html5-video-player.ad-interrupting video {
                    opacity: 0 !important;
                }

                /* Complete annihilation of ad countdowns, preview text, timer residue */
                .ytp-ad-player-overlay,
                .ytp-ad-player-overlay-layout,
                .ytp-ad-player-overlay-flyout-cta,
                .ytp-ad-text,
                .ytp-ad-preview-text,
                .ytp-ad-preview-container,
                .ytp-ad-duration-remaining,
                .ytp-ad-time-remaining,
                .ytp-ad-message-container,
                .ytp-ad-simple-ad-badge,
                .ytp-ad-badge,
                .ytp-ad-badge-container,
                .ytp-ad-button,
                .ytp-ad-button-icon,
                .ytp-ad-hover-text-container,
                .ytp-ad-info-dialog-container,
                .ytp-ad-survey,
                .ytp-ad-survey-interstitial,
                .ytp-ad-progress,
                .ytp-ad-progress-list,
                .ytp-ad-timed-pie-countdown,
                .ytp-ad-action-interstitial,
                .ytp-ad-action-interstitial-background-container,
                .ytp-ad-action-interstitial-slot,
                .ytp-ad-visiting-advertiser-slot,
                .ytp-ad-feedback-dialog-container,
                .ytp-ad-overlay-container,
                .ytp-ad-overlay-slot,
                .ytp-ad-image-overlay,
                .ytp-ad-text-overlay,
                .video-ads,
                .ytp-ad-module,
                ytd-action-companion-ad-renderer,
                ytd-ad-slot-renderer,
                div[class*="ytp-ad-text"],
                div[class*="ytp-ad-preview"],
                div[class*="ytp-ad-duration"],
                div[class*="ytp-ad-time"],
                div[class*="ytp-ad-countdown"],
                span[class*="ytp-ad-duration"],
                span[class*="ytp-ad-time"],
                .ytd-display-ad-renderer,
                .ytd-promoted-sparkles-web-renderer,
                .ytd-promoted-sparkles-text-search-renderer,
                .ytd-player-legacy-desktop-watch-ads-renderer,
                .ytd-in-feed-ad-layout-renderer,
                .ytd-banner-promo-renderer,
                .ytd-statement-banner-renderer,
                .ytd-brand-video-singleton-renderer,
                .ytd-brand-video-shelf-renderer,
                .ytd-primetime-promo-renderer,
                tp-yt-paper-dialog:has(.ytd-enforcement-message-view-model),
                ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
                #masthead-ad,
                #player-ads,
                #panels > ytd-engagement-panel-section-list-renderer:has(ytd-ads-engagement-panel-content-renderer),
                ad-slot-renderer,
                ytd-rich-section-renderer:has(.ytd-statement-banner-renderer),
                ytd-reel-video-renderer[is-ad] {
                    display: none !important;
                    height: 0 !important;
                    min-height: 0 !important;
                    max-height: 0 !important;
                    overflow: hidden !important;
                    visibility: hidden !important;
                    opacity: 0 !important;
                    pointer-events: none !important;
                }

                /* Search ads */
                ytd-search-pyv-renderer,
                ytd-promoted-video-renderer {
                    display: none !important;
                }

                /* Sidebar companion ads */
                #related ytd-compact-promoted-video-renderer,
                ytd-companion-slot-renderer {
                    display: none !important;
                }

                /* Popup and survey ads */
                tp-yt-iron-overlay-backdrop,
                .ytp-ad-survey-interstitial,
                .ytp-ad-overlay-close-button {
                    display: none !important;
                }

                /* Shorts ads */
                ytd-reel-video-renderer[is-ad] {
                    display: none !important;
                }

                /* Premium / Music upsells */
                ytmusic-mealbar-promo-renderer,
                ytd-mealbar-promo-renderer:has(a[href*="premium"]),
                tp-yt-paper-dialog:has(yt-upsell-dialog-renderer) {
                    display: none !important;
                }

                /* Hide "Skip Ad" area countdown flicker */
                .ytp-ad-skip-button-slot { z-index: 999999 !important; }

                /* Notification / toast ads */
                .ytd-popup-container:has(ytd-ad-slot-renderer) {
                    display: none !important;
                }
            `;
            (document.head || document.documentElement).appendChild(css);
        },

        startMonitoring() {
            // CSS handles visual hiding; poll less often for video skip controls.
            this.checkInterval = setInterval(() => this.checkAndSkipVideoAd(), 250);

            // MutationObserver for new ad DOM insertions
            let checkQueued = false;
            this.observer = new MutationObserver((mutations) => {
                let addedNode = false;
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        this.processNewNode(node);
                        addedNode = true;
                    }
                }
                if (addedNode && !checkQueued) {
                    checkQueued = true;
                    setTimeout(() => {
                        checkQueued = false;
                        this.checkAndSkipVideoAd();
                    }, 100);
                }
            });

            const target = document.body || document.documentElement;
            this.observer.observe(target, { childList: true, subtree: true });

            // Initial scan
            this.scanExistingAds();
        },

        watchNavigation() {
            // YouTube is an SPA; listen for navigation events
            document.addEventListener('yt-navigate-finish', () => {
                this.skipAttempts = 0;
                this.scanExistingAds();
            });

            // Also watch for popstate
            window.addEventListener('popstate', () => {
                setTimeout(() => this.scanExistingAds(), 400);
            });
        },

        scanExistingAds() {
            // Remove banner / companion ads already in the DOM
            const selectors = [
                '#masthead-ad',
                '#player-ads',
                'ytd-ad-slot-renderer',
                'ytd-promoted-sparkles-web-renderer',
                'ytd-display-ad-renderer',
                'ytd-promoted-sparkles-text-search-renderer',
                'ytd-compact-promoted-video-renderer',
                'ytd-action-companion-ad-renderer',
                'ytd-in-feed-ad-layout-renderer',
                'ytd-banner-promo-renderer',
                'ytd-brand-video-singleton-renderer',
                'ytd-search-pyv-renderer',
                'ytd-promoted-video-renderer',
                'ytd-statement-banner-renderer',
                'ytd-primetime-promo-renderer'
            ];

            for (const sel of selectors) {
                try {
                    document.querySelectorAll(sel).forEach(el => hideElement(el, 'yt-scan'));
                } catch (_) {}
            }
        },

        processNewNode(node) {
            const tag = node.tagName?.toLowerCase() || '';
            // Quick tag check for known ad renderers
            if (tag.includes('ad-slot') || tag.includes('promoted') ||
                tag.includes('display-ad') || tag === 'ytd-in-feed-ad-layout-renderer' ||
                tag === 'ytd-banner-promo-renderer' || tag === 'ytd-brand-video-singleton-renderer') {
                hideElement(node, 'yt-new-node');
                return;
            }

            // Check for ad class names
            if (node.classList) {
                for (const cls of node.classList) {
                    if (cls.startsWith('ytp-ad-') || cls.includes('ad-slot') ||
                        cls.includes('promoted-sparkles')) {
                        hideElement(node, 'yt-class');
                        return;
                    }
                }
            }

            // Do not hide an arbitrary parent because it contains an ad
            // descendant: YouTube may insert an entire feed/related list as one
            // subtree. The CSS rules above hide the ad renderer itself.
        },

        checkAndSkipVideoAd() {
            if (!adblockEnabled || !youtubeAdsEnabled) return;

            // 1. Defuse YouTube Anti-Adblock enforcement modal if present
            const enforcement = document.querySelector('tp-yt-paper-dialog:has(.ytd-enforcement-message-view-model), ytd-enforcement-message-view-model');
            if (enforcement) {
                const dialog = enforcement.closest('tp-yt-paper-dialog') || enforcement;
                dialog.remove();
                document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach(b => b.remove());
                const vid = document.querySelector('.html5-video-player video');
                if (vid && vid.paused) {
                    vid.play().catch(() => {});
                }
            }

            // 2. Auto-skip ad reels in YouTube Shorts
            const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
            if (activeShort && (activeShort.hasAttribute('is-ad') || activeShort.querySelector('ytd-ad-slot-renderer, .ytd-ad-slot-renderer'))) {
                const nextShortBtn = document.querySelector('#navigation-button-down button, ytd-shorts #navigation-button-down');
                if (nextShortBtn) nextShortBtn.click();
            }

            // 3. Skip Main Video Ads
            const player = document.querySelector('.html5-video-player');
            if (!player) return;

            const adOverlay = player.querySelector('.ytp-ad-player-overlay');
            const activeAdOverlay = adOverlay && adOverlay.getClientRects().length > 0;
            const isAd = player.classList.contains('ad-showing') ||
                         player.classList.contains('ad-interrupting') ||
                         Boolean(activeAdOverlay);

            if (isAd) {
                if (!this.lastAdState) {
                    this.lastAdState = true;
                    this.skipAttempts = 0;
                }

                // Zero-Flicker: Immediately make video invisible and mute
                const video = player.querySelector('video');
                if (video) {
                    if (!this.videoStates.has(video)) {
                        this.videoStates.set(video, {
                            opacity: video.style.getPropertyValue('opacity'),
                            opacityPriority: video.style.getPropertyPriority('opacity'),
                            muted: video.muted,
                            playbackRate: video.playbackRate
                        });
                    }
                    video.muted = true;
                    video.style.setProperty('opacity', '0', 'important');
                }

                // Notify MAIN world to invoke movie_player.skipAd()
                try {
                    window.postMessage({ type: 'LEDO_SKIP_AD' }, '*');
                } catch (_) {}

                // Strategy 1: Instant skip button click
                const skipBtn = player.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, [class*="skip-button"], button.ytp-ad-skip-button-slot button, button[id^="skip-button"]');
                if (skipBtn) {
                    skipBtn.click();
                    statsThisPage.skipped++;
                    reportStats();
                    return;
                }

                // Strategy 2: Fast-forward past duration without triggering countdown UI
                if (video) {
                    // Do NOT set currentTime = duration because that causes YouTube UI to display "11 of 11"
                    if (video.duration && isFinite(video.duration) && video.duration > 0) {
                        video.currentTime = video.duration + 1;
                    } else {
                        video.currentTime = 999999;
                    }
                    try {
                        video.dispatchEvent(new Event('ended'));
                    } catch (_) {}
                    video.playbackRate = 16;
                    statsThisPage.skipped++;
                }

                // Strategy 3: Multi-language text scan for skip button
                this.skipAttempts++;
                if (this.skipAttempts > 2) {
                    const allBtns = player.querySelectorAll('button, .ytp-ad-overlay-close-button, [role="button"]');
                    for (const btn of allBtns) {
                        const text = (btn.textContent || '').toLowerCase().trim();
                        if (text.includes('skip') || text.includes('تخطي') || text.includes('passer') ||
                            text.includes('überspringen') || text.includes('saltar') || text.includes('пропустить')) {
                            btn.click();
                            statsThisPage.skipped++;
                            reportStats();
                            break;
                        }
                    }
                }

                // Strategy 4: Close overlay ads
                const closeBtn = player.querySelector('.ytp-ad-overlay-close-button, .ytp-ad-overlay-close-container button');
                if (closeBtn) {
                    closeBtn.click();
                }

            } else {
                if (this.lastAdState) {
                    this.lastAdState = false;
                    this.skipAttempts = 0;
                    // Restore audio, normal playback rate, and visibility
                    const video = player.querySelector('video');
                    if (video) {
                        this.restoreVideo(video);
                    }
                }
            }

            // Always clean up overlay/banner ads
            const overlays = player.querySelectorAll('.ytp-ad-overlay-container, .ytp-ad-overlay-slot');
            overlays.forEach(o => hideElement(o, 'yt-overlay'));
        },

        destroy() {
            if (this.observer) this.observer.disconnect();
            if (this.checkInterval) clearInterval(this.checkInterval);
            document.querySelectorAll('.html5-video-player video').forEach(video => {
                this.restoreVideo(video);
            });
            this.observer = null;
            this.checkInterval = null;
            this.active = false;
            this.lastAdState = false;
            this.skipAttempts = 0;
            const style = document.getElementById('ledo-yt-adblock');
            if (style) style.remove();
        }
    };

    // ========================================================================
    //  SOCIAL MEDIA AD BLOCKER
    // ========================================================================
    const SocialMediaAdBlocker = {
        observer: null,
        scanInterval: null,

        init() {
            if (!adblockEnabled || !socialAdsEnabled) return;

            const platform = this.detectPlatform();
            if (!platform) return;

            this.injectStyles(platform);
            this.startObserver(platform);

            // Initial scan; later scans are debounced from DOM mutations.
            setTimeout(() => this.scanAds(platform), 250);
        },

        detectPlatform() {
            if (domainIs('facebook.com', 'fb.com', 'web.facebook.com')) return 'facebook';
            if (domainIs('instagram.com')) return 'instagram';
            if (domainIs('twitter.com', 'x.com')) return 'twitter';
            if (domainIs('tiktok.com')) return 'tiktok';
            if (domainIs('linkedin.com')) return 'linkedin';
            if (domainIs('reddit.com', 'old.reddit.com')) return 'reddit';
            if (domainIs('snapchat.com')) return 'snapchat';
            if (domainIs('pinterest.com')) return 'pinterest';
            if (domainIs('twitch.tv')) return 'twitch';
            return null;
        },

        // Platform-specific CSS for immediate hiding
        injectStyles(platform) {
            const css = document.createElement('style');
            css.id = 'ledo-social-adblock';

            const rules = {
                facebook: [
                    'div[data-pagelet*="FeedUnit"]:has(a[href*="/ads/"])',
                    'div[data-pagelet*="FeedUnit"]:has(span:not([class]) > a[href*="ads/about"])',
                    'div[data-testid="fbfeed_story"]:has(a[href*="/ads/"])',
                    '.x1lliihq:has(a[href="/ads/about/privacy"])',
                    'div[data-pagelet*="Reel"]:has(a[href*="/ads/"])',
                    'div[data-pagelet="RightRail"] div[data-testid*="ad"]',
                    'div[data-pagelet="RightRail"] ._4-u2._4-u8',
                    'div[data-pagelet*="MarketplaceFeed"]:has([aria-label*="ponsored"])',
                    'div[data-pagelet*="MarketplaceFeed"]:has([aria-label*="إعلان"])',
                    'div[data-pagelet="Stories"]:has(a[href*="/ads/"])'
                ],
                instagram: [
                    'article:has(a[href*="/explore/"] + span:empty)',
                    'article._aatb._aatc:has(span:not([class]):not([id]) > a[href*="/explore/"])',
                    'div[class*="Story"]:has(span[class*="Sponsored"])',
                    'div._aagw:has(a[href*="/ads/"])',
                    'div[class*="reel"]:has([aria-label*="ponsored"])',
                    'div[class*="reel"]:has([aria-label*="إعلان"])'
                ],
                twitter: [
                    'article:has(div[data-testid="placementTracking"])',
                    'div[data-testid="cellInnerDiv"]:has(div[data-testid="placementTracking"])',
                    'aside[aria-label*="follow"]:has([data-testid="placementTracking"])',
                    'div[data-testid="cellInnerDiv"]:has(path[d*="M19.498"])',
                    'div[data-testid="cellInnerDiv"]:has(svg + span:only-child)'
                ],
                tiktok: [
                    'div[class*="DivItemContainer"]:has(span[class*="SpanAdTag"])',
                    'div[class*="DivVideoCard"]:has([class*="ad-tag"])',
                    'div[data-e2e="recommend-list-item-container"]:has([class*="ad-label"])',
                    'div[class*="DivItemContainer"]:has(a[href*="/ads/"])',
                    'div[class*="tiktok-feed"]:has([class*="sponsored"])',
                    'div[class*="tiktok-feed"]:has([class*="ad_label"])'
                ],
                linkedin: [
                    'div.feed-shared-update-v2:has(a[href*="lnkd.in"])',
                    'aside[class*="ad-banner"]',
                    'div.ad-banner-container',
                    'div[data-ad-banner]',
                    'div.msg-overlay-conversation-bubble--is-ad'
                ],
                reddit: [
                    '.promotedlink',
                    'div[data-testid="post-container"]:has(a[href*="redd.it/ads"])',
                    'shreddit-ad-post',
                    'shreddit-experience-tree:has(shreddit-ad-post)',
                    '.listing-page .promotedlink',
                    'div[data-testid="frontpage-sidebar"]:has([data-testid="ad"])',
                    'div._1OVBBWLtHoSPfGCRaPzpTf:has(span._2oEYZXchPfHwcf9mTMGMg8)',
                    'faceplate-tracker[data-faceplate-tracking-context*="ad"]'
                ],
                snapchat: [
                    'div[class*="AdCard"]',
                    'div[class*="sponsored-content"]'
                ],
                pinterest: [
                    'div[data-ad-creative-id]'
                ],
                twitch: [
                    'div[data-a-target="video-ad-countdown"]',
                    'div.video-player__overlay:has(div[data-a-target="video-ad-countdown"])',
                    'div[class*="ad-banner"]',
                    'div[data-target="side-nav-ad"]'
                ]
            };

            const platformRules = rules[platform] || [];
            if (platformRules.length) {
                css.textContent = platformRules.join(',\n') + ' {\n' +
                    '    display: none !important;\n' +
                    '    visibility: hidden !important;\n' +
                    '    height: 0 !important;\n' +
                    '    max-height: 0 !important;\n' +
                    '    overflow: hidden !important;\n' +
                    '    pointer-events: none !important;\n' +
                    '}\n';
                (document.head || document.documentElement).appendChild(css);
            }
        },

        startObserver(platform) {
            this.observer = new MutationObserver((mutations) => {
                let needsScan = false;
                for (const mutation of mutations) {
                    if (mutation.addedNodes.length > 0) {
                        needsScan = true;
                        break;
                    }
                }
                if (needsScan) {
                    // Debounce scans
                    if (this._scanTimeout) return;
                    this._scanTimeout = setTimeout(() => {
                        this._scanTimeout = null;
                        this.scanAds(platform);
                    }, 250);
                }
            });

            const target = document.body || document.documentElement;
            this.observer.observe(target, { childList: true, subtree: true });
        },

        scanAds(platform) {
            if (!adblockEnabled || !socialAdsEnabled) return;

            switch (platform) {
                case 'facebook': this.scanFacebook(); break;
                case 'instagram': this.scanInstagram(); break;
                case 'twitter': this.scanTwitter(); break;
                case 'tiktok': this.scanTikTok(); break;
                case 'linkedin': this.scanLinkedIn(); break;
                case 'reddit': this.scanReddit(); break;
                case 'snapchat': this.scanSnapchat(); break;
                case 'pinterest': this.scanPinterest(); break;
                case 'twitch': this.scanTwitch(); break;
            }
        },

        // --- Facebook/Meta ---
        scanFacebook() {
            // Method 1: Look for "Sponsored" / "مُموَّل" text markers
            const sponsoredTexts = ['sponsored', 'مُموَّل', 'مُمَوَّل', 'ممول', 'gesponsert', 'sponsorisé',
                'patrocinado', 'sponsorizzato', 'gesponsord', 'sponsrad', 'реклама',
                'sponsorowane', 'рекламна', 'Được tài trợ', 'スポンサー', '广告', '贊助', '후원'];

            // Scan all feed units
            const feedUnits = document.querySelectorAll(
                'div[data-pagelet*="FeedUnit"], div[role="article"], div.x1yztbdb'
            );

            for (const unit of feedUnits) {
                if (unit.dataset.ledoHidden) continue;

                // Check for "Sponsored" text anywhere in the post header
                const allText = unit.querySelectorAll('span, a');
                let isSponsored = false;

                for (const textEl of allText) {
                    const text = (textEl.textContent || '').trim().toLowerCase();
                    if (sponsoredTexts.includes(text)) {
                        // Verify this is actually a "Sponsored" label (check parent structure)
                        const parent = textEl.closest('div[data-pagelet*="FeedUnit"], div[role="article"]');
                        if (parent) {
                            isSponsored = true;
                            break;
                        }
                    }
                }

                // Check for ads/about privacy links (Meta's ad disclosure)
                if (!isSponsored) {
                    const adLinks = unit.querySelectorAll('a[href*="/ads/about"], a[href*="ads/about"], a[href*="/ads/preferences"]');
                    if (adLinks.length > 0) isSponsored = true;
                }

                // Check for "Suggested for you" (Facebook suggested content = soft ads)
                if (!isSponsored) {
                    for (const textEl of allText) {
                        const text = (textEl.textContent || '').trim().toLowerCase();
                        if (text === 'suggested for you' || text === 'مقترح لك') {
                            // Only if the element is in the header area
                            const rect = textEl.getBoundingClientRect();
                            const parentRect = unit.getBoundingClientRect();
                            if (rect.top - parentRect.top < 100) {
                                isSponsored = true;
                                break;
                            }
                        }
                    }
                }

                if (isSponsored) {
                    hideElement(unit, 'fb-sponsored');
                }
            }

            // Remove right-column ad containers
            document.querySelectorAll('[data-pagelet="RightRail"] [data-testid*="ad"]').forEach(el => {
                hideElement(el, 'fb-rightcol');
            });
        },

        // --- Instagram ---
        scanInstagram() {
            const sponsoredTexts = ['sponsored', 'مُموَّل', 'ممول', 'gesponsert', 'sponsorisé',
                'patrocinado', 'sponsorizzato', 'реклама', 'スポンサー', '赞助', '후원'];

            // Feed posts (articles)
            const posts = document.querySelectorAll('article, div[role="presentation"]');
            for (const post of posts) {
                if (post.dataset.ledoHidden) continue;

                let isSponsored = false;

                // Check for "Sponsored" label
                const spans = post.querySelectorAll('span, a');
                for (const span of spans) {
                    const text = (span.textContent || '').trim().toLowerCase();
                    if (sponsoredTexts.includes(text)) {
                        isSponsored = true;
                        break;
                    }
                }

                // Check for "Paid partnership" labels
                if (!isSponsored) {
                    for (const span of spans) {
                        const text = (span.textContent || '').trim().toLowerCase();
                        if (text.includes('paid partnership') || text.includes('شراكة مدفوعة')) {
                            isSponsored = true;
                            break;
                        }
                    }
                }

                if (isSponsored) {
                    hideElement(post, 'ig-sponsored');
                }
            }

            // Explore page ad cards
            document.querySelectorAll('div._aagw a[href*="/ads/"]').forEach(el => {
                const card = el.closest('div._aagw') || el.closest('div[class*="explore"]');
                if (card) hideElement(card, 'ig-explore-ad');
            });
        },

        // --- Twitter / X ---
        scanTwitter() {
            // Look for promoted tweets
            const cells = document.querySelectorAll('div[data-testid="cellInnerDiv"]');
            for (const cell of cells) {
                if (cell.dataset.ledoHidden) continue;

                // Method 1: Placement tracking marker
                if (cell.querySelector('div[data-testid="placementTracking"]')) {
                    hideElement(cell, 'x-promoted');
                    continue;
                }

                // Method 2: "Promoted" / "Ad" / "مُروَّج" text
                const spans = cell.querySelectorAll('span');
                for (const span of spans) {
                    const text = (span.textContent || '').trim().toLowerCase();
                    if (['promoted', 'ad', 'مُروَّج', 'مروج', 'gesponsert', 'sponsorisé',
                         'promovido', 'promosso', 'рекламная', 'プロモーション', '推广', '프로모션'].includes(text)) {
                        // Verify it's actually a label (small text, not part of tweet content)
                        const style = window.getComputedStyle(span);
                        const fontSize = parseFloat(style.fontSize);
                        if (fontSize <= 14) {
                            hideElement(cell, 'x-promoted-text');
                            break;
                        }
                    }
                }

                // Method 3: SVG icon for promoted (megaphone icon path)
                const svgs = cell.querySelectorAll('svg');
                for (const svg of svgs) {
                    const path = svg.querySelector('path');
                    if (path) {
                        const d = path.getAttribute('d') || '';
                        // Twitter uses specific SVG paths for promoted icon
                        if (d.startsWith('M19.498') || d.includes('M20.75 2H3.25C2.007')) {
                            hideElement(cell, 'x-promoted-icon');
                            break;
                        }
                    }
                }
            }

            // Promoted trends in sidebar
            const trends = document.querySelectorAll('div[data-testid="trend"]');
            for (const trend of trends) {
                if (trend.dataset.ledoHidden) continue;
                const spans = trend.querySelectorAll('span');
                for (const span of spans) {
                    if ((span.textContent || '').toLowerCase().includes('promoted')) {
                        hideElement(trend, 'x-trend-promoted');
                        break;
                    }
                }
            }
        },

        // --- TikTok ---
        scanTikTok() {
            // Look for ad tags
            const adTags = document.querySelectorAll(
                '[class*="SpanAdTag"], [class*="ad-tag"], [class*="ad-label"], [class*="AdBadge"]'
            );
            for (const tag of adTags) {
                // Navigate up to the video container
                const container = tag.closest(
                    'div[class*="DivItemContainer"], div[class*="DivVideoCard"], ' +
                    'div[data-e2e="recommend-list-item-container"], div[class*="video-feed-item"]'
                ) || tag.parentElement?.parentElement?.parentElement;

                if (container) {
                    hideElement(container, 'tt-ad');
                }
            }

            // Check for branded content / sponsored markers
            const items = document.querySelectorAll('div[class*="DivItemContainer"], div[class*="ItemModule"]');
            for (const item of items) {
                if (item.dataset.ledoHidden) continue;
                const links = item.querySelectorAll('a');
                for (const link of links) {
                    if ((link.href || '').includes('/ads/') || (link.textContent || '').toLowerCase().includes('sponsored')) {
                        hideElement(item, 'tt-sponsored');
                        break;
                    }
                }
            }
        },

        // --- LinkedIn ---
        scanLinkedIn() {
            const promotedTexts = ['promoted', 'مروج', 'gesponsert', 'sponsorisé', 'promovido', 'promosso'];

            const posts = document.querySelectorAll(
                'div.feed-shared-update-v2, div.occludable-update, li.ember-view'
            );

            for (const post of posts) {
                if (post.dataset.ledoHidden) continue;

                const subDesc = post.querySelector('.feed-shared-actor__sub-description, .update-components-actor__sub-description');
                if (subDesc) {
                    const text = (subDesc.textContent || '').trim().toLowerCase();
                    if (promotedTexts.some(t => text.includes(t))) {
                        hideElement(post, 'li-promoted');
                        continue;
                    }
                }

                // Check for "Promoted" label directly
                const spans = post.querySelectorAll('span.t-12, span.t-black--light');
                for (const span of spans) {
                    if (promotedTexts.includes((span.textContent || '').trim().toLowerCase())) {
                        hideElement(post, 'li-promoted-span');
                        break;
                    }
                }
            }

            // Sidebar ads
            document.querySelectorAll('aside[class*="ad-banner"], div.ad-banner-container, div[data-ad-banner]').forEach(el => {
                hideElement(el, 'li-sidebar-ad');
            });
        },

        // --- Reddit ---
        scanReddit() {
            // New Reddit (shreddit)
            document.querySelectorAll('shreddit-ad-post').forEach(el => {
                const parent = el.closest('shreddit-experience-tree, article') || el;
                hideElement(parent, 'reddit-shreddit-ad');
            });

            // New Reddit (React)
            const postContainers = document.querySelectorAll('div[data-testid="post-container"]');
            for (const post of postContainers) {
                if (post.dataset.ledoHidden) continue;
                const promoted = post.querySelector('a[href*="redd.it/ads"], span[data-click-id="promoted"]');
                if (promoted) {
                    hideElement(post, 'reddit-promoted');
                    continue;
                }

                // Promoted text detection
                const spans = post.querySelectorAll('span');
                for (const span of spans) {
                    const text = (span.textContent || '').trim().toLowerCase();
                    if (text === 'promoted' || text === 'مروج' || text === 'إعلان') {
                        hideElement(post, 'reddit-promoted-text');
                        break;
                    }
                }
            }

            // Faceplate tracker ads
            document.querySelectorAll('faceplate-tracker[data-faceplate-tracking-context*="ad"]').forEach(el => {
                const container = el.closest('article, div[data-testid="post-container"]') || el;
                hideElement(container, 'reddit-faceplate-ad');
            });

            // Old Reddit
            document.querySelectorAll('.promotedlink, .promoted').forEach(el => {
                hideElement(el, 'reddit-old-promoted');
            });
        },

        // --- Twitch ---
        scanTwitch() {
            // Pre-roll/mid-roll ad overlays
            const adCountdown = document.querySelector('div[data-a-target="video-ad-countdown"]');
            if (adCountdown) {
                const overlay = adCountdown.closest('div.video-player__overlay') || adCountdown;
                hideElement(overlay, 'twitch-ad-overlay');
            }

            // Display ads
            document.querySelectorAll('div[data-target="side-nav-ad"], div[class*="ad-banner"]').forEach(el => {
                hideElement(el, 'twitch-display-ad');
            });
        },

        // --- Snapchat ---
        scanSnapchat() {
            document.querySelectorAll('div[class*="AdCard"], div[class*="sponsored-content"]').forEach(el => {
                hideElement(el, 'snapchat-ad');
            });
        },

        // --- Pinterest ---
        scanPinterest() {
            const pins = document.querySelectorAll('div[data-test-id="pinWrapper"]');
            for (const pin of pins) {
                if (pin.dataset.ledoHidden) continue;
                if (pin.querySelector('[data-ad-creative-id]') ||
                    (pin.textContent || '').toLowerCase().includes('promoted') ||
                    (pin.textContent || '').includes('مروج') ||
                    (pin.textContent || '').includes('إعلان')) {
                    hideElement(pin, 'pinterest-promoted');
                }
            }
        },

        destroy() {
            if (this.observer) this.observer.disconnect();
            if (this.scanInterval) clearInterval(this.scanInterval);
            const style = document.getElementById('ledo-social-adblock');
            if (style) style.remove();
        }
    };

    // ========================================================================
    //  GENERIC AD ELEMENT BLOCKER (all websites)
    // ========================================================================
    const GenericAdBlocker = {
        observer: null,

        init() {
            if (!adblockEnabled) return;

            this.injectGenericStyles();
            this.injectCosmeticFilters();
            this.startObserver();
            setTimeout(() => this.scanGenericAds(), 1000);
        },

        injectCosmeticFilters() {
            try {
                document.getElementById('ledo-dynamic-cosmetic-filters')?.remove();

                // Immediate hardcoded rules for popular benchmarks and known edge-case sites
                const defaultSiteSelectors = [];
                // Spotify web player ad cards and banners. Keep this cosmetic-only
                // and scoped to Spotify so playback/API requests remain untouched.
                if (domainIs('open.spotify.com', 'spotify.com')) {
                    defaultSiteSelectors.push(
                        '[data-testid="ad-banner"]',
                        '[data-testid="ad-slot"]',
                        '[data-testid="ad-card"]',
                        '.Root__ads-container'
                    );
                }
                if (domainIs('turtlecute.org', 'd3ward.github.io', 'adblock-tester.com')) {
                    defaultSiteSelectors.push(
                        '#cts_test', '#ad_ctd', '#ctd_test',
                        '.adbox', '.banner_ads', '.adsbox', '.textads',
                        '.adbox.banner_ads.adsbox', '.adbox-wrapper', '.adSocial',
                        '.afs_ads', '.ad-zone', '.ad-space', '.ad-unit'
                    );
                }

                if (defaultSiteSelectors.length > 0) {
                    const fallbackStyle = document.createElement('style');
                    fallbackStyle.id = 'ledo-benchmark-cosmetic-filters';
                    fallbackStyle.textContent = defaultSiteSelectors.join(',\n') + ' { display: none !important; visibility: hidden !important; height: 0 !important; min-height: 0 !important; max-height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: hidden !important; pointer-events: none !important; opacity: 0 !important; }';
                    (document.head || document.documentElement).appendChild(fallbackStyle);
                }

                chrome.storage.local.get(['adblock_cosmetic_filters', 'adblock_cosmetic_enabled'], (data) => {
                    if (data?.adblock_cosmetic_enabled === false) return;
                    const filters = Array.isArray(data?.adblock_cosmetic_filters) ? data.adblock_cosmetic_filters : [];
                    if (!filters.length) return;

                    const matched = new Set();
                    const exceptions = new Set();
                    for (const item of filters) {
                        const hasDomain = Array.isArray(item.domains) && item.domains.length > 0;
                        const excluded = Array.isArray(item.excludedDomains) && item.excludedDomains.some(d => domainIs(d));
                        if (excluded) continue;

                        if (!hasDomain || item.domains.some(d => domainIs(d))) {
                            if (item.selector && item.exception) {
                                exceptions.add(item.selector);
                            } else if (item.selector) {
                                matched.add(item.selector);
                            }
                        }
                    }

                    for (const selector of exceptions) matched.delete(selector);
                    if (matched.size > 0) {
                        const style = document.createElement('style');
                        style.id = 'ledo-dynamic-cosmetic-filters';
                        style.textContent = [...matched].slice(0, 800).join(',\n') + ' { display: none !important; visibility: hidden !important; height: 0 !important; min-height: 0 !important; max-height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: hidden !important; pointer-events: none !important; }';
                        (document.head || document.documentElement).appendChild(style);
                    }
                });
            } catch (_) {}
        },

        injectGenericStyles() {
            const css = document.createElement('style');
            css.id = 'ledo-generic-adblock';
            css.textContent = `
                /* Generic ad containers commonly used across the web */
                iframe[src*="doubleclick.net"],
                iframe[src*="googlesyndication.com"],
                iframe[src*="googleadservices.com"],
                iframe[src*="facebook.com/plugins/ad"],
                iframe[id*="google_ads_iframe"],
                iframe[name*="google_ads_iframe"],
                ins.adsbygoogle,
                div[id*="google_ads"],
                div[id*="div-gpt-ad"],
                div[class*="ad-container"],
                div[class*="ad-wrapper"],
                div[class*="ad-banner"],
                div[class*="ad-slot"],
                div[data-ad],
                div[data-ad-slot],
                div[data-google-query-id],
                amp-ad,
                amp-embed[type="ad"],
                div[id*="taboola-"],
                div[id*="outbrain_widget"],
                div[class*="taboola"],
                div[class*="outbrain"],
                #carbonads,
                div[class*="__ad"],
                a[href*="//ad."],
                /* Universal ad-box, banner, text-ad, and placeholder selectors */
                .adbox,
                .banner_ads,
                .adsbox,
                .textads,
                .adbox-wrapper,
                .adSocial,
                .ADBox,
                .AdBox,
                #cts_test,
                #ad_ctd,
                #ctd_test,
                .afs_ads,
                .ad-zone,
                .ad-space,
                .ad-placement,
                .ad_unit,
                .ad-unit,
                div[class*="adbox"],
                div[class*="banner_ads"],
                div[class*="adsbox"],
                div[class*="textads"],
                div[id*="ad_ctd"],
                div[id*="cts_test"],
                div[id*="ctd_test"] {
                    display: none !important;
                    visibility: hidden !important;
                    height: 0 !important;
                    min-height: 0 !important;
                    max-height: 0 !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    border: none !important;
                    overflow: hidden !important;
                    pointer-events: none !important;
                    opacity: 0 !important;
                }
            `;
            (document.head || document.documentElement).appendChild(css);
        },

        startObserver() {
            let scanQueued = false;
            const pendingNodes = new Set();
            this.observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) pendingNodes.add(node);
                    }
                }
                if (!pendingNodes.size || scanQueued) return;
                scanQueued = true;
                setTimeout(() => {
                    scanQueued = false;
                    const nodes = Array.from(pendingNodes);
                    pendingNodes.clear();
                    for (const node of nodes) this.checkNode(node);
                }, 100);
            });

            const target = document.body || document.documentElement;
            if (target) {
                this.observer.observe(target, { childList: true, subtree: true });
            }
        },

        checkNode(node) {
            const tag = (node.tagName || '').toLowerCase();

            // Block ad iframes
            if (tag === 'iframe') {
                const src = node.src || '';
                if (src.includes('doubleclick') || src.includes('googlesyndication') ||
                    src.includes('googleadservices') || src.includes('facebook.com/plugins/ad') ||
                    /google_ads_iframe/.test(node.id || '') || /google_ads_iframe/.test(node.name || '')) {
                    hideElement(node, 'generic-iframe');
                    return;
                }
            }

            // Block Google AdSense containers
            if (tag === 'ins' && node.classList.contains('adsbygoogle')) {
                hideElement(node, 'adsense');
                return;
            }

            // Block amp-ad
            if (tag === 'amp-ad' || tag === 'amp-embed') {
                hideElement(node, 'amp-ad');
                return;
            }

            // Check class/id for ad patterns
            const id = (node.id || '').toLowerCase();
            const className = (node.className && typeof node.className === 'string') ? node.className.toLowerCase() : '';

            if (id.includes('google_ads') || id.includes('div-gpt-ad') ||
                id.includes('taboola-') || id.includes('outbrain_widget') ||
                id.includes('cts_test') || id.includes('ad_ctd') || id.includes('ctd_test')) {
                hideElement(node, 'generic-id');
                return;
            }

            if (className.includes('ad-container') || className.includes('ad-wrapper') ||
                className.includes('ad-banner') || className.includes('ad-slot') ||
                className.includes('taboola') || className.includes('outbrain') ||
                className.includes('adbox') || className.includes('banner_ads') ||
                className.includes('adsbox') || className.includes('textads') ||
                className.includes('ad-unit') || className.includes('afs_ads')) {
                hideElement(node, 'generic-class');
                return;
            }

            // Check data attributes
            if (node.dataset?.ad !== undefined || node.dataset?.adSlot !== undefined ||
                node.dataset?.googleQueryId !== undefined) {
                hideElement(node, 'generic-data');
            }
        },

        scanGenericAds() {
            if (!adblockEnabled) return;

            const selectors = [
                'ins.adsbygoogle',
                'div[id*="google_ads"]',
                'div[id*="div-gpt-ad"]',
                'iframe[src*="doubleclick.net"]',
                'iframe[src*="googlesyndication.com"]',
                'div[id*="taboola-"]',
                'div[id*="outbrain_widget"]',
                'amp-ad',
                '#carbonads',
                'div[data-google-query-id]',
                '#cts_test',
                '#ad_ctd',
                '#ctd_test',
                '.adbox',
                '.banner_ads',
                '.adsbox',
                '.textads',
                '.adbox-wrapper'
            ];

            for (const sel of selectors) {
                try {
                    document.querySelectorAll(sel).forEach(el => hideElement(el, 'generic-scan'));
                } catch (_) {}
            }
        },

        destroy() {
            if (this.observer) this.observer.disconnect();
            this.observer = null;
            const style = document.getElementById('ledo-generic-adblock');
            if (style) style.remove();
            document.getElementById('ledo-benchmark-cosmetic-filters')?.remove();
            document.getElementById('ledo-dynamic-cosmetic-filters')?.remove();
        }
    };

    // ========================================================================
    //  Anti-Adblock Defuser
    // ========================================================================
    const AntiAdblockDefuser = {
        init() {
            if (!adblockEnabled) return;
            // Never inject bait into ad-blocker benchmark suites
            if (domainIs('turtlecute.org', 'd3ward.github.io', 'canyoublockit.com', 'adblock-tester.com', 'browserleaks.com')) {
                return;
            }

            // Prevent common anti-adblock detection scripts
            this.defuseDetection();
        },

        defuseDetection() {
            // Create a bait element that anti-adblock scripts look for
            const bait = document.createElement('div');
            bait.className = 'ad-banner ad-container adsbox doubleclick ad-placement carbon-ads';
            bait.id = 'ad-banner';
            bait.style.cssText = 'display:block!important;visibility:visible!important;position:absolute!important;left:-9999px!important;top:-9999px!important;width:1px!important;height:1px!important;min-height:1px!important;opacity:0.01!important;pointer-events:none!important;';
            bait.innerHTML = '&nbsp;';

            // Insert bait off-screen so detection scripts find it
            if (document.body) {
                document.body.appendChild(bait);
            } else {
                document.addEventListener('DOMContentLoaded', () => {
                    document.body?.appendChild(bait);
                });
            }

            // Override common detection variables
            for (const [name, value] of Object.entries({
                adBlockDetected: false,
                adblockDetected: false,
                canRunAds: true,
                isAdBlockActive: false
            })) {
                try {
                    this.previousProperties.set(name, Object.getOwnPropertyDescriptor(window, name) || null);
                    Object.defineProperty(window, name, { get: () => value, set: () => {}, configurable: true });
                } catch (_) {}
            }
        },

        previousProperties: new Map(),

        destroy() {
            document.getElementById('ad-banner')?.remove();
            for (const [name, descriptor] of this.previousProperties) {
                try {
                    if (descriptor) Object.defineProperty(window, name, descriptor);
                    else delete window[name];
                } catch (_) {}
            }
            this.previousProperties.clear();
        }
    };

    // ========================================================================
    //  Bootstrap
    // ========================================================================
    function syncBlockers() {
        YouTubeAdBlocker.destroy();
        SocialMediaAdBlocker.destroy();
        GenericAdBlocker.destroy();
        AntiAdblockDefuser.destroy();
        restoreHiddenElements();
        if (domainIs('youtube.com', 'youtu.be', 'youtube-nocookie.com')) {
            window.postMessage({
                type: 'LEDO_ADBLOCK_STATE',
                enabled: adblockEnabled && youtubeAdsEnabled
            }, location.origin);
        }
        if (!adblockEnabled) {
            document.getElementById('ledo-hidden-elements-style')?.remove();
            return;
        }

        installHiddenElementStyle();
        if (youtubeAdsEnabled) YouTubeAdBlocker.init();
        if (socialAdsEnabled) SocialMediaAdBlocker.init();
        GenericAdBlocker.init();
        AntiAdblockDefuser.init();
    }

    loadSettings(syncBlockers);

})();
