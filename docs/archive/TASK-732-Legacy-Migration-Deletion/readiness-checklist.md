# TASK-732 Phase 1 Task 1 — Migration Readiness Checklist

Re-verified against the live tree on `feat/loop` (2026-08-16, post-reconciliation commit
`e2e54c1f2`). Each row is either **VERIFIED** (the proof artifact exists and was inspected this
pass) or **NOT VERIFIED** (named, with an owner). Per the ticket's Task 3 rule: **any unmet row
makes the verdict NO-GO regardless of the numbers Task 2/3 would otherwise compute.**

**Tree-stability note:** a parallel session was observed actively editing TASK-713's own files
(`.gitlab/ci/test.yml`, its ticket README) while this checklist was being written — a re-read of
the same job block returned different content minutes apart. Row 7 below reflects the LIVE
`.gitlab/ci/test.yml` as directly re-grepped at the time this checklist was finalized, not
either ticket's README prose. Re-verify row 7 directly against that file before relying on it if
material time has passed since 2026-08-16.

| # | Precondition | Status | Evidence (inspected this pass) | Owner if unmet |
|---|---|---|---|---|
| 1 | Temporal hosting decision made and signed | **NOT VERIFIED** | `TASK-730/temporal-hosting-decision.md` exists with both options costed out, but its Decision Record table is blank — TASK-730 §7 states this explicitly: *"The decision itself is NOT made."* | Product/infra owner — TASK-730 Task 1 |
| 2 | `harness` + `harness-worker` Deployments exist in `arca/hope-v2-deployment` | **PARTIALLY VERIFIED** | TASK-730 §2.10/§2.11 (read-only GitLab MCP access) confirms the manifests exist and the specific `CreateContainerConfigError` root cause already has a fix commit (`fcfe19a64`, 2026-08-09) with no evidence of reversion. Whether the pod is healthy **today** on the live cluster is unconfirmed — no cluster access from any session so far. | Infra owner — confirm pod health with cluster access (TASK-730 Task 2 remainder) |
| 3 | A real staging namespace exists and `promote-staging` has succeeded end-to-end | **NOT VERIFIED** | `.claude/rules/09-infrastructure-devops.md` states plainly: *"only `hope-v2-dev` exists on the cluster… there is no separate staging or prod namespace yet."* TASK-730 Task 3 is unstarted (needs write/cluster access no session has had). | Infra owner — TASK-730 Task 3 |
| 4 | Availability measurement produced (5xx rate, latency percentiles, duplicate `harness-doc-{id}` count) | **PARTIALLY VERIFIED — instrument exists, no real traffic yet** | `scripts/harness-availability-report.py` (TASK-730 Task 4) runs end-to-end against live local Temporal (re-verified this pass, see §Task 4 evidence below) and returns `Total executions seen: 0` — a fresh dev DB with zero consultation traffic, not a failure of the tool. This ticket's own Phase 1 Task 2 adds the missing-note-rate + harm-proxy half of the same measurement (`scripts/harness-migration-readiness-report.ts`, new this pass) — also verified runnable, also zero-traffic. **Neither report has a non-zero sample to compute a real rate from yet.** | Whoever runs Phase 1 Task 3 once there is real traffic (staging or a monitored dev cohort) |
| 5 | Temporal backlog + worker-health dashboards and alert rules exist | **VERIFIED (local dev only)** | `infrastructure/grafana/dashboards/harness-temporal.json` (7 panels) + `infrastructure/docker/configs/prometheus/rules/harness-temporal.rules.yml` (4 rules) — TASK-730 §7 records `promtool check rules`/`check config` passing AND a live re-verification against local Prometheus/Grafana (4/4 rules `health: "ok"`, dashboard rendering, `temporal` scrape target `up`). Cluster-side equivalent is unconfirmed (no write access to `arca/hope-v2-deployment`). | Infra owner — cluster-side dashboard/alerts (deployment repo) |
| 6 | Temporal DR/backup runbook exists | **VERIFIED (document exists; content has open items)** | `docs/operations/temporal/README.md` exists, modeled on the vault runbook shape. TASK-730 §7 states its own §6 leaves Postgres-backup coverage for Temporal's tables, workflow-history retention, and an untested restore procedure open. The document existing satisfies this row; the open items are a Task-730 follow-up, not a Phase-1 blocker in themselves. | N/A for this row; TASK-730 owns the open items |
| 7 | `harness-eval-gate` is blocking (no `allow_failure: true`) and produces real PASS/FAIL | **NOT VERIFIED — half true** | Re-checked `.gitlab/ci/test.yml` directly this pass, twice, because the tree changed under this session mid-investigation (a parallel session is actively editing TASK-713's own files — see the note at the top of this document). **Current live state, re-confirmed by a clean `grep -n "RUN_INFRA_TESTS\|allow_failure" .gitlab/ci/test.yml`:** the `harness-eval-gate` job (starting `test.yml:628`) carries **no** `allow_failure` key — TASK-713's own claim *"flipped the job to blocking (Task 3)"* is true for that half. **But its `rules:` still gate the whole job behind `if: $RUN_INFRA_TESTS != "true" → when: never`** (`:736`, with a header comment at `:610-627` explaining why: the chosen judge backend as of this read, LM Studio, is a desktop app with no CI-runnable image, so an ordinary shared-runner pipeline cannot reach it — a deliberate, documented "opt in explicitly" posture, not an oversight). **Net: the job is a real blocking gate WHEN it runs, but it still does not run on an ordinary merge-request pipeline today** — this row's precondition ("produces real PASS/FAIL," implying on the normal path) is not met. This is a live-tree finding as of 2026-08-16, not a static one — re-check `.gitlab/ci/test.yml` directly (not this document, not either ticket's README) before relying on it, since TASK-713 was observed changing under this session. | Whoever provisions a self-hosted CI runner reaching LM Studio (or the alternate path named at `test.yml:610-627`) and sets `RUN_INFRA_TESTS=true` on real pipelines — TASK-713's own open item |
| 8 | TASK-704's seam exists and `harnessEnabled` has exactly one runtime reader | **VERIFIED** | `packages/applications/src/services/consultation/note-generation/note-generation.service.ts` is the seam (`generate()`); `note-generation/__tests__/harness-enabled-single-reader.grep-gate.test.ts` (TASK-704 Task 6, already shipped) enforces it with one documented, marker-commented allow-listed exception (`consultation-event.handler.ts`'s NER-skip read, which answers a different question — "skip duplicate NER work?", not "which generator?"). Re-ran the full `@arcaai/applications` suite this pass: **492 test files / 9153 tests passed, 0 failed** (includes this grep-gate). | N/A |
| 9 | TASK-709 (`note-occ`) has landed | **VERIFIED (code); on-the-wire proof still open**  | TASK-709 status is `Review`; SDK writes wired to the If-Match OCC contract. **Its own README documents the still-open risk this row inherits**: CDN/reverse-proxy weak-ETag rewriting (`W/"5"` vs `"5"`) can silently defeat If-Match per RFC 7232 §2.3.2, and TASK-709's Task 7 ("on-the-wire weak-ETag check") is itself HUMAN-GATED and marked open — *"cannot be completed from this repository alone… a person with access to [the deployment repo] and a deployed environment must confirm."* Per R-8: **this row is satisfied only by that deployed-environment check, not by TASK-709's local/unit tests** — say so explicitly, as instructed. | Person with `arca/hope-v2-deployment` + deployed-env access — TASK-709 Task 7 |
| 10 | The consultation palette exists and its platform default definition is seeded | **NOT VERIFIED** | TASK-731 status is `Pending` — unstarted. `packages/applications/src/services/consultation/note-generation/` (the seam TASK-731 would extend) exists, but no palette code does. | TASK-731 owner |

## Overall verdict for this row set

**Rows 1, 3, 4, 7, 10 are NOT VERIFIED; rows 2, 5, 6, 9 are VERIFIED with a named open item that is
not itself this checklist's blocker (config/tooling exists, a deployed-environment or live-traffic
observation is what's outstanding); row 8 is fully VERIFIED.**

Per Task 3's rule, **any unmet row makes the verdict automatically NO-GO regardless of what Task 2's
formulas compute** — and five rows are unmet here. This checklist does not itself render a
GO/NO-GO/INVERT verdict (that is Task 3, HUMAN-GATED and out of this pass's scope per the executing
instructions); it records, as of 2026-08-16, that **the precondition set is not yet satisfied**, so
even a favorable missing-note-rate/harm-proxy comparison could not turn this into a GO today.

## Task 4 evidence (harness-availability-report.py, re-run this pass)

```
$ ~/miniconda3/envs/arcaenv/bin/python scripts/harness-availability-report.py --since-days 90
```
(See `go-no-go-thresholds.md` §Instrumentation evidence for the full paste — reproduced there
alongside this ticket's own new missing-note-rate script so both halves of the measurement are in
one place.)
