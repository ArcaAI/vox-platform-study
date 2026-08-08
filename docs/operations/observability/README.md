# HOPE Observability — On-Call, Alert Response & SLOs

> **Scope note.** This page describes **process**: who looks at what, how to triage, where the
> dashboards live, and the shape an SLO should take once one is defined. It deliberately does
> **not** state current coverage numbers (how many of the 11 services emit metrics/traces/logs,
> how many dependencies are monitored) — those are moving targets owned by
> [TASK-636](../../implementation/TASK-636-Observability-Coverage-And-Dependency-Monitoring/README.md),
> which is landing coverage incrementally. A number hard-coded here would be stale within days.
> **For the current coverage state, read TASK-636's own scorecard, not this page.** What this page
> asserts about *today* is limited to claims that stay true regardless of how much of TASK-636 has
> landed: the tooling itself is deployed and healthy, alerting does not exist yet, and no formal
> on-call rotation exists. Update those three claims here if and when they change; do not add
> coverage percentages.

---

## 1. What's deployed, and where it lives

Prometheus, Loki, Tempo, the OTel Collector, and Grafana are deployed and have been healthy for
an extended period
(TASK-636 §2.2: *"The tooling is fully deployed and healthy. It is the feeding that is broken."*).
That statement is about the tooling's uptime, not about how much of the platform it currently sees
— see the scope note above.

