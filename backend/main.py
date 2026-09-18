import asyncio
import psutil
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, BackgroundTasks, concurrency
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx
from typing import Optional, List
import uvicorn
import os
import sys
import time

# FIX for [Errno 22] Invalid argument in PyInstaller --noconsole mode
# When running without a console, standard streams are None. This causes
# yt-dlp and subprocesses to crash wi th Errno 22 when they try to inherit handles.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")
if sys.stdin is None:
    sys.stdin = open(os.devnull, "r")

current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

import orjson
from loguru import logger
from sqlalchemy.orm import Session

from database import get_db, DownloadRecord, SessionLocal
from downloader import (
    start_download, active_downloads, get_category_dir, BASE_DOWNLOAD_DIR,
    set_speed_limit, get_speed_limit, set_max_concurrent, get_max_concurrent,
    set_auto_categorize, set_base_download_dir
)
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi.responses import FileResponse
from datetime import datetime
import os

scheduler = AsyncIOScheduler()

# Configure Loguru for robust error tracking and stability monitoring
logger.remove()
logger.add(sys.stdout, format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>")
# File logging enabled to help debug "paralyzed" app issues
logger.add("ledo_backend.log", rotation="10 MB", retention="10 days", level="INFO")

app = FastAPI(title="Ledo Downloader API - Core")
app_loop = None

# CORS middleware - restricted to prevent malicious websites from accessing the local API
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex="^null$|^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/health")
async def health_check():
    return {"status": "ok", "service": "Ledo Downloader Backend"}

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"WebSocket client connected. Total clients: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"WebSocket client disconnected. Total clients: {len(self.active_connections)}")

    async def broadcast(self, message: str):
        dead_connections = []
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.warning(f"Failed to send to a websocket client: {e}")
                dead_connections.append(connection)
        for connection in dead_connections:
            self.disconnect(connection)

manager = ConnectionManager()

class DownloadRequest(BaseModel):
    url: str
    is_yt_dlp: Optional[bool] = None
    save_path: Optional[str] = None
    quality: Optional[str] = "best"
    title: Optional[str] = None
    cookies: Optional[str] = None
    user_agent: Optional[str] = None
    referer: Optional[str] = None

class InfoRequest(BaseModel):
    url: str

class QuickAddRequest(BaseModel):
    url: str
    cookies: Optional[str] = None
    user_agent: Optional[str] = None
    referer: Optional[str] = None
    filename: Optional[str] = None
    file_size: Optional[int] = None
    mime_type: Optional[str] = None

class SettingsUpdateRequest(BaseModel):
    speed_limit_kbps: Optional[int] = None
    max_concurrent: Optional[int] = None
    auto_categorize: Optional[bool] = None
    download_path: Optional[str] = None

async def resolve_short_url(url: str) -> str:
    if "open.spotify.com/track/" in url or "spotify.link/" in url:
        try:
            if "spotify.link/" in url:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.head(url, follow_redirects=True)
                    url = str(resp.url)
            
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(url, follow_redirects=True)
                import re
                match = re.search(r'<title>(.*?)</title>', resp.text)
                if match:
                    title = match.group(1)
                    clean_title = title.replace('| Spotify', '').replace('- song and lyrics by', '').replace('- song by', '').strip()
                    logger.info(f"Resolved Spotify URL to search query: {clean_title}")
                    return f"ytsearch1:{clean_title} audio"
        except Exception as e:
            logger.warning(f"Failed to resolve spotify URL: {e}")

    if any(short in url for short in ["vt.tiktok.com", "vm.tiktok.com", "instagram.com/reel", "t.co/", "fb.watch"]):
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.head(url, follow_redirects=True)
                return str(resp.url)
        except Exception as e:
            logger.warning(f"Failed to resolve short URL: {e}")
    return url

