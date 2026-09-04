"""lane B — guardrail's config plane resolves tenant-first,
distinguishes absence from failure, and presents the shared internal token.

Three defects, one theme: a value that a tenant is entitled to express was being
answered with the platform's, and the substitution was silent.

* **F-05** — the `AiRuntimeProfile` read and the `AiModel` slug tie-break pinned
  SYSTEM unconditionally, so a tenant with its own connection still ran on the
  platform's tuning and the platform's catalog row. The mandated order is
  request tenant → SYSTEM, widening on ABSENCE only, exactly as the
  `AiTaskDefault` selection already resolves.
* **F-08** — a DB error was mapped to `{}` and negative-cached, and `resolve()`
  reads `{}` as "no tenant opinion" and widens. Because a tenant may only
  TIGHTEN relative to SYSTEM, a tenant that chose a stricter safety posture was
  downgraded to the platform floor for a full TTL window with nothing raised.
* **F-06** — the effective-config pull and the self-registration call bypassed
  `peer_service_token()`, so under owner decision D-D (one shared
  `INTERNAL_ACCESS_TOKEN`, legacy per-service token empty) both sent an empty
  token and 401'd.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from guardrail.core.tenant_config import (
    KEY_MAX_TOKENS,
    KEY_TEMPERATURE,
    KEY_TIMEOUT_S,
    SYSTEM_TENANT_ID,
    TASK_KEY_GUARDRAIL_VALIDATE,
    TenantConfigResolver,
    TenantConfigUnavailableError,
)

TENANT_A = "11111111-1111-1111-1111-111111111111"


# ---------------------------------------------------------------------------
# A scripted session fake. Since TASK-862 `_load_from_db` issues ONE query —
# the `AiRoutingPolicy ⋈ AiModel` select; the tuning that used to come from a
# second `AiRuntimeProfile` read now rides on the winning row's `configJson`
# (`config_json` below). Trailing script entries are simply never consumed.
# ---------------------------------------------------------------------------


class _Result:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def all(self) -> list[Any]:
        return list(self._rows)

    def first(self) -> Any | None:
        return self._rows[0] if self._rows else None


class _ScriptedSession:
    """Answers each `execute` with the next scripted row set, in order."""

    def __init__(self, script: list[list[Any]]) -> None:
        self._script = script
        self.executed = 0

    async def __aenter__(self) -> _ScriptedSession:
        return self

    async def __aexit__(self, *exc_info: object) -> bool:
        return False

    async def execute(self, stmt: object) -> _Result:
        rows = self._script[self.executed] if self.executed < len(self._script) else []
        self.executed += 1
        return _Result(rows)


def _selection_row(
    default_tenant: str,
    model_tenant: str | None,
    provider: str | None = "lm-studio",
    source_uri: str | None = "the-model",
    config_json: dict[str, Any] | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        default_tenant_id=default_tenant,
        default_resource_status="ENABLED",
        default_enabled=True,
        config_json=config_json,
        model_tenant_id=model_tenant,
        provider=provider,
        source_uri=source_uri,
        meta_data=None,
        local_path=None,
        checksum=None,
        source=None,
        source_revision=None,
    )


def _scripted_resolver(script: list[list[Any]]) -> TenantConfigResolver:
    session = _ScriptedSession(script)
    return TenantConfigResolver(session_factory=lambda: session, cache_ttl_s=60)


# ---------------------------------------------------------------------------
# F-05a (TASK-862 form) — tuning rides on the WINNING row's configJson: the
# tenant's own elected row wins, SYSTEM applies only on absence, and widening
# is row-level (a tenant row never borrows SYSTEM's other knobs).
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tuning_prefers_the_tenants_own_elected_row() -> None:
    """A tenant that elected its own configuration tunes it: its configJson
    wins over the platform row's for the same task key."""
    resolver = _scripted_resolver(
        [
            [
                _selection_row(
                    SYSTEM_TENANT_ID,
                    SYSTEM_TENANT_ID,
                    config_json={"temperature": 0.9, "maxTokens": 1024, "timeoutS": 30},
                ),
                _selection_row(
                    TENANT_A,
                    SYSTEM_TENANT_ID,
                    config_json={"temperature": 0.1, "maxTokens": 4096, "timeoutS": 90},
                ),
            ]
        ]
    )

    cfg = await resolver.resolve(TENANT_A)

    assert cfg.temperature == 0.1
    assert cfg.max_tokens == 4096
    assert cfg.timeout_s == 90


