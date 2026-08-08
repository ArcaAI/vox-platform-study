# TASK-621 — Supply Chain Integrity

**Status**: Pending (plan authored 2026-08-08, awaiting owner approval)
**Classification**: infrastructure
**Created**: 2026-08-08
**Parent**: [TASK-616 Phase 5](../TASK-616-Deployment-CICD-Observability-Modernization/README.md) · [Program index](../TASK-616-Deployment-CICD-Observability-Modernization/phase-program-index.md)
**Scope**: `hope-v2` (`.gitlab/ci/scan.yml`, `.gitlab/ci/test.yml`, `.gitlab/ci/build.yml`, `.gitlab-ci.yml`, `.gitleaks.toml`) · `arca/hope-v2-deployment` (Kyverno policy, registry cleanup policy — GitLab project setting) · the live `hope-v2` k3s cluster (`c-nfhxq`)
**Conventions**: [Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md)
**Evidence base**: `.gitlab/ci/scan.yml`, `.gitlab/ci/test.yml`, `.gitlab/ci/build.yml`, `.gitlab-ci.yml`, `.gitlab/ci/vault.yml`, `.gitleaks.toml` (all read 2026-08-08) · [SOTA research §A7, §A12](../TASK-616-Deployment-CICD-Observability-Modernization/sota-research-2026.md) · [TASK-619 F0-1](../TASK-619-GitOps-CICD-Delivery-Loop/README.md)

---

## 1. Requirement Analysis

TASK-616 Phase 5 was scoped as "supply chain integrity" — the security stack a pipeline runs
*after* code compiles: secret scanning, vulnerability scanning, image signing, SBOM generation,
and admission-time enforcement. A 2026-08-08 file-by-file read of every CI security job found that
none of this stack currently blocks anything. Three jobs exist and are neutralized by their own
configuration; the four jobs a 2026 baseline would add (cosign, SBOM, Kyverno, immutable tags) do
not exist at all.

> **The security stack is not degraded — it was never armed.** `scan-gitleaks` is commented out.
> Trivy cannot fail a pipeline under any input. Four of six Python test suites are `allow_failure`
> and their `build-*` jobs `needs:` them anyway, which GitLab treats as passed. Nothing here is a
> regression to fix; it is a gate to build for the first time.

Restated requirement, in the order the sequencing constraints (§5) force:

| Part | Restated requirement |
|---|---|
| **A — Make the existing jobs mean what their names say** | `scan-gitleaks` runs and blocks; Trivy blocks on CRITICAL; the four `allow_failure` Python suites either go green and lose the flag, or their red failure becomes a tracked, owner-assigned defect |
| **B — Close the coverage gap** | Every built image gets a `scan-*` job, not 5 of 12 |
| **C — Add the 2026 baseline this stack is missing entirely** | cosign keyless signing → CycloneDX SBOM attestation → Kyverno unsigned-image admission policy, in that dependency order |
| **D — Fix the registry cleanup policy inversion** | `name_regex_keep` so release digests survive the 90-day reap (shared with TASK-619 step C.11 — implement once, close both) |

**Classification**: `infrastructure`. Not a feature ticket — no user-visible capability is added.

### Explicitly out of scope

