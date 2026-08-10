# TASK-645 — Parallel agent work plan

Operational contract for executing TASK-645. Analysis and evidence live in
[README.md](./README.md); **read it before starting any workstream.**

**Status:** Phase A/B releasable. **Phase C (teardown) and beyond are GATED on explicit
owner approval and must not be started without it.**

---

## 0. Universal guardrails — every agent, every workstream

These are not advisory. A violation destroys data that is not recoverable from this repo.

### Never touch

| Thing | Why |
|---|---|
| MinIO buckets `gitlab-*` (12), `pgbackrest`, `vault-backups` | GitLab's own storage and the database backup target. Destroying `pgbackrest` removes the only PITR path for the Patroni cluster. |
| MinIO buckets `audio`, `tts-audio`, `langfuse` | Owner decision: hope-v1 legacy, **leave untouched**. |
| Databases `hope`, `hope-staging`, `langfuse`, `vox_staging` | Not ours. The app DB is **`vox-dev`**. |
| Cluster `c-9lwv8` (hope-v1) and Rancher `local` (`c-nfhxq` is the only target) | Different product. |
| Namespace `hope-v2-prod` | Empty placeholder; out of scope. |
| The Patroni/HAProxy/PgBouncer stack itself, Redis, the MinIO server | Infrastructure is declared ready and is not being rebuilt. |

### Always

- **Read-only until your workstream explicitly says otherwise.** State in your report every
  mutating command you ran.
- **`kubectl` on the target cluster runs from SSH host `gpu`** (`ssh gpu kubectl …`), as user
  `dell`, no sudo. The Rancher MCP has `--disable-destructive=true`, so deletes must go
  through SSH.
- **macOS has no `timeout`.** Use `ssh -o ConnectTimeout=8 -o BatchMode=yes`.
- **Never print a credential value** in a report, commit, or log. Names and key lists only.
- **Never `git push`** unless your workstream names it. Commit locally; the owner pushes.
- **Never run `prisma db push`, `migrate reset`, or `migrate dev` against any cluster
  database.** Those are local-development-only. One prior `db push --force-reset` against
  the cluster is the reason this ticket exists.
- **Concurrency hazard:** several agents work in the same two git repos. Stage your changes
  (`git add`) as soon as they are written — a parallel session has previously reverted
  unstaged edits and deleted untracked files in this repo.
- If a step's precondition is not what this document says it is, **stop and report**. Do not
  improvise around a surprise in a destructive workstream.

### Repos and hosts

| Alias | Meaning |
|---|---|
| `APP_REPO` | `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2` (branch `dev-2.1`) |
| `DEPLOY_REPO` | `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-deployment` (branch `main`) |
| `gpu` | SSH host = the `c-nfhxq` / hope-v2 cluster node, 10.10.1.10 |
| `master` | SSH host = Rancher management cluster (Argo CD lives here) |
| `db0` | Patroni **leader**, 10.10.1.200. `docker exec patroni psql -U postgres …` |
| `minio` | Host with `mc` configured; alias **`homelab`** → `https://10.10.1.102:9000` |

---

## 1. Workstream map

```
        ┌─ WS-1  Migration squash ─────────────┐
        ├─ WS-2  Manifest fixes ───────────────┤
 PHASE  ├─ WS-3  TTS unblock ──────────────────┤
   A    ├─ WS-4  promote-dev / CI ─────────────┤──┐
        ├─ WS-5  Image Updater decommission ───┤  │
        └─ WS-6  Backups + snapshot ───────────┘  │
                                                  │
              WS-7  Shadow rehearsal ◄────────────┘   (needs WS-1 + WS-6)
                            │
              ══════════ OWNER APPROVAL GATE ══════════
                            │
              WS-8  Teardown  (destructive)
                            │
              WS-9  Rebuild + bootstrap
                            │
              WS-10 Verification
                            │
              WS-11 Documentation close-out
```

