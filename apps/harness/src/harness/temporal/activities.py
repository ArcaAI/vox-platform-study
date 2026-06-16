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
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from temporalio import activity

from harness.core.config import Settings, get_runtime_judge_config, get_settings
from harness.eval.judge.base import JudgeClient
from harness.eval.judge.providers import build_judge_client
from harness.guards.phi import (
    PhiEgressBlocked,
    PhiRedactor,
    ensure_egress_safe,
    ensure_inferential_egress_safe,
)
from harness.guides.retrieval.prompt import build_strict_citations_block
from harness.guides.retrieval.qdrant_store import KnowledgeQdrantStore
from harness.guides.retrieval.retriever import HybridRetriever, build_query
from harness.guides.retrieval.sparse import SparseBm25Embedder
from harness.sensors.base import SensorContext, SensorResult
from harness.sensors.config import SensorThresholds
from harness.sensors.inferential import (
    CITATION_VERIFY_NAME,
    GROUNDEDNESS_NAME,
    SAFETY_NAME,
    CitationVerifySensor,
    GraniteGuardianClient,
    GroundednessSensor,
    SafetySensor,
)
from harness.sensors.inferential.base import degraded_result
from harness.sensors.inferential.groundedness import ClaimVerdictCallback
from harness.services.api_client import (
    ApiClient,
    AssembleResponse,
    DraftResponse,
    FinalizeAssuranceResponse,
    PersistEntitiesResponse,
    RecordGateResponse,
)
from harness.services.embeddings_client import EmbeddingsClient
from harness.services.nlp_client import NlpClient
from harness.services.reranker_client import RerankerClient
from harness.services.sensor_runner import SensorRunOutput, run_computational_sensors
from harness.services.smr_client import SmrClient, SmrGenerationResult
from harness.temporal.models import (
    AssembleInput,
    EntitiesResult,
    EscalateInput,
    EscalateResult,
    ExtractEntitiesInput,
    FetchPolicyInput,
    FinalizeAssuranceInput,
    GenerateInput,
    HarnessPolicy,
    InferentialRunOutput,
    PersistDraftInput,
    PersistEntitiesInput,
    RecordGateInput,
    ReportProgressInput,
    ReportProgressResult,
    RetrieveContextInput,
    RetrievedContext,
    RunInferentialSensorsInput,
    RunSensorsInput,
)


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


# Progress reporting is fire-and-forget (TASK-345): a dedicated short HTTP
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


def _build_runtime_judge() -> JudgeClient:
    """Build the calibrated runtime judge (reuses the eval ``HARNESS_JUDGE_*`` config).

    Factored out (like the other client factories) so the inferential activity can
    build the judge once and the tests can monkeypatch it with a stub.
    """
    return build_judge_client(get_runtime_judge_config())


def _granite_client(settings: Settings) -> GraniteGuardianClient:
    return GraniteGuardianClient(settings.safety)


def _phi_redactor() -> PhiRedactor:
    """Build the fail-closed PHI egress redactor (TASK-357; Presidio engines are lazy).

    Factored out like the other client factories so each cloud-bound activity builds
    it once per invocation (the spaCy model loads only on an actual cloud redaction)
    and the tests can monkeypatch it with a stub.
    """
    return PhiRedactor()


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
# Document-loop activities
# ---------------------------------------------------------------------------


@activity.defn
async def fetch_policy(payload: FetchPolicyInput) -> HarnessPolicy:
    """Read the effective harness policy for the tenant (Phase-6 live policy injection).

    I/O lives here, never the workflow body. Raises :class:`ApiServiceError` on an
    unreachable endpoint; the workflow catches the resulting ``ActivityError`` and
    degrades to the code defaults (fail-safe — never crash the loop).
    """
    settings = get_settings()
    data = await _api_client(settings).get_policy(payload.tenant_id)
    return HarnessPolicy.from_api(data)


