"""Peer client for `apps/nlp` — guardrail's classification/NER executor.

Phases 3 & 6. `apps/guardrail` used to host a GLiNER ONNX runtime and a
MiniCheck GGUF scorer. Both moved to `apps/nlp`, which already owns NER and
token/text classification (rule 06: "a service that needs NER / token- or
text-classification calls `apps/nlp`"). Guardrail keeps POLICY — which taxonomy,
which thresholds, the verdict shape, the fail posture — and calls this client.

Wire contract (per rule 06's peer-client shape):

* ``X-Service-Token`` — the shared internal credential;
* ``X-Tenant-Id`` — **MANDATORY**. This client REFUSES TO CONSTRUCT without one,
  so an unattributable safety decision cannot be made at all. A genuinely
  tenant-less caller declares ``tenantless:<reason>``;
* a DEADLINE owned HERE (guardrail decides how long a safety check may take), not
  by `apps/nlp` — TASK-1047 D7: `timeout_s` bounds the WHOLE call, every attempt
  included, and an attempt is retried ONLY when it provably never left (a
  connect-phase error). Once an attempt may still be running in the peer — a read
  timeout, the deadline, any answered status — a retry would only stack a second
  inference on the one still running (C6), so it is never made;
* a DECLARED fail posture — see below.

**Fail posture.** Every method RAISES :class:`GuardrailUndeterminedError` on an
exhausted budget. That is the correct posture for both of the shapes rule 06
distinguishes:

* a *moderation verdict* has a safe default, and guardrail's routes already turn
  this exception into 503 (single-item) or ``safe=false, issues=["undetermined"]``
  (batch) — fail-CLOSED, never ``safe: true``;
* a *generated label* — a PII span set, an entailment score — must never be
  FABRICATED. An empty span list would read as "no PII found" and a substituted
  score would read as "grounded"; both are silently wrong, so neither is ever
  synthesised here.

Guardrail forwards no vendor credential of its own: there is deliberately no
``api_key`` parameter (BYOK posture, Phase 5).
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import httpx
from hope_obs import outbound_context_headers

from guardrail.core.breaker import BreakerOpenError, CircuitBreaker
from guardrail.core.errors import REASON_ENGINE_ERROR, GuardrailUndeterminedError
from guardrail.core.logging import get_logger
from guardrail.core.metrics import observe_peer_latency

logger = get_logger(__name__)

PII_PATH = "/api/v1/guard/pii"
CLASSIFY_PATH = "/api/v1/guard/classify"
ENTAILMENT_PATH = "/api/v1/guard/entailment"
#: TASK-1050 §12 — a generative guard judge on its own chat template (`qwen3guard_native`).
JUDGE_PATH = "/api/v1/guard/judge"
#: The `AiModel.libraryName` apps/nlp serves with its sequence-classification runtime
#: (TASK-1049 R2, `nlp.services.seq_cls_guard.SEQ_CLS_LIBRARY`) — the only runtime sent `threshold`.
SEQ_CLS_LIBRARY = "transformers"


@dataclass(frozen=True)
class ClassifiedTasks:
    """One moderation call's answer: the labels, and the confidences behind them.

    `apps/nlp` used to answer `/guard/classify` with labels alone, which
    is why session aggregate could only ever be a flag RATE. The
    confidences now ride along in the SAME response, so a graded score costs no
    extra inference pass.

    `scores` maps task → {label: confidence} and covers only the labels present in
    `labels`. It is EMPTY when the peer reported none — never filled with zeros,
    which would read as "the model was certain of nothing".
    """

    labels: dict[str, Any]
    scores: dict[str, dict[str, float]]

    @property
    def is_scored(self) -> bool:
        """True when at least one label carries a confidence."""
        return bool(self.scores)


@dataclass(frozen=True)
class PiiSpan:
    """One PII span in DOCUMENT coordinates of the text that was submitted."""

    label: str
    start: int
    end: int
    score: float


def _parse_scores(blob: Any, labels: dict[str, Any]) -> dict[str, dict[str, float]]:
    """Read `scores` defensively: a number or nothing, never a coercion.

    An unparseable confidence is DROPPED, not defaulted. Both a fabricated 0.0
    (reads as "certainly clean") and a fabricated 1.0 (reads as "certainly
    harmful") are wrong claims about what the model said, and the graded/
    categorical flag downstream exists precisely so an absence can be declared
    rather than filled in.
    """
    if not isinstance(blob, dict):
        return {}
    parsed: dict[str, dict[str, float]] = {}
    for task, per_label in blob.items():
        if task not in labels or not isinstance(per_label, dict):
            continue
        confidences: dict[str, float] = {}
        for label, value in per_label.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            confidences[str(label)] = float(value)
        if confidences:
            parsed[str(task)] = confidences
    return parsed


#: The request never reached the peer, so nothing can still be running there —
#: the only failures it is safe to retry (TASK-1047 D7).
_NOT_SENT_ERRORS: tuple[type[BaseException], ...] = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.PoolTimeout,
)

#: An attempt that ran out of time — the local deadline (`asyncio.timeout`) or an httpx phase.
_TIMEOUT_ERRORS: tuple[type[BaseException], ...] = (TimeoutError, httpx.TimeoutException)

#: `apps/nlp` refuses a text longer than its window (TASK-1047 FC-8). Guardrail
#: windows every screen, so this is a contract breach between the two — logged,
#: never retried, and fail-CLOSED like any other undetermined screen.
_INPUT_EXCEEDS_WINDOW_STATUS = 413


class _PeerStatusError(RuntimeError):
    """A non-2xx from `apps/nlp`. Raised so the breaker counts it as a failure."""

    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        super().__init__(f"apps/nlp returned HTTP {status_code}")


class NlpPeerTransientError(GuardrailUndeterminedError):
    """The peer TIMED OUT or answered 5xx (TASK-1063 item 5a) — still undetermined, never a pass.

    The same reason and detail as its base, so every existing handler reads it unchanged. It is
    the one failure a CALLER may choose to retry once at its own level (the `pii_leak` span
    extraction does); this client still never retries it itself (D7 / C6).
    """


class NlpGuardClient:
    """One tenant's bound view of `apps/nlp`'s guard surface."""

    def __init__(
        self,
        *,
        base_url: str,
        service_token: str,
        http_client: httpx.AsyncClient,
        tenant_id: str,
        model_id: str = "",
        model_path: str | None = None,
        labels: list[str] | None = None,
        threshold: float = 0.5,
        calibration: dict[str, Any] | None = None,
        library_name: str | None = None,
        timeout_s: float = 60.0,
        max_attempts: int = 2,
        retry_backoff_s: float = 0.1,
        breaker: CircuitBreaker | None = None,
    ) -> None:
        # Attribution is a CONSTRUCTION-time invariant, not a per-call check:
        # there is no way to obtain this client and then make an unattributable
        # call with it.
        if not (tenant_id or "").strip():
            raise ValueError(
                "NlpGuardClient requires a tenant: guardrail decisions must be "
                "attributable (owner directive 2026-08-16). Declare "
                "'tenantless:<reason>' for genuinely tenant-less internal work."
            )

        self._base_url = base_url.rstrip("/")
        self._service_token = service_token
        self._http = http_client
        self._tenant_id = tenant_id
        self.model_id = model_id
        self.model_path = model_path
        self.labels = labels or []
        self.threshold = threshold
        # `AiModel._metadata.entailment` for the selected NLI build. `apps/nlp`
        # refuses to score without it (or when it names a different adapter),
        # so an unforwarded blob degrades the groundedness gate to `unverified`
        # rather than mis-scoring — safe, but silently non-functional. It rides
        # with the selection because the bounds are calibrated per BUILD, incl.
        # quantisation: Q6 tolerances are meaningless for a Q4 of the same model.
        self.calibration = calibration
        #: The selected row's `AiModel.libraryName` (TASK-1049 R2). It decides apps/nlp's
        #: `/guard/classify` RUNTIME: absent or `gliner2` ⇒ GLiNER2, `transformers` ⇒ the
        #: sequence-classification runtime, anything else ⇒ 503. Absent is sent as absent, so a
        #: caller that predates the field keeps exactly its old call.
        self.library_name = (library_name or "").strip() or None
        self._timeout_s = timeout_s
        self._max_attempts = max(1, max_attempts)
        self._retry_backoff_s = retry_backoff_s
        # Optional so unit tests and one-shot callers need not build one; when
        # present it sheds load for a peer that is already down instead of paying
        # `max_attempts × timeout` on every request.
        self._breaker = breaker
        #: The peer's OWN per-call usage from the most recent successful POST
        #: (TASK-878/G2), or `None` when it reported none. `apps/nlp` runs local
        #: weights and reports no usage today, so this is normally `None` — which
        #: is the honest answer, and the reason it is `None` rather than a zeroed
        #: block. Kept as the LAST value rather than a sum: the screen makes one
        #: classify and one PII call, and each client holds its own.
        self.last_usage_detail: dict[str, Any] | None = None

    # ── transport ────────────────────────────────────────────────────────

    def record_usage_detail(self, usage: Any) -> None:
        """Keep a peer-reported usage block, VERBATIM.

        Never re-derived: `text` derives the funding tier from the credential that
        served the call, and re-deriving it downstream is how a call site starts
        mis-billing (the rule `external_text_client.py` already states for the
        judge). Anything that is not a non-empty dict is not a usage block and is
        ignored — silence is the correct report for a call that metered nothing.
        """
        if isinstance(usage, dict) and usage:
            self.last_usage_detail = usage

    def _headers(self) -> dict[str, str]:
        headers = {"X-Tenant-Id": self._tenant_id}
        if self._service_token:
            headers["X-Service-Token"] = self._service_token
        headers.update(outbound_context_headers())
        return headers

    async def _post(self, path: str, payload: dict[str, Any], what: str) -> dict[str, Any]:
        """One bounded, retried POST. Raises rather than returning a fabricated result.

        Three exits, three different meanings: a peer that ANSWERED badly
        (retried within the budget, then `GuardrailUndeterminedError` — fail
        closed); a peer that is known-down (`BreakerOpenError`, shed without a
        retry); and a call the CALLER abandoned, which propagates untouched and
        is never counted against the peer.
        """
        body = {**payload, "tenant_id": self._tenant_id}
        if self.model_id:
            body["model_name"] = self.model_id
        if self.model_path:
            body["model_path"] = self.model_path
        if self.calibration:
            body["calibration"] = self.calibration

        deadline = time.monotonic() + self._timeout_s

        async def _once() -> dict[str, Any]:
            budget = max(0.001, deadline - time.monotonic())
            started = time.monotonic()
            try:
                # The deadline is ENFORCED here, not merely passed to httpx (whose
                # timeouts are per phase): an expiry cancels the request and closes
                # the connection, which is what lets the peer notice and drop it.
                async with asyncio.timeout(budget):
                    response = await self._http.post(
                        f"{self._base_url}{path}",
                        json=body,
                        headers=self._headers(),
                        timeout=budget,
                    )
            finally:
                observe_peer_latency("nlp", what, time.monotonic() - started)
            if response.status_code < 400:
                result = response.json()
                if not isinstance(result, dict):
                    return {}
                self.record_usage_detail(result.get("usage_detail"))
                return result
            if response.status_code == _INPUT_EXCEEDS_WINDOW_STATUS:
                max_chars = None
                try:
                    detail = response.json()
                    if isinstance(detail, dict):
                        max_chars = detail.get("maxChars")
                except Exception:  # noqa: BLE001 — the status alone is the signal
                    pass
                # PHI-safe: the LENGTH and the peer's bound, never the text.
                logger.error(
                    "guardrail.nlp_delegation.input_exceeds_window",
                    what=what,
                    input_chars=len(str(payload.get("text") or "")),
                    max_chars=max_chars,
                )
            raise _PeerStatusError(response.status_code)

        last_error = ""
        #: TASK-1063 item 5a: the budget ran out or the peer answered 5xx — a caller may retry.
        transient = False
        for attempt in range(self._max_attempts):
            if deadline - time.monotonic() <= 0:
                last_error = last_error or "deadline_exceeded"
                transient = True
                break
            try:
                if self._breaker is not None:
                    return await self._breaker.call(_once)
                return await _once()
            except BreakerOpenError as exc:
                # The peer is known-down. Retrying is load amplification, so stop
                # here — the posture is unchanged (this still raises below).
                last_error = str(exc)
                break
            except asyncio.CancelledError:
                # The upstream gave up (its own deadline, or a disconnect), so
                # nobody wants this answer any more: stop, rather than spending
                # the rest of the budget on it. It is NOT a peer failure — the
                # breaker declares that posture (`core/breaker.py`) and this
                # states the caller-side half of it, because `except Exception`
                # below does not catch a `BaseException` today and a future
                # widening must not silently start counting one.
                raise
            except _PeerStatusError as exc:
                # The peer ANSWERED. Not retried (D7): a 4xx will be refused
                # identically, and a 5xx / 429 means the peer is already struggling —
                # a retry is load amplification on exactly the wrong service.
                last_error = f"HTTP {exc.status_code}"
                transient = exc.status_code >= 500
                break
            except _NOT_SENT_ERRORS as exc:
                # The request never left, so nothing is running in the peer: the
                # one failure a retry cannot amplify.
                last_error = f"{type(exc).__name__}"
                transient = isinstance(exc, _TIMEOUT_ERRORS)
            except Exception as exc:  # noqa: BLE001 — every transport failure is fail-closed
                # A read timeout, the deadline, a reset mid-response: the inference
                # may STILL be running in the peer. Never retried (C6).
                last_error = f"{type(exc).__name__}"
                transient = isinstance(exc, _TIMEOUT_ERRORS)
                break

            remaining = deadline - time.monotonic()
            if attempt + 1 < self._max_attempts and self._retry_backoff_s > 0 and remaining > 0:
                await asyncio.sleep(min(remaining, self._retry_backoff_s * (attempt + 1)))

        # PHI-safe: the error string carries no request text.
        logger.error(f"guardrail.nlp_delegation.failed what={what} error={last_error}")
        raise (NlpPeerTransientError if transient else GuardrailUndeterminedError)(
            REASON_ENGINE_ERROR,
            f"apps/nlp {what} delegation failed ({last_error}) — refusing to fabricate a result",
        )

    # ── the three delegated capabilities ─────────────────────────────────

    async def extract_pii_entities(self, text: str) -> list[PiiSpan]:
        """PII spans in the coordinates of `text`. NEVER an empty list on error."""
        payload = await self._post(
            PII_PATH,
            {"text": text, "labels": self.labels, "threshold": self.threshold},
            "pii",
        )
        spans: list[PiiSpan] = []
        for entity in payload.get("entities") or []:
            try:
                spans.append(
                    PiiSpan(
                        label=str(entity["label"]),
                        start=int(entity["start"]),
                        end=int(entity["end"]),
                        score=float(entity.get("score", 0.0)),
                    )
                )
            except (KeyError, TypeError, ValueError) as exc:
                # A span we cannot trust the offsets of would corrupt the mask.
                raise GuardrailUndeterminedError(
                    REASON_ENGINE_ERROR,
                    "apps/nlp returned a PII span without usable offsets",
                ) from exc
        return spans

    async def classify(self, tasks: dict[str, Any], text: str) -> dict[str, Any]:
        """Run the caller's moderation task schema; return only what nlp answered.

        Labels only — the shape `analyze_content` and `services/screening.py`
        have always parsed. Callers that need the confidences use
        :meth:`classify_scored`.
        """
        return (await self.classify_scored(tasks, text)).labels

    async def classify_scored(self, tasks: dict[str, Any], text: str) -> ClassifiedTasks:
        """The same one call, with the per-label confidences kept.

        TASK-1049 Track R: the row's ``library_name`` (runtime choice) rides the call when the
        row has one. ``threshold`` is sent ONLY to the sequence-classification runtime
        (``transformers``), which requires it. A GLiNER2 call stays byte-identical to the
        pre-Track-R wire — no threshold, so apps/nlp keeps its own 0.5, the value every TASK-1049
        GLiGuard measurement assumed. Sending the policy's 0.4 there would silently move every
        production flag.
        """
        request: dict[str, Any] = {"text": text, "tasks": tasks}
        if self.library_name:
            request["library_name"] = self.library_name
            if self.library_name.lower() == SEQ_CLS_LIBRARY:
                request["threshold"] = self.threshold
        payload = await self._post(CLASSIFY_PATH, request, "classify")
        results = payload.get("results")
        labels = results if isinstance(results, dict) else {}
        return ClassifiedTasks(labels=labels, scores=_parse_scores(payload.get("scores"), labels))

    async def judge(
        self,
        *,
        protocol: str,
        mode: str,
        prompt: str,
        response: str | None = None,
        max_new_tokens: int,
        temperature: float,
    ) -> dict[str, Any]:
        """One generative-guard judgement (TASK-1050 §12, ``POST /api/v1/guard/judge``).

        Returns apps/nlp's NATIVE fields raw — ``{tier, categories[], refusal,
        undetermined_reason, latency_ms, …}``. Which lane a category feeds and what a tier means
        are the model row's ``_metadata.judge`` mapping, applied by the judge runner, never here.
        ``max_new_tokens`` / ``temperature`` are the row's ``judgeMaxTokens`` /
        ``judgeTemperature``. Same deadline, no-retry-once-sent and fail-closed raise as every
        other call on this client.
        """
        body: dict[str, Any] = {
            "protocol": protocol,
            "mode": mode,
            "prompt": prompt,
            "max_new_tokens": int(max_new_tokens),
            "temperature": float(temperature),
        }
        if response is not None:
            body["response"] = response
        return await self._post(JUDGE_PATH, body, "judge")

    async def score_pairs(self, pairs: Sequence[tuple[str, str]]) -> list[float]:
        """The `NliScorer` seam's spelling (`services/groundedness_nli.py`)."""
        return await self.score_entailment(list(pairs))

    async def score_entailment(self, pairs: list[tuple[str, str]]) -> list[float]:
        """`P(claim entailed by document)` per pair, in order."""
        if not pairs:
            return []
        payload = await self._post(
            ENTAILMENT_PATH,
            {"pairs": [{"document": doc, "claim": claim} for doc, claim in pairs]},
            "entailment",
        )
        scores = payload.get("scores")
        if not isinstance(scores, list) or len(scores) != len(pairs):
            raise GuardrailUndeterminedError(
                REASON_ENGINE_ERROR,
                "apps/nlp returned an entailment score count that does not match the request",
            )
        return [float(score) for score in scores]