WS-1 through WS-6 are **fully parallel**. WS-7 joins WS-1 and WS-6. WS-8 onward are strictly
serial and gated.

| WS | Title | Tier | Model | Effort | Writes? |
|---|---|---|---|---|---|
| 1 | Migration squash | Very high | `opus` (opus-5) | max | APP_REPO |
| 2 | Manifest + sync-wave fixes | Complex | `opus` (opus-4-8) | high | DEPLOY_REPO |
| 3 | TTS unblock | Moderate | `sonnet` | medium | DEPLOY_REPO |
| 4 | promote-dev / CI | Moderate | `sonnet` | medium | GitLab config |
| 5 | Image Updater decommission | Moderate | `sonnet` | medium | mgmt cluster |
| 6 | Backups + snapshot | Moderate | `sonnet` | medium | scratch only |
| 7 | Shadow rehearsal | Complex | `opus` (opus-4-8) | high | scratch DB only |
| 8 | Teardown | Very high | `opus` (opus-5) | max | **DESTRUCTIVE** |
| 9 | Rebuild + bootstrap | Complex | `opus` (opus-4-8) | high | cluster |
| 10 | Verification | Moderate | `sonnet` | medium | read-only |
| 11 | Docs close-out | Trivial | `haiku` | default | APP_REPO docs |

---

## WS-1 — Migration squash *(opus-5, max)*

**Repo:** APP_REPO. **Parallel-safe.** Touches only `packages/database/**` and its tests.

### Deliverables

1. `packages/database/src/prisma/db_main/migrations/20260810000000_task_645_squashed_baseline/migration.sql`

   Generate with (note the Prisma 7 flag rename — `--to-schema-datamodel` no longer exists):

   ```bash
   node packages/database/node_modules/prisma/build/index.js migrate diff \
     --from-empty --to-schema packages/database/src/prisma/db_main --script
   ```

   Expected shape, verify before proceeding: 3,362 lines · 1 `CREATE SCHEMA` ·
   1 `CREATE EXTENSION vector` · 55 `CREATE TYPE` · **87 `CREATE TABLE`** · 292 indexes ·
   55 FK constraints · **0 `INSERT`** · **0 partial indexes**. The 87 must match the live
   `core` table count — that is the parity gate.

   Then hand-append, in this order, each with a comment naming the migration it came from:

   - after `CREATE EXTENSION`: `CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;` —
     **or** delete it and record the decision. It is in the history, absent from the
     datamodel's `extensions` array, and has never been installed. Do not let it vanish
     silently; put the decision in the ticket.
   - after all `CREATE TABLE`: the **three WORM `DO $worm$` blocks** verbatim from
     `20260606143138_task_330_…:205-215`, `20260607120000_task_330_phase6_…:74-84`,
     `20260615120000_task_356_phase5_…:72-82`, covering `HarnessAuditEvent`,
     `HarnessPolicyChange`, `PipelinePolicyChange`.
   - after all `CREATE INDEX`: the partial unique index from
     `20260413000000_add_user_voice_profile:40-42`
     (`UserVoiceProfile_userId_active_unique … WHERE "isActive" = true AND "resourceStatus" = 'ENABLED'`).

2. `…/migrations/20260810000100_task_645_bootstrap_system_rows/migration.sql` — verbatim
   copies of the SYSTEM `Tenant` insert (`20260527000000_task_305_phase_a:64-76`) and the
   six loopback `TenantAllowedOrigin` rows (`20260808160000_task_641:84-169`), both
   `ON CONFLICT … DO NOTHING`. Keep these **out** of the baseline so the baseline stays a
   pure, regenerable `migrate diff` product.

3. Delete the 80 superseded migration folders. **Keep `migration_lock.toml` unchanged.**

