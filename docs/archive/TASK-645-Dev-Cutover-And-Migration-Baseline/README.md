# TASK-645 — Deployment review, migration squash, and `hope-v2-dev` clean cutover

**Status:** Pending (proposal — nothing destructive executed)
**Created:** 2026-08-09
**Type:** infrastructure
**Supersedes planning in:** `docs/implementation/TASK-644-Prisma-Migration-Baseline/` (see §6)

---

## 1. Requirement Analysis

Three asks from the owner:

1. **Argo/CI must never reset or reseed the database.** Establish a real migration
   practice for pipeline + GitOps deployment. Review the migration history; the current
   schema version becomes the new baseline.
2. **Fix the `promote-dev` job** in the `arca/hope-v2` pipeline.
3. **Cut off at this point and redeploy `hope-v2-dev` from scratch** — reset databases,
   clean pods, volumes, temp files, MinIO buckets for the HOPE apps. Infrastructure
   (TimescaleDB HA, Redis, MinIO, the external Vault cluster) is already up and is **not**
   to be rebuilt.

Owner decisions taken during review:

| Decision | Answer |
|---|---|
| In-cluster `hope-vault` StatefulSet | **Wipe it** (delete StatefulSet + 10Gi PVC, let Argo recreate empty, re-seed) |
| Databases to reset | **`vox-dev` (the app DB) + `temporal` + `temporal_visibility`** |
| Data carried by migrations | **Re-home into the seed** where the seed already covers it; bootstrap-critical rows stay in a migration (§3.3) |
| Execution posture | **Propose first, execute on approval** |
| MinIO `audio`, `tts-audio`, `langfuse` | **Leave untouched** (hope-v1 legacy) |
| `hope-ollama` (100Gi) and `hope-ui` | **Wipe both** — see the SMR blocker in §5 Scope |

Execution is broken into parallel agent workstreams in
[agent-workplan.md](./agent-workplan.md). That document is the operational contract; this
one is the analysis behind it.

---

## 2. Current State — verified findings

### 2.1 The whole Argo application is wedged by one pod

`hope-v2-dev` is the **only** Argo CD Application. It is `OutOfSync` / `Degraded`; the last
sync **Failed** after 3 retries (`e8947d6`).

Single cause:

```
Deployment hope-tts | status=Synced | hookPhase=Failed
  | msg= Deployment "hope-tts" exceeded its progress deadline
```

`hope-tts` has **every provider disabled** in its pod spec —
`TTS_KOKORO_ENABLED=false`, `TTS_AZURE_ENABLED=false`, `TTS_SARVAM_ENABLED=false`,
`TTS_PARLER_ENABLED=false`, `TTS_INDICF5_ENABLED=false` — so `/api/v1/health/ready`
returns 503 forever, the Deployment blows `progressDeadlineSeconds: 600`, and Argo marks
the sync Failed. **Nothing else in Git has been reaching the cluster since.** Roughly
11,300 `Unhealthy` events and 4,000 `FailedGetResourceMetric` HPA events have accumulated.

⚠ **Do not simply flip `TTS_KOKORO_ENABLED=true`.** The Deployment carries
`limits.memory: 1Gi`; measured Kokoro peak RSS is ~7.2 GB at concurrency 5 (TASK-642), and
the node is already ~95% committed. Flipping the flag alone converts a readiness failure
into an OOMKill loop.

### 2.2 Prune is off, and cannot simply be turned on

`syncPolicy: {"automated": {}}` — no `prune`, no `selfHeal`. Seven resources are live but
absent from Git and reported `PruneSkipped`:

| Resource | Why it is not in Git |
|---|---|
| `Service/hope-lmstudio` | **Deliberate** — moved to `deployment/k8s/out-of-band/` (`759d682`, `6704b93`) because a `commonLabels` selector injection broke it in the 2026-08-09 outage |
| `StatefulSet/hope-ollama` + `Service/hope-ollama` | Live-only; owns a **100Gi** model PVC |
| `Deployment/hope-ui` + `Service/hope-ui` | Deprecated `ui-playground`, still running `dev-66287e0f` |
| `ConfigMap/hope-config`, `ConfigMap/hope-smr-config-62ht876cm9` | Stale generator leftovers |

**Enabling `prune` today deletes the out-of-band LM Studio Service and the Ollama
StatefulSet.** Either adopt them into Git or keep prune off deliberately — this must be a
decision, not a default.

### 2.3 The `db-migrate` Job is structurally broken in the dev overlay

