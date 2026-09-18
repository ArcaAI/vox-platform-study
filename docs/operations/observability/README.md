# Observability — dashboards, alert rules, and the still-missing paging path

This page describes **process and current wiring**: where the dashboards and alert rules live,
what they cover, and what still doesn't happen when one fires. It deliberately does not state
coverage numbers (how many of the 11 services emit metrics/traces/logs) — those move as coverage
lands incrementally; query Prometheus/Grafana directly for that.

## Layout

| Path | What it holds |
|---|---|
| `README.md` (this file) | dashboards, alert rules, and the still-missing paging path |
| [`python-logging-and-tracing.md`](python-logging-and-tracing.md) | **the standard every Python service emits under** — the shared `hope_obs` package, the env contract, what survives the collector, and what a new service must do (TASK-987) |

## How it works

No SLOs are defined for any HOPE service today. An SLI added later should be sourced
from a metric Prometheus already collects for that service, not a new bespoke measurement.

Prometheus, Loki, Tempo, the OTel Collector, and Grafana are deployed in `hope-v2-dev`. All
manifests live in the separate `arca/hope-v2-deployment` repo, not here.

| Tool | Local dev | In-cluster (`hope-v2-dev`) |
|---|---|---|
| Prometheus | `http://localhost:9090` (`.claude/rules/00-project-context.md` §Ports) | `ClusterIP` only (`base/prometheus.yaml`) — no NodePort, no Ingress. Reach it with `kubectl -n hope-v2-dev port-forward svc/prometheus 9090:9090`, or `kubectl exec` into the pod for a live PromQL query |
| Grafana | `http://localhost:3001` (`.claude/rules/00-project-context.md` §Ports) | `ClusterIP` Service (`base/grafana.yaml`) behind an Ingress. `base/ingress.yaml` ships an `.invalid` placeholder host by design, but as of 2026-09-02 the `overlays/dev` kustomization routes `https://grafana.taphuynh.dev` to it through Traefik and the in-cluster Cloudflare tunnel — a known, unresolved hostname collision with the `prod` overlay, and it disagrees with the pod's own `GF_SERVER_ROOT_URL` (`grafana-dev.taphuynh.dev`, which no Ingress claims yet). Treat the routed hostname as the one that works, and fall back to `kubectl -n hope-v2-dev port-forward svc/grafana 3000:3000` if that routing changes |
| Loki / Tempo | Part of the same Docker Compose observability profile (`pnpm infra:dev:up:observability`) | In-cluster only, no external access documented |

There is no separate "SRE dashboard" or status page — Grafana, at the addresses above, is the
dashboard layer.

### Alert rules exist and are wired; nothing pages a human

Prometheus is configured with `rule_files` and an `alerting.alertmanagers` block (base
`observability-config.yaml`), and a large rule set is deployed (`base/alert-rules.yaml`,
`base/alertmanager.yaml`, both listed in `base/kustomization.yaml`) covering, among others: scrape
coverage (`TargetDown`, an expected-target-count check), node health (disk/memory pressure, OOM
kills, file descriptors), Postgres and its backups (down, connections near max, WAL archive
stalled, backup age/failure), Redis, Vault seal state (`HopeVaultSealed`, `HopeVaultDown`), MinIO
(drive offline, capacity), workload health (crash-looping, evicted pods, unavailable replicas),
GPU (temperature, memory remap failures, uncorrectable ECC errors), Temporal, the STT batch worker
and Temporal worker task failures, the observability agents themselves, MLflow, and the vLLM
serving tier.

**Every Alertmanager receiver is currently a no-op sink.** The routing tree classifies alerts by
severity (`page` / `ticket` / `default`), but every receiver block in `base/alertmanager.yaml` is
commented out (Slack, generic webhook, etc.) with an explicit owner-facing note marking that nothing is
pushed anywhere yet. Alerts fire, are evaluated correctly, and are visible in Alertmanager's own
UI/API — they do not reach a person. Closing that gap is filling in one receiver block, not
building the pipeline.

### On-call — what actually exists today

