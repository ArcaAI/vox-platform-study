# TASK-553 — Exploration Report 2: Agent / Instruction / Context Control Plane

Produced by the TASK-553 exploration pass on 2026-07-24. Scope: management plane only
(Prisma → domains → applications → apps/api → admin-console). All claims anchored to
file:line in the working tree (branch `fix/2605-review`).

---

## 1. DATA MODEL

| Model | File | Key fields | Tenant scoping | OCC (`_version`)? | Relations |
|---|---|---|---|---|---|
| **DepartmentAgent** (the first-class "agent") | `packages/database/src/prisma/db_main/department-agent.prisma:22-74` | `departmentId` FK, `promptTemplateId` FK, `pinnedVersionNumber Int?` (null⇒track latest APPROVED), `dnaStylePolicy` enum, `harnessOverrides Json?`, `goldenSetId?`, `isDefault Boolean`, `sourceAgentTemplateSlug?`, `templateLocked Boolean`, unique `(tenantId,departmentId,slug)` | tenant-scoped, soft delete | **Yes** | → `Department`, → `PromptTemplate` |
| **PromptTemplate** | `prompt-template.prisma:34-102` | `status` DRAFT→PUBLISHED→APPROVED (`:23-32`), `scope` TENANT_DEFAULT\|DEPARTMENT_DEFAULT\|USER_PERSONAL (`:15-21`), `currentVersionNumber`, `departmentId?`, `ownerUserId?`, unique `(tenantId,name)` + `(tenantId,departmentId,ownerUserId,name)` | tenant-scoped | **Yes** | → `PromptVersion[]`, → `DepartmentAgent[]` |
| **PromptVersion** | same file `:104-134` | `versionNumber`, `content` (immutable snapshot), `variables`, `changeReason`, `changedBy`, unique `(promptTemplateId,versionNumber)` | tenant-stamped, no independent status | append-only, no `_version` | → `PromptTemplate` |
| **HarnessPolicy** | `harness.prisma:314-387` | 5 sensor thresholds, `maxRegen`, gate SLA/escalation, `toolAllowlist`, safety/PHI/judge/routing knobs, agentic-loop knobs, `mcpToolsEnabled`; unique `(tenantId)` — SYSTEM row = global default | tenant-scoped | **Yes** | none |
| **HarnessPolicyChange** | `:389-423` | before/after JSON, `changedBy`, `policyVersion` | tenant-scoped | none — **WORM** | — |
| **GoldenSet** | `:43-80` | `pinnedVersion?`, `departmentId?` (TASK-549) | tenant-scoped | **Yes** | → `GoldenCase[]`, → `EvalRun[]` |
| **GoldenCase** | `:82-119` | `encryptedTranscript/encryptedReferenceNote` (Vault-Transit) | tenant-scoped | **Yes** | → `GoldenSet` |
| **EvalRun** | `:121-178` | `modelName/modelVersion`, `promptTemplateId?`, `promptVersion?`, `promptVersionNumber?`, `triggerType?` (MANUAL\|PROMOTION\|CI), `status`, `aggregateScores`, `encryptedNotes` | tenant-scoped | **Yes** | → `GoldenSet`, → `EvalScore[]` |
| **EvalScore** | `:180-221` | `metric/score/maxScore/judgeModel`, encrypted rationale/details | tenant-scoped | **Yes** | → `EvalRun`, → `GoldenCase` |
| **HarnessAuditEvent** | `:227-291` | `action` enum, `prevHash/hash` chain, encrypted sensor scores/citations, `contextItemVersionId?` | tenant-scoped | none — **append-only WORM, hash-chained** | — |
| **GateEditExemplar** | `:440-488` | `consultationId`, `departmentId?`, `visitType?`, `gateDecision/qualitySignal`, `editDistance*`, `redactedBefore/redactedAfter` (PHI-redacted at write), provenance ids | tenant-scoped | **Yes** | soft-delete **exempt** |
| **PipelinePolicy** | `pipeline-policy.prisma:28-70` | `scope` TENANT\|DEPARTMENT\|DOCTOR + `scopeId`, `autoSummaryEnabled/autoNerEnabled/harnessEnabled/dnaStyleEnabled/dnaRedactionEnabled` (nullable cascade), unique `(tenantId,scope,scopeId)` | tenant-scoped, SYSTEM row = default | **Yes** | — |
| **AiTaskDefault** | `ai-task-default.prisma:21-51` | `taskKey` (`nlp.ner`, `smr.live`, `smr.finalize`, `harness.judge`), `modelSlug`, unique `(tenantId,taskKey)`; ALL prefixes GLOBAL-ADMIN-ONLY writes | tenant row **ignored at resolution** — only SYSTEM consumed | **Yes** | — |
| **McpServer** | `mcp-server.prisma:31-79` | `baseUrl`, `authRef` (Vault path only), `toolAllowlist`, `phiBoundary` default `"external"`, `enabled` default `false` | SYSTEM rows + `SYSTEM_SHARED_READ_MODELS` | **Yes** | — |
| **AgentTrajectoryStep** | `agent-trajectory.prisma:62-120` | `sessionKind`, `stepType`, `stats`/`payloadRef` (claim-check refs only), unique `(tenantId,sessionId,runId,seq)` | tenant-scoped | **Yes**, no soft delete (retention-pruned) | — |
| **DnaWritingStyleReport / Version** | `dna-writing-style.prisma:6-96` | `encryptedStyleText/encryptedReportData`, TASK-551 `encryptedRedactionRules Bytes?`, `isLatest`, `currentVersionNumber` | tenant-scoped | **Yes** | → Versions |
| **ContextItem** | `consultation.prisma:73-159` | `type` enum (…TRANSCRIPT/CASE_NOTE/ATTACHMENT/SIGNED_NOTE…), `source`, `encryptedContent`, `currentVersionNumber`, loose refs | tenant-scoped | **Yes** | → Consultation, ContextItemVersion[], SummaryMeta?, NamedEntity[], TranscriptSegment[] |
| **SummaryMeta** | `:220-320` | provenance arrays, `promptResolvedFrom/resolvedPromptId`, sensor scores, `gateDecision`, TASK-551 `redactionApplied?` + `encryptedRedactionManifest?` | tenant-scoped | **none — no OCC** *(historical: F-11 added `_version` in Wave 2)* | 1:1 → ContextItem |
| **Highlight** | `:492-551` | W3C dual selector, `targetKind`, `sourceContextItemId?` | tenant-scoped | **Yes** | → Consultation |
| **TranscriptSegment** | `:575-621` | `idx`, `t0Ms/t1Ms`, `speaker`, `charStart/charEnd` (offsets only) | tenant-scoped | **Yes**, no soft delete | → ContextItem |