async def check_is_direct_file(url: str, cookies: str = None, user_agent: str = None, referer: str = None) -> dict:
    try:
        default_ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        headers = {
            'User-Agent': user_agent or default_ua,
            'Accept': '*/*'
        }
        if referer:
            headers['Referer'] = referer
        if cookies:
            headers['Cookie'] = cookies
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
            resp = await client.head(url, headers=headers)
            if resp.status_code not in (200, 206):
                resp = await client.get(url, headers={"Range": "bytes=0-0", **headers})
                
            if resp.status_code in (200, 206):
                content_type = resp.headers.get('content-type', '').lower()
                content_dispo = resp.headers.get('content-disposition', '')
                
                # Check for direct file signatures
                is_direct = False
                
                # If it's an explicit attachment
                if 'attachment' in content_dispo.lower():
                    is_direct = True
                # If it's not HTML and not a typical API response (json), it's probably a file
                elif content_type and 'text/html' not in content_type and 'application/json' not in content_type:
                    is_direct = True
                else:
                    import os as _os
                    from urllib.parse import urlparse as _urlparse
                    
                    ext_final = _os.path.splitext(_urlparse(str(resp.url)).path)[1].lower()
                    ext_orig  = _os.path.splitext(_urlparse(url).path)[1].lower()
                    
                    target_exts = [
                        '.exe', '.msi', '.zip', '.rar', '.7z',
                        '.pdf', '.iso', '.apk', '.dmg',
                        '.tar', '.gz', '.bz2', '.xz', '.zst',
                        '.deb', '.rpm', '.pkg', '.jar'
                    ]
                    
                    if ext_final in target_exts or ext_orig in target_exts:
                        is_direct = True
                        
                if is_direct:
                    import re as _re, os as _os
                    from urllib.parse import urlparse as _urlparse, unquote as _unquote
                    filename = "downloaded_file"
                    if content_dispo:
                        # RFC 5987
                        m_utf8 = _re.search(r"filename\*=UTF-8''(.+)", content_dispo, _re.IGNORECASE)
                        if m_utf8:
                            filename = _unquote(m_utf8.group(1))
                        else:
                            m = _re.search('filename="?([^"]+)"?', content_dispo)
                            if m:
                                filename = m.group(1)
                    if filename == "downloaded_file":
                        parsed_name = _os.path.basename(_unquote(_urlparse(url).path))
                        if not parsed_name or len(parsed_name) < 3:
                            parsed_name = _os.path.basename(_unquote(_urlparse(str(resp.url)).path))
                        if parsed_name:
                            filename = parsed_name
                        
                    size = int(resp.headers.get('content-length', 0))
                    return {"is_direct": True, "title": filename, "size": size}
    except Exception as e:
        logger.warning(f"Direct file check failed: {e}")
    return {"is_direct": False}

@app.post("/api/quick-add")
async def trigger_quick_add(req: QuickAddRequest):
    if not req.url:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="URL is required")
    import urllib.parse
    parsed = urllib.parse.urlparse(req.url)
    if not parsed.scheme or not parsed.netloc:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Invalid URL format")
        
    logger.info(f"Received quick add trigger for URL: {req.url}")
    payload = {
        "type": "open_quick_add",
        "url": req.url,
        "cookies": req.cookies,
        "user_agent": req.user_agent,
        "referer": req.referer,
        "filename": req.filename,
        "file_size": req.file_size,
        "mime_type": req.mime_type
    }
    await manager.broadcast(orjson.dumps(payload).decode("utf-8"))
    return {"status": "triggered"}

