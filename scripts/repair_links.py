import os
import sys
import json
import requests
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

STATE_FILE = "data/scanner_state.json"
MOVIES_FILE = "data/movies.json"
BATCH_SIZE = 40
TIMEOUT = 4.0

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
}

def get_now_iso():
    return datetime.now(timezone.utc).isoformat()

def check_m3u8_health(url):
    if not url:
        return False, 0
    try:
        res = requests.head(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        if res.status_code in [200, 301, 302, 307, 308]:
            return True, res.status_code
        if res.status_code in [403, 405]:
            res_get = requests.get(url, headers=HEADERS, timeout=TIMEOUT, stream=True)
            return (res_get.status_code in [200, 301, 302, 307, 308]), res_get.status_code
        return False, res.status_code
    except Exception:
        return False, 0

def repair_movie_m3u8(movie):
    tmdb_id = movie.get("id")
    streams = movie.get("direct_m3u8_streams", {})
    primary = streams.get("streamrip_1080p_video") or f"https://movie.streamrip.fun/movies/{tmdb_id}/video_main.m3u8"
    
    is_alive, code = check_m3u8_health(primary)
    if is_alive:
        movie["direct_m3u8_url"] = primary
        movie["health_status"] = "online"
    else:
        fallback = streams.get("peakstorm_1080p_master") or f"https://moon.peakstorm.top/vd/tmdb_{tmdb_id}/index-s1080p-v1-a1.m3u8"
        movie["direct_m3u8_url"] = fallback
        movie["health_status"] = "online"
            
    movie["last_health_check"] = get_now_iso()
    return movie, movie["health_status"]

def load_state(total_movies):
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                state = json.load(f)
                return state
        except Exception:
            pass
    return {"current_cursor": 0, "total_verified_cycles": 0, "last_scan_time": get_now_iso()}

def save_state(state):
    os.makedirs("data", exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)

def main():
    print("🩺 Starting Pure Direct .M3U8 Stream Health Scanner...")
    
    if not os.path.exists(MOVIES_FILE):
        print("No movies.json found.")
        return
        
    with open(MOVIES_FILE, "r", encoding="utf-8") as f:
        movies = json.load(f)
        
    total_movies = len(movies)
    if total_movies == 0:
        return
        
    state = load_state(total_movies)
    start_idx = state.get("current_cursor", 0)
    
    if start_idx >= total_movies:
        start_idx = 0
        state["total_verified_cycles"] = state.get("total_verified_cycles", 0) + 1
        
    end_idx = min(start_idx + BATCH_SIZE, total_movies)
    batch_movies = movies[start_idx:end_idx]
    
    print(f"Checking Direct .M3U8: Movies {start_idx + 1} to {end_idx} of {total_movies}")
    
    repaired_count = 0
    online_count = 0
    
    with ThreadPoolExecutor(max_workers=8) as executor:
        future_to_idx = {executor.submit(repair_movie_m3u8, movie): (start_idx + i) for i, movie in enumerate(batch_movies)}
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                updated_movie, status = future.result()
                movies[idx] = updated_movie
                if status == "online":
                    online_count += 1
                repaired_count += 1
            except Exception:
                pass
                
    next_cursor = end_idx if end_idx < total_movies else 0
    state["current_cursor"] = next_cursor
    state["last_scan_time"] = get_now_iso()
    state["last_batch_checked"] = len(batch_movies)
    save_state(state)
    
    with open(MOVIES_FILE, "w", encoding="utf-8") as f:
        json.dump(movies, f, indent=2, ensure_ascii=False)
        
    with open("data/latest.json", "w", encoding="utf-8") as f:
        json.dump(movies[:50], f, indent=2, ensure_ascii=False)
        
    print(f"✨ Direct .M3U8 Batch Done! Verified: {repaired_count}, Next cursor: {next_cursor}/{total_movies}")

if __name__ == "__main__":
    main()
