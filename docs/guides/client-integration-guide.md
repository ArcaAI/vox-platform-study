# Client-side Development & Integration Guide

Everything a client developer needs to take a HOPE tenant from a credential to a signed,
closed consultation: which credential to ask for, how to turn the tenant's configuration into
TypeScript types, how to open a consultation and read back what you sent, how to stream audio,
how to finish, and how to learn that a run is done.

Two SDKs, one gateway:

| You are writing                                                         | Package               | Runtime                                         |
| ----------------------------------------------------------------------- | --------------------- | ----------------------------------------------- |
| A Node / Bun / Deno / edge service, a batch job, an integration adapter | `@arcaai/vox-node`    | Node >= 22, zero runtime dependencies, no React |
| A React consultation UI                                                 | `@arcaai/vox`         | Browser only, React 18.3 / 19                   |
| Either one's build pipeline                                             | `@arcaai/vox-codegen` | Node >= 22, build-time CLI                      |

Every snippet longer than a few lines in this guide is an excerpt from a **compiled file** under
`packages/vox-node/examples/`. Those files are type-checked on every build, so they cannot
silently rot; a snippet here that drifts from them is a bug in this guide.

Throughout, `<angle-bracket>` values are yours to fill in. Never put a secret on a command line —
`ps` shows argv to every process on the machine. Use the environment variable each flag names.

---

## 1. Credentials

There are two machine credential classes and one human one, and which routes they reach is a
property of the ROUTE, not of the SDK.

| Class               | Header                    | Reaches                                                                                                       | Who issues it                                     |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **API key**         | `X-API-Key`               | The business plane: consultations, STT, published agents and workflows. **Never** `/admin/*`, under any scope | A tenant admin, in the console                    |
| **Service account** | `X-Service-Account-Token` | The business plane **and** the admin plane                                                                    | A platform admin — a tenant admin cannot mint one |
| **Human JWT**       | `Authorization: Bearer`   | Whatever the signed-in user's role allows                                                                     | Sign-in                                           |

Passing both machine credentials to one `HopeClient` throws at construction. Pick one:

```ts
const hope = new HopeClient({ baseUrl: '<gateway-url>', apiKey: process.env.HOPE_API_KEY });
// or
const hope = new HopeClient({
  baseUrl: '<gateway-url>',
  serviceAccount: { clientId: process.env.HOPE_SVC_CLIENT_ID!, clientSecret: process.env.HOPE_SVC_CLIENT_SECRET! },
});
```

A service account exchanges its client id and secret at `POST /auth/service-token` for an opaque
token that lives about fifteen minutes; the SDK handles the exchange, the early refresh and the
re-exchange after a revocation. One thing differs from API-key intuition and catches everybody:
**a service account's working tenant is bound at the exchange**, so `X-Tenant-Id` is never sent
alongside it.

### Which preset to ask your tenant admin for

The console's create-key dialog offers three purposes before "Custom". Ask for the one that
matches what you are building, by name — the admin sees exactly these words:

| Purpose                           | Grants                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Use it for                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Consultation app**              | `consultation:session:read`, `consultation:session:write`, `consultation:report:read`, `consultation:report:write`, `stt:transcription:read`, `stt:transcription:write`, `stt:stream:write`, `stt:model:read`, `tts:speech:write`, `tts:voice:read`, `tenant:context-schema:read`, `tenant:profile:read`, `user:profile:read`, `user:preferences:read`, `user:preferences:write`, `user:settings:read`, `user:settings:write`, `prompt:template:read`, `dna-writing-style:ingest` | A clinic app that opens consultations, streams audio and reads summaries |
| **Type generation (build tools)** | `tenant:context-schema:read`, `agent:definition:read`, `workflow:definition:read`                                                                                                                                                                                                                                                                                                                                                                                                 | A build pipeline that generates types. Read-only                         |
| **Agents & workflows**            | `agent:definition:read`, `agent:invocation:write`, `workflow:definition:read`, `workflow:run:read`, `workflow:run:write`, `workflows:execute`                                                                                                                                                                                                                                                                                                                                     | A server that calls published agents and runs workflows                  |

The same three presets are `API_KEY_SCOPE_PRESETS`, exported from `@arcaai/types` and re-exported
from both SDKs, so a client can render them without retyping the list.

Two rules bound what any credential can do, and they compose with AND:

- **Scopes bind the credential; abilities bind the human it belongs to.** A key can never
  out-rank the person who created it.
- **No scope declaration at all means deny.** An absent scope is a 403, not an unknown.

### When you need a service account, and who issues it

Ask for one when your integration must reach `/admin/*` — subscribing a webhook, reading a
tenant's context schema for codegen without a human's browser session, driving consultations from
a back office on behalf of named clinicians. Only a **platform** administrator can issue one, so
this is a conversation with whoever runs the HOPE deployment, not with the tenant admin.

Scopes on a service account are `svc:`-prefixed twins of the API-key names — `svc:consultation:session:write`,
`svc:admin:workflow-run:read`. One family does not follow the convention and has to be requested by
name: `svc:webhook:event:read` and `svc:webhook:event:write` predate `svc:admin:*` and are **not**
implied by it. A service account granted every `svc:admin:*` scope still answers:

```
403 {"message":"Service account does not have required scope(s): svc:webhook:event:write",
     "error":"Forbidden","statusCode":403,"code":"HTTP.FORBIDDEN"}
```

---

## 2. Generate types

`@arcaai/vox-codegen` turns a tenant's live configuration into plain TypeScript with no runtime
imports, so one generated file serves a browser app, a Node service, or both.

### What a context schema declares

A tenant admin declares **kinds** — one per thing a consultation may carry. Each invents the
tenant's own vocabulary (`encounter`, `vitals`, `previous_case_notes`) but must name exactly one of
five platform primitives, which is what keeps that vocabulary on ground the platform understands:

| Primitive      | What it is                                     | Gets a generated type?                 |
| -------------- | ---------------------------------------------- | -------------------------------------- |
| `STRUCTURED`   | JSON validated against a declared field schema | **Yes**                                |
| `TEXT`         | Free text                                      | No — there is no payload shape to type |
| `STREAM_AUDIO` | The live recording, captured by an STT session | No                                     |
| `DOCUMENT`     | A file, with text extracted from it            | No                                     |
| `IMAGE`        | A file                                         | No                                     |

