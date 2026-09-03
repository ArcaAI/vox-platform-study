"""Self-hosted Streaming Sortformer diarizer — the live 2-speaker loop core.

Frame-level online speaker diarization for the clinician/patient case: NVIDIA
Streaming Sortformer (arXiv:2507.18446) emits per-frame speaker-activity
probabilities (T×S) at an ~80 ms cadence, which this module thresholds into
2-speaker turns for the live transcript. It is selected per-pipeline via
``DiarizationConfig.backend == "sortformer"`` while the existing
embedding-clustering path (and ``preseed_speaker`` naming, and the batch path)
stay put behind the same selector (replace the core, augment for naming).

Fail posture (mirrors ``groundedness_nli.load_default_scorer``):

* backend un-staged / un-loadable  → diarizer degrades to "no labels" (applied=False)
* backend inference error          → degrades to "no labels" (applied=False)

Degrading to "no labels" — rather than crashing — keeps the ASR hot path alive
and reproduces today's default (diarization-off) behavior exactly. No path ever
fabricates a speaker turn the model did not actually emit.

MODEL REALITY (2026-07): the Streaming Sortformer ``.nemo`` weights
(``nvidia/diar_streaming_sortformer_4spk-v2.1``, NVIDIA Open Model License —
pinned per owner directive 2026-07-11) are NOT in the offline HF cache
(``HF_HOME`` holds only whisper + silero + pyannote-embedding), and the model
needs the NeMo/PyTorch GPU runtime (no working CPU/ONNX path). The NeMo loader is
IMPLEMENTED (``_restore_sortformer_model`` + ``NemoSortformerBackend``, written
against the verified ``SortformerEncLabelModel.diarize`` API — model card + NeMo
source), but is UNVALIDATED-pending-GPU: the un-runnable NeMo calls are fenced in
``# UNVALIDATED`` blocks and were NOT executed here (no GPU, ``.nemo`` un-staged).
Until the weights + runtime are staged, ``load_default_backend`` still raises
``SortformerModelUnavailableError`` (the lazy ``nemo`` import / restore fails) so
the diarizer degrades to "no labels" — the diarizer, thresholding, and tests do
NOT change. Track guardrail: self-hosted only — no cloud diarization vendor may
receive clinical audio.

PHI hygiene: this module NEVER logs audio samples or transcript text — it logs
frame/sample counts and reasons only.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from stt.core.logging import get_logger
from stt.pipeline.dto import DiarizationConfig

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


# Streaming preset (nvidia/diar_streaming_sortformer_4spk-v2.x model card, all in
# 80 ms frames). These are the checkpoint's PUBLISHED example values — the
# latency/accuracy trade-off is a GPU-validation tuning point, not
# fabricated here. See the model card "Streaming configuration" section.
_STREAMING_PRESET: dict[str, int] = {
    "chunk_len": 340,
    "chunk_right_context": 40,
    "fifo_len": 40,
    "spkcache_update_period": 300,
    "spkcache_len": 188,
}


def _activities_from_nemo_output(tensor_outputs: Any) -> list[list[float]]:
    """Convert a NeMo ``diarize(include_tensor_outputs=True)`` output → a plain ``T×S``
    list-of-lists of Python floats.

    ``SortformerEncLabelModel.diarize`` returns ``(segments, tensor_outputs)`` where
    ``tensor_outputs`` is a ``list`` of ``(T, S)`` speaker-activity tensors, one per
    audio input (verified against the NeMo source). For the single-buffer
    ``infer_activities`` call we take the first. Rows arrive as a torch tensor, so we
    coerce via ``.tolist()`` when present. Pure and model-independent — unit-tested
    with fakes, so the reusable adapter math needs neither NeMo nor a GPU.
    """
    if not tensor_outputs:
        return []
    matrix: Any = tensor_outputs[0]  # first (only) audio input in the batch
    to_list = getattr(matrix, "tolist", None)
    if callable(to_list):
        matrix = to_list()
    return [[float(prob) for prob in frame] for frame in matrix]


class NemoSortformerBackend:
    """``SortformerBackend`` over a loaded NeMo ``SortformerEncLabelModel``.

    Structurally satisfies the ``SortformerBackend`` protocol. The only
    model-dependent step — the ``diarize`` forward — is fenced in the ``# UNVALIDATED``
    block below; the ``T×S`` extraction is the pure ``_activities_from_nemo_output``
    helper. Any inference error propagates to ``StreamingSortformerDiarizer.diarize``,
    which degrades to "no labels" (the hot path never crashes). Self-hosted only: the
    model runs on-prem; no clinical-audio egress.
    """

    def __init__(self, model: Any, config: DiarizationConfig) -> None:
        self._model = model
        self._config = config

    def infer_activities(
        self, audio: Sequence[float], sample_rate: int
    ) -> Sequence[Sequence[float]]:
        """Run the Sortformer forward over one mono buffer → ``T×S`` activity probs."""
        import numpy as np  # lazy — keep the module import light + torch-free

        samples = np.asarray(audio, dtype=np.float32)
        # === UNVALIDATED — requires GPU + .nemo staging ======================
        # SortformerEncLabelModel.diarize over an in-memory mono buffer, returning the
        # raw per-frame speaker-activity probabilities (a list of (T, S) tensors, one
        # per input). Signature verified against the model card + NeMo source, but NOT
        # executed here (no NVIDIA GPU, .nemo un-staged). Any surprise is caught by the
        # caller's try/except and degraded to "no labels".
        _segments, tensor_outputs = self._model.diarize(
            audio=samples,
            batch_size=1,
            sample_rate=sample_rate,
            include_tensor_outputs=True,
            verbose=False,
        )
        # === end UNVALIDATED =================================================
        return _activities_from_nemo_output(tensor_outputs)


def _restore_sortformer_model(config: DiarizationConfig) -> Any:
    """Load the streaming Sortformer ``SortformerEncLabelModel`` (NeMo).

    Mirrors ``models/nemo_loader.py``: LAZY ``nemo`` import (so this module and the
    unit tests import with nemo absent), ``restore_from`` a locally-staged ``.nemo``
    else ``from_pretrained`` the pinned HF repo (``sortformer_revision`` when set),
    ``.eval()``, the streaming preset, device placement. Raises on ANY failure —
    ``load_default_backend`` wraps it so the diarizer degrades. Self-hosted only:
    stage the weights offline; the clinical loop never auto-downloads.
    """
    # === UNVALIDATED — requires GPU + .nemo staging ==========================
    from nemo.collections.asr.models import SortformerEncLabelModel

    from stt.core.platform import get_device_string

    device = get_device_string()
    model_id = config.sortformer_model_id

    if model_id.endswith(".nemo") and Path(model_id).exists():
        # A locally-staged checkpoint — this file IS the revision-pinned artifact.
        model = SortformerEncLabelModel.restore_from(
            restore_path=model_id, map_location=device, strict=False
        )
    else:
        # HF repo id, resolved from the offline HF cache (stage it first). Pin by
        # revision when the operator set one; tolerate a NeMo build whose
        # from_pretrained predates the revision kwarg.
        pretrained_kwargs: dict[str, Any] = {"model_name": model_id, "map_location": device}
        if config.sortformer_revision:
            pretrained_kwargs["revision"] = config.sortformer_revision
        try:
            model = SortformerEncLabelModel.from_pretrained(**pretrained_kwargs)
        except TypeError:
            pretrained_kwargs.pop("revision", None)
            model = SortformerEncLabelModel.from_pretrained(**pretrained_kwargs)

    model.eval()

    modules = getattr(model, "sortformer_modules", None)
    if modules is not None:
        for name, value in _STREAMING_PRESET.items():
            setattr(modules, name, value)
        check = getattr(modules, "_check_streaming_parameters", None)
        if callable(check):
            check()

    return model
    # === end UNVALIDATED ====================================================


def load_default_backend(config: DiarizationConfig) -> SortformerBackend:
    """Production backend factory — loads the self-hosted Streaming Sortformer.

    Delegates the un-runnable NeMo restore to ``_restore_sortformer_model`` and wraps
    ANY failure (nemo absent, ``.nemo`` un-staged, load / streaming-config error) into
    ``SortformerModelUnavailableError`` so ``StreamingSortformerDiarizer.diarize``
    degrades to "no labels" — reproducing today's diarization-off behavior and never
    crashing the ASR hot path. On THIS host the NeMo/GPU runtime + weights are not
    staged, so the lazy import still fails and this still raises (see the unit tests).
    Track guardrail: self-hosted only — do NOT substitute a cloud diarization vendor.
    """
    try:
        model = _restore_sortformer_model(config)
    except Exception as exc:  # noqa: BLE001 — ANY load failure is fail-safe → degrade
        raise SortformerModelUnavailableError(
            f"Streaming Sortformer model '{config.sortformer_model_id}' could not be "
            f"loaded on this host ({type(exc).__name__}): it needs the ~471 MB .nemo "
            "weights staged + the NeMo/PyTorch GPU runtime. Diarization degrades to "
            "'no labels'. See "
            " "
            "for the model-staging ask."
        ) from exc
    return NemoSortformerBackend(model, config)


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
                    "stt.diarization.sortformer.model_unavailable",
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
                "stt.diarization.sortformer.inference_failed",
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
