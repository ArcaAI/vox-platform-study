"""The ``compiledConfig`` contract, Python side (TASK-716 Task 7b).

``compiledConfig`` is what ``@arcaai/workflow-contract``'s TypeScript compiler
(``packages/workflow-contract/src/compiler.ts``) produces from a server-validated
``WorkflowGraph``, and what the Python interpreter (TASK-718) consumes. The single
normative machine artifact is
``packages/workflow-contract/schemas/compiled-config.schema.json``;
this module is a MIRROR of it, kept honest by ``tests/test_parity.py``.

**Consumer half only.** Python never authors or validates a workflow — there is no
compiler and no rule catalogue here, and there must not be one. The graph is
untrusted input; the compiled config is a server-produced artifact.

Normative rules, binding on every consumer in both languages
(``contracts/README.md`` §"Normative rules"):

1. **There is no node type that can write ``SIGNED``.** The format has no such
   field anywhere. Approval remains ``approveSummary``, outside the substrate
   entirely (TASK-716 §2.7).
2. **A gate's ``onTimeout`` may never be a value that means "approved"**
   (INV-001, INV-147, INV-181). ``CompiledGate`` rejects the literal ``APPROVED``;
   that is the same mechanical tripwire the schema encodes and is NOT a substitute
   for a human check that the gate-type enum grows no synonym (``AUTO_APPROVE``,
   ``GRANTED``, ...).
3. **An unknown ``formatVersion`` is REFUSED, never best-effort parsed.** Parsing
   raises :class:`UnsupportedFormatVersionError`. Precedent:
   ``UsageOutboxPayload.version``.
4. **``checksum`` MUST be verified before executing.** Call
   :func:`verify_checksum`. A mismatch means the stored document was tampered with
   or corrupted between compile and execution — it is not a warning to log and
   continue.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Mapping
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

#: This contract defines version 1 only. A future version is a NEW literal with its
#: own models, never a mutation of these.
COMPILED_CONFIG_FORMAT_VERSION: Literal[1] = 1

_UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
_NODE_ID_PATTERN = r"^[a-z0-9_]{2,48}$"

#: The schema says ``format: uuid``; a pattern enforces the same thing without
#: swapping the value for a ``uuid.UUID`` object, which would re-serialize (and so
#: potentially re-case) a field the checksum is computed over.
UuidStr = Annotated[str, Field(pattern=_UUID_PATTERN)]
NodeIdStr = Annotated[str, Field(pattern=_NODE_ID_PATTERN)]

#: JSON ``number`` — ints stay ints. Declaring these ``float`` would turn the wire's
#: ``1`` into ``1.0``, which canonicalizes to ``"1.0"`` where JavaScript writes
#: ``"1"``, and every real config would then fail checksum verification.
JsonNumber = int | float


class UnsupportedFormatVersionError(Exception):
    """Raised when a document declares a ``formatVersion`` this build cannot read.

    Deliberately NOT a ``ValueError``: pydantic wraps ``ValueError`` raised inside a
    validator into a ``ValidationError``, which would bury normative rule 3 among
    ordinary shape complaints. A refused version is a distinct, unambiguous outcome.
    """

    def __init__(self, format_version: object) -> None:
        self.format_version = format_version
        super().__init__(
            f"unsupported compiledConfig formatVersion {format_version!r}; "
            f"this build reads only {COMPILED_CONFIG_FORMAT_VERSION}"
        )


class _CompiledModel(BaseModel):
    """Shared posture: camelCase wire names, no unknown keys, immutable once parsed.

    ``extra='forbid'`` mirrors the schema's ``additionalProperties: false``
    throughout. ``frozen=True`` keeps a verified document verified — a config
    mutated after :func:`verify_checksum` returned ``True`` would carry a
    guarantee it no longer has.
    """

    model_config = ConfigDict(
        extra="forbid",
        alias_generator=to_camel,
        populate_by_name=True,
        frozen=True,
    )


class CompiledRetryPolicy(_CompiledModel):
    maximum_attempts: int = Field(ge=1)
    initial_interval_seconds: JsonNumber = Field(gt=0)
    backoff_coefficient: JsonNumber = Field(ge=1)


class CompiledInputBinding(_CompiledModel):
    from_node_id: str
    from_port: str
    to_port: str


class CompiledNode(_CompiledModel):
    node_id: NodeIdStr
    type: str = Field(min_length=1)
    #: A closed set drawn from ``apps/harness/src/harness/temporal/activities.py``'s
    #: ``@activity.defn`` names. No activity here writes SIGNED (TASK-716 §2.7).
    activity: str = Field(min_length=1)
    config: dict[str, Any]
    #: Already clamped to ``caps.maxNodeSeconds`` at COMPILE time — never re-derived here.
    timeout_seconds: int = Field(ge=1)
    retry: CompiledRetryPolicy
    inputs: list[CompiledInputBinding]
    #: ``degrade`` produces a MARKED nothing and continues (INV-019, INV-205) —
    #: never a silent empty result.
    on_error: Literal["fail", "degrade"]
    #: Always true for activity nodes (INV-084) — provenance emission is not
    #: tenant-disableable, so the contract pins it rather than leaving it optional.
    emits_trajectory: Literal[True]


class CompiledStage(_CompiledModel):
    stage_index: int = Field(ge=0)
    nodes: list[CompiledNode]


class CompiledGate(_CompiledModel):
    node_id: NodeIdStr
    gate_type: str = Field(min_length=1)
    blocking: bool
    timeout_seconds: int = Field(ge=1)
    on_timeout: str

    @field_validator("on_timeout")
    @classmethod
    def _timeout_is_never_approval(cls, value: str) -> str:
        # Normative rule 2 — the same mechanical tripwire as the schema's
        # `not: { const: "APPROVED" }`, and just as much NOT a full guarantee.
        if value == "APPROVED":
            raise ValueError("a gate's onTimeout may never mean approved (INV-001)")
        return value


class CompiledPromptTemplateRef(_CompiledModel):
    node_id: str
    template_id: str
    version_number: int = Field(ge=1)


class CompiledDocumentTemplateRef(_CompiledModel):
    """TASK-810 DD-2 — WHICH ``DocumentTemplate`` version one generation node decodes into.

    Structurally identical to :class:`CompiledPromptTemplateRef` and a DIFFERENT pin:
    that one pins what the model is TOLD, this one pins the SHAPE its output is decoded
    into. Kept a separate model rather than an alias so the two can never be passed for
    one another, and so a future divergence is a change here rather than a silent
    widening of both.
    """

    node_id: str
    template_id: str
    version_number: int = Field(ge=1)


class CompiledPolicyBindings(_CompiledModel):
    #: GUARDRAIL_PROFILE_KEYS — placement, not permission; the actual clinical-safety
    #: enforcement runs at a boundary this field only SELECTS.
    guardrail_profile: Literal["STANDARD", "STRICT", "RELAXED"]
    redaction_rule_set_id: str | None
    prompt_template_refs: list[CompiledPromptTemplateRef]
    #: SORTED by ``nodeId`` and UNPINNED bindings omitted, by the emitter — an absent ref
    #: means "this node follows the template's own pin", never ``versionNumber: 0``.
    document_template_refs: list[CompiledDocumentTemplateRef]
    context_schema_version_id: str | None
    entitlement_keys: list[str]


class CompiledCaps(_CompiledModel):
    """Platform ceilings materialized at compile time.

    "Tenants tighten, never exceed" is applied when the config is COMPILED; these
    are the ceilings that clamp used, not knobs to re-read at runtime.
    """

    max_total_seconds: int = Field(ge=1)
    max_node_seconds: int = Field(ge=1)
    max_attempts: int = Field(ge=1)


class CompiledWorkflowConfig(_CompiledModel):
    """The interpreter's input contract. Verify :func:`verify_checksum` before executing."""

    format_version: Literal[1]
    definition_id: UuidStr
    slug: str = Field(min_length=1)
    version_number: int = Field(ge=1)
    tenant_id: UuidStr
    palette_key: str = Field(min_length=1)
    #: An ISO-8601 date-time STRING, kept a string on purpose: parsing it into a
    #: ``datetime`` and dumping it back rewrites the bytes the checksum covers
    #: (``2026-08-16T00:00:00.000Z`` -> ``2026-08-16T00:00:00Z``).
    compiled_at: str = Field(min_length=1)
    compiler_version: str = Field(min_length=1)
    registry_checksum: str = Field(min_length=1)
    rule_set_version: int = Field(ge=0)
    #: Topological LEVELS, not a linear list: nodes within one stage have no
    #: dependency on each other and MAY run concurrently (INV-044, INV-108).
    stages: list[CompiledStage]
    #: Gate nodes lifted OUT of the stage list so the interpreter can find them
    #: without walking the graph, and so "nothing routes around a gate" is
    #: checkable against the compiled artifact as well as the source graph.
    gates: list[CompiledGate]
    policy_bindings: CompiledPolicyBindings
    caps: CompiledCaps
    checksum: str = Field(min_length=1)

    @model_validator(mode="before")
    @classmethod
    def _refuse_unknown_format_version(cls, data: Any) -> Any:
        # Normative rule 3. Runs BEFORE field validation so an unreadable document
        # is refused as such, rather than reported as a pile of shape errors from a
        # future version's fields.
        if isinstance(data, Mapping):
            declared = data.get("formatVersion", data.get("format_version"))
            if declared is not None and declared != COMPILED_CONFIG_FORMAT_VERSION:
                raise UnsupportedFormatVersionError(declared)
        return data


