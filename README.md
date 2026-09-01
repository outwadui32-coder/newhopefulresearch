# 🎬 DirectMedia DB (OpenPosterDB & Direct Stream Engine)

[![Deploy GitHub Pages Web Catalog](https://github.com/outwadui32-coder/newhopefulresearch/actions/workflows/deploy_pages.yml/badge.svg)](https://github.com/outwadui32-coder/newhopefulresearch/actions/workflows/deploy_pages.yml)
[![Auto Sync & Health Repair Engine](https://github.com/outwadui32-coder/newhopefulresearch/actions/workflows/update_data.yml/badge.svg)](https://github.com/outwadui32-coder/newhopefulresearch/actions/workflows/update_data.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Stream Engine](https://img.shields.io/badge/Stream%20Engine-100%25%20Direct%20Media%20(No%20Embeds)-brightgreen)](data/stats.json)

An open-source, automated high-resolution movie & TV dataset, rating poster database, and **100% Direct Media Stream Source (Zero Iframes, Zero Popup Ads)** powered by GitHub Actions (6-hour cycle) and **jsDelivr Global CDN**.

---

## 🌐 Live Web Catalog (100% Native HTML5 Player)

👉 **Live Catalog:** [https://outwadui32-coder.github.io/newhopefulresearch/](https://outwadui32-coder.github.io/newhopefulresearch/)

- **Zero Iframes / Zero Embeds**: Built using pure HTML5 `<video>` element + `Hls.js`.
- **Zero Third-Party Ads**: No popup tabs, no redirects, no clickjacking traps.
- **Multi-Resolution Playback**: 4K Ultra HD, 1080p Full HD, and 720p HD direct streams.

---

## 📺 Multi-Format Live CDN Endpoints (Instant API Access)

| Dataset / Format | Free jsDelivr CDN Endpoint (Cached & Fast) | Raw GitHub Link |
| :--- | :--- | :--- |
| **📺 Full M3U Playlist (IPTV/VLC)** | [`/data/playlist.m3u`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/playlist.m3u) | [`Raw M3U`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/playlist.m3u) |
| **⚡ Latest 50 M3U Playlist** | [`/data/latest.m3u`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/latest.m3u) | [`Raw M3U`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/latest.m3u) |
| **📄 Plaintext Dataset (TXT)** | [`/data/movies.txt`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/movies.txt) | [`Raw TXT`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/movies.txt) |
| **🔗 Direct Links Only (TXT)** | [`/data/links.txt`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/links.txt) | [`Raw TXT`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/links.txt) |
| **🎬 All Movies (JSON Master)** | [`/data/movies.json`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/movies.json) | [`Raw JSON`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/movies.json) |
| **⭐ Latest Movies (Top 50)** | [`/data/latest.json`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/latest.json) | [`Raw JSON`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/latest.json) |
| **🔥 Trending This Week** | [`/data/trending.json`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/trending.json) | [`Raw JSON`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/trending.json) |
| **🏆 Top Rated Movies** | [`/data/top_rated.json`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/top_rated.json) | [`Raw JSON`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/top_rated.json) |
| **📺 TV Shows & Series** | [`/data/tv_shows.json`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/tv_shows.json) | [`Raw JSON`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/tv_shows.json) |
| **📊 Database Stats** | [`/data/stats.json`](https://cdn.jsdelivr.net/gh/outwadui32-coder/newhopefulresearch@main/data/stats.json) | [`Raw JSON`](https://raw.githubusercontent.com/outwadui32-coder/newhopefulresearch/main/data/stats.json) |

---

## 📦 Direct Media JSON Schema Structure

```json
{
  "id": 969681,
  "imdb_id": "tt22084616",
  "type": "movie",
  "title": "Spider-Man: Brand New Day",
  "release_year": 2026,
  "rating": 7.9,
  "runtime_formatted": "2h 25m",
  "genres": ["Sci-Fi", "Action", "Adventure"],
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
  "stream_type": "direct_hls_media",
  "direct_stream_url": "https://multiembed.mov/directstream.php?video_id=969681&tmdb=1",
  "stream_sources": {
    "primary_hls_stream": "https://multiembed.mov/directstream.php?video_id=969681&tmdb=1",
    "qualities": {
      "4K Ultra HD": "https://multiembed.mov/directstream.php?video_id=969681&tmdb=1&res=4k",
      "1080p Full HD": "https://multiembed.mov/directstream.php?video_id=969681&tmdb=1&res=1080",
      "720p HD": "https://multiembed.mov/directstream.php?video_id=969681&tmdb=1&res=720"
    }
  },
  "health_status": "online",
  "updated_at": "2026-09-01T10:34:18Z"
}
```

---

## 🔒 GitHub Secrets Configuration

- `TMDB_API_KEY`: `9a4681358a20ad3919ee10d23d15a80f`
- `MAIN_SOURCE_URL`: `https://redflix.co`
- `TMDB_READ_TOKEN`: *(Your TMDB Read Access Token)*
- `OMDB_API_KEY`: `bcfcab00`

---

## 📜 License
Distributed under the MIT License. See `LICENSE` for more information.