4. Fix the three tests that read migration folders by name:
   - `packages/database/src/__tests__/phase-f-backfill-migration.test.ts:27,43`
   - `packages/database/src/__tests__/role-consolidation-migration.test.ts:26,38`
   - `packages/database/src/__tests__/pipeline-template-lineage-migration.test.ts:22,35` —
     **retarget, do not delete.** It is a live drift gate asserting the 9-slug array
     set-equals `ASR_TEMPLATE_SLUGS` (`seed/06-stt.ts:1154`). Point it at the seed constant.
   - Update the migration-path comment in
     `packages/applications/src/services/origin-registry/__tests__/loopback-bootstrap-origins.task641.test.ts`.

### Do not

- Do not move the SYSTEM tenant or loopback origin rows into the seed. The seed is opt-in
  and fails closed (`RUN_SEED` unset → `none` → no connection opened). Without those rows
  the API refuses every browser origin including localhost.
- Do not run any `prisma` command that writes to a database.

### Gate

`pnpm --filter @arcaai/database test` and `pnpm --filter @arcaai/database build` green;
paste output. Report the `vectorscale` decision explicitly.

---

## WS-2 — Manifest and sync-wave fixes *(opus-4-8, high)*

**Repo:** DEPLOY_REPO. **Parallel-safe** — but coordinate with WS-3, which edits the same
`overlays/dev/kustomization.yaml`. Agree a split: WS-2 owns waves/base, WS-3 owns the TTS
patch block.

### Deliverables

1. **Re-layer the sync waves** (README §2.8). Two cold-bootstrap deadlocks must be gone
   before a wiped Vault comes back:

   | Wave | Resources |
   |---|---|
   | -4 | `StatefulSet/hope-vault`, `StatefulSet/hope-qdrant` |
   | -3 | `Job/hope-vault-init`, `Job/hope-qdrant-init` (Sync hooks) |
   | -2 | `Deployment/hope-temporal` |
   | -1 | `Job/hope-db-migrate` (PreSync) |
   | 0 | all app Deployments incl. `hope-harness-worker`, observability stack |
   | 1 | `Deployment/hope-temporal-ui` |
   | 5 | `Job/hope-smoke-test` (PostSync) |

2. **Restore the db-migrate hook in dev.** Delete the JSON6902 patch at
   `overlays/dev/kustomization.yaml:45-54` that removes `argocd.argoproj.io/hook`,
   `hook-delete-policy` and `sync-wave`. Keep the separate `RUN_SEED=none` patch — that one
   is correct and must stay.

3. **Add `activeDeadlineSeconds`** to `hope-db-migrate` (900), `hope-vault-init` (600) and
   `hope-qdrant-init` (300). `backoffLimit` does not help: `hope-vault-init` spins
   `until wget -qO- $VAULT_ADDR/v1/sys/health; do sleep 3; done` forever inside a single pod
   attempt against a sealed Vault.

4. **Add `resources` requests/limits and a `livenessProbe` to `hope-vault`**
   (`base/vault.yaml:50-68` currently has neither). It is the single-replica secret store on
   a node running at ~95% commit.

5. **Replace `commonLabels`** in all three overlays with the non-selector-injecting form:
   ```yaml
   labels:
     - pairs: { environment: dev }
       includeSelectors: false
   ```
   `commonLabels` injects into `spec.selector`, which is the exact mechanism that hijacked
   the selector-less `hope-lmstudio` Service and caused the 2026-08-09 outage.

6. Fix the stale "PreSync" comments for `qdrant-init` in the staging and prod overlays — it
   is `hook: Sync` by design, and a future edit "correcting" the annotation to match the
   comment would reintroduce a real ordering bug.

### Verify

`kubectl kustomize deployment/k8s/overlays/{dev,staging,prod}` renders clean, then run both
repo gates against the rendered output — they run fully offline:

```bash
python3 scripts/check-config-refs.py <rendered>
python3 scripts/check-envfrom-coverage.py <rendered>
```

Both currently pass (93 refs resolve; coverage complete). They must still pass.

