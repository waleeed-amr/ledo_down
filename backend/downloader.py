import os
import threading
import time
from urllib.parse import urlparse, unquote
import uuid
import asyncio
import aiohttp
import aiofiles
import re
import shutil
from loguru import logger
from database import DownloadRecord, SessionLocal
from typing import Optional, List, Dict, Set

try:
    from telemetry_worker import report_error, report_exception
except ImportError:
    try:
        from cloud_backend.telemetry_worker import report_error, report_exception
    except ImportError:
        def report_error(*a, **kw): pass
        def report_exception(*a, **kw): pass

import sys

def get_resource_dir():
    """
    Returns the directory where bundled binaries (ffmpeg.exe, yt-dlp.exe, etc.) are located.
    Handles:
    - Packaged Electron app (resources/ directory)
    - PyInstaller standalone (same directory or parent)
    - Local development environment
    """
    if getattr(sys, 'frozen', False):
        exe_dir = os.path.dirname(sys.executable)
        # 1. Electron resources dir: <InstallDir>/resources/backend/dist -> ../.. = <InstallDir>/resources
        electron_res = os.path.abspath(os.path.join(exe_dir, "..", ".."))
        if os.path.exists(os.path.join(electron_res, "ffmpeg.exe")) or os.path.exists(os.path.join(electron_res, "yt-dlp.exe")):
            return electron_res
        
        # 2. In case resources is 1 level up:
        one_up = os.path.abspath(os.path.join(exe_dir, ".."))
        if os.path.exists(os.path.join(one_up, "ffmpeg.exe")) or os.path.exists(os.path.join(one_up, "yt-dlp.exe")):
            return one_up

        # 3. In root directory (<InstallDir>):
        app_root = os.path.abspath(os.path.join(electron_res, ".."))
        if os.path.exists(os.path.join(app_root, "ffmpeg.exe")) or os.path.exists(os.path.join(app_root, "yt-dlp.exe")):
            return app_root

        # 4. Same directory as executable:
        if os.path.exists(os.path.join(exe_dir, "ffmpeg.exe")) or os.path.exists(os.path.join(exe_dir, "yt-dlp.exe")):
            return exe_dir

        return electron_res
    else:
        return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

BASE_DIR = get_resource_dir()

def resolve_binary(binary_name):
    """
    Finds a bundled binary or falls back to system PATH.
    """
    # 1. Check in BASE_DIR (bundled resources or project root)
    target = os.path.abspath(os.path.join(BASE_DIR, binary_name))
    if os.path.exists(target):
        return target
    
    # 2. Check in system PATH
    sys_path = shutil.which(binary_name) or shutil.which(os.path.splitext(binary_name)[0])
    if sys_path and os.path.exists(sys_path):
        return sys_path
        
    return target

YT_DLP_PATH = resolve_binary("yt-dlp.exe")
FFMPEG_PATH = resolve_binary("ffmpeg.exe")

# Automatically add resource directory to PATH so yt-dlp & child processes find ffmpeg & ffprobe
if os.path.exists(BASE_DIR):
    if BASE_DIR not in os.environ.get('PATH', ''):
        os.environ['PATH'] = BASE_DIR + os.pathsep + os.environ.get('PATH', '')
if FFMPEG_PATH and os.path.exists(FFMPEG_PATH):
    ffmpeg_dir = os.path.dirname(FFMPEG_PATH)
    if ffmpeg_dir not in os.environ.get('PATH', ''):
        os.environ['PATH'] = ffmpeg_dir + os.pathsep + os.environ.get('PATH', '')

def get_default_downloads_dir():
    """
    Dynamically determines the user's Downloads folder from the OS.
    Supports relocated Downloads folders, custom drive letters, and OneDrive.
    """
    # 1. Query Windows User Shell Folders registry
    try:
        import winreg
        key_path = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            raw_path, _ = winreg.QueryValueEx(key, "{374DE290-123F-4565-9164-39C4925E467B}")
            expanded = os.path.expandvars(raw_path)
            if os.path.exists(expanded):
                return os.path.join(expanded, "Ledo Downloader")
    except Exception:
        pass
    
    # 2. Fallback to standard user home directory
    user_home = os.path.expanduser('~')
    downloads_path = os.path.join(user_home, 'Downloads')
    if os.path.exists(downloads_path):
        return os.path.join(downloads_path, "Ledo Downloader")
        
    return os.path.join(user_home, "Ledo Downloader")

BASE_DOWNLOAD_DIR = get_default_downloads_dir()

# File Categories
CATEGORIES = {
    "Videos": [".mp4", ".mkv", ".avi", ".flv", ".mov", ".wmv", ".webm", ".m4v", ".3gp", ".ts", ".vob", ".mpg", ".mpeg", ".hevc", ".m3u8"],
    "Audio": [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".wma", ".opus", ".aiff", ".mid"],
    "Images": [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".ico", ".tiff", ".heic", ".avif", ".jxl"],
    "Archives": [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".zst", ".tgz", ".cab", ".iso", ".img", ".vhd", ".wim"],
    "Documents": [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".epub", ".mobi", ".rtf"],
    "Programs": [".exe", ".msi", ".msix", ".appx", ".apk", ".dmg", ".pkg", ".deb", ".rpm", ".appimage", ".jar", ".run", ".bin"]
}

AUTO_CATEGORIZE = True

def set_auto_categorize(enabled: bool):
    global AUTO_CATEGORIZE
    AUTO_CATEGORIZE = bool(enabled)
    logger.info(f"Auto categorize set to: {AUTO_CATEGORIZE}")

def set_base_download_dir(new_path: str):
    global BASE_DOWNLOAD_DIR
    if new_path:
        norm = os.path.abspath(os.path.normpath(new_path))
        os.makedirs(norm, exist_ok=True)
        BASE_DOWNLOAD_DIR = norm
        logger.info(f"Base download directory set to: {BASE_DOWNLOAD_DIR}")

