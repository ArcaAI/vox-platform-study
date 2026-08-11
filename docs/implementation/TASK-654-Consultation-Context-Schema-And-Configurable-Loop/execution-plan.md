# TASK-654 — Execution Plan

Per-ticket specs for a team of agents working in parallel. Companion to [README.md](./README.md); every current-state claim below is cited there.

**Read this first if you are an implementing agent.** §1 is the contract. §3 is your ticket.

---

## 1. Agent Contract

### 1.1 Isolation

| Ticket type | Where it runs |
|---|---|
| Code | **Its own git worktree**, one implementing session at a time |
| Documentation only | The shared tree |

```bash
git worktree add ../hope-654-<ticket> -b task-<ticket>
cd ../hope-654-<ticket>
git reset --hard dev-2.1     # MANDATORY — worktrees spawn from main in this repo
```

Skipping the reset silently bases the work on `main`. This has happened before in this tree.

### 1.1a Python tickets MUST NOT gate from a worktree

Discovered the hard way on TASK-657, 2026-08-11.

The conda env `arcaenv` installs each Python service as an **editable package pinned to an absolute path**:

```
site-packages/__editable__.smr-2.0.0.pth  →  /…/hope-v2/apps/smr/src
```

That path is the **main checkout**. Run `pnpm smr:test` (or `harness:test`, `nlp:test`, …) from a worktree and pytest collects the *worktree's tests* but imports the *main tree's source*. Observed result: 30 spurious failures (`AttributeError: 'ProviderInfo' object has no attribute 'supports_vision'` — asserting against code that predated the ticket) plus knock-on 401s. The far more dangerous inverse is equally possible: a Python ticket reporting **green while having tested none of its own changes**.

**Therefore:**

- **TASK-657, TASK-662, TASK-664 run in the MAIN TREE**, serialised against each other — never concurrently, and never alongside another ticket touching the same service.
- If a Python ticket must run in a worktree, every gate command has to be prefixed `PYTHONPATH="$PWD/apps/<svc>/src"`, and the ticket README must state that this was done. Verified working: `PYTHONPATH="$PWD/apps/smr/src" pnpm smr:test:unit` → 109 failed / 1009 passed, versus 139 / 979 without it.
- **Always establish a baseline** before attributing Python failures to a ticket: run the same suite on `dev-2.1` without the change. SMR's standing baseline is **109 failures** (the TASK-639 module-level `app = create_app()` env leak); harness and the others have their own.

TypeScript tickets are unaffected — pnpm workspaces resolve inside the worktree correctly.

### 1.1b Build before you test, or your gates lie

A fresh worktree has no built workspace dists. Two consequences, both observed:

- **`pnpm test:unit` needs `room`, `noise-filter`, `vad`, `stt`, `med-ner`, `vox` and `ui` built first** — otherwise ~31 files fail on unresolved workspace entries and the run reports a false red.
- **After `pnpm db:generate` you must rebuild `@arcaai/database` and `@arcaai/domains`** before testing. The `resourceType.enum-parity` guard reads the *generated* Prisma enum through `@arcaai/database`'s dist; a stale dist makes it fail against a correct schema. Observed on the TASK-658 merge: 1 domains failure and **197 applications files failing to load with only 1 failed assertion** — the signature of stale-dist module-load failure, not broken code. Rebuilding in dependency order returned 1,564 and 8,685 passing.

Correct order: `pnpm install` → `pnpm db:generate` → `pnpm --filter @arcaai/database build` → `--filter @arcaai/domains build` → `--filter @arcaai/applications build` → tests.

### 1.1c `pnpm db:migrate` is broken on `dev-2.1`

The script is `prisma migrate dev --skip-generate`; **Prisma 7 removed `--skip-generate`**, so it exits 1 on the flag. `db:migrate:create` is also unusable because the local dev DB is `db push`-managed with no `_prisma_migrations` ledger.

TASK-658's working recovery, until the script is fixed: generate SQL with `prisma migrate diff --from-migrations` against a throwaway shadow DB (which replays the whole ledger), re-run the diff afterwards to confirm only pre-existing drift remains, sync dev with `db:push`, and inspect in psql. Note that a **pre-existing TASK-648 index-rename drift** shows up in that diff and is not yours.

### 1.2 Completion

