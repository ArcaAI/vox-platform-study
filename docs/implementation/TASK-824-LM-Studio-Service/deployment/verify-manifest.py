#!/usr/bin/env python3
"""TASK-824 — assert manifest.tsv agrees with manifest.json, and (optionally)
that both agree with what HuggingFace actually serves today.

WHY TWO FORMS EXIST
-------------------
The sync Job runs in `minio/mc`, which ships no `jq` and no package manager to
install one. So the machine-readable manifest the Job parses is a TSV, and the
JSON alongside it carries the provenance notes. Two representations of the same
facts is a drift hazard; this script is the guard.

Run it after ANY edit to either block in model-sync.yaml.

    python3 verify-manifest.py              # local consistency only
    python3 verify-manifest.py --remote     # also re-check against HuggingFace

`--remote` is the stronger check and the one that matters before a first sync:
TASK-831 §4.1 records that Google's 15-17 July 2026 uploads of the Gemma repos
were BROKEN and were silently REPLACED on 2026-07-17. A digest that no longer
matches the live blob means the upstream artifact moved under us.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
MANIFEST_YAML = HERE / "model-sync.yaml"


def load_configmap_data() -> dict[str, str]:
    try:
        import yaml
    except ImportError:
        print("FAIL: pyyaml is required (pip install pyyaml)")
        raise SystemExit(2)
    docs = [d for d in yaml.safe_load_all(MANIFEST_YAML.read_text()) if d]
    for d in docs:
        if d.get("kind") == "ConfigMap" and d["metadata"]["name"] == "hope-llama-model-manifest":
            return d["data"]
    print("FAIL: ConfigMap hope-llama-model-manifest not found")
    raise SystemExit(2)


def rows_from_json(blob: str) -> list[tuple[str, str, int]]:
    doc = json.loads(blob)
    return [
        (f["key"], f["sha256"], int(f["bytes"]))
        for m in doc["models"]
        for f in m["files"]
    ]


def rows_from_tsv(blob: str) -> list[tuple[str, str, int]]:
    out = []
    for line in blob.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) != 3:
            print(f"FAIL: TSV line does not have 3 tab-separated fields:\n  {line!r}")
            raise SystemExit(1)
        out.append((parts[0], parts[1], int(parts[2])))
    return out


def hf_actual(repo: str, revision: str) -> dict[str, tuple[str, int]]:
    url = f"https://huggingface.co/api/models/{repo}/tree/{revision}?expand=true&recursive=true"
    req = urllib.request.Request(url, headers={"User-Agent": "hope-task824-verify-manifest"})
    with urllib.request.urlopen(req, timeout=60) as r:
        tree = json.load(r)
    out = {}
    for e in tree:
        if e.get("type") != "file" or not e["path"].endswith(".gguf"):
            continue
        lfs = e.get("lfs") or {}
        out[e["path"]] = (lfs.get("oid", ""), int(lfs.get("size") or e.get("size") or 0))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--remote", action="store_true",
                    help="also verify each digest against the live HuggingFace blob")
    args = ap.parse_args()

    data = load_configmap_data()
    j = rows_from_json(data["manifest.json"])
    t = rows_from_tsv(data["manifest.tsv"])

    print(f"manifest.json : {len(j)} files")
    print(f"manifest.tsv  : {len(t)} files")

    if sorted(j) != sorted(t):
        print("\nFAIL: manifest.tsv and manifest.json disagree.")
        for row in sorted(set(j) - set(t)):
            print(f"  only in JSON: {row[0]}")
        for row in sorted(set(t) - set(j)):
            print(f"  only in TSV : {row[0]}")
        return 1
    print("PASS: TSV and JSON agree on every (key, sha256, bytes).")

    total = sum(b for _, _, b in j)
    print(f"total staged bytes: {total:,} ({total / 1024**3:.2f} GiB)")

    if not args.remote:
        return 0

    print("\nre-checking digests against live HuggingFace blobs...")
    doc = json.loads(data["manifest.json"])
    ok = True
    for m in doc["models"]:
        try:
            actual = hf_actual(m["repo"], m["revision"])
        except urllib.error.HTTPError as exc:
            print(f"  {m['repo']}: HTTP {exc.code} — cannot verify")
            ok = False
            continue
        for f in m["files"]:
            basename = f["key"].split("/")[-1]
            match = next((v for k, v in actual.items() if k.split("/")[-1] == basename), None)
            if match is None:
                print(f"  MISSING upstream: {m['repo']}/{basename}")
                ok = False
                continue
            sha, size = match
            good = sha == f["sha256"] and size == int(f["bytes"])
            print(f"  {'ok  ' if good else 'DRIFT'} {basename}")
            if not good:
                print(f"        manifest sha={f['sha256']} bytes={f['bytes']}")
                print(f"        upstream sha={sha} bytes={size}")
                ok = False
    print()
    print("PASS: every digest matches the live upstream blob." if ok
          else "FAIL: upstream drift — do NOT sync until this is explained.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
