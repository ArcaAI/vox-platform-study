# TASK-930 — Agent & Workflow Platform Commitments (NER agents, service-account plane, promotion, seed rebuild)

| Field | Value |
|---|---|
| **Status** | `In Progress` |
| **Type** | `feature` (agent task, invocation plane, promotion) + `infrastructure` (seed rebuild) |
| **Branch** | `dev-2.2` |
| **Raised** | 2026-09-08 |
| **Memory snapshot** | [`MEMORY.md`](./MEMORY.md) — verbatim copies of the orchestrator memory files governing this ticket (decisions, hazards, working rules) |
| **Related** | TASK-893 (legacy vocabulary retirement — Phases 2–4 run as lane R of this wave), TASK-931 (SDK 3.1.0 + ALaaS), TASK-890 (the journeys these commitments come from) |
| **Lane contract** | [`INTERFACES.md`](./INTERFACES.md) — file ownership + every cross-lane signature |

---

## 1. Requirement Analysis

Owner brief (2026-09-08), the four asks verbatim in short form:

1. **Core business commitments** — (a) tenant admin manages agents (single task) and workflows
   (chains incl. parallel + sequential); (b) tenant admin defines an input and an output schema per
   agent/workflow for developers; (c) tenant admin publishes agents/workflows and exposes them via
   webhook / API / socket / http-SSE usable with an API key or a service account; (d) developers
   integrate with `@arcaai/vox-node` (backend) and `@arcaai/vox` (frontend); (e) **for any agent
   node, instruction/prompt, a provider + model must be declared from what is available to the
   tenant.**
2. **Delete all old seed data; seed the HOPE promotion process** Global (platform admin creates,
   tests, promotes) → SYSTEM (out-of-the-box set cloned into every new tenant) → tenants (edit the
   clone, create new, clone existing). Global set: a realtime transcription agent (whisper.cpp +
   `taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF`); a **General Medicine
   Consultation** workflow with a NER agent (transformer + `blaze999/Medical-NER`), guardrail enabled
   on the summarization agent (transformer + `fastino/GLiNER2-Guardrails-PII-Multi` for PII), a
   partial-summarization agent (LM Studio + `gemma-4-e2b-it-qat`, instruction prompt + General
   Medicine document template) and a case-note finalization + redaction agent (same model). Test
   locally before moving on.
3. **ArcaAI seed data** — transform the department × visit-type prompt templates into agents and
   workflows under the new architecture; test at least three at random.
4. **SDKs** — production readiness, version bump + release, the two codegen packages, then update
   ALaaSv3.0 (tracked as TASK-931).

Classification: `feature` + `infrastructure`. Numbering: highest ticket directory is TASK-893;
TASK-890 §8 reserves proposals up to TASK-929, so this is **TASK-930** and the SDK release is
**TASK-931** (owner delegated the decision).

---

## 2. Current State Evaluation — measured 2026-09-08 on `dev-2.2 @ 4e0c9362e`

Five read-only discovery lanes (seeds, contract + harness, agent entity + exposure, SDKs, ALaaS)
plus direct checks on the dev DB and the local stack. Findings that decide the design:

| # | Finding | Evidence |
|---|---|---|
| C-1 | `AgentTask` has exactly three values — `SPEECH_TO_TEXT`, `TEXT_GENERATION`, `TEXT_TO_SPEECH`. NER exists only as a workflow node (`consultation.extractEntities`, a deprecated type) or a `core.classify` node with a bare `modelSlug`; the guardrail PII model is chosen by the SUPER_ADMIN-only `AiRoutingPolicy`, never by a tenant. **Commitment (e) is unmet for NER.** | `enums.prisma:949-955`; `node-config-schemas.ts:1837` (`modelSlug` on classify); `16-ai-routing-policy.ts:91` |
| C-2 | Service accounts are locked out of the whole invocation plane: neither `agent.controller.ts` nor `workflows.controller.ts` declares a `@RequiredSvcScopes`, so `enforceServiceAccountScopes` denies by default; the Node SDK hard-codes the same in `assertApiKeyPlane()`. **Commitment (c) is unmet for service accounts.** | `agent.controller.ts:108-110`; `unified-auth.guard.ts:578-591`; `vox-node/src/resources/workflows.ts:159-167` |
| C-3 | The socket protocol a published workflow advertises needs a stream ticket that only a JWT can mint (`auth.controller.ts:99` is class-level `@ForbidApiKey()`). **Socket is not API-key usable.** | `workflow-ws.gateway.ts:26-45`; TASK-890 Q-16 / TASK-914 |
| C-4 | `Agent.outputSchema` is authorable and published on `GET /agents/:slug` but never used to constrain generation; the enforced contract is the unrelated `parameters.responseFormat`. **Commitment (b) is declarative only.** | `agent-invocation.service.ts:369-373`; no reference to `outputSchema` in it |
| C-5 | Parallel execution is real: the compiler groups independent nodes into one `CompiledStage` and the durable interpreter runs a stage with `asyncio.gather`; the realtime executor uses `Promise.all`. The Studio just never names it. **Commitment (a) is met at runtime.** | `compiler.ts:369-406`; `interpreter/workflow.py:455`; `realtime-executor.ts:206-231` |
| C-6 | **No seed file uses the `core.*` vocabulary.** Three vocabularies coexist: legacy `consultation.*`/`agent.*` (seeds 23, 24 — 26 distinct types, all deprecated), the `summarization` palette (seed 21), and `core.*` (Studio palette only). | contract lane grep: zero `core.(trigger|agent|…)` hits across the five seed files |
| C-7 | Promotion Global → SYSTEM exists for **workflows only** (`POST /admin/workflow-definitions/promote-to-system`, source tenant hard-coded to `50000000-…`). Agents have clone/import/export/sync but no privileged promotion lane. The seed copier (`26-tenant-reference-set.ts`) deliberately skips `workflowDefinitions`, unlike the runtime `TenantReferenceSetService`. | `workflow-definition.service.ts:1075-1130`; `26-tenant-reference-set.ts:432-436` |
| C-8 | The consultation dispatcher and the realtime lane resolve assignments for palette `'consultation'` only, while the exposure plane refuses that palette (`EXPOSURE_ALLOWED_PALETTES = {summarization, core}`) — a published consultation graph can govern a consultation OR be exposed to developers, never both. The J4/J5 black-box graph was authored in `core` and assigned under palette `core`. | `consultation-workflow-dispatch.service.ts:141,171`; `live-documentation.service.ts:1376`; `exposure-palette-policy.ts:80` |
| C-9 | ArcaAI's 23 clinical prompt templates (11 departments × 2 visit types + 1 pre-summary, `v3` approved) are wired only through the plain-string `Department.newPatientPromptId` / `revisitPromptId` columns, not through agents. | `07b-arcaai-clinical-templates.ts:159-183,561`; `prompt-resolution.service.ts:739` |
| C-10 | Local runtime: Docker infra healthy; gateway `:8868` + console `:5176` up from stale supervisors; the six Python services down; LM Studio service on `:1234` with `gemma-4-e2b-it-qat` downloaded but not loaded; HF cache at `~/.cache/hope-hf` holds Medical-NER, GLiNER2 PII and the code-switch GGUF. `.env.dev:1651` still points `HF_HOME` at the exFAT volume (the launch config overrides it). | probes 2026-09-08 |

The TASK-893 §2.7 root cause still holds: the 34 `ACTION_CATALOGUE` keys ARE deprecated node
descriptors, so the retirement needs the catalogue re-homed first (lane R, INTERFACES §7).

---

## 3. Decisions (owner delegated; each is recorded so it is not re-derived)

| # | Decision | Why |
|---|---|---|
| **D-1** | `AgentTask.NAMED_ENTITY_RECOGNITION` — NER is a first-class agent task backed by `TOKEN_CLASSIFICATION` catalogue rows, invocable at `POST /agents/:slug/invocations`, runnable as `core.agent`. Supersedes the 2026-09-04 note "Agent is only based on LLM/ASR/TTS models". | The owner's brief names "nlp ner agent: built-in provider + model" and rule (e) requires a tenant-chosen provider + model on every agent node; a `modelSlug` on a classify node is a second, inconsistent path. |
| **D-2** | Guardrail stays platform policy (OD-R, 2026-09-06). "Guardrail enabled with GLiNER2 on the summarization agent" = `parameters.guards.enabled: true` on the agent + `guardrail.enabled: true` on its node + the SYSTEM `AiRoutingPolicy` row `guardrail.pii.spans → gliner2-guardrails-pii-multi` (already seeded). No guardrail agent task. | OD-R is an owner rule from two days ago; the brief's wording is satisfied without a third model-selection path. |
| **D-3** | Service accounts get five `svc:*` scopes on the invocation plane (INTERFACES §3). | Commitment (c) says "API key or service account". |
| **D-4** | A run-scoped stream ticket route on the workflows controller makes the socket protocol usable with an API key or a service account; SDKs gain `transport: 'socket'` (INTERFACES §4). Closes TASK-914 / TASK-898. | Commitment (c) names socket explicitly. |
| **D-5** | `Agent.outputSchema` becomes the default `response_format: json_schema` when it is an explicit object schema and no `responseFormat` hyper-parameter is set (INTERFACES §5). | Commitment (b): the declared contract and the enforced one must be the same object. |
| **D-6** | The `core` palette governs consultations AND is exposable; the `consultation` palette dies with the legacy vocabulary. Seeds use `core`. | C-8; J4/J5 already proved the path. |
| **D-7** | Agents get `POST /admin/agents/promote-to-system` mirroring the workflow route; workflow promotion refuses (409) when a referenced agent is not in SYSTEM; the reference set clones `workflowDefinitions` + TENANT-scope `workflowAssignments` in both the runtime service and the seed copier (INTERFACES §6). | Ask #2's promotion process end to end. |
| **D-8** | Seeds are **deleted and rebuilt in `core.*`** (TASK-893 OD-6, second branch — now owner-directed). Global and SYSTEM carry an identical set (Global authors, SYSTEM = promoted copy with provenance); ArcaAI is generated from a department × visit-type table (INTERFACES §8). | Ask #2 and #3. |
| **D-9** | TASK-893 Phases 2 + 4 run now as lane R: the action catalogue becomes a curated first-class table (17 kept, 17 agent-shaped keys dropped), then every deprecated node type is deleted TS + Python in lockstep (INTERFACES §7). | OD-2 "deprecated things must be removed completely" — and the seed rebuild removes the last consumer. |
| **D-10** | SDKs ship **3.1.0** (minor, non-breaking); the R4 deprecation removals (`pipelineId`, client-AI packages) stay for TASK-901. | ALaaS and three first-party demo apps still sit on `sttPipelineId`; a breaking release would block ask #4's own consumer update. |

