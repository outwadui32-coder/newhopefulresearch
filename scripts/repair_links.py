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
BATCH_SIZE = 40 # Process 40 movies per run to stay well within GitHub Actions time limit
TIMEOUT = 4.0   # Fast timeout in seconds

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
}

def get_now_iso():
    return datetime.now(timezone.utc).isoformat()

def check_url_health(url):
    """Fast check if a video stream server is alive and responding"""
    if not url:
        return False, 0
    try:
        # Try fast HEAD request first
        res = requests.head(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        if res.status_code in [200, 301, 302, 307, 308]:
            return True, res.status_code
        if res.status_code in [403, 405]: # Some embed servers block HEAD, try quick GET
            res_get = requests.get(url, headers=HEADERS, timeout=TIMEOUT, stream=True)
            return (res_get.status_code in [200, 301, 302, 307, 308]), res_get.status_code
        return False, res.status_code
    except Exception:
        return False, 0

def repair_movie_links(movie):
    """Test all stream servers for a movie, prioritize healthy servers, and repair dead links"""
    tmdb_id = movie.get("id")
    current_servers = movie.get("stream_servers", {})
    
    # Complete pool of fallback embed providers
    candidate_servers = {
        "vidbolt": f"https://vidbolt.xyz/movie/{tmdb_id}",
        "vidlink": f"https://vidlink.pro/movie/{tmdb_id}",
        "videasy": f"https://player.videasy.to/movie/{tmdb_id}",
        "autoembed": f"https://player.autoembed.cc/embed/movie/{tmdb_id}",
        "vidfast": f"https://vidfast.vc/movie/{tmdb_id}",
        "vidcore": f"https://vidcore.net/movie/{tmdb_id}",
        "vidnest": f"https://vidnest.fun/movie/{tmdb_id}",
        "vidsrc": f"https://vidsrc.to/embed/movie/{tmdb_id}",
        "multiembed": f"https://multiembed.mov/directstream.php?video_id={tmdb_id}&tmdb=1"
    }
    
    # Merge existing servers
    candidate_servers.update(current_servers)
    
    healthy_servers = {}
    dead_servers = {}
    
    # Test primary candidates
    for name, url in candidate_servers.items():
        is_alive, code = check_url_health(url)
        if is_alive:
            healthy_servers[name] = url
        else:
            dead_servers[name] = url
            
    # Determine health status
    if len(healthy_servers) >= 2:
        health_status = "online"
    elif len(healthy_servers) == 1:
        health_status = "warning"
    else:
        # Fallback to default embed list if all network checks blocked
        healthy_servers = candidate_servers
        health_status = "unverified"

    # Select best working primary stream link
    best_server_name = list(healthy_servers.keys())[0]
    best_stream_url = healthy_servers[best_server_name]
    
    movie["stream_servers"] = healthy_servers
    movie["primary_stream_url"] = best_stream_url
    movie["health_status"] = health_status
    movie["last_health_check"] = get_now_iso()
    
    return movie, health_status

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
    print("🩺 Starting Dedicated Batch Dead Link Repair Scanner...")
    
    if not os.path.exists(MOVIES_FILE):
        print("No movies.json found. Run scraper.py first.")
        return
        
    with open(MOVIES_FILE, "r", encoding="utf-8") as f:
        movies = json.load(f)
        
    total_movies = len(movies)
    if total_movies == 0:
        print("Movie list is empty.")
        return
        
    state = load_state(total_movies)
    start_idx = state.get("current_cursor", 0)
    
    # Handle wrap-around
    if start_idx >= total_movies:
        start_idx = 0
        state["total_verified_cycles"] = state.get("total_verified_cycles", 0) + 1
        
    end_idx = min(start_idx + BATCH_SIZE, total_movies)
    batch_movies = movies[start_idx:end_idx]
    
    print(f"Checking Batch: Movies {start_idx + 1} to {end_idx} of {total_movies} (Batch Size: {len(batch_movies)})")
    
    repaired_count = 0
    online_count = 0
    
    # Process batch in parallel using ThreadPool
    with ThreadPoolExecutor(max_workers=8) as executor:
        future_to_idx = {executor.submit(repair_movie_links, movie): (start_idx + i) for i, movie in enumerate(batch_movies)}
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                updated_movie, status = future.result()
                movies[idx] = updated_movie
                if status == "online":
                    online_count += 1
                repaired_count += 1
            except Exception as e:
                print(f"Error checking movie index {idx}: {e}")
                
    # Update cursor for next run
    next_cursor = end_idx if end_idx < total_movies else 0
    state["current_cursor"] = next_cursor
    state["last_scan_time"] = get_now_iso()
    state["last_batch_checked"] = len(batch_movies)
    save_state(state)
    
    # Save repaired database
    with open(MOVIES_FILE, "w", encoding="utf-8") as f:
        json.dump(movies, f, indent=2, ensure_ascii=False)
        
    # Also update latest.json
    with open("data/latest.json", "w", encoding="utf-8") as f:
        json.dump(movies[:50], f, indent=2, ensure_ascii=False)
        
    print(f"✨ Batch Completed! Verified: {repaired_count}, Healthy: {online_count}. Next cursor: {next_cursor}/{total_movies}")

if __name__ == "__main__":
    main()
