"""TASK-1006 — apps/stt selects ASR through the gateway-resolved ``ResolvedAsrSpec`` ONLY.

The pre-agent pipeline path is gone: no ``PipelineConfigReader``, no optional
Postgres layer, no ``pipeline_id`` / ``fallback_pipeline_id`` on the session-create
path. A session or a batch job without a ``resolved_spec`` is refused with a
NAMED error. The Dramatiq actor keeps its positional ARITY, so a message queued
before this change still binds; the two slots the ids used to occupy are ignored.
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
import inspect
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import dramatiq
import pytest
import structlog.testing
from fastapi import FastAPI
from fastapi.testclient import TestClient

from stt.streaming._runtime import clear_runtime, set_session_manager
from stt.streaming.api.routes import router as streaming_router
from stt.streaming.api.schemas import CreateStreamingSessionRequest, StreamingSessionResponse

_SRC = Path(__file__).resolve().parents[2] / "src" / "stt"
# The package re-exports the ACTOR under the module's own name, so attribute access
# (`import stt.transcription.workers.transcribe_file as m`) yields the actor.
_WORKER = "stt.transcription.workers.transcribe_file"


def _fixture_spec() -> dict[str, Any]:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))["platformDefault"]["expected"]
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


SPEC = _fixture_spec()


# ---------------------------------------------------------------------------
# The wire: no pipeline ids in, none out; the spec is required
# ---------------------------------------------------------------------------


def test_session_create_request_carries_no_pipeline_ids_and_requires_the_spec() -> None:
    fields = CreateStreamingSessionRequest.model_fields
    assert "pipeline_id" not in fields
    assert "fallback_pipeline_id" not in fields
    assert fields["resolved_spec"].is_required()


def test_session_response_carries_no_pipeline_id_but_keeps_active_engine() -> None:
    fields = StreamingSessionResponse.model_fields
    assert "pipeline_id" not in fields
    assert "active_engine" in fields


@pytest.fixture
def streaming_client() -> Any:
    clear_runtime()
    mgr = AsyncMock()
    mgr.capacity_guard = MagicMock(max_streams=10, active_count=1)
    mgr.get_switch_controller = MagicMock(return_value=None)
    mgr.get_voice_profile_seeded = MagicMock(return_value=False)
    mgr.get_language_resolution = MagicMock(return_value=None)
    session = MagicMock()
    session.session_id = "s-1006"
    mgr.create_session = AsyncMock(return_value=session)
    set_session_manager(mgr)
    app = FastAPI()
    app.include_router(streaming_router)
    yield TestClient(app), mgr
    clear_runtime()


def test_http_create_without_a_resolved_spec_is_refused_naming_the_field(
    streaming_client: Any,
) -> None:
    client, mgr = streaming_client
    resp = client.post(
        "/internal/streaming/sessions",
        json={"session_id": "s-1006", "tenant_id": "t-1", "pipeline_id": "legacy-pipeline"},
    )
    assert resp.status_code == 422
    missing = [err["loc"][-1] for err in resp.json()["detail"] if err["type"] == "missing"]
    assert missing == ["resolved_spec"]
    mgr.create_session.assert_not_awaited()


def test_http_create_from_an_older_gateway_ignores_its_stale_pipeline_ids(
    streaming_client: Any,
) -> None:
    """Merge-order safety: an older gateway still sends both ids beside the spec."""
    client, mgr = streaming_client
    resp = client.post(
        "/internal/streaming/sessions",
        json={
            "session_id": "s-1006",
            "tenant_id": "t-1",
            "pipeline_id": "legacy-pipeline",
            "fallback_pipeline_id": "legacy-fallback",
            "resolved_spec": SPEC,
        },
    )
    assert resp.status_code == 201, resp.text
    kwargs = mgr.create_session.await_args.kwargs
    assert "pipeline_id" not in kwargs
    assert "fallback_pipeline_id" not in kwargs
    assert kwargs["resolved_spec"] == SPEC
    body = resp.json()
    assert "pipeline_id" not in body
    assert body["active_engine"] == "primary"


# ---------------------------------------------------------------------------
# The session manager: the spec is the only selector
# ---------------------------------------------------------------------------


def test_session_manager_create_takes_no_pipeline_ids() -> None:
    from stt.streaming.session_manager import SessionManager

    params = inspect.signature(SessionManager.create_session).parameters
    assert "pipeline_id" not in params
    assert "fallback_pipeline_id" not in params
    assert params["resolved_spec"].default is inspect.Parameter.empty


@pytest.mark.asyncio
async def test_session_manager_refuses_a_create_without_a_spec_before_taking_a_slot() -> None:
    from stt.core.exceptions import ResolvedSpecRequiredError
    from stt.streaming.session_manager import SessionManager

    mgr = MagicMock(spec=SessionManager)
    mgr._capacity_guard = MagicMock()
    mgr._capacity_guard.try_acquire = AsyncMock(return_value=True)

    with pytest.raises(ResolvedSpecRequiredError) as excinfo:
        await SessionManager.create_session(
            mgr, session_id="s-1006", tenant_id="t-1", resolved_spec=None
        )
    assert excinfo.value.error_code == "RESOLVED_SPEC_REQUIRED"
    mgr._capacity_guard.try_acquire.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_runtime_key_no_spec_carries_is_a_named_error_not_a_database_read() -> None:
    from stt.core.exceptions import ResolvedSpecRequiredError
    from stt.streaming.session_manager import SessionManager

    mgr = MagicMock(spec=SessionManager)
    mgr._session_specs = {}
    with pytest.raises(ResolvedSpecRequiredError):
        await SessionManager._load_pipeline_config(mgr, "legacy-pipeline", tenant_id="t-1")


@pytest.mark.asyncio
async def test_recovery_skips_a_session_persisted_without_a_spec() -> None:
    """A session opened on the removed pipeline path cannot be rebuilt: skipped, never
    guessed, and it takes no capacity slot."""
    from stt.streaming.schemas import SessionMetadata, SessionStatus
    from stt.streaming.session_manager import SessionManager

    meta = SessionMetadata(
        session_id="legacy-1",
        tenant_id="t-1",
        pipeline_id="legacy-pipeline",
        status=SessionStatus.ACTIVE,
        worker_id="w-1",
    )
    mgr = MagicMock(spec=SessionManager)
    mgr._session_specs = {}
    mgr._worker_id = "w-1"
    mgr._redis = AsyncMock()
    mgr._redis.scan = AsyncMock(return_value=(0, [b"stt:session:legacy-1"]))
    mgr._redis.hgetall = AsyncMock(return_value=meta.to_redis_dict())
    mgr._capacity_guard = MagicMock()
    mgr._capacity_guard.try_acquire = AsyncMock(return_value=True)
    mgr._load_pipeline_config = AsyncMock()

    with structlog.testing.capture_logs() as logs:
        await SessionManager._recover_sessions(mgr)

    mgr._capacity_guard.try_acquire.assert_not_awaited()
    mgr._load_pipeline_config.assert_not_awaited()
    skipped = [entry for entry in logs if entry.get("session_id") == "legacy-1"]
    assert [entry.get("error_code") for entry in skipped] == ["RESOLVED_SPEC_REQUIRED"]


# ---------------------------------------------------------------------------
# The batch actor: arity preserved, both id slots ignored, spec required
# ---------------------------------------------------------------------------

_POSITIONAL = [
    "job_id",
    "tenant_id",
    "_ignored_pipeline_id",
    "audio_uri",
    "consultation_id",
    "media_id",
    "language",
    "_ignored_code_switching",
    "audio_bucket_name",
    "user_id",
    "storage",
    "_ignored_fallback_pipeline_id",
    "resolved_spec",
    "voice_profiles",
]


def test_actor_keeps_its_positional_arity_with_the_id_slots_renamed_ignored() -> None:
    from stt.transcription.workers.transcribe_file import transcribe_file

    params = inspect.signature(transcribe_file.fn).parameters.values()
    positional = [p.name for p in params if p.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD]
    keyword_only = [p.name for p in params if p.kind is inspect.Parameter.KEYWORD_ONLY]
    assert positional == _POSITIONAL
    # `fallback_pipeline_id` survives as an ignored KEYWORD: the pre-agent gateway
    # sent it by keyword, so that is the name a queued legacy message binds to.
    assert keyword_only == ["language_mode", "language_mode_source", "fallback_pipeline_id"]


@pytest.mark.parametrize(
    ("pipeline_slot", "fallback_slot", "legacy_kwargs"),
    [
        ("legacy-pipeline", "legacy-fallback", {}),
        ("legacy-pipeline", None, {"fallback_pipeline_id": "legacy-fallback"}),
        (None, None, {}),
    ],
    ids=["queued-before-TASK-1006", "legacy-fallback-kwarg", "sent-after-TASK-1006"],
)
def test_actor_binds_an_old_and_a_new_message_and_drops_the_ids(
    pipeline_slot: str | None, fallback_slot: str | None, legacy_kwargs: dict[str, Any]
) -> None:
    module = importlib.import_module(_WORKER)

    message = [
        "j-1006",
        "t-1",
        pipeline_slot,
        "s3://bucket/a.wav",
        "c-1",
        None,
        None,
        None,
        None,
        None,
        None,
        fallback_slot,
        SPEC,
        None,
    ]
    fake_async = MagicMock(return_value="coro")
    with (
        patch.object(module, "_transcribe_file_async", fake_async),
        patch.object(module, "run_on_worker_loop") as run,
    ):
        module.transcribe_file.fn(*message, language_mode="en", **legacy_kwargs)

    run.assert_called_once_with("coro")
    kwargs = fake_async.call_args.kwargs
    assert "pipeline_id" not in kwargs
    assert "fallback_pipeline_id" not in kwargs
    assert kwargs["resolved_spec"] == SPEC
    assert kwargs["audio_uri"] == "s3://bucket/a.wav"
    assert kwargs["consultation_id"] == "c-1"
    assert kwargs["language_mode"] == "en"


@pytest.mark.asyncio
async def test_a_job_without_a_resolved_spec_fails_with_a_named_error() -> None:
    module = importlib.import_module(_WORKER)

    api = AsyncMock()
    api.get_job_status = AsyncMock(return_value="PROCESSING")
    blob = AsyncMock()
    blob._resolver = MagicMock()
    batch = AsyncMock()
    publisher = AsyncMock()
    with (
        patch.object(module, "get_api_client", return_value=api),
        patch.object(module, "get_blob_service", return_value=blob),
        patch.object(module, "get_batch_service", return_value=batch),
        patch.object(module, "TranscriptionEventPublisher", return_value=publisher),
        pytest.raises(dramatiq.middleware.SkipMessage),
    ):
        await module._transcribe_file_async(
            job_id="j-1006", tenant_id="t-1", audio_uri="s3://bucket/a.wav", resolved_spec=None
        )

    api.fail_job.assert_awaited_once()
    assert api.fail_job.await_args.kwargs["error_code"] == "RESOLVED_SPEC_REQUIRED"
    publisher.publish_error.assert_awaited_once()
    assert publisher.publish_error.await_args.args[1] == "RESOLVED_SPEC_REQUIRED"
    blob.download_audio.assert_not_awaited()
    batch.transcribe.assert_not_awaited()


# ---------------------------------------------------------------------------
# Nothing left to import: the reader and the optional Postgres layer are gone
# ---------------------------------------------------------------------------

_FORBIDDEN_IMPORTS = ("sqlalchemy", "asyncpg", "stt.pipeline.config_reader", "stt.core.database")


@pytest.mark.parametrize("module", ["stt.pipeline.config_reader", "stt.core.database"])
def test_the_removed_modules_no_longer_exist(module: str) -> None:
    assert importlib.util.find_spec(module) is None


def _absolute_imports(path: Path) -> list[str]:
    package = ".".join(path.relative_to(_SRC.parent).with_suffix("").parts[:-1])
    names: list[str] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package.split(".")[: len(package.split(".")) - node.level + 1]
                module = ".".join([*base, node.module] if node.module else base)
            else:
                module = node.module or ""
            names.append(module)
            names.extend(f"{module}.{alias.name}" for alias in node.names)
    return names


def test_no_stt_module_imports_the_reader_or_a_database_driver() -> None:
    offenders = sorted(
        f"{path.relative_to(_SRC.parent)}: {name}"
        for path in _SRC.rglob("*.py")
        for name in _absolute_imports(path)
        if any(name == bad or name.startswith(f"{bad}.") for bad in _FORBIDDEN_IMPORTS)
    )
    assert offenders == []


def test_settings_declare_no_database_connection() -> None:
    from stt.core.config.settings import Settings

    leftovers = [name for name in Settings.model_fields if name.startswith("database_")]
    assert leftovers == []


def test_the_pipeline_only_http_routes_are_gone() -> None:
    from stt.main import create_app

    paths = set(create_app().openapi()["paths"])
    assert "/api/v1/transcribe" not in paths
    assert "/api/v1/pipelines/validate" not in paths
    assert "/internal/pipelines/loaded" not in paths
    # The agent path is untouched.
    assert "/internal/streaming/sessions" in paths