- **Commit per ticket** on the ticket branch, then **merge to `dev-2.1` locally**.
- **Do not push. Do not open a merge request.**
- Commit message: `feat(TASK-<n>): <what>` or `refactor(TASK-<n>): <what>`, ending with the repo's `Co-Authored-By` trailer.

### 1.3 Process

1. **First action**: author `docs/implementation/TASK-<n>-<Short-Name>/README.md` from your spec in §3, with the sections required by `.claude/rules/01-development-workflow.md` (Header, Requirement Analysis, Current State Evaluation, Implementation Plan, Implementation Summary, Change History).
2. Follow the 5-phase lifecycle. TDD Red-Green-Refactor — **you must see the test fail first**.
3. Paste **real** gate output into your README. A claim of completion without pasted output is not accepted.
4. Update the parent's §6.1 status when you land.

### 1.4 Universal prohibitions

| Never | Why |
|---|---|
| Run `pnpm gen:mapper` | Destructive — strips the `_version` OCC guard from mappers before crashing |
| Edit a committed migration | Roll forward with a new one |
| Edit `apps/harness/.../workflows.py` `HarnessDocWorkflow` body | ~10 live `workflow.patched` eras + replay fixtures (C2) |
| Edit `src/compat.ts`, `src/compat/**`, the `compat` tsup block, `"./compat"` exports, or `docs/Compat-API-Reference.md` | Owner exclusion |
| Change the **shape or signature** of `src/types/*` (`AgenticConfig`, `Consultation`, `AudioProcessingConstraints`), `src/core/AgenticClient`, `src/core/SSEClient`, `agenticStore` selectors, `useArcaAudio`, `useArcaSession` | Compat is a thin client of these — additive only (README §6.4) |
| Add Ajv or Zod to `packages/agentic-sdk-v2` | **valibot** is already a bundled dependency (`package.json:66`) |
| Hard delete | `repository.softDelete()` |
| Widen `SYSTEM_SHARED_READ_MODELS` to make `DepartmentAgent` cross-tenant readable | Would break tenant isolation platform-wide |

### 1.5 Model tier rationale

| Tier | Used for | Tickets |
|---|---|---|
| **sonnet-5**, effort medium | Multi-file but well-specified changes with a named pattern to follow | 655, 656, 657, 659, 660, 661, 665, 666, 667, 668 |
| **opus-4.8**, effort high | Migration + domain-layer risk, or a new trust boundary | 658, 663 |
| **opus-5**, effort high | Novel durable-execution design; non-deterministic orchestration under clinical safety constraints | 662, 664 |

No ticket is trivial enough for haiku — every one touches multi-file production code in a PHI system.

---

## 2. Waves

```
W0  655 ∥ 656 ∥ 657        prerequisite refactors + independent capability
W1  658                     DB — blocks everything downstream
W2  659 ∥ 660 ∥ 661
W3  662 ∥ 663
W4  664 ∥ 665 ∥ 666 ∥ 667
W5  668
```

Wave N+1 starts only when every ticket in wave N is merged to `dev-2.1`.

---

## 3. Tickets

### TASK-655 — Collapse the four-way live-snapshot resolver

**Wave** W0 · **Tier** sonnet-5 / medium · **Size** S · **Depends on** — · **Type** refactor

**Objective.** One implementation of "find the live SOAP snapshot for this consultation." Four exist. No behaviour change.

**Extend, do not rebuild.** The canonical implementation already exists: `ContextItemRepository.findLatestPreSummaryWithDecryptedContent(consultationId, secrets, { subType })` (`packages/domains/src/repositories/generated/core/ContextItemRepository.encryption.ts:117-132`).

Replace these four with calls to it:

| Copy | Location |
|---|---|
| `findLiveSnapshotRow` | `live-documentation.service.ts:1860-1866` — hand-rolled `findPreSummaries` + filter + reduce |
| `loadLiveSoapSnapshot` | `harness-internal.service.ts:1265-1274` — same, plus a decrypt |
| `resolveWarmStartPreSummary` | `summary.service.ts:1476-1486` |
| `resolveWarmStartPreSummary` | `summary.processor.ts:344-356` — **byte-identical** to the previous |

**Must not change.** Any observable behaviour. `readLiveAgentLineage` (`live-agent-lineage.ts:18-23`) stays the single lineage reader. The `LIVE_SOAP_SNAPSHOT` `subType` contract is unchanged.

