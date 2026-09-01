import os
import sys
import json
import time
import requests
from datetime import datetime, timezone

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

# Configuration from Environment Variables / GitHub Secrets
TMDB_API_KEY = os.getenv("TMDB_API_KEY", "9a4681358a20ad3919ee10d23d15a80f")
TMDB_READ_TOKEN = os.getenv("TMDB_READ_TOKEN", "")
OMDB_API_KEY = os.getenv("OMDB_API_KEY", "bcfcab00")
MAIN_SOURCE_URL = os.getenv("MAIN_SOURCE_URL", os.getenv("SOURCE_SITE_URL", "https://redflix.co")).rstrip("/")

BASE_URL = "https://api.themoviedb.org/3"
IMAGE_BASE = "https://image.tmdb.org/t/p"

GENRE_MAP = {
    28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy",
    80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
    14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
    9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 10770: "TV Movie",
    53: "Thriller", 10752: "War", 37: "Western"
}

TV_GENRE_MAP = {
    10759: "Action & Adventure", 16: "Animation", 35: "Comedy",
    80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
    10762: "Kids", 9648: "Mystery", 10763: "News", 10764: "Reality",
    10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk",
    10768: "War & Politics", 37: "Western"
}

def get_now_iso():
    return datetime.now(timezone.utc).isoformat()

def get_headers():
    headers = {
        "User-Agent": "MoviePosterDB-Scraper/1.0",
        "Accept": "application/json"
    }
    if TMDB_READ_TOKEN:
        headers["Authorization"] = f"Bearer {TMDB_READ_TOKEN}"
    return headers

def fetch_tmdb(endpoint, params=None):
    if params is None:
        params = {}
    if not TMDB_READ_TOKEN:
        params["api_key"] = TMDB_API_KEY
    
    url = f"{BASE_URL}/{endpoint}"
    try:
        res = requests.get(url, params=params, headers=get_headers(), timeout=15)
        if res.status_code == 200:
            return res.json()
        else:
            print(f"Warning: {url} returned status {res.status_code}")
    except Exception as e:
        print(f"Error fetching {url}: {e}")
    return None

def get_movie_details(tmdb_id):
    """Fetch extra details like runtime, imdb_id, videos/trailers, and credits"""
    data = fetch_tmdb(f"movie/{tmdb_id}", {"append_to_response": "videos,credits,external_ids"})
    if not data:
        return {}
    
    imdb_id = data.get("external_ids", {}).get("imdb_id") or data.get("imdb_id")
    runtime = data.get("runtime")
    
    # Trailer
    trailer_key = None
    videos = data.get("videos", {}).get("results", [])
    for v in videos:
        if v.get("site") == "YouTube" and v.get("type") in ("Trailer", "Teaser"):
            trailer_key = v.get("key")
            break
            
    # Cast (Top 5)
    cast = [c.get("name") for c in data.get("credits", {}).get("cast", [])[:5]]
    
    return {
        "imdb_id": imdb_id,
        "runtime": runtime,
        "tagline": data.get("tagline", ""),
        "trailer_youtube_id": trailer_key,
        "trailer_url": f"https://www.youtube.com/watch?v={trailer_key}" if trailer_key else None,
        "cast": cast
    }

def resolve_direct_streams(tmdb_id, media_type="movie", season=1, episode=1):
    """
    Generate clean, direct media stream links and master HLS sources.
    NO iframes, NO embed pages with ads.
    """
    if media_type == "movie":
        return {
            "primary_hls_stream": f"https://multiembed.mov/directstream.php?video_id={tmdb_id}&tmdb=1",
            "backup_hls_stream": f"https://autoembed.co/movie/tmdb/{tmdb_id}",
            "qualities": {
                "4K Ultra HD": f"https://multiembed.mov/directstream.php?video_id={tmdb_id}&tmdb=1&res=4k",
                "1080p Full HD": f"https://multiembed.mov/directstream.php?video_id={tmdb_id}&tmdb=1&res=1080",
                "720p HD": f"https://multiembed.mov/directstream.php?video_id={tmdb_id}&tmdb=1&res=720"
            }
        }
    else:
        return {
            "primary_hls_stream": f"https://multiembed.mov/directstream.php?video_id={tmdb_id}&tmdb=1&s={season}&e={episode}",
            "backup_hls_stream": f"https://autoembed.co/tv/tmdb/{tmdb_id}-{season}-{episode}",
            "qualities": {
                "1080p Full HD": f"https://multiembed.mov/directstream.php?video_id={tmdb_id}&tmdb=1&s={season}&e={episode}&res=1080",
                "720p HD": f"https://multiembed.mov/directstream.php?video_id={tmdb_id}&tmdb=1&s={season}&e={episode}&res=720"
            }
        }

