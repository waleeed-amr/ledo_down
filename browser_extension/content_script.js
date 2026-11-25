(function() {
    // Avoid injecting downloader UI or DOM hooks into the ChatGPT application.
    if (location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com')) return;
    // Content scripts can outlive an extension reload in an already-open tab.
    // In that stale context Chrome withdraws the extension APIs; exit quietly.
    if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.storage?.local) return;

    let hoveredVideo = null;
    let hideTimeout = null;
    const ignoredVideos = new WeakSet();
    let floatingEnabled = true;
    const cosmeticStyle = document.createElement('style');
    cosmeticStyle.dataset.ledoAdBlock = 'cosmetic';
    const hostname = window.location.hostname.toLowerCase();

    function domainMatches(domain) {
        return hostname === domain || hostname.endsWith(`.${domain}`);
    }

    function refreshCosmeticFilters() {
        chrome.storage.local.get([
            'adblock_enabled', 'adblock_cosmetic_enabled',
            'adblock_allowlist', 'adblock_cosmetic_filters'
        ], settings => {
            const isAllowed = Array.isArray(settings.adblock_allowlist)
                && settings.adblock_allowlist.some(domainMatches);
            if (settings.adblock_enabled === false || settings.adblock_cosmetic_enabled === false || isAllowed) {
                cosmeticStyle.textContent = '';
                return;
            }

            const filters = Array.isArray(settings.adblock_cosmetic_filters) ? settings.adblock_cosmetic_filters : [];
            const matchesPage = filter => {
                const matchesIncluded = !filter.domains?.length || filter.domains.some(domainMatches);
                const matchesExcluded = filter.excludedDomains?.some(domainMatches);
                return matchesIncluded && !matchesExcluded;
            };
            const exceptions = new Set(filters.filter(filter => filter.exception && matchesPage(filter)).map(filter => filter.selector));
            const selectors = [...new Set(filters
                .filter(filter => !filter.exception && matchesPage(filter) && !exceptions.has(filter.selector))
                .map(filter => filter.selector))];
            cosmeticStyle.textContent = selectors.map(selector => `${selector} { display: none !important; }`).join('\n');
            if (cosmeticStyle.textContent && !cosmeticStyle.isConnected) {
                (document.head || document.documentElement).appendChild(cosmeticStyle);
            }
        });
    }

    refreshCosmeticFilters();
    chrome.storage.local.get(['floating_enabled'], result => {
        floatingEnabled = result.floating_enabled !== false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.floating_enabled) {
            floatingEnabled = changes.floating_enabled.newValue !== false;
            if (!floatingEnabled) {
                container.style.display = 'none';
                dropdown.style.display = 'none';
                hoveredVideo = null;
            }
        }
        if (changes.adblock_enabled || changes.adblock_cosmetic_enabled
            || changes.adblock_allowlist || changes.adblock_cosmetic_filters) refreshCosmeticFilters();
    });

    const container = document.createElement('div');
    container.id = 'ledo-floating-container';
    
    // Premium styling for the floating container
    container.style.position = 'absolute';
    container.style.zIndex = '2147483647';
    container.style.display = 'none';
    container.style.flexDirection = 'column';
    container.style.gap = '4px';
    container.style.fontFamily = '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif';

    const topRow = document.createElement('div');
    topRow.style.display = 'flex';
    topRow.style.alignItems = 'center';
    topRow.style.gap = '4px';

    const mainBtn = document.createElement('div');
    mainBtn.innerHTML = `
        <span aria-hidden="true" style="width:14px;height:14px;margin-right:6px;display:inline-grid;place-items:center;border-radius:4px;background:linear-gradient(135deg,#22d3ee,#2563eb);font-size:10px;font-weight:800;color:#fff;">L</span>
        <span style="font-weight: 600; font-size: 11px; letter-spacing: 0.2px;">Download ▾</span>
    `;
    
    const btnStyle = `
        background: rgba(15, 23, 42, 0.85);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: #fff;
        padding: 5px 10px;
        border-radius: 6px;
        cursor: pointer;
        box-shadow: 0 4px 15px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.1);
        display: flex;
        align-items: center;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        border: 1px solid rgba(99, 102, 241, 0.4);
    `;
    mainBtn.style.cssText = btnStyle;

    const closeBtn = document.createElement('div');
    closeBtn.innerHTML = '×';
    closeBtn.style.cssText = `
        background: rgba(15, 23, 42, 0.85);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: #fff;
        padding: 5px 8px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
        font-weight: bold;
        line-height: 1;
        box-shadow: 0 4px 15px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.1);
        border: 1px solid rgba(99, 102, 241, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
    `;
    closeBtn.addEventListener('mouseenter', () => {
        closeBtn.style.background = 'rgba(239, 68, 68, 0.8)';
        closeBtn.style.borderColor = 'rgba(239, 68, 68, 0.9)';
    });
    closeBtn.addEventListener('mouseleave', () => {
        closeBtn.style.background = 'rgba(15, 23, 42, 0.85)';
        closeBtn.style.borderColor = 'rgba(99, 102, 241, 0.4)';
    });
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (hoveredVideo) {
            ignoredVideos.add(hoveredVideo);
        }
        container.style.display = 'none';
        dropdown.style.display = 'none';
        hoveredVideo = null;
    });

    topRow.appendChild(mainBtn);
    topRow.appendChild(closeBtn);

    const dropdown = document.createElement('div');
    dropdown.style.display = 'none';
    dropdown.style.flexDirection = 'column';
    dropdown.style.background = 'rgba(15, 23, 42, 0.95)';
    dropdown.style.backdropFilter = 'blur(12px)';
    dropdown.style.borderRadius = '8px';
    dropdown.style.padding = '4px';
    dropdown.style.border = '1px solid rgba(99, 102, 241, 0.3)';
    dropdown.style.boxShadow = '0 8px 25px rgba(0,0,0,0.4)';
    dropdown.style.marginTop = '4px';

    const optionStyle = `
        padding: 8px 12px;
        color: #e2e8f0;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        border-radius: 4px;
        transition: background 0.2s;
        display: flex;
        align-items: center;
        gap: 8px;
    `;

    const optVideo = document.createElement('div');
    optVideo.innerHTML = `🎬 Video (Best Quality)`;
    optVideo.style.cssText = optionStyle;
    
    const optAudio = document.createElement('div');
    optAudio.innerHTML = `🎵 Audio Only`;
    optAudio.style.cssText = optionStyle;

    const optFile = document.createElement('div');
    optFile.innerHTML = `📄 Direct File (ZIP, EXE, etc)`;
    optFile.style.cssText = optionStyle;

    const optManual = document.createElement('div');
    optManual.innerHTML = `⚙️ Quick Add (Advanced)`;
    optManual.style.cssText = optionStyle;

    [optVideo, optAudio, optFile, optManual].forEach(opt => {
        opt.addEventListener('mouseenter', () => opt.style.background = 'rgba(99, 102, 241, 0.3)');
        opt.addEventListener('mouseleave', () => opt.style.background = 'transparent');
    });

    dropdown.appendChild(optVideo);
    dropdown.appendChild(optAudio);
    dropdown.appendChild(optFile);
    dropdown.appendChild(optManual);

    container.appendChild(topRow);
    container.appendChild(dropdown);
    document.documentElement.appendChild(container);

    // Hover logic
    container.addEventListener('mouseenter', () => {
        clearTimeout(hideTimeout);
        mainBtn.style.background = 'rgba(30, 27, 75, 0.95)';
        mainBtn.style.border = '1px solid rgba(129, 140, 248, 0.8)';
        dropdown.style.display = 'flex';
    });
    
    container.addEventListener('mouseleave', () => {
        mainBtn.style.background = 'rgba(15, 23, 42, 0.85)';
        mainBtn.style.border = '1px solid rgba(99, 102, 241, 0.4)';
        dropdown.style.display = 'none';
        hideTimeout = setTimeout(() => {
            container.style.display = 'none';
            hoveredVideo = null;
        }, 1000);
    });

    let lastMouseMove = 0;

    document.addEventListener('mousemove', (e) => {
        const now = Date.now();
        const rect = container.getBoundingClientRect();
        const isHoveringBtn = container.style.display === 'flex' && 
            (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom);
            
        let isHoveringMedia = false;
        if (hoveredVideo && document.documentElement.contains(hoveredVideo)) {
            const vRect = hoveredVideo.getBoundingClientRect();
            isHoveringMedia = (e.clientX >= vRect.left && e.clientX <= vRect.right && e.clientY >= vRect.top && e.clientY <= vRect.bottom);
        }

        if (floatingEnabled && !isHoveringBtn && !isHoveringMedia && now - lastMouseMove > 150) {
            lastMouseMove = now;
            // Check all elements under the cursor (bypasses transparent overlays)
            const elements = document.elementsFromPoint(e.clientX, e.clientY);
            const media = elements.find(el => {
                if (!el.tagName) return false;
                const tag = el.tagName.toUpperCase();
                if (['VIDEO', 'AUDIO'].includes(tag)) return true;
                if (tag === 'A' && el.href) {
                    if (el.hasAttribute('download')) return true;
                    return /\.(mp4|mp3|mkv|avi|mov|wmv|flv|webm|ogg|wav|flac|m4a|aac|zip|rar|exe|msi|iso|pdf|apk|7z|tar|gz|bz2|xz|zst|dmg|pkg|deb|rpm|jar|doc|docx|xls|xlsx|ppt|pptx|txt|rtf|csv|epub|mobi|jpg|jpeg|png|gif|webp|svg|bmp|tiff|psd|ai|eps|ttf|otf|woff|woff2|cab)(\?.*)?$/i.test(el.href);
                }
                return false;
            });
            
            if (media && !ignoredVideos.has(media)) {
                hoveredVideo = media;
                isHoveringMedia = true;
                const mRect = hoveredVideo.getBoundingClientRect();
                
                container.style.display = 'flex';
                dropdown.style.display = 'none';
                let btnWidth = container.offsetWidth || 160;
                let leftPos;
                if (hoveredVideo.tagName.toUpperCase() === 'A') {
                    // Keep the control clear of the link so it doesn't steal clicks.
                    const controlHeight = container.offsetHeight || 34;
                    const above = mRect.top - controlHeight - 10;
                    const below = mRect.bottom + 10;
                    const topPos = above >= 5 ? above : Math.min(below, window.innerHeight - controlHeight - 5);
                    container.style.top = (window.scrollY + Math.max(5, topPos)) + 'px';
                    leftPos = window.scrollX + mRect.left;
                } else {
                    container.style.top = (window.scrollY + mRect.top + 5) + 'px';
                    leftPos = window.scrollX + mRect.right - btnWidth - 15;
                    if (mRect.width < 200) leftPos = window.scrollX + mRect.left + 5;
                }
                leftPos = Math.max(5, Math.min(leftPos, window.innerWidth - btnWidth - 5));
                container.style.left = leftPos + 'px';
                
                clearTimeout(hideTimeout);
                hideTimeout = null;
            }
        }

        if (container.style.display === 'flex') {
            if (!isHoveringBtn && !isHoveringMedia) {
                if (!hideTimeout) {
                    hideTimeout = setTimeout(() => {
                        container.style.display = 'none';
                        dropdown.style.display = 'none';
                        hoveredVideo = null;
                        hideTimeout = null;
                    }, 500);
                }
            } else {
                clearTimeout(hideTimeout);
                hideTimeout = null;
            }
        }
    });

    const VIDEO_PAGE_PATH = /\/(?:@[^/]+\/)?(?:video|videos?|reel|shorts|watch|clip|status|posts?|share|stories|media|p|tv)\b/i;
    const DIRECT_MEDIA_PATH = /\.(?:mp4|m4v|webm|mkv|mov|m3u8|mpd|mp3|m4a|aac|wav|ogg)(?:$|[?#])/i;

    function looksLikeVideoPageUrl(value) {
        try {
            const url = new URL(value, location.href);
            if (!/^https?:$/.test(url.protocol) || DIRECT_MEDIA_PATH.test(url.href)) return false;
            if (VIDEO_PAGE_PATH.test(url.pathname)) return true;
            return ['v', 'video_id', 'videoid', 'item_id', 'aweme_id', 'clip_id', 'story_fbid']
                .some(key => (url.searchParams.get(key) || '').length >= 5);
        } catch (_) {
            return false;
        }
    }

    function isGenericLandingPage(value) {
        try {
            const pathname = new URL(value, location.href).pathname.replace(/\/+$/, '').toLowerCase();
            return !pathname || /^\/(?:home|feed|foryou|for-you|explore|search|results|trending|following)$/.test(pathname);
        } catch (_) {
            return true;
        }
    }

    function getMediaScopes(mediaElement, maxDepth = 24) {
        if (!mediaElement) return [];
        const article = mediaElement.closest?.('[role="article"], article');
        const scopes = article ? [article] : [];
        let scope = mediaElement;
        for (let depth = 0; scope && depth < maxDepth; depth += 1, scope = scope.parentElement) {
            if (!scopes.includes(scope)) scopes.push(scope);
        }
        return scopes;
    }

    function findVideoPageUrl(mediaElement) {
        if (!mediaElement || !['VIDEO', 'AUDIO'].includes(mediaElement.tagName?.toUpperCase())) return '';

        // A detail page URL is more useful than a signed CDN or blob player URL.
        if (looksLikeVideoPageUrl(location.href)) return location.href;

        const scopes = getMediaScopes(mediaElement);
        for (const scope of scopes) {
            const anchors = scope.matches?.('a[href]') ? [scope] : [...(scope.querySelectorAll?.('a[href]') || [])];
            const candidates = anchors.flatMap(anchor => {
                try {
                    const url = new URL(anchor.href, location.href);
                    if (!looksLikeVideoPageUrl(url.href)) return [];
                    let score = 100;
                    if (url.origin === location.origin) score += 20;
                    if (/\/(?:@[^/]+\/)?video\/\d+/i.test(url.pathname)) score += 30;
                    if (/reel|short|watch|video|clip|post|share/i.test(anchor.getAttribute('aria-label') || anchor.innerText || '')) score += 8;
                    return [{ href: url.href, score }];
                } catch (_) {
                    return [];
                }
            });
            if (candidates.length) {
                candidates.sort((a, b) => b.score - a.score);
                return candidates[0].href;
            }
        }

        // Some platforms put the video ID on the player/card instead of a link.
        for (const scope of scopes) {
            for (const key of ['data-video-id', 'data-videoid', 'data-video_id', 'data-aweme-id']) {
                const id = scope.getAttribute?.(key);
                if (id && /^\d{8,}$/.test(id) && domainMatches('facebook.com')) {
                    return `https://www.facebook.com/watch/?v=${encodeURIComponent(id)}`;
                }
            }
        }

        // On a non-feed page the current URL is usually the canonical media page.
        if (!isGenericLandingPage(location.href)) return location.href;
        return '';
    }

    function getMediaTitle(mediaElement) {
        const scopes = getMediaScopes(mediaElement, 16);
        const titleSelectors = [
            '[data-ad-preview="message"]', '[data-ad-comet-preview="message"]',
            '[data-testid*="post_message"]', '[data-testid*="caption"]',
            '[data-ad-rendering-role="story_message"]', '[data-e2e*="video-desc"]',
            '[data-e2e*="desc"]', '[itemprop="description"]', 'figcaption',
            '[aria-label*="caption" i]'
        ];
        for (const scope of scopes) {
            for (const selector of titleSelectors) {
                const node = scope.querySelector?.(selector);
                const text = (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
                if (text.length >= 8) return text.slice(0, 255);
            }
        }

        const textScope = scopes.find(scope => scope.matches?.('[role="article"], article')) || scopes[Math.min(scopes.length - 1, 8)];
        if (textScope) {
            const generic = new Set(['facebook', 'tiktok', 'instagram', 'youtube', 'video', 'فيديو']);
            const candidates = [...textScope.querySelectorAll('div[dir="auto"], [dir="auto"]')]
                .map(node => (node.innerText || '').replace(/\s+/g, ' ').trim())
                .filter(text => text.length >= 16 && text.length <= 500 && !generic.has(text.toLocaleLowerCase()));
            candidates.sort((a, b) => b.length - a.length);
            if (candidates[0]) return candidates[0].slice(0, 255);
        }

        const pageTitle = (document.title || '').replace(/\s+/g, ' ').trim();
        const cleanedTitle = pageTitle.replace(/\s*[|·–—-]\s*(?:youtube|tiktok|facebook|instagram|x)\b.*$/i, '').trim();
        return cleanedTitle.length >= 8 ? cleanedTitle.slice(0, 255) : '';
    }

    function triggerDownload(quality, isYtDlp = true) {
        let targetUrl = window.location.href;
        if (hoveredVideo) {
            if (hoveredVideo.tagName.toUpperCase() === 'A' && hoveredVideo.href) {
                targetUrl = hoveredVideo.href;
            } else if ((hoveredVideo.currentSrc || hoveredVideo.src) && !/^(blob|data):/i.test(hoveredVideo.currentSrc || hoveredVideo.src) && /^https?:/i.test(hoveredVideo.currentSrc || hoveredVideo.src)) {
                targetUrl = hoveredVideo.currentSrc || hoveredVideo.src;
            }
        }

        // A player src on social sites is usually a signed CDN URL. Keep the
        // post/share page URL so the downloader can resolve its real metadata.
        const mediaElement = ['VIDEO', 'AUDIO'].includes(hoveredVideo?.tagName?.toUpperCase()) ? hoveredVideo : null;
        const mediaPageUrl = isYtDlp ? findVideoPageUrl(mediaElement) : '';
        const mediaTitle = isYtDlp ? getMediaTitle(mediaElement) : '';
        if (mediaPageUrl) targetUrl = mediaPageUrl;
        else if (isYtDlp && mediaElement && (targetUrl === location.href || targetUrl.startsWith('blob:'))) {
            showToast('مش لاقي رابط صفحة للفيديو. استخدم مشاركة ثم نسخ الرابط.', true);
            return;
        }

        const originalHtml = mainBtn.innerHTML;
        mainBtn.innerHTML = `<span style="font-weight: 600; font-size: 13px; color: #818cf8;">Sending...</span>`;
        dropdown.style.display = 'none';

        // Guard against invalidated extension context (reload, update, MV3 service worker suspend)
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
            showToast("Extension updated. Please refresh the page.", true);
            mainBtn.innerHTML = originalHtml;
            return;
        }

        try {
            chrome.runtime.sendMessage({ action: "directDownload", url: targetUrl, quality: quality, title: mediaTitle || document.title }, (response) => {
                if (chrome.runtime.lastError) {
                    showToast("Extension updated. Please refresh the page.", true);
                    mainBtn.innerHTML = originalHtml;
                } else if (!response || !response.success) {
                    showToast("Ledo Downloader is offline!", true);
                    mainBtn.innerHTML = originalHtml;
                } else {
                    showToast("✔ Added to Ledo!");
                    mainBtn.innerHTML = `<span style="font-weight: 600; font-size: 13px; color: #10b981;">✔ Added!</span>`;
                    mainBtn.style.borderColor = '#10b981';
                    setTimeout(() => {
                        mainBtn.innerHTML = originalHtml;
                        mainBtn.style.borderColor = 'rgba(99, 102, 241, 0.4)';
                        container.style.display = 'none';
                    }, 2000);
                }
            });
        } catch (e) {
            showToast("Extension updated. Please refresh the page.", true);
            mainBtn.innerHTML = originalHtml;
        }
    }

    optVideo.addEventListener('click', () => triggerDownload("best"));
    optAudio.addEventListener('click', () => triggerDownload("audio"));
    optFile.addEventListener('click', () => triggerDownload("best", false));
    
    optManual.addEventListener('click', () => {
        let targetUrl = window.location.href;
        if (hoveredVideo) {
            if (hoveredVideo.tagName.toUpperCase() === 'A' && hoveredVideo.href) {
                targetUrl = hoveredVideo.href;
            } else if ((hoveredVideo.currentSrc || hoveredVideo.src) && !/^(blob|data):/i.test(hoveredVideo.currentSrc || hoveredVideo.src) && /^https?:/i.test(hoveredVideo.currentSrc || hoveredVideo.src)) {
                targetUrl = hoveredVideo.currentSrc || hoveredVideo.src;
            }
        }
        const mediaElement = ['VIDEO', 'AUDIO'].includes(hoveredVideo?.tagName?.toUpperCase()) ? hoveredVideo : null;
        const mediaPageUrl = findVideoPageUrl(mediaElement);
        const mediaTitle = getMediaTitle(mediaElement);
        if (mediaPageUrl) targetUrl = mediaPageUrl;
        else if (mediaElement && (targetUrl === location.href || targetUrl.startsWith('blob:'))) {
            showToast('مش لاقي رابط صفحة للفيديو. استخدم مشاركة ثم نسخ الرابط.', true);
            return;
        }
        const originalHtml = mainBtn.innerHTML;
        mainBtn.innerHTML = `<span style="font-weight: 600; font-size: 13px; color: #818cf8;">Sending...</span>`;

        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
            showToast("Extension updated. Please refresh the page.", true);
            mainBtn.innerHTML = originalHtml;
            return;
        }

        try {
            chrome.runtime.sendMessage({ action: "downloadUrl", url: targetUrl, title: mediaTitle || document.title, referer: window.location.href }, (response) => {
                if (chrome.runtime.lastError) {
                    showToast("Extension updated. Please refresh the page.", true);
                    mainBtn.innerHTML = originalHtml;
                } else if (!response || !response.success) {
                    showToast("Ledo Downloader is offline!", true);
                    mainBtn.innerHTML = originalHtml;
                } else {
                    showToast("✔ Opened Quick Add");
                    mainBtn.innerHTML = originalHtml;
                    container.style.display = 'none';
                }
            });
        } catch (e) {
            showToast("Extension updated. Please refresh the page.", true);
            mainBtn.innerHTML = originalHtml;
        }
    });

    function showToast(message, isError = false) {
        const toast = document.createElement('div');
        toast.style.position = 'fixed';
        toast.style.bottom = '24px';
        toast.style.right = '24px';
        toast.style.zIndex = '2147483647';
        toast.style.background = isError ? '#ef4444' : 'rgba(16, 185, 129, 0.95)';
        toast.style.backdropFilter = 'blur(10px)';
        toast.style.color = '#fff';
        toast.style.padding = '12px 20px';
        toast.style.borderRadius = '8px';
        toast.style.fontFamily = '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
        toast.style.fontSize = '14px';
        toast.style.fontWeight = '500';
        toast.style.boxShadow = isError ? '0 4px 15px rgba(239, 68, 68, 0.3)' : '0 4px 15px rgba(16, 185, 129, 0.3)';
        toast.style.transition = 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px) scale(0.9)';
        toast.style.wordBreak = 'break-word';
        toast.style.overflowWrap = 'break-word';
        toast.style.maxWidth = '300px';
        toast.innerHTML = message;
        
        document.documentElement.appendChild(toast);
        
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateY(0) scale(1)';
        });
        
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(20px) scale(0.9)';
            setTimeout(() => {
                if (toast.parentNode) toast.remove();
            }, 400);
        }, 3500);
    }

    // ========================================================================
    //  Element Zapper Tool (أداة إزالة العناصر السريعة من الصفحة)
    // ========================================================================
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message && message.action === 'startElementZapper') {
            startElementZapper();
            sendResponse({ success: true });
            return false;
        }
    });

    function startElementZapper() {
        let currentTarget = null;

        // Floating instruction banner at the top
        const banner = document.createElement('div');
        banner.id = 'ledo-zapper-banner';
        banner.style.cssText = `
            position: fixed !important;
            top: 14px !important;
            left: 50% !important;
            transform: translateX(-50%) !important;
            z-index: 2147483647 !important;
            background: #0f172a !important;
            color: #ffffff !important;
            padding: 8px 18px !important;
            border-radius: 30px !important;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            font-size: 13px !important;
            font-weight: 600 !important;
            box-shadow: 0 10px 25px rgba(0,0,0,0.4) !important;
            border: 1px solid rgba(255,255,255,0.2) !important;
            display: flex !important;
            align-items: center !important;
            gap: 12px !important;
            direction: rtl !important;
            pointer-events: auto !important;
        `;
        banner.innerHTML = `
            <span>🎯 أداة الإزالة: انقر على أي إعلان أو عنصر لحذفه</span>
            <span style="font-size:11px; background:#334155; padding:2px 8px; border-radius:12px; color:#cbd5e1; cursor:pointer;" id="ledo-zapper-cancel-btn">Esc إلغاء</span>
        `;
        document.documentElement.appendChild(banner);

        // Highlight box
        const highlightBox = document.createElement('div');
        highlightBox.id = 'ledo-zapper-highlight';
        highlightBox.style.cssText = `
            position: absolute !important;
            z-index: 2147483646 !important;
            border: 2px dashed #ef4444 !important;
            background: rgba(239, 68, 68, 0.2) !important;
            pointer-events: none !important;
            display: none !important;
            transition: all 0.05s ease-out !important;
            border-radius: 4px !important;
        `;
        document.documentElement.appendChild(highlightBox);

        function updateHighlight(el) {
            if (!el || el === banner || banner.contains(el) || el === highlightBox || el === document.body || el === document.documentElement) {
                highlightBox.style.display = 'none';
                currentTarget = null;
                return;
            }
            currentTarget = el;
            const rect = el.getBoundingClientRect();
            highlightBox.style.display = 'block';
            highlightBox.style.top = `${rect.top + window.scrollY}px`;
            highlightBox.style.left = `${rect.left + window.scrollX}px`;
            highlightBox.style.width = `${rect.width}px`;
            highlightBox.style.height = `${rect.height}px`;
        }

        function onMouseMove(e) {
            const el = document.elementFromPoint(e.clientX, e.clientY);
            updateHighlight(el);
        }

        function onClick(e) {
            if (banner.contains(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            if (currentTarget) {
                const target = currentTarget;
                cleanup();

                // Quick vanish animation
                target.style.transition = 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
                target.style.transform = 'scale(0.85)';
                target.style.opacity = '0';
                setTimeout(() => {
                    target.style.setProperty('display', 'none', 'important');
                    target.style.setProperty('visibility', 'hidden', 'important');
                }, 250);

                showNotification('✔ تمت إزالة العنصر بنجاح!');
                try {
                    chrome.runtime.sendMessage({
                        action: 'adblockStats',
                        stats: { blocked: 1, skipped: 0 },
                        hostname: location.hostname
                    });
                } catch(_) {}
            }
        }

        function onKeyDown(e) {
            if (e.key === 'Escape' || e.keyCode === 27) {
                cleanup();
                showNotification('تم إلغاء أداة الإزالة');
            }
        }

        function cleanup() {
            document.removeEventListener('mousemove', onMouseMove, true);
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('keydown', onKeyDown, true);
            if (banner.parentNode) banner.remove();
            if (highlightBox.parentNode) highlightBox.remove();
        }

        document.getElementById('ledo-zapper-cancel-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            cleanup();
        });

        document.addEventListener('mousemove', onMouseMove, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKeyDown, true);
    }
})();
