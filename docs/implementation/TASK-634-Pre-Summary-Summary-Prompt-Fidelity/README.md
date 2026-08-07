# TASK-634 — Pre-Summary / Summary Prompt Fidelity & v1 1:1 Re-Port

| Field | Value |
|---|---|
| **Status** | In Progress |
| **Type** | bugfix (+ refactor of the prompt-resolution model) |
| **Tenant in scope** | ArcaAI (`50000000-0000-0000-0000-000000000001`) |
| **Reported by** | Tester — "generated pre-summary does not meet expectation" |
| **Opened** | 2026-08-07 |
| **Related** | TASK-592 (compat SMR pre-summary/summary integration, Workstream D — the migration this ticket corrects), TASK-546 (DepartmentAgent tier-1a), TASK-560 (v1→v2 compat) |

> **Ticket number not yet confirmed by the owner.** 633 was the highest existing id;
> 634 assigned per `00-project-context.md` §Ticket Workflow. Rename if it collides.

---

## 1. Requirement Analysis

The client (ArcaAI tenant, `@arcaai/vox` compat SDK) reported that generated
**pre-summaries** do not match expectations versus HOPE v1. Investigation widened
to the whole prompt-instruction surface. The owner set these requirements:

| # | Requirement |
|---|---|
| R1 | Pre-Summary is **not** Summary — they are different capabilities and must not share a resolution axis |
| R2 | Each department has exactly two visit types: **New** and **Re-Visit** |
| R3 | Define a default/fallback prompt template for **Pre-Summary** when the request carries no department |
| R4 | Define a default/fallback prompt template for **Summary** when the request carries no department |
| R5 | Department-specific **New** and **Re-Visit** templates must be set correctly, following v1 |
| R6 | Tenant admins must be able to view / create / update / version / manage prompt templates and agents |
| R7 | Copy **exactly 1:1** all prompt instruction templates from v1 → v2. **No** rewriting, rephrasing, or content changes |

### 1.1 Scope boundary

In scope: ArcaAI seed data, the prompt-resolution chain, the v1-compat SMR shim,
and the response mapper. Out of scope (tracked as follow-ups in §6): the v1
summary **wrapper** artifacts (JSON schema envelope), and the Malayalam language
defect, which is pre-existing and independent.

---

## 2. Current State Evaluation

All findings below were verified against **running systems**, not source
checkouts: the v1 deployment (Rancher cluster `c-9lwv8`, namespace `apps`, pod
`apps-smr-84c9774997-zhp2l`) and the v2 deployment (cluster `c-nfhxq`, namespace
`hope-v2-dev`, pod `hope-api-…`, DB `vox-dev`).

### 2.1 The two models do not match

**v1 — two capabilities on two different axes:**

| Capability | Axis | Prompt count | Selector |
|---|---|---|---|
| Summary | department × visit type | 7 × 2 = **14** | `select_prompt_template()` |
| Pre-Summary | *none* — global | **1** | none; department/visit type are **variables inside** the single prompt |

`select_prompt_template` is called from exactly one place —
`services/summary_service.py:212`. The pre-summary route
(`api/routes.py:439` → `PreviousVisitService.generate_pre_summary`) never touches
it.

**v2 — one collapsed axis.** `promptType: 'pre-summary' | 'new-patient' | 'revisit'`
is a single enum, resolved by one service, backed by three sibling columns on
`Department` (`preSummaryPromptId`, `newPatientPromptId`, `revisitPromptId`).

> **Root cause (category error).** v2 models pre-summary as if it were a third
> visit type. It is not: it has no department axis and no visit-type axis. Every
> defect in §2.3–§2.5 follows from this.

### 2.2 Which v1 path is authoritative

The v1 SMR pod runs `SUMMARY_SERVICE_PROVIDER=azure_openai`, so `/presummary`
takes the **non-Langflow** branch. The authoritative pre-summary prompt is the
Python f-string in
`apps/smr/src/smr/services/previous_visit_service.py::_build_pre_summary_prompt`,
**not** the Langflow flow and **not** any local `HOPE/docs` checkout.

**The deployed v1 and the local v1 checkout have diverged.** Confirmed on the
pre-summary FORMAT block and on several department prompts. Direction of drift is
*not* uniform — for Surgery the checkout appears to be *ahead* of production
(content never deployed), while for pre-summary it is *behind*. **Neither is a
safe source; only the running pod is.**

