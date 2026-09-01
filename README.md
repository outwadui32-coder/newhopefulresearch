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

## 🔒 GitHub Secrets Configuration (For Actions & Automation)

To allow GitHub Actions to run automatically in your repo with full security:
1. Go to your repo: **Settings** -> **Secrets and variables** -> **Actions** ([Link](https://github.com/outwadui32-coder/newhopefulresearch/settings/secrets/actions)).
2. Click **New repository secret**.
3. Add the following secrets:
   - `TMDB_API_KEY`: Your TMDB API Key (`9a4681358a20ad3919ee10d23d15a80f`)
   - `MAIN_SOURCE_URL`: Main source site base URL (`https://redflix.co`)
   - `TMDB_READ_TOKEN`: (Optional) TMDB Read Access Token
   - `OMDB_API_KEY`: (Optional) OMDb API Key (`bcfcab00`)

---

## ⚙️ How It Works (Automation Engine)

1. **GitHub Actions (`.github/workflows/update_data.yml`)**:
   - Executes every 12 hours via cron schedule or manual trigger.
   - Runs `scripts/scraper.py` using secure GitHub Repository Secrets.
   - Automatically commits and pushes new datasets if changes are detected.

2. **Secrets Protection**:
   - All API keys, source site URLs, and tokens are strictly kept in **GitHub Secrets** (`TMDB_API_KEY`, `MAIN_SOURCE_URL`, etc.).
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
   # Edit .env and enter your TMDB and MAIN_SOURCE_URL values
   ```

4. **Run the scraper**:
   ```bash
   python scripts/scraper.py
   ```

5. **Preview the Web Catalog**:
   Open `index.html` in any web browser.

---

## 📜 License
Distributed under the MIT License. See `LICENSE` for more information.
