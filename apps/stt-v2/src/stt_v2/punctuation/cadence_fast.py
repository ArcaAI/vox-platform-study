"""Direct loader for ai4bharat/Cadence-Fast punctuation restoration.

The ``cadence-punctuation`` wrapper
package cannot load under the pinned transformers 5.x, so the ``cadence-fast``
model option loads the checkpoint directly via ``AutoModel`` with
spike-verified kwargs.

This module imports no ML dependencies at import time; transformers/torch are
only pulled in when :func:`load_model` actually runs.
"""

from __future__ import annotations

import threading
from typing import Any

import structlog

from stt_v2.core.config.settings import get_settings

logger = structlog.get_logger(__name__)

MODEL_NAME = "cadence-fast"
"""Config/registry option string selecting the direct loader.

Exact match only: the wrapper-based names ('Cadence', 'Cadence-Fast') keep
their legacy loader.
"""

MODEL_ID = "ai4bharat/Cadence-Fast"
REVISION = "8971c5011e4fba5dcfbcac52744587d7da605534"
"""Pinned revision — remote code + weights audited at this sha."""

_WARMUP_TEXT = "hello doctor how are you"
_NO_PUNCTUATION_LABEL = "O"


class CadenceFastModel:
    """Cadence-Fast behind the registry's ``punctuate()`` interface.

    The forward pass is serialized with a lock: the torch module is not
    assumed thread-safe, and a single F32 forward already saturates several
    CPU threads, so concurrent forwards would only contend with ASR decoding.
    """

    def __init__(self, tokenizer: Any, model: Any) -> None:
        self._tokenizer = tokenizer
        self._model = model
        self._id2label = {
            int(label_id): str(label)
            for label_id, label in model.config.id2label.items()
        }
        self._infer_lock = threading.Lock()

    def punctuate(self, texts: list[str], batch_size: int = 1) -> list[str]:
        """Punctuate texts serially (single-flight, wrapper-compatible signature)."""
        del batch_size  # interface parity with the wrapper; processed one by one
        with self._infer_lock:
            return [self._punctuate_one(text) for text in texts]

    def _punctuate_one(self, text: str) -> str:
        """Token-classification decode, mirroring the spike's verified pattern."""
        import torch

        inputs = self._tokenizer(
            text, return_tensors="pt", padding=True, truncation=True
        )
        with torch.inference_mode():
            logits = self._model(**inputs).logits
        pred_ids = torch.argmax(logits, dim=-1)[0].tolist()
        input_ids = inputs["input_ids"][0].tolist()
        attention_mask = inputs["attention_mask"][0].tolist()
        special_ids = set(self._tokenizer.all_special_ids)

        pieces: list[str] = []
        for token_id, attended, pred_id in zip(
            input_ids, attention_mask, pred_ids, strict=True
        ):
            if not attended or token_id in special_ids:
                continue
            pieces.append(self._tokenizer.convert_ids_to_tokens([token_id])[0])
            mark = self._id2label.get(int(pred_id), _NO_PUNCTUATION_LABEL)
            if mark != _NO_PUNCTUATION_LABEL:
                pieces.append(mark)
        return str(self._tokenizer.convert_tokens_to_string(pieces))


def load_model() -> CadenceFastModel:
    """Load Cadence-Fast directly via transformers (spike-verified recipe).

    Called by the punctuation service registry under its load lock, so the
    load itself is single-flight per process. Runs one warmup inference to
    absorb the ~1.6 s cold first forward before serving.
    """
    from transformers import AutoModel, AutoTokenizer

    cache_dir = get_settings().punctuation_model_cache_dir
    logger.info(
        "Loading Cadence-Fast punctuation model (direct transformers load)",
        model_id=MODEL_ID,
        revision=REVISION,
    )
    # trust_remote_code on the tokenizer avoids an interactive [y/N] prompt
    # (the repo declares a custom model_type); the resolved class is the
    # stock GemmaTokenizer.
    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        revision=REVISION,
        trust_remote_code=True,
        cache_dir=cache_dir,
    )
    # tie_word_embeddings=False is REQUIRED on transformers 5.x: the remote
    # code replaces lm_head with a Sequential classifier head, and the 5.x
    # tied-weights finalizer otherwise raises
    # "AttributeError: Sequential has no attribute 'weight'".
    model = AutoModel.from_pretrained(
        MODEL_ID,
        revision=REVISION,
        trust_remote_code=True,
        tie_word_embeddings=False,
        cache_dir=cache_dir,
    )
    model.eval()
    # transformers 5.x never calls the remote code's _update_causal_mask
    # override; this config flag restores the intended non-causal masking
    # (exact for inputs <= 512 tokens — every streaming final fits).
    model.config.use_bidirectional_attention = True

    wrapped = CadenceFastModel(tokenizer, model)
    wrapped.punctuate([_WARMUP_TEXT])
    logger.info(
        "Cadence-Fast punctuation model loaded and warmed up",
        model_id=MODEL_ID,
        revision=REVISION,
    )
    return wrapped
