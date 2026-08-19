# HOPE Consultation Audit — Wave 2, Lane H: target architecture, spec red-team, sequenced remediation

**Inputs:** `10-conformance-matrix.md` (authoritative), `90-verification-critical.md`, `00-invariant-register.md`, lanes `01`–`04`, plus fresh code reads recorded below.
**Repo:** `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2`, branch `feat/loop`. Static evidence; no application was run.
**Framing:** `docs/architecture/consultation-session-workflow/` is untracked and new this sprint. Everything below is a gap against a newly-adopted standard, not a regression against a shipped promise. The hazards are still real; two of them are live in a seeded tenant today.

---

## Executive summary

**Decision: make `HarnessDocWorkflow` the sole signable-note generator — but stage it, and do the entry-point consolidation first, because the flag that is supposed to select the generator does not actually govern three of the four ways a note gets made.**

The audit's headline — "the default configuration routes clinical documentation through the least-safeguarded pipeline" — is true and understated. `POST :id/summary/async` (the regenerate button), `SummaryService.generate` (the synchronous path), and `ComprehensiveSummaryProcessor` never read `harnessEnabled` at all. A tenant with the harness explicitly **on** — including the seeded ArcaAI production day-1 tenant — still gets an ungated legacy draft from any of them. And because the legacy path writes no `SummaryMeta`, those drafts sign straight through the assurance guard: `signedBeforeAssurance` is `!!draftMeta && …`, so no metadata means no check (`summary.service.ts:866-867`).

So the first move is not migration. It is putting every generation entry point behind one seam so the flag means something. That is cheap (~2 forks plus 3 unforked call sites) and it is a precondition for every other option.

Two corrections to the adjudicated matrix follow from this wave's reads, and both matter for sequencing. First, **`harness.loop.enabled` is seeded `'true'` in every environment** (`seed/11c-consultation-gate-settings.ts:69`, *"Enabled on day 1 in every environment"*) even though its code default is `false`. The loop may not be dormant; where seeds ran, `adjudicate()`'s silent auto-resolution (A-28) is live, not gated off. Second, the harness's operational substrate is not ready to be mandatory: Temporal runs on an unmanaged VM with a dead in-cluster copy, harness and harness-worker are **not in the k3s base**, and `harness-eval-gate` is `allow_failure: true` and fails closed for want of a judge backend — **there is no working clinical-quality gate in CI today.** *(Updated 2026-08-17: re-verified against `arca/hope-v2-deployment` and confirmed precisely. The hosting question has since been decided: self-hosted Temporal in k3s, ratifying the existing (but currently disconnected) in-cluster `hope-temporal` Deployment rather than the VM — `temporal-hosting-decision.md` §6. The harness+harness-worker manifests are also further along than "not in the k3s base" now suggests: they exist and are synced to `hope-v2-dev` (§2.10/§2.11 of the same ticket); the exact reconnection patch is written but not yet applied — `deployment-repo-changes.md`. The `harness-eval-gate` gap is unchanged.)*

That combination sets the plan. Containment now (days): the DNA feature is on in a seeded production tenant with no redactor anywhere in the codebase; 13 seeded prompts instruct the model to free-write ICD-10 codes; the live path publishes empty notes on first-flush failure. Then structural foundations (OCC, a real PHI redactor, the session state machine, consent) — none of which depend on which generator wins. Then generator consolidation. Then the section model, which is the keystone for roughly twenty invariants and is cheaper than it looks, because per-section write authority already exists as validated configuration (`DepartmentAgent.writeScope`) that no runtime write site enforces.

Eleven CRITICAL/HIGH findings survive every flag being on. Flags are containment, never the fix.

---

## The generator decision

### The four paths, restated with this wave's corrections

| Path | Trigger | Signable? | Default? | Correction from this wave |
|---|---|---|---|---|
| 1. Legacy BullMQ `SummaryProcessor` (389 LOC) + `NerProcessor` (237) | `TranscriptionCreated` when `harnessEnabled=false` | **YES** | **YES** (SYSTEM cascade) | Also reachable on harness-ON tenants via 3 unforked entry points |
| 2. `HarnessDocWorkflow` (~1,330 LOC, frozen, 11 patch eras, 12 replay fixtures) | Same event when `harnessEnabled=true` | **YES** | No — but **both** seeded real tenants (demo, ArcaAI) set it true | Start path has no fallback and one silent-drop bug |
| 3. `LiveDocumentationService` (2,434 LOC) | Direct STT subscription | No (`isFinalSummary` excludes `PRE_SUMMARY`) | YES | Loop *dispatches* it; contract is "the loop never absorbs it" |
| 4. `ConsultationLoopWorkflow` (~920 LOC) | `contextAdded` / ending signals | Only via path 2 | **Seeded ON**, code default off | Not dormant where seeds ran. Not a skeleton: pinned config, 7 implemented actions, 2 patch eras, ~2,170 LOC of tests, 3 replay fixtures |

The decisive structural fact: **paths 1 and 2 are not mutually exclusive per tenant.** `consultation.controller.ts:1146` (`generateSummaryAsync` → `createSummaryJob`), `summary.service.ts:503` (a third full generator with its own prompt assembly and SMR call), and `ComprehensiveSummaryProcessor` all bypass the fork at `consultation-event.handler.ts:146`.

### Options, honestly

**(a) Harden the legacy BullMQ generator in place.**
*Cost:* medium, and lower than the matrix implies — several safeguards are already reachable from TypeScript. Groundedness runs from TS on the live path today (P-15). `HarnessAuditEvent` is written from TS (`harness-internal.service.ts`). `SummaryMeta` + `assuranceCompletedAt` is a write, not a system. What is genuinely Python-only is the sensor suite (`numeric_dose.py`, entity faithfulness, coverage) and the gate.
*Fixes:* the assurance-guard vacuum, the missing `PENDING_REVIEW` lifecycle, and — with a guardrail call — groundedness on the default path.
*Leaves broken:* dosage/faithfulness/coverage sensors, the gate, terminology validation, WORM generation trail. And it creates a **second permanent assurance implementation** in a second language that must be kept in step with the first.
*Risk:* the classic one — the "temporary floor" becomes the permanent product because it is the one that works, and the harness ossifies as the thing two tenants use.
*Exposure meanwhile:* short. Weeks.

