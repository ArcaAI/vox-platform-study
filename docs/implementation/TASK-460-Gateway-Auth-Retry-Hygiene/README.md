# TASK-460 — Gateway Auth Posture + Retry Hygiene (C4-02 · C4-03 · C4-04)

- **Status**: Pending (Wave 2 scaffold — no implementation)
- **Type**: bugfix (security posture + billing/correctness)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 2 (P1)
- **Findings**: C4-02 (Med) · C4-03 (Med) · C4-04 (Med) — all CONFIRMED — see [TASK-448 register](../TASK-448-Harness-Loop-Quality-Review/README.md)
- **Branch (when scheduled)**: `fix/task-460-gateway-auth-retry` (from the Wave-1 landing on `fix/2605-review`)
- **Size**: M
- **Suggested agent**: security-auditor

## File-ownership manifest (exclusive — binding)

| File | Change |
|---|---|
| `apps/api/src/modules/ai-inference/ai-inference.client.ts` | Attach fail-closed `X-Service-Token` to NLP/Guardrail hops (C4-02) |
| `apps/api/src/modules/ai-inference/__tests__/ai-inference.client.test.ts` | Invert the "never sends X-Service-Token" test |
| `apps/api/src/common/tenant-owned-resource-sse.guard.ts` | Periodic / revocation re-check for long-lived SSE (C4-03) |
| `apps/api/src/common/__tests__/tenant-owned-resource-sse.guard.test.ts` | NEW — mid-stream re-auth test |
| `apps/api/src/modules/streaming/smr-proxy.controller.ts` | Idempotency key + connect-phase-only retry for `/generate` (C4-04) |
| `apps/api/src/modules/streaming/__tests__/smr-proxy.controller.test.ts` | Retry single-delivery / idempotency tests |

Adding a config knob (e.g. an SSE re-check interval) may touch a config surface — if so, STOP and report before editing it. Anything else outside the manifest → STOP.

## Requirement Analysis

Three independent gateway hygiene defects for PHI-bearing / billable internal traffic.

### C4-02 (Med) — AiInferenceClient sends PHI to NLP + Guardrail with NO auth header
`AiInferenceClient.post` ([ai-inference.client.ts:59-66](apps/api/src/modules/ai-inference/ai-inference.client.ts)) sends the body with only a `timeout` — no service token. Both outbound calls carry caller clinical text: `analyzeGuardrail()` → `POST /api/guardrail/analyze`, `classifyTokens()` → `POST /api/v1/classify/tokens` (:42-49). The PHI enters via `@Post('guardrail/analyze')` / `@Post('nlp/entities')` ([ai-inference.controller.ts:32-49]). This sits in a **three-way asymmetry**: harness + STT-internal are **fail-closed** (receivers 401 on missing/unconfigured token — [harness-service-token.guard.ts:26-38], [stt-internal.controller.ts:28-32]; senders always attach the header — [harness-ops.client.ts:155-161]); SMR is **fail-open** (token attached only if present — [smr-proxy.controller.ts:183-195]); ai-inference has **no token mechanism at all**. Target: uniform fail-closed `X-Service-Token` for all PHI-bearing internal hops.

### C4-03 (Med) — SSE tenant-ownership is a one-time pre-stream check
`TenantOwnedResourceSseGuard.canActivate` ([tenant-owned-resource-sse.guard.ts:32-48]) runs `assertAccess` exactly once at request admission ([interceptor.ts:96-120]); a NestJS `CanActivate` guard has no per-event re-evaluation, so once the `text/event-stream` opens, the subscription lives on regardless of later logout / session revocation / active-tenant switch. **Register correction (from the scout)**: only `GET :id/live-summary/stream` ([consultation.controller.ts:507-519]) actually relays **PHI**; the code's own OpenAPI descriptions say `harness-progress` ([:524-536]) and `harness-assurance` ([:543-555]) carry **"no PHI"** (stage lists / ids / verdict labels only). So the stale-authorization concern applies to all three, but the **PHI-exposure severity is concentrated on live-summary** — prioritize the re-check there. There is **no dedicated test** for this guard today.

### C4-04 (Med) — `withRetry` re-POSTs `/generate` with no idempotency dedup
`withRetry` ([smr-proxy.controller.ts:222-245]) re-invokes up to `maxRetries=2` extra times on `isRetriable` errors ([:197-202]) whose `RETRIABLE_CODES` include `ECONNRESET`/`EPIPE`/`ETIMEDOUT` ([:88]) — which occur **after** request bytes are sent, so SMR may have already started/billed a generation when the socket dropped, and the retry re-POSTs the identical body. Both `/generate` POSTs are wrapped: `generate()` ([:388-395]) and `generateAssembled()` ([:570-577]). No idempotency key exists (grep-confirmed repo-wide): headers ([:183-195]) carry none, the request DTOs ([:50-79]) have no request-id field. Result: duplicate billable generations + divergent (non-deterministic) drafts.

