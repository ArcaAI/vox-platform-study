# TASK-952 — Provider extras: the blank-field 400, and the inert config planes behind it

| | |
|---|---|
| **Status** | In Progress |
| **Type** | bugfix + refactor (console) · feature (harness) |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-11 |

## Requirement Analysis

Reported: on the `arcaai` tenant, creating a realtime-transcription agent with Sarvam as a
fallback reports the provider unusable; enabling the Sarvam STT connection with **no model**
then fails with

```
extraJson is not a valid provider-extras object: 'model' must be a string, number,
boolean, or an array of those (nested objects are not forwarded)
```

The reported 400 is one symptom of a wider defect class found while tracing it. This ticket
covers the whole class.

## Current State Evaluation

### The 400 itself

`buildBody()` in `provider-credential-card.tsx` turns a blank field into `null`. For a
COLUMN-backed field that is correct (it clears the column). For an `extraJson` field it is not:
`validateProviderExtras` admits scalars and scalar arrays only, and `null` is neither.
Reproduced against the real validator:

```
{ model: null } -> ["'model' must be a string, number, boolean, or an array of those …"]
{ model: '' }   -> []          ← accepted on write
{}              -> []
sanitizeProviderExtras({ model: '' }) -> {}   ← dropped on read
```

`provider-extras.ts` documents that `''` is accepted on write precisely "so clearing a field is
not a 400". The console never sends it.

**Blast radius: 11 `store: 'extra'` fields.** Four cards are unsavable in their documented
default state: `stt:sarvam` (its only field), `model-registry:huggingface` and
`model-registry:s3` (both carry `platformDefaultWhenBlank: true` — a blank row IS the built-in
default), and `llm:llama-cpp` when restoring the endpoint on the row the seed ships without a
`modelPath`.

### What the field does when you fill it in

`extraJson.model` is an **override-wins global pin**, not "which model this connection serves":

- `apps/text/src/text/providers/openai.py:130` — *"override-wins: a tenant override MAY pin the
  model; otherwise the caller-supplied model is authoritative"* (same in bedrock/anthropic/vertex)
- `apps/stt/src/stt/models/sarvam_loader.py:80` — `model_name = override.get("model") or model_name`

So the blank→400 bug pushes a tenant admin into silently overriding every agent's bound model.

### The plane that already solves it

Model identity is `AiModel`, not the connection: tenant rows are declared against a connection
(`sourceConnectionId`, TASK-890 §3.1) and agents bind them by FK (`Agent.modelId`,
`AgentModelFallback.modelId`). The editor is `connection-models-editor.tsx`, gated on
`current.version > 0` — i.e. it appears only after a successful save, which the 400 prevents.

For the reported case nothing needed declaring at all: the platform catalogue already ships
`sarvam-saaras-v4` (`wireModelId = saaras:v4`, `deploymentKind = CLOUD`). Enabling the connection
with a key and no model is the whole fix.

### Extras audit — who actually reads each field

| Card | Extra key | Runtime reader | Blank legitimate? |
|---|---|---|---|
| `llm:llama-cpp` | `modelPath` | required by `PROVIDER_REQUIREMENTS`; seed ships the row enabled without it | no when enabled |
| `llm:vertex` | `project` | `vertex.py:128` | no |
| `stt:sarvam` | `model` | `sarvam_loader.py:80` (override-wins) | yes |
| `stt:openai` | `model` | `openai_loader.py:76` (override-wins) | yes |
| `stt:azure-speech` | `model` | **nothing** | yes |
| `stt:azure-foundry` | `model` | **nothing** — `azure_foundry_loader.py:105` reads `source_uri`, fail-closed by design | yes |
| `embeddings:openai` | `model` | **nothing** — harness reads `settings.retrieval.embeddings_model` | yes |
| `vector:qdrant` | `collection` | **nothing** — the fold sets only `qdrant_url` / `qdrant_api_key` | yes |
| `model-registry:huggingface` | `model` | requirements table only | yes, by design |
| `model-registry:s3` | `accessKeyId` | `apps/stt/src/stt/core/model_credentials.py:195` | yes, by design |

