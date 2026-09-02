# TASK-854 — Portable deployment templates + verified dev delivery chain

| | |
|---|---|
| **Status** | Review — repo changes complete and render-verified; two live steps await owner go-ahead |
| **Type** | infrastructure |
| **Branch** | `dev-2.2` (monorepo) · `main` (`arca/hope-v2-deployment`) |
| **Date** | 2026-09-02 |
| **Repos** | `arca/hope-v2` (rules + this ticket) · `arca/hope-v2-deployment` (manifests + docs) |

## Requirement Analysis

Two requirements, in the owner's words:

1. *"make sure we are building and deploying a dev in-cluster environment using
   gitlab-ci, argo-cd, rancher, and one VM with 2xGPU assigned"* — verify the
   delivery chain end to end, with evidence, not assertion.
2. *"update all k8s templates and documents in both repos, to ensure we have
   correct deployment instructions to be used for deployments in any k8s
   environments"* — the manifests must stop encoding this one cluster, and the
   documentation must say what a new environment has to supply.

Preceding work in the same session (folded in here because it shares the disk):
grow VM 200's second disk 300 GB → 500 GB, give MinIO a 300 GB budget for models
and artifacts, and set log retention to 30 days.

## Current State Evaluation

### The chain works (verified 2026-09-02)

| Link | Evidence |
|---|---|
| GitLab CI | pipeline **#818** (id 1082, `dev-2.2`, sha `83304378`) — success. 11 validate gates, 16 image builds, `scan-gitleaks`, `promote-dev`, `github-backup` |
| Digest promotion | `promote-dev` committed `4c41ac7` to `arca/hope-v2-deployment@main` — image digests, not tags |
| Argo CD | app `hope-v2-dev` on VM 400, last sync **Succeeded** 02:03Z, 165 resources, 160 Synced |
| Rancher | cluster `c-nfhxq` state **active**, `Connected=True`, `Ready=True`, agent healthy in-cluster |
| k3s | v1.34.5 on VM 200 (`dell`, `10.10.1.10`), namespace `hope-v2-dev`, 51 pods |
| GPU | `hostpci0: 4f:00`, `hostpci1: d5:00` → 2× RTX 2000 Ada in-guest; device plugin advertises **6** (×3 time-slicing); **6/6 allocated** — LM Studio 4, STT 1, STT worker 1 |

Two permanent-but-cosmetic Argo statuses, documented so they stop being
investigated: health `Missing` (two Jobs self-delete via
`ttlSecondsAfterFinished`) and two hashed ConfigMaps `OutOfSync`
(`selfHeal: false` means Argo never corrects drift it did not cause).

### The templates did not travel

`base/` encoded this cluster in six places. Each works here and fails elsewhere,
mostly without saying so:

| Defect | Consequence |
|---|---|
| Six production hostnames in `base/ingress.yaml`, patched by **no** overlay | **The dev cluster was serving the production hostnames.** Measured: `grafana.taphuynh.dev` → 302 from dev Grafana; `grafana-dev.taphuynh.dev` → 502, despite the dev overlay setting that as Grafana's own `GF_SERVER_ROOT_URL`. Standing up `overlays/prod` would have put two Ingresses on one host |
| `--allowed-hosts=…hope-mlflow.hope-v2-dev.svc.cluster.local…` | MLflow in any other namespace rejects **its own Service DNS** with `400 Invalid Host` |
| `serverstransport: hope-v2-dev-hope-minio-tls@kubernetescrd` | Traefik cannot resolve the transport, downgrades to HTTP, MinIO answers `400` — the bug the annotation exists to prevent |
| `tcp://hope-postgres-rw.hope-v2-dev.svc…` in the tunnel config | A staging connector tunnels `db-staging` into the **dev database** |
| `hostPath: /mnt/data/models-cache` ×4 | On a second node: empty cache, silent full re-download |
| `base/vllm.yaml` mounting undeclared PVC `hope-models-cache` | Latent (`replicas: 0`): scale to 1 anywhere ⇒ **Pending forever**. Confirmed absent from the cluster |

### Storage was unbounded

`local-path` enforces no quota, so every PVC size in the repo is metadata and
MinIO, PostgreSQL, the container image store and a 112 GB model cache shared one
295 GB filesystem — an overrun surfacing as `DiskPressure` under the database.
Redis, separately, ran `--save "" --appendonly no` on an `emptyDir`: the BullMQ
queues the gateway fans sys-events into were lost on **every** pod restart, after
the producer had already returned 2xx.

## Implementation Summary

### Live changes applied

| Change | Result |
|---|---|
| `qm resize 200 virtio1 +200G` + online `resize2fs /dev/vdb` | 300 GB → **500 GB**, 492 GB usable / 257 GB free. Whole-disk ext4, no partition table — no reboot, no pod restart, `DiskPressure: False` |
| MinIO per-bucket quotas | `hope-models` 200Gi · `hope-loki-logs` 40Gi · `hope-tempo-traces` 30Gi · `mlflow` 20Gi · `harness-claim-check` 20Gi. PHI audio + `hope-backups` deliberately unquoted |
| MinIO ILM on `hope-models` | non-current versions expire after 30 d (the bucket is versioned; every re-publish was leaving ~15 GB invisible to `mc ls` but charged against the quota) |
| Bucket cleanup (VM 402) | 20 `hope-*`/legacy buckets destroyed, ~21 GB. All in-cluster consumers already point at `hope-minio`; no live dependency touched |