### Do not

- Do not enable `prune` or `selfHeal`. Out-of-band resources (`hope-lmstudio` Service +
  Endpoints) would be deleted. Prune stays off until they are adopted into Git — a separate
  decision, not this ticket.
- Do not edit `deployment/argocd/application-dev.yaml`'s `spec.project`. See WS-9 D3a.

---

## WS-3 — TTS unblock *(sonnet-5, medium)*

**Repo:** DEPLOY_REPO, `overlays/dev/kustomization.yaml` TTS patch only.

`hope-tts` is what has been failing every Argo sync for weeks: all five providers are
`false`, `/api/v1/health/ready` 503s, the Deployment blows `progressDeadlineSeconds: 600`.

**Implement `replicas: 0` for the dev overlay**, with a comment pointing at TASK-642.

Rationale to preserve in the comment: enabling Kokoro instead requires
`limits.memory` ≥ 8Gi (measured peak RSS ~7.2 GB at concurrency 5), and the node cannot
absorb that today at ~95% commit alongside Ollama's former reservation. `replicas: 0`
removes the unhealthy resource from the sync without pretending TTS works.

**Do not** flip `TTS_KOKORO_ENABLED=true` while the 1Gi limit stands — that converts a
readiness failure into an OOMKill loop, which fails the sync identically but harder to
diagnose.

### Gate

Render the dev overlay and confirm `hope-tts` has `replicas: 0` and that no other workload's
replica count changed.

---

## WS-4 — `promote-dev` and CI *(sonnet-5, medium)*

**Writes:** GitLab project configuration on `arca/hope-v2`. Owner-gated in part.

Root cause is settled: `DEPLOY_TOKEN` is unset, and `promote.sh:43`'s `:?` guard fires
before any logic. All 14 builds and both scans pass. All 13 `SERVICES` names have
exact-matching `SERVICE_NAME` build jobs — nothing silently skips.

### Owner action — do not attempt to automate this

1. `arca/hope-v2-deployment` → Settings → Access Tokens → **Project Access Token**, role
   `Maintainer`, scope **`write_repository`** only.
2. `arca/hope-v2` → Settings → CI/CD → Variables → `DEPLOY_TOKEN`, **Masked: yes**.
   **Protected: yes only after step 3 lands**, otherwise **Protected: no** — an unprotected
   branch cannot see a protected variable and the job fails with a byte-identical error.
3. If GitLab assigns the token a fixed username, add `DEPLOY_TOKEN_USERNAME` (unmasked).
   `promote.sh` defaults to `gitlab-ci-token`, correct for personal/project access tokens
   but rejected for deploy tokens.

### Agent action

- Add protected-branch rules for `dev-*` and `staging-*` (push + merge = Maintainer) via
  `mcp__gitlab__protect_branch`. Today only `main` and `release` are protected, which also
  makes the `hope-ci-deploy-dev` Vault role's `ref_protected: "true"` claim unsatisfiable.
- Confirm nothing else in `.gitlab/ci/` blocks the job. Do **not** relax the `:?` guards in
  `promote.sh` — failing loudly on a missing credential is correct.

### Gate

Re-run `promote-dev` on `dev-2.1`. Success = 13 `COPY` lines and **zero** `SKIP`, a commit
landing on `hope-v2-deployment@main`, and the dev overlay's `images:` block flipping from
`newTag: dev-<sha8>` to `@sha256:` digests. Paste the job log.

---

## WS-5 — Decommission the Argo CD Image Updater *(sonnet-5, medium)*

**Writes:** the `argocd` namespace on the **management** cluster (SSH host `master`).

It is live — `argocd-image-updater-controller` 1/1, 142 days — despite
`deployment/argocd/bootstrap.dev.yaml` documenting it as removed. It polls every two
minutes, holds cluster-wide `get/list/patch/update/watch` on Argo `Application` objects, and
carries a standing Git-write PAT. It is inert only because its tag regex doesn't match
`dev-<sha8>` and its write-back branch doesn't exist — both accidents this cutover could
undo.

