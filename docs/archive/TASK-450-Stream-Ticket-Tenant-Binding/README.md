# TASK-450 — Stream-Ticket / WS Tenant Binding (C4-01, Critical)

- **Status**: Review — implemented, adversarially reviewed, merged to `fix/task-449-wave1`; cross-tenant e2e + final landing pending
- **Type**: bugfix (security — cross-tenant PHI egress)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 1 (P0) · **EXPEDITE** — merges as soon as its own gates pass; does not wait for wave sync.
- **Finding**: C4-01 (Critical, CONFIRMED ✓C ✓H) — see [TASK-448 register](../TASK-448-Harness-Loop-Quality-Review/README.md)
- **Branch**: `fix/task-450-stream-ticket-tenant-binding` (cut from `main`)
- **Size**: M
- **Suggested agent**: security-auditor

## File-ownership manifest (exclusive — binding)

| File | Change |
|---|---|
| `apps/api/src/modules/auth/auth.controller.ts` | Add fail-closed ownership for `stt_session:*` at mint (`assertConsultationScopeOwnership` or a sibling) |
| `apps/api/src/modules/streaming/stt-ws.gateway.ts` | `handleConnection` ONLY — add ticket-tenant vs bound-tenant check via the already-injected `sessionBinding.lookup()` |
| `apps/api/src/modules/auth/__tests__/auth.controller.stream-ticket.test.ts` | Add `stt_session:*` ownership cases |
| `apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts` | Add foreign-tenant-ticket rejection case |
| `apps/api/tests/e2e/task-450-stt-session-cross-tenant.spec.ts` | NEW e2e — cross-tenant WS handshake → rejected |

Do NOT touch `stream-ticket.service.ts`, `stream-session-tenant-binding.service.ts`, `transcription-job.controller.ts`, or the interceptor — the binding infrastructure is already correct and used elsewhere; this ticket only wires the two missing call sites. Anything outside the manifest → STOP and report.

## Requirement Analysis

`POST /api/v1/auth/stream-ticket` mints `stt_session:<sessionId>` tickets carrying the **caller's** active tenant, with **no ownership check** — the scope silently bypasses `assertConsultationScopeOwnership` because it fails the `consultation_*` regex. The WS gateway then validates the ticket **scope string only** and copies `stored.tenantId` (the minter's tenant) onto the session, never comparing it to the session's true owning tenant. Net: any authenticated user in tenant B who learns a tenant-A `sessionId` (logged in clear at multiple points) can mint a valid ticket and subscribe to tenant A's live transcript over WS — **cross-tenant PHI egress** that HTTP/SSE would 404.

The fix is low-risk because the correct mechanism already exists: `StreamSessionTenantBindingService.lookup(sessionId) → tenantId` is written at session-create ([transcription-job.controller.ts:383-391](apps/api/src/modules/streaming/transcription-job.controller.ts)) and already enforced on the DELETE-session route via `assertStreamSessionOwnership` ([tenant-owned-resource.interceptor.ts:159-164](apps/api/src/common/tenant-owned-resource.interceptor.ts)) with the house 404-over-403 posture. This ticket applies the same check at the two paths that skip it.

### Acceptance criteria

- [ ] **AC-1 (defense-in-depth, two independent gates)**: cross-tenant live-transcript subscription is blocked at BOTH (a) mint time and (b) WS handshake. Either alone must reject; both are required.
- [ ] **AC-2 (mint)**: minting a `stt_session:<sessionId>` ticket resolves the session's bound tenant via `sessionBinding.lookup(sessionId)`; if the binding is missing OR ≠ the caller's active tenant, respond **404** (`NotFoundException`, no existence leak) — identical posture to the consultation-scope path.
- [ ] **AC-3 (handshake)**: `handleConnection` calls `sessionBinding.lookup(sessionId)` and closes the socket with the existing generic `(4401, "Authentication failed")` tuple when the bound tenant is missing or ≠ `stored.tenantId`. No new close code, no tenant value in the close reason or logs.
- [ ] **AC-4 (red first, mint)**: a unit test mints a `stt_session:*` ticket whose session is bound to a different tenant and expects 404 — FAILS against current code, then passes.
- [ ] **AC-5 (red first, handshake)**: a gateway unit test supplies a ticket with `scope: stt_session:<sid>` but a foreign `tenantId` and expects handshake rejection — FAILS against current code (existing tests stub `lookup` but never assert it is called), then passes.
- [ ] **AC-6 (e2e)**: `task-450-stt-session-cross-tenant.spec.ts` proves a tenant-B principal cannot open the WS for a tenant-A session, mirroring `task-307-*-cross-tenant.spec.ts` conventions.
- [ ] **AC-7 (no regression)**: same-tenant mint + handshake still succeed; the `consultation_*` and `consultation_job` paths are unchanged; sessionId is never newly logged in clear as part of this change.
- [ ] **AC-8**: verification gate green, output pasted into §Implementation Summary.

