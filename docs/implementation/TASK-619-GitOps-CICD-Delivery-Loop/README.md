# TASK-619 — GitOps CI/CD Delivery Loop

**Status**: Pending (plan authored 2026-08-08, awaiting owner approval)
**Classification**: infrastructure
**Created**: 2026-08-08
**Parent**: [TASK-616 Phase 3](../TASK-616-Deployment-CICD-Observability-Modernization/README.md#phase-3--real-gitops-cicd--l) · [Program index](../TASK-616-Deployment-CICD-Observability-Modernization/phase-program-index.md)
**Scope**: `hope-v2/.gitlab/ci/**` · `arca/hope-v2-deployment` (`deployment/argocd/**`, overlays) · the live `argocd` namespace · GitLab project settings
**Conventions**: [Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md)
**Evidence base**: [Appendix F — CI/CD & Promotion](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-cicd-promotion.md) · [Appendix E — Config Plane](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-config-plane.md) · [Live-state recheck 2026-08-08](../TASK-616-Deployment-CICD-Observability-Modernization/live-state-recheck-2026-08-08.md)

> ## 🚨 Read this before anything else
>
> **Two live credentials are readable in `origin/main` of `arca/hope-v2-deployment` right now.** A
> GitLab access token for the user `argocd`, and `gitlab+deploy-token-2`, were committed in plaintext
> in commit `08d1651`, which is reachable on origin today. The current file
> (`deployment/argocd/bootstrap.dev.yaml:50-65`) carries a placeholder — **deleting the value from
> the tip does not remove it from history.**
>
> Together these grant write access to the config repository that Argo CD auto-syncs into a live
> PHI cluster. **Rotate both today, before and independently of any other work in this ticket.**
> This is finding **F0-1** in §2.1.

---

## 1. Requirement Analysis

TASK-616 R2 was *"auto CI/CD following latest best practice"* — a working, automated
commit→build→deploy path with no human hand-editing of image tags, gated by tests and scans.

**The shape of this ticket changed between the assessment and today.** Appendix F (2026-08-07)
describes Image Updater and a nonexistent deploy job as the current state. That is no longer
accurate: between 2026-08-07 and 2026-08-08, most of Appendix F's own recommendation was
**implemented in code** — in `hope-v2/.gitlab/ci/deploy.yml`, `vault.yml`, and
`hope-v2-deployment/deployment/argocd/*.yaml` — but **never pushed, never applied, and never once
executed.**

So the requirement restates as:

| Part | Restated requirement |
|---|---|
| **A — Contain** | Rotate the leaked credentials; tear down the live Image Updater controller that still holds both a registry pull secret and a Git write PAT |
| **B — Land** | Get the authored delivery architecture onto origin and into the cluster: three AppProjects, three Applications, digest promotion |
| **C — Exercise** | Run it once for real, per environment. Nothing in this ticket is done on the strength of code review alone — a promotion path that has never executed is a hypothesis |
| **D — Close the gaps** | Sync waves for the app tier, Argo notifications, a rehearsed rollback, the registry retention fix |

**Classification**: `infrastructure`.

### Explicitly out of scope

| Excluded | Owned by |
|---|---|
| Getting today's single Argo Application to sync at all (the nil-pointer panic, the Rancher-proxy destination, the four unpushed commits) | [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) — **hard prerequisite** |
| gitleaks/Trivy/cosign/SBOM/Kyverno, Vault OIDC activation, GPU runner | [TASK-621](../TASK-621-Supply-Chain-Integrity/README.md) |
| Branch-model design, Vault CI role definitions | [TASK-629](../TASK-629-Branch-Model-Vault-Boundary-And-Release-Gates/README.md) — this ticket *consumes* its output |
| `harness-worker` build target and manifest | [TASK-625](../TASK-625-Harness-Temporal-Worker-And-Consolidation/README.md) |
| Creating the staging/prod **namespaces and workloads** | [TASK-626](../TASK-626-Staging-Production-And-AWS-Portable-Structure/README.md). This ticket lands the *Argo objects*; 626 makes the environments real |

Boundary with TASK-617: **617 makes the existing app sync. 619 replaces it with the real
architecture.** 617 must land first or 619's first `kubectl apply` goes into a panicking controller.

---

## 2. Current State Evaluation

### 2.1 Security — act now

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **F0-1** | **Critical** | ❌ **Live** | A GitLab access token for user `argocd` and `gitlab+deploy-token-2` were committed in plaintext and the commit is **on `origin/main` today**. Anyone with repo read has write access to the config repo Argo auto-syncs into a live PHI cluster | `hope-v2-deployment` history at `08d1651`; current placeholder at `deployment/argocd/bootstrap.dev.yaml:50-65` |
| **F1-live** | **High** | ❌ **Live** | The Image Updater *controller* — Deployment, CRD, and its `registry-creds` Secret — was still running in the cluster as of the 2026-08-07 inspection, with `images_updated=0` forever. **Removing YAML from Git does not stop a running Deployment.** It holds both a registry pull credential and a Git write PAT and polls the registry every 2 minutes | Appendix B live finding; no decommission evidence in either repo |

### 2.2 Delivery architecture — authored, unpushed, unapplied

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| F1 | Critical | ✅ **Resolved in code** | The three Image Updater defects (a tag regex matching nothing published, a write-back branch Argo never reads, 6 of 12 images uncovered) are moot — it is decommissioned in the tree, replaced by CI promotion | `bootstrap.dev.yaml:1-33` (removal note) |
| F2 | High | ✅ **Resolved in code** | `promote-dev`/`promote-staging`/`promote-prod` use short-TTL Vault-issued tokens instead of a standing controller with a permanent PAT | `.gitlab/ci/deploy.yml:34-105`, `.gitlab/ci/promote.sh` |
| **F3** | High | ⚠️ **Authored, never executed** | Digest promotion is implemented — `docker buildx imagetools inspect`/`create` copies the exact `sha-<sha8>` manifest, then `kustomize edit set image <svc>=...@sha256:...` pins the overlay. **But no `promote-*` job has ever run.** `overlays/dev/kustomization.yaml` still carries 11 mutable `newTag: dev-<sha8>` entries and **zero `@sha256:`** | `promote.sh:62-127`; `overlays/dev/kustomization.yaml` |
| F5 | High | ⚠️ **Authored, unapplied** | Per-env auto-sync matrix is exactly per spec: dev/staging `automated: {prune: true, selfHeal: true}`; prod has **no `automated:` block at all** — the correct CE-only way to mean "off" | `application-dev.yaml:32-34`, `application-staging.yaml:36-38`, `application-prod.yaml` |
| F8 | High | ⚠️ **Authored, unapplied** | Three separate AppProjects replace the single shared one that wrongly rejected `rbac.authorization.k8s.io` everywhere and `autoscaling`/`policy` in prod. `orphanedResources.warn: true` on prod only | `appproject-{dev,staging,prod}.yaml` |
| **LIVE-08** | Medium | ❌ **Live** | The cluster has exactly **one** Argo Application — hand-created 2026-03-31 (`managedFields.manager: kubectl`), pointed at `overlays/dev`. None of the six authored objects exist live | ArgoCD API, 2026-08-08 |
| F6 | Low | ⚠️ **Partial** | Sync waves exist for infrastructure — `db-migrate` PreSync wave `-1`, Vault Sync-hook waves `0`/`1`, Temporal `2`/`3`, `smoke-test` PostSync `5`. **The entire app tier carries no wave** and defaults to `0`, racing Vault's own wave-`0`/`1` hooks | `db-migrate.yaml:9-11`, `vault.yaml:39,128-130`, `temporal.yaml:27,132`, `smoke-test.yaml:32-34` |
| F6b | Low | ❌ **Stubs** | Argo CD Notifications on `on-sync-failed`/`on-health-degraded` are `TODO(owner)` stubs — no destination channel wired | `application-staging.yaml`, `application-prod.yaml` |
| F7 | Medium | ❌ **Not started** | The rollback runbook is documented in Appendix F and has **never been rehearsed**. No measured rollback time exists; the 5–8 min worst case is theoretical | Appendix F §F7; README §5 DoD item unchecked |
| **F9-partial** | Medium | ❌ **Absent** | `promote.sh:69,77-80` lists `harness-worker` in `SERVICES` and **skips it with a warning** because no Dockerfile target, CI job or manifest exists. It will silently start working the day TASK-625 lands — but promotion coverage is 10/11 until then | `promote.sh:69,77-80`; `.gitlab/ci/build.yml` |
| **F12 / C-20** | Medium | ❌ **Live** | Registry `container_expiration_policy` is `cadence:7d, keep_n:25, older_than:90d` with `name_regex:".*"` and **no `name_regex_keep`**. Promoted and release digests are reaped after 90 days — **the rollback horizon is silently capped, directly undermining F3's "promote a digest, never rebuild" guarantee**: a promoted digest can be garbage-collected out from under a still-deployed overlay | Live project setting, 2026-08-07 |

### 2.3 Owner-blocked GitLab and Vault state

Every one of these is a project-level setting or a Vault write. **None can be delegated to an agent**,
and the deploy jobs cannot authenticate until they land.

| ID | Sev | Statement | Consequence |
|---|---|---|---|
| **C-21** | High | `only_allow_merge_if_pipeline_succeeds: false` at the project level | An MR can merge with a red pipeline. **Every "tests gate the merge" assumption in this phase is false** until a Maintainer flips this |
| **C-22** | Medium | `restrict_user_defined_variables: false` + `ci_pipeline_variables_minimum_override_role: developer` | Any Developer can override `VAULT_ADDR`/`DEPLOY_REPO_URL` at pipeline-trigger time — a privilege-escalation path into the deploy jobs on any unprotected branch |
| **C-23** | Medium | The default branch is `dev` and it is **not protected** | Direct pushes to the default branch are unrestricted |
| **Vault-boundary** | High | `ref_protected: "true"` is written into the design (`vault.yml:96,109,123`) but **cannot be turned on** — only `main` and `release` are protected refs today. And the `hope-ci-deploy-{dev,staging,prod}` roles most likely **do not exist in live Vault** (no `vault write auth/jwt-gitlab/role/...` evidence in either repo) | **Every `promote-*` job will fail Vault login** until the refs are protected *and* the roles are written, in that order |

> **The current failure mode is correct.** The old shared `hope-ci-deploy` role's glob literals
> (`"staging"`, `"dev"`) do not match real branch names, so today nothing can authenticate as a
> deploy role at all — failing closed, not open. **Do not "fix" this by loosening the glob before
> ref protection lands.** That would convert a fail-closed state into a fail-open one.

---

## 3. Implementation Plan

**⚙ = human-applied. ⚠ = owner decision.** Tier/effort per the
[Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md).

### Wave A — Contain (start immediately, no dependency on anything)

| # | Task | Closes | Complexity | Tier | Effort |
|---|---|---|---|---|---|
| **A.1** | 🚨 ⚙ **Rotate both leaked credentials.** Revoke the `argocd` GitLab access token and `gitlab+deploy-token-2`; issue replacements; update the live `repo-creds` Secret's `stringData.password` **out-of-band** — never re-commit the real value (`bootstrap.dev.yaml` already documents `__SUPPLIED_OUT_OF_BAND__`) | F0-1 | — | **human** | — |
| **A.2** | **Author the Image Updater decommission runbook**: `kubectl delete deployment/argocd-image-updater -n argocd` (or `helm uninstall` if Helm-installed), delete its `registry-creds` Secret and `argocd-image-updater-config` ConfigMap, confirm via `kubectl get all -n argocd` that nothing still polls. Include a rollback. ⚙ execution is human | F1-live | Moderate | `sonnet-5` | medium |
| **A.3** | **Write the retro note on why the leak was not caught**: no CI existed in `hope-v2-deployment` until `37cf4f6`. Record why the new `gitleaks` job deliberately runs `--no-git` (working-tree-only) until rotation completes, and the exact condition for flipping it to full-history. Hands off to [TASK-621](../TASK-621-Supply-Chain-Integrity/README.md) step 1 | — | Trivial — text | `haiku-4-5` | default |

### Wave B — Land ⚙ (needs TASK-617 Wave B complete)

| # | Task | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|
| **B.1** | ⚙ **Protect `dev-*`, `staging-*`, `prod-*` branches and the `v*` tag** in GitLab | — | **human** | — | Payloads specified in [TASK-629 §5.2-5.3](../TASK-629-Branch-Model-Vault-Boundary-And-Release-Gates/README.md). **Nothing downstream authenticates until this lands** |
| **B.2** | ⚙ **Write the `hope-ci-deploy-{dev,staging,prod}` roles and policies to live Vault.** Commands are already drafted at `vault.yml:88-127` | — | **human** | — | **Strictly after B.1** — never before (§5) |
| **B.3** | ⚙ Flip `only_allow_merge_if_pipeline_succeeds: true` and `restrict_user_defined_variables: true` (or raise the override-role floor to `maintainer`) via `PUT /projects/6` | — | **human** | — | ⚠ Confirm the single global switch does not block a legitimate emergency-merge workflow (§4) |
| **B.4a** | 🔴 **Amend the six authored Argo files before applying them.** [TASK-617 A.4](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/wave-a4-argo-direct-api-runbook.md) found that `appproject-dev.yaml` and `application-dev.yaml` **still hard-code the Rancher proxy URL** (`https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq`). Applying them as-is would carry L-01 forward unchanged — the rename alone does not fix the destination. A two-line diff, plus the matching `AppProject` `destinations[]` allow-list entry | Moderate — small diff, easy to miss | `sonnet-5` | medium |
| **B.4b** | **Author the Argo object cutover runbook**: apply `bootstrap.dev.yaml` server-side, then each `appproject-*.yaml` and `application-*.yaml` in the order documented at `bootstrap.dev.yaml:35-46`. **This replaces the hand-created `AppProject hope-v2` / `Application hope-v2`** — the runbook must cover the `hope-v2` → `hope-v2-dev` rename and verify Argo neither orphans nor recreates workload resources during the swap. **Keep the first sync manual with `--prune=false`** before letting `prune: true` take over. Note the `argocd-manager` ServiceAccount, ClusterRole, ClusterRoleBinding **and** a K8s ≥1.24-style manual token Secret **already exist on `c-nfhxq`** (created 2026-03-19) — the only genuinely new object is the Argo-side cluster registration `Secret`. ⚙ execution is human | Complex — a mis-sequenced swap can orphan live workloads | `opus-4-8` | high |
| **B.5** | ⚙ **Add `name_regex_keep`** (e.g. `^(v.*|prod-.*|sha-.*)$`) to the registry `container_expiration_policy` | — | **human** | — | **Shared with [TASK-621](../TASK-621-Supply-Chain-Integrity/README.md) — implement once, close both.** Note: exempted tags also stop counting toward `keep_n`, by design |

### Wave C — Exercise (the part that actually proves it)

| # | Task | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|
| **C.1** | ⚙ Trigger one real `dev-*` pipeline; observe `promote-dev` end-to-end: Vault login via `hope-ci-deploy-dev` → `imagetools create` per service → a commit landing in `hope-v2-deployment` → Argo reconciling to the new digest | — | **human** | — | This is also the first live test of whether B.2's Vault role exists. **Expect failure on Vault auth if B.1/B.2 were skipped — that is the correct signal** |
| **C.2** | **Verify digest pinning actually lands.** After C.1, `overlays/dev/kustomization.yaml` must show `newName: ...@sha256:...` replacing every `newTag: dev-<sha8>`. **If mutable tags survive a successful promote run, that is a new defect, not a doc gap** | Moderate — verification with a real failure mode | `sonnet-5` | medium | On GitLab CE, digest pinning is the *sole* defense against tag mutation (§6). There is no fallback control |
| **C.3** | ⚙ Same for one `staging-*` push, and — once a protected `v*` tag exists — one manual `promote-prod` | — | **human** | — | Prod is a **two-gate** model: a human clicks the manual job, then a second human clicks Sync |

### Wave D — Close the remaining gaps

| # | Task | Closes | Complexity | Tier | Effort |
|---|---|---|---|---|---|
| **D.1** | **Add `argocd.argoproj.io/sync-wave` to the app tier** — guardrail/nlp/smr/stt/stt-worker/tts/harness at wave `2`, `api` at `3`, `admin-console`/`compat-playground` at `4`. They currently default to `0` and race Vault's own wave-`0`/`1` hooks | F6 | Moderate | `sonnet-5` | medium |
| **D.2** | **Wire Argo CD Notifications** — `on-sync-failed`/`on-health-degraded` for staging, plus `on-sync-succeeded` for prod. ⚠ Blocked on the owner naming a channel | F6b | Moderate | `sonnet-5` | medium |
| **D.3** | **Write the rollback runbook, then ⚙ rehearse it once against staging and time it.** One real `git revert` of a `promote-staging` commit, with Argo reconciling under `selfHeal`. Record the measured time against Appendix F's theoretical 5–8 min. **The runbook must state that `argocd app rollback` alone is not durable under `selfHeal: true`** — a live rollback must always be paired with a `git revert`, even mid-incident | F7 | Complex — the doc is easy, the trap is not | `sonnet-5` | high |

---

## 4. Owner decisions and blocked items

| # | Item | Why it is owner-only |
|---|---|---|
| 🚨 **1** | **Rotate the two F0-1 credentials** | GitLab admin; irreversible; the actual security boundary |
| **⚙ 2** | Protect `dev-*`/`staging-*`/`prod-*` branches + `v*` tag | GitLab Maintainer/Owner |
| **⚙ 3** | Write the three `hope-ci-deploy-*` Vault roles | Vault operator token |
| **⚠ 4** | Flipping `only_allow_merge_if_pipeline_succeeds` is a **single global project switch**, not a per-branch rule — it will also gate merges into `dev-*`. Confirm that is wanted | Team-workflow decision |
| **⚠ 5** | **Name a notification channel** (Slack webhook / email) for Argo notifications | No destination exists anywhere; blocks D.2 |
| **⚠ 6** | **Must the `v*` release tag be signed (`git tag -s`)?** Appendix F §F11 recommends yes for PHI; undecided. Also [TASK-629](../TASK-629-Branch-Model-Vault-Boundary-And-Release-Gates/README.md) Open Question 3 | Policy decision |
| **⚙ 7** | Decommission the live Image Updater and confirm the hand-created Argo objects are gone | Cluster operator; ideally the same session as B.4 |

---

## 5. Sequencing constraints

```
A.1 rotate credentials ─────────────────────────────► (independent, do first)
A.2 decommission Image Updater ─────────────────────► (independent)
        │
TASK-617 Wave B complete (Argo syncs at all)
        │
        ▼
B.1 protect dev-*/staging-*/prod-* + v*        ◄── HARD GATE
        │
        ▼
B.2 write hope-ci-deploy-* Vault roles         ◄── MUST follow B.1, never precede
        │
        ▼
B.4 apply 3 AppProjects + 3 Applications; retire the hand-made pair
        │
        ▼
C.1/C.3 run real dev-* and staging-* pipelines → C.2 verify digests land
        │
        ├──► D.1 sync waves        (independent, any time)
        ├──► D.2 notifications     (blocked on ⚠ 5)
        └──► B.5 name_regex_keep   (independent, any time)
        │
        ▼
first v* tag → promote-prod (manual) → manual Argo sync → D.3 rehearse rollback
```

Two orderings are hard:

1. **B.1 before B.2.** Writing a Vault role with `ref_protected: "true"` against refs that are not
   yet protected produces a role that denies everything — and the tempting "fix" is to loosen the
   glob, which converts a fail-closed state into a fail-open one.
2. **TASK-617 before B.4.** Applying six new Argo objects into a controller that panics on every
   sync produces an uninterpretable failure.

---

## 6. GitLab CE traps

These are constraints of the tier, not defects. Designing past them wastes a cycle.

- **No Protected Environments, no per-rule multi-approval, no merge trains.** The two-gate model
  (protected `v*` tag creation + a manual Argo sync click) is the *entire* CE-available approval
  surface. Do not design a third review step assuming CE has more.
- **No immutable container tags** (Ultimate-only). Digest pinning in the overlays is the **sole**
  defense against tag mutation. If C.2 fails, there is no fallback control — a mutable `dev-<sha8>`
  tag being repointed under a running deployment is unguarded until promotion is proven to pin.
- **`ref_protected` is asserted by GitLab's OIDC issuer, not by the glob.** A pipeline author cannot
  forge it by naming a branch `staging-evil`. But until refs are actually protected, `ref_protected`
  is simply `false` for everything, so **the glob alone is the only boundary today**.
- **A `v*` tag does not move the commit.** `promote-prod` depends on the same `sha-<sha8>` image a
  prior `dev-*`/`staging-*` pipeline built already existing in the registry. Tagging a commit that
  was never built on those branches makes `promote-prod` **fail cleanly** (`imagetools inspect`
  finds nothing) rather than silently rebuilding. **Preserve that fail-closed behaviour — never
  "fix" it into a fallback rebuild**, which would defeat F3 entirely.
- **`prod-*` and `production-*` are not interchangeable** in GitLab, Vault, or Argo — no glob covers
  both. `production-*` was deliberately retired (`.gitlab-ci.yml:79-94`); do not resurrect it.
- **Argo `selfHeal` silently reverts a rollback that is not also a Git commit.** See D.3.

---

## 7. Acceptance criteria

- [ ] Both F0-1 credentials are rotated; a request using either old value **fails**
- [ ] `argocd-image-updater` Deployment, its `registry-creds` Secret and its ConfigMap no longer exist; `kubectl get all -n argocd` confirms it
- [ ] `hope-v2-deployment` `origin/main` matches local HEAD
- [ ] Live Argo shows exactly three Applications — `hope-v2-dev`, `hope-v2-staging`, `hope-v2-prod` — each backed by its own AppProject; no hand-created `Application hope-v2` remains
- [ ] A push to a `dev-*` branch produces, with zero human intervention: build → `promote-dev` → a digest-pinned commit in `hope-v2-deployment` → `hope-v2-dev` Synced + Healthy within one poll interval
- [ ] Same for `staging-*` → `promote-staging`
- [ ] A protected `v*` tag → `promote-prod` (manual) → a human clicks → `hope-v2-prod` shows `OutOfSync` until a second human clicks Sync
- [ ] `overlays/dev` and `overlays/staging` carry `@sha256:` image refs after promotion — **no mutable tag survives**
- [ ] Deleting any Application/AppProject and re-syncing from Git recreates it identically
- [ ] Sync waves cover every workload tier; a full-stack sync from empty completes in dependency order with zero `CrashLoopBackOff` from a service starting before its dependency
- [ ] One rollback is rehearsed against staging and its wall-clock time is recorded in §8
- [ ] `container_expiration_policy.name_regex_keep` exempts `v*`/`prod-*`/`sha-*`; a policy dry-run confirms a >90-day-old release tag survives
- [ ] `only_allow_merge_if_pipeline_succeeds` is `true`; a red pipeline blocks a merge

---

## 8. Implementation Summary

*Not started — awaiting owner approval of this plan (Phase 3 gate).*

---

## 9. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Ticket created. TASK-616 Phase 3 was never spun out; this creates it. **The ticket's shape differs sharply from Appendix F's**: most of Appendix F's recommendation was implemented in code on 2026-08-07/08 but never pushed, applied, or executed — so this is a land-and-prove ticket, not a build ticket. Re-audit surfaced one **critical** new finding: **two live credentials are readable in `origin/main`'s history** (F0-1), plus a still-running Image Updater controller holding a registry credential and a Git write PAT (F1-live). Recorded the hard Vault sequencing constraint (protect refs *before* writing roles, and never loosen the glob instead) and the GitLab CE trap set. Status `Pending` pending owner approval. | Claude |
