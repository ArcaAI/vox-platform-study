# TASK-939 — Realtime case note: incremental accumulation, not whole-note regeneration

| Field | Value |
|---|---|
| **Status** | `In Progress` — owner answered the ODs and said go |
| **Type** | `bugfix` + `feature` |
| **Branch** | `dev-2.2` |
| **Raised** | 2026-09-09, owner review of the realtime consultation workflow |
| **Predecessor** | TASK-891 R2/R3 (the incremental `DocumentSection` plane was built there; this ticket is about what it *writes*) |
| **Test asset** | `~/Downloads/YTDown.com_YouTube_Communication-Skills-A-Patient-Centered-_Media_S4wWClQhZaA_009_128k.mp3` — 13 m 18 s, owner-supplied |

---

## 1. Requirement Analysis

### 1.1 What the owner asked for (2026-09-09)

> when it run partial summarization using a segment of transcript, it always refresh by cleanup and
> redisplay the whole existing consultation case note contains some previous partial summary <-- it
> SHOULD NOT like that, it MUST follow the behavior of incremental adding partial summary into the
> current case note containing some previous summary parts.
>
> make sure we have best practices of agents workflow implemented, best performance, easy to
> configure, manage and test.

Reference behaviour the owner cited — the MS Teams Copilot **Facilitator** incremental summary workflow:

| Facilitator step | What it means for HOPE |
|---|---|
| **Active synthesis** — every 10–15 min, or when a topic concludes, synthesize the raw discussion into 1–2 punchy sentences | A turn produces a **new part**, not a new document |
| **Verbal confirmation (the "Checkpoint")** — pause and validate the summary before moving on | The clinician **confirms** a section; once confirmed it is authoritative |
| **Live adjustments** — refine the note on screen in real time from feedback | A later turn **appends** below confirmed content and only **revises** where the transcript contradicts it |

### 1.2 Decomposition

| Id | Requirement | Kind |
|---|---|---|
| **R1** | A partial-summary turn **adds** its new content to the existing case note. Text already published stays byte-stable unless the transcript contradicts it | defect |
| **R2** | The prior note is presented to the model **with its structure** (section keys/titles), never as an unlabelled blob | defect |
| **R3** | A CONFIRMED section **accumulates** machine appends instead of freezing — the behaviour the entity, the store and the OpenAPI description all already promise | defect (specified, never implemented) |
| **R4** | The clinician has a **checkpoint** affordance: confirm a section from the console (the gateway route exists and has no caller) | feature |
| **R5** | Agent-workflow best practice: the turn contract is authored on the **agent/workflow**, not hardcoded in the service | quality |
| **R6** | Performance: a turn's output cost is proportional to **new** content, not to the whole note | perf |
| **R7** | Configure/manage: the flush cadence knobs live in the settings registry, not a constructor `env` freeze; a **churn** metric makes the defect measurable | quality |
| **R8** | Test: a repeatable realtime replay using the owner's recording, asserting the accumulation invariant | test |
| **R9** | A session resumed on an existing consultation (stop→restart, pod restart, ownership handoff) **continues** the note instead of restarting it — §2.11 C-1 | defect |
| **R10** | A clinician's CONFIRMED section text is what the next turn's prompt sees — §2.11 C-2 | defect |
| **R11** | A superseded flush never leaves the transcript cursor advanced past content that reached no note — §2.11 C-3 | defect |

### 1.3 Explicit non-goals

- No change to the durable harness/Temporal finalisation path — the **realtime** lane only (same boundary as TASK-891).
- No new inference stack, no new provider adapter (`06-python-services.md`).
- No cluster manifest edits (`09-infrastructure-devops.md`).
- Not re-opening TASK-891's language / reasoning / dropdown scope.

---

## 2. Current State Evaluation

> Every claim below was read on `dev-2.2` at `27e895f47`. File:line references are that tree.

### 2.1 The defect, stated mechanically

There are two realtime lanes and **neither has an append path**. The graph lane replaces every
section body every turn (below); the legacy lane — the default, see §2.8 — replaces the whole note
object and has no per-section plane at all. Steps 2–3 below are graph-only; steps 1, 4 and 5 describe
what both do.

Every flush regenerates the entire document and replaces every section's body:

| Step | Where | What happens |
|---|---|---|
| 1 | `live-documentation.service.ts:2576` | TEXT returns the **whole** document; `sections = parsed` replaces the prior list wholesale |
| 2 | `publishSectionPatches` — `:3095` | iterates **every** section of the parse, every turn |
| 3 | `section-store.ts:163` + `applyFlushPatch` | calls `applyMachineContent(input.content, …)` — the full new body |
| 4 | `DocumentSectionEntity.ts:280-281` | `applyMachineContent` does `this.content = content` — an outright **replace** |
| 5 | `section.patch` → console | `content` is the full new body; `useDocumentSectionsStream` (`hooks.ts:417-437`) swaps the stored string |

So the console is a faithful renderer of a producer that rewrites everything each turn. That is the
"cleanup and redisplay the whole note" the owner sees. The client fold is already correct
(per-`(documentKey, sectionKey)`, revision-gated) — **the defect is upstream of it.**

The word `append` occurs exactly **once** in the whole write path — in a comment describing
behaviour that does not exist (`DocumentSectionEntity.ts:286`).

### 2.2 Why the model cannot preserve prior text even though it is told to

The operating frame added by TASK-932 §3.7 already says the right thing
(`live-documentation.service.ts:3941`):

> `2. This is an UPDATE, not a fresh note. Keep everything the running note above already records, extend a section the new transcript adds to, and revise one only where the new transcript contradicts it.`

But the prior note handed to the model alongside it is **structurally destroyed first**:

```ts
// document-shape-parser.ts:204-208
export function buildRunningSummary(sections: LiveSummarySectionDto[]): string {
  return sections
    .map((section) => section.content.trim())   // ← titles and section keys dropped
    .filter((content) => content.length > 0)
    .join('\n\n');
}
```

`priorNote = session.lastPayload?.runningSummary` (`:2432`) is that unlabelled `\n\n` join, rendered
into the prompt as `Current <title> so far:` (`buildTextUserPrompt`, `:3994`). The model is then
asked to emit a **keyed JSON document** against the compiled template schema.

So every turn the model must re-derive which prose belonged to which section, and re-emit all of it.
Instructing "merge, don't restart" against a prompt that structurally requires a full re-partition is
the contradiction at the centre of this defect.

`session.lastPayload.sections` — the same content **with** its titles — is in scope two lines away at
`:2451`. `buildRunningSummary`'s real job is to be the offset base for NER
(`document-shape-parser.ts:197-202`), which it should keep; it is simply the wrong thing to feed back
as the prior note.

### 2.3 The append path is specified in three places and implemented in none

| Source | What it promises |
|---|---|
| `DocumentSectionEntity.ts:264-268` | "A CONFIRMED section has been touched by a clinician, so a flush may **APPEND** to it but must never overwrite it" |
| `DocumentSectionEntity.ts:285-286` | "A machine write never demotes a CONFIRMED section … the clinician's touch is the higher authority and **survives the append**" |
| `consultation.controller.ts:1300` (OpenAPI, shipped) | "transitions it to `confirmed`, after which a flush **may append** but will never overwrite it" |

What the code does instead: `applyFlushPatch` refuses a CONFIRMED section outright with
`confirmed-no-overwrite` (`section-store.ts:163`). A confirmed section
therefore **freezes** — it stops receiving new clinical content for the rest of the encounter. Under
the facilitator model that is exactly backwards: confirming a checkpoint should make the note *safe to
keep extending*, not stop it.

### 2.4 The checkpoint has no UI

`DocumentSectionsView` (`case-note-column.tsx:99-136`) is read-only, and says so:

> "Per-section CLINICIAN EDITING is not wired here: no console-facing mutation endpoint exists yet for a single section"

That comment is now stale — `PATCH :id/documents/:documentKey/sections/:sectionKey` exists
(`consultation.controller.ts:1283-1334`, `If-Match` + ownership-gated). The badge renders
`confirmed` (`:78`) but **nothing in the console can ever produce that state**, so in practice every
section is PROVISIONAL forever and the `confirmed-no-overwrite` protection never engages.

### 2.5 Cadence has no checkpoint concept

| Trigger | Value | Where |
|---|---|---|
| segment threshold | 3 final segments | `agentic.context.liveFlush.segmentThreshold` |
| idle debounce | 5 000 ms | `agentic.context.liveFlush.idleMs` |
| min interval floor | 4 000 ms | `LIVE_DOC_MIN_INTERVAL_MS`, **constructor-frozen** at `:998` |
| topic / section boundary | **does not exist** | — |

