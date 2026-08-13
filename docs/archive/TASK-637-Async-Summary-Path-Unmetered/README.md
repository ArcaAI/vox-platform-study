# TASK-637 — BUG: the async summary path is entirely unmetered (quota + billing bypass)

| | |
|---|---|
| **Status** | Pending |
| **Classification** | bugfix (revenue / quota integrity) |
| **Severity** | High — live production code path; bypasses both quota enforcement and billing |
| **Created** | 2026-08-08 |
| **Branch** | dev-2.1 |
| **Discovered by** | TASK-635 defect B-13 investigation (2026-08-08) |
| **Related** | TASK-615 (usage metering + tenant billing — shipped the metering this path never adopted), TASK-635 (§2.4 B-13, §7 NEW-1) |
| **Ticket-number note** | `docs/archive/` could not be enumerated (permission denied); highest in `docs/implementation/` is TASK-636. If an archived ticket ≥ 637 exists, renumber. |

---

## 1. Summary

`SummaryProcessor` — the BullMQ finalize path — performs **no metering of any kind**:

- no usage-ledger emission (`parseSmrUsageDetail` is never called, no `usageLedgerService`, no `unitOfWork` injected),
- no quota assertion (`assertMeterQuota` is never called),
- no `SummaryMeta` row written (no `SummaryMetaFactory`, no repository call).

The path is **live production code** with two active enqueue sites. Every summary generated through it is invisible to quota enforcement, to the usage ledger, and to invoicing — while the synchronous path (`SummaryService`) meters normally.

## 2. Evidence (verified 2026-08-08 against dev-2.1)

### 2.1 The path is live, not legacy

| Fact | Evidence |
|---|---|
| Queue registration | `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts:24` — `@Processor(JobQueue.GenerateSummary)`; module wiring `consultation-job.service.module.ts:42`; service `consultation-job.service.ts:85,185` |
| Enqueue site 1 (public API) | `apps/api/src/modules/consultation/consultation.controller.ts:1072` — `POST /consultations/:id/summary/async`, `@RequiredScopes('consultation:report:write')`. This is what the SDK's `generateSummaryAsync` calls. |
| Enqueue site 2 (automatic) | `consultation-event.handler.ts:227` — the auto-pipeline enqueues it without any user action |
| Result is never persisted | The only consumer of `ConsultationPipelineEvent.SummaryGenerated` is `consultation-event.handler.ts:267-320`, which enqueues NER and ignores the returned `SummaryJobResult.summaryMeta` |

### 2.2 What the path omits, versus its three siblings

`summary.processor.ts:272-333` uses `mapSmrGenerateResponse` **without** `parseSmrUsageDetail`, and injects neither `usageLedgerService` nor `unitOfWorkService`.

Every other summary-producing path writes `SummaryMeta` **and** `usageLedgerService.recordUsage` inside the SAME transaction:

| Writer | Location |
|---|---|
| `SummaryService.persistSummaryMetaWithUsage` | `summary.service.ts:600-653` |
| `ComprehensiveSummaryProcessor` | `comprehensive-summary.processor.ts:223-237` + `:433-484` |
| `ChainSummaryService` | `chain-summary.service.ts:446-478` |
| `ContextService` | `context.service.ts:570-617` |

The transactional coupling is deliberate — `summary.service.ts:587-590`: *a `SummaryMeta` that rolls back must not leave a billed event behind.*

### 2.3 Why the missing `SummaryMeta` row matters beyond provenance

`SummaryMeta` is a **metering and quota surface**, not a bookkeeping table:

| Consumer | Evidence |
|---|---|
| Quota / entitlements (HTTP 429) | `metering.service.ts:193,211` counts `SummaryMeta` in-window → `MeterUsage.summaries` → `entitlements.service.ts:84` (`monthlySummaries`) → `assertMeterQuota` (`:253-254`) → `QuotaExceededException` (`:240`). Asserted on the sync path at `summary.service.ts:269,412`. Kill-switch gated at `entitlements.service.ts:127-129`. |
| Persisted usage meters | `metering.service.ts:107` — `upsertMeter(..., UsageMeterMetric.SUMMARIES, ...)` → `TenantUsageMeter` |
| Shadow metering / drift alerting | `shadow-metering.service.ts:84-89` compares ledger `LLM_TOKENS` rollups vs `sumSummaryMetaTokens`; alerts past 2% (`metering.descriptors.ts:129`) |
| Tenant / platform metrics | `tenant.service.ts:1401` (`summaries24h`), `platform-metrics.service.ts:130`; `usage-analytics.service.ts:40-42` documents the deliberate reliance on `SummaryMeta` |

Invoices are priced from `AiUsageRollupDaily` (`billing.service.ts:460-481`), which is fed by the ledger — so the billing impact arrives through the missing `recordUsage`, and the quota impact through the missing `SummaryMeta`.

## 3. Impact