1. Capture `kubectl get -o yaml` for the Deployment, both ConfigMaps, the Secret (**key
   names only in your report**) and the `ImageUpdater` CR, into the scratchpad.
2. Delete: Deployment, `argocd-image-updater-config`, `argocd-image-updater-ssh-config`,
   `argocd-image-updater-secret`, the `ImageUpdater` CR, then the
   `imageupdaters.argocd-image-updater.argoproj.io` CRD, and any ClusterRole/Binding/SA
   belonging to it.
3. Confirm the `hope-v2-dev` Application still reconciles afterwards.
4. **Report the PAT for owner rotation** — identify it, do not print it.

### Do not

Do not touch any other resource in the `argocd` namespace. Argo CD itself must keep running.

---

## WS-6 — Backups and pre-teardown snapshot *(sonnet-5, medium)*

**Writes:** scratchpad and backup targets only. Nothing in the cluster.

Everything here must be complete and **verified** before the approval gate. A backup that
has not been test-restored is not a backup.

1. `pg_dump -Fc` from the Patroni leader `db0` for **`vox-dev`**, **`temporal`**,
   **`temporal_visibility`**. Verify each with `pg_restore --list`. Record byte sizes and
   row counts for the sentinel tables: `User`, `Consultation`, `AuditLog`,
   `PromptTemplate`, `DepartmentAgent`, `AiUsageEvent`.
2. Snapshot the namespace: `kubectl get all,cm,secret,pvc,ingress -n hope-v2-dev -o yaml`
   from `gpu` into the scratchpad. **Redact Secret `data` values**; keep key names.
3. Record the full `hope-secrets` **key list** (31 keys) so WS-9 can rebuild it. Values are
   the owner's to supply.
4. `mc mirror` the HOPE buckets (`hope-attachments-*`, `hope-audio*`, `hope-recordings-*`,
   `hope-loki-logs`, `hope-tempo-traces`) to a dated prefix — **or** report their sizes and
   let the owner accept the loss. Do not mirror into `pgbackrest` or `vault-backups`.
5. Capture the Vault unseal keys currently in the `hope-vault-init` Secret so the wipe is
   reversible. Report that they exist; do not print them.

### Gate

A written manifest of every artifact, its location, its size, and the verification command
that proved it restorable.

---

## WS-7 — Shadow rehearsal of the baseline *(opus-4-8, high)*

**Depends on:** WS-1 (baseline exists) and WS-6 (dump exists). **Writes:** a throwaway
scratch database only.

This is the step that made TASK-644 safe, and the reason it is worth repeating: it catches
a broken baseline before the real database is gone.

1. Stand up a scratch Postgres. **It must be `pgvector/pgvector:pg18`** — plain
   `postgres:18-alpine` fails the restore on `CREATE EXTENSION vector`.
2. Run `manual/vault-admin-bootstrap.sql` **first**, as superuser, so `hope_app_template`
   and `hope_app` exist. The WORM `REVOKE`s are role-existence-guarded: without the roles
   they silently no-op and the migration still reports success while the audit tables come
   up mutable. **This ordering is the single most likely way to get a false green.**
3. `prisma migrate deploy` the two new migrations onto the empty scratch DB.
4. Prove equivalence to the real schema:
   ```bash
   prisma migrate diff \
     --from-url "<scratch>" \
     --to-schema packages/database/src/prisma/db_main --script   # expect empty
   ```
5. Prove the four hand-appended items actually landed — `migrate diff` cannot see any of
   them, so check directly:
   - `SELECT indexdef FROM pg_indexes WHERE indexname = 'UserVoiceProfile_userId_active_unique';`
     → must contain the `WHERE` clause
   - `has_table_privilege('hope_app','core."HarnessAuditEvent"','UPDATE')` → **false**, and
     the same for `DELETE` and for the other two WORM tables
   - extension list matches the `vectorscale` decision from WS-1
