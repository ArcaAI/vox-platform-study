# TASK-930 §6.9 — LOCAL runtime proofs (lane LOCAL)

Run 2026-09-08, 21:16–21:50 ICT (14:16–14:50 UTC) against the running dev stack
(`stack-dev`, gateway `http://127.0.0.1:8868/api/v1`, branch `dev-2.2 @ 4e0c9362e`,
gateway build `0.0.0-dev-2-2.bc8234fe`). No repository edits, no git commands.
Artifacts and raw responses: this directory. Service logs read from
`/Users/taphuynh/.local/state/hope-dev/logs/dev/{api,stt,text}.log`.

Credentials used (all seeded, none invented):
- super admin JWT — `super_admin` / `password123` (no `tenantKey`)
- Global tenant admin JWT — `tenant_admin` / `password123` / `tenantKey=__GLOBAL__`
- ArcaAI tenant admin JWT — `arcaai_admin` / `password123` / `tenantKey=ARCAAI`
- internal service token — `INTERNAL_ACCESS_TOKEN` from `.env.dev` (peer-service probes only)

> Note on API keys: the seeded SDK keys carry `SDK_DAY_ONE_SCOPES`, which deliberately
> EXCLUDES `workflow:*` (`packages/database/src/prisma/db_main/seed/02-apikey.ts:126`
> — *"`workflow:*`. The exposure plane ships behind a kill-switch."*). `GET /workflows`
> with `SEED_API_KEY` answers
> `403 {"message":"API key does not have required scope(s): workflow:definition:read"}`.
> Every workflow proof below therefore uses a tenant-admin JWT, which is a legitimate
> credential class for the same routes.

---

## Summary

| # | Proof | Verdict |
|---|---|---|
| 1 | Global `realtime-transcription` streams | **FAIL** (blocked — ASR model not in the local HF cache; gateway 15 s timeout aborts the download) |
| 2 | `general-medicine-consultation` end to end | **FAIL** — three independent blockers (D-1, D-2, D-3) |
| 3 | Promotion round-trip Global → SYSTEM → fresh tenant | **PARTIAL PASS** — agent half passes with provenance; workflow half is **unreachable** (D-4) and the fresh tenant gets **no published workflow and no workflow assignment** (D-5) |
| 4 | Three ArcaAI department workflows at random | **FAIL** — all three reach a decided terminal state, but it is `FAILED`, for the same structural reason as proof 2 (D-1) |

Defects found: **D-1 … D-6**, listed at the end.

---

## Proof 1 — Global `realtime-transcription` streams — FAIL

### Request
```
POST /api/v1/audio/transcription-jobs/stream/session
Authorization: Bearer <tenant_admin JWT, Global tenant>
{"agentSlug":"realtime-transcription","sampleRate":16000,"language":"en"}
```

### Result — `HTTP 503`, three times, ~15 s each
```json
{"statusCode":503,"error":"Service Unavailable",
 "message":"Transcription is temporarily unavailable. Please retry.",
 "code":"GATEWAY.DOWNSTREAM_UNAVAILABLE",
 "correlationId":"01a0816a-1a66-7681-aa5a-adfeb907c057"}
```
(`session.json`; correlation ids `01a08164-84e7-…`, `01a0816a-1a66-…`)

### The agent itself resolves correctly — this is NOT an agent/resolver fault
```
GET /audio/transcription-jobs/fallback?agentSlug=realtime-transcription   → 200
{"configured":true,
 "pipelineId":"9c000000-0000-0000-0002-000000000001:fallback:arcaai-whisper-large-ml-en-gguf",
 "pipelineName":"arcaai-whisper-large-ml-en-gguf","agentSlug":"realtime-transcription"}
```
and a bogus slug is correctly rejected: `{"agentSlug":"no-such-agent-xyz"}` → `404 Agent not found`.
The deprecated `{"pipelineId":"probe-legacy"}` path → `404`. So `AsrAgentResolverService`
resolves the Global agent, its fallback chain and its runtime key.

