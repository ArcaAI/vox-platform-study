# TASK-951 — ArcaAI context schemas consolidated to two, and the ALaaS realtime contract

| Field | Value |
|---|---|
| **Status** | Pending — plan awaiting owner decisions (OD-0…OD-11) and an explicit **go** |
| **Type** | feature (schema content + open-time mappings + STT session context echo); touches `packages/database` (seeds), `packages/applications`, `packages/workflow-contract`, `apps/api`, `apps/harness` (test + one model), `packages/vox-node`, `packages/vox-codegen`, `packages/agentic-sdk-v2` (type parity), `apps/admin-console` (marker picker), and a documented ALaaS change list (separate repo) |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-11 |
| **Ticket number** | TASK-951 — highest under `docs/implementation/` is TASK-950; `docs/archive/` unreadable from this session, confirm (OD-0) |
| **Depends on** | TASK-950 (the `userIdentity` marker, `open.context`, `ContextUserIdentityService`) |

## Requirement Analysis

Owner ask (2026-09-11, verbatim):

> for ALaaS, do not switch from its identity-mapping file, but ensure it send the staff id in the
> context. Help me consolidate the schema definitions of ArcaAI tenant: create 2 schemas, one for
> realtime transcription schema to be used with a standalone realtime transcription agent; and
> one for realtime consultation scribe for ALaaS: doctor id, event id, department name (required,
> for triggering consultation workflows), visit type (required, for identifying/combining which
> prompt will be used), vitals, previous cases notes; for audio stream, ALaaS will send metadata
> contains the mic_id, or something else for the hope to return exactly the same metadata things
> along with time-synced transcription <-- ALaaS has a logic for labelling speaker I think.

Restated:

| # | Behaviour |
|---|---|
| **R1** | ArcaAI has exactly TWO consultation context schemas: `arcaai_realtime_transcription` and `arcaai_consultation_scribe`. Discovery and every ArcaAI workflow trigger / agent binding resolve to one of them. |
| **R2** | A client of the standalone transcription agent sends a validated metadata object when it creates an STT stream session, and every time-synced transcript segment of that session echoes that object verbatim. |
| **R3** | The scribe schema carries, as client-supplied fields: doctor staff id (→ TASK-950 identity), external event id, department (required; selects the consultation workflow), visit type (required; selects the prompt), vitals, previous case notes. HOPE MAPS each of them at `open`, never just validates them. |
| **R4** | ALaaS keeps its identity-mapping file (`clinicianUserId` + `departmentId` from the map) AND sends the staff id and the other facts in `context`; HOPE refuses disagreement between the two routes (as `CLINICIAN_MISMATCH` already does). |
| **R5** | The facts a client sends at `open` reach the consultation: persisted as PRE context items and threaded into the governing workflow's trigger context. |

## Current State Evaluation (verified 2026-09-11 at `70a842c7b`, five read-only lanes)

### ArcaAI has three schemas, bound inconsistently

| Row | Scope | Kinds | Bound by |
|---|---|---|---|
| `consultation_note_context` (clone of SYSTEM, `templateLocked`) | TENANT default | `audio_stream`, `work_note`, `case_note`, `attachment`, `context` (STRUCTURED, `producedBy: [SYSTEM, CLIENT]`, 9 required platform-derived properties + v1 legacy names) | the `core.trigger` of ALL 11 `arcaai-<dept>-consultation` workflows; `case-notes-pre-summary` variables `trigger.context.*`; `core.condition` on `trigger.context.visit_type` |
| `consultation_gen_arcaai` (07f) | DEPARTMENT default for `GEN_ARCAAI` | `audio_stream`, `work_note`, `attachment`, `vitals` (STRUCTURED: bloodPressure, heartRate, temperature, oxygenSaturation) | nothing — but it is what discovery SERVES for `departmentId=GEN_ARCAAI`, so TASK-950's open-time validation and identity marker land here, not on the workflow's schema |
| `consultation_rheum_arcaai` (07f) | DEPARTMENT default for `RHEUM_ARCAAI` | + `joint_count`, `inflammatory_markers` | nothing |