---

## 2. INSTRUCTION LIFECYCLE

**States**: `DRAFT → PUBLISHED → APPROVED` (`prompt-template.prisma:23-32`). Only `APPROVED` templates resolve for clinical generation (`prompt-resolution.service.ts:236,347,367`).

**Versions**: every create/update/approve snapshots a `PromptVersion` inside the SAME transaction as the OCC compare-and-set (`prompt-management.service.ts:390-406` update, `:482-495` approve). `PromptVersion` has **no per-snapshot approval-status column** — documented schema gap (`TASK-546/README.md:152-153`), load-bearing (see §7).

**Approval / OD-3 split gate** (`prompt-management.service.ts:445-503`, `:1094-1106`):
- SYSTEM/library template → global-admin-only (403, existence NOT hidden).
- Tenant-owned → `manage:PromptTemplate` OR global admin; cross-tenant id → 404 first.
- Approving is idempotent (`:452-454`), pins a `PromptVersion` snapshot (`:482-495`), and — when bound agent(s) carry `goldenSetId` — runs **eval-gated promotion** BEFORE flipping status (`:461-476`).

**Eval-gated promotion** (TASK-549):
- `EvalPromotionGateService.evaluatePromotion` (`eval-promotion-gate.service.ts:60-119`): mode = `agentic.eval.promotionGate` (`block`|`warn`|`off`; fail-safe defaults to `block` on resolver outage, `:121-132`). No golden set ⇒ proceeds with warning, never blocked (`:83-88`).
- `EvalRunService.runGoldenSet` (`eval-run.service.ts:68-184`): golden set 404-over-403, decrypts GoldenCases, POSTs harness `POST /api/v1/internal/eval/run` via `HarnessGatewayService.runEval` (`harness-gateway.service.ts:201-212`), persists EvalRun+EvalScore, sys-event.
- Triggered from exactly TWO call sites: `approveTemplate` (`:461`) and `DepartmentAgentService.pin` (`departmentAgent.service.ts:272-289`). **Not triggered by `updatePromptTemplate`** — see §7.2.
- Runtime-proven live 2026-07-23 (TASK-549 README): failing set → 409 `EVAL_GATE_FAILED`; passing → 200 APPROVED.

