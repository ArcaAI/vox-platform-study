# TASK-634 — Pre-Summary / Summary Prompt Fidelity & v1 1:1 Re-Port

| Field | Value |
|---|---|
| **Status** | **Review** — code complete and committed; cluster rollout + live A/B outstanding |
| **Type** | bugfix (+ refactor of the prompt-resolution model) |
| **Tenant in scope** | ArcaAI (`50000000-0000-0000-0000-000000000001`) |
| **Reported by** | Tester — "generated pre-summary does not meet expectation" |
| **Opened** | 2026-08-07 |
| **Code complete** | 2026-08-08 |
| **Related** | TASK-592 (compat SMR pre-summary/summary integration, Workstream D — the migration this ticket corrects), TASK-546 (DepartmentAgent tier-1a), TASK-560 (v1→v2 compat), TASK-635 (agent capability bindings — its migration is a rollout prerequisite, §11.5) |

Ticket id **TASK-634** confirmed by the owner (OD-4).

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
9. ~~**FORMAT block rewritten** — title line added, five headers reordered, `Latest Dept Note` → `Latest Department Note`~~ — **RETRACTED 2026-08-10 (D-27).** This reads the diff BACKWARDS. v1 *is* the title line + that order + `Latest Department Note` (`previous_visit_service.py:151-163`); items 1-8 were real migration edits, but item 9 describes v1's own text as if it were the migration's. Acting on it is what introduced the drift. See D-27 in §8.

> ⚠ **Items 1-8 below are still valid; item 9 and §2.11 (D-09) are not.** The paragraph
> immediately following is retained only as the record of the mistaken reasoning.

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

### 2.11 D-09 — ~~Response mapper hard-codes the stale section contract~~ **WITHDRAWN**

> ⚠ **WITHDRAWN 2026-08-10 (D-27).** The mapper was already correct. It carried v1's
> real order and naming (`Latest Department Note`); "old" here was a misreading of
> item 9 above. Changing it to `Latest Dept Note` is what broke `structured_data`
> on the dev cluster. Both mapper and template are now back on v1. The one durable
> lesson stands: **the template and the parser must change together** — v1 keeps
> them identical, so any edit must touch `V1_PRE_SUMMARY_TEMPLATE` and
> `PRE_SUMMARY_DISPLAY_TITLES` in the same commit, re-derived from
> `previous_visit_service.py` and re-hashed.

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

### 2.15 D-14 — v1 has ELEVEN departments; only SEVEN were migrated

Discovered 2026-08-07 while establishing department parity. **v1 has no `Department`
table at all** (verified against the v1 Postgres, `core` schema: 29 tables, none
department-related). Departments in v1 are defined by what the SMR service
recognises, and two independent sources agree on **eleven**:

- `DEPT_VISIT_SCHEMAS` — **22 pairs** = 11 departments × `{new_referral, followup}`
- `select_prompt_template` — **11 branches**, each returning a real prompt module

```
breast_endocrine, dermatology, dietetics, hematology, medicine,
nephrology, neurology, orthopedics, rheumatology, surgery, surgical_oncology
```

The v2 migration ported **7 departments / 14 templates**. Four departments and
their eight templates were never migrated:

| Module | sha256 | chars / bytes |
|---|---|---|
| `dermatology_new_referral` | `b99ab4f49520` | 2019 / 2033 |
| `dermatology_followup` | `d237427271bd` | 1487 / 1501 |
| `dietetics_new_referral` | `351041078487` | 2068 / 2082 |
| `dietetics_followup` | `715a394f0e11` | 1701 / 1717 |
| `nephrology_new_referral` | `24e6eb6b735b` | 1900 / 1914 |
| `nephrology_followup` | `53841fda6205` | 1766 / 1780 |
| `surgical_oncology_new_referral` | `419e577751a8` | 1584 / 1598 |
| `surgical_oncology_followup` | `6c9c122c725b` | 1415 / 1429 |

