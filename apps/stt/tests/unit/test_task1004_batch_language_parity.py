"""TASK-1004 G-1/G-2 — batch resolves the language exactly as streaming does.

Batch used to read a mode engine-UNAWARE (``_language_from_mode``): the pair's
primary subtag plus ``code_switching=True`` on every engine, so a whisper.cpp
``ml-en`` job was PINNED to Malayalam (the very bias the unpinned pair exists to
avoid), Sarvam never got ``codemix``, and the Whisper gloss never applied. It also
could not carry the end user's selection at all: the gateway's only channel was the
dead positional ``code_switching``.

Now:

* the Dramatiq actor takes keyword-only ``language_mode`` / ``language_mode_source``
  (already-queued positional messages stay valid — the dead slot is kept, ignored);
* each chain's mode is resolved with ``resolve_language`` — the call the streaming
  loader makes — so for EVERY engine and every catalog mode the batch config and
  receipt equal the streaming ones (the table below);
* the receipt reaches the gateway on the completion callback (``languageResolution``).
"""

from __future__ import annotations

import copy
import importlib
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import dramatiq
import pytest

from stt.core.api_client.gateway import APIGatewayClient
from stt.core.initial_prompt import compose_prompt
from stt.models.base_loader import LoadedModel
from stt.pipeline import language_modes
from stt.pipeline.dto import AiModelFormat
from stt.pipeline.language_modes import LANGUAGE_MODE_CATALOG, LanguageModeUnsupportedError
from stt.pipeline.spec import (
    ResolvedAsrSpec,
    bundle_from_resolved,
    pipeline_spec_from_resolved,
)
from stt.streaming.session_manager import SessionManager
from stt.transcription.dto import TranscriptionResult
from stt.transcription.workers.transcribe_file import (
    _resolve_chain_language,
    _transcribe_file_async,
    transcribe_file,
)

# The MODULE (the package re-exports the actor under the same name).
worker = importlib.import_module("stt.transcription.workers.transcribe_file")


def _fixture() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


BASE_SPEC = _fixture()["platformDefault"]["expected"]
AGENT_PROMPT = BASE_SPEC["instruction"]["initialPrompt"]
_PROVIDERS = {
    AiModelFormat.SARVAM: "sarvam",
    AiModelFormat.AZURE_SPEECH: "azure-speech",
    AiModelFormat.AZURE_FOUNDRY: "azure-foundry",
    AiModelFormat.OPENAI: "openai",
}


@pytest.fixture(autouse=True)
def _prompts_as_shipped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(language_modes, "WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED", False)
    monkeypatch.setattr(language_modes, "WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED", False)


def _spec(
    primary: AiModelFormat = AiModelFormat.WHISPER_CPP,
    fallback: AiModelFormat = AiModelFormat.FASTER_WHISPER,
    mode: str | None = "ml-en",
) -> dict[str, Any]:
    spec = copy.deepcopy(BASE_SPEC)
    spec["models"]["asr"]["format"] = primary.value
    spec["models"]["asr"]["provider"] = _PROVIDERS.get(primary)
    spec["decoding"]["languageMode"] = mode
    for chain in (spec["fallback"]["spec"], *spec["fallback"]["chain"]):
        chain["models"]["asr"]["format"] = fallback.value
        chain["models"]["asr"]["provider"] = _PROVIDERS.get(fallback)
    return spec


# --- the streaming half, driven through the REAL session loader ------------------------


async def _streaming(spec: dict[str, Any], mode: str) -> tuple[tuple[Any, ...], str | None, Any]:
    mgr = MagicMock(spec=SessionManager)
    for name in (
        "_session_specs",
        "_session_language_modes",
        "_session_asr_formats",
        "_session_connections",
        "_session_pinned_models",
    ):
        setattr(mgr, name, {})
    mgr._pending_want_word_timestamps = False
    mgr._warm_and_pin_pipeline_models = AsyncMock(return_value=[])
    captured: dict[str, Any] = {}

    def _spy(asr_model: Any, inference_config: Any, initial_prompt: str | None = None) -> Any:
        captured["config"] = inference_config
        return AsyncMock()

    mgr._make_asr_callable = _spy
    bundle = SessionManager._register_resolved_spec(mgr, "s1", spec)
    config = await SessionManager._load_pipeline_config(mgr, bundle.runtime_key, session_id="s1")
    mgr._session_language_modes["s1"] = mode
    mgr._session_language_sources = {"s1": "consultation"}

    async def _load(*, model_ref: Any, task_type: Any, db_model_config: Any) -> LoadedModel:
        return LoadedModel(
            model_id="m",
            model_slug=db_model_config.slug,
            model=MagicMock(),
            format=db_model_config.format,
            device="cpu",
        )

    cache = MagicMock()
    cache.get_or_load_from_ref = AsyncMock(side_effect=_load)
    cache.pin = AsyncMock()
    with patch("stt.models.get_model_cache", return_value=cache):
        _run, prompt = await SessionManager._load_asr_pipeline(mgr, config, "s1")
    cfg = captured["config"]
    fields = (cfg.language, cfg.code_switching, cfg.streaming_english_gloss)
    return fields, prompt, mgr._pending_language_receipts.get("s1")


