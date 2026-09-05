"""TASK-880 — an agent's `models.embedding` reaches the embedding service.

TASK-877 found and DEFERRED this: `_assemble_session_runtime` resolved a per-session
embedding model only from an INLINE `ModelRef`, while `pipeline_spec_from_resolved`
emits a SLUG ref for every agent. So an agent that bound a speaker-embedding row got
the platform singleton (`stt.diarization.hfModelId`) instead, silently.

TASK-887 then removed the singleton this defect used to fall through to: the ASR agent
declares the embedding model, a `UserVoiceProfile` records the model that embedded it, and
matching only compares profiles from that model. So this resolution is no longer merely the
CORRECT source of the model — it is the ONLY one, and `None` means embedding diarization does
not run for the session at all.
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
    def test_no_resolvable_row_resolves_to_none(
        self, bundle: dict | None, config: SimpleNamespace
    ) -> None:
        """TASK-887 — `None` no longer means "use the platform singleton" (there is none); it
        means this session does not diarize by embedding. `buildResolvedAsrSpec` refuses an
        agent that enables it without naming a model, so reaching here is a
        deprecated-pipeline session."""
        assert SessionManager._spec_embedding_model_id(_mgr(bundle), "s1", config) is None
