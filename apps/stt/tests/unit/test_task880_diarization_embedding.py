"""TASK-880 — an agent's `models.embedding` reaches the embedding service.

TASK-877 found and DEFERRED this: `_assemble_session_runtime` resolved a per-session
embedding model only from an INLINE `ModelRef`, while `pipeline_spec_from_resolved`
emits a SLUG ref for every agent. So an agent that bound a speaker-embedding row got
the platform singleton (`stt.diarization.hfModelId`) instead, silently.

`stt.diarization.hfModelId` itself is deliberately NOT moved: it declares the embedding
SPACE that enrolled `UserVoiceProfile` rows live in. The guard that keeps an agent from
re-spacing diarization behind enrollment's back is on the PRODUCER side
(`buildResolvedAsrSpec` refuses a declared dimension mismatch); this half only makes the
reference actually arrive.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from stt.streaming.session_manager import SessionManager


def _mgr(bundle_models: dict[str, object] | None = None) -> MagicMock:
    mgr = MagicMock(spec=SessionManager)
    mgr._session_specs = (
        {"s1": SimpleNamespace(model_configs=bundle_models)} if bundle_models is not None else {}
    )
    return mgr


def _config(*, slug: str | None = None, inline_id: str | None = None) -> SimpleNamespace:
    if inline_id is not None:
        ref = SimpleNamespace(is_inline=True, inline=SimpleNamespace(hf_model_id=inline_id), slug=None)
    elif slug is not None:
        ref = SimpleNamespace(is_inline=False, inline=None, slug=slug)
    else:
        return SimpleNamespace(models=SimpleNamespace(embedding=None))
    return SimpleNamespace(models=SimpleNamespace(embedding=ref))


class TestEmbeddingRefResolution:
    def test_a_slug_ref_resolves_from_the_session_spec_bundle(self) -> None:
        """The regression TASK-877 recorded: this returned None for every agent."""
        mgr = _mgr({"wespeaker-voxceleb-resnet34": SimpleNamespace(source_uri="pyannote/wespeaker-voxceleb-resnet34-LM")})
        resolved = SessionManager._spec_embedding_model_id(
            mgr, "s1", _config(slug="wespeaker-voxceleb-resnet34")
        )
        assert resolved == "pyannote/wespeaker-voxceleb-resnet34-LM"

    def test_an_inline_ref_still_wins(self) -> None:
        mgr = _mgr({})
        assert (
            SessionManager._spec_embedding_model_id(mgr, "s1", _config(inline_id="speechbrain/spkrec-ecapa-voxceleb"))
            == "speechbrain/spkrec-ecapa-voxceleb"
        )

    @pytest.mark.parametrize(
        ("bundle", "config"),
        [
            (None, _config(slug="anything")),
            ({}, _config(slug="not-in-bundle")),
            ({}, _config()),
        ],
    )
    def test_no_resolvable_row_falls_back_to_the_platform_singleton(
        self, bundle: dict | None, config: SimpleNamespace
    ) -> None:
        """`None` is the caller's signal to use `get_embedding_service()` — the
        pre-existing behaviour for a deprecated-pipeline session, kept deliberately."""
        assert SessionManager._spec_embedding_model_id(_mgr(bundle), "s1", config) is None
