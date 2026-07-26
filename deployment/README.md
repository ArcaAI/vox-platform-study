# `deployment/`

> **Read this before adding anything here.**
>
> The previous contents of this directory — `deployment/k3s/base/*`,
> `deployment/k3s/overlays/{dev,prod}`, `deployment/argocd/bootstrap.*.yaml.example`
> and `deployment/secrets.*.yaml.example` — were **deleted on 2026-07-24** in commit
> `1de5b8c1` ("chore(deployment): Remove deprecated deployment files and templates",
> 24 files, −2622 lines). They were stale: service names still said `stt-v2`, images
> were tagged `latest` (which `.claude/rules/09-infrastructure-devops.md` forbids),
> and every pod took its credentials from `envFrom: secretRef: hope-secrets` — a
> materialized Kubernetes `Secret`, the posture TASK-558 §9.2 L7 rejects for a PHI
> platform.
>
> The **live** cluster path is not in this repository. `.gitlab/ci/deploy.yml`
> writes image tags into a separate `hope-deployments` repo (Helm values at
> `apps/<service>/values-staging.yaml`) which Argo CD watches. Anything here is a
> contract for that repo to consume, not a second source of truth for topology.
>
> `.claude/rules/09-infrastructure-devops.md` still describes the deleted Kustomize
> tree as if it existed. That rule is stale as of `1de5b8c1`; correcting it was out
> of scope for TASK-558 lane K (rules are another lane's file).

## Contents

| Path | What it is |
|---|---|
| `vault-agent/` | The **pod-level contract** for delivering platform secrets with Vault Agent injection instead of Kubernetes `Secret` objects (TASK-558 §13.2 P1/P2/P7, §9.2 L7). A reference Deployment, the per-service secret table, and the equivalent Helm `podAnnotations` snippet. |

Vault **server-side** configuration (auth methods, roles, policies) is not here —
it lives with the rest of the Vault configuration under
`infrastructure/docker/configs/vault/policies/`, so the dev bootstrap and the
cluster load the same files.