Kind keys share one grammar everywhere — lowercase letters, digits and underscores, two to
forty-eight characters — across the schema, the workflow bindings that name a kind, and the write
path. A tenant admin who renames a kind breaks every binding naming it, which is why section 6 of
the [Tenant Admin User Guide](./tenant-admin-user-guide.md) exists.

A schema is also **versioned and pinned**: published versions are immutable, and exactly one of them
is the pin discovery serves. Authoring is the tenant admin's job in the console; a machine that
genuinely has to author one does it through `hope.admin.*`, which needs a service account.

### One command per credential

An API key types what the tenant **publishes**. A service account additionally types the tenant's
**consultation context schema** — the declaration of what a consultation may carry.

```bash
# The tenant's published agents and workflows — API key
export HOPE_API_KEY=<tenant-api-key>
npx @arcaai/vox-codegen --api-key "$HOPE_API_KEY" --agents --workflows \
  --base-url <gateway-url> --out ./src/generated
```

```bash
# The tenant's consultation context schema — service account
export HOPE_SVC_CLIENT_SECRET=<service-account-secret>
npx @arcaai/vox-codegen --tenant <tenant-id> \
  --client-id <service-account-client-id> \
  --base-url <gateway-url> --out ./src/generated/consultation-context.generated.ts
```

A super-admin JWT works in place of the service account (`--token <jwt>`, or `HOPE_API_TOKEN`), but
a build pipeline wants the machine identity: it is revocable, and it does not expire when a person
goes on leave.

### What you get

The context-schema mode emits one named type per structured kind, the lookup maps, and —
the type you will actually use at a call site — `OpenConsultationContext`:

```ts
/** @schemaVersion 2 */
export type OpenConsultationContext = {
  encounter?: EncounterPayload;
  vitals?: VitalsPayload;
  previous_case_notes?: PreviousCaseNotesPayload;
};
```

It carries one property per structured kind the CLIENT produces before the consultation starts. A
kind the tenant marked required loses its `?`. Pass it to `open()` and the payload is checked
where you write it, not two network hops later.

The catalogue mode writes `agents.generated.ts` and `workflows.generated.ts`, each workflow input
type tagged with the schema its trigger is bound to and the review nodes in its graph:

```ts
/**
 * @contextSchema arcaai_consultation_scribe v1 (follows latest)
 * @reviewNodes n_review
 */
export type Workflow_GeneralMedicineConsultation_Input = {/* … */};
```

`follows latest` means the trigger validates against whatever version the tenant has pinned **at
the moment your consultation starts** — publishing a new version takes effect immediately, with no
republish. `pinned` means it validates against one frozen version whatever the tenant does next,
which is the case that can refuse you (chapter 3).

### Commit the output, and check it in CI

The generated file is committed source, like any other. Never fetch or generate it at application
boot. `--check` regenerates in memory, normalizes the timestamp header out, and exits 1 with a
diff instead of writing:

```bash
npx @arcaai/vox-codegen --tenant <tenant-id> --client-id <client-id> \
  --out ./src/generated/consultation-context.generated.ts --check
```

Drift is then a red build rather than a runtime refusal. `--check` and `--watch` are mutually
exclusive: a check is one snapshot, not a poll.

> **Codegen is an accessory to runtime discovery, never a replacement.** A tenant can publish a
> new kind between two runs of the generator. Keep reading the live declaration
> (`hope.tenants.contextSchema()` on the server, `useConsultationSchema()` in the browser) as the
> wire contract, and let the server be the final authority on any payload.

---

## 3. Open a consultation with typed context

`open()` is get-or-create, and it fixes identity for the whole visit. Everything downstream —
which workflow governs the consultation, which note template is used, which language the note is
written in — is decided here and read from the row afterwards.

```ts
const consultation = await hope.consultations.open<OpenConsultationContext>({
  patientId: '<your-patient-id>',
  context: {
    encounter: {
      event_id: 'EVT-88213',
      doctor_id: '<clinician-staff-id>',
      department_code: 'GEN',
      visit_type: 'new-visit',
      chief_complaint: 'Dry cough for three days.',
    },
    vitals: { bloodPressure: '128/82', heartRate: 88 },
  },
});
```

Full file, including the refusal handling below:
[`packages/vox-node/examples/07-typed-open-and-refusals.ts`](../../packages/vox-node/examples/07-typed-open-and-refusals.ts).

### The four markers: fields that are mapped, not just validated

A tenant admin can mark one field of a structured kind for each of four roles. A marked field is
**acted on**, which is why you never have to learn HOPE's own identifiers:

| Marker             | What the marked field does                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User identity      | For a service-account caller, the value is the clinician's **staff id as your own roster spells it**. HOPE resolves it to a tenant user and — when the tenant allows it — provisions one that does not exist yet. That user becomes the consultation's doctor. For a human or API-key caller the field is validated as ordinary content and otherwise ignored: that caller already is the clinician |
| Department         | The stated code (or name) selects the consultation's department, and with it the governing workflow and the note's shape                                                                                                                                                                                                                                                                            |
| Visit type         | Recorded on the row, where it outranks any `parentConsultationId` link for prompt and workflow selection                                                                                                                                                                                                                                                                                            |
| External reference | Your own encounter id, recorded as a label. It is **not** part of the re-open key                                                                                                                                                                                                                                                                                                                   |

A machine caller must name the clinician one way or the other: either `clinicianUserId` (a HOPE
user id) or the identity field. Sending both and disagreeing is a refusal, not a silent precedence.

Every validated kind is also persisted as a context item you can read back (chapter 4), and threaded
into the governing workflow's trigger.

### Every refusal, and what to do about it

A refusal carries `{ message, code, problems? }`. **Branch on `code`, never on the message**, and
show `problems[]` — one human-readable string per unmet requirement — to whoever can fix the
payload. The status is 4xx; most are 400, and the exceptions are marked below.