No agent binds a schema at the `Agent` row (`contextSchemaId: null` for all six golden agents and the 23 ArcaAI ones). The seeded `context` kind is produced by HOPE itself: `LiveDocumentationService.realtimeRunContext` derives `current_department` from the department row, `visit_type` from the session, `language` from the session, `formatted_vitals` from the NLP vitals TOOL (not the `vitals` kind), and leaves `safe_*` = `Unknown`, `formatted_previous_visits` = `''`, `chief_complaint` = `''`. The `vitals` kind is read by nobody.

### What a client cannot state at `open` today

- **Department** must arrive as an id (`assertParentInScope`); `DepartmentRepository.findByCode` exists (`@@unique([tenantId, code])`), `name` is NOT unique (ArcaAI carries two rows named "General Medicine"); departments are only listable under `admin/departments` (`svc:admin:department:manage`), a scope the ALaaS service account does not hold.
- **Visit type** is 100 % derived from `parentConsultationId` (`selectVisitType({ isFollowUp })` at all 10 call sites; `Consultation` has no `visitType` column); the catalogue knows two keys, `new-visit` (aliases `new-patient`, `new-referral`, `referral`) and `revisit` (`follow-up`, …), and `VisitTypeService.match(raw)` exists but is only used by the frozen v1 plane.
- **Vitals / previous case notes**: `open.context` is validated for identity and DISCARDED (TASK-950 scope); `POST :id/context` items are never read by native prompt assembly; `formatted_previous_visits` and `safe_vitals` are hard-wired empty / `Not available`; the warm-start pre-summary reads `CASE_NOTE` context items (`findCaseNotes()`).
- **Event id**: no column, no reserved metadata key; idempotent re-open is `(tenantId, patientId, appointmentDate, doctorId)` only.
- **Trigger context**: the dispatcher sends only `subject`; `_authored_context(run_payload)` is `{}` for every consultation-open run, so `trigger.context.*` sees nothing a client sent.

### Realtime STT and client metadata

- `CreateStreamSessionRequest` (gateway) has NO `metadata`/`context` field; the internal STT DTO's `microphoneId` is dead (never set), the JSON audio frame's `microphoneId` is dropped by `SttWsGateway`, and `SegmentResult.to_redis_dict()` carries no client field — so nothing a client sends is echoed on `/ws/stt/stream`. Only the legacy `/stt` compat gateway echoes a per-socket, last-write-wins `metadata` blob.
- One consultation binds ONE live STT session (`recording/start.sessionId` replaces the previous subscription); `channelCount` is a billing signal; speaker labels come only from diarization (`speakerId`/`speakerLabel`).
- `d8ce54c17` added per-segment timing (`utteranceIndex`, `seq`, `charStart/End`, `receivedAtMs`, `words[]`) and `audio: { kind, sessionId, epochMs }` on the realtime GRAPH lane; the WS wire contract is unchanged.
- A `SPEECH_TO_TEXT` agent CAN be published with `contextSchemaId` (compiles, frozen into `compiledConfig.contextSchema`) but nothing on the STT plane reads it.

### ALaaS today (`apps/audio-stream-svc`, branch `refactor-hope-integaration`, uncommitted work in flight)

