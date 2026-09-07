# TASK-891 — Realtime Consultation Scribe: language selection, incremental case note, reasoning control

| Field | Value |
|---|---|
| **Status** | `In Progress` — Wave 1 running, five writers spawned 2026-09-07 |
| **Type** | `bugfix` + `feature` |
| **Branch** | `dev-2.2` |
| **Raised** | 2026-09-07, from a live diagnosis of consultation `01a07ae9-2497-7858-bb07-39f38d5ffed3` on `hope-v2-dev` |
| **Deployed commit under diagnosis** | `c24648e4e` (pipeline #1130) — identical to local `dev-2.2` HEAD, so every code reference below is what is actually running |

---

## 1. Requirement Analysis

### 1.1 What the owner asked for (2026-09-07)

> For realtime consultation scribe playground it should:
> * allow user (end-user or frontend developer) to select language, if no language is selected/declared, by default it use english.
> * allow user (end-user) to see realtime case note (incremental-updating-summarization using a pre-defined template set in each workflow depends on selected department (as-tag) and visit-type (as-tag)).
> * keep incremental update the case note and display those details when consulting (realtime consultation transcription/realtime summarization, highlight the NER detected information and details, etc, depends on selected workflow).
> * allow tenant admin to control reasoning/thinking (enable or disable, reasoning effort if any).
> * remove the un-used dropdowns: Transcription Agent, Note assistant, Writing style!

### 1.2 Decomposition

| Id | Requirement | Kind |
|---|---|---|
| **R1** | Language is selectable by the end user AND by an SDK caller. Absent any declaration the session stays **code-switch** (empty = the agent's mode) — *revised by the owner, see OD-1* | feature + defect |
| **R2** | The realtime case note renders and updates **incrementally**, section by section, off a template the **workflow** predefines, selected by **department** and **visit-type** tags | feature (machinery exists, never runs) |
| **R3** | The case note keeps updating during the consultation and shows the workflow's other realtime output — NER highlights, findings, corrections | defect (all of it is built; all of it fails) |
| **R4** | Tenant admin controls reasoning/thinking: on/off, and effort where the engine supports it | feature (transport exists, no control surface) |
| **R5** | Remove the Transcription Agent, Note assistant and Writing style dropdowns from the scribe footer | chore |
| **D1–D7** | The defects found in diagnosis that block R1–R3 (§2.6) | bugfix |

### 1.3 Explicit non-goals

- No change to the durable harness/Temporal finalisation path. This ticket is the **realtime** lane only.
- No new inference stack, no new provider adapter (`06-python-services.md` §"Do not grow a second inference stack").
- No cluster manifest edits in this repo — the four deployment-side changes (§4.6) belong in `arca/hope-v2-deployment`.

---

## 2. Current State Evaluation

Everything in this section was measured on the live dev cluster on 2026-09-07, not inferred from code.

### 2.1 The realtime lane starts correctly and then fails every flush

Gateway log for the traced session:

```
08:08:56  Live documentation session started
08:08:56  Froze the live document template — templateId: null, slug "soap_note", versionNumber: null
08:08:56  Froze the realtime lane — laneSource "tenant-graph",
          definitionSlug "arcaai-consultation-medical-ner", stageCount 3

08:16:09  WARN Realtime lane node degraded  n_realtime  consultation.realtimeSummary
               reason: "timeout of 20000ms exceeded"
08:16:09  WARN Realtime lane node degraded  n_entities  consultation.extractEntities
               reason: "connect ECONNREFUSED 10.43.207.213:8864"
08:16:09  Live summary flush  flushCount 1  textFailed true  nlpFailed true
               sectionCount 0  summaryChars 0  staleDropCount 38

08:19:27  (identical)        flushCount 2                    staleDropCount 53
08:19:27  Live documentation session stopped
```

**55 flush generations in 10½ minutes; 53 dropped as stale, 2 completed, both produced zero
sections.** Nothing was ever published to `consultation:live-summary:{id}`. `core."DocumentSection"`
holds **0 rows** cluster-wide — the incremental plane has never once produced output.

The console is not at fault: both Redis subscriptions (`consultation:live-summary:{id}` and the
`…:co…` sibling) were established at 08:08:56 and the SSE stream stayed open for the whole session.
It is a correctly-wired consumer of an empty producer. `case-note-column.tsx:120` renders
`state === 'empty'` as a `<Skeleton />`, which is the spinner the owner sees.

### 2.2 R1 — why an English recording transcribed as Malayalam

The `ResolvedAsrSpec` persisted at `stt:session:01a07ae9-c4dc-…`:

```
asr model : arcaai-whisper-large-ml-en-gguf
sourceUri : taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF
metadata  : maxDecodeWindowSec 7, partialWindowSec 6
decoding  : languageMode "ml-en", codeSwitching true, wordTimestamps true, beamSize 5, temp 0
instruction.initialPrompt: "…English and Malayalam medical terminology."
```

Three compounding causes:

1. The seeded platform default agent (`25-agents.ts:106`, `platform-transcription`) is a
   **Malayalam/English code-switch full fine-tune**, and `languageMode: 'ml-en'`.
2. `resolve_mode_for_engine` deliberately does **not** pin a language for a code-switch pair on
   `WHISPER_CPP` — it returns `language = None`, i.e. free auto-detect
   ([`language_modes.py:341-352`](../../../apps/stt/src/stt/pipeline/language_modes.py)).
3. The one compensating signal is **switched off**: `WHISPER_CPP_PRIMING_PROMPT_ENABLED = False`
   ([`language_modes.py:214`](../../../apps/stt/src/stt/pipeline/language_modes.py)). Verified in
   the running pod (`priming_prompt_enabled= False`).

So the decoder receives no language signal at all. Worse, `__call__` splits every utterance into
≤7 s spans and decodes each **independently** ([`whisper_cpp_asr.py:361`](../../../apps/stt/src/stt/streaming/whisper_cpp_asr.py)),
so language auto-detect re-runs per chunk — which is why one sentence comes back half Malayalam,
half English.

The console *has* a language picker (`SttLanguageModePicker`, wired at
[`consultation-demo-screen.tsx:456`](../../../apps/admin-console/src/features/playground-consultation/components/consultation-demo-screen.tsx))
but it initialises to `''`, and empty means "no opinion" → the agent's `ml-en` wins. **There is no
English default anywhere in the chain.**

### 2.3 R1 (second half) — finals lose 65–80% of the words

Measured over the 87 stored `TranscriptSegment` rows. Continuous speech runs ~13–16 chars/s:

| utterance | duration | chars | chars/s |
|---|---|---|---|
| idx 4 | 16.99 s | 70 | 4.1 |
| idx 8 | 12.93 s | 71 | 5.5 |
| idx 18 | 12.16 s | 21 | 1.7 |
| idx 20 | 13.22 s | 38 | 2.9 |
| idx 36 | 6.08 s | 5 | 0.8 |

The ratio degrades with utterance length, which points at the 7 s chunking: a span that decodes to
nothing contributes nothing to `_merge_results`' join. Compounding it, the agent sets
`wordTimestamps: true`, which forces `max_len=1, split_on_word=True` — the adapter's own comment
calls this *"a lossy, script-corrupting hack"* causing *"space-joining corruption of
non-space-delimited scripts (Malayalam)"* ([`whisper_cpp_asr.py:500-505`](../../../apps/stt/src/stt/streaming/whisper_cpp_asr.py)).
The orphaned combining marks in the output (`ൽ`, `ും`, `്ട്`) are that corruption, visible.

`partialWindowSec` (6) ≠ `maxDecodeWindowSec` (7), which
[`session_manager.py:433`](../../../apps/stt/src/stt/streaming/session_manager.py) says must match
"so the last partial and the final decode the SAME audio". They don't — this is the mechanical
reason a good-looking draft is replaced by a shorter final.

### 2.4 R2/R3 — the template is resolved on the wrong axis

`ensureTemplateResolved` calls `this.documentTemplateService.resolveForGeneration(session.tenantId)`
— **tenant id only**
([`live-documentation.service.ts:1072`](../../../packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts)).
The method accepts an optional `slug` second argument that nothing passes. There is no department
axis, no visit-type axis, and no read of the governing workflow's node config, even though the
lane resolver already knows all three. The traced session logged `templateId: null` — it fell
through to `PLATFORM_TEMPLATE`.

`core."DocumentTemplate"` columns are `_metadata, _version, id, tenantId, slug, name, description,
status, pinnedVersionNumber, isDefault, sourceTemplateSlug, templateLocked, …`. **There is no
`tags` column**, so tag-based selection needs a schema addition (§3.2, OD-2).

Note the precedent already exists one layer up:
`AgentAssignmentService.resolve(tenantId, task, departmentId, selectorTags)` implements exactly the
requested shape — department → tenant tier order, and within each tier a `key:value` selector
subset match, most specific first, unqualified last
([`agent-assignment.service.ts:60-85`](../../../packages/applications/src/services/agent-assignment/agent-assignment.service.ts)).
`WorkflowAssignment` has `scope`/`scopeId` (TENANT | DEPARTMENT) but **no selector tags**.

Visit type is a fixed platform catalogue of two — `new-visit`, `revisit`
([`visit-type.catalogue.ts:84`](../../../packages/applications/src/services/consultation/visit-type/visit-type.catalogue.ts)).
TASK-882 deliberately retired the tenant-managed catalogue and TASK-884 replaced the
`(task, visitType) → prompt` binding with `Agent.tags`. Expressing visit-type as a selector tag is
consistent with that; re-introducing a tenant-managed visit-type catalogue would reverse it (OD-3).

### 2.5 R4 — the transport exists, the control surface does not

`GenerateRequest.extra` is already declared on the text service and forwarded as `extra_body` to
the OpenAI-compatible family, and the field comment names `reasoning_effort` as its example
([`apps/text/src/text/models/requests.py:270-275`](../../../apps/text/src/text/models/requests.py)).
It is populated by the gateway's `applyTextRuntimeProfile` from `AiRuntimeProfile.extraJson`, which
`live-documentation.service.ts` already calls at three call sites (3605, 3688, 3790). The providers
already split `reasoning_content` from `content` and meter it separately
(`providers/openai.py:203-225`).

So R4 needs **no new transport** — it needs a governed, tenant-writable descriptor and a UI, plus
the platform default flipped. Measured cost of the current default:

| probe (cluster idle) | wall | completion tokens | reasoning tokens |
|---|---|---|---|
| `"hello"` | **1.37 s** | 50 | **35 (70%)** |
| SOAP note, 136-token transcript | **14.06 s** | 538 | **422 (78%)** |

14 seconds at idle on a toy input, against a hard-coded 20 s budget. On a real transcript with
Whisper competing for the GPU, LM Studio's own log shows 20–52 s per flush.

### 2.6 Defect register

| Id | Defect | Evidence | Blocks |
|---|---|---|---|
| ~~D1~~ | ~~No English default~~ — **withdrawn under OD-1.** Empty *is* the intended default; code-switch is always on unless a language is declared | — | — |
| **D2** | Code-switch has **no bias correction**: `ml-en` on whisper.cpp pins no language, and `WHISPER_CPP_PRIMING_PROMPT_ENABLED = False` suppresses the bilingual priming prompt the pair mode depends on — so it is free auto-detect, re-run independently per 7 s chunk | `language_modes.py:341`, `:214`; verified in-pod | R1 |
| **D2b** | An **explicitly declared** language is never proven to reach the decoder end-to-end (picker → SDK → gateway → `ResolvedAsrSpec` → `whisper.cpp language=`). No test covers the declaration path | §2.2 | R1 |
| **D3** | Finals lose 65–80% of words: 7 s chunking + `wordTimestamps: true` forcing `max_len=1` script corruption; `partialWindowSec` ≠ `maxDecodeWindowSec` | §2.3 | R1 |
| **D4** | `LIVE_DOC_TEXT_TIMEOUT_MS` unset → 20 s default; every realtime summary call exceeds it | `live-documentation.service.ts:778`; probe §2.5 | R2, R3 |
| **D5** | `hope-nlp` readiness probe (`timeoutSeconds: 1`, `failureThreshold: 2`, cpu limit 2) fails **44×** under its own NER load and drops out of Service endpoints → `ECONNREFUSED` for the gateway | kubelet events 08:09:46→08:19:50 | R3 |
| **D6** | 53 of 55 flushes discarded by `isStale()` — flush cadence and model latency are mismatched, so even a successful call rarely survives | §2.1 | R2, R3 |
| **D7** | `hope-secrets` has **no `INTERNAL_ACCESS_TOKEN` key**; `hope-text`'s outbound gateway calls 401, so `effective_config.last_refresh_ok = false` and it runs with zero control-plane config. Its inbound auth is silently bypassed for the same reason (`accepted_service_tokens` returns empty) | probe: all 4 tokens in the pod 401 against `/internal/effective-config` | R4 (a tenant setting cannot reach TEXT), security |

Two further findings, in scope to record but not to fix here: `hope-text` emits **no request logs
at all** since startup (07:17), and LM Studio loads `gemma-4-e2b-it-qat` with
`loaded_context_length: 8192` against a `max_context_length` of 131072.

---

## 3. Owner decisions — ANSWERED 2026-09-07

### OD-1 — Default language: **EMPTY, not English** ✅ *(revised by the owner)*

> "default language is empty (so the code-switch is always enabled), to use a specific language,
> the SDK or end-user must declare the language code!"

The platform default stays the agent's code-switch mode. **There is no English default and none is
to be introduced.** A specific language is reached only by an explicit declaration from the SDK
caller or the end user.

This **reverses the framing of §2.2**: Malayalam output on an English recording is the *expected*
behaviour of an undeclared code-switch session, not a bug in itself. What *is* a bug is that the
code-switch path has no bias correction at all, because `WHISPER_CPP_PRIMING_PROMPT_ENABLED = False`
kills the bilingual priming prompt that pair modes depend on
([`language_modes.py:214`](../../../apps/stt/src/stt/pipeline/language_modes.py)). D2 is therefore
re-scoped from "add an English default" to **"make code-switch actually work, and make an explicit
declaration actually pin the language"**. D1 is withdrawn.

### OD-2 — Template selection: **no new table** ✅ *(owner challenged the proposal; the challenge is correct)*

The originally-proposed `DocumentTemplateAssignment` model was unjustified. Re-reading the
requirement — *"a pre-defined template set in **each workflow**, depends on selected department
(as-tag) and visit-type (as-tag)"* — the three pieces already exist:

| Axis | Where it already lives | Gap |
|---|---|---|
| **Template** | the workflow itself. Realtime node `config` is `Readonly<Record<string, unknown>>` — free-form JSON on the definition graph ([`realtime-lane.ts:52`](../../../packages/applications/src/services/consultation/live-documentation/realtime/realtime-lane.ts)) | nothing reads a template slug from it |
| **Department** | `WorkflowAssignment.scope = DEPARTMENT, scopeId = departmentId` | none — already works |
| **Visit-type** | — | `WorkflowAssignment` has no tag selector |

And `resolveForGeneration(tenantId, slug?)` **already accepts the slug** — nothing passes it
([`document-template.service.ts:354`](../../../packages/applications/src/services/document-template/document-template.service.ts)).

So the whole requirement is **one column, one migration, and three wire-ups**:

1. `WorkflowAssignment.selectorKey String @default("")` — a byte-for-byte copy of
   `AgentAssignment.selectorKey` ([`agent.prisma:224-231`](../../../packages/database/src/prisma/db_main/agent.prisma)),
   extending the existing `@@unique` to `[tenantId, scope, scopeId, paletteKey, selectorKey]`.
   No new model, no new domain trio, no new `ResourceType` value.
2. Workflow assignment resolution reuses `canonicalAgentTags` / `agentTagsSatisfy` from
   `@arcaai/workflow-contract` — the same matcher `AgentAssignmentService.resolve` already uses.
3. The `consultation.realtimeSummary` node config carries `documentTemplateSlug`, and
   `ensureTemplateResolved` passes it into the parameter that already exists.

### OD-3 — Visit-type stays the fixed platform pair ✅

`new-visit` / `revisit` ([`visit-type.catalogue.ts:84`](../../../packages/applications/src/services/consultation/visit-type/visit-type.catalogue.ts)),
expressed as the reserved selector tag `visit-type:new-visit` / `visit-type:revisit`. TASK-882's
retirement of the tenant-managed catalogue stands.

### OD-4 — Reasoning control: **per-agent `parameters` block** ✅

> "Per-agent parameters block"

`Agent.parameters.generation.reasoning = { enabled, effort }`, resolved per agent and merged into
`GenerateRequest.extra` on the existing `applyTextRuntimeProfile` path. No governed descriptor, no
new transport. Each agent's reasoning posture is authored with the agent, which is consistent with
the agent already owning `temperature`, `maxTokens` and `responseFormat`.

Still to confirm during build: "disabled" is implemented as *instruct the engine not to reason*
(`reasoning_effort: "minimal"` / the engine's own off switch), **and** `reasoning_content` keeps
being dropped from the note text as it is today.

### OD-5 — No dropdowns at all ✅

> "As the workflow combines agents including summarization (partial and finalize) and DNA writing
> style redaction agent (user must create a DNA writing style report first, the report will be
> instructions/rules for finalized case-note redaction), I dont think we need any dropdown!"

All three go. The workflow is the single selector: it names the ASR agent, the partial- and
finalize-summarization agents, and the **DNA writing-style redaction agent** whose instructions come
from a DNA writing-style report the user must author first. Consequently `agentChoice`,
`noteModels` and `dnaStyleId` are all deleted from the console, and `audio.start()` / generate stop
sending them — the assignment cascade and the workflow decide.

> **Follow-up to confirm (F-1):** the DNA redaction agent applies at **finalize**, not on the live
> flush. This ticket keeps the live case note un-redacted and leaves redaction on the finalize path.
> Say if you want redaction applied live too — that is a different lane.

### OD-6 — LM Studio 8192 context — noted, deployment-side

`gemma-4-e2b-it-qat` is loaded at 8192 of a possible 131072. Out of scope for this repo; tracked as
F4 in Lane F.

---

## 4. Implementation Plan

Ordered by the layer chain in `01-development-workflow.md`. Lanes A–C are independent and can run
in parallel worktrees; D depends on B; E is client-only; F is the deployment repo.

### Lane A — STT declaration path and decode correctness (D2, D2b, D3 → R1)

**Empty stays empty** (OD-1). Nothing in this lane introduces a default language.

| # | Change | File | Verify |
|---|---|---|---|
| A1 | RED: end-to-end declaration test — picker/SDK `languageMode: 'en'` ⇒ the persisted `ResolvedAsrSpec.decoding.languageMode` is `en` ⇒ the adapter receives `language="en"`. And: **absent** declaration ⇒ the agent's `ml-en` survives untouched | `apps/stt/tests/`, `packages/applications/.../__tests__/` | both fail, then pass |
| A2 | Fix whatever A1 exposes on the declaration path (`AsrAgentResolverService` → `ResolvedAsrSpec` → `resolve_mode_for_engine` → `_decode_capturing(language=…)`) | as located by A1 | A1 green |
| A3 | Re-enable the **bilingual** priming prompt for pair modes — the code-switch bias correction that is currently off. Prefer decoupling the flag (pair prompt on, single prompt independently switchable) over a blanket `True`, so each can be evaluated on its own | `apps/stt/src/stt/pipeline/language_modes.py:214` | prompt asserted in the `ml-en` resolution test |
| A4 | Set `wordTimestamps: false` on the seeded ASR agent, and make the adapter refuse `max_len=1` when the decode may emit a non-space-delimited script — the adapter's own comment calls it script-corrupting | `seed/25-agents.ts:106`, `whisper_cpp_asr.py:500` | chars/s ratio on a fixture recording |
| A5 | Align `partialWindowSec` with `maxDecodeWindowSec`, and raise the decode window toward the model's real context so a 19 s utterance is not three blind 7 s decodes | `AiModel._metadata.asr` for `arcaai-whisper-large-ml-en-gguf` | last partial and final decode identical audio |
| A6 | Console: keep the picker's empty default; label the empty option honestly (e.g. "Auto (code-switch)") so "no selection" reads as a choice, not as a missing one | `consultation-demo-screen.tsx:239`, `scribe-footer.tsx` | both themes, axe clean |

> **A3 re-enables a prompt that was deliberately switched off to evaluate quality on this exact
> `ml-en` fine-tune.** Gate it on a measured comparison over a held-out English recording *and* a
> held-out Malayalam recording. If code-switch quality regresses, ship A4/A5 alone and leave the
> flag off — those two are independently worth the ~3–5× recovery in captured words.

### Lane B — Make the realtime lane actually complete (D4, D6 → R2, R3)

| # | Change | File | Verify |
|---|---|---|---|
| B1 | Promote `LIVE_DOC_TEXT_TIMEOUT_MS` from a raw env read to a governed descriptor (`consultation.realtime.textTimeoutMs`, `global-kv`, `open-to-default`), default **60000** | `live-documentation.service.ts:778`, `settings-registry/descriptors/` | descriptor registered; default asserted |
| B2 | RED: a flush whose generation exceeds the *previous* flush's cadence must not be discarded when it is the only in-flight generation | `live-documentation/__tests__/` | test fails |
| B3 | Fix the stale-drop starvation: gate the next generation on the previous one **completing** (single-flight per session) instead of firing on every transcript delta, so a slow model degrades cadence rather than producing nothing. Keep `isStale()` for genuine supersession | `live-documentation.service.ts` | 53/55 → 0 dropped in the harness test |
| B4 | Surface `staleDropCount`, `textFailed` and node-degrade reasons on the live-doc admin DTO so this is visible without reading pod logs | `dto/live-doc-admin.dto.ts` | admin screen shows them |
| B5 | Emit a `section.patch` with `state: 'empty'` **and a degrade reason** when a node fails, so the console can distinguish "still thinking" from "generation failed" — today both render as a skeleton (`case-note-column.tsx:120`) | `realtime/section-store.ts`, `dto/section-patch.dto.ts` | console shows an honest state |

### Lane C — Reasoning/thinking control (D7 → R4)

Per OD-4 this is a **per-agent `parameters` block**, not a settings descriptor.

| # | Change | File | Verify |
|---|---|---|---|
| C1 | Extend the agent `parameters` schema with `generation.reasoning = { enabled: boolean, effort?: 'minimal'\|'low'\|'medium'\|'high' }`, validated on the agent write DTOs | `packages/applications/src/services/agent/**` | write DTO rejects an unknown effort |
| C2 | Merge the resolved agent's reasoning block into `GenerateRequest.extra` on the existing `applyTextRuntimeProfile` path — `extra` is already declared and already forwarded as `extra_body` to the OpenAI-compatible family | `text-request-enrichment`, `live-documentation.service.ts:3605/3688/3790` | payload asserted in a unit test |
| C3 | Seed the platform agents with `reasoning.enabled: false` for the **realtime** tier (78% of the token budget is reasoning, and the note is JSON-shaped); leave the finalize tier as-is | `seed/25-agents.ts` | seed test |
| C4 | Admin console: the reasoning toggle + effort live on the **agent editor**, next to temperature/maxTokens | `apps/admin-console/src/features/...` | both themes, axe clean |
| C5 | Assert `reasoning_content` never reaches `parseDocumentJson` (already true — LM Studio returns it as a separate field; make it a locked contract) | `live-documentation/__tests__/` | test |

> C2's per-request `extra` path works regardless of D7. But until `hope-text` can read its effective
> config (Lane F1), its lane budgets and moderation posture stay unconfigured — so fix F1 anyway.

### Lane D — Template from the workflow, selected by department + visit-type (R2)

Per OD-2: **one column, no new model.** Department already works; only the visit-type selector and
the template wire-up are missing.

| # | Change | File | Notes |
|---|---|---|---|
| D1 | Add `selectorKey String @default("")` to `WorkflowAssignment`, extending `@@unique` to `[tenantId, scope, scopeId, paletteKey, selectorKey]` | `workflow-assignment.prisma` | byte-for-byte copy of `AgentAssignment.selectorKey` (`agent.prisma:224-231`). `map:` names the DB index — **not** `name:` (rule 02 §@@unique) |
| D2 | Migration authored against a throwaway shadow DB, `task_891_workflow_assignment_selector`; prove `migrate diff` is empty afterwards | `db_main/migrations/` | never stage an unapplied folder under `migrations/` |
| D3 | `pnpm gen:model`; hand-edit the existing `WorkflowAssignment` entity/factory/mapper/repository for the new field; `gen:entity` + `gen:factory` to reconcile | `packages/domains` | **do not run `gen:mapper`** — it is destructive |
| D4 | Workflow assignment resolution gains selector-tag matching, reusing `canonicalAgentTags` / `agentTagsSatisfy` from `@arcaai/workflow-contract` — the same walk `AgentAssignmentService.resolve` performs | workflow-assignment service | most-specific-first, unqualified last |
| D5 | Dispatch passes the consultation's visit type as the reserved tag `visit-type:<key>` | consultation open / lane resolver | `new-visit` \| `revisit` |
| D6 | `consultation.realtimeSummary` node config carries `documentTemplateSlug` | workflow definition data | node `config` is already `Record<string, unknown>` — **no schema change** |
| D7 | `ensureTemplateResolved` reads that slug from the frozen lane and passes it to `resolveForGeneration(tenantId, slug)` — the parameter already exists and nothing passes it today | `live-documentation.service.ts:1072` | this is the actual fix for `templateId: null` |
| D8 | Seed: give the SYSTEM reference workflows a `documentTemplateSlug` and a visit-type-qualified assignment pair; cloned to tenants by `TenantReferenceSetService` | `seed/` | content is cloned, configuration cascades |
| D9 | Admin CRUD for the selector + regeneration of **all five artifacts together** (`api:build`, `route-manifest`, `openapi`, `portal`, `gen:admin`) | `apps/api`, `packages/vox-node` | `05-nestjs-api.md` DoD |

No new `ResourceType` value is needed — `WorkflowAssignment` already has one.

### Lane E — Scribe footer cleanup (R5)

Per OD-5: **all three dropdowns go**, language picker stays. The workflow is the single selector —
it names the ASR agent, the partial/finalize summarization agents and the DNA writing-style
redaction agent.

| # | Change | File |
|---|---|---|
| E1 | Delete the `Transcription agent`, `Note assistant` and `Writing style` blocks and their props | `scribe-footer.tsx` |
| E2 | Delete the orphaned `agentChoice`, `noteModels`, `noteModelName`, `dnaStyleId` state and the `useSelectableAsrAgents` / `useDnaStyleOptions` calls | `consultation-demo-screen.tsx:235,243,612,640-651` |
| E3 | `audio.start()` stops sending `agentSlug`; generate stops sending `dnaStyleId` — both fall to the server-side cascade | `consultation-demo-screen.tsx:456,536` |
| E4 | Update the affected tests | `.../scribe/__tests__/`, `.../components/__tests__/` |

Per `_karpathy.md` §3, remove only what these changes orphan — leave `useSelectableAsrAgents` /
`useDnaStyleOptions` themselves in place if any other screen reads them.

### Lane F — Deployment repo (`arca/hope-v2-deployment`) — *not this repo*

| # | Change | Fixes |
|---|---|---|
| F1 | Add `INTERNAL_ACCESS_TOKEN` to the `hope-secrets` Secret (it is Argo-unmanaged — a hand-applied prerequisite) and stop referencing it `optional: true` in stt/nlp/text | D7 |
| F2 | `hope-nlp` probes: `timeoutSeconds 1 → 5`, `readiness failureThreshold 2 → 3`; raise the CPU limit above 2 | D5 |
| F3 | Set `LIVE_DOC_TEXT_TIMEOUT_MS` on the api Deployment until B1's descriptor ships | D4 |
| F4 | Raise LM Studio's loaded context above 8192 | OD-6 |

F1–F3 are a fast unblock: applied alone, they should turn the case note from "never renders" into
"renders slowly", before any code in this repo changes. **Recommend doing Lane F first** so the
rest of the work can be verified against a cluster that is not failing for unrelated reasons.

---

## 5. Verification Criteria

| Gate | Command / evidence |
|---|---|
| Domain | `pnpm --filter @arcaai/domains build test` |
| Applications | `pnpm --filter @arcaai/applications build test` |
| API | `pnpm api:build`, `pnpm test:unit`, `pnpm test:e2e`, `pnpm api:route-manifest` + the other four artifacts, `pnpm api:openapi:check` / `api:portal:check` / `gen:admin:check` |
| STT | `pnpm stt:test`, `pnpm stt:lint`, `pnpm stt:typecheck` |
| Text | `pnpm text:test`, `pnpm text:lint`, `pnpm text:typecheck` |
| Console | `pnpm --filter @arcaai/admin-console build lint test`; both themes; axe 0 violations |
| Boot | paste a `/health` line — a silent admin-route defect refuses API startup |
| **Runtime** | one recorded consultation on `hope-v2-dev` showing: language `en` honoured, `DocumentSection` rows > 0, `staleDropCount` 0, `sectionCount` > 0, NER highlights rendered, and the case note updating section-by-section |

The runtime gate is the real one. Every unit test in this ticket can pass while the feature stays
broken — that is exactly what happened to the section-patch plane, which is fully built, fully
tested, and has produced zero rows in production.

Per `01-development-workflow.md` §Test Scope Exclusions, `apps/compat-playground`,
`apps/quick-compat-app` and `packages/ui` suites are out of scope unless the change is inside them.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| A3 re-enables a prompt that was disabled for measured quality reasons on this exact fine-tune | Gate on a held-out English **and** Malayalam recording; ship A4/A5 without A3 if it regresses |
| B3 changes flush cadence semantics under a clinician's live note | Single-flight only; `isStale()` retained for genuine supersession; CONFIRMED sections still never overwritten |
| D1 changes a `@@unique` on a live table | Additive column with a `""` default, so every existing row keeps its identity; migration proven on a shadow DB with an empty `migrate diff` afterwards |
| Removing the ASR-agent picker (OD-5) removes the only in-app way to demo a non-default engine | Owner-decided; the workflow and the admin console still select it |
| Reasoning off may degrade note quality | Per-agent (OD-4), so it is reversible per agent without a deploy and never global |
| Whisper and LM Studio contend for the same time-sliced GPUs | Out of scope here, but it is why B1's timeout must be generous rather than tight |

---

## 7. Execution — worktree partition, tiers, waves

### 7.1 Why the A–F lanes cannot be the parallel unit

The §4 lanes are a *feature* decomposition. As a *writer* decomposition they collide, and
`14-multi-agent-worktrees.md` §3 is explicit: **one writer per file, per branch — if two tasks would
touch the same file they are ONE task.**

| Contended file | Drafted lanes that write it |
|---|---|
| `live-documentation.service.ts` (4265 lines) | B1–B5, C2, C5, D7 |
| `seed/25-agents.ts` | A4 (wordTimestamps), C3 (reasoning defaults) |
| `consultation-demo-screen.tsx`, `scribe-footer.tsx` | A6 (language label), E1–E3 |

So the parallel unit is **path ownership**, and the §4 lane ids become work items distributed
across the owners below.

### 7.2 The five writers

Each owns a disjoint path set. **Touching a file outside your boundary is a stop-and-report, never
an edit.**

| Wk | Worktree / branch | Owns (exclusive) | Work items | Tier | Effort |
|---|---|---|---|---|---|
| **W1** | `../hope-v2-task-891-stt` `task-891/stt` | `apps/stt/**` | A1(py half), A2(py half), A3, A4(adapter half) | `opus` | low → escalate on evidence |
| **W2** | `../hope-v2-task-891-livedoc` `task-891/livedoc` | `packages/applications/src/services/consultation/live-documentation/**`, `.../services/agent/**`, `.../services/text-request/**` | B1–B5, C1, C2, C5, D7 | `opus` | **high** |
| **W3** | `../hope-v2-task-891-data` `task-891/data` | `packages/database/**`, `packages/domains/**`, `packages/applications/src/services/workflow-assignment/**` | D1–D5, D8, C3, A4(seed half), A5 | `sonnet` | high |
| **W4** | `../hope-v2-task-891-console` `task-891/console` | `apps/admin-console/**` | E1–E4, A6, C4 | `sonnet` | medium |
| **W5** | `arca/hope-v2-deployment` (separate repo, no worktree) | `deployment/k8s/overlays/dev/**` | F2, F3, F4 | `sonnet` | low |

**Tier rationale** (rule 14 §1 — tier per stage, never downshift the deciding stage):

- **W2 is the hardest stage in the ticket** and the one whose verdict everything else rests on:
  flush lifecycle, single-flight vs `isStale()`, per-section OCC, and the CONFIRMED-never-overwritten
  invariant, inside a 4265-line service. `opus`/`high`.
- **W1** is small but subtle — decode semantics on a fine-tune, plus a flag that was deliberately
  switched off. `opus` at the tier floor; escalate only if A2 comes back hedged.
- **W3** is exacting but mechanical: a copy of an existing column, the `gen:*` guard rules, seed
  edits. `sonnet`/`high` is right **because the deciding stage is not in the agent** — I review the
  migration SQL and I am the only one who applies it (§7.5).
- **W4** is deletion-heavy plus two small additions against a shape I fix in advance.
- **W5** is four manifest values; the risk is a bad indent, which `kustomize build` catches.

Read-only work (exploration, review) gets no worktree.

### 7.3 The contract that makes the lanes independent

Four cross-lane compile dependencies exist. Rather than serialising, **I fix the shapes up front**
and every brief quotes them verbatim — this is the whole reason the four writers can run at once:

```ts
// C1 — agent parameters, authored by W2, seeded by W3, edited by W4
parameters.generation.reasoning?: { enabled: boolean; effort?: 'minimal' | 'low' | 'medium' | 'high' }

// D6 — realtime node config key, authored by W3 (seed), read by W2 (D7)
config.documentTemplateSlug?: string

// D1 — the new column, authored by W3, consumed by W3 only
WorkflowAssignment.selectorKey: String @default("")   // canonical `key:value` csv, '' = unqualified

// D5 — the reserved selector tag
`visit-type:new-visit` | `visit-type:revisit`
```

Any writer that wants to change one of these stops and asks me. A shape drift discovered at merge
is the failure mode this section exists to prevent.

### 7.4 Waves

```
Wave 0  (me)      commit HEAD · create 4 worktrees off dev-2.2 · pnpm install in each
                  · copy .env.dev/.env.test in (they do not follow a worktree)
                  · hand F1 to the owner (a shared secret is not a subagent's job)

Wave 1  (‖ 4)     W1 · W2 · W3 · W4        ← disjoint paths, contract-first, no shared surface
        (‖ 1)     W5 in the deployment repo, independent of all of them

Wave 2  (‖ 2)     read-only reviewers, distinct lenses, no worktree:
                  R1 `opus`/high  — correctness + regression on the live-doc concurrency change
                  R2 `sonnet`/high — tenancy, 404-over-403, secret handling, generated-artifact drift

Wave 3  (me)      merge W3 → W2 → W1 → W4 into dev-2.2 from the PRIMARY checkout
                  · apply the migration · regenerate ALL FIVE api artifacts once
                  · re-run affected gates AFTER the merge · remove worktrees only then

Wave 4            deploy (GitLab CI → Argo) and run the §5 runtime gate on hope-v2-dev
```

Merge order is dependency order, not finish order: W3's column and seeds first, then W2 which reads
the shapes, then W1, then W4.

### 7.5 Shared surfaces the orchestrator keeps (rule 14 §3)

Never delegated, in any wave: `pnpm install` · `db:push` / `db:migrate` / `test:db:reset` ·
applying the migration · the five-artifact regeneration (`api:build`, `route-manifest`, `openapi`,
`portal`, `gen:admin`) · all merges · all worktree removal · any Docker/infra command · the
`hope-secrets` change (F1).

### 7.6 Standing brief clauses (every writer)

Rule 14 §2 — each spawn carries ticket + target branch + working directory + its exclusive path set
+ which `.claude/rules/NN-*.md` to read (a subagent inherits none of my context) + the exact
commands that prove success + the return contract. Plus these repo-specific hazards:

- **Never `git stash`** — the stash stack is shared repo-wide. Commit, then `git checkout HEAD~1 -- <path>`.
- **Never run `pnpm gen:mapper`** — it rewrites mappers and strips the `_version` OCC guard before crashing.
- **Never stage an unapplied folder under `migrations/`** — Prisma applies every subdirectory regardless of its name.
- **Never `pnpm install`, `db:*`, or any infra command** — report the need instead.
- W3 only: `@@unique` takes `map:` for the DB index name, not `name:`.
- W1 only: the `apps/stt` pytest conftest guard aborts a run that imports the primary checkout — that is the guard working, not a bug to delete.
- Long suites go to a log in the scratchpad and are polled, not run in the foreground (600 s no-progress watchdog).
- Evidence or it did not happen: paste real command output; "tests pass" with nothing pasted is not a result.
- Out-of-scope suites (`apps/compat-playground`, `apps/quick-compat-app`, `packages/ui`) are not gates.

## 8. Findings from Wave 1

### 8.1 W1 — A3 decided: the pair priming prompt stays OFF (decoupling only)

The brief asked W1 to re-enable the bilingual priming prompt as the missing code-switch bias
correction. **It should not be re-enabled, and the evidence is already in the repo:**

- `apps/stt/tests/integration/mlen_scorecard_baseline.json` states its own provenance: the
  committed `mean_cer 0.325` (ceiling `0.40`) was measured on *"greedy + language auto + clean
  decode"* — i.e. **with the prompt OFF and no word-split**. Turning the prompt on invalidates the
  number the platform holds itself to until it is re-measured.
- TASK-594 already flipped `WHISPER_CPP_PRIMING_PROMPT_ENABLED = True` and it was **reverted with
  owner approval** on measured evidence (prompt on injected `baş)!�` junk and broke clusters).

Two further reasons the prompt is not obviously the right correction: the bilingual template is
written **entirely in English**, and a Whisper `initial_prompt` biases output toward the prompt's
own language — so as a code-switch corrector it is not neutral; and at ~70 tokens it consumes a
third of the 224-token prior-context budget on every chunk, displacing the per-utterance
carry-forward.

**Delivered instead:** the single kill-switch is split into
`WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED` and `WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED`, both
defaulting OFF, so each can be A/B'd independently. `mlen_scorecard.py` gains the matching flags.
The A/B needs the private clinical clips (`STT_MLEN_EVAL_DIR`, `WHISPER_MLEN_GGUF`), which are not
on this machine — **flip a default only if `mean_cer` beats 0.325 with no clip regressing past the
committed `per_clip_tolerance` of 0.08.**

### 8.2 W1 — the real A1/A2 defect was durability, not the declaration

The declaration already reaches `pywhispercpp` correctly at session create. The defect is that the
effective mode lived only in the process-local `_session_language_modes`: after a worker restart
`_recover_sessions` rebuilt the spec but not the mode, so resolution fell through to
`spec.py::_language_from_mode`, which maps `ml-en` to its **primary subtag `ml`** — silently
converting a declared-English or deliberately-unpinned session into a **Malayalam-pinned** one.
Fixed by persisting `SessionMetadata.language_mode` through Redis.

### 8.3 W1 — language is TWO channels, and that is correct

`language_mode` (the end user's declaration) travels beside `resolved_spec.decoding.languageMode`
(the agent's) on the same POST; it does not overwrite it. Overwriting would erase the agent's own
declaration from the record crash recovery rebuilds from. The §4 A1 wording implied one channel and
was wrong; a TS test now locks the two-channel contract.

### 8.4 NEW DEFECT — the BATCH path pins Malayalam (not fixed, needs a decision)

Measured off the committed contract fixture, same agent and engine:

```
BATCH     inference.language = 'ml'    (spec.py::_language_from_mode maps ml-en -> primary)
STREAMING resolved.language  = None    (resolve_mode_for_engine('ml-en', WHISPER_CPP))
```

So **batch transcription of a code-switch agent is Malayalam-pinned** — the same class of defect as
§8.2, on a path this ticket does not cover. It also makes `WhisperCppAsrAdapter`'s pair-detection
branch dead code. Correct fix is per-engine mode resolution on the batch path
(`batch_service.py`); `_language_from_mode` is engine-independent, so simply returning the pair id
would hand `"ml-en"` to the Sarvam and Azure adapters, which normalise single codes. **Out of scope
here — needs its own ticket.**

### 8.5 Orchestration defect (mine)

Wave 0 ran `pnpm install` in each worktree but not `pnpm db:generate`. The generated Prisma client
is gitignored, so it does not follow a worktree and every TypeScript build fails with
`TS2307: Cannot find module './generated/core-prisma-client/client.js'`. Corrected mid-wave in all
four worktrees. **Add `db:generate` to the worktree bootstrap for any future fan-out.**


### 8.6 Wave 3 (merge) — what integration caught

All four writer branches merged into `dev-2.2` with **zero conflicts**; the path partition held
exactly. Three things only became visible at merge:

1. **A duplicate control.** W4 hand-rendered `ReasoningField` *because* `GENERATION_PROPERTY` did
   not declare `reasoning`. Once the orchestrator added the property, the generic schema walker
   rendered a second copy — `Found multiple elements with the text of: Enable reasoning`. Two
   correct changes, one broken result. Fixed by skipping `generation.reasoning` in the walker: a
   boolean + enum pair belongs in a switch and a select, not a generic nested-object fieldset.
2. **`prisma migrate dev` cannot run non-interactively.** It demands a TTY to prompt about the
   unique-constraint warning, so the recipe in `02-database-prisma.md` §"Authoring a migration"
   is unusable from an agent session. `migrate diff --from-config-datasource --to-schema --script`
   against the ledger-replayed shadow produces the same SQL and still supports the empty-diff
   proof. **Worth adding to rule 02.**
3. **Generated-artifact drift was exactly as predicted** — `LiveDocNodeDegradeResponse` /
   `nodeDegrades` (W2) and `selectorTags` (W3) in `openapi.json` and the vox-node admin schemas.
   `route-manifest.json` unchanged, since no route was added or altered.

**Migration:** `20260907101216_task_891_workflow_assignment_selector`, authored against a throwaway
shadow DB with the full ledger replayed. The generated SQL is **byte-identical** to the SQL W3
hand-derived from the TASK-884 precedent, and `migrate diff` afterwards prints
`-- This is an empty migration.`

**Gates on the merged tree:** applications **12172 passed / 0 failed**; domains, database and
workflow-contract (1665) green; admin-console **2498 passed** after the fix above; all eight API
steps green including `api:openapi:check`, `api:portal:check` and `gen:admin:check`. The one
failing *suite* is `membership-bounded-sync.integration.test.ts`, which wants a live test DB on
port 5433 — pre-existing, flagged independently by two writers, zero individual tests failing.


## 9. Implementation Summary

*(to be filled during Phase 4)*

## 10. Change History

| Date | Change |
|---|---|
| 2026-09-07 | Ticket opened. Live diagnosis of consultation `01a07ae9-2497-…` on `hope-v2-dev` recorded in §2; plan drafted; OD-1…OD-6 raised. |
| 2026-09-07 | **Owner answered OD-1…OD-5.** OD-1 reversed: the default language is EMPTY (code-switch always on), a specific language must be declared — D1 withdrawn, D2 re-scoped, Lane A rewritten. OD-2: the proposed `DocumentTemplateAssignment` table was rejected as unjustified; corrected to one `selectorKey` column on `WorkflowAssignment` plus a `documentTemplateSlug` on the realtime node config, reusing the parameter `resolveForGeneration` already accepts. OD-4: per-agent `parameters.generation.reasoning`, not a settings descriptor. OD-5: all three dropdowns removed; the workflow names the ASR, summarization and DNA-redaction agents. Follow-up F-1 raised (live vs finalize redaction). Status stays `Pending` — awaiting go-ahead on sequencing. |
| 2026-09-07 | Owner said **go**. Wave 0 complete: plan committed at `f6aa16cf9`; four worktrees created off `dev-2.2` (`task-891/{stt,livedoc,data,console}`) with `pnpm install` and env files done by the orchestrator; `task-891/dev-fixes` branched in the deployment repo. Wave 1 launched — W1 `opus`, W2 `opus`/high, W3 `sonnet`/high, W4 `sonnet`, W5 `sonnet`. F1 (`INTERNAL_ACCESS_TOKEN` in `hope-secrets`) held back for the owner: a shared credential is not a subagent's job. |
| 2026-09-07 | **W5 landed** (`c78cb89`, unpushed): nlp probe timeouts 1s->5s + failureThreshold 2->3 + cpu 2->4, `LIVE_DOC_TEXT_TIMEOUT_MS=60000`, `LMS_CONTEXT` 8192->32768 — overlay only, base untouched, repo CI gates green locally. **W1 landed** (`cd6e439fb`): A1/A2 durability fix, A3 decoupled and left OFF with evidence (§8.1), A4 adapter refuses `max_len=1` on unpinned/non-space-delimited decodes. New batch defect recorded in §8.4. |
| 2026-09-07 | **Wave 3 merged** — W3, W2, W1, W4 into `dev-2.2`, zero conflicts. Migration authored and proven; local dev DB synced with explicit owner consent. Orchestrator added the `reasoning` property to `GENERATION_PROPERTY` (both W2 and W4 had blocked on it) and fixed the duplicate-control regression it caused. Five artifacts regenerated. **Wave 4 launched**: W6 template (`opus`/high), W7 agentsplit (`opus`), W8 visittype (`sonnet`/high). TASK-892 was already taken, so the live/finalize agent split is folded into this ticket rather than spun out. |
