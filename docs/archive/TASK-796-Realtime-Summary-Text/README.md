# TASK-796 — Make realtime summaries actually reach the clinician

| | |
|---|---|
| **Status** | Review |
| **Type** | feature |
| **Branch** | `feat/task-796-realtime-summary-text` (worktree `hope-v2-task-796`, based on `dev-2.2` @ `cbd21e14b`) |
| **Owns** | `apps/harness/**` only |
| **Requirement** | R3 — *"realtime evaluate and provide short summaries"*, and *"during the consultation it MUST autofill summaries and gist into customized SOAP forms"* |

---

## 1. Requirement Analysis

TASK-791 built the three R3 capabilities that had no node at all —
`consultation.realtimeSummary`, `consultation.suggestions`,
`consultation.proposeCorrections`. They generate correctly. **Nothing they generate is ever
displayed.**

`interpreter.consultation_realtime_summary` announces itself on the loop plane with
`kind: "summary.interim"` and `data: {kindKey, ordinal, total, chars}` — progress metadata. The
console renders a progress indicator. A character count is not a summary. The other two nodes
have no delivery mechanism whatsoever: their output reaches downstream graph nodes and the run
result, and stops there.

So the ticket is a DELIVERY ticket, not a generation ticket, and it is bounded by two properties
that must survive it.

### The boundary that must NOT be widened

`EmitLoopEventInput` (`apps/harness/src/harness/temporal/models.py:1464`) is
`model_config = ConfigDict(extra="forbid")`, and its docstring states the channel carries
*"ids/keys/labels only, NEVER note or transcript text: the channel is a live UI feed, not a PHI
transport."* Adding summary text to the loop event would push clinical text onto a channel
explicitly designed not to carry it. **The loop event is unchanged by this ticket**, and two
tests now assert that structurally (§6, `TestLoopEventBoundaryUnwidened`).

---

## 2. Current State Evaluation — verified against source, not against description

The brief described an existing live-summary plane and asked this ticket to feed it rather than
invent a second delivery mechanism. That description is **accurate about the plane and wrong
about harness's access to it**, and the difference decided the design. Everything below was read
from source on 2026-08-23.

### 2.1 The plane exists and is the right destination — CONFIRMED

| Piece | Location |
|---|---|
| Redis channel | `consultation:live-summary:{id}` — `live-documentation.service.ts:318` |
| Payload | `LiveSummaryEventDto` — `…/live-documentation/dto/live-summary.dto.ts`, carrying `runningSummary`, `sections[]`, `entities[]`, `metadata`, `updatedAt` |
| SSE relay | `GET /consultations/:id/live-summary/stream` — `subscribeToLiveSummary`, `live-documentation.service.ts:1487` |
| SDK hook | `useArcaLiveSummary` — `packages/agentic-sdk-v2/src/hooks/useArcaLiveSummary.ts`; route constant `core/constants.ts:72` |
| Console | `apps/admin-console/src/features/playground-consultation/components/scribe/case-note-column.tsx:188` |

### 2.2 Harness CANNOT write to it today — the finding that shaped the design

Two independent reads, both negative:

1. **`LiveDocumentationService` has no ingest-an-external-snapshot method.** Its entire public
   surface is `start`, `stop`, `isActive`, `ingestSegment`, `handleContextAdded`,
   `handleContextRemoved`, `flush`, `subscribeToLiveSummary`. Every one of those either *starts
   its own* generation loop or *feeds transcript into* it. `flush` generates from the session's
   own accumulated transcript via its own TEXT call — it cannot be handed a summary.