def _batch(spec: dict[str, Any], mode: str) -> tuple[tuple[Any, ...], str | None, Any]:
    bundle = bundle_from_resolved(spec)
    config, receipt = _resolve_chain_language(bundle, bundle.runtime_key, mode, "consultation")
    inf = config.spec.inference
    fields = (inf.language, inf.code_switching, inf.streaming_english_gloss)
    return fields, inf.initial_prompt_text, receipt


_TABLE = [(engine, mode.id) for engine in AiModelFormat for mode in LANGUAGE_MODE_CATALOG]


@pytest.mark.parametrize(("engine", "mode"), _TABLE, ids=[f"{e.value}-{m}" for e, m in _TABLE])
@pytest.mark.asyncio
async def test_batch_resolves_every_engine_and_mode_exactly_as_streaming(
    engine: AiModelFormat, mode: str
) -> None:
    spec = _spec(primary=engine)
    level, _ = language_modes.mode_capability(mode, engine)
    if level == "unsupported":
        with pytest.raises(LanguageModeUnsupportedError):
            await _streaming(spec, mode)
        with pytest.raises(LanguageModeUnsupportedError):
            _batch(spec, mode)
        return

    s_fields, s_prompt, s_receipt = await _streaming(spec, mode)
    b_fields, b_prompt, b_receipt = _batch(spec, mode)

    assert b_fields == s_fields
    assert b_prompt == s_prompt
    assert b_receipt == s_receipt
    assert b_receipt.engine == engine.value
    assert b_receipt.provider == _PROVIDERS.get(engine)


@pytest.mark.asyncio
async def test_parity_holds_with_the_pair_priming_prompt_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(language_modes, "WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED", True)
    spec = _spec(primary=AiModelFormat.WHISPER_CPP)

    s_fields, s_prompt, s_receipt = await _streaming(spec, "ml-en")
    b_fields, b_prompt, b_receipt = _batch(spec, "ml-en")

    priming = language_modes.build_code_switch_prompt("ml", "en")
    assert s_prompt == b_prompt == compose_prompt(priming, AGENT_PROMPT)
    assert b_fields == s_fields
    assert b_receipt == s_receipt
    assert (b_receipt.primed, b_receipt.degraded) == (True, False)


# --- the shared mapping is engine-aware now ---------------------------------------------


@pytest.mark.parametrize(
    ("engine", "expected"),
    [
        (AiModelFormat.WHISPER_CPP, (None, False, False)),
        (AiModelFormat.FASTER_WHISPER, ("ml", False, True)),
        (AiModelFormat.SARVAM, ("ml", True, False)),
        (AiModelFormat.AZURE_SPEECH, ("ml", True, False)),
    ],
)
def test_the_chain_mapping_resolves_the_agent_mode_for_its_own_engine(
    engine: AiModelFormat, expected: tuple[Any, ...]
) -> None:
    """G-2: the whisper.cpp pair is no longer PINNED to its primary subtag."""
    spec = ResolvedAsrSpec.model_validate(_spec(primary=engine))
    pipeline, _ = pipeline_spec_from_resolved(spec)
    inf = pipeline.inference
    assert (inf.language, inf.code_switching, inf.streaming_english_gloss) == expected


def test_a_chain_that_cannot_serve_the_agent_mode_still_maps() -> None:
    """The mapping is eager over EVERY chain, so it must not raise for a fallback that
    cannot serve the agent's mode — the session/job resolution decides that."""
    spec = ResolvedAsrSpec.model_validate(_spec(primary=AiModelFormat.NEMO, mode="ml"))
    pipeline, _ = pipeline_spec_from_resolved(spec)
    assert pipeline.inference.language is None


