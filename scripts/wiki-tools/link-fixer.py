#!/usr/bin/env python3
"""Apply the two remaining classes of fix:
1. Regenerate broken TOC anchors in delivery-history/Delivery-Overview.md
2. Convert non-wiki-path links (../../../lib/...) to absolute github.com blob URLs.
"""
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
WIKI = REPO_ROOT / "docs" / "wiki"
REPORTS = REPO_ROOT / "scripts" / "wiki-tools" / "reports"
GH_BLOB_BASE = "https://github.com/Insight-Services-APAC/a sibling project/blob/main"

LINK_RE = re.compile(r"(?<!\!)\[([^\]]+)\]\(([^)]+)\)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


def slugify(s):
    """GitHub-style slugify: one-for-one whitespace -> hyphen (no collapsing)."""
    s = s.strip().lower()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"\s", "-", s)
    return s.strip("-")


def fix_toc_anchors(path):
    text = path.read_text()
    headings = HEADING_RE.findall(text)
    valid = {slugify(h[1]) for h in headings}
    # Compute fuzzy mapping: condensed-no-extra-hyphens form -> real slug
    condensed = {}
    for h in headings:
        s = slugify(h[1])
        # Remove all standalone single hyphens between digits and "feb"/"mar" etc.
        # Or more usefully: drop hyphens entirely as a normalised key
        c = s.replace("-", "")
        condensed[c] = s
    edits = 0
    def repl(m):
        nonlocal edits
        label, target = m.group(1), m.group(2)
        if not target.startswith("#"):
            return m.group(0)
        anchor = target.lstrip("#")
        if anchor in valid:
            return m.group(0)
        # Try condensed match (drop all hyphens, find equivalent)
        c = anchor.replace("-", "")
        if c in condensed:
            edits += 1
            return f"[{label}](#{condensed[c]})"
        return m.group(0)
    new_text = LINK_RE.sub(repl, text)
    if new_text != text:
        path.write_text(new_text)
    return edits


def fix_non_wiki_paths(findings):
    edits = 0
    by_file = {}
    for f in findings:
        if f["kind"] != "non-wiki-path":
            continue
        # Only handle ../../../<path> or ../../<path> style
        target = f["target"]
        # Strip leading ../ sequences and resolve against repo root
        m = re.match(r"^((?:\.\./)+)(.+)$", target)
        if not m:
            continue
        # Hop count = number of ../ segments
        hops = len(m.group(1)) // 3
        rest = m.group(2)
        # Source file is at docs/wiki/<source>. Need to resolve target absolute repo path.
        src_path = WIKI / f["source"]
        # Resolve up `hops` levels from src_path.parent
        cur = src_path.parent
        for _ in range(hops):
            cur = cur.parent
        # Now rest is relative to repo root (or wherever)
        try:
            absolute = (cur / rest).resolve()
            repo_rel = absolute.relative_to(REPO_ROOT)
        except ValueError:
            continue
        # Build github.com URL — keep any anchor
        anchor = ""
        rest_path = str(repo_rel)
        if "#" in rest_path:
            rest_path, anchor = rest_path.split("#", 1)
            anchor = "#" + anchor
        new_target = f"{GH_BLOB_BASE}/{rest_path}{anchor}"
        by_file.setdefault(f["source"], []).append((target, new_target, f["label"]))
    for src, fixes in by_file.items():
        path = WIKI / src
        text = path.read_text()
        new_text = text
        for old_target, new_target, label in fixes:
            old_link = f"[{label}]({old_target})"
            new_link = f"[{label}]({new_target})"
            if old_link in new_text:
                new_text = new_text.replace(old_link, new_link, 1)
                edits += 1
        if new_text != text:
            path.write_text(new_text)
    return edits


def main():
    detail = json.loads((REPORTS / "link-audit-latest.json").read_text())
    # 1. TOC anchors — apply across all files that have anchor-missing-self findings
    files_with_anchor_issues = {
        WIKI / f["source"] for f in detail["findings"] if f["kind"] == "anchor-missing-self"
    }
    total_anchor_fixes = 0
    for p in sorted(files_with_anchor_issues):
        n = fix_toc_anchors(p)
        if n:
            print(f"  TOC anchor fixes in {p.relative_to(WIKI)}: {n}")
            total_anchor_fixes += n
    print(f"Total TOC anchor fixes: {total_anchor_fixes}")

    # 2. Non-wiki paths -> github.com blob URLs
    n_external = fix_non_wiki_paths(detail["findings"])
    print(f"Non-wiki-path -> github.com URL conversions: {n_external}")


if __name__ == "__main__":
    main()
