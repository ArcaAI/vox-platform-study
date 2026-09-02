# TASK-850 — Workflow Invocation Surfaces

| Field | Value |
|---|---|
| **Status** | `Review` |
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

**Lane A is complete.** A tenant's published **consultation** workflow is now invocable by that
tenant's developer, and finding **C-8 is closed harder than it was before** — the payload channel
that carried the vulnerability cannot carry identity at all any more, for any caller.

### 5.1 The C-8 chain, link by link

C-8 was a chain of four. Breaking any one closes it; this change breaks three and turns the
fourth into a non-issue.

| C-8 link | What it is now | Where |
|---|---|---|
| **1. `consultationId` from caller-controlled `dto.input`** | **BROKEN, structurally.** Identity travels on `InterpreterInput.subject`, a field no request shape can write. `sanitize_run_payload` strips every `RESERVED_RUN_IDENTITY_KEYS` entry from the payload and re-stamps the server's, **unconditionally** — no branch on sandbox, palette or caller. At the composition point the gateway additionally **400s** on a reserved key rather than dropping it silently. | `interpreter/models.py`, `api/endpoints/interpreter.py`, `exposure-palette-policy.ts` |
| **2. `sandbox: false`, so external-write suppression never fires** | **Still true, and no longer load-bearing.** Suppression answered *"may this run write?"*; the binding answers *"WHERE may it write?"* — one row the caller was already authorised for. A boolean could never have expressed that, which is why the fix is a binding and not a flag. | `RunSubject` |
| **3. `consultation.persistDraft` reaches the shared activity** | **Unchanged, and now the FEATURE.** It writes to the caller's own consultation. All 13 `run_identity(...)` call sites plus the consent gate read `run_payload` exactly as before — and can only ever see server-stamped values. | untouched |
| **4. API-key reachable; `paletteKey` is free text** | **Narrowed.** The gate still resolves NODE types, never the declared palette. `EXPOSURE_ALLOWED_PALETTES` is **unchanged** (`{'summarization'}`); a second set `CONSULTATION_BOUND_ALLOWED_PALETTES` applies **only** on a plane where the binding exists. Plus `execute:ConsultationWorkflow` and a **new top-level** `workflows:execute` scope — deliberately outside the `workflow:` prefix, since scope matching is by prefix and a key holding bare `workflow` must not inherit a clinical-write plane. | `exposure-palette-policy.ts`, `consultation-workflow-runs.controller.ts` |

**The allow-list was NOT lifted.** It is byte-identical, and a test pins it.

### 5.2 What was built

| Area | Change |
|---|---|
| Harness | `RunSubject` + `RESERVED_RUN_IDENTITY_KEYS` + `sanitize_run_payload` (`interpreter/models.py`); dispatcher strips/re-stamps and declares `id_conflict_policy=USE_EXISTING` + `id_reuse_policy=REJECT_DUPLICATE` |
| Applications | `CONSULTATION_BOUND_ALLOWED_PALETTES`, plane-aware `exposureBoundaryViolation`, realtime-only refusal, `reservedIdentityKeysIn`, `deterministicRunId`, consultation re-resolution, durable idempotent join; `ConsultationWorkflowDispatchService` moved to `subject` |
| API | `POST /workflows/:slug/runs` (canonical) + `/invoke` alias; `ConsultationWorkflowRunsController`; `deliverRun` (one response-mode implementation); `WorkflowStreamService.awaitTerminal` |
| Auth | `workflows:execute` scope; `execute:ConsultationWorkflow` seeded for tenant admins |

### 5.3 Two live findings this verification produced

Both are **pre-existing local-dev defects**, found only because the run was real:

1. **The Temporal worker imports the PRIMARY checkout, not the invoking worktree.**
   `scripts/dev-service.sh worker` runs `python -m harness.temporal.worker` with **no `--app-dir`
   and no `PYTHONPATH`**, so `harness` resolves through the conda editable install's `.pth` — an
   absolute path into the primary tree. This is exactly the hazard `14-multi-agent-worktrees.md`
   §4 documents for pytest, and the `pythonpath` fix applied there **does not cover the worker**,
   because it lives in pytest config. It surfaced here as
   `InterpreterInput.subject: extra_forbidden` — the worker running code that predated the field.
   A worktree agent changing interpreter models will otherwise test the wrong source and see a
   green suite.
