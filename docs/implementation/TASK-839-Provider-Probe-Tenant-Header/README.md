# TASK-839 — Provider Probe Tenant Header Fix

| Field | Value |
|---|---|
| **Status** | `Completed` |
| **Type** | `bugfix` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track A |
| **Tier / Effort** | `sonnet` / high (the sweep, not the fix, was the deliverable) |
| **Opened / Completed** | 2026-09-01 |
| **Merge** | `70d63bac2` (impl `ffd52d1fa`) |

> **Process note.** Written RETROSPECTIVELY on 2026-09-01, after merge — a deviation from Phase 3.
> See [TASK-837 §10](../TASK-837-AI-Platform-Consolidation-Program/README.md).

## 1. Requirement Analysis

The admin console reported `Unreachable: Request failed with status code 428` for LM Studio and vLLM. The
reported cause was wrong in a way that mattered: **the probe had never contacted either engine.** Program
finding **F-1**.

Fixing this does not turn the badge green — it makes the *explanation* true. It is a prerequisite for
TASK-840/841, because without it there is no trustworthy signal that a bring-up worked.

## 2. Current State Evaluation (pre-change)

The console issues a clean `GET /api/hope/admin/ai-models/discovery?provider=…`. The gateway route carries
no OCC decorators (`route-manifest.json` records `requiresIfMatch: false`), so the global
`RequiresIfMatchGuard` no-ops. **HTTP 428 did not originate in the gateway's OCC machinery.**

The real chain:
1. `ai-model-discovery.service.ts:339-341` POSTs to `apps/text` `/api/v1/providers/probe` with only
   `Content-Type` and a legacy `X-Service-Token` — **omitting the mandatory `X-Tenant-Id`**.
2. `apps/text` refuses in middleware at `auth.py:137` (HTTP 428); the path is not in `EXEMPT_PATHS`.
3. The gateway catch at `:356-361` copies `err.message` verbatim into every provider's `probes[].error`
   and answers **HTTP 200**.

The refusal happens in middleware, **before** `probe_providers` runs — so no socket is ever opened to any
engine. Environment-independent: it would fire identically at full replica count.

The tell that pinned it: axios says "status **code** 428"; the console's own `GatewayError` says "status 428"
without the word *code*. The string could only have come from a Node axios client inside the gateway.

Contract violated: `00-project-context.md` §"Tenant identity is mandatory on internal service calls" — *"a
peer client that omits it is a bug in the CALLER."* TASK-737 fixed exactly this at seven call sites in
`text-proxy.controller.ts`; `probeText` was missed by that sweep, though it already read `tenantId` from CLS
60 lines earlier at `:279`.

## 3. Implementation Plan (as executed)

1. **RED first** — extend the axios spy (which ignored its third argument) to assert outgoing headers.
2. Replace the hand-rolled header object with `internalServiceHeaders(...)`, copying `ai-inference.client.ts:114-128`.
3. Resolve the token via `resolveInternalAccessToken` — the legacy `TEXT_SERVICE_TOKEN` is no longer accepted
   by `apps/text` (`config.py:238-247`), so this call would have become a 401 once text was tokenized.
4. **Do NOT** add the path to `EXEMPT_PATHS` — that papers over a caller bug and weakens a contract
   `apps/text`'s own suite pins as correct.
5. Sweep the sibling call site; census every other hand-rolled internal-header object without fixing them all.

## 4. Implementation Summary

**Files changed**
- `apps/api/src/modules/ai-model/ai-model-discovery.service.ts` — `internalServiceHeaders({ serviceToken,
  tenantId: cls.get('tenantId'), tenantlessReason: TENANTLESS.PLATFORM_OPERATOR })`. The tenant-less case
  (a SUPER_ADMIN with no working tenant) **declares itself** rather than sending nothing.
- `apps/api/src/modules/ai-model/__tests__/ai-model-discovery.controller.test.ts` — 2 new cases.

**Census — 8 sites found, 1 fixed, 7 justified**

| Site | Verdict |
|---|---|
| `ai-model-discovery.service.ts:339-341` | **Fixed.** |
| `ai-service-admin/ai-service-proxy.client.ts:105-107` | Not a defect — guardrail's middleware has no `X-Tenant-Id` requirement; health paths exempt; `/medical/config` documents that provider/model are resolved per tenant at request time. |
| `harness-admin/harness-ops.client.ts:161-171` | `tenantId` travels as an explicit param; zero `X-Tenant-Id` references in `apps/harness/src/harness/api`. |
| `speech/tts-ws.gateway.ts:308-313`, `speech/speech-proxy.controller.ts:150-157` | Documented gateway-resolved-injection pattern — config in the body; TTS never resolves tenant config itself. |
| `shared/base-proxy.controller.ts:70` | **Dead code** — zero production subclasses. |
| `streaming/text-proxy.controller.ts:398-409`, `text-compat/text-compat.controller.ts:911-919` | Already fixed under TASK-737. |

**Evidence** — RED pasted before the fix; then `apps/api` **267 files / 4109 tests passed**, `api:build` 12/12.
The pre-existing frontend fixture at `engine-screen.test.tsx:39` already expected a truthful
`connect ECONNREFUSED …`, so the fix made production match its own fixtures.

**Surfaced, not fixed here** — two literal NUL bytes in this file made git treat it as binary and every diff
unreviewable. Raised separately; fixed in `660ce5396`/`af650ef12`. NUL count is now 0.

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Implemented, verified, merged as `70d63bac2`. |
| 2026-09-01 | NUL-byte follow-up landed separately (`af650ef12`). |
| 2026-09-01 | README written retrospectively; process deviation recorded above. |