**Version pinning / movable pointer**: `DepartmentAgent.pinnedVersionNumber` — null ⇒ track latest APPROVED, else pin exact version (`department-agent.prisma:41`). Write-side enforced in `DepartmentAgentService.pin` (`departmentAgent.service.ts:246-300`) + `assertPinnedVersionApproved` (`:474-484`). Read-side resolved in `PromptResolutionService.resolveDepartmentAgent` (`prompt-resolution.service.ts:301-330`) reading immutable `PromptVersion.content`.

**⚠️ Can a running consultation pin the version it started with? — NO, in practice.** `resolve()` returns pinned `PromptVersion.content` on `ResolvedPromptConfig.content` (`:61-73,284-288`), but the ONLY consumer, `PromptAssemblyService.assemble()`, **never reads `resolved.content`** — it re-fetches the template by id and uses the current mutable row (`prompt-assembly.service.ts:323-331`, line 331). Pinning is **inert for actual generation** — flagship defect §7.1.

**Rollback**: `activateVersion` is **rollback-by-copy** (old content becomes NEW latest version), not a true pin. The DepartmentAgent pin is the only real freeze — undermined by §7.1.

**RBAC** (`seed/01-policy.ts`):
- Tenant admin: `manage:PromptTemplate` (`:367`), `manage:DepartmentAgent` (`:121`), `manage:HarnessEval` (`:154`), `manage:PipelinePolicy` (`:161`), `manage:HarnessPolicy` tenant-tier (`:151`).
- Clinician: read-only PromptTemplate (`:386`) + own-only USER_PERSONAL self-service (`prompt-management.service.ts:1126-1145`) + `setPreferredPromptTemplate` (`:941-954`).
- Global admin: everything + SYSTEM template approval + `GLOBAL_ADMIN_ONLY_POLICY_KEYS` + all AiTaskDefault prefixes.

**Resync from SYSTEM golden library** (TASK-548): `AgentTemplateResyncService` (`agent-template-resync.service.ts`) — add-missing-locked, fast-forward-pristine-locked, never-touch-unlocked, skip-drifted. Cron (settings-gated, `0 4 * * *`) + `POST admin/department-agents/resync` (`@CanManage('Tenant')`). Runtime-proven 2026-07-23.

---

## 3. DEPARTMENT ↔ AGENT BINDING

- One row per `(tenantId,departmentId,slug)`; `isDefault` flipped atomically by `DepartmentAgentRepository.setDefaultForDepartment` (`DepartmentAgentRepository.ts:82-95`, single transaction).
- **Selection**: `PromptResolutionService.resolve()` (`prompt-resolution.service.ts:147-291`), 4-tier fallback, evaluated fresh on EVERY call (no caching, no consultation-start pin):
  1. Tier-0 doctor `preferredPromptTemplateId`, APPROVED-gated (`:342-357`).
  2. Tier-1a department default `DepartmentAgent` → PromptVersion at `pinnedVersionNumber ?? latest APPROVED` (`:301-330`).
  3. Legacy `Department.{preSummaryPromptId|newPatientPromptId|revisitPromptId}` loose refs, APPROVED-gated (`:213-243`).
  4. Hardcoded `SYSTEM_DEFAULTS` CATCHALL_SOAP (`:118-121`).
- **New-visit vs re-visit**: `consultation?.parentConsultationId ? 'revisit' : 'new-patient'` (`harness-internal.service.ts:422`) — the ONLY switch, lives in the gateway app service.
- Both runtime paths (harness `HarnessInternalService.assemble` + legacy `SummaryService`) share `PromptAssemblyService.assemble()` → one resolution implementation.
- **DNA gate per-agent**: `DepartmentAgent.dnaStylePolicy` (`INHERIT`|`DISABLED`) read in `ConsultationEventHandler.resolveRedactionRulesForHarness` (`consultation-event.handler.ts:534-547`) and `HarnessInternalService.resolveEffectiveDnaStyleId` — forces department OFF regardless of doctor opt-in.
- **Harness overrides**: `DepartmentAgent.harnessOverrides` layered at `HarnessPolicyService.applyAgentOverrides` (`harness-policy.service.ts:429-462`), keyed off `consultation.departmentId → findDefaultForDepartment`.

---

## 4. RUNTIME HANDOFF (apps/harness ↔ apps/api)

