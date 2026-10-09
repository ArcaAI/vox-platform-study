"""Sequence-classification guard runtime behind ``/guard/classify`` (TASK-1049 R2).

The second runtime on the guardrail classify plane, beside
:mod:`nlp.services.gliner2_guard`. It drives a transformers
``*ForSequenceClassification`` checkpoint with ONE softmax head — the Prompt
Guard 2 class that TASK-1049 R1 selects for ``jailbreak_detection``. The route
picks it when the resolved row's ``AiModel.libraryName`` is ``transformers``.

It knows no model id, no label, no benign label and no threshold. All of them
arrive per request from the caller's ``labelTaxonomy``:

* ``tasks[<name>].labels`` names the head's classes IN INDEX ORDER (logit ``i``
  is ``labels[i]``) and must have exactly as many entries as the head has
  logits — a checkpoint whose ``config.json`` declares no ``id2label`` (Prompt
  Guard 2 reports ``LABEL_0``/``LABEL_1``) is named by its taxonomy, not by us;
* ``tasks[<name>].benign_labels`` says which classes mean "clean";
* ``tasks[<name>].cls_threshold``, else the request ``threshold``, is the
  attack probability at which a non-benign class is reported.

The mechanics that silently break accuracy when missed (TASK-1049 §8.2, §9 R2):

* **Tokenizer.** The repo's own ``tokenizer.json`` through the ``tokenizers``
  library, NEVER ``AutoTokenizer``: transformers 5 rebuilds ``DebertaV2Tokenizer``
  and replaces Prompt Guard 2's anti-obfuscation normaliser, and a letter-spaced
  attack then scores 0.004 instead of 0.999.
* **Segmentation.** A text is tokenised without special tokens, cut into content
  segments of at most ``SEGMENT_MAX_TOKENS`` (special tokens included) with
  ``SEGMENT_OVERLAP_TOKENS`` of overlap, and each segment is wrapped in the
  tokenizer's own special-token template. The text is as malicious as its WORST
  segment, and that segment's distribution is the one reported.
* **Batching.** At most ``MAX_SEGMENTS_PER_PASS`` segments per forward pass.

Memory bounds: the route caps every text at ``nlp.inference.maxInputChars`` and
the micro-batcher caps a batch at ``nlp.inference.maxBatchChars`` before this
runs; here a pass is at most 8 x 512 tokens under ``torch.inference_mode`` (no
autograd state), which is the geometry TASK-1049 measured at +2.1 GB RSS for
Prompt Guard 2 86M (§8.6).

Fail posture — FAIL-CLOSED: an unusable task spec, a label/logit mismatch, a
missing ``tokenizer.json`` or an inference failure RAISES (the route answers
503). Nothing is ever reported benign by default.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from nlp.core.logging import get_logger

logger = get_logger(__name__)

#: ``AiModel.libraryName`` values `/guard/classify` serves.
GLINER2_LIBRARY = "gliner2"
SEQ_CLS_LIBRARY = "transformers"

#: Segment geometry and pass size required by TASK-1049 R2 for this checkpoint
#: class (the model card's 512-token context, the eval's 64-token overlap, and
#: the batch at which §8.3/§8.6 measured memory). A model whose own
#: ``max_position_embeddings`` is smaller lowers the segment to fit it.
SEGMENT_MAX_TOKENS = 512
SEGMENT_OVERLAP_TOKENS = 64
MAX_SEGMENTS_PER_PASS = 8

TOKENIZER_FILENAME = "tokenizer.json"

#: A text the template probe encodes to at least one content token.
_TEMPLATE_PROBE = "probe"


def _hf_hub_download(repo_id: str, filename: str) -> str:
    """Seam over the hub download, so tests never reach the network."""
    from huggingface_hub import hf_hub_download

    return str(hf_hub_download(repo_id=repo_id, filename=filename))


def resolve_tokenizer_file(weights_source: str) -> str:
    """The ``tokenizer.json`` shipped with these weights.

    A staged directory must contain it — a missing file RAISES rather than
    falling back to any other tokenizer, because a different tokenizer is a
    different (and, for Prompt Guard 2, measurably weaker) classifier. A hub
    reference fetches that one file through the hub cache the weights use.
    """
    local = Path(weights_source)
    if local.is_dir():
        candidate = local / TOKENIZER_FILENAME
        if not candidate.is_file():
            raise RuntimeError(
                f"staged weights at {weights_source!r} carry no {TOKENIZER_FILENAME}; "
                "a sequence-classification guard is only served with its own tokenizer."
            )
        return str(candidate)
    return _hf_hub_download(weights_source, TOKENIZER_FILENAME)


def token_segments(n_tokens: int, *, max_tokens: int, overlap: int) -> list[tuple[int, int]]:
    """``[start, end)`` content ranges covering all ``n_tokens``, each <= ``max_tokens``."""
    segments: list[tuple[int, int]] = []
    step = max_tokens - overlap
    start = 0
    while start < n_tokens:
        end = min(start + max_tokens, n_tokens)
        segments.append((start, end))
        if end == n_tokens:
            break
        start += step
    return segments


@dataclass(frozen=True)
class TokenCodec:
    """Content-token encoding plus the single-sequence special-token template."""

    encode: Callable[[str], list[int]]
    prefix: tuple[int, ...]
    suffix: tuple[int, ...]
    pad_id: int

    @property
    def n_special(self) -> int:
        return len(self.prefix) + len(self.suffix)

    def build(self, content: Sequence[int]) -> list[int]:
        return [*self.prefix, *content, *self.suffix]


def codec_from_tokenizer(tokenizer: Any, *, pad_id: int) -> TokenCodec:
    """Read the special-token template off a ``tokenizers.Tokenizer``'s post-processor.

    A segment is then wrapped exactly as the tokenizer would wrap a short prompt.
    """
    content = list(tokenizer.encode(_TEMPLATE_PROBE, add_special_tokens=False).ids)
    full = list(
        tokenizer.post_process(tokenizer.encode(_TEMPLATE_PROBE, add_special_tokens=False)).ids
    )
    if not content:
        raise RuntimeError("tokenizer template probe encoded to no tokens")
    for i in range(len(full) - len(content) + 1):
        if full[i : i + len(content)] == content:
            return TokenCodec(
                encode=lambda text: list(tokenizer.encode(text, add_special_tokens=False).ids),
                prefix=tuple(full[:i]),
                suffix=tuple(full[i + len(content) :]),
                pad_id=pad_id,
            )
    raise RuntimeError("tokenizer post-processor template does not contain the content tokens")


@dataclass(frozen=True)
class _HeadTask:
    """One validated task: the taxonomy's view of the single classification head."""

    name: str
    labels: tuple[str, ...]
    attack: tuple[int, ...]
    benign: tuple[int, ...]
    threshold: float