- Mapping file `ALAAS_HOPE_MAPPING`: `departments` (ALaaS dept id → HOPE dept UUID) and `clinicians` (consultant id → HOPE username → user id). `open` sends `patientId = alaas:<regNo>`, `clinicianUserId`, `departmentId`, `parentConsultationId` (revisit only), `language`, `metadata { source, alaasSessionId, alaasEventId, alaasDepartmentId, summaryLanguage, patientRegNo }`. The consultant id is used only to resolve the user and then dropped.
- `StartMessage` already carries `eventId`, `clinician.consultantId`, `departmentId` (a CODE such as `GEN`/`BREN`), `visitType` (`new` \| `revisit`), `priorCaseNotes[]`; `departmentName` and `vitals[] { componentName, value, date }` exist in the browser but are not sent.
- Prior case notes are written as `CASE_NOTE` items (no `kindKey`) before `recording/start` so the warm-start pre-summary sees them; mid-visit notes as `TEXT`. The typed `context` kind is never used on the realtime path.
- Audio: all microphones are MIXED to one mono PCM16 stream (`AudioMixer.drain`); `micId` dies at the mixer; one STT session per consultation; the browser attributes turns from `speakerLabel ?? speakerId` only. The integration plan's own open item: "per-mic attribution revisited once H2 confirms HOPE's diarization uses it".

## Implementation Plan

### The two schemas (content, seeded for ArcaAI; the SYSTEM reference set is untouched)