**(b) Migrate all tenants to `HarnessDocWorkflow` and retire legacy.**
*Cost:* the fork removal is trivial (~35 LOC across 2 sites). The three unforked entry points must be routed. `summary.processor.ts` + `ner.processor.ts` (~626 LOC) become retirable; `prompt-assembly`, `prompt-resolution`, `text-generate` and the SSE/progress plumbing are **shared with the harness** and stay. The real cost is operational: Temporal onto managed infrastructure and under GitOps, harness + harness-worker into the k3s base, staging/prod namespaces that have never been created, and a judge backend so `harness-eval-gate` stops being `allow_failure: true`.
*Fixes:* reaches the sensors, groundedness, gate, WORM trail, and `PENDING_REVIEW` lifecycle for every tenant. This is the single highest-leverage change in the matrix, because most of the safeguards are *built and unreachable*, not missing.
*Leaves broken:* all eleven flag-surviving CRITICAL/HIGHs — consent, PHI redaction, prompt-authored ICD-10, contradiction, DNA, overwrite, OCC, erasure, section HITL, confidence column, imaging.
*Risk:* the sharp one. Making a Temporal dependency mandatory converts a harness outage from "two tenants degrade" into "no clinician gets a note." Path 2's start has **no fallback** and a silent-drop bug (`this.harnessGatewayService?.start(...)` on an `@Optional()` dependency logs *"Harness document workflow start requested"* and returns, producing a success log and zero notes). Migrating clinical documentation with no working PASS/FAIL quality gate in CI is the highest-risk item in this whole program.
*Exposure meanwhile:* long. The infra prerequisites are a quarters-scale program largely outside this team's control.

**(c) Adopt `ConsultationLoopWorkflow` as the orchestration layer over a single generator.**
*Cost:* low in code — it is complete, tested, replay-fixtured, and composes the doc workflow as an unmodified child. High in blast radius: it dispatches `LiveDocumentationService`, and today the double-dispatch hazard is avoided only by a seed omitting `audio_stream` from `subscribedKinds` because the controller already owns LiveDoc lifecycle.
*Fixes:* two-phase drain (A-26), per-agent timeout isolation (A-27), durable checkpointing, budget-bounded cascade.
*Leaves broken:* everything (b) leaves broken, plus it **introduces** a hazard: `adjudicate()` silently accepts the highest-confidence view with no clinician gate (A-28), which the reference forbids by name.
*Risk:* it may already be on. The seed sets `harness.loop.enabled = 'true'`. Adoption is not the decision; *discovery* is.

**(d) Staged combination.** Consolidate entry points → raise a deliberately-minimal legacy safety floor → close harness operational prerequisites → flip the default and retire legacy.

### Recommendation

**Take (d), with (b) as the named, dated end-state. Do not adopt (c) in this program.**

Concretely, three phases:

1. **Consolidate.** Introduce one `NoteGenerationService` seam. Every generation entry point — event handler, `generateSummaryAsync`, `SummaryService.generate`, `ComprehensiveSummaryProcessor` — routes through it, and `harnessEnabled` is read in exactly one place. Nothing about *which* generator runs changes. This makes the flag mean what everyone already believes it means.
2. **Floor, not parity.** Bring the legacy branch of that seam to a safety floor: write `SummaryMeta` with `assuranceCompletedAt`, run the groundedness check that already runs on the live path, flip `Consultation.status` to `PENDING_REVIEW`, and append the WORM generation event. Explicitly *not* the sensor suite, *not* the gate. This is throwaway code, sized to the exposure window, and its scope is capped in writing so it cannot grow into a second assurance implementation.
3. **Migrate.** In parallel, close the harness prerequisites: Temporal consolidated and under GitOps, harness + harness-worker in the k3s base, and a judge backend so the eval gate produces a real verdict. Then flip the SYSTEM cascade default to `harnessEnabled: true`, retire `summary.processor.ts` and `ner.processor.ts`, and delete the legacy branch of the seam along with its floor.

Why this beats pure (b): pure (b) leaves every unconfigured tenant on the weakest generator for the duration of an infrastructure program measured in quarters. Why it beats pure (a): the floor is a floor by construction — capped scope, deletion scheduled in the same epic that builds it.

On the loop: **do not adopt it as the orchestration layer, but do two things with it.** First, determine whether it is actually running anywhere (the seed says yes, the code default says no, and `RUN_SEED` gating in the cluster makes it genuinely uncertain) — because if it is, A-28's auto-adjudication is a live defect, not a gated-off one. Second, harvest its model without its workflow: `LoopAgentSpec.may_write()` and `PRIMARY_ONLY_OUTPUT_KINDS = {note, gate}` (`models.py:1087-1093`, *"a tenant misconfiguring a specialist's write scope must not be able to hand that ownership away"*) is exactly the per-section write-authority primitive the target architecture needs. The team has already solved this problem once, in the right place, with the enforcement outside the agent's own code.

### What would have to be true for me to be wrong

- **The Temporal/k8s program is short (weeks, not quarters).** Then phase 2 is wasted work and the answer is pure (b) immediately. This is the most likely way I am wrong, and it is knowable by asking one infrastructure owner.
- **Harness availability under a mandatory dependency is worse than legacy's.** If making Temporal non-optional produces more clinical harm through missing notes than legacy produces through unverified ones, the end-state inverts and the answer is (a) permanently. This is unmeasured (see Risks §1).
- **A tenant population exists that cannot take a Temporal dependency** — on-prem, air-gapped, edge. Then legacy is a product requirement, not debt, and it must be hardened to parity rather than floored and deleted.
- **The harness's second-execution draft re-adoption fires often.** Migrating before the OCC fix lands would *increase* clinician-edit loss, because path 1 requires a second `HarnessDocWorkflow` execution to overwrite. This is a hard sequencing constraint, not a reason to change the destination.

---

## Target architecture

### 1. Session state machine

**What exists.** `ConsultationStatus` has seven members (`enums.prisma:278-288`): `OPEN`, `RECORDING`, `DRAFT_PENDING_SENSORS`, `PENDING_REVIEW`, `SIGNED`, `CLOSED`, `REOPENED`. `CLOSED` and `REOPENED` are written by no code. A *second*, rogue tracker exists in `metadata.status`, written by `closeConsultation()` behind an ownership-only guard — so `POST :id/close` on a never-recorded consultation produces `metadata.status = CLOSED` while typed `status` stays `OPEN` (A-13). `ConsultationEntity.status` is a bare setter; `validate()` enforces no transition legality (A-36).

**What the real machine should be — eleven persisted states, but not the reference's eleven.**

| # | State | Existing member | Enters on |
|---|---|---|---|
| 1 | `OPEN` | ✓ | Session created; consent/ABAC not yet evaluated |
| 2 | `PRIMED` | **new** | Consent + ABAC granted and prior history loaded |
| 3 | `RECORDING` | ✓ (reference calls it Streaming) | Capture started |
| 4 | `PAUSED` | **new** | Capture suspended, context durably checkpointed |
| 5 | `DRAINING` | **new** | Capture closed, in-flight agents finishing |
| 6 | `DRAFT_PENDING_SENSORS` | ✓ (reference: Drafting) | Reconciliation + verification running |
| 7 | `PENDING_REVIEW` | ✓ (reference: Awaiting Review) | Candidate offered for human decision |
| 8 | `SIGNED` | ✓ (reference: Closed Approved) | Human attestation — **the keystone, unchanged** |
| 9 | `TIMED_OUT` | **new** | Review SLA exhausted; visibly unsigned |
| 10 | `CLOSED` | ✓ (dead) | Archived, TTLs applied |
| 11 | `REOPENED` | ✓ (dead) | A signed or timed-out record reopened |

