"""Guardrail's peer-service client to `apps/text`.

Guardrail owns POLICY and delegates INFERENCE. This client is the whole of the
LLM half of that split: it posts one judgement to `text`'s isolated judge lane
(`POST /api/v1/generate/internal/judge`) and hands the raw output back to the
caller, which interprets it into a verdict.

What deliberately does NOT live here:

* **No engine.** No base_url per vendor, no `api_key`, no model default. The
  provider/model pair is resolved from `AiRoutingPolicy` (tenant row first,
  SYSTEM as the platform fallback) and passed in; the tenant's own credential
  arrives as an opaque `provider_overrides` blob that this client forwards
  VERBATIM and never decrypts, stores or logs.
* **No fail-open.** A judgement the lane never rendered raises
  :class:`~guardrail.core.errors.GuardrailUndeterminedError`, which the medical
  routes map to 503. `apps/text` gates every `/generate` on that verdict, so a
  permissive default here ships an unmoderated clinical prompt — the exact
  inversion the fail-closed sweep removed from the in-process engines.

Retry budget lives on THIS side by contract: the judge route runs zero retries
so a public generation never waits behind a compounding backoff.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, cast

from hope_obs import outbound_context_headers

from guardrail.core.breaker import BreakerOpenError, CircuitBreaker
from guardrail.core.config import JudgePolicy
from guardrail.core.errors import (
    REASON_ENGINE_ERROR,
    REASON_INVALID_RESPONSE,
    REASON_TIMEOUT,
    REASON_UNSUPPORTED,
    GuardrailUndeterminedError,
)
from guardrail.core.logging import get_logger
from guardrail.core.metrics import (
    observe_peer_latency,
    record_guardrail_call,
    record_medical_judge_call,
    track_model_inference,
)
from guardrail.providers.stats import GuardrailCallStats, normalize_stop_reason

logger = get_logger(__name__)

JUDGE_PATH = "/api/v1/generate/internal/judge"

#: The verdict shape `_parse_verdict` reads back, pinned on the wire as a JSON
#: schema rather than requested in prose.
#:
#: This is a WIRE CONTRACT, not configuration: it is the exact set of keys this
#: module then parses, so it moves only when `_parse_verdict` moves. It is sent
#: as `response_format.type = "json_schema"` because that is the only structured
#: form BOTH hops accept — `apps/text` validates the literal
#: (`models/requests.ResponseFormat`, which has no `json_object` member) and LM
#: Studio, the engine behind the default judge model, refuses the OpenAI
#: `json_object` wire form that `text` maps its own `"json"` literal onto
#: (`providers/openai_compat._apply_response_format`; the same engine behaviour
#: is recorded in `apps/harness/eval/README.md`).
#:
#: `title` is load-bearing: `text` names the schema from it.
JUDGE_VERDICT_SCHEMA: dict[str, Any] = {
    "title": "guardrail_medical_context_verdict",
    "type": "object",
    "properties": {
        "is_medical": {"type": "boolean"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "context_type": {"type": "string"},
        "reasoning": {"type": "string"},
    },
    # Every key `_parse_verdict` reads is required: an optional field lets the
    # engine emit a shape the parser can only call undetermined, which fails the
    # safety gate closed for a reason that is not a safety reason.
    "required": ["is_medical", "confidence", "context_type", "reasoning"],
    "additionalProperties": False,
}

# There is deliberately NO criteria constant here and NO keyword taxonomy.
#
# The criteria text DECIDES a clinical verdict, so it is configuration with a
# declared fail-CLOSED posture (`core/policy.py`, key `medicalValidationCriteria`,
# stored on the registry row's `_metadata.policy` and resolved through the same
# two-tier `request tenant → SYSTEM` cascade as the model selection). A judge with
# no criteria is not a lenient judge — it is no judge at all, so absence raises.
#
# The 40-term `_MEDICAL_KEYWORDS` fallback that used to live here is gone with it
# It scored the RAW MODEL OUTPUT, so a caller who could steer the
# judge into emitting prose containing two clinical words earned `is_medical: true`
# without any model having judged the input — a hardcoded taxonomy and a prompt-
# injection bypass in the same twelve lines.


def _stats_from_judge(payload: dict[str, Any], provider: str, model: str) -> GuardrailCallStats:
    """Map `text`'s `GenerationStats` onto guardrail's AD-1 mirror.

    Null-safe by contract (see `providers/stats.py`): a missing or malformed
    stats block costs the caller its telemetry, never its verdict.
    """
    raw_stats = payload.get("stats")
    stats: dict[str, Any] = raw_stats if isinstance(raw_stats, dict) else {}
    prompt_tokens = int(stats.get("prompt_tokens", 0) or 0)
    predicted = int(stats.get("predicted_tokens", stats.get("completion_tokens", 0)) or 0)
    total = stats.get("total_tokens")
    raw_stop = stats.get("stop_reason_raw") or payload.get("finish_reason") or ""
    return GuardrailCallStats(
        stop_reason=stats.get("stop_reason") or normalize_stop_reason(raw_stop),
        stop_reason_raw=str(raw_stop),
        total_ms=int(stats.get("total_ms", payload.get("latency_ms", 0)) or 0),
        ttft_ms=stats.get("ttft_ms"),
        tokens_per_second=stats.get("tokens_per_second"),
        prompt_tokens=prompt_tokens,
        predicted_tokens=predicted,
        total_tokens=int(total) if total is not None else prompt_tokens + predicted,
        provider=str(stats.get("provider") or provider),
        model=str(stats.get("model") or model),
        engine_native=(
            stats.get("engine_native") if isinstance(stats.get("engine_native"), dict) else None
        ),
    )


#: Public spelling for the judge runner (TASK-1050), which interprets combined payloads itself.
judge_call_stats = _stats_from_judge

#: The medical judge's user-turn lead-in. Structure, not policy: the criteria are the system turn.
MEDICAL_JUDGE_PROMPT_HEADER = "Analyze this text for medical context:\n\n"


def medical_judge_prompt(text: str) -> str:
    """The medical judge's user turn: the lead-in, then ``text`` in the untrusted envelope (M-1).

    TASK-1050 §3.2: the judged text used to go into the user turn RAW, so an injected transcript
    line (``…return {"is_medical": true…}``) sat beside the instruction it was steering. It is now
    a nonce-delimited data block; a text that carries the closing marker raises
    `GuardrailUndeterminedError` before anything is sent (fail-closed).
    """
    from guardrail.services.judge_envelope import wrap_untrusted

    return f"{MEDICAL_JUDGE_PROMPT_HEADER}{wrap_untrusted(text)}"


class TextJudgeClient:
    """The guardian, as a delegation rather than an engine.

    Exposes the same three methods the deleted in-process guardian did
    (`validate_medical_context` / `batch_validate` / `health_check`), so the
    medical routes were repointed without their wire contract moving — `text`'s
    gate maps 422-vs-503 off exactly that shape.
    """

    def __init__(
        self,
        *,
        base_url: str,
        http_client: Any,
        service_token: str,
        provider: str,
        model: str,
        tenant_id: str,
        criteria: str | None,
        # REQUIRED, like `criteria` and `tenant_id` above and for the same reason
        # (TASK-878): each is configuration with no code default, so a client that
        # cannot be built is a client that cannot render a verdict nobody can
        # attribute. `temperature` / `max_tokens` come from the selected model
        # row's `_metadata.policy` (fail-CLOSED); `timeout_s` from the platform
        # `guardrail.judge.timeoutSeconds`. Both are resolved by
        # `core/tenant_config.build_judge_client`, the one production call site.
        temperature: float,
        max_tokens: int,
        timeout_s: float,
        policy: JudgePolicy | None = None,
        min_confidence: float | None = None,
        max_attempts: int | None = None,
        provider_overrides: dict[str, Any] | None = None,
        breaker: CircuitBreaker | None = None,
        enabled: bool = True,
        window_criteria: str | None = None,
        native_chat: bool = False,
    ) -> None:
        resolved_tenant = (tenant_id or "").strip()
        if not resolved_tenant:
            # Same rule as every other peer client in the monorepo: an absent
            # tenant is a CALLER defect, and a guardrail decision must be
            # attributable. Tenant-less internal work declares `tenantless:<reason>`.
            raise ValueError(
                "TextJudgeClient requires a tenant_id: the caller must forward "
                "X-Tenant-Id or declare 'tenantless:<reason>'."
            )
        resolved_criteria = (criteria or "").strip()
        # TASK-1050 W5: a `native_chat` client (a native-template guard such as Qwen3Guard) sends
        # the model's own template and NO criteria, so it is the one client built without them.
        # It can only call `judge_native_chat`; the criteria paths refuse it.
        self.native_chat = native_chat
        if not resolved_criteria and not native_chat:
            # Same construction-time invariant as the tenant: a client that cannot
            # be built is a client that cannot render an unattributable or
            # uncriteria'd verdict.
            raise ValueError(
                "TextJudgeClient requires `criteria`: the text that decides the "
                "verdict is configuration (policy key 'medicalValidationCriteria', "
                "failMode=closed) and has no code default."
            )
        self.criteria = resolved_criteria
        # The PER-WINDOW criterion (TASK-1047 OD-5, policy key
        # `medicalWindowScopeCriteria`). Optional at construction because only the
        # `regions` path reads it — and that path fails CLOSED when it is absent
        # (`judge_window_on_scope`), so a legacy caller is not 503'd by a key it
        # never uses.
        self.window_criteria = (window_criteria or "").strip() or None
        self.policy = policy or JudgePolicy()
        self.min_confidence = (
            self.policy.min_confidence if min_confidence is None else min_confidence
        )
        self.base_url = base_url.rstrip("/")
        self.http_client = http_client
        self._service_token = service_token
        self.provider = provider
        self.model = model
        self.tenant_id = resolved_tenant
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.timeout_s = timeout_s
        self.max_attempts = self.policy.max_attempts if max_attempts is None else max_attempts
        self.provider_overrides = provider_overrides
        self.breaker = breaker
        self.enabled = enabled

    # -- wire ---------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "X-Tenant-Id": self.tenant_id}
        if self._service_token:
            headers["X-Service-Token"] = self._service_token
        headers.update(outbound_context_headers())
        return headers

    async def judge_raw(
        self, *, prompt: str, system_prompt: str, schema: dict[str, Any]
    ) -> dict[str, Any]:
        """One judgement under a caller-owned verdict ``schema``; the raw lane payload back.

        The seam the TASK-1050 judge runner uses for a COMBINED call (one verdict per lane,
        `services/judge_protocols.py`). Same transport, retry budget, breaker and fail-closed raise
        as the medical judge; interpreting the payload is the caller's job.
        """
        return await self._judge(prompt, system_prompt, schema=schema)

    async def judge_native_chat(self, *, messages: list[dict[str, str]]) -> dict[str, Any]:
        """One native-template judgement (TASK-1050 W5): TEXT ``protocol: "native_chat"``.

        ``messages`` are the turns the model's own chat template is applied to — the user turn,
        plus the assistant turn for response moderation. No system prompt and no
        ``response_format`` are sent: the engine (LM Studio) applies the GGUF-embedded template.
        Same transport, retry budget, breaker and fail-closed raise as every other judgement;
        the raw completion comes back for the caller to parse.
        """
        if not self.native_chat:
            raise ValueError("judge_native_chat needs a client built with native_chat=True")
        body: dict[str, Any] = {
            "protocol": "native_chat",
            "messages": [{"role": m["role"], "content": m["content"]} for m in messages],
            "provider": self.provider,
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }
        if self.provider_overrides:
            body["provider_overrides"] = self.provider_overrides
        return await self._send(body)

    async def _judge(
        self,
        prompt: str,
        system_prompt: str,
        *,
        schema: dict[str, Any] = JUDGE_VERDICT_SCHEMA,
    ) -> dict[str, Any]:
        """One judgement, with a bounded retry budget. Raises when exhausted."""
        if self.native_chat:
            raise ValueError("a native_chat client has no criteria judgement")
        body: dict[str, Any] = {
            "prompt": prompt,
            "system_prompt": system_prompt,
            "provider": self.provider,
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            # `json_schema`, not `json_object`: see JUDGE_VERDICT_SCHEMA — the
            # literal `text` accepts AND the wire form the engine accepts are the
            # same shape only here.
            "response_format": {
                "type": "json_schema",
                "json_schema": schema,
                "strict": True,
            },
        }
        if self.provider_overrides:
            body["provider_overrides"] = self.provider_overrides
        return await self._send(body)

    async def _send(self, body: dict[str, Any]) -> dict[str, Any]:
        """POST one judge-lane body under the bounded retry budget; raise when exhausted."""

        async def _once() -> dict[str, Any]:
            started = time.monotonic()
            try:
                with track_model_inference(self.model):
                    response = await self.http_client.post(
                        f"{self.base_url}{JUDGE_PATH}",
                        json=body,
                        headers=self._headers(),
                        timeout=self.timeout_s,
                    )
                    response.raise_for_status()
                return cast(dict[str, Any], response.json())
            finally:
                observe_peer_latency("text", "judge", time.monotonic() - started)

        # One count per judgement REQUESTED of the lane (S6: judge calls must be
        # proportional to new text) — cached windows never get here.
        record_medical_judge_call()
        attempts = max(1, self.max_attempts)
        last_error = ""
        timed_out = False
        for attempt in range(attempts):
            try:
                if self.breaker is not None:
                    return await self.breaker.call(_once)
                return await _once()
            except BreakerOpenError as exc:
                # Known-down peer: shed rather than amplify. Still fail-CLOSED below.
                last_error = str(exc)
                break
            except Exception as exc:  # noqa: BLE001 — every failure is fail-CLOSED below
                last_error = str(exc)
                timed_out = "timeout" in type(exc).__name__.lower()
                if attempt + 1 >= attempts:
                    break
                await asyncio.sleep(self.policy.retry_backoff_s * (attempt + 1))

        # FAIL-CLOSED. No verdict was rendered, so there is none to report — and
        # "we could not check" is never "it is fine".
        logger.error(
            "guardrail.judge.undetermined",
            provider=self.provider,
            model=self.model,
            attempts=attempts,
            error=last_error,
        )
        raise GuardrailUndeterminedError(
            REASON_TIMEOUT if timed_out else REASON_ENGINE_ERROR,
            f"text judge lane rendered no verdict: {last_error}",
        )

    # -- policy -------------------------------------------------------------

    async def validate_medical_context(
        self, text: str, include_reasoning: bool = False
    ) -> dict[str, Any]:
        """Delegate the medical-context judgement and interpret the result."""
        if not self.enabled:
            # DECLARED bypass, not a fail-open: an operator turned the guardian
            # off. Every FAILURE path raises instead.
            return {
                "is_medical": True,
                "confidence": 1.0,
                "context_type": "unknown",
                "reasoning": "Guardian validation disabled",
            }

        payload = await self._judge(
            prompt=medical_judge_prompt(text[: self.policy.max_input_chars]),
            system_prompt=self.criteria,
        )
        return self._interpret(payload)

    async def judge_window_on_scope(self, window: str) -> dict[str, Any]:
        """Judge ONE window `on_scope` (TASK-1047 OD-5). `is_medical` carries the answer.

        The caller sizes the window to the judge lane's input cap, so nothing is cut
        here. Same fail-CLOSED interpretation as the whole-text judge — an
        unparseable or under-confident verdict raises — under the window criterion,
        which has no code default: absent, nothing can be judged.
        """
        if not self.enabled:
            return {
                "is_medical": True,
                "confidence": 1.0,
                "context_type": "unknown",
                "reasoning": "Guardian validation disabled",
            }
        if not self.window_criteria:
            raise GuardrailUndeterminedError(
                REASON_UNSUPPORTED,
                "policy key 'medicalWindowScopeCriteria' is unresolved (failMode=closed): "
                "the per-window judge criterion is configuration with no code default — "
                "seed it on the guardrail.validate AiModel row's `_metadata.policy`",
            )
        payload = await self._judge(
            prompt=medical_judge_prompt(window),
            system_prompt=self.window_criteria,
        )
        return self._interpret(payload)

    def _interpret(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Turn one judge-lane payload into a verdict; raise when none was rendered."""
        content = str(payload.get("content") or "").strip()
        result = self._parse_verdict(content)

        stats = _stats_from_judge(payload, self.provider, self.model)
        result["stats"] = stats.to_dict()
        # `text` DERIVED this (BYOK vs platform credential); forwarding it verbatim
        # is the only route guardrail's spend has to the billing plane, and
        # re-deriving it here is exactly how a call site starts mis-billing.
        usage_detail = payload.get("usage_detail")
        if isinstance(usage_detail, dict):
            result["usage_detail"] = usage_detail
        record_guardrail_call(
            provider=stats.provider,
            model=stats.model,
            status="success",
            prompt_tokens=stats.prompt_tokens,
            completion_tokens=stats.predicted_tokens,
        )

        if result["confidence"] < self.min_confidence:
            # ENFORCED, not merely logged. A verdict the model is not
            # confident in is a verdict that was not rendered: returning it as if it
            # had cleared the floor made the floor decorative.
            logger.warning(
                "guardrail.judge.low_confidence",
                confidence=result["confidence"],
                threshold=self.min_confidence,
            )
            raise GuardrailUndeterminedError(
                REASON_INVALID_RESPONSE,
                f"judge confidence {result['confidence']:.2f} is below the configured "
                f"floor {self.min_confidence:.2f}",
            )
        # `include_reasoning` is honoured by the ROUTE (it shapes the response
        # DTO); the verdict itself always carries the model's reasoning so the
        # low-confidence log above has something to say.
        return result

    def _parse_verdict(self, content: str) -> dict[str, Any]:
        """Interpret the judge's JSON. A response we cannot read is UNDETERMINED.

        There is no synthesised fallback: the alternative computes an answer from
        text the model produced, which is attacker-influenceable and reads on the
        wire exactly like a judged verdict.
        """
        try:
            parsed = json.loads(content)
            confidence = max(0.0, min(1.0, float(parsed.get("confidence", 0.0))))
            return {
                "is_medical": bool(parsed.get("is_medical", False)),
                "confidence": confidence,
                "context_type": parsed.get("context_type", "unknown"),
                "reasoning": parsed.get("reasoning", ""),
            }
        except (json.JSONDecodeError, KeyError, ValueError, TypeError) as exc:
            logger.warning("guardrail.judge.invalid_response", error=type(exc).__name__)
            raise GuardrailUndeterminedError(
                REASON_INVALID_RESPONSE,
                "the judge lane returned a response that is not a parseable verdict",
            ) from exc

    async def batch_validate(self, texts: list[str]) -> list[dict[str, Any]]:
        """Validate many texts; per-item failures come back as exceptions.

        The batch route marks the failed ELEMENT rather than voiding the resolved
        ones — a multiplex cannot collapse onto one status code.
        """
        results = await asyncio.gather(
            *(self.validate_medical_context(t) for t in texts), return_exceptions=True
        )
        return cast(list[dict[str, Any]], results)

    async def health_check(self) -> dict[str, Any]:
        """Report the delegation target's reachability (never raises)."""
        try:
            response = await self.http_client.get(
                f"{self.base_url}/api/v1/health",
                headers=self._headers(),
                timeout=10.0,
            )
            response.raise_for_status()
            return {
                "healthy": True,
                "guardian_enabled": self.enabled,
                "delegate": "text",
                "provider": self.provider,
                "model": self.model,
                "base_url": self.base_url,
            }
        except Exception as exc:  # noqa: BLE001 — health never raises
            return {
                "healthy": False,
                "guardian_enabled": self.enabled,
                "delegate": "text",
                "provider": self.provider,
                "model": self.model,
                "error": str(exc),
                "base_url": self.base_url,
            }
