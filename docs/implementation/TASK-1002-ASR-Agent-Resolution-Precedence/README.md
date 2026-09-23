# TASK-1002 — ASR agent resolution precedence: client → governing workflow → assignment cascade

| Field | Value |
|---|---|
| Status | **Pending — awaiting owner go** |
| Type | bugfix |
| Branch | `dev-2.2` |
| Reported by | tester — "the workflow did not trigger the STT model set in the agent/workflow, it used the default one" |
| Opened | 2026-09-23 |

## 1. Requirement (owner, 2026-09-23)

A live STT session's ASR agent is chosen in this order, first hit wins:

1. **Client supplies it** — an explicit `agentSlug` on the session request.
2. **Governing workflow drives it** — the consultation's governing workflow names a `SPEECH_TO_TEXT` agent on a `core.agent` node (the ALaaS path).
3. **Assignments drive it** — the tenant admin's `AgentAssignment` cascade (department → tenant), honouring selector tags.

## 2. Current state (cluster evidence, 2026-09-23)

### 2.1 What ran

Every consultation-bound STT session in tenant `50000000-…-0001` on 09-22/09-23 resolved with
`resolved_spec_json.agent.source = "tenant"` (Redis `stt:session:*`, ~45 sessions), i.e. agent
`sarvam-saaras-v4` v1 (`01a0c27a…`) — the tenant's untagged default assignment. The `hope-stt`
`stt.streaming.fingerprint` log line agrees (`modelSlug=sarvam-saaras-v4`).

| Consultation(s) | Governing workflow → ASR node | STT actually used |
|---|---|---|
| General medicine + repro runs (`01a0cd63`, `01a0cdd9`, `01a0ce2b`, `01a0ce3e`, `01a0ce4c`, …) | `arcaai-gen-consultation` v3 → `n_asr` names **`saaras-test`** | `sarvam-saaras-v4` (tenant default) |
| `01a0ce37` (Radiology dept) | `radiology_report_generation` v1 → `n_summary` names **`realtime-rado-asr`** | `sarvam-saaras-v4` (tenant default) |

**Tier 1 check ("we need to check this also")**: no client sent `agentSlug` on a consultation-bound
session. The only two `source: "explicit"` sessions have no `consultation_id` (playground / agent
test). All three clients *can* send it — browser SDK `StreamingSessionManager.createSession`
(`packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts:93-120`), vox-node
`hope.stt.createStreamSession` (`packages/vox-node/src/resources/stt.ts:69-77`), admin-console
playground (`apps/admin-console/src/features/playground-live-transcription/api/client.ts:25`) —
ALaaS simply does not.

### 2.2 Why

- `transcription-job.controller.ts:220-225` — `resolveAsrAgent(tenantId, agentSlug)` calls
  `AsrAgentResolverService.resolve({ tenantId, agentSlug, departmentId: null })`. The request's
  `consultationId` (`dto/transcription-job.dto.ts:158`) is read only AFTER resolution (`:1064`).
- `ResolveAsrSpecInput` (`asr-agent-resolver.service.ts:19-23`) has no consultation and no
  `selectorTags`; the agent resolver documents the ASR seam as tag-less
  (`agent-resolver.service.ts:277`). So: the workflow is never read, the department tier is
  never reached, and a tagged assignment (`lang:en,speciality:radiology → realtime-rado-asr`)
  can never match.
- The workflow's `n_asr` node is classified by capability only: the realtime
  `SPEECH_TO_TEXT` handler reads back the session's transcript
  (`live-documentation.service.ts:3913-3919`); its `agentRef.slug` never selects an engine. The
  `stt` palette was retired by TASK-893 (`consultation-workflow-dispatch.service.ts:472-481`) on
  the premise that the gateway's assignment resolution is the only ASR binding — this ticket
  reverses that premise for workflow-governed consultations.
- Nothing tells an operator which tier won: `ResolvedAsrSpec.agent.source` exists
  (`build-resolved-asr-spec.ts:707`) but is neither on `StreamSessionResponse` nor logged.

### 2.3 Config timeline for the radiology case (for the tester)

