# @arcaai/vox-node — Changelog

## Unreleased — 3.6.0

### Minor Changes

- **`consultations.listContext(consultationId)`** — `GET consultations/{id}/context`. Reads back
  every context item written on the consultation, including `kindKey` and
  `contextSchemaVersionId`, which `addContext`'s own response never projected. Scope
  `svc:consultation:session:read`.
- **`open<TContext>(request)` is now generic** on `context`'s shape. A caller that ran
  `vox-codegen --tenant` can pass the generated `OpenConsultationContext` type here and have the
  payload checked at the call site; the default (`Record<string, unknown>`) is unchanged for an
  untyped caller.
- **`ContextItemResponse` now carries `kindKey: string | null` and
  `contextSchemaVersionId: string | null`** (always present, possibly `null`) — the gateway's
  `ContextDtoMapper` did not project either field before this release, so a caller had to
  remember what it sent rather than read it back.
- **`ConsultationGetResponse` gains `language`, `metadata`, `parentConsultationId`, and
  `governingRun`; `ConsultationOpenResponse` gains `governingRun`.** `governingRun` is
  `GoverningRunSummary | null` (re-exported from `@arcaai/types`): the consultation's governing
  workflow run, derived from the persisted `metadata.governingEngine` marker, never a live
  harness call.
- **`HopeAPIError.problems?: string[]`**, lifted in `fromResponse` from the house
  `{ message, code, problems? }` body shape, for every 4xx status. `open()` can now answer 400
  `WORKFLOW_CONTEXT_INCOMPATIBLE` — read this ticket's full refusal-code union as
  `OPEN_REFUSAL_CODES` (`OpenRefusalCode`), re-exported from `@arcaai/types`.
- **`WorkflowSchemaDescription` gains `contextSchema` and `reviewNodes`.** `contextSchema` names
  the schema (and version) a definition's `core.trigger` is bound to, and whether it tracks the
  tenant's pin (`followsLatest`) or is frozen to the published version. `reviewNodes` is every
  `core.humanReview` node in the graph, in graph order — the intended way to discover a review
  node id rather than hardcoding one.
- **`WorkflowRunStatus` gains `degraded: boolean` and four node counts** (`nodeCount`,
  `failedNodeCount`, `degradedNodeCount`, `skippedNodeCount`, each `number | null`). DEGRADED
  stays a per-run FLAG, never a persisted run STATUS — `status` never carries the interpreter's
  own `DEGRADED` word; read `degraded` instead.
- **`API_KEY_SCOPE_PRESETS` / `ApiKeyScopePreset` / `ApiKeyScopePresetKey`** re-exported from
  `@arcaai/types` — the three scope presets (`consultation-app`, `types-codegen`,
  `agents-and-workflows`) the tenant console's create-key dialog offers.
- New example — **`examples/06-realtime-consultation.ts`**: the whole machine-driven consultation
  journey, open through close, including the review gate and the approve/close finish.
- `@arcaai/types` is now a **devDependency** (not a runtime dependency) — the two runtime
  constants it supplies (`OPEN_REFUSAL_CODES`, `API_KEY_SCOPE_PRESETS`) are inlined into the built
  bundle by `tsup`, so the package's **zero-runtime-dependency guarantee is unchanged**;
  `pnpm check:exports` (`attw --pack . && publint`) is the gate that would catch it drifting into
  a real dependency.

### Read this before you upgrade

- `open()`'s new `WORKFLOW_CONTEXT_INCOMPATIBLE` refusal is a NEW way an existing call can fail:
  a consultation whose context does not match what its governing workflow accepts now refuses
  synchronously (400) on the CREATE path, rather than opening ungoverned. Catch it alongside the
  other members of `OPEN_REFUSAL_CODES`.
- `ContextItemResponse.kindKey` / `.contextSchemaVersionId` and `ConsultationGetResponse.governingRun`
  / `ConsultationOpenResponse.governingRun` are additive fields — no existing field changed shape.

## 3.5.0

### Minor Changes