| Excluded | Owned by |
|---|---|
| `harness-eval-gate`'s `allow_failure: true` (`.gitlab/ci/test.yml:591-601`) | **Not a supply-chain defect.** It is diagnostic-only until a judge backend + clinician-rated golden set exist (see the job's own comment and `docs/implementation/TASK-508-Agentic-SOTA-Program/README.md`). Listed here only so nobody folds it into C-03's four suites — it is a different defect class entirely: an unbuilt capability, not a masked failure |
| GitLab CE → Ultimate upgrade (native SAST/DAST/Dependency/Container Scanning, immutable container tags) | Owner/licensing decision. This ticket builds the hand-rolled equivalent that CE forces (§ GitLab CE traps below) |
| Vault OIDC activation in CI (`VAULT_ADDR: ""` at `.gitlab-ci.yml:141`) | [TASK-629](../TASK-629-Branch-Model-Vault-Boundary-And-Release-Gates/README.md) — C-09 is cited here for context (masked CI vars are the fallback every job in this ticket still reads) but the activation itself is a Vault/branch-protection ticket, not a supply-chain one |
| Digest promotion, `restrict_user_defined_variables: false`, AppProject/ApplicationSet, `prune`/`selfHeal` | [TASK-619](../TASK-619-GitOps-CICD-Delivery-Loop/README.md) — this ticket's Kyverno policy assumes TASK-619's digest-pinning exists (see §5); it does not implement digest-pinning itself |
| k3s PSA `restricted`, default-deny NetworkPolicies, secrets-at-rest encryption | [TASK-618](../TASK-618-PHI-Security-Baseline/README.md) — Kyverno is introduced here scoped to ONE policy (image signature verification); PSA/NetworkPolicy Kyverno policies are 618's |
| Credential rotation for the two committed secrets (F0-1) | [TASK-619 F0-1](../TASK-619-GitOps-CICD-Delivery-Loop/README.md) — owner-executed; cited here only as the blocker for gitleaks full-history mode (§5) |
| GPU CI runner provisioning for `stt-ml-runtime`/`stt-worker` validation (C-18) | No CI runner with GPU passthrough exists; out of scope until one is provisioned. Recorded as an owner-blocked item (§4) so it is not silently dropped |

---

## 2. Current State Evaluation

### 2.1 Findings

