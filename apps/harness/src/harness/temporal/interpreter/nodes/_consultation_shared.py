"""Shared helpers for the consultation-palette node activities.

Not itself an activity module. Every consultation node beyond N-1/N-5 wraps an activity that
already exists in ``harness.temporal.activities`` (the ones ``HarnessDocWorkflow`` has run in
production since long before this palette existed) — see
"Compile target" column. What every one of those wrappers needs, and what lives here, is the
same three-part mapping:

* **Identity** (`consultationId`, `externalPatientId`, `userId`, `jobId`) comes from
  ``payload.run_payload`` — the run's own opaque invocation payload — NEVER from
  ``payload.config``. A consultation id is a property of the RUN, not something a tenant
  authors on a node; ``interpreter_consultation_consent_gate`` already established that split
  (``nodes/consultation.py``) and every node here follows it.
* **Tenant** is ``payload.tenant_id``, which the interpreter's own input model makes required.
* **Data** flows in through ``payload.bound_inputs``, keyed by ``toPort`` — read generically
  (never off a fixed port name), the same rule ``nodes/text_generate.py`` and
  ``nodes/guardrail_check.py`` already apply, because port names are graph-author-chosen. Since
  each bound value is the SINGLE output key the producing socket declares, never
  the whole predecessor output dict; ``bound_value`` reads the top level first for that reason.

Failure posture, uniformly: a wrapped activity that raises DEGRADES the node with a named
``error_code`` — it never propagates. CR-14 (``contracts/node-types.md``) makes only
``consentGate`` and ``hitlGate`` ``critical``; every other consultation node must degrade
visibly rather than fail the run, and the interpreter's own workflow body is what promotes a
degraded CRITICAL node to a run-level failure (contracts/execution-semantics.md

Sandbox suppression is NOT re-implemented here: ``workflow.py:188`` already skips any
``external_write`` node when the run is sandboxed, before the activity is ever scheduled.
"""

from __future__ import annotations

from typing import Any

from harness.sensors.base import NEREntity

__all__ = [
    "RunIdentity",
    "bound_entities",
    "bound_text",
    "bound_value",
    "run_identity",
]


class RunIdentity:
    """The run-scoped identity every consultation activity needs, read once from
    ``run_payload``. A plain class rather than a pydantic model — it never crosses an activity
    boundary, so it needs no serialization contract."""

    __slots__ = ("consultation_id", "external_patient_id", "job_id", "session_id", "user_id")

    def __init__(self, run_payload: dict[str, Any]) -> None:
        self.consultation_id = _str_or_none(run_payload.get("consultationId"))
        self.external_patient_id = _str_or_none(run_payload.get("externalPatientId"))
        self.user_id = _str_or_none(run_payload.get("userId"))
        self.job_id = _str_or_none(run_payload.get("jobId"))
        self.session_id = _str_or_none(run_payload.get("sessionId"))


def _str_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def run_identity(run_payload: dict[str, Any]) -> RunIdentity:
    return RunIdentity(run_payload)


def bound_value(bound_inputs: dict[str, Any], key: str) -> Any:
    """``key`` as a TOP-LEVEL bound input, else the first occurrence of it inside a dict-valued
    one, else ``None``.

    ## Why both, and why the top level comes first

    This function used to search the nested level ONLY, and its own docstring said why: the
    interpreter threaded "either the single value named by the edge's ``fromPort`` or the WHOLE
    predecessor output dict", so a node could not assume which it had received. The whole-object
    fallback is gone — every socket now declares the key it carries — and under strict per-key
    binding the value a graph binds is frequently the datum ITSELF, not a dict to rummage through:
    ``persistDraft.contextItemId -> finalizeAssurance.contextItemId`` binds a bare id string,
    ``extractEntities.out -> …entities`` binds a bare list. A nested-only search returns ``None``
    for both.

    That ``None`` is the dangerous part. ``PersistDraftInput``/``FinalizeAssuranceInput`` read
    ``scores``, ``citationsMap``, ``guardrailDecisions``, ``ragTriadScore`` and
    ``reducedAssurance`` through here, and treat ``None`` as "no verifier ran" — so a lookup that
    silently stops finding its key does not raise, it persists a clinical draft with its assurance
    record missing and reports success. Checking the top level first is what keeps that from
    happening; the nested search is kept because an assurance record legitimately arrives as ONE
    object on a single ``verdict`` socket (``nodes/consultation_verify.py``), which is what stops
    a socket carrying one field and dropping the other four.

    A top-level ``None`` never shadows a real nested value — absent and "present but null" are the
    same "nothing was bound for this" here, exactly as before.
    """
    direct = bound_inputs.get(key)
    if direct is not None:
        return direct
    for value in bound_inputs.values():
        if isinstance(value, dict) and value.get(key) is not None:
            return value[key]
    return None


def bound_text(bound_inputs: dict[str, Any]) -> str | None:
    """The same extraction rule ``nodes/guardrail_check.py`` and ``nodes/deliver.py`` use —
    prefer a ``text`` key on a dict-shaped upstream output, else any bound bare string."""
    for value in bound_inputs.values():
        text = value.get("text") if isinstance(value, dict) else None
        if isinstance(text, str) and text:
            return text
    for value in bound_inputs.values():
        if isinstance(value, str) and value:
            return value
    return None


def bound_entities(bound_inputs: dict[str, Any]) -> list[NEREntity]:
    """Rehydrate ``NEREntity`` rows an upstream ``consultation.extractEntities`` published.

    The workflow threads node outputs as plain JSON dicts, so the models must be rebuilt here.
    A row that does not validate is DROPPED rather than raising: a malformed entity should cost
    that one entity, never the whole downstream node (CR-14's degrade-visibly posture).
    """
    raw = bound_value(bound_inputs, "entities")
    if not isinstance(raw, list):
        return []
    entities: list[NEREntity] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            entities.append(NEREntity.model_validate(item))
        except ValueError:
            continue
    return entities
