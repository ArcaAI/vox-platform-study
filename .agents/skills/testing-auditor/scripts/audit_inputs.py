#!/usr/bin/env python3
"""Evidence extractor for the Testing_Auditor skill.

Finds a component's test-result folder, validates the required artifacts, and
emits a single JSON evidence bundle. It never writes to the input folder.

Stdlib only. Python 3.8+.

Usage:
    python3 audit_inputs.py --component tts
    python3 audit_inputs.py --component tts --root /path/to/Test_Results
    python3 audit_inputs.py --component tts --json-out /tmp/tts-evidence.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

REQUIRED = (
    "coverage_report.txt",
    "test_results.log",
    "TEST_SUMMARY.md",
    "coverage_html/index.html",
)
OPTIONAL = ("coverage.xml",)
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache"}


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def _artifact_mtime(path: Path) -> float:
    for name in ("test_results.log", "TEST_SUMMARY.md", "coverage_report.txt"):
        target = path / name
        if target.exists():
            return target.stat().st_mtime
    return 0.0


def find_component_dirs(root: Path, component: str) -> list[Path]:
    """Directories whose basename matches `component` and look like a result bundle.

    Newest bundle first: dated result folders are expected to accumulate.
    """
    wanted = component.lower()
    matches: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".git")]
        name = os.path.basename(dirpath)
        if name.lower() != wanted:
            continue
        has_any = any(
            os.path.exists(os.path.join(dirpath, rel)) for rel in REQUIRED + OPTIONAL
        )
        if has_any:
            matches.append(Path(dirpath))
    return sorted(matches, key=lambda p: (_artifact_mtime(p), -len(p.parts)), reverse=True)


def plural(count: int) -> str:
    return "" if count == 1 else "s"


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------


def parse_coverage_report(path: Path) -> dict:
    """Parse pytest-cov's `Name Stmts Miss Cover` table."""
    text = path.read_text(encoding="utf-8", errors="replace")
    files: list[dict] = []
    total: dict | None = None
    row = re.compile(r"^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)%\s*$")
    for line in text.splitlines():
        m = row.match(line.strip())
        if not m:
            continue
        name, stmts, miss, cover = m.groups()
        if name.lower() == "total":
            total = {
                "path": "TOTAL",
                "statements": int(stmts),
                "missing": int(miss),
                "cover_pct": float(cover),
            }
            continue
        files.append(
            {
                "path": name,
                "statements": int(stmts),
                "missing": int(miss),
                "cover_pct": float(cover),
            }
        )
    files.sort(key=lambda f: (f["cover_pct"], -f["missing"], f["path"]))
    return {"files": files, "total": total, "file_count": len(files)}


def parse_missing_ranges(spec: str) -> list[dict]:
    """Turn `12-15, 99, 120-121` into structured ranges."""
    ranges: list[dict] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            start, _, end = chunk.partition("-")
            try:
                ranges.append({"start": int(start), "end": int(end)})
            except ValueError:
                continue
        else:
            try:
                line = int(chunk)
                ranges.append({"start": line, "end": line})
            except ValueError:
                continue
    return ranges


