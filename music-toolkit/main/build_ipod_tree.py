#!/usr/bin/env python3
"""
build_ipod_tree.py — Build the iPod Video sync tree from the master library.

The master library stays 100% ALAC and is NEVER modified. This builds a
parallel tree that Music can import as a separate, disposable sync library:

    < THRESHOLD   -> hard link to the master ALAC (costs no disk space)
    >= THRESHOLD  -> a 256k AAC derivative named "<stem> ~.m4a"
                     reused from the master if one already exists there,
                     otherwise encoded fresh INTO THE SYNC TREE.

Why a derivative at all: the iPod Video 5.5g has a 64 MB RAM buffer. Tracks
above ~40 MiB force a mid-track disk spin-up and get skipped.

Two rules this script exists to enforce, both learned the hard way:

  1. The track list comes from the MUSIC DATABASE, not from a filesystem
     walk. The master tree carries unreferenced files, dedup twins and old
     derivatives; a filesystem walk sweeps all of that onto the iPod.

  2. Newly encoded derivatives land in the SYNC tree, never in the master.
     Writing them into the master leaves hundreds of unreferenced
     " ~.m4a" files behind.

Encoder settings are the ones recovered from the surviving derivatives:
Apple AudioToolbox AAC (aac_at), 256k constrained VBR. Do NOT substitute
ffmpeg's native `aac` — it produces audible HF chirping on dense material.

Usage:
    # preview (no writes)
    python3 main/build_ipod_tree.py --dry-run

    # refresh the track list from Music, then build
    python3 main/build_ipod_tree.py --refresh

    # build using the cached track list
    python3 main/build_ipod_tree.py

    # also delete sync-tree files that are no longer in the library
    python3 main/build_ipod_tree.py --prune

Music must be running with your main library open for --refresh.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# ── Defaults ──────────────────────────────────────────────────────────────────

MASTER = Path(os.environ.get("MUSIC_ROOT", "~/Music/Music/Media.localized/Music")).expanduser()
SYNC   = Path(os.environ.get("IPOD_SYNC_ROOT", "~/Music/SyncLibraries/iPodVideo/Music")).expanduser()

# 40 MiB exactly. Recovered from the surviving derivatives: the smallest
# ALAC that got one is 40.0 MiB, the largest that did not is just under.
THRESHOLD = 40 * 1024 * 1024

# Recovered encoder fingerprint. The 631 existing derivatives sit at
# 262-288 kbps, which is aac_at's constrained-VBR spread around 256k.
AAC_ARGS = ["-c:a", "aac_at", "-b:a", "256k", "-aac_at_mode", "2"]

CACHE  = Path(__file__).parent.parent / "output" / "ipod_track_list.txt"
REPORT = Path(__file__).parent.parent / "output" / "ipod_tree_report.json"

# AppleScript: pull every file track's location straight from the live DB.
TRACKLIST_AS = r'''
set AppleScript's text item delimiters to linefeed
tell application "Music"
	set L to {}
	repeat with t in (get file tracks of library playlist 1)
		try
			set end of L to POSIX path of (location of t as alias)
		on error
			set end of L to "!!MISSING!!"
		end try
	end repeat
end tell
return L as text
'''


def nfc(p: Path) -> str:
    """macOS hands back NFD; normalize before comparing to anything."""
    return unicodedata.normalize("NFC", str(p))


def refresh_track_list() -> list[str]:
    """Ask the running Music app for every local track's path."""
    print("Querying Music for the track list (takes ~90s for ~9k tracks)...")
    r = subprocess.run(["osascript", "-e", TRACKLIST_AS],
                       capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        sys.exit(f"AppleScript failed: {r.stderr.strip()}\n"
                 "Is Music running with your main library open?")
    lines = r.stdout.splitlines()
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text("\n".join(lines))
    print(f"  cached {len(lines):,} entries -> {CACHE}")
    return lines


def load_track_list(refresh: bool) -> list[str]:
    if refresh or not CACHE.exists():
        return refresh_track_list()
    lines = CACHE.read_text().splitlines()
    age = (time.time() - CACHE.stat().st_mtime) / 3600
    print(f"Using cached track list ({len(lines):,} entries, {age:.1f}h old)")
    print("  pass --refresh to re-query Music")
    return lines


def plan(lines: list[str]) -> tuple[list, dict]:
    """Resolve the raw path list into concrete link/encode/copy actions."""
    stats = {
        "db_entries": len(lines),
        "broken_refs": 0, "outside_master": 0, "absent": 0,
        "duplicate_paths": 0,
    }
    seen, actions = set(), []
    master_prefix = nfc(MASTER) + "/"

    for line in lines:
        if line == "!!MISSING!!":
            stats["broken_refs"] += 1
            continue
        src = Path(line)
        if not nfc(src).startswith(master_prefix):
            stats["outside_master"] += 1
            continue
        if not src.exists():
            stats["absent"] += 1
            continue
        key = nfc(src)
        if key in seen:
            stats["duplicate_paths"] += 1
            continue
        seen.add(key)

        rel = src.relative_to(MASTER)
        size = src.stat().st_size

        if size < THRESHOLD:
            actions.append(("link", src, SYNC / rel))
            continue

        # Oversized: prefer a derivative that already exists in the master.
        existing = src.with_name(src.stem + " ~.m4a")
        dst = (SYNC / rel).with_name(src.stem + " ~.m4a")
        if existing.exists():
            actions.append(("link", existing, dst))
        else:
            actions.append(("encode", src, dst))

    stats["usable_tracks"] = len(seen)
    stats["to_link"]   = sum(1 for a in actions if a[0] == "link")
    stats["to_encode"] = sum(1 for a in actions if a[0] == "encode")
    return actions, stats


def do_link(src: Path, dst: Path) -> str:
    """Hard link src -> dst. Costs no disk space; same APFS volume."""
    if dst.exists():
        if dst.stat().st_ino == src.stat().st_ino:
            return "skip"
        dst.unlink()
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(src, dst)
        return "link"
    except OSError:
        # Cross-volume or link limit — fall back to a real copy.
        shutil.copy2(src, dst)
        return "copy"


def do_encode(src: Path, dst: Path) -> str:
    """Encode an ALAC master track to a 256k AAC derivative in the sync tree."""
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return "skip"
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".tmp.m4a")
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
        "-map", "0:a:0", "-map", "0:v:0?",           # audio + cover art if present
        "-c:v", "copy", "-disposition:v", "attached_pic",
        *AAC_ARGS,
        "-map_metadata", "0", "-movflags", "+faststart", str(tmp),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if r.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"{src.name}: {r.stderr.strip()[:200]}")
    tmp.replace(dst)
    return "encode"


