# TASK-1004 — One language selection, applied everywhere (live + batch, every provider) · compat surface removal

| Field | Value |
|---|---|
| Status | **In Progress** — all lanes merged on `dev-2.2` (local), ALaaS `refactor-hope-integaration` (local) and deployment `main` (local); single gate pass green apart from pre-existing failures (§9.2); awaiting push + deploy + live verification (§8.3) |
| Type | feature + bugfix + refactor (removal) |
| Branch | `dev-2.2` (hope-v2) · `main` (hope-v2-deployment) · `refactor-hope-integaration` (ALaaSv3.0) |
| Surfaces | `apps/api`, `packages/applications`, `packages/database`, `packages/domains`, `apps/stt`, `packages/agentic-sdk-v2`, `packages/vox-node`, `apps/admin-console` (docs sample + agent-assignment warning), ALaaS `apps/web_ui` + `apps/audio-stream-svc`, deployment repo |
| Opened | 2026-09-24 |
| Rules read | `00`, `01`, `02`, `03`, `04`, `05`, `06`, `08`, `09`, `13`, `14`, `_karpathy` |

## 1. Requirement (owner, 2026-09-24)

> "ALaaS (as tenant client/customer client) will allow the end-user to select language; we need it to be captured and sent through the HOPE workflow and agent, for live/batch transcription only (no matter what model and provider), so we need to ensure seamless language/code-switch configuration through providers and models."
> "For ALaaS let's not focus on the Azure batch upload; however we need to ensure language will be passed properly in our HOPE agents/workflows sockets/endpoints. ALaaS needs to capture the selected language and pass it through HOPE for live transcription."
> "We don't use compat endpoints and, more so, start deprecation and deletion."
> "For the rest, we need best practices for best performance."

Standing owner rules that bound the design:

- **OD-6 (TASK-1003):** language never routes the engine. The ASR agent and its admin-configured fallback chain decide the engine; language only configures decoding.
- **Notes are English-only.** The spoken language is not the note language (TASK-1001 OD-12, memory "English-only notes").

## 2. Current state (evidence, 2026-09-24)

### 2.1 What already works — keep it

| Behaviour | Evidence |
|---|---|
| The live path carries the end-user mode end to end: `audio.start({languageMode})` / vox-node → `POST audio/transcription-jobs/stream/session` (`languageMode` wins over `language`) → `StreamingSessionService.createSession` → STT `language_mode` | `transcription-job.dto.ts:165-177`, `transcription-job.controller.ts:1092-1093`, `streamingSession.service.ts:332-335` |
| **Live proof:** both tester sessions on 2026-09-24 (whisper `01a0d26e…`, Sarvam `01a0d2a1…`) persisted `language_mode = ml-en` in Redis `stt:session:*` | `redis-cli HGETALL`, 2026-09-24 |
| STT precedence: explicit `language_mode` > a declared `language` promoted to a catalog mode > the agent's `decoding.language_mode` (the TASK-938 fix: the agent default no longer clobbers the caller) | `apps/stt/.../session_manager.py:400-428, ~1580-1651` |
| Per-engine translation at load (`resolve_mode_for_engine`); re-translation on every fallback engine switch; the effective mode is persisted for worker-restart recovery | `language_modes.py:470-537`, `session_manager.py:2257-2358, 3052-3067` |
| Agent/engine resolution is language-blind (OD-6 holds) | `asr-agent-resolver.service.ts:18-30` |
| A catalog endpoint lists modes with `supportedEngines` | `GET audio/transcription-jobs/language-modes` → `language_mode_catalog_payload()` |

### 2.2 Gaps