def canonical_json(value: Any) -> str:
    """Canonical JSON: object keys SORTED, array order PRESERVED.

    A byte-for-byte port of ``packages/workflow-contract/src/canonical-json.ts``
    (itself a deliberate copy of the applications layer's algorithm). Key order is a
    formatting accident and must not mint a new checksum; array order is authored
    intent (edge/port ordering) and must.

    ``json.dumps`` per scalar reproduces ``JSON.stringify``'s primitive encoding,
    including ``ensure_ascii=False`` — JavaScript does not escape non-ASCII, and
    escaping it here would produce a different digest for the same document.
    """
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, Mapping):
        entries = [
            f"{json.dumps(key, ensure_ascii=False)}:{canonical_json(value[key])}"
            for key in sorted(value)
        ]
        return "{" + ",".join(entries) + "}"
    return json.dumps(value, ensure_ascii=False)


def compute_checksum(document: Mapping[str, Any]) -> str:
    """sha256 hex over the canonical JSON of every field EXCEPT ``checksum``."""
    payload = {key: value for key, value in document.items() if key != "checksum"}
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def verify_checksum(config: CompiledWorkflowConfig | Mapping[str, Any]) -> bool:
    """Recompute ``checksum`` and compare (normative rule 4).

    Accepts either the raw wire document or a parsed :class:`CompiledWorkflowConfig`.
    Returns ``False`` — never raises — for a missing or non-string ``checksum``: an
    absent digest is an unverifiable document, which is the same answer as a wrong one.

    A ``False`` here means the stored document was tampered with or corrupted between
    compile and execution. Refuse to execute; do not log and continue.
    """
    if isinstance(config, CompiledWorkflowConfig):
        document: Mapping[str, Any] = config.model_dump(mode="json", by_alias=True)
    else:
        document = config

    stored = document.get("checksum")
    if not isinstance(stored, str):
        return False
    return hmac.compare_digest(compute_checksum(document), stored)
