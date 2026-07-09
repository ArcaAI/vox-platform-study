# TASK-466 — apps/api + apps/smr Consumption of Harness Idempotency/Escalation (TASK-458 receiver half, DISCOVERED)

- **Status**: Pending (discovered during TASK-458 implementation — awaiting prioritization)
- **Type**: bugfix (reliability, observability) + cross-service coordination
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 2 follow-up (pairs with [TASK-458](../TASK-458-Harness-Idempotency-Escalation/README.md))
- **Origin**: TASK-458 fixed the **harness (sender) half** of C1-03/C1-04/C1-05. Three receiver-side consumption gaps remain — the harness now sends the right signals, but apps/api / apps/smr don't consume them yet.
- **Severity**: Med
- **Branch (when scheduled)**: `fix/task-466-harness-callback-consumption`
- **Size**: M

## Requirement Analysis

TASK-458 (landed on the harness side) now emits:
1. **An escalation record** — `POST {internal}/consultations/{id}/escalation` (body `tenantId/reason/escalationCount/terminal/jobId`). **This apps/api route does not exist yet** — the harness activity's fail-safe swallows the 404, so an SLA breach still notifies no one until the endpoint lands. It also carries the terminal `gate_sla_abandoned` signal (C1-02's abandon).
2. **An `Idempotency-Key` header** on the five WORM/draft callbacks (`persist_draft`, `finalize_assurance`, `record_gate_decision`, `report_progress`, `report_assurance_event`). **apps/api must consume it to actually dedup** the WORM/draft writes — otherwise a retried callback still double-writes.
3. **SMR generate**: TASK-458 closed the in-process re-send and the activity-observable retry, but a pure worker **crash** mid-`generate` (activity dies without raising) can still re-invoke SMR. **Fully closing needs SMR-side idempotency** — an idempotency key the `apps/smr` `/api/v1/generate` service honors.

### Acceptance criteria

- [ ] **AC-1 (C1-05 endpoint — apps/api)**: add `POST /api/v1/internal/consultations/:id/escalation` (behind the harness service-token guard) that persists/notifies the gate SLA breach (and the terminal `gate_sla_abandoned`). Verify the harness→api hop end-to-end (the 404-swallow becomes a real record).
- [ ] **AC-2 (C1-03 dedup — apps/api)**: the WORM/draft callback handlers read `Idempotency-Key` and dedup (a retried callback with the same key is a no-op that returns the prior result). Cover with a test: same key twice → one write.
- [ ] **AC-3 (C1-04 SMR idempotency — apps/smr)**: `apps/smr` `/api/v1/generate` accepts + honors an idempotency key so a worker-crash re-invoke returns the prior generation instead of billing a second one. Harness passes the key (TASK-458 already sends it on retries; confirm the wire field).
- [ ] **AC-4**: `pnpm test:unit` (apps/api) + `pnpm py:smr-v2:test` green; the cross-service contract is covered.

### Non-goals

- The harness side (done in TASK-458). The escalation NOTIFICATION channel (email/pager) beyond persisting the record — scope at prioritization.

## Current State Evaluation (from TASK-458's implementer, 2026-07-09)

Harness sends: escalation POST (route missing in apps/api), `Idempotency-Key` header on 5 callbacks (apps/api ignores it), and the SMR key on generate retries (apps/smr doesn't honor it). See TASK-458 §STOP-and-report.

## Implementation Plan

_Deferred — pending prioritization. apps/api (endpoint + dedup) + apps/smr (idempotency) — coordinate as one cross-service ticket or split by service. Standard TDD._

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-458's three STOP-and-report coordination items (escalation endpoint, WORM dedup, SMR idempotency). Harness sender half done; this is the apps/api + apps/smr receiver half. Awaiting prioritization. |