All HTTP, `X-Service-Token` (`HarnessServiceTokenGuard`).

**Outbound (gateway → harness)** — `HarnessGatewayService`:
- `start()` (`:141-161`) → `POST /internal/consultations/:id/document:start` — `redactionRules` omitted when empty (body byte-identical pre/post-TASK-551, `:150-152`).
- `signalApproval()`/`signalEdit()` (`:167-193`) — best-effort.
- `runEval()` (`:201-212`) — synchronous eval (TASK-549).

**Inbound (harness → gateway)** — `HarnessInternalController` (`harness-internal.controller.ts`), `@Public()` + service-token, `/internal/harness/*`:
- `GET policy` (`:184-213`) — `fetch_policy` endpoint; optional `consultationId` overlays agent `harnessOverrides` (TASK-550). CLS re-established per-request (`:209-212`) — the documented "S-3 recurrence class."
- `GET mcp-token` (`:230-238`) — Vault-path resolution; secret never enters Temporal history.
- `POST/GET consultations/:id/entities` (`:244-264`) — NamedEntity persist/read.
- `POST consultations/:id/assemble` (`:266-271`) → prompt assembly; returns `{userPrompt, systemPrompt, hyperparameters, responseFormat, promptTemplateId, promptVersion, resolvedFrom, segmentCitations}`.
- `POST consultations/:id/draft` (`:273-278`) — two-phase persist (EARLY `DRAFT_PENDING_SENSORS` / FINALIZE), Idempotency-Key header.
- `POST gate-decision`, `escalation`, `assurance` (`:280-311`) — WORM audit + optimistic finalize.
- `POST assurance-event`, `progress` (`:302-342`) — best-effort Redis-pubsub live feeds.
- `POST trajectory` (`:355-393`) — batch AgentTrajectoryStep ingest, idempotent on `(tenantId,sessionId,runId,seq)`, 202.

**Caching/TTL**: every fetch is live, per-call, **no cache** — `getEffectivePolicy` does 6-7 DB reads on every `fetch_policy` call (`harness-policy.service.ts:355-462`). TASK-550 measured ~60ms fleet-wide convergence for a policy edit.

**Instructions changing mid-consultation**: resolution is uncached and re-run per activity call — no "frozen at start" semantics for policy or (nominally) prompt content. The prompt-content side is moot given §7.1 (content is always "live" regardless of intent).

---

## 5. CONTEXT INJECTION

**Models**: `ContextItem` + `ContextItemVersion` (append-only) + `NamedEntity` + `Highlight` + `TranscriptSegment`.

**Writes** — `ContextService` (`context.service.ts`):
- `addContext()` (`:147-236`) — WORKNOTE/CASE_NOTE/ATTACHMENT etc. Validates only presence of `content` for non-media (`:163-166`); encrypts (`:188`); v1 ContextItemVersion (`:194-200`); `ContextAdded` event for human-authored types (`:215-233`; 2000-char cap is for the live SSE preview ONLY, not the persisted content or the prompt).
- `updateContext()` (`:245-310`) — new ContextItemVersion per edit.
- `addRawSummary()` (`:443-522`) — validates every `caseNoteIds/preSummaryIds/previousSummaryIds` in-tenant at write (`:457-459`).
- `addNamedEntities()` (`:539-592`); highlights via `highlight.service.ts`.

**Reaching the LLM prompt**: `HarnessInternalService.assemble()` (`:342-458`) folds all into labeled blocks — `[case note]`/`[work note]` (`:371-374`), attachments prefer `metaData.extractedText` (`:375-384`), `[highlight]` (`:391-392`). No transformation other than the label prefix.

**Size limits — NONE**:
- `AddContextRequest.content` (`add-context.request.ts:13-16`) — no `@MaxLength`.
- `CreateHighlightRequest.exact/note` — no `@MaxLength`.
- `AddContextRequest.metadata` (`:42-44`) — `@IsObject()` only; `extractedText` rides here, unbounded, verbatim into `assemble()` (`:381`).
- `CreatePromptTemplateRequest.content` (`create-prompt-template.request.ts:16-18`) — no `@MaxLength` (name/description DO have one).

**Sanitization — nobody, for tenant/doctor-authored content.** Guardrail screens AI-generated output only (harness assurance pass); never invoked on CASE_NOTE/WORKNOTE/ATTACHMENT/Highlight ingestion, nor on PromptTemplate.content at create/update. Concrete prompt-injection surface — §7.3.

