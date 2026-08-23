"""Sensor thresholds — env-driven, local to the ``sensors`` package.

Kept separate from :mod:`harness.core.config` (the gate sensors own their own
``HARNESS_SENSOR_`` knobs). Every threshold is a fraction in ``[0, 1]``; the
defaults are clinically conservative — fabrication (entity-faithfulness) and
numeric/dose checks are **zero-tolerance** (1.0) because they are the
highest-harm errors.

These defaults were validated against a labeled fixture set rather than
loosening them: the FLAG-always behaviour was a *bug* (markdown notes failed the
schema gate; ``▁``/BIO NER artifacts and mic-check counting words drove
entity-faithfulness below 1.0), not a too-strict threshold. With the inputs
cleaned (schema_validity validates the actual contract; the entity-level sensors
consume merged, marker-free, noise-filtered entities), a faithful note legitimately
reaches 1.0, so the zero-tolerance fabrication/numeric-dose values stay unchanged
and the gate discriminates good vs bad. Making these admin-editable (effective values
resolve from the ``HarnessPolicy`` DB row) is a separate, coordinated change; changing
a default end-to-end is not a calibration edit here.
"""

from __future__ import annotations

from typing import Any

import structlog
from hope_env import hope_settings_sources
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = structlog.get_logger(__name__)


class SensorThresholds(BaseSettings):
    """``passed`` thresholds for the computational sensors."""

    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="HARNESS_SENSOR_")

    # Zero-tolerance: any note entity ungrounded in the transcript fails.
    entity_faithfulness_threshold: float = 1.0
    # >= 80% of transcript entities must be reflected in the note.
    coverage_threshold: float = 0.8
    # Every provenance claim must carry >= 1 evidence span.
    citation_presence_threshold: float = 1.0
    # Zero-tolerance: every numeric/dose value in the note must match the transcript.
    numeric_dose_threshold: float = 1.0
    # Inferential: >= 80% of provenance claims must be entailed by the
    # transcript/evidence per the LM Studio judge (lower than the zero-tolerance
    # checks — semantic entailment is graded, not exact-match).
    groundedness_threshold: float = 0.8
    # Inferential (institutional RAG): >= 80% of CITED claims must be
    # entailed by their cited knowledge chunk(s) per the same judge — a strict
    # citations check (regen-fixable; degrades to the "unverified" badge on outage).
    citation_verify_threshold: float = 0.8
    # Reference-free atomic-fact verifier: >= 80% of the note's atomic
    # claims must be entailed by the transcript per the DETERMINISTIC self-hosted NLI
    # (a second, model-cheap groundedness gate alongside the LLM-judge groundedness
    # sensor). Regen-fixable; a degraded backend degrades (never auto-PASS).
    atomic_fact_threshold: float = 0.8

    @field_validator(
        "entity_faithfulness_threshold",
        "coverage_threshold",
        "citation_presence_threshold",
        "numeric_dose_threshold",
        "groundedness_threshold",
        "citation_verify_threshold",
        "atomic_fact_threshold",
    )
    @classmethod
    def _unit_interval(cls, v: float) -> float:
        if not (0.0 <= v <= 1.0):
            raise ValueError("sensor thresholds must be within [0, 1]")
        return v


#: Threshold field -> the registry key that supplies its PLATFORM default.
#:
#: The key grammar is ``harness.sensor.<camelCaseField>``, and the mapping is DERIVED from
#: the model rather than hand-listed so a new threshold cannot be silently left behind —
#: ``test_task799_sensor_thresholds.py`` asserts the two sets are equal.
SENSOR_THRESHOLD_KEYS: dict[str, str] = {
    field: "harness.sensor."
    + "".join(part.capitalize() if i else part for i, part in enumerate(field.split("_")))
    for field in SensorThresholds.model_fields
}


def resolve_sensor_thresholds(snapshot: Any | None, base: SensorThresholds) -> SensorThresholds:
    """``base`` with each threshold the CONTROL PLANE resolved substituted in.

    This supplies the PLATFORM default only. The per-tenant lane is PUSH and already
    exists — ``HarnessPolicy`` resolves per tenant in ``apps/api`` and the workflow
    snapshots the result onto the activity input — so the precedence is **policy (tenant)
    then control plane (platform) then env bootstrap**, and a tenant with an opinion never
    reaches this function at all (owner decision D-1: cardinality decides the channel; one
    platform default per service is PULL, anything per-tenant is PUSH).

    Every rejection path keeps the bootstrap value:

    * no snapshot, or a snapshot from a FAILED pull (``ok=False``) — a degraded control
      plane must leave a clinical gate exactly where it was;
    * an absent key or a ``null`` value — "no opinion", never "the default";
    * a value outside the declared ``[0, 1]`` contract, or of the wrong type.

    That last case is REFUSED, not clamped. Clamping would invent a clinical gate nobody
    chose, and would hide the control-plane defect that produced it.

    Returns a COPY: a ``SensorThresholds`` instance is shared across a pass, and rewriting
    one in place would change a gate under a sensor that had already read it.
    """
    if snapshot is None or not getattr(snapshot, "ok", False):
        return base

    updates: dict[str, float] = {}
    for field, key in SENSOR_THRESHOLD_KEYS.items():
        value = snapshot.setting(key)
        # `bool` is an `int` subclass — exclude it, or `True` would become 1.0.
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if not (0.0 <= float(value) <= 1.0):
            logger.warning(
                "harness.sensor_thresholds.refused",
                key=key,
                reason="outside the declared [0, 1] contract",
            )
            continue
        updates[field] = float(value)

    return base.model_copy(update=updates) if updates else base