| # | Gap | Evidence |
|---|---|---|
| G-1 | **Batch cannot carry the selection.** `TranscribeFileRequest` and `AgentTranscriptionBody` (a TS `interface`, not a validated DTO) accept only `language`. The gateway always sends the Dramatiq positional `code_switching = null`, and the worker never applies it | `transcription-job.dto.ts:98-101`, `agent.controller.ts:92-96`, `transcriptionRealtime.service.ts:343-382`, `transcribe_file.py:44-58,132-223` |
| G-2 | **Batch resolves language per-engine-unaware** (`_language_from_mode`). Sarvam codemix, the Azure auto-detect flag and the Whisper gloss never apply to batch; there is no capability check | `apps/stt/src/stt/pipeline/spec.py:741-762` |
| G-3 | **The consultation's language is not inherited.** `consultations.open({language})` stores the spoken language in `Consultation.metadata.summaryLanguage` (a misleading name). Nothing seeds the STT session or batch job from it, so every client must declare the language twice | `summary-language.ts:60-123`, `transcription-job.controller.ts:975-1093` |
| G-4 | **Silent degrade.** On whisper.cpp a code-switch pair resolves to `language=None`, and with the priming prompt disabled (TASK-985 OD-B) the engine gets **no language signal**. It re-runs language detection per window, which produced Run 1's "English in Malayalam script". The catalog still reports the engine as supporting the pair | `language_modes.py:96-111, 255-280, 479-496`; memory TASK-938 |
| G-5 | **No resolution receipt.** Nothing tells the client or admin which engine served the session and what language parameters it actually applied | session-create response, STT `status` frames |
| G-6 | **Workflow ASR nodes carry an agent reference only** (correct under OD-6), but a consultation-bound batch STT invoked by a workflow or agent does not inherit the consultation's mode (follows from G-1/G-3) | `governing-workflow-asr.ts:200-216` |
| G-7 | **Stale SDK doc:** `OpenSessionInput.language` still documents the pre-TASK-1001 meaning ("the note language") | `packages/agentic-sdk-v2/src/types/consultation.ts:162-177` |
| G-8 | **ALaaS live:** one dropdown value (a mode id, e.g. `ml-en`) is sent as both `language` and `summaryLanguage`. `noteLanguageFor` can forward `ml-en` to `consultations.open` as a "note language"; a repeat `start` keeps the stale language; the broker routes by language via `HOPE_STT_AGENT_SLUG_BY_MODE`, which **contradicts OD-6**; nothing shows the engine or effective mode | `useClinicalLogic.js:1790,1797`, `protocol.ts:599-629`, `consultation-broker.service.ts:362-376`, `stt-lane.ts:829-832`, `consultation.module.ts:62-101` |
| G-9 | **Compat surface:** the v1 compat routes have no `languageMode`, duplicate the native plane, and received **zero requests in the last 10 days** (Loki, gateway access log; the same filter shows 460 native consultation requests per day) | §2.3 |

### 2.3 Compat surface inventory (deletion scope)

| Surface | Where | Consumers |
|---|---|---|
| `POST /api/stt/start_session`, `/switch`, `/stop_session`, `WS /stt` | `apps/api/src/modules/stt-compat/**`; prefix exclusions `apps/api/src/global-prefix.config.ts:23-30`; module registration `app.module.ts:121-123,550-552` | none (0 requests in 10 days) |
| `POST /api/smr/api/v1/presummary`, `/summary/sync` | `apps/api/src/modules/text-compat/**` (all files local to the module) | none: ALaaS migrated to the agent/workflow plane (its code comments record the replacement); 0 requests in 10 days |
| Scope `stt:stream:write` / `svc:stt:stream:write` (compat STT only) | `service-account-scopes.registry.ts:118`, `apikey-scopes.registry.ts:97-101`, seed `94-service-account.ts:193` | compat only (`consultation:report:write` is shared and stays) |
| `@arcaai/vox/compat` | `packages/agentic-sdk-v2/src/compat/**`, `src/compat.ts`, `package.json#exports["./compat"]`, `tsup.config.ts:157-168`; core escape hatches `StreamingSessionManager.ts:68-75,305-315`, `useArcaAudio.ts:1614-1638` | none in hope-v2 or ALaaS source |
| `hope.summarization.*` (vox-node) | `packages/vox-node/src/resources/summarization.ts`, `types/summarization.ts`, `client.ts:94-99,230`, `core/url.ts:22-40` (prefix exemptions), examples `01-summary.ts`, `02-presummary-stream.ts`, README | **admin console Developer Docs sample** `apps/admin-console/src/features/developer-docs/components/sdk-screen.tsx:23` |
| `hope-compat-playground` workload | deployment repo `base/compat-playground.yaml`, `base/kustomization.yaml:39`, image renames in 5 overlays + 2 EKS overlays, `allow-front-doors.yaml:41-52`, `smoke-test.yaml:48` | none; **no source and no CI build job left**, so it runs a stale image |
| Tests / docs | e2e `task-562-text-compat.spec.ts`, `stt-compat-switch-cross-tenant.spec.ts`, contracts `text-compat.*`, unit `task-767-compat-wire-contract.test.ts`; mixed files `task-767-standalone-feature-credentials.spec.ts`, `task-760-uri-normalization.spec.ts:191-227`; docs `api-controller-groupings.md` View C, `api-controller-inventory.md`, rules `05`, `08`, `09` | — |
| `apps/smr/` on disk | **untracked** `__pycache__` leftovers from the pre-rename `text` service (not in git) | not a deletion target (local cruft only) |

