import asyncio
import psutil
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, BackgroundTasks, concurrency, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx
from typing import Any, Dict, List, Optional
import uvicorn
import os
import sys
import time
import re
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

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

try:
    from spotify_resolver import is_spotify_url, resolve_spotify
except ImportError:
    logger.warning("spotify_resolver module not found - Spotify support disabled")
    def is_spotify_url(url): return False
    def resolve_spotify(url): return None
from database import get_db, DownloadRecord, SessionLocal
from downloader import (
    start_download, active_downloads, get_category_dir, BASE_DOWNLOAD_DIR, IN_MEMORY_DB_CACHE,
    set_speed_limit, get_speed_limit, set_max_concurrent, get_max_concurrent,
    set_auto_categorize, set_base_download_dir, get_smart_referer, pick_best_youtube_match
)
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi.responses import FileResponse
from datetime import datetime
import os
import secrets
import threading
import uuid

scheduler = AsyncIOScheduler()

# Configure Loguru for robust error tracking and stability monitoring
logger.remove()
logger.add(sys.stdout, format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>")
# File logging - write to AppData to avoid PermissionError in Program Files
_log_dir = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "Ledo Downloader")
os.makedirs(_log_dir, exist_ok=True)
logger.add(os.path.join(_log_dir, "ledo_backend.log"), rotation="10 MB", retention="10 days", level="INFO")

app = FastAPI(title="Ledo Downloader API - Core")
app_loop = None
app.state.spotify_batch_tasks = set()

# CORS middleware - restricted to prevent malicious websites from accessing the local API
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^null$|^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
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

def normalize_youtube_watch_url(url: str) -> str:
    """Drop YouTube playlist/radio parameters when a single watch video is requested."""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        if host == "youtu.be":
            video_id = parts.path.strip("/").split("/", 1)[0]
        elif host == "youtube.com" or host.endswith(".youtube.com"):
            if parts.path != "/watch":
                return url
            video_id = parse_qs(parts.query).get("v", [""])[0]
        else:
            return url
        if not video_id:
            return url
        return urlunsplit(("https", "www.youtube.com", "/watch", urlencode({"v": video_id}), ""))
    except (TypeError, ValueError):
        return url

class DownloadRequest(BaseModel):
    url: str
    is_yt_dlp: Optional[bool] = None
    save_path: Optional[str] = None
    quality: Optional[str] = "best"
    title: Optional[str] = None
    cookies: Optional[str] = None
    cookies_netscape: Optional[str] = None
    cookie_jar: Optional[List[Dict[str, Any]]] = None
    headers: Optional[Dict[str, str]] = None
    user_agent: Optional[str] = None
    referer: Optional[str] = None
    selected_track_indices: Optional[List[int]] = None
    spotify_tracks: Optional[List[Dict[str, Any]]] = None

class InfoRequest(BaseModel):
    url: str
    cookies: Optional[str] = None
    cookies_netscape: Optional[str] = None
    cookie_jar: Optional[List[Dict[str, Any]]] = None
    headers: Optional[Dict[str, str]] = None
    user_agent: Optional[str] = None
    referer: Optional[str] = None

class YouTubeAudioSessionRequest(BaseModel):
    url: str
    cookies: Optional[str] = None
    cookies_netscape: Optional[str] = None
    user_agent: Optional[str] = None

_youtube_audio_sessions = {}
_youtube_audio_sessions_lock = threading.Lock()
_youtube_audio_extract_limit = asyncio.Semaphore(2)
_YOUTUBE_AUDIO_SESSION_TTL = 60 * 60
_YOUTUBE_AUDIO_MAX_SESSIONS = 256

def _extract_youtube_audio(url: str, cookies: Optional[str] = None, user_agent: Optional[str] = None):
    import yt_dlp
    options = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": 20,
        "cachedir": False,
        "remote_components": ["ejs:github"],
        "extractor_args": {"youtube": ["player_client=web_safari,web_embedded,-tv_downgraded", "player_skip=configs"]},
    }
    media_headers = {}
    if cookies:
        media_headers["Cookie"] = cookies
    if user_agent:
        media_headers["User-Agent"] = user_agent
    if media_headers:
        options["http_headers"] = media_headers
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info:
        raise ValueError("YouTube did not return media information")
    audio_formats = [
        media_format for media_format in info.get("formats", [])
        if media_format.get("url")
        and media_format.get("protocol") in ("http", "https")
        and media_format.get("acodec") not in (None, "none")
        and media_format.get("vcodec") in (None, "none")
    ]
    if not audio_formats:
        raise ValueError("No audio-only format is available")
    with yt_dlp.YoutubeDL(options) as ydl:
        sortable_info = {
            "formats": audio_formats,
            "_format_sort_fields": info.get("_format_sort_fields"),
        }
        ydl.sort_formats(sortable_info)
        audio_formats = sortable_info["formats"]
    fmt = audio_formats[-1]
    if not fmt.get("url") or fmt.get("vcodec") not in (None, "none"):
        raise ValueError("Could not resolve an audio-only YouTube stream")
    # yt-dlp may suffix an itag (for example "140-drc"), while the actual
    # YouTube videoplayback URL still carries the numeric itag in its query.
    video_itags = sorted({
        match.group(1)
        for media_format in info.get("formats", [])
        if media_format.get("vcodec") not in (None, "none")
        if (match := re.match(r"^(\d+)", str(media_format.get("format_id", ""))))
    })
    return {
        "url": fmt["url"],
        "title": info.get("title") or "YouTube audio",
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "ext": fmt.get("ext"),
        "format_id": fmt.get("format_id"),
        "audio_bitrate_kbps": fmt.get("tbr"),
        "video_itags": video_itags,
        "created_at": time.time(),
    }

