# TASK-622 — Portability Hygiene & Operations Docs

**Status**: Closed
**Classification**: infrastructure
**Created**: 2026-08-08
**Parent**: [TASK-616 Phase 6](../TASK-616-Deployment-CICD-Observability-Modernization/README.md#phase-6--production-templates--documentation--m) · [Program index](../TASK-616-Deployment-CICD-Observability-Modernization/phase-program-index.md)
**Scope**: `hope-v2/.claude/rules/09-infrastructure-devops.md` · `hope-v2/docs/operations/` (new `deployment/` and `observability/` subtrees) · `hope-v2/docs/research/deployments/` (supersession markers) · `hope-v2/docs/implementation/TASK-596-ArcaAI-Production-Readiness/README.md` (§4 P0 closure) · `arca/hope-v2-deployment` `README.md` and `overlays/prod/{hpa,pdb}.yaml`
**Conventions**: [Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md)
**Evidence base**: [component-design-aws-portability.md §2](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-aws-portability.md) · [TASK-596](../TASK-596-ArcaAI-Production-Readiness/README.md) · live repo audit 2026-08-08 (this document)

---

## 1. Requirement Analysis

TASK-616 Phase 6 was scoped as *"the 'any kind of deployment' half of R1 without deploying
prod"* — five steps (6.1–6.5): dual-shape manifests, the Phase-0 Option-C Helm/Kustomize
hybrid, the two missing `docs/operations/` subtrees, reconciling stale docs against reality,
and closing out TASK-596's remaining P0s.

Re-verified against the repo on 2026-08-08, three of those five steps are **larger than Phase 6
described them**, and one is **partially owned by TASK-626**:

| Restated requirement | Change from the Phase-6 framing |
|---|---|
| Fix `.claude/rules/09-infrastructure-devops.md`, which still describes a deleted Kustomize tree and a deployment repo that never existed | Confirmed unchanged since `deployment/README.md`'s own blockquote flagged it and deferred the fix (§2) |
| Rewrite the `arca/hope-v2-deployment` `README.md` from generic template boilerplate into a real document | Not mentioned in Phase 6's five steps at all — found during this ticket's audit; it is genuinely zero-commits-since-template and describes resources (`base/charts/temporal/`, `ui.yaml`) that do not exist |
| Author `docs/operations/deployment/` and `docs/operations/observability/` | 6.3 as written; `observability/` content is gated on TASK-636 landing real coverage — this ticket writes the *process* doc (on-call, alert response, runbook shape), not a coverage claim |
| Mark the superseded `docs/research/deployments/` infra-planning docs as historical | 6.4 as written, narrower than "reconcile 09 with reality" — that reconciliation is 09's rewrite itself |
| Close TASK-596's still-open P0s (D2, D3, C5) or defer them with a date | 6.5 as written |
| Give `base/` dual-shape scheduling primitives (anti-affinity, PDB, HPA) | **6.1 is split with TASK-626**: this ticket owns the *base-level* anti-affinity/PDB/HPA rollout across all 11 services; TASK-626 owns *prod-overlay tiering* built on top of it. See §4 ⚠ 1 |

**Classification**: `infrastructure`. **Not** a feature ticket — every deliverable is a
document, a rule-file correction, or a scheduling-primitive manifest change; nothing here adds
user-visible product capability.

### Explicitly out of scope

| Excluded | Owned by |
|---|---|
| The Phase-0 Option-C Helm/Kustomize hybrid itself (`helmCharts:`, vendored GPU Operator/Kyverno/Prometheus Operator/Alloy charts) | [TASK-616 Phase 0](../TASK-616-Deployment-CICD-Observability-Modernization/README.md) — already done; 6.2 in this ticket is documentation of the *pattern*, not building it |
| Observability coverage itself (metrics/traces/logs/alerting/dependency monitoring) | [TASK-636](../TASK-636-Observability-Coverage-And-Dependency-Monitoring/README.md) — this ticket's `docs/operations/observability/` describes on-call process, not coverage |
| Prod-overlay resource tiering, real staging/prod namespaces, AWS-portable `components/` split | [TASK-626](../TASK-626-Staging-Production-And-AWS-Portable-Structure/README.md) — see the file-ownership split in §4 ⚠ 1 |
| GitOps recovery, Argo panic diagnosis, the four unpushed commits | [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) — this ticket's docs describe the *intended* delivery path; getting the *current* one working is 617's job |
| GPU time-slicing activation, disk reclaim | [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) §2.4 — the k3s-upgrade runbook (§3, C.3 below) documents the downtime caveat but does not execute anything |
| k3s hardening, PSA, NetworkPolicy | [TASK-618](../TASK-618-PHI-Security-Baseline/README.md) |
| Postgres restore drill, MinIO object-data backup, tenant storage credentials in Vault (TASK-596 D2/D3/C5) *execution* | Still this ticket's to close-or-defer (§1 requirement above), but the underlying HA/backup engineering may be a separate spin-out if non-trivial — see §4 ⚠ 2 |

---

## 2. Current State Evaluation

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **I-01** | High | ❌ **Not done** | `.claude/rules/09-infrastructure-devops.md:42` still describes `deployment/k3s/base/` (redis, ollama, lmstudio alias, api, guardrail, reranker, smr, stt, stt-worker, ui, `db-migrate` PreSync hook Job) — that tree was deleted 2026-07-24 in commit `1de5b8c1` ("Remove deprecated deployment files and templates", 24 files, −2622 lines) | `.claude/rules/09-infrastructure-devops.md:42`; `git log --oneline --diff-filter=D -- deployment/k3s` → `1de5b8c1` |
| **I-02** | High | ❌ **Not done** | `.claude/rules/09-infrastructure-devops.md:47` claims CI's `deploy-staging` job writes image tags to a separate `hope-deployments` Helm-values repo. **Doubly stale**: that repo never existed (TASK-616 §0, verified against the GitLab API — only 11 projects total, no `arcaai` namespace), and `deploy-staging` itself no longer exists in `.gitlab/ci/deploy.yml` — replaced by `promote-dev`/`promote-staging`/`promote-prod` (`.gitlab/ci/deploy.yml:58,71,84`), which digest-pin images into the real repo, `arca/hope-v2-deployment`, using Kustomize `base/`+`overlays/` | `.claude/rules/09-infrastructure-devops.md:47`; `hope-v2/.gitlab/ci/deploy.yml:22,58,71,84` |
| **I-03** | Medium | ⚠️ **Already flagged, not yet fixed** | `deployment/README.md:1-19` (in `hope-v2`, not the deployment repo) already carries a blockquote naming this exact staleness and states fixing the rule was "out of scope for TASK-558 lane K" — i.e. deferred once already. This ticket owns closing that deferral | `hope-v2/deployment/README.md:1-19` |
| **I-04** | Medium | ❌ **Not done** | `arca/hope-v2-deployment`'s own `README.md` has had **zero commits since `7c22bea`** (the initial template commit) and is unmodified generic boilerplate: placeholders `your-app`/`YOUR-APP`/`your-org`/`example.com` never swept, a documented tree that claims `base/charts/temporal/` (a Helm subtree — Temporal is a plain Kustomize `Deployment`/`Service` in `temporal.yaml`) and `base/ui.yaml` (deleted; `hope-ui` is retired) | `hope-v2-deployment/README.md:1-40`; `find deployment/k8s/base -name '*.yaml'` shows no `charts/`, no `ui.yaml` |
| **I-05** | High | ❌ **Not done** | The README also never explains the GPU **time-slicing model** its own manifests depend on: `stt-v2.yaml`, `stt-v2-worker.yaml`, and `ollama.yaml` all carry `nvidia.com/gpu` requests/limits, and `gpu-time-slicing.yaml` defines a `replicas: 3` ConfigMap — but the README describes none of the two-physical-GPU / 6-allocatable-slot model, the required apply order, or that the ConfigMap is deliberately excluded from `base/kustomization.yaml` (targets the `gpu-operator` namespace, outside the app's Argo Application) | `hope-v2-deployment/deployment/k8s/base/gpu-time-slicing.yaml`; TASK-617 §2.4 |
| I-06 | Medium | ❌ **Not done** | `stt-v2.yaml` and `stt-v2-worker.yaml` (the workload GPU requests, `runtimeClassName: nvidia` + `nvidia.com/gpu` req/limit) now genuinely match the README's claim about GPU passthrough — the one claim in the README that TASK-616's `8bcc85e` made true. Record this so the rewrite (C.2) doesn't over-correct a claim that is now accurate | `hope-v2-deployment/deployment/k8s/base/stt-v2.yaml`, `stt-v2-worker.yaml`, `ollama.yaml` |
| **I-07** | Medium | ❌ **Not done** | Neither `docs/operations/deployment/` nor `docs/operations/observability/` exists. `docs/operations/` today holds only: `proxmox-mcp/`, `testing/`, `retrieval-corpus-ingestion/`, `tts-model-mirror/`, `vox-sdk-release/`, `inference/`, `vault/`, plus a loose `telemetry-phi-guardrails.md` — no staging runbook, no rollback runbook, no k3s-upgrade doc, no on-call/alert-response doc anywhere in the repo | `ls docs/operations/` |
| **I-08** | Low | ⚠️ **Partially superseded, unmarked** | `docs/research/deployments/` holds 13 files from 2026-03-12 describing a 5-bridge VLAN design with Proxmox VM IDs that were never built as designed; the live network is a flat `10.10.1.0/24`. Some of the 13 (e.g. `deploy-vm430-432-vault.md`, the Postgres-HA and MinIO docs) describe infrastructure that **was** built and is live — those are not superseded, only the network-topology framing around them is. Nothing in the directory is marked historical/current | `docs/research/deployments/` (13 files, `ls` above); TASK-616 §0 cross-reference for the live `10.10.1.0/24` topology |
| **I-09** | High | ⚠️ **Partial** | [TASK-596](../TASK-596-ArcaAI-Production-Readiness/README.md) status is **Review**, not Completed (`README.md:3`). Its §4 punch list carries unresolved P0s this ticket must close-with-evidence or defer-with-a-date: **D2** Postgres restore drill never run, **D3** MinIO object-data backup absent (PHI recordings have no backup path at all — "the scariest gap on this list"), **C5** tenant storage credentials fall back to plaintext env vars because `TenantStorageConfig.credentialsRef` was never seeded with real JSON | `docs/implementation/TASK-596-ArcaAI-Production-Readiness/README.md:3,69,59` |
| **I-10** | Low | ❌ **Not done** | Zero `preferredDuringScheduling` anti-affinity anywhere in `arca/hope-v2-deployment`. Only `hope-api` carries an HPA (`overlays/prod/hpa.yaml`) and a PDB (`overlays/prod/pdb.yaml`), and only in the `prod` overlay — every other one of the 11 services has neither, in any environment | `grep -rn "preferredDuringScheduling" deployment/k8s/` → 0 hits; `overlays/prod/{hpa,pdb}.yaml` are single-resource files scoped to `hope-api` only |
| **I-11** | Low | ✅ **Done, cite for the doc** | Zero `helmCharts:` usage and no vendored charts anywhere in `arca/hope-v2-deployment` — TASK-616's Phase-0 Option-C hybrid is greenfield, so 6.2's documentation task has no existing pattern to describe yet; write it as "the pattern to follow when Phase 0's hybrid lands," not as current-state description | `grep -rn "helmCharts" deployment/k8s/` → 0 hits |

---

## 3. Implementation Plan

Three waves. Everything inside a wave runs concurrently. Tier and effort per the
[Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md).

**⚙ = human-applied** (agent authors, owner executes). **⚠ = owner decision.**

### Wave A — Rule-file and README corrections (no cluster risk, disjoint files)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **A.1** | Rewrite `.claude/rules/09-infrastructure-devops.md`'s "Cluster Deploys" section: remove the deleted `deployment/k3s/base/` tree description and the `deploy-staging`/`hope-deployments` claim; replace with the real `arca/hope-v2-deployment` Kustomize `base/`+`overlays/{dev,staging,prod}` layout and the `promote-dev`/`promote-staging`/`promote-prod` digest-pinning flow (`.gitlab/ci/deploy.yml:58,71,84`) | I-01, I-02, I-03 | Trivial — text correction against verified facts | `haiku-4-5` | default | Delete `deployment/README.md:1-19`'s blockquote once this lands (the deferral it names is closed) |
| **A.2** | Rewrite `arca/hope-v2-deployment`'s `README.md` end to end against the real tree: sweep the unreplaced `your-app`/`YOUR-APP`/`your-org`/`example.com` placeholders, remove the `base/charts/temporal/` and `base/ui.yaml` claims, describe the GPU time-slicing model (2 physical GPUs, 6 allocatable slots, the ConfigMap's deliberate exclusion from `base/kustomization.yaml`, and the required apply order from TASK-617 §2.4), and correct I-06's now-true GPU-passthrough claim rather than deleting it | I-04, I-05, I-06 | Moderate — cross-repo, needs the GPU model explained correctly | `sonnet-5` | medium | Repo: `hope-v2-deployment`. Do not describe the time-slicing *activation steps* as done — TASK-617 Wave B/D owns executing them |
| **A.3** | Mark the 13 files in `docs/research/deployments/` — add a one-line historical/current header to each stating whether the file describes infrastructure that was actually built (Vault HA, Postgres HA, MinIO, the Cloudflare tunnel) vs. the superseded 5-bridge VLAN topology design. Do not delete or move any file | I-08 | Trivial — classification + one-line headers | `haiku-4-5` | default | Cross-check each file's VM IDs against the live `10.10.1.0/24` topology (TASK-616 §0) before marking |

**Wave A gate**: no rule file or doc in the repo describes a path, repo, or CI job that does not
exist; `git grep -n "deployment/k3s\|hope-deployments\|deploy-staging"` returns zero hits outside
this ticket's own evidence citations.

### Wave B — Operations docs (new files, concurrent)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **B.1** | Author `docs/operations/deployment/` — staging deploy runbook (promote-staging → Argo sync → smoke verification), **rollback runbook** (`git revert` on `arca/hope-v2-deployment` → Argo self-heals; state the trap explicitly: under `selfHeal: true`, `argocd app rollback` alone is **not durable** — a live rollback must always be paired with a `git revert`, or the next reconcile silently re-applies the reverted state), and a **k3s upgrade runbook** that carries the GPU-passthrough-VM downtime caveat (no live migration — the GPU node goes down for the duration) | 6.3 (deployment half) | Moderate — process documentation with one load-bearing correctness trap | `sonnet-5` | medium | Read TASK-617 §2.2 (LIVE-04, disk) and §2.4 (GPU sequencing) before writing the upgrade runbook — do not re-derive the ordering, cite it |
| **B.2** | Author `docs/operations/observability/` — on-call process, alert-response procedure, SLO-definition placeholder. Describe **process** (who gets paged, how to triage, where the dashboards are), not coverage numbers — TASK-636 owns closing the coverage gaps this doc will point at | 6.3 (observability half) | Moderate | `sonnet-5` | medium | Explicit dependency on [TASK-636](../TASK-636-Observability-Coverage-And-Dependency-Monitoring/README.md) — this doc must not claim coverage that doesn't exist yet; write it so it stays true as TASK-636 lands incrementally |
| **B.3** | Document the Phase-0 Option-C Helm/Kustomize hybrid pattern (`helmCharts:` for vendored GPU Operator/Kyverno/Prometheus Operator/Alloy charts, Kustomize for in-house services) as the pattern to follow — TASK-616 Phase 0 already built it; this is documentation only, and I-11 confirms nothing in `arca/hope-v2-deployment` uses `helmCharts:` yet | 6.2 | Trivial — documents an existing pattern from Phase 0, does not build anything | `haiku-4-5` | default | Cite TASK-616's Phase 0 deliverable directly rather than re-explaining the mechanism from scratch |

**Wave B gate**: a new engineer can deploy and roll back staging from `docs/operations/deployment/`
alone, per Phase 6's own verification line.

### Wave C — Scheduling primitives + TASK-596 closure (touches `arca/hope-v2-deployment` `base/`)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **C.1** | Add `preferredDuringScheduling` pod anti-affinity to all 11 services' base manifests (never `required` — single-node dev/staging must still schedule). This is the **base-level** rollout only; do not touch `overlays/prod/{hpa,pdb}.yaml` — TASK-626 owns prod-overlay tiering on top of this base (§4 ⚠ 1) | 6.1 (base half) | Moderate — 11 disjoint per-service edits, same shape | `sonnet-5` | medium | Repo: `hope-v2-deployment`. Partition by service so agents stay on disjoint files per the Agent Operating Contract §5 |
| **C.2** | Add HPA + PDB to the remaining 10 services that currently have neither (today only `hope-api` has either, and only in `overlays/prod`) — base-level `minAvailable < HPA.minReplicas` shape, not prod-specific tuning | 6.1 (base half) | Moderate | `sonnet-5` | medium | Same file-ownership boundary as C.1 — see §4 ⚠ 1 before touching anything under `overlays/prod/` |
| **C.3** | Verify the k3s-upgrade runbook's downtime caveat (B.1) against the actual GPU-passthrough VM: confirm there is no live-migration path for a Proxmox GPU-passthrough VM and state the expected downtime window in the runbook | 6.3 | Trivial — one fact to verify and cite | `haiku-4-5` | default | Read-only against Proxmox docs/existing VM config; no cluster mutation |
| **C.4** | **Close or defer TASK-596 D2** (Postgres restore drill) — either run one real restore drill against the documented pgBackRest retention policy (`full=2`, `diff=7`) and capture the evidence, or write an explicit deferral with an owner-assigned date in TASK-596 §4 | I-09 (D2) | Complex — a live restore drill touches production-shaped data infrastructure | `opus-4-8` | high | PHI-adjacent data-recovery verification; tier bump per Agent Operating Contract rule 2 regardless of mechanical simplicity |
| **C.5** | **Close or defer TASK-596 D3** (MinIO object-data backup) — author bucket replication/versioning or an object-level backup job for PHI recordings/attachments, which currently have **no backup path at all**, or defer with a date and an explicit risk acceptance recorded in TASK-596 §4 | I-09 (D3) | Complex — PHI data-loss risk design | `opus-4-8` | high | The TASK-596 audit itself calls this "the scariest gap on this list for a healthcare platform" — do not defer silently |
| **C.6** | **Close or defer TASK-596 C5** (tenant storage credentials) — populate `platform/storage/minio` in Vault with real credentials so `TenantStorageConfig.credentialsRef` resolves instead of falling back to plaintext `S3_ACCESS_KEY`/`S3_SECRET_KEY` env vars, or defer with a documented fast-follow date | I-09 (C5) | Complex — credential provisioning, irreversible once rotated | `opus-4-8` | high | Same subsystem as the `"http://"` seed bug already fixed this cycle (see MEMORY.md); do not re-open that fix, only seed the missing credential |

**Wave C gate**: `kustomize build` of all three overlays in `arca/hope-v2-deployment` still passes
the deployment repo's five CI jobs after C.1/C.2; each TASK-596 §4 P0 row this ticket claims is
either `Done` with pasted evidence or carries an explicit deferral date.

---

## 4. Owner decisions and blocked items

| # | Item | Why it is owner-only |
|---|---|---|
| **⚠ 1** | **File-ownership split with TASK-626 on `overlays/prod/{hpa,pdb}.yaml`.** TASK-626 also touches these files for prod-overlay tiering. This ticket (TASK-622) owns the **base**-level anti-affinity/PDB/HPA rollout (C.1, C.2) across all 11 services; TASK-626 owns **prod-overlay** tiering (replica counts, resource classes) built on top of that base. Confirm this split before C.1/C.2 and TASK-626's equivalent tasks run concurrently, or they collide on the same files | Cross-ticket sequencing decision; the alternative (one ticket owns both) is equally valid but must be picked explicitly, not discovered as a merge conflict |
| **⚠ 2** | **Whether TASK-596 D2/D3/C5 are closed inside this ticket or spun into dedicated tickets.** C.4–C.6 are scoped as "close or defer" per Phase 6.5's own instruction, but each is genuinely substantial (a live restore drill, a PHI backup design, a credential-provisioning change) — TASK-596 §4's own closing note already anticipates this: *"spin off a dedicated ticket for any workstream that turns out to be non-trivial."* Decide per-item whether it stays in Wave C or becomes its own ticket before C.4–C.6 start | Scope/ticket-boundary decision, and C.4–C.6 are PHI-consequence work that should not start without an explicit go |
| **⚙ 3** | Running the actual Postgres restore drill (C.4) requires access to the production-shaped backup infrastructure this session has not verified access to | No confirmed access |
| **⚙ 4** | Seeding real MinIO credentials into Vault (C.6) is a credential-provisioning action — agents author the Vault write command, humans execute it, per the Agent Operating Contract's "agents author, they do not mutate live infrastructure" rule | Non-negotiable per the operating contract |

---

## 5. Sequencing constraints

1. **A.1 before A.2's cross-reference check.** A.2 cites the corrected CI job names from A.1; write A.1 first even though the two files are in different repos.
2. **⚠ 1 resolved before C.1/C.2 and TASK-626's equivalent tasks run concurrently.** Both tickets touch `overlays/prod/{hpa,pdb}.yaml` if the split is not honored — an unresolved ⚠ 1 means the two tickets can silently overwrite each other's work.
3. **B.1's rollback-runbook trap must be written before B.1 is considered done.** The `git revert` + `selfHeal` pairing is the load-bearing correctness fact in that runbook — a rollback runbook that omits it is actively dangerous, not merely incomplete.
4. **C.4–C.6 do not start until ⚠ 2 is resolved.** Each is PHI-consequence work; starting without an explicit scope decision risks half-finishing a credential rotation or a backup design that then needs a second pass.
5. **Wave A and Wave B have no ordering dependency on each other or on Wave C** — they touch disjoint files (rule files/docs vs. `arca/hope-v2-deployment` `base/` manifests) and can run fully concurrently.
6. **This ticket does not depend on TASK-617's GitOps recovery being complete** to author its content — but Wave C's manifest changes cannot be verified live (Argo `Synced`/`Healthy`) until TASK-617 restores the delivery path. Author now; verify once 617 lands.

---

## 6. Acceptance criteria

Wave A — rule-file and README corrections:
- [ ] `git grep -rn "deployment/k3s/base\|hope-deployments\|deploy-staging"` in `hope-v2` returns zero hits outside historical Change History entries
- [ ] `arca/hope-v2-deployment`'s `README.md` contains no unreplaced `your-app`/`YOUR-APP`/`your-org`/`example.com` placeholder and no `base/charts/temporal/` or `base/ui.yaml` claim
- [ ] The GPU time-slicing model (2 physical GPUs, 6 allocatable slots, ConfigMap exclusion, apply order) is documented in the deployment repo README
- [ ] Every file in `docs/research/deployments/` carries a historical/current header

Wave B — operations docs:
- [ ] `docs/operations/deployment/` exists with a staging runbook, a rollback runbook (stating the `selfHeal` + `git revert` pairing), and a k3s-upgrade runbook (stating the GPU-passthrough-VM downtime caveat)
- [ ] `docs/operations/observability/` exists describing on-call/alert-response process, with no coverage claim TASK-636 hasn't yet delivered
- [ ] A new engineer can deploy and roll back staging from `docs/operations/deployment/` alone (Phase 6's own verification bar)
- [ ] The Phase-0 Option-C hybrid pattern is documented

Wave C — scheduling primitives + TASK-596 closure:
- [ ] All 11 services in `arca/hope-v2-deployment` `base/` carry `preferredDuringScheduling` anti-affinity
- [ ] All 11 services carry an HPA and a PDB at the base level (`minAvailable < HPA.minReplicas`)
- [ ] `kustomize build` of all three overlays still passes the deployment repo's five CI jobs after the scheduling-primitive changes
- [ ] TASK-596 §4 rows D2, D3, C5 are each either `Done` with pasted evidence, or carry an explicit deferral date recorded in TASK-596's own README

---

## 7. Implementation Summary

*Not started — awaiting owner approval of this plan (Phase 3 gate).*

---

## 8. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Ticket created from TASK-616 Phase 6, re-verified against the live repo and `arca/hope-v2-deployment`. Widened beyond the original five steps: the deployment-repo README rewrite (I-04/I-05) was not named in Phase 6 but is a genuine zero-commits-since-template gap; the file-ownership overlap with TASK-626 on `overlays/prod/{hpa,pdb}.yaml` is called out explicitly as ⚠ 1 rather than left implicit; TASK-596's three remaining P0s (D2/D3/C5) are scoped as "close or defer," with the "may need its own ticket" possibility flagged as ⚠ 2 per TASK-596's own closing note. Status `Pending` pending owner approval. | Claude |
| 2026-08-12 | Closed — plan deprioritized, not being pursued at this time. | owner |
