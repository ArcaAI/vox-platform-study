# TASK-962 — Three enforced entitlement limits have no capability row, so their usage is invisible

| | |
|---|---|
| **Status** | `Pending` — raised from a TASK-958 console follow-up; not started |
| **Type** | `bugfix` (application services; no schema, no console) |
| **Branch** | `dev-2.2` |
| **Found while** | surfacing `maxWorkflowDefinitions`, `maxAiProviderConnections` and `monthlyWorkflowInvocations` in the admin console (`98d6e2a2c`, `1a3078923`). The console can now SET all three; nothing can show usage AGAINST them. |
| **Related** | TASK-958 (D-8 introduced `maxAiProviderConnections`) |

---

## 1. Requirement Analysis

| # | Requirement | Reading applied |
|---|---|---|
| R-1 | Every entitlement limit the platform ENFORCES must be observable — a tenant at 4 of 5 provider connections must be able to see that before the fifth create returns 409. | `GET /admin/entitlements/tenants/:tenantId` and `GET /tenants/me/entitlements` answer this for every other limit through `quantities[]` / `meters[]`. Three enforced limits are simply absent from both arrays. |
| R-2 | A row's `used` must be computed the same way the enforcement counts, or the row misleads. | `buildCapabilityRow(key, limit, used)` also derives `remaining`, `nearLimit` and `exceeded`. A `used` that disagrees with the precheck produces a row that says "3 / 5" on a tenant the gateway is already refusing. See OQ-1. |
| R-3 | Gateway-only change. | The console renders `CapabilityUsageRow` key-driven (`tenant-override-panel.tsx`, the "Quantities" / "Meters (this period)" lists), so new rows appear with no console edit. |

## 2. Current State Evaluation

`EntitlementsService.getTenantEntitlements` (`packages/applications/src/services/entitlements/entitlements.service.ts:207-234`) builds **7 quantity rows** and **9 meter rows**. Measured against `ResolvedLimits`, three enforced limits have no row:

| Limit | Enforced at | Capability row | Usage counter available today |
|---|---|---|---|
| `maxWorkflowDefinitions` | `workflow-definition.service.ts:383`, `:478`, `:718` | **missing** | **No** — `ITenantService.getUsageStats` returns no workflow-definition count |
| `maxAiProviderConnections` | `ai-provider-connection.service.ts:1922` (`assertConnectionQuota`) | **missing** | **No** — same |
| `monthlyWorkflowInvocations` | 1 site via `assertMeterQuota` | **missing** | **Yes** — `METER_USAGE_FIELD_BY_CAPABILITY` (`entitlements.service.ts:88`) already maps it to `MeterUsage.workflowInvocations` |

So the three are **not one bug**. `monthlyWorkflowInvocations` is a pure omission with its data already in hand; the two quantities additionally lack a count.

**Enforcement is NOT the gap.** All three limits are resolved, respected and capable of throwing `QuotaExceededException` (409) / meter 429. Every meter in `MeterCapabilityKey` has at least one live `assertMeterQuota` call site (verified: workflow-invocations 1, stt-session-seconds 1, tts-characters 4, embedding-tokens 1, nlp-text-units 2, llm-tokens 9). This ticket is about OBSERVABILITY only.

**Precedent for the fix.** Not every quantity row is fed from `getUsageStats`: `apiKeyCount` is counted in the entitlements service directly (`this.apiKeyRepository.count({ where: { tenantId } })`, `:198`). The two new quantities can follow that shape rather than widening the `ITenantService` contract.

**The provider-connection cap is CREATE-only and skips the platform tier.** `assertConnectionQuota`
returns early for `SYSTEM_TENANT_ID` (`ai-provider-connection.service.ts:1919`) and grandfathers
existing rows, so its `used` is a live count of the scoped tenant's non-deleted `AiProviderConnection`
rows across every service. A row emitted for the SYSTEM tenant would therefore advertise a ceiling
nothing applies — the quantity row must either be omitted on that tier or carry `unlimited: true`.

