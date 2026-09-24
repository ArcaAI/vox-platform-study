"""TASK-1004 — honest capability levels, the degrade policy and the per-chain catalog.

The catalog used to say only "this engine serves this mode", so a whisper.cpp
code-switch pair read as supported while it actually reached the decoder with NO
language signal at all (the priming prompt is off, TASK-985 OD-B) — Run 1's
"English in Malayalam script" (G-4). Each (mode, engine) now has a LEVEL:

* ``native``      — the engine realises the mode itself;
* ``degraded``    — it serves the mode, visibly less well, with a closed reason;
* ``unsupported`` — it cannot serve the mode at all.

Language never selects the engine (OD-6): a level only DESCRIBES what the
admin-chosen chain delivers.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from stt.pipeline import language_modes
from stt.pipeline.dto import AiModelFormat
from stt.pipeline.language_modes import (
    LanguageModeUnsupportedError,
    chain_effective_level,
    language_mode_catalog_payload,
    mark_fallback_engine_switch,
    mode_capability,
    resolve_language,
)
from stt.streaming._runtime import clear_runtime, set_session_manager
from stt.streaming.api.routes import router

WHISPER_FAMILY = (
    AiModelFormat.SAFETENSOR,
    AiModelFormat.PYTORCH,
    AiModelFormat.ONNX,
    AiModelFormat.ONNX_OPTIMUM,
    AiModelFormat.CTRANSLATE2,
    AiModelFormat.FASTER_WHISPER,
)


@pytest.fixture(autouse=True)
def _prompts_as_shipped(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin both whisper.cpp prompt switches to their shipped state (OFF)."""
    monkeypatch.setattr(language_modes, "WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED", False)
    monkeypatch.setattr(language_modes, "WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED", False)


# --- levels ------------------------------------------------------------------


def test_whisper_cpp_pair_is_degraded_while_its_prompt_is_off() -> None:
    assert mode_capability("ml-en", AiModelFormat.WHISPER_CPP) == (
        "degraded",
        "whisper_cpp_pair_unprimed",
    )


def test_whisper_cpp_pair_is_native_once_the_pair_prompt_is_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(language_modes, "WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED", True)
    assert mode_capability("ml-en", AiModelFormat.WHISPER_CPP) == ("native", None)


@pytest.mark.parametrize("engine", WHISPER_FAMILY)
def test_whisper_family_pair_is_a_gloss_and_therefore_degraded(engine: AiModelFormat) -> None:
    assert mode_capability("ml-en", engine) == ("degraded", "gloss_translation_only")


@pytest.mark.parametrize(
    ("mode", "engine"),
    [
        ("ml-en", AiModelFormat.SARVAM),
        ("ml-en", AiModelFormat.AZURE_SPEECH),
        ("en", AiModelFormat.WHISPER_CPP),
        ("ml", AiModelFormat.WHISPER_CPP),
        ("en", AiModelFormat.NEMO),
        ("vi", AiModelFormat.OPENAI),
    ],
)
def test_native_levels(mode: str, engine: AiModelFormat) -> None:
    assert mode_capability(mode, engine) == ("native", None)


@pytest.mark.parametrize("engine", list(AiModelFormat))
def test_auto_is_native_on_every_engine(engine: AiModelFormat) -> None:
    assert mode_capability("auto", engine) == ("native", None)


@pytest.mark.parametrize(
    ("mode", "engine"),
    [
        ("ml", AiModelFormat.NEMO),
        ("ml-en", AiModelFormat.OPENAI),
        ("ml-en", AiModelFormat.PARAKEET_CPP),
        ("vi", AiModelFormat.SARVAM),
    ],
)
def test_unsupported_levels_still_raise_on_resolution(mode: str, engine: AiModelFormat) -> None:
    assert mode_capability(mode, engine) == ("unsupported", None)
    with pytest.raises(LanguageModeUnsupportedError):
        resolve_language(mode, engine, source="request")


def test_levels_agree_with_the_existing_support_matrix_for_every_pair() -> None:
    """``unsupported`` is exactly ``not engine_supports_mode`` — the levels refine the
    old matrix, they never move an engine in or out of it."""
    for mode in language_modes.LANGUAGE_MODE_CATALOG:
        for engine in AiModelFormat:
            level, _ = mode_capability(mode.id, engine)
            assert (level != "unsupported") is language_modes.engine_supports_mode(mode, engine)


# --- the receipt's degrade semantics -------------------------------------------


