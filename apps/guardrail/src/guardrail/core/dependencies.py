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

    Reads ``AiTaskDefault`` ⋈ ``AiModel`` for ``guardrail.validate`` tenant-first
    (SYSTEM as the platform fallback) and returns a client bound to that
    selection, pointed at ``apps/text``'s judge lane.

    **Fail-closed at every step and with no env engine left to fall back to**
    (TASK-735 Phase 2b deleted them): an absent ``X-Tenant-Id`` is 428, a DISABLED
    tenant row is a 503 veto, and a missing selection is a 503. The
    ``db_config_enabled=False`` escape hatch is GONE (TASK-799 lane D) — without a
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
            detail="AiTaskDefault for 'guardrail.validate' is unavailable (resolver not wired).",
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
        # tenant that may have chosen something stricter (TASK-799 F-08).
        raise HTTPException(
            status_code=503,
            detail=(
                f"guardrail.validate config for tenant {exc.tenant_id!r} could not be "
                "read — not falling through to the SYSTEM default."
            ),
        ) from exc
    except TenantSelectionVetoedError as exc:
        # Tenant-first resolution (TASK-735 Phase 1): a DISABLED tenant row is
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
            detail="AiTaskDefault for 'guardrail.validate' is missing. Run db:seed.",
        )

    from guardrail.core.errors import GuardrailUndeterminedError

    try:
        return build_judge_client(  # type: ignore[no-any-return]
            settings,
            tenant_cfg,
            request.app.state.http_client,
            tenant_id,
            provider_overrides=_provider_overrides(request),
            breaker=_breaker(request.app.state, "text"),
        )
    except GuardrailUndeterminedError as exc:
        # A fail-CLOSED policy key (the criteria that decides the verdict) is
        # unresolved. Same 503 shape as a missing selection: the check cannot run,
        # so it certainly cannot pass.
        raise HTTPException(status_code=503, detail=exc.as_detail()) from exc


def _provider_overrides(request: Request) -> dict[str, Any] | None:
    """Tenant BYO credentials forwarded by the caller, passed through VERBATIM.

    Guardrail never decrypts, stores or logs them: the gateway resolved them, the
    caller forwarded them, and `text` hands them to the adapter. Absent ⇒ the
    platform-tier credential `text` resolves for itself.
    """
    overrides = getattr(getattr(request, "state", None), "provider_overrides", None)
    return overrides if isinstance(overrides, dict) and overrides else None


def _breaker(app_state: Any, peer: str) -> Any:
    """The process-wide breaker for a peer (``None`` in tests that never build one)."""
    breakers = getattr(app_state, "circuit_breakers", None)
    return breakers.get(peer) if isinstance(breakers, dict) else None


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
# Delegated aux models (TASK-735 Phases 3 & 6).
#
# Guardrail holds ZERO resident model weights. The GLiNER runtime and the
# MiniCheck GGUF scorer moved to `apps/nlp` together with their model cache and
# their weight staging; what stays here is POLICY plus a bounded peer client.
#
# Two selections, both `AiTaskDefault` ⋈ `AiModel`, both tenant-first with
# SYSTEM as the platform fallback, both FAIL-CLOSED:
#
#   `guardrail.safety`       — the LLM-safety moderation model (six tasks)
#   `guardrail.pii`          — the PII span model (English only)
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
    deleted in TASK-799 lane D): guardrail names no model in code, so without the
    registry there is nothing to name, and the resolver check below already says
    so with the same error.
    """
    resolver = getattr(app_state, "tenant_config_resolver", None)
    if resolver is None:
        raise SelectionUnavailableError(
            f"AiTaskDefault for {task_key!r} is unavailable (resolver not wired)."
        )

    from guardrail.core.tenant_config import (
        TenantConfigUnavailableError,
        TenantSelectionVetoedError,
    )

    try:
        cfg = await resolver.resolve(tenant_id, task_key)
    except TenantConfigUnavailableError as exc:
        # A failed READ is not "no tenant opinion" (TASK-799 F-08) — fail closed
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
        raise SelectionUnavailableError(f"AiTaskDefault for {task_key!r} is missing. Run db:seed.")
    return cfg


def _nlp_client(
    app_state: Any,
    tenant_id: str,
    cfg: Any,
    *,
    labels: list[str] | None = None,
    threshold: float = 0.5,
) -> NlpGuardClientT:
    """Build a tenant-bound `apps/nlp` client for one resolved selection."""
    from guardrail.services.external_nlp_client import NlpGuardClient

    settings = cast("Settings", app_state.settings)
    return NlpGuardClient(
        base_url=settings.nlp_url,
        service_token=settings.peer_service_token(settings.service_token),
        http_client=app_state.http_client,
        tenant_id=tenant_id,
        model_id=cfg.model,
        model_path=cfg.local_path,
        labels=labels,
        threshold=threshold,
        # The selected NLI build's calibration, forwarded so `apps/nlp` can bind
        # its adapter and score. Absent, nlp refuses and the groundedness gate
        # degrades to `unverified` — safe, but a gate that has silently stopped
        # working, which is why this travels with the selection rather than
        # being configured independently on either side.
        calibration=getattr(cfg, "entailment", None),
        timeout_s=float(cfg.timeout_s or settings.judge.timeout_s),
        breaker=_breaker(app_state, "nlp"),
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
    return SafetyAnalyzer(
        policy,
        safety_client=_nlp_client(
            app_state, tenant_id, safety_cfg, threshold=policy.classification_threshold
        ),
        pii_client=_nlp_client(
            app_state,
            tenant_id,
            pii_cfg,
            labels=policy.pii_labels,
            threshold=policy.pii_threshold,
        ),
    )


async def build_screener(app_state: Any, tenant_id: str) -> Any:
    """Build the bidirectional screener for one tenant.

    Reuses `build_safety_analyzer` verbatim — one selection path, one taxonomy,
    one fail-closed posture — and layers the screening policy (containment size
    bound, PII-leak score floor) resolved through the SAME two-tier cascade.
    """
    from guardrail.core.policy import GuardrailPolicy
    from guardrail.core.tenant_config import TASK_KEY_GUARDRAIL_SAFETY
    from guardrail.services.screening import Screener

    analyzer = await build_safety_analyzer(app_state, tenant_id)
    safety_cfg = await _resolve_selection(app_state, tenant_id, TASK_KEY_GUARDRAIL_SAFETY)
    policy = GuardrailPolicy.from_blob(
        getattr(safety_cfg, "policy", None),
        source_tenant_id=getattr(safety_cfg, "source_tenant_id", None),
    )
    return Screener(
        analyzer=analyzer,
        tenant_id=tenant_id,
        policy_source_tenant_id=policy.source_tenant_id,
        max_untrusted_chars=policy.max_untrusted_chars,
        pii_leak_min_score=policy.pii_leak_min_score,
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
        scorer=_nlp_client(app_state, tenant_id, cfg),
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
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return gate

    return gate.model_copy(update=served) if served else gate
