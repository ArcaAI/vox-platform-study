# TASK-616 Appendix F — CI/CD, Auto-Deployment & Promotion Pipeline

**Date**: 2026-08-07 · **Status**: Draft for owner decision — nothing applied.

Grounded in `deployment/argocd/bootstrap.dev.yaml` (commit `08d1651`, 2026-08-07) and `hope-v2/.gitlab/ci/**`.

---

## F0. 🔴 Rotate two credentials before anything else

`deployment/argocd/bootstrap.dev.yaml` commits **two live secrets in plaintext**, and the commit is **pushed to `origin/main`**:

| Location | Secret | Blast radius |
|---|---|---|
| `repo-creds.stringData.password` | GitLab access token for user `argocd` | **Write** access to the config repo Argo auto-syncs — anyone with repo read can commit manifests the cluster will apply |
| `registry-creds.stringData.credentials` | `gitlab+deploy-token-2` | Registry pull |

Deleting the file is insufficient — the values are in history. **Rotate both.**

Why nothing caught it: the deployment repo **has no CI**, so `.gitleaks.toml` (291 lines, in the *monorepo*) never sees it. This is the concrete case for the deployment-repo CI guardrail, not a hypothetical one.

---

## F1. The Image Updater has three independent defects — each fatal alone

I previously reported only the stale image names. That was incomplete. Verified against `.gitlab/ci/templates.yml:126-146` and `build.yml`:

| # | Defect | Evidence | Fix |
|---|---|---|---|
| **a** | **The tag regex matches nothing CI publishes.** `allowTags: "regexp:^[0-9a-f]{7,40}$"` is anchored, whole-string, pure hex. Every published tag carries a non-hex prefix — `dev-6fba22dc`, `staging-<sha8>`, `sha-<sha8>`. **This is the actual cause of `images_skipped=3`** | `bootstrap.dev.yaml:148` vs `templates.yml:133-146` | `^dev-[0-9a-f]{8}$` per environment — or drop Image Updater entirely (F2) |
| **b** | **Write-back targets a branch Argo never reads.** `writeBackConfig.gitConfig.branch: "dev"`, but `Application.spec.source.targetRevision: main` | `bootstrap.dev.yaml:152` vs `:119` | `branch: "main"`. Do **not** create a `dev` branch — the repo is already one-branch/directories-per-env |
| **c** | **Stale names + 6 of 12 images uncovered.** `stt-v2-ml-runtime`/`stt-v2-worker` vs CI's `stt-ml-runtime`/`stt-worker`; `ui-playground` is deprecated and not deployed; `guardrail`, `harness`, `nlp`, `tts`, `admin-console`, `compat-playground` are absent | `bootstrap.dev.yaml` image list vs `overlays/dev/kustomization.yaml:123-156` | Correct the names, drop `ui`, add the six |

This reconciles the log line exactly: `images_considered=3` = `api`, `smr`, `db` (the only aliases whose `manifestTargets.kustomize.name` resolves against the live overlay); `images_skipped=3` = those three failing the tag regex; `stt`/`stt-worker`/`ui` never reach "considered" because their kustomize name matches nothing.

---

## F2. Repair or replace? — **Replace**

Repair is a handful of lines, but Image Updater should not remain the deployment mechanism here:

1. **Upstream says so.** `argocd-image-updater` is an `argoproj-labs` project documented as not recommended for critical production workloads. For a PHI platform that is not a caveat to route around.
2. **The credential model you're already living is its textbook risk.** One controller holds registry pull creds *and* a Git write PAT — and both are currently plaintext in a pushed commit (F0). Compare the alternative already 80% built in this repo: `.gitlab/ci/vault.yml` issues a Vault JWT-OIDC token scoped by `bound_claims`, **10-minute TTL, 20 uses, audited, never resident**. Same capability, strictly better posture.
3. **It has no idea what passed tests or scans.** `updateStrategy: newest-build` polls the registry and takes the newest by creation time — it will happily promote an image pushed by a red pipeline or a laptop `docker push`. CI *is* the gate; `build-api` already `needs: test-api`.
4. **Its failure mode is silent.** `images_updated=0` has been true forever with nobody paged. A failed CI job is red in GitLab.
5. **It doesn't scale to 12 services without 12 chances to typo a name** — 2 of 6 are already wrong.

