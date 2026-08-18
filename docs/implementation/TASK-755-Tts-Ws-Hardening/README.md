# TASK-755 — TTS WebSocket hardening (CSWSH origin check + `tts_session` mint branch)

| | |
|---|---|
| **Status** | **Completed** |
| **Owner** | Platform / API gateway |
| **Created** | 2026-08-18 |
| **Classification** | `bugfix` — defence-in-depth (P2; see §Severity) |
| **Related** | `docs/architecture/api-design-conformance-review.md` §1 scorecard row R3, §3.4 items 5-6, §4 sequencing row 3 · `docs/architecture/api-controller-inventory.md` §5 (`TtsWsGateway`, *"No Redis tenant-binding cross-check"*) · **TASK-754** (the STT sibling — P0, in progress) · TASK-610 (the CSWSH/origin posture being copied) · TASK-615 (the TTS quota close `4429`) |

---

## Requirement Analysis

### The two gaps

`apps/api/src/modules/speech/tts-ws.gateway.ts` — note the path: the gateway lives in
**`modules/speech/`**, not `modules/streaming/` where its STT counterpart sits. Grepping
`modules/streaming` for the TTS gateway finds nothing, which is part of why these two gaps went
unnoticed while the STT path was hardened twice.

| # | Gap |
|---|---|
| **G-1** | **No `Origin` / CSWSH check at all.** Browsers do not apply CORS to the WebSocket handshake, so nothing upstream has checked `Origin` by the time this gateway runs. `SttWsGateway` grew a fail-closed, registry-backed check under TASK-610; `TtsWsGateway` never got one. |
| **G-2** | **`tts_session:*` is the only stream-ticket scope prefix with no ownership branch at mint.** `POST /api/v1/auth/stream-ticket` checks `consultation_*`, `stt_session:`, and `workflow_run:` before issuing. A `tts_session:<anything>` scope is minted unconditionally for any authenticated caller. |

### Severity — deliberately lower than TASK-754, and why

State this plainly so the two tickets are not conflated:

**There is no pre-existing server-side TTS session resource to hijack.** Unlike STT — where
`POST …/stream/session` creates a real upstream session, records a binding, and hands back a
`sessionId` that a colleague could steal — the TTS `sessionId` is an **opaque, client-chosen string**
with no server-side row, no Redis binding, and no prior existence. The gateway's own header comment
says so (`tts-ws.gateway.ts:50-54`): *"Unlike STT there is no server-side session resource to own"*.
Each connect calls `openBridge()` (`:207`), which opens **its own** upstream socket keyed to that
socket's `Bridge` entry (`bridges: Map<WebSocket, Bridge>`, `:105`). Two connections with the same
`sessionId` get two independent bridges; neither can see, steal, or displace the other's audio.

Therefore:

- **G-2 cannot produce a hijack**, because there is nothing to take over. A caller minting
  `tts_session:whatever` is minting a ticket for a session that will only ever exist as *their own*
  socket. The ticket already carries the minting caller's `userId`/`tenantId`
  (`StreamTicketService.IssueTicketInput`), is single-use, and expires in 30 seconds.
- **G-1 is a real but bounded CSWSH exposure.** A hostile page can open the socket only if it can
  also obtain a ticket, which requires a same-origin authenticated HTTP call to
  `POST /auth/stream-ticket` — and that call *does* sit behind the HTTP CORS gate. The gateway also
  ships `credentials: false` on the CORS side, so a cross-origin socket carries no ambient
  credentials to ride.

**These two changes close a defence-in-depth layer; they do not fix an active exploit.** Do not
carry TASK-754's P0 urgency across to this ticket, and do not let this ticket's lower severity be
used to argue TASK-754's was overstated — the difference is structural, not a matter of degree.

What the changes *do* buy: the two WS surfaces stop diverging (one operator-visible origin posture
across both, one greppable pair of log reasons), and the mint plane stops having a hole shaped like
"the one scope prefix nobody checks" — the kind of asymmetry that becomes exploitable the moment
someone gives TTS a server-side session resource.

### Acceptance criteria

- **AC-1** `TtsWsGateway.handleConnection` runs a fail-closed `Origin` check **first**, before
  `sessionId`/`ticket` parsing, with semantics identical to `SttWsGateway`.