2. **None of the 18 `/internal/harness/*` routes accepts clinical summary text.** Enumerated
   from `apps/api/src/modules/consultation/harness-internal.controller.ts`: `policy`,
   `prompt-templates/:id/resolved`, `mcp-token`, `consultations/:id/entities` (POST+GET),
   `…/assemble`, `…/draft`, `…/gate-decision`, `…/escalation`, `…/assurance`,
   `…/assurance-event`, `…/progress`, `…/loop-event`, `trajectory`, `loop-config`,
   `…/context-items/:id/extracted-text`, `…/live-documentation/start`,
   `…/live-documentation/stop`, `stt/batch-jobs` (POST+GET).
   - `live-documentation/start` / `stop` DISPATCH the gateway's own watcher (controller
     lines 675–705). They start Substrate A's engine; they do not carry a summary.
   - `loop-event` and `assurance-event` are ids/labels only.
   - The **only** text-accepting write is `POST …/consultations/:id/draft`, and it creates a
     **`RAW_SUMMARY`** ContextItem — the final draft note
     (`harness-internal.service.ts:714`, `:756`). Wrong kind for an interim summary; N windows
     would create N draft notes; and it is precisely the row TASK-795's exclusivity gate
     governs. Using it here would be a second writer on one document.

**Conclusion: the plane is correct and must be reused, but reaching it needs exactly one new
gateway route.** That route is `apps/api/**` — owned by NOBODY per the ownership map — so it is
requested (§7), not built here.

### 2.3 A brief assumption that source contradicted — recorded, not silently followed

> W2: *"Respect the tenant's `ConsultationContextSchema` where the existing path already does."*

**The existing path does not.** `soap-parser.ts:13` hardcodes
`['Subjective','Objective','Assessment','Plan']`, and `live-documentation.service.ts:86`
hardcodes the matching prompt instruction. There is no `ConsultationContextSchema` read anywhere
in `live-documentation/**` (grepped: the model appears only in `packages/database/**`).

Mirroring the shipped four-section contract is therefore **matching the live plane**, not adding
a hardcoded taxonomy — the consumer on the other end of that channel parses exactly those
titles. A graph author who wants a different form supplies `config.systemPrompt`, which is where
a workflow-governed engine's customization belongs. Making the live plane genuinely
schema-driven is one change in ONE place (the default engine) and is filed as a requested
contract rather than forked into harness.

---

## 3. Delivery Design

```
                                   ┌──────────────────────────────────────────┐
  interpreter node (apps/harness)  │  summary TEXT  →  publish_live_summary   │
                                   └──────────────────────────────────────────┘
                                                     │  POST /internal/harness
                                                     │       /consultations/:id/live-summary
                                                     ▼
                        gateway relays VERBATIM onto  consultation:live-summary:{id}
                                                     │        (the EXISTING channel)
                                                     ▼
                     GET /consultations/:id/live-summary/stream   (existing SSE route)
                                                     ▼
                          useArcaLiveSummary  →  case-note-column   (existing consumers)

  ── and, unchanged ──
  interpreter node  →  report_loop_event  →  consultation:loop:{id}   {ordinal, total, chars}
                                                     ids and counts only. No text. Ever.
```

Three properties make this the smallest thing that can work:

1. **One new route, zero new consumers.** The channel, the SSE relay, the SDK hook and the
   console panel are all reused as-is. A graph-governed consultation produces the same live SOAP
   experience the default engine does because it produces the *same payload on the same channel*.
2. **The loop plane is untouched.** The announcement still carries `{ordinal, total, chars}`.
   The text takes a different road.
3. **Delivery is best-effort, exactly as the announcement already was.** A publish that fails
   costs the DELIVERY of that window — never the summary, never the node, never the run. This is
   `report_loop_event`'s own documented posture, applied consistently.

### 3.1 Suggestions and corrections get their own plane

There is no existing plane for them, so one is proposed — a single route with a `kind`
discriminator, not two:

`POST /internal/harness/consultations/:id/live-assist` → `consultation:live-assist:{id}` →
`GET /consultations/:id/live-assist/stream`.

Why not reuse `live-summary`: the payload is not a running note. Each item is an **actionable
proposal** with its own id and a `PROPOSED` state a clinician resolves; folding them into the
summary snapshot would force the note panel to re-render on every suggestion tick and would
conflate "what was said" with "what you might do about it". Why not the loop plane: a correction
proposal necessarily quotes clinical text, which that channel forbids.

