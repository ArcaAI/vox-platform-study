# TASK-469 — SMR Generate Idempotency Key (C1-04, split off TASK-458)

- **Status**: Pending
- **Type**: bugfix (reliability + cost — prevents double-billed LLM generations)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · split off from Wave 2 [TASK-458](../TASK-458-Harness-Idempotency-Escalation/README.md)
- **Finding**: C1-04 (Med, reliability-durability) — CONFIRMED — see [TASK-448 register](../TASK-448-Harness-Loop-Quality-Review/README.md). **Residual OPEN** after TASK-458's partial fix (see below).
- **Branch (when scheduled)**: `fix/task-469-smr-idempotency` (from the current `fix/2605-review` HEAD)
- **Size**: M
- **Suggested agent**: general-purpose (Python / Temporal + FastAPI)

## Why this is a split-off (read first) — what TASK-458 did and did NOT close

C1-04 ("non-idempotent SMR `generate` wrapped in a retry policy → lost response re-invokes the LLM") was in TASK-458's manifest, but TASK-458 shipped only the **in-process retry-narrowing** half:
- `smr_client.generate()` now classifies a **post-send** transport loss as `_SmrResponseLost` (marker-free) and passes `retry_on_timeout=False`, so the per-endpoint **governor never re-POSTs** after the prompt is dispatched ([smr_client.py:40-139](apps/harness/src/harness/services/smr_client.py)); the `generate` activity re-raises `after_send` as `non_retryable=True` so Temporal's `_GENERATE_RETRY` won't re-run it ([activities.py:314-330](apps/harness/src/harness/temporal/activities.py)).
- **Left explicitly open, in a code comment** ([activities.py:322-327]): *"a genuine worker CRASH mid-activity (no exception to catch), and an SMR 5xx / LM-Studio `terminated` 400 that arrives AFTER the model ran … The durable fix for both is a downstream idempotency key SMR honours — apps/smr."*

So the **cross-process** re-invoke path (worker dies after SMR ran but before the result is recorded → Temporal replays the activity → a second billable generation) is still OPEN. Closing it needs an **idempotency key on the wire** that the SMR receiver honors — which TASK-458's manifest did NOT include (`apps/smr` was never in it). This ticket is that closure, spanning the harness **sender** and the SMR **receiver**.

## 🔗 Supersedes TASK-466 AC-3 · replay-safety gate

- **[TASK-466](../TASK-466-Harness-Callback-Consumption/README.md) AC-3** ("`apps/smr` `/api/v1/generate` accepts + honors an idempotency key") is **absorbed here** — TASK-469 owns the whole C1-04 idempotency-key path (harness sender + SMR receiver). When TASK-469 is scheduled, drop AC-3 from TASK-466 (it keeps AC-1 escalation endpoint + AC-2 WORM dedup). Both tickets touch `apps/smr` if run concurrently → serialize (TASK-469 owns the `generate` endpoint edit).
- **Replay-safety**: the harness `generate` activity change is **activity-body-only** — passing an idempotency key argument does NOT alter the workflow command sequence, so **no `workflow.patched()` marker and no new replay fixture are required**. But `workflows.py` is untouched by design, and you MUST still run `test_replay_compat` after the activity change to prove the frozen histories replay. Touching `workflows.py` at all → STOP.

## File-ownership manifest (exclusive — binding)

### Harness SENDER (apps/harness)

| File | Change |
|---|---|
| `apps/harness/src/harness/services/smr_client.py` | Add an `idempotency_key: str \| None` param to `generate()`; attach it to the request (body field AND/OR `Idempotency-Key` header) |
| `apps/harness/src/harness/temporal/activities.py` | Pass `_idempotency_key(...)` (the helper already exists at [:137]) from the `generate` activity's `smr_client.generate(...)` call ([:303-313]) — a **stable** key derived from workflow_run + logical generate step so a replayed activity reuses it |
| `apps/harness/src/harness/tests/unit/services/test_smr_client.py` | RED-first: key is attached to the request |
| `apps/harness/src/harness/tests/unit/temporal/test_activities.py` | RED-first: the generate activity passes a stable key across a re-run |

