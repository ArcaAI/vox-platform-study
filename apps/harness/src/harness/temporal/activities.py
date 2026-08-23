"""Temporal activities.

Activities are where all non-deterministic work lives — network calls, model
inference, tool invocations, clock/random access. They are retryable and must
be idempotent. The workflow body (see ``workflows.py``) stays deterministic and
delegates every side effect here.

``ping_activity`` is a trivial placeholder that proves the substrate. The
document-loop activities below are thin wrappers over the typed httpx tool
clients (NLP/Text/apps-api) + the pure sensor runner; they read settings at
runtime (allowed in activities) and construct a client per call.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import itertools
import json
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from harness.core.config import Settings, get_runtime_judge_config, get_settings
from harness.core.consent_client import ConsentClient, ConsentDecision, build_consent_client
from harness.core.effective_config import get_effective_config_client
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
from harness.sensors.config import SensorThresholds, resolve_sensor_thresholds
from harness.sensors.inferential import (
    ATOMIC_FACT_NAME,
    CITATION_VERIFY_NAME,
    GROUNDEDNESS_NAME,
    SAFETY_NAME,
    AtomicFactSensor,
    CitationVerifySensor,
    DeterministicOverlapEntailer,
    GroundednessSensor,
    GuardrailSafetyScreen,
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
    SttBatchJobResponse,
    TrajectoryStepInput,
)
from harness.services.embeddings_client import EmbeddingsClient
from harness.services.guardrail_client import GuardrailClient
from harness.services.nlp_client import NlpClient
from harness.services.reranker_client import RerankerClient
from harness.services.sensor_runner import SensorRunOutput, run_computational_sensors
from harness.services.text_client import TextClient, TextGenerationResult, TextServiceError
from harness.temporal.claim_check import (
    ClaimCheckRef,
    build_blob_store,
    load_blob,
    maybe_offload,
    resolve_min_bytes,
)
from harness.temporal.models import (
    AGENT_ROLE_SPECIALIST,
    LOOP_EVENT_ADJUDICATED,
    PRIMARY_ONLY_OUTPUT_KINDS,
    ApplyRedactionInput,
    ApplyRedactionResult,
    AssembleInput,
    CallMcpToolInput,
    ConsultationLoopConfig,
    DeriveContextInput,
    DeriveContextResult,
    DispatchBatchTranscriptionInput,
    DispatchBatchTranscriptionOutput,
    EmitLoopEventInput,
    EmitLoopEventResult,
    EntitiesResult,
    EscalateInput,
    EscalateResult,
    ExtractEntitiesInput,
    FetchLoopConfigInput,
    FetchPolicyInput,
    FinalizeAssuranceInput,
    GenerateInput,
    HarnessPolicy,
    InferentialRunOutput,
    LiveDocControlInput,
    LiveDocControlResult,
    LoopAgentSpec,
    LoopBudget,
    LoopSubscription,
    McpToolCallResult,
    PersistDraftInput,
    PersistEntitiesInput,
    PlanDecision,
    PlanLoopInput,
    PlannedSpecialist,
    RecordAdjudicationInput,
    RecordGateInput,
    ReportProgressInput,
    ReportProgressResult,
    RetractDraftInput,
    RetrieveContextInput,
    RetrievedContext,
    RunInferentialSensorsInput,
    RunSensorsInput,
    SpecialistAnalysisInput,
    SpecialistFinding,
    SpecialistResult,
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
# One interpreter (TASK-718) node dispatch — describes a WorkflowInterpreter node, not a
# HarnessDocWorkflow phase; kept in this shared vocabulary (rather than a second enum) so both
# workflow types feed the same trajectory read model.
STEP_NODE = "NODE"
# Terminal step statuses (STARTED is reserved for a future streaming variant; the
# harness emits terminal spans carrying startedAt+endedAt to bound the call count).
STATUS_OK = "OK"
STATUS_ERROR = "ERROR"
STATUS_SKIPPED = "SKIPPED"
# "Completed, but not fully." The interpreter's per-node DEGRADED outcome — persisted as itself
# rather than collapsed into ERROR (TASK-789 C-10), so a partially-degraded graph is
# distinguishable in the trace from one that failed outright.
STATUS_DEGRADED = "DEGRADED"


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


# Owner decision D-D (2026-08-17): every outbound hop PRESENTS the ONE shared
# `INTERNAL_ACCESS_TOKEN`. The legacy per-target secrets (`HARNESS_NLP_SERVICE_TOKEN`,
# `HARNESS_TEXT_SERVICE_TOKEN`, `HARNESS_SERVICE_TOKEN`) remain only as the fallback
# for an environment that has not been migrated yet — `peer_service_token` encodes
# "shared first, legacy second" in one place so no factory can drift from it.
# TASK-737 — every peer call out of an activity must carry the tenant its work
# belongs to. The workflow input models all carry it (required on the newer ones,
# additive-optional with "" on `GenerateInput`/`ApplyRedactionInput` so an OLD
# Temporal history still deserializes and replays). This is the one place that
# turns "the input had no tenant" into a loud, attributable failure instead of a
# silent platform-default resolution one or two hops downstream.
#
# Genuinely tenant-less internal work does NOT come through here — it declares
# itself with a `tenantless:<reason>` marker, which passes this check untouched.
def _required_tenant(tenant_id: str | None, activity_name: str) -> str:
    resolved = (tenant_id or "").strip()
    if not resolved:
        raise ValueError(
            f"harness activity {activity_name!r} has no tenant_id (TASK-737). A peer "
            "call carrying tenant-scoped work must identify its tenant; an absent one "
            "is a defect in the workflow that scheduled this activity, not something "
            "the callee should resolve to a platform default."
        )
    return resolved


def _nlp_client(settings: Settings) -> NlpClient:
    return NlpClient(
        settings.nlp_base_url,
        timeout=settings.nlp_timeout_s,
        service_token=settings.peer_service_token(settings.nlp_service_token),
    )


def _text_client(settings: Settings) -> TextClient:
    return TextClient(
        settings.text_base_url,
        timeout=settings.text_timeout_s,
        service_token=settings.peer_service_token(settings.text_service_token),
    )


def _api_client(settings: Settings) -> ApiClient:
    return ApiClient(
        settings.api_base_url,
        internal_prefix=settings.api_internal_prefix,
        service_token=settings.peer_service_token(settings.service_token),
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


def _draft_idempotency_key(consultation_id: str, content: str) -> str:
    """Idempotency-Key for the DRAFT persist — derived from the WRITE, not the execution.

    ``_idempotency_key`` above is correct for callbacks whose duplicate is always a
    RETRY of one invocation. The draft persist is not one of those: ``HarnessDocWorkflow``
    has TWO start sites (``ConsultationEventHandler`` via ``internal.py`` and the loop's
    ``harness.finalize`` child), both targeting the deterministic id
    ``harness-doc-{consultation_id}`` with no ``id_reuse_policy``. Temporal's default
    ``ALLOW_DUPLICATE`` therefore rejects the second start ONLY while the first execution
    is still open, so a second EXECUTION — new ``workflow_run_id`` — is routine (a legacy
    run that already completed, or a late transcript after the loop finalized). A
    run-scoped key makes those two writes look unrelated, and the clinical note is
    duplicated.

    The stable identity of this write is the consultation plus the note it carries:

    * ``consultation_id`` — the same across every execution for this consultation, and
      never shared with another consultation.
    * a digest of the resolved note ``content`` — this is what keeps a LEGITIMATE
      re-delivery working. The optimistic path re-persists a REGENERATED note through
      this same activity, and a key that ignored the content would let the gateway's
      replay cache swallow that better note as a "duplicate". A changed note is a
      changed key, so it reaches the gateway and UPDATES the draft.

    Deliberately NOT derived from ``workflow_run_id``/``activity_id``. This value is
    computed inside an activity body, so the workflow records no new command and no
    ``workflow.patched`` era is required.
    """
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return f"draft:{consultation_id}:{digest}"


def _entities_idempotency_key(consultation_id: str, entities: Sequence[Any]) -> str:
    """Idempotency-Key for the ENTITY persist — derived from the WRITE, not the execution.

    Same reasoning as ``_draft_idempotency_key``: ``persist_entities`` is duplicated by a
    second workflow EXECUTION (a new ``workflow_run_id``), not merely by an activity
    retry, so a run-scoped key makes the two writes look unrelated and every
    ``NamedEntity`` row — encrypted PHI — is inserted twice.

    Identity = the consultation plus a digest of the extracted entity set. The digest is
    what keeps a LEGITIMATE re-extraction working: a genuinely different entity set is a
    different key, so it reaches the gateway instead of being swallowed as a duplicate.

    This key is only the FAST PATH. ``withHarnessIdempotency`` degrades to running the
    work whenever Redis is absent or throws, so the row invariant lives in the gateway's
    write path (``persistEntities`` adopts its own prior rows); this merely avoids the
    round trip when the cache is healthy.

    Computed inside an activity body ⇒ no new workflow command, no ``workflow.patched``
    era.
    """
    payload = json.dumps(
        [e.model_dump(mode="json") if hasattr(e, "model_dump") else e for e in entities],
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"entities:{consultation_id}:{digest}"


# Progress reporting is fire-and-forget: a dedicated short HTTP
# timeout so a wedged API never holds a stage transition hostage for the full
# standard budget.
_PROGRESS_HTTP_TIMEOUT_S = 5.0


def _progress_api_client(settings: Settings) -> ApiClient:
    return ApiClient(
        settings.api_base_url,
        internal_prefix=settings.api_internal_prefix,
        service_token=settings.peer_service_token(settings.service_token),
        timeout=min(_PROGRESS_HTTP_TIMEOUT_S, settings.api_timeout_s),
    )


# trajectory reporting is fire-and-forget (like progress) —
# a short HTTP timeout so a wedged gateway never holds a phase boundary hostage.
_TRAJECTORY_HTTP_TIMEOUT_S = 5.0


def _trajectory_api_client(settings: Settings) -> ApiClient:
    return ApiClient(
        settings.api_base_url,
        internal_prefix=settings.api_internal_prefix,
        service_token=settings.peer_service_token(settings.service_token),
        timeout=min(_TRAJECTORY_HTTP_TIMEOUT_S, settings.api_timeout_s),
    )


def _reasoning_tokens(stats: dict[str, Any] | None) -> int:
    """Best-effort reasoning-token count from a ``GenerationStats`` dict.

    ``TextGenerationResult`` has no dedicated reasoning field yet, so we read it
    defensively from the stats block (top-level ``reasoning_tokens`` or the
    engine-native OpenAI-wire ``completion_tokens_details.reasoning_tokens``). A
    positive count is the "Text returned non-empty reasoning" signal for the
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