| ID | Sev | Statement | Evidence |
|---|---|---|---|
| **C-01** | **Critical** | `scan-gitleaks` is entirely commented out — the whole job body, lines 134–176, is a `#`-prefixed block. The 291-line `.gitleaks.toml` ruleset (secret patterns, allowlisted historic rotations) exists and is read by nothing | `.gitlab/ci/scan.yml:132-176`; `.gitleaks.toml` (291 lines, `wc -l`) |
| **C-02** | **Critical** | Trivy cannot fail a pipeline under any configuration — triple-neutralized in the same template: `--exit-code 0` on the HIGH/CRITICAL scan (line 25), a second CRITICAL-only scan whose non-zero exit is swallowed by `\|\| echo "CRITICAL vulnerabilities found — review required"` (line 37), and `allow_failure: true` on the shared template (line 38) as a third, independent belt-and-suspenders neutralization | `.gitlab/ci/scan.yml:24-38` |
| **C-03** | **Critical** | 4 of 6 Python suites are `allow_failure: true`: `test-stt` (`test.yml:331`), `test-smr` (`:388`), `test-guardrail` (`:485`), `test-nlp` (`:780`). Their `build-*` jobs `needs:` them with `optional: true` (`build.yml`, e.g. `build-nlp` → `needs: [..., { job: test-nlp, optional: true }]`), and GitLab treats an `allow_failure` (or skipped/optional) job as satisfied for `needs:` purposes — a red test suite never blocks its image build. `test-harness` (`:540`) and `test-tts` (`:444`) are already blocking; `test-api`, `test-api-e2e`'s sibling TS suites are a separate lane, not part of this finding | `.gitlab/ci/test.yml:331,388,485,780`; `.gitlab/ci/build.yml` (`build-nlp`, `build-guardrail`, `build-smr` `needs:` blocks) |
| **C-09** | High | Vault OIDC in CI is fully built (`.gitlab/ci/vault.yml`, `.gitlab/ci/vault-login.sh`) but inactive — `VAULT_ADDR: ""` at `.gitlab-ci.yml:141`. Every job, including every job this ticket touches, falls back to long-lived masked CI variables. Cited for context only; activation is TASK-629's | `.gitlab-ci.yml:141` |
| **C-11** | High | Only 5 of 12 built images carry a `scan-*` job: `scan-api`, `scan-stt`, `scan-smr`, `scan-nlp`, `scan-compat-playground` (`.gitlab/ci/scan.yml:42-105`). **Unscanned: `guardrail` (the PII/safety engine) and `harness` (clinical documentation)**, plus `admin-console`, `tts`, `stt-worker`, `database`, `python-base` — 7 of 12 built images (`build.yml:80-319`) never see a Trivy scan of any kind | `.gitlab/ci/scan.yml:42-105` vs `.gitlab/ci/build.yml` (12 `build-*` jobs) |
| **C-18** | — | GPU images (`stt-ml-runtime` stage inside `apps/stt/docker/Dockerfile`, and `stt-worker`) are built with no GPU CI runner — the k8s-executor runner is commented out, and `apps/stt/docker/Dockerfile:25` itself states the CUDA path "must be validated on a GPU CI runner." Listed here because it bears on what a container scan of these two images can actually certify: Trivy scans layers, not runtime CUDA behavior, and no functional gate exists at all for the GPU path. Out of scope (§1) pending runner provisioning | `apps/stt/docker/Dockerfile:25`; `.gitlab-ci.yml` runner config |
| **C-20 / F12** | Medium | Registry `container_expiration_policy` (a GitLab project setting, `GET /projects/6`) is `cadence: 7d`, `keep_n: 25`, `older_than: 90d`, `name_regex: ".*"` with **no `name_regex_keep`** — every tag matches the reap regex, including release tags. Once `name_regex_keep` exempts release tags they also stop counting toward `keep_n` by design, so the fix does not need a matching `keep_n` bump. **Shared with [TASK-619](../TASK-619-GitOps-CICD-Delivery-Loop/README.md) step C.11 — implement once, close both tickets' copy of this finding** | `component-design-cicd-promotion.md:315` (TASK-616 Appendix F §F12), live `GET /projects/6` 2026-08-07 |
| **SC-01** (new) | High | Zero `cosign`, `SIGSTORE_ID_TOKEN`, `CycloneDX`, or `Kyverno` references anywhere in `.gitlab/ci/` (this repo) or the `arca/hope-v2-deployment` manifests (grep, both repos). No image HOPE builds is signed; nothing verifies a signature at admission; no SBOM is produced or attached. This is the entire A12 #3 leverage item (cosign + Kyverno) unimplemented, not partially implemented | grep across `.gitlab/ci/*.yml` and the deployment repo tree, 2026-08-08 |
| **SC-02** (new) | Medium | GitLab CE has no native SAST/DAST/Dependency Scanning/Container Scanning (Ultimate-only) — the hand-rolled `scan-*` + `scan-source` + (currently disabled) `scan-gitleaks` jobs in `.gitlab/ci/scan.yml` ARE the entire security-scanning stack for this project, with no managed fallback if a hand-rolled job is misconfigured (as C-01/C-02 currently are) | GitLab tier docs; `.gitlab/ci/scan.yml` (only Trivy + gitleaks jobs exist) |
| **SC-03** (new) | Medium | GitLab CE also has no immutable container tags (Ultimate-only, ≤5 protection rules/project even there). This repo's rollback story is entirely digest-based (TASK-619's job), and Kyverno's `verifyImages` policy (Wave C) MUST verify by digest, never by mutable tag — a tag-based policy is bypassable by re-pushing the same tag to a different digest, which is exactly the attack immutable tags exist to prevent on Ultimate | SOTA research §A7 (`sota-research-2026.md:198`); GitLab immutable-tags tier gate |

### 2.2 Does it exist today? — job-by-job

