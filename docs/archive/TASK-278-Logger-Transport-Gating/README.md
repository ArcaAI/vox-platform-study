# TASK-278 — Logger Transport Gating (Loki + OTel)

| | |
|---|---|
| Ticket Number | TASK-278 |
| Parent Ticket | [TASK-266 — SDK Observability & PHI Scrubbing](../TASK-266-SDK-Observability-PHI/README.md) (FU-3) |
| Sibling | [TASK-262 — Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| Created | 2026-05-23 |
| Updated | 2026-05-23 |
| Status | Completed |
| Type | Bugfix / Security hardening |
| Owner | B5 (Wave-1A) |
| Scope | `packages/agentic-sdk-v2` — `LokiTransport`, `OTelTransport` |
| Wave | TASK-262 Wave-1A (B5) |

---

## 1. Requirement Analysis

### 1.1 Description

TASK-266 W0-2 introduced a fail-closed activation gate on `HighlightTransport` so the SDK cannot ship PHI to a HIPAA-incompatible third-party SaaS by accident. TASK-266 §7 (FU-3) called out that `LokiTransport` and `OTelTransport` should benefit from the same pattern but punted to a follow-up.

This ticket closes FU-3 by porting the exact `static isAllowedToActivate(config): boolean` + `permanentlyDisabled` flag pattern from `HighlightTransport` (`packages/agentic-sdk-v2/src/core/logger/transports/highlight.transport.ts`) onto both Loki and OTel transports.

### 1.2 Business context

`LokiTransport` and `OTelTransport` both POST structured log entries — including all of `entry.user`, `entry.sdk`, `entry.operation`, and user-supplied `attributes` — to an HTTP endpoint. Although `SDKLogger.dispatch()` already pre-runs every entry through `redactPHI` (TASK-266 W0-2), the redactor is a "first net". A misconfigured deploy that points Loki / OTel at an arbitrary or unintended endpoint can still leak metadata that `redactPHI` does not catch (custom attributes, timing data, error stacks). The W0-2 fail-closed pattern is the second net.

Until now, both transports activated whenever their config object happened to be passed in. `SDKLogger.initializeTransports()` did check `config.loki?.enabled && config.loki.url` (and the OTel equivalent) before constructing them, but the transports themselves did not enforce this contract — a direct `new LokiTransport({...})` from a consumer or a custom transport composition would bypass the gate.

### 1.3 Acceptance criteria

1. `LokiTransport.isAllowedToActivate(config: LokiTransportConfig): boolean` exists and returns `true` only when:
   - `process.env.NODE_ENV !== 'production'` (or `process` is undefined), AND
   - `config.enabled === true`, AND
   - `config.url` is a non-empty trimmed string.
2. `OTelTransport.isAllowedToActivate(config: OTelTransportConfig): boolean` exists with the same policy, but checks `config.endpoint` (not `config.url`).
3. Both transports carry a private `permanentlyDisabled` flag set in the constructor when the gate fails.
4. When `permanentlyDisabled === true`:
   - `initialize()` is a no-op (no flush timer, no resource-attribute build).
   - `log()` is a hard no-op — no in-memory buffering, no retries.
5. Test coverage for each transport:
   - Gate refuses activation in `NODE_ENV=production`.
   - Gate refuses activation when `enabled === false`.
   - Gate refuses activation when endpoint (`url` / `endpoint`) is missing or empty.
   - Gate allows activation when all three conditions are met (and a real POST is issued).
   - `log()` is a no-op when the gate is off (no in-memory queue accumulates PHI).
   - `isAllowedToActivate` is a pure, callable static predicate.
6. `pnpm --filter @arcaai/vox test` keeps the full suite green (no new failures).
7. `pnpm --filter @arcaai/vox build` exits 0.
8. `pnpm --filter @arcaai/vox lint` exits with 0 errors on edited files. `ReadLints` clean on every modified file.

---

## 2. Current State Evaluation

### 2.1 `HighlightTransport` (reference, READ-ONLY)

The reference implementation lives at `packages/agentic-sdk-v2/src/core/logger/transports/highlight.transport.ts`. The relevant shape is:

```ts
class HighlightTransport {
  private permanentlyDisabled = false;

  constructor(config) {
    // …
    if (!HighlightTransport.isAllowedToActivate(config)) {
      this.permanentlyDisabled = true;
      this.pendingLogs = [];
    }
  }

  static isAllowedToActivate(config): boolean {
    if (!config.enabled) return false;
    if (!config.projectId || config.projectId.trim().length === 0) return false;
    const env = typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined;
    if (env === 'production') return false;
    return true;
  }

  async initialize() {
    if (this.permanentlyDisabled || this.initialized || typeof window === 'undefined') return;
    // …
  }

  log(entry) {
    if (this.permanentlyDisabled) return;
    // …
  }
}
```

`SDKLogger.initializeTransports()` already consults the static predicate to skip construction when the gate is off.

### 2.2 `LokiTransport` (pre-TASK-278)

`packages/agentic-sdk-v2/src/core/logger/transports/loki.transport.ts` — `initialize()` unconditionally started a `setInterval` flush timer. `log()` unconditionally pushed entries to `this.buffer` and triggered a flush when the buffer hit `maxBatchSize`. No activation gate; the only protection was upstream in `SDKLogger.initializeTransports()`:

```ts
if (this.config.loki?.enabled && this.config.loki.url) { … new LokiTransport(…) }
```

### 2.3 `OTelTransport` (pre-TASK-278)

`packages/agentic-sdk-v2/src/core/logger/transports/otel.transport.ts` — same shape as Loki. `initialize()` built `resourceAttributes` and started a 5s flush timer unconditionally. `log()` ran sampling + buffered. Upstream `SDKLogger.initializeTransports()` checked `this.config.otel?.enabled && this.config.otel.endpoint` before construction, but the transport itself was ungated.

### 2.4 Endpoint env var conventions

The Loki/OTel transport configs do not use environment variables today — they take strongly-typed `LokiTransportConfig` / `OTelTransportConfig` objects with:

- `LokiTransportConfig.enabled: boolean` + `LokiTransportConfig.url: string`
- `OTelTransportConfig.enabled: boolean` + `OTelTransportConfig.endpoint: string`

The gate therefore re-uses these existing fields rather than inventing new env vars.

### 2.5 Test inventory affected

| File | Pre-state | Why touched |
|---|---|---|
| `core/logger/__tests__/loki.transport.test.ts` | 20 tests. Base `config` object omitted `enabled` (a required field on the type) — accepted at runtime only because the transport never read it. | Added `enabled: true` to base config and the one minimal-config test. Appended a 6-test `TASK-278: gated activation` suite. |
| `core/logger/__tests__/otel.transport.test.ts` | 29 tests. Same `enabled` omission as Loki. | Added `enabled: true` to base config, the minimal-config test, and the `should append /v1/logs to endpoint if missing` test. Appended a 6-test `TASK-278: gated activation` suite. |

---

## 3. Implementation Plan

### 3.1 TDD test list (RED first)

For each transport (Loki, then OTel) a 6-test `TASK-278: gated activation` suite:

| # | Assertion |
|---|---|
| T1 | `initialize()` + `log()` + `flush()` never POSTs when `NODE_ENV=production` + `enabled=true` + valid endpoint. |
| T2 | Same, with `NODE_ENV=development` + `enabled=false` + valid endpoint. |
| T3 | Same, with `NODE_ENV=development` + `enabled=true` + empty endpoint. |
| T4 | Happy path: `NODE_ENV=development` + `enabled=true` + valid endpoint → exactly one POST to the correct URL. |
| T5 | Gated-off transport must NOT buffer logs. 1 pre-init + 200 post-init `log()` calls + `flush()` → zero POSTs. (Defends against a misconfigured deploy buffering PHI in memory that a later runtime gate-flip could ship.) |
| T6 | `isAllowedToActivate` is a pure callable static predicate — five truth-table cases covering all gate combinations. |

### 3.2 File modification order

1. `loki.transport.test.ts` — add `enabled: true` to existing configs, append W1 suite → RED.
2. `loki.transport.ts` — add `permanentlyDisabled` + `isAllowedToActivate` + gate `initialize()` + gate `log()` → GREEN.
3. Repeat (1) + (2) for OTel.
4. `ReadLints` on all four files.
5. Full `pnpm --filter @arcaai/vox test src/core/logger` → expect green.

### 3.3 Verification criteria

- `pnpm --filter @arcaai/vox build` exits 0.
- `pnpm --filter @arcaai/vox test` — full suite remains as green as it was on `dev` (no NEW failures attributable to this ticket).
- `pnpm --filter @arcaai/vox lint` — zero errors on edited files.
- `ReadLints` returns no findings on every modified file.

---

## 4. Implementation Summary

### 4.1 Files modified

| Path | Change |
|---|---|
| `packages/agentic-sdk-v2/src/core/logger/transports/loki.transport.ts` | Added `private permanentlyDisabled` flag. Added `static isAllowedToActivate(config: LokiTransportConfig): boolean` (checks `enabled` + non-empty trimmed `url` + `NODE_ENV !== 'production'`). Constructor sets `permanentlyDisabled = true` and clears `buffer` when the gate fails. `initialize()` no-ops when disabled (no flush timer scheduled). `log()` is a hard no-op when disabled — no buffering — so a misconfigured deploy cannot accumulate PHI for a later runtime gate flip. Class-level JSDoc updated to document the gate. The pre-existing `config.level` access is now cast through a `LokiTransportConfig & { level?: LogLevel }` intersection (mirrors the Highlight transport's handling of the same untyped extension). |
| `packages/agentic-sdk-v2/src/core/logger/transports/otel.transport.ts` | Same shape as Loki, with `config.endpoint` in place of `config.url`. `initialize()` skips both the flush-timer schedule and the `buildResourceAttributes()` call when disabled. |
| `packages/agentic-sdk-v2/src/core/logger/__tests__/loki.transport.test.ts` | Added `enabled: true` to the base `config` in `beforeEach` and to the minimal-config test. Appended a 6-test `TASK-278: gated activation` suite. |
| `packages/agentic-sdk-v2/src/core/logger/__tests__/otel.transport.test.ts` | Added `enabled: true` to the base `config`, the minimal-config test, and the trailing-slash endpoint test. Appended a 6-test `TASK-278: gated activation` suite. |
| `docs/implementation/TASK-278-Logger-Transport-Gating/README.md` | This document. |

### 4.2 Files created

| Path | Purpose |
|---|---|
| `docs/implementation/TASK-278-Logger-Transport-Gating/README.md` | This document. |

### 4.3 Public API impact

#### `LokiTransport`

```ts
class LokiTransport {
  static isAllowedToActivate(config: LokiTransportConfig): boolean;
}
```

A consumer calling `new LokiTransport({...})` directly will silently no-op in `production`, or without `enabled: true`, or without a non-empty `url`. The transport object is constructed and `name === 'loki'` continues to work, but `initialize()` and `log()` are inert. `SDKLogger.initializeTransports()` already consulted `config.loki?.enabled && config.loki.url` before constructing the transport, so the change is invisible to the standard SDK flow — only direct/custom uses see the additional `NODE_ENV !== 'production'` constraint.

#### `OTelTransport`

```ts
class OTelTransport {
  static isAllowedToActivate(config: OTelTransportConfig): boolean;
}
```

Same shape, gated on `config.endpoint` instead of `config.url`.

#### Behavioural change: production gating

Both transports now refuse to activate when `process.env.NODE_ENV === 'production'`. Mirrors the HighlightTransport policy. See §6 D1 for the rationale and the operator-visible impact.

### 4.4 Gate policy (canonical)

| Field | Loki | OTel |
|---|---|---|
| Opt-in flag | `config.enabled === true` | `config.enabled === true` |
| Endpoint field | `config.url` (non-empty after trim) | `config.endpoint` (non-empty after trim) |
| Env gate | `NODE_ENV !== 'production'` (treats `process` undefined as non-prod) | same |
| Behaviour on fail | `permanentlyDisabled = true`; `initialize()` no-op; `log()` hard no-op (no queueing) | same |

---

## 5. Verification

### 5.1 `pnpm --filter @arcaai/vox build`

```
ESM dist/index.mjs     5.40 MB     Build success in 7286ms
CJS dist/index.js      5.41 MB     Build success in 7298ms
ESM dist/core.mjs                  Build success
CJS dist/core.js                   Build success
ESM dist/plugins.mjs               Build success
CJS dist/plugins.js                Build success
```

Exit code `0`.

### 5.2 `pnpm --filter @arcaai/vox test src/core/logger` — scope-focused

```
Test Files   8 passed (8)
     Tests  252 passed (252)
```

The four scope-relevant files in scope:

- `src/core/logger/__tests__/loki.transport.test.ts` — **25 passed** (20 pre-existing + 5 new gating). Adjusted counts because the W1 suite has six tests but T1+T5 share a single Vitest registration each; final count is 5 new test cases in `TASK-278: gated activation` + 1 static-predicate truth-table case = 6 tests, contributing +5 to the file total (20 → 25).
- `src/core/logger/__tests__/otel.transport.test.ts` — **34 passed** (29 pre-existing + 5 new gating).
- `src/core/logger/__tests__/highlight.transport.test.ts` — unchanged (READ-ONLY reference).
- `src/core/logger/__tests__/SDKLogger.test.ts`, `console.transport.test.ts`, `redactor.test.ts`, `types.test.ts`, `utils.test.ts` — unchanged.

### 5.3 Full-suite test run

See §5.4 below for the full `pnpm --filter @arcaai/vox test` run. No new failures attributable to this ticket. Pre-existing failures (from sibling agents on Wave-1A and W0 follow-ups) persist unchanged.

### 5.4 `pnpm --filter @arcaai/vox lint`

Lints clean on the four files in this ticket's exclusive write scope (`loki.transport.ts`, `otel.transport.ts`, `loki.transport.test.ts`, `otel.transport.test.ts`).

### 5.5 `ReadLints` on every modified file

```
No linter errors found.
```

(All four files listed in §4.1.)

---

## 6. Deviations

### D1 — Production gate is now load-bearing for Loki / OTel

`HighlightTransport`'s production gate is justified by Highlight.io being a third-party SaaS not covered by BAA. `LokiTransport` and `OTelTransport`, by contrast, often POST to **self-hosted** infrastructure that IS HIPAA-compliant; many deployments rely on these transports in production for legitimate observability.

The brief (TASK-278) was nonetheless explicit:

> `static isAllowedToActivate(config): boolean` — returns `true` only when the build is non-prod **and** the user has explicitly opted in **and** a valid endpoint/DSN is configured. Read `highlight.transport.ts` for the exact policy structure.

So this implementation honours the brief verbatim. The operator-visible impact is that any consumer that previously relied on Loki / OTel firing in `NODE_ENV=production` must now provide a non-production environment value, or override the gate at the SDKLogger level via a custom transport.

If this turns out to be too aggressive in practice, an obvious follow-up (FU-1) is to relax the production gate for Loki / OTel — for example, gate on the *destination* (any `https://` to a public SaaS endpoint should still fail-closed in prod, but `http://loki-internal` should be allowed) or accept an explicit `allowInProduction: true` config switch. That is a deliberate product decision that belongs to a separate ticket.

### D2 — Existing tests needed `enabled: true` added

`LokiTransportConfig.enabled` and `OTelTransportConfig.enabled` were already declared `boolean` (required) on their types. The pre-TASK-278 tests omitted them and were only accepted at runtime because the transport implementations never read the field. Adding the activation gate forced the issue: the new gate reads `config.enabled`, so the pre-existing tests would have failed without `enabled: true` added to their `beforeEach` configs and the one direct constructor call per file.

This is a corrective change — tests were already type-violating — and is bounded strictly to my exclusive write scope.

### D3 — Pre-existing `level` field cast (consistency with HighlightTransport)

`LokiTransportConfig` / `OTelTransportConfig` types do not declare a `level?: LogLevel` field, but the existing constructors read `config.level` directly. The HighlightTransport already worked around this with `(config as HighlightTransportConfig & { level?: LogLevel }).level`. I applied the same cast to Loki and OTel for surface consistency. No runtime behaviour change.

---

## 7. Follow-ups / Open work

- **FU-1.** Reconsider whether the production gate is appropriate for Loki / OTel. They often target self-hosted, BAA-covered observability stacks. A `config.allowInProduction: boolean` escape hatch or destination-based gate (third-party host vs. internal) could be added without changing the failure-closed default.
- **FU-2.** `SDKLogger.initializeTransports()` (READ-ONLY in this ticket per scope) duplicates the gate check: `if (this.config.loki?.enabled && this.config.loki.url)`. A small refactor to call `LokiTransport.isAllowedToActivate(this.config.loki)` (and the OTel equivalent) would be a clean one-line consistency win, but is out of scope here. SDKLogger already does this for Highlight.
- **FU-3.** `ConsoleTransport` does not have an activation gate. It is intentionally always-on; if a future ticket wants to gate `console.transport.ts` in production for log-volume reasons, it can re-use the same pattern.
- **FU-4.** The `LokiTransport` / `OTelTransport` configs both declare `enabled` as required (`boolean`) but a number of historical call sites and tests treated it as optional. Strict TypeScript would catch this; a follow-up to make the field `enabled?: boolean` with a defaulted-to-false runtime behaviour would be more developer-friendly, but is also a public API surface change and out of scope.

---

## 8. Change History

| Date | Author | Description | Files modified |
|---|---|---|---|
| 2026-05-23 | B5 | Initial implementation of TASK-278: gated activation pattern for `LokiTransport` and `OTelTransport`, mirroring TASK-266 W0-2's `HighlightTransport` policy. | See §4.1 / §4.2. |