### Non-goals

- The broader asymmetric service-token posture (C4-02), SSE re-auth (C4-03), SMR retry dedup (C4-04), error-body sanitization (C4-05) — those are TASK-460 / TASK-462.
- Removing sessionId from logs (observability hardening) — out of scope; only ensure this change adds none.
- Restricting who can mint `stt_session` scopes to server-only paths — noted as an ideal in TASK-448; a follow-up, not required here (the two-gate check closes the hole).

## Current State Evaluation (code-verified 2026-07-09 by read-only scout)

**Mint — unchecked skip** ([auth.controller.ts:836-857](apps/api/src/modules/auth/auth.controller.ts)):

```ts
private async assertConsultationScopeOwnership(scope: string, activeTenantId: string | null): Promise<void> {
  const match = /^(consultation_[a-z0-9_]+):(.*)$/.exec(scope ?? '');
  if (!match) {
    return;                       // ← stt_session:* exits here, unchecked
  }
  ...
}
```

Mint handler passes the caller's tenant onto the ticket ([auth.controller.ts:791-808](apps/api/src/modules/auth/auth.controller.ts)); DTO validates only a free-form `scope` string ([stream-ticket.request.ts:12-20](apps/api/src/modules/auth/dto/stream-ticket.request.ts)); stored ticket carries the minter's `tenantId` ([stream-ticket.service.ts:51-58](apps/api/src/modules/auth/stream-ticket.service.ts)).

**Handshake — scope-only check** ([stt-ws.gateway.ts:242-285](apps/api/src/modules/streaming/stt-ws.gateway.ts)):

```ts
const expectedScope = `stt_session:${sessionId}`;
if (stored.scope !== expectedScope) {          // ← ONLY check
  ... client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON); return;
}
...
const session: SessionInfo = { ..., tenantId: stored.tenantId /* ← trusts ticket, never verified */ };
```

The gateway injects `sessionBinding` (constructor) but in the handshake calls only `lookupSessionMeta` (for sampleRate), never `lookup(sessionId)`.

**The check that already exists (reference to mirror)** ([tenant-owned-resource.interceptor.ts:159-164](apps/api/src/common/tenant-owned-resource.interceptor.ts)):

```ts
private async assertStreamSessionOwnership(sessionId: string, callerTenantId: string): Promise<void> {
  const boundTenantId = await this.streamSessionTenantBinding.lookup(sessionId);
  if (boundTenantId === null || boundTenantId !== callerTenantId) {
    throw new NotFoundException(RESOURCE_NOT_FOUND);      // 404-over-403
  }
}
```

**Binding written at session-create** ([transcription-job.controller.ts:383-391](apps/api/src/modules/streaming/transcription-job.controller.ts)) — `bind(sessionId, tenantId)` runs in the same `Promise.all` that mints the ticket.

**404-over-403 pattern to match** ([consultation.controller.ts:507-518](apps/api/src/modules/consultation/consultation.controller.ts) + [tenant-owned-resource.interceptor.ts:173-181](apps/api/src/common/tenant-owned-resource.interceptor.ts)).

**Test gaps** (both stubs exist but never assert the check): [auth.controller.stream-ticket.test.ts](apps/api/src/modules/auth/__tests__/auth.controller.stream-ticket.test.ts) has no `stt_session:*` case; [stt-ws.gateway.test.ts:52](apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts) stubs `lookup: vi.fn().mockResolvedValue('tenant-abc')` but no test asserts a foreign-tenant ticket is rejected. E2e [task-419-stream-ticket-scopes.spec.ts](apps/api/tests/e2e/task-419-stream-ticket-scopes.spec.ts) covers `dna_job`/`transcription_job` SSE only — no `stt_session`/WS coverage.