def get_category_dir(filename, base_dir=None):
    root = base_dir or BASE_DOWNLOAD_DIR
    if not AUTO_CATEGORIZE:
        os.makedirs(root, exist_ok=True)
        return root
    ext = os.path.splitext(filename)[1].lower()
    for cat, exts in CATEGORIES.items():
        if ext in exts:
            cat_dir = os.path.join(root, cat)
            os.makedirs(cat_dir, exist_ok=True)
            return cat_dir
    
    other_dir = os.path.join(root, "Others")
    os.makedirs(other_dir, exist_ok=True)
    return other_dir

active_downloads = {}

class DynamicSemaphore:
    def __init__(self, value=3):
        self._value = max(1, int(value))
        self._current = 0
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)

    def set_value(self, value):
        with self._lock:
            self._value = max(1, int(value))
            self._cond.notify_all()
        logger.info(f"Max concurrent downloads updated to: {self._value}")

    def get_value(self):
        with self._lock:
            return self._value

    def acquire(self):
        with self._lock:
            while self._current >= self._value:
                self._cond.wait()
            self._current += 1

    def release(self):
        with self._lock:
            self._current = max(0, self._current - 1)
            self._cond.notify()

    def __enter__(self):
        self.acquire()

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.release()

download_semaphore = DynamicSemaphore(3)

def set_max_concurrent(count: int):
    download_semaphore.set_value(count)

def get_max_concurrent() -> int:
    return download_semaphore.get_value()

GLOBAL_SPEED_LIMIT_KBPS = 0  # 0 = unlimited

def set_speed_limit(kbps: int):
    global GLOBAL_SPEED_LIMIT_KBPS
    GLOBAL_SPEED_LIMIT_KBPS = max(0, int(kbps))
    logger.info(f"Speed limit set to: {GLOBAL_SPEED_LIMIT_KBPS} KB/s")

def get_speed_limit() -> int:
    return GLOBAL_SPEED_LIMIT_KBPS
    
def calculate_optimal_threads(total_size: int) -> int:
    if total_size <= 0:
        return 1
    if total_size < 5 * 1024 * 1024:        # < 5MB
        return 2
    elif total_size < 50 * 1024 * 1024:    # < 50MB
        return 4
    elif total_size < 300 * 1024 * 1024:   # < 300MB
        return 8
    else:                                  # Large files
        return 16

class DownloadContext:
    def __init__(self, download_id, url, on_update, save_path=None, quality="best", cookies=None, user_agent=None, referer=None):
        self.id = download_id
        self.url = url
        self.on_update = on_update
        self.save_path = save_path
        self.quality = quality
        self.cookies = cookies
        self.user_agent = user_agent
        self.referer = referer
        self.num_threads = 8
        self.stop_event = threading.Event()
        self.thread_stop_event = threading.Event()
        self.process = None

def start_download(url, db, use_ytdlp=False, on_update=None, save_path=None, quality="best", cookies=None, user_agent=None, referer=None, existing_id=None, title=None):
    if save_path:
        norm_path = os.path.normpath(save_path)
        if not os.path.isabs(norm_path):
            norm_path = os.path.join(BASE_DOWNLOAD_DIR, norm_path)
        norm_path = os.path.abspath(norm_path)
        os.makedirs(norm_path, exist_ok=True)
        save_path = norm_path

    if existing_id:
        download_id = existing_id
        logger.info(f"Resuming download {download_id} for URL: {url}")
        db_rec = db.query(DownloadRecord).filter(DownloadRecord.id == download_id).first()
        if db_rec:
            db_rec.status = "starting"
            db_rec.error_message = ""
            db.commit()
    else:
        download_id = str(uuid.uuid4())
        logger.info(f"Preparing download {download_id} for URL: {url} | yt-dlp: {use_ytdlp} | Quality: {quality}")
        
        db_rec = DownloadRecord(
            id=download_id,
            url=url,
            is_yt_dlp=use_ytdlp,
            status="starting",
            filename=title if title else "",
            total_size=0,
            downloaded=0,
            speed=0,
            progress=0.0,
            created_at=time.time() * 1000,
            save_path=save_path,
            quality=quality,
            cookies=cookies,
            user_agent=user_agent,
            referer=referer
        )
        db.add(db_rec)
        db.commit()
    
    ctx = DownloadContext(download_id, url, on_update, save_path, quality, cookies, user_agent, referer)
    active_downloads[download_id] = ctx
    
    if use_ytdlp:
        thread = threading.Thread(target=_run_ytdlp, args=(ctx,))
        thread.daemon = True
        thread.start()
    else:
        def run_async_download():
            with download_semaphore:
                if ctx.thread_stop_event.is_set() or ctx.stop_event.is_set():
                    return
                _update_db(ctx, status="downloading")
                asyncio.run(_run_chunked_download_async(ctx))
        
        thread = threading.Thread(target=run_async_download)
        thread.daemon = True
        thread.start()
        
    return download_id


# Global cache to prevent constant disk I/O on SQLite
IN_MEMORY_DB_CACHE = {}

def _update_db(ctx, **kwargs):
    global IN_MEMORY_DB_CACHE
    
    # Always update memory cache immediately
    if ctx.id not in IN_MEMORY_DB_CACHE:
        IN_MEMORY_DB_CACHE[ctx.id] = {}
    IN_MEMORY_DB_CACHE[ctx.id].update(kwargs)
    
    # Only commit to SQLite if status changed or it's a final state, or error
    # Progress updates alone won't hammer the database
    should_commit_to_db = False
    if "status" in kwargs:
        should_commit_to_db = True
    elif "error_message" in kwargs and kwargs["error_message"]:
        should_commit_to_db = True
    elif "filename" in kwargs and "total_size" in kwargs:
        should_commit_to_db = True

    if should_commit_to_db:
        db = SessionLocal()
        try:
            rec = db.query(DownloadRecord).filter(DownloadRecord.id == ctx.id).first()
            if rec:
                # Flush everything from cache to the real DB
                for k, v in IN_MEMORY_DB_CACHE[ctx.id].items():
                    setattr(rec, k, v)
                db.commit()
        except Exception as e:
            logger.error(f"Database update failed for {ctx.id}: {e}")
        finally:
            db.close()
            
    # Trigger UI update callback via websocket
    if ctx.on_update:
        ctx.on_update(ctx.id)


