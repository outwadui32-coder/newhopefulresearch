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

## Source-neutral output library (`lib/`)

`lib/` is independent of any scraper. It turns a list of normalized content
items into the published `data/` tree and is driven entirely by local fixtures
and authorized sample manifests.

| Module | Responsibility |
| --- | --- |
| `lib/quality.js` | Classifies raw encoder dimensions into the only publishable tiers: `1080p` (1920x1080), `2K` (2560x1440), `4K` (3840x2160), `8K` (7680x4320). Anything below 1080p is rejected. |
| `lib/servers.js` | Canonical server whitelist: Alpha, Premium, Orion, Ultra, PlayFast. Source labels map onto these; unknown providers are dropped. |
| `lib/streams.js` | Normalizes captures and deduplicates by content + server + quality, keeping one URL per tier. |
| `lib/manifest.js` | Generic HLS master and DASH MPD parsing. Keeps every allowed tier and uses the exact child variant URL. |
| `lib/model.js` | The one normalized model. Separates movies from series and groups Series -> Season -> Episode. |
| `lib/queue.js` | Batch scheduler. A series costs one title slot and contributes all of its aired episodes. |
| `lib/paths.js`, `lib/output.js` | The `data/<category>/{movies,series}/` layout and the six writers. |
| `lib/verify.js` | Checks a written tree against every published-output rule. |
| `lib/index.js` | Single entry point re-exporting the whole chain. |

### The chain

```js
const lib = require('./lib');

// 1. a manifest becomes stream entries for one server
const streams = lib.streamsFromManifest('Alpha', manifestText, manifestUrl, { verified: true });

// 2. items become the one normalized model
const model = lib.buildCategoryModel({ category, lastUpdated, purpose, items });

// 3. the model becomes the six files
lib.writeCategoryOutputs(model, { baseDirectory: 'data' });

// 4. the written tree is checked
const report = lib.verifyDataTree('data');
```

Batch scheduling is independent: `lib.buildBatch({ titles, maxTitles })` decides
which titles a run processes, a series counting as one title slot and
contributing all of its aired episodes.

### Output layout

```text
data/
`-- <category>/
    |-- movies/
    |   |-- movies.json
    |   |-- movies.m3u
    |   `-- movies.txt
    `-- series/
        |-- series.json
        |-- series.m3u
        `-- series.txt
```

A `movies/` or `series/` folder is created only when that content type has
records, so a movie-only category never gets an empty `series/` folder.

All six files are projections of the same model, so JSON, TXT and M3U cannot
disagree. Published resolutions are always one of the four standard frames;
raw dimensions such as `1920x800` or `1620x1080` classify into a tier and are
never printed.

### Commands

```bash
npm run test:lib                 # all eleven library suites
npm run test:e2e                 # end-to-end checklist only
npm run verify:data              # verify ./data
node bin/verify-data.js <dir>    # verify another tree
```