| Job / control | Exists | Blocks the pipeline | State |
|---|---|---|---|
| `scan-gitleaks` (secret scan) | Authored, not registered | — | Entire job body commented out (`scan.yml:134-176`); ruleset file unused |
| `scan-source` (Trivy fs SAST) | Yes | No | `--exit-code 0`, `allow_failure: true` (`scan.yml:109-128`) — informational only, and out of scope for this ticket's blocking work (kept non-blocking deliberately per its rule comment; not one of C-01/C-02) |
| `.trivy-scan` (per-image container scan template) | Yes | No | Triple-neutralized, C-02 |
| `scan-api` / `scan-stt` / `scan-smr` / `scan-nlp` / `scan-compat-playground` | Yes (5 jobs) | No (inherits `.trivy-scan`) | Exist but non-blocking |
| `scan-guardrail` / `scan-harness` / `scan-admin-console` / `scan-tts` / `scan-stt-worker` / `scan-database` / `scan-python-base` | **No** | — | Never authored — 7 of 12 images |
| `test-stt` / `test-smr` / `test-guardrail` / `test-nlp` | Yes | No | `allow_failure: true`, C-03 |
| `test-harness` / `test-tts` | Yes | Yes | Already correct — not touched by this ticket |
| cosign image signing | **No** | — | Zero references, SC-01 |
| CycloneDX SBOM generation/attestation | **No** | — | Zero references, SC-01 |
| Kyverno unsigned-image admission policy | **No** | — | Zero references, SC-01; also has no cluster-side Kyverno install to attach to yet (TASK-618 introduces Kyverno; this ticket adds one policy to it) |
| Registry `name_regex_keep` | **No** | — | C-20/F12 |
| GitLab immutable container tags | **No** (Ultimate-only) | — | SC-03; digest-pinning is the CE-tier substitute (TASK-619) |

---

## 3. Implementation Plan

Three waves. Everything inside a wave runs concurrently. Tier and effort per the
[Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md).

**⚙ = human-applied** (agent authors, owner executes). **⚠ = owner decision.**

### Wave A — Arm the existing jobs (no new tooling, closes C-01/C-02/C-11)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **A.1** | **Uncomment `scan-gitleaks` in working-tree mode.** Restore the job body at `.gitlab/ci/scan.yml:134-176` but change `GIT_DEPTH: 0` (full-history clone) to the default shallow depth and drop `--source .` history scanning in favor of gitleaks' working-tree-only mode, matching exactly what the sibling `hope-v2-deployment` repo's CI did first. Full-history mode is Wave-B-gated (§5) — it would fail permanently on the already-known F0-1 secrets in `arca/hope-v2-deployment` history, and this repo's own history has not been audited for equivalents yet | C-01 | Moderate — config change with a documented reason | `sonnet-5` | medium | Keep `allow_failure: false`; keep the SARIF artifact wiring as-is |
| **A.2** | **Fix the Trivy container-scan template.** In `.gitlab/ci/scan.yml:22-38`: change the first scan's `--exit-code 0` → `--exit-code 1` for CRITICAL only (keep HIGH,CRITICAL reporting via a separate non-blocking informational pass, or fold into one call with `--exit-code 1 --severity CRITICAL` blocking + a second non-blocking `--severity HIGH` pass for visibility); remove the `\|\| echo "..."` swallow on line 37; remove `allow_failure: true` on line 38. Net effect: CRITICAL vulnerabilities fail the job, HIGH is reported but non-blocking | C-02 | Moderate — single template, five jobs inherit it | `sonnet-5` | medium | Touches ONE template (`.trivy-scan`); all five `scan-*` jobs inherit the fix automatically — do not edit them individually |
| **A.3** | **Author the 7 missing `scan-*` jobs** (`scan-guardrail`, `scan-harness`, `scan-admin-console`, `scan-tts`, `scan-stt-worker`, `scan-database`, `scan-python-base`) by extending `.trivy-scan` exactly like the existing five, each `needs:`-ing its `build-*` job's artifact and gated by the matching `.rules-<svc>` fragment (follow `scan-guardrail`'s pattern from `scan-api`'s block, lines 42-53, substituting the service) | C-11 | Moderate — 7 near-identical jobs, mechanical but must match each service's existing `.rules-*` fragment exactly | `sonnet-5` | high | Cross-check each new job's `rules:` block against its `build-*` job's rules in `build.yml` — a mismatched rule silently never runs |
| **A.4** | **Diagnose each of the 4 `allow_failure` Python suites independently**: run `test-stt`, `test-smr`, `test-guardrail`, `test-nlp` and report, per suite, whether it is currently green or red. **This is diagnosis only — do not remove `allow_failure` yet.** Un-flagging is C.1 below and is gated on this task's findings | C-03 | Moderate — 4 independent live test runs, no code change | `sonnet-5` | high | Deliverable: a table, one row per suite, pass/fail + failure summary if red |

