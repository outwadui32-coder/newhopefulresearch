# Redflix Category Stream Scanner

This repository scans one Redflix category per GitHub Actions run. Each run refreshes only the selected category, puts newly discovered content ahead of its saved backlog, and processes at most 20 movies, series, or episodes. Two title workers run concurrently and each title attempts Alpha, Premium, Orion, Ultra, and PlayFast with up to five parallel server workers. Existing verified output is preserved while expired links are scheduled for refresh.

## Run from GitHub

Open **Actions -> Redflix Category Scanner -> Run workflow**. Automatic mode uses the saved rotation. Manual mode accepts an exact category name, category ID, folder, or 1-based category index without moving the automatic pointer. **Refresh category list** performs the slower complete site discovery only when explicitly requested; normal runs refresh only the selected category.

The workflow also runs once daily. GitHub concurrency prevents two scanner runs from updating the same state simultaneously. Real browser diagnostics are uploaded as a short-lived artifact if a run fails before it can publish state.

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

Each category output begins with its category, total movie count, newly added movie/series/episode counts, stream counts, and update time. Items are numbered `Movie-N`, `Series-N`, or `Episode-N`, include clean title, year, and poster, and group resolutions beneath each server. Posters come from the source page first, TMDB second, and OMDb as a fallback; configure `TMDB_API_KEY`, `TMDB_READ_TOKEN`, and `OMDB_API_KEY` as repository variables or secrets.

Only direct, no-custom-header media from Alpha, Premium, Orion, Ultra, or PlayFast is eligible. Links below 1080-class are excluded. Embed/player URLs, `Type: hls`, custom headers, and TMDB scores are not published.

The Actions log lists the selected batch, every item, poster status, and a per-server `selected / captured / verified / resolution / error` result. Redflix currently labels the Ultra source slot as `Vid`; scanner diagnostics show this as `Ultra<-Vid`, while verified output retains the requested `Ultra` server name.
