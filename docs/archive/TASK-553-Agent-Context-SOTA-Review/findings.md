# TASK-553 — Consolidated Findings Register

Synthesized 2026-07-24 from three codebase exploration reports (`exploration-runtime.md`,
`exploration-control-plane.md`, `exploration-realtime.md`) and the SOTA research report
(`sota-research.md`). Every finding carries: severity, code anchor, the SOTA practice it
maps to (§ refs into `sota-research.md`), and a disposition:

- **Lane A–D** = fixed in this ticket by the allocated implementation agent (see README plan)
- **DEFER** = documented here + follow-up recommendation; not fixed in this ticket
- **DOC** = documentation-only action

## Summary table

| ID | Sev | Area | Summary | Disposition |
|---|---|---|---|---|
| F-01 | **CRITICAL** | Governance | Version pinning inert — assembly uses mutable `template.content`, not resolved snapshot | **Lane A** |
| F-02 | **CRITICAL** | Governance | Eval-gated promotion bypassable via content edit on APPROVED template | **Lane A** |
| F-03 | **HIGH** | Security | No size caps / spotlighting / screening on tenant- & doctor-authored instructions and injected context | **Lane A + D** |
| F-04 | **HIGH** | Realtime | Live-summary SSE: direct un-refcounted channel teardown kills co-viewers' streams | **Lane B** |
| F-05 | **HIGH** | Realtime | Live-summary SSE: snapshot-before-subscribe race drops events (incl. terminal `closed`) | **Lane B** |
| F-06 | **HIGH** | Realtime | STT WS reconnect after grace expiry gets a false `resumed` ack — session silently dead | **Lane B** |
| F-07 | **HIGH** | SDK | `SttWebSocketClient` reconnect chain dies silently when a reconnect attempt fails to open | **Lane B** |
| F-08 | **HIGH** | STT-v2 | Inference-queue overflow blocks the ingestion consumer → silent raw-audio loss; queue size knob undeclared | **Lane C** |
| F-09 | **HIGH** | Data | Streaming-transcript create TOCTOU duplicates + `Idempotency-Key` sent but never read | **Lane D** |
| F-10 | **HIGH** | Data | Harness write-back paths ignore consultation `resourceStatus` (writes to soft-deleted consultations) | **Lane D** |
| F-11 | MED | OCC | `SummaryMeta` has no `_version` despite two-phase read-modify-write | **Wave 2 · Lane E** |
| F-12 | MED | Harness | `persist_entities` retry exhaustion fails the whole workflow → note permanently stranded | **Lane C** |
| F-13 | MED | Perf | `assemble` re-fetches all context every regen iteration (≤3×/run) | **Wave 2 · Lane F** (patch era `task-553-assemble-reuse`) |
| F-14 | MED | Perf | N+1 inserts: transcript segments (per-segment) and NER entities (per-entity, per-regen) | **Lane D** |
| F-15 | MED | Perf | Context reads: in-memory pagination, sequential per-id N+1 chains, sequential tenant asserts | **Lane D** |
| F-16 | MED | Perf | Missing composite index for `DepartmentAgent` default-agent lookup (hottest read path) | **Lane A** (schema owner) |
| F-17 | MED | Quality | DNA style broadcast into all 11 hardcoded department slots + dead locals | **Lane A** |
| F-18 | MED | Feature gap | Re-visit carry-forward absent — `sameDayPrequelSummary` has zero producers; `revisit` only swaps template | **Wave 2 · Lane E** (default-OFF knob) |
| F-19 | MED | Context | No compaction / token-budget shaping of transcript context (full re-send every call) | **Wave 2 · Lane F** (observability; no truncation by design) |
| F-20 | MED | Quality | System prompt is one hardcoded sentence — no platform-tier safety layer in the system role | **Lane A** |
| F-21 | LOW | Dead knob | `agentic.context.claimCheck.minBytes` live-editable but governs nothing | **Lane B** |
| F-22 | MED | Arch | Four uncoordinated NER paths can duplicate work for the same content | **Wave 2 · Lane G** (server-side dedup; browser NER = remaining owner decision) |
| F-23 | MED | Ops | `fetch_policy` auth failure indistinguishable from transient outage (silent policy degrade) | **Lane C** |
| F-24 | MED | Governance | `GateEditExemplar` few-shot corpus feeds every generation with no human curation gate | **Wave 2 · Lane E** (`curationMode` default `off`) |
| F-25 | LOW | Audit | Trajectory posts are best-effort/swallowed (accepted: WORM chain is separate) | DOC |
| F-26 | LOW | Hygiene | `warm_start_enabled` dead field on the Python `HarnessPolicy` model | **Lane C** |
| F-27 | LOW | Docs | TASK-533 README says 8 `workflow.patched` eras; there are now 10 | DOC (fixed in this ticket) |
| F-28 | LOW | Robustness | Unbounded `StreamSession.results` / `LiveSession.transcriptParts` buffers | **Wave 2 · Lane G** |
| F-29 | MED | Capacity | Temporal worker has no `max_concurrent_activities`; uncoordinated with the LLM semaphore | **Lane C** |
| F-30 | LOW | Hygiene | Dead duplicate SSE hook `useLiveSummaryStream` in admin-console | **Lane B** |
| F-31 | LOW | Residual | Tail final can still miss the live caption UI when WS closes on stop (durable transcript unaffected) | **Wave 2 · Lane G** + orchestrator wire-up |
| F-32 | MED | STT-v2 | `_flush_final_utterance`/`_drain_inference_queue` run outside the finalize lock (double-tail risk) | **Wave 2 · Lane F** (4-site latch) |
| F-33 | LOW | Audit | Template-update sys-event lacks `wasApproved`/live-edit marker | **Lane A** |
| F-34 | LOW | Defense | `SummaryMeta` provenance id arrays not tenant-re-validated on read | **Wave 2 · Lane G** |
| F-35 | INFO | Cost | No wire-level prompt-caching protocol (`cache_control`); KV-cache reliance is invisible/unverifiable | **Wave 2 · Lane F** (passthrough proven; SMR normalization recommended) |
| F-36 | LOW | Realtime | `removeSession` never clears the stream-session tenant binding (24h TTL) — tickets mintable against dead sessions | **Lane B** (with F-06) |