---

## 4. Implementation Plan — five parallel worktree lanes, one contract

| Lane | Ticket | Tier / effort | Worktree · branch | Scope (INTERFACES §) |
|---|---|---|---|---|
| **R** | TASK-893 | opus · high | `../hope-v2-t893-r` · `task-893-retire` | §7 action catalogue table, legacy deletion TS + Python, rule catalogue, palettes, realtime rekey, Studio dropdown, register |
| **N** | TASK-930 | opus · high | `../hope-v2-t930-n` · `task-930-ner-plane` | §2 NER task, §3 svc scopes, §4 stream ticket, §5 outputSchema, console wizard |
| **P** | TASK-930 | opus · medium | `../hope-v2-t930-p` · `task-930-promotion` | §6 agent promote-to-system, workflow promote check, reference-set kinds |
| **S** | TASK-930 | opus · high | `../hope-v2-t930-s` · `task-930-seeds` | §8 seed rebuild (Global/SYSTEM/ArcaAI), copier, regen script, tests |
| **K** | TASK-931 | opus · medium | `../hope-v2-t931-k` · `task-931-sdk` | §9 SDK 3.1.0 |

Tiering: every lane is opus because each one's verdict is acted on (rule 14 §1 — never
downshift the deciding stage); effort `high` where the work is cross-language or shape-defining
(R, N, S), `medium` for the well-specified P and K.

### 4.1 Lane execution log (live — updated by the orchestrator)

All lanes branch from `dev-2.2 @ 7793d09ca` (the plan commit). Bootstrapped 2026-09-08 01:20
(`pnpm install`, `db:generate`, `build:packages` — 22/22 tasks green in every tree; `.env.dev` /
`.env.test` copied in). Per rule 14 §5 no worktree is removed before its branch is merged.

| Lane | Ticket | Worktree · branch | Model | State (2026-09-08, wave 3) |
|---|---|---|---|---|
| R | TASK-893 | `../hope-v2-t893-r` · `task-893-retire` | fable → **opus** | **DONE-WITH-GAPS @ `6dfd9783c`** (§4.3). wave 3's fable run reached 7 commits (Phase 2 TS+Py, realtime rekey, applications retarget, Studio dropdown, registry deletion) then hit the fable session limit (429, resets 21:20 Saigon) with the legacy-test deletion uncommitted; **resumed 17:25 on opus** from its own `.lane-report.md`. Before that: waves 1+2 both died before writing anything — **zero commits, clean tree**. Wave 3 starts the lane from the base with INTERFACES §7 as the design of record |
| N | TASK-930 | `../hope-v2-t930-n` · `task-930-ner-plane` | opus | **DONE-WITH-GAPS @ `9128d7507`** (§4.3). Was: `66241bb57` (enum + migration + domains enum) and `96a4af2d1` (NER contract in `agent-schemas.ts` + tests) landed; `packages/types/src/agent.ts` (A-5 widening) left UNCOMMITTED. Wave 3 **resumes**: commit that file first, then §2.4 invocation, §3 scopes, §4 ticket, §5 outputSchema, §2.5 console |
| P | TASK-930 | `../hope-v2-t930-p` · `task-930-promotion` | opus | **DONE @ `4a634f8c8`** (§4.3). Was: zero commits, but wave 2 left ~1 000 uncommitted lines under `packages/applications/src/services/agentPromotion/` (service + interface + DTO + test). Wave 3 **commits that first**, then judges it against §6 and adds the controller/module, §6.2 409 check, §6.3 reference set, §6.4 console |
| S | TASK-930 | `../hope-v2-t930-s` · `task-930-seeds` | fable → **opus** | **DONE @ `5eb24b9a1`** (§4.3). wave 3's fable run reached 8 commits (§8.1 deletion, §8.2 schema, §8.3 agents, §8.4/8.5/8.6 workflows + generator + regen script) then hit the same 429 with the §6.3 copier RED test uncommitted; **resumed 17:25 on opus**, briefed with P's kind set and N's five scopes. Before that: `eeb232436` carries the §2.1 enum line only (no migration, by contract). Both waves died during reading — the seed rebuild itself is unstarted. Wave 3 works against a throwaway `hope_seed_930` DB |
| K | TASK-931 | `../hope-v2-t931-k` · `task-931-sdk` | opus | **DONE @ `0bf31a4e6`** (§4.3). Was: `cf62eff3d` (`SDK_VERSION` from `package.json`) landed; changesets + `.gitlab/ci/publish.yml` + CHANGELOG left UNCOMMITTED. Wave 3 **resumes** against the A-1 ticket shape |
| A | TASK-931 | ALaaSv3.0 working tree | — | held back until the 3.1.0 publish; its edits do not gate the lanes |

