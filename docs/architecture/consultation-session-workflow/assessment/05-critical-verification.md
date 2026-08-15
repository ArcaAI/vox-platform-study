# Adversarial verification of two CRITICAL findings

Independent re-derivation against the live tree at `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2`, branch `feat/loop`. All citations below were gathered independently; none are copied from the original agent. Excluded from every search: `.claude/worktrees/**`, `**/dist/**`, `**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`, `**/.next/**`.

**A framing fact that governs both findings.** The requirements both findings are measured against live in `docs/architecture/consultation-session-workflow/` — and that directory is **untracked** (`git status --porcelain` → `?? docs/architecture/consultation-session-workflow/`). It is a *new-sprint design specification*, not a description of shipped guarantees. That changes what these findings are: they are **spec-versus-current-state gaps**, not regressions against behavior the system ever promised. It does not make the underlying hazards unreal — one of them is live in a seeded production tenant today — but "VIOLATED" overstates the relationship. The correct verb is "not yet satisfied by".

---

# FINDING 1 — Writing-DNA style profile ingests unredacted PHI which is then injected into other patients' prompts

## Verdict

**CONFIRMED** — every link in the chain holds on its own evidence, and the important form of the finding is the *normal-operation* path, not the `textSamples` misuse path: there is no redaction, sanitization, schema constraint, or output validation anywhere between approved clinical notes and a persisted style profile that is later injected verbatim into a different patient's summary prompt. One qualifier that the verdict label cannot carry: the *existence of the uncontrolled path* is proven statically; the *quantity of PHI actually sitting in style profiles today* is not (see True scope).

## Link-by-link

**Link 1 — DTO accepts unconstrained `textSamples`. HOLDS (one detail corrected).**
`packages/applications/src/services/dna-writing-style/dto/generate-dna-report.request.ts:4-9`:

```ts
export class GenerateDnaReportRequest {
  @ApiPropertyOptional({ description: 'Text samples for analysis (if not provided, gathered from ContextItems)', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  textSamples?: string[];
```

No `@MaxLength`, no `@ArrayMaxSize`, no content validation, no provenance field. Correction to the original: there *is* an effective size bound downstream — the processor truncates the joined corpus at `maxContextChars` (default `100_000`, `dna-writing-style.processor.ts:31-34` and `:177-179`). So "no length cap" is wrong as stated; the array itself is unbounded but what reaches the LLM is capped.

Reachability: `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts:96-100` — class-level bare `@Authorize()` (`:50`), and the only extra gate is `assertActingAsDoctor()` (`:77-88`), which blocks *admins who are neither clinicians nor impersonating*. A normal authenticated clinician passes it. The admin variant `generateForDoctor` at `dna-writing-style-admin.controller.ts:167-169` is gated by `@Authorize(['manage', 'DnaWritingStyleReport'])` (`:36`).

**Link 2 — `textSamples` bypasses the approved-only filter. HOLDS, and is stronger than claimed.**
`dna-writing-style.processor.ts:105-124`:

```ts
if (textSamples && textSamples.length > 0) {
  samples = textSamples.join('\n\n---\n\n');
  ...
} else {
  if (this.configResolver) {
    const { effective } = await this.configResolver.resolveEffectiveDnaStyleEnabled({ tenantId, doctorId });
    if (!effective) { ... throw new Error('DNA writing style is disabled for this doctor (opt-out or tenant flag off)'); }
  }
```

The `else` branch holds *both* controls: the approved-only corpus filter (`:146-171`) **and** the tenant-AND-doctor DNA enablement gate (`:118-124`). Supplying `textSamples` skips both. The code says so deliberately at `:116-117`: *"Only the automatic path is gated; an explicit textSamples request (admin/migration) bypasses this."*

