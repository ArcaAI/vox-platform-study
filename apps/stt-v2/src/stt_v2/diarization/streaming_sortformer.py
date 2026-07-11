"""Self-hosted Streaming Sortformer diarizer — the live 2-speaker loop core
(TASK-475 · SOTA S1-DIAR · Theme B2).

Frame-level online speaker diarization for the clinician/patient case: NVIDIA
Streaming Sortformer (arXiv:2507.18446) emits per-frame speaker-activity
probabilities (T×S) at an ~80 ms cadence, which this module thresholds into
2-speaker turns for the live transcript. It is selected per-pipeline via
``DiarizationConfig.backend == "sortformer"`` while the existing
embedding-clustering path (and ``preseed_speaker`` naming, and the batch path)
stay put behind the same selector (see the TASK-474 §B2 Build Brief: replace the
core, augment for naming).

Fail posture (mirrors TASK-479's ``groundedness_nli.load_default_scorer``):

* backend un-staged / un-loadable  → diarizer degrades to "no labels" (applied=False)
* backend inference error          → degrades to "no labels" (applied=False)

Degrading to "no labels" — rather than crashing — keeps the ASR hot path alive
and reproduces today's default (diarization-off) behavior exactly. No path ever
fabricates a speaker turn the model did not actually emit.

MODEL REALITY (2026-07): the Streaming Sortformer ``.nemo`` weights (~471 MB,
``nvidia/diar_streaming_sortformer_4spk-v2``, cc-by-4.0) are NOT in the offline
HF cache (``HF_HOME`` holds only whisper + silero + pyannote-embedding), and the
model needs the NeMo/PyTorch GPU runtime (no working CPU/ONNX path). So
``load_default_backend`` raises ``SortformerModelUnavailableError`` until the
model is staged; once staged, implement the NeMo scorer inside that factory
against the ``SortformerBackend`` seam — the diarizer, thresholding, and tests do
NOT change. Track guardrail: self-hosted only — no cloud diarization vendor may
receive clinical audio.

PHI hygiene: this module NEVER logs audio samples or transcript text — it logs
frame/sample counts and reasons only.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Protocol

from stt_v2.core.logging import get_logger
from stt_v2.pipeline.dto import DiarizationConfig

logger = get_logger(__name__)

REASON_APPLIED = "applied"
REASON_MODEL_UNAVAILABLE = "sortformer_model_unavailable"
REASON_ERROR = "sortformer_inference_error"


class SortformerModelUnavailableError(RuntimeError):
    """The self-hosted Streaming Sortformer model cannot be loaded on this host."""


class SortformerBackend(Protocol):
    """Frame-level speaker-activity scorer contract.

    Implementations MUST be deterministic and self-hosted (no network egress of
    clinical audio — track guardrail). ``infer_activities`` returns a ``T×S``
    matrix of per-frame per-speaker activity probabilities in ``[0, 1]``, one row
    per model frame (~80 ms), one column per speaker.
    """

    def infer_activities(
        self, audio: Sequence[float], sample_rate: int
    ) -> Sequence[Sequence[float]]:
        """Return per-frame per-speaker activity probabilities for a mono chunk."""
        ...


@dataclass
class StreamingDiarizationResult:
    """One diarization pass over an audio chunk.

    ``activities`` is the raw ``T×S`` probability matrix; ``to_turns`` thresholds
    it into ``(start, end, speaker_label)`` turns. ``applied`` is False on every
    degrade path (model unavailable / inference error) so callers can tell a real
    "no speech" result from an honest "diarizer unavailable" one.
    """

    activities: list[list[float]] = field(default_factory=list)
    frame_shift_s: float = 0.08
    applied: bool = False
    reason: str = REASON_MODEL_UNAVAILABLE

    @property
    def num_speakers(self) -> int:
        return len(self.activities[0]) if self.activities else 0

    def to_turns(self, threshold: float) -> list[tuple[float, float, str]]:
        """Threshold frame probabilities into contiguous single-speaker turns.

        Each frame is attributed to its argmax speaker when that speaker's
        probability ``>= threshold``; otherwise the frame is silence (a gap).
        Consecutive same-speaker frames merge into one ``(start, end, "S<i>")``
        turn (timestamps in seconds). Pure and model-independent — the reusable
        half of the diarizer that survives once the NeMo model is staged.
        """
        turns: list[tuple[float, float, str]] = []
        current_speaker: int | None = None
        current_start = 0.0
        for index, frame in enumerate(self.activities):
            speaker = _dominant_speaker(frame, threshold)
            frame_start = round(index * self.frame_shift_s, 6)
            if speaker == current_speaker:
                continue
            if current_speaker is not None:
                turns.append((current_start, frame_start, f"S{current_speaker}"))
            current_speaker = speaker
            current_start = frame_start
        if current_speaker is not None:
            end = round(len(self.activities) * self.frame_shift_s, 6)
            turns.append((current_start, end, f"S{current_speaker}"))
        return turns


def _dominant_speaker(frame: Sequence[float], threshold: float) -> int | None:
    """Argmax speaker for a frame, or None (silence) if below ``threshold``."""
    if not frame:
        return None
    best_index = max(range(len(frame)), key=lambda i: frame[i])
    return best_index if frame[best_index] >= threshold else None


def load_default_backend(config: DiarizationConfig) -> SortformerBackend:
    """Production backend factory — requires the Streaming Sortformer model staged.

    The ``.nemo`` weights (``config.sortformer_model_id``) are NOT bundled with the
    service and are currently NOT staged in the offline HF cache, and the model
    needs the NeMo/PyTorch GPU runtime, so this factory raises
    ``SortformerModelUnavailableError`` and the diarizer degrades to "no labels".
    Once the model is staged, implement the NeMo streaming session here against the
    verified model-card I/O and plug it into the existing ``SortformerBackend`` seam
    — the diarizer, thresholding, and tests do not change. Track guardrail:
    self-hosted only — do NOT substitute a cloud diarization vendor.
    """
    raise SortformerModelUnavailableError(
        f"Streaming Sortformer model '{config.sortformer_model_id}' is not staged on "
        "this host (needs the ~471 MB .nemo weights + NeMo/PyTorch GPU runtime); "
        "diarization degrades to 'no labels'. See "
        "docs/implementation/TASK-475-Streaming-2Speaker-Diarization/README.md "
        "for the model-staging ask."
    )


class StreamingSortformerDiarizer:
    """Streaming 2-speaker diarizer wrapping a lazily-loaded Sortformer backend.

    The backend is injectable (``SortformerBackend``) so tests run hermetically
    with a tiny deterministic stub; production lazy-loads it via
    ``load_default_backend`` (which raises until the model is staged, degrading
    ``diarize`` to "no labels"). Never raises out of ``diarize``.
    """

    def __init__(
        self,
        config: DiarizationConfig,
        backend: SortformerBackend | None = None,
        backend_factory: Callable[[DiarizationConfig], SortformerBackend] | None = None,
    ) -> None:
        self._config = config
        self._backend = backend
        self._backend_factory = backend_factory or load_default_backend

    @property
    def model_id(self) -> str:
        return self._config.sortformer_model_id

    def reset(self) -> None:
        """Drop any lazily-loaded backend + streaming state (e.g. on session reset)."""
        self._backend = None

    def diarize(self, audio: Sequence[float], sample_rate: int) -> StreamingDiarizationResult:
        """Diarize a mono audio chunk. Never raises; degrades to "no labels"."""
        shift = self._config.sortformer_frame_shift_s
        backend = self._backend
        if backend is None:
            try:
                backend = self._backend_factory(self._config)
            except SortformerModelUnavailableError:
                # PHI-safe: sample COUNT only, never the samples themselves.
                logger.warning(
                    "stt_v2.diarization.sortformer.model_unavailable",
                    model_id=self._config.sortformer_model_id,
                    sample_count=len(audio),
                )
                return StreamingDiarizationResult(
                    activities=[],
                    frame_shift_s=shift,
                    applied=False,
                    reason=REASON_MODEL_UNAVAILABLE,
                )
            self._backend = backend

        try:
            raw = backend.infer_activities(audio, sample_rate)
            activities = [[float(prob) for prob in frame] for frame in raw]
        except Exception as exc:  # noqa: BLE001 — degrade, never crash the hot path
            logger.warning(
                "stt_v2.diarization.sortformer.inference_failed",
                model_id=self._config.sortformer_model_id,
                sample_count=len(audio),
                error=type(exc).__name__,
            )
            return StreamingDiarizationResult(
                activities=[], frame_shift_s=shift, applied=False, reason=REASON_ERROR
            )

        return StreamingDiarizationResult(
            activities=activities, frame_shift_s=shift, applied=True, reason=REASON_APPLIED
        )
