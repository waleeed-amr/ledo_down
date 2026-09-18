const fs = require('fs');

let content = fs.readFileSync('backend/main.py', 'utf-8');

// Ensure IN_MEMORY_DB_CACHE is imported
content = content.replace(
    'start_download, active_downloads, get_category_dir, BASE_DOWNLOAD_DIR,',
    'start_download, active_downloads, get_category_dir, BASE_DOWNLOAD_DIR, IN_MEMORY_DB_CACHE,'
);

// Modify broadcast_downloads
const oldBroadcast = `async def broadcast_downloads():
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
            logger.error(f"Error broadcasting downloads: {e}")`;

const newBroadcast = `async def broadcast_downloads():
    with SessionLocal() as db:
        try:
            records = db.query(DownloadRecord).all()
            downloads = []
            now_ms = time.time() * 1000
            for rec in records:
                dl = {
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
                }
                
                # Merge fresh memory cache data over stale DB data
                if rec.id in IN_MEMORY_DB_CACHE:
                    mem_data = IN_MEMORY_DB_CACHE[rec.id]
                    for k, v in mem_data.items():
                        if k in dl:
                            dl[k] = v
                            
                downloads.append(dl)
            
            payload = {
                "type": "downloads",
                "downloads": downloads
            }
            await manager.broadcast(orjson.dumps(payload).decode('utf-8'))
        except Exception as e:
            logger.error(f"Error broadcasting downloads: {e}")`;

content = content.replace(oldBroadcast, newBroadcast);
fs.writeFileSync('backend/main.py', content, 'utf-8');
console.log('main.py optimized');