- **The finish half of the consultation plane — `hope.consultations.summaries.approve()` and `hope.consultations.close()` (TASK-972).** The realtime plane (TASK-933) opened `open`/`recording.*`/the live SSE streams to machines, but the sign-off and the close were never wrapped, so a machine integration could run a consultation end to end and then had no way to submit the clinician's reviewed note or finish the session — `close` was always real and OCC-guarded at the gateway (the browser SDK's `useArcaSession().close()` already calls it); only the SDK surface was missing.
  - **`hope.consultations.summaries.approve(consultationId, contextItemId, request, options)`** — `POST consultations/{id}/summary/{contextItemId}/approve`. Signs and locks the summary under optimistic concurrency; `options.ifMatch` is **required** (the route carries `@RequiresIfMatch()` — a 428 otherwise). `request.clinicianUserId` names the clinician the approval is attested for: required for a service-account caller, refused for a non-admin human, 404 for a clinician outside the tenant.
  - **`hope.consultations.close(consultationId, request, options)`** — `POST consultations/{id}/close`, the bookend to `open()`. Legal only from `SIGNED`/`TIMED_OUT` (409 otherwise — `summaries.approve()` must succeed first from `PENDING_REVIEW`). Same required `options.ifMatch` and optional `request.clinicianUserId` shape as `approve()`.
  - Both methods are reachable by **either** machine credential class — an API key or a service account — — neither route refuses a credential class client-side, so no client-side guard is applied.
  - **`options.ifMatch` accepts a version NUMBER or a raw `ETag`.** The gateway accepts only a strong validator (`/^"(0|[1-9][0-9]*)"$/`), and the only version a consumer can read is `ConsultationGetResponse.version` — a number — so `String(c.version)` would send the one form the gateway rejects. Pass `ifMatch: consultation.version` and the SDK quotes it; a raw `"7"` or `W/"7"` passes through untouched.
  - **`ConsultationGetResponse.version` and `ConsultationSummaryResponse.version` are now declared.** The gateway returns both (`ConsultationResponse.version` is documented as "Read this to build the `If-Match` header"), but neither SDK type carried the field — so the one value the new methods require could not be read without a cast.
  - `hope.consultations.summaries.update()` is unchanged — it already reaches both machine classes once the gateway grants the scope; this release adds no client code for it.

## 3.4.0

### Minor Changes

- **`hope.consultations.documentSections(consultationId, documentKey?)`** — the template-shaped note. Reads `GET /consultations/{id}/documents/sections` (scope `svc:consultation:report:read`) and returns `DocumentSection[]`: one row per section HOPE persisted (`documentKey`, `sectionKey`, `title`, `idx`, `state`, `revision`, `content`, `documentTemplateVersionId`, …). HOPE persists only the sections that carry content, so a caller lays the rows onto the template it already holds from the live snapshot — which is what lets a client render the partial and the finalized note as ONE document with the same keys and order.

## 3.3.0

### Minor Changes

- TASK-951 — the ArcaAI realtime contract on the SDKs.

  - `hope.stt.createStreamSession({ context })` (vox-node) / the stream-session request (vox): a client-declared session context (≤ 4 KB), validated against the ASR agent's frozen context schema and echoed VERBATIM on every transcript of that session together with `sessionEpochMs`.
  - `RealtimeSttSocket.setMetadata(value)` (vox-node) and `SttWebSocketClient.setMetadata(value)` (vox): declare the metadata in force from the current point of the audio onward — one microphone at a time, sticky until the next declaration, no timestamp. Every transcript then carries `metadata` (the flat object in force over its audio, e.g. `{ mic_id: '2' }`) and `metadataSpans` (`SttMetadataSpan[]` / `WsMetadataSpan[]`, the exact bounds clipped to the segment). Refusals arrive on the error channel — `METADATA_TOO_LARGE`, `METADATA_INVALID`, `METADATA_SCHEMA_VIOLATION` with `problems` — and never end the session.
  - `@arcaai/vox-codegen`: the context-schema marker roles (`userIdentity`, `department`, `visitType`, `externalRef`, `materializeAs`, `streamContext`) are emitted as documentation tags on the generated kind types.

## 3.2.0

### Minor Changes