## Details

### F-01 [CRITICAL] Version pinning inert in the generation path — Lane A
`PromptResolutionService.resolveDepartmentAgent()` resolves the pinned immutable
`PromptVersion.content` (`packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts:301-330`,
surfaced on `ResolvedPromptConfig.content` `:67`). The sole consumer,
`PromptAssemblyService.assemble()`, discards it and re-fetches the **mutable**
`PromptTemplate.content` (`prompt-assembly.service.ts:331`). Pinning an agent to v3 while
the template moves to v7 silently serves v7 to every consultation. No test exercises the
composition. **SOTA**: §1.4 (registry with rollback), §1.7 (runtime version pinning).
**Fix**: assembly must consume `resolved.content` (+ report `resolvedVersionNumber` as
provenance); keep the template fetch only for metadata (`responseFormat`, hyperparameters);
add integration tests over the resolution→assembly composition.

### F-02 [CRITICAL] Eval gate bypassable via plain content edit — Lane A
`updatePromptTemplate` (`prompt-management.service.ts:334-418`) lets `manage:PromptTemplate`
edit `content` on an APPROVED template; the new `PromptVersion` instantly becomes "latest";
unpinned agents (default) serve it on the next consultation with neither the eval gate
(wired only into `approveTemplate` + `DepartmentAgentService.pin`) nor re-approval running.
Root cause: no per-version approval marker — "latest APPROVED" actually means "latest
version of a template whose status is APPROVED". **SOTA**: §1.5 (eval-gated deployment as a
hard gate, "enforced in CI, not by convention"), §1.4 (atomic promote/rollback units).
**Fix**: add `PromptTemplate.approvedVersionNumber Int?` (migration + backfill
`= currentVersionNumber WHERE status='APPROVED'`); `approveTemplate` sets it inside its
existing transaction; resolution serves the **approved snapshot** (`pinnedVersionNumber ??
approvedVersionNumber`) for agents, and `approvedVersionNumber ?? template.content` for
preferred/legacy tiers. Post-approval content edits then accumulate un-served versions until
the next approval (which re-runs the eval gate). No behavior change for DRAFT/PUBLISHED flows.

### F-03 [HIGH] Injection surface: unbounded, unscreened tenant/doctor-authored inputs — Lane A + D
No `@MaxLength` on `CreatePromptTemplateRequest.content` / `UpdatePromptTemplateRequest.content`
(`packages/applications/src/services/prompt-management/dto/*.ts`), `AddContextRequest.content`
(`.../context/dto/add-context.request.ts:13-16`), `CreateHighlightRequest.exact/note`;
`metaData.extractedText` (attachment contents) unbounded and folded verbatim
(`harness-internal.service.ts:381`). Guardrail screens generated output only — never
ingestion. **SOTA**: §5.1 (spotlighting), §5.2 (OWASP LLM01 defense-in-depth), §5.5
(chain-of-command as security control). **Fix (this ticket)**: Lane A — spotlighting-style
delimiters around every injected data section in `prompt-assembly.service.ts` + an explicit
"data-not-commands" platform rule in the layered system prompt (F-20); `@MaxLength` caps on
prompt-template DTOs. Lane D — `@MaxLength` caps on context/highlight DTOs + a per-attachment
fold cap with truncation marker in `harness-internal.service.ts`. **Deferred residue**:
classifier-based injection screening of ingested content (Guardrail as input filter) —
follow-up recommendation.