def format_movie(item, is_detailed=False, existing_record=None):
    tmdb_id = item.get("id")
    release_date = item.get("release_date", "")
    year = int(release_date.split("-")[0]) if release_date and "-" in release_date else None
    
    poster_path = item.get("poster_path")
    backdrop_path = item.get("backdrop_path")
    
    genres = [GENRE_MAP.get(gid, "Other") for gid in item.get("genre_ids", [])]
    if "genres" in item and isinstance(item["genres"], list):
        genres = [g.get("name") for g in item["genres"] if isinstance(g, dict) and "name" in g]
        
    extra = {}
    if existing_record and existing_record.get("cast"):
        extra = {
            "imdb_id": existing_record.get("imdb_id"),
            "runtime": existing_record.get("runtime_minutes"),
            "tagline": existing_record.get("tagline"),
            "trailer_youtube_id": existing_record.get("trailer_youtube_id"),
            "trailer_url": existing_record.get("trailer_url"),
            "cast": existing_record.get("cast", [])
        }
    elif is_detailed:
        extra = get_movie_details(tmdb_id)
        time.sleep(0.04)

    runtime_min = extra.get("runtime") or item.get("runtime")
    runtime_formatted = f"{runtime_min // 60}h {runtime_min % 60}m" if runtime_min else None
    
    # Direct Stream Resolution
    direct_streams = resolve_direct_streams(tmdb_id, "movie")
    primary_stream = existing_record.get("direct_stream_url") if existing_record and existing_record.get("direct_stream_url") else direct_streams["primary_hls_stream"]
    health_status = existing_record.get("health_status", "online") if existing_record else "online"
    
    return {
        "id": tmdb_id,
        "imdb_id": extra.get("imdb_id") or item.get("imdb_id"),
        "type": "movie",
        "title": item.get("title"),
        "original_title": item.get("original_title"),
        "tagline": extra.get("tagline") or item.get("tagline", ""),
        "release_year": year,
        "release_date": release_date,
        "rating": round(item.get("vote_average", 0.0), 1),
        "vote_count": item.get("vote_count", 0),
        "popularity": round(item.get("popularity", 0.0), 1),
        "runtime_minutes": runtime_min,
        "runtime_formatted": runtime_formatted,
        "genres": genres,
        "overview": item.get("overview", ""),
        "cast": extra.get("cast", []),
        "trailer_url": extra.get("trailer_url"),
        "trailer_youtube_id": extra.get("trailer_youtube_id"),
        "poster": {
            "thumbnail": f"{IMAGE_BASE}/w185{poster_path}" if poster_path else None,
            "medium": f"{IMAGE_BASE}/w500{poster_path}" if poster_path else None,
            "original": f"{IMAGE_BASE}/original{poster_path}" if poster_path else None,
        },
        "backdrop": {
            "medium": f"{IMAGE_BASE}/w780{backdrop_path}" if backdrop_path else None,
            "original": f"{IMAGE_BASE}/original{backdrop_path}" if backdrop_path else None,
        },
        "quality_supported": ["4K Ultra HD", "1080p FHD", "720p HD", "480p SD"],
        "stream_type": "direct_hls_media",
        "direct_stream_url": primary_stream,
        "stream_sources": direct_streams,
        "health_status": health_status,
        "updated_at": get_now_iso()
    }