class QuickAddRequest(BaseModel):
    url: str
    cookies: Optional[str] = None
    cookies_netscape: Optional[str] = None
    cookie_jar: Optional[List[Dict[str, Any]]] = None
    headers: Optional[Dict[str, str]] = None
    user_agent: Optional[str] = None
    referer: Optional[str] = None
    filename: Optional[str] = None
    file_size: Optional[int] = None
    mime_type: Optional[str] = None

class UpdateUrlRequest(BaseModel):
    id: str
    new_url: str
    cookies: Optional[str] = None
    cookies_netscape: Optional[str] = None
    cookie_jar: Optional[List[Dict[str, Any]]] = None
    headers: Optional[Dict[str, str]] = None
    user_agent: Optional[str] = None
    referer: Optional[str] = None

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
        referer = get_smart_referer(url, referer)
        default_ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        headers = {
            'User-Agent': user_agent or default_ua,
            'Accept': '*/*'
        }
        if referer:
            headers['Referer'] = referer
        if cookies:
            headers['Cookie'] = cookies
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
            resp = await client.head(url, headers=headers)
            if resp.status_code not in (200, 206):
                resp = await client.get(url, headers={"Range": "bytes=0-0", **headers})
            
            # If 403 or 404, retry with smart referer candidate if available
            if resp.status_code in (403, 404):
                smart_ref = get_smart_referer(url)
                if smart_ref and smart_ref != headers.get('Referer'):
                    retry_headers = {**headers, 'Referer': smart_ref, 'Range': 'bytes=0-0'}
                    try:
                        retry_resp = await client.get(url, headers=retry_headers)
                        if retry_resp.status_code in (200, 206):
                            resp = retry_resp
                    except Exception:
                        pass
                
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
    req.url = normalize_youtube_watch_url(req.url)
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
        "cookies_netscape": req.cookies_netscape,
        "cookie_jar": req.cookie_jar,
        "headers": req.headers,
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
    req.url = normalize_youtube_watch_url(req.url)
    req.url = await resolve_short_url(req.url)
    # Streaming sites such as YouTube can take several seconds to answer a
    # HEAD request and never behave like a downloadable file. Skip that probe
    # so it cannot consume most of the metadata lookup's time budget.
    from urllib.parse import urlparse
    host = (urlparse(req.url).hostname or "").lower()
    streaming_hosts = (
        "youtube.com", "youtu.be", "tiktok.com", "instagram.com",
        "facebook.com", "fb.watch", "twitter.com", "x.com", "twitch.tv",
        "vimeo.com", "dailymotion.com", "soundcloud.com", "reddit.com"
    )
    is_streaming = any(host == domain or host.endswith("." + domain) for domain in streaming_hosts)

    if not is_streaming:
        direct_info = await check_is_direct_file(
            req.url, cookies=req.cookies, user_agent=req.user_agent, referer=req.referer
        )
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
            'socket_timeout': 10,
            'cookiefile': None,
            'remote_components': ['ejs:github'],
            'extractor_args': {'youtube': ['player_client=web_safari,web_embedded,-tv_downgraded', 'player_skip=configs']}
        }
        sniff_headers = {}
        if req.user_agent:
            sniff_headers['User-Agent'] = req.user_agent
        if req.cookies:
            sniff_headers['Cookie'] = req.cookies
        if req.referer:
            sniff_headers['Referer'] = req.referer
        if sniff_headers:
            ydl_opts['http_headers'] = sniff_headers
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