### Acceptance criteria

- [ ] **C4-02 (red first — invert)**: the existing test that asserts `X-Service-Token` is `undefined` ([ai-inference.client.test.ts:57-64]) is inverted to REQUIRE the header. Then `AiInferenceClient` attaches `X-Service-Token` (from `SecretsService`, matching the harness outbound pattern) on both NLP + Guardrail calls, **fail-closed** (empty/unset token is still sent so the receiver rejects — align the receivers to reject if they don't already). Document the receiver-side change if the NLP/Guardrail services need a guard.
- [ ] **C4-03 (red first — new test)**: a test opens the live-summary SSE, simulates a revocation / tenant switch, and asserts the stream STOPS delivering (currently it does not). Then: re-assert SSE access periodically and/or on a revocation event for long-lived PHI streams (at least `live-summary`). Keep the pre-stream check.
- [ ] **C4-04 (red first)**: a test drives a mid-flight `ECONNRESET` on `/generate` and asserts the current code re-POSTs (duplicate delivery). Then: attach an idempotency key so a retried `/generate` dedups downstream, OR retry only connect-phase failures (`ECONNREFUSED`/`ENOTFOUND` — never post-send resets) so an already-sent generation is never re-invoked. Assert single delivery.
- [ ] **AC-gate**: `pnpm build:api` + `pnpm test:unit` (the three suites) + `pnpm lint` (hard errors in apps/api) green; output pasted.

### Non-goals

- C4-05 (SMR error-body sanitization, Low) → TASK-462. C4-01 (done, TASK-450).
- Re-architecting the guard pipeline; a full session-revocation event bus (a periodic re-check or a targeted revocation signal is sufficient).
- The SMR fail-open→fail-closed flip is in-scope only insofar as it's the same `X-Service-Token` uniformity; if it expands, note it.

## Current State Evaluation (code-verified 2026-07-09 against `fix/2605-review`)

C4-02: no-auth POST [ai-inference.client.ts:59-66], calls [:42-49], intentional-design comment [:25-28]; PHI entry [ai-inference.controller.ts:32-49]; fail-closed references [harness-service-token.guard.ts:26-38], [harness-ops.client.ts:155-161], [stt-internal.controller.ts:28-32]; SMR fail-open [smr-proxy.controller.ts:183-195]; test asserting absence [ai-inference.client.test.ts:57-64].
C4-03: one-time guard [tenant-owned-resource-sse.guard.ts:32-48] → [interceptor.ts:96-120]; registration order [app.module.ts:130-142]; PHI route [consultation.controller.ts:507-519]; no-PHI routes [:524-536], [:543-555]; no dedicated guard test (coverage gap). TASK-450 touched the stream-ticket mint, NOT this guard.
C4-04: `withRetry` [smr-proxy.controller.ts:222-245]; `isRetriable`+codes [:197-202/:88]; retried POSTs [:388-395], [:570-577]; no idempotency (grep-confirmed); retry loop untested ([smr-proxy.controller.test.ts] has zero `withRetry`/`ECONNRESET` coverage — unreachable-service tests never assert POST count).

## Implementation Plan (TDD — strict order)

> Context pack: this README · TASK-449 §Architecture preamble · `.claude/rules/05-nestjs-api.md` (guard pipeline, service-token injection via SecretsService, 404-over-403).

1. RED→GREEN per finding (independent). For C4-02, mirror the harness outbound `buildHeaders` pattern. For C4-03, prioritize live-summary. For C4-04, prefer connect-phase-only retry (simplest correct) unless a real idempotency key is cheap downstream.

### Verification gate

```bash
pnpm build:api
pnpm test:unit   # ai-inference.client + tenant-owned-resource-sse.guard + smr-proxy.controller
pnpm lint
```

Adversarial review focus: (a) C4-02 — is the token attached on EVERY PHI hop, and is it genuinely fail-closed (receiver rejects empty)? did inverting the test actually catch the change? (b) C4-03 — does the re-check reliably stop a revoked user's PHI stream without killing valid streams? is the interval/signal sound? (c) C4-04 — can a post-send generation EVER be re-invoked after the fix? is single-delivery asserted by POST-count, not just "throws"? (d) zero diff outside the manifest.

## Implementation Summary

_Pending — not yet implemented (Wave 2)._

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-448 findings C4-02/03/04; all re-verified against the post-Wave-1 tree by read-only scout. Register corrected: harness-progress/assurance SSE are "no PHI" per the code — only live-summary carries PHI, so C4-03's PHI severity is concentrated there. No implementation. |
