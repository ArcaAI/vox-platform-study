# @arcaai/vox-node — server-side Node SDK for the HOPE gateway

`packages/vox-node`, npm package `@arcaai/vox-node` (version 4.0.x). A typed, non-browser client
for `apps/api` (port 8868): the realtime consultation lifecycle
(`hope.consultations.open` -> `recording` -> live SSE `streams`, with `hope.stt` streaming audio
over a WebSocket), consultation-bound summarization (`hope.consultations.summaries.*`), the
workflow and published-agent invocation planes, DNA writing-style ingest, and the full
administration plane (`hope.admin.*`, 48 areas). For backend engineers calling HOPE from a Node
service, script, or worker.

It shares the "vox" brand with `@arcaai/vox` (`packages/agentic-sdk-v2`, the browser consultation
SDK) but not its runtime: Node >= 22 (also Bun, Deno, most edge runtimes), no React dependency,
no audio/VAD/ML pipeline, and **zero runtime dependencies** — only the standard `fetch`,
`AbortSignal`, Web Crypto (`crypto.getRandomValues`) and `ReadableStream` globals. One build runs
unmodified across all of them. If you are recording audio or driving a live consultation from a
browser, use `@arcaai/vox` instead; use this package for backend services, scripts, or workers —
including one that already has audio (a telephony bridge, a recording relay) and needs to drive a
consultation with it.

**"No audio/ML pipeline" is not the same as no audio.** `RealtimeSttSocket` speaks HOPE's realtime
STT wire protocol: it frames PCM16 up a WebSocket and decodes transcripts down. It never captures,
runs VAD, denoises, or runs a model — which ASR runs is the tenant's published `SPEECH_TO_TEXT`
Agent, resolved by the gateway.

## Layout