def _run_ytdlp(ctx: DownloadContext):
    logger.info(f"Queued yt-dlp download: {ctx.id}. Waiting for available slot...")
    
    with download_semaphore:
        if ctx.thread_stop_event.is_set() or ctx.stop_event.is_set():
            return
            
        logger.info(f"Starting yt-dlp download: {ctx.id}")
        _update_db(ctx, status="downloading")
        
        _run_ytdlp_inner(ctx)

def _run_ytdlp_inner(ctx: DownloadContext):
    # Resolve short URLs for TikTok, Instagram, etc.
    url = ctx.url
    if any(short in url for short in ["vt.tiktok.com", "vm.tiktok.com", "instagram.com/reel", "t.co/", "fb.watch"]):
        try:
            import requests as req_lib
            resp = req_lib.head(url, allow_redirects=True, timeout=5)
            url = resp.url
            ctx.url = url
            logger.info(f"Resolved short URL to: {url}")
        except Exception as e:
            logger.warning(f"Failed to resolve short URL, using original: {e}")
    
    # Handle Spotify via oEmbed and ytsearch
    if "spotify.com/track/" in url:
        try:
            import urllib.request
            import json
            req_url = f"https://open.spotify.com/oembed?url={url}"
            with urllib.request.urlopen(req_url) as resp:
                data = json.loads(resp.read().decode())
                if "title" in data:
                    search_query = data["title"]
                    # Spotify oEmbed title format: "Track Name - Song by Artist Name"
                    ctx.url = f"ytsearch1:{search_query} audio"
                    logger.info(f"Converted Spotify URL to ytsearch: {ctx.url}")
                    # Force audio format if it's Spotify
                    ctx.quality = "audio"
        except Exception as e:
            logger.error(f"Failed to resolve Spotify track: {e}")
            
    if ctx.save_path:
        video_dir = ctx.save_path
    elif not AUTO_CATEGORIZE:
        video_dir = BASE_DOWNLOAD_DIR
    elif ctx.quality == "audio":
        video_dir = os.path.join(BASE_DOWNLOAD_DIR, "Audio")
    else:
        video_dir = os.path.join(BASE_DOWNLOAD_DIR, "Videos")
    os.makedirs(video_dir, exist_ok=True)
    
    FFMPEG_PATH = resolve_binary("ffmpeg.exe")
    if FFMPEG_PATH and os.path.exists(FFMPEG_PATH):
        ffmpeg_dir = os.path.dirname(FFMPEG_PATH)
        if ffmpeg_dir not in os.environ.get('PATH', ''):
            os.environ['PATH'] = ffmpeg_dir + os.pathsep + os.environ.get('PATH', '')

    
    last_update = time.time()
    
    def progress_hook(d):
        nonlocal last_update
        
        if ctx.thread_stop_event.is_set() or ctx.stop_event.is_set():
            raise Exception("Download paused/stopped by user")
            
        if d['status'] == 'downloading':
            filename = d.get('info_dict', {}).get('_filename') or d.get('filename')
            if filename:
                filename = os.path.basename(filename)
                
            # Smart cross-site progress: use bytes when available, fallback to percent string
            total_size = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            downloaded = d.get('downloaded_bytes', 0)
            speed = d.get('speed') or 0.0
            
            if total_size > 0:
                prog = (downloaded / total_size) * 100.0
            else:
                # Fallback: parse _percent_str for sites that don't report bytes
                percent_str = d.get('_percent_str', '0.0%').strip()
                percent_str = re.sub(r'\x1b\[[0-9;]*m', '', percent_str).replace('%', '')
                try:
                    prog = float(percent_str)
                except ValueError:
                    prog = 0.0
                    
            if prog < 0:
                prog = 0.0
            if prog > 100:
                prog = 100.0
            
            now = time.time()
            if now - last_update > 0.5:
                kwargs = dict(progress=prog, speed=speed, downloaded=downloaded, total_size=total_size)
                if filename:
                    kwargs['filename'] = filename
                _update_db(ctx, **kwargs)
                last_update = now
                
        elif d['status'] == 'finished':
            filename = d.get('info_dict', {}).get('_filename') or d.get('filename')
            if filename:
                filename = os.path.basename(filename)
                _update_db(ctx, progress=100.0, status="processing", filename=filename)
            else:
                _update_db(ctx, progress=100.0, status="processing")
            
    # Use a safer outtmpl to avoid Windows path length limits and invalid arguments
    outtmpl_path = video_dir.replace('\\', '/') + '/%(title).100s.%(ext)s'
    
    ydl_opts = {
        'outtmpl': outtmpl_path,
        'progress_hooks': [progress_hook],
        'noplaylist': True,
        'nocheckcertificate': True,
        'quiet': True,
        'no_warnings': True,
        'ignoreerrors': False,
        'restrictfilenames': False,
        'windowsfilenames': True,
        'trim_file_name': 200,
        'concurrent_fragment_downloads': 10,
        'extractor_args': {'youtube': ['player_client=android'], 'generic': ['impersonate']},
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        },
        'force_ipv4': True
    }
    
    if GLOBAL_SPEED_LIMIT_KBPS > 0:
        ydl_opts['ratelimit'] = GLOBAL_SPEED_LIMIT_KBPS * 1024
    
    if 'facebook.com' in ctx.url or 'fb.watch' in ctx.url:
        ydl_opts['force_ipv4'] = False
        ydl_opts['legacyserverconnect'] = True
    
    if ctx.user_agent:
        ydl_opts['http_headers']['User-Agent'] = ctx.user_agent
        
    if ctx.cookies:
        ydl_opts['http_headers']['Cookie'] = ctx.cookies
        
    if ctx.referer:
        ydl_opts['http_headers']['Referer'] = ctx.referer
    
    # NOTE: aria2c is NOT used as external downloader for yt-dlp because it
    # conflicts with progress hooks and causes [Errno 22] Invalid argument on
    # Windows. aria2c is still used for direct/chunked downloads separately.
    
    # Configure format based on user quality selection
    if ctx.quality == "audio":
        ydl_opts['format'] = 'bestaudio/best'
        ydl_opts['writethumbnail'] = True
        ydl_opts['postprocessors'] = [
            {
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': '192',
            },
            {
                'key': 'EmbedThumbnail',
                'already_have_thumbnail': False,
            }
        ]
    elif ctx.quality == "720p":
        ydl_opts['format'] = 'bestvideo[height<=720]+bestaudio/best[height<=720]/bestvideo+bestaudio/best'
    elif ctx.quality == "480p":
        ydl_opts['format'] = 'bestvideo[height<=480]+bestaudio/best[height<=480]/bestvideo+bestaudio/best'
    elif ctx.quality == "360p":
        ydl_opts['format'] = 'bestvideo[height<=360]+bestaudio/best[height<=360]/bestvideo+bestaudio/best'
    else:
        # Default to best quality (Max)
        ydl_opts['format'] = 'bestvideo+bestaudio/best'
    
    if FFMPEG_PATH and os.path.exists(FFMPEG_PATH):
        ffmpeg_dir = os.path.dirname(FFMPEG_PATH)
        ydl_opts['ffmpeg_location'] = ffmpeg_dir
        # Also add to PATH so any subprocess yt-dlp spawns can find ffmpeg
        if ffmpeg_dir not in os.environ.get('PATH', ''):
            os.environ['PATH'] = ffmpeg_dir + os.pathsep + os.environ.get('PATH', '')
        if ctx.quality != "audio":
            ydl_opts['merge_output_format'] = 'mp4'
    else:
        logger.warning(f"ffmpeg not found at {FFMPEG_PATH}. Merging might fail!")
        
    try:
        import yt_dlp
    except ImportError:
        logger.error("yt_dlp python module not found!")
        _update_db(ctx, status="error", error_message="yt_dlp module is missing. Please run: pip install yt-dlp")
        return
        
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info_dict = ydl.extract_info(ctx.url, download=True)
            if info_dict is None:
                raise Exception("Failed to extract video information or video unavailable.")
                
            logger.success(f"yt-dlp download {ctx.id} finished processing.")
            # Check if user requested pause during post-processing (ffmpeg merge/convert)
            if ctx.stop_event.is_set():
                logger.info(f"yt-dlp download {ctx.id} was paused during post-processing, marking as paused.")
                _update_db(ctx, progress=100.0, status="paused")
            else:
                _update_db(ctx, progress=100.0, status="completed")
            # Clean up any leftover yt-dlp temp files after successful completion
            _cleanup_ytdlp_temps(video_dir)
            
    except Exception as e:
        if "Download paused/stopped by user" in str(e):
            logger.info(f"yt-dlp download {ctx.id} paused/stopped.")
            _update_db(ctx, status="paused")
            # Do NOT clean up part files on pause so it can resume
        else:
            logger.exception(f"yt-dlp error for {ctx.id}: {e}")
            try:
                domain = urlparse(ctx.url).netloc if ctx.url else "unknown"
                report_exception(e, context=f"yt-dlp error ({ctx.title or ctx.url})", domain=domain)
            except Exception:
                pass
            _update_db(ctx, status="error", error_message=str(e))
            # Clean up temp files only on hard error
            _cleanup_ytdlp_temps(video_dir)