@app.post("/api/youtube/audio-session")
async def create_youtube_audio_session(req: YouTubeAudioSessionRequest):
    from urllib.parse import urlparse
    parsed = urlparse(req.url)
    allowed_hosts = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtube-nocookie.com"}
    if (
        len(req.url) > 4096
        or len(req.cookies or "") > 16_384
        or len(req.user_agent or "") > 1024
        or "\r" in (req.cookies or "")
        or "\n" in (req.cookies or "")
        or parsed.username
        or parsed.password
        or parsed.scheme != "https"
        or (parsed.hostname or "").lower() not in allowed_hosts
    ):
        raise HTTPException(status_code=400, detail="Only YouTube video URLs are supported")
    try:
        async with _youtube_audio_extract_limit:
            resolved = await asyncio.to_thread(_extract_youtube_audio, req.url, req.cookies, req.user_agent)
    except Exception as exc:
        logger.warning(f"YouTube audio session extraction failed: {exc}")
        raise HTTPException(status_code=502, detail="Could not resolve an audio-only stream. This video may be unavailable or restricted.")
    session_id = secrets.token_urlsafe(24)
    with _youtube_audio_sessions_lock:
        now = time.time()
        for key in [key for key, value in _youtube_audio_sessions.items() if now - value["created_at"] > _YOUTUBE_AUDIO_SESSION_TTL]:
            _youtube_audio_sessions.pop(key, None)
        if len(_youtube_audio_sessions) >= _YOUTUBE_AUDIO_MAX_SESSIONS:
            raise HTTPException(status_code=429, detail="Too many active audio sessions. Close an existing session and retry.")
        # The browser receives the signed stream URL directly. Keep no copy of
        # that credential-like URL in backend memory after constructing response.
        _youtube_audio_sessions[session_id] = {"created_at": now}
    return {
        "session_id": session_id,
        "title": resolved["title"],
        "duration": resolved["duration"],
        "thumbnail": resolved["thumbnail"],
        "stream_url": resolved["url"],
        "format_id": resolved["format_id"],
        "audio_bitrate_kbps": resolved["audio_bitrate_kbps"],
        "video_itags": resolved["video_itags"],
    }

@app.delete("/api/youtube/audio-session/{session_id}")
async def close_youtube_audio_session(session_id: str):
    with _youtube_audio_sessions_lock:
        _youtube_audio_sessions.pop(session_id, None)
    return {"status": "closed"}