| Path                   | What it holds                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`         | The public entry point — the only supported import surface                                                                                                                                 |
| `src/client.ts`        | `HopeClient` — constructs the transport and every resource namespace                                                                                                                       |
| `src/resources/`       | Hand-authored resources: `consultations`, `consultation-recording`, `consultation-streams`, `consultation-summaries`, `jobs`, `stt`, `tenants`, `workflows`, `agents`, `dna-writing-style` |
| `src/resources/admin/` | GENERATED `/api/v1/admin/**` surface (48 areas) — only `admin-resource.ts` is hand-authored                                                                                                |
| `src/core/`            | Transport, retry, redact, SSE parsing/subscription, realtime STT socket, run-identity guard, webhook signing, service-account token exchange, errors                                       |
| `src/types/`           | Request/response types                                                                                                                                                                     |
| `examples/`            | Seven runnable examples (`03-consultation-async.ts` through `09-completion-signals.ts`), own `examples/README.md`                                                                          |

## Commands

Run from this directory, or `pnpm --filter @arcaai/vox-node <script>` from the repo root.

| Command                       | Effect                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `pnpm build`                  | tsup build                                                                        |
| `pnpm dev`                    | tsup watch mode                                                                   |
| `pnpm test`                   | Vitest (`--passWithNoTests`)                                                      |
| `pnpm test:cov`               | Vitest with coverage                                                              |
| `pnpm lint` / `pnpm lint:fix` | ESLint on `src`                                                                   |
| `pnpm typecheck`              | `tsc --noEmit`                                                                    |
| `pnpm check:exports`          | `attw --pack .` + `publint` — validates the published package's type/export shape |
| `pnpm gen:admin`              | Regenerate `src/resources/admin/**` from the gateway route manifest + OpenAPI doc |
| `pnpm gen:admin:check`        | Fail if the admin surface has drifted from the gateway (CI gate)                  |
| `pnpm clean` / `pnpm nuke`    | Remove build output (`nuke` also removes `node_modules`)                          |

## How it works

### Two credential classes, mutually exclusive

|                            | API key                | Service account                                            |
| -------------------------- | ---------------------- | ---------------------------------------------------------- |
| Option / header            | `apiKey` / `X-API-Key` | `serviceAccount` / `X-Service-Account-Token`               |
| Reaches the business plane | yes                    | yes                                                        |
| Reaches `/admin/*`         | never                  | only way to reach it                                       |
| Issued by                  | a tenant admin         | a platform super-admin                                     |
| Shape                      | one long-lived secret  | `clientId` + `clientSecret`, exchanged for a ~15-min token |

Supplying both throws at construction. A user-facing frontend should use a gateway JWT via
`@arcaai/vox` instead — both credentials here are machine identities with no bound session.
`/admin/*` is closed to API keys unconditionally (`@ForbidApiKey()`, checked before the scope
check) regardless of the key's scopes: scopes bind the credential, abilities bind the bound
human, and the two compose as AND.

The service-account exchange is invisible to the caller: construction never touches the network,
the first call exchanges lazily, the token is cached and refreshed before expiry, and concurrent
calls during a refresh collapse to one exchange. **`workingTenantId` binds at EXCHANGE time, not
per request** — a service-account token carries its working tenant fixed at mint time, and the
SDK never sends `X-Tenant-Id` alongside it. Passing top-level `tenantId` together with
`serviceAccount` throws at construction.

### Required API-key scopes, per method

`UnifiedAuthGuard` checks a `@RequiredScopes(...)` decorator on the API-key auth path (JWT
callers are unaffected). A key holding `consultation:*` satisfies every scope below.

| SDK method                                                                                     | Required scope (API key)     |
| ---------------------------------------------------------------------------------------------- | ---------------------------- |
| `consultations.open`, `.recording.start/.stop`, `.addContext`, `.streams.*`, `.updateLanguage` | `consultation:session:write` |
| `consultations.get`, `jobs.get/.cancel/.stream/.subscribe/.waitFor`                            | `consultation:session:read`  |
| `consultations.chain`, `.listContext`, `.documentSections`, `.close`, `.summaries.approve`     | `consultation:session:write` (the controller's class default; a service account needs `svc:consultation:session:read` for `chain`/`listContext`, `:write` for `close`/`approve`, `svc:consultation:report:read` for `documentSections`) |
| `consultations.waitForFinalNote` (polls `summaries.latest` + `get`)                            | `consultation:report:read` + `consultation:session:read` |
| `stt.createStreamSession`/`.refreshTicket`/`.closeStreamSession`                               | `stt:transcription:write`    |
| `agents.transcribe(slug, { file })` — multipart upload, batch ASR                              | `stt:transcription:write`    |
| `agents.transcribe(slug, { mediaId })` — media already uploaded                                | `agent:invocation:write`     |
| `agents.transcriptionJob`/`.subscribeTranscription`/`.waitForTranscription`                    | `stt:transcription:write`    |
| `consultations.summaries.generateAsync*`, `.update`                                            | `consultation:report:write`  |
| `consultations.summaries.list`/`.latest`/`.latestPreSummary`                                   | `consultation:report:read`   |

### Which credential reaches what

| Plane                                                                 | API key                | Service account |
| --------------------------------------------------------------------- | ---------------------- | --------------- |
| `hope.agents.*`, `hope.workflows.*`                                   | yes                    | yes             |
| `hope.consultations.*` (open, recording, streams, context, summaries) | yes                    | yes             |
| `hope.consultations.workflows.*` (the clinical workflow plane)        | yes                    | yes             |
| `hope.stt.*`                                                          | yes                    | yes             |
| `hope.tenants.contextSchema()`                                        | yes                    | yes             |
| `hope.dnaWritingStyle.*`                                              | yes                    | yes             |
| `hope.admin.*`                                                        | never, under any scope | only            |

A service-account caller opening a consultation MUST name `clinicianUserId` (a machine is never
recorded as the clinician); a human JWT caller is refused if it sends one.

### The admin plane — `hope.admin.*`

48 administration areas, service-account only, generated from the gateway's route manifest and
OpenAPI document (`pnpm gen:admin`); `gen:admin:check` fails CI on drift. Areas are named after
the scope they need: `svc:admin:tenant-storage:manage` -> `hope.admin.tenantStorage`. `svc:
admin:*` does not reach areas whose scope predates the `admin:*` convention (e.g.
`hope.admin.webhookEvent` needs `svc:webhook:event:write` separately); `svc:*` reaches everything.

Ten admin controllers are deliberately absent from the generated surface — a generated method
that always 403s is worse than no method — per `src/resources/admin/admin-namespace.ts`'s own
docblock: `AdminHealthServicesController`, `AdminImpersonationController`,
`AiRoutingPolicyAdminController`, `ConsentGrantController`, `GlobalSettingController`,
`GuardrailAvailabilityController`, `MonitoringController`, `ServiceAccountController`,
`WorkflowInvariantRuleController`, `WorkflowRunController`. Each carries `@ForbidServiceAccount()`
or declares no `svc:*` scope on the gateway; the generator asserts this and FAILS generation
rather than silently emitting a forbidden surface.

Every list method comes in two forms: `list()` returns one page, `listIterate()` walks all of
them — prefer the iterator, since the gateway echoes back raw (sometimes `undefined` or `0`)
query values rather than resolved pagination state. Writes to versioned resources take a required
`ifMatch` option (the row itself, not a header you capture) — forgetting it is a compile error,
and a stale precondition throws `VersionConflictError` (412).

### Summarization is consultation-bound

`hope.consultations.summaries.*` (`generateAsync`/`generatePreSummaryAsync` — job-backed, pair
with `hope.jobs.waitFor()` — plus `list`/`latest`/`latestPreSummary`, `update`, `approve`) is the
SDK's one summarization surface: a consultation must exist first, and every summary/pre-summary is
a persisted, versioned `ContextItemVersion` row on it, wire contract v2 native (`camelCase`). The
SYNCHRONOUS `generate`/`generatePreSummary` methods were removed outright in TASK-1006 (their
gateway routes were retired alongside them) — use the `*Async` methods, which were already the
recommended path for anything but a trivially short generation. The stateless, v1-compat
`hope.summarization.*` (`preSummary`/`preSummaryStream`/`summary`/`summaryStream`, no consultation
required) was removed outright — TASK-1004, zero production traffic in the ten days before removal.

### Running workflows and invoking agents

`hope.workflows.*` runs a tenant's published workflows standalone;
`hope.consultations.workflows.*` runs the same, bound to one consultation, and can write into a
clinical record (ability `execute:ConsultationWorkflow`, API-key scope `workflows:execute`) —
these are deliberately different powers on different routes. `hope.agents.*` invokes a single
published Agent directly (`TEXT_GENERATION`, `TEXT_TO_SPEECH`, `SPEECH_TO_TEXT` batch,
`NAMED_ENTITY_RECOGNITION`); NER is one-shot (`?mode=stream` on a NER agent is a gateway 400).
Administration of agents/workflows is the generated admin plane, service-account only.

`streamRun`/`runAndStream` resume via `Last-Event-ID`; `transport: 'socket'` mints a run-scoped,
single-use ~30s ticket and opens a WebSocket instead — SSE stays the default because it is the
only lane that resumes. `options.idempotencyKey` derives the run id from `(tenant, slug, key)`, so
a retry with the same key JOINS the run already in flight rather than starting a second one.
`input` may never carry the reserved keys `consultationId`, `externalPatientId`, `userId`,
`jobId`, `sessionId` — the SDK throws `ReservedRunIdentityError` before the request leaves.

**Batch transcription spans two planes, and the SDK hides the seam rather than the difference.**
`agents.transcribe(slug, { file })` uploads the audio as multipart to
`POST /audio/transcription-jobs/transcribe` (scope `stt:transcription:write`, the agent named in
the form); `agents.transcribe(slug, { mediaId })` posts JSON to `POST /agents/{slug}/transcriptions`
for media already uploaded. Either way you get a job handle — and the job is then read with
`agents.transcriptionJob(jobId)`, watched with `agents.subscribeTranscription(jobId, handlers)`
(SSE frames `status` / `progress` / `chunk` / `transcript` / `error`, ending itself on a terminal
`status`), or awaited with `agents.waitForTranscription(jobId, { pollIntervalMs, timeoutMs })`,
which resolves on COMPLETED/FAILED/CANCELLED/DEAD and throws `TranscriptionJobTimeoutError`
otherwise. The transcript is `resultText` on the completed job. **Not `hope.jobs.*`** — that is the
CONSULTATION jobs plane (`/consultations/jobs/{jobId}`) and answers 404 for a transcription job id.

### 5.0 — `RunHandle`: one handle for a workflow or an agent run

`hope.workflows.run(slug, input, options?)` and `hope.agents.run(slug, input, options?)` start a
run and return a `RunHandle<TOutput>`. `input` is the workflow's input object itself (an agent's
flat `{ text, context?, variables? }` body) — **not** wrapped in `{ input }`, which is what the
pre-5.0 `run()` took. An `Idempotency-Key` is sent on every start (your `options.idempotencyKey`,
else a fresh UUIDv7); the same key joins the run in flight (`run.joined === true`).

```ts
const run = await hope.workflows.run('note-writer', { note }, { idempotencyKey: `note-${visitId}` });

// Stream the text as it is written.
for await (const chunk of run.text()) process.stdout.write(chunk);

// The delivered value, verified (a stored result is fetched by signed URL and its sha256 checked).
// `null` when the run delivered nothing; throws `RunFailedError` when the run did not complete.
const note = await run.result();

// Wait for the end — streamed, or polled where a proxy buffers `text/event-stream`.
const outcome = await run.wait({ poll: true, intervalMs: 2_000 });
if (outcome.status !== 'COMPLETED') console.error(outcome.error?.code);

// Explicit and idempotent. Breaking out of a loop, aborting a signal or losing the connection
// NEVER cancels a run — it is a durable execution.
await run.cancel();

// Another process, later: pick the run up by id (makes no request).
const same = hope.workflows.attach('note-writer', run.runId);
for await (const event of same.events({ after: persistedSeq })) { /* typed protocol-v2 events */ }