`deployment/k8s/base/db-migrate.yaml` declares the Job as a PreSync hook
(`argocd.argoproj.io/hook: PreSync`, `hook-delete-policy: BeforeHookCreation`,
`sync-wave: "-1"`). The dev overlay then **removes all three annotations**:

```yaml
- target: { kind: Job, name: hope-db-migrate }
  patch: |
    - op: remove
      path: /metadata/annotations/argocd.argoproj.io~1hook
    - op: remove
      path: /metadata/annotations/argocd.argoproj.io~1hook-delete-policy
    - op: remove
      path: /metadata/annotations/argocd.argoproj.io~1sync-wave
```

A plain `batch/v1` Job has an **immutable** `spec.template`. Every time the image tag
changes, Argo tries to patch it, Kubernetes rejects the patch, and the Job stays
`OutOfSync` permanently — which is exactly what the live status shows. That is why
migrations were run by hand instead, via the bare `db-migrate-manual` pod. **That pod ran
`prisma db push --force-reset`** on 2026-07-29 — the direct cause of the missing
`_prisma_migrations` table that TASK-644 later had to repair.

This is the single most important thing to fix for ask #1.

### 2.4 `promote-dev` — root cause

Pipeline #880, job 12746:

```
.gitlab/ci/promote.sh: line 43: DEPLOY_TOKEN: DEPLOY_TOKEN is required — a masked CI
variable holding a token with write_repository on the deployment repo, or Vault
deploy/DEPLOY_TOKEN once VAULT_ADDR is set
```

Everything before it is green: all 14 build jobs succeed, both scans pass, Vault is
correctly skipped (`VAULT_ADDR` empty). The job dies on the very first guard.

Two compounding traps behind it:

1. **`dev-2.1` is not a protected branch.** `GET /projects/6/protected_branches` returns
   only `main` and `release`. If `DEPLOY_TOKEN` is added as a **protected** CI variable it
   will not be exposed to this job and the failure will be byte-identical.
2. **The Vault fallback is also blocked.** `.gitlab/ci/vault.yml` documents the
   `hope-ci-deploy-dev` role with `"ref_protected": "true"` — which denies every
   `promote-*` job while `dev-*` is unprotected. The file already flags this as an
   OPEN ITEM.

**Not a defect:** every one of the 13 names in promote.sh's `SERVICES` list has a build job
with a matching `SERVICE_NAME` (verified against `.gitlab/ci/build.yml`), so nothing will
be silently skipped once the token exists.

Consequence of the outage: because `promote-dev` has never succeeded, the dev overlay's
`images:` block still carries **hand-edited floating tags** (`newTag: dev-715ac46b`)
instead of the `@sha256:` digests promote.sh is designed to write.

### 2.5 Migration history — live state

Verified directly against the Patroni leader (`db0`, 10.10.1.200):

| Fact | Value |
|---|---|
| App database | **`vox-dev`** (26 MB) — *not* `hope` (13 MB, stale/unused) |
| `public._prisma_migrations` | **80 rows, all `finished_at` set** |
| `core` tables | **87** |
| Temporal DBs | `temporal` (10 MB), `temporal_visibility` (10 MB) |

So TASK-644 **did execute successfully** — contrary to that ticket's own §1.1, which still
describes the pre-baseline state. The generated squash candidate produces **87 tables**,
matching live exactly.

### 2.6 Environment topology (verified)

| Component | Location |
|---|---|
| `hope-v2` cluster `c-nfhxq` | SSH host **`gpu`** (10.10.1.10); plain `kubectl` works as user `dell`, no sudo |
| Namespace | **`hope-v2-dev`** — single namespace holds app, Vault, Temporal, Qdrant, Ollama and the full observability stack |
| Postgres | External Patroni HA: `db0` leader, `db1` replica, `db2` sync standby; HAProxy `:5000` primary via VIP **10.10.1.250**; PgBouncer `:6432` |
| Redis / MinIO | External (`10.10.1.120`, `s3.taphuynh.dev` → `10.10.1.102:9000`, mc alias `homelab`) |
| Disk risk | `/mnt/data` on `gpu` is at **90%** (30 GB free); `models-cache` alone is 110 GB |

### 2.7 🔴 A second, unaudited writer to the cluster is still live

`deployment/argocd/bootstrap.dev.yaml` states the Argo CD Image Updater was
"REMOVED — decommissioned". **It was not.** Verified live on the management cluster:

```
deployment.apps/argocd-image-updater-controller   1/1   1   1   142d
configmap/argocd-image-updater-config             132d
secret/argocd-image-updater-secret                142d
crd/imageupdaters.argocd-image-updater.argoproj.io
```