`live-assist` is declared, deliberately, as a **PHI-carrying** per-consultation stream — the same
class as `live-summary`, behind the same `TenantOwnedResourceSseGuard`. That is the whole reason
it is a sibling of `live-summary` and not of `loop`.

### 3.2 A correction proposal is not a summary

Three properties, all tested:

- **Stable identity.** `proposalId` / `suggestionId` are content-derived SHA-256 prefixes, not
  `uuid4`. A Temporal activity retries; a retry that re-published the same proposal under a
  fresh id would resurrect an item the clinician already dismissed.
- **Span binding.** The envelope carries `textSha256` — the digest of the exact bytes the spans
  were measured against. A console that holds drifted text can refuse the accept rather than
  splicing a replacement over the wrong characters. This is the same failure mode
  `_verified_proposals` already guards locally, extended across the wire.
- **Proposal-first on the wire, not only in the output.** `applied: false`, `appliedCount: 0`,
  every item `status: "PROPOSED"`, source text returned byte-identical. A system that silently
  rewrites a drug name or a dose is a patient-safety defect, so the property is asserted at both
  ends.

### 3.3 Configuration posture

Unchanged and re-verified: provider/model selection resolves tenant → SYSTEM through
`get_policy(task_key=…)` (the `AiTaskDefault` overlay) and **fails CLOSED** — an unresolved
selection DEGRADES the node, and no env default is ever substituted. No model, engine or
endpoint literal was added. LLM work stays delegated to `apps/text`; NER stays with `apps/nlp`.
Harness grows no second inference stack.

---

## 4. Implementation Summary

### Files changed (all inside `apps/harness/**`)

| File | Change |
|---|---|
| `src/harness/services/api_client.py` | **+** `publish_live_summary()`, `publish_live_assist()` — the two delivery calls, raising `ApiServiceError` like every other method so the calling node stays the swallow layer |
| `src/harness/temporal/interpreter/nodes/_soap.py` | **NEW** — Python mirror of `soap-parser.ts`: `parse_soap_json`, `parse_soap_sections`, `build_running_summary`, `sections_for`, `SOAP_OUTPUT_INSTRUCTION`, `SOAP_RESPONSE_FORMAT` |
| `src/harness/temporal/interpreter/nodes/consultation_realtime.py` | W1 publishes a cumulative SOAP snapshot per window; W2/W3 gain stable ids, `PROPOSED` status, provenance and delivery; `text_digest()` + `_stable_id()` helpers. **Loop-event emission byte-unchanged.** |
| `tests/unit/temporal/interpreter/test_realtime_delivery.py` | **NEW** — 14 tests: the delivery, and the boundary |
| `tests/unit/temporal/interpreter/test_soap_sections.py` | **NEW** — 10 tests pinning parity with the TS parser |
| `tests/unit/services/test_live_delivery_client.py` | **NEW** — 5 tests pinning the exact wire bodies TASK-797 renders |
| `tests/unit/temporal/interpreter/test_realtime_capability_nodes.py` | `_FakeApi` records publishes; one suggestion assertion updated for the added identity fields |

### Not changed, deliberately

- `temporal/models.py` — `EmitLoopEventInput` is untouched.
- `temporal/workflows.py`, `interpreter/workflow.py` — untouched, so **replay compatibility is
  structural**, not merely tested. No new workflow command, no changed command sequence.
- `apps/api/**`, `packages/**` — outside this ticket's ownership.

---

## 5. Work Items

| Item | Status | Delivered |
|---|---|---|
| **W1** — persist and deliver the interim summary | **DONE (harness half)** | Per-window publish of a cumulative snapshot onto the existing live-summary plane; loop event unchanged. Blocked on the gateway route (RC-1) before a clinician sees pixels. |
| **W2** — keep the SOAP shape | **DONE** | `_soap.py` mirrors the default engine exactly; default prompt + `response_format` ask for SOAP; unstructured output degrades to one `Running Summary` section rather than crashing or fabricating. `ConsultationContextSchema` finding recorded in §2.3. |
| **W3** — deliver suggestions and corrections | **DONE (harness half)** | `live-assist` plane; stable ids; `textSha256` span binding; proposal-first preserved end to end. Blocked on the gateway route (RC-2). |

