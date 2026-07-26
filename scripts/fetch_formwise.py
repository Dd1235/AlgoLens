#!/usr/bin/env python3
"""
Turn the curated formwise.xlsx sheet into URL blocks the annotator can ingest,
plus a record of what was skipped.

The sheet is 17 topic tabs (Binary Search … Graph Level 2) with columns
Problem Name / Problem Link / Difficulty / Form / Status / Comments. Two things
make it worth more than a plain URL list:
  * the tab name is a topic ("DP Optimizations")
  * the Form column is a human technique label ("Binary Search On Answer")
Both are carried into Problems/urls.txt as topic headers so annotate picks them
up as source_topic; the curated labels are merged after annotation by
scripts/apply_formwise_labels.py.

Only judges the annotator can fetch statements for are ingested; the rest land
in data/skipped_problems.json with a reason rather than disappearing silently.

  python3 scripts/fetch_formwise.py
"""

from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
XLSX = ROOT / "data" / "formwise.xlsx"
OUT_URLS = ROOT / "Problems" / "urls_formwise.txt"
OUT_LABELS = ROOT / "data" / "cache" / "formwise_labels.json"
OUT_SKIPPED = ROOT / "data" / "skipped_problems.json"

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
SUPPORTED = ("leetcode.com", "codeforces.com", "atcoder.jp", "cses.fi")
# Curriculum bookkeeping, not techniques — the LLM labels cover these problems.
NON_TECHNIQUE_FORMS = {"mixed", "level-1", "level-2", "level-3", "fundamental-ideas",
                       "intermediate-ideas", "advanced-ideas", "kth-form", "operation-decoding",
                       "state-rotation", "cyclic-property", "msb-to-lsb-or-lsb-to-msb"}


def is_non_technique(form: str) -> bool:
    f = form.strip().lower().replace(" ", "-")
    return not f or f in NON_TECHNIQUE_FORMS or re.fullmatch(r"form-\d+", f) is not None


def slugify(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")


def problem_id(url: str) -> str | None:
    if "leetcode.com" in url:
        m = re.search(r"/problems/([^/?#]+)", url)
        return f"leetcode-{m.group(1)}" if m else None
    if "cses.fi" in url:
        m = re.search(r"/task/(\d+)", url)
        return f"cses-{m.group(1)}" if m else None
    if "atcoder.jp" in url:
        m = re.search(r"/tasks/([A-Za-z0-9_]+)", url)
        return f"atcoder-{m.group(1).lower().replace(chr(95), chr(45))}" if m else None
    if "codeforces.com" in url:
        m = re.search(r"/(?:problemset/problem|contest/\d+/problem)/?(\d+)?/?([A-Za-z]\d?)", url)
        m2 = re.search(r"/problemset/problem/(\d+)/([A-Za-z]\d?)", url) or \
             re.search(r"/contest/(\d+)/problem/([A-Za-z]\d?)", url)
        if m2:
            return f"codeforces-{m2.group(1)}-{m2.group(2).lower()}"
    return None


def read_sheet_rows(z: zipfile.ZipFile, path: str, shared: list[str]):
    sheet = ET.fromstring(z.read(path))
    relpath = path.rsplit("/", 1)[0] + "/_rels/" + path.rsplit("/", 1)[1] + ".rels"
    hrels = {}
    if relpath in z.namelist():
        hrels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read(relpath))}
    cellurl = {}
    for hl in sheet.iter(NS + "hyperlink"):
        rid = hl.get(RID)
        if rid in hrels:
            cellurl[hl.get("ref")] = hrels[rid]
    for row in sheet.iter(NS + "row"):
        cells = {}
        for c in row.iter(NS + "c"):
            ref = c.get("r") or ""
            col = "".join(ch for ch in ref if ch.isalpha())
            v = c.find(NS + "v")
            val = shared[int(v.text)] if (c.get("t") == "s" and v is not None) else (v.text if v is not None else "")
            cells[col] = (val or "", ref)
        name = cells.get("A", ("", ""))[0]
        if not name or name == "Problem Name":
            continue
        yield {
            "name": name,
            "url": cellurl.get(cells.get("B", ("", ""))[1], ""),
            "difficulty": cells.get("C", ("", ""))[0],
            "form": cells.get("D", ("", ""))[0],
        }


def main() -> int:
    z = zipfile.ZipFile(XLSX)
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    shared = ["".join(t.text or "" for t in si.iter(NS + "t"))
              for si in ET.fromstring(z.read("xl/sharedStrings.xml"))]

    blocks: dict[str, list[str]] = {}
    labels: dict[str, dict] = {}
    skipped: list[dict] = []
    seen: set[str] = set()

    for sheet_el in wb.iter(NS + "sheet"):
        topic = sheet_el.get("name")
        path = "xl/" + rels[sheet_el.get(RID)].lstrip("/")
        for row in read_sheet_rows(z, path, shared):
            url = row["url"]
            if not url or not any(d in url for d in SUPPORTED):
                skipped.append({"name": row["name"], "url": url, "topic": topic,
                                "reason": "unsupported judge (no fetchable statement)"})
                continue
            pid = problem_id(url)
            if not pid:
                skipped.append({"name": row["name"], "url": url, "topic": topic,
                                "reason": "could not parse a problem id from the link"})
                continue
            form = (row["form"] or "").strip()
            curated = [] if is_non_technique(form) else [slugify(form)]
            if pid in seen:
                # 36 problems are filed under two tabs. The URL only needs
                # annotating once, but both tabs' labels are real information —
                # a problem in "DP Level 1" and "DP Optimizations" earns both.
                entry = labels[pid]
                if topic not in entry["topics"]:
                    entry["topics"].append(topic)
                for slug in curated:
                    if slug not in entry["curated"]:
                        entry["curated"].append(slug)
                continue
            seen.add(pid)
            blocks.setdefault(topic, []).append(url)
            labels[pid] = {"topic": topic, "topics": [topic], "form": form,
                           "curated": curated, "sheet_difficulty": row["difficulty"]}

    lines = ["# Generated from data/formwise.xlsx by scripts/fetch_formwise.py",
             "# Topic headers become source_topic; curated Form labels are in",
             "# data/cache/formwise_labels.json and merged after annotation.", ""]
    for topic, urls in blocks.items():
        lines.append(f"# Formwise / {topic}")
        lines.extend(urls)
        lines.append("")
    OUT_URLS.write_text("\n".join(lines))
    OUT_LABELS.parent.mkdir(parents=True, exist_ok=True)
    OUT_LABELS.write_text(json.dumps(labels, indent=1, ensure_ascii=False) + "\n")
    OUT_SKIPPED.write_text(json.dumps(
        {"source": "data/formwise.xlsx", "count": len(skipped), "problems": skipped},
        indent=1, ensure_ascii=False) + "\n")

    curated_n = sum(1 for v in labels.values() if v["curated"])
    print(f"staged {len(labels)} problems across {len(blocks)} topics "
          f"({curated_n} with a curated Form label); skipped {len(skipped)}")
    print(f"  {OUT_URLS.relative_to(ROOT)} · {OUT_LABELS.relative_to(ROOT)} · {OUT_SKIPPED.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