def _head_task(tasks: Mapping[str, Any], threshold: float, num_labels: int) -> _HeadTask:
    """Validate the caller's task schema against the head; raise on anything unusable."""
    if len(tasks) != 1:
        raise ValueError(
            f"a sequence-classification guard has one head and serves one task per request; "
            f"got {sorted(tasks)}"
        )
    ((name, spec),) = tasks.items()
    spec = dict(spec or {})
    labels = tuple(str(label) for label in spec.get("labels") or ())
    if len(labels) != num_labels:
        raise ValueError(
            f"task {name!r} declares {len(labels)} labels for a head with {num_labels} logits"
        )
    if spec.get("multi_label"):
        raise ValueError(f"task {name!r} is multi-label; this head is a single-label softmax")
    benign_names = {str(label).strip().lower() for label in spec.get("benign_labels") or ()}
    if not benign_names:
        raise ValueError(f"task {name!r} declares no benign_labels; the taxonomy owns them")
    benign = tuple(i for i, label in enumerate(labels) if label.lower() in benign_names)
    unknown = benign_names - {label.lower() for label in labels}
    if unknown:
        raise ValueError(f"task {name!r} benign_labels {sorted(unknown)} are not among its labels")
    attack = tuple(i for i in range(len(labels)) if i not in benign)
    if not attack:
        raise ValueError(f"task {name!r} declares every label benign; nothing can be flagged")
    cls_threshold = spec.get("cls_threshold")
    return _HeadTask(
        name=str(name),
        labels=labels,
        attack=attack,
        benign=benign,
        threshold=float(cls_threshold if cls_threshold is not None else threshold),
    )


def _decide(task: _HeadTask, segment_probs: Sequence[Sequence[float]]) -> dict[str, Any]:
    """The text's verdict: its worst segment, thresholded on the attack classes."""

    def attack_score(probs: Sequence[float]) -> float:
        return max(probs[i] for i in task.attack)

    worst = max(segment_probs, key=attack_score)
    if attack_score(worst) >= task.threshold:
        index = max(task.attack, key=lambda i: worst[i])
    else:
        index = max(task.benign, key=lambda i: worst[i])
    return {"label": task.labels[index], "confidence": float(worst[index])}


