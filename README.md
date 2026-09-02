# GitHub Category Direct Stream Scanner

This repository is a GitHub Actions-only scanner. The workflow discovers one selected category from the top on each run, filters permanent category history, processes at most 20 Movie/Series/Episode items in source order, verifies direct 1080-class-or-higher media without custom headers, validates cumulative outputs, then commits the completed batch.

## Runtime

Use **Actions → Category Direct Stream Scanner → Run workflow**, or let the six-hour schedule run it. There is no local user-facing `npm start` operation.

Required GitHub repository secrets:

- `MAIN_SOURCE_URL`
- `TMDB_API_KEY`
- `TMDB_READ_TOKEN`
- `OMDB_API_KEY`

Credentials are never stored in source files or generated outputs.

## Persistent output

```text
output/
├── state/
│   └── scanner-state.json
├── master/
│   ├── catalog.json
│   ├── streams.txt
│   └── playlist.m3u
├── categories/
│   └── <stable-category>/
│       ├── category.json
│       ├── streams.txt
│       └── playlist.m3u
└── history/
    └── YYYY-MM-DD.jsonl
```

`scanner-state.json` is the only authoritative state. It stores stable rotation, permanent per-category history, global canonical history, stream freshness flags, and an unfinished `activeBatch` for crash resume.

## Publication contract

- Approved servers only: Alpha, Premium, Orion, Ultra, PlayFast.
- Direct HLS or DASH only; embeds, iframe/player pages, media fragments and header-dependent URLs are excluded.
- Resolution must be 1080-class or higher, including cinematic widths such as 1920x800.
- HLS validation checks the master, selected child, media segment, key/map when present, and alternate audio playlist/segment.
- DASH validation checks the MPD, a 1080-class representation, initialization segment and media segment.
- Master stream URLs are deduplicated by exact URL while canonical IDs and category memberships are retained.
- Posters appear in JSON, TXT and M3U `tvg-logo`.

## Safety

Every item is atomically checkpointed by the coordinator. The category pointer advances only after the active batch is complete. Validation checks JSON parsing, canonical/URL duplicates, resolution, server allow-list, no-header publication, pointer/state, batch maximum, cumulative output floors, poster presence, and JSON/TXT/M3U count agreement before the workflow pushes.

Automated tests cover rotation and wrap, fresh top/middle/bottom insertions, independent category history, global reuse, mixed Movie/Series/Episode order, crash/resume, 1080 filtering, no-header publication, HLS/DASH parser paths, cumulative output, URL dedupe, count cross-checking and one-time legacy migration.
