# @arcaai/vox-node

The HOPE **server-side Node SDK** — a typed client for the HOPE gateway's
summarization and consultation-summary surfaces, the workflow and published-agent
invocation planes (`hope.workflows.*`, `hope.agents.*`), plus the full
**administration plane** (`hope.admin.*`, 49 areas), for backend engineers who
need to call HOPE from a Node service, script, or worker.

## What this is, and what it is NOT

`@arcaai/vox-node` shares the `vox` brand with `@arcaai/vox`
(`packages/agentic-sdk-v2`) — the browser consultation SDK — **but not its
runtime, not React, and not the audio/ML stack.** These are two separate
packages with two separate purposes:

| | `@arcaai/vox-node` (this package) | `@arcaai/vox` |
|---|---|---|
| Environment | Node >= 22 (also Bun/Deno/edge) | Browser only |
| React | Not a dependency at all | Required peer dependency |
| Audio/VAD/STT/ML | None | Core capability |
| State | None — stateless method calls | Zustand store, session lifecycle |
| Use case | Backend services calling HOPE | In-browser consultation capture |

If you are building a web UI that records audio or drives a live
consultation, you want `@arcaai/vox`, not this package. If you are writing a
backend service, script, or worker that needs to POST a transcript and get a
summary back, you want this one.

This package has **zero runtime dependencies** — only the standard `fetch`,
`AbortSignal`, Web Crypto (`crypto.getRandomValues`), and `ReadableStream`
globals (the WinterTC common minimum). One build runs unmodified on Node
>= 22, Bun, Deno, and most edge runtimes.

## Install

```bash
npm install @arcaai/vox-node
# or: pnpm add / yarn add @arcaai/vox-node
```

Published to the ArcaAI GitHub npm registry (`npm.pkg.github.com`), matching
`@arcaai/vox`.

## 60-second quickstart

The fastest path to a summary needs no consultation, no prior setup — just a
transcript:

```ts
import { HopeClient } from '@arcaai/vox-node';

const hope = new HopeClient({
  baseUrl: process.env.HOPE_API_URL!, // e.g. http://localhost:8868
  apiKey: process.env.HOPE_API_KEY!, // sent as X-API-Key
});

const { summary } = await hope.summarization.summary({
  session_data: {
    created_at: new Date().toISOString(),
    conversation_segments: [
      { speaker: 'provider', text: 'What brings you in today?', timestamp: new Date().toISOString() },
      { speaker: 'patient', text: 'I have had a headache for three days.', timestamp: new Date().toISOString() },
    ],
  },
});

console.log(summary);
```

`summarization.summary()` is a stateless call over HOPE's v1-compat summarization shim
— no `HopeClient.consultations.open(...)` call, no persisted state, nothing
to clean up. See [`examples/01-summary.ts`](./examples/01-summary.ts) for a
runnable version.

## Auth

The SDK supports **two credential classes**, and which one you hold decides
which half of the platform you can reach. Pick one — supplying both throws at
construction, because the gateway rejects a request carrying two.

| | **API key** | **Service account** |
|---|---|---|
| Option | `apiKey` | `serviceAccount` |
| Header | `X-API-Key` | `X-Service-Account-Token` |
| Reaches the business plane | yes | yes, for the standalone features |
| Reaches `/admin/*` | **never** | **yes** — this is the only way |
| Issued by | a tenant admin | a **platform** super-admin |
| Shape | one long-lived secret | `clientId` + `clientSecret`, exchanged for a short-lived token |

> **There is a third credential class this SDK deliberately does not carry: the user JWT.** A
> gateway JWT is bound to one *user*, for one short session, and is refreshable and revocable; it
> is what a user-facing frontend should authenticate with, and
> [`@arcaai/vox`](../agentic-sdk-v2/README.md) is JWT-first for exactly that reason. Both
> credentials here are *machine* identities with no bound session, which is the right shape for a
> server and the wrong shape for a browser.
>
> The line is credential class, not privilege. Scopes bind the **credential**; abilities bind the
> bound **human**; the two compose as **AND**, so a machine credential can never exceed the human
> it acts for — and `/admin/*` is closed to API keys unconditionally (`@ForbidApiKey()`, checked
> before the scope check), regardless of the scopes the key holds.

### API key

Sent as `X-API-Key`. The expected path for ordinary server-side work; the
gateway's `UnifiedAuthGuard` binds the request's tenant from the key itself, so
a Node service needs nothing else (no browser session, no stream tickets).

- **`tenantId`** — sent as `X-Tenant-Id`, on top of `apiKey`. Only meaningful
  for **super-admin** API keys, which are not bound to a single tenant; a
  tenant-scoped key ignores this header (its own tenant always wins).

```ts
const hope = new HopeClient({
  baseUrl: process.env.HOPE_API_URL!,
  apiKey: process.env.HOPE_API_KEY!,
  // tenantId: process.env.HOPE_TENANT_ID, // super-admin keys only
});
```

