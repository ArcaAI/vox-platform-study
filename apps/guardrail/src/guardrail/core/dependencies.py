"""FastAPI dependency injection for Guardrail service."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any, cast

from fastapi import Request

from guardrail.core.logging import get_logger

logger = get_logger(__name__)

if TYPE_CHECKING:
    import httpx
    import redis.asyncio as aioredis

    from guardrail.core.config import GroundednessConfig, Settings
    from guardrail.services.external_nlp_client import NlpGuardClient as NlpGuardClientT
    from guardrail.services.external_text_client import TextJudgeClient
    from guardrail.services.groundedness_nli import GroundednessNliVerifier
    from guardrail.services.job_processor import JobProcessor
    from guardrail.services.safety_analyzer import SafetyAnalyzer

    # Guardrail hosts no engine: the "guardian" is a delegation to `apps/text`.
    GuardianLike = TextJudgeClient


# ---------------------------------------------------------------------------
# `X-Tenant-Id` is MANDATORY on tenant-scoped work (owner directive 2026-08-16).
#
# Guardrail decisions must be ATTRIBUTABLE. Every read site here used to be a bare
# `request.headers.get("X-Tenant-Id")` with no None-check, so an absent header resolved
# the SYSTEM row — and because a tenant may only TIGHTEN relative to SYSTEM, that
# silently served the LOOSEST admissible posture to a tenant that had chosen a stricter
# one, with no error anywhere. An absent header is a defect in the CALLER.
#
# 428 (not 400) is the platform-wide spelling for a missing request PRECONDITION: the
# gateway's `RequiresIfMatch` uses it, and `apps/nlp` + `apps/text` already return it for
# exactly this condition. One status code, one meaning.
#
# The DECLARED `tenantless:<reason>` marker is the sanctioned exception — genuinely
# tenant-less internal work (a platform job queue, a control-plane pull) says so instead
# of arriving indistinguishable from a header dropped in transit. That distinction is
# precisely what makes ABSENT safe to refuse.
# ---------------------------------------------------------------------------


def require_tenant_id(request: Request) -> str:
    """Return the declared tenant (or `tenantless:` marker); refuse absence with 428.

    Fails CLOSED and EARLY — before any model selection, credential resolution or engine
    call — so a mis-attributed request never resolves config from the wrong tier.
    """
    from fastapi import HTTPException

    raw = (request.headers.get("X-Tenant-Id") or "").strip()
    if not raw:
        logger.error(
            "guardrail.tenant_header.missing",
            detail=(
                "internal request carried no X-Tenant-Id; refusing rather than resolving "
                "the SYSTEM floor and silently loosening a tenant's safety posture. This "
                "is a CALLER defect."
            ),
        )
        raise HTTPException(
            status_code=428,
            detail=(
                "X-Tenant-Id is required on requests carrying tenant-scoped work. "
                "Declare 'tenantless:<reason>' for genuinely tenant-less internal work."
            ),
        )
    return raw


def get_settings(request: Request) -> Settings:
    """Retrieve settings from app.state (set during lifespan)."""
    return cast("Settings", request.app.state.settings)


def get_http_client(request: Request) -> httpx.AsyncClient:
    """Retrieve shared httpx AsyncClient from app.state."""
    return cast("httpx.AsyncClient", request.app.state.http_client)


def get_redis(request: Request) -> aioredis.Redis:
    """Retrieve shared Redis client from app.state."""
    return cast("aioredis.Redis", request.app.state.redis)


async def get_resolved_guardian_provider(request: Request) -> GuardianLike:
    """Resolve the delegated guardian for this request's tenant.

    Reads ``AiRoutingPolicy`` ⋈ ``AiModel`` for ``guardrail.validate`` tenant-first
    (SYSTEM as the platform fallback) and returns a client bound to that
    selection, pointed at ``apps/text``'s judge lane.

    **Fail-closed at every step and with no env engine left to fall back to**
    ( deleted them): an absent X-Tenant-Id is 428, a DISABLED
    tenant row is a 503 veto, and a missing selection is a 503. The
    db_config_enabled=False escape hatch is GONE ( lane D) — without a
    DB there is no model to name, and inventing one is precisely the hardcoded
    selection this ticket removed. The unreachable-resolver case it used to
    short-circuit is answered by the very next check, with the same 503.
    """
    from fastapi import HTTPException

    # 428 before anything else: attribution is required whether or not DB config is on.
    tenant_id = require_tenant_id(request)

    settings = request.app.state.settings

    resolver = getattr(request.app.state, "tenant_config_resolver", None)
    if resolver is None:
        raise HTTPException(
            status_code=503,
            detail="AiRoutingPolicy for 'guardrail.validate' is unavailable (resolver not wired).",
        )

    from guardrail.core.tenant_config import (
        TenantConfigUnavailableError,
        TenantSelectionVetoedError,
        build_judge_client,
    )

    try:
        tenant_cfg = await resolver.resolve(tenant_id)
    except TenantConfigUnavailableError as exc:
        # The tenant's rows could not be READ, which is not the same as absent —
        # answering with SYSTEM's would serve the platform safety FLOOR to a
        # tenant that may have chosen something stricter.
        raise HTTPException(
            status_code=503,
            detail=(
                f"guardrail.validate config for tenant {exc.tenant_id!r} could not be "
                "read — not falling through to the SYSTEM default."
            ),
        ) from exc
    except TenantSelectionVetoedError as exc:
        # Tenant-first resolution: a DISABLED tenant row is
        # a VETO, never a silent fold-through to the SYSTEM row.
        raise HTTPException(
            status_code=503,
            detail=(
                f"guardrail.validate selection is DISABLED for tenant {exc.tenant_id!r} "
                "(veto) — not falling through to the SYSTEM default."
            ),
        ) from exc

    # Fail closed when DB selection is missing (no env fallback).
    if not tenant_cfg.provider or not tenant_cfg.model:
        raise HTTPException(
            status_code=503,
            detail="AiRoutingPolicy for 'guardrail.validate' is missing. Run db:seed.",
        )

    from guardrail.core.errors import GuardrailUndeterminedError

    try:
        return build_judge_client(  # type: ignore[no-any-return]
            settings,
            tenant_cfg,
            request.app.state.http_client,
            tenant_id,
            provider_overrides=await _provider_overrides(request),
            breaker=_breaker(request.app.state, "text"),
            judge_timeout_s=await resolve_judge_timeout_s(request.app.state),
        )
    except GuardrailUndeterminedError as exc:
        # A fail-CLOSED policy key (the criteria that decides the verdict) is
        # unresolved. Same 503 shape as a missing selection: the check cannot run,
        # so it certainly cannot pass.
        raise HTTPException(status_code=503, detail=exc.as_detail()) from exc


async def _provider_overrides(request: Request) -> dict[str, Any] | None:
    """The connection the caller forwarded for the judge, passed through VERBATIM.

    Guardrail never decrypts, stores or logs it: the gateway resolved it, the
    caller forwarded it, and `text` hands it to the adapter.

    TWO sources, in order, and the second is the one that made this slot real:

    1. ``request.state.provider_overrides`` — the documented carrier, for a
       middleware or an in-process caller that has already resolved one.
    2. the request BODY (TASK-890). Nothing ever set (1), so every judge call
       posted without a connection and `apps/text` — which holds none of its own —
       answered 503 `PROVIDER_CREDENTIALS_MISSING` on every guardrail-enabled
       generation. Guardrail is a PEER service with no gateway in front of it, so
       the caller's body is the only channel a connection has into this service,
       and the judge is built by a DEPENDENCY, which is solved before the handler
       ever sees the parsed model. Reading it here is therefore not a shortcut
       around the model — it is the only point in the request that is both after
       the body and before the client.

    Safe by construction rather than by luck: FastAPI reads and CACHES the body
    (`Request._body`) before it solves dependencies, so this is the already-read
    bytes, not a second read of a consumed stream. A route with no body (the GET
    health check) raises on decode and answers ``None``.

    Absent ⇒ absent, deliberately: `core/tenant_config._judge_connection` then
    resolves the engine's own endpoint for a keyless provider, and a cloud
    provider fails closed.
    """
    overrides = getattr(getattr(request, "state", None), "provider_overrides", None)
    if isinstance(overrides, dict) and overrides:
        return overrides

    reader = getattr(request, "json", None)
    if not callable(reader):
        return None
    try:
        payload = await reader()
    except Exception:  # noqa: BLE001 — no body, or not JSON: there is nothing to forward
        return None
    if not isinstance(payload, dict):
        return None
    forwarded = payload.get("provider_overrides")
    return forwarded if isinstance(forwarded, dict) and forwarded else None


def _breaker(app_state: Any, peer: str) -> Any:
    """The process-wide breaker for a peer (``None`` in tests that never build one)."""
    breakers = getattr(app_state, "circuit_breakers", None)
    return breakers.get(peer) if isinstance(breakers, dict) else None


async def resolve_judge_timeout_s(app_state: Any) -> float:
    """The platform per-call budget for a delegated peer call (TASK-878).

    `guardrail.judge.timeoutSeconds`, `global-kv` / `globalOnly` /
    `open-to-default`, served on the pull route. It replaced
    `JudgePolicy.timeout_s`. Since TASK-1047 (D7) it budgets the JUDGE only — the
    apps/nlp clients take the policy `nlpDeadlineSeconds` instead.

    NEVER raises. A config-plane outage must not take a safety route down, so
    every failure keeps the declared default — the same posture
    `_groundedness_gate` states for the gate's geometry.
    """
    from guardrail.core.effective_config import DEFAULT_JUDGE_TIMEOUT_S

    client = getattr(app_state, "effective_config_client", None)
    if client is None:
        return DEFAULT_JUDGE_TIMEOUT_S
    try:
        snapshot = await client.get()
        return float(snapshot.judge_timeout_s())
    except Exception as exc:  # noqa: BLE001 — a config refresh never breaks the judge
        logger.warning(
            "guardrail.judge.timeout_refresh_failed",
            error_type=type(exc).__name__,
        )
        return DEFAULT_JUDGE_TIMEOUT_S


def get_gate(request: Request, name: str = "request") -> Any:
    """The named admission gate, or ``None`` when the app was built without one."""
    gates = getattr(request.app.state, "admission_gates", None)
    return gates.get(name) if isinstance(gates, dict) else None


@asynccontextmanager
async def admitted(request: Request, gate_name: str = "request") -> AsyncIterator[None]:
    """Hold an admission slot for the request, or refuse it with a DECLARED 503.

    Saturation is answered with `503 + Retry-After`, the same status an
    undetermined verdict uses — a rejection means nothing was checked, so nothing
    is reported safe. It is emphatically NOT a fail-open, and `apps/text` already
    treats 503 as retryable rather than as a content rejection.
    """
    from fastapi import HTTPException

    from guardrail.core.concurrency import AdmissionRejected

    gate = get_gate(request, gate_name)
    if gate is None:
        yield
        return
    try:
        async with gate.admit():
            yield
    except AdmissionRejected as exc:
        logger.warning(
            "guardrail.admission.rejected", gate=exc.gate, waited_s=round(exc.waited_s, 3)
        )
        raise HTTPException(
            status_code=503,
            detail=(
                "guardrail is at capacity and refused to queue this check further — "
                "nothing was analysed, so nothing is reported safe"
            ),
            headers={"Retry-After": str(int(exc.retry_after_s))},
        ) from exc


def get_job_processor(request: Request) -> JobProcessor:
    """Retrieve job processor from app.state."""
    return cast("JobProcessor", request.app.state.job_processor)


# ---------------------------------------------------------------------------
# Delegated aux models ( Phases 3 & 6).
#
# Guardrail holds ZERO resident model weights. The GLiNER runtime and the
# MiniCheck GGUF scorer moved to `apps/nlp` together with their model cache and
# their weight staging; what stays here is POLICY plus a bounded peer client.
#
# Two selections, both `AiRoutingPolicy` ⋈ `AiModel`, both tenant-first with
# SYSTEM as the platform fallback, both FAIL-CLOSED:
#
#   `guardrail.safety` — the LLM-safety moderation model (six tasks)
#   `guardrail.injection` — OPTIONAL: answers `jailbreak_detection` in place of the
#       safety model when a row resolves (TASK-1049 R1); absent = unchanged
#   `guardrail.pii` — the PII span model (English only)
#   `guardrail.groundedness` — the NLI entailment model
#
# The label TAXONOMY travels with the selection: it is `AiModel._metadata`'s
# `labelTaxonomy`, resolved through the very same two-tier cascade. That is
# what makes it configuration rather than a Python literal — a platform admin
# edits the SYSTEM row, a tenant may carry its own, and an unresolved taxonomy
# fails closed instead of substituting a built-in list.
# ---------------------------------------------------------------------------


class SelectionUnavailableError(RuntimeError):
    """A required registry selection is missing/vetoed — callers map this to 503."""


# Kept as the public name the endpoints import; nothing loads a model any more.
ModelUnavailableError = SelectionUnavailableError


async def _resolve_selection(app_state: Any, tenant_id: str | None, task_key: str) -> Any:
    """Resolve one task key's model identity + taxonomy, tenant-first, fail-closed.

    There is NO env fallback and no `db_config_enabled` escape hatch (the latter
    deleted in lane D): guardrail names no model in code, so without the
    registry there is nothing to name, and the resolver check below already says
    so with the same error.
    """
    resolver = getattr(app_state, "tenant_config_resolver", None)
    if resolver is None:
        raise SelectionUnavailableError(
            f"AiRoutingPolicy for {task_key!r} is unavailable (resolver not wired)."
        )

    from guardrail.core.tenant_config import (
        TenantConfigUnavailableError,
        TenantSelectionVetoedError,
    )

    try:
        cfg = await resolver.resolve(tenant_id, task_key)
    except TenantConfigUnavailableError as exc:
        # A failed READ is not "no tenant opinion" — fail closed
        # rather than widen to SYSTEM.
        raise SelectionUnavailableError(
            f"{task_key!r} config for tenant {exc.tenant_id!r} could not be read — "
            "not falling through to the SYSTEM default."
        ) from exc
    except TenantSelectionVetoedError as exc:
        # A DISABLED tenant row is a VETO (Phase 1) — never a silent fold-through
        # to the SYSTEM row.
        raise SelectionUnavailableError(
            f"{task_key!r} selection is DISABLED for tenant {exc.tenant_id!r} (veto) — "
            "not falling through to the SYSTEM default."
        ) from exc

    if not cfg.model:
        raise SelectionUnavailableError(
            f"AiRoutingPolicy for {task_key!r} is missing. Run db:seed."
        )
    return cfg


def _nlp_client(
    app_state: Any,
    tenant_id: str,
    cfg: Any,
    *,
    labels: list[str] | None = None,
    threshold: float = 0.5,
    deadline_s: float,
) -> NlpGuardClientT:
    """Build a tenant-bound `apps/nlp` client for one resolved selection.

    ``deadline_s`` is the policy ``nlpDeadlineSeconds`` (TASK-1047 D7) — the WHOLE
    call's budget, every attempt included. It replaced the judge's
    ``guardrail.judge.timeoutSeconds`` here: an NLP window and an 8B-model
    judgement have nothing in common but the word "peer". A row's own
    ``configJson`` timeout may only SHORTEN it, never extend it.
    """
    from guardrail.services.external_nlp_client import NlpGuardClient

    settings = cast("Settings", app_state.settings)
    return NlpGuardClient(
        base_url=settings.nlp_url,
        service_token=settings.peer_service_token(settings.service_token),
        http_client=app_state.http_client,
        tenant_id=tenant_id,
        model_id=cfg.model,
        labels=labels,
        threshold=threshold,
        # The selected NLI build's calibration, forwarded so `apps/nlp` can bind
        # its adapter and score. Absent, nlp refuses and the groundedness gate
        # degrades to `unverified` — safe, but a gate that has silently stopped
        # working, which is why this travels with the selection rather than
        # being configured independently on either side.
        calibration=getattr(cfg, "entailment", None),
        # TASK-1050 / TASK-1049 Track R: the row's serving library, so apps/nlp binds
        # the loader the platform admin chose (e.g. `seq-cls`), never a guessed one.
        **_library_kwarg(NlpGuardClient, getattr(cfg, "library_name", None)),
        timeout_s=(
            min(float(cfg.timeout_s), float(deadline_s)) if cfg.timeout_s else float(deadline_s)
        ),
        breaker=_breaker(app_state, "nlp"),
    )


def _library_kwarg(client_cls: Any, library_name: str | None) -> dict[str, Any]:
    """``{"library_name": …}`` when the client accepts it (lane W2a1 adds the parameter)."""
    import inspect

    try:
        accepted = "library_name" in inspect.signature(client_cls.__init__).parameters
    except (TypeError, ValueError):
        accepted = False
    return {"library_name": library_name} if accepted else {}


def _row_policy(cfg: Any) -> Any:
    """The selected row's governed policy blob as a `GuardrailPolicy` (`{}` = no opinion)."""
    from guardrail.core.policy import GuardrailPolicy

    blob = getattr(cfg, "policy", None)
    if isinstance(blob, GuardrailPolicy):
        return blob
    return GuardrailPolicy.from_blob(
        blob if isinstance(blob, dict) else None,
        source_tenant_id=getattr(cfg, "source_tenant_id", None),
    )


