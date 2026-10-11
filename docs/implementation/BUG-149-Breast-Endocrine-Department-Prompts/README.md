# BUG-149 — Breast & Endocrine department prompt templates (New/Referral + Follow-up) with DNA overlay

| Field | Value |
|---|---|
| Status | Pending |
| Type | feature (filed as bug) — verification / closure |
| Source | https://github.com/ArcaAI/ALaaSv3.0/issues/149 (OPEN, 2025-08-06; labels bug, ALaaS) |
| Severity | Low (largely delivered; residual = DNA department fallback + one ALaaS UI comment) |
| Proposed verdict | Fixed in hope-v2 for the template; residual gap in DNA overlay; clipboard comment belongs to ALaaS web_ui |

## 1. Requirement Analysis
The issue asks for (1) two Breast & Endocrine prompts (new/referral, follow-up) merging breast/thyroid/parathyroid fields; (2) wiring so the summariser uses them for the department; (3) DNA style overlay via `style_DNA_doctor_department_breast_endocrine_as` (doctor to department to default); (4) console logging of each summary; (5) tests for existence/headers/selection. A first comment (Neena) reports that the AI summary pasted from the AI Feedback panel loses rich text and shows raw markdown.
Original design is stale: it assumes `docs/*.md` prompt files and code-side "if department ===" selection in ALaaS. In HOPE, prompts are tenant CONTENT cloned from SYSTEM seeds; department selection is data (`Department.newPatientPromptId/revisitPromptId`) plus the workflow `n_visit` branch on `trigger.context.visit_type`.

## 2. Current State Evaluation
- Department row: `packages/database/src/prisma/db_main/seed/04-department.ts:356-363` (`Breast & Endocrine`, code BREN, `newPatientPromptId`=BREAST_ENDOCRINE_NEW_REFERRAL, `revisitPromptId`=BREAST_ENDOCRINE_FOLLOWUP).
- Template ids: `seed/07b-arcaai-clinical-templates.ts:173-174`; bodies V1/V2/V3 imported at :63-64, :88-89, :113-114; current V3 body in `seed/07b-arcaai-clinical-content-v3.ts`; document-template library entry `seed/27-document-template-library.ts:847-848`.
- Fidelity guard: `packages/database/src/__tests__/v1-clinical-prompt-fidelity.test.ts` + `v1-clinical-prompt-checksums.fixture.ts`; dept-template seed test `seed/__tests__/arcaai-department-document-templates.task932.test.ts`.
- Visit-type selection / fallback: workflow graphs branch `n_visit` per department (`seed/28-workflow-library.ts`; TASK-1020 README section 2.2). Selection is data-driven, so the issue item 4 (wire code) is obsolete.
- DNA overlay: the generic `dna_style_text` variable is assembled in `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts:86,631-675` and appended with DNA_STYLE_GUIDANCE when the body has no explicit slot. The BREN V3 body has NO named `style_DNA_*` slot (only dermatology, dietetics, nephrology, surgical_oncology do), so the generic path applies. No per-department DNA exists: `packages/applications/src/services/dna-writing-style/` has no `departmentId` usage (doctor-scoped only; weekly regen/ingest per TASK-1034).
- Logging: summary console logging is obsolete; PHI-redacting logging via `LoggingService` is the standard (rule 05).
- Clipboard/markdown comment: AI Feedback panel is ALaaS `apps/web_ui`, not in this repo. SDK exposes `stripCitationLabels` only (08-vox-sdk rule), no markdown-to-plain helper.

## 3. Root Cause / Gap
1. Template: delivered (seeded, tested). Verify live content parity against the issue body (the V3 bodies were rewritten by TASK-932/947/1001; owner clinical sign-off for BREN not located in docs/implementation).
2. DNA doctor to department to default fallback is not implemented; only per-doctor DNA exists (shared gap with #170, #192, #197).
3. Clipboard formatting: out of repo (ALaaS web_ui) unless an SDK helper is wanted.

## 4. Implementation Plan (only if owner wants the residuals)
1. Tests first: seed test asserting BREN new/revisit bodies contain required headings from the issue (Risk Factors, Personal & Reproductive History, thyroid/parathyroid fields) — note V3 wording may differ; decide expected list with clinician.
2. DNA department fallback: see BUG-192 plan (single shared work item); do NOT build per-ticket.
3. Clipboard: ALaaS-side change (render HTML / copy as text/html + text/plain); if shared SDK helper wanted, add `markdownToPlainText` to `@arcaai/vox` core with unit tests.
Verification: `pnpm --filter @arcaai/database test` (seed tests); manual BREN consultation both visit types.

## 5. Risks / Open Questions
- OD-1: Close as delivered, or keep open for clinical re-review of the V3 BREN text?
- OD-2: Is department-level DNA wanted (see BUG-192)?
- OD-3: Hand the clipboard comment to ALaaS web_ui owner?
- No model load/change needed for any of this.

## 6. Implementation Summary
Not started.

## 7. Change History
| Date | Change |
|---|---|
| 2026-10-06 | Created from https://github.com/ArcaAI/ALaaSv3.0/issues/149 after read-only review of dev-2.2 |