It runs an update cycle every two minutes, holds cluster-wide
`get/list/patch/update/watch` on Argo `Application` objects, and carries a standing
Git-write PAT next to registry credentials — with no audit trail. It is inert **only by
two accidents**: its tag regex `^[0-9a-f]{7,40}$` does not match what CI publishes
(`dev-<sha8>`), and its write-back branch `dev` does not exist on the remote. Either
one-line drift turns it into a second writer racing `promote-dev`.

**Must be deleted before the cutover** — a from-scratch redeploy is exactly when tag
shapes and branch names change.

### 2.8 🔴 Two cold-bootstrap deadlocks — these will bite *this* cutover

The sync-wave order is:

```
PreSync  -1 : Job/hope-db-migrate            (dev: annotations stripped → wave 0)
Wave      0 : StatefulSet/hope-vault, StatefulSet/hope-qdrant,
              ALL app Deployments (api, smr, guardrail, stt-v2(+worker), tts,
              nlp, harness, harness-worker, admin-console, compat-playground),
              full observability stack
Wave      1 : Job/hope-vault-init (Sync hook), Job/hope-qdrant-init (Sync hook)
Wave      2 : Deployment/hope-temporal
Wave      3 : Deployment/hope-temporal-ui
PostSync  5 : Job/hope-smoke-test
```

Argo will not advance a wave until every resource in it is Synced **and Healthy**. That
makes two dependencies inverted:

1. **`hope-api` (wave 0) requires an unsealed Vault, which `hope-vault-init` only produces
   in wave 1.** `api.yaml:57-62` sets `SECRETS_PROVIDER=vault`; `SecretsModule.forRoot`
   performs a blocking AppRole login and secret warmup before NestJS providers construct,
   so `/api/v1/health/startup` never answers on a fresh, sealed Vault. Wave 0 never goes
   Healthy → wave 1 never runs → Vault is never unsealed. **This blocks the entire
   platform, and wiping `hope-vault-data` (an approved step) creates precisely this
   fresh-Vault condition.**
2. **`hope-harness-worker` (wave 0) hard-requires Temporal, which is wave 2.**
   `apps/harness/src/harness/temporal/worker.py:228` calls `get_temporal_client()` *before*
   the heartbeat task is created at line 260, so on an unreachable Temporal the process
   exits, the `startupProbe` file at `/tmp/harness-worker-heartbeat` is never written, and
   the Deployment never reports Available. Same wave-0-blocks-wave-2 shape.

Neither has fired yet only because Vault and Temporal have been continuously running from
earlier syncs. A namespace recreate removes that accident.

**Required fix before Phase D** — re-layer the waves so dependencies precede dependents:

| Wave | Resources |
|---|---|
| -4 | `StatefulSet/hope-vault`, `StatefulSet/hope-qdrant` |
| -3 | `Job/hope-vault-init`, `Job/hope-qdrant-init` (Sync hooks) |
| -2 | `Deployment/hope-temporal` |
| -1 | `Job/hope-db-migrate` (PreSync) |
| 0 | all app Deployments incl. `hope-harness-worker`, observability stack |
| 1 | `Deployment/hope-temporal-ui` |
| 5 | `Job/hope-smoke-test` (PostSync) |

Also add `activeDeadlineSeconds` to `hope-vault-init` and `hope-qdrant-init`. Neither has
one today, and `hope-vault-init`'s script is
`until wget -qO- "$VAULT_ADDR/v1/sys/health"; do sleep 3; done` — against a *sealed* Vault
that loop spins forever inside a single pod attempt, so `backoffLimit` never engages. This
is the same wedge shape as the `bitnami/kubectl` incident that blocked syncs for days.

### 2.9 🟠 Applying `application-dev.yaml` from Git will break Argo's Git access

Live `spec.project` is `hope-v2`; Git declares `hope-v2-dev` (the TASK-616 §F8 per-env
AppProject). The migration was attempted on 2026-08-08 and broke Git access in 4 seconds —
`failed to list refs: authentication required: HTTP Basic: Access denied` — because the Argo
repo-credential Secret `repo-820844053` is itself **scoped to the old `hope-v2` project**.
The field was reverted. A naive `kubectl apply -f application-dev.yaml` during the cutover
reproduces the outage. Unscope the credential first, verify, then repoint the project.

### 2.10 Other defects found

