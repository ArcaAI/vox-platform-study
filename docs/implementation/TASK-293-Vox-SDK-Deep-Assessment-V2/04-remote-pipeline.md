# 04 — Remote Pipeline (admin-configured backend transcription)

| | |
|---|---|
| Reviewer | A4 (code-reviewer) |
| Date | 2026-05-24 |
| Parent ticket | [TASK-293](./README.md) |
| Predecessor | [TASK-262 08-api-cross-reference.md](../TASK-262-Vox-SDK-Deep-Assessment/08-api-cross-reference.md), [04-stt.md](../TASK-262-Vox-SDK-Deep-Assessment/04-stt.md), [07-pipeline.md](../TASK-262-Vox-SDK-Deep-Assessment/07-pipeline.md) |

---

## 1. Scope & method

This review evaluates the **remote** transcription path that the doctor selects when `provider === 'backend' | 'remote'`. The business requirement is that the doctor **chooses from a list of audio-processing pipelines pre-configured by a tenant admin** — the doctor never authors a pipeline.

I evaluated the following surfaces:

1. **SDK** — `packages/agentic-sdk-v2/src/core/constants.ts`, `usePipelines.ts`, `useArcaPipelines.ts`, `useUserSettings.ts`, `useArcaAudio.ts`, `core/StreamingSessionManager.ts`, `core/SttV2WebSocketClient.ts`, `core/PluginManager.ts`, `core/TranscriptionPipeline.ts`, `types/stt-v2.ts`, `types/config.ts`.
2. **SDK STT package** — `packages/stt/src/providers/BackendSTTProvider.ts` (a.k.a. `RemoteSTTProvider`), `packages/stt/src/core/STTProcessor.ts`.
3. **API gateway** — `apps/api/src/modules/pipeline/{audio-pipeline,audio-pipeline-public}.controller.ts`, `apps/api/src/modules/pipeline/dto/validate-yaml.dto.ts`, `apps/api/src/modules/streaming/{stt-ws.gateway,transcription-job.controller,smr-proxy.controller}.ts`, `apps/api/src/modules/consultation/{consultation,consultation-job}.controller.ts`, `apps/api/src/modules/internal/stt-internal.controller.ts`, `apps/api/src/guards/jwtauth.guard.ts`, `apps/api/src/modules/auth/decorators/stream-scope.decorator.ts`.
4. **Application + domain services** — `packages/applications/src/services/stt/pipeline/pipeline.service.ts`, `packages/applications/src/services/stt/streaming/streamingSession.service.ts`, `packages/domains/src/repositories/generated/core/AsrPipelineRepository.ts`.
5. **STT-V2 Python service** — `apps/stt-v2/src/stt_v2/streaming/api/routes.py`, `streaming/session_manager.py`, `pipeline/config_reader.py`.
6. **Tests** — `apps/api/src/modules/pipeline/__tests__/audio-pipeline.controller.test.ts`, SDK `usePipelines.test.ts`.

Method: static code review with file/line citations, cross-referenced against the TASK-262 gap matrix (GAP-05, GAP-06, R-04, R-06).

---

## 2. Current architecture

```
TENANT ADMIN UI                           DOCTOR UI                             BACKEND
─────────────────                         ──────────                            ───────
                                                                                  
usePipelines.create()                     usePipelines.list()                   AudioPipelineController
  POST /admin/audio/pipelines             ─► GET /audio/pipelines        ───►   (admin: CRUD + validate)
usePipelines.update()                                                            
  PATCH /admin/audio/pipelines/:id        usePipelines.select(id)        ───►   AudioPipelinePublicController
usePipelines.validateConfig()             (sets React state — no IO)            (public: fetchAll only)
  POST /admin/audio/pipelines/validate    [no persistence to user settings]     
usePipelines.delete()                                                            ▼
  DELETE /admin/audio/pipelines/:id       useArcaAudio.start({…})               PipelineService
                                          (pipelineId NOT propagated)           ─ create/update/delete (tenant scoped)
                                          [tries StreamingSessionManager? NO]   ─ getById (NOT tenant scoped) ⚠
                                                  │                              ─ validateYaml (shallow)
                                                  ▼
                                          STTProcessor.initializeRemoteProvider()
                                          → RemoteSTTProvider (legacy v1 WS)    [POST /stream/session is
                                          → WebSocket connect(sttSocket+sessionId)  NEVER CALLED from this path]
                                          [no pipelineId on the wire]           
                                                  │                              StreamingSessionManager
                                                  │   ┌── DEAD CODE (no consumer) ─►   POST /audio/transcription-jobs
                                                  │   │   StreamingSessionManager      /stream/session   { pipelineId, … }
                                                  │   │   SttV2WebSocketClient    ───►  ▼
                                                  ▼   ▼                                StreamingSessionService
                                          ws://api/ws/stt-v2/stream?sessionId=X       (forwards to STT-V2 internal)
                                          (NO auth required by gateway) ⚠               ▼
                                                  │                                    STT-V2 /internal/streaming/sessions
                                                  ▼                                       ─ get_pipeline(id) (no tenant check) ⚠
                                          SttWsGateway.handleConnection                   ─ load pipeline_config, build VAD/ASR
                                          (only checks ?sessionId=)                       ─ stream PCM → ASR → publish results
                                                  │                                            
                                                  ▼                                            
                                          bridgeService.subscribeToResults ──── stream back ◄── stt-v2 worker
                                                  │
                                                  ▼
                                          server-side result → ws.send(transcript JSON)
```

Two key flow anomalies are visible in this diagram and substantiated in §5:

- **`useArcaAudio` path** uses the legacy v1 WebSocket via `RemoteSTTProvider` and never tells the backend which admin pipeline to run.
- **`StreamingSessionManager` + `SttV2WebSocketClient`** are the pipeline-aware client the SDK shipped in W2/W3 of TASK-262 — but no top-level hook wires them in. They are reachable only via direct import.

---

## 3. Public surface map

### 3.1 Admin endpoints (`AudioPipelineController` at `/admin/audio/pipelines`)