Merge order stays **N → P → R → S → K**; A lands after the 3.1.0 publish. Every brief is in the
session scratchpad (`briefs/full-{R,N,P,S,K}.md`, `preamble.md`, `N-discovery.md`, plus wave 3's
`RESUME.md`, which adds one standing rule: **commit every ~10 minutes and keep a running
`.lane-report.md`**, because the failure mode that cost two waves was uncommitted work at kill time).

### 4.2 Mid-flight contract amendments (recorded here, applied in `INTERFACES.md`)

Found by lane N's completed discovery sub-reports before the interruption; every lane was told.

| # | Amendment | Why |
|---|---|---|
| A-1 | The run-scoped stream-ticket route (INTERFACES §4) answers `{ ticket, expiresAt (epoch ms), scope, url }`, **not** `expiresIn`. | Matches the gateway's existing `IssueStreamTicketResponse` and `StreamTicketService.issueTicket` (30 s TTL, scope `workflow_run:<runId>`, `@Global` module); `WorkflowWsGateway` checks the scope string by strict equality. K codes against this shape. |
| A-2 | `svc:*` scopes are **derived**, never hand-written: `service-account-scopes.registry.ts` builds each family from API-key scope sources via `deriveFamilyInto()`; a fourth family (`AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES`) is the sanctioned shape, and it must also be registered in `apps/api/src/bootstrap/service-account-surface-audit.ts` (`declaredNonAdmin`) and the registry test's count. The five API-key scopes already exist (`apikey-scopes.registry.ts:722-753`). | The registry test and boot audit D refuse a literal `svc:` entry. |
| A-3 | Lane N may regenerate `apps/api/route-manifest.json` in its worktree (only that artifact) because `svc-scope-route-ability-coverage.test.ts` reads the committed manifest; the orchestrator regenerates all five artifacts after merge anyway. | Keeps N's own gate honest without widening artifact ownership. |
| A-4 | `outputSchemaResponseFormat` (INTERFACES §5) is exported from the package `index.ts` by lane R (owner of `index.ts`), not by N. | Avoids a two-owner edit on `index.ts`. |
| A-5 | `AGENT_TASK_SERVICE` widens to `'stt' \| 'llm' \| 'tts' \| null` and `AgentCompiledConfig.service` likewise: `MODEL_TASK_TYPE_SERVICE[TOKEN_CLASSIFICATION]` is `null` by design (nlp serves the classification family from the bucket, no connection plane). NER rows are `provider: 'built-in'`, so `providerClassOf` yields `platform-self-host` before the service is consulted and publish is not blocked. | Discovered in `agent.service.ts:1831-1897`; without it every NER publish would fail `MODEL_UNAVAILABLE`. |
| A-6 | nlp `POST /api/v1/classify/tokens` takes `model_name` = `AiModel.sourceUri` (required) + `model_path` = `localPath`, answers entities as `{ text, entity_type, confidence, position:{start,end} }`; the gateway maps them to the §2.3 output. Usage is recorded with the existing `buildNerUsageEvent` (`operation: 'ner.extract'`) after `assertMeterQuota(tenantId, 'monthlyNlpTextUnits')`. | Reuses the three existing gateway NER callers' contract instead of inventing a fourth. |

### 4.3 Lane reports (wave 3)

**Lane P — DONE.** `task-930-promotion` @ `4a634f8c8`, 11 commits, tree clean, all 17 changed
files inside its §1 ownership rows (verified by the orchestrator, not taken on report). Its first
action was committing the ~1 000 rescued lines; the service was judged sound against §6.1 and kept
— its two real defects were missing barrel exports and a `JsonValue` cast, and the failing test was
the fixture, not the service.

Delivered: `POST admin/agents/promote-to-system` (`@CanManage('Agent')` + `@ForbidApiKey` +
`@RequiredSvcScopes('svc:admin:agent:manage')`, `AUTH-NOTE` marker) →
`{ agentId, slug, versionNumber, copied: { promptTemplates, contextSchemas }, promotionId, warnings }`;
`WorkflowDefinitionService.assertReferencedAgentsInSystem` → 409 `AGENTS_NOT_IN_SYSTEM` (§6.2);
`REFERENCE_SET_KINDS` at seven entries with `workflowAssignments` last, TENANT scope only (§6.3).