An API key **cannot reach `/admin/*` under any scope**, including `*`. That is
policy, not an oversight: every admin controller carries `@ForbidApiKey()`,
which is checked *before* the scope check, and a boot audit fails the gateway's
startup if an admin route ever declares an API-key scope again. Use a service
account.

### Service account

The platform's machine identity, and the only credential that reaches the
administration plane. You hold a `clientId` and a `clientSecret`; the SDK
exchanges them at `POST /auth/service-token` for an opaque, short-lived token
(~15 min) and presents it as `X-Service-Account-Token`.

```ts
const hope = new HopeClient({
  baseUrl: process.env.HOPE_API_URL!,
  serviceAccount: {
    clientId: process.env.HOPE_SVC_CLIENT_ID!,
    clientSecret: process.env.HOPE_SVC_CLIENT_SECRET!,
  },
});

const page = await hope.admin.tenant.list({ query: { page: 0, limit: 50 } });
```

**The exchange is invisible to you.** Construction never touches the network;
the first call exchanges lazily, the token is cached and refreshed on a margin
*before* expiry, concurrent calls during a refresh collapse to a single
exchange, and a token revoked mid-flight is re-exchanged once and the call
retried. Neither the secret nor the token can reach a log line or an error
message.

> **`workingTenantId` binds at EXCHANGE time, not per request.** This is the one
> place API-key intuition misleads. With a key you may send `X-Tenant-Id` per
> call; a service-account token *carries* its working tenant, fixed when the
> token was minted, and the SDK never sends `X-Tenant-Id` alongside it. Pass
> `serviceAccount.workingTenantId` to choose it at exchange; omit it and a
> platform account resolves the SYSTEM tenant. Supplying top-level `tenantId`
> together with `serviceAccount` throws at construction rather than being
> silently dropped.

Service accounts are issued by a super-admin through
`POST /api/v1/admin/service-accounts`, and the secret is shown **once**. There
is no recovery path — rotate to get a new one.

Local dev keys are seeded by
[`packages/database/src/prisma/db_main/seed/02-apikey.ts`](../database/src/prisma/db_main/seed/02-apikey.ts) —
read that file to find (or mint) a key for your local stack; never copy a key
value into source control, a README, or an example file.

### Required API-key scopes, per method

HOPE's `UnifiedAuthGuard` checks a `@RequiredScopes(...)` decorator on the
API-key auth path (JWT-authenticated callers are unaffected). A key holding
`consultation:*` satisfies every scope below (category wildcards are
honored). If your key is scoped narrower than `consultation:*`, match it to
the methods you actually call:

| SDK method | Route | Required scope (API key) |
|---|---|---|
| `summarization.preSummary` / `.preSummaryStream` | `POST /api/smr/api/v1/presummary` | `consultation:report:write` |
| `summarization.summary` / `.summaryStream` | `POST /api/smr/api/v1/summary/sync` | `consultation:report:write` |
| `consultations.summaries.generate` | `POST /api/v1/consultations/:id/summary` | `consultation:report:write` |
| `consultations.summaries.generatePreSummary` | `POST /api/v1/consultations/:id/summary/pre-summary` | `consultation:report:write` |
| `consultations.summaries.generateAsync` | `POST /api/v1/consultations/:id/summary/async` | `consultation:report:write` |
| `consultations.summaries.generatePreSummaryAsync` | `POST /api/v1/consultations/:id/summary/pre-summary/async` | `consultation:report:write` |
| `consultations.summaries.list` | `GET /api/v1/consultations/:id/summary` | `consultation:report:read` |
| `consultations.summaries.latest` | `GET /api/v1/consultations/:id/summary/latest` | `consultation:report:read` |
| `consultations.summaries.latestPreSummary` | `GET /api/v1/consultations/:id/summary/pre-summary/latest` | `consultation:report:read` |
| `jobs.get` | `GET /api/v1/consultations/jobs/:jobId` | `consultation:session:read` |
| `jobs.cancel` | `PATCH /api/v1/consultations/jobs/:jobId/cancel` | `consultation:session:read` |
| `jobs.stream` / `jobs.waitFor` | `GET /api/v1/consultations/jobs/:jobId/stream` | `consultation:session:read` |
| `consultations.summaries.update` | `PATCH /api/v1/consultations/:id/summary/:summaryId` | **none declared** — see note below |
| `consultations.get` | `GET /api/v1/consultations/:id` | **none declared** — see note below |

> **Two methods carry no scope requirement today.** Verified directly against
> `apps/api/src/modules/consultation/consultation.controller.ts`:
> `updateSummary` (backing `consultations.summaries.update`) and `getById`
> (backing `consultations.get`) have no `@RequiredScopes(...)` decorator at
> all. Any API key your RBAC role permits can call these two routes
> regardless of its declared scopes — this is a real gap in the gateway, not
> an SDK omission, and it is narrower than the pre-fix state (every other
> route the SDK calls was equally unenforced before this scope-decorator work
> landed). Don't assume a narrowly-scoped key is blocked from these two
> calls; it is not.

