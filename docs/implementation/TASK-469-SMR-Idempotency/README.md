# TASK-469 — SMR Generate Idempotency Key (C1-04, split off TASK-458)

- **Status**: Completed -- all ACs met + adversarial review (Critical cache-SET double-bill fix applied, +2 tests) + gates green (smr 768 / harness 665 passed incl. replay-compat, lint/typecheck clean); only the owner's own push/PR to main remains (per owner directive, they land it)
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

Closed the C1-04 cross-process residual with a deterministic idempotency key carried on the
wire as an **`Idempotency-Key` HTTP header** — mirroring the existing `api_client._headers`
sender contract and the receiver's `x_tenant_id` header read, so no `GenerateRequest` model
change was needed (the "read a header" option in the manifest). Both halves shipped TDD
RED→GREEN.

### Harness SENDER (`apps/harness`)
- `services/smr_client.py` — `generate()` gained an `idempotency_key: str | None = None`
  parameter; when set it is attached as the `Idempotency-Key` header on the POST (built once,
  passed into the governed `_send`). It is transport metadata only — never added to the LLM
  request body. TASK-458's `_SmrResponseLost` / `retry_on_timeout=False` machinery is untouched
  (the key is defense on top of it). The `SmrServiceError` docstring was updated to point the
  durable-fix reference at TASK-469 (was TASK-466) and restate the narrowed residual.
- `temporal/activities.py` — the `generate` activity now passes `idempotency_key=_idempotency_key()`,
  reusing the pre-existing helper (`activities.py:137`) that returns `workflow_run_id:activity_id`.
  That value is **stable across a worker-crash re-delivery** of the same logical activity (so a
  replay reuses it and dedups) yet **unique per logical generate** (a later regen is a different
  activity ⇒ a different key). **Activity-body-only change** — `workflows.py` is untouched, so no
  `workflow.patched()` marker and no new replay fixture; the except-block residual comment was
  updated to reflect that the key now closes the worker-crash replay path.

### SMR RECEIVER (`apps/smr`)
- `api/endpoints/generate.py` — the synchronous `/generate` endpoint now injects the shared Redis
  (`get_redis`) and reads the `Idempotency-Key` header. On a **HIT** (after the shutdown check,
  before guardrail / rate-limit / circuit-breaker / task machinery) it returns the cached
  `GenerateResponse` via `model_validate_json` **without invoking the provider** — no second model
  bill, no side effects. On a successful **MISS** it caches `response.model_dump_json()` under
  `smr:idem:{key}` with a bounded 24h TTL (`_IDEMPOTENCY_TTL_S`) before returning. **No key or no
  Redis wired → the pre-existing generation path runs unchanged** (behavior preserved; the existing
  `test_generate_endpoint_e1.py` suite — which wires no Redis — stays green). Both the cache **read
  and write are locally guarded** (review fix, below): a Redis GET error degrades to normal
  generation, and neither a GET nor a SET error can fail an otherwise-serviceable request or,
  critically, a billed generation — the dedup store is strictly best-effort.
- `models/requests.py` — **not modified**; the header-read option made a model field unnecessary
  (smaller diff, keeps transport metadata out of the generation model).

### Wire contract (confirmed matching on both sides)
`Idempotency-Key: {workflow_run_id}:{activity_id}` (header) → SMR cache key `smr:idem:{that value}`.

### TDD evidence (RED → GREEN)
- **Receiver** (`test_generate_idempotency.py`, new): RED first — same key twice invoked the
  provider **twice** and nothing was cached (`2 failed, 2 passed`). After the endpoint change:
  same key twice → provider invoked **once**, second returns the identical cached response (same
  `created_at`, full content/usage/model/status/task_id shape); no key → generates twice; distinct
  keys → generates twice; the completed response is cached under `smr:idem:{key}` with `ttl > 0`
  (`4 passed`).
