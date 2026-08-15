# Consultation Session Workflow — Codebase Assessment

| | |
|---|---|
| **Status** | Review |
| **Date** | 2026-08-15 |
| **Scope** | Consultation vertical, full stack — harness (Temporal), live-documentation, domains/applications, gateway, Vox SDK, admin console, and the Python services on the path (stt, nlp, smr, guardrail) |
| **Measured against** | [dataset.xml](../dataset.xml) + [user-stories-and-use-cases.md](../user-stories-and-use-cases.md) |
| **Method** | 9 agents, 2 waves, with adversarial verification of critical findings |

> **Framing.** The reference documents are new to this sprint and untracked. Everything below is a
> **gap against a newly-adopted standard, not a regression against a shipped promise.** The code was
> never built to these invariants. That distinction should survive into how this work is planned and
> communicated.

> **Scope limit.** This is an *engineering* assessment of whether controls exist and function in code.
> It is not legal, regulatory, or clinical guidance, and it is not a compliance certification. Where a
> gap has regulatory implications, the engineering fact is stated; a qualified assessor must judge the
> consequence.

---

## 1. Headline

**The keystone safety property holds.** `ConsultationStatus.SIGNED` has exactly one write site, inside
`approveSummary`, gated on an authenticated `requestUserId`, with exactly one caller — an HTTP route.
No clock, cron, worker, workflow, service token, or admin endpoint reaches it. Two lanes plus an
independent compliance audit each tried to break this and could not. **Timeout genuinely never signs.**

**Three things undercut it.**

1. A note can be made to *look* signed without being signed (§3.1). Storage is honest; presentation is not.
2. The clinician "writing-DNA" feature sends unredacted approved clinical notes to an LLM and injects the
   result into other patients' prompts (§3.2). **Confirmed, and enabled in the seeded production tenant.**
3. **No working PHI redactor exists in the codebase.** `IPhiRedactor` has no implementation anywhere.

**Flags are not the fix.** Eleven CRITICAL/HIGH findings survive with every kill-switch enabled.

---

## 2. The three non-negotiables

| Non-negotiable | Verdict | Note |
|---|---|---|
| Timeout is never clinical approval | ✅ **UPHELD** | No counterexample across cron, workers, service tokens, admin endpoints, Temporal timers, or default parameters |
| The system never signs for the clinician | ✅ **UPHELD** at the record of truth | Attestation WORM write is awaited fail-closed *before* the status flip. **Caveat:** enforcement is application-layer only — no DB constraint binds `SIGNED` to an attestation, and the repo's own test proves a bare `UPDATE` succeeds |
| The draft is not the record until approved | 🔴 **BREACHED in presentation** | See §3.1 — stored record intact, displayed record forgeable |

---

## 3. Critical findings

### 3.1 A note can be displayed as SIGNED without being signed

`PATCH /consultations/:id` with `{"metadata": {"status": "SIGNED"}}` bypasses the
`@IsIn(['OPEN','CLOSED'])` guard — that validator constrains only the typed field, while `metadata` is an
unvalidated `@IsObject()` that is shallow-merged (`consultation.service.ts:757-758`). The DTO mapper then
**prefers `metadata.status` when the column reads `OPEN`** (`consultation.dto.mapper.ts:23-26`), so all 17
read paths return `SIGNED`.

No `SIGNED_NOTE`, no attestation, column untouched — so the stored record is intact and the act is
auditable. But nothing in the API or UI distinguishes it from a real signature, and it is reachable by the
assigned doctor **or any tenant admin holding `manage:Consultation`**. A tenant admin can make a note
appear clinician-signed without the clinician attesting; medico-legal review runs on what the system
displays.

### 3.2 Writing-DNA ingests unredacted PHI and applies it across patients — CONFIRMED

Independently verified; all five links hold. Using the documented feature, up to 50 approved clinical notes
are rendered twice each, concatenated to 100,000 characters, sent to an LLM under a prompt that asks for
"common phrases" and forbids nothing, and the unvalidated response is persisted and later appended verbatim
to the system prompt for **whatever patient is summarized next** — `getEffectiveStyleText(doctorId, tenantId)`
takes no patient parameter.

Four candidate defenses were tested and all failed: guardrail returns a verdict and never transforms text
(and defaults to `enabled = False`); the DNA template carries no `json_schema`, unlike its SOAP sibling; the
SMR call binds no `response_format`; the parser's `catch` stores raw model output verbatim.

`dnaStyleEnabled` code-defaults to `false` and fails closed — but **the seed sets it `true` at tenant scope
for ArcaAI and seeds every ArcaAI doctor with a DNA report.**

