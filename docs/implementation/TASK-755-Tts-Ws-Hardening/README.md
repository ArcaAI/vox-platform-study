# TASK-755 — TTS WebSocket hardening (CSWSH origin check + `tts_session` mint branch)

| | |
|---|---|
| **Status** | **Pending** |
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

**pending** — no code written. To be filled in after the Verification Criteria have been run and
their output captured, and must record which of Options A/B/C was chosen for G-2 and on whose
decision.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-18 | **Created.** Documents the two `TtsWsGateway` defence-in-depth gaps from the conformance review §3.4 items 5-6: no CSWSH `Origin` check (verified — zero `origin`/`Origin` matches in the 468-line file, and `speech.module.ts` does not import `OriginRegistryServiceModule`), and `tts_session:*` as the only stream-ticket scope prefix with no branch at mint (verified — three branches exist at `auth.controller.ts:931/937/942`, none for TTS). Severity recorded as **lower than TASK-754's** with the structural reason: TTS has no server-side session resource (`SpeechProxyController` exposes only `synthesize` and `voices`; each connect opens its own socket-keyed bridge at `tts-ws.gateway.ts:105/207`), so there is nothing to hijack. **Discrepancy corrected:** the review's claim that STT's comments argue for STT↔TTS alignment does not hold literally — those comments (`stt-ws.gateway.ts:359`, `:374`) argue for alignment with the **HTTP CORS path**, and the STT gateway never mentions TTS. The argument transfers, but is not made in that code. Status **Pending** — sequenced behind TASK-754 per conformance review §4 row 3. No source code modified. |
