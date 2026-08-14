# TASK-693 — GitLab → GitHub Migration: CI/CD, Registry, Packages & Release Management

| Field | Value |
|---|---|
| **Status** | `In Progress` — design approved 2026-08-13; the locally-verifiable subset of lanes A/D/E has landed (§9.1). Workflows not yet written: they cannot be executed until the repo is on GitHub. |
| **Type** | `infrastructure` |
| **Ticket number** | TASK-693 (assigned by owner 2026-08-13) |
| **Parent / sibling** | **[TASK-690](../TASK-690-AWS-Deployment-Architecture/README.md)** owns the AWS landing zone, GPU tier, cost model, and data migration. This ticket is the **execution detail for TASK-690 phase P5** and is deliberately scoped to CI/CD, registry, npm packages, and release mechanics. |
| **Depends on** | [TASK-648](../../operations/versioning.md) — release tag grammar (`packages/utils/src/version-grammar.ts`) is the input, not a deliverable, of this ticket |
| **Blocked by** | Nothing hard. Org confirmed **`ArcaAI`**, packages are **private** (owner, 2026-08-13). One open item — the target **repo name** — decides whether lane D is near-free or needs a package re-link (§0.2). |
| **Evidence base** | Direct read of all 13 `.gitlab/ci/*` files (4,082 lines), `promote.sh`, `templates.yml`, every publishable `package.json`, `docs/operations/versioning.md`, `docs/operations/vox-sdk-release/README.md`, 2026-08-13 |

---

## 0. Scope

### 0.1 What this ticket covers, and what it does not

| In scope (this ticket) | Out of scope — owned elsewhere |
|---|---|
| GitHub Actions workflow architecture (reusable workflows, composite actions, the `classify` job) | EKS landing zone, Terraform, VPC/RDS/ElastiCache — **TASK-690 P2** |
| Per-service build + promotion mechanics | GPU sizing, inference topology, cost model — **TASK-690 §2/§2A/§5** |
| Container registry: ECR layout, immutability, lifecycle, pull-through cache, cross-account promotion | The *decision* to use ECR — already made in **TASK-690 §4.1** |
| **npm packages → private GitHub Packages under `ArcaAI`** (not covered anywhere else) | arm64 rebuilds — **TASK-690 P4** |
| **Release management: tags, environments, approvals, changelog** (not covered anywhere else) | Version *grammar* — **TASK-648**, consumed as-is |
| cosign/SBOM activation, CodeQL, Dependabot | Data migration rehearsal — **TASK-690 P6** |
| Zero-downtime obligations that CI must enforce (migration compatibility gate) | Zero-downtime *runtime* config (probes, PDBs, ALB) — **TASK-690 §4.4 / P3** |

### 0.2 Destination — settled, with one open item

**Owner decision, 2026-08-13:** the org is **`ArcaAI`**, and **every npm package publishes private**. The last successful release went to `ArcaAI/project-hope`, so that path is known-good and is the reference configuration.

Current on-disk state is already consistent with it — all 9 publishable packages carry `repository.url = git+https://github.com/ArcaAI/project-hope.git` (verified 2026-08-13). Two facts follow:

- The org name resolves. npm scopes are lowercase, so `@arcaai/*` ↔ org `ArcaAI` is fine — and the successful release proves it empirically, which is worth more than the docs.
- The `4bits-vn/project-hope-v2` mirror (`.gitlab/ci/notify.yml:26`) is unrelated to packages and gets deleted in lane F regardless.

**The one open item is the target repo NAME, and it is a real fork in lane D:**

| If the monorepo lands at… | Lane D effort |
|---|---|
| **`ArcaAI/project-hope`** (matches `repository.url` today) | Near-free. `GITHUB_TOKEN` publishes with no extra grant. |
| **any other name** (e.g. `ArcaAI/hope-v2`, matching the GitLab remote `arca/hope-v2`) | Needs a deliberate re-link — see K-9. `GITHUB_TOKEN` from repo X **cannot** publish a package linked to repo Y; it 403s. |

This is the only genuinely new risk the private-package decision introduces, and it is invisible until the first publish fails. It is tracked as **Q1** and **K-9**, not as a blocker — lane D can be fully authored before the answer lands.

---

## 1. Requirement Analysis

The owner's stated requirements, restated as testable properties:

| # | Requirement | Testable property |
|---|---|---|
| R1 | CI/CD, build and release with **promotion per app/service** | A named service at a named version can be promoted to a named environment, independently of every other service, with an auditable approval record |
| R2 | **Seamless EKS integration, zero downtime** | No deploy path mutates the cluster directly; every environment change is a Git commit; no rollout can serve traffic from a pod that is not ready, and no schema change can break the previously-deployed image |
| R3 | **Environment isolation**, starting with a pilot/staging environment | A credential, an image tag, or an approval valid for staging is mechanically incapable of affecting prod |
| R4 | **GitHub Registry or AWS ECR** | One registry is authoritative for runtime images; pulls require no rotating secret; tags cannot be re-pointed |
| R5 | **GitHub Packages for Node packages** | `@arcaai/*` publishes from CI with no human-held token; consumers can install |
| R6 | **App/service version and release management** | The version of any running process is derivable from the artifact alone, and every deployed digest traces to a tag, a commit, and a test run |

---

## 2. Current State Evaluation

### 2.1 Four invariants that are already correct — port, do not redesign

The existing pipeline gets four things right that most teams do not. They are the load-bearing design and must survive the migration unchanged in *behaviour*, however much the YAML changes:

1. **Build once, promote by digest.** [`promote.sh:108-118`](../../../.gitlab/ci/promote.sh) resolves the `sha-<sha8>` manifest digest and re-tags it with `imagetools create` — zero rebuild. Production is structurally incapable of running bytes that were not tested.
2. **No `latest`, anywhere.** Every image carries `sha-<sha8>` (immutable identity) plus exactly one env or release tag.
3. **CI never touches the cluster.** The deploy stage commits a digest pin to `arca/hope-v2-deployment`; Argo CD pulls. This is what makes rollback a `git revert` rather than an incident.
4. **The git tag is the version**, baked into the image as `/app/build-info.json` — never `package.json`. (TASK-648.)