**`Degraded` is not a state.** It is a set of health flags ORed onto whatever phase the session occupies. The reference models it as a single-row transient (T10.1 enters it, T11 silently reverts to Streaming) while every other row is durable — a genuine spec defect (see red-team §1). HOPE's existing per-run booleans (`degraded`, `reduced_assurance`, `mcp_degraded`) are the better model; what is missing is a *consultation-level* projection a dashboard can filter. Add `Consultation.degradedReasons String[]` (append-only within a session, cleared on `SIGNED`), not a state.

**Changes.**
- Add four enum members to `ConsultationStatus` (append-only migration; the parity guard in `resourceType.enum-parity.test.ts` shows the discipline this repo already applies).
- Add `ConsultationEntity.transitionTo(next, actor, reason)` carrying an explicit legality matrix; make `status` private to it. Every write goes through one method — this is where `validate()`'s missing transition legality lands.
- **Delete `metadata.status`.** One closed tracker. A lint/test gate asserting zero writers.
- Persist transitions as sys-events (`ResourceUpdated`) for the routine ones, and append the clinically-significant four (`PRIMED`, `SIGNED`, `TIMED_OUT`, `REOPENED`) to `HarnessAuditEvent`, which is already immutable at the DB layer (P-03). No new ledger.
- Status writes take OCC (`updateWithVersion`), same as note content.

**Invasiveness:** M. One enum migration, one entity method, one rogue writer deleted.

**Guarded transitions worth naming:** `RECORDING` is unreachable before `PRIMED`; `SIGNED` is unreachable unless every required section is `APPROVED` (§3); `TIMED_OUT → SIGNED` is legal (the reference is right that a later explicit approval may still commit); `CLOSED` is unreachable except from `SIGNED` or `TIMED_OUT` — which is exactly the invariant A-13 breaks today.

### 2. Context-item lifecycle

**What exists.** `ContextItem` (`consultation.prisma:73-179`) carries `_version` (unused for OCC), `currentVersionNumber` (a content pointer), `kindKey`, `contextSchemaVersionId`, encrypted content. `ContextItemVersion` is an immutable snapshot trail with `changeSource`, `contentDiff`, attestation fields and `sensorScores`. There is **no per-item state, no ordering column, no self-parent, no supersession field, and no derivation edge**.

**The substrate that already exists and should be built on.** `ConsultationContextSchema` declares tenant-invented `kinds` over five platform primitives (`STREAM_AUDIO | TEXT | DOCUMENT | IMAGE | STRUCTURED`), and each declared kind carries `phiClass: PHI | NON_PHI`, `producedBy: CLIENT | AGENT | SYSTEM`, `lifecycle`, `cardinality`, plus a separate `outputs[]` list. `ContextItem.kindKey` + `contextSchemaVersionId` already link a row to its pinned declaration, and schema versioning is real governance (P-08). This is a better foundation than the reference imagines, and three target requirements fall out of it almost free: `producedBy` is the origin class A-17 wants; `phiClass` tells the redaction hop which items need sanitizing; tenant-declared kinds are where a typed contradiction item belongs.

**Changes.**

- **`ContextItem.lifecycleState`** — a new enum with **five durable states**, not the reference's seven: `ACTIVE`, `FLAGGED`, `INVALIDATED`, `SUPERSEDED`, `FINALIZED`. `Added`/`Updated`/`Unchanged` are *event verbs on the version trail*, not states an item can rest in; conflating them is a spec defect (red-team §11). The seven reference actions map cleanly: three become `ContextItemVersion.changeSource` values, four become states.
- **`supersededById String?` + `supersededAt`** — a self-FK. Supersession without provenance loss, which today is only emulated by version history and has no queryable edge.
- **`ContextItemDerivation`** — the missing table: `(id, tenantId, sourceContextItemId, derivedContextItemId, relation, producedByAgentId, producedAt)`. One table, two jobs: it is the invalidation cascade's graph *and* the provenance graph's missing join (§7). Indexed both directions.
- **Invalidation cascade** — on a clinician edit to a high-risk fact, walk `ContextItemDerivation` forward, set reached items to `INVALIDATED`, emit `context.invalidated`, and mark the affected note sections for regeneration. Depth-bounded; reuse the loop's existing `max_depth: 3` semantics rather than inventing a second bound.
- **Partial-transcript addressability (A-34)** — `TranscriptSegment` has `@@unique([contextItemId, idx])` but identity is effectively array position and partials are never persisted. Give segments a stable id and persist superseded partials as `SUPERSEDED` rather than dropping them.

**Invasiveness:** L. One enum, three columns, one new table + repository trio, one cascade service.

### 3. Section-level HITL

**What exists.** Nothing, at any layer. `approveSummary` gates on `contextItem.isFinalSummary` — one whole document. `LiveSummarySectionDto` is `{title, content}`, produced by `parseSoapSections` at display time and never persisted; `HarnessGateDecisionRequest` records one aggregate verdict. And the round-trip is **lossy**: `buildRunningSummary` joins non-empty section bodies and drops the headings, so a persisted note cannot be re-sectioned by re-parsing it.

**What already exists and is not enforced — the cheap part of the keystone.** `DepartmentAgent.writeScope.outputs[]` names, per agent, which output keys it may write. It is grammar-validated on write (`writeScopeProblems`), cross-checked against the department's published context-schema `outputs` (`departmentAgent.service.ts:770-787`), mapped to DTOs, and template-resynced. **It is enforced at exactly one runtime write site in the entire platform** — inside the loop's specialist path (`activities.py:2560`), behind the platform floor `PRIMARY_ONLY_OUTPUT_KINDS = {note, gate}`. Everywhere else it is configuration with no enforcement point.

So the section model is not greenfield. It is *persisting and enforcing a contract that already exists in configuration.*

**Changes.**