| Method | Path | SDK constant | Hook | Status |
|---|---|---|---|---|
| GET | `/admin/audio/pipelines` | (no constant — uses `LIST` public) | — | ⚠ duplicated under admin and public |
| GET | `/admin/audio/pipelines/list?page&limit` | (none) | — | Orphan — SDK has no caller |
| GET | `/admin/audio/pipelines/:id` | `PIPELINE_ENDPOINTS.GET` | `usePipelines.get` | ⚠ Admin perms required, but `GET` constant points here for ALL users (see D-3) |
| GET | `/admin/audio/pipelines/slug/:slug` | `PIPELINE_ENDPOINTS.GET_BY_SLUG` | `usePipelines.getBySlug` | ⚠ Same — admin-only path used by all users |
| POST | `/admin/audio/pipelines` | `PIPELINE_ENDPOINTS.CREATE` | `usePipelines.createPipeline` | OK |
| PATCH | `/admin/audio/pipelines/:id` | `PIPELINE_ENDPOINTS.UPDATE` | `usePipelines.updatePipeline` | OK |
| DELETE | `/admin/audio/pipelines/:id` | `PIPELINE_ENDPOINTS.DELETE` | `usePipelines.deletePipeline` | OK |
| POST | `/admin/audio/pipelines/validate` | `PIPELINE_ENDPOINTS.VALIDATE` | `usePipelines.validateConfig` | ⚠ Body field mismatch (see D-6) |
| POST | `/admin/audio/pipelines/:id/assign-tenant` | `PIPELINE_ENDPOINTS.ASSIGN_TENANT` | `usePipelines.assignToTenant` | ❌ Route not implemented |
| POST | `/admin/audio/pipelines/:id/assign-user` | `PIPELINE_ENDPOINTS.ASSIGN_USER` | (no caller) | ❌ Route not implemented |

Permission: class-level `@Authorize(['manage', 'all'])` (`apps/api/src/modules/pipeline/audio-pipeline.controller.ts:17`). See D-4 — this is the CASL "do anything" check; it does not encode "tenant admin scoped to own tenant."

### 3.2 Public end-user endpoints (`AudioPipelinePublicController` at `/audio/pipelines`)

| Method | Path | SDK constant | Hook | Status |
|---|---|---|---|---|
| GET | `/audio/pipelines` | `PIPELINE_ENDPOINTS.LIST` | `usePipelines.list` | OK (tenant-scoped at service: `PipelineService.getAll` reads `this.tenantId`) |

That is the **entire** end-user surface. There is no per-id or per-slug end-user route, no per-user assignment, no "selection persistence" route.

### 3.3 Streaming endpoints

| Method | Path | DTO | SDK caller |
|---|---|---|---|
| POST | `/audio/transcription-jobs/stream/session` | `CreateStreamSessionRequest` (requires `pipelineId`) | `StreamingSessionManager` (UNUSED by main flow) |
| DELETE | `/audio/transcription-jobs/stream/session/:sessionId` | — | `StreamingSessionManager.closeSession` |
| WS | `/ws/stt-v2/stream?sessionId=…` | binary PCM Int16 LE or JSON `{type:'audio',seq,data}` | `SttV2WebSocketClient` (UNUSED by main flow); legacy `WebSocketClient` (`packages/stt/src/websocket/WebSocketClient.ts`) is what `STTProcessor` actually instantiates |
| POST | `/audio/transcription-jobs/transcribe` (multipart) | `TranscribeFileRequest` (requires `pipelineId`) | `useArca.transcribeFile` via `FileTranscriptionService` |
| GET (SSE) | `/audio/transcription-jobs/:id/stream` | — | `SSEClient` via `TranscriptionJobService` |
| GET | `/consultations/jobs/:jobId` (+ `/cancel`, `/stream`) | — | `ConsultationJobController` (TASK-263, ticket-auth on SSE) |

---

## 4. Strengths

1. **GAP-05 / R-04 resolved.** `AudioPipelineController.validateYaml` is now bound to path `'validate'` (`apps/api/src/modules/pipeline/audio-pipeline.controller.ts:98`) and matches `PIPELINE_ENDPOINTS.VALIDATE = '/admin/audio/pipelines/validate'` (`constants.ts:306`). A regression test pins this in `apps/api/src/modules/pipeline/__tests__/audio-pipeline.controller.test.ts:33`.

2. **`StreamingSessionManager.getWebSocketUrl(_token)` deliberately does NOT embed the JWT in the URL** (`packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts:134-157`). The comment explicitly cites HIPAA-sensitive leakage. This is the right design.

3. **SSE auth via single-use ticket** (`JwtAuthGuard.handleTicketAuth` + `StreamTicketService` + `@StreamScope` decorator at `apps/api/src/modules/auth/decorators/stream-scope.decorator.ts`) is well-implemented: namespace-scoped, one-shot, 30 s TTL. `ConsultationJobController.streamJob` (`apps/api/src/modules/consultation/consultation-job.controller.ts:60-71`) demonstrates correct usage.

4. **STT-V2 protocol is faithfully proxied.** `StreamingSessionService.createSession` (`packages/applications/src/services/stt/streaming/streamingSession.service.ts:66-121`) sends snake_case (`pipeline_id`, `tenant_id`, `audio_bucket_name`) to STT-V2 and tolerates camel/snake variants on the response.

5. **`SttV2WebSocketClient` reconnection is sound.** Exponential backoff + 50% jitter + `intentionalDisconnect` guard + `cancelReconnect()` (`packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts:360-415`). Fixes TASK-262 §13 linear-backoff and re-connect-after-disconnect bugs **for this client only**.

6. **Tenant-scoped admin queries.** `PipelineService.create`, `update`, `getBySlug`, `getAll`, `list` (`packages/applications/src/services/stt/pipeline/pipeline.service.ts:25-196`) all require `this.tenantId` and enforce isolation in the queries.

7. **YAML uniqueness per tenant.** `AsrPipelineRepository.isSlugUnique(tenantId, slug, excludeId?)` is called on create and update.

8. **Internal stt-callback API is API-key gated.** `SttInternalController.ensureInternalApiKey` (`apps/api/src/modules/internal/stt-internal.controller.ts:23`) is correct; the STT-V2 worker uses its issued API key to write transcripts back through `/internal/stt/transcripts`.

---

## 5. Defects

> File:line citations are followed by `[priority]` `[impact]` `[fix]`.

### 🔴 Critical

#### D-1 — STT WebSocket gateway has no authentication

`apps/api/src/modules/streaming/stt-ws.gateway.ts:29-50`

```typescript
handleConnection(client: WebSocket, req: IncomingMessage): void {
  const url = new URL(req.url || '', 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) {
    client.close(4001, 'Missing required query parameter: sessionId');
    return;
  }

  const session: SessionInfo = { sessionId, connectedAt: new Date(), binarySeq: 0 };
  this.sessions.set(client, session);
  // … begin streaming audio in/transcripts out
}
```

**Impact.** Any actor that knows or guesses a `sessionId` can connect to the WS, stream arbitrary PCM, and receive live transcripts. `sessionId` is a `uuidv7` (`apps/api/src/modules/streaming/transcription-job.controller.ts:247`) which is *time-ordered* — its high bits are predictable. Combined with the absence of a per-session capacity limit at the gateway layer, this is a session-hijack and PHI-exfiltration vector. The SDK doc in `StreamingSessionManager.getWebSocketUrl` (lines 134-138) claims callers "should send the token as the first WebSocket message after connecting" but `SttV2WebSocketClient.connect()` (`packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts:130-230`) **never sends any auth message** — the claim is unrealized.

