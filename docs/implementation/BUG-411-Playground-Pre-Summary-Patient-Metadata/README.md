# BUG-411 — Playground Pre-summary tab: patient metadata, filtering, vitals/lab items

- **Status:** Pending
- **Type:** feature (change request)
- **Source:** https://github.com/ArcaAI/ALaaSv3.0/issues/411 (NeenaPanicker, 2026-03-31)
- **Severity:** Low-Medium
- **Verdict:** largely obsolete / fixed by redesign; one residual open point

## Requirement Analysis

(1) Pre-summary tab pulled ALL case notes/transcripts into a global list with no patient, date or source attribution; asked for a patient filter and per-item metadata (date, patient, live vs manual). (2) Support Latest Vitals, Lab Results and custom Header/Content items injected into the pre-summary prompt.

## Current State Evaluation

- The Pre-summary "tab" is gone. Pre-summary is a per-consultation output (`case-note-column.tsx:388` `PreSummaryPanel`, stream hook tested in `api/__tests__/pre-summary-stream.task932.test.ts`, TASK-932 "pre-summary panel", commit 6d10facf0). It is scoped to ONE consultation, so cross-patient contamination (the core complaint) cannot occur by construction.
- Patient scoping exists in the left column: `scribe/consultations-column.tsx` — patient-id input with a datalist of the clinician's own history (~line 380), department scope, and per-visit chaining keyed by externalRef (TASK-1020, one consultation per visit; prior record is selectable, TASK-932 "prior record").
- Vitals are deterministically extracted live (`api/types.ts:189 LiveSummaryVitals`, accumulated into the live summary at :217) and schema-driven vitals/prior notes come from the tenant ConsultationContextSchema (TASK-951/981/982; presets in `@arcaai/types`). Known gap from memory TASK-981: "D1 vitals/prior notes never reach prompt variables" — verify whether it was fixed in TASK-982 before claiming (not confirmed here).
- Free "Custom item (Header+Content)": not present; same gap as BUG-410 item 4.

## Root Cause

Obsolete: the global-list design was removed. Residual: custom Header/Content context items (shared with BUG-410) and verification that schema vitals reach the pre-summary prompt.

## Implementation Plan

Recommend closing as superseded; fold the custom-item request into BUG-410. If kept: RED test that a pre-summary run for patient A never lists patient B's notes (existing consultation-scoped tests likely cover it — add one assertion), plus a live check of vitals in prompt capture (recipe in TASK-981 memory note).
Verification commands: `pnpm --filter @arcaai/admin-console test`, `pnpm admin:typecheck`, `pnpm admin:lint`, then a manual headed pass (`next-dev-loop` skill) in both themes. Per the owner rule, a lane runs only its own new/changed test files; the orchestrator gates after merge.

## Risks / Open Questions

- OD: close as obsolete? Is date-wise selection of prior notes still wanted (prior-record picker exists for one record only)?
- Needs a live prompt capture to settle the vitals question; code reading is not conclusive.

## Implementation Summary

Not started.

## Change History

| Date | Change |
|---|---|
| 2026-10-06 | Ticket created (read-and-document lane; no code changed). |