def parse_log(path: Path) -> dict:
    """Parse pytest output: counts, skips, deselections, warnings, term-missing table."""
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    out: dict = {
        "platform": None,
        "python": None,
        "rootdir": None,
        "configfile": None,
        "collected": None,
        "deselected": None,
        "passed": None,
        "failed": None,
        "skipped": None,
        "errors": None,
        "warnings": None,
        "duration_s": None,
        "coverage_warning": None,
        "skipped_details": [],
        "missing_lines": {},
        "test_paths_inventory": [],
    }

    header = re.compile(r"^platform (\S+) -- Python ([\d.]+)")
    for line in lines[:15]:
        m = header.match(line)
        if m:
            out["platform"], out["python"] = m.group(1), m.group(2)
        if line.startswith("rootdir:"):
            out["rootdir"] = line.split(":", 1)[1].strip()
        if line.startswith("configfile:"):
            out["configfile"] = line.split(":", 1)[1].strip()
        m = re.search(r"collected (\d+) items?(?: / (\d+) deselected)?(?: / (\d+) selected)?", line)
        if m:
            out["collected"] = int(m.group(1))
            out["deselected"] = int(m.group(2)) if m.group(2) else 0

    # Final status line, whose token order varies with failures:
    # "1 failed, 479 passed, 4 skipped, 2 deselected, 1 warning in 13.41s"
    for line in reversed(lines):
        if not re.search(r" in [\d.]+s\s*=*\s*$", line):
            continue
        found = {}
        for key, pattern in (
            ("passed", r"(\d+) passed"),
            ("failed", r"(\d+) failed"),
            ("skipped", r"(\d+) skipped"),
            ("deselected", r"(\d+) deselected"),
            ("warnings", r"(\d+) warnings?"),
            ("errors", r"(\d+) errors?"),
        ):
            m = re.search(pattern, line)
            if m:
                found[key] = int(m.group(1))
        if "passed" not in found:
            continue
        out["passed"] = found["passed"]
        out["failed"] = found.get("failed", 0)
        out["skipped"] = found.get("skipped", 0)
        out["deselected"] = found.get("deselected", out["deselected"] or 0)
        out["warnings"] = found.get("warnings", 0)
        out["errors"] = found.get("errors", 0)
        m = re.search(r" in ([\d.]+)s", line)
        out["duration_s"] = float(m.group(1)) if m else None
        break

    for line in lines:
        m = re.match(r"^SKIPPED \[\d+\] (\S+):(\d+): (.+)$", line.strip())
        if m:
            out["skipped_details"].append(
                {"test": m.group(1), "line": int(m.group(2)), "reason": m.group(3).strip()}
            )

    coverage_notes = [
        line.strip()
        for line in lines
        if "module-not-measured" in line or "previously imported, but not measured" in line
    ]
    if coverage_notes:
        # Prefer the human-readable header over coverage.py's `self.warn(...)` line.
        out["coverage_warning"] = next(
            (n for n in coverage_notes if "CoverageWarning" in n), coverage_notes[0]
        )

    # Term-missing table: `path  stmts  miss  cover%  1-3, 9`
    row = re.compile(r"^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)%\s*(.*)$")
    for line in lines:
        m = row.match(line.strip())
        if not m:
            continue
        name, stmts, miss, cover, rest = m.groups()
        if name.lower() == "total":
            continue
        if "." not in name and "/" not in name:
            continue
        out["missing_lines"][name] = {
            "statements": int(stmts),
            "missing": int(miss),
            "cover_pct": float(cover),
            "ranges": parse_missing_ranges(rest),
            "raw": rest.strip(),
        }

    # Inventory of test ids actually exercised (deduped, order preserved)
    seen: set[str] = set()
    test_re = re.compile(r"^(\S+\.py)::")
    for line in lines:
        m = test_re.match(line)
        if m and m.group(1) not in seen:
            seen.add(m.group(1))
            out["test_paths_inventory"].append(m.group(1))

    return out


def parse_xml(path: Path) -> dict | None:
    """Parse Cobertura coverage.xml (best effort, stdlib only)."""
    try:
        import xml.etree.ElementTree as ET
    except Exception:  # pragma: no cover
        return None
    try:
        root = ET.parse(path).getroot()
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}

    classes: list[dict] = []
    for cls in root.iter("class"):
        filename = cls.get("filename") or ""
        line_rate = float(cls.get("line-rate") or 0.0)
        missing = []
        for ln in cls.iter("line"):
            if ln.get("hits") == "0":
                missing.append(int(ln.get("number")))
        ranges: list[dict] = []
        for num in missing:
            if ranges and num == ranges[-1]["end"] + 1:
                ranges[-1]["end"] = num
            else:
                ranges.append({"start": num, "end": num})
        classes.append(
            {
                "path": filename,
                "line_rate_pct": round(line_rate * 100, 2),
                "missing_line_count": len(missing),
                "missing_ranges": ranges,
            }
        )
    classes.sort(key=lambda c: (c["line_rate_pct"], c["path"]))
    return {
        "line_rate_pct": round(float(root.get("line-rate") or 0.0) * 100, 2),
        "branch_rate_pct": round(float(root.get("branch-rate") or 0.0) * 100, 2),
        "lines_valid": root.get("lines-valid"),
        "lines_covered": root.get("lines-covered"),
        "timestamp_ms": root.get("timestamp"),
        "classes": classes,
    }