**Patch (sketch).** Adopt the same ticket model used for SSE.

```typescript
// stt-ws.gateway.ts (sketch)
handleConnection(client: WebSocket, req: IncomingMessage): void {
  const url = new URL(req.url || '', 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');
  const ticket = url.searchParams.get('ticket');
  if (!sessionId || !ticket) {
    client.close(4001, 'Missing sessionId or ticket');
    return;
  }
  const stored = await this.streamTicketService.consumeTicket(ticket);
  if (!stored || stored.scope !== `stt_stream:${sessionId}`) {
    client.close(4401, 'Invalid or expired ticket');
    return;
  }
  // bind tenantId/userId from stored payload, verify session belongs to tenantId
  …
}
```

Mint the ticket from `createStreamSession` (return `{ sessionId, wsUrl, ticket }`) and have `StreamingSessionManager.getWebSocketUrl()` append `&ticket=…`.

---

#### D-2 — Cross-tenant `pipelineId` not validated at session bootstrap

`apps/api/src/modules/streaming/transcription-job.controller.ts:246-285`

```typescript
async createStreamSession(@Body() body: CreateStreamSessionRequest) {
  const sessionId = uuidv7();
  const tenantId = this.getTenantId();              // from JWT
  const user = this.cls.get('user');
  // …
  const sessionPayload = {
    sessionId, tenantId, pipelineId: body.pipelineId,
    consultationId: body.consultationId, sampleRate: body.sampleRate ?? 16000,
    language: body.language, userId: user?.id, audioBucketName,
  } as Parameters<StreamingSessionService['createSession']>[0];
  const result = await this.sessionService.createSession(sessionPayload);
  …
}
```

`body.pipelineId` is forwarded verbatim. There is **no `PipelineService.getById(body.pipelineId)` lookup** to confirm that the pipeline's `tenantId` matches `this.getTenantId()`. STT-V2 then `_load_pipeline_config(pipeline_id)` without a tenant check either (see D-3).

**Impact.** A doctor in Tenant-A can send `pipelineId = <Tenant-B's pipeline>` and the system will happily attach the foreign pipeline to a session bound to Tenant-A's `tenantId`. If Tenant-B has a more capable model (e.g., a paid LLM), this is theft of compute. If Tenant-B's pipeline references models scoped to Tenant-B's storage, the cross-tenant model load may fail in surprising ways — or worse, may succeed.

**Patch.**

```typescript
const pipeline = await this.pipelineService.getById(body.pipelineId);
if (!pipeline || pipeline.tenantId !== tenantId) {
  throw new ForbiddenException(`Pipeline ${body.pipelineId} is not available for this tenant`);
}
if (pipeline.resourceStatus !== 'ENABLED') {
  throw new BadRequestException(`Pipeline ${body.pipelineId} is not enabled`);
}
```

Mirror the same guard in `TranscriptionJobController.transcribeFile` (line 147-151) and any other call site that accepts a `pipelineId` from the doctor.

---

#### D-3 — STT-V2 `_load_pipeline_config(pipeline_id)` is not tenant-scoped

`apps/stt-v2/src/stt_v2/streaming/session_manager.py:636-656` and `apps/stt-v2/src/stt_v2/pipeline/config_reader.py:37-63`

```python
async def get_pipeline(self, pipeline_id: str) -> PipelineConfig:
    # … no tenant_id parameter, no filter
```

The sibling method `get_pipeline_by_slug(slug, tenant_id=None)` (L65-95) *does* support tenant filtering, but the by-id path that streaming uses does not. With D-2 in place, this is exploitable; even if D-2 is fixed, this is the second layer of defense-in-depth that the architecture mandates (see `/Users/taphuynh/.cursor/skills/methodology/defense-in-depth/SKILL.md`).

**Patch.** Add `tenant_id` parameter to `get_pipeline`, propagate from `session_manager.create_session(... tenant_id, pipeline_id)` → `_load_pipeline_config(pipeline_id, tenant_id)`, and reject with a 4xx-equivalent error when mismatched.

---

#### D-4 — Two parallel remote transports; the pipeline-aware one is dead code

| | Legacy v1 (in use) | stt-v2 (designed, unwired) |
|---|---|---|
| SDK client | `packages/stt/src/providers/BackendSTTProvider.ts` (`RemoteSTTProvider`) | `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` + `StreamingSessionManager.ts` |
| Session bootstrap | none (uses pre-issued `sessionId` + `sttSocket` URL) | `POST /audio/transcription-jobs/stream/session` with `pipelineId` |
| Knows about pipelineId | **NO** | **YES** |
| Wired into `STTProcessor` / `useArcaAudio` | YES (`STTProcessor.initializeRemoteProvider`, `packages/stt/src/core/STTProcessor.ts:520-556`) | NO (no `import` from `useArcaAudio` / `STTProcessor` / `PluginManager`) |

`RemoteSTTProvider.init(config: RemoteProviderConfig)` (`BackendSTTProvider.ts:68-121`) takes only `sttSocket`, `sessionId`, `language`, `sampleRate`, etc. — there is **no `pipelineId` field on `RemoteProviderConfig`** (cross-checked at `packages/stt/src/types/index.ts`, the file has no `pipelineId` member on that type). `STTProcessor.initializeRemoteProvider` (`STTProcessor.ts:530-543`) does not pass it either.

I verified by grepping the SDK for `StreamingSessionManager` consumers: matches occur only in `core.ts` barrel, `core/index.ts` barrel, and the two test files. **No production hook constructs it.**

`useArcaAudio.startAudio(options?: AudioStartOptions)` (`packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:53-205`) accepts `options.pipelineId`, logs it (line 66), and then **never uses it** — only `options.language` is propagated to the store. The plumbing into `PluginManager.getTranscriptionPipelineConfig().stt.pipelineId` (`PluginManager.ts:457`) flows into `TranscriptionPipelineConfig.stt.pipelineId`, but `TranscriptionPipeline` (`packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts`) never reads that field — verified with `grep "pipelineId" packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts → 0 matches`.

**Impact.** The actual code path a doctor exercises today (`useArca.startAudio()` → `STTProcessor` → `RemoteSTTProvider`) does NOT call the session-create endpoint, does NOT forward a `pipelineId`, and connects to the v1 WS at `sttSocket/sessionId`. The pipeline selection has **no effect on the running session**. The stt-v2-aware `StreamingSessionManager` ships in the bundle (~12 KB) for nothing.

