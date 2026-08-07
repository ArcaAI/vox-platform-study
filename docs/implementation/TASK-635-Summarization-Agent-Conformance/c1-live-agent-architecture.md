# TASK-635 C1 — Native Live-Summarization Agent Architecture

| | |
|---|---|
| **Task** | C1 (Lane C, Wave 2) — architecture design for the native live-summarization agent |
| **Status** | Review (awaiting owner approval — nothing in Lane C starts before sign-off) |
| **Date** | 2026-08-08 |
| **Author** | C1 design agent (fable-tier) |
| **Inputs** | TASK-635 README §1–§4 (requirements R-N1/R-N2, findings F-01/F-02/F-04/F-05, defect B-12, decisions OD-2(a)/OD-3(b)/OD-5(b), refinements RF-1…RF-6 — all BINDING), post-Wave-1 working tree |
| **Governs** | Tasks C2 (schema/domain/seed), C3 (live-loop integration), C4 (tool layer), C5 (finalize lineage); the D2 contract for the SYSTEM dept-free pre-summary fork |

Every claim about current behavior below is cited `file:line` against the post-Wave-1 working tree (i.e. including A2–A5's changes to `summary.service.ts`, `harness-internal.service.ts`, `ContextItemRepository.encryption.ts`, and B1's `SmrRoutingTask = 'live' | 'finalize' | 'test'`).

---

## 1. Executive summary

**One schema, one resolver, one frozen identity.** `DepartmentAgent` is extended in place (no new model) with six nullable columns: four capability-keyed template bindings (`newPatientTemplateId`, `revisitTemplateId`, `preSummaryTemplateId`, `livePromptTemplateId`), a `toolConfig` JSONB, and an `llmOverrides` JSONB keyed `live`/`finalize`. All are null on every existing row, and every resolution path treats null as "fall through to exactly what happens today" — so the 36 seeded agents (18 SYSTEM golden + 18 Global clones) change behavior by zero bytes, and the migration is a pure `ALTER TABLE ADD COLUMN`.

`PromptResolutionService.resolve()` stays the single capability-keyed entry point; `promptType` gains a `'live'` member. Per capability the tiers are: **summary** = preferred → agent visit-type binding (`newPatientTemplateId`/`revisitTemplateId` ?? base `promptTemplateId`) → legacy `Department` columns (demoted, deprecated) → SYSTEM default; **pre-summary (native)** = agent `preSummaryTemplateId` → tenant `TENANT_DEFAULT` (per-surface tag, RF-2) → SYSTEM dept-free fork (D2) → 503; **live** = agent `livePromptTemplateId` → SYSTEM live-default template → in-code constant (documented fail-open exception). Compat is untouched by construction: its pre-summary call carries no `departmentId` (RF-5) and defaults to the v1 surface variant.

The live loop resolves its agent **once**, at `start()`, through a narrow injected port (`ILiveAgentResolver`) — never `PromptAssemblyService`. The frozen snapshot (agent id, pinned `(templateId, versionNumber)`, prompt bytes, tool config, LLM override) lives on the in-memory `LiveSession`, is mirrored to Redis for cross-instance/crash recovery, and is stamped into the durable `LIVE_SOAP_SNAPSHOT` `metaData`. Every flush reads only the frozen snapshot: **zero added blocking I/O per flush**. The current hardcoded live prompt constants become the seeded, byte-identical SYSTEM live-default `PromptTemplate` (APPROVED, pinned v1), so default behavior is provably unchanged.

Finalize closes R-N2: the snapshot's agent lineage flows into `SummaryService.generateSummary` / the harness draft path, which (a) pin the resolver to the session's agent, (b) record lineage on `SummaryMeta`, and (c) inject the live note as the reviewed prior draft **unconditionally when lineage exists** — the `warmStartEnabled` flag is demoted to gating only the legacy no-lineage path.

**B-12 folds into C2 and is in fact a hard dependency of it**: the new SYSTEM-owned live-default template is unreadable cross-tenant without adding `PromptTemplate`/`PromptVersion` to `SYSTEM_SHARED_READ_MODELS`; the same change makes `…040` reachable once it is re-owned to the SYSTEM tenant. List surfaces pin an explicit caller `tenantId` so admin lists don't suddenly grow SYSTEM rows.

Tool orchestration stays config-driven (OD-5(b)): a small `LiveToolRegistry` maps keys (`nlp.classify-tokens`, `guardrail.groundedness`) to the existing executors; an unconfigured `toolConfig` reproduces today's NER+vitals+grounding exactly; a `version` field plus a per-executor `describe()` seam lets model-initiated tool-calling arrive later with no schema churn. The grounding anti-laundering rule (NER on transcript, never generated text), delta/windowed modes, flush throttle, Redis single-owner lock, and the SSE contract (additive-only DTO change) are preserved verbatim.

---

## 2. Decision record

Each design question from README §4.4 C1 (items 1–6, plus the three extensions in the task brief): one decision, alternatives dismissed, reasoning.

### DR-1 — Schema: extend `DepartmentAgent` (no `LiveAgentProfile`)

**Decision.** Extend `DepartmentAgent` with six nullable columns (§3). No new model.

**Alternatives dismissed.**
- *Separate `LiveAgentProfile` model.* Rejected. RF-4 is binding ("`DepartmentAgent` becomes a capability-keyed activation unit"), and the governance analysis below shows DepartmentAgent's semantics are the *right* ones for live behavior, not an accident. A second model would need its own default-per-department invariant, its own clone/lock/lineage/resync machinery (all already built for DepartmentAgent: `departmentAgent.service.ts:320-404` clone, `:487-491` lock guard, `agent-template-resync.service.ts:40-77` sweep), a second `isDefault` race with the first, and a JOIN on the resolution hot path. RF-6's "ONE agent identity per session" spanning live→finalize is also structurally simpler when live and finalize bindings live on the same row.
- *Per-visit-type agent rows (one agent per (department, visitType)).* Rejected: breaks the "exactly one default per department" invariant that `setDefaultForDepartment` enforces atomically (`departmentAgent.service.ts:221-237`), multiplies rows ×2–4, and makes RF-6's single session identity ambiguous.

**Do DepartmentAgent's governance semantics correctly govern live behavior?** Yes, examined one by one:

| Semantic | Effect on live bindings | Verdict |
|---|---|---|
| **Approval gate** (only APPROVED templates resolve — `prompt-resolution.service.ts:571-573`, `isApprovedTemplate` `:627-639`) | A live prompt streams to a clinician in real time; it needs *at least* the integrity the finalize prompt gets. The live chain applies the same APPROVED + snapshot-content discipline. | Correct as-is |
| **`templateLocked`** (locked golden clones reject content mutation — `departmentAgent.service.ts:487-491`; every DTO field flows through `update()` which calls `assertNotTemplateLocked` at `:153`) | New binding columns ride the same `update()` path, so a locked clone rejects binding edits automatically; "clone to customize" (`:320-404`) is the sanctioned escape. Zero new code. | Correct as-is |
| **Resync sweep** (`AgentTemplateResyncService`, four conservative rules at `agent-template-resync.service.ts:40-77`) | Rule (iii) never touches unlocked rows; rule (ii) pristine detection anchors on `metaData.sourceTemplateVersionNumber` + bound-template content, which the new nullable columns don't perturb. Rule (i) clone-when-absent must copy the new columns (all null on golden rows today — future-proofing only). One surgical change in C2. See DR-1a below for the ArcaAI interaction. | One small C2 edit |
| **Eval promotion gate** (`eval-promotion-gate.service.ts:80-81` finds bound agents by `filters: { tenantId, promptTemplateId }`; pin re-point gate at `departmentAgent.service.ts:272-289`) | Two gaps open: (a) at *approve* trigger, a template bound only via a capability column would not be found — C2 extends the lookup to OR across all five binding columns (new repo helper `findByBoundTemplate`). (b) The golden-set eval judges transcript→final-note quality; it is *meaningless* for a live delta prompt or a pre-summary prompt. Decision: the eval gate governs the summary bindings only (base + `newPatientTemplateId`/`revisitTemplateId`); live/pre-summary bindings are gated by APPROVED status alone. Extending eval coverage to other capabilities is the documented follow-on already excluded by README §4.7. | One C2 edit + documented limitation |
| **`pinnedVersionNumber`** | Stays scoped to the base `promptTemplateId` binding (no per-binding admin-pin columns — see DR-1b). | Correct as-is |

**DR-1a — migration story for the 36 existing seeded agents.** Their single `promptTemplateId` maps onto the new axis as the **base binding**: resolution reads `newPatientTemplateId ?? promptTemplateId` and `revisitTemplateId ?? promptTemplateId` (§4.1). Since all new columns are null on existing rows, every existing agent resolves the same template for both visit types — byte-identical to today's behavior (which is exactly what F-01 describes for the Global tenant: same prompt both visit types; we do not change Global's behavior in this ticket, we make the *capability* to differ exist). **No data migration, no backfill.** The 7 new ArcaAI agents (RF-3) are a *seed addition*, not a migration of existing rows (§5.2).

**DR-1b — no per-binding admin pin columns.** RF-6's pinning requirement is *session-freeze* pinning (resolve once → record the concrete `(templateId, versionNumber)` → serve those bytes for the whole session), which is delivered by the frozen snapshot (§6), not by admin pin columns. Governance pinning for the new bindings is already provided by `approvedVersionNumber` (approval pins the snapshot — `prompt-template.prisma`, `resolveGovernedContent` at `prompt-resolution.service.ts:519-546`); the 14 ArcaAI templates are seeded `approvedVersionNumber: 1` (`07b-arcaai-clinical-templates.ts:305-312`), so RF-3's bindings serve immutable snapshots with no extra columns. Adding four `*PinnedVersionNumber` columns now would be speculative admin-UI surface (out of scope per §4.7) — the columns can be added later additively if the UI wants them.

