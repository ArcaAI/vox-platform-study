"""``PoolConfig`` — this process's entry of ``vllm.pools`` (C-4), in engine terms.

A leaf module ON PURPOSE: ``core/config.py`` needs it, and importing settings must never
drag in the pool (and with it the Prometheus registry) — ``scripts/python-env-surface.py``
imports every service's settings in ONE process, where two services registering the same
residency-contract series name would collide.
"""

from __future__ import annotations

from dataclasses import dataclass

#: `vllm.pools[*].inflightFactor` default (C-4).
DEFAULT_INFLIGHT_FACTOR = 2


@dataclass(frozen=True)
class PoolConfig:
    """This process's entry of ``vllm.pools``."""

    accepted_kinds: frozenset[str]
    pins: tuple[str, ...]
    vram_budget_gib: float
    max_resident: int
    #: A lease beyond ``max_num_seqs × inflight_factor`` on one engine is 429 (C-3).
    inflight_factor: int = DEFAULT_INFLIGHT_FACTOR