**Schema 1 — `arcaai_realtime_transcription`** (TENANT scope, `isDefault: false`; bound by ArcaAI's `realtime-transcription` SPEECH_TO_TEXT agent via `Agent.contextSchemaId`)

```json
{ "schemaVersion": 1,
  "kinds": [
    { "key": "audio_stream", "primitive": "STREAM_AUDIO", "phiClass": "PHI", "cardinality": "ONE", "lifecycle": "DURING", "producedBy": ["CLIENT"] },
    { "key": "stream", "label": "Stream Metadata", "primitive": "STRUCTURED", "phiClass": "NON_PHI", "cardinality": "ONE", "lifecycle": "PRE", "producedBy": ["CLIENT"],
      "description": "Client-owned identification of this audio stream. Echoed VERBATIM on every transcript segment of the session.",
      "fields": { "type": "object", "properties": {
          "mic_id":        { "type": "string", "minLength": 1 },
          "speaker_label": { "type": "string" },
          "channel":       { "type": "string" },
          "source":        { "type": "string" } },
        "required": ["mic_id"], "additionalProperties": true },
      "streamContext": true } ],
  "outputs": [
    { "key": "transcript", "primitive": "TEXT" },
    { "key": "transcript_segment", "primitive": "STRUCTURED", "fields": { "type": "object", "properties": {
        "text": {"type":"string"}, "isFinal": {"type":"boolean"}, "startTime": {"type":"number"}, "endTime": {"type":"number"},
        "utteranceIndex": {"type":"integer"}, "speakerId": {"type":"string"}, "speakerLabel": {"type":"string"},
        "words": {"type":"array","items":{"type":"object","properties":{"text":{"type":"string"},"start":{"type":"number"},"end":{"type":"number"}}}},
        "sessionEpochMs": {"type":"integer"},
        "context": {"type":"object"} } } } ] }
```

**Schema 2 — `arcaai_consultation_scribe`** (TENANT default; replaces the tenant clone as the trigger binding of the 11 ArcaAI consultation workflows; the two 07f department rows are retired for ArcaAI — OD-9)

```json
{ "schemaVersion": 1,
  "kinds": [
    { "key": "audio_stream", "primitive": "STREAM_AUDIO", "phiClass": "PHI", "cardinality": "ONE", "lifecycle": "DURING", "producedBy": ["CLIENT"] },
    { "key": "encounter", "label": "Encounter", "primitive": "STRUCTURED", "phiClass": "NON_PHI", "cardinality": "ONE", "lifecycle": "PRE", "producedBy": ["CLIENT"], "required": true,
      "fields": { "type": "object", "properties": {
          "doctor_id":        { "type": "string", "minLength": 1, "description": "The clinician's staff identifier (ALaaS consultantId)." },
          "event_id":         { "type": "string", "minLength": 1, "description": "The external encounter/event id." },
          "department_code":  { "type": "string", "minLength": 1, "description": "Department code as registered in HOPE (GEN, BREN, …)." },
          "department_name":  { "type": "string", "description": "Display name; informational unless OD-1 says otherwise." },
          "visit_type":       { "type": "string", "enum": ["new-visit", "revisit"] } },
        "required": ["doctor_id", "event_id", "department_code", "visit_type"] },
      "userIdentity": { "field": "doctor_id" },
      "department":   { "field": "department_code", "by": "code" },
      "visitType":    { "field": "visit_type" },
      "externalRef":  { "field": "event_id" } },
    { "key": "vitals", "primitive": "STRUCTURED", "phiClass": "PHI", "cardinality": "ONE", "lifecycle": "PRE", "producedBy": ["CLIENT"],
      "fields": { "type": "object", "properties": { "observations": { "type": "array", "items": { "type": "object",
          "properties": { "name": {"type":"string"}, "value": {"type":"string"}, "unit": {"type":"string"}, "recorded_at": {"type":"string"} }, "required": ["name","value"] } } }, "required": ["observations"] } },
    { "key": "previous_case_notes", "primitive": "STRUCTURED", "phiClass": "PHI", "cardinality": "ONE", "lifecycle": "PRE", "producedBy": ["CLIENT"],
      "fields": { "type": "object", "properties": { "notes": { "type": "array", "items": { "type": "object",
          "properties": { "date": {"type":"string"}, "department": {"type":"string"}, "doctor": {"type":"string"}, "title": {"type":"string"}, "text": {"type":"string"} }, "required": ["text"] } } }, "required": ["notes"] },
      "materializeAs": "CASE_NOTE" },
    { "key": "work_note", "primitive": "TEXT", "phiClass": "PHI", "cardinality": "MANY", "lifecycle": "ANY", "producedBy": ["CLIENT"] },
    { "key": "attachment", "primitive": "DOCUMENT", "phiClass": "PHI", "cardinality": "MANY", "lifecycle": "ANY", "producedBy": ["CLIENT"] },
    { "key": "context", "...": "the platform-produced prompt context kind, UNCHANGED from consultation_note_context (SYSTEM-produced; prompts bind trigger.context.*)" } ],
  "outputs": [ { "key": "case_note", "primitive": "TEXT" }, { "key": "soap_note", "primitive": "TEXT" } ] }
```

### Decisions taken (owner may override)

| # | Decision | Rationale |
|---|---|---|
| **D-1** | Open-time mappings are declared by KIND-LEVEL MARKERS in the TASK-950 style, one per role, ≤ 1 each per definition, STRUCTURED/ONE kinds only: `userIdentity` (exists), `department: { field, by: 'code' \| 'name' }`, `visitType: { field }`, `externalRef: { field }`. One derivation `openBindingsFromDefinition(definition)` beside `userIdentityBindingFromDefinition`; frozen the same way. | The owner's ask is that the tenant schema carries these facts; TASK-950 already established that a marker is a mapping declaration, never authorization. Any tenant can declare them, not only ArcaAI. |
| **D-2** | `department` resolves BY CODE by default (`DepartmentRepository.findByCode`, unique per tenant). `by: 'name'` is allowed but resolves case-insensitively and answers **400 `DEPARTMENT_AMBIGUOUS`** on more than one match and **404** on none. When the request also carries `departmentId`, the two must agree → **400 `DEPARTMENT_MISMATCH`**. | ArcaAI already has two departments named "General Medicine"; ALaaS already sends the code. |
| **D-3** | The stated `visit_type` is matched through `VisitTypeService.match` (aliases honoured), persisted on the row as `metadata.visitType` (a namespaced marker like `withWorkflowSelectionMarker`), and every `forConsultation({ isFollowUp })` call site passes `recorded: consultation.metadata.visitType` so the stated value wins over the parent-link derivation. A stated `revisit` with no parent is allowed; a stated `new-visit` with a parent is allowed (the caller knows). | Minimum change (no migration); the catalogue's `selectVisitType` already accepts a recorded value. OD-2 offers the column. |
| **D-4** | `externalRef` lands on `metadata.externalRef` (marker helper) and is NOT part of the idempotency key. | Adding it to the key changes get-or-create semantics for every caller; OD-3. |
| **D-5** | `open` PERSISTS every validated `context` kind as a PRE context item (`ContextService.addContext` semantics, `kindKey` + canonical content), and a kind marked `materializeAs: 'CASE_NOTE'` is additionally written as one `CASE_NOTE` item per array entry (title + text), so the existing warm-start `findCaseNotes()` read works and ALaaS's own `pushPriorCaseNotes` loop becomes unnecessary. | TASK-950 deferred persistence deliberately; R5 now needs it. |
| **D-6** | The dispatcher threads the AUTHORED, validated `open.context` into the run payload, so `_authored_context(run_payload)` is the client's context and `trigger.context.encounter.*` / `.vitals` / `.previous_case_notes` are addressable by workflow nodes. The harness validates it against the trigger's frozen schema exactly as it does for API-triggered runs. | Makes R3's "for triggering / for prompt selection" real inside the graph, not only at open. |
| **D-7** | The realtime lane merges client-supplied facts into the prompt context it builds: `formatted_vitals` prefers a client `vitals` kind over the NLP tool output when present; `formatted_previous_visits` is populated from the `previous_case_notes` kind (bounded by the existing 15 000-char cap). | The deliberate "leave previous visits empty" choice predates a client that can supply them; OD-5 lets the owner keep the old posture. |
| **D-8** | STT session context echo: `CreateStreamSessionRequest.context?: { [kindKey]: payload }` (≤ 4 KB), validated against the session's ASR agent's frozen `compiledConfig.contextSchema.payloadSchema` when the agent binds a schema (400 `CONTEXT_SCHEMA_VIOLATION`), stored on the gateway's session binding (Node/Redis, no `apps/stt` change), and projected verbatim as `context` on every `transcript` message plus `sessionEpochMs` (the gateway's attach clock, aligning segment-relative times across sessions). `streamContext: true` on the kind is informational (which kind carries stream identity). | One STT session per microphone gives per-mic attribution without touching the mixer or the consultation binding; the echo is per session, which is exactly "the same metadata things back". |
| **D-9** | The consultation keeps ONE bound STT session (the mixed stream). Per-mic standalone sessions are for the transcription display; binding several sessions to one consultation is out of scope (OD-8). | The live lane replaces, not fans in, subscriptions; changing that is its own ticket. |
| **D-10** | ArcaAI seeds: replace the 07f department rows and the ArcaAI use of the tenant clone with the two new rows (create-only, idempotent), rebind the 11 workflows' `core.trigger` to `arcaai_consultation_scribe`, set `contextSchemaId` on ArcaAI's `realtime-transcription` agent to `arcaai_realtime_transcription`. The SYSTEM/Global reference set and other tenants are untouched. | R1; ArcaAI is a customer tenant, its schemas are tenant content. |
| **D-11** | Console: the TASK-950 "User identity field" select becomes a "Field role" table on a STRUCTURED kind (identity / department / visit type / external ref, each ≤ 1 per schema, plus `by` for department). | One picker per marker would not scale. |
| **D-12** | SDKs: `vox-node` `CreateStreamSessionRequest.context?`, `SttTranscriptResult.context?` + `sessionEpochMs?`; browser SDK `WsTranscriptResult` parity; `vox-codegen` emits `@identity` (exists) and `@role(department\|visitType\|externalRef\|stream)` JSDoc tags. | Type-only. |