- **The realtime consultation plane — a server can now drive a HOPE consultation end to end (TASK-933).**

  `@arcaai/vox-node` previously stopped at stateless summarization and job submission; a service that already had audio (a telephony bridge, a recording relay) had no way to open a consultation, stream into it, or watch it produce a note. It does now, and the package still has **zero runtime dependencies**.

  - **`hope.consultations.open(request)`** takes `clinicianUserId`, REQUIRED for a service-account caller and refused (400) for a human one — a machine is never recorded as the clinician, so the named user lands on `Consultation.doctorId` and the audit names the service account as the actor beside them. Identity fixes at open: `departmentId` selects the workflow and note shape, `parentConsultationId` is the visit-type signal, and `language` fixes the note's language (never the STT language). `hope.consultations.get(id)` reads it back.
  - **`hope.consultations.recording.{start,stop}`** and the four live SSE planes under **`hope.consultations.streams`** — `liveSummary`, `liveAssist`, `harnessProgress`, `loop`. Each is a handler subscription returning `{ close() }`, and `onError` is REQUIRED on every one: a subscription is fire-and-forget, so a 403 with nowhere to go is indistinguishable from a quiet consultation. `liveSummary` is MULTIPLEXED — snapshot / `section.patch` / `presummary`, discriminated by the `event` field IN THE JSON, never by the SSE `event:` line.
  - **`hope.stt.*`** — `createStreamSession` / `refreshTicket` / `closeStreamSession` / `socket(session)` — plus **`RealtimeSttSocket`**: binary PCM16 LE mono up, typed `transcript` / `status` / `error` / `resumed` events down. The handshake carries a SINGLE-USE ticket, never a credential, so every reconnect mints a fresh one and re-handshakes with `{type:'resume', sessionId, lastSeq}`. It is `globalThis.WebSocket` and nothing else — a runtime without it gets `SocketUnavailableError`, not a silent polyfill.
  - **`hope.jobs.subscribe`** joins the existing `jobs.stream` generator with the same handler shape.

  ASR selection stays `agentSlug` or nothing, resolved by the gateway: this is a socket client for HOPE's `/ws/stt/stream` protocol, **not** an inference stack — no capture, no VAD, no denoise, no models.

  **Both machine credential classes now reach the consultation plane.** `assertCredentialClass()` replaced the hard-coded API-key check per resource, so an API key and a service-account token both reach consultations, agents and workflows; only `hope.admin.*` stays service-account-only. `CredentialClassError` / `assertApiKeyPlane` remain exported for integrators on older versions.

### Patch Changes

- a0e73e1: **`RealtimeSttSocket#stop()` is renamed to `finalize()` — its old doc comment was wrong, and it cost real consultations.** `stop()` documented itself as "finalize the current utterance. The SESSION stays open — this is not a close." That was never true: the `{type:'stop'}` frame it sends is forwarded by the gateway to the tenant's ASR service as a `finalize` control command, which flushes the tail of the utterance and then CLOSES the session (observed live: `status finalizing` → `status closed`, the session's Redis status ending `closed`). Two integrators called `stop()` mid-consultation expecting to keep streaming and lost the rest of the session.

  `finalize()` carries the corrected doc and is now the primary name; `stop()` is kept as a `@deprecated` alias that delegates to it and sends the exact same wire frame — no wire-protocol change, this is a documentation and naming fix. Existing callers of `stop()` are unaffected functionally and should migrate to `finalize()` at their own pace.

- e8e8518: `consultations.summaries.generate` and `generatePreSummary` now wait up to `SYNC_GENERATION_TIMEOUT_MS` (180 s) when neither the call nor the client names a `timeoutMs`, instead of the transport's 60 s default; `ConsultationSummaryRequestOptions.timeoutMs` overrides it per call. A four-note pre-summary took 46–68 s on a local model and the old default gave up before the gateway answered (TASK-946).

## 3.1.0

### Minor Changes

