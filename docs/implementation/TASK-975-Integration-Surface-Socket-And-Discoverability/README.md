# TASK-975 — Integration Surface: the Socket Lane & Discoverability

**Status:** Pending — plan awaiting approval (no code written)
**Type:** `feature` (+ two `bugfix` steps, C4 and D1)
**Branch:** `dev-2.2`
**Owner directive (2026-09-14):** *"review the agents and workflow integration, i can see there are
Vox-node SDK integration, but no Vox SDK Integration, the Rest API and socket is missing, the
postman is unclear also. make sure the information is useful!"*

**Depends on** TASK-965 WS-1 (`shared/versioning/IntegrationPanel`) and TASK-971 (the four lanes,
the derived example body, `/developer/invoke`). This ticket extends both; it reverses neither.

**Collides with** anything else editing `apps/admin-console/src/shared/versioning/` or
`shared/docs/`. Serialize — do not run beside a TASK-965 WS-3 lane.

**Scope boundary:** every change is inside `apps/admin-console`. No gateway route, no SDK method,
no schema and no seed changes. Nothing here alters what the platform *does* — only what it *says*.

---

## 1. Requirement Analysis

Four reported symptoms. Measured verdicts, established before any plan was written:

| # | Report | Verdict |
|---|---|---|
| 1 | "no Vox SDK Integration" | **Partly real.** The Browser lane exists and its snippets are correct, but it renders an absence note instead of a snippet on every agent whose task is not `TEXT_GENERATION` — 12 of the 26 seeded agent rows. |
| 2 | "the Rest API is missing" | **Real, as discoverability.** Three good REST surfaces exist. The Integration panel links to none of them. |
| 3 | "socket is missing" | **Real, and the only true absence.** Four WebSocket endpoints and two SDK socket clients ship today; the console documents none of them. |
| 4 | "the postman is unclear" | **Real, as presentation.** The generated collection is correct; the lane dumps it as raw JSON with no manifest and no import walkthrough. |

The directive's last clause — *"make sure the information is useful"* — is the acceptance bar:
a lane is done when a developer can copy it and make a successful call, not when it is accurate.

## 2. Current State Evaluation (measured 2026-09-14, `dev-2.2` @ `b33e1c24a`)

### What is already right — do not rebuild it

| Surface | Verdict |
|---|---|
| `IntegrationPanel` four lanes (Node · Browser · HTTP · Postman) | correct; snippets verified against the real SDK prototypes |
| `exampleBodyFromJsonSchema` + `agentContextExample` (TASK-971 B, FU-1) | correct; the body is derived, not invented |
| `buildPostmanCollection` | correct v2.1: empty `apiKey` variable, `runId` capture script, status + stream-ticket follow-ups, NER stream suppressed |
| `/developer/invoke` (8 routes, credential matrix, SSE framing, reserved keys) | correct and genuinely useful |
| `/developer/reference` (Scalar, business + admin planes, per-request entitlement) | correct |
| flat-vs-enveloped callouts | correct, and the most valuable thing on the panel |

### F-1 — the Browser lane is prose where every other lane is code

`integration-panel.tsx:339` renders `BrowserAbsence` for any task that is not `TEXT_GENERATION`.
The note is **truthful** — `@arcaai/vox` has no invoke-by-slug for TTS or batch STT — but for
`SPEECH_TO_TEXT` it describes the real path (`audio.start({ agentSlug })`) in a sentence and
supplies no snippet. Seeded distribution: 12 `TEXT_GENERATION`, 10 `SPEECH_TO_TEXT`,
2 `TEXT_TO_SPEECH`, 2 `NAMED_ENTITY_RECOGNITION`.

### F-2 — the two halves of the integration story do not link to each other

`IntegrationPanel` links to exactly one destination, `/api-keys`
(`integration-panel.tsx:95`, used at `:364` and `:524`). It never references `/developer/invoke`,
`/developer/reference` or `/developer/sdk`.

Worse in the three workflow early-return states (`:408` not active, `:421` not exposable,
`:445` exposure 404): those render an `Alert` and **nothing else** — no lanes, no links. A
developer whose workflow sits on a non-`core` palette is told it cannot be exposed and is handed
no onward path at all.