**Bounded:** same tenant, same treating clinician, encrypted at rest. This is cross-patient contamination
*of the record*, not third-party disclosure.

**Unresolved — the path is proven, the payload is not.** Whether verbatim PHI sits in stored profiles depends
on LLM behavior and cannot be settled statically. **One query decides it:** decrypt
`DnaWritingStyleReport.styleText` for the ArcaAI tenant and scan for patient names, MRNs, DOBs, and drug+dose
strings. Clean rows → latent control gap. Dirty rows → live incident. *Not yet run.*

### 3.3 PHI reaches NLP and SMR unsanitized

No sanitizer runs between a finalized transcript and downstream consumption; `ner.processor.ts` posts raw
`contextItem.content`. Third-party egress is currently prevented only because seeded providers are local —
and the cloud guard is an **allowlist that returns text untouched for providers not on it**. It lists
`azure` and `bedrock`; SMR registers `openai`, `anthropic`, and `vertex` unconditionally. **One tenant BYOK
config change — no code change, no deploy — sends unredacted PHI to a third party, while the redactor reports
itself enabled and fail-closed.**

### 3.4 Prompts instruct the model to invent diagnosis codes

14+ seeded `PromptTemplate` rows instruct the LLM to free-write ICD-10 codes into note prose. The MCP
terminology validator is opt-in, runs *after* persistence, gates nothing, and has no server registered outside
unit tests. A deterministic non-hallucinating linker does exist on the default path, but covers ~40 terms.
**Deployed rows do not re-seed and have drifted — this needs a data migration, not just a seed edit.**

### 3.5 AI overwrites clinician-authored text

`persistDraft`'s draft-adoption branch overwrites `ContextItem.content` unconditionally — plain non-versioned
`update`, no version or provenance check. Verified narrower than first reported: the work-note path
(`persistDurableSnapshot`) writes an artifact the spec itself defines as volatile, with no client editing it.
**One real defect, not two.**

Compounding it: note and section writes use `.update()` rather than `.updateWithVersion()` and carry no
`@RequiresIfMatch()`, while **six or more sibling modules in the same repo do it correctly.** There is no
ETag source today — `_version` is not exposed on `ContextItemResponse`.

### 3.6 Consent and ABAC do not exist

Confirmed by four independent lanes. No `Consent` model, no `Patient` model, two dead never-written enum
literals. The guard checks type names, so CASL conditions never evaluate, and `getAccessibleBy` has zero call
sites. The reference makes consent the **first clinical act**, gating history retrieval, capture start, and
every downstream tool call. Today none of that is gated, and there is consequently no revocation or erasure
cascade to build on.

---

## 4. What the platform gets right

Recorded deliberately — an assessment that lists only failures misrepresents the system and misdirects effort.

- **The signing gate** (§2) — the hardest property to get right, and it is right.
- **`HarnessAuditEvent` is a genuinely sound WORM ledger.** (`AuditLog`, by contrast, is mutable, unchained,
  and hard-deletable via a live cron.)
- **Attestation is fail-closed and ordered correctly** — the WORM write is awaited before the status flip.
- **`isFinal` gating is correct today** — churning partials do not drive downstream extraction.
- **Mute is implemented correctly** at the SDK/track level (`track.enabled = false`) — though no product
  screen exposes it.
- **Version-level AI-vs-human provenance is real and reconstructible**, even though per-clause labeling is absent.
- **The tenant-declarable `ConsultationContextSchema` primitive system is real**, not scaffolding.
- **`DepartmentAgent.writeScope.outputs[]` already models per-section write authority** — grammar-validated,
  schema-cross-checked, template-resynced. Section-level HITL is enforcing an existing contract, not greenfield.
- **Guardrail's GLiNER already extracts PII entities with scores** — the redactor is closer to free than it looks.

---

## 5. Architecture: which generator is the product?

**Recommendation — staged; end-state `HarnessDocWorkflow` as the sole signable generator. Do not adopt
`ConsultationLoopWorkflow`.**

Hardening legacy means reimplementing sensors, the gate, `SummaryMeta`, and WORM audit that **already exist
and are merely unreachable**. The harness is already on for both seeded real tenants; legacy is only the
*inherited* SYSTEM-cascade default.

**Strongest counter-argument, and it is serious:** the harness's operational substrate cannot be made mandatory
today. Temporal runs on an unmanaged VM with a dead in-cluster copy; `harness` and `harness-worker` are not in
the k3s base; staging and prod namespaces have never been created; and `harness-eval-gate` is
`allow_failure: true`, failing closed for want of a judge backend — **there is no working clinical-quality gate
in CI.** Making Temporal non-optional converts a harness outage from "two tenants degrade" to "no clinician gets
a note."

