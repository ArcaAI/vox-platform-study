# BUG-398: Pre-Summary Vitals Come From Case-Note Text, Not From The Latest Two Structured Encounters

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | bugfix + small contract change (data plane and prompt precedence) |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/398 (ArcaAI/ALaaSv3.0) |
| **Severity** | High (stale vitals shown as current; clinical risk) |
| **Classification** | Mixed: contract gap (code/seed schema: only ONE vitals set) + prompt precedence (config) |
| **Still applicable on dev-2.2?** | Yes, partially. Structured client vitals exist and outrank NLP-extracted vitals, but the contract holds one observation set, not "the latest two encounters", and the pre-summary prompt has no rule preferring them over vitals written in note text. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

The pre-summary shows vitals pulled from unstructured historical case-note text. Expected: vitals are fetched from the latest TWO structured encounters, because structured encounter data is the source of truth for physiological parameters and note text can be stale.

## 2. Current State Evaluation

- **Structured vitals exist, but as a single set.** The tenant schema kind `vitals` is `STRUCTURED`, `cardinality: 'ONE'`, `lifecycle: 'PRE'`, `producedBy: ['CLIENT']`, one flat object with `recordedAt` (`packages/database/src/prisma/db_main/seed/07g-arcaai-two-schemas.ts:233-258`). There is no array of dated encounters, so "latest two" cannot be expressed by a client today.
- **Rendering.** `formatClientVitalsForPrompt` renders that one object as one line (`packages/applications/src/services/consultation/context/client-clinical-context.ts:161-184`); the reader takes the newest item of the kind (`:393`, `findLatestByKindKey`). The pre-summary processor passes it as `vitals: client.vitals` (`jobs/processors/pre-summary.processor.ts:216`) and the variable defaults to the literal `'Not available'` (`prompt/pre-summary-variables.ts:132`).
- **Precedence is implemented only for NLP vs structured.** Client-measured vitals outrank vitals extracted from speech (`client-clinical-context.ts:150-156`, `live-documentation.service.ts:4913`). Nothing orders structured vitals against vitals that appear inside `previous_case_notes` text.
- **Prompt.** `PRE_SUMMARY_CONTENT_V3` (`07b-arcaai-clinical-content-v3.ts:152`) declares `Recent Vitals: {{context.safe_vitals}} (the dated vitals supplied for this patient - use every value given, not only the latest two)` and lists all three sources as admissible with no precedence. If the client sent no `vitals` kind, `safe_vitals` is `Not available`, and the model, which is allowed to use any supplied record, lifts vitals from the notes. That is the reported behaviour. The v1 seed template (`07-prompt-template.ts:424`) says "(two most recent encounters)" while nothing supplies two.
- Mismatch between the two prompts is itself a defect: one says latest two, the other says every value.

## 3. Root Cause

(1) Contract: HOPE models vitals as one observation set (ONE), so a client that holds two or more structured encounters has nowhere to put them. (2) Prompt: no precedence rule says structured vitals win over vitals mentioned in note text, and the "no data" default is a placeholder string rather than an instruction not to fall back to text.

## 4. Implementation Plan (needs owner decisions, see section 5)

1. **Tests first** (`client-clinical-context.test.ts`, `pre-summary-variables.test.ts`, prompt-assembly test):
   - the reader renders N dated vitals sets (latest first, capped at two) when the kind holds a list;
   - an absent structured payload leaves `safe_vitals` empty rather than `Not available` for the dept-free pre-summary variant;
   - assembled prompt contains the precedence sentence.
2. **Contract:** extend the `vitals` kind to accept either the existing object or `{ encounters: [{ recordedAt, ... }] }` (back-compatible; `cardinality` stays ONE). Update `ClientVitalsPayload`, `vitalsListOf` (`consultation-read-model.assembler.ts:271`), the JSON Schema in `07g-arcaai-two-schemas.ts`, and regenerate the seed blobs/OpenAPI/portal/vox-node artifacts per the five-artifact rule if routes/DTOs change.
3. **Renderer:** `formatClientVitalsForPrompt` accepts the list, emits one dated line per encounter, newest first, max two.
4. **Prompt (config):** in the v3 pre-summary add a SOURCE RULE: "Vitals come only from the structured `Recent Vitals` block. Do not extract vitals from Previous Visits text; if the block is empty, omit vitals." Align the v1 seed template wording. Republish the agents (content is cloned per tenant).
5. Verification: only the touched test files; then a replay of one pre-summary with captured prompt.

## 5. Risks and Open Questions

- OD-1 (owner): extend `vitals` to a list, or add a second kind (`vitals_previous`)? Recommended: list on the existing kind.
- OD-2 (owner): strict exclusion of vitals from note text, or fall back to text only when no structured vitals were sent? The issue asks for strict structured priority; a fallback reintroduces stale values.
- OD-3: what does ALaaS send today? Needs an ALaaS-side change to supply two encounters; ALaaS contract change belongs to the ALaaS repo.
- Risk: golden fixtures for the frozen v1 prompt surface; tenant content republish required (cloned content never re-reads SYSTEM).
- Risk: PHI class stays PHI; no logging of values.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0 #398 (read-and-document lane); no code changed. |