def parse_summary(path: Path) -> dict:
    """Extract the claims the summary makes, so they can be cross-checked."""
    text = path.read_text(encoding="utf-8", errors="replace")
    out: dict = {
        "claimed": {},
        "module_rows": [],
        "execution_date": None,
        "referenced_paths": [],
    }

    patterns = {
        "total_tests": r"Total Tests Executed\*\*\s*\|\s*\*\*?([\d,]+)",
        "passed": r"Passed Tests\*\*\s*\|\s*\*\*?([\d,]+)",
        "failed": r"Failed Tests\*\*\s*\|\s*\*\*?([\d,]+)",
        "skipped": r"Skipped Tests\*\*\s*\|\s*\*\*?([\d,]+)",
        "deselected": r"Deselected Tests\*\*\s*\|\s*\*\*?([\d,]+)",
        "overall_coverage": r"Overall Code Coverage\*\*\s*\|\s*\*\*?([\d.]+)%",
        "statements": r"Lines Analyzed\*\*\s*\|\s*\*\*?([\d,]+)",
        "covered": r"Lines Covered\*\*\s*\|\s*\*\*?([\d,]+)",
    }
    for key, pat in patterns.items():
        m = re.search(pat, text)
        if m:
            out["claimed"][key] = m.group(1).replace(",", "")

    m = re.search(r"\*\*Execution Date\*\*:\s*(.+)", text)
    if m:
        out["execution_date"] = m.group(1).strip()

    for line in text.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 5 or not cells[0].startswith("`test_"):
            continue
        name = cells[0].strip("`")
        nums = []
        for cell in cells[1:5]:
            cell = cell.replace("*", "").strip()
            nums.append(int(cell) if cell.isdigit() else None)
        out["module_rows"].append(
            {"module": name, "total": nums[0], "passed": nums[1], "skipped": nums[2], "failed": nums[3]}
        )

    for m in re.finditer(r"`([^`]+\.py)`", text):
        out["referenced_paths"].append(m.group(1))
    return out


def resolve_source_repo(result_dir: Path, coverage_paths: list[str], component: str) -> dict:
    """Find the checkout that owns the paths named in the coverage report."""
    candidates = [result_dir]
    for parent in list(result_dir.parents)[:6]:
        candidates.append(parent)
    for path in coverage_paths:
        parts = Path(path).parts
        for idx in range(len(parts), 0, -1):
            suffix = Path(*parts[:idx])
            for base in candidates:
                probes = (
                    base / suffix,
                    base / "apps" / suffix,
                    base / "apps" / component / suffix,
                )
                for probe in probes:
                    if not probe.exists():
                        continue
                    # Walk back to a plausible repo root (workspace marker or .git).
                    cur = probe.parent
                    for _ in range(10):
                        if (cur / "pnpm-workspace.yaml").exists() or (cur / ".git").exists():
                            try:
                                rel = probe.relative_to(cur)
                            except ValueError:
                                rel = suffix
                            return {"repo_root": str(cur), "source_probe": str(rel)}
                        if cur.parent == cur:
                            break
                        cur = cur.parent
                    return {"repo_root": str(base), "source_probe": str(suffix)}
    return {"repo_root": None, "source_probe": None}


