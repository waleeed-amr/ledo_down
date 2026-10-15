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
from typing import Optional, List, Dict, Set, Callable

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

def _normalize_arabic(text: str) -> str:
    """Normalize Arabic text for fuzzy matching (remove diacritics, normalize alef, etc.)."""
    import unicodedata
    # Remove Arabic diacritics (tashkeel)
    text = re.sub(r'[\u064B-\u065F\u0670]', '', text)
    # Normalize alef forms → plain alef
    text = re.sub(r'[أإآ]', 'ا', text)
    # Normalize teh marbuta
    text = re.sub(r'ة', 'ه', text)
    # Remove non-arabic/non-latin/non-digit characters
    text = re.sub(r'[^\w\s]', ' ', text, flags=re.UNICODE)
    return text.lower().strip()


def _transliterate_arabic(text: str) -> str:
    """Create a simple Egyptian-friendly Latin form for cross-script matching."""
    arabic_to_latin = {
        "ا": "a", "أ": "a", "إ": "a", "آ": "a", "ء": "", "ؤ": "w", "ئ": "y",
        "ب": "b", "ت": "t", "ث": "th", "ج": "g", "ح": "h", "خ": "kh",
        "د": "d", "ذ": "z", "ر": "r", "ز": "z", "س": "s", "ش": "sh",
        "ص": "s", "ض": "d", "ط": "t", "ظ": "z", "ع": "a", "غ": "gh",
        "ف": "f", "ق": "q", "ك": "k", "ل": "l", "م": "m", "ن": "n",
        "ه": "h", "ة": "a", "و": "w", "ى": "a", "ي": "y", "ئ": "y",
    }
    text = re.sub(r"[\u064B-\u065F\u0670ـ]", "", text)
    return "".join(arabic_to_latin.get(char, char) for char in text)


def _latin_match_forms(text: str) -> set:
    """Return literal and consonant-only forms to tolerate Arabic romanization."""
    normalized = _normalize_arabic(text)
    # Arabic chat numerals vary across transliterations (7abibi / habibi).
    normalized = normalized.translate(str.maketrans({"2": "a", "3": "a", "5": "kh", "7": "h", "9": "s"}))
    forms = {normalized}
    forms.add(re.sub(r"[aeiouy]", "", normalized))
    return forms


def _latin_arabic_query(text: str) -> str:
    """Approximate common Arabic-in-Latin song titles in Arabic script for search."""
    normalized = _normalize_arabic(text)
    digraphs = {
        "sh": "ش", "kh": "خ", "gh": "غ", "th": "ث", "dh": "ذ",
        "ch": "تش", "aa": "ا", "ee": "ي", "oo": "و", "ou": "و",
        "aw": "و", "ay": "ي", "ai": "ي", "ei": "ي",
    }
    letters = {
        "b": "ب", "c": "ك", "d": "د", "f": "ف",
        "g": "ج", "h": "ح", "i": "ي", "j": "ج", "k": "ك", "l": "ل",
        "m": "م", "n": "ن", "p": "ب", "q": "ق", "r": "ر",
        "s": "س", "t": "ت", "v": "ف", "w": "و", "x": "كس",
        "y": "ي", "z": "ز",
    }
    words = []
    for word in normalized.split():
        if word in {"we", "wa"}:
            words.append("و")
            continue
        if word in {"el", "al"}:
            words.append("ال")
            continue
        converted = []
        index = 0
        while index < len(word):
            pair = word[index:index + 2]
            if pair in digraphs:
                converted.append(digraphs[pair])
                index += 2
            else:
                char = word[index]
                if char == "a":
                    # Short internal "a" is usually omitted in Arabic spelling.
                    if index == 0 or index == len(word) - 1:
                        converted.append("ا")
                elif char in {"e", "i"}:
                    # Long vowels map to ya; short terminal vowels are usually
                    # not written before a final consonant (Habetek → حبيتك).
                    next_char = word[index + 1] if index + 1 < len(word) else ""
                    if index == len(word) - 1 or (next_char and next_char not in "aeiou"):
                        if next_char and index + 2 == len(word) and char in {"e", "i"}:
                            pass
                        else:
                            converted.append("ي")
                elif char in {"o", "u"}:
                    next_char = word[index + 1] if index + 1 < len(word) else ""
                    if index == 0 or index == len(word) - 1 or (next_char and next_char not in "aeiou"):
                        converted.append("و")
                else:
                    converted.append(letters.get(char, char))
                index += 1
        words.append("".join(converted))
    return re.sub(r"\bو\s+", "و", " ".join(words))


def _matching_words(text: str) -> set:
    normalized = _normalize_arabic(text)
    forms = [normalized]
    if re.search(r"[\u0600-\u06FF]", text):
        forms.append(_transliterate_arabic(text))
    words = set()
    for form in forms:
        for word in _normalize_arabic(form).split():
            if len(word) > 1:
                variants = {word}
                if re.search(r"[\u0600-\u06FF]", text):
                    # Arabic conjunctions and articles are often attached without spaces.
                    if word.startswith("w") and len(word) > 3:
                        variants.add(word[1:])
                    for variant in list(variants):
                        for prefix in ("al", "el"):
                            if variant.startswith(prefix) and len(variant) > len(prefix) + 2:
                                variants.add(variant[len(prefix):])
                words.update(variant for variant in variants if len(variant) > 1)
    return words