@pytest.mark.asyncio
async def test_tuning_widens_to_system_only_on_absence() -> None:
    """No tenant row = no opinion, so the platform default (and its tuning) applies."""
    resolver = _scripted_resolver(
        [
            [
                _selection_row(
                    SYSTEM_TENANT_ID,
                    SYSTEM_TENANT_ID,
                    config_json={"temperature": 0.9, "maxTokens": 1024, "timeoutS": 30},
                )
            ]
        ]
    )

    cfg = await resolver.resolve(TENANT_A)

    assert cfg.temperature == 0.9
    assert cfg.max_tokens == 1024
    assert cfg.timeout_s == 30


@pytest.mark.asyncio
async def test_tuning_widening_is_row_level_not_field_level() -> None:
    """A tenant row that sets only `temperature` does not borrow SYSTEM's
    `maxTokens` — the winning row is the whole opinion."""
    resolver = _scripted_resolver(
        [
            [
                _selection_row(
                    SYSTEM_TENANT_ID,
                    SYSTEM_TENANT_ID,
                    config_json={"temperature": 0.9, "maxTokens": 1024, "timeoutS": 30},
                ),
                _selection_row(TENANT_A, SYSTEM_TENANT_ID, config_json={"temperature": 0.1}),
            ]
        ]
    )

    cfg = await resolver.resolve(TENANT_A)

    assert cfg.temperature == 0.1
    assert cfg.max_tokens is None
    assert cfg.timeout_s is None


@pytest.mark.asyncio
async def test_tuning_keys_are_absent_when_the_row_carries_none() -> None:
    resolver = _scripted_resolver([[_selection_row(TENANT_A, SYSTEM_TENANT_ID)]])

    keys = await resolver._load_from_db(TENANT_A, TASK_KEY_GUARDRAIL_VALIDATE)

    assert KEY_TEMPERATURE not in keys
    assert KEY_MAX_TOKENS not in keys
    assert KEY_TIMEOUT_S not in keys


@pytest.mark.asyncio
async def test_a_switched_off_tenant_row_is_a_veto_not_an_absence() -> None:
    """`enabled = false` on the tenant's elected row fails closed exactly like a
    DISABLED resourceStatus — never a fold-through to SYSTEM."""
    from guardrail.core.tenant_config import TenantSelectionVetoedError

    off = _selection_row(TENANT_A, SYSTEM_TENANT_ID)
    off.default_enabled = False
    resolver = _scripted_resolver([[_selection_row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID), off]])

    with pytest.raises(TenantSelectionVetoedError):
        await resolver.resolve(TENANT_A)


# ---------------------------------------------------------------------------
# F-05b — AiModel slug tie-break: the tenant's own catalog row wins.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_model_catalog_prefers_the_tenants_own_row_over_the_system_copy() -> None:
    """Both tiers carry the slug → the tenant's own catalog row wins, matching
    the tenant-first order `_row_rank` already applies to the selection."""
    resolver = _scripted_resolver(
        [
            [
                _selection_row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, source_uri="system-source-uri"),
                _selection_row(SYSTEM_TENANT_ID, TENANT_A, source_uri="tenant-source-uri"),
            ],
            [],
        ]
    )

    cfg = await resolver.resolve(TENANT_A)

    assert cfg.model == "tenant-source-uri"