### DR-2 — Resolver: one capability-keyed `resolve()`, `promptType` gains `'live'`

**Decision.** Keep `PromptResolutionService.resolve(params)` as the single entry point. `PromptResolutionParams.promptType` widens to `'pre-summary' | 'new-patient' | 'revisit' | 'live'`; two new optional params: `preSummaryVariant?: 'v1' | 'dept-free'` (default `'v1'`) and `pinnedAgentId?: string` (C5). Full tier tables in §4.

**Alternatives dismissed.**
- *A separate `resolveLive()` method / separate live resolver service.* Rejected: the capability-chain-inside-one-resolve pattern is already established (`prompt-resolution.service.ts:255-259` dispatches per `promptType`), and finalize's `pinnedAgentId` preference (C5) needs to live in the same summary chain anyway.
- *Surface flag `compat: boolean` for the pre-summary agent tier.* Rejected by RF-5: eligibility falls out of the call signature — compat pre-summary passes no `departmentId` (`smr-compat-template.service.ts:70-71`), so the agent tier is naturally ineligible.
- *No variant param — discriminate the tenant pre-summary tag purely on `departmentId` presence.* Rejected: a **native** consultation may legitimately carry no department, and it must still get the dept-free family (tenant dept-free row → SYSTEM fork), while a compat call with the *same* signature must get the v1 family. RF-2 mandates per-surface-tag filtering, which requires the surface to be expressible. `preSummaryVariant` is not a compat/native flag (which RF-5 forbids for agent eligibility — that stays signature-derived); it selects which *template family* the caller wants, and its default (`'v1'`) means the compat call sites are untouched — no compat file changes at all. Native callers opt in to `'dept-free'` **in D2, not in Lane C** (§10 rollout), so Lane C ships mechanism with zero behavior change.

**Determinism with multiple agents.** Unchanged: only the department's **default** agent is ever consulted (`findDefaultForDepartment`, `prompt-resolution.service.ts:568`; atomic single-default flip at `departmentAgent.service.ts:221-237`). The capability axis lives as bindings *on* the default agent — never as a second agent row per capability — so `isDefault` semantics need no change and resolution stays a single indexed read (`DepartmentAgent_tenantId_departmentId_isDefault_idx`, `department-agent.prisma:76`).

**Tier-0 / tier-1b interaction.** Doctor-preferred (tier-0) continues to outrank the agent tier on the summary chain (current ordering, `prompt-resolution.service.ts:339,355-357`) — a doctor's explicit choice beats the department default, including the session-pinned agent at finalize (§7). The legacy `Department.newPatientPromptId`/`revisitPromptId` columns demote to **deprecated tier-1b fallback** (RF-3): reached only when there is no default agent or the agent's selected binding fails the APPROVED/snapshot checks. Within the agent tier there is exactly **one** attempt: `selected = visitBinding ?? promptTemplateId`; if that template is unapproved or has no snapshot, the whole tier returns null and falls to tier-1b (same single-attempt shape as today's `resolveDepartmentAgent`, `:563-593` — no second within-agent attempt, keeping resolution deterministic and cheap). Tier-0 is **not** consulted for `'live'` (live is a department/tenant-governed surface; a per-doctor live prompt is not a v1 concept and would add a resolution read to the session-start path for no requirement) nor for `'pre-summary'` (unchanged, `:394-405`).

### DR-3 — Live-loop integration: narrow port, resolve-once-at-start, frozen snapshot

**Decision.** A new interface `ILiveAgentResolver` (symbol token + `FrozenLiveAgentSnapshot` type, defined next to the live-doc service) is injected `@Optional()` into `LiveDocumentationService` — **not** `PromptAssemblyService`. Implementation: a new `LiveAgentResolutionService` in `services/consultation/prompt/` composing `ConsultationRepository` (to read `departmentId` — `start()` receives only ids, `consultation.controller.ts:472-477`), `PromptResolutionService.resolve({ promptType: 'live', … })`, and `DepartmentAgentRepository` (to read `toolConfig`/`llmOverrides` off the resolved agent row). Resolution is kicked off in `start()` as a memoized promise on the `LiveSession`; `flush()` awaits it (a resolved promise after the first flush — a microtask, no I/O). Full spec §6.

**Why not `PromptAssemblyService`?** The live prompt is *not* the template-assembly pipeline: it is a bespoke, prefix-cache-ordered concatenation (`buildSmrUserPrompt`, `live-documentation.service.ts:1542-1568`) with no `{variable}` substitution, no `EXTERNAL_DATA` spotlighting, no DNA/few-shot/NER blocks. Dragging the assembler in would put its DB reads (template row, DNA decrypt, exemplar retrieval — `prompt-assembly.service.ts:445,469,654`) onto the flush path and couple the live loop to finalize-only concerns. The port carries exactly what the loop needs and nothing else.

**Alternatives dismissed:** per-flush resolution (violates README §6 risk table and the ~5s budget); resolving in the controller and passing the snapshot through `StartLiveDocumentationParams` (breaks crash-recovery — a re-attach on another instance would have no snapshot source; the service must own adopt-from-Redis anyway).

### DR-4 — Finalize lineage and the fate of `warmStartEnabled`

**Decision.** The durable `LIVE_SOAP_SNAPSHOT`'s `metaData` gains an `agent` block (§7.1). `SummaryService.generateSummary` and the harness draft path read it, pin the resolver to the session agent (`pinnedAgentId`), record lineage on `SummaryMeta` (two new nullable columns, added in C2's migration), and inject the live note as the reviewed prior draft **unconditionally when agent lineage is present**. `HarnessPolicy.warmStartEnabled` (+ env fallback) survives, demoted to gating **only** the legacy no-lineage path (case-notes pre-summaries, sessions run before C3).

**Why agent-lineage supersedes the flag (the argument requested by the brief).** R-N2 says *"the same specific agent reviews and finalizes"* — that is the product contract, not an optional optimization. Keeping it behind a default-OFF env flag (`HARNESS_WARM_START_ENABLED=false` in every env file — F-05) makes R-N2 conformance an accident of deployment configuration: the exact defect class this ticket exists to close. Once a session has *provably* run the live agent (the lineage block exists only because the loop wrote it), refusing to hand its output to finalize is refusing the requirement. Conversely, the flag's original caution — injecting a possibly-stale, possibly-unencryptable prior draft — was addressed by Wave 1: A2 fixed the decryption (B-02, `ContextItemRepository.encryption.ts:79-132`), A3 fixed the shadowing (B-06, `summary.service.ts:1399-1407`). The legacy path (no live session ever ran; the "pre-summary" is a case-notes artifact) keeps the flag because there the injection is genuinely an opt-in behavior change. Deleting the flag outright is avoidable churn (policy column, admin console write path, env plumbing) for no benefit — demotion is the surgical move.

**Alternatives dismissed:** (a) flag stays the master gate (fails R-N2 by default — rejected); (b) delete the flag (touches HarnessPolicy schema/DTO/console for nothing); (c) new `agenticFinalize` flag (a new flag to bypass an old flag — no).

### DR-5 — Native pre-summary agent tier (scope extension, §3.1)

**Decision.** Chain per §4.3: agent `preSummaryTemplateId` (eligible only when `departmentId` was passed — RF-5) → tenant `TENANT_DEFAULT` filtered by surface tag (RF-2: `'smr-v1'` for the v1 variant, `'dept-free'` for the native variant) → SYSTEM default for the variant (v1: `…040`; dept-free: the D2 fork, contract in §4.3.1) → 503 fail-closed. Compat is untouched: its call (`smr-compat-template.service.ts:71`) passes neither `departmentId` nor a variant, so it takes v1-variant + no-agent-tier — the byte-identical current chain (locked by test, §10 C2-T6).

### DR-6 — B-12 fold-in: lands in C2, as two coordinated pieces

**Decision.** (a) Data migration re-owning `…040` (+ its `PromptVersion` `V40`) to the SYSTEM tenant and pinning `approvedVersionNumber = 1`; (b) code change adding `PromptTemplate` + `PromptVersion` to `SYSTEM_SHARED_READ_MODELS`; (c) explicit caller-`tenantId` pinning on the prompt-management list/count reads so admin lists don't grow SYSTEM rows. Full analysis §8. It lands in **C2** — not a separate A-lane follow-up — because C2's own SYSTEM live-default template is unreadable cross-tenant without (b): the fold-in is a *dependency* of Lane C, not merely co-located work.

### DR-7 — Latency budget (OD-5 justification)

Quantified in §9. Today's flush = 1 SMR call (dominant, bounded by `LIVE_DOC_SMR_TIMEOUT_MS` = 20s, typ. 1–5s) + 1 NLP call (30s timeout, typ. 100–500ms) + optional groundedness (default off) + Redis publish + throttled durable write. The design adds zero blocking I/O per flush; the one-time cost moves to `start()` (≤4 reads). This is why OD-5(b) (config-driven orchestration) is the only shape that fits the ~5s budget now, and why the registry's `describe()` seam is the sanctioned path to OD-5(a) later.

### DR-8 — Rollout order & behavior-identical proof plan

§10. C2 → C3 ∥ C4 → C5 → C6, every step carrying invariant tests that prove **no behavior change until a tenant opts in**: byte-compare of the seeded SYSTEM live template vs. the exported constants, agent-vs-column resolution equality for all 14 ArcaAI cells, SSE DTO additive-only snapshot, unconfigured-toolConfig executor-sequence parity, fidelity suite untouched.

### DR-9 — Admin-surface deferral