def _word_matches(expected: str, candidates: set, min_token_length: int = 3, similarity_threshold: float = 0.72) -> bool:
    from difflib import SequenceMatcher

    expected_forms = _latin_match_forms(expected)
    for candidate in candidates:
        candidate_forms = _latin_match_forms(candidate)
        if expected_forms & candidate_forms:
            return True
        if any(
            min(len(left), len(right)) >= min_token_length
            and SequenceMatcher(None, left, right).ratio() >= similarity_threshold
            for left in expected_forms for right in candidate_forms
        ):
            return True
    return False

def _pick_best_youtube_match_legacy(track_name: str, artist_name: str, n_results: int = 7) -> Optional[str]:
    """
    Search YouTube for n_results, score each by how well artist_name appears
    in the video title/uploader, return the direct YouTube URL of the best match.
    Falls back to first result if no artist info available.
    """
    try:
        import yt_dlp
        
        queries = [
            f'ytsearch{n_results}:{track_name} {artist_name} audio',
            f'ytsearch{n_results}:{track_name} {artist_name}',
            f'ytsearch{n_results}:{track_name}'
        ]
        
        # Add fallback for Arabic songs with long/sensitive names (take first 2 words + artist)
        words = track_name.split()
        if len(words) > 2:
            short_track = " ".join(words[:2])
            queries.append(f'ytsearch{n_results}:{short_track} {artist_name}')
            
        # Add fallback for YouTube's exact string blocking
        if " " in track_name:
            queries.append(f'ytsearch{n_results}:{artist_name}') # broad artist search as last resort if everything else gets connection closed
        
        entries = []
        for query in queries:
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'extract_flat': True,
                'skip_download': True,
                'ignoreerrors': True,
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(query, download=False)
            
            entries = info.get('entries', []) if info else []
            entries = [e for e in entries if e]  # remove None
            
            if entries:
                logger.info(f"Found {len(entries)} results using query: {query}")
                break
        
        if not entries:
            return None
        
        if not artist_name:
            # No artist info → just take first result
            return f"https://www.youtube.com/watch?v={entries[0]['id']}"
        
        artist_norm = _normalize_arabic(artist_name)
        artist_words = set(w for w in artist_norm.split() if len(w) > 1)
        
        best_url = None
        best_score = -1
        
        for entry in entries:
            title = _normalize_arabic(entry.get('title', ''))
            uploader = _normalize_arabic(entry.get('uploader', '') or entry.get('channel', ''))
            combined = title + ' ' + uploader
            
            # Score = how many artist words appear in title+uploader
            matched = sum(1 for w in artist_words if w in combined)
            score = matched / max(len(artist_words), 1)
            
            logger.debug(f"YT candidate: {entry.get('title', '')} | score={score:.2f}")
            
            if score > best_score:
                best_score = score
                best_url = f"https://www.youtube.com/watch?v={entry['id']}"
        
        logger.info(f"Best YouTube match for '{track_name}' by '{artist_name}': score={best_score:.2f} → {best_url}")
        return best_url
    except Exception as e:
        logger.error(f"pick_best_youtube_match failed: {e}")
        return None


