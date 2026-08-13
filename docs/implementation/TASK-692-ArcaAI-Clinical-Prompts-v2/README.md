# TASK-692 — ArcaAI Clinical Prompt Corpus v2 (hardened) and v3

- **Status:** Review
- **Type:** feature (seed data)
- **Scope:** `packages/database` seed only. No schema change, no migration, no API change.

> Covers the v2 corpus (original scope) and the v3 corpus added on 2026-08-13.
> Both are seeded; **v3 is the approved/served version**. See §v3 below.

## Requirement Analysis

The ArcaAI clinical prompt library is seeded at version 1 — a byte-exact port of the
HOPE v1 SMR prompts. A v2 corpus was supplied (`DEPARTMENT_PROMPTS_v2.md`,
`PRE_SUMMARY_PROMPT_v2.md`, rationale in `PROMPT_REVIEW_FINDINGS.md`) that hardens
every prompt against a reported clinical-safety defect:

> when the transcript is thin, the model fills the note from PREVIOUS CASE NOTES
> SUMMARY, so prior-encounter content reads as what was discussed today.

Requirement: **add** v2 to the seed without removing v1.

## Current State Evaluation

`07b-arcaai-clinical-templates.ts` seeds 23 `PromptTemplate` rows for the ArcaAI
tenant (`50000000-…0001`) — 22 department × visit-type summaries + 1 tenant-wide
pre-summary — each `APPROVED` and pinned via `approvedVersionNumber` to a
`PromptVersion` snapshot, so `PromptResolutionService` serves the pinned snapshot
rather than the mutable `content` column.

The v2 corpus maps **1:1** onto those 23 (22 fenced `text` blocks + the
pre-summary document), so no new templates and no new template ID slots are
needed. `PromptVersion` is exactly the mechanism for "add a version, keep the
current one".

## Implementation Summary

| File | Change |
|---|---|
| `seed/07b-arcaai-clinical-content-v2.ts` | **New, generated.** The 23 v2 bodies, JSON-encoded. |
| `scripts/generate-arcaai-clinical-content-v2.mjs` | **New.** The generator, so the file above is reproducible rather than merely asserted to be verbatim. |
| `seed/07b-arcaai-clinical-templates.ts` | `versionId(templateId, versionNumber)`; `V2_CONTENT_BY_TEMPLATE_ID`; `ARCAAI_CLINICAL_APPROVED_VERSION = 2`; templates now carry the v2 body pinned at v2; `ARCAAI_CLINICAL_VERSIONS` emits **two** rows per template (v1 then v2). |
| `seed/00-constants.ts` | Documents the version-in-third-UUID-group convention. |
| `src/__tests__/seed.test.ts` | Version invariants updated + two new v2-specific guards. |

### Versioning model

- **v1 is retained**, byte-unchanged, both on disk (`07b-arcaai-clinical-content.ts`)
  and in the database as `versionNumber = 1` with its **original** id.
- **v2 is approved and served**: `content`, `currentVersionNumber` and
  `approvedVersionNumber` all track `ARCAAI_CLINICAL_APPROVED_VERSION`.
- **Rollback is one field** — set `ARCAAI_CLINICAL_APPROVED_VERSION = 1` (or edit
  `approvedVersionNumber` in the console). No content needs restoring.

### ID allocation

Version ids keep the `72…` mirror of the template id and carry the version
number in the **third** UUID group; the fourth stays the tenant slot.

```
template  71000000-0000-0000-0001-0000000000XX
v1        72000000-0000-0000-0001-0000000000XX   (unchanged)
v2        72000000-0000-0002-0001-0000000000XX   (fresh, collision-checked)
```

### Extraction guards (the generator aborts rather than emit a bad seed)

- exactly 22 fenced blocks, one per declared section — sections are keyed by
  their `## N)` number, not file order (the source file lists §2/§3 last);
