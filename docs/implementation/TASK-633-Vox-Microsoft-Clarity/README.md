# TASK-633 — Microsoft Clarity monitoring for the Vox SDK

| Field | Value |
| --- | --- |
| Status | Review |
| Type | feature |
| Branch | `dev-2.1` |
| Package | `packages/agentic-sdk-v2` (`@arcaai/vox`) |
| Date | 2026-08-07 |

## Requirement Analysis

Add Microsoft Clarity (project ID `xynejqavet`) to the Vox SDK for monitoring and tracking.

Clarity provides session replay, heatmaps and behavioural insight. The SDK already exposes a
pluggable logging transport contract (`ILogTransport`) with four implementations, so the
integration belongs there rather than as a parallel mechanism.

### Compliance constraint (drives the whole design)

Two facts set the shape of this ticket:

1. **Clarity is a session-replay product** — it reconstructs the page DOM. On a HOPE surface
   that DOM carries consultation transcripts, patient context and clinician notes, i.e. PHI.
2. **Microsoft does not offer a HIPAA BAA covering Clarity.** The Microsoft BAA covers
   Azure/Microsoft 365 services; Clarity is not among them.

The repo already has a decided position on this exact question. `HighlightTransport`
(`src/core/logger/transports/highlight.transport.ts`) — the only comparable third-party
monitoring SaaS in the SDK — is fail-closed with the rationale stated in its own doc comment:
*"Sending healthcare consultation telemetry to a third-party SaaS is a HIPAA exposure."*

This ticket therefore mirrors that precedent rather than inventing a new posture.

## Current State Evaluation

| Element | Location | Relevance |
| --- | --- | --- |
| Transport contract | `src/core/logger/types.ts` (`ILogTransport`) | Integration seam |
| Fail-closed precedent | `transports/highlight.transport.ts` | Pattern to mirror (3-gate activation) |
| PHI redaction | `src/core/logger/redactor.ts` | Runs in `SDKLogger.dispatch()` before any transport |
| Transport registration | `SDKLogger.initializeTransports()` | Gate is applied here AND in the constructor |
| Public config | `src/types/config.ts` (`LoggingConfig`) | Consumer-facing surface |
| Provider wiring | `src/providers/AgenticProvider.tsx` | Passes `cfg.logging.*` into `createSDKLogger` |

`@microsoft/clarity` v1.0.2 API surface (verified against the published `index.d.ts`):

```ts
init(projectId: string): void
setTag(key: string, value: string | string[]): void
identify(customId: string, customSessionId?, customPageId?, friendlyName?): void
consent(consent?: boolean): void            // deprecated in favour of consentV2
consentV2(opts?: { ad_Storage; analytics_Storage }): void
upgrade(reason: string): void
event(eventName: string): void              // NAME ONLY — no metadata
```

Three constraints follow from that surface:

- `event()` takes no properties, so structured metadata must travel as `setTag()` pairs.
- There is **no stop/teardown API**. Once `init()` runs, recording continues for the page
  lifetime; the closest available action is revoking consent.
- There is no message/log sink — Clarity is not a log backend. Hence the `error` level floor.

## Implementation Plan

1. `ClarityTransportConfig` in the logger types + `clarity?` on `LoggerConfig`.
2. `ClarityTransport implements ILogTransport` with the 3-gate fail-closed activation.
3. Register in `SDKLogger.initializeTransports()` behind `isAllowedToActivate`.
4. Public config type `LoggingClarityConfig` + provider wiring.
5. Optional peer dependency + tsup external (keep it a lazy dynamic import).
6. Unit tests mirroring `highlight.transport.test.ts`, including the production gate.
7. README documentation with the compliance warning and the masking prerequisite.

## Implementation Summary

### Activation gate (fail-closed, identical to Highlight)

> **Superseded — see Phase 2 (gate 1) and Phase 3 (gates 2–3) below for the final contract.**
> Gate 1 was replaced by a deployment-stage test because `NODE_ENV` is the build mode; gates 2–3
> were replaced by "the project ID is the switch". Recorded here as the original design.

`ClarityTransport.isAllowedToActivate()` requires **all** of:

1. `process.env.NODE_ENV !== 'production'`
2. `config.enabled === true` (explicit opt-in)
3. non-empty `projectId`

If any gate fails the transport is `permanentlyDisabled`: `log()` is a hard no-op that does not
even queue, so a misconfigured deploy cannot buffer PHI in memory. The gate is enforced twice —
in `initializeTransports()` (the transport is never constructed) and in the constructor.