async def _download_chunk_async(ctx, session, start, end, part_num, final_path, downloaded_list, total_size, start_time, lock, last_update_list):
    part_path = f"{final_path}.part{part_num}"
    
    # Resume capability: check if part exists and its size
    existing_size = 0
    if os.path.exists(part_path):
        existing_size = os.path.getsize(part_path)
    
    # If the part is completely downloaded, skip
    if existing_size >= (end - start + 1):
        async with lock:
            downloaded_list[0] += (end - start + 1)
            last_update_list[1] += (end - start + 1)
        return part_path

    if existing_size > 0:
        async with lock:
            downloaded_list[0] += existing_size
            last_update_list[1] += existing_size

    # Adjust start byte based on what we already have
    current_start = start + existing_size
    headers = {"Range": f"bytes={current_start}-{end}"}
    if ctx.user_agent:
        headers["User-Agent"] = ctx.user_agent
    if ctx.cookies:
        headers["Cookie"] = ctx.cookies
    
    try:
        # Append mode if resuming, write if starting fresh
        mode = "ab" if existing_size > 0 else "wb"
        async with session.get(ctx.url, headers=headers) as response:
            if response.status not in (200, 206):
                raise Exception(f"Failed to fetch chunk {part_num}. Status: {response.status}")
                
            async with aiofiles.open(part_path, mode) as f:
                async for chunk in response.content.iter_chunked(65536):
                    if ctx.stop_event.is_set():
                        return False
                    
                    if chunk:
                        await f.write(chunk)
                        async with lock:
                            downloaded_list[0] += len(chunk)
                            now = time.time()
                            if now - last_update_list[0] > 0.5:
                                prog = (downloaded_list[0] / total_size) * 100
                                current_speed = (downloaded_list[0] - last_update_list[1]) / (now - last_update_list[0]) if now > last_update_list[0] else 0
                                _update_db(ctx, progress=prog, speed=current_speed, downloaded=downloaded_list[0])
                                last_update_list[0] = now
                                last_update_list[1] = downloaded_list[0]
                                
                        if GLOBAL_SPEED_LIMIT_KBPS > 0:
                            # Throttle speed across chunks
                            expected_time = len(chunk) / (GLOBAL_SPEED_LIMIT_KBPS * 1024 / max(1, ctx.num_threads))
                            await asyncio.sleep(min(0.5, expected_time))
                                
        return part_path
    except Exception as e:
        logger.error(f"Error in chunk {part_num} for {ctx.id}: {e}")
        raise e