- **`NoteSection`** — a new table, modeled on `TranscriptSegment` (the repo's own precedent for a child-of-`ContextItem` ordered row): `(id, tenantId, contextItemId, outputKey, idx, encryptedContent, keyVersion, _version, hitlState, authorClass, lastHumanEditAt, lastHumanEditBy, approvedBy, approvedAt, charStart, charEnd)`, with `@@unique([contextItemId, idx])` and `@@unique([contextItemId, outputKey])`. Unlike `TranscriptSegment` it **does** carry `_version` — it is OCC-written.
- `outputKey` is drawn from the tenant's context-schema `outputs[].key`, so agent `writeScope` validates against the same vocabulary the sections are keyed by. No second naming scheme.
- **`hitlState`**: `PENDING | APPROVED | EDITED | REJECTED | RETURNED_FOR_REGEN`. Each transition appends its own `HarnessAuditEvent` row — new actions `SECTION_APPROVED / SECTION_EDITED / SECTION_REJECTED / SECTION_RETURNED`. The ledger is already WORM at the DB layer; do not build a second one.
- **`approveSummary` precondition:** every section whose schema `output` is `required` must be `APPROVED`. Sign attempt with a `PENDING` required section → 409. This is the reference's "FINALIZED unreachable until all approved" and it is a precondition, not a new write path — **`SIGNED`'s single write site is untouched.**
- **Signed-note assembly:** at approve time, concatenate sections in `idx` order into one text, write it as the `SIGNED_NOTE` `ContextItemVersion`, and compute `attestationHash` over the assembled text. The attested artifact stays one immutable blob (P-05 preserved).
- **Per-section regeneration:** `returnForRegen(sectionId)` regenerates one `outputKey` and re-runs sensors incrementally, leaving independent sections untouched.
- **Enforce `writeScope` at the write site**, not only in the loop: an agent writing a section outside its declared outputs is refused with an audited denial, and `PRIMARY_ONLY_OUTPUT_KINDS` becomes a platform floor for the doc workflow too.
- **Backfill posture:** because parse→flatten is lossy, pre-cutover notes cannot be reliably re-sectioned. They get a single degenerate section (`outputKey: 'body'`, `idx: 0`) so the approve path is uniform. Say this out loud rather than promising a backfill that cannot be correct.

**Invasiveness:** L. This is the keystone — roughly twenty invariants across `hitl-authority`, `commit-idempotency`, `labeling-transparency` and `audit` cannot be built until sections are addressable.

### 4. Clinician-authorship protection

**What exists.** Nothing structural, and the team has already built the right guard in the wrong scope. `_ever_edited` (`workflows.py:312,353,1332,1348`) makes an edited note escalate a REGEN verdict to a FLAG rather than swapping the clinician's words — its own comment is *"Once edited, a REGEN-fixable issue must SURFACE as a FLAG (never swap the clinician's note)."* But it is a workflow-instance attribute: it does not cross an activity boundary, it resets on a second execution, it never guarded `persistDraft`, and the edit signal is only sent while status is `DRAFT_PENDING_SENSORS`, so an edit during normal `PENDING_REVIEW` never sets it. Meanwhile `MODIFIED_SUMMARY` context items are **written by no code path**, while two comments assert they are and a read-authority ladder depends on them — which is precisely why an edited row stays adoptable by the AI writer.

**Three layers, defense in depth. Convention is not one of them.**

1. **OCC — the shared primitive.** `@RequiresIfMatch()` + `@ExpectedVersion()` + `updateWithVersion()` on the three note-content routes (`PATCH :id/summary/:summaryId`, `PATCH :id/context/:contextId`, `POST :id/summary/:contextItemId/approve`), copying the webhook exemplar verbatim. AI writers capture `_version` at delivery and treat `OptimisticConcurrencyException` as *"a human edited this — do not overwrite, raise a FLAG."* This closes A-08 and removes A-07's mechanism in the same change. Two wiring details: the consultation controller declares routes through the custom `@ApiEndpoint()` decorator rather than `@Patch`, so guard interaction must be verified; and `ContextItemResponse` exposes `currentVersionNumber` but **not** `_version`, so there is no ETag source for a client to send `If-Match` — the response DTO needs the row version.
2. **Authorship state.** `NoteSection.authorClass ∈ {AI, CLINICIAN, MIXED}` plus `lastHumanEditAt/By`, **derived from the write path, never stamped by a caller**. An AI writer physically cannot write a section whose `authorClass = CLINICIAN`; enforcement lives in the service/repository, outside the agent's own code — the same placement the loop already chose for `PRIMARY_ONLY_OUTPUT_KINDS`.
3. **Propose, don't overwrite.** When an AI generation targets a clinician-authored section, it produces a *proposed patch* with a visible diff (which is what the stories' sharpened criterion demands) rather than a content write. `_ever_edited` generalizes from workflow memory into the persisted `authorClass` column and stops resetting between executions.

Also in scope: **fix or delete the dead `MODIFIED_SUMMARY` rung.** Either write it on clinician edit (which independently removes the row from `findOwnHarnessDraft`'s adoption predicate) or delete the ladder and its two lying comments. Leaving a permanently-dead middle rung in a read-authority ladder is its own defect.

Not in scope: guarding `persistDurableSnapshot`. The spec itself defines the work note as volatile, and no client surface passes the live snapshot's id today. Re-read the row instead of writing through the stale in-memory `session.snapshotEntity`, and revisit if a client ever edits it.

**Invasiveness:** M for OCC (the template exists and 30 controllers already use it), M for `authorClass`, S for the dead rung.

### 5. Consent / ABAC gate

**What exists.** Nothing. No `Consent` or ABAC model in any of the 41 `.prisma` files; `HarnessAuditAction.CONSENT_GIVEN` / `CONSENT_WITHDRAWN` have zero writers. And a constraint the design must respect: **there is no `Patient` model.** Patients are external ids (`Consultation.patientId String`), exactly as the reference says ("Patient records are referenced by external patientId").

**Where it belongs.** Not solely in the guard pipeline, because the gate must also cover non-HTTP callers — BullMQ workers, Temporal activities, tool calls. So:

- **One choke point:** `IConsultationConsentService.assertConsent(tenantId, externalPatientId, purpose, scope)` in `packages/applications`, callable from anywhere. `failMode: closed`, in the settings-registry's own vocabulary.
- **HTTP:** a `@RequiresPatientConsent(purpose)` decorator + `PatientConsentGuard` registered as `APP_GUARD` **after** `UnifiedAuthGuard` (it needs the authenticated principal and the resolved tenant) and before `RequiresIfMatchGuard`. Denial inside the caller's own tenant → 403 (a privilege boundary); a cross-tenant id → 404, preserving the existing posture.
- **Non-HTTP call sites — four, and they are the reference's four:** (i) prior-history retrieval, (ii) capture start (`recording/start` and the SDK's audio start), (iii) every MCP/tool call — which has a natural home, since `toolAllowlist` is already a tenant-tier harness knob, and (iv) RAG retrieval.
- **Data model:** `PatientConsent (id, tenantId, externalPatientId, purposes String[], scope Json, grantedAt, grantedBy, expiresAt, revokedAt, revokedBy, evidenceRef, _version)` keyed `@@unique([tenantId, externalPatientId])`, plus consent events appended to the existing WORM ledger using the two `HarnessAuditAction` members that already exist and have no writers.
- **ABAC, minimally.** The platform already has RBAC (`Policy`, `RolePolicy`, `@Authorize`). Do **not** build a general policy engine. ABAC here means exactly two attributes evaluated against the grant — *purpose-of-use* and *minimum-necessary scope*. Widening scope is a new audited retrieval, which is a service call, not an engine.
- **Boot-time enforcement:** mirror the existing deny-by-default route audit — the application refuses to start if a consultation route declares neither a consent requirement nor an explicit exemption. That pattern already exists here and is the reason `@Public()` cannot be forgotten.

