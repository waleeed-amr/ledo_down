import time
import json
import os
import requests
import queue
import threading
from loguru import logger

# Using the public REST API for Firestore to keep it ultra-lightweight and decoupled
# without needing the Admin SDK or service accounts on the desktop client.
FIREBASE_PROJECT_ID = "group-a0ee4"
FIRESTORE_API_URL = f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}/databases/(default)/documents/crash_reports"

# Thread-safe queue for telemetry events
telemetry_queue = queue.Queue()

def _send_to_firestore(event_data):
    """
    Sends an event payload to Firestore using the REST API.
    Does not require auth since the Firestore rules allow create for all.
    """
    try:
        # Format for Firestore REST API
        # We need to map standard JSON to Firestore types (stringValue, mapValue, etc)
        # For simplicity, we just serialize the whole payload into a string field or structured map.
        
        # Helper to convert to Firestore Document format
        def to_fs_value(val):
            if isinstance(val, dict):
                return {"mapValue": {"fields": {k: to_fs_value(v) for k, v in val.items()}}}
            elif isinstance(val, int):
                return {"integerValue": str(val)}
            elif isinstance(val, bool):
                return {"booleanValue": val}
            else:
                return {"stringValue": str(val)}

        firestore_payload = {
            "fields": {
                k: to_fs_value(v) for k, v in event_data.items()
            }
        }
        
        response = requests.post(FIRESTORE_API_URL, json=firestore_payload, timeout=5)
        response.raise_for_status()
        logger.debug(f"Telemetry sent successfully: {event_data.get('event_id', 'unknown')}")
    except Exception as e:
        logger.error(f"Failed to send telemetry event: {str(e)}")
        # In a real offline mode, we would write this to a local buffer file here.

def _telemetry_worker():
    """
    Background worker that constantly processes the telemetry queue.
    Completely decoupled from the main download thread.
    """
    logger.info("Cloud Telemetry Worker started.")
    while True:
        try:
            event = telemetry_queue.get(block=True)
            if event is None: # Poison pill to exit
                break
            _send_to_firestore(event)
            telemetry_queue.task_done()
        except Exception as e:
            logger.error(f"Telemetry worker error: {str(e)}")

# Start the worker thread
_worker_thread = threading.Thread(target=_telemetry_worker, daemon=True)
_worker_thread.start()

def report_error(error_category, message, domain="unknown", stack_trace="", user_id="guest"):
    """
    Public API for the main backend to report an error asynchronously.
    """
    event = {
        "event_id": f"err_{int(time.time()*1000)}",
        "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        "error_category": error_category,
        "error_message": message,
        "target_domain": domain,
        "user_id": user_id,
        "stack_trace": stack_trace,
        "status": "new"
    }
    # Non-blocking put
    try:
        telemetry_queue.put_nowait(event)
    except queue.Full:
        pass