def test_inventory(repo_root: str | None, component: str) -> dict:
    if not repo_root:
        return {"root": None, "test_files": [], "count": 0}
    root = Path(repo_root)
    patterns = [
        root / "apps" / component / "src" / component / "tests",
        root / "apps" / component / "tests",
        root / "src" / component / "tests",
    ]
    for base in patterns:
        if base.is_dir():
            files = sorted(p.name for p in base.rglob("test_*.py"))
            return {"root": str(base), "test_files": files, "count": len(files)}
    return {"root": None, "test_files": [], "count": 0}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def build_report(root: Path, component: str, explicit_dir: Path | None = None) -> dict:
    matches = [explicit_dir] if explicit_dir else find_component_dirs(root, component)
    report: dict = {
        "component": component,
        "search_root": str(root),
        "matches": [str(m) for m in matches],
        "candidates": [
            {"path": str(m), "artifact_mtime": _artifact_mtime(m)} for m in matches
        ],
        "ambiguous": len(matches) > 1,
        "selected": None,
        "artifacts": {},
        "missing_required": [],
        "warnings": [],
        "errors": [],
    }

    if not matches:
        report["errors"].append(
            f"No folder named '{component}' containing test artifacts was found under {root}."
        )
        return report

    result_dir = matches[0]
    report["selected"] = str(result_dir)
    if explicit_dir and result_dir.name.lower() != component.lower():
        report["warnings"].append(
            f"Explicit directory name '{result_dir.name}' does not match component '{component}'."
        )

    for rel in REQUIRED:
        target = result_dir / rel
        report["artifacts"][rel] = {
            "required": True,
            "present": target.exists(),
            "path": str(target) if target.exists() else None,
            "bytes": target.stat().st_size if target.exists() else 0,
        }
        if not target.exists():
            report["missing_required"].append(rel)

    for rel in OPTIONAL:
        target = result_dir / rel
        report["artifacts"][rel] = {
            "required": False,
            "present": target.exists(),
            "path": str(target) if target.exists() else None,
            "bytes": target.stat().st_size if target.exists() else 0,
        }

    if report["ambiguous"]:
        report["warnings"].append(
            f"{len(matches)} candidate folders matched; auditing the shortest path. "
            "Confirm this is the intended run."
        )
    if not report["artifacts"]["coverage.xml"]["present"]:
        report["warnings"].append("coverage.xml is absent (optional); line-level ranges come from the log only.")

    if report["missing_required"]:
        report["errors"].append(
            "Missing required artifact(s): " + ", ".join(report["missing_required"])
        )
        return report

    cov = parse_coverage_report(result_dir / "coverage_report.txt")
    log = parse_log(result_dir / "test_results.log")
    summary = parse_summary(result_dir / "TEST_SUMMARY.md")
    xml = parse_xml(result_dir / "coverage.xml") if report["artifacts"]["coverage.xml"]["present"] else None

    source = resolve_source_repo(
        result_dir, [f["path"] for f in cov["files"]], component
    )
    inventory = test_inventory(source.get("repo_root"), component)

    referenced = {Path(p).name for p in summary["referenced_paths"]}
    missing_from_summary = [f for f in inventory["test_files"] if f not in referenced]

    report.update(
        {
            "coverage_report": cov,
            "log": log,
            "coverage_xml": xml,
            "summary": summary,
            "source": source,
            "repo_test_inventory": inventory,
            "drift": {
                "summary_module_count": len(summary["module_rows"]),
                "repo_test_file_count": inventory["count"],
                "test_files_not_in_summary": missing_from_summary,
                "summary_count_mismatch": (
                    len(summary["module_rows"]) != inventory["count"]
                    if inventory["count"]
                    else None
                ),
            },
        }
    )

    # Internal consistency checks
    if log["passed"] is not None and summary["claimed"].get("passed"):
        if int(summary["claimed"]["passed"]) != log["passed"]:
            report["warnings"].append(
                f"Summary claims {summary['claimed']['passed']} passed; log reports {log['passed']}."
            )
    if cov["total"] and summary["claimed"].get("overall_coverage"):
        # coverage_report.txt rounds to whole percent; coverage.xml carries 2 decimals.
        tolerance = 0.51
        if abs(cov["total"]["cover_pct"] - float(summary["claimed"]["overall_coverage"])) > tolerance:
            report["warnings"].append(
                "Summary coverage "
                f"{summary['claimed']['overall_coverage']}% != coverage_report "
                f"{cov['total']['cover_pct']}%."
            )
    if log["coverage_warning"]:
        report["warnings"].append(
            "Coverage run emitted a 'module-not-measured' warning; treat the headline percentage as approximate."
        )
    if log["rootdir"] and "/Users/" in log["rootdir"]:
        report["warnings"].append(
            f"Log was produced on a different checkout/host (`{log['rootdir']}`); regenerate before quoting numbers."
        )
    if missing_from_summary:
        report["warnings"].append(
            f"{len(missing_from_summary)} repo test file(s) are absent from the summary inventory: "
            + ", ".join(missing_from_summary[:8])
            + ("..." if len(missing_from_summary) > 8 else "")
        )

    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract evidence for Testing_Auditor")
    parser.add_argument("--component", required=True, help="Component/folder name, e.g. tts")
    parser.add_argument("--root", default=".", help="Directory to search (default: cwd)")
    parser.add_argument("--dir", help="Explicit result folder; skips discovery")
    parser.add_argument("--json-out", help="Write the JSON bundle to this path instead of stdout")
    args = parser.parse_args()

    explicit = Path(args.dir).resolve() if args.dir else None
    report = build_report(Path(args.root).resolve(), args.component, explicit)
    payload = json.dumps(report, indent=2, sort_keys=False)

    if args.json_out:
        Path(args.json_out).write_text(payload, encoding="utf-8")
        print(f"wrote {args.json_out}")
    else:
        print(payload)

    return 0 if not report["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
