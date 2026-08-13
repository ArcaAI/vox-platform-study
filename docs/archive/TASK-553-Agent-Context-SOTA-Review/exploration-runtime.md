# TASK-553 — Exploration Report 1: Agentic Loop Runtime (apps/harness)

Produced by the TASK-553 exploration pass on 2026-07-24. All claims anchored to file:line
in the working tree of branch `fix/2605-review`.

Scope note up front, because it changes how every other section should be read: **there are
two independent "loops" in this codebase**, and the ticket's framing ("agents monitor
realtime consultation transcripts") mostly describes the one that is **not** in `apps/harness`:

- **Live-documentation loop** (TypeScript, `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts`) — genuinely realtime: ingests transcript segments as they arrive, debounces/thresholds, calls SMR directly. No Temporal, no `apps/harness` involvement at all.
- **Harness async doc loop** (Python, `apps/harness`, Temporal `HarnessDocWorkflow`) — a **single-shot, durable** guides→generate→sensors→gate pass over an **already-complete** transcript, triggered once per consultation by a `TranscriptionCreated` event, with bounded internal regeneration for quality (not for incorporating new transcript content over time).

Everything below is about the second one, with the first cross-referenced only where it
clarifies scope.

---

## 1. The loop itself

**Files**: `apps/harness/src/harness/temporal/{workflows.py,activities.py,models.py,worker.py,claim_check.py}`

### Workflow/activity split

- `HarnessDocWorkflow` (`apps/harness/src/harness/temporal/workflows.py:222-1507`) is the single deterministic workflow. Every I/O call is delegated to an `@activity.defn` in `activities.py` (1981 lines, ~28 activities, listed at `activities.py:158-1924`). The workflow imports activity stubs + the pure sensor aggregator through `workflow.unsafe.imports_passed_through()` (`workflows.py:27-88`).
- Task queue: `settings.temporal.task_queue` (`worker.py:191-199`), one worker process hosts both `HarnessPingWorkflow` and `HarnessDocWorkflow` plus all `DOCUMENT_ACTIVITIES`.

### Signals/queries (the *only* realtime input this workflow accepts)

- `approval` signal (`workflows.py:281-284`) — clinician sign-off, resolves the gate wait.
- `edit` signal (`workflows.py:286-301`) — clinician edited the optimistically-delivered draft; sets per-pass latch `_edited` and sticky `_ever_edited`.
- `phase` query (`workflows.py:303-306`) — ops/debug only.
- **There is no signal for incoming transcript text/segments.** The full transcript is a one-time value on `HarnessDocWorkflowInput.transcript_text` (`models.py:83-90`), set at `document:start` and never updated for the life of the workflow run.

### Iteration / termination

Bounded regen loop (`workflows.py:685-871`, legacy path) or its optimistic-delivery twin (`workflows.py:972-1276`):
1. `assemble_prompt` → `generate` → `extract_entities` (note NER) → `run_sensors` (5 cheap computational sensors) → `aggregate()` (`sensors/aggregator.py:97-144`).
2. Cheap verdict first (`workflows.py:778-793`): REGEN while `regens_used < gate.max_regen` and budget not exhausted → loop with corrective feedback; else fall through to the costly `run_inferential_sensors` (groundedness + safety + citation-verify + optional atomic-fact) once per settle, folded into a final `aggregate()` (`workflows.py:856-871`).
3. Termination is **fail-safe by construction**, decided in `sensors/aggregator.py:97-144`: any degraded/missing-expected sensor → `FLAG` (`:108-113`); highest-harm sensors (`entity_faithfulness`, `numeric_dose`, `safety`, `aggregator.py:55`) failing → `FLAG` unconditionally (never regenerated); regen-fixable sensors (`schema_validity`/`coverage_omission`/`citation_presence`/`groundedness`/`citation_verify`/`atomic_fact`, `aggregator.py:64-71`) → `REGEN` while budget remains, else `FLAG`.
4. Gate wait (`workflows.py:1422-1476`): `workflow.wait_condition` raced against `gate.gate_sla_seconds`, escalating via `escalate_gate` every `gate_escalation_seconds` up to terminal bound `gate.gate_max_escalations` (patch-gated `task-458-gate-terminal-abandon`, `workflows.py:1432,1442,1456-1457`) — an unsigned draft eventually *abandons* rather than escalating forever.

### Budget enforcement