@activity.defn
async def extract_entities(payload: ExtractEntitiesInput) -> EntitiesResult:
    """Run medical NER over ``text`` via the NLP service."""
    settings = get_settings()
    entities = await _nlp_client(settings).classify_tokens(payload.text, language=payload.language)
    return EntitiesResult(entities=entities)


@activity.defn
async def persist_entities(payload: PersistEntitiesInput) -> PersistEntitiesResponse:
    """Persist extracted NamedEntity rows via the apps/api internal endpoint."""
    settings = get_settings()
    return await _api_client(settings).persist_entities(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        context_item_id=payload.context_item_id,
        entities=payload.entities,
        user_id=payload.user_id,
    )


@activity.defn
async def assemble_prompt(payload: AssembleInput) -> AssembleResponse:
    """Resolve the prompt tier + assemble the SMR payload via apps/api."""
    settings = get_settings()
    return await _api_client(settings).assemble(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        template=payload.template,
        dna_style_id=payload.dna_style_id,
        conversation_language=payload.conversation_language,
    )


@activity.defn
async def generate(payload: GenerateInput) -> SmrGenerationResult:
    """Generate the SOAP draft synchronously via the SMR service."""
    settings = get_settings()
    hp = payload.hyperparameters or {}

    # TASK-357: enforce the fail-closed PHI egress guard before any cloud SMR call.
    # Local providers (the default) are a pure pass-through. A fail-closed block
    # raises PhiEgressBlocked, which propagates and fails the workflow — no draft is
    # ever persisted (the SMR failure-propagation invariant), never a silent leak.
    redactor = _phi_redactor()
    try:
        prompt = ensure_egress_safe(
            payload.prompt,
            provider=payload.provider,
            settings=settings,
            phi_enabled=payload.phi_enabled,
            phi_fail_closed=payload.phi_fail_closed,
            redactor=redactor,
        )
        system_prompt = (
            ensure_egress_safe(
                payload.system_prompt,
                provider=payload.provider,
                settings=settings,
                phi_enabled=payload.phi_enabled,
                phi_fail_closed=payload.phi_fail_closed,
                redactor=redactor,
            )
            if payload.system_prompt is not None
            else None
        )
    except PhiEgressBlocked as exc:
        activity.logger.warning(
            "harness.phi_egress.blocked",
            extra={"provider": exc.provider, "reason": exc.reason, "stage": "generate"},
        )
        raise

    return await _smr_client(settings).generate(
        prompt=prompt,
        system_prompt=system_prompt,
        provider=payload.provider,
        model=payload.model,
        temperature=hp.get("temperature"),
        max_tokens=hp.get("max_tokens"),
        top_p=hp.get("top_p"),
        response_format=payload.response_format,
    )


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
    if not settings.retrieval.enabled:
        return RetrievedContext()

    query = build_query(payload.entities)
    result = await _hybrid_retriever(settings).retrieve(query=query, tenant_id=payload.tenant_id)
    return RetrievedContext(
        chunks=result.chunks,
        degraded=result.degraded,
        prompt_block=build_strict_citations_block(result.chunks),
    )


@activity.defn
async def run_sensors(payload: RunSensorsInput) -> SensorRunOutput:
    """Build the SensorContext + provenance and run all computational sensors.

    ``payload.thresholds`` is the policy-driven :class:`SensorThresholds` (Phase 6);
    ``None`` falls back to the sensors' own env-driven defaults.
    """
    return run_computational_sensors(
        note_text=payload.note_text,
        transcript_text=payload.transcript_text,
        note_entities=payload.note_entities,
        transcript_entities=payload.transcript_entities,
        response_format=payload.response_format,
        transcript_context_item_id=payload.transcript_context_item_id,
        retrieved_chunk_ids=payload.retrieved_chunk_ids,
        thresholds=payload.thresholds,
    )


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


