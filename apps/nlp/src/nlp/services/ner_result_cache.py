"""Tenant-keyed NER result cache for ``/classify/tokens`` (TASK-1049 F10).

The same text reaches NER again and again: a note is re-extracted per
regeneration, the whole transcript is re-extracted at note time, and the
windows of a GROWING transcript are planned from its start, so every window
but the tail is byte-identical to the one extracted on the previous pass. Each
repeat used to be a full GLiNER2 forward pass.

One entry is one pass — a single short text or one window of a long one —
keyed by::

    (tenant, model_name, model_path, sha256(request parameters), sha256(text))

* **The tenant is in the key** (rule 09 §Config caches): two tenants that send
  the same text never share an entry. A request with no ``X-Tenant-Id`` is
  never cached at all — an absent tenant cannot be attributed, so it cannot
  own an entry.
* **The weight identity and every other request field** (labels, threshold,
  aggregation strategy, clinical taxonomy, language) are in the key, because
  each one changes the answer.
* **The text is hashed**, never held in the key. The cached VALUE does hold
  PHI (entity surface forms) — it lives only in this process's memory, bounded
  by ``nlp.ner.resultCacheMaxEntries`` (least-recently-used out first) and
  ``nlp.ner.resultCacheTtlSeconds`` from the last write, the same exposure
  class as the model's own working memory.

Both bounds are read from :func:`nlp.core.bounds.get_bounds` on every call, so
a control-plane change applies at once; ``0`` for either disables the cache.
"""

from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict

from nlp.core.bounds import get_bounds
from nlp.schemas.classification import TokenClassificationRequest, TokenClassificationResponse

NerCacheKey = tuple[str, str, str, str, str]

#: Seam for tests; monotonic so a wall-clock step cannot resurrect an entry.
_clock = time.monotonic


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def ner_cache_key(tenant_id: str | None, request: TokenClassificationRequest) -> NerCacheKey | None:
    """The entry key for one pass, or ``None`` when the pass must not be cached."""
    tenant = (tenant_id or "").strip()
    if not tenant:
        return None
    params = request.model_dump(mode="json", exclude={"text", "model_name", "model_path"})
    return (
        tenant,
        request.model_name or "",
        request.model_path or "",
        _sha256(json.dumps(params, sort_keys=True, default=str)),
        _sha256(request.text),
    )


class NerResultCache:
    """Bounded LRU with a per-entry TTL. Event-loop confined: no lock needed."""

    def __init__(self) -> None:
        self._entries: OrderedDict[NerCacheKey, tuple[float, TokenClassificationResponse]] = (
            OrderedDict()
        )

    @staticmethod
    def _limits() -> tuple[int, int]:
        bounds = get_bounds()
        return bounds.ner_result_cache_ttl_seconds, bounds.ner_result_cache_max_entries

    def get(self, key: NerCacheKey | None) -> TokenClassificationResponse | None:
        """A copy of the cached answer, reported as costing no inference."""
        ttl, max_entries = self._limits()
        if key is None or ttl <= 0 or max_entries <= 0:
            return None
        held = self._entries.get(key)
        if held is None:
            return None
        expires_at, response = held
        if _clock() >= expires_at:
            del self._entries[key]
            return None
        self._entries.move_to_end(key)
        # A hit ran no forward pass, so it is not metered as one (TASK-959).
        return response.model_copy(deep=True, update={"inference_ms": 0})

    def put(self, key: NerCacheKey | None, response: TokenClassificationResponse) -> None:
        if key is None:
            return
        ttl, max_entries = self._limits()
        if ttl <= 0 or max_entries <= 0:
            # Disabled: release whatever an earlier configuration held.
            self._entries.clear()
            return
        self._entries[key] = (_clock() + ttl, response.model_copy(deep=True))
        self._entries.move_to_end(key)
        while len(self._entries) > max_entries:
            self._entries.popitem(last=False)

    def __len__(self) -> int:
        return len(self._entries)


_cache = NerResultCache()


def get_ner_result_cache() -> NerResultCache:
    return _cache


def reset_ner_result_cache() -> None:
    global _cache
    _cache = NerResultCache()