### Decisive cause
`api.log`:
```
21:27:04.601 ERROR [StreamingSessionService] {"message":"Failed to create streaming session",
  "sessionId":"01a0816a-1a69-7593-a5bc-0ad22dda58c8","error":"timeout of 15000ms exceeded"}
21:27:04.602 ERROR [ExceptionInterceptor] {"message":"Downstream service call failed",
  "path":"/api/v1/audio/transcription-jobs/stream/session","downstreamFailureKind":"transport",
  "capability":"Transcription","status":503,"causeType":"AxiosError","causeCode":"ECONNABORTED",
  "causeMessage":"timeout of 15000ms exceeded"}
```
`stt.log` for the same session:
```
14:20:43 Creating streaming session  pipeline_id=9c000000-0000-0000-0002-000000000001
14:20:44 Silero VAD v5 ONNX model loaded …
14:20:44 Loading model arcaai-whisper-large-ml-en-gguf-q8_0 (format=WHISPER_CPP)
14:20:45 GET https://huggingface.co/taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF/…
Fetching 5 files:  40%|████      | 2/5
14:20:45 WARNING Reconciled leaked capacity slots  leaked_session_ids=[…]
```
The session-open path downloads the whisper GGUF repo (5 files) from Hugging Face on
first use. The gateway's client timeout is hard-coded at 15 s
(`packages/applications/src/services/stt/streaming/streamingSession.service.ts:246`
— `timeout: 15000`), so the request is abandoned mid-download, the capacity slot is
reconciled as leaked, and the partial blobs are left behind:
```
$ find ~/.cache/hope-hf/models--taphuynh--whisper-turbo-…-GGUF -name '*.incomplete'
… 609066 bytes ×3, last written 21:21, no growth since
```
Total cached: **1.8 MB** of a multi-GB repo. STT itself is healthy and has capacity
(`GET /internal/streaming/availability` → `{"available":true,"status":"ready","max_concurrent":15,"current_active":0}`).

**Verdict: FAIL, blocked on the environment.** No WebSocket connect or audio frame was
attempted, because no session id was ever returned. The proof cannot be re-attempted
without first warming the model. Warming it out of band needs the private HF repo's
token (`https://huggingface.co/api/models/taphuynh/…` returns `401 RepositoryNotFound`
without one), which this lane did not extract or use.

---

## Proof 2 — `general-medicine-consultation` end to end — FAIL

Fictional General-Medicine transcript (`transcript.txt`, 361 words: NSAID-associated
peptic ulcer; invented names Rajan Menon / Dr Priya Varghese / Sunitha George and
invented phone numbers 0484 555 0192, 98470 22314, so the PII guardrail has real work).

### 2a — API plane, `POST /workflows/general-medicine-consultation/runs`

`202` → run `01a0816f-0420-7cf8-bb68-283703bde6e0`. Terminal state after approving
`n_review` (`{"decision":"approved"}` → `200 {"signaled":true}`):

```
status FAILED   ended 2026-09-08T14:33:46.922412+00:00   resultRef null
  n_trigger  SUCCEEDED
  n_asr      SKIPPED    realtime_lane
  n_ner      SKIPPED    realtime_lane
  n_summary  SKIPPED    realtime_lane
  n_finalize DEGRADED   core.agent: nothing bound on `in`/`context` to generate from
  n_review   SUCCEEDED
  n_output   FAILED     activity_error: RuntimeError: core.output: result violates the
                        declared output schema: (root): 'case_note' is a required property
```

This is **D-1**. The graph's three producing nodes (`n_asr`, `n_ner`, `n_summary`) are all
`execution.lane = realtime`, and the Temporal interpreter skips every realtime node with
`reason="realtime_lane"` because the live executor owns them
(`apps/harness/src/harness/temporal/interpreter/workflow.py:505`; documented at
`node_spec.py:71`). Nothing then feeds `n_finalize`, so `n_output` cannot satisfy its own
`required: ["case_note","entities"]`. The definition nevertheless declares
`kinds: ['consultation','api']` and its description says *"exposed on the API plane"* —
so on that plane it is **structurally incapable of producing its declared output**.
No NER entities, no guardrail decision, no partial summary, no case note.