Gates pasted: applications typecheck/lint clean, `12 279 passed | 0 failed`; `api:build` 12 tasks;
api tests `4 261 passed`; api lint clean; a real boot smoke on `:8972` returning
`{"status":"healthy"}` — which also proves the deny-by-default boot audit accepted the new route.
One test FILE errors on `$connect()` because the `:5433` test DB is down — orchestrator-owned infra,
not a lane defect.

Two deviations from the contract, both **accepted** by the orchestrator:

| Deviation | Ruling |
|---|---|
| The response carries `promotionId` + `warnings` beyond the four declared fields | Accepted — additive, and an exact mirror of the existing `PromoteWorkflowToSystemResponse`. Consistency with the workflow route outranks a literal reading of §6.1. |
| §6.1's "same versions" implemented as: copy the source's APPROVED snapshot, restart the SYSTEM lineage at v1, re-pin `promptVersionNumber: 1` | Accepted — verbatim what `AgentPromotionService.materializeTemplate` already does, improved by stamping `sourceTemplateId` (making re-promotion idempotent) and marking `APPROVED` only where the source was. |

Carried to merge time: P committed a `.lane-report.md` at its worktree root — a lane scratch file
that must NOT land on `dev-2.2`; drop it in the merge. Its cross-lane request (lane S must give
`26-tenant-reference-set.ts` the same `workflowAssignments` clone) is already contract §6.3, so it
needs verification at merge, not a new instruction.

**Lane N — DONE-WITH-GAPS.** `task-930-ner-plane` @ `9128d7507`, 12 commits, tree clean, merges
clean against `dev-2.2`. Out-of-row edits, each verified and accepted: `route-manifest.json`
(A-3), `service-account-surface-audit.ts` + test (A-2), `workflow-contract/src/index.ts` (the
A-4 export, from the earlier run — R was told not to duplicate it), and one hunk in
`interpreter/models.py` widening the Python `AgentTask` Literal (without it
`ResolvedAgent.model_validate` refuses a NER agent and degrades the node as `agent_unresolvable`).

Delivered: `POST /workflows/:slug/runs/:runId/stream-ticket` → 201 `{ ticket, expiresAt (epoch ms),
scope: 'workflow_run:<runId>', url }`, ownership proved via `getRunStatus` before the mint (A-1 as
written); the fourth derived scope family (`svc:agent:definition:read`, `svc:agent:invocation:write`,
`svc:workflow:definition:read`, `svc:workflow:run:read`, `svc:workflow:run:write`) on all 5 agent +
10 workflow routes, `svc:admin:*` deliberately NOT reaching them; `AgentInvocationService.invokeNer`
→ `{ entities: {text,label,start,end,score?}[], model, charCount }`; the invocations route dispatches on
the RESOLVED task (NER + `?mode=stream` → 400 `MODE_UNSUPPORTED`); `outputSchemaResponseFormat()` TS +
`output_schema_response_format()` Python applied in `invokeText` / `_run_text_generation`; the console
authors a NER agent.

Gates pasted: migration proved on a shadow DB (`-- This is an empty migration.`), domains 1 899 +
gen checks "no drift" / "coverage OK", workflow-contract 1 713, api **4 265 / 0 failed**,
route-manifest 736 routes, boot smoke `:8971` healthy, harness interpreter 591 + ruff clean, console
agents 66 + tsc 0 + eslint 0, applications 12 280 with **one real failure — the gap below**.

Deviations, accepted: `model_name = wireModelId ?? sourceUri` (built-in NER rows declare no
`wireModelId`, so the literal §2.4 would 503 at nlp — same posture `buildSpeechRequest` uses for
built-in TTS); `clinical_taxonomy` not injected (needs a runtime catalogue read; §2.3 promises spans
only). Watch item: the task-mismatch 400 message changed wording — check SDK/e2e string asserts.

**Lane K — DONE.** `task-931-sdk` @ `0bf31a4e6`, 15 commits, tree clean, entirely in-row, nothing
under the generated `vox-node/src/resources/admin/**` touched, merges clean.

Delivered: NER task + `NamedEntityRecognition*` types in both SDKs; `assertApiKeyPlane` replaced by an
overridable `assertCredentialClass()` so service accounts reach the agent/workflow planes while the
consultation plane stays strict; `transport: 'sse' | 'socket'` on `streamRun` / `waitForRun` /
`runAndStream` (vox-node, zero-dep `core/socket.ts`) and `useWorkflowRun` (browser,
`WorkflowRunSocketClient`), both coded to A-1; `useAudioCapture` forwards `sttAgentSlug` — a live
bug, since a compat app that had moved to the agent slug ran capture with NO selector; `vox-codegen`
business-plane mode emitting `Agent_<Slug>_Input/_Output` and slug-keyed contract maps; release
mechanics (nine minors — three plus the six `linked` audio packages, expected).