@app.post("/api/download")
async def add_download(req: DownloadRequest, db: Session = Depends(get_db)):
    req.url = normalize_youtube_watch_url(req.url)
    logger.info(f"Received download request for URL: {req.url}")
    
    if is_spotify_url(req.url):
        supplied_tracks = []
        for raw_track in req.spotify_tracks or []:
            if not isinstance(raw_track, dict):
                continue
            title = str(raw_track.get("title") or "").strip()
            artist = str(raw_track.get("artist") or "").strip()
            if not title:
                continue
            track = {"title": title, "artist": artist}
            album = str(raw_track.get("album") or "").strip()
            if album:
                track["album"] = album
            duration = raw_track.get("duration")
            if isinstance(duration, (int, float)) and duration > 0:
                track["duration"] = float(duration)
            supplied_tracks.append(track)

        res = (
            {"type": "spotify", "tracks": supplied_tracks}
            if supplied_tracks else await asyncio.to_thread(resolve_spotify, req.url)
        )
        if res and res.get("tracks"):
            # Enqueue every resolved Spotify item (playlist, album, or artist top tracks).
            def broadcast_update(dl_id):
                if app_loop and not app_loop.is_closed():
                    try:
                        asyncio.run_coroutine_threadsafe(broadcast_downloads(), app_loop)
                    except Exception: pass
                    
            tracks = res["tracks"]
            if req.selected_track_indices is not None:
                selected_indices = list(dict.fromkeys(req.selected_track_indices))
                if not selected_indices or any(index < 0 or index >= len(tracks) for index in selected_indices):
                    return {
                        "status": "error",
                        "message": "اختار أغنية واحدة على الأقل من القائمة.",
                    }
                tracks = [tracks[index] for index in selected_indices]

            pending_tracks = []
            now_ms = time.time() * 1000
            for track in tracks:
                artist = track.get('artist', '')
                title = track.get('title', '')
                display_title = f"{artist} - {title}" if artist else title
                pending_id = str(uuid.uuid4())
                db.add(DownloadRecord(
                    id=pending_id,
                    url=req.url,
                    filename=display_title,
                    status="resolving",
                    progress=5.0,
                    speed=0.0,
                    total_size=0.0,
                    downloaded=0.0,
                    is_yt_dlp=True,
                    error_message="",
                    created_at=now_ms,
                    save_path=req.save_path,
                    quality="audio",
                    cookies=req.cookies,
                    user_agent=req.user_agent,
                    referer=req.referer,
                ))
                IN_MEMORY_DB_CACHE[pending_id] = {"status": "resolving", "progress": 5.0, "speed": 0}
                pending_tracks.append((pending_id, track, display_title))
            db.commit()
            # Show each selected song in the downloads list while YouTube matches are being resolved.
            await broadcast_downloads()

            matched_youtube_urls = set()
            match_semaphore = asyncio.Semaphore(3)

            async def resolve_spotify_track(pending_id, track, display_title):
                artist = track.get('artist', '')
                title  = track.get('title', '')
                worker_db = SessionLocal()

                def report_match_progress(progress, _attempt, _total):
                    cache = IN_MEMORY_DB_CACHE.setdefault(pending_id, {})
                    if cache.get("status") not in ("error", "completed"):
                        cache.update(status="resolving", progress=progress, speed=0)
                        broadcast_update(pending_id)

                try:
                    # Search off the request path so Spotify lists are accepted
                    # immediately and never hold FastAPI's request DB session.
                    async with match_semaphore:
                        matched_url = await asyncio.to_thread(
                            pick_best_youtube_match,
                            title,
                            artist,
                            6,
                            track.get('duration'),
                            track.get('album', ''),
                            report_match_progress,
                        )
                    record = worker_db.query(DownloadRecord).filter(DownloadRecord.id == pending_id).first()
                    if not record:
                        IN_MEMORY_DB_CACHE.pop(pending_id, None)
                        return
                    if not matched_url:
                        reason = "لم يتم العثور على نسخة مطابقة بدرجة كافية"
                        record.status = "error"
                        record.progress = 0
                        record.error_message = reason
                        IN_MEMORY_DB_CACHE.setdefault(pending_id, {}).update(
                            status="error", error_message=reason, resolving=False, progress=0, speed=0
                        )
                        worker_db.commit()
                        logger.warning(f"No confident YouTube match for Spotify track '{display_title}'")
                        return
                    if matched_url in matched_youtube_urls:
                        reason = "تم تخطيها لأن نتيجة YouTube نفسها اختيرت لأغنية أخرى في القائمة"
                        record.status = "error"
                        record.progress = 0
                        record.error_message = reason
                        IN_MEMORY_DB_CACHE.setdefault(pending_id, {}).update(
                            status="error", error_message=reason, resolving=False, progress=0, speed=0
                        )
                        worker_db.commit()
                        logger.warning(f"Skipping duplicate Spotify match for '{display_title}': {matched_url}")
                        return

                    # This coroutine runs on the event loop; no await occurs
                    # between checking and reserving the URL, so duplicates
                    # from parallel track searches cannot race each other.
                    matched_youtube_urls.add(matched_url)
                    record.progress = 0
                    record.downloaded = 0
                    record.total_size = 0
                    record.speed = 0
                    worker_db.commit()
                    IN_MEMORY_DB_CACHE.setdefault(pending_id, {}).update(
                        progress=0, downloaded=0, total_size=0, speed=0
                    )
                    IN_MEMORY_DB_CACHE.setdefault(pending_id, {}).pop("resolving", None)
                    dl_id = start_download(
                        matched_url, worker_db,
                        use_ytdlp=True,
                        on_update=broadcast_update,
                        save_path=req.save_path,
                        quality="audio",
                        cookies=req.cookies,
                        user_agent=req.user_agent,
                        referer=req.referer,
                        existing_id=pending_id,
                        title=display_title
                    )
                    logger.info(f"Spotify match ready for '{display_title}' ({dl_id})")
                except Exception as exc:
                    logger.exception(f"Spotify track resolution failed for '{display_title}': {exc}")
                    try:
                        failed_record = worker_db.query(DownloadRecord).filter(DownloadRecord.id == pending_id).first()
                        if failed_record:
                            reason = f"تعذر تجهيز التنزيل: {exc}"
                            failed_record.status = "error"
                            failed_record.progress = 0
                            failed_record.error_message = reason
                            IN_MEMORY_DB_CACHE.setdefault(pending_id, {}).update(
                                status="error", error_message=reason, resolving=False, progress=0, speed=0
                            )
                            worker_db.commit()
                        else:
                            IN_MEMORY_DB_CACHE.pop(pending_id, None)
                    except Exception:
                        logger.exception(f"Could not persist Spotify resolution failure for {pending_id}")
                finally:
                    worker_db.close()
                    await broadcast_downloads()

            async def resolve_spotify_batch():
                outcomes = await asyncio.gather(*(
                    resolve_spotify_track(pending_id, track, display_title)
                    for pending_id, track, display_title in pending_tracks
                ), return_exceptions=True)
                for outcome in outcomes:
                    if isinstance(outcome, Exception):
                        logger.error(f"Spotify background batch task failed: {outcome}")
                await broadcast_downloads()

            # Keep the task strongly referenced until all selected tracks have
            # either entered the download queue or received an error state.
            batch_task = asyncio.create_task(resolve_spotify_batch())
            app.state.spotify_batch_tasks.add(batch_task)
            batch_task.add_done_callback(app.state.spotify_batch_tasks.discard)

            first_id = pending_tracks[0][0] if pending_tracks else ""
            return {
                "status": "started",
                "id": first_id,
                "count": len(pending_tracks),
                "multiple": len(pending_tracks) > 1,
                "selected_count": len(pending_tracks),
                "resolving": True,
            }

        if "/artist/" in req.url.lower():
            return {
                "status": "error",
                "message": "تعذر جلب أفضل أغاني الفنان من Spotify. جرّب مرة أخرى أو استخدم رابط أغنية أو ألبوم."
            }
        return {
            "status": "error",
            "message": "تعذر قراءة رابط Spotify. استخدم رابطًا عامًا لأغنية أو ألبوم أو Playlist."
        }

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
        download_id = start_download(
            req.url, db,
            use_ytdlp=is_yt_dlp,
            on_update=broadcast_update,
            save_path=req.save_path,
            quality=req.quality,
            cookies=req.cookies,
            cookies_netscape=req.cookies_netscape,
            headers=req.headers,
            user_agent=req.user_agent,
            referer=req.referer,
            title=req.title
        )
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
    current_worker = active_downloads.get(download_id)
    if current_worker and not current_worker.stop_event.is_set() and not current_worker.thread_stop_event.is_set():
        return {"status": "already_running"}
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
                existing_id=download_id,
                save_path=db_rec.save_path,
                quality=db_rec.quality or "best",
                cookies=db_rec.cookies,
                user_agent=db_rec.user_agent,
                referer=db_rec.referer,
                title=db_rec.filename
            )
            asyncio.create_task(broadcast_downloads())
            return {"status": "resumed"}
        except Exception as e:
            logger.error(f"Failed to resume download {download_id}: {e}")
            return {"status": "error", "message": str(e)}
    return {"status": "not_found"}