```
$ curl -X POST <gateway-url>/api/v1/consultations/open \
    -H "X-Service-Account-Token: <token>" -H 'Content-Type: application/json' \
    -d '{"patientId":"P-1","context":{"encounter":{"event_id":"E-1","visit_type":"new-visit"}}}'

{"message":"The supplied `context` does not satisfy this tenant's consultation context schema.",
 "code":"CONTEXT_SCHEMA_VIOLATION",
 "problems":["encounter: /doctor_id: required property is missing",
             "encounter: /department_code: required property is missing"],
 "statusCode":400}
```

| Code                                    | Status  | What it means                                                                                                              |
| --------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_SCHEMA_VIOLATION`              | 400     | The payload does not match the tenant's pinned schema. `problems[]` names each offending path                              |
| `WORKFLOW_CONTEXT_INCOMPATIBLE`         | 400     | The tenant's schema accepts it, but the governing workflow froze an older version and would refuse it. Nothing was written |
| `DEPARTMENT_UNKNOWN`                    | **404** | The department field resolved to no department in this tenant                                                              |
| `DEPARTMENT_AMBIGUOUS`                  | 400     | The department field matched more than one department — resolve by code rather than name                                   |
| `DEPARTMENT_MISMATCH`                   | 400     | The department named in the context is not the one the caller may open for                                                 |
| `VISIT_TYPE_INVALID`                    | 400     | The visit-type field carried a value outside the tenant's vocabulary                                                       |
| `CLINICIAN_REQUIRED`                    | 400     | A machine caller named no clinician. There is no safe default                                                              |
| `CLINICIAN_MISMATCH`                    | 400     | `clinicianUserId` and the identity field resolved to different people                                                      |
| `CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER` | 400     | A human caller supplied `clinicianUserId`. Remove it; the consultation opens for the authenticated user                    |
| `USER_IDENTITY_UNKNOWN`                 | **404** | The identity field held a staff id this tenant does not know and could not provision                                       |
| `USER_IDENTITY_AMBIGUOUS`               | **409** | The identity field matched more than one user                                                                              |
| `USER_IDENTITY_INVALID`                 | 400     | The identity field was present but not a usable staff identifier                                                           |
| `USER_IDENTITY_NOT_USABLE`              | **404** | The resolved user cannot act as a clinician in this tenant                                                                 |
| `USER_IDENTITY_DEPARTMENT_UNRESOLVED`   | 400     | The clinician resolved, but no department could be derived for them                                                        |

The union is `OPEN_REFUSAL_CODES` in `@arcaai/types`, re-exported from both SDKs — import it rather
than copying this table into a `switch`.

`WORKFLOW_CONTEXT_INCOMPATIBLE` is worth a second look, because it is the one refusal that is not
about your payload being wrong. It fires when the tenant's schema and the workflow that governs
the consultation disagree, and the fix is on the tenant's side: republish the workflow so its
trigger picks up the current schema, or send only what the frozen version declares. The check runs
on the create path only, and only when it is conclusive — if the governing workflow cannot be
resolved at all, the consultation opens **ungoverned** rather than being refused, because a
dependency outage must never stop a clinician starting a visit.

### Choosing the workflow yourself

Normally the department decides which workflow governs the consultation. A client that wants to
offer the choice can name one with `workflowDefinitionSlug`:

| Outcome                                                                         | Status                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------- |
| A slug not visible to your tenant — another tenant's, unknown, or not published | **404**, all three deliberately indistinguishable |
| Visible, but not a consultation workflow                                        | **403**                                           |
| A malformed slug                                                                | **400**                                           |

List what you may offer rather than guessing: the browser SDK's
`useSelectableConsultationWorkflows()` answers from the same predicate that authorizes `open`, so a
slug it lists is never refused and a slug it omits is never accepted. `null` and `[]` are different
states and must render differently — an empty picker on a network blip tells a clinician something
false about their tenant.

### Was it governed?

```ts
if (consultation.governingRun) {
  console.log(`governed by ${consultation.governingRun.workflowDefinitionSlug}`);
} else {
  console.log('this consultation is ungoverned — no workflow is watching it');
}
```

`governingRun` is on both `open()` and `get()`. It is derived from a marker persisted on the
consultation, never a live call into the workflow engine, so reading it costs nothing.

**Selecting is not running.** Dispatch is best-effort by design — a clinician must be able to open a
consultation while the workflow engine is down — so a dispatch failure degrades to an ungoverned
consultation rather than failing the open. Read back rather than assuming, and treat an unresolved
read as "we do not know", never as "nothing governs it".

---

## 4. Read back — and add to — context items

```ts
const items = await hope.consultations.listContext(consultation.id);
for (const item of items) {
  console.log(`${item.id}: kind=${item.kindKey} schemaVersion=${item.contextSchemaVersionId}`);
}
```

`kindKey` tells you which declared kind an item is, and `contextSchemaVersionId` which version it
was validated under — so a consultation opened before a schema publish is still readable as what it
was, not as what the schema says today. Both fields are always present and may be `null` for an item
written outside the schema (a plain case note, for example).

### Adding an item mid-consultation

`addContext` writes one item, on either of two paths:

```ts
// No schema involved — a plain clinical note.
await hope.consultations.addContext(consultationId, { type: 'CASE_NOTE', content: 'Reports intermittent chest pain.' });

