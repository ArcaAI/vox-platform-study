# Single-Deployment — Production Blueprints

Last updated: 2026-07-04

Production deployment blueprints for infrastructure components that are deployed once per environment (as opposed to the per-service application manifests in [deployment/](../../deployment/README.md)).

The directory currently contains a single stack:

## vault/ — HA Vault on self-hosted k3s

Production blueprint for a 3-node, highly-available, auto-unsealing HashiCorp Vault cluster (Raft integrated storage + Transit auto-unseal via a separate single-node seal Vault). Full architecture, install steps, bootstrap, and validation live in [vault/README.md](vault/README.md).

| Path | Contents |
|---|---|
| `vault/helm/` | Pinned Helm values for the `hashicorp/vault` chart (`values.yaml`, digest pins in `values.digests.yaml`). |
| `vault/seal-vault/` | The single-node seal Vault (Transit key holder): manifest, bootstrap script, kustomization. |
| `vault/bootstrap/` | Post-install bootstrap: `configure-app-auth.sh` (mints the HOPE API's AppRole creds into a k8s Secret), `rotate-secret-id.sh`, init Job + kustomization. |
| `vault/manifests/` | Network policies (server + seal), audit sidecar values, Prometheus ServiceMonitor. |
| `vault/monitoring/` | Alert rules (`alerts.yaml`, `alerts-app.yaml`), recording rules, Grafana dashboard JSON. See [vault/monitoring/README.md](vault/monitoring/README.md). |
| `vault/test/kind-e2e.sh` | End-to-end smoke of the whole stack on a local kind cluster. |

## When to use what

| Scenario | Use |
|---|---|
| Local development secrets | Dev-mode Vault in Docker Compose — see [infrastructure/docker/README.md](../docker/README.md) (`--profile vault`, `pnpm infra:dev:up`). |
| Production / staging Vault on the k3s cluster | This directory (`vault/`). |
| Day-2 Vault operations (rotation, failover, recovery, monitoring) | [docs/operations/vault/](../../docs/operations/vault/README.md). |
| Resilience drills against a running HA cluster | `scripts/chaos/vault-drill.sh` (see [scripts/README.md](../../scripts/README.md)). |
| Application service deploys (API, STT, SMR, ...) | [deployment/](../../deployment/README.md) (k3s + ArgoCD). |