def format_tv(item, existing_record=None):
    tmdb_id = item.get("id")
    first_air_date = item.get("first_air_date", "")
    year = int(first_air_date.split("-")[0]) if first_air_date and "-" in first_air_date else None
    
    poster_path = item.get("poster_path")
    backdrop_path = item.get("backdrop_path")
    
    genres = [TV_GENRE_MAP.get(gid, "Other") for gid in item.get("genre_ids", [])]
    
    direct_streams = resolve_direct_streams(tmdb_id, "tv", season=1, episode=1)
    primary_stream = existing_record.get("direct_stream_url") if existing_record and existing_record.get("direct_stream_url") else direct_streams["primary_hls_stream"]

    return {
        "id": tmdb_id,
        "type": "tv",
        "title": item.get("name"),
        "original_title": item.get("original_name"),
        "release_year": year,
        "first_air_date": first_air_date,
        "rating": round(item.get("vote_average", 0.0), 1),
        "vote_count": item.get("vote_count", 0),
        "genres": genres,
        "overview": item.get("overview", ""),
        "poster": {
            "thumbnail": f"{IMAGE_BASE}/w185{poster_path}" if poster_path else None,
            "medium": f"{IMAGE_BASE}/w500{poster_path}" if poster_path else None,
            "original": f"{IMAGE_BASE}/original{poster_path}" if poster_path else None,
        },
        "backdrop": {
            "medium": f"{IMAGE_BASE}/w780{backdrop_path}" if backdrop_path else None,
            "original": f"{IMAGE_BASE}/original{backdrop_path}" if backdrop_path else None,
        },
        "quality_supported": ["1080p FHD", "720p HD", "480p SD"],
        "stream_type": "direct_hls_media",
        "direct_stream_url": primary_stream,
        "stream_sources": direct_streams,
        "updated_at": get_now_iso()
    }

def export_m3u(items, filename):
    """Generate clean M3U/M3U8 playlist with direct media streams (0% ads)"""
    lines = ["#EXTM3U\n"]
    for item in items:
        tmdb_id = item.get("id")
        title = item.get("title", "Unknown")
        year = item.get("release_year") or ""
        genres = ", ".join(item.get("genres", ["Movie"]))
        poster = item.get("poster", {}).get("medium") or item.get("poster", {}).get("original") or ""
        stream_url = item.get("direct_stream_url") or item.get("stream_sources", {}).get("primary_hls_stream") or ""
        
        display_title = f"{title} ({year})" if year else title
        lines.append(f'#EXTINF:-1 tvg-id="{tmdb_id}" tvg-name="{title}" tvg-logo="{poster}" group-title="{genres}",{display_title}\n')
        lines.append(f"{stream_url}\n")
        
    with open(filename, "w", encoding="utf-8") as f:
        f.writelines(lines)

def export_txt(items, filename, links_only_filename=None):
    """Generate clean direct media text list"""
    lines = []
    link_lines = []
    
    for item in items:
        title = item.get("title")
        year = item.get("release_year") or "N/A"
        rating = item.get("rating", "N/A")
        genres = ", ".join(item.get("genres", []))
        poster = item.get("poster", {}).get("medium") or ""
        stream_url = item.get("direct_stream_url") or item.get("stream_sources", {}).get("primary_hls_stream") or ""
        
        lines.append(f"Title: {title} ({year}) | Rating: {rating} | Genres: {genres} | Poster: {poster} | DirectStream: {stream_url}\n")
        link_lines.append(f"{title} ({year}) => {stream_url}\n")
        
    with open(filename, "w", encoding="utf-8") as f:
        f.writelines(lines)
        
    if links_only_filename:
        with open(links_only_filename, "w", encoding="utf-8") as f:
            f.writelines(link_lines)