### 2b — Consultation plane

`POST /consultations/open {"patientId":"LOCAL-LANE-PT-0001","appointmentDate":"2026-09-08"}`
→ `201`. The assignment cascade worked and auto-started a governing run:
```json
"governingEngine":{"engine":"tenant-workflow","workflowDefinitionSlug":"general-medicine-consultation",
                   "workflowRunId":"01a08170-d1eb-7529-8b25-1f5350aff7d5"}
```
Transcript added as a `TRANSCRIPT` context item → `201`.

`POST /consultations/{id}/workflows/general-medicine-consultation/runs?mode=stream` → `202`,
then, 227 ms later, on the FIRST node:
```
event: workflow.node.failed
{"nodeId":"n_trigger","nodeType":"core.trigger","status":"FAILED",
 "reason":"activity_error: RuntimeError: core.trigger: run payload violates the declared
           context schema: (root): Additional properties are not allowed
           ('consultationId', 'externalPatientId', 'userId' were unexpected)"}
event: workflow.run.completed  {"status":"FAILED"}
```
(`consult-run-sse.txt`). Reproduced **identically with `{"input":{}}`**
(`consult-run-empty.txt`) — so the rejected properties are the ones the gateway injects,
not anything the caller sent. This is **D-2**: every consultation-plane run of this
workflow fails at `core.trigger`, before any node does work.

The clinical route deliberately injects `{ consultationId, userId, externalPatientId }`
(`packages/applications/src/services/consultation/workflow-dispatch/consultation-workflow-dispatch.service.ts:242`,
documented at `.../consultation/consultation/dto/consultation-workflow.response.ts:29`),
and `core.trigger` validates the whole payload against a context schema whose derived
form is `additionalProperties: false` — the reserved run-identity fields are not exempted.

### 2c — Positive control: is the durable lane + LLM usable at all?

`platform-default-summarization` (`kinds:['api']`, one durable `core.agent`) was run three
times with the same input:

| run | started | terminal |
|---|---|---|
| `01a08174-51ec-…` | 21:37 | `DEGRADED` — `n_summary: core.agent: text generate failed on every resolved candidate: text generate fail` |
| `01a08177-fb03-…` | 21:41 (after the endpoint repoint below) | `DEGRADED` — same |
| `01a0817c-1608-…` | 21:46 | `DEGRADED` — `… text generate failed: Server error '503 Service Unavailable' for url 'http://localhost:8862/api/v1/generate'` |

`n_trigger` and `n_output` both SUCCEEDED, so the durable lane, the graph, the review
machinery and the schema gate all work — **only the LLM call fails**. This is **D-3**.

Root cause chain:
1. `apps/text` answers `POST /api/v1/generate` with `503` in **0.5–2 ms** — it never dials a provider.
2. `POST /api/v1/providers/probe` (service token + `X-Tenant-Id`) reports, for EVERY provider:
   `"probe_error":"no connection is configured for this provider; nothing was probed"` —
   including for `X-Tenant-Id: 00000000-…` (SYSTEM) and `50000000-…` (Global).
3. The gateway, however, DOES hold the SYSTEM row:
   `GET /admin/providers/llm` (`X-Tenant-Id: SYSTEM`) →
   `lm-studio :: enabled=true :: baseUrl=http://hope-lmstudio:1234/v1`
   (Global and ArcaAI hold no `llm` rows at all — correct "no opinion" state.)
4. `http://hope-lmstudio:1234/v1` is the **k3s Service name**, dead on a laptop. That default
   is deliberate and documented, and is meant to be overridden at seed time by
   `SEED_LMSTUDIO_BASE_URL` (`packages/database/src/prisma/db_main/seed/17-ai-provider-connection.ts:60`,
   with the failure mode spelled out at lines 45–52). **`.env.dev` does not set it**, and the
   reseed therefore wrote the cluster hostname.