### Behaviour

| Log entry | Clarity call |
| --- | --- |
| `error` / `fatal` | `event('vox.error.<code\|name>')` + error tags; optional `upgrade()` |
| operation with `durationMs` | `event('vox.op.<name>')` |
| any entry | low-cardinality `setTag()` pairs |

Tags: `vox.service`, `vox.environment`, `vox.context`, `vox.component`, `vox.correlationId`,
`vox.tenantId`, `vox.errorName`, `vox.errorCode`, `vox.httpStatus`, `vox.sdkVersion`.
`vox.correlationId` is deliberately included despite its cardinality — it is what links a Clarity
session replay back to the gateway/Loki logs for the same request.

### PHI defences (four layers)

1. `redactPHI()` in `SDKLogger.dispatch()` strips PHI before the transport sees the entry.
2. The transport skips any value equal to `REDACTED_VALUE` rather than forwarding the marker.
3. `identifyUsers` defaults to **false** — a user id is a personal identifier handed to a third party.
4. The production gate above.

### Deliberate deviations from the Highlight transport

| Deviation | Reason |
| --- | --- |
| Level floor defaults to `error`, not `info` | Clarity has no message sink; every entry would otherwise become a behavioural event |
| Pending queue bounded to 50 entries | Highlight's queue is unbounded; a failed SDK load should not grow memory |
| `shutdown()` revokes consent | Clarity exposes no stop API |
| Duplicate tag suppression | Clarity tags are sticky; re-sending identical pairs is pure noise |

### Files changed

| File | Change |
| --- | --- |
| `src/core/logger/transports/clarity.transport.ts` | **New** — the transport |
| `src/core/logger/types.ts` | `ClarityTransportConfig`; `clarity?` on `LoggerConfig` |
| `src/core/logger/SDKLogger.ts` | Import + gated registration |
| `src/core/logger/transports/index.ts` | Barrel export |
| `src/core/logger/index.ts` | Barrel export (class + type) |
| `src/types/config.ts` | `LoggingClarityConfig`; `clarity?` on `LoggingConfig` |
| `src/types/index.ts`, `src/core.ts` | Type barrel exports |
| `src/providers/AgenticProvider.tsx` | `clarity: cfg.logging?.clarity` |
| `package.json` | Optional peer dep `@microsoft/clarity@^1.0.0` + devDependency |
| `tsup.config.ts` | Added to `externalDependencies` |
| `src/core/logger/__tests__/clarity.transport.test.ts` | **New** — 31 tests |
| `src/__tests__/mocks/clarity.mock.ts` | **New** — SDK mock |
| `README.md` | Clarity section, config table, compliance warning |

## Verification

| Gate | Result |
| --- | --- |
| `pnpm --filter @arcaai/vox test` | **246 files / 3994 tests passed** |
| New Clarity suite | **31/31 passed** |
| `pnpm --filter @arcaai/vox typecheck` | clean |
| `pnpm --filter @arcaai/vox lint` | 0 errors (3 pre-existing warnings, unrelated files) |
| `pnpm --filter @arcaai/vox build` | success; `.d.ts` emitted for the transport |
| Bundle check | `import('@microsoft/clarity')` stays a lazy external import in `dist/core.mjs` |
| Gate mutation test | Removing the `NODE_ENV === 'production'` check fails 2 tests — the gate is genuinely covered |

## Phase 2 — Staging capture completeness

Follow-up requirement: *"make sure all metrics, console logs, etc are captured for issue
investigation and monitoring, we are in staging."* Three gaps blocked that.

### Gap 1 (blocking) — the transports were dead on staging

`isAllowedToActivate()` tested `process.env.NODE_ENV !== 'production'`. **`NODE_ENV` is the build
mode, not the deployment stage.** Vite/Next/webpack substitute it at build time and set it to
`production` for ANY optimised build — including the artifact deployed to staging. Evidence that
HOPE deploys this way: `deployment/vault-agent/reference-deployment.yaml` sets
`NODE_ENV: production` on deployed pods, and `00-project-context.md` treats
`NODE_ENV=production` as the deployed-runtime signal.

Net effect: Clarity (and Highlight) would have been **silently disabled on
`staging.hope.arcaai.com`** — the exact environment the telemetry was wanted for, failing with no
error at all.

Fix: new `src/core/logger/environment.ts` → `isProductionEnvironment(declaredEnvironment?)`.