# --- Universal File Extension & Filename Extraction Utilities ---

# Server scripts and web pages that should NEVER be treated as target download filenames
SERVER_SCRIPT_EXTENSIONS = {
    '.php', '.asp', '.aspx', '.jsp', '.jspx', '.do', '.action', '.cgi',
    '.pl', '.cfm', '.html', '.htm', '.shtml', '.xhtml'
}

# Domains that are video/audio streaming services (handled by yt-dlp)
STREAMING_DOMAINS = {
    'youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com', 'facebook.com',
    'fb.watch', 'twitter.com', 'x.com', 'twitch.tv', 'vimeo.com',
    'dailymotion.com', 'soundcloud.com', 'reddit.com'
}

# Non-media direct file extensions. If ANY of these appear in path or query,
# the URL is 100% a direct file download and MUST NEVER be sent to yt-dlp.
NON_MEDIA_DIRECT_EXTENSIONS = {
    # Programs & Installers
    '.exe', '.msi', '.msix', '.appx', '.appimage', '.dmg', '.pkg', '.deb',
    '.rpm', '.apk', '.aab', '.xapk', '.snap', '.flatpak', '.run', '.bin',
    '.jar', '.war', '.ear',
    # Archives & Compressed
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.zst', '.lz',
    '.lzma', '.tgz', '.tbz2', '.txz', '.cab', '.iso', '.img', '.vhd',
    '.vmdk', '.ova', '.qcow2', '.wim', '.z', '.lz4', '.br', '.zstd',
    # Documents & Ebooks
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
    '.ods', '.odp', '.rtf', '.txt', '.csv', '.tsv', '.epub', '.mobi',
    '.azw3', '.djvu', '.xps', '.pages', '.numbers', '.key',
    # Fonts
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    # Data & Config
    '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
    '.sql', '.db', '.sqlite', '.sqlite3', '.bak', '.dat', '.log',
    # Misc
    '.torrent', '.nfo', '.srt', '.sub', '.ass', '.vtt', '.ics',
    '.vcf', '.gpx', '.kml', '.kmz',
}

# Direct media extensions
DIRECT_MEDIA_EXTENSIONS = {
    # Video
    '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
    '.3gp', '.3g2', '.ts', '.mts', '.m2ts', '.vob', '.ogv', '.mpg',
    '.mpeg', '.divx', '.asf', '.rm', '.rmvb', '.f4v',
    # Audio
    '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.opus',
    '.aiff', '.aif', '.mid', '.midi', '.ape', '.alac', '.dsf', '.dff',
    '.tak', '.tta', '.mka', '.ac3', '.dts', '.pcm',
    # Images
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico',
    '.tiff', '.tif', '.psd', '.ai', '.eps', '.raw', '.cr2', '.nef',
    '.arw', '.dng', '.heic', '.heif', '.avif', '.jxl',
}

KNOWN_EXTENSIONS = NON_MEDIA_DIRECT_EXTENSIONS | DIRECT_MEDIA_EXTENSIONS

# MIME type -> extension mapping for last-resort inference
MIME_TO_EXT = {
    'application/x-msdownload': '.exe', 'application/x-msi': '.msi',
    'application/x-dosexec': '.exe',
    'application/zip': '.zip', 'application/x-rar-compressed': '.rar',
    'application/x-7z-compressed': '.7z', 'application/x-tar': '.tar',
    'application/gzip': '.gz', 'application/x-bzip2': '.bz2',
    'application/x-xz': '.xz', 'application/zstd': '.zst',
    'application/x-iso9660-image': '.iso',
    'application/pdf': '.pdf',
    'application/vnd.android.package-archive': '.apk',
    'application/x-apple-diskimage': '.dmg',
    'application/octet-stream': '',  # generic, no extension to infer
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/msword': '.doc', 'application/vnd.ms-excel': '.xls',
    'application/vnd.ms-powerpoint': '.ppt',
    'video/mp4': '.mp4', 'video/x-matroska': '.mkv', 'video/webm': '.webm',
    'video/x-msvideo': '.avi', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/flac': '.flac',
    'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/webm': '.webm',
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/svg+xml': '.svg',
}

def looks_like_filename(val: str) -> bool:
    """Check if a string looks like a valid filename with a known file extension."""
    if not val or len(val) < 3:
        return False
    clean = val.split('?')[0].split('#')[0]
    basename = os.path.basename(clean)
    if not basename or len(basename) < 3:
        return False
    ext = os.path.splitext(basename)[1].lower()
    return ext in KNOWN_EXTENSIONS and ext not in SERVER_SCRIPT_EXTENSIONS