- **Sender**: RED first — `smr_client.generate(idempotency_key=...)` raised `TypeError` and the
  activity's fake saw no `idempotency_key` (`2 failed`). After the change — the client attaches the
  `Idempotency-Key` header (and omits it when unset), and the activity supplies `"test-run:test"`
  (ActivityEnvironment defaults) **stably across a re-run** (`test_smr_client.py`,
  `test_activities.py::TestGenerate` green).
- **Replay-compat**: all 7 `test_replay_compat` histories replay on the current definition —
  proves the activity-body change added no workflow command.

### Review fix (best-effort cache, adversarial round) — the failure posture now holds
The first cut placed the cache **write inside the endpoint's broad `try:`**, whose `except Exception`
records a circuit-breaker failure, marks the task FAILED, and returns 502. A Redis SET failure on an
**already-successful, already-billed** generation (e.g. OOM on a large SOAP note) therefore discarded
the ready response, tripped a FALSE breaker failure, and returned a 5xx the harness retries → with a
failed SET (cache MISS) the model is **re-invoked = the exact C1-04 double-bill**. The cache **read**
was likewise unguarded (a live-but-erroring Redis → unhandled 500, not the claimed fall-through).
Fixes (`generate.py`): the SET is wrapped in its own local `try/except` that logs and falls through
to `return response` (a cache-write failure never touches the breaker / task-FAILED / 502 path); the
GET is wrapped to log + treat an error as a MISS and generate normally. Two failure-posture tests now
lock the contract in — **RED against the buggy code** (SET-fail → task `status=failed` + `502`;
GET-fail → `500`) → **GREEN after the fix** (both `200`, provider invoked once, task COMPLETED, no
false breaker failure). Also added: a debug log on a cache HIT (dedup was previously silent) and a
comment noting the key is safe un-tenant-scoped (globally-unique `run_id`; the apps/api proxy strips
client-supplied `Idempotency-Key`).

### Verification gate output
- `pnpm py:smr-v2:test` → **768 passed, 29 deselected** (e2e; incl. the 2 new failure-posture tests);
  `pnpm py:harness:test` (incl. `test_replay_compat`) → **665 passed**.
- `pnpm py:smr-v2:lint` / `pnpm py:harness:lint` → **All checks passed!**
- `pnpm py:smr-v2:typecheck` → **no issues in 45 files**; `pnpm py:harness:typecheck` → **no issues
  in 79 files**.
- (Run from the agent worktree with the worktree `src` dirs on `PYTHONPATH` to shadow the
  main-checkout editable install; commands are otherwise identical to the `pnpm py:*` scripts.)

### Documented residual (accepted — matches C1-04 intent)
The key closes the common crash-replay double-bill: a worker crash after SMR generated → Temporal
re-delivers the `generate` activity → the harness re-POSTs the **same** key → SMR returns the first
cached generation. **Still OPEN (rare, accepted):** an SMR **5xx / LM-Studio `terminated` 400 that
arrives AFTER the model ran but BEFORE the response was cached** — the governor retries it and there
is no cached result to replay, so that one window can still re-invoke. This is the narrow tail
C1-04 explicitly deems acceptable; it is not silently claimed closed (the code comments in
`smr_client.py` and `activities.py` state it too).

### Files changed
- `apps/harness/src/harness/services/smr_client.py` (param + header + docstring)
- `apps/harness/src/harness/temporal/activities.py` (pass `_idempotency_key()` + residual comment)
- `apps/smr/src/smr_v2/api/endpoints/generate.py` (Redis dep + header + HIT/cache dedup + TTL const;
  locally-guarded best-effort read & write + HIT debug log — review fix)
- `apps/harness/src/harness/tests/unit/services/test_smr_client.py` (2 sender tests)
- `apps/harness/src/harness/tests/unit/temporal/test_activities.py` (1 stable-key activity test)
- `apps/smr/src/smr_v2/tests/unit/test_generate_idempotency.py` (**new** — 6 receiver tests: 4 dedup
  + 2 failure-posture)

