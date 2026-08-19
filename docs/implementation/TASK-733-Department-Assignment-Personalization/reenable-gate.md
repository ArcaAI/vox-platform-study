# TASK-733 Task 7 — Personalization re-enable gate

**Status: UNSIGNED. No verdict has been recorded for any tenant, and this ticket has not
enabled `dnaStyleEnabled` anywhere.**

This document is the checklist Phase B (Tasks 8–12) is gated on. It is assembled by an
implementing agent; the VERDICT is the data owner's, per tenant, and is recorded in §3.

---

## 1. Evidence status (verified against `feat/loop` @ `a6daa9157`, 2026-08-19)

| # | Gate condition | Status | Evidence found in the tree |
|---|---|---|---|
| 1 | TASK-700 Task 2 — DNA_ANALYSIS carries a strict `json_schema` `promptConfig` with no free-text field | **NOT VERIFIED HERE** | Requires reading the seed diff + its test; not re-verified by this pass. Owner of the evidence: TASK-700 §7. |
| 2 | TASK-700 Task 3 — `response_format` bound and the parser hard-fails instead of storing raw output | **SHIPPED** | `dna-writing-style.processor.ts` no longer contains `catch { styleText = smrResponse.content }` (grep: no match). |
| 3 | TASK-700 Task 4 — the opt-out gate sits ABOVE the `textSamples` branch | **SHIPPED** | `dna-writing-style.processor.ts:134-148` — `resolveEffectiveDnaStyleEnabled` at `:141`, the `textSamples` branch at `:148`, with the comment stating an admin/migration caller cannot use `textSamples` to override the opt-out. |
| 4 | **TASK-700 Task 6 executed** — the decrypt-and-scan reports zero name/MRN/DOB/drug+dose matches, per tenant | **NOT RUN** | HUMAN-GATED there and here. No scan output exists. **This is the row that blocks every tenant.** |
| 5 | TASK-710 Task 5 — the DNA corpus is fully redacted before the model call, fail-closed | **NOT VERIFIED HERE** | Requires the TASK-710 integration test; not re-verified by this pass. |
| 6 | §2.7's ungated injection path is closed | **CLOSED** (by other work already on `feat/loop`) | `apps/api/src/modules/streaming/text-proxy.controller.ts:1041-1045` now routes through `IDnaWritingStyleService.getEffectiveStyleText` and injects only `effectiveStyleText`; the ownership check at `:1005-1030` is retained. TASK-733 Task 8 is therefore already satisfied — no change was needed. |
| 7 | A reset path exists and is reachable by the clinician (INV-240) | **SHIPPED** (by other work already on `feat/loop`) | `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts:279` (`@Delete('my-style')`) and `:301` (`@Delete(':reportId')`). TASK-733 Task 10 is therefore already satisfied. |

Related, also already satisfied: **Task 9** (`failMode` declaration). `pipeline.descriptors.ts:54-76`
declares `dnaStyleEnabled` as `'closed'` with the discrepancy written down in full. No change needed.

## 2. What is still open in Phase B

| Task | State | Why |
|---|---|---|
| 11 — node-level DNA opt-in on the synthesis node | **BLOCKED** | The consultation palette (TASK-731) has not landed: the node registry (`packages/workflow-contract/src/node-registry.ts`) carries `summarization` and `stt` only. Building a synthesis-node config against a palette that does not exist would be the speculative build §3.3 warns about. |
| 12 — re-derivation script for pre-containment profiles | **NOT AUTHORED** | Phase B is gated on row 4, which has not been run. Authoring it is cheap; running it against PHI is the human-gated act. Deferred with the gate. |

## 3. Verdict (to be completed by the data owner)

| Tenant | Scan date | Scan result | Verdict (GO / NO-GO) | Signed by | Date |
|---|---|---|---|---|---|
| _(none recorded)_ | | | | | |

**Re-enabling for a tenant marked GO is a `PipelinePolicy` write at tenant scope
(`dnaStyleEnabled = true`) by a `manage:PipelinePolicy` holder — the same mechanism
`seed/14-pipeline-policy.ts:79` uses for ArcaAI today. This ticket does not flip it for
any tenant.** A tenant whose scan comes back dirty stays off until Task 12's re-derivation
has run for it and the scan has been re-run clean.

Note the scope limit restated from README §1.4: the clinician-initiated reset is NOT
INV-170's consent-revocation erasure cascade, and must not be described as satisfying it.