def test_a_degraded_level_marks_the_receipt() -> None:
    _, receipt = resolve_language("ml-en", AiModelFormat.FASTER_WHISPER, source="request")
    assert receipt.degraded is True
    assert receipt.reason == "gloss_translation_only"
    assert (receipt.language, receipt.streaming_english_gloss) == ("ml", True)


def test_an_unknown_mode_fails_open_to_engine_auto_detect() -> None:
    """Language is TUNING, never selection: a mode with no catalog meaning (an agent
    configured with one the catalog dropped) leaves the engine to its own LID, and
    says so on the receipt instead of failing the session."""
    resolved, receipt = resolve_language("xx", AiModelFormat.WHISPER_CPP, source="agent")
    assert (resolved.language, resolved.code_switching, resolved.streaming_english_gloss) == (
        None,
        False,
        False,
    )
    assert resolved.initial_prompt is None
    assert receipt.requested_mode == "xx"
    assert receipt.applied_mode == "auto"
    assert receipt.degraded is True
    assert receipt.reason == "engine_auto_detect"


def test_a_bcp47_request_is_normalized_before_resolution() -> None:
    resolved, receipt = resolve_language("en-US", AiModelFormat.WHISPER_CPP, source="request")
    assert resolved.language == "en"
    assert (receipt.requested_mode, receipt.applied_mode, receipt.degraded) == ("en", "en", False)


def test_fallback_engine_switch_marks_only_a_receipt_that_was_not_already_degraded() -> None:
    _, native = resolve_language("ml-en", AiModelFormat.SARVAM, source="request")
    marked = mark_fallback_engine_switch(native)
    assert (marked.degraded, marked.reason) == (True, "fallback_engine_switch")
    assert marked.engine == native.engine

    _, degraded = resolve_language("ml-en", AiModelFormat.WHISPER_CPP, source="request")
    assert mark_fallback_engine_switch(degraded).reason == "whisper_cpp_pair_unprimed"


# --- chain level + catalog ---------------------------------------------------------


def test_chain_level_is_the_primary_s_unless_the_primary_cannot_serve() -> None:
    assert (
        chain_effective_level("ml-en", [AiModelFormat.WHISPER_CPP, AiModelFormat.SARVAM])
        == "degraded"
    )
    assert chain_effective_level("ml", [AiModelFormat.NEMO, AiModelFormat.SARVAM]) == "native"
    assert chain_effective_level("ml", [AiModelFormat.NEMO]) == "unsupported"
    assert chain_effective_level("ml", []) == "unsupported"


def test_catalog_without_engines_is_unchanged() -> None:
    for entry in language_mode_catalog_payload():
        assert set(entry) == {
            "id",
            "label",
            "kind",
            "primaryLanguage",
            "secondaryLanguage",
            "supportedEngines",
        }


def test_catalog_with_a_chain_reports_levels_and_the_effective_level() -> None:
    payload = language_mode_catalog_payload([AiModelFormat.WHISPER_CPP, AiModelFormat.SARVAM])
    by_id = {entry["id"]: entry for entry in payload}
    assert by_id["ml-en"]["levels"] == {"WHISPER_CPP": "degraded", "SARVAM": "native"}
    assert by_id["ml-en"]["effective"] == "degraded"
    assert by_id["vi"]["levels"] == {"WHISPER_CPP": "native", "SARVAM": "unsupported"}
    assert by_id["vi"]["effective"] == "native"
    assert by_id["vi-en"]["levels"] == {"WHISPER_CPP": "degraded", "SARVAM": "unsupported"}
    assert by_id["vi-en"]["effective"] == "degraded"


# --- the route ---------------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    clear_runtime()
    set_session_manager(MagicMock())
    app = FastAPI()
    app.include_router(router)
    yield TestClient(app)
    clear_runtime()


def test_route_engines_query_returns_per_chain_levels(client: TestClient) -> None:
    resp = client.get("/internal/streaming/language-modes", params={"engines": "NEMO,SARVAM"})
    assert resp.status_code == 200
    ml = next(m for m in resp.json()["modes"] if m["id"] == "ml")
    assert ml["levels"] == {"NEMO": "unsupported", "SARVAM": "native"}
    assert ml["effective"] == "native"


def test_route_without_engines_keeps_the_old_shape(client: TestClient) -> None:
    resp = client.get("/internal/streaming/language-modes")
    assert resp.status_code == 200
    assert all("levels" not in m for m in resp.json()["modes"])


def test_route_rejects_an_unknown_engine_by_name(client: TestClient) -> None:
    resp = client.get(
        "/internal/streaming/language-modes", params={"engines": "WHISPER_CPP,TELEPATHY"}
    )
    assert resp.status_code == 422
    assert "TELEPATHY" in str(resp.json()["detail"])