**Invasiveness:** L, but bounded: two tables, one service, one guard, four call sites. It is the single largest new domain in the program, and A-10 (erasure) cannot begin until it lands — there is nothing to revoke.

### 6. PHI redaction

**What exists.** No working redactor anywhere in the codebase. `IPhiRedactor` is a well-designed fail-closed port with **no implementation and no DI provider**; because `GateEditMiningService` treats "unchanged text" as a redaction failure and drops the candidate, the `GateEditExemplar` corpus currently mines nothing. Guardrail's `pii_detection` returns a verdict, never a transform, and defaults `enabled = False`.

**What makes this cheap.** Guardrail's GLiNER provider already extracts PII entities with per-entity scores over `PII_LABELS` (`providers/gliner.py:176-181`) — and then throws them away, because `GuardrailResponse` has only `{safe, issues, confidence, …}` with no entities or spans field. The redactor is one endpoint, one response model, and a masking function away from an extractor that already runs.

**Changes.**

- Add `POST /api/v1/guardrail/redact` returning `{sanitized_text, entities:[{label, start, end, score}]}`.
- Implement `GuardrailPhiRedactor implements IPhiRedactor` and **register the DI provider** — which simultaneously un-breaks gate-edit mining.
- **Hops, and only these:**
  - **(a) STT finalized segment → NLP** (`ner.processor.ts:92-99`) — the default-path hole, reference T5.
  - **(b) Reconciled transcript → final note pass** — reference T17.
  - **(c) Approved notes → DNA corpus** (`buildCorpus`, which today renders each encounter twice as an `AI DRAFT:` → `DOCTOR APPROVED:` pair, up to 50 patients in one prompt) — A-06.
  - **(d) Cloud-LLM egress** — already exists; keep it.
- **Explicitly not a hop: the primary summarization prompt.** Redacting the transcript before summarization would destroy the note — the note must contain patient facts. This is the reference's sharpest over-reach: T5 as literally written ("PHI sanitizer runs on finalized speech before NLP/Reasoning may consume it") forbids NER from seeing the medication names it exists to extract. The correct rule is **pseudonymize direct identifiers — names, MRN, contact details, dates — while preserving clinical entities**, and apply full redaction only to *derived, retained, cross-patient* artifacts: style profiles, exemplar banks, episodic memory, third-party egress. See red-team §7.
- **Fail-closed everywhere:** absent or failing redactor ⇒ drop the derived artifact, exactly the pattern `GateEditMiningService` already implements.

**Invasiveness:** S–M. Highest safety-per-line in the program after OCC.

### 7. Provenance graph

**What exists.** Real data, no graph and no single reader. Claim-level citations are genuinely good — `provenance.py` builds per-claim `{section, status, evidence[contextItemId+offsets+quote], knowledgeChunkIds}` filtered to actually-retrieved chunks, so a fabricated citation cannot survive (P-07). But the pieces live in four tables joined only by shared ids (`SummaryMeta.encryptedCitationsMap`, `AgentTrajectoryStep`, `HarnessAuditEvent`, `ContextItemVersion`), and the typed client contract in `types/citations.ts` has **zero consumers** while admin-console reimplements highlight-building independently.

**Changes.** No graph database. Two additions:

- `ContextItemDerivation` from §2 supplies the edge nobody has today — the transcript-span → derived-item link. Same table, two consumers.
- One read API, `GET /consultations/:id/provenance`, assembling five sources into one DTO: transcript spans → retrieved snippets (with source date and version, which `KnowledgeDocument`/`KnowledgeChunk` currently lack and need) → tool calls (`AgentTrajectoryStep`) → evaluator scores (`SummaryMeta`) → HITL edits (`ContextItemVersion` + the new section decisions). A read model over existing tables.
- Retire admin-console's parallel highlight implementation in favour of `types/citations.ts`, so two implementations stop being free to drift.

**Invasiveness:** M.

---

## Spec red-team of `dataset.xml`

Consolidated from all four lanes plus this stage. The reference is a research synthesis; these are the places where building it literally would produce a worse product.