| UTC | Change |
|---|---|
| 12:08:48 | agent `realtime-rado-asr` v1 published (model `radiology-asr-en`) |
| 12:17:14 | workflow `radiology_report_generation` v1 published |
| 12:21:32 | that workflow assigned to the Radiology department |
| 12:22:20 | consultation `01a0ce37` opened under it; STT session 12:22:24 → `sarvam-saaras-v4` |
| 12:24:25 / 12:24:33 | tagged assignment `lang:en,speciality:radiology` moved `realtime-transcription` → `realtime-rado-asr` |
| 12:26:24 | run FAILED — `core.output: … 'case_note' is a required property` (the ASR agent sits on the node named `n_summary`, so no summariser produces `case_note`; an authoring error, separate from this bug) |
| 12:41:40 | recording restarted → still `sarvam-saaras-v4` |

## 3. Design

One resolver, one order — `AsrAgentResolverService.resolve` gains `consultationId?` and does:

```
1. agentSlug given                       → explicit     (unchanged)
2. consultationId given, consultation governed by a workflow
   whose pinned version has a SPEECH_TO_TEXT core.agent node → workflow
3. assignment cascade(task=SPEECH_TO_TEXT,
      departmentId = consultation.departmentId,
      selectorTags = derived tags)       → department | tenant
4. nothing                               → AGENT_NOT_ASSIGNED (unchanged, fail closed)
```

- **Consultation lookup** is tenant-scoped (extended client); a foreign `consultationId` is 404
  (404-over-403), never a silent fall-through to tier 3.
- **Which workflow version**: the governing marker's `workflowRunId` → `WorkflowRun.workflowVersionId`
  → that definition's `compiledConfig` (the version the consultation was opened on), falling
  back to `workflowSelection` then to "no workflow opinion". Reuse the node walk already used by
  `resolveConsultationSelectedLane` / `buildRealtimeLane` / `readAgentRef`
  (`live-documentation.service.ts:2347-2409`, `realtime/realtime-node-registry.ts:316-325`) —
  extract it to a shared helper rather than a second graph walker.
- **ASR node identification** is by the referenced agent's TASK (`SPEECH_TO_TEXT`), not by the
  node id — `n_asr` is a convention, and the radiology graph proves ids are not reliable.
- **`source` gains `'workflow'`** in `packages/types/src/agent.ts:263`,
  `packages/types/src/asr-spec.ts` and the Python mirror
  `apps/stt/src/stt/pipeline/spec.py:532` (`Literal[...]`), plus the parity fixture
  `tests/contracts/resolved-asr-spec.fixture.json`.
- **Observability**: `StreamSessionResponse` gains `agentSource`; the gateway logs one
  `stt.asr_agent_resolved { consultationId, agentSlug, agentVersionId, source, workflowDefinitionSlug? }`
  line per session, so a tester can answer "which tier won" from Grafana without Redis.
- **Every entry point** gets the same order: stream session, batch `…/transcribe`,
  `POST audio/transcription-jobs` (both carry `consultationId`). v1-compat `api/stt/start_session`
  has no `consultationId` → tiers 1 and 3 only (unchanged apart from the department/tag fix,
  which it cannot use either). `agents/:slug/transcribe` stays explicit-only.
- **Resume**: every `recording/start` mints a new STT session and resolves again; because tier 2
  reads the PINNED version, a workflow republished mid-consultation does not switch engines
  between cycles.

## 4. Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | Tier 2 reads the version the consultation's governing run is on, not the currently active version | stable engine across start/stop cycles |
| D-2 | ASR node found by agent task `SPEECH_TO_TEXT`, not by node id | ids are free text (`n_summary` holds the ASR agent in the radiology graph) |
| D-3 | Foreign/unknown `consultationId` → 404, never a fall-through | 404-over-403; must not resolve another tenant's workflow |
| D-4 | `source: 'workflow'` added end-to-end + `agentSource` on the response + one log line | the tester could not tell which tier won |
| D-5 | STT (Python) ships first, gateway second | the Python `Literal` would reject `source: "workflow"` and fail every workflow-resolved session |

## 5. Open decisions (owner)

