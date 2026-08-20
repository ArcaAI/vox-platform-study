"""Retention propagation helpers for server-managed engines.

Text holds no model weights: LM Studio does. So "retention" here is a
per-request HINT forwarded to the engine, not an in-process cache. The product
clamp is imported from the shared contract so Text can never drift from the
services that do own a cache.

`DEFAULT_RETENTION_TTL_S` is a BOOTSTRAP FALLBACK only — the runtime value
arrives from the control plane via `GET /internal/effective-config?service=text`.
"""

from __future__ import annotations

from hope_runtime_models import clamp_cache_ttl_seconds

#: Program default. Deliberately 600 s, not LM Studio's own default
#: (60 min) — one admin-controlled number governs it.
DEFAULT_RETENTION_TTL_S = 600

__all__ = ["DEFAULT_RETENTION_TTL_S", "clamp_cache_ttl_seconds"]