**Cross-tenant on read** (good pattern): `assertParentInScope` gates every write (`:160,253,329,374,456,551,802`); `resolveLinkedConsultationIds` re-filters chain ids to CLS tenant as defense-in-depth (`:1212-1245`).

---

## 6. TICKET DRIFT (docs vs code)

1. **Version pinning documented as delivered but inert at generation time** (not caught by any ticket). TASK-546 README claims reading `PromptVersion.content` "is what makes version pinning meaningful" — true of `PromptResolutionService` in isolation; `PromptAssemblyService.assemble()` discards `resolved.content` (`prompt-assembly.service.ts:331`). No suite exercises the composition — unit tests validated the two services independently.
2. **TASK-548 "Parts 1-3 deferred" → later completed by a different concurrent session** (TASK-544 §7 Run-2 verdict) — violating the ticket's own one-session-per-tree contract; repeated for TASK-551 cycle 4. Docs are honest; code authorship doesn't match any single ticket's Change History — re-verify current state rather than trust line-level claims.
3. **TASK-551 records its own mid-flight drift**: harness proven live to "compute then discard" the RedactionManifest (README `RUNTIME-FINISH` :365-375); fixed in cycles 4/5 — current code matches the LATEST README entries, not mid-document ones. Read the bottom of that README.
4. **TASK-552 Lane B "smr.live activation" was already fixed upstream** (commit `c6c44de2f`, 2026-07-21) before the ticket was authored; only the `metadata.stats.task_key` provenance stamp was net-new.
5. **TASK-544 §2.3 "no first-class agent entity" / "no redaction concept"** — true at review time (2026-07-22), now stale.
6. **Console naming rollout deliberately partial** (TASK-547): sidebar "Agents", `/playground/llm` "Agent Playground" — documented scope decisions, don't "fix."
7. **`SYSTEM_SHARED_READ_MODELS` widening explicitly rejected** for Department/PromptTemplate/DepartmentAgent (TASK-548) — no tenant-facing "browse platform Agent Library" surface exists, contrary to TASK-544 §5.1's "Library" language.
8. **`fable-thinking` skill mandated by every Execution Contract never actually available** (~10 sessions, every README records `Unknown skill`) — mandatory process gate silently never ran; unresolved owner-tail item.
9. **Runtime/browser verification gaps disclosed but easy to miss**: TASK-549 console visual pass skipped (credential-entry policy); TASK-552 Lane C next-dev-loop deferred; TASK-550 proof 3b needed worker restart. Treat every "Review" status as gate-verified at unit/integration level, NOT browser/e2e-verified.

---

## 7. DEFECTS & GAPS

### 7.1 — [CRITICAL] Version pinning is inert in the actual generation path
`PromptResolutionService.resolveDepartmentAgent()` resolves pinned/latest-APPROVED `PromptVersion.content` (`prompt-resolution.service.ts:301-330`, surfaced at `:67`). But `PromptAssemblyService.assemble()` — the SOLE consumer, shared by harness (`harness-internal.service.ts:416-433`) and legacy (`summary.service.ts:188,320`) paths — ignores `resolved.content`:
```
prompt-assembly.service.ts:324  const resolved = await this.promptResolutionService.resolve({...});
prompt-assembly.service.ts:331  const template = resolved.promptId ? await this.promptTemplateRepository.findById(resolved.promptId) : null;
                                // ^ re-fetches the MUTABLE row; template.content, not resolved.content, feeds the prompt
```
**Impact**: pin v3, colleague edits to v7 → every consultation generates against v7. The "movable pointer" governance story is implemented at DB/service layer but never consumed. No test exercises the composition.

### 7.2 — [CRITICAL] Eval-gated promotion bypassable via plain template update
`updatePromptTemplate` (`prompt-management.service.ts:334-418`) lets `manage:PromptTemplate` edit `content` on an ALREADY-APPROVED template (no status check on the content-edit branch, `:343-353`), creating a new PromptVersion that instantly becomes "latest" (`PromptVersionRepository.findLatestVersion`, unconditional ORDER BY versionNumber DESC — no per-version approval marker in schema). Any unpinned agent (default mode) picks up the new content next consultation with **neither** the eval gate (only wired into `approveTemplate` + `pin`) **nor** re-approval running. OD-3 "mandatory eval gate on promotion" trivially bypassed by editing content without touching status.