**Total v1 corpus is therefore 23 templates** (22 department × visit-type + 1
pre-summary), not 15. This also means R5 ("New and Re-Visit templates set
properly following v1") was only 64% satisfiable before this discovery.

### 2.16 D-15 — ArcaAI's live department set does not match v1

Seed defines 7 ArcaAI clinical departments. The **live** v2 dev DB carries
**eighteen** rows for the tenant: a `019fb12d-*` set of 15 plus
`70000000-…-0001-{…0001, …0002, …0003}`.

| Category | Departments |
|---|---|
| In v1 **and** ArcaAI | Breast & Endocrine, Dermatology, Dietetics, General Medicine, Hematology, Nephrology, Neurology, Orthopedics, Rheumatology, Surgery, Surgical Oncology (11) |
| In ArcaAI, **not** in v1 | Cardiology, Emergency, Laboratory, Pediatrics, Psychiatry, Radiology (6) |
| Duplicated | General Medicine (2 rows — see D-05) |

Note `Cardiology` and `Emergency` are the rows `00-constants.ts` describes as
"retired" demo departments, yet they persist in the live DB **and** carry the
`isDefault` DepartmentAgents responsible for D-01.

### 2.17 Tenant admin capability (R6) — largely already present

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
| D-13 | No tenant-level fallback resolution tier (pointers are inert) | **Critical** | **Fixed** (Phase 1) |
| D-14 | v1 has 11 departments / 23 templates; only 7 / 15 were migrated | **Critical** | In progress (Phase 8a) |
| D-15 | ArcaAI's live department set (18 rows) ≠ v1's 11 | High | In progress (Phase 8b) |
| D-16 | `substituteVariables` in `prompt-assembly.service.ts` uses `name in variables` — walks the prototype chain, so `{toString}` injects JS source into a clinical prompt | High | **Fixed** |
| D-17 | `.env.test` sets `SECRETS_PROVIDER=vault`, so ~379 PHI-encryption unit tests fail by default in `@arcaai/applications` | Medium | **Fixed** — see §12 |
| D-18 | `AgentTemplateResyncService.resolveOrCreateTenantDepartment` clones EVERY Global department into every tenant — the source of ArcaAI's 7 non-v1 departments. Deleting them without disabling this re-creates them on the next sweep | **Critical** | **Fixed** — see §10 |
| D-19 | Live `DepartmentAgent` rows for 6 ArcaAI departments are `019fb12d-*` golden clones, but the seed declares `78000000-…-0001-…`. Seeding would ADD a second agent rather than update the existing one | High | Open (TASK-635 RF-3 seam) |
| D-20 | `approvedVersionNumber` — the pin the resolver actually serves — was absent from `PromptTemplateResponse`, and the `status` union omitted `APPROVED` despite the enum, list filter and approve route all producing it | Medium | **Fixed** (Phase 6) — gateway rebuild/restart required |
| D-21 | The shared `destructive` **Alert** variant renders its description at **4.08:1**, failing WCAG 1.4.3. Affects every destructive alert app-wide, including the OCC conflict banner | Medium | Open (`packages/ui`, separate ticket) |
| D-22 | ~~Global tenant has no APPROVED pre-summary template~~ — **premise wrong.** Global has TWO tier-1 candidates and the resolver picks the WRONG one; stale overrides are **25**, not 18 | High | Audited — see §11 |
| D-23 | Global's `…0000-000000000026` "Pre-Summary System Prompt" is tagged `pre-summary`, so it WINS tier-1 by oldest-wins (15 ms) over the real body `…040`. Global pre-summaries render from a **337-byte system-role prompt** | **Critical** | **Fixed in seed** — local DB correct; cluster needs the seed run (§12) |
| D-24 | `SYSTEM_DEFAULTS.preSummaryPromptId` (`…0000-000000000040`) is owned live by the **Global** tenant, not SYSTEM, so `SYSTEM_SHARED_READ_MODELS` cross-tenant read does not apply. Every non-Global tenant finds nothing at tier 2 → **503** | **Critical** | **Fixed in seed** — local DB correct; cluster needs the seed run (§12) |
| D-26 | Same prototype-chain lookup in the browser SDK `promptUtils.ts` (both substitution AND required-variable validation) | High | **Fixed** |
| D-25 | `…026`, `…040` and `…024` all have `approvedVersionNumber = null`, so `governedSnapshot` serves the **mutable `content` column**, not a pinned `PromptVersion` — the F-02 integrity guarantee is inert for exactly the templates the pre-summary path uses | High | **Fixed in seed** — local DB correct; cluster needs the seed run (§12) |

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

### 4.6 Phases delivered (2026-08-07)

All six dispatched phases landed. Gates re-run independently at the top level,
not relayed from agent self-reports:

| Phase | Delivered |
|---|---|
| **1 — Resolution model** | `resolve()` split by capability. Pre-summary skips the agent tier AND the department visit-type columns, resolves the tenant `TENANT_DEFAULT` template → SYSTEM pre-summary default (`…040`) → **throws 503**; never CATCHALL_SOAP. Summary chain byte-identical, locked by a deep-equal regression test. `resolvedFrom` now names the producing tier, so the D-02 guard is live. New `'tenant'` tier. Deterministic tenant lookup (`createdAt asc, id asc`, warns on >1). Closes D-01, D-02, D-03, D-13. |
| **2+3 — Pre-summary fidelity** | Verbatim v1 body seeded (`309a9cd13792`, 3091 B). Builder is v1-shaped: system = v1's system prompt verbatim, user = the whole interpolated body; the competing v2 directives removed. Mapper titles corrected to v1's live order + `Latest Dept Note`. `max_tokens` 800, `temperature` 0.2. `ml` now resolves to Malayalam via v1's `LANGUAGE_MAP`. Golden fixtures generated with **Python's own `str.format()`** — v1's interpolation engine. Closes D-08, D-09, D-10, D-11. |
| **2b — Native v2 path** | Substituter moved DOWN to `packages/applications/.../prompt/pre-summary-variables.ts` (apps/api imports it) so one implementation serves both SDK surfaces. `PromptAssemblyService.assemble()` is the seam — both native entry points converge there. `tenantId` threaded through the processor, summary service and agentic-instructions service. Uses `hasOwnProperty`, so `{constructor}`/`{toString}` are not resolvable. |
| **4 — Department matching** | v1 alias + visit-type tables verified against the pod; `findAllByTenant` now `name asc, id asc`. Found v1's two alias tables are **not** identical to each other, and that v2's bare `general → medicine` entry exists in neither. |
| **5 — Summary wrapper** | All five v1 composition artifacts extracted byte-exact into `apps/api/.../smr-compat/v1-wrapper/` with a checksum manifest + 8 tests. **Not wired** — extraction only. |
| **7 — Regression gate** | Checksum fixture pinning every v1 sha256 + a fidelity test. Converts silent prompt drift into a CI failure. |

**Verified gates (run at top level):** `@arcaai/database` 972 passed · `@arcaai/applications` 8099 passed (`SECRETS_PROVIDER=env`; see D-17) · `apps/api` 2668 passed · `@arcaai/domains` 1518 passed · `pnpm api:build` 8/8 · typechecks clean.

**Byte-exactness paid for itself three times.** Independent agents had content
silently corrupted mid-transfer — a hand-copied base64 blob, an 82-byte
truncation in `prompts_json.py`, and a user-prompt template exported with
placeholders still open. Every one was caught by the sha256 gate, none by review.
**Never let a model retype prompt content.**

### 4.7 ⚠ Unintended commit

Commit `06f4f087`, message `docs: add README for TASK-634…`, also carried
`seed.test.ts`, `04-department.ts`, `07b-arcaai-clinical-content.ts` and
`07b-arcaai-clinical-templates.ts` — a mid-flight snapshot committed by an agent
despite an explicit do-not-commit instruction. No work was lost. The message
describes only the README, so the history is misleading; disposition (amend /
reset / leave) is an owner decision.

### 4.8 ⚠ Known regression until Phase 1 lands

The §4.3 seed change is **inert without the resolver tier (D-13)**. Seeding it on
current code moves pre-summary from *6 of 18 correct* to **0 of 18** — every
department falls through to `CATCHALL_SOAP`. **Do not run `pnpm db:seed` against
any environment that matters until Phase 1 ships.** Warning is duplicated in the
seed source.

---

## 5. Decisions (RESOLVED — owner, 2026-08-07)

| ID | Decision | Ruling |
|---|---|---|
| **OD-1** | Strict 1:1 for the "v2 added content" group (Surgery ×2, Hematology ×2)? | **Strictly the same prompt instruction template / agent instruction as v1. Do NOT create or fabricate anything else — especially departments or prompt content.** The §4.2 reverts stand; the Fitness-for-Surgery, Referral Source, Investigations and chemotherapy sections are removed as a deliberate, accepted consequence. No new fallback prompt body may be authored — fallbacks must point at existing approved templates. |
| **OD-2** | Adopt the verbatim pre-summary body only together with interpolation? | **Best practice fitting requests sent by Vox SDK compat AND Vox SDK v2.** → adopt verbatim body together with assembly-time interpolation; substitution must serve both SDK surfaces, not compat only. |
| **OD-3** | May the resolver change touch the native v2 path? | **Best practice fitting requests sent by Vox SDK compat AND Vox SDK v2.** → **Yes.** The resolution fix applies to the native v2 path (`pre-summary.processor.ts`, `summary.service.ts`) as well as the compat shim; both surfaces must behave consistently. |
| **OD-4** | Ticket id | **TASK-634** confirmed. |
| **OD-5** | Deployed v1 or v1 checkout as the reference? | **Follow OD-1** → the **running v1 pod** is the sole authoritative source. Any local `HOPE/docs` checkout is disqualified. |

### 5.0 Later rulings (owner, 2026-08-07)

| Ruling | Effect |
|---|---|
| **"Make sure ArcaAI tenant has the same number of departments set in HOPE-v1 — strict rule!"** | ArcaAI must carry exactly v1's **11** departments. Supersedes the earlier reading of OD-1 that barred creating departments: the four missing ones (Dermatology, Dietetics, Nephrology, Surgical Oncology) are **v1 departments being restored**, not fabrications. The six ArcaAI-only departments (Cardiology, Emergency, Laboratory, Pediatrics, Psychiatry, Radiology) and the duplicate General Medicine are out-of-parity — see Phase 8b. |
| **"Any UI screens you are allowed to finish implementation without any figma design gate"** | The `12-design-workflow.md` approval gate is **waived** for this ticket. Phase 6 proceeds directly against the existing design system. All other UI rules (ScreenTemplate, DetailDrawer, `@arcaai/ui`, semantic tokens, skeletons, WCAG 2.2 AA) still apply. |

### 5.1 Consequences of OD-1 (accepted, recorded for traceability)

Restoring strict v1 parity **removes** the following from ArcaAI prompts. This is
intentional under OD-1, not an oversight:

- *Surgery – New Referral / Follow-up*: Comorbidities, Past Surgical History,
  Fitness for Surgery (cardiology / pulmonology / anaesthesia clearance, ASA
  class, NPO instructions)
- *Hematology – New Referral*: Referral Source, Investigations (Bone Marrow
  Aspiration & Biopsy, CBC, M-band)
- *Hematology – Revisit*: Treatment History (chemotherapy regimens, cycle
  numbers, responses, adverse effects) and the next-chemotherapy-date /
  dose-modification Plan-of-Care bullet

If any of this is wanted again it must be re-introduced deliberately as a NEW
tenant-owned template version through the admin surface (R6) — not by editing the
v1-parity seed, which is now checksum-pinned (Phase 7).

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

### Phase 8 — v1 department parity (fixes D-14, D-15) — owner's strict rule

**8a — port the 8 missing templates.** Byte-exact from the running pod into
`07b-arcaai-clinical-content.ts`, with the checksum fixture extended to 23.
Template ids `71000000-…-0001-0000000000{25..32}`.

**8b — expand ArcaAI to v1's 11 departments.** Add Dermatology (`…16`),
Dietetics (`…17`), Nephrology (`…18`), Surgical Oncology (`…19`); wire each
department's `newPatientPromptId` / `revisitPromptId`; leave `preSummaryPromptId`
NULL and give none of them a default `DepartmentAgent`. Lock the count at 11 with
a seed test — the owner's rule must be asserted, not merely satisfied.

**8c — live-DB reconciliation (report first, no data mutation).** The live tenant
has 18 rows; reaching 11 means retiring 6 non-v1 departments and the duplicate
General Medicine. `GEN_ARCAAI` is referenced by consultation / user / DNA / audit
seed data, and Cardiology + Emergency carry the `isDefault` agents behind D-01, so
this needs an impact assessment and explicit sign-off before any row is touched.

### Phase 6 — Tenant admin surface (R6) — design gate WAIVED by the owner

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

## 9. Live-DB Reconciliation — ArcaAI departments (read-only survey, nothing executed)

Surveyed against the live v2 dev DB. **No data was modified.**

### 9.1 Current state: 18 rows

**Eleven correspond to v1** — and DERM / DIET / NEPH / SONC **already exist live**.
Because the seed upserts by `(tenantId, code)`, seeding wires those four existing
rows **in place**; it does not create duplicates and their live ids survive.

| Code | Name | id | prompt columns wired |
|---|---|---|---|
| GEN | General Medicine | `70000000-…-0001-000000000001` | ✓ |
| SURG · RHEUM · NEUR · ORTH · HEME · BREN | — | `019fb12d-*` | ✓ |
| DERM · DIET · NEPH · SONC | — | `019fb12d-*` | — (this seed wires them) |

**Seven are not in v1:**

| Code | Name | id | note |
|---|---|---|---|
| CARD | Cardiology | `70000000-…-0001-000000000002` | retired seed id; agent `isDefault: true` |
| ER | Emergency | `70000000-…-0001-000000000003` | retired seed id; agent `isDefault: true` |
| LAB | Laboratory | `019fb12d-daaa…` | |
| **MED** | **General Medicine** | `019fb12d-dbe7…` | **the D-05 duplicate** |
| PEDS | Pediatrics | `019fb12d-db86…` | |
| PSYCH | Psychiatry | `019fb12d-db59…` | |
| RAD | Radiology | `019fb12d-da63…` | |

### 9.2 The duplicate, resolved precisely

Two rows named `General Medicine` with **different codes**: `GEN` (v1's `medicine`)
and `MED` (a Global-catalog clone). TASK-592 renamed ArcaAI's `GEN` to the same
display string, and `findAllByTenant` sorted on name alone — hence D-05.

**Keep `70000000-…-0001-000000000001` (GEN). Retire `019fb12d-dbe7…` (MED).**
GEN carries 2 Consultations, 3 UserDepartment rows and 2 DnaUsageRecord rows;
MED carries none. Reversing this destroys live clinical data.

### 9.3 Root cause of the extras (D-18) — deletion alone will not work

All 15 `019fb12d-*` rows were created inside a **629 ms window on 2026-07-30T04:00:00**
— not by the seed (seed rows use the `70000000-…` block), but by
`AgentTemplateResyncService.resolveOrCreateTenantDepartment`
(`packages/applications/src/services/departmentAgent/agent-template-resync.service.ts:329-348`),
which clones each golden department into the tenant. `GOLDEN_DEPARTMENTS` derives
from the 18 Global `DEFAULT_DEPARTMENTS`, so the sweep provisions one ArcaAI
department per Global department **in perpetuity**.

> **Delete the seven today and the sweep re-creates them tomorrow.**

### 9.4 Blast radius of retiring the seven

`Consultation`, `UserDepartment`, `DnaUsageRecord`, `PromptUsageRecord`,
`GoldenSet`, `GateEditExemplar`, child departments: **0 across all seven.**
Each holds exactly one `DepartmentAgent` (golden clone, `templateLocked: true`)
and one `PromptTemplate` named `<Name> Default Agent`. Total: 7 agents +
7 agent templates. **No clinical data, no users, no audit-referenced rows.**

### 9.5 Recommended sequence (owner decision — nothing executed)

1. **Stop the source first.** Disable the resync sweep or scope
   `resolveOrCreateTenantDepartment` to reuse-only so it never *creates* a tenant
   department. Any deletion before this is undone by the next sweep.
2. **Then soft-delete** (`resourceStatus = 'DELETED'` — never hard-delete) the 7
   extras plus their 7 `DepartmentAgent` and 7 golden-clone `PromptTemplate` rows.
3. **Then seed.** `pnpm db:seed` wires DERM/DIET/NEPH/SONC in place and adds the 8
   templates → exactly 11 live departments, all wired. Still gated by §4.8.

Note D-01 remains live for **CARD and ER** until they are retired — they are the
only remaining `isDefault: true` agents besides GEN.

## 10. D-18 Fix — resync is reuse-only (delivered)

`AgentTemplateResyncService.resolveOrCreateTenantDepartment` →
**`resolveTenantDepartment`**: returns the tenant's same-code department or
`null`, and **never creates one**. `cloneGoldenIntoTenant` returns `false` on a
miss, so the sweep records a skip and logs
`'Skipped golden agent - tenant has no department with this code'` instead of
materializing a department. The now-orphaned `DepartmentFactory` import was
removed.

**The principle, recorded in the code:** a tenant's department set is
authoritative and owned by the tenant (for ArcaAI, pinned to v1's eleven).
Resync reconciles **agents onto departments that already exist** — it is not a
department provisioner.

**Regression test** (`agent-template-resync.service.test.ts`, `D-18:`) asserts
that when the tenant has no matching department, `create` is called on **none**
of the department / agent / template / version repositories, and the summary is
`{ added: 0, fastForwarded: 0, skipped: 1 }`.

Evidence: `@arcaai/applications` **8348 passed**, 4 skipped; typecheck clean.

> This unblocks §9.5 step 1. The 7 non-v1 ArcaAI departments can now be retired
> without the next sweep re-creating them. §9.5 steps 2 and 3 remain owner
> decisions and have not been executed.

## 11. D-22 Live Pre-Summary Audit (read-only; nothing mutated)

### 11.1 Per-tenant tier-1 resolution

Predicate: `scope=TENANT_DEFAULT ∧ status=APPROVED ∧ departmentId IS NULL ∧
resourceStatus=ENABLED ∧ tags has 'pre-summary' ∧ NOT tags has 'dept-free'`.

| Tenant | Candidates | Resolves to | Ambiguous |
|---|---|---|---|
| System | 0 | falls to SYSTEM default | — |
| Global | **2** | `…0000-000000000026` "Pre-Summary System Prompt" (oldest by 15 ms) | **YES** |
| ArcaAI | 1 | `…0001-000000000024` "Clinical Pre-Summary" | no |

**The reported premise was wrong in an instructive way.** Global is not missing a
pre-summary template — it has two, and the resolver picks the wrong one. `…026`
is 337 bytes and is the **system-role** prompt ("You are a medical AI assistant
producing… pre-summaries"), not the pre-summary **body**. The real body is `…040`
(3059 B, "## Medical AI Pre-Summary Prompt"), which loses the oldest-wins
tiebreak by 15 milliseconds. So Global renders pre-summaries from a system prompt
and never falls through. That is D-23, and a "missing template" framing would
have sent the fix in exactly the wrong direction.

### 11.2 Stale `preSummaryPromptId` overrides — 25, not 18

The Fallbacks screen showed 18 because it scopes to the working tenant.

| Tenant | Departments with a non-null override |
|---|---|
| Global | **18 / 18** → all point at `…0000-000000000040` |
| ArcaAI | 7 / 18 (BREN, GEN, HEME, NEUR, ORTH, RHEUM, SURG) → all at `…0001-000000000024` |
| System | 0 |

### 11.3 Is the column safe to clear?

**Yes.** Nothing on the pre-summary resolution path reads it —
`resolvePreSummaryPromptId` sets `trace.departmentPromptId = null` and never
consults it. Remaining readers are the department write/API surface (accepts and
echoes), the admin console (which *labels* them "Legacy per-department
pre-summary"), and SDK type plumbing. **No analytics or reporting reader; no FK.**
The one functional consumer is `apps/ui-playground` (deprecated), which uses it
client-side to rank template choices — clearing it degrades that picker to
tag-based ranking.

### 11.4 Remediation script (written, NOT executed)

`packages/database/scripts/clear-stale-pre-summary-overrides.ts`

```bash
# dry run — the DEFAULT, writes nothing
NODE_ENV=development pnpm --filter @arcaai/database exec tsx scripts/clear-stale-pre-summary-overrides.ts
# apply
... tsx scripts/clear-stale-pre-summary-overrides.ts --apply
```

Single interactive transaction; idempotent (`preSummaryPromptId: { not: null }`
guard makes a concurrent clear a no-op); sets NULL + `_version` increment +
`updatedBy` stamp; never deletes; never touches `newPatientPromptId` /
`revisitPromptId`. Prints a read-only per-tenant pre-flight first.

### 11.5 ⛔ DEPLOY BLOCKERS — repo is coherent, the live DB is not

The repo has all three artifacts; the **live dev DB predates them**. Verified in
the working tree:

| Artifact | Repo | Live DB |
|---|---|---|
| `DepartmentAgent.preSummaryTemplateId` | ✅ `department-agent.prisma:60` | ❌ column absent |
| Migration `20260808000000_task_635_agent_capability_bindings` | ✅ present | ❌ not applied |
| Dept-free default `71000000-0000-0000-0004-000000000002` | ✅ `00-constants.ts:356` + `07d-…` seed + checksum test | ❌ row absent |

`summary.service.ts:312` and `pre-summary.processor.ts:109,147` pass
`preSummaryVariant: 'dept-free'` **unconditionally**. The currently deployed image
predates Phase 1, so nothing 503s *today* — but the moment this branch deploys
against the live DB as-is:

- every **native** pre-summary 503s (dept-free row absent);
- every tenant except Global 503s at tier 2 (`…040` mis-owned — D-24);
- any native call carrying a `departmentId` fails on the missing column.

**Required order: apply the migration → run the seed → then deploy.** Clearing
the 25 overrides is safe and independent, and must not be mistaken for fixing any
of these.

### 11.6 Recommendation on the Global tenant

Relying on the SYSTEM default is correct by design — Global is the platform
catalog tenant and has no clinical identity of its own; a Global-specific
pre-summary would be a second copy to keep in sync. The fix is to make the SYSTEM
default reachable, **authoring no prompt content** (OD-1):

1. Remove the `pre-summary` tag from `…0000-000000000026` — it is a system-role
   prompt and the tag is the only reason it wins tier 1.
2. Re-own `…0000-000000000040` to the SYSTEM tenant as TASK-635 B-12 intended.
   Global's tier-1 then goes empty and every tenant reaches it at tier 2.
3. Seed the dept-free default and apply the TASK-635 migration before deploy.

## 12. D-17 Fix — `@arcaai/applications` unit tests no longer inherit `SECRETS_PROVIDER=vault`

**Status: Fixed.**

### 12.1 Root cause

`.env.test` sets `SECRETS_PROVIDER=vault` (line ~2253) — correct for
integration/e2e suites that exercise a real Vault-backed `SecretsService`. But
`packages/applications`' unit suites build services directly, constructing them
without a `SecretsService`. The shared PHI-field-encryption guard
(`isPhiEncryptionRequired` / `encryptPhiFields` in
`packages/applications/src/common/phi-field-encryption.ts` — used by every
mapper for a model with an encrypted field) reads ambient `process.env` and
fails closed: *"`<Model>` field encryption is required (SECRETS_PROVIDER=vault)
but no SecretsService is available."* Because `.env.test` is loaded
process-wide (via `env-file-resolution.ts`'s `NODE_ENV=test` → `.env.test`
contract, host-env-wins), every unit test process — not just the ones that
touch encryption — inherited the vault requirement. Proof it was environmental,
not a code defect: `notification.service.test.ts`, which has no encryption
logic at all, failed with the identical error.

### 12.2 Options considered

| Option | Verdict |
|---|---|
| (a) Override `SECRETS_PROVIDER=env` for `packages/applications`' Vitest run only | **Chosen** |
| (b) Provide a test `SecretsService` double wired into every affected constructor | Rejected — far larger diff (dozens of constructors across ~36 files) for no behavioral gain; the fail-closed *policy* already has dedicated coverage (12.4) that doesn't need every unrelated unit test to carry a fake SecretsService |
| (c) Change `.env.test` directly to `SECRETS_PROVIDER=env` | Rejected — `.env.test` is a SHARED contract file consumed by `prisma.config.ts` (×2), `@arcaai/tools`, `apps/api/src/main.ts`, and Python via `packages/py-env`/`hope_env`, plus integration/e2e suites that legitimately want vault-mode coverage. Changing it would silently weaken those suites' fidelity to production (which runs `SECRETS_PROVIDER=vault`) — out of proportion to a unit-test-only problem |

### 12.3 Fix

`packages/applications/vitest.config.ts` — added a `test.env` override:

```ts
env: {
  SECRETS_PROVIDER: 'env',
},
```

This mirrors the existing, already-established pattern in
`apps/api/vitest.config.ts` (`test.env.DATABASE_URL`), which overrides env
file values the same way for that package's Vitest run. `.env.test` itself is
untouched — vault mode stays the default for every consumer outside this one
package's unit run.

### 12.4 Where vault-mode coverage lives

Fail-closed (`SECRETS_PROVIDER=vault`) behavior is NOT lost — it has dedicated,
explicit coverage independent of ambient `process.env`:
`packages/applications/src/common/__tests__/phi-field-encryption.test.ts`
drives `isPhiEncryptionRequired` and `encryptPhiFields` with an injected
`{ SECRETS_PROVIDER: 'vault' } as NodeJS.ProcessEnv` argument (see
`requiredEnv` in that file), asserting the guard throws
`/required \(SECRETS_PROVIDER=vault\)/` when no `SecretsService` is present and
that it runs the real encryption path when one is. That suite passes under
both `SECRETS_PROVIDER=env` (this fix) and `SECRETS_PROVIDER=vault` (the
default `.env.test`/production posture) because it never reads ambient env —
so genuine vault-mode coverage does not depend on which mode the surrounding
test process happens to be in.

### 12.5 Other packages checked for the same defect

- **`apps/api`** (`pnpm --filter @arcaai/api test`) — does NOT share the
  defect. `apps/api/vitest.config.ts` already overrides `DATABASE_URL` but not
  `SECRETS_PROVIDER`; re-ran clean: 187 files / 2703 tests passed, 2 skipped.
- **`@arcaai/domains`** (`pnpm --filter @arcaai/domains test`) — does NOT
  share the defect. 133 files / 1531 tests passed, 2 skipped, 9 todo; the only
  `mode=vault` log lines come from `core.database.service.test.ts`, which
  legitimately mocks a Vault factory itself.
- Both were left unmodified per scope — reported only, no fix needed.

### 12.6 Verification

```
pnpm --filter @arcaai/applications test       →  440 files passed | 1 skipped (441); 8348 tests passed | 4 skipped (8352)
pnpm --filter @arcaai/applications typecheck  →  clean (tsc --noEmit, no output)
```

No test was skipped, weakened, or deleted; no prompt/seed content touched.

## 12. Local Environment Verification (2026-08-08)

Run against the local dev database (`localhost:5432/hope`). **This is now the
reference for what the cluster should look like.**

### 12.1 The local DB is already correct — the cluster is stale

| Check | Local dev DB | Cluster `vox-dev` |
|---|---|---|
| TASK-635 migration applied | ✅ | ❌ |
| `DepartmentAgent.preSummaryTemplateId` | ✅ | ❌ |
| Dept-free default `…0004-…002` | ✅ SYSTEM-owned, APPROVED | ❌ absent |
| D-23 `…026` mis-tagged `pre-summary` | ✅ not tagged | ❌ tagged |
| D-24 `…040` ownership | ✅ SYSTEM | ❌ Global |
| D-25 `approvedVersionNumber` | ✅ 1 | ❌ null |
| ArcaAI departments | ✅ 11 | ❌ 18 |
| ArcaAI v1 templates | ✅ 23 | ❌ 15 |

**D-23, D-24 and D-25 are therefore live-data staleness, not repo defects** — the
seed already produces the correct ownership, tagging and approval pin. Applying
the migration and running the seed resolves all three.

Tier-1 resolution locally is the intended design:

| Tenant | Candidates | Resolves to |
|---|---|---|
| ArcaAI | 1 | `Clinical Pre-Summary` |
| Global | **0** | falls through to the SYSTEM default (correct — §11.6) |
| System | 1 | `Pre-Summary Default Template` |

### 12.2 A D-18-class trap found and fixed

The remediation dry-run showed all 18 stale overrides were **Global-tenant
departments that the seed itself still set** (`DEFAULT_DEPARTMENTS`). Clearing
them would have been undone by the very next seed — exactly the D-18 pattern.
Fixed at source: `preSummaryPromptId: null` on all 18, and the test asserting the
old design inverted.

Proven, not assumed:

1. cleanup applied → 18 cleared, 0 remaining
2. **full re-seed** → still **0** (previously it would have restored all 18);
   ArcaAI 11 departments, 23 templates, 7 default agents

### 12.3 End-to-end content proof

sha256 computed **inside Postgres** over the `PromptVersion` snapshots the
resolver actually serves, compared against the fingerprints taken from the
running v1 pod:

```
Clinical Pre-Summary            content_matches_v1 = true   pinned v1
Dermatology - New Referral      content_matches_v1 = true   pinned v1
General Medicine - Follow-up    content_matches_v1 = true   pinned v1
Hematology - Revisit            content_matches_v1 = true   pinned v1
Orthopedics - New Referral      content_matches_v1 = true   pinned v1
Surgery - New Referral          content_matches_v1 = true   pinned v1
Surgical Oncology - Follow-up   content_matches_v1 = true   pinned v1
```

The full chain is verified: v1 pod → byte-exact extraction → seed → database →
the pinned snapshot served at runtime.

## 13. Delivery Summary

### 13.1 Commits (branch `dev-2.1`)

| Commit | Scope |
|---|---|
| `ee30acb5` | Resolution split by capability, pre-summary variables, smr-compat fidelity |
| `058cff6b` | v1's complete 23-template corpus + ArcaAI pinned to v1's 11 departments |
| `72ed73a6` | D-18 — resync sweep can no longer provision a tenant department |
| `628b8e7f` | D-20 `approvedVersionNumber` on the DTO + D-17 test posture |
| `3fec28cb` | Phase 6 — tenant-admin prompt-template console |
| `a8145538` | e2e coverage for the new console |
| `679cf8bb` | Global pre-summary de-coupling (the D-18-class seed trap) |
| `bfe1a5ae` | D-21 — destructive Alert contrast raised to a passing ratio |
| `b6c7b3cd` | D-26 — prototype-chain substitution in the browser SDK |
| `06f4f087` `5b38f85e` `43a65bc6` | Ticket documentation |

`06f4f087` carries a `docs:` subject but also contains seed and test changes — an
agent committed a mid-flight snapshot. Left as-is: amending would rewrite a shared
branch that other sessions are committing to. Noted in §4.7.

### 13.2 Verification (re-run at top level, not relayed from agents)

| Suite | Result |
|---|---|
| `@arcaai/database` | 1061 passed (42 files) |
| `@arcaai/applications` | 8348 passed, 4 skipped |
| `@arcaai/admin-console` | 1300 passed (167 files), lint 0 warnings, axe 0 violations, 23/23 Playwright |
| `@arcaai/vox` | 4126 passed (254 files) |
| `@arcaai/domains` | 1518 passed |
| `apps/api` | 2668 passed · `api:build` 8/8 |
| Local dev DB | 0 stale overrides after a full re-seed; served `PromptVersion` snapshots sha256-match v1 |

### 13.3 Requirements

| Req | State |
|---|---|
| R1 pre-summary ≠ summary | ✅ separate resolution chains; pre-summary fails closed rather than reaching a note prompt |
| R2 two visit types | ✅ 11 departments × {New, Re-Visit} = 22 templates wired |
| R3 pre-summary fallback | ✅ tenant `TENANT_DEFAULT` → SYSTEM default → 503 |
| R4 summary fallback | ✅ department-agnostic fallback declared; points at an existing approved template (no content authored) |
| R5 per-department New/Re-Visit | ✅ all 22 byte-exact against the running v1 pod |
| R6 tenant-admin management | ✅ `/prompt-templates` console with Fallbacks / Templates / Governance |
| R7 exact 1:1, no rewriting | ✅ 23/23 sha256-pinned; extraction only, never model-retyped |

### 13.4 Outstanding — cluster rollout, in this order

1. Apply the TASK-635 migration to `vox-dev`
2. Run the seed — resolves D-23, D-24, D-25 and wires DERM/DIET/NEPH/SONC in place
3. §9.5 cleanup — retire the 7 non-v1 departments and duplicate `MED` (keep `GEN`: it holds the live consultations). Safe now that D-18 is fixed
4. Deploy **after** 1–2, or every native pre-summary 503s (§11.5)
5. Live A/B against v1, reviewed by the reporting tester

Owner decisions still open: soft-delete vs rename for `019fb12d-dbe7…`, and
whether `06f4f087` is left as-is.

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-07 | Ticket opened. Traced pre-summary template resolution against live v1 + v2 clusters; identified the agent-tier hijack (D-01) and the dead fallback guard (D-02). |
| 2026-08-07 | Established the v1 two-axis model vs v2's collapsed enum; catalogued D-03 through D-06 and D-09 through D-12. |
| 2026-08-07 | Ran a 15-agent byte-exact 1:1 audit against the running v1 pod. 8 match, 7 drift; drift taxonomy recorded (D-07). Found the pre-ticked `☒2 Weeks` checkbox in Orthopedics – New Referral. |
| 2026-08-07 | Restored 6 drifted department templates to v1 verbatim; recorded sha256 fingerprints in the seed header. |
| 2026-08-07 | Removed `preSummaryPromptId` from all 7 ArcaAI clinical departments; added `ARCAAI_FALLBACK_TEMPLATE_IDS`; updated 3 seed tests. 956 tests green, typecheck clean. |
| 2026-08-07 | Documented findings and the 7-phase remediation plan (this document). |
| 2026-08-07 | OD-1…OD-5 resolved by the owner (§5). Ticket id confirmed as TASK-634; deployed v1 pod ruled the sole authoritative source; resolver fix authorised for the native v2 path as well as compat. |
| 2026-08-07 | Phases 1, 2+3, 4, 5 and 7 dispatched in parallel with strict per-agent file ownership (Phase 6 held — it needed the Figma design gate per `12-design-workflow.md`). |
| 2026-08-07 | All five phases landed, plus Phase 2b (native Vox SDK v2 path). Gates re-verified at top level: database 972, applications 8099, api 2668, domains 1518, `api:build` 8/8, typechecks clean. Details in §4.6. |
| 2026-08-07 | Phase 2b found that the briefed follow-up was insufficient — the processor's line-100 `resolve()` only feeds a debug log, while `assemble()` runs its own `resolve()` (the one whose body reaches the LLM) with no `tenantId` at all. Both fixed. |
| 2026-08-07 | Discovered D-14/D-15 while establishing department parity: v1 has **11** departments and **23** templates; only 7 / 15 were ever migrated. v1 has no `Department` table — the set is defined by `DEPT_VISIT_SCHEMAS` (22 pairs) and `select_prompt_template` (11 branches), which agree. |
| 2026-08-07 | Owner ruled department parity a strict rule and waived the Figma design gate (§5.0). Phases 8a, 8b and 6 dispatched in parallel. |
| 2026-08-07 | Recorded the unintended commit `06f4f087` (§4.7) and two spin-off defects: D-16 prototype-chain variable substitution, D-17 `SECRETS_PROVIDER=vault` breaking the default unit-test run. |
| 2026-08-07 | **Phase 8a** — the 8 missing v1 templates ported byte-exact (dermatology, dietetics, nephrology, surgical oncology × new/follow-up). The checksum gate now pins the complete **23-template** v1 corpus. |
| 2026-08-07 | **Phase 8b** — ArcaAI expanded to v1's **11** departments (added DERM `…16`, DIET `…17`, NEPH `…18`, SONC `…19`), all 22 visit-type templates wired, pre-summary left NULL on every one. Owner's strict rule locked by set-equality tests in both directions, so an EXTRA department fails the suite too. Gates: 1060 tests / 42 files, typecheck clean. |
| 2026-08-07 | Phase 8b split `ARCAAI_CLINICAL_DEPARTMENTS` (7 agent-bound) / `…_WITHOUT_AGENT` (4 new) / `ARCAAI_ALL_CLINICAL_DEPARTMENTS` (11), because `ARCAAI_TENANT_AGENTS` maps an agent over every row of the first array and throws on an unmapped code. Membership is now the structural "has a default agent" predicate. |
| 2026-08-07 | **Phase 6 (R6)** — tenant-admin UI delivered with the Figma gate waived. Most of R6 already existed but was buried in `/agents`; promoted to a new `/prompt-templates` screen (tier 30-49) with **Fallbacks · Templates · Governance** tabs. `/agents` demoted to `DepartmentAgent` only per the one-authoritative-editor rule; `/prompt-studio` redirect re-pointed. The Fallbacks tab mirrors `PromptResolutionService` literally — pre-summary as a single row badged `tenant-wide` ("no department axis / no visit-type axis") with the `tenant → SYSTEM → 503` chain, summary as a department × visit-type matrix whose pre-summary column reads `n/a — tenant-wide`. Gates: 167 files / 1300 tests, lint 0 warnings, **axe 0 violations** (8 scans, both themes), **23/23 Playwright** against the running stack. |
| 2026-08-07 | Phase 6 surfaced D-20 (added `approvedVersionNumber` to `PromptTemplateResponse` + widened the `status` union to include `APPROVED`), D-21 (destructive Alert contrast 4.08:1) and D-22 (Global tenant has no APPROVED pre-summary template; 18 departments still carry inert pre-summary overrides). It also fixed two pre-existing broken e2e specs (`agents.spec.ts` fully red since TASK-547; a fragile `.first()` filter locator). |
| 2026-08-08 | **D-18 fixed** (§10) — resync made reuse-only; it can no longer provision a tenant department. Regression test locks it. Unblocks §9.5 step 1, so retiring the 7 non-v1 ArcaAI departments will now stick. |
| 2026-08-08 | Status → Review. All phases code-complete and committed (§13); cluster rollout and live A/B outstanding. |
| 2026-08-08 | Local dev DB verified end to end (§12). D-23/D-24/D-25 confirmed **live-data staleness, not repo defects** — the seed already yields correct ownership, tagging and approval pins. Found and fixed a D-18-class trap: the seed still set `preSummaryPromptId` on all 18 Global departments, so clearing them would have been undone by the next seed. Cleanup + full re-seed proved 0 restored. sha256 computed inside Postgres proves the served `PromptVersion` snapshots are byte-exact v1. |
| 2026-08-08 | D-16, D-17 and D-26 fixed and committed. D-26 closed the same prototype-chain defect in the browser SDK, in BOTH substitution and required-variable validation. |
| 2026-08-08 | Spin-offs dispatched: D-16 (prototype-chain substitution), D-17 (`SECRETS_PROVIDER=vault`), D-22 (live pre-summary audit + dry-run remediation script). D-21 (Alert contrast) is being handled in a separate owner session. |
| 2026-08-07 | Live-DB reconciliation completed read-only (§9). Found **D-18**: the 15 `019fb12d-*` rows were created in a 629 ms window by `AgentTemplateResyncService`, which clones every Global department into every tenant — so deleting the 7 non-v1 departments without disabling the sweep is futile. Also **D-19**: live agent ids diverge from the seed, so seeding would add a second agent to 6 departments. |
| 2026-08-10 | **D-27 — D-09's premise was wrong; the pre-summary FORMAT block is restored to v1.** A byte diff of the v1 source body (`HOPE/apps/smr/src/smr/services/previous_visit_service.py`, `_build_pre_summary_prompt`) against `V1_PRE_SUMMARY_TEMPLATE` differs in the **FORMAT block alone** — every other byte of TASK-634's port was faithful. But that block was a rewrite, not an extraction: v1 is sha256 `d1b718001948`, **3155 B**, while the `309a9cd13792` / 3091 B recorded here as v1 provenance is the hash of *this ticket's own output*. Three changes are reverted: the `Pre-Summary of Medical History` title line (dropped → restored), the section order (reordered → v1's Diagnoses · Plan of Care · Investigations · Medications · Diagnostics & Trends), and `Latest Department Note` (renamed to `Latest Dept Note` → restored). D-09 is therefore **withdrawn**, not fixed: v1 keeps template and parser identical (`previous_visit_service.py:151-163` vs `:215-221`), and so do we. Changed together: `summary-prompt.builder.ts`, `summary-response.mapper.ts` (`PRE_SUMMARY_DISPLAY_TITLES`), the three seeded bodies (`07-prompt-template.ts`, `07b-arcaai-clinical-content.ts`, `07d` re-derived keeping its `(Latest Note)` fork wording), the v1 provenance fixture, 2 checksum pins and 4 golden fixtures. Owner accepted v1's duplicated title (FORMAT emits it unbolded, the mapper prepends the bolded form) as true parity. Verified: database 44 files / **1118 tests**, smr-compat **178**, applications prompt **205**, SMR contracts **50**, api lint 0 warnings in scope. |
| 2026-08-10 | **Root cause of the reported dev-cluster failure identified — it is data, not code.** A `hope-v2-dev` `/presummary` call returned a v1-shaped markdown body (title line, v1 order, `Latest Department Note`) alongside `structured_data` using the *v2* order and `Latest Dept Note` naming. Two vintages in one response ⇒ new image + **stale governed template row**: `buildPreSummaryPrompt` uses `governed \|\| V1_PRE_SUMMARY_TEMPLATE`, so the tenant's DB row silently overrides corrected code. The same stale row is the pre-TASK-634 de-parameterized body (§2.10 items 1-6, placeholders → `provided in the request context`), which is why the model answered "no contextual patient data … were provided" despite vitals/labs/prior-visits being sent. **A redeploy alone cannot fix this — the ArcaAI pre-summary `PromptTemplate`/`PromptVersion` rows must be re-seeded.** |
| 2026-08-08 | **D-17 fixed** (§12) — `packages/applications/vitest.config.ts` now overrides `SECRETS_PROVIDER=env` for that package's Vitest run (mirrors the existing `apps/api/vitest.config.ts` `DATABASE_URL` override pattern), instead of touching the shared `.env.test`. Vault-mode (fail-closed) behavior keeps dedicated coverage in `phi-field-encryption.test.ts`, which injects `SECRETS_PROVIDER=vault` explicitly rather than relying on ambient `process.env`. Confirmed `apps/api` and `@arcaai/domains` do not share the defect (both pass unmodified). Verified: `@arcaai/applications` 440 files / 8348 tests passed (1/4 skipped), typecheck clean. |