| OD | Question | Answer / recommendation |
|---|---|---|
| OD-1 | Workflow names an ASR agent that does not resolve | **ANSWERED 2026-09-23: fail with a named error** — 409 `WORKFLOW_ASR_AGENT_UNAVAILABLE` (owner notes the console cannot display an unpublished/disabled ASR agent, so this is a defence against drift after publish, e.g. a connection disabled later) |
| OD-2 | Workflow graph with MORE than one `SPEECH_TO_TEXT` node | **ANSWERED: reject** — validation ERROR at validate/publish; runtime fails closed with the same named error |
| OD-3 | Tier-3 selector tags — purpose and impact | **ANSWERED: 3a** — no request tags on the ASR path; pass the consultation's `departmentId`; the console warns that a tagged `SPEECH_TO_TEXT` assignment is never selected (§5.1) |
| OD-4 | Consultation with no workflow marker | **ANSWERED: yes** — no marker = no workflow opinion → tier 3 |
| OD-5 | Radiology authoring error (ASR agent wired straight to a `core.output` that requires `case_note`) | **ANSWERED: in scope now** — see §5.2; OD-5a open |

### 5.1 OD-3 — what selector tags are, and what they change

**Purpose.** A selector lets one tier hold several opinions for the same task: an untagged row is
the fallback, and a tagged row (`lang:en,speciality:radiology`) wins only when the REQUEST carries
all of its tags (subset match, AND-joined; the most specific row wins —
`agentTagsSatisfy`, `packages/workflow-contract/src/agent-schemas.ts:1695`). The request side is
what makes a tagged row reachable: today only two request vocabularies exist —
`phase:live` (live vs finalize text agent, TASK-891) and `visit-type:<key>` (workflow selection).

**Where they sit in the new flow.** Tier 3 only. The cascade is department row → tenant row, and
inside each tier the most specific satisfied selector wins, then the untagged row. When the
governing workflow names an ASR agent (the ALaaS path), tags are never consulted.

**Current state.** The ASR path sends NO tags, so every tagged `SPEECH_TO_TEXT` row is inert. The
tenant's `lang:en,speciality:radiology → realtime-rado-asr` row has never been selectable. The
console's "Tag selector (optional)" is free text (`agent-detail.tsx:958`), so the vocabulary is
whatever the admin types — this tenant wrote `speciality:`, the code's own examples say
`specialty:`; a derived tag the admin did not guess matches nothing.

| Option | What the gateway derives per session | Effect |
|---|---|---|
| **3a** (recommended) | nothing new; pass the consultation's `departmentId` | a Radiology **department** assignment does what `speciality:radiology` was meant to do, with no vocabulary to agree on; console warns that a tagged ASR row is never selected |
| 3b | `lang:<declared language>` + `visit-type:<key>` (existing derivation) on top of 3a | per-language ASR (e.g. an `en` model vs the `ml-en` code-switch model) becomes configurable; `speciality:` stays inert |
| 3c | 3b + `specialty:<Department.specialty>` (new column + migration + console field) | full vocabulary; largest change, and the existing `speciality:` rows must be renamed to match |

### 5.2 OD-5 — the radiology workflow failure

Graph `radiology_report_generation` v1: `n_trigger → n_summary (core.agent → realtime-rado-asr, a
SPEECH_TO_TEXT agent) → n_output (core.output, required: case_note, onSchemaViolation: fail)`. An
ASR node yields `{ transcript, segments, audio }`, so `case_note` can never exist and the run fails
at the first output (12:26:24).

- **Product fix (in scope):** validation ERROR at validate/publish when a `core.output`'s required
  properties cannot be produced by its upstream node — for a `SPEECH_TO_TEXT` node the output shape
  is fixed and known; for other agents, their declared `outputSchema`. Lives beside the OD-2 rule.
  The already-published v1 then shows `needsReview` / a validation error in the console.
- **OD-5a — ANSWERED: the tenant admin rebuilds it**, guided by the new validation message. No
  data change by us. Original analysis: the tenant's workflow itself is tenant content. Either the tenant admin
  rebuilds it (`n_asr → text-generation agent producing case_note → n_output`), or we republish a
  corrected v2 through the admin API on the tenant's behalf — which also needs a radiology
  summary agent to point at. Recommendation: the tenant admin rebuilds; we ship the validation so
  the console shows exactly what is wrong.