6. Seed the scratch DB with `RUN_SEED=all NODE_ENV=development` and confirm it completes —
   this is the first time the seed will have run against a squashed schema.
7. Run the WORM regression suite against the scratch DB:
   `pnpm --filter @arcaai/database exec vitest run --config vitest.worm.config.ts`.
   **It self-skips when no database is reachable** — confirm from the output that it
   actually executed rather than skipped.

### Gate

All of 4–7 pass. A failure here **blocks the approval gate**; report and stop.

---

## WS-8 — Teardown *(opus-5, max)* — 🔴 DESTRUCTIVE, GATED

**Do not start without explicit owner approval recorded in the ticket.** Re-read §0.

Preconditions, all of which you must verify yourself before the first delete:
WS-1..WS-7 complete · WS-6 backups verified restorable · WS-7 rehearsal green ·
owner approval recorded.

1. **Disable Argo auto-sync** on `hope-v2-dev` first (via the argocd MCP —
   `kubectl patch` of the Application has previously been blocked by the permission
   classifier). Nothing below is safe while a controller is re-creating resources.
2. Delete HOPE Deployments, StatefulSets and Jobs in `hope-v2-dev` — including
   **`hope-ollama` and `hope-ui`** (owner decision: wipe). SMR is unaffected: it points at
   `http://hope-lmstudio:1234/v1`, verified, not at Ollama.
3. Delete stale/failed pods (~35, back to April), dead ReplicaSets, and the leftover debug
   pods `db-migrate-manual` and `redis-temp`.
4. Delete PVCs: all namespace PVCs including `hope-vault-data`, plus the orphans
   `data-hope-postgres-0` (100Gi) and `data-hope-redis-0` (5Gi), plus Ollama's 100Gi.
   Reclaims ~205Gi on a `/mnt/data` that is **90% full**.
5. Delete stale config: `hope-config`, `hope-smr-config-62ht876cm9`,
   `hope-registry-credsf`.
6. **Databases** — on `db0` (Patroni leader) drop and recreate **only** `vox-dev`,
   `temporal`, `temporal_visibility`. Re-read the never-touch list before typing.
7. **MinIO** — `mc rm --recursive --force` the *contents* of the HOPE buckets, leaving the
   buckets themselves. Scope is exactly: `hope-attachments-{4bits,arcaai,global,mumbai-hospital,system}`,
   `hope-audio`, `hope-audio-{4bits,arcaai,chunks,global,mumbai-hospital}`,
   `hope-recordings-{arcaai,global,system}`, `hope-loki-logs`, `hope-tempo-traces`.
   **Not** `gitlab-*`, **not** `pgbackrest`, **not** `vault-backups`, **not** `audio`,
   **not** `tts-audio`, **not** `langfuse`.
8. Prune unused container images on `gpu` to recover disk.

Report a line-by-line log of every destructive command and its result.

---

## WS-9 — Rebuild and bootstrap *(opus-4-8, high)*

1. Recreate `hope-registry-creds` and `hope-secrets` **without** the
   `kubectl.kubernetes.io/last-applied-configuration` annotation — use
   `kubectl create secret … --save-config=false` or `kubectl apply --server-side`, never
   plain `kubectl apply`. All 31 credentials have been readable in cleartext via that
   annotation; **the owner rotates every value** as part of this step.
2. Run `manual/vault-admin-bootstrap.sql` as superuser against the fresh `vox-dev`
   **before** any migration — same ordering trap as WS-7 step 2.
3. Re-apply out-of-band manifests: `deployment/k8s/out-of-band/lmstudio-service.yaml` and
   `lmstudio-endpoints.yaml` (they must stay outside kustomize), and the GPU time-slicing
   ConfigMap + ClusterPolicy patch in the `gpu-operator` namespace. Confirm LM Studio is
   actually listening on `10.10.1.10:1234` — SMR's readiness depends on it.
