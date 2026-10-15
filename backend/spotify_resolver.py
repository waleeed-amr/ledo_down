"""
Spotify URL Resolver for Ledo Downloader
Handles track, album, playlist, and artist Spotify URLs by extracting metadata
from Spotify's embed pages and converting them to YouTube search queries.
"""
import re
import json
import urllib.request
from loguru import logger
from typing import Optional, List, Dict


def _fetch_url(url: str, timeout: int = 10) -> Optional[str]:
    """Fetch a URL and return the response body as string."""
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        logger.warning(f"Failed to fetch {url}: {e}")
        return None


def _get_embed_entity(spotify_id: str, content_type: str) -> Optional[Dict]:
    """
    Fetch the Spotify embed page and extract the entity data from __NEXT_DATA__.
    Returns the entity dict with keys like: name, artists, type, trackList, etc.
    """
    url = f"https://open.spotify.com/embed/{content_type}/{spotify_id}"
    html = _fetch_url(url)
    if not html:
        return None
    
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not m:
        return None
    
    try:
        data = json.loads(m.group(1))
        page_props = data.get("props", {}).get("pageProps", {})
        state = page_props.get("state", {})
        entity = state.get("data", {}).get("entity")
        return entity
    except Exception as e:
        logger.warning(f"Failed to parse embed data for {content_type}/{spotify_id}: {e}")
        return None


def _get_oembed_title(url: str) -> Optional[str]:
    """Fetch the OEmbed title for a Spotify URL (works for tracks and playlists)."""
    try:
        oembed_url = f"https://open.spotify.com/oembed?url={url}"
        body = _fetch_url(oembed_url, timeout=5)
        if body:
            data = json.loads(body)
            return data.get("title")
    except Exception as e:
        logger.warning(f"OEmbed failed for {url}: {e}")
    return None


def _duration_seconds(item: Dict) -> Optional[float]:
    """Read Spotify duration fields when present in embed payloads."""
    if not isinstance(item, dict):
        return None
    for key in ("duration_ms", "durationMs", "totalMilliseconds"):
        value = item.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return float(value) / 1000
    value = item.get("duration")
    if isinstance(value, dict):
        return _duration_seconds(value)
    if isinstance(value, (int, float)) and value > 0:
        return float(value) / 1000 if value > 1000 else float(value)
    return None


def _parse_spotify_url(url: str) -> Optional[Dict]:
    """
    Parse a Spotify URL and extract the content type and ID.
    Supports: track, album, playlist, artist, and short links (spotify.link).
    Returns: {"type": "track"|"album"|"playlist", "id": "..."}
    """
    # Handle spotify.link short URLs - resolve them first
    if "spotify.link/" in url:
        try:
            req = urllib.request.Request(url, method="HEAD", headers={
                "User-Agent": "Mozilla/5.0"
            })
            resp = urllib.request.urlopen(req, timeout=5)
            url = resp.url
        except Exception as e:
            logger.warning(f"Failed to resolve spotify.link: {e}")
            return None

    # Match open.spotify.com/{type}/{id}
    m = re.search(r'open\.spotify\.com/(track|album|playlist|artist)/([a-zA-Z0-9]+)', url)
    if m:
        return {"type": m.group(1), "id": m.group(2), "url": url}
    
    return None


def resolve_spotify_track(spotify_id: str, original_url: str = "") -> Optional[Dict]:
    """
    Resolve a single Spotify track to a YouTube search query with metadata.
    Returns: {
        "search_query": "ytsearch1:Artist - Track Name audio",
        "title": "Track Name",
        "artist": "Artist Name",
        "album": "Album Name" (if available)
    }
    """
    # Strategy 1: Embed page (best - has artist info)
    entity = _get_embed_entity(spotify_id, "track")
    if entity and entity.get("name"):
        track_name = entity["name"]
        artists = [a["name"] for a in entity.get("artists", []) if a.get("name")]
        artist_str = ", ".join(artists) if artists else ""
        
        result = {
            "title": track_name,
            "artist": artist_str,
        }
        duration = _duration_seconds(entity)
        if duration:
            result["duration"] = duration
        
        if artist_str:
            result["search_query"] = f'ytsearch1:{track_name} {artist_str} audio'
        else:
            result["search_query"] = f'ytsearch1:{track_name} audio'
        
        logger.info(f"Spotify track resolved via embed: {result['search_query']}")
        return result
    
    # Strategy 2: OEmbed fallback (less info but reliable)
    oembed_title = _get_oembed_title(original_url or f"https://open.spotify.com/track/{spotify_id}")
    if oembed_title:
        clean_title = re.sub(r' \| Spotify$', '', oembed_title)
        clean_title = re.sub(r' - song and lyrics by ', ' ', clean_title)
        clean_title = re.sub(r' - song by ', ' ', clean_title)
        
        result = {
            "title": clean_title,
            "artist": "",
            "search_query": f'ytsearch1:{clean_title} audio'
        }
        logger.info(f"Spotify track resolved via OEmbed: {result['search_query']}")
        return result
    
    logger.error(f"Failed to resolve Spotify track: {spotify_id}")
    return None


