# TASK-651 — BUG: instruction template / agent selection by department + visit-type, with a real default fallback

| Field | Value |
|---|---|
| **Status** | **Pending** — one product decision blocks the pre-summary half (§5) |
| **Type** | bugfix (summary) + feature-decision (pre-summary) |
| **Priority** | P1 |
| **Surfaces** | `hope-v2` (`apps/api/src/modules/smr-compat/`, `packages/applications/.../prompt/`) + `ALaaSv3.0` (caller) |
| **Reported** | 2026-08-10 |
| **Related** | TASK-592 (department→template resolution), TASK-634 (v1 parity + the INFO audit log), TASK-635 (agent capability bindings, RF-5) |

---

## 1. Requirement

Pre-summary and summary must each resolve the **correct instruction template /
agent** for the request's **department** and **visit type**, and fall back to a
**default** when no indicator identifies a template.

---

## 2. Current State — verified 2026-08-10

Read this section before changing anything. **The summary half is largely already
correct**, and two behaviours that look like bugs are deliberate.

### 2.1 Summary: selection WORKS ✅

Chain: `resolveGovernedInstruction` → `matchTenantDepartment` (code → name →
v1 synonym, case-insensitive; `department-match.ts:29-45`) → `resolve({ departmentId, promptType })`,
where `promptType` is the visit-type bucket from `normalizeVisitType`
(`dept-templates.ts:66-91`, a faithful v1 port including its misspellings).

Verified:
- all 12 department names ALaaS can emit resolve to a real ArcaAI row;
- all **11** ArcaAI departments have BOTH visit-type templates wired
  (`04-department.ts`: `newPatientPromptId` / `revisitPromptId`);
- all 22 are seeded `status: 'APPROVED'`, `approvedVersionNumber: 1`
  (`07b-arcaai-clinical-templates.ts:405-410`) — **this is load-bearing**: Tier-1b
  silently SKIPS a non-APPROVED template (`prompt-resolution.service.ts:491`);
- `"New Referral"` / `"Follow-up"` / `"New / Referral"` all normalise correctly.

### 2.2 The resolution cascade as built

`prompt-resolution.service.ts:6-33`

| Tier | Source | Reachable from v1-compat? |
|---|---|---|
| Tier-0 `preferred` | doctor's `UserProfile.preferredPromptTemplateId` | ✗ (out of scope — separate ticket) |
| Tier-1a `agent` | department default `DepartmentAgent`, visit-type aware | ✓ |
| Tier-1b `department` | department `newPatientPromptId` / `revisitPromptId` | ✓ |
| Tier-2 `default` | `SYSTEM_DEFAULTS.promptId` (CATCHALL_SOAP) | ✓ then **discarded** — see 2.3 |

### 2.3 ⚠ DELIBERATE #1 — the Tier-2 default is thrown away on compat

`smr-compat-template.service.ts:74` drops any resolution whose
`resolvedFrom === 'default'` and returns `undefined`, so the caller falls back to
the hardcoded static v1 dept×visit steering in `dept-templates.ts`.

Reason (documented at `:59-65`): the SYSTEM pre-summary template still carries
un-interpolated single-brace `{placeholders}` that would reach the LLM literally.

**So "the default fallback" on compat is NOT CATCHALL_SOAP — it is the static v1
field-set guidance.** That satisfies the requirement's intent, but anyone reading
the tier table alone will conclude it is broken. **Do not "fix" this** without
reading TASK-634 first.

### 2.4 ⚠ DELIBERATE #2 — pre-summary has NO department or visit-type axis

`resolveGovernedInstruction` skips department matching entirely for
`pre-summary` (`smr-compat-template.service.ts:70-71`) and the chain consults
neither the preferred nor the department tier (`prompt-resolution.service.ts:520-540`).

This is **verified v1 behaviour**, not an oversight: v1 has exactly ONE
hardcoded pre-summary body per tenant, with department and visit type as
**variables inside it**, never selectors
(`HOPE/apps/smr/src/smr/services/previous_visit_service.py:37-169`; the route
defaults `dept`/`vtype` at `routes.py:544-545`). Every ArcaAI department is
seeded `preSummaryPromptId: null`, consistent with that.

There IS a department-aware pre-summary tier in v2 — Tier-1a′, the agent's
`preSummaryTemplateId` — but it is reachable only when the caller supplies a
`departmentId`, and RF-5 states the compat shim deliberately never does.

**Therefore the requirement "pre-summary picks a template by department and visit
type" is a CHANGE, not a fix.** It needs the §5 decision.

### 2.5 The actual gap: you cannot see what was selected

Until `f243da80c` (this branch, unpushed) the shim discarded the resolved
`promptId` and logged nothing; `PromptResolutionService` traced it only at
`debug`. On a normal deployment there was no way to answer "which template served
this request?" — which is why this looked broken.

