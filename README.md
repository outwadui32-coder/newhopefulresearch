# 🎬 OpenPosterDB & Redflix Automated Data Source

[![Auto Update Movie Database](https://github.com/outwadui32-coder/newhopefulresearch/actions/workflows/update_data.yml/badge.svg)](https://github.com/outwadui32-coder/newhopefulresearch/actions/workflows/update_data.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Database Status](https://img.shields.io/badge/Database-Active%20%26%20Synced-brightgreen)](data/stats.json)

An open-source, automated high-resolution movie & TV dataset, rating poster database, and multi-server streaming source powered by GitHub and **jsDelivr Global CDN**.

---

## 🚀 Free Live CDN Endpoints (Instant API Access)

No backend or database hosting required! Consume any of these high-speed CDN endpoints directly in your web or mobile applications:

| Dataset | Free jsDelivr CDN Endpoint (Cached & Fast) | Raw GitHub Link |
| :--- | :--- | :--- |
| **All Movies (Master)** | [`/data/movies.json`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/movies.json) | [`Raw`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/movies.json) |
| **Latest Movies (Top 50)** | [`/data/latest.json`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/latest.json) | [`Raw`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/latest.json) |
| **Trending This Week** | [`/data/trending.json`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/trending.json) | [`Raw`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/trending.json) |
| **Top Rated Movies** | [`/data/top_rated.json`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/top_rated.json) | [`Raw`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/top_rated.json) |
| **TV Shows & Web Series** | [`/data/tv_shows.json`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/tv_shows.json) | [`Raw`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/tv_shows.json) |
| **Database Stats** | [`/data/stats.json`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/stats.json) | [`Raw`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/stats.json) |

### 📂 Filter by Genre
- **Action**: `https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/genres/action.json`
- **Sci-Fi**: `https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/genres/sci-fi.json`
- **Horror**: `https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/genres/horror.json`
- **Drama**: `https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/genres/drama.json`
- *(All other genres available in `data/genres/`)*

### 📅 Filter by Year
- **2026 Movies**: `https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/years/2026.json`
- **2025 Movies**: `https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/years/2025.json`

---

## 📦 JSON Schema Structure

Each movie object contains rich metadata, high-res posters, trailers, and multi-server stream embeds:

```json
{
  "id": 969681,
  "imdb_id": "tt22084616",
  "type": "movie",
  "title": "Spider-Man: Brand New Day",
  "original_title": "Spider-Man: Brand New Day",
  "tagline": "A brand new day starts now.",
  "release_year": 2026,
  "release_date": "2026-07-29",
  "rating": 7.9,
  "vote_count": 2325,
  "popularity": 1028.0,
  "runtime_minutes": 145,
  "runtime_formatted": "2h 25m",
  "genres": ["Sci-Fi", "Action", "Adventure"],
  "overview": "Fighting crime full-time as Spider-Man in a world that doesn't remember him...",
  "cast": ["Tom Holland", "Zendaya", "Mark Ruffalo", "Jon Bernthal"],
  "trailer_url": "https://www.youtube.com/watch?v=PGL_1onLHlg",
  "trailer_youtube_id": "PGL_1onLHlg",
  "poster": {
    "thumbnail": "https://image.tmdb.org/t/p/w185/bjiS5ipwxb9JFy3XRRN4OAilSeX.jpg",
    "medium": "https://image.tmdb.org/t/p/w500/bjiS5ipwxb9JFy3XRRN4OAilSeX.jpg",
    "original": "https://image.tmdb.org/t/p/original/bjiS5ipwxb9JFy3XRRN4OAilSeX.jpg"
  },
  "backdrop": {
    "medium": "https://image.tmdb.org/t/p/w780/7iwUUcKURMT7aKfCwMy6YnGtchD.jpg",
    "original": "https://image.tmdb.org/t/p/original/7iwUUcKURMT7aKfCwMy6YnGtchD.jpg"
  },
  "quality_supported": ["4K Ultra HD", "1080p FHD", "720p HD", "480p SD"],
  "redflix_play_url": "https://redflix.co/play?id=969681&type=movie",
  "stream_servers": {
    "vidbolt": "https://vidbolt.xyz/movie/969681",
    "vidlink": "https://vidlink.pro/movie/969681",
    "videasy": "https://player.videasy.to/movie/969681",
    "vidfast": "https://vidfast.vc/movie/969681",
    "vidcore": "https://vidcore.net/movie/969681",
    "vidnest": "https://vidnest.fun/movie/969681",
    "autoembed": "https://player.autoembed.cc/embed/movie/969681",
    "vidsrc": "https://vidsrc.to/embed/movie/969681",
    "multiembed": "https://multiembed.mov/directstream.php?video_id=969681&tmdb=1"
  },
  "updated_at": "2026-09-01T09:40:38Z"
}
```

---

## ⚙️ How It Works (Automation Engine)

1. **GitHub Actions (`.github/workflows/update_data.yml`)**:
   - Executes every 12 hours via cron schedule.
   - Runs `scripts/scraper.py` using secure GitHub Repository Secrets.
   - Automatically commits and pushes new datasets if changes are detected.

2. **Secrets Protection**:
   - All API keys and source tokens are strictly kept in **GitHub Secrets** (`TMDB_API_KEY`, `TMDB_READ_TOKEN`, `OMDB_API_KEY`).
   - No sensitive credentials are exposed in public code.

---

## 💻 Local Development & Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/outwadui32-coder/newhopefulresearch.git
   cd newhopefulresearch
   ```

2. **Create Python virtual environment**:
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   pip install -r scripts/requirements.txt
   ```

3. **Set your API keys**:
   ```bash
   cp .env.example .env
   # Edit .env and enter your TMDB and OMDb API keys
   ```

4. **Run the scraper**:
   ```bash
   python scripts/scraper.py
   ```

5. **Preview the Web Catalog**:
   Open `index.html` in any web browser.

---

## 🔒 Adding GitHub Secrets for GitHub Actions

To allow GitHub Actions to run automatically in your repo:
1. Go to your repo: **Settings** -> **Secrets and variables** -> **Actions**.
2. Click **New repository secret**.
3. Add the following secrets:
   - `TMDB_API_KEY`: Your TMDB API Key
   - `TMDB_READ_TOKEN`: (Optional) Read Access Token
   - `OMDB_API_KEY`: (Optional) OMDb Key

---

## 📜 License
Distributed under the MIT License. See `LICENSE` for more information.