| Sev | Finding |
|---|---|
| 🔴 | **All three Secrets carry `kubectl.kubernetes.io/last-applied-configuration`**, which is *not* redacted by Kubernetes. All 31 credentials in `hope-secrets` — DB password, `JWT_SECRET_KEY`, `VAULT_TOKEN`, `VAULT_ROLE_ID`/`SECRET_ID`, Azure/HF/Sarvam keys — are readable in cleartext by any read-only viewer. Previously recorded (TASK-636), **still live**. |
| 🟠 | ~35 stale `Failed`/`Succeeded` pods never garbage-collected, back to April; root cause `ephemeral-storage` evictions on the single node |
| 🟠 | Orphaned PVCs `data-hope-postgres-0` (**100Gi**) and `data-hope-redis-0` (5Gi) — owning StatefulSets no longer exist |
| 🟠 | `commonLabels: {environment: dev}` in the dev overlay injects into **selectors** — the exact mechanism that broke `hope-lmstudio`. Kustomize deprecates this; use `labels: [{pairs: …, includeSelectors: false}]` |
| 🟡 | Duplicate `Secret/hope-registry-credsf` (typo of `hope-registry-creds`) |
| 🟡 | Leftover debug pods `db-migrate-manual`, `redis-temp` |
| 🟡 | Only `grafana` has an Ingress; the API, admin console and playground are NodePort-only (30088/30081/30082) |

---

## 3. Ask #1 — Database migration: the practice, and the squash

### 3.1 The rule

**Argo CD applies migrations. It never resets and never seeds.**

- `packages/database/migrate.sh` is already correct: it always runs `prisma migrate deploy`
  (the old `NODE_ENV`-switched `db push` branch was removed in TASK-616), and seeding is
  opt-in via `RUN_SEED`, defaulting to `none`.
- The dev overlay already pins `RUN_SEED=none` (`e8947d6`). Keep it.
- `prisma db push` and `migrate reset` are **local-development-only** tools. The one time
  `db push --force-reset` was run against the cluster it destroyed the migration history
  and cost a full baselining exercise.

### 3.2 Fix the Job so migrations actually run on every sync

Restore the PreSync hook in the dev overlay — **delete the annotation-removal patch** in
`deployment/k8s/overlays/dev/kustomization.yaml` — and harden the base:

```yaml
# deployment/k8s/base/db-migrate.yaml
metadata:
  name: hope-db-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
    # Delete the previous run at the moment a new one is created, so the Job
    # name can be reused and its immutable spec is never patched in place.
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
    argocd.argoproj.io/sync-wave: "-1"
spec:
  backoffLimit: 3
  activeDeadlineSeconds: 900   # ADD — a hung migration must fail, not wedge the sync
  ttlSecondsAfterFinished: 3600
```

`BeforeHookCreation` is what makes a hook Job safe: Argo deletes the old object before
creating the new one, so the immutability problem in §2.3 disappears. `activeDeadlineSeconds`
is the guard against the failure mode this cluster has already suffered — a wave-1 hook that
never terminates blocks every subsequent sync.

Two further requirements:

- **`hope-db-migrate` must not use a floating tag.** It is pinned by promote.sh
  (`hope-v2/database`), which only works once §4 is fixed. Until then the PreSync hook runs
  whatever `dev-715ac46b` currently points at.
- **The migration image and the repo must agree.** TASK-644's most valuable lesson: run
  `migrate resolve`/`deploy` from *inside the deployed image*, never from a working tree, so
  the migration file set and Prisma version that compute the checksums are the ones that ship.

### 3.3 The squash

**Verdict: squash, and do it as part of this cutover.** The window is free precisely because
the database is being reset anyway — the reset drops `_prisma_migrations` along with
everything else, so the trivial path applies and the checksum one-way door never has to be
forced open.

Why the history is not worth keeping as a replayable spec:

- 30 `DROP COLUMN`s across 15 tables (`task_369_phase6_drop_plaintext_phi_columns`)
- 2 `DROP TABLE`s (`task_576`), plus an earlier `INSERT … SELECT` (`task_569`) that reads
  those very tables — vacuous forever
- a `DROP TYPE` + rename enum swap (`task_367`)
- `ADD COLUMN nullable → backfill → SET NOT NULL` triads whose middle step is meaningless
  on an empty database
- an entire migration (`task_615_reconcile_dbpush_drift`) whose only job is reconciling
  `db push` naming against migration naming — obsolete the moment we squash

Only the *full* replay is meaningful, and git preserves that perfectly.