def extract_filename_from_query(query_str: str) -> Optional[str]:
    """
    Universally inspects ALL query parameters in a query string for filenames.
    Works for any CDN or web service (Broadcom, S3, Azure, Cloudflare, etc.)
    regardless of whether parameters are named 'file', 'name', 'token', or random keys.
    Also handles embedded Content-Disposition (e.g. AWS S3 response-content-disposition).
    """
    if not query_str:
        return None
    
    from urllib.parse import parse_qs, unquote
    parsed_qs = parse_qs(query_str, keep_blank_values=False)
    candidates = []

    for param_name, values in parsed_qs.items():
        param_name_lower = param_name.lower()
        for raw_val in values:
            if not raw_val or len(raw_val) < 3:
                continue
            
            # 1. Check for embedded Content-Disposition inside query param
            m_utf8 = re.search(r"filename\*\s*=\s*UTF-8''(.+?)(?:;|$|&)", raw_val, re.IGNORECASE)
            if m_utf8:
                fn = unquote(m_utf8.group(1)).strip().strip('"\'')
                if looks_like_filename(fn):
                    candidates.append((200, fn))
                    continue
            m = re.search(r'filename\s*=\s*"?([^";&]+)"?', raw_val, re.IGNORECASE)
            if m:
                fn = unquote(m.group(1)).strip().strip('"\'')
                if looks_like_filename(fn):
                    candidates.append((200, fn))
                    continue

            # 2. Decode value and strip secondary query/fragment
            decoded = unquote(raw_val)
            clean_val = decoded.split('?')[0].split('#')[0]
            basename = os.path.basename(clean_val)

            if basename and len(basename) >= 3 and looks_like_filename(basename):
                # Calculate priority score
                score = 10
                # High priority if parameter name commonly denotes a filename
                if any(k in param_name_lower for k in ['file', 'filename', 'name', 'dl', 'download', 'package', 'asset', 'path']):
                    score += 50
                # Bonus if extension is an explicit software installer or archive
                ext = os.path.splitext(basename)[1].lower()
                if ext in NON_MEDIA_DIRECT_EXTENSIONS:
                    score += 30
                # Tie-breaker: prefer longer descriptive names
                score += min(len(basename), 30)
                candidates.append((score, basename))

    if candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        return candidates[0][1]
    
    return None

def detect_filename_from_url(url: str) -> Optional[str]:
    """
    Extracts a filename from a URL by inspecting both the path and all query parameters.
    Gives priority to query parameter filenames if the path is generic or a server script.
    """
    if not url:
        return None
    try:
        from urllib.parse import urlparse, unquote
        parsed = urlparse(url)
        path_name = os.path.basename(unquote(parsed.path))
        path_ext = os.path.splitext(path_name)[1].lower() if path_name else ""

        # Check query string first (any query parameter)
        query_fn = extract_filename_from_query(parsed.query)

        if query_fn:
            # If path has no extension, or is a server script (.php, .asp, etc.),
            # or is generic (e.g. 'download', 'file', 'get', 'index'), query filename WINS.
            if (not path_ext or 
                path_ext in SERVER_SCRIPT_EXTENSIONS or 
                path_ext not in KNOWN_EXTENSIONS or
                path_name.lower() in {'download', 'get', 'file', 'index', 'api', 'v1', 'v2'}):
                return query_fn
            # If both have known extensions, prefer query if it's a dedicated installer/archive
            query_ext = os.path.splitext(query_fn)[1].lower()
            if query_ext in NON_MEDIA_DIRECT_EXTENSIONS and path_ext not in NON_MEDIA_DIRECT_EXTENSIONS:
                return query_fn
            return query_fn

        # Otherwise check path name
        if path_name and len(path_name) >= 3 and path_ext in KNOWN_EXTENSIONS and path_ext not in SERVER_SCRIPT_EXTENSIONS:
            return path_name
            
        return None
    except Exception:
        return None

def extract_filename(headers, original_url, final_url=None) -> str:
    """
    Universal filename extractor. Works with any URL structure:
    - Content-Disposition header (RFC 5987 / RFC 6266)
    - URL query parameter scanner (handles any parameter key)
    - URL path basename
    - Content-Type → extension inference as last resort
    """
    from urllib.parse import urlparse, unquote
    headers = headers or {}
    filename = None
    content_disposition = headers.get('Content-Disposition') or headers.get('content-disposition', '')
    
    # Priority 1: Content-Disposition header (most reliable from server)
    if content_disposition:
        m_utf8 = re.search(r"filename\*\s*=\s*UTF-8''(.+?)(?:;|$)", content_disposition, re.IGNORECASE)
        if m_utf8:
            filename = unquote(m_utf8.group(1).strip()).strip('"\'')
        else:
            m = re.search(r'filename\s*=\s*"?([^";]+)"?', content_disposition, re.IGNORECASE)
            if m:
                filename = m.group(1).strip().strip('"\'')

    # Priority 2: Extract from final_url or original_url (query params + path)
    if not filename or not looks_like_filename(filename):
        for candidate_url in [final_url, original_url]:
            if candidate_url:
                detected = detect_filename_from_url(candidate_url)
                if detected:
                    filename = detected
                    break

    # Priority 3: Path basename fallback (even if extension unknown, if not a script)
    if not filename or filename == '/' or len(filename) < 2:
        for candidate_url in [final_url, original_url]:
            if candidate_url:
                try:
                    p = unquote(urlparse(candidate_url).path)
                    bn = os.path.basename(p.rstrip('/'))
                    ext = os.path.splitext(bn)[1].lower()
                    if bn and len(bn) >= 3 and ext not in SERVER_SCRIPT_EXTENSIONS:
                        filename = bn
                        break
                except Exception:
                    pass

    # Priority 4: Content-Type MIME inference
    content_type = (headers.get('Content-Type') or headers.get('content-type', '')).split(';')[0].strip().lower()
    inferred_ext = MIME_TO_EXT.get(content_type, '')

    if not filename or filename == '/' or len(filename) < 2 or filename == 'downloaded_file':
        if inferred_ext:
            try:
                domain = urlparse(original_url).hostname or 'download'
                domain = domain.replace('www.', '').split('.')[0]
                filename = f"{domain}_download{inferred_ext}"
            except Exception:
                filename = f"downloaded_file{inferred_ext}"
        else:
            filename = "downloaded_file"
    elif inferred_ext:
        # If we have a filename but it lacks an extension, append inferred one
        _base, _ext = os.path.splitext(filename)
        if not _ext or _ext.lower() not in KNOWN_EXTENSIONS:
            filename = _base + inferred_ext

    # Sanitize for Windows filesystems
    filename = re.sub(r'[<>:"/\\|?*]', '_', filename).strip().rstrip('. ')
    if len(filename) > 240:
        base, ext = os.path.splitext(filename)
        filename = base[:240 - len(ext)] + ext
    if not filename:
        filename = "downloaded_file"
    return filename