// An agent run is the same handle; it has one step, `nodeId: 'agent'`.
const agentRun = await hope.agents.run('scribe', { text: transcript });
```

| Member                               | What it gives you                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `runId`, `kind`, `slug`, `joined`    | Identity. Persist `runId` immediately — there is no business-plane run listing                 |
| `text({ field?, nodeId? })`          | `AsyncGenerator<string>` of the text output                                                    |
| `events({ after?, autoResume? })`    | Typed protocol-v2 events; resumes by `seq`, never infers loss from a `seq` jump                |
| `result()`                           | The verified delivered value (`TOutput \| null`)                                               |
| `wait({ poll?, intervalMs? })`       | `RunOutcome` — `status`, `degraded`, `error`, `durationMs`, `tokens`, `result`                 |
| `cancel()`                           | Idempotent cancel; `cancel_requested` means the signal was SENT                                |
| `status`, `lastSeq`, `outcome`       | The handle's current view of the run                                                           |

Each iterator is an independent connection with its own cursor, so they can be combined freely.
`start()`, `runAndWait()`, `runAndStream()`, `streamRun()` and `waitForRun()` are kept (not removed
in 5.x) and marked `@deprecated` where `RunHandle` supersedes them; `start()` is the old `run()`
(the bare 202 body). Pass the types `vox-codegen --api-key … --workflows` emits for a typed call:
`hope.workflows.run<Workflow_NoteWriter_Input, Workflow_NoteWriter_Output>(…)`. Runnable:
`examples/09-completion-signals.ts`.

### Live audio into a run — `hope.workflows.runWithAudio` (TASK-1042)

A standalone workflow run (no consultation) can be fed by live audio when its Input shape declares
a stream-delivery audio kind and its settings enable the `socket` connection. `runWithAudio` does
the three steps in the one order that works: open an STT session **bound to the workflow**
(`createStreamSession({ workflowSlug })`), connect its socket, then start the run with
`input[audioField] = { sttSessionId }`.

```ts
const { run, audio } = await hope.workflows.runWithAudio('live-note', { visitType: 'follow-up' }, { language: 'en', idempotencyKey: `note-${visitId}` });
for await (const frame of pcm16Frames) audio.sendPcm16(frame); // PCM16 little-endian, mono
await audio.finalize(); // flushes the tail, closes the session
const delivered = await run.result(); // the run carried on while the audio ended
```

- `audioField` defaults to the single key of the published Input shape whose schema is the
  stream-audio payload (an object whose only property is `sttSessionId`). Zero or several keys throw
  `RunAudioFieldError` before any session exists; pass `audioField` to choose.
- `agentSlug` overrides the ASR agent; by default the workflow's own `SPEECH_TO_TEXT` node decides.
- If anything after the session exists fails (socket, run start), the socket and the session are
  closed and the original error is rethrown.
- **Ending the audio never cancels the run.** `audio.finalize()` and `audio.close()` stop the audio
  only; `run.cancel()` is the one way to stop a run.
- A refused start keeps the gateway's `code`: 400 `RUN_AUDIO_INPUT_UNDECLARED`,
  `RUN_AUDIO_MULTIPLE`, `LIVE_AUDIO_UNSUPPORTED`; 409 `RUN_AUDIO_SESSION_NOT_LIVE`,
  `RUN_AUDIO_SESSION_BOUND_ELSEWHERE`, `RUN_AUDIO_AGENT_MISMATCH`; 404 when the session is unknown,
  another tenant's or another principal's.
- Zero runtime dependencies stay: the socket is `globalThis.WebSocket` (Node 22+), else
  `SocketUnavailableError`. `CreateStreamSessionRequest.workflowSlug` is mutually exclusive with
  `consultationId` (400 `STREAM_SESSION_TARGET_CONFLICT`) if you drive `hope.stt.*` by hand.

### DNA writing style — `hope.dnaWritingStyle.*`

`ingest({ clinicianUserId?, items })` submits 1-200 time-ordered writing samples so the platform's
hidden `dna-writing-style-analyst` agent can regenerate a clinician's writing-style report.
`clinicianUserId` is required for a machine caller, refused for a human acting for themselves.
`waitForIngestJob` POLLS `getIngestJob` (no SSE on this route) and throws
`DnaIngestJobTimeoutError` after `timeoutMs` (default 120000ms); a failed job resolves normally.

### Realtime consultations

`open<TContext>()` fixes identity for the whole visit: `clinicianUserId` (-> `Consultation.doctorId`),
`departmentId` (governing workflow + note shape), `parentConsultationId` (present = revisit,
absent = new visit), `language`/`languageMode` (the SPOKEN language, independent of the note's
language — never the other way round). It is GENERIC on `context` — pass the
`OpenConsultationContext` type `vox-codegen --tenant` generates for your tenant's schema and the
payload is checked at the call site, not just at the gateway.
Then: open an STT session (`hope.stt.createStreamSession`), start recording with that session id,
subscribe to `hope.consultations.streams.liveSummary/liveAssist/harnessProgress/loop` (each
returns `{ close() }`; `onError` is required — a subscription is fire-and-forget), stream PCM16
LE mono up `hope.stt.socket(session)`, then stop recording and read the finished note. The full
journey, including the finish (below), is `examples/06-realtime-consultation.ts`.

`RealtimeSttSocket` is a socket client, not an inference stack: the handshake carries a
single-use ticket (never a credential), reconnects resume via `{ type: 'resume', sessionId,
lastSeq }`, and it needs `globalThis.WebSocket` (Node 22+) — no polyfill is bundled, so its
absence throws `SocketUnavailableError` rather than silently degrading. Which ASR runs is
`agentSlug` (a published `SPEECH_TO_TEXT` agent) or nothing: omitted, the session's
`consultationId` — when its governing workflow names a speech-to-text agent — wins, otherwise the
tenant admin's assignment (department first, then tenant default) decides. The resolved choice is
echoed on `agentSource`.

**Spoken-language selection (TASK-1004).** `languageMode` (a catalog id like `'en'`/`'ml-en'`;
`(string & {})`-widened so a newly added mode still type-checks) is accepted by
`consultations.open`, `stt.createStreamSession` and `agents.transcribe` — omit it and a linked
consultation's declared mode is inherited, then the resolved agent's own default, then `'auto'`.
Change a consultation's default mid-visit with
`consultations.updateLanguage(id, { languageMode }, { ifMatch? })` (OCC `PATCH`; omit `ifMatch` and
it reads the consultation first to build one). Every resolution — live session create, the STT
`status`/`ready` socket frames, and a batch transcription job — carries a `languageResolution`
receipt: which tier won (`requestedMode`/`source`/`appliedMode`), the serving `engine` and
`provider`, the vendor `params` actually applied, and `degraded`/`reason` when the engine could
only approximate the requested mode (never a silent downgrade — a mode NO engine in the chain can
serve at all is refused at create, before any audio is accepted).

`hope.tenants.contextSchema()` returns the tenant's pinned context-schema bundle; pin its
`contextSchemaVersionId` on every `addContext` call so a mid-run publish never silently changes
validation. `@arcaai/vox-codegen --tenant` generates TypeScript types from the same bundle and
accepts a service account as well as a human JWT. `hope.consultations.listContext(id)` reads
every context item back — including the `kindKey` / `contextSchemaVersionId` each one was
validated under, which `addContext`'s own response never carried before now.

Every `HopeAPIError` may carry `.problems` — one human-readable string per validation failure
(the house `{ message, code, problems? }` shape), lifted for every 4xx status. `open()` itself can
refuse `WORKFLOW_CONTEXT_INCOMPATIBLE` (400) when the governing workflow's trigger would not
accept the context you sent — see `@arcaai/types`' `OPEN_REFUSAL_CODES` for the full union,
re-exported from this package.

`ConsultationOpenResponse.governingRun` / `ConsultationGetResponse.governingRun` /
`hope.consultations.get(id)` read the consultation's governing workflow run — `null` when
ungoverned — derived from the persisted marker, never a live harness call. Read
`WorkflowSchemaDescription.reviewNodes` (from `hope.workflows.schema(slug)`) to discover a
`core.humanReview` node id without hardcoding it, release it with
`hope.workflows.reviews.get/decide(slug, runId, nodeId)`, then finish the consultation:
`hope.consultations.summaries.approve(consultationId, contextItemId, { clinicianUserId? }, { ifMatch })`
signs the note (legal from `PENDING_REVIEW`, `DRAFT_PENDING_SENSORS`, `TIMED_OUT` or `CLOSED_INCOMPLETE`), and
`hope.consultations.close(consultationId, { clinicianUserId? }, { ifMatch })` closes it (only
legal from `SIGNED` or `TIMED_OUT` — a `PENDING_REVIEW` consultation must be approved first, or
`close()` answers 409). Both need the row's `version` as `ifMatch`, exactly like every other
OCC-guarded write in this SDK.

### Visits, return visits and the final note (TASK-1020)

`consultations.open` returns the visit's identity and whether it may still be recorded:
`status` (the 12-value `ConsultationStatus`), `visitType` (`'new-visit' | 'revisit'`),
`externalRef` (`string | null`), `parentConsultationId` (`string | null`) and `recordable`.

- **One consultation per visit.** With an `externalRef` (the value of the schema's
  `externalRef`-marked context field, e.g. `context.encounter.event_id` for ArcaAI) the same ref
  returns the same consultation and a new ref creates a new one — a patient seen again the same
  day is a second, chained consultation. A `revisit` open with no `parentConsultationId` gets a
  server-derived same-day parent. The ref bound to a different patient is a 409
  `EXTERNAL_REF_CONFLICT`; a parent of another patient is a 400 `PARENT_PATIENT_MISMATCH`.
- **Check `recordable` before `recording.start`.** A signed or closed consultation is returned
  as-is with `recordable: false`; `recording.start` on it is a 409 `CONSULTATION_NOT_RECORDABLE`.
  Start a return visit by opening with a new `externalRef` instead.
- **`consultations.chain(id)`** reads the chain the visit belongs to (`GET consultations/:id/chain`).
- **`consultations.waitForFinalNote(id, { since, timeoutMs?, pollIntervalMs?, signal? })`** resolves
  with the latest summary only once it is NEWER than `since` (pass the moment you stopped — the
  `updatedAt` of the `recording.stop` response) and the status is note-ready. A stale note from an
  earlier recording is never returned. It rejects with `FinalNoteUnavailableError` when the
  consultation closes `CLOSED_INCOMPLETE` with no fresh note, and `FinalNoteTimeoutError` on
  timeout.

```ts
const stopped = await hope.consultations.recording.stop(id);
const note = await hope.consultations.waitForFinalNote(id, { since: stopped.updatedAt });
```

### Async jobs

For long transcripts, `generateAsync` + `jobs.waitFor` hands generation to a background job;
`waitFor` prefers the live SSE stream and falls back to polling if the stream drops before a
terminal status.

### Receiving webhooks

Subscribe with `hope.admin.webhookEvent.create(...)` (service account only, scope
`svc:webhook:event:write` — not covered by `svc:admin:*`); the `rawSecret` in the response is
shown once. A subscription is per resource type, not per event type, and delivers references
(`resourceId`, `fetchUrl`), never content — HOPE will not push PHI to a third-party endpoint.
Verify every delivery with `verifyWebhookSignature(rawBody, header, secret)` against the RAW body
before parsing (`X-Hope-Webhook-Signature: sha256=<hex>`, constant-time, never throws).

A workflow run **does** fire a webhook: `WorkflowRunService.recordRunFinished` emits exactly one
sys-event per TERMINAL transition, so a subscription with `resourceTypeName: 'WorkflowRun'`
receives it — and because the start of a run emits nothing, a delivery IS "the run finished". It
no longer depends on somebody reading the run either: a gateway-side watcher attaches to the run's
event stream independently of any HTTP connection. Holding the stream (`waitForRun`) and polling
(`getRun` until `isTerminalRunStatus`) remain available and are lower-latency; pick by whether
your process can afford to stay connected. See `examples/09-completion-signals.ts`.

### Errors

Every non-2xx response throws a typed `HopeAPIError` subclass: `AuthenticationError` (401),
`PermissionError` (403), `NotFoundError` (404), `ConflictError` (409, told apart by `error.code` —
`CONSULTATION_NOT_RECORDABLE`, `CONSULTATION_TRANSITION_ILLEGAL`, `EXTERNAL_REF_CONFLICT`,
`STT_SESSION_NOT_ACTIVE`; `QuotaExceededError extends ConflictError` and is raised only for
`DOMAIN.QUOTA_EXCEEDED`), `VersionConflictError` (412), `PreconditionRequiredError` (428), `RateLimitError` (429),
`APIConnectionError`/`APITimeoutError` (no HTTP status — connection-phase failures). Streaming
methods can also throw `HopeStreamError`.

### PHI/logging and retry posture

Request/response bodies are never passed to the injected `logger` — only `message` plus
non-content `meta` (method, path, status, `requestId`); a `logger` is currently accepted but not
yet wired to any request, so it receives nothing today. Credential headers
(`Authorization`, `X-API-Key`, `X-Service-Token`, `Cookie`) are redacted on the way in, and thrown
errors never carry response bodies. No on-disk caching. Retries: `408`/`429`/any `5xx`/connection
failures, exponential backoff with full jitter, `Retry-After` honored on 429, default
`maxRetries: 2`. Non-idempotent `POST`s are never retried unless an idempotency key was supplied;
`generateAsync`/`generatePreSummaryAsync` auto-generate one, which also makes them safely
retryable.

## Gotchas

- **`NotFoundError` can mean "not yours".** HOPE's tenancy posture is 404-over-403: a cross-tenant
  read or write returns 404, never 403. Do not assume the id is wrong before checking tenant
  ownership.
- **`summaries.update()`'s `ifMatch` is a no-op today.** `PATCH :id/summary/:summaryId` carries
  neither `@RequiresIfMatch()` nor `@ExpectedVersion()` server-side and appends a new
  `ContextItemVersion` row on every edit — a missing `If-Match` never 428s and concurrent edits
  never 412. The SDK still accepts and forwards `ifMatch` forward-compatibly; do not build
  conflict-detection logic around it yet.
- **A run's terminal status survives a gateway restart only on the next read.** A gateway-side
  watcher records the terminal frame without any reader attached, but it is per PROCESS: a run
  whose gateway restarts mid-run is reconciled by the next `getRun`, as before. Nothing is lost —
  the outcome just arrives later than the webhook would have.
- **Two job-status vocabularies for the same workflow.** `generateAsync` returns
  `pending | processing | completed | failed`; `jobs.get`/`jobs.stream` return
  `PENDING | RUNNING | COMPLETED | FAILED | CANCELLED`. Use the exported
  `isTerminalJobStatus(status)` rather than hand-rolling a comparison.
- **`clinicianUserId` and a staff-identity context field must agree** on `open()` when both are
  sent (400 `CLINICIAN_MISMATCH`); a service account that sends neither gets 400
  `CLINICIAN_REQUIRED`.
- Never hand-edit `src/resources/admin/**` — only `admin-resource.ts` is hand-authored; everything
  else is generated and CI-gated against drift.

## Related

- [`@arcaai/vox`](../agentic-sdk-v2/README.md) — the browser consultation SDK; JWT-first, has the
  audio pipeline this package deliberately does not.
- [`@arcaai/vox-codegen`](../vox-codegen/README.md) — generates TypeScript types from a tenant's
  context schema or a tenant's published agents/workflows.
- [`@arcaai/vox-node-codegen`](../vox-node-codegen/README.md) — the private generator that
  produces `src/resources/admin/**`.
- [`examples/`](./examples) — seven runnable examples with their own `examples/README.md`.
- [`docs/guides/client-integration-guide.md`](../../docs/guides/client-integration-guide.md) — the
  end-to-end integration guide these examples illustrate.
- `.claude/rules/08-vox-sdk.md` — SDK architecture and credential-class rules.
