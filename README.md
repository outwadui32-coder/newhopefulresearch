# 🎬 OpenPosterDB & Redflix Automated Data Source

[![Auto Sync & Health Repair Engine](https://github.com/outwadui32-coder/newhopefulresearch/actions/workflows/update_data.yml/badge.svg)](https://github.com/outwadui32-coder/newhopefulresearch/actions/workflows/update_data.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Database Status](https://img.shields.io/badge/Database-Active%20%26%20Synced-brightgreen)](data/stats.json)
[![M3U IPTV Supported](https://img.shields.io/badge/IPTV-M3U%20%26%20TXT%20Ready-blue)](data/playlist.m3u)

An open-source, automated high-resolution movie & TV dataset, rating poster database, and multi-server streaming source powered by GitHub Actions (6-hour cycle) and **jsDelivr Global CDN**.

---

## 📺 Multi-Format Live CDN Endpoints (Instant API Access)

No backend or database hosting required! Consume any of these high-speed CDN endpoints directly in your web or mobile applications, IPTV players (VLC, Kodi, TiviMate), or scrapers:

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

## 🩺 Dedicated Chunked Dead-Link Repair System

To prevent exceeding GitHub Actions time limits, link health verification operates in **chunked batches (40 movies per run)** with cursor tracking (`data/scanner_state.json`):

1. **Continuous Round-Robin Rotation**:
   - Run 1: Checks Movies 1 to 40
   - Run 2 (6h later): Checks Movies 41 to 80
   - Run 3 (12h later): Checks Movies 81 to 120... and loops back automatically.
2. **Multi-Server Auto-Failover**:
   - Tests all candidate stream embed servers (`vidbolt`, `vidlink`, `videasy`, `autoembed`, `vidfast`, `vidcore`, `vidsrc`).
   - If a primary server fails or dies, it dynamically repairs and replaces it with the fastest working alternative.

---

## ⚡ Smart Incremental Deduplication (6-Hour Cycle)

- **No Duplicates**: Previous movies are remembered by TMDB ID; newly discovered movies are merged at the top without overwriting historical database records.
- **API Cache Preservation**: Cached details (cast, runtime, trailer) are preserved to avoid unnecessary API requests.

---

## 🔒 GitHub Secrets Configuration

To enable automated 6-hour sync and link repair:
1. Go to: **Settings** -> **Secrets and variables** -> **Actions** ([Direct Link](https://github.com/outwadui32-coder/newhopefulresearch/settings/secrets/actions)).
2. Add the following secrets:
   - `TMDB_API_KEY`: `9a4681358a20ad3919ee10d23d15a80f`
   - `MAIN_SOURCE_URL`: `https://redflix.co`
   - `TMDB_READ_TOKEN`: *(Your TMDB Read Access Token)*
   - `OMDB_API_KEY`: `bcfcab00`

---

## 📜 License
Distributed under the MIT License. See `LICENSE` for more information.