Both MinIO commands were validated against the real server on a throwaway bucket
before being applied or committed (quota accepted; combined
`NoncurrentVersionExpiration` + `ExpiredObjectDeleteMarker` rule accepted; bucket
removed).

### `arca/hope-v2-deployment` — manifests

- **`base/ingress.yaml`** — six hostnames → `.invalid` placeholders (RFC 2606).
  `dev`, `staging`, `prod` each patch their own. Dev keeps its **current** names,
  so nothing moved; the dev/prod collision is now visible in two files instead of
  latent in one, with the `*-dev.taphuynh.dev` migration written up as a
  two-part DNS + overlay change (deliberately not performed — it changes public
  URLs).
- **`base/models-cache.yaml`** (new) — `hope-models-cache` PVC, RWX, 150Gi.
  Fixes the dangling vLLM reference and gives base a portable default.
- **`components/node-local-model-cache/`** (new) — deletes that PVC and puts all
  five consumers back on `/mnt/data/models-cache`. Enabled by `dev` and
  `standalone`; explicitly not for multi-node clusters.
- **`base/mlflow.yaml`** — `--allowed-hosts` uses `hope-mlflow.*`; the public
  hostname is appended per overlay.
- **`base/minio.yaml`** — claim 200Gi → **300Gi**; Traefik transport documented
  as overlay-owned and patched in all three overlays; `persistentVolumeClaimRetentionPolicy: Retain/Retain`.
- **`base/cloudflared.yaml`** — namespace-free Service origins.
- **`components/data-tier/redis.yaml`** — AOF (`everysec`) on an **8Gi PVC**.
- **7 standalone PVCs** — `argocd.argoproj.io/sync-options: Prune=false,Delete=false`.
- **4 StatefulSets** — `persistentVolumeClaimRetentionPolicy: Retain/Retain`.
- **`base/observability-config.yaml`** — Loki `2160h → 720h`, Tempo `2160h → 720h`.
- **`out-of-band/minio-bootstrap.yaml`** — quota + ILM provisioning, idempotent.

### `arca/hope-v2-deployment` — documents

- **`docs/deploying-to-any-kubernetes.md`** (new, 208 lines) — the layering rule,
  the six defects and how each failed, a new-environment checklist (identity,
  storage, GPU, secrets, Argo), the verified dev chain, and render assertions.
- **`README.md`** — the "no placeholders left to replace" claim replaced with the
  base/overlay split; layout updated.
- **`docs/deployment-runbook.md`** — §1 rewritten for the 500 GB disk, the three
  `local-path` facts, and the over-provisioned thin pool; pointer to the new doc.
- **`docs/observability-retention.md`** — 30-day decision, with measurements.

### `arca/hope-v2` — rules

- **`.claude/rules/09-infrastructure-devops.md`** — corrected the stale claim that
  Postgres/MinIO are external; added the verified chain, the base-portability
  contract, and the three `local-path` storage facts.

## Verification

```
kubectl kustomize overlays/{dev,staging,prod,standalone}   → all four OK
dev render diff vs pre-change baseline                     → 30 lines, all intended
  · postgres tunnel origins → short names (same Service)
  · mlflow allowed-hosts → glob (superset; public host preserved)
  · vllm models volume → hostPath (was a dangling claim; replicas: 0)
  · ingress hosts, minio transport → UNCHANGED
render assertions: dev .invalid=0 · standalone .invalid=6
                   dev hope-models-cache PVC=0, hostPath=5
                   prod hope-models-cache PVC=1, hostPath=0
```

Live: `/dev/vdb` 492 G (257 G free), `DiskPressure: False`, all quotas readable
back via `mc quota info`, ILM rule present on `hope-models`.

## Open items (owner decision required)

1. **Two StatefulSet recreates.** `volumeClaimTemplates` is immutable, so the
   MinIO 300Gi and the Redis PVC will **fail the Argo sync** — and a failed sync
   blocks every later change to the app — until each is preceded by
   `kubectl -n hope-v2-dev delete sts <name> --cascade=orphan` (PVC, PV and data
   survive). The Redis cutover restarts Redis, dropping whatever is queued at
   that instant: the last data it loses before it stops losing data.
2. **Dev hostname migration.** Move dev to `*-dev.taphuynh.dev` — 5 Cloudflare
   CNAMEs plus a one-word overlay edit — before `overlays/prod` is stood up.
3. **`fstrim -av`** across the guests: the thin pool is over-provisioned
   (1.83 TiB of volumes against a 1.67 TiB pool, ~16 GB unallocated in the VG, so
   it cannot be extended) and ~265 GB sits in never-trimmed blocks.
4. **Nothing is committed or pushed.** Argo auto-syncs `main`, so pushing the
   deployment repo is a live deploy — sequenced behind (1).

## Change History

| Date | Change |
|---|---|
| 2026-09-02 | Ticket created. Disk grown, quotas + ILM applied, manifests made portable, docs written. Status: Review |