def _taxonomy(cfg: Any) -> dict[str, Any]:
    """The registry row's declared label taxonomy (`{}` when it has no opinion)."""
    taxonomy = getattr(cfg, "label_taxonomy", None)
    return taxonomy if isinstance(taxonomy, dict) else {}


async def build_safety_analyzer(app_state: Any, tenant_id: str) -> SafetyAnalyzer:
    """Resolve both safety selections + their taxonomies and bind the analyzer.

    Fail-closed on every step: an unresolved selection or an unresolved taxonomy
    raises rather than substituting a built-in label list.
    """
    from guardrail.core.tenant_config import (
        TASK_KEY_GUARDRAIL_PII,
        TASK_KEY_GUARDRAIL_SAFETY,
    )
    from guardrail.services.safety_analyzer import SafetyAnalyzer, SafetyPolicy

    safety_cfg = await _resolve_selection(app_state, tenant_id, TASK_KEY_GUARDRAIL_SAFETY)
    pii_cfg = await _resolve_selection(app_state, tenant_id, TASK_KEY_GUARDRAIL_PII)

    safety_taxonomy = _taxonomy(safety_cfg)
    pii_taxonomy = _taxonomy(pii_cfg)

    tasks = safety_taxonomy.get("tasks")
    if not isinstance(tasks, dict) or not tasks:
        raise SelectionUnavailableError(
            "the guardrail.safety model row declares no `labelTaxonomy.tasks` — the "
            "moderation taxonomy is configuration and has no code default (fail-closed)."
        )
    pii_labels = pii_taxonomy.get("labels")
    if not isinstance(pii_labels, list) or not pii_labels:
        raise SelectionUnavailableError(
            "the guardrail.pii model row declares no `labelTaxonomy.labels` — the PII "
            "taxonomy is configuration and has no code default (fail-closed)."
        )

    benign = safety_taxonomy.get("benignLabels")
    policy_kwargs: dict[str, Any] = {
        "tasks": {str(k): dict(v) for k, v in tasks.items() if isinstance(v, dict)},
        "pii_labels": [str(label) for label in pii_labels],
    }
    if isinstance(benign, list) and benign:
        policy_kwargs["benign_labels"] = frozenset(str(b).lower() for b in benign)
    for source, key in (
        (pii_taxonomy, "pii_threshold"),
        (safety_taxonomy, "classification_threshold"),
    ):
        value = source.get("threshold")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            policy_kwargs[key] = float(value)

    policy = SafetyPolicy(**policy_kwargs)
    deadline_s = _row_policy(safety_cfg).nlp_deadline_seconds
    return SafetyAnalyzer(
        policy,
        injection=await _resolve_injection_route(app_state, tenant_id),
        safety_client=_nlp_client(
            app_state,
            tenant_id,
            safety_cfg,
            threshold=policy.classification_threshold,
            deadline_s=deadline_s,
        ),
        pii_client=_nlp_client(
            app_state,
            tenant_id,
            pii_cfg,
            labels=policy.pii_labels,
            threshold=policy.pii_threshold,
            deadline_s=_row_policy(pii_cfg).nlp_deadline_seconds,
        ),
    )