# --- the Dramatiq actor --------------------------------------------------------------------

# The positional args an already-queued message carries (the gateway's shape before
# this ticket): ..., language, code_switching, audio_bucket_name, user_id
_QUEUED_POSITIONAL = (
    "job-1",
    "tenant-1",
    "p-primary",
    "s3://hope-audio/x.wav",
    "consult-1",
    None,
    "en",
    True,
    "hope-audio",
    "user-1",
)


def _invoke_actor(*args: Any, **kwargs: Any) -> dict[str, Any]:
    with (
        patch(
            "stt.transcription.workers.transcribe_file._transcribe_file_async",
            new_callable=MagicMock,
        ) as inner,
        patch("stt.transcription.workers.transcribe_file.run_on_worker_loop"),
        patch("stt.transcription.workers.transcribe_file.refresh_job_concurrency_limit"),
    ):
        transcribe_file.fn(*args, **kwargs)
    return inner.call_args.kwargs


def test_an_already_queued_positional_message_still_binds() -> None:
    forwarded = _invoke_actor(*_QUEUED_POSITIONAL)
    assert forwarded["language"] == "en"
    assert forwarded["audio_bucket_name"] == "hope-audio"
    assert forwarded["user_id"] == "user-1"
    # The dead slot is accepted and dropped — it never meant anything.
    assert "code_switching" not in forwarded
    assert forwarded["language_mode"] is None
    assert forwarded["language_mode_source"] is None


def test_the_new_kwargs_are_forwarded() -> None:
    forwarded = _invoke_actor(
        *_QUEUED_POSITIONAL, language_mode="ml-en", language_mode_source="consultation"
    )
    assert forwarded["language_mode"] == "ml-en"
    assert forwarded["language_mode_source"] == "consultation"


def test_language_mode_is_keyword_only() -> None:
    """Appending it positionally would shift on any future insertion upstream — the
    same reason `storage` and `resolved_spec` ride as kwargs."""
    with pytest.raises(TypeError):
        _invoke_actor(*_QUEUED_POSITIONAL, None, None, None, None, "ml-en")


# --- the worker end to end (external boundaries mocked) -----------------------------------


def _result() -> TranscriptionResult:
    return TranscriptionResult(
        text="ok",
        language="en",
        language_probability=0.9,
        duration_seconds=3.0,
        processing_time_seconds=0.5,
        word_timestamps=[],
        sentence_timestamps=[],
        segments=[],
        metadata={},
    )


async def _run_worker(spec: dict[str, Any], **kwargs: Any) -> tuple[AsyncMock, AsyncMock]:
    api = AsyncMock()
    api.get_job_status = AsyncMock(return_value="PROCESSING")
    api.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-1"})
    blob = AsyncMock()
    blob.download_audio = AsyncMock(return_value=b"audio")
    blob.upload_transcript = AsyncMock(return_value="s3://t/transcript.json")
    blob.upload_batch_metadata = AsyncMock(return_value="s3://t/metadata.json")
    blob._resolver = MagicMock()
    batch = AsyncMock()
    batch.transcribe = AsyncMock(return_value=_result())
    eff = MagicMock()
    eff.get_provider_overrides = AsyncMock(return_value={})
    with (
        patch.object(worker, "get_api_client", return_value=api),
        patch.object(worker, "get_blob_service", return_value=blob),
        patch.object(worker, "get_batch_service", return_value=batch),
        patch.object(worker, "get_effective_config_client", return_value=eff),
        patch.object(worker, "TranscriptionEventPublisher", return_value=AsyncMock()),
        patch.object(worker, "refresh_job_concurrency_limit", AsyncMock()),
    ):
        await _transcribe_file_async(
            job_id="j-1",
            tenant_id="t-1",
            pipeline_id=spec["runtimeKey"],
            audio_uri="s3://a.wav",
            resolved_spec=spec,
            **kwargs,
        )
    return api, batch


