# BUG-218 — Encode and sanitize all input data (UTF-8, encodeURIComponent, DOMPurify)

| Field | Value |
|---|---|
| Status | Pending |
| Type | security hardening |
| Source | https://github.com/ArcaAI/ALaaSv3.0/issues/218 (OPEN, 2025-11-17; enhancement, ReactJS, ALaaS) |
| Severity | Low-Medium (generic checklist; web_ui is ALaaS ReactJS, not this repo) |
| Proposed verdict | Mostly ALaaS-side; verify SDK/console surfaces; no DOMPurify dependency here |

## 1. Requirement Analysis
Generic hardening: UTF-8 everywhere, `encodeURIComponent` for URL/query params, DOMPurify when rendering user HTML.

## 2. Current State Evaluation
- Server: global ValidationPipe with whitelist + forbidNonWhitelisted (rule 05; `apps/api/src/main.ts`), class-validator DTOs on every field — input validation covered; SQL via Prisma.
- SDK URL building: `encodeURIComponent` used in `packages/agentic-sdk-v2/src/core/ConsultationSchemaClient.ts`, `SharedConnectionManager.ts`, `SttWebSocketClient.ts`, `SSEClient.ts`, `constants.ts`; `contextPayloadValidation.ts` validates context payloads. Completeness across every call site is not audited.
- HTML rendering: no `dompurify` dependency in `packages/agentic-sdk-v2`, `packages/ui` or `apps/admin-console`; `dangerouslySetInnerHTML` appears only in vendored registry components and shadcn chart (`packages/ui/src/components/registries/...`, `shadcn/chart.tsx`); `packages/ui` has `sanitize-href.ts` for links. Notes are rendered via react-markdown (escapes HTML by default).
- Admin console: BFF proxy, tokens in httpOnly cookie (rule 13).

## 3. Root Cause / Gap
Not a defect; an unscoped checklist. Gaps to confirm: (a) path-segment ids in SDK URLs not always encoded; (b) `marked` usage (packages/ui) outputting HTML without sanitising; (c) ALaaS web_ui (out of repo) rendering AI summary HTML.

## 4. Implementation Plan
1. Audit (read-only, 1 hour): list SDK/vox-node URL builders interpolating ids; list `marked`/`dangerouslySetInnerHTML` users that take non-static input.
2. Tests first: vox-node/SDK unit test that an id containing `/`, `?`, `#` is encoded into one path segment; fix call sites.
3. If `marked` output reaches the DOM: add DOMPurify (new dependency needs owner approval) in the ui renderer only.
Verification: touched test files; `@arcaai/ui` tests only if change lands inside packages/ui (owner exclusion otherwise).

## 5. Risks / Open Questions
- OD-1: scope to hope-v2 SDKs/console only and hand the web_ui part to ALaaS? OD-2: approve DOMPurify dependency?

## 6. Implementation Summary
Not started.

## 7. Change History
| Date | Change |
|---|---|
| 2026-10-06 | Created from https://github.com/ArcaAI/ALaaSv3.0/issues/218 |