Gates pasted: `sdk:test` 3 704 / 244 files, `sdk-node:test` 452 / 30 files, codegen 55 + 36,
`check:exports` clean, all builds/lints/typechecks 0. `apps/quick-compat-app` typecheck cannot run
until 3.1.0 is on the registry (it installs the PUBLISHED package) — re-run after publish.

**Lane S — DONE.** `task-930-seeds` @ `5eb24b9a1`, 18 commits, tree clean, 48 files all in-row,
merges clean; its only sibling overlap is the intentional identical enum hunk shared with N. It
corrected its own handoff: the "RED, now the two copiers" note was stale — the copiers had landed
before the kill and the §6.3 suite was 5/5 green on first run.

Delivered: the legacy seed set deleted (23 / 24 / 07e / 07g and their regen scripts); ONE trigger
context schema `consultation_note_context` (`isDefault: true`, 07e folded in — `DAY1_CONTEXT_SCHEMA_SLUG`
has no runtime reader); Global and SYSTEM each 5 agents (1 STT, 2 TEXT_GEN, 1 TTS, 1 NER) + 2
workflows with SYSTEM carrying `sourceTenantId = Global`; ArcaAI generated from the department ×
visit-type table — 27 agents, 13 workflows, 1 TENANT + 11 DEPARTMENT assignments; the §6.3 seed copier
cloning `workflowDefinitions` + TENANT-scope `workflowAssignments` with a parity test proving the
re-stamped clone equals a real `compile()`; the five §3 scopes in `94-service-account.ts`; a fix to a
real break in `09-consultation.ts` (it still named the deleted `example-transcription`).

Gates pasted: database **80 files / 1 651 tests**, typecheck clean, `seed:regen:workflows` twice →
`git status` clean, **two real seed runs** on the throwaway `hope_seed_930` (run 2 every counter
`+0` → idempotent, DB then dropped), `audit-publish-findings` clean over all 17 persisted graphs.

Report answers: no document-template binding kind exists on `Agent.instruction` (only
`{value}` | `{path}`), so the General Medicine heading lists are bound as constants; the ArcaAI v3
templates declare no variables, so §8.5's "variables populated" is pinned as the EMPTY set.

**Binding consequence for the merge order:** the `.generated.ts` blobs are checksum-bound to THIS
tree's node registry. Lane R's retirement changes that checksum, so after R merges the orchestrator
must re-run `seed:regen:workflows` — S's new parity test goes red until then, by design.

**Lane R — DONE-WITH-GAPS.** `task-893-retire` @ `6dfd9783c`, 35 commits, tree clean, merges
clean; the one out-of-row file is `workflow-contract/package.json` (two `regen:*` script lines —
the same allowance S has). It stayed out of N's `interpreter_core_agent` / `_run_*` and did not
duplicate the A-4 export.

Delivered: `ACTION_CATALOGUE` (17 keys) as a first-class table in TS and Python, `ACTION_PORTS`,
`ACTION_CONFIG_SCHEMAS`, `WORKFLOW_NODE_REGISTRY` → 11 `core.*` entries, `NODE_REGISTRY` 64 → 11,
`NODE_ACTIVITIES` 65 → 29, `MANDATORY_NODE_TYPES = {core.trigger, core.output}`, the `WF-SUMM-*` set
and `DRAFT_CONSULTATION_RULE_SET` deleted, `classesOf()` resolving a `core.action` instance to its
delegate. Two SOURCE fixes it found rather than test edits: `GUARDRAIL_OPTED_OUT` in
`publish-findings.ts` had become dead code after Phase 4 (it tested the mandatory set, which is now
exactly the two types whose schema withholds `enabled`) — the first of TASK-890 D-1's three
compensating controls; and `core.start` left `ENTRY_NODE_TYPES`.

Gates pasted: workflow-contract 38 files / 827, tsc + eslint + build clean; Studio 56 files / 544,
tsc + `--max-warnings 0` clean; `py-workflow-contract` 75; harness ruff + mypy (152 files) clean;
applications (own rows) 26 files / 248; `grep "deprecated: true"` → 0; `NodeSpec(` → 11. Python
provenance proved in-tree.

**Named reds, left failing on purpose — each an owner decision, ruled below (§4.5):** harness
pytest **34 failed / 2 203 passed** = 6 replay-compat (a deploy PRECONDITION, not a bug — deleting a
node type changes what the interpreter schedules, `TMPRL1100 Nondeterminism`, no `workflow.patched`
can rescue a path that no longer exists) + 22 agentic-loop (the `agentic.loop` dispatcher was the
only caller of `AgenticLoopWorkflow` / `loop_activities.py` — a feature removal outside the brief)
+ 2 audio two-lane (needs N's `interpreter_core_agent`) + 6 pre-existing at baseline.

**The real blast radius:** `packages/applications` **140 failures across 30 files, none in R's
rows** — `agentPromotion/**`, `workflow-definition/**` (P's tests, written against the old
vocabulary), `config-resolver/**`, `workflow-assignment/**`, `workflow-invariant-rule/**`,
`workflow-validator/**`, `consultation/prompt/**`, `live-documentation/__tests__/**` (unowned).
INTERFACES §7 anticipated only the seeds. Plus: `GET /admin/workflow-nodes` must serve the 17 action
descriptors or the Studio's `effectiveNodePorts` silently falls back to the generic superset (six
sockets where the action has one); `live-documentation.service.ts:1376` still resolves palette
`'consultation'`; `py-workflow-contract` has no `pythonpath`, so the worktree guard needs a manual
`PYTHONPATH`.

