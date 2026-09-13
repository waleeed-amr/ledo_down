(function() {
    let hoveredVideo = null;
    let hideTimeout = null;
    const ignoredVideos = new WeakSet();

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
        <img src="${chrome.runtime.getURL('icons/icon48.png')}" alt="Ledo" style="width:14px;height:14px;margin-right:6px;vertical-align:middle;display:inline-block; border-radius:3px;">
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

        if (!isHoveringBtn && !isHoveringMedia && now - lastMouseMove > 150) {
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
                let btnWidth = container.offsetWidth || 160;
                
                container.style.top = (window.scrollY + mRect.top + 5) + 'px';
                
                // Position logic
                let leftPos = window.scrollX + mRect.right - btnWidth - 15;
                if (mRect.width < 200) {
                    leftPos = window.scrollX + mRect.left + 5; 
                }
                // Clamp
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

    function triggerDownload(quality) {
        let targetUrl = window.location.href;
        if (hoveredVideo) {
            if (hoveredVideo.tagName.toUpperCase() === 'A' && hoveredVideo.href) {
                targetUrl = hoveredVideo.href;
            } else if (hoveredVideo.src && !hoveredVideo.src.startsWith('blob:') && hoveredVideo.src.startsWith('http')) {
                targetUrl = hoveredVideo.src;
            }
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
            chrome.runtime.sendMessage({ action: "directDownload", url: targetUrl, quality: quality }, (response) => {
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
    optFile.addEventListener('click', () => triggerDownload("best"));
    
    optManual.addEventListener('click', () => {
        let targetUrl = window.location.href;
        if (hoveredVideo) {
            if (hoveredVideo.tagName.toUpperCase() === 'A' && hoveredVideo.href) {
                targetUrl = hoveredVideo.href;
            } else if (hoveredVideo.src && !hoveredVideo.src.startsWith('blob:') && hoveredVideo.src.startsWith('http')) {
                targetUrl = hoveredVideo.src;
            }
        }
        const originalHtml = mainBtn.innerHTML;
        mainBtn.innerHTML = `<span style="font-weight: 600; font-size: 13px; color: #818cf8;">Sending...</span>`;

        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
            showToast("Extension updated. Please refresh the page.", true);
            mainBtn.innerHTML = originalHtml;
            return;
        }

        try {
            chrome.runtime.sendMessage({ action: "downloadUrl", url: targetUrl }, (response) => {
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
})();