---

## 6. Evidence

Every command below ran in the **worktree** `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-task-796`.

> **Which checkout ran.** The conda env `arcaenv` has an editable install pointing at the PRIMARY
> checkout, so an unqualified run tests the wrong tree:
>
> ```
> $ python -c "import harness; print(harness.__file__)"
> harness -> /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/harness/src/harness/__init__.py   ← WRONG TREE
> ```
>
> Every run below therefore sets `PYTHONPATH=$PWD/apps/harness/src`, proven to redirect:
>
> ```
> $ PYTHONPATH=$PWD/apps/harness/src python -m pytest /tmp/ck_tree.py -q -s
> HARNESS_PKG: /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-task-796/apps/harness/src/harness/__init__.py
> NODE_MODULE: /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-task-796/.../nodes/consultation_realtime.py
> 1 passed in 0.23s
> ```
>
> `conda run -n arcaenv` itself is unusable in this sandbox (`__conda_exe: permission denied`), so
> the env's interpreter is invoked directly at
> `/Users/taphuynh/miniconda3/envs/arcaenv/bin/{python,ruff,mypy,black}` — the same binaries
> `pnpm harness:*` wraps.

### 6.1 RED — before the implementation

```
$ PYTHONPATH=$PWD/apps/harness/src python -m pytest .../test_realtime_delivery.py -q
...
>       assert result.output["published"] is False
               ^^^^^^^^^^^^^^^^^^^^^^^^^^
E       KeyError: 'published'

=========================== short test summary info ============================
FAILED .../test_realtime_delivery.py::TestRealtimeSummaryDelivery::test_publishes_each_window_to_the_live_summary_plane
FAILED .../test_realtime_delivery.py::TestRealtimeSummaryDelivery::test_the_published_payload_is_soap_shaped_not_a_flat_blob
FAILED .../test_realtime_delivery.py::TestRealtimeSummaryDelivery::test_unstructured_prose_degrades_to_one_running_summary_section
FAILED .../test_realtime_delivery.py::TestRealtimeSummaryDelivery::test_a_failed_publish_never_loses_the_summary
FAILED .../test_realtime_delivery.py::TestSuggestionDelivery::test_publishes_suggestions_with_stable_ids_and_provenance
FAILED .../test_realtime_delivery.py::TestSuggestionDelivery::test_suggestion_ids_are_deterministic_across_retries
FAILED .../test_realtime_delivery.py::TestSuggestionDelivery::test_a_failed_publish_never_loses_the_suggestions
FAILED .../test_realtime_delivery.py::TestCorrectionDelivery::test_publishes_proposals_that_a_clinician_can_accept_or_reject
FAILED .../test_realtime_delivery.py::TestCorrectionDelivery::test_proposal_ids_are_deterministic_across_retries
FAILED .../test_realtime_delivery.py::TestCorrectionDelivery::test_a_failed_publish_never_loses_the_proposals
10 failed, 4 passed in 3.34s
```

The **4 that passed at RED are the invariants that had to stay true**: the loop announcement is
already text-free, `EmitLoopEventInput` already forbids extras and already has exactly its eight
fields, and a run with nothing to propose already publishes nothing. They pass before and after,
which is the point.

### 6.2 GREEN — the new suites

```
$ PYTHONPATH=$PWD/apps/harness/src python -m pytest \
    .../test_realtime_delivery.py .../test_soap_sections.py .../test_live_delivery_client.py -q
.............................                                            [100%]
29 passed in 4.55s
```

### 6.3 Full suite — `pnpm harness:test` equivalent