**Recommendation**: decommission the `ImageUpdater` CRD and the `registry-creds` Secret. Extend the existing `deploy-staging` pattern into environment-scoped `promote-*` CI jobs. Keep `repo-creds` — Argo's read-only pull is fine and necessary.

⚠️ `deploy-staging` needs **rewriting, not repointing**: `.gitlab/ci/deploy.yml:10-24` edits a Helm-values layout (`apps/<svc>/values-staging.yaml`) that has never existed here. The real repo is pure Kustomize.

---

## F3. Promote a digest — never rebuild

Today, `.build-common-rules` (`build.yml:18-22`) fires independently on `dev-*`, `staging-*`, and `prod-*` pushes, and `.build-template` runs a fresh `docker buildx build --push` every time. Even at the same `CI_COMMIT_SHA` you get structurally different images: base-layer cache drift, `apt`/`pip` resolved at two different moments, different `created` labels.

- **Security**: a digest is content-addressed; a tag is a mutable pointer. If "prod" means "whatever the prod branch rebuilt," you cannot attest that what runs is what was scanned — and with GitLab CE, that container scan is the *only* automated security signal you get.
- **Reproducibility**: promotion should be a Git-metadata operation, not a compute operation. It eliminates the whole "worked in staging, broke in prod" class caused by nothing but two builds twelve hours apart.

**Mechanism**: build once on `dev-X.Y`. The `sha-<sha8>` tag every build already pushes is the immutable handle. Promotion copies that manifest to a new tag with zero rebuild — `docker buildx imagetools create` (already in the `docker:27` image) or `crane copy`. Pin staging/prod overlays to the resolved `sha256:` digest via kustomize `images[].digest`.

```
 hope-v2 (source)                          hope-v2-deployment (branch: main)
 ────────────────                          ─────────────────────────────────
 dev-2.1 ──► build ONCE                    ┌─ overlays/dev/     ← App "hope-v2-dev"     auto + prune + selfHeal
      │      test → scan → push            │
      │      sha-<sha8>, dev-<sha8> ──────►│  promote-dev (CI, automatic)
      ▼                                    │
   MR → staging-2.1  (protected, ≥1 approval)
      │                                    ├─ overlays/staging/ ← App "hope-v2-staging" auto + prune + selfHeal
      │   promote-staging: imagetools copy │      ↳ PostSync smoke tests
      │   sha-<sha8>@<digest> → staging-*  │
      ▼   commit digest-pinned overlay     │
   soak + smoke green + QA sign-off        │
      │                                    │
   MR → prod-2.1  (protected, ≥1 approval) │
      │                                    └─ overlays/prod/    ← App "hope-v2-prod"    MANUAL sync
      │   promote-prod: when: manual              ↳ PostSync smoke tests
      ▼   commit digest-pinned overlay → Argo shows OutOfSync → human clicks Sync
```

> ⚠️ **Superseded prod step.** The `MR → prod-2.1` branch trigger above is the *current* topology, not the recommendation. Per **F11**, production should be triggered by a **protected `vX.Y.Z` tag** and `prod-*` branches should stop building entirely. Everything before that step is unchanged.

---

## F4. Human approval on GitLab CE — what is actually enforceable

CE lacks Protected Environments (EE) and approval rules by group (Premium). What it *does* have, layered:

1. **Protected branches with wildcards** — `staging-*` and `prod-*`, push/merge restricted to Maintainer. `.gitlab/ci/vault.yml:105-115` already records this as "THE INTENDED END STATE" and flags that today only `main` and `release` are protected.
2. **Require an MR with ≥1 approval** into `staging-X.Y`/`prod-X.Y`. The single global approval-count rule is Free-tier; per-rule multi-approver and Code Owners are Premium — don't oversell it, but 1 approval on a Maintainer-only branch is real.
3. **`when: manual` on `promote-prod`.** The load-bearing part isn't the button — it's that GitLab restricts *who can trigger a job on a protected branch* to users with push/merge rights there.
4. **Vault `bound_claims` with `ref_protected`** — even someone who could run the job on an unprotected branch gets a Vault auth denial, not just a UI block.

Net: two Maintainer-role actions are structurally required to reach prod, both in GitLab's audit events. That's the closest CE equivalent to a protected-environment approval record.

---

## F5. Per-environment auto-sync matrix

Current state precisely: `bootstrap.dev.yaml:124-131` sets `automated: {}` — **auto-sync on, `prune` and `selfHeal` both defaulting to `false`**, despite the comment above it claiming otherwise.