# Heartbeat cadence for the long inferential pass (TASK-354 Defect A). The workflow sets
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

    ``verdict_cache`` (TASK-359 WS-1) is the content-addressed per-claim verdict map this pass
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
    """Build the Q5 per-claim live publisher, or ``None`` when not streaming.

    TASK-355 Phase D Slice 5d: returns a best-effort ``on_claim`` callback only when
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
            )
        except Exception as exc:  # noqa: BLE001 — live feed is fire-and-forget
            activity.logger.warning(
                "harness.assurance_event.failed",
                extra={"consultation_id": consultation_id, "claim_id": claim_ref, "error": str(exc)},
            )

    return _publish


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
    judge_config = get_runtime_judge_config()

    # TASK-359 WS-1 — seed the per-claim verdict cache from earlier passes (the L2 carrier).
    # The sensors reuse a cached verdict for an unchanged claim and re-judge only cache-missing
    # ones; we echo the (now-populated) cache on the output so the workflow threads it forward.
    # On any early degrade below, the unchanged inbound cache is returned (nothing was judged).
    verdict_cache: dict[str, bool] = dict(payload.prior_verdicts)

    # TASK-357: enforce the fail-closed PHI egress guard before any cloud judge/Granite
    # call — redact the Granite-screened note (safety provider) and the judge premise
    # (transcript + per-claim hypotheses/evidence + knowledge chunks, judge provider).
    # Local providers (the default) are an identity no-op. A fail-closed block degrades
    # the whole inferential pass (reduced assurance) rather than raising into the loop —
    # the inferential degrade contract — so an unverifiable note never auto-PASSes.
    try:
        note_text, transcript_text, citations_map, knowledge_chunks = (
            ensure_inferential_egress_safe(
                note_text=payload.note_text,
                transcript_text=payload.transcript_text,
                citations_map=payload.citations_map,
                knowledge_chunks=payload.knowledge_chunks,
                judge_provider=str(judge_config.provider),
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
        return _assemble_inferential_output(degraded, verdict_cache)

    ctx = SensorContext(
        note_text=note_text,
        transcript_text=transcript_text,
        citations_map=citations_map,
        knowledge_chunks=knowledge_chunks,
    )

    # TASK-354 Defect A: heartbeat for the whole pass (the costly, many-call part) so a
    # hung attempt / dead worker is detected at heartbeat_timeout (60s) instead of the
    # 900s start_to_close. Cancelled in ``finally`` once the pass returns either way.
    heartbeat = asyncio.create_task(_heartbeat_periodically())
    try:
        try:
            judge = _build_runtime_judge()
        except Exception as exc:  # noqa: BLE001 — un-buildable judge degrades, never raises
            reason = f"inferential judge unavailable: {exc}"
            degraded = [
                degraded_result(GROUNDEDNESS_NAME, reason),
                degraded_result(CITATION_VERIFY_NAME, reason),
            ]
            # Phase 6: a disabled safety guard contributes no safety result at all.
            if payload.safety_enabled:
                degraded.append(degraded_result(SAFETY_NAME, reason))
            return _assemble_inferential_output(degraded, verdict_cache)

        thresholds = SensorThresholds()
        # Phase 6: the groundedness pass threshold is policy-driven; the safety screen
        # is skipped entirely when the policy disables the safety guard.
        # TASK-355 R-5: claim batching is env-driven (HARNESS_JUDGE_ENTAILMENT_BATCH_SIZE);
        # default 1 keeps the legacy one-call-per-claim path. Read from the same judge
        # config the runtime judge is built from.
        groundedness = GroundednessSensor(
            threshold=payload.groundedness_threshold,
            batch_size=judge_config.entailment_batch_size,
        )
        citation_verify = CitationVerifySensor(threshold=thresholds.citation_verify_threshold)
        # TASK-355 Phase D Slice 5d (Q5) — stream each groundedness claim verdict to
        # apps/api as it resolves (optimistic ASSURANCE pass only). Best-effort: the
        # callback swallows every error so the live feed can NEVER degrade the pass.
        on_claim = _build_assurance_publisher(settings, payload, ctx)
        tasks = [
            groundedness.arun(ctx, judge=judge, on_claim=on_claim, verdict_cache=verdict_cache),
            # TASK-359 WS-2 — citation_verify reuses the SAME shared cache dict; its keys never
            # collide with groundedness (different premise + sensor identity), so the two verdicts
            # stay separable while both are reused across regen passes.
            citation_verify.arun(ctx, judge=judge, verdict_cache=verdict_cache),
        ]
        if payload.safety_enabled:
            # TASK-363 WS-3 — the safety screen reuses the SAME shared cache dict: each
            # per-(criterion, screened-text, model) verdict is content-addressed with a
            # "safety" sensor identity, so its keys never collide with groundedness/citation
            # entries while an unchanged-content regen pass reuses the prior screen (no Granite
            # call). No new carrier field / workflow command — the existing dict is threaded.
            tasks.append(
                SafetySensor(_granite_client(settings)).arun(
                    ctx, judge=judge, screen_cache=verdict_cache
                )
            )
        results = list(await asyncio.gather(*tasks))
        return _assemble_inferential_output(results, verdict_cache)
    finally:
        heartbeat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat


@activity.defn
async def persist_draft(payload: PersistDraftInput) -> DraftResponse:
    """Persist the generated draft (ContextItem + SummaryMeta + PENDING_REVIEW).

    TASK-355 Phase D: ``payload.phase == "DRAFT_PENDING_SENSORS"`` switches apps/api
    to the optimistic early persist (verdict withheld, GENERATE-only audit); absent
    (legacy) keeps the single-shot persist (full scores, straight to PENDING_REVIEW).
    """
    settings = get_settings()
    return await _api_client(settings).persist_draft(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        content=payload.content,
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
    )


@activity.defn
async def finalize_assurance(payload: FinalizeAssuranceInput) -> FinalizeAssuranceResponse:
    """Backfill the early-persisted draft with the inferential verdict (TASK-355 Phase D).

    Second phase of optimistic delivery: apps/api stamps the inferential scores +
    gate verdict + ``assuranceCompletedAt`` onto the early ``SummaryMeta``, flips
    ``DRAFT_PENDING_SENSORS → PENDING_REVIEW``, and records the deferred ``SENSOR_RUN``
    (+ ``REDUCED_ASSURANCE``) WORM audit. Idempotent on the apps/api side (a retry
    re-stamps the same verdict without regressing state).
    """
    settings = get_settings()
    return await _api_client(settings).finalize_assurance(
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
    )


@activity.defn
async def record_gate_decision(payload: RecordGateInput) -> RecordGateResponse:
    """Record the clinician GATE_DECISION (WORM audit) via apps/api."""
    settings = get_settings()
    return await _api_client(settings).record_gate_decision(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        decision=payload.decision,
        gate_decision=payload.gate_decision,
        user_id=payload.user_id,
        context_item_version_id=payload.context_item_version_id,
        attestation_hash=payload.attestation_hash,
        clinician_id=payload.clinician_id,
    )


@activity.defn
async def report_progress(payload: ReportProgressInput) -> ReportProgressResult:
    """Publish one workflow stage event to the live UI feed (TASK-345).

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
    """Escalate an un-signed gate past its SLA (fail-safe: log + flag, keep waiting)."""
    activity.logger.warning(
        "harness.gate.sla_breached",
        extra={
            "consultation_id": payload.consultation_id,
            "tenant_id": payload.tenant_id,
            "reason": payload.reason,
            "job_id": payload.job_id,
        },
    )
    return EscalateResult(escalated=True)


# Registered on the worker alongside ``ping_activity``.
DOCUMENT_ACTIVITIES: list[Callable[..., Any]] = [
    fetch_policy,
    extract_entities,
    persist_entities,
    assemble_prompt,
    retrieve_context,
    generate,
    run_sensors,
    run_inferential_sensors,
    persist_draft,
    finalize_assurance,
    record_gate_decision,
    escalate_gate,
    report_progress,
]
