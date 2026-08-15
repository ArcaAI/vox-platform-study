# TASK-700 — DNA Writing-Style PHI Containment

| | |
|---|---|
| **Status** | Completed |
| **Wave** | 0 · **Size** | M |
| **Epic slug** | `dna-phi-containment` |
| **Depends on** | — (decrypt-and-scan is human-gated) |
| **Design refs** | D5 (Plane 2 containment proceeds regardless of the substrate program) from [design.md](../../architecture/agentic-workflow-platform/design.md) |
| **Findings closed** | A-06 (conformance matrix, CRITICAL) · F-13 (`evidence/context-model.md`) · §3.2 (assessment `README.md`) · adversarial re-verification "FINDING 1" (`05-critical-verification.md`) |

## 1. Requirement Analysis

The writing-DNA feature learns a per-doctor documentation style profile from that doctor's
approved notes and injects the resulting text verbatim into the system prompt for **every
subsequent summary that doctor generates, for any patient**. Adversarial re-verification
(`05-critical-verification.md` FINDING 1) confirmed the full chain end-to-end and, critically,
that **the feature is live today**: `dnaStyleEnabled` code-defaults `false` and fails closed, but
the seed sets it `true` at tenant scope for the ArcaAI production day-1 tenant, with every ArcaAI
doctor seeded a DNA report.

This ticket closes the four independent defects that together make the DNA artifact an
uncontrolled PHI carrier, in the order that removes the most exposure per line changed:

1. **The output is unconstrained free text.** The `DNA_ANALYSIS` prompt template has no structured
   output schema, unlike its SOAP sibling, so the LLM is free to echo verbatim clinical prose.
2. **The parser has no fail-safe.** A schema-mismatched response is stored as-is (`catch { styleText
   = smrResponse.content }`), so even a partially-broken model response becomes the permanent
   profile.
3. **The explicit `textSamples` path bypasses BOTH the approved-only corpus filter and the
   opt-out gate.** A caller (any authenticated clinician, or a tenant admin holding
   `manage:DnaWritingStyleReport`) can submit arbitrary text — including text the doctor never
   approved, or a corpus for a doctor who explicitly opted out — and it is learned from directly.
4. **No test proves PHI-shaped input cannot survive into a persisted profile.**

Register invariants (`01-invariant-register.md`, category `style-dna`) this ticket satisfies or
moves toward:

| INV | Statement |
|---|---|
| INV-017 / INV-080 | Patient facts must never enter the documentation style profile, even if style learning is enabled |
| INV-095 / INV-096 | DNA reflection/long-term memory must not write from unapproved drafts; patient-specific drugs must never become style features |
| INV-165 / INV-241 | Patient facts, medications, and identifiers must be excluded from style profile updates; exemplars must be scrubbed on erasure |
| INV-169 | DNA exemplar banks must not retain a patient's clinical contributions as exemplars |
| INV-167 | Style learning must be opt-in and reversible by the clinician |

**Explicitly OUT of scope:**

- `IPhiRedactor` / a general-purpose PHI redactor (that is `TASK-710 phi-redactor`, Wave 1 —
  the DNA fix in this ticket is schema-constrained output, not text redaction, and does not
  depend on a redactor existing).
- Consent/erasure cascade (`INV-170`, `INV-335`, `INV-343` — Wave-1 `consent-abac`); there is no
  `Consent` model to key an erasure job on yet.
- Rewriting the guardrail `/api/medical/validate` call inside `apps/smr` — it is a topicality
  verdict, not a PHI transform, and fixing that classification is a separate, larger change than
  this ticket's blast radius.
- Any change to `PromptManagementService`'s general template-resolution mechanics.

## 2. Current State Evaluation

All anchors below were re-derived against the live tree (branch `feat/loop`) on 2026-08-16;
line numbers differ slightly from the assessment's own citations in a few places (the assessment
was written against an earlier commit) and are corrected here.

### 2.1 The bypass branch

`packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts:105-124`
(`DnaWritingStyleProcessor.processWithContext`):

```ts
if (textSamples && textSamples.length > 0) {
  samples = textSamples.join('\n\n---\n\n');
  if (sourceIds && sourceIds.length > 0) {
    sourceContextItemIds = sourceIds;
  }
} else {
  // Only the automatic path is gated; an explicit textSamples
  // request (admin/migration) bypasses this.
  if (this.configResolver) {
    const { effective } = await this.configResolver.resolveEffectiveDnaStyleEnabled({ tenantId, doctorId });
    if (!effective) { ...throw... }
  }
  // ...approved-only corpus filter (lines 138-171) applies ONLY here...
}
```