async def _resolve_injection_route(app_state: Any, tenant_id: str) -> Any:
    """The `guardrail.injection` route for ``tenant_id`` (TASK-1049 R1), or ``None``.

    ``None`` ONLY when no row resolves at either tier — `jailbreak_detection` then stays
    on the `guardrail.safety` model, byte-identical to before the key existed. A row
    that resolved but cannot answer is a route marked ``unavailable`` — a tenant VETO,
    an unreadable row, or a row whose `labelTaxonomy.tasks` declares no injection task —
    so the task is UNDETERMINED (→ `unverified`). It never folds back to GLiGuard: that
    would serve a tenant the model it vetoed, or hide a broken row behind a working one.
    NEVER raises — the other checks of the screen do not depend on this row.
    """
    from guardrail.core.tenant_config import (
        TASK_KEY_GUARDRAIL_INJECTION,
        TenantConfigUnavailableError,
        TenantSelectionVetoedError,
    )
    from guardrail.services.safety_analyzer import (
        _DEFAULT_BENIGN,
        INJECTION_TASKS,
        InjectionRoute,
        SafetyPolicy,
    )

    resolver = getattr(app_state, "tenant_config_resolver", None)
    if resolver is None:
        return None
    try:
        cfg = await resolver.resolve(tenant_id, TASK_KEY_GUARDRAIL_INJECTION)
    except TenantSelectionVetoedError:
        logger.info("guardrail.injection.vetoed", tenant_id=tenant_id)
        return InjectionRoute(unavailable="vetoed")
    except TenantConfigUnavailableError as exc:
        logger.warning("guardrail.injection.unreadable", tenant_id=tenant_id, error=str(exc))
        return InjectionRoute(unavailable="unreadable")
    if cfg is None or not getattr(cfg, "model", None):
        return None

    taxonomy = _taxonomy(cfg)
    declared = taxonomy.get("tasks")
    tasks = {
        str(name): dict(spec)
        for name, spec in (declared.items() if isinstance(declared, dict) else ())
        if name in INJECTION_TASKS and isinstance(spec, dict) and spec.get("labels")
    }
    if not tasks:
        logger.warning(
            "guardrail.injection.no_task_spec",
            tenant_id=tenant_id,
            source_tenant_id=getattr(cfg, "source_tenant_id", None),
        )
        return InjectionRoute(unavailable="no_task_spec")
    benign = taxonomy.get("benignLabels")
    threshold = taxonomy.get("threshold")
    return InjectionRoute(
        tasks=tasks,
        benign_labels=(
            frozenset(str(b).lower() for b in benign)
            if isinstance(benign, list) and benign
            else _DEFAULT_BENIGN
        ),
        client=_nlp_client(
            app_state,
            tenant_id,
            cfg,
            threshold=(
                float(threshold)
                if isinstance(threshold, (int, float)) and not isinstance(threshold, bool)
                else SafetyPolicy.classification_threshold
            ),
            deadline_s=_row_policy(cfg).nlp_deadline_seconds,
        ),
    )


