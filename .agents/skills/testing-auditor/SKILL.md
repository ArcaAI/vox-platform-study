---
name: testing-auditor
description: 'Audit a component''s existing test-result bundle and produce a risk-focused Test_Auditor_Report.md inside that bundle. Trigger when the user asks to audit, assess, or explain test coverage/quality for a named component using saved artifacts (for example "audit tts tests", "testing audit for stt", "review coverage for nlp"). Do not trigger for writing new tests, fixing CI, or interpreting a single failing assertion.'
license: MIT
compatibility: 'Cross-platform. Python 3.8+ (stdlib only). Read-only: the only file written is <component>/Test_Auditor_Report.md.'
argument-hint: '<component>  e.g. tts'
metadata:
  version: "1.3"
  style: "terse, evidence-first, table-first"
---

# Testing_Auditor

Audit one component's **saved test evidence**; write one file:

```
<component-folder>/Test_Auditor_Report.md
```

Turn coverage numbers into ranked, evidence-backed risk: what the tests prove, what they do not, and what could break in production. Audit only — never edit source, tests, or artifacts.

**Style contract:** one idea per bullet, ≤2 sentences per bullet, tables over prose, pictures over tables, no filler, no long sentences, precision over explanation, no restating a heading, no adjectives ("robust", "comprehensive", "flawless").

**Contents**