// Schema-aware, PINNED to the version you built against.
await hope.consultations.addContext(
  consultationId,
  { type: 'STRUCTURED', kindKey: 'vitals', payload: { bloodPressure: '128/82', heartRate: 88 } },
  { contextSchemaVersionId: bundle.contextSchemaVersionId },
);
```

|                              |                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`type` is still required** | `kindKey` does not replace it. A kind says which declared vocabulary entry this is; `type` says what sort of item it is                                                                    |
| **Pin the write**            | `contextSchemaVersionId` travels as `X-Context-Schema-Version`. Omit it and the server validates against whatever is pinned _at that instant_ — rarely what a long-lived integration wants |
| **It fails fast locally**    | A `payload` with no `kindKey` throws before any request is issued, rather than surfacing as a 400 in production                                                                            |
| **It is never retried**      | The route accepts no idempotency key, so the SDK leaves this non-idempotent write alone. A duplicated clinical note is worse than a surfaced error                                         |
| **The body is closed**       | The gateway rejects undeclared fields wholesale — an extra key is a 400, not a silent drop                                                                                                 |

### Discovering the declaration at run time

```ts
const bundle = await hope.tenants.contextSchema({ departmentId });
if (bundle.schemaId === null) {
  // An unconfigured tenant: 200, every field null, `etag: "none"`. A real state, not an error.
}
```

Three things about that call:

- **Resolution is department default, then tenant default**, and only a _servable_ schema
  participates — published or approved, and carrying a pin. You get what the tenant **pinned**,
  never simply the latest published version.
- **Pass the `departmentId` of the consultation you are about to write to.** This is the sharp edge.
  An explicit `contextSchemaVersionId` on `addContext` wins outright, so discovering the _tenant_
  default and then writing into a department with its own vocabulary validates against a declaration
  that may not declare your kind. It surfaces as "does not declare a kind `x`", which reads like a
  typo rather than the scope mismatch it is.
- **Enum-ish fields are widened with `| string` on purpose.** A tenant can publish vocabulary a
  shipped SDK build has never seen, and a client one release behind must still parse the bundle and
  ignore what it does not recognize.

The bundle carries its own `etag`, so caching needs no header plumbing. `definition.outputs[]`
declares what the tenant's workflow is expected to _produce_ (a problem list, a structured note);
codegen types those too.

---

## 5. Stream audio

The browser SDK captures and streams audio for you (chapter 10). This chapter is for a **server
that already has audio** — a telephony bridge, a recording relay, an ingest worker.

```ts
const session = await hope.stt.createStreamSession({ context: { source: 'telephony-bridge' } });
await hope.consultations.recording.start(consultationId, { sessionId: session.sessionId });

const socket = hope.stt.socket(session);
socket.on('transcript', (event) => console.log(`${event.isFinal ? 'final' : 'partial'}: ${event.text}`));
await socket.connect();
```

Full file: [`packages/vox-node/examples/08-stream-audio.ts`](../../packages/vox-node/examples/08-stream-audio.ts).

Five facts that decide whether this works:

- **PCM16 little-endian, mono.** `socket.sendPcm16(frame)` sends one binary frame. Anything else
  is silence to the recognizer.
- **Node 22 or newer.** The SDK has zero runtime dependencies, so the socket is
  `globalThis.WebSocket` and nothing else. A runtime without it throws `SocketUnavailableError`
  rather than degrading into a transport you did not choose.
- **The handshake carries a single-use ticket, never a credential.** It is consumed at the first
  open, which is why a reconnect mints a fresh one and re-handshakes rather than replaying.
- **`socket.finalize()` ends the session.** It flushes the tail of the last utterance and closes;
  there is no grace window and no resume afterwards. It is the last thing you send, not mid-stream
  punctuation.
- **Which model runs is the tenant's decision.** Name a published speech-to-text agent with
  `agentSlug`, or name nothing and let the tenant's assignment cascade choose. There is no engine,
  model id or pipeline id to pass.

`session.context` (up to 4 KB) is echoed verbatim on every transcript of the session, so a
downstream consumer can attribute a segment without a second lookup. `socket.setMetadata(value)`
declares what is true from **here in the audio onward** — one microphone at a time, sticky until
the next call — and each transcript then carries the metadata that was in force over its own audio.
There is no timestamp to pass, deliberately: you cannot know how much of your audio the platform
has ingested.

### The literal frames on `/ws/stt/stream`

`RealtimeSttSocket` hides all of this — read this only if you are debugging with `websocat`, or
writing a client without the SDK. Binary WebSocket frames are audio, one PCM16 LE mono frame per
message, no envelope. Every other frame is JSON text:

```
client -> server
{"type":"metadata","metadata":{"mic_id":"left"}}     // sets the metadata in force from here on
{"type":"stop"}                                      // finalize the utterance; ends the session
{"type":"resume","sessionId":"…","lastSeq":42}        // reconnect handshake, on a FRESH ticket
{"type":"close"}                                      // real end, no grace window

