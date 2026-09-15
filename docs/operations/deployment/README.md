# Deployment — CI-side image promotion into the cluster GitOps repo

HOPE runs entirely in Kubernetes (k3s, Argo CD GitOps). This repo's GitLab CI builds, scans and
publishes images; it never touches the cluster directly. Every k8s manifest, the Argo CD config,
and the actual deploy/rollback/upgrade runbooks live in the SEPARATE `arca/hope-v2-deployment`
repo (checked out at `~/Desktop/igglo/ARCAAI/hope-v2-deployment`) — nothing under this directory
is a cluster manifest, and no path here is relative to that other repo.

## Layout

| Path | What it holds |
|---|---|
| `README.md` | This file — the CI-side promotion mechanics owned by this repo |
| `cdn-edge-requirements.md` | Strong-ETag preservation requirements for any CDN/WAF/proxy in front of HOPE (Cloudflare in front of the admin console today) — without it, optimistic-concurrency writes break after a deploy |
| `helm-kustomize-pattern.md` | The Helm/Kustomize hybrid pattern to follow if a third-party chart is ever vendored into `arca/hope-v2-deployment` — a documented pattern, not something currently built there |

## How it works

Promotion is digest-pinned and driven entirely by which branch or tag a pipeline runs against
(`.gitlab-ci.yml`, `.gitlab/ci/deploy.yml`, script `.gitlab/ci/promote.sh`):

| Ref | `PIPELINE_TYPE` | CI job | Target overlay in `arca/hope-v2-deployment` |
|---|---|---|---|
| `dev-*` (current active branch `dev-2.2` included) | `dev` | `promote-dev` — runs automatically | `deployment/k8s/overlays/dev` |
| `staging-*` | `staging` | `promote-staging` — runs automatically | `deployment/k8s/overlays/staging` |
| a protected `vX.Y.Z` tag | `tag_release` | `promote-prod` — manual trigger | `deployment/k8s/overlays/prod` |

Each `promote-*` job resolves the already-built image's `sha-<sha8>` digest (`docker buildx
imagetools inspect`), runs `kustomize edit set image` against the target overlay, commits, and
pushes to `arca/hope-v2-deployment`'s `main`. It never rebuilds an image, and it is the only thing
this pipeline does to that repo — Argo CD, watching `main` there, is what actually applies the
change to the cluster.

Per `.claude/rules/09-infrastructure-devops.md` (the current, authoritative source for cluster
state): only `hope-v2-dev` is a live namespace with a live Argo `Application` today. The
`staging`/`prod` overlays and their `promote-*` jobs exist and render correctly, but no
`hope-v2-staging`/`hope-v2-prod` namespace or Application has been created yet.

## Gotchas

- **Git is the only durable write path.** Under Argo's auto-sync, `kubectl apply` / `kubectl edit`
  / `argocd app rollback` against the live cluster is not durable on its own — the next reconcile
  (or, once `selfHeal` is on, the very next one regardless of any new commit) can silently revert
  it. A rollback always needs a `git revert` pushed to `arca/hope-v2-deployment`'s `main`, not just
  a live-cluster mutation; the other repo's own runbook has the procedure.
- **Migrations are forward-only** (`.claude/rules/02-database-prisma.md`: "NEVER edit a committed
  migration; roll forward with a new migration"). Rolling back an image does not roll back a
  schema that already migrated past it — a bad deploy that crossed a breaking migration boundary
  needs a compensating forward migration, not an image revert.
- **The only live k3s node is a single Proxmox VM** with GPUs attached via PCI passthrough
  (`.claude/rules/09-infrastructure-devops.md` Topology) — there is no second node to fail over to,
  so a k3s or kernel upgrade takes the whole cluster down for its duration; that is a deliberate,
  documented constraint of the platform, not a gap.

## Related

- [`.claude/rules/09-infrastructure-devops.md`](../../../.claude/rules/09-infrastructure-devops.md) — cluster topology, the GitOps write path, and configuration-tier rules (current and authoritative)
- [`.claude/rules/02-database-prisma.md`](../../../.claude/rules/02-database-prisma.md) — the forward-only migration rule
- the separate `arca/hope-v2-deployment` repo (`~/Desktop/igglo/ARCAAI/hope-v2-deployment`) — every k8s manifest, the Argo CD config, and the actual deploy/rollback/k3s-upgrade runbooks (start at its own `README.md` and `docs/deployment-runbook.md`)
- [`cdn-edge-requirements.md`](./cdn-edge-requirements.md), [`helm-kustomize-pattern.md`](./helm-kustomize-pattern.md) — siblings in this directory
- [`../observability/README.md`](../observability/README.md), [`../vault/README.md`](../vault/README.md) — on-call/alerting and Vault operations