| # | Claim | Problem | Recommended edit |
|---|---|---|---|
| **1** | T5 / T17: *"PHI sanitizer runs on finalized speech before NLP/Reasoning may consume it"* | **Harmful if built literally.** Full redaction upstream of NLP removes the medication and diagnosis names the pipeline exists to extract. It also implies a control the codebase cannot provide — no working redactor exists. | Split the requirement: **pseudonymize direct identifiers** (names, MRN, contact, dates) before NLP, preserving clinical entities; apply **full redaction** only to derived, retained, cross-patient artifacts (style profiles, exemplar banks, episodic memory, external egress). State the property, not the hop. |
| **2** | `Degraded` as one of eleven session states | Self-contradictory. T10.1 enters it and T11 silently reverts to Streaming — modeled as a one-row transient while every other state is durable. Forces every consumer to treat a health condition as mutually exclusive with the phase it occurs in. | **Remove from the state enumeration.** Add a "health flags" section: `degraded`, `reduced_assurance`, `tool_unavailable`, ORed onto the active phase, filterable, cleared on sign. HOPE's boolean-flag model is the better one. |
| **3** | T14: *"Harness restores the checkpoint bit-for-bit"* | **Unimplementable, and wrong to want.** The session spans a browser SDK, an STT stream with a seq cursor, Redis buffers and Postgres rows. "Bit-for-bit" would also forbid legitimate change on resume — a re-resolved config, a rotated credential, an **expired or revoked consent**. It misdirects work that is already correct: the seq-cursor resume (P-12) satisfies the real requirement. | *"Resume restores all durably-checkpointed context without recomputation or re-transcription. Authorization, consent, and configuration are re-evaluated on resume; a revoked consent blocks resumption."* |
| **4** | Nine named agent roles as nine agents | Over-specified as an *implementation*, and a reader will build nine services. In this codebase "Summarization Agent" and "Note-taking Agent" are the same SMR call with different templates; "Compliance" is a guard plus a service; "Master/Harness loop" is an orchestrator, not an agent. | Distinguish **capabilities** (what must happen, ~5) from **agents** (independently scheduled, independently timeout-able units). HOPE's `DepartmentAgent` factoring — `role: PRIMARY|SPECIALIST` plus declared read/write scope — is better: an agent is defined by its scope, not its job title. Note that deployments may collapse capabilities into one agent. |
| **5** | Seven context-item "actions" as one vocabulary | Mixes events and states. `Added`/`Updated`/`Unchanged` are transition verbs; `Unchanged` in particular cannot be a durable state. `Flagged`/`Invalidated`/`Superseded`/`Finalized` are states. | Split: **four durable states** (+ `Active`) and **three version-trail verbs**. |
| **6** | T21 `Closed Approved` and T23 `Closed` as two top-level states | Over-specified. T23's own note says Closed Approved has already occurred, and its activity is housekeeping with no human gate. This over-specification is what makes two independent closed-trackers look defensible — the exact shape of A-13. | Merge into one state with a `housekeepingCompletedAt` timestamp. |
| **7** | `Primed` has no exit criterion | T2 loads history, T3 reviews it, but nothing says what makes `Primed → Streaming` legal. If clinician acknowledgement is *required*, the reference has specified a modal dialog between the doctor and the patient at the most latency-sensitive moment of the visit. | State it: `Primed` is entered automatically on history load; the **gate on capture is consent + ABAC**, not clinician review. Review is offered, not required. |
| **8** | UC-06: *"escalate to HITL merge"* | Operationally undefined for a deterministic workflow that cannot block indefinitely. The code had to answer this alone and chose auto-resolve-and-record (A-28), which the reference forbids elsewhere. | Define escalation as **non-blocking**: record the conflict, resolve nothing, surface it at the review gate — and make *finalization* blocking when tenant policy says the conflict is safety-critical. That is implementable; "escalate" is not. |
| **9** | T10/UC-03 presume a live terminology MCP server | Specifies a mechanism where the property is what matters. HOPE's deterministic ~40-term dictionary structurally cannot hallucinate — a lookup is an exact hit or `None` — which is arguably safer than a network tool that can time out mid-note. | State the property: *"no code is emitted without a verified match against a controlled source; unmapped terms are marked unmapped and surfaced."* Explicitly bless a curated table as a valid source, and require the coverage gap be visible. |
| **10** | T18 lists safety checks alongside generic content safety | Conflates clinical-fact validation (medication, allergy, laterality, dosage, negation, identity) with LLM harm screening (jailbreak, toxicity). HOPE implements the latter well and the former barely; scored as one, the former looks covered. | Separate them into two named check families with separate acceptance criteria. |
| **11** | Four artifacts (work note / candidate / approved / committed) | Doesn't map onto the shipped two-tier model; grading strictly against four rows produces false negatives against a design that may satisfy the same properties with fewer. | State the **invariants between artifacts** — volatile never signs; candidate is diffable against the last review; approved is immutable; committed carries provenance — rather than mandating four rows. |
| **12** | `REOPENED` in the stories, absent from the XML's eleven states; "Timed Out" called terminal | Two reference documents with different state inventories; and UC-12 immediately describes a non-terminal continuation from Timed Out. | Add `REOPENED` to the XML enumeration (HOPE's enum already has the member) and re-word Timed Out as *"terminal absent explicit reopening."* |
| **13** | §8 story-vs-XML conflicts (5 sharpenings, 3 divergences) | The stories are consistently **stricter** and more testable. INV-249 in particular — *"confidence is a calibrated system measure … not a clinical probability"* — is a genuine patient-safety rule that the XML's bare "confidence scores" permits violating. | Promote all five sharpenings into the XML notes and resolve all three divergences in the stories' favour. Nothing is lost; the XML becomes testable. |
| **14** | Register metrics: per-category tally sums to 445, stated total 449 | A four-row discrepancy carried into every coverage denominator. | Reconcile and restate. |
| **15** | ~15 aspirational invariants (specialist handoff, nurse action items, multidisciplinary blackboard, telehealth shared ledger, patient-facing surface) | These describe a materially larger product than a single-clinician ambient scribe. Carried in the register, they count as gaps forever and distort every coverage number. | Move to a labeled **"Out of scope for this program"** appendix. They are roadmap, not debt. |

---

## Remediation plan

Dependency-ordered. **Wave 0 is containment** — fast, separable, reduces live exposure, requires no architectural agreement and should not wait for one. Everything after is structural.

### Wave 0 — Containment (days)

| Epic | Goal | Closes | Needs first | Size | Verification |
|---|---|---|---|---|---|
| `dna-phi-containment` | Stop an unredacted PHI→style-profile→cross-patient path that is **on in a seeded production tenant**. Ship the three-part minimal fix: a `json_schema` `promptConfig` on the DNA template with no free-text field, a parser that hard-fails instead of storing raw model output, and move the opt-in gate **above** the `textSamples` branch. Consider disabling `dnaStyleEnabled` at the ArcaAI tenant scope until it lands. | A-06 (+ the opt-out bypass) | — | S | (1) A decrypt-and-scan over `DnaWritingStyleReport.styleText` for that tenant reports zero name/MRN/dose matches — **this also decides latent-gap vs. live incident**; (2) unit test: parser throws on non-conforming output; (3) e2e: `textSamples` for an opted-out doctor is refused. |
| `icd10-prompt-containment` | Remove free-write ICD-10 instructions from the 13 live seed templates **and** ship a data migration — deployed tenants' `PromptTemplate` rows do not re-seed, so a seed edit alone changes nothing in the cluster. | A-03 | — | S | (1) A seed-lint test fails on `/ICD-?10/i` in any template body; (2) the migration reports rows updated per tenant and is idempotent; (3) a drift check comparing cluster rows to seed. |
| `empty-note-marker` | Stop publishing `runningSummary: ''` with a fresh timestamp on first-flush SMR failure; add the already-computed `smrFailed`/`degraded` to `LiveSummaryEventDto` and render it. | A-11 | — | S | Unit test: SMR throws on first flush ⇒ either no publish, or a publish carrying `degraded: true`; UI test asserting the banner renders. |
| `generator-entry-point-seam` | One `NoteGenerationService` seam; every generation entry point routes through it; `harnessEnabled` read in exactly one place. Fix the `harnessGatewayService?.start(...)` silent-drop that logs success and produces zero notes. | Prerequisite for the whole generator program; closes the "harness tenant still gets legacy drafts" hole | — | S–M | (1) e2e on a harness-on tenant: `POST :id/summary/async` produces a draft **with** a `SummaryMeta` and `assuranceCompletedAt`; (2) unit test: a missing gateway dependency throws rather than logging success; (3) a grep-gate asserting `harnessEnabled` has one runtime reader. |
| `loop-status-discovery` | Determine whether `harness.loop.enabled` is actually `'true'` in each environment (code default `false`, seed `'true'`, cluster `RUN_SEED` gating unknown). If it is on anywhere, A-28's silent auto-adjudication is **live**, not gated off, and must be re-triaged. | Re-triages A-28, A-26, A-27 | — | S | A per-environment report of the `GlobalSetting` row value, plus a Temporal query for `ConsultationLoopWorkflow` executions in the last 30 days. |