| Tool | Local dev | In-cluster (`hope-v2-dev`) |
|---|---|---|
| Prometheus | `http://localhost:9090` (`.claude/rules/00-project-context.md` §Ports) | `ClusterIP` only (`deployment/k8s/base/prometheus.yaml`) — no NodePort, no Ingress. Reach it with `kubectl -n hope-v2-dev port-forward svc/prometheus 9090:9090`, or `kubectl exec` into the pod for a live PromQL query (the method TASK-636's own audits used) |
| Grafana | `http://localhost:3001` (`.claude/rules/00-project-context.md` §Ports) | `NodePort 30300` (`deployment/k8s/base/grafana.yaml`). The manifest's `Ingress` host is the literal placeholder `grafana.local` — **not resolvable DNS**, never replaced with a real hostname. Until that's fixed, in-cluster access is `kubectl -n hope-v2-dev port-forward svc/grafana 3000:3000` or the NodePort, not a URL you can bookmark |
| Loki / Tempo | Part of the same Docker Compose observability profile (`pnpm infra:dev:up:observability`) | In-cluster only, no external access documented |

There is no separate "SRE dashboard" or status page — Grafana, at the addresses above, is the
dashboard layer. If a dashboard you expect to exist isn't there, that's a TASK-636 coverage gap,
not a wrong URL.

## 2. On-call — what actually exists today

**There is no formal on-call rotation, paging tool, or escalation policy configured for HOPE.**
No PagerDuty/Opsgenie integration, no Alertmanager deployment, and no documented rotation exists
anywhere in this repo (verified: no `pagerduty`/`on-call` hits outside archived planning docs and
template placeholders like `<on-call schedule link>` in
`docs/research/deployments/dr-break-glass-runbook.md:181`, which was never filled in). Practically,
today, whoever is doing operational work on the platform is the de facto on-call — there is no
handoff process, no rotation calendar, and no automated page.

**This is a real gap, not a documentation omission** — TASK-636's own scorecard records alerting
coverage as effectively nonexistent (no Alertmanager, no rule files) at the time that ticket was
opened, so there is currently no mechanism by which a failure *would* page anyone even if a
rotation existed. Closing that is explicitly TASK-636 R4 ("signals are actionable, not merely
collected — a failure in any [monitored] subsystem pages a human"), not this ticket.

**Until a rotation and an alerting path exist**, detection is reactive: someone doing other work
notices a problem via Grafana, `kubectl get pods`, or a report from whoever is using the system.
Keep that in mind when reading [§3](#3-alert-response-procedure) below — it describes the shape of
the response once an alert exists to trigger it, not a process that fires automatically today.

## 3. Alert response procedure

This is written to stay correct as TASK-636 lands alerting incrementally — it describes the shape
of triage, not which alerts currently exist.

1. **Acknowledge.** Once paging exists, acknowledge in whatever tool delivers the page before
   investigating — an un-acknowledged alert that a second responder also picks up wastes duplicate
   effort.
2. **Identify scope.** Which service/namespace fired? Check the Argo Application health first —
   a failing sync (see the [deployment runbook §3](../deployment/README.md#3-health-check--run-this-first))
   can present as a service-health alert but actually be a stuck deploy, which has a different fix
   than a runtime bug.
   ```bash
   argocd app get hope-v2-dev
   kubectl -n hope-v2-dev get pods | grep -v Running
   ```
3. **Check dashboards** (Grafana, [§1](#1-whats-deployed-and-where-it-lives)) for the affected
   service before diving into logs — a dashboard answers "when did this start / is it still
   getting worse" faster than `kubectl logs` does.
4. **Check whether it's a known gap first.** Given current coverage is partial (TASK-636), a
   "service X has no metrics" alert firing is itself informative — it may mean the alert threshold
   caught a real outage, or it may mean the *absence* of data tripped a stale-data alert on a
   service that was never wired up to begin with. Don't assume the alert's framing is correct;
   confirm what signal actually triggered it.
5. **Consult the relevant runbook** before improvising a fix. For a deploy-shaped incident (bad
   promotion, needs rollback), go straight to the
   [deployment runbook's rollback procedure](../deployment/README.md#5-rollback-runbook) — do not
   `kubectl edit`/`kubectl scale` directly; that fights GitOps the same way an ad-hoc rollback
   does.
6. **Mitigate, then follow up.** Once the immediate issue is contained, open a ticket for the root
   cause under `docs/implementation/` per this repo's normal ticket workflow
   (`.claude/rules/00-project-context.md` §Ticket Workflow) — an incident that's fixed live and
   never documented tends to recur.

## 4. SLO definitions — placeholder

No SLOs are currently defined for any HOPE service. This is a placeholder shape to fill in once
ownership and targets are decided — do not treat the example row as a real commitment.

| Service | SLI | Target (placeholder) | Error budget window | Owner |
|---|---|---|---|---|
| _e.g._ `hope-api` | _e.g._ request success rate | _TBD_ | _TBD_ | _TBD_ |
| `hope-stt-v2` | | | | |
| `hope-smr` | | | | |
| `hope-guardrail` | | | | |
| `hope-nlp` | | | | |
| `hope-harness` | | | | |
| `hope-tts` | | | | |

When this gets filled in, the SLI should be sourced from a metric that already exists in
Prometheus for that service (per TASK-636's coverage work), not a new bespoke measurement — check
TASK-636's scorecard for what's actually queryable before committing to an SLI.

## 5. Dependency monitoring — where it's headed

The platform's runtime dependencies — TimescaleDB HA (Patroni), PgBouncer, Redis, MinIO, Qdrant,
Temporal, Vault, the k3s node itself, and the GPU — are TASK-636's R3 requirement
("every runtime dependency is monitored... with alerts on their failure modes"). As of this
writing none of them are, which is exactly the class of gap that caused the 2026-08-06 DiskPressure
incident to go unnoticed until it became a live outage (referenced in
`docs/operations/vault/vm-cluster-seal-unseal.md` §8's own callout: *"a sealed seal-Vault is silent
until the next Raft restart fails... a failing cron is silent until you need a restore"* — the same
principle applies to every dependency in this list). Don't re-verify the exact count here; check
TASK-636 directly, since it changes as that ticket lands each dependency.

## 6. PHI safety — read before enabling anything new

Before wiring a new metric, trace attribute, or log field into any of the tools in
[§1](#1-whats-deployed-and-where-it-lives), read
[`docs/operations/telemetry-phi-guardrails.md`](../telemetry-phi-guardrails.md). The telemetry
plane is explicitly a separate system from the usage ledger and the HIPAA audit log, and it must
never carry clinical content — that page is the four-layer defense (pinned `NO_CONTENT`, an
attribute allow-list, an OTel Collector deny-list, and CI assertions) that keeps it that way.

## Related

- [`docs/operations/deployment/README.md`](../deployment/README.md) — deploy/rollback/k3s-upgrade runbooks; §3's health check and §4's smoke check are the first things to run during triage
- [TASK-636](../../implementation/TASK-636-Observability-Coverage-And-Dependency-Monitoring/README.md) — the live coverage scorecard and defect register; the authoritative source for "how much is actually observable right now"
- [`docs/operations/telemetry-phi-guardrails.md`](../telemetry-phi-guardrails.md) — PHI-safe telemetry rules for every new emitter
- [`docs/operations/vault/vm-cluster-seal-unseal.md`](../vault/vm-cluster-seal-unseal.md) — a worked example of "no alerting on a silent failure mode" biting in production (§8), and the runbook style this page and the deployment runbook follow

---

## Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Initial version (TASK-622 B.2) — on-call process, alert-response procedure, and an SLO-definition placeholder. Deliberately omits coverage numbers (metrics/traces/logs/dependency percentages) since TASK-636 is landing those incrementally; points to TASK-636's own scorecard instead. States plainly that no formal on-call rotation or alerting/paging mechanism currently exists. | Claude |
