# HOPE Consultation Conformance Audit — Wave 2, Lane G: Adjudicated Conformance Matrix

**Inputs:** `00-invariant-register.md` (449 invariants) · `01-orchestration.md` (B) · `02-context-model.md` (C) · `03-ai-pipeline.md` (D) · `04-surfaces.md` (E)
**Repo:** `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2`, branch `feat/loop`. Static-code evidence only.
**Adjudicator method:** every conflict below was settled by reading the code directly, not by averaging lane opinions. Searches excluded `.claude/worktrees/**`, `**/dist/**`, `**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`.

---

## 0. The one-paragraph result

The platform's **terminal safety property holds**: there is exactly one code path that can mark a consultation `SIGNED`, it requires an authenticated human identity, and it has exactly one caller — an HTTP route. No clock, no worker, no workflow, and no admin endpoint can reach it. Verified independently by me, not inherited from a lane.

Everything upstream of that gate is weaker than the reference requires, and the weakness is concentrated in a specific place: **the default configuration routes clinical documentation through the codebase's *least*-safeguarded pipeline.** `harnessEnabled` code-defaults `false` and the seeded SYSTEM-tenant policy sets it `false`, so a default tenant's note is produced by the legacy BullMQ path — no sensors, no groundedness scoring, no terminology validation, no adjudication. Every one of those safeguards exists, is well-built, and is unreachable without a per-tenant opt-in. This is the single most consequential fact in the audit and it reframes most remediation from "build it" to "reach it".

---

## 1. Conformance matrix

Verdicts: `IMPLEMENTED` · `PARTIAL` · `GATED-OFF` (built, unreachable in default config) · `ABSENT` · `VIOLATED` · `DISPUTED`
Confidence: `CORROBORATED (n)` · `SINGLE-SOURCE` · `PENDING-VERIFICATION` · `RESOLVED-BY-ADJUDICATION` (I read the code)

### 1.1 CRITICAL

| ID | Invariant / requirement | Register refs | Category | Verdict | Confidence | Lanes | Evidence | Severity |
|---|---|---|---|---|---|---|---|---|
| A-01 | Patient consent + clinician ABAC gate all agents, retrieval, and tool calls; revocation blocks future calls | INV-003,004,006-010,015,016,067,201,232,338-345,371,437,438 | consent-abac | **ABSENT** | RESOLVED-BY-ADJUDICATION (4 lanes agree) | B,C,D,E | No `Consent`/`ABAC` model in any of the 41 `.prisma` files; `HarnessAuditAction.CONSENT_GIVEN`/`CONSENT_WITHDRAWN` have zero writers; open path checks tenant + RBAC + quota only | CRITICAL |
| A-02 | PHI sanitizer runs on finalized speech before NLP/reasoning consumes it, and on the reconciled transcript | INV-026, INV-136 | consent-abac | **VIOLATED** | RESOLVED-BY-ADJUDICATION (D + my read) | D | `ner.processor.ts:92-99,219-221` — `contextItem.content` → `POST /api/v1/classify/tokens`, zero guardrail hop. Guardrail's `pii_detection` is detection-only (no `sanitized_text` field) and fails open. `PhiRedactor` exists but is scoped to cloud-LLM egress only | CRITICAL |
| A-03 | No clinical code emitted without a tool-verified match; hallucinated codes forbidden | INV-065,066,231,432,447 | terminology | **VIOLATED** | RESOLVED-BY-ADJUDICATION (D + my read) | D | `seed/07-prompt-template.ts` — 14+ live prompts instruct the LLM to free-write ICD-10 into a plain `type:'string'` assessment field. I confirmed the counter-measure is inert: `mcpToolsEnabled` is nullable with **no seed writer** (`None ⇒ OFF`) and `mcp_servers` defaults to an empty list | CRITICAL |
| A-04 | Contradictions (image-vs-speech, history-vs-current) become typed items, never silently resolved | INV-013,014,039-043,102-108,189,190,248,366,401-408 | contradiction | **ABSENT** | RESOLVED-BY-ADJUDICATION (4 lanes + my TS **and** Python sweep) | B,C,D,E | Repo-wide across `packages/*`, `apps/api`, `apps/harness`, `apps/nlp`: two hits, both unrelated (a serviceRelease comment; a deepeval hallucination metric). Zero `contradiction` members in `SysEventType` | CRITICAL |
| A-05 | The default generation path must not silently prefer one source over another | INV-042,106,402,407 | contradiction | **VIOLATED** | SINGLE-SOURCE (D, mechanism verified) | D | `prompt-assembly.service.ts:507-607` concatenates transcript + attachments + prior record with no conflict instruction; `:82-89` and `:579-589` encode two **silent** precedence rules; `live-documentation.service.ts:1933` repeats the pattern | CRITICAL |
| A-06 | Style/writing-DNA memory holds no patient facts and learns only from approved notes | INV-017,080,095,096,165,169,241 | style-dna | **VIOLATED** | PENDING-VERIFICATION (carried at claimed severity) | C | `dna-writing-style.processor.ts:105-111` — caller-supplied `textSamples` bypasses the approved-notes filter; no redaction anywhere in the chain; output injected into a different patient's prompt via `text-compat.controller.ts:284-302` | CRITICAL |
| A-07 | User-authored text is protected from automatic overwrite by system-generated content | INV-029,052,085,092,100,133,152,219,237,253,356,396 | hitl-authority | **VIOLATED** | PENDING-VERIFICATION (carried at claimed severity) | C | Two AI write paths overwrite `ContextItem.content` unconditionally: `harness-internal.service.ts:761-774` (draft re-adoption) and `live-documentation.service.ts:1802-1873` (30s snapshot flush). No `locked`/`clinicianEdited` column exists | CRITICAL |
| A-08 | Clinician edits cannot be lost; commit uses optimistic concurrency / record-version checks | INV-157,257,382 + INV-029 | commit-idempotency | **VIOLATED** | RESOLVED-BY-ADJUDICATION (E + my read) | E | `summary.service.ts:767,994` and `context.service.ts:519` all call `.update()`, never `.updateWithVersion()`. **Zero** `@RequiresIfMatch` in `consultation.controller.ts`, while ≥6 sibling modules (tenant, webhook, audio-pipeline, tenant-tts-config, settings-registry-write) use the pattern correctly | CRITICAL |
| A-09 | Medication, allergy, laterality, dosage, negation, and patient-identity checks run before approval is offered | INV-139,246,421,424,431 | hitl-authority | **PARTIAL / ABSENT** | CORROBORATED (2) | D,B | Dosage IMPLEMENTED (`numeric_dose.py`); negation exists but ungated (`assertion.py`); medication generic-grounding only; **allergy, laterality, patient-identity: zero implementation**. Note: the sensors that do exist are harness-only ⇒ absent entirely on the default path | CRITICAL |
| A-10 | Consent revocation / erasure cascades to scratch, caches, episodic memory, style exemplars | INV-170,335,343,439,440,441 | retention-erasure | **ABSENT** | CORROBORATED (2) | C,E | Zero hits for `erasure`/`gdpr`/scrub-on-revocation; no consent record exists to revoke (A-01). Compounds A-06: a leaked style profile has no remediation path | CRITICAL |
| A-11 | No failure path publishes an empty/partial note without a degradation marker | INV-126,131,132,143 | degradation | **VIOLATED** | SINGLE-SOURCE (D) | D | `live-documentation.service.ts:1090-1092,1145-1149,1249` — first-flush SMR failure publishes `runningSummary:''` with a fresh timestamp; `smrFailed` is computed but omitted from `LiveSummaryEventDto`. Durable path (`summary.service.ts:1316`) correctly throws instead | CRITICAL |