**Patch.** Three plausible directions, in increasing surgery cost:

1. **Bridge** — extend `RemoteProviderConfig` with `pipelineId`, and add a pre-flight to `STTProcessor.initializeRemoteProvider` that calls `apiClient.post('/audio/transcription-jobs/stream/session', { pipelineId, consultationId, … })`, then sets `sttSocket` / `sessionId` from the response. Plus mint a stream ticket (per D-1).
2. **Replace** — retire `RemoteSTTProvider` in favor of a new `StreamingSttProvider` that internally owns a `StreamingSessionManager` + `SttV2WebSocketClient`. Cleaner end-state.
3. **Remove dead code** — if the org has decided the v1 WS *is* the keeper, delete `StreamingSessionManager` and `SttV2WebSocketClient`. This is the worst outcome but consistent with what is actually shipped.

Most likely (2) is the intended end state; the implementation is half-done.

---

#### D-5 — Doctor's pipeline selection has no persistence path

| Surface | Capability |
|---|---|
| `usePipelines.select(pipelineId)` (`hooks/usePipelines.ts:86-92`) | Local React `useState` only — lost on page reload. |
| `useUserSettings.updateByKey(namespace, key, value)` (`hooks/useUserSettings.ts:41-44`) | Only persists per-key arbitrary settings; there is no namespace convention for "selected pipeline." |
| `useArca.updatePreferences()` (via `PersonalizationManager`) → `PATCH /user/me/preferences` | `UserPreferences.remoteConfig` is documented at `packages/agentic-sdk-v2/src/types/config.ts:430-432` as "read-only, resolved from admin-assigned pipeline at read time." `UserPreferencesUpdate` (lines 441-447) explicitly omits `remoteConfig` so doctors can NOT update it. |

The business requirement "Selection persists in user settings" has no implementation path in the current SDK or API. There is no `PATCH /audio/pipelines/me/selection`, no `userPreferences.selectedPipelineId`, no `userSettings['audio']['pipelineId']` convention.

**Patch.** The cleanest fix is to add `selectedPipelineId?: string` to `UserPreferencesUpdate` (and to `UserPreferences`) with a server-side validator that `selectedPipelineId` resolves to a pipeline in the caller's tenant. Then `usePipelines.select(id)` calls `useArca.updatePreferences({ selectedPipelineId: id })`. The session-bootstrap flow then defaults `body.pipelineId` from the caller's persisted selection if the SDK didn't explicitly supply one.

---

### 🟠 High

#### D-6 — `validateConfig` body field mismatch

- SDK: `usePipelines.validateConfig(configYaml)` posts `{ configYaml }` (`hooks/usePipelines.ts:126`, test at `hooks/__tests__/usePipelines.test.ts:267`).
- Backend: `ValidateYamlRequest.yaml` is required with `@IsString() @IsNotEmpty()` (`apps/api/src/modules/pipeline/dto/validate-yaml.dto.ts:7-8`), and the controller dereferences `body.yaml` (`audio-pipeline.controller.ts:102`).

**Impact.** The `global ValidationPipe` (configured in `apps/api/src/main.ts`) has `whitelist: true` + `forbidNonWhitelisted: true`. The SDK request `{ configYaml: '…' }` will be rejected with HTTP 400 `"property configYaml should not exist"` and `"yaml must be a string"`. The "TASK-265 W0-9 / GAP-10" SDK test at `usePipelines.test.ts:271-283` only verifies the URL — it does not verify the body shape against the API DTO.

**Patch.**

```typescript
// hooks/usePipelines.ts L123-128
const validateConfig = useCallback(
  (yaml: string) =>
    execute<PipelineValidationResult>('validateConfig', (client) =>
      client.post<PipelineValidationResult>(PIPELINE_ENDPOINTS.VALIDATE, { yaml }),
    ),
  [execute],
);
```

Or change the DTO to accept `configYaml`. Either way, lock the contract with an integration test that exercises the actual NestJS pipe.

---

#### D-7 — `PIPELINE_ENDPOINTS.ASSIGN_TENANT` / `ASSIGN_USER` are orphaned (GAP-06 unresolved)

`packages/agentic-sdk-v2/src/core/constants.ts:308-310`:

```typescript
ASSIGN_TENANT: (pipelineId: string) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}/assign-tenant`,
ASSIGN_USER:   (pipelineId: string) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}/assign-user`,
```

`usePipelines.assignToTenant` (`hooks/usePipelines.ts:131-137`) POSTs to the first. **Neither route exists** in `AudioPipelineController`. Reading the controller end-to-end (`audio-pipeline.controller.ts:18-104`), the only mutator endpoints are `create`, `update`, `delete`, `validate`. This is GAP-06 from TASK-262 — still open.

This matters because the business requirement says "tenant admin pre-configures" pipelines and a global admin may need to assign one global pipeline to multiple tenants. Without the assign route, **the only way to make a pipeline available to a tenant today is for a `manage all` global admin to log in, switch to the tenant context, and re-create the pipeline against `this.tenantId`**.

**Patch.** Implement an `assign-tenant` route that copies the pipeline (or, if pipelines become tenant-shareable, attaches a join row). Until then, remove the SDK hook so consumers don't silently 404.

---

#### D-8 — Public `GET /audio/pipelines/:id` and `/slug/:slug` are admin-only

The SDK constants `PIPELINE_ENDPOINTS.GET` and `PIPELINE_ENDPOINTS.GET_BY_SLUG` (`constants.ts:296-298`) point to `/audio/pipelines/:id` and `/audio/pipelines/slug/:slug`. These paths fall under `AudioPipelinePublicController` (`Controller('audio/pipelines')`), but the public controller (`audio-pipeline-public.controller.ts:10-20`) implements **only `fetchAll()`** — there is NO `:id` or `slug/:slug` handler. The same-named routes do exist on `AudioPipelineController` at `/admin/audio/pipelines/:id` and `/admin/audio/pipelines/slug/:slug` (lines 50-68), but those are `@Authorize(['manage','all'])`.