```
$ PYTHONPATH=$PWD/apps/harness/src python -m pytest apps/harness/src/harness/tests/ -q
........................................................................ [ 98%]
..........................                                               [100%]
1538 passed, 1 warning in 73.06s (0:01:13)
```

### 6.4 Lint — `pnpm harness:lint`

```
$ ruff check apps/harness/src/
All checks passed!
```

### 6.5 Typecheck — `pnpm harness:typecheck`

```
$ MYPYPATH=$PWD/apps/harness/src mypy --config-file apps/harness/pyproject.toml apps/harness/src/
Success: no issues found in 134 source files
```

### 6.6 Replay compatibility

No workflow definition was touched (`git diff --name-only` matches nothing named `workflow`), so
replay compatibility is structural. Confirmed anyway:

```
$ PYTHONPATH=$PWD/apps/harness/src python -m pytest \
    .../test_replay_compat.py .../test_gating_consolidation_replay.py \
    .../interpreter/test_interpreter_semantics.py .../interpreter/test_worker_registration.py \
    .../interpreter/test_node_registry_parity.py -v
...
TestWorkflowInterpreterReplayCompatibility::test_v1_history_replays_on_current_definition PASSED
test_existing_replay_fixtures_stay_byte_identical[doc_workflow_post_task355_regen_history] PASSED
TestFullWorkerRegistration::test_all_workflows_and_activities_construct_on_one_worker PASSED
TestNodeRegistryParity::test_matches_the_committed_cross_language_fixture_exactly PASSED
======================== 37 passed, 3 warnings in 3.94s ========================
```

### 6.7 Proof the loop event was NOT widened

```python
# test_realtime_delivery.py::TestLoopEventBoundaryUnwidened
assert EmitLoopEventInput.model_config["extra"] == "forbid"
assert set(EmitLoopEventInput.model_fields) == {
    "consultation_id", "tenant_id", "event_type", "context_item_id",
    "kind_key", "action", "reason", "detail",
}

# test_realtime_delivery.py::test_the_loop_announcement_is_not_widened
assert set(event["detail"]) == {"ordinal", "total", "chars"}
for leak in ("Cough", "Subjective", "AAAA", "viral"):
    assert leak not in repr(event)
```

`git diff cbd21e14b..HEAD -- apps/harness/src/harness/temporal/models.py` is **empty**.

---

## 7. Requested Contracts (for the orchestrator / TASK-797)

Two gateway routes, both in `apps/api/**` + `packages/applications/**` — outside this ticket's
ownership, so requested rather than written. The exact bodies are pinned by
`tests/unit/services/test_live_delivery_client.py`, so an implementation can be checked against
executable expectations rather than prose.

### RC-1 — `POST /api/v1/internal/harness/consultations/:id/live-summary`

Publishes onto the **existing** `consultation:live-summary:{id}` channel. Service-token auth,
same as every other `/internal/harness/*` route.

```jsonc
// request body
{
  "tenantId":       "uuid",            // required
  "runningSummary": "string",          // required — flat text the console renders
  "sections":       [ { "title": "Subjective", "content": "..." } ],   // required, may be []
  "source":         "interpreter",     // required — which engine produced it
  "nodeType":       "consultation.realtimeSummary",  // optional
  "ordinal":        1,                 // optional — window n
  "total":          3,                 // optional — of m
  "provider":       "lm-studio",       // optional
  "model":          "a-model",         // optional
  "taskKey":        "text.live",       // optional
  "userId":         "uuid",            // optional
  "jobId":          "uuid",            // optional
  "runId":          "string"           // optional
}
// response
{ "ok": true }
```

Gateway maps this onto `LiveSummaryEventDto` and publishes verbatim: `consultationId` from the
path, `runningSummary` / `sections` passthrough, `entities: []`, `updatedAt` stamped
**server-side** (so interpreter snapshots order consistently against default-engine flushes),
and `metadata.stats = { provider, model, task_key }`. Absent optional fields are omitted by the
client (`_prune`), never sent as `null` — the global pipe runs `forbidNonWhitelisted`.