That second bypass is a **consent** defect the original finding did not identify: a tenant admin holding `manage:DnaWritingStyleReport` can `POST admin/dna-writing-styles/generate/:doctorId` with `textSamples` and build a style profile for a clinician who has **explicitly opted out** via `PUT /dna-writing-styles/settings`. The only remaining guard on that route is tenant membership (`dna-writing-style.service.ts:118`, `assertUserBelongsToTenant`).

**Link 3 — the DNA_ANALYSIS prompt contains no PHI-exclusion instruction. HOLDS, and the output is unconstrained.**
`packages/database/src/prisma/db_main/seed/07-prompt-template.ts:385-399`. Full content:

> "Analyze the physician's writing style from the provided consultation transcripts and summaries.\n\nExtract patterns for:\n1. Sentence structure preferences … 4. Common phrases and transition words … 6. Tone and formality level\n\nOutput a structured DNA profile that can be used to generate future summaries matching this physician's style. Include confidence scores for each extracted pattern."

No instruction to exclude patient facts, medications, or identifiers. Item 4 ("Common phrases") actively invites verbatim quotation from source notes.

Critically — and this defeats the "it's a constrained structured profile" counter-argument — this template carries **no** `metaData.promptConfig`, unlike its sibling SOAP template two entries above which sets `metaData: { promptConfig: SOAP_PROMPT_CONFIG }` to "Activate structured SOAP output (json_schema)" (`:377-378`). The DNA call therefore requests **free text**. Confirm at the call site: `dna-writing-style.processor.ts:332-341` posts `{prompt, system_prompt, stream:false, provider, model}` to `SMR /api/v1/generate` with **no `response_format`** — compare the summary path, which does bind one (`smr-compat.controller.ts:400-406`, `response_format: {type:'json_schema', json_schema: responseSchema, strict:true}`).

**Link 4 — persisted with no redaction. HOLDS.** The parser, `dna-writing-style.processor.ts:197-203`:

```ts
try {
  const parsed = JSON.parse(smrResponse.content);
  reportData = parsed.reportData ?? parsed;
  styleText = parsed.styleText ?? smrResponse.content;
} catch {
  styleText = smrResponse.content;
}
```

No schema validation on either branch; both fall back to storing the raw LLM output verbatim. `encryptFieldsIntoEntity` (`:231-233`) is **encryption, not redaction** — it changes who can read the field, not what the field contains.

**Link 5 — doctor-scoped profile injected into an unrelated patient's prompt. HOLDS. This is the load-bearing link and it is solid.**
`dna-writing-style.service.ts:202-230` — the signature is `getEffectiveStyleText(doctorId, explicitTenantId?)`. There is **no patient or consultation parameter anywhere in it**; it resolves the latest report for the doctor and decrypts `styleText`. Consumed at `apps/api/src/modules/smr-compat/smr-compat.controller.ts:284-302` (`resolveDnaStyleText`), threaded through `:463-464`, `:527-528`, `:621-622`, `:671-672`, and embedded verbatim into the **system prompt** at `apps/api/src/modules/smr-compat/v1-summary-prompt.builder.ts:379-384`:

```ts
const dnaStyle = options.dnaStyleText?.trim();
if (dnaStyle) {
  systemLines.push(
    `Match this clinician's documentation writing style (tone, formatting, and section phrasing) without changing any clinical facts:\n${dnaStyle}`,
  );
}
```

Identical embedding in the generic builder at `summary-prompt.builder.ts:231-236`. The profile is per-doctor and is applied to *every* subsequent summary and pre-summary that doctor generates, for any patient. The finding's structural claim is correct.

## Strongest counter-argument

Four counter-arguments are available. I built each as strongly as the code allows; three fail, one partly survives.

1. **"Guardrail sanitizes the prompt."** This is the best-looking defense and it fails on three independent grounds. SMR's `/generate` genuinely does call guardrail (`apps/text/src/text/api/endpoints/generate.py:282-299`), so the DNA corpus *does* traverse it. But (a) `ExternalGuardrailClient.validate` posts to `/api/medical/validate` and returns `{allowed, is_medical, confidence, reason}` — a **verdict, not a transform**; the prompt text is passed to the LLM unmodified (`apps/text/src/text/services/external_guardrail.py:41-95`). (b) Its question is *"is this medical content"* (`require_medical`), which is topicality, not PHI detection — a PHI-dense note is exactly what it *approves*. (c) It defaults **off**: `enabled: bool = False` at `apps/text/src/text/core/config.py:329`, and when off it returns `{"allowed": True, ..., "reason": "external_guardrail_disabled"}` without any call at all.

2. **"A PHI redactor exists in this codebase, so this path probably uses it."** It does not, and the truth is worse than the original stated. `IPhiRedactor` is declared at `packages/applications/src/services/gate-edit-mining/IPhiRedactor.ts:12-20` but **has no implementation and no DI provider anywhere in the repo** — the only hits are the interface, its barrel export, and its consumer. The module comment is explicit (`gate-edit-mining.service.module.ts:10-13`): *"Note what is NOT provided here: `IPhiRedactor` … a wiring that forgets to wire it collects an empty store rather than an unredacted one."* Because `GateEditMiningService` is fail-closed (`gate-edit-mining.service.ts:408-414`, `redactOrNull` returns `null` with no redactor, and `:176-178` drops the candidate), the `GateEditExemplar` corpus the original agent held up as the good sibling pattern currently mines **nothing**. This cuts both ways: it weakens the rhetorical comparison, and it establishes the stronger systemic fact that **no working PHI redactor exists anywhere in this codebase**.

3. **"The stored artifact is a constrained profile, so the leak surface is narrow."** Refuted above — no `json_schema`, no `response_format`, no schema validation, and a `catch` that stores raw model output.

4. **"Prompt-level constraint limits contamination." — this one partly survives and the original agent missed it.** Both builders wrap the injected style in *"without changing any clinical facts"*, and the generic builder adds *"Base the summary strictly on the provided transcript and context; do not fabricate findings"* (`summary-prompt.builder.ts:238-241`). This is a real, deliberate control that meaningfully reduces the probability that patient A's facts get *written into patient B's note*. It is a soft instruction with no enforcement, and it does nothing about the disclosure of patient A's content *into the prompt context* — but it is not nothing, and a fair report must credit it.

Two further mitigations the original also missed and should have credited: the plaintext columns are **dropped**, with `styleText`/`reportData` persisted as Vault-Transit ciphertext only (`packages/database/src/prisma/db_main/dna-writing-style.prisma:19-23`, `:70-75`), and `encryptPhiFields` **fails closed in staging/prod** — `SECRETS_PROVIDER=vault` makes a missing secrets service or a failed encryption *abort the write* rather than persist plaintext (`packages/applications/src/common/phi-field-encryption.ts:32-34`, `:44-46`). The processor's own comment at `:229-230` claiming "dual-write; plaintext retained for the soak" is **stale** and contradicted by the schema. So this is not a plaintext-at-rest exposure.

## True scope and severity

Report on the two paths separately, as instructed.

**(a) Misuse path (`textSamples` supplied) — real but low practical severity, with one genuinely notable sub-case.** A clinician submitting their own `textSamples` is pasting text they already lawfully hold; the marginal exposure is small and self-inflicted. The sub-case that matters is not PHI but **consent**: because the gate lives only in the `else` branch, a tenant admin can generate a DNA profile for a clinician who explicitly opted out. That is a defensible finding on its own and does not depend on any PHI reaching the profile.

**(b) Normal-operation path (no `textSamples`) — this is the finding, and it requires no misuse whatsoever.** A clinician invokes the documented feature. The processor harvests up to 50 of that doctor's most recent `RAW_SUMMARY`/`MODIFIED_SUMMARY` context items (`:126-131`), keeps only those with an `approved` version (`:159-166`), and — a detail the original agent missed that *increases* PHI density — renders each as an explicit `AI DRAFT:` → `DOCTOR APPROVED:` pair (`buildCorpus`, `:305-313`), i.e. **two** full PHI-bearing renderings of each encounter. Up to 100,000 characters of approved clinical notes from up to 50 distinct patients are concatenated into a **single** LLM prompt with no redaction, no schema, and no output validation. Approved clinical notes contain PHI by definition.

**Is the feature actually on?** Yes, in the tenant that matters. `dnaStyleEnabled` has `codeDefault: false` and fails closed (`packages/applications/src/services/config-resolver/config-resolver.service.ts:82`, `:157-178`), which alone would suggest low reachability — but the seed sets it **true at tenant scope for the ArcaAI production day-1 tenant**, `packages/database/src/prisma/db_main/seed/14-pipeline-policy.ts:75-80`, with the comment: *"`dnaStyleEnabled: true` turns on the per-doctor DNA writing-style gate at the tenant scope; every ArcaAI doctor is seeded with a DNA report."* Since `effective = tenantEnabled && (doctorToggle ?? true)` (`config-resolver.service.ts:197`), every ArcaAI doctor with an unset toggle is enabled. Scheduled auto-regeneration is separately off by default (`dna-regeneration.scheduler.ts:13-17`, `enabled: false`, monthly cron), so generation is clinician- or admin-triggered rather than continuous.

**Who is affected, and how bad.** Blast radius is bounded by tenant and by treating clinician: `assertUserBelongsToTenant` is applied on generate, read, and `getEffectiveStyleText` (`dna-writing-style.service.ts:118`, `:159`, `:216`), so this is **not** a cross-tenant leak, and the same clinician has a treatment relationship with both patients. The material harm is therefore not "a stranger reads patient A's chart" — it is **cross-patient contamination of the medical record**: patient A's identifiable clinical content entering the generation context for patient B, with a non-zero chance of landing in patient B's note, which is then read by other clinicians and disclosable to patient B on a records request. That is a HIPAA-relevant integrity-and-disclosure problem, and it is also a **patient-safety** problem — a drug or dose migrating between charts is the failure mode the new spec calls out by name (`dataset.xml:154`: *"must never store the patient-specific drug as a style feature"*).

**What is proven versus what is not.** Statically proven: an uncontrolled PHI→profile→cross-patient path with zero redaction at any hop. **Not** statically provable: whether the stored profiles *actually* contain verbatim PHI today, because that depends on LLM behavior under a prompt that asks for abstract patterns but forbids nothing. Runtime evidence that would settle it, and that I recommend gathering before escalating: decrypt `DnaWritingStyleReport.styleText` for the ArcaAI tenant and grep for patient names, MRNs, dates of birth, and drug+dose strings. If those rows are clean, this is a latent control gap; if they are not, it is a live incident.

## Minimal fix

Smallest change that closes it, in priority order:

1. **Constrain the output rather than trusting the model.** Add a `promptConfig` with a `json_schema` to the DNA_ANALYSIS seed template (mirroring `SOAP_PROMPT_CONFIG`) whose fields are enumerated style descriptors — verbosity, hedging, list-vs-narrative, section order, tone, confidence scores — with **no free-text field**, and bind `response_format` on the SMR call at `dna-writing-style.processor.ts:332-341`. Then make the parser reject rather than fall back: replace the `catch { styleText = smrResponse.content; }` at `:201-203` with a hard failure. This is the single highest-value change — it converts the artifact from "whatever the LLM wrote" into a fixed shape that structurally cannot carry a clinical narrative.
2. Append one sentence to the DNA_ANALYSIS prompt forbidding reproduction of patient names, identifiers, dates, medications, doses, and any encounter-specific fact. Cheap, immediate, partial.
3. Move the `resolveEffectiveDnaStyleEnabled` gate at `:118-124` **above** the `if (textSamples …)` branch so the opt-out cannot be bypassed. Two-line change, closes the consent defect outright.

---

# FINDING 2 — Two AI write paths silently overwrite clinician-authored text

## Verdict

**CONFIRMED-NARROWER** — the mechanism is exactly as described for both paths (unconditional `content` overwrite via non-versioned `update`, no edit check of any kind), but the two paths do not carry equal weight: `persistDraft` is a genuine, reachable clinician-edit-loss defect on the authoritative note row, while `persistDurableSnapshot` targets a row the architecture itself classifies as volatile work-note state, and I found no client surface that edits it. Treating them as one CRITICAL overstates the second.

## Link-by-link

**Claim: `persistDraft`'s draft-adoption branch overwrites unconditionally. HOLDS.**
`packages/applications/src/services/consultation/harness/harness-internal.service.ts:759-774`. The adoption branch assigns `existingDraft.content = strippedContent` (`:762`), sets `existingDraft.updatedBy = userId` where `userId = dto.userId ?? 'system'` — the AI worker (`:730`, `:764`) — and calls the **non-versioned** `contextItemRepository.update(existingDraft.id, existingDraft)` (`:768`). Within lines 719-977 there is no read or comparison of `_version`, `currentVersionNumber`, `updatedAt`, `updatedBy`, `changeReason`, or `changeSource` before the write. The only gate is the ownership marker `metaData.subType === 'HARNESS_DRAFT'` in `findOwnHarnessDraft` (`:1316-1321`), which answers "did *we* author this row?" and not "has a human touched it since?".

The distinction is not incidental: `packages/domains/src/common/repository.ts:167-181` documents `update` as *"the NON-versioned write. It takes no `_version` predicate and bumps no counter — for optimistic concurrency use `updateWithVersion`."* `updateWithVersion` exists (`:208-243`) and `ContextItem` does carry `version Int @default(1) @map("_version")` (`packages/database/src/prisma/db_main/consultation.prisma:76`). The same method uses OCC correctly one screen below — `summaryMetaRepository.updateWithVersion(...)` at `:876` — for `SummaryMeta`, i.e. for the *metadata* but not for the clinical note.

**Claim: `persistDurableSnapshot` overwrites on a ~30s periodic flush. HOLDS, mechanically.**
`packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts:1802-1873`. It is a throttle, not a timer: `:1804` returns early unless `opts.force` or `Date.now() - session.lastDurableAt >= durableSnapshotMs`, with `durableSnapshotMs = Number(configService.get('LIVE_DOC_DURABLE_SNAPSHOT_MS') ?? 30000)` (`:453`). I checked independently — `LIVE_DOC_DURABLE_SNAPSHOT_MS` appears in **no** env file, `.sample`, or `turbo.json` in the repo, so the 30 s default is what runs, on every live session, called after every flush (`:1254`) and once more on stop (`:807-811`). Both write branches use plain `update` (`:1837`, `:1864`) with no version or provenance check; the only field resembling provenance, `updatedAt` at `:1819`, is written into a JSON blob and never read back.

One aggravator the original did not identify: the steady-state branch at `:1861-1864` writes through `session.snapshotEntity`, a **long-lived in-memory entity** the session never re-reads. Any external write to that row is therefore clobbered from stale memory at the next flush — this is unconditional overwrite in its strongest form.

**Claim: a real guard (`_ever_edited`) exists but does not survive the re-entrant paths. HOLDS, with a correction that makes it worse.**
`apps/harness/src/harness/temporal/workflows.py:312` declares `self._ever_edited: bool = False`; the sole write is the `edit` signal handler at `:353`; the only two reads are `:1332` (zero the regen budget so a REGEN verdict escalates to FLAG) and `:1348` (`not self._ever_edited` guarding regen-if-untouched re-delivery). It is a plain workflow instance attribute — not on any dataclass crossing an activity boundary (`PersistDraftInput` carries no edit flag), and `grep -rn "ever_edited" apps/harness/src` returns hits in that one file only.

The correction: `_ever_edited` does not guard `persistDraft` **at all**, even inside a single execution. It guards a different, adjacent hazard — silent regen-swap within the assurance loop. So it is not, as claimed, "a real guard for exactly this hazard" that merely fails to persist; it is a guard for a neighbouring hazard that was never wired to this one. Two further scope limits compound it: (i) it is reconstructed by event-history replay only *within one execution*, so a second `HarnessDocWorkflow` execution begins with `False`; (ii) the edit signal is only sent when `consultation.status === ConsultationStatus.DRAFT_PENDING_SENSORS` (`packages/applications/src/services/consultation/summary/summary.service.ts:784`), so an edit made during `PENDING_REVIEW` — the normal clinician review state — never sets the flag even in a running workflow.

## Strongest counter-argument

Three defenses are available. Two fail outright; the third succeeds for one of the two paths.

1. **"The clinician edit and the AI write target different rows or different fields, so they never collide."** This is the counter the brief asked me to test first, and it fails. The clinician path is `PATCH /consultations/:id/summary/:summaryId` → `SummaryService.updateSummary` (`summary.service.ts:702-800`), which assigns `contextItem.content = request.content` (`:752`) and calls the same `contextItemRepository.update` (`:767`) on the same `core.ContextItem` row and the same encrypted `content` field the AI paths write. Same table, same column, same repository method.

2. **"A clinician edit reclassifies the row to `MODIFIED_SUMMARY`, moving it out of adoption range."** This is the most plausible-sounding defense — two code comments explicitly assert it (`summary.service.ts:779`, *"the MODIFIED_SUMMARY version write above is the source of truth"*, and `harness-gateway.service.ts:264`) — and it is **false**. I grepped every `MODIFIED_SUMMARY` occurrence in `packages/applications/src`: all of them are reads, type filters, DTO descriptions, or comments. **No code path anywhere writes a `MODIFIED_SUMMARY` ContextItem.** `updateSummary` never touches `contextItem.type`. The edited row therefore remains `RAW_SUMMARY` with `metaData.subType = 'HARNESS_DRAFT'` — precisely the predicate `findOwnHarnessDraft` matches. The comments describe a design that was never implemented. (Collateral: the read-authority ladder at `harness-internal.service.ts:364`, `SIGNED_NOTE → MODIFIED_SUMMARY → RAW_SUMMARY`, has a permanently dead middle rung, so it silently resolves to the very row the AI overwrites.)

3. **"A lifecycle guard bounds the window."** `persistDraft` does call `assertConsultationWritable` at `:735`, which looks like a status gate — but reading it (`:402-406`) it checks only `consultation.resourceStatus !== ResourceStatusType.ENABLED`, i.e. the soft-delete status. It does not consult `ConsultationStatus` at all, so `PENDING_REVIEW` and `DRAFT_PENDING_SENSORS` are equally writable. This defense fails.

4. **The defense that succeeds, for the live-snapshot path only.** The row `persistDurableSnapshot` writes is a `PRE_SUMMARY` tagged `subType: 'LIVE_SOAP_SNAPSHOT'` — and the sprint spec itself defines this artifact as disposable: *"The work note is volatile operational state, not the final record"* (`docs/architecture/consultation-session-workflow/user-stories-and-use-cases.md:205`), with the note draft, candidate final note, approved note, and committed record as four separate artifacts. Continuously regenerating the work note is the intended behavior, not a violation. A clinician *could* edit it — `updateSummary` accepts any row where `isSummary` is true, which includes `PRE_SUMMARY` (`packages/domains/src/entities/generated/core/ContextItemEntity.ts:256-262`) — and the SDK exposes a generic `updateSummary(id, content)` (`packages/agentic-sdk-v2/src/types/summary.ts:261`) over a by-id route builder (`packages/agentic-sdk-v2/src/core/constants.ts:145`). But I found no client surface that actually passes the live snapshot's id. So for this path the mechanism is real and the clinical consequence is unproven.

## True scope and severity

**The concrete race, walked through the actual writes (`persistDraft` path).** The harness delivers a draft; `persistDraft` creates the `RAW_SUMMARY` row, stamps `subType: 'HARNESS_DRAFT'`, and pins `currentVersionNumber = 1` (`:776-785`). The clinician edits it: `updateSummary` writes a `ContextItemVersion` snapshot **containing the pre-edit content** plus a `contentDiff` of previous→new (`summary.service.ts:725-747` — note `CreateFromContextItem` snapshots the *previous* content, per its own comment at `:736-737`), bumps `currentVersionNumber` to 2 (`:749`), sets `updatedBy` to the clinician (`:756`), and writes the new text to `contextItem.content` (`:752`, `:767`). A second `HarnessDocWorkflow` execution then runs `persistDraft`; `findOwnHarnessDraft` matches the row on type + subType; line 762 replaces the clinician's text with fresh AI output; line 768 commits it.

**Reachability is established by the code's own justification.** The adoption branch exists *because* second executions are routine — `:747-758` states that `HarnessDocWorkflow` has two start sites (the gateway start and `ConsultationLoopWorkflow`'s `harness.finalize` child), both on the deterministic id `harness-doc-{consultationId}` with no `id_reuse_policy`, so Temporal's default `ALLOW_DUPLICATE` rejects a second start only while the first is still open. The branch was added to stop a second execution creating a *duplicate row*; it solved that and introduced this. Its author also noted that `withHarnessIdempotency` degrades to `work()` whenever Redis is absent or throws (`:1398-1400`) — so the Redis replay cache is not a backstop either.

**Blast radius and recoverability.** Any consultation whose harness workflow runs a second execution after a clinician edit. The clinician's text is **not permanently destroyed** — it is reconstructible as `stored previous content + contentDiff` from the `ContextItemVersion` row — so the spec's *"edit history remains available for audit"* is arguably met. What is violated is the sharper requirement: *"Clinician-authored text is never silently overwritten"* (`user-stories-and-use-cases.md:205`, `:214`, `:381`) and *"The system must not silently restore the old wording"* (`dataset.xml:151`). The authoritative note row silently reverts to machine wording with no diff shown, no conflict surfaced, and no signal to the clinician. In a clinical record that is a patient-safety and medico-legal defect regardless of whether a forensic reconstruction is possible afterwards.

**Framing.** Per the header note, the requirements cited are from an untracked new-sprint spec. This is a design-gap to close in the sprint, not a regression against a shipped guarantee — but the data-loss behavior is live in the current code and does not depend on the spec being adopted.

**What is not proven.** Whether second executions actually fire in production frequency, and whether any deployed client edits the live snapshot row. Runtime evidence that would settle both: query Temporal for consultations with more than one `harness-doc-{consultationId}` execution, and join `ContextItemVersion` rows with `changeSource='doctor_edit'` against the `updatedBy` on their parent `ContextItem` — any row whose latest `updatedBy` is the harness worker while a `doctor_edit` version exists is a realized instance of this bug.

## Minimal fix

There is a one-line guard available, because the two paths already maintain the discriminator. `persistDraft` pins `currentVersionNumber = 1` on create (`:779`) and `updateSummary` sets it to `previous + 1 ≥ 2` on every clinician edit (`:749`). So `currentVersionNumber > 1` is exactly "a human has edited this row". In the adoption branch at `harness-internal.service.ts:761`, change

```ts
if (existingDraft) {
```
to skip the content overwrite when `(existingDraft.currentVersionNumber ?? 1) > 1` — leaving the clinician's text in place, still re-stamping `SummaryMeta`, and surfacing the new generation as a proposed patch or a FLAG rather than a silent swap. The structurally cleaner variant is to switch `:768` to `updateWithVersion(existingDraft.id, existingDraft, expectedVersion)` with the `_version` captured at delivery and treat `OptimisticConcurrencyException` as "clinician edited — do not overwrite", which also closes the concurrent-write window the version check alone leaves open.

For `persistDurableSnapshot`, no change is warranted until the work note is shown to be clinician-editable; if it is, the fix is to re-read the row instead of writing through the stale `session.snapshotEntity` (`:1861`) and apply the same guard.

---

## Corrections to the original findings

**Things the original got wrong or overstated:**

1. **"VIOLATED" is the wrong verb for both.** The requirements come from `docs/architecture/consultation-session-workflow/`, which is **untracked** — a new-sprint spec, not a shipped guarantee. These are gaps to close, not regressions.
2. **Finding 1, "no length cap":** wrong as stated. The joined corpus is truncated at `maxContextChars` (default 100,000) at `dna-writing-style.processor.ts:177-179`.
3. **Finding 1 under-credited three real controls:** the injected style is wrapped in *"without changing any clinical facts"* in both prompt builders (`v1-summary-prompt.builder.ts:382`, `summary-prompt.builder.ts:234`); `styleText`/`reportData` plaintext columns are **dropped**, persisted as Vault-Transit ciphertext only (`dna-writing-style.prisma:19-23`); and `encryptPhiFields` **fails closed** in staging/prod (`phi-field-encryption.ts:32-34`). This is not a plaintext-at-rest exposure. (The processor's own comment at `:229-230` claiming "plaintext retained for the soak" is stale and contradicts the schema — worth deleting.)
4. **Finding 1's `GateEditExemplar` comparison is weaker than presented — and the real fact is worse.** `IPhiRedactor` has **no implementation and no DI provider anywhere in the repo**; because `GateEditMiningService` is fail-closed, that corpus currently mines nothing. The sibling pattern does not "exist here" as a working control. The correct systemic statement is: **no working PHI redactor exists anywhere in this codebase.**
5. **Finding 2 mischaracterizes `_ever_edited`.** It is not a guard for this hazard that merely fails to persist — it never guarded `persistDraft` at any point, in any execution. It gates regen-if-untouched inside the assurance loop only.
6. **Finding 2 treats two unequal paths as one.** `persistDurableSnapshot` writes the volatile work note, which the spec explicitly defines as disposable.

**Things the original missed, in its own favour:**

7. **The DNA feature is ON in the production day-1 tenant.** `dnaStyleEnabled` code-defaults to `false` and fails closed, but the seed sets it `true` at tenant scope for ArcaAI with *"every ArcaAI doctor is seeded with a DNA report"* (`seed/14-pipeline-policy.ts:75-80`). This is the single most important severity fact and the original omitted it.
8. **The `textSamples` branch also bypasses the DNA opt-out**, not just the approved-only filter (`processor.ts:112-124`) — a tenant admin can build a style profile for a clinician who explicitly opted out. That is a consent defect independent of any PHI question.
9. **The DNA corpus is denser in PHI than described:** `buildCorpus` (`:305-313`) renders each encounter as an `AI DRAFT:` → `DOCTOR APPROVED:` pair, i.e. two full renderings per patient, up to 50 patients in one prompt.
10. **The DNA output is entirely unconstrained.** The DNA_ANALYSIS template carries no `promptConfig`/`json_schema` (unlike its SOAP sibling), the SMR call binds no `response_format`, and the parser's `catch` stores raw model output verbatim (`:197-203`). The "it's a structured profile" defense has nothing holding it up.
11. **Guardrail is not a sanitizer.** It returns a verdict, never transforms text, asks only "is this medical content", and defaults to `enabled = False` (`apps/text/src/text/core/config.py:329`).
12. **`MODIFIED_SUMMARY` ContextItems are never written by any code path**, while two comments (`summary.service.ts:779`, `harness-gateway.service.ts:264`) assert that they are, and a read-authority ladder (`harness-internal.service.ts:364`) depends on them. This is the root reason the clinician-edited row stays adoptable, and it is a defect in its own right that neither finding identified.
13. **`assertConsultationWritable` is not a lifecycle guard** — it checks soft-delete status only (`:402-406`), so review state does not bound the overwrite window.