> **Corollary for the whole ticket: this is a transport change, not an architecture change.** Any proposal that alters one of these four is out of scope and needs its own ticket.

### 2.2 Defects found — do not port these

| ID | Finding | Evidence |
|---|---|---|
| **C-1** | **npm publishing is half-migrated and non-functional.** Every publishable package already declares `publishConfig.registry: https://npm.pkg.github.com`, but [`publish.yml:99-108`](../../../.gitlab/ci/publish.yml) writes a `.npmrc` authenticating to the **GitLab** registry. `publishConfig.registry` wins at publish time → 401. It never gets that far: `.changeset/` **does not exist**, so `pnpm changeset version` (line 113) fails first. The job has therefore never succeeded. Releases are cut by hand ([runbook](../../operations/vox-sdk-release/README.md)). | verified: `ls .changeset` → absent; 9 packages carry the GitHub registry |
| **C-2** | **Image signing is 100 % inert and cannot be fixed on GitLab.** [`publish.yml:157-190`](../../../.gitlab/ci/publish.yml) documents it: `git.taphuynh.dev` is not in public Fulcio's `oidc-issuers` allow-list, and the `meta-issuers` wildcards do not cover self-hosted GitLab. All 14 `sign-*` + `sbom-*` jobs are dead weight, and the Kyverno `verifyImages` policy in the deployment repo verifies nothing. | same file; matches TASK-690 §6.3 |
| **C-3** | **The service inventory is hand-maintained in 5 places.** `build.yml` job list · [`promote.sh:101`](../../../.gitlab/ci/promote.sh) `SERVICES=` · `scan.yml` · `publish.yml` · `SERVICE_TAG_PREFIXES` in `packages/utils/src/version-grammar.ts`. A service added to four of five is a silent partial deployment. | `promote.sh:97-101` explicitly warns the names "MUST equal the `SERVICE_NAME` of its build job" — a comment doing a schema's job |
| **C-4** | **The prod trigger tag has no enforced relationship to the release tag.** [`versioning.md §5`](../../operations/versioning.md) states it outright: "`ALL-<ver>` and `vX.Y.Z` … do not imply each other … nothing in CI enforces that they match." A `v2.2.0` on the wrong commit promotes whatever that commit last built. | `versioning.md:205-209` |
| **C-5** | **`warm-up-base-images` is an artefact of persistent runners and becomes harmful without them.** [`build.yml:36-73`](../../../.gitlab/ci/build.yml) pre-pulls 8 base images including `nvidia/cuda:12.8.1-cudnn-devel`. On ephemeral runners this caches nothing and every build cold-pulls multi-GB layers. | job body is `docker image inspect \|\| docker pull` — pure local-cache logic |
| **C-6** | **`dev-2.1` ships images built from entirely unverified code.** `.gitlab-ci.yml:65-68` sets `SKIP_TESTS: "true"`; `rules.yml` forces `when: never` on the validate and scan jobs; builds still run with `needs: optional: true`. | corroborates TASK-690 §6.1 — **prerequisite, not follow-up** |
| **C-7** | **Registry is plain HTTP.** `.buildx-registry-login` writes `http = true, insecure = true` into `buildkitd.toml`. | `templates.yml:99-111` |
| **C-8** | **No build caching of any kind.** `turbo.json` sets `"cache": false` on `build` (and on `@arcaai/database#build`); no Turbo remote cache is configured. | `turbo.json:6-30`; corroborates TASK-690 §6.4 |
| **C-9** | **The deploy credential is a long-lived PAT** (`DEPLOY_TOKEN`) with `write_repository` on the deployment repo, held as a masked CI variable. | `deploy.yml:36-40` |
| **C-10** | **Promotions are not serialized.** [`promote.sh:173-206`](../../../.gitlab/ci/promote.sh) carries a 5-attempt reset-and-replay loop precisely because two `promote-*` jobs can race on the deployment repo's `main`. The retry is a correct mitigation for a problem that should not exist. | the script's own comment: "The promote-* jobs are not serialized against each other" |

### 2.3 What GitLab did well that GitHub does *worse*, and needs compensating

Not everything improves. Three regressions to plan for:

| Loss | Impact | Compensation |
|---|---|---|
| `extends:` + `!reference` for **shared `rules:` fragments** | `rules.yml` is 395 lines of 17 reusable path-filter anchors. GHA has **no equivalent** — `if:` cannot be composed. | Centralise path filters in the `classify` job (§4.2); every downstream `if:` reads one output. Never inline a path filter in a job. |
| `needs: {optional: true}` (~40 uses) | GHA's `needs` hard-fails on a skipped dependency. Naive translation either blocks legitimate skips or runs jobs it shouldn't. | Standard idiom, applied mechanically: `if: ${{ !cancelled() && !contains(needs.*.result, 'failure') }}`. This is TASK-690 R-2's silent-drift risk and is where review effort belongs. |
| `artifacts:reports:dotenv` (`build.env` carries `DIGEST` between stages) | No direct equivalent. | `$GITHUB_OUTPUT` from the reusable workflow's `outputs:` block. |

---

## 3. Design Principles

Five rules that decide every open question below.

1. **One source of truth per fact.** The service inventory, the tag grammar, and the environment list each live in exactly one file, and CI fails if a second copy disagrees.
2. **Deploys are an action, not a side effect of a tag.** A tag records that a version exists. A deploy records that a human approved putting it somewhere. Conflating them is C-4.
3. **No long-lived credentials.** OIDC to AWS, OIDC to Vault, GitHub App tokens for repo writes, `GITHUB_TOKEN` for packages. Every static secret removed is an audit finding closed.
4. **Environment isolation is enforced by the identity system, not by convention.** A staging job must be *incapable* of assuming the prod role — not merely unlikely to.
5. **Port the comments, not just the YAML.** The 4,082 lines encode paid-for incidents: the `--metadata-file` digest fix (a bare `imagetools inspect` silently emitted empty digests, [`templates.yml:232-259`](../../../.gitlab/ci/templates.yml)), the promote retry loop, the `harness` `optional: true` shim. Each is a postmortem. Losing the comment loses the lesson.