Pinned as tests, not silently changed: all ten `WF-I-*` invariants are INERT (`paletteKey:
'summarization'`, and `validate()` skips a foreign palette); `WF-S-007` is vacuous for `core`;
anti-laundering is weaker for NER (a `core.agent` typed on `text`, which `document` widens to);
`compileGate` may be unreachable (nothing is `gate`-classed now).

### 4.4 Orchestrator punch list — the unowned files, resolved (wave 3)

Lane S reported four cross-lane needs that share one root cause: **the §1 ownership table has no
row for them**, so under "anything not listed is owned by nobody" they were correctly left alone.
They are hereby the **orchestrator's**, and they are fixed **at merge time, not before** — flipping
any of them on `dev-2.2` while the seeds still exist there would turn the branch red for a state
that has not landed yet.

| Unowned file | What must change | When |
|---|---|---|
| `packages/applications/src/services/consultation-context-schema/context-schema-definition.ts:56` (the constant; consumed at `prompt-assembly.service.ts:770/786`) | `LEGACY_CONTEXT_SCHEMA_SLUG` repointed from `consultation_legacy_v1` to `consultation_note_context`. The resolver is FAIL-CLOSED (`LEGACY_CONTEXT_SCHEMA_MISSING`), so the moment S's §8.1 deletion lands without this, every prompt assembly throws. **Highest-risk item in the wave.** | with the S merge, in the same commit |
| `tests/contracts/tenant-reference-set-parity.contract.test.ts:36` | `SEED_DECLARED_EXCEPTIONS` drops `workflowDefinitions` — §6.3 makes the seed copier and the runtime service copy the same kind set, which is exactly what this contract exists to pin | with the S merge (P's §6.3 half is already on `task-930-promotion`) |
| `live-documentation.consultation-selected-lane.task858:49`, `live-documentation.realtime-capabilities.task852:43`, `live-documentation.governed-graph-mode.task858:385-386`, `consultation/loop/__tests__/day1-loop-defaults.task686` | retarget path-imports off deleted seeds 23 / 24 / 07e onto `28-workflow-library.generated.ts`, `29-arcaai-agents-and-workflows.generated.ts`, `07e-consultation-note-context-schema.ts` | with the S merge |
| `packages/database` `.generated.ts` seed blobs | `pnpm --filter @arcaai/database seed:regen:workflows` after R lands (registry checksum changes); S's parity test is red until then | after the R merge, before S's gates |
| `packages/applications/src/services/consultation-context-schema/context-schema-definition.ts` | check only — S folds `DAY1_CONTEXT_SCHEMA_SLUG` into the new schema because it has **no runtime reader** (`LoopConfigService` reads `isDefault`). Verify that still holds after R's retirement | at merge |
| `packages/applications/src/services/consultation/__tests__/nlp-egress-redacted.grep-gate.test.ts` | **Owner ruling (orchestrator, 2026-09-08): allow-list entry for `services/agent/agent-invocation.service.ts`**, reason as lane N drafted it — the caller submits this text itself through a scoped public API and receives character OFFSETS into it; `pseudonymize` is not length-preserving, so redacting first would return spans that index a document the caller never sees, i.e. highlight the wrong words in a clinical note. This is the gate's own documented review moment; the unredacted hop is caller-owned text, unlike the transcript/DNA hops where HOPE moves a patient's text the caller never sent. **Flagged to the owner; overrule before the N merge if the posture is wrong.** | with the N merge |
| `apps/api/tests/e2e/task-776-credential-classes.spec.ts:183-188` | uses `GET /workflows` as the "no `@RequiredSvcScopes` → 403" example; it now HAS one and returns 200 once the seeded account holds `svc:workflow:definition:read` (which lane S is adding). Repoint at a still-undeclared business route (a `/consultations/:id/workflows*` route) or drop the case | with the S merge, before e2e |
| `turbo.json#globalEnv` | `+= HOPE_API_KEY` — `vox-codegen`'s business-plane mode reads it as the fallback for `--api-key` (a key on argv is visible in `ps`); currently one `turbo/no-undeclared-env-vars` warning | with the K merge |
| `packages/vox-node/src/__tests__/workflows.contract.task850.test.ts` `PENDING_GATEWAY_ROUTES` | empty the set in the manifest-regeneration commit — it lists the stream-ticket route as pending and gates the `svcScopes` assertions behind a `MANIFEST_PREDATES_TASK930` flag; left as is, a genuinely missing route stops being noticed | with the five-artifact regen |
| `apps/admin-console/src/shared/docs/sdk-snippets.ts` | optional — `SdkSnippetAgentTask` has no NER arm; N mapped NER to the invoke-shaped snippet at the call site (correct, same route). A NER-specific `{ entities }` example is a docs nicety, not a gate | after merge, if time |
| `packages/workflow-contract/src/index.ts`, `interpreter/nodes/core.py` | the only N ∩ R overlaps, both by contract (disjoint hunks). Merge N first; resolve R's side against N's landed lines | with the R merge |

Also carried to merge time:

- **Drop every lane's `.lane-report.md`** — a wave-3 scratch artifact, committed on purpose so a
  kill could not lose it. P, R, S and K each have one; none belongs on `dev-2.2`.
- **Test infra** (`:5433`) was down for the whole wave, which is why lane P's one integration test
  file could not `$connect()`. Brought up by the orchestrator; the post-merge gates need it seeded.
- **Disk is at 98 % (≈21 GiB free).** The step-3 dev-DB reset + reseed and the five-artifact
  regeneration both want headroom; check before the reset rather than after it fails.

Orchestrator sequence after the lanes report:

1. Merge in the order **N → P → R → S → K** (N first so the enum exists for everything after;
   S after R so the registry checksum is final before regeneration), re-running the affected gates
   after each merge.
2. `pnpm install` if lockfiles moved; `pnpm db:generate`; apply the NER migration to dev + test DBs;
   `pnpm --filter @arcaai/database seed:regen:workflows`; five artifacts; `pnpm build:packages`.
3. Reset + seed the dev DB (owner consent text from TASK-890 applies: "you must reset dev
   database"), start the stack (`stack-dev` launch config), load `gemma-4-e2b-it-qat` in LM Studio.
4. **Local tests (ask #2 gate):** Global `realtime-transcription` streams; `general-medicine-consultation`
   runs end to end through the API plane (`POST /workflows/…/runs?mode=stream`) and through a
   consultation; the promotion round-trip Global → SYSTEM → a fresh tenant via `reference-set/sync`.
5. **ArcaAI gate (ask #3):** three department workflows picked at random, run to a decided review.
6. SDK publish (GitHub Packages, from this machine) + `SDK-3.1.0` tag; then TASK-931's ALaaS update.
7. Docs: this README §6, TASK-893 §6, TASK-931 §6, changelogs, release notes, rule amendments
   (00 §content-vs-config unchanged; 05 imperative-check table gains the promotion routes; 08 SDK).

---

## 5. Open Questions for the owner

| # | Question | Working assumption |
|---|---|---|
| Q-1 | D-1 supersedes the 2026-09-04 "LLM/ASR/TTS only" agent note. Confirm. | Yes — the brief names a NER agent with provider + model. |
| Q-2 | D-2 keeps the guardrail model platform-chosen (OD-R). If a tenant must pick its own PII model, that is a guardrail agent task — a separate ticket. | Platform-chosen. |
| Q-3 | The ALaaS `.npmrc` files (both apps) commit a live GitHub token; the owner must rotate it — no agent can. | Reported in TASK-931; the token is replaced by `${GITHUB_TOKEN}` interpolation there. |
| Q-4 | `~/.zshrc:149` still exports the exFAT `HF_HOME`; `.env.dev:1651` likewise. The launch config overrides it for the stack only. | Left as is; flagged again. |

---

## 6. Implementation Summary

_Pending — filled at close with per-lane evidence, merge commits, gates and the local test log._

---

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-08 (wave 3, S) | Lane S reported DONE on its opus resume and was verified; the legacy-slug punch-list row corrected to the constant's real home; the post-R `seed:regen:workflows` dependency recorded. Only R outstanding. |
| 2026-09-08 (wave 3, later) | P, N, K reported (§4.3) and were verified against their trees — all merge clean. The two fable lanes (R, S) hit that model's session limit mid-step with substantial committed progress; both resumed on opus. Owner ruling recorded on the PHI egress grep-gate (§4.4). Test infra brought up. |
| 2026-09-08 (wave 3) | Prior session's artifacts reviewed; measured per-lane state recorded in §4.1 (R and S effectively unstarted, N and K resuming from one commit each, P holding ~1 000 uncommitted lines). Five lanes relaunched from the same worktrees under a new account budget, tiers R/S `fable` · N/P/K `opus`, with a `RESUME.md` commit-discipline addendum. Lane A still held to after the publish. |
| 2026-09-08 (later) | Six lanes spawned (R N P S K + A); all six killed by the account spend limit (HTTP 429, limit resets Sep 11) — N and K after one commit each, the rest before committing; all six relaunched/resumed. Lane log §4.1, contract amendments A-1..A-6 §4.2 (applied to `INTERFACES.md`). |
| 2026-09-08 | Created from the owner's four-part brief. Five discovery lanes measured the current state (§2); ten decisions recorded (§3); five-lane plan with a written contract (`INTERFACES.md`). Status `In Progress`. |