5. This lane repointed it through the admin API (a runtime config write, no repo edit):
   `PUT /admin/providers/llm/lm-studio` `{"baseUrl":"http://127.0.0.1:1234/v1"}` → `200`, `version` 1→2;
   `POST /admin/providers/llm/lm-studio/test` → `200 {"ok":true,"probe":"reachability","source":"platform"}`.
   LM Studio is up and serving (`GET http://127.0.0.1:1234/v1/models` → 200; it binds
   **IPv4 only** — `http://[::1]:1234` refuses).
6. **`apps/text` still 503s after the repoint** and still reports "no connection is configured"
   for both tiers. So beyond the bad seed value there is a second gap: the SYSTEM-tier
   `AiProviderConnection` is not reaching `apps/text`'s provider resolution at all.

**Verdict: FAIL.** None of proof 2's four required observations (NER entities, a recorded
guardrail decision on the summarization agent, a partial summary, a case-note
finalization/redaction output) was reachable.

---

## Proof 3 — Promotion round-trip Global → SYSTEM → fresh tenant — PARTIAL PASS

### 3a — Agent promotion — PASS

New Global lineage (clone of `general-medicine-summarization`):
```
POST /admin/agents/general-medicine-summarization/clone   (X-Tenant-Id: Global)
  {"newSlug":"local-lane-probe-summarizer","name":"LOCAL lane promotion probe"}
→ 201  id=01a08178-6a4e-75ae-a74f-9d6ec4141f1c  status=DRAFT v1
```
First publish attempt → **`400`** (this is **D-6**):
```json
{"message":"The agent cannot be published.","code":"CONFIG","findings":[
 {"severity":"ERROR","path":"parameters.generation.reasoning",
  "message":"`generation.reasoning` is not supported by the bound provider configuration
             `lm-studio/lms-gemma-4-e2b-it-qat` …"}]}
```
The parameter block is copied verbatim from the seeded, already-PUBLISHED
`general-medicine-summarization`, so a faithful clone of a published agent cannot be
re-published. Worked around by `PATCH`ing `parameters` to drop `generation.reasoning`
(`If-Match: "1"` → `200`), then publish → `200`.

Promotion — note the contract: it is refused with a working tenant and requires a
tenant-less super-admin context.
```
POST /admin/agents/promote-to-system   (X-Tenant-Id: Global)  → 403
  "Promoting an agent into SYSTEM crosses a tenant boundary and requires an elevated
   tenant-less context; clear the working tenant and retry."
POST /admin/agents/promote-to-system   (no X-Tenant-Id)       → 200
  {"agentId":"01a08178-f374-7ce2-a7f7-e9ce12fdf477","slug":"local-lane-probe-summarizer",
   "versionNumber":1,"copied":{"promptTemplates":0,"contextSchemas":0},
   "promotionId":"01a08178-f376-7553-bdde-5745fc03b74f","warnings":[]}
```
SYSTEM row, with provenance — **the decisive evidence**:
```json
{"id":"01a08178-f374-7ce2-a7f7-e9ce12fdf477",
 "tenantId":"00000000-0000-0000-0000-000000000000",
 "slug":"local-lane-probe-summarizer","status":"PUBLISHED","versionNumber":1,
 "sourceTenantId":"50000000-0000-0000-0000-000000000000",
 "sourceAgentId":"01a08178-6a4e-75ae-a74f-9d6ec4141f1c","sourceVersionNumber":1}
```

### 3b — Workflow promotion — FAIL (**D-4**: the route is unreachable, and it fails dirty)

```
POST /admin/workflow-definitions/promote-to-system  (X-Tenant-Id: Global)
  {"sourceDefinitionSlug":"general-medicine-consultation","changeReason":"…"}
→ 403 "Promoting into SYSTEM crosses a tenant boundary and requires an elevated
       tenant-less context; clear the working tenant and retry."

POST /admin/workflow-definitions/promote-to-system  (no X-Tenant-Id)   same body
→ 400 {"message":"Tenant ID is required","error":"Bad Request","code":"HTTP.BAD_REQUEST",
       "correlationId":"01a08179-11ce-7f80-a977-4932c1dc74ae"}
```
A closed loop: with a tenant it is 403, without one it is 400. No 409
`AGENTS_NOT_IN_SYSTEM` was ever reachable — the check never runs.