**Generated baseline** (`prisma migrate diff --from-empty --to-schema … --script`, Prisma 7
— note `--to-schema-datamodel` was renamed): 3,362 lines — 1 `CREATE SCHEMA`, 1
`CREATE EXTENSION vector`, 55 `CREATE TYPE`, **87 `CREATE TABLE`** (matches live), 292
indexes, 55 FK constraints, **zero** `INSERT`, **zero** partial indexes, **zero** `REVOKE`.

#### 3.3.1 Four things the generator loses — hand-append all four

**(a) The one partial unique index** — `20260413000000_add_user_voice_profile`:

```sql
CREATE UNIQUE INDEX "UserVoiceProfile_userId_active_unique"
    ON "core"."UserVoiceProfile"("userId")
    WHERE "isActive" = true AND "resourceStatus" = 'ENABLED';
```

Prisma's schema language cannot express a partial index at any version. This index is
**already missing from the live database** (`db push` never created it), so "at most one
active voice profile per user" is currently unenforced. Folding it into the baseline turns
the squash into a net fix and removes the need for TASK-644's planned Phase-4 migration.
Pre-checked: 0 conflicting rows.

**(b) Three WORM privilege blocks — a live HIPAA control.** From
`task_330_add_clinical_harness_eval_and_worm_audit`, `task_330_phase6_harness_policy` and
`task_356_phase5_pipeline_policy`:

```sql
DO $worm$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hope_app_template') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "core"."PipelinePolicyChange" FROM hope_app_template';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hope_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "core"."PipelinePolicyChange" FROM hope_app';
  END IF;
END
$worm$;
```

This one is dangerous to lose silently. `manual/vault-admin-bootstrap.sql` sets
`ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT, INSERT, UPDATE, DELETE … TO
hope_app_template`, so **every newly created `core` table auto-grants UPDATE and DELETE to
the role the app inherits**. Without these blocks the three append-only audit tables come up
mutable and deletable, with no error and no diff.

⚠ **Ordering trap:** the `REVOKE`s are role-existence-guarded. `manual/vault-admin-bootstrap.sql`
must run **before** the baseline, or they silently no-op and the migration still reports success.

**(c) `CREATE EXTENSION vectorscale CASCADE`** — present in the history, absent from the
datamodel's `extensions` array, and **never actually installed** (live DB has only `plpgsql`
and `vector 0.8.2`). Decide explicitly: add it to the datasource `extensions` list, or delete
it and record that it is dead. Do not let it disappear by accident.

**(d) Two bootstrap data sets** — see §3.3.2.

Everything else you might worry about is genuinely absent from all 81 files: no triggers,
functions, views, materialised views, rules, CHECK/EXCLUDE constraints, deferrable FKs, RLS
policies, sequences, comments, collations, generated columns, `CONCURRENTLY`, index storage
parameters, or GIN/GIST/HNSW/ivfflat indexes. (Notably `UserVoiceProfile.embedding` is
`Unsupported("vector(256)")` with **no ANN index anywhere** — pre-existing, not a squash loss.)

**Enum parity: green.** Replaying every `CREATE TYPE` / `ALTER TYPE … ADD VALUE` /
`RENAME` / `DROP TYPE` yields a union identical to the current `.prisma` declarations, for
every enum. `ResourceType` is 56 values in `audit.prisma` and 56 in
`packages/domains/src/enums/generated/ResourceType.ts` — symmetric difference empty, so
`resourceType.enum-parity.test.ts` stays satisfied.

#### 3.3.2 Data carried by migrations — 17 sites, 2 genuine losses

Fifteen of the seventeen `INSERT`/`UPDATE`/`DELETE` sites are **vacuous on a fresh
database** (they repair existing rows, or are gated on `WHERE EXISTS` against rows a clean
seed never creates), or are **already covered by the seed**:

> GEN Department (`seed/04-department.ts:18,399`) · UserDepartment (`seed/91-user.ts`) ·
> GLOBAL_ADMIN role (`seed/03-role.ts:93`) · APPROVED prompt statuses
> (`seed/07-prompt-template.ts:22`) · `approvedVersionNumber` pinning (`07b:27`, `07d:132`) ·
> SYSTEM-owned pre-summary default (`07d:120,152`) · `sourceTemplateSlug`/`templateLocked`
> (`seed/06-stt.ts:1166`) · `sarvam-saaras-v4 format: SARVAM` (`seed/ai-models/audio.ts:149`) ·
> SYSTEM PipelinePolicy default (`seed/14-pipeline-policy.ts:152`)

