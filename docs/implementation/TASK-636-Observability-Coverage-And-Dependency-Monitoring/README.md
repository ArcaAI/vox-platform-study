# TASK-636 — Observability Coverage & Dependency Monitoring

| Field | Value |
|---|---|
| **Status** | `Pending` |
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

*(To be completed as lanes land. Each lane appends its own subsection with live query output as evidence — configuration inspection is not accepted as verification, per §3.2 rule 2.)*

**Baseline captured 2026-08-08** (cluster `c-nfhxq`, ns `hope-v2-dev`):

```
metrics : 3/11 workloads scraped  (api-gateway, stt-v2, smr) + 4 self-jobs; up==0 → empty
traces  : 1/11 services emitting  (hope-api; 4,815 spans/15m)
logs    : 3/11 service_names in Loki; 2 active in last hour
alerts  : 0 rules, 0 Alertmanager
deps    : 0 of 9 monitored
head series: 15,338 (largest single metric: traces_spanmetrics_latency_bucket, 3,300)
```

---

## 5. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Ticket created. Full stack observability review (static + live cluster inspection). 36 defects registered (OBS-01…OBS-36): 17 inherited from the TASK-616 O-register, 14 new, 5 refined. **Inherits all open items of TASK-616 Phase 4 (steps 4.1–4.9), which had been planned as TASK-620 — that ticket was never created.** Extends the parent's scope with the dependency tier (TimescaleDB HA, PgBouncer, Redis, MinIO, Temporal, Vault, node/cluster, GPU), which the parent register did not cover at all. 8-phase plan across 6 parallel agent lanes with model-tier assignments. Status `Pending` — awaiting owner approval of the plan before Phase 1. | Claude (review requested by owner) |