async def build_pii_span_client(app_state: Any, tenant_id: str) -> NlpGuardClientT:
    """The tenant-bound `apps/nlp` PII span client for `guardrail.pii.spans` (TASK-1035).

    Same selection path and fail-closed posture as `build_safety_analyzer`: an
    unresolved selection or a row with no `labelTaxonomy.labels` raises, because a
    span list from an unconfigured model would read as "no PII found".
    """
    from guardrail.core.tenant_config import TASK_KEY_GUARDRAIL_PII_SPANS
    from guardrail.services.safety_analyzer import SafetyPolicy

    cfg = await _resolve_selection(app_state, tenant_id, TASK_KEY_GUARDRAIL_PII_SPANS)
    taxonomy = _taxonomy(cfg)
    labels = taxonomy.get("labels")
    if not isinstance(labels, list) or not labels:
        raise SelectionUnavailableError(
            "the guardrail.pii.spans model row declares no `labelTaxonomy.labels` — the PII "
            "taxonomy is configuration and has no code default (fail-closed)."
        )
    threshold = taxonomy.get("threshold")
    return _nlp_client(
        app_state,
        tenant_id,
        cfg,
        labels=[str(label) for label in labels],
        threshold=(
            float(threshold)
            if isinstance(threshold, (int, float)) and not isinstance(threshold, bool)
            else SafetyPolicy.pii_threshold
        ),
        deadline_s=_row_policy(cfg).nlp_deadline_seconds,
    )