- **Regens**: `HarnessGateConfig.max_regen` (default 2, `models.py:43`), checked at **three** call sites (`workflows.py:788`, `:862`, `:1244-1254`) — the third (post-delivery "regen-if-untouched") was DR-12 in TASK-533 (fixed); all three now carry `and not budget_stopped`.
- **Tokens**: `_tokens_from_stats` (`workflows.py:170-192`) folds `generated.stats` into `tokens_used`; `_budget_exhausted` (`workflows.py:195-201`) stops the loop when `token_budget_per_run > 0` and spent ≥ budget. `token_budget_per_run` defaults to **0 = unbounded** (`models.py:49`), only becomes non-zero via `HarnessPolicy.token_budget_per_run` (`agentic.context.tokenBudget.perRun`).
- **Cost ($)**: no cost enforcement in the workflow at all; $-estimation exists only downstream in the TS trajectory rollup (`agent-trajectory.service.ts`, `aggregateGenerationStats`) driven by `AiModel.metaData.pricing` — informational, not a loop gate.
- **Wall-clock**: `_ACTIVITY_TIMEOUT=150s`, `_INFERENTIAL_TIMEOUT=900s` + `_INFERENTIAL_HEARTBEAT_TIMEOUT=60s` (`workflows.py:94-110`), `_MCP_TIMEOUT=30s`, `_PROGRESS_TIMEOUT=10s`.

### Replay-compat posture

- 10 distinct `workflow.patched()` eras currently in `workflows.py`: `task-345-harness-progress` (:320), `task-348-failure-terminal` (:368), `task-355-optimistic-delivery` (:657-659), `task-355-assurance-signals` (:1136), `task-458-edit-rerun-cap` (:1208), `task-458-gate-terminal-abandon` (:1432), `task-481-optimistic-retraction` (:1296), `task-516-mcp-tools` (:575), `task-551-redaction` (:890), `task-551-redaction-audit` (:914). **This is 2 more than the "8 eras" TASK-533's README states** (`docs/implementation/TASK-533-Agentic-Loop-Completion/README.md:126,198,220`) — stale, TASK-551 landed after. Coverage: `apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py` has a forward-guard test per era.
- Most feature additions since are deliberately **command-neutral** (additive-optional fields on activity inputs/outputs — `phi_enabled`, `prior_verdicts`, claim-check refs, budget). Note at `workflows.py:106-109`: activity **option** changes (timeouts) are replay-safe without a patch gate, "proven by test_replay_compat.py."

---

## 2. Prompt / instruction assembly — exact order, file:line

Spans **two processes and three layers**. The harness Python side does *not* build the clinical prompt template — it calls back into apps/api (`assemble_prompt` activity → NestJS `PromptAssemblyService`) and then folds in RAG/segment/regen-critique blocks itself.

### Layer 1 — apps/api template + variable assembly (`PromptAssemblyService.assemble`, `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts:323-431`)

Entry point: harness activity `assemble_prompt` (`apps/harness/src/harness/temporal/activities.py:872-909`) → HTTP `POST /internal/harness/consultations/{id}/assemble` → `harness-internal.controller.ts:266-270` → `HarnessInternalService.assemble` (`packages/applications/src/services/consultation/harness/harness-internal.service.ts:342-458`).

`harness-internal.service.ts:342-458` gathers, **before** calling the prompt assembler:
1. Transcript = join of all transcript `ContextItem`s (`:355-356`).
2. NER entities (`:358`), clinician case/work notes labeled `[case note]`/`[work note]` (`:365-374`), attachment extracted text (`:375-384`), manual highlight spans labeled `[highlight]` (`:391-392`).
3. Live SOAP snapshot for warm-start, gated on `resolveWarmStartEnabled` (`:399`).
4. Doctor's Tier-0 preferred template id (`:406-408`) and effective DNA-style id (tenant+doctor gate, `:414`).
5. `promptType` computed as `consultation?.parentConsultationId ? 'revisit' : 'new-patient'` (`:422`) — **this is the entire "new-visit vs re-visit" decision**; it only changes which department prompt-id column resolves; nothing else carries prior-visit content (see §3).

Then `PromptAssemblyService.assemble()` (`prompt-assembly.service.ts:323-431`), **in this exact order**:

1. **Template resolution** — `PromptResolutionService.resolve()` (`prompt-resolution.service.ts:147-291`), 4-tier cascade, most-specific wins: Tier-0 doctor-preferred (`:155-156,246-248`) → Tier-1a department-default `DepartmentAgent` pinned `PromptVersion` snapshot (`:201-211,301-330`, TASK-546) → Tier-1 legacy department `newPatientPromptId`/`revisitPromptId`/`preSummaryPromptId` columns, APPROVED-gated (`:213-243`) → Tier-2 hardcoded `SYSTEM_DEFAULTS` (CATCHALL_SOAP, `:118-121`).
2. `userPrompt = substituteVariables(template.content, variables)` (`prompt-assembly.service.ts:336-337`), or raw transcript if no template resolved (`:339`). Variables built in `buildVariables` (`:433-470`): `conversation_language`, `ner_entities`, `clinician_notes`, `attachments`, `doctor_highlights`, optional `pre_summary_text`/`same_day_prequel_summary`, and `style_DNA_*` (11 hardcoded department-scoped keys, `:472-486`).
3. **Few-shot exemplar block** (gate-edit mining, TASK-533 B6) appended **before** the transcript, ≤3 exemplars (`:285-321,346`) — framed as "notes from OTHER patients... never carry a clinical fact... across from them" (`:315-318`).
4. `--- TRANSCRIPT ---` appended only if the template didn't already consume it (`:348-350`).
5. `--- RECOGNIZED CLINICAL ENTITIES (from NER) ---` if not already consumed (`:352-357`).
6. `--- CLINICIAN NOTES (case / work notes) ---` (`:359-365`).
7. `--- ATTACHMENTS (lab / exam results) ---` (`:367-370`).
8. `--- DOCTOR HIGHLIGHTS (clinician-flagged spans) ---` (`:372-379`).
9. `--- PRIOR DRAFT (running SOAP note from the live session — STAGE 1 SCRATCHPAD) ---` + refine-not-regenerate instruction, gated on `resolveWarmStartEnabled` (`:381-405`) — warm-start from the **same live session**, not a prior visit.
10. `systemPrompt = 'You are a medical scribe AI assistant.'` — **a single hardcoded literal, no DNA, no policy, no per-department text ever reaches the system role** (`:413`). There is no "system prompt layering" in this codebase; everything is folded into the user prompt.
11. `responseFormat` from `template.metaData.promptConfig.outputSchema` if present (`:407-411`).

Returned to the harness as `AssembleResponse` (`apps/harness/src/harness/services/api_client.py:38-59`).

### Layer 2 — harness-side RAG/segment/critique folding (`generate` activity, `activities.py:912-1048`)

`assemble_generation_prompt()` (`apps/harness/src/harness/temporal/prompt_cache.py:116-147`), called at `activities.py:935-940`, appends onto the user_prompt, **in this exact stable-prefix order** (module docstring `prompt_cache.py:1-15` states the ordering is a tested contract):
1. `user_prompt` (template + transcript, from Layer 1) — the stable, cacheable prefix.
2. RAG **StrictCitations** Knowledge Context block, `build_strict_citations_block()` (`apps/harness/src/harness/guides/retrieval/prompt.py:36-51`) from `retrieve_context` activity output — one numbered `[i] id=<chunk_id>: <text>` line per chunk, instructing `[[kb:<id>]]` citation markers.
3. Transcript-**segment** StrictCitations block, `build_segment_citations_block()` (`prompt_cache.py:78-101`) — PHI-safe (`id`/`idx`/`speaker`/`t0`/`t1` only, never plaintext), instructing `[[seg:<id>]]` markers.
4. Regen-feedback corrective suffix (`render_regen_feedback_block`, `prompt_cache.py:181-197`), **only on a regen iteration** and only when `regenFeedbackEnabled` — fixed preamble (`CORRECTIVE_RETRY_PREAMBLE`, `:34-38`) plus one numbered per-sensor "expected fix" (`_EXPECTED_FIX`, `:42-63`) and the specific flagged claims.

Then `system_prompt` is resolved inline-or-ref (`activities.py:941-946`), and **both** prompts pass through the fail-closed PHI egress guard `ensure_egress_safe()` (`apps/harness/src/harness/guards/phi/egress.py:37-68`) before the SMR call — no-op for local/self-hosted providers, redact-and-confirm (or block) for cloud.

### Policy overlays (HarnessPolicy + TASK-550 per-agent overrides)