### 1.2 HIGH

| ID | Invariant / requirement | Register refs | Category | Verdict | Confidence | Lanes | Evidence | Severity |
|---|---|---|---|---|---|---|---|---|
| A-12 | Per-section approve / edit / reject / return-for-regen, each a separate audit event; FINALIZED unreachable until all approved | INV-146,150,151,154,155,250-254,302,379,381 | hitl-authority | **ABSENT** | CORROBORATED (2, both layers) | C,E | `approveSummary` gates on `contextItem.isFinalSummary` — one whole document (confirmed: `ContextItemEntity.ts:267`). `LiveSummarySectionDto` is a display-time parse with no id/version/state; `HarnessGateDecisionRequest` records one aggregate verdict. Not a gateway-proxying gap — C confirmed it at the harness layer too | HIGH |
| A-13 | "Closed" (T23) presupposes "Closed Approved" (T21) | INV-174,175 | partial-vs-final | **VIOLATED** | SINGLE-SOURCE (B) | B | Two independent closed-trackers: typed `ConsultationStatus.CLOSED` (**never written anywhere**) and legacy `metadata.status` written by `closeConsultation()` (`consultation.service.ts:664-712`) with an ownership-only guard. `POST :id/close` succeeds on a never-recorded consultation | HIGH |
| A-14 | Every PHI access is recorded on the durable audit ledger | INV-008,330,332,333 | audit | **ABSENT for reads** | SINGLE-SOURCE (C) | C | Clinical reads broadcast `ResourceViewed`, but `sysEvent.service.ts:239-254` persists an `AuditLog` row only `if (!disableAuditLog && forceAuditLog)`; `forceAuditLog:true` is set only on `GlobalSetting`/`Policy`/`Role` reads — never on `Consultation`/`ContextItem`. Otherwise it is an ephemeral `removeOnComplete:true` job | HIGH |
| A-15 | Retention TTL configurable per artifact class; scratch/drafts expire independently of the signed note | INV-171,323,324,325 | retention-erasure | **PARTIAL + GATED-OFF** | CORROBORATED (2) + adjudication | C,E | Only two retention jobs exist (`AuditLog`, `AgentTrajectoryStep`), each one flat window over one whole table, and **I confirmed both default `enabled:false`**. Nothing ever expires `ContextItem`/`ContextItemVersion`/`TranscriptSegment`/`AudioRecording`. In default config, **nothing expires at all** | HIGH |
| A-16 | Uncertainty / confidence marks survive from ASR into the work note and final summary | INV-021,022,047,087,206,207,444 | labeling-transparency | **VIOLATED (dropped at first hop)** | SINGLE-SOURCE (D) | D | `TranscriptSegment` Prisma model and `TranscriptSegmentInput` DTO both lack any confidence column; `session.py:357-397` emits `{idx,t0Ms,t1Ms,speaker,text,charStart,charEnd}`. Word confidence is `None` on Whisper, the default local engine | HIGH |
| A-17 | Each clause carries an origin class (patient-reported / clinician-observed / imported / AI-derived) | INV-442-445, INV-300,301,346,347 | labeling-transparency | **ABSENT** | SINGLE-SOURCE (E) | E | `LiveSummarySection` is `{title, content}`; note body renders as one undifferentiated `<article>`; `changeSource` is a version-history event field, not a per-clause label | HIGH |
| A-18 | Imaging intake: metadata match, authenticated report preferred, image-derived findings labeled and isolated | INV-031-038,142,211-215,363-369 | multimodal | **ABSENT** | RESOLVED-BY-ADJUDICATION (D + my repo-wide sweep) | D,E | **Zero** `pydicom`/`.dcm` hits anywhere in `apps/` or `packages/`; no radiology-report-preference logic. Only generic `ATTACHMENT` + a deliberately non-diagnostic OCR tool (`activities.py:2637-2673`). Confirms E's ABSENT-in-scope as a genuine platform gap | HIGH |
| A-19 | Retrieval abstains on low-quality/conflicting evidence; sources carry date + version | INV-055,056,060,221,224,225,280,281 | debounce-synthesis / provenance | **PARTIAL / GATED-OFF** | SINGLE-SOURCE (D) | D | `retriever.py:122-155` takes `ranked[:top_k_rerank]` with no score floor; `KnowledgeDocument`/`KnowledgeChunk` have **no date or version field**; "abstain" appears nowhere in the repo. The whole RAG path is `RetrievalConfig.enabled=False` by default | HIGH |
| A-20 | Pause durably checkpoints and actually stops capture | INV-109-114,268-271,417,418 | checkpoint-resume | **ABSENT (+ misleading surface)** | CORROBORATED (2) | B,E | The only session-level pause is `useArcaSessionManager.ts:192-199`, which sets local React state and nothing else (its own header: *"pause/resume have no v2 equivalent → local status only"*). Server `pause`/`resume`/`cancel` WS control commands exist and are **dead** — only `'finalize'` is ever sent | HIGH |
| A-21 | Prior history is loaded, source-linked, imported-vs-current distinct, scope auditable/widenable; "Primed" gates streaming | INV-011,012,015,016,018,187-200 | provenance / consent-abac | **PARTIAL** | CORROBORATED (2) | B,E | Data linkage exists (`SummaryMeta.caseNoteIds`/`preSummaryIds`, tenant-revalidated both directions). But zero hits for `Primed` repo-wide — no gate blocks streaming pending history review — and no admin-console screen consumes `getPatientHistory`; no date-range/source-system/widen-scope surface | HIGH |
| A-22 | Terminology binding through a verified tool; unmapped terms flagged for human review | INV-061-064,233,234,429,430,446,449 | terminology | **PARTIAL + GATED-OFF** | CORROBORATED (3) + adjudication | C,D,E | `NamedEntity.snomedCode`/`rxnormCode`/`icdCode` columns are **written by no code** (schema comment, `consultation.prisma:391-406`). `ontology_linker.py` is a deterministic ~40-term dictionary (cannot hallucinate, but silently returns `None` outside it — no "unmapped" marker persisted). MCP `validate_codes` is post-hoc, non-gating, and unregistered | HIGH |
| A-23 | ASR pipeline failure is never a silent drop | INV-019,205,318,425-428 | degradation | **PARTIAL** | SINGLE-SOURCE (D) | D | Engine-switch fallback is genuinely solid and visible end-to-end (`engine_switch.py` → `provider_switched` → SDK). Gap: with no fallback configured or a non-classified exception, `session_manager.py:2440-2480` logs server-side only and the utterance vanishes — indistinguishable from silence on screen | HIGH |
| A-24 | Mute is obvious and immediately stops sending audio | INV-202 | template-config | **PARTIAL** | SINGLE-SOURCE (E) | E | SDK mute is genuinely correct (`useArcaAudio.ts:1545-1566`, browser-enforced `track.enabled=false` across all sources). No UI surface exposes it — `AudioMeter`'s `isMuted` is hardcoded `false`; `ConversationBar`/`MicSelector` are never imported by admin-console | HIGH |

### 1.3 MEDIUM