Hence three phases: consolidate entry points → a deliberately-capped legacy safety floor (deleted by the epic
that retires legacy) → migrate once infrastructure closes.

**Biggest unknown that could invalidate this:** harness/Temporal availability under a mandatory dependency is
unmeasured. If the missing-note rate exceeds the harm rate of unverified notes, the end state inverts to
permanent-legacy. Settled cheaply — harness 5xx rates, generation latency percentiles, and a Temporal query for
duplicate `harness-doc-{consultationId}` executions (which also reveals how often §3.5's overwrite actually fires).

---

## 6. Corrections to the reference documents

The reference is a research synthesis, not a validated spec. Three corrections matter most.

1. **T5's PHI sanitizer is harmful if built literally.** Full redaction upstream of NLP removes the medication
   and diagnosis names the pipeline exists to extract. Correct to **identifier pseudonymization before NLP**,
   with full redaction reserved for derived, retained, and cross-patient artifacts.
2. **`Degraded` is not a session state.** T10.1 enters it and T11 silently reverts. Demote to health flags ORed
   onto the active phase.
3. **"Restores the checkpoint bit-for-bit" (T14) is unimplementable and wrong to want** — it would forbid
   re-evaluating an expired or revoked consent on resume. The existing sequence-cursor resume already satisfies
   the real requirement.

Also: the 9 named agent roles over-specify implementation, and the §8 story-vs-XML sharpenings should be promoted
into the XML — especially `INV-249`, *"confidence is not a clinical probability."*

---

## 7. Remediation

**Wave 0 — containment.** Fast, exposure-reducing, separable from the architecture program.

| Epic | Closes |
|---|---|
| `dna-phi-containment` | §3.2 — `json_schema` on the DNA template, parser hard-fail, move the opt-in gate above the `textSamples` branch; **plus the decrypt-and-scan that decides latent-gap vs. live incident** |
| `signed-status-forgery` | §3.1 — validate `metadata`, remove the mapper's `metadata.status` preference |
| `icd10-prompt-containment` | §3.4 — 13 seed templates **plus a data migration** for drifted deployed rows |
| `empty-note-marker` | Stop publishing `runningSummary: ''`; surface the already-computed `smrFailed` |
| `generator-entry-point-seam` | One `NoteGenerationService`, one reader of `harnessEnabled` |
| `loop-status-discovery` | Determine whether `harness.loop.enabled` is actually on in each environment |

**Wave 1 — generator-independent structure.** `note-occ` (webhook exemplar verbatim on 3 routes; expose
`_version` — closes §3.5 in both mechanisms) · `phi-redactor` (guardrail redact endpoint + DI provider; also
un-breaks gate-edit mining, which currently mines nothing) · `session-state-machine` (4 new enum members, a
`transitionTo()` legality matrix, delete `metadata.status`, `Degraded` → flags) · `consent-abac` (no `Patient`
model exists — key on `(tenantId, externalPatientId)`; guard after `UnifiedAuthGuard` plus a non-HTTP
`assertConsent` choke point for workers, activities, and tools) · `harness-eval-gate`.

Full detail, sizes, and verification criteria: [04-target-architecture.md](./04-target-architecture.md).

---

## 8. Coverage and limits

**353 of 449 invariants audited (78.6%). 92 unaudited, all IDs listed** in
[02-conformance-matrix.md](./02-conformance-matrix.md) §5.1.

The largest unaudited cluster is `labeling-transparency` — 22 of 57 — and the gap is not random: it is the
"what the clinician actually sees" category, unaudited because **no agent ran the application.** Closing it
requires a runtime pass against a running admin console, not more static reading.

Other limits worth carrying forward:

- §3.2's payload question is unresolved and needs a database query to settle.
- Findings marked SINGLE-SOURCE in the matrix have not been independently corroborated.
- Three stages corrected the stage before them — lane-level claims about default configuration proved
  unreliable twice. Treat any remaining "defaults to X" claim as needing verification against seed data,
  not just code defaults.

---

## 9. Index

| Document | Contents |
|---|---|
| [01-invariant-register.md](./01-invariant-register.md) | 449 invariants; §8 story-vs-XML conflicts; persona coverage |
| [02-conformance-matrix.md](./02-conformance-matrix.md) | 46 adjudicated findings + 21 verified positives; coverage table |
| [03-compliance-posture.md](./03-compliance-posture.md) | Non-negotiables, control inventory, PHI flow map |
| [04-target-architecture.md](./04-target-architecture.md) | Generator decision, target design, spec red-team, sequenced plan |
| [05-critical-verification.md](./05-critical-verification.md) | Adversarial verification of §3.2 and §3.5 |
| [evidence/](./evidence/) | The four wave-1 lane reports |