async def _resolve_availability(app_state: Any, tenant_id: str) -> Any:
    """Resolve WHICH screening policies apply to ``tenant_id`` (TASK-886).

    Falls back to the FULL declared set — never an empty one — when the resolver
    is not wired or the read fails. That is deliberately UNLIKE `_resolve_selection`
    above, which raises: an unresolved model SELECTION means there is nothing to
    run at all, whereas an unresolved AVAILABILITY has a strictest answer
    available in code (`PLATFORM_DEFAULT_AVAILABILITY`). Screening more than the
    tenant selected is the safe direction; screening less is not, and 503-ing a
    request whose gate could have run is worse than both.

    The fallback is LOGGED, because "every check ran" and "we could not read
    which checks to run" must be distinguishable after the fact.
    """
    from guardrail.core.availability import PLATFORM_DEFAULT_AVAILABILITY

    resolver = getattr(app_state, "tenant_config_resolver", None)
    if resolver is None:
        return PLATFORM_DEFAULT_AVAILABILITY
    try:
        return await resolver.resolve_availability(tenant_id)
    except Exception as exc:  # noqa: BLE001 — see the docstring: strictest set, logged
        logger.warning(
            "guardrail.availability.unavailable",
            tenant_id=tenant_id,
            error=type(exc).__name__,
        )
        return PLATFORM_DEFAULT_AVAILABILITY


#: `(task key, source tenant, key)` already logged by :func:`_log_retired_keys` in this process.
_RETIRED_KEYS_LOGGED: set[tuple[str, str, str]] = set()


def _log_retired_keys(policy: Any, task_key: str) -> None:
    """Log — ONCE per row and key — a RETIRED policy key a stored row still carries.

    The key is ignored (`core/policy.RETIRED_KEYS`): never read, never hashed. A row keeps it
    only until its reseed, so this is information for the operator, never an error.
    """
    for key in getattr(policy, "retired_keys_present", ()) or ():
        marker = (task_key, str(getattr(policy, "source_tenant_id", None)), key)
        if marker in _RETIRED_KEYS_LOGGED:
            continue
        _RETIRED_KEYS_LOGGED.add(marker)
        logger.info(
            "guardrail.policy.retired_key_ignored",
            key=key,
            task_key=task_key,
            source_tenant_id=getattr(policy, "source_tenant_id", None),
        )