| ID | Invariant / requirement | Register refs | Category | Verdict | Confidence | Lanes | Evidence | Severity |
|---|---|---|---|---|---|---|---|---|
| A-25 | Verification completes before the note is offered for approval | INV-139,141,144,421 | hitl-authority | **GATED-OFF (risk)** | RESOLVED-BY-ADJUDICATION (corrects B) | B | Sign-before-assurance is reachable **only** when optimistic delivery is on — I confirmed `optimistic_delivery_enabled` defaults `False` at both `models.py:57` and `config.py:367`, with a nullable policy override. Without it, drafts arrive with `assuranceCompletedAt` stamped and the safety-FLAG hard block applies. **B ranked this #2 VIOLATED; it is a latent risk, not a default-config defect** | MEDIUM |
| A-26 | Two-phase drain: await in-flight agents, force-stop on timeout, mark sections incomplete | INV-121-133,357,412 | drain-shutdown | **GATED-OFF** | CORROBORATED (2) | B,D | The real multi-agent drain (`workflows.py:2099-2110`) lives only in `ConsultationLoopWorkflow`, gated by `harness.loop.enabled` (default `false`). Default-path "drain" is `LiveDocumentationService.stop()` flushing its own buffer | MEDIUM |
| A-27 | Per-agent timeout isolation; `agent.timeout` recorded; force-stop only the timed-out agent | INV-068-075,409-412 | degradation | **GATED-OFF** | CORROBORATED (2) | B,D | `SpecialistWorkflow` child-workflow isolation (`workflows.py:1784-1787`) exists only in the dormant loop. `LOOP_EVENT_SPECIALIST_FAILED` conflates timeout with any failure | MEDIUM |
| A-28 | Multi-view conflicts escalate to a human, never auto-resolved | INV-387 (UC-06) | contradiction | **GATED-OFF + VIOLATED-in-scope** | CORROBORATED (2) | C,D | `models.py:1595-1665` `adjudicate()` deterministically accepts the highest-confidence view with no clinician gate (rejected views retained for audit). Doubly unreachable: harness loop off, and it addresses specialist ensembles not the reference's inter-source case | MEDIUM |
| A-29 | Idempotent commit: duplicate approval never creates a second signed note | INV-157,158,185,382 | commit-idempotency | **PARTIAL** | SINGLE-SOURCE (B) | B | Read-then-check idempotency (`summary.service.ts:841-850`), not a key. DB `@@unique([contextItemId, versionNumber])` prevents a second `SIGNED_NOTE`, but the losing racer gets a 500, and there is no transaction spanning version-create + WORM append + status flip | MEDIUM |
| A-30 | Audit-ledger clinician attribution cannot be forged | INV-160,330,331 | audit | **PARTIAL** | SINGLE-SOURCE (B) | B | `POST /admin/harness/workflows/:id/signal` forwards an arbitrary `signalName`+payload; `recordGateDecision` writes `clinicianId`/`attestationHash` from the payload with no cross-check against a real `SIGNED_NOTE`. Bounded: cannot produce a signed note | MEDIUM |
| A-31 | Missing required template sections are reported, not invented | INV-079,140,247,261,293,298,423 | template-config | **ABSENT** | CORROBORATED (2) | D,E | `soap-parser.ts:110-151` is explicitly "lenient on missing keys" and silently fills `content:''` with no flag | MEDIUM |
| A-32 | Switching templates reformats existing evidence rather than regenerating | INV-082,263,296,297 | template-config | **ABSENT** | CORROBORATED (2) | D,E | No reformat operation exists anywhere; admin-console's note-model selector is a hardcoded single-option no-op (`onNoteChange={() => undefined}`) | MEDIUM |
| A-33 | A distinct, visibly-unsigned `TIMED_OUT` state with clinician notification | INV-177,178,182,183,413,414,416 | timeout-approval | **PARTIAL** | CORROBORATED (2) | B,E | No `TIMED_OUT` in `ConsultationStatus`. Escalation is WORM-audit-only (`GATE_ESCALATED`/`GATE_ABANDONED`) and never touches status. **The safe half holds** — timeout cannot auto-sign (see P-01). No notification pathway found | MEDIUM |
| A-34 | Superseded partial spans remain addressable in the ledger | INV-025,028,135,209,304 | provenance / partial-vs-final | **PARTIAL** | CORROBORATED (2) | C,E | Partials are never persisted (dropped under backpressure, client-ephemeral until Stop); `TranscriptSegment` has no stable id — identity is array position. Supersession is emulated only by `ContextItemVersion` history; no `supersededBy` field | MEDIUM |
| A-35 | Dependent artifacts invalidated on a high-risk correction; only affected sections regenerated | INV-091,098,099,236,397,399,400 | commit-idempotency | **ABSENT** | SINGLE-SOURCE (C) | C | No `invalidated` state or cascade on `ContextItem`/`NamedEntity`; `updateSummary` never touches derived entities; `extractEntities` only appends. Drug-interaction retrieval does not exist at all | MEDIUM |
| A-36 | 7-value context-item lifecycle (Added/Updated/Unchanged/Flagged/Invalidated/Superseded/Finalized) | dataset.xml §5 | (structural) | **ABSENT** | CORROBORATED (2) | C,B | No per-item state column, no transition guard. Only generic soft-delete + a per-*consultation* status. `ConsultationEntity.status` is a bare setter; `validate()` enforces no transition legality | MEDIUM |
| A-37 | Guideline sources are an explicit allowlist with defined conflict precedence | INV-319,320,321,282 | template-config | **PARTIAL** | RESOLVED-BY-ADJUDICATION (corrects E) | D,E | A real allowlist **does** exist — `qdrant_store.py:112-146` filters on `tenant_id` + `status=APPROVED`. Missing: named per-source allowlist UI, and any precedence concept. **E's ABSENT is corrected to PARTIAL** | MEDIUM |
| A-38 | Confidence gate before terminology binding on provisional tokens | INV-088,089 | terminology | **VIOLATED (no-op gate)** | SINGLE-SOURCE (D) | D | The gate mechanism is real (`token_classifier.py:220-233`) but `linker_confidence_floor` defaults `0.0` — every entity passes. Structurally unfixable today: ASR confidence never reaches NLP (`TokenClassificationRequest` accepts only `text`) | MEDIUM |
| A-39 | Tenant-wide quality dashboards: accept/edit/reject rate, template completeness, citation frequency | INV-307,310,327 | audit | **PARTIAL** | SINGLE-SOURCE (E) | E | `edit-burden` is scoped to a single `consultationId`; `consultations/aggregate` is volume-only; trajectory metrics are LLM latency. No tenant-wide clinical-quality aggregate | MEDIUM |
| A-40 | Work-note updates debounce on a silence / clinical-episode boundary, not every token | INV-049,050,083,216,355 | debounce-synthesis | **PARTIAL** | RESOLVED-BY-ADJUDICATION (settles E's open Q6) | D,E | Debounce is real and live-tunable: ~3 final segments **or** ~5s idle (`live-documentation.service.ts:889,1608`, resolved through `EffectiveSettings`). It is segment-count/idle-timer based — a silence proxy, not clinical-episode-boundary aware | MEDIUM |
| A-41 | "Degraded" is a distinguishable session state | INV-072,073 | degradation | **PARTIAL** | SINGLE-SOURCE (B) | B | Only per-run booleans (`degraded`/`reduced_assurance`/`mcp_degraded`) OR'd into `SummaryMeta`/audit. No `Consultation`-level state a dashboard could filter. Arguably a cleaner model than the reference's — see §8 | LOW-MEDIUM |
| A-42 | Named event taxonomy (`session.opened`, `agent.timeout`, `contradiction.detected`, `hitl.edit`, …) | register §4 (29 events) | audit | **PARTIAL** | SINGLE-SOURCE (B) | B | `session.opened` ABSENT; `agent.timeout` conflated; `contradiction.detected` ABSENT (A-04); `note.revision.requested` functional but unnamed; `hitl.edit` exists as a Temporal signal + version-trail entry but is never emitted as a taxonomy event | MEDIUM |

### 1.4 LOW

| ID | Invariant / requirement | Register refs | Category | Verdict | Confidence | Lanes | Evidence | Severity |
|---|---|---|---|---|---|---|---|---|
| A-43 | Irreversible clinical action requires confirmation | [ADDED] (project UX rule) | hitl-authority | **PARTIAL** | SINGLE-SOURCE (E) | E | `handleApprove` fires the mutation on click; the same app gates the lower-stakes "Activate version" behind a `ConfirmDialog` | LOW |
| A-44 | The typed citation/provenance client contract is actually consumed | [ADDED] | provenance | **PARTIAL** | SINGLE-SOURCE (E) | E | `types/citations.ts` (`ClinicalReviewData`, `CitationClaim`) has zero consumers; admin-console reimplements highlight-building independently — two implementations free to drift | LOW |
| A-45 | A patient-facing surface exists for consent, transparency, after-visit content | INV-264-267,342,346-348 | (structural) | **ABSENT** | SINGLE-SOURCE (E) | E | No patient app anywhere in `apps/`. Structural product scope, not a defect | LOW (structural) |
| A-46 | `REOPENED` / `CLOSED` enum members are live | — | (hygiene) | **ABSENT (dead enum)** | CORROBORATED (2) | B,C | Both declared in `enums.prisma:284-285`, neither written by any code | LOW |

---

## 2. What the platform gets RIGHT

Not a courtesy section. These are load-bearing and several are better-engineered than the reference requires.

| ID | Property | Verdict | Evidence |
|---|---|---|---|
| **P-01** | **No path can sign without a human.** | **IMPLEMENTED** — verified by me | `ConsultationStatus.SIGNED` has exactly **one** write site (`summary.service.ts:978`), inside `approveSummary`, which has exactly **one** caller repo-wide: the HTTP route `consultation.controller.ts:1295`. It requires `approvedBy = this.requestUserId` and throws without it. No cron, worker, Temporal activity, or admin endpoint reaches it. Corroborated by B, C, E — and independently re-verified here because it is the audit's keystone |
| **P-02** | Timeout never substitutes for approval | **IMPLEMENTED** | Gate-SLA exhaustion (`workflows.py:1520-1574`) returns `approved=False` and writes no status; `recordEscalation` appends `GATE_ESCALATED`/`GATE_ABANDONED` WORM rows only. The draft stays `PENDING_REVIEW` and is explicitly abandoned rather than promoted |
| **P-03** | WORM audit ledger is genuinely immutable at the DB layer | **IMPLEMENTED** (one caveat) | `REVOKE UPDATE, DELETE ON "core"."HarnessAuditEvent"` confirmed in migration SQL; identity-only row, no `_version`/`updatedAt`. 10 of 12 `HarnessAuditAction` values are wired end-to-end. *Caveat:* the REVOKE is role-existence-guarded against `hope_app`/`hope_app_template` — it is a no-op if the app connects as an owner/superuser role |
| **P-04** | Approval is fail-closed on audit-append failure | **IMPLEMENTED** | The `ATTEST` WORM append is ordered **before** the status flip, so an audit failure aborts the approval rather than producing an unaudited signature |
| **P-05** | Attestation carries real provenance | **IMPLEMENTED** | `SIGNED_NOTE` version records `attestedBy`/`attestedAt`/`attestationHash` (content-bound) + `modelName`/`modelVersion`/`sensorScores` |
| **P-06** | Edit-protection within one workflow execution | **IMPLEMENTED, well** | `workflows.py:304-356,1250-1348` — sticky `_edited`/`_ever_edited` forces `regens_remaining=0`; its own comment: *"Once edited, a REGEN-fixable issue must SURFACE as a FLAG (never swap the clinician's note)."* The team has solved A-07's exact hazard here; the fix is generalizing this guard, not inventing it |
| **P-07** | Claim-level citation provenance that cannot carry hallucinated citations | **IMPLEMENTED** | `provenance.py` builds per-claim `{section, status, evidence:[contextItemId+offsets+quote], knowledgeChunkIds}`, filtered to only actually-retrieved chunks — a fabricated `[[kb:id]]` cannot survive |
| **P-08** | Context-schema versioning and pinning is real governance | **IMPLEMENTED** | `addContext`/`updateContext` validate against the version the caller **pinned** (never silently upgraded); full CRUD with breaking-change detection and checksum-idempotent republish |
| **P-09** | Cross-tenant provenance defense-in-depth | **IMPLEMENTED** | Provenance id arrays are tenant-revalidated on **both** write (`assertContextItemsInTenant`) and read (`scrubForeignProvenanceIds`) |
| **P-10** | 404-over-403 posture + client tenant isolation | **IMPLEMENTED** | `assertParentInScope`/`assertEqualTenants`/`@TenantOwnedResource` on every SSE route; `clearTenantSessionData()` called synchronously before async re-hydrate |
| **P-11** | ASR fallback switch is visible end-to-end | **IMPLEMENTED** | `engine_switch.py` → Prometheus + structured log + `publish_provider_switched` → streaming API → SDK `useSTT`. (The gap is only the *exhausted*-fallback case, A-23) |
| **P-12** | Network-drop resume avoids re-transcription | **IMPLEMENTED** | `handleResume` replays only `seq > lastSeq` from a bounded buffer and rejects a false resume on a fresh session; SDK mirrors the seq-cursor handshake |
| **P-13** | The durable summary path never degrades to an empty note | **IMPLEMENTED** | `callSmrService` retries a tenant fallback then **throws** — never substitutes content (contrast A-11's live path) |
| **P-14** | Dosage safety sensor | **IMPLEMENTED** | `numeric_dose.py` flags any note dose absent from the transcript, with explicit degrade-not-pass on missing data |
| **P-15** | Groundedness NLI is fail-closed | **IMPLEMENTED** | `groundedness_nli.py`; live path also runs a real groundedness check before publishing |
| **P-16** | Downstream consumes finalized segments only | **IMPLEMENTED** | `is_final` gating at `inference.py:333,484`, `session.py:342-355`, `live-documentation.service.ts:853,1580` |
| **P-17** | SDK mute is genuinely correct | **IMPLEMENTED** | Browser-enforced across every source stream, de-duplicated by track identity (A-24 is a UI gap, not a fake control) |
| **P-18** | QA provenance read API + admin surface | **IMPLEMENTED** | `GET :id/summary/:id/provenance` + versions/diff, plus the harness-observability screen (WORM trail, gate queue, edit-burden, golden sets) |
| **P-19** | Template versioning/governance and audio-pipeline config | **IMPLEMENTED** | US-AD-01 and US-AD-02 both fully satisfied across API + UI |
| **P-20** | Two-tier idempotency-key discipline in the harness | **IMPLEMENTED** | Execution-scoped keys (`workflow_run_id:activity_id`) for retry duplicates vs. content-hashed keys for cross-execution duplicates — worth preserving in any redesign |
| **P-21** | The kill-switch discipline itself | **IMPLEMENTED** | `consultation-gates.constants.ts` is an unusually rigorous piece of config engineering: kill-switches live in `global-kv`, resolve at call time, propagate on `app-settings:invalidate`, and `SettingsRegistry.killSwitches()` **refuses boot** if one defaults ON. The problem is which side of the switch the safeguards sit on (§4), not the mechanism |

---

## 3. VIOLATED — ranked, worst first

> Two `ABSENT` findings outrank most of this list in real risk — **A-01 (no consent/ABAC)** and **A-04 (no contradiction detection)** — but are excluded here because they breach `MUST NOT`s by *having no implementation at all*. Their remediation is "build a domain", not "fix a guard". Do not read their absence from this section as lower priority.

| # | ID | Mechanism | Evidence | Failure scenario | Default config? | Blast radius |
|---|---|---|---|---|---|---|
| 1 | **A-02** | No PHI sanitization between finalized transcript and model input | `ner.processor.ts:92-99,219-221`; guardrail `pii_detection` has no `sanitized_text` field and fails open | Patient/family names and phone numbers spoken aloud flow verbatim into `/classify/tokens` and every SMR call. Vault-Transit protects storage, not inference input | **YES** — both default-on paths | Every consultation, every tenant |
| 2 | **A-03** | Prompt templates instruct the LLM to free-write ICD-10 codes | `seed/07-prompt-template.ts:43,369,561,698,768,1007,1057,1158,1207,1908,2394`; MCP validator unregistered (`mcpToolsEnabled` nullable, no seed writer) | Model writes `"Community-acquired pneumonia (ICD-10 J18.9)"` into a plain-string assessment field. If the correct code is J15.9, nothing catches it — no tool, no confidence, no flag. Ships in the signed note indistinguishable from a verified code | **YES** — default SOAP + ~10 department templates | Every tenant on the default catalog; billing + diagnosis correctness |
| 3 | **A-06** | `textSamples` bypasses the approved-notes gate; no redaction; profile injected into other patients' prompts | `dna-writing-style.processor.ts:105-111`; `text-compat.controller.ts:284-302` | A doctor (or any tenant admin, for any doctor) posts `textSamples:["Patient John Doe, MRN 12345, on Warfarin 5mg…"]`; it is stored as permanent writing DNA and later injected into an unrelated patient's summary prompt | **YES** — endpoint always reachable | Cross-**patient** PHI leak; no remediation path (A-10) |
| 4 | **A-07** | Two AI write paths overwrite `ContextItem.content` with no edit check | `live-documentation.service.ts:1802-1873` (30s cadence); `harness-internal.service.ts:761-774` | Clinician corrects a medication dose in the live note; within 30s the next snapshot flush overwrites it with fresh AI wording. Precisely the "silently restore old wording" mode T12.2 forbids by name | **YES** — Path 2 fires every 30s of every live session | Highest-frequency write path in the session |
| 5 | **A-08** | No OCC on any note-content write; no `@RequiresIfMatch` | `summary.service.ts:767,994`; `context.service.ts:519`; zero `RequiresIfMatch` in the controller | Two tabs, or a stale retry after a network blip: A's save silently last-write-wins over B's edit. No 412, no warning, no merge prompt | **YES** — ordinary concurrent use | Sharpest gap in the audit: a **regression relative to ≥6 sibling modules** that use the pattern correctly |
| 6 | **A-05** | Default prompt path hands conflicting sources to the LLM with silent precedence rules | `prompt-assembly.service.ts:507-607,82-89,579-589`; `live-documentation.service.ts:1933` | Patient says "no prior surgery"; attached CT describes post-op clips. The model silently synthesizes a winner. No event, no flag, no block | **YES** | Every tenant except the one with the seeded ArcaAI `RULE 5 — CONFLICT` corpus |
| 7 | **A-11** | First-flush SMR failure publishes `runningSummary:''` with a fresh timestamp | `live-documentation.service.ts:1090-1092,1145-1149,1249`; `smrFailed` omitted from the wire DTO | Clinician's live panel shows an empty note refreshing on a ~4s cadence, visually identical to "the visit just started" | **YES** — `LIVE_DOC_ENABLED` defaults `'true'` | Every live session where SMR is unreachable |
| 8 | **A-16** | Confidence has no column to live in | `TranscriptSegment` model + `TranscriptSegmentInput` DTO both lack it; Whisper word-confidence is `None` | A high-ambiguity medication mishearing renders identically to a 99%-confident one | **YES** | Platform-wide; also structurally blocks A-38 |
| 9 | **A-13** | Two independent "closed" trackers, neither aware of the other | `consultation.service.ts:664-712`; `consultation.controller.ts:431-442` (ownership-only guard) | `POST :id/close` on a fresh, never-recorded consultation: `metadata.status=CLOSED` while typed `status` stays `OPEN`. A "Closed" record with no "Closed Approved" | **YES** | Any consumer of "is this closed" — UI, reporting, retention scheduling |
| 10 | **A-38** | Confidence floor defaults to `0.0` | `nlp/core/config.py:300`; `.env.sample` `NLP_LINKER_CONFIDENCE_FLOOR=0.0` | Every entity passes the gate. Even a strict floor could not help — ASR confidence never reaches NLP | **YES** | All ontology linking |
| 11 | **A-28** | `adjudicate()` accepts the highest-confidence view with no clinician gate | `models.py:1595-1665` | Two specialists disagree 0.62 vs 0.58; the 0.62 view proceeds silently | **NO** — doubly gated off | Multi-specialist path only (lowest-priority use case) |
| 12 | **A-30** | Generic ops signal endpoint writes caller-supplied `clinicianId` into a WORM row | `harness-admin.controller.ts:485-493`; `harness-internal.service.ts:1211-1247` | A tenant-admin-scoped actor injects a `GATE_DECISION` row with a fabricated clinician identity. **Cannot** forge a signed note | YES (requires elevated ability) | Audit-integrity dent, bounded |

---

## 4. GATED-OFF inventory

The category the lane agents did not have. **"Not built" and "built but switched off" are entirely different remediation programs.**

### 4.1 The three switches, and their verified defaults

| Switch | Where | Default | What it gates |
|---|---|---|---|
| `pipeline.harnessEnabled` | `config-resolver.service.ts:80` (codeDefault `false`, maxScope DEPARTMENT, globalOnly) + seeded SYSTEM row `harnessEnabled:false` | **OFF** | Whether a consultation's note comes from `HarnessDocWorkflow` (sensors, groundedness, MCP hook, gate) or the legacy BullMQ `SummaryProcessor` (none of those) |
| `harness.loop.enabled` | `consultation-gates.constants.ts` (`CONSULTATION_GATE_DEFAULTS`) | **OFF** | Whether `ConsultationLoopWorkflow` exists at runtime at all — drain, per-agent timeout isolation, `continue_as_new` checkpointing, adjudication, loop event stream |
| `LIVE_DOC_ENABLED` | `live-documentation.service.ts:449` | **ON** | The live SSE work-note loop |

Two seeded tenants (a clinical-workspace demo and the ArcaAI tenant) set `harnessEnabled=true` at TENANT scope. **Every other tenant runs the legacy path.**

### 4.2 Re-classification of lane ABSENT/PARTIAL findings against this axis

| Finding | Was | Now | Enabling the flag WOULD fix | Enabling the flag would NOT fix |
|---|---|---|---|---|
| A-26 two-phase drain | B: PARTIAL | **GATED-OFF** (`harness.loop.enabled`) | Multi-agent drain with bounded await + force-stop | Marking sections incomplete (no section model — A-12); no `Consultation`-level Draining state |
| A-27 per-agent timeout isolation | B: PARTIAL | **GATED-OFF** (`harness.loop.enabled`) | `SpecialistWorkflow` isolation, degrade-parent-on-child-error | The `agent.timeout` named event (still conflated); `Degraded` as a state (A-41) |
| A-09 clinical safety sensors | D: PARTIAL/ABSENT | **GATED-OFF** (`harnessEnabled`) for dosage/grounding | Dosage + entity-grounding + groundedness reach the default tenant | **Allergy, laterality, patient-identity remain ABSENT at any flag setting** — they are not implemented anywhere |
| A-19 retrieval quality | D: PARTIAL/VIOLATED | **GATED-OFF** (`harnessEnabled` + `RetrievalConfig.enabled`) | RAG runs at all | Abstention (does not exist); source date/version (**no schema column**) |
| A-22 terminology validation | C/D/E: PARTIAL/ABSENT | **GATED-OFF** (triple: `harnessEnabled` → `mcpToolsEnabled` → a registered server) | Advisory post-hoc validation | It is **post-hoc and non-gating by design** — it never strips or blocks an already-persisted code, and it does not touch A-03's prompt-authored codes at all |
| A-28 adjudication | C/D: VIOLATED | **GATED-OFF** (`harness.loop.enabled`) | — (enabling it *introduces* the auto-resolve risk) | The reference's actual inter-source contradiction case (A-04) |
| A-25 sign-before-assurance | **B ranked #2 VIOLATED** | **GATED-OFF (risk)** (`optimisticDeliveryEnabled`, default `false`) | — (enabling it *introduces* the risk) | — |
| A-15 retention | C/E: PARTIAL | **PARTIAL + GATED-OFF** (both jobs `enabled:false`) | Purging `AuditLog` + `AgentTrajectoryStep` | Everything the reference means: `ContextItem`, versions, transcripts, recordings, notes have **no TTL surface at all** |
| A-33 timed-out state | B/E: PARTIAL | **GATED-OFF** for the SLA timer; ABSENT for the state | Gate-SLA escalation firing at all | `TIMED_OUT` in the enum; clinician notification |

### 4.3 The load-bearing consequence

**Turning both harness switches on would not make the default path safe — it would make it a different path.** The safeguards that materialize are: dosage + entity-grounding sensors, groundedness scoring, multi-agent drain, per-agent timeout isolation, durable checkpointing, and an (unregistered, non-gating) terminology hook.

The eleven CRITICAL/HIGH findings that **survive every flag being on**: A-01 (consent), A-02 (PHI sanitizer — the harness redactor is egress-scoped and never touches the STT→NLP hop), A-03 (prompt-authored ICD-10 — harness re-runs NER over the note but never persists or verifies `note_entities`), A-04 (contradiction), A-06 (DNA PHI), A-07 (overwrite — worse with the harness on, since Path 1 requires a second `HarnessDocWorkflow` execution), A-08 (OCC), A-10 (erasure), A-12 (section-level HITL), A-16 (confidence column), A-18 (imaging).

---

## 5. Register coverage — honest accounting

Coverage is reported in three tiers, because a single blanket verdict ("no `Consent` model exists") legitimately resolves 39 invariants without examining any of them individually, and reporting that as "39 audited" would overstate the work.

- **Directly evidenced** — a lane cited `file:line` bearing on that invariant's own mechanism.
- **Cluster-resolved** — covered only by a structural blanket verdict.
- **Unaudited** — no lane produced evidence bearing on it.

| Category | Invariants | Directly evidenced | Cluster-resolved | Unaudited | Verdict distribution (adjudicated) |
|---|---:|---:|---:|---:|---|
| labeling-transparency | 57 | 13 | 22 | **22** | 1 VIOLATED, 2 ABSENT, 3 PARTIAL |
| hitl-authority | 41 | 19 | 14 | 8 | 2 VIOLATED, 2 ABSENT, 3 PARTIAL, 2 IMPLEMENTED |
| consent-abac | 40 | 4 | 33 | 3 | 1 VIOLATED (A-02), 1 ABSENT (A-01), 1 PARTIAL |
| audit | 37 | 14 | 14 | 9 | 1 ABSENT, 3 PARTIAL, 2 IMPLEMENTED |
| provenance | 31 | 15 | 9 | 7 | 2 PARTIAL, 3 IMPLEMENTED |
| template-config | 26 | 11 | 9 | 6 | 2 ABSENT, 2 PARTIAL, 2 IMPLEMENTED |
| style-dna | 25 | 8 | 11 | 6 | 1 VIOLATED |
| contradiction | 22 | 5 | 17 | 0 | 2 VIOLATED, 1 ABSENT, 1 GATED-OFF |
| degradation | 22 | 10 | 6 | 6 | 1 VIOLATED, 2 PARTIAL, 1 GATED-OFF |
| terminology | 21 | 11 | 6 | 4 | 2 VIOLATED, 1 PARTIAL/GATED-OFF |
| checkpoint-resume | 21 | 8 | 9 | 4 | 1 ABSENT, 1 PARTIAL, 1 IMPLEMENTED |
| commit-idempotency | 20 | 9 | 8 | 3 | 1 VIOLATED, 1 ABSENT, 1 PARTIAL |
| timeout-approval | 20 | 12 | 8 | 0 | 1 PARTIAL, **2 IMPLEMENTED (the keystone)** |
| debounce-synthesis | 16 | 6 | 5 | 5 | 1 PARTIAL, 1 GATED-OFF |
| partial-vs-final | 14 | 6 | 5 | 3 | 1 VIOLATED, 1 PARTIAL, 1 IMPLEMENTED |
| multimodal | 12 | 5 | 4 | 3 | 1 ABSENT |
| drain-shutdown | 11 | 4 | 6 | 1 | 1 GATED-OFF |
| retention-erasure | 9 | 4 | 3 | 2 | 1 ABSENT, 1 PARTIAL/GATED-OFF |
| **Total** | **445** | **164** | **189** | **92** | — |

**Coverage: 353 / 449 = 78.6% audited; 92 (20.5%) unaudited.** (The register's own §Metrics category tally sums to 445, not 449 — a 4-row discrepancy, logged in §8.)

**Largest unaudited category: `labeling-transparency` — 22 of 57 untouched.** This is not random. It is the category whose invariants are about *what the clinician sees on screen*, and all four lanes were static-code lanes. No lane ran the application.

### 5.1 Invariant IDs no lane touched

**labeling-transparency (22):** INV-012, INV-030, INV-051, INV-057, INV-087, INV-132, INV-148, INV-182, INV-188, INV-194, INV-203, INV-218, INV-222, INV-249, INV-256, INV-267, INV-279, INV-289, INV-294, INV-322, INV-416, INV-444
**hitl-authority (8):** INV-041, INV-104, INV-287, INV-290, INV-302, INV-376, INV-403, INV-408
**audit (9):** INV-035, INV-230, INV-286, INV-299, INV-306, INV-310, INV-326, INV-414, INV-441
**provenance (7):** INV-038, INV-221, INV-225, INV-277, INV-278, INV-292, INV-295
**template-config (6):** INV-078, INV-166, INV-243, INV-276, INV-314, INV-328
**style-dna (6):** INV-169, INV-240, INV-242, INV-374, INV-375, INV-377
**degradation (6):** INV-034, INV-143, INV-298, INV-316, INV-410, INV-423
**debounce-synthesis (5):** INV-044, INV-108, INV-358, INV-385, INV-386
**checkpoint-resume (4):** INV-271, INV-273, INV-394, INV-419
**terminology (4):** INV-370, INV-372, INV-373, INV-429
**consent-abac (3):** INV-309, INV-329, INV-344
**partial-vs-final (3):** INV-176, INV-183, INV-220
**multimodal (3):** INV-272, INV-384, INV-390
**commit-idempotency (3):** INV-252, INV-291, INV-380
**retention-erasure (2):** INV-285, INV-326
**drain-shutdown (1):** INV-123

### 5.2 The three coherent themes inside the unaudited set

1. **Rendered-state invariants (~30 IDs).** "Visibly marked without relying only on color", "visually distinct", "confidence not presented as a clinical probability", "visible processing indicator". Unreachable by static analysis. **Requires a running-app lane with an accessibility pass.**
2. **Style-cannot-override-safety (INV-078, 166, 243, 376).** Four invariants stating documentation-style preferences must never waive clinical or tenant safety rules. **No lane examined whether style application is bounded by anything.** Given A-06, this is a conspicuous omission.
3. **Aspirational-product stories (~15 IDs).** Specialist handoff (INV-284-287), nurse action items (INV-288-291), multidisciplinary blackboard (INV-384-389), telehealth shared ledger (INV-272). Lane E judged these to describe a materially larger product; they should be scoped out of the register rather than carried as gaps.

---

## 6. Conflict resolutions

### C1 — Pipeline topology · RULING: four paths, hierarchical *and* parallel; both lanes were partly right

Neither lane had the whole shape. The evidence:

| Path | Trigger | Produces | Can it reach a signed note? | Default? | Safety posture |
|---|---|---|---|---|---|
| **1. Legacy BullMQ** `SummaryProcessor` → `NerProcessor` | `TranscriptionCreated` when `harnessEnabled=false` | `RAW_SUMMARY` | **YES** | **YES — the platform default** | Lowest. No sensors, no groundedness, no terminology validation, no adjudication. Prompt-authored ICD-10 (A-03) |
| **2. `HarnessDocWorkflow`** (Temporal, frozen, bounded) | Same event when `harnessEnabled=true` | `RAW_SUMMARY` via `persistDraft` | **YES** | **NO** — two seeded tenants only | Highest available: computational + inferential sensors, groundedness, gate, WORM trail |
| **3. `LiveDocumentationService`** (SSE) | Direct STT stream subscription | `PRE_SUMMARY` / `LIVE_SOAP_SNAPSHOT` | **NO** — `isFinalSummary` excludes `PRE_SUMMARY` (`ContextItemEntity.ts:267`) | **YES** | Ephemeral work note. Groundedness on output, nothing on input. Empty-publish defect (A-11), 30s overwrite (A-07) |
| **4. `ConsultationLoopWorkflow`** | `ContextAdded`/ending signals when `harness.loop.enabled=true` | Nothing of its own | Only via path 2 | **NO — off everywhere** | Orchestration wrapper. `_start_finalize_child` calls `workflow.start_child_workflow(HarnessDocWorkflow.run, …)` at `workflows.py:2452-2453` |

**Ruling.** Lane B is **correct** that the loop is hierarchical over the doc workflow — I confirmed the child-workflow call site; it composes, it does not reimplement. Lane D is **correct** that multiple pipelines with materially different safety postures coexist. Both missed the decisive fact: **paths 1 and 2 are mutually exclusive per tenant and switch on `harnessEnabled`, whose code default and seeded SYSTEM-tenant value are both `false`.** So there are **two independent signable-note generators** (1 and 2, mutually exclusive), **one ephemeral work-note generator** (3, always on, cannot sign), and **one dormant orchestration wrapper** (4, composes 2).

**Default-live is path 1 + path 3.** Lane B's claim that "in the default, always-on configuration `HarnessDocWorkflow` runs once at stop/finalize" is **wrong for a default tenant** — it corrected for the two seeded tenants only. This single correction reshapes remediation: the safest generator is the one almost no tenant uses.

### C2 — `harness.loop.enabled` defaults false · RULING: three switches, not one; see §4

Confirmed and extended. `harness.loop.enabled` is **not** the switch that matters most — `pipeline.harnessEnabled` is, because it decides which *generator* runs, while the loop flag decides only whether an *orchestrator* wraps it. A third switch, `optimisticDeliveryEnabled` (default `false`), reclassifies lane B's #2-ranked VIOLATED into a latent risk. Full re-classification table at §4.2; the eleven findings that survive all flags being on are at §4.3.

### C3 — Lane E's declared blind spot · RULING: 2 of 6 verdicts corrected; 4 confirmed as genuine platform gaps

Lane E deliberately did not read `apps/harness` or `apps/nlp` and flagged its verdicts accordingly. Cross-referenced against B/C/D plus my own reads:

| Lane E finding | E's verdict | Adjudicated | Basis |
|---|---|---|---|
| F-20 contradiction | ABSENT-in-scope | **CONFIRMED ABSENT** | My own sweep across `apps/harness` + `apps/nlp` + all TS: two hits, both unrelated |
| F-21 imaging/vision | ABSENT-in-scope | **CONFIRMED ABSENT** | Zero `pydicom`/`.dcm` anywhere in `apps/` or `packages/`; D read the vision tool and found it explicitly non-diagnostic |
| F-04 section-level HITL | ABSENT | **CONFIRMED ABSENT** | C confirmed at the harness layer: `HarnessGateDecisionRequest` records one aggregate verdict. Not a proxying gap |
| F-01/F-02 consent | VIOLATED / ABSENT | **CONFIRMED** (verdict harmonized to ABSENT, see §7) | B and C independently swept the same trees |
| **F-07 terminology binding** | **ABSENT-in-scope** | **CORRECTED → PARTIAL + GATED-OFF (A-22)** | D found a real mechanism E could not see: `ontology_linker.py`, a deterministic ~40-term dictionary that runs on the default path and *structurally cannot hallucinate*, plus a GATED-OFF MCP validator |
| **F-11 guideline allowlist** | **ABSENT (vs spec)** | **CORRECTED → PARTIAL (A-37)** | D found a genuine allowlist E could not see: `qdrant_store.py:112-146` filters on `tenant_id` + `status=APPROVED`. Precedence and versioning remain absent |

**2 of 6 corrected.** Lane E's self-declared caveat was well-calibrated — it did not over-claim, and the two corrections both moved in the same direction (a real mechanism existed in a service it could not read). No double-counting was found: E's ABSENT verdicts and D's findings describe the same gaps and have been merged into single rows.

### C4 — Overlapping overwrite claims · RULING: **one root cause, two distinct defects, and they compound**

**Root cause:** `ContextItem.content` has no concurrency control on *any* writer. `Repository.updateWithVersion` exists and is used correctly in ≥6 other modules; the consultation note path uses plain `.update()` everywhere (verified: `summary.service.ts:767,994`, `context.service.ts:519`, and **zero** `@RequiresIfMatch` in the controller).

**Two distinct defects, different victims and different triggers:**

| | A-07 (lane C) | A-08 (lane E) |
|---|---|---|
| Victim | Clinician edit overwritten by an **AI process** | Clinician edit overwritten by **another human** (or a stale retry) |
| Trigger | 30s snapshot timer; second `HarnessDocWorkflow` execution | Two tabs; concurrent editors; retry after a blip |
| Invariant | INV-029/052/085/092 "user-authored text protected from automatic overwrite" | INV-157/257/382 "commit uses record-version checks" |
| Fix | Read `currentVersionNumber` before writing; divert to FLAG on drift | `@RequiresIfMatch` + `updateWithVersion` on the three routes |

**They compound in three ways.** (1) They share one fix primitive — A-07's remediation *is* A-08's `updateWithVersion`, so fixing either half-way leaves the other reachable. (2) A-08 removes the detection A-07 would need: with no version check on the write path, the AI writer has no mechanism available to notice it is clobbering an edit even if it wanted to. (3) Sequenced, they are worse than either alone: clinician edits (v2) → AI snapshot overwrites (A-07) → clinician re-edits from a stale tab (A-08) → the note now contains neither correction, with a version history that shows three writes and no conflict.

**Not merged into one row** — they are not duplicates, and merging would hide a fix that must be applied at two different call sites. Cross-referenced instead.

---

## 7. Corrections to lane findings

| # | Lane | Correction |
|---|---|---|
| 1 | **B** | **Overstated the default topology.** B's two-orchestrator analysis states `HarnessDocWorkflow` runs "in the default, always-on configuration". It does not: `harnessEnabled` code-defaults `false` and the seeded SYSTEM policy sets it `false`. B analyzed the two seeded tenants' configuration as if it were the platform default. This is the audit's most consequential single correction (C1) |
| 2 | **B** | **Over-ranked F-07 (sign-before-assurance) as #2 VIOLATED.** `optimistic_delivery_enabled` defaults `False` at `models.py:57` and `config.py:367`; without it, drafts arrive with `assuranceCompletedAt` stamped and the safety-FLAG block applies. Reclassified **GATED-OFF (risk)**, MEDIUM. B itself noted its sub-agent "did not confirm the default" — it was right to flag the uncertainty and wrong to rank on it |
| 3 | **E** | **F-07 terminology ABSENT → PARTIAL + GATED-OFF.** A real, non-hallucinating deterministic linker runs on the default path (C3) |
| 4 | **E** | **F-11 guideline allowlist ABSENT → PARTIAL.** A tenant + `APPROVED` allowlist genuinely exists in the vector store (C3) |
| 5 | **E** | **F-01 consent VIOLATED → ABSENT (harmonized).** E's reasoning was sound but produces a verdict that mis-signals remediation: "VIOLATED" implies a guard to fix; there is no consent artifact to guard. Retained at CRITICAL and called out above §3 so it is not buried by the re-grade |
| 6 | **C** | **F-08 adjudication VIOLATED → GATED-OFF + VIOLATED-in-scope.** C ranked it #3 VIOLATED with appropriate caveats; it is doubly unreachable (loop off; wrong scope). C's own open question #1 anticipated exactly this |
| 7 | **D** | **"Three parallel consultation pipelines" is imprecise.** There are four paths, and the first two are *mutually exclusive per tenant*, not parallel. D also treated the live SSE loop as a peer note-producer; it cannot produce a signable note (`isFinalSummary` excludes `PRE_SUMMARY`). D's safety-posture analysis is otherwise the most decision-relevant contribution in the wave |
| 8 | **C** | **F-07 retention PARTIAL understated.** C correctly found both jobs default OFF but reported the finding as "two real jobs exist, narrow scope". In default configuration **nothing in the platform ever expires** — including the two tables that do have jobs |
| 9 | **B, C** | **Duplicate reporting of the "no invalidation cascade" finding** (B via F-12 event taxonomy, C via F-14/lifecycle). Merged into A-35 |
| 10 | **B, C, D, E** | **Consent reported four times** (B:F-03, C:F-01, D implicit, E:F-01+F-02) and **contradiction four times** (B:F-04, C:F-03, D:F8, E:F-20). Merged into A-01 and A-04. No lane double-counted *within* itself |
| 11 | **All** | **Register defect, not a lane defect:** §Metrics' per-category tally sums to **445**, not the stated 449 — a 4-row discrepancy carried into §5's denominator |
| 12 | **All** | **No lane ran the application.** Every verdict in this matrix is static-code evidence. This is the direct cause of the 22 unaudited `labeling-transparency` invariants (§5.2) and means every "visibly marked" invariant is genuinely unverified, not merely unreported |

---

## 8. Reference defects worth carrying forward

- **`Degraded` as a state vs. a flag.** The XML models it as a single-row transient while every other row is a durable state. HOPE's boolean-flag-on-active-phase resolves the ambiguity more cleanly than the reference does (A-41).
- **"Closed Approved" (T21) and "Closed" (T23) as two top-level states** is over-specified — T23 is housekeeping with no human gate. Merging them would have made A-13 impossible to misread as "two states, so two write paths are fine".
- **"Provenance graph" (T21) implies one object.** In code the data is real but spans four tables joined by shared ids (`SummaryMeta`, `AgentTrajectoryStep`, `HarnessAuditEvent`, `ContextItemVersion`).
- **UC-06's "escalate to HITL merge" is operationally undefined** for a Temporal workflow that cannot block indefinitely. The code had to answer this alone (auto-resolve-and-record, A-28).
- **T10/UC-03 presume a live terminology MCP server is the only sound design.** HOPE's deterministic dictionary structurally cannot hallucinate — the reference should say whether a curated table is an acceptable substitute (A-22).
- **T18 conflates clinical-fact safety checks with generic LLM content-safety.** HOPE implements the latter (Granite Guardian) and largely not the former (A-09); the two must not be scored as one.
- **`REOPENED` appears in the stories but not the XML's 11-state enumeration.**

---

## 9. What the architecture stage must decide first

1. **Which generator is the product?** Every remediation estimate depends on whether the target is hardening path 1 (legacy, default, least safe) or migrating tenants to path 2. Doing both doubles the work; doing neither leaves A-03/A-09 unfixed for the tenants that actually exist today.
2. **Consent is a domain, not a guard** (A-01), and A-10 cannot start until it lands.
3. **A-08's fix primitive is already in the codebase** and unblocks A-07. Highest safety-per-line-changed in the whole matrix.
4. **A-02 and A-03 are one-hop fixes on the default path** — a guardrail call before `/classify/tokens`, and removing "ICD-10 codes" from 14 seeded prompts — and together they close two of the three worst CRITICALs without any architectural change.
5. **The section model (A-12) is the keystone for ~20 invariants** across `hitl-authority`, `commit-idempotency`, `labeling-transparency`, and `audit`. Nothing per-section can be built until `ContextItem` has addressable sections.
6. **Commission a running-app lane** before the next audit: 22 of 57 `labeling-transparency` invariants are structurally unverifiable from source.