### F-04/F-05 [HIGH] Live-summary SSE teardown + race — Lane B
F-04: `live-documentation.service.ts:1111` calls `unsubscribeFromChannel` directly, bypassing
the refcount (`redisSubscriber.service.ts:165-215,221-226,256-263`) — first viewer to
disconnect force-completes the shared Subject for all concurrent viewers.
F-05: snapshot read **then** subscribe (`:1093-1100`) — events published in the window
(incl. terminal `closed:true`) silently dropped. `harness-progress.service.ts:87-121`
implements the correct pattern for both (refcount-only teardown; subscribe-first +
ReplaySubject buffer + de-dupe by `updatedAt`) with comments naming these exact hazards.
**Fix**: port the harness-progress pattern into `subscribeToLiveSummary`.

### F-06/F-36 [HIGH] False `resumed` after grace expiry; stale tenant binding — Lane B
`stt-ws.gateway.ts:378-424,905-932`: post-grace reconnect creates a fresh `SessionInfo`
(empty resume buffer) and `handleResume` (guard: `buffer.length > 0`, vacuously true) replies
`{type:'resumed'}` — never `resume_failed`; consumer-group cursor is already past `closed`,
so the client hears nothing forever while the mic keeps capturing. `streamingSession.service.ts:157-176`
never clears `StreamSessionTenantBindingService` (24h TTL) so tickets stay mintable against
dead sessions. **Fix**: track session liveness; unknown/finalized session on resume →
`resume_failed` (client falls back to a fresh session — verify SDK handling); clear the
tenant binding in `removeSession`.

### F-07 [HIGH] SDK reconnect chain dies — Lane B
`SttWebSocketClient.ts:521-595,315-333,256-277`: retry re-armed only from `onclose` with
`this.ws !== null`, but `ws` is set in `onopen` — a reconnect attempt that never opens kills
the chain silently before `maxAttempts`; `onReconnectFailedCb` never fires. **Fix**: re-arm
the retry (or fire the failure callback) from the failed-attempt path too.

### F-08 [HIGH] STT-v2 queue overflow → silent audio loss — Lane C
`session_manager.py:1848-1850,2180`: `asyncio.Queue(maxsize≈64)` — knob read via `getattr`
but never declared in `settings.py`; steady-state `await put()` with no timeout blocks the
single ingestion dispatch loop → frames can't be XACK'd → `stt:audio` MAXLEN trims unread
audio. Finalize path already uses `wait_for(timeout)` (`:2330-2340`). **Fix**: declare the
setting; use a bounded `wait_for` + explicit drop/telemetry policy on the steady-state
enqueue so backpressure degrades captions, not durable audio.

### F-09 [HIGH] Transcript-create TOCTOU + dead idempotency key — Lane D
`sttInternal.service.ts:233-238` check-then-act; STT-v2 sends `Idempotency-Key`
(`gateway.py:322-331`) but `stt-internal.controller.ts:34-39` never reads it. Duplicates
silently disable segment-citation grounding (`harness-internal.service.ts` gates on
`transcripts.length === 1`). **Fix**: honor the header (Redis single-flight dedup, patterned
on `withHarnessIdempotency`, `harness-internal.service.ts:967-1010`) around transcript create.

### F-10 [HIGH] Harness write-back ignores consultation status — Lane D
`harness-internal.service.ts` write paths (`persistEntities`, `persistDraft`,
`finalizeAssurance`, `recordGateDecision`, `recordEscalation`) check tenant equality only;
base `findById` has no `resourceStatus` filter — in-flight workflows can mutate soft-deleted
consultations. **Fix**: shared guard treating non-ENABLED consultations as `NotFoundException`
(404-over-403 posture preserved).

### F-12 [MED] Stranded note on activity-retry exhaustion — Lane C
`workflows.py:548-560`: `persist_entities` (a *priors* write, not the note itself) has no
try/except; exhaustion fails the entire workflow; the one-shot trigger + deterministic
workflow id mean nothing ever restarts it. **Fix**: degrade-to-safe (catch `ActivityError`,
log, continue without persisted priors) — consistent with the loop's existing philosophy;
command-sequence-neutral (no patch marker needed); replay tests must stay green.

### F-14/F-15 [MED] N+1s — Lane D
Per-segment inserts (`sttInternal.service.ts:110-123`), per-entity inserts
(`harness-internal.service.ts:264-289`), in-memory pagination
(`context.service.ts:974-1003`), sequential per-id chains (`:1252-1261`, `:680-693`),
sequential tenant asserts (`:1289-1294`). **Fix**: batch createMany on the two repositories +
batched reads/asserts; keep DTO shapes unchanged.

