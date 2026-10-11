# BUG-413 — DNA Writing Style / DNA Report tab: report not editable, no scroll, invisible focus

- **Status:** Pending
- **Type:** bugfix (scroll, focus) + change request (edit)
- **Source:** https://github.com/ArcaAI/ALaaSv3.0/issues/413 (NeenaPanicker, 2026-04-08; 1 screenshot)
- **Severity:** Medium
- **Verdict:** edit — fixed; scroll/focus — likely fixed, needs a browser pass

## Requirement Analysis

(a) Admin DNA Report profile is non-editable. (b) Pasting ~1143 words into Writing Samples leaves the page unscrollable so "Generate DNA" is unreachable. (c) Tab focus moves with no visible indicator.

## Current State Evaluation

- (a) Editable now, both planes: admin `features/dna-writing-styles/components/doctor-detail.tsx:84 ReportEditor` (Edit button :275, OCC with ETag) and playground `features/playground-dna-style/components/my-style-card.tsx:32 StyleEditor` (Edit :193, "Edit reason" field :76, PATCH with If-Match via `api/client.ts:51`). Edit requires an ETag (`disabled={!etag}`) and is hidden while a report is absent; a tenant admin still hits the `assertActingAsDoctor` gate on generate (frame 53, `impersonation-gate-panel.tsx`) — that is by design and may be the reporter's "non-editable" experience in the old build.
- (b) Screen is `ScreenTemplate` in scroll mode (`my-dna-style-screen.tsx:103`), the console owns an inner scroll region; the ingest textarea uses `field-sizing-content` (`packages/ui/.../textarea.tsx:10`) so it grows with content inside that scroll container. The new ingest pane (`ingest-pane.tsx:138`) and `generate-pane.tsx:109` follow the same frame. Not reproduced.
- (c) Shared primitives define `focus-visible:ring-[3px]` (button.tsx:8, textarea.tsx:10) — so the old build's missing indicator is not a current defect for stock controls. Unverified for custom clickables on these screens.

## Root Cause

Obsolete/fixed by the console rebuild (new screens, ScreenTemplate, shared focus tokens). The edit capability exists in both screens (ticket of origin not identified).

## Implementation Plan (verification-only unless the browser pass fails)

1. Add/confirm a Playwright spec: paste 1200 words into the samples textarea at 1280x720, assert the Generate button becomes reachable (scrollIntoView or visible) and Tab to it shows a computed focus ring (outline/box-shadow non-none); axe scan 0 violations, both themes.
2. If it fails, fix the offending container (`min-h-0`/`overflow-y-auto` per rule 11 §1) and add `scroll-mt-*` for sticky regions (WCAG 2.4.11).
Verification commands: `pnpm --filter @arcaai/admin-console test`, `pnpm admin:typecheck`, `pnpm admin:lint`, then a manual headed pass (`next-dev-loop` skill) in both themes. Per the owner rule, a lane runs only its own new/changed test files; the orchestrator gates after merge.

## Risks / Open Questions

- OD: should a tenant admin without a doctor persona be able to edit another doctor's report (admin grid) — permissions are ability-gated today; confirm intent.
- Reporter's build/date unknown; ask them to retest on the current console.

## Implementation Summary

Not started.

## Change History

| Date | Change |
|---|---|
| 2026-10-06 | Ticket created (read-and-document lane; no code changed). |