@app.post("/api/update-url")
async def update_download_url(req: UpdateUrlRequest, db: Session = Depends(get_db)):
    if not req.id or not req.new_url:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="id and new_url are required")
    
    clean_url = req.new_url.strip()
    logger.info(f"Update URL requested for download ID {req.id}: {clean_url}")
    
    # 1. Stop active worker if running
    if req.id in active_downloads:
        dl = active_downloads[req.id]
        dl.stop_event.set()
        dl.thread_stop_event.set()
        await asyncio.sleep(0.2)
        
    db_rec = db.query(DownloadRecord).filter(DownloadRecord.id == req.id).first()
    if not db_rec:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Download record not found")
        
    clean_url = await resolve_short_url(clean_url)
    db_rec.url = clean_url
    db_rec.status = "starting"
    db_rec.error_message = ""
    db_rec.speed = 0
    
    smart_ref = get_smart_referer(clean_url, req.referer)
    if smart_ref:
        db_rec.referer = smart_ref
    if req.cookies:
        db_rec.cookies = req.cookies
    if req.user_agent:
        db_rec.user_agent = req.user_agent
        
    db.commit()
    
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
            existing_id=req.id,
            save_path=db_rec.save_path,
            quality=db_rec.quality or "best",
            cookies=db_rec.cookies,
            user_agent=db_rec.user_agent,
            referer=db_rec.referer,
            title=db_rec.filename
        )
        logger.success(f"Download {req.id} resumed successfully with new URL: {clean_url}")
        asyncio.create_task(broadcast_downloads())
        return {"status": "updated", "id": req.id}
    except Exception as e:
        logger.error(f"Failed to resume download {req.id} after URL update: {e}")
        return {"status": "error", "message": str(e)}

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


def _is_temp_download_file(filename: str) -> bool:
    return (filename.endswith(('.part', '.ytdl')) or '.part-Frag' in filename
            or any(filename.endswith(f'.part{i}') for i in range(32)))


def _scan_temp_files(filename: str = None, clean_all: bool = False, protected_filenames=None):
    """List only downloader partials below the configured download directory."""
    candidates = []
    protected = {os.path.basename(name) for name in (protected_filenames or []) if name}
    try:
        for root, _, files in os.walk(BASE_DOWNLOAD_DIR, followlinks=False):
            for name in files:
                if not _is_temp_download_file(name):
                    continue
                if not clean_all:
                    if not filename:
                        continue
                    base = os.path.basename(filename).split('.part')[0]
                    if not (name.startswith(filename) or name.startswith(base)):
                        continue
                # Never remove a partial associated with a queued, paused, or
                # currently downloading record.
                if any(name.startswith(item.split('.part')[0]) for item in protected):
                    continue
                path = os.path.join(root, name)
                try:
                    size = os.path.getsize(path)
                    if os.path.isfile(path):
                        candidates.append({"path": path, "name": name, "size": size})
                except OSError as exc:
                    logger.debug(f"Skipping unreadable temp file {path}: {exc}")
    except OSError as exc:
        logger.error(f"Error scanning temporary files: {exc}")
    return candidates


def _cleanup_temp_files(filename: str = None, clean_all: bool = False, protected_filenames=None):
    """Remove recognized downloader partials and report what was actually removed."""
    removed = 0
    freed_bytes = 0
    for candidate in _scan_temp_files(filename, clean_all, protected_filenames):
        try:
            os.remove(candidate["path"])
            removed += 1
            freed_bytes += candidate["size"]
            logger.info(f"Cleaned temp file: {candidate['path']}")
        except OSError as exc:
            logger.warning(f"Failed to remove temp file {candidate['name']}: {exc}")
    if removed:
        logger.success(f"Cleaned {removed} temporary file(s), freeing {freed_bytes} bytes.")
    return {"status": "cleaned", "count": removed, "bytes_freed": freed_bytes}

def sync_extract_info(url: str, ydl_opts: dict):
    import yt_dlp
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(url, download=False)