@app.post("/api/sniff")
async def sniff_url(req: InfoRequest):
    req.url = await resolve_short_url(req.url)
    # Try direct file first
    direct_info = await check_is_direct_file(req.url)
    if direct_info.get("is_direct"):
        return {
            "title": direct_info.get("title", ""),
            "size": direct_info.get("size", 0),
            "type": "file"
        }
    
    # Try yt-dlp if it's a media site
    try:
        import yt_dlp
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': False,
            'dump_single_json': True,
            'default_search': 'auto',
            'playlist_items': '1',
            'cookiefile': None
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = await asyncio.to_thread(ydl.extract_info, req.url, download=False)
            if info:
                title = info.get('title', 'Unknown Media')
                ext = info.get('ext', 'mp4')
                filename = f"{title}.{ext}"
                
                base_size = info.get('filesize_approx', info.get('filesize', 0))
                sizes = {"best": base_size}
                
                audio_size = 0
                for f in info.get('formats', []):
                    if f.get('acodec') != 'none' and f.get('vcodec') == 'none':
                        s = f.get('filesize') or f.get('filesize_approx') or 0
                        if s > audio_size:
                            audio_size = s
                
                sizes['audio'] = audio_size
                
                best_video_sizes = {}
                for f in info.get('formats', []):
                    h = f.get('height')
                    if h in [1080, 720, 480, 360]:
                        s = f.get('filesize') or f.get('filesize_approx') or 0
                        if s:
                            key = f"{h}p"
                            # Prefer a reasonable size, or max size
                            if key not in best_video_sizes or s > best_video_sizes[key]:
                                best_video_sizes[key] = s
                                
                for k, v in best_video_sizes.items():
                    if v > 0:
                        sizes[k] = v + audio_size
                        
                return {
                    "title": filename,
                    "size": base_size,
                    "sizes": sizes,
                    "type": "media"
                }
    except Exception as e:
        logger.warning(f"yt-dlp sniff failed: {e}")
        
    return {"title": "Unknown File", "size": 0, "type": "unknown"}

@app.post("/api/download")
async def add_download(req: DownloadRequest, db: Session = Depends(get_db)):
    logger.info(f"Received download request for URL: {req.url}")
    
    req.url = await resolve_short_url(req.url)

    is_yt_dlp = req.is_yt_dlp
    if is_yt_dlp is None:
        direct_info = await check_is_direct_file(req.url, cookies=req.cookies, user_agent=req.user_agent, referer=req.referer)
        is_yt_dlp = not direct_info.get("is_direct", False)
        
    def broadcast_update(dl_id):
        if app_loop and not app_loop.is_closed():
            try:
                asyncio.run_coroutine_threadsafe(broadcast_downloads(), app_loop)
            except Exception:
                pass

    try:
        download_id = start_download(req.url, db, use_ytdlp=is_yt_dlp, on_update=broadcast_update, save_path=req.save_path, quality=req.quality, cookies=req.cookies, user_agent=req.user_agent, referer=req.referer, title=req.title)
        logger.success(f"Download started successfully with ID: {download_id}")
        asyncio.create_task(broadcast_downloads())
        return {"status": "started", "id": download_id}
    except Exception as e:
        logger.exception(f"Failed to start download: {e}")
        return {"status": "error", "message": str(e)}

@app.post("/api/pause/")
@app.post("/api/pause/{download_id}")
async def pause_download(db: Session = Depends(get_db), download_id: str = ""):
    if not download_id:
        return {"status": "not_found"}
    logger.info(f"Pause requested for ID: {download_id}")
    if download_id in active_downloads:
        dl = active_downloads[download_id]
        dl.stop_event.set()
        dl.thread_stop_event.set()
        
        db_rec = db.query(DownloadRecord).filter(DownloadRecord.id == download_id).first()
        if db_rec:
            db_rec.status = "paused"
            db_rec.speed = 0
            db.commit()
            logger.info(f"Download {download_id} paused in DB.")
            
        asyncio.create_task(broadcast_downloads())
        return {"status": "pausing"}
    
    logger.warning(f"Download ID {download_id} not found for pausing.")
    return {"status": "not_found"}