**Wave A gate**: `scan-gitleaks` runs on every pipeline type in working-tree mode and blocks;
Trivy blocks on CRITICAL; all 12 built images have a `scan-*` job; the four Python suites have a
documented current pass/fail state.

### Wave B — Close the C-03 gap for real (depends on A.4's findings)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **C.1a** | For each suite A.4 found **green**: remove `allow_failure: true` from that job in `.gitlab/ci/test.yml` (one line each, at the line numbers cited in C-03) | C-03 (green suites) | Trivial | `haiku-4-5` | default | Independent per suite — do only the ones A.4 confirmed green |
| **C.1b** | For each suite A.4 found **red**: this is NOT a flag flip. ⚠ **Owner-blocked** — the service owner fixes the actual failing test(s) (root cause, not a skip/xfail), THEN the flag comes off in a follow-up commit. Do not un-flag a suite whose test is red; that converts "hidden failure" into "blocking failure that nobody has fixed," which breaks every pipeline for that service until it's addressed | C-03 (red suites) | — | **human** (service owner) | — | Track each red suite as its own line item in §4; this ticket cannot close it unilaterally |

**Wave B gate**: every suite A.4 found green ships with `allow_failure` removed; every suite found
red has a named owner and a tracked defect, not a silently-flipped flag.

### Wave C — 2026 baseline: signing, SBOM, admission enforcement, registry retention

