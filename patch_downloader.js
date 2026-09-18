const fs = require('fs');

let content = fs.readFileSync('backend/downloader.py', 'utf-8');

const oldUpdateDb = `def _update_db(ctx, **kwargs):
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
        ctx.on_update(ctx.id)`;

const newUpdateDb = `
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
`;

content = content.replace(oldUpdateDb, newUpdateDb);
fs.writeFileSync('backend/downloader.py', content, 'utf-8');
console.log('downloader.py optimized');