def prune(actions: list, dry: bool) -> int:
    """Delete sync-tree files that the current plan no longer produces."""
    wanted = {nfc(dst) for _, _, dst in actions}
    removed = 0
    for f in SYNC.rglob("*.m4a"):
        if nfc(f) not in wanted:
            print(f"  prune: {f.relative_to(SYNC)}")
            if not dry:
                f.unlink()
            removed += 1
    if not dry:
        # clear out directories left empty by the prune
        for d in sorted(SYNC.rglob("*"), key=lambda p: -len(p.parts)):
            if d.is_dir() and not any(d.iterdir()):
                d.rmdir()
    return removed


def main() -> None:
    global THRESHOLD
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="plan only, write nothing")
    ap.add_argument("--refresh", action="store_true", help="re-query Music for the track list")
    ap.add_argument("--prune", action="store_true", help="delete sync-tree files no longer in the library")
    ap.add_argument("--jobs", type=int, default=8, help="parallel encodes (default 8)")
    ap.add_argument("--threshold-mb", type=float, default=THRESHOLD / 1024 / 1024)
    args = ap.parse_args()
    THRESHOLD = int(args.threshold_mb * 1024 * 1024)

    if not MASTER.is_dir():
        sys.exit(f"Master library not found: {MASTER}")

    actions, stats = plan(load_track_list(args.refresh))

    print(f"\n  DB entries        {stats['db_entries']:>7,}")
    print(f"  broken refs       {stats['broken_refs']:>7,}  (skipped)")
    print(f"  outside master    {stats['outside_master']:>7,}  (skipped)")
    print(f"  absent on disk    {stats['absent']:>7,}  (skipped)")
    print(f"  duplicate paths   {stats['duplicate_paths']:>7,}  (deduped)")
    print(f"  ---------------------------")
    print(f"  usable tracks     {stats['usable_tracks']:>7,}")
    print(f"    hard link       {stats['to_link']:>7,}")
    print(f"    encode to AAC   {stats['to_encode']:>7,}  (>= {args.threshold_mb:g} MiB)")

    if args.dry_run:
        print("\n[dry run] nothing written.")
        for kind, src, dst in [a for a in actions if a[0] == "encode"][:10]:
            print(f"  would encode: {src.relative_to(MASTER)}")
        return

    SYNC.mkdir(parents=True, exist_ok=True)
    counts = {"link": 0, "copy": 0, "skip": 0, "encode": 0}
    errors = []

    links = [a for a in actions if a[0] == "link"]
    print(f"\nLinking {len(links):,} tracks...")
    t0 = time.time()
    for i, (_, src, dst) in enumerate(links, 1):
        try:
            counts[do_link(src, dst)] += 1
        except Exception as e:
            errors.append(f"link {src.name}: {e}")
        if i % 2000 == 0:
            print(f"  {i:,}/{len(links):,}")
    print(f"  done in {time.time() - t0:.1f}s")

    encodes = [a for a in actions if a[0] == "encode"]
    if encodes:
        print(f"\nEncoding {len(encodes):,} derivatives with aac_at ({args.jobs} parallel)...")
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=args.jobs) as ex:
            futs = {ex.submit(do_encode, s, d): s for _, s, d in encodes}
            for n, f in enumerate(as_completed(futs), 1):
                try:
                    counts[f.result()] += 1
                except Exception as e:
                    errors.append(str(e))
                print(f"  {n}/{len(encodes)}  {futs[f].name[:60]}")
        print(f"  done in {time.time() - t0:.1f}s")

    pruned = prune(actions, args.dry_run) if args.prune else 0

    total = sum(f.stat().st_size for f in SYNC.rglob("*.m4a"))
    real = sum(f.stat().st_size for f in SYNC.rglob("*.m4a") if f.stat().st_nlink == 1)
    print(f"\n  linked {counts['link']:,} | copied {counts['copy']:,} | "
          f"encoded {counts['encode']:,} | unchanged {counts['skip']:,} | pruned {pruned:,}")
    print(f"  sync tree payload : {total / 2**30:.1f} GiB  (what lands on the iPod)")
    print(f"  actual disk cost  : {real / 2**30:.1f} GiB  (rest is hard links)")
    if errors:
        print(f"\n  {len(errors)} ERROR(S):")
        for e in errors[:20]:
            print(f"    {e}")

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps({
        "threshold_mb": args.threshold_mb, "stats": stats, "counts": counts,
        "pruned": pruned, "payload_bytes": total, "disk_bytes": real,
        "errors": errors,
    }, indent=2))
    print(f"\n  report -> {REPORT}")


if __name__ == "__main__":
    main()
