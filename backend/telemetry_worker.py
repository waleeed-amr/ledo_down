"""
Ledo Downloader — Cloud Telemetry & Remote Admin Worker
========================================================
Handles:
  1. Automatic error/crash reporting to Firestore
  2. Startup heartbeat (anonymous usage stats)
  3. Fetching admin announcements for the user
  4. Checking for app updates (MediaFire link)
  5. Offline queue — buffers events when there's no internet

All communication uses the public Firestore REST API so that
NO user account or Firebase Auth is needed.
"""

import time
import json
import os
import sys
import uuid
import platform
import threading
import queue
import re
import traceback
import requests
from urllib.parse import urlparse
from loguru import logger

# ─── Firebase Config ──────────────────────────────────────────────────────────
FIREBASE_PROJECT_ID = "group-a0ee4"
FIRESTORE_BASE = f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}/databases/(default)/documents"

# ─── App Version (read from package.json at build time or fallback) ───────────
APP_VERSION = os.environ.get("LEDO_APP_VERSION", "unknown")
try:
    # In dev: read from package.json
    _pkg_path = os.path.join(os.path.dirname(__file__), "..", "package.json")
    if APP_VERSION == "unknown" and os.path.exists(_pkg_path):
        with open(_pkg_path, "r", encoding="utf-8") as f:
            APP_VERSION = json.load(f).get("version", "unknown")
except Exception:
    pass

# ─── Data Directory (user-writable, no admin needed) ──────────────────────────
DATA_DIR = os.path.join(
    os.environ.get("APPDATA", os.path.expanduser("~")),
    "Ledo Downloader"
)
os.makedirs(DATA_DIR, exist_ok=True)

# ─── Device ID (persistent, anonymous) ───────────────────────────────────────
DEVICE_ID_FILE = os.path.join(DATA_DIR, "device_id")
DISMISSED_FILE = os.path.join(DATA_DIR, "dismissed_announcements.json")
OFFLINE_QUEUE_FILE = os.path.join(DATA_DIR, "offline_telemetry_queue.json")

# A short cache keeps the local API responsive when the user opens Settings or
# manually checks more than once, while still allowing a newly published
# release to reach clients quickly.
UPDATE_CACHE_TTL_SECONDS = 5 * 60
_update_cache = {"checked_at": 0.0, "value": None}


def _get_or_create_device_id():
    """Generate a stable anonymous device ID, persisted across sessions."""
    try:
        if os.path.exists(DEVICE_ID_FILE):
            with open(DEVICE_ID_FILE, "r") as f:
                did = f.read().strip()
                if did:
                    return did
    except Exception:
        pass
    did = f"dev_{uuid.uuid4().hex[:16]}"
    try:
        with open(DEVICE_ID_FILE, "w") as f:
            f.write(did)
    except Exception:
        pass
    return did


DEVICE_ID = _get_or_create_device_id()


def _get_system_info():
    """Collect basic, non-personal system info for debugging."""
    try:
        return {
            "os": platform.system(),
            "os_version": platform.version(),
            "os_release": platform.release(),
            "arch": platform.machine(),
            "python": platform.python_version(),
            "app_version": APP_VERSION,
        }
    except Exception:
        return {"app_version": APP_VERSION}


# ═══════════════════════════════════════════════════════════════════════════════
#  Firestore REST API Helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _to_firestore_value(val):
    """Convert a Python value to Firestore REST API typed value."""
    if val is None:
        return {"nullValue": None}
    if isinstance(val, bool):
        return {"booleanValue": val}
    if isinstance(val, int):
        return {"integerValue": str(val)}
    if isinstance(val, float):
        return {"doubleValue": val}
    if isinstance(val, dict):
        return {"mapValue": {"fields": {k: _to_firestore_value(v) for k, v in val.items()}}}
    if isinstance(val, (list, tuple)):
        return {"arrayValue": {"values": [_to_firestore_value(v) for v in val]}}
    return {"stringValue": str(val)}


def _from_firestore_value(val):
    """Convert a Firestore typed value back to a Python value."""
    if "stringValue" in val:
        return val["stringValue"]
    if "integerValue" in val:
        return int(val["integerValue"])
    if "doubleValue" in val:
        return float(val["doubleValue"])
    if "booleanValue" in val:
        return val["booleanValue"]
    if "nullValue" in val:
        return None
    if "mapValue" in val:
        fields = val["mapValue"].get("fields", {})
        return {k: _from_firestore_value(v) for k, v in fields.items()}
    if "arrayValue" in val:
        values = val["arrayValue"].get("values", [])
        return [_from_firestore_value(v) for v in values]
    if "timestampValue" in val:
        return val["timestampValue"]
    return str(val)