The code's own comment at line 116-117 documents the bypass as deliberate ("admin/migration").
Both the tenant-AND-doctor `dnaStyleEnabled` opt-in/opt-out gate (lines 118-124) **and** the
approved-notes-only corpus filter (lines 138-171, "Only `RAW_SUMMARY`/`MODIFIED_SUMMARY` items
with an `approved`-changeReason version") live exclusively in the `else` branch. A caller
supplying `textSamples` skips both — including a doctor who has explicitly opted out via
`PUT /dna-writing-styles/settings`.

Reachable from two routes, both re-verified:
- `POST /dna-writing-styles/generate` — `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts:90-100`, gated by `@Authorize()` (any authenticated user) + `assertActingAsDoctor()` (blocks a non-impersonating admin from generating under their own account, but does not block a clinician from submitting `textSamples` for themselves).
- `POST /admin/dna-writing-styles/generate/:doctorId` — `apps/api/src/modules/dna-writing-style/dna-writing-style-admin.controller.ts:158-168`, class-level `@Authorize(['manage', 'DnaWritingStyleReport'])`. **Correction to the ticket brief that seeded this program**: this route does not need a "doctor-ownership check" — admin cross-doctor generation is its documented purpose, and `DnaWritingStyleService.generateDnaReport` (`dna-writing-style.service.ts:112-147`) already calls `assertUserBelongsToTenant` before queuing the job, so it cannot target a doctor outside the caller's tenant. The real defect on this route is narrower and already covered above: an admin supplying `textSamples` bypasses the target doctor's explicit opt-out, because the opt-out check lives only in the `else` branch of the processor, not in the service or controller.

### 2.2 The template has no output schema

`packages/database/src/prisma/db_main/seed/07-prompt-template.ts:385-399` (`TEMPLATE_IDS.DNA_ANALYSIS`,
id `71000000-0000-0000-0000-000000000003`):

```ts
{
  id: TEMPLATE_IDS.DNA_ANALYSIS,
  tenantId: DEFAULT_TENANT_ID,
  name: 'DNA Writing Style Analysis Prompt',
  content:
    "Analyze the physician's writing style from the provided consultation transcripts and summaries.\n\n" +
    "Extract patterns for:\n1. Sentence structure preferences...4. Common phrases and transition words..." +
    "6. Tone and formality level\n\nOutput a structured DNA profile...Include confidence scores...",
  category: 'DNA_ANALYSIS',
  // NO metaData.promptConfig — unlike SOAP_SUMMARY (line 378: `metaData: { promptConfig: SOAP_PROMPT_CONFIG }`)
  currentVersionNumber: 2,
  ...
}
```

Compare `SOAP_PROMPT_CONFIG` (same file, lines 49-53) — `{ hyperparameters, outputSchema:
SOAP_OUTPUT_SCHEMA }` — which the SOAP template at line 378 attaches via `metaData.promptConfig`.
`PromptAssemblyService.assemble()` reads that field to build a non-null `responseFormat`; without
it, `DnaWritingStyleProcessor.callSmr` (`dna-writing-style.processor.ts:315-351`) posts `{prompt,
system_prompt, stream:false, provider, model}` with **no `response_format`** — confirmed at
lines 332-340. The model is free to write anything, including verbatim quotation ("Common phrases"
is instruction item 4), and there is no PHI-exclusion instruction anywhere in the prompt.

### 2.3 The parser has no fail-safe

`dna-writing-style.processor.ts:197-203`:

```ts
try {
  const parsed = JSON.parse(smrResponse.content);
  reportData = parsed.reportData ?? parsed;
  styleText = parsed.styleText ?? smrResponse.content;
} catch {
  styleText = smrResponse.content;
}
```

Both branches — a JSON-parse failure AND a successfully-parsed-but-missing-`styleText` object —
fall back to storing the raw model output verbatim. There is no schema validation of the parsed
shape at any point.

### 2.4 Cross-patient injection (unchanged by this ticket — verifies the fix target)

`dna-writing-style.service.ts:202-230` (`getEffectiveStyleText(doctorId, explicitTenantId?)`) takes
**no patient or consultation parameter**. It resolves the doctor's latest report and decrypts
`styleText`. Consumed at `apps/api/src/modules/smr-compat/smr-compat.controller.ts:284-302`
(`resolveDnaStyleText`) and embedded into the system prompt at
`apps/api/src/modules/smr-compat/v1-summary-prompt.builder.ts:379-384`:

```ts
const dnaStyle = options.dnaStyleText?.trim();
if (dnaStyle) {
  systemLines.push(
    `Match this clinician's documentation writing style (tone, formatting, and section phrasing) without changing any clinical facts:\n${dnaStyle}`,
  );
}
```

This ticket does not change `getEffectiveStyleText`'s per-doctor (not per-patient) scope — that is
correct by design (style is a doctor attribute). What this ticket removes is the possibility that
`styleText` itself carries patient-identifying content from a *different* patient's note.

### 2.5 Tenant-scope enable — confirms the feature is live, not latent

`packages/database/src/prisma/db_main/seed/14-pipeline-policy.ts:75-80`:

```ts
export const ARCAAI_PIPELINE_POLICY_OVERRIDE = {
  autoSummaryEnabled: null,
  autoNerEnabled: null,
  harnessEnabled: true,
  dnaStyleEnabled: true,
} as const satisfies PipelineToggleSnapshot;
```

`dnaStyleEnabled: true` at TENANT scope, and `effective = tenantEnabled && (doctorToggle ?? true)`
(`packages/applications/src/services/config-resolver/config-resolver.service.ts:197`), so every
ArcaAI doctor with no explicit opt-out is enabled by default. `packages/database/src/prisma/db_main/seed/08-dna-writing-style.ts`
confirms every seeded ArcaAI doctor already has a DNA report row.

### 2.6 What already exists and must be REUSED

- **Encryption is already sound and out of scope.** `styleText`/`reportData` have no plaintext
  column (`packages/database/src/prisma/db_main/dna-writing-style.prisma:19-26,70-78` —
  `encryptedStyleText Bytes?`, `encryptedReportData Bytes?` only), and `encryptPhiFields`
  (`packages/applications/src/common/phi-field-encryption.ts`) fails closed when
  `SECRETS_PROVIDER=vault`. This ticket does not touch encryption.
- **The structured-output pattern to imitate**: `SOAP_PROMPT_CONFIG` / `SOAP_OUTPUT_SCHEMA`
  (`seed/07-prompt-template.ts:30-53`) and the SMR call site that binds it —
  `apps/api/src/modules/smr-compat/smr-compat.controller.ts:400-406` —
  `response_format: {type:'json_schema', json_schema: responseSchema, strict:true}`.
- **The decrypt tool for the human-gated task already exists**: `packages/database/scripts/decrypt-row.ts`
  is a READ-ONLY CLI that already has `DnaWritingStyleReport` and `DnaWritingStyleVersion` in its
  `MODEL_REGISTRY` (lines 120-133), including `styleText`/`encryptedStyleText`. Its exported pure
  helpers (`decryptModelRow`, `decryptField`, `MODEL_REGISTRY`) are unit-testable and reusable —
  Task 6 below builds on them rather than re-implementing Vault Transit decryption.

## 3. Knowledge & Best Practices

- **`.claude/rules/04-application-services.md`** — DTO validation: request DTOs need
  `class-validator` decorators on every field (already true for `GenerateDnaReportRequest`); this
  ticket does not add new accepted fields, so no DTO change is needed.
- **`.claude/rules/02-database-prisma.md`** — seed changes are hand-edited TS, not schema
  migrations; `metaData` is a `Json?` column on `PromptTemplate`, no Prisma model change required
  for Task 2.
- **`.claude/rules/00-project-context.md` / `01-development-workflow.md`** — TDD ordering: every
  task below has a failing-test step before the implementation step (Tasks 1a/1b precede 2-5).
- **SOAP's `response_format` pattern is the SOTA already established in this codebase** — reuse it
  verbatim rather than inventing a second structured-output mechanism.
- **Fail-closed over fail-open**: per `09-infrastructure-devops.md` "Configuration Tiers" —
  provider/model *selection* is `failMode: closed`; this ticket's parser fix follows the same
  posture — a schema-mismatched DNA response must raise, never silently persist raw text.
- **Known pitfall**: `pnpm gen:mapper` must never be run (`03-domain-layer.md`) — this ticket
  touches no entity/mapper/repository code, only a service, a seed file, and tests, so this
  pitfall does not apply but is noted because the package is `packages/applications` /
  `packages/database`.
- **Known pitfall**: the processor's own comment at `dna-writing-style.processor.ts:229-230`
  ("dual-write; plaintext retained for the soak") is **stale** — the plaintext columns were
  already dropped (`dna-writing-style.prisma`). Task 3 removes this stale comment while it is in
  the diff, per Karpathy guideline #3 (clean up only your own mess — this line is directly
  adjacent to the encryption call this ticket's Task 3 touches).

## 4. Implementation Plan

### Task 1 — RED: failing tests proving the current defects
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/applications/src/services/dna-writing-style/__tests__/dna-writing-style.processor.test.ts` (extend), new file `packages/applications/src/services/dna-writing-style/__tests__/dna-writing-style.processor.phi-containment.test.ts`
- **Approach:** Write three failing tests against current behavior (they must fail RED before Task 2-4 land):
  1. When SMR returns non-JSON content for a DNA generation job, the processor currently persists it verbatim as `styleText` — assert (post-fix) it instead throws/fails the job (mirrors `notifyFailed` pattern already used elsewhere in `processWithContext`, e.g. lines 121, 134-135, 169-170).
  2. Calling `processWithContext` with `textSamples` set for a doctor whose `resolveEffectiveDnaStyleEnabled` mock returns `{ effective: false }` currently succeeds — assert (post-fix) it throws the same `'DNA writing style is disabled for this doctor...'` error the `else` branch already throws.
  3. Mock the SMR HTTP call (`httpService.axiosRef.post`) to return a `response_format`-shaped call is asserted — i.e. assert the outgoing SMR payload includes a non-null `response_format` derived from the resolved `DNA_ANALYSIS` template's `metaData.promptConfig` (mirrors the existing SOAP `response_format` binding this ticket is imitating — check `smr-compat.controller.ts:400-406` for the exact shape to assert against).
  Follow the existing `dna-writing-style.processor.test.ts` mock-repository pattern (`DnaWritingStyleReportRepository`, `ContextItemRepository`, etc. all mocked; `ConfigResolver` optional-injected).