Resolved **once** at workflow start via `fetch_policy` (`activities.py:555-591`), snapshotted for the whole run (`workflows.py:384-499`). Resolution order (TS side, `harness-policy.service.ts:355-407`): **code default → SYSTEM `HarnessPolicy` row → tenant `HarnessPolicy` row → `DepartmentAgent.harnessOverrides`** via `applyAgentOverrides()` (`:429-`), read-time-filtered against `TENANT_TIER_HARNESS_OVERRIDE_KEYS` (imported `:19`) so a stray global-only key in the JSONB is dropped+warned, mirroring `GLOBAL_ADMIN_ONLY_POLICY_KEYS` SYSTEM overlay (`:130,380-383`). Selection/judge/MCP-registry knobs are **always** overlaid from SYSTEM regardless of which policy row won (`:374-388`). Only `coverageThreshold`/thresholds/`maxRegen`/gate-SLA/`toolAllowlist` are agent-overridable (live-verified in TASK-550, `docs/implementation/TASK-550-Per-Agent-Harness-Overrides/README.md:114-140`).

Tool definitions: MCP servers snapshotted onto the policy as `McpServerConfig` (`models.py:219-254`), first-enabled-server-with-the-tool selection is pure/deterministic (`_select_mcp_server`, `workflows.py:142-152`), read-only terminology-validation is the only wired tool (`MCP_TERMINOLOGY_TOOL = "validate_codes"`, `workflows.py:139`).

---

## 3. Context management

### Across loop iterations (within one run)

**No compaction, no summarization, no truncation of the transcript.** `inp.transcript_text` is a single immutable string threaded unchanged through every `extract_entities`/`run_sensors`/`run_inferential_sensors`/`generate` call for the life of the run (`workflows.py:521,759,815,956,1096,1165`). Every regen iteration re-sends the **entire** template+transcript prefix verbatim; the only thing that changes between iterations is the trailing regen-feedback suffix (§2). Deliberate design (`prompt_cache.py:1-15`): keep the invariant prefix byte-identical so an inference-engine-level KV-cache (vLLM/llama.cpp `cache_prompt`) can reuse it — there is **no explicit provider-side prompt-caching API call** (no `cache_control`/`prompt_cache_key` anywhere in `apps/harness/src/harness/services/smr_client.py`); relies entirely on prefix stability + whatever the SMR backend does automatically.

**Token counting** exists only as bookkeeping, not as a truncation trigger: `_tokens_from_stats()` (`workflows.py:170-192`) reads token counts off the already-returned generation stats — it cannot preemptively shrink a prompt; it only decides whether to *stop looping*.

### Temporal-history size management (claim-check, not context management)

Large blobs (transcript, assembled prompt, generated note, RAG chunk texts) are offloaded via the claim-check pattern (`apps/harness/src/harness/temporal/claim_check.py:1-273`) when ≥ `min_bytes` (default 64 KiB, `core/config.py:215`): `_offload_text()` (`activities.py:523-534`) stores content-addressed (sha256) via `S3BlobStore`/`InMemoryBlobStore` (`claim_check.py:99-197`) and threads only a small `ClaimCheckRef` through workflow history; `_resolve_ref()` dereferences at each activity's edge (`activities.py:516-520`). Solves Temporal's ~50MB history budget, not LLM context-window pressure — the full text is still sent to the LLM every call.

### Memory/notes persistence — within a session vs across sessions

- **Within-session (warm-start)**: running live SOAP snapshot injected as `{pre_summary_text}` with an explicit "refine, don't regenerate" instruction (`prompt-assembly.service.ts:392-405`) — gated on `resolveWarmStartEnabled` (per-tenant `HarnessPolicy.warmStartEnabled`, env `HARNESS_WARM_START_ENABLED` fallback). The one real "memory" mechanism; only bridges the live in-session note into the harness's async doc pass — not across visits.
- **Across sessions (revisit continuity) — effectively absent.** `PromptAssemblyParams.sameDayPrequelSummary` and its `{same_day_prequel_summary}` variable exist (`prompt-assembly.service.ts:158,452-454`), but **zero producers anywhere in applications+api** (grep-confirmed). The `promptType: 'revisit'` branch (`harness-internal.service.ts:422`) changes only *which template resolves* (`department.revisitPromptId` vs `newPatientPromptId`, `prompt-resolution.service.ts:167-172,221-226`); it injects no content from the patient's prior visit. A "re-visit" run and a "new-visit" run see the same kind of context — a different template, not a different memory.
- **Across encounters, cross-patient (learning loop)**: only durable cross-session memory is the few-shot exemplar block (§2 step 3) sourced from `GateEditExemplar` (redacted, `APPROVED_CLEAN` gate-edit outcomes from *other* patients) — explicitly not per-patient continuity, explicitly not fine-tuning (TASK-533 §3.4).

