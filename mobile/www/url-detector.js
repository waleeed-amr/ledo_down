/* ============================================
   URL Detector — Smart URL Classification
   Decides whether a URL is a direct file or a
   media URL that needs yt-dlp to extract streams.
   Loaded before mobile-bridge.js so it's available
   globally as window.UrlDetector.
   ============================================ */

(function () {
    'use strict';

    // Known direct-file extensions (case-insensitive). Includes executables,
    // archives, documents, disk images, and bare media files (mp4/mp3/etc).
    const DIRECT_EXTENSIONS = new Set([
        // Archives
        'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'lz', 'lzma', 'z',
        // Executables / installers
        'exe', 'msi', 'apk', 'appx', 'msix', 'pkg', 'deb', 'rpm', 'dmg', 'pkg',
        // Disk images
        'iso', 'img', 'bin', 'cue', 'mdf', 'nrg',
        // Documents
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'epub', 'mobi', 'azw', 'azw3',
        // Plain media (often served as a single file, no need for yt-dlp)
        'mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac', 'aiff',
        // Subtitles
        'srt', 'vtt', 'ass', 'ssa', 'sub',
        // Fonts
        'ttf', 'otf', 'woff', 'woff2',
        // Other binaries
        'torrent'
    ]);

    // Known media platforms (hostnames / hostname patterns that need yt-dlp).
    // We check if any of these match a substring of the hostname.
    const MEDIA_HOSTS = [
        // Video
        'youtube.com', 'youtu.be', 'm.youtube.com', 'youtube-nocookie.com',
        'vimeo.com', 'player.vimeo.com', 'dailymotion.com', 'dai.ly',
        'twitch.tv', 'twitch.com', 'clips.twitch.tv',
        'rumble.com', 'bitchute.com', 'odysee.com', 'lbry.tv',
        // Social media (video / image)
        'twitter.com', 'x.com', 't.co',
        'instagram.com', 'instagr.am',
        'facebook.com', 'fb.watch', 'fb.com', 'm.facebook.com',
        'tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
        'reddit.com', 'redd.it', 'old.reddit.com',
        'linkedin.com',
        'pinterest.com', 'pin.it',
        'snapchat.com',
        // Music / audio platforms
        'soundcloud.com', 'snd.sc',
        'bandcamp.com',
        'mixcloud.com',
        'audius.co',
        // Other
        'streamable.com',
        'imgur.com',
        'gfycat.com',
        'newgrounds.com',
        'pornhub.com',
        'xvideos.com',
        'bilibili.com', 'b23.tv',
        'nicovideo.jp',
        'naver.com',
        'kakao.com',
        'vk.com',
        'rutube.ru',
        'yandex.ru', 'yandex.com',
        '9gag.com'
    ];

    /**
     * Try to pull a filename out of a URL path. Returns '' if the path is
     * empty or has no basename. URL-decodes the result.
     */
    function filenameFromPath(rawUrl) {
        if (!rawUrl) return '';
        try {
            const u = new URL(rawUrl);
            const path = u.pathname || '';
            const lastSlash = path.lastIndexOf('/');
            let name = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
            if (!name) return '';
            try {
                name = decodeURIComponent(name);
            } catch (e) {
                /* keep raw if decode fails */
            }
            // Trim trailing query garbage if any leaked in
            return name.replace(/[?#].*$/, '').trim();
        } catch (e) {
            return '';
        }
    }

    /**
     * Returns lowercase extension WITHOUT the dot, or '' if none.
     */
    function getExtension(name) {
        if (!name) return '';
        const lastDot = name.lastIndexOf('.');
        if (lastDot < 0 || lastDot === name.length - 1) return '';
        return name.substring(lastDot + 1).toLowerCase();
    }

    /**
     * Classify a URL.
     * @param {string} rawUrl
     * @returns {{type: 'direct'|'media'|'unknown', filename: string, ext: string, platform: string}}
     */
    function classify(rawUrl) {
        const result = { type: 'unknown', filename: '', ext: '', platform: '' };
        if (!rawUrl || typeof rawUrl !== 'string') return result;

        // Cleanup
        let url = rawUrl.trim();
        // Strip common shortener prefix that breaks URL parsing
        // (e.g. user pastes "https://youtu.be/abc?t=1" — URL() handles that fine)

        let host = '';
        let pathname = '';
        try {
            const u = new URL(url);
            host = (u.hostname || '').toLowerCase();
            pathname = (u.pathname || '').toLowerCase();
        } catch (e) {
            // Not a valid URL — best we can do is look at the raw text.
            const m = url.match(/^[a-z]+:\/\/([^/?#]+)(.*)$/i);
            if (m) {
                host = m[1].toLowerCase();
                pathname = (m[2] || '').toLowerCase();
            }
        }

        // Filename + extension
        const filename = filenameFromPath(url);
        const ext = getExtension(filename);

        // 1) Strong signal: known media host → media.
        for (const h of MEDIA_HOSTS) {
            if (host === h || host.endsWith('.' + h) || host.includes('.' + h + '.') || host.includes(h + '.')) {
                // youtube, twitter, etc. are media. But also check that we
                // don't accidentally treat a CDN URL (e.g. twimg.net) as media.
                // The MEDIA_HOSTS list is curated so this is fine.
                result.type = 'media';
                result.platform = h;
                result.filename = filename;
                result.ext = ext;
                return result;
            }
        }

        // 2) Strong signal: file extension in our direct list → direct.
        if (ext && DIRECT_EXTENSIONS.has(ext)) {
            result.type = 'direct';
            result.filename = filename || ('download_' + Date.now() + '.' + ext);
            result.ext = ext;
            return result;
        }

        // 3) No extension but looks like a CDN / hashed path → treat as
        // unknown; the bridge will try the direct downloader first.
        result.type = 'unknown';
        result.filename = filename;
        result.ext = ext;
        return result;
    }

    /**
     * Try to guess a human-readable title for a direct file from its URL.
     * If the URL has no useful basename, returns a generated one.
     */
    function guessTitle(rawUrl) {
        const c = classify(rawUrl);
        if (c.filename && c.filename.length > 3 && /\.[a-z0-9]{2,5}$/i.test(c.filename)) {
            return c.filename;
        }
        if (c.ext) return 'download_' + Date.now() + '.' + c.ext;
        return 'download_' + Date.now() + '.bin';
    }

    /**
     * Map a renderer quality id to a yt-dlp -f format string.
     *  - 'best'   → empty (let yt-dlp auto-pick the best single file)
     *  - '720p'   → bestvideo<=720 + bestaudio / best<=720
     *  - '480p'   → bestvideo<=480 + bestaudio / best<=480
     *  - '360p'   → bestvideo<=360 + bestaudio / best<=360
     *  - 'audio'  → bestaudio (the YtDlp plugin adds --extract-audio itself)
     */
    function qualityToYtdlpFormat(quality) {
        if (!quality || quality === 'best') return '';
        if (quality === 'audio') return 'bestaudio/best';
        const m = String(quality).match(/^(\d{2,4})p$/);
        if (m) {
            const h = m[1];
            return `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
        }
        return quality; // already a format id or free-form
    }

    window.UrlDetector = {
        classify: classify,
        guessTitle: guessTitle,
        qualityToYtdlpFormat: qualityToYtdlpFormat,
        filenameFromPath: filenameFromPath
    };
})();
