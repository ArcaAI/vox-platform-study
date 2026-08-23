"""The three R3 capabilities that had no node, activity or sensor anywhere (TASK-791 W1-W3).

R3 asks ONE workflow to coordinate: record -> transcribe -> realtime entity extraction ->
**realtime short summaries** -> autofill SOAP -> **intelligent suggestions** ->
**spelling / medical-term / drug-name correction**. TASK-789 verified the last three did not
exist: the nearest neighbours only VERIFY (``consultation.bindTerminology`` validates codes
read-only; ``sensors/computational/numeric_dose.py`` flags a dose mismatch and never corrects
it). These are those three nodes.

## Why all three live in one module

They share one shape — bind text, resolve a model tenant -> SYSTEM, call a peer service, return
a structured proposal — and differ only in the prompt and the parse. Three near-duplicate
modules would drift; the palette's own ``consultation_{capture,nlp,compose}`` grouping already
sets the precedent of grouping by pipeline stage rather than one module per node.

## No second inference stack (rule 06)

Nothing here hosts a model. LLM judgement goes to ``apps/text`` via the same ``TextClient`` the
already-shipped ``generate`` activity uses; NER goes to ``apps/nlp`` through the existing
``extract_entities`` activity. Provider/model SELECTION resolves tenant -> SYSTEM through
``get_policy(task_key=...)`` — the ``AiTaskDefault`` overlay ``nodes/text_generate.py``
established — and **fails CLOSED**: an unresolved selection DEGRADES the node rather than
substituting an env default (``00-project-context.md`` §Configuration Principles).

## W1's incremental path, and the constraint it respects

``nodes/stt_placeholder.py``'s module docstring is explicit that **no per-frame audio and no
per-token transcript may cross a Temporal workflow boundary** — a per-frame signal loop is both
a determinism risk and a latency disaster. So the batching here is entirely ACTIVITY-SIDE: the
workflow dispatches this node once, and the activity windows the bound transcript and emits one
announcement per window as each summary resolves. That mirrors ``run_inferential_sensors``'
per-claim ``report_assurance_event`` callback, which is the established shape for true mid-pass
streaming out of a single activity.

**The announcement carries no text.** ``EmitLoopEventInput``'s own docstring states the loop
plane is "a live UI feed, not a PHI transport" — ids, keys and labels only. So each event
carries an ordinal, a total and a character count; the summary text itself travels as node
OUTPUT, to downstream nodes and the run result. Rendering it live needs a read-back surface the
console owns — recorded as a requested contract in the TASK-791 README rather than invented here.

## W3 is a PROPOSAL surface. This is a patient-safety property, not a preference.

A system that silently rewrites a drug name or a dose in clinical text is a patient-safety
defect. ``interpreter_consultation_propose_corrections`` therefore:

* returns the source text **byte-identical** and marks ``applied: False``;
* attributes every proposal to BOTH the detector that found the span (``detectedBy``) and the
  model that proposed the replacement (``proposedBy``), so a clinician can weigh it;
* **verifies each proposal against the source before publishing it** — a proposal whose
  ``[start:end)`` does not equal its own ``original`` is DROPPED and counted, because accepting
  it in a one-click UI would splice the replacement over the wrong characters.

The accept/reject decision belongs to the clinician, and the surface that offers it belongs to
the console (TASK-793).
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from temporalio import activity

from harness.core.config import get_settings
from harness.guards.phi.egress import ensure_egress_safe
from harness.guards.phi.redactor import PhiEgressBlocked
from harness.services.api_client import ApiServiceError
from harness.services.nlp_client import NlpServiceError
from harness.services.text_client import TextServiceError
from harness.temporal.activities import (
    _api_client,  # noqa: SLF001 — the sanctioned accessor, same as nodes/text_generate.py
    _phi_redactor,  # noqa: SLF001
    _text_client,  # noqa: SLF001
    extract_entities,
)
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._consultation_shared import bound_text, run_identity
from harness.temporal.interpreter.nodes._shared import (
    STATUS_DEGRADED,
    STATUS_ERROR,
    STATUS_OK,
    now,
    record_and_flush,
)
from harness.temporal.interpreter.nodes._soap import (
    SOAP_OUTPUT_INSTRUCTION,
    SOAP_RESPONSE_FORMAT,
    sections_for,
)
from harness.temporal.models import ExtractEntitiesInput, HarnessPolicy

#: Task keys this family may select under. Mirrors ``nodes/text_generate.py``'s
#: ``_ALLOWED_TASK_KEYS`` — the value still SELECTS the model via the ``AiTaskDefault`` overlay;
#: this set only rejects a typo'd key before a pointless gateway round trip.
_ALLOWED_TASK_KEYS = {"text.finalize", "text.live", "text.test"}

#: Default transcript window for W1. A tuning knob, not a selection — it may fail open to this
#: value (``SettingDescriptor.failMode`` split: selection closed, tuning open).
_DEFAULT_WINDOW_CHARS = 1200
_MAX_WINDOWS = 24

#: The live-feed event kind W1 announces each interim summary under.
LOOP_EVENT_SUMMARY_INTERIM = "summary.interim"

#: Correction categories W3 will publish. Anything else the model returns is dropped — an
#: open-ended category set would let a model invent a class of edit nobody reviewed.
_CORRECTION_CATEGORIES = {"spelling", "medicalTerm", "drugName"}

_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _parse_json_object(content: str) -> dict[str, Any] | None:
    """Best-effort parse of a model's JSON reply.

    Tolerates the common ```json fence / prose-preamble shapes by falling back to the first
    balanced-looking ``{...}`` span. Returns ``None`` when nothing parses — the caller DEGRADES
    rather than fabricating a result, which is the whole point of parsing strictly here.
    """
    for candidate in (content, (_JSON_BLOCK.search(content) or _Empty()).group(0)):
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


class _Empty:
    """Null-object so ``_parse_json_object``'s fallback stays a single expression."""

    def group(self, _index: int) -> str:
        return ""


async def _resolve_selection(
    payload: NodeActivityInput, task_key: str
) -> tuple[HarnessPolicy | None, str | None, str | None, str | None]:
    """``(policy, provider, model, error_code)`` — selection resolved tenant -> SYSTEM.

    ``error_code`` non-``None`` means the caller must DEGRADE. Selection is ``failMode: closed``:
    an unresolved provider/model is never substituted with an env default, mirroring the text
    service's own fail-closed 422.
    """
    try:
        raw_policy = await _api_client(get_settings()).get_policy(
            payload.tenant_id, task_key=task_key
        )
    except ApiServiceError:
        return None, None, None, "policy_fetch_unreachable"

    policy = HarnessPolicy.from_api(raw_policy)
    if not policy.text_provider or not policy.text_model:
        return policy, None, None, "no_text_selection"
    return policy, policy.text_provider, policy.text_model, None


def _screen(
    text: str, *, provider: str, policy: HarnessPolicy, settings: Any, redactor: Any
) -> str:
    """The same fail-closed PHI egress chokepoint ``nodes/text_generate.py`` uses."""
    return ensure_egress_safe(
        text,
        provider=provider,
        settings=settings,
        phi_enabled=policy.phi_enabled,
        phi_fail_closed=policy.phi_fail_closed,
        redactor=redactor,
    )


def _windows(text: str, size: int) -> list[str]:
    """Split ``text`` into at most ``_MAX_WINDOWS`` contiguous windows of ``size`` characters.

    A hard cap rather than an unbounded split: the node's own activity timeout is the only other
    thing standing between a very long transcript and a run that never finishes, and a cap that
    is visible in the output (``windowCount``) is easier to reason about than a timeout.
    """
    if size <= 0:
        size = _DEFAULT_WINDOW_CHARS
    chunks = [text[i : i + size] for i in range(0, len(text), size)]
    return chunks[:_MAX_WINDOWS] or [text]


def text_digest(text: str) -> str:
    """SHA-256 of the text a set of correction proposals was computed against.

    Published alongside the proposals so a console can refuse to splice a replacement into text
    that has since drifted. A span is only meaningful against the exact bytes it was measured
    on; without this, a stale one-click accept edits the wrong characters — the same failure
    ``_verified_proposals`` guards against locally.
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _stable_id(*parts: str) -> str:
    """A DETERMINISTIC id for one clinician-actionable item.

    Not ``uuid4``: a Temporal activity retries, and a retry that re-publishes the same
    suggestion or proposal under a fresh id would resurrect an item the clinician already
    dismissed. Derived from the node and the item's own content, so a retry is a no-op and two
    genuinely different items never collide.
    """
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# W1 — consultation.realtimeSummary
# ---------------------------------------------------------------------------


@activity.defn(name="interpreter.consultation_realtime_summary")
async def interpreter_consultation_realtime_summary(
    payload: NodeActivityInput,
) -> NodeActivityResult:
    """W1 — short running summaries produced DURING a consultation, announced as they resolve.

    One ``apps/text`` generation and one loop-event announcement per transcript window. A failed
    announcement never costs the summary: the live feed must never fail the loop, exactly as
    ``ApiClient.report_loop_event``'s docstring states for the ``emit_loop_event`` activity.
    """
    started = now()
    config = payload.config
    task_key = config.get("taskKey") or "text.live"
    if task_key not in _ALLOWED_TASK_KEYS:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="invalid_task_key"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"config.taskKey {task_key!r} is not a recognized text task key",
        )

    text = bound_text(payload.bound_inputs)
    if not text:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_text"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="no text bound from an upstream node to summarize"
        )

    policy, provider, model, error_code = await _resolve_selection(payload, task_key)
    if error_code is not None or policy is None or provider is None or model is None:
        await record_and_flush(payload, status=STATUS_ERROR, started=started, error_code=error_code)
        reason = (
            "effective policy fetch unreachable"
            if error_code == "policy_fetch_unreachable"
            else "no text provider/model resolved for this tenant"
        )
        return NodeActivityResult(status="DEGRADED", reason=reason)

    window_chars = config.get("windowChars")
    window_chars = window_chars if isinstance(window_chars, int) else _DEFAULT_WINDOW_CHARS
    windows = _windows(text, window_chars)

    settings = get_settings()
    redactor = _phi_redactor()
    text_client = _text_client(settings)
    api_client = _api_client(settings)
    identity = run_identity(payload.run_payload)
    # The default asks for a SOAP-shaped running note, because R3's requirement is to autofill
    # "summaries and gist into customized SOAP forms" — a flat blob cannot populate a form. The
    # instruction is the DEFAULT ENGINE's own (``_soap.SOAP_OUTPUT_INSTRUCTION``), so a
    # graph-governed consultation and a default one render identically in the same panel. A
    # graph author who wants a different form supplies ``config.systemPrompt``.
    system_prompt = _optional_str(config.get("systemPrompt")) or (
        "You are assisting during a live clinical consultation. Maintain a short running note "
        "of the consultation so far. State only what the transcript supports. Do not diagnose "
        "beyond what was said, do not recommend treatment, and do not invent details.\n\n"
        + SOAP_OUTPUT_INSTRUCTION
    )
    response_format = config.get("responseFormat") or SOAP_RESPONSE_FORMAT

    summaries: list[str] = []
    sections: list[dict[str, str]] = []
    running_summary = ""
    announced = 0
    published = 0
    for ordinal, window in enumerate(windows, start=1):
        try:
            safe_window = _screen(
                window, provider=provider, policy=policy, settings=settings, redactor=redactor
            )
            safe_system = _screen(
                system_prompt,
                provider=provider,
                policy=policy,
                settings=settings,
                redactor=redactor,
            )
        except PhiEgressBlocked as exc:
            await record_and_flush(
                payload, status=STATUS_DEGRADED, started=started, error_code="phi_egress_blocked"
            )
            return NodeActivityResult(status="DEGRADED", reason=f"phi egress blocked: {exc}")

        try:
            result = await text_client.generate(
                tenant_id=payload.tenant_id,
                prompt=safe_window,
                system_prompt=safe_system,
                provider=provider,
                model=model,
                temperature=config.get("temperature"),
                max_tokens=config.get("maxTokens"),
                response_format=response_format,
            )
        except TextServiceError as exc:
            await record_and_flush(
                payload, status=STATUS_DEGRADED, started=started, error_code="text_generate_failed"
            )
            return NodeActivityResult(
                status="DEGRADED",
                reason=f"realtime summary generation failed: {exc}",
                output={
                    "summaries": summaries,
                    "windowCount": len(summaries),
                    "published": published,
                },
            )

        summaries.append(result.content)
        sections, running_summary = sections_for("\n\n".join(summaries))

        # DELIVERY (TASK-796). The summary TEXT travels on the live-summary plane — the same
        # ``consultation:live-summary:{id}`` channel the default engine flushes onto, so the
        # already-shipped SSE route, SDK hook and console panel render it with no new consumer.
        # Best-effort in exactly the sense the announcement below is: a plane that is down costs
        # the DELIVERY of this window, never the summary or the run.
        if identity.consultation_id and running_summary:
            try:
                await api_client.publish_live_summary(
                    identity.consultation_id,
                    tenant_id=payload.tenant_id,
                    running_summary=running_summary,
                    sections=sections,
                    source="interpreter",
                    node_type=payload.node_type,
                    ordinal=ordinal,
                    total=len(windows),
                    provider=provider,
                    model=model,
                    task_key=task_key,
                    user_id=identity.user_id,
                    job_id=identity.job_id,
                )
                published += 1
            except ApiServiceError:
                pass

        # Announce, best-effort. IDS AND COUNTS ONLY — never the summary or the transcript.
        # UNCHANGED by TASK-796: ``EmitLoopEventInput`` stays ``extra="forbid"`` and this
        # detail stays ``{ordinal, total, chars}``. The loop plane is not a PHI transport.
        if identity.consultation_id:
            try:
                await api_client.report_loop_event(
                    identity.consultation_id,
                    tenant_id=payload.tenant_id,
                    event_type=LOOP_EVENT_SUMMARY_INTERIM,
                    kind_key=payload.node_type,
                    detail={
                        "ordinal": ordinal,
                        "total": len(windows),
                        "chars": len(result.content),
                    },
                )
                announced += 1
            except ApiServiceError:
                # The live feed is best-effort; losing an announcement must not lose the work.
                pass

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            "summaries": summaries,
            "text": "\n\n".join(summaries),
            "sections": sections,
            "runningSummary": running_summary,
            "windowCount": len(summaries),
            "announced": announced,
            "published": published,
            "provider": provider,
            "model": model,
        },
    )


# ---------------------------------------------------------------------------
# W2 — consultation.suggestions
# ---------------------------------------------------------------------------


_SUGGESTION_SYSTEM_PROMPT = (
    "You assist a clinician during a live consultation. From the transcript and context, "
    "propose the most useful next questions, checks or omissions to consider. "
    'Reply ONLY with JSON of the form {"suggestions": [{"text": "...", "category": "..."}]}. '
    "Ground every suggestion in the supplied text. Never state a diagnosis as fact and never "
    "invent clinical findings. If nothing useful can be suggested, return an empty list."
)


@activity.defn(name="interpreter.consultation_suggestions")
async def interpreter_consultation_suggestions(payload: NodeActivityInput) -> NodeActivityResult:
    """W2 — clinician-facing suggestions from the live transcript + bound context.

    Generation is delegated to ``apps/text`` (rule 06). An unparseable reply DEGRADES with an
    empty list rather than surfacing half-parsed or invented suggestions.
    """
    started = now()
    config = payload.config
    task_key = config.get("taskKey") or "text.live"
    if task_key not in _ALLOWED_TASK_KEYS:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="invalid_task_key"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"config.taskKey {task_key!r} is not a recognized text task key",
        )

    text = bound_text(payload.bound_inputs)
    if not text:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_text"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="no text bound from an upstream node to suggest from"
        )

    policy, provider, model, error_code = await _resolve_selection(payload, task_key)
    if error_code is not None or policy is None or provider is None or model is None:
        await record_and_flush(payload, status=STATUS_ERROR, started=started, error_code=error_code)
        reason = (
            "effective policy fetch unreachable"
            if error_code == "policy_fetch_unreachable"
            else "no text provider/model resolved for this tenant"
        )
        return NodeActivityResult(status="DEGRADED", reason=reason)

    settings = get_settings()
    redactor = _phi_redactor()
    try:
        safe_text = _screen(
            text, provider=provider, policy=policy, settings=settings, redactor=redactor
        )
        safe_system = _screen(
            _SUGGESTION_SYSTEM_PROMPT,
            provider=provider,
            policy=policy,
            settings=settings,
            redactor=redactor,
        )
    except PhiEgressBlocked as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="phi_egress_blocked"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"phi egress blocked: {exc}")

    try:
        result = await _text_client(settings).generate(
            tenant_id=payload.tenant_id,
            prompt=safe_text,
            system_prompt=safe_system,
            provider=provider,
            model=model,
            temperature=config.get("temperature"),
            max_tokens=config.get("maxTokens"),
            response_format=config.get("responseFormat"),
        )
    except TextServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="text_generate_failed"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"suggestion generation failed: {exc}")

    parsed = _parse_json_object(result.content)
    raw = parsed.get("suggestions") if isinstance(parsed, dict) else None
    if not isinstance(raw, list):
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="unparseable_suggestions"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason="the model did not return a parseable suggestion list",
            output={"suggestions": [], "count": 0},
        )

    suggestions = [
        item for item in raw if isinstance(item, dict) and _optional_str(item.get("text"))
    ]
    max_suggestions = config.get("maxSuggestions")
    if isinstance(max_suggestions, int) and max_suggestions >= 0:
        suggestions = suggestions[:max_suggestions]

    # TASK-796 — a suggestion the clinician can ACT on needs an identity and a resolvable
    # state, not just prose: an id stable across activity retries (so a dismissed suggestion
    # stays dismissed), the model that proposed it, and a status only the clinician advances.
    suggestions = [
        {
            **item,
            "suggestionId": _stable_id(payload.node_id, str(index), str(item.get("text") or "")),
            "status": "PROPOSED",
            "proposedBy": f"{provider}:{model}",
        }
        for index, item in enumerate(suggestions)
    ]

    identity = run_identity(payload.run_payload)
    published = False
    if identity.consultation_id and suggestions:
        try:
            await _api_client(settings).publish_live_assist(
                identity.consultation_id,
                tenant_id=payload.tenant_id,
                kind="suggestions",
                node_type=payload.node_type,
                suggestions=suggestions,
                provider=provider,
                model=model,
                user_id=identity.user_id,
                job_id=identity.job_id,
            )
            published = True
        except ApiServiceError:
            # Best-effort, same posture as every other live plane: losing the delivery must
            # never lose the work, and must never fail the run.
            pass

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            "suggestions": suggestions,
            "count": len(suggestions),
            "published": published,
            "provider": provider,
            "model": model,
        },
    )


# ---------------------------------------------------------------------------
# W3 — consultation.proposeCorrections
# ---------------------------------------------------------------------------


_CORRECTION_SYSTEM_PROMPT = (
    "You review clinical text for spelling, medical-term and drug-name errors. "
    "You are given the text and the character spans of detected clinical entities. "
    "Propose corrections ONLY for spans that are genuinely wrong. "
    'Reply ONLY with JSON of the form {"proposals": [{"start": 0, "end": 0, '
    '"original": "...", "proposed": "...", "category": "spelling|medicalTerm|drugName", '
    '"confidence": 0.0, "rationale": "..."}]}. '
    "Never change a dose, a number or a unit. Copy `original` exactly as it appears in the "
    "text at [start, end). If nothing is wrong, return an empty list."
)


@activity.defn(name="interpreter.consultation_propose_corrections")
async def interpreter_consultation_propose_corrections(
    payload: NodeActivityInput,
) -> NodeActivityResult:
    """W3 — PROPOSE spelling / medical-term / drug-name corrections. Never apply them.

    Detection is ``apps/nlp``'s (the existing ``extract_entities`` activity); the proposal is
    ``apps/text``'s. Both halves are recorded on every proposal so a clinician can weigh it, and
    every proposal is verified against the source before it is published — see the module
    docstring for why an unverifiable proposal is dropped rather than shown.
    """
    started = now()
    config = payload.config
    task_key = config.get("taskKey") or "text.live"
    if task_key not in _ALLOWED_TASK_KEYS:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="invalid_task_key"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"config.taskKey {task_key!r} is not a recognized text task key",
        )

    text = bound_text(payload.bound_inputs)
    if not text:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_text"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="no text bound from an upstream node to review"
        )

    identity = run_identity(payload.run_payload)
    try:
        extracted = await extract_entities(
            ExtractEntitiesInput(
                text=text,
                language=str(config.get("language") or "en"),
                tenant_id=payload.tenant_id,
                consultation_id=identity.consultation_id,
            )
        )
    except NlpServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="nlp_extract_failed"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"entity detection failed, so no correction can be proposed: {exc}",
            output={"text": text, "proposals": [], "applied": False, "appliedCount": 0},
        )

    entities = list(extracted.entities)
    unchanged = {
        "text": text,
        "proposals": [],
        "applied": False,
        "appliedCount": 0,
        "rejectedProposals": 0,
    }
    if not entities:
        # Nothing clinical was detected, so there is nothing to propose a correction FOR.
        # Calling a model here would invite ungrounded edits to ordinary prose.
        await record_and_flush(payload, status=STATUS_OK, started=started)
        return NodeActivityResult(status="SUCCEEDED", output=unchanged)

    policy, provider, model, error_code = await _resolve_selection(payload, task_key)
    if error_code is not None or policy is None or provider is None or model is None:
        await record_and_flush(payload, status=STATUS_ERROR, started=started, error_code=error_code)
        reason = (
            "effective policy fetch unreachable"
            if error_code == "policy_fetch_unreachable"
            else "no text provider/model resolved for this tenant"
        )
        return NodeActivityResult(status="DEGRADED", reason=reason, output=unchanged)

    spans = [
        {"start": entity.start, "end": entity.end, "text": entity.text, "type": entity.type}
        for entity in entities
        if entity.start >= 0 and entity.end > entity.start
    ]
    user_prompt = json.dumps({"text": text, "entities": spans}, ensure_ascii=False)

    settings = get_settings()
    redactor = _phi_redactor()
    try:
        safe_prompt = _screen(
            user_prompt, provider=provider, policy=policy, settings=settings, redactor=redactor
        )
        safe_system = _screen(
            _CORRECTION_SYSTEM_PROMPT,
            provider=provider,
            policy=policy,
            settings=settings,
            redactor=redactor,
        )
    except PhiEgressBlocked as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="phi_egress_blocked"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"phi egress blocked: {exc}")

    try:
        result = await _text_client(settings).generate(
            tenant_id=payload.tenant_id,
            prompt=safe_prompt,
            system_prompt=safe_system,
            provider=provider,
            model=model,
            temperature=config.get("temperature"),
            max_tokens=config.get("maxTokens"),
            response_format=config.get("responseFormat"),
        )
    except TextServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="text_generate_failed"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"correction proposal generation failed: {exc}",
            output=unchanged,
        )

    parsed = _parse_json_object(result.content)
    raw = parsed.get("proposals") if isinstance(parsed, dict) else None
    if not isinstance(raw, list):
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="unparseable_proposals"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason="the model did not return a parseable proposal list",
            output=unchanged,
        )

    proposals, rejected = _verified_proposals(
        raw, text, provider=provider, model=model, node_id=payload.node_id
    )

    # TASK-796 — deliver the PROPOSALS, and only the proposals. The envelope is explicitly
    # proposal-first on the wire as well as in the output: nothing is applied, every item is
    # ``PROPOSED``, and ``textSha256`` pins the exact bytes the spans were measured against so
    # a console cannot accept one into text that has since drifted.
    corrections = {
        "proposals": proposals,
        "applied": False,
        "appliedCount": 0,
        "rejectedProposals": rejected,
        "textSha256": text_digest(text),
    }
    published = False
    if identity.consultation_id and proposals:
        try:
            await _api_client(settings).publish_live_assist(
                identity.consultation_id,
                tenant_id=payload.tenant_id,
                kind="corrections",
                node_type=payload.node_type,
                corrections=corrections,
                provider=provider,
                model=model,
                user_id=identity.user_id,
                job_id=identity.job_id,
            )
            published = True
        except ApiServiceError:
            pass

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            # The source text, returned BYTE-IDENTICAL. Nothing here rewrites clinical text.
            "text": text,
            "proposals": proposals,
            "applied": False,
            "appliedCount": 0,
            "rejectedProposals": rejected,
            "textSha256": corrections["textSha256"],
            "published": published,
            "provider": provider,
            "model": model,
        },
    )


def _verified_proposals(
    raw: list[Any], source: str, *, provider: str, model: str, node_id: str
) -> tuple[list[dict[str, Any]], int]:
    """Keep only proposals that can be safely offered for one-click acceptance.

    A proposal survives when it is well-formed, carries a known category, and — the safety
    check — its own ``[start, end)`` in the SOURCE equals the ``original`` it claims to replace.
    Everything else is dropped and counted, never silently repaired: repairing a mis-specified
    span would be this module guessing at an edit to clinical text, which is exactly what it
    exists not to do.
    """
    proposals: list[dict[str, Any]] = []
    rejected = 0
    for item in raw:
        if not isinstance(item, dict):
            rejected += 1
            continue
        start, end = item.get("start"), item.get("end")
        original, proposed = item.get("original"), item.get("proposed")
        category = item.get("category")
        if (
            not isinstance(start, int)
            or not isinstance(end, int)
            or not isinstance(original, str)
            or not isinstance(proposed, str)
            or category not in _CORRECTION_CATEGORIES
            or start < 0
            or end > len(source)
            or start >= end
        ):
            rejected += 1
            continue
        if source[start:end] != original:
            # The proposal misreports its own span — accepting it would splice the replacement
            # over the WRONG characters.
            rejected += 1
            continue
        if proposed == original:
            rejected += 1
            continue

        confidence = item.get("confidence")
        confidence = float(confidence) if isinstance(confidence, (int, float)) else 0.0
        proposals.append(
            {
                # Stable across activity retries — a re-run must not resurrect a proposal the
                # clinician already rejected under a fresh id.
                "proposalId": _stable_id(
                    node_id, str(start), str(end), original, proposed, category
                ),
                "start": start,
                "end": end,
                "original": original,
                "proposed": proposed,
                "category": category,
                "confidence": max(0.0, min(1.0, confidence)),
                "rationale": _optional_str(item.get("rationale")) or "no rationale given",
                # Provenance for BOTH halves of how this proposal was produced.
                "detectedBy": "nlp.ner",
                "proposedBy": f"{provider}:{model}",
                # The clinician is the one who accepts. Nothing here advances this.
                "status": "PROPOSED",
            }
        )
    return proposals, rejected