### Between-iteration verdict caching

`verdict_cache: dict[str, bool]` (`workflows.py:684`) threaded from one `run_inferential_sensors` pass's output into the next regen's input (`RunInferentialSensorsInput.prior_verdicts`, `workflows.py:832,1191`) so an **unchanged claim** across regens reuses its previously-computed groundedness/citation/safety verdict instead of re-invoking the judge (`activities.py:1402,1510-1525`). A claim-level judge-call cache, orthogonal to LLM prompt caching.

### Live-documentation windowing (TS side — NOT the harness loop)

`live-documentation.service.ts` implements real incremental-delta handling with two modes selected by `agentic.context.transcript.mode` — `whole` (carry-forward: unsent backlog truncated at `liveDeltaMaxChars`, overflow carried to next flush, `:730-744`) and `windowed` (most-recent segments only, older backlog **permanently elided**, `:704-728`, logged at `:750-758`). Lives entirely outside `apps/harness`; **not** consumed by the harness's `assemble()` call — the harness async doc pass always gets the full transcript (§2, `harness-internal.service.ts:355-356`).

---

## 4. Realtime ingestion into the loop

**The harness Temporal loop has no realtime ingestion mechanism.** Triggered exactly once per consultation:

1. `SttInternalService.persistTranscriptSegments` finishes writing a full transcript `ContextItem` → emits `ConsultationPipelineEvent.TranscriptionCreated`.
2. `ConsultationEventHandler.handleTranscriptionCreated` (`packages/applications/src/services/consultation/events/consultation-event.handler.ts:93-191`) checks `pipelineConfig.harnessEnabled` (`:146`); if set, best-effort loads the transcript text (`:152-163`), resolves TASK-551 redaction rules (`:170`), and calls `HarnessGatewayService.start()` (`:172-181`) — a single fire-and-forget POST.
3. `HarnessGatewayService` (`harness-gateway.service.ts:142`) → `POST /api/v1/internal/consultations/{id}/document:start` → `apps/harness/src/harness/api/endpoints/internal.py:132-223` → `client.start_workflow(HarnessDocWorkflow.run, wf_input, ...)` with **deterministic workflow id** `harness-doc-{consultation_id}` (`internal.py:75-77`), so duplicate start is idempotent (`WorkflowAlreadyStartedError` caught at `:199-201`).

No batching/debouncing/cadence — exactly one trigger per consultation lifecycle (plus one-shot `signal/approve`/`signal/edit`, `internal.py:226-301`). Back-pressure N/A.

The actual per-segment realtime cadence lives in `live-documentation.service.ts` — `ingestSegment()` (`:572-591`) flushes on `pendingSegments >= segmentThreshold` or debounce timer (`scheduleFlush`, `:1173`), with min-interval throttle coalescing bursts (`:660-665`) and a **generation-id** guard so a stale in-flight SMR/NLP call from a superseded flush can never publish/persist (`:646-648,677-683`).

---

## 5. Safety/eval integration in the loop

### Guardrail sensors (in-loop, mandatory)