| Dimension | Effect |
|---|---|
| **Billing** | Summaries generated asynchronously produce no `AiUsageEvent` → no `AiUsageRollupDaily` → **no invoice line**. Unbilled consumption of paid LLM capacity. |
| **Quota** | Async summaries never count toward `monthlySummaries`, and never trigger `assertMeterQuota`. A tenant can exceed its plan ceiling indefinitely by using the async endpoint. |
| **Observability** | `summaries24h`, platform metrics and usage analytics all under-report. |
| **Shadow metering** | Because BOTH sides (ledger and `SummaryMeta`) are absent, the 2% drift detector stays silent — the gap is invisible to the existing alerting. |
| **Provenance (TASK-635)** | Agent lineage (`sessionAgentId`, `sessionAgentPromptVersion`) has no row to live in on this path. Prompt-side R-N2 behavior is correct (TASK-635 C6); only the record is missing. |

**Exposure is not hypothetical**: enqueue site 2 fires from the automatic pipeline, so tenants who never call the async endpoint directly can still generate unmetered summaries.

## 4. Why TASK-635 did not fix it

Deliberate scope decision, recorded as TASK-635 B-13. Both candidate fixes change live metering output:

- **Mirror the sibling** (write `SummaryMeta` + `recordUsage`) → first-ever billable ledger rows on this queue → **new invoice lines for existing tenants**, retroactive in effect from the deploy date.
- **`SummaryMeta`-only write** → avoids invoices but raises every tenant's `monthlySummaries` (429s the moment the entitlements kill-switch is on) and creates a permanent ledger-vs-`SummaryMeta` gap that shadow metering reports as drift.

Neither is a silent bugfix; both are business decisions. Hence this ticket.

## 5. Owner decisions required before implementation

| ID | Decision | Options |
|---|---|---|
| **D-1** | Should the async summary path count toward `monthlySummaries` (quota)? | (a) Yes — align with the sync path; tenants near their ceiling begin seeing 429s that they do not see today. (b) No — formally exempt it and document why. |
| **D-2** | Should it emit billable usage-ledger rows? | (a) Yes — align with all four sibling writers; new invoice lines appear from the deploy date. (b) No — formally document the async path as non-billable. |
| **D-3** | Backfill? | (a) None — fix forward only. (b) Reconstruct historical usage from `ContextItem`/job records for a bounded window. Note: without `SummaryMeta` rows, token counts for past runs are unrecoverable — only counts could be reconstructed, not billable token volume. |
| **D-4** | Rollout guard | Recommend landing behind a kill-switch (`redis-flag` tier, default OFF per rule 09) so metering can be enabled per environment and rolled back without a deploy. |

Recommendation: **D-1(a) + D-2(a) + D-3(a) + D-4**, because the current state is a revenue and plan-integrity leak, and the sync/async split is invisible to customers — two callers doing the same clinical action should not be metered differently. Confirm with finance/product before shipping D-2(a), since it changes invoices.

## 6. Implementation sketch (after decisions)

1. Inject `IUsageLedgerService` + `CoreUnitOfWorkService` (+ `SummaryMetaRepository`, `SecretsService` for field encryption) into `SummaryProcessor`, mirroring `ComprehensiveSummaryProcessor:433-484` exactly.
2. Parse SMR usage with `parseSmrUsageDetail` (the processor currently discards it) so token counts are real, not estimated.
3. Write `SummaryMeta` + `recordUsage` in ONE transaction; on metering failure, follow the sibling's degrade path (persist the meta alone rather than losing the summary).
4. Stamp the TASK-635 lineage columns via `formatSessionAgentPromptVersion` (`prompt/live-agent-lineage.ts`) — reuse, do not re-implement.
5. Add `assertMeterQuota` at enqueue time, not in the worker: rejecting at `POST :id/summary/async` returns a 429 the caller can act on, whereas a worker-side throw only dead-letters the job. Check the auto-pipeline site's behavior separately — it has no caller to receive a 429.
6. Guard the whole behavior behind the D-4 kill-switch.
7. Verify: unit tests for the transaction + degrade path; an e2e asserting one async summary produces exactly ONE `AiUsageEvent` and ONE `SummaryMeta` (no double-metering vs the sync path); a shadow-metering assertion that ledger and `SummaryMeta` agree afterwards.

## 7. Verification criteria

- [ ] Decisions D-1..D-4 recorded in this README before code is written
- [ ] Exactly one `SummaryMeta` and one ledger event per async summary (no double-count when the auto-pipeline and a manual call race)
- [ ] Quota enforcement observable at the enqueue site (429), with the auto-pipeline path's behavior explicitly decided
- [ ] Shadow-metering drift between ledger and `SummaryMeta` stays within threshold after the change
- [ ] Kill-switch defaults OFF and is documented in the settings registry
- [ ] `pnpm --filter @arcaai/applications test build` green; e2e added

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-08 | Ticket created from TASK-635 B-13 / NEW-1. Full evidence chain captured (path liveness, sibling comparison, `SummaryMeta` consumer map, impact). Status Pending — blocked on owner decisions D-1..D-4. |