`f243da80c` adds one INFO line per resolution carrying `promptTemplateId`,
`promptVersionNumber`, `departmentAgentId`, `department` + `departmentId`,
`visitType`, `doctorId`, `resolvedFrom`, and `served`. **It is not deployed.**
Deploying it is the cheapest way to convert this ticket from suspicion to
evidence.

### 2.6 Caller-side risk

ALaaS emits department in **two different naming conventions**: mapped friendly
names (browser pre-summary + summary) and raw ALL-CAPS EMR names
(`department-pre-summary-job.service.ts:640`, e.g. `"BREAST AND ENDOCRINE SURGERY"`,
`"PULMONOLOGY"`). The ALL-CAPS variants match **no** tenant row and **no** v1
synonym. They currently only degrade the `{current_department}` text inside the
pre-summary prompt (department is not a selector there) — but they become a real
selection bug the moment §5 makes pre-summary department-aware.

---

## 3. Implementation Plan

### Phase 1 — see it before changing it (do first)

| # | Task | Agent tier | Effort |
|---|---|---|---|
| 1.1 | Deploy `f243da80c` to `hope-v2-dev` and capture the INFO line for a summary and a pre-summary request. Record `promptTemplateId` / `resolvedFrom` here. | sonnet-5 | medium |
| 1.2 | From those lines, state per capability whether selection is correct. **If summary selection is already correct, say so and close that half** rather than changing working code. | sonnet-5 | medium |

### Phase 2 — summary: close any gap Phase 1 proves

| # | Task | Agent tier | Effort |
|---|---|---|---|
| 2.1 | Normalise ALaaS department naming to ONE convention (recommend the mapped friendly name, already used by 2 of 3 paths). Fix `department-pre-summary-job.service.ts:640` to map instead of forwarding the raw EMR string. | sonnet-5 | medium |
| 2.2 | Add a test matrix: every ArcaAI department × both visit types resolves a distinct, APPROVED, department-bound template id. Locks 2.1 and guards future seed edits. | sonnet-5 | high |
| 2.3 | Make the fallback explicit rather than implied: when nothing resolves, log `served: 'static-v1-steering'` at INFO (already in `f243da80c`) and assert it in a test. | haiku-4-5 | default |

### Phase 3 — pre-summary: only after the §5 decision

If the owner chooses department-aware pre-summary:

| # | Task | Agent tier | Effort |
|---|---|---|---|
| 3.1 | Pass `departmentId` into the pre-summary resolve call so Tier-1a′ (`preSummaryTemplateId`) becomes reachable, keeping the tenant-wide row as the fallback and the SYSTEM default below it. | **opus-5** | high |
| 3.2 | Decide what a department pre-summary template contains — every ArcaAI department is `preSummaryPromptId: null` today, so there is nothing to select yet. Seeding content is the larger half of this work. | **opus-5** | high |
| 3.3 | Reconcile with RF-5 and the dept-free native fork (`07d`), and update TASK-635's conformance tests, which currently ASSERT the compat pre-summary supplies no department. | **opus-5** | high |

---

## 4. Verification Criteria

- [ ] INFO log shows the expected `promptTemplateId` + `resolvedFrom` per capability on dev
- [ ] Every ArcaAI department × visit type resolves its own APPROVED template (test matrix)
- [ ] One department naming convention leaves ALaaS
- [ ] Unknown department ⇒ logged fallback, never a silent wrong template
- [ ] Pre-summary behaviour matches the §5 decision, with TASK-635 conformance tests updated deliberately
- [ ] `pnpm --filter @arcaai/api test lint` green

---

## 5. Decision Required (blocks Phase 3 only)

**Should pre-summary become department- and visit-type-aware?**

- v1 says no — one body per tenant, department as a variable.
- v2 has the mechanism (Tier-1a′) but deliberately disables it on compat (RF-5),
  and no department pre-summary content exists to select.
- Enabling it is a v1 divergence plus a content-authoring project, not a code fix.

Recommendation: **Phase 1 + Phase 2 now; defer Phase 3.** Deploy the audit log,
prove summary selection, normalise department naming. Revisit pre-summary
department-awareness only if the tenant-wide pre-summary is demonstrably
insufficient — the evidence for that does not exist yet.

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-08-10 | Opened. Established that summary selection already works end to end (11 departments × 2 visit types, all APPROVED and wired) and that the real gap was observability, addressed by the unpushed `f243da80c`. Documented the two deliberate behaviours — the discarded Tier-2 default and the department-free pre-summary chain — so neither is "fixed" into a regression. Flagged that department-aware pre-summary is a change requiring a decision plus content authoring. |