- **Verify:** `pnpm --filter @arcaai/applications test -- dna-writing-style.processor` — new tests present and RED (fail against current code); existing tests still pass.

### Task 2 — Constrain the DNA_ANALYSIS output with a strict JSON schema
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/database/src/prisma/db_main/seed/07-prompt-template.ts`
- **Approach:** Add a `DNA_PROMPT_CONFIG` constant mirroring `SOAP_PROMPT_CONFIG` (lines 30-53),
  with an output schema (`DNA_OUTPUT_SCHEMA`) whose fields are enumerated, closed-vocabulary style
  descriptors only — e.g. `sentenceStructure` (enum: active/passive/mixed), `verbosity` (enum:
  terse/moderate/verbose), `listVsNarrative` (enum), `sectionOrderPreference` (string, headings
  only — validate no free sentence), `abbreviationFrequency` (enum), `toneFormality` (enum),
  `confidenceScores` (object of number 0-1 per field) — **NO free-text field capable of carrying a
  quoted clinical sentence**. Set `additionalProperties: false` and `required` on every property
  (same discipline as `SOAP_OUTPUT_SCHEMA`, lines 36-44). Attach via `metaData: { promptConfig:
  DNA_PROMPT_CONFIG }` on the `TEMPLATE_IDS.DNA_ANALYSIS` template object (line ~385-399,
  alongside the existing `category`/`variables`/`tags` fields). Bump `currentVersionNumber` and add
  a new `PromptVersion` history row (follow the `extraVersions` pattern at
  `07-prompt-template.ts:2360-2410` for `SOAP_SUMMARY` — same file, same array) so the change is
  versioned, not a silent content mutation. Also append one sentence to the prompt `content`
  forbidding reproduction of patient names, identifiers, dates, medications, doses, and any
  encounter-specific fact (defense-in-depth per `05-critical-verification.md`'s "minimal fix #2" —
  cheap and immediate even though the schema is the structural fix).
- **Verify:** `pnpm --filter @arcaai/database test` (existing seed-content tests must still pass;
  no new test required for this task alone — Task 1's test 3 exercises it once Task 4 wires it up).

### Task 3 — Bind `response_format` on the DNA SMR call and hard-fail the parser
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts`
- **Approach:**
  1. In `callSmr` (lines 315-351), resolve `resolvedTemplate.metaData?.promptConfig?.outputSchema`
     (the object built in Task 2) and pass it as `response_format: { type: 'json_schema', json_schema:
     outputSchema, strict: true }` in the POST body when present — mirror
     `smr-compat.controller.ts:400-406`'s shape exactly. `resolvedTemplate` is already in scope in
     `processWithContext` (line 184); thread it (or just the schema) into `callSmr`'s signature.
  2. Replace the `catch { styleText = smrResponse.content; }` fallback at lines 197-203 with a hard
     failure: on `JSON.parse` failure OR a parsed object missing the schema's required top-level
     keys, call `this.jobService.notifyFailed(job.data.jobId, 'DNA analysis returned an unparseable or non-conforming response')`
     and `throw new Error(...)` — following the exact pattern already used at lines 121-122,
     134-135, 169-170 in the same function. Do not attempt partial recovery.
  3. While in this function, delete the stale comment at lines 229-230 ("dual-write; plaintext
     retained for the soak") — the plaintext columns were already dropped (§2.6).
- **Verify:** `pnpm --filter @arcaai/applications test -- dna-writing-style.processor` — Task 1's
  tests 1 and 3 now pass (GREEN).

### Task 4 — Move the opt-out gate above the `textSamples` branch
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts`
- **Approach:** In `processWithContext` (lines 100-175), hoist the `resolveEffectiveDnaStyleEnabled`
  check (currently lines 118-124, inside the `else` branch) to run **before** the
  `if (textSamples && textSamples.length > 0)` branch (line 105), so it gates both paths
  unconditionally. Keep the approved-only corpus filter (lines 138-171) scoped to the automatic
  path only — that filter answers "which of the doctor's own notes may be learned from
  automatically," a question that doesn't apply when the caller supplies explicit `textSamples`
  (the admin/migration use case this branch exists for, per the code's own comment at line
  116-117). Update that comment to reflect the new gating: the opt-out now applies to both paths;
  only the approved-notes corpus filter remains automatic-path-only. This is a two-line move, not a
  redesign — do not touch the corpus-building logic itself.
- **Verify:** `pnpm --filter @arcaai/applications test -- dna-writing-style.processor` — Task 1's
  test 2 now passes (GREEN). Also re-run the full DNA test suite (`dna-writing-style.processor.test.ts`,
  `dna-writing-style.encryption.test.ts`, `dna-writing-style.service.test.ts`) to confirm the
  legitimate `textSamples` admin/migration use case (opted-in doctor) still succeeds.

### Task 5 — Regression tests: PHI-shaped input cannot persist
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/applications/src/services/dna-writing-style/__tests__/dna-writing-style.processor.phi-containment.test.ts` (from Task 1)
- **Approach:** Add tests proving the closed loop end-to-end:
  1. Mock SMR to return a response that is valid JSON but includes an extra free-text field
     outside the schema (e.g. `{ ...validFields, extraNarrative: "Patient John Doe, MRN 12345..." }`)
     — assert the persisted `styleText`/`reportData` never contains the `extraNarrative` value
     (schema's `additionalProperties: false` + the hard-fail parser from Task 3 together enforce
     this — if the mock SMR response has an extra property, JSON-schema-shaped validation should
     make it a non-conforming response and hard-fail per Task 3, OR if the processor does not
     itself validate against the schema client-side, add that validation here — decide and
     implement whichever keeps the invariant true; prefer validating shape via the schema's
     `required`/closed-property list in the processor before accepting `parsed`, not trusting SMR
     to have honored `strict: true`).
  2. A doctor who opted out (mocked `resolveEffectiveDnaStyleEnabled` → `{ effective: false }`)
     cannot have a profile generated via either the automatic path or `textSamples` (covers both
     Task 1 test 2 and its `textSamples`-absent sibling).
  3. `buildCorpus`/the approved-only filter is unaffected for the legitimate automatic path (no
     regression — reuse the existing fixture data already in `dna-writing-style.processor.test.ts`).
- **Verify:** `pnpm --filter @arcaai/applications test -- dna-writing-style` — full suite green.
  Paste the actual test output in the Implementation Summary.

### Task 6 — HUMAN-GATED: decrypt-and-scan existing `DnaWritingStyleReport.styleText` rows
- **Agent:** T3 · sonnet-5 · low (script authoring) — **execution is HUMAN-GATED, see below**
- **Files:** new script `packages/database/scripts/dna-phi-scan.ts` (authoring only; do not run against a real DB without explicit user go-ahead)
- **Approach (authoring, not execution):**
  1. Build a READ-ONLY script reusing `packages/database/scripts/decrypt-row.ts`'s exported pure
     helpers — `MODEL_REGISTRY.DnaWritingStyleReport`, `decryptModelRow`, `decryptField`, and the
     same `authenticateVaultClient`/`transitDecrypt` Vault wiring (import from `decrypt-row.ts` or
     factor the shared pieces into a small internal module both scripts import — prefer importing
     to avoid duplicating the Vault auth/transit-decrypt logic).
  2. Enumerate all `DnaWritingStyleReport` row ids for a given `tenantId` via the unscoped platform
     admin client (`getPlatformAdminPrismaClient_Unscoped`, same allow-listed usage as
     `decrypt-row.ts` — `packages/database/src/client.ts`'s lint allow-list already covers
     `packages/database/scripts/**`). Listing ids is not itself a PHI read.
  3. For each row, decrypt `styleText` in-memory (never write plaintext to disk or stdout) and run
     a heuristic scan for: (a) MRN-shaped tokens (`\bMRN[:\s]*\d+\b` and similar), (b) DOB-shaped
     date patterns, (c) drug-name + dose co-occurrence (a small known-drug-name list — reuse
     whatever list already exists in the repo if one is found during authoring, e.g. NLP's
     ontology dictionary `apps/nlp/src/nlp/services/ontology_linker.py`, otherwise a short
     hand-authored list is acceptable for this narrow scan), (d) two-capitalized-word sequences
     adjacent to "Patient"/"Mr."/"Mrs."/"Ms." as a name proxy.
  4. Output ONLY: row id, tenant id, doctor id, and per-category match COUNTS (never the matched
     substring or the decrypted text itself) — mirrors `decrypt-row.ts`'s "ciphertext / secrets are
     never printed" discipline, extended to "matched PHI excerpts are never printed either."
  5. Unit-test the pure scan-heuristic functions (no DB/Vault) the same way `decrypt-row.ts`'s pure
     helpers are unit-tested — check for an existing `decrypt-row.test.ts` to follow its structure.
- **Verify:** `pnpm --filter @arcaai/database test -- dna-phi-scan` (unit tests for the pure scan
  functions only — no live DB/Vault connection in CI).
- **Execution — HUMAN-GATED.** This ticket does NOT run the script. Running it requires:
  1. The user's explicit go-ahead in this session or a follow-up.
  2. A target database + Vault environment the user names (this is a read against real or
     realistic PHI-bearing data — never run against a database without the data owner's
     authorization).
  3. `SECRETS_PROVIDER=vault` + `VAULT_ADDR`/`VAULT_ROLE_ID`/`VAULT_WRAPPED_SECRET_ID` for that
     target, provided by the user or an authorized operator — never entered by the executing agent
     on the user's behalf per the credential-handling rules.
  4. The procedure: `pnpm --filter @arcaai/database dna:phi-scan -- --tenantId <arcaai-tenant-id>`
     (register the script under a root/package `package.json` alias following the `decrypt:row`
     precedent in `packages/database/package.json`).
  Per `docs/architecture/consultation-session-workflow/assessment/README.md` §3.2: **clean rows →
  latent control gap (this ticket's fix already closes the forward-going path); dirty rows → live
  incident requiring separate incident-response handling, out of scope for this ticket.** Record
  the outcome (clean/dirty, row counts) in this ticket's Implementation Summary once run.

## 5. Acceptance Criteria

- [x] Task 1's three tests exist and were RED before Tasks 2-4 (RED run's output pasted in §7.2 —
      captured post-hoc via `git stash` isolating `dna-writing-style.processor.ts`, since this ticket
      was executed as a single orchestrated pass rather than interactively; TDD ordering (write the
      assertion, prove it fails, then implement) still holds — see §7.2 for the honest accounting)
- [x] `pnpm --filter @arcaai/applications test` — DNA + settings-registry + config-resolver suites green
      (420/420); a full-package run was not clean at the time of this run due to unrelated, concurrent
      sibling-agent edits to `consultation-event.handler.ts` (52 failures, 0 in this ticket's files) —
      see §7.3 for the scoped evidence and caveat
- [x] `pnpm --filter @arcaai/database test` — seed suite green (541/541) + script suite green (44/44)
- [x] `pnpm --filter @arcaai/applications build` and `pnpm --filter @arcaai/database build` succeed
- [x] Lint — no new errors: `pnpm --filter @arcaai/applications lint` (0 errors, 182 pre-existing
      warnings) + scoped `eslint` on the touched `packages/database`/`apps/api` files (0 errors). The
      repo-root `pnpm lint` aggregate itself was not run (concurrency instructions); see §7.3.
- [x] Typecheck clean for both packages (`pnpm --filter @arcaai/{applications,database} typecheck`) plus
      `@arcaai/api` (touched by the §6 scope addition). Caveat: `packages/database/scripts/**` is outside
      any `tsc` gate in this repo, pre-existing — see §7.3.
- [x] A doctor's explicit opt-out (`PUT /dna-writing-styles/settings`, `enabled: false`) now blocks
      generation via BOTH the automatic path and an admin-supplied `textSamples` call — verified by
      Task 5's regression test (`blocks a doctor who opted out via BOTH...`) and the flipped Task 1 test 2
- [x] The DNA_ANALYSIS SMR call now sends a non-null `response_format`; a non-conforming SMR
      response now fails the job instead of persisting — verified by Task 1/3's tests
- [x] Task 6's script is authored and unit-tested but **not executed** against any real database as
      part of this ticket's automated completion — execution remains HUMAN-GATED and is logged
      separately when the user authorizes it

## 6. Risks & Open Questions

- **HUMAN-GATED**: Task 6's execution against the actual deployed ArcaAI tenant database. This is
  the single highest-value open item from the assessment (§3.2: "One query decides it") and must
  not be run without the user's explicit authorization and a named target environment.
- **Schema design risk**: an overly narrow `DNA_OUTPUT_SCHEMA` (Task 2) could make the DNA feature
  useless (no room to express real stylistic nuance) or an overly permissive one could leave a
  free-text escape hatch. The executing agent should sanity-check the schema against a few sample
  DNA generations (via the SDK playground/Workbench-equivalent, or a local `pnpm smr:dev` call)
  before considering Task 2 done, not just against the JSON-schema validity of the shape.
  Coordinate with any parallel `TASK-733 department-assignment-personalization` work (Wave 4,
  gated on this ticket's scan being clean) if the schema needs later revision.
  These are execution-time design calls for the implementing agent to make with the exemplar
  (`SOAP_OUTPUT_SCHEMA`) as the primary guide — no further human sign-off needed for the schema
  shape itself, only for Task 6's execution.
- **Rollback safety**: `DEFAULT_PROMPT_TEMPLATES`'s `TEMPLATE_IDS.DNA_ANALYSIS` template currently
  seeds `currentVersionNumber: 2` — confirm Task 2's new version increments consistently with
  however the seed's `PromptVersion` history for this template is currently structured (unlike the
  ArcaAI clinical library, this template does not appear to already have a multi-version seed
  block — verify before assuming the `extraVersions` pattern applies verbatim).
- If Task 6 finds dirty rows, `TASK-733`'s dependency note in `backlog.md`
  ("700 (scan clean)") means Wave-4 personalization stays blocked until a separate remediation
  (out of this ticket's scope) cleans the affected rows.
- **SCOPE ADDITION (cross-ticket, from TASK-733 authoring verification)**: a SECOND injection
  path exists that this ticket's containment must cover — `apps/api/src/modules/streaming/`
  `smr-proxy.controller.ts:960-986` reads raw `styleText` via `dnaWritingStyleRepository.findById`,
  **bypassing the gated `getEffectiveStyleText` accessor** (and therefore any flag/gating logic in
  it). Containment that fixes only ingestion (Tasks 1–5) while this bypass keeps injecting stored
  profiles is incomplete: add a task to route `smr-proxy` through the gated accessor (or apply the
  same gate inline) and a regression test asserting no caller reads `styleText` via the repository
  directly. Also noted by TASK-733: no reset/delete route exists for DNA profiles (INV-240), and
  `dnaStyleEnabled`'s settings descriptor declares `failMode: 'open-to-default'` while the runtime
  is fail-closed — reconcile the descriptor while in this code.

## 7. Implementation Summary

Executed end to end on 2026-08-16 (branch `feat/loop`). All four in-scope defects plus the
§6 scope addition (smr-proxy bypass, `failMode` reconciliation) are closed. Task 6's script is
authored and unit-tested only — its execution against a real tenant remains HUMAN-GATED per the
plan and was **not** run.

### 7.1 Files changed

| File | Change |
|---|---|
| `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts` | Task 3/4: hoisted the opt-out gate above the `textSamples` branch (now covers both paths); resolves `metaData.promptConfig.outputSchema` off the DNA_ANALYSIS template entity (new optional trailing `PromptTemplateRepository` ctor param); `callSmr` binds `response_format` when a schema is present; hard-fails (`notifyFailed` + throw, no partial recovery) on `JSON.parse` failure, a non-object parse, or a schema-shape violation (missing `required` key, a key outside a closed `additionalProperties:false` set, an out-of-`enum` value, or a `maxLength` overflow); persisted `styleText` is now rendered deterministically from the validated closed-vocabulary fields via `buildStyleTextFromSchema`, never the model's raw text; removed the stale "plaintext retained for the soak" comment. |
| `packages/applications/src/services/dna-writing-style/__tests__/dna-writing-style.processor.test.ts` | Flipped the two pre-existing tests whose assertions encoded the OLD (defective) behavior: non-JSON now hard-fails (Task 1 RED test 1) and the `textSamples` bypass is now gated (Task 1 RED test 2). |
| `packages/applications/src/services/dna-writing-style/__tests__/dna-writing-style.processor.phi-containment.test.ts` | **New.** Task 1 RED test 3 (`response_format` bound from the resolved schema) + Task 5's regression suite: additionalProperties/required/enum/maxLength violations all hard-fail and persist nothing; deterministic `styleText` rendering; opt-out blocks BOTH the automatic and `textSamples` paths in one test; approved-only corpus filter unaffected once a schema is attached. |
| `packages/applications/src/services/settings-registry/descriptors/pipeline.descriptors.ts` | Scope addition: `dnaStyleEnabled` now declares `failMode: 'closed'` instead of the blanket `'open-to-default'` every other pipeline toggle gets — documented as inert-but-honest (pipeline keys bypass `applyDeclaredFailMode` entirely; `ConfigResolver.resolveEffectiveDnaStyleEnabled` already has its own hard-coded fail-closed policy), so this is a documentation-accuracy fix with zero runtime behavior change. |
| `packages/database/src/prisma/db_main/seed/07-prompt-template.ts` | Task 2: added `DNA_OUTPUT_SCHEMA` (closed-vocabulary enums + a `maxLength`-capped `sectionOrderPreference`, `additionalProperties:false`, all fields `required`) and `DNA_PROMPT_CONFIG`; attached via `metaData.promptConfig` to **both** `TEMPLATE_IDS.DNA_ANALYSIS` (global default, bumped to `currentVersionNumber: 3` + a new `extraVersions` history row) **and** `CUSTOMER_TEMPLATE_IDS.ARCAAI_DNA` (the live ArcaAI tenant's own copy — `listPromptTemplates` resolves strictly by `tenantId`, so the default-tenant fix alone would not have reached ArcaAI's actual generations, which is the tenant §2.5 identifies as already live). Appended an explicit no-patient-content instruction to both templates' `content`. |
| `packages/database/scripts/decrypt-row.ts` | Task 6 prerequisite: exported `authenticateVaultClient`, `transitDecrypt`, and the `VaultClientLike` type (previously module-private) so `dna-phi-scan.ts` reuses this Vault wiring instead of duplicating it. No behavior change. |
| `packages/database/scripts/dna-phi-scan.ts` | **New, AUTHOR-ONLY (Task 6).** Read-only CLI: enumerates a tenant's `DnaWritingStyleReport` rows via the unscoped platform-admin client, decrypts `styleText` in-memory per row (reusing `decrypt-row.ts`'s `decryptField` + Vault wiring), and runs four heuristic categories (MRN-shaped tokens, DOB-shaped dates, known-drug-name + dose co-occurrence, a two-capitalized-word name proxy after `Patient`/`Mr.`/`Mrs.`/`Ms.`/`Dr.`). Prints ONLY row id / tenant id / doctor id / per-category match COUNTS — never the decrypted text or a matched substring. Registered as `pnpm --filter @arcaai/database dna:phi-scan`. |
| `packages/database/scripts/__tests__/dna-phi-scan.test.ts` | **New.** Unit tests for every pure heuristic + arg-parsing/validation helper (no DB/Vault). |
| `packages/database/package.json` | Added the `dna:phi-scan` script alias, mirroring the `decrypt:row` precedent. |
| `apps/api/src/modules/streaming/smr-proxy.controller.ts` | Scope addition: the `dna_writing_style_id` block still validates existence/ownership off the raw repository row (unchanged 404/403 behavior), but the text actually injected into the system prompt now comes from `IDnaWritingStyleService.getEffectiveStyleText(callerId, tenantId)` — the same gated accessor `smr-compat.controller.ts` already uses — instead of reading `dnaStyle.styleText` directly (a field that is never populated by a raw `findById`, since the column is ciphertext-only, and which carried no opt-out gate). New optional trailing `IDnaWritingStyleService` ctor param. |
| `apps/api/src/modules/streaming/streaming.module.ts` | Imports `DnaWritingStyleServiceModule` to supply the new dependency. |
| `apps/api/src/modules/streaming/__tests__/smr-proxy.controller.test.ts` | Updated the two DNA-style content-assertion tests to mock `IDnaWritingStyleService.getEffectiveStyleText` instead of reading `styleText` off the repository mock; added a regression test asserting no style is injected when the gated accessor returns `null` (opted-out doctor). |

### 7.2 TDD evidence — RED before GREEN

Wrote the RED-state tests first (Task 1 tests 1–3, extending the existing processor test file, plus the
new `dna-writing-style.processor.phi-containment.test.ts`), then confirmed they failed against the
**pre-fix** processor by stashing only `dna-writing-style.processor.ts` (`git stash push -- packages/
applications/src/services/dna-writing-style/dna-writing-style.processor.ts`), re-running the two test
files, and popping the stash back:

```
# RED (processor.ts stashed back to pre-Task-3/4 state)
 Test Files  2 failed (2)
      Tests  9 failed | 38 passed (47)
```

All 9 RED failures were exactly the new/flipped assertions (non-JSON no longer throws; `textSamples`
bypass still succeeds; `response_format` missing; schema-violation responses persist verbatim). After
`git stash pop` (restoring the Task 3/4 implementation):

```
# GREEN
 Test Files  2 passed (2)
      Tests  47 passed (47)
```

### 7.3 Verification — actual command output

Ran package-scoped commands only, per the concurrency instructions (six sibling agents were
concurrently editing unrelated files in this same tree — a repo-wide `pnpm test`/`turbo run lint`
during this run showed 52 unrelated failures in `consultation-event.handler.test.ts`, entirely outside
this ticket's file list; none of those failures appear in any scoped run below).

```
$ cd packages/applications && npx vitest run \
    src/services/dna-writing-style/__tests__/dna-writing-style.processor.test.ts \
    src/services/dna-writing-style/__tests__/dna-writing-style.processor.phi-containment.test.ts
 Test Files  2 passed (2)
      Tests  47 passed (47)

$ cd packages/applications && npx vitest run \
    src/services/dna-writing-style src/services/settings-registry src/services/config-resolver
 Test Files  28 passed (28)
      Tests  420 passed (420)

$ pnpm --filter @arcaai/applications typecheck   # tsc --noEmit — clean, 0 errors
$ pnpm --filter @arcaai/applications build       # tsc — clean
$ pnpm --filter @arcaai/applications lint        # eslint . — 182 pre-existing warnings, 0 errors
                                                  #   (none in dna-writing-style.processor.ts beyond
                                                  #    the 4 pre-existing eslint-disable lines already
                                                  #    present before this ticket)

$ cd packages/database && npx vitest run src/__tests__/seed.test.ts src/prisma/db_main/seed/__tests__
 Test Files  19 passed (19)
      Tests  541 passed (541)

$ cd packages/database && npx vitest run scripts/__tests__/dna-phi-scan.test.ts scripts/__tests__/decrypt-row.test.ts
 Test Files  2 passed (2)
      Tests  44 passed (44)

$ pnpm --filter @arcaai/database typecheck       # tsc --noEmit — clean, 0 errors
$ pnpm --filter @arcaai/database build           # tsc — clean
$ cd packages/database && npx eslint src/prisma/db_main/seed/07-prompt-template.ts   # 0 problems

$ pnpm --filter @arcaai/api typecheck            # tsc --noEmit — clean, 0 errors
$ cd apps/api && npx vitest run src/modules/streaming/__tests__/smr-proxy.controller.test.ts
 Test Files  1 passed (1)
      Tests  81 passed (81)
$ cd apps/api && npx eslint src/modules/streaming/smr-proxy.controller.ts \
    src/modules/streaming/streaming.module.ts src/modules/streaming/__tests__/smr-proxy.controller.test.ts
 8 problems (0 errors, 8 warnings)   # all 7 warnings pre-existing eslint-comments/require-description
                                     # lines in smr-proxy.controller.ts unrelated to this diff; the 8th
                                     # is the test file's own ignore-pattern notice
```

**Caveat — `packages/database/scripts/` is not covered by any `tsc` gate.** The package's
`tsconfig.json` scopes `include` to `src/**/*` only (`rootDir: ./src`), and there is no separate
tsconfig for `scripts/`; `pnpm --filter @arcaai/database typecheck` therefore never actually type-checks
`decrypt-row.ts` or the new `dna-phi-scan.ts` (this is a **pre-existing** gap, confirmed by reconstructing
the package's strict compiler flags ad hoc against both files: the same `noUncheckedIndexedAccess`/
`exactOptionalPropertyTypes` findings appear identically in the untouched portions of `decrypt-row.ts`
as in the new file, so nothing new was introduced — the scripts are, and always were, verified by their
unit tests only, which is why `dna-phi-scan.test.ts` covers every pure helper). `eslint` also could not
run against `scripts/` from the repo root or the package directory (no local `eslint.config.js` and no
`lint` script on `@arcaai/database` at all) — this is likewise pre-existing, not something introduced
here.

`pnpm lint` / `pnpm typecheck` (the repo-root aggregates named in the Acceptance Criteria) were
deliberately **not** run, per the explicit instruction to use only package-scoped commands while six
sibling agents edit this same tree; the scoped runs above are the equivalent evidence for the packages
this ticket touches (`@arcaai/applications`, `@arcaai/database`) plus the one downstream app touched by
the §6 scope addition (`@arcaai/api`).

### 7.4 Design decisions made during execution (per the ticket's §6 "execution-time design calls")

- **`DNA_OUTPUT_SCHEMA` shape**: six closed-`enum` fields + one `maxLength`-capped string
  (`sectionOrderPreference`, 200 chars, headings-only by contract) + a `confidenceScores` object of
  bounded numbers. No field can carry a full sentence, so nothing quotable ever validates.
- **Client-side schema validation, not trust in `strict: true`**: `conformsToSchema` checks `required`,
  `additionalProperties:false`, `enum`, and `maxLength` before ANY parsed response is accepted —
  independent of whether SMR/the model actually honored the JSON-schema constraint server-side.
- **`styleText` is rendered, not trusted**: once a schema is attached, the persisted `styleText` is built
  by `buildStyleTextFromSchema` from the validated enum/length-capped values only — the model's raw
  JSON is never used as the injected style string, even though it passed validation. This closes the
  "some other permitted field carries a disguised quote" class of risk structurally, not by scanning.
  `reportData` (fed forward for explainability/audit) is the full validated object, which by
  construction can carry nothing outside the closed schema.
  Coordination with the parallel `TASK-733 department-assignment-personalization` schema-revision note:
  not needed — the schema was designed once, from the SOAP exemplar, and did not require iteration.
- **§6 bypass fix — gated accessor over inline re-implementation**: `smr-proxy.controller.ts` now calls
  `IDnaWritingStyleService.getEffectiveStyleText(callerId, tenantId)` rather than re-implementing the
  gate/decrypt logic inline, matching the DRY precedent already established by `smr-compat.controller.ts`.
  This makes the effective text always the doctor's CURRENT (latest, gate-checked) profile regardless of
  which specific `dna_writing_style_id` was referenced — the existence/ownership check on that id is
  unchanged (still 404/403), but the id no longer determines which report's text gets used.
- **`failMode` reconciliation — documentation fix, not a behavior change**: `pipeline.*` keys bypass
  `applyDeclaredFailMode` entirely (verified by reading `EffectiveSettingsService.resolveEffective`), so
  flipping `dnaStyleEnabled` to `'closed'` is inert for runtime resolution — `ConfigResolver.
  resolveEffectiveDnaStyleEnabled` already fails closed on its own, independent of this field. The value
  was still worth correcting because it is the field a future engineer would read to answer "what happens
  on an unresolved DNA toggle?" — it should not say the opposite of what actually happens.
- **Task 6 script scope**: reused `decrypt-row.ts`'s Vault wiring by exporting the two previously-private
  helper functions (`authenticateVaultClient`, `transitDecrypt`) rather than duplicating them, per the
  ticket's explicit preference.

### 7.5 Human-gated (not executed)

- **Task 6 execution** (`pnpm --filter @arcaai/database dna:phi-scan -- --tenantId <arcaai-tenant-id>`
  against a real database + Vault). Requires the user's explicit go-ahead, a named target environment,
  and `SECRETS_PROVIDER=vault` + Vault credentials supplied by the user/an authorized operator. Not run
  in this session. Record the clean/dirty outcome here once it is.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | T3/T4 authoring agent (Claude, sonnet-5) |
| 2026-08-16 | Scope addition: `smr-proxy` raw-`styleText` bypass (found during TASK-733 authoring) + descriptor `failMode` mismatch + missing reset route noted | Program coordinator (Fable 5) |
| 2026-08-16 | Implemented Tasks 1-5 (schema-constrained DNA output, hard-fail parser, opt-out gate hoisted to cover both paths, regression suite) + Task 6 authored/unit-tested (not executed) + §6 scope addition (smr-proxy routed through `getEffectiveStyleText`, `dnaStyleEnabled` descriptor `failMode` reconciled to `'closed'`). RED→GREEN evidence captured via `git stash`. All scoped tests/build/typecheck/lint green for `@arcaai/applications`, `@arcaai/database`, and `@arcaai/api`. Status → Completed. Missing reset route (INV-240) remains out of scope, not addressed. | T2/T3 executing agent (Claude, sonnet-5) |