### 7.3 — [HIGH] Prompt-injection surface: zero screening on tenant/doctor-authored inputs
- `PromptTemplate.content`: no `@MaxLength`, no validation, no Guardrail at create/update (`create-prompt-template.request.ts:16-18`, `update-prompt-template.request.ts:18-21`).
- `ContextItem.content` (CASE_NOTE/WORKNOTE/ATTACHMENT) + `Highlight.exact/note`: no `@MaxLength`, folded verbatim into the prompt (`harness-internal.service.ts:371-392`) with only a label prefix. `metaData.extractedText` unbounded (`:381`). Guardrail invoked ONLY on generated output.

### 7.4 — [PERF] Missing composite index on hottest lookup
`DepartmentAgent` indexes: `[tenantId]`, `[departmentId]`, `[promptTemplateId]`, unique `(tenantId,departmentId,slug)` (`department-agent.prisma:69-73`). `findDefaultForDepartment` filters `(tenantId, departmentId, isDefault: true, resourceStatus: ENABLED)` (`DepartmentAgentRepository.ts:62-70`) — called on every prompt resolution (`prompt-resolution.service.ts:306`), every `getEffectivePolicy` with consultationId (`harness-policy.service.ts:439`), every harness start (`consultation-event.handler.ts:537`). No covering index.

### 7.5 — [DEAD KNOB] `claimCheck.minBytes` governs nothing
Resolved/stored (`live-documentation.service.ts:1507,1529`), echoed in stats (`:2042`), never used to branch — grep-confirmed. Matches TASK-544 F-008 residue.

### 7.6 — [PERF] N+1 / unbounded in-memory pagination on context reads
- `getContextItemsPaginated` (`context.service.ts:974-1003`) fetches ALL rows then slices in memory (`:975-984`).
- `fetchConsultationsWithRelations` (`:1252-1261`) sequential per-id `findWithRelations` in a for loop; called from `getAggregateNamedEntities` (`:680`) which iterates ids calling `findSummaries`/`findTranscripts` per id (`:687-690`) then per context item `findByContextItem` (`:693`) — triple-nested sequential-await chain.
- `assertContextItemsInTenant` (`:1289-1294`) sequential `for...of` — N round trips instead of one `findAll({ id: { in } })`.

### 7.7 — [OCC] `SummaryMeta` has no `_version` despite two-phase read-modify-write
Two-phase optimistic-delivery (`persistDraft` EARLY → `finalizeAssurance` backfill, `harness-internal.service.ts:460-476`) is a read-then-update race window with no compare-and-set; correctness depends entirely on HTTP-layer idempotency-key dedup.

### 7.8 — [GOVERNANCE] `GateEditExemplar` few-shot corpus has no reviewer/moderation gate
`buildFewShotExemplarBlock` mines `redactedAfter` into EVERY generation's few-shot block — PHI-redacted at write but an unreviewed clinician-edit corpus replayed into future prompts with no human curation. The TASK-549 "promote to golden case" affordance reviews the EVAL corpus, not the live few-shot-injection corpus.

### 7.9 — [AUDIT] Content edits on APPROVED templates carry no distinct audit signal
`broadcastSysEvent(ResourceUpdated, {...})` (`prompt-management.service.ts:408-415`) carries no `wasApproved`/`liveEdit` marker — downstream audit consumers cannot distinguish routine draft edits from live-template mutations.

### 7.10 — [LIFECYCLE] Soft-delete exemptions across the plane
`AgentTrajectoryStep` (no resourceStatus), `GateEditExemplar` (no resourceStatus), `TranscriptSegment` (dies with parent) — intentional and documented in-schema, but any future admin bulk-restore feature must special-case these three.

### 7.11 — [DEFENSE] `SummaryMeta` provenance id arrays not tenant re-validated on read
`caseNoteIds/preSummaryIds/previousSummaryIds` (`consultation.prisma:259-261`) validated in-tenant at WRITE only (`context.service.ts:457-459`); never re-validated when dereferenced later.

---

## Key files for follow-up work

- `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts:323-331` — §7.1, highest priority.
- `packages/applications/src/services/prompt-management/prompt-management.service.ts:334-418` — §7.2.
- `packages/applications/src/services/consultation/harness/harness-internal.service.ts:342-458` — §7.3 injection point.
- `packages/database/src/prisma/db_main/department-agent.prisma` + `DepartmentAgentRepository.ts:62-70` — §7.4.
- `docs/implementation/TASK-544-Agent-Platform-Concept/README.md` §7 execution log + `TASK-551` README Change History bottom — current-vs-historical state.