Compounding it: `/developer` lives in `USER_MENU_ENTRIES` (`nav-config.ts:970`) — the topbar
avatar menu — and `/developer/reference` / `/developer/sdk` have no nav entry at all, reachable
only by in-page links from a page that reads as account chrome. See **OQ-1**.

### F-3 — the socket contract is absent from the console, and half-told where it is told

Shipping today:

| Surface | Where | Handshake |
|---|---|---|
| `/ws/stt/stream` | `apps/api/src/modules/streaming/stt-ws.gateway.ts:260` | `?sessionId=&ticket=`, scope `stt_session:<id>` |
| `/ws/workflows` | `apps/api/src/modules/streaming/workflow-ws.gateway.ts:48` | `?slug=&runId=&ticket=`, scope `workflow_run:<runId>` |
| `/ws/tts/stream` | `apps/api/src/modules/speech/tts-ws.gateway.ts:138` | `?sessionId=&ticket=`, scope `tts_session:<id>` |
| `/stt` (legacy compat) | `apps/api/src/modules/stt-compat/stt-compat.gateway.ts:31` | `X-API-Key` + `?sessionId=` |
| `transport?: 'sse' \| 'socket'` | `packages/vox-node/src/resources/workflows.ts:155` | on `streamRun` / `waitForRun` / `runAndStream`; default `'sse'` |
| `useWorkflowRun({ transport })`, `WorkflowRunSocketClient` | `packages/agentic-sdk-v2/src/hooks/useWorkflowRun.ts:222` | browser half |
| `RealtimeSttSocket`, `hope.stt.*` | `packages/vox-node/src/core/realtime-stt-socket.ts:168`, `resources/stt.ts:65` | events `transcript` / `status` / `error` / `resumed` / `close` |
| `SttWebSocketClient` | `packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts` | ticket in query, replaced on reconnect |

Two stream-ticket routes exist, taking **different credential classes**:

- `POST /auth/stream-ticket` — JWT only, caller-supplied scope, 30s TTL (`auth.controller.ts:927`)
- `POST /workflows/:slug/runs/:runId/stream-ticket` — **API key and service account reachable**,
  scope derived server-side, returns the `url` to open (`workflows.controller.ts:356`)

Console coverage: `ws://`, `wss://` and `RealtimeSttSocket` return **zero** hits across
`apps/admin-console/src`. The only three occurrences of `socket` in the documentation surfaces are
code that removes it (`integration-panel.tsx:61,471`; `postman-collection.ts:59,218`).

The sharpest part: the stream ticket **is** documented, at `invoke-guide-screen.tsx:56,133,406`
and in the generated collection — but exclusively as the `EventSource`/SSE mechanism
(`GET {url}?ticket=`). The same ticket authenticates the WebSocket handshake on all three modern
gateways. Documenting half of a mechanism is worse than omitting it: a developer reading it
concludes the ticket is an SSE concept.

And the console already knows better — its own live-transcription playground drives
`SttWebSocketClient` including ticket refresh on reconnect
(`features/playground-live-transcription/api/use-live-stt-session.ts:16,281`). A working
reference implementation sits in the same repository as the docs that never mention WebSockets.

### F-4 — the Postman lane is correct and unreadable

`PostmanLane` (`integration-panel.tsx:163`) renders a download button, then the entire collection
as raw JSON in a `<pre>`. There is no manifest of the requests inside, so learning that the file
contains "Invoke X" and "Invoke X (stream)" costs ~200 lines of reading. The import walkthrough
exists (OD-4, `/developer/invoke`) and is not linked.

Same-panel contradiction: the Postman lane injects the **real** gateway origin
(`publicEnv.apiHost`), while the HTTP lane two tabs away instructs
`export HOPE_API_URL="https://your-gateway.example.com"` (`sdk-snippets.ts` `CURL_ENV_LINES`).
Two different answers to one question. Additionally, with `NEXT_PUBLIC_API_HOST` unset the
downloaded collection ships `http://localhost:8868` (`public-env.ts:12`) with nothing saying so.