| Declared `environment` | `NODE_ENV` | Result |
| --- | --- | --- |
| `'staging'` | `production` | **activates** (the bug fixed) |
| `'production'` / `'prod'` / `'live'` | anything | blocked |
| undeclared | `production` | blocked (unchanged behaviour) |
| undeclared | anything else | activates (unchanged behaviour) |

The fail-closed property is preserved: reaching a production deploy still requires someone to
explicitly mislabel that deploy's stage — an auditable declaration, not an accident. Applied to
**both** `ClarityTransport` and `HighlightTransport`, since both carried the identical latent trap.

### Gap 2 — `console.*` and uncaught errors reached no transport

`SDKLogger` only ever saw what SDK code routed through it. Application/library `console.*` output,
`window.onerror` and `unhandledrejection` were invisible to every transport — which is how a
staging bug report arrives with an empty log trail while the browser console was full.

New `src/core/logger/globalCapture.ts` → `installGlobalCapture(logger, options)`, wired into
`AgenticProvider`'s mount effect and uninstalled on cleanup.

Two hazards handled explicitly:

- **Infinite recursion.** `ConsoleTransport` writes via `console.*` resolved at dispatch time, so
  naive patching loops: patched console → logger → console transport → patched console. Defence is
  a module-level re-entrancy flag plus captured originals used for pass-through.
- **Flooding.** A render-loop `console.error` would otherwise saturate the transports and the
  Clarity event quota. A rolling per-minute budget (default 200) caps it and emits a
  suppressed-count warning when the window rolls, so a gap is never mistaken for silence.

`console` capture defaults to **off** — it forwards arbitrary free text, which `redactPHI()` cannot
scrub (it scrubs known PHI keys and `data:`/`blob:`/`file:` URLs). `globalErrors` defaults to on.

### Gap 3 — Clarity's `error` floor dropped operation metrics

At the default `level: 'error'`, `vox.op.*` operation-timing events never fire. Staging config
should set `clarity.level: 'info'`. Documented in the README's recommended staging block rather
than changed as a default, since the `error` floor remains right for the non-staging case.

### Phase 2 files

| File | Change |
| --- | --- |
| `src/core/logger/environment.ts` | **New** — `isProductionEnvironment()` |
| `src/core/logger/globalCapture.ts` | **New** — console + global error capture |
| `src/core/logger/transports/clarity.transport.ts` | Gate uses deployment stage |
| `src/core/logger/transports/highlight.transport.ts` | Same gate fix (identical latent trap) |
| `src/types/config.ts` | `LoggingCaptureConfig`; `capture?` on `LoggingConfig` |
| `src/providers/AgenticProvider.tsx` | Install capture on mount, uninstall on cleanup |
| `src/core/logger/index.ts`, `src/types/index.ts`, `src/core.ts` | Barrel exports |
| `src/core/logger/__tests__/environment.test.ts` | **New** — 20 tests |
| `src/core/logger/__tests__/globalCapture.test.ts` | **New** — 19 tests |
| `src/core/logger/__tests__/clarity.transport.test.ts` | +4 staging-gate regression tests |
| `README.md` | Staging note, capture section, recommended staging config |

### Phase 2 verification

| Gate | Result |
| --- | --- |
| `pnpm --filter @arcaai/vox test` | **248 files / 4033 tests passed** |
| Logger suites | **322 passed** |
| typecheck / lint / build | clean · 0 errors (3 pre-existing warnings) · success |

## Phase 3 — Project ID as the enable/disable switch

Requirement: *"allow the engineer/developer to enable/disable Clarity by configuring the project ID
or not."*

Previously activation needed BOTH `enabled: true` AND a `projectId` — two things to keep in sync,
and no way to toggle Clarity per deployment without a code change. Now the project ID alone is the
switch.

### Activation contract (final)

```ts
static isAllowedToActivate(config) {
  if (config.enabled === false) return false;                  // explicit kill switch
  if (!config.projectId?.trim()) return false;                 // the switch: no ID ⇒ off
  if (isProductionEnvironment(config.environment)) return false; // PHI gate (unchanged)
  return true;
}
```

Type change: `projectId: string` → `projectId?: string`, and `enabled: boolean` → `enabled?: boolean`
on both `ClarityTransportConfig` and the public `LoggingClarityConfig`.

| `projectId` | `enabled` | Result |
| --- | --- | --- |
| set | omitted | **enabled** — the intended path |
| omitted / `''` / `'   '` | omitted | disabled |
| set | `false` | disabled (kill switch, ID retained) |
| set | `true` | enabled (redundant but accepted) |
| omitted | `true` | disabled — Clarity cannot initialise without an ID |