def pick_best_youtube_match(
    track_name: str,
    artist_name: str,
    n_results: int = 6,
    expected_duration: Optional[float] = None,
    album_name: str = "",
    progress_callback: Optional[Callable[[int, int, int], None]] = None,
) -> Optional[str]:
    """Choose a confident YouTube match using title, artist, and duration."""
    try:
        import yt_dlp

        arabic_query_title = _latin_arabic_query(track_name)
        exact_title = f'"{track_name}"'
        exact_artist = f'"{artist_name}"' if artist_name else ""
        exact_album = f'"{album_name}"' if album_name else ""
        exact_terms = " ".join(part for part in (exact_title, exact_artist, exact_album) if part)
        artist_terms = f' {artist_name}' if artist_name else ""
        # Start with Spotify's exact metadata. Broaden only after this single
        # search fails confidence checks, and always run fallback searches one
        # at a time so we never wait for slower alternatives unnecessarily.
        query_texts = [exact_terms]
        query_texts.append(f'{exact_title}{artist_terms} official audio')
        if artist_name:
            query_texts.append(f'{track_name} {artist_name}')
        if arabic_query_title and arabic_query_title.lower() != track_name.lower():
            translated_query = f'{arabic_query_title} {artist_name}'.strip()
            if translated_query not in query_texts:
                query_texts.append(translated_query)
        query_texts.append(track_name)
        query_texts = list(dict.fromkeys(query.strip() for query in query_texts if query.strip()))
        max_results = max(1, min(int(n_results), 8))

        def search_candidates(query_text):
            query = f'ytsearch{max_results}:{query_text}'
            options = {
                'quiet': True, 'no_warnings': True, 'extract_flat': True,
                'skip_download': True, 'ignoreerrors': True, 'noplaylist': True,
                'socket_timeout': 10, 'retries': 1, 'extractor_retries': 1,
            }
            try:
                with yt_dlp.YoutubeDL(options) as ydl:
                    info = ydl.extract_info(query, download=False)
                return (info.get('entries', []) if info else []) or []
            except Exception as exc:
                logger.debug(f"Spotify candidate search failed for query '{query_text}': {exc}")
                return []

        if not track_name.strip():
            return None

        title_words = {
            w for w in _normalize_arabic(track_name).split()
            if len(w) > 1 and w not in {"we", "wa"}
        }
        artist_words = {w for w in _normalize_arabic(artist_name).split() if len(w) > 1}
        if not title_words:
            return None
        expected_variants = set(_normalize_arabic(track_name).split())
        variant_markers = {
            'live', 'remix', 'cover', 'karaoke', 'instrumental', 'sped', 'slowed', 'nightcore',
            'لايف', 'حفله', 'ريمكس', 'كوفر', 'كاريوكي', 'مسرع', 'بطيء', 'حفلة',
        }
        def rank_candidates(entries):
            best = None
            best_score = 0.0
            best_title_coverage = 0.0
            best_artist_coverage = 0.0
            for entry in entries:
                if not entry or not entry.get('id'):
                    continue
                candidate_words = _matching_words(entry.get('title', ''))
                title_coverage = sum(_word_matches(word, candidate_words) for word in title_words) / len(title_words)
                artist_candidate_words = candidate_words | _matching_words(entry.get('uploader', '') or entry.get('channel', ''))
                artist_coverage = (
                    sum(_word_matches(word, artist_candidate_words, 2, 0.78) for word in artist_words) / len(artist_words)
                    if artist_words else 0.5
                )
                score = title_coverage * 0.68 + artist_coverage * 0.32
                if not (expected_variants & variant_markers) and candidate_words & variant_markers:
                    score -= 0.20
                duration = entry.get('duration')
                if expected_duration and duration:
                    delta = abs(float(duration) - float(expected_duration))
                    if delta <= 5:
                        score += 0.16
                    elif delta > 25 or delta / max(float(expected_duration), 1) > 0.18:
                        score -= 0.22
                logger.debug(
                    f"Spotify candidate: {entry.get('title', '')} | title={title_coverage:.2f} "
                    f"artist={artist_coverage:.2f} score={score:.2f}"
                )
                if score > best_score:
                    best = (f"https://www.youtube.com/watch?v={entry['id']}", score, title_coverage, artist_coverage)
                    best_score = score
                    best_title_coverage = title_coverage
                    best_artist_coverage = artist_coverage
            confident = best and best_score >= 0.62 and best_title_coverage >= 0.65 and (not artist_words or best_artist_coverage >= 0.4)
            return best, confident

        best = None
        best_score = 0.0
        # Search likely spellings first and stop as soon as one yields a
        # verified result; querying every variant made even a good match wait
        # for several slow YouTube searches to finish.
        max_search_attempts = min(len(query_texts), 4)
        for query_index, query_text in enumerate(query_texts[:max_search_attempts], start=1):
            if progress_callback:
                estimated_progress = min(82, 10 + (query_index - 1) * 20)
                try:
                    progress_callback(estimated_progress, query_index, max_search_attempts)
                except Exception as callback_error:
                    logger.debug(f"Spotify progress callback failed: {callback_error}")
            entries = search_candidates(query_text)
            candidate, confident = rank_candidates(entries)
            logger.info(
                f"Spotify YouTube search {query_index}/{max_search_attempts} for '{track_name}' "
                f"returned {len(entries)} candidates"
            )
            if candidate and candidate[1] > best_score:
                best, best_score = candidate, candidate[1]
            if confident:
                if progress_callback:
                    try:
                        progress_callback(90, query_index, max_search_attempts)
                    except Exception as callback_error:
                        logger.debug(f"Spotify progress callback failed: {callback_error}")
                break

        if not best or best[1] < 0.62 or best[2] < 0.65 or (artist_words and best[3] < 0.4):
            logger.warning(f"No confident YouTube match for '{track_name}' by '{artist_name}' (score={best_score:.2f})")
            return None
        logger.info(f"Best YouTube match for '{track_name}' by '{artist_name}': score={best[1]:.2f} -> {best[0]}")
        return best[0]
    except Exception as e:
        logger.error(f"pick_best_youtube_match failed: {e}")
        return None


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
    
def calculate_optimal_threads(total_size: int, url: str = "") -> int:
    if total_size <= 0:
        return 1
    # For mirrors/tokenized downloads like FileCR, servers often block > 4-6 concurrent connections
    url_lower = url.lower() if url else ""
    is_sensitive_host = any(x in url_lower for x in ["download_token", "filecr", "download.xyz", "1fichier", "mediafire"])

    if total_size < 5 * 1024 * 1024:        # < 5MB
        return 2
    elif total_size < 50 * 1024 * 1024:    # < 50MB
        return 4
    elif total_size < 300 * 1024 * 1024:   # < 300MB
        return 4 if is_sensitive_host else 8
    else:                                  # Large files
        return 6 if is_sensitive_host else 16

class DownloadContext:
    def __init__(self, download_id, url, on_update, save_path=None, quality="best", cookies=None, user_agent=None, referer=None, cookies_netscape=None, headers=None):
        self.id = download_id
        self.url = url
        self.on_update = on_update
        self.save_path = save_path
        self.quality = quality
        self.cookies = cookies
        self.cookies_netscape = cookies_netscape
        self.headers = headers or {}
        self.user_agent = user_agent
        self.referer = referer
        self.num_threads = 8
        self.stop_event = threading.Event()
        self.thread_stop_event = threading.Event()
        self.process = None
        self.title = ""
        self.filename = ""

def _release_download(ctx):
    """Drop finished worker state without removing a newer resumed worker."""
    if active_downloads.get(ctx.id) is ctx:
        active_downloads.pop(ctx.id, None)
        IN_MEMORY_DB_CACHE.pop(ctx.id, None)
        IN_MEMORY_DB_LAST_COMMIT.pop(ctx.id, None)

