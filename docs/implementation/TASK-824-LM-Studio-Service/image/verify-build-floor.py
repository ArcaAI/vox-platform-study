#!/usr/bin/env python3
"""TASK-824 — prove a llama.cpp image is at or past the TASK-831 build floor.

Run this after ANY change to the digest pin in `Dockerfile`.

WHY THIS EXISTS
---------------
TASK-831 §4.1 sets a hard floor of build b9383 (2026-05-28). Below it, two
merged-but-not-yet-included bugs make Gemma 4 multimodal output *plausible but
wrong*, with no error and no crash:

  * PR #23822 — the multimodal projector used post-norm; Gemma 4 switched to
    pre-norm. Degraded vision, silently.
  * PR #23815 — audio RMS-norm eps hardcoded 1e-5 instead of 1e-6.
    Degraded audio, silently.

Comparing build NUMBERS (9853 > 9383) is a proxy. This script checks the thing
that actually matters: that each fix commit is an ANCESTOR of the git revision
the image was built from. A `behind_by` of 0 means the fix is in.

Usage:
    python3 verify-build-floor.py                       # checks the pinned default
    python3 verify-build-floor.py --revision <git-sha>  # checks any revision

Exit status is 0 only if every required fix is present.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

REPO = "ggml-org/llama.cpp"

# Pinned in image/Dockerfile — keep in sync.
DEFAULT_REVISION = "7af4279f4579094cbe121cccb3c28357396e55d0"  # server-cuda-b9853

# The fixes that define the floor, from TASK-831 §4.1.
REQUIRED_PRS = {
    23822: "mtmd: gemma 4 projector pre_norm (vision correctness)",
    23815: "mtmd: gemma 4 audio rms_norm eps 1e-6 (audio correctness)",
    21309: "model: gemma 4 vision support",
    21421: "mtmd: gemma 4 audio conformer encoder support",
}


def gh(path: str) -> tuple[int, object | None]:
    req = urllib.request.Request(f"https://api.github.com{path}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "hope-task824-verify-build-floor")
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as exc:
        return exc.code, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--revision", default=DEFAULT_REVISION,
                    help="git revision the image was built from (org.opencontainers.image.revision)")
    args = ap.parse_args()
    rev = args.revision

    status, commit = gh(f"/repos/{REPO}/commits/{rev}")
    if status != 200 or commit is None:
        print(f"FAIL: revision {rev} not found in {REPO} (HTTP {status})")
        return 2
    print(f"image revision : {rev}")
    print(f"committed      : {commit['commit']['committer']['date']}")
    print()

    ok = True
    for pr, label in sorted(REQUIRED_PRS.items()):
        status, data = gh(f"/repos/{REPO}/pulls/{pr}")
        if status != 200 or data is None:
            print(f"  PR #{pr:<6} UNKNOWN  (HTTP {status}) — {label}")
            ok = False
            continue
        merge_sha = data.get("merge_commit_sha")
        if not data.get("merged_at") or not merge_sha:
            print(f"  PR #{pr:<6} NOT MERGED — {label}")
            ok = False
            continue
        status, cmp_ = gh(f"/repos/{REPO}/compare/{merge_sha}...{rev}")
        if status != 200 or cmp_ is None:
            print(f"  PR #{pr:<6} COMPARE FAILED (HTTP {status}) — {label}")
            ok = False
            continue
        present = cmp_["status"] in ("ahead", "identical") and cmp_["behind_by"] == 0
        mark = "PRESENT" if present else "MISSING"
        print(f"  PR #{pr:<6} {mark:<8} behind_by={cmp_['behind_by']:<4} ahead_by={cmp_['ahead_by']:<5} — {label}")
        ok = ok and present

    print()
    if ok:
        print("PASS — every required multimodal fix is an ancestor of this build.")
        return 0
    print("FAIL — this image is BELOW the TASK-831 b9383 floor.")
    print("       Gemma 4 vision/audio output would be silently wrong. Do not deploy.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