**TDD list.** A test proving all four call sites return identical results for: no snapshot; one snapshot; multiple `PRE_SUMMARY` rows where only one carries `subType = LIVE_SOAP_SNAPSHOT`; a snapshot whose decryption fails.

**Gates.** `pnpm --filter @arcaai/domains build test` · `pnpm --filter @arcaai/applications build test` · `pnpm test:unit` · `pnpm lint`.

**Why first.** TASK-662 subscribes to the same event and would otherwise add a fifth copy.

---

### TASK-656 — `mediaId` correctness, both sides

**Wave** W0 · **Tier** sonnet-5 / medium · **Size** S · **Depends on** — · **Type** bugfix

**Objective.** Make `ContextItem.mediaId` mean `Media.id` everywhere. Today two bugs cancel for OCR while silently breaking presigned URLs for every attachment.

**Change together — one commit, or the system stays broken one way:**

| Side | File | Fix |
|---|---|---|
| Producer | `apps/ui-playground/.../context-panel.tsx:101,110` | Destructure `mediaId` (already returned) instead of sending `key` |
| Producer | `apps/ui-playground/.../consultation-recording-panel.tsx:145-146` | Same |
| Producer | `apps/ui-playground/.../use-dual-capture.ts:107-115` | Same, for `rawMediaId`/`processedMediaId` |
| Consumer | `ocr-enrichment.processor.ts:110-119` | Resolve via `mediaRepository.findById(mediaId)` → `parseStorageUri(media.uri)` → `getObject({bucket, key})`, mirroring `smr-proxy.controller.ts:1103-1118` |
| Shared | `context.service.ts:80-89` | Promote private `parseStorageUri` to a shared util; `smr-proxy.controller.ts` has its own copy — collapse both |

**Backfill.** Existing `ATTACHMENT` / `AUDIO_RECORDING` rows whose `mediaId` holds a raw S3 key. Write a script under `packages/database/scripts/` that resolves or creates the matching `Media` row (`uri = s3://<bucket>/<key>`) and rewrites `ContextItem.mediaId`. **Fixing the processor without backfilling breaks OCR for legacy rows** — the script is part of this ticket, not a follow-up.

**TDD list.** Upload → attach → `resolveMediaUrls` returns a presigned URL (fails today). OCR resolves bytes through the `Media` row. Backfill is idempotent. A row whose `mediaId` is already a valid UUID is untouched.

**Gates.** `pnpm --filter @arcaai/applications build test` · `pnpm test:unit` · `pnpm lint`.

---

### TASK-657 — Vision capability

**Wave** W0 · **Tier** sonnet-5 / medium · **Size** M · **Depends on** — · **Type** feature

**Objective.** Make `vision.extract_text` real. Fully independent of the rest of the programme.

**Scope.**
1. `apps/smr/src/smr/models/requests.py:79-102` — add a content-parts union alongside `prompt: str`. **Additive**; `prompt` keeps working.
2. `apps/smr/src/smr/providers/base.py:40-61` — extend the `LLMProvider.generate` contract.
3. Adapters, in ascending order of lift: `bedrock.py:108-120` and `anthropic.py:130-141` (content already list-shaped) → `openai_compat.py:103-108`, `azure_openai.py:104-109`, `openai.py:125-130` (string → parts) → `ollama.py:82-111` (populate the unused `images` key). `llama_cpp.py` stays text-only and must **declare** so.
4. `apps/smr/src/smr/models/provider.py` — `supports_vision` on `ProviderInfo`/`ModelInfo`.
5. `packages/applications/src/services/ai-task-default/constants.ts:26-39` — add `vlm.extract`.
6. Seed at least one `AiModel` with `ModelCategory.VISION` — the enum values already exist (`enums.prisma:84-157`) and no seeded row uses them.

**Fail-closed.** An unresolvable vision model raises. It must **not** silently fall back to OCR — the established posture for provider/model *selection*.

**Must not change.** Any existing text-only call path. Every current SMR request keeps its exact behaviour.

**TDD list.** Text-only request unchanged (regression). Image part reaches each adapter in its native shape. `llama.cpp` rejects an image request with a clear error. Unresolvable vision model raises rather than degrading. `supports_vision` reported correctly per provider.