- **AC-2** Enforcement on/off is read from the **same** switch as the HTTP CORS path
  (`isOriginEnforcementEnabled()` in `apps/api/src/cors.config.ts`) — never re-resolved locally. The
  WS gate can never disagree with the HTTP gate about whether enforcement is on.
- **AC-3** Absent / empty / throwing registry ⇒ **deny**, under the existing greppable
  `origin_registry_unavailable` reason. No bootstrap fallback.
- **AC-4** A **missing** `Origin` header is allowed (non-browser caller; CSWSH is by definition an
  attack that rides a victim browser's auto-attached header).
- **AC-5** An origin rejection closes with the gateway's existing generic `4401`
  (`TTS_WS_CLOSE_CODES.AUTH_FAILED` / `TTS_WS_GENERIC_AUTH_REASON`) — **not** a new code, and not the
  quota `4429`.
- **AC-6** `tts_session:*` gets an explicit branch at mint that states and enforces what *can* be
  enforced, and documents in code why it is not an ownership lookup (there is no resource to look
  up). See §Design decision.
- **AC-7** No behavioural change to the quota pre-flight (`4429`), the init-frame enrichment, the
  binary passthrough, or the usage-ledger teardown frame.

---

## Current State Evaluation

All line numbers opened and verified in the working tree on **2026-08-18**.

### G-1 — `TtsWsGateway` has no origin handling whatsoever

`grep -n "origin\|Origin" apps/api/src/modules/speech/tts-ws.gateway.ts` returns **zero matches**
across all 468 lines. `handleConnection` (`:136-177`) goes straight to
`url.searchParams.get('sessionId')` / `get('ticket')` (`:137-139`), consumes the ticket (`:147`),
checks the scope (`:152-155`), runs the `monthlyTtsCharacters` pre-flight (`:165-175`), then opens
the bridge (`:176`). There is no point at which `req.headers.origin` is read.

`apps/api/src/modules/speech/speech.module.ts` imports `TenantTtsConfigServiceModule`,
`AiProviderConnectionServiceModule`, `UsageLedgerServiceModule`, `EntitlementsServiceModule` — and
**not** `OriginRegistryServiceModule`. `IOriginRegistry` is therefore not injectable into this
gateway today.

### The STT reference implementation being copied

`apps/api/src/modules/streaming/stt-ws.gateway.ts`:

| Element | Verified location |
|---|---|
| `IOriginRegistry` injected `@Optional()` | `:245-252` (constructor) |
| `isOriginAllowed()` — doc comment + body | `:342-435` (method signature at `:381`) |
| Switch read from the HTTP CORS path | `:397` — `if (!isOriginEnforcementEnabled()) return true;` (imported `:18` from `../../cors.config`) |
| Registry absent ⇒ deny | `:401-408` |
| Registry present but empty ⇒ deny | `:410-417` |
| Lookup throws ⇒ deny | `:427-435` |
| Invocation, **first** in `handleConnection`, before `sessionId`/`ticket` parsing | `:452-461` |
| Missing `Origin` ⇒ allow | `:452` — the `typeof origin === 'string' && origin.length > 0` guard |
| Module wiring | `apps/api/src/modules/streaming/streaming.module.ts:49` (`OriginRegistryServiceModule`) |

**Discrepancy — correcting the framing.** The conformance review §3.4 item 5 says *"STT's own
comments argue the paths should be aligned"*. Read in the source, those comments argue for alignment
between the **WS handshake and the HTTP CORS path** (`cors.config.ts`) — `:359` *"THIS IS
DELIBERATELY ALIGNED WITH THE HTTP CORS PATH"*, `:374` *"Aligning the two paths closes that gap and
gives an operator ONE consistent pair of log reasons across both"*. **`stt-ws.gateway.ts` contains
no mention of TTS at all** (`grep -ni tts` → no matches). The argument still transfers cleanly, and
arguably more forcefully: if the reason for the STT check is that browsers exempt WebSockets from
CORS, that reason is a property of *WebSockets*, not of STT — so it applies verbatim to
`/ws/tts/stream`. But the code does not make the STT↔TTS comparison itself, and this ticket should
not cite it as though it does.

**Stale comment noticed in passing (not in scope, flagged only):**
`streaming.module.ts:47-48` still says the gateway *"injects it `@Optional()` and fails OPEN"*. That
was reversed by TASK-610 — `isOriginAllowed` now fails **closed** on an absent registry
(`stt-ws.gateway.ts:401-408`). Correcting that comment belongs to whoever next touches that module.

### G-2 — the mint plane

`apps/api/src/modules/auth/auth.controller.ts#issueStreamTicket` (`:916-958`) runs exactly three
ownership assertions before `issueTicket`:

| Assertion | Call site | Method |
|---|---|---|
| `consultation_*:<id>` | `:931` | `assertConsultationScopeOwnership` `:980` |
| `stt_session:<id>` | `:937` | `assertSttSessionScopeOwnership` `:1026` (TASK-754) |
| `workflow_run:<id>` | `:942` | `assertWorkflowRunScopeOwnership` `:1056` |

`grep -n "tts_session" apps/api/src/modules/auth/` → **no matches**. The prefix exists only in
`tts-ws.gateway.ts:70` (`TTS_SESSION_SCOPE_PREFIX`) and its header comment at `:52`. Confirmed: it
is the only stream-ticket scope prefix with no branch at mint.

There is also **no HTTP route that creates a TTS session**. `SpeechProxyController`
(`apps/api/src/modules/speech/speech-proxy.controller.ts:67`) exposes exactly `POST speech/synthesize`
(`:251`) and `GET speech/voices` (`:390`) — no session create, no session id issuance. This is the
concrete confirmation of the severity argument above, and it is what makes the shape of the G-2 fix
a design question rather than a copy of TASK-754's.

---

## Design decision required before Step 2

**A `tts_session` branch cannot be an ownership lookup, because there is no resource to look up.**
Three honest options; pick one deliberately and record the choice here rather than letting the code
imply it:

| Option | What it does | Trade |
|---|---|---|
| **A — document-and-assert** *(recommended)* | Add the branch; assert only what is knowable: the scope is well-formed (`tts_session:` + a non-empty, bounded, character-restricted id) and the caller has an active tenant. Carry a comment stating plainly that no ownership check is possible and **why**, so the next reader does not mistake the gap for an oversight. | No new isolation; removes the "unchecked prefix" asymmetry and leaves a durable explanation |
| **B — server-issued session ids** | Give TTS a real session-create route that mints the id and records a binding, then mirror TASK-754 exactly. | Correct and symmetric, but a new API surface + client change for a hazard that does not currently exist. Over-engineering by the standard of `_karpathy.md` §2 |
| **C — leave unchecked** | Status quo. | Leaves the one prefix nobody checks; the moment TTS gains a server-side session this becomes a live hijack |

Option A is the recommendation. Option B is the right answer *if and when* TTS gains a server-side
session resource — note that dependency in the code comment so the trigger is visible.

### DECIDED — 2026-08-18: **Option A**, on the ticket's own recommendation

Recorded plainly because the choice was **delegated to this ticket's recommendation, not
independently approved by the owner**. What Option A commits the platform to, and how reversible
it is, is set out in §Implementation Summary → *Option A trade-off*. It is a code-local, additive
change with no schema, no API surface and no client change; reversing it to Option B is purely
additive on top.

---

## Implementation Plan

Ordered. RED first at every step (`.claude/rules/01-development-workflow.md` §TDD).

### Step 1 — Origin / CSWSH check on `TtsWsGateway` (G-1)

1. `apps/api/src/modules/speech/speech.module.ts` — import `OriginRegistryServiceModule`.
2. `tts-ws.gateway.ts` — inject `@Optional() @Inject(IOriginRegistry) private readonly originRegistry?: IOriginRegistry`
   as a **trailing** constructor param, matching the file's existing convention (`:114-133`) so the
   positional test fixtures keep compiling.
3. Import `isOriginEnforcementEnabled` from `../../cors.config` — **do not** re-resolve the switch
   locally (AC-2).
4. Add `isOriginAllowed(origin: string): boolean` with semantics identical to
   `stt-ws.gateway.ts:381-435`: enforcement off ⇒ allow; registry absent ⇒ deny; registry empty ⇒
   deny; lookup throws ⇒ deny; otherwise `registry.has(origin)`. Reuse the greppable
   `origin_registry_unavailable` / `origin_registry_miss` log reasons verbatim so operators get one
   vocabulary across all three surfaces.
5. Invoke it **first** in `handleConnection`, before `sessionId`/`ticket` parsing, guarded by
   `typeof origin === 'string' && origin.length > 0` (AC-4). Reject through the existing
   `this.reject(client, 'unregistered origin')` helper (`:184-192`) so the close code and reason stay
   the gateway's single generic `4401` (AC-5).

**Do not** copy STT's Redis tenant-binding cross-check. It has no counterpart here — that is the
`api-controller-inventory.md` §5 note *"No Redis tenant-binding cross-check"* being correct, not a
second gap.

**TDD — `apps/api/src/modules/speech/__tests__/tts-ws.gateway.origin.test.ts`** *(new file, named
after the existing `stt-ws.gateway.origin.task610.test.ts`)*

| RED assertion |
|---|
| Enforcement ON, registry contains the origin → handshake proceeds to ticket consumption |
| Enforcement ON, registry does **not** contain the origin → close `4401`; `consumeTicket` **never called**; no upstream socket created |
| Enforcement ON, registry **absent** (`@Optional()` not provided) → close `4401` (fail-closed) |
| Enforcement ON, registry `size() === 0` → close `4401` |
| Enforcement ON, `registry.has()` **throws** → close `4401`, no unhandled rejection |
| **No `Origin` header** → allowed through (non-browser caller) |
| Empty-string `Origin` → allowed through (same guard) |
| Enforcement **OFF** → allowed through, and the registry is **never consulted** |
| The origin check runs **before** ticket consumption — assert ordering, not just the outcome, so a later refactor cannot silently move it after the ticket burn |
| Rejection close code/reason are byte-identical to the missing-ticket and scope-mismatch rejections (no enumeration signal) |

### Step 2 — `tts_session:*` branch at mint (G-2)

`apps/api/src/modules/auth/auth.controller.ts` — add `assertTtsSessionScopeOwnership` (or, under
Option A, a more honest name such as `assertTtsSessionScopeShape`) alongside the three existing
assertions, called from `issueStreamTicket` after the `stt_session:` call at `:937`. Mirror the
existing methods' structure: prefix guard → early return for other scopes → fail-closed
`NotFoundException` on rejection, never a 403 and never a distinguishable message.

Carry the design decision as a code comment: what is checked, what is **not**, and the precise
reason (no server-side TTS session resource; each connect opens its own socket-keyed bridge) — plus
the trigger that would make Option B necessary.

**TDD — `apps/api/src/modules/auth/__tests__/auth.controller.stream-ticket.test.ts`** *(extend)*

| RED assertion |
|---|
| A well-formed `tts_session:<id>` from an authenticated caller with an active tenant → minted, scope preserved |
| A malformed / empty-suffix `tts_session:` scope → `NotFoundException`, `issueTicket` **never called** |
| A caller with **no active tenant** → `NotFoundException`, no mint |
| Non-`tts_session:` scopes are unaffected — assert the three existing branches still behave exactly as before (regression guard on the shared mint path) |
| The rejection message is identical to the `stt_session` / `consultation_*` rejections |

### Step 3 — Documentation

- `docs/architecture/api-controller-inventory.md` §5 `TtsWsGateway inbound`: record the origin check
  as step 1 of the connect sequence, and keep the *"no Redis tenant-binding cross-check"* note with
  its reason attached so a future reader does not re-file it as a gap.
- Append the outcome to the conformance review §3.4 items 5-6 and the §1 scorecard R3 row; do not
  overwrite the finding text.

---

## Verification Criteria

- [ ] `pnpm --filter @arcaai/api test:unit` green — new origin suite plus the extended mint suite
- [ ] Existing TTS suites unbroken: `tts-ws.gateway.test.ts`, `tts-ws.gateway.quota.task615.test.ts`,
      `speech-proxy.controller.test.ts`, `speech-proxy.controller.quota.task615.test.ts`
- [ ] `pnpm api:build` green
- [ ] `pnpm lint` — no new errors in `apps/api`
- [ ] Every RED assertion was **observed failing** before its implementation existed
- [ ] Inspection: the enforcement switch is read from `cors.config.ts`, with **no** second source of
      truth in the speech module (AC-2)
- [ ] Inspection: the origin rejection reuses `TTS_WS_CLOSE_CODES.AUTH_FAILED`; no new close code was
      introduced and `4429` behaviour is untouched (AC-5, AC-7)
- [ ] Inspection: no Redis tenant-binding cross-check was copied over from STT
- [ ] The Option A/B/C decision is recorded in §Design decision **and** restated in the code comment

---

## Implementation Summary

**Completed 2026-08-18.** Both gaps closed, TDD (RED observed on every new assertion before the
implementation existed). G-2 was implemented as **Option A — document-and-assert**, on this
ticket's own recommendation; see the trade-off note below, which is written for an owner who may
want to revisit it.

### Files changed

| File | Change |
|---|---|
| `apps/api/src/modules/speech/tts-ws.gateway.ts:5` | Import `IOriginRegistry` from `@arcaai/applications` |
| `apps/api/src/modules/speech/tts-ws.gateway.ts:19` | Import `isOriginEnforcementEnabled` from `../../cors.config` — the switch is READ, never re-resolved (AC-2) |
| `apps/api/src/modules/speech/tts-ws.gateway.ts:134-139` | `@Optional() @Inject(IOriginRegistry) originRegistry?` as the **trailing** constructor param (positional test fixtures keep compiling) |
| `apps/api/src/modules/speech/tts-ws.gateway.ts:141-213` | `isOriginAllowed(origin)` — semantics identical to `stt-ws.gateway.ts:381-435`: enforcement off ⇒ allow (registry never consulted); registry absent ⇒ deny; `size() === 0` ⇒ deny; `has()` throws ⇒ deny; otherwise `has(origin)`. Log reasons `origin_registry_unavailable` / `origin_registry_miss` reused verbatim (AC-3) |
| `apps/api/src/modules/speech/tts-ws.gateway.ts:215-235` | Invocation **first** in `handleConnection`, before `sessionId`/`ticket` parsing, guarded by `typeof origin === 'string' && origin.length > 0` (AC-1, AC-4); rejects through the existing `this.reject(client, 'unregistered origin')` so the close stays the generic `4401` (AC-5) |
| `apps/api/src/modules/speech/speech.module.ts:4,30-36` | `OriginRegistryServiceModule` imported (with the fail-CLOSED note) |
| `apps/api/src/modules/auth/auth.controller.ts:943-948` | `assertTtsSessionScopeShape(body.scope, tenantId)` called from `issueStreamTicket`, after the `workflow_run` assertion |
| `apps/api/src/modules/auth/auth.controller.ts:1077-1133` | `TTS_SESSION_SCOPE_PREFIX`, `TTS_SESSION_ID_PATTERN` (`/^[A-Za-z0-9._-]{1,128}$/`), and `assertTtsSessionScopeShape` — Option A, with the full "what is NOT checked and why" comment and the Option-B trigger (AC-6) |
| `apps/api/src/modules/speech/__tests__/tts-ws.gateway.origin.test.ts` | **New** — 12 assertions, the full RED table from §Implementation Plan Step 1 |
| `apps/api/src/modules/auth/__tests__/auth.controller.stream-ticket.test.ts:548-686` | **Extended** — new `tts_session scope shape` describe block, 10 assertions |
| `apps/api/src/modules/streaming/streaming.module.ts:44-51` | **Comment only** — the stale *"fails OPEN"* note corrected to fail-CLOSED (reversed by TASK-610; flagged in this ticket's §Current State Evaluation). Zero behavioural change; corrected here because this ticket mirrored that exact wiring comment into `speech.module.ts` and shipping a correct copy beside a wrong original is worse than fixing both |
| `docs/architecture/api-controller-inventory.md` | §5 summary row + `TtsWsGateway inbound` rewritten as an ordered 3-step connect sequence; the *"no Redis tenant-binding cross-check"* note kept **with its reason attached** |
| `docs/architecture/api-design-conformance-review.md` | §1 scorecard R3 row → 2/2 conformant (original text struck through, not deleted); §3.4 items 5-6 marked DONE with the Option-A outcome appended; §4 sequencing row 3 struck through |

### Option A trade-off — what it commits the platform to, and how reversible it is

**What was added:** `tts_session:` now has a branch at mint that requires (a) a well-formed suffix —
non-empty, ≤128 chars, `[A-Za-z0-9._-]` — and (b) an active tenant on the caller. Both shapes the
SDK actually mints (`useTtsStream.ts:101`: a `crypto.randomUUID()`, and the `tts-<epochMs>-<rand>`
fallback) are covered, and both are pinned by tests so a future SDK id change fails loudly here
rather than in production.

**What it does NOT buy — state this plainly:** *no isolation*. Any authenticated caller with an
active tenant can still mint `tts_session:<anything-well-formed>`. That is not a weakness of the
implementation; it is the honest ceiling, because there is nothing to own. What it buys is the
removal of the "one prefix nobody checks" asymmetry and a durable, in-code explanation so the next
reader does not re-file the gap or, worse, assume an ownership check exists.

**The commitment it creates:** a **grammar** for `tts_session` ids. A client that starts using an id
outside `[A-Za-z0-9._-]` (a URL-encoded value, a `/`-separated composite, an id over 128 chars) will
be refused at mint with a 404. Today's only consumer is the SDK hook, which stays inside the
grammar; a third-party consumer choosing a different id shape is the one realistic way this becomes
a breaking change.

**Reversibility — high, in both directions:**

- *Loosen / revert to Option C:* delete one call site (`auth.controller.ts:948`) and one private
  method. No schema, no migration, no API contract, no client change.
- *Upgrade to Option B:* purely additive. Add the TTS session-create route + binding, then replace
  the body of `assertTtsSessionScopeShape` with a real ownership lookup mirroring
  `assertSttSessionScopeOwnership`. The method name and call site are already in the right place —
  Option A is deliberately shaped as the seat Option B slides into.
- **The trigger is documented in the code**, not only here: the doc comment on
  `assertTtsSessionScopeShape` names *"the moment TTS gains a server-side session resource"* as the
  point at which Option A stops being sufficient.

**Owner decision still open (deliberately):** whether TTS should get a server-side session resource
at all (Option B). This ticket does not settle that and does not pre-commit to it.

### Discrepancies found in the specification

1. **AC/RED table — "The rejection message is identical to the `stt_session` / `consultation_*`
   rejections" (Step 2) is not literally satisfiable.** Those two are already different from each
   other: `stt_session` throws `'Session not found'`, `consultation_*` throws
   `'Consultation not found'`. Resolved by matching the **`stt_session`** message
   (`'Session not found'`) — the nearest sibling, and both are session scopes — and the test asserts
   equality against the `stt_session` rejection specifically rather than against both.
2. **Ticket §Current State line numbers for `handleConnection` (`:136-177`) are pre-change** and
   have shifted by the inserted origin block; the Files-changed table above carries post-change
   lines.
3. Everything else in the spec was implementable as written. Nothing in the plan had to be
   substituted, and Option A was implemented as specified — not silently swapped.

### Verification evidence

```
$ pnpm --filter @arcaai/api test
 Test Files  218 passed | 2 skipped (220)
      Tests  3093 passed | 4 skipped (3097)
   Duration  39.44s
```

```
$ pnpm api:build
 Tasks:    12 successful, 12 total
Cached:    0 cached, 12 total
  Time:    25.168s
```

```
$ pnpm --filter @arcaai/api lint
✖ 65 problems (0 errors, 65 warnings)
```

All 65 are pre-existing `eslint-comments/require-description` warnings on `eslint-disable`
directives this ticket did not touch; **0 errors**, and this ticket added no directive comments.

**RED evidence (observed before any implementation existed):**

```
$ npx vitest run src/modules/speech/__tests__/tts-ws.gateway.origin.test.ts
 Test Files  1 failed (1)
      Tests  9 failed | 3 passed (12)
```

The 3 that passed at RED are the three ALLOW paths (no `Origin`, empty `Origin`, enforcement OFF) —
they pass vacuously when no check exists at all, which is exactly why the 9 DENY/ordering
assertions are the ones that prove the check. After implementation: 12/12 green.

```
$ npx vitest run src/modules/auth/__tests__/auth.controller.stream-ticket.test.ts
 Test Files  1 failed (1)
      Tests  5 failed | 33 passed (38)
```

The 5 failures are the five rejection paths (empty suffix, illegal characters, over-long id, no
active tenant, message parity); the 4 new mint-SUCCESS assertions pass vacuously with no branch
present. After implementation: 38/38 green (10 new).

```
$ npx vitest run src/modules/speech/      # after implementation
 Test Files  6 passed (6)
      Tests  77 passed (77)
```

Confirms AC-7: `tts-ws.gateway.test.ts`, `tts-ws.gateway.quota.task615.test.ts`,
`speech-proxy.controller*.test.ts` all unbroken — the `4429` quota path, init enrichment, binary
passthrough and usage-ledger teardown are untouched.

### Verification Criteria — final state

- [x] `pnpm --filter @arcaai/api test` green (3093 passed) — new origin suite + extended mint suite
- [x] Existing TTS suites unbroken (6 files / 77 tests in `modules/speech`)
- [x] `pnpm api:build` green
- [x] `pnpm --filter @arcaai/api lint` — 0 errors, no new warnings
- [x] Every RED assertion observed failing first (output above)
- [x] Inspection: the switch is read from `cors.config.ts`; no second source of truth in the speech module (AC-2)
- [x] Inspection: rejection reuses `TTS_WS_CLOSE_CODES.AUTH_FAILED`; no new close code; `4429` untouched (AC-5, AC-7)
- [x] Inspection: no Redis tenant-binding cross-check copied over from STT
- [x] Option A recorded in §Design decision **and** restated in the code comment

---

## Change History

| Date | Change |
|---|---|
| 2026-08-18 | **Created.** Documents the two `TtsWsGateway` defence-in-depth gaps from the conformance review §3.4 items 5-6: no CSWSH `Origin` check (verified — zero `origin`/`Origin` matches in the 468-line file, and `speech.module.ts` does not import `OriginRegistryServiceModule`), and `tts_session:*` as the only stream-ticket scope prefix with no branch at mint (verified — three branches exist at `auth.controller.ts:931/937/942`, none for TTS). Severity recorded as **lower than TASK-754's** with the structural reason: TTS has no server-side session resource (`SpeechProxyController` exposes only `synthesize` and `voices`; each connect opens its own socket-keyed bridge at `tts-ws.gateway.ts:105/207`), so there is nothing to hijack. **Discrepancy corrected:** the review's claim that STT's comments argue for STT↔TTS alignment does not hold literally — those comments (`stt-ws.gateway.ts:359`, `:374`) argue for alignment with the **HTTP CORS path**, and the STT gateway never mentions TTS. The argument transfers, but is not made in that code. Status **Pending** — sequenced behind TASK-754 per conformance review §4 row 3. No source code modified. |
| 2026-08-18 | **Implemented — status Pending → Completed.** G-1: fail-closed Origin/CSWSH check added to `TtsWsGateway` (`isOriginAllowed` + first-in-`handleConnection` invocation), `OriginRegistryServiceModule` wired into `speech.module.ts`; semantics, log reasons and the `cors.config.ts` switch read are identical to the STT reference — no second source of truth. G-2: implemented as **Option A (document-and-assert)** per this ticket's recommendation — `assertTtsSessionScopeShape` in `auth.controller.ts` asserts a bounded, character-restricted id and an active tenant, and carries in-code the reason no ownership check is possible plus the trigger (a server-side TTS session resource) that would upgrade it to Option B. 22 new test assertions across a new `tts-ws.gateway.origin.test.ts` and an extended `auth.controller.stream-ticket.test.ts`, all observed RED first. **Spec discrepancy found:** the Step-2 RED row "rejection message identical to the `stt_session` / `consultation_*` rejections" is unsatisfiable as written (those two already differ — `'Session not found'` vs `'Consultation not found'`); resolved by matching `stt_session`. **Out-of-scope fix taken deliberately:** the stale *"fails OPEN"* comment at `streaming.module.ts:47-48` (flagged in §Current State Evaluation) was corrected to fail-CLOSED — comment only, zero behaviour change, done because this ticket mirrored that wiring comment into `speech.module.ts`. Docs updated: `api-controller-inventory.md` §5 (ordered connect sequence; the no-tenant-binding note kept with its reason), `api-design-conformance-review.md` §1 R3 row, §3.4 items 5-6, §4 row 3. |
