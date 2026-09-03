"""The interpreter's read of ``compiledConfig`` (Task 1/5).

This is a LOCAL, harness-scoped Pydantic mirror of the single normative schema —
``packages/workflow-contract/schemas/compiled-config.schema.json``
— produced by ``packages/workflow-contract``'s TypeScript compiler. It is deliberately NOT the
full cross-language parity package (``packages/py-workflow-contract`` / ``hope_workflow_contract``)
that Task 7b still owes the platform (see "not built, not
reached in this session's time budget") — this module only implements what the
config-loader activity needs: parse, structural admission, and checksum verification.

**Known gap, named rather than hidden** (for the honest accounting):
``canonical_json`` below is a best-effort Python port of
``packages/workflow-contract/src/canonical-json.ts``'s algorithm (key-sorted objects, order-
preserved arrays, ``JSON.stringify``-equivalent primitive encoding). It has NOT been verified
byte-for-byte against a live Node.js execution of the TypeScript original in this session (no
Node runtime was exercised here) — only structurally reviewed against the TS source and unit-
tested for internal determinism/round-trip. A real compiled artifact's ``checksum`` was computed
by the TS implementation; if the two canonicalizers ever diverge (the most likely gap: JS
``JSON.stringify`` drops the ``.0`` suffix on whole-number floats, which this port special-cases,
and JS does not escape non-ASCII characters, which this port matches via ``ensure_ascii=False``),
every real config would fail checksum verification here. Closing that gap for real is exactly
Task 7b's parity-test job; until that lands, this module's checksum check should be
treated as validated-in-principle, not proven-in-practice against the actual TS output.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from harness.temporal.interpreter import caps


class InterpreterConfigError(RuntimeError):
    """Raised by config admission (Task 5, contracts/execution-semantics.md). Always fail LOUD.

    ``code`` is one of: malformed_json, unsupported_format_version, checksum_mismatch,
    gates_not_supported_v1, structural_bounds_exceeded, invalid_shape.
    """

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        super().__init__(f"{code}: {detail}" if detail else code)


# ---------------------------------------------------------------------------
# Canonical JSON — see the module docstring's "known gap" note.
# ---------------------------------------------------------------------------


def _primitive(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        # JS `JSON.stringify` drops the trailing `.0` on a whole-number float (2.0 -> "2");
        # Python's json.dumps does not. Match JS for this one, common divergence.
        if value.is_integer():
            return str(int(value))
        return repr(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        # ensure_ascii=False: JS JSON.stringify does not escape non-ASCII characters.
        return json.dumps(value, ensure_ascii=False)
    raise TypeError(f"canonical_json: unsupported primitive type {type(value)!r}")


def canonical_json(value: Any) -> str:
    """Deliberate Python port of ``packages/workflow-contract/src/canonical-json.ts``.

    Object keys SORTED, array order PRESERVED — see that file's docstring for why (key order is
    a formatting accident; array order is authored intent).
    """
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        entries = [
            f"{json.dumps(k, ensure_ascii=False)}:{canonical_json(v)}"
            for k, v in sorted(value.items())
            if v is not None
            or k in value  # mirror the TS `!== undefined` filter (JSON has no undefined)
        ]
        return "{" + ",".join(entries) + "}"
    return _primitive(value)


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Compiled-config shape (mirrors compiled-config.schema.json's $defs 1:1)
# ---------------------------------------------------------------------------


class CompiledRetryPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    maximum_attempts: int = Field(alias="maximumAttempts")
    initial_interval_seconds: float = Field(alias="initialIntervalSeconds")
    backoff_coefficient: float = Field(alias="backoffCoefficient")


class CompiledInputBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_node_id: str = Field(alias="fromNodeId")
    from_port: str = Field(alias="fromPort")
    to_port: str = Field(alias="toPort")


class CompiledNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node_id: str = Field(alias="nodeId")
    type: str
    activity: str
    config: dict[str, Any] = Field(default_factory=dict)
    timeout_seconds: int = Field(alias="timeoutSeconds")
    retry: CompiledRetryPolicy
    inputs: list[CompiledInputBinding] = Field(default_factory=list)
    on_error: Literal["fail", "degrade"] = Field(alias="onError")
    emits_trajectory: Literal[True] = Field(alias="emitsTrajectory")


class CompiledStage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stage_index: int = Field(alias="stageIndex")
    nodes: list[CompiledNode]


class CompiledGate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node_id: str = Field(alias="nodeId")
    gate_type: str = Field(alias="gateType")
    blocking: bool
    timeout_seconds: int = Field(alias="timeoutSeconds")
    on_timeout: str = Field(alias="onTimeout")


class CompiledPromptTemplateRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node_id: str = Field(alias="nodeId")
    template_id: str = Field(alias="templateId")
    version_number: int = Field(alias="versionNumber")


class CompiledDocumentTemplateRef(BaseModel):
    """WHICH DocumentTemplate version one generation node decodes into.

    Same three keys as :class:`CompiledPromptTemplateRef`, a different pin: that one pins
    what the model is TOLD, this one pins the SHAPE its output is decoded into.
    """

    model_config = ConfigDict(extra="forbid")

    node_id: str = Field(alias="nodeId")
    template_id: str = Field(alias="templateId")
    version_number: int = Field(alias="versionNumber")


class CompiledPolicyBindings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    guardrail_profile: Literal["STANDARD", "STRICT", "RELAXED"] = Field(alias="guardrailProfile")
    redaction_rule_set_id: str | None = Field(alias="redactionRuleSetId")
    prompt_template_refs: list[CompiledPromptTemplateRef] = Field(
        default_factory=list, alias="promptTemplateRefs"
    )
    #: Sorted by ``nodeId`` and unpinned bindings omitted, by the emitter. Defaulted like
    #: its siblings on this model so an artifact compiled before the field existed still
    #: parses — absence means "binds no shape", never "unknown".
    document_template_refs: list[CompiledDocumentTemplateRef] = Field(
        default_factory=list, alias="documentTemplateRefs"
    )
    context_schema_version_id: str | None = Field(alias="contextSchemaVersionId")
    entitlement_keys: list[str] = Field(default_factory=list, alias="entitlementKeys")


class CompiledCaps(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_total_seconds: int = Field(alias="maxTotalSeconds")
    max_node_seconds: int = Field(alias="maxNodeSeconds")
    max_attempts: int = Field(alias="maxAttempts")


class CompiledWorkflowConfig(BaseModel):
    """Mirrors ``CompiledWorkflowConfig`` in ``packages/workflow-contract/src/compiler.ts``."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    format_version: Literal[1] = Field(alias="formatVersion")
    definition_id: str = Field(alias="definitionId")
    slug: str
    version_number: int = Field(alias="versionNumber")
    tenant_id: str = Field(alias="tenantId")
    palette_key: str = Field(alias="paletteKey")
    compiled_at: str = Field(alias="compiledAt")
    compiler_version: str = Field(alias="compilerVersion")
    registry_checksum: str = Field(alias="registryChecksum")
    rule_set_version: int = Field(alias="ruleSetVersion")
    stages: list[CompiledStage]
    gates: list[CompiledGate]
    policy_bindings: CompiledPolicyBindings = Field(alias="policyBindings")
    caps: CompiledCaps
    checksum: str


