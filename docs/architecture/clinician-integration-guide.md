# Clinician Integration Guide

How to build a clinician-facing realtime experience on HOPE, end to end: live
transcription in the browser, a consultation governed by a workflow you choose,
and the server-side half that runs workflows and receives webhooks.

Written 2026-09-03 (TASK-858 Lane E). Every route, hook and scope below was
verified against `apps/api/route-manifest.json` and the SDK source at that date.
Where something does **not** exist, this guide says so rather than inventing it —
those are the sections worth reading twice.

| | Package | Use it for |
|---|---|---|
| Browser | [`@arcaai/vox`](../../packages/agentic-sdk-v2/README.md) | The clinician's screen: capture, live transcript, live summary |
| Server | [`@arcaai/vox-node`](../../packages/vox-node/README.md) | Your backend: running workflows, receiving webhooks |

## Credentials, before anything else

Three credential classes, and each plane accepts exactly one shape:

| Plane | JWT | API key | Service account |
|---|---|---|---|
| Business (`/consultations/**`, `/workflows/**`, `/audio/**`) | yes | yes | **no** — every route declares `svcScopes: []` |
| Admin (`/admin/**`) | yes | **never** (`apiKeyForbidden`) | yes |
| Stream tickets (`POST /auth/stream-ticket`) | yes | **never** | no |

Two consequences that decide your architecture:

1. **A browser uses a JWT, not an API key.** Not because a key lacks power — a
   key can open a consultation — but because every SSE hook needs a stream
   ticket, and `POST /auth/stream-ticket` is `apiKeyForbidden`. An API key
   simply cannot open a live stream.
2. **A backend that both runs workflows and manages webhooks needs TWO clients.**
   The workflow plane is API-key-only; the webhook plane is service-account-only.
   `HopeClient` throws at construction if you pass both credentials.

```ts
const runner = new HopeClient({ baseUrl, apiKey });                    // workflows
const platform = new HopeClient({ baseUrl, serviceAccount: { clientId, clientSecret } }); // webhooks
```

`workingTenantId` binds at token **exchange** for a service account, so never
send `X-Tenant-Id` alongside one.

---

## 1. A realtime transcription agent in the browser

The narrow case: live transcript, no consultation workflow. Four steps.

### 1.1 Pick an agent

What transcribes is a **server-side decision**: the tenant's published ASR
**Agent** (task `SPEECH_TO_TEXT`, TASK-863) carries the engine, the model, the
VAD and the denoise settings. The browser captures audio and renders the result
— it never runs a model (TASK-865). List what your tenant may name:

```tsx
const { agents, tenantDefault, isLoading, refresh } = useSelectableAsrAgents();
// GET /agents?task=SPEECH_TO_TEXT — the same predicate the session route resolves with,
// so anything listed is accepted at start and anything omitted is refused.
```

Two "nothing to show" states are deliberately distinct: `agents === null` means
the read has not resolved or failed (render nothing, or a retry); `agents.length
=== 0` means the tenant has published no ASR agent and the platform default
governs. `tenantDefault` names the slug the tenant-level assignment points at —
surface it as a hint; do **not** preselect it, because a department assignment
can still win at resolution and a slug sent on every start would silently
override it.

Nothing is persisted per user: the selection is per capture. (`usePipelines`,
`select(pipelineId)` and the `selectedPipelineId` user setting are deprecated
and removed in R4, with the `AsrPipeline` resource under TASK-861.)

### 1.2 Start capture

```tsx
import type { AudioStartOptions } from '@arcaai/vox/core';

const { start, stop, transcriptSegments, currentTranscript, sttConnectionState } = useArcaAudio();

const options: AudioStartOptions = {
  agentSlug,               // optional; omit → the tenant → department assignment cascade decides
  language: 'en',
  deviceId,                // optional; exact-match getUserMedia constraint
  secondaryDeviceId,       // optional; mixed with the primary via @arcaai/room AudioMixer
};
await start(options);
```

