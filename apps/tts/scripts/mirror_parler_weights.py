#!/usr/bin/env python3
"""Mirror the gated Indic Parler-TTS weights into an internal store.

The ``ai4bharat/indic-parler-tts`` HuggingFace repo is Apache-2.0 but sits behind
a click-through gate — a production/cluster deploy must NOT pull it (or use a
personal ``HF_TOKEN``) at build/run time. An authorized operator runs this ONCE to
snapshot both repos into a local directory, which is then uploaded to the internal
mirror (MinIO ``models/`` prefix — Option A in the ticket). The Parler pod loads
from the mirror fully offline (``TTS_PARLER_MODEL_PATH`` / ``TTS_PARLER_DESC_ENCODER_PATH``
+ ``HF_HUB_OFFLINE=1`` / ``TRANSFORMERS_OFFLINE=1``).

Two repos are mirrored (see the runbook, ``docs/operations/tts-model-mirror/``):
  1. ``ai4bharat/indic-parler-tts``  — full snapshot (model + prompt tokenizer + DAC), ~3.76 GB.
  2. ``google/flan-t5-large``        — description tokenizer ONLY (~3 MB, ungated);
     Parler bakes this Hub id in its config and fetches it at load even when local.

Output layout (sha-scoped for reproducible rollback):
  <out>/indic-parler-tts/<sha>/…      + checksums.sha256 + NOTICE
  <out>/flan-t5-large/<sha>/…         + checksums.sha256

Usage:
  export HF_TOKEN=hf_...            # operator token WITH gate access — never committed/shipped
  python mirror_parler_weights.py --out ./mirror
  # then: mc cp --recursive ./mirror/ myminio/models/   (see runbook for upload + verify)

This script needs ``huggingface_hub`` (not a service runtime dep); run it in the
operator's env, not in CI or the cluster.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

PARLER_REPO = "ai4bharat/indic-parler-tts"
FLAN_REPO = "google/flan-t5-large"
# flan-t5-large: mirror the tokenizer (+ config) only — NOT the weights, which are
# already bundled inside the Parler safetensors.
FLAN_TOKENIZER_PATTERNS = [
    "tokenizer.json",
    "tokenizer_config.json",
    "spiece.model",
    "special_tokens_map.json",
    "config.json",
]


def _pinned_sha(api, repo: str) -> str:
    """Resolve the current commit sha of a repo's main revision (pin for rollback)."""
    return api.model_info(repo).sha


def _snapshot(repo: str, revision: str, dest: Path, allow_patterns: list[str] | None) -> Path:
    from huggingface_hub import snapshot_download

    print(f"→ downloading {repo}@{revision[:8]} → {dest}")
    path = snapshot_download(
        repo_id=repo,
        revision=revision,
        local_dir=str(dest),
        allow_patterns=allow_patterns,
    )
    return Path(path)


def _write_checksums(root: Path) -> Path:
    """Write a sha256 manifest of every mirrored file (integrity verification)."""
    manifest = root / "checksums.sha256"
    lines: list[str] = []
    for file in sorted(root.rglob("*")):
        if not file.is_file() or file.name == manifest.name:
            continue
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        lines.append(f"{digest}  {file.relative_to(root)}")
    manifest.write_text("\n".join(lines) + "\n")
    print(f"  wrote {manifest} ({len(lines)} files)")
    return manifest


def _write_notice(root: Path, sha: str) -> None:
    """Author the Apache-2.0 §4 attribution NOTICE (upstream ships none).

    The canonical LICENSE text is added by the operator per the runbook.
    """
    (root / "NOTICE").write_text(
        "Indic Parler-TTS (mirrored internally — TASK-495)\n"
        "==================================================\n\n"
        f"Source     : https://huggingface.co/{PARLER_REPO}\n"
        f"Revision   : {sha}\n"
        "License    : Apache-2.0 (see LICENSE, added per runbook)\n"
        "Copyright  : AI4Bharat and the Indic Parler-TTS contributors.\n\n"
        "Bundled/derived components retain their own attribution:\n"
        f"  - Description text encoder tokenizer: {FLAN_REPO} (Google, Apache-2.0)\n"
        "  - Audio codec: parler-tts/dac_44khZ_8kbps (Descript DAC, MIT)\n\n"
        "This mirror is an internal redistribution for HOPE cluster deploys and\n"
        "preserves the upstream license and attribution as required by Apache-2.0 §4.\n"
    )
    print(f"  wrote {root / 'NOTICE'}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Mirror gated Indic Parler-TTS weights (TASK-495)")
    parser.add_argument("--out", type=Path, default=Path("./mirror"), help="output directory")
    parser.add_argument(
        "--parler-revision", default=None, help="pin a specific commit sha (default: current main)"
    )
    args = parser.parse_args()

    try:
        from huggingface_hub import HfApi
    except ImportError:
        print("ERROR: pip install huggingface_hub (operator env only)", file=sys.stderr)
        return 2

    api = HfApi()
    parler_sha = args.parler_revision or _pinned_sha(api, PARLER_REPO)
    flan_sha = _pinned_sha(api, FLAN_REPO)
    print(f"Pinned {PARLER_REPO} → {parler_sha}")
    print(f"Pinned {FLAN_REPO} → {flan_sha}")

    parler_dir = args.out / "indic-parler-tts" / parler_sha
    flan_dir = args.out / "flan-t5-large" / flan_sha

    _snapshot(PARLER_REPO, parler_sha, parler_dir, allow_patterns=None)
    _write_checksums(parler_dir)
    _write_notice(parler_dir, parler_sha)

    _snapshot(FLAN_REPO, flan_sha, flan_dir, allow_patterns=FLAN_TOKENIZER_PATTERNS)
    _write_checksums(flan_dir)

    print("\nDone. Record these pins in the TASK-495 README, then upload per the runbook:")
    print(f"  TTS_PARLER_MODEL_PATH        → .../indic-parler-tts/{parler_sha}")
    print(f"  TTS_PARLER_DESC_ENCODER_PATH → .../flan-t5-large/{flan_sha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