def parse_and_verify(raw: str) -> CompiledWorkflowConfig:
    """The six-step admission sequence from contracts/execution-semantics.md.

    Steps 1 (claim-check dereference) and 6 (structural bounds) happen around/after this
    function (dereference is the caller's job — ``load_config`` in ``activities.py``; the
    caller also owns ordering). This function performs steps 2-5: parse, formatVersion,
    checksum, gates-empty — plus structural bounds (step 6) since they need the parsed dict.
    """
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise InterpreterConfigError("malformed_json", str(exc)) from exc

    if not isinstance(parsed, dict):
        raise InterpreterConfigError("malformed_json", "top-level document is not an object")

    if parsed.get("formatVersion") != 1:
        raise InterpreterConfigError(
            "unsupported_format_version", f"got {parsed.get('formatVersion')!r}"
        )

    claimed_checksum = parsed.get("checksum")
    if not isinstance(claimed_checksum, str):
        raise InterpreterConfigError("checksum_mismatch", "checksum field missing or not a string")
    body = {k: v for k, v in parsed.items() if k != "checksum"}
    recomputed = _sha256_hex(canonical_json(body))
    if recomputed != claimed_checksum:
        raise InterpreterConfigError(
            "checksum_mismatch", f"expected {claimed_checksum}, computed {recomputed}"
        )

    # Gate admission. This used to be a blanket `gates != []` refusal
    # ("HITL gate execution is out of scope for this interpreter version"). The interpreter now
    # executes ONE blocking gate as a child workflow, so the refusal narrows rather than
    # disappearing — every shape the interpreter cannot faithfully execute is still refused
    # loudly at admission, never silently walked past.
    gates = parsed.get("gates")
    if not isinstance(gates, list):
        raise InterpreterConfigError("invalid_shape", "compiledConfig.gates is not a list")
    if len(gates) > caps.MAX_GATES:
        raise InterpreterConfigError(
            "too_many_gates",
            f"compiledConfig carries {len(gates)} gates; at most {caps.MAX_GATES} is supported "
            "(the validator's own SINGLE_ENTRY rule on the gate node type enforces this "
            "upstream — a config reaching here with more is a compiler bug)",
        )
    for gate in gates:
        if not isinstance(gate, dict):
            raise InterpreterConfigError(
                "invalid_shape", "compiledConfig.gates[] entry is not an object"
            )
        if gate.get("blocking") is not True:
            # A non-blocking gate would mean "carry on without the human", which is a different
            # authority model, not a variation of this one. Refused rather than approximated.
            raise InterpreterConfigError(
                "non_blocking_gate_not_supported",
                f"gate {gate.get('nodeId')!r} declares blocking=False; only a blocking gate is supported",
            )

    stages = parsed.get("stages") or []
    if len(stages) > caps.MAX_STAGES:
        raise InterpreterConfigError(
            "structural_bounds_exceeded", f"{len(stages)} stages > MAX_STAGES={caps.MAX_STAGES}"
        )
    total_nodes = 0
    for stage in stages:
        nodes = stage.get("nodes") if isinstance(stage, dict) else None
        n = len(nodes) if isinstance(nodes, list) else 0
        if n > caps.MAX_NODES_PER_STAGE:
            raise InterpreterConfigError(
                "structural_bounds_exceeded",
                f"stage {stage.get('stageIndex')} has {n} nodes > "
                f"MAX_NODES_PER_STAGE={caps.MAX_NODES_PER_STAGE}",
            )
        total_nodes += n
    if total_nodes > caps.MAX_TOTAL_NODES:
        raise InterpreterConfigError(
            "structural_bounds_exceeded",
            f"{total_nodes} total nodes > MAX_TOTAL_NODES={caps.MAX_TOTAL_NODES}",
        )

    try:
        return CompiledWorkflowConfig.model_validate(parsed)
    except Exception as exc:  # noqa: BLE001 — normalize every shape failure into one error type
        raise InterpreterConfigError("invalid_shape", str(exc)) from exc
