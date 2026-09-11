# TASK-952 — Provider extras: the blank-field 400, and the inert config planes behind it

| | |
|---|---|
| **Status** | Review |
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

Five lanes, all merged into `dev-2.2`. Nothing pushed.

| Lane | Merge | Delivered |
|---|---|---|
| B | `eee62f360` | The four inert / override-wins `model` extras fields removed from the STT cards, plus a drift guard so they cannot return. |
| A | `0f53040ed` | `buildBody()`: blanks OMITTED (D-2), `extraJson` sent whenever the provider declares extras (D-2b), envelope MERGED over the stored one (D-6), models-editor signpost on an unsaved BYO row (D-3). RED verified — 4 of 8 new tests fail against the previous implementation. |
| C | `4de67dad8` | Reason codes rendered as guidance (D-5); unknown codes still fall through verbatim. |
| D | `a0caf7a6f` | Harness reads the qdrant `collection` prefix (D-1b) and the embeddings endpoint/key/model (D-1c) from the connection plane, plus the gateway `extras` passthrough the plan wrongly assumed was unnecessary. |
| E | `ad81bca8e` | The platform embeddings tier gets its own provider id, `embeddings:tei-embed`, so it stops being gated as vendor spend; SYSTEM row seeded; `text-embedding-bge-m3` literal retired; platform card added. |

Two defects found in orchestrator review, outside any lane:

- `1cea8e80c` — **the read projection returned `extraJson` raw.** Harmless while the console rebuilt the envelope from its own field list; load-bearing the moment lane A made it echo the stored envelope back, since an inadmissible legacy value would then return as a 400 on the next save. `toResponse` now sanitises, `null` preserved.
- `0449cc180` — **`no-usable-model` left rendering raw.** Lane C found a sixth reason code and excluded it under the "unknown codes fall through" rule; that rule is for codes nobody has SEEN. Mapped with its own wording (it is the Hope GROUP summary, whose fix is not on AI Providers).

### Four places this plan was wrong, corrected by the lanes

1. **"No gateway lane is needed for D-1b/D-1c."** `HarnessProviderCredentialResponse` allow-listed `model` and dropped every other extras key, so `vector:qdrant`'s `collection` was validated, stored, and discarded one hop before its only consumer. Lane D added the passthrough.
2. **"Seed a keyless SYSTEM row."** `ai-provider-connection.service.ts:653` drops `!row.enabled || !row.encryptedApiKey` on BOTH tiers, so a literally keyless row resolves `absent` and delivers nothing. The row carries `SELF_HOST_PLACEHOLDER_API_KEY`, exactly as the four `llm` engines do.
3. **"Widening happens only on ABSENCE."** A tenant with no embeddings row does not resolve `ABSENT` on the BYO pair — it resolves `DENIED`, always, because the entitlement gate is evaluated without reference to any row. The rule was unsatisfiable as written. The gateway now stamps a machine-readable `denial` (`tenant-veto` | `platform-entitlement`) and the harness widens on the entitlement one only; a VETO is never widened past, and an unknown or absent cause fails closed.
4. **`BUILT_IN_PROVIDERS_BY_SERVICE` had no consumer.** `platform-provider-sections.tsx` rendered the flat card list under a hardcoded `service="llm"`, so a new platform card would have written an `llm:tei-embed` row nothing resolves. The section now carries the service with the card, pinned by a drift assertion.

### Verification (primary checkout, after every merge)

| Suite | Result |
|---|---|
| `pnpm harness:test` (incl. replay-compat) | 2488 passed |
| `pnpm harness:lint` / `harness:typecheck` | ruff clean · mypy clean, 151 files |
| `@arcaai/applications` — ai-provider-connection + consultation/harness | 564 passed (31 files) |
| `tests/contracts` + `tests/cross-tenant` | 359 passed (27 files) |
| `@arcaai/database` | 1756 passed (89 files) |
| `@arcaai/admin-console` — ai-providers + agents | 184 passed (23 files) |
| `@arcaai/admin-console` lint / typecheck | clean |

### Outstanding

- **A re-seed is required** before the platform embeddings lane resolves at runtime — `pnpm db:seed` (create-only), with `SECRETS_PROVIDER=vault` so the placeholder ciphertext is written. No migration: no schema changed. Until then, retrieval with `enabled: true` degrades visibly with `error_code="embeddings_model_unresolved"` rather than embedding on an invented model.
- `embeddings_dim` deliberately stays an env-tier sizing knob: it describes the Qdrant COLLECTION as much as the model, and a connection row has nowhere to declare one. Co-locating it (`extraJson.dim` + a fold) changes what "reset to default" means for an existing collection — an owner call, not a silent one.
- `pnpm harness:format:check` is red on `dev-2.2` INDEPENDENTLY of this ticket (24 files, 23 of them untouched here). A repo-wide `pnpm harness:format` as its own commit clears it.
- `membership-bounded-sync.integration.test.ts` fails on a live-DB credential error, environmental and pre-existing.
- Not addressed, flagged by lane A: `handleTest()` skips every `store: 'extra'` field when building the probe body, so a typed-but-unsaved `vertex:project` probes a different configuration than the save will store.

## Change History

| Date | Change |
|---|---|
| 2026-09-11 | Ticket opened; investigation, extras audit and owner decisions recorded; four lanes briefed. |
| 2026-09-11 | Lanes B, A, C merged; two orchestrator-review defects fixed (read-projection sanitise, `no-usable-model` mapping). |
| 2026-09-11 | Lane D merged. Its embeddings half was unreachable — `featurePlatformDefaultCredential` is false on every plan, so the entitlement gate answered `denied` for `embeddings:openai` regardless of rows, and `retrieve_context` degraded to empty context. Latent only (`RetrievalConfig.enabled` defaults false). Owner chose to finish rather than defer. |
| 2026-09-11 | Lane E merged: `embeddings:tei-embed` classified as platform self-host, SYSTEM row seeded, hardcoded model literal retired, `denial` discriminator added so a veto and an entitlement suppression are distinguishable on the wire. All gates green; status → Review pending owner sign-off and a dev re-seed. |