def _build_runtime_judge(*, provider: str | None = None, model: str | None = None) -> JudgeClient:
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


def _safety_screen_client(settings: Settings, tenant_id: str) -> GuardrailSafetyScreen:
    """Build the safety screen — a DELEGATION to ``apps/guardrail``, not a local engine.

    Harness used to construct an IBM Granite Guardian client here from
    ``settings.safety`` (provider / base_url / model / harm-criteria taxonomy in env) and
    post at an OpenAI-compatible endpoint itself, which is the second inference stack rule
    06 forbids. It now uses the SAME ``GuardrailClient`` the interpreter lane already used
    (``temporal/interpreter/nodes/guardrail_check.py``); guardrail owns the policy, the
    tenant-resolved taxonomy and the engine delegation.

    Factored out like the other client factories so tests can monkeypatch it with a stub.
    """
    return GuardrailSafetyScreen(
        GuardrailClient(
            settings.guardrail_base_url,
            # The shared `INTERNAL_ACCESS_TOKEN`, legacy-falling-back to guardrail's own
            # token — NOT `HARNESS_SERVICE_TOKEN`, which apps/guardrail never accepts.
            # Same credential choice as the interpreter lane's guardrail hop (D-D).
            service_token=settings.peer_service_token(settings.guardrail_service_token),
            timeout=settings.guardrail_timeout_s,
        ),
        tenant_id=tenant_id,
    )


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


# TASK-712 (consent-abac Phase 4) — process-lifetime singleton, UNLIKE the
# other client factories above. ConsentClient carries an in-process TTL cache
# whose whole purpose is to survive ACROSS activity invocations (a Temporal
# worker handles many activity calls over its life on the same event loop);
# rebuilding it every call (the ``_mcp_client``/``_api_client`` pattern) would
# silently disable the cache. Tests monkeypatch ``_consent_client`` itself
# (same convention as every other client factory here), so the singleton is
# never exercised in the hermetic suite.
_consent_client_singleton: ConsentClient | None = None


def _consent_client(_settings: Settings) -> ConsentClient:
    """The worker's consent-assert client (lazy singleton — see note above)."""
    global _consent_client_singleton
    if _consent_client_singleton is None:
        _consent_client_singleton = build_consent_client()
    return _consent_client_singleton


async def _check_consent(
    settings: Settings,
    *,
    tenant_id: str | None,
    external_patient_id: str | None,
    purpose: str,
    scope: dict[str, Any] | None = None,
    consultation_id: str | None = None,
    tool_name: str | None = None,
) -> ConsentDecision:
    """Evaluate consent for a gated stage, UNAVAILABLE (not a crash) when the
    caller has not threaded identity through yet.

    A missing ``tenant_id``/``external_patient_id`` is a WIRING gap (an
    upstream caller — e.g. the ConsultationLoopWorkflow finalize-child path —
    has not been upgraded to send ``external_patient_id`` on
    :class:`~harness.temporal.models.HarnessDocWorkflowInput`), not a genuine
    consent denial. Both fail closed (R4), but reporting it as ``unavailable``
    keeps a real compliance denial distinguishable from a configuration gap in
    the trajectory and in alerting.
    """
    if not tenant_id or not external_patient_id:
        logger.warning(
            "harness.consent.identity_missing",
            purpose=purpose,
            tenant_id=tenant_id,
            has_external_patient_id=bool(external_patient_id),
        )
        return ConsentDecision(allowed=False, unavailable=True)

    return await _consent_client(settings).check(
        tenant_id=tenant_id,
        external_patient_id=external_patient_id,
        purpose=purpose,
        scope=scope,
        consultation_id=consultation_id,
        tool_name=tool_name,
    )


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
        text,
        store=build_blob_store(cc),
        bucket=cc.bucket,
        # PLATFORM default from the control plane, env as the bootstrap floor beneath it
        # (TASK-799 A.2). A failed read keeps `cc.min_bytes`, so a degraded control plane
        # leaves the offload behaviour byte-identical.
        min_bytes=resolve_min_bytes(await _config_snapshot(), cc.min_bytes),
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


# F-23 — ``ApiServiceError`` (api_client.py) wraps every transport/HTTP failure into
# a single string (``f"apps/api {path} failed: {exc}"``); it does not carry a
# structured status code. httpx's own ``HTTPStatusError`` message embeds the status
# as ``'<code> <reason>'`` (e.g. "Client error '401 Unauthorized' for url ..."), so a
# 401/403 is recognizable by pattern even without a dedicated attribute. Kept
# deliberately narrow (401/403 only) so genuine transport/5xx outages are never
# misclassified as an auth problem.
_POLICY_AUTH_STATUS_RE = re.compile(r"'\s*(401|403)\b")


def _is_policy_auth_failure(exc: Exception) -> bool:
    """True when ``exc`` (an ``ApiServiceError`` from ``fetch_policy``) wraps an
    HTTP 401/403 — i.e. an auth/misconfiguration failure, not a transient outage."""
    return bool(_POLICY_AUTH_STATUS_RE.search(str(exc)))