async def build_screener(app_state: Any, tenant_id: str) -> Any:
    """Build the bidirectional screener for one tenant.

    Reuses `build_safety_analyzer` verbatim — one selection path, one taxonomy,
    one fail-closed posture — and layers the screening policy (containment size
    bound, PII-leak score floor) resolved through the SAME two-tier cascade.

    TASK-886 adds the AVAILABILITY set on the same two tiers. Both screens
    (`/guardrail/screen/inbound` and `/guardrail/screen/outbound`) are built
    HERE, so honouring the selection on both is structural rather than two
    call sites remembering to do it.
    """
    from guardrail.core.availability import JUDGE_IDS
    from guardrail.core.policy import GuardrailPolicy
    from guardrail.core.tenant_config import TASK_KEY_GUARDRAIL_SAFETY
    from guardrail.services.screening import Screener

    analyzer = await build_safety_analyzer(app_state, tenant_id)
    safety_cfg = await _resolve_selection(app_state, tenant_id, TASK_KEY_GUARDRAIL_SAFETY)
    raw_policy = getattr(safety_cfg, "policy", None)
    policy = GuardrailPolicy.from_blob(
        raw_policy,
        source_tenant_id=getattr(safety_cfg, "source_tenant_id", None),
    )
    _log_retired_keys(policy, TASK_KEY_GUARDRAIL_SAFETY)
    geometry = window_geometry_of(policy)
    availability = await _resolve_availability(app_state, tenant_id)
    # TASK-1050: a judge runner only when a judge lane is ON for this tenant — the
    # four lanes ship OFF (OD-6), so a default deploy makes no extra judge call.
    judge_runner = (
        await _build_judge_runner(app_state, tenant_id)
        if any(availability.is_enabled(lane) for lane in JUDGE_IDS)
        else None
    )
    return Screener(
        analyzer=analyzer,
        tenant_id=tenant_id,
        policy_source_tenant_id=policy.source_tenant_id,
        max_untrusted_chars=policy.max_untrusted_chars,
        pii_leak_min_score=policy.pii_leak_min_score,
        availability=availability,
        window_geometry=geometry,
        window_runner=await build_window_runner(app_state, tenant_id, policy, geometry),
        judge_runner=judge_runner,
        judge_geometry=_judge_geometry(app_state, policy),
        # Bands are read through `GuardrailPolicy.judge_band` (fail-closed) by the screener.
        screen_policy=policy,
        medical_skip=policy.medical_judge_config_regions,
        policy_version=await _policy_version_or_unavailable(app_state, tenant_id),
    )


def _judge_geometry(app_state: Any, policy: Any) -> Any:
    """The judge window — the SAME geometry the medical route judges with, so the
    inbound judges ride the same windows (and the same window cache)."""
    from guardrail.core.config import JudgePolicy
    from guardrail.core.policy_version import judge_window_chars
    from guardrail.services.windowing import WindowGeometry

    settings = getattr(app_state, "settings", None)
    judge = getattr(settings, "judge", None) or JudgePolicy()
    try:
        from guardrail.services.judge_runner import judge_geometry
    except ImportError:
        pass
    else:
        return judge_geometry(policy, judge.max_input_chars)
    _size, overlap = policy.screen_window_geometry
    size = judge_window_chars(policy, judge.max_input_chars)
    return WindowGeometry(
        size=size,
        overlap=min(overlap, max(0, size - 1)),
        concurrency=policy.screen_window_concurrency,
    )


async def _build_judge_runner(app_state: Any, tenant_id: str) -> Any:
    """The per-tenant judge runner (`services/judge_runner.py`), or ``None``.

    NEVER raises: an unbuildable runner leaves the enabled judge lanes UNDETERMINED,
    which degrades to `unverified` (README §9.8.1) — never a pass and never a 503.
    """
    try:
        from guardrail.services.judge_runner import build_judge_runner_for_app
    except ImportError as exc:
        logger.warning("guardrail.judge_runner.unavailable", error_type=type(exc).__name__)
        return None
    try:
        # Wired from app.state (http client, breakers, judge timeout, window cache, policy
        # version, the process-wide single-flight) — the same runner the medical route
        # builds, so the two routes share calls. The screen body carries no
        # `provider_overrides`: a keyless engine resolves its own endpoint; a CLOUD judge
        # needs the caller to forward one (open question for lane W2c).
        return await build_judge_runner_for_app(app_state, tenant_id)
    except Exception as exc:  # noqa: BLE001 — see the docstring
        logger.warning(
            "guardrail.judge_runner.build_failed",
            tenant_id=tenant_id,
            error_type=type(exc).__name__,
        )
        return None


async def _policy_version_or_unavailable(app_state: Any, tenant_id: str) -> str:
    """The tenant's policy version for notices and records; `unavailable` on failure."""
    from guardrail.core import policy_version as pv

    try:
        return str(await pv.resolve_policy_version(app_state, tenant_id))
    except Exception as exc:  # noqa: BLE001 — a version read never breaks a screen
        logger.warning(
            "guardrail.policy_version.unavailable",
            tenant_id=tenant_id,
            error_type=type(exc).__name__,
        )
        return "unavailable"


def window_geometry_of(policy: Any) -> Any:
    """The screen window geometry a `GuardrailPolicy` declares (TASK-1047 D4)."""
    from guardrail.services.windowing import WindowGeometry

    size, overlap = policy.screen_window_geometry
    return WindowGeometry(size=size, overlap=overlap, concurrency=policy.screen_window_concurrency)


async def build_window_runner(app_state: Any, tenant_id: str, policy: Any, geometry: Any) -> Any:
    """One request's window runner: per-request concurrency + the verdict cache.

    The cache exists only when ALL of its inputs do (TASK-1047 FC-7): the platform
    secret `GUARDRAIL_WINDOW_CACHE_KEY`, a Redis client, and this tenant's policy
    version. Any one missing ⇒ no cache ⇒ every window is computed — never skipped,
    and never cached under a key that could not name its policy.
    """
    from hope_env import real_secret

    from guardrail.core.policy_version import (
        PolicyVersionUnavailableError,
        resolve_policy_version,
    )
    from guardrail.services.window_cache import WindowVerdictCache
    from guardrail.services.windowing import WindowRunner

    settings = getattr(app_state, "settings", None)
    secret_field = getattr(settings, "window_cache_key", None)
    secret = real_secret(secret_field) if secret_field is not None else ""
    cache = WindowVerdictCache.build(
        getattr(app_state, "redis", None), secret, ttl_s=policy.window_cache_ttl_seconds
    )
    policy_version: str | None = None
    if cache is not None:
        try:
            policy_version = await resolve_policy_version(app_state, tenant_id)
        except PolicyVersionUnavailableError as exc:
            logger.warning(
                "guardrail.window_cache.no_policy_version",
                tenant_id=tenant_id,
                error=str(exc),
            )
    return WindowRunner(
        tenant_id=tenant_id,
        policy_version=policy_version,
        cache=cache,
        concurrency=geometry.concurrency,
    )