## The admin plane — `hope.admin.*`

49 administration areas, reachable **only** with a service account. The surface
is generated from the gateway's own route metadata and OpenAPI document, and a
CI gate fails on any drift between them, so it cannot silently fall behind the
API.

Areas are named after the **scope** they need, not the URL, so the property you
call and the grant you must ask for are one substitution apart:

```
svc:admin:tenant-tts-config:manage   →   hope.admin.tenantTtsConfig
```

Every resource declares its `svcScope`, and a 403 names it — which is the single
most common integration failure, so the error tells you what to request.

### Scopes

A service account is granted an explicit set. Two rules that surprise people:

- **`svc:admin:*` does not reach everything on the admin plane.** It expands
  over the `svc:admin:` prefix, so `hope.admin.webhookEvent`
  (`svc:webhook:event:write` — a scope predating the `admin:*` convention) is
  granted separately or not at all.
- **`svc:*` reaches both**, and is correspondingly blunt.

### Areas that are deliberately absent

Five admin areas are machine-closed by owner decision and have **no** generated
methods, because a method that always 403s is worse than no method:

| Area | Why |
|---|---|
| `admin/service-accounts` | Self-replication — a machine must not mint another machine |
| Impersonation | A machine assuming a person's identity defeats audit attribution: `AuditLog` records exactly one actor, human *or* machine, never both |
| `admin/consent-grants` | Consent is an act of a person |
| `admin/monitoring` | Operator telemetry, read by a human on the console |
| `admin/health/services` | Same, and a fan-out that would amplify an SSRF if driven in a loop |

### Pagination

Every list method comes in two forms. `list()` returns one page; `listIterate()`
walks all of them.

```ts
for await (const tenant of hope.admin.tenant.listIterate()) { /* ... */ }
```

Prefer the iterator. **Do not hand-roll a page loop off the response's `page`
and `limit`** — the gateway echoes back the *raw* query values, so omitting them
returns `page: undefined, limit: undefined` over a page that really was limited
to 10, and one endpoint returns `limit: 0` outright. The iterator drives
pagination from the request side for exactly this reason.

### Optimistic concurrency

Writes to versioned resources require `If-Match`, and **the row is the
precondition** — there is nothing to capture from a header:

```ts
const tenant = await hope.admin.tenant.get(id);
await hope.admin.tenant.update(id, { name: 'New' }, { ifMatch: tenant });
```

`ifMatch` is a required property on those methods, so forgetting it is a compile
error rather than a runtime 428. A stale precondition throws `VersionConflictError`
(HTTP 412) carrying the current version. Note that list responses carry no ETag
at all — one validator cannot represent N rows — which is why the row, not a
header, is the precondition.

### Errors

- **404 can mean "not yours".** The platform answers cross-tenant reads with 404
  rather than 403, deliberately, so a missing resource and someone else's
  resource are indistinguishable. Do not treat it as proof the record is gone.
- **403 means your service account lacks the scope**, and the message names it.

## The two summarization families

HOPE exposes summarization two ways. Pick the one that matches your
integration:

| | `hope.summarization.*` (stateless) | `hope.consultations.summaries.*` (consultation-bound) |
|---|---|---|
| Prerequisite | None — no consultation required | A consultation must already exist |
| Persistence | None — request in, response out | Persisted, versioned `ContextItemVersion` rows |
| Wire contract | v1-compat, frozen `snake_case` shapes | v2 native, `camelCase` |
| When to use | Migrating an existing v1 backend integration; one-off/batch summarization with no HOPE-side record | Building against HOPE's own consultation model — summaries need to be retrievable, listed, or edited later |

If you're migrating an existing v1 integration, the compat routes are
byte-identical to what you already call — swapping a raw `fetch` call for
`hope.summarization.summary(...)` is the entire migration; there is no
request/response reshaping to do.

## Running workflows

A published workflow is a product your backend can invoke. Two families, split
by what they are allowed to write:

| | `hope.workflows.*` | `hope.consultations.workflows.*` |
|---|---|---|
| Runs | A tenant's published workflows, standalone | The same, bound to one consultation |
| Writes into a clinical record | No | Yes |
| Ability | `create`/`read`/`update:WorkflowRun`, `list:WorkflowDefinition` | `execute:ConsultationWorkflow` |
| API-key scopes | `workflow:definition:read`, `workflow:run:read`, `workflow:run:write` | `workflows:execute` |

"May run a workflow" and "may run one that writes into a clinical record" are
deliberately different powers, so they are different routes, abilities and
scopes — granting the first never implies the second.

### Which credential reaches what