@app.post("/api/info")
async def get_info(req: InfoRequest):
    req.url = normalize_youtube_watch_url(req.url)
    logger.info(f"Fetching info for URL: {req.url}")
    
    # ── Spotify: Return metadata directly without hitting YouTube ──
    if is_spotify_url(req.url):
        res = await asyncio.to_thread(resolve_spotify, req.url)
        if res and res.get("tracks"):
            tracks = res["tracks"]
            content_type = res.get("type", "track")
            first_track = tracks[0]
            
            if content_type == "track":
                # Single track — show proper artist + title
                artist = first_track.get("artist", "")
                title  = first_track.get("title", "Unknown")
                display_title = f"{artist} - {title}" if artist else title
                return {
                    "status": "success",
                    "download_info": {
                        "is_spotify": True,
                        "is_multi_track": False,
                        "title": display_title,
                        "tracks": [{
                            "title": title,
                            "artist": artist,
                            "duration": first_track.get("duration"),
                            "album": first_track.get("album", ""),
                        }],
                        "thumbnail": "",
                        "sizes": {"audio": 0}
                    }
                }
            else:
                # Album / playlist — show all track names
                track_names = []
                for t in tracks:
                    a = t.get("artist", "")
                    n = t.get("title", "")
                    track_names.append(f"{a} - {n}" if a else n)
                
                # Artist links resolve to the artist's Top tracks, while albums and
                # playlists use their first track's metadata when available.
                if content_type == "artist":
                    album_title = "Top tracks"
                    first_artist = res.get("artist", "") or first_track.get("artist", "")
                else:
                    album_title = first_track.get("album", "") or content_type.capitalize()
                    first_artist = first_track.get("artist", "")
                display_title = f"{first_artist} - {album_title}" if first_artist else album_title
                
                return {
                    "status": "success",
                    "download_info": {
                        "is_spotify": True,
                        "is_multi_track": True,
                        "title": display_title,
                        "track_count": len(tracks),
                        "track_names": track_names[:50],  # cap at 50 for display
                        "tracks": [
                            {
                                "title": t.get("title", ""),
                                "artist": t.get("artist", ""),
                                "duration": t.get("duration"),
                                "album": t.get("album", ""),
                            }
                            for t in tracks
                        ],
                        "content_type": content_type,
                        "thumbnail": "",
                        "sizes": {"audio": 0}
                    }
                }
        # Don't send an unrecognized Spotify page to yt-dlp; it is not a video URL.
        if "/artist/" in req.url.lower():
            return {
                "status": "error",
                "message": "تعذر جلب أفضل أغاني الفنان من Spotify. جرّب مرة أخرى أو استخدم رابط أغنية أو ألبوم."
            }
        return {
            "status": "error",
            "message": "تعذر قراءة رابط Spotify. استخدم رابطًا عامًا لأغنية أو ألبوم أو Playlist."
        }
    
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
            'force_ipv4': True,
            'skip_download': True,
            'socket_timeout': 10,
            'extract_flat': 'in_playlist',
            'extractor_args': {'youtube': ['player_client=web_safari,web_embedded,-tv_downgraded', 'player_skip=configs'], 'generic': ['impersonate']},
            'remote_components': ['ejs:github'],
            'http_headers': {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
            }
        }

        if req.user_agent:
            ydl_opts['http_headers']['User-Agent'] = req.user_agent
        if req.cookies:
            ydl_opts['http_headers']['Cookie'] = req.cookies
        if req.referer:
            ydl_opts['http_headers']['Referer'] = req.referer
        
        if 'facebook.com' in req.url or 'fb.watch' in req.url:
            ydl_opts['force_ipv4'] = False
            ydl_opts['legacyserverconnect'] = True
            
        # Prefer an anonymous extraction for public videos. Browser cookies
        # can make YouTube return "The page needs to be reloaded"; retry with
        # them only when they may be needed for restricted videos.
        extract_attempts = []
        if req.cookies:
            anonymous_opts = {**ydl_opts, 'http_headers': dict(ydl_opts['http_headers'])}
            anonymous_opts['http_headers'].pop('Cookie', None)
            extract_attempts.append(anonymous_opts)
        extract_attempts.append(ydl_opts)

        info = None
        last_extract_error = None
        for attempt_index, attempt_opts in enumerate(extract_attempts, start=1):
            try:
                candidate = await concurrency.run_in_threadpool(
                    sync_extract_info, req.url, attempt_opts
                )
                if candidate:
                    info = candidate
                    if candidate.get('formats'):
                        break
            except Exception as extract_error:
                last_extract_error = extract_error
                logger.warning(
                    f"Media extraction attempt {attempt_index}/{len(extract_attempts)} failed: {extract_error}"
                )

        if not info:
            if last_extract_error:
                raise last_extract_error
            raise Exception("Failed to extract video information or unsupported site.")
                
        formats = info.get('formats', [])
        
        if not formats:
            root_size = info.get('filesize') or info.get('filesize_approx') or 0
            return {
                "status": "success",
                "download_info": {
                    "title": info.get('title', 'Unknown Title'),
                    "thumbnail": info.get('thumbnail', ''),
                    "sizes": {"best": root_size, "1080p": root_size, "720p": root_size, "480p": root_size, "360p": root_size, "audio": root_size}
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
        total_1080 = calc_total(1080)
        total_720 = calc_total(720)
        total_480 = calc_total(480)
        total_360 = calc_total(360)
        
        # Ensure sizes are > 0 by falling back
        if not total_1080: total_1080 = int(total_best * 0.85) if total_best else 0
        if not total_720: total_720 = int(total_best * 0.6) if total_best else 0
        if not total_480: total_480 = int(total_720 * 0.6) if total_720 else 0
        if not total_360: total_360 = int(total_480 * 0.6) if total_480 else 0
        
        # Ensure sizes are logically ordered and distinctly different to meet user expectations
        if total_1080 >= total_best and total_best > 0:
            total_1080 = int(total_best * 0.9)
        if total_720 >= total_1080 and total_1080 > 0:
            total_720 = int(total_1080 * 0.75)
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
                    "1080p": total_1080,
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

def add_queue_positions(downloads):
    """Attach a stable one-based position to downloads waiting for a worker slot."""
    queued = [item for item in downloads if item.get("status") == "starting"]
    queued.sort(key=lambda item: (float(item.get("created_at") or 0), item.get("id") or ""))
    queue_total = len(queued)
    for position, item in enumerate(queued, start=1):
        item["queue_position"] = position
        item["queue_total"] = queue_total
    return downloads


async def broadcast_downloads():
    with SessionLocal() as db:
        try:
            records = db.query(DownloadRecord).all()
            downloads = []
            now_ms = time.time() * 1000
            seen_ids = set()
            for rec in records:
                seen_ids.add(rec.id)
                # Overlay in-memory cache on top of DB data for real-time progress
                cache = IN_MEMORY_DB_CACHE.get(rec.id, {})
                status = cache.get("status", rec.status)
                progress = cache.get("progress", rec.progress)
                speed = cache.get("speed", rec.speed)
                total_size = cache.get("total_size", rec.total_size)
                downloaded_val = cache.get("downloaded", rec.downloaded)
                filename = cache.get("filename", rec.filename)
                error_message = cache.get("error_message", rec.error_message)

                final_path = getattr(rec, 'save_path', None)
                if not final_path and filename:
                    final_path = os.path.join(get_category_dir(filename), filename)
                
                downloads.append({
                    "id": rec.id,
                    "url": rec.url,
                    "status": status,
                    "progress": progress,
                    "speed": speed,
                    "total_size": total_size,
                    "downloaded": downloaded_val,
                    "filename": filename,
                    "error_message": error_message,
                    "created_at": getattr(rec, 'created_at', None) or now_ms,
                    "completed_at": cache.get("completed_at", getattr(rec, 'completed_at', None)),
                    "save_path": final_path
                })
                
            from downloader import active_downloads
            for d_id, ctx in active_downloads.items():
                if d_id not in seen_ids:
                    cache = IN_MEMORY_DB_CACHE.get(d_id, {})
                    filename = cache.get("filename", "")
                    final_path = getattr(ctx, 'save_path', None)
                    if not final_path and filename:
                        final_path = os.path.join(get_category_dir(filename), filename)
                    
                    downloads.append({
                        "id": d_id,
                        "url": getattr(ctx, 'url', ''),
                        "status": cache.get("status", "starting"),
                        "progress": cache.get("progress", 0.0),
                        "speed": cache.get("speed", 0.0),
                        "total_size": cache.get("total_size", 0.0),
                        "downloaded": cache.get("downloaded", 0.0),
                        "filename": filename,
                        "error_message": cache.get("error_message", ""),
                        "created_at": now_ms,
                        "completed_at": cache.get("completed_at"),
                        "save_path": final_path
                    })
            
            add_queue_positions(downloads)
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
    seen_ids = set()
    for rec in records:
        seen_ids.add(rec.id)
        # Overlay in-memory cache on top of DB data for real-time progress
        cache = IN_MEMORY_DB_CACHE.get(rec.id, {})
        status = cache.get("status", rec.status)
        progress = cache.get("progress", rec.progress)
        speed = cache.get("speed", rec.speed)
        total_size = cache.get("total_size", rec.total_size)
        downloaded_val = cache.get("downloaded", rec.downloaded)
        filename = cache.get("filename", rec.filename)
        error_message = cache.get("error_message", rec.error_message)

        final_path = getattr(rec, 'save_path', None)
        if not final_path and filename:
            final_path = os.path.join(get_category_dir(filename), filename)
            
        downloads.append({
            "id": rec.id,
            "url": rec.url,
            "status": status,
            "progress": progress,
            "speed": speed,
            "total_size": total_size,
            "downloaded": downloaded_val,
            "filename": filename,
            "error_message": error_message,
            "created_at": getattr(rec, 'created_at', None) or now_ms,
            "completed_at": cache.get("completed_at", getattr(rec, 'completed_at', None)),
            "save_path": final_path
        })
        
    from downloader import active_downloads
    for d_id, ctx in active_downloads.items():
        if d_id not in seen_ids:
            cache = IN_MEMORY_DB_CACHE.get(d_id, {})
            filename = cache.get("filename", "")
            final_path = getattr(ctx, 'save_path', None)
            if not final_path and filename:
                final_path = os.path.join(get_category_dir(filename), filename)
            
            downloads.append({
                "id": d_id,
                "url": getattr(ctx, 'url', ''),
                "status": cache.get("status", "starting"),
                "progress": cache.get("progress", 0.0),
                "speed": cache.get("speed", 0.0),
                "total_size": cache.get("total_size", 0.0),
                "downloaded": cache.get("downloaded", 0.0),
                "filename": filename,
                "error_message": cache.get("error_message", ""),
                "created_at": now_ms,
                "completed_at": cache.get("completed_at"),
                "save_path": final_path
            })
            
    return add_queue_positions(downloads)

class ScheduleRequest(BaseModel):
    url: str
    is_yt_dlp: Optional[bool] = None
    save_path: Optional[str] = None
    quality: Optional[str] = "best"
    run_at: str
    title: Optional[str] = None
    selected_track_indices: Optional[List[int]] = None

@app.post("/api/schedule")
async def schedule_download(req: ScheduleRequest, db: Session = Depends(get_db)):
    logger.info(f"Scheduling download for {req.url} at {req.run_at}")
    req.url = await resolve_short_url(req.url)
    run_date = datetime.fromisoformat(req.run_at.replace('Z', '+00:00'))
    
    def job_func(url, is_yt_dlp, save_path, quality, title, selected_track_indices):
        if selected_track_indices is not None and is_spotify_url(url):
            async def start_scheduled_download():
                db_session = SessionLocal()
                try:
                    scheduled_req = DownloadRequest(
                        url=url,
                        is_yt_dlp=True,
                        save_path=save_path,
                        quality=quality,
                        title=title,
                        selected_track_indices=selected_track_indices,
                    )
                    result = await add_download(scheduled_req, db_session)
                    logger.info(f"Scheduled Spotify selection started: {result}")
                finally:
                    db_session.close()

            if app_loop and not app_loop.is_closed():
                asyncio.run_coroutine_threadsafe(start_scheduled_download(), app_loop)
            else:
                logger.error("Could not start scheduled Spotify selection: app event loop is unavailable")
            return

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
        args=[req.url, req.is_yt_dlp, req.save_path, req.quality, req.title, req.selected_track_indices]
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

def _protected_partial_filenames(db: Session):
    return [row.filename for row in db.query(DownloadRecord.filename)
            .filter(DownloadRecord.status.in_(("starting", "queued", "downloading", "paused")))
            .all() if row.filename]


@app.get("/api/cleanup-preview")
async def cleanup_preview(db: Session = Depends(get_db)):
    """Preview eligible partial files without changing anything."""
    protected = _protected_partial_filenames(db)
    candidates = await concurrency.run_in_threadpool(_scan_temp_files, None, True, protected)
    return {
        "count": len(candidates),
        "bytes": sum(item["size"] for item in candidates),
        "files": [{"name": item["name"], "size": item["size"]} for item in candidates[:8]],
        "truncated": len(candidates) > 8
    }


@app.post("/api/cleanup-temps")
async def cleanup_temps(db: Session = Depends(get_db)):
    """Clean eligible temp files while preserving partials tied to active downloads."""
    logger.info("Manual temp file cleanup triggered.")
    protected = _protected_partial_filenames(db)
    result = await concurrency.run_in_threadpool(_cleanup_temp_files, None, True, protected)
    return result

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
        query = db.query(DownloadRecord).filter(
            (DownloadRecord.status == "completed") | (DownloadRecord.progress == 100)
        )
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
                                db_rec.speed = 0
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

    # A resolving record cannot resume after a process restart because its
    # in-memory search task is gone. Mark it clearly instead of leaving a
    # spinner in the user's queue forever.
    recovery_db = SessionLocal()
    try:
        interrupted = recovery_db.query(DownloadRecord).filter(
            DownloadRecord.status == "resolving"
        ).all()
        for record in interrupted:
            record.status = "error"
            record.progress = 0
            record.speed = 0
            record.error_message = "توقف البحث عن الأغنية عند إغلاق التطبيق. أعد إضافتها للمحاولة مرة أخرى."
        if interrupted:
            recovery_db.commit()
            logger.warning(f"Marked {len(interrupted)} interrupted Spotify search(es) for retry")
    except Exception:
        recovery_db.rollback()
        logger.exception("Could not recover interrupted Spotify search records")
    finally:
        recovery_db.close()
    
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
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("LEDO_BACKEND_PORT", "8000")), log_level="warning")