### Explicitly NOT findings — checked, and correct as they stand

- **`socket` filtered from the `?mode=` badges** (`integration-panel.tsx:61,471`) is *right*:
  TASK-971 recorded that socket is a lane, not a `?mode=` value. The defect was never the filter —
  it was filtering the mode and then never documenting the lane. The filter stays; it gains the
  comment it lacks.
- **`tts_session:` has no ownership branch** in `issueStreamTicket`. Deliberate and documented:
  `assertTtsSessionScopeShape` is a shape check by design (`auth.controller.ts:966`), and
  `assertKnownScopeNamespace` rejects unknown namespaces last. Not this ticket's business.
- **`socket` across `features/workflow-studio/`** means graph port connectors, not networking.
  A false positive; leave it alone.

## 3. Implementation Plan

Five lanes. A is the cheapest and highest-value; B is the largest; C, D, E are independent of one
another and may run in parallel once A has landed.

### Lane A — cross-links (the smallest change that answers symptom 2)

| Step | Work |
|---|---|
| A1 | `IntegrationPanel` gains a shared footer link row beside `ApiKeysLink`: `/developer/invoke` ("the direct HTTP contract"), `/developer/reference` ("every route"), `/developer/sdk` ("both SDKs"). |
| A2 | Render that row in the **three workflow early-return states too** (`:408`, `:421`, `:445`). A developer told "not exposable" must still be handed the onward path. |
| A3 | `/developer/invoke` gains the reverse pointer: the generated Postman collection is downloaded from a published agent's or workflow's **Integration** tab. |

### Lane B — the socket lane (answers symptom 3)

| Step | Work |
|---|---|
| B1 | **NEW** `shared/docs/socket-snippets.ts` — same documentation-surface rules as `sdk-snippets.ts` (template literals only, never read a real env var; `shared/docs/` is already an exempt directory for `env-sync`). |
| B2 | Workflow variant gains a fifth tab **Socket**: `transport: 'socket'` on `streamRun`/`waitForRun`/`runAndStream`, the run-scoped ticket the Postman lane **already mints**, `useWorkflowRun({ transport: 'socket' })` on the browser half. |
| B3 | The Socket lane states the two facts a snippet cannot: **SSE is the only lane that resumes** (so socket is for a buffering proxy, not a default), and `globalThis.WebSocket` is required — `SocketUnavailableError` (`vox-node/src/core/errors.ts:370`) refuses to fall back silently, so Node 22+ is a hard floor. |
| B4 | `SPEECH_TO_TEXT` agent variant: the Browser absence note keeps its honest framing and **gains a real `audio.start({ agentSlug })` snippet**; a Socket tab documents `hope.stt.*` + `RealtimeSttSocket` (events `transcript`/`status`/`error`/`resumed`/`close`) for a server that already has audio. Reference implementation to mirror: `use-live-stt-session.ts`. |
| B5 | Keep `socket` out of the `?mode=` badges and out of the Postman modes, and add the comment saying **why** — that it is a lane, not a mode, and where that lane is now documented. |

### Lane C — Postman legibility (answers symptom 4)

| Step | Work |
|---|---|
| C1 | `PostmanLane` renders a **request manifest** above the file: one row per item — name · method · path — derived from the same `collection.item` array, so it can never drift from the JSON. |
| C2 | The raw JSON moves behind a collapsed disclosure. It stays present and complete: reading it before importing is the only way to see for yourself that no credential travels with it. |
| C3 | Link the import walkthrough (`/developer/invoke`) from the lane, and show the `baseUrl` the file will carry. |
| C4 | **bugfix** — the curl lane derives its base URL from `publicEnv.apiHost`, like the Postman lane, so the two tabs stop disagreeing. |

### Lane D — the invoke guide correction

| Step | Work |
|---|---|
| D1 | **bugfix** — `STREAM_TICKET_EXAMPLE` and its prose currently present the ticket as SSE-only. Correct it to **SSE *and* WebSocket**, and name the two minting routes with their different credential classes. |
| D2 | A companion table for the WebSocket surfaces: `/ws/workflows` and `/ws/stt/stream`, with their query-param handshake and scope shape. |