**Two must NOT go to the seed**, because the seed is opt-in and fails closed
(`RUN_SEED` unset → `none` → `migrate.sh` never opens a connection). These are the rows the
platform cannot boot without, and today a *migration* is what guarantees them in every
environment:

1. **The SYSTEM tenant row** `00000000-0000-0000-0000-000000000000` / key `__SYSTEM__`
   (from `task_305_phase_a`). It is the sentinel the entire tenant-scope client extension
   depends on.
2. **Six SYSTEM loopback `TenantAllowedOrigin` rows** (from `task_641`). Since
   `enforcementEnabled` now defaults TRUE and the `NODE_ENV === 'development'` loopback
   branch was deleted from `apps/api/src/cors.config.ts`, an environment without these rows
   **refuses every browser origin including localhost, recoverable only by direct database
   access.** That migration's own header states this and names the SYSTEM tenant as its
   precedent.

→ Ship them as a **companion data migration**, keeping the baseline a pure, regenerable
`migrate diff` product:

```
migrations/20260810000000_task_645_squashed_baseline/migration.sql      # generated + 3 hand-appends
migrations/20260810000100_task_645_bootstrap_system_rows/migration.sql  # 2 INSERT … ON CONFLICT DO NOTHING
```

`migration_lock.toml` is unchanged.

#### 3.3.3 Tests and docs that must ship with the squash

Three tests read specific migration folders by name and will break:

| Test | Reads |
|---|---|
| `packages/database/src/__tests__/phase-f-backfill-migration.test.ts:27,43` | `20260602010000_task_305_phase_f_…` |
| `packages/database/src/__tests__/pipeline-template-lineage-migration.test.ts:22,35` | `20260720140100_task_531_…` — **this is a drift gate**: it asserts the inlined 9-slug array set-equals `ASR_TEMPLATE_SLUGS` (`seed/06-stt.ts:1154`). Retarget it at the seed constant rather than deleting it. |
| `packages/database/src/__tests__/role-consolidation-migration.test.ts:26,38` | `20260705000000_task_417_…` |

Also update the migration-path comment in
`packages/applications/src/services/origin-registry/__tests__/loopback-bootstrap-origins.task641.test.ts`,
re-run `packages/database/tests/pgbouncer-validation/__tests__/06-prisma-migrate.test.ts`,
and append a Change History entry to TASK-644 recording the pivot from
baseline-and-keep-history to squash-and-reset.

#### 3.3.4 If a database ever must be squashed *without* a reset

Not needed for this cutover — recorded because it will be needed for staging/prod later.
Order is not negotiable:

```bash
# 1. Prove the DB already equals the squash point (empty output, modulo the
#    partial index and privileges, which migrate diff cannot see).
prisma migrate diff --from-url "$DIRECT_URL" --to-schema packages/database/src/prisma/db_main --script
# 2. pg_dump -Fc AND verify with pg_restore --list. Step 4 has no undo.
# 3. IN GIT FIRST: replace the folders, build and promote the image. Checksums are
#    computed from the file the CLI sees at that instant — it must be the shipped file.
# 4. psql "$DIRECT_URL" -c 'BEGIN; DELETE FROM "_prisma_migrations"; COMMIT;'
# 5. prisma migrate resolve --applied 20260810000000_task_645_squashed_baseline
# 6. prisma migrate status   # MUST print "Database schema is up to date!"
```

Step 4 before 5, because a leftover row naming a folder that no longer exists on disk makes
`migrate deploy` fail permanently. Step 3 before 4 and 5, because resolve records the SHA of
the file as it exists at that moment.

---

## 4. Ask #2 — Fixing `promote-dev`

Three changes, in this order. **The first requires the owner** — I will not mint or store a
write-capable credential.

### 4.1 Owner action — create the token and the CI variable

1. `arca/hope-v2-deployment` → **Settings → Access Tokens** → new **Project Access Token**
   - role `Maintainer`, scope **`write_repository`** (`api` is not needed)
   - no expiry longer than your rotation policy
2. `arca/hope-v2` → **Settings → CI/CD → Variables** → add
   - key `DEPLOY_TOKEN`, value = the token, **Masked: yes**
   - **Protected: yes** — *only after* §4.2 lands. If `dev-*` is not protected, this must be
     **Protected: no** or the job fails identically.
3. If GitLab assigns the token a fixed username, also add `DEPLOY_TOKEN_USERNAME`
   (unmasked). promote.sh already anticipates this and defaults to `gitlab-ci-token`, which
   works for personal/project access tokens but is rejected for deploy tokens.

### 4.2 Protect the deploy branch patterns

