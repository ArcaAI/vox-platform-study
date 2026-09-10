# TASK-943 — the realtime lane supplies its agent's declared trigger context

| Field | Value |
|---|---|
| **Status** | `In Progress` — owner chose option (a) and said go, 2026-09-10 |
| **Type** | `bugfix` |
| **Branch** | `dev-2.2` |
| **Raised** | 2026-09-10, from the TASK-939 replay against the owner's 13-minute recording |
| **Blocks** | TASK-939 §6.2 — the churn measurement cannot run until the note generates |

---

## 1. Requirement Analysis

The realtime case note **never generates**. Every flush's summary node degrades:

```
core.agent: prompt_variable_unresolved: trigger.context.language (agent 'general-medicine-summarization')
```

Measured on the owner's recording, 2026-09-10: 120 s fed in real time through the full local stack
(gateway + STT + TEXT + guardrail + NLP + LM Studio serving `gemma-4-e2b-it-qat`) produced **8 flush
generations, 8 degrades, 0 content `section.patch` events**.

### The defect

`LiveDocumentationService.realtimeRunContext` supplies exactly one variable:

```ts
private realtimeRunContext(session: LiveSession): Record<string, ExpressionValue> {
  const context: Record<string, ExpressionValue> = {};
  if (session.visitType) context.visit_type = session.visitType;
  return { trigger: { context }, vars: {}, nodes: {} };
}
```

The seeded `general-medicine-summarization` agent binds **nine** names to `trigger.context.*`
(`seed/25-agents.ts` `generalMedicinePromptVariables()`, over
`GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES`): `visit_type`, `current_department`, `language`,
`safe_age`, `safe_dob`, `safe_gender`, `chief_complaint`, `formatted_vitals`,
`formatted_previous_visits`. The two heading lists are constants, so they resolve.

`core.agent` fails CLOSED on the first unresolved variable — correctly; a clinical prompt with a
literal `{{safe_age}}` in it is worse than no note. So eight missing names stop the note outright.

Introduced by TASK-932 (`32640d7cc`), which added `realtimeRunContext` with `visit_type` only.
Untouched by TASK-939.

### Why this matters beyond its own symptom

It independently explains TASK-891 §2.1's observation that `core."DocumentSection"` held **0 rows
cluster-wide**, which that ticket attributed to timeouts and stale drops. Both were true; this is
why the two surviving flushes produced `sectionCount 0`.

## 2. Where the values come from — and the authority for each default

`29-arcaai-agents-and-workflows.generated.ts` declares the trigger-context SCHEMA with each field's
documented absence value, so nothing here is invented:

| Variable | Source | Declared default |
|---|---|---|
| `visit_type` | `session.visitType` (already frozen) | `Medical examination` |
| `current_department` | `Department.name` via the consultation's `departmentId` | `General` |
| `language` | `session.summaryLanguage` (already frozen) — "the consultation language code (`en`, `ml`) — the v1 name of `language`" | v1 language resolution |
| `safe_age` / `safe_dob` / `safe_gender` | **nothing** — "the v2 data model holds no patient demographics … `patientId` is an external reference with no local demographic store" (`prompt-assembly.service.ts:860`) | `Unknown` |
| `chief_complaint` | **nothing** — "when the client supplies one" | empty |
| `formatted_vitals` | the session's OWN extracted vitals when it has them | `Not available` |
| `formatted_previous_visits` | **nothing yet** — see §4 | empty |

The six shared names come from `buildPreSummaryVariables` (`prompt/pre-summary-variables.ts`), the
same surface-neutral builder the summary path uses, so the realtime and durable surfaces cannot
drift on a default. Its docstring states the rule this ticket follows: *"A surface that has no
equivalent for a field simply omits it and inherits v1's default — never a newly invented one."*

`departmentId` is frozen off the consultation row `ensureSubstrateResolved` ALREADY reads for
`summaryLanguage` and `visitType`, so it costs no extra I/O — the pattern that row read's own
comment establishes.

## 3. Decisions taken

| Id | Decision | Rationale |
|---|---|---|
| D-1 | Reuse `buildPreSummaryVariables` rather than a second table of defaults | One source of truth for what absence means; the alternative is two surfaces drifting |
| D-2 | `formatted_vitals` uses the session's real vitals when present | Telling the model `Not available` while the session HOLDS vitals is a falsehood, not a default |
| D-3 | `formatted_previous_visits` stays empty for now | The warm-start pre-summary IS prior-visit material, but wiring it is an input-enrichment decision with clinical weight — §4, not this fix |
| D-4 | Department name via an OPTIONAL repository, falling back to the builder's default | Mirrors `prompt-assembly.resolveDepartmentName`; a non-DI construction path must still build |

## 4. Deliberately NOT in this ticket

Enriching the prompt's inputs beyond restoring generation:
- `formatted_previous_visits` from the cached warm-start pre-summary;
- `safe_age`/`safe_dob`/`safe_gender` from a patient store that does not exist in v2;
- `chief_complaint` from the per-department consultation context schema, which declares it.

Each changes what a clinician's note is generated FROM. They deserve their own review.

## 5. Verification

- The nine declared names are present in the run context, with the declared defaults.
- No extra consultation read: the department id rides the existing row read.
- End to end: the TASK-939 replay against the owner's recording produces content `section.patch`
  events and a churn number.

## 6. Implementation Summary

_In progress._

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-10 | Raised from the TASK-939 replay. Owner chose option (a) — wire the declared context rather than stub `language` — and said go. |
