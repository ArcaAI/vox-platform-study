# Vault monitoring — Prometheus rules and Grafana dashboard for the retired HA Vault

Prometheus rules and a Grafana dashboard for the retired HA Vault cluster blueprint (see
[../README.md](../README.md) — never applied to the in-cluster Vault, which still has no seal
alerting). Scraping itself is wired by the blueprint's **ServiceMonitor**
(`../manifests/service-monitor.yaml`), which scrapes every node (active + standby) at
`/v1/sys/metrics?format=prometheus`.

## Layout

| File | Kind | What |
|---|---|---|
| `alerts.yaml` | PrometheusRule | Server-side alerts: sealed, no-leader, node-down, quorum-at-risk, leader-flap, autopilot-unhealthy, audit-write/response failures, audit/data PVC low-space |
| `recording-rules.yaml` | PrometheusRule | Pre-aggregations (`vault:nodes_unsealed:count`, `vault:has_leader:bool`, ...) the dashboard + alerts read |
| `alerts-app.yaml` | PrometheusRule | App-side alerts on `arca_vault_*`. Apply only after the API exports them (see How it works) |
| `grafana-dashboard.json` | Grafana | Importable dashboard ("HOPE — Vault HA", uid `hope-vault-ha`) |

## Commands

```bash
# Prometheus Operator (kube-prometheus-stack) picks up PrometheusRule CRDs whose
# labels match its ruleSelector. Confirm the selector, then apply:
kubectl -n monitoring get prometheus -o yaml | grep -A3 ruleSelector   # e.g. release: kube-prometheus-stack
kubectl apply -f recording-rules.yaml -f alerts.yaml
# (apply alerts-app.yaml ONLY once GET /metrics on the API exposes arca_vault_*)
```

Import `grafana-dashboard.json` (Dashboards -> New -> Import). It prompts for a `Prometheus`
data source (`DS_PROMETHEUS`). Panels: seal/leader/quorum stat row, autopilot health, per-node
seal & leader timelines, leases & tokens, audit failure rates, and PVC free-space %.

## How it works

### App-side metrics (not yet exported)

`alerts-app.yaml` expects three series the API does not export today:

| Metric | Type | Source already present |
|---|---|---|
| `arca_vault_degraded` | gauge 0/1 | `SecretsService.health().degraded` |
| `arca_vault_token_ttl_remaining_seconds` | gauge | AppRole token-renew loop in `VaultSecretsProvider` |
| `arca_vault_lease_renewal_failure_total` | counter | `VaultLeaseRenewer.failureCount` |

The API already serves `prom-client` at `GET /metrics` (`apps/api/src/observability/metrics.ts`).
Exporting these is a small, additive follow-up (a gauge with a `collect()` hook reading the live
`SecretsService`). See `docs/operations/vault/README.md#app-side-vault-metrics-future`.

## Gotchas

- If the `release` label on these rules doesn't match your Prometheus Operator's
  `ruleSelector`, the rules are silently ignored — edit `metadata.labels.release` in each file.
- `alerts-app.yaml` alerts on metrics that do not exist yet — applying it before the API exports
  `arca_vault_*` gives a permanently-firing or permanently-absent alert, not a useful one.

## Related

- [../README.md](../README.md) — the retired Vault HA blueprint this monitoring set belongs to
- [../../../../docs/operations/vault/README.md](../../../../docs/operations/vault/README.md) — day-2 operator runbook, including the app-side metrics follow-up
