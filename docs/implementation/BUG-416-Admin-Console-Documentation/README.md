# BUG-416 — VOX Admin Console documentation

- **Status:** Pending
- **Type:** docs
- **Source:** https://github.com/ArcaAI/ALaaSv3.0/issues/416 (dohuta, 2026-05-06; body: "create documents for VOX Admin Console", assigned @arca-sumankumar)
- **Severity:** Low
- **Verdict:** partially satisfied; gap analysis and doc plan below

## Requirement Analysis

Produce documentation for the Admin Console. The issue gives no audience or scope; assume operators (super admin), tenant admins and developers.

## Current State Evaluation

Existing:
- `docs/guides/tenant-admin-user-guide.md` — click-paths for tenant admins (departments, clinicians, consent, schema, agents, API keys).
- `apps/admin-console/README.md` — developer layout, commands, route inventory (counts, e.g. "56 feature-domain directories", "57 nav entries" go stale).
- `docs/architecture/admin-console-capabilities-matrix.md` — 2026-07-04 capability snapshot (historical).
- `apps/admin-console/src/shared/docs/*` — in-app developer docs (run guide, SSE/STT protocols, SDK snippets, Postman).
- `docs/guides/consultation-session-lifecycle.md`, `docs/consultation-context-schema-integration-guide.md`, `docs/operations/*`.
Missing: a super-admin/platform operator guide (tenants, providers, models, settings/feature matrix, runs, promotion, residency, storage browser), a Playground user guide (consultation scribe, live transcription, voice profiles, DNA style, LLM), impersonation/working-tenant procedures, screen-by-screen reference tied to `nav-config.ts`, and a troubleshooting/error glossary.

## Root Cause

n/a (documentation gap). The audience split (platform vs tenant vs developer) is the main structural gap.

## Implementation Plan

1. Owner confirms audience and format (markdown under `docs/guides/` vs in-app help).
2. Add `docs/guides/platform-admin-console-guide.md` and `docs/guides/playground-user-guide.md`; link from `docs/README.md` and the user guide; refresh README counts from `nav-config.ts` (script-checked to avoid drift).
3. Screenshots via the `next-dev-loop`/browser against a seeded dev stack; store under `docs/guides/images/`.
4. Verification: every route in `nav-config.ts` appears in the reference table (small test or script); links resolve; read-through by a non-author.

## Risks / Open Questions

- OD: audience, language, screenshots policy (PHI-free seed only).
- Ownership: issue assigned to an external member; confirm who authors.

## Implementation Summary

Not started.

## Change History

| Date | Change |
|---|---|
| 2026-10-06 | Ticket created (read-and-document lane; no code changed). |
