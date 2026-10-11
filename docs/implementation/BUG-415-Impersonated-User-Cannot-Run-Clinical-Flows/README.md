# BUG-415 — Impersonated (new) user cannot start consultations or live transcription

- **Status:** Pending
- **Type:** bugfix
- **Source:** https://github.com/ArcaAI/ALaaSv3.0/issues/415 (NeenaPanicker, 2026-05-04; 3 screenshots, no text of the errors)
- **Severity:** High (blocks the QA persona flow)
- **Verdict:** open/unconfirmed; probable prerequisite gaps on a freshly created user, partly mitigated

## Requirement Analysis

After creating a user in Tenants/Users and choosing Start Impersonation, consultations and live transcription are "restricted or non-functional".

## Current State Evaluation

- Impersonation BFF: `app/api/auth/impersonate/route.ts:34-110` — super admin → `POST admin/users/:id/impersonate` (time-boxed), tenant admin → `auth/impersonate`; the minted token replaces the bearer (`hope-proxy.ts:76`). Token is non-refreshable (see BUG-412 residual): when it expires the proxy silently reverts to the admin identity (`hope-proxy.ts:160-167`), after which clinical routes fail for the admin — plausibly what the reporter saw mid-session.
- A newly created user has no clinical prerequisites: no department membership (the scribe department catalog was an ADMIN read that 403'd under impersonation and was moved to clinician-plane `users/me/departments` — commit b137cac48; `consultations-column.tsx` now explains empty/unreadable states), no role granting consultation abilities unless assigned, no consent, no `staffId` (TASK-950 find-or-provision), and no ASR agent assignment (`AGENT_NOT_ASSIGNED`, rule 00 content-cloned; stt session needs `agentSource`, TASK-1002).
- Console gating: `playground-persona-bar`/`ImpersonationBanner` are display only; DNA has its gate panel, consultation does not name the missing prerequisite beyond the department case.
- Screenshots show no readable error text here; cannot map to a specific 403/409 by reading.

## Root Cause

Not determined. Ranked hypotheses: (1) target user lacks role/department/agent assignment or consent so the first clinical call 403/409s; (2) impersonation token expiry/revert; (3) pre-b137cac48 build 403 on admin department read.

## Implementation Plan

1. Reproduce on the current build with a fresh doctor user (one live pass, orchestrator only; no model load): create user with a doctor role and department, impersonate, open consultation, start live transcription; record the first failing request.
2. RED tests per finding, e.g. consultation screen shows a named blocker (`EnrollmentBlockedCard`-style) for missing role/consent/agent; proxy test for the expiry revert (shared with BUG-412).
3. Optionally: user-creation flow offers "ready for clinical use" checklist (role, department, consent).
Verification commands: `pnpm --filter @arcaai/admin-console test`, `pnpm admin:typecheck`, `pnpm admin:lint`, then a manual headed pass (`next-dev-loop` skill) in both themes. Per the owner rule, a lane runs only its own new/changed test files; the orchestrator gates after merge.

## Risks / Open Questions

- OD: should creating a user via the console seed a default clinical role/department? (tenant policy)
- Depends on BUG-412 decision for the expiry behaviour.

## Implementation Summary

Not started.

## Change History

| Date | Change |
|---|---|
| 2026-10-06 | Ticket created (read-and-document lane; no code changed). |