# Backward-compatibility alias for internal callers
_extract_filename = extract_filename

async def _run_chunked_download_async(ctx: DownloadContext):
    logger.info(f"Starting async chunk download: {ctx.id}")
    
    # Default browser-like headers for direct file downloads
    default_ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    
    try:
        # Build connector with longer timeouts for large files
        timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_read=60)
        connector = aiohttp.TCPConnector(limit=32, force_close=False, enable_cleanup_closed=True)
        
        async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
            headers = {
                'User-Agent': ctx.user_agent or default_ua,
                'Accept': '*/*',
                'Accept-Encoding': 'identity',
                'Connection': 'keep-alive',
            }
            if ctx.cookies:
                headers['Cookie'] = ctx.cookies
            if ctx.referer:
                headers['Referer'] = ctx.referer
                
            # Try HEAD first, fallback to GET range=0-0
            head_status = 0
            head_headers = {}
            final_url = ctx.url
            last_error_msg = None
            
            try:
                async with session.head(ctx.url, allow_redirects=True, headers=headers) as head_req:
                    head_status = head_req.status
                    head_headers = head_req.headers
                    final_url = str(head_req.url)
            except Exception as e:
                last_error_msg = str(e)
                logger.warning(f"HEAD request failed for {ctx.id}: {e}")
            
            # If HEAD failed or returned 403/405, retry with GET range=0-0
            if head_status not in (200, 206):
                try:
                    range_headers = {**headers, 'Range': 'bytes=0-0'}
                    async with session.get(ctx.url, headers=range_headers, allow_redirects=True) as get_req:
                        head_status = get_req.status
                        head_headers = get_req.headers
                        final_url = str(get_req.url)
                except Exception as e:
                    last_error_msg = str(e)
                    logger.warning(f"GET range request failed for {ctx.id}: {e}")
            
            # If still 403, retry with a referer header (some CDNs require it)
            if head_status == 403:
                try:
                    parsed = urlparse(ctx.url)
                    referer = f"{parsed.scheme}://{parsed.netloc}/"
                    retry_headers = {**headers, 'Referer': referer}
                    async with session.head(ctx.url, allow_redirects=True, headers=retry_headers) as retry_req:
                        if retry_req.status in (200, 206):
                            head_status = retry_req.status
                            head_headers = retry_req.headers
                            final_url = str(retry_req.url)
                            headers['Referer'] = referer
                except Exception:
                    pass
            
            if head_status not in (200, 206):
                if head_status == 0 and last_error_msg:
                    raise Exception(f"Network error: {last_error_msg}")
                else:
                    raise Exception(f"Server returned status {head_status}. The link may require login or cookies.")
                
            total_size = int(head_headers.get('Content-Length', 0))
            
            # --- Extract filename properly ---
            filename = _extract_filename(head_headers, ctx.url, final_url)
            
            if ctx.save_path:
                cat_dir = ctx.save_path
                os.makedirs(cat_dir, exist_ok=True)
            else:
                cat_dir = get_category_dir(filename)
            final_path = os.path.join(cat_dir, filename)
            
            _update_db(ctx, total_size=total_size, filename=filename, status="downloading")
            logger.info(f"Download size for {ctx.id}: {total_size} bytes. Filename: {filename}. Target: {final_path}")
            
            if total_size == 0 or head_headers.get('Accept-Ranges') != 'bytes':
                logger.warning(f"Server does not support range requests for {ctx.id}, falling back to single stream.")
                await _normal_download_async(ctx, session, final_path, total_size, headers)
                return

            num_threads = calculate_optimal_threads(total_size)
            ctx.num_threads = num_threads
            chunk_size = total_size // num_threads
            downloaded = [0]
            lock = asyncio.Lock()
            
            # To calculate speed accurately on resume, we shouldn't count existing size in elapsed speed
            # But for simplicity in progress bar we accumulate total downloaded
            start_time = time.time()
            last_update = [time.time(), 0]
            
            tasks = []
            for i in range(num_threads):
                start = i * chunk_size
                end = (i + 1) * chunk_size - 1 if i < num_threads - 1 else total_size - 1
                tasks.append(_download_chunk_async(ctx, session, start, end, i, final_path, downloaded, total_size, start_time, lock, last_update))
                
            logger.info(f"Awaiting {num_threads} async chunk tasks for {ctx.id}")
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            if ctx.stop_event.is_set():
                logger.info(f"Download {ctx.id} paused.")
                _update_db(ctx, status="paused")
                # DO NOT clean up .part files on pause so it can resume
                return
                
            for res in results:
                if isinstance(res, Exception):
                    raise res
                    
            logger.info(f"Merging chunks for {ctx.id}")
            _update_db(ctx, status="processing")
            async with aiofiles.open(final_path, "wb") as outfile:
                for part in [r for r in results if r]:
                    async with aiofiles.open(part, "rb") as infile:
                        while True:
                            buffer = await infile.read(1024 * 1024) # 1MB buffer
                            if not buffer:
                                break
                            await outfile.write(buffer)
                    try:
                        os.remove(part)
                    except Exception:
                        pass
                    
            logger.success(f"Chunked download {ctx.id} completed successfully.")
            _update_db(ctx, progress=100.0, status="completed", downloaded=total_size)
            import gc; gc.collect()
        
    except Exception as e:
        logger.exception(f"Async chunk download error for {ctx.id}: {e}")
        try:
            domain = urlparse(ctx.url).netloc if ctx.url else "unknown"
            report_exception(e, context=f"Chunk download error ({ctx.filename or ctx.url})", domain=domain)
        except Exception:
            pass
        _update_db(ctx, status="error", error_message=str(e))
        # DO NOT clean up part files on error, allow the user to retry/resume