### SMR RECEIVER (apps/smr)

| File | Change |
|---|---|
| `apps/smr/src/smr_v2/models/requests.py` | Add an idempotency field to `GenerateRequest` ([:21]) (and/or read the `Idempotency-Key` header in the endpoint) |
| `apps/smr/src/smr_v2/api/endpoints/generate.py` | Dedup in `generate` ([:114]) using SMR's existing Redis (`get_redis` [dependencies.py:35] / `app.state.redis` [main.py:41-45]): on a key HIT return the cached `GenerateResponse` WITHOUT invoking the provider; on success CACHE it (`smr:idem:{key}`, bounded TTL) |
| `apps/smr/src/smr_v2/tests/unit/test_generate_endpoint_e1.py` (or a new `test_generate_idempotency.py`) | RED-first: same key twice → provider invoked once, second call returns the cached response |

STOP-and-report before touching: `apps/harness/src/harness/temporal/workflows.py` (any edit — replay gate), the SMR provider/registry/rate-limit internals, `apps/api` (TASK-466's escalation endpoint + WORM dedup), `turbo.json`/barrels, or the streaming SSE `/generate` path (this ticket is the **synchronous** `/generate` only). Anything outside the manifest → STOP.

## Requirement Analysis

### C1-04 (Med) — a worker crash after SMR ran re-invokes a second billable generation
`generate()` POSTs `/api/v1/generate` with a body of `{prompt, stream:false, …}` and **no idempotency field** ([smr_client.py:100-117](apps/harness/src/harness/services/smr_client.py)). SMR's receiver ([generate.py:114-128](apps/smr/src/smr_v2/api/endpoints/generate.py)) has no dedup — every POST runs the provider and bills. TASK-458 closed the two *observable* re-send paths (governor + activity retry), but a bare worker **crash** mid-activity leaves no exception to intercept: Temporal replays the `generate` activity on recovery, the harness re-POSTs the same prompt, and — with no shared idempotency key and no receiver dedup — SMR **generates and bills a second time**, producing a divergent draft. The durable fix is an idempotency key the sender sets deterministically (so a replayed activity reuses it) and the receiver honors (so a duplicate returns the first result).

### Acceptance criteria

- [ ] **Sender (red first)**: a test asserts `smr_client.generate()` attaches the idempotency key to the request, and the `generate` activity supplies a **stable** key that is identical across a re-run of the same logical generate (so replay reuses it). Derive it via the existing `_idempotency_key(...)` helper.
- [ ] **Receiver (red first)**: a test POSTs the same key twice and asserts the provider is invoked **once** and the second call returns the **cached** `GenerateResponse` (no double-bill). On a cache miss it generates and caches under `smr:idem:{key}` with a bounded TTL.
- [ ] **End-to-end**: the harness→SMR hop carries the key; a simulated activity replay does not produce a second generation. (Confirm the wire field name matches on both sides.)
- [ ] **Replay-compat**: `pnpm py:harness:test` INCLUDING `test_replay_compat` green — the activity-body change adds no command, frozen histories still replay. `workflows.py` untouched.
- [ ] **Documented residual**: an SMR **5xx after the model ran with nothing cached** still cannot be replayed (the generation happened, no cached response to return, the retry re-invokes). This is **acceptable and matches the C1-04 intent** — the key closes the common crash-replay double-bill; the rare "model ran then SMR failed to cache" window is documented, not solved. Record it in the Implementation Summary.
- [ ] **AC-gate**: `pnpm py:harness:test` (+ `test_replay_compat`) + `pnpm py:harness:lint`/`typecheck` and `pnpm py:smr-v2:test` + `pnpm py:smr-v2:lint`/`typecheck` green; output pasted.

### Non-goals

- The harness in-process retry narrowing (done in TASK-458 — do not undo it; the key is defense on top of it).
- apps/api WORM/draft callback dedup + the escalation endpoint (TASK-466 AC-1/AC-2).
- Rotating/signed idempotency keys, or a cross-service idempotency store beyond SMR's existing Redis (a per-key cached response is sufficient).
- The **streaming** `/generate` (SSE) path — synchronous generate only.
- Solving the rare "model ran, then SMR 5xx before caching" window (documented residual, above).

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review`)

- **Sender**: `generate()` body build [smr_client.py:100-117] — no idempotency field; the `_SmrResponseLost`/`retry_on_timeout=False` machinery [:40-139] is TASK-458's and stays. The generate activity's `smr_client.generate(...)` call [activities.py:303-313]; the residual is spelled out in the comment [:322-327] pointing at "a downstream idempotency key SMR honours — apps/smr". The `_idempotency_key(...)` helper [activities.py:137] already exists (TASK-458 built it for the WORM callbacks C1-03) — reuse it.
- **Receiver**: `GenerateRequest` [requests.py:21-29] has `stream: bool = False` and no idempotency field; `generate` endpoint [generate.py:114-128] injects many deps but not Redis and does no dedup; `get_redis` [dependencies.py:35] + `app.state.redis` [main.py:41-45] are wired and available; `GenerateResponse` (the cache payload shape) is [responses.py:44](apps/smr/src/smr_v2/models/responses.py).
- **Tests**: `test_smr_client.py` + `test_activities.py` (harness) and `test_generate_endpoint_e1.py` (SMR) exist to extend; none asserts idempotency today.

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-449 §Architecture preamble (SMR `generate` sits on BOTH loops — but this fix is the **durable harness** generate; the key must be deterministic per logical generate so replay reuses it) · `.claude/rules/06-python-services.md` (Temporal determinism/replay, `X-Service-Token`, SMR receiver patterns).

1. **Receiver first** (independently testable, no Temporal): add the `GenerateRequest` field / header read → dedup via `get_redis` → cache on success. RED (same-key-twice → provider once) then GREEN.
2. **Sender**: add the `idempotency_key` param to `smr_client.generate()` (attach to request) → pass `_idempotency_key(...)` from the activity with a stable derivation. RED then GREEN.
3. **Replay**: run `test_replay_compat` after the activity change — prove no command-sequence change. Confirm the wire field matches sender↔receiver.

### Verification gate

```bash
pnpm py:smr-v2:test && pnpm py:smr-v2:lint && pnpm py:smr-v2:typecheck
pnpm py:harness:test   # MUST include test_replay_compat
pnpm py:harness:lint && pnpm py:harness:typecheck
```

Adversarial review focus: (a) is the key **stable across a replay** of the same logical generate (else it never dedups) AND **distinct across genuinely different generates** (else it wrongly returns a stale draft)? (b) does a cache HIT truly skip the provider (no bill, no side effects)? (c) is the cached response the correct `GenerateResponse` shape, with a bounded TTL (no unbounded Redis growth)? (d) is `workflows.py` genuinely untouched and does `test_replay_compat` pass (no patch marker needed)? (e) is the documented residual (model-ran-then-5xx-uncached) honestly stated, not silently claimed closed? (f) zero diff outside the manifest.

## Implementation Summary

_Pending — not yet implemented._

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Ticket scaffolded as the split-off closure of C1-04. Verified OPEN against the current `fix/2605-review` tree: TASK-458 narrowed the in-process retries (`_SmrResponseLost`/`retry_on_timeout=False`) but left the cross-process worker-crash re-invoke open — documented in code at activities.py:322-327 ("downstream idempotency key SMR honours — apps/smr"). Sender gap (no key in smr_client body :100-117; `_idempotency_key` helper already exists :137) and receiver gap (`GenerateRequest` no field :21-29; endpoint no dedup :114-128; Redis wired via get_redis) confirmed. Supersedes TASK-466 AC-3; activity-body change is replay-safe (no patch marker, still run test_replay_compat). No implementation. |
