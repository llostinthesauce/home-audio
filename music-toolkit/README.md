# Apple Music Toolkit

Python and AppleScript tools for keeping a large lossless (ALAC) Apple Music library clean. They find tracks whose audio doesn't match their tags, check that albums are complete, repair tags and artwork, reconcile the local library with iCloud, and build a sync library for a classic iPod.

Each tool is a standalone script. Anything that changes files or the Music library has a `--dry-run` mode, so you can see exactly what it would do first. Common tasks are also in an interactive menu (`./amt.sh`).

## Requirements

- macOS with Music.app (several tools drive it through AppleScript)
- Python 3.10+
- `ffmpeg` / `ffprobe`, and `fpcalc` from Chromaprint for fingerprinting: `brew install ffmpeg chromaprint`
- Optional: a free [AcoustID API key](https://acoustid.org/new-application) for fingerprint lookups, and [Spotify app credentials](https://developer.spotify.com/dashboard) for `spotify.py`

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env                           # set your library and export paths
cp sync_config.example.json sync_config.json   # only for iPod sync
./amt.sh
```

Several tools read an XML export of your library (Music → File → Library → Export Library).

## Configuration

Set in `.env` (`amt.sh` loads it), or export the variables in your shell.

| Variable | Used for | Default |
|---|---|---|
| `MUSIC_ROOT` | Library root, laid out as `Artist/Album/Track` | `~/Music` |
| `XML_DEFAULT` | Music library XML export | `~/Desktop/Library.xml` |
| `CLOUD_XML` | XML export of the iCloud library, for the cloud-vs-local tools | `~/Desktop/CloudLibrary.xml` |
| `IPOD_MOUNT` | iPod mount point | `/Volumes/iPod` |
| `IPOD_SYNC_ROOT` | Separate sync library built by `build_ipod_tree.py` | `~/Music/SyncLibraries/iPodVideo/Music` |
| `ACOUSTID_API_KEY` | Fingerprint lookups | unset |
| `OUTPUT_DIR` | Reports and caches | `./output/` |

## Tools

**Finding problems**

| Script | What it does |
|---|---|
| `validate.py`, `fix.py` | Full library check (duplicates, missing art, bad tags) that writes a report; `fix.py` applies it |
| `track_swap_detector.py` | Fingerprints tracks with Chromaprint and AcoustID to catch files whose audio doesn't match their tags |
| `duration_check.py` | Faster wrong-audio check: compares each track's length against MusicBrainz |
| `check_wholeness.py` | Compares each album with its MusicBrainz tracklist to find missing or extra tracks |
| `acoustic_audit.py` | Builds the fingerprint cache for the library |
| `scan_library.py`, `audit.py`, `dedupe.py`, `loudness_scan.py` | Library-wide scans for size and bitrate, corruption, duplicates, and loudness |

**Tags, artwork, organization**

| Script | What it does |
|---|---|
| `align.py`, `polish.py` | Make file names, track numbers, and album artists match the library XML |
| `tag.py`, `force_album_artist.py`, `fix_compilations.py`, `enrich_metadata.py` | Tag repair: from folder structure, blank album artists, compilations, and genre/year from XML |
| `strip_prefixes.py`, `strip_meta_prefixes.py` | Remove leaked track numbers ("01 Song") from file names and title tags |
| `art.py`, `art_fix.py`, `compress_art.py` | Fetch missing covers (Cover Art Archive, iTunes), normalize them, embed them, and shrink oversized art |
| `find_album_merges.py`, `auto_merge_albums.py` | Find and merge albums split into several variants |
| `ingest.py`, `import_to_music.py`, `purge_junk.py` | Move new albums into the library (instant, no extra disk space), add them to Music, and clear review folders |
| `refresh_library.py`, `refresh_album.py` | Make Music re-read files whose tags changed on disk |

**Local vs. cloud library**

| Script | What it does |
|---|---|
| `cloud_diff.py`, `sync_quick_check.py` | Diff the local library against the iCloud XML, with fuzzy title matching |
| `reconcile_libraries.py`, `deep_reconcile.py` | Side-by-side comparison of two XML exports |
| `acoustic_cloud_sync.py`, `folder_cloud_sync.py`, `apply_sync_fixes.py` | Move local files to match the cloud library, using fingerprints when tags disagree |

**Playlists, history, lyrics**

| Script | What it does |
|---|---|
| `build_playlists.py`, `playlists.py`, `export.py` | Rebuild playlists from an XML export, inside Music or as `.m3u8`, and export them |
| `history.py` | Restore play counts and ratings from an older export |
| `spotify.py` | Copy playlists or liked songs to Spotify |
| `lyrics.py` | Fetch lyrics from LRCLIB and embed them in the tags |

**iPod Classic / Video**

| Script | What it does |
|---|---|
| `build_ipod_tree.py` | Builds a separate sync library from the main one. Tracks under 40 MiB are hard links (no extra space); larger ones get a 256k AAC copy, since the iPod Video's 64 MB buffer skips them otherwise |
| `build_sync_library.py`, `compress_large_tracks.py`, `transcode.py` | Splitting and transcoding for older iPods, configured in `sync_config.json` |
| `rebuild_itunesdb.py` | Writes the iPod's binary `iTunesDB` directly from the files on the device |

## License

MIT. See [LICENSE](LICENSE).