- the `=== SOURCE-OF-TRUTH PROTOCOL ===` block is **byte-identical in all 22**
  (the corpus's own stated invariant — it is duplicated, not referenced);
- the pre-summary's markdown escapes (`{current\_department}`) are stripped and
  all nine single-brace placeholders survive, with no tenth introduced —
  a lost placeholder would ship a literal brace to the model;
- the five `## FORMAT` titles are present. They are title-matched by
  `PRE_SUMMARY_DISPLAY_TITLES` (`summary-response.mapper.ts`); renaming one
  returns an EMPTY `structured_data.sections`.

### Decisions taken with the requester

1. **v2 is served, not merely staged.** The alternative (seed v2 inert, approve
   later in the console) was offered and declined.
2. **The one mandated heading rename is applied as written**: Hematology —
   Revisit heading 2, `Primary Diagnoses & Co-morbidities` → `Primary Diagnosis /
   Co-morbidities`, per the department's own template
   (`PROMPT_REVIEW_FINDINGS.md` §5.2). This is the **only** heading changed
   anywhere in the corpus.

## Verification

```
pnpm --filter @arcaai/database test        → 48 files, 1186 tests passed
pnpm --filter @arcaai/database typecheck   → clean
cd apps/api && npx vitest run smr-compat   → 9 files, 234 tests passed
```

`pre-summary-placeholder-guard.test.ts` and `template-selection-matrix.test.ts`
pass unchanged against the v2 body — the placeholder set and every department
agent / legacy-column binding still resolve.

## Open items (carried from `PROMPT_REVIEW_FINDINGS.md`, NOT closed here)

1. **Verify the EMR section mapping for the renamed Hematology heading** before
   this is promoted past dev.
2. **Per-department output-language policy is still inconsistent** (some prompts
   say English, some say the conversation language). v2 restates each prompt's
   existing policy unambiguously but does not change it; Hematology has directly
   conflicting written evidence and should be decided first (§8.1).
3. **Deployed rows will not pick this up automatically.** `hope-v2-dev` runs with
   seeding off, so the cluster's `PromptTemplate` rows are already drifted from
   the seed; applying v2 there is a separate, deliberate data operation.
4. **No regression fixture yet** for the actual defect. The highest-value test is
   a thin-transcript fixture (rich pre-summary, unrelated two-minute
   conversation) graded on "does any pre-summary fact appear undated under a
   today-only heading" (§8.7).

---

## v3 corpus (added 2026-08-13)

A v3 corpus was supplied (`DEPARTMENT_PROMPTS_v3.md`, `PRE_SUMMARY_PROMPT_v3.md`,
`INTEGRATION_NOTES_v3.md`) with the same requirement: **add** it, keep v1 and v2.

### The finding that shaped the implementation

**The 22 v3 department bodies are byte-identical to v2.** v3's own version-history
table credits v3.0 with rewriting RULE 6 for ASR terminology repair, but that text
was already present in the v2 corpus — only the surrounding documentation prose
differs between `DEPARTMENT_PROMPTS_v2.md` and `_v3.md`. Verified by content
comparison, not by reading the changelog. The one genuinely new body is the
**pre-summary** (161 diff lines).

All 23 are still seeded at `versionNumber 3`, because the corpus ships as a
**matched set** (`INTEGRATION_NOTES_v3.md` §1): the department prompts depend on
the v3 pre-summary's `(recorded DD-MMM-YYYY)` stamp to tell history from what was
said today, so one uniform pin stops the pair being rolled back independently.
The 22 duplicate bodies are the price of that guarantee. A seed test asserts the
asymmetry (`differsFromV2` must equal exactly `[PRE_SUMMARY]`), so if a later
corpus does change the department prompts, the test fails and says so.

### What v3 actually changes (the pre-summary)

Per `INTEGRATION_NOTES_v3.md` §3.3 — rebuilt after review against a real generated
snapshot (Rheumatology, 11-Aug-2026):

| Was | Now |
|---|---|
| One date parenthesis meant both "filed on" and "measured on" — a 2025 CPK inside a 2026 note read as a 2026 result | **Provenance** `(recorded 11-Aug-2026)`, one per bullet, trailing; **event date** inline and verbatim, never reformatted |
| Same diagnosis repeated once per encounter | Each distinct diagnosis stated once |
| Already-administered interventions (`Inj Rituximab, cycle 2`) dropped — every rule was scoped to the latest note | Captured as status-post entries with their dates |
| Ordered tests appeared under both Investigations and Plan of Care | Investigations = results only |
| Normal vitals dumped raw while a 7 kg weight loss went unreported | Insignificant vitals omitted; trends use the whole supplied series |
| Steroid taper (Omnacortil 20 → 10 mg) shown as current value only | Dose changes shown against the previous dose with its date |

**Also English-only.** The `{language_name}` localization block was removed (it
instructed the model to translate `(date not stated)`, contradicting the dating
rule, and was dead code — the caller hardcodes `language: 'en'`). **The
placeholder is retained and neutralised in the prompt text**, so the
nine-variable contract with `renderPreSummaryTemplate` is unchanged — this is
why `pre-summary-placeholder-guard.test.ts` still passes untouched.

### Files

| File | Change |
|---|---|
| `seed/07b-arcaai-clinical-content-v3.ts` | **New, generated.** The 23 v3 bodies. |
| `scripts/generate-arcaai-clinical-content-v3.mjs` | **New.** Generator + extraction guards. |
| `seed/07b-arcaai-clinical-templates.ts` | `V3_CONTENT_BY_TEMPLATE_ID`; `contentFor(spec, version)` replaces `v2ContentFor`; `ARCAAI_CLINICAL_SEEDED_VERSIONS = [1,2,3]`; `ARCAAI_CLINICAL_APPROVED_VERSION = 3`; version rows now built by `flatMap` over the version list rather than one hand-written block per version. |
| `seed/00-constants.ts` | Records the `…-0003-0001-…` version-id block. |
| `src/__tests__/seed.test.ts` | Version invariants generalised to three versions; Block A and pre-summary contract tests run per-version via `it.each`; two new v3 guards (annotated ASR repair on all 22; provenance-vs-event dating in the pre-summary). |

Version ids follow the established convention — v3 is `72000000-0000-0003-0001-…`,
a fresh collision-free block; v1 and v2 ids are byte-unchanged.

### v3 extraction guards (added on top of the v2 set)

- the `(transcribed as "…")` ASR-repair annotation form is present in all 22
  department bodies — it is the entire safety argument for permitting repair at
  all (`INTEGRATION_NOTES_v3.md` §3.2), and must not be stripped downstream;
- the pre-summary teaches both dating kinds (`Provenance date`, `Event date`,
  `(recorded `) — the v3 fix would be silently absent otherwise.

### v3 verification

```
pnpm --filter @arcaai/database test        → 48 files, 1190 tests passed
pnpm --filter @arcaai/database typecheck   → clean
cd apps/api && npx vitest run smr-compat   → 9 files, 234 tests passed
```

`packages/database` has no `lint` script, so no lint gate applies to it.

### v3 open items

1. **Rollback is `ARCAAI_CLINICAL_APPROVED_VERSION = 2`** (or an
   `approvedVersionNumber` edit in the console). No content needs restoring.
2. **The three integration gaps in `INTEGRATION_NOTES_v3.md` §4 are NOT closed
   here** and limit what the new pre-summary rules can do — `{formatted_test_results}`
   is never sent, `formatted_vitals` appears to always render empty (so the
   vitals-trend rules cannot fire), and `safe_age` is not sent. All three are
   caller-side (`department-pre-summary-job.service.ts`), outside this seed.
3. Carried forward unchanged from the v2 open items above: the Hematology EMR
   section mapping, the per-department output-language decision, the deployed-row
   drift on `hope-v2-dev` (seeding is off there — applying v3 is a separate
   deliberate data operation), and the missing thin-transcript regression fixture.

## Change History

| Date | Change |
|---|---|
| 2026-08-13 | Initial implementation — v2 corpus seeded as `versionNumber 2` across all 23 ArcaAI clinical templates; v1 retained. |
| 2026-08-13 | v3 corpus seeded as `versionNumber 3` and approved; v1 and v2 retained. Department bodies found byte-identical to v2 — only the pre-summary changed; versioned uniformly anyway because the corpus is a matched set, with a test asserting the asymmetry. |
| 2026-08-13 | Stripped the author-only `FILE METADATA — DO NOT PASTE INTO HOPE` HTML comment from the seeded v3 pre-summary body. The comment lived at the top of `PRE_SUMMARY_PROMPT_v3.md` and was ingested because the generator copied the whole document. The 22 department prompts were already fence-extracted and never contained it. Both generators now strip the comment (and abort if it leaks) so regeneration cannot put it back. |