**Finding nuance (correct the register wording in review)**: there is no comment that names `stt_session` as skipped — the exemption is a silent regex non-match, and the documented comment above the method concerns the consultation path. This does not change the fix.

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-449 §Architecture preamble (this is the **realtime loop's** WS ingress; the session is ephemeral UX, but the PHI it streams is real) · `.claude/rules/05-nestjs-api.md` (404-over-403, guard pipeline, `@TenantOwnedResource`).

1. **RED (handshake)** — add the gateway test (AC-5): ticket scope matches, `stored.tenantId = 'tenant-B'`, `sessionBinding.lookup` resolves `'tenant-A'`; assert socket closed `(4401, generic)`. Confirm it FAILS. Commit.
2. **GREEN (handshake)** — in `handleConnection`, after the scope check, `const boundTenant = await this.sessionBinding.lookup(sessionId);` then close generically if `boundTenant === null || boundTenant !== stored.tenantId`. Keep the existing generic reason. Suite green. Commit.
3. **RED (mint)** — add the controller test (AC-4): a `stt_session:<sid>` mint whose bound tenant ≠ caller tenant expects `NotFoundException`. Confirm FAILS. Commit.
4. **GREEN (mint)** — extend the ownership assertion (or add a sibling branch) so `stt_session:<sid>` resolves `sessionBinding.lookup(sid)` and 404s on missing/mismatch. Inject the binding service into the controller if not already available (constructor only — do not alter the service). Suite green. Commit.
5. **E2e** — author `task-450-stt-session-cross-tenant.spec.ts` (AC-6) following `task-307-*` fixtures. Run under `pnpm test:api:up` + `pnpm test:e2e`.
6. **Regression sweep** — same-tenant happy paths, `consultation_*`, `consultation_job` untouched (AC-7).

### Verification gate (paste output into §Implementation Summary)

```bash
pnpm --filter @arcaai/api build   # or: pnpm build:api
pnpm test:unit                    # auth.controller + stt-ws.gateway suites
pnpm lint                         # HARD ERRORS in apps/api
pnpm test:api:up                  # terminal 1
pnpm test:e2e                     # terminal 2 — includes task-450 spec
```

Adversarial review focus (reviewer agent): (a) is the mint check truly fail-closed when the binding is absent (not just when it mismatches)? (b) can the handshake still be reached with a stale/replayed ticket whose session was rebound? (c) does the 404/4401 leak existence or tenant identity anywhere (body, log, close reason)? (d) confirm the two gates are independent (disable one in a scratch test — the other still blocks). (e) zero diff outside the manifest.

## Implementation Summary

**Branch**: `fix/task-450-stream-ticket-tenant-binding` (2 commits: `f1efc415` C4-01, `a50aa9cb` I-1) — merged into `fix/task-449-wave1`.

**What shipped**: fail-closed tenant binding on both `stt_session:*` mint surfaces + the WS handshake, all via the pre-existing `StreamSessionTenantBindingService.lookup(sessionId)` (404-over-403 posture):
- **Mint** (`auth.controller.ts`): new `assertSttSessionScopeOwnership` resolves the session's owning tenant and throws `NotFoundException` on missing/mismatch/lookup-failure. `AuthModule` imports `TenantOwnedResourceModule` to inject the service (pre-approved manifest exception).
- **WS handshake** (`stt-ws.gateway.ts`): after the scope check, `lookup(sessionId)` and a generic `(4401, "Authentication failed")` close on missing/mismatch — no new close code, no tenant in logs/close reason.
- **I-1 (review)**: the second mint path `refreshStreamTicket` (`transcription-job.controller.ts`) gained `@TenantOwnedResource({ modelName:'StreamSession', paramName:'sessionId', lookup:'session' })`, copied verbatim from the DELETE-session route, so both gates hold on both mint paths.

**Gates**: `auth.controller.stream-ticket` 21/21, `stt-ws.gateway` 51/51, `transcription-job.controller` 63/63; `pnpm build:api` clean; `pnpm lint` clean (apps/api hard-error surface); gitleaks clean. RED captured for the mint, handshake, and I-1 metadata assertions.

**Adversarial review**: no Critical (PHI hole closed end-to-end; `X-Tenant-Id` spoof-resistance, fail-closed, and no-info-leak all verified). Important I-1 found and fixed (above).

**Deferred**: `apps/api/tests/e2e/task-450-stt-session-cross-tenant.spec.ts` written and compiling (`playwright --list`, 7 tests) but NOT executed — needs the live test stack (docker + test API + STT). Its 3 mint-level fail-closed tests are the strongest wire pin; run at landing/CI. The 135 unit tests cover the cross-tenant scenarios in the interim.

**Register wording correction**: the mint skip is a silent regex non-match, not a documented `stt_session` skip (does not change the fix).

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-448 finding C4-01; mint skip, handshake gap, and the already-existing binding/lookup enforcement all re-verified against code by read-only scout. Register wording nuance recorded. No implementation started. |
| 2026-07-09 | Implemented (TDD, isolated worktree) + adversarially reviewed. Review found I-1 (second un-gated mint endpoint `refreshStreamTicket`); fixed. Merged to `fix/task-449-wave1` (integration build green). e2e written, deferred to landing. |
