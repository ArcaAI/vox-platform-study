# TASK-467 — STT WS Gateway: ws@8 Control-Frame Classification (defect #1 from TASK-455)

- **Status**: **Completed** — the classifier fix landed on `fix/2605-review` @ `45b3ae08` (`fix(task-467): route ws@8 frames by isBinary …`), then [TASK-457](../TASK-457-Redis-Consumer-Groups/README.md) merged on top (`b2645dc6`, `--no-ff`) and reconciled the gateway to its grace-window/consumer-groups version with this isBinary fix folded in. Gateway unit suite green (61) at the merged HEAD.
- **Type**: bugfix (realtime control channel)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) — discovered follow-up
- **Origin**: "Defect #1" surfaced by [TASK-455](../TASK-455-Streaming-E2E-Eval-Harness/README.md) §"Two defects surfaced by this gate" and its 2026-07-10 baseline run. Filed informally to "TASK-457/454 owners". At authoring time TASK-457 was Pending and its manifest didn't enumerate the classifier fix, so this got its own ticket; TASK-457 subsequently implemented the identical isBinary fix as part of its consumer-groups branch, and the two were reconciled in the `b2645dc6` merge (TASK-457's more complete version won; this ticket records the standalone fix + its test-infra fix). The live resume e2e was flipped GREEN by TASK-457, not here.
- **Branch**: `fix/2605-review`
- **Size**: S (one-line classifier change + tests + docs)

## Requirement Analysis

Over a **real** WebSocket, the STT gateway's entire JSON control channel (`stop` / `resume` / `close`, plus the JSON `audio` fallback and `UNKNOWN_TYPE` handling) is dead. Restore it.

**Root cause.** `apps/api` runs `ws ^8.21.0`. In **ws v8** the `WebSocket` `message` event delivers **both** text and binary frames as a Node `Buffer`, and signals which via a **second `isBinary: boolean` argument** — a breaking change from ws v7, where a text frame arrived as a `string` and a binary frame as a `Buffer`. `SttWsGateway.handleMessage` classified frames with `Buffer.isBuffer(rawData)` ([apps/api/src/modules/streaming/stt-ws.gateway.ts:537](../../../apps/api/src/modules/streaming/stt-ws.gateway.ts) pre-fix), so **every** `{type:'stop'|'resume'|'close'|'audio'}` **text** control frame matched `Buffer.isBuffer` and was misrouted into the binary-audio branch; the JSON `switch` never ran.

**Impact is production, not just e2e.** The SDK sends control frames as text and audio as binary:
- `sendStop()` → `ws.send(JSON.stringify({type:'stop'}))`, `sendClose()` → `{type:'close'}`, `sendResume()` → `{type:'resume',…}` ([packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts:394,402,947](../../../packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts))
- `sendAudioFrame()` → `ws.send(ArrayBuffer)` (binary), unaffected.

So over a real socket, **client-driven finalize (`stop`), graceful `close`, and the D-17 `resume` handshake were all silent no-ops**; audio still flowed. Sessions could only finalize via VAD silence / the STT inactivity reaper.

## Current State Evaluation

TASK-455's real-socket e2e harness proved the defect directly (baselines):
- `{type:'close'}` did **not** close the socket (readyState stayed OPEN); an unknown `{type:'__probe__'}` drew **no** `UNKNOWN_TYPE` reply — the JSON path is never reached.
- resume-after-drop: `finding_control_frames_ignored: true`, `reconnectMessageTypesFromGateway: ["transcript","status"]` (no `resumed`/`resume_failed`).
- backpressure-recovery: `reachedClosedStatusAfterStop: false`.

Scope boundary — **this ticket fixes frame CLASSIFICATION only.** It is independent of [TASK-457](../TASK-457-Redis-Consumer-Groups/README.md) (Redis consumer-groups transport). After this fix a reconnect resume is *answered*, but the per-connection resume buffer still does not survive a drop (`handleDisconnect` deletes the `SessionInfo` and removes the upstream session), so replay-from-`lastSeq` / no-duplicate-flood remains the TASK-457 target. Per TASK-455's "No regression contract", the resume-spec `test.fixme('TARGET TASK-457 …')` "also requires fixing defect #1 so the resume frame is actually processed" — this ticket delivers that prerequisite; the `test.fixme` stays until TASK-457 lands.