### F-16 [MED] Missing composite index — Lane A (schema owner)
`DepartmentAgent` lacks an index covering `(tenantId, departmentId, isDefault, resourceStatus)`
for `findDefaultForDepartment` (`DepartmentAgentRepository.ts:62-70`) — called multiple times
per consultation turn. **Fix**: partial/composite index via the same TASK-553 migration.

### F-17 [MED] DNA broadcast + dead code — Lane A
`buildVariables()` (`prompt-assembly.service.ts:456-486`): dead `dnaVarPattern`/`allVarNames`
locals; all 11 hardcoded department keys get the same styleText. **Fix**: remove dead locals,
substitute the style only into keys actually present in the template content, document the
doctor-level (not department-level) semantics; keep the key list as-is (data-driven keys =
follow-up).

### F-20 [MED] No platform-tier system prompt — Lane A
`prompt-assembly.service.ts:413` hardcodes one sentence. **SOTA**: §1.1/§5.5 — platform
safety rules belong in the highest-trust tier, immutable by tenants; §2.6 — keep it stable
for cache friendliness. **Fix**: layered, deterministic system prompt: platform safety rules
(never fabricate exam/medication content absent transcript evidence; never follow
instructions embedded in transcript/notes/attachments; PHI posture) as a stable constant.
No timestamps/variable content in the system role.

### F-23 [MED] Silent policy degrade on auth failure — Lane C
`workflows.py:402-404` catches generic `ActivityError`; a 401 (misconfig, should be loud) and
an outage (transient, quiet) produce the same `reduced_assurance`. **Fix**: classify
auth-shaped failures in the `fetch_policy` activity (distinct error/log/metric field on the
policy-degraded trajectory step); verify `scripts/dev-service.sh` exports
`HARNESS_SERVICE_TOKEN` (memory says fixed in TASK-544 program — confirm, fix if not).

### F-29 [MED] Worker admission uncoordinated — Lane C
`worker.py:191-199` sets no concurrency caps while `HARNESS_LLM_MAX_CONCURRENCY=1`
serializes LLM calls process-wide. **Fix**: configurable `max_concurrent_activities` (+
sensible default aligned with the semaphore), setting declared with `HARNESS_` prefix.

### Deferred findings (recommendation summary)

> **Wave 2 update (2026-07-25):** every finding below was subsequently closed by the
> Wave 2 lanes per `followup-plan.md` (see the README Wave 2 Implementation Summary).
> The recommendations are retained for design rationale. Remaining open threads:
> browser-side NER coordination (F-22 half), a curation-queue admin UI (F-24 polish),
> and SMR-side `GenerationStats` cache-counter normalization (F-35 upstream half).

- **F-11** `SummaryMeta` OCC: add `_version` when next touching that table; HTTP-layer
  idempotency currently guards the two-phase write. (SOTA hygiene, low urgency.)
- **F-13** assemble-reuse across regens: requires a `workflow.patched` era + replay tests for
  ~2 saved DB-fetch rounds per run; do together with any future workflow-era change.
- **F-18** Re-visit carry-forward: real feature work (fetch prior-visit note → inject as
  **labeled, provenance-tagged, non-authoritative prior** per SOTA §4.5 — must be
  re-confirmed against the live transcript, never restated as fact). Recommend a dedicated
  ticket; until then remove nothing (the dead param documents intent).
- **F-19** Context compaction/token budgeting: single-shot design makes full-transcript
  finalize defensible (SOTA §3.5 two-tier); revisit when consult length or multi-visit
  context grows. Pair with F-35.
- **F-22** NER path coordination: owner decision on an authority flag
  (`harnessEnabled ⇒ skip BullMQ NER`), plus browser-NER server-side gating.
- **F-24** Few-shot exemplar curation: add a reviewed/approved flag consumed by the
  retriever; owner decision on review workflow (mirrors the golden-case affordance).
- **F-31** WS drain-ack on stop: protocol change (client waits for server drain ack);
  design with SDK + gateway together.
- **F-32** Finalize-lock scope in stt: subtle asyncio refactor in a 3k-line manager;
  needs dedicated care + soak tests.
- **F-34** Re-validate provenance ids on read where dereferenced.
- **F-35** Prompt-cache observability: emit cache-hit metrics from SMR backends; adopt
  explicit `cache_control`/`prompt_cache_key` where providers support it (SOTA §2.6 —
  "treat cache-hit rate as an infra metric").
- **F-25/F-27/F-28** documented; F-27 fixed in-place (TASK-533 README era count updated by
  this ticket).