@activity.defn
async def fetch_policy(payload: FetchPolicyInput) -> HarnessPolicy:
    """Read the effective harness policy for the tenant (live policy injection).

    I/O lives here, never the workflow body. Raises :class:`ApiServiceError` on an
    unreachable endpoint; the workflow catches the resulting ``ActivityError`` and
    degrades to the code defaults (fail-safe — never crash the loop).

    A 401/403 from the gateway (``HarnessServiceTokenGuard`` rejecting a missing/
    wrong ``X-Service-Token`` — almost always ``HARNESS_SERVICE_TOKEN``
    misconfiguration) is reclassified here as a distinct, non-retryable
    ``PolicyAuthError`` with a loud structured log — the workflow's catch is
    UNCHANGED (it still degrades to ``reduced_assurance`` either way); only the
    activity-side error type/log differentiates "misconfigured, should be loud"
    from "transient outage, expected, quiet."
    """
    settings = get_settings()
    started = _now()
    # Thread the consultation id (when present) so the gateway overlays
    # the department default agent's tenant-tier harnessOverrides. Omitting the
    # kwarg when absent keeps the request byte-identical for non-agent runs.
    client = _api_client(settings)
    try:
        if payload.consultation_id:
            data = await client.get_policy(
                payload.tenant_id, consultation_id=payload.consultation_id
            )
        else:
            data = await client.get_policy(payload.tenant_id)
    except ApiServiceError as exc:
        if _is_policy_auth_failure(exc):
            logger.error(
                "harness.policy_auth_failed",
                tenant_id=payload.tenant_id,
                consultation_id=payload.consultation_id,
                error=str(exc),
                hint=(
                    "gateway rejected the policy fetch with 401/403 — "
                    "HARNESS_SERVICE_TOKEN is likely missing or misconfigured "
                    "(HarnessServiceTokenGuard is fail-closed)"
                ),
            )
            raise ApplicationError(
                f"policy fetch auth failure: {exc}",
                type="PolicyAuthError",
                non_retryable=True,
            ) from exc
        raise
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
    ner_priors_enabled = _resolve_flag(
        payload.ner_priors_enabled, env_default=settings.ner_priors_enabled
    )
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
    entities = await _nlp_client(settings).classify_tokens(
        text,
        tenant_id=_required_tenant(payload.tenant_id, "extract_entities"),
        language=payload.language,
    )
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

    0.5. **Consent** (TASK-712, consent-abac Phase 4) — the caller's
       ``(tenant_id, external_patient_id)`` must hold an active
       ``EXTERNAL_TOOL_LOOKUP`` grant. Checked BEFORE the allowlist (a consent
       failure is not a configuration problem). Raises a non-retryable
       ``ApplicationError`` — ``type="ConsentDenied"`` for a genuine denial,
       ``type="ConsentUnavailable"`` for a lookup failure or missing identity
       (R4 — both fail closed, never conflated).
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

    # (0.5) Consent (TASK-712, consent-abac Phase 4) — BEFORE the allowlist, so a
    # consent denial is distinguishable from a configuration/policy denial in the
    # trajectory (README §2.3: "consent becomes step (0.5), before the allowlist,
    # because a consent failure is not a configuration problem"). Both a genuine
    # denial and an UNAVAILABLE lookup (R4) block the call — the trajectory
    # error_code and the raised ApplicationError.type are what stay distinguishable.
    consent = await _check_consent(
        settings,
        tenant_id=payload.tenant_id,
        external_patient_id=payload.external_patient_id,
        purpose="EXTERNAL_TOOL_LOOKUP",
        consultation_id=payload.consultation_id,
        tool_name=tool,
    )
    if not consent.allowed:
        error_code = "consent_unavailable" if consent.unavailable else "consent_denied"
        batch.record(
            step_type=STEP_TOOL_CALL,
            name=step_name,
            status=STATUS_ERROR,
            started=started,
            stats={"server": server.name, "tool": tool},
            error_code=error_code,
        )
        await batch.flush()
        raise ApplicationError(
            f"Consent check failed for MCP tool call: {tool} ({error_code})",
            type="ConsentUnavailable" if consent.unavailable else "ConsentDenied",
            non_retryable=True,
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
            "server_error"
            if exc.is_server_error
            else "timeout" if exc.is_timeout else "client_error"
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
        # NOT ``_idempotency_key()`` — see ``_entities_idempotency_key``. This
        # callback is duplicated by a second workflow EXECUTION, not just by an
        # activity retry.
        idempotency_key=_entities_idempotency_key(payload.consultation_id, payload.entities),
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
    """Resolve the prompt tier + assemble the Text payload via apps/api."""
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
async def generate(payload: GenerateInput) -> TextGenerationResult:
    """Generate the SOAP draft synchronously via the Text service."""
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

    # Enforce the fail-closed PHI egress guard before any cloud Text call.
    # Local providers (the default) are a pure pass-through. A fail-closed block
    # raises PhiEgressBlocked, which propagates and fails the workflow — no draft is
    # ever persisted (the Text failure-propagation invariant), never a silent leak.
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

    # F-19 — measure the prompt ACTUALLY dispatched (assembled user prompt incl.
    # the RAG / segment-citation / regen-feedback blocks, plus the system
    # prompt). Observation ONLY: clinical content is never compacted or
    # truncated to fit a budget, so an oversized prompt is made LOUD instead.
    # Emitted before the call so a prompt that then blows the context window is
    # still visible in the logs.
    prompt_chars = len(prompt) + len(system_prompt or "")
    prompt_tokens_est = prompt_chars // 4
    if prompt_chars > settings.prompt_size_warn_chars:
        activity.logger.warning(
            "harness.prompt_size_warn",
            extra={
                "prompt_chars": prompt_chars,
                "prompt_tokens_est": prompt_tokens_est,
                "threshold_chars": settings.prompt_size_warn_chars,
                "provider": payload.provider,
                "model": payload.model,
            },
        )

    try:
        result = await _text_client(settings).generate(
            tenant_id=_required_tenant(payload.tenant_id, "generate"),
            prompt=prompt,
            system_prompt=system_prompt,
            provider=payload.provider,
            model=payload.model,
            temperature=hp.get("temperature"),
            max_tokens=hp.get("max_tokens"),
            top_p=hp.get("top_p"),
            response_format=payload.response_format,
            # A deterministic key (workflow_run:activity_id, stable across
            # worker-crash re-delivery) so Text dedups a replayed generate — the durable half
            # of the fix on top of the in-process retry narrowing.
            idempotency_key=_idempotency_key(),
        )
    except TextServiceError as exc:
        # ``after_send`` means the request reached Text and the model MAY have
        # generated — a dropped-read transport loss OR the governor's per-call timeout
        # firing mid-request (both closed in ``text_client``). Re-running the activity
        # (Temporal ``_GENERATE_RETRY``) would re-invoke the model (double spend + divergent
        # draft), so mark it non-retryable — the Text-failure invariant still fails the
        # workflow without a draft. A PRE-send failure propagates unchanged (retryable: the
        # model never ran).
        #
        # Belt-and-braces with the idempotency key above: a genuine worker CRASH mid-activity
        # (no exception to catch) that makes Temporal re-deliver the activity now re-POSTs the
        # SAME ``Idempotency-Key``, so Text returns the first generation instead of re-billing.
        # The one residual (documented, accepted): an Text 5xx / LM-Studio
        # ``terminated`` 400 arriving AFTER the model ran but BEFORE the response was cached —
        # the governor retries it and there is no cached result to replay.
        if exc.after_send:
            raise ApplicationError(str(exc), type="TextResponseLost", non_retryable=True) from exc
        raise

    # Offload the generated note so the (large) content stays OUT of Temporal
    # history; on offload the inline ``content`` is emptied and the workflow threads
    # ``content_ref`` to the consumers (note-NER / sensors / persist) that resolve it.
    content_inline, content_ref = await _offload_text(settings, result.content)
    out = (
        result
        if content_ref is None
        else result.model_copy(update={"content": content_inline, "content_ref": content_ref})
    )

    # LLM_CALL step embeds the ``stats`` verbatim;
    # a bounded-regen generation bumps ``harness_regen_total``. When Text returned
    # non-empty reasoning, emit a stats-only THINKING step (payloadRef stays null until
    # a capture-payload policy flag is on — which it is not yet).
    # F-19 / F-35 — the backend's generation stats VERBATIM (so any cache
    # counters it reports — ``cached_tokens``, ``prompt_cache_*``, whatever sits
    # in ``engine_native`` — reach the trajectory rollups untouched) plus the
    # locally measured prompt size. A legacy Text response with no ``stats`` still
    # gets the size fields.
    llm_stats: dict[str, Any] = dict(result.stats or {})
    llm_stats["prompt_chars"] = prompt_chars
    llm_stats["prompt_tokens_est"] = prompt_tokens_est
    # The gateway's usage-ledger emission hook (co-emitted on
    # trajectory persistence) needs `provider`/`model` on every LLM_CALL step to
    # attribute cost. AD-1 GenerationStats normally carries both
    # (``stats.provider``/``stats.model``), but a legacy Text response with no
    # ``stats`` block (cache hit) would otherwise omit them even though
    # ``TextGenerationResult`` itself always carries them at the top level.
    # Backfill only when the stats block didn't already say one — never
    # overwrite a value Text actually reported.
    if not llm_stats.get("provider") and result.provider:
        llm_stats["provider"] = result.provider
    if not llm_stats.get("model") and result.model:
        llm_stats["model"] = result.model
    batch = _TrajectoryBatch(settings, payload.trajectory)
    batch.record(
        step_type=STEP_LLM_CALL,
        name="generate",
        status=STATUS_OK,
        started=started,
        stats=llm_stats,
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

    CONSENT (TASK-712, consent-abac Phase 4): a ``HISTORY_RETRIEVAL`` grant is
    required before the retriever runs. Unlike ``call_mcp_tool``, a denial here
    does NOT raise — it follows this activity's existing degrade-to-empty
    contract (a missing/denied grant behaves like a retrieval backend outage:
    ``degraded=True``, no chunks, generation proceeds without institutional
    context). The trajectory ``error_code`` (``consent_denied`` /
    ``consent_unavailable``) is what stays distinguishable (R4).
    """
    settings = get_settings()
    started = _now()
    batch = _TrajectoryBatch(settings, payload.trajectory)
    # the policy override (when non-null) wins over the env
    # kill-switch; None falls through to ``HARNESS_RETRIEVAL_ENABLED``.
    retrieval_enabled = _resolve_flag(
        payload.retrieval_enabled, env_default=settings.retrieval.enabled
    )
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

    consent = await _check_consent(
        settings,
        tenant_id=payload.tenant_id,
        external_patient_id=payload.external_patient_id,
        purpose="HISTORY_RETRIEVAL",
        consultation_id=payload.consultation_id,
    )
    if not consent.allowed:
        error_code = "consent_unavailable" if consent.unavailable else "consent_denied"
        batch.record(
            step_type=STEP_RETRIEVAL,
            name="retrieve_context",
            status=STATUS_ERROR,
            started=started,
            stats={"enabled": True, "chunk_count": 0},
            error_code=error_code,
        )
        await batch.flush()
        return RetrievedContext(degraded=True)

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


def _stt_batch_job_output(
    resp: SttBatchJobResponse, *, timed_out: bool = False
) -> DispatchBatchTranscriptionOutput:
    return DispatchBatchTranscriptionOutput(
        job_id=resp.job_id,
        status=resp.status,
        progress=resp.progress,
        error_message=resp.error_message,
        error_code=resp.error_code,
        timed_out=timed_out,
    )


# Non-terminal `TranscriptionJobStatus` values (mirrors
# `packages/domains/src/enums/generated/TranscriptionJobStatus.ts`; QUEUED/PROCESSING
# keep polling, COMPLETED/FAILED/CANCELLED/DEAD are terminal). Duplicated here rather
# than shared cross-language — see the ticket README's own "cross-language enum drift"
# risk note, same posture already accepted for `ModelTaskType`/`LanguageModeKind`.
_STT_JOB_NON_TERMINAL_STATUSES = frozenset({"QUEUED", "PROCESSING"})


@activity.defn
async def dispatch_batch_transcription(
    payload: DispatchBatchTranscriptionInput,
) -> DispatchBatchTranscriptionOutput:
    """TASK-724 Task 5 — the STT palette's batch-trigger activity.

    Given a resolved `AsrPipeline` id (README §1's central design decision: a
    published `stt` `WorkflowDefinition` compiles to an `AsrPipeline`, it is never
    walked node-by-node by this interpreter) and a batch job's audio reference, this
    is the ONE place harness dispatches STT batch work: it calls apps/api's
    `POST /internal/harness/stt/batch-jobs`, which itself calls the EXACT SAME
    `TranscriptionJobService.createBatchJob` + `TranscriptionRealtimeService.
    dispatchDramatiqJob` calls `TranscriptionJobController`'s own batch handlers
    already make — no duplicate job-processing logic in harness, and no per-frame
    audio or per-node execution inside this (or any) Temporal workflow.

    Idempotent / retriable: apps/api itself dedups on (`consultation_id`,
    `pipeline_id`) for a non-terminal job, so a Temporal retry of this ENTIRE
    activity (worker crash, network blip) re-POSTs safely and gets back the
    already-dispatched job rather than a duplicate. The poll loop is real wall-clock
    `asyncio.sleep` (never Temporal's own clock — this is I/O, not workflow code) and
    is bounded by `payload.poll_timeout_seconds`; hitting the ceiling returns
    `timed_out=True` on the LAST-OBSERVED (non-terminal) status rather than raising —
    the job keeps running on apps/api/apps/stt, so a timeout here is "poll again
    later", not "the job failed."
    """
    settings = get_settings()
    client = _api_client(settings)

    try:
        created = await client.create_stt_batch_job(
            tenant_id=payload.tenant_id,
            pipeline_id=payload.pipeline_id,
            audio_uri=payload.audio_uri,
            consultation_id=payload.consultation_id,
            media_id=payload.media_id,
            language=payload.language,
        )
    except ApiServiceError as exc:
        raise ApplicationError(
            f"dispatch_batch_transcription: create failed: {exc}", type="SttBatchDispatchFailed"
        ) from exc

    if created.status not in _STT_JOB_NON_TERMINAL_STATUSES:
        return _stt_batch_job_output(created)

    deadline = asyncio.get_running_loop().time() + payload.poll_timeout_seconds
    latest = created
    while latest.status in _STT_JOB_NON_TERMINAL_STATUSES:
        if asyncio.get_running_loop().time() >= deadline:
            return _stt_batch_job_output(latest, timed_out=True)
        await asyncio.sleep(payload.poll_interval_seconds)
        try:
            latest = await client.get_stt_batch_job_status(
                created.job_id, tenant_id=payload.tenant_id
            )
        except ApiServiceError as exc:
            raise ApplicationError(
                f"dispatch_batch_transcription: poll failed: {exc}", type="SttBatchPollFailed"
            ) from exc

    return _stt_batch_job_output(latest)


@activity.defn
async def run_sensors(payload: RunSensorsInput) -> SensorRunOutput:
    """Build the SensorContext + provenance and run all computational sensors.

    ``payload.thresholds`` is the policy-driven (per-tenant) :class:`SensorThresholds`;
    ``None`` falls back to the PLATFORM default the control plane resolves, and to the
    sensors' own env values beneath that (see :func:`_platform_thresholds`).
    """
    # Resolve the (possibly offloaded) note + transcript inline-or-ref.
    settings = get_settings()
    started = _now()
    note_text = await _resolve_ref(settings, payload.note_text, payload.note_text_ref)
    transcript_text = await _resolve_ref(
        settings, payload.transcript_text, payload.transcript_text_ref
    )
    output = run_computational_sensors(
        note_text=note_text,
        transcript_text=transcript_text,
        note_entities=payload.note_entities,
        transcript_entities=payload.transcript_entities,
        response_format=payload.response_format,
        transcript_context_item_id=payload.transcript_context_item_id,
        retrieved_chunk_ids=payload.retrieved_chunk_ids,
        allowed_segment_ids=payload.allowed_segment_ids,
        thresholds=await _platform_thresholds(payload.thresholds),
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
                extra={
                    "consultation_id": consultation_id,
                    "claim_id": claim_ref,
                    "error": str(exc),
                },
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


async def _config_snapshot() -> Any | None:
    """The process-wide control-plane snapshot, or `None` when it cannot be read.

    Never raises: every consumer of this treats `None` as "keep the bootstrap value", so
    a config read can never fail an activity that would otherwise have succeeded.
    """
    try:
        return await get_effective_config_client().get()
    except Exception as exc:  # noqa: BLE001 — a config read must never fail a pass
        activity.logger.warning(
            "harness.effective_config.unavailable",
            extra={"error": str(exc), "error_type": type(exc).__name__},
        )
        return None


async def _platform_thresholds(policy: SensorThresholds | None) -> SensorThresholds:
    """The thresholds this run gates on: policy (tenant) then control plane then env.

    `policy` is the PUSH lane — `HarnessPolicy` resolved per tenant by apps/api and
    snapshotted onto the activity input at workflow start. When it is set, the tenant has
    an opinion and it wins outright; the control plane is not consulted (owner decision
    D-1: anything that varies BY TENANT travels PUSH, and PULL carries only the one
    platform value).

    When it is absent, the PLATFORM default comes from the control plane, with the
    service's own env values as the bootstrap floor beneath it. Every failure degrades to
    that floor — `resolve_sensor_thresholds` refuses an unresolved or out-of-contract
    value rather than substituting one, so a degraded control plane leaves every clinical
    gate exactly where it was.

    Safe to call from an ACTIVITY (network I/O); never from a workflow body.
    """
    if policy is not None:
        return policy
    return resolve_sensor_thresholds(await _config_snapshot(), SensorThresholds())


async def _already(result: SensorResult) -> SensorResult:
    """Wrap an already-decided result so it can join the ``asyncio.gather`` fan-out."""
    return result


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
                # `None`, because the safety screen no longer egresses from harness to a
                # provider at all: it posts the note to `apps/guardrail`, a first-party
                # internal peer, exactly like the `text`/`nlp` hops this guard has never
                # gated. Guardrail owns the PHI posture of whatever engine IT selects —
                # harness cannot know that engine and must not guess it. The `judge_*`
                # gating below is unchanged, because the judge client still posts to its
                # selected provider directly from this process.
                safety_provider=None,
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

        # The inferential input carries no policy thresholds of its own (the groundedness
        # one arrives as its own field), so this is the platform-default lookup.
        thresholds = await _platform_thresholds(None)
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
            if payload.tenant_id:
                tasks.append(
                    SafetySensor(_safety_screen_client(settings, payload.tenant_id)).arun(
                        ctx, judge=judge, screen_cache=verdict_cache
                    )
                )
            else:
                # A tenant-scoped internal call with no tenant is a CALLER bug (TASK-737),
                # not something to paper over with a default: guardrail would answer 428
                # and the screen would look like an outage. Degrade explicitly and say why.
                results_degraded = degraded_result(
                    SAFETY_NAME, "safety screen unavailable: no tenant on the inferential input"
                )
                tasks.append(_already(results_degraded))
        # The DETERMINISTIC reference-free atomic-fact verifier runs
        # ALONGSIDE the judge sensors (defense-in-depth), gated by the runtime ops
        # kill-switch (default OFF). It uses a SELF-HOSTED NLI (NOT the judge), so it adds
        # no cloud egress; a degraded backend degrades (never auto-PASS). Read at runtime
        # here — not the workflow — so it adds no new workflow command (replay-safe).
        # the policy override (when non-null) wins over the env
        # kill-switch; None falls through to ``HARNESS_ATOMIC_FACT_ENABLED``.
        if _resolve_flag(payload.atomic_fact_enabled, env_default=settings.atomic_fact_enabled):
            tasks.append(_run_atomic_fact_sensor(settings, ctx, thresholds.atomic_fact_threshold))
        results = list(await asyncio.gather(*tasks))
        return await _emit(_assemble_inferential_output(results, verdict_cache))
    finally:
        heartbeat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat


def _needs_semantic_rewrite(rule: RedactionRule) -> bool:
    """A ``rewrite`` rule with NO literal ``replacement`` ⇒ the Text semantic pass."""
    return rule.type == "rewrite" and rule.replacement is None


def _build_rewrite_prompt(text: str, rules: list[RedactionRule]) -> str:
    """A constrained rewrite instruction for the Text semantic pass.

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
    """DNA redaction/rewrite — a SEPARATE, auditable post-generation transform.

    Runs AFTER the computational-sensor loop settles and BEFORE persist/delivery so the
    persisted/delivered note is the redacted one and the sensors validate the FINAL text.

    Two passes:

    1. **Deterministic** — literal/regex/category ``remove`` rules and ``rewrite`` rules
       that carry a literal ``replacement``. Pure, replay-neutral. A malformed rule that
       reaches the engine fails CLOSED (see below).
    2. **Optional Text semantic rewrite** — ``rewrite`` rules with no literal replacement.
       One constrained Text call, PHI-egress guarded + idempotency-keyed exactly like
       ``generate``; the output must preserve the note's JSON schema.

    **Fail CLOSED**: if the deterministic engine raises OR a required Text rewrite cannot be
    completed/parsed, the result carries ``failed_closed=True`` (the workflow forces a FLAG).
    A note the doctor expected redacted must never slip through silently. The audit
    ``manifest`` carries spans + counts only — never removed PHI plaintext.
    """
    settings = get_settings()
    started = _now()
    text = await _resolve_ref(settings, payload.note_text, payload.note_text_ref)

    if not payload.rules:
        # No rules ⇒ pure no-op (the default, and every legacy/patched-off path).
        # No GUARDRAIL step: redaction was never armed, so there is nothing to audit.
        return ApplyRedactionResult(text=text, changed=False, manifest=RedactionManifest())

    batch = _TrajectoryBatch(settings, payload.trajectory)

    async def _emit(result: ApplyRedactionResult) -> ApplyRedactionResult:
        # ONE GUARDRAIL trajectory step per armed transform (audit clause).
        # Carries manifest STATS ONLY — counts + rule ids + fail-closed marker, never
        # removed PHI plaintext. Fire-and-forget flush (never fails the clinical loop).
        batch.record(
            step_type=STEP_GUARDRAIL,
            name="apply_redaction",
            status=STATUS_OK,
            started=started,
            stats={
                "applied": result.manifest.applied,
                "total_hits": result.manifest.total_hits,
                "hits_by_rule": result.manifest.hits_by_rule,
                "failed_closed": result.failed_closed,
            },
        )
        await batch.flush()
        return result

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
        return await _emit(
            ApplyRedactionResult(
                text=text, changed=False, failed_closed=True, manifest=RedactionManifest()
            )
        )

    working = outcome.text
    manifest = outcome.manifest

    # 2) Optional Text semantic-rewrite pass — fail closed on ANY failure.
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
            result = await _text_client(settings).generate(
                tenant_id=_required_tenant(payload.tenant_id, "apply_redaction"),
                prompt=safe_prompt,
                provider=payload.provider,
                model=payload.model,
                response_format=payload.response_format,
                idempotency_key=_idempotency_key("redaction"),
            )
        except (PhiEgressBlocked, TextServiceError) as exc:
            activity.logger.warning(
                "harness.redaction.failed_closed",
                extra={"stage": "text_rewrite", "reason": str(exc)},
            )
            return await _emit(
                ApplyRedactionResult(
                    text=working,
                    changed=manifest.applied,
                    failed_closed=True,
                    manifest=manifest,
                )
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
                    extra={"stage": "text_rewrite_schema", "reason": str(exc)},
                )
                return await _emit(
                    ApplyRedactionResult(
                        text=working,
                        changed=manifest.applied,
                        failed_closed=True,
                        manifest=manifest,
                    )
                )
        working = rewritten
        manifest = RedactionManifest(
            applied=True,
            total_hits=manifest.total_hits + len(semantic),
            hits_by_rule={**manifest.hits_by_rule, **{r.id: 1 for r in semantic}},
            hits=manifest.hits,
        )

    text_out, text_ref = await _offload_text(settings, working)
    return await _emit(
        ApplyRedactionResult(
            text=text_out,
            text_ref=text_ref,
            changed=working != text,
            failed_closed=False,
            manifest=manifest,
        )
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
        # DNA redaction/rewrite audit marker (audit era). None on every
        # pre-audit-era persist ⇒ pruned client-side ⇒ byte-identical POST body.
        redaction_applied=payload.redaction_applied,
        redaction_manifest=payload.redaction_manifest,
        # NOT ``_idempotency_key()`` — see ``_draft_idempotency_key``. This callback
        # is duplicated by a second workflow EXECUTION, not just by an activity retry.
        idempotency_key=_draft_idempotency_key(payload.consultation_id, content),
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
    except (
        Exception
    ) as exc:  # noqa: BLE001 — best-effort: an escalation record must never fail the gate
        activity.logger.warning(
            "harness.gate.escalation_record_failed",
            extra={
                "consultation_id": payload.consultation_id,
                "reason": payload.reason,
                "error": str(exc),
            },
        )
    return EscalateResult(escalated=True)


# ---------------------------------------------------------------------------
# Consultation loop
#
# All three side effects the mechanical loop performs. They are ordinary
# activities: the deterministic workflow body never touches HTTP, and a signal
# handler never calls any of them (it only mutates guarded state and lets the
# main coroutine react).
# ---------------------------------------------------------------------------

# The loop-event feed is fire-and-forget, exactly like progress/trajectory.
_LOOP_EVENT_HTTP_TIMEOUT_S = 5.0


def _loop_event_api_client(settings: Settings) -> ApiClient:
    return ApiClient(
        settings.api_base_url,
        internal_prefix=settings.api_internal_prefix,
        service_token=settings.peer_service_token(settings.service_token),
        timeout=min(_LOOP_EVENT_HTTP_TIMEOUT_S, settings.api_timeout_s),
    )


@activity.defn
async def fetch_loop_config(payload: FetchLoopConfigInput) -> ConsultationLoopConfig:
    """Resolve the loop configuration the workflow PINS for its whole run.

    Called exactly once, on the workflow's first execution; the resolved object
    is then carried through every ``continue_as_new`` in the workflow input, so
    a mid-consultation tenant edit is invisible to a running loop.

    RAISES on a transport/HTTP failure so Temporal's retry policy covers infra
    blips. The workflow — not this activity — decides what an ultimately
    unresolvable config means, and its answer is "run degraded", i.e. the
    consultation behaves exactly as it does today (K7).
    """
    settings = get_settings()
    data = await _api_client(settings).get_loop_config(
        payload.consultation_id, tenant_id=payload.tenant_id
    )

    raw_budget = data.get("budget")
    if not isinstance(raw_budget, dict):
        raw_budget = {}
    defaults = LoopBudget()
    budget = LoopBudget(
        max_depth=int(raw_budget.get("maxDepth", defaults.max_depth)),
        max_actions=int(raw_budget.get("maxActions", defaults.max_actions)),
    )

    subscriptions: list[LoopSubscription] = []
    for entry in data.get("subscriptions") or []:
        if not isinstance(entry, dict):
            continue
        kind_key = entry.get("kindKey")
        if not isinstance(kind_key, str):
            continue
        actions = [a for a in (entry.get("actions") or []) if isinstance(a, str)]
        subscriptions.append(LoopSubscription(kind_key=kind_key, actions=actions))

    def _strings(key: str) -> list[str]:
        return [a for a in (data.get(key) or []) if isinstance(a, str)]

    # The idle lifecycle bound. Absent (or non-numeric) on a gateway
    # that predates this ticket, in which case the loop stays unbounded and
    # behaves exactly as left it. Resolved gateway-side from the
    # `harness.loop.idleTimeoutSeconds` `global-kv` setting and PINNED here: this
    # is the once-only read, so the bound is fixed for the whole consultation.
    raw_idle_timeout = data.get("idleTimeoutSeconds")
    idle_timeout_seconds = (
        float(raw_idle_timeout)
        if isinstance(raw_idle_timeout, (int, float)) and not isinstance(raw_idle_timeout, bool)
        else None
    )

    # The agent roster. Absent on a gateway that predates this ticket,
    # in which case the roster is empty, `reasoning_enabled` stays False, and the
    # loop behaves exactly as left it.
    agents: list[LoopAgentSpec] = []
    for entry in data.get("agents") or []:
        if not isinstance(entry, dict):
            continue
        agent_id = entry.get("agentId")
        if not isinstance(agent_id, str):
            continue
        agents.append(
            LoopAgentSpec(
                agent_id=agent_id,
                role=entry.get("role") or AGENT_ROLE_SPECIALIST,
                slug=entry.get("slug"),
                goal=entry.get("goal"),
                subscribed_kinds=[
                    k for k in (entry.get("subscribedKinds") or []) if isinstance(k, str)
                ],
                write_scope=[k for k in (entry.get("writeScope") or []) if isinstance(k, str)],
                agent_config_version_id=entry.get("agentConfigVersionId"),
            )
        )

    return ConsultationLoopConfig(
        enabled=bool(data.get("enabled", False)),
        consultation_id=data.get("consultationId") or payload.consultation_id,
        department_id=data.get("departmentId"),
        agent_id=data.get("agentId"),
        agent_config_version_id=data.get("agentConfigVersionId"),
        context_schema_version_id=data.get("contextSchemaVersionId"),
        subscriptions=subscriptions,
        budget=budget,
        start_actions=_strings("startActions"),
        ending_actions=_strings("endingActions"),
        reasoning_enabled=bool(data.get("reasoningEnabled", False)),
        agents=agents,
        idle_timeout_seconds=idle_timeout_seconds,
    )


@activity.defn
async def livedoc_start(payload: LiveDocControlInput) -> LiveDocControlResult:
    """Dispatch ``LiveDocumentationService.start`` — the reflex lane.

    Best-effort by contract: LiveDoc has its own kill-switch and its own
    idempotent restart semantics, and a failure to start it must not take down
    the orchestrator that merely asked for it.
    """
    settings = get_settings()
    try:
        ok = await _api_client(settings).live_documentation_start(
            payload.consultation_id,
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            session_id=payload.session_id,
        )
        return LiveDocControlResult(ok=ok)
    except Exception as exc:  # noqa: BLE001 — best-effort by design, never raise
        activity.logger.warning(
            "harness.loop.livedoc_start_failed",
            extra={"consultation_id": payload.consultation_id, "error": str(exc)},
        )
        return LiveDocControlResult(ok=False)


@activity.defn
async def livedoc_stop(payload: LiveDocControlInput) -> LiveDocControlResult:
    """Dispatch ``LiveDocumentationService.stop``. Best-effort, as for start."""
    settings = get_settings()
    try:
        ok = await _api_client(settings).live_documentation_stop(
            payload.consultation_id,
            tenant_id=payload.tenant_id,
            persist_snapshot=payload.persist_snapshot,
        )
        return LiveDocControlResult(ok=ok)
    except Exception as exc:  # noqa: BLE001 — best-effort by design, never raise
        activity.logger.warning(
            "harness.loop.livedoc_stop_failed",
            extra={"consultation_id": payload.consultation_id, "error": str(exc)},
        )
        return LiveDocControlResult(ok=False)


@activity.defn
async def emit_loop_event(payload: EmitLoopEventInput) -> EmitLoopEventResult:
    """Publish one loop event to the live client feed (``client.emit``).

    Fire-and-forget by contract: ALL errors are swallowed so a down SSE plane
    can never fail — or even retry-delay — the loop.
    """
    settings = get_settings()
    try:
        ok = await _loop_event_api_client(settings).report_loop_event(
            payload.consultation_id,
            tenant_id=payload.tenant_id,
            event_type=payload.event_type,
            run_id=activity.info().workflow_run_id,
            context_item_id=payload.context_item_id,
            kind_key=payload.kind_key,
            action=payload.action,
            reason=payload.reason,
            detail=payload.detail,
        )
        return EmitLoopEventResult(emitted=ok)
    except Exception as exc:  # noqa: BLE001 — best-effort by design, never raise
        activity.logger.warning(
            "harness.loop.emit_event_failed",
            extra={
                "consultation_id": payload.consultation_id,
                "event_type": payload.event_type,
                "error": str(exc),
            },
        )
        return EmitLoopEventResult(emitted=False)


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
    # TASK-724 Task 5 — the STT palette's batch-trigger activity.
    dispatch_batch_transcription,
]

# ---------------------------------------------------------------------------
# Reasoning lane
#
# Four concerns, all of them activities:
#
#   * ``plan_reasoning``     — the LLM planner. An ACTIVITY, never a workflow-body
#                              call, so its decision is recorded in history and a
#                              replay reuses it instead of re-rolling the model (C1).
#   * ``run_specialist``     — one specialist's analysis (also a model call).
#   * ``record_adjudication``— publishes the primary's reconciliation to the
#                              inspection surface.
# * the three ``*_extract_*`` derivers that back the keys declared
#     but left unimplemented.
#
# Every one of them FAILS SAFE. A planner that cannot answer returns a degraded
# decision dispatching nothing; a deriver that cannot extract returns
# ``derived=False``. Neither raises, because neither is allowed to take down a
# clinical consultation — the loop degrades, it does not abort.
# ---------------------------------------------------------------------------

_PLAN_TIMEOUT_S = 60.0
_SPECIALIST_TIMEOUT_S = 90.0

# Bounds what a single planner answer may schedule, independently of the
# workflow's own budget. Belt and braces: a model that returns a thousand
# specialists must not be able to spend the whole consultation's budget in one
# decision before the workflow ever sees the list.
_PLAN_MAX_DISPATCH = 16

_PLANNER_SYSTEM_PROMPT = (
    "You are the primary clinical documentation agent coordinating specialist "
    "reviewers during a live consultation. Decide WHICH specialists should "
    "review the new context, and why. Do not write clinical content, do not "
    "summarise, and do not produce a note. Answer with JSON only: "
    '{"dispatch": [{"agent_id": "...", "kind_key": "...", "reason": "..."}], '
    '"rationale": "..."}'
)

_SPECIALIST_SYSTEM_PROMPT = (
    "You are a specialist reviewer. Read the supplied consultation context and "
    "return discrete findings within your declared output scope. Return claims, "
    "never prose, and never a clinical note. Answer with JSON only: "
    '{"findings": [{"output_kind": "...", "statement": "...", "confidence": 0.0}]}'
)


def _json_block(raw: str) -> dict[str, Any]:
    """Best-effort JSON object out of a model answer. Never raises."""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text.strip("`")
        if text.lstrip().startswith("json"):
            text = text.lstrip()[4:]
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return {}
    try:
        parsed = json.loads(text[start : end + 1])
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


@activity.defn
async def plan_reasoning(payload: PlanLoopInput) -> PlanDecision:
    """Decide which specialists review the newly arrived context. RECORDED.

    Being an activity is the entire point ( / C1): the returned
    ``PlanDecision`` lands in workflow history, so replaying the workflow reuses
    that exact decision and never calls the model again. A planner invoked from
    the workflow body would make every replay non-deterministic.

    ``reasoning`` is requested here — planning is precisely where the evidence
    says reasoning helps. It is NOT requested anywhere on the note-generation
    path (arXiv 2605.24902).

    Fails SAFE: any transport, parse or validation failure yields a degraded
    decision with an EMPTY dispatch list. A guessed roster of clinical
    specialists is worse than none, so the planner never falls back to "run
    everything".
    """
    plan_id = f"{payload.consultation_id}:{payload.plan_seq}"
    candidates = payload.candidates[: payload.max_specialists]
    if not candidates:
        return PlanDecision(plan_id=plan_id, dispatch=[], rationale="no candidate specialists")

    allowed = {agent.agent_id: agent for agent in candidates}
    roster = "\n".join(
        f"- {a.agent_id} (slug={a.slug or '-'}) reads={a.subscribed_kinds} "
        f"writes={a.write_scope} goal={a.goal or '-'}"
        for a in candidates
    )
    prompt = (
        f"Consultation goal: {payload.goal or 'produce one reconciled clinical note'}\n"
        f"New context kinds since the last plan: {sorted(set(payload.trigger_kinds))}\n"
        f"Available specialists:\n{roster}\n\n"
        "Dispatch only specialists whose read scope covers a new kind."
    )

    settings = get_settings()
    try:
        result = await _text_client(settings).generate(
            tenant_id=_required_tenant(payload.tenant_id, "plan_reasoning"),
            prompt=prompt,
            system_prompt=_PLANNER_SYSTEM_PROMPT,
            temperature=0.0,
            idempotency_key=f"plan:{plan_id}",
            context={"reasoning": payload.reasoning, "task": "harness.loop.plan"},
        )
    except Exception as exc:  # noqa: BLE001 — degrade, never fail the consultation
        activity.logger.warning(
            "harness.loop.plan_failed",
            extra={"consultation_id": payload.consultation_id, "error": str(exc)},
        )
        return PlanDecision(plan_id=plan_id, dispatch=[], degraded=True, rationale=str(exc))

    parsed = _json_block(result.content)
    dispatch: list[PlannedSpecialist] = []
    for entry in parsed.get("dispatch") or []:
        if not isinstance(entry, dict):
            continue
        agent_id = entry.get("agent_id")
        kind_key = entry.get("kind_key")
        if not isinstance(agent_id, str) or not isinstance(kind_key, str):
            continue
        agent = allowed.get(agent_id)
        # The model may only schedule an agent that EXISTS and that actually
        # subscribes to the kind. A hallucinated agent id or a widened read scope
        # is dropped here rather than trusted downstream.
        if agent is None or not agent.reads(kind_key):
            continue
        reason = entry.get("reason")
        dispatch.append(
            PlannedSpecialist(
                agent_id=agent_id,
                kind_key=kind_key,
                reason=reason if isinstance(reason, str) else "",
            )
        )
        if len(dispatch) >= _PLAN_MAX_DISPATCH:
            break

    rationale = parsed.get("rationale")
    return PlanDecision(
        plan_id=plan_id,
        dispatch=dispatch,
        rationale=rationale if isinstance(rationale, str) else "",
        model=result.model or None,
        degraded=not parsed,
    )


@activity.defn
async def run_specialist(payload: SpecialistAnalysisInput) -> SpecialistResult:
    """One specialist's review of its OWN scoped slice of the consultation.

    The context it receives was already filtered to its subscribed kinds by the
    workflow — this activity cannot widen its own read scope because it is never
    handed anything outside it.

    Findings outside the declared ``write_scope`` are refused here as well as in
    the parent. The parent's check is the authoritative one (enforcement outside
    agent code); this one exists so a mis-scoped agent is visible
    in its own result rather than only as a parent-side drop.
    """
    settings = get_settings()
    body = "\n\n".join(
        f"[{item.kind_key or 'context'} {item.context_item_id}]\n{item.text}"
        for item in payload.context
    )
    prompt = (
        f"Your role: {payload.agent_slug or payload.agent_id}\n"
        f"Your goal: {payload.goal or 'review the context within your specialty'}\n"
        f"Output kinds you may emit: {payload.write_scope}\n\n"
        f"Consultation context:\n{body}"
    )

    try:
        result = await _text_client(settings).generate(
            tenant_id=_required_tenant(payload.tenant_id, "run_specialist"),
            prompt=prompt,
            system_prompt=_SPECIALIST_SYSTEM_PROMPT,
            temperature=0.0,
            idempotency_key=f"spec:{payload.plan_id}:{payload.agent_id}:{payload.kind_key}",
            context={"reasoning": payload.reasoning, "task": "harness.loop.specialist"},
        )
    except Exception as exc:  # noqa: BLE001 — one specialist failing is isolated
        activity.logger.warning(
            "harness.loop.specialist_failed",
            extra={
                "consultation_id": payload.consultation_id,
                "agent_id": payload.agent_id,
                "error": str(exc),
            },
        )
        raise

    allowed = set(payload.write_scope)
    findings: list[SpecialistFinding] = []
    refused: list[str] = []
    for entry in _json_block(result.content).get("findings") or []:
        if not isinstance(entry, dict):
            continue
        output_kind = entry.get("output_kind")
        statement = entry.get("statement")
        if not isinstance(output_kind, str) or not isinstance(statement, str):
            continue
        if output_kind not in allowed or output_kind in PRIMARY_ONLY_OUTPUT_KINDS:
            refused.append(output_kind)
            continue
        raw_confidence = entry.get("confidence")
        confidence = float(raw_confidence) if isinstance(raw_confidence, int | float) else 0.0
        findings.append(
            SpecialistFinding(
                output_kind=output_kind,
                statement=statement,
                confidence=max(0.0, min(1.0, confidence)),
                evidence_context_item_ids=[item.context_item_id for item in payload.context],
            )
        )

    return SpecialistResult(
        agent_id=payload.agent_id,
        plan_id=payload.plan_id,
        kind_key=payload.kind_key,
        findings=findings,
        out_of_scope_findings=refused,
    )


@activity.defn
async def record_adjudication(payload: RecordAdjudicationInput) -> EmitLoopEventResult:
    """Publish the primary's reconciliation to the inspection surface (E12).

    Rides the existing loop-event plane rather than inventing a second transport:
    the record carries agent ids, output kinds and short statements — the same
    class of content the feed already relays — and never note or transcript text.

    Fire-and-forget, like every other loop event: a down feed must not cost the
    consultation its adjudication, which is also recorded in workflow history.
    """
    settings = get_settings()
    try:
        ok = await _loop_event_api_client(settings).report_loop_event(
            payload.consultation_id,
            tenant_id=payload.tenant_id,
            event_type=LOOP_EVENT_ADJUDICATED,
            run_id=activity.info().workflow_run_id,
            detail=payload.record.model_dump(mode="json"),
        )
        return EmitLoopEventResult(emitted=ok)
    except Exception as exc:  # noqa: BLE001 — best-effort by design, never raise
        activity.logger.warning(
            "harness.loop.adjudication_publish_failed",
            extra={"consultation_id": payload.consultation_id, "error": str(exc)},
        )
        return EmitLoopEventResult(emitted=False)


async def _resolve_derive_text(settings: Settings, payload: DeriveContextInput) -> str:
    """The item's text, resolving a claim-check ref when the payload was offloaded.

    Reuses the existing ``_resolve_ref`` edge helper rather than adding a second
    inline-or-ref convention (reused ``claim_check.py`` for the same reason).
    """
    return await _resolve_ref(settings, payload.text, payload.text_ref)


def _derived_kind(kind_key: str | None, suffix: str) -> str:
    """Deterministic kind key for a derived item — `<parent>_<suffix>`."""
    return f"{kind_key or 'context'}_{suffix}"


@activity.defn
async def vision_extract_text(payload: DeriveContextInput) -> DeriveContextResult:
    """Extract text from an IMAGE context item.

    Backs `vision.extract_text`, which declared but left dispatching as
    an `unsupported_action` skip. Uses the vision capability shipped in
    Text. Its output re-enters the context bus one depth deeper, which is what
    makes image -> text the same mechanism as audio -> transcript.
    """
    settings = get_settings()
    source = await _resolve_derive_text(settings, payload)
    try:
        result = await _text_client(settings).generate(
            tenant_id=_required_tenant(payload.tenant_id, "vision_extract_text"),
            prompt=(
                "Transcribe all legible text in this clinical image verbatim. "
                "Do not interpret, diagnose or summarise.\n\n"
                f"{source}"
            ),
            temperature=0.0,
            idempotency_key=f"vision:{payload.context_item_id}",
            context={"task": "harness.loop.vision_extract", "vision": True},
        )
    except Exception as exc:  # noqa: BLE001 — a dead branch of the cascade, not an error
        activity.logger.warning(
            "harness.loop.vision_extract_failed",
            extra={"context_item_id": payload.context_item_id, "error": str(exc)},
        )
        return DeriveContextResult(derived=False)

    text = (result.content or "").strip()
    if not text:
        return DeriveContextResult(derived=False)
    return DeriveContextResult(
        derived=True,
        context_item_id=f"{payload.context_item_id}:vision",
        kind_key=_derived_kind(payload.kind_key, "text"),
        text=text,
    )


@activity.defn
async def document_extract_text(payload: DeriveContextInput) -> DeriveContextResult:
    """Extract text from a DOCUMENT context item (DOCUMENT primitive).

    Backs `document.extract_text`. The gateway owns OCR (`OcrEnrichmentProcessor`
    -> NLP `/extract`), so this asks the gateway for the item's extracted text
    rather than opening a second, divergent extraction path.
    """
    settings = get_settings()
    try:
        text = await _api_client(settings).extract_document_text(
            payload.consultation_id,
            context_item_id=payload.context_item_id,
            tenant_id=payload.tenant_id,
        )
    except Exception as exc:  # noqa: BLE001 — a dead branch of the cascade, not an error
        activity.logger.warning(
            "harness.loop.document_extract_failed",
            extra={"context_item_id": payload.context_item_id, "error": str(exc)},
        )
        return DeriveContextResult(derived=False)

    text = (text or "").strip()
    if not text:
        return DeriveContextResult(derived=False)
    return DeriveContextResult(
        derived=True,
        context_item_id=f"{payload.context_item_id}:doctext",
        kind_key=_derived_kind(payload.kind_key, "text"),
        text=text,
    )


@activity.defn
async def nlp_extract_entities(payload: DeriveContextInput) -> DeriveContextResult:
    """Extract clinical entities from a TEXT context item.

    Backs `nlp.extract_entities` using the SAME `classify_tokens` call the
    document workflow's `extract_entities` activity uses — one NER path, not two.
    The derived item carries the entity surfaces so a downstream subscription can
    act on them.
    """
    settings = get_settings()
    source = await _resolve_derive_text(settings, payload)
    if not source.strip():
        return DeriveContextResult(derived=False)
    try:
        entities = await _nlp_client(settings).classify_tokens(
            source, tenant_id=_required_tenant(payload.tenant_id, "nlp_extract_entities")
        )
    except Exception as exc:  # noqa: BLE001 — a dead branch of the cascade, not an error
        activity.logger.warning(
            "harness.loop.nlp_extract_failed",
            extra={"context_item_id": payload.context_item_id, "error": str(exc)},
        )
        return DeriveContextResult(derived=False)

    surfaces = [e.text for e in entities if e.text]
    if not surfaces:
        return DeriveContextResult(derived=False)
    return DeriveContextResult(
        derived=True,
        context_item_id=f"{payload.context_item_id}:entities",
        kind_key=_derived_kind(payload.kind_key, "entities"),
        text="; ".join(surfaces),
    )


# Registered on the worker alongside ``DOCUMENT_ACTIVITIES``. Kept a SEPARATE
# list so the loop's surface is legible and so nothing here can be mistaken for
# part of the frozen document loop.
LOOP_ACTIVITIES: list[Callable[..., Any]] = [
    fetch_loop_config,
    livedoc_start,
    livedoc_stop,
    emit_loop_event,
]

# A THIRD list, for the same reason `LOOP_ACTIVITIES` is a second one:
# the deliberative lane is separable from the mechanical loop, and keeping the
# registration surfaces distinct means a reader can see at a glance which
# activities carry a model call.
REASONING_ACTIVITIES: list[Callable[..., Any]] = [
    plan_reasoning,
    run_specialist,
    record_adjudication,
    vision_extract_text,
    document_extract_text,
    nlp_extract_entities,
]