server -> client
{"type":"ready","sessionId":"…","fromSeq":1}
{"type":"transcript","text":"…","isFinal":false,"seq":7,"startTime":0.4,"endTime":1.1}
{"type":"status","status":"transcribing","message":"…"}
{"type":"resumed","sessionId":"…","fromSeq":43}
{"type":"resume_failed","sessionId":"…","reason":"unknown_session"}
{"type":"resume_failed","sessionId":"…","reason":"buffer_overflow","minAvailableSeq":10}
{"type":"error","code":"…","message":"…"}
```

Resume is **in-band**, not a reconnect option: mint a fresh ticket (the old one is consumed),
open a new socket, then send `{"type":"resume", sessionId, lastSeq}` where `lastSeq` is the
highest `seq` you actually saw (`RealtimeSttSocket.lastSeq`). A successful `resumed` replays every
buffered transcript with `seq > lastSeq` — never a duplicate flood. `resume_failed` means a real
gap in the transcript (the buffer window was exceeded, or the session was never resumable), not a
hiccup to retry blind.

---

## 6. Live summary and events

Four server-sent streams, each a handler subscription returning `{ close() }`:

| Stream                                                     | Carries                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `hope.consultations.streams.liveSummary(id, handlers)`     | The running note — three payload kinds multiplexed on one channel                     |
| `hope.consultations.streams.liveAssist(id, handlers)`      | Suggestions and proposed corrections. **Carries PHI**; nothing on it has been applied |
| `hope.consultations.streams.harnessProgress(id, handlers)` | The governing workflow's stage list, re-sent in full on every change                  |
| `hope.consultations.streams.loop(id, handlers)`            | The agentic loop's own events                                                         |

```ts
const liveSummary = hope.consultations.streams.liveSummary(consultation.id, {
  onSnapshot(event) {
    console.log(`live summary: ${event.closed ? 'closed' : 'updated'}`);
  },
  onPreSummary(event) {
    console.log(`pre-summary: ${event.status}`);
  },
  onError(error) {
    console.error('live summary stream failed:', error);
  },
});
```

**`onError` is required on every one of them.** A subscription is fire-and-forget: a 403 with
nowhere to go is indistinguishable from a quiet consultation, and that is exactly how an
integration ends up rendering an empty note for an hour.

`liveSummary` is multiplexed, and the discriminator is the `event` field **inside the JSON**, never
the server-sent `event:` line. A snapshot with `closed: true` ends the stream by itself.

### When the governing workflow fails

A governed run that fails after the consultation has opened publishes one frame on the live-summary
channel:

```json
{ "event": "workflow.failed", "consultationId": "…", "workflowRunId": "…", "workflowDefinitionSlug": "…", "reason": "…" }
```

The consultation's own status does not change — the clinician keeps working, and the note is still
written, just without the workflow the tenant configured. `governingRun.status` flips to `FAILED`
on the row, so a later `get()` tells you the same thing.

There is no dedicated handler for this frame yet: it arrives at `onSnapshot`, so check
`event === 'workflow.failed'` there before treating the payload as a note snapshot. That is a known
gap, listed in chapter 11.

---

## 7. Stop, release the review gate, approve, close

The finish is four calls, in this order. Skipping one is the single most common reason an
integration ends with consultations stuck in `PENDING_REVIEW` forever.

```ts
await hope.consultations.recording.stop(consultation.id);
```

### Release the review gate

If the governing workflow parks on a human-review node, everything downstream of it waits —
durably — until somebody decides. Discover the node id rather than hardcoding it:

```ts
const schema = await hope.workflows.schema(consultation.governingRun.workflowDefinitionSlug);
for (const { nodeId } of schema.reviewNodes) {
  const review = await hope.workflows.reviews.get(slug, runId, nodeId);
  if (review.exists && !review.decided) {
    await hope.workflows.reviews.decide(slug, runId, nodeId, { decision: 'approved' });
  }
}
```

`reviewNodes` comes from the workflow's own published graph, so it survives a rename that a
hardcoded `'n_review'` would not. `exists: false` is the engine's own answer for a review that has
not started or has already settled — a real outage throws instead, which is what keeps a reviewer
queue from rendering empty during one. There is no `reviewerId` to send: the gateway stamps the
acting principal from your credential, because an approval is an attribution.

### Approve, then close

Both are guarded by optimistic concurrency. Read the row's `version` and pass it as `ifMatch` — a
missing one is a 428, a stale one a 412.

```ts
const latest = await hope.consultations.summaries.latest(consultation.id);
await hope.consultations.summaries.approve(consultation.id, latest.id, { clinicianUserId: '<clinician-user-id>' }, { ifMatch: latest.version ?? 1 });

const signed = await hope.consultations.get(consultation.id);
await hope.consultations.close(consultation.id, { clinicianUserId: '<clinician-user-id>' }, { ifMatch: signed.version ?? 1 });
```

Legal states, which is where 409s come from:

| Call                | Legal from            | Otherwise           |
| ------------------- | --------------------- | ------------------- |
| `summaries.approve` | `PENDING_REVIEW`      | 409                 |
| `close`             | `SIGNED`, `TIMED_OUT` | 409 — approve first |

`clinicianUserId` names the clinician the approval is attested for: required for a service-account
caller, refused for a human acting for themselves, 404 for a clinician outside the tenant. Pass
`ifMatch` as the version **number**; the SDK quotes it into the header form the gateway accepts.

Full journey: [`packages/vox-node/examples/06-realtime-consultation.ts`](../../packages/vox-node/examples/06-realtime-consultation.ts).

---

## 8. Read the note and the governing run

```ts
const closed = await hope.consultations.get(consultation.id);
const note = await hope.consultations.summaries.latest(consultation.id);
const sections = await hope.consultations.documentSections(consultation.id);
```

`documentSections` returns one row per section HOPE actually persisted — only the sections that
carry content — each with its `documentKey`, `sectionKey`, `title`, `idx`, `state` and `revision`.
Lay them onto the template you already hold and the partial note and the finished one render as one
document with the same keys and the same order.

`closed.governingRun` is the workflow side of the same question:

```ts
interface GoverningRunSummary {
  workflowDefinitionSlug: string;
  workflowRunId: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT';
  degraded: boolean;
  decidedAt: string;
  failureReason: string | null;
}
```

**Degradation is a flag, never a status.** A run that finished with some nodes degraded or skipped
is `COMPLETED` with `degraded: true`. The workflow engine's own words — `SUCCEEDED`, `DEGRADED` —
never reach you, on any surface. Branch on the flag.

`GET consultations/:id/workflow` answers the same object under `run`, alongside whether the
consultation is governed at all and which definition was selected.

---

## 9. Completion signals

**Both a webhook and polling work.** A workflow run emits exactly one event, on reaching a terminal
status, and a tenant webhook subscribed to the `WorkflowRun` resource type receives it.

Pick by what your process can afford:

| Signal                                              | Reach for it when                                               | Cost                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Hold the stream — `runAndStream` / `waitForRun`     | You want the lowest latency and can keep a connection           | One live connection per run. Server-sent events is the only lane that resumes |
| Poll — `getRun` until `isTerminalRunStatus(status)` | You have the `runId` and nothing else                           | A request per interval                                                        |
| Webhook                                             | Nothing of yours should be connected while the run is in flight | A public endpoint and a signature check                                       |

Full file: [`packages/vox-node/examples/09-completion-signals.ts`](../../packages/vox-node/examples/09-completion-signals.ts).

### Three ways to start a run, and when each is wrong

| Call                       | Shape                        | Watch out                                                                     |
| -------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `run(slug, body)`          | Returns a handle immediately | You now own the `runId`, and there is no way to re-discover it                |
| `runAndWait(slug, body)`   | Blocks until terminal        | The gateway's ~60s cap is a **ceiling, not a flake** — a 504 is never retried |
| `runAndStream(slug, body)` | Async generator of frames    | Resumes automatically; the right default for anything slow                    |

`streamRun` and `runAndStream` track each frame's opaque id and reconnect with `Last-Event-ID`, so a
dropped connection costs latency, not events. Use `isTerminalRunStatus(status)` rather than comparing
strings: the terminal set includes `TIMED_OUT`, and cancellation is spelled `CANCELED`, with one L.

### Workflow run over WebSocket

`transport: 'socket'` is an **option on the methods above**, not a different method — nothing else
in your code changes:

```ts
const run = await hope.workflows.run(slug, { input: { /* … */ } });