@app.post("/api/resume/")
@app.post("/api/resume/{download_id}")
async def resume_download(db: Session = Depends(get_db), download_id: str = ""):
    if not download_id:
        return {"status": "not_found"}
    logger.info(f"Resume requested for ID: {download_id}")
    db_rec = db.query(DownloadRecord).filter(DownloadRecord.id == download_id).first()
    if db_rec:
        def broadcast_update(dl_id):
            if app_loop and not app_loop.is_closed():
                try:
                    asyncio.run_coroutine_threadsafe(broadcast_downloads(), app_loop)
                except Exception:
                    pass

        try:
            start_download(
                db_rec.url, 
                db, 
                use_ytdlp=db_rec.is_yt_dlp, 
                on_update=broadcast_update,
                existing_id=download_id
            )
            db_rec.status = "starting"
            db.commit()
            asyncio.create_task(broadcast_downloads())
            return {"status": "resumed"}
        except Exception as e:
            logger.error(f"Failed to resume download {download_id}: {e}")
            return {"status": "error", "message": str(e)}
    return {"status": "not_found"}

@app.delete("/api/cancel/")
@app.delete("/api/cancel/{download_id}")
async def cancel_download(db: Session = Depends(get_db), download_id: str = "", delete_file: bool = False):
    if not download_id:
        return {"status": "error"}
    logger.info(f"Cancel requested for ID: {download_id}, delete_file: {delete_file}")
    if download_id in active_downloads:
        dl = active_downloads[download_id]
        dl.stop_event.set()
        dl.thread_stop_event.set()
        
    db_rec = db.query(DownloadRecord).filter(DownloadRecord.id == download_id).first()
    filename = db_rec.filename if db_rec else None
    if db_rec:
        db.delete(db_rec)
        db.commit()
        logger.info(f"Download {download_id} canceled and deleted from DB.")
    
    # Give the downloader thread a moment to receive the stop event and close the file
    await asyncio.sleep(1.0)
    
    # Clean up temporary/partial files left on disk
    await concurrency.run_in_threadpool(_cleanup_temp_files, filename)
    
    if delete_file and filename:
        import glob
        for root, _, files in os.walk(BASE_DOWNLOAD_DIR):
            if filename in files:
                try:
                    os.remove(os.path.join(root, filename))
                    logger.info(f"Deleted completed file: {filename}")
                except Exception as e:
                    logger.error(f"Failed to delete {filename}: {e}")
        
    asyncio.create_task(broadcast_downloads())
    return {"status": "canceled", "download_id": download_id}


def _cleanup_temp_files(filename: str = None, clean_all: bool = False):
    """Remove .part, .ytdl, and fragment temp files from the downloads directory."""
    import glob
    cleaned = 0
    try:
        for root, dirs, files in os.walk(BASE_DOWNLOAD_DIR):
            for f in files:
                # If we're not cleaning ALL files, and we have a specific filename
                if not clean_all and filename:
                    basename = filename.split('.part')[0]
                    if not (f.startswith(filename) or f.startswith(basename)):
                        continue
                # If not cleaning all and no filename provided, skip to avoid deleting everything
                elif not clean_all and not filename:
                    continue
                    
                is_temp = False
                # Match common temp patterns
                if f.endswith('.part') or f.endswith('.ytdl') or '.part-Frag' in f:
                    is_temp = True
                # Match partial chunks from our chunked downloader (e.g. file.ext.part0)
                elif any(f.endswith(f'.part{i}') for i in range(32)):
                    is_temp = True
                    
                if is_temp:
                    try:
                        path = os.path.join(root, f)
                        os.remove(path)
                        cleaned += 1
                        logger.info(f"Cleaned temp file: {path}")
                    except Exception as e:
                        logger.warning(f"Failed to remove temp file {f}: {e}")
        if cleaned > 0:
            logger.success(f"Cleaned {cleaned} temporary file(s).")
    except Exception as e:
        logger.error(f"Error during temp file cleanup: {e}")

def sync_extract_info(url: str, ydl_opts: dict):
    import yt_dlp
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(url, download=False)