### 2.3 D-01 — The DepartmentAgent tier hijacks pre-summary (and summary)

`PromptResolutionService.resolve()`
(`packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts:203`)
runs tier-1a (department default `DepartmentAgent`) **before** the
`switch (params.promptType)` that reads the visit-type columns. The agent tier is
**promptType-agnostic**, so once a department has a default agent, `promptId` is
already set and the switch at line 219 never executes.

Live evidence from the v2 gateway (`hope-api-5f47458b47-r6dk4`):

```
resolvedFrom: "agent"
promptId:     71000000-0000-0000-0001-000000000005   ← General Practice Default Agent (a NOTE prompt)
departmentId: 70000000-0000-0000-0001-000000000001   (General Medicine)
promptType:   "pre-summary"
trace.departmentPromptId: 71000000-0000-0000-0001-000000000024  ← Clinical Pre-Summary, IGNORED
```

The same log shows `promptType: "new-patient"` also resolving to the agent, with
`trace.departmentPromptId: …012` (the migrated v1 Medicine new-referral prompt)
ignored. **This breaks Summary as well as Pre-Summary** for every department
carrying a default agent.

Departments with `isDefault: true` agents in ArcaAI: General Medicine, Cardiology,
Emergency.

### 2.4 D-02 — The compat fallback guard never fires

`SmrCompatTemplateService.resolveGovernedInstruction`
(`apps/api/src/modules/smr-compat/smr-compat-template.service.ts:60`) returns
`undefined` when `resolvedFrom === 'default'`, intending "no department-specific
template → use static steering".

But `resolvedFrom` is computed as
`department && trace.usedDefaults.length < 3 ? 'department' : 'default'`
(`prompt-resolution.service.ts:272`). For a department with a
`defaultSummaryTemplate` and no pre-summary id, `usedDefaults` is only
`['promptId','contextVariables']` — length 2. So the resolver reports
`'department'` while actually serving `CATCHALL_SOAP`, and the guard is dead code.

### 2.5 D-03 — Resulting pre-summary state (all 18 ArcaAI departments)

Derived from the resolution chain + DB rows; General Medicine directly observed
in logs.

| Outcome | Departments | Count |
|---|---|---|
| ✅ `Clinical Pre-Summary` | Breast & Endocrine, Hematology, Neurology, Orthopedics, Rheumatology, Surgery | 6 |
| ❌ Default **agent** (note prompt) | **General Medicine**, Cardiology, Emergency | 3 |
| ❌ `CATCHALL_SOAP` (note prompt) | Dermatology, Dietetics, Laboratory, Nephrology, Pediatrics, Psychiatry, Radiology, Surgical Oncology, General Medicine *(duplicate row)* | 9 |

**6 of 18 correct.** The department the client actually uses — General Medicine —
is in the broken set.

### 2.6 D-04 — Pre-summary coverage was scoped to the summary matrix

v1's pre-summary applies to **every** department. The v2 seed wired
`preSummaryPromptId` only on the 7 departments that happened to have v1 *summary*
prompts, leaving 11 with `NULL` → `CATCHALL_SOAP`.

### 2.7 D-05 — Duplicate `General Medicine` departments

ArcaAI has two rows named `General Medicine`:

| id | default agent | prompt columns |
|---|---|---|
| `70000000-…-0001-000000000001` | yes (`isDefault: true`) | all three set |
| `019fb12d-dbe7-728d-951a-80f2646f9c92` | agent exists, `isDefault: false` | all `NULL` |

`DepartmentRepository.findAllByTenant` sorts by `name asc` **only**, so the tie is
resolved non-deterministically by Postgres. The two rows produce completely
different prompts. Observed stable in sampling, but unguaranteed.

### 2.8 D-06 — Department alias table not ported

v1 maps department synonyms in **two** places that must stay consistent —
`prompt_selector._norm`/`select_prompt_template` and
`prompts_json.get_department_schema`:

- `general`, `general medicine`, `internal medicine` → **medicine**
- `orthopedics`, `orthopaedics`, `ortho` → orthopedics
- `hematology`, `haematology`, `heme` → hematology
- `breast & endocrine`, `breast and endocrine`, `breast&endocrine` → breast_endocrine
- `surgery`, `general surgery` → surgery · `rheumatology`, `rheum` · `neurology`, `neuro`

