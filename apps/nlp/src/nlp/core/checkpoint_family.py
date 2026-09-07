"""Which token-level RUNTIME a checkpoint needs, read from the checkpoint itself.

`apps/nlp` hosts two token-level runtimes and they are not interchangeable:

* the transformers ``AutoModelForTokenClassification`` pipeline — a CLOSED
  taxonomy, the checkpoint's own BIO label set, driven by
  :class:`~nlp.services.token_classifier.TransformerTokenClassifier`;
* the ``gliner2`` extractor moved here from `apps/guardrail` — an OPEN taxonomy,
  the labels arrive per request, driven by
  :class:`~nlp.services.gliner_token_classifier.Gliner2TokenClassifier`.

Both are TOKEN_CLASSIFICATION rows in the registry and both arrive on
``/classify/tokens`` with nothing but a ``model_name``/``model_path``, so
something has to tell them apart. That something is the CHECKPOINT's own
``config.json`` — never a slug, a vendor prefix or a hub id: model identity is
configuration (a tenant BYO row names whatever its admin configured), so a
literal here could not see the checkpoint it was meant to describe.
``tests/test_no_hardcoded_model_ids_task778.py`` enforces exactly that.

Fail posture: an unreadable or unrecognised config is NOT evidence of anything —
it reads as "not a GLiNER checkpoint" and the transformers path runs, failing
precisely as it does today. Absence never becomes a decision.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from nlp.core.logging import get_logger

logger = get_logger(__name__)

#: ``config.json#model_type`` values the ``gliner2`` runtime serves and
#: `transformers` does not host. These are ARCHITECTURE families declared by the
#: checkpoint, not model ids — GLiNER2 checkpoints declare ``extractor``.
GLINER_MODEL_TYPES = frozenset({"extractor", "gliner", "gliner2"})

#: Config keys only a GLiNER-family checkpoint carries (older GLiNER exports
#: declare no ``model_type`` at all).
GLINER_CONFIG_KEYS = ("gliner_config", "span_mode")

#: The file every HuggingFace-layout checkpoint carries its architecture in.
CONFIG_FILENAME = "config.json"


def read_checkpoint_config(source: str) -> dict[str, Any]:
    """The checkpoint's ``config.json`` as a dict, or ``{}`` when unreadable.

    ``source`` is whatever ``from_pretrained`` would be handed: a staged local
    directory or a hub id. A hub id is resolved through the SAME local cache the
    runtime would use, so this reads a file that is already on disk in every
    deployment that can actually serve the model.

    Blocking (filesystem, possibly a small cached download) — call it off the
    event loop.
    """
    reference = (source or "").strip()
    if not reference:
        return {}

    local = Path(reference) / CONFIG_FILENAME
    try:
        if local.is_file():
            return _as_config(json.loads(local.read_text(encoding="utf-8")))
    except (OSError, ValueError) as exc:
        logger.warning(f"nlp.checkpoint_family.local_config_unreadable source={reference} {exc}")
        return {}

    try:
        from huggingface_hub import hf_hub_download

        path = hf_hub_download(repo_id=reference, filename=CONFIG_FILENAME)
        return _as_config(json.loads(Path(path).read_text(encoding="utf-8")))
    except Exception as exc:  # noqa: BLE001 — every fault reads as "unknown family"
        logger.warning(f"nlp.checkpoint_family.config_unreadable source={reference} {exc}")
        return {}


def _as_config(parsed: Any) -> dict[str, Any]:
    return parsed if isinstance(parsed, dict) else {}


def is_gliner_checkpoint(config: Mapping[str, Any] | None) -> bool:
    """True when ``config`` describes a GLiNER-family checkpoint."""
    if not isinstance(config, Mapping):
        return False
    model_type = str(config.get("model_type") or "").strip().lower()
    if model_type in GLINER_MODEL_TYPES:
        return True
    return any(key in config for key in GLINER_CONFIG_KEYS)