| Env | `automated` | `prune` | `selfHeal` | Precondition |
|---|---|---|---|---|
| dev | on (already) | **on** | **on** | The 7 ConfigMap keys in Git ([Appendix E](./component-design-config-plane.md)); `hope-ui` decision made; one `argocd app diff --local` dry run |
| staging | on | **on** | **on**, with alerting | Same, plus fixed promotion coverage — auto-sync against a half-updating source makes `OutOfSync` meaningless for 6 of 12 services |
| prod | **off — manual** | manual `--prune` only | **off** | See below |

**Why prod stays manual.** CE gives no protected-environment gate, so the Argo sync action itself is the only remaining independent human checkpoint. If prod auto-syncs, the MR merge is the last human action and a bad manifest rolls out unattended. Keeping prod manual makes the sync a genuine second approval.

**`selfHeal` on prod would also break incident response** — an on-call engineer's `kubectl scale` or emergency env patch gets reverted almost immediately (reconciliation is watch-based, not bound by the 3-minute poll). There is no clean "pause for an hour" primitive.

**Carry `ignoreDifferences` on `/spec/replicas` into every environment**, not just dev. Prod has an HPA; without it, Argo fights the HPA controller on every reconciliation.

---

## F6. Sync waves for a full-stack release

Extending the annotations already present (`db-migrate` at wave `-1`, Vault at `0`, vault-init at `1`):

| Wave | Phase | Resources | Why |
|---|---|---|---|
| `-1` | PreSync | `hope-db-migrate` | Schema must be forward-compatible with both old and new code before either runs |
| `0` | Sync | `hope-vault` | Everything downstream needs it for `SECRETS_PROVIDER=vault` |
| `1` | Sync | `hope-vault-init`, Temporal | Vault must be unsealed before secrets are read |
| `2` | Sync | guardrail, nlp, smr, stt, stt-worker, tts, harness, harness-worker | No intra-tier ordering — they retry on startup |
| `3` | Sync | `hope-api` | Proxies wave-2 services; safe to start before they're Ready |
| `4` | Sync | admin-console, compat-playground | Depend on a routable gateway |
| — | PostSync | one smoke-test Job per service | Verify before declaring `Healthy` |

**Do not copy the dev overlay's hook-stripping patch** (`overlays/dev/kustomization.yaml:12-22`) into staging or prod — it deliberately turns `db-migrate` into a plain Job for local iteration.

