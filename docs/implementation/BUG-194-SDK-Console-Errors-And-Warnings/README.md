# BUG-194 — Console errors and warnings while integrating the SDK package

| Field | Value |
|---|---|
| Status | Pending |
| Type | bugfix |
| Source | https://github.com/ArcaAI/ALaaSv3.0/issues/194 (OPEN, 2025-09-30; bug, ALaaS) |
| Severity | Low-Medium (unreproducible from text; evidence is two screenshots) |
| Proposed verdict | Needs reproduction; likely obsolete against SDK 5.0.0 (v1 compat and client-AI/ML paths removed) |

## 1. Requirement Analysis
SDK integration produces multiple browser console errors/warnings; expectation is a clean console. Body has only two screenshots (not retrievable in this read-only lane; no download performed) and no message text.

## 2. Current State Evaluation
- Filed 2025-09-30 against an SDK of that date; since then: TASK-1004 removed `@arcaai/vox/compat`, TASK-1006 (4.0.0) removed in-browser VAD/denoise/NER models and `pipelineId`; family now 5.0.0 (08-vox-sdk rule). Typical console noise from that era (model/worklet loading, WASM, compat deprecations) no longer exists.
- Remaining plausible sources: SDK logger transports (`packages/agentic-sdk-v2/src/core/logger/transports/clarity.transport.ts`, `highlight.transport.ts`), AudioWorklet loading, React 19 peer warnings, deprecated-alias warnings (TASK-1045 register), CORS / allowed-origin rejections (tenant allowed origins).
- No existing test asserts "no console.error on mount" — grep for such a test not found.

## 3. Root Cause / Gap
Unknown. Cannot be classified without the message text.

## 4. Implementation Plan
1. Ask reporter (Neena/ALaaS) for text of the console messages and SDK version, or owner approves downloading the two attachments.
2. If still reproducible on 5.0.0: add a vitest/Playwright mount test spying on `console.error/warn` with a provider mounted (red first), then fix each source.
3. Verification: run only that test file.

## 5. Risks / Open Questions
- OD-1: close as obsolete unless reporter reproduces on current SDK? OD-2: allow downloading the screenshots?

## 6. Implementation Summary
Not started.

## 7. Change History
| Date | Change |
|---|---|
| 2026-10-06 | Created from https://github.com/ArcaAI/ALaaSv3.0/issues/194 |