**Row-key naming is not uniform and must be matched, not invented.** Quantity rows use short names (`users`, `departments`, `promptTemplates`, `asrPipelines`, `apiKeys`, `storageBytes`, `concurrentSessions`); meter rows use the full limit key (`monthlyConsultations`, …). New rows therefore take `workflowDefinitions` / `aiProviderConnections` / `monthlyWorkflowInvocations`.

**Out of scope: metering dimensions that are not limits.** TASK-959 added `COMPUTE_SECONDS`,
`WORKFLOW_CPU_SECONDS` and `STORAGE_BYTES` to `UsageMeterMetric` (with `MeterUsage.workflowCpuSeconds`
and friends). Verified 2026-09-13: none of them appears in `ResolvedLimits` or anywhere in
`entitlements.service.ts`, so there is no ceiling to show usage against and no row is owed. A row for
a metered-but-unbounded dimension is a separate product decision — the `guardrailCalls` precedent
(emitted with `limit: null`, deliberately never quota-blocked) is the shape it would take.

## 3. Open Questions

- **OQ-1 — what does `maxWorkflowDefinitions` actually cap?** The response DTO says *"Max PUBLISHED workflow definitions"* (twice), and the console label was corrected to "Max published workflow definitions" on that basis (`1b4021090`). The enforcement counts something else: `workflowDefinitionRepository.count({ where: { tenantId } })`, whose own comment states *"Counts every version row for the tenant."* One of the two is wrong. Whichever wins, the capability row must count identically (R-2). **Owner decision needed before the quantity row lands** — this is a behaviour question, not a display one.
- **OQ-2 — cost.** Each request to these endpoints already pays a `getUsageStats`, an API-key `COUNT`, a meter read and a concurrency probe. This adds two more `COUNT`s. Acceptable, or should the quantity block move behind an opt-in query flag?

## 4. Implementation Plan

Sequenced so the free win is not blocked by the open question.

1. **Meter row (no open questions).** Add `buildCapabilityRow('monthlyWorkflowInvocations', resolved.limits.monthlyWorkflowInvocations, meterUsage.workflowInvocations)` to the `meters` array. One line; the usage field is already mapped.
2. **Resolve OQ-1** with the owner, then align the enforcement count and the DTO/label wording so they state the same rule.
3. **Quantity rows.** Inject the workflow-definition and provider-connection repositories into `EntitlementsService` and count per tenant in the `apiKeyCount` shape; emit `workflowDefinitions` and `aiProviderConnections` rows using exactly the count the matching precheck uses.
4. **Guard the class of bug.** Add a test asserting every `EntitlementLimitKey` that has an enforcement call site also has a capability row — so the next limit added cannot repeat this silently.

### TDD list

- RED: `getTenantEntitlements` returns a `monthlyWorkflowInvocations` meter row carrying the live count.
- RED: `quantities` contains `workflowDefinitions` and `aiProviderConnections` with `used` equal to the enforcing precheck's count (same fixture, both paths).
- RED: the coverage guard above, which fails today for all three keys.
- Existing `entitlements.service.test.ts` and the console's `tenant-override-panel` rendering must stay green (new rows are additive and key-driven).

### Verification criteria

- `pnpm --filter @arcaai/applications test` and `build` green.
- A tenant at its `maxAiProviderConnections` cap shows `exceeded: true` on that row, and the same tenant's next create still returns 409 — the row and the gate agree.
- No console change required; confirm by loading a tenant on `/entitlements?tab=overrides` and seeing the three new rows without touching `apps/admin-console`.

## 5. Implementation Summary

_Not started._

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-13 | Ticket created. Found while surfacing the three limits in the admin console (TASK-958 console follow-ups `98d6e2a2c` / `1a3078923`): the console can now set them and the gateway enforces them, but no capability row exists for any of the three, so usage against them is unobservable. Verified enforcement is complete (every `MeterCapabilityKey` has a live call site) and that the three split into one free fix (`monthlyWorkflowInvocations` — usage field already mapped) and two that need a count `getUsageStats` does not return. Recorded OQ-1: the DTO says the workflow-definition cap counts PUBLISHED definitions while the precheck counts every version row — the capability row cannot be written until that is settled. Status `Pending`. |
