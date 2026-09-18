"""QW-12 geometry-parity gate — pure-CPU, blocking, runs in the FAST unit lane.

Reads the committed BP-1 fingerprint (``streaming_thresholds.json``'s
``_fingerprint`` block) and the LIVE seed file
(``packages/database/src/prisma/db_main/seed/25-agents.ts``, read AT PARSE
TIME as text — never against a live DB) plus the whisper.cpp prompt-state
module constants (``apps/stt/src/stt/pipeline/language_modes.py``, also read
as text — this test never imports STT's runtime code, so it stays fast and
dependency-free). It FAILS when any served geometry / prompt-state field
differs from what the committed baseline says was measured.

This is the concrete fix for M-16's "``e3d61eefb`` and ``ea174814e`` changed
geometry with no scorecard entry": an ungoverned edit to
``ASR_PARAMETERS.streaming.*`` or the ``WHISPER_CPP_*_PRIMING_PROMPT_ENABLED``
flags now turns THIS test red at PR time, instead of only being caught (or
not) on the next nightly ``stt-quality-gate`` run.

**Self-skips (not fails) until BP-1's live capture lands.** The committed
``_fingerprint`` block ships as all-null scaffolding (this lane must never
invent fingerprint numbers) — this test recognizes that shape via
``streaming_quality.check_fingerprint`` semantics and skips with a named
reason so it cannot flag a false "geometry drifted from null" positive. Once
the orchestrator's BP-1 re-capture fills the block in, this test goes live
automatically — no code change required.

Only the fields this text-scan can extract are compared: ``partialWindowSec``,
``partialIntervalMs``, ``endpointing``, ``vadEnabled`` (from the agent seed's
``ASR_PARAMETERS``) and ``pairPromptEnabled`` / ``singlePromptEnabled`` (from
``language_modes.py``'s module constants — the literal root-cause signal of
today's regression). ``modelSlug`` / ``modelDigest`` / ``maxDecodeWindowSec`` /
``agentVersion`` / ``promptHash`` / ``engineBuild`` / ``device`` /
``sdkOperatingPoint`` are SDK/runtime-resolved facts a static seed scan cannot
derive and are left to the live ``stt-quality-gate`` (QW-12) instead.

Run::

    conda run -n arcaenv --no-capture-output pytest \
        apps/stt/tests/integration/test_seed_geometry_parity.py -v
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from tests.integration.streaming_quality import fingerprint_mismatch

pytestmark = [pytest.mark.integration]

_REPO_ROOT = Path(__file__).resolve().parents[4]
_SEED_PATH = (
    _REPO_ROOT / "packages" / "database" / "src" / "prisma" / "db_main" / "seed" / "25-agents.ts"
)
_LANGUAGE_MODES_PATH = _REPO_ROOT / "apps" / "stt" / "src" / "stt" / "pipeline" / "language_modes.py"
_THRESHOLDS_PATH = Path(__file__).resolve().parent / "streaming_thresholds.json"

# The subset of the BP-1 schema this static text-scan can actually derive.
# The rest (modelSlug, modelDigest, maxDecodeWindowSec, agentVersion,
# promptHash, engineBuild, device, sdkOperatingPoint) are SDK/runtime facts —
# left to the live nightly gate.
_STATIC_FIELDS: tuple[str, ...] = (
    "partialWindowSec",
    "partialIntervalMs",
    "endpointing",
    "vadEnabled",
    "pairPromptEnabled",
    "singlePromptEnabled",
)


@pytest.fixture(scope="session")
def verify_test_environment():  # noqa: D401 — fixture override
    """No services needed — this gate reads two committed source files as text."""
    yield


def _load_baseline_fingerprint() -> dict[str, Any] | None:
    thresholds = json.loads(_THRESHOLDS_PATH.read_text(encoding="utf-8"))
    return thresholds.get("_fingerprint")


def _extract_asr_parameters_block(seed_text: str) -> str | None:
    """Isolate the ``export const ASR_PARAMETERS = { ... };`` block by brace
    depth so field regexes below never accidentally match a same-named field
    elsewhere in the seed file."""
    marker = "export const ASR_PARAMETERS ="
    start = seed_text.find(marker)
    if start == -1:
        return None
    brace_start = seed_text.find("{", start)
    if brace_start == -1:
        return None
    depth = 0
    for i in range(brace_start, len(seed_text)):
        ch = seed_text[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return seed_text[brace_start : i + 1]
    return None


def _extract_seed_geometry(block: str) -> dict[str, Any]:
    out: dict[str, Any] = {}

    m = re.search(r"partialWindowSec:\s*(\d+(?:\.\d+)?)", block)
    if m:
        out["partialWindowSec"] = float(m.group(1))

    m = re.search(r"partialIntervalMs:\s*(\d+(?:\.\d+)?)", block)
    if m:
        out["partialIntervalMs"] = float(m.group(1))

    m = re.search(r"endpointing:\s*'([^']+)'", block)
    if m:
        out["endpointing"] = m.group(1)

    # Scoped to the audioFrontEnd.vad sub-object specifically, so this never
    # picks up denoise.enabled / diarization.enabled instead.
    m = re.search(r"vad:\s*\{[^}]*?enabled:\s*(true|false)", block)
    if m:
        out["vadEnabled"] = m.group(1) == "true"

    return out


def _extract_prompt_state(language_modes_text: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    m = re.search(r"^WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED\s*=\s*(True|False)", language_modes_text, re.MULTILINE)
    if m:
        out["pairPromptEnabled"] = m.group(1) == "True"
    m = re.search(r"^WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED\s*=\s*(True|False)", language_modes_text, re.MULTILINE)
    if m:
        out["singlePromptEnabled"] = m.group(1) == "True"
    return out


def _served_geometry() -> dict[str, Any]:
    """The currently-served geometry/prompt-state, read from the two
    committed source files as TEXT (never a live DB / import)."""
    served: dict[str, Any] = {}
    if _SEED_PATH.is_file():
        block = _extract_asr_parameters_block(_SEED_PATH.read_text(encoding="utf-8"))
        if block:
            served.update(_extract_seed_geometry(block))
    if _LANGUAGE_MODES_PATH.is_file():
        served.update(_extract_prompt_state(_LANGUAGE_MODES_PATH.read_text(encoding="utf-8")))
    return served


def test_seed_geometry_matches_baseline_fingerprint() -> None:
    """FAILS on an ungoverned geometry/prompt-state edit (the ``e3d61eefb`` /
    ``ea174814e`` pattern M-16 names); SKIPS until BP-1's live fingerprint
    capture lands (streaming_thresholds.json ships with an all-null
    scaffolding block — this lane never invents the numbers).
    """
    baseline = _load_baseline_fingerprint()
    if not baseline or all(v is None for v in baseline.values()):
        pytest.skip(
            "no BP-1 fingerprint captured in streaming_thresholds.json yet "
            "(_fingerprint is all-null scaffolding) — nothing to compare against"
        )

    if not _SEED_PATH.is_file():
        pytest.skip(f"seed file not found: {_SEED_PATH}")
    if not _LANGUAGE_MODES_PATH.is_file():
        pytest.skip(f"language_modes.py not found: {_LANGUAGE_MODES_PATH}")

    served = _served_geometry()
    missing_static_fields = [f for f in _STATIC_FIELDS if f not in served]
    assert not missing_static_fields, (
        "geometry-parity extractor could not find "
        f"{missing_static_fields} in {_SEED_PATH.name} / {_LANGUAGE_MODES_PATH.name} — "
        "the seed/module shape changed; update the regexes in this test rather than "
        "silently skipping a field the baseline DOES carry a value for"
    )

    mismatches = fingerprint_mismatch(served, baseline)
    assert not mismatches, (
        "seed geometry / prompt-state drifted from the BP-1 baseline fingerprint "
        "with no re-capture — this is exactly the e3d61eefb/ea174814e pattern (M-16): "
        + "; ".join(mismatches)
    )


# ===========================================================================
# Pure self-checks of the extractors themselves (no live seed file needed)
# ===========================================================================


def test_extract_asr_parameters_block_isolates_the_object_literal() -> None:
    sample = """
