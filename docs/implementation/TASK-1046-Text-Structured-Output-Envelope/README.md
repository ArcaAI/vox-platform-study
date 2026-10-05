# TASK-1046 — Text service: one structured-output envelope for every provider

| Field | Value |
|---|---|
| Status | **Pending** — raised from TASK-1045 (H-164, owner decision D-39, 2026-10-05); not started |
| Type | bugfix (pre-existing, all providers) |
| Repo / branch | `hope-v2`, `dev-2.2` |
| Related | TASK-1045 (found by its live proof; LM Studio-only fix `c322e89e4`) |

## 1. Requirement Analysis

Every agent with an output schema must have that schema ENFORCED by the engine that serves it, on every provider the platform supports (LM Studio, OpenAI-compatible base, OpenAI, Azure OpenAI, vLLM incl. `guided_json`, llama.cpp, Ollama, Anthropic, Bedrock, Vertex). Today it is enforced only on LM Studio.

## 2. Current State Evaluation (code-verified 2026-10-05)

- Callers (gateway + harness) build the directive with `outputSchemaResponseFormat` (`packages/workflow-contract/src/agent-schemas.ts:1878`): `{ type: 'json_schema', json_schema: { name, schema, strict } }` — OpenAI's ENVELOPE.
- `apps/text/src/text/models/requests.py` `ResponseFormat.json_schema` is documented and used as the BARE schema.
- Every adapter wraps `json_schema` in its own engine format, assuming it is bare: `openai_compat.py:317` (`{type:'json_schema', json_schema:{name, schema: <json_schema>, strict}}`), `azure_openai.py:257`, `vllm.py:111` (`extra_body.guided_json = json_schema` on older builds), `llama_cpp.py:127` (`payload.json_schema`), `ollama.py:157` (`payload.format`), `bedrock.py:271`, `anthropic.py:216`.
- Result: the envelope is wrapped AS the schema (schema = `{name, schema, strict}`), which constrains nothing useful (or is rejected). TASK-1045's live run found the fact ledger empty for exactly this reason on LM Studio; `providers/lmstudio.py` `_unwrapped_envelope` (`c322e89e4`) fixes that one engine only.

## 3. Implementation Plan (proposed — owner approves before code)

1. **Normalise once at the request boundary**: `ResponseFormat` accepts both shapes; a `json_schema` that is an envelope (`{name?, schema: object, strict?}` with no top-level JSON-Schema keywords) is unwrapped into `json_schema = schema`, `strict = envelope.strict ?? strict`, `name` kept for adapters that need a name. Unwrapping here is safe for OpenAI too: its adapter re-wraps.
2. Remove the LM Studio-only `_unwrapped_envelope` (now redundant).
3. Contract tests per provider (TDD, RED first): given the envelope AND the bare schema, each adapter's outgoing payload carries the bare schema in its native slot (OpenAI/Azure/LM Studio `response_format.json_schema.schema`, vLLM `guided_json` / `response_format`, llama.cpp `json_schema`, Ollama `format`, Bedrock/Anthropic tool schema, Vertex `response_schema`).
4. Optional hardening: a shared fixture `tests/contracts/response-format.fixture.json` used by the TS builder and the Python model.
5. Rollout: behaviour changes for every agent on every non-LM-Studio provider (schemas start being enforced) → run each tenant's golden sets / evalGate on a non-LM-Studio provider before enabling there.

## 4. Implementation Summary

Not started.

## 5. Change History

| Date | Change |
|---|---|
| 2026-10-05 | Ticket opened from TASK-1045 H-164 / D-39; current state verified against the provider adapters. |