| Plane | API key | Service account |
|---|---|---|
| `hope.agents.*`, `hope.workflows.*` (incl. `.reviews`) | ✅ | ✅ since **3.1.0** |
| `hope.consultations.workflows.*` — the CLINICAL plane | ✅ | ❌ refused at the call site |
| `hope.admin.*` | ❌ never, under any scope | ✅ only |

Until 3.1.0 the whole workflow plane declared `svcScopes: []` — deny-by-default
for a service account — and the SDK refused at the call site rather than let you
discover it as a 403 that no role grant could fix. The gateway now declares
`svc:agent:definition:read`, `svc:agent:invocation:write`,
`svc:workflow:definition:read`, `svc:workflow:run:read` and
`svc:workflow:run:write`, so **one client can now both administer and invoke**.

Two things did NOT change:

- **The consultation-bound plane still refuses a service account.** Running a
  workflow that writes into a clinical record is not a machine-identity power,
  so it gained no `svc:*` scopes and `CredentialClassError` still fires there.
- **A service-account client never sends `X-Tenant-Id`**, because
  `workingTenantId` binds at token EXCHANGE. Setting both throws at construction
  — as does passing an API key and a service account to one client.

### Starting a run

### Starting a run

```ts
const hope = new HopeClient({ baseUrl, apiKey });

// Fire and collect a handle.
const handle = await hope.workflows.run('discharge_summary', { input: { … } });

// Or block until it finishes (the gateway caps this; a 504 is a ceiling, not
// a transient failure, and is never retried).
const status = await hope.workflows.runAndWait('discharge_summary', { input: { … } });

// Or consume events as they happen.
for await (const event of hope.workflows.runAndStream('discharge_summary', { input: { … } })) {
  if (event.type === 'workflow.node.completed') { … }
}
```

Consultation-bound runs take the consultation id first, and are otherwise
identical:

```ts
await hope.consultations.workflows.list(consultationId);
await hope.consultations.workflows.run(consultationId, slug, { input: { … } });
await hope.consultations.workflows.runAndWait(consultationId, slug, { input: { … } });
for await (const e of hope.consultations.workflows.runAndStream(consultationId, slug, { input: { … } })) { … }
```

### Following a run

| Method | Use it when |
|---|---|
| `getRun(slug, runId)` | One-shot status check. |
| `streamRun(slug, runId, opts)` | Attach to a run you started earlier — resumable (below). |
| `waitForRun(slug, runId, opts)` | Same, but you only care about the terminal status. |
| `cancelRun(slug, runId)` | Signal cancellation. |

`streamRun` and `runAndStream` **resume**: each frame's opaque `id` is tracked
and a dropped connection reconnects with `Last-Event-ID`, so a disconnect costs
latency, not events. Hand-rolling this means knowing that the snapshot frame
deliberately carries no token.

#### `transport: 'socket'` (3.1.0)

```ts
const status = await hope.workflows.waitForRun(slug, runId, { transport: 'socket' });
```

Same events, same terminal detection, same return value — a one-word change at
the call site. It mints a run-scoped, single-use ~30-second ticket
(`POST /workflows/{slug}/runs/{runId}/stream-ticket`) and opens the `url` that
response returns; a JWT never travels in a query string.

**SSE stays the default, because it is the only lane that RESUMES.** The
socket's ticket is single-use, so a dropped socket ends the read where SSE
reconnects and loses nothing. Reach for `socket` when something between you and
the gateway BUFFERS `text/event-stream` — the symptom is a run that looks
stalled and then completes all at once — or when a socket is the connection
budget you already hold.

It needs `globalThis.WebSocket`, i.e. **Node 22 or newer** (also Bun, Deno, edge
runtimes): this package has zero runtime dependencies and will not import a
polyfill on your behalf. Without it you get `SocketUnavailableError` naming that
floor — never a silent fallback to SSE, which would reproduce the buffering
symptom you switched transports to escape.

Use the exported `isTerminalRunStatus(status)` rather than comparing strings —
the terminal set includes `TIMED_OUT` and spells cancellation `CANCELED`
(one L), which is easy to get wrong.

### Idempotency is a JOIN, not a de-duplicate

`options.idempotencyKey` derives the run id from `(tenant, slug, key)`. A retry
with the same key **joins the run already in flight** rather than starting — and
billing — a second one. That is the behaviour you want on a retry, and a
surprise if you reuse a key across genuinely different payloads.

The run identity is stamped server-side, so `input` may not carry the reserved
keys — `consultationId`, `externalPatientId`, `userId`, `jobId`, `sessionId`.
The gateway REFUSES rather than silently dropping them, because the failure it
is preventing is not a 400: it is a caller sending `{ consultationId }`,
getting a 202, and believing it addressed that consultation while the run acted
on something else. The SDK throws
`ReservedRunIdentityError` before the request leaves; `RESERVED_RUN_IDENTITY_KEYS`
and `reservedRunIdentityKeysIn(input)` are exported so you can check a payload
while you build it.

### Runs do not notify you