Worse, the 400 arrives **after the write has committed**. `api.log` around
`requestId 01a08179-11d0-…` (durationMs 53) shows, in order:
`INSERT INTO "core"."WorkflowDefinition"` → `INSERT INTO "core"."AgentPromotion"` →
`COMMIT` → `Job added to queue (SysEvent/AuditLog)` → a `WorkflowInvariantRule` read →
then `BadRequestException: Tenant ID is required`. The orphan is visible:
```
GET /admin/workflow-definitions   (X-Tenant-Id: SYSTEM)
  01a08179-11f5-75c7-a51c-6396981d82cc  general-medicine-consultation  DRAFT v2  active:false   ← orphan
  99000000-0000-0000-0000-000000000002  general-medicine-consultation  PUBLISHED v1 active:true
  99000000-0000-0000-0000-000000000001  platform-default-summarization PUBLISHED v1 active:true
```
`WorkflowDefinitionService.promoteToSystem`
(`packages/applications/src/services/workflow-definition/workflow-definition.service.ts:1076`)
asserts the tenant-less context at line 1077 and then, after
`agentPromotionService.promote(...)` has committed, calls
`this.publishEntity(promoted, { activate: true })` (line 1120) — the publish path is what
demands a CLS tenant. Candidate throw sites (`requireTenant()` /
`BadRequestException('Tenant ID is required')`):
`packages/applications/src/services/workflow-assignment/workflow-assignment.service.ts:294`
and `packages/applications/src/services/agent-assignment/agent-assignment.service.ts:268`.
(`agentPromotion.service.ts:311` has the same message but only on its read paths, 166/191.)

### 3c — Fresh tenant + reference-set sync — MIXED (**D-5**)

```
POST /admin/tenants {"name":"LOCAL Lane Proof Tenant","key":"LOCAL_LANE_PROOF","plan":"PRO"}
→ 201  id=01a0817b-5549-7d1e-9ed7-3d2360ec2a38
POST /admin/tenants/01a0817b-…/reference-set/sync {"mode":"missing-only"} → 200
```
```json
{"kinds":{"contextSchemas":{"added":0,"skipped":1,"failed":0},
          "promptTemplates":{"added":0,"skipped":17,"failed":0},
          "agents":{"added":0,"skipped":6,"failed":0},
          "agentAssignments":{"added":0,"skipped":4,"failed":0},
          "documentTemplates":{"added":0,"skipped":2,"failed":0},
          "workflowDefinitions":{"added":0,"skipped":2,"failed":0},
          "workflowAssignments":{"added":0,"skipped":0,"failed":1}},
 "warnings":["workflowAssignments: 'core' -> 'general-medicine-consultation' was not
              provisioned: No PUBLISHED 'core' workflow definition with slug
              'general-medicine-consultation'."]}
```
(`skipped` = already provisioned by the create-time clone, which is the correct
`missing-only` behaviour.)

What the fresh tenant actually holds:
```
agents (6, all PUBLISHED, all sourceTenantId=00000000-…):
  casenote-finalization · general-medicine-summarization · local-lane-probe-summarizer
  · medical-ner · realtime-transcription · text-to-speech
agentAssignments (4, scope TENANT): SPEECH_TO_TEXT→realtime-transcription,
  TEXT_GENERATION→general-medicine-summarization, …
workflowDefinitions (2):
  general-medicine-consultation   DRAFT v1  active:false  sourceTemplateSlug: (empty)
  platform-default-summarization  DRAFT v1  active:false  sourceTemplateSlug: (empty)
workflowAssignments: []
```

**PASS** for the agent half — and the round trip is proven end to end: the agent this lane
created in Global and promoted to SYSTEM (`local-lane-probe-summarizer`) is present in the
brand-new tenant with `sourceTenantId = 00000000-…`.