§11. The system is usable with zero new UI: seeds make every default path work; tenants opt in through the existing DepartmentAgent REST surface (the create/update DTOs gain the six optional fields in C2 — API-only until the Figma-gated UI ticket). The future UI's API needs are enumerated so C2's DTO shapes don't have to be revisited.

---

## 3. Schema & migration spec (C2)

### 3.1 `DepartmentAgent` diff

Additive columns only, inserted in the `// binding` section of `packages/database/src/prisma/db_main/department-agent.prisma` (after `goldenSetId`, line 44), respecting the rule-02 field template (meta → tenant → core → status → audit → tags → constraints order is untouched):

```prisma
  // ── TASK-635 capability-keyed bindings (RF-4). All nullable; null ⇒ the
  // legacy behavior for that capability (base promptTemplateId for summary,
  // tenant/SYSTEM tiers for pre-summary and live). Loose String refs like the
  // legacy Department prompt-id columns (department.prisma:21-23) — validated
  // in DepartmentAgentService.assertTemplateBindable, resolved through the
  // APPROVED + PromptVersion-snapshot discipline in PromptResolutionService.
  newPatientTemplateId String?
  revisitTemplateId    String?
  preSummaryTemplateId String?
  livePromptTemplateId String?
  // Which live-loop tools run for sessions under this agent. Null ⇒ platform
  // default (today's NER+vitals, groundedness per env) — see §C1 toolConfig
  // spec. Validated against LIVE_TOOL_KEYS in the application service.
  toolConfig Json? @db.JsonB
  // Optional per-task LLM override, keyed by SmrRoutingTask subset:
  // { live?: { aiModelSlug }, finalize?: { aiModelSlug } } (OD-3b). Validated
  // against ENABLED TEXT_GENERATION AiModel rows at write time; precedence at
  // read time: agent override → tenant AiTaskDefault (smr.live/smr.finalize)
  // → fail-closed. NEVER one global field — a low-latency live model must not
  // silently drive finalize (RF-4).
  llmOverrides Json? @db.JsonB
```

Design notes:

- **Loose refs, no FK relations.** The four binding columns follow the legacy `Department` column precedent (plain `String`, no FK — `department.prisma:21-23` per README §2.3) rather than `promptTemplateId`'s FK. Adding four named relations would put four back-relation arrays on `PromptTemplate` for zero query benefit (bindings are read off the agent row, never joined). Integrity is service-enforced (`assertTemplateBindable`, `departmentAgent.service.ts:444-453`, applied per binding) plus resolver-enforced (unapproved/missing → fall through).
- **No new indexes.** The resolution hot path is unchanged (covered by `DepartmentAgent_tenantId_departmentId_isDefault_idx`). Reverse lookups ("which agents bind template X" — eval gate at approve, resync) are admin-time operations over tables of dozens of rows per tenant; an OR-filter query (`findByBoundTemplate`, §3.4) needs no index.
- **No allow-list changes** (`DepartmentAgent` is already in `TENANT_SCOPED_MODELS`, `tenant-scope.ts:183-187`, and keeps soft delete), **no `ResourceType` change** (model already exists and emits sys-events).

### 3.2 `SummaryMeta` diff (lineage columns, consumed by C5)

In `packages/database/src/prisma/db_main/consultation.prisma`, appended to the provenance block (after `resolvedPromptId`, line 279):

```prisma
  // TASK-635 RF-6 — session-agent lineage: the DepartmentAgent identity frozen
  // at recording start and carried live-flushes → LIVE_SOAP_SNAPSHOT metaData
  // → finalize. Null for non-live-session summaries. `sessionAgentPromptVersion`
  // is "<templateId>@<versionNumber>" — the immutable PromptVersion the live
  // loop actually served (distinct from promptVersion, which names finalize's
  // own template version).
  sessionAgentId            String?
  sessionAgentPromptVersion String?
```

(The consumed snapshot ContextItem id is recorded in the existing `preSummaryIds String[]` — `consultation.prisma:269` — no new column.)

### 3.3 Migrations (`packages/database/src/prisma/db_main/migrations/`)

1. **`<ts>_task_635_agent_capability_bindings/migration.sql`** — `ALTER TABLE core."DepartmentAgent" ADD COLUMN` ×6 (all nullable, no defaults, no backfill) + `ALTER TABLE core."SummaryMeta" ADD COLUMN` ×2. Purely additive; zero table rewrites.
2. **`<ts>_task_635_reown_system_pre_summary_default/migration.sql`** (B-12 data migration, §8):
   ```sql
   UPDATE core."PromptTemplate" SET "tenantId" = '00000000-0000-0000-0000-000000000000',
     "approvedVersionNumber" = 1
     WHERE id = '71000000-0000-0000-0000-000000000040';
   UPDATE core."PromptVersion"  SET "tenantId" = '00000000-0000-0000-0000-000000000000'
     WHERE id = '72000000-0000-0000-0000-000000000040';
   ```
   Migration-review checks: the `@@unique([tenantId, name])` on `PromptTemplate` must not collide in the SYSTEM tenant ("Pre-Summary Default Template" does not appear among the 13 golden names sourced from `DEFAULT_PROMPT_TEMPLATES` — verify in review); content untouched (the sha256 lock `system-pre-summary-default-checksum.test.ts` stays green).

Both roll forward only; committed together with the schema files per rule 02.

### 3.4 Domain trio (hand-authored — `gen:mapper` is NEVER run)

Per rule 03 (`gen:entity`/`gen:factory` reconcile only; `gen:mapper` destructive; `gen:repository` broken):

- `pnpm gen:model` regenerates `packages/domains/src/models/generated/core/DepartmentAgentModel.ts` and `SummaryMetaModel.ts` (the ONLY generated step).
- **Hand-edit** `DepartmentAgentEntity.ts` (+6 getter/setter pairs through `setProperty`), `DepartmentAgentFactory.ts` (+6 optional props), `DepartmentAgentEntityMapper.ts` (+6 field mappings — **`FIELDS_NOT_WRITABLE = ['version']` and `stripNonWritableFields` stay untouched**), `DepartmentAgentRepository.ts` (+ `findByBoundTemplate(tenantId, promptTemplateId)` — OR-filter across `promptTemplateId | newPatientTemplateId | revisitTemplateId | preSummaryTemplateId | livePromptTemplateId`). Same four-file treatment for `SummaryMeta*` (+2 fields).
- `pnpm gen:entity` + `pnpm gen:factory` afterwards must report no-drift + schema-coverage OK (the coverage check is what proves the new columns are surfaced).

### 3.5 Seed changes (C2)

1. **`seed/00-constants.ts`** — document the new id sub-block `…-0004-…` (TASK-635 SYSTEM defaults) and export:
   - `SYSTEM_LIVE_SOAP_TEMPLATE_ID = '71000000-0000-0000-0004-000000000001'` (+ version `72000000-0000-0000-0004-000000000001`)
   - reserved for D2: `SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID = '71000000-0000-0000-0004-000000000002'`
   (A fresh static block — NOT the golden `…-0002-…` generator, whose ids derive from `uniqueSourceIds` insertion order, `07a-agent-golden-library.ts:124-141`; appending there would renumber nothing today but couples the id to fixture ordering.)
2. **New `seed/07c-live-agent-defaults.ts`** — the SYSTEM live-default `PromptTemplate`:
   - `tenantId: SYSTEM_TENANT_ID`, `name: 'Live SOAP Running Note — System Default'`, `category: 'SYSTEM'`, `status: 'APPROVED'`, `approvedVersionNumber: 1`, `currentVersionNumber: 1`, `departmentId: null`, `scope: 'TENANT_DEFAULT'`, `tags: ['live-summary', 'system-default']`.
   - `content` = **byte-identical** to `LIVE_SOAP_STABLE_SYSTEM_PREFIX` (`live-documentation.service.ts:69-72`, including its embedded `SOAP_OUTPUT_INSTRUCTION` `:52-58`).
   - `metaData.promptConfig.systemPrompt` = the byte-identical `system_prompt` literal from the flush payload (`live-documentation.service.ts:1668-1669`). Carrying the system-role string under `metaData.promptConfig` reuses the existing metaData convention (`prompt-assembly.service.ts:747-761` reads `promptConfig.hyperparameters/outputSchema` the same way) — **no schema change, no new enum member**. (`PromptTemplateCategory` has no `LIVE_SUMMARY`; adding one means `ALTER TYPE` + enum-parity churn for zero resolver benefit, since resolution targets the template by the explicit `SYSTEM_DEFAULTS.livePromptId` pointer, never by tag scan. Tag-based identification chosen — C1 item 4 "category or tag" resolved: tag.)
   - Plus one `PromptVersion` v1 snapshot with the same content. Registered in the seed index after 07a/07b.
3. **`seed/07a-agent-golden-library.ts`** — restore ArcaAI agents per RF-3 (§5.2) and rewrite the `:270-280` NOTE (the zero-agent invariant is retired, not guarded).
4. **`seed/07-prompt-template.ts`** — the `…040` row's `tenantId` becomes `SYSTEM_TENANT_ID` and it gains `approvedVersionNumber: 1` (matching the data migration; note the generic `resolvePromptStatus` at `:22` already seeds it APPROVED); same tenant change on the `V40` version row; the `:1615-1619` B-10 NOTE updated.
5. **Test replacement (RF-3)**: delete `seed/__tests__/arcaai-zero-department-agents.test.ts`; add `seed/__tests__/arcaai-agent-column-equality.test.ts` asserting, for all 7 departments × 2 visit types, that the seeded agent's binding id equals the corresponding legacy `Department` column id (id-level equality provable in the seed package; the resolver-level equality test lives in `packages/applications` — §10 C2-T2).