The SDK opens and refreshes the streaming session for you — do not hand-roll
the WebSocket. `pipelineId` is **deprecated** (removed in R4): it is still
forwarded with a warning, and when both are passed `agentSlug` wins and
`pipelineId` is dropped — warned, never silent.

No client model is involved: `audio.noiseFilter` / `audio.vad` are ignored even
when `enabled: true` (a deprecation warning is logged) unless the host sets the
deprecated `audio.clientInference: { allow: true }`. Native `getUserMedia`
constraints (`noiseSuppression`, `echoCancellation`, `autoGainControl`) are not
models and stay on; disable them per capture with `audioProcessing` for raw
clinical capture.

### 1.3 Render the transcript

```tsx
transcriptSegments.map(seg => ({
  text: seg.text,
  isFinal: seg.isFinal,          // interim segments are replaced, not appended
  speaker: seg.speakerLabel,
  words: seg.words,              // [{ word, start, end, confidence }] when the engine emits them
}));

currentTranscript   // the interim string — render it separately from finalized segments
```

There is no dedicated transcript hook and the store is deliberately private;
`useArcaAudio()` is the whole public surface for live transcript.

### 1.4 Stop

```tsx
await stop();
```

### Routes behind this section

| Route | Credential | Scope |
|---|---|---|
| `GET /api/v1/agents?task=SPEECH_TO_TEXT` | JWT or API key | business plane (TASK-863) |
| `GET /api/v1/agents/{slug}` | JWT or API key | business plane (TASK-863) |
| `POST /api/v1/audio/transcription-jobs/stream/session` `{ agentSlug? }` | JWT or API key | `stt:transcription:write` (body: TASK-861) |
| `WS /ws/stt/stream` | session ticket | — (WebSocket gateways carry no manifest row) |
| ~~`GET /api/v1/audio/pipelines`~~ | deprecated | removed in R4 (TASK-861) |

Note the streaming session mints **its own** ticket
(`…/stream/session/{sessionId}/refresh-ticket`). That is a different mechanism
from `POST /auth/stream-ticket`, which serves the SSE hooks in §2. Do not
conflate them.

---

## 2. A realtime consultation, governed by a workflow you choose

The full clinician journey. A consultation is documented by one of two engines:
the platform's own loop, or a `consultation`-palette workflow your tenant
published. The assignment cascade (`department → tenant → platform-default`)
decides by default; `open()` lets you override it for one consultation.

### 2.1 Offer the choice

```tsx
const { workflows, tenantDefault, isLoading } = useSelectableConsultationWorkflows();

// workflows: [{ slug, name, description, isTenantDefault }] — every slug open() accepts
// workflows === null  -> the read has not resolved, or it FAILED
// workflows.length === 0 -> asked, and your tenant published none
// tenantDefault -> a sensible preselection
```

**`null` and `[]` are different states and must render differently.** An empty
picker on a network blip tells a clinician something false about their tenant.

`GET /consultations/workflows` answers from the same predicate that authorizes
`open`, so a slug it lists is never refused and a slug it omits is never
accepted. It needs only `create:Consultation` — the ability `open` itself needs —
so a clinician-facing app can enumerate options without being able to read the
workflow plane.

### 2.2 Open the consultation

```tsx
const { open } = useArcaSession();

await open({
  patientId,
  workflowDefinitionSlug: selected?.slug,   // omit → the cascade decides
  departmentId,                             // NOT `department` — that field is a 400
});
```

