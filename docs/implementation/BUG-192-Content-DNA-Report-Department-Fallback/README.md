# BUG-192 — Writing Style Content DNA report: department-level fallback, EMR note source, recommendations

| Field | Value |
|---|---|
| Status | Pending |
| Type | feature (enhancement) |
| Source | https://github.com/ArcaAI/ALaaSv3.0/issues/192 (OPEN, 2025-09-16; enhancement, ALaaS; comment: align with #117) |
| Severity | Medium (partially delivered; department fallback missing) |
| Proposed verdict | Partially fixed (TASK-974/991/1034); department tier + Behive connector + completeness feedback open |

## 1. Requirement Analysis
Per-doctor Content DNA report (fallback department then default when insufficient notes), template integration without dropping mandatory fields, periodic regeneration, doctor feedback on missing sections, Behive `/getClinicalNotesAndSummaries` connector (departmentId, doctorId, encounterDates[]), audit logging, fallback to the standard department template.

## 2. Current State Evaluation
- Per-doctor generation/ingest: `packages/applications/src/services/dna-writing-style/` (`dna-writing-style.processor.ts`, ingest, `dna-regeneration.scheduler.ts`); SDK `hope.dnaWritingStyle.ingest` (TASK-974); weekly feedback-gated regen + tenant-admin ingest + style/rules in prompt (TASK-1034, Review); seeds `seed/08-dna-writing-style.ts`; platform analyst agent `dna-writing-style-analyst` (00-project-context, D-1).
- Ingest replaces the Behive pull: caller pushes items (`text, writtenAt, kind, sourceRef`) — there is no Behive connector in HOPE (EMR integration lives in ALaaS).
- Prompt use: `prompt-assembly.service.ts:86,631-735` (`dna_style_text`, `styleReference`, redaction rules); doctor-resolved only.
- Department tier: no `departmentId` in dna-writing-style service files (grep) — no department-level report, no doctor to department fallback. Missing-section audit/recommendations: not found.
- Fallback to standard template: DNA absence leaves the department template unchanged (variable simply absent).

## 3. Root Cause / Gap
1. No department-level DNA aggregate or fallback tier. 2. No completeness/recommendation output. 3. Behive connector belongs to ALaaS/EMR side (push via ingest). 4. "Minimum notes X" threshold: verify whether the processor enforces one.

## 4. Implementation Plan
Needs OD decisions first (storage: department-scoped report row vs aggregate at resolve time; PHI/tenancy: department DNA must be tenant-scoped, cascade tenant then SYSTEM is NOT applicable — it is content/clinician data).
1. Tests: resolver returns doctor report, else department report, else null (domain/application unit tests).
2. Schema/Prisma only if a department-scoped row is chosen (rule 02 migration flow, rule 03 trio, ResourceType enum).
3. Application: resolver in the DNA service; consult in `prompt-assembly` path that supplies `dnaStyleId`.
4. Optional: completeness metrics in report JSON.
Verification: touched test files only, then `pnpm --filter @arcaai/applications build`.

## 5. Risks / Open Questions
- OD-1: Is department DNA in scope for this release? OD-2: threshold X? OD-3: privacy review — aggregating several doctors' notes into one style profile. Related: BUG-149, BUG-170, BUG-197 depend on this tier.

## 6. Implementation Summary
Not started.

## 7. Change History
| Date | Change |
|---|---|
| 2026-10-06 | Created from https://github.com/ArcaAI/ALaaSv3.0/issues/192 |