def start_download(url, db, use_ytdlp=False, on_update=None, save_path=None, quality="best", cookies=None, user_agent=None, referer=None, existing_id=None, title=None, cookies_netscape=None, headers=None):
    if save_path:
        norm_path = os.path.normpath(save_path)
        if not os.path.isabs(norm_path):
            norm_path = os.path.join(BASE_DOWNLOAD_DIR, norm_path)
        norm_path = os.path.abspath(norm_path)
        os.makedirs(norm_path, exist_ok=True)
        save_path = norm_path

    referer = get_smart_referer(url, referer)

    if existing_id:
        download_id = existing_id
        logger.info(f"Resuming download {download_id} for URL: {url}")
        db_rec = db.query(DownloadRecord).filter(DownloadRecord.id == download_id).first()
        if not db_rec:
            raise ValueError(f"Download record {download_id} no longer exists")
        db_rec.url = url
        db_rec.status = "starting"
        db_rec.filename = title or db_rec.filename
        db_rec.save_path = save_path or db_rec.save_path
        db_rec.quality = quality or db_rec.quality
        db_rec.error_message = ""
        db_rec.speed = 0
        if referer:
            db_rec.referer = referer
        if cookies:
            db_rec.cookies = cookies
        if user_agent:
            db_rec.user_agent = user_agent
        db.commit()
        cached = IN_MEMORY_DB_CACHE.setdefault(download_id, {})
        cached.pop("status", None)
        cached.pop("resolving", None)
        cached.pop("error_message", None)
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
    
    ctx = DownloadContext(download_id, url, on_update, save_path, quality, cookies, user_agent, referer, cookies_netscape=cookies_netscape, headers=headers)
    ctx.title = title or getattr(db_rec, 'filename', '') or ''
    ctx.filename = getattr(db_rec, 'filename', '') or ''
    active_downloads[download_id] = ctx
    
    if use_ytdlp:
        def run_ytdlp():
            try:
                _run_ytdlp(ctx)
            finally:
                _release_download(ctx)

        thread = threading.Thread(target=run_ytdlp)
        thread.daemon = True
        thread.start()
    else:
        def run_async_download():
            try:
                with download_semaphore:
                    if ctx.thread_stop_event.is_set() or ctx.stop_event.is_set():
                        return
                    _update_db(ctx, status="downloading")
                    asyncio.run(_run_chunked_download_async(ctx))
            finally:
                _release_download(ctx)
        
        thread = threading.Thread(target=run_async_download)
        thread.daemon = True
        thread.start()
        
    return download_id


# Global cache to prevent constant disk I/O on SQLite
IN_MEMORY_DB_CACHE = {}
IN_MEMORY_DB_LAST_COMMIT = {}