## Implementation Plan (TDD — executed)

1. **RED** — new unit block in `stt-ws.gateway.test.ts` feeding control frames in their real ws@8 wire form (a `Buffer` with `isBinary=false`): assert `stop`→`finalize`, `resume`→`resumed`/`resume_failed`, `close`→removeSession+socket close, unknown→`UNKNOWN_TYPE`; and a binary frame (`isBinary=true`) still forwards audio. → 4 fail against `Buffer.isBuffer`.
2. **GREEN** — gateway: pass `isBinary` from the `message` listener into `handleMessage`; branch on `isBinary` (`true`→audio Buffer, else `data.toString()`→JSON). Update the existing binary-frame test call sites to the new `(Buffer, true)` contract.
3. Correct the now-stale "control frames are ignored" narrative in both TASK-455 baseline specs; add a live assertion that the control channel is answered.
4. Verify: gateway suite, full API unit suite, `build:api`, lint.

## Implementation Summary

**Product fix** — [apps/api/src/modules/streaming/stt-ws.gateway.ts](../../../apps/api/src/modules/streaming/stt-ws.gateway.ts):
- `handleConnection` message listener now forwards the event's second arg: `client.on('message', (data: Buffer, isBinary: boolean) => this.handleMessage(client, data, isBinary)…)`.
- `handleMessage(client, rawData, isBinary = false)` branches on `isBinary` (`true` → `forwardAudioFrame`; else `rawData.toString()` → `JSON.parse` → the existing `audio`/`stop`/`resume`/`close`/`UNKNOWN_TYPE` switch). Default `isBinary=false` fails loud on bad JSON rather than silently forwarding a control frame as audio. `Buffer.isBuffer` is no longer used as a frame classifier.

**Tests** — [apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts](../../../apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts):
- New `describe('TASK-467 — ws@8 text control frames arrive as Buffer + isBinary=false')` (5 tests) — the regression guard.
- Six existing binary-frame call sites updated to `handleMessage(client, buf, true)` (they relied on the removed heuristic).

**E2e narrative + one live assert** (cannot be run without a live STT stack — see Verification):
- [task-455-streaming-resume-after-drop.spec.ts](../../../apps/api/tests/e2e/task-455-streaming-resume-after-drop.spec.ts) — corrected the "gateway never processes the handshake" narrative; added Invariant #2: the reconnect resume now draws a reply, i.e. `expect(baseline.finding_control_frames_ignored).toBe(false)`. The TASK-457 `test.fixme` (replay-from-lastSeq, no duplicate flood) is **unchanged**.
- [task-455-streaming-backpressure-recovery.spec.ts](../../../apps/api/tests/e2e/task-455-streaming-backpressure-recovery.spec.ts) — corrected the "`{type:stop}` is a no-op" comment/notes; `reachedClosedStatusAfterStop` stays **recorded, not asserted** (post-fix it hinges on the upstream finalize emitting `closed`, not on frame classification).

**Test-infra fix (bundled, called out)** — [vitest.config.ts](../../../vitest.config.ts): added `.claude/**` to `SHARED_EXCLUDE`. Claude Code's throwaway agent worktrees under `.claude/worktrees/` were being scanned by the root unit runner (double-counting every suite; `ERR_MODULE_NOT_FOUND` on copies without resolved deps), breaking the documented `pnpm test:unit` gate. `projects[]`-config vitest ignores CLI `--exclude`/`--dir`/positional filters, so the per-project `SHARED_EXCLUDE` is the only lever. `.claude/` is untracked and never a source root.

### Files changed

| File | Change |
|---|---|
| `apps/api/src/modules/streaming/stt-ws.gateway.ts` | **Product fix**: classify frames by ws@8 `isBinary`, not `Buffer.isBuffer` |
| `apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts` | New TASK-467 regression block (5); 6 binary call sites → `(Buffer, true)` |
| `apps/api/tests/e2e/task-455-streaming-resume-after-drop.spec.ts` | Narrative correction + control-channel-answered assertion (needs live stack) |
| `apps/api/tests/e2e/task-455-streaming-backpressure-recovery.spec.ts` | Narrative correction (comment/notes only) |
| `vitest.config.ts` | Exclude `.claude/**` from unit discovery (test-infra) |