Result: `usePipelines.get(id)` and `usePipelines.getBySlug(slug)` from a doctor account return **404 Not Found** (or in some configurations, NestJS may match the admin route's path inside a different controller and return 403 — depends on registration order; in either case, the call does not succeed).

**Patch.** Add `findById(id)` and `findBySlug(slug)` to `AudioPipelinePublicController`, each delegating to `pipelineService.getById(id)` / `getBySlug(slug)`, then *manually filter* by the caller's tenant inside `getById` (see D-9) to prevent cross-tenant leakage of pipeline metadata.

---

#### D-9 — `PipelineService.getById` is NOT tenant-scoped

`packages/applications/src/services/stt/pipeline/pipeline.service.ts:119-128`:

```typescript
async getById(id: string): Promise<PipelineResponse | null> {
  const pipeline = await this.pipelineRepository.findById(id);
  if (!pipeline) return null;
  this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: pipeline.id });
  return PipelineDtoMapper.toResponse(pipeline);
}
```

Compare with sibling methods that all check `this.tenantId` (`create:26`, `update:70`, `getBySlug:134`, `getAll:153`, `list:171`, `delete` indirectly via `existing.tenantId`).

`findById` on the repository (verified at `packages/domains/src/repositories/generated/core/AsrPipelineRepository.ts`) inherits the base class's plain `findById` with no tenant filter.

**Impact.** A `manage all` admin can fetch ANY tenant's pipeline by ID — including the YAML body (`configYaml` is in `PipelineResponse`). The `ResourceViewed` audit will record it but the data still leaves the security perimeter. Cross-tenant disclosure of `configYaml` may expose proprietary model selection, prompt templates, etc.

**Patch.**

```typescript
async getById(id: string): Promise<PipelineResponse | null> {
  const tenantId = this.tenantId;
  if (!tenantId) throw new BadRequestException('Tenant ID is required');
  const pipeline = await this.pipelineRepository.findById(id);
  if (!pipeline) return null;
  if (pipeline.tenantId !== tenantId) {
    throw new ForbiddenException('Pipeline does not belong to this tenant');
  }
  …
}
```

For the `manage all` super-admin case where cross-tenant browsing is intentional, add a separate `getByIdAcrossTenants(id)` reserved for `Role(SUPER_ADMIN)`.

---

#### D-10 — `@Authorize(['manage','all'])` on `AudioPipelineController` is too coarse for "tenant admin"

`apps/api/src/modules/pipeline/audio-pipeline.controller.ts:17`:

```typescript
@Authorize(['manage', 'all'])
export class AudioPipelineController {…}
```

CASL `can('manage', 'all')` is the *root* permission — only the global super-admin role carries it (verified in the policy seed conventions and `SUPER_ADMIN_ROLE = 'SUPER_ADMIN'` referenced in `smr-proxy.controller.ts:74`). A **tenant admin** does not satisfy this check, so per the business requirement "tenant admin pre-configured" the only path today is to elevate to global admin — which violates least-privilege.

**Patch.** Replace with `@Authorize(['manage', 'AsrPipeline'])` and grant `manage:AsrPipeline` to the tenant-admin role. The CASL policy must also constrain the action to records where `record.tenantId === user.tenantId` (use a CASL `conditions` block).

---

#### D-11 — YAML schema validation is shallow

`PipelineService.validateYaml` (`pipeline.service.ts:221-280`) parses the YAML and only verifies:

1. The root is an object.
2. A `models` key exists.
3. `models.asr` references a model via one of `{hf_model_id|model_id|slug|name|id}`.

There is NO check of:

- `preprocessing.vad` schema (the STT-V2 service reads `pipeline_config.preprocessing.vad.{enabled,threshold,min_speech_duration_ms,…}` at `session_manager.py:303-317`). A malformed VAD block will not be caught until session create — at which point a doctor sees a 500-class error mid-consultation.
- `preprocessing.denoise.{enabled,strength}` validity.
- `preprocessing.target_sample_rate` value range.
- `inference.language` ISO 639-1.
- Model references resolve to *enabled* AI-model rows in the tenant.

**Patch.** Hoist STT-V2's `PipelineSpec` Pydantic schema into a shared YAML schema (e.g. a JSON Schema published from the Python service), and use Ajv or Zod on the Node side to validate against it. Add a contract test that round-trips a known-good pipeline YAML through SDK → API → STT-V2 to detect drift.

---

#### D-12 — No audit logging or per-pipeline metrics for streaming WS sessions

`SttWsGateway.handleConnection/Disconnect/handleMessage` (`stt-ws.gateway.ts`) emit only structured `Logger.log/warn/error` lines. There is no:

- `broadcastSysEvent(SysEventType.SessionStarted, {pipelineId, sessionId, …})` (or equivalent) → no row in `audit_logs` for "doctor X opened streaming session with pipeline Y."
- Per-pipeline counter/histogram emission (latency from `audio_in_ts` to `transcript_out_ts`, error rate, dropped frames). The rest of the application uses NestJS-Prometheus via `apps/api/src/modules/observability` — none of those metrics are wired here.
- WS disconnect-reason audit (the gateway logs `code/reason` but nothing observable downstream).

**Impact.** SecOps cannot answer "which doctor used which pipeline last quarter" or "is pipeline X's WER getting worse over time."

**Patch.** In `handleConnection`, after the session is validated, emit a SysEvent and a Prometheus counter `stt_ws_session_started_total{pipelineId,tenantId}` and a histogram `stt_ws_session_duration_seconds`.

---

### 🟡 Medium

#### D-13 — Selected pipeline deletion is not communicated to live sessions

`AudioPipelineController.delete` (`audio-pipeline.controller.ts:91`) calls `PipelineService.delete` (`pipeline.service.ts:201-216`) which soft-deletes. There is no notification to running streaming sessions that referenced this pipeline (verified by grep: `pipeline.service.ts` emits `ResourceDeleted` but `StreamingSessionService` and `SttWsGateway` do not subscribe). Active sessions keep streaming because the pipeline config is loaded once at session-create. On reconnect (`SttV2WebSocketClient.attemptReconnect()`), the API would re-validate (if D-2 is fixed) and reject, but the user would only see "WebSocket reconnection failed — max attempts exhausted" without a remediation hint.

**Patch.** Add a `SysEvent` listener that pushes a `{type:'status', status:'pipeline_deleted', message:'…'}` to all affected sessions and instructs the client to surface a "pipeline was removed; pick another" UI.

#### D-14 — `AudioPipelinePublicController.fetchAll()` has no pagination

`audio-pipeline-public.controller.ts:13-19` returns `PipelineResponse[]` for the whole tenant. The SDK helpfully appends `?page=&limit=` (via `appendPagination`, `usePipelines.ts:71`) but the controller ignores them. With dozens of pipelines per tenant this is functional today; at scale (100s of tenant-shared pipelines under D-7) it is wasteful.

**Patch.** Add `@Query('page','limit')` and delegate to `PipelineService.list(page, limit)` which already returns `PaginatedPipelineResponse`. Mirror the admin shape.

#### D-15 — SDK backpressure is unbounded during WS `connecting`

`packages/stt/src/providers/BackendSTTProvider.ts:160-171` enqueues every incoming audio chunk into `audioQueue` regardless of WS state. `flushAudioQueue` (line 237-263) only drains when `isConnected()`. In the gap (e.g., slow handshake, mid-reconnect), audio piles up. For 5 s of `connecting` at 44.1 kHz × 4 bytes ≈ 880 KB — manageable but unbounded if the gap is longer.

`SttV2WebSocketClient.sendAudioFrame()` (`packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts:235-238`) goes straight to `ws.send(buffer)` with no check on `WebSocket.bufferedAmount`. A slow server (or a high-loss network) will inflate the browser's outgoing buffer without telling the caller.

**Patch.** Cap `audioQueue` size; drop oldest frames with a `stt-frame-dropped` event so the UI can show "buffering / poor connection." Guard `sendAudioFrame` with a check `if (this.ws!.bufferedAmount > HIGH_WATER_MARK) emit('backpressure', amount)` and either drop or apply application-level rate limiting.

#### D-16 — No transport-level compression (PCM only)

The WS protocol is unconditional Int16 LE mono @ 16 kHz (`stt-ws.gateway.ts:126` hard-codes `16000, 'pcm_s16le'`). A 60-minute consultation streams ~115 MB. There is no Opus negotiation, no FLAC, no even per-frame deflate.

**Patch.** Add a `Sec-WebSocket-Protocol` negotiation step where the client offers `opus` and the server falls back to `pcm`. STT-V2 already loads `pyrnnoise` for denoise — adding `opuslib` decode is straightforward. Saves ~10× bandwidth and lowers mobile data costs.

#### D-17 — Reconnect is lossy (no resumability token)

`SttV2WebSocketClient.attemptReconnect` (`SttV2WebSocketClient.ts:360-415`) just re-opens the URL with the original `sessionId`. There is no `?lastSeq=N` query param and no client-side replay buffer. Audio sent during the disconnect window is silently lost; the partial transcript visible to the user may be incorrect.

**Patch.** Buffer the last *N* seconds of frames in `SttV2WebSocketClient`. On reconnect, send the buffered frames in order before resuming live frames. The server can de-duplicate on `seq`. (TASK-262 §13 R-04 left this open.)

#### D-18 — Reconnect re-uses URL but, once D-1 is fixed, will need a fresh ticket

Stream tickets are single-use (`StreamTicketService` consumes atomically in Redis). When auth is added to the WS path (D-1), `attemptReconnect` will need to call `POST /auth/stream-ticket` to mint a fresh ticket before reopening the URL. Address this in the same patch.

---

### 🟢 Low

#### D-19 — `pipelineId` accepted as arbitrary string, never validated as UUID or slug

`CreateStreamSessionRequest.pipelineId` is just `@IsString() @IsNotEmpty()` (`transcription-job.dto.ts:40-43`). Same for `TranscribeFileRequest.pipelineId` (line 22-26). Adding `@Matches(/^[a-z0-9-]+$|^[0-9a-f]{8}-…$/i)` would catch typos earlier.

#### D-20 — Misleading `STTPluginConfig.pipelineId` / `AudioStartOptions.pipelineId`

Both are propagated from `useArcaAudio` through `PluginManager.getTranscriptionPipelineConfig().stt.pipelineId` (`PluginManager.ts:457`), into a `TranscriptionPipelineConfig` that never reads the field. Misleading API surface that hides D-4. Either delete the field or actually wire it (preferred — that *is* the wiring step that fixes D-4).

#### D-21 — `RemoteSTTProvider.transcribeSegment` throws — fine, but the error code is `Error`, not `STTError`

`BackendSTTProvider.ts:174-181`. Minor — but the rest of the SDK consistently uses `STTError(STTErrorCode.NOT_SUPPORTED, …)`. Inconsistent throws make catch-block error-discrimination harder for SDK consumers.

#### D-22 — `PIPELINE_ENDPOINTS` const has admin and public paths in the same object

Mixing `/admin/...` and `/audio/...` in one constant (lines 292-311) is confusing — a SDK caller writing role-based UI cannot easily distinguish which endpoints to gate behind admin role.

**Patch.** Split into `PIPELINE_ADMIN_ENDPOINTS` and `PIPELINE_PUBLIC_ENDPOINTS`. Low priority; cosmetic.

---

## 6. Security findings

| # | Finding | Severity |
|---|---|---|
| S-1 | WS gateway has no authentication; session-id-only access; sessionIds are time-ordered `uuidv7` (D-1) | 🔴 Critical |
| S-2 | Cross-tenant pipelineId not validated at API gateway or STT-V2 service (D-2, D-3) | 🔴 Critical |
| S-3 | `PipelineService.getById` leaks foreign-tenant pipelines via configYaml (D-9) | 🟠 High |
| S-4 | Tenant admin cannot self-serve — requires `manage all` super-admin (D-10) | 🟠 High |
| S-5 | YAML validation is shallow; malformed pipelines fail at runtime, not at admin-publish time (D-11) | 🟠 High |
| S-6 | No SysEvent audit trail for WS sessions; cannot reconstruct "who streamed via which pipeline" (D-12) | 🟡 Medium |
| S-7 | Reconnect path (when auth added) will need fresh ticket minting (D-18) | 🟢 Low |
| S-8 | Opus negotiation absent; PCM in cleartext on the wire (D-16) — mitigated by `wss://` requirement but verbose | 🟢 Low |

**Tenant-isolation summary.** Today an attacker with a doctor account in Tenant-A can (a) enumerate pipeline IDs (e.g., via leaked logs or `ResourceViewed` audit dumps), (b) call `POST /audio/transcription-jobs/stream/session` with Tenant-B's `pipelineId`, (c) connect to the WS with the returned `sessionId` (no auth required), and (d) stream audio that is transcribed using Tenant-B's pipeline configuration. Whether transcripts are stored against the attacker's tenant is configurable but the *compute* is stolen. Defense-in-depth at three layers (API gateway D-2, STT-V2 D-3, WS gateway D-1) is required to fully close this.

---

## 7. Performance findings

| # | Finding | Note |
|---|---|---|
| P-1 | No audio compression on WS — ~115 MB/hr/session | D-16 |
| P-2 | `SttV2WebSocketClient.sendAudioFrame` doesn't check `bufferedAmount` | D-15 |
| P-3 | `RemoteSTTProvider.audioQueue` is unbounded during `connecting` | D-15 |
| P-4 | `usePipelines.list()` returns ALL tenant pipelines (no pagination on public route) | D-14 |
| P-5 | Reconnect is lossy → user-perceived gap; partial transcripts can be wrong | D-17 |
| P-6 | Pipeline YAML is parsed on every `create`/`update`/`validate` call — fine for current scale | minor |
| P-7 | `validateYaml` runs both on dedicated `/validate` and inside `create/update` — duplicated parse cost | minor |

**End-to-end latency budget (estimated).** From `processAudio` → transcript event:

- Browser capture (4096 sample buffer @ 44.1 kHz via ScriptProcessorNode) ≈ 93 ms
- Resampling 44.1 → 16 kHz (linear interp) ≈ 1 ms
- Queue + 100 ms flush interval in `RemoteSTTProvider.SEND_INTERVAL_MS` ≈ 50 ms avg
- WS send + network round-trip (regional) ≈ 30-100 ms
- STT-V2 VAD + Whisper inference (depends on model) ≈ 200-2000 ms
- Result publish via Redis → bridge → ws.send ≈ 5-20 ms

The dominant variability is STT inference; the SDK adds ~150 ms of unnecessary buffering that could be reduced by event-driven flush (see TASK-262 §4 P-6).

---

## 8. Test coverage gaps

| Area | Existing | Missing |
|---|---|---|
| Admin pipeline CRUD HTTP route metadata | `audio-pipeline.controller.test.ts` (route paths only) | Service-layer tenant scoping (D-9), forbidden cross-tenant fetch, malformed YAML rejection (D-11) |
| Public pipeline endpoints | none | Permission check for doctor account, pagination behavior on `fetchAll` (D-14) |
| `usePipelines.validateConfig` body shape | unit test mocks the client | Real integration test catching the `configYaml` vs `yaml` mismatch (D-6) |
| `StreamingSessionManager` | unit test exists | Cross-tenant pipelineId rejection (D-2) |
| `SttV2WebSocketClient` | unit test exists | Auth message protocol (currently broken — D-1) |
| `SttWsGateway` | minimal test fixture present | No test exercising auth, no test for cross-tenant sessionId hijack, no test for reconnect resumption (D-17) |
| `useArcaAudio.start({pipelineId})` | none for pipelineId | Does not verify the pipelineId reaches the backend at all (D-4) |
| End-to-end SDK → API → STT-V2 contract | none | Round-trip pipeline YAML, round-trip session create, round-trip transcript |
| Pipeline deleted during active session | none | D-13 |

---

## 9. Conformance to the business requirement

### 9.1 Admin can CRUD pipelines — **PARTIAL ⚠**

| Evidence | Verdict |
|---|---|
| `AudioPipelineController.create/update/delete/validate` exist (`audio-pipeline.controller.ts:21-103`) | ✓ Routes present |
| `PipelineService` enforces `tenantId` on `create/update/getBySlug/getAll/list` (`pipeline.service.ts:26-196`) | ✓ Tenant-scoped writes |
| `PipelineService.getById` does NOT check tenant (`pipeline.service.ts:119`) (D-9) | ✗ Cross-tenant read |
| `@Authorize(['manage','all'])` requires global super-admin, not tenant admin (D-10) | ✗ Wrong role |
| `assign-tenant` route missing (D-7, GAP-06) | ✗ No cross-tenant assignment |

**Verdict.** A tenant admin **cannot** today perform this requirement without elevation to a super-admin role. The CRUD machinery is sound but the authorization layer denies the intended actor.

### 9.2 Doctor can list + select but NOT author — **PARTIAL ⚠**

| Evidence | Verdict |
|---|---|
| `usePipelines.list()` → `GET /audio/pipelines` works for doctors (`AudioPipelinePublicController.fetchAll`) | ✓ List |
| `usePipelines.get(id)` → 404 (D-8, no public-controller handler) | ✗ Get-by-id broken |
| `usePipelines.getBySlug(slug)` → 404 (D-8) | ✗ Get-by-slug broken |
| `usePipelines.select(id)` is local React state (`usePipelines.ts:86-92`) | ✓ "Select" is client-only — doctor cannot author |
| `usePipelines.createPipeline/update/delete` POST to `/admin/...` → 403 for doctors | ✓ Authoring correctly denied |

**Verdict.** Doctor can list pipelines and pick one in memory. Two read-by-id paths are broken. Authoring is properly forbidden.

### 9.3 Selection persists in user settings — **FAIL ✗**

| Evidence | Verdict |
|---|---|
| `usePipelines.select()` does NOT call any API | ✗ |
| `UserPreferences.remoteConfig.pipelineId` exists but is documented as "read-only, resolved from admin-assigned pipeline" (`types/config.ts:430-432`) | ✗ Read-only |
| `UserPreferencesUpdate` explicitly omits `remoteConfig` (lines 441-447) | ✗ No write path |
| `useUserSettings.updateByKey(namespace, key, value)` could in principle store an arbitrary value | ⚠ No SDK convention; no server-side validation that the chosen pipelineId belongs to caller's tenant |

**Verdict.** No implemented persistence path. The doctor's selection survives only within the running React app. Refresh → selection lost.

### 9.4 Live audio routes to the selected pipeline — **FAIL ✗**

| Evidence | Verdict |
|---|---|
| `useArca.startAudio({pipelineId})` accepts the option but never propagates it (`useArcaAudio.ts:53-205`, used only in logger attribute on line 66) | ✗ |
| `STTProcessor.initializeRemoteProvider` builds `RemoteProviderConfig` without a pipelineId field (`STTProcessor.ts:520-556`) | ✗ |
| `RemoteSTTProvider.init` has no pipelineId parameter (`BackendSTTProvider.ts:68-121`) | ✗ |
| The pipeline-id-aware `StreamingSessionManager` + `SttV2WebSocketClient` exist but no top-level hook constructs them | ✗ Dead code |
| STT-V2 `_load_pipeline_config` and the WS gateway *would* route correctly IF a pipelineId reached them, but it never does via the actual SDK path | — |

**Verdict.** Audio is streamed via a v1 WS that knows nothing about admin-configured pipelines. The most charitable reading is "this requirement is implemented in design but not in execution path."

---

## 10. Recommended fixes (prioritized)

### P0 (must fix before any tenant relies on this for PHI)

| # | Fix | Files | Linked defects |
|---|---|---|---|
| F-1 | Add stream-ticket auth to STT WS gateway | `apps/api/src/modules/streaming/stt-ws.gateway.ts`, `apps/api/src/modules/auth/stream-ticket.service.ts` (extend namespace), `apps/api/src/modules/streaming/transcription-job.controller.ts` (mint ticket on createStreamSession), `packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts` (append `&ticket=…`) | D-1 |
| F-2 | Validate `pipelineId` belongs to caller's tenant in `createStreamSession` and `transcribeFile` | `apps/api/src/modules/streaming/transcription-job.controller.ts` | D-2 |
| F-3 | Add `tenant_id` enforcement to `PipelineConfigReader.get_pipeline` | `apps/stt-v2/src/stt_v2/pipeline/config_reader.py`, `apps/stt-v2/src/stt_v2/streaming/session_manager.py` | D-3 |
| F-4 | Tenant-scope `PipelineService.getById` | `packages/applications/src/services/stt/pipeline/pipeline.service.ts` | D-9 |
| F-5 | Wire `pipelineId` through to a session-create call. Replace `RemoteSTTProvider` (or extend it) so live audio actually uses the chosen pipeline | `packages/stt/src/core/STTProcessor.ts`, `packages/stt/src/providers/BackendSTTProvider.ts`, `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts`, `packages/agentic-sdk-v2/src/core/PluginManager.ts` | D-4 (root cause of FAIL on 9.4) |
| F-6 | Add a persistence path for the doctor's selected pipeline. Extend `UserPreferencesUpdate` with `selectedPipelineId` and validate server-side | `packages/agentic-sdk-v2/src/types/config.ts`, `apps/api/src/modules/user/...preferences...`, `packages/agentic-sdk-v2/src/hooks/usePipelines.ts` (call updatePreferences inside `select`) | D-5 (root cause of FAIL on 9.3) |

### P1 (must fix before next release)

| # | Fix | Files | Linked defects |
|---|---|---|---|
| F-7 | Fix `validateConfig` body field (`configYaml` ↔ `yaml`) and add integration test | `packages/agentic-sdk-v2/src/hooks/usePipelines.ts` OR `apps/api/src/modules/pipeline/dto/validate-yaml.dto.ts` | D-6 |
| F-8 | Implement `POST /admin/audio/pipelines/:id/assign-tenant` (or remove SDK stub) | `apps/api/src/modules/pipeline/audio-pipeline.controller.ts`, `packages/applications/src/services/stt/pipeline/pipeline.service.ts` | D-7 |
| F-9 | Add `GET /audio/pipelines/:id` and `/audio/pipelines/slug/:slug` to public controller | `apps/api/src/modules/pipeline/audio-pipeline-public.controller.ts` | D-8 |
| F-10 | Change `@Authorize` on admin controller to `['manage','AsrPipeline']` with tenant condition | `apps/api/src/modules/pipeline/audio-pipeline.controller.ts`, CASL policy | D-10 |
| F-11 | Deep YAML schema validation (mirror STT-V2 PipelineSpec) | `packages/applications/src/services/stt/pipeline/pipeline.service.ts` (or share schema package) | D-11 |
| F-12 | SysEvent audit + Prometheus per-pipeline metrics for WS sessions | `apps/api/src/modules/streaming/stt-ws.gateway.ts` | D-12 |
| F-13 | Add pagination to `AudioPipelinePublicController.fetchAll` | `apps/api/src/modules/pipeline/audio-pipeline-public.controller.ts` | D-14 |

### P2 (polish / hardening)

| # | Fix | Files | Linked defects |
|---|---|---|---|
| F-14 | Pipeline-deleted-mid-session notification | `apps/api/src/modules/pipeline/...`, `apps/api/src/modules/streaming/...` | D-13 |
| F-15 | Bounded `audioQueue` + drop policy + `bufferedAmount` check | `packages/stt/src/providers/BackendSTTProvider.ts`, `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` | D-15 |
| F-16 | Opus negotiation on WS protocol | `apps/api/src/modules/streaming/stt-ws.gateway.ts`, `apps/stt-v2/src/stt_v2/streaming/...`, SDK clients | D-16 |
| F-17 | Frame replay buffer on reconnect | `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts`, gateway dedup | D-17 |
| F-18 | Mint fresh ticket on reconnect (when F-1 lands) | `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts`, `StreamingSessionManager` | D-18 |
| F-19 | Validate `pipelineId` shape | `apps/api/src/modules/streaming/dto/transcription-job.dto.ts` | D-19 |
| F-20 | Remove dead `pipelineId` field from `STTPluginConfig` / `AudioStartOptions` if F-5 takes the "delete legacy" branch | various | D-20 |

---

## 11. Scorecard

| Dimension | Score | Notes |
|---|---|---|
| Endpoint alignment | 6 / 10 | GAP-05 closed; GAP-06 still open; validate body shape mismatch; per-id/slug on public missing |
| Permission boundary | 3 / 10 | Doctor properly denied from authoring, but admin role grant too broad and `getById` leaks cross-tenant |
| Pipeline schema validation | 4 / 10 | Validate endpoint exists and is wired; depth is insufficient; integration tests missing |
| Selection persistence | 1 / 10 | No path exists; `UserPreferences.remoteConfig` is documented as read-only |
| Streaming session bootstrap | 3 / 10 | Bootstrap controller exists and forwards `pipelineId` to STT-V2; SDK does NOT call it on the live path |
| Backpressure / flow control | 3 / 10 | Old provider queues unbounded; new client lacks `bufferedAmount` check |
| Resume / reconnect | 4 / 10 | Reconnect logic with backoff exists; lossless resume does not (TASK-262 §13 open) |
| Auth on streaming channels | 4 / 10 | SSE is solid (ticket + scope); WS has zero auth — net average |
| Tenant isolation | 2 / 10 | Multiple layers (API gateway, STT-V2, repository) all skip the tenant check on the by-id path |
| Observability | 2 / 10 | Console-style logging only; no audit, no per-pipeline metrics |
| Failure modes | 3 / 10 | Pipeline deletion not propagated; STT-down not surfaced to user |
| Performance | 5 / 10 | Functional; uncompressed PCM; no SAB; minor over-buffering |
| **Overall** | **3.3 / 10** | Foundation is half-built; main flow does not actually exercise the admin-pipeline selection |

---

## Reviewer summary

The architecture of the remote-pipeline feature is *designed* correctly — there is an admin controller, a public controller, a session-bootstrap controller, a stream-ticket primitive for SSE, a `StreamingSessionManager` in the SDK that knows about `pipelineId`, a `SttV2WebSocketClient` with proper reconnect, and an STT-V2 service that consumes the `pipelineId` end-to-end. But the **execution path the doctor actually exercises bypasses all of it**: `useArca` → legacy `RemoteSTTProvider` → v1 WebSocket → unauthenticated `SttWsGateway`. The pipeline-aware client is dead code.

Combined with the absence of a persistence path for the doctor's selection (D-5) and three layers of missing tenant checks (D-2, D-3, D-9), the feature today behaves as: "the doctor sees a list of pipelines; their UI selection has no effect on the transcription; the live audio is sent unauthenticated over a WebSocket that any actor with the session-id can hijack."

The fixes are tractable and largely additive. F-1 through F-6 (P0) restore the integrity of the requirement and close the cross-tenant attack surface; F-7 through F-13 (P1) make the surface production-ready; F-14 through F-20 (P2) polish.
