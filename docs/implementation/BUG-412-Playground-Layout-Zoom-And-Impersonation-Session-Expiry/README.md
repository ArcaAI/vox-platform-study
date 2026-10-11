# BUG-412 — Playground layout breaks on zoom/resize; "Session Expired" during impersonation without logout

- **Status:** Pending
- **Type:** bugfix
- **Source:** https://github.com/ArcaAI/ALaaSv3.0/issues/412 (NeenaPanicker, 2026-03-31; 2 screenshots)
- **Severity:** Medium (part 1), High (part 2 as originally filed)
- **Verdict:** part 2 fixed (with a residual risk); part 1 open/unverified

## Requirement Analysis

1. Playground UI overlaps (buttons, textareas, cards escape containers) at 125-150% zoom or a narrow window.
2. During Impersonation a "Session Expired" message appears but the user is not hard-logged-out.

## Current State Evaluation

**Part 2.** Fixed by TASK-988 (commits abdb9d364, 070adbf42, 069b46599, c3c4c7f11): the BFF stamps its own 401s with `x-session-expired` (`apps/admin-console/src/server/hope-proxy.ts:57-66`) and the client calls `redirectToLogin()` (`shared/auth/session-expiry.ts:37-52`, `reportUnauthorized` :60) plus a refresh heartbeat (`shared/auth/hooks.ts:68-78`), as a full document navigation that drops all caches.

**Residual (new finding).** Impersonation tokens are non-refreshable. On a 401 while impersonating, `hope-proxy.ts:160-167` silently swaps the session back to the ORIGINAL admin (`impersonation: undefined`) and RETRIES the request as that admin (:174). The user is neither told the act-as expired nor logged out; subsequent calls run as the admin (clinical routes 403, DNA `assertActingAsDoctor` gate, writes attributed to the admin). The banner (`shared/layout/session-banners`) only updates when the session query refetches. Not confirmed at runtime.

**Part 1.** The console shell is inner-scroll (rule 11 §1) and the consultation screen is a ResizablePanelGroup with `min-w-0` panels (`consultation-demo-screen.tsx:758-817`, minSize 16/22/22 %) — at 150% zoom on a 1366px window the 3 columns get ~900 CSS px, so min panel sizes plus fixed children (e.g. the `grid-cols-[1fr_2px_1.6fr_2px_1.6fr]` skeleton at :133, toolbars in `consultations-column.tsx`) can overflow. The old ArcaVox playground the screenshot shows no longer exists, so the exact overlap is unreproducible by reading alone.

## Root Cause

Part 1: fixed three-column desktop layout lacking a narrow/zoom fallback (likely; needs a viewport pass). Part 2: original cause fixed; the impersonation 401 path now degrades silently.

## Implementation Plan

1. RED: `server/__tests__/hope-proxy*.test.ts` — impersonation 401 ⇒ response carries a header (e.g. `x-impersonation-ended`) or the retry is NOT replayed for non-idempotent methods; client test that the banner clears and a toast explains.
2. Proxy: on impersonation 401, end the impersonation, do not replay writes under the admin identity, signal the client (`session-expiry.ts` handler → refetch session + `toast.warning`).
3. Layout: Playwright viewport matrix (1280/1024/768 at DSF 1.25/1.5) on `/playground/*` with axe + overflow assertion (`scrollWidth <= clientWidth`); fix with container queries and a stacked/tabbed fallback below ~1100px (skills `responsive-web-design`, rule 07).
4. Verify both themes; WCAG 1.4.10 reflow at 320px/400% zoom.
Verification commands: `pnpm --filter @arcaai/admin-console test`, `pnpm admin:typecheck`, `pnpm admin:lint`, then a manual headed pass (`next-dev-loop` skill) in both themes. Per the owner rule, a lane runs only its own new/changed test files; the orchestrator gates after merge.

## Risks / Open Questions

- OD: on impersonation expiry, retry as admin (today) or stop and prompt? Recommend never replaying a mutation under a different identity.
- OD: acceptable minimum supported width for the three-column scribe (stack vs tabs)?

## Implementation Summary

Not started.

## Change History

| Date | Change |
|---|---|
| 2026-10-06 | Ticket created (read-and-document lane; no code changed). |
