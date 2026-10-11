# BUG-017 — Vox/ALaaS UI: unexpected "attached to existing consultation" / "clinician account provisioned" banners

- **Status:** Completed (fix in the ALaaS repo, commit f5f9ee6; verified live 2026-10-10; no hope-v2 change)
- **Type:** bugfix (UI, lives in a sibling repo)
- **Source:** https://github.com/ArcaAI/project-hope/issues/17 (NeenaPanicker, 2026-09-29; no labels)
- **Severity:** Low

## Requirement Analysis

Two notices appear above the transcription pane with no obvious trigger: "This recording was attached to an existing consultation from earlier today." and "A new clinician account was provisioned in HOPE for this consultation." Reporter wants to know whether they are correctly triggered, and mentions dismissibility. Screenshot: https://github.com/user-attachments/assets/fffbf442-4041-4378-9b77-976471a34e91 . Steps: open a recording or active consultation in the Vox UI.

## Current State Evaluation

- Neither string exists in `hope-v2` (`grep` over apps/ packages/ returns nothing). They are rendered by the ALaaS web UI, sibling repo `/Users/taphuynh/Desktop/igglo/ARCAAI/ALaaSv3.0`, `apps/web_ui/hooks/useClinicalLogic.js:1033-1052` (`identityNotices`), fed by `consultationState.identity` (`apps/web_ui/src/reducer/session.js:45`, shape `{ clinicianUserId, provisioned, departmentId, workflowSlug, visitType, reattached }`).
- Those flags are legitimate HOPE open-time markers: `provisioned` when `UserIdentityService.resolveOrProvision` created a clinician (`packages/applications/src/services/consultation/consultation/consultation.service.ts:836`, TASK-950/951), `reattached` when same-day open joined an existing consultation (TASK-1020, one consultation per visit keyed by externalRef). So the banners were correctly triggered by backend facts; the defect is presentation.
- Already fixed: ALaaS commit `f5f9ee6` (2026-09-29, "drop the provisioned banner, make identity notices dismissible (project-hope#17)"), on branch `refactor-hope-integaration` (also contained by `task-1045/e2e-broker*`). It removes the provisioned banner (now `logger.info` only, `useClinicalLogic.js:1043-1048`) and makes the remaining reattached notice dismissible (`apps/web_ui/components/ConversationPanel.jsx`). I did not verify whether that branch is pushed/merged.
- No change is needed in hope-v2 code. The consultation open response already carries the markers (`open-markers.ts`).

## Root Cause

The ALaaS UI surfaced every open-time identity marker as a banner (including an admin-only provisioning fact the clinician cannot act on) and gave no way to dismiss them. Confidence: high.

## Implementation Plan

hope-v2 work: none beyond closing/redirecting the issue. Process steps:
1. Owner confirms ALaaS `f5f9ee6` is pushed/merged to the branch the reporter's environment runs; then close #17 referencing it.
2. Optional RED tests in ALaaS (outside this repo, lane must use its own checkout): reattached notice renders and can be dismissed; provisioned produces no banner.
3. Optional hope-v2 follow-up: document in `docs/operations` that `identity.provisioned`/`reattached` are consumer-display hints (no API change).

Verification: in ALaaS, the web_ui's own test command for `ConversationPanel`/`useClinicalLogic`; then open a same-day consultation and a first-time clinician in the Vox UI.

## Risks / Open Questions for the owner

- Is the "reattached" notice still wanted as a banner (TASK-1020 return-visit chip may supersede it)? The reporter called both unexplained.
- Which environment/branch is the reporter on (the fix is not in hope-v2)?

## Implementation Summary

Fixed in ArcaAI/ALaaSv3.0 `f5f9ee6` (branch `refactor-hope-integaration`, 2026-09-29): `apps/web_ui/hooks/useClinicalLogic.js` logs `identity.provisioned` instead of showing a banner; `apps/web_ui/components/ConversationPanel.jsx` adds a per-notice dismiss (×). No hope-v2 change.

Live verification 2026-10-10 (ALaaS web_ui + audio-stream-svc at `185a093` → local HOPE `dev-2.2`, dev DB reset + reseeded, whisper.cpp ASR):
- Start #1, unmapped consultant 234 → HOPE provisioned `auto_5860ffd6359c0a14`, consultation `01a12663-69ea-…` → no provisioning banner.
- Start #2, same patient same day → same consultation, encounter 2 → "attached to an existing consultation" notice shown, no provisioning banner; × dismissed it and it stayed dismissed while transcripts streamed.
- Verification comment posted: https://github.com/ArcaAI/project-hope/issues/17#issuecomment-6099037507
- Seen in passing, out of scope: `closeStreamSession` 404 after stop (BUG-036), and the note run failed `NOTE_GENERATION_FAILED` (`execute_note_plan`) while the consultation continued (BUG-041 pattern).

## Change History

- 2026-10-06 — Ticket created from GitHub issue #17 (read-only investigation).
- 2026-10-10 — Verified live end to end and comment posted on the GitHub issue; status Completed.