async def _normal_download_async(ctx: DownloadContext, session, path, total_size, extra_headers=None):
    try:
        start_time = time.time()
        actual_total = total_size

        headers = extra_headers.copy() if extra_headers else {}
        if ctx.user_agent and 'User-Agent' not in headers:
            headers['User-Agent'] = ctx.user_agent
        if ctx.cookies and 'Cookie' not in headers:
            headers['Cookie'] = ctx.cookies

        # Resume support: check for existing partial file
        existing_size = 0
        file_mode = 'wb'
        if os.path.exists(path):
            existing_size = os.path.getsize(path)
            if existing_size > 0 and actual_total > 0 and existing_size < actual_total:
                headers['Range'] = f'bytes={existing_size}-'
                file_mode = 'ab'
                logger.info(f"Resuming normal download {ctx.id} from byte {existing_size}")
            elif existing_size > 0 and existing_size >= actual_total and actual_total > 0:
                # File is already complete
                logger.info(f"Normal download {ctx.id} already complete on disk.")
                _update_db(ctx, progress=100.0, status='completed', downloaded=actual_total, total_size=actual_total)
                return

        downloaded = [existing_size]
        last_update = [time.time(), existing_size]

        async with session.get(ctx.url, headers=headers, allow_redirects=True) as response:
            # If server doesn't support Range (returns 200 instead of 206), start fresh
            if existing_size > 0 and response.status == 200:
                existing_size = 0
                downloaded[0] = 0
                last_update[1] = 0
                file_mode = 'wb'

            # Update total_size from response if HEAD didn't provide it
            if actual_total == 0:
                actual_total = int(response.headers.get('Content-Length', 0))
                if existing_size > 0 and response.status == 206:
                    actual_total += existing_size
                if actual_total > 0:
                    _update_db(ctx, total_size=actual_total)
            
            # Also try to get filename from the actual response if we had a generic name
            resp_filename = _extract_filename(response.headers, ctx.url, str(response.url))
            if resp_filename and resp_filename != 'downloaded_file':
                current_dir = os.path.dirname(path)
                path = os.path.join(current_dir, resp_filename)
                _update_db(ctx, filename=resp_filename, status='downloading')
            else:
                _update_db(ctx, status='downloading')
            
            async with aiofiles.open(path, file_mode) as f:
                async for chunk in response.content.iter_chunked(131072):
                    if ctx.stop_event.is_set():
                        _update_db(ctx, status='paused')
                        return
                    
                    if chunk:
                        await f.write(chunk)
                        downloaded[0] += len(chunk)
                        
                        now = time.time()
                        if now - last_update[0] > 0.5:
                            prog = (downloaded[0] / actual_total) * 100 if actual_total > 0 else 0
                            current_speed = (downloaded[0] - last_update[1]) / (now - last_update[0]) if now > last_update[0] else 0
                            _update_db(ctx, progress=prog, speed=current_speed, downloaded=downloaded[0], status='downloading')
                            last_update[0] = now
                            last_update[1] = downloaded[0]
                        if GLOBAL_SPEED_LIMIT_KBPS > 0:
                            expected_time = len(chunk) / (GLOBAL_SPEED_LIMIT_KBPS * 1024)
                            await asyncio.sleep(min(0.5, expected_time))

        final_size = downloaded[0] if downloaded[0] > 0 else actual_total
        logger.success(f"Normal download {ctx.id} completed successfully. Size: {final_size}")
        _update_db(ctx, progress=100.0, status='completed', downloaded=final_size, total_size=final_size)
        import gc; gc.collect()
    except Exception as e:
        logger.exception(f"Normal download error for {ctx.id}: {e}")
        try:
            domain = urlparse(ctx.url).netloc if ctx.url else "unknown"
            report_exception(e, context=f"Normal download error ({ctx.filename or ctx.url})", domain=domain)
        except Exception:
            pass
        _update_db(ctx, status='error', error_message=str(e))


def _cleanup_ytdlp_temps(directory: str):
    """Remove yt-dlp temporary files (.part, .ytdl, .part-Frag*) from a directory."""
    try:
        if not os.path.isdir(directory):
            return
        cleaned = 0
        for f in os.listdir(directory):
            fp = os.path.join(directory, f)
            if os.path.isfile(fp) and (f.endswith('.part') or f.endswith('.ytdl') or '.part-Frag' in f or f.endswith('.temp')):
                try:
                    os.remove(fp)
                    cleaned += 1
                    logger.info(f"Cleaned yt-dlp temp: {fp}")
                except Exception as e:
                    logger.warning(f"Could not remove {fp}: {e}")
        if cleaned > 0:
            logger.success(f"Cleaned {cleaned} yt-dlp temp file(s) from {directory}")
    except Exception as e:
        logger.error(f"Error cleaning yt-dlp temps: {e}")


def _cleanup_part_files(final_path: str, num_parts: int = 32):
    """Remove .part0, .part1, ... chunk files for a given download path."""
    try:
        cleaned = 0
        for i in range(num_parts):
            part_path = f"{final_path}.part{i}"
            if os.path.exists(part_path):
                try:
                    os.remove(part_path)
                    cleaned += 1
                    logger.info(f"Cleaned chunk part: {part_path}")
                except Exception as e:
                    logger.warning(f"Could not remove {part_path}: {e}")
        if cleaned > 0:
            logger.success(f"Cleaned {cleaned} chunk part file(s) for {final_path}")
    except Exception as e:
        logger.error(f"Error cleaning part files: {e}")