@app.post("/api/info")
async def get_info(req: InfoRequest):
    logger.info(f"Fetching info for URL: {req.url}")
    req.url = await resolve_short_url(req.url)
    
    try:
        # Check if direct file first
        direct_info = await check_is_direct_file(req.url)
        if direct_info.get("is_direct"):
            return {
                "status": "success",
                "download_info": {
                    "is_direct": True,
                    "title": direct_info["title"],
                    "thumbnail": "",
                    "sizes": {
                        "best": direct_info["size"],
                        "medium": direct_info["size"],
                        "audio": direct_info["size"]
                    }
                }
            }
            
        ydl_opts = {
            'quiet': True, 
            'no_warnings': True,
            'nocheckcertificate': True,
            'ignoreerrors': True,
            'force_ipv4': True,
            'skip_download': True,
            'socket_timeout': 15,
            'flat_playlist': True,
            'http_headers': {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
            }
        }
        
        if 'facebook.com' in req.url or 'fb.watch' in req.url:
            ydl_opts['force_ipv4'] = False
            ydl_opts['legacyserverconnect'] = True
            
        info = await concurrency.run_in_threadpool(sync_extract_info, req.url, ydl_opts)
        if not info:
            raise Exception("Failed to extract video information or unsupported site.")
                
        formats = info.get('formats', [])
        
        if not formats:
            root_size = info.get('filesize') or info.get('filesize_approx') or 0
            return {
                "status": "success",
                "download_info": {
                    "title": info.get('title', 'Unknown Title'),
                    "thumbnail": info.get('thumbnail', ''),
                    "sizes": {"best": root_size, "720p": root_size, "480p": root_size, "360p": root_size, "audio": root_size}
                }
            }
        
        def get_size(f):
            return f.get('filesize') or f.get('filesize_approx') or 0
        
        def get_height(f):
            return f.get('height') or 0

        audio_formats = [f for f in formats if f.get('vcodec') == 'none' and f.get('acodec') != 'none']
        # Pick the best audio by bitrate, then by size
        best_audio = max(audio_formats, key=lambda f: (f.get('abr') or f.get('tbr') or 0, get_size(f))) if audio_formats else None
        audio_size = get_size(best_audio) if best_audio else 0

        video_only = [f for f in formats if f.get('vcodec') != 'none' and (f.get('acodec') == 'none' or f.get('acodec') is None)]
        combined = [f for f in formats if f.get('vcodec') != 'none' and f.get('acodec') not in ('none', None)]

        def calc_total(max_h=None):
            """Calculate best estimated file size for a given max height.
            Picks the highest resolution within the limit (not the largest file)."""
            # Check combined formats (video+audio in one stream)
            c_fmts = [f for f in combined if get_height(f) <= max_h] if max_h else combined
            # Pick by highest resolution, then largest size as tiebreaker
            best_c = max(c_fmts, key=lambda f: (get_height(f), get_size(f))) if c_fmts else None
            size_c = get_size(best_c) if best_c else 0
            
            # Check video-only + audio
            v_fmts = [f for f in video_only if get_height(f) <= max_h] if max_h else video_only
            best_v = max(v_fmts, key=lambda f: (get_height(f), get_size(f))) if v_fmts else None
            size_v = get_size(best_v) if best_v else 0
            
            if size_v > 0 and audio_size > 0:
                size_v += audio_size
                
            total = max(size_c, size_v)
            if total == 0 and not max_h:
                total = info.get('filesize') or info.get('filesize_approx') or 0
            return total

        total_best = calc_total(None)
        total_720 = calc_total(720)
        total_480 = calc_total(480)
        total_360 = calc_total(360)
        
        # Ensure sizes are > 0 by falling back
        if not total_720: total_720 = int(total_best * 0.6) if total_best else 0
        if not total_480: total_480 = int(total_720 * 0.6) if total_720 else 0
        if not total_360: total_360 = int(total_480 * 0.6) if total_480 else 0
        
        # Ensure sizes are logically ordered and distinctly different to meet user expectations
        if total_720 >= total_best and total_best > 0:
            total_720 = int(total_best * 0.7)
        if total_480 >= total_720 and total_720 > 0:
            total_480 = int(total_720 * 0.65)
        if total_360 >= total_480 and total_480 > 0:
            total_360 = int(total_480 * 0.65)

        # If audio_size is 0 but we have combined formats, estimate from duration + bitrate
        if audio_size == 0 and combined:
            duration = info.get('duration') or 0
            if duration > 0 and best_audio:
                abr = best_audio.get('abr') or 128  # default 128kbps
                audio_size = int((abr * 1000 / 8) * duration)
            else:
                # Last resort: estimate ~10% of best video
                audio_size = int(total_best * 0.10) if total_best > 0 else 0
        
        return {
            "status": "success",
            "download_info": {
                "title": info.get('title', 'Unknown Title'),
                "thumbnail": info.get('thumbnail', ''),
                "sizes": {
                    "best": total_best,
                    "720p": total_720,
                    "480p": total_480,
                    "360p": total_360,
                    "audio": audio_size
                }
            }
        }
    except Exception as e:
        logger.exception(f"Failed to fetch info: {e}")
        return {"status": "error", "message": str(e)}

