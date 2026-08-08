# TASK-636 — Observability Coverage & Dependency Monitoring

| Field | Value |
|---|---|
| **Status** | `In Progress` — Phase 1 partial (6 defects closed, verified); Phases 2–7 not started |
| **Type** | `infrastructure` |
| **Created** | 2026-08-08 |
| **Supersedes** | TASK-616 Phase 4 (planned as TASK-620 — **never created**; all its open items are inherited here) |
| **Scope** | `infrastructure/docker/**` · `apps/{api,stt,smr,guardrail,nlp,harness,tts}/**` · `packages/applications/src/services/baseServices/{logging,observability,metrics}/**` · `turbo.json` · the external config repo `arca/hope-v2-deployment` |
| **Related** | [TASK-616](../TASK-616-Deployment-CICD-Observability-Modernization/README.md) (parent assessment) · [TASK-627](../TASK-627-Service-Health-Probes-And-Lifecycle-Standards/README.md) (probes/lifecycle) · [TASK-615](../TASK-615-Usage-Metering-And-Billing/README.md) (usage metering — separate plane, do not conflate) |

---

## 1. Requirement Analysis

> **Requirement (owner, 2026-08-08)**: "review the stack, we need to make sure all apps/services logs and metrics are captured properly to the observable tools" — extended in-thread with "we also need to monitor the dependencies such as TimescaleHA cluster, temporal, etc."

Decomposed into four acceptance requirements:

| ID | Requirement | Definition of satisfied |
|---|---|---|
| **R1** | **Every app/service emits metrics and they reach Prometheus** | All 11 deployed workloads (+ both worker processes) appear as `up=1` targets with non-empty series, in dev AND in cluster |
| **R2** | **Every app/service emits logs and they reach Loki** | Every workload's container logs are queryable in Loki within seconds, correctly labelled by `service_name` + environment |
| **R3** | **Every runtime dependency is monitored** | TimescaleDB HA (Patroni), PgBouncer, Redis, MinIO, Qdrant, Temporal, Vault, the k3s node itself, and the GPU all produce metrics with alerts on their failure modes |
| **R4** | **Signals are actionable, not merely collected** | A failure in any of the above pages a human; dashboards exist per subsystem; PHI never reaches a telemetry backend |

**Explicitly out of scope** (owned elsewhere): CI/CD promotion (TASK-619), k3s hardening / NetworkPolicy (TASK-618), health-probe semantics (TASK-627), usage metering and billing (TASK-615 — a *business* ledger, not a telemetry signal; the two must not be merged).

**Non-negotiable constraint (inherited, TASK-411)**: services may *expose* `/metrics` and *push* OTLP, but must **never require a reachable observability backend** to start, serve traffic, or stay quiet in logs. Local dev runs with zero observability tools by default. Every gate added by this ticket defaults OFF and fails open.

---

## 2. Current State Evaluation

### 2.1 Method

Two independent passes, 2026-08-08:

1. **Static** — read `infrastructure/docker/**`, every service's metrics/telemetry module, `packages/applications` logging transports, `turbo.json`.
2. **Live** — read-only inspection of cluster `c-nfhxq` (`hope-v2-dev`) via the Rancher MCP: workload health, the `observability-config` ConfigMap, and **direct PromQL / Loki API queries executed from inside the running Prometheus pod** (`prometheus-6c497645f7-d5dbt`).

Every claim below carries a `file:line` citation or a live query result. Where this pass **contradicts or refines** the TASK-616 O-register, that is stated explicitly.

### 2.2 The one-line summary

> **The tooling is fully deployed and healthy. It is the feeding that is broken.**

Prometheus, Loki, Tempo, the OTel Collector and Grafana are all `1/1 Ready` and have been for 127 days. Between them they observe roughly a quarter of the platform and zero of its dependencies.

### 2.3 Live coverage scorecard (measured, not estimated)

| Signal | Coverage | Query / evidence |
|---|---|---|
| **Metrics** | **3 of 11** workloads — `api-gateway`, `stt-v2`, `smr`. Plus 4 self-monitoring jobs (`loki`, `tempo`, `grafana`, `prometheus`). All 7 targets `up=1`, none down | `observability-config` → `prometheus.yml`; `query=up`, `query=up==0` → empty |
| **Traces** | **1 of 11** — `hope-api` only, and it is genuinely live (**4,815 spans in the last 15 min**) | `count by (service)(traces_spanmetrics_calls_total)` → `{service="hope-api"} 30`; `sum(increase(traces_spanmetrics_calls_total[15m]))` → `4815.5` |
| **Logs** | **3 of 11** `service_name` values in Loki; only **2 active in the last hour** | `/loki/api/v1/label/service_name/values` → `["hope-api","hope-stt-v2","hope-stt-v2-worker-worker"]`; `/index/volume` → only `hope-stt-v2` (2.0 MB), `hope-api` (1.1 MB) |
| **Alerting** | **Zero** | No `rule_files`, no `alerting:` block, no Alertmanager workload, no Loki ruler rules |
| **Dependencies** | **Zero** | Scrape config is 3 app jobs + 4 self-jobs. Nothing else |

**Dark on all three signals** (10 of 13 runtime units): `guardrail`, `nlp`, `harness`, `tts`, `admin-console`, `compat-playground`, `hope-ui`, `ollama`, `temporal`, `vault` — plus the **STT Dramatiq worker** (logs only) and the **harness Temporal worker** (nothing; and per TASK-616 §B1 Q4 it is not even running in-cluster).

### 2.4 Defect register

Severity: **Critical** = a whole signal or subsystem is invisible · **High** = material blind spot or PHI risk · **Medium** = correctness/usability · **Low** = hygiene.

Column `Origin`: `616` = inherited from the TASK-616 O-register (re-verified this pass) · `NEW` = first identified in this pass · `REFINED` = inherited but materially corrected.

#### A. Metrics coverage