v2's `matchTenantDepartment` (`apps/api/src/modules/smr-compat/department-match.ts`)
does not reproduce these. **Note the asymmetry:** a *missing* department is not
the same as the literal string `"General"` — the former falls through to the
generic path, the latter selects the Medicine prompts.

### 2.9 D-07 — 1:1 audit: 7 of 15 templates had drifted

Every template was extracted byte-exact from the running v1 pod via base64 shell
pipeline (never model-retyped) and verified by sha256. Results:

| Template | v1 sha256 | Verdict |
|---|---|---|
| Surgery – New Referral | `082f81eef304` | ❌ different document |
| Surgery – Follow-up | `3aea7e6a3fac` | ❌ different document |
| General Medicine – New Referral | `19cf6a024684` | ✅ match |
| General Medicine – Follow-up | `38d3f0f400c4` | ❌ paraphrased |
| Rheumatology – New Referral | `75f52e154882` | ✅ match |
| Rheumatology – Follow-up | `202b5e506026` | ✅ match |
| Neurology – New Referral | `ed6ebc57e158` | ✅ match |
| Neurology – Follow-up | `03fede6bda45` | ✅ match |
| Orthopedics – New Referral | `017c955f3b05` | ❌ 2-char edit |
| Orthopedics – Review | `00793f68aa6f` | ✅ match |
| Hematology – New Referral | `c86f9408dc36` | ❌ v2 added content |
| Hematology – Revisit | `865b4a31db2c` | ❌ v2 added content |
| Breast & Endocrine – New Referral | `8bc3073ba3eb` | ✅ match |
| Breast & Endocrine – Follow-up | `15155247c944` | ✅ match |
| Clinical Pre-Summary | `309a9cd13792` | ❌ de-parameterized |

**Drift taxonomy — three distinct kinds, needing three different decisions:**

**(a) Genuine defects — revert, no downside**

- *Medicine – Follow-up*: heading `New Complaints` dropped entirely; the
  `[NOTE TO LLM…]` preamble and **all ten remaining section bodies independently
  reworded**. Not a truncation — a rewrite.
- *Orthopedics – New Referral*: identical byte length, two character edits.
  Offset 2710 `*`→`-` (cosmetic) and **offset 2755 `☐2 Weeks` → `☒2 Weeks`** — the
  review-interval checkbox ships **pre-ticked**, applying a clinical default no
  clinician selected. Orthopedics-Review uses the same `☐` convention and is
  clean, so this is an isolated edit, not a convention change.

**(b) v2 added clinical content — needs a clinical owner's decision**

- *Surgery ×2*: v2 adds Comorbidities, Past Surgical History, **Fitness for
  Surgery** (cardiology / pulmonology / anaesthesia clearance, ASA class, NPO).
  v1 has Risk Factors & Exposures, Personal & Reproductive History, History of
  Present Illness, Treatment History, Medications & Allergies, Patient Education
  & Consent. Bidirectional divergence.
- *Hematology – New Referral*: v2 adds **Referral Source** and an
  **Investigations** section (Bone Marrow Aspiration & Biopsy, CBC, M-band).
- *Hematology – Revisit*: v2 adds **Treatment History** (chemotherapy regimens,
  cycle numbers, responses, adverse effects) and a Plan-of-Care bullet for **next
  chemotherapy date and dose modifications**.

> Strict 1:1 **deletes** this content. That is the opposite failure mode from the
> one reported. Flagged for explicit sign-off — see §5 OD-1.

**(c) Pre-summary de-parameterization** — see §2.10.

### 2.10 D-08 — Pre-summary template and its interpolation

v1 template: sha256 `309a9cd13792`, **3091 bytes** (after the source's own
`.strip()`). v1 system prompt: sha256 `277d94d56d3d`, 336 bytes.

Nine substitutions were made during migration:

1–6. `{current_department}`, `{visit_type}`, `Age {safe_age}, DOB {safe_dob}, Gender {safe_gender}`, `{safe_vitals}`, `{formatted_test_results}`, `{formatted_previous_visits}` → `provided in the request context`
7. `Notes from {current_department}` → `Notes from the current department`
8. all 8 × `{language_name}` → `the conversation language` / `conversation-language`
9. **FORMAT block rewritten** — title line added, five headers reordered, `Latest Dept Note` → `Latest Department Note`