There is no "run completed" webhook — see
[Known gateway quirks](#known-gateway-quirks-the-sdk-deliberately-does-not-hide).
Hold the stream or poll `getRun`; do not fire and forget.

## Invoking agents — `hope.agents.*`

A published **Agent** is a single-task product — an LLM agent (`TEXT_GENERATION`),
a TTS agent (`TEXT_TO_SPEECH`), an ASR agent (`SPEECH_TO_TEXT`), a NER agent
(`NAMED_ENTITY_RECOGNITION`, new in 3.1.0) — that a tenant admin configures and
publishes; a workflow composes agents, an agent is what a workflow node calls.
`hope.agents` invokes them directly, with the same client and the same credential
rule as `hope.workflows`: an API key **or** a service account (see
[Which credential reaches what](#which-credential-reaches-what)).

```ts
const hope = new HopeClient({ baseUrl: process.env.HOPE_API_URL!, apiKey: process.env.HOPE_API_KEY! });

// Discovery — the same predicate the gateway resolves an `agentSlug` with.
const writers = await hope.agents.list({ task: 'TEXT_GENERATION' });   // GET /api/v1/agents?task=…
const writer = await hope.agents.get(writers[0].slug);                 // + inputSchema / outputSchema / protocols

// LLM agent — blocking (60s gateway ceiling → GatewayTimeoutError) or streaming.
const { output } = await hope.agents.invoke(writer.slug, { note }, { idempotencyKey: visitId });
for await (const event of hope.agents.invokeAndStream(writer.slug, { note })) console.log(event.type, event.payload);

// TTS agent — the audio body is handed back unbuffered.
const speech = await hope.agents.synthesize('clinic-tts', { text: 'Take one tablet daily.' });
await pipeline(Readable.fromWeb(speech.stream!), createWriteStream('advice.mp3'));   // or await speech.arrayBuffer()

// Batch ASR agent — multipart file or an already-uploaded mediaId → a TranscriptionJob.
const job = await hope.agents.transcribe('clinic-asr', { file: recording, filename: 'visit.wav', language: 'en' });
```

### `NAMED_ENTITY_RECOGNITION` (3.1.0)

```ts
const [ner] = await hope.agents.list({ task: 'NAMED_ENTITY_RECOGNITION' });
const { output } = await hope.agents.invoke<NamedEntityRecognitionOutput>(ner.slug, {
  text: 'Started metformin 500mg twice daily.',
});
// output.entities → [{ text: 'metformin', label: 'DRUG', start: 8, end: 17, score: 0.98 }, …]
```

Same method, different output — there is no second call to learn.
`NamedEntityRecognitionInput` / `NamedEntityRecognitionOutput` / `RecognizedEntity`
describe the task's DEFAULT schema; a tenant may author its own, which is why they
are convenience types and not a constraint on `invoke`. Read the agent's own
`inputSchema` / `outputSchema` from `get(slug)` when you need to know rather than
assume, or generate them with
[`@arcaai/vox-codegen`](../vox-codegen/README.md)'s `--agents` mode.

It is a **one-shot** task: `?mode=stream` on a NER agent is a gateway 400
(`MODE_UNSUPPORTED`), so `invokeAndStream` on one fails rather than answering
slowly. There is nothing to stream — the answer is a single spans array.

`invoke` sends the `Idempotency-Key` header exactly like a workflow run: a retry
with the same key JOINS the in-flight invocation. The blocking 504 ceiling is never
retried. `invokeAndStream` yields the same envelope as a workflow-run frame
(`type`, `correlationId`, `payload`, `resumeToken`, …) but does **not** reconnect —
TASK-863 exposes no per-invocation stream route to resume against; re-invoke with
the same idempotency key instead.

Realtime transcription is deliberately **not** here: a browser captures audio and
opens the stream session through `@arcaai/vox` (`audio.start({ agentSlug })`).
This package has no audio stack and never will — *the browser never runs a model*,
and neither does this SDK.

Administration of agents (CRUD, versions, publish, assignments) is the generated
admin plane, `hope.admin.agent.*` — service account only.

## Streaming

Both stateless summarization methods have a streaming variant that yields
`delta`/`reasoning` events as they arrive, then a terminal `result` event:

```ts
for await (const event of hope.summarization.summaryStream(input)) {
  if (event.type === 'delta') process.stdout.write(event.text);
  if (event.type === 'result') console.log('\n\nDone:', event.data);
}
```

Most callers just want the final answer. `.result()` collapses the stream to
its terminal payload — iterate with `for await` **or** call `.result()`, not
both (the underlying generator can only be consumed once):

```ts
const summary = await hope.summarization.summaryStream(input).result();
```

A stream that ends without ever emitting a `result` frame, or that emits an
`error` frame, rejects `.result()` (and, when iterating directly, yields an
`{ type: 'error', detail }` event) with a `HopeStreamError`. See
[`examples/02-presummary-stream.ts`](./examples/02-presummary-stream.ts).

## Async jobs

For long transcripts, the async path (`generateAsync` +
`jobs.waitFor`) is the ergonomic default — it hands the generation off to a
background job instead of holding the connection open:

```ts
const { jobId } = await hope.consultations.summaries.generateAsync(consultationId, {
  transcription: fullTranscriptText,
});

const finished = await hope.jobs.waitFor(jobId);
console.log(finished.status, finished.result);
```

`waitFor` prefers the live SSE stream (`jobs.stream`) and falls back to
polling `jobs.get` if the stream drops before a terminal status arrives —
you don't need to choose between the two. See
[`examples/03-consultation-async.ts`](./examples/03-consultation-async.ts).

## Receiving webhooks

HOPE pushes a notification to your endpoint when a resource you subscribed to
changes. Two halves: subscribe with `hope.admin.webhookEvent` (service account
only), then verify each delivery with `verifyWebhookSignature`.

### Subscribing

```ts
const { webhook, rawSecret } = await hope.admin.webhookEvent.create({
  name: 'consultation-events',
  url: 'https://your-service.example.com/hooks/hope',
  resourceTypeName: 'Consultation', // the ResourceType to watch
  // resourceId: '…',               // optional: one specific row, not the whole type
});

// `rawSecret` is shown ONCE, here. HOPE stores only a hash and can never
// show it again — persist it now or rotate to get a new one.
```

| Method | What it does |
|---|---|
| `create(body)` | Subscribe. Returns `{ webhook, rawSecret }` — the only sight of the secret. |
| `fetchAll(opts)` / `fetchAllIterate(opts)` | List subscriptions (paginated; the `Iterate` form is an async iterator). |
| `fetchById(id)` | One subscription. |
| `update(id, body, { ifMatch })` | Change url/name/resource type. Versioned — see [Optimistic concurrency](#optimistic-concurrency). |
| `rotateSecret(id, body, { ifMatch })` | Issue a new signing secret; returns it once, like `create`. **No overlap window** — the previous secret dies immediately, so deploy the new one before rotating. Versioned. |
| `fetchDeliveries(id)` / `fetchDeliveriesIterate(id)` | Delivery history — status, response code, attempts. Start debugging here. |
| `delete(id)` | Unsubscribe. |

The scope is `svc:webhook:event:write`, which **predates the `svc:admin:*`
convention and is therefore NOT granted by `svc:admin:*`** — ask for it
explicitly (see [Scopes](#scopes)).

`resourceTypeName` is matched against the fired event's `resourceType` by plain
string equality, and the gateway does **not** validate it against a list. A
typo, or a resource type that emits no sys-events, is accepted at create time
and then simply never fires — check `fetchDeliveries` before assuming your
receiver is at fault.

### What arrives

A subscription is per **resource type**, not per event type: you receive
`ResourceCreated`, `ResourceUpdated`, `ResourceDeleted` and friends for that
type, and branch on `eventType` yourself.

The body is **references, never content** — HOPE will not push resource data,
PHI included, to a third-party endpoint:

```jsonc
{
  "eventType": "ResourceUpdated",
  "resourceType": "Consultation",
  "resourceId": "0192…",
  "tenantId": "5000…",
  "occurredAt": "2026-09-03T10:15:30.000Z",
  "fetchUrl": "https://api.example.com/api/v1/admin/consultations/0192…"
}
```

So a receiver's job is: verify, enqueue, then fetch what it needs with its own
credentials. Do not expect the payload to grow a `data` field.

### Verifying the signature

Every delivery carries `X-Hope-Webhook-Signature: sha256=<hex>` — an
HMAC-SHA256 of the **raw** body under your `rawSecret`.

```ts
import express from 'express';
import { WEBHOOK_SIGNATURE_HEADER, verifyWebhookSignature } from '@arcaai/vox-node';

app.post('/hooks/hope', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.header(WEBHOOK_SIGNATURE_HEADER) ?? '';
  if (!verifyWebhookSignature(req.body, signature, process.env.HOPE_WEBHOOK_SECRET!)) {
    return res.status(401).end(); // reject BEFORE parsing
  }

  const event = JSON.parse(req.body.toString('utf8'));
  enqueue(event); // ack fast; fetch and process out of band
  res.status(204).end();
});
```

Three things that silently break verification:

- **Parsing before verifying.** The digest covers the exact bytes on the wire.
  A `JSON.parse` → `JSON.stringify` round trip reorders and reformats, and the
  signature will never match. Reach for `express.raw` (or `express.json`'s
  `verify` hook, or a Fastify `preValidation` raw-body hook).
- **Using the hashed secret.** The signing key is the `rawSecret` from `create`
  or `rotateSecret`, not anything readable from `fetchById` later.
- **Treating a missing header as unsigned.** A subscription created without a
  secret is not signed at all; one created *with* one always is. If your
  handler falls through when the header is absent, an attacker just omits it.

`verifyWebhookSignature` never throws — a malformed header, a wrong secret or a
non-string argument all return `false` — so it is safe to call directly in a
route guard. It is synchronous and dependency-free, so it works unchanged in
Node, Bun, Deno and edge runtimes. Comparison is constant-time.

### Which events actually fire

Any resource type whose service broadcasts a sys-event on mutation — which is
most of the CRUD surface (`Consultation`, `Department`, `User`, `ApiKey`,
`Tenant`, `WorkflowDefinition`, `WorkflowAssignment`, …).

**Workflow *runs* are not among them.** `WorkflowRun` is deliberately exempt
from sys-events, so there is no "run completed" webhook to subscribe to today —
see [Known gateway quirks](#known-gateway-quirks-the-sdk-deliberately-does-not-hide)
and, for the full analysis, the
[clinician integration guide](../../docs/architecture/clinician-integration-guide.md#webhooks).
Poll `hope.workflows.getRun(slug, runId)` or hold the SSE stream instead.

## Errors

Every non-2xx gateway response is thrown as a typed subclass of
`HopeAPIError`, so you can `catch` a specific class instead of switching on
`error.status`:

| Class | HTTP status | Meaning |
|---|---|---|
| `AuthenticationError` | 401 | The API key (or bearer token) is missing, invalid, or expired. |
| `PermissionError` | 403 | A privilege boundary — e.g. a super-admin-only action attempted by a tenant admin. |
| `NotFoundError` | 404 | See the callout below before treating this as "wrong route". |
| `QuotaExceededError` | 409 | An entitlements quota (quantity-capped resource) was exceeded. |
| `VersionConflictError` | 412 | Optimistic-concurrency conflict; carries `currentVersion` when the server reported it. |
| `PreconditionRequiredError` | 428 | A versioned route required `If-Match` and none was sent. |
| `RateLimitError` | 429 | Rate limited; carries `retryAfterMs` when the server sent `Retry-After`. |
| `APIConnectionError` | *(no HTTP status — `status: 0`)* | No response was ever received: DNS failure, connection refused, TLS error, or a non-caller abort. |
| `APITimeoutError` | *(subclass of `APIConnectionError`)* | The request exceeded its configured timeout. |
| `HopeAPIError` | any other status | Base class — every subclass above extends it, so `catch (err) { if (err instanceof HopeAPIError) ... }` catches all of them uniformly. |

Streaming methods can additionally throw `HopeStreamError` (not a
`HopeAPIError` subclass — it does not correspond to an HTTP status) when a
summarization stream itself fails; see [Streaming](#streaming).

### `NotFoundError` — read this before filing a bug

**HOPE's tenancy posture is 404-over-403**: a cross-tenant read or write
returns 404, never 403
(`.claude/rules/05-nestjs-api.md` — "Cross-tenant access returns 404, never
403"). This deliberately hides resource *existence* from a caller who is not
entitled to see it — a real consultation belonging to a different tenant is,
on the wire, indistinguishable from an id that was never valid at all.

So when your integration gets a `NotFoundError`, **do not assume the id is
wrong or the route is misspelled.** It may mean the id is real and
correctly formed, but scoped to a tenant your API key cannot access (most
commonly: the key is bound to a different tenant than the consultation
belongs to). Verify tenant ownership before treating a 404 from this SDK as
a client-side bug.

```ts
import { NotFoundError } from '@arcaai/vox-node';

try {
  await hope.consultations.get(consultationId);
} catch (err) {
  if (err instanceof NotFoundError) {
    // Could be a genuinely missing id, OR a real id owned by another tenant.
    // The response never tells you which — see the docstring on NotFoundError.
  }
  throw err;
}
```

## Known gateway quirks the SDK deliberately does not hide

The SDK types the gateway's real behavior faithfully, including three rough
edges it does not paper over:

- **Two different job-status vocabularies for the same workflow (G5).**
  `generateAsync`/`generatePreSummaryAsync` return an `AsyncJobResponse`
  whose `status` is `pending | processing | completed | failed`; `jobs.get`
  and `jobs.stream` return a `JobStatusResponse` whose `status` is
  `PENDING | RUNNING | COMPLETED | FAILED | CANCELLED`. These are **not** a
  1:1 mapping (`processing` vs `RUNNING`, and `CANCELLED` has no counterpart
  in the first vocabulary) — a gateway inconsistency, not something this SDK
  silently normalizes into one shape. Use the exported
  `isTerminalJobStatus(status)` helper, which accepts either vocabulary,
  instead of hand-rolling a status comparison:

  ```ts
  import { isTerminalJobStatus } from '@arcaai/vox-node';

  if (isTerminalJobStatus(job.status)) { /* … */ }
  ```

- **`summaries.update()`'s `ifMatch` option buys you no conflict detection
  today (G8).** HOPE's house pattern for versioned PATCH routes is
  `_version` → `ETag` → client `If-Match` → 428 if missing / 412 on drift.
  `PATCH :id/summary/:summaryId` does **not** follow that pattern: it carries
  neither `@RequiresIfMatch()` nor `@ExpectedVersion()` server-side, and the
  service has no `updateWithVersion` call at all — every edit is appended as
  a new `ContextItemVersion` row instead. Concretely: a missing `If-Match`
  never yields 428, and two concurrent edits never yield 412. The SDK still
  accepts and forwards `ifMatch` (forward-compatibly, so adopting real OCC on
  this route later needs no SDK change), but **it is a no-op today — do not
  build any conflict-detection logic around it.**

  ```ts
  await hope.consultations.summaries.update(consultationId, summaryId, { content }, {
    ifMatch: currentEtag, // sent, but currently has no server-side effect
  });
  ```

- **A workflow run's terminal status is only recorded when somebody asks
  (G9).** `WorkflowRun` rows are written `RUNNING` at dispatch, but nothing
  server-side observes the finish: the only two calls that write a terminal
  status sit inside `syncTerminalStatus`, reachable exclusively from a
  `getRunStatus` read (`workflow-exposure.service.ts:369`,
  `workflow-sandbox-run.service.ts:156`). So a run whose result nobody reads
  stays `RUNNING` in the read model indefinitely, and a cancelled run's row is
  never updated at all. There is also, by deliberate design, no `WorkflowRun`
  sys-event — so **no webhook can carry "run completed"**.

  What this means for your integration: do not fire-and-forget. Either hold the
  stream (`runAndStream` / `streamRun`, which read terminal status as a side
  effect) or poll `getRun` until `isTerminalRunStatus(status)`. The full analysis
  and the design a push notification would need are in the
  [clinician integration guide](../../docs/architecture/clinician-integration-guide.md#webhooks).

## PHI/logging posture

HOPE handles protected health information (transcripts, summaries) — this
SDK is built so that leaking PHI or credentials into a log is structurally
hard, not just a rule to remember:

- **Request and response bodies are never passed to a logger, at any log
  level.** The injected `logger: HopeLogger` option (`debug`/`info`/`warn`/
  `error`, each optional) only ever receives a `message` string and an
  optional `meta` object of non-content fields (method, path, status,
  `requestId`) — never a transcript, a summary, or any other PHI-bearing
  field.

  > **Current status:** `HopeLogger` is accepted by `HopeClient`'s
  > constructor for forward compatibility with the documented shape, but as
  > of this release it is **not yet wired to any request** — `core/transport.ts`
  > has no logging hook of its own, so a `logger` you pass in today receives
  > nothing. This is a known gap, not a documentation error; do not rely on
  > it for request-level observability yet.

- **Credential headers are redacted everywhere**, including inside a thrown
  error's `headers`: `Authorization`, `X-API-Key`, `X-Service-Token`, and
  `Cookie` are replaced with `[REDACTED]` before the header set is ever
  stored — case-insensitively, and on the way IN (at construction), not only
  when something reads them back out.
- **Error objects never carry response bodies.** `HopeAPIError` and its
  subclasses store `status`, `code`, `requestId`, and (redacted) `headers` —
  never the parsed body — so a transcript or summary can never leak through
  an error's `toString()`, `toJSON()`, or `util.inspect()` output.
- **No on-disk caching of any kind.**

## Retry semantics

Requests are retried automatically under `core/retry.ts`'s policy:

- **What's retried**: `408`, `429`, any `5xx`, and connection-phase failures
  (DNS/connect/TLS/timeout). Default `maxRetries: 2` (configurable per
  `HopeClient` or per call).
- **Backoff**: exponential with **full jitter** —
  `delay = random(0, min(cap, base * 2**attempt))` — not plain exponential
  backoff. Plain exponential backoff makes every client that failed at
  roughly the same moment retry in lockstep, re-flooring a gateway that was
  in the middle of recovering; full jitter spreads retries across the whole
  window instead.
- **`Retry-After` is honored** on a `429` — when the server sends it, it
  overrides the computed backoff delay for that wait.
- **Non-idempotent `POST`s are never retried unless you supplied an
  idempotency key.** `POST` is HOPE's non-idempotent write verb (summary
  generation, job creation) — blindly retrying one risks double-billing an
  LLM call or creating a duplicate job. `generateAsync`/
  `generatePreSummaryAsync` auto-generate a UUIDv7 idempotency key when you
  don't supply one (so those two calls are always safely retryable); the
  synchronous `generate`/`generatePreSummary` calls, and the stateless
  `summarization.*` calls, are retried only for the connection/status
  reasons above — never blindly retried as a write.

## Further reading

The full requirement analysis, design decisions, and verification evidence
for this package live in
[`docs/implementation/TASK-632-HOPE-Node-SDK/README.md`](../../docs/implementation/TASK-632-HOPE-Node-SDK/README.md).
Runnable examples are in [`examples/`](./examples), with their own
[`examples/README.md`](./examples/README.md).
