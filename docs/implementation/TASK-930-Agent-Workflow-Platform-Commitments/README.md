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
| R | TASK-893 | `../hope-v2-t893-r` · `task-893-retire` | fable | waves 1+2 both died before writing anything — **zero commits, clean tree**. Wave 3 starts the lane from the base with INTERFACES §7 as the design of record |
| N | TASK-930 | `../hope-v2-t930-n` · `task-930-ner-plane` | opus | `66241bb57` (enum + migration + domains enum) and `96a4af2d1` (NER contract in `agent-schemas.ts` + tests) landed; `packages/types/src/agent.ts` (A-5 widening) left UNCOMMITTED. Wave 3 **resumes**: commit that file first, then §2.4 invocation, §3 scopes, §4 ticket, §5 outputSchema, §2.5 console |
| P | TASK-930 | `../hope-v2-t930-p` · `task-930-promotion` | opus | zero commits, but wave 2 left ~1 000 uncommitted lines under `packages/applications/src/services/agentPromotion/` (service + interface + DTO + test). Wave 3 **commits that first**, then judges it against §6 and adds the controller/module, §6.2 409 check, §6.3 reference set, §6.4 console |
| S | TASK-930 | `../hope-v2-t930-s` · `task-930-seeds` | fable | `eeb232436` carries the §2.1 enum line only (no migration, by contract). Both waves died during reading — the seed rebuild itself is unstarted. Wave 3 works against a throwaway `hope_seed_930` DB |
| K | TASK-931 | `../hope-v2-t931-k` · `task-931-sdk` | opus | `cf62eff3d` (`SDK_VERSION` from `package.json`) landed; changesets + `.gitlab/ci/publish.yml` + CHANGELOG left UNCOMMITTED. Wave 3 **resumes** against the A-1 ticket shape |
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
| 2026-09-08 (wave 3) | Prior session's artifacts reviewed; measured per-lane state recorded in §4.1 (R and S effectively unstarted, N and K resuming from one commit each, P holding ~1 000 uncommitted lines). Five lanes relaunched from the same worktrees under a new account budget, tiers R/S `fable` · N/P/K `opus`, with a `RESUME.md` commit-discipline addendum. Lane A still held to after the publish. |
| 2026-09-08 (later) | Six lanes spawned (R N P S K + A); all six killed by the account spend limit (HTTP 429, limit resets Sep 11) — N and K after one commit each, the rest before committing; all six relaunched/resumed. Lane log §4.1, contract amendments A-1..A-6 §4.2 (applied to `INTERFACES.md`). |
| 2026-09-08 | Created from the owner's four-part brief. Five discovery lanes measured the current state (§2); ten decisions recorded (§3); five-lane plan with a written contract (`INTERFACES.md`). Status `In Progress`. |