**FAIL** for the workflow half: the cloned workflow definitions land **DRAFT / inactive**,
so no TENANT-scope workflow assignment can be created, the tenant has **no governing
workflow**, and unlike agents the workflow clones carry **no provenance**
(`sourceTemplateSlug` empty, no `sourceTenantId`).

---

## Proof 4 — Three ArcaAI department workflows at random — FAIL

Selection: deterministic mulberry32 PRNG, **seed `20260908`**, over the 11 published
`arcaai-*-consultation` slugs sorted alphabetically (script inline in the session; pool and
picks printed):
```
POOL   = bren, derm, diet, gen, heme, neph, neur, orth, rheum, sonc, surg  (arcaai-*-consultation)
PICKED = arcaai-neur-consultation, arcaai-rheum-consultation, arcaai-gen-consultation
```
Each was run through `POST /workflows/{slug}/runs?mode=async` as the ArcaAI tenant admin,
with a department-appropriate fictional transcript (migraine with aura; seropositive-pattern
inflammatory polyarthritis; a fluid-overload revisit — `run3.js`), then its `n_review` node
was approved (`200` each) and polled to terminal. Raw: `proof4.json`.

All three reached a **decided terminal state — `FAILED`** — identically:
```
n_trigger         SUCCEEDED
n_asr             SKIPPED   realtime_lane
n_ner             SKIPPED   realtime_lane
n_visit           SUCCEEDED            ← core.condition; the durable lane works
n_summary_new     SKIPPED   realtime_lane
n_summary_revisit SKIPPED   realtime_lane
n_finalize        DEGRADED  core.agent: nothing bound on `in`/`context` to generate from
n_review          SUCCEEDED
n_output          FAILED    activity_error: RuntimeError: core.output: result violates the
                            declared output schema: (root): 'case_note' is a required property
```
| slug | runId | terminal | endedAt |
|---|---|---|---|
| `arcaai-neur-consultation`  | `01a08173-b414-7cd2-9627-cfe41320dc6c` | FAILED | 14:37:22Z |
| `arcaai-rheum-consultation` | `01a08173-cc9b-7490-a3d8-db598d071e0c` | FAILED | 14:37:28Z |
| `arcaai-gen-consultation`   | `01a08173-e4f4-7096-a4aa-70408ddfab4b` | FAILED | 14:37:34Z |

No document was generated. Same structural cause as proof 2a (**D-1**), so this is not a
property of the three slugs drawn — it applies to all 11.

---

## Defects