**There is no formal on-call rotation, paging tool, or escalation policy.** No PagerDuty/Opsgenie
integration exists, and no documented rotation exists anywhere in this repo (a template
placeholder — "Incident commander rota: `<on-call schedule link>`" — in
`docs/research/deployments/dr-break-glass-runbook.md` was never filled in). Practically, whoever is
doing operational work is the de facto on-call: no handoff process, no rotation calendar, and — per
the no-op receivers above — no automated page even though the alerts themselves already fire.

### Alert response procedure
Written to stay correct regardless of which alerts currently exist or fire:

1. **Acknowledge** in Alertmanager (or whatever tool eventually delivers the page) before
   investigating — an un-acknowledged alert that a second responder also picks up wastes duplicate
   effort.
2. **Identify scope.** Which service/namespace fired? Check the Argo Application health first — a
   failing sync can present as a service-health alert but actually be a stuck deploy, which has a
   different fix than a runtime bug:
   ```bash
   argocd app get hope-v2-dev
   kubectl -n hope-v2-dev get pods | grep -v Running
   ```
3. **Check Grafana** for the affected service before diving into logs — a dashboard answers "when
   did this start / is it still getting worse" faster than `kubectl logs` does.
4. **Check whether it's a known gap first.** A "service X has no metrics" alert firing is itself
   informative — it may be a real outage, or the *absence* of data tripping a stale-data check on a
   service never fully wired up. Confirm what signal actually triggered it before trusting its
   framing.
5. **Consult the relevant runbook** before improvising a fix. For a deploy-shaped incident (bad
   promotion, needs rollback), go straight to `arca/hope-v2-deployment`'s own deploy/rollback
   runbook (see [`../deployment/README.md`](../deployment/README.md) for how this repo's CI feeds
   that repo) — do not `kubectl edit`/`kubectl scale` directly; that fights GitOps the same way an
   ad-hoc rollback does.
6. **Mitigate, then follow up.** Once contained, open a ticket for the root cause under
   `docs/implementation/` per this repo's normal ticket workflow
   (`.claude/rules/00-project-context.md` §Ticket Workflow) — an incident fixed live and never
   documented tends to recur.

## Gotchas

- **"No alerting" is no longer true — "no paging" still is.** Do not describe this platform as
  unmonitored; the rule set in `base/alert-rules.yaml` is broad and evaluates today. The real gap
  is that every Alertmanager receiver is a commented-out no-op, so nothing tells a human.
- Grafana's actually-routed hostname (`grafana.taphuynh.dev`) and its own configured
  `GF_SERVER_ROOT_URL` (`grafana-dev.taphuynh.dev`) disagree — this is a known, unresolved issue in
  the deployment repo, not a sign that Grafana is unreachable.
- **The collector drops anything not on its allow-list, silently.** `redaction/phi` runs on traces,
  metrics AND logs. A bespoke attribute name never arrives — `apps/nlp`'s metrics carried `model`,
  `entity_type` and `label` and reached Prometheus stripped of all three. Use `hope.*` and add the key
  to the allow-list in the same change as the emitter.
- Before wiring a new metric, trace attribute, or log field into any of the tools above, read
  [`../telemetry-phi-guardrails.md`](../telemetry-phi-guardrails.md). The telemetry plane is a
  separate system from the usage ledger and the HIPAA audit log and must never carry clinical
  content — that page is the four-layer defense (pinned `NO_CONTENT`, an attribute allow-list, an
  OTel Collector **allow**-list, and CI assertions) that keeps it that way.

## Related

- [`../deployment/README.md`](../deployment/README.md) — how this repo's CI promotes images into the cluster GitOps repo; the actual deploy/rollback/k3s-upgrade runbooks live in `arca/hope-v2-deployment` itself
- [`../telemetry-phi-guardrails.md`](../telemetry-phi-guardrails.md) — PHI-safe telemetry rules for every new emitter
- [`../vault/README.md`](../vault/README.md), [`../vault/vm-cluster-seal-unseal.md`](../vault/vm-cluster-seal-unseal.md) — Vault operations, including the seal-state alert referenced above
- `arca/hope-v2-deployment`'s own `docs/observability-dependency-monitoring.md` and `docs/observability-dashboards.md` — the dependency-monitoring design record and the Grafana dashboard catalogue