| Outcome | Status |
|---|---|
| Slug not visible to your tenant (another tenant's, unknown, or not published/active) | `404` — all three deliberately indistinguishable |
| Visible, but not a `consultation`-palette definition | `403` |
| Malformed slug (not `[a-z0-9_]{2,48}`) | `400` |

### 2.3 Confirm what actually governs it

Selecting is not running. Dispatch is **best-effort by design** — a clinician
must be able to open a consultation while the harness is down — so a dispatch
failure silently degrades to the platform default engine rather than failing the
open. Read back:

```tsx
const { workflow, isGoverned } = useConsultationWorkflow();

isGoverned            // true  -> a tenant-authored workflow is writing this document
workflow?.governed    // false -> the platform default engine is
workflow === null     // unknown — the read has not resolved, or it failed
```

Treat `null` as "we do not know", never as "the default engine governs".

### 2.4 Capture, and open the live streams

```tsx
await audio.start({ pipelineId });

const summary = useArcaLiveSummary();
const loop = useConsultationEvents();

summary.start(consultationId);
loop.start(consultationId);
```

**`useArcaLiveSummary` — full-state snapshots.** Every event is the complete
current state, so keep only the latest:

```tsx
summary.snapshot?.runningSummary      // the running SOAP text
summary.snapshot?.sections            // [{ title, content }]
summary.snapshot?.entities            // [{ text, type, confidence?, icd10?, start?, end? }]
summary.snapshot?.vitals              // { systolic?, diastolic?, heartRate?, spo2?, ... }
summary.snapshot?.textFailed          // last generation failed; content is the last good one
summary.snapshot?.closed              // terminal — recording stopped, the stream closes
```

For NER highlighting: `entities[].start`/`end` are character offsets **into
`runningSummary`**, not into the transcript. Highlight the summary with the
offsets; match on `entities[].text` if you also want to mark up the transcript.
(The SDK type's comment says "detected in the running transcript" — that is
misleading; the gateway DTO it mirrors says `runningSummary`.)

**`useConsultationEvents` — append-only loop events.**

```tsx
loop.events        // LoopEvent[], oldest first, capped at the last 500
loop.latestEvent   // { consultationId, runId?, kind, label?, data?, publishedAt }
```

`kind` is an open string namespace (`action.started`, `specialist.dispatched`,
…), not a closed enum — branch defensively. It carries **no PHI**: ids and short
labels only.

> **No resume.** A reconnect mints a fresh single-use ticket and sends no
> `Last-Event-ID`. Events published while you were disconnected are gone, and
> there is no server-side buffer for this stream. If you need a complete
> history, read it from where the loop persists its own record.

### 2.5 Grammar corrections and suggestions

The `agent.grammar` node publishes to a **fourth** stream,
`GET /api/v1/consultations/{id}/live-assist/stream` (ticket scope
`consultation_live_assist:<id>`), read with `useArcaLiveAssist`:

```tsx
const assist = useArcaLiveAssist(consultation.id);  // omit the id to drive start()/stop() yourself

assist.suggestions   // LiveAssistSuggestion[] — { suggestionId, text, category?, … }
assist.corrections   // LiveAssistCorrections | null — { proposals, applied, textSha256? }
assist.lastEvent     // the raw full-state snapshot
assist.connected     // status === 'open'
```

Each event is a **full-state snapshot carrying both branches** — the gateway
folds back the branch a publish did not carry — so keep only the latest and
never merge successive events: an absent branch means "there are none", and
re-merging resurrects withdrawn PHI. Unlike the live-summary feed there is **no
terminal event**; the client closes it (`stop()`, unmount, or an id change).

**Nothing here has been applied.** `corrections.applied` is `false` under
proposal-first — the clinician decides. Each proposal's `start`/`end` are
character offsets into the text named by `corrections.textSha256`; check that
hash against the text you are about to patch, or the offsets may land on
drifted content. The feed carries PHI: `original` quotes the clinician's own
text verbatim.

They are **not** on `useConsultationEvents` (the loop stream carries ids and
labels only) and **not** on `useArcaLiveSummary` (that DTO has no `corrections`
field).

### 2.6 Stop, and finalize

```tsx
await audio.stop();
summary.stop();
loop.stop();

const { generateSummary } = useArcaSummary();
await generateSummary({ /* … */ });   // or generateSummaryAsync for SSE progress

await session.close();
```

> **`close()`, `reopen()` and `prime()` are optimistically concurrent.** All
> three routes carry `@RequiresIfMatch()`, so the SDK echoes the strong
> validator it read with the consultation and refreshes it from the response.
> A `412` surfaces as a `ConfigConflictError` — re-load the consultation and
> retry. (`prime()` is new: previously only the route existed, and `close()` /
> `reopen()` sent no `If-Match` at all, so every call answered 428.)

### Routes behind this section

| Route | Credential | Scope / ability |
|---|---|---|
| `GET /api/v1/consultations/workflows` | JWT or API key | `consultation:session:write` · `create:Consultation` |
| `POST /api/v1/consultations/open` | JWT or API key | `consultation:session:write` · `create:Consultation` |
| `GET /api/v1/consultations/{id}/workflow` | JWT or API key | `consultation:session:read` |
| `GET /api/v1/consultations/{id}/live-summary/stream` | **JWT** (ticket) | `consultation:session:write` |
| `GET /api/v1/consultations/{id}/loop/stream` | **JWT** (ticket) | `consultation:session:write` |
| `GET /api/v1/consultations/{id}/live-assist/stream` | **JWT** (ticket) | `consultation:session:write` |
| `POST /api/v1/consultations/{id}/summary` | JWT or API key | `consultation:report:write` |
| `POST /api/v1/consultations/{id}/close` | JWT or API key | `consultation:session:write` · **If-Match required** |

`/consultations/workflows` is a static segment declared above `/consultations/{id}` —
order matters if you re-implement the routing.

---

## 3. Server-side: running workflows and receiving webhooks

### 3.1 Run a workflow

```ts
import { HopeClient, isTerminalRunStatus } from '@arcaai/vox-node';

const hope = new HopeClient({ baseUrl, apiKey });

// Unbound: does not write into a clinical record.
for await (const event of hope.workflows.runAndStream('discharge_summary', { input })) {
  if (event.type === 'workflow.node.completed') { /* … */ }
  if (event.type === 'workflow.run.completed')  { /* … */ }
}

// Consultation-bound: writes into the record. Different ability, different scope.
await hope.consultations.workflows.runAndWait(consultationId, slug, { input });
```

| | `hope.workflows.*` | `hope.consultations.workflows.*` |
|---|---|---|
| Ability | `create`/`read`/`update:WorkflowRun` | `execute:ConsultationWorkflow` |
| Scopes | `workflow:definition:read`, `workflow:run:read`, `workflow:run:write` | `workflows:execute` |
| Writes into a clinical record | no | yes |

Granting the first never implies the second — that separation is the point.

### 3.2 Three ways to run, and when each is wrong

| Call | Shape | Watch out |
|---|---|---|
| `run(slug, body)` | Returns a handle immediately | You now own the `runId`. There is no way to re-discover it (§3.4). |
| `runAndWait(slug, body)` | Blocks until terminal | The gateway's ~60s cap is a **ceiling, not a flake** — a 504 is never retried. |
| `runAndStream(slug, body)` | Async generator of frames | Resumes automatically; the right default for anything slow. |

`streamRun` and `runAndStream` track each frame's opaque `id` and reconnect with
`Last-Event-ID`, so a dropped connection costs latency, not events. Hand-rolling
this means knowing the snapshot frame deliberately carries no cursor.

Use `isTerminalRunStatus(status)` rather than comparing strings: the terminal set
includes `TIMED_OUT`, and cancellation is spelled `CANCELED` (one L).

### 3.3 Idempotency joins, it does not de-duplicate

```ts
await hope.workflows.run(slug, { input }, { idempotencyKey: key });
```

The run id derives from `(tenant, slug, key)`, so a retry with the same key
**joins the run already in flight** rather than starting — and billing — a
second one. Correct on a retry; a surprise if you reuse a key across different
payloads.

`input` may not carry the reserved run-identity keys — `consultationId`,
`externalPatientId`, `userId`, `jobId`, `sessionId`. The gateway refuses rather
than dropping them, because a silent drop would let you send `{ consultationId }`,
receive a 202, and believe you addressed that consultation while the run acted on
something else. The SDK throws `ReservedRunIdentityError` before the request
leaves.

### 3.4 You cannot list your runs

There is no business-plane run-listing route: no `GET /workflows/{slug}/runs`,
no `GET /workflows/runs`. A run is reachable only by a `runId` you already hold
(`GET /workflows/{slug}/runs/{runId}`). Listing exists **only** on the admin
plane (`GET /admin/workflow-runs`, `svc:admin:workflow-run:read`,
`apiKeyForbidden`).

Persist the `runId` at the moment you get the handle. If you lose it, an
API-key integration cannot recover it.

### 3.5 Webhooks

Subscribe with the **service-account** client:

```ts
const { webhook, rawSecret } = await platform.admin.webhookEvent.create({
  name: 'consultation-events',
  url: 'https://your-service.example.com/hooks/hope',
  resourceTypeName: 'Consultation',
});
// rawSecret is shown ONCE. HOPE stores only a hash.
```

The scope is `svc:webhook:event:write`, which predates the `svc:admin:*`
convention and is therefore **not** granted by `svc:admin:*` — request it
explicitly.

`resourceTypeName` is matched by plain string equality against the fired event's
`resourceType`, and the gateway validates it against no list. A typo is accepted
at create time and then never fires. Check `fetchDeliveries(id)` before blaming
your receiver.

The delivery body is **references, never content** — HOPE does not push resource
data, PHI included, to a third-party endpoint:

```jsonc
{ "eventType": "ResourceUpdated", "resourceType": "Consultation",
  "resourceId": "0192…", "tenantId": "5000…",
  "occurredAt": "2026-09-03T10:15:30.000Z",
  "fetchUrl": "https://api.example.com/api/v1/admin/consultations/0192…" }
```

So a receiver verifies, enqueues, and then fetches what it needs with its own
credentials.

### 3.6 Verifying a delivery

```ts
import express from 'express';
import { WEBHOOK_SIGNATURE_HEADER, verifyWebhookSignature } from '@arcaai/vox-node';

app.post('/hooks/hope', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.header(WEBHOOK_SIGNATURE_HEADER) ?? '';
  if (!verifyWebhookSignature(req.body, signature, process.env.HOPE_WEBHOOK_SECRET!)) {
    return res.status(401).end();
  }
  enqueue(JSON.parse(req.body.toString('utf8')));
  res.status(204).end();
});
```

`verifyWebhookSignature` is synchronous, dependency-free and never throws — a
malformed header, a wrong secret or a non-string argument all return `false`.
Comparison is constant-time.

Three silent failure modes:

- **Parsing before verifying.** The digest covers the exact bytes on the wire; a
  `JSON.parse` → `JSON.stringify` round trip will never match.
- **Signing with the stored value.** The key is the `rawSecret` from `create` or
  `rotateSecret`, not anything you can read back later.
- **Falling through on a missing header.** That is just an attacker omitting it.

Rotation has **no overlap window** — `rotateSecret` invalidates the previous
secret immediately — so deploy the new secret before rotating.

---

## Webhooks

### What you cannot subscribe to, and why

**There is no "workflow run completed" webhook, and adding one is not a small
change.** This was assessed in full for TASK-858 (Lane E, deliverable E2); the
conclusion is recorded here rather than half-implemented.

### The finding

A `WorkflowRun` row is created `RUNNING` at dispatch, from three reliable
Node-side sites:

| Site | Trigger |
|---|---|
| `packages/applications/src/services/workflow-exposure/workflow-exposure.service.ts:194` | `api invoke` |
| `packages/applications/src/services/workflow-sandbox-run/workflow-sandbox-run.service.ts:62` | `workbench sandbox` |
| `packages/applications/src/services/consultation/workflow-dispatch/consultation-workflow-dispatch.service.ts:204` | `consultation open` |

**Terminal status has no such site.** The only method that writes it,
`WorkflowRunService.recordRunFinished`
(`packages/applications/src/services/workflow-run/workflow-run.service.ts:319`),
has exactly two production callers — `syncTerminalStatus` in
`workflow-exposure.service.ts:369` and `workflow-sandbox-run.service.ts:156` —
and each is reachable **only** from its own `getRunStatus` read
(`workflow-exposure.service.ts:260`, `workflow-sandbox-run.service.ts:97`).

So a run leaves `RUNNING` if and only if somebody looks: a status poll, a held
SSE/blocking connection, or an admin-console refresh. A fire-and-forget invoke
whose caller never returns leaves the row `RUNNING` **forever** — precisely the
case a webhook exists to serve. And `cancelRun`
(`workflow-exposure.service.ts:265-277`) signals Temporal and broadcasts a
sys-event but never writes `status = CANCELED`, so cancellation is doubly
unserved.

The one genuine terminal *push* the platform has — the harness's
`workflow.run.completed` envelope on the Redis stream `wf:run:<runId>:events` —
is consumed by exactly one component, `WorkflowStreamService`
(`apps/api/src/modules/workflows/workflow-stream.service.ts:250`), which lives
only for the lifetime of a client HTTP connection and does not extend
`BaseService`. Nothing else subscribes.

Ruled out by search, not inference: no BullMQ processor, cron or `@OnEvent`
handler calls `recordRunFinished`; and `apps/api/src/modules/consultation/harness-internal.controller.ts`
— the Python harness's 26-route callback surface — has no workflow-run route at
all.

### There is also a written prohibition

`packages/database/src/prisma/db_main/workflow-run.prisma:33-39` states that
`WorkflowRun` carries no `ResourceType` **deliberately**, and ends: *"Do not
'fix' this by adding one."* The same exemption is restated in
`WorkflowRunEntity`, `WorkflowRunRepository` and `WorkflowRunService`. Emitting
run sys-events overturns a recorded design decision — an owner call, not a
patch.

### What is already in place, if that decision is ever made

The downstream plumbing needs **no** widening. `Webhook.resourceTypeName` is a
plain `String` (`packages/database/src/prisma/db_main/webhook.prisma:14`)
validated only by `@IsString()`, and the fan-out matches it by string equality
against `event.resourceType`
(`packages/applications/src/services/webhook/webhook-delivery.processor.ts:190-197`).
A tenant can already create a subscription naming `WorkflowRun` today — it just
never fires. The `fetchUrl` builder's kebab-plural guess also happens to produce
the correct `/api/v1/admin/workflow-runs/{id}`.

### The recommended design

1. **A background consumer of `wf:run:<runId>:events`**, mirroring
   `WorkflowStreamService.awaitTerminal`'s loop but detached from any HTTP
   response, calling `recordRunFinished` and emitting there. Without this, a
   terminal event fires only when someone was already watching — which is not a
   webhook contract.
2. **Have `cancelRun` write `CANCELED`** rather than leaving the row `RUNNING`.
3. Only then: add `WorkflowRun` to `ResourceType` in **both**
   `audit.prisma` and `packages/domains/src/enums/generated/ResourceType.ts`,
   with an `ALTER TYPE "core"."ResourceType" ADD VALUE 'WorkflowRun';` migration.
4. Emit with `resourceId: runId` (**not** the definition id — the two existing
   exposure-plane sys-events use `definition.id`, which would point `fetchUrl` at
   the wrong object) and a PHI-free payload: slug, status, terminal reason,
   timestamps, `consultationId` if bound. Never node outputs.

Note that an emit placed inside `syncTerminalStatus` today would inherit that
method's swallow-everything error handling, so a delivery could be dropped with
no trace. That is another reason the observer belongs first.

### Until then

Hold the stream (`runAndStream` / `streamRun`), or poll `getRun` until
`isTerminalRunStatus(status)`. Do not build on an event that will not arrive.

---

## Known gaps, collected

| # | Gap | Impact |
|---|---|---|
| G9 | No `WorkflowRun` sys-event; terminal status only written on a lazy read | No "run completed" webhook; a fire-and-forget run stays `RUNNING` forever |
| — | No business-plane run listing | A run is reachable only by a `runId` you kept |
| — | `useConsultationEvents` has no resume | Frames published while disconnected are lost, with no server-side buffer |

## Further reading

- [`packages/vox-node/README.md`](../../packages/vox-node/README.md) — full server SDK reference
- [`packages/agentic-sdk-v2/README.md`](../../packages/agentic-sdk-v2/README.md) — full browser SDK reference
- [`docs/architecture/vox-node-gateway-gaps.md`](./vox-node-gateway-gaps.md) — gateway quirks the SDK surfaces rather than hides