---

## 4. Target Design

### 4.1 Single source of truth for the service inventory (fixes C-3)

`.github/services.json` — the only place a service is declared:

```jsonc
[
  {
    "name": "api",                       // == image repo name == promote.sh key == kustomize image name
    "tagPrefix": "API",                  // must exist in SERVICE_TAG_PREFIXES
    "dockerfile": "apps/api/Dockerfile",
    "context": ".",
    "target": null,
    "pythonBase": false,
    "arch": ["amd64", "arm64"],
    "paths": ["apps/api/**", "packages/**", "pnpm-lock.yaml"]
  }
  // … 13 more: admin-console, compat-playground, smr, guardrail, nlp, tts,
  //    harness, harness-worker, stt-ml-runtime, stt-worker, database,
  //    qdrant-init, hope-python-base
]
```

Consumed by `fromJSON()` for the build, scan, sign, and promote matrices. A new CI check asserts `services.json` ⟷ `SERVICE_TAG_PREFIXES` parity — the same enum-parity discipline already used for `ResourceType` (`resourceType.enum-parity.test.ts`).

### 4.2 Workflow architecture

```
.github/
  services.json
  actions/
    setup-pnpm/action.yml          # corepack + pnpm install --frozen-lockfile + store cache
    setup-python-uv/action.yml     # uv sync --frozen  (NOT conda — arcaenv does not exist on a runner)
    ecr-login/action.yml           # OIDC → IAM role → amazon-ecr-login → buildx builder
  workflows/
    ci.yml                 # pull_request + push: classify → lint/typecheck/test (filtered)
    build.yml              # push dev-*/staging-*, tags <SVC>-x.y.z | ALL-x.y.z
    promote.yml            # workflow_dispatch(environment, version) — Environment-gated
    release-npm.yml        # Changesets: version PR → publish
    security.yml           # CodeQL, gitleaks (full history), Trivy fs, Dependabot triage
    _test-node.yml         # reusable
    _test-python.yml       # reusable  (service containers — see R-1)
    _build-image.yml       # reusable: one service → ECR; outputs: digest
    _sign-attest.yml       # reusable: cosign sign --key-less + CycloneDX attestation, by digest
```

**The `classify` job replaces `PIPELINE_TYPE`.** One job at the top of `ci.yml`/`build.yml` emits every routing decision as an output — `pipeline_type`, plus one boolean per service from `dorny/paths-filter` driven by `services.json.paths`, plus the build matrix as a JSON array. Every downstream `if:` reads `needs.classify.outputs.*` and nothing else. This is the single compensating control for the loss of `!reference` (§2.3) and the mitigation for TASK-690 R-2.

### 4.3 Per-service promotion (R1, R3)

```yaml
# promote.yml
on:
  workflow_dispatch:
    inputs:
      environment: { type: choice, options: [dev, staging, prod] }
      version:     { type: string }   # ALL-2.2.0 | SMR-2.1.0
      services:    { type: string, default: "" }   # "" = every service in the tag's scope

concurrency:
  group: promote-${{ inputs.environment }}      # ← serializes; retires the promote.sh race (C-10)
  cancel-in-progress: false

jobs:
  promote:
    environment: ${{ inputs.environment }}      # ← required reviewers, env secrets, audit record
    permissions: { id-token: write, contents: read }
```

This replaces the `vX.Y.Z` tag trigger and fixes C-4: the version becomes an *input* that can be validated, rather than a tag whose relationship to the release is conventional. Preconditions enforced in the job, before anything is re-tagged:

1. The tag exists and parses under `version-grammar.ts`.
2. A `sha-<sha8>` image exists for the tagged commit, for every service in scope.
3. That digest has a **passing Trivy result and a valid cosign signature**.
4. `environment == prod` ⟹ the version has **no prerelease component**. (Stated as policy in `versioning.md §5`, enforced nowhere today.)
5. `environment == prod` ⟹ the digest is already deployed in `staging`. No skipping the pilot.

`promote.sh` itself is kept **near-verbatim** — it is provider-agnostic POSIX shell, and it carries hard-won behaviour (empty-promotion refusal, declarative pin replay). Changes: `CI_*` → inputs, and the retry loop can be simplified once `concurrency` guarantees serialization (keep it initially; remove only after a quarter of clean runs).

**Isolation (R3)** is enforced by identity, not naming:

| | dev | staging | prod |
|---|---|---|---|
| GitHub Environment | `dev` | `staging` (required reviewer) | `prod` (required reviewer + wait timer) |
| AWS IAM role | `hope-ci-dev` | `hope-ci-staging` | `hope-ci-prod` — **separate AWS account** |
| OIDC trust condition | `environment:dev` | `environment:staging` | `environment:prod` |
| Vault role | `hope-ci-deploy-dev` | `-staging` | `-prod` |
| GitHub App installation | deployment repo, `overlays/dev` | `overlays/staging` | `overlays/prod` |

The IAM trust policy conditions on `token.actions.githubusercontent.com:sub` containing `environment:prod`. A workflow that has not passed the `prod` Environment gate **cannot mint prod credentials** — the isolation is cryptographic, not procedural. This is the direct replacement for GitLab's protected-branch/protected-variable model, and it is stronger.

### 4.4 What CI owes zero-downtime (R2)

TASK-690 §4.4/P3 owns the runtime side (probes, PDBs, ALB idle timeout, topology spread). CI owes exactly two things, and they are the two most commonly missed:

1. **CI must never touch the cluster.** Preserved: the promote job's only write is a Git commit to the deployment repo. No `kubectl`, no `helm upgrade`, no `argocd app sync` from a workflow. (`argocd app rollback` without a paired `git revert` is the documented footgun — [deployment runbook §1](../../operations/deployment/README.md).)

2. **A migration compatibility gate.** This is the real zero-downtime risk and it has no owner today. The Argo `PreSync` `db-migrate` Job runs **while the previous release's pods are still serving traffic**. A migration that is not backwards-compatible with the previously-deployed image takes the platform down during a rollout that every probe reports as healthy.

   **Shipped** as `scripts/check-migration-compat.ts` (`pnpm db:migrate:compat`). Required check on any PR touching `packages/database/src/prisma/**/migrations/**`.

   | Rule | Severity | Fires on |
   |---|---|---|
   | `drop-column` | **error** | `DROP COLUMN` |
   | `drop-table` | **error** | `DROP TABLE` |
   | `rename-table-or-column` | **error** | `ALTER TABLE` **and** `RENAME` in one statement |
   | `alter-column-type` | **error** | `ALTER COLUMN` **and** `TYPE` in one statement |
   | `set-not-null` | **error** | `SET NOT NULL` |
   | `non-concurrent-index` | warn | `CREATE INDEX` without `CONCURRENTLY` |

   > **Two rules in the original design were wrong, and measuring the existing 87 migrations is what showed it.** Both narrowings are load-bearing:
   >
   > - A blanket **`RENAME`** rule would have been **100 % false positives**. Every RENAME in the repo's history is `ALTER INDEX … RENAME` (the TASK-648 index-alignment migration); renaming an index is safe because no application code names one. The rule now requires `ALTER TABLE`.
   > - A blanket **`ALTER … TYPE`** rule would have fired on all **66** occurrences of `ALTER TYPE … ADD VALUE` — the enum-extension pattern `03-domain-layer.md` *requires* for every model emitting sys-events. The rule now requires `ALTER COLUMN`.
   >
   > Measured result after narrowing: **6 of 87 migrations trip the gate**, and `ADD VALUE` never fires. A rule that flags everything is a rule people rubber-stamp.

   **The override is an in-file annotation, not a PR label:**

   ```sql
   -- @expand-contract-reviewed: <why the running image survives this>
   ```

   Chosen deliberately over a label so the justification lives in git beside the SQL forever and appears in the diff that introduces it. A label is invisible six months later to whoever is reading the migration during an incident. This mirrors the existing `@allowedDirectPrisma <reason>` escape hatch on the controller-Prisma lint rule — same shape of problem, same shape of answer.

   This extends, rather than contradicts, the existing rule (`02-database-prisma.md`: never edit a committed migration, always roll forward). It makes expand/contract mechanical instead of cultural.

### 4.5 Registry — ECR (R4)

TASK-690 §4.1 already selected ECR. What that ticket does not specify, and this one does:

| Concern | Decision | Why |
|---|---|---|
| Repo layout | one ECR repo per `services.json` entry, plus `<name>/cache` | matches the existing `$REGISTRY/$CI_PROJECT_PATH/<svc>` shape, so `promote.sh` and the Kustomize `hope-v2/<svc>` keys survive |
| **Tag mutability** | **`IMMUTABLE`** | This is the exact defect [`publish.yml:161-168`](../../../.gitlab/ci/publish.yml) laments — "GitLab CE has no immutable container tags … a tag on this registry can be re-pushed to point at different bytes." ECR closes it with a checkbox. Sign by digest anyway; belt and braces. |
| Lifecycle | env tags: keep. `sha-*`: expire 90 d. untagged: expire 7 d. `*/cache`: expire 14 d | `--cache-to mode=max` on CUDA images grows fast and is billed per GB |
| Base images | **pull-through cache rules for `docker.io` and `ghcr.io`** | All 8 warm-up images live on those two upstreams. This **retires `warm-up-base-images` entirely** (C-5) and keeps multi-GB CUDA pulls in-VPC — which also serves TASK-690 R-5 (cold start) |
| Cross-account prod | `crane copy` (or `imagetools create`) the promoted digest into the prod account's ECR during `promote.yml` | prod's cluster then has **zero** read dependency on the non-prod account — completes R3 |
| Auth | OIDC → IAM → `aws-actions/amazon-ecr-login`; pods pull via node role/IRSA | no `imagePullSecret` to create, rotate, or leak per namespace |
| Layer cache | keep `--cache-to type=registry,mode=max` on the `<name>/cache` repo | **do not** use `type=gha` — 10 GB/repo cap, which the CUDA layers exceed immediately |
| TLS | delete the `http = true, insecure = true` buildkitd config (C-7) | |

**Signing activates here (C-2).** GitHub Actions' issuer *is* on public Fulcio's allow-list, so the 14 already-written `sign-*`/`sbom-*` jobs become live with `permissions: id-token: write`. Add `actions/attest-build-provenance` for SLSA. Then — for the first time — the Kyverno `verifyImages` policy in the deployment repo can be **enforced** rather than carried.

> **GHCR was considered and rejected for runtime images.** Every pod start would egress to `ghcr.io` through NAT, adding cost, latency, and a hard availability dependency on github.com for a PHI platform's recovery path — and it needs a rotating `imagePullSecret` per namespace. GHCR remains appropriate if public images are ever published.

### 4.6 Node packages (R5) — private GitHub Packages under `ArcaAI`

This lane is **not covered by TASK-690** and has the largest gap between assumed and actual state (C-1).

**Owner decision, 2026-08-13: every package publishes PRIVATE, to GitHub Packages, under `ArcaAI`.** That settles the registry question — GitHub Packages' lack of anonymous read stops being a drawback and becomes the point. `npmjs.com` is out of scope for this ticket.

#### 4.6.1 Three prep items the private + `ArcaAI` decision creates

None are hard; all three are silent failures if missed.