| id | Defect | Localisation | Severity |
|---|---|---|---|
| **D-1** | Every consultation-palette workflow is exposed on the API plane (`kinds:['consultation','api']`) but cannot satisfy its own `core.output` contract there: its producing nodes are all `lane: realtime`, which the durable interpreter skips (`realtime_lane`), so `n_finalize` degrades and `n_output` fails `'case_note' is a required property`. Reproduced on 4/4 definitions tried (Global `general-medicine-consultation` + 3 ArcaAI). | skip: `apps/harness/src/harness/temporal/interpreter/workflow.py:505` (contract at `.../interpreter/node_spec.py:71`); graphs: `packages/database/src/prisma/db_main/seed/28-workflow-library.ts:113-115` and `29-arcaai-agents-and-workflows.ts` | High — either the `api` trigger kind or the declared output schema is wrong for these graphs |
| **D-2** | Every CONSULTATION-plane run of `general-medicine-consultation` fails on `core.trigger` in ~230 ms: the gateway injects `{consultationId, externalPatientId, userId}` into the run payload and the trigger's context-schema validation rejects them as `Additional properties are not allowed`. Independent of caller input (reproduced with `{"input":{}}`). | injection: `packages/applications/src/services/consultation/workflow-dispatch/consultation-workflow-dispatch.service.ts:242`; validation: the `core.trigger` interpreter node against the derived (`additionalProperties:false`) context schema | **Critical — the clinical plane is dead for this workflow** |
| **D-3** | No TEXT_GENERATION agent can run locally. `apps/text` answers `/generate` `503` in ~1 ms and reports `"no connection is configured for this provider"` for lm-studio at BOTH the Global and the SYSTEM tier — even after the SYSTEM `AiProviderConnection` was repointed to a reachable, test-passing endpoint. Contributing: the reseed wrote the k3s hostname `http://hope-lmstudio:1234/v1` because `SEED_LMSTUDIO_BASE_URL` is unset in `.env.dev`. | seed default: `packages/database/src/prisma/db_main/seed/17-ai-provider-connection.ts:60` (failure mode documented at lines 45–52); relay gap: `apps/text` provider resolution / the gateway→text provider-override relay | High — blocks every LLM proof |
| **D-4** | `POST /admin/workflow-definitions/promote-to-system` is **unreachable**: `403` with a working tenant, `400 "Tenant ID is required"` without one. And the 400 is thrown AFTER `COMMIT`, leaving an orphan SYSTEM `WorkflowDefinition` (DRAFT v2) plus an `AgentPromotion` row — the operation is not atomic. | guard: `workflow-definition.service.ts:1077`; post-commit publish: same file line 1120 (`publishEntity`); the `requireTenant()` throw is in the publish path — candidates `workflow-assignment.service.ts:294`, `agent-assignment.service.ts:268` | **Critical — TASK-930 §6.2 is untestable and the route corrupts SYSTEM** |
| **D-5** | Reference-set clone lands workflow definitions in a new tenant as `DRAFT`/`isActive:false`, so `workflowAssignments` fails (`No PUBLISHED 'core' workflow definition with slug 'general-medicine-consultation'`) and the tenant has no governing workflow. Workflow clones also carry no provenance (`sourceTemplateSlug` empty), unlike agents which correctly carry `sourceTenantId`. | `TenantReferenceSetService` workflow-definition + workflow-assignment kinds | High — a freshly provisioned tenant cannot run a consultation |
| **D-6** | A faithful clone of a PUBLISHED agent cannot be published: `parameters.generation.reasoning`, copied verbatim from the seeded published `general-medicine-summarization`, is refused as "not supported by the bound provider configuration `lm-studio/lms-gemma-4-e2b-it-qat`". Either the seed publishes agents past their own validator, or the validator/model-capability table drifted. | agent publish validator (`generation.reasoning` capability check) vs. seeded agent parameters in `packages/database/src/prisma/db_main/seed/25-agents.ts` | Medium |

### Secondary observations (not counted as defects)
- **Contract inconsistency:** `POST /admin/agents/promote-to-system` requires a tenant-LESS context; `POST /admin/tenants/{id}/reference-set/sync` and the admin reads require `X-Tenant-Id`. Callers must know which. (`/admin/workflow-definitions/promote-to-system` wants both — that is D-4.)
- `GET /admin/workflow-runs` listed runs as `RUNNING` that the SSE stream had already reported `FAILED` (e.g. `01a08171-8445-…`). Possible status-projection lag; not chased.
- Seeded SDK API keys cannot reach the workflow plane at all (documented kill-switch), so any SDK-facing workflow proof must use a JWT or a service account.

## State this lane left behind on the dev DB
1. SYSTEM `AiProviderConnection` `llm/lm-studio` `baseUrl` changed `http://hope-lmstudio:1234/v1` → `http://127.0.0.1:1234/v1` (version 1→2). **Deliberate and worth keeping locally**; revert with the same PUT if the cluster value is wanted.
2. Global agent `local-lane-probe-summarizer` (`01a08178-6a4e-…`) + its SYSTEM promotion (`01a08178-f374-…`) + promotion record `01a08178-f376-…`.
3. Orphan SYSTEM `WorkflowDefinition` `01a08179-11f5-75c7-a51c-6396981d82cc` — `general-medicine-consultation` DRAFT v2, from the D-4 dirty failure. Safe to delete.
4. Tenant `LOCAL_LANE_PROOF` (`01a0817b-5549-…`) with its cloned reference set.
5. Consultation `01a08170-d16e-…` (patient `LOCAL-LANE-PT-0001`) with one TRANSCRIPT context item, plus 8 workflow runs.