def resolve_spotify_album(spotify_id: str) -> Optional[List[Dict]]:
    """
    Resolve a Spotify album to a list of track search queries.
    Uses the embed page which contains a trackList.
    Returns: list of track dicts (same format as resolve_spotify_track)
    """
    entity = _get_embed_entity(spotify_id, "album")
    
    # The album embed may not have trackList, so we try alternate approach
    tracks = []
    
    if entity and entity.get("trackList"):
        album_name = entity.get("name", "")
        album_artists = [a["name"] for a in entity.get("artists", []) if a.get("name")]
        
        for track in entity["trackList"]:
            track_title = track.get("title", "")
            track_artist = track.get("subtitle", "")  # subtitle = artist in trackList
            track_uri = track.get("uri", "")  # spotify:track:XXXX
            
            if not track_title:
                continue
            
            artist = track_artist or ", ".join(album_artists)
            search = f'ytsearch1:{track_title} {artist} audio' if artist else f'ytsearch1:{track_title} audio'
            
            tracks.append({
                "title": track_title,
                "artist": artist,
                "album": album_name,
                **({"duration": _duration_seconds(track)} if _duration_seconds(track) else {}),
                "search_query": search,
            })
        
        if tracks:
            logger.info(f"Spotify album '{album_name}' resolved: {len(tracks)} tracks")
            return tracks
    
    # Fallback: try fetching the album page HTML for track links
    logger.warning(f"Album embed didn't have trackList, trying HTML fallback")
    html = _fetch_url(f"https://open.spotify.com/album/{spotify_id}")
    if html:
        # Find all track IDs in the page
        track_ids = re.findall(r'open\.spotify\.com/track/([a-zA-Z0-9]+)', html)
        track_ids = list(dict.fromkeys(track_ids))  # deduplicate, preserve order
        
        if track_ids:
            logger.info(f"Found {len(track_ids)} track IDs in album HTML")
            for tid in track_ids:
                resolved = resolve_spotify_track(tid)
                if resolved:
                    tracks.append(resolved)
            return tracks if tracks else None
    
    logger.error(f"Failed to resolve Spotify album: {spotify_id}")
    return None


def resolve_spotify_playlist(spotify_id: str) -> Optional[List[Dict]]:
    """
    Resolve a Spotify playlist. Uses OEmbed for title, then tries embed for tracks.
    """
    entity = _get_embed_entity(spotify_id, "playlist")
    tracks = []
    
    if entity and entity.get("trackList"):
        playlist_name = entity.get("name", "")
        
        for track in entity["trackList"]:
            track_title = track.get("title", "")
            track_artist = track.get("subtitle", "")
            
            if not track_title:
                continue
            
            search = f'ytsearch1:{track_title} {track_artist} audio' if track_artist else f'ytsearch1:{track_title} audio'
            tracks.append({
                "title": track_title,
                "artist": track_artist,
                **({"duration": _duration_seconds(track)} if _duration_seconds(track) else {}),
                "search_query": search,
            })
        
        if tracks:
            logger.info(f"Spotify playlist '{playlist_name}' resolved: {len(tracks)} tracks")
            return tracks
    
    logger.error(f"Failed to resolve Spotify playlist: {spotify_id}")
    return None


def resolve_spotify_artist(spotify_id: str) -> Optional[List[Dict]]:
    """Resolve an artist profile to the Top tracks exposed by Spotify's embed."""
    entity = _get_embed_entity(spotify_id, "artist")
    if not entity or not isinstance(entity.get("trackList"), list):
        logger.error(f"Failed to resolve Spotify artist: {spotify_id}")
        return None

    artist_name = entity.get("name", "")
    tracks = []
    for track in entity["trackList"]:
        title = track.get("title", "")
        if not title:
            continue
        artist = track.get("subtitle", "") or artist_name
        tracks.append({
            "title": title,
            "artist": artist,
            **({"duration": _duration_seconds(track)} if _duration_seconds(track) else {}),
            "search_query": f'ytsearch1:{title} {artist} audio' if artist else f'ytsearch1:{title} audio',
        })

    if tracks:
        logger.info(f"Spotify artist '{artist_name}' resolved: {len(tracks)} top tracks")
        return tracks
    logger.error(f"Spotify artist has no playable top tracks: {spotify_id}")
    return None


def is_spotify_url(url: str) -> bool:
    """Check if a URL is a Spotify URL."""
    return "spotify.com/" in url.lower() or "spotify.link/" in url.lower()


def resolve_spotify(url: str) -> Optional[Dict]:
    """
    Main entry point: resolve any Spotify URL.
    Returns:
    {
        "type": "track" | "album" | "playlist" | "artist",
        "tracks": [
            {
                "search_query": "ytsearch1:Artist - Title audio",
                "title": "Track Name",
                "artist": "Artist Name",
                "album": "Album Name" (optional)
            },
            ...
        ]
    }
    """
    parsed = _parse_spotify_url(url)
    if not parsed:
        logger.warning(f"Could not parse Spotify URL: {url}")
        return None
    
    content_type = parsed["type"]
    spotify_id = parsed["id"]
    
    if content_type == "track":
        track = resolve_spotify_track(spotify_id, url)
        if track:
            return {"type": "track", "tracks": [track]}
    
    elif content_type == "album":
        tracks = resolve_spotify_album(spotify_id)
        if tracks:
            return {"type": "album", "tracks": tracks}
    
    elif content_type == "playlist":
        tracks = resolve_spotify_playlist(spotify_id)
        if tracks:
            return {"type": "playlist", "tracks": tracks}

    elif content_type == "artist":
        tracks = resolve_spotify_artist(spotify_id)
        if tracks:
            return {"type": "artist", "artist": tracks[0].get("artist", ""), "tracks": tracks}
    
    return None