def _from_firestore_doc(doc):
    """Convert a full Firestore document to a plain dict, including the doc ID."""
    fields = doc.get("fields", {})
    result = {k: _from_firestore_value(v) for k, v in fields.items()}
    # Extract document ID from the name path
    name = doc.get("name", "")
    if "/" in name:
        result["_id"] = name.rsplit("/", 1)[-1]
    return result


def _post_document(collection, data, timeout=8):
    """Create a new document in a Firestore collection."""
    url = f"{FIRESTORE_BASE}/{collection}"
    payload = {"fields": {k: _to_firestore_value(v) for k, v in data.items()}}
    resp = requests.post(url, json=payload, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def _get_collection(collection, timeout=8):
    """Read all documents from a Firestore collection."""
    url = f"{FIRESTORE_BASE}/{collection}"
    resp = requests.get(url, timeout=timeout)
    resp.raise_for_status()
    body = resp.json()
    docs = body.get("documents", [])
    return [_from_firestore_doc(d) for d in docs]


def _get_document(collection, doc_id, timeout=8):
    """Read a single document from Firestore."""
    url = f"{FIRESTORE_BASE}/{collection}/{doc_id}"
    resp = requests.get(url, timeout=timeout)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return _from_firestore_doc(resp.json())


# ═══════════════════════════════════════════════════════════════════════════════
#  Offline Queue — buffer events when there's no internet
# ═══════════════════════════════════════════════════════════════════════════════

def _load_offline_queue():
    """Load buffered events from disk."""
    try:
        if os.path.exists(OFFLINE_QUEUE_FILE):
            with open(OFFLINE_QUEUE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return []


def _save_offline_queue(items):
    """Save buffered events to disk."""
    try:
        with open(OFFLINE_QUEUE_FILE, "w", encoding="utf-8") as f:
            json.dump(items[-100:], f)  # Keep max 100 events
    except Exception:
        pass


def _flush_offline_queue():
    """Try to send all buffered events."""
    items = _load_offline_queue()
    if not items:
        return
    remaining = []
    for item in items:
        try:
            _post_document("crash_reports", item, timeout=5)
        except Exception:
            remaining.append(item)
    _save_offline_queue(remaining)


# ═══════════════════════════════════════════════════════════════════════════════
#  Telemetry Queue & Background Worker
# ═══════════════════════════════════════════════════════════════════════════════

telemetry_queue = queue.Queue(maxsize=200)


def _telemetry_worker():
    """Background thread that processes telemetry events."""
    logger.info("Cloud Telemetry Worker started.")

    # On startup, try to flush any offline-buffered events
    try:
        _flush_offline_queue()
    except Exception:
        pass

    while True:
        try:
            event = telemetry_queue.get(block=True, timeout=30)
            if event is None:
                break
            try:
                _post_document("crash_reports", event, timeout=8)
                logger.debug(f"Telemetry sent: {event.get('event_id', '?')}")
            except Exception as e:
                logger.warning(f"Telemetry send failed (buffering offline): {e}")
                # Buffer to offline queue
                offline = _load_offline_queue()
                offline.append(event)
                _save_offline_queue(offline)
            telemetry_queue.task_done()
        except queue.Empty:
            # Periodic flush of offline queue during idle
            try:
                _flush_offline_queue()
            except Exception:
                pass
        except Exception as e:
            logger.error(f"Telemetry worker error: {e}")


_worker_thread = threading.Thread(target=_telemetry_worker, daemon=True)
_worker_thread.start()


# ═══════════════════════════════════════════════════════════════════════════════
#  Public API — Error Reporting
# ═══════════════════════════════════════════════════════════════════════════════

def _parse_version(v_str):
    """Return a stable numeric version tuple, or ``None`` for an invalid value.

    We intentionally compare the first four numeric components only.  This
    makes ``3.9`` and ``3.9.0`` equal, instead of treating the latter as a
    newer build just because it has an extra zero.
    """
    value = str(v_str or "").strip()
    if not value:
        return None
    match = re.match(r"^v?(\d+(?:\.\d+){0,3})(?:[-+][0-9A-Za-z.-]+)?$", value)
    if not match:
        return None
    parts = [int(part) for part in match.group(1).split(".")]
    return tuple((parts + [0, 0, 0, 0])[:4])


def _is_safe_public_url(value):
    """Only pass absolute HTTPS links from remote configuration to the UI."""
    try:
        parsed = urlparse(str(value or "").strip())
        return parsed.scheme == "https" and bool(parsed.netloc)
    except Exception:
        return False


def report_error(error_category, message, domain="unknown", stack_trace="", extra=None):
    """
    Report an error to Firestore (non-blocking).
    Works without any user account.
    """
    # Format message to include traceback summary if available so admin dashboard table shows it
    formatted_msg = str(message)
    if stack_trace and str(stack_trace).strip() and str(stack_trace) not in formatted_msg:
        formatted_msg = f"{message}\n\n--- Stack Trace ---\n{str(stack_trace)[:1500]}"

    event = {
        "event_id": f"err_{uuid.uuid4().hex[:12]}",
        "device_id": DEVICE_ID,
        "email": f"Device: {DEVICE_ID}",  # Shows in Admin table 'Email' column
        "subject": f"[{error_category}] {domain}",  # Shows in Admin table 'Subject' column
        "message": formatted_msg,  # Required by Firestore rules and displayed in Admin table
        "raw_message": str(message),
        "error_category": str(error_category),
        "target_domain": str(domain),
        "stack_trace": str(stack_trace)[:2000],  # Truncate large traces
        "system_info": _get_system_info(),
        "status": "new",
        "createdAt": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),  # Required by Firestore rules
    }
    if extra and isinstance(extra, dict):
        event["extra"] = {k: str(v) for k, v in extra.items()}

    try:
        telemetry_queue.put_nowait(event)
    except queue.Full:
        pass


def report_exception(exc, context="", domain="unknown"):
    """
    Report a caught exception with full traceback.
    """
    tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
    report_error(
        error_category=type(exc).__name__,
        message=f"{context}: {str(exc)}" if context else str(exc),
        domain=domain,
        stack_trace="".join(tb),
    )


# ═══════════════════════════════════════════════════════════════════════════════
#  Public API — Startup Heartbeat
# ═══════════════════════════════════════════════════════════════════════════════

def send_heartbeat():
    """
    Send a startup heartbeat to Firestore so the admin can track
    active users count, popular versions, OS distribution, etc.
    Non-blocking, fire-and-forget.
    """
    def _do():
        try:
            data = {
                "device_id": DEVICE_ID,
                "app_version": APP_VERSION,
                "system_info": _get_system_info(),
                "message": "heartbeat",  # Required by Firestore rules
                "createdAt": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                "type": "heartbeat",
            }
            _post_document("heartbeats", data, timeout=8)
            logger.debug("Heartbeat sent successfully.")
        except Exception as e:
            logger.debug(f"Heartbeat failed (non-critical): {e}")

    threading.Thread(target=_do, daemon=True).start()


# ═══════════════════════════════════════════════════════════════════════════════
#  Public API — Announcements
# ═══════════════════════════════════════════════════════════════════════════════

def _load_dismissed():
    """Load the list of dismissed announcement IDs from disk."""
    try:
        if os.path.exists(DISMISSED_FILE):
            with open(DISMISSED_FILE, "r", encoding="utf-8") as f:
                return set(json.load(f))
    except Exception:
        pass
    return set()


def _save_dismissed(dismissed_set):
    """Persist dismissed announcement IDs."""
    try:
        with open(DISMISSED_FILE, "w", encoding="utf-8") as f:
            json.dump(list(dismissed_set), f)
    except Exception:
        pass


def fetch_announcements():
    """
    Fetch active announcements from Firestore, filtering out:
      - Dismissed ones
      - Ones not matching the current app version range
    Returns a list of dicts.
    """
    try:
        all_announcements = _get_collection("announcements", timeout=8)
        dismissed = _load_dismissed()

        result = []
        for ann in all_announcements:
            # Skip inactive
            if not ann.get("active", True):
                continue

            # Skip dismissed
            ann_id = ann.get("_id", "")
            if ann_id in dismissed:
                continue

            # Version filtering (optional)
            min_v = ann.get("min_version", "")
            max_v = ann.get("max_version", "")
            parsed_current = _parse_version(APP_VERSION)
            parsed_min = _parse_version(min_v) if min_v else None
            parsed_max = _parse_version(max_v) if max_v else None
            # Bad targeting data should not take down the announcements feed.
            if min_v and (parsed_min is None or parsed_current is None or parsed_current < parsed_min):
                continue
            if max_v and (parsed_max is None or parsed_current is None or parsed_current > parsed_max):
                continue

            ann["id"] = ann_id
            result.append(ann)

        # Sort by priority (high first), then by created_at (newest first)
        result.sort(key=lambda x: (
            0 if x.get("priority") == "high" else 1,
            x.get("created_at", "")
        ), reverse=False)

        return result
    except Exception as e:
        logger.debug(f"Failed to fetch announcements: {e}")
        return []


def dismiss_announcement(announcement_id):
    """Mark an announcement as dismissed so it won't show again."""
    dismissed = _load_dismissed()
    dismissed.add(announcement_id)
    _save_dismissed(dismissed)


# ═══════════════════════════════════════════════════════════════════════════════
#  Public API — Update Checker
# ═══════════════════════════════════════════════════════════════════════════════

def check_for_update(force=False):
    """
    Check Firestore for a newer app version.
    Returns update info dict if available, None otherwise.
    """
    now = time.monotonic()
    if not force and now - _update_cache["checked_at"] < UPDATE_CACHE_TTL_SECONDS:
        return _update_cache["value"]

    result = None
    try:
        update_doc = _get_document("app_config", "latest_update", timeout=8)
        if not update_doc:
            return None

        latest_version = update_doc.get("version", "")
        latest = _parse_version(latest_version)
        current = _parse_version(APP_VERSION)
        if not latest_version or latest is None or current is None:
            logger.warning("Ignoring an invalid update version in remote configuration.")
            return None

        # Never show an update which cannot be opened safely by the desktop
        # app.  The admin dashboard validates this too; this is defence in
        # depth for data edited outside the dashboard.
        download_url = update_doc.get("download_url", "")
        if latest > current and _is_safe_public_url(download_url):
            result = {
                "version": latest_version,
                "current_version": APP_VERSION,
                "download_url": download_url,
                "changelog": update_doc.get("changelog", ""),
                "required": update_doc.get("required", False),
                "released_at": update_doc.get("released_at", ""),
                "channel": update_doc.get("channel", "stable"),
                "sha256": update_doc.get("sha256", ""),
            }
        return result
    except Exception as e:
        logger.debug(f"Update check failed: {e}")
        return None
    finally:
        _update_cache["checked_at"] = now
        _update_cache["value"] = result


def get_public_links():
    """Return the website and legal links configured by the admin dashboard."""
    try:
        links = _get_document("app_config", "public_links", timeout=8) or {}
        allowed = ("website_url", "privacy_url", "terms_url", "support_url")
        return {key: links[key] for key in allowed if _is_safe_public_url(links.get(key))}
    except Exception as e:
        logger.debug(f"Failed to load public links: {e}")
        return {}


# ═══════════════════════════════════════════════════════════════════════════════
#  Loguru Integration — Auto-report errors logged via logger.error/critical
# ═══════════════════════════════════════════════════════════════════════════════

class _FirestoreLogSink:
    """
    A Loguru sink that automatically forwards ERROR and CRITICAL
    log messages to Firestore as crash reports.
    """

    def write(self, message):
        record = message.record
        level = record["level"].name
        if level not in ("ERROR", "CRITICAL"):
            return
        # Avoid recursive reporting of telemetry errors
        module = record.get("name", "")
        if "telemetry" in str(module):
            return
        report_error(
            error_category=f"log_{level.lower()}",
            message=str(record["message"])[:500],
            domain=str(record.get("name", "backend")),
            stack_trace=str(record.get("exception", ""))[:2000] if record.get("exception") else "",
            extra={
                "module": str(record.get("name", "")),
                "function": str(record.get("function", "")),
                "line": str(record.get("line", "")),
            }
        )


# Call this from main.py to connect Loguru → Firestore
firestore_sink = _FirestoreLogSink()


def install_loguru_sink():
    """
    Install the Firestore sink into Loguru so all ERROR/CRITICAL
    messages are automatically reported.
    """
    logger.add(firestore_sink, level="ERROR", format="{message}")
    logger.info("Firestore error reporting sink installed.")