### ALaaS change list (separate repo, documented here; the mapping file stays)

1. `open`: keep `clinicianUserId` + `departmentId` from the mapping file; ADD `context: { encounter: { doctor_id: clinician.consultantId, event_id: eventId, department_code: departmentId /* the ALaaS code */, department_name, visit_type: visitType === 'new' ? 'new-visit' : 'revisit' }, vitals: { observations: [...] }, previous_case_notes: { notes: [...] } }`. Drop the separate `pushPriorCaseNotes` loop once D-5 ships. HOPE answers `CLINICIAN_MISMATCH` / `DEPARTMENT_MISMATCH` if the two routes disagree — a self-check on the mapping file.
2. Standalone per-mic transcription: one `hope.stt.createStreamSession({ agentSlug: 'realtime-transcription', context: { stream: { mic_id, speaker_label } } })` per microphone (unmixed), display `transcript.context.mic_id` + `sessionEpochMs + startTime` for alignment; the mixed session stays bound to the consultation as today.
3. `npm run hope:codegen` regenerates `ContextPayload`/kind maps; `KNOWN_CONTEXT_KINDS` gains the new kinds.
4. `web_ui` sends `departmentName` and `vitals[]` on `StartMessage` (both already in the browser).

### Open decisions for the owner (OD)