@pytest.mark.asyncio
async def test_model_catalog_widens_to_system_when_the_tenant_has_no_copy() -> None:
    resolver = _scripted_resolver(
        [
            [_selection_row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, source_uri="system-source-uri")],
            [],
        ]
    )

    cfg = await resolver.resolve(TENANT_A)

    assert cfg.model == "system-source-uri"


@pytest.mark.asyncio
async def test_a_joined_row_still_beats_an_unjoined_one() -> None:
    """`model_tenant_id is None` is the outer join missing entirely; it must lose
    to any real catalog row rather than tie with the SYSTEM one."""
    resolver = _scripted_resolver(
        [
            [
                _selection_row(SYSTEM_TENANT_ID, None, provider=None, source_uri=None),
                _selection_row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, source_uri="system-source-uri"),
            ],
            [],
        ]
    )

    cfg = await resolver.resolve(TENANT_A)

    assert cfg.model == "system-source-uri"


@pytest.mark.asyncio
async def test_by_slug_lookup_prefers_the_tenants_own_catalog_row() -> None:
    """The `slug::` pseudo task key ranks the same way — a tenant's own weight
    row is the tenant's opinion, not a copy to be overruled by the platform's."""
    resolver = _scripted_resolver(
        [
            [
                SimpleNamespace(
                    model_tenant_id=SYSTEM_TENANT_ID,
                    provider="hf",
                    source_uri="system-weights",
                    local_path=None,
                    checksum=None,
                    source=None,
                    source_revision=None,
                ),
                SimpleNamespace(
                    model_tenant_id=TENANT_A,
                    provider="hf",
                    source_uri="tenant-weights",
                    local_path=None,
                    checksum=None,
                    source=None,
                    source_revision=None,
                ),
            ]
        ]
    )

    cfg = await resolver.resolve(TENANT_A, "slug::minicheck")

    assert cfg.model == "tenant-weights"


# ---------------------------------------------------------------------------
# F-08 — absence and failure are different answers.
# ---------------------------------------------------------------------------


class _ExplodingSession:
    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    async def __aenter__(self) -> _ExplodingSession:
        return self

    async def __aexit__(self, *exc_info: object) -> bool:
        return False

    async def execute(self, stmt: object) -> Any:
        raise self._exc


@pytest.mark.asyncio
async def test_a_db_error_raises_instead_of_widening_to_system() -> None:
    """The tenant's row could not be READ. Answering with SYSTEM's would serve
    the platform floor to a tenant that may have chosen something stricter."""
    resolver = TenantConfigResolver(
        session_factory=lambda: _ExplodingSession(RuntimeError("connection refused")),
        cache_ttl_s=60,
    )

    with pytest.raises(TenantConfigUnavailableError) as exc_info:
        await resolver.resolve(TENANT_A)

    assert exc_info.value.tenant_id == TENANT_A
    assert exc_info.value.task_key == TASK_KEY_GUARDRAIL_VALIDATE


@pytest.mark.asyncio
async def test_a_db_error_is_not_cached_as_absence() -> None:
    """A failure must not outlive the condition that caused it: the next resolve
    after recovery answers from the DB, not from a cached empty result."""
    sessions: list[Any] = [
        _ExplodingSession(RuntimeError("connection refused")),
        _ScriptedSession([[_selection_row(TENANT_A, SYSTEM_TENANT_ID)], []]),
    ]

    resolver = TenantConfigResolver(session_factory=lambda: sessions.pop(0), cache_ttl_s=60)

    with pytest.raises(TenantConfigUnavailableError):
        await resolver.resolve(TENANT_A)

    cfg = await resolver.resolve(TENANT_A)

    assert cfg.model == "the-model"


# ---------------------------------------------------------------------------
# F-06 — both outbound call sites present the shared internal token.
# ---------------------------------------------------------------------------


SHARED_TOKEN = "shared-internal-access-token"