`resolveTenantCloudOverrides` is only ever called for `llm` / `stt` / `tts`
(`AGENT_TASK_SERVICE`), so the whole `embeddings` connection — endpoint, key and model — is a
write-only surface today.

### The wipe hiding behind the 400

`buildBody()` rebuilds `extra` from the card's field list alone, and the service replaces
`extraJson` wholesale (`ai-provider-connection.service.ts:399`). Any stored key without a card
field is destroyed on save — concretely `inheritsPlatformStorage` on the seeded S3 row. Today
the 400 masks it; fixing the 400 without fixing this ships the data loss. Severity is low
(`platformStorageFallback` keys on tenant + enabled + no-key, not on the marker) but the shape
is wrong and the next load-bearing extras key would lose data for real.

## Owner Decisions

| # | Decision | Answer (2026-09-11) |
|---|---|---|
| D-1 | The `model` field on inference cards | Remove from `stt:azure-speech`, `stt:azure-foundry`, `stt:sarvam`, `stt:openai`. Keep `llama-cpp:modelPath`, `vertex:project`, both model-registry extras. Column + API unchanged. |
| D-1b | `vector:qdrant` → `collection` | **Wire it** into the harness retrieval config beside `qdrant_url` / `qdrant_api_key`. |
| D-1c | The inert `embeddings` plane | **Wire it end to end** — harness reads endpoint + model from the connection instead of `pydantic-settings`, retiring the hardcoded `text-embedding-bge-m3` default. |
| D-2 | Blank extras → 400 | Omit blank keys; send `extraJson` unconditionally when the provider declares any extras field. |
| D-3 | Invisible Models editor | Hint on an unsaved BYO row: save the credential, then declare its models. |
| D-4 | Two accounts per vendor | Accept `@@unique([tenantId, service, provider])`. Not in scope. |
| D-5 | `no-enabled-connection` in the picker | Render reason codes as guidance, not raw codes. |
| D-6 | Extras wipe on save | Merge over the stored `extraJson` so keys without a card field survive. |

"Drop the embeddings tab" was considered and rejected: `provider-services.drift.test.ts` pins the
console tab list two-directionally against the gateway's `:service` OpenAPI enum, so it is not a
console-only change.

No gateway lane is needed for D-1b/D-1c: `GET internal/harness/provider-credential`
(`harness-internal.controller.ts:534`) already validates `(service, provider)` against
`PROVIDER_SERVICES` and names `embeddings` in its own Swagger.

## Implementation Plan — four non-overlapping lanes

| Lane | Scope | Files it OWNS | Tier |
|---|---|---|---|
| **A** | D-2, D-6, D-3 | `ai-providers/components/provider-credential-card.tsx` + `__tests__/provider-credential-card.test.tsx` | opus-5 |
| **B** | D-1 | `ai-providers/components/provider-meta.ts` + `__tests__/provider-meta.drift.test.ts` | sonnet-5 |
| **C** | D-5 | `agents/components/model-picker.tsx` + a new `__tests__/model-picker.task952.test.tsx` | sonnet-5 |
| **D** | D-1b, D-1c | `apps/harness/**` (+ env samples / `turbo.json` if a var is retired) | opus-5 |

No file is owned by two lanes. Lane A must handle a provider whose `fields` list is EMPTY —
`stt:sarvam` becomes one after Lane B. The orchestrator owns merges, `pnpm install` in the
primary checkout, all DB/infra commands, and this document.

## Implementation Summary

_Filled in as lanes land._

## Change History

| Date | Change |
|---|---|
| 2026-09-11 | Ticket opened; investigation, extras audit and owner decisions recorded; four lanes briefed. |
