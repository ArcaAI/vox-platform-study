"""TASK-961 — a Kokoro row with unpublished weights fails with an ACTIONABLE error.

`resolve_kokoro_paths` failing closed is deliberate and stays (TASK-860: a
silent Hub fallback would hide a registry row whose weights were never
published). What was wrong is what the failure SAYS: it named
`TTS_KOKORO_MODEL_PATH`, an environment variable `moved_to_row_alias` has since
made a DEAD alias — so it cannot be set, cannot be fixed, and pointing an
operator at it is the same misdirection as telling them to configure a
HuggingFace token for a repo that does not exist on the Hub (TASK-960 D1).

The value's only supplier is the resolved spec (`from_spec` fills it from the
registry row's derived `localPath`), so the message must name THAT.
"""

from __future__ import annotations

import pytest

from tts.core.config import KokoroConfig
from tts.providers.kokoro import KokoroProvider, resolve_kokoro_paths


def _unpublished(tmp_path) -> KokoroConfig:
    """A set `model_path` whose directory holds no config.json / .pth."""
    return KokoroConfig().model_copy(update={"model_path": str(tmp_path)})


# ── the TASK-860 contract that must NOT regress ──────────────────────────────


def test_still_fails_closed_rather_than_falling_back_to_the_hub(tmp_path):
    """Regression guard. Falling through would hide an unpublished row."""
    with pytest.raises(FileNotFoundError):
        resolve_kokoro_paths(_unpublished(tmp_path))


def test_empty_model_path_is_still_the_hub_fallback():
    assert resolve_kokoro_paths(KokoroConfig()) is None


# ── TASK-961: the message must be actionable ─────────────────────────────────


def test_error_does_not_name_the_retired_env_var(tmp_path):
    with pytest.raises(FileNotFoundError) as exc:
        resolve_kokoro_paths(_unpublished(tmp_path))
    assert "TTS_KOKORO_MODEL_PATH" not in str(exc.value), (
        "the message names a dead alias an operator cannot set — it must name the registry row"
    )


def test_error_names_the_registry_row_as_the_supplier(tmp_path):
    with pytest.raises(FileNotFoundError) as exc:
        resolve_kokoro_paths(_unpublished(tmp_path))
    message = str(exc.value)
    assert "registry" in message.lower()
    assert "bucketPrefix" in message or "bucket" in message.lower()
    # The offending path still has to be in there.
    assert str(tmp_path) in message


def test_error_names_the_model_slug_when_one_is_known(tmp_path):
    """With several kokoro rows, 'which row?' is the operator's first question."""
    with pytest.raises(FileNotFoundError) as exc:
        resolve_kokoro_paths(_unpublished(tmp_path), slug="kokoro-en-custom")
    assert "kokoro-en-custom" in str(exc.value)


def test_slug_is_optional_so_existing_callers_keep_working(tmp_path):
    with pytest.raises(FileNotFoundError):
        resolve_kokoro_paths(_unpublished(tmp_path))


def test_provider_construction_propagates_the_slug_into_the_error(tmp_path):
    with pytest.raises(FileNotFoundError) as exc:
        KokoroProvider(_unpublished(tmp_path), slug="kokoro-en-custom")
    assert "kokoro-en-custom" in str(exc.value)


def test_from_spec_supplies_the_slug_from_the_resolved_row(tmp_path):
    """`from_spec` knows the row; the error must inherit its identity."""

    class _Model:
        slug = "kokoro-en-custom"
        local_path = None

    class _Candidate:
        model = _Model()

    class _Settings:
        kokoro = KokoroConfig()
        model_cache_ttl_seconds = 60

    _Model.local_path = str(tmp_path)
    with pytest.raises(FileNotFoundError) as exc:
        KokoroProvider.from_spec(_Settings(), _Candidate(), {})
    assert "kokoro-en-custom" in str(exc.value)
