#!/usr/bin/env python3
"""
Remove duplicate URL lines from Problems/urls.txt while preserving comments.

The first occurrence wins. Comments and blank lines are kept, with excessive
blank runs collapsed to a single blank line.

Usage:
  python3 scripts/dedupe_urls.py
  python3 scripts/dedupe_urls.py --check
"""

from __future__ import annotations

import argparse
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_URLS = ROOT / "Problems" / "urls.txt"


def dedupe_text(text: str) -> tuple[str, int]:
    seen: set[str] = set()
    out: list[str] = []
    removed = 0
    previous_blank = False

    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("http://") or line.startswith("https://"):
            if line in seen:
                removed += 1
                continue
            seen.add(line)
            out.append(line)
            previous_blank = False
            continue

        if line == "":
            if not previous_blank:
                out.append("")
            previous_blank = True
            continue

        out.append(raw.rstrip())
        previous_blank = False

    while out and out[-1] == "":
        out.pop()

    return "\n".join(out) + "\n", removed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--urls", type=Path, default=DEFAULT_URLS)
    ap.add_argument("--check", action="store_true", help="Fail if duplicates would be removed")
    args = ap.parse_args()

    original = args.urls.read_text()
    deduped, removed = dedupe_text(original)

    if args.check:
        if removed:
            print(f"{args.urls}: {removed} duplicate URL lines found")
            return 1
        print(f"{args.urls}: no duplicate URL lines")
        return 0

    if deduped != original:
        args.urls.write_text(deduped)
    print(f"{args.urls}: removed {removed} duplicate URL lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