async def resolve_screen_policy(app_state: Any, tenant_id: str) -> Any:
    """The `guardrail.safety` row's policy — the screen geometry's one source.

    NEVER raises: every key it is read for is open-to-default tuning, so an
    unresolvable row means the declared defaults (logged), not a failed request.
    Routes that need the safety SELECTION itself still fail closed on their own.
    """
    from guardrail.core.policy import GuardrailPolicy
    from guardrail.core.tenant_config import TASK_KEY_GUARDRAIL_SAFETY

    try:
        cfg = await _resolve_selection(app_state, tenant_id, TASK_KEY_GUARDRAIL_SAFETY)
    except SelectionUnavailableError as exc:
        logger.warning("guardrail.screen_policy.defaults", tenant_id=tenant_id, error=str(exc))
        return GuardrailPolicy.from_blob({})
    return _row_policy(cfg)


async def build_judge_window_plan(
    app_state: Any, tenant_id: str, judge: Any, settings: Settings
) -> tuple[Any, Any]:
    """`(runner, geometry)` for the per-window medical judge (TASK-1047 OD-5).

    The judge's window is the screen window bounded by the judge lane's input cap
    (`core/policy_version.judge_window_chars`), so every character is judged.
    """
    from guardrail.core.policy_version import judge_window_chars
    from guardrail.services.windowing import WindowGeometry

    policy = await resolve_screen_policy(app_state, tenant_id)
    _size, overlap = policy.screen_window_geometry
    size = judge_window_chars(policy, settings.judge.max_input_chars)
    geometry = WindowGeometry(
        size=size,
        overlap=min(overlap, max(0, size - 1)),
        concurrency=policy.screen_window_concurrency,
    )
    return await build_window_runner(app_state, tenant_id, policy, geometry), geometry


async def build_realtime_validator(app_state: Any, tenant_id: str) -> Any:
    """Build the realtime plane for one tenant.

    Reuses `build_safety_analyzer` verbatim — one selection path, one taxonomy,
    one fail-closed posture — and adds the realtime declarations that live
    alongside it on the SAME registry row, resolved by the SAME two-tier
    `request tenant -> SYSTEM` cascade.

    Every realtime declaration is fail-CLOSED, and each for its own reason:

    * ``realtime.axes`` — which signals GATE and which merely inform a clinician
      is the C-1 decision. Guessing it either lets a self-harm disclosure stop a
      note being written, or lets an injection through as "informational".
    * ``realtime.deterministicPatterns`` — an empty automaton reports every
      stream clean.
    * ``realtime.capabilitySets`` — C-3 cannot be checked against an undeclared
      capability model.

    ``realtime.protectedLexicons`` is the one that is NOT fail-closed at build
    time, because its absence degrades a specific output check to ``skipped``
    rather than silently passing it — the distinction `_check_pii_leak` already
    makes.
    """
    from guardrail.core.policy import GuardrailPolicy
    from guardrail.core.tenant_config import TASK_KEY_GUARDRAIL_SAFETY
    from guardrail.realtime.consumption import CapabilityPolicy
    from guardrail.realtime.deterministic import DeterministicRuleSet
    from guardrail.realtime.service import AxisTasks, RealtimePolicy, RealtimeValidator
    from guardrail.realtime.session_state import SessionRiskPolicy
    from guardrail.realtime.store import RedisRealtimeStore

    analyzer = await build_safety_analyzer(app_state, tenant_id)
    safety_cfg = await _resolve_selection(app_state, tenant_id, TASK_KEY_GUARDRAIL_SAFETY)
    taxonomy = _taxonomy(safety_cfg)
    realtime = taxonomy.get("realtime")
    if not isinstance(realtime, dict) or not realtime:
        raise SelectionUnavailableError(
            "the guardrail.safety model row declares no `labelTaxonomy.realtime` — the "
            "realtime consultation plane is configuration and has no code default "
            "(fail-closed)."
        )
    policy_blob = GuardrailPolicy.from_blob(
        getattr(safety_cfg, "policy", None),
        source_tenant_id=getattr(safety_cfg, "source_tenant_id", None),
    )

    benign = taxonomy.get("benignLabels")
    realtime_benign = (
        frozenset(str(b).casefold() for b in benign)
        if isinstance(benign, list) and benign
        else frozenset()
    )
    classifier_version = str(getattr(safety_cfg, "model", "") or "")
    injection = getattr(analyzer, "_injection", None)
    if injection is not None:
        # TASK-1049 R1: `jailbreak_detection` answers from the injection row, so its
        # benign labels count as clean and its model is part of the verdict identity.
        if realtime_benign:
            realtime_benign = realtime_benign | injection.benign_labels
        injection_model = getattr(injection.client, "model_id", "") or injection.unavailable
        classifier_version = f"{classifier_version}+{injection_model}"
    realtime_policy = RealtimePolicy(
        axes=AxisTasks.from_declaration(realtime.get("axes")),
        rules=DeterministicRuleSet.from_declaration(realtime.get("deterministicPatterns")),
        capabilities=CapabilityPolicy.from_declaration(realtime.get("capabilitySets")),
        session=SessionRiskPolicy(
            noise_floor=policy_blob.number("realtimeNoiseFloor"),
            excess_risk_threshold=policy_blob.number("realtimeExcessRiskThreshold"),
            consecutive_limit=int(policy_blob.number("realtimeConsecutiveLimit")),
            mean_score_threshold=policy_blob.number("realtimeMeanScoreThreshold"),
            min_windows_for_mean=int(policy_blob.number("realtimeMinWindowsForMean")),
        ),
        lexicons=realtime.get("protectedLexicons") or {},
        benign_labels=realtime_benign,
        window_chars=policy_blob.realtime_window_chars,
        overlap_chars=policy_blob.realtime_window_overlap_chars,
        ceiling_chars=policy_blob.realtime_cumulative_ceiling_chars,
        ttl_s=policy_blob.realtime_verdict_ttl_seconds,
        # The verdict must die when any of these change ( condition 3): the
        # stamp is a cache entry, and it dies when its key components do.
        policy_version=int(getattr(safety_cfg, "version", 0) or 0),
        classifier_version=classifier_version,
        taxonomy_version=str(realtime.get("version") or taxonomy.get("version") or ""),
        threshold_set=str(realtime.get("thresholdSet") or "default"),
        source_tenant_id=policy_blob.source_tenant_id,
    )
    return RealtimeValidator(
        analyzer=analyzer,
        policy=realtime_policy,
        tenant_id=tenant_id,
        store=RedisRealtimeStore(app_state.redis),
    )