`workflows.py`, `models/requests.py`, apps/api, the streaming SSE path, and provider/registry/
rate-limit internals were **not touched** (within the manifest; zero out-of-manifest code diff).

### Base note
Branched from `fix/2605-review` at `87b33f57` (its HEAD at branch time). `fix/2605-review` has since
advanced by one **docs-only** commit (`60f0bbde`, SOTA scaffolding for TASK-470/471/478) that does
not touch any file in this ticket — no conflict; left for the orchestrator to rebase/merge.

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Ticket scaffolded as the split-off closure of C1-04. Verified OPEN against the current `fix/2605-review` tree: TASK-458 narrowed the in-process retries (`_SmrResponseLost`/`retry_on_timeout=False`) but left the cross-process worker-crash re-invoke open — documented in code at activities.py:322-327 ("downstream idempotency key SMR honours — apps/smr"). Sender gap (no key in smr_client body :100-117; `_idempotency_key` helper already exists :137) and receiver gap (`GenerateRequest` no field :21-29; endpoint no dedup :114-128; Redis wired via get_redis) confirmed. Supersedes TASK-466 AC-3; activity-body change is replay-safe (no patch marker, still run test_replay_compat). No implementation. |
| 2026-07-10 | **Implemented (status → Review).** Sender: `smr_client.generate()` gained an `idempotency_key` param attached as the `Idempotency-Key` header; the `generate` activity passes `_idempotency_key()` (`workflow_run:activity_id`). Receiver: `/generate` injects `get_redis` + reads the `Idempotency-Key` header, returns the cached `GenerateResponse` on a HIT without invoking the provider, and caches it under `smr:idem:{key}` (24h TTL) on a MISS; no key / no Redis → unchanged path. `requests.py` left unmodified (header-read option). TDD RED→GREEN: 4 new receiver tests (`test_generate_idempotency.py`), 2 sender client tests, 1 stable-key activity test. Gates green — `py:smr-v2:test` 766 passed / `py:harness:test` 665 passed (incl. all 7 replay-compat histories) / lint + typecheck clean both services. `workflows.py` untouched (no patch marker needed). Residual documented: an SMR 5xx after the model ran but before caching still can't replay (accepted, matches C1-04). Branched from `fix/2605-review`@`87b33f57`; that branch since advanced one docs-only commit (`60f0bbde`) — disjoint, left for orchestrator. |
| 2026-07-10 | **Adversarial-review fix (still Review).** CRITICAL: the idempotency cache SET sat inside the endpoint's broad `try:`, so a Redis write failure on an already-billed generation was caught by the `except Exception` → false circuit-breaker failure + task FAILED + 502 → harness retry re-invoked the model (re-opened C1-04). IMPORTANT-1: the cache GET was unguarded → a live-but-erroring Redis 500'd instead of falling through. Fix (`generate.py`): wrapped the SET in its own local `try/except` (log + fall through to `return response`, never the breaker/FAILED/502 path) and the GET likewise (log + treat as MISS → generate). IMPORTANT-2: added 2 failure-posture tests — RED against the buggy code (SET-fail→`status=failed`+502; GET-fail→500), GREEN after (both 200, provider once, task COMPLETED, no false breaker failure). Also: HIT debug log + un-tenant-scoped safety comment (MINOR, left as-is per review). Gates re-run: `py:smr-v2:test` **768 passed** / `py:harness:test` **665 passed** (incl. 7 replay-compat) / lint + typecheck clean both services. |
| 2026-07-11 | **Closed (Status -> Completed).** Closure-review pass (owner directive "close if finished completely and properly"): all ACs met, adversarial review found+fixed a Critical (cache-SET in a broad try re-opening the double-bill) with 2 new failure-posture tests; smr 768 + harness 665 passed (7 replay-compat) / lint+typecheck clean both services; the one residual is explicitly accepted per C1-04 intent. No external work remains -- only the owner's git push/PR to main. |
