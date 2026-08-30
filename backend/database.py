import os
import sys
from sqlalchemy import create_engine, Column, String, Float, Integer, Boolean, event
from sqlalchemy.orm import declarative_base, sessionmaker

def get_data_dir():
    if getattr(sys, 'frozen', False):
        base_dir = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'LedoDownloader')
        os.makedirs(base_dir, exist_ok=True)
        return base_dir
    else:
        return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

DB_PATH = os.path.join(get_data_dir(), "downloads.db")
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})

@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class DownloadRecord(Base):
    __tablename__ = "downloads"

    id = Column(String, primary_key=True, index=True)
    url = Column(String, index=True)
    filename = Column(String, default="")
    status = Column(String, default="starting")  # starting, downloading, paused, completed, error
    progress = Column(Float, default=0.0)
    speed = Column(Float, default=0.0)
    total_size = Column(Float, default=0.0)
    downloaded = Column(Float, default=0.0)
    is_yt_dlp = Column(Boolean, default=False)
    error_message = Column(String, default="")

Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