- 2e09493: **A service account can now run agents and workflows, NER is a task, and a run stream can
  be a socket (3.1.0).**

  **The invocation plane accepts both credential classes.** `hope.agents.*` and
  `hope.workflows.*` were API-key-only: every method called `assertApiKeyPlane`, so a client
  constructed with a service account was refused locally. The gateway now declares
  service-account scopes for those routes (`svc:agent:definition:read`,
  `svc:agent:invocation:write`, `svc:workflow:definition:read`, `svc:workflow:run:read`,
  `svc:workflow:run:write`), so the local refusal is gone and ONE client can both administer
  and invoke. The rule that made the refusal necessary is unchanged and still enforced at
  construction: a service-account client never sends `X-Tenant-Id`, because `workingTenantId`
  binds at token EXCHANGE. The admin plane is still service-account only, and an API key still
  cannot reach `/admin/*` under any scope.

  **Named entity recognition.** `AgentTask` gains `'NAMED_ENTITY_RECOGNITION'`, so
  `hope.agents.list({ task: 'NAMED_ENTITY_RECOGNITION' })` types, and `invoke` returns the
  agent's entities. `NamedEntityRecognitionInput` / `NamedEntityRecognitionOutput` /
  `RecognizedEntity` describe the default schema. It is a one-shot task — `invokeAndStream`
  on a NER agent is a gateway 400, not a slower answer.

  **`transport: 'socket'` on `streamRun` / `waitForRun` / `runAndStream`.** Mints a run-scoped
  single-use ticket (`POST /workflows/{slug}/runs/{runId}/stream-ticket`) and reads the run's
  events over `globalThis.WebSocket`, resolving the ticket's `url` against the client's
  `baseUrl` (`http(s)` → `ws(s)`). Same events, same terminal detection, same
  `waitForRun` return. **Still zero runtime dependencies**: the socket is the platform global,
  which means Node **22 or newer**. On a runtime without it the SDK throws
  `SocketUnavailableError` naming that floor instead of importing a polyfill you did not ask
  for. SSE remains the default and the only lane that RESUMES — a dropped socket ends the
  iteration, where SSE reconnects with `Last-Event-ID`.

  **`SDK_VERSION` is derived from `package.json` at build time.** It was a hand-maintained
  literal and had already drifted, so every request from the shipped SDK announced the wrong
  version in `User-Agent` — discoverable only mid-incident, while correlating SDK versions in
  gateway logs.

  **Docs.** The generated `hope.admin.*` surface is **49 areas**, not the 52 the 3.0.1 notes
  and the README claimed (three areas left with the routes they wrapped: `ai-task-defaults`,
  `pipeline-policy`, `tenant-tts-config`). `docs/architecture/vox-node-gateway-gaps.md` G3
  ("webhooks never fire") is closed — delivery shipped in TASK-890. New example
  `examples/05-agents-and-workflows.ts` runs an agent, streams a workflow and releases a
  human-review node end to end.

All notable changes to the `@arcaai/vox-node` server SDK are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at `[Unreleased]`. Releases up to and including `3.0.0` shipped
without a changelog of their own — the package is versioned in lockstep with the
`@arcaai/*` SDK family, so their history is
[`packages/agentic-sdk-v2/CHANGELOG.md`](../agentic-sdk-v2/CHANGELOG.md) and the
release notes in [`docs/operations/release-notes/`](../../docs/operations/release-notes/).

---

## [Unreleased]

### Added — TASK-931: the invocation plane accepts a service account

`hope.agents.*` and `hope.workflows.*` were API-key-only: every method called
`assertApiKeyPlane`, which refused a service-account client LOCALLY, before any request, because
`route-manifest.json` declared `svcScopes: []` on those routes and a 403 with no grantable scope
behind it is worse than an explanation. TASK-930 declares the scopes
(`svc:agent:definition:read`, `svc:agent:invocation:write`, `svc:workflow:definition:read`,
`svc:workflow:run:read`, `svc:workflow:run:write`), so the refusal is gone and ONE client can
administer and invoke.

The rule that made the refusal necessary is unchanged, and still enforced at construction: a
service-account client never sends `X-Tenant-Id`, because `workingTenantId` binds at token
EXCHANGE. `hope.admin.*` remains service-account only, and an API key still cannot reach
`/admin/*` under any scope — that is platform policy, enforced by a boot audit.

`CredentialClassError` and `assertApiKeyPlane` are still exported: the consultation-bound plane
(`hope.consultations.workflows`) is API-key/JWT only and still uses them.

### Added — TASK-931: `NAMED_ENTITY_RECOGNITION`