| # | Item | Current state | Action |
|---|---|---|---|
| **P-1** | **`publishConfig.access` says `"public"` on all 9 packages** | verified 2026-08-13 — every one of `vox`, `vox-node`, `room`, `stt`, `vad`, `noise-filter`, `med-ner`, `pipeline`, `vox-codegen` | Flip to `"restricted"`. Treat this as **defence in depth, not the control** — on GitHub Packages, visibility is ultimately governed by the package's own settings, so set both and let neither be load-bearing alone. Add a CI assertion that no publishable package carries `access: "public"`. |
| **P-2** | **Package ↔ repo linkage** | all 9 point at `ArcaAI/project-hope`; the monorepo's own remote is `arca/hope-v2` | If the GitHub target repo is **not** `project-hope`, `GITHUB_TOKEN` from that repo cannot publish these packages — it 403s, because the package is bound to a different repo. Resolve by either (a) landing the monorepo at `ArcaAI/project-hope`, or (b) updating `repository.url` **and** granting the new repo publish access in the org's package settings. See K-9. |
| **P-3** | **`npm publish --provenance` is not available** | previously recommended in this doc's first draft | Provenance is an **npmjs-registry feature**; it does not apply to GitHub Packages. Use **`actions/attest-build-provenance` on the packed tarball** instead — same guarantee, stored in GitHub's attestation store, and it works for private packages. Retracted from §4.5's sibling recommendation for images, which is unaffected (cosign covers those). |

#### 4.6.2 What private costs the consumer

Private is the right call for a PHI-adjacent SDK, but it is not free — it moves work onto every consumer, and that work has to be designed rather than discovered:

- **Every consumer needs an authenticated `.npmrc`**: `@arcaai:registry=https://npm.pkg.github.com/` plus a token line. There is no unauthenticated path, in CI or on a laptop.
- **In-org CI is easy**: `GITHUB_TOKEN` with `permissions: {packages: read}` works for repos in `ArcaAI`.
- **Everything else needs a real token.** A classic PAT with `read:packages` is the known-working path; **verify fine-grained PAT support before standardising on it** — GitHub Packages' fine-grained-PAT story has historically lagged, and this is worth a five-minute empirical check rather than a docs read.
- **⚠ External customers cannot read a private package without being granted access to it** — i.e. added to the `ArcaAI` org or given explicit package access. `@arcaai/vox-node` is documented as a customer-facing server SDK (`08-vox-sdk.md`). If customers are expected to `pnpm add` it, private GitHub Packages means onboarding each one with a GitHub identity and a grant. That is a viable model (it is how many commercial SDKs ship), but it is a **distribution decision with go-to-market consequences**, so it is recorded as **Q1** rather than assumed. It does not block lane D.
- **Already-published `2.0.x` versions were published `access: public`.** Confirm their current visibility in the org's package settings and decide whether to flip them; existing consumers with cached tarballs are unaffected either way. Do this before publishing `2.0.8`, so the family's visibility is uniform.

#### 4.6.3 Publishing mechanics

Replaces the dead `release-sdk` branch *and* the manual runbook:

```
.changeset/config.json
  linked:  [["@arcaai/vox","@arcaai/vox-node","@arcaai/room","@arcaai/stt",
             "@arcaai/vad","@arcaai/noise-filter","@arcaai/med-ner"]]
  ignore:  [api, database, domains, applications, ui, exceptions, logger,
            tools, types, utils, config-*, eslint-plugin-*, py-*, …]
```

`linked` reproduces the current practice exactly — all seven sit at `2.0.7` today and the runbook's for-loop bumps them together. `changesets/action` opens a "Version Packages" PR on the default branch; merging it publishes. Auth is `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` with `permissions: {contents: write, packages: write, id-token: write}` — **no PAT**.

Correctness gates this lane needs on day one, because the manual path had none:

- `pnpm --filter <pkg> check:exports` before publish (the `sdk-node:check:exports` script already exists).
- Publish order is dependency order — `vox` cannot resolve before `room`/`vad`/`stt`/`noise-filter` are on the registry. Changesets handles this; the manual runbook required a human to remember it.
- A **`repository.url` parity check** against the actual remote, run in CI. It has been wrong twice per [the SDK runbook](../../operations/vox-sdk-release/README.md), and under P-2 a wrong value is now a 403 rather than a cosmetic error.
- An **`access: "public"` assertion** (P-1) — a package that publishes public under a private-only policy cannot be un-published.
- A **consume-from-clean smoke test**: in a throwaway directory with only a token-authenticated `.npmrc`, `pnpm add @arcaai/vox@<new>` must succeed. This is the only check that exercises the consumer's path rather than the publisher's, and it is what would have caught C-1 years ago.

### 4.7 Version & release management (R6)

**Keep, unchanged:** the tag grammar (`<SVC>-M.m.p`, `ALL-M.m.p`), `version-grammar.ts` as the single code-side authority, `/app/build-info.json` as baked build identity, the `ServiceRelease` registry, and `0.0.0-<branch-slug>.<sha8>` for untagged builds. TASK-648 got this right and it is out of scope to relitigate.

**Change three things:**

| # | Change | Reason |
|---|---|---|
| V-1 | **Retire `vX.Y.Z` as the prod trigger.** Prod is reached by `promote.yml` dispatch + Environment approval (§4.3). | C-4 — the tag family's link to the release tag is convention-only and unenforced. Principle 2. |
| V-2 | **`services.json` becomes the authority for valid tag prefixes**, with a parity test against `SERVICE_TAG_PREFIXES`. | C-3 |
| V-3 | **Add `commitlint`** on Conventional Commits as a required PR check. | `versioning.md §1` already specifies a MAJOR-bump gate keyed on `BREAKING CHANGE:`/`feat!:` footers and calls it "a human judgment call" until the changelog generator ships. The generator cannot ship without enforced commit format. |

**Add:**

- `gh release create --generate-notes` on `ALL-` tags, giving the changelog a canonical home alongside the existing draft `ChangelogEntry` flow (`versioning.md §3.6`).
- **Do not** adopt release-please or Changesets for *service* versions. Services are versioned by deployed artifact; packages by semver contract. Changesets stays scoped to npm. Conflating the two is a known failure mode.

