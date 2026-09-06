"""``hope_workflow_contract`` — the Python mirror of ``@arcaai/workflow-contract``'s
compiledConfig contract (b).

CONSUMER half only: pydantic models for the compiled artifact, checksum verification
and a ``formatVersion`` guard. There is no compiler and no validator here — Python
never authors a workflow. See :mod:`hope_workflow_contract.compiled_config` for the
four normative rules every consumer is bound by.
"""

from hope_workflow_contract.compiled_config import (
    COMPILED_CONFIG_FORMAT_VERSION,
    CompiledBranchGuard,
    CompiledCaps,
    CompiledContextSchemaRef,
    CompiledDocumentTemplateRef,
    CompiledGate,
    CompiledGuardrailDecision,
    CompiledInputBinding,
    CompiledLoop,
    CompiledLoopBody,
    CompiledNode,
    CompiledPolicyBindings,
    CompiledPromptTemplateRef,
    CompiledRetryPolicy,
    CompiledStage,
    CompiledWorkflowConfig,
    UnsupportedFormatVersionError,
    canonical_json,
    compute_checksum,
    verify_checksum,
)

__all__ = [
    "COMPILED_CONFIG_FORMAT_VERSION",
    "CompiledBranchGuard",
    "CompiledCaps",
    "CompiledContextSchemaRef",
    "CompiledDocumentTemplateRef",
    "CompiledGate",
    "CompiledGuardrailDecision",
    "CompiledInputBinding",
    "CompiledLoop",
    "CompiledLoopBody",
    "CompiledNode",
    "CompiledPolicyBindings",
    "CompiledPromptTemplateRef",
    "CompiledRetryPolicy",
    "CompiledStage",
    "CompiledWorkflowConfig",
    "UnsupportedFormatVersionError",
    "canonical_json",
    "compute_checksum",
    "verify_checksum",
]