**Item 9 is a defect independent of the placeholder question.** v1's
`display_titles` and `normalize_header` match `Latest Dept Note` verbatim, so the
rename breaks section parsing even for otherwise-correct output.

**Interpolation gap.** A verbatim v1 template carries single-brace `{placeholders}`.
v2's only interpolator, `interpolateTemplate`
(`prompt-management.service.ts:985`), uses **`{{var}}`** and runs on the *test*
path only — a single-brace template passes through untouched, so literal braces
would reach the LLM. **Adopting the verbatim body without a substitution step is
a regression.**

v1 defaults to reproduce: department `|| 'General'`; visit type
`|| 'Medical examination'`; age/dob/gender `|| 'Unknown'`; vitals
`|| 'Not available'`; test results / previous visits `|| ''`;
`language_name` via `en→English`, `ml→Malayalam`, else `English`.
All nine values already exist on `dto/pre-summary.request.ts`.

### 2.11 D-09 — Response mapper hard-codes the stale section contract

`apps/api/src/modules/smr-compat/summary-response.mapper.ts:162-166` hard-codes
the five titles in the **old order** with the **old naming**
(`Latest Department Note`). Because parsing is title-matched, a corrected prompt
emitting `Latest Dept Note` yields an **empty** `structured_data.sections`.
The template and the parser must change together.

### 2.12 D-10 — Generation parameters diverge

| Parameter | v1 | v2 (`smr-compat.controller.ts:34-35`) |
|---|---|---|
| `max_tokens` | **800** | **32,768** |
| `temperature` | 0.2 | 0.0 |
| model | azure `gpt-5.4-mini` | `azure-gpt-5.4-mini` ✅ matches |

v1's 800-token ceiling is what enforces the prompt's "CRISP" instruction.
Removing it is a likely major contributor to the verbose output reported.

### 2.13 D-11 — Malayalam language directive is wrong

`apps/api/src/modules/smr-compat/summary-prompt.builder.ts:42`

```ts
const LANGUAGE_INSTRUCTION: Record<string, string> = {
  en: 'Write the summary in English.',
  ml: 'Write the summary in English',   // ← instructs English for Malayalam
};
```

`languageDirective()` feeds **both** `buildPreSummaryPrompt` and the summary
builder, so every `ml` request has been told to answer in English. Pre-existing
and independent of this ticket's migration defects, but it directly undermines
the ml/ml-en STT work.

### 2.14 D-12 — v1's summary prompt is composed, not raw

v1 does **not** send the department prompt alone.
`summary_service.py:212` selects it, then wraps it via
`JsonPromptFactory.build_template_by_department`, which composes:

1. `ConversationalPrompts.build_system_prompt()`
2. `get_department_schema(dept, visit)` — a per-(department × visit-type) **JSON schema**
3. `ConversationalPrompts.build_user_prompt(...)`
4. `PRIOR MEDICAL CONTEXT (authoritative, use to fill missing details):` — how the pre-summary is injected into the summary
5. The `STRICT JSON RESPONSE FORMAT (CRITICAL)` rule block (monolingual policy, markdown rules, "never use placeholders for the 'summary' field", schema conformance)

**A byte-exact port of the 14 template bodies is necessary but not sufficient for
output parity.** These five artifacts are not yet ported.

### 2.15 Tenant admin capability (R6) — largely already present

`admin/prompt-templates`
(`apps/api/src/modules/prompt-management/prompt-management.controller.ts`) already
provides create / update / delete, `:id/versions`,
`:id/versions/:from/diff/:to`, `:id/approve`, `assign-department`, and usage
analytics, behind `@Authorize(['manage','PromptTemplate'])`.

Gaps against R6:

- **No tenant-level pre-summary setting** to manage — the concept was scattered
  across 18 department columns (addressed by this ticket's seed change).
- `assertCanApprove` keeps SYSTEM/library templates GLOBAL_ADMIN-only; tenant-owned
  templates are tenant-manageable. Believed correct by design — needs owner
  confirmation.
- Admin-console UI surface for the new tenant fallback pointers is not built.

---

## 3. Gap Register

| ID | Gap | Severity | Status |
|---|---|---|---|
| D-01 | Agent tier hijacks pre-summary **and** summary | **Critical** | Open |
| D-02 | `resolvedFrom === 'default'` guard is dead code | High | Open |
| D-03 | 12 of 18 departments resolve pre-summary to a note prompt | **Critical** | Open |
| D-04 | Pre-summary coverage scoped to the summary matrix | High | **Fixed** (§4) |
| D-05 | Duplicate `General Medicine`; non-deterministic match | High | Open |
| D-06 | v1 department alias table not ported | Medium | Open |
| D-07 | 7 of 15 templates not 1:1 | **Critical** | **Partly fixed** (§4) |
| D-08 | Pre-summary de-parameterized; no `{var}` interpolator | **Critical** | Open |
| D-09 | Mapper hard-codes stale section titles/order | High | Open |
| D-10 | `max_tokens` 800 → 32,768; temp 0.2 → 0.0 | High | Open |
| D-11 | `ml` directive says "write in English" | High | Open |
| D-12 | v1 summary wrapper (system prompt, JSON schemas, envelope) not ported | Medium | Open |
| D-13 | No tenant-level fallback resolution tier (pointers are inert) | **Critical** | Open |

---

## 4. Implementation Summary (work completed so far)

Working tree only — **nothing committed, nothing seeded, live DB untouched.**

### 4.1 Byte-exact v1 corpus extracted and verified

15 templates pulled from the running v1 pod via base64 pipeline, each verified by
sha256 and independently re-verified in the main session (15/15, 0 failures).
Artifacts in the session scratchpad (`<scratch>/v1-prompts/*.txt`, `*.line.txt`).

> One agent's hand-copy of a base64 blob corrupted the payload; the sha256 gate
> caught it and it recovered via 21 chunk-verified re-extractions. This validates
> the byte-exact protocol — **never allow a model to retype prompt content.**

### 4.2 Six drifted department templates restored to v1 verbatim

`packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-content.ts`

| Constant | Before → After |
|---|---|
| `SURGERY_NEW_REFERRAL_CONTENT` | 4859 → 3320 B |
| `SURGERY_FOLLOWUP_CONTENT` | 3352 → 2941 B |
| `MEDICINE_FOLLOWUP_CONTENT` | 3004 → 4156 B |
| `ORTHOPEDICS_NEW_REFERRAL_CONTENT` | 2880 → 2880 B (un-ticks `☒2 Weeks`) |
| `HEMATOLOGY_NEW_REFERRAL_CONTENT` | 4272 → 3833 B |
| `HEMATOLOGY_REVISIT_CONTENT` | 4273 → 4007 B |

File header now records all 14 sha256 fingerprints and states that extraction
must come from the **deployed pod, not a source checkout**.

`PRE_SUMMARY_CONTENT` deliberately **left unchanged** — see §5 OD-2.

### 4.3 Pre-summary de-coupled from the department axis

- `04-department.ts` — all 7 ArcaAI `preSummaryPromptId` wirings → `null`
- `07b-arcaai-clinical-templates.ts` — `Clinical Pre-Summary` documented as
  tenant-wide (`scope: TENANT_DEFAULT`, `departmentId: null`)
- New export `ARCAAI_FALLBACK_TEMPLATE_IDS`:
  - `PRE_SUMMARY` → `71000000-…-0001-000000000024`
  - `SUMMARY` → `71000000-…-0000-000000000036` (Global Catch-All SOAP, APPROVED)

No new clinical content was authored (per R7); the summary fallback points at an
existing approved template.

### 4.4 Tests updated

`packages/database/src/__tests__/seed.test.ts` — three tests asserted the old
design. Replaced with: no ArcaAI department may department-scope pre-summary; the
tenant fallback is APPROVED / `TENANT_DEFAULT` / unbound.

### 4.5 Verification evidence

```
pnpm --filter @arcaai/database test       → 956 passed (32 files)
pnpm --filter @arcaai/database typecheck  → clean (tsc --noEmit)
```
(`@arcaai/database` has no `lint` script.)

### 4.6 ⚠ Known regression until Phase 1 lands

The §4.3 seed change is **inert without the resolver tier (D-13)**. Seeding it on
current code moves pre-summary from *6 of 18 correct* to **0 of 18** — every
department falls through to `CATCHALL_SOAP`. **Do not run `pnpm db:seed` against
any environment that matters until Phase 1 ships.** Warning is duplicated in the
seed source.

---

## 5. Open Decisions (owner input required)

| ID | Decision | Why it blocks |
|---|---|---|
| **OD-1** | Strict 1:1 for the "v2 added content" group (Surgery ×2, Hematology ×2)? Applying it **deletes** Fitness-for-Surgery / anaesthesia clearance, and chemotherapy regimen + next-chemo-date tracking. | Silent removal of clinical prompting. Currently **applied** per R7; one `git checkout` reverts. |
| **OD-2** | Adopt the verbatim pre-summary body **only together with** assembly-time interpolation? | Adopting alone sends literal `{braces}` to the LLM. |
| **OD-3** | May the resolver change touch the **native v2 path**? `promptType: 'pre-summary'` is consumed by `pre-summary.processor.ts` and `summary.service.ts`, not just the compat shim. | Determines Phase 1 blast radius. |
| **OD-4** | Confirm ticket id **TASK-634**. | Doc/branch naming. |
| **OD-5** | Is the deployed v1 or the v1 checkout the intended reference for Surgery? Drift direction is not uniform. | Affects OD-1. |

---

## 6. Implementation Plan

Phases are ordered by dependency. Each phase is independently shippable and
verifiable. TDD per `01-development-workflow.md`: failing test first.

### Phase 1 — Resolution model (fixes D-01, D-02, D-03, D-13) — **blocking**

**Goal:** pre-summary never resolves to a summary-shaped prompt.

1. **Split the resolution chains by capability** in
   `PromptResolutionService.resolve()`:
   - `promptType === 'pre-summary'` → **skip tier-1a (agent) and the department
     visit-type columns entirely**. Resolve: tenant `TENANT_DEFAULT` pre-summary
     template → SYSTEM pre-summary template → **fail closed (503)**. Never
     `CATCHALL_SOAP`.
   - `promptType ∈ {new-patient, revisit}` → unchanged chain
     (preferred → agent → department column → tenant default → SYSTEM default).
2. **Add a tenant-default tier** that reads `scope = TENANT_DEFAULT` for the
   tenant, so `ARCAAI_FALLBACK_TEMPLATE_IDS` stops being declarative.
3. **Fix `resolvedFrom`** so a bare SYSTEM-default resolution reports `'default'`
   regardless of `defaultSummaryTemplate` (kills D-02's dead guard).

**Tests (red first):** pre-summary with a default-agent department must resolve
the tenant pre-summary template, not the agent; pre-summary with no template must
raise, not return a note prompt; new-patient/revisit resolution must be
byte-identical to today for a department with an agent (regression lock).

**Verify:** unit suites for `@arcaai/applications`; re-run the live trace and
confirm `resolvedFrom` is no longer `"agent"` for `promptType: "pre-summary"`.

### Phase 2 — Pre-summary 1:1 + interpolation (fixes D-08, D-09)

1. **Assembly-time substitution** in `buildPreSummaryPrompt`
   (`summary-prompt.builder.ts`) — the only correct site:
   - *seed time* impossible (values are per-request; would need a template per
     department × visit type × language);
   - *resolve time* wrong — destroys the version-pinned APPROVED snapshot identity
     for audit/diff, and pushes **PHI (vitals, DOB) into anything logging a
     resolved prompt**;
   - *assembly time* keeps the stored row byte-identical to v1 and confines PHI to
     the last hop before the SMR call.
2. Implement the nine variables with v1's exact defaults (§2.10). Declare them in
   `PromptTemplate.variables` (JSONB, already on the model). Do **not** reuse
   `interpolateTemplate` — it is `{{var}}` and test-path only.
3. Swap `PRE_SUMMARY_CONTENT` to the verified verbatim body
   (`309a9cd13792`, 3091 B) — line pre-staged at
   `<scratch>/v1-prompts/pre_summary.line.txt`.
4. **Together with 3**, fix `summary-response.mapper.ts` titles to v1's live
   order and `Latest Dept Note` naming.

**Tests:** rendered pre-summary prompt is byte-identical to v1's rendered output
for a fixture request (golden-file test against the extracted v1 corpus); mapper
parses all five sections from a v1-shaped response.

### Phase 3 — Parameters and language (fixes D-10, D-11)

1. `PRE_SUMMARY_DEFAULT_MAX_TOKENS` 32_768 → **800**; temperature 0.0 → **0.2**.
2. Fix `LANGUAGE_INSTRUCTION.ml` to a genuine Malayalam directive. Ship the v1
   system prompt (`277d94d56d3d`) alongside.

**Tests:** request without explicit params carries v1's defaults; `ml` produces a
Malayalam directive.

### Phase 4 — Department matching (fixes D-05, D-06)

1. Port v1's alias table into `matchTenantDepartment`, preserving the
   missing-department vs `"General"` asymmetry (§2.8).
2. Make department matching deterministic — add a stable tiebreak to
   `findAllByTenant` ordering (e.g. `name asc, id asc`), and resolve the duplicate
   `General Medicine` rows as a data fix (merge/retire the empty `019fb12d…` row).

**Tests:** each alias resolves to the right department; duplicate-name fixture
resolves deterministically.

### Phase 5 — Summary wrapper parity (fixes D-12)

Port the five v1 composition artifacts (§2.14) byte-exact from the running pod:
system prompt, per-(department × visit) JSON schemas, user scaffold,
`PRIOR MEDICAL CONTEXT` injection, `STRICT JSON RESPONSE FORMAT` block.

**Tests:** assembled summary request for each of the 14 department × visit
combinations matches the v1-rendered envelope.

### Phase 6 — Tenant admin surface (R6)

1. Expose the tenant fallback pointers (pre-summary + summary) as managed
   settings, readable/writable by tenant admins.
2. Admin-console screen for template + version management over the existing
   `admin/prompt-templates` API (view / create / update / diff / approve),
   per `13-nextjs-apps.md` and the design gate in `12-design-workflow.md`.
3. Confirm the `assertCanApprove` SYSTEM-vs-tenant split matches intent.

### Phase 7 — Regression gate (prevents recurrence)

1. Commit the 15 v1 sha256 fingerprints as a **checked-in fixture**, and add a
   test asserting every seeded ArcaAI template still matches. This converts "was
   it rewritten?" from an investigation into a CI failure.
2. Document in the seed header (**done**, §4.2) that extraction comes from the
   deployed pod only.

---

## 7. Verification Criteria (definition of done)

- [ ] `promptType: 'pre-summary'` never resolves to a note/summary prompt — live trace confirms
- [ ] All 18 ArcaAI departments resolve pre-summary to the tenant pre-summary template
- [ ] Rendered pre-summary prompt byte-identical to v1's rendered output (golden test)
- [ ] 15/15 seeded templates match the v1 sha256 fixture
- [ ] `structured_data.sections` populated for a v1-shaped response
- [ ] Summary resolution for agent-carrying departments uses the visit-type template
- [ ] `pnpm --filter @arcaai/database test typecheck` green; `@arcaai/applications` + `apps/api` suites green
- [ ] Tenant admin can view/create/update/version a prompt template end to end
- [ ] Live A/B against v1 on a real ArcaAI consultation, reviewed by the reporting tester

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-07 | Ticket opened. Traced pre-summary template resolution against live v1 + v2 clusters; identified the agent-tier hijack (D-01) and the dead fallback guard (D-02). |
| 2026-08-07 | Established the v1 two-axis model vs v2's collapsed enum; catalogued D-03 through D-06 and D-09 through D-12. |
| 2026-08-07 | Ran a 15-agent byte-exact 1:1 audit against the running v1 pod. 8 match, 7 drift; drift taxonomy recorded (D-07). Found the pre-ticked `☒2 Weeks` checkbox in Orthopedics – New Referral. |
| 2026-08-07 | Restored 6 drifted department templates to v1 verbatim; recorded sha256 fingerprints in the seed header. |
| 2026-08-07 | Removed `preSummaryPromptId` from all 7 ArcaAI clinical departments; added `ARCAAI_FALLBACK_TEMPLATE_IDS`; updated 3 seed tests. 956 tests green, typecheck clean. |
| 2026-08-07 | Documented findings and the 7-phase remediation plan (this document). |
