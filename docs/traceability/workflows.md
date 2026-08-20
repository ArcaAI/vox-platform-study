# Traceability — End-to-End Business Workflows

The **workflow dimension** of the traceability rebuild. The per-domain
files ([`index.md`](./index.md)) answer *"where does capability X live?"*; this file answers
*"how do the capabilities compose into a business flow, and which invariants must hold along
the way?"* Each of the 11 flows below is an ordered step list — every step names the service,
the endpoint (relative to the global prefix `/api/v1` unless shown in full), the Prisma
model touched, and the test that covers it — followed by the **capability rows it composes**
(links into the domain files) and the **invariants** the flow must uphold.

Nothing here is a new claim: every endpoint, model, and test cited is verified in the linked
domain file.
`—` means verified-absent. Test shorthand is defined in [`index.md`](./index.md#test-location-shorthand).

## Cross-cutting invariants (asserted by every flow)

- **404-over-403 tenancy.** A cross-tenant read or write returns **404**, never 403 — the
  gateway's tenant-owned-resource interceptor + service-layer `assertEqualTenants` throw
  `NotFoundException`, hiding resource existence. Locked by `tests/cross-tenant/` + the
  `*-cross-tenant.spec.ts` suite. (Distinct from the imperative **403** privilege
  boundaries — SUPER_ADMIN-only writes — which are annotated `AUTH-NOTE` at the
  route; see rule 05.)
- **Optimistic concurrency (OCC / If-Match).** `_version` → strong `ETag` → client `If-Match`
  → `@RequiresIfMatch()` (missing header → **428**) + `@ExpectedVersion()` → `updateWithVersion`
  CAS (drift → **412**). **The "0"-create contract:** config-plane `PUT /row`
  surfaces a `version: 0` placeholder on a GET of a not-yet-materialized row; the client echoes
  `If-Match: "0"`; the service CAS **creates** if the row is absent and **412s** if a row at
  version ≥ 1 already exists. `"0"` is now an accepted strong validator (`(0|[1-9][0-9]*)`);
  a null result renders 404, never a 200 with an empty body. Evidence: `apps/api/src/decorators/expectedVersion.decorator.ts`
  (+ `__tests__/expectedVersion.decorator.test.ts`), e2e `optimistic-locking.spec.ts`,
  `ai-provider-connections.spec.ts`, `ai-runtime-profiles.spec.ts`, `settings-registry-write.spec.ts`.
- **PHI posture.** Clinical payloads (context items, highlights, transcript segments, summaries,
  DNA reports, audit rows) are envelope-encrypted at rest; golden-case reads surface
  PHI-safe metadata only; guardrail validation is **fail-closed** on the
  generation path; BYO provider keys are Vault-Transit ciphertext, write-only (no reveal route),
  and ciphertext never crosses the wire (asserted against raw response text in `ai-provider-connections.spec.ts`).

---

## W1 — Consultation lifecycle (open → record → document → close/chain)

The spine every clinical flow hangs off. A consultation is get-or-created, accrues clinical
context and recordings, is documented (W2/W4/W5), then closed — and may be reopened or chained
to a follow-up.

1. **Open (get-or-create).** `apps/api` → `POST /consultations/open` (get-or-create by patient; the only session entry point) → `Consultation` (`db_main/consultation.prisma`). unit(app): `consultation/consultation/__tests__/consultation.service.test.ts`.
2. **Add clinical context.** `POST /consultations/:id/context` (transcriptions / case notes) → `ContextItem`, `ContextItemVersion` (envelope-encrypted). unit(app): `context/__tests__/context.service.encryption.test.ts`.
3. **Record.** `POST /consultations/:id/recording/{start,stop}`, `POST /consultations/:id/recordings` → `AudioRecording`, `Media`; STT posts media back on `@Controller('internal/stt')` → `POST /internal/stt/{audio-records,media}`. unit(app): `consultation.service.recording.test.ts`.
4. **Read the running record.** `GET /consultations/:id/timeline` (`?scope=single|chain`), `GET /consultations/:id/highlights`, `GET /consultations/:id/named-entities` — composed reads over `ContextItem` / `AudioRecording` / `Highlight` / `SummaryMeta` / `NamedEntity`. unit(app): `timeline/__tests__/timeline.service.test.ts`.
5. **Close / reopen / chain.** `POST /consultations/:id/close`, `POST /consultations/:id/reopen`, `GET /consultations/:id/chain`, `GET /consultations/patient/:patientId/history`. e2e: `admin-fetchall-cross-tenant.spec.ts` (admin fetch-all cross-tenant); unit(api): `consultation/__tests__/consultation.controller.test.ts`.

**Composes:** [`consultation.md`](./consultation.md) C1 (lifecycle), C2 (context/versions), C3 (timeline), C4 (highlights), C5 (aggregate NER), C6 (recording/media).

**Invariants:** 404-over-403 on every `:id` (a cross-tenant consultation id is 404 — `admin-fetchall-cross-tenant`); OCC on `PATCH /consultations/:id`; context/highlight payloads envelope-encrypted at rest.

---

## W2 — Live transcription & live documentation (streaming → running SOAP note)

Real-time capture: browser audio bridges through the gateway WS into a Redis-Streams session
STT consumes; transcript segments feed a running SOAP note streamed back over SSE.

1. **Open a streaming session + ticket.** `POST /audio/transcription-jobs/stream/session` → `TranscriptionJob`, `AsrPipeline` (`db_main/stt.prisma`); refresh via `POST …/:sessionId/refresh-ticket`. unit(app): `stt/streaming/__tests__/streamingSession.service.test.ts`; e2e: `stt-session-cross-tenant.spec.ts`, `stream-ticket-scopes.spec.ts`.
2. **Stream audio (WS, single-use ticket — never a JWT in the URL).** WS `@WebSocketGateway({ path: '/ws/stt/stream' })` → gateway bridges to STT internal `POST /internal/streaming/sessions` (`APIRouter(prefix="/internal/streaming")`). unit(app): `streamingAudioBridge.service.test.ts`; py(stt): `unit/streaming/*`; e2e: `streaming-{resume-after-drop,backpressure-recovery,ticket-refresh}.spec.ts`.
3. **Persist transcript segments.** STT posts back on `@Controller('internal/stt')` → `POST /internal/stt/transcripts` → `TranscriptSegment` (`db_main/consultation.prisma`, transcription-owned). contract: `tests/contracts/stt-transcript-segments/`, `stt.contract.test.ts`.
4. **Stream the running SOAP note.** SSE `GET /consultations/:id/live-summary/stream` (`@Sse()`) → `ContextItem` `PRE_SUMMARY` snapshot tagged `metadata.subType = LIVE_SOAP_SNAPSHOT` (SMR-generated, NLP-entity-grounded). unit(app): `consultation/live-documentation/__tests__/{live-documentation.service,soap-parser,live-documentation.groundedness}.test.ts`.

**Composes:** [`transcription.md`](./transcription.md) R1 (live STT); [`consultation.md`](./consultation.md) C7 (live documentation), C2 (context).

**Invariants:** 404-over-403 on the session id (`stt-session-cross-tenant`, `transcription-job-cross-tenant`); stream tickets are single-use out-of-band (never a JWT in a WS/SSE URL — rule 13); no dedicated live-DB WS round-trip e2e (env-gated playground pass — [`transcription.md`](./transcription.md) gap).

---

## W3 — Batch transcription (upload → Dramatiq worker → callbacks)

Asynchronous file transcription: an upload creates a job the STT Dramatiq worker processes,
posting progress/results back on internal service-token callbacks.

1. **Create the job.** `@Controller('audio/transcription-jobs')` → `POST ''` / `POST /batch` / `POST /transcribe` → `TranscriptionJob`, `Media` (`db_main/{stt,media}.prisma`). unit(app): `stt/job/__tests__/transcriptionJob.service.test.ts`.
2. **Worker transcribes.** STT `POST /api/v1/transcribe` → Dramatiq `worker.py`. py(stt): `unit/test_batch_service.py`, `unit/test_broker.py`, `unit/test_job_concurrency.py`.
3. **Progress + result callbacks.** `@Controller('internal/stt')` → `PATCH /internal/stt/jobs/:id/{start,progress,complete,fail}`, `POST /internal/stt/transcripts`, `GET /internal/stt/jobs/:id/status`. unit(api): `internal` STT-callback tests.
4. **Client polls / streams / cancels / retries.** `GET /audio/transcription-jobs/:id`, SSE `GET …/:id/stream`, `POST …/:id/{cancel,retry}`; admin roll-up `@Controller('admin/audio/transcription-jobs')` → `GET /stats`, `GET /status/:status`. e2e: `transcription-job-cross-tenant.spec.ts`; py(stt): `integration/*`.

**Composes:** [`transcription.md`](./transcription.md) R2 (batch jobs).

**Invariants:** 404-over-403 on the job id (`transcription-job-cross-tenant`); transcript content envelope-encrypted (`transcriptionJob.service.encryption.test.ts`); job state in Redis/BullMQ (no OCC — job status is monotonic).

---

## W4 — Summarization (async / SSE) with in-band guardrail interception

Turning clinical context into documentation across tiers (pre / final / comprehensive), with
guardrail validation applied **inside** Text generation (a gateway hop it is not).

1. **Resolve the prompt.** `packages/applications/src/services/consultation/prompt` (`prompt-resolution.service.ts`, `prompt-assembly.service.ts`) selects the effective (approved) `PromptTemplate`/`PromptVersion`. unit(app): `summary.service.prompt-tier.task331`, `summary.service.preferred-prompt.task329`.
2. **Quota precheck.** `IEntitlementsService.assertQuantityQuota` → `QuotaExceededException` (HTTP 409), kill-switch-gated (rule 04) → `TenantEntitlement`, `TenantUsageMeter` (legacy row 6). unit(app): entitlements suite (legacy row 6).
3. **Generate (sync or async).** `POST /consultations/:id/summary[/async]`, `/pre-summary[/async]`, `/comprehensive[/async]` → BullMQ `Generate*` queues → Text `POST /api/v1/generate` → `SummaryMeta`, `ContextItem` (`RAW_SUMMARY`/`MODIFIED_SUMMARY`). unit(app): `consultation/summary/__tests__/{summary.service,chain-summary.service,text-generate}.test.ts`; contract: `text.contract.test.ts`; py(text).
4. **Guardrail gate (in-band, fail-closed).** Text `ExternalGuardrailClient` (`external_guardrail.py`) validates every prompt before the LLM call → guardrail `POST /api/v1/guardrail/analyze` (stateless); guardrail outage → retryable **503**, genuine violation → **block**. py(text): `unit/test_generate_guardrail_wiring.py`, `unit/test_external_guardrail_client.py`; py(grd).
5. **Stream progress / track the job.** SSE `GET /consultations/jobs/:jobId/stream`, `GET /consultations/jobs/:jobId`, `PATCH …/cancel`. e2e: `consultation-jobs.spec.ts`, `consultation-job-cross-tenant.spec.ts`.
6. **Read / edit / provenance.** `GET /consultations/:id/summary/latest`, `PATCH /consultations/:id/summary/:summaryId` (OCC), `GET …/:contextItemId/{versions,provenance,diff}`. unit(app): `summary.service.provenance.task330`, `summary.service.edit-capture`.

**Composes:** [`summarization.md`](./summarization.md) G1 (summarization), G2 (Text proxy), G3 (guardrail interception); [`consultation.md`](./consultation.md) C8 (async jobs).

**Invariants:** 404-over-403 on consultation/job ids (`consultation-job-cross-tenant`); OCC on `PATCH …/summary/:summaryId`; guardrail **fail-closed** (a wired-but-unreachable guardrail blocks generation rather than shipping an unmoderated PHI prompt); summary content envelope-encrypted.

---

## W5 — Harness documentation gating (guides → generate → sensors → gate → attest)

The durable, Temporal-orchestrated clinical-documentation harness layered over W4: a draft is
generated, scored by sensors, and held at a gate until a clinician approves or edits — the
attestation write.

1. **Start the workflow.** Gateway → harness `POST /api/v1/internal/consultations/:id/document:start` (service-token, `HarnessServiceTokenGuard`) → Temporal workflow (`harness-task-queue`, deterministic; side effects in idempotent activities). unit(app): `consultation/harness/__tests__/harness-gateway.service.test.ts`; py(hrn) incl. `test_replay_compat`.
2. **Assemble + retrieve context (RAG).** Harness `retrieve_context` activity over `KnowledgeDocument`/`KnowledgeChunk` (Qdrant + TEI reranker), ingested via internal `POST /api/v1/internal/knowledge/ingest` (BullMQ, no public REST). unit(app): `knowledge/__tests__/*`; e2e: `harness-institutional-rag.spec.ts`.
3. **Draft + sensor scoring.** Gateway internal `@Controller('internal/harness')` → `POST /consultations/:id/{assemble,draft,gate-decision}` → `SummaryMeta` (scores/gate), `HarnessPolicy` (effective gate policy). unit(app): `harness-internal.service.test.ts`.
4. **Stream progress / assurance / trajectory.** SSE on `ConsultationController`: `GET /consultations/:id/harness-progress/stream`, `…/harness-assurance/stream`, `…/trajectory/stream` (agentic loop). unit(api): `consultation.controller.{harness-progress,harness-assurance,trajectory}.test.ts`; e2e: `harness-progress-stream-cross-tenant.spec.ts`.
5. **Gate + attest.** Clinician approve/edit → workflow signal `POST /api/v1/internal/workflows/:id/signal/{approve,edit}`; attestation `POST /consultations/:id/summary/:contextItemId/approve` → `ContextItemVersion` (attestation), `HarnessAuditEvent`. e2e: `harness-gate.spec.ts`.

**Composes:** [`harness.md`](./harness.md) H1 (harness workflow), H4 (RAG); [`summarization.md`](./summarization.md) G1 (the draft it gates).

**Invariants:** 404-over-403 on the consultation id (`harness-progress-stream-cross-tenant`); gate is authoritative — an un-approved draft is not clinical documentation; harness FastAPI must boot even when Temporal is down (rule 06); workflow determinism + replay-compat (`test_replay_compat`); harness CI (`test-harness`) is hermetic — not live-infra evidence.

---

## W6 — Tenant provisioning & onboarding (tenant → users → entitlements → SSO → BYO)

Standing up a new tenant end to end: create the tenant, seed users/departments, grant
entitlements, wire SSO, and attach BYO credentials.

1. **Create + lifecycle the tenant.** `@Controller('admin/tenants')` CRUD, `POST /admin/tenants/:id/{suspend,archive,restore}`, `GET /admin/tenants/:id/usage` → `Tenant` (legacy row 4). e2e: `tenants.spec.ts`, `tenant-detail-contract.spec.ts`, `tenant-data-model-contract.spec.ts`.
2. **Seed users + departments + roles.** `@Controller('admin/users')` (+ `:id/roles`, `:id/departments`, `bulk-actions`), `@Controller('admin/departments')` → `User`, `UserProfile`, `Department`, `UserRoleAssignment` (legacy rows 3, 7). e2e: `users-management-contract.spec.ts`, `users-bulk-role-export.spec.ts`, `role-members-cross-tenant.spec.ts`.
3. **Grant entitlements + frontend config.** `@Controller('admin/entitlements')` (matrix / override / kill-switch / downgrade), `GET /entitlements/me` → `PlanEntitlement`, `TenantEntitlement`; `@Controller('admin/tenant-frontend-config')` + effective `GET /tenant/me/config` → `TenantFrontendConfig` (legacy rows 5, 6). e2e: `super-admin-backend-backlog.spec.ts` (partial), `admin-features-contract.spec.ts` (partial).
4. **Wire SSO (OIDC / SAML).** `@Controller('admin/tenant-idp-config')` → `POST ''` / `PUT :id`, `POST :id/test` (DRAFT→ENABLED), `PUT :id/directory-credentials` (Vault-encrypted BYO directory key), `POST :id/sync` (directory sync, BullMQ) → `TenantIdentityProvider`, `FederatedIdentity`, `TenantIdentityProviderDomain`. unit(app): `tenant-idp-config/__tests__/*`, `directory-sync/__tests__/*`.
5. **Attach BYO provider + TTS credentials.** `PUT /admin/ai-providers/:provider` (`AiProviderConnection`) and `PUT /admin/tts-config/credentials/:provider` (`TenantTtsProviderCredential`) — Vault-Transit, write-only. unit(app): `ai-provider-connection.service.test.ts`; e2e: `ai-provider-connections-cross-tenant.spec.ts`.

**Composes:** [`tenancy-provisioning.md`](./tenancy-provisioning.md) TP1–TP5 (tenancy, entitlements, users, departments); [`auth-identity.md`](./auth-identity.md) A3 (RBAC), I1 (IdP config); [`ai-models-providers.md`](./ai-models-providers.md) M6 (BYO); [`tts.md`](./tts.md) T3 (tenant-TTS BYO).

**Invariants:** 404-over-403 on every tenant-scoped `:id` (`role-members-cross-tenant`, `*-cross-tenant.spec.ts` suite); OCC on tenant/entitlement/IdP writes; SSO client secret + directory + BYO keys sealed with Vault Transit (plaintext never stored); **SAML assertion-security e2e is an OPEN gate** — I2's unit coverage is mocked, not real signed-assertion tamper/expiry/replay/XSW ([`auth-identity.md`](./auth-identity.md) gap).

---

## W7 — Model lifecycle (discovery → registry → task-defaults → retention)

The AI model plane end to end: discover a model on a provider host, register it, wire it to
tasks, resolve its runtime, and retire trajectory data on a retention schedule.

1. **Discover.** `@Controller('admin/ai-models')` → `GET /admin/ai-models/discovery` (probe upstream hosts via `HttpService`, URLs from `IConfigService`). unit(api): `ai-model/__tests__/ai-model-discovery.controller.test.ts`; e2e: `ai-model-discovery.spec.ts`.
2. **Register into the registry.** `POST /admin/ai-models/discovery/register`, `POST /admin/ai-models` → `AiModel` (`db_main/stt.prisma`); `PATCH /admin/ai-models/:id` (OCC). unit(api): `ai-model-admin.controller.test.ts`; unit(app): `stt/model/__tests__/aiModel.service.test.ts`.
3. **Wire per-task defaults.** `@Controller('admin/ai-task-defaults')` → `GET /options`, `GET ''` (resolved effective map), `PUT /row` (create/CAS under `If-Match`, incl. the "0"-create contract) → `AiTaskDefault` (`db_main/ai-task-default.prisma`). unit(app): `ai-task-default/__tests__/ai-task-default.service.test.ts`; e2e: `ai-task-defaults-cross-tenant.spec.ts`.
4. **Resolve runtime at inference.** `@Controller('admin/ai-runtime-profiles')` → `GET /resolve`, `PUT /row` → `AiRuntimeProfile`; consumed by `@Controller('ai')` → `POST /ai/{guardrail/analyze,nlp/entities,nlp/diagnosis}`. unit(api): `ai-inference/__tests__/ai-inference-runtime-profile.controller.test.ts`; e2e: `ai-inference-proxy.spec.ts`.
5. **Observe + retain.** `@Controller('admin/agent-trajectory')` → `GET /metrics/generation`, `GET /sessions[/:sessionId/steps]` → `AgentTrajectoryStep` (`db_main/agent-trajectory.prisma`); retention sweep in `agent-trajectory-retention` (unit-only). unit(app): `agent-trajectory-retention/__tests__/agent-trajectory-retention.service.test.ts`; e2e: `trajectory-admin.spec.ts` (probes the `/admin/agent-trajectory/*` read plane: RBAC, keyset step pagination, `payloadRef` never surfaced).

**Composes:** [`ai-models-providers.md`](./ai-models-providers.md) M1 (registry), M2 (discovery), M3 (task defaults), M4 (runtime profiles), M5 (inference gateway), M7 (trajectory + retention).

**Invariants:** the registry is a **SUPER_ADMIN plane** (guards pinned to `manage:all`); OCC on `PATCH ai-models/:id` and every `PUT /row` (incl. "0"-create — `ai-provider-connections.spec.ts`, `ai-runtime-profiles.spec.ts`, `settings-registry-write.spec.ts`); certain task-default prefixes are SUPER_ADMIN-only **imperatively** (`SUPER_ADMIN_ONLY_TASK_PREFIXES`, a 403, not the 404 posture — rule 05); exact-tenant scoping in the Prisma `tenant-scope` extension.

---

## W8 — BYO provider resolution (tenant override → Text / TTS injection)

Runtime resolution of a tenant's own cloud-provider credentials, injected into the otherwise
stateless generation and synthesis services.

1. **Store the BYO connection.** `PUT /admin/ai-providers/:provider` → `AiProviderConnection` (`db_main/ai-provider-connection.prisma`; `apiKey` write-only, Vault-Transit, no reveal route, OCC). unit(app): `ai-provider-connection/__tests__/ai-provider-connection.service.test.ts`.
2. **Resolve at generation time.** `resolveConnection` / `resolveTenantCloudOverrides` → `TextProxyController.applyTenantProviderOverrides` injects `provider_overrides` onto Text `POST /api/v1/generate`. unit(app): `ai-provider-connection.tenant-lane.test.ts`; unit(api): `streaming/__tests__/text-proxy-tenant-byo.controller.test.ts`; e2e: `ai-provider-connections-cross-tenant.spec.ts`.
3. **Tenant-TTS lane.** Gateway resolves the effective TTS spec (tenant row merged over SYSTEM default, clamped to platform limits) + decrypts the BYO TTS key at injection time → injected into stateless `apps/tts` per request → `TenantTtsConfig`, `TenantTtsProviderCredential` (deliberately **non-OCC**). unit(app): `tenant-tts-config/__tests__/{tenant-tts-config.service,platform-limits}.test.ts`.

**Composes:** [`ai-models-providers.md`](./ai-models-providers.md) M6 (BYO cloud connections); [`tts.md`](./tts.md) T3 (tenant-TTS BYO).

**Invariants:** 404-over-403 on cross-tenant provider reads (`ai-provider-connections-cross-tenant`); BYO keys are Vault-Transit ciphertext, decrypted only at injection, never returned and never on the wire; the Python services stay stateless (never touch Postgres).

---

## W9 — TTS synthesis (gateway proxy → stateless tts)

Text-to-speech from a browser: the gateway fronts the stateless synthesis service, resolving
the tenant's effective TTS spec per request.

1. **Request synthesis.** `@Controller('speech')` → `POST /speech/synthesize`, `GET /speech/voices`; WS `@WebSocketGateway({ path: '/ws/tts/stream' })` → WS `/ws/tts/stream`. unit(api): `speech/__tests__/{speech-proxy.controller,tts-ws.gateway}.test.ts`; e2e: `speech-proxy-auth.spec.ts`.
2. **Resolve effective spec + inject.** Gateway resolves `TenantTtsConfig` (tenant over SYSTEM default, clamped), decrypts `TenantTtsProviderCredential` (BYO), injects `X-Service-Token` + spec into tts. unit(app): `tenant-tts-config/__tests__/platform-limits.test.ts`.
3. **Synthesize.** `apps/tts` `POST /api/v1/audio/speech` (OpenAI-compatible), `GET /api/v1/voices`, WS `/api/v1/audio/stream` — Azure Speech + local Kokoro / Indic Parler / IndicF5 + Sarvam, en + ml. py(tts): `unit/test_speech_endpoint.py`, `unit/test_stream_ws.py`, provider suites (`test_{azure,kokoro,parler,indic_f5,sarvam}_provider.py`).

**Composes:** [`tts.md`](./tts.md) T2 (gateway proxy), T1 (synthesis service), T3 (per-tenant config).

**Invariants:** browsers never call `apps/tts` directly (gateway-only, `X-Service-Token`); the Python service is stateless (effective spec injected per request); BYO key ciphertext decrypted only at injection; **no TTS-config or live-synthesis e2e** — T1/T2 have unit + `speech-proxy-auth` coverage, live Azure/GPU/browser-WS round-trips are env-gated ([`tts.md`](./tts.md) gap).

---

## W10 — AuthN / AuthZ session flows (login → authorize → revoke)

Session issuance, per-request authorization, and the revocation + HIPAA auth-event
audit path.

1. **Authenticate.** `@Controller('auth')` → `POST /auth/login` (or federated `@Controller('auth/sso')` → OIDC `POST /start` + `GET /callback`, SAML `POST /saml/:tenantKey/{start,acs}`) → `User`, `FederatedIdentity`; refresh-token family + revocation state in Redis. e2e: `auth.spec.ts`, `auth-refresh.spec.ts`; unit(app): `federated-auth/__tests__/*`.
2. **Authorize every request (deny-by-default).** `UnifiedAuthGuard` (JWT / API key / OIDC) → `JwtStrategy` applies revocation posture; `@Authorize`/`@Can*` → PolicyEngine over `Role`/`Policy`/`RolePolicy`/`UserRoleAssignment`; runtime check `POST /rbac/check[/bulk]`. e2e: `auth-guard-behavior.spec.ts`, `rbac.spec.ts`, `authorization.spec.ts`.
3. **Stream ticket (out-of-band).** `POST /auth/stream-ticket` mints a single-use ticket for WS/SSE (never a JWT in the URL). e2e: `stream-ticket-scopes.spec.ts`.
4. **Impersonate (break-glass).** `POST /auth/impersonate`, `POST /admin/users/:id/impersonate`, `POST /auth/revoke-impersonation` — audited via `ImpersonationAuditInterceptor`. e2e: `user-impersonation.spec.ts`, `policy-break-glass.spec.ts`.
5. **Revoke + audit.** `POST /auth/logout` (access jti + refresh family) and user deactivate/suspend/soft-delete stamp Redis `jwt-revoked:<jti>` + per-user `auth:user-nbf:<userId>`; failed logins emit envelope-encrypted `UserAuthenticationFailed` rows → `AuditLog` (`db_main/audit.prisma`, no new model). unit(app): `auth/__tests__/{jwt-revocation.service,jwt.strategy}.test.ts`, `user/user/__tests__/user.service.task541.test.ts`; e2e: `auth-revocation-audit.spec.ts` (logout→replay 401; deactivate→live-token 401; failed login writes a queryable `success:false` row that never contains the attempted password).

**Composes:** [`auth-identity.md`](./auth-identity.md) A1 (sessions), A2 (API keys), A3 (RBAC), A5 (revocation + audit), I2 (federated SSO); [`platform-ops.md`](./platform-ops.md) PO1 (audit logging & sys-events).

**Invariants:** deny-by-default (`UnifiedAuthGuard` — every route carries `@Public()` or a permission decorator, enforced by the boot audit); revocation fails **OPEN** for ordinary tokens / **CLOSED** for impersonation on a Redis outage (owner decision A3); per-user not-before TTL 24 h, deny-on-tie `iat <= notBefore`; failed-auth audit rows never contain the attempted password; 404-over-403 on cross-tenant admin-user reads (`tenant-access-control.spec.ts`). A5 is **uncommitted on `fix/2605-review`** (status Review).

---

## W11 — Admin governance flows (prompt approval · policy cascade · kill switch)

The three release-governance write paths, each an authoritative-editor surface with an
imperative privilege gate above the declarative decorator.

1. **Prompt approval (clinical gate).** `POST /admin/prompt-templates/:id/approve` → flips `PromptTemplate.status = APPROVED`, pins a `PromptVersion`, writes a WORM change row (`@RequiresIfMatch()`). **SUPER_ADMIN-only imperatively** (`isSuperAdmin` in the service — the class decorator understates it; `AUTH-NOTE`). This is the gate `prompt-resolution` (W4 step 1) requires. unit(app): `prompt-management/__tests__/prompt-management.service.test.ts`; e2e: `agent-management-contract.spec.ts`, `agents-backend-backlog.spec.ts`.
2. **Policy cascade (realtime pipeline policy).** `@Controller('admin/harness/pipeline-policy')` → `GET /row`, `PUT /row` (create/CAS under `If-Match`, "0"-create) → `PipelinePolicy`, `PipelinePolicyChange`. **`globalOnly` descriptor lock enforced imperatively** (`AUTH-NOTE`). unit(app): `pipeline-policy/__tests__/pipeline-policy.service.test.ts`; e2e: `backend-residuals.spec.ts` (partial).
3. **Global harness policy default.** `GET/PATCH /admin/harness/policy/global` (SYSTEM-tenant GLOBAL-DEFAULT `HarnessPolicy`; `@RequiresIfMatch()` even on first edit — 428/412) — the single authoritative editor (`/agentic-policy` owns it; `/harness/policy` links). **SUPER_ADMIN-only** via `SUPER_ADMIN_ONLY_POLICY_KEYS`. unit(app): `harness-policy/__tests__/*`; e2e: `agentic-policy.spec.ts`.
4. **Engine kill switch.** `GET/PATCH /admin/harness/live/config` — `enabled:false` engages the kill-switch (new `start()` calls refused while in-flight sessions drain; NOT versioned). Reading/toggling raises `ForbiddenException` without platform (super-admin) privilege. unit(app): `agentic-instructions/__tests__/agentic-instructions.service.test.ts`; e2e: `agentic-policy.spec.ts`.
5. **MCP tool registry writes.** `@Controller('admin/mcp-servers')` CRUD → `McpServer` — writes stay **SUPER_ADMIN-only** in the service (`AUTH-NOTE`). e2e: `mcp-admin.spec.ts`.

**Composes:** [`summarization.md`](./summarization.md) G5 (prompt governance); [`harness.md`](./harness.md) H3 (pipeline-policy cascade), H6 (agentic-policy engine + kill switch), H7 (MCP registry).

**Invariants:** these are **403 privilege boundaries** (imperative `isSuperAdmin` / `SUPER_ADMIN_ONLY_*` / `globalOnly` locks), NOT the 404-over-403 cross-tenant posture — a cross-tenant id is still **404** via `assertOwnedByTenant` (rule 05); OCC / "0"-create on every versioned `PUT /row` and `PATCH /policy/global`; approval + policy changes write WORM change rows (`HarnessPolicyChange`, `PipelinePolicyChange`, pinned `PromptVersion`); one authoritative editor per resource (rule 13).

---

## W12 — Agentic workflow substrate: author → validate → publish → invoke → result (Summarization palette)

The first palette proving the agentic-workflow-platform substrate (wave
1/2 of [`design.md`](../programs/agentic-workflow-platform/design.md)). **Partial** — see
the gaps below; a REAL clinical-summarization result is not producible end-to-end yet, but the
authoring→publish→invoke→status→cancel *mechanism* now is.

1. **Definition model + domain quartet.** `WorkflowDefinition` (the Prisma model plus the hand-authored
   `Entity`/`Factory`/`EntityMapper`/`Repository`, incl.
   `findPublishedBySlug`/`findActivePublishedByTenant`) — rows ARE versions (no head/version
   split); `graph` (authored canvas, `packages/database/src/prisma/db_main/workflow-definition.prisma`).
   A `BEFORE UPDATE OR DELETE` trigger + a partial unique index enforce PUBLISHED-row
   immutability and the "at most one ACTIVE version per slug" invariant at the DB layer
   (`migrations/20260817000100_task_734_workflow_definition_immutability_guard/`).
2. **Validate + compile (pure engine).** `packages/workflow-contract` —
   `validate()` (structural/invariant/schema rule classes over `DRAFT_SUMMARIZATION_RULE_SET`,
   itself DRAFT/not clinician-reviewed) and `compile()` (deterministic graph →
   `compiledConfig`, the interpreter's input contract), wired into `WorkflowDefinitionService`:
   `compile()` is the always-blocking ENGINE gate on create/update/publish;
   `validate()`'s DRAFT rule findings are recorded but never block a write (decision #3). **The
   Summarization palette's own mandatory-subgraph rules** (`input.context_binding →
   generate.text → guardrail.check → output.deliver`, guardrail non-removable) are
   `WF-SUMM-001..006`, golden fixtures at
   `packages/workflow-contract/src/__tests__/golden/WF-SUMM-*/`. Node config schemas:
   `docs/implementation/TASK-720-Palette-Summarization/contracts/nodes/*.schema.json` +
   `contracts/palette.md` (safety class / `critical` / activity-name table) — no delivered
   `configSchema` contract exists on the node-registry response yet.
3. **Node registry.** `@arcaai/workflow-contract`'s `WORKFLOW_NODE_REGISTRY`
   (`packages/workflow-contract/src/node-registry.ts`) is the code-owned TS mirror of
   `apps/harness/.../interpreter/registry.py`'s `NODE_REGISTRY`, parity-guarded by a shared
   fixture (`docs/implementation/TASK-734-Workflow-Substrate-Second-Pass/contracts/node-registry.snapshot.json`). Carries
   seven entries: the `noop`/`passthrough` seed pair plus the five Summarization palette node
   types (`interpreter.context_binding` / `interpreter.template_ref` / `interpreter.text_generate`
   / `interpreter.guardrail_check` / `interpreter.deliver`), populated on both sides + the shared
   fixture by the palette's second pass (2026-08-16) — see the gaps below for what remains before a
   real invoke produces a retrievable clinical output.
4. **Interpreter.** `WorkflowInterpreter` Temporal workflow
   (`apps/harness/src/harness/temporal/interpreter/`) — stage-walk dispatch off
   `compiledConfig`, registry-sanctioned activities only (S-4: the wire `activity` string is a
   consistency check, never a routing decision). A new HTTP dispatcher
   (`apps/harness/src/harness/api/endpoints/interpreter.py`) exposes `POST
   /api/v1/workflow-runs:start` (idempotent by workflow-id collision), `GET
   /api/v1/workflow-runs/{runId}` (Temporal `describe()` + the workflow's `state` query), `POST
   /api/v1/workflow-runs/{runId}:cancel` (a code allow-list — never a caller-supplied signal
   name) — `X-Service-Token`-guarded, called only from the gateway (never a browser).
5. **Exposure plane — invoke/status/stream/cancel/list.** `GET /api/v1/workflows`,
   `POST /api/v1/workflows/:slug/invoke`, `GET /api/v1/workflows/:slug/runs/:runId[/stream]`,
   `POST /api/v1/workflows/:slug/runs/:runId/cancel` (`apps/api/src/modules/workflows/`), gated
   OFF by default (`WORKFLOW_EXPOSURE_ENABLED`, R-1) and scoped by both a CASL authorization
   decorator and `@RequiredScopes('workflow:{definition:read,run:read,run:write}')` on every
   route (boot-audited, `api-key-scope-audit.ts`). `invoke()` resolves the tenant's
   ACTIVE PUBLISHED version (`findPublishedBySlug`, 404-over-403), mints a content-addressed
   `ClaimCheckRef` for `compiledConfig` into the self-hosted MinIO claim-check bucket (the
   interpreter never accepts a raw compiled config — the interpreter's own dispatcher contract), and
   POSTs to the harness dispatcher's `:start` route. The SSE stream is a documented, disclosed
   BRIDGE, not a byte-proxy: no live event-stream producer exists on the interpreter yet
   (deferred), so `WorkflowStreamService` polls the JSON status read and
   translates each snapshot into an async-contract envelope; no synthetic resume token
   is minted (Temporal polling has no transport-native cursor — async-contract §3.6 forbids
   inventing one). Decision #6 (cloud-provider selection through a public workflow, R-8): OFF by
   default (`WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS`), checked against `compiledConfig`'s
   per-node `config.provider` field via the SAME `isCloudByoProvider('llm', …)` classification
   the BYO-credential plane uses — currently inert (no node type sets `config.provider` yet)
   but wired for the moment one does.
6. **Seeded platform default.** One SYSTEM-tenant, `PUBLISHED`, `isActive` `WorkflowDefinition`
   row (`packages/database/src/prisma/db_main/seed/21-workflow-definition.ts`)
   — the dispatcher's fallback when a tenant has authored no workflow of its own. `graph` /
   `compiledConfig` are the literal, provable output of the real `compile()`/`validate()` engine.
7. **Async envelope + Studio.** The async contract is delivered through Phases A+B; Workflow
   Studio v1 (`apps/admin-console`) is separate in-flight work.

**Composes:** [`harness.md`](./harness.md) (Temporal workflow patterns); no domain file yet
owns this substrate as a first-class capability (candidate for a future `agentic-workflow.md`
once wave 2+ lands).

**Invariants (intended, not all enforced yet):** the guardrail node is structurally
non-removable and nothing routes around it (`WF-SUMM-004`/`006`); `compiledConfig` is
server-produced only, never accepted from a request DTO; a published row is hard-immutable
(service guard + DTO whitelist + checksum drift-detection + a DB trigger); a
publicly-invoked workflow never routes to a cloud LLM provider without an explicit tenant
opt-in (exposure-plane decision #6); provider/model selection for `generate.text` is `failMode:
closed` (no env fallback).

---

## Honest notes / gaps (workflow-level)

- **No e2e proves W4's full guardrail-interception chain end to end.** The fail-closed behavior is covered at py(text) unit level (`test_generate_guardrail_wiring.py`); there is no live-DB Playwright spec asserting a blocked generation from a browser call.
- **W2's browser-WS live round-trip and W9's live synthesis are env-gated**, not `apps/api/tests/e2e` specs (playground manual passes) — see the transcription and TTS domain gaps.
- **W6's SAML leg is an open security gate** — real signed-assertion tamper/expiry/replay/XSW coverage does not exist (I2 unit tests use a mocked SAML client). Do not read W6 step 4 as assertion-hardening evidence.
- **W10 step 5 (revocation/audit) is uncommitted** on `fix/2605-review` (status Review) — landed-but-unmerged.
- **W12's five Summarization node activities are now implemented** (palette second pass,
  2026-08-16): `interpreter.context_binding` / `interpreter.template_ref` /
  `interpreter.text_generate` / `interpreter.guardrail_check` / `interpreter.deliver` all exist,
  are registered on both `NODE_REGISTRY` (Python) and `WORKFLOW_NODE_REGISTRY` (TS, cross-language
  parity-tested), and are unit-proven (20 cases, incl. the fail-closed guardrail assertion). The
  two blockers this bullet previously named were closed, not routed around: `workflow.py` now
  threads a `bound_inputs` dict (from the compiler's own `NODE.inputs` edges) between nodes, and
  `generate.text` reuses the harness's own already-shipped `ApiClient.get_policy` +
  `SmrClient.generate` pattern (never the gateway). **W12 STILL cannot produce a real clinical result
  end-to-end**, for reasons now narrower and specifically named:
  1. `WorkflowExposureService.invoke()` accepts `InvokeWorkflowRequest.input` but does
     NOT forward it to `HarnessGatewayService.startWorkflowRun(...)` — so `input.context_binding`
     always sees an empty `run_payload` on a real invoke today, and (its kind is `required: true`
     in the seeded definition) DEGRADES → the run's `input.context_binding` node fails. This is the
     exposure plane's (step 5) gap, not the palette definition's (steps 1–3).
  2. `output.deliver`'s claim-check write has no consumer: no `WorkflowRun` column or callback
     records a `resultRef` for a run-status caller to read back, so a run's actual output is
     unrecoverable by an invoker even when the graph runs cleanly. Real external write, no
     retrieval path — the runs-observability plane's gap to close.
  3. `guardrail.check`'s `onFail: 'abort'` is accepted/recorded but cannot promote a run to
     `FAILED` (that requires the code-owned `critical` registry flag, which this node carries as
     `False` per its safety classification) — a genuine v1 architectural ceiling, not a bug.
  A live Temporal/harness round trip (item below) remains separately unverified regardless.
- **W12's exposure plane was NOT proven against a live Temporal/harness round trip.**
  `apps/harness` and its Temporal worker are not part of `pnpm test:up:api`'s server set and
  were not started this session; `apps/api/tests/e2e/task-722-workflow-exposure.spec.ts` proves
  every gateway-side gate (scoping, tenant isolation, 404-over-403, DTO validation, the
  stream-ticket mint-time ownership check) live against the test DB, and proves a published,
  in-scope, own-tenant invoke passes every one of those gates before failing on the one boundary
  this environment cannot host (the unreachable harness dispatcher) — see that spec's own header
  comment. A genuine `202 → RUNNING → COMPLETED` round trip is unverified pending a running
  harness + Temporal worker (R-2 already names Temporal as not production-ready for the same
  reason).
- **The "0"-create contract is proven mostly at the unit/decorator layer plus the `ai-provider-connections.spec.ts` / `ai-runtime-profiles.spec.ts` / `settings-registry-write.spec.ts` 428/412 legs.** The create-from-absent (`If-Match: "0"` → new row) path is asserted in the service unit suites (`settings-registry-write.occ`, `ai-provider-connection.service`, `harness-policy.service`), not yet in a dedicated e2e create leg.
- W6 (tenancy/entitlements) and W10 (audit) now resolve to [`tenancy-provisioning.md`](./tenancy-provisioning.md) and [`platform-ops.md`](./platform-ops.md) respectively; their step-level claims were carried over from the retired matrix and have not been re-verified against those files line by line.
- **[`ai-models-providers.md`](./ai-models-providers.md) M7's `e2e: —` is stale.** `apps/api/tests/e2e/trajectory-admin.spec.ts` exists and probes the M7 `/admin/agent-trajectory/*` read plane (RBAC + keyset step pagination + `payloadRef`-never-surfaced); code wins over the domain file's cell. W7 step 5 cites it; M7's e2e cell should be corrected on that file's next re-stamp.

Last verified: 2026-07-22
</content>
</invoke>