2. **`HARNESS_CLAIM_CHECK_STORE` defaults to `memory` while the gateway always writes to MinIO.**
   `WorkflowExposureService` mints the compiled-config claim-check into MinIO unconditionally, so
   on a default dev box every exposure-plane invoke starts a run whose config the interpreter
   cannot load (`ClaimCheckNotFound`). Pre-dates this ticket (TASK-722's path).

### 5.4 Deployment ordering — a hazard this change introduces

`InterpreterInput` is `extra="forbid"`. Adding `subject` is safe for **replay** (an old history
lacks the field and the default applies — the 19 replay-compat tests pass), but it is **not**
safe for a dispatcher that outruns its worker: a NEW harness API sending `subject` to an OLD
worker fails **every** run at argument decoding. **Roll the Temporal worker before the harness
API and the gateway.** The reverse order is safe.

### 5.5 Scoped out, named rather than stubbed

- **Webhook HMAC + replay window** (TASK-837 §4 step 5) — a Vault-backed credential surface; it
  belongs with the webhook lane, not the invocation boundary. Not built, not stubbed.
- **Realtime-lane consultation capabilities over this plane** — the durable interpreter skips
  `lane: 'realtime'` nodes, so a realtime-only graph is refused on BOTH planes rather than
  accepted and silently no-op'd. Those capabilities stay on TASK-852's session-bound path.
- **Service accounts cannot reach either plane** (`svcScopes: []`), matching the pre-existing
  exposure plane: `svc:*` is the PLATFORM machine identity, and declaring one on a route that
  writes a tenant's clinical rows is the credential-space mixing the TASK-708 ruling forbids.

---

## 5.6 Lane B — the SDK invocation surfaces

Lane A built the gateway. **Lane B is the surface a developer writes code against**, and the
requirement it answers is the owner's: *"the developer will utilize the SDK Vox or Vox-node for
implementing the features."* Both SDKs speak the routes lane A shipped — no new endpoints, no
second contract.

### 5.6.1 What shipped

| Package | Surface |
|---|---|
| `@arcaai/vox-node` | `hope.workflows` — `list` · `run` · `runAndWait` · `runAndStream` · `getRun` · `cancelRun` · `streamRun` · `waitForRun`.<br>`hope.consultations.workflows` — `list` · `run` · `runAndWait` · `runAndStream`. |
| `@arcaai/vox` | `useWorkflowRun()` — `workflows` · `start` · `watch` · `events` · `status` · `isRunning` · `fetchStatus` · `cancel` · `stopWatching` · `lastEventId`. Exported from `/core` (no audio, no ML). |

Both planes share one engine per package, for the same reason the gateway's two controllers share
one `deliverRun`: two copies would be two places for resume, the reserved-key refusal and the
blocking ceiling to drift apart.

### 5.6.2 The five things "complete" required

| # | Requirement | How |
|---|---|---|
| 1 | List what a consultation can run | `hope.consultations.workflows.list(id)` / `useWorkflowRun({ consultationId })` — the WIDER catalogue (adds the `consultation` palette) |
| 2 | Start async / blocking / streaming | `run` (202) · `runAndWait` (`?mode=blocking`) · `runAndStream` (`?mode=stream`) |
| 3 | Consume the stream and RESUME after a disconnect | Both SDKs track each frame's opaque `id` and reconnect with `Last-Event-ID` (`?lastEventId=` in the browser) |
| 4 | Retry safely and JOIN the existing run | `Idempotency-Key` header; the handle reports `already_running` when a join happened |
| 5 | Typed, actionable errors | `BadRequestError` · `PermissionError` · `NotFoundError` · `GatewayTimeoutError` · `ReservedRunIdentityError` · `CredentialClassError` |

### 5.6.3 Resume is the load-bearing part, and it is subtle in both runtimes

**Node.** The cursor advances **only on a frame that carried an `id:`**. Lane A's snapshot frame
deliberately carries none (async-contract §3.6 forbids minting a token the transport cannot resume
from) — treating that absence as "no cursor" would replay the entire retained window on every
reconnect. `runAndStream` resumes on the **run** (`GET …/runs/{runId}/stream`), never by re-POSTing:
a re-POST would start a second run, or with a key re-open a second view of the first while the SDK
already held the `runId` from the snapshot frame.

**Browser.** `EventSource` tracks `lastEventId` and replays it on ITS OWN internal reconnect — but
`SSEClient` never uses that reconnect. Every reconnect there closes the `EventSource` and builds a
new one, because each connect must mint a fresh single-use ticket, and a new `EventSource` starts
with an empty `lastEventId`. **The browser's resume was therefore being discarded on exactly the
path this client takes.** Closed with an opt-in `{ resume: true }` that appends `?lastEventId=` —
the escape hatch lane A's own controller doc names for a client that cannot set headers. Opt-in
because appending an unrecognized query parameter to every existing SSE consumer's URL would change
routes that never asked for it.

### 5.6.4 The reserved-identity refusal, and why the SDK duplicates a server check

The gateway's 400 is correct and sufficient for safety. It is a poor **teacher**: restating the
consultation id in the body is the natural mistake (you just put it in the URL), and discovering it
as an HTTP 400 costs a round trip and a guess about which field was disliked. Both SDKs refuse
before the request is issued, naming **every** offending key at once.

**The list is five, not three:** `consultationId`, `externalPatientId`, `userId`, `jobId`,
`sessionId` — taken from `exposure-palette-policy.ts`, which is the gateway's own copy of the
harness's list. A contract test reads that file off disk and asserts equality, so a fourth spelling
cannot drift silently.

### 5.6.5 Credential class: this plane is API-key only

`route-manifest.json` records `svcScopes: []` on all seven routes — deny-by-default for a service
account (§5.5 records lane A's reasoning). A service-account client would therefore get a 403 that
**no role grant can fix**, and an integrator would go looking for a scope that does not exist. Both
SDK planes refuse at the call site instead, naming the credential CLASS as the problem. This makes
`hope.workflows` the exact mirror of `hope.admin`, which is service-account only.

### 5.6.6 Two defects found while building, fixed rather than worked around

- **`504` was retryable.** `core/retry.ts` treats every 5xx as transient, and the non-idempotent-POST
  guard does not stop a POST that carries an `Idempotency-Key` — so a keyed `runAndWait` would have
  spent a second and third 60s ceiling to reach the identical answer. Added
  `nonRetryableStatuses`, a per-request opt-out checked before every other rule; blocking runs
  declare `{504}`. The 504 is a deterministic ceiling, not a transient failure.
- **`maxResumeAttempts` counted connections, not resumes**, so `streamRun` made one fewer attempt
  than asked for. The loop now takes a CONNECTION budget and each caller states its own
  (`streamRun`: resumes + 1, since it opens the first; the `runAndStream` hand-off: resumes only,
  since the POST already spent one).

### 5.6.7 A deliberate asymmetry between the two SDKs

The browser hook offers **no** `mode=blocking` and no `mode=stream` start. `blocking` would hold a
fetch open against a ~60s gateway ceiling from a UI thread; `stream` would put the run's whole event
stream on a POST the browser cannot resume (a resume must be a GET on the run). The browser starts
async and then WATCHES. The server SDK, which can hold a socket and resume off the `runId`, offers
all three. Same contract, different runtimes — stated here so the gap reads as a decision.

### 5.6.8 Contract conformance — verified, not assumed

`packages/vox-node/src/resources/__tests__/workflows.contract.task850.test.ts` reads
`apps/api/route-manifest.json` **off disk** and asserts, for every route the SDK calls: it exists,
`apiKeyForbidden: false`, `apiKeyScopes` non-empty, `svcScopes: []`, `isPublic: false`, plus the
exact scope and ability per plane. Without it the behavioural suite is only self-consistent — a
lane-A rename would leave it green. No route decorators or metadata were changed, so **no artifact
regeneration was needed or performed.**

### 5.6.9 Scoped out

- **Live-gateway verification.** The gateway was **not running on :8868** during this lane
  (connection refused). Conformance rests on the committed `route-manifest.json` and the controller
  sources, which are the authoritative artifacts; lane A already verified the same routes live
  (§5.3).
- **A `HopeClient` catalogue cache / polling fallback.** `waitForRun` uses the event stream and
  falls back to ONE authoritative `getRun` when resume attempts are exhausted — never a poll loop.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Ticket document created and aligned to TASK-837 §4. Not started. |
| 2026-09-02 | Lane A implemented. Status `Pending` -> `In Progress`. §3 expanded into the executed step list. |
| 2026-09-02 | C-8 closed structurally: `RunSubject` + `sanitize_run_payload` make the run payload incapable of carrying consultation identity, for every caller of the dispatcher. `EXPOSURE_ALLOWED_PALETTES` unchanged; `CONSULTATION_BOUND_ALLOWED_PALETTES` added for the bound plane only. |
| 2026-09-02 | Idempotency moved off the best-effort Redis cache: derived run id + `USE_EXISTING` + `REJECT_DUPLICATE`. Proven live — a retry after the run CLOSED returns `already_running` with still exactly ONE Temporal execution (previously `ALLOW_DUPLICATE` would have billed a second). |
| 2026-09-02 | LIVE verification against a real gateway, harness dispatcher, Temporal worker and the dev DB: a published consultation workflow ran (`202`, real interpreter execution); Temporal history shows `subject` carrying the server-resolved consultation and the attacker's keys absent; blocking mode hit its 60s ceiling with a 504 and also returned 200 on a fast run; a mid-stream disconnect left the Temporal execution `COMPLETED`, and `Last-Event-ID` resumed. |
| 2026-09-02 | Two pre-existing local-dev defects found by that run and recorded in §5.3 (Temporal worker imports the primary checkout; claim-check store defaults to `memory` while the gateway writes to MinIO). Deployment-ordering hazard recorded in §5.4 — roll the worker first. |
| 2026-09-02 | Webhook HMAC and realtime-lane invocation deliberately scoped OUT and named in §5.5 rather than stubbed. |
| 2026-09-02 | **Lane B implemented** — SDK invocation surfaces in both SDKs. `@arcaai/vox-node`: `hope.workflows` + `hope.consultations.workflows` (list / run / runAndWait / runAndStream / getRun / cancelRun / streamRun / waitForRun). `@arcaai/vox`: `useWorkflowRun()` exported from `/core`. See §5.6. |
| 2026-09-02 | Lane B: resume made REAL in both runtimes. Node tracks each frame's opaque `id` and reconnects with `Last-Event-ID`, advancing the cursor only on frames that carry one (the snapshot frame deliberately has none). `runAndStream` resumes on the RUN, never by re-POSTing — a re-POST starts a second run. |
| 2026-09-02 | Lane B found and closed a REAL browser gap: `SSEClient` rebuilds its `EventSource` on every reconnect (each connect mints a fresh single-use ticket), which discards the browser's own `lastEventId` — so its resume never fired on the path this client actually takes. Closed with opt-in `{ resume: true }` → `?lastEventId=`, the fallback lane A's controller doc names. All 45 pre-existing `SSEClient` tests still green. |
| 2026-09-02 | Lane B: the reserved run-identity list is **five** keys, not the three the lane brief quoted — `consultationId`, `externalPatientId`, `userId`, `jobId`, `sessionId`. Both SDKs refuse them before the request is issued, and a contract test reads `exposure-palette-policy.ts` off disk to keep the copies equal. |
| 2026-09-02 | Lane B fixed two defects found while building: `504` was retryable (a keyed `runAndWait` would have burned a second and third 60s ceiling — added `nonRetryableStatuses`), and `maxResumeAttempts` counted connections rather than resumes (the loop now takes a connection budget each caller states). |
| 2026-09-02 | Lane B: service-account clients are refused at the call site on both SDK planes, since `route-manifest.json` records `svcScopes: []` on all seven routes — a 403 no role grant can fix is a worse answer than naming the credential class. Mirror image of `hope.admin`. |
| 2026-09-02 | Lane B verification: `@arcaai/vox-node` 296 tests / 22 files, `tsc --noEmit` clean, `eslint` clean, `tsup` CJS+ESM+DTS, `check:exports` green (node10 / node16-CJS / node16-ESM / bundler) + publint "All good!". `@arcaai/vox` 4268 tests / 274 files, typecheck clean, lint clean, build green. Route decorators unchanged, so **no artifact regeneration performed**. The README usage example is an executed, type-checked test rather than prose. |
| 2026-09-02 | Lane B could NOT verify against a live gateway — nothing was listening on :8868 (connection refused). Conformance rests on the committed `route-manifest.json` + controller sources; lane A verified the same routes live (§5.3). Recorded in §5.6.9. |
