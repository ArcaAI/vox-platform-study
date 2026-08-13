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

from hope_env import hope_settings_sources
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


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
