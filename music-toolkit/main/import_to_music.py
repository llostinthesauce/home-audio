#!/usr/bin/env python3
"""
import_to_music.py — Import audio files into Apple Music.app via osascript.

Adds files/folders to Music.app's library. Files already in the library
folder are cataloged in-place (no copy). Files outside are copied in.

Usage:
  # Import one or more album folders:
  python3 main/import_to_music.py ~/Music/Artist/Album ~/Music/Artist/Other

  # Dry run:
  python3 main/import_to_music.py ~/Music/Artist/Album --dry-run
"""

import argparse
import subprocess
import time
from pathlib import Path
import os

MUSIC_ROOT = Path(os.environ.get("MUSIC_ROOT", str(Path.home() / "Music")))


def label_for(folder: Path) -> str:
    try:
        return str(folder.relative_to(MUSIC_ROOT))
    except ValueError:
        return str(folder)


def add_to_music(folder: Path) -> bool:
    """Add a folder to Music.app via osascript. Returns True on success."""
    posix = str(folder)
    script = f'tell application "Music" to add POSIX file "{posix}"'
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=30,
        )
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        return False


def main():
    parser = argparse.ArgumentParser(description="Import files into Apple Music.app")
    parser.add_argument("folders", nargs="+", type=Path,
                        help="Album folders to import")
    parser.add_argument("--dry-run", action="store_true", help="Preview only")
    parser.add_argument("--delay", type=float, default=0.5,
                        help="Seconds between imports (default: 0.5)")
    args = parser.parse_args()

    folders = [f.expanduser().resolve() for f in args.folders if f.expanduser().is_dir()]

    if not folders:
        print("No folders to import.")
        return

    file_count = sum(
        len([f for f in d.iterdir() if f.suffix.lower() in {".m4a", ".mp3", ".flac"}])
        for d in folders
    )
    print(f"{'[DRY RUN] ' if args.dry_run else ''}"
          f"Importing {file_count} files from {len(folders)} album folders\n")

    ok = 0
    failed = 0
    for i, folder in enumerate(folders, 1):
        n_files = len([f for f in folder.iterdir()
                       if f.suffix.lower() in {".m4a", ".mp3", ".flac"}])
        label = f"[{i}/{len(folders)}]"

        if args.dry_run:
            print(f"  {label} WOULD ADD  {label_for(folder)}  ({n_files} files)")
            ok += 1
            continue

        print(f"  {label} Adding  {label_for(folder)}  ({n_files} files)...",
              end="", flush=True)
        if add_to_music(folder):
            print(" OK")
            ok += 1
        else:
            print(" FAILED")
            failed += 1

        time.sleep(args.delay)

    print(f"\n{'[DRY RUN] ' if args.dry_run else ''}Done.")
    print(f"  OK: {ok}  |  Failed: {failed}")


if __name__ == "__main__":
    main()