---

## 4. Resolver spec

### 4.1 Signature

```ts
// prompt-resolution.service.ts
export interface PromptResolutionParams {
  departmentId?: string;
  tenantId?: string;
  promptType?: 'pre-summary' | 'new-patient' | 'revisit' | 'live';   // + 'live'
  explicitTemplate?: string;
  preferredPromptTemplateId?: string | null;
  /** RF-2 — which pre-summary template family. Default 'v1' preserves every
   *  existing call site byte-for-byte; native callers flip to 'dept-free' in D2. */
  preSummaryVariant?: 'v1' | 'dept-free';
  /** C5 / RF-6 — finalize pins the summary chain's agent tier to the SESSION's
   *  agent instead of findDefaultForDepartment. Verified same-tenant/-department
   *  + ENABLED; falls through normally when the row is gone. */
  pinnedAgentId?: string;
}
```

`ResolvedPromptConfig` additions (all optional, additive): `resolvedAgentId` already exists (`prompt-resolution.service.ts:102`); add `resolvedCapability?: 'summary' | 'pre-summary' | 'live'` (trace/telemetry) — nothing else. The frozen-snapshot extras (toolConfig, llmOverrides, agent name) are read by `LiveAgentResolutionService` from the agent row it already fetched, not funneled through `ResolvedPromptConfig` (keeps the resolver's return type prompt-shaped).

`SYSTEM_DEFAULTS` (`prompt-resolution.service.ts:173-183`) gains:

```ts
livePromptId: '71000000-0000-0000-0004-000000000001',            // C2 seed, §3.5
deptFreePreSummaryPromptId: '71000000-0000-0000-0004-000000000002', // D2 seed (reserved)
```

### 4.2 Summary chain (`'new-patient' | 'revisit'`) — modified `resolveSummaryPromptId` (`:313-375`)

| Tier | Source | Condition | Change vs today |
|---|---|---|---|
| 0 | `preferredPromptTemplateId` (doctor) | APPROVED (`:605-620`) | unchanged — still outranks the agent tier, incl. `pinnedAgentId` |
| 1a | **Agent binding**: `agent = pinnedAgentId ? findById(pinnedAgentId) [verify tenant/department/ENABLED] : findDefaultForDepartment(tenantId, departmentId)`; then `selected = (promptType === 'revisit' ? agent.revisitTemplateId : agent.newPatientTemplateId) ?? agent.promptTemplateId` | `selected` APPROVED + snapshot at `pinnedVersionNumber ?? approvedVersionNumber ?? latest` resolves (existing `resolveDepartmentAgent` discipline `:563-593`, now parameterized by the selected template id) | **F-01 closed**: visit type now reaches the agent tier. Single attempt: if `selected` fails checks, the whole tier returns null (no within-agent retry) |
| 1b | Legacy `Department.newPatientPromptId`/`revisitPromptId` (`:327,365-367`) | APPROVED | unchanged mechanics; documented **deprecated fallback** (RF-3) |
| 2 | `SYSTEM_DEFAULTS.promptId` (CATCHALL_SOAP `:374`) | — | unchanged |

### 4.3 Pre-summary chain — modified `resolvePreSummaryPromptId` (`:394-436`)

| Tier | Source | Condition | Change vs today |
|---|---|---|---|
| 1a′ | **Agent `preSummaryTemplateId`** via `findDefaultForDepartment` | `params.departmentId` present (RF-5 — compat never passes it, `smr-compat-template.service.ts:70-71`) AND binding set AND template APPROVED + snapshot | **new** (scope extension §3.1) |
| 1t | Tenant `TENANT_DEFAULT` row via `findTenantPreSummaryTemplateId` (`:464-490`), filter gains the **surface tag**: `tags: { hasEvery: ['pre-summary', variantTag] }` where `variantTag = 'smr-v1' | 'dept-free'` | APPROVED, dept-unbound, ENABLED (unchanged) | **RF-2**: per-(tenant, surface-tag) single-candidate rule. The ArcaAI v1 row already carries both `'pre-summary'` and `'smr-v1'` (`07b:270`), so the default variant resolves it identically |
| 2 | Variant-selected SYSTEM default: `'v1'` → `preSummaryPromptId` (`…040`); `'dept-free'` → `deptFreePreSummaryPromptId` (D2 fork) | APPROVED (post-B-12 fold-in, reachable cross-tenant — §8) | v1 branch unchanged; dept-free branch is D2 |
| — | **503 fail-closed** (`:429-435`) | — | unchanged |

#### 4.3.1 The D2 fork contract (what Lane D2 must deliver for tier-2-dept-free to work)

- A SYSTEM-tenant-owned `PromptTemplate` at `SYSTEM_DEFAULTS.deptFreePreSummaryPromptId`: APPROVED, `approvedVersionNumber: 1`, `departmentId: null`, tags `['pre-summary', 'dept-free', 'system-default']`, with one v1 `PromptVersion` snapshot.
- Content: the pre-summary instruction **without** `{current_department}`/`{visit_type}` placeholders and with section headings free of "(Latest Dept Note)" — RF-1 permits renaming because native does not use the compat title-matching mapper (`PRE_SUMMARY_DISPLAY_TITLES`, `summary-response.mapper.ts` — compat-only).
- Its own checksum entry (new fixture constant, NOT an edit to any of the 15 locked v1 constants — the TASK-634 gate stays byte-identical).
- D2 also flips the native pre-summary call sites to `preSummaryVariant: 'dept-free'` (§10 step D2) — until then the fork is seeded but unreferenced.
- Compat proof obligation (D3): `resolveGovernedInstruction(tenantId, undefined, 'pre-summary')` resolves the identical template id and content before and after Lane C+D2 (test C2-T6/D2-T1).

### 4.4 Live chain — new `resolveLivePromptId` (same file, sibling of the other two chains)

| Tier | Source | Condition |
|---|---|---|
| 1a | Agent `livePromptTemplateId` via `findDefaultForDepartment(tenantId, departmentId)` (agent tier skipped entirely when the consultation has no department) | binding set AND template APPROVED + snapshot at `approvedVersionNumber ?? latest` |
| 2 | `SYSTEM_DEFAULTS.livePromptId` (the seeded SYSTEM live default, §3.5) | APPROVED (readable cross-tenant post-§8) |
| 3 | **In-code constants** (`LIVE_SOAP_STABLE_SYSTEM_PREFIX` + system-prompt literal), `resolvedFrom: 'code-default'` | always — **fail-open, never throws** |

Tier 3 is the **documented exception to the fail-closed doctrine** (README §4.4 C1 item 5, binding): the live loop must never fail a running consultation on resolution failure — patient-safety of the live view outranks selection strictness. It is safe precisely because tier 3's bytes are proven identical to tier 2's seeded content (test C2-T1), so "fail-open" degrades to *identical behavior*, not different behavior. Finalize and pre-summary keep their fail-closed posture unchanged. No tenant tag-scan tier for live (avoids re-creating B-01's multi-candidate convention); a tenant-wide live prompt is expressed by binding `livePromptTemplateId` on its department default agents, and a tenant tier can be added later additively if ever wanted.

The live chain reports tier as `'agent' | 'default' | 'code-default'` — one new `PromptResolutionTier` member (`'code-default'`), additive to the union at `:112`.

---

## 5. Seeded data: RF-3 (ArcaAI agents) and the golden library

### 5.1 Golden + Global agents — untouched

All 36 rows keep null capability columns → resolve exactly as today (DR-1a). No backfill, no re-pointing.

### 5.2 ArcaAI agents (RF-3) — 7 new rows in `07a-agent-golden-library.ts`

| Field | Value | Why |
|---|---|---|
| `id` | `78000000-0000-0000-0001-0000000000NN` (N = 1…7) | Reuses the retired ArcaAI block (`07a:31-32`); upsert-by-id self-heals any stale pre-Workstream-D rows in long-lived dev DBs |
| `tenantId` / `departmentId` | ArcaAI (`50000000-…0001`) / the 7 clinical departments (`00-constants.ts:228-234`) | |
| `slug` | **the golden slug** — `gen-default`, `surg-default`, `rheum-default`, `neur-default`, `orth-default`, `heme-default`, `bren-default` (`07a:187`) | Load-bearing: resync rule (i) clones a golden agent only when its slug is absent for the tenant (`agent-template-resync.service.ts:52-54`). Matching slugs make the sweep a guaranteed no-op for ArcaAI (rule (iii) then protects the unlocked rows forever) — the F-01 "sweep silently re-adds an agent" hazard is closed *structurally*, not by kill-switch |
| `promptTemplateId` (base, NOT NULL) | the department's **new-referral** template id (`ARCAAI_CLINICAL_TEMPLATE_IDS`, `07b:70-86`) | required column; also the within-tier fallback |
| `newPatientTemplateId` | same new-referral id (explicit) | RF-3: explicit per-visit-type bindings |
| `revisitTemplateId` | the department's followup/revisit/review template id | |
| `preSummaryTemplateId` / `livePromptTemplateId` / `toolConfig` / `llmOverrides` | null | pre-summary keeps resolving via the tenant tier (`…024` — behavior-identical); live keeps the SYSTEM default; tools/LLM keep platform behavior |
| `pinnedVersionNumber` | null | the 14 templates are `approvedVersionNumber: 1`-pinned (`07b:309`) — the approval pin IS the governance pin (DR-1b) |
| `isDefault` | true | tier-1a eligibility |
| `templateLocked` / `sourceAgentTemplateSlug` | false / null | tenant-owned wiring, not golden clones; resync rule (iii) never touches them |
| `goldenSetId` | null | no eval corpus exists for these; the gate records "proceeded ungated" on approve (existing semantics, `eval-promotion-gate.service.ts:83-88`) |

**Behavior-identical by construction, proven twice**: id-level (seed test §3.5.5) and resolution-level (C2-T2: for each of the 14 cells, `resolve({departmentId, promptType})` returns the same `promptId`, same `resolvedVersionNumber`, same `content` bytes as a legacy-column-only fixture; only `resolvedFrom` flips `'department'` → `'agent'`). The `resolvedFrom` flip is asserted *intentional* in the same test and checked against its one behavioral consumer: the compat shim's guard is `resolvedFrom === 'default'` (`smr-compat-template.service.ts:74`), which neither `'department'` nor `'agent'` triggers — compat output unchanged.

Also in C2: `04-department.ts:341-360` and `07b:8-15` prose updated (the zero-agent invariant text is now wrong), and the legacy columns' comments gain the "deprecated tier-1b fallback" wording (RF-3).

---

## 6. Live-loop integration spec (C3)

### 6.1 The port

```ts
// live-documentation/live-agent.port.ts (new)
export const ILiveAgentResolver = Symbol('ILiveAgentResolver');

export interface FrozenLiveAgentSnapshot {
  /** 'agent' | 'default' | 'code-default' — which tier froze. */
  resolvedFrom: 'agent' | 'default' | 'code-default';
  agentId: string | null;          // null on default/code-default tiers
  agentName: string | null;
  promptTemplateId: string | null; // null only on code-default
  promptVersionNumber: number | null;
  /** The immutable prompt bytes served for the WHOLE session. */
  stableUserPrefix: string;        // replaces LIVE_SOAP_STABLE_SYSTEM_PREFIX
  systemPrompt: string;            // replaces the :1668-1669 literal
  /** Normalized tool plan (§C4). Always populated — defaults applied here. */
  toolPlan: ResolvedToolPlan;
  /** Frozen per-task LLM override; null ⇒ per-flush resolveSmrSelection(tenantId,'live') as today. */
  liveLlm: { provider: string; model: string } | null;
  frozenAt: string;                // ISO
}

export interface ILiveAgentResolver {
  /** Resolve-and-freeze for a session. NEVER throws (fail-open to code-default). */
  resolveForSession(input: { consultationId: string; tenantId: string }): Promise<FrozenLiveAgentSnapshot>;
}
```

Implementation `LiveAgentResolutionService` (`services/consultation/prompt/live-agent-resolution.service.ts`, new):
1. `consultationRepository.findById(consultationId)` → `departmentId` (nullable — the consultation stamps it at open, README §2.1) with a tenant guard (`consultation.tenantId === tenantId`, else treat as no-department).
2. `promptResolutionService.resolve({ promptType: 'live', tenantId, departmentId })` → template id / version / content / tier / `resolvedAgentId`.
3. If tier `'agent'`: `departmentAgentRepository.findById(resolvedAgentId)` was already loaded inside the chain — the chain returns the agent row's `toolConfig`/`llmOverrides` alongside (implementation detail: `resolveLivePromptId` passes the fetched agent entity back so no second read happens). `llmOverrides.live.aiModelSlug` → `AiModelRepository` lookup → `{ provider, model: sourceUri }` with the `azure → azure-openai` alias (mirrors `harness-policy.service.ts:546-548`); an unknown/disabled slug logs + degrades to null (per-flush tenant default — fail-open, live posture).
4. `systemPrompt` from the resolved template's `metaData.promptConfig.systemPrompt`, falling back to the in-code literal when absent.
5. Any error anywhere → the code-default snapshot (constants, default tool plan, null LLM) + `logger.error`. **This method cannot throw.**

Registered in the consultation service module; injected into `LiveDocumentationService` as `@Optional() @Inject(ILiveAgentResolver)` trailing-parameter (the established fixture-arity convention, `live-documentation.service.ts:339-367`). Absent (legacy fixtures) ⇒ the service synthesizes the code-default snapshot locally — behavior byte-identical to today.

### 6.2 Session lifecycle changes (`live-documentation.service.ts`)

- `LiveSession` (`:145-205`) gains: `agentPromise: Promise<FrozenLiveAgentSnapshot>` and `agentSnapshot?: FrozenLiveAgentSnapshot` (cached result).
- **`start()` (`:449-503`)** stays synchronous: after registering the session it kicks `session.agentPromise = this.ensureAgentResolved(session)` (fire-and-forget shape like `claimOwnership`, `:500`). `ensureAgentResolved`:
  1. **Adopt-first**: read Redis `consultation:live-summary:{id}:agent` (new key helper beside `:1915-1931`); a valid stored snapshot is adopted verbatim — this is what makes cross-instance restart and crash recovery re-resolve *identically* (RF-6: the stored `(templateId, versionNumber)` pins immutable `PromptVersion` bytes, never "latest").
  2. Else call the port, then persist the snapshot to that Redis key with `EX = LOCK_TTL` (3600s, `:263`), refreshed alongside the fenced lock renewal (`startLockRenewal`, `:1352-1360`) so a live session's pin never expires mid-session.
  3. On any failure: code-default snapshot (never rejects).
  A second recovery source exists implicitly: the durable `LIVE_SOAP_SNAPSHOT.metaData.agent` block (§7.1) — if Redis is cold AND a durable row exists, `ensureAgentResolved` re-pins from it (fetch `PromptVersion` by the stored `(templateId, versionNumber)` — immutable ⇒ byte-identical). Only a genuinely fresh session performs a fresh resolve. Mid-session template approvals therefore **never** mutate a running session (RF-6).
- **`flush()` (`:688-992`)**: first line after the throttle gate — `const agent = session.agentSnapshot ?? (session.agentSnapshot = await session.agentPromise);` (post-first-flush this is a resolved promise: no I/O). Then:
  - `buildSmrUserPrompt` (`:1542-1568`) takes `agent.stableUserPrefix` as its lead-in instead of the module constant (the constant remains exported as the tier-3 source). Prefix-cache friendliness is *preserved by construction*: the prefix is frozen per session, so it is byte-identical across every flush of the session — the same property the constant provided (`:60-68`).
  - `callSmr` (`:1639-1692`) gains a `selection` parameter: when `agent.liveLlm` is set it is used verbatim (frozen — RF-4 agent override); else the existing per-flush `resolveSmrSelection(tenantId, 'live')` (`:1656-1657`) runs unchanged (tenant AiTaskDefault fallback, admin re-points still land next flush — current behavior preserved). `system_prompt` in the payload (`:1668-1669`) becomes `agent.systemPrompt`. The stats stamp stays `task_key: 'smr.live'` (`:1689`) with an additive `selection_source: 'agent-override' | 'task-default'`.
  - Tool execution: driven by `agent.toolPlan` through the `LiveToolRegistry` (§C4) — replacing the hardcoded `callNlp` orchestration at `:877-893` and the `groundednessEnabled` branch at `:905-910`. The **anti-laundering rule is preserved structurally**: the registry context exposes only `nerSourceText = delta || transcript` (`:877`) to extraction tools; the generated note is grounded *after* tool execution by the untouched `groundEntitiesToNote` (`:916`, `:1796-1812`).
  - Delta/windowed modes (`:737-801`), min-interval throttle (`:701-706`), generation/stale guards (`:718-724`), single-owner lock (`:95-113`, `:1315-1393`) — untouched.
- **`persistDurableSnapshot()` (`:1458-1518`)**: the `metaData` literal (`:1466`) gains the `agent` block (§7.1).
- **`recordFlushTrajectory()` (`:1002-1110`)**: the `LLM_CALL flush` step's `payloadRef` gains `{ agentId, promptVersion }` (additive).
- **SSE payload**: `LiveSummaryMetadataDto` (`dto/live-summary.dto.ts:240`) gains an optional `agent?: LiveSummaryAgentDto { id: string | null; name: string | null; promptTemplateId: string | null; promptVersionNumber: number | null; resolvedFrom: string }`. Optional field on an optional envelope ⇒ additive-only; the DTO snapshot test (C3-T3) locks it.

### 6.3 What is deliberately NOT frozen

The `agentic.context.*` batching knobs stay per-flush-resolved (`resolveAgenticContext`, `:1593-1626`) — they are ops throttles, not agent identity, and freezing them would regress the TASK-533 control-plane contract. The tenant `smr.live` AiTaskDefault stays per-flush when no agent override exists (above) — same reasoning, and it is today's behavior.

---

## 7. Finalize-lineage spec (C5)

### 7.1 `LIVE_SOAP_SNAPSHOT` metaData shape (written by C3, consumed by C5)

```jsonc
// ContextItem.metaData on the durable snapshot row (live-documentation.service.ts:1466)
{
  "subType": "LIVE_SOAP_SNAPSHOT",
  "lastSegmentId": "seg-…",
  "updatedAt": "2026-…",
  "agent": {                              // NEW — RF-6 lineage
    "agentId": "78000000-…|null",
    "agentName": "Surgery Default Agent|null",
    "promptTemplateId": "71000000-…|null",
    "promptVersionNumber": 1,             // null only on code-default
    "resolvedFrom": "agent|default|code-default",
    "liveLlm": { "provider": "…", "model": "…" },   // present only when the agent override served
    "frozenAt": "2026-…"
  }
}
```

### 7.2 `SummaryService.generateSummary` (post-Wave-1 state)

- `resolveWarmStartPreSummaryText` (`summary.service.ts:1399-1407`) is renamed/extended to `resolveWarmStartPreSummary(): Promise<{ text: string | null; lineage: SnapshotAgentLineage | null; snapshotId: string | null }>` — it already receives `{ entity, plaintext }` from `findLatestPreSummaryWithDecryptedContent` (`ContextItemRepository.encryption.ts:117-132`); the change is surfacing `entity.metaData.agent` + `entity.id` instead of discarding them. Both branches (LIVE_SOAP_SNAPSHOT-preferred, legacy any-subtype — A3's shape) kept.
- The `assemble()` call (`:413-422`) gains `preSummaryLineage: lineage ?? undefined` and, when `lineage?.agentId` exists, `pinnedAgentId: lineage.agentId`.
- `SummaryMeta` creation (`:454-465`): `sessionAgentId = lineage?.agentId ?? null`, `sessionAgentPromptVersion = lineage ? `${lineage.promptTemplateId}@${lineage.promptVersionNumber}` : null`, and `preSummaryIds` gains the consumed `snapshotId`.

### 7.3 `PromptAssemblyService`

- `PromptAssemblyParams` gains `preSummaryLineage?: { agentId: string | null; promptTemplateId: string | null; promptVersionNumber: number | null }` and `pinnedAgentId?: string` (passed through to the resolver, `prompt-assembly.service.ts:432-443`).
- The warm-start gate (`:534`) becomes: `if (params.preSummaryLineage || await this.resolveWarmStartEnabled(params.tenantId))` — lineage injects unconditionally (DR-4); the no-lineage legacy path keeps the flag exactly as today. The injected block text (`:540-550`) is unchanged.

### 7.4 Resolver: `pinnedAgentId` in the summary chain

In tier-1a (§4.2): when `pinnedAgentId` is present, load that agent by id and verify `tenantId` + `departmentId` match and `resourceStatus === ENABLED`; on any mismatch/absence, fall through to `findDefaultForDepartment` then the normal chain (a deleted/re-departmented agent must not 500 a finalize). This is what makes tier-1a **deterministic w.r.t. the live session** even if the department default was re-pointed mid-visit (RF-6). Tier-0 doctor-preferred still outranks it (DR-2) — the doctor's explicit template choice is a stronger signal than the department default that happened to run live; the lineage columns still record which agent ran live, so provenance is never lost even when tier-0 wins.

### 7.5 Harness draft path (`harness-internal.service.ts`)

- `assemble()` (`:487-621`): the snapshot load at `:544` becomes unconditional (`loadLiveSoapSnapshot` always runs); injection decision: lineage present → inject (`preSummaryText` `:586` + `preSummaryLineage` + `pinnedAgentId` into the `:570-592` assemble call); lineage absent → current flag-gated behavior (`resolveWarmStartEnabled(tenantId)`).
- `persistDraft()` (`:640-`): the provenance re-resolve at `:694` follows the same rule; `SummaryMeta` creation (`:710-`) sets the two lineage columns + `preSummaryIds` (the shared `loadLiveSoapSnapshot` helper `:1241-1243` already guarantees both call sites see the same frozen row — its determinism note at `:688-693` carries over).
- E2E (C5/C6): start recording → live flushes (SSE events carry `metadata.agent`) → stop → finalize → the `SummaryMeta` row's `sessionAgentId` equals the SSE-reported agent id, and `promptResolvedFrom='agent'` with `resolvedPromptId` = the agent's summary binding.

---

## 8. B-12 fold-in spec (C2)

**Problem (B-12, README §2.4).** `PromptTemplate`/`PromptVersion` are tenant-scoped (`tenant-scope.ts:96-97`) and not SYSTEM-shared (`:262-360`); `mergeTenantIntoWhere` (`:573-585`) injects the caller's tenant, so a non-Global tenant's `findById('…040')` misses → `isApprovedTemplate` false (`prompt-resolution.service.ts:627-639`) → tier-2 pre-summary falls to the 503. The same mechanics would make C2's new SYSTEM live-default template invisible to every tenant — **so the fold-in is a Lane-C dependency, not just co-located hygiene.**

**Change set (all in C2):**
1. **Re-own `…040` + `V40` to the SYSTEM tenant** (data migration §3.3.2 + seed §3.5.4). Rationale over leaving it Global-owned and widening anyway: SYSTEM ownership is what `SYSTEM_SHARED_READ_MODELS` semantically means ("platform catalog owned by SYSTEM", `tenant-scope.ts:243-261`); widening reads to `[caller, SYSTEM]` would NOT make a Global-owned row visible to a third tenant. Also pins `approvedVersionNumber = 1` (integrity upgrade: tier-2 then serves the immutable `V40` snapshot instead of the mutable-content legacy fallback — content is byte-identical, locked by the Wave-1 checksum test).
2. **`SYSTEM_SHARED_READ_MODELS` += `PromptTemplate`, `PromptVersion`** with a justification comment following the house pattern (`tenant-scope.ts:262-360`). Write-scoping is fully preserved by the extension's design: only `makeReadHandler` widens; mutations keep exact-tenant injection, so `update`/`delete` on a SYSTEM row from tenant CLS yields P2025 → 404 (`:254-261`). An explicit `where.tenantId` pin remains legal only for `[caller, SYSTEM]` (`mergeSharedReadTenantIntoWhere`).
3. **Who reads `PromptTemplate` cross-tenant today expecting a miss — audited:**
   - `07a:34-41` records the deliberate decision NOT to widen, precisely because tenant **list surfaces** (template pickers, `/agents` Templates tab, the B4 combobox) would surface the 13 SYSTEM golden templates + now the live default + `…040`. Mitigation: the prompt-management list/count reads pin an explicit `tenantId: <caller>` filter (legal under the widened handler), preserving today's list contents exactly. Touch: `prompt-management.service.ts` list/count call sites (Lane C2 touch list). By-id reads (resolution, `assertTemplateBindable`, version fetches) get the widening — which is the intent.
   - `DepartmentAgentService.assertTemplateBindable` (`departmentAgent.service.ts:444-453`) *already* codes for SYSTEM-template visibility (`template.tenantId !== SYSTEM_TENANT_ID` allowance) — under current scoping that branch is unreachable from tenant CLS (the read misses first), i.e. binding a golden/SYSTEM template today fails with the generic 400. The widening **fixes** this latent gap; no code change needed there.
   - `AgentTemplateResyncService` runs tenant-less (elevated pass-through, `agent-template-resync.service.ts:70-77`) — unaffected. Tenant provisioning reads golden rows through the sanctioned unscoped client (`07a:38-40`) — unaffected. GLOBAL_ADMIN callers already bypass injection (B-12 note) — unaffected.
   - Cross-tenant 404 e2e contracts (task-307 pattern): those specs assert 404 for *another customer tenant's* rows — the widening adds only `[caller, SYSTEM]`, so they stay green; a new spec asserts a SYSTEM template is readable-but-not-writable from a tenant (C2-T5).
4. **Placement verdict:** C2, as its own migration step (§3.3.2) within the C2 change set — not a separate A-lane ticket. Ordering inside C2: the code widening and the seed/data migration land in the same MR; the widening is inert without SYSTEM-owned rows and the re-own is invisible without the widening, so neither partial state breaks anything (Global keeps resolving `…040` in both partial states — as owner before, via widening after).
5. **New tests:** fresh-tenant (no TENANT_DEFAULT pre-summary row) resolution reaches `…040` instead of 503 (RED against pre-C2 tree per B-12's evidence chain); SYSTEM live default resolvable from a customer-tenant CLS; tenant CLS cannot update a SYSTEM template (404).

---

## 9. Latency budget (DR-7 / OD-5 evidence)

Per-flush blocking work, today vs designed (flush body `live-documentation.service.ts:688-992`):

| Step | Today | After C3/C4 | Delta |
|---|---|---|---|
| `resolveAgenticContext` | in-memory settings snapshot, no I/O per call (`:1584-1588`) | unchanged | 0 |
| Agent/prompt resolution | — (constants) | `await session.agentPromise` — resolved after flush 1 ⇒ microtask | **0 I/O** (first flush may await the in-flight start-time resolve, ≤4 reads, once) |
| LLM selection | `resolveSmrSelection(tenantId,'live')` every flush (`:1656-1657`) | frozen agent override (0 I/O) **or** the identical per-flush call | ≤ 0 |
| SMR `/generate` | 1 call, timeout 20s (`:391`), typical 1–5s — dominant | 1 call (same payload shape; prompt bytes identical by default) | 0 |
| NLP `/classify/tokens` | 1 call (`:1710-1721`), typ. 100–500ms | 1 registry-dispatched call, same endpoint (entities+vitals still one HTTP call) | 0 |
| Groundedness | 0 (default off) or 1 call ≤5s + 1 bounded retry (`:404-407`) | same, now selectable via toolPlan (default follows env) | 0 |
| Redis publish/stats, durable write (30s-throttled), trajectory (fire-and-forget) | `:937-989` | + agent block in the throttled durable metaData; + one Redis `SET` **at start only** | ~0 |

Conclusion: the ~5s flush budget continues to hold 1 LLM call + 1 NLP call (+ optional groundedness) and nothing else — the OD-5(b) envelope. An OD-5(a) model-initiated loop would add ≥1 additional serial LLM round-trip per tool call (2–10s) and an unbounded worst case; it remains excluded from the live path and reachable later only through the registry's `describe()` seam with an explicit round cap (README C4 fallback clause).

---

## 10. Rollout plan & behavior-identical proof (DR-8)

Order: **C2 → (C3 ∥ C4) → C5 → C6.** C3 and C4 both edit `flush()`; they may run in parallel only if C3 codes against the `ResolvedToolPlan`/registry interfaces frozen in this document and C4 owns the executor extraction — otherwise serialize C4 → C3. Each step lands with its invariants green; no step turns any tenant-visible behavior on (opt-in = a tenant admin setting a binding via the API).

| Step | Invariant tests (write FIRST, per TDD) |
|---|---|
| **C2** | **C2-T1** byte-compare: seeded SYSTEM live template `content` sha256 === sha256(`LIVE_SOAP_STABLE_SYSTEM_PREFIX`) AND `metaData.promptConfig.systemPrompt` === the `:1668-1669` literal (test in `packages/applications` importing the seed module — the sanctioned cross-package divergence-guard pattern of `07b:105-113`). **C2-T2** agent-vs-column resolution equality: all 7×2 ArcaAI cells resolve identical `promptId`/`versionNumber`/`content` via agent tier vs a column-only fixture; `resolvedFrom` flip asserted intentional; compat `resolvedFrom==='default'` guard unaffected. **C2-T3** seed id-equality test (replaces `arcaai-zero-department-agents.test.ts`). **C2-T4** `gen:model`/`gen:entity`/`gen:factory` no-drift + coverage OK; fidelity suite (15 locked constants) untouched-and-green; `system-pre-summary-default-checksum` green. **C2-T5** B-12 trio (§8.5). **C2-T6** compat pre-summary resolution snapshot: same template id + content pre/post C2. **C2-T7** existing-agent null-binding fallback: an agent with null visit bindings resolves its base template for both visit types (the 36-row no-op proof). |
| **C3** | **C3-T1** default-prompt parity: with the resolver returning the SYSTEM default (or port absent), the exact SMR payload (`prompt` + `system_prompt`) of a flush is byte-identical to the pre-C3 implementation (golden-string fixture). **C3-T2** freeze semantics: approve/edit the bound template mid-session → subsequent flushes still serve the frozen bytes; Redis-adopt path: second instance `start()` adopts the stored snapshot (unit: mock cache). **C3-T3** SSE DTO additive-only: serialize a payload without agent metadata → deep-equals the pre-C3 shape; with it → only `metadata.agent` added. **C3-T4** fail-open: resolver port throws → session starts, flushes with code-default snapshot, no error surfaces to the controller. **C3-T5** existing suite green (throttle, lock, windowed/delta, grounding, trajectory). |
| **C4** | **C4-T1** unconfigured/null `toolConfig` ⇒ executor sequence and HTTP calls identical to today (one NLP call producing entities+vitals; groundedness iff env-enabled) — spy-based parity test. **C4-T2** `ner.enabled:false` ⇒ no NLP call, entities/vitals absent, grounding of prior entities still re-runs against the current note. **C4-T3** unknown tool key in `toolConfig` rejected at service write (400) AND ignored-with-warn at read (defense-in-depth mirror of `applyAgentOverrides`, `harness-policy.service.ts:462-479`). **C4-T4** anti-laundering lock: a static/spy test asserting extraction executors receive `nerSourceText` (delta), never `runningSummary`. |
| **C5** | **C5-T1** lineage present ⇒ prior-draft injected with flag OFF; lineage absent ⇒ flag still gates (legacy posture locked). **C5-T2** `pinnedAgentId` beats a re-pointed department default; missing agent falls through without error; tier-0 preferred still wins. **C5-T3** `SummaryMeta` rows: new columns null on non-live summaries (additive proof); populated + `preSummaryIds` carries the snapshot id on lineage summaries. **C5-T4** harness `assemble`/`persistDraft` see the same frozen row + stamp identical lineage. |
| **C6** | Full-suite layer gates; live e2e (start → SSE with `metadata.agent` → stop → finalize → `SummaryMeta.sessionAgentId` matches); crash-recovery e2e (kill owner instance mid-session → restart → same frozen `(templateId, versionNumber)` in subsequent SSE metadata); evidence into README §7. |
| **(D2, Lane D)** | Seeds the dept-free fork per §4.3.1, flips native pre-summary call sites to `preSummaryVariant: 'dept-free'`, adds its checksum entry; **D2-T1** compat pre-summary still byte-identical (the C2-T6 snapshot re-run). Until D2, the `preSummaryVariant` mechanism ships dormant — Lane C changes native pre-summary behavior by zero bytes. |

---

## 11. Admin-surface deferral (DR-9)

**Usable without any new UI** (rule-12 Figma gate untouched):
- Every default path works from seeds alone: SYSTEM live template (C2) serves all tenants; ArcaAI's dept×visit agents are behavior-identical; golden/Global agents unchanged; pre-summary chains unchanged until D2.
- Tenant opt-in surface = the existing DepartmentAgent REST API (`admin/department-agents` CRUD, OCC-guarded): C2 extends `CreateDepartmentAgentRequest`/`UpdateDepartmentAgentRequest`/`DepartmentAgentResponse` (+ dto mapper) with the six optional fields — every field class-validator-declared + `@ApiPropertyOptional` (the global whitelist pipe rejects undeclared fields, so this is mandatory, not cosmetic). `templateLocked` stays absent from DTOs (existing posture, `department-agent.prisma:18-19`).

**What the future UI ticket will need from the API (all delivered by C2/C3, so no API rework later):**
1. Capability-binding editors: template pickers filtered by department/scope (existing prompt-management list routes; post-§8 the picker may also want a "platform library" toggle — that is the dedicated global-admin-fed endpoint 07a §34-41 anticipated, not a scope change).
2. Per-task LLM override selects: fed by `GET /text/providers` (README §2.5.3) + validated server-side against ENABLED `AiModel` rows (same rule as B1).
3. `toolConfig` editing: `CodeEditor` per rule 11; server-side validation errors already structured (C4-T3).
4. Lineage display: SSE `metadata.agent` (live panel badge) and `SummaryMeta.sessionAgentId`/`sessionAgentPromptVersion` (summary detail) — both shipped.
5. Live-default template visibility: the SYSTEM template row is readable by tag `'live-summary'` post-§8.

---

## 12. Risk register

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | Read-widening (§8) leaks SYSTEM rows into tenant *list* UIs (the 07a §34-41 objection) | M | Explicit caller-`tenantId` pin on prompt-management list/count reads (C2); list-content snapshot test; by-id reads only get the widening |
| R2 | `resolvedFrom` flip `'department'`→`'agent'` for ArcaAI breaks a consumer keying on the tier | M | Only behavioral consumer is compat's `=== 'default'` guard (`smr-compat-template.service.ts:74`) — unaffected; `SummaryMeta.promptResolvedFrom` is provenance-only; C2-T2 asserts the flip and greps consumers |
| R3 | Frozen-snapshot Redis key lost mid-session (eviction/outage) → silent re-resolve to newer content | M | Three-tier recovery (Redis → durable metaData pin → fresh resolve); key TTL refreshed with lock renewal; version pin in durable metaData makes byte-drift detectable in C6 crash e2e |
| R4 | Resync sweep interacts badly with the restored ArcaAI agents | M | Golden-slug seeding makes rule (i) a no-op and rule (iii) protects unlocked rows (§5.2); a C2 test runs the sweep against seeded ArcaAI and asserts `{added:0, fastForwarded:0}` |
| R5 | Eval gate blind spot: capability-bound templates ungated at approve | L→M | `findByBoundTemplate` OR-lookup in C2; live/pre-summary bindings deliberately eval-exempt (documented, §DR-1); follow-on ticket noted |
| R6 | `llmOverrides` names a model the tenant later disables → frozen selection targets a dead model | L | Freeze stores the resolved pair; an SMR-side failure hits the existing per-flush `smrFailed` containment (last-good note retained, `:864-868`); next session re-resolves and degrades to tenant default with a warn |
| R7 | C3/C4 parallel edits collide in `flush()` | M | Interfaces frozen here; C4 owns executor extraction, C3 owns session/prompt/LLM; if the teams can't honor the seam, serialize C4→C3 (coordinator's call at dispatch) |
| R8 | Unconditional lineage injection (DR-4) surprises a tenant that relied on warm-start-off | L | Lineage exists only after C3 ships the agent loop for that session; pre-C3 sessions have no lineage → flag still governs; release note in README §7 |
| R9 | `preSummaryVariant` default drift (someone flips native callers before D2) | M | C-lane tests C2-T6 lock compat AND native pre-summary resolution snapshots; D2 owns the flip with its own gate |
| R10 | Byte-parity between constants and seed silently broken by a later edit | M | C2-T1 sha256 parity test is permanent (mirrors the `PRE_SUMMARY_VARIABLES` divergence guard, `07b:105-113`) |

---

## 13. Exact touch list for C2–C5

Every entry: file → function/region → nature of change. Paths absolute from repo root. "NEW" = file created by that task.

### C2 — schema, domain trio, seeds, DTOs, B-12 (one agent)

| File | Function / region | Change |
|---|---|---|
| `packages/database/src/prisma/db_main/department-agent.prisma` | model `DepartmentAgent`, binding section (after `:44`) | +6 nullable columns (§3.1) + doc comments |
| `packages/database/src/prisma/db_main/consultation.prisma` | model `SummaryMeta`, provenance block (after `:279`) | + `sessionAgentId`, `sessionAgentPromptVersion` |
| `packages/database/src/prisma/db_main/migrations/<ts>_task_635_agent_capability_bindings/migration.sql` | NEW | additive `ALTER TABLE` ×8 columns |
| `packages/database/src/prisma/db_main/migrations/<ts>_task_635_reown_system_pre_summary_default/migration.sql` | NEW | §3.3.2 data migration (`…040`, `V40`) |
| `packages/domains/src/models/generated/core/DepartmentAgentModel.ts`, `SummaryMetaModel.ts` | — | regenerated via `pnpm gen:model` only |
| `packages/domains/src/entities/generated/core/DepartmentAgentEntity.ts` | class body | +6 `setProperty`-routed accessors (hand-edit) |
| `packages/domains/src/factories/generated/core/DepartmentAgentFactory.ts` | `CreateDepartmentAgent` | +6 optional props (hand-edit) |
| `packages/domains/src/mappers/generated/core/DepartmentAgentEntityMapper.ts` | field maps | +6 mappings; `FIELDS_NOT_WRITABLE`/`stripNonWritableFields` untouched (hand-edit; never `gen:mapper`) |
| `packages/domains/src/repositories/generated/core/DepartmentAgentRepository.ts` | + `findByBoundTemplate(tenantId, templateId)` | OR-filter across the 5 binding columns (hand-edit) |
| `packages/domains/src/{entities,factories,mappers}/generated/core/SummaryMeta*.ts` | — | +2 fields each (hand-edit, same discipline) |
| `packages/database/src/extensions/tenant-scope.ts` | `SYSTEM_SHARED_READ_MODELS` (`:262-360`) | + `PromptTemplate`, `PromptVersion` with justification comments |
| `packages/database/src/prisma/db_main/seed/00-constants.ts` | id-block docs | + `…-0004-…` block, `SYSTEM_LIVE_SOAP_TEMPLATE_ID`, reserved D2 id |
| `packages/database/src/prisma/db_main/seed/07c-live-agent-defaults.ts` | NEW | SYSTEM live template + v1 version (§3.5.2); exports the content constants for the parity test |
| `packages/database/src/prisma/db_main/seed/index.ts` (seed runner) | phase 3 registration | + `seedLiveAgentDefaults` after 07b |
| `packages/database/src/prisma/db_main/seed/07a-agent-golden-library.ts` | `:270-280` NOTE + new `ARCAAI_TENANT_AGENTS` export + `seedAgentGoldenLibrary` | restore 7 ArcaAI agents per §5.2; upsert them |
| `packages/database/src/prisma/db_main/seed/07-prompt-template.ts` | `…040` row (`:1620-1641`) + `V40` + `:1615-1619` NOTE | tenantId → SYSTEM; `approvedVersionNumber: 1`; NOTE rewrite |
| `packages/database/src/prisma/db_main/seed/04-department.ts` | `:341-360` prose | invariant text updated (columns = deprecated tier-1b) |
| `packages/database/src/prisma/db_main/seed/__tests__/arcaai-zero-department-agents.test.ts` | DELETE | replaced per RF-3 |
| `packages/database/src/prisma/db_main/seed/__tests__/arcaai-agent-column-equality.test.ts` | NEW | C2-T3 id-equality |
| `packages/applications/src/services/prompt-management/prompt-management.service.ts` | template list/count reads | explicit `tenantId: <caller>` filter pin (R1) |
| `packages/applications/src/services/departmentAgent/departmentAgent.service.ts` | `create` (`:100`), `update` (`:148`), `clone` (`:320`) | accept/copy the 6 fields; per-binding `assertTemplateBindable`; `validateToolConfig` + `validateLlmOverrides` (new privates; LLM slugs vs ENABLED TEXT_GENERATION `AiModel` rows) |
| `packages/applications/src/services/departmentAgent/dto/{create,update}-department-agent.request.ts`, `…response.ts`, `departmentAgent.dto.mapper.ts` | DTO classes | +6 optional validated fields / response fields |
| `packages/applications/src/services/departmentAgent/constants.ts` | + `LIVE_TOOL_KEYS`, toolConfig/llmOverrides validators' allow-lists | shared with C4 registry |
| `packages/applications/src/services/departmentAgent/agent-template-resync.service.ts` | rule-(i) clone construction | copy capability columns from golden row; + sweep-no-op test vs seeded ArcaAI (R4) |
| `packages/applications/src/services/eval/eval-promotion-gate.service.ts` | `evaluatePromotion` (`:80-81`) | agent lookup via `findByBoundTemplate` |
| `packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts` | `SYSTEM_DEFAULTS` (`:173-183`); `resolveSummaryPromptId` (`:313-375`); `resolvePreSummaryPromptId` (`:394-436`); `findTenantPreSummaryTemplateId` (`:464-490`); `resolveDepartmentAgent` (`:563-593`) | + `livePromptId`/`deptFreePreSummaryPromptId`; visit-type-aware agent tier; agent pre-summary tier + variant tag filter (default `'v1'`); parameterize agent snapshot resolution by selected template id. (The `'live'` chain itself is C3's entry below — C2 lands only what C2-T2/T6 need: the summary + pre-summary tier changes) |
| `packages/applications/src/services/consultation/prompt/__tests__/…` + `packages/database/src/__tests__/…` | NEW/extended | C2-T1…T7, §8.5 B-12 trio |

### C3 — live-loop integration (one agent)

| File | Function / region | Change |
|---|---|---|
| `packages/applications/src/services/consultation/live-documentation/live-agent.port.ts` | NEW | `ILiveAgentResolver` symbol, `FrozenLiveAgentSnapshot`, `ResolvedToolPlan` types (§6.1) |
| `packages/applications/src/services/consultation/prompt/live-agent-resolution.service.ts` | NEW | port implementation (§6.1 steps 1–5); never-throws contract |
| `packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts` | + `resolveLivePromptId` (new chain, §4.4); `promptType` union + dispatch (`:255-259`); `PromptResolutionTier` + `'code-default'` (`:112`) | live capability chain |
| `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts` | constructor (`:334-367`); `LiveSession` (`:145-205`); `start` (`:449-503`); new `ensureAgentResolved` + Redis agent-key helpers (beside `:1915-1931`); `flush` (`:688-992`); `buildSmrUserPrompt` (`:1542-1568`); `callSmr` (`:1639-1692`); `persistDurableSnapshot` metaData (`:1466`); `recordFlushTrajectory` (`:1030-1043`) | §6.2 in full; constants remain exported as tier-3 source |
| `packages/applications/src/services/consultation/live-documentation/dto/live-summary.dto.ts` | `LiveSummaryMetadataDto` (`:240` region) | + optional `agent: LiveSummaryAgentDto` (NEW class) |
| `packages/applications/src/services/consultation/consultation.service.module.ts` (or the module providing live-doc) + `apps/api/src/modules/consultation/consultation.module.ts` | providers | register `LiveAgentResolutionService` under `ILiveAgentResolver` |
| `packages/applications/src/services/consultation/live-documentation/__tests__/…` | NEW/extended | C3-T1…T5 |

### C4 — tool layer (one agent)

| File | Function / region | Change |
|---|---|---|
| `packages/applications/src/services/consultation/live-documentation/live-tool-registry.ts` | NEW | `LiveToolRegistry`, `LiveToolExecutor` interface (`execute` + optional `describe()` OD-5-later seam), executors `nlp.classify-tokens` (body moved from `callNlp` `:1710-1741`, incl. `resolveNerModelInjection`) and `guardrail.groundedness` (body moved from `checkGroundedness` `:1826-1858` + `mapGroundednessResponse` `:1867-1913`); `resolveToolPlan(toolConfig | null)` normalizer (defaults = today) |
| `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts` | `flush` tool section (`:877-910`) | dispatch via registry per `agent.toolPlan`; `groundEntitiesToNote`/`mergeVitals` calls unchanged after dispatch |
| `packages/applications/src/services/departmentAgent/constants.ts` | `LIVE_TOOL_KEYS` (stubbed in C2) | keyed to the registry's executor keys — single allow-list for write-validation and read-dispatch |
| `packages/applications/src/services/consultation/live-documentation/__tests__/live-tool-registry.test.ts` (NEW) + service tests | | C4-T1…T4 |

**toolConfig JSON shape (frozen here, validated in C2's service, consumed by C4):**

```jsonc
{
  "version": 1,                        // schema-evolution anchor — model-initiated
                                       // mode arrives later as `"mode"` w/o churn
  "tools": {
    "ner":          { "enabled": true },   // → executor nlp.classify-tokens (entities)
    "vitals":       { "enabled": true },   // same NLP response's vitals block (filtered off when false)
    "groundedness": { "enabled": null }    // null ⇒ follow LIVE_DOC_GROUNDEDNESS_ENABLED env
  }
}
```
Null/absent `toolConfig` ⇒ the exact object above ⇒ today's behavior. Unknown keys: 400 at write, warn+ignore at read (C4-T3).

### C5 — finalize lineage (one agent)

| File | Function / region | Change |
|---|---|---|
| `packages/applications/src/services/consultation/summary/summary.service.ts` | `resolveWarmStartPreSummaryText` (`:1399-1407`) → `resolveWarmStartPreSummary`; `generateSummary` (`:407`, `:413-422`, `:454-465`) | lineage surfacing; `preSummaryLineage`/`pinnedAgentId` into assemble; `SummaryMeta` lineage columns + `preSummaryIds` |
| `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts` | `PromptAssemblyParams` (`:203-267`); `assemble` resolver call (`:432-443`); warm-start gate (`:534`) | + `preSummaryLineage`, `pinnedAgentId`; lineage-unconditional injection (DR-4) |
| `packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts` | summary chain tier-1a (§4.2) | `pinnedAgentId` handling (§7.4) |
| `packages/applications/src/services/consultation/harness/harness-internal.service.ts` | `assemble` (`:544`, `:570-592`); `persistDraft` (`:694`, SummaryMeta creation `:710-`) | unconditional snapshot load + lineage-gated injection; lineage stamping (§7.5) |
| `packages/applications/src/services/consultation/summary/__tests__/…`, `…/harness/__tests__/…`, `…/prompt/__tests__/…` | NEW/extended | C5-T1…T4 |
| `apps/api/tests/e2e/task-635-live-agent-lineage.spec.ts` | NEW (executed in C6) | start→SSE-agent-metadata→stop→finalize lineage; crash-recovery pin |

---

*End of C1. Owner review gates C2 dispatch (README §5 Lane C: "C1 design reviewed & approved by owner BEFORE C2").*