Add protected-branch rules for `dev-*` and `staging-*` (push+merge = Maintainer). This is
the documented intended end state in `.gitlab/ci/vault.yml` (§F10/§F12) and does three
things at once: it lets `DEPLOY_TOKEN` be a *protected* variable, it makes the
`ref_protected: "true"` claim on the `hope-ci-deploy-dev` Vault role satisfiable, and it
stops an arbitrary branch from minting deploy credentials. I can apply this via the GitLab
API on your word.

### 4.3 Manifest/CI hardening (I can prepare these now)

- `deployment/k8s/base/db-migrate.yaml` — add `activeDeadlineSeconds: 900` (§3.2)
- `deployment/k8s/overlays/dev/kustomization.yaml` — drop the hook-annotation-removal patch (§3.2)
- Replace `commonLabels` with the non-selector-injecting `labels:` form (§2.7)
- After the first successful `promote-dev`, the overlay's `images:` block flips from
  `newTag: dev-<sha8>` to `@sha256:` digests automatically — no manual edit needed

### 4.4 Verification

Re-run `promote-dev` on `dev-2.1` and confirm: 13 `COPY` lines (no `SKIP`), a commit landing
on `hope-v2-deployment@main`, and Argo picking up digest-pinned images.

---

## 5. Ask #3 — `hope-v2-dev` clean cutover runbook

**Nothing below has been executed.** Approval gates every step from C1 onward.

### Scope

| In scope (destroyed) | Out of scope (untouched) |
|---|---|
| Namespace `hope-v2-dev` contents: api, stt(+worker), smr, nlp, tts, guardrail, harness(+worker), admin-console, compat-playground, temporal, temporal-ui, vault, qdrant, reranker, observability stack | TimescaleDB HA cluster itself (Patroni/HAProxy/PgBouncer) |
| PVCs in that namespace, incl. `hope-vault-data` and the two orphans (105Gi) | Redis cluster |
| Databases `vox-dev`, `temporal`, `temporal_visibility` | Databases `hope`, `hope-staging`, `langfuse`, `vox_staging` |
| MinIO buckets `hope-attachments-*`, `hope-audio*`, `hope-recordings-*`, `hope-loki-logs`, `hope-tempo-traces` | **`gitlab-*` (12 buckets), `pgbackrest`, `vault-backups`** |
| Stale pods, failed Jobs, dead ReplicaSets, debug pods | `hope-v1` cluster (`c-9lwv8`), Rancher `local` cluster, `hope-v2-prod` namespace |
| | `Service/hope-lmstudio` + its Endpoints (out-of-band, hand-managed) |

**Open question before execution:** `audio`, `tts-audio` and `langfuse` MinIO buckets do not
follow the `hope-*` convention and are probably hope-v1 legacy. Confirm before touching, or
they stay.

**Also confirm:** `hope-ollama` (100Gi model cache) and `hope-ui` (deprecated playground) are
live-only, not in Git. Wipe, keep, or adopt into Git?

### Phase A — Prepare (non-destructive, can run now)

- A1. Land the squashed baseline + companion data migration + test updates in `hope-v2`
- A2. Land the manifest fixes (§4.3) in `hope-v2-deployment`
- A3. Decide and land the `hope-tts` fix — either `replicas: 0` in the dev overlay until
  TASK-642's memory budget is resolved, or Kokoro enabled **with `limits.memory` raised to
  ≥8Gi**, which the node cannot currently absorb alongside Ollama. Recommend `replicas: 0`
  for the cutover so the sync can go green.
- A4. Owner creates `DEPLOY_TOKEN` (§4.1); protect `dev-*` (§4.2)
- A5. **Re-layer the sync waves per §2.8** and add `activeDeadlineSeconds` to
  `hope-vault-init` and `hope-qdrant-init`. Non-optional — without it the cold bootstrap
  in Phase D deadlocks on a freshly wiped Vault.
- A6. **Delete the Argo CD Image Updater** (§2.7): the Deployment, its ConfigMaps, its
  Secret, and the `ImageUpdater` CR + CRD, in the `argocd` namespace on the management
  cluster. Rotate the Git PAT it held.
- A7. Green pipeline on `dev-2.1` **including** `promote-dev`

### Phase B — Backup (mandatory, non-destructive)

- B1. `pg_dump -Fc` of `vox-dev`, `temporal`, `temporal_visibility`; verify each with
  `pg_restore --list`
- B2. `mc mirror` the HOPE buckets to a dated prefix, or confirm pgbackrest/`vault-backups`
  coverage is sufficient and accept the loss
