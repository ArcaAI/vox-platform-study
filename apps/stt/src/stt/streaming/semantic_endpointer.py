"""Self-hosted semantic end-of-utterance detector.

Content-driven end-of-turn detection that augments the fixed Silero-VAD silence
offset on the realtime hot path. Today the streaming preprocessor declares
end-of-turn with a fixed silence-frame timer (``silence_frames >=
_min_silence_frames``). This module lets that cut become SEMANTIC: consult the
running ASR hypothesis and, only when it carries a reliable completion signal AND
a minimum trailing silence has elapsed, signal an end-of-turn EARLIER than the
fixed timer (target 160–500 ms band) or capture a tail the timer would strand.

Two-layer detector:

* **Model-free heuristic core** (always available, deterministic, hermetic): the
  positive cut signal is TERMINAL PUNCTUATION on the running hypothesis (a
  completed sentence); a trailing-disfluency filler ("…uh") is a hard veto; tiny
  fragments and pre-floor silence defer to the fixed timer. Because ASR partials
  may be UNPUNCTUATED (the punctuation model runs finals-only on some pipelines),
  the heuristic simply produces low confidence there → no early cut → the fixed
  backstop governs. It never truncates.
* **Optional neural turn-detector seam** (``EndOfTurnModel``): a self-hosted
  turn/EOU model (e.g. a LiveKit-style turn detector or a Kyutai-style semantic
  VAD) that can raise confidence on UNPUNCTUATED complete text — the case the
  heuristic cannot cover. It is injectable for hermetic stub tests; production
  lazy-loads it via ``load_default_endpoint_model`` (which raises until the model
  is staged), so an un-staged model degrades to the heuristic.

Fail posture: model un-staged / un-loadable → heuristic-only; model inference
error → heuristic-only; ANY uncertainty (disabled, no hypothesis,
below the silence floor, low confidence, trailing filler) →
``should_endpoint=False``. ``decide()`` NEVER raises, so the preprocessor always
falls back to the EXISTING fixed silence-offset endpoint. No path ever cuts a
final the fixed timer would not eventually cut — it only cuts EARLIER, and only
when confident.

MODEL REALITY (2026-07): no dedicated turn/endpointing model is staged in the
offline HF cache (it holds only whisper + silero-vad + pyannote-wespeaker +
gliner-guard + an emotion classifier). So ``load_default_endpoint_model`` raises
``EndpointModelUnavailableError`` and the endpointer runs heuristic-only until a
model is staged. Track guardrail: self-hosted only — do NOT send clinical audio
or transcript to a cloud endpointing/VAD vendor.

PHI hygiene: this module NEVER logs hypothesis text — it logs reasons, word
counts, and silence durations only.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

import structlog

from stt.pipeline.dto import EndpointConfig

logger = structlog.get_logger(__name__)

# Decision reasons (surfaced for metrics/telemetry; never carry transcript text).
REASON_DISABLED = "disabled"
REASON_NO_HYPOTHESIS = "no_hypothesis"
REASON_TOO_SHORT = "too_short"
REASON_SILENCE_FLOOR = "below_silence_floor"
REASON_INCOMPLETE = "incomplete_trailing_filler"
REASON_LOW_CONFIDENCE = "low_confidence"
REASON_ENDPOINT = "endpoint"

# Sentence-terminal punctuation — Latin plus common CJK/Indic terminals so the
# heuristic is not silently English-only. This is the model-free POSITIVE signal.
_TERMINAL_PUNCTUATION = frozenset(".?!…。？！।")

# Disfluency fillers that never legitimately END a clinical utterance — a hard
# veto even if the token is (mis-)punctuated. Deliberately small and
# conservative: only unambiguous hesitation sounds, NOT content words.
_TRAILING_FILLERS = frozenset(
    {
        "uh",
        "uhh",
        "uhhh",
        "um",
        "umm",
        "ummm",
        "er",
        "err",
        "ah",
        "ahh",
        "eh",
        "hmm",
        "hmmm",
        "mm",
        "mmm",
        "mhm",
        "mmhm",
        "huh",
    }
)

# Confidence assigned to a punctuation-terminated hypothesis by the heuristic.
_HEURISTIC_COMPLETE_CONFIDENCE = 0.95


class EndpointModelUnavailableError(RuntimeError):
    """The optional self-hosted turn/EOU model cannot be loaded on this host."""


class EndOfTurnModel(Protocol):
    """Self-hosted end-of-turn scorer contract (the neural-model seam).

    Implementations MUST be deterministic and self-hosted (no network egress of
    clinical transcript — track guardrail). ``predict_eot`` returns the model's
    probability in ``[0, 1]`` that ``hypothesis`` is a completed turn.
    """

    def predict_eot(self, hypothesis: str) -> float:
        """Return P(end-of-turn) in ``[0, 1]`` for the running hypothesis."""
        ...


@dataclass
class EndpointDecision:
    """One end-of-turn decision.

    ``should_endpoint`` is True ONLY on a confident, complete turn; every degrade
    path returns False so the preprocessor keeps the fixed silence backstop.
    ``reason`` is a stable, PHI-free tag for telemetry.
    """

    should_endpoint: bool
    confidence: float
    reason: str


def load_default_endpoint_model(config: EndpointConfig) -> EndOfTurnModel:
    """Production model factory — requires a self-hosted turn/EOU model staged.

    No dedicated endpointing model is bundled with the service or currently
    staged in the offline HF cache, so this factory raises
    ``EndpointModelUnavailableError`` and the endpointer runs heuristic-only.
    Once a model is staged, implement the self-hosted scorer here against the
    ``EndOfTurnModel`` seam (return P(end-of-turn) for the hypothesis) — the
    endpointer, its gating, and the tests do NOT change. Track guardrail:
    self-hosted only — do NOT substitute a cloud endpointing/VAD vendor.
    """
    raise EndpointModelUnavailableError(
        f"Semantic-endpoint model '{config.model_id}' is not staged on this host; "
        "the endpointer degrades to the model-free heuristic. See "
        " for the "
        "model-staging ask."
    )


class SemanticEndpointer:
    """Per-session semantic end-of-utterance detector.

    Stateful: ``observe_hypothesis`` records the latest running ASR hypothesis
    (fed from the partial-inference path, mirroring the LocalAgreement-2 commit
    policy); ``decide`` is consulted by the preprocessor at the silence→final
    cut. The optional neural model is injectable (``model`` for hermetic stub
    tests) or lazily loaded via ``model_factory`` (default
    ``load_default_endpoint_model``, which raises until a model is staged →
    heuristic-only). ``decide`` never raises.
    """

    def __init__(
        self,
        config: EndpointConfig,
        model: EndOfTurnModel | None = None,
        model_factory: Callable[[EndpointConfig], EndOfTurnModel] | None = None,
    ) -> None:
        self._config = config
        self._model = model
        self._model_factory = model_factory or load_default_endpoint_model
        # Set once a load attempt has run, so an un-staged model is not retried
        # on every frame (the factory raise is logged once per session).
        self._model_load_attempted = model is not None
        self._hypothesis: str = ""

    @property
    def enabled(self) -> bool:
        return bool(self._config.enabled)

    @property
    def config(self) -> EndpointConfig:
        """The configuration this endpointer applies.

        TASK-985 (M-13): the preprocessor reports the segmentation numbers it
        actually ran on (``StreamingPreprocessor.effective_segmentation``), and
        the endpoint floor is one of them. Reading ``_config`` through a private
        attribute from another module is how that report would rot.
        """
        return self._config

    def observe_hypothesis(self, text: str) -> None:
        """Record the latest running hypothesis (called on each partial)."""
        self._hypothesis = text or ""

    def reset(self) -> None:
        """Clear the observed hypothesis at an utterance boundary."""
        self._hypothesis = ""

    def decide(self, *, trailing_silence_ms: float, min_silence_ms: float) -> EndpointDecision:
        """Decide whether to cut a final now — conservative; never raises.

        Returns ``should_endpoint=True`` only for a confident, complete turn once
        the trailing-silence floor is met. Every other path returns False so the
        caller falls through to the fixed ``min_silence_ms`` backstop.

        TASK-985 (D2-N7): ``min_silence_ms`` used to be ACCEPTED and never read
        — the caller computed the fixed backstop and passed it to no effect, so
        a session could not configure a semantic floor at all. It is now the
        clamp its own documentation describes (``min_endpoint_silence_ms`` is
        "kept below the fixed backstop so a cut is 'earlier'"): the effective
        floor is the LOWER of the two, which is a no-op whenever the configured
        floor is already below the backstop (200 vs 350 on the served pipeline)
        and stops a mis-set floor above it from making the semantic path
        unreachable rather than merely early.
        """
        if not self._config.enabled:
            return EndpointDecision(False, 0.0, REASON_DISABLED)

        hypothesis = self._hypothesis.strip()
        if not hypothesis:
            return EndpointDecision(False, 0.0, REASON_NO_HYPOTHESIS)

        if len(hypothesis.split()) < self._config.min_words:
            return EndpointDecision(False, 0.0, REASON_TOO_SHORT)

        # Do not cut on the instant the last word lands — require a minimum
        # trailing silence (the target-min EOU latency floor).
        silence_floor_ms = min(float(self._config.min_endpoint_silence_ms), float(min_silence_ms))
        if trailing_silence_ms < silence_floor_ms:
            return EndpointDecision(False, 0.0, REASON_SILENCE_FLOOR)

        # Hard safety veto: a trailing disfluency is never a turn boundary, even
        # if a stray punctuation or a confident model would otherwise pass it.
        if self._ends_with_filler(hypothesis):
            return EndpointDecision(False, 0.0, REASON_INCOMPLETE)

        confidence = self._confidence(hypothesis)
        if confidence >= self._config.confidence_threshold:
            return EndpointDecision(True, confidence, REASON_ENDPOINT)
        return EndpointDecision(False, confidence, REASON_LOW_CONFIDENCE)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _confidence(self, hypothesis: str) -> float:
        """Blend the heuristic completion signal with the optional model."""
        heuristic = _HEURISTIC_COMPLETE_CONFIDENCE if _looks_complete(hypothesis) else 0.0

        model = self._resolve_model()
        if model is None:
            return heuristic

        try:
            model_conf = float(model.predict_eot(hypothesis))
        except Exception as exc:  # noqa: BLE001 — degrade to heuristic, never crash
            logger.warning(
                "stt.streaming.endpointer.model_inference_failed",
                model_id=self._config.model_id,
                error=type(exc).__name__,
            )
            return heuristic

        if model_conf != model_conf:  # NaN guard
            return heuristic
        # The model can only RAISE confidence (cover unpunctuated complete text);
        # the trailing-filler veto above already fired before we get here.
        return max(heuristic, min(1.0, max(0.0, model_conf)))

    def _resolve_model(self) -> EndOfTurnModel | None:
        """Return the model, lazily loading once; heuristic-only if unavailable."""
        if self._model is not None:
            return self._model
        if not self._config.model_id:
            return None
        if self._model_load_attempted:
            return None
        self._model_load_attempted = True
        try:
            self._model = self._model_factory(self._config)
        except EndpointModelUnavailableError:
            logger.warning(
                "stt.streaming.endpointer.model_unavailable",
                model_id=self._config.model_id,
            )
            return None
        except Exception as exc:  # noqa: BLE001 — any load failure degrades
            logger.warning(
                "stt.streaming.endpointer.model_load_failed",
                model_id=self._config.model_id,
                error=type(exc).__name__,
            )
            return None
        return self._model

    def _ends_with_filler(self, hypothesis: str) -> bool:
        return _last_token(hypothesis) in _TRAILING_FILLERS


def _looks_complete(hypothesis: str) -> bool:
    """True when the hypothesis ends in sentence-terminal punctuation."""
    stripped = hypothesis.rstrip()
    return bool(stripped) and stripped[-1] in _TERMINAL_PUNCTUATION


def _last_token(hypothesis: str) -> str:
    """Last whitespace-delimited token, stripped of surrounding punctuation."""
    tokens = hypothesis.split()
    if not tokens:
        return ""
    return tokens[-1].strip(".?!,…。？！।\"')(-").lower()
