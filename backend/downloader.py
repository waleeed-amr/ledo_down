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

import sys

def get_base_dir():
    if getattr(sys, 'frozen', False):
        return os.path.abspath(os.path.join(os.path.dirname(sys.executable), "..", "..", ".."))
    else:
        return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

BASE_DIR = get_base_dir()
YT_DLP_PATH = os.path.abspath(os.path.join(BASE_DIR, "yt-dlp.exe"))
if not os.path.exists(YT_DLP_PATH):
    YT_DLP_PATH = shutil.which("yt-dlp") or "yt-dlp"

def get_default_downloads_dir():
    if getattr(sys, 'frozen', False):
        return os.path.join(os.path.expanduser('~'), 'Downloads', 'Ledo Downloader')
    else:
        return os.path.abspath(os.path.join(BASE_DIR, "downloads"))

BASE_DOWNLOAD_DIR = get_default_downloads_dir()

# File Categories
CATEGORIES = {
    "Videos": [".mp4", ".mkv", ".avi", ".flv", ".mov"],
    "Audio": [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".webm"],
    "Archives": [".zip", ".rar", ".7z", ".tar", ".gz", ".iso"],
    "Documents": [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt"],
    "Programs": [".exe", ".msi", ".apk", ".dmg"]
}

def get_category_dir(filename):
    ext = os.path.splitext(filename)[1].lower()
    for cat, exts in CATEGORIES.items():
        if ext in exts:
            cat_dir = os.path.join(BASE_DOWNLOAD_DIR, cat)
            os.makedirs(cat_dir, exist_ok=True)
            return cat_dir
    
    other_dir = os.path.join(BASE_DOWNLOAD_DIR, "Others")
    os.makedirs(other_dir, exist_ok=True)
    return other_dir

active_downloads = {}
download_semaphore = threading.Semaphore(2)

class DownloadContext:
    def __init__(self, download_id, url, on_update, save_path=None, quality="best", cookies=None, user_agent=None):
        self.id = download_id
        self.url = url
        self.on_update = on_update
        self.save_path = save_path
        self.quality = quality
        self.cookies = cookies
        self.user_agent = user_agent
        self.stop_event = threading.Event()
        self.thread_stop_event = threading.Event()
        self.process = None

def start_download(url, db, use_ytdlp=False, on_update=None, save_path=None, quality="best", cookies=None, user_agent=None):
    if save_path:
        norm_path = os.path.normpath(save_path)
        if not os.path.isabs(norm_path):
            norm_path = os.path.join(BASE_DOWNLOAD_DIR, norm_path)
        norm_path = os.path.abspath(norm_path)
        
        base_abs = os.path.abspath(BASE_DOWNLOAD_DIR)
        try:
            common = os.path.commonpath([base_abs, norm_path])
            if common != base_abs:
                raise ValueError("Invalid save_path: Cannot save outside the base download directory.")
        except ValueError:
            # commonpath raises ValueError if paths are on different drives on Windows
            raise ValueError("Invalid save_path: Cannot save outside the base download directory.")
            
        save_path = norm_path

    download_id = str(uuid.uuid4())
    logger.info(f"Preparing download {download_id} for URL: {url} | yt-dlp: {use_ytdlp} | Quality: {quality}")
    
    db_rec = DownloadRecord(
        id=download_id,
        url=url,
        is_yt_dlp=use_ytdlp,
        status="starting",
        filename="",
        total_size=0,
        downloaded=0,
        speed=0,
        progress=0.0
    )
    db.add(db_rec)
    db.commit()
    
    ctx = DownloadContext(download_id, url, on_update, save_path, quality, cookies, user_agent)
    active_downloads[download_id] = ctx
    
    if use_ytdlp:
        thread = threading.Thread(target=_run_ytdlp, args=(ctx,))
        thread.daemon = True
        thread.start()
    else:
        def run_async_download():
            asyncio.run(_run_chunked_download_async(ctx))
        
        thread = threading.Thread(target=run_async_download)
        thread.daemon = True
        thread.start()
        
    return download_id

def _update_db(ctx, **kwargs):
    db = SessionLocal()
    try:
        rec = db.query(DownloadRecord).filter(DownloadRecord.id == ctx.id).first()
        if rec:
            for k, v in kwargs.items():
                setattr(rec, k, v)
            db.commit()
    except Exception as e:
        logger.error(f"Database update failed for {ctx.id}: {e}")
    finally:
        db.close()
        
    if ctx.on_update:
        ctx.on_update(ctx.id)

def _run_ytdlp(ctx: DownloadContext):
    logger.info(f"Queued yt-dlp download: {ctx.id}. Waiting for available slot...")
    
    with download_semaphore:
        if ctx.thread_stop_event.is_set() or ctx.stop_event.is_set():
            return
            
        logger.info(f"Starting yt-dlp download: {ctx.id}")
        _update_db(ctx, status="downloading")
    
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
            
    video_dir = ctx.save_path if ctx.save_path else os.path.join(BASE_DOWNLOAD_DIR, "Videos")
    os.makedirs(video_dir, exist_ok=True)
    
    FFMPEG_PATH = os.path.abspath(os.path.join(BASE_DIR, "ffmpeg.exe"))
    if not os.path.exists(FFMPEG_PATH):
        FFMPEG_PATH = shutil.which("ffmpeg")
    if not FFMPEG_PATH or not os.path.exists(FFMPEG_PATH):
        fallback_path = r"C:\build\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"
        if os.path.exists(fallback_path):
            FFMPEG_PATH = fallback_path
    
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
    
    if ctx.user_agent:
        ydl_opts['http_headers']['User-Agent'] = ctx.user_agent
        
    if ctx.cookies:
        ydl_opts['http_headers']['Cookie'] = ctx.cookies
    
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
                
            logger.success(f"yt-dlp download {ctx.id} completed.")
            _update_db(ctx, progress=100.0, status="completed")
            # Clean up any leftover yt-dlp temp files after successful completion
            _cleanup_ytdlp_temps(video_dir)
            
    except Exception as e:
        if "Download paused/stopped by user" in str(e):
            logger.info(f"yt-dlp download {ctx.id} paused/stopped.")
            _update_db(ctx, status="paused")
        else:
            logger.exception(f"yt-dlp error for {ctx.id}: {e}")
            _update_db(ctx, status="error", error_message=str(e))
        # Clean up temp files on error/pause
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
        return part_path

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
                                
        return part_path
    except Exception as e:
        logger.error(f"Error in chunk {part_num} for {ctx.id}: {e}")
        raise e

def _extract_filename(headers, original_url, final_url):
    import re
    from urllib.parse import urlparse, unquote
    
    filename = None
    content_disposition = headers.get('Content-Disposition', '')
    
    if content_disposition:
        # Check for RFC 5987 filename*=UTF-8''...
        m_utf8 = re.search(r"filename\*=UTF-8''(.+)", content_disposition, re.IGNORECASE)
        if m_utf8:
            filename = unquote(m_utf8.group(1))
        else:
            # Check for regular filename="..."
            m = re.search(r'filename="?([^"]+)"?', content_disposition)
            if m:
                filename = m.group(1)
                
    if not filename:
        # Fallback to URL path
        parsed_path = unquote(urlparse(final_url).path)
        filename = os.path.basename(parsed_path)
        
        if not filename or len(filename) < 3:
            # Try original URL
            parsed_path_orig = unquote(urlparse(original_url).path)
            filename = os.path.basename(parsed_path_orig)
            
    if not filename or filename == '/' or len(filename) < 2:
        filename = "downloaded_file"
        
    # Clean up weird characters that might be invalid on Windows
    filename = re.sub(r'[<>:"/\\|?*]', '_', filename)
    return filename

async def _run_chunked_download_async(ctx: DownloadContext):
    logger.info(f"Starting async chunk download: {ctx.id}")
    _update_db(ctx, status="downloading")
    num_threads = 16
    
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
                
            # Try HEAD first, fallback to GET range=0-0
            head_status = 0
            head_headers = {}
            final_url = ctx.url
            
            try:
                async with session.head(ctx.url, allow_redirects=True, headers=headers) as head_req:
                    head_status = head_req.status
                    head_headers = head_req.headers
                    final_url = str(head_req.url)
            except Exception as e:
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
            
            _update_db(ctx, total_size=total_size, filename=filename)
            logger.info(f"Download size for {ctx.id}: {total_size} bytes. Filename: {filename}. Target: {final_path}")
            
            if total_size == 0 or head_headers.get('Accept-Ranges') != 'bytes':
                logger.warning(f"Server does not support range requests for {ctx.id}, falling back to single stream.")
                await _normal_download_async(ctx, session, final_path, total_size, headers)
                return

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
                # Clean up .part chunk files on pause
                _cleanup_part_files(final_path, num_threads)
                return
                
            for res in results:
                if isinstance(res, Exception):
                    raise res
                    
            logger.info(f"Merging chunks for {ctx.id}")
            async with aiofiles.open(final_path, "wb") as outfile:
                # asyncio.gather preserves the order of tasks, so results are already correctly ordered from part 0 to part N.
                # Sorting them alphabetically was breaking the file structure (part10 before part2).
                for part in [r for r in results if r]:
                    async with aiofiles.open(part, "rb") as infile:
                        content = await infile.read()
                        await outfile.write(content)
                    os.remove(part)
                    
            logger.success(f"Chunked download {ctx.id} completed successfully.")
            _update_db(ctx, progress=100.0, status="completed", downloaded=total_size)
        
    except Exception as e:
        logger.exception(f"Async chunk download error for {ctx.id}: {e}")
        _update_db(ctx, status="error", error_message=str(e))
        # Clean up .part chunk files on error
        try:
            _cleanup_part_files(final_path, num_threads)
        except Exception:
            pass

async def _normal_download_async(ctx: DownloadContext, session, path, total_size, extra_headers=None):
    try:
        start_time = time.time()
        downloaded = [0]
        last_update = [time.time(), 0]
        actual_total = total_size

        headers = extra_headers.copy() if extra_headers else {}
        if ctx.user_agent and 'User-Agent' not in headers:
            headers['User-Agent'] = ctx.user_agent
        if ctx.cookies and 'Cookie' not in headers:
            headers['Cookie'] = ctx.cookies

        async with session.get(ctx.url, headers=headers, allow_redirects=True) as response:
            # Update total_size from response if HEAD didn't provide it
            if actual_total == 0:
                actual_total = int(response.headers.get('Content-Length', 0))
                if actual_total > 0:
                    _update_db(ctx, total_size=actual_total)
            
            # Also try to get filename from the actual response if we had a generic name
            resp_filename = _extract_filename(response.headers, ctx.url, str(response.url))
            if resp_filename and resp_filename != 'downloaded_file':
                current_dir = os.path.dirname(path)
                path = os.path.join(current_dir, resp_filename)
                _update_db(ctx, filename=resp_filename)
            
            async with aiofiles.open(path, 'wb') as f:
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
                            _update_db(ctx, progress=prog, speed=current_speed, downloaded=downloaded[0])
                            last_update[0] = now
                            last_update[1] = downloaded[0]

        final_size = downloaded[0] if downloaded[0] > 0 else actual_total
        logger.success(f"Normal download {ctx.id} completed successfully. Size: {final_size}")
        _update_db(ctx, progress=100.0, status='completed', downloaded=final_size, total_size=final_size)
    except Exception as e:
        logger.exception(f"Normal download error for {ctx.id}: {e}")
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