**Gates.** `pnpm smr:test` · `pnpm smr:lint` · `pnpm smr:typecheck` · `pnpm --filter @arcaai/applications test` · `pnpm --filter @arcaai/database test`.

> **Script names**: `.claude/rules/06-python-services.md` documents a `py:<svc>:<action>` form. **Those scripts do not exist** — TASK-557 renamed every one to `<svc>:<action>`. Verified 2026-08-11 against root `package.json`. The rule file is stale; use the names above.

---

### TASK-658 — Context schema: data model, validation, discovery

**Wave** W1 · **Tier** opus-4.8 / high · **Size** L · **Depends on** — · **Type** feature
**This ticket blocks W2 onward. Nothing else may write a migration until it lands.**

**Objective.** Tenants declare context kinds; clients discover them; the server validates against them.

**Schema** (`packages/database/src/prisma/db_main/`):
- `ConsultationContextSchema` — tenantId, slug, name, description, scope(TENANT|DEPARTMENT), departmentId?, status(DRAFT|PUBLISHED|APPROVED), pinnedVersionNumber?, isDefault, sourceTemplateSlug?, templateLocked
- `ConsultationContextSchemaVersion` — schemaId, versionNumber, `definition Json`, checksum, createdBy, changeReason (immutable)
- `ContextItem` gains `kindKey String?` and `contextSchemaVersionId String?`
- `ContextItemType` gains `STRUCTURED`

**The full checklist — every item is mandatory:**

| Artifact | Path |
|---|---|
| Enum value | `enums.prisma:224-237` |
| Tenant scoping | `TENANT_SCOPED_MODELS`, `packages/database/src/extensions/tenant-scope.ts:52-234` |
| Soft delete | `MODELS_WITHOUT_SOFT_DELETE`, `packages/database/src/client.ts:95-171` (only if no `resourceStatus`) |
| `ResourceType` parity | **BOTH** `audit.prisma:104-242` **and** `packages/domains/src/enums/generated/ResourceType.ts` — guard: `resourceType.enum-parity.test.ts` |
| Repository registration | `core.database.module.ts:112-244` (spread into providers **and** exports) |
| Hand-edited barrels | entities / factories / mappers / repositories `generated/core/index.ts` |
| Migration naming | `pnpm db:migrate:create` → `task_658_<desc>`; the enum change needs `ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'X';` — precedent `migrations/20260719020000_task_516_mcp_server_registry/migration.sql:46` |

Sequence: `pnpm gen:model` → **hand-author** entity/factory/mapper/repository (exemplars `AiTaskDefault*`, `AiProviderConnection*`) → `gen:entity` + `gen:factory` to reconcile barrels.

**Validation hook.** `ContextService.addContext` (`context.service.ts:167`), immediately after the `metadata` merge (`:202-204`) and **before** `encryptContent` (`:208`). `updateContext` (`:265`) calls the same validator. Add `kindKey` and `payload` as declared `@IsOptional()` fields on `AddContextRequest` (`add-context.request.ts:12-53`) — the global pipe strips anything undeclared.

**Discovery endpoint.** A **new sibling controller**, not `/tenant/me/config`. That endpoint returns a flat `{key,value,namespace}[]` of `GlobalSetting` rows and every structured tenant config in this repo already has its own controller (`tenant-stt-config`, `tenant-tts-config`, `tenant-storage-config`). Serve the resolved pinned bundle with a strong `ETag`.

**Schema language.** JSON Schema draft 2020-12 subset. Constrain what a tenant may author: no `if`/`then`/`else` (no clean TS equivalent), `oneOf` only with an explicit discriminator (generators otherwise emit merged property soup).

**TDD list.** Kind with unknown primitive is rejected at publish. Payload validates against the pinned version, not the latest. Cross-tenant schema id returns 404. Additive change does not require a version bump; a rename does. ETag changes only when the served version changes. Existing context writes with no `kindKey` behave exactly as before.

**Gates.** `pnpm db:migrate` + `pnpm db:generate` · `pnpm --filter @arcaai/database build test` · `pnpm --filter @arcaai/domains build test` · `pnpm --filter @arcaai/applications build test` · `pnpm api:build` · `pnpm test:unit` · `pnpm lint`.

---

### TASK-659 — Agent configuration extension