### Wave 1 — Structural foundations (independent of the generator decision)

| Epic | Goal | Closes | Needs first | Size | Verification |
|---|---|---|---|---|---|
| `note-occ` | `@RequiresIfMatch` + `@ExpectedVersion` + `updateWithVersion` on the three note-content routes, copying the webhook exemplar. Expose `_version` on `ContextItemResponse` so a client has an ETag source. AI writers capture `_version` at delivery and treat drift as *"clinician edited — FLAG, do not overwrite."* | **A-08, A-07** | — | M | (1) e2e: PATCH without `If-Match` → 428, with a stale ETag → 412; (2) integration test: a second harness `persistDraft` after a clinician edit leaves `content` unchanged and emits a flag; (3) **verify the ETag on the wire in a deployed environment** — a CDN that rewrites strong `ETag: "5"` to `W/"5"` silently defeats the whole epic. |
| `phi-redactor` | Guardrail `redact` endpoint exposing the spans GLiNER already computes; `GuardrailPhiRedactor` + DI provider; the STT→NLP hop and the DNA-corpus hop. | **A-02**, structurally A-06; un-breaks gate-edit mining | — | M | (1) pytest on the endpoint asserting correct span offsets and masking; (2) contract test: a redactor returning input unchanged causes the candidate to be dropped; (3) integration test: `/classify/tokens` receives no name or MRN token while medication tokens survive. |
| `session-state-machine` | Four new `ConsultationStatus` members; `transitionTo()` with a legality matrix on `ConsultationEntity`; delete `metadata.status`; `degradedReasons` as flags; wire the existing notification service to `TIMED_OUT`. | **A-13, A-33, A-41, A-46, A-36** (partly) | — | M | (1) entity unit test enumerating the legality matrix — every illegal transition throws; (2) e2e: `POST :id/close` on a never-recorded consultation is rejected; (3) a gate asserting zero writers to `metadata.status`. |
| `consent-abac` | `PatientConsent` + WORM consent events; `assertConsent` choke point; `@RequiresPatientConsent` guard after `UnifiedAuthGuard`; wired at history retrieval, capture start, tool calls, retrieval. | **A-01**; unblocks A-10 | — | L | (1) e2e: capture start without an active consent → 403; (2) revocation mid-session ⇒ the next tool call is denied and audited; (3) cross-tenant id still → 404; (4) a **boot-time audit** refusing start if any consultation route declares neither a consent requirement nor an exemption. |
| `harness-eval-gate` | Wire a judge backend so `harness-eval-gate` produces a real PASS/FAIL instead of `allow_failure: true` failing closed on a connection error. | Migration prerequisite | — | M | The job runs non-`allow_failure` on a golden set and fails on a deliberately degraded note. |

### Wave 2 — Generator consolidation

| Epic | Goal | Closes | Needs first | Size | Verification |
|---|---|---|---|---|---|
| `legacy-safety-floor` | Bring the legacy branch of the seam to a floor: write `SummaryMeta` + `assuranceCompletedAt`, run the groundedness check that already runs on the live path, flip to `PENDING_REVIEW`, append the WORM generation event. **Scope capped in writing; deleted by `harness-sole-generator`.** | Bounds default-path exposure during the infra program; closes the assurance-guard vacuum | `generator-entry-point-seam` | M | (1) test: no code path creates a `RAW_SUMMARY` without a `SummaryMeta`; (2) test: a legacy draft with an ungrounded claim cannot be signed without an explicit override. |
| `harness-availability` | Make a Temporal dependency safe to mandate: bounded retry, an explicit clinician-visible failure state, and a decided degraded-mode posture (block vs. produce a visibly-unverified draft). No silent drops. | Prerequisite for retirement | `session-state-machine` | M | Chaos test: harness returns 503 ⇒ the consultation lands in a visible degraded state with a notification — never a missing note behind a success log. |
| `harness-sole-generator` | Flip the SYSTEM cascade default to `harnessEnabled: true`; retire `summary.processor.ts` + `ner.processor.ts` (~626 LOC) and the floor. Requires Temporal under GitOps and harness/harness-worker in the k3s base. | **Reaches** A-09, A-19, A-22's safeguards for every tenant | `legacy-safety-floor`, `harness-availability`, `note-occ`, `harness-eval-gate` | M–L (+ an infra program) | (1) integration test: a SYSTEM-default tenant's `TranscriptionCreated` produces a draft with sensor scores and `assuranceCompletedAt`; (2) a gate asserting the legacy processors have no callers. |

### Wave 3 — Sections and provenance (the keystone)

| Epic | Goal | Closes | Needs first | Size | Verification |
|---|---|---|---|---|---|
| `note-sections` | `NoteSection` table + per-section `hitlState` + per-section WORM decisions; `approveSummary` requires all required sections `APPROVED`; per-section return-for-regen; **enforce `writeScope` and `PRIMARY_ONLY_OUTPUT_KINDS` at the write site**, not just in the loop. | **A-12, A-31**, ~20 invariants | `note-occ`, `session-state-machine`, `harness-sole-generator` | L | (1) e2e: sign with one required section `PENDING` → 409; (2) each decision produces its own WORM row; (3) an agent writing outside `writeScope` is refused with an audited denial; (4) regen of one section leaves the others byte-identical. |
| `authorship-protection` | `authorClass` derived from the write path; AI writes to clinician-authored sections become proposed patches with a visible diff; generalize `_ever_edited` into the persisted column; fix or delete the dead `MODIFIED_SUMMARY` rung. | Makes A-07 structural rather than conventional | `note-sections` | M | Test: an AI write targeting a `CLINICIAN` section produces a patch proposal and changes no content; a grep-gate on the `MODIFIED_SUMMARY` ladder. |
| `context-lifecycle` | `lifecycleState` (5 states), `supersededById`, `ContextItemDerivation` edges, depth-bounded invalidation cascade, persisted superseded partials. | **A-34, A-35, A-36** | `note-sections` | L | Test: editing a medication invalidates exactly its derived interaction items, depth-bounded, leaving independent sections untouched. |
| `provenance-read-api` | One `GET :id/provenance` assembling the five sources; source date/version columns on `KnowledgeDocument`/`KnowledgeChunk`; retire admin-console's parallel highlight implementation in favour of `types/citations.ts`. | **A-44**, A-19 (partly), the QA story | `context-lifecycle` | M | A QA reviewer can, in one call, trace a signed claim to its transcript span, retrieved snippet, tool call, evaluator score, and edit history. |

