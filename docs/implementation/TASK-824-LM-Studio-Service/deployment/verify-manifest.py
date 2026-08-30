#!/usr/bin/env python3
"""TASK-824 — assert manifest.tsv agrees with manifest.json, and (optionally)
that both agree with what HuggingFace actually serves today.

WHAT THIS CHECKS
----------------
`upstream.json` in the sync ConfigMap is the PROVENANCE RECORD the publisher
verifies against before uploading anything into `hope-models`
(infrastructure/docker/minio/README.md §5.5 step 0). It is deliberately NOT read
by `sync.sh` — the sync verifies against each prefix's own `SHA256SUMS`, so the
bucket stays the single source of truth at serving time.

That makes this script a PRE-PUBLISH gate: it re-checks every recorded digest
against the live publisher blob, and cross-checks that `models.tsv` and
`upstream.json` name the same slugs.

Run it after ANY edit to model-sync.yaml, and before any publish.

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


def objects_from_json(blob: str) -> list[tuple[str, str, str, int]]:
    """upstream.json objects: (slug, path, sha256, bytes)."""
    doc = json.loads(blob)
    return [
        (m["slug"], o["path"], o["sha256"], int(o["bytes"]))
        for m in doc["models"]
        for o in m["objects"]
    ]


def slugs_from_tsv(blob: str) -> list[tuple[str, str, str]]:
    """models.tsv rows: slug <TAB> version <TAB> role."""
    out = []
    for line in blob.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) != 3:
            print(f"FAIL: models.tsv line does not have 3 tab-separated fields:\n  {line!r}")
            raise SystemExit(1)
        out.append((parts[0], parts[1], parts[2]))
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
                    help="also verify each recorded digest against the live HuggingFace blob")
    args = ap.parse_args()

    data = load_configmap_data()
    objs = objects_from_json(data["upstream.json"])
    rows = slugs_from_tsv(data["models.tsv"])

    json_slugs = {s for s, _, _, _ in objs}
    tsv_slugs = {s for s, _, _ in rows}

    print(f"models.tsv    : {len(rows)} model(s)")
    print(f"upstream.json : {len(objs)} object(s) across {len(json_slugs)} model(s)")

    ok = True
    if json_slugs != tsv_slugs:
        print("\nFAIL: models.tsv and upstream.json name different slugs.")
        for s in sorted(json_slugs - tsv_slugs):
            print(f"  only in upstream.json: {s}")
        for s in sorted(tsv_slugs - json_slugs):
            print(f"  only in models.tsv   : {s}")
        ok = False
    else:
        print("PASS: models.tsv and upstream.json name the same slugs.")

    # Slugs must be S3-safe and lowercase (minio/README.md §5.1).
    for s in sorted(tsv_slugs):
        if s != s.lower() or not all(c.isalnum() or c in "._-" for c in s):
            print(f"FAIL: slug {s!r} is not lowercase [a-z0-9._-]")
            ok = False

    unset = [s for s, v, _ in rows if v == "SET-AT-PUBLISH" or not v]
    if unset:
        print(f"\nNOTE: {len(unset)} slug(s) have no published version yet "
              f"(content-addressed, known only after publish): {', '.join(sorted(unset))}")
        print("      The sync Job fails closed on these by design.")

    total = sum(b for _, _, _, b in objs)
    print(f"total upstream bytes: {total:,} ({total / 1024**3:.2f} GiB)")

    if not ok:
        return 1
    if not args.remote:
        return 0

    print("\nre-checking recorded digests against live HuggingFace blobs...")
    doc = json.loads(data["upstream.json"])
    for m in doc["models"]:
        try:
            actual = hf_actual(m["repo"], m["revision"])
        except urllib.error.HTTPError as exc:
            print(f"  {m['repo']}: HTTP {exc.code} — cannot verify")
            ok = False
            continue
        for o in m["objects"]:
            base = o["path"].split("/")[-1]
            match = next((v for k, v in actual.items() if k.split("/")[-1] == base), None)
            if match is None:
                print(f"  MISSING upstream: {m['repo']}/{base}")
                ok = False
                continue
            sha, size = match
            good = sha == o["sha256"] and size == int(o["bytes"])
            print(f"  {'ok   ' if good else 'DRIFT'} {base}")
            if not good:
                print(f"        recorded sha={o['sha256']} bytes={o['bytes']}")
                print(f"        upstream sha={sha} bytes={size}")
                ok = False

        # primaryObject / projectorObject must exist in `objects`.
        paths = {o["path"] for o in m["objects"]}
        for field in ("primaryObject", "projectorObject"):
            val = m.get(field)
            if val and val not in paths:
                print(f"  FAIL {m['slug']}: {field} {val!r} is not listed in objects[]")
                ok = False

    print()
    print("PASS: every recorded digest matches the live upstream blob." if ok
          else "FAIL: upstream drift — do NOT publish until this is explained.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
