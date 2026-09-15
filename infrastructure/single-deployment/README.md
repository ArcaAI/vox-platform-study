# Single-Deployment — production infrastructure blueprints

Production deployment blueprints for infrastructure components that are deployed once per
environment (as opposed to the per-service application manifests, which live in the separate
`arca/hope-v2-deployment` repository, not here).

> ## The one stack in here — `vault/` — is RETIRED (TASK-833)
>
> It targets Proxmox VMs 430/431/432/434, which are being destroyed. HOPE's Vault is now a
> single in-cluster instance (`hope-vault` in `hope-v2-dev`, Shamir seal unsealed by an in-pod
> sidecar) defined in `arca/hope-v2-deployment` -> `deployment/k8s/base/vault.yaml`, with the
> operator procedure in that repo's `docs/vault-seal-migration.md`.
>
> The tree below is kept as a design record and for the parts still in use
> (`bootstrap/configure-app-auth.sh`, the policy set, the unapplied monitoring rules). Read the
> banner at the top of [vault/README.md](vault/README.md) before using any of it. **This
> directory therefore contains no currently-deployable blueprint.**

## Layout

The directory currently contains a single stack:

### vault/ — HA Vault on self-hosted k3s (retired)

Production blueprint for a 3-node, highly-available, auto-unsealing HashiCorp Vault cluster
(Raft integrated storage + Transit auto-unseal via a separate single-node seal Vault). Full
architecture, install steps, bootstrap, and validation live in [vault/README.md](vault/README.md).

| Path | Contents |
|---|---|
| `vault/helm/` | Pinned Helm values for the `hashicorp/vault` chart (`values.yaml`, digest pins in `values.digests.yaml`) |
| `vault/seal-vault/` | The single-node seal Vault (Transit key holder): manifest, bootstrap script, kustomization |
| `vault/bootstrap/` | Post-install bootstrap: `configure-app-auth.sh` (mints the HOPE API's AppRole creds into a k8s Secret), `rotate-secret-id.sh`, init Job + kustomization |
| `vault/manifests/` | Network policies (server + seal), audit sidecar values, Prometheus ServiceMonitor |
| `vault/monitoring/` | Alert rules (`alerts.yaml`, `alerts-app.yaml`), recording rules, Grafana dashboard JSON — see [vault/monitoring/README.md](vault/monitoring/README.md) |
| `vault/test/kind-e2e.sh` | End-to-end smoke of the whole stack on a local kind cluster |

## How it works

| Scenario | Use |
|---|---|
| Local development secrets | Dev-mode Vault in Docker Compose — see [infrastructure/docker/README.md](../docker/README.md) (`--profile vault`, `pnpm infra:dev:up`) |
| Production / staging Vault on the k3s cluster | The in-cluster instance defined in `arca/hope-v2-deployment`, not this directory |
| Day-2 Vault operations (rotation, failover, recovery, monitoring) | [docs/operations/vault/](../../docs/operations/vault/README.md) |
| Resilience drills against a running HA cluster | `scripts/chaos/vault-drill.sh` (see [scripts/README.md](../../scripts/README.md)) |
| Application service deploys (API, STT, TEXT, ...) | The separate `arca/hope-v2-deployment` repository |

## Related

- [vault/README.md](vault/README.md) — the retired Vault HA blueprint, with the full retirement banner
- [../README.md](../README.md) — the `infrastructure/` directory map
- [../../docs/operations/vault/README.md](../../docs/operations/vault/README.md) — day-2 Vault operator runbook