@pytest.mark.asyncio
async def test_the_job_applies_the_requested_mode_and_reports_the_receipt() -> None:
    api, batch = await _run_worker(
        _spec(primary=AiModelFormat.SARVAM),
        language_mode="ml-en",
        language_mode_source="consultation",
    )
    inf = batch.transcribe.await_args.kwargs["pipeline_config"].spec.inference
    assert (inf.language, inf.code_switching, inf.streaming_english_gloss) == ("ml", True, False)
    receipt = api.complete_job.await_args.kwargs["language_resolution"]
    assert receipt == {
        "requested_mode": "ml-en",
        "source": "consultation",
        "applied_mode": "ml-en",
        "engine": "SARVAM",
        "provider": "sarvam",
        "params": {
            "language": "ml",
            "code_switching": True,
            "streaming_english_gloss": False,
            "primed": False,
        },
        "degraded": False,
        "reason": None,
    }


@pytest.mark.parametrize(
    ("kwargs", "spec_mode", "expected"),
    [
        ({"language_mode": "en"}, "ml-en", ("en", "request")),
        ({"language": "en-US"}, "ml-en", ("en", "request")),
        ({"language_mode": "en", "language_mode_source": "agent"}, "ml-en", ("en", "agent")),
        ({}, "ml-en", ("ml-en", "agent")),
        ({}, None, ("auto", "default")),
    ],
)
@pytest.mark.asyncio
async def test_the_job_source_follows_the_same_rules_as_a_live_session(
    kwargs: dict[str, Any], spec_mode: str | None, expected: tuple[str, str]
) -> None:
    api, _ = await _run_worker(_spec(mode=spec_mode), **kwargs)
    receipt = api.complete_job.await_args.kwargs["language_resolution"]
    assert (receipt["requested_mode"], receipt["source"]) == expected


@pytest.mark.asyncio
async def test_a_raw_non_catalog_language_keeps_its_override_and_no_receipt() -> None:
    api, batch = await _run_worker(_spec(), language="fr")
    assert batch.transcribe.await_args.kwargs["pipeline_config"].spec.inference.language == "fr"
    assert api.complete_job.await_args.kwargs.get("language_resolution") is None


@pytest.mark.asyncio
async def test_a_primary_that_cannot_serve_the_mode_runs_on_the_fallback_visibly() -> None:
    spec = _spec(primary=AiModelFormat.NEMO, fallback=AiModelFormat.SARVAM)
    api, batch = await _run_worker(spec, language_mode="ml")
    config = batch.transcribe.await_args.kwargs["pipeline_config"]
    assert config.id == spec["fallback"]["chain"][0]["runtimeKey"]
    receipt = api.complete_job.await_args.kwargs["language_resolution"]
    assert receipt["engine"] == "SARVAM"
    assert (receipt["degraded"], receipt["reason"]) == (True, "fallback_engine_switch")


@pytest.mark.asyncio
async def test_no_chain_serving_the_mode_fails_the_job_by_code_without_a_retry() -> None:
    spec = _spec(primary=AiModelFormat.NEMO, fallback=AiModelFormat.NEMO)
    api = AsyncMock()
    with (
        patch.object(worker, "get_api_client", return_value=api),
        patch.object(worker, "get_blob_service", return_value=AsyncMock()),
        patch.object(worker, "get_batch_service", return_value=AsyncMock()),
        patch.object(worker, "TranscriptionEventPublisher", return_value=AsyncMock()),
        patch.object(worker, "refresh_job_concurrency_limit", AsyncMock()),
        pytest.raises(dramatiq.middleware.SkipMessage),
    ):
        await _transcribe_file_async(
            job_id="j-1",
            tenant_id="t-1",
            pipeline_id=spec["runtimeKey"],
            audio_uri="s3://a.wav",
            resolved_spec=spec,
            language_mode="ml",
        )
    assert api.fail_job.await_args.kwargs["error_code"] == "LANGUAGE_MODE_UNSUPPORTED"


# --- the gateway client ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_complete_job_sends_the_receipt_as_a_typed_sibling_field() -> None:
    client = APIGatewayClient.__new__(APIGatewayClient)
    client._request = AsyncMock(return_value={})
    client._tenant_headers = MagicMock(return_value={})
    receipt = {"requested_mode": "en"}

    await client.complete_job("job-1", result_text="hi", language_resolution=receipt)
    assert client._request.await_args.kwargs["json"]["languageResolution"] == receipt

    await client.complete_job("job-1", result_text="hi")
    assert "languageResolution" not in client._request.await_args.kwargs["json"]