`AgentTask` gains the value, so `hope.agents.list({ task: 'NAMED_ENTITY_RECOGNITION' })` types
and filters. `invoke()` returns the agent's entities;
`NamedEntityRecognitionInput` / `NamedEntityRecognitionOutput` / `RecognizedEntity` describe the
task's DEFAULT schema (`{ text, language? }` → `{ entities: [{ text, label, start, end, score? }] }`)
— a tenant may author a different one, which is why they are a convenience type and not a
constraint on `invoke`.

It is a ONE-SHOT task: `?mode=stream` on a NER agent is a gateway 400 (`MODE_UNSUPPORTED`), so
`invokeAndStream` on one fails rather than answering slowly.

### Added — TASK-931: `transport: 'socket'` on the workflow run stream

`streamRun`, `waitForRun` and `runAndStream` accept `{ transport: 'socket' }`. The SDK mints a
run-scoped single-use ticket (`POST /workflows/{slug}/runs/{runId}/stream-ticket`) and reads the
run's events over `globalThis.WebSocket`, resolving the ticket's `url` against the client's
`baseUrl` (`http(s)` → `ws(s)`). Same event objects, same terminal detection, same `waitForRun`
return value — a one-word change at the call site.

**Still zero runtime dependencies.** The socket is the platform global, which means **Node 22 or
newer**; on a runtime without it the SDK throws `SocketUnavailableError` naming that floor rather
than importing a polyfill you did not ask for.

**SSE remains the default, and remains the only lane that RESUMES.** A dropped socket ends the
iteration (the ticket is single-use and the gateway replays nothing), where SSE reconnects with
`Last-Event-ID` and loses no frames. Reach for `socket` when something between you and the
gateway buffers `text/event-stream` — the symptom is a run that looks stalled and then completes
all at once — or when a socket is the budget you already hold.

### Fixed — TASK-931: `SDK_VERSION` is derived from `package.json`

It was a hand-maintained literal in `core/transport.ts` and had already drifted — it read `3.0.0`
while the package was `3.0.1`, so every request from the shipped SDK announced the wrong version
in `User-Agent`. `tsup` now substitutes the manifest's value at build time, with a manifest read
as the fallback when the source runs unbuilt.

### Fixed — TASK-931: the admin surface is 49 areas, not 52

`src/index.ts` and the README said 52 — the count from TASK-773, before `ai-task-defaults`
(TASK-881), `pipeline-policy` (TASK-882) and `tenant-tts-config` (TASK-888) left with the routes
they wrapped. The generated tree has said 49 since; only the prose was stale.
`docs/architecture/vox-node-gateway-gaps.md` G3 ("webhook deliveries never fire") is closed for
the same reason: delivery shipped in TASK-890.

### Added — TASK-931: `examples/05-agents-and-workflows.ts`

Runs a published agent, streams a workflow run over both transports, and releases a
`core.humanReview` node — the three surfaces the examples did not cover.

---

## [3.0.1] — 2026-09-07

### Added — TASK-890: `hope.agents.*`, the tenant's published agents

Hand-authored (like `hope.workflows`), API-key plane, six methods over five gateway routes:

| Method                                    | Route                                          |
| ----------------------------------------- | ---------------------------------------------- |
| `hope.agents.list({ task? })`             | `GET /api/v1/agents`                           |
| `hope.agents.get(slug)`                   | `GET /api/v1/agents/{slug}`                    |
| `hope.agents.invoke(slug, body)`          | `POST /api/v1/agents/{slug}/invocations`       |
| `hope.agents.invokeAndStream(slug, body)` | `POST /api/v1/agents/{slug}/invocations` (SSE) |
| `hope.agents.synthesize(slug, body)`      | `POST /api/v1/agents/{slug}/speech`            |
| `hope.agents.transcribe(slug, …)`         | `POST /api/v1/agents/{slug}/transcriptions`    |

**Selection is a `slug`, never a model, provider or pipeline id.** An agent names the
tenant's own published lineage; which model actually serves it is the agent's binding, resolved
server-side.

This surface is **API-key only** — every method calls `assertApiKeyPlane`
(`src/resources/agents.ts`), so a client constructed with a service account is refused locally
rather than at the gateway. Realtime ASR stays the browser SDK's job: this package still has
**zero runtime dependencies** and no audio stack.

### Added — TASK-890: the workflow surface completes