- B3. Export the current `hope-secrets` key set (values are needed to rebuild it)
- B4. `kubectl get all,cm,secret,pvc -n hope-v2-dev -o yaml` snapshot to disk

### Phase C — Teardown (destructive — **approval required**)

- C1. Disable Argo auto-sync on `hope-v2-dev` (prevents a mid-teardown re-create)
- C2. Delete all HOPE Deployments/StatefulSets/Jobs in the namespace; delete stale/failed
  pods, dead ReplicaSets, `db-migrate-manual`, `redis-temp`
- C3. Delete PVCs: all namespace PVCs including `hope-vault-data`, plus the orphaned
  `data-hope-postgres-0` (100Gi) and `data-hope-redis-0` (5Gi). Reclaims ~105Gi of the
  90%-full `/mnt/data`.
- C4. Delete stale ConfigMaps/Secrets: `hope-config`, `hope-smr-config-62ht876cm9`,
  `hope-registry-credsf`
- C5. Drop and recreate `vox-dev`, `temporal`, `temporal_visibility` on the Patroni leader
- C6. Empty the HOPE MinIO buckets (`mc rm --recursive --force`), leaving the buckets in
  place. **Never** touch `gitlab-*`, `pgbackrest`, `vault-backups`.
- C7. Prune unused container images on `gpu` to recover `/mnt/data`

### Phase D — Rebuild

- D1. Recreate `hope-registry-creds` and `hope-secrets` **without** the plaintext annotation:
  use `kubectl create secret … --save-config=false` or `kubectl apply --server-side`, never
  plain `kubectl apply`. **Rotate every credential in the process** — they have been readable
  in cleartext (§2.7).
- D2. Run `manual/vault-admin-bootstrap.sql` as superuser **before** any migration, so the
  `hope_app_template` / `hope_app` roles exist and the WORM `REVOKE`s bind (§3.3.1b).
- D3. Re-apply the out-of-band `deployment/k8s/out-of-band/lmstudio-*.yaml`. Also re-apply
  the GPU time-slicing ConfigMap + ClusterPolicy patch (`base/gpu-time-slicing.yaml`,
  deliberately outside the kustomize tree because it targets the `gpu-operator`
  namespace) — leaving it un-activated has already caused a scheduling deadlock once.
- D3a. If `spec.project` is to move to `hope-v2-dev`, unscope the Argo repo credential
  `repo-820844053` **first**, verify Git access, then repoint — see §2.9. Otherwise leave
  the live Application's project alone.
- D4. Re-enable Argo auto-sync and let the PreSync `hope-db-migrate` Job apply the baseline
  + companion migration on an empty database
- D5. Seed **once, by hand**, deliberately: `RUN_SEED=all NODE_ENV=development` for a
  one-off invocation. Do **not** restore `RUN_SEED` in the overlay.
- D6. Re-initialise Vault (new unseal keys, AppRole re-issue), re-seed platform secrets via
  `scripts/vault-seed-secrets.sh`
- D7. Qdrant collections via the `qdrant-init` PreSync Job

### Phase E — Verify

- E1. `prisma migrate status` → "Database schema is up to date!"
- E2. `migrate diff --from-migrations … --to-schema … --exit-code` → 0
- E3. WORM guard against the live DB:
  `pnpm --filter @arcaai/database exec vitest run --config vitest.worm.config.ts` — this is
  the only automated proof the privilege revocations landed, and it self-skips when no DB is
  reachable, so confirm it actually ran
- E4. Argo `hope-v2-dev` → `Synced` + `Healthy` (the first time in weeks)
- E5. All service `/health/ready` endpoints 200
- E6. One end-to-end consultation: audio → STT → SMR summary → usage ledger row

---

## 6. Relationship to TASK-644

TASK-644 baselined the database in place and preserved all data. That work is what made the
current state legible, and its lesson — run migration commands **from inside the deployed
image** so the file set and Prisma version match — carries forward into §3.2.

Squashing supersedes three parts of it: §2.4's 70/11 classification, §4.2's resolve loop, and
§4.5's planned Phase-4 partial-index migration (folded into the baseline instead). Its §1.1
also now describes a state that no longer exists — the live database has 80 recorded
migrations. Append a Change History entry there rather than leaving a stale plan in
`docs/implementation/`.

---

## 7. Implementation Summary

*Empty — nothing executed. Awaiting approval of §5 Phase C onward.*

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-09 | Ticket created. Review completed; cutover runbook proposed. No destructive action taken. |