With the TASK-934/935 measured STT geometry (~7 s finals), 3 segments ≈ a flush every ~21 s. Over the
owner's 13 m 18 s recording that is **≈ 38 whole-document regenerations**, each permitted up to
`LIVE_DOC_TEXT_MAX_TOKENS = 8192` output tokens (`:1002`). The facilitator's "every 10–15 minutes, or
when a topic concludes" has no analogue in the trigger set.

### 2.6 The note is the *only* cumulative artefact that is not accumulated

Everything else in the same function accumulates explicitly:

```ts
const entities  = this.groundEntitiesToNote([...priorEntities, ...extracted], runningSummary);  // :2681
const findings  = this.groundEntitiesToNote([...priorFindings, ...flushFindings], runningSummary); // :2689
const vitals    = this.mergeVitals(session.lastPayload?.vitals, flushVitals);                    // :2692
```

The note text is the exception. And because entity offsets are re-grounded against a `runningSummary`
that churns every turn, **the highlights are re-anchored every turn too** — a second, visible symptom
of the same root cause.

### 2.7 Two adjacent gaps found on the way

- **No durable hydration in the console.** `GET :id/documents/:documentKey/sections` exists precisely
  for this ("the `section.patch` SSE lane only emits while a flush is running, so a client that
  reloads mid-encounter reads its state here" — `consultation.controller.ts:1244-1248`) and the
  console never calls it. `useDocumentSectionsStream` folds from SSE only, so a mid-encounter reload
  shows skeletons until the next full rewrite.
- **No churn metric.** `publishStats` (`:5232`) reports `flushCount`, `summaryChars`, latencies and
  degrades — nothing that measures how much previously-published content a turn rewrote. The owner's
  defect is currently unmeasurable from the admin surface.
- **Config hygiene.** None of the 17 `LIVE_DOC_*` vars the constructor reads is declared in
  `turbo.json#globalEnv` (`grep` returns 0). `minIntervalMs`, `heartbeatMs`, `durableSnapshotMs`,
  `textMaxTokens`, `statsTtl` and the four groundedness knobs are constructor-frozen with no registry
  descriptor — the same "constructor freeze makes the control plane decorative" the service's own
  comment at `:983-986` calls out for the knobs it *did* fix.
  (Checked and **not** a finding: `LIVE_DOC_TEXT_PROVIDER`/`_MODEL` are only a non-DI fallback —
  selection resolves through `harnessPolicyService.resolveTextSelection(tenantId, 'live')` at `:4338`.)

### 2.8 On a default tenant the incremental plane does not run at all

`publishSectionPatches` is called under `if (graph)` (`:2742`), and the comment says why:

> "Only in graph mode: the legacy engine's contract is 'one document, global offsets', and emitting
> section patches from it would claim a granularity it does not have."

And the graph executor is **off by default**:

```ts
// consultation-gates.constants.ts:165
[CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY]: false,
```

`isGraphExecutorEnabled` (`:1654-1670`) resolves tenant → SYSTEM → this code default, and every
failure path also returns `false` ("absence resolves to the LEGACY engine, which is both fail-safe and
today's behaviour").

**So unless a tenant has explicitly switched it on, the realtime lane is LEGACY, and on that lane
there is no `DocumentSection` plane at all** — no rows, no `section.patch`, no per-section state
machine, no revision gating, nothing for the clinician to confirm. The console falls through to the
legacy branch (`case-note-column.tsx:707`), fed by `useSnapshotStream`'s `setSnapshot(parsed)`
(`hooks.ts:257`) — a wholesale replace of the entire note object on every flush.

That is the owner's symptom in its most literal form: on a default deployment the case note really is
torn down and re-rendered whole, every ~21 s, because **the only incremental machinery in the system
is behind a flag that is off**. It is also consistent with TASK-891 §2.1's observation that
`core."DocumentSection"` held **0 rows cluster-wide**.

This changes the shape of the ticket: §2.1–§2.3 describe what the graph lane does wrong *when it
runs*; §2.8 says that for most tenants it does not run. Both have to be answered — see OD-8.

### 2.9 The seeded prompt explicitly orders the behaviour the owner is reporting

The agent that produces the running note is `general-medicine-summarization` — *"The running per-turn
consultation note for General Medicine"* (`seed/25-agents.ts:396-411`), bound to
`SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID`. That template's body says
(`seed/07-prompt-template.ts:1733`, verbatim):

> "You maintain the RUNNING consultation note … The transcript you receive is PARTIAL and grows on
> every turn: **re-emit the whole note each time**, extend a section when the transcript adds to it,
> revise it when the transcript corrects it …"

**"Re-emit the whole note each time" is the reported defect, written down as an instruction.**

And it contradicts the runtime operating frame appended to the *same prompt* a few hundred tokens
later (`live-documentation.service.ts:3941`):

> "This is an UPDATE, not a fresh note. Keep everything the running note above already records …"

So the model receives both "re-emit everything" and "don't restart, extend" in one prompt, with the
prior note supplied between them as an unlabelled blob (§2.2). Given a direct instruction to re-emit
and no structural way to emit anything else, "re-emit" wins — which is exactly what is observed.

This is the one finding with a **same-day remedy**: the sentence can be rewritten independently of any
structural change, and the §6 harness measures whether it moves churn. It will not reach zero on its
own — an LLM told "extend" still paraphrases what it re-emits, and nothing *prevents* a rewrite until
the turn contract changes (OD-2) — but it is the cheapest available reduction and it de-risks the
larger work by giving us a BEFORE/AFTER number early.

### 2.10 "Merge" is a prompt convention, not a capability

There is no node, action or capability anywhere that represents *merge into the running note* as
distinct from *generate the note*:

- The Python interpreter's 11 `core.*` node types (`registry.py:52-192`) and 17 `core.action`
  capabilities (`action_catalogue.py:78-238`) are all generation or persistence. `_run_text_generation`
  (`nodes/core.py:1196-1209`) builds its user prompt purely from bound `in`/`context` — no prior-note
  input exists.
- The TS realtime registry says the same: a `core.agent` resolving `TEXT_GENERATION` "generates the
  running note" (`realtime-node-registry.ts:22-31`).
- Every merge behaviour in the system lives in one place — the string assembly in
  `buildTextUserPrompt` (`:3982-3986`).

That is the structural statement of §2.1: **accumulation is currently a request, not a mechanism.**
It is the premise behind OD-2's recommendation.

Two related facts, both verified: the Python harness's own realtime summary node
(`consultation_realtime.py`) has **no** prior-note input at all and rebuilds `summaries = []` per
invocation (`:292`), publishing verbatim through `publishInterpreterSummary` (`:5130-5165`) with no
`DocumentSectionStore` and no merge — but it is **retired as a node type** and unreachable
(`test_realtime_capability_nodes.py:791-817`), so it is a latent hazard on reactivation, not today's
cause. And `runGraphLane` threads `priorNote` and the delta **identically** to the legacy lane
(`:2477-2494`, `:2883-2888`), so §2.2 applies to both lanes equally.

### 2.11 Three further accumulation defects (from the continuity audit, each re-verified here)

These are real and independent of §2.1–§2.2. I checked each claim against the tree rather than taking
the audit's word for it — including its ranking, which does **not** hold for the reported symptom.

- **C-1 — a new session never reloads the persisted note.** The `LiveSession` literal (`:1132-1154`)
  has no `lastPayload` key and `StartLiveDocumentationParams` (`:415-421`) carries no field that could
  seed one; nothing in the service reads persisted note content back into it (`findLiveSnapshotRow`
  reads `.metaData` only, `:3854-3865`). With `priorNote === ''`, `buildTextUserPrompt` flips from
  *"Update the existing note … keep prior content"* to *"produce the running note now"* (`:3985-3993`)
  — a deterministic from-scratch regeneration.
  **Scope correction:** the audit ranked this the primary cause of the owner's symptom. It is not.
  `start()` is called from `POST :id/recording/start` (`consultation.controller.ts:842`) — **once per
  recording lifecycle**, not per partial-summary turn — and the `existing` fast-path (`:1109-1116`)
  preserves the session across reconnects that keep it alive. Partial summarizations therefore happen
  *inside* one session where `lastPayload` is intact. C-1 fires on **stop→restart, API pod restart,
  ownership handoff, and any reload that restarts recording** — a real note-restart defect, and a
  second one, not this one.
- **C-2 — a clinician's CONFIRMED text never re-enters the prompt.** `session.lastPayload = payload`
  (`:2735`) is unconditional and runs *before* `publishSectionPatches` (`:2742`), so a
  `confirmed-no-overwrite` refusal is logged (`:3116-3124`) and nothing reconciles `lastPayload`
  against the confirmed row. The DB row is protected; the next turn's prompt still shows the machine's
  version, so the model keeps re-proposing over the clinician's edit. Directly contradicts the
  facilitator's "live adjustments" step.
- **C-3 — a stale-generation race can strand transcript.** `session.flushedTranscriptCount = deltaEnd`
  is written at `:2579` (legacy) / `:2519` (graph), then the NLP call is awaited (`:2637`) and the only
  remaining `isStale()` check is *after* the cursor write (`:2649`). A `stop()`-forced flush (which
  bypasses the single-flight gate at `:2242`) superseding during that window returns via `dropStale`
  without ever reaching `:2735` — the delta's content is discarded while the cursor stays advanced.
  Sporadic gaps, not the per-turn symptom. Static-analysis finding, not reproduced.

None of the existing tests would catch any of these: the session-generation test's TEXT mock returns a
fixed constant regardless of the prompt, so a `priorNote` reset is invisible to it, and the
supersession test (`live-documentation.service.test.ts:821-862`) exercises only the TEXT-await window,
which is checked *before* the cursor write.

---

## 3. Decisions taken (owner may override)

| Id | Decision | Rationale |
|---|---|---|
| D-1 | The fix is in the **turn contract**, not in the prompt wording | "Keep prior content" is unenforceable against a model asked to re-emit the document. Making prior text un-emittable makes it byte-stable by construction |
| D-2 | `buildRunningSummary` **keeps** its current shape and job (the NER offset base). A separate structured renderer feeds the prompt | Changing it would move every entity offset |
| D-3 | The client fold, revision gating and per-section OCC are **unchanged** | They are correct; the defect is upstream |
| D-4 | Existing `section.patch` consumers keep working — `content` stays the full body, the additive field is new and optional | `@arcaai/vox-node` `onSectionPatch` and the browser SDK are published surfaces |
| D-5 | No change to the durable/finalisation path | TASK-891's boundary, restated |

## 4. Owner decisions — ANSWERED 2026-09-09

| Id | Answer | Source |
|---|---|---|
| **OD-1** | **New ticket TASK-939** | owner, explicit |
| **OD-2** | **(a)** — the agent emits per-section `{ addition, corrections[] }` and never re-emits prior text | owner, explicit |
| **OD-8** | **(a)** — graph mode becomes the realtime default and only that lane is fixed | owner, explicit |
| **OD-3** | **Implement the append** to a CONFIRMED section | owner said "go ahead"; taken on the recommendation below |
| **OD-4** | **One cadence** for now; no checkpoint-cadence engine until measurement asks for it | idem |
| **OD-5** | **Console confirm affordance in this ticket** | idem |
| **OD-6** | **`minIntervalMs` only** into the registry; declare the rest in `turbo.json#globalEnv` | idem |
| **OD-7** | **Env-var path** (`STREAM_E2E_WAV`) for the full run **plus** a committed ~2 min excerpt for CI | idem |
| **OD-9** | **Accept** — a resumed session inherits the persisted note | idem |

Six of the nine were not named individually; the owner's "go ahead" is taken as assent to the
recommendations recorded below, and each is flagged again at the point of implementation so a
reversal costs one wave, not the ticket.

### 4.1 The questions as put (recommendations retained for the record)

| Id | Question | Recommendation |
|---|---|---|
| **OD-1** | **Ticket number + placement.** Is this TASK-939, or a continuation of TASK-891 (whose R2 already said "incrementally, section by section")? | New ticket **TASK-939**, cross-referencing TASK-891 R2/R3 — the checkpoint/confirm model is new scope, and TASK-891 is already large |
| **OD-2** | **Turn contract shape.** (a) the agent emits per-section `{ addition, corrections[] }` and never re-emits prior text; (b) it keeps emitting the whole document and the *service* diffs it before writing; (c) fix only the prompt (§2.9) and stop there | **(a)**. (b) leaves the output-token cost and the paraphrase drift where they are — it only hides them. (c) is worth doing *first* (wave 0) but is not sufficient on its own: "merge" would remain a request rather than a mechanism (§2.10), and a model told to extend still paraphrases what it re-emits. Do (c) now, measure, then (a) |
| **OD-3** | **Append to CONFIRMED?** The entity, the store comment and the shipped OpenAPI all promise a flush may append to a confirmed section. Implement that, or keep today's hard freeze? | **Implement the append.** Freezing means a confirmed section stops receiving clinical content mid-encounter |
| **OD-4** | **Cadence.** Keep the current ~21 s cadence for every turn, or add a slower **checkpoint** cadence (the facilitator's 10–15 min / topic boundary) alongside it? | Keep one cadence for now and let the delta contract cut the cost; add a checkpoint knob only if measurement says the fast cadence still hurts. Avoids inventing a two-cadence engine before we have the number |
| **OD-5** | **Console confirm affordance** (R4) in this ticket, or split? | In this ticket — without it nothing ever reaches CONFIRMED and OD-3 is untestable end to end |
| **OD-6** | **Config lane.** Move the 9 constructor-frozen `LIVE_DOC_*` knobs into registry descriptors now, or only `minIntervalMs`? | Only the cadence-relevant ones now (`minIntervalMs`); declare the rest in `turbo.json#globalEnv` and leave the migration to a config-governance ticket |
| **OD-7** | **Test asset.** The converted 16 kHz WAV is 24.4 MB — too big to commit. Keep it out of the repo behind `STREAM_E2E_WAV`, or commit a trimmed 2–3 min excerpt as a fixture? | Env-var path for the full run **plus** a committed ~2 min excerpt so CI has something deterministic |
| **OD-8** | **Which lane, and does the flag flip?** The incremental plane exists only in graph mode, and `consultation.realtime.graphExecutor.enabled` defaults to **`false`** (§2.8) — so most tenants have no incremental machinery in the path at all. (a) turn graph mode ON as the realtime default and fix only that lane; (b) fix graph and additionally build a section plane for legacy; (c) fix graph, leave the flag off, ship this as opt-in | **(a)**. (b) means building a second incremental plane on an engine whose own contract is "one document, global offsets" — inventing granularity it does not have. (c) leaves the reported defect in place for every default tenant. (a) needs its own rollout evidence, which the §6 harness is exactly the instrument for — so I would gate the flip on the AFTER-churn measurement, not ship it blind |
| **OD-9** | **Session continuity (R9).** Seeding `lastPayload` from the persisted note on restart means a resumed session inherits machine text it did not produce. Accept, or scope R9 out? | Accept — the alternative is that every stop→restart silently discards the note so far, which is the same defect in a rarer costume |

## 5. Implementation Plan (on go)

_Ordering follows the layer chain: domain → applications → api → console, per `01-development-workflow.md`._

| Wave | Lane | Scope | Tier |
|---|---|---|---|
| **0** | **Z — the one-sentence prompt fix (§2.9)** | Rewrite `GENERAL_MEDICINE_SUMMARY_CONTENT`'s "re-emit the whole note each time" so the seeded template stops ordering the defect and stops contradicting the runtime operating frame. Seed test updated. Cheapest possible remedy; run immediately after wave 1's BEFORE measurement so we get an early AFTER number | `sonnet` |
| **1** | **A — measure first** | Churn metric on `LiveDocSessionStatsResponse` + the replay harness (§6) run against today's code, to capture the BEFORE number | `sonnet` |
| **1** | **B — prompt structure (R2)** | Structured prior-note renderer from `lastPayload.sections`; `buildTextUserPrompt` takes it instead of the flat blob. Unit tests on the rendered prompt | `sonnet` |
| **2** | **C — turn contract (R1, R5, R6)** | Agent output schema → per-section `{ addition, corrections[] }`; parser; `DocumentSectionEntity.appendMachineContent`; `applyFlushPatch` append mode; `section.patch.appended`. Seeded agent prompt updated | `opus` |
| **2** | **D — append to CONFIRMED (R3)** | The `machineMayOverwrite` branch becomes append-not-refuse; contradiction guard unchanged | `opus` |
| **2** | **H — session continuity (R9, R10, R11)** | Seed `lastPayload` from the persisted note when a session starts on a consultation that already has one; reconcile `lastPayload` against a `confirmed-no-overwrite` refusal; move the cursor write after the last `isStale()` check. Same file as C/D ⇒ **same writer**, sequenced after them | `opus` |
| **3** | **E — console (R4)** | Per-section Confirm wired to the existing PATCH (`If-Match` from the GET); hydration from `GET …/sections` on mount; render `appended` with a brief highlight | `sonnet` |
| **3** | **F — config (R7)** | `minIntervalMs` → registry descriptor; declare the `LIVE_DOC_*` set in `turbo.json#globalEnv` + `.env.sample` | `sonnet` |
| **4** | **G — verify** | Re-run the harness; AFTER vs BEFORE churn; both themes + axe on the console change | orchestrator |

Waves 2 and 3 are one writer per package per `14-multi-agent-worktrees.md` §3; C and D touch the same
files and are therefore **one** agent, not two.

## 6. Verification Criteria

### 6.1 The accumulation invariant (the test that encodes the owner's requirement)

Capture every `section.patch` for a session. For each `(documentKey, sectionKey)`, across consecutive
revisions `r → r+1`:

> `content[r]` MUST be a **prefix** of `content[r+1]`, unless the turn carried an explicit
> `corrections[]` entry naming the contradicting transcript span.

Reported as **note churn** = characters of previously-published content that changed, per flush.
Today's expected value is large and non-zero on nearly every turn; the target is **0** except on an
explicit correction.

### 6.2 Replay harness

Reuses the existing machinery — no new transport code:

- `tests/helpers/streaming.helper.ts` already provides `createStreamSession`, `openStreamSocket`,
  `loadPcm16`, `feedFramesRealtime`, and the `STREAM_E2E_WAV` override.
- The owner's recording is already converted and verified:
  `ffmpeg -i <mp3> -ac 1 -ar 16000 -sample_fmt s16 patient-centred-interview-16k.wav`
  → **pcm_s16le, 16 000 Hz, mono, 797.9 s** (checked with `ffprobe`).
- The spec opens a consultation, feeds the audio at real-time pace, subscribes to the `section.patch`
  plane, and asserts §6.1 plus: no section ever shrinks without a contradiction; entity highlights are
  not re-anchored on a turn that added nothing.

### 6.3 Gates

`pnpm --filter @arcaai/domains test` · `pnpm --filter @arcaai/applications build test` ·
`pnpm api:build` + `pnpm test:unit` · `pnpm --filter @arcaai/admin-console build lint test` ·
the five API artifacts regenerated together if any route changes (`05-nestjs-api.md` DoD).

---

## 7. Implementation Summary

_Not started — plan awaiting owner decisions and go._

## 8. Change History

| Date | Change |
|---|---|
| 2026-09-09 | Ticket raised from the owner's review. Read-only audit of the realtime lane; §2 findings recorded with file:line evidence. Test recording converted and verified. **Status `Pending` — awaiting the OD answers and an explicit go before any code.** |
| 2026-09-09 | Continuity audit returned; its three findings (C-1/C-2/C-3) re-verified here and recorded as §2.9 + R9–R11. **Its ranking was corrected**: it proposed C-1 (a resumed session never reloads the note) as the primary cause of the reported symptom, but `start()` fires on `POST :id/recording/start` — once per recording, not per turn — so partial summarizations run inside one session where `lastPayload` is intact. C-1 is a real second defect (stop→restart, pod restart, ownership handoff), not this one. Separately verified that `consultation.realtime.graphExecutor.enabled` defaults to `false`, so on a default tenant the incremental plane does not run at all (§2.8) — this reshapes OD-8. |
| 2026-09-09 | Harness/graph audit returned; findings re-verified here. **The decisive one**: the seeded platform prompt bound to `general-medicine-summarization` literally instructs *"re-emit the whole note each time"* (`07-prompt-template.ts:1733`), contradicting the runtime operating frame in the same prompt — recorded as §2.9 and given its own **wave 0**. Also confirmed: no node/action/capability anywhere expresses "merge" as distinct from "generate" — accumulation is a prompt convention, not a mechanism (§2.10); `runGraphLane` threads `priorNote`+delta identically to legacy, so §2.2 applies to both lanes; the Python harness realtime-summary node has no prior-note input and no merge, but is retired as a node type and unreachable, so it is a reactivation hazard, not today's cause. |
| 2026-09-09 | **Owner answered: OD-1 new ticket TASK-939, OD-2 (a), OD-8 (a), and said go.** §4 rewritten as the answer table; the six unnamed ODs taken on the recorded recommendations. Status → `In Progress`. Execution starts at wave 0. |