### Lane E — the SDK screen

| Step | Work |
|---|---|
| E1 | `sdk-screen.tsx` `@arcaai/vox-node` card gains `hope.stt.*` + `RealtimeSttSocket`; the `@arcaai/vox` card gains the socket transport. Both point at the panel's Socket lane rather than restating it. |

### 3.1 TDD test list (RED first)

| # | Test | Asserts |
|---|---|---|
| T1 | `integration-panel.test.tsx` | the panel links to `/developer/invoke`, `/developer/reference` and `/developer/sdk` — in the agent state, the workflow state, **and all three workflow early returns** |
| T2 | `integration-panel.test.tsx` | the workflow panel offers a Socket lane naming `transport: 'socket'` and the run-scoped stream-ticket route |
| T3 | `integration-panel.test.tsx` | the Socket lane states the Node-22 floor and that SSE is the only resuming lane |
| T4 | `integration-panel.test.tsx` | an STT agent's Browser lane carries a real `audio.start({ agentSlug })` snippet, not prose alone — and still never invents a TTS one |
| T5 | `integration-panel.test.tsx` | **regression guard**: `?mode=` badges and the Postman collection still exclude `socket` |
| T6 | `integration-panel.test.tsx` | the Postman lane renders one manifest row per `collection.item`, and still embeds no credential |
| T7 | `integration-panel.test.tsx` | the curl lane and the Postman collection agree on the base URL |
| T8 | `socket-snippets.drift.test.ts` (**NEW**, mirrors `sdk-snippets.drift.test.ts`) | every `hope.<resource>.<method>` named exists on the real `@arcaai/vox-node` prototype, and every `@arcaai/vox` hook/class named is exported from `@arcaai/vox/core`. This is the test that keeps a socket doc from rotting the way F-A1 did. |
| T9 | `invoke-guide-screen.test.tsx` | the stream-ticket section names WebSocket as well as SSE, and both minting routes |
| T10 | axe | 0 violations on the now five-tab panel, both themes |

### 3.2 Verification criteria

- `pnpm --filter @arcaai/admin-console build lint test` green (paste output).
- **Runtime pass** (`next-dev-loop`, live stack): publish an agent and a workflow, walk all five
  lanes, and actually **open a socket run** — the lane is not done because it renders, it is done
  because the snippet works. Per TASK-971's own lesson, the runtime pass is what found FU-1.
- Both themes; keyboard pass over the tab list.

## 4. Open Questions — owner decision needed before the relevant step

| # | Question | Recommendation |
|---|---|---|
| **OQ-1** | Should `/developer` return to the nav rail? It was moved to the user menu by **TASK-788 phase A** (`72024b7dc`) and that is pinned by `nav-config.test.ts:80` ("no longer surfaces the developer portal or the account page from the rail"). | **Leave it.** Lane A solves the discoverability problem without reversing a deliberate IA decision, and the rail move was made for reasons this ticket has not re-examined. Revisit only if Lane A proves insufficient. |
| **OQ-2** | Document the legacy `/stt` gateway (`X-API-Key`, path `/stt`)? | **Omit.** It is a compat surface; documenting it invites new consumers. |
| **OQ-3** | `/ws/tts/stream` is **voice**-selected, not agent-selected, so it does not belong on a published TTS agent's Integration panel. Document it on `/developer/sdk` only? | **Yes** — SDK screen only. Putting it on the agent panel would contradict the (correct) "no browser path by slug" note. |

## 5. Implementation Summary

*(to be filled on completion — files changed, tests added, runtime evidence)*

## 6. Change History

| Date | Entry |
|---|---|
| 2026-09-14 | Ticket opened. Review completed against `dev-2.2` @ `b33e1c24a`: four reported symptoms measured, three confirmed real (one as discoverability, one as presentation, one as a true absence), one partly real. Socket inventory mapped across gateway + both SDKs. Three would-be findings checked and dismissed (the `?mode=` socket filter, the `tts_session:` ticket branch, workflow-studio "socket"). Plan drafted; status Pending pending approval of the plan and OQ-1..OQ-3. |