| ID | Sev | Origin | Defect | Evidence |
|---|---|---|---|---|
| **OBS-01** | Critical | REFINED (O-03) | Cluster Prometheus scrapes **3 of 11** workloads, not 3 of 7. Guardrail, NLP, harness, TTS, admin-console, compat-playground, hope-ui, ollama, temporal, vault all have zero metrics | live `observability-config` ConfigMap `prometheus.yml` |
| **OBS-02** | Critical | **NEW** | **NLP `/metrics` returns HTTP 404 — the endpoint is not mounted at all.** Root cause: `setup_prometheus()` passes `should_respect_env_var=True, env_var_name="ENABLE_METRICS"`, and `ENABLE_METRICS` is set in **no** environment. The service is otherwise healthy on the same port (`uptime 407,850s`) | [nlp/core/observability.py:155-169](../../../apps/nlp/src/nlp/core/observability.py#L155); live `wget http://hope-nlp:8864/metrics` → `404`, `…/api/v1/health` → `{"status":"healthy"}` |
| **OBS-03** | High | **NEW** | **NLP metric-namespace contradiction.** `setup_prometheus` passes `metric_namespace="nlp"`, so its HTTP series are `nlp_http_*`. The dev scrape config's `metric_relabel_configs` rule matches `__name__ =~ "http_.*"` and its own comment claims NLP "was `nlp_http_*` until aligned with the rest of the fleet". **It was never aligned** — the `service` label will never be stamped on NLP metrics, silently breaking `sum by (service)(…)` in `PlatformMetricsService` | [nlp/core/observability.py:166](../../../apps/nlp/src/nlp/core/observability.py#L166) vs [prometheus.yml](../../../infrastructure/docker/configs/prometheus/prometheus.yml) NLP job comment |
| **OBS-04** | High | REFINED (O-05) | **Dev `prometheus.yml` omits TTS (8865)** although TTS exposes `/metrics` via the standard instrumentator gate. Six services scraped, seven exist | [tts/main.py:170-173](../../../apps/tts/src/tts/main.py#L170); dev `prometheus.yml` has no `tts` job |
| **OBS-05** | High | **NEW** | **The STT Dramatiq batch worker exposes no Prometheus endpoint.** It configures OTel *logs* only (gated on `otel_enabled`), never a metrics reader or an HTTP exposer. Batch transcription throughput, queue depth, job duration and failure rate are unmeasurable | [stt/worker.py:37-46](../../../apps/stt/src/stt/worker.py#L37); `grep -n "prometheus\|start_http_server\|metrics" stt/worker.py core/worker_loop.py transcription/workers/*.py` → 0 hits |
| **OBS-06** | High | **NEW** | **The harness Temporal worker has no metrics runtime.** `pnpm worker:dev` → `python -m harness.temporal.worker`; the Temporal Python SDK's `Runtime(telemetry=TelemetryConfig(metrics=PrometheusConfig(bind_address=…)))` is never constructed. Every durable workflow — task-queue latency, activity failures, workflow-task timeouts — is invisible | [scripts/dev-service.sh](../../../scripts/dev-service.sh) `worker)` case; `grep "metric\|prometheus" harness/temporal/worker.py` → only an unrelated `RuntimeError` |
| **OBS-07** | Medium | 616 (O-17) | 100% `static_configs` — no `kubernetes_sd_configs`, no ServiceMonitor CRDs. Every new service needs a manual scrape-target edit in two places (dev file + cluster ConfigMap), which is precisely how OBS-01/04 arose | both prometheus configs |

**Free wins — verified reachable from inside the Prometheus pod this session, and simply not listed:**

```
hope-guardrail:8863/metrics                      REACHABLE
hope-harness:8866/metrics                        REACHABLE
hope-tts:8865/metrics                            REACHABLE
nvidia-dcgm-exporter.gpu-operator:9400/metrics   REACHABLE (92 DCGM metrics)
```

Four scrape stanzas move cluster coverage from 3/11 to 6/11 **plus full GPU telemetry**, with zero code change.

#### B. Log pipeline

| ID | Sev | Origin | Defect | Evidence |
|---|---|---|---|---|
| **OBS-08** | Critical | REFINED (O-08) | **8 of 11 workloads ship no logs anywhere but `kubectl logs`.** The O-register said "nothing ships to Loki"; that is now too pessimistic — the app-side OTLP push path *works* for `hope-api` and `hope-stt-v2`. What is missing is a **node-level container-log shipper**, so anything without in-app OTLP export is invisible | `/loki/api/v1/label/service_name/values` → 3 values; `grep -r "promtail\|alloy\|fluent-bit"` → 0 matches |
| **OBS-09** | Medium | **NEW** | **`hope-stt-v2-worker-worker`** — the Dramatiq worker double-suffixes its OTel service name: `f"{settings.otel_service_name}-worker"` applied to a name that already ends in `-worker`. Pollutes the `service_name` label space and breaks any dashboard variable built on it | [stt/worker.py:41-45](../../../apps/stt/src/stt/worker.py#L41); live Loki label values |
| **OBS-10** | High | **NEW** | **`LOKI_ENABLED` / `LOKI_HOST` are read at runtime but undeclared in `turbo.json#globalEnv`.** A fully-implemented Loki push transport exists in the applications package and Turbo will not pass its config through — the transport can never be enabled through the normal env path. Violates the project rule "new runtime env vars must be added to `turbo.json#globalEnv`" | [logging.service.ts:125-144](../../../packages/applications/src/services/baseServices/logging/logging.service.ts#L125); `grep "LOKI" turbo.json` → 0 hits |
| **OBS-11** | Medium | **NEW** | Loki runs single-replica on **filesystem** storage with `retention_period: 168h`, `replication_factor: 1`, `ring.kvstore: inmemory`, on a node that has already hit DiskPressure. Log loss on eviction is expected behaviour, not an edge case | live `observability-config` → `loki-config.yaml` |

#### C. Tracing

| ID | Sev | Origin | Defect | Evidence |
|---|---|---|---|---|
| **OBS-12** | Critical | 616 (O-04) | **Guardrail has zero OpenTelemetry code.** The content-safety / PII / prompt-injection engine — the most compliance-sensitive service on the platform — cannot be traced at all | `grep -rl opentelemetry apps/guardrail/src --include=*.py` → **0 files** |
| **OBS-13** | Critical | 616 (O-05) | **TTS has zero OpenTelemetry code** | `grep -rl opentelemetry apps/tts/src --include=*.py` → **0 files** |
| **OBS-14** | High | 616 (O-07) | **Harness has no `TracerProvider`.** The only `opentelemetry` reference in the whole service is a comment in `config.py` explaining that no provider is constructed | `grep -rn "TracerProvider\|set_tracer_provider" apps/harness/src` → 1 hit, a comment at [config.py:479](../../../apps/harness/src/harness/core/config.py#L479) |
| **OBS-15** | High | 616 (O-02) | NLP's real tracing gate is `NLP_OTEL_ENABLED` (default `false`), distinct from the generic `OTEL_*` flags the overlays set — never enabled anywhere, despite NLP having the most complete OTel implementation of any Python service | [nlp/core/config.py:132,176](../../../apps/nlp/src/nlp/core/config.py#L132) |
| **OBS-16** | High | 616 (O-16) | **No trace-context propagation across async boundaries.** Server-side, `traceparent` appears only in the CORS allow-list. Redis Streams, SSE, WebSocket and Temporal hops all sever the trace — which is why the one working trace never leaves the gateway. (The browser SDK *does* generate `traceparent`; the server never continues it across a queue) | [cors.headers.ts:31](../../../apps/api/src/cors.headers.ts#L31) is the only server hit; contrast [AgenticClient.ts:217-219](../../../packages/agentic-sdk-v2/src/core/AgenticClient.ts#L217) |
| **OBS-17** | Medium | 616 (O-01) | The API's OTel SDK is loaded only via `node --import ./dist/instrumentation.js` (i.e. `start`/`start:prod`/Docker, never `pnpm dev`) and requires `OTEL_EXPORTER_OTLP_ENDPOINT`. Staging/prod overlays flip `OTEL_TRACES_ENABLED`, **which the code does not read** | [instrumentation.ts:16-24](../../../apps/api/src/instrumentation.ts#L16) |

#### D. Environment labelling & PHI safety

| ID | Sev | Origin | Defect | Evidence |
|---|---|---|---|---|
| **OBS-18** | Critical | REFINED (O-06/O-15) | **Environment is mislabelled from two directions at once.** The collector's `resource` processor **upserts `deployment.environment: "dev"`** unconditionally, while STT's resource builder **hardcodes `deployment.environment: "production"`**. Whichever wins, telemetry outside dev is wrong, and STT's own attribute disagrees with the collector's in the same pipeline | live `otel-collector-config.yaml` `processors.resource`; [stt/core/telemetry.py:46](../../../apps/stt/src/stt/core/telemetry.py#L46) |
| **OBS-19** | Critical | REFINED (O-13/O-14) | **No PHI redaction anywhere in the telemetry path.** The collector pipeline is `memory_limiter, resource, batch` — **no `redaction` processor, no attribute allowlist**. NLP defines a span-redaction hook and never wires it. The backend logging package declares `redactFields?: string[]` and **never reads it**. Only the browser SDK actually implements redaction. Turning tracing on for the Python services before this lands would push clinical payloads into Tempo | live `otel-collector-config.yaml`; [nlp/core/observability.py:34-38](../../../apps/nlp/src/nlp/core/observability.py#L34) vs `:108-127`; [transports/types.ts:319](../../../packages/applications/src/services/baseServices/logging/transports/types.ts#L319) — declared, zero readers |

> **Gate**: OBS-19 **must close before** OBS-12/13/14/15 (broad tracing enablement). This ordering is not negotiable — it is the same `4.1 before 4.3` rule inherited from TASK-616 Phase 4.

#### E. Dependency & platform monitoring — the largest hole

**Nothing outside the app tier is monitored at all.** Not one dependency.

| ID | Sev | Origin | Dependency | Metrics source | Current state |
|---|---|---|---|---|---|
| **OBS-20** | Critical | **NEW** | **TimescaleDB HA** (VMs 500–502, Patroni 4.1 + PG 18 + TimescaleDB 2.25) | `postgres_exporter:9187` **and** Patroni's own `:8008/metrics` | **Both specified in the runbook** ([deploy-vm500-502-postgres-ha.md](../../research/deployments/deploy-vm500-502-postgres-ha.md) §11, port table L81/L88) — **scraped by nothing**. No replication-lag, failover, connection-saturation, WAL, or checkpoint visibility on the platform's primary datastore |
| **OBS-21** | High | **NEW** | **PgBouncer** | `pgbouncer_exporter:9127` | Scrape config *and a complete alert rule set* already written at [docs/research/configs/postgres-ha/prometheus/](../../research/configs/postgres-ha/prometheus/) — never deployed. A `pgbouncer.json` Grafana dashboard also exists, orphaned (see OBS-27) |
| **OBS-22** | Critical | **NEW** | **Temporal** | server metrics via `PROMETHEUS_ENDPOINT` env | Not set — `hope-temporal:9090/metrics` **unreachable** (verified). Compounding: **two Temporal servers still run simultaneously** (host-Docker pair + in-cluster), so even once enabled it must be pointed at the surviving one |
| **OBS-23** | High | **NEW** | **Redis** (VMs 420–421) | `redis_exporter` | A working compose exists at [docs/research/configs/redis/docker-compose.yml:30](../../research/configs/redis/docker-compose.yml#L30) — research only, never deployed. Note Redis persistence is deliberately **disabled** (PHI posture), which makes memory-pressure and eviction metrics more important, not less |
| **OBS-24** | High | **NEW** | **MinIO** (VM 402) | native `/minio/v2/metrics/cluster` | Not scraped. No bucket-capacity or S3-error visibility |
| **OBS-25** | Medium | **NEW** | **Vault** | `/v1/sys/metrics` | A **ServiceMonitor and alert rules are already written** at [infrastructure/single-deployment/vault/](../../../infrastructure/single-deployment/vault/) (manifests + `monitoring/alerts.yaml`) — never applied. Now materially more important post-TASK-616 Track V (Vault HA on VMs 430–432/434) |
| **OBS-26** | Critical | **NEW** | **The k3s node itself** | kube-state-metrics · node-exporter · cAdvisor/kubelet | **None deployed.** Only `metrics-server` (HPA-only, not a Prometheus source). **This is not theoretical: the node hit DiskPressure on 2026-08-06 and evicted pods across the namespace — including Prometheus itself, four separate times. Node-level monitoring would have caught it. Nothing did, and nothing alerted.** `/mnt/data` (the STT model-cache `hostPath`) sat at 89% |
| **OBS-27** | High | **NEW** | **GPU** | `nvidia-dcgm-exporter` | **Already running and reachable** in the `gpu-operator` namespace (92 metrics, verified). Completely unscraped. This is the single cheapest dependency win on the list |
| **OBS-28** | Medium | **NEW** | **Qdrant** | native `/metrics` | Not deployed in-cluster at all (TASK-624 owns deployment); add the scrape job as part of that work, not this one |

#### F. Dashboards, alerting, multi-environment, governance

| ID | Sev | Origin | Defect | Evidence |
|---|---|---|---|---|
| **OBS-29** | Critical | 616 (O-09) | **No alerting layer exists.** No Alertmanager, no `rule_files`, no Loki ruler rules, no routing. `evaluation_interval: 15s` is configured with nothing to evaluate. **An incident pages nobody** | live `prometheus.yml`; `grep -r alertmanager` → 0 matches |
| **OBS-30** | High | REFINED (O-12) | **9 purpose-built dashboards are orphaned from *both* stacks.** `infrastructure/grafana/dashboards/` holds `smr-overview`, `smr-resilience`, `smr-security`, `smr-cache-friendliness`, `consumption`, `agentic-trajectory`, `model-retention`, `optimistic-locking`, `pgbouncer` (9, not 8). They are mounted **only** by the standalone [apps/smr/docker-compose.yml:71](../../../apps/smr/docker-compose.yml#L71). The **main dev** Grafana mounts `configs/grafana/dashboards/` which contains exactly **one** file; the **cluster** Grafana ships one dashboard with a single `up` panel. `infrastructure/grafana/provisioning/dashboards.yml` (SMR + PgBouncer providers) is likewise mounted by nothing | compose volume mounts vs directory listings |
| **OBS-31** | Medium | 616 (O-10) | Per-namespace isolated Prometheus/Loki/Tempo/Grafana with **identical fixed datasource UIDs** and ClusterIP-only services. No federation, no remote-write aggregation. One Grafana cannot serve dev+staging+prod as built | live `grafana-datasources.yaml` |
| **OBS-32** | Medium | 616 (O-11) | Grafana Ingress host is patched only by the dev overlay; staging and prod both fall back to `grafana.local` and collide | deployment repo `base/grafana.yaml` |
| **OBS-33** | Medium | **NEW** | **Retention is too short to investigate anything.** Prometheus `7d`/`10GB`, Loki `168h`, Tempo `72h` block retention — all on node-local storage with no object-store backend and no long-term tier. A postmortem on a two-week-old incident is impossible | live deployment args + configs |
| **OBS-34** | Medium | **NEW** | **A dead-pod graveyard masks real health.** `hope-v2-dev` carries dozens of `Succeeded`/`Error`/`Evicted` pods going back 126 days (11 `loki`, 10 `otel-collector`, 7 `temporal`, 6 `grafana`, 5 `prometheus`, …). Any human or tool listing pods sees noise; `kubernetes_exec` against an observability pod hits a dead one by default | live pod list vs `workload_health` (every Deployment is genuinely `1/1`) |
| **OBS-35** | Low | 616 (O-18) | Grafana auth is one shared admin credential, no SSO, no per-user RBAC, no query audit. Dev Grafana additionally enables **anonymous Viewer**. For a PHI platform, dashboard access is an audit surface | `docker-compose.dev.yml:334-341`; deployment repo `base/grafana.yaml` |
| **OBS-36** | Low | 616 (O-19) | **No SLOs, error budgets, or on-call runbooks.** `docs/operations/` has no observability content | `ls docs/operations/` → 8 entries, none observability |

### 2.5 What is genuinely good (do not rebuild these)

An honest assessment — several pieces are well-engineered and only need wiring:

- **Grafana datasource cross-linking** is excellent: trace→logs (`tracesToLogsV2` with a custom LogQL query keyed on `service.name` + `traceId`), trace→metrics, logs→traces via `derivedFields` on two regex shapes, and Prometheus `exemplarTraceIdDestinations`. This is the hard part of correlation and it is already correct.
- **Tempo's `metrics_generator`** is configured with `service-graphs` + `span-metrics`, remote-writing to Prometheus with exemplars. It is why `hope-api` already has RED metrics for free.
- **Prometheus has `--web.enable-remote-write-receiver`**, so both the collector's `prometheusremotewrite` exporter and Tempo's generator land correctly. *(Verified — this was a plausible silent-failure mode and it is not one.)*
- **The API's OTel shutdown discipline** — `flushOtel()` deliberately installs no signal handlers and is registered through `GracefulShutdownService`, with a comment explaining the WebSocket/SSE drain race it previously caused.
- **A complete Loki push transport already exists** in `packages/applications` (`loki.transport.ts`), alongside `otel.transport.ts`, `otel-log-bridge.transport.ts` and `highlight.transport.ts`. OBS-10 is a one-line env declaration, not an implementation.
- **The dev opt-in invariant (TASK-411)** is correctly implemented across all six Python services and the gateway — every exporter is behind a default-off flag. Preserve this.
- **`redactPHI` is fully implemented and tested** in the browser SDK ([redactor.ts](../../../packages/agentic-sdk-v2/src/core/logger/redactor.ts)) with a `DEFAULT_PHI_REDACT_FIELDS` set. OBS-19's backend fix has a working reference implementation in-repo.

### 2.6 Best practices to apply (2026 baseline)

| Practice | Rationale for HOPE |
|---|---|
| **Grafana Alloy, never Promtail** | Promtail reached EOL **2026-03-02**. Alloy is the supported OTel-native shipper |
| **Collector as agent DaemonSet + gateway Deployment** | Node-local agents for reliability/back-pressure; a single gateway is the *only* correct place for the redaction processor and tail sampling — one enforcement point, not eleven |
| **Attribute allowlist, never a denylist** | A denylist fails open on every new attribute. For PHI, only an allowlist is defensible |
| **Prometheus Operator + ServiceMonitor over `static_configs`** | Directly prevents OBS-01/04 recurring: new service ⇒ new ServiceMonitor beside it, not an edit in two remote files |
| **`up` is not coverage** | All 7 targets report `up=1` today while 8 workloads are invisible. Alert on *expected-target-count*, not just target health |
| **RED for services, USE for dependencies** | Rate/Errors/Duration from Tempo span-metrics (already generating); Utilization/Saturation/Errors from the exporters in Phase 2 |
| **Exemplars end-to-end** | Already half-built (Prometheus exemplar destination + Tempo `send_exemplars: true`). Completing it makes every latency spike one click from a trace |
| **Object-store backends for Loki/Tempo** | MinIO already runs on VM 402. Node-local telemetry storage on a DiskPressure-prone node is a guaranteed data-loss path (OBS-11/33) |
| **Alert on symptoms, page on user impact** | Ties directly to the SLOs owed in OBS-36 |
| **Cardinality budget per service** | `traces_spanmetrics_latency_bucket` is already the single largest metric (3,300 of 15,338 head series) from **one** service. Extrapolating to 11 without a budget will OOM a 1 GiB-limited Prometheus |

---

## 3. Implementation Plan

### 3.1 Shape of the work

**8 phases, 6 parallel agent lanes.** Phases 1–2 are independent and start immediately. Phase 3 gates all broad tracing work. The lanes are designed so that no two agents write the same file.

```
        ┌──────────────────────────────────────────────────────────┐
   P0   │ Lane O: Baseline, conventions, cardinality budget        │  ← blocks nothing, informs all
        └──────────────────────────────────────────────────────────┘
   P1   │ Lane A: Metrics coverage (scrape configs + service fixes)│  ─┐
   P2   │ Lane B: Dependency & platform exporters                  │  ─┼─ parallel from t=0
   P3   │ Lane C: PHI redaction + env labelling      ★ GATE        │  ─┘
              │
              ▼ (C must be green before D)
   P4   │ Lane D: Tracing enablement + context propagation         │
   P5   │ Lane E: Log pipeline (Alloy + transports)                │  ─ parallel with D
   P6   │ Lane F: Alerting, SLOs, dashboards                       │  ─ needs A+B series to exist
   P7   │ Lane O: Multi-env, retention, governance, docs           │
```

### 3.2 Agent tier assignment

Per the owner's complexity table. **Effort level** is the reasoning-effort setting, not a time estimate.

| Lane | Phase | Complexity | **Tier** | Effort | Why this tier |
|---|---|---|---|---|---|
| **A1** | P1 | Trivial | `haiku-4-5` | default | Adding scrape stanzas to two YAML files against a verified-reachable target list. Pure mechanical edit |
| **A2** | P1 | Moderate | `sonnet-5` | medium | Python service fixes (OBS-02/03/09) — small, localised, but need TDD and an understanding of instrumentator semantics |
| **A3** | P1 | Complex | `sonnet-5` | high | Worker metrics (OBS-05/06) — new exposition in two worker runtimes, process-model tradeoffs (Dramatiq forks; multiprocess registry) |
| **B1** | P2 | Moderate | `sonnet-5` | medium | Exporter deployment for Timescale/PgBouncer/Redis/MinIO/Vault. Configs already written in-repo; this is deploy + wire + verify |
| **B2** | P2 | Trivial | `haiku-4-5` | default | DCGM + Temporal `PROMETHEUS_ENDPOINT` scrape stanzas. Two edits |
| **B3** | P2 | Complex | `sonnet-5` | high | kube-state-metrics + node-exporter + cAdvisor on a **single-node, DiskPressure-prone** cluster — resource budgeting and cardinality control matter |
| **C** | P3 | **Very high** | **`opus-5`** | high | **PHI redaction architecture.** Allowlist design, gateway topology, the two-directional env-label bug, and a compliance boundary that must fail closed. Get this wrong and clinical data lands in a trace store |
| **D1** | P4 | Complex | `sonnet-5` | high | Add OTel to guardrail + TTS from zero; add a TracerProvider to harness. Three services, established in-repo pattern (SMR/NLP) to copy |
| **D2** | P4 | **Very high** | **`opus-5`** | max | **Trace-context propagation across Redis Streams, SSE, WebSocket and Temporal.** Long-horizon, cross-cutting, four different async transports, must survive STT streaming and workflow replay. The hardest item in the ticket |
| **E1** | P5 | Complex | `sonnet-5` | high | Grafana Alloy DaemonSet + Loki object-store backend |
| **E2** | P1/P5 | Trivial | `haiku-4-5` | default | `turbo.json#globalEnv` + `.env.sample` declarations (OBS-10) |
| **F1** | P6 | Complex | `sonnet-5` | high | Alert rules + Alertmanager routing. Judgement-heavy (symptom vs cause, page vs ticket) but well-trodden |
| **F2** | P6 | Moderate | `sonnet-5` | medium | Repackage the 9 orphaned dashboards; fix both mount paths |
| **O** | P0/P7 | **Very high** | **`opus-5`** or `fable-5` | max | Cross-env architecture (single Grafana + tenanted backends vs per-env), retention tiering, SLO definition, cardinality budget. Open-ended design with real tradeoffs |

**Coordination rules for the agent team:**

1. **File ownership is exclusive per lane.** Lane A owns `infrastructure/docker/configs/prometheus/prometheus.yml` and the cluster `observability-config` `prometheus.yml` key. Lane C owns the `otel-collector-config.yaml` key. Lane E owns the Alloy manifests. If a lane needs an edit in another's file, it files it as a hand-off note, it does not edit.
2. **Every lane re-verifies before claiming done.** Coverage claims must be backed by a live PromQL/LogQL query pasted into this README, not by "the config looks right." That standard is why this assessment found OBS-02 and OBS-03 — the configs *did* look right.
3. **No lane may weaken the TASK-411 invariant.** Every new gate defaults OFF and must not break startup when its backend is unreachable.
4. **Two repos.** App-side changes land in `hope-v2`; manifests land in `arca/hope-v2-deployment`. Every lane states which repo each change targets.

### 3.3 Phase detail

#### Phase 0 — Baseline & conventions · Lane O · `opus-5`

| Step | Deliverable | Verify |
|---|---|---|
| 0.1 | **Capture the "before" scorecard** — snapshot the §2.3 queries with timestamps into this README as the immutable baseline | The exact PromQL/LogQL used is recorded, reproducible by any lane |
| 0.2 | **Write `docs/operations/observability/METRIC-CONVENTIONS.md`** — naming (`http_*` un-namespaced, fleet-wide), required labels (`service`, `deployment.environment.name`, `tenant_id` **only** where already non-PHI), a per-service **cardinality budget**, and the rule that `metric_namespace` is never used (OBS-03's root cause) | Lane A/B can name a new metric without asking |
| 0.3 | **Define the expected-target inventory** as data (a YAML list of 13 runtime units + 9 dependencies), so Phase 6 can alert on *missing* targets, not just down ones | The list exists and OBS-01 becomes machine-detectable |

#### Phase 1 — Metrics coverage · Lanes A1/A2/A3 · start immediately

| Step | Lane | Tier | Closes | Instruction | Verify |
|---|---|---|---|---|---|
| 1.1 | A1 | `haiku-4-5` | OBS-01, OBS-27 | Add scrape jobs for `hope-guardrail:8863`, `hope-harness:8866`, `hope-tts:8865`, `nvidia-dcgm-exporter.gpu-operator:9400` to the cluster `observability-config` ConfigMap. **All four are verified reachable** — no discovery needed | `up{job=~"guardrail\|harness\|tts\|dcgm"} == 1` (4 series); `count(DCGM_FI_DEV_GPU_UTIL) > 0` |
| 1.2 | A1 | `haiku-4-5` | OBS-04 | Add a `tts` job (`host.docker.internal:8865`) to the dev `prometheus.yml`, matching the existing `metric_relabel_configs` pattern | Dev Prometheus shows 7 app targets up |
| 1.3 | A2 | `sonnet-5` | OBS-02 | Fix NLP `/metrics`. **Preferred**: drop `should_respect_env_var` + `env_var_name` so NLP matches the other five services (all use a plain `settings.metrics_enabled` gate). **Alternative**: set `ENABLE_METRICS=true` in every env. Prefer the code fix — six services should not have six different gates | `wget http://hope-nlp:8864/metrics` → `200`; add a unit test asserting the route is mounted |
| 1.4 | A2 | `sonnet-5` | OBS-03 | Remove `metric_namespace="nlp"` so NLP emits `http_*` like the fleet. Then **correct the stale comment** in the dev `prometheus.yml` NLP job, which already claims this was done | `nlp` job series are `http_*`; `sum by (service)(rate(http_requests_total[5m]))` includes `nlp` |
| 1.5 | A2 | `sonnet-5` | OBS-09 | Fix the double-suffix: `service_name` for the STT worker must be `hope-stt-v2-worker`, not `…-worker-worker` | Loki `service_name` values contain no doubled suffix |
| 1.6 | A3 | `sonnet-5` (high) | OBS-05 | Add Prometheus exposition to the STT Dramatiq worker. **Dramatiq forks processes** — use `prometheus_client` multiprocess mode (`PROMETHEUS_MULTIPROC_DIR`) or a per-process port offset; do not naively `start_http_server` in each fork. Emit: jobs consumed, job duration, failures by reason, queue depth. Gate behind the existing `metrics_enabled` setting | A batch transcription increments a job counter; two worker processes do not collide on a port |
| 1.7 | A3 | `sonnet-5` (high) | OBS-06 | Add a Temporal SDK metrics runtime to the harness worker: `Runtime(telemetry=TelemetryConfig(metrics=PrometheusConfig(bind_address="0.0.0.0:9464")))`. Add the scrape job. **Note**: TASK-616 §B1 Q4 found the worker is not deployed in-cluster at all — coordinate with TASK-625; in dev, `pnpm worker:dev` is sufficient to verify | `curl localhost:9464/metrics` from the worker shows `temporal_*` series after one workflow |
| 1.8 | E2 | `haiku-4-5` | OBS-10 | Add `LOKI_ENABLED`, `LOKI_HOST`, `LOKI_LABELS` to `turbo.json#globalEnv`, `.env.dev`, and regenerate `.env.sample` via `pnpm env:sync` | `pnpm env:sync --check` green; setting `LOKI_ENABLED=true` actually reaches the transport |

#### Phase 2 — Dependency & platform monitoring · Lanes B1/B2/B3 · start immediately

> This phase is what the owner's follow-up asked for and it is the **largest single gap**. Most of the configs already exist in-repo as research artifacts; the work is deploy + scrape + alert, not author-from-scratch.

| Step | Lane | Tier | Closes | Instruction | Verify |
|---|---|---|---|---|---|
| 2.1 | B1 | `sonnet-5` | **OBS-20** | **TimescaleDB HA.** Deploy `postgres_exporter:9187` on VMs 500–502 per runbook §11, and scrape **Patroni's own `:8008/metrics`** (often overlooked — it is where failover state lives). Both are already specified; neither is running | `pg_up == 1` × 3; `patroni_primary` identifies exactly one leader; replication lag charts |
| 2.2 | B1 | `sonnet-5` | OBS-21 | **PgBouncer.** Deploy `pgbouncer_exporter:9127`. The scrape config **and alert rules already exist** at `docs/research/configs/postgres-ha/prometheus/` — promote them out of research | `pgbouncer_pools_*` present; pool saturation visible |
| 2.3 | B1 | `sonnet-5` | OBS-23 | **Redis.** Deploy `redis_exporter` on VMs 420–421 using the existing research compose. Because persistence is deliberately off (PHI posture), alert on `maxmemory` pressure and evictions specifically | `redis_up == 1` × 2; eviction counter charted |
| 2.4 | B1 | `sonnet-5` | OBS-24 | **MinIO.** Scrape native `/minio/v2/metrics/cluster` on VM 402 (needs a Prometheus bearer token from MinIO) | Bucket capacity + S3 error rate visible |
| 2.5 | B1 | `sonnet-5` | OBS-25 | **Vault.** Apply the **already-written** ServiceMonitor + alerts at `infrastructure/single-deployment/vault/`. Now HA (VMs 430–432/434), so seal-state and Raft-peer metrics matter | `vault_core_unsealed == 1`; Raft peer count == 3 |
| 2.6 | B2 | `haiku-4-5` | **OBS-22** | **Temporal.** Set `PROMETHEUS_ENDPOINT` on the Temporal server and add the scrape job. **Blocked on**: resolving the two-Temporal-servers duplication (TASK-625) — point metrics at the survivor | `temporal_*` series present; task-queue latency charted |
| 2.7 | B2 | `haiku-4-5` | OBS-27 | (covered by 1.1 — DCGM scrape stanza) | — |
| 2.8 | B3 | `sonnet-5` (high) | **OBS-26** | **Node & cluster.** Deploy `kube-state-metrics` + `node-exporter` and scrape kubelet/cAdvisor. **Budget resources carefully** — this cluster is single-node with a 1 GiB Prometheus limit and a DiskPressure history. Apply the §0.2 cardinality budget; drop high-cardinality cAdvisor series aggressively | Node disk/memory/CPU charted; `kube_pod_container_status_restarts_total` present; a simulated disk-fill triggers the Phase 6 alert |
| 2.9 | B3 | `sonnet-5` | OBS-34 | Reap the dead-pod backlog and add a `ttlSecondsAfterFinished` / cleanup policy so it does not regrow. **Read before deleting** — confirm each pod is genuinely terminal | `kubectl get pods` returns only live pods; observability lanes stop hitting dead pods |

#### Phase 3 — PHI redaction & environment labelling · Lane C · `opus-5` · ★ **GATE**

> **No lane may enable tracing on a new service until 3.1 and 3.2 are verified green.**

| Step | Tier | Closes | Instruction | Verify |
|---|---|---|---|---|
| 3.1 | `opus-5` | **OBS-19** | Restructure the collector into **agent DaemonSet + gateway Deployment**. At the gateway, add the `redaction` processor with an **attribute allowlist** (never a denylist), plus tail sampling and a memory limiter. Reuse the `DEFAULT_PHI_REDACT_FIELDS` vocabulary already implemented in the browser SDK's `redactor.ts` as the starting allowlist complement | **A span carrying a deliberately-planted PHI-shaped attribute is confirmed dropped at the gateway before Tempo.** This is an explicit test, not an inspection |
| 3.2 | `opus-5` | **OBS-18** | Fix env labelling from both directions: parameterize `deployment.environment.name`, `service.namespace`, `k8s.cluster.name` as **overlay-patched** values (remove the hardcoded `"dev"` upsert), **and** remove STT's hardcoded `"production"` in `telemetry.py:46` | Telemetry from a non-dev namespace carries the right env; no `dev` labels outside dev; STT's attribute agrees with the collector's |
| 3.3 | `opus-5` | **OBS-19** | Implement the backend log-redaction pipeline the logging package only *declares* (`redactFields` at `transports/types.ts:319` — declared, zero readers), and wire NLP's dead redaction hook to its instrumentor | A unit test asserts a PHI-shaped field is redacted **before** transport, for both the log path and the span path |

#### Phase 4 — Tracing · Lanes D1/D2 · **after Phase 3**

| Step | Lane | Tier | Closes | Instruction | Verify |
|---|---|---|---|---|---|
| 4.1 | D1 | `sonnet-5` (high) | OBS-12, OBS-13 | Add OpenTelemetry to **guardrail** and **TTS** from zero. Copy the established in-repo pattern from `smr/core/observability.py` (the most complete implementation), including its wired redaction hook. Keep the default-off gate | Both services produce spans in Tempo when their flag is on, and start cleanly when the collector is unreachable |
| 4.2 | D1 | `sonnet-5` | OBS-14 | Add a `TracerProvider` to harness; set `OTEL_SERVICE_NAME` in its manifest (the only service missing it) | Harness spans appear; structlog's span-id processor stops emitting `INVALID_SPAN` |
| 4.3 | D1 | `sonnet-5` | OBS-15, OBS-17 | Set `NLP_OTEL_ENABLED` and `OTEL_EXPORTER_OTLP_ENDPOINT` in all overlays. **Remove or implement `OTEL_TRACES_ENABLED`** — overlays set a flag the code does not read, which is worse than no flag | A single request produces one connected trace spanning gateway → ≥2 Python services |
| 4.4 | **D2** | **`opus-5` (max)** | **OBS-16** | **Propagate W3C trace context across every async boundary**: Redis Streams (STT), SSE (SMR), WebSocket (STT/TTS gateways), and Temporal (use the SDK's OTel interceptor). Server-side must **continue** the `traceparent` the browser SDK already sends — today it is only CORS-allowed, never extracted | **A trace survives a full STT streaming session end-to-end, and a second survives a Temporal workflow across replay.** Both captured as screenshots/trace IDs in this README |

#### Phase 5 — Log pipeline · Lane E1 · parallel with Phase 4

| Step | Tier | Closes | Instruction | Verify |
|---|---|---|---|---|
| 5.1 | `sonnet-5` (high) | **OBS-08** | Deploy **Grafana Alloy** as a container-log-shipping DaemonSet into Loki. **Never Promtail — EOL 2026-03-02.** Ensure structured logs carry `traceId` so the existing `derivedFields` trace-links light up | All 11 workloads queryable in Loki within seconds of a log line, with a clickable trace link |
| 5.2 | `sonnet-5` | OBS-11, OBS-33 | Move Loki and Tempo to an **object-store backend on the existing MinIO** (VM 402) and define a retention tier: hot 7d local, warm 30–90d object store | Loki survives a pod eviction with no gap; a 30-day-old log line is retrievable |

#### Phase 6 — Alerting, SLOs, dashboards · Lanes F1/F2 · after A+B produce series

| Step | Lane | Tier | Closes | Instruction | Verify |
|---|---|---|---|---|---|
| 6.1 | F1 | `sonnet-5` (high) | **OBS-29** | Deploy **Alertmanager**; author the first rule set. Minimum viable page-worthy set: node disk/memory pressure (**the 2026-08-06 incident**), target-down, **expected-target-count mismatch** (uses the §0.3 inventory — catches OBS-01-class regressions), Patroni failover / replication lag, Redis eviction, pod crash-loop, Vault sealed, GPU unavailable | A deliberately-stopped exporter pages within the alert's `for` window; a deliberate disk-fill fires the node alert |
| 6.2 | F1 | `sonnet-5` | OBS-36 | Write SLOs + error budgets for the user-facing paths (transcription latency, summarization availability), and the on-call runbook at `docs/operations/observability/` | A new engineer can respond to each alert from the runbook alone |
| 6.3 | F2 | `sonnet-5` | **OBS-30** | Repackage the **9** orphaned dashboards. **Two mount paths are wrong and both need fixing**: point the dev Grafana at `infrastructure/grafana/dashboards/` (or consolidate the two directories — recommended), and package them as provisioned ConfigMaps in the deployment repo. Also mount `infrastructure/grafana/provisioning/dashboards.yml` or fold its providers into the mounted one | Every dashboard loads with live data in both dev and cluster Grafana |
| 6.4 | F2 | `sonnet-5` | new | Add dependency dashboards for the Phase 2 exporters (Timescale/Patroni, Redis, MinIO, node, GPU) | Each dependency has a USE-method dashboard |

#### Phase 7 — Multi-environment, governance, docs · Lane O · `opus-5` / `fable-5`

| Step | Tier | Closes | Instruction | Verify |
|---|---|---|---|---|
| 7.1 | `opus-5` | OBS-31, OBS-32 | **Decide and implement the cross-environment view.** Recommended: one Grafana + Mimir/Loki/Tempo with `X-Scope-OrgID` tenancy, over per-env Grafana with mixed datasources. Fix the `grafana.local` Ingress collision | One Grafana charts the same metric for dev and staging side by side |
| 7.2 | `sonnet-5` | OBS-07 | Migrate from `static_configs` toward **Prometheus Operator ServiceMonitors** so a new service ships its own scrape definition. This is the structural fix that stops OBS-01 recurring | Adding a service requires no edit to any central config |
| 7.3 | `sonnet-5` | OBS-35 | Replace Grafana's shared admin credential with SSO + per-user RBAC; disable anonymous Viewer outside local dev; enable query audit | Dashboard access is attributable per user |
| 7.4 | `opus-5` | — | Update `.claude/rules/09-infrastructure-devops.md` with the observability contract, and write `docs/operations/observability/README.md` as the durable home | The rules file matches reality; no future ticket rediscovers §2.4 |

### 3.4 Verification criteria (ticket-level definition of done)

- [ ] **R1** — `count(up == 1)` ≥ 22 (13 runtime units + 9 dependencies); the expected-target-count alert is green
- [ ] **R2** — `/loki/api/v1/label/service_name/values` returns every deployed workload; `/index/volume` shows non-zero for each in the last hour
- [ ] **R3** — each of Timescale/Patroni, PgBouncer, Redis, MinIO, Temporal, Vault, node, GPU has ≥1 dashboard and ≥1 alert rule
- [ ] **R4** — a deliberately-planted PHI attribute is dropped at the collector gateway; a stopped exporter pages; a trace survives an STT streaming session and a Temporal workflow
- [ ] The **before/after scorecard** (§2.3 format) is pasted into §4 with live query output
- [ ] `pnpm lint:all`, `pnpm typecheck:all`, and every touched service's test suite are green
- [ ] `pnpm env:sync --check` green
- [ ] TASK-411's invariant re-verified: every service starts cleanly with **no** observability backend reachable

---

## 4. Implementation Summary

**Baseline captured 2026-08-08** (cluster `c-nfhxq`, ns `hope-v2-dev`):

```
metrics : 3/11 workloads scraped  (api-gateway, stt-v2, smr) + 4 self-jobs; up==0 → empty
traces  : 1/11 services emitting  (hope-api; 4,815 spans/15m)
logs    : 3/11 service_names in Loki; 2 active in last hour
alerts  : 0 rules, 0 Alertmanager
deps    : 0 of 9 monitored
head series: 15,338 (largest single metric: traces_spanmetrics_latency_bucket, 3,300)
```

### Phase 1 — partial (2026-08-08)

Closed: **OBS-02, OBS-03, OBS-04, OBS-09, OBS-10, OBS-30 (dev half)**. All verified against the running dev stack, not by config inspection.

| Defect | Change | Files |
|---|---|---|
| **OBS-02** | NLP `/metrics` un-404'd. **Two independent root causes, both required**: (a) `setup_prometheus` gated on `should_respect_env_var`/`ENABLE_METRICS`, which no environment sets — replaced with the fleet-standard `settings.service.metrics_enabled` check; (b) even then `metrics_enabled` resolved from the **gateway-scoped** `OTEL_METRICS_ENABLED`, which `.env.dev:513` sets to `false` — NLP now reads its own `NLP_METRICS_ENABLED` first (matching `SMR_`/`TTS_`/`GUARDRAIL_V2_`/`HARNESS_`/STT's `METRICS_ENABLED`), falling back to the old key | `apps/nlp/src/nlp/core/observability.py`, `apps/nlp/src/nlp/core/config.py`, `apps/nlp/.env.sample`, `.env.dev`, `.env.test` |
| **OBS-03** | Dropped `metric_namespace="nlp"`; NLP now emits fleet-standard `http_*`. Corrected the dev `prometheus.yml` comment, which had asserted this alignment before it existed | same + `infrastructure/docker/configs/prometheus/prometheus.yml` |
| **OBS-04** | Added the missing `tts` scrape job (`host.docker.internal:8865`) with the standard `service` relabel | `infrastructure/docker/configs/prometheus/prometheus.yml` |
| **OBS-09** | `_worker_service_name()` suffixes at most once, ending the `hope-stt-v2-worker-worker` label | `apps/stt/src/stt/worker.py` |
| **OBS-10** | `LOKI_ENABLED`/`LOKI_HOST`/`LOKI_LABELS` declared as `env`-tier descriptors, so `env:sync` emits them into `turbo.json#globalEnv` and the samples. **Root cause**: the reader goes through `getEnvString`/`getEnvBoolean`, which index `process.env[key]` dynamically — `env-sync.mts`'s `process.env.NAME` regex scan cannot see them, so a fully-implemented transport had no declared config path | `apps/api/src/config/env.descriptors.ts` (generated: `turbo.json`, `.env.sample`, `apps/api/.env.sample`) |
| **OBS-30** (dev) | Consolidated the two dashboard directories: `hope-platform-metrics.json` moved into `infrastructure/grafana/dashboards/`, and the dev Grafana repointed there. The cluster half remains open | `infrastructure/docker/docker-compose.dev.yml`, `git mv` of the dashboard |

**Evidence — dev Prometheus targets (was 7 jobs, now 8):**

```
api-gateway  guardrail  harness  nlp  prometheus  smr  stt  tts   ← tts is new
```

**Evidence — dev Grafana provisioned dashboards (was 1, now 10):**

```
Agentic Trajectory (Harness) · Consumption & Cost · HOPE Platform Metrics (dev)
Model Retention & Lifecycle · Optimistic Locking · PgBouncer — HOPE Production
SMR Cache Friendliness · SMR Overview · SMR Resilience · SMR Security
```

**Evidence — tests.** New: `apps/nlp/tests/test_metrics_endpoint_task636.py` (2), `apps/stt/tests/test_worker_service_name_task636.py` (5). Both were written failing first; the NLP test reproduced the exact live `404 == 200`. Suites: NLP `196 passed, 6 failed`, STT (worker/telemetry/metrics scope) `134 passed`, `pnpm api:typecheck` clean, `pnpm env:sync:check` OK (144 keys). **The 6 NLP failures are pre-existing** — `test_extract.py` auth 401s, reproduced identically with these changes stashed.

**Operational note discovered during verification.** Rewriting a single-file Docker bind mount **atomically** (write-temp + rename, which most editors and tools do) changes the inode and **severs the mount** — the container keeps serving its old in-memory copy and `POST /-/reload` fails with `no such file or directory`. Editing `prometheus.yml` on a running dev stack therefore requires `--force-recreate`, not a reload. Worth carrying into the Phase 6 runbook.

### Phase 1 completion + Phase 2 (in-cluster) — authored 2026-08-08, NOT deployed

Repo: `hope-v2-deployment`, branch `task-636-observability-coverage` (uncommitted, unpushed).

Closes on merge: **OBS-01, OBS-22, OBS-26, OBS-27**.

| Defect | Change | File |
|---|---|---|
| **OBS-01** | Added scrape jobs for `guardrail:8863`, `nlp:8864`, `harness:8866`, `tts:8865`. All were serving `/metrics` already and were simply never listed | `base/observability-config.yaml` |
| **OBS-27** | Added the `dcgm-exporter` job (`nvidia-dcgm-exporter.gpu-operator.svc:9400`). The exporter has been running healthy the whole time, producing 92 GPU metrics that were discarded | same |
| **OBS-22** | Temporal server metrics: `PROMETHEUS_ENDPOINT=0.0.0.0:9090` on the Deployment, a `metrics` port on the container and Service, and a `temporal` scrape job | `base/temporal.yaml`, `base/observability-config.yaml` |
| **OBS-26** | New `cluster-monitoring.yaml`: **kube-state-metrics** (Deployment + Service + ServiceAccount + read-only ClusterRole/Binding) and **node-exporter** (DaemonSet, `tolerations: [{operator: Exists}]` so it survives a pressured node). Scrape jobs for both, with a `metric_relabel_configs` drop of `kube_*_labels`/`kube_*_annotations` for cardinality | `base/cluster-monitoring.yaml`, `base/kustomization.yaml`, `base/observability-config.yaml` |

Scrape jobs go **7 → 15**. Verified: all three overlays (`dev`/`staging`/`prod`) render via `kubectl kustomize`; both pinned image tags resolve (`docker manifest inspect`).

**Two defects were found and fixed in this change before it shipped** — both by rendering the non-dev overlays rather than trusting the dev render:

1. **Hardcoding `namespace: hope-v2-dev` on the ClusterRoleBinding subject made kustomize's namespace transformer skip it** — the staging render still bound to the *dev* ServiceAccount, so staging's kube-state-metrics would have got 403s. Omitting the field entirely makes the transformer inject the right namespace per overlay. Verified against all three.
2. **Cluster-scoped name collision (documented, not fixed).** `ClusterRole`/`ClusterRoleBinding` are cluster-scoped and no overlay sets a `namePrefix`. Harmless today — `hope-v2-dev` is the only HOPE namespace — but the moment staging or prod is created on the same k3s cluster, all three overlays render the same object name and their Argo Applications will fight over it. Flagged in-file for **TASK-626**, which owns creating those namespaces.

**Deliberately deferred: container-level cAdvisor metrics.** They need Prometheus RBAC + `kubernetes_sd_configs` + TLS and are the highest-cardinality source available. Enabling them on a single node with a 1 GiB Prometheus limit *and a live eviction history* — in the same change that first gives the node any visibility at all — is the wrong risk order. Separate step, after the §0.2 cardinality budget exists.

**Not deployed.** These manifests are authored and validated but not committed, pushed, or synced. Argo's `hope-v2-dev` Application syncs `main` automatically, so merging deploys them — including a `hostPID`/`hostNetwork` DaemonSet. That needs an explicit go-ahead, not an inference from "implement Phase 2".

### Phase 2 — VM-hosted dependencies · authored 2026-08-08, NOT deployed

Full deployment reference: **[`hope-v2-deployment/docs/observability-dependency-monitoring.md`](../../../../hope-v2-deployment/docs/observability-dependency-monitoring.md)** — inventory, per-VM evidence, verification runbook, gotchas.

> **The register's premise for this phase was wrong, and in our favour.** §2.4 E assumed these exporters needed deploying. Live inspection of the Proxmox estate found **`postgres_exporter` v0.16.0 running on all three database VMs, Patroni's own `:8008/metrics` live on all three, and `redis_exporter` v1.66.0 running on both Redis VMs** — all healthy, and all **already reachable from the Prometheus pod** (verified by `wget` from inside it: 6 of 7 targets OK, no firewall or route change needed). They had never been listed in a scrape config. Same "built, then never wired" pattern TASK-616 §7 found in the CI security gates and Vault OIDC.

Closes on merge: **OBS-20, OBS-23** (plus OBS-01/22/26/27 above). Scrape jobs **7 → 18**.

| Defect | Change |
|---|---|
| **OBS-20** | `postgres` job (`10.10.1.{200,201,202}:9187`) + `patroni` job (`:8008`). Patroni is the more important of the two — it carries `patroni_primary`, `patroni_replica`, `patroni_cluster_unlocked`, `patroni_postgres_streaming`, i.e. failover state, which `postgres_exporter` does not expose |
| **OBS-23** | `redis` job (`10.10.1.{120,121}:9121`). Persistence is deliberately off (PHI posture), so eviction and memory-pressure metrics are load-bearing — an eviction is by-design unrecoverable loss |

Both jobs stamp a readable `node` label via `relabel_configs` (`database-00`, `redis-01`, …); a bare `ip:port` `instance` is useless in an alert body.

**Live state now recorded for the first time:** db-00 leader, db-01/02 streaming replicas, cluster locked/healthy; 833 `pg_*` series per node; `redis_up 1`, 119 MB used, 0 evictions.

### Phase 2 completion — VM exporters DEPLOYED LIVE 2026-08-08 (owner-approved)

Owner approved MinIO, Vault and PgBouncer on the basis that the Proxmox estate is a development environment. All three are **applied and running**; exact configs, commands and rollback are in the deployment doc §3.

| Defect | Result | Evidence |
|---|---|---|
| **OBS-21** PgBouncer | `pgbouncer_exporter` v0.11.0 deployed on all three DB VMs in the existing `monitoring` compose profile; password kept in `.env` via `${PG_PASSWORD}`. No restart of PgBouncer or Patroni | `pgbouncer_up 1` ×3, 48 metrics each |
| **OBS-24** MinIO | `MINIO_PROMETHEUS_AUTH_TYPE=public` + container recreate | 200, 91 `minio_*` series; cluster healthy, 300 GB usable, drive online |
| **OBS-25** Vault | Added the missing `telemetry` stanza **and** `unauthenticated_metrics_access` on the listener (Vault had *no* telemetry config on any node), then a rolling restart standbys-first | 201 `vault_*` series ×3, `vault_core_unsealed 1` ×3; every node auto-unsealed, leadership failed over cleanly vault-2 → vault-1 |

**Two corrections to the register.** (1) **OBS-24's diagnosis was wrong**: MinIO serves **HTTPS**, so the observed 400 was a protocol mismatch, not auth — over `https://` it was a **403**. The scrape job needs `scheme: https` + `insecure_skip_verify`, which the original reading would have missed; the same applies to Vault. (2) The premise that these exporters needed deploying held for **PgBouncer only**.

**Incident during execution.** VM 402's QEMU guest agent stalled mid-command (that VM runs at ~90% memory). MinIO itself was unaffected — verified healthy over the network — but it left the `.env` write state unknown, and a corrupt `env_file` stops MinIO booting. SSH between VMs turned out to be impossible (**no key path exists — worth fixing independently**), so recovery was: snapshot `task636-pre-metrics-restart` → graceful shutdown → start. The agent returned and the file was **pristine — the command had never executed**. Full account + rollback command in the deployment doc §7.

### Phase 6 (partial) — Grafana dashboards · authored 2026-08-08, NOT deployed

Full catalogue: **[`hope-v2-deployment/docs/observability-dashboards.md`](../../../../hope-v2-deployment/docs/observability-dashboards.md)**

Five dashboards, **67 panels**, delivered as real `.json` files assembled by a kustomize `configMapGenerator` (content-hashed, so an edit rolls Grafana automatically). Replaces the previous cluster Grafana, which shipped **one dashboard with one `up` panel**.

| Dashboard | Covers |
|---|---|
| Infrastructure Overview | target up/down, **availability % over range**, uptime, reboots, dependency tiles (incl. Patroni leader count — must be exactly 1) |
| Node & System Activity | CPU by mode, load vs cores, **PSI resource-stall (the honest RAM-stress signal)**, OOM kills, **open sockets** (TCP in-use/alloc/TIME_WAIT, UDP), file descriptors vs max, disk, network, context switches |
| GPU (DCGM) | utilisation, framebuffer, thermals, power, clock throttling, tensor-pipe activity, PCIe replays, **remapped-row failures** |
| Data-tier Dependencies | Patroni role/failover, replication, connections vs max, cache hit ratio, PgBouncer client-wait, Redis evictions, MinIO capacity, Vault seal state |
| Kubernetes Workloads & Events | **node conditions incl. DiskPressure**, pod phase, restarts, waiting reasons, evicted pods, requests vs allocatable |

**Validation** — the check that matters is PromQL: **111 of 111 expressions parse**, verified by submitting each one to a live Prometheus with template vars substituted. That catches typos which would otherwise surface as a silently empty panel weeks later. Also: all 5 accepted by Grafana's `POST /api/dashboards/db`; all three overlays render. Validation imports were then deleted from the dev Grafana, since these target cluster-only exporters.

**Honest limitation**: kube-state-metrics exposes object *state*, not the Kubernetes event stream. Restart counters, waiting reasons and terminal pod reasons are **event proxies**. A true event feed needs `kube-events-exporter` or an event→Loki shipper — neither is in this change.

### Phase 5 — Alerting · authored 2026-08-08, NOT deployed

Full reference: **[`hope-v2-deployment/docs/observability-alerting.md`](../../../../hope-v2-deployment/docs/observability-alerting.md)**

**31 alert rules across 8 groups** + Alertmanager with a routing tree, inhibition rules and persistent silences. Prometheus wired with `rule_files` + `alerting` (its `evaluation_interval` had been set since the file was created, with nothing to evaluate). Scrape jobs **21 → 22** (Alertmanager self-monitors — an alerting layer that is itself down unnoticed is the worst of both worlds).

Rules are derived from failure modes this platform has **already experienced**, not a generic template: `NodeDiskPressure` (2026-08-06), `PodCrashLooping` (hope-stt-v2 at 22 restarts), `VaultSealed`, `RedisEvictingKeys` (persistence is off, so eviction *is* data loss), `PatroniNoLeader`/`SplitBrain`.

**`ExpectedTargetCountMismatch` is the guard against this ticket's own defect class.** A plain `up == 0` check could never have detected the original problem: when a service is silently absent from the scrape config, every target that exists is up and the platform looks healthy — precisely the state found at the start (3 of 11 scraped, zero down). So the rule alerts on expected *job count*, not target health.

**Verification.** `promtool check rules` → 31 rules, no errors. `amtool check-config` → SUCCESS. And, more importantly, **`promtool test rules` → 7 scenarios, SUCCESS** — syntax passing does not prove an alert fires. The tests prove the logic, including the healthy-case silence and one scenario that replays the 2026-08-06 incident. They are hermetic and need no cluster, so they belong in the deployment repo's CI.

> **⚠️ OBS-29 is only HALF closed, and the ticket should not claim otherwise.** Alerts now fire and are visible in the Alertmanager UI and on the Infrastructure Overview dashboard (new `ALERTS` panels). But **nothing is delivered to a human**: there is no Slack webhook, no SMTP server and no PagerDuty key anywhere in this estate — Argo CD Notifications hit the identical wall and left a `TODO(owner)`. Until a receiver is supplied, an incident still pages nobody; it merely becomes visible to someone who goes looking. Receiver blocks are stubbed and commented in `alertmanager.yaml`, using `*_file` variants so the credential never enters Git.

### Blocked on an owner decision — not actioned

> **Superseded 2026-08-08** — all three were owner-approved and are now **done** (see above). Retained for the decision record.

| Item | Why it was gated |
|---|---|
| **OBS-24 MinIO** | `/minio/v2/metrics/cluster` returns **400** — auth required, and `MINIO_PROMETHEUS_AUTH_TYPE` is unset. Option A (`=public`) needs a **MinIO container restart** — an availability event on the PHI object store. Option B (`mc admin prometheus generate` → k8s Secret → `bearer_token_file`) needs no restart but puts a long-lived JWT in the telemetry path. Both costed in the deployment doc §5.2 |
| **OBS-25 Vault** | `/opt/vault/config/vault.hcl` has **no `telemetry` stanza at all** on any node, so Vault emits nothing and `/v1/sys/metrics` needs a token; standbys 307 to the leader. Needs the stanza plus a **rolling restart of vault-1/2/3**. Low-risk on paper — Track V proved transit auto-unseal survives a hard power cycle in ~20 s — but if VM 434 is unavailable at that moment a restarted node stays **sealed** and every secret resolution fails. Exact config in the deployment doc §5.3 |
| **OBS-21 PgBouncer** | `pgbouncer` runs on all three DB VMs (`:6432`) but there is **no exporter beside it** — `:9127` is closed. Deploying is additive (new container, no restart of pgbouncer or Patroni), and the scrape config *and* alert rules already exist at `docs/research/configs/postgres-ha/prometheus/`. Listed rather than done silently because it adds a container to a production database host |

### Phase 1 tail — worker metrics · OBS-05 + OBS-06 closed 2026-08-08

Both workers are separate processes from their HTTP services, so the app-level jobs said nothing about them, and **neither emitted any metric at all**. Scrape jobs **22 → 23**; alert rules **31 → 35**.

| Defect | Change | Files |
|---|---|---|
| **OBS-05** | STT batch worker exposes `dramatiq_*` on :9191 via dramatiq's own Prometheus middleware. Chosen over a hand-rolled exporter because dramatiq **forks** — a naive `start_http_server()` collides on the port in each fork and plain `prometheus_client` counters would be per-fork and silently wrong. The middleware sets `PROMETHEUS_MULTIPROC_DIR` and binds once | [broker.py](../../../apps/stt/src/stt/core/messaging/broker.py), `stt-v2-worker.yaml`, `.env.sample` |
| **OBS-06** | New [`harness/temporal/metrics.py`](../../../apps/harness/src/harness/temporal/metrics.py) builds a Temporal SDK `Runtime` with `PrometheusConfig` (default `127.0.0.1:9464`), passed to `Client.connect(runtime=…)`. The SDK emits nothing without one, and a `Runtime` must exist exactly once per process — hence the memo | `metrics.py`, `client.py`, `config.py`, `.env.sample` |

Two decisions worth recording:

- **Both default to loopback**, not the libraries' `0.0.0.0`. These are PHI-processing services and must not become LAN-reachable by accident — the same posture `scripts/dev-service.sh` takes for the HTTP ports. Only the container manifests open them up.
- **A headless Service + `dns_sd_configs`** for the STT worker, not a ClusterIP + `static_configs`. A ClusterIP Service load-balances, so scraping it returns **one random pod per scrape** and the series is silently a sample rather than the fleet. Headless publishes an A record per pod — correct at `replicas: 1` and still correct when it scales.

Both degrade rather than fail: a held metrics port logs a warning and the worker keeps consuming. That is the TASK-411 invariant applied consistently — a service must never require a reachable observability backend, and by the same principle must not refuse to boot because a metrics port is taken. A test asserts it.

> ⚠️ **The harness worker has no k8s Deployment**, so OBS-06 has nothing to scrape in-cluster yet — TASK-616 §B1 Q4 found the only `*-worker` pods are STT's. Building it is **TASK-625**. The code and the `TemporalWorkerTaskFailures` alert are ready and simply never fire until then; `pnpm worker:dev` exercises it locally.

**Tests** (RED first, both): `apps/stt/tests/test_worker_metrics_task636.py` (3), `apps/harness/.../test_worker_metrics_task636.py` (5). Suites green — STT worker/broker scope **120 passed**, harness temporal **276 passed**. `ruff` + `black` clean; `env:sync:check` OK; `promtool check config` validates all 23 jobs + the alerting block; `promtool test rules` still passes.

### Phase 3 — PHI redaction & environment labelling · OBS-18 + OBS-19 closed 2026-08-08

Full reference: **[`hope-v2-deployment/docs/observability-phi-redaction.md`](../../../../hope-v2-deployment/docs/observability-phi-redaction.md)**

**This was the gate on Phase 4.** Four separate holes, all closed:

| Defect | Fix |
|---|---|
| **OBS-19** collector | `redaction/phi` processor with an **attribute allowlist** (`allow_all_keys: false`) on **all three** pipelines, placed **before `batch`** so nothing unredacted is ever buffered or flushed on shutdown |
| **OBS-19** backend logs | New [`logging/redactor.ts`](../../../packages/applications/src/services/baseServices/logging/redactor.ts) applied at the single `dispatch()` chokepoint — before ANY transport. `LOG_REDACT_FIELDS` finally makes the long-declared `redactFields` load-bearing |
| **OBS-19** NLP | `_phi_sanitization_hook` wired. The two `instrument_app` call sites are collapsed into one `_instrument_fastapi()` — two call sites is exactly how the hook came to be missing from *both* |
| **OBS-18** env label | Collector reads `DEPLOYMENT_ENVIRONMENT` from pod env (patched per overlay: dev/staging/prod); STT's hardcoded `"production"` replaced with `DEPLOYMENT_ENVIRONMENT` → `NODE_ENV` → `development` |

**Allowlist, not denylist** — a denylist fails open on every attribute anyone adds later. Deliberate omissions: `http.url`/`http.target` (query strings carry identifiers — `http.route` allowed instead), `db.statement` (embeds parameter values), `exception.message`/`exception.stacktrace` (both embed the offending payload). `hope.tenant_id` **is** allowed: a tenant is a routing key, not patient data.

Three decisions worth recording:

- **The redactor returns the original reference when nothing needs redacting.** Load-bearing, not an optimisation: `base.transport.formatError` and `console.transport` both branch on `instanceof Error`, and existing tests compare identity. I initially converted `Error` to a plain object and broke two passing tests — the identity-preserving design fixes that *and* means the common clean log line costs no clone. When redaction is needed the `Error` is rebuilt as a real `Error`, **with the stack redacted too** (the stack embeds the message verbatim).
- **STT defaults to `development`, never `production`.** An unset environment tagging laptop traces as production is the dangerous direction — a mislabelled dev span is noise, a mislabelled prod span corrupts an audit trail.
- **`insert`, not `upsert`** on the environment keys: a service that sets its own correct value keeps it. The collector fills gaps, it doesn't overrule emitters.

**Verification.** The collector config validates against the real contrib 0.149.0 binary (`otelcol validate`, exit 0) — and a **negative control** with a deliberately broken processor key was correctly rejected, proving the check can fail and that `redaction` exists in this build. Suites: applications **321 passed** (18 new, RED first), STT **2810 passed**, NLP 199 passed, `api:typecheck`/`ruff`/`black`/`env:sync:check` clean.

> **Honest limits.** The allowlist guarantees no *unlisted attribute* leaves the collector; it cannot know whether an *allowed* one has been misused. Span **names** are not redacted, only attributes. The agent-DaemonSet/gateway split from the original plan was **not** implemented — redaction went into the single existing collector, which achieves the same enforcement with far less infrastructure; the split remains worthwhile for back-pressure and tail sampling but is not a PHI gap. And **no test proves an end-to-end drop through a running collector** — the ticket's acceptance criterion ("a span carrying a planted PHI attribute is confirmed dropped before Tempo") needs a live deployment. **Run it first after merging, before enabling Phase 4.**

### Phases 4, 5 and 7 — delivered by 8 parallel agents, 2026-08-08

Every lane was independently re-verified (tests re-run, claims checked); agent reports were not taken as evidence. Lanes had exclusive file ownership so none could collide.

| Lane | Tier | Closes |
|---|---|---|
| Guardrail OTel | `sonnet` | **OBS-12** — service had zero OTel code |
| TTS OTel | `sonnet` | **OBS-13** — service had zero OTel code |
| Harness tracing | `sonnet` | **OBS-14** — no TracerProvider; + Temporal `TracingInterceptor` |
| Trace propagation | `opus` | **OBS-16** — Redis Streams · SSE · WebSocket · inbound HTTP |
| Alloy + object storage | `sonnet` | **OBS-08, OBS-11, OBS-33** |
| Cross-env topology | `opus` | **OBS-31, OBS-32, OBS-35, OBS-07/17** |
| SLOs + on-call | `sonnet` | **OBS-36** |
| App-side follow-ups | `sonnet` | service-name alignment · helper dedupe · TTS test isolation |

**Totals: scrape jobs 7 → 26. Alert rules 0 → 35. Dashboards 1 panel → 67. Dependencies monitored 0 → 9.**

#### OBS-18 was materially wider than this register recorded

The register named the collector and STT. Verification found the same hardcoded `"production"` / `"dev"` environment stamp in **five** places:

1. **`apps/smr/core/config.py` — the origin.** It is the reference implementation every service's OTel setup is copied from, and it always defaulted to `"production"`. Harness and TTS faithfully inherited it when they were added in this ticket.
2. `apps/smr/core/observability.py` — same literal in the function signature.
3. `apps/harness` and 4. `apps/tts` — inherited.
5. **Prometheus `external_labels`** — `environment: "dev"` hardcoded in the shared base with no overlay patching it, sitting in the exact label a cross-environment view joins on. Fixed via `--enable-feature=expand-external-labels`.

All five now resolve `DEPLOYMENT_ENVIRONMENT` → `NODE_ENV` → **`development`**, with regression guards. Defaulting to `production` is the dangerous direction: a mislabelled dev span is noise, a mislabelled prod span corrupts an audit trail.

#### Three findings that corrected this ticket's own analysis

- **`OTEL_TRACES_ENABLED` was NOT unread.** This README asserted it was. It is read at `otel.service.ts:88` and `apps/nlp/core/config.py:133,190` — the "unread" claim came from grepping the literal `traceparent`, a bad inference. Deleting it, as originally proposed, would have desynchronised the gateway from a service that honours it. It is now implemented.
- **The cAdvisor deferral rested on a false premise.** It cited memory pressure and eviction history. The evictions were **DiskPressure**; Prometheus's last termination was `exitCode 255`, **not OOMKilled**. Measured live: 11,456 head series at 125 MiB — **12% of its 1 GiB limit**. cAdvisor enabled with a `keep` allowlist, landing at ~30%. Two surprises from that budget: **87.5% of what this Prometheus stores is the observability stack monitoring itself** (app services are 6.4%), and the largest pending contributor is **redis_exporter at 3,566 series — 4× filtered cAdvisor**.
- **"ClusterIP-only blocks a cross-env view" was wrong.** ClusterIP is routable cross-namespace by FQDN and no NetworkPolicy exists. The real blocker was identical datasource UIDs — a provisioning-file problem, not architecture.

#### OBS-31 — recommendation: NOT Mimir

One platform Grafana + per-env Prometheus/Loki/Tempo as separate datasources, staged, with Mimir behind explicit documented triggers. Mimir's distinguishing benefits (HA dedup, retention beyond local disk, cross-cluster) apply to none of: one cluster, one live namespace, 7-day retention under 1 GiB. Building it adds three failure modes (ring, WAL replay, compactor) to serve a Prometheus at 12% utilisation — a net reliability *reduction*. Design: [`observability-multi-env.md`](../../../../hope-v2-deployment/docs/observability-multi-env.md).

#### Two hard failures caught before staging bring-up

- **`nodePort: 30300` is cluster-scoped.** The second overlay applied to this cluster would fail Service allocation outright (`provided port is already allocated`). Staging/prod now use Ingress; dev keeps the NodePort.
- **`GF_SECURITY_COOKIE_SECURE=true` would have broken Grafana login silently** — the dev Ingress publishes on port 80 despite an `https://` root URL, and a secure cookie over HTTP is never returned. `false` in base, `true` in prod only.

#### 🔴 Security finding — out of scope, needs owner action

**`hope-secrets` exposes every credential in plaintext via `kubectl.kubernetes.io/last-applied-configuration`.** Kubernetes redacts `data`; it does **not** redact annotations. Verified directly against the cluster: the API returned all 31 values as `***` and then supplied the full original `stringData` in the annotation. Readable by anyone with `get secret` and by any UI rendering object metadata.

Exposed: Postgres superuser password (and the three DSNs embedding it), `VAULT_TOKEN` / `VAULT_ROLE_ID` / `VAULT_SECRET_ID`, `JWT_SECRET_KEY`, `ADMIN_SESSION_SECRET`, `API_GATEWAY_KEY`, Azure OpenAI + Speech keys, HuggingFace token, Sarvam key, MinIO secret key, Redis password. **No value is reproduced in any document.**

Stop the bleeding: `kubectl -n hope-v2-dev annotate secret hope-secrets kubectl.kubernetes.io/last-applied-configuration-`. But the annotation is not the vulnerability — the exposure already happened, so **every credential above should be treated as compromised and rotated**, Vault AppRole and Postgres superuser first. Root cause is `kubectl apply` on Secrets; server-side apply or the Vault Agent injection already designed in `deployment/vault-agent/` avoids it. In-cluster sibling of the TASK-617→626 leak. **Not actioned — rotating credentials on a PHI cluster is an owner decision.**

### Spun out

- **[TASK-639](../TASK-639-SMR-Test-Environment-Leak/README.md)** — the SMR test env-leak (109 failures, `401 Invalid or missing service token`). Surfaced during this ticket's verification and initially mis-diagnosed here as a regression from the trace-propagation refactor; a stash-and-rerun disproved that (baseline 134 failed / 928 passed vs 109 / 963 with the work). Two partial fixes landed under this ticket — a conftest env snapshot/restore, and a genuinely separate stale-mock defect in `test_xread_streaming.py` where the SSE endpoint had moved to `read_chunk_entries_blocking` while the test double still mocked only the old reader. TASK-639 finishes it.
- **`task_8f917f8a`** (separate session) — the same env-leak class in guardrail.
- The TTS instance of the same defect was **fixed inside this ticket** (5 failing → 243 passing).

### Not yet started

- **Alert delivery.** OBS-29 remains HALF closed: 35 rules fire and are visible, but no Slack/SMTP/PagerDuty destination exists anywhere in the estate. One receiver block closes it.
- `smr_provider_health == 0` has no alert despite SMR being the best-instrumented path — a genuine hole in the 35.
- Prometheus Operator / ServiceMonitor migration (design written, deliberately not executed).
- End-to-end proofs needing live infra: the planted-PHI drop through a running collector, and one connected trace across an STT streaming session in Tempo.

---

## 5. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | **Phases 4, 5 and 7 delivered via 8 parallel agents** (exclusive file ownership per lane; every lane independently re-verified rather than trusted). Closes OBS-07/08/11/12/13/14/16/17/31/32/33/35/36. Scrape jobs 7 → 26, alert rules 0 → 35, dashboards 1 panel → 67, dependencies 0 → 9. **Verification corrected this ticket's own analysis three times**: OBS-18 was five places not two — `apps/smr/core/config.py` is the reference every service copies and always defaulted to `"production"`, so harness and TTS inherited it, and Prometheus `external_labels` had the same defect in the label a cross-env view joins on; `OTEL_TRACES_ENABLED` was NOT unread (read in `otel.service.ts` and NLP config — deleting it would have desynchronised the gateway); and the cAdvisor deferral rested on a false premise (evictions were DiskPressure, `exitCode 255` not OOMKilled — Prometheus sits at 12% of its memory limit). Two hard failures caught pre-staging: cluster-scoped `nodePort: 30300` would fail Service allocation on the second overlay, and `COOKIE_SECURE=true` would have broken Grafana login silently over the plain-HTTP Ingress. OBS-31 recommendation is **against** Mimir — three new failure modes to serve a Prometheus at 12% utilisation is a net reliability reduction. **🔴 Out-of-scope security finding: `hope-secrets` leaks all 31 credentials in plaintext via the `last-applied-configuration` annotation** (annotations are not redacted like `data`) — verified live, values deliberately not reproduced, rotation is an owner action. | Claude |
| 2026-08-08 | **Phase 3 closed — OBS-18 + OBS-19. This was the gate on Phase 4.** Four holes: the collector had no redaction at all; the backend `redactFields` was declared with zero readers; NLP's PHI hook was dead code; and the environment label was wrong from both directions (collector upserted `dev`, STT hardcoded `production`). Collector now runs a `redaction/phi` **allowlist** on all three pipelines before `batch`; backend logs redact at the single `dispatch()` chokepoint; NLP's two `instrument_app` sites collapsed into one that always attaches the hook; environment comes from pod env, patched per overlay. **A design correction mid-implementation**: converting `Error` to a plain object broke two passing transport tests, so the redactor now returns the ORIGINAL reference when nothing needs redacting — preserving `instanceof Error`, which `base.transport` and `console.transport` both branch on — and rebuilds a real `Error` (stack included) only when it must. Validated against the real otelcol binary **with a negative control** proving the validator rejects a broken config. 321 + 2810 + 199 tests green. Doc: `observability-phi-redaction.md`, including the limits: allowlists don't police misuse of allowed keys, span names aren't redacted, the agent/gateway split was deliberately skipped, and **the end-to-end planted-PHI drop test still needs a live deployment — run it before Phase 4**. | Claude |
| 2026-08-08 | **OBS-05 + OBS-06 closed — both worker processes now emit metrics.** Neither had emitted anything at all. STT's batch worker uses dramatiq's own Prometheus middleware because dramatiq FORKS: a naive `start_http_server()` collides per-fork and plain counters would be silently per-fork. The harness worker gets a Temporal SDK `Runtime` with `PrometheusConfig` — the SDK emits nothing without one. Both default to **loopback** rather than the libraries' `0.0.0.0` (PHI posture), with containers opening them up; both **degrade rather than fail** on a held port, asserted by test. STT's scrape uses a **headless Service + `dns_sd_configs`**, not ClusterIP + `static_configs` — a ClusterIP would load-balance and return one random pod per scrape, making the series a silent sample. Scrape jobs 22 → 23, alert rules 31 → 35 (batch failure rate, queue backlog, worker down). **OBS-06 has nothing to scrape in-cluster until TASK-625 builds the harness worker Deployment** — recorded, not hidden. 8 new tests RED-first; 120 + 276 suite tests green; ruff/black/env:sync clean; `promtool check config` validates the whole config. | Claude |
| 2026-08-08 | **Phase 5 alerting authored** (same branch, not deployed). 31 rules / 8 groups + Alertmanager with routing, inhibition and persistent silences; Prometheus wired with `rule_files` + `alerting`; scrape jobs 21 → 22. Rules derived from incidents this platform actually had, not a template. **`promtool test rules` passes 7 logic scenarios** — including the healthy-case silence and a replay of the 2026-08-06 DiskPressure event — which is the check that matters, since `check rules` only proves syntax. `ExpectedTargetCountMismatch` guards against this ticket's own defect class: a plain `up == 0` check cannot see a service that is silently absent from the scrape config. **OBS-29 is deliberately recorded as HALF closed**: alerts fire and are visible, but no notification destination exists anywhere in the estate, so nothing reaches a human until an owner supplies a receiver. Doc: `observability-alerting.md`. | Claude |
| 2026-08-08 | **Phase 2 VM work DEPLOYED LIVE + Phase 6 dashboards authored.** Owner approved MinIO/Vault/PgBouncer (Proxmox is a dev estate). Deployed `pgbouncer_exporter` ×3 (the one exporter genuinely absent), `MINIO_PROMETHEUS_AUTH_TYPE=public`, and Vault telemetry ×3 via rolling restart — every node auto-unsealed, leadership failed over cleanly. **Corrected OBS-24's diagnosis: MinIO runs HTTPS, so the observed 400 was a protocol mismatch, not auth (403 over https) — the scrape job needs `scheme: https`, which the original reading would have missed.** VM 402's guest agent stalled mid-command; MinIO stayed healthy but the `.env` write state was unknown, and no SSH key path exists between VMs, so recovery was snapshot → graceful reboot; the file turned out pristine (the command never ran). Also authored 5 Grafana dashboards / 67 panels (infra, node+PSI+sockets, GPU/DCGM, dependencies, k8s events) as kustomize-generated JSON replacing the cluster's single one-panel dashboard; **111/111 PromQL expressions parse-validated against a live Prometheus**. Two deployment docs written: `observability-dependency-monitoring.md` (rewritten with exact configs, incident record, rollback, gotchas) and `observability-dashboards.md`. | Claude |
| 2026-08-08 | **Phase 2 VM-hosted dependencies authored** (same branch, not deployed). **The register's premise for this phase was wrong in our favour**: live Proxmox inspection found `postgres_exporter` on all three database VMs, Patroni `:8008` on all three, and `redis_exporter` on both Redis VMs — all healthy, and all already reachable from the Prometheus pod (6 of 7 probes OK from inside it; only MinIO failed). Nothing needed deploying; they had never been listed in a scrape config. Closes OBS-20 + OBS-23; scrape jobs 7 → 18. Three items gated on an owner decision rather than actioned: MinIO (restart or long-lived JWT), Vault (no `telemetry` stanza on any node; needs a rolling restart of the secrets backbone), PgBouncer (exporter genuinely absent; additive but on a production DB host). Full reference captured as a deployment doc at `hope-v2-deployment/docs/observability-dependency-monitoring.md`. | Claude |
| 2026-08-08 | **Phase 1 completion + Phase 2 in-cluster authored** in `hope-v2-deployment` branch `task-636-observability-coverage` (uncommitted, **not deployed**): closes OBS-01, OBS-22, OBS-26, OBS-27 on merge; scrape jobs 7 → 15. New `cluster-monitoring.yaml` deploys kube-state-metrics + node-exporter — the node had **no** monitoring at all, which is why the 2026-08-06 DiskPressure eviction wave produced no signal. Rendering the *staging* overlay (not just dev) caught a real defect before it shipped: hardcoding the ClusterRoleBinding subject namespace makes kustomize's transformer skip it, so staging/prod would bind the dev ServiceAccount and 403. A second, unfixed constraint is documented in-file for TASK-626 — cluster-scoped ClusterRole/Binding names collide across overlays once staging/prod exist on the same cluster. cAdvisor deliberately deferred (highest-cardinality source; wrong risk order on a 1 GiB Prometheus with an eviction history). | Claude |
| 2026-08-08 | **Phase 1 partial — 6 defects closed and verified against the running dev stack**: OBS-02, OBS-03, OBS-04, OBS-09, OBS-10, OBS-30 (dev half). Dev Prometheus 7 → 8 targets; dev Grafana 1 → 10 dashboards. Two TDD test files added (both RED first). **OBS-02 turned out to have two independent root causes**, not one: the `ENABLE_METRICS` instrumentator gate *and* `metrics_enabled` resolving from the gateway-scoped `OTEL_METRICS_ENABLED=false`; fixing either alone still left `/metrics` returning 404. **OBS-10's root cause was also deeper than recorded**: `env-sync.mts` computes `globalEnv` from the declared surface ∪ a `process.env.NAME` regex scan, and the Loki keys are read via `getEnvString`/`getEnvBoolean` (dynamic `process.env[key]`), so the scan structurally cannot see them — the fix is a descriptor declaration, not a hand-edit to `turbo.json` (which `env:sync` reverts). OBS-01 deliberately left unapplied: it belongs in the Argo-managed config repo, and hand-`kubectl apply` drift is already a recorded problem (TASK-616 L-06). | Claude |
| 2026-08-08 | Ticket created. Full stack observability review (static + live cluster inspection). 36 defects registered (OBS-01…OBS-36): 17 inherited from the TASK-616 O-register, 14 new, 5 refined. **Inherits all open items of TASK-616 Phase 4 (steps 4.1–4.9), which had been planned as TASK-620 — that ticket was never created.** Extends the parent's scope with the dependency tier (TimescaleDB HA, PgBouncer, Redis, MinIO, Temporal, Vault, node/cluster, GPU), which the parent register did not cover at all. 8-phase plan across 6 parallel agent lanes with model-tier assignments. Status `Pending` — awaiting owner approval of the plan before Phase 1. | Claude (review requested by owner) |