### Verification evidence

- **Gateway unit suite** (RED→GREEN): before the fix, the 4 control-frame tests FAIL (`× stop TEXT frame …`, `× resume …`, `× close …`, `× unknown …`) against `Buffer.isBuffer`; after the fix:
  ```
  ✓ apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts
   Test Files  1 passed (1)
        Tests  56 passed (56)
  ```
- **Full API unit suite** (no regressions):
  ```
   Test Files  122 passed (122)
        Tests  2056 passed (2056)
  ```
  (run: `pnpm exec dotenv -e .env.test -- vitest run apps/api`)
- **Build** (`pnpm build:api`): `Tasks: 8 successful, 8 total`.
- **Lint**: `stt-ws.gateway.ts` → 0 errors. Test file is eslint-ignored (test glob). The two e2e specs sit OUTSIDE the API lint glob (`{src,apps,libs,test}/**` — note `test`, not `tests`) and carry pre-existing prettier violations (44 + 7 at HEAD); this change adds **0** new (verified HEAD-vs-now).
- **Live e2e — NOT run here.** No STT stack in this session. To confirm the resume-spec Invariant #2 and refresh the baselines, run against a live stack:
  ```bash
  RESET_DB=false E2E_WAIT_SERVICES=true npx dotenv -e .env.test -- \
    npx playwright test task-455 --workers=1
  ```
  Expected post-fix deltas: resume spec `finding_control_frames_ignored → false`, `reconnectMessageTypesFromGateway` includes `resumed`; backpressure spec's stop no longer a no-op.

### Coordination with TASK-457 (read before scheduling TASK-457)

TASK-457's manifest also edits `stt-ws.gateway.ts` and rewrites pins in `stt-ws.gateway.test.ts`. After this ticket lands: the gateway already classifies by `isBinary` (TASK-457 builds its grace-window/sessionId-keyed resume on top — no conflict, different regions), the resume-spec already asserts the control channel is answered, and the `test.fixme('TARGET TASK-457 …')` is the remaining gate — TASK-457 drops its `.fixme` and turns `c3_01_duplicate_flood → false` / replay-from-`lastSeq` green, as TASK-455's "No regression contract" specifies.

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Fixed defect #1 from TASK-455: `SttWsGateway.handleMessage` classified WS frames with `Buffer.isBuffer`, but ws@8 delivers TEXT frames as Buffer too — so `stop`/`resume`/`close` text control frames were misrouted as binary audio and the JSON control channel was dead over a real socket. Now branches on the `message` event's `isBinary` arg (TDD: 4 RED control-frame tests → GREEN; 56 gateway / 2056 API unit tests pass; `build:api` 8/8). Corrected the now-stale defect narrative in both TASK-455 baseline specs + added a control-channel-answered assertion to the resume spec (live e2e not run in-session). Bundled a test-infra fix: excluded `.claude/**` (Claude Code worktrees) from the vitest unit runner, which was breaking `pnpm test:unit`. Status → Review. |
| 2026-07-10 | Follow-up: the flagged lint-glob gap (the two e2e specs — and 57 others — sat outside the `apps/api` lint glob) is addressed in [TASK-468](../TASK-468-API-E2E-Lint-Glob-Coverage/README.md). Those two TASK-455 specs were reformatted there by the e2e `eslint --fix` sweep; the TASK-467 control-channel assertion + narrative are unchanged. |
| 2026-07-10 | Reconciliation (concurrent-agent merge): the classifier fix was committed @ `45b3ae08`, then [TASK-457](../TASK-457-Redis-Consumer-Groups/README.md) merged (`b2645dc6`) with the identical isBinary fix in its consumer-groups branch. The merge kept TASK-457's more complete gateway (grace-window resume + `WS_RESUME_GRACE_MS`), folding this fix in; TASK-457 also flipped the resume-after-drop TARGET `test.fixme` to a live GREEN gate (superseding this ticket's interim control-channel-answered assertion). Header → Completed. The still-independent `.claude/**` vitest exclude ships alongside TASK-468. |