class SeqClsGuardService:
    """A loaded sequence classifier with the classify calls guardrail delegates.

    Construction is weightless; :meth:`load` is blocking and is driven through
    ``asyncio.to_thread`` by the model-cache factory.
    """

    def __init__(self, weights_source: str, model_id: str, device: str = "cpu") -> None:
        self.model_id = model_id
        self._weights_source = weights_source
        self._device = device
        self._tokenizer: Any = None
        self._model: Any = None
        self._codec: TokenCodec | None = None
        self._max_tokens = SEGMENT_MAX_TOKENS
        self._num_labels = 0

    @property
    def device(self) -> str:
        """The metering label (``cuda`` / ``mps`` / ``cpu``) — every response carries it."""
        from nlp.core.device import device_label

        return device_label(self._device)

    @property
    def placement(self) -> str:
        """The device id the weights were placed on (``cuda:1``) — TASK-1055."""
        return self._device

    def load(self) -> None:
        """Load the tokenizer from ``tokenizer.json`` and the head (blocking)."""
        import torch
        from tokenizers import Tokenizer  # type: ignore[import-untyped]
        from transformers import AutoModelForSequenceClassification

        from nlp.core.device import apply_device_placement

        logger.info(f"nlp.seq_cls_guard.loading model_id={self.model_id} device={self._device}")
        tokenizer = Tokenizer.from_file(resolve_tokenizer_file(self._weights_source))
        # Segmenting and padding are this runtime's job: a tokenizer that
        # truncated would silently drop the tail of a long window.
        tokenizer.no_padding()
        tokenizer.no_truncation()
        model = AutoModelForSequenceClassification.from_pretrained(
            self._weights_source, trust_remote_code=False, dtype=torch.float32
        )
        model.eval()
        apply_device_placement(model, self._device)

        config = model.config
        pad_id = getattr(config, "pad_token_id", None)
        if not isinstance(pad_id, int):
            raise RuntimeError(f"model {self.model_id!r} declares no integer pad_token_id")
        max_pos = getattr(config, "max_position_embeddings", None)
        if isinstance(max_pos, int) and max_pos > 0:
            self._max_tokens = min(SEGMENT_MAX_TOKENS, max_pos)
        codec = codec_from_tokenizer(tokenizer, pad_id=pad_id)
        if self._max_tokens - codec.n_special <= SEGMENT_OVERLAP_TOKENS:
            raise RuntimeError(
                f"model {self.model_id!r}: a {self._max_tokens}-token segment leaves no room "
                f"for a {SEGMENT_OVERLAP_TOKENS}-token overlap"
            )
        self._tokenizer = tokenizer
        self._model = model
        self._codec = codec
        self._num_labels = int(config.num_labels)
        logger.info(f"nlp.seq_cls_guard.ready model_id={self.model_id} device={self._device}")

    def torch_modules(self) -> list[Any]:
        """The torch modules this instance holds (residency sizing, TASK-1055)."""
        return [self._model] if self._model is not None else []

    def shutdown(self) -> None:
        """Drop the weights so eviction frees them."""
        self._model = None
        self._tokenizer = None
        self._codec = None

    # ── sync core (thread-pool bound) ───────────────────────────────────

    def _segments(self, text: str) -> list[list[int]]:
        codec = self._require_codec()
        ids = codec.encode(text)
        spans = token_segments(
            len(ids),
            max_tokens=self._max_tokens - codec.n_special,
            overlap=SEGMENT_OVERLAP_TOKENS,
        ) or [(0, 0)]
        return [codec.build(ids[start:end]) for start, end in spans]

    def _require_codec(self) -> TokenCodec:
        if self._codec is None or self._model is None:
            raise RuntimeError(f"sequence-classification guard {self.model_id!r} is not loaded")
        return self._codec

    def _forward(self, rows: list[list[int]]) -> list[list[float]]:
        import torch

        codec = self._require_codec()
        width = max(len(ids) for ids in rows)
        input_ids = torch.full((len(rows), width), codec.pad_id, dtype=torch.long)
        attention_mask = torch.zeros((len(rows), width), dtype=torch.long)
        for row, ids in enumerate(rows):
            input_ids[row, : len(ids)] = torch.tensor(ids, dtype=torch.long)
            attention_mask[row, : len(ids)] = 1
        with torch.inference_mode():
            logits = self._model(
                input_ids=input_ids.to(self._device),
                attention_mask=attention_mask.to(self._device),
            ).logits
        probs: list[list[float]] = torch.softmax(logits.float(), dim=-1).cpu().tolist()
        if any(len(row) != self._num_labels for row in probs):
            raise RuntimeError(f"model {self.model_id!r} returned a logit row of the wrong width")
        return probs

    def _sync_batch_classify(
        self, texts: list[str], tasks: Mapping[str, Any], threshold: float, batch_size: int
    ) -> list[dict[str, Any]]:
        task = _head_task(tasks, threshold, self._num_labels)
        plan: list[tuple[int, list[int]]] = []
        for index, text in enumerate(texts):
            plan.extend((index, ids) for ids in self._segments(text))

        per_text: list[list[list[float]]] = [[] for _ in texts]
        step = max(1, min(int(batch_size), MAX_SEGMENTS_PER_PASS))
        for offset in range(0, len(plan), step):
            chunk = plan[offset : offset + step]
            for (index, _ids), probs in zip(
                chunk, self._forward([ids for _, ids in chunk]), strict=True
            ):
                per_text[index].append(probs)
        return [{task.name: _decide(task, segments)} for segments in per_text]

    # ── async API (the same surface as Gliner2GuardService's classify) ───

    async def batch_classify_text(
        self,
        texts: list[str],
        tasks: Mapping[str, Any],
        threshold: float,
        batch_size: int = MAX_SEGMENTS_PER_PASS,
    ) -> list[dict[str, Any]]:
        """One verdict per text, ``{task: {"label", "confidence"}}`` — gliner2's shape."""
        if not texts:
            return []
        return await asyncio.to_thread(
            self._sync_batch_classify, texts, tasks, threshold, batch_size
        )

    async def classify_text(
        self, text: str, tasks: Mapping[str, Any], threshold: float
    ) -> dict[str, Any]:
        (verdict,) = await self.batch_classify_text([text], tasks, threshold)
        return verdict