export const OTHER = { partialWindowSec: 999 };
export const ASR_PARAMETERS = {
  audioFrontEnd: {
    vad: { enabled: false, modelSlug: 'silero-vad' },
    denoise: { enabled: false },
  },
  decoding: { languageMode: 'ml-en' },
  streaming: { partialIntervalMs: 300, partialWindowSec: 3, endpointing: 'semantic' },
};
export const AFTER = { partialWindowSec: 111 };
"""
    block = _extract_asr_parameters_block(sample)
    assert block is not None
    assert "streaming:" in block
    assert "OTHER" not in block
    assert "AFTER" not in block

    geometry = _extract_seed_geometry(block)
    assert geometry == {
        "partialWindowSec": 3.0,
        "partialIntervalMs": 300.0,
        "endpointing": "semantic",
        "vadEnabled": False,
    }


def test_extract_asr_parameters_block_missing_marker_returns_none() -> None:
    assert _extract_asr_parameters_block("export const SOMETHING_ELSE = {};") is None


def test_extract_prompt_state_reads_module_constants() -> None:
    sample = "WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED = True\nWHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED = False\n"
    assert _extract_prompt_state(sample) == {
        "pairPromptEnabled": True,
        "singlePromptEnabled": False,
    }


def test_extract_prompt_state_missing_constants_returns_partial() -> None:
    assert _extract_prompt_state("# nothing here") == {}


def test_geometry_parity_detects_a_drifted_flag() -> None:
    """Proves the gate itself fires (not just asserted): a baseline recorded
    with the pair prompt OFF must flag today's served ON state.
    """
    baseline = {
        "partialWindowSec": 3.0,
        "partialIntervalMs": 300.0,
        "endpointing": "semantic",
        "vadEnabled": False,
        "pairPromptEnabled": False,
        "singlePromptEnabled": False,
    }
    served_with_drift = dict(baseline, pairPromptEnabled=True)
    mismatches = fingerprint_mismatch(served_with_drift, baseline)
    assert any("pairPromptEnabled" in m for m in mismatches)

    served_matching = dict(baseline)
    assert fingerprint_mismatch(served_matching, baseline) == []