- `hope.workflows.run(slug, body)` — `POST /api/v1/workflows/{slug}/runs`
- `hope.workflows.runAndWait(slug, body)` — start, then poll/stream to a terminal status
- `hope.workflows.runAndStream(slug, body)` — start and yield `WorkflowRunEvent`s off
  `GET /api/v1/workflows/{slug}/runs/{runId}/stream` (SSE parsed off `response.body`, never
  `EventSource`)
- `hope.workflows.schema(slug)` — `GET /api/v1/workflows/{slug}/schema`, the run-input shape a
  caller must satisfy without reading the graph
- `hope.workflows.reviews.get(slug, runId, nodeId)` / `.decide(...)` — the human-review proxy,
  `GET`/`POST /api/v1/workflows/{slug}/runs/{runId}/reviews/{nodeId}[/decide]`

`hope.consultations.workflows.*` carries the same run/stream shape under a consultation.

### Added — TASK-890: `signWebhookTrigger`, the outbound half of the webhook pair

`signWebhookTrigger`, `WEBHOOK_TRIGGER_SIGNATURE_HEADER` (`X-Hope-Signature`) and
`WEBHOOK_TRIGGER_TIMESTAMP_HEADER` (`X-Hope-Timestamp`) sign an INBOUND workflow trigger for the
public `POST /api/v1/hooks/workflows/{hookId}` (`WorkflowHooksController.trigger`).

Deliberately a different header and a different signed string from the existing
`verifyWebhookSignature` (`X-Hope-Webhook-Signature`, delivery side): the trigger folds the
timestamp into the HMAC, which is what makes the gateway's 300-second replay window mean
anything. Same zero-dependency core, so it runs unchanged in Node, Bun, Deno and edge runtimes.

### Changed — the generated `hope.admin.*` surface

Regenerated by `pnpm --filter @arcaai/vox-node gen:admin` against
`apps/api/route-manifest.json` cross-checked with `apps/api/openapi.json`. It now carries
**49 administration areas over 429 routes** (`src/resources/admin/**`, counted from the generated
tree; the manifest declares 455 `/api/v1/admin/*` routes in total — the 40 unreached ones are the
five owner-closed areas plus routes with no service-account scope). Notable new members from this
ticket: `hope.admin.aiModel` gains the tenant-facing catalogue read
(`GET admin/ai-models/catalogue`, reachable with `svc:admin:ai-model:read` as well as `:manage`)
and the inventory sweep (`POST admin/ai-models/inventory`); `hope.admin.agent` covers
`POST admin/agents/{id}/test[/finalize]`; `hope.admin.tenant` covers
`POST admin/tenants/{id}/reference-set/sync`; `hope.admin.aiProvider` covers
`PUT admin/providers/{service}/{provider}/models`; `hope.admin.aiService` covers
`GET`/`POST admin/ai-services/readiness[/refresh]`.

Never hand-edit `src/resources/admin/**` — only `admin-resource.ts` is hand-authored, and
`gen:admin:check` fails CI on any drift.

### Note — this package is where the browser SDK's admin surface went

`@arcaai/vox` removed its 25 admin hook families and every admin-bearing endpoint constant in
this same ticket (OD-F/OD-K); `AgenticClient` now throws `AdminPlaneRefusedError` before the
network call. **`hope.admin.*` here, with a service-account credential, is the supported
replacement** (the other being the admin console). No API-key integration is affected: every
`/admin/*` route is `@ForbidApiKey()`, so a key could never have reached them.

### Fixed — TASK-890 black-box J6: `hope.agents.invoke` sends the body the gateway validates

`invoke()` and `invokeAndStream()` wrapped the caller's object as `{ input }`. The gateway's
invocation body is **flat** — `{ text, context?, variables? }` — and it is validated against the
agent's own `inputSchema` (`additionalProperties: false` over `{ text, variables }`), so the
envelope failed that check on **every** call: a body that answered 200 over `curl` answered 400
through this SDK. The `{ input }` envelope belongs to the WORKFLOW plane
(`POST /workflows/{slug}/runs`), which is a different contract.

`context` is why it cannot be nested at all — the controller withholds it from the `inputSchema`
check and validates it against the agent's frozen context schema instead, so it is only
expressible at the top level.