Strict internal order (see §5): **C.2 → C.3 → C.4**. cosign must exist before Kyverno verifies
anything, and the SBOM attestation depends on cosign's signing identity too.

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **C.2** | **cosign keyless signing.** Add `id_tokens: { SIGSTORE_ID_TOKEN: { aud: sigstore } }` and a `cosign sign` step to `.gitlab/ci/publish.yml` (wherever the pushed image reference is finalized, after `build-*`/before/alongside `scan-*`). Sign by digest, not tag (SC-03). Requires cosign v2.0+. GitLab ships a `Cosign.gitlab-ci.yml` template — follow it rather than hand-rolling the OIDC exchange, mirroring how `.gitlab/ci/vault.yml` already documents the `id_tokens` (Free-tier) vs `secrets:` (Premium/Ultimate) split for Vault | SC-01 | Complex — new signing identity, OIDC wiring, blast radius is every published image | `opus-4-8` | high | `id_tokens` is Free-tier (confirmed by the same CI-lint probe `.gitlab/ci/vault.yml:11-22` used for Vault); do not attempt the native `secrets:`/Cosign GitLab-managed-key flow — same Premium/Ultimate gate as Vault's `secrets:` keyword |
| **C.3** | **CycloneDX SBOM per image, attached as an in-toto attestation via `cosign attest`.** Generate with `syft` (or Trivy's own `--format cyclonedx` output, already available in the pinned `aquasec/trivy:0.58.2` image used by `.trivy-scan`) immediately after C.2's signing step, keyed to the same digest | SC-01 | Moderate — one more step per publish job, reuses the already-vendored Trivy binary | `sonnet-5` | high | Depends on C.2 (attestation needs a signing identity) |
| **C.4** | **Kyverno `verifyImages` admission policy** rejecting unsigned images. Policy authored here; cluster-side Kyverno install and namespace scoping is [TASK-618](../TASK-618-PHI-Security-Baseline/README.md)'s (this ticket adds the ONE image-signature policy, not the PSA/NetworkPolicy set). Policy MUST target the image **digest**, never the tag (SC-03) — verifying a tag is bypassable by re-pushing. Author it against `dev` namespace first with `validationFailureAction: Audit`, not `Enforce`, per the sequencing note below | SC-01 | Complex — cluster admission policy, wrong config either blocks all deploys or silently allows everything | `opus-4-8` | high | **Hard dependency: C.2 must be live and producing real signatures in the cluster's registry before this policy is applied — see §5.** Coordinate namespace scope with TASK-618's Kyverno rollout so two tickets don't both bootstrap the Kyverno install |
| **C.5** | **Registry retention fix (shared with TASK-619 C.11).** Set `name_regex_keep` on the project's `container_expiration_policy` (`PUT /projects/:id` with `container_expiration_policy_attributes.name_regex_keep`) to protect `^(v\|prod-\|production-)` release tags. This is a GitLab API/UI call, not a file in either repo — author the exact `curl`/`glab` command for the owner to run once; do not implement it twice across this ticket and TASK-619 | C-20/F12 | Trivial — one API call, already fully specified | `haiku-4-5` | default | ⚙ human-applied (project-settings write); coordinate with TASK-619 so only one of the two tickets actually executes it |

**Wave C gate**: every newly-published image carries a verifiable cosign signature and an attached
CycloneDX SBOM; the Kyverno policy exists in `Audit` mode against `dev` with zero false-positive
denials over a 48h observation window before any `Enforce` flip (owner decision, §4); release tags
survive the 90-day registry reap.

---

## 4. Owner decisions and blocked items

| # | Item | Why it is owner-only |
|---|---|---|
| **⚠ 1** | **Kyverno `Audit` → `Enforce` flip** (C.4). Only after a 48h+ observation window with zero false-positive denials on real traffic. Flipping early risks blocking every deploy the moment the policy has a scoping bug | Irreversible-in-effect (blocks all deploys) production posture change |
| **⚠ 2** | **Any C.1b red suite** (test-stt / test-smr / test-guardrail / test-nlp, whichever A.4 finds red). Fixing a failing test is service-owner work, not infrastructure work — this ticket names the gap, it does not silently patch or skip the failing assertion | Domain knowledge of the service under test |
| **⚙ 3** | **C.2's cosign OIDC role setup on the Sigstore/Fulcio side** — no agent can create or verify the trust root config; only prepare the exact `id_tokens`/`cosign sign` invocation | No access; irreversible signing-identity bootstrap |
| **⚙ 4** | **C.5's registry API call** — `PUT /projects/6` with project-owner credentials | GitLab admin action; also must be de-duplicated against TASK-619 (§3 note) |
| **🚫 5** | **GPU CI runner for C-18.** No GPU-capable runner exists; provisioning one is out of scope for this ticket (§1) and is not assigned here — flagged so the gap is tracked, not silently dropped | No capability; separate infra decision |
| **⚠ 6** | **Full-history `scan-gitleaks` activation** (deferred past A.1's working-tree mode). Requires TASK-619's F0-1 credential rotation to land first, or the job fails permanently on the already-known committed secrets in `arca/hope-v2-deployment` history (a different repo's history than this one, but the same operational blocker: full-history gitleaks in either repo needs its known-secrets question resolved first) | Depends on a rotation this ticket does not own |

---

## 5. Sequencing constraints

These are the orderings where getting it wrong produces a silently-broken control, not a build error.

1. **gitleaks ships in working-tree mode first (A.1), never full-history mode, until TASK-619's F0-1
   credential rotation lands.** Two live credentials (a GitLab access token for user `argocd`, and
   `gitlab+deploy-token-2`) are committed in plaintext in commit `08d1651` on `origin/main` of
   `arca/hope-v2-deployment` **today**. A full-history gitleaks scan of that repo (or any repo with
   an equivalent unrotated finding) would fail every single pipeline permanently on an already-known
   issue, training everyone to ignore the job's red — exactly how C-01 ended up commented out in the
   first place. Ship `--no-git`/working-tree mode now (A.1); revisit full-history mode only after
   rotation (⚠ 6).
2. **cosign (C.2) before SBOM attestation (C.3).** `cosign attest` needs a signing identity that
   only exists once C.2 is live; there is no attestation without a signer.
3. **cosign (C.2) before Kyverno (C.4), never the other way.** A Kyverno unsigned-image admission
   policy verifying a signature scheme that produces no signatures passes everything silently — the
   policy exists, appears to be "on," and enforces nothing. This is the single most dangerous
   ordering mistake available in this ticket: it looks done and is not.
4. **Kyverno policy targets digests, never tags (C.4, SC-03).** GitLab CE has no immutable container
   tags (Ultimate-only); this stack's only tamper-resistant reference is the digest. A tag-based
   `verifyImages` rule is bypassable by re-pushing the same tag to a new digest — signing means
   nothing if the enforcement point can be pointed at unsigned content under the same name.
   Corollary: C.4 assumes TASK-619's digest-pinning in the deployment overlays already exists: if
   overlays still deploy by mutable tag, Kyverno verifying-by-digest has nothing stable to check
   against at admission time.
5. **Kyverno ships `Audit` before `Enforce` (C.4, ⚠ 1).** A misscoped policy in `Enforce` mode
   blocks every deploy in the target namespace, including unrelated fixes trying to land during the
   incident. Observe first.
6. **Wave A before Wave C.** Arming the existing Trivy/gitleaks jobs is cheap, reversible, and
   immediately raises the floor; the new cosign/SBOM/Kyverno stack is slower to land and has real
   failure modes (constraints 2–5). Do not let Wave C's complexity delay Wave A's near-zero-risk fixes.
7. **C.1a/C.1b (Wave B) is independent per suite and has no ordering dependency on Wave C** — it can
   run in parallel with Wave C once A.4's diagnosis is in.
8. **Registry retention (C.5) has no dependency on anything else in this ticket** but must be
   de-duplicated against TASK-619 step C.11 — implement once. Whichever ticket lands first executes
   the API call; the other links to it instead of repeating it.

---

## 6. Acceptance criteria

Part A — existing jobs armed:
- [ ] `scan-gitleaks` runs on every `PIPELINE_TYPE` the commented-out rules block listed (`.gitlab/ci/scan.yml:166-175`), in working-tree mode, `allow_failure: false`, and a pipeline with a planted test secret fails it
- [ ] `.trivy-scan` fails a pipeline when a CRITICAL vulnerability is present in a scanned image (verified against a known-vulnerable test image or an existing image with a real CRITICAL finding)
- [ ] All 12 built images (`api`, `admin-console`, `compat-playground`, `nlp`, `guardrail`, `smr`, `harness`, `tts`, `stt`, `stt-worker`, `database`, `python-base`) have a corresponding `scan-*` job that runs on the same rules as their `build-*` job
- [ ] `test-stt`/`test-smr`/`test-guardrail`/`test-nlp` each have a documented current pass/fail state (A.4's table)

Part B — C-03 closed honestly:
- [ ] Every suite found green in A.4 has `allow_failure: true` removed and a subsequent pipeline shows it as blocking
- [ ] Every suite found red in A.4 has a tracked, owner-assigned defect (not this ticket silently closing it) and remains `allow_failure: true` until that defect is fixed

Part C — 2026 baseline:
- [ ] A published image carries a cosign signature verifiable with `cosign verify --certificate-identity ... --certificate-oidc-issuer ...` against the real Fulcio/Rekor infrastructure
- [ ] The same image has an attached CycloneDX SBOM retrievable via `cosign download attestation` (or equivalent) and it parses as valid CycloneDX
- [ ] The Kyverno policy exists in the cluster in `Audit` mode, targets image digest not tag, and a manually-pushed unsigned test image is logged as a policy violation (not silently allowed) during the 48h observation window
- [ ] `⚠ 1`'s `Enforce` flip has NOT happened as part of this ticket's automated work — it is owner-executed after observation
- [ ] `GET /projects/6`'s `container_expiration_policy.name_regex_keep` protects `^(v|prod-|production-)`; a synthetic release-pattern tag survives a simulated 90-day-old reap dry-run

---

## 7. Implementation Summary

### Wave A — done 2026-08-08 (`ce14fed0`)

**A.2 Trivy** armed: the template was neutralised three times over (`--exit-code 0`, `|| echo` swallowing pass 2, `allow_failure: true`). Now blocks on CRITICAL; HIGH stays informational.
**A.3** — 12 images were built, 5 scanned. Added the 7 missing jobs; verified **both** directions (nothing built-unscanned, nothing scanning a build that never runs).
**A.1 gitleaks** restored in working-tree mode, blocking. Full-history is Wave-B-gated: this repo's history is unaudited, and the sibling repo showed the failure mode.

Arming it surfaced 3 hits, all placeholders. Allowlisted **by match form, not by path** — a path allowlist would then hide a real password in those same files. Needed `regexTarget = "match"`; gitleaks matches allowlist regexes against the captured *secret* by default, so without it the allowlist silently never fires. Verified against a `git archive HEAD` checkout: 0 leaks, a real `postgresql://admin:<pw>@` still caught.

### A.4 — the four `allow_failure` Python suites

Run with each job's **exact** CI command.

| Suite | CI-shaped result | Verdict |
|---|---|---|
| `test-stt` | 2753 passed | **GREEN** |
| `test-nlp` | 202 passed | **GREEN** |
| `test-guardrail` | 187 passed | **GREEN** |
| `test-smr` | 1 failed, 690 passed | **RED** — `test_provider_key_consistency.py::test_unconfigured_azure_not_registered_and_env_enable_ignored`; `azure-openai` registers when the test asserts it must not. Persists with Azure vars unset, so it is a real defect, not env bleed |

⚠️ **Three of these first appeared RED locally and were not.** `nlp` and `guardrail` failed `401 != 200`, and `smr` mis-registered Azure, purely because `.env.dev` supplies a service token and Azure credentials that CI does not have. Re-running with those variables **unset** (not empty — setting them empty breaks a different nlp test that asserts Vault's secrets-dir supplies the value, since host env outranks secrets_dir) turned all three green. A verdict taken from a bare local run would have been wrong in both directions.

**A.4 also found a defect this ticket did not record**: `test-stt`'s command ended in `|| true`. `allow_failure: true` was not its only gag — removing the flag alone would have been cosmetic.

### Wave B — done 2026-08-08

C.1a applied to the three green suites (`allow_failure` removed; `|| true` removed from stt). `test-smr` **keeps** `allow_failure: true` per C.1b — a red suite is owner-blocked, not flag-flipped.

🔴 **Forward risk for [TASK-619](../TASK-619-GitOps-CICD-Delivery-Loop/README.md)**: these suites pass today only because `VAULT_ADDR` is deliberately empty, so `.vault-oidc` injects nothing. The moment Vault is armed in CI, service tokens get injected and `nlp`/`guardrail` will start returning `401` — exactly the local failure. The tests assume the unauthenticated dev-mode bypass. Arming Vault and un-flagging these suites are coupled, and were not previously known to be.

**Not done**: Wave C (C.2 cosign, C.3 SBOM, C.4 Kyverno, C.5 registry retention).


*Not started — awaiting owner approval of this plan (Phase 3 gate).*

---

## 8. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Ticket created as TASK-616 Phase 5. Findings grounded in a direct read of `.gitlab/ci/scan.yml`, `.gitlab/ci/test.yml`, `.gitlab/ci/build.yml`, `.gitlab-ci.yml`, `.gitlab/ci/vault.yml` and `.gitleaks.toml` (2026-08-08). Three critical gaps confirmed live: `scan-gitleaks` fully commented out (C-01), Trivy triple-neutralized against ever failing a pipeline (C-02), and 4 of 6 Python suites `allow_failure`-flagged with their `build-*` jobs `needs:`-ing them anyway so a red suite never blocks an image (C-03). Coverage gap confirmed: only 5 of 12 built images are scanned at all (C-11). Zero cosign/SBOM/Kyverno tooling found anywhere in either repo (SC-01) — the 2026 SOTA baseline (§A7, §A12 #3) is unimplemented, not partial. Registry cleanup-policy inversion (C-20/F12) reconfirmed and explicitly shared with TASK-619 C.11 to avoid double implementation. `harness-eval-gate`'s `allow_failure` explicitly scoped out as a different defect class. Hard sequencing encoded: gitleaks working-tree-mode-first (blocked on TASK-619 F0-1 for full-history mode), cosign before SBOM before Kyverno, Kyverno by digest never tag, Audit before Enforce. Status `Pending` pending owner approval. | Claude |