for await (const event of hope.workflows.streamRun(slug, run.runId, { transport: 'socket' })) {
  // Same frames, same order, same terminal event as the SSE lane.
}
```

The browser SDK takes the same option: `useWorkflowRun({ transport: 'socket' })` (chapter 10)
returns the identical shape — same `events`, `status`, `lastEventId`, `stopWatching()` — as the
default SSE lane.

Reach for it only when something between you and the gateway **buffers `text/event-stream`** — a
proxy that looks like the run stalled and then completed all at once. It is not a faster default:

- **SSE is the only lane that resumes.** `streamRun`/`runAndStream` reconnect with
  `Last-Event-ID` automatically. The socket has no such reconnect: a drop just ends the watch —
  mint a fresh ticket, open a new socket, and pass the last frame `id` you saw as `lastEventId` on
  the query string to pick the stream back up. Nothing is replayed for you in between.
- **`globalThis.WebSocket` is required — Node 22+, Bun, Deno or edge.** `@arcaai/vox-node` throws
  `SocketUnavailableError` rather than silently falling back to SSE, the transport you explicitly
  ruled out.
- **The ticket is minted by a different route than the JWT-only one.**
  `POST auth/stream-ticket` is user-JWT-only and refuses API keys and service accounts.
  `POST workflows/{slug}/runs/{runId}/stream-ticket` is the counterpart for unattended callers —
  reachable by an API key or a service account — and derives the scope itself as
  `workflow_run:{runId}`, so nothing wider than that run is ever minted. The SDK mints it and opens
  the URL the gateway returns for you; you never see the query string.

Every text message on the socket is the same `{ event, id?, data }` shape the SSE lane sends, one
JSON object per message — the first message is a snapshot and carries no `id`, every one after it
does:

```
{"event":"workflow.run.progress","data":{"runId":"…","status":"running","…":"…"}}   // snapshot, no "id"
{"event":"workflow.run.progress","id":"3","data":{"…":"…"}}                          // a later delta
{"event":"workflow.run.completed","data":{"status":"succeeded"}}                     // terminal, socket closes
```

There is no client-to-server frame on this socket — it is receive-only, exactly like the SSE run
stream.

### A workflow declares what it can do

A workflow carries its own contract, and the gateway enforces it rather than documenting it:

| Declared                                             | Governs                                                         | What you see                                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger kinds                                        | Which entry points exist — API, webhook, consultation, schedule | Starting a run on a workflow that does not declare an API entry point is a **404**. The route family exists; that workflow is not on it |
| Output protocols                                     | Which `?mode=` the run route admits                             | An undeclared mode is a **400**, never a silent downgrade                                                                               |
| The trigger's context schema and the output's schema | The input body and the result                                   | Published as the components `hope.workflows.schema(slug)` returns                                                                       |

That schema is tenant data, served live — it is deliberately not baked into the static API document,
which describes the generic route family only.

Two things make the webhook reliable rather than best-effort. The run's terminal status is no
longer written only when somebody reads it: a background watcher attaches to the run's event stream
independently of any HTTP connection, so a fire-and-forget run with no reader still completes and
still fires. And the run read model emits exactly one event, on the terminal transition — the start
of a run emits nothing — so a delivery **is** "the run finished". What stays true: the watcher is
per gateway process, so a run whose gateway restarts mid-run is reconciled on the next status read,
as before.

### Subscribing

Subscribing is an admin call. It needs a **service account** holding `svc:webhook:event:write`
(chapter 1), and a tenant admin does the equivalent from the console.

```ts
const { rawSecret } = await platform.admin.webhookEvent.create({
  name: 'workflow-runs',
  url: 'https://<your-service>/hooks/hope',
  resourceTypeName: 'WorkflowRun',
});
// rawSecret is shown ONCE. HOPE stores only a hash.
```

`resourceTypeName` is matched by plain string equality and validated against no list, so a typo is
accepted at create time and then never fires. Check the subscription's deliveries before blaming
your receiver.

### Receiving

The delivery body is **references, never content** — HOPE does not push resource data, PHI
included, to a third-party endpoint:

```json
{
  "eventType": "ResourceUpdated",
  "resourceType": "WorkflowRun",
  "resourceId": "<run-id>",
  "tenantId": "<tenant-id>",
  "occurredAt": "2026-09-17T10:15:30.000Z",
  "fetchUrl": "https://<gateway>/api/v1/admin/workflow-runs/<run-id>"
}
```

So a receiver verifies, enqueues, and then fetches what it needs with its own credentials.

```ts
import { WEBHOOK_SIGNATURE_HEADER, verifyWebhookSignature } from '@arcaai/vox-node';

