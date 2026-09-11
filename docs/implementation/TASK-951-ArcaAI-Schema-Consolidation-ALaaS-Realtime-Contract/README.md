# TASK-951 — ArcaAI context schemas consolidated to two, and the ALaaS realtime contract

| Field | Value |
|---|---|
| **Status** | Review — lane E2 (time-synced metadata) merged and gated; owner re-clarified R2 (ONE sticky `mic_id`): `transcript.metadata` is the flat object in force (the v1 shape), `metadataSpans` its bounds; the agent's frozen schema carries `openBindings` so the gate engages; live e2e green (§Gate evidence) |
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
| **R2** | **(clarified 2026-09-11)** ALaaS sends one, two or more mic ids WHILE recording; each transcript segment HOPE returns carries exactly the metadata that was in force during that segment's time window — i.e. metadata is attached per AUDIO SPAN and time-synced with the segment (`startTime`/`endTime`), not per session. The session-level `context` echo shipped by lane E stays for static per-session facts; the time-synced channel is lane E2's `metadata` frame + `metadata[]` spans on every transcript. |
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

**History (owner asked 2026-09-11 whether the time-synced echo still exists).** It did, in v1: the client attached an arbitrary JSON object to each audio chunk on the live-STT WebSocket (`{device_id, role, chunk_id, consultationId}`) and the v1 recognizer buffered and re-attached it to every `{type:'transcription', …, metadata}` message — coarse correlation (Azure FIFO / Whisper sticky-per-batch, v1 doc §9.3). The v2 port (TASK-564/565/566, now `docs/archive/TASK-564-live-transcription-metadata-passthrough/`) deliberately did NOT reproduce the server echo — "the v2 wire has no metadata field; the gateway drops it; every server-echo design edits `SttWsGateway`, the bridge and `apps/stt`" — and DEFERRED it to "a separate backend ticket" (§7). What survives is client-side only: `/vox/compat` `useArcaSpeechToText` keeps a capture-relative timeline (`TimelineEntry { atMs, metadata }`, cap 256) and `pickMetadataForFinal` attaches the latest entry with `atMs ≤ startTime·1000` (sticky fallback; documented wall-clock vs stream-time risk). The legacy `/stt` compat gateway still parses the v1 frame header and echoes a per-socket last-write-wins blob, preferring a `message.metadata` the current STT never sends. A server-side caller (the ALaaS broker on `/vox-node`) therefore has NOTHING today. **Lane E2 is the deferred backend ticket**, with a strictly better time base: the gateway's audio clock (bytes forwarded ÷ (sampleRate × 2)) and `apps/stt`'s segment times both count audio samples, so spans clip to segment windows exactly rather than by wall clock. Follow-up once E2 lands: `useArcaSpeechToText` can prefer the server-attested `metadata[]` spans over its client timeline.


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
2. Standalone transcription, ONE session for the whole recording: `hope.stt.createStreamSession({ agentSlug: 'realtime-transcription', context: { stream: { mic_id } } })` (the initial mic; the `context` is optional), then `socket.setMetadata({ mic_id })` on the SAME socket every time the live microphone changes — no timestamps, sticky until the next declaration, HOPE places each one on its own count of the audio received. Read `transcript.metadata.mic_id` exactly as the v1 pipeline returned it (the mic live over that segment's audio); `transcript.metadataSpans[]` (`{ from, to, value }`, seconds in the same clock as `startTime`/`endTime`, clipped to the segment) carries the exact bounds when a switch fell inside a segment. The mixed session stays bound to the consultation as today.
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

### Lanes merged into `dev-2.2` (2026-09-11, same model as TASK-950: no lane ran a gate)

| Lane | Tier | Commit | What landed |
|---|---|---|---|
| A seeds | opus | `5dee0149a` | `07g-arcaai-two-schemas.ts` (both rows, retirement sweep, STT agent bind with frozen `contextSchema`), 07f deleted, 29 triggers rebound; `regen-workflow-seeds.ts` reads `target.contextSchemaDefinition` |
| B grammar | opus | `5c769bfc9` | `department`/`visitType`/`externalRef`/`materializeAs`/`streamContext` markers, `openBindingsFromDefinition`, frozen on agents + compiled triggers, harness admission test |
| C open mappings | opus | `b1b4e4b4c` | two-pass resolution (department by code/name → bundle re-derived), `open-markers.ts`, PRE-item persistence via `addContext`, `CASE_NOTE` materialisation, authored context into the run payload, 7 visit-type call sites |
| D realtime lane | opus | `c935bd79e` | `realtimeRunContext` prefers client `vitals` / `previous_case_notes`; two visit-type call sites |
| E STT echo | opus | `cfae7bc86` | `CreateStreamSessionRequest.context` (≤ 4 KB, validated against the ASR agent's frozen schema via `ResolvedAsrSession.contextSchema`), stored on `StreamSessionMeta`, echoed with `sessionEpochMs` |
| E2 per-span metadata (R2 clarified) | opus | `a64ad6dd9` (lane `7289132e4`) | `{ type: 'metadata' }` control frame (also inline on JSON audio frames), gateway audio clock `bytes ÷ (sampleRate × 2)`, spans mirrored to Redis `stream-session-marks:<id>` for reconnects, `transcript.metadata[]` spans clipped to each segment's window, validated against the frozen `streamContext` kind (`METADATA_INVALID` / `METADATA_TOO_LARGE` 2 KB / `METADATA_SCHEMA_VIOLATION` + `problems`), `RealtimeSttSocket.setMetadata` + `SttWebSocketClient.setMetadata`, `SttMetadataSpan` type |
| F SDKs | sonnet | `b1d141f2f` | vox-node/browser/codegen types, `` tags |
| G console | sonnet | `72dd7a34e` | `FieldRoleTable` replaces the identity select |
| I (TASK-950 FW) | opus | `2540ef1bb` | `actingUserId` on `WorkflowRun._metadata`; `doctorId` on agent-invocation usage rows |
| I2 (TASK-950 FW) | opus | `5007b6c0f` | `WorkflowRun.metaData` accessors; `actingUserId` on run + status responses |

Orchestrator fixups: `2580552e0` (STT fixture `sessionEpochMs`), `1ca0a8f88` (prettier), `780c39c94` (scribe `encounter` NOT kind-level required — the derived trigger schema would otherwise fail every console-opened consultation; `case_note` kind retained; doc link), `704a0c2ff` / the human-caller test (assertions aligned), `0dc2f3732` (status call passes `actingUserId`), regenerated `29-*.generated.ts` via `seed:regen:workflows`. After lane E2: `f155a4bec` (vox-node barrel exports `SttMetadataSpan`; prettier on E2's two gateway files; the echo test mocks the marks lookups), `c1ab18485` (gateway tests follow the echo object's `metadataSpans` accessor and the two-key handshake read; prettier on the stream-session controller), `4686caca4` (content: `stream` kind → `mic_ids`, frozen blob + `openBindings`, seed re-freeze / in-place v1 refresh, ArcaAI-bound e2e case, SDK docs on the seeded key), `66d211539` (the v1 refresh writes only columns the version row has). Three lanes (D, F, G) were first spawned on a stale base (`c56b54e99`) by the worktree tool, stopped, and re-spawned with a mandatory `git merge --ff-only dev-2.2` first step; every lane's report states its HEAD before/after.

### Accepted deviations

| # | Plan said | Shipped | Why |
|---|---|---|---|
| 1 | `sessionEpochMs` on every transcript | on every transcript OF A SESSION THAT DECLARED `context`; always on the create response and the `ready` frame | a context-less session stays byte-identical to today (pinned with `toEqual`) |
| 2 | `department.by` defaults to `code` | `by` is REQUIRED in the grammar; ArcaAI's schema declares `by: 'code'` | an implicit default in a publish gate is a second, quieter rule |
| 3 | Schema 2 `encounter` `required: true` | kind-level `required` dropped; property-level `required` inside the kind kept | see fixup `780c39c94` |
| 4 | Schema 2 kind list | `case_note` (TEXT/MANY) retained beside `work_note` | the note-context clone declared it; a client naming `kindKey: 'case_note'` must keep validating |
| 5 | `subject.userId` for standalone runs (TASK-950 decision 2) | fast win: `WorkflowRun._metadata.actingUserId` + `actingUserId` on run/status responses | owner decision |
| 6 | agent-plane attribution (TASK-950 decision 3) | fast win: `doctorId` on the `AiUsageEvent` row | owner decision |
| 7 | 10 visit-type call sites | 9 changed (7 in lane C, 2 in lane D); `agentic-instructions.service.ts` untouched — it has no consultation | nothing recorded to pass |
| 8 | R2 read as "one or more mic ids per span" → `mic_ids: string[]` (briefly shipped in `4686caca4`) | **Owner re-clarified (2026-09-11): ONE microphone at a time.** `stream` kind requires a single `mic_id` (string), sticky until the next declaration; `transcript.metadata` is the FLAT object in force over the segment (the v1 wire shape, so ALaaS reads `metadata.mic_id` as before) and `transcript.metadataSpans` its exact bounds within the segment. When a switch fell inside a segment, `metadata` is the value in force over the larger share (tie → the earlier); both keys are absent on a session that never declared. A frame carrying `mic_ids` / `micId` is refused `METADATA_SCHEMA_VIOLATION` with `/mic_id: required property is missing` | the owner's sequence table: mic 1 → (none) → mic 2 → mic 1 → mic 2 → (none) returns 1, 1, 2, 1, 2, 2 — pinned by `metadataInForce` + `setMetadataAt` + `clipSpansToWindow` in `stream-metadata-timeline.task951.test.ts` |
| 9 | frozen `compiledConfig.contextSchema` on the ASR agent = `schemaId` / `versionNumber` / `versionId` / `payloadSchema` | + `openBindings`, spread when non-empty exactly as `ConsultationContextSchemaService.resolveReference` does | `resolveStreamMetadataSchema` finds the kind a `metadata` frame is validated against through `openBindings.streamContext.kindKey` on the FROZEN artifact. The dev DB agent row (verified with `psql`) carried no `openBindings`, so the gate accepted any object and the live spans spec passed for the wrong reason — the ArcaAI-bound e2e case now pins the refusal |
| 10 | seed is create-only | create-only for schema ROWS (by our id and by slug); the v1 DEFINITION of a seed-owned row is refreshed in place when its checksum moved; the agent blob is RE-FROZEN when its content drifted (`canonicalJson`, `jsonb` key order independent); an admin's own pin or slug is never touched | a dev database seeded before a definition change must converge on `RUN_SEED=all` without a reset |

### Gate evidence (orchestrator, verification worktree `../hope-v2-task-951-verify` on `dev-2.2`)

| Gate | Result |
|---|---|
| `gen:model:check` / `gen:entity:check` / `gen:factory:check` | no drift (181 / 103 / 103); schema coverage OK (101 artifacts / 105 models) |
| `/domains` test | 1929 passed (incl. `workflowRun.metadata.task950`) |
| `/database` test | 1752 passed (incl. `task-951-arcaai-two-schemas`, `task-930-workflow-seeds` against the regenerated blobs) |
| `/json-schema-subset` / `/workflow-contract` test | 18 / 945 passed |
| `pnpm harness:test:unit` | 2426 passed (incl. `test_compiled_config_open_bindings_task951.py`) |
| `/applications` FULL test | 13170 passed; the only failed file is `membership-bounded-sync.integration` (needs the live TEST DB — pre-existing, ports held by ALaaS); `workflow-exposure.service.test` fixed for `actingUserId: null` |
| `/applications` build + lint | build OK; 0 errors; prettier warnings in ticket files fixed; the 11 `require-description` warnings in `streamingSession.service.ts` predate lane E |
| `pnpm api:build`, `/api` vitest | build OK; 4379 passed; the only failure is the pre-existing `summary-provenance.spec` (TASK-932) |
| `/api` lint | 0 errors after prettier on `task-951-open-mappings.spec.ts` |
| `/vox-node` build / test / check:exports / lint / typecheck; `/vox-codegen` build / test / lint; `/vox` typecheck (deps built) | all exit 0 (35 test files; 76 tests) |
| `/admin-console` test / lint / build (deps built) | 2890 passed; lint clean; build exit 0 |
| Five artifacts | `route-manifest` unchanged; `openapi.json`, portal (admin 662 / business 200 ops), vox-node admin (49 areas, 422 routes, 428 schemas) regenerated, all `:check` no drift — merged `0a64878f3` |
| Seed on the dev DB (`RUN_SEED=all`, no reset) | exit 0; ArcaAI rows: `arcaai_consultation_scribe` TENANT default PUBLISHED v1, `arcaai_realtime_transcription` TENANT, `consultation_gen_arcaai` + `consultation_rheum_arcaai` `DELETED`, `consultation_note_context` clone no longer default; `realtime-transcription` agent bound to `79000000-…-0020` v1 |
| API e2e (worktree gateway 8869, `RESET_DB=false`, throttle toggled) | `task-951-open-mappings` **7/7**; `task-950-consultation-identity` **13/13** against the scribe (spec now resolves the schema GEN actually serves); `task-950-invocation-identity` **7/7**; `task-658` green after the reseed; `task-951-stt-context-echo` **6/6 live** once `apps/stt` was started from the worktree (413 over 4 KB, under-bound accepted, create echo + epoch, no-context byte-identical, `ready` epoch, every real transcript carries the context verbatim); `task-933` governing-run case fails only because the harness is down |
| **Lane E2 round** — `/api` vitest (whole suite, verify worktree at `c1ab18485`) | 4401 passed, 4 skipped; the only failure is the pre-existing `summary-provenance.spec` (TASK-932). The five gateway tests that went red after the merge were assertion-shape gaps (`sessionEcho` now always carries `metadataSpans`; the handshake reads meta + marks in ONE `Promise.all`, so an unmocked `lookupMetadataMarks` rejected the pair and dropped the negotiated sampleRate) — fixed in the tests, not the gateway |
| Lane E2 round — `/api` lint | 0 errors (65 pre-existing `require-description` warnings) |
| Lane E2 round — `/vox-node` build / typecheck / check:exports (publint "All good!") / lint / test | all exit 0; 36 files, 514 tests |
| Lane E2 round — `/database` `task-951-arcaai-two-schemas` test, `tsc --noEmit` | 27 passed (incl. the openBindings copy vs the real function, the re-freeze by content, the in-place v1 refresh, and the admin-pin guard); typecheck clean. `@arcaai/database` has no `lint` script; prettier applied |
| Dev DB after `RUN_SEED=all` (no reset) at `66d211539` | `✓ ArcaAI context schemas: 0 created, 2 already present (1 v1 definition(s) refreshed)` · `✓ realtime-transcription agent: refrozen`; `psql`: agent `compiledConfig.contextSchema.openBindings = {"streamContext":{"kindKey":"stream"}}`, `…payloadSchema.properties.stream.required = ["mic_ids"]`; version row `definition.kinds[1].fields.required = ["mic_ids"]`, checksum moved, `_version` 2. Before the fix the same queries returned NO `openBindings` and `["mic_id"]` |
| Live e2e, lane E2 (worktree gateway 8869 at `66d211539`, `apps/stt` up, throttle toggled) | `task-951-stt-metadata-spans` **5/5** + `task-951-stt-context-echo` **6/6** (11 passed, 24.9 s), the cascade resolving ArcaAI's `realtime-transcription` agent for the service account: oversized frame refused `METADATA_TOO_LARGE` with the session kept up; `mic_ids` frame accepted silently; **the ArcaAI-bound case** — a frame carrying `mic_id` + `micIds` refused `METADATA_SCHEMA_VIOLATION` with `problems` `['/mic_ids: required property is missing']`, then `{ mic_ids: [...] }` accepted with no new error; every real transcript carries spans clipped to its own `startTime`–`endTime`, contiguous, values verbatim, BOTH declarations seen; a session that never declares carries no `metadata` field; the create-time `context: { stream: { mic_ids } }` echoes verbatim with `sessionEpochMs`. Before the reseed the same run was 7/11: `CONTEXT_SCHEMA_VIOLATION /stream/mic_id` and no refusal on the bound case — the dev DB still carried the old shape |
| **Owner re-clarification round (single sticky `mic_id`; flat `metadata` + `metadataSpans`)** | Commit `9cca3a386`, verify worktree. `/applications` stt suite 179 passed (incl. `metadataInForce`: largest share, tie → earlier, zero-width window, the owner's six-frame sequence → `1,1,2,1,2,2`; bridge emits flat `metadata` + `metadataSpans` from ONE accessor read and neither key when nothing was declared) · `/api` streaming suite 422 passed, lint 0 errors, `api:build` 12/12, `openapi:check` OK · `/vox` typecheck clean, `SttWebSocketClient` 119 passed · `/vox-node` build / typecheck / check:exports ("All good!") / lint / test 514 passed · `/database` seed test 27 passed, `tsc --noEmit` clean · dev DB `RUN_SEED=all`: `1 v1 definition(s) refreshed`, agent `refrozen`; `psql`: `openBindings.streamContext.kindKey = stream`, `stream.required = ["mic_id"]` on the agent blob AND the version row (`_version` 3) · **live e2e 11/11 (29.2 s)** on gateway 8869 at `9cca3a386` with `apps/stt` up, the cascade resolving `realtime-transcription`: the ArcaAI-bound case refuses `{ mic_ids, micId }` with `/mic_id: required property is missing` and accepts `{ mic_id }` silently; every real transcript carries a flat `metadata` equal to one of the two objects sent plus `metadataSpans` clipped to its window, contiguous, containing that object; both `mic_id` values reached the transcripts; a session that never declares carries neither key; `context: { stream: { mic_id } }` echoes verbatim with `sessionEpochMs` |

### ALaaS hand-over (lane H, separate repo)

The change list in §Implementation Plan stands, with OD-4: map the browser `vitals[] { componentName, value, date }` into the normalised object (`bloodPressure`, `heartRate`, `respiratoryRate`, `temperature`, `oxygenSaturation`, `weightKg`, `heightCm`, `bmi`, `bloodGlucose`, `painScore`, `recordedAt`, `notes`); send `context.encounter { doctor_id: consultantId, event_id, department_code: departmentId, department_name, visit_type }` and `previous_case_notes { notes[] }`; drop `pushPriorCaseNotes` once verified; `npm run hope:codegen`.

**Microphone metadata, one mic at a time (R2 as the owner clarified it).** One standalone session per recording on `agentSlug: 'realtime-transcription'`. Optionally state the initial mic at create (`context: { stream: { mic_id: '1' } }`), then on the SAME `RealtimeSttSocket` call `socket.setMetadata({ mic_id: '2' })` every time the live microphone changes — the object is yours (`additionalProperties: true`; add `speaker_label`, `channel`, `source` or anything else), `mic_id` is the one required property, a frame that declares nothing inherits the last (sticky), and there is no timestamp to send: HOPE places the declaration on its own count of the PCM it has received, the same quantity `apps/stt` derives `startTime`/`endTime` from. Every transcript then carries `metadata` — the flat object in force over its audio, exactly the v1 shape, so `metadata.mic_id` reads as it always did — and `metadataSpans: [{ from, to, value }]` clipped to its own `startTime`–`endTime` (one entry normally; two when the switch fell inside the segment, in which case `metadata` is the value covering the larger share). A session that never declares anything gets neither field. Refusals leave the session up and answer on the error channel: `METADATA_TOO_LARGE` (over 2 KB), `METADATA_INVALID` (not an object), `METADATA_SCHEMA_VIOLATION` with `problems` (e.g. `['/mic_id: required property is missing']` for a frame sending `mic_ids` or `micId`). The browser SDK's `SttWebSocketClient.setMetadata` is the same call; `useArcaSpeechToText`'s client-side timeline (TASK-564) may later prefer these server-attested values — a follow-up, not part of this ticket.

## Change History

| Date | Entry |
|---|---|
| 2026-09-11 | Opened from the owner's consolidation ask. Five read-only discovery lanes (ArcaAI schemas, STT protocol, open-time resolution, ALaaS broker, decision sizing). Plan + OD table written; status Pending. |
| 2026-09-11 | Owner go. OD answers: 0 = TASK-951; 4 = the `vitals` kind is the NORMALISED object (bloodPressure, heartRate, respiratoryRate, temperature, oxygenSaturation, weightKg, heightCm, bmi, bloodGlucose, painScore, recordedAt, notes — all optional; ALaaS maps its payload into it); all other ODs = recommendations. Lanes A–G spawned in own worktrees (A/B/C/D/E opus, F/G sonnet) plus TASK-950 lane I; no lane runs gates — the orchestrator merges into `dev-2.2` and gates. Ownership split fixed one collision: `live-documentation.service.ts` (incl. its two visit-type call sites) is lane D's, the other eight call sites lane C's. |
| 2026-09-11 | All nine lanes merged; seed blobs regenerated; five artifacts regenerated; full gates + e2e run (table above). Two spec fixes for the seeded scribe (identity marker moved onto `vitals`; schema resolved instead of a retired slug). Status → **Review**. |
| 2026-09-11 | Owner clarified R2: metadata is per audio SPAN (one or more mic ids change while recording) and must come back time-synced on each segment. Session-level echo is insufficient. Lane E2 (opus, own worktree, no gates) spawned: `{type:'metadata'}` control frame, gateway audio clock (bytes ÷ (sampleRate×2)), span store in Redis, `metadata[]` spans clipped to each segment's window, validated against the schema's `streamContext` kind, SDK `setMetadata`. Status back to In Progress. |
| 2026-09-11 | Lane E2 merged (`a64ad6dd9`) and gated. First live run failed with `INTERNAL_ERROR` on every metadata frame: the worktree gateway was serving a stale `@arcaai/applications` dist without the new helpers (environment, not code — rebuilt, green). Mechanical fixes `f155a4bec`, `c1ab18485`. Reviewing the fixtures exposed a CONTENT gap the transport proof had hidden: the seeded `stream` kind still required a single `mic_id` and the agent's hand-frozen `contextSchema` carried no `openBindings`, so `resolveStreamMetadataSchema` never engaged and ANY object was accepted (verified on the dev DB row). Fixed in `4686caca4` + `66d211539`: `mic_ids: string[]`, `openBindings` frozen as `resolveReference` stamps it, the seed re-freezes a seed-owned pin by content and refreshes the seed-owned v1 in place, an e2e case names the ArcaAI agent and pins the `/mic_ids` refusal; SDK docs and fixtures use the seeded key. Dev DB reseeded and verified. Worktree `agent-ada4d0db695a1bb4e` removed after merge. Status → **Review**. |
| 2026-09-11 | **Owner correction: it must be ONE `mic_id`** — the sequence table (mic 1 → none → 2 → 1 → 2 → none returns 1, 1, 2, 1, 2, 2) describes the v1 behaviour ALaaS's labelling code already reads. Reverted the `mic_ids` set to a single sticky `mic_id`; reshaped the transcript wire so `metadata` is the FLAT object in force (v1 shape, `metadata.mic_id`) and the time-synced bounds ride beside it as `metadataSpans` (`metadataInForce`: the value covering the larger share of the segment, tie → earlier). Bridge, DTO, both SDKs' types/normalisers/docs, seed + seed test, e2e specs follow; the ArcaAI-bound e2e case now pins the `/mic_id` refusal. Dev DB reseeded (v1 refreshed, agent re-frozen). Commit `9cca3a386`; gates + live e2e 11/11 in the row above. Status stays **Review**. |
| 2026-09-11 | **Release round.** Seed review: no seed or catalogue field carries a context length — LM Studio's per-model load setting does (the cluster already runs `LMS_CONTEXT=16384` in `base/lmstudio.yaml`); the LOCAL gap was the JIT default of 8192, so `scripts/dev-stack.sh` now loads the text model at `LM_STUDIO_CONTEXT_LENGTH=16384` under the model-key identifier (mirrors `LMS_*`), and `dev-service.sh`'s default model is the catalogue's `gemma-4-e2b-it-qat` (was e4b). Fixed the long-red `summary-provenance.spec` (`redactionApplied` since TASK-932). CI: image scans skip `SDK-` tags — the `SDK-3.2.0` pipeline had died at creation with zero jobs because the scans' `build-*` needs never run on an SDK tag (`a6e16b075`). Tests: TS 44/46 turbo tasks (the two misses are the test-DB-bound `membership-bounded-sync.integration` and two admin-console files that pass alone, 51/51), text 1669, harness 2426, live e2e 34/36 with the two identity specs 15/15 alone (they share `identity.autoProvision.enabled` and race under parallel workers), ALaaS broker 15 suites / 310. SDK 3.3.0 published per `docs/operations/vox-sdk-release/README.md`; tags `SDK-3.3.0` + `ALL-2.2.0`; ALaaS `refactor-hope-integaration` fast-forwarded to the 3.3.0 deps + regenerated scribe context types (`85c287b`, `083f351`, not pushed). |