@asynccontextmanager
async def pinned_safety_analyzer(
    app_state: Any, tenant_id: str | None = None, analyzer: Any = None
) -> AsyncIterator[SafetyAnalyzer]:
    """Yield the safety analyzer for a request/job.

    Kept as a context manager because the call sites are unchanged from when a
    model instance had to be PINNED against eviction. Nothing is pinned now —
    there is nothing resident to evict — but the seam stays so a future change
    of transport does not ripple through every endpoint again.
    """
    if analyzer is not None:
        yield analyzer
        return
    yield await build_safety_analyzer(app_state, tenant_id or "")


async def get_safety_analyzer(request: Request) -> SafetyAnalyzer:
    """FastAPI dependency: 428 on absent tenant, 503 on an unresolved selection."""
    from fastapi import HTTPException

    tenant_id = require_tenant_id(request)  # 428 before any registry read
    try:
        return await build_safety_analyzer(request.app.state, tenant_id)
    except SelectionUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@asynccontextmanager
async def acquire_groundedness_verifier(
    request: Request,
) -> AsyncIterator[GroundednessNliVerifier]:
    """Yield a groundedness verifier backed by `apps/nlp`'s entailment scorer.

    Resolution order:
      1. a pre-seeded ``app.state.groundedness_verifier`` (test seam) is used verbatim;
      2. a disabled gate builds a verifier that degrades honestly (no selection needed);
      3. otherwise the ``guardrail.groundedness`` selection drives the model id and a
         tenant-bound `apps/nlp` client scores the segments.

    An UNRESOLVED selection is 503. An `apps/nlp` outage is NOT: the verifier
    degrades to ``unverified`` — fail-closed groundedness never reads as
    ``grounded``, and a scoring outage must not take the whole route down.
    """
    from fastapi import HTTPException

    from guardrail.services.groundedness_nli import GroundednessNliVerifier

    # 428 first: a groundedness verdict is a tenant-scoped safety decision, and the
    # test seam below must not become a way to skip attribution.
    tenant_id = require_tenant_id(request)

    app_state = request.app.state
    pre_seeded = getattr(app_state, "groundedness_verifier", None)
    if pre_seeded is not None:
        yield pre_seeded
        return

    # The gate's platform-scope knobs now come from the control plane
    # (`guardrail.groundedness.*`), with the env-era struct as the bootstrap
    # floor. A gateway outage leaves the running values in force, and an absent
    # `enabled` leaves the gate OFF — a safety gate is never switched on by
    # silence.
    gate = await _groundedness_gate(app_state)

    if not gate.enabled:
        # Bypass — degrades to `groundedness_disabled`, no selection needed.
        yield GroundednessNliVerifier(gate)
        return

    from guardrail.core.tenant_config import TASK_KEY_GUARDRAIL_GROUNDEDNESS

    try:
        cfg = await _resolve_selection(app_state, tenant_id, TASK_KEY_GUARDRAIL_GROUNDEDNESS)
    except SelectionUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    # The verdict-deciding threshold rides the SELECTED MODEL's own policy blob,
    # resolved by the same tenant → SYSTEM cascade that chose the model — so a
    # threshold can never be applied to a checkpoint it was not calibrated for.
    policy = getattr(cfg, "policy", None)
    threshold = (
        policy.groundedness_entailment_threshold
        if policy is not None
        else gate.entailment_threshold
    )

    yield GroundednessNliVerifier(
        gate.model_copy(update={"entailment_threshold": threshold}),
        scorer=_nlp_client(
            app_state, tenant_id, cfg, deadline_s=_row_policy(cfg).nlp_deadline_seconds
        ),
    )


async def _groundedness_gate(app_state: Any) -> GroundednessConfig:
    """The gate's platform-scope geometry, control plane over bootstrap floor.

    NEVER raises: a config-plane outage must not take a safety route down. Keys
    the control plane has no opinion on keep their running values.
    """
    settings = cast("Settings", app_state.settings)
    gate = settings.groundedness

    client = getattr(app_state, "effective_config_client", None)
    if client is None:
        return gate

    try:
        snapshot = await client.get()
        served = snapshot.groundedness()
    except Exception as exc:  # noqa: BLE001 — config refresh may never break the gate
        logger.warning(
            "guardrail.groundedness.config_refresh_failed",
            error_type=type(exc).__name__,
        )
        return gate

    return gate.model_copy(update=served) if served else gate
