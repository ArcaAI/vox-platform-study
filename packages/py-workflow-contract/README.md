# hope-workflow-contract — the Python mirror of `compiledConfig` (consumer half)

The Python mirror of `@arcaai/workflow-contract`'s `compiledConfig` contract — the CONSUMER half
only. Consumed by `apps/harness`'s Temporal workflow interpreter.

Normative machine artifact (the one both languages mirror):
[`compiled-config.schema.json`](../workflow-contract/schemas/compiled-config.schema.json).

## Layout

| Path | What it holds |
|---|---|
| `src/hope_workflow_contract/compiled_config.py` | `CompiledWorkflowConfig` and every nested model (`CompiledNode`, `CompiledStage`, `CompiledGate`, `CompiledRetryPolicy`, ...), `UnsupportedFormatVersionError`, `verify_checksum` |
| `tests/test_parity.py` | Field-set parity against the normative JSON Schema, round-trips the shared TS/Python example, recomputes a TypeScript-produced sha256 |

## Commands

```bash
conda run -n arcaenv pytest packages/py-workflow-contract
```

## How it works

### Why it exists

`compiledConfig` is produced by `packages/workflow-contract`'s TypeScript compiler from a
server-validated `WorkflowGraph`, stored on `WorkflowDefinition.compiledConfig` at publish, and
consumed by the Python interpreter in `apps/harness`. Two languages, one format — which is exactly
the shape that has drifted silently in this repo before.

`tests/test_parity.py` is the artifact that stops it drifting a fourth time. It asserts field-set
parity against the normative JSON Schema definition-by-definition, round-trips the SAME shared
example the TypeScript test asserts
(`packages/workflow-contract/src/__tests__/fixtures/example-compiled-config.json`), and recomputes
a real, TypeScript-produced sha256 to prove the two canonicalizers agree byte-for-byte. **That test
is load-bearing** — if it is ever skipped, the format has three implementations again.

### Consumer half only

Python never authors or validates a workflow. There is no compiler, no rule catalogue, and no
graph model here, and there must not be one: the graph is untrusted input, the compiled config is
a server-produced artifact.

```python
from hope_workflow_contract import (
    CompiledWorkflowConfig,
    UnsupportedFormatVersionError,
    verify_checksum,
)

try:
    config = CompiledWorkflowConfig.model_validate(document)   # refuses unknown formatVersion
except UnsupportedFormatVersionError:
    raise                                                      # never best-effort parse

if not verify_checksum(document):
    raise RuntimeError("compiledConfig checksum mismatch")     # refuse to execute

for stage in config.stages:      # topological LEVELS; nodes in one stage may run concurrently
    for node in stage.nodes:
        ...
```

`verify_checksum` accepts either the raw wire mapping or a parsed `CompiledWorkflowConfig`.

### The four normative rules this package implements

| Rule | Here |
|---|---|
| There is no node type that can write `SIGNED` — approval lives outside the substrate | No such field exists in any model; a test asserts no property name on either side contains `sign` |
| A gate's `onTimeout` may never mean "approved" | `CompiledGate` rejects the literal `APPROVED` — a mechanical tripwire, not a substitute for a human check that the enum grows no synonym (`AUTO_APPROVE`, `GRANTED`, ...) |
| An unknown `formatVersion` is REFUSED, never best-effort parsed | `UnsupportedFormatVersionError` (deliberately not a `ValueError`, so pydantic cannot bury it inside a `ValidationError`) |
| `checksum` MUST be verified before executing | `verify_checksum()`; a mismatch means tampering or corruption between compile and execution, not a warning to log |

### Two mirroring decisions worth knowing

Both exist to keep parse -> dump byte-identical, because the checksum is computed over those
bytes:

- `compiledAt` stays a `str`, not a `datetime`. Parsing and re-emitting rewrites
  `2026-08-16T00:00:00.000Z` as `2026-08-16T00:00:00Z`.
- `retry` numbers are `int | float`, not `float`. JSON `number` includes integers; declaring
  `float` turns the wire's `1` into `1.0`, which canonicalizes to `"1.0"` where JavaScript writes
  `"1"` — every real config would then fail verification.

`tests/test_parity.py` pins both with an exact round-trip assertion, so neither can be "simplified"
away silently.

## Gotchas

- **Worktree/editable-install hazard.** `hope_workflow_contract` is editable-installed into the
  shared `arcaenv`, pointing at the MAIN checkout. Running the suite from a git worktree can
  therefore exercise the wrong copy. `test_the_module_under_test_is_the_one_next_to_this_test`
  fails loudly when that happens; force the right tree with
  `PYTHONPATH=<tree>/packages/py-workflow-contract/src`, or refresh the editable install.
- The original design writeup for this contract (TASK-716) has since been archived along with the
  rest of that ticket's docs; this README and the normative schema are the current source of
  truth.

## Related

- [`@arcaai/workflow-contract` normative schema](../workflow-contract/schemas/compiled-config.schema.json)
- [`06-python-services.md`](../../.claude/rules/06-python-services.md) — the harness Temporal interpreter this package feeds