Intended usage — one env var controls it per deployment, with no code change:

```ts
clarity: { projectId: process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID, environment: 'staging' }
```

Whitespace-only IDs are treated as unconfigured (an env var resolving to `''` disables rather than
crashes), and a padded ID is trimmed before `init()`.

### Discoverability

No new warning surface was added: `SDKLogger.getTransportNames()` already exists and
`AgenticProvider` already logs `transports: [...]` at startup, so `clarity` appearing in that list
is the confirmation that it activated.

The `HighlightTransport` config was deliberately **left unchanged** — the request was Clarity-specific,
and Highlight's `enabled` flag has pre-existing semantics. The two configs therefore differ; if
uniformity is wanted, applying the same three lines to Highlight is a trivial follow-up.

### Phase 3 files

| File | Change |
| --- | --- |
| `src/core/logger/types.ts` | `projectId?`, `enabled?` + switch semantics documented |
| `src/types/config.ts` | Same on the public `LoggingClarityConfig`, with the env-var example |
| `src/core/logger/transports/clarity.transport.ts` | New gate order; trims the ID at `init()` |
| `src/core/logger/__tests__/clarity.transport.test.ts` | Base fixture drops `enabled`; +8 switch tests |
| `README.md` | Env-var pattern, enable/disable table, updated config table |

### Phase 3 verification

| Gate | Result |
| --- | --- |
| `pnpm --filter @arcaai/vox test` | **248 files / 4039 tests passed** |
| Clarity suite | **40 passed** |
| typecheck / lint / build | clean · 0 errors (3 pre-existing warnings) · success |

## Owner Decisions Outstanding

1. **Production use requires a BAA.** As shipped, Clarity is non-production only. Enabling it in
   production needs a signed BAA from Microsoft covering Clarity plus a privacy review — the gate
   is a single predicate (`isAllowedToActivate`) if that decision is ever made.
2. **Set the Clarity project to "Mask All"** in the Clarity dashboard, and mark PHI-bearing
   elements `data-clarity-mask="true"`. Masking is a project-level setting; the npm SDK exposes no
   masking option, so the transport cannot enforce it from code.
3. **The staging app must declare `environment: 'staging'`** in its `logging.clarity` (and
   `logging.highlight`) config. Without it the deploy is indistinguishable from production and both
   transports stay disabled. This is a consumer-side config change, not an SDK default — the SDK
   cannot infer deployment stage from inside a browser bundle.
4. **Set `CLARITY_PROJECT_ID` (or equivalent) in the staging environment** and wire it to
   `logging.clarity.projectId`. An unset variable is a valid, silent "off" — which is the intended
   design, but it also means a forgotten variable looks identical to a deliberate disable. Confirm
   via the startup log's `transports: [...]` list.
5. **Confirm staging data is synthetic before enabling `capture.console`.** Console capture
   forwards free-text that the PHI redactor cannot scrub. If staging carries any real patient data,
   leave `capture.console` off and rely on `globalErrors` + structured SDK logs.
6. **Clarity is not a log backend.** `event()` is name-only, so Clarity cannot store console
   message text — it gets behavioural events plus tags. For searchable log/metric retention, enable
   the Loki or OTel transport (neither is environment-gated); the capture bridge feeds all
   transports at once.
7. **Runtime verification not performed** — no live consumer app was run against a real Clarity
   project. Coverage is unit-level plus the build/bundle check.
8. `@microsoft/clarity` is currently a devDependency (for tests) + optional peer dep. Consumers
   must install it themselves to activate the transport.

## Change History

| Date | Change |
| --- | --- |
| 2026-08-07 | Initial implementation: fail-closed Clarity transport, config surface, tests, docs. |
| 2026-08-07 | Phase 2 (staging capture): deployment-stage gate (`environment.ts`) fixing silent disablement on staging for Clarity AND Highlight; browser-wide `console.*` / uncaught-error capture (`globalCapture.ts`) with re-entrancy and rate-limit protection; recommended staging configuration documented. |
| 2026-08-07 | Phase 3 (enable/disable switch): `projectId` is now the on/off switch (`projectId?`, `enabled?`), so a single env var toggles Clarity per deployment with no code change; `enabled: false` retained as a kill switch. Phase 1's gate description marked superseded; README rewritten around the env-var pattern. |
