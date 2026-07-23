"""Temporal activities.

Activities are where all non-deterministic work lives — network calls, model
inference, tool invocations, clock/random access. They are retryable and must
be idempotent. The workflow body (see ``workflows.py``) stays deterministic and
delegates every side effect here.

``ping_activity`` is a trivial placeholder that proves the substrate. The
document-loop activities below are thin wrappers over the typed httpx tool
clients (NLP/SMR/apps-api) + the pure sensor runner; they read settings at
runtime (allowed in activities) and construct a client per call.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from harness.core.config import Settings, get_runtime_judge_config, get_settings
from harness.core.logging import get_logger
from harness.core.metrics import inc_gate_decision, inc_regen, observe_step_duration
from harness.eval.judge.base import JudgeClient
from harness.eval.judge.providers import build_judge_client
from harness.guards.phi import (
    PhiEgressBlocked,
    PhiRedactor,
    ensure_egress_safe,
    ensure_inferential_egress_safe,
    ensure_mcp_args_safe,
)
from harness.guides.retrieval.prompt import build_strict_citations_block
from harness.guides.retrieval.qdrant_store import KnowledgeQdrantStore
from harness.guides.retrieval.retriever import HybridRetriever, build_query
from harness.guides.retrieval.sparse import SparseBm25Embedder
from harness.redaction.engine import (
    RedactionEngineError,
    RedactionManifest,
    RedactionRule,
    apply_deterministic_redaction,
)
from harness.sensors.base import NEREntity, SensorContext, SensorResult
from harness.sensors.config import SensorThresholds
from harness.sensors.inferential import (
    ATOMIC_FACT_NAME,
    CITATION_VERIFY_NAME,
    GROUNDEDNESS_NAME,
    SAFETY_NAME,
    AtomicFactSensor,
    CitationVerifySensor,
    DeterministicOverlapEntailer,
    GraniteGuardianClient,
    GroundednessSensor,
    NliEntailer,
    SafetySensor,
)
from harness.sensors.inferential.base import degraded_result
from harness.sensors.inferential.groundedness import ClaimVerdictCallback
from harness.sensors.inferential.minicheck_entailer import load_minicheck_entailer
from harness.services.api_client import (
    ApiClient,
    ApiServiceError,
    AssembleResponse,
    DraftResponse,
    FinalizeAssuranceResponse,
    PersistEntitiesResponse,
    RecordGateResponse,
    RetractDraftResponse,
    TrajectoryStepInput,
)
from harness.services.embeddings_client import EmbeddingsClient
from harness.services.nlp_client import NlpClient
from harness.services.reranker_client import RerankerClient
from harness.services.sensor_runner import SensorRunOutput, run_computational_sensors
from harness.services.smr_client import SmrClient, SmrGenerationResult, SmrServiceError
from harness.temporal.claim_check import (
    ClaimCheckRef,
    build_blob_store,
    load_blob,
    maybe_offload,
)
from harness.temporal.models import (
    ApplyRedactionInput,
    ApplyRedactionResult,
    AssembleInput,
    CallMcpToolInput,
    EntitiesResult,
    EscalateInput,
    EscalateResult,
    ExtractEntitiesInput,
    FetchPolicyInput,
    FinalizeAssuranceInput,
    GenerateInput,
    HarnessPolicy,
    InferentialRunOutput,
    McpToolCallResult,
    PersistDraftInput,
    PersistEntitiesInput,
    RecordGateInput,
    ReportProgressInput,
    ReportProgressResult,
    RetractDraftInput,
    RetrieveContextInput,
    RetrievedContext,
    RunInferentialSensorsInput,
    RunSensorsInput,
    TrajectoryContext,
)
from harness.temporal.prompt_cache import (
    assemble_generation_prompt,
    build_segment_citations_block,
)
from harness.tools.mcp_client import McpClientError, McpToolClient

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# trajectory step types (the ordered spine vocabulary)
# ---------------------------------------------------------------------------
STEP_PHASE = "PHASE"
STEP_TOOL_CALL = "TOOL_CALL"
STEP_RETRIEVAL = "RETRIEVAL"
STEP_LLM_CALL = "LLM_CALL"
STEP_SENSOR = "SENSOR"
STEP_GUARDRAIL = "GUARDRAIL"
STEP_THINKING = "THINKING"
STEP_GATE = "GATE"
# Terminal step statuses (STARTED is reserved for a future streaming variant; the
# harness emits terminal spans carrying startedAt+endedAt to bound the call count).
STATUS_OK = "OK"
STATUS_ERROR = "ERROR"
STATUS_SKIPPED = "SKIPPED"


@dataclass
class PingInput:
    """Input payload for :func:`ping_activity`."""

    message: str


@dataclass
class PingResult:
    """Result returned by :func:`ping_activity`."""

    message: str
    task_queue: str


@activity.defn
async def ping_activity(payload: PingInput) -> PingResult:
    """Return a ``pong`` for the given message.

    Any real I/O (HTTP tool calls, model inference, DB writes) belongs in
    activities like this one — never in the workflow body.
    """
    info = activity.info()
    activity.logger.info("harness.ping_activity.invoked", extra={"message": payload.message})
    return PingResult(message=f"pong: {payload.message}", task_queue=info.task_queue)


# ---------------------------------------------------------------------------
# Tool-client factories (settings read at runtime — non-deterministic, OK here)
# ---------------------------------------------------------------------------


def _nlp_client(settings: Settings) -> NlpClient:
    return NlpClient(settings.nlp_base_url, timeout=settings.nlp_timeout_s)


def _smr_client(settings: Settings) -> SmrClient:
    return SmrClient(settings.smr_base_url, timeout=settings.smr_timeout_s)


def _api_client(settings: Settings) -> ApiClient:
    return ApiClient(
        settings.api_base_url,
        internal_prefix=settings.api_internal_prefix,
        service_token=settings.service_token.get_secret_value(),
        timeout=settings.api_timeout_s,
    )


def _idempotency_key(*parts: str) -> str:
    """Deterministic Idempotency-Key for a harness→apps/api WORM/draft write.

    Derived from the workflow RUN + THIS activity invocation: ``activity_id`` is stable
    across the activity's retry attempts (and worker-crash re-delivery) yet unique per
    logical write, so a retried/redelivered POST dedups on apps/api WITHOUT suppressing
    distinct writes (a later regen's persist is a different activity ⇒ a different key).
    Optional ``parts`` disambiguate multiple writes issued inside ONE activity (e.g. the
    per-claim live assurance events). Called only inside an activity (info() is available).
    """
    info = activity.info()
    base = f"{info.workflow_run_id}:{info.activity_id}"
    return ":".join((base, *parts)) if parts else base


# Progress reporting is fire-and-forget: a dedicated short HTTP
# timeout so a wedged API never holds a stage transition hostage for the full
# standard budget.
_PROGRESS_HTTP_TIMEOUT_S = 5.0


def _progress_api_client(settings: Settings) -> ApiClient:
    return ApiClient(
        settings.api_base_url,
        internal_prefix=settings.api_internal_prefix,
        service_token=settings.service_token.get_secret_value(),
        timeout=min(_PROGRESS_HTTP_TIMEOUT_S, settings.api_timeout_s),
    )


# trajectory reporting is fire-and-forget (like progress) —
# a short HTTP timeout so a wedged gateway never holds a phase boundary hostage.
_TRAJECTORY_HTTP_TIMEOUT_S = 5.0


def _trajectory_api_client(settings: Settings) -> ApiClient:
    return ApiClient(
        settings.api_base_url,
        internal_prefix=settings.api_internal_prefix,
        service_token=settings.service_token.get_secret_value(),
        timeout=min(_TRAJECTORY_HTTP_TIMEOUT_S, settings.api_timeout_s),
    )


def _reasoning_tokens(stats: dict[str, Any] | None) -> int:
    """Best-effort reasoning-token count from a ``GenerationStats`` dict.

    ``SmrGenerationResult`` has no dedicated reasoning field yet, so we read it
    defensively from the stats block (top-level ``reasoning_tokens`` or the
    engine-native OpenAI-wire ``completion_tokens_details.reasoning_tokens``). A
    positive count is the "SMR returned non-empty reasoning" signal for the
    ``THINKING`` step; everything is null-safe (missing ⇒ 0 ⇒ no THINKING step).
    """
    if not stats:
        return 0
    direct = stats.get("reasoning_tokens")
    if direct:
        return int(direct)
    engine_native = stats.get("engine_native")
    if isinstance(engine_native, dict):
        native = engine_native.get("reasoning_tokens")
        if native:
            return int(native)
        details = engine_native.get("completion_tokens_details")
        if isinstance(details, dict) and details.get("reasoning_tokens"):
            return int(details["reasoning_tokens"])
    return 0


class _TrajectoryBatch:
    """Collects a phase-boundary's trajectory steps and flushes them ONCE.

    ``record`` appends one terminal span (status + start/end
    timing + stats) AND always observes the ``harness_step_duration_seconds`` metric
    (metrics are useful even without a session context). ``flush`` posts the batch
    via :meth:`ApiClient.report_trajectory` fire-and-forget: a trajectory/gateway
    outage is swallowed+logged so it can NEVER fail the clinical loop (the same
    posture as ``report_progress``). When the activity input carried no
    ``TrajectoryContext`` (a legacy call from before this trajectory feature) no
    step is built and no POST is made (metrics still fire).
    """

    def __init__(self, settings: Settings, ctx: TrajectoryContext | None) -> None:
        self._settings = settings
        self._ctx = ctx
        self._steps: list[TrajectoryStepInput] = []

    def record(
        self,
        *,
        step_type: str,
        name: str,
        status: str,
        started: datetime,
        stats: dict[str, Any] | None = None,
        payload_ref: dict[str, Any] | None = None,
        error_code: str | None = None,
        offset: int = 0,
    ) -> None:
        ended = datetime.now(UTC)
        elapsed_ms = max(0.0, (ended - started).total_seconds() * 1000.0)
        observe_step_duration(step_type, name, elapsed_ms / 1000.0)
        # The apps/api ingest DTO validates `durationMs` as an integer (the column
        # is `Int?`) under a strict global ValidationPipe — a fractional value
        # 400s the whole batch, which fire-and-forget then silently swallows. Emit
        # a rounded int so real (fractional) durations persist.
        duration_ms = round(elapsed_ms)
        if self._ctx is None:
            return
        info = activity.info()
        self._steps.append(
            TrajectoryStepInput(
                tenant_id=self._ctx.tenant_id,
                consultation_id=self._ctx.consultation_id,
                session_id=str(info.workflow_id),
                run_id=str(info.workflow_run_id),
                seq=self._ctx.seq + offset,
                step_type=step_type,
                name=name,
                status=status,
                started_at=started.isoformat(),
                ended_at=ended.isoformat(),
                duration_ms=duration_ms,
                stats=stats,
                payload_ref=payload_ref,
                error_code=error_code,
                correlation_id=self._ctx.correlation_id,
            )
        )

    async def flush(self) -> None:
        if not self._steps:
            return
        steps: Sequence[TrajectoryStepInput] = self._steps
        try:
            await _trajectory_api_client(self._settings).report_trajectory(
                steps, idempotency_key=_idempotency_key("traj")
            )
        except Exception as exc:  # noqa: BLE001 — trajectory is fire-and-forget, never raise
            activity.logger.warning(
                "harness.report_trajectory.failed",
                extra={"steps": len(steps), "error": str(exc)},
            )
        finally:
            self._steps = []


def _now() -> datetime:
    """Activity-side wall clock (non-deterministic — activities may read it)."""
    return datetime.now(UTC)


def _resolve_flag(policy_value: bool | None, *, env_default: bool) -> bool:
    """per-field policy/env fallthrough for a boolean knob.

    The effective (DB-backed) ``HarnessPolicy`` carries the seven agentic loop
    knobs as NULLABLE overrides threaded onto the activity inputs. ``None`` means
    "no override" ⇒ fall through to the harness env/code default; a non-null value
    is the explicit override and wins. Keeps the null-means-env-default contract
    identical everywhere the knobs are consumed.
    """
    return env_default if policy_value is None else policy_value


def _build_runtime_judge(
    *, provider: str | None = None, model: str | None = None
) -> JudgeClient:
    """Build the calibrated runtime judge from the DB-selected provider/model.

    the SELECTION (provider + model) comes from the SYSTEM
    ``harness.judge`` policy, threaded here as ``provider``/``model``; env
    (``HARNESS_JUDGE_*``) supplies only the CONNECTION config (base_url/api_key/
    tuning), never the selection. When an override is given it wins over the
    env-config provider/model via ``model_copy`` (the env provider/model are the
    offline-eval defaults only). Factored out (like the other client factories) so
    the tests can monkeypatch it with a stub.
    """
    config = get_runtime_judge_config()
    updates: dict[str, str] = {}
    if provider:
        updates["provider"] = provider
    if model:
        updates["model"] = model
    if updates:
        config = config.model_copy(update=updates)
    return build_judge_client(config)


def _granite_client(settings: Settings) -> GraniteGuardianClient:
    return GraniteGuardianClient(settings.safety)


def _atomic_fact_entailer(settings: Settings, model_path: str | None = None) -> NliEntailer:
    """Build the atomic-fact verifier's NLI entailer.

    Default = the model-free, deterministic, hermetic :class:`DeterministicOverlapEntailer`
    (no model/network/cloud egress). When ``HARNESS_ATOMIC_FACT_MODEL_PATH`` names a staged
    local ``.gguf`` (owner directive 2026-07-11), swaps in the self-hosted MiniCheck-Flan-T5
    GGUF entailer behind the same :class:`NliEntailer` interface (the ``JudgeClient`` is NEVER
    used — the verifier is judge-free by contract). A build/calibration failure is a config
    error, NOT a runtime outage, so it falls back to the SAFE deterministic entailer (which
    never auto-PASSes) with a loud warning rather than degrading the whole sensor. Factored
    out like the other client factories so tests can monkeypatch it with a stub NLI.
    """
    # `model_path` may be supplied by the caller after a
    # control-plane resolve (`resolve_atomic_fact_model_path`); when it is None
    # this falls back to the env setting, which is today's behaviour verbatim.
    resolved_path = model_path if model_path is not None else settings.atomic_fact_model_path
    if not resolved_path:
        return DeterministicOverlapEntailer()
    try:
        return load_minicheck_entailer(
            model_path=resolved_path,
            n_ctx=settings.atomic_fact_n_ctx,
            n_threads=settings.atomic_fact_n_threads,
            n_gpu_layers=settings.atomic_fact_n_gpu_layers,
            threshold=settings.atomic_fact_entail_threshold,
        )
    except Exception as exc:  # noqa: BLE001 — misconfig/load/calibration failure => safe fallback
        logger.warning(
            "harness.atomic_fact.minicheck_unavailable_fallback",
            model_id=settings.atomic_fact_model_id,
            error=type(exc).__name__,
        )
        return DeterministicOverlapEntailer()


def _phi_redactor() -> PhiRedactor:
    """Build the fail-closed PHI egress redactor (Presidio engines are lazy).

    Factored out like the other client factories so each cloud-bound activity builds
    it once per invocation (the spaCy model loads only on an actual cloud redaction)
    and the tests can monkeypatch it with a stub.
    """
    return PhiRedactor()


def _mcp_client(settings: Settings) -> McpToolClient:
    """Build the streamable-HTTP MCP tool client.

    Factored out like the other client factories so ``call_mcp_tool`` builds it once
    per invocation and the tests can monkeypatch it with a stub (the hermetic suite
    never touches the real ``mcp`` SDK / network).
    """
    return McpToolClient(timeout_s=settings.mcp.timeout_s, max_attempts=settings.mcp.max_attempts)


async def _resolve_mcp_token(settings: Settings, auth_ref: str | None) -> str | None:
    """Resolve an MCP server credential by its ``authRef`` PATH.

    ``auth_ref`` is a PATH — NEVER secret bytes in the DB/policy. Resolution goes
    through the GATEWAY (``GET /internal/harness/mcp-token``), not a harness-side
    Vault client: this design keeps secret material on the
    side of the boundary that already holds a secrets backend. The gateway
    allowlists the ref against registered, ENABLED ``McpServer`` rows, so this is
    not an arbitrary secret-path read.

    Called from INSIDE the activity that performs the MCP call, so the token is an
    activity local: it is handed to :class:`McpToolClient` as the ``Authorization``
    bearer header and then dropped. It is NEVER logged, echoed into a result,
    written to the trajectory, put in a heartbeat, or placed in an activity input —
    Temporal history is durable storage, so a token in an input is a token on disk.

    Returns None when no ``authRef`` is configured, when the gateway declines to
    resolve it, or on any transport failure — the server must then be public /
    in-boundary. A bounded tool call must never take the loop down.
    """
    if not auth_ref:
        return None
    try:
        return await _api_client(settings).resolve_mcp_token(auth_ref)
    except Exception as exc:  # noqa: BLE001 - degrade to unauthenticated, never crash the loop
        # Logs the REF (a path) and the error TYPE only — never the response body,
        # which on some secrets backends echoes fragments of the requested value.
        activity.logger.warning(
            "harness.mcp.token_resolution_failed",
            extra={"auth_ref": auth_ref, "error_type": type(exc).__name__},
        )
        return None


def _effective_mcp_allowlist(
    policy_allowlist: list[str] | None, server_allowlist: list[str] | None
) -> set[str]:
    """The tool allowlist a call must satisfy: ``policy ∩ server`` (deny-all default).

    An MCP server with NO allowlist can call NOTHING (fail-safe empty set); the tenant
    ``policy_allowlist`` (``None`` ⇒ no tenant restriction) narrows the server's set.
    """
    allowed = set(server_allowlist or [])
    if policy_allowlist is None:
        return allowed
    return allowed & set(policy_allowlist)


def _hybrid_retriever(settings: Settings) -> HybridRetriever:
    """Build the JIT hybrid retriever from the (flag-gated) ``RetrievalConfig``.

    Factored out (like the other client factories) so ``retrieve_context`` builds it
    once and the tests can monkeypatch it with a fake. The dense query stays on the
    self-hosted LM Studio path (the query can contain PHI).
    """
    rc = settings.retrieval
    return HybridRetriever(
        embeddings=EmbeddingsClient(
            rc.embeddings_base_url, model=rc.embeddings_model, timeout=rc.embeddings_timeout_s
        ),
        sparse=SparseBm25Embedder(),
        store=KnowledgeQdrantStore(rc.qdrant_url, rc.collection, timeout=rc.qdrant_timeout_s),
        reranker=RerankerClient(rc.reranker_base_url, timeout=rc.reranker_timeout_s),
        top_k_retrieval=rc.top_k_retrieval,
        top_k_rerank=rc.top_k_rerank,
    )


# ---------------------------------------------------------------------------
# Claim-check helpers — the store/load edge lives HERE in activities
# (side effects belong in activities, never the deterministic workflow body).
# ``_resolve_ref`` dereferences an offloaded field (ALWAYS — even if offload is
# now disabled, an already-offloaded ref must still be readable); ``_offload_text``
# offloads a produced field above the threshold ONLY when the feature is enabled.
# ---------------------------------------------------------------------------


async def _resolve_ref(settings: Settings, inline: str, ref: ClaimCheckRef | None) -> str:
    """Inline-or-ref at an activity's edge: dereference ``ref`` when set, else the inline."""
    if ref is None:
        return inline
    return await load_blob(ref, store=build_blob_store(settings.claim_check))


async def _offload_text(settings: Settings, text: str) -> tuple[str, ClaimCheckRef | None]:
    """Offload a produced field above the threshold (``("", ref)``) when enabled.

    Disabled ⇒ ``(text, None)`` (inline, byte-identical to before offload was introduced). Above the
    threshold the inline is emptied so the blob stays OUT of Temporal history.
    """
    cc = settings.claim_check
    if not cc.enabled:
        return text, None
    return await maybe_offload(
        text, store=build_blob_store(cc), bucket=cc.bucket, min_bytes=cc.min_bytes
    )


async def _resolve_knowledge_chunks(
    settings: Settings, inline: dict[str, str], refs: dict[str, ClaimCheckRef]
) -> dict[str, str]:
    """Merge the inline chunk texts with any offloaded (ref) ones, resolving each ref."""
    if not refs:
        return inline
    store = build_blob_store(settings.claim_check)
    out = dict(inline)
    for chunk_id, ref in refs.items():
        out[chunk_id] = await load_blob(ref, store=store)
    return out


# ---------------------------------------------------------------------------
# Document-loop activities
# ---------------------------------------------------------------------------


@activity.defn
async def fetch_policy(payload: FetchPolicyInput) -> HarnessPolicy:
    """Read the effective harness policy for the tenant (live policy injection).

    I/O lives here, never the workflow body. Raises :class:`ApiServiceError` on an
    unreachable endpoint; the workflow catches the resulting ``ActivityError`` and
    degrades to the code defaults (fail-safe — never crash the loop).
    """
    settings = get_settings()
    started = _now()
    # TASK-550 — thread the consultation id (when present) so the gateway overlays
    # the department default agent's tenant-tier harnessOverrides. Omitting the
    # kwarg when absent keeps the request byte-identical for non-agent runs.
    client = _api_client(settings)
    if payload.consultation_id:
        data = await client.get_policy(payload.tenant_id, consultation_id=payload.consultation_id)
    else:
        data = await client.get_policy(payload.tenant_id)
    policy = HarnessPolicy.from_api(data)
    # Observability — surface the per-agent override provenance on the fetch_policy
    # trajectory step so a flagged draft can be traced to the agent whose thresholds
    # governed it. `HarnessPolicy` (extra="ignore") drops the field, so read it off
    # the raw response dict. Absent ⇒ no overlay was applied.
    stats: dict[str, Any] = {"version": policy.version}
    overrides_source = data.get("overridesSource")
    if overrides_source:
        stats["overrides_source"] = overrides_source
    batch = _TrajectoryBatch(settings, payload.trajectory)
    batch.record(
        step_type=STEP_PHASE,
        name="fetch_policy",
        status=STATUS_OK,
        started=started,
        stats=stats,
    )
    await batch.flush()
    return policy


def _has_ontology_code(entity: NEREntity) -> bool:
    """True when a prior carries any ontology code (worth reusing)."""
    return bool(
        entity.umls_cui
        or entity.snomed_code
        or entity.rxnorm_code
        or entity.icd_code
        or entity.loinc_code
    )


async def _load_coded_priors(settings: Settings, payload: ExtractEntitiesInput) -> list[NEREntity]:
    """Read persisted ``NamedEntity`` priors from apps/api; return them ONLY when coded.

    Degrade-safe: any apps/api error yields ``[]`` so the caller falls
    back to the cold NLP extraction (priors are an optimization, never a hard
    dependency). Returns the priors only when at least one carries an ontology code
    — so the reuse is a no-op until the codes are populated, and never
    silently drops coverage to an un-coded snapshot.
    """
    if not (payload.consultation_id and payload.tenant_id):
        return []
    try:
        priors = await _api_client(settings).load_entity_priors(
            payload.consultation_id, tenant_id=payload.tenant_id
        )
    except ApiServiceError:
        return []
    return priors if any(_has_ontology_code(e) for e in priors) else []


@activity.defn
async def extract_entities(payload: ExtractEntitiesInput) -> EntitiesResult:
    """Run medical NER over ``text`` via the NLP service.

    NER-priors reuse: on the TRANSCRIPT pass (``reuse_priors``) and
    when ``HARNESS_NER_PRIORS_ENABLED`` is on, first try to reuse already-persisted CODED
    ``NamedEntity`` rows as the transcript entities instead of re-running the
    cold NLP extraction — killing the redundant second NER pass. Falls back to the cold
    NLP extraction when the flag is off, the priors are absent/unreachable, or none carry
    an ontology code (so it stays inert until coded entities are actually persisted
    elsewhere, and never regresses). The note-NER calls leave ``reuse_priors`` unset ⇒
    always cold.
    """
    settings = get_settings()
    started = _now()
    batch = _TrajectoryBatch(settings, payload.trajectory)
    # the policy override (when non-null) wins over the env
    # kill-switch; None falls through to ``HARNESS_NER_PRIORS_ENABLED``.
    ner_priors_enabled = _resolve_flag(payload.ner_priors_enabled, env_default=settings.ner_priors_enabled)
    if payload.reuse_priors and ner_priors_enabled:
        priors = await _load_coded_priors(settings, payload)
        if priors:
            batch.record(
                step_type=STEP_TOOL_CALL,
                name="nlp.extract_entities",
                status=STATUS_OK,
                started=started,
                stats={"entity_count": len(priors), "reused": True},
            )
            await batch.flush()
            return EntitiesResult(entities=priors, reused=True)
    # Resolve the (possibly offloaded) note/transcript before the cold NER pass.
    text = await _resolve_ref(settings, payload.text, payload.text_ref)
    entities = await _nlp_client(settings).classify_tokens(text, language=payload.language)
    batch.record(
        step_type=STEP_TOOL_CALL,
        name="nlp.extract_entities",
        status=STATUS_OK,
        started=started,
        stats={"entity_count": len(entities), "reused": False},
    )
    await batch.flush()
    return EntitiesResult(entities=entities)


@activity.defn
async def call_mcp_tool(payload: CallMcpToolInput) -> McpToolCallResult:
    """Call a READ-ONLY MCP tool on a registered external server.

    Enforcement order (security-critical — everything before the network call is
    fail-closed and BLOCKS without any egress):

    1. **Allowlist** — the tool MUST be in ``policy_tool_allowlist ∩ server.tool_allowlist``
       (deny-all when the server has no allowlist). A denial raises BEFORE any network
       call (non-retryable); the workflow catches it and degrades (never crashes).
    2. **PHI egress guard** — for a ``phi_boundary="external"`` server the outbound
       ``args`` are screened FAIL-CLOSED; PHI (or a redactor failure) raises
       :class:`PhiEgressBlocked` BEFORE any network call.
    3. **Bounded call** — the credential is resolved from Vault (never logged) and the
       client makes the bounded-timeout/retry tool call. A server/transport/tool error
       records an ``ERROR`` step and returns a DEGRADED result (no raise) so the
       workflow degrades to reduced assurance and never crashes.
    4. **Size cap + claim-check** — a result over ``settings.mcp.max_result_bytes`` is
       offloaded (claim-checked, kept OUT of Temporal history) when claim-check is on,
       else truncated. A ``TOOL_CALL`` trajectory step is emitted (secret-free stats).
    """
    settings = get_settings()
    started = _now()
    batch = _TrajectoryBatch(settings, payload.trajectory)
    server = payload.server
    tool = payload.tool
    step_name = f"mcp.{tool}"

    # (0) Defense-in-depth: a disabled server never calls out (the workflow gates on this
    # too). Recorded SKIPPED + degraded so the caller OR-s it into reduced assurance.
    if not server.enabled:
        batch.record(
            step_type=STEP_TOOL_CALL,
            name=step_name,
            status=STATUS_SKIPPED,
            started=started,
            stats={"server": server.name, "tool": tool, "reason": "server_disabled"},
        )
        await batch.flush()
        return McpToolCallResult(
            ok=False, server=server.name, tool=tool, degraded=True, error_code="server_disabled"
        )

    # (1) Allowlist — BEFORE any network call. Denial raises (non-retryable).
    allowed = _effective_mcp_allowlist(payload.policy_tool_allowlist, server.tool_allowlist)
    if tool not in allowed:
        batch.record(
            step_type=STEP_TOOL_CALL,
            name=step_name,
            status=STATUS_ERROR,
            started=started,
            stats={"server": server.name, "tool": tool},
            error_code="tool_not_allowed",
        )
        await batch.flush()
        raise ApplicationError(
            f"MCP tool not in effective allowlist: {tool}",
            type="McpToolNotAllowed",
            non_retryable=True,
        )

    # (2) PHI egress guard — fail-closed for an external server, BEFORE any network call.
    try:
        ensure_mcp_args_safe(
            payload.args,
            phi_boundary=server.phi_boundary,
            phi_enabled=payload.phi_enabled,
            phi_fail_closed=payload.phi_fail_closed,
            server=f"mcp:{server.name}",
            redactor=_phi_redactor(),
        )
    except PhiEgressBlocked as exc:
        activity.logger.warning(
            "harness.mcp.phi_egress.blocked",
            extra={"server": server.name, "tool": tool, "reason": exc.reason},
        )
        batch.record(
            step_type=STEP_TOOL_CALL,
            name=step_name,
            status=STATUS_ERROR,
            started=started,
            stats={"server": server.name, "tool": tool},
            error_code="phi_egress_blocked",
        )
        await batch.flush()
        raise

    # (3) Bounded tool call. The gateway-resolved credential is NEVER logged/echoed,
    # and never leaves this activity frame.
    token = await _resolve_mcp_token(settings, server.auth_ref)
    try:
        tool_result = await _mcp_client(settings).call_tool(
            base_url=server.base_url, tool=tool, args=payload.args, auth_token=token
        )
    except McpClientError as exc:
        error_code = (
            "server_error" if exc.is_server_error else "timeout" if exc.is_timeout else "client_error"
        )
        activity.logger.warning(
            "harness.mcp.call_failed",
            extra={
                "server": server.name,
                "tool": tool,
                "error_code": error_code,
                "status": exc.status,
            },
        )
        batch.record(
            step_type=STEP_TOOL_CALL,
            name=step_name,
            status=STATUS_ERROR,
            started=started,
            stats={"server": server.name, "tool": tool},
            error_code=error_code,
        )
        await batch.flush()
        return McpToolCallResult(
            ok=False, server=server.name, tool=tool, degraded=True, error_code=error_code
        )

    # A tool that returned its own error result is a degraded (not fatal) outcome.
    if tool_result.is_error:
        batch.record(
            step_type=STEP_TOOL_CALL,
            name=step_name,
            status=STATUS_ERROR,
            started=started,
            stats={"server": server.name, "tool": tool},
            error_code="tool_error",
        )
        await batch.flush()
        return McpToolCallResult(
            ok=False, server=server.name, tool=tool, degraded=True, error_code="tool_error"
        )

    # (4) Size cap + claim-check. A result over the cap is offloaded (claim-check on) or
    # truncated (claim-check off) so a huge tool payload never bloats Temporal history.
    content = tool_result.content
    result_bytes = len(content.encode("utf-8"))
    cap = settings.mcp.max_result_bytes
    content_ref: ClaimCheckRef | None = None
    truncated = False
    if result_bytes > cap:
        cc = settings.claim_check
        if cc.enabled:
            content, content_ref = await maybe_offload(
                content, store=build_blob_store(cc), bucket=cc.bucket, min_bytes=cap
            )
        else:
            content = content.encode("utf-8")[:cap].decode("utf-8", "ignore")
            truncated = True

    batch.record(
        step_type=STEP_TOOL_CALL,
        name=step_name,
        status=STATUS_OK,
        started=started,
        stats={
            "server": server.name,
            "tool": tool,
            "result_bytes": result_bytes,
            "offloaded": content_ref is not None,
            "truncated": truncated,
        },
        payload_ref=content_ref.model_dump() if content_ref is not None else None,
    )
    await batch.flush()
    return McpToolCallResult(
        ok=True,
        server=server.name,
        tool=tool,
        content=content,
        content_ref=content_ref,
        truncated=truncated,
    )


@activity.defn
async def persist_entities(payload: PersistEntitiesInput) -> PersistEntitiesResponse:
    """Persist extracted NamedEntity rows via the apps/api internal endpoint."""
    settings = get_settings()
    started = _now()
    result = await _api_client(settings).persist_entities(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        context_item_id=payload.context_item_id,
        entities=payload.entities,
        user_id=payload.user_id,
        idempotency_key=_idempotency_key(),
    )
    batch = _TrajectoryBatch(settings, payload.trajectory)
    batch.record(
        step_type=STEP_TOOL_CALL,
        name="persist_entities",
        status=STATUS_OK,
        started=started,
        stats={"saved_count": result.saved_count},
    )
    await batch.flush()
    return result


@activity.defn
async def assemble_prompt(payload: AssembleInput) -> AssembleResponse:
    """Resolve the prompt tier + assemble the SMR payload via apps/api."""
    settings = get_settings()
    started = _now()
    resp = await _api_client(settings).assemble(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        template=payload.template,
        dna_style_id=payload.dna_style_id,
        conversation_language=payload.conversation_language,
    )
    # Offload the (large) assembled prompts so they don't enter Temporal
    # history; ``generate`` resolves them inline-or-ref. Below the threshold they stay
    # inline (refs None) and the response is unchanged.
    user_inline, user_ref = await _offload_text(settings, resp.user_prompt)
    sys_inline, sys_ref = await _offload_text(settings, resp.system_prompt)
    out = resp
    if user_ref is not None or sys_ref is not None:
        out = resp.model_copy(
            update={
                "user_prompt": user_inline,
                "user_prompt_ref": user_ref,
                "system_prompt": sys_inline,
                "system_prompt_ref": sys_ref,
            }
        )
    batch = _TrajectoryBatch(settings, payload.trajectory)
    batch.record(
        step_type=STEP_TOOL_CALL,
        name="assemble_prompt",
        status=STATUS_OK,
        started=started,
        stats={"resolved_from": resp.resolved_from, "prompt_version": resp.prompt_version},
    )
    await batch.flush()
    return out


@activity.defn
async def generate(payload: GenerateInput) -> SmrGenerationResult:
    """Generate the SOAP draft synchronously via the SMR service."""
    settings = get_settings()
    started = _now()
    hp = payload.hyperparameters or {}

    # Resolve the (possibly offloaded) prompts inline-or-ref, then fold in the
    # RAG StrictCitations block (moved here from the workflow so the workflow can thread
    # the small prompt REF instead of the concatenated blob). The PHI-egress guard below
    # then screens the FULLY-assembled prompt, exactly as before.
    user_prompt = await _resolve_ref(settings, payload.prompt, payload.prompt_ref)
    # assemble in a stable prefix ordering (invariant
    # template+transcript prefix, then the RAG StrictCitations block) so the
    # engine prefix-cache is reused across regen iterations. Byte-identical to
    # the prior inline concatenation → command-neutral for Temporal replay.
    # on a regen iteration the prior iteration's failed-sensor critique
    # is appended as a trailing corrective suffix (None on the first iteration /
    # when regenFeedbackEnabled is off ⇒ byte-identical to before).
    # when segment citation refs are supplied, fold a PHI-safe
    # ``[[seg:<id>]]`` StrictCitations block after the RAG block (empty/absent
    # ⇒ byte-identical to before; additive-optional ⇒ replay-safe).
    segment_block = build_segment_citations_block(payload.segment_citations)
    user_prompt = assemble_generation_prompt(
        user_prompt,
        payload.prompt_block,
        payload.regen_feedback,
        segment_block=segment_block or None,
    )
    if payload.system_prompt_ref is not None:
        system_prompt_in: str | None = await _resolve_ref(
            settings, payload.system_prompt or "", payload.system_prompt_ref
        )
    else:
        system_prompt_in = payload.system_prompt

    # Enforce the fail-closed PHI egress guard before any cloud SMR call.
    # Local providers (the default) are a pure pass-through. A fail-closed block
    # raises PhiEgressBlocked, which propagates and fails the workflow — no draft is
    # ever persisted (the SMR failure-propagation invariant), never a silent leak.
    redactor = _phi_redactor()
    try:
        prompt = ensure_egress_safe(
            user_prompt,
            provider=payload.provider,
            settings=settings,
            phi_enabled=payload.phi_enabled,
            phi_fail_closed=payload.phi_fail_closed,
            redactor=redactor,
        )
        system_prompt = (
            ensure_egress_safe(
                system_prompt_in,
                provider=payload.provider,
                settings=settings,
                phi_enabled=payload.phi_enabled,
                phi_fail_closed=payload.phi_fail_closed,
                redactor=redactor,
            )
            if system_prompt_in is not None
            else None
        )
    except PhiEgressBlocked as exc:
        activity.logger.warning(
            "harness.phi_egress.blocked",
            extra={"provider": exc.provider, "reason": exc.reason, "stage": "generate"},
        )
        raise

    try:
        result = await _smr_client(settings).generate(
            prompt=prompt,
            system_prompt=system_prompt,
            provider=payload.provider,
            model=payload.model,
            temperature=hp.get("temperature"),
            max_tokens=hp.get("max_tokens"),
            top_p=hp.get("top_p"),
            response_format=payload.response_format,
            # A deterministic key (workflow_run:activity_id, stable across
            # worker-crash re-delivery) so SMR dedups a replayed generate — the durable half
            # of the fix on top of the in-process retry narrowing.
            idempotency_key=_idempotency_key(),
        )
    except SmrServiceError as exc:
        # ``after_send`` means the request reached SMR and the model MAY have
        # generated — a dropped-read transport loss OR the governor's per-call timeout
        # firing mid-request (both closed in ``smr_client``). Re-running the activity
        # (Temporal ``_GENERATE_RETRY``) would re-invoke the model (double spend + divergent
        # draft), so mark it non-retryable — the SMR-failure invariant still fails the
        # workflow without a draft. A PRE-send failure propagates unchanged (retryable: the
        # model never ran).
        #
        # Belt-and-braces with the idempotency key above: a genuine worker CRASH mid-activity
        # (no exception to catch) that makes Temporal re-deliver the activity now re-POSTs the
        # SAME ``Idempotency-Key``, so SMR returns the first generation instead of re-billing.
        # The one residual (documented, accepted): an SMR 5xx / LM-Studio
        # ``terminated`` 400 arriving AFTER the model ran but BEFORE the response was cached —
        # the governor retries it and there is no cached result to replay.
        if exc.after_send:
            raise ApplicationError(str(exc), type="SmrResponseLost", non_retryable=True) from exc
        raise

    # Offload the generated note so the (large) content stays OUT of Temporal
    # history; on offload the inline ``content`` is emptied and the workflow threads
    # ``content_ref`` to the consumers (note-NER / sensors / persist) that resolve it.
    content_inline, content_ref = await _offload_text(settings, result.content)
    out = result if content_ref is None else result.model_copy(
        update={"content": content_inline, "content_ref": content_ref}
    )

    # LLM_CALL step embeds the ``stats`` verbatim;
    # a bounded-regen generation bumps ``harness_regen_total``. When SMR returned
    # non-empty reasoning, emit a stats-only THINKING step (payloadRef stays null until
    # a capture-payload policy flag is on — which it is not yet).
    batch = _TrajectoryBatch(settings, payload.trajectory)
    batch.record(
        step_type=STEP_LLM_CALL,
        name="generate",
        status=STATUS_OK,
        started=started,
        stats=result.stats,
    )
    reasoning = _reasoning_tokens(result.stats)
    if reasoning > 0:
        batch.record(
            step_type=STEP_THINKING,
            name="reasoning",
            status=STATUS_OK,
            started=started,
            stats={"reasoning_tokens": reasoning},
            offset=1,
        )
    if payload.trajectory is not None and payload.trajectory.is_regen:
        inc_regen()
    await batch.flush()
    return out


@activity.defn
async def retrieve_context(payload: RetrieveContextInput) -> RetrievedContext:
    """JIT hybrid retrieval for the generation prompt (flag-gated, degrade-safe).

    Off by default (``HARNESS_RETRIEVAL_ENABLED``) -> returns an empty context with no
    backend calls. When enabled, builds the query from the extracted entities and runs
    the dense+sparse -> RRF -> rerank pipeline (tenant + APPROVED scoped). Any backend
    outage degrades to an empty context (``degraded=True``); it never raises into the
    durable loop. Returns the reranked chunks + the ready-to-append StrictCitations block.
    """
    settings = get_settings()
    started = _now()
    batch = _TrajectoryBatch(settings, payload.trajectory)
    # the policy override (when non-null) wins over the env
    # kill-switch; None falls through to ``HARNESS_RETRIEVAL_ENABLED``.
    retrieval_enabled = _resolve_flag(payload.retrieval_enabled, env_default=settings.retrieval.enabled)
    if not retrieval_enabled:
        batch.record(
            step_type=STEP_RETRIEVAL,
            name="retrieve_context",
            status=STATUS_SKIPPED,
            started=started,
            stats={"enabled": False, "chunk_count": 0},
        )
        await batch.flush()
        return RetrievedContext()

    query = build_query(payload.entities)
    result = await _hybrid_retriever(settings).retrieve(query=query, tenant_id=payload.tenant_id)
    # Build the StrictCitations block from the FULL chunk text FIRST (it needs the text),
    # THEN offload each chunk's text so the reranked chunk texts don't enter
    # Temporal history; the inferential citation-verify pass resolves them inline-or-ref.
    prompt_block = build_strict_citations_block(result.chunks)
    chunks = []
    for chunk in result.chunks:
        inline, ref = await _offload_text(settings, chunk.text)
        chunks.append(
            chunk.model_copy(update={"text": inline, "text_ref": ref}) if ref is not None else chunk
        )
    batch.record(
        step_type=STEP_RETRIEVAL,
        name="retrieve_context",
        status=STATUS_OK,
        started=started,
        stats={"enabled": True, "chunk_count": len(chunks), "degraded": result.degraded},
    )
    await batch.flush()
    return RetrievedContext(chunks=chunks, degraded=result.degraded, prompt_block=prompt_block)


@activity.defn
async def run_sensors(payload: RunSensorsInput) -> SensorRunOutput:
    """Build the SensorContext + provenance and run all computational sensors.

    ``payload.thresholds`` is the policy-driven :class:`SensorThresholds`;
    ``None`` falls back to the sensors' own env-driven defaults.
    """
    # Resolve the (possibly offloaded) note + transcript inline-or-ref.
    settings = get_settings()
    started = _now()
    note_text = await _resolve_ref(settings, payload.note_text, payload.note_text_ref)
    transcript_text = await _resolve_ref(settings, payload.transcript_text, payload.transcript_text_ref)
    output = run_computational_sensors(
        note_text=note_text,
        transcript_text=transcript_text,
        note_entities=payload.note_entities,
        transcript_entities=payload.transcript_entities,
        response_format=payload.response_format,
        transcript_context_item_id=payload.transcript_context_item_id,
        retrieved_chunk_ids=payload.retrieved_chunk_ids,
        allowed_segment_ids=payload.allowed_segment_ids,
        thresholds=payload.thresholds,
    )
    batch = _TrajectoryBatch(settings, payload.trajectory)
    batch.record(
        step_type=STEP_SENSOR,
        name="run_sensors",
        status=STATUS_OK,
        started=started,
        stats={"sensor_count": len(output.results), "scores": output.scores},
    )
    await batch.flush()
    return output


def _groundedness_decision(result: SensorResult) -> dict[str, Any]:
    """Map the groundedness result to its guardrail-decision entry (regen-fixable)."""
    if result.degraded:
        return {"decision": "DEGRADED", "degraded": True, "reason": result.details.get("reason")}
    details = result.details
    return {
        # Severity class this sensor's failure maps to in the aggregator; the FINAL
        # gate verdict still depends on the regen budget.
        "decision": "PASS" if result.passed else "REGEN",
        "passed": result.passed,
        "score": round(result.score, 6),
        "ragTriadScore": details.get("rag_triad_score"),
        "ragTriad": details.get("rag_triad"),
        "sections": list(details.get("sections", [])),
        "ungrounded": list(details.get("ungrounded", [])),
        "claimsFlagged": list(result.claims_flagged),
    }


def _citation_verify_decision(result: SensorResult) -> dict[str, Any]:
    """Map the citation-verify result to its guardrail-decision entry (regen-fixable).

    On degrade (judge unavailable) it surfaces an ``"unverified"`` badge so the UI
    can flag that the StrictCitations could not be checked this run.
    """
    if result.degraded:
        return {
            "decision": "DEGRADED",
            "degraded": True,
            "badge": "unverified",
            "reason": result.details.get("reason"),
        }
    details = result.details
    return {
        "decision": "PASS" if result.passed else "REGEN",
        "passed": result.passed,
        "score": round(result.score, 6),
        "total": details.get("total", 0),
        "supported": details.get("supported", 0),
        "unverified": list(details.get("unverified", [])),
        "sections": list(details.get("sections", [])),
        "claimsFlagged": list(result.claims_flagged),
    }


def _atomic_fact_decision(result: SensorResult) -> dict[str, Any]:
    """Map the atomic-fact result to its guardrail-decision entry (regen-fixable).

    The DETERMINISTIC reference-free groundedness gate; on degrade
    (self-hosted NLI unavailable) it degrades so an unverifiable pass never auto-PASSes.
    """
    if result.degraded:
        return {"decision": "DEGRADED", "degraded": True, "reason": result.details.get("reason")}
    details = result.details
    return {
        "decision": "PASS" if result.passed else "REGEN",
        "passed": result.passed,
        "score": round(result.score, 6),
        "total": details.get("total", 0),
        "grounded": details.get("grounded", 0),
        "ungrounded": list(details.get("ungrounded", [])),
        "claimsFlagged": list(result.claims_flagged),
    }


def _safety_decision(result: SensorResult) -> dict[str, Any]:
    """Map the safety result to its guardrail-decision entry (highest-harm FLAG)."""
    if result.degraded:
        return {"decision": "DEGRADED", "degraded": True, "reason": result.details.get("reason")}
    details = result.details
    return {
        "decision": "PASS" if result.passed else "FLAG",
        "passed": result.passed,
        "score": round(result.score, 6),
        "unsafe": bool(details.get("unsafe", False)),
        "flaggedDimensions": list(details.get("flagged_dimensions", [])),
        "dimensions": dict(details.get("dimensions", {})),
        "model": details.get("model"),
    }


# Heartbeat cadence for the long inferential pass. The workflow sets
# ``heartbeat_timeout=60s`` on ``run_inferential_sensors``; a beat well inside that window
# lets Temporal detect a dead worker / hung attempt promptly (~60s) instead of waiting out
# the 900s ``start_to_close``. 15s gives ample margin under the 60s cap.
_HEARTBEAT_INTERVAL_S = 15.0


async def _heartbeat_periodically() -> None:
    """Emit an ``activity.heartbeat()`` immediately, then every ``_HEARTBEAT_INTERVAL_S``.

    Runs as a background task for the lifetime of ``run_inferential_sensors`` so a hung
    judge/guardian pass (or a dead worker) is surfaced to Temporal via the heartbeat
    timeout. Cancelled in the activity's ``finally`` once the pass returns.
    """
    while True:
        activity.heartbeat()
        await asyncio.sleep(_HEARTBEAT_INTERVAL_S)


def _assemble_inferential_output(
    results: list[SensorResult], verdict_cache: dict[str, bool] | None = None
) -> InferentialRunOutput:
    """Fold the inferential sensor results into the activity's typed output.

    ``verdict_cache`` is the content-addressed per-claim verdict map this pass
    saw + populated; it is echoed on the output so the workflow can thread it into the next
    regen pass. On a degrade it is the unchanged inbound cache (nothing new was judged).
    """
    by_name = {r.name: r for r in results}
    guardrail_decisions: dict[str, Any] = {}
    rag_triad_score: float | None = None

    grounded = by_name.get(GROUNDEDNESS_NAME)
    if grounded is not None:
        guardrail_decisions[GROUNDEDNESS_NAME] = _groundedness_decision(grounded)
        if not grounded.degraded:
            rag_triad_score = grounded.details.get("rag_triad_score")

    safety = by_name.get(SAFETY_NAME)
    if safety is not None:
        guardrail_decisions[SAFETY_NAME] = _safety_decision(safety)

    citation_verify = by_name.get(CITATION_VERIFY_NAME)
    if citation_verify is not None:
        guardrail_decisions[CITATION_VERIFY_NAME] = _citation_verify_decision(citation_verify)

    atomic_fact = by_name.get(ATOMIC_FACT_NAME)
    if atomic_fact is not None:
        guardrail_decisions[ATOMIC_FACT_NAME] = _atomic_fact_decision(atomic_fact)

    return InferentialRunOutput(
        results=results,
        guardrail_decisions=guardrail_decisions,
        rag_triad_score=rag_triad_score,
        degraded=any(r.degraded for r in results),
        verdict_cache=dict(verdict_cache or {}),
    )


def _build_assurance_publisher(
    settings: Settings,
    payload: RunInferentialSensorsInput,
    ctx: SensorContext,
) -> ClaimVerdictCallback | None:
    """Build the per-claim live publisher, or ``None`` when not streaming.

    Returns a best-effort ``on_claim`` callback only when
    the optimistic ASSURANCE pass asked for ``live_assurance`` AND the routing ids are
    present. It reuses the short-timeout, fire-and-forget progress client and swallows
    every error — the live feed can never degrade the durable assurance pass. ``total``
    mirrors the sensor's emission contract (one event per non-empty-text claim) so the
    UI sees a stable N-of-M counter.
    """
    if not (payload.live_assurance and payload.consultation_id and payload.tenant_id):
        return None

    consultation_id = payload.consultation_id
    tenant_id = payload.tenant_id
    job_id = payload.job_id
    total = sum(1 for c in ctx.claims() if str(c.get("text") or "").strip())
    ordinals = itertools.count(1)

    async def _publish(claim_ref: str, supported: bool) -> None:
        try:
            await _progress_api_client(settings).report_assurance_event(
                consultation_id,
                tenant_id=tenant_id,
                claim_id=claim_ref,
                sensor=GROUNDEDNESS_NAME,
                verdict="grounded" if supported else "ungrounded",
                ordinal=next(ordinals),
                total=total,
                job_id=job_id,
                # Per-claim key (activity run/id + claim) so a re-run of this
                # inferential activity dedups each claim event rather than double-posting.
                idempotency_key=_idempotency_key(claim_ref),
            )
        except Exception as exc:  # noqa: BLE001 — live feed is fire-and-forget
            activity.logger.warning(
                "harness.assurance_event.failed",
                extra={"consultation_id": consultation_id, "claim_id": claim_ref, "error": str(exc)},
            )

    return _publish


async def _run_atomic_fact_sensor(
    settings: Settings, ctx: SensorContext, threshold: float
) -> SensorResult:
    """Run the DETERMINISTIC reference-free atomic-fact verifier, degrading on any failure.

    Builds the self-hosted NLI entailer and runs the verifier over the
    (already PHI-redacted) ``ctx``. Any entailer BUILD failure degrades here (the sensor's
    own ``arun`` already degrades on a RUNTIME entailer error) — so an unverifiable
    atomic-fact pass is never a silent auto-PASS (fail-safe), and never raises into the
    inferential pass.
    """
    try:
        # Resolve the weight path inside the ACTIVITY (never
        # the workflow: no determinism impact, `workflows.py` untouched). The
        # control plane wins; env is the fallback, so behaviour is unchanged
        # until the effective-config `modelWeights` key appears.
        from harness.models.source_resolver import (
            ModelSourceConfig,
            resolve_atomic_fact_model_path,
        )

        model_path = await resolve_atomic_fact_model_path(
            getattr(settings, "effective_config_client", None),
            env_path=settings.atomic_fact_model_path,
            config=ModelSourceConfig(cache_dir=settings.atomic_fact_model_cache_dir),
        )
        # Call the incumbent single-arg form unless the control plane actually
        # supplied a path, so existing one-arg test doubles keep working and the
        # no-registry path is byte-for-byte the original call.
        entailer = (
            _atomic_fact_entailer(settings)
            if model_path is None
            else _atomic_fact_entailer(settings, model_path)
        )
    except Exception as exc:  # noqa: BLE001 — un-buildable NLI degrades, never raises
        return degraded_result(ATOMIC_FACT_NAME, f"atomic-fact NLI unavailable: {exc}")
    return await AtomicFactSensor(entailer, threshold=threshold).arun(ctx)


@activity.defn
async def run_inferential_sensors(payload: RunInferentialSensorsInput) -> InferentialRunOutput:
    """Run the costly inferential sensors (groundedness + safety) once, concurrently.

    Builds the calibrated judge + the Granite Guardian client a single time and fans
    them out via ``asyncio.gather`` (model calls live here, never in the workflow).
    Backend failures degrade rather than raise into the durable loop: each sensor
    self-degrades on a runtime backend outage, and an un-buildable judge degrades the
    whole pass. Returns the raw results + a guardrailDecisions map + ragTriadScore.
    """
    settings = get_settings()
    started = _now()
    batch = _TrajectoryBatch(settings, payload.trajectory)
    judge_config = get_runtime_judge_config()
    # the judge SELECTION (provider + model) is DB-driven: it comes from
    # the SYSTEM ``harness.judge`` policy, snapshotted onto the input at workflow
    # start. Env (``HARNESS_JUDGE_*``) supplies only the CONNECTION config
    # (base_url/api_key/tuning), never the selection. A missing selection FAILS
    # CLOSED below (the pass degrades) — it never falls back to an env-selected
    # judge, so an unverifiable note can never silently auto-PASS.
    judge_provider = payload.judge_provider
    judge_model = payload.judge_model

    async def _emit(out: InferentialRunOutput) -> InferentialRunOutput:
        # GUARDRAIL step for the (once-per-loop) inferential pass; degrade is carried in
        # stats (the pass returns an output on every path — it never raises into the loop).
        batch.record(
            step_type=STEP_GUARDRAIL,
            name="run_inferential_sensors",
            status=STATUS_OK,
            started=started,
            stats={"degraded": out.degraded, "rag_triad_score": out.rag_triad_score},
        )
        await batch.flush()
        return out

    # Seed the per-claim verdict cache from earlier passes (the L2 carrier).
    # The sensors reuse a cached verdict for an unchanged claim and re-judge only cache-missing
    # ones; we echo the (now-populated) cache on the output so the workflow threads it forward.
    # On any early degrade below, the unchanged inbound cache is returned (nothing was judged).
    verdict_cache: dict[str, bool] = dict(payload.prior_verdicts)

    # Enforce the fail-closed PHI egress guard before any cloud judge/Granite
    # call — redact the Granite-screened note (safety provider) and the judge premise
    # (transcript + per-claim hypotheses/evidence + knowledge chunks, judge provider).
    # Local providers (the default) are an identity no-op. A fail-closed block degrades
    # the whole inferential pass (reduced assurance) rather than raising into the loop —
    # the inferential degrade contract — so an unverifiable note never auto-PASSes.
    # Resolve the (possibly offloaded) note / transcript / chunk texts
    # inline-or-ref BEFORE the PHI-egress redaction + sensor pass.
    note_text_in = await _resolve_ref(settings, payload.note_text, payload.note_text_ref)
    transcript_text_in = await _resolve_ref(
        settings, payload.transcript_text, payload.transcript_text_ref
    )
    knowledge_chunks_in = await _resolve_knowledge_chunks(
        settings, payload.knowledge_chunks, payload.knowledge_chunks_ref
    )

    # fail closed when the SYSTEM harness.judge selection is absent. The
    # judge is required for BOTH judge sensors (groundedness + citation-verify), so a
    # missing selection degrades the whole judge-dependent pass (mirrors the existing
    # un-buildable-judge degrade) rather than silently using an env-selected judge.
    # Checked BEFORE the egress guard because that guard's cloud-redaction decision is
    # keyed on the effective (policy) judge provider.
    if not judge_provider or not judge_model:
        reason = "inferential judge unavailable: no SYSTEM harness.judge selection (fail-closed)"
        activity.logger.warning(
            "harness.judge.no_policy_selection",
            extra={"stage": "inferential", "reason": reason},
        )
        degraded = [
            degraded_result(GROUNDEDNESS_NAME, reason),
            degraded_result(CITATION_VERIFY_NAME, reason),
        ]
        if payload.safety_enabled:
            degraded.append(degraded_result(SAFETY_NAME, reason))
        return await _emit(_assemble_inferential_output(degraded, verdict_cache))

    try:
        note_text, transcript_text, citations_map, knowledge_chunks = (
            ensure_inferential_egress_safe(
                note_text=note_text_in,
                transcript_text=transcript_text_in,
                citations_map=payload.citations_map,
                knowledge_chunks=knowledge_chunks_in,
                judge_provider=judge_provider,
                safety_provider=settings.safety.provider if payload.safety_enabled else None,
                settings=settings,
                phi_enabled=payload.phi_enabled,
                phi_fail_closed=payload.phi_fail_closed,
                redactor=_phi_redactor(),
            )
        )
    except PhiEgressBlocked as exc:
        activity.logger.warning(
            "harness.phi_egress.blocked",
            extra={"provider": exc.provider, "reason": exc.reason, "stage": "inferential"},
        )
        reason = f"phi egress blocked for cloud provider {exc.provider!r}: {exc.reason}"
        degraded = [
            degraded_result(GROUNDEDNESS_NAME, reason),
            degraded_result(CITATION_VERIFY_NAME, reason),
        ]
        if payload.safety_enabled:
            degraded.append(degraded_result(SAFETY_NAME, reason))
        return await _emit(_assemble_inferential_output(degraded, verdict_cache))

    ctx = SensorContext(
        note_text=note_text,
        transcript_text=transcript_text,
        citations_map=citations_map,
        knowledge_chunks=knowledge_chunks,
    )

    # Heartbeat for the whole pass (the costly, many-call part) so a
    # hung attempt / dead worker is detected at heartbeat_timeout (60s) instead of the
    # 900s start_to_close. Cancelled in ``finally`` once the pass returns either way.
    heartbeat = asyncio.create_task(_heartbeat_periodically())
    try:
        try:
            judge = _build_runtime_judge(provider=judge_provider, model=judge_model)
        except Exception as exc:  # noqa: BLE001 — un-buildable judge degrades, never raises
            reason = f"inferential judge unavailable: {exc}"
            degraded = [
                degraded_result(GROUNDEDNESS_NAME, reason),
                degraded_result(CITATION_VERIFY_NAME, reason),
            ]
            # A disabled safety guard contributes no safety result at all.
            if payload.safety_enabled:
                degraded.append(degraded_result(SAFETY_NAME, reason))
            return await _emit(_assemble_inferential_output(degraded, verdict_cache))

        thresholds = SensorThresholds()
        # The groundedness pass threshold is policy-driven; the safety screen
        # is skipped entirely when the policy disables the safety guard.
        # Claim batching is env-driven (HARNESS_JUDGE_ENTAILMENT_BATCH_SIZE);
        # default 1 keeps the legacy one-call-per-claim path. Read from the same judge
        # config the runtime judge is built from.
        groundedness = GroundednessSensor(
            threshold=payload.groundedness_threshold,
            batch_size=judge_config.entailment_batch_size,
        )
        citation_verify = CitationVerifySensor(threshold=thresholds.citation_verify_threshold)
        # Stream each groundedness claim verdict to
        # apps/api as it resolves (optimistic ASSURANCE pass only). Best-effort: the
        # callback swallows every error so the live feed can NEVER degrade the pass.
        on_claim = _build_assurance_publisher(settings, payload, ctx)
        tasks = [
            groundedness.arun(ctx, judge=judge, on_claim=on_claim, verdict_cache=verdict_cache),
            # citation_verify reuses the SAME shared cache dict; its keys never
            # collide with groundedness (different premise + sensor identity), so the two verdicts
            # stay separable while both are reused across regen passes.
            citation_verify.arun(ctx, judge=judge, verdict_cache=verdict_cache),
        ]
        if payload.safety_enabled:
            # The safety screen reuses the SAME shared cache dict: each
            # per-(criterion, screened-text, model) verdict is content-addressed with a
            # "safety" sensor identity, so its keys never collide with groundedness/citation
            # entries while an unchanged-content regen pass reuses the prior screen (no Granite
            # call). No new carrier field / workflow command — the existing dict is threaded.
            tasks.append(
                SafetySensor(_granite_client(settings)).arun(
                    ctx, judge=judge, screen_cache=verdict_cache
                )
            )
        # The DETERMINISTIC reference-free atomic-fact verifier runs
        # ALONGSIDE the judge sensors (defense-in-depth), gated by the runtime ops
        # kill-switch (default OFF). It uses a SELF-HOSTED NLI (NOT the judge), so it adds
        # no cloud egress; a degraded backend degrades (never auto-PASS). Read at runtime
        # here — not the workflow — so it adds no new workflow command (replay-safe).
        # the policy override (when non-null) wins over the env
        # kill-switch; None falls through to ``HARNESS_ATOMIC_FACT_ENABLED``.
        if _resolve_flag(payload.atomic_fact_enabled, env_default=settings.atomic_fact_enabled):
            tasks.append(
                _run_atomic_fact_sensor(settings, ctx, thresholds.atomic_fact_threshold)
            )
        results = list(await asyncio.gather(*tasks))
        return await _emit(_assemble_inferential_output(results, verdict_cache))
    finally:
        heartbeat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat


def _needs_semantic_rewrite(rule: RedactionRule) -> bool:
    """A ``rewrite`` rule with NO literal ``replacement`` ⇒ the SMR semantic pass."""
    return rule.type == "rewrite" and rule.replacement is None


def _build_rewrite_prompt(text: str, rules: list[RedactionRule]) -> str:
    """A constrained rewrite instruction for the SMR semantic pass.

    The model is told to REMOVE/soften the described spans and change nothing else —
    it must never add clinical content and must return the SAME JSON shape it was given.
    """
    directives = "\n".join(
        f"- {r.note or f'redact matches of category/pattern {r.pattern!r}'}" for r in rules
    )
    return (
        "You are a redaction transform. Apply ONLY the following removal/rewrite "
        "instructions to the clinical note below. Do NOT add any new content, do NOT "
        "change facts, doses, or citation markers like [[seg:...]]. Return the note in "
        "the SAME structure/format you received.\n\n"
        f"Instructions:\n{directives}\n\nNote:\n{text}"
    )


@activity.defn
async def apply_redaction(payload: ApplyRedactionInput) -> ApplyRedactionResult:
    """DNA redaction/rewrite — a SEPARATE, auditable post-generation transform (TASK-551).

    Runs AFTER the computational-sensor loop settles and BEFORE persist/delivery so the
    persisted/delivered note is the redacted one and the sensors validate the FINAL text.

    Two passes:

    1. **Deterministic** — literal/regex/category ``remove`` rules and ``rewrite`` rules
       that carry a literal ``replacement``. Pure, replay-neutral. A malformed rule that
       reaches the engine fails CLOSED (see below).
    2. **Optional SMR semantic rewrite** — ``rewrite`` rules with no literal replacement.
       One constrained SMR call, PHI-egress guarded + idempotency-keyed exactly like
       ``generate``; the output must preserve the note's JSON schema.

    **Fail CLOSED**: if the deterministic engine raises OR a required SMR rewrite cannot be
    completed/parsed, the result carries ``failed_closed=True`` (the workflow forces a FLAG).
    A note the doctor expected redacted must never slip through silently. The audit
    ``manifest`` carries spans + counts only — never removed PHI plaintext.
    """
    settings = get_settings()
    text = await _resolve_ref(settings, payload.note_text, payload.note_text_ref)

    if not payload.rules:
        # No rules ⇒ pure no-op (the default, and every legacy/patched-off path).
        return ApplyRedactionResult(text=text, changed=False, manifest=RedactionManifest())

    deterministic = [r for r in payload.rules if not _needs_semantic_rewrite(r)]
    semantic = [r for r in payload.rules if _needs_semantic_rewrite(r)]

    # 1) Deterministic pass — fail closed on a malformed rule (never a silent leak).
    try:
        outcome = apply_deterministic_redaction(text, deterministic)
    except RedactionEngineError as exc:
        activity.logger.warning(
            "harness.redaction.failed_closed",
            extra={"stage": "deterministic", "reason": str(exc)},
        )
        return ApplyRedactionResult(
            text=text, changed=False, failed_closed=True, manifest=RedactionManifest()
        )

    working = outcome.text
    manifest = outcome.manifest

    # 2) Optional SMR semantic-rewrite pass — fail closed on ANY failure.
    if semantic:
        redactor = _phi_redactor()
        prompt = _build_rewrite_prompt(working, semantic)
        try:
            safe_prompt = ensure_egress_safe(
                prompt,
                provider=payload.provider,
                settings=settings,
                phi_enabled=payload.phi_enabled,
                phi_fail_closed=payload.phi_fail_closed,
                redactor=redactor,
            )
            result = await _smr_client(settings).generate(
                prompt=safe_prompt,
                provider=payload.provider,
                model=payload.model,
                response_format=payload.response_format,
                idempotency_key=_idempotency_key("redaction"),
            )
        except (PhiEgressBlocked, SmrServiceError) as exc:
            activity.logger.warning(
                "harness.redaction.failed_closed",
                extra={"stage": "smr_rewrite", "reason": str(exc)},
            )
            return ApplyRedactionResult(
                text=working,
                changed=manifest.applied,
                failed_closed=True,
                manifest=manifest,
            )
        rewritten = result.content
        # If a JSON schema was requested, the rewrite MUST still parse — otherwise
        # fail closed rather than deliver a structurally broken note.
        if payload.response_format is not None:
            try:
                json.loads(rewritten)
            except (json.JSONDecodeError, TypeError) as exc:
                activity.logger.warning(
                    "harness.redaction.failed_closed",
                    extra={"stage": "smr_rewrite_schema", "reason": str(exc)},
                )
                return ApplyRedactionResult(
                    text=working,
                    changed=manifest.applied,
                    failed_closed=True,
                    manifest=manifest,
                )
        working = rewritten
        manifest = RedactionManifest(
            applied=True,
            total_hits=manifest.total_hits + len(semantic),
            hits_by_rule={**manifest.hits_by_rule, **{r.id: 1 for r in semantic}},
            hits=manifest.hits,
        )

    text_out, text_ref = await _offload_text(settings, working)
    return ApplyRedactionResult(
        text=text_out,
        text_ref=text_ref,
        changed=working != text,
        failed_closed=False,
        manifest=manifest,
    )


@activity.defn
async def persist_draft(payload: PersistDraftInput) -> DraftResponse:
    """Persist the generated draft (ContextItem + SummaryMeta + PENDING_REVIEW).

    ``payload.phase == "DRAFT_PENDING_SENSORS"`` switches apps/api
    to the optimistic early persist (verdict withheld, GENERATE-only audit); absent
    (legacy) keeps the single-shot persist (full scores, straight to PENDING_REVIEW).
    """
    settings = get_settings()
    started = _now()
    # Resolve the (possibly offloaded) draft content — apps/api still receives
    # the fully-materialized note (the persist contract is unchanged).
    content = await _resolve_ref(settings, payload.content, payload.content_ref)
    result = await _api_client(settings).persist_draft(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        content=content,
        user_id=payload.user_id,
        job_id=payload.job_id,
        model_name=payload.model_name,
        model_version=payload.model_version,
        sensor_scores=payload.sensor_scores,
        citations_map=payload.citations_map,
        guardrail_decisions=payload.guardrail_decisions,
        reduced_assurance=payload.reduced_assurance,
        entity_faithfulness_score=payload.entity_faithfulness_score,
        coverage_score=payload.coverage_score,
        rag_triad_score=payload.rag_triad_score,
        prompt_template_id=payload.prompt_template_id,
        prompt_version=payload.prompt_version,
        dna_style_id=payload.dna_style_id,
        gate_decision=payload.gate_decision,
        is_auto_generated=payload.is_auto_generated,
        phase=payload.phase,
        idempotency_key=_idempotency_key(),
    )
    # count the gate verdict EXACTLY ONCE per completed session.
    # The single-shot (legacy) persist carries the verdict; the optimistic early persist
    # withholds it (``gate_decision is None`` ⇒ no count here — finalize/retract counts it).
    if payload.gate_decision is not None:
        inc_gate_decision(payload.gate_decision)
    batch = _TrajectoryBatch(settings, payload.trajectory)
    batch.record(
        step_type=STEP_PHASE,
        name="persist_draft",
        status=STATUS_OK,
        started=started,
        stats={"context_item_id": result.context_item_id, "phase": payload.phase},
    )
    await batch.flush()
    return result


@activity.defn
async def finalize_assurance(payload: FinalizeAssuranceInput) -> FinalizeAssuranceResponse:
    """Backfill the early-persisted draft with the inferential verdict.

    Second phase of optimistic delivery: apps/api stamps the inferential scores +
    gate verdict + ``assuranceCompletedAt`` onto the early ``SummaryMeta``, flips
    ``DRAFT_PENDING_SENSORS → PENDING_REVIEW``, and records the deferred ``SENSOR_RUN``
    (+ ``REDUCED_ASSURANCE``) WORM audit. Idempotent on the apps/api side (a retry
    re-stamps the same verdict without regressing state).
    """
    settings = get_settings()
    started = _now()
    result = await _api_client(settings).finalize_assurance(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        context_item_id=payload.context_item_id,
        context_item_version_id=payload.context_item_version_id,
        user_id=payload.user_id,
        job_id=payload.job_id,
        sensor_scores=payload.sensor_scores,
        citations_map=payload.citations_map,
        guardrail_decisions=payload.guardrail_decisions,
        reduced_assurance=payload.reduced_assurance,
        rag_triad_score=payload.rag_triad_score,
        gate_decision=payload.gate_decision,
        model_name=payload.model_name,
        model_version=payload.model_version,
        prompt_template_id=payload.prompt_template_id,
        prompt_version=payload.prompt_version,
        idempotency_key=_idempotency_key(),
    )
    # the optimistic path counts the gate verdict HERE (the early
    # persist withheld it), so the counter still fires exactly once per completed session.
    if payload.gate_decision is not None:
        inc_gate_decision(payload.gate_decision)
    batch = _TrajectoryBatch(settings, payload.trajectory)
    batch.record(
        step_type=STEP_PHASE,
        name="finalize_assurance",
        status=STATUS_OK,
        started=started,
        stats={"gate_decision": payload.gate_decision},
    )
    await batch.flush()
    return result


@activity.defn
async def retract_draft(payload: RetractDraftInput) -> RetractDraftResponse:
    """Retract an optimistically-delivered draft that later failed assurance.

    The optimistic path calls this INSTEAD of ``finalize_assurance`` when the post-delivery
    assurance pass FLAGs: apps/api marks the delivered ``DRAFT_PENDING_SENSORS`` draft
    ``RETRACTED``, writes the WORM audit (carrying the FLAG verdict + the offending
    atomic/claim refs), and surfaces a clinician-facing retraction event — the safety net
    for the accepted pre-assurance sign-off window. Idempotent on the apps/api
    side (the stable ``_idempotency_key`` dedups a retried retraction, so a bounded retry
    never double-writes). Raises :class:`ApiServiceError` on transport/HTTP error; the
    workflow retries under ``_API_RETRY``.
    """
    settings = get_settings()
    started = _now()
    result = await _api_client(settings).retract_draft(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        context_item_id=payload.context_item_id,
        context_item_version_id=payload.context_item_version_id,
        gate_decision=payload.gate_decision,
        reason=payload.reason,
        claims_flagged=payload.claims_flagged,
        sensor_scores=payload.sensor_scores,
        guardrail_decisions=payload.guardrail_decisions,
        reduced_assurance=payload.reduced_assurance,
        rag_triad_score=payload.rag_triad_score,
        user_id=payload.user_id,
        job_id=payload.job_id,
        idempotency_key=_idempotency_key(),
    )
    # a retraction is a terminal FLAG verdict — count it once here
    # (the early persist withheld it), and emit a GATE step for the retraction event.
    if payload.gate_decision is not None:
        inc_gate_decision(payload.gate_decision)
    batch = _TrajectoryBatch(settings, payload.trajectory)
    batch.record(
        step_type=STEP_GATE,
        name="retract_draft",
        status=STATUS_OK,
        started=started,
        stats={"gate_decision": payload.gate_decision, "reason": payload.reason},
    )
    await batch.flush()
    return result


@activity.defn
async def record_gate_decision(payload: RecordGateInput) -> RecordGateResponse:
    """Record the clinician GATE_DECISION (WORM audit) via apps/api."""
    settings = get_settings()
    started = _now()
    result = await _api_client(settings).record_gate_decision(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        decision=payload.decision,
        gate_decision=payload.gate_decision,
        user_id=payload.user_id,
        context_item_version_id=payload.context_item_version_id,
        attestation_hash=payload.attestation_hash,
        clinician_id=payload.clinician_id,
        idempotency_key=_idempotency_key(),
    )
    batch = _TrajectoryBatch(settings, payload.trajectory)
    batch.record(
        step_type=STEP_GATE,
        name="record_gate_decision",
        status=STATUS_OK,
        started=started,
        stats={"decision": payload.decision, "gate_decision": payload.gate_decision},
    )
    await batch.flush()
    return result


@activity.defn
async def report_progress(payload: ReportProgressInput) -> ReportProgressResult:
    """Publish one workflow stage event to the live UI feed.

    Fire-and-forget by contract: ALL errors are swallowed (logged + ``reported=False``)
    so a down progress pipeline can never fail — or even retry-delay — the loop.
    """
    settings = get_settings()
    try:
        resp = await _progress_api_client(settings).report_progress(
            payload.consultation_id,
            tenant_id=payload.tenant_id,
            stage=payload.stage,
            label=payload.label,
            ordinal=payload.ordinal,
            total=payload.total,
            job_id=payload.job_id,
            idempotency_key=_idempotency_key(),
        )
        return ReportProgressResult(reported=bool(resp.ok))
    except Exception as exc:  # noqa: BLE001 — best-effort by design, never raise
        activity.logger.warning(
            "harness.report_progress.failed",
            extra={
                "consultation_id": payload.consultation_id,
                "stage": payload.stage,
                "error": str(exc),
            },
        )
        return ReportProgressResult(reported=False)


@activity.defn
async def escalate_gate(payload: EscalateInput) -> EscalateResult:
    """Escalate an un-signed gate past its SLA: RECORD the breach to apps/api + log.

    The breach is now durably recorded / notifiable via apps/api
    instead of a local log-only no-op. Fail-safe by contract — a failed record is
    swallowed (logged) and the gate keeps waiting, so a down escalation endpoint (e.g.
    before the coordinated apps/api route lands) never fails the clinical loop. The
    idempotency key dedups the retried record (``_API_RETRY`` at the workflow call site).
    """
    activity.logger.warning(
        "harness.gate.sla_breached",
        extra={
            "consultation_id": payload.consultation_id,
            "tenant_id": payload.tenant_id,
            "reason": payload.reason,
            "job_id": payload.job_id,
        },
    )
    settings = get_settings()
    try:
        await _api_client(settings).record_escalation(
            payload.consultation_id,
            tenant_id=payload.tenant_id,
            reason=payload.reason,
            job_id=payload.job_id,
            idempotency_key=_idempotency_key(),
        )
    except Exception as exc:  # noqa: BLE001 — best-effort: an escalation record must never fail the gate
        activity.logger.warning(
            "harness.gate.escalation_record_failed",
            extra={
                "consultation_id": payload.consultation_id,
                "reason": payload.reason,
                "error": str(exc),
            },
        )
    return EscalateResult(escalated=True)


# Registered on the worker alongside ``ping_activity``.
DOCUMENT_ACTIVITIES: list[Callable[..., Any]] = [
    fetch_policy,
    extract_entities,
    call_mcp_tool,
    persist_entities,
    assemble_prompt,
    retrieve_context,
    generate,
    run_sensors,
    run_inferential_sensors,
    apply_redaction,
    persist_draft,
    finalize_assurance,
    retract_draft,
    record_gate_decision,
    escalate_gate,
    report_progress,
]
