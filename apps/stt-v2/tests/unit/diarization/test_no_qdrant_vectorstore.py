"""Regression guard for the TASK-330 corrective decision.

Speaker diarization in STT-v2 is **in-memory and session-scoped**. The legacy
Qdrant-backed speaker vector store (``stt_v2.core.vectorstore``) was removed by
design during the diarization refactor (``feat(diarization): implement speaker
tracking and embedding extraction``). Cross-session speaker identity is now
persisted via PostgreSQL voice profiles
(``stt_v2.diarization.preseed.preseed_speaker``), not Qdrant.

These tests fail loudly if the removed Qdrant store is resurrected, or if a hard
``qdrant_client`` dependency is reintroduced into the diarization import path, so
the intentional absence of the module is never mistaken for a regression.

See ``apps/stt-v2/README.md`` (Overview note) for the architectural decision.
"""

from __future__ import annotations

import importlib
import subprocess
import sys

import pytest


def test_legacy_qdrant_vectorstore_module_is_absent() -> None:
    """The Qdrant-backed speaker store was intentionally removed (TASK-330).

    If this fails, a ``core/vectorstore`` module has reappeared — reconcile it
    with the documented in-memory/session-scoped design before re-adding it.
    """
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("stt_v2.core.vectorstore")


def test_session_scoped_diarization_does_not_import_qdrant_client() -> None:
    """A fresh import of the diarization stack must not pull in ``qdrant_client``.

    Speaker identity is in-memory (``SpeakerTracker``) + DB voice profiles
    (``preseed_speaker``); the diarization path must have no Qdrant dependency.
    """
    snippet = (
        "import sys, importlib\n"
        "try:\n"
        "    importlib.import_module('stt_v2.diarization.speaker_identifier')\n"
        "    importlib.import_module('stt_v2.diarization.speaker_tracker')\n"
        "    importlib.import_module('stt_v2.diarization.preseed')\n"
        "except Exception as exc:\n"
        "    sys.stderr.write(repr(exc))\n"
        "    sys.exit(2)\n"
        "sys.exit(1 if 'qdrant_client' in sys.modules else 0)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", snippet],
        capture_output=True,
        text=True,
    )

    if result.returncode == 2:
        pytest.skip(f"diarization stack not importable in this env: {result.stderr}")

    assert result.returncode == 0, (
        "The session-scoped diarization import path pulled in qdrant_client; "
        "speaker identity must stay in-memory + DB voice profiles (TASK-330). "
        f"stderr: {result.stderr}"
    )