### RC-2 — `POST /api/v1/internal/harness/consultations/:id/live-assist`

New channel `consultation:live-assist:{id}` + SSE `GET /api/v1/consultations/:id/live-assist/stream`,
behind `TenantOwnedResourceSseGuard` exactly as the live-summary stream is. **This plane carries
clinical text by design** — a correction proposal quotes the span it would replace.

```jsonc
{
  "tenantId": "uuid",
  "kind":     "suggestions" | "corrections",   // discriminator
  "nodeType": "consultation.suggestions",
  "provider": "lm-studio", "model": "a-model",
  "userId": "uuid", "jobId": "uuid", "runId": "string",

  // present when kind === "suggestions"
  "suggestions": [
    { "suggestionId": "16-hex", "text": "Ask about penicillin allergy",
      "category": "history", "status": "PROPOSED", "proposedBy": "lm-studio:a-model" }
  ],

  // present when kind === "corrections"
  "corrections": {
    "proposals": [
      { "proposalId": "16-hex", "start": 19, "end": 29,
        "original": "amoxicilin", "proposed": "amoxicillin",
        "category": "spelling" | "medicalTerm" | "drugName",
        "confidence": 0.96, "rationale": "misspelling",
        "detectedBy": "nlp.ner", "proposedBy": "lm-studio:a-model",
        "status": "PROPOSED" }
    ],
    "applied": false, "appliedCount": 0, "rejectedProposals": 0,
    "textSha256": "<sha256 of the exact source text the spans index into>"
  }
}
// response
{ "ok": true }
```

**Rendering rules TASK-797 must honour** (these are safety properties, not styling):

1. Never auto-apply. `status` advances only on an explicit clinician action.
2. Before applying a proposal, verify the local text's SHA-256 equals `textSha256`. On mismatch,
   refuse and re-request — the span indexes bytes that no longer exist.
3. Key the list by `proposalId` / `suggestionId`, not by array index. Ids are stable across
   activity retries precisely so a dismissed item stays dismissed.
4. Show both provenance halves (`detectedBy`, `proposedBy`) — a clinician weighing an edit to a
   drug name needs to know what found it and what proposed it.

### RC-3 — schema-aware section titles (deferred, not blocking)

If tenant-customized SOAP forms are wanted, the change belongs in the DEFAULT ENGINE
(`soap-parser.ts` + `live-documentation.service.ts:86`), which currently hardcodes the four
canonical titles (§2.3). Harness mirrors whatever that contract becomes; it must not fork it.

---

## 8. Boundary Compliance

| Rule | Held |
|---|---|
| Own `apps/harness/**` only | Yes — `git diff --stat cbd21e14b..HEAD` touches nothing else |
| Loop event not widened | Yes — `temporal/models.py` diff is empty; two structural tests |
| Proposal-first preserved | Yes — byte-identical source, `applied: false`, `status: 'PROPOSED'`, on the wire and in the output |
| Workflows deterministic / replay-compatible | Yes — no workflow file changed; ids are content-derived, not `uuid4`/wall-clock |
| No hardcoded model/engine/endpoint | Yes — selection stays `get_policy` tenant → SYSTEM, fail-closed |
| No second inference stack | Yes — LLM via `apps/text`, NER via `apps/nlp`, unchanged |
| No `db:*` / `gen:mapper` / Docker / infra | Yes — none run |
| No `git stash` | Yes |
| Not merged, worktree intact | Yes |

---

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-23 | Ticket opened. Verified the live-summary plane against source and established that harness cannot write to it (§2.2). Designed delivery as one reuse of the existing plane + one new sibling plane for actionable items. TDD: 10 RED → 29 GREEN across three new suites; full harness suite 1538 passed; ruff + mypy clean; replay-compat green. Committed `d62daefe8` on `feat/task-796-realtime-summary-text`. Gateway halves requested as RC-1 / RC-2. |
