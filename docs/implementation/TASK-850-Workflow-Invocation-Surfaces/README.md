# TASK-850 — Workflow Invocation Surfaces

| Field | Value |
|---|---|
| **Status** | `In Progress` |
| **Type** | `feature` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track D |
| **Tier / Effort** | `opus` / high (auth + idempotency); `haiku` (SDK artifact regeneration) |
| **Depends on** | TASK-848, TASK-849 |
| **Blocked by** | TASK-848 and TASK-849 |

## 1. Requirement Analysis

A published workflow invocable four ways: webhook with streaming, REST + API key, SDK Vox (API key), SDK Vox-node (API key or service account). One handler; all four converge on it. **Idempotency uses Temporal natively** — `Idempotency-Key` → Workflow ID with `WorkflowIdConflictPolicy: UseExisting`, so a retried webhook JOINS the existing run rather than double-billing an LLM run. **Client disconnect never cancels the run.**

## 2. Current State Evaluation

Program finding **F-14**. **1 of 4 surfaces exists**, off by default, and `EXPOSURE_ALLOWED_PALETTES = new Set(['summarization'])` (`exposure-palette-policy.ts:61`) **explicitly refuses the `consultation` palette** — a consultation workflow cannot be REST-invoked today at all.

**⚠ Read TASK-852 §5 before touching that allow-list.** The refusal is finding C-8, a real vulnerability: the exposure route forwards caller-controlled `dto.input` verbatim with `sandbox: false`, and the interpreter's external-write suppression fires only in sandbox. **F-24** shows the palette has grown to 31 descriptors with **11** `externalWrite` — the constraint is STRONGER than its own comment claims. A realtime consultation does **not** need this plane; it has a session-bound entry point that breaks every link of the chain. Verified **false**: the claim that TASK-806 widened palettes.

## 3. Implementation Plan

The program-level step list is **[TASK-837 §4 → TASK-850](../TASK-837-AI-Platform-Consolidation-Program/README.md)**.
This section is the **lane A** expansion actually executed — the gateway invocation handler and the safe
exposure boundary. Lane B (SDK surfaces) consumes the contract in §5.

### 3.0 The design question, and the answer

The business requirement is *"a tenant publishes a consultation workflow, and their developer can run it
from an application."* `EXPOSURE_ALLOWED_PALETTES = {'summarization'}` refuses that outright, and the
refusal is finding **C-8**, a real vulnerability — not bureaucracy. Lifting the allow-list reopens it
verbatim; refusing the requirement fails the ticket.

**TASK-852 §5 already states the invariant that resolves it:**

> *consultation identity comes from the URL and is re-resolved against the caller's tenant — never from a
> caller-composed payload.*

TASK-852 preserved that invariant by having a **session-bound** entry point. Lane A generalises the same
invariant to an **invocation** entry point: consultation identity is a **path parameter**, re-resolved
against the caller's tenant, frozen into a server-owned channel the caller cannot address. The palette
boundary is then not "lifted" — it becomes **two boundaries**, and the wider one only exists on a plane
where the binding is present.

### 3.1 Steps

| # | Step | Verify |
|---|---|---|
| 1 | **Separate the run-identity channel from the payload (harness).** `InterpreterInput` / `StartWorkflowRunRequest` gain `subject: RunSubject \| None`. The dispatcher **strips** `RESERVED_RUN_IDENTITY_KEYS` from `payload` and re-stamps them from `subject`. `payload` becomes structurally incapable of carrying consultation identity, for **every** caller of the dispatcher — not only the gateway. | `harness:test` — a start request whose payload names a foreign `consultationId` reaches the workflow with that key **absent** |
| 2 | **Refuse identity keys at the composition point (gateway).** `InvokeWorkflowRequest.input` carrying any reserved key → **400**, never a silent drop (a silent drop lets a caller believe it addressed a consultation it did not). | `applications` unit — 400 with the offending key named |
| 3 | **Two boundaries, not a lifted one.** `EXPOSURE_ALLOWED_PALETTES` stays `{'summarization'}` for the **unbound** plane. A new `CONSULTATION_BOUND_ALLOWED_PALETTES = {'summarization','consultation'}` governs the **bound** plane only. `exposureBoundaryViolation(def, { consultationBound })` selects between them. | `workflow-exposure.palette-boundary.test.ts` — pins **both** sets and proves the bound set is unreachable without a binding |
| 4 | **Refuse realtime-lane graphs on either plane.** The Temporal interpreter deliberately skips `lane: 'realtime'` nodes; a graph whose only work is realtime would accept an invoke and silently do nothing. Same honesty reasoning the `stt` placeholder refusal already records. | boundary test |
| 5 | **The consultation-bound route.** `POST /consultations/:consultationId/workflows/:slug/runs`. `consultationId` is a PATH param, re-resolved with `IConsultationService.getById` (tenant-scoped; foreign/unknown → 404). The resolved `{consultationId, externalPatientId, userId}` is frozen into `subject`. | controller + service unit; cross-tenant → 404 |
| 6 | **Deterministic run id + Temporal-native idempotency.** `Idempotency-Key` → `deterministicRunId(tenantId, slug, key)` (RFC 9562 v8, SHA-256). Three layers: the durable read model (`getRun` hit ⇒ join), Temporal `id_conflict_policy=USE_EXISTING` + `id_reuse_policy=REJECT_DUPLICATE` (a **closed** run cannot be re-run under the same id — the actual double-billing hole), and the pre-existing Redis fast path. | unit: same key ⇒ one `startWorkflowRun`, `status: 'already_running'`; harness: policies asserted on the start call |
| 7 | **Two response modes on one handler.** `mode=async` (default, 202 — the shipped contract), `mode=blocking` (waits on the **same** run-event transport, hard ceiling ⇒ **504** "switch to streaming"), `mode=stream` (delegates to `WorkflowStreamService` — TASK-849 lane A's stream, never a second one). **Client disconnect never cancels**: nothing on either path calls cancel, asserted. | unit: 504 at the ceiling; disconnect ⇒ no cancel |
| 8 | **Ability + scope.** `ConsultationWorkflow:execute` (seeded for tenant admins) and a **new top-level** `workflows:execute` scope — deliberately NOT under the `workflow:` prefix, so a key holding `workflow` does not silently inherit consultation execution. | scope-registry test; route-authz matrix |
| 9 | **`POST /workflows/:slug/runs`** as the canonical unbound entry; `/invoke` retained as a delegating alias (the shipped SDK contract). | controller unit |
| 10 | Regenerate all five artifacts and run the three `:check` gates. | `api:openapi:check`, `api:portal:check`, `gen:admin:check` |

### 3.2 Scoped OUT, deliberately

- **Webhook HMAC (`t=…,v1=…`) + Redis replay window** — TASK-837 §4 step 5. It is a *credential* surface
  whose signing secret must live in Vault; it belongs with the SDK/webhook lane, not with the invocation
  boundary. Recorded as not-built rather than stubbed.
- **`lane: 'realtime'` consultation capabilities over the invocation plane.** The durable interpreter
  skips realtime nodes by construction. Rather than weaken the boundary to fake them, they stay on
  TASK-852's session-bound path. Named explicitly in §5.

## 4. Verification Criteria

See TASK-837 §4 for this ticket's verification block. Program-wide gates in TASK-837 §3.5 apply regardless.

## 5. Implementation Summary

Not started.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Ticket document created and aligned to TASK-837 §4. Not started. |