### 4.8 Runners

TASK-690 §6.4 recommends **AWS CodeBuild-hosted GitHub Actions runners**, with `actions-runner-controller` (ARC) as the cost-pressure alternative. Concur, with one refinement — the two are complementary, not exclusive:

| Tier | Runner | Why |
|---|---|---|
| lint / typecheck / unit tests | GitHub-hosted `ubuntu-latest` | free-tier friendly, no ops, no AWS auth needed |
| image builds (esp. CUDA) | **CodeBuild-hosted**, large disk, arm64-capable | GitHub-hosted runners have ~14 GB free — the CUDA build will not fit. IAM-native ECR access, per-minute billing, no idle cost |
| anything needing in-VPC reach | CodeBuild in the VPC, or ARC on the EKS cluster | see R-1 below |

**Ephemerality changes two existing assumptions.** Both must be handled explicitly:

- `warm-up-base-images` stops working (C-5) → ECR pull-through cache (§4.5).
- **Python jobs must use `uv`, not conda.** Every current `<svc>:test` script wraps `conda run -n arcaenv` (`06-python-services.md`); `arcaenv` does not exist on a fresh runner. Use `uv sync --frozen --package <svc>` against the root `uv.lock` — the same path the Dockerfiles already take. This also sidesteps the documented worktree failure mode where `arcaenv`'s editable installs resolve to the wrong checkout.

### 4.9 Caching (C-8)

| Layer | Mechanism | Expected win |
|---|---|---|
| pnpm store | `actions/cache` on `pnpm-lock.yaml` | minutes per job × ~15 jobs |
| **Turborepo remote cache** | self-hosted (`ducktors/turborepo-remote-cache`) on S3, or Vercel | TASK-690 §6.4: currently *every* `turbo build/lint/typecheck/test` runs stone cold |
| Docker layers | `type=registry,mode=max` → `<name>/cache` ECR repo | preserves current behaviour |
| Build matrix filtering | `dorny/paths-filter` → `services.json.paths` | TASK-690 §6.4 measures this at **~$370/month**, the single largest CI lever |

`turbo.json`'s `"cache": false` on `build` must be revisited as part of this — but only after confirming outputs are deterministic. Flipping it blindly on a monorepo with codegen (`db:generate`, `gen:model`) is how stale-artifact bugs enter.

---

## 5. Implementation Plan

Six lanes. **A–C are independent and can run in parallel; D is blocked on §0.2; E and F gate cutover.**

| Lane | Scope | Gate |
|---|---|---|
| **A — Foundations** | Org decision (§0.2); **rotate the leaked credentials** (TASK-690 §6.5 🚩 — a live GitLab token sits in plaintext in `bootstrap.dev.yaml`); create the GitHub App for deployment-repo writes; author `services.json` + the parity test; enable merge queue + branch protection | `services.json` ⟷ `SERVICE_TAG_PREFIXES` test green; no secret from the leak list reused |
| **B — CI parity** | `classify` job, `_test-node.yml`, `_test-python.yml` with **service containers** (postgres:18 + redis:8 — TASK-690 R-1), composite actions, path filters. Run alongside GitLab on the mirror and diff the effective job set per trigger. | Same pass/fail verdict as GitLab on 20 consecutive commits |
| **C — Build + registry** | ECR repos (IMMUTABLE) + lifecycle + pull-through cache; `_build-image.yml`; OIDC→IAM; **activate cosign + SBOM** (C-2); delete `warm-up-base-images`; CodeQL + Dependabot | One service (`nlp` or `guardrail` — small, fast, low blast radius) building to ECR, signed, scanned |
| **D — npm** | Install Changesets; `linked` config; `release-npm.yml`; **P-1/P-2/P-3 prep** (§4.6.1); the four correctness gates; **delete the broken `publish-sdk` job** | A real `2.0.8` published **private** from CI, and `pnpm add @arcaai/vox@2.0.8` succeeding in a clean directory with only a token `.npmrc` |
| **E — Promotion** | `promote.yml` + Environments + per-env IAM roles; port `promote.sh`; the 5 preconditions; **migration compatibility gate** (§4.4); cross-account copy | A staging promotion and a rejected-precondition prod promotion, both audited |
| **F — Cutover** | Remove the `dev-2.1` shim (C-6); flip build authority to GHA; archive GitLab CI; **delete the `github-backup` mirror job**; decommission the GitLab registry | Two weeks of GHA-only builds with no GitLab fallback |

**Sequencing constraint:** lane E cannot complete before TASK-690 P2 (the EKS landing zone) exists to promote *into*. Lanes A–D are independent of the AWS work entirely and should start now.

---

## 6. Verification Criteria

| Req | Evidence required at closure |
|---|---|
| R1 | A single service promoted to staging at a named version, with the approval record and the resulting deployment-repo commit linked |
| R2 | The migration gate demonstrably failing a PR carrying `DROP COLUMN`; no workflow in the repo contains `kubectl`, `helm upgrade`, or `argocd app sync` |
| R3 | A staging-scoped workflow run **failing** to assume the prod IAM role — the negative test, captured |
| R4 | An attempted re-push of an existing tag rejected by ECR; `cosign verify` green on a promoted digest; Kyverno `verifyImages` enforced |
| R5 | `pnpm add @arcaai/vox@<new>` succeeding in a clean directory whose only credential is a `read:packages` token — **and failing without one**, proving the package is genuinely private |
| R6 | `/api/v1/health` on a deployed pod reporting the real version from `/app/build-info.json` — closing the `0.1.0`-in-every-environment defect (`versioning.md §5`) |

---

## 7. Open Questions