PostSync smoke tests should curl **the same endpoint the kubelet already trusts** (each service's existing `readinessProbe` path) rather than inventing a new surface. A failed PostSync hook marks the sync `Degraded`, which is the built-in feedback loop — no extra tooling.

**Wire Argo CD Notifications** for `on-sync-failed` and `on-health-degraded`. The Image Updater's silent `images_updated=0` is the lesson here: the fix isn't just "make it work," it's "make every failure mode page someone."

---

## F7. Rollback

This is GitOps, so the durable rollback is a **`git revert` of the promotion commit**, not `argocd app rollback`. The distinction is a real footgun: `argocd app rollback` mutates live state to a prior revision, but with `selfHeal: true` the next reconciliation re-applies current Git and silently undoes it.

- **selfHeal on (dev/staging)**: `git revert` + push. Argo reconciles within the poll interval (3 min default; near-instant with a webhook — worth adding).
- **selfHeal off (prod)**: `argocd app rollback` is safe for the fast path, but **follow it with a Git revert** or the next manual sync reintroduces the bad version.

**Time budget**, bounded by the manifests rather than guessed: revert+push ≈ seconds; detection ≤ 3 min (or instant with a webhook); rolling convergence for `hope-api` is bounded by `startupProbe.failureThreshold: 30` × `periodSeconds` (`api.yaml:95-99`) with `maxUnavailable: 0` keeping the old pod serving. **Worst case ≈ 5–8 minutes; typically under 2.**

⚠️ **Migrations are forward-only** (`02-database-prisma.md`: "NEVER edit a committed migration; roll forward"). A rollback of the *image* does not roll back the *schema*. Crossing a breaking migration boundary needs a compensating forward migration, not a revert — which is the practical argument for expand/contract discipline per release.

---

## F8. The AppProject is right about Secrets and wrong about two resource groups

**Correct and load-bearing**: `namespaceResourceBlacklist: [{group: "", kind: Secret}]`. Argo cannot manage Secrets, forcing them out-of-band. That matches the project's own PHI posture (Vault injection over materialized k8s Secrets). The cost — `kubectl apply -f secrets.dev.yaml` per environment, rotation as a scripted rather than GitOps operation — is the right trade, not a gap.

**Two verified gaps** that will break the stack the project is meant to protect:

1. **`rbac.authorization.k8s.io` is missing.** Verified: `base/vault.yaml:102,111` deploys a `Role` and `RoleBinding` for the vault-init ServiceAccount. The whitelist covers only `""`, `apps`, `batch`, `networking.k8s.io` — so **Argo refuses to manage them**. This likely explains why vault-init objects show hand-applied `last-applied-configuration` drift.
2. **`autoscaling` and `policy` are missing.** Verified: `overlays/prod/` contains `autoscaling/v2 HorizontalPodAutoscaler` and `policy/v1 PodDisruptionBudget`. **Reusing this AppProject for prod would reject prod's own HPA and PDB.**

**Recommendation**: three separate AppProjects, not one shared. Separate blast radius, and it allows per-environment Argo `roles:` later (e.g. a `ci-promote` role that can sync only its own Application). Add `rbac.authorization.k8s.io` everywhere (with `ClusterRole`/`ClusterRoleBinding` explicitly blacklisted), and `autoscaling`/`policy` **to prod only** — least privilege per environment beats consistency for its own sake. Add `orphanedResources: {warn: true}` on prod to surface out-of-band applies instead of silently pruning them.

---

## F9. The canonical service list — 11 deployable services

Confirmed with the owner 2026-08-07. This is the authoritative list; every image list, Image Updater config, PostSync smoke test, and overlay `images:` block must cover exactly these:

| # | Service | Image | Notes |
|---|---|---|---|
| 1 | `api` | `hope-v2/api` | NestJS gateway |
| 2 | `stt` | `hope-v2/stt-ml-runtime` | ⚠️ **not** `stt-v2-ml-runtime` |
| 3 | `stt-worker` | `hope-v2/stt-worker` | ⚠️ **not** `stt-v2-worker` |
| 4 | `smr` | `hope-v2/smr` | |
| 5 | `guardrail` | `hope-v2/guardrail` | |
| 6 | `harness` | `hope-v2/harness` | |
| 7 | `harness-worker` | `hope-v2/harness-worker` | **Does not exist yet** — Dockerfile target + CI job + manifest all needed |
| 8 | `nlp` | `hope-v2/nlp` | |
| 9 | `tts` | `hope-v2/tts` | |
| 10 | `admin-console` | `hope-v2/admin-console` | |
| 11 | `compat-playground` | `hope-v2/compat-playground` | **Retained** — ⚠️ currently missing from the staging overlay's `images:` list (defect D-04) |

Plus `database` as the migration-Job image (not a long-running service).

**Retired**: `ui-playground` / `hope-ui`. Delete `base/ui.yaml`, the dead prod-overlay override, the Image Updater `ui` alias, and the live Deployment/Service.

---

## F10. Vault `bound_claims` — the boundary is broken in three ways

Current role definition (`.gitlab/ci/vault.yml:88-90`):

```json
"bound_claims_type": "glob",
"bound_claims": { "project_path": "arca/hope-v2",
                  "ref": ["staging", "dev", "v*"] }
```

Against the real branch names (`.gitlab-ci.yml:66-74` matches `^dev-`, `^staging-`, `^prod-`):

| Problem | Effect |
|---|---|
| `"staging"` is a **literal** — the glob matcher only expands `*` | Does **not** match `staging-2.1`. The staging deploy job cannot authenticate |
| `"dev"` is a literal | Does **not** match `dev-2.1`. Same |
| **`prod-*` is absent entirely** | A production deploy job could never obtain credentials — the deploy path is unauthorized before it is even written |

A fourth, subtler issue: `ref` alone does not distinguish a **branch** from a **tag**, and does not assert the ref is protected. A tag named `dev-abc1234` would satisfy a `dev-*` glob.

### Recommended fix — split the role per environment

One shared deploy role means a staging pipeline can mint credentials that write the prod overlay. Least privilege says three roles:

```json
// hope-ci-deploy-staging
{ "role_type": "jwt", "user_claim": "user_email",
  "bound_audiences": ["https://vault.hope.arcaai.com"],
  "bound_claims_type": "glob",
  "bound_claims": {
    "project_path":  "arca/hope-v2",
    "ref_type":      "branch",
    "ref_protected": "true",
    "ref":           "staging-*"
  },
  "token_policies": ["hope-ci-deploy-staging"],
  "token_ttl": "10m", "token_max_ttl": "20m", "token_num_uses": 20 }
```

```json
// hope-ci-deploy-prod  — tag-triggered, see F11
{ ...same shape...,
  "bound_claims": {
    "project_path":  "arca/hope-v2",
    "ref_type":      "tag",
    "ref_protected": "true",
    "ref":           "v*"
  },
  "token_policies": ["hope-ci-deploy-prod"] }
```

Three properties this buys:

1. **`ref_protected: "true"` is the real boundary.** Even if someone pushes a branch literally named `staging-evil`, an unprotected ref yields a Vault auth *denial* — not merely a UI-level block. This is what makes the glob safe.
2. **`ref_type` prevents tag/branch confusion.**
3. **Separate policies** mean a staging pipeline physically cannot write the prod overlay, which is the whole point of scoping.

⚠️ **Prerequisite, and it is not optional**: `staging-*` and `prod-*` must actually be **protected branch patterns** in GitLab, and `v*` a **protected tag**. The file's own open item records that as of 2026-07-26 only `main` and `release` are protected — so `ref_protected` would deny everything today. **Protect the refs first, then tighten the claims**, or you break CI.

---

## F11. Production trigger — recommendation: protected `vX.Y.Z` tags

### Current state: both candidates are broken

| Candidate | State |
|---|---|
| `^v\d+` tag → `PIPELINE_TYPE: tag_release` (`.gitlab-ci.yml:45-47`) | Creates a pipeline that **builds nothing** — every build job's tag rule matches `^(API\|SMR\|…)-` or `^ALL-`, never `^v` |
| `^prod-` branch → `PIPELINE_TYPE: prod` (`:72-74`) | Builds **every image**, then stops — no deploy job exists |

So today the platform rebuilds all images on a prod branch push and ships none of them.

### Recommendation

**Use a protected, annotated `vX.Y.Z` tag as the production trigger.** Four reasons:

1. **Immutability.** A branch is mutable and force-pushable; a tag is a point-in-time marker. Production should be triggered by something that cannot be rewritten after the fact.
2. **It is the auditable release identity.** During an incident you say "we're on `v2.1.4`" — not "we're on whatever `prod-2.1` pointed at on Tuesday." For a PHI platform that traceability matters.
3. **Protected tags are enforceable in GitLab CE.** Protect `v*` with create-permission limited to Maintainers. That is a genuine gate, not a convention — and it is one of the few real controls CE gives you (F4).
4. **Semver carries human intent** about compatibility, which matters given migrations are forward-only.

**Crucially, under digest promotion the tag pipeline should build nothing** — which means the existing `tag_release` type is already *correct*, it just has no job attached. The tag points at a commit whose image was built once on `dev-X.Y` and validated in staging. `promote-prod` copies that exact digest.

```
dev-2.1 push        → build ONCE → sha-<sha8> (immutable) + dev-<sha8>
                      promote-dev (auto) → overlays/dev
MR → staging-2.1    → promote-staging (auto) → copies digest → overlays/staging
                      soak + PostSync smoke + QA sign-off
git tag -a v2.1.4   → tag_release pipeline: NO build
  (protected, Maintainer-only, on the validated staging commit)
                    → promote-prod (when: manual) → copies the SAME digest
                    → commits digest-pinned overlays/prod
                    → Argo shows OutOfSync → human clicks Sync   ← 2nd gate
```

**Required changes:**

| # | Change |
|---|---|
| 1 | Protect the tag pattern `v*` — create restricted to Maintainers |
| 2 | Protect the branch patterns `dev-*`, `staging-*`, `prod-*` (also unblocks F10) |
| 3 | Add `promote-prod` to `deploy.yml`, `rules: - if: $PIPELINE_TYPE == "tag_release"` with `when: manual` and `environment: production` |
| 4 | **Stop `prod-*` branches from building.** Remove `prod` from `.build-common-rules` (`build.yml:22`) — under digest promotion a prod-branch rebuild is exactly the anti-pattern of F3. Keep `prod-*` as a release-line branch for cherry-picks if useful, but it must not build or deploy |
| 5 | Vault role `hope-ci-deploy-prod` bound to `ref_type: tag`, `ref: "v*"`, `ref_protected: "true"` (F10) |
| 6 | Decide whether the tag must be **signed** (`git tag -s`). Recommended for a PHI platform — it makes the release marker attributable to a key, not just an account |

### Why not `prod-*` branches

Mutable, force-pushable, and they currently trigger a full rebuild — which breaks digest promotion and means the artifact reaching production was never the artifact that passed staging. If you prefer branches for workflow reasons, the minimum bar is: protect them, make them fast-forward-only, and strip their build rules so promotion stays a metadata operation.

---

## F12. GitLab project settings — queried live 2026-08-07

`GET /projects/6` and `GET /projects/6/protected_branches`. These are configuration facts no file in either repo records, and several are load-bearing.

| Setting | Value | Assessment |
|---|---|---|
| `protected_branches` | **`main`, `release` only** | Neither `dev-*`, `staging-*`, `prod-*` nor `production-*` is protected. The four-branch model has **zero enforcement** today, and `ref_protected` scoping (F10) would deny everything |
| `default_branch` | **`dev`** | The default branch is `dev` — and it is **not** in the protected list. Anyone with push access can push directly to the default branch |
| `only_allow_merge_if_pipeline_succeeds` | **`false`** | **An MR can be merged with a red pipeline.** Every "tests gate the merge" assumption in this design is currently false at the project level, independent of `allow_failure` on individual jobs |
| `only_allow_merge_if_all_discussions_are_resolved` | `false` | Unresolved review comments do not block merge |
| `restrict_user_defined_variables` | **`false`** | Combined with `ci_pipeline_variables_minimum_override_role: "developer"`, **any Developer can override CI variables when triggering a pipeline** — including `VAULT_ADDR`, `DEPLOY_REPO_URL`, or `SKIP_TESTS`. On unprotected deploy branches this is a real privilege path |
| `ci_id_token_sub_claim_components` | `["project_path","ref_type","ref"]` | ✅ Good — the JWT `sub` already carries `ref_type` and `ref`, so the per-environment Vault roles in F10 are directly supportable |
| `auto_devops_enabled` | `true` | Almost certainly inert (a committed `.gitlab-ci.yml` takes precedence), but it is config noise that should be turned off to avoid surprises |
| `container_expiration_policy` | **enabled** — `cadence: 7d`, `keep_n: 25`, `older_than: 90d`, `name_regex: ".*"` | ⚠️ **Corrects defect C-20 in the parent README, which claimed no cleanup policy exists.** One does. But `name_regex: ".*"` matches **every** tag with no `name_regex_keep` exclusion — so **release images older than 90 days will be deleted** once more than 25 tags exist. For a platform whose rollback story is "re-deploy the previous digest," that is a silent rollback-horizon of 90 days. Set `name_regex_keep` to protect `^(v\|prod-\|production-)` |

**Four project-level changes belong in TASK-629 alongside the branch protection work:**

1. Protect `dev-*`, `staging-*`, `prod-*`, `production-*` (and the `v*` tag pattern).
2. Set `only_allow_merge_if_pipeline_succeeds: true` — otherwise the promotion gates are decorative.
3. Set `restrict_user_defined_variables: true`, or raise `ci_pipeline_variables_minimum_override_role` to `maintainer`.
4. Add `name_regex_keep` to the cleanup policy so release images are never reaped.

---

## F13. Open questions

| # | Question | Status |
|---|---|---|
| 1 | Registry hostname: CI pushes to `10.10.1.110:5050`, manifests reference `registry.taphuynh.dev` | ✅ **Resolved** — the live `hope-api` pod runs `registry.taphuynh.dev/arca/hope-v2/api:dev-6fba22dc` and is `1/1 Running`, so the alias resolves and pulls work |
| 2 | `secrets.dev.yaml.example:49` names the pull secret `hope-registry-credsf`; every manifest references `hope-registry-creds` | **Open** — one-character fix, but anyone following the example verbatim gets `ImagePullBackOff` platform-wide (this is defect D-06) |
| 3 | Production trigger | ✅ **Resolved — see F11.** Protected `vX.Y.Z` tags; `prod-*` branches stop building |
| 4 | Vault `bound_claims` boundary | ✅ **Resolved — see F10.** Per-environment roles with `ref_type` + `ref_protected`; protect the refs FIRST or CI breaks |
| 5 | Should `compat-playground` be retired? | ✅ **Resolved 2026-08-07 — retained.** It is service #11 in the canonical list (F9) and must be added to the staging overlay's `images:` block |
