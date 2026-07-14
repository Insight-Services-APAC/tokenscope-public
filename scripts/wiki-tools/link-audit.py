#!/usr/bin/env python3
"""Wiki link auditor — publish-transform-aware.

Simulates the wiki-publish.yml workflow's flattening of docs/wiki/ into a flat
GitHub Wiki namespace, then checks every internal link in source against that
post-publish target set.

Usage:
  python3 wiki_link_audit.py              # audit + apply HIGH-confidence fixes in source
  python3 wiki_link_audit.py --dry-run    # audit only, no edits
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
WIKI = REPO_ROOT / "docs" / "wiki"
# Reports go OUTSIDE docs/wiki/ so the wiki-publish workflow doesn't ship them to GH wiki.
REPORT_DIR = REPO_ROOT / "scripts" / "wiki-tools" / "reports"
REPORT = REPORT_DIR / "link-audit-latest.md"

# Match markdown links but not images (no leading !) and not reference style.
# Group 1 = label, group 2 = target (may include #anchor and trailing space+title which we strip).
LINK_RE = re.compile(r"(?<!\!)\[([^\]]+)\]\(([^)]+)\)")
HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$", re.MULTILINE)


def slugify_anchor(s):
    """GitHub-style slugify: lowercase, drop non-word non-space non-hyphen,
    replace each whitespace character with a single hyphen (NOT collapsing runs)
    so removed punctuation that leaves consecutive spaces produces consecutive
    hyphens (e.g. 'Foo & Bar' -> 'foo--bar')."""
    s = s.strip().lower()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"\s", "-", s)  # one-for-one
    return s.strip("-")


def is_external(target):
    return bool(re.match(r"^(https?://|mailto:|tel:|ftp://)", target, re.I))


def source_to_flat(rel_path):
    """Map a docs/wiki/-relative path to its post-publish flat slug (no .md)."""
    parts = rel_path.parts
    if len(parts) == 1:
        return parts[0][:-3] if parts[0].endswith(".md") else parts[0]
    prefix = parts[0]
    name = parts[-1]
    if name == "README.md":
        return f"{prefix}-Overview"
    if name.endswith(".md"):
        return f"{prefix}-{name[:-3]}"
    return f"{prefix}-{name}"


def build_namespace():
    """Walk docs/wiki/, return (flat_slugs:set, slug_to_source:dict, all_basenames:dict)."""
    flat_slugs = set()
    slug_to_source = {}
    by_basename = defaultdict(list)  # for fuzzy-match suggestions
    for p in WIKI.rglob("*.md"):
        rel = p.relative_to(WIKI)
        slug = source_to_flat(rel)
        flat_slugs.add(slug)
        slug_to_source[slug] = rel
        # Fuzzy index: basename without .md, lowercase
        base = p.stem
        by_basename[base.lower()].append((rel, slug))
    return flat_slugs, slug_to_source, by_basename


def collect_headings(file_path):
    try:
        text = file_path.read_text(errors="replace")
    except Exception:
        return set()
    return {slugify_anchor(m.group(1)) for m in HEADING_RE.finditer(text)}


def transform_link(target, src_rel, known_prefixes):
    """Simulate the wiki-publish.yml sed pipeline against a single link target.

    src_rel is the docs/wiki/-relative source path.
    Returns (transformed, anchor): the transformed slug + optional anchor.
    """
    t = target.strip()
    # Strip optional title: [x](path "title") or 'title'
    t = t.split(' "', 1)[0].split(" '", 1)[0].strip()
    # Pure anchor — caller handles
    if t.startswith("#"):
        return None, t.lstrip("#")
    # Split target + anchor
    if "#" in t:
        path_part, anchor = t.split("#", 1)
    else:
        path_part, anchor = t, ""

    # Normalize leading "./" — same-dir explicit form.
    if path_part.startswith("./"):
        path_part = path_part[2:]

    # Step 1: same-dir bare reference inside a subdir-sourced file.
    # If src is in a subdir AND path_part has no '/' AND no '../', rewrite to <prefix>-<name>
    src_parts = src_rel.parts
    in_subdir = len(src_parts) > 1
    if in_subdir and "/" not in path_part and ".." not in path_part:
        prefix = src_parts[0]
        if path_part == "README.md":
            path_part = f"{prefix}-Overview.md"
        elif path_part.endswith(".md"):
            path_part = f"{prefix}-{path_part}"
        # else: not a .md target (probably image, code etc.) — skip rewrite

    # Step 2: cross-subdir prefixed forms: (P/...) and (../P/...) -> P-...
    for p in known_prefixes:
        # (P/README.md...) -> (P-Overview.md...)
        path_part = re.sub(rf"^{re.escape(p)}/README\.md$", f"{p}-Overview.md", path_part)
        path_part = re.sub(rf"^\.\./{re.escape(p)}/README\.md$", f"{p}-Overview.md", path_part)
        # (P/Foo.md) -> (P-Foo.md)
        path_part = re.sub(rf"^{re.escape(p)}/", f"{p}-", path_part)
        path_part = re.sub(rf"^\.\./{re.escape(p)}/", f"{p}-", path_part)

    # Step 3: bare ../ collapse to root
    if path_part.startswith("../"):
        path_part = path_part[3:]

    # Step 4: strip .md extension
    if path_part.endswith(".md"):
        path_part = path_part[:-3]

    return path_part, anchor


def fuzzy_suggestions(target_path, by_basename):
    """Suggest possible flat slugs for a broken target by basename match."""
    base = os.path.basename(target_path)
    if base.endswith(".md"):
        base = base[:-3]
    base_lower = base.lower()
    if base_lower in by_basename:
        return [slug for (_, slug) in by_basename[base_lower]]
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    flat_slugs, slug_to_source, by_basename = build_namespace()
    known_prefixes = sorted({p.parts[0] for p in (slug_to_source.values()) if len(p.parts) > 1})

    # Anchor cache by flat slug
    heading_cache = {}

    def get_headings_for_slug(slug):
        if slug in heading_cache:
            return heading_cache[slug]
        rel = slug_to_source.get(slug)
        if rel is None:
            heading_cache[slug] = set()
            return set()
        hs = collect_headings(WIKI / rel)
        heading_cache[slug] = hs
        return hs

    findings = []
    fixes_applied = []
    file_edits = defaultdict(list)
    total_links = 0
    broken_count = 0

    for p in sorted(WIKI.rglob("*.md")):
        rel = p.relative_to(WIKI)
        # Skip the audit report itself
        if p.name.startswith("_link-audit-"):
            continue
        try:
            text = p.read_text(errors="replace")
        except Exception:
            continue
        own_slug = source_to_flat(rel)
        for m in LINK_RE.finditer(text):
            total_links += 1
            label = m.group(1)
            raw_target = m.group(2)
            transformed, anchor = transform_link(raw_target, rel, known_prefixes)

            # External -> skip
            stripped = raw_target.strip().split(' "', 1)[0].split(" '", 1)[0]
            if is_external(stripped):
                continue
            # Anchor-only — verify in own slug headings
            if transformed is None:
                hs = get_headings_for_slug(own_slug)
                if anchor and slugify_anchor(anchor) not in hs:
                    findings.append({
                        "source": str(rel),
                        "label": label,
                        "target": raw_target,
                        "kind": "anchor-missing-self",
                        "transformed": None,
                        "suggestion": None,
                    })
                    broken_count += 1
                continue

            # Skip image-like or non-md targets that don't end in something we resolve
            if transformed == "" or transformed.endswith("/"):
                continue
            # Heuristic: skip targets that look like raw repo paths (e.g., ../../lib/content/README.md)
            # — those don't apply to the wiki namespace at all and can't be auto-fixed.
            if transformed.startswith("../") or "/" in transformed:
                # Still note as broken-on-wiki
                findings.append({
                    "source": str(rel),
                    "label": label,
                    "target": raw_target,
                    "kind": "non-wiki-path",
                    "transformed": transformed,
                    "suggestion": None,
                })
                broken_count += 1
                continue

            # Match against flat slugs
            if transformed in flat_slugs:
                # Verify anchor if any
                if anchor:
                    hs = get_headings_for_slug(transformed)
                    if slugify_anchor(anchor) not in hs:
                        findings.append({
                            "source": str(rel),
                            "label": label,
                            "target": raw_target,
                            "kind": "anchor-missing-cross",
                            "transformed": transformed,
                            "suggestion": None,
                        })
                        broken_count += 1
                continue

            # Broken on wiki
            broken_count += 1
            sugs = fuzzy_suggestions(transformed, by_basename)
            # Filter out the broken one itself
            sugs = [s for s in sugs if s != transformed]
            if len(sugs) == 1:
                # HIGH confidence — propose source rewrite that survives the publish transform
                target_slug = sugs[0]
                # Find the source path for the suggested slug
                target_src = slug_to_source[target_slug]
                # Compute the source-side link we should write so that publish produces target_slug.
                # Strategy: write a path that matches the workflow's expected forms.
                # If src is in subdir P and target is in subdir P (same): write "Sibling.md"
                # If src is in subdir P and target is in subdir Q (different): write "../Q/File.md"
                # If src is in root and target is in subdir Q: write "Q/File.md"
                # If src is in subdir and target is in root: write "../File.md"
                # If src is in root and target is in root: write "File.md"
                src_dir = rel.parts[0] if len(rel.parts) > 1 else None
                tgt_dir = target_src.parts[0] if len(target_src.parts) > 1 else None
                tgt_name = target_src.parts[-1]
                if src_dir is None and tgt_dir is None:
                    new_path = tgt_name
                elif src_dir is None:
                    new_path = f"{tgt_dir}/{tgt_name}"
                elif tgt_dir is None:
                    new_path = f"../{tgt_name}"
                elif src_dir == tgt_dir:
                    new_path = tgt_name
                else:
                    new_path = f"../{tgt_dir}/{tgt_name}"
                new_target = new_path + (f"#{anchor}" if anchor else "")
                findings.append({
                    "source": str(rel),
                    "label": label,
                    "target": raw_target,
                    "kind": "broken-fixable",
                    "transformed": transformed,
                    "suggestion": new_target,
                    "target_slug": target_slug,
                })
                file_edits[p].append((raw_target, new_target, label))
            else:
                findings.append({
                    "source": str(rel),
                    "label": label,
                    "target": raw_target,
                    "kind": "broken-ambiguous" if sugs else "broken-unfixable",
                    "transformed": transformed,
                    "suggestion": sugs if sugs else None,
                })

    # Apply fixes
    if not args.dry_run:
        for p, edits in file_edits.items():
            text = p.read_text(errors="replace")
            new_text = text
            for old_target, new_target, label in edits:
                old_link = f"[{label}]({old_target})"
                new_link = f"[{label}]({new_target})"
                if old_link in new_text:
                    new_text = new_text.replace(old_link, new_link, 1)
                    fixes_applied.append({
                        "source": str(p.relative_to(WIKI)),
                        "old": old_target,
                        "new": new_target,
                    })
            if new_text != text:
                p.write_text(new_text)

    by_kind = defaultdict(int)
    for f in findings:
        by_kind[f["kind"]] += 1

    # Report
    lines = []
    lines.append("---")
    lines.append("title: Wiki Link Audit (publish-transform aware)")
    lines.append(f"created: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}")
    lines.append("---\n")
    lines.append("# Wiki Link Audit Report")
    lines.append("")
    lines.append("This audit simulates `.github/workflows/wiki-publish.yml` and checks every internal link against the post-publish flat namespace (the way the GitHub Wiki actually sees them).")
    lines.append("")
    lines.append(f"_Generated {datetime.now(timezone.utc).isoformat(timespec='seconds')}._")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- Source files scanned: **{len(list(WIKI.rglob('*.md')))}**")
    lines.append(f"- Markdown-style links inspected: **{total_links}**")
    lines.append(f"- Broken on wiki / problem links: **{broken_count}**")
    lines.append(f"- HIGH-confidence fixes applied: **{len(fixes_applied)}**")
    lines.append("")
    lines.append("### Breakdown by kind")
    lines.append("")
    lines.append("| Kind | Count |")
    lines.append("|------|------:|")
    for k in sorted(by_kind):
        lines.append(f"| `{k}` | {by_kind[k]} |")
    lines.append("")

    if fixes_applied:
        lines.append("## Fixes Applied")
        lines.append("")
        lines.append("| Source | Old target | New target |")
        lines.append("|--------|------------|------------|")
        for fa in fixes_applied:
            lines.append(f"| `{fa['source']}` | `{fa['old']}` | `{fa['new']}` |")
        lines.append("")

    lines.append("## Remaining Issues (need human review)")
    lines.append("")
    by_file = defaultdict(list)
    for f in findings:
        if f["kind"] == "broken-fixable":
            continue
        by_file[f["source"]].append(f)
    for src in sorted(by_file):
        lines.append(f"### `{src}`")
        lines.append("")
        for f in by_file[src]:
            sug = ""
            if isinstance(f.get("suggestion"), list) and f["suggestion"]:
                sug = " — candidates: " + ", ".join(f"`{s}`" for s in f["suggestion"])
            xform = f" → would publish as `{f['transformed']}`" if f.get("transformed") else ""
            lines.append(f"- **{f['kind']}** `[{f['label']}]({f['target']})`{xform}{sug}")
        lines.append("")

    if not args.dry_run:
        REPORT.write_text("\n".join(lines))
        REPORT.with_suffix(".json").write_text(json.dumps({
            "summary": {
                "files_scanned": len(list(WIKI.rglob("*.md"))),
                "links_inspected": total_links,
                "broken_count": broken_count,
                "fixes_applied": len(fixes_applied),
                "by_kind": dict(by_kind),
            },
            "fixes": fixes_applied,
            "findings": findings,
        }, indent=2))

    print(f"files={len(list(WIKI.rglob('*.md')))} links={total_links} broken={broken_count} fixes_applied={len(fixes_applied)}")
    for k in sorted(by_kind):
        print(f"  {k}: {by_kind[k]}")


if __name__ == "__main__":
    main()