| # | Question | Blocks | Default if unanswered |
|---|---|---|---|
| **Q1** | **What is the target repo NAME?** If not `ArcaAI/project-hope`, lane D needs the P-2 re-link (§4.6.1, K-9). *Sub-question:* are external customers expected to `pnpm add @arcaai/vox-node`? Private packages require granting each one org/package access (§4.6.2). | Lane D's *first publish*, not its authoring | assume `ArcaAI/project-hope`; treat external distribution as internal-only until told otherwise |
| Q2 | Does prod get a **separate AWS account**, or account-level separation only at the IAM-role level? (§4.3) | Lane E | separate account (recommended for PHI) |
| Q3 | Accept **V-1** — retiring `vX.Y.Z` as the prod trigger in favour of dispatch + approval? | Lane E | proceed with V-1 |
| Q4 | Confirm **change-filtered builds** as a deliberate behaviour change (today all 15 images rebuild on every push). TASK-690 §6.4 prices the current behaviour at ~$430/month. | Lane C | proceed with filtering |
| Q5 | Who holds **required-reviewer** rights on the `prod` Environment? | Lane E | owner only |
| Q6 | Is there an existing GitHub **org-level runner** budget, or does lane C provision CodeBuild? | Lane C | provision CodeBuild per TASK-690 §6.4 |

---

## 8. Risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| **K-1** | **Silent behaviour drift** translating `PIPELINE_TYPE` + `!reference` + `needs:optional` across ~90 jobs. A job that quietly stops running is invisible until something ships broken. | **Critical** | Lane B runs GHA and GitLab in parallel and **diffs the effective job set per trigger type** before cutover. This is TASK-690 R-2; the compensating control is §4.2's single `classify` job. |
| **K-2** | **Leaked credentials carried into GitHub Secrets.** A live GitLab token is in plaintext in the deployment repo today; CI scans working-tree only (`--no-git`), so history-resident leaks are invisible to the gate. | **Critical** | Rotation is lane A, **before** any secret lands in GitHub. Add `gitleaks --no-git=false` over full history as a one-time audit. |
| **K-3** | **CI tests target LAN-only Postgres `10.10.1.250` / Redis `10.10.1.120`**, unreachable from any cloud runner. | **Critical** | Service containers in `_test-python.yml`/`_test-node.yml`. TASK-690 R-1. |
| K-4 | **Promotion succeeds partially** — images re-tagged, manifest pin not pushed. `promote.sh` already handles this (registry tags land first, re-running is safe) but the failure mode survives the port. | High | Preserve the script's ordering and its "re-running this job is safe" guarantee verbatim; `concurrency` removes the racing cause |
| **K-9** | **Package ↔ repo linkage 403.** All 9 packages are bound to `ArcaAI/project-hope`; the monorepo's remote is `arca/hope-v2`. If the GitHub target repo is named anything else, `GITHUB_TOKEN` cannot publish them and the first release fails at the last step — after version bumps, tags, and a merged Version PR. | **High** | Answer Q1 before lane D's first publish. Mitigation if the name differs: update `repository.url` **and** grant the new repo publish access in the org package settings. Prove it with a `0.0.0-linkcheck` dry publish of a throwaway package before touching the real family. |
| K-5 | **Private-package access friction discovered after customers are onboarded.** A customer cannot read `@arcaai/vox-node` without an `ArcaAI` org or package grant. | Medium | Q1's sub-question. Not a blocker — a viable commercial model, but it must be a decision rather than a discovery |
| K-10 | **Already-published `2.0.x` versions went out with `access: "public"`.** The family's visibility may be non-uniform. | Medium | Audit visibility in org package settings before publishing `2.0.8` (§4.6.2) |
| K-6 | **`turbo.json` `"cache": true` flipped before outputs are deterministic**, producing stale artifacts from codegen packages. | Medium | Enable per-task, `database` last, with a cache-hit-vs-cold-build output diff |
| K-7 | **Changesets' first run bumps unexpectedly** — 9 packages, `linked` semantics, `workspace:*` rewrites. | Medium | Dry-run `changeset version` on a scratch branch and diff every `package.json` before lane D's first real publish |
| K-8 | **cosign activates and Kyverno starts rejecting unsigned images** already running. | Medium | Enable Kyverno in `Audit` mode first; flip to `Enforce` only after a full promotion cycle is signed end-to-end |

---

## 9. Implementation Summary

### 9.1 Landed 2026-08-13 — the locally-verifiable subset

Three items, chosen because they can be **proven today** without a GitHub repo, runners, OIDC or ECR, and because each is useful whether the migration lands next week or next quarter. No GitHub Actions workflows were written: they cannot be executed, and unverifiable YAML is where K-1 (silent behaviour drift) enters.

| File | Purpose |
|---|---|
| `.github/services.json` | §4.1 — the single service inventory. 14 services, 13 promotable. JSON has no comments, so the field contract lives in a `readme` key. |
| `tests/contracts/services-manifest.contract.test.ts` | Enforces the manifest against `build.yml`, `promote.sh`, and `version-grammar.ts`. **11 assertions, all bidirectional.** |
| `tests/contracts/npm-publish-policy.contract.test.ts` | §4.6.1 — P-1 (`access`), P-2 (repository binding), registry target, vox-family lockstep. **9 assertions.** |
| `scripts/check-migration-compat.ts` | §4.4 — the zero-downtime migration gate. Pure rules separated from git plumbing, mirroring `scripts/changelog-from-commits.ts`. |
| `scripts/__tests__/check-migration-compat.test.ts` | **24 assertions**, including explicit must-NOT-fire cases for both calibration narrowings. |
| 10 × `package.json` | P-1 — `publishConfig.access` `"public"` → `"restricted"`. |
| `package.json` (root) | `db:migrate:compat` script. |

### 9.2 Verification evidence

```
$ npx vitest run tests/contracts/ scripts/__tests__/
  Test Files  16 passed (16)
       Tests  271 passed (271)          # 44 new, 227 pre-existing — no regressions

$ npx tsc --noEmit --strict <all 4 new TS files>
  exit 0

$ pnpm db:migrate:compat --base HEAD
  migration-compat: no migration files in scope — nothing to check.   exit 0

$ npx tsx scripts/check-migration-compat.ts --all
  exit 1 — 6 blocked files / 87, 30 error findings, 0 false positives on ADD VALUE
  rule distribution: 339 non-concurrent-index (warn) · 14 drop-column ·
                     12 set-not-null · 2 drop-table · 2 alter-column-type
```

