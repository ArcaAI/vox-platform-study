# Vault monitoring (TASK-312 Phase E)

Prometheus rules + a Grafana dashboard for the HA Vault cluster. Scraping itself
is already wired by the Phase C **ServiceMonitor** (`../manifests/service-monitor.yaml`),
which scrapes every node (active + standby) at `/v1/sys/metrics?format=prometheus`.

| File | Kind | What |
|---|---|---|
| `alerts.yaml` | PrometheusRule | Server-side alerts: sealed, no-leader, node-down, quorum-at-risk, leader-flap, autopilot-unhealthy, audit-write/response failures, audit/data PVC low-space. |
| `recording-rules.yaml` | PrometheusRule | Pre-aggregations (`vault:nodes_unsealed:count`, `vault:has_leader:bool`, …) the dashboard + alerts read. |
| `alerts-app.yaml` | PrometheusRule | App-side alerts on `arca_vault_*`. **Apply only after the API exports them** (see the operator runbook). |
| `grafana-dashboard.json` | Grafana | Importable dashboard ("HOPE — Vault HA", uid `hope-vault-ha`). |

## Apply

```bash
# Prometheus Operator (kube-prometheus-stack) picks up PrometheusRule CRDs whose
# labels match its ruleSelector. Confirm the selector, then apply:
kubectl -n monitoring get prometheus -o yaml | grep -A3 ruleSelector   # e.g. release: kube-prometheus-stack
kubectl apply -f recording-rules.yaml -f alerts.yaml
# (apply alerts-app.yaml ONLY once GET /metrics on the API exposes arca_vault_*)
```

If the `release` label here doesn't match your operator's `ruleSelector`, the
rules are silently ignored — edit the `metadata.labels.release` in each file.

## Grafana dashboard

Import `grafana-dashboard.json` (Dashboards → New → Import). It prompts for a
`Prometheus` data source (`DS_PROMETHEUS`). Panels: seal/leader/quorum stat row,
autopilot health, per-node seal & leader timelines, leases & tokens, audit
failure rates, and PVC free-space %.

## App-side metrics (future)

`alerts-app.yaml` expects three series the API does not export yet:

| Metric | Type | Source already present |
|---|---|---|
| `arca_vault_degraded` | gauge 0/1 | `SecretsService.health().degraded` |
| `arca_vault_token_ttl_remaining_seconds` | gauge | AppRole token-renew loop in `VaultSecretsProvider` |
| `arca_vault_lease_renewal_failure_total` | counter | `VaultLeaseRenewer.failureCount` |

The API already serves `prom-client` at `GET /metrics`
(`apps/api/src/observability/metrics.ts`). Exporting these is a small, additive
follow-up (a gauge with a `collect()` hook reading the live `SecretsService`).
See `docs/operations/vault/README.md#app-side-vault-metrics-future`.