_last_net_io = None
_last_disk_io = None
_last_time = None

async def get_system_stats():
    """Retrieve system stats using psutil"""
    global _last_net_io, _last_disk_io, _last_time
    import time
    
    cpu_percent = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory()
    
    current_time = time.time()
    current_net = psutil.net_io_counters()
    current_disk = psutil.disk_io_counters()
    
    net_speed = 0
    disk_speed = 0
    
    if _last_time is not None:
        dt = current_time - _last_time
        if dt > 0:
            net_speed = (current_net.bytes_recv + current_net.bytes_sent - _last_net_io.bytes_recv - _last_net_io.bytes_sent) / dt
            disk_speed = (current_disk.read_bytes + current_disk.write_bytes - _last_disk_io.read_bytes - _last_disk_io.write_bytes) / dt
            
    _last_time = current_time
    _last_net_io = current_net
    _last_disk_io = current_disk

    return {
        "cpu": cpu_percent,
        "memory": mem.percent,
        "net_speed": net_speed,
        "disk_speed": disk_speed
    }

async def broadcast_system_stats():
    try:
        sys_stats = await get_system_stats()
        payload = {
            "type": "system",
            "system": sys_stats
        }
        await manager.broadcast(orjson.dumps(payload).decode('utf-8'))
    except Exception as e:
        logger.error(f"Error broadcasting system stats: {e}")

async def broadcast_downloads():
    with SessionLocal() as db:
        try:
            records = db.query(DownloadRecord).all()
            downloads = []
            now_ms = time.time() * 1000
            for rec in records:
                downloads.append({
                    "id": rec.id,
                    "url": rec.url,
                    "status": rec.status,
                    "progress": rec.progress,
                    "speed": rec.speed,
                    "total_size": rec.total_size,
                    "downloaded": rec.downloaded,
                    "filename": rec.filename,
                    "error_message": rec.error_message,
                    "created_at": getattr(rec, 'created_at', None) or now_ms
                })
            
            payload = {
                "type": "downloads",
                "downloads": downloads
            }
            await manager.broadcast(orjson.dumps(payload).decode('utf-8'))
        except Exception as e:
            logger.error(f"Error broadcasting downloads: {e}")

@app.get("/api/downloads")
async def get_all_downloads(db: Session = Depends(get_db)):
    records = db.query(DownloadRecord).all()
    downloads = []
    now_ms = time.time() * 1000
    for rec in records:
        downloads.append({
            "id": rec.id,
            "url": rec.url,
            "status": rec.status,
            "progress": rec.progress,
            "speed": rec.speed,
            "total_size": rec.total_size,
            "downloaded": rec.downloaded,
            "filename": rec.filename,
            "error_message": rec.error_message,
            "created_at": getattr(rec, 'created_at', None) or now_ms
        })
    return downloads