| # | Question | Options | Recommendation |
|---|---|---|---|
| **OD-0** | Ticket number | TASK-951 / other | TASK-951 |
| **OD-1** | Department resolution | **by code** (unique) with `department_name` informational / by name (case-insensitive, 400 on ambiguity) / accept both, code wins | **by code**; ArcaAI has duplicate names |
| **OD-2** | Visit-type persistence | **`metadata.visitType` marker** (no migration) / a `Consultation.visitType` column | **marker** now; column when it needs indexing |
| **OD-3** | `event_id` | **`metadata.externalRef` only** / also part of the re-open idempotency key | **metadata only** |
| **OD-4** | Vitals shape | **ALaaS list `observations[] { name, value, unit?, recorded_at? }`** / normalised GEN shape (`bloodPressure`, `heartRate`, …) | **list** — no client-side mapping, HOPE formats for the prompt |
| **OD-5** | Client previous notes reach prompts | **yes** (`formatted_previous_visits` from the kind; CASE_NOTE items for warm-start) / keep the current "empty by design" posture and only persist items | **yes** |
| **OD-6** | Persist all validated `open.context` kinds as PRE items | **yes** / identity-only as in TASK-950 | **yes** |
| **OD-7** | Thread authored context into the run payload | **yes** / no (trigger context stays empty at open) | **yes** |
| **OD-8** | Per-mic attribution | **one standalone session per mic + echo** (this ticket) / multi-session consultation binding (own ticket) | **standalone sessions** |
| **OD-9** | 07f department schemas | **retire for ArcaAI** (two schemas total) / keep as department overrides | **retire** — owner said two |
| **OD-10** | Marker grammar | **one key per role** (`department`, `visitType`, `externalRef`, `streamContext`) / a single `roles` object | **one key per role** — matches `userIdentity` |
| **OD-11** | `context` kind's nine `required` properties | keep (HOPE-produced; a client never sends this kind at open) / relax | **keep** |

### Lanes (on go — same model as TASK-950: pinned contracts, no lane runs gates, the orchestrator merges into `dev-2.2` and gates)