## 6. Implementation plan (on go)

TDD, layer order. Lanes are file-disjoint.

| Lane | Tier | Scope |
|---|---|---|
| L-A contract | sonnet | `packages/types` source union + `asr-spec.ts`; Python `spec.py` Literal; parity fixture; `apps/stt` test |
| L-B resolver | opus | `asr-agent-resolver.service.ts` (+ `consultationId`, departmentId, tags, tier 2); shared graph helper extracted from live-documentation; unit tests |
| L-C gateway | sonnet | `transcription-job.controller.ts` (3 entry points pass `consultationId` + language), `StreamSessionResponse.agentSource`, log line; controller tests; openapi / route-manifest / portal / vox-node `gen:admin` regen |
| L-D SDK docs | sonnet | vox-node + browser SDK doc comments ("omit it → governing workflow → assignment cascade"), `StreamSessionResponse` type |
| L-F console | sonnet | Agents screen (`apps/admin-console/src/features/agents/components/agent-detail.tsx`): for a `SPEECH_TO_TEXT` agent, entering a tag selector shows "tagged speech-to-text assignments are never selected — assign per department instead"; existing tagged ASR rows are flagged in the assignments list (OD-3 = 3a) |
| L-E graph validation | opus | workflow validate/publish: OD-2 (more than one `SPEECH_TO_TEXT` node → ERROR) and OD-5 (`core.output` required keys unreachable from the upstream node → ERROR); console surfaces the validation report |

### TDD test list

1. explicit `agentSlug` wins over a workflow ASR node and over assignments (`source: explicit`).
2. no slug + consultation governed by a workflow with a `SPEECH_TO_TEXT` node → that agent (`source: workflow`).
3. the node is found by agent task even when its id is not `n_asr`.
4. workflow republished mid-consultation → the pinned version's agent still wins.
5. workflow's ASR agent unresolvable → per OD-1.
6. workflow without an ASR node → assignment cascade with the consultation's `departmentId`; department row beats tenant row (`source: department`).
7. (OD-3 = 3a) a tagged tenant row is NOT selected — the untagged tenant default serves; a department row for the consultation's department beats both.
8. no `consultationId` → byte-identical to today (existing resolver tests stay green).
9. foreign-tenant `consultationId` → 404.
10. controller: stream session, batch transcribe and job create pass `consultationId`; response carries `agentSource`.
11. Python: `AsrSpecAgent` accepts `source: "workflow"`; parity fixture round-trips.
12. validate/publish rejects a graph with two `SPEECH_TO_TEXT` nodes (OD-2).
13. validate/publish rejects `SPEECH_TO_TEXT node → core.output{required: case_note}` (the radiology v1 graph as the fixture) and accepts `ASR → text agent (outputSchema has case_note) → core.output` (OD-5).

### Verification (after merge)

Cluster: open an ALaaS-style consultation in General Medicine → `stt.asr_agent_resolved source=workflow agentSlug=saaras-test`, and the `hope-stt` fingerprint's `agentVersion` equals `saaras-test`'s version id; repeat with an explicit `agentSlug` (source explicit) and with a workflow lacking an ASR node (source department/tenant).

## 7. Implementation summary

_Not started._

## 8. Change history

| Date | Change |
|---|---|
| 2026-09-23 | Ticket opened from the tester report; cluster evidence (Redis `stt:session:*`, `hope-stt` fingerprints, DB agents/assignments/workflows) and plan recorded. Awaiting owner go. |
| 2026-09-23 | Owner answered OD-1 (named error), OD-2 (reject), OD-4 (yes), OD-5 (fix now). OD-3 explained (§5.1) and OD-5a raised (§5.2); still awaiting go. |
| 2026-09-23 | Owner answered OD-3 = 3a (department tier, no ASR request tags, console warning → lane L-F) and OD-5a = tenant admin rebuilds. All ODs closed; awaiting go. |