### Wave 4 — Transparency, contradiction, retention

| Epic | Goal | Closes | Needs first | Size |
|---|---|---|---|---|
| `transparency-labels` | Confidence column on `TranscriptSegment` + `TranscriptSegmentInput` (unblocks A-38's floor, which is a no-op today because ASR confidence never reaches NLP); per-clause origin class from the schema's `producedBy`; provisional-vs-documented separation; uncertainty marking that is not colour-only. | **A-16, A-17, A-38**, most of `labeling-transparency` | `note-sections`, `running-app-audit-lane` | M–L |
| `contradiction-items` | Contradiction as a first-class tenant-declared context kind, emitted on inter-source disagreement (speech-vs-image, history-vs-current), never auto-resolved, blocking finalization under tenant policy. Replace `adjudicate()`'s silent confidence-ranking with recorded non-resolution. | **A-04, A-05, A-28** | `context-lifecycle` | L |
| `retention-erasure` | Per-artifact-class TTL surface (nothing expires today — both existing jobs default `enabled: false` and cover only two tables); consent-revocation erasure cascade into scratch, caches, style exemplars, episodic memory, Qdrant. | **A-10, A-15** | `consent-abac`, `context-lifecycle` | M–L |

### Cross-cutting — closing the coverage gap

`running-app-audit-lane` — **92 of 449 invariants (20.5%) are unaudited, 22 of them in `labeling-transparency`, for one reason: no lane ran the application.** Every "visibly marked", "visually distinct", "not by colour alone", "confidence not presented as a clinical probability" invariant is genuinely unverified, not merely unreported.

*What it takes:* `pnpm setup:dev` and `pnpm stack:dev`, a seeded tenant, then drive the four real surfaces — `apps/admin-console` `consultations`, `consultation-review`, `playground-consultation`, `playground-live-transcription` — using the `next-dev-loop` skill plus Playwright, with an axe scan per screen and both themes. Record a verdict per rendered-state invariant. Roughly one focused week.

*Sequencing:* run it **before** `transparency-labels`, so that epic works from an observed gap list rather than an inferred one. Also scope the ~15 aspirational invariants out of the register first (red-team §15), so the coverage denominator stops including a product nobody is building.

---

## What we are NOT doing, and why

- **Not adopting `ConsultationLoopWorkflow` as the orchestration layer.** It is well-built, but its value is multi-specialist ensembles — the lowest-priority use case — and adopting it *introduces* the silent auto-adjudication the reference forbids. Harvest its `writeScope` / `PRIMARY_ONLY_OUTPUT_KINDS` model; leave the workflow behind its kill-switch. **Caveat:** first find out whether it is already running (Wave 0).
- **Not building a general ABAC policy engine.** Two attributes — purpose and minimum-necessary scope — evaluated against a consent grant. RBAC already exists and works.
- **Not redacting PHI from the primary summarization prompt.** It would destroy the note. Redaction protects derived, retained, cross-patient artifacts; the primary clinical pipeline gets identifier pseudonymization at most.
- **Not building a graph database for provenance.** One edge table plus one read API over data that already exists.
- **Not building imaging/DICOM intake (A-18).** A genuine platform gap — zero `pydicom` anywhere — but a product-scope decision, not a safety fix, and the reference's imaging rows presume a modality the product does not have.
- **Not building the patient-facing surface (A-45), specialist handoff, nurse action items, the multidisciplinary blackboard, or the telehealth shared ledger.** A materially larger product. Move them out of the register.
- **Not "just flipping flags."** Eleven CRITICAL/HIGH findings survive every flag being on. The flags are containment.
- **Not touching `SIGNED`'s write site.** It has one writer, one caller, requires an authenticated human, and cannot be reached by any clock, worker, workflow or admin endpoint. Section approval becomes a *precondition* to it. The keystone holds; do not renovate it.
- **Not backfilling sections onto pre-cutover notes.** `parseSoapSections` → `buildRunningSummary` is lossy — headings are dropped — so re-sectioning stored text cannot be correct. Old notes get one degenerate section.

---

## Risks and unknowns

1. **Biggest: harness and Temporal operational reliability under a mandatory dependency is unmeasured.** If making it non-optional raises the missing-note rate above the harm rate of unverified notes, the end-state inverts entirely. *Evidence that would settle it:* harness 5xx rate and note-generation latency percentiles from a real environment, plus a Temporal query for consultations with more than one `harness-doc-{id}` execution. **This single measurement could invalidate the generator decision, and it is cheap to take.**
2. **Whether DNA style profiles contain verbatim PHI today.** Statically we have proven an uncontrolled path; we have not proven what is in the rows. Decrypt-and-scan for the ArcaAI tenant converts a control gap into a live incident, or clears it. Do this in Wave 0.
3. **Deployment reality is contradictory in the repo's own docs.** One architecture doc says harness and Temporal are not in the k3s base; another lists `hope-harness` and `hope-harness-worker` as live workloads with CPU/memory sizing and calls the in-cluster Temporal dead code in favour of an unmanaged VM. Wave 2 cannot be sized until an infrastructure owner reconciles this. *(Resolved 2026-08-17: both descriptions were accurate for different repos at the same time — `harness`/`harness-worker` manifests exist and are synced in `arca/hope-v2-deployment` even though this repo's own `deployment/k3s/**` tree was deleted 2026-07-24, and the in-cluster Temporal genuinely was dead code (harness talked to the VM, not it) until the Task 1 hosting decision. The owner has since decided: self-hosted Temporal in k3s, ratifying the in-cluster copy over the VM. The reconnection itself is a written, not-yet-applied patch in the deployment repo.)*
4. **Whether the loop is running.** Code default `false`, seed `'true'` in every environment, cluster seeding gated. This changes the triage of three findings.
5. **CDN weak-ETag rewriting would silently defeat `note-occ`** in deployed environments — a strong `ETag: "5"` rewritten to `W/"5"` breaks `If-Match`. Verify on the wire before calling that epic done; do not verify only locally.
6. **Prompt templates in deployed tenants do not re-seed and have drifted**, so `icd10-prompt-containment` needs a migration whose input rows may not match the seed at all.
7. **Consent applied retroactively has no grant for historical records.** Every consultation created before `consent-abac` lands would fail a fail-closed check. An explicit legacy-grant posture is required — and it is a compliance decision, not an engineering one.
8. **Enforcing `writeScope` at the write site may break tenants** whose agents carry scopes that were validated at configuration time but never exercised at runtime. Needs a dry-run mode that logs refusals before enforcing them.
9. **The plan is sized against 78.6% invariant coverage.** The 92 unaudited invariants may contain further CRITICALs, most likely in `labeling-transparency` — which is exactly where a clinician's ability to tell a guess from a fact lives.