**Prior owner decision in conflict:** OD-704 (2026-08-17, `docs/programs/agentic-workflow-platform/owner-decisions-2026-08-17.md:76`) kept the legacy pre-summary/summary compat "deliberately, no removal date". Today's instruction reverses it. See OD-1.

## 3. Best practices applied

| Practice | Applied as | Why it is best for correctness and performance |
|---|---|---|
| **One canonical value, normalized at the edge** | `languageMode` (closed catalog id) is the only internal carrier; a raw `language` is normalized to a mode once, at the gateway, by one shared normalizer; an unknown value gets **400 at the edge** | Validation fails fast and cheaply; no downstream service re-interprets strings (the TASK-938 lesson) |
| **Declare once, inherit by default, override explicitly** | Consultation-level declaration; sessions, jobs and workflow runs inherit unless the request overrides | Removes double declaration, the root of drift |
| **Capability negotiation with an explicit receipt** (the same idea as HTTP content negotiation / `Content-Language`) | The engine adapter returns a `LanguageResolution` (requested → applied, degraded + reason), echoed on the session/job response and the STT `ready` frame, and persisted | No silent degrade; clients and admins see what actually ran |
| **Prevent misconfiguration at configuration time** | Agent assignment/publish returns warnings when its engine degrades a mode the tenant offers | Cheaper than runtime surprises; OD-6 kept (a warning, never re-routing) |
| **Resolve once per session/job; zero per-frame cost** | Resolution happens at create; the consultation lookup folds into the existing ownership read; the catalog is cached (ETag + in-process TTL, invalidated on agent/model change) | No added latency or round trips on the live path |
| **Remove unused surface area** | Compat routes, SDK entries and the workload are deleted outright (zero traffic; pre-production precedent: deprecation register "Wave 3a" removed redundant surfaces without a window) | Smaller attack surface, fewer code paths, faster builds and CI |
| **Deprecation signalling for published artifacts** | Removal is recorded in the deprecation register; SDK removal ships in a documented release (the version bump is the owner's release call) | Consumers of published packages get a clear changelog |

## 4. Design

### 4.1 Canonical selection and precedence

```
requested (session/job/workflow override)  ─┐
consultation.spokenLanguageMode (declared) ─┼─▶ EffectiveLanguageModeResolver ─▶ languageMode ─▶ engine adapter ─▶ LanguageResolution receipt
agent decoding.languageMode (default)      ─┤         (packages/applications, one place)            (apps/stt, per engine)
'auto'                                     ─┘
```

- **Normalizer (TS, shared):** accepts a catalog id (`en`, `ml`, `ml-en`, `vi`, `vi-en`, `auto`, …) or a BCP-47 tag that maps 1:1 to a single-language mode (`en-US` → `en`, `ml-IN` → `ml`). Anything else is 400 `LANGUAGE_MODE_UNKNOWN` naming the catalog. It mirrors STT's `_language_mode_for_declared_language`, and a parity fixture pins them together (like `tests/contracts/resolved-asr-spec.fixture.json`).
- **Resolver precedence:** explicit request > consultation declaration > agent default > `auto`. It never selects or changes the engine (OD-6).

### 4.2 Consultation declaration

- `consultations.open` accepts `languageMode` (preferred) or `language` (normalized). It is stored in a **typed column** `Consultation.spokenLanguageMode` (nullable `String`), migration `task_1004_consultation_spoken_language_mode`.
  - Backfill from `metadata.summaryLanguage` only where that value normalizes to a catalog mode.
  - Readers of `metadata.summaryLanguage` (the live-documentation prompt context `trigger.context.language`) switch to the column, with one release of fallback reading.
- `PATCH consultations/:id` accepts `languageMode` (If-Match OCC, house pattern) so a client can change the consultation default between recordings (see OD-2).

### 4.3 Where the effective mode is applied

| Entry point | Change |
|---|---|
| `POST audio/transcription-jobs/stream/session` (native live, WS `/ws/stt/stream`) | If neither `languageMode` nor `language` is sent and `consultationId` is present, inherit `consultation.spokenLanguageMode`. The lookup reuses the existing consultation ownership read |
| `POST audio/transcription-jobs/transcribe` (batch) | Add `languageMode`; inherit as above; thread to the worker |
| `POST agents/:slug/transcriptions` (agent invocation, batch) | Replace the `AgentTranscriptionBody` interface with a class-validator DTO (`mediaId`, `consultationId?`, `language?`, `languageMode?`); inherit as above |
| Workflow / harness runs that invoke a SPEECH_TO_TEXT agent for a consultation | Pass the consultation's effective mode on the invocation (the node still names only the agent) |
| Dramatiq `transcribe_file` actor | Replace the dead positional `code_switching` with a named optional kwarg `language_mode` (default `None`, so already-queued messages stay valid) |

### 4.4 STT: engine-aware everywhere, honest capability, receipt

- **Batch parity:** `pipeline_spec_from_resolved` resolves each chain's mode with `resolve_mode_for_engine(mode, asr_model.format)` (the same call streaming makes); `_language_from_mode` is deleted. An engine that cannot serve the mode follows the degrade policy below.
- **Effective capability:** the catalog distinguishes `native` (e.g. Sarvam `codemix`, Azure auto-detect with candidate languages), `degraded` (for example whisper.cpp pair while the priming prompt is disabled, which means auto-detect with no language signal) and `unsupported`. `GET …/language-modes` gains an optional `agentSlug` (default: the caller's resolved agent) and returns, per mode, the level for that agent's primary engine and its fallback chain. The response carries an ETag and is cached.
- **Degrade policy:**
  - `native` → apply.
  - `degraded` → apply the best available and mark the receipt `degraded: true` with a reason.
  - `unsupported` by every engine in the chain → 422 `LANGUAGE_MODE_UNSUPPORTED` at create, as today, before any audio is accepted.
  - This is fail-soft with full transparency; a clinical live session is never refused for a partially served mode.
- **Receipt** `LanguageResolution { requestedMode, source: 'request'|'consultation'|'agent'|'default', appliedMode, engine, provider, params (vendor-level, e.g. {language_code:'ml-IN', mode:'codemix'}), degraded, reason? }`:
  - Returned on stream-session create and on the batch job create/get.
  - Carried on the STT `status: ready` WS frame and on the fallback engine switch frame (re-resolution already happens there).
  - Persisted in the STT session hash and in `TranscriptionJob` attributes.

### 4.5 Admin guard (configuration time)

- Assigning or publishing a SPEECH_TO_TEXT agent (department/tenant assignment, workflow publish) returns `warnings[]` when its primary engine is `degraded`/`unsupported` for any catalog mode the tenant offers.
- The console shows them next to the assignment. There is no block and no re-routing (OD-6).

### 4.6 SDKs

- **`@arcaai/vox-node`:** `consultations.open({languageMode})`, `stt.createStreamSession({languageMode})` (exists), batch `agents.transcribe({languageMode})`, typed `LanguageResolution` on responses and socket `ready`/switch events.
- **`@arcaai/vox` (browser):** the same types; fix the stale `OpenSessionInput.language` TSDoc (G-7).

### 4.7 ALaaS (live only; the Azure batch upload is out of scope)

- **web_ui:** one explicit `languageMode` on the `start` message from the "Language" selector. Stop overloading `language` and `summaryLanguage`; do not send a note language (notes are English).
- **Broker:**
  - `consultations.open({ languageMode })` and `stt.createStreamSession({ languageMode })` (explicit; HOPE also inherits server-side).
  - Refresh the stored language on a repeat `start`.
  - **Remove `HOPE_STT_AGENT_SLUG_BY_MODE` language→agent routing** (OD-6: HOPE resolves the agent).
  - Forward the `LanguageResolution` receipt to web_ui on the status frame.
- **UI:** a small chip, "Malayalam + English · <agent> (<engine>) · applied: auto-detect ⚠ degraded", with the reason in a tooltip.
- Out of scope: the unwired two-select workspace screen (`ConsultationSetupPanel.jsx`) and `upload_audio`.

### 4.8 Compat removal (outright; zero traffic)

Order keeps every CI gate green at each step:

1. **Deployment repo:** delete `hope-compat-playground` (manifest, kustomization entry, overlay image renames, network policy, smoke-test line). It is decoupled; land it first.
2. **`@arcaai/vox`:** delete `src/compat/**`, `src/compat.ts`, the `./compat` export and tsup entry; prune `compatSwitchEnabled`/`setCompatSwitchEnabled` and `opts.useCompatEndpoint` from the core.
3. **`@arcaai/vox-node`:** delete `summarization` (resource, types, tests, examples), the client property, `PREFIX_EXEMPT_PATHS` entries and README section; rewrite the console Developer Docs sample to the native agent/workflow call.
4. **Gateway:** delete `stt-compat/**` and `text-compat/**`, module registrations, prefix exclusions, tags, compat-only tests; edit the two mixed specs; retire `stt:stream:write`/`svc:stt:stream:write` (registry, API-key scopes, seed). Then regenerate route-manifest → openapi → portal → vox-node gen:admin together.
5. **Docs:**
   - Deprecation register rows (status `removed`, ticket TASK-1004).
   - OD-704 annotated **SUPERSEDED 2026-09-24**.
   - Retire View C in `api-controller-groupings.md` and the inventory entries.
   - Update rules `05`, `08`, `09`.

## 5. Performance and correctness targets (acceptance)

| Target | Value |
|---|---|
| Added latency on live session create | ≤ 5 ms p95 (no extra round trip; measured before/after) |
| Language selections lost between UI and engine (live) | 0: every session has `requestedMode` = the UI selection, or `source = consultation` |
| Silent degrades | 0: every degraded resolution carries `degraded: true` + reason in the receipt and the UI |
| Batch mode parity | For each engine, the batch vendor params equal the streaming vendor params for the same mode (table test) |
| Compat routes | 404 (removed); route manifest, openapi, portal and SDK exports have no compat entries |

## 6. Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | `languageMode` (catalog id) is the single internal carrier; `language` is normalized at the gateway; an unknown value → 400 | Fail fast at the edge; one interpretation |
| D-2 | Precedence: request > consultation > agent default > `auto`; never engine selection | The owner's "capture once" plus OD-6 |
| D-3 | Typed column `Consultation.spokenLanguageMode` (migration + backfill), replacing the misleading `metadata.summaryLanguage` for the spoken language | Queried on every session create; removes a name that caused confusion with the note language |
| D-4 | Degrade visibly (receipt + UI) rather than refuse; 422 only when no engine in the chain can serve the mode at all | Best clinical UX: the session continues, and the truth is shown |
| D-5 | whisper.cpp pair mode is reported as **degraded** while the priming prompt is disabled | Honest capability (G-4) |
| D-6 | Admin warnings at assignment/publish time; never block, never re-route | Prevent misconfiguration without violating OD-6 |
| D-7 | ALaaS drops `HOPE_STT_AGENT_SLUG_BY_MODE` routing | OD-6 ("no routing") |
| D-8 | Compat routes, SDK entries and the playground workload are **removed outright** (no deprecation window) | Zero traffic in 10 days, no consumers, pre-production precedent |
| D-9 | The Dramatiq actor gets a named optional `language_mode` kwarg; the dead positional is removed | Queue-safe evolution |
| D-10 | The catalog is cached with an ETag; resolution is computed once per session/job | Performance |

## 7. Open decisions (owner)

| OD | Question | Recommendation |
|---|---|---|
| **OD-1** | Confirm that today's "delete compat endpoints" **supersedes OD-704** (2026-08-17: "keep legacy pre-summarization and summarization, no removal date"), covering the text compat routes `/api/smr/api/v1/{presummary,summary/sync}` and `hope.summarization.*`, not only the STT compat routes | Yes: zero traffic, ALaaS migrated, the native agent/workflow plane covers it |
| **OD-2** | When the clinician changes the language between recordings in ALaaS, should it (a) change the consultation's default (later batch and workflow runs inherit it), or (b) apply to that recording only? | (a): ALaaS sends `PATCH consultations/:id {languageMode}` on change, so every later step agrees with what the clinician last chose |
| **OD-3** | SDK release for the removals: the `@arcaai/vox` `./compat` entry and vox-node `summarization` are breaking removals for published packages; ship them as the next **major** (4.0.0), or as a minor with a changelog note since there are no known consumers? | Next major (4.0.0): semver-correct; the owner cuts the tag |

### 7.1 Owner answers (2026-09-24)

> "go with your recommendations on all ODs for both tickets by align agents using appropriate model-effort tier"

- **OD-1:** yes. Today's instruction **supersedes OD-704**; both STT and text compat routes and `hope.summarization.*` are removed.
- **OD-2:** (a). A language change in ALaaS PATCHes the consultation default.
- **OD-3:** the SDK removals ship in the next **major** (4.0.0); the owner cuts the tag.

## 8. Implementation plan (on go)

### 8.1 Lanes and tiers (rule 14; file-disjoint)

| Lane | Repo | Owns | Tier / effort |
|---|---|---|---|
| L-DB | hope-v2 | `Consultation.spokenLanguageMode` Prisma field + domain entity/mapper/factory updates + backfill script (the orchestrator authors and applies the migration on the shadow DB) | `sonnet` / low |
| L-GW | hope-v2 | normalizer + parity fixture; `EffectiveLanguageModeResolver`; `consultations.open`/`PATCH` DTOs; stream-session, `transcriptions/transcribe`, `agents/:slug/transcriptions` DTOs + inheritance; Dramatiq kwarg; `LanguageResolution` DTOs; catalog `agentSlug` + ETag cache; assignment/publish warnings; live-doc readers switch to the column | `opus` / high (the deciding lane) |
| L-STT | hope-v2 | batch engine-aware resolution (`spec.py`, `transcribe_file.py`); effective capability levels in `language_modes.py`; receipt emission (session create response, `ready`/switch frames, session hash, job attributes); catalog per agent | `opus` / medium |
| L-SDK | hope-v2 | vox-node + vox types/params/events, TSDoc fix; **compat deletion in both SDKs** (§4.8 steps 2–3) + console Developer Docs sample | `sonnet` / medium |
| L-COMPAT | hope-v2 + deployment | gateway compat deletion + scope retirement + tests/docs (§4.8 steps 1, 4, 5); the orchestrator regenerates the artifacts after merge | `sonnet` / medium |
| L-ALS | ALaaS | web_ui `languageMode` + receipt chip; broker `consultations.open`/`createStreamSession` explicit mode, repeat-start refresh, routing-map removal, receipt forwarding, `PATCH` on change (per OD-2) | `opus` / medium |

**Conflict check:**
- `app.module.ts` / `global-prefix.config.ts` are touched only by L-COMPAT.
- The consultation DTO/service is touched only by L-GW; the Prisma schema and domain only by L-DB.
- SDK compat is touched only by L-SDK (L-COMPAT does not touch the SDKs).
- L-GW must not edit the compat modules. L-STT and L-GW agree on a pinned `LanguageResolution` wire shape (fixture in `tests/contracts/language-resolution.fixture.json`, authored by L-STT and consumed by L-GW, L-SDK and L-ALS).

### 8.2 TDD test list (first failing test per lane)

- **Normalizer parity (TS ↔ Python)** on the shared fixture: `en-US` → `en`, `ml-IN` → `ml`, `ml-en` → `ml-en`, `xx` → 400.
- **Resolver precedence** table test, including "never changes the agent".
- **Stream session** with only `consultationId` inherits the consultation's mode (`source: consultation`); an explicit mode wins.
- **Batch DTO** accepts `languageMode`; the Dramatiq message carries a `language_mode` kwarg; the worker applies `resolve_mode_for_engine` per chain (table: whisper.cpp / faster-whisper / Sarvam / Azure / OpenAI).
- **Receipt:** a whisper.cpp pair gives `degraded: true` with reason `whisper_cpp_pair_unprimed`; Sarvam `ml-en` gives `mode: codemix`; the receipt appears on the `ready` frame and after a fallback switch.
- **Catalog** returns per-agent levels, and an `If-None-Match` request gets a 304.
- **Assignment warning** is returned for a whisper.cpp primary with tenant mode `ml-en` offered.
- **Compat:** a route-manifest assertion that no compat path exists; the SDK exports check has no `./compat`; vox-node `publint`/`attw` stay green.
- **ALaaS:** the start message carries `languageMode` only; the broker sends it to both calls; a repeat start refreshes it; no `agentSlug` is sent; the status frame carries the receipt; the chip renders degraded state.

### 8.3 Verification (after merge + deploy)

- The single gate pass (owner rule), then artifact regeneration and checks, then `kustomize build` of every overlay.
- **Live:** an ALaaS session with `ml-en` on a whisper.cpp agent shows the degraded chip and the receipt in Redis/job. The same with the Sarvam agent shows `codemix`. A batch job via `agents/:slug/transcriptions` with only `consultationId` inherits `ml-en` and applies the engine's vendor params.
- **Compat:** each route answers 404; the `hope-compat-playground` pods are gone after Argo sync; the Developer Docs sample works against the native plane.

## 9. Implementation summary

### 9.1 Lanes (merge targets confirmed by the owner 2026-09-24: hope-v2 `dev-2.2`, deployment `main`, ALaaS `refactor-hope-integaration`)

| Lane | Tier | Branch @ tip | Change |
|---|---|---|---|
| L-DB (shared with TASK-1005) | sonnet | `task-1004-1005/db` @ `3012222fb` | `Consultation.spokenLanguageMode`; domain entity/factory/mapper |
| migrations | orchestrator | `3c4234abe` | `20260924133000_task_1004_consultation_spoken_language_mode` with the backfill IN the migration (catalog id, or `<lang>-<REGION>` with region = 2 letters or 3 digits); authored on a shadow DB, `migrate diff` empty afterwards |
| L-STT | opus | `task-1004/stt` @ `a201cd3dd` | `normalize_language_mode`, capability levels (`native`/`degraded`/`unsupported`), `LanguageResolution` receipt (session create, `provider_switched` entries, session hash, job completion), batch resolves per engine (`_language_from_mode` deleted), actor kwargs `language_mode` / `language_mode_source` (positional arity kept), catalog `?engines=` |
| L-GW | opus | `task-1004/gw` @ `4727ea1fe` | TS normalizer + precedence resolver + receipt projection; `open` stores and updates the mode (accepts `auto`), `PATCH consultations/:id {languageMode}` (If-Match); live + batch inheritance from the consultation; bridge + WS `ready` carry the receipt; `AgentTranscriptionRequest` DTO; harness batch route; catalog `?agentSlug` + ETag/304 (cache keyed by tenant); advisory `warnings[]` on ASR assignment/publish; legacy `metadata.summaryLanguage` readers switched to the column |
| L-SDK | sonnet | `task-1004/sdk` @ `9fc7adc4c` | `LanguageModeId`, `LanguageResolution`, `consultations.updateLanguage`, `languageMode` on open/stream/transcribe; `./compat` and `hope.summarization.*` removed; `agents.transcribe` now forwards `consultationId` (bug); console SDK sample rewritten; changeset → **4.0.0** (`30e94aea7`) |
| L-COMPAT | sonnet | `task-1004/compat` @ `7aa913dff`; deployment `task-1004/compat-deploy` @ `1d5188c` | `stt-compat/**` + `text-compat/**` deleted (6 routes, 2 tags), scopes `stt:stream:write` / `svc:stt:stream:write` retired (existing credentials keep authenticating — scopes match by string), preset fix, docs (deprecation register, OD-704 SUPERSEDED, rules 05/08/09); `hope-compat-playground` removed from every overlay |
| L-ALS | opus | ALaaS `task-1004/als` @ `a536809` (merged as `a6afbeb` after a peer's message-whitespace rewrite, tree-identical) | one `languageMode` on `start`; `language: <mode>` on open (works on today's gateway); explicit mode on the stream session; repeat start refreshes; `HOPE_STT_AGENT_SLUG_BY_MODE` routing removed; receipt forwarded + chip; `updateLanguage` feature-detected until vox-node 4.0.0 is installed |
| integration | orchestrator | `8b6f783b3` | regenerated route-manifest, openapi, portal, vox-node admin |

### 9.2 Gate pass (2026-09-24, integration worktree `hope-v2-task-1004-1005-verify`, real `pnpm install`)

| Gate | Result |
|---|---|
| `db:generate`, `build:packages`, `api:build`, `typecheck`, api `tsc --noEmit`, `pnpm lint` | PASS |
| `pnpm test:unit` (after the integration fixes) | **28 429 passed, 6 failed** — all six in `loki-line-contract.test.ts`, pre-existing (identical in the TASK-1003 gate) |
| `stt` pytest | 4 338 passed; the 46 failing ids are EXACTLY the pre-existing set (diffed against the TASK-1003 gate log: 0 new, 2 fixed) |
| `nlp` pytest | 716 passed, 2 failed (`test_metrics_endpoint_task636.py`, pre-existing) |
| `harness` unit, `text`, `py-runtime-models` | PASS |
| Python lint; typecheck | lint PASS; stt mypy: the same 4 pre-existing errors |
| `gen:model/entity/factory:check`, `env:sync --check`, `sdk-node:check:exports`, `api:openapi:check`, `api:portal:check`, `gen:admin:check` | PASS |
| ALaaS (merged branch) | `tsc` PASS; jest 833 passed / 5 failed — the same 5 on the pre-merge commit `41dc1a7`; web_ui 470 / 12 failed, the lane's documented pre-existing `priorCaseNotes` / `consultationStartContext` |
| Deployment `main` (merged) | render dev/staging/prod/standalone OK, `compat-playground` absent; `promtool` 64 rules + tests SUCCESS |

### 9.3 Behaviour changes to expect after deploy

- whisper.cpp `ml-en` sessions report `degraded: whisper_cpp_pair_unprimed` (true today, silent before); batch whisper.cpp `ml-en` jobs are no longer pinned to `ml`, so transcripts change.
- A non-catalog language (`hi`, `fr-FR`, `en-Latn-US`) is now **400 `LANGUAGE_MODE_UNKNOWN`** at the gateway (D-1) instead of a raw pass-through.
- `PATCH consultations/:id` is reachable by service accounts (`svc:consultation:session:write`, TASK-933 OD-2 posture) — and so can change `appointmentDate` / `departmentId` / `metadata`, not only the language. **Owner review point.**
- Explicit `agentSlug` + a foreign `consultationId` with no language is now 404 (previously unchecked).

### 9.5 Deploy (2026-09-25)

- Pushed deployment `main` (`8861956`), hope-v2 `dev-2.2` (`370bb8132`, pipeline **#1330**) and ALaaS `refactor-hope-integaration` (`a6afbeb`).
- `build-tts` / `build-harness-worker` failed twice on the runner's registry login (DNS timeout, then GitLab `jwt/auth` 502) and passed on the third run; no code cause.
- **The deployment push wedged Argo.** The exporter DaemonSet shipped with an all-zero placeholder digest, and the sync operation waited on its health indefinitely, blocking the promotion of #1330 (images + migrations). With owner approval the DaemonSet image was patched to the digest Git already declared at `0c624b8`; the stuck operation finished and auto-sync applied `main` (Synced/Healthy 23:32:19Z). Lesson recorded: never land a manifest whose image does not exist yet.
- Migrations applied 23:23:56Z; backfill typed 41 existing consultations (`ml-en` 24, `en` 15, `ml` 2; 13 left NULL).
- `verify-dev` in #1330 timed out during the wedge and was re-run.
- Live checks: the five compat HTTP routes answer **404** on `api-dev.taphuynh.dev`; the new routes answer 401 unauthenticated (mounted). Language receipts need a tester recording to verify.

### 9.4 Follow-ups (not done here)

1. Harness Python `_run_transcription` must send `consultation_id` and leave the legacy `pipeline_id` path (TASK-861 TODO); until then workflow batch jobs do not inherit the consultation's mode.
2. The batch receipt lives at `TranscriptionJob.dispatchEnvelope.languageResolution` (the entity has no metadata accessor); give it a proper field.
3. Confirm the batch Whisper-family path honours `streaming_english_gloss` for `ml-en`.
4. ~20 historical code comments still name the deleted compat controllers (provenance only).
5. Install `@arcaai/vox-node` 4.0.0 in ALaaS once the owner cuts `SDK-4.0.0`, to light up `updateLanguage`.

## 10. Change history

| Date | Change |
|---|---|
| 2026-09-24 | All lanes merged locally (6 lanes + migrations + artifacts + SDK 4.0.0); integration fixes; gate pass §9.2. |
| 2026-09-24 | Owner **go**: OD-1 (supersede OD-704), OD-2 (a), OD-3 (major) as recommended. |
| 2026-09-24 | Ticket opened from the owner's TASK-1003 follow-up. Discovery: HOPE language path (live, batch, workflow, per-engine, fallback), ALaaS language capture, and the compat surface + consumers (three read-only `sonnet` agents), plus live evidence (Redis `language_mode=ml-en` on both tester sessions; zero compat requests in 10 days). Plan, decisions and ODs written; awaiting go. |