- **Computational** (cheap, every iteration): `entity_faithfulness`, `numeric_dose`, `coverage_omission`, `citation_presence`, `schema_validity` — via `run_computational_sensors` inside `run_sensors` (`activities.py:1101-1133`), pure/deterministic (`sensors/base.py:170-178`).
- **Inferential** (costly, once per settle): `GroundednessSensor` + `CitationVerifySensor` + optional `SafetySensor` (Granite-Guardian) + optional `AtomicFactSensor` (self-hosted NLI) — fanned out concurrently via `asyncio.gather` in `run_inferential_sensors` (`activities.py:1362-1541,1508-1538`). Judge selection is DB-driven (`HarnessPolicy.judge_provider/judge_model` from SYSTEM `harness.judge` AiTaskDefault) and **fails closed** (degrades the whole pass) rather than falling back to env-selected judge when unset (`activities.py:1426-1438`).
- PHI egress enforced immediately before every cloud-bound call: `generate` (`activities.py:948-979`), the inferential pass (`ensure_inferential_egress_safe`, `activities.py:1440-1467`, fans across note/transcript/claims/knowledge-chunks each gated against *its own* consumer's provider — `guards/phi/egress.py:124-171`), and MCP tool args (`ensure_mcp_args_safe`, block-not-redact for external tools, `guards/phi/egress.py:80-121`).

### Redaction (TASK-551)

`apply_redaction` activity (`activities.py:1569-1710`) runs **after** the computational loop settles and **before** persist/delivery, gated on `inp.redaction_rules` + `workflow.patched("task-551-redaction")` (`workflows.py:890`). Two passes: pure deterministic engine (`redaction/engine.py:150-206` — literal/regex/category `remove`/`rewrite`, fails **closed** on malformed rule, never invents characters) then optional bounded SMR semantic rewrite for rules with no literal replacement (`activities.py:1640-1698`, schema-validated, fails closed on any SMR error or unparsable JSON). If the note changed, computational sensors **re-run on the redacted text** (`workflows.py:930-969`). `redaction.failed_closed` forces `decision = FLAG` unconditionally (`workflows.py:1280-1281,1373-1376`), and (optimistic path) triggers full **retraction** of an already-delivered draft (`workflows.py:1296-1336`).

**Audit persistence**: `redaction_marker_applied`/`redaction_marker_manifest` (rule ids, hit counts, `failedClosed` — never removed-PHI plaintext, `workflows.py:909-923`) threaded into both `persist_draft` and optimistic `_deliver_early` (`workflows.py:1016-1017,1409-1410`) → `SummaryMeta.redactionApplied`/`encryptedRedactionManifest` on apps/api, behind patch marker `task-551-redaction-audit` (`workflows.py:914`).

### Trajectory (audit) persistence

Every activity records steps via `_TrajectoryBatch` (`activities.py:261-336`) — `PHASE`/`TOOL_CALL`/`RETRIEVAL`/`LLM_CALL`/`SENSOR`/`GUARDRAIL`/`THINKING`/`GATE` — fire-and-forget POSTed (`report_trajectory`) with workflow-owned monotonic `seq` (`TrajectoryContext`, `models.py:174-198`; allocator `workflows.py:263-279`, stride 16). A trajectory-post failure is swallowed (`activities.py:330-334`) — best-effort, not WORM itself (the true WORM audit is the apps/api `HarnessAuditEvent` hash-chain, written by `record_gate_decision`/`retract_draft`).

### Eval-gated behavior at runtime

None found. The eval pipeline (`apps/harness/src/harness/eval/**`, golden sets, PDSQI/faithfulness judges, `harness.eval.ci`) is entirely offline/CI (`.gitlab/ci/test.yml:521-535`, `allow_failure: true` at `:525` — still non-blocking) and does not gate the live workflow; nothing in `workflows.py`/`activities.py` reads an eval score to permit/deny a run.

---

## 6. Defects & smells

### High-confidence, newly found this review (not in any existing ticket doc)

1. **[CRITICAL] TASK-546's version-pinning is silently discarded by prompt assembly — "movable pointer vs. frozen governed version" doesn't work.**
   `PromptResolutionService.resolveDepartmentAgent()` (`prompt-resolution.service.ts:301-330`) correctly reads the **immutable** `PromptVersion.content` at `pinnedVersionNumber ?? latest APPROVED` and returns it as `resolved.content`/`resolved.resolvedVersionNumber`/`resolved.resolvedAgentId` (`:274-288`). But `PromptAssemblyService.assemble()` (`prompt-assembly.service.ts:331`) **re-fetches the template by id and reads `template.content`** — the **mutable** `PromptTemplate.content` column (`prompt-template.prisma:46`, distinct from `PromptVersion.content` at `:119`) — and never references `resolved.content`/`resolved.resolvedVersionNumber` (grep-confirmed zero hits). Net effect: if a `DepartmentAgent` pins version 3 while the template has since moved to version 5, the assembled prompt silently serves v5, not the pinned/approved v3 snapshot. Defeats the entire pinning/approval-governance story from TASK-546/548/550. No error, no log, no test catching it (`prompt-assembly.service.test.ts` has zero references to `resolvedAgentId`/`resolvedVersionNumber`/`pinnedVersion`).

2. **DNA writing-style variable substitution is dead-code-laden and broadcasts one style into every department slot regardless of the doctor's actual department.**
   `buildVariables()` (`prompt-assembly.service.ts:456-467`): `dnaVarPattern` and `allVarNames` computed and immediately discarded (eslint-disabled unused vars, `:459-462`), then a loop (`:463-466`) sets **all 11** hardcoded department keys (`getDnaVariableKeys()`, `:472-486`) to the same `dnaStyle.styleText` — no per-department selection logic despite the naming. Adding a 12th department requires a code change (not data-driven); any template referencing more than one `{style_DNA_doctor_department_*}` placeholder gets identical text in every slot.

3. **`sameDayPrequelSummary` — a "revisit continuity" field declared, wired into template substitution, and never populated by anything.**
   `PromptAssemblyParams.sameDayPrequelSummary` (`prompt-assembly.service.ts:158`) → `variables.same_day_prequel_summary` (`:452-454`), zero producers (grep-confirmed). API surface *implies* prior-visit content flows into a "revisit" prompt; it doesn't.

4. **`systemPrompt` is a single hardcoded string with no policy/DNA/department layering at all.**
   `prompt-assembly.service.ts:413`: `const systemPrompt = 'You are a medical scribe AI assistant.';` — every other instruction (template, DNA, notes, warm-start, RAG, redaction) is folded into the *user* prompt. No system-prompt layering mechanism exists.

5. **`agentic.context.claimCheck.minBytes` is a live-editable knob that governs nothing** (verified still true): `live-documentation.service.ts:1499,1507,1529` resolve/store `claimCheckMinBytes`; `:2042` only reports it on the config-inspection surface; no comparison/threshold use anywhere in the file. A global admin can move a console value that changes zero runtime behavior, no error surfaced. Documented open in `TASK-533/README.md:395`, still true.

### Confirmed-still-open items already tracked in ticket docs (re-verified)

6. **`GateEditExemplar` unique-constraint/schema drift** (`harness.prisma:482-483`) — schema declares only `@@index([tenantId, consultationId])`; live dev DB carries an additional UNIQUE constraint from an earlier migration. Miner idempotency is read-then-write, race-safe **only** under the UNIQUE constraint. Owner decision open.

7. **Dev-environment auth gotcha causes silent, undetectable policy degrade.** `scripts/dev-service.sh` does not export `HARNESS_SERVICE_TOKEN`, gateway `HarnessServiceTokenGuard` is fail-closed → worker's `fetch_policy` 401s → `workflows.py:402-404` catches generic `ActivityError` → `policy_degraded=True` → code defaults + `reduced_assurance`, **indistinguishable from a genuine transient outage**. Auth failures (misconfiguration, should be loud) vs infra blips (expected, quiet) are the same code path — needs a distinct error code/metric.

8. **`warm_start_enabled` parsed into Python `HarnessPolicy` (`models.py:301,365`) but never read in `workflows.py`/`activities.py`** (grep-confirmed). Intentional per TASK-533 A3 (switch moved to TS side), but the dead field on the replayed model invites a future contributor to wire a second, competing warm-start switch. Needs comment or removal.

9. **Documentation drift**: TASK-533 README's "8 `workflow.patched` eras" is now 10 (§1).

### Design choices worth flagging

10. **Pervasive broad `except Exception` degrade-to-safe patterns** (`activities.py:410,463,483-484,1483,1660`; `worker.py:51,81,95`) — consistent with "never crash the loop" philosophy, but operationally "policy service down," "auth misconfigured," and "policy row genuinely absent" are the same code path and the same operator signal (`reduced_assurance=True`). Monitoring/observability gap.

11. **No prompt-caching wire protocol** (no `cache_control`/`prompt_cache_key` in `smr_client.py`) — the caching story is "hope the inference engine's own prefix cache kicks in": invisible/unverifiable from the harness side, provider-dependent, no test/metric to catch a regression (wall-clock/cost property).

### Not defects (verified fixed; listed to avoid re-reporting)

- MCP token resolution (D-24) — `_resolve_mcp_token` (`activities.py:439-470`) now genuinely calls the gateway; no longer a stub.
- OTel dead flag (D-27) — fully removed from `core/config.py`.
- Claim-check unsafe prod default (D-28) — guarded at `Settings` construction (`core/config.py:466-495`) and worker boot (`worker.py:122-155`).
- Third regen-site missing budget accounting (DR-12) — all three sites (`workflows.py:788,862,1253`) carry `and not budget_stopped` + token accumulation.