class ScheduleRequest(BaseModel):
    url: str
    is_yt_dlp: Optional[bool] = None
    save_path: Optional[str] = None
    quality: Optional[str] = "best"
    run_at: str
    title: Optional[str] = None

@app.post("/api/schedule")
async def schedule_download(req: ScheduleRequest, db: Session = Depends(get_db)):
    logger.info(f"Scheduling download for {req.url} at {req.run_at}")
    req.url = await resolve_short_url(req.url)
    run_date = datetime.fromisoformat(req.run_at.replace('Z', '+00:00'))
    
    def job_func(url, is_yt_dlp, save_path, quality, title):
        db_session = SessionLocal()
        try:
            download_id = start_download(url, db_session, use_ytdlp=is_yt_dlp, save_path=save_path, quality=quality, title=title)
            logger.info(f"Scheduled download started: {download_id}")
            if app_loop and not app_loop.is_closed():
                asyncio.run_coroutine_threadsafe(broadcast_downloads(), app_loop)
        finally:
            db_session.close()

    scheduler.add_job(
        job_func, 
        'date', 
        run_date=run_date, 
        args=[req.url, req.is_yt_dlp, req.save_path, req.quality, req.title]
    )
    return {"status": "scheduled", "time": str(run_date)}

@app.get("/api/stats")
async def get_stats(db: Session = Depends(get_db)):
    records = db.query(DownloadRecord).all()
    total_files = len(records)
    total_downloaded = sum(r.downloaded for r in records if r.downloaded)
    completed = len([r for r in records if r.status == "completed" or r.progress == 100])
    errors = len([r for r in records if r.status == "error"])
    video_count = len([r for r in records if r.filename and r.filename.endswith(('.mp4', '.mkv', '.avi', '.flv', '.mov'))])
    audio_count = len([r for r in records if r.filename and r.filename.endswith(('.mp3', '.m4a', '.wav', '.webm', '.ogg', '.flac'))])
    
    return {
        "total_files": total_files,
        "total_downloaded_bytes": total_downloaded,
        "completed": completed,
        "errors": errors,
        "videos": video_count,
        "audios": audio_count
    }

@app.post("/api/cleanup-temps")
async def cleanup_temps():
    """Manually trigger cleanup of all temporary/partial files in the downloads directory."""
    logger.info("Manual temp file cleanup triggered.")
    await concurrency.run_in_threadpool(_cleanup_temp_files, None, True)
    return {"status": "cleaned"}

@app.delete("/api/clear-history")
async def clear_history(db: Session = Depends(get_db)):
    """Clear all download records from the database (does not delete actual files)."""
    logger.info("Clearing all download history from database.")
    try:
        count = db.query(DownloadRecord).count()
        db.query(DownloadRecord).delete()
        db.commit()
        logger.success(f"Cleared {count} download records from history.")
        asyncio.create_task(broadcast_downloads())
        return {"status": "cleared", "count": count}
    except Exception as e:
        logger.error(f"Failed to clear history: {e}")
        db.rollback()
        return {"status": "error", "message": str(e)}

@app.post("/api/clear-completed")
async def clear_completed_history(db: Session = Depends(get_db)):
    """Clear only completed download records from the database."""
    logger.info("Clearing completed download history from database.")
    try:
        query = db.query(DownloadRecord).filter(DownloadRecord.status == "completed")
        count = query.count()
        query.delete()
        db.commit()
        logger.success(f"Cleared {count} completed records.")
        asyncio.create_task(broadcast_downloads())
        return {"status": "cleared", "count": count}
    except Exception as e:
        logger.error(f"Failed to clear completed history: {e}")
        db.rollback()
        return {"status": "error", "message": str(e)}