def _update_db(ctx, **kwargs):
    global IN_MEMORY_DB_CACHE

    if kwargs.get("status") == "completed" and "completed_at" not in kwargs:
        kwargs["completed_at"] = time.time() * 1000
    
    # Always update memory cache immediately
    if ctx.id not in IN_MEMORY_DB_CACHE:
        IN_MEMORY_DB_CACHE[ctx.id] = {}
    IN_MEMORY_DB_CACHE[ctx.id].update(kwargs)
    
    # Persist progress periodically so the websocket/API (which read SQLite) see
    # live byte counts, while avoiding a disk write for every network chunk.
    should_commit_to_db = False
    if "status" in kwargs:
        should_commit_to_db = True
    elif "error_message" in kwargs and kwargs["error_message"]:
        should_commit_to_db = True
    elif "filename" in kwargs and "total_size" in kwargs:
        should_commit_to_db = True
    elif any(key in kwargs for key in ("progress", "downloaded", "speed", "total_size")):
        now = time.monotonic()
        last_commit = IN_MEMORY_DB_LAST_COMMIT.get(ctx.id, 0)
        if now - last_commit >= 0.75:
            should_commit_to_db = True

    if should_commit_to_db:
        db = SessionLocal()
        try:
            rec = db.query(DownloadRecord).filter(DownloadRecord.id == ctx.id).first()
            if rec:
                # Flush everything from cache to the real DB (skip None values)
                for k, v in IN_MEMORY_DB_CACHE[ctx.id].items():
                    if v is not None:
                        setattr(rec, k, v)
                db.commit()
                IN_MEMORY_DB_LAST_COMMIT[ctx.id] = time.monotonic()
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
        # yt-dlp still has to inspect the source and select a format before
        # bytes arrive. Keep that setup phase separate from real transfer so
        # the UI never claims a download is running at 0 B/s for several seconds.
        _update_db(ctx, status="preparing", speed=0)
        
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
    
    # Resolve a direct Spotify track URL before selecting its YouTube source.
    spotify_host = (urlparse(url).hostname or '').lower()
    if spotify_host == 'open.spotify.com' or spotify_host == 'spotify.link' or spotify_host.endswith('.spotify.link'):
        try:
            from resolvers.spotify import resolve_spotify
            spotify_result = resolve_spotify(url)
            resolved = (
                spotify_result.get("tracks", [])[0]
                if spotify_result and spotify_result.get("type") == "track" and spotify_result.get("tracks")
                else None
            )
            if not resolved:
                raise RuntimeError("Could not read Spotify track metadata")

            track_name = resolved.get("title", "")
            artist_name = resolved.get("artist", "")
            ctx.title = f"{artist_name} - {track_name}" if artist_name else track_name
            if not ctx.filename:
                ctx.filename = ctx.title
            ctx.quality = "audio"
            best_url = pick_best_youtube_match(
                track_name, artist_name, n_results=6,
                expected_duration=resolved.get("duration"), album_name=resolved.get("album", ""),
                progress_callback=lambda progress, _attempt, _total: _update_db(
                    ctx, status="resolving", progress=progress, speed=0
                )
            )
            if not best_url:
                _update_db(
                    ctx, status="error", progress=0, speed=0,
                    error_message=f"No confident YouTube match for Spotify track: {track_name}"
                )
                raise RuntimeError(f"No confident YouTube match for Spotify track: {track_name}")
            ctx.url = best_url
            _update_db(ctx, status="preparing", progress=0, speed=0, downloaded=0, total_size=0)
            logger.info(f"Spotify match verified -> {best_url}")
        except Exception as e:
            logger.error(f"Spotify download stopped because no verified YouTube match was found: {e}")
            raise
            
    base_dir = ctx.save_path or BASE_DOWNLOAD_DIR
    if not AUTO_CATEGORIZE:
        video_dir = base_dir
    elif ctx.quality == "audio":
        video_dir = os.path.join(base_dir, "Audio")
    else:
        video_dir = os.path.join(base_dir, "Videos")
    os.makedirs(video_dir, exist_ok=True)
    
    FFMPEG_PATH = resolve_binary("ffmpeg.exe")
    if FFMPEG_PATH and os.path.exists(FFMPEG_PATH):
        ffmpeg_dir = os.path.dirname(FFMPEG_PATH)
        if ffmpeg_dir not in os.environ.get('PATH', ''):
            os.environ['PATH'] = ffmpeg_dir + os.pathsep + os.environ.get('PATH', '')

    
    last_update = time.time()
    transfer_started = False
    
    def progress_hook(d):
        nonlocal last_update, transfer_started
        
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
            has_transfer_data = downloaded > 0 or speed > 0 or prog > 0
            if has_transfer_data:
                first_transfer_update = not transfer_started
                transfer_started = True
                if first_transfer_update or now - last_update > 0.5:
                    kwargs = dict(
                        progress=prog, speed=speed, downloaded=downloaded,
                        total_size=total_size, status="downloading",
                    )
                    if filename:
                        kwargs['filename'] = filename
                    _update_db(ctx, **kwargs)
                    last_update = now
            elif filename and now - last_update > 1.0:
                # Keep the chosen filename current while the source is being
                # prepared, without presenting a fake zero-speed transfer.
                _update_db(ctx, filename=filename)
                last_update = now
                
        elif d['status'] == 'finished':
            filename = d.get('info_dict', {}).get('_filename') or d.get('filename')
            if filename:
                filename = os.path.basename(filename)
                # Read actual file size from disk to fix "0 bytes" display issue
                try:
                    actual_size = os.path.getsize(filename if os.path.isabs(filename) else
                                                  os.path.join(video_dir, filename))
                except Exception:
                    actual_size = d.get('downloaded_bytes', 0) or 0
                _update_db(ctx, progress=100.0, status="processing",
                           filename=filename,
                           downloaded=actual_size,
                           total_size=actual_size if actual_size > 0 else None)
            else:
                _update_db(ctx, progress=100.0, status="processing")
                
    def postprocessor_hook(d):
        if d.get('status') == 'finished':
            info = d.get('info_dict', {})
            filepath = info.get('filepath') or d.get('filepath')
            if filepath and os.path.exists(filepath):
                try:
                    sz = os.path.getsize(filepath)
                    if sz > 0:
                        _update_db(ctx, total_size=sz, downloaded=sz)
                except Exception:
                    pass
            
    # Use a safer outtmpl to avoid Windows path length limits and invalid arguments
    outtmpl_path = video_dir.replace('\\', '/') + '/%(title).100s.%(ext)s'
    
    ydl_opts = {
        'outtmpl': outtmpl_path,
        'progress_hooks': [progress_hook],
        'postprocessor_hooks': [postprocessor_hook],
        'noplaylist': True,
        'nocheckcertificate': True,
        'quiet': True,
        'no_warnings': True,
        'ignoreerrors': False,
        'restrictfilenames': False,
        'windowsfilenames': True,
        'trim_file_name': 200,
        'concurrent_fragment_downloads': 16,
        'http_chunk_size': 10485760,
        'socket_timeout': 12,
        'retries': 5,
        'fragment_retries': 5,
        'extractor_retries': 2,
        'file_access_retries': 3,
        'remote_components': ['ejs:github'],
        'extractor_args': {
            # Avoid yt-dlp's logged-in tv_downgraded client, which currently
            # returns "The page needs to be reloaded" for some YouTube videos.
            'youtube': ['player_client=web_safari,web_embedded,-tv_downgraded', 'player_skip=configs'],
            'generic': ['impersonate']
        },
        'http_headers': {
            'User-Agent': ctx.user_agent or 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
    
    if ctx.headers and isinstance(ctx.headers, dict):
        for hk, hv in ctx.headers.items():
            if hk.lower() not in ('cookie', 'host'):
                ydl_opts['http_headers'][hk] = hv

    if ctx.referer:
        ydl_opts['http_headers']['Referer'] = ctx.referer

    # Ensure Deno is in PATH so yt-dlp can solve YouTube challenges locally
    deno_path = resolve_binary("deno.exe")
    if deno_path and os.path.exists(deno_path):
        deno_dir = os.path.dirname(deno_path)
        if deno_dir not in os.environ.get('PATH', ''):
            os.environ['PATH'] = deno_dir + os.pathsep + os.environ.get('PATH', '')

    temp_cookie_path = None
    try:
        if ctx.cookies_netscape and ctx.cookies_netscape.strip():
            import tempfile
            tf = tempfile.NamedTemporaryFile(mode='w', suffix='_cookies.txt', delete=False, encoding='utf-8')
            tf.write(ctx.cookies_netscape)
            tf.close()
            temp_cookie_path = tf.name
            ydl_opts['cookiefile'] = temp_cookie_path
        elif ctx.cookies and ctx.cookies.strip():
            try:
                host = urlparse(ctx.url).hostname or 'youtube.com'
                domain = f".{host}" if not host.startswith('.') else host
                netscape_lines = ["# Netscape HTTP Cookie File", "# Generated by LEDO Downloader"]
                expiry = str(int(time.time() + 86400 * 30))
                for c in ctx.cookies.split(';'):
                    if '=' in c:
                        ck, cv = c.strip().split('=', 1)
                        if ck and cv:
                            netscape_lines.append(f"{domain}\tTRUE\t/\tTRUE\t{expiry}\t{ck.strip()}\t{cv.strip()}")
                import tempfile
                tf = tempfile.NamedTemporaryFile(mode='w', suffix='_cookies.txt', delete=False, encoding='utf-8')
                tf.write('\n'.join(netscape_lines) + '\n')
                tf.close()
                temp_cookie_path = tf.name
                ydl_opts['cookiefile'] = temp_cookie_path
            except Exception as ce:
                logger.warning(f"Failed to generate Netscape cookiefile: {ce}")
                ydl_opts['http_headers']['Cookie'] = ctx.cookies
    except Exception as ce:
        logger.warning(f"Error preparing cookies for {ctx.id}: {ce}")
    
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
    elif ctx.quality == "1080p":
        ydl_opts['format'] = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo+bestaudio/best'
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
        is_youtube_url = False
        try:
            youtube_host = (urlparse(ctx.url).hostname or '').lower()
            is_youtube_url = (
                youtube_host == 'youtu.be'
                or youtube_host == 'youtube.com'
                or youtube_host.endswith('.youtube.com')
            )
        except Exception:
            pass

        def extract_and_download(options):
            try:
                with yt_dlp.YoutubeDL(options) as ydl:
                    return ydl.extract_info(ctx.url, download=True)
            except Exception as exc:
                err_str = str(exc)
                if any(w in err_str for w in ["The page needs to be reloaded", "reload", "confirm you're not a bot", "Sign in", "UNPLAYABLE"]):
                    logger.warning(f"Encountered YouTube challenge/reload error for {ctx.id}; auto-recovering: {exc}")
                    retry_options = []
                    if options.get('cookiefile'):
                        # Public videos often work better without the browser's
                        # logged-in cookies; retain the same format and client.
                        clean_opts = dict(options)
                        clean_opts['cookiefile'] = None
                        retry_options.append(('web_safari without cookies', clean_opts))

                    # Last fallback: use iOS alone, still explicitly excluding
                    # the problematic tv_downgraded client.
                    ios_opts = dict(options)
                    ios_opts['extractor_args'] = {
                        'youtube': ['player_client=ios,-tv_downgraded', 'player_skip=configs']
                    }
                    retry_options.append(('iOS client', ios_opts))

                    for label, retry_opts in retry_options:
                        try:
                            with yt_dlp.YoutubeDL(retry_opts) as ydl_retry:
                                return ydl_retry.extract_info(ctx.url, download=True)
                        except Exception as retry_exc:
                            logger.warning(f"YouTube {label} retry failed for {ctx.id}: {retry_exc}")
                raise exc

        info_dict = extract_and_download(ydl_opts)

        if info_dict is None:
            raise Exception("Failed to extract video information or video unavailable.")

        logger.success(f"yt-dlp download {ctx.id} finished processing.")
        # Check if user requested pause during post-processing (ffmpeg merge/convert)
        if ctx.stop_event.is_set():
            logger.info(f"yt-dlp download {ctx.id} was paused during post-processing, marking as paused.")
            _update_db(ctx, progress=100.0, status="paused", speed=0)
        else:
            # ── Thorough final file-size resolution ──
            # Scan multiple sources to find the REAL downloaded file.
            final_size = 0
            final_filepath = None

            try:
                # Source 1: requested_downloads (best source — post-FFmpeg path)
                if info_dict:
                    pps = info_dict.get('requested_downloads', [])
                    if pps and isinstance(pps, list):
                        for dl_entry in pps:
                            fp = dl_entry.get('filepath') or dl_entry.get('filename')
                            if fp and os.path.exists(fp):
                                sz = os.path.getsize(fp)
                                if sz > final_size:
                                    final_size = sz
                                    final_filepath = fp

                # Source 2: info_dict _filename / filename (pre-FFmpeg, raw download)
                if final_size == 0 and info_dict:
                    for key in ['filepath', '_filename', 'filename']:
                        fp = info_dict.get(key)
                        if fp and os.path.exists(fp):
                            sz = os.path.getsize(fp)
                            if sz > final_size:
                                final_size = sz
                                final_filepath = fp
                                break

                # Source 3: Brute-force scan the download directory for recently created files
                if final_size == 0:
                    import glob
                    now_ts = time.time()
                    # Scan all media files created in the last 120 seconds
                    for ext in ['*.mp3', '*.m4a', '*.mp4', '*.mkv', '*.webm', '*.opus', '*.ogg', '*.aac', '*.wav']:
                        for candidate in glob.glob(os.path.join(video_dir, ext)):
                            try:
                                stat = os.stat(candidate)
                                # File must be recent (created in last 2 minutes)
                                if (now_ts - stat.st_mtime) < 120 and stat.st_size > final_size:
                                    final_size = stat.st_size
                                    final_filepath = candidate
                            except Exception:
                                continue
                
                # Source 4: Search by recorded filename (strip extension, try all formats)
                if final_size == 0 and ctx.filename:
                    base = os.path.splitext(ctx.filename)[0]
                    for ext in ['.mp3', '.m4a', '.mp4', '.mkv', '.webm', '.opus', '.ogg']:
                        candidate = os.path.join(video_dir, base + ext)
                        if os.path.exists(candidate):
                            sz = os.path.getsize(candidate)
                            if sz > 0:
                                final_size = sz
                                final_filepath = candidate
                                break

            except Exception as sz_err:
                logger.warning(f"Could not determine final file size for {ctx.id}: {sz_err}")

            if final_size > 0:
                update_kwargs = {
                    "progress": 100.0,
                    "status": "completed",
                    "downloaded": final_size,
                    "total_size": final_size,
                }
                if final_filepath:
                    update_kwargs["filename"] = os.path.basename(final_filepath)
                _update_db(ctx, **update_kwargs)
                logger.info(f"Download {ctx.id} completed successfully: {final_size} bytes -> {final_filepath}")
            else:
                # No file found at all → this download actually FAILED silently
                logger.error(f"Download {ctx.id} reported success but NO file found on disk!")
                _update_db(ctx, status="error", progress=0,
                           error_message="Download completed but no file was saved. The video may be unavailable or the search returned no results.")
        # Clean up any leftover yt-dlp temp files after successful completion
        _cleanup_ytdlp_temps(video_dir)
            
    except Exception as e:
        if "Download paused/stopped by user" in str(e):
            logger.info(f"yt-dlp download {ctx.id} paused/stopped.")
            _update_db(ctx, status="paused", speed=0)
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
    finally:
        # Always clean up temporary Netscape cookie file
        if temp_cookie_path:
            try:
                os.unlink(temp_cookie_path)
            except Exception:
                pass

async def _download_chunk_async(ctx, session, start, end, part_num, final_path, downloaded_list, total_size, start_time, lock, last_update_list):
    part_path = f"{final_path}.part{part_num}"
    
    # Resume capability: check if part exists and its size
    existing_size = 0
    if os.path.exists(part_path):
        existing_size = os.path.getsize(part_path)
        expected_size = end - start + 1
        # A stale/oversized part must not be concatenated into the final file.
        if existing_size > expected_size:
            os.remove(part_path)
            existing_size = 0
    
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
    headers = {
        "Range": f"bytes={current_start}-{end}",
        "User-Agent": ctx.user_agent or 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        "Accept": "*/*",
        "Accept-Encoding": "identity",
    }
    if ctx.cookies:
        headers["Cookie"] = ctx.cookies
    effective_ref = ctx.referer or get_smart_referer(ctx.url)
    if effective_ref:
        headers["Referer"] = effective_ref
    
    try:
        # Append mode if resuming, write if starting fresh
        mode = "ab" if existing_size > 0 else "wb"
        async with session.get(ctx.url, headers=headers) as response:
            if response.status != 206:
                if response.status >= 400:
                    raise Exception(_http_status_error(response.status))
                raise Exception(f"Server stopped honoring byte ranges for chunk {part_num} (HTTP {response.status}); retry the download.")
            content_range = response.headers.get("Content-Range", "")
            range_match = re.match(r"bytes (\d+)-(\d+)/(\d+|\*)$", content_range)
            if not range_match or int(range_match.group(1)) != current_start or int(range_match.group(2)) != end:
                raise Exception(f"Server returned an invalid byte range for chunk {part_num}: {content_range or 'missing Content-Range'}")
                
            async with aiofiles.open(part_path, mode) as f:
                async for chunk in response.content.iter_chunked(262144): # 256KB chunks for faster disk IO
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

def get_smart_referer(url: str, referer: Optional[str] = None) -> Optional[str]:
    """
    Returns an appropriate Referer header for download requests.
    If an explicit referer is provided and valid, it is preserved.
    Otherwise, deduces the required referer for protected hosting sites (FileCR, MediaFire, etc.)
    or falls back to the origin domain of the download URL.
    """
    if referer and str(referer).strip():
        ref = str(referer).strip()
        # If user passed their own local client URL as referer, ignore it
        if not ref.startswith(('http://localhost', 'http://127.0.0.1')):
            return ref

    if not url:
        return None

    url_lower = url.lower()
    try:
        parsed = urlparse(url)
        hostname = (parsed.hostname or '').lower()
    except Exception:
        hostname = ''
        parsed = None

    # 1. FileCR & its storage mirror networks (s1-download.xyz, s2-download.xyz, etc.)
    if (
        'filecr' in url_lower
        or 'download.xyz' in hostname
        or 's1-download' in hostname
        or 's2-download' in hostname
        or 's3-download' in hostname
        or '[filecr]' in url_lower
    ):
        return 'https://filecr.com/'

    # 2. MediaFire
    if 'mediafire.com' in hostname:
        return 'https://www.mediafire.com/'

    # 3. PixelDrain
    if 'pixeldrain.com' in hostname:
        return 'https://pixeldrain.com/'

    # 4. 1Fichier
    if '1fichier.com' in hostname:
        return 'https://1fichier.com/'

    # 5. Gofile
    if 'gofile.io' in hostname:
        return 'https://gofile.io/'

    # 6. Default to origin domain if hostname exists
    if parsed and parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}/"

    return None

def _http_status_error(status: int) -> str:
    if status == 401:
        return "HTTP 401: authentication is required. Sign in to the site in your browser and send the link again."
    if status == 403:
        return "HTTP 403: access denied. The site may require browser cookies, a matching referrer, or may block external download tools."
    if status == 404:
        return "HTTP 404: the link may have expired or only work in the browser session that created it. Reopen the file page and send Ledo the fresh download link."
    if status == 429:
        return "HTTP 429: too many requests. Wait a little and retry."
    return f"HTTP {status}: the site rejected the download request. It may require a browser session or a fresh link."

async def _run_chunked_download_async(ctx: DownloadContext):
    logger.info(f"Starting async chunk download: {ctx.id}")
    
    # Default browser-like headers for direct file downloads
    default_ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    
    # Ensure smart referer
    ctx.referer = get_smart_referer(ctx.url, ctx.referer)

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
            
            # If HEAD failed or returned 404/403/405 (many CDNs reject HEAD), retry with GET range=0-0
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
            
            # If still 403 or 404, try alternative smart referers (e.g. FileCR main site vs CDN domain)
            if head_status in (403, 404):
                candidates = []
                smart_ref = get_smart_referer(ctx.url)
                if smart_ref and smart_ref != headers.get('Referer'):
                    candidates.append(smart_ref)
                try:
                    parsed = urlparse(ctx.url)
                    origin_ref = f"{parsed.scheme}://{parsed.netloc}/"
                    if origin_ref not in candidates and origin_ref != headers.get('Referer'):
                        candidates.append(origin_ref)
                except Exception:
                    pass
                
                for cand in candidates:
                    try:
                        retry_headers = {**headers, 'Referer': cand, 'Range': 'bytes=0-0'}
                        async with session.get(ctx.url, allow_redirects=True, headers=retry_headers) as retry_req:
                            if retry_req.status in (200, 206):
                                head_status = retry_req.status
                                head_headers = retry_req.headers
                                final_url = str(retry_req.url)
                                headers['Referer'] = cand
                                ctx.referer = cand
                                logger.info(f"Recovered download probe using smart referer: {cand}")
                                break
                    except Exception as retry_err:
                        logger.warning(f"Referer probe candidate {cand} failed: {retry_err}")
            
            if head_status not in (200, 206):
                if head_status == 0 and last_error_msg:
                    raise Exception(f"Network error: {last_error_msg}")
                else:
                    raise Exception(_http_status_error(head_status))
                
            total_size = int(head_headers.get('Content-Length', 0))

            # Some servers advertise Accept-Ranges but ignore Range requests.
            # Verify with a one-byte probe before starting parallel writers.
            supports_ranges = False
            try:
                probe_headers = {**headers, 'Range': 'bytes=0-0'}
                async with session.get(ctx.url, headers=probe_headers, allow_redirects=True) as probe:
                    if probe.status == 206:
                        supports_ranges = True
                        final_url = str(probe.url)
                        content_range = probe.headers.get('Content-Range', '')
                        match = re.search(r'/([0-9]+)$', content_range)
                        if match:
                            total_size = int(match.group(1))
                        elif not total_size:
                            total_size = int(probe.headers.get('Content-Length', 0))
                        await probe.content.read(1)
                    else:
                        # Consume/close the response without buffering the file.
                        probe.close()
            except Exception as e:
                logger.debug(f"Range probe failed for {ctx.id}; using single stream: {e}")
            
            # --- Extract filename properly ---
            filename = _extract_filename(head_headers, ctx.url, final_url)
            
            if ctx.save_path:
                cat_dir = get_category_dir(filename, base_dir=ctx.save_path)
            else:
                cat_dir = get_category_dir(filename)
            final_path = os.path.join(cat_dir, filename)
            
            _update_db(ctx, total_size=total_size, filename=filename, status="downloading")
            logger.info(f"Download size for {ctx.id}: {total_size} bytes. Filename: {filename}. Target: {final_path}")
            
            if total_size == 0 or not supports_ranges:
                logger.warning(f"Server does not support range requests for {ctx.id}, falling back to single stream.")
                await _normal_download_async(ctx, session, final_path, total_size, headers)
                return

            num_threads = calculate_optimal_threads(total_size, ctx.url)
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
                _update_db(ctx, status="paused", speed=0)
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
        effective_ref = ctx.referer or get_smart_referer(ctx.url)
        if effective_ref and 'Referer' not in headers:
            headers['Referer'] = effective_ref

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
            if response.status >= 400:
                raise Exception(_http_status_error(response.status))

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
                        _update_db(ctx, status='paused', speed=0)
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
