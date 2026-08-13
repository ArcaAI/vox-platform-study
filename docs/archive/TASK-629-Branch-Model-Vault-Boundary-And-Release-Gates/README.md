# TASK-629 — Branch Model, Vault CI Boundary & Release Gates

**Status**: Closed
**Classification**: Infrastructure
**Date**: 2026-08-07
**Parent**: `docs/implementation/TASK-616-Deployment-CICD-Observability-Modernization/component-design-cicd-promotion.md` §F4 (CE approval model), §F10 (Vault `bound_claims` boundary), §F11 (production trigger). This ticket operationalizes those three sections into a concrete, applied ref/environment/credential model — it does not repeat their analysis, only their conclusions where load-bearing.

---

## 1. Requirement Analysis

The owner has decided the branch **naming** model: four branch patterns, one per environment, wildcarded on version —

```
dev-*          staging-*          prod-*          production-*
```

This is an *authoritative* decision on shape (four patterns → four environment identities), not yet a decision on *mechanism* (whether a branch push itself triggers a production deploy, as it does today for `staging-*`, or whether — per the parent doc's §F11 recommendation — production is triggered by a separate protected `vX.Y.Z` tag cut from a `prod-*`/`production-*` line). Scope item 5 below exists precisely to reconcile those two designs rather than assume one.

**⚠️ Flagged per the owner's explicit instruction**: `prod-*` and `production-*` are two different glob patterns, and neither GitLab, Vault, nor Argo will ever treat them as synonyms automatically. Concretely: the regex GitLab CI already uses for the third pattern, `/^prod-/` (`.gitlab-ci.yml:72`), does **not** match `production-2.1` — position 5 of `production-2.1` is `u`, not `-`, so the anchored literal `prod-` never lines up. The same is true of Vault's glob matcher (`*` only, no character classes) and of a GitLab protected-branch wildcard `prod-*` (GitLab wildcard protection is a literal-prefix + `*` match, not a regex — `production-2.1` does not start with `prod-` either). **Every system that gates on a ref must therefore carry two explicit entries, never one pattern assumed to cover both.** This ticket's matrix (§3) and every config sample in it does exactly that — nowhere does a single `prod*` or `prod-*` glob stand in for both.

This ticket does **not** re-decide anything the parent doc already resolved (F9's 11-service list, F3's digest-promotion mechanism, F7's rollback model) — it consumes them as fixed inputs to the ref/environment/credential design.

**Scope** (verbatim from the assignment, restated for traceability):

1. The complete ref → environment → credential matrix.
2. Fix the Vault boundary: per-environment roles, `ref_protected` as the real gate, protect-before-tighten sequencing.
3. Protected-branch/tag configuration — exact patterns, who may push/merge/create, and CE's honest limits.
4. Release gates per environment, tied to digest promotion.
5. Production trigger — reconcile the owner's four-branch model with §F11's tag recommendation.
6. Migration runbook from today's state to the target state without an intermediate broken state.
7. Verification that the boundary actually holds (a denial, not a UI failure).

---

## 2. Current State Evaluation

All of the following was re-verified against the live GitLab instance and the checked-out tree on 2026-08-07, not assumed from the parent doc.

### 2.1 GitLab: only two branches are protected, live-confirmed today

`mcp__gitlab__list_protected_branches` against project `arca/hope-v2` (id `6`) returns exactly:

```json
[
  {"name": "main",    "push_access_levels": [{"access_level": 40}], "merge_access_levels": [{"access_level": 40}], "allow_force_push": false},
  {"name": "release", "push_access_levels": [{"access_level": 40}], "merge_access_levels": [{"access_level": 40}], "allow_force_push": false}
]
```

No `dev-*`, `staging-*`, `prod-*`, or `production-*` pattern exists. This matches — and refreshes, twelve days later — the finding already on record at `.gitlab/ci/vault.yml:105-109` and `docs/operations/vault/README.md:307-312`. `mcp__gitlab__get_project` for the same project additionally confirms:

- `"default_branch": "dev"` (not `main` — matches this session's own git status banner).
- `"ci_id_token_sub_claim_components": ["project_path","ref_type","ref"]`, matching the ordering already assumed at `.gitlab/ci/vault.yml:123-126`.
- **`"only_allow_merge_if_pipeline_succeeds": false`** — a red pipeline does not block a merge into any branch today, including `staging-*`/`prod-*`/`production-*`. This is a direct gap against scope item 4 (release gates) and is carried into §5.
- No Protected Environments, no per-rule multi-approval, no merge trains — GitLab CE 18.8.6 genuinely lacks these (Premium/Ultimate only), matching §F4 of the parent doc.

### 2.2 `production-*` is a silent no-op today — not merely unprotected, functionally inert

Tracing the actual pipeline logic (not assumption) for a push to a branch named e.g. `production-2.1`:

1. `.gitlab-ci.yml:32-89` — the `workflow.rules` block matches, in order: `RUN_NOTIFY_ONLY`, release tags, `^v\d+` tags, `merge_request_event`, `cicd`, `dev-2.1` (literal), `^dev-`, `^staging-`, `^prod-`, `release-sdk`, `release-playground`, `^maintenance/`, the default branch, then a catch-all `if: $CI_COMMIT_BRANCH` → `PIPELINE_TYPE: "feature"`. **There is no `/^production-/` rule.** `production-2.1` falls through every named rule (it does not match `^prod-` per §1) and lands on the catch-all: `PIPELINE_TYPE: "feature"`.
2. Under `PIPELINE_TYPE: feature`, `.build-common-rules` (`.gitlab/ci/build.yml:18-22`) explicitly sets `when: never` for `feature`. **No image builds.**
3. `.gitlab/ci/templates.yml:135-146`'s `case "${CI_COMMIT_BRANCH:-}"` tag-computation block is dead code for this ref anyway (step 2 already skipped the job), but for completeness: it has cases for `prod-*`, `staging-*`, `dev-*`, `cicd`, `release-playground`, and a generic fallback — no `production-*` case, so if it ever *did* run it would fall to the generic branch-slug tag (`production-2-1-<sha8>`), not a `production-<sha8>` tag parallel to the other three environments.
4. `.rules-*` change-filtered test rules (`.gitlab/ci/rules.yml`) run only on changed paths under `PIPELINE_TYPE: feature`, not the unconditional full suite `dev` gets.
5. No deploy job exists for `prod` or `production` `PIPELINE_TYPE` at all — `.gitlab/ci/deploy.yml` defines exactly two jobs, `deploy-staging` and `smoke-pgbouncer-staging`, both gated on `staging`. `sync-argocd` also gates on `PIPELINE_TYPE == "staging"`.

**Net**: today, `production-*` is not merely "missing protection" — a push to it builds nothing, deploys nothing, and runs a reduced test set. `prod-*` fares little better: it builds *every* image (`PIPELINE_TYPE: prod` is included in `.build-common-rules`) via `.gitlab/ci/rules.yml:37`'s `.rules-always` (forces the full test suite first, correctly), but **no deploy job consumes those images** — matching parent-doc §F11's "the platform rebuilds all images on a prod branch push and ships none of them."

### 2.3 Vault: the deploy role's `bound_claims` matches none of the four branch patterns

Live role definition, `.gitlab/ci/vault.yml:84-93` (mirrored at `docs/operations/vault/README.md:264-272`):

```json
{ "role_type": "jwt", "user_claim": "user_email",
  "bound_audiences": ["https://vault.hope.arcaai.com"],
  "bound_claims_type": "glob",
  "bound_claims": { "project_path": "arca/hope-v2",
                    "ref": ["staging", "dev", "v*"] },
  "token_policies": ["hope-ci-deploy"],
  "token_ttl": "10m", "token_max_ttl": "20m", "token_num_uses": 20 }
```

`bound_claims_type: "glob"` only expands `*`; `"staging"` and `"dev"` are compared as literal strings. Neither matches the actual branch names `staging-2.1` / `dev-2.1`. `prod-*` and `production-*` are absent from the claim entirely — a production deploy job, if one existed, could never obtain credentials under this role. This is `.gitlab/ci/vault.yml:190-208`'s finding (§F10 of the parent doc), reconfirmed by direct read on 2026-08-07 — the file has not changed since.

Also true today and unaffected by anything in this ticket: `deploy-staging` (`.gitlab/ci/deploy.yml:39-51`) is the only job that authenticates to Vault with `VAULT_AUTH_ROLE: "hope-ci-deploy"`; `sync-argocd` and `smoke-pgbouncer-staging` share the same single deploy role — there is no per-environment split at all, so today one role covers a security boundary that does not yet exist operationally either (there is nothing deploying to prod to protect from staging).

### 2.4 Argo CD Applications live in a separate, un-audited repo

Per `deployment/README.md:1-21` (re-confirmed present and unchanged), the Kustomize/Argo tree that used to live at `deployment/k3s/**` and `deployment/argocd/bootstrap.*.yaml` was deleted 2026-07-24 in commit `1de5b8c1` (24 files, −2622 lines) for carrying stale service names, `latest` tags, and materialized-`Secret` credential delivery — all of which this monorepo's own rules (`.claude/rules/09-infrastructure-devops.md`) now forbid. **The live cluster path is the separate `hope-deployments` repository**, which `.gitlab/ci/deploy.yml`'s `deploy-staging` job writes into via `DEPLOY_TOKEN`. That repo has no CI of its own (parent doc §F0) — this is exactly why a leaked credential there went undetected for a live secret, and why any Argo Application definitions this ticket's matrix references (§3, `hope-v2-dev`/`hope-v2-staging`/`hope-v2-prod`) are **design targets carried over from parent-doc §F5/§F8, not files this ticket can re-cite by line number** — they do not exist in this repository. Follow-up work that materializes those Applications belongs to a `hope-deployments`-side ticket; this ticket's job is to make the **GitLab-side and Vault-side** ref boundary correct so that whichever CI job eventually writes into that repo is the only one that legitimately can.

### 2.5 Summary of verified gaps against the owner's four-pattern model

| Pattern | Protected today? | `PIPELINE_TYPE` today | Builds? | Deploys? | Vault role matches? |
|---|---|---|---|---|---|
| `dev-*` | No | `dev` (correct) | Yes, all 11+1 images | No deploy job exists | No (`ref: "dev"` literal ≠ `dev-2.1`) |
| `staging-*` | No | `staging` (correct) | Yes | Yes — `deploy-staging` writes Helm values into `hope-deployments`, but the *service list it updates* (`.gitlab/ci/deploy.yml:75`) is `api nlp smr guardrail stt-ml-runtime stt-worker database compat-playground` — 8 of the 11 canonical services (§F9); `harness`, `tts`, `admin-console` are silently unwritten | No (`ref: "staging"` literal ≠ `staging-2.1`) |
| `prod-*` | No | `prod` | Yes — every image, unconditionally | **No deploy job exists at all** | No claim entry |
| `production-*` | No | `feature` (falls through — §2.2) | No | No | No claim entry |
| `v*` tag | No (no protected-tag config exists) | `tag_release` | No build job's tag rule matches `^v` (parent doc §F11) | No | Matches glob `v*`, but `ref_type`/`ref_protected` are not asserted, so a *branch* literally named `v1` would also match |

---

## 3. The ref/environment/credential matrix

This is the target state this ticket designs to. One row per ref pattern; every column is either a concrete config value or an explicit "N/A — see note."

| Ref | `ref_type` | `PIPELINE_TYPE` | Target environment | Argo Application (`hope-deployments`) | Auto-sync | Vault role | Vault policy | GitLab protected pattern | Push/merge | Create (tags) |
|---|---|---|---|---|---|---|---|---|---|---|
| `dev-*` | branch | `dev` | dev | `hope-v2-dev` | auto + prune + selfHeal (parent §F5) | `hope-ci-deploy-dev` | `hope-ci-deploy-dev` | `dev-*` | Developer (access level `30`) | — |
| `staging-*` | branch | `staging` | staging | `hope-v2-staging` | auto + prune + selfHeal, alerted (§F5) | `hope-ci-deploy-staging` | `hope-ci-deploy-staging` | `staging-*` | Maintainer (`40`) + ≥1 MR approval | — |
| `prod-*` | branch | `prod` (build+test only — **no deploy job**, per §5 recommendation) | *release line, not an environment* | none directly | N/A | none — this branch never authenticates to a deploy-scoped Vault role | — | `prod-*` | Maintainer (`40`) | — |
| `production-*` | branch | *(new)* `production` — same treatment as `prod-*`: build+test only, no deploy job, until §5's open question resolves | *release line, not an environment, pending §Open-Questions-1* | none directly | N/A | none | — | `production-*` | Maintainer (`40`) | — |
| `v*` (annotated, recommended signed) | tag | `tag_release` (builds **nothing** — parent §F11) | production | `hope-v2-prod` | **manual only** (§F5 — no `selfHeal`, no auto) | `hope-ci-deploy-prod` | `hope-ci-deploy-prod` | `v*` (protected tag) | N/A | Maintainer (`40`) |
| `main` | branch | `main` | none (validate/test only, no builds) | — | — | none (read-only `hope-ci` role only, if any Vault call is needed) | `hope-ci` | `main` (already protected, `40`/`40`) | Maintainer (already live, §2.1) | — |
| `release` | branch | n/a in current workflow rules | none | — | — | none | — | `release` (already protected, `40`/`40`) | Maintainer (already live) | — |

**Why `prod-*`/`production-*` carry no deploy role in the recommended design**: this is the reconciliation from §5. Production is triggered by the tag, not the branch push, so the branch itself never needs deploy-scoped Vault credentials — it only needs the same read-only `hope-ci` role every other branch gets for tests (`.gitlab/ci/vault.yml:73-81`), which is already correctly scoped to "any ref of this project" and requires no change.

**If the answer to Open Question 1 turns out to be "these are two genuinely different environments"**, add a `hope-ci-deploy-production` row with its own `token_policies` and its own `hope-v2-production` Argo Application — the shape of every other row in this table (branch pattern → dedicated role → dedicated policy → dedicated Application) already generalizes to a fifth environment without redesign. What does **not** generalize safely is silently reusing `hope-ci-deploy-prod` for both — see §5.

---

## 4. Fix the Vault boundary

### 4.1 Why `ref_protected` — not the glob — is the actual boundary

A glob on `ref` alone is a *routing* mechanism, not a *privilege* boundary: anyone who can push a branch can name it `staging-evil` and satisfy `"ref": "staging-*"`. `ref_protected` is a claim GitLab's OIDC issuer asserts server-side from its own protected-branch/tag configuration — a pipeline cannot forge it by naming a branch cleverly, because GitLab only sets the claim `true` for refs it has independently marked protected (`.gitlab/ci/vault.yml:113-115`, confirmed unchanged). Setting `VAULT_AUTH_ROLE` by hand in a pipeline does not help an attacker either: Vault re-validates the claims embedded in the presented ID token against the role's `bound_claims`, not the requested role name.

This is also why the glob is still worth keeping alongside `ref_protected`, not replaced by it: `ref_protected: "true"` alone would let *any* protected branch (including `main`) authenticate as `hope-ci-deploy-dev` if the glob were dropped. The two claims are complementary — `ref_protected` proves the ref cannot be freely created by an attacker, and the glob proves it is the *specific* ref that role is meant to serve.

### 4.2 The four per-environment roles (real JSON, ready to `vault write ... - <<'EOF'`)

Following `.gitlab/ci/vault.yml:95-103`'s two documented syntax traps — `bound_claims` must be JSON on stdin, never a CLI string, and there is no brace-alternation, only JSON arrays — every role below is written the same way the existing `hope-ci`/`hope-ci-deploy` roles are.

```bash
# ── dev ──────────────────────────────────────────────────────────────────────
vault policy write hope-ci-deploy-dev infrastructure/docker/configs/vault/policies/hope-ci-deploy-dev.hcl
vault write auth/jwt-gitlab/role/hope-ci-deploy-dev - <<'EOF'
{ "role_type": "jwt", "user_claim": "user_email",
  "bound_audiences": ["https://vault.hope.arcaai.com"],
  "bound_claims_type": "glob",
  "bound_claims": {
    "project_path":  "arca/hope-v2",
    "ref_type":      "branch",
    "ref_protected": "true",
    "ref":           "dev-*"
  },
  "token_policies": ["hope-ci-deploy-dev"],
  "token_ttl": "10m", "token_max_ttl": "20m", "token_num_uses": 20 }
EOF

# ── staging ──────────────────────────────────────────────────────────────────
vault policy write hope-ci-deploy-staging infrastructure/docker/configs/vault/policies/hope-ci-deploy-staging.hcl
vault write auth/jwt-gitlab/role/hope-ci-deploy-staging - <<'EOF'
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
EOF

# ── production (tag-triggered — see §5 for why this is a tag, not "prod-*"/"production-*") ──
vault policy write hope-ci-deploy-prod infrastructure/docker/configs/vault/policies/hope-ci-deploy-prod.hcl
vault write auth/jwt-gitlab/role/hope-ci-deploy-prod - <<'EOF'
{ "role_type": "jwt", "user_claim": "user_email",
  "bound_audiences": ["https://vault.hope.arcaai.com"],
  "bound_claims_type": "glob",
  "bound_claims": {
    "project_path":  "arca/hope-v2",
    "ref_type":      "tag",
    "ref_protected": "true",
    "ref":           "v*"
  },
  "token_policies": ["hope-ci-deploy-prod"],
  "token_ttl": "10m", "token_max_ttl": "20m", "token_num_uses": 20 }
EOF
```

`hope-ci` (the existing read-only, any-ref role at `.gitlab/ci/vault.yml:74-81`) is unchanged — every branch, including `prod-*`/`production-*`, keeps using it for test credentials.

**Contingency role — only if Open Question 1 resolves to "both patterns must independently deploy"**: replace the single-string `"ref": "v*"` shape with an array the same way `.gitlab/ci/vault.yml:100-103`'s own comment describes ("`bound_claims` matches if ANY element matches"), rather than trying to write one glob that covers both spellings (§1 — no such glob exists):

```json
"ref": ["prod-*", "production-*"]
```

Do **not** ship this contingency speculatively — §5 recommends the tag-triggered design specifically so this branch-level role is never needed. It is documented here only so that if the open question forces a branch-triggered design, the fix is "swap one array," not "redesign the boundary."

### 4.3 Sequencing constraint (restated from `.gitlab/ci/vault.yml:111-119`, still true)

`ref_protected` is asserted by GitLab from its *live* protected-branch/tag table. If the claims above are written before `dev-*`/`staging-*`/`v*` are actually protected in GitLab, **every deploy job starts failing Vault auth immediately** — `ref_protected` would be `false` for all of them and the role would deny every login. This is why §6 (migration runbook) protects the refs first and only then tightens the roles — never the reverse.

---

## 5. Protected-branch/tag configuration

### 5.1 What GitLab CE can and cannot enforce (honest accounting, per parent §F4)

| Mechanism | CE? | What it actually buys here |
|---|---|---|
| Protected branches with wildcards, per-pattern push/merge access level | **Yes** | The only real "who may even run this pipeline" gate CE has |
| Protected tags with `create_access_level` | **Yes** | Same, for the tag-triggered production path |
| Require ≥1 MR approval before merge (single global rule) | **Yes, Free-tier** | Real, but it is one count for the whole project — no per-branch approver list |
| `only_allow_merge_if_pipeline_succeeds` (project setting) | **Yes** | **Currently `false`** (confirmed live, §2.1) — a failing pipeline does not block merge into any branch today, including `staging-*`. This is a release-gate gap independent of Vault/branch protection and should be flipped `true` as part of this ticket |
| `when: manual` restricted to push/merge-capable users on a protected ref | **Yes** | The real mechanism behind "manual approval," per §F4 point 3 |
| Protected Environments (deployment-tier approval, required-reviewers) | **No — Premium** | Cannot be used; do not design around it |
| Per-branch/per-rule multi-approver, Code Owners | **No — Premium** | Same |
| Merge trains | **No — Premium** | Same |

### 5.2 Protected-branch payloads (GitLab REST, real JSON — access levels: `30` = Developer, `40` = Maintainer)

```json
// POST /projects/6/protected_branches
{ "name": "dev-*",        "push_access_level": 30, "merge_access_level": 30, "allow_force_push": false }
{ "name": "staging-*",    "push_access_level": 40, "merge_access_level": 40, "allow_force_push": false }
{ "name": "prod-*",       "push_access_level": 40, "merge_access_level": 40, "allow_force_push": false }
{ "name": "production-*", "push_access_level": 40, "merge_access_level": 40, "allow_force_push": false }
```

`dev-*` is Developer-level because it is the integration branch every feature branch merges toward under normal flow (`.gitlab-ci.yml:14-16`'s own header comment calls `dev` "integration branch") — Maintainer-only here would make dev-line work a bottleneck for no security benefit, since `dev-*` never gets a deploy-Vault credential capable of writing staging/prod (§3). `staging-*`/`prod-*`/`production-*` are Maintainer-only per §F4's reasoning: these are the branches whose Vault roles (existing `staging`, proposed `prod`/`production`) can reach environments real users depend on.

### 5.3 Protected-tag payload

```json
// POST /projects/6/protected_tags
{ "name": "v*", "create_access_level": 40 }
```

### 5.4 The MR-approval and merge-gate settings this ticket should also flip

```json
// PUT /projects/6
{
  "only_allow_merge_if_pipeline_succeeds": true,
  "approvals_before_merge": 1
}
```

Both are Free-tier project settings (confirmed by the live `get_project` payload showing the field exists and is currently `false`/unset) — not gated on Premium. `only_allow_merge_if_pipeline_succeeds: true` is the mechanical enforcement behind "a build/release is only cut from a green commit," which today is only a comment in `.gitlab/ci/rules.yml:34-35`, not an enforced rule.

---

## 6. Release gates per environment

Tied to the digest-promotion model already decided in parent §F3: **build once on `dev-*`; every later environment receives a `docker buildx imagetools create` / `crane copy` of the exact `sha-<sha8>` digest, never a rebuild.**

| Environment | Gate to enter | Enforced by |
|---|---|---|
| **dev** | Push to a protected `dev-*` branch; full test suite (`.rules-always` + `PIPELINE_TYPE == dev` unconditional run, `.gitlab/ci/rules.yml:65`); build succeeds; scan stage passes | `.build-common-rules`, existing `test-*`/`scan-*` jobs, now behind `dev-*` protection (§5.2) |
| **staging** | MR from `dev-*` into a protected `staging-*` branch; ≥1 approval (§5.4); `only_allow_merge_if_pipeline_succeeds: true` (§5.4) so the MR's own pipeline must be green; `promote-staging` copies the `dev`-built digest — no rebuild (parent §F3) | Protected branch + MR approval count + pipeline-must-succeed setting, all Free-tier |
| **production** | Soak + PostSync smoke green on staging (parent §F6); MR into `prod-*`/`production-*` (Maintainer-only, ≥1 approval) accumulates the release line; **an annotated (recommended: signed) `vX.Y.Z` tag, protected, Maintainer-create-only**, cut from that line's validated commit; `promote-prod` (`when: manual`) copies the *same* digest validated in staging; Argo `hope-v2-prod` shows `OutOfSync`; a human clicks Sync | Protected tag (§5.3) + Vault `hope-ci-deploy-prod` role scoped to `ref_type: tag` (§4.2) + manual Argo sync (parent §F5: prod stays `automated: {}`-off) |

Two human, Maintainer-role, audited actions are required to reach production under this design: (1) creating the protected `v*` tag, (2) clicking Sync on a manual Argo Application — matching parent §F4's "closest CE equivalent to a protected-environment approval record," now concretely wired to the four-branch naming model instead of left abstract.

**What must NOT happen, restated from parent §F3/§F11 because it directly threatens the digest-promotion guarantee**: `prod-*`/`production-*` branches must not trigger a fresh `docker buildx build`. `.build-common-rules` (`.gitlab/ci/build.yml:18-22`) currently includes `PIPELINE_TYPE == "prod"` in its build-triggering condition — this must be removed (§7 runbook step). If it is not, a `prod-*` push and the eventual `v*` tag can produce two different images from the same source commit (parent §F3's "worked in staging, broke in prod" failure class), defeating the entire point of promoting a digest.

---

## 7. Implementation Plan

Phased so that GitLab-side protection always lands before the Vault claim that depends on it (§4.3), and so no phase leaves CI in a state where a previously-working job starts failing. Agent tier notation: `haiku-4-5` (mechanical, low-risk edits) / `sonnet-5` (standard implementation) / `sonnet-5|opus-4-8` (needs judgment, escalate if blocked) / `opus-5|fable-5` (design-sensitive, security-boundary, or ambiguous-requirement work).

| # | Task | Files | Agent tier |
|---|---|---|---|
| 1 | Protect `dev-*` (Developer `30`/`30`), `staging-*` (Maintainer `40`/`40`), `prod-*` (`40`/`40`), `production-*` (`40`/`40`) via GitLab API/UI. Protect tag `v*` (create `40`). **No code change** — this is a GitLab project-settings operation, done first per §4.3/§9 | GitLab project settings only | `haiku-4-5` |
| 2 | Flip `only_allow_merge_if_pipeline_succeeds: true`, set `approvals_before_merge: 1` | GitLab project settings only | `haiku-4-5` |
| 3 | Add `production` as a first-class `PIPELINE_TYPE` alongside `prod`: new `workflow.rules` entry `if: $CI_COMMIT_BRANCH =~ /^production-/` → `PIPELINE_TYPE: "production"`, inserted **before** the generic catch-all and immediately after the existing `^prod-` rule (mirrors §2.2's diagnosis exactly) | `.gitlab-ci.yml:66-89` | `sonnet-5` |
| 4 | Remove `prod`/`production` from `.build-common-rules`'s build-triggering condition (§6 "what must NOT happen") — `prod-*`/`production-*` become build+test-only release lines, matching §3/§5 | `.gitlab/ci/build.yml:18-22` | `sonnet-5` |
| 5 | Add `production` to every `.rules-*` template's existing `staging" \|\| ... == "main"` change-filtered clauses in `.gitlab/ci/rules.yml` so `production-*` pushes get the same change-filtered test coverage `staging`/`prod` already have (today it silently gets none — §2.2 finding #4) | `.gitlab/ci/rules.yml` (every `.rules-*` block) | `sonnet-5` |
| 6 | Add a `production-*` case to the tag-computation `case` block in `templates.yml` for symmetry with `prod-*`/`staging-*`/`dev-*`, even though no build job will invoke it post-step-4 — keeps the file honest for anyone re-enabling a build later | `.gitlab/ci/templates.yml:135-146` | `haiku-4-5` |
| 7 | Write the three new Vault policies (`hope-ci-deploy-dev.hcl`, `hope-ci-deploy-staging.hcl`, `hope-ci-deploy-prod.hcl`) and roles per §4.2. Retire the shared `hope-ci-deploy` role/policy once step 9 repoints every consumer | `infrastructure/docker/configs/vault/policies/*.hcl`, Vault write (operator action) | `sonnet-5|opus-4-8` |
| 8 | Add `promote-dev`, `promote-staging`, `promote-prod` CI jobs implementing digest promotion (parent §F3) — `promote-dev`/`promote-staging` automatic on `dev-*`/`staging-*`; `promote-prod` `when: manual`, `rules: - if: $PIPELINE_TYPE == "tag_release"`, `environment: production`. Each uses its environment's Vault role (`VAULT_AUTH_ROLE: "hope-ci-deploy-dev"` etc.) instead of the shared `hope-ci-deploy` | `.gitlab/ci/deploy.yml` (new jobs, alongside existing `deploy-staging`) | `sonnet-5|opus-4-8` |
| 9 | Repoint `deploy-staging`'s `VAULT_AUTH_ROLE` from `"hope-ci-deploy"` to `"hope-ci-deploy-staging"`; fix its service loop (`.gitlab/ci/deploy.yml:75`) to cover all 11 canonical services from parent §F9 (currently 8 — missing `harness`, `tts`, `admin-console`) | `.gitlab/ci/deploy.yml:39-97` | `sonnet-5` |
| 10 | Author the three Argo `Application` manifests (`hope-v2-dev`/`hope-v2-staging`/`hope-v2-prod`) in the `hope-deployments` repo per §3's sync-mode column and parent §F5/§F8's AppProject-per-environment recommendation. **Out of this repo's tree** — tracked here as a dependency, executed as a `hope-deployments`-side change | `hope-deployments` repo (external) | `sonnet-5|opus-4-8` |
| 11 | Resolve Open Question 1 (§9) with the owner; if the answer requires a fifth environment or a branch-triggered production path, apply the contingency role from §4.2 and add the corresponding matrix row | Depends on answer | `opus-5|fable-5` |
| 12 | Write/extend `docs/operations/vault/README.md` §"GitLab CI → Vault (OIDC)" to describe four roles instead of one, and remove its now-stale "⚠ Open item" once step 1 lands | `docs/operations/vault/README.md:230-325` | `haiku-4-5` |

---

## 8. Migration Runbook

Ordered so nothing is ever in a state where a **currently-working** job breaks. The load-bearing constraint (§4.3): protecting a ref and tightening the Vault claim that depends on it must never be reversed, and a Vault role must never be pointed at a policy stricter than what its current consumers need until those consumers are repointed.

1. **Protect refs first, change nothing else.** Execute §7 task 1 (protect `dev-*`, `staging-*`, `prod-*`, `production-*`, tag `v*`) and task 2 (merge-gate settings). At this point: `deploy-staging` still authenticates with the old shared `hope-ci-deploy` role, whose `bound_claims` (`ref: ["staging","dev","v*"]`, no `ref_protected`) is untouched — **still broken exactly as documented in §2.3, but no more broken than before.** Nothing regresses.
2. **Add the `production` `PIPELINE_TYPE` and its test/build-exclusion rules** (§7 tasks 3–6). `production-*` moves from "silently inert" (§2.2) to "protected, tested, not yet deployable" — strictly additive, no existing pipeline type's behavior changes.
3. **Write the three new Vault policies and roles (§7 task 7), additively.** The old `hope-ci-deploy` role and policy are left in place, untouched, still serving `deploy-staging`/`sync-argocd`/`smoke-pgbouncer-staging` exactly as today. Two roles now coexist; nothing yet consumes the new ones.
4. **Verify the new roles independently before any job depends on them** — run §9's denial/success probes (below) against `hope-ci-deploy-dev`/`-staging`/`-prod` using a manually-obtained ID token from a real pipeline run on each protected branch, *before* wiring a job to use them.
5. **Repoint `deploy-staging` to `hope-ci-deploy-staging`** (§7 task 9) in the same MR that fixes its service list. This is the first point an existing job's behavior changes — verify the very next `staging-*` pipeline succeeds end-to-end (Vault login + all 11 services updated) before proceeding.
6. **Add `promote-dev`/`promote-prod` (§7 task 8)** using the already-verified `hope-ci-deploy-dev`/`hope-ci-deploy-prod` roles. `promote-prod` ships `when: manual` and gated on `tag_release` from day one — it cannot fire accidentally during this rollout because no `v*` tag has been cut yet.
7. **Retire the shared `hope-ci-deploy` role and policy** only after step 5 confirms nothing references it (`grep -rn 'hope-ci-deploy"' .gitlab/`  should return only the new per-environment names).
8. **Cut a `v2.x.y` tag on the validated staging commit for the first tag-triggered production run.** This is the first time `hope-ci-deploy-prod`'s `ref_type: tag` claim is exercised by a real pipeline — treat it as a dry run with `promote-prod` still `when: manual` and a human watching the Argo sync.
9. **Update `docs/operations/vault/README.md`** (§7 task 12) to close out the "⚠ Open item" now that it no longer describes the live state.

At every step above, the *previous* step's jobs keep working with their *previous* credentials — the cutover per job happens exactly once, atomically, in the same commit that repoints its `VAULT_AUTH_ROLE`.

---

## 9. Verification Criteria

Per the assignment: prove the boundary holds with a **denial**, not a UI-level failure.

1. **Positive control** — from a pipeline running on a newly-protected `staging-*` branch, `vault-login.sh`'s Vault write against `auth/jwt-gitlab/login` with role `hope-ci-deploy-staging` returns `200` with a valid `client_token`; the deploy job proceeds.
2. **Negative control — unprotected ref denial.** Push a throwaway branch named `staging-should-fail` (matches the `staging-*` glob, deliberately **not** added to protected branches). Trigger a pipeline on it with `VAULT_AUTH_ROLE=hope-ci-deploy-staging` forced via `git push -o ci.variable`. Expected: Vault responds `400`/`403` (`permission denied` / `invalid role or claims`) at the login call itself — the job fails inside `vault-login.sh`, before any deploy logic runs. This is the concrete evidence that `ref_protected` is enforced, not merely documented.
3. **Negative control — cross-environment denial.** From a verified-protected `dev-*` pipeline, attempt to force `VAULT_AUTH_ROLE=hope-ci-deploy-staging` (or `-prod`). Expected: denial, because the presented ID token's `ref` claim is `dev-X.Y`, which does not satisfy the staging/prod role's `ref` glob — proves the per-environment split actually isolates credentials, not just labels them differently.
4. **Negative control — branch/tag confusion.** Attempt (in a disposable test project or via a dry-run token inspection) to authenticate as `hope-ci-deploy-prod` using a *branch* named `v1` rather than a tag. Expected: denial from the `ref_type: "tag"` claim, proving a same-named branch cannot impersonate the release-tag path.
5. **Merge gate.** Confirm via `mcp__gitlab__get_project` (or UI) that `only_allow_merge_if_pipeline_succeeds: true` and `approvals_before_merge: 1` are live, then confirm a deliberately failing MR pipeline blocks the Merge button.
6. **Digest integrity.** After a `promote-staging` and later `promote-prod` run for the same release, confirm (`docker buildx imagetools inspect` or `crane digest`) that the image digest running in dev, staging, and prod for that release is byte-identical — the direct test of §6's "no rebuild" gate.
7. **Full pipeline dry run** through the sequence in §8 step 8 on a real `v*` tag, with `promote-prod` executed manually and observed, before declaring this ticket done.

---

## 10. Open Questions

| # | Question | Why it matters | Status |
|---|---|---|---|
| 1 | What is the semantic difference between `prod-*` and `production-*`? Candidate readings: (a) two genuinely separate environments (e.g., a pre-release "prod-candidate" soak lane distinct from customer-facing "production"); (b) an in-progress rename where one will be retired; (c) both names accepted as aliases into the same single production environment, kept for workflow flexibility (e.g., long-lived release branch vs. per-version cut). §3/§4 default to treating both as protected release-line branches feeding the **same** `v*`-tag-triggered production path (reading (c)) because it is the only reading that requires no new environment, no new cluster namespace, and no new Argo Application — but this is an assumption, not a decision, and must be confirmed before §7 task 11 | Determines whether a fifth Vault role/Argo Application/environment is needed, or whether both branches converge on the single `hope-ci-deploy-prod` design in §4.2 | **Open — owner to answer** |
| 2 | Does the owner's "these branch patterns deploy to their matching environments" note mean `prod-*`/`production-*` pushes should themselves trigger a deploy (matching `dev-*`/`staging-*`'s behavior), overriding parent §F11's tag recommendation? §5/§6 recommend the tag-triggered design (reconciling with F11: immutability, auditability, and CE's protected-tag enforcement) and treat the branches as release lines only. If the owner intends literal branch-push-triggers-deploy for production too, §4.2's contingency array (`"ref": ["prod-*","production-*"]`) is the fallback shape, but it forfeits the immutability argument in parent §F11 point 1 | Directly changes whether §7 task 8's `promote-prod` job is tag-gated or branch-gated | **Open — recommend tag-triggered; owner to confirm or override** |
| 3 | Should the `v*` tag be **signed** (`git tag -s`), per parent §F11 point 6's recommendation for a PHI platform? This ticket's Vault role (§4.2) works identically either way — signature verification is a separate, additive control (e.g., a CI step that runs `git tag -v` before `promote-prod` proceeds) | Attributability of a release marker to a specific Maintainer's key, not just their GitLab account | **Open — parent doc recommends yes; not yet implemented** |
| 4 | Who should hold Developer-level push/merge on `dev-*` vs. requiring Maintainer, given `dev-*` is the integration branch every feature branch targets? §5.2 defaults to Developer (`30`) to avoid bottlenecking routine integration work, since `dev-*` carries no deploy-capable Vault credential either way | Affects team throughput vs. the (already low, since dev has no deploy privilege) risk surface | **Open — recommend Developer; owner to confirm** |

---

## 11. Change History

| Date | Change |
|---|---|
| 2026-08-07 | Ticket created. Requirement analysis, current-state verification (live GitLab API checks against project `arca/hope-v2` id `6`, plus static reads of `.gitlab-ci.yml`, `.gitlab/ci/{vault,rules,build,deploy,templates}.yml`, `docs/operations/vault/README.md`, `deployment/README.md`), the four/five-row ref/environment/credential matrix, Vault role JSON, protected-branch/tag payloads, release-gate table, phased implementation plan, migration runbook, verification criteria, and four open questions written. Status: Pending — no code or infrastructure changes applied yet. |
| 2026-08-12 | Closed — Vault HA and promote-* CI gating already delivered under TASK-616 Track V; remaining scope not being pursued separately. |