@app.post("/api/settings")
async def update_settings(req: SettingsUpdateRequest):
    if req.speed_limit_kbps is not None:
        set_speed_limit(req.speed_limit_kbps)
    if req.max_concurrent is not None:
        set_max_concurrent(req.max_concurrent)
    if req.auto_categorize is not None:
        set_auto_categorize(req.auto_categorize)
    if req.download_path is not None:
        set_base_download_dir(req.download_path)
    return {
        "status": "success",
        "speed_limit_kbps": get_speed_limit(),
        "max_concurrent": get_max_concurrent()
    }

@app.get("/api/settings")
async def get_settings():
    return {
        "speed_limit_kbps": get_speed_limit(),
        "max_concurrent": get_max_concurrent()
    }

@app.get("/api/stream/{download_id}")
async def stream_file(download_id: str, db: Session = Depends(get_db)):
    rec = db.query(DownloadRecord).filter(DownloadRecord.id == download_id).first()
    if not rec or not rec.filename:
        return {"error": "Not found"}
    
    # Detect correct MIME type for audio/video
    import mimetypes
    mime_type = mimetypes.guess_type(rec.filename)[0] or 'application/octet-stream'
    
    cat_dir = get_category_dir(rec.filename)
    file_path = os.path.join(cat_dir, rec.filename)
    
    if os.path.exists(file_path):
        return FileResponse(file_path, media_type=mime_type, filename=rec.filename)
    
    for root, dirs, files in os.walk(BASE_DOWNLOAD_DIR):
        if rec.filename in files:
            return FileResponse(os.path.join(root, rec.filename), media_type=mime_type, filename=rec.filename)
            
    return {"error": "File not found on disk"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        await broadcast_system_stats()
        await broadcast_downloads()
        while True:
            data = await websocket.receive_text()
            logger.debug(f"Received WS message: {data}")
            try:
                msg = orjson.loads(data)
                action = msg.get("action")
                dl_id = msg.get("id")
                if action and dl_id:
                    with SessionLocal() as db:
                        if action == "pause":
                            if dl_id in active_downloads:
                                dl = active_downloads[dl_id]
                                dl.stop_event.set()
                            db_rec = db.query(DownloadRecord).filter(DownloadRecord.id == dl_id).first()
                            if db_rec:
                                db_rec.status = "paused"
                                db.commit()
                            await broadcast_downloads()
                        elif action == "cancel":
                            if dl_id in active_downloads:
                                dl = active_downloads[dl_id]
                                dl.stop_event.set()
                                dl.thread_stop_event.set()
                            db_rec = db.query(DownloadRecord).filter(DownloadRecord.id == dl_id).first()
                            if db_rec:
                                db.delete(db_rec)
                                db.commit()
                            await broadcast_downloads()
            except orjson.JSONDecodeError:
                pass
            except Exception as e:
                logger.error(f"Error handling WS message: {e}")
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket unexpected error: {e}")
        manager.disconnect(websocket)

# Background task to send system stats periodically
async def system_monitor():
    logger.info("System monitor started.")
    while True:
        await asyncio.sleep(5) # Update every 5 seconds (reduced from 2s for lower resource usage)
        if len(manager.active_connections) > 0:
            await broadcast_system_stats()

@app.on_event("startup")
async def startup_event():
    global app_loop
    app_loop = asyncio.get_running_loop()
    scheduler.start()
    
    import subprocess
    logger.info("Ledo Downloader Backend is starting up...")
    
    # Auto-Updater for yt-dlp (Disabled during dev to prevent nodemon/uvicorn restart loops)
    # logger.info("Checking for yt-dlp updates in the background...")
    # try:
    #     subprocess.Popen([sys.executable, "-m", "pip", "install", "--upgrade", "yt-dlp", "--quiet"])
    # except Exception as e:
    #     logger.warning(f"Failed to launch yt-dlp updater: {e}")
        
    asyncio.create_task(system_monitor())

if __name__ == "__main__":
    logger.info("Starting Uvicorn server...")
    # host="127.0.0.1" restricts connections to the local machine only (closes IP vulnerabilities)
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