**Wave** W2 · **Tier** sonnet-5 / medium · **Size** M · **Depends on** 658 · **Type** feature

**Objective.** The agent becomes the unit of loop configuration and of promotion.

**Extend `DepartmentAgent`** (`department-agent.prisma`) with: `role` (PRIMARY|SPECIALIST), `subscribedKinds Json?`, `writeScope Json?`, `goal`/instructions (constrained fields, **not** free text — D8), `guardrailProfile`, `alwaysActions Json?`, `neverActions Json?`. Add `DepartmentAgentVersion` (immutable) — promotion needs something immutable to copy, and pin-once needs agent config versioned alongside schema.

**Follow the existing validator pattern exactly.** In `packages/applications/src/services/departmentAgent/constants.ts`, beside `LIVE_TOOL_KEYS` (`:61`), `TENANT_TIER_HARNESS_OVERRIDE_KEYS` (`:16-28`) and `AGENT_LLM_OVERRIDE_TASKS` (`:73`): add a readonly const allow-list per new field and a pure `<field>Problems(value): string[]` that never throws. Then a thin `private validateX()` in `departmentAgent.service.ts` beside `validateToolConfig` (`:535-541`), `validateLlmOverrides` (`:550-564`) and `validateHarnessOverrides` (`:567-575`), wired into both `create` (`:120-123`) and `update` (`:184-190`).

**Cross-check.** `subscribedKinds` and `writeScope` must reference kinds that exist in the agent's resolved schema version (TASK-658).

**Must not change.** `resolveDepartmentAgent` (`prompt-resolution.service.ts:834-882`) selection semantics. The five capability-keyed template bindings. `sessionAgentId` continuity.

**TDD list.** Unknown kind in `subscribedKinds` rejected. `writeScope` naming an undeclared output rejected. A global-admin-only key in `harnessOverrides` still rejected (regression). Config version is immutable once written. Exactly one PRIMARY per department enforced.

**Gates.** database + domains + applications build/test · `pnpm test:unit` · `pnpm lint`.

---

### TASK-660 — Loop event plane

**Wave** W2 · **Tier** sonnet-5 / medium · **Size** M · **Depends on** 658 · **Type** feature

**Objective.** Context events reach the loop; loop output reaches the client.

**Scope.**
1. **Widen the cascade gate.** `LIVE_CONTEXT_TYPES` (`context.service.ts:64`) currently emits `ContextAdded` only for `WORKNOTE`, `CASE_NOTE`, `ATTACHMENT`. Transcripts and derived kinds must emit too. **Both existing consumers change input set** — add an explicit kind filter to `LiveDocumentationService.handleContextAdded` (`:882-902`) and `OcrEnrichmentProcessor.handleContextAdded` (`:85-86`) **before** widening, in that order, so neither starts seeing traffic it was not written for.
2. **New listener** alongside them — `@OnEvent(ConsultationPipelineEvent.ContextAdded)` on a new service that signals the loop. No controller or route change (this is exactly how `OcrEnrichmentProcessor` was added).
3. **New signal methods** on `HarnessGatewayService` (`harness-gateway.service.ts`) — copy `signalEdit` (`:188-201`) verbatim, swapping URL suffix and payload interface.
4. **New SSE stream** `consultation:loop:{id}` following the trajectory exemplar: publisher service with its own channel prefix (cf. `agent-trajectory.service.ts:68,339-356`), a `HarnessInternalController` POST (`@HttpCode(200)` for best-effort, `Idempotency-Key` for durable), a `ConsultationController` `@Sse()` route with `@TenantOwnedResource` + `@StreamScope` and a merged heartbeat (`consultation.controller.ts:566-608,177,589`), and a response DTO.

**Must not change.** LiveDoc's flush/throttle/supersede internals. The existing three SSE streams.

**TDD list.** Widening emits for transcripts. LiveDoc ignores kinds outside its filter (regression). OCR ignores non-attachments (regression). Loop signal is idempotent under duplicate emission. SSE relays and heartbeats. Cross-tenant consultation id returns 404.

**Gates.** applications build/test · `pnpm api:build` · `pnpm test:unit` · `pnpm lint`.

---

### TASK-661 — Schema compatibility and lifecycle

**Wave** W2 · **Tier** sonnet-5 / medium · **Size** M · **Depends on** 658 · **Type** feature