| Section | Covers | Search terms |
|---|---|---|
| [1. Rules](#1-rules) | evidence, reachability, stop conditions | fabrication, degraded, sibling |
| [2. Input](#2-input) | resolution, artifacts, format deviations | coverage_report, coverage.xml |
| [3. Workflow](#3-workflow) | phases 0–6 | extractor, inventory checks, register |
| [4. Report template](#4-report-template) | headings, index, registers | GAP, SEC, TEST, register |
| [5. Scoring](#5-scoring) | severity, likelihood, priority | P0, P1, Silent, Logged |
| [6. Quality bar](#6-quality-bar) | good/bad example, final response | evidence, top three |
| [7. Invocation](#7-invocation) | run examples | tts, stt, bundle path |

---

## 1. Rules

1. **Evidence or it did not happen.** Every finding cites `path:line`, a test name, or a log line. Never invent a number.
2. **Summary is a claim, not truth.** Cross-check `TEST_SUMMARY.md` against the log, coverage report, and repo; report disagreements.
3. **Executed ≠ verified.** Say "executed" unless you read the assertion.
4. **Read the source behind each gap.** Name the behaviour and a trigger; otherwise it is not a finding.
5. **Do not overstate reachability.** No entry point → `[LATENT]`; source not inspectable → `[INFERRED]`.
6. **No fabrication.** Unknown → `[UNKNOWN]`; unreadable → `[UNREADABLE]`; skipped capability → name it.
7. **Stop on missing required artifacts** unless the user opts into a degraded report.
8. **One input, one report.** Do not audit siblings.

---

## 2. Input

Argument = component folder name (e.g. `tts`). Resolve:

1. User-supplied path wins (`--dir`).
2. Else find a directory whose basename matches (case-insensitive) and holds test artifacts.
3. Several bundles → newest by artifact mtime; state the choice and list alternatives.

| Artifact | Required | Use |
|---|:---:|---|
| `coverage_report.txt` | yes | per-file statements, misses, % |
| `test_results.log` | yes | counts, skips, deselections, warnings, missing lines |
| `TEST_SUMMARY.md` | yes | claimed totals, module list, skip rationale |
| `coverage_html/` | yes | snapshot source and `mis` lines; needs `index.html` |
| `coverage.xml` | no | line-level data; prefer when present |

Missing/empty required artifact → print the inventory table and ask exactly one question: **"Produce a degraded report from the artifacts that do exist, or stop?"** Do not guess.

**Non-Python bundles:** record the format deviation in §2, use `coverage.xml`/`coverage_html` for line data, and state that per-file statement counts are unavailable. Never silently reinterpret a file.

---

## 3. Workflow

```
- [ ] Phase 0: Resolve folder, validate artifacts
- [ ] Phase 1: Extract evidence
- [ ] Phase 2: Cross-check inventory and summary
- [ ] Phase 3: Build the coverage-gap register
- [ ] Phase 4: Apply functional and security lenses
- [ ] Phase 5: Write Test_Auditor_Report.md
- [ ] Phase 6: Validate against the output contract
```

### Phase 0 — Resolve and validate

```sh
SKILL_ROOT="<this skill's folder>"
python3 "$SKILL_ROOT/scripts/audit_inputs.py" --component <component> \
  --root . --json-out /tmp/<component>-audit-evidence.json
```

Exit `1` = required artifact missing or no match → report `errors`, stop. Fallback:

```sh
grep -nE 'collected|passed|failed|skipped|deselected|warning|SKIPPED' test_results.log | tail -40
sed -n '/Name  *Stmts/,/TOTAL/p' coverage_report.txt
awk '/^Name  *Stmts/{f=1} f' test_results.log | grep -E '^src/|^apps/|^packages/'
```

### Phase 1 — Extract evidence

- Headline: statements, misses, %, passed/failed/skipped/deselected.
- 10 lowest-coverage files with miss counts.
- Every skip and deselection, with the capability it leaves unverified.
- Warnings that weaken the numbers (`module-not-measured`, unraisable exceptions).
- Exact missing ranges per file.
- Current test inventory and source root for line mapping.

Repo drifted? Recover the measured code from `coverage_html` (`class="mis"` embeds the snapshot source).

### Phase 2 — Cross-check inventory

| Check | Disagreement means |
|---|---|
| Summary pass/fail/skip vs log | summary stale or hand-edited |
| Summary coverage vs report/XML | >0.5 pt = finding |
| Summary module list vs repo tests | suites added or omitted |
| Log rootdir/platform vs checkout | foreign machine or clone |
| `module-not-measured` | headline approximate |
| Skipped/deselected capabilities | behaviours unexercised |
| XML timestamp vs summary date | artifact age |

State confidence `high` / `medium` / `low` + one concrete reason. Foreign/stale artifacts cap at **medium**; missing required evidence caps at **low**.

### Phase 3 — Coverage-gap register

Group by **behaviour**, not by line.

1. Read the missing range in source (`src/<pkg>/…` under `apps/<component>/`).
2. Name the symbol/branch.
3. Classify: `validation`, `recovery`, `security`, `cleanup`, `telemetry`, `variant`, `unreachable`.
4. Give the trigger and the behaviour that changes.
5. Mark `[REACHABLE]` / `[LATENT]` / `[INFERRED]`.
6. Assign a stable `GAP-001` ID (append-only, never reuse).

True dead code goes to §13 "Accepted gaps", not the register.

### Phase 4 — Lenses

**Functional & Contractual.** For each gap ask: does it break API contracts, violate method/class specifications, fail architectural boundaries, drop endpoint parameters, mishandle dependencies, or corrupt state/data flows? All "no" → label **Reliability** or **Maintainability**; do not manufacture false contract failures.

| Target / Component | Typical contract failure |
|---|---|
| APIs & Endpoints | mismatched schema, unhandled status code, missing validation, broken routing |
| Methods & Classes | broken interface contract, state corruption, invalid dependency lifecycle |
| Data & Architecture | schema mismatch, serialization error, unhandled null/undefined, boundary violation |
| Dependencies | timeout, payload truncation, protocol violation, unhandled upstream failure |

**Security.** Map each gap to ≥1: auth/tenant isolation · secrets and precedence · TLS/cert verification · input validation/SSRF/traversal · resource exhaustion · data leakage · supply-chain integrity · audit/logging tampering.

An untested security control (token gate, TLS choice, checksum, tenant key) is a finding even when the code looks correct. Say **"control unverified"**, not "vulnerability", unless you traced an exploit path.

### Phase 5 — Write

Path exactly `<component-folder>/Test_Auditor_Report.md`. Existing file → ask; non-interactive → timestamped `.bak.md` first.

Length **3–6 pages equivalent**. Every section: short. Delete any sentence that repeats the template.

### Phase 6 — Validate

- [ ] File exists at the exact path, non-empty.
- [ ] Length 3–6 pages equivalent; no bullet >2 sentences; no filler.
- [ ] Every template heading present, in order.
- [ ] `## Index` present; every section and every ID is listed.
- [ ] Every GAP/SEC row cites evidence.
- [ ] Every mitigation closes ≥1 ID; every P0 has a next-step row.
- [ ] No exploitability claim without a traced path; no invented numbers.
- [ ] Confidence and limitations stated; no source/test/artifact modified.

---

## 4. Report template

Headings verbatim. One line of guidance each; expand only where the component needs it.

```markdown
# Test Audit — <component>

## Index

| Anchor | Section | Answers |
|---|---|---|
| [#0-metadata](#0-metadata) | 0. Metadata | bundle, commit, confidence, scope |
| [#1-executive-verdict](#1-executive-verdict) | 1. Verdict | what holds, what does not, top fix |
| [#2-input-inventory-and-integrity](#2-input-inventory-and-integrity) | 2. Inventory | artifact table, reproducibility |
| [#3-what-the-numbers-actually-say](#3-what-the-numbers-actually-say) | 3. Numbers | headline, low files, skips, warnings |
| [#5-coverage-gap-register](#5-coverage-gap-register) | 5. Gaps | GAP register |
| [#8-security--vapt-risk-register](#8-security--vapt-risk-register) | 8. Security | SEC register |
| [#9-mitigation-plan](#9-mitigation-plan) | 9. Mitigation | TEST / REF / FEAT |
| [#10-prioritisation](#10-prioritisation) | 10. Priority | P0–P3 |
| [#11-immediate-next-steps-next-5-working-days](#11-immediate-next-steps-next-5-working-days) | 11. Next steps | ≤7 owner actions |
| [#13-accepted-gaps-and-limitations](#13-accepted-gaps-and-limitations) | 13. Accepted | dead code, unknowns |

**GAP:** `GAP-001` <label> · `GAP-002` <label> · …
**SEC:** `SEC-001` <label> · …
**TEST / REF / FEAT:** `TEST-001` <label> · `REF-001` <label> · `FEAT-001` <label> · …
**Search terms:** <10–15 domain words: empty payload, TLS, checksum, websocket, billing, API, …>

## 0. Metadata
Bundle path · audit date · auditor · repo commit · artifact age · confidence + reason · scope in/out.

## 1. Executive verdict
Three paragraphs: what holds, what does not, the one fix to make first. Scorecard: coverage · passed · skipped · deselected · files <80 % · findings by severity.

## 2. Input inventory and integrity
Artifact table (required/present/size/parse). Say whether the run is reproducible from this checkout.

## 3. What the numbers actually say
Headline; top-10 low files; skips/deselections and the capability each hides; warnings; covered-but-unasserted; what is genuinely well covered.

## 5. Coverage-gap register
| ID | File / symbol | Uncovered lines | Untested behaviour | Trigger | System consequence | Class | Reachability | Severity | Detectability |
|---|---|---|---|---|---|---|---|---|---|
| GAP-001 | ... | 73–77 | ... | ... | ... | security | [REACHABLE] | High | Silent |

## 8. Security / VAPT risk register
| SEC-ID | Gap(s) | Category | Attack or failure path | Unverified control | Exposure | Severity | Evidence |
|---|---|---|---|---|---|---|---|

Add a one-line "designed but unverified controls" list.

## 9. Mitigation plan
### 9.1 Tests to add
| TEST-ID | Closes | Level | Suggested file | Assertion (not "calls the function") |
|---|---|---|---|---|

### 9.2 Refactors
| REF-ID | Closes | Change | Why it removes the risk | Risk of the change |
|---|---|---|---|---|

### 9.3 New capabilities
| FEAT-ID | Closes | Capability | Operational value | Cost |
|---|---|---|---|---|

## 10. Prioritisation
State the scoring rule, then:
| Priority | IDs | Rationale | Effort S/M/L | Release-blocking? |
|---|---|---|---|---|

P0 = credible system failure, security, or silent data/tenant impact.
P1 = outage, wrong routing/billing, or silent degradation with no telemetry.
P2 = degraded UX or weak diagnostics.
P3 = maintainability.

## 11. Immediate next steps (next 5 working days)
| # | Action | Owner role | Output artifact | Acceptance criteria | Due |
|---|---|---|---|---|---|

≤7 rows. Every P0 appears. Bad provenance → row 1 is "regenerate artifacts on this checkout".

## 13. Accepted gaps and limitations
Dead code, `pragma: no cover`, platform-only branches, unavailable source, unreadable artifacts, unverified claims.
```

**Index rules.** Generate the index **last**. One row per section; every GAP/SEC/REF/TEST/FEAT ID appears once, by family, with a 3–6 word label. Anchors follow the verbatim headings. An ID is defined once and may be referenced elsewhere; never duplicate a definition. No prose in the index.

Use `[LATENT]`, `[INFERRED]`, `[UNKNOWN]`, `[UNREADABLE]` inline. Evidence format: `path:line` or `test_name::test_id`.

---

## 5. Scoring

Three-factor judgement, shown in the register:

- **Severity** — `Critical`: critical system failure, cross-tenant exposure, credential compromise, irreversible data loss. `High`: tenant/engine outage, incorrect API responses, silent control bypass, data corruption. `Medium`: degraded UX/latency, misleading diagnostics, recoverable inconsistency. `Low`: maintainability, cosmetic, unreachable.
- **Likelihood** — `Common` (normal use/deploy), `Occasional` (restart, malformed input, failover), `Rare` (tampering, exotic config).
- **Detectability** — `Silent` (no log/metric/health), `Logged` (visible, unalerted), `Caught` (test/CI fails).

| Condition | Priority |
|---|---|
| Critical, any detectability | **P0** |
| High + Silent, or High security control | **P0** |
| High + Logged/Caught, or Medium + Silent | **P1** |
| Medium + Logged, or Low + Silent | **P2** |
| Low + Logged/Caught | **P3** |

State deviations (e.g. high severity but `[LATENT]` → P2 today).

---

## 6. Quality bar

> `GAP-004` — `stream_ws.py:257` (`flush`). No test sends `{"type":"flush"}`; the gateway forwards it (`tts-ws.gateway.ts:473`), so it is reachable. If dropped, execution waits for the next boundary: the client receives a pause, no error, no metric. Medium/Common/Silent → P1.

Bad: "Coverage is 80 %, which is too low."

**Final response:** report path · confidence · top three findings by priority · P0/P1 counts. Do not paste the report.

---

## 7. Invocation

```
Testing auditor: tts
```
→ audits `.../Test_Results/tts/`, writes `.../Test_Results/tts/Test_Auditor_Report.md`.

```
Testing auditor: /abs/path/to/run/stt
```
→ explicit bundle; warn if the basename is not the component.