4. Re-enable Argo auto-sync. The re-layered waves (WS-2) should bring up Vault → unseal →
   Qdrant init → Temporal → migrate → apps.
5. Seed **once, by hand**: `RUN_SEED=all NODE_ENV=development` for that single invocation.
   **Do not** restore `RUN_SEED` in the overlay — it enables `SEED_DEMO_DATA`, which writes
   demo API keys with raw secrets on every sync.
6. Re-initialise Vault: new unseal keys, AppRole re-issue, re-seed platform secrets.
7. **D3a, only if moving `spec.project` to `hope-v2-dev`:** unscope the Argo repo credential
   `repo-820844053` first, verify Git access, *then* repoint. Doing it in the other order
   broke Argo's Git access in 4 seconds on 2026-08-08. If in doubt, leave the live project
   as `hope-v2` — it works.

---

## WS-10 — Verification *(sonnet-5, medium)* — read-only

| # | Check | Pass condition |
|---|---|---|
| 1 | `prisma migrate status` | "Database schema is up to date!", 2 migrations recorded |
| 2 | `migrate diff --from-migrations … --to-schema … --exit-code` | 0 |
| 3 | Partial index present | `pg_indexes` row contains the `WHERE` clause |
| 4 | WORM privileges | `has_table_privilege('hope_app', …, 'UPDATE'/'DELETE')` false on all three tables |
| 5 | WORM vitest suite | Ran (**not skipped**) and green |
| 6 | Argo `hope-v2-dev` | `Synced` + `Healthy` — first time in weeks |
| 7 | Service health | every `/health/ready` returns 200 |
| 8 | Smoke test | `hope-smoke-test` PostSync Job completes |
| 9 | End-to-end | one consultation: audio → STT → SMR summary → a row in `AiUsageEvent` |
| 10 | Disk | `/mnt/data` on `gpu` materially below 90% |
| 11 | No regression | zero `PruneSkipped` surprises; `hope-lmstudio` Service still selector-less with live Endpoints |

---

## WS-11 — Documentation close-out *(haiku-4-5, default)*

- Fill in README.md §7 Implementation Summary with what actually happened.
- Add a Change History row to `docs/implementation/TASK-644-Prisma-Migration-Baseline/README.md`
  recording the pivot from baseline-and-keep-history to squash-and-reset, and noting that
  its §1.1 described a pre-baseline state that no longer holds (the live DB had 80 recorded
  migrations before this cutover).
- Update `DEPLOY_REPO/README.md`, which wrongly claims HPA/PDB scope only `hope-api` — TASK-622
  C.2 moved HPA+PDB for 11 services into `base/`.
- Update `DEPLOY_REPO/deployment/argocd/bootstrap.dev.yaml`, which claims the Image Updater
  was removed. After WS-5 that becomes true; make the comment match reality either way.

---

## Known-open items this ticket does NOT close

Record them; do not silently absorb them.

| Item | Status |
|---|---|
| Leaked `gl4bits-`/`gldt-` tokens in DEPLOY_REPO git history (commit `08d1651`) | Rotation still owed; `gitleaks` runs `--no-git` to avoid failing forever |
| No Vault auto-unseal in-cluster — a `hope-vault-0` restart comes back sealed | Open; WS-2's `activeDeadlineSeconds` only stops it wedging the sync |
| All PDBs are `minAvailable: 0` placeholders | Inert until `minReplicas` rises |
| `prune`/`selfHeal` off; out-of-band resources not adopted into Git | Deliberate; revisit after this cutover |
| `hope-v2-staging` / `hope-v2-prod` Applications exist in Git but were never applied | Nothing in CI creates them |
| API/admin-console/playground are NodePort-only; only Grafana has an Ingress | Confirm intentional |