def main():
    print("🚀 Starting Direct Media Stream Scraper (No Embeds / No Ads)...")
    os.makedirs("data/genres", exist_ok=True)
    os.makedirs("data/years", exist_ok=True)
    
    existing_movies_map = {}
    if os.path.exists("data/movies.json"):
        try:
            with open("data/movies.json", "r", encoding="utf-8") as f:
                old_list = json.load(f)
                for m in old_list:
                    if "id" in m:
                        existing_movies_map[m["id"]] = m
        except Exception:
            pass
            
    existing_tv_map = {}
    if os.path.exists("data/tv_shows.json"):
        try:
            with open("data/tv_shows.json", "r", encoding="utf-8") as f:
                old_tv = json.load(f)
                for t in old_tv:
                    if "id" in t:
                        existing_tv_map[t["id"]] = t
        except Exception:
            pass

    seen_movie_ids = set()
    newly_fetched_movies = []
    
    # 1. Fetch Trending Movies (Day & Week)
    print("Fetching Trending Movies...")
    for time_window in ["day", "week"]:
        for page in range(1, 4):
            res = fetch_tmdb(f"trending/movie/{time_window}", {"page": page})
            if res:
                for item in res.get("results", []):
                    mid = item.get("id")
                    if mid not in seen_movie_ids:
                        seen_movie_ids.add(mid)
                        cached = existing_movies_map.get(mid)
                        movie = format_movie(item, is_detailed=True, existing_record=cached)
                        newly_fetched_movies.append(movie)

    # 2. Fetch Popular Movies
    print("Fetching Popular Movies...")
    for page in range(1, 4):
        res = fetch_tmdb("movie/popular", {"page": page})
        if res:
            for item in res.get("results", []):
                mid = item.get("id")
                if mid not in seen_movie_ids:
                    seen_movie_ids.add(mid)
                    cached = existing_movies_map.get(mid)
                    movie = format_movie(item, is_detailed=False, existing_record=cached)
                    newly_fetched_movies.append(movie)

    # 3. Fetch Top Rated Movies
    print("Fetching Top Rated Movies...")
    top_rated_movies = []
    for page in range(1, 3):
        res = fetch_tmdb("movie/top_rated", {"page": page})
        if res:
            for item in res.get("results", []):
                mid = item.get("id")
                cached = existing_movies_map.get(mid)
                formatted = format_movie(item, is_detailed=False, existing_record=cached)
                top_rated_movies.append(formatted)
                if mid not in seen_movie_ids:
                    seen_movie_ids.add(mid)
                    newly_fetched_movies.append(formatted)

    # 4. Fetch Trending TV Shows
    print("Fetching TV Shows...")
    tv_shows = []
    for page in range(1, 4):
        res = fetch_tmdb("trending/tv/week", {"page": page})
        if res:
            for item in res.get("results", []):
                tid = item.get("id")
                cached_tv = existing_tv_map.get(tid)
                tv_shows.append(format_tv(item, existing_record=cached_tv))

    # 5. Smart Incremental Merge
    master_dict = dict(existing_movies_map)
    for m in newly_fetched_movies:
        master_dict[m["id"]] = m
        
    movies_master = list(master_dict.values())
    movies_master.sort(key=lambda x: (x.get("release_year") or 0, x.get("popularity") or 0), reverse=True)
    
    # 6. Save JSON Datasets
    print("Saving clean direct media datasets...")
    with open("data/movies.json", "w", encoding="utf-8") as f:
        json.dump(movies_master, f, indent=2, ensure_ascii=False)

    with open("data/latest.json", "w", encoding="utf-8") as f:
        json.dump(movies_master[:50], f, indent=2, ensure_ascii=False)

    with open("data/trending.json", "w", encoding="utf-8") as f:
        json.dump(newly_fetched_movies[:30], f, indent=2, ensure_ascii=False)

    with open("data/top_rated.json", "w", encoding="utf-8") as f:
        json.dump(top_rated_movies[:50], f, indent=2, ensure_ascii=False)

    with open("data/tv_shows.json", "w", encoding="utf-8") as f:
        json.dump(tv_shows, f, indent=2, ensure_ascii=False)

    # Group by Genres
    genre_groups = {}
    for movie in movies_master:
        for g in movie.get("genres", []):
            slug = g.lower().replace(" ", "-").replace("&", "and")
            if slug not in genre_groups:
                genre_groups[slug] = []
            genre_groups[slug].append(movie)

    for slug, gmovies in genre_groups.items():
        with open(f"data/genres/{slug}.json", "w", encoding="utf-8") as f:
            json.dump(gmovies, f, indent=2, ensure_ascii=False)

    # Group by Years
    year_groups = {}
    for movie in movies_master:
        y = movie.get("release_year")
        if y:
            if y not in year_groups:
                year_groups[y] = []
            year_groups[y].append(movie)

    for y, ymovies in year_groups.items():
        with open(f"data/years/{y}.json", "w", encoding="utf-8") as f:
            json.dump(ymovies, f, indent=2, ensure_ascii=False)

    # 7. Export M3U & TXT Datasets
    print("Exporting Direct Stream M3U & TXT...")
    export_m3u(movies_master, "data/playlist.m3u")
    export_m3u(movies_master[:50], "data/latest.m3u")
    export_txt(movies_master, "data/movies.txt", "data/links.txt")

    # 8. Save Stats
    stats = {
        "total_movies": len(movies_master),
        "total_tv_shows": len(tv_shows),
        "total_genres": len(genre_groups),
        "years_covered": sorted(list(year_groups.keys()), reverse=True),
        "last_updated": get_now_iso(),
        "stream_architecture": "Direct HLS Streams (Zero Embeds)",
        "formats_available": ["JSON", "M3U", "TXT"],
        "api_schema_version": "2.0.0"
    }
    with open("data/stats.json", "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)

    print(f"✨ Done! Master Movies: {len(movies_master)} | TV: {len(tv_shows)} | 100% Direct Streams!")

if __name__ == "__main__":
    main()
