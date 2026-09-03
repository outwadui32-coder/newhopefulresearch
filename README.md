# Redflix Category Stream Scanner

This repository scans one Redflix category per GitHub Actions run. Each run processes at most 20 new movies, series, or episodes with three parallel browser workers, saves the cumulative state, then stops. The next run automatically moves to the next category; after the final category it wraps to the first and skips items already recorded in that category's history.

## Run from GitHub

Open **Actions -> Redflix Category Scanner -> Run workflow**. No source URL, category name, or local command is required. The source URL is built into the scanner.

The workflow also runs once daily. GitHub concurrency prevents two scanner runs from updating the same state simultaneously.

## Output

```text
output/
|-- master/
|   |-- catalog-summary.json
|   |-- all-streams.txt
|   `-- all-streams.m3u
|-- categories/
|   `-- <category>/
|       |-- category.json
|       |-- streams.txt
|       `-- playlist.m3u
|-- state/
|   `-- scan-checkpoint.json
`-- history/
    `-- scan-history.jsonl
```

Each category output begins with its category, total movie count, newly added movie/series/episode counts, stream counts, update time, and educational-use purpose. Items are numbered `Movie-N`, `Series-N`, or `Episode-N`, include clean title and year, and group resolutions beneath each server.

Only direct, no-custom-header media from Alpha, Premium, Orion, Ultra, or PlayFast is eligible. Links below 1080-class are excluded. Embed/player URLs, `Type: hls`, custom headers, and TMDB scores are not published.