| Lane | Tier | Owns | Deliverable |
|---|---|---|---|
| A seeds | sonnet | `seed/07f-*`, new `seed/07g-arcaai-two-schemas.ts`, `seed/29-arcaai-*` (trigger rebind + STT agent binding), `seed/26-*` (skip the clone for ArcaAI), seed tests | the two rows, bindings, idempotency |
| B grammar + freeze | opus | `context-schema-definition.ts` (three markers + `materializeAs` + `streamContext`, `openBindingsFromDefinition`), `resolveReference`, `agent.service.ts`, `workflow-contract/compiler.ts`, harness test | markers validated at publish, frozen beside `userIdentity` |
| C open mappings | opus | `consultation.service.ts` (department/visitType/externalRef resolution, persistence D-5, mismatch codes), `visit-type/*` (`recorded` from metadata), the 10 `forConsultation` call sites, dispatcher run payload (D-6), `harness-gateway` payload, e2e | R3/R5 |
| D realtime lane | opus | `live-documentation.service.ts` `realtimeRunContext` (D-7), `pre-summary-variables.ts` sources | prompts see client vitals / prior notes |
| E STT echo | opus | gateway `transcription-job.dto.ts` + controller (`context`), `StreamSessionTenantBindingService` (store), `streamingAudioBridge.service.ts` (`projectAndEmitResult` adds `context`, `sessionEpochMs`), `streaming-session.dto.ts`, `stt-ws.gateway.ts` (attach epoch), e2e | R2 |
| F SDKs | sonnet | `vox-node` types/resources, browser SDK `WsTranscriptResult`, `vox-codegen` role tags | D-12 |
| G console | sonnet | `definition-editor.tsx` field-role table | D-11 |
| H ALaaS | (separate repo, after HOPE merges) | broker `open` context, per-mic sessions, codegen | the change list above |

### TDD list (RED first)

1. Grammar: each marker only on STRUCTURED/ONE; field exists with the right type (`visit_type` enum ⊂ catalogue keys/aliases); ≤ 1 per role; `department.by ∈ {code,name}`; `materializeAs` only on an array-of-objects-with-`text` shape; ADDITIVE classification.
2. `openBindingsFromDefinition` → `{ userIdentity?, department?, visitType?, externalRef? }`; frozen on agents and triggers; absent → absent.
3. Open: department by code → id; by name unique → id; by name duplicate → 400 `DEPARTMENT_AMBIGUOUS`; unknown → 404; disagreement with `departmentId` → 400 `DEPARTMENT_MISMATCH`.
4. Open: stated `visit_type` persisted; `forConsultation` prefers the recorded value at every call site (table-driven test over the 10 sites); alias `referral` → `new-visit`.
5. Open: `event_id` → `metadata.externalRef`; idempotency key unchanged.
6. Open: every validated kind becomes a PRE `ContextItem` with `kindKey`; `previous_case_notes` → N `CASE_NOTE` items; `findCaseNotes()` sees them.
7. Dispatch: run payload = authored context + subject; harness `_authored_context` equals the client's context; trigger validation passes for the scribe schema.
8. Realtime lane: `formatted_vitals` from the client kind; `formatted_previous_visits` from the notes (bounded).
9. STT: `context` validated against the ASR agent's frozen schema; stored; echoed on every `transcript`; `sessionEpochMs` present; a session without an agent schema accepts any ≤ 4 KB object; > 4 KB → 413.
10. Seeds: exactly two ArcaAI schema rows after a reseed; 11 triggers bound to the scribe; STT agent bound to the transcription schema; `GET tenants/me/context-schema?departmentId=GEN_ARCAAI` returns the scribe schema.
11. e2e (service account): `open` with the full `encounter` + `vitals` + `previous_case_notes` → 201, `doctorId` provisioned/resolved, `departmentId` = GEN by code, `metadata.visitType`/`externalRef` set, PRE items present; mismatch cases; per-mic STT session echoes `context` on transcripts (against the dev gateway; STT service required for the echo case).

### Verification

Same gate list as TASK-950 (domains/applications/workflow-contract/harness/vox-node/codegen/console/api builds, suites, lints, five artifacts, e2e against a `dev-2.2` gateway) plus a live proof from the ALaaS replay once lane H lands.

## Implementation Summary

_Pending — awaiting OD answers and go._

## Change History

| Date | Entry |
|---|---|
| 2026-09-11 | Opened from the owner's consolidation ask. Five read-only discovery lanes (ArcaAI schemas, STT protocol, open-time resolution, ALaaS broker, decision sizing). Plan + OD table written; status Pending. |