**This is a behaviour change for callers**: the argument is now the body itself. A caller that had
worked around the bug by passing `{ input: {...} }` must unwrap it. The TASK-865 test that had
asserted the envelope now pins the flat body for both modes.

### Added — packaging

`CHANGELOG.md` is included in the published tarball (`package.json#files`).

### Added — TASK-773: the administration plane and the service-account credential class

The version number does not carry the size of this change — `3.0.0 → 3.0.1` was a deliberate
patch bump per owner decision D-4, taken so the SDK family stays in lockstep. Read this entry,
not the number, for what landed.

`new HopeClient({ serviceAccount: { clientId, clientSecret } })`. The SDK exchanges the pair at
`POST /auth/service-token` for an opaque short-lived token and presents it as
`X-Service-Account-Token`. Construction still never touches the network: the first call exchanges
lazily, the token is cached and refreshed on a margin before expiry, concurrent calls during a
refresh collapse to one exchange, and a token revoked mid-flight (revocation is immediate, not
TTL-bound) is re-exchanged once and the call retried. Neither the secret nor the token can reach a
log line or a serialized error.

An API key still cannot reach `/admin/*` under any scope, including `*` — platform policy,
enforced by a boot audit, not a gap. A service account is the only path.

**`workingTenantId` binds at exchange, not per request.** This is the one place API-key intuition
misleads: a token _carries_ its working tenant, so the SDK never sends `X-Tenant-Id` alongside it.
Supplying top-level `tenantId` together with `serviceAccount` throws at construction rather than
being silently dropped, as does supplying `apiKey` and `serviceAccount` together (the gateway
rejects two credentials, so failing at construction turns a runtime refusal into a programming
error).

`hope.admin.*` is generated from the gateway's own route metadata cross-checked against its
OpenAPI document, with a CI gate that fails on drift. Areas are named after the scope they require
(`svc:admin:tenant-tts-config:manage` → `hope.admin.tenantTtsConfig`), and every 403 names the
scope that route needs.

Three behaviours worth knowing before writing against it:

- **Use `listIterate()` rather than a hand-rolled page loop.** The gateway echoes back the raw
  `page`/`limit` query values, so reading them off the response and incrementing does not work;
  the iterator drives pagination from the request side.
- **The row is the OCC precondition**, not a header — `update(id, patch, { ifMatch: row })`.
  `ifMatch` is a required property, so forgetting it is a compile error rather than a 428. List
  responses carry no ETag at all, since one validator cannot represent N rows.
- **A 404 can mean "not yours"**, not "does not exist" — the platform answers cross-tenant reads
  with 404 deliberately.

Five admin areas are deliberately absent, machine-closed by owner decision: service-account
issuance (self-replication), impersonation (it would defeat audit attribution, which records
exactly one actor — human or machine, never both), consent grants (consent is an act of a
person), and the monitoring and service-health telemetry surfaces. A method that always 403s is
worse than no method.

Also exports `ServiceAccountCredentials` from the root barrel, previously reachable only from the
`core` subpath, so integrators could not name the type of the credential they were constructing.

### Added — earlier in the 3.0.1 window

Back-filled from git history; each shipped between `3.0.0` (2026-08-18) and the `3.0.1` bump.

- **TASK-865** — `hope.agents.*`: invoke a tenant's published Agents from a server (list, get,
  invoke, invokeAndStream, synthesize, transcribe). Selection is a `slug`, never a model,
  provider or pipeline id.
- **TASK-858** — `verifyWebhookSignature`: verify an inbound HOPE webhook delivery from the
  server SDK, zero dependencies, constant-time.
- **TASK-856** — workflow clone (`admin` surface) reached the generated tree.
- **TASK-855** — the model-download / model-registry admin surface reached the generated tree.
- **TASK-850b** — `hope.workflows` and `hope.consultations.workflows`: the workflow invocation
  plane, with SSE resume (`Last-Event-ID`), reserved run-identity refusal, and the blocking
  ceiling handled as non-retryable.
- **TASK-800** — consultation context write plus context-schema discovery.
- **TASK-760 / TASK-742** — `core/url.ts`'s prefix-exemption set re-synced with the gateway's
  own `main.ts` exclusion list.