**Green-on-first-run was not accepted as evidence.** Both contract tests passed on their first execution, which for a parity test proves nothing — per `_karpathy.md` §4 and the TDD rule "if the test never failed, it verifies nothing." Each was mutation-tested by deliberately corrupting the thing it guards:

| Mutation | Caught |
|---|---|
| rename a service in the manifest | ✅ 2 assertions |
| add `ALL` to a `tagPrefixes` | ✅ |
| flip `database` to non-promotable | ✅ 2 assertions |
| change `guardrail`'s build target | ✅ |
| point a service at a non-existent Dockerfile | ✅ 2 assertions |
| drop the `TTS` prefix entirely | ✅ |
| empty `paths` on a service | ✅ |
| revert `@arcaai/vox` to `access: "public"` (the pre-ticket state) | ✅ 2 assertions |
| revert the `private: true` package to public | ✅ 2 assertions |
| point one package at a different repo (partial P-2 edit) | ✅ |
| point one package at a non-`ArcaAI` org | ✅ 2 assertions |
| switch one package's registry to npmjs | ✅ |
| drift one vox-family version | ✅ |

13/13 caught, manifest restored byte-identical afterwards. Three mutations initially reported "caught nothing" because the `perl` one-liner applying them choked on the `/` in URLs — the mutation never applied. Those were re-run with a working applier rather than counted as passes.

### 9.3 Findings from doing the work

1. **The §4.4 rule table as originally designed was wrong in two places**, and only measurement showed it — see the callout in §4.4. `RENAME` would have been 100 % false positives; `ALTER … TYPE` would have fired on 66 sanctioned enum extensions. The shipped rules are narrowed accordingly.

2. **A real bug in the escape hatch, caught by a must-fail test.** `REVIEW_ANNOTATION` used `\s*` after the colon; `\s` matches a newline, so a bare `-- @expand-contract-reviewed:` silently adopted the *next line* as its justification — turning the empty annotation someone types to quiet the gate into a passing one. Fixed to `[ \t]*(\S.*)`. This is exactly the case that only exists because the test asserted the negative.

3. **`config-ts` was a 10th package with the P-1 contradiction** — `access: "public"` under `private: true`. Flipped rather than exempted in the test: an exemption is a contradiction someone inherits.

4. **Warning volume buried the errors.** The first real `--all` run emitted 47 KB, ~339 per-occurrence index warnings on top of the 30 findings that matter. Warnings are now summarised one-line-per-file and capped at 10 (95 lines total). An advisory that hides the blocking output is worse than no advisory.

5. **V-3's premise needs a correction.** §4.7 says the changelog generator "cannot ship without enforced commit format." The generator **already exists** — `scripts/changelog-from-commits.ts`, including `assertBreakingRequiresMajorBump`, which throws when a breaking change ships without a MAJOR bump. What is missing is only the Conventional Commits enforcement feeding it. This *strengthens* V-3 (commitlint) rather than weakening it: the enforcement machinery is built and idle.

6. **The current `changes:` filters miss the shared Python packages.** No `.rules-*` anchor in `rules.yml` lists `packages/py-env`, `py-otel`, or `py-runtime-models`, so a change to the shared env loader rebuilds no Python service. `services.json` includes them, plus the lockfiles — a deliberate correction, called out here because it is a behaviour change, not a like-for-like port.

### 9.4 Not started

Lanes A (rotation, GitHub App, branch protection), B, C, E, F, and the authoring half of D. All gated on the repo existing on GitHub, except the credential rotation, which is gated on nothing and should not wait.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-13 | Initial solution design. Scoped as the execution detail for TASK-690 P5; explicitly defers AWS landing zone, GPU tier, and cost model to TASK-690, and version grammar to TASK-648. Adds two lanes TASK-690 does not cover: npm/GitHub Packages (§4.6) and release management on GHA (§4.7). Records 10 current-state defects (§2.2), of which C-1 (npm publishing non-functional) and C-4 (prod tag unenforced) are new findings. Status `Pending` — Q1 (GitHub org + SDK consumer) blocks lane D. |
| 2026-08-13 | **Design approved; first code landed.** Status → `In Progress`. Shipped the three locally-verifiable items: `.github/services.json` + its bidirectional contract test, the npm publish-policy contract test + the P-1 `access` flip across 10 packages, and `scripts/check-migration-compat.ts` + `pnpm db:migrate:compat`. 44 new assertions, 271/271 green, all mutation-tested (13/13 caught). §4.4's rule table rewritten against measured data — two originally-designed rules would have been ~100% false positives. Six findings recorded in §9.3, incl. a real bug in the escape-hatch regex caught by a must-fail test, and a correction to V-3's premise (the changelog generator already exists). |
| 2026-08-13 | **Owner decision: all npm packages publish PRIVATE to GitHub Packages under `ArcaAI`; `ArcaAI/project-hope` is the known-good release path.** §4.6 rewritten — the npmjs/public routing is withdrawn, and with it the `npm publish --provenance` recommendation (an npmjs-registry feature that does not apply to GitHub Packages; replaced by `actions/attest-build-provenance` on the tarball, P-3). §0.2 downgraded from blocker to open item. Three new prep items (P-1 `access: "public"` on all 9 packages contradicts the private policy; P-2 package↔repo linkage; P-3 provenance) and three new risks (**K-9** linkage 403 — the one genuinely new failure mode, since all 9 packages bind to `ArcaAI/project-hope` while the monorepo remote is `arca/hope-v2`; K-5 downgraded to Medium; K-10 non-uniform visibility of the existing `2.0.x` releases). Two new correctness gates: an `access` assertion and a consume-from-clean smoke test. |