if (!verifyWebhookSignature(rawBody, req.header(WEBHOOK_SIGNATURE_HEADER) ?? '', secret)) return 401;
```

`verifyWebhookSignature` is synchronous, dependency-free, constant-time, and never throws — a
malformed header, a wrong secret and a non-string argument all return `false`. Three silent failure
modes to avoid:

- **Parsing before verifying.** The digest covers the exact bytes on the wire; a
  `JSON.parse` → `JSON.stringify` round trip will never match.
- **Signing with the stored value.** The key is the `rawSecret` the create (or rotate) call
  returned, not anything you can read back later.
- **Falling through on a missing header.** That is just an attacker omitting it.

Rotation has no overlap window — rotating invalidates the previous secret immediately — so deploy
the new secret before rotating.

---

## 10. The same journey in the browser

`@arcaai/vox` is React-first and JWT-first. The gateway contract is identical; the SDK shape is not.

| Step                    | Server (`@arcaai/vox-node`)                           | Browser (`@arcaai/vox`)                                                      |
| ----------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Generate types          | Same CLI, same generated file                         | Same CLI, same generated file                                                |
| Read the declaration    | `hope.tenants.contextSchema()`                        | `useConsultationSchema()` — provider-owned, no fetch of your own             |
| Open                    | `hope.consultations.open<T>(request)`                 | `useArcaSession().open(input)`                                               |
| Capture audio           | You already have audio; push it (chapter 5)           | `useArcaAudio().start({ agentSlug? })` — capture, transport and lifecycle    |
| Live note               | `streams.liveSummary(id, handlers)`                   | The session's live-summary state                                             |
| Governing run           | `consultation.governingRun`                           | `useArcaSession().consultation.governingRun`, or `useConsultationWorkflow()` |
| A workflow run's status | `hope.workflows.getRun(slug, runId)`                  | `useWorkflowRun()` — exposes `degraded` and the node counts                  |
| Refusal details         | `error.problems` on `HopeAPIError`                    | `error.context.problems` on `AgenticError`                                   |
| Finish                  | `summaries.approve` then `close`, both with `ifMatch` | `useArcaSession().close()`                                                   |

Three browser-specific rules:

- **The browser never runs a model.** Voice activity detection, noise suppression, diarization,
  speech recognition and entity recognition are server-side decisions made by the tenant's
  published agents. Native `getUserMedia` constraints are not models and stay on; disable them per
  capture for raw clinical audio.
- **Selection is an `agentSlug`, or nothing.** Omit it and the tenant's department assignment
  cascade decides. There is no pipeline, engine or model id to choose.
- **`useConsultationSchema().validatePayload` validates against the session-pinned bundle**, which
  can differ from the version a governing workflow froze. A payload that passes locally can still
  be refused with `WORKFLOW_CONTEXT_INCOMPATIBLE`. Client-side validation is an ergonomic, the
  server is the authority.

### Capture, without a consultation

The narrow case — a live transcript and nothing else — is four steps.

```tsx
const { agents, tenantDefault } = useSelectableAsrAgents();
const { start, stop, transcriptSegments, currentTranscript, sttConnectionState } = useArcaAudio();