**Objective.** Once tenants version a schema, you own an API-versioning problem. Close it deliberately.

**Scope.** Additive-only enforcement (refuse to publish a breaking change without a version bump — borrow Confluent's `BACKWARD` vocabulary); schema version carried in a request header on every write so the server validates against what the client built against; deprecation signalling; a years-old `ContextItem` remains readable after its schema version is superseded; and **K7 — every existing consultation keeps working with no schema configured**, as a tested contract rather than an implementation detail.

**TDD list.** Adding an optional field does not bump. Renaming refuses without a bump. A write carrying an old version header validates against that version. A superseded version is still readable. A tenant with no schema behaves exactly as today, end to end.

**Gates.** applications build/test · `pnpm api:build` · `pnpm test:unit` · `pnpm lint`.

---

### TASK-662 — `ConsultationLoopWorkflow` (mechanical loop)

**Wave** W3 · **Tier** **opus-5** / high · **Size** L · **Depends on** 658, 659, 660 · **Type** feature

**Objective.** The durable per-consultation orchestrator — **deterministic subscriptions only**. Reasoning lands in TASK-664.

**Scope.**
- New workflow type in `apps/harness/src/harness/temporal/workflows.py`, id `consultation-loop-{consultationId}`, idempotent-on-start. **A new type needs no `workflow.patched` era** — that is why this is a new workflow rather than an edit.
- `fetch_loop_config` activity pins `(contextSchemaVersionId, agentConfigVersionId)` at start. Never re-read mid-run (C1).
- Signals `contextAdded`, `consultationEnding`, `cancel`; query `state()`.
- **Action registry** including `livedoc.start` / `livedoc.stop` → `LiveDocumentationService.start/stop` as **activities**. LiveDoc internals untouched (README §4.4).
- `harness.finalize` starts `HarnessDocWorkflow` as an **unmodified child** with an explicit `ParentClosePolicy` (default `ABANDON` would orphan it).
- Planned `continue_as_new` checkpoints (51,200-event / 50MB ceiling); `ClaimCheckRef` for payloads (>2MB soft-errors).
- **Signal safety**: serialise handler access (`asyncio.Lock`), use `@workflow.init` for the signal-with-start race, and never call an activity from a signal handler — update state and let the main coroutine react.
- Register in `worker.py:243-254` (`workflows=[...]`, `activities=[...]`).
- New replay fixture: capture via `_capture_replay_fixture.py`, assert in `test_replay_compat.py`.

**Must not change.** `HarnessDocWorkflow`'s body. `LiveDocumentationService`'s internals. The `LIVE_SOAP_SNAPSHOT` + lineage seam — `harness.finalize` picks up the live note through the existing `{pre_summary_text}` path with no change.

**TDD list.** Config pinned at start; a mid-run edit does not affect the run. Duplicate `contextAdded` is idempotent. Cascade terminates at the depth cap. Budget exhaustion degrades rather than aborts. `continue_as_new` preserves state. Cancel stops children. **Existing `HarnessDocWorkflow` replay fixtures still pass unchanged.** New fixture replays.

**Gates.** `pnpm harness:test` including the `-k replay` subset · `pnpm harness:lint` · `pnpm harness:typecheck` · applications/api gates for the gateway side. (Not `py:harness:*` — those scripts do not exist; see the note under TASK-657.)

---

### TASK-663 — Agent promotion between tenants

**Wave** W3 · **Tier** opus-4.8 / high · **Size** L · **Depends on** 659 · **Type** feature

**Objective.** An admin who manages two tenants promotes an agent version from one to the other. **12 of 13 stories here have nothing behind them** — this is the largest net-new surface in the programme.

**Scope.**
- `AgentPromotion` model — fromTenantId, toTenantId, agentVersionId, evalRunId?, actor, timestamp. Immutable.
- Authorization: the actor holds **manage rights on both tenants**. There is no environment or family concept (D10), so this check is the entire control.
- Copy semantics: the exact immutable version, never re-authored in the target — mirroring the repo's own `promote-*` CI jobs, which re-tag a digest rather than rebuild.
- Lineage on the target; drift detection afterwards.
- **Eval re-runs at the target tenant.** The source `EvalRun` travels as an attestation; the corpus never moves. `GoldenCase` holds Vault-Transit-encrypted PHI and no code path moves it across tenants today — do not create one.
- Blocked when the target lacks a context kind the agent subscribes to.
- Alert, don't block, when the target has live consultations: *"N consultations are currently running on the previous version and will complete on it."*
- Runs under an elevated tenant-less context, exactly as `AgentTemplateResyncService` does — **do not** add `DepartmentAgent` to `SYSTEM_SHARED_READ_MODELS`.

**TDD list.** Promotion without manage rights on both tenants → 403. Cross-tenant read outside a promotion → 404 (posture regression). Target missing a subscribed kind → blocked with a named reason. Eval runs against the target's corpus. No `GoldenCase` row crosses a tenant. Promotion record is immutable. Live consultations on the target are unaffected.

**Gates.** database/domains/applications build+test · `pnpm api:build` · `pnpm test:e2e` cross-tenant specs · `pnpm lint`.

---

### TASK-664 — Reasoning primary and specialists

**Wave** W4 · **Tier** **opus-5** / high · **Size** L · **Depends on** 662 · **Type** feature

**Objective.** The deliberative lane, layered on the mechanical loop.

**Scope.**
- LLM planner as a Temporal **activity** so the decision is recorded and replays (C1, D3).
- Replanning at **checkpoints**, not per event — an intermediate frequency beats per-step (*Learning When to Plan*).
- Specialists as **child workflows** — own history budget, own failure isolation. Explicit `ParentClosePolicy`.
- Scoped reads (subscribed kinds only) and enforced `writeScope`.
- Adjudication by the primary, **inspectable**: one reconciled note carrying which view was taken and on what basis (E12). Clinician finalises.
- Depth counter, per-consultation budget, `(agent, kind)` cycle detection.
- Reasoning placement: planning and verification, **never the note-generation call** (arXiv 2605.24902 — judge score 4.10 → 3.28 with reasoning on SOAP generation).

**Prerequisite measurement, in this ticket, before the primary ships.** `entity_faithfulness` and `coverage_omission` are lexical. Adjudication *is* clinical inference, and lexical evaluation reports ~35% hallucination where inference-aware evaluation gives ~9% (arXiv 2604.14829). Quantify how much a correct adjudication is penalised, and record the number in the README. If it is material, raise it as its own ticket rather than loosening thresholds.

**TDD list.** Planner decision replays from history without re-invoking the model. Specialist cannot write outside `writeScope`. Specialist failure degrades the run. Contradictory findings surface rather than merge silently. Cycle detection terminates. Budget cuts off a runaway specialist without harming the run. Primary remains the only writer of the note and gate.

**Gates.** `pnpm harness:test` including `-k replay` · py lint/typecheck · applications/api gates.

---

### TASK-665 — SDK: discovery, validated context, event hook

**Wave** W4 · **Tier** sonnet-5 / medium · **Size** M · **Depends on** 658, 662 · **Type** feature

**Objective.** The client discovers the schema and builds against it — additively.

**Scope.**
- `useConsultationSchema()` — fetch at `AgenticProvider` mount, cached in a ref exactly as `ModelRegistry.loadTenantConfig` is (`AgenticProvider.tsx:472-490`), awaited in `init()` before `setConfigReady(true)`. **Replicate in the tenant-switch block too** (`:758-879`) or a working-tenant switch leaves it stale.
- Session pins the schema version; handle version skew.
- `AddContextInput` (`src/types/context.ts:129-138`) gains **optional** `mediaId`, `kindKey`, `payload`. Mirror onto `ContextItem` (`:16-48`). Add `SIGNED_NOTE` to the type union (currently missing). Keep `src/types/consultation.ts:202,238` in sync — it re-declares rather than imports.
- `StorageFile` (`useStorage.ts:21-27`) gains `mediaId?: string`; `addAttachment` accepts and forwards it.
- `useConsultationEvents()` — copy `useArcaLiveSummary` (`src/hooks/useArcaLiveSummary.ts`), the leaner exemplar: `useApiOperation`, teardown-before-restart, `new SSEClient(scope, apiClient, logger)`, connect against `getStreamBaseUrl()`.
- Client-side validation with **valibot** (already bundled).

**Known limitation to document, not silently inherit.** `SSEClient` has **no** `Last-Event-Id` resume — reconnect mints a fresh ticket and opens a new `EventSource` with no cursor. State this in the hook's doc comment.

**Must not change.** Anything in §1.4's additive-only list. **Verification step: `apps/compat-playground` must build.**

**TDD list.** Unknown kind is ignored, not fatal. Payload validated client-side before send. Session keeps its pinned version when the tenant publishes a new one. `mediaId` threads from upload to attachment. Compat build passes.

**Gates.** `pnpm --filter @arcaai/vox build test lint typecheck` · a build of `apps/compat-playground`.

---

### TASK-666 — Admin console: context schema editor

**Wave** W4 · **Tier** sonnet-5 / medium · **Size** M · **Depends on** 658 · **Type** feature

**Objective.** The first schema builder in the product.

**Scaffolding — copy the Agent Catalog screen wholesale.** `apps/admin-console/src/app/(console)/(tenant)/agents/page.tsx` → `features/agents/components/agents-screen.tsx` + `agent-detail-drawer.tsx`. It is the only single-resource tenant screen that already has a form, pin/version controls (`agent-detail-drawer.tsx:401-462`) and OCC `If-Match` (`features/agents/api/client.ts:54-60`, `getWithEtag`/`patchWithEtag`/`versionFromEtag`) in one place.

Required files: route under `(console)/(tenant)/<slug>/page.tsx`; nav entry in `shared/navigation/nav-config.ts` `NAV_ENTRIES` with `tier: '30-49'`; `ScreenTemplate` from `@/shared/page/screen-template`; per-feature `api/keys.ts` + `api/hooks.ts` + `api/client.ts`; calls through the BFF catch-all `app/api/hope/[...path]/route.ts` via `shared/api/http.ts`.

**Screen.** Kind editor (key, label, primitive, PHI class, cardinality, lifecycle, producedBy, field builder, constraints); output-kind editor; version history with pin / track-latest; department default; publish validation surfacing the server's rejection reasons; a sample-payload tester.

**TDD list + gates.** Colocated Vitest in `__tests__`; axe scan 0 violations; both themes; `pnpm --filter @arcaai/admin-console build lint test`.

---

### TASK-667 — Admin console: agent configuration form

**Wave** W4 · **Tier** sonnet-5 / medium · **Size** M · **Depends on** 659 · **Type** feature

**Objective.** Constrained goal / tool / guardrail authoring (D8) — **not** a rule builder, and **not** a free-text prompt box.

**Scope.** Extend the existing Agent Catalog screen rather than creating a new one: role (primary/specialist), subscribed kinds with optional filter, write scope, goal via constrained fields, tool allowlist, guardrail profile selection, `always` / `never`. Budgets are global-admin-tier and render disabled for a tenant admin, following the `TENANT_LOCKED_POLICY_KEYS` precedent (`harness-policy/components/policy-fields.ts:45-54`).

**Include C25** — disabling a clinical check requires an explicit typed acknowledgement. A speed bump with a record, not a blocker.

**TDD list + gates.** As TASK-666, plus: a tenant admin cannot set a global-only field; the acknowledgement is required and recorded.

---

### TASK-668 — SDK codegen CLI

**Wave** W5 · **Tier** sonnet-5 / medium · **Size** M · **Depends on** 665 · **Type** feature

**Objective.** `npx @arcaai/vox codegen --tenant <id>` emits TypeScript types from a tenant's schema. An accessory to runtime discovery, never a replacement.

**Placement decision to make and record.** `packages/agentic-sdk-v2` has no `bin` field and every tsup entry is `platform: 'browser'`. Either add a Node entry that overrides `sharedOptions`, or put the generator in its own workspace package — which matches the repo's existing `packages/tools` generator convention. Recommend the latter; state the choice in the README.

Add a root script under the `<target>:<action>` taxonomy. Support `--watch` for the dev loop.

**Gates.** Package build/test/lint · generated types compile against a fixture schema.

---

## 4. Cross-cutting acceptance

Before the programme is called done:

- [ ] Every existing consultation works with no schema and no loop policy configured (K7) — an explicit e2e test, not an assumption
- [ ] `HarnessDocWorkflow` replay fixtures pass unchanged
- [ ] `apps/compat-playground` builds
- [ ] No new `databaseService.client` lint warnings in `packages/*`
- [ ] Cross-tenant e2e coverage for every new admin surface (404, not 403)
- [ ] `pnpm verify` green