@pytest.mark.asyncio
async def test_boot_call_sites_present_the_shared_internal_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Owner decision D-D configuration — `INTERNAL_ACCESS_TOKEN` set, the legacy
    per-service token empty. Both boot-time outbound calls must carry the shared
    token; `get_secret_value()` on the legacy field sends "" and 401s."""
    import guardrail.core.effective_config as effective_config_module
    import guardrail.main as main_module

    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", SHARED_TOKEN)
    monkeypatch.setenv("GUARDRAIL_SERVICE_TOKEN", "")
    # No DB engine, no job processor, no pubsub — this test is about two tokens.
    monkeypatch.setenv("GUARDRAIL_DB_CONFIG_ENABLED", "false")

    seen: dict[str, str] = {}

    class _CapturingConfigClient:
        def __init__(self, *, base_url: str, token: str) -> None:
            seen["effective_config"] = token

    def _capturing_registration(*, service_token: str, **kwargs: Any) -> None:
        seen["registration"] = service_token
        return None

    monkeypatch.setattr(effective_config_module, "EffectiveConfigClient", _CapturingConfigClient)
    monkeypatch.setattr(main_module, "start_registration", _capturing_registration)

    app = main_module.create_app()

    class _NoopJobProcessor:
        async def stop(self) -> None:
            return None

    app.state.job_processor = _NoopJobProcessor()

    async with app.router.lifespan_context(app):
        pass

    assert seen["effective_config"] == SHARED_TOKEN
    assert seen["registration"] == SHARED_TOKEN


# ---------------------------------------------------------------------------
# F-08, dependency layer — an unreadable config is a declared 503, not a 500.
# ---------------------------------------------------------------------------


class _UnavailableResolver:
    async def resolve(self, tenant_id: str, task_key: str = TASK_KEY_GUARDRAIL_VALIDATE):
        raise TenantConfigUnavailableError(
            tenant_id=tenant_id, task_key=task_key, cause="connection refused"
        )


def _request_state() -> SimpleNamespace:
    from guardrail.core.config import Settings

    settings = Settings()
    return SimpleNamespace(
        settings=settings,
        http_client=object(),
        tenant_config_resolver=_UnavailableResolver(),
    )


@pytest.mark.asyncio
async def test_unreadable_config_is_a_503_at_the_judge_dependency() -> None:
    from fastapi import HTTPException

    from guardrail.core.dependencies import get_resolved_guardian_provider

    state = _request_state()
    request = SimpleNamespace(app=SimpleNamespace(state=state), headers={"X-Tenant-Id": TENANT_A})

    with pytest.raises(HTTPException) as exc_info:
        await get_resolved_guardian_provider(request)  # type: ignore[arg-type]

    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_unreadable_config_is_a_selection_failure_for_the_aux_lanes() -> None:
    from guardrail.core.dependencies import (
        SelectionUnavailableError,
        _resolve_selection,
    )

    with pytest.raises(SelectionUnavailableError):
        await _resolve_selection(_request_state(), TENANT_A, "guardrail.pii")


# ---------------------------------------------------------------------------
# F-03 / F-14 — the operator-facing files describe what the service reads.
# ---------------------------------------------------------------------------

# Prefixes with no field and no reader anywhere in guardrail. `GUARDRAIL_V2_PROVIDER`
# never existed at all — it survived purely in comments and in a `.env.prod` that
# told operators to set it. The engine prefixes went with the engines
# (`06-python-services.md`: "GONE … do not reintroduce one"); GLiNER went to
# apps/nlp with its weights.
PHANTOM_ENV_PREFIXES = (
    "GUARDRAIL_V2_PROVIDER",
    "GUARDRAIL_GLINER_",
    "GUARDRAIL_VLLM_",
    "GUARDRAIL_LLAMA_CPP_",
    "GUARDRAIL_OLLAMA_",
    "GUARDRAIL_OPENAI_COMPAT_",
    "GUARDRAIL_AZURE_",
    "GUARDRAIL_BEDROCK_",
)

# Declared-but-never-read fields, deleted with their `.env.sample` /
# docker-compose lines. A settable knob nothing reads is not a spare voice, it is
# an instruction to the operator that does nothing.
DELETED_DEAD_VARS = (
    "GUARDRAIL_V2_HTTPX_MAX_CONNECTIONS",
    "GUARDRAIL_V2_HTTPX_MAX_KEEPALIVE",
    "GUARDRAIL_V2_MODEL_CACHE_TTL_S",
    "GUARDRAIL_V2_MODEL_CACHE_MAX_MODELS",
    "GUARDRAIL_REDIS_TASK_TTL_SECONDS",
    "GUARDRAIL_REDIS_STREAM_MAX_LEN",
    "GUARDRAIL_REDIS_CACHE_TTL_SECONDS",
    "GUARDRAIL_V2_QUEUE_MAX_WAIT_S",
    "GUARDRAIL_V2_QUEUE_MAX_RETRIES",
    "GUARDRAIL_V2_QUEUE_RETRY_BACKOFF_S",
    "GUARDRAIL_V2_QUEUE_BATCH_SIZE",
)


def _operator_facing_files() -> list[Any]:
    from pathlib import Path

    app_root = Path(__file__).resolve().parents[3]
    # `.env.prod` is here because it is the file that actually regressed. It is a
    # tracked ops reference (see the test below), so the honesty checks that
    # cover `.env.sample` have to cover it too — that, not its absence, is the
    # property worth pinning.
    return [
        app_root / ".env.sample",
        app_root / "docker-compose.yml",
        app_root / ".env.prod",
    ]


def test_no_operator_facing_file_sets_a_phantom_engine_var() -> None:
    for path in _operator_facing_files():
        body = path.read_text()
        for prefix in PHANTOM_ENV_PREFIXES:
            for line in body.splitlines():
                stripped = line.strip()
                if stripped.startswith("#"):
                    continue  # prose explaining the absence is the point
                assert prefix not in stripped, f"{path.name} sets {prefix}"


def test_the_prod_reference_exists_and_does_not_resurrect_the_phantom_plane() -> None:
    """The prod reference must exist and must not lie — and those are two claims.

    This replaces an `assert not (...).exists()`. That assertion was a PROXY:
    the file deleted was entirely the engine plane /736 had
    already removed, so "no file" and "no lie" were the same thing at the time.
    They are not the same thing in general, and they came apart the moment the
    file was rewritten as an honest one.

    Absence is the wrong invariant to pin, because `apps/*/.env.prod` is a
    governed artifact rather than an accident: `.gitignore` un-ignores it
    explicitly, `.gitleaks.toml` sanctions it as a committed template, and
    `scripts/env-sync.mts` (`READER_CHECKED_FILES`) gates all seven of them so a
    key with no reader fails `pnpm env:sync --check`. Nothing LOADS it —
    production is configured from host env only — but plenty CONSUMES it.

    So honesty is what gets pinned: `_operator_facing_files()` now includes
    `.env.prod`, aiming the two checks above at it.
    """
    from pathlib import Path

    app_root = Path(__file__).resolve().parents[3]
    assert (app_root / ".env.prod").exists()


def test_no_operator_facing_file_declares_a_var_with_no_reader() -> None:
    for path in _operator_facing_files():
        body = path.read_text()
        for var in DELETED_DEAD_VARS:
            assert var not in body, f"{path.name} declares dead var {var}"


def test_the_settings_classes_no_longer_carry_the_dead_fields() -> None:
    from guardrail.core.config import QueueConfig, RedisConfig, Settings

    for field in ("httpx_max_connections", "httpx_max_keepalive"):
        assert field not in Settings.model_fields
    for field in ("model_cache_ttl_s", "model_cache_max_models"):
        assert field not in Settings.model_fields
    for field in ("task_ttl_seconds", "stream_max_len", "cache_ttl_seconds"):
        assert field not in RedisConfig.model_fields
    for field in ("max_wait_s", "max_retries", "retry_backoff_s", "batch_size"):
        assert field not in QueueConfig.model_fields