await start({ agentSlug, language: 'en', deviceId, secondaryDeviceId });
```

Two "nothing to show" states are deliberately distinct: `agents === null` means the read has not
resolved or has failed; `agents.length === 0` means the tenant has published no speech-to-text agent
and the platform default governs. `tenantDefault` names the slug the tenant-level assignment points
at — show it as a hint, but do **not** preselect it: a department assignment can still win at
resolution, and a slug sent on every start would silently override it.

Render `transcriptSegments` (each with `isFinal`, `speakerLabel`, and word timings when the engine
emits them) separately from `currentTranscript`, the interim string. Interim segments are replaced,
not appended. The SDK opens and refreshes the streaming session itself — do not hand-roll the
WebSocket.

### The four live streams

Each is a hook, and each carries **full-state snapshots**: keep only the latest and never merge
successive events.

| Hook                                | Carries                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `useArcaLiveSummary()`              | The running note, its sections, detected entities and vitals; `closed` is terminal |
| `useArcaLiveAssist(consultationId)` | Suggestions and proposed corrections. **PHI**                                      |
| `useConsultationEvents()`           | Append-only loop events — ids and short labels, no PHI                             |
| `useConsultationWorkflow()`         | The governing run                                                                  |

Three traps worth naming:

- **Entity offsets index the running summary**, not the transcript. Highlight the summary with
  `start`/`end`; match on the entity's `text` if you also want to mark up the transcript.
- **Nothing on the assist feed has been applied.** Each correction proposal's offsets index the text
  named by the snapshot's own content hash — check that hash against the text you are about to patch,
  or the offsets land on drifted content. The clinician decides; the platform proposes.
- **The loop stream does not resume.** A reconnect mints a fresh single-use ticket and sends no
  cursor, so events published while you were disconnected are gone and there is no server-side
  buffer. Read a complete history from where the loop persists it, not from this feed.

Finally: `close()`, `reopen()` and `prime()` are all optimistic-concurrency-guarded. The SDK echoes
the validator it read with the consultation and refreshes it from each response; a conflict surfaces
as an error to handle by re-loading and retrying, not by retrying blind.

---

## 11. Things that surprise people

### Re-opening is idempotent, and it does not re-dispatch

`open()` is get-or-create on `(patientId, appointmentDate, doctorId)`. A retry after a timeout
returns the consultation you already have rather than starting a second one — which is what makes
it safe to retry. Two consequences:

- The external-reference field is deliberately **not** part of that key, so two encounter ids
  against the same patient, date and clinician join one consultation.
- The re-open branch writes no context items and dispatches no workflow. Whatever was decided at
  create time stands.

Starting a workflow run has the same shape: `hope.workflows.run(slug, body, { idempotencyKey })`
derives the run id from `(tenant, slug, key)`, so a retry with the same key **joins the run already
in flight** rather than starting — and billing — a second one. Correct on a retry; a surprise if you
reuse a key across different payloads. The run input may not carry the reserved identity keys
(`consultationId`, `externalPatientId`, `userId`, `jobId`, `sessionId`); the SDK throws
`ReservedRunIdentityError` before the request leaves, because a silent drop would let you believe
you addressed a consultation the run never touched.

### You cannot list your runs

There is no business-plane run listing: no `GET /workflows/{slug}/runs`, no `GET /workflows/runs`. A
run is reachable only by a `runId` you already hold. Listing exists only on the admin plane
(`GET /admin/workflow-runs`), which an API key can never reach.

**Persist the `runId` the moment you get the handle.** If you lose it, an API-key integration cannot
recover it.

### `NotFoundError` can mean "not yours"

HOPE's tenancy posture is 404-over-403: a cross-tenant read or write returns 404, never 403. Do not
assume the id is wrong before checking tenant ownership. The exception is a privilege boundary —
a scope you do not hold is a 403, as in chapter 1's webhook example.

### Inbound webhooks — letting a third party start a workflow

The webhook in chapter 9 is outbound. The other direction also exists: a workflow whose trigger
declares `webhook` can be started from outside with no API key. An admin issues (or rotates) the
definition's secret, shown once, and the caller signs every request over the raw body:

```
X-Hope-Timestamp: <unix seconds>
X-Hope-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<rawBody>")
Idempotency-Key:  <optional>
POST /api/v1/hooks/workflows/<hookId>
```

The timestamp must be within five minutes, the signature is compared in constant time, and the body
must be JSON — it becomes the run's input and is validated against the trigger's context schema at
dispatch. **Every refusal is the same 404**: an unknown hook id, a stale timestamp and a bad
signature are indistinguishable from outside, so the hook URL is not an oracle. Success is a 202
with the run handle, always asynchronous — read the result through the stream or the completion
event.

### Symptom to cause

| Symptom                                                          | Cause                                                                                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery answers 200 with every field `null` and `etag: "none"` | The tenant has configured no schema. **Not** an error — branch on it                                                                            |
| `400` naming a missing `kindKey`                                 | A structured `payload` was sent without naming the kind it belongs to                                                                           |
| `400` on an apparently valid body                                | An undeclared field. Every request body is closed                                                                                               |
| `412` on an update                                               | A version drift. `428` means you omitted `If-Match` entirely                                                                                    |
| Types exist for some kinds only                                  | Only structured kinds carry a field definition; the rest get a comment, because there is no payload to type                                     |
| The wrong department's kinds were generated                      | Pass `--department <id>` to codegen — a department's schema shadows the tenant default                                                          |
| The schema changed but your types did not                        | Codegen is build time. Regenerate, or run `--check` in CI so the build tells you                                                                |
| A payload passed local validation and the server refused it      | Expected. Client-side validation is permissive by design; the server is authoritative                                                           |
| "does not declare a kind `<key>`" on a kind you can see          | You pinned a version from the tenant default while writing into a department with its own schema. Discover with that `departmentId` (chapter 4) |
| Published, but discovery still serves the old version            | The schema was moved back to draft, or an older version is pinned                                                                               |

### Known gaps

| Gap                                                             | Impact                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A `workflow.failed` frame has no dedicated live-summary handler | It arrives at `onSnapshot`; check `event === 'workflow.failed'` before treating it as a note snapshot (chapter 6)                                                                    |
| The completion watcher is per gateway process                   | A run whose gateway restarts mid-run has its terminal status recorded on the next status read instead of immediately                                                                 |
| No business-plane run listing                                   | A run is reachable only by a `runId` you kept                                                                                                                                        |
| `summaries.update()`'s `ifMatch` is inert                       | That route carries no concurrency guard server-side today; the SDK forwards the value forward-compatibly. Do not build conflict detection on it yet                                  |
| Browser consultation events do not resume                       | Frames published while disconnected are lost, with no server-side buffer                                                                                                             |
| Two job-status vocabularies                                     | `generateAsync` returns lowercase `pending`/`processing`/…; `jobs.get` returns uppercase `PENDING`/`RUNNING`/…. Use the exported `isTerminalJobStatus` rather than comparing strings |

---

## 12. What changed, per SDK release

The nine SDK packages are versioned in lockstep.

### 3.6.0 — `@arcaai/vox-node`

- `consultations.listContext(id)` reads every context item back, with `kindKey` and
  `contextSchemaVersionId` — fields the write response never carried.
- `open<TContext>(request)` is generic on `context`, so a generated `OpenConsultationContext`
  checks the payload at the call site.
- `ConsultationGetResponse` gains `language`, `metadata`, `parentConsultationId` and
  `governingRun`; `ConsultationOpenResponse` gains `governingRun`.
- `HopeAPIError.problems?: string[]`, lifted for every 4xx.
- `WorkflowSchemaDescription` gains `contextSchema` and `reviewNodes`.
- `WorkflowRunStatus` gains `degraded` and four node counts.
- `OPEN_REFUSAL_CODES`, `OpenRefusalCode`, `GoverningRunSummary` and `API_KEY_SCOPE_PRESETS` are
  re-exported from `@arcaai/types`. The package's zero-runtime-dependency guarantee is unchanged —
  the two constants are inlined into the built bundle.
- New examples: the full realtime consultation journey, typed open with refusal handling, streaming
  audio from a server, and completion signals.

**Read this before you upgrade:** `open()` can now refuse with `WORKFLOW_CONTEXT_INCOMPATIBLE`
(400). That is a new way an existing call can fail — a consultation whose context does not match
what its governing workflow accepts is refused synchronously on the create path rather than opening
ungoverned. Catch it alongside the other refusal codes. Everything else in this release is additive.

### 3.6.0 — `@arcaai/vox`

- `AgenticError.context.problems`, beside the existing `code`.
- `governingRun` on `useArcaSession().consultation` and on `useConsultationWorkflow()`.
- `useWorkflowRun().status` gains `degraded` and the four node counts.
- `WorkflowSchemaDescription` gains `contextSchema` and `reviewNodes`.
- `useConsultationSchema().validatePayload` documents that it validates against the session-pinned
  bundle, which a pinned workflow trigger may not share. Documentation only, no behavior change.

### 3.6.0 — `@arcaai/vox-codegen`

- `--check` for both modes: regenerate in memory, diff against what is committed, exit 1 on drift,
  write nothing. Mutually exclusive with `--watch`.
- The context-schema mode emits `OpenConsultationContext` and a `@schemaVersion` header tag.
- The catalogue mode emits `@contextSchema <slug> v<n> (follows latest | pinned)` and
  `@reviewNodes <ids>` on each workflow input type.
- Generated files no longer carry internal ticket references.

### Earlier releases

`3.5.0` added the finish half of the consultation plane — `summaries.approve()` and `close()`, both
optimistic-concurrency-guarded. `3.4.0` added `documentSections`. `3.3.0` added the session
`context` echo and `setMetadata`. `3.2.0` let codegen authenticate as a service account. Each
package's `CHANGELOG.md` has the full history.

---

## Related

- [`packages/vox-node/README.md`](../../packages/vox-node/README.md) — the server SDK reference
- [`packages/vox-node/examples/`](../../packages/vox-node/examples/) — every runnable example
- [`packages/agentic-sdk-v2/README.md`](../../packages/agentic-sdk-v2/README.md) — the browser SDK reference
- [`packages/vox-codegen/README.md`](../../packages/vox-codegen/README.md) — the generator's full flag reference
- [`tenant-admin-user-guide.md`](./tenant-admin-user-guide.md) — the console side: what your tenant admin has to configure before any of this works
