# TASK-251: HOPE Observability Stack (Modified LGTM)

| Field | Value |
|-------|-------|
| **Ticket** | TASK-251 |
| **Created** | 2026-04-02 |
| **Updated** | 2026-04-02 |
| **Status** | Pending |
| **Type** | Infrastructure |
| **Priority** | High |

---

## 1. Requirement Analysis

### 1.1 Description

Deploy a centralized observability stack for the HOPE healthcare AI platform covering log aggregation, metrics collection, distributed tracing, real-user monitoring, visualization, and alerting. The stack must support all backend services (API Gateway, STT, SMR, NLP), the TimescaleDB HA cluster, Redis instances, and the `@arcaai/vox` browser SDK with multi-tenancy.

### 1.2 Business Context

- **Production readiness**: monitoring is required before real doctors/patients use the system
- **Debugging efficiency**: trace issues across 4+ services and a browser SDK in a distributed pipeline
- **Performance visibility**: GPU utilization, model inference latency, audio pipeline performance
- **Compliance foundation**: audit trail and log retention infrastructure (PHI redaction deferred to a later task)

### 1.3 Acceptance Criteria

- [ ] All 5 observability containers (OTel Collector, Prometheus, Loki, Tempo, Grafana) running on VM 400
- [ ] Prometheus scrapes `/metrics` from all services, database exporters, and Redis exporters — all targets `UP`
- [ ] Loki receives structured logs from API Gateway, STT, SMR, and NLP
- [ ] Tempo receives distributed traces with cross-service span correlation
- [ ] Grafana displays 7+ dashboards with live data
- [ ] Grafana Alerting sends critical/warning/info alerts to Slack
- [ ] Grafana Faro receives browser RUM data from `@arcaai/vox` and `ui-playground`
- [ ] End-to-end trace visible: browser → API → downstream service → back
- [ ] Cold storage (MinIO) receives Loki chunks and Tempo blocks after retention periods
- [ ] Grafana accessible externally via `grafana.taphuynh.dev` (Cloudflare Tunnel)

---

## 2. Current State Evaluation

### 2.1 What Already Exists (Strong Foundation)

#### API Gateway (`apps/api/`)
- Custom `LoggingService` with 5 transports: Console, File, Highlight.io, Grafana Loki, OpenTelemetry
- Structured logging with trace context injection (traceId, spanId, requestId)
- `/metrics` endpoint ready for Prometheus scraping
- OTEL env vars pre-configured in Dockerfile (`OTEL_SERVICE_NAME=hope-api`)
- Health endpoints: `/api/v1/health/{live,ready,startup,services}`

#### STT (`apps/stt/`)
- `structlog` JSON-structured logging with context vars
- `prometheus_fastapi_instrumentator` exposing `/metrics`
- Health endpoints with per-dependency checks (DB, MinIO, Redis, streaming)
- OTel env vars reserved but not wired

#### SMR (`apps/smr/`)
- `structlog` JSON logging with `RequestIDMiddleware` and `RequestLoggingMiddleware`
- 14 custom Prometheus metrics (generation latency, token throughput, circuit breaker, queue depth, etc.)
- OpenTelemetry opt-in via `SMR_OTEL_ENABLED` with OTLP gRPC exporter
- Rich exception hierarchy with structured error responses

#### NLP (`apps/nlp/`)
- Custom `LoggingConfig` with `JsonFormatter` (JSON to files, simple to console)
- `prometheus_fastapi_instrumentator` with `nlp` namespace
- Full OpenTelemetry setup in `nlp.core.observability` (TracerProvider, MeterProvider, OTLP gRPC)
- Health endpoints with per-model checks

#### `@arcaai/vox` SDK (`packages/agentic-sdk-v2/`)
- Comprehensive `SDKLogger` with 4 transports: Console, Highlight.io, Loki, OTel
- W3C `traceparent` propagation on every HTTP request via `createTraceparent()`
- Correlation IDs (UUID per session), operation timing (`startOperation` → `durationMs`)
- PHI redaction built into logger (patientId, SSN, MRN, DOB, tokens)
- Missing: client-side metrics (counters/histograms), Web Vitals, audio pipeline metrics

#### Infrastructure
- PostgreSQL exporters (`postgres_exporter:9187`) on VMs 500-502
- Patroni metrics (`:8008`) on VMs 500-502
- etcd metrics (`:2379`) on VMs 500-502
- Redis exporters (`redis_exporter:9121`) on VMs 420-421
- 3 Grafana dashboard JSONs for SMR (overview, resilience, security)
- Grafana datasource provisioning YAML exists

### 2.2 What's Missing (Gaps)

| Gap | Impact |
|-----|--------|
| No central Prometheus instance | All `/metrics` endpoints exist but nobody scrapes them |
| No central log aggregation | Loki transport in code but no Loki server deployed |
| No distributed tracing backend | OTel configured in apps but no Tempo/Jaeger receiving |
| No Grafana instance | Dashboard JSONs exist but no server to host them |
| No GPU monitoring | NVIDIA DCGM not deployed despite 2× RTX 2000 Ada GPUs |
| No alerting | Alert thresholds documented but no AlertManager/Grafana Alerting |
| No client-side RUM | SDK logs operations but no real-user metrics collected |

### 2.3 Networking Assessment

All observability-relevant VMs are on **vmbr1** (10.10.1.0/24). Traffic is L2-direct on the same bridge — no iptables FORWARD rules apply.

| From VM 400 (10.10.1.100) → | Target | Ports | Firewall | Reachable? |
|---|---|---|---|---|
| VM 200 (apps) | 10.10.1.10 | 8861-8868, 4317, 4318 | No host firewall | **Yes** (verify bind `0.0.0.0`) |
| VMs 500-502 (DB) | 10.10.1.200-202 | 9187, 8008, 2379 | UFW allows `10.10.1.0/24` | **Yes** |
| VMs 420-421 (Redis) | 10.10.1.120-121 | 9121 | awall allows `10.10.1.0/24:9121` | **Yes** |
| VM 402 (MinIO) | 10.10.1.102 | 9000 | No firewall | **Yes** |
| Browsers → VM 400 | via Cloudflare Tunnel | 3000 (Grafana) | Need new tunnel route | **Needs config** |

**Action items:**
1. VM 200: verify service ports bound to `0.0.0.0` (not `127.0.0.1`), add K3s NodePorts if needed
2. Cloudflare Tunnel: add `grafana.taphuynh.dev` → `http://10.10.1.100:3000`
3. VM 400: add UFW with `allow from 10.10.1.0/24` before exposing new services

---

## 3. Architecture

### 3.1 Deployment Target

**VM 400** (`master`, 10.10.1.100) — colocated with Rancher and Argo CD.

| Resource | Current | After Expansion | Allocation |
|---|---|---|---|
| CPU | 8 cores | 8 cores (unchanged) | ~2 cores observability + ~3 cores Rancher/Argo + headroom |
| RAM | 16 GB | 16 GB (unchanged) | ~3.5 GB observability + ~3.5 GB existing + ~9 GB headroom |
| Disk | 64 GB | **128 GB** (expand on Proxmox) | ~60 GB observability hot storage + existing |

### 3.2 Component Overview

| Component | Version | Role | RAM | Ports |
|---|---|---|---|---|
| OpenTelemetry Collector | `otel/opentelemetry-collector-contrib:0.120.0` | Central telemetry gateway | 512 MB | 4317 (gRPC), 4318 (HTTP), 8889 (self-metrics) |
| Prometheus | `prom/prometheus:v3.2.0` | Metric scraping + 15-day storage | 1 GB | 9090 |
| Grafana Loki | `grafana/loki:3.4.0` | Log aggregation, multi-tenant | 1 GB | 3100 |
| Grafana Tempo | `grafana/tempo:2.7.0` | Distributed trace storage | 512 MB | 3200 (HTTP), 4320 (OTLP) |
| Grafana | `grafana/grafana:11.5.0` | Dashboards, alerting, Faro receiver | 512 MB | 3000 |
| **Total** | | | **~3.5 GB** | |

### 3.3 Storage Tiers

| Tier | Location | Data | Retention |
|---|---|---|---|
| **Hot (local SSD)** | VM 400 `/opt/observability/data/` | Prometheus TSDB, Loki recent chunks, Tempo recent blocks | Prometheus: 15d, Loki: 30d, Tempo: 14d |
| **Cold (MinIO S3)** | VM 402 `10.10.1.102:9000` | Loki compacted chunks, Tempo compacted blocks | Loki: 365d, Tempo: 90d |

MinIO buckets to create: `loki-chunks`, `loki-ruler`, `tempo-traces`.

### 3.4 Network Flow Diagram

```
┌─────────────────────── VM 200 (10.10.1.10) ───────────────────────┐
│                                                                     │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐              │
│  │ API     │  │ STT  │  │ SMR     │  │ NLP     │              │
│  │ :8868   │  │ :8861   │  │ :8862   │  │ :8864   │              │
│  │ OTel SDK│  │ OTel SDK│  │ OTel SDK│  │ OTel SDK│              │
│  │ /metrics│  │ /metrics│  │ /metrics│  │ /metrics│              │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘              │
│       └────────────┴────────────┴────────────┘                    │
│                     │ OTLP push (logs + traces)                    │
└─────────────────────┼──────────────────────────────────────────────┘
                      │
         OTLP gRPC :4317 / HTTP :4318
                      │
                      ▼
┌─────────────────────── VM 400 (10.10.1.100) ──────────────────────┐
│                                                                     │
│  ┌──────────────────────────────────────────┐                      │
│  │         OpenTelemetry Collector          │                      │
│  │  :4317 (gRPC)  :4318 (HTTP)  :8889      │                      │
│  │                                          │                      │
│  │  logs ──→ Loki exporter ─────────────→ :3100                   │
│  │  traces → OTLP exporter ─────────────→ :4320                   │
│  │  metrics → prometheusremotewrite ────→ :9090                   │
│  └──────────────────────────────────────────┘                      │
│                                                                     │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────────┐ │
│  │ Grafana Loki   │  │ Grafana Tempo  │  │ Prometheus           │ │
│  │ :3100          │  │ :3200 (query)  │  │ :9090                │ │
│  │ 30d local      │  │ :4320 (ingest) │  │ 15d local TSDB       │ │
│  │ 365d → MinIO   │  │ 14d local      │  │                      │ │
│  └───────┬────────┘  │ 90d → MinIO    │  │ Scrape targets:      │ │
│          │           └───────┬────────┘  │  VM 200 :8861-8868   │ │
│          │                   │           │  VM 500-502 :9187     │ │
│          │                   │           │  VM 500-502 :8008     │ │
│  ┌───────┴───────────────────┴────┐      │  VM 500-502 :2379    │ │
│  │        Grafana :3000           │      │  VM 420-421 :9121    │ │
│  │  Datasources: Prometheus,      │      │  localhost :3100     │ │
│  │    Loki, Tempo                 │      │  localhost :3200     │ │
│  │  Faro receiver: /collect       │      │  localhost :8889     │ │
│  │  Alerting → Slack webhook      │      └──────────────────────┘ │
│  └────────────────────────────────┘                                │
│                                                                     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ S3 API (cold storage)
                               ▼
                  VM 402 (10.10.1.102:9000)
                  ┌──────────────────────┐
                  │ MinIO                │
                  │  loki-chunks/        │
                  │  loki-ruler/         │
                  │  tempo-traces/       │
                  └──────────────────────┘


Browser (Cloudflare Tunnel)
┌──────────────────────────┐
│ @arcaai/vox SDK          │
│  └ Grafana Faro SDK      │──── HTTPS ───→ grafana.taphuynh.dev
│    ├ Web Vitals           │               → 10.10.1.100:3000/collect
│    ├ JS errors            │               (Faro receiver)
│    ├ HTTP timing          │
│    ├ Console logs         │
│    └ Custom events:       │
│       audio.pipeline.*    │
│       ws.connection.*     │
│       stt.transcript.*    │
└──────────────────────────┘
```

### 3.5 Client-Side Telemetry Strategy

**Decision**: Use **Grafana Faro** as the single client-side collector instead of the SDK's existing Loki/OTel transports.

**Rationale**:
- Faro handles batching, offline buffering, and session correlation out of the box
- Faro pushes to Grafana's `/collect` endpoint which routes internally to Loki + Tempo
- Avoids exposing raw Loki (`:3100`) and OTel Collector (`:4317/4318`) endpoints to the public internet
- The SDK's existing LokiTransport and OTelTransport should be **disabled** when Faro is active to prevent duplicate telemetry

**What Faro captures**:
- Core Web Vitals: LCP, FID, CLS, TTFB, INP
- JavaScript errors with full stack traces and source maps
- Browser console log forwarding (warn + error levels)
- HTTP request/response timing (fetch/XHR instrumentation)
- Session metadata: tenantId, userId, browser, device, SDK version
- Custom events via `faro.api.pushEvent()`:
  - `audio.pipeline.start` / `audio.pipeline.stop` with duration
  - `ws.connect` / `ws.disconnect` / `ws.reconnect` with latency
  - `stt.transcript.received` with latency from audio send
  - `consultation.start` / `consultation.end` with duration
  - `vad.speech_detected` / `vad.silence_detected`

### 3.6 Trace Correlation: Client → Server

The SDK already generates `traceparent` headers on every HTTP request via `createTraceparent()`. This links browser spans to backend spans automatically.

For WebSocket (where headers aren't available after the upgrade handshake), the existing `SttWebSocketClient` sends an auth message as the first frame. The trace context will be included in this initial message using the envelope pattern:

```
Browser                          API Gateway                 STT
───────                          ───────────                 ──────
[consultation.start]
  └→ POST /api/v1/sessions
      traceparent: 00-{traceId}-{spanId}-01
                                 [handle-session]
                                   └→ POST /internal/sessions
                                       traceparent propagated
                                                              [create-session]

[audio.capture.start]
  └→ WS upgrade (traceparent in upgrade headers)
      first msg: {type:'auth', traceContext: {...}}
                                 [ws-bridge]
                                   └→ forward audio + traceContext
                                                              [transcribe]
```

---

## 4. Implementation Plan

### Phase 1: Infrastructure Foundation (VM 400)

**Effort**: ~1 day
**Prerequisites**: SSH access to VM 400, Proxmox console access, MinIO admin access

#### Step 1.1 — Expand VM 400 Disk to 128 GB

```bash
# On Proxmox host (192.168.68.130)
qm resize 400 scsi0 +64G

# On VM 400
ssh hope@10.10.1.100
sudo growpart /dev/sda 2          # or appropriate partition
sudo resize2fs /dev/sda2          # ext4
# OR for LVM:
sudo pvresize /dev/sda2
sudo lvextend -l +100%FREE /dev/mapper/ubuntu--vg-ubuntu--lv
sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv

# Verify
df -h /
# Expected: ~128 GB total
```

#### Step 1.2 — Create MinIO Buckets

```bash
# On VM 402 or any machine with mc (MinIO client)
mc alias set hope https://10.10.1.102:9000 <ACCESS_KEY> <SECRET_KEY> --insecure

mc mb hope/loki-chunks
mc mb hope/loki-ruler
mc mb hope/tempo-traces

# Verify
mc ls hope/
# Expected: loki-chunks/ loki-ruler/ tempo-traces/
```

#### Step 1.3 — Create Directory Structure on VM 400

```bash
ssh hope@10.10.1.100

sudo mkdir -p /opt/observability/{configs,data}
sudo mkdir -p /opt/observability/configs/{otel,prometheus,loki,tempo,grafana}
sudo mkdir -p /opt/observability/configs/grafana/{provisioning/datasources,provisioning/alerting,dashboards}
sudo mkdir -p /opt/observability/data/{prometheus,loki,tempo,grafana}

sudo chown -R hope:hope /opt/observability
```

#### Step 1.4 — VM 400 Firewall Hardening (UFW)

```bash
ssh hope@10.10.1.100

sudo apt install -y ufw

# Default policies
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH
sudo ufw allow from 10.10.1.0/24 to any port 22 proto tcp

# Rancher (existing)
sudo ufw allow from 10.10.1.0/24 to any port 80 proto tcp
sudo ufw allow from 10.10.1.0/24 to any port 443 proto tcp

# K3s API (existing)
sudo ufw allow from 10.10.1.0/24 to any port 6443 proto tcp

# Observability — OTel Collector (services push here)
sudo ufw allow from 10.10.1.0/24 to any port 4317 proto tcp   # OTLP gRPC
sudo ufw allow from 10.10.1.0/24 to any port 4318 proto tcp   # OTLP HTTP

# Observability — Grafana (Cloudflare Tunnel CT 101 at 10.10.1.2)
sudo ufw allow from 10.10.1.2 to any port 3000 proto tcp

# Observability — internal only (not exposed externally)
# Prometheus, Loki, Tempo only accessed via localhost (Docker internal network)
# No UFW rules needed — Docker manages its own iptables

# Enable
sudo ufw enable
sudo ufw status verbose
```

> **Important**: Docker bypasses UFW by default. Add DOCKER-USER chain rules to restrict Docker-published ports:

```bash
# Restrict Docker-published ports to vmbr1 subnet only
sudo iptables -I DOCKER-USER -i enp6s18 ! -s 10.10.1.0/24 -j DROP

# Persist
sudo apt install -y iptables-persistent
sudo netfilter-persistent save
```

#### Step 1.5 — OpenTelemetry Collector Config

File: `/opt/observability/configs/otel/otel-collector-config.yaml`

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: "0.0.0.0:4317"
      http:
        endpoint: "0.0.0.0:4318"
        cors:
          allowed_origins:
            - "https://*.taphuynh.dev"
            - "http://localhost:*"
          allowed_headers:
            - "Content-Type"
            - "X-Scope-OrgID"
            - "X-Tenant-ID"

processors:
  batch:
    send_batch_size: 1024
    timeout: 5s

  memory_limiter:
    check_interval: 1s
    limit_mib: 400
    spike_limit_mib: 100

  resource:
    attributes:
      - key: deployment.environment
        value: "production"
        action: upsert
      - key: service.namespace
        value: "hope"
        action: upsert

exporters:
  loki:
    endpoint: "http://loki:3100/loki/api/v1/push"
    default_labels_enabled:
      exporter: true
      job: true
      instance: true
      level: true

  otlp/tempo:
    endpoint: "tempo:4317"
    tls:
      insecure: true

  prometheusremotewrite:
    endpoint: "http://prometheus:9090/api/v1/write"
    resource_to_telemetry_conversion:
      enabled: true

  debug:
    verbosity: basic

extensions:
  health_check:
    endpoint: "0.0.0.0:13133"

  zpages:
    endpoint: "0.0.0.0:55679"

service:
  extensions: [health_check, zpages]
  telemetry:
    metrics:
      address: "0.0.0.0:8889"
    logs:
      level: "info"

  pipelines:
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [loki]

    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [otlp/tempo]

    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [prometheusremotewrite]
```

#### Step 1.6 — Prometheus Config

File: `/opt/observability/configs/prometheus/prometheus.yml`

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: "hope-production"
    environment: "production"

remote_write:
  - url: "http://localhost:9090/api/v1/write"

scrape_configs:
  # ── Application Services (VM 200) ──
  - job_name: "api-gateway"
    metrics_path: "/metrics"
    static_configs:
      - targets: ["10.10.1.10:8868"]
        labels:
          service: "api-gateway"
          vm: "200"

  - job_name: "stt"
    metrics_path: "/metrics"
    static_configs:
      - targets: ["10.10.1.10:8861"]
        labels:
          service: "stt"
          vm: "200"

  - job_name: "smr"
    metrics_path: "/metrics"
    static_configs:
      - targets: ["10.10.1.10:8862"]
        labels:
          service: "smr"
          vm: "200"

  - job_name: "nlp"
    metrics_path: "/metrics"
    static_configs:
      - targets: ["10.10.1.10:8864"]
        labels:
          service: "nlp"
          vm: "200"

  # ── Database Cluster (VMs 500-502) ──
  - job_name: "postgres-exporter"
    scrape_interval: 30s
    static_configs:
      - targets:
          - "10.10.1.200:9187"
          - "10.10.1.201:9187"
          - "10.10.1.202:9187"
        labels:
          service: "postgresql"

  - job_name: "patroni"
    scrape_interval: 30s
    metrics_path: "/metrics"
    static_configs:
      - targets:
          - "10.10.1.200:8008"
          - "10.10.1.201:8008"
          - "10.10.1.202:8008"
        labels:
          service: "patroni"

  - job_name: "etcd"
    scrape_interval: 30s
    metrics_path: "/metrics"
    static_configs:
      - targets:
          - "10.10.1.200:2379"
          - "10.10.1.201:2379"
          - "10.10.1.202:2379"
        labels:
          service: "etcd"

  # ── Redis (VMs 420-421) ──
  - job_name: "redis"
    scrape_interval: 30s
    static_configs:
      - targets:
          - "10.10.1.120:9121"
          - "10.10.1.121:9121"
        labels:
          service: "redis"

  # ── Observability Stack Self-Monitoring ──
  - job_name: "otel-collector"
    static_configs:
      - targets: ["otel-collector:8889"]
        labels:
          service: "otel-collector"

  - job_name: "loki"
    scrape_interval: 30s
    static_configs:
      - targets: ["loki:3100"]
        labels:
          service: "loki"

  - job_name: "tempo"
    scrape_interval: 30s
    static_configs:
      - targets: ["tempo:3200"]
        labels:
          service: "tempo"

  - job_name: "grafana"
    scrape_interval: 30s
    static_configs:
      - targets: ["grafana:3000"]
        labels:
          service: "grafana"

  - job_name: "prometheus"
    static_configs:
      - targets: ["localhost:9090"]
        labels:
          service: "prometheus"

storage:
  tsdb:
    retention:
      time: 15d
      size: 15GB
```

#### Step 1.7 — Grafana Loki Config

File: `/opt/observability/configs/loki/loki-config.yaml`

```yaml
auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096
  log_level: info

common:
  path_prefix: /loki
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: "2026-04-01"
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

ingester:
  chunk_encoding: snappy
  chunk_idle_period: 1h
  max_chunk_age: 2h
  chunk_target_size: 1572864
  flush_check_period: 30s

storage_config:
  filesystem:
    directory: /loki/chunks

  tsdb_shipper:
    active_index_directory: /loki/tsdb-index
    cache_location: /loki/tsdb-cache

limits_config:
  retention_period: 720h
  ingestion_rate_mb: 10
  ingestion_burst_size_mb: 20
  max_query_parallelism: 8
  max_query_series: 5000
  max_entries_limit_per_query: 10000

compactor:
  working_directory: /loki/compactor
  compaction_interval: 10m
  retention_enabled: true
  retention_delete_delay: 2h
  retention_delete_worker_count: 150
  delete_request_store: filesystem

querier:
  max_concurrent: 4

query_scheduler:
  max_outstanding_requests_per_tenant: 2048

ruler:
  storage:
    type: local
    local:
      directory: /loki/rules
  rule_path: /loki/rules-tmp
  enable_api: true

analytics:
  reporting_enabled: false
```

> **Note**: MinIO cold storage integration (S3 backend for chunks older than 30 days) will be configured in Phase 5 as an enhancement. Phase 1 uses local filesystem only to reduce initial complexity.

#### Step 1.8 — Grafana Tempo Config

File: `/opt/observability/configs/tempo/tempo-config.yaml`

```yaml
server:
  http_listen_port: 3200
  log_level: info

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: "0.0.0.0:4317"

ingester:
  max_block_duration: 5m
  trace_idle_period: 10s
  max_block_bytes: 1073741824

compactor:
  compaction:
    block_retention: 336h

storage:
  trace:
    backend: local
    wal:
      path: /var/tempo/wal
    local:
      path: /var/tempo/blocks

metrics_generator:
  registry:
    external_labels:
      source: tempo
  storage:
    path: /var/tempo/generator/wal
    remote_write:
      - url: http://prometheus:9090/api/v1/write
        send_exemplars: true
  processor:
    service_graphs:
      dimensions:
        - service.namespace
        - deployment.environment
    span_metrics:
      dimensions:
        - service.namespace
        - http.method
        - http.status_code
        - http.route

overrides:
  defaults:
    metrics_generator:
      processors:
        - service-graphs
        - span-metrics

usage_report:
  reporting_enabled: false
```

> **Note**: MinIO cold storage for Tempo (blocks older than 14 days) will be configured in Phase 5.

#### Step 1.9 — Grafana Datasource Provisioning

File: `/opt/observability/configs/grafana/provisioning/datasources/datasources.yaml`

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
    jsonData:
      httpMethod: POST
      exemplarTraceIdDestinations:
        - name: traceID
          datasourceUid: tempo
      incrementalQuerying: true
      incrementalQueryOverlapWindow: 10m

  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    editable: false
    jsonData:
      derivedFields:
        - datasourceUid: tempo
          matcherRegex: '"traceId"\s*:\s*"(\w+)"'
          name: TraceID
          url: "$${__value.raw}"
        - datasourceUid: tempo
          matcherRegex: 'traceId=(\w+)'
          name: TraceID
          url: "$${__value.raw}"
      maxLines: 1000

  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    editable: false
    jsonData:
      httpMethod: GET
      tracesToLogsV2:
        datasourceUid: loki
        spanStartTimeShift: "-1h"
        spanEndTimeShift: "1h"
        filterByTraceID: true
        filterBySpanID: false
        customQuery: true
        query: '{service_name="${__span.tags["service.name"]}"} | json | traceId = `${__span.traceId}`'
      tracesToMetrics:
        datasourceUid: prometheus
        spanStartTimeShift: "-1h"
        spanEndTimeShift: "1h"
        tags:
          - key: service.name
            value: service
        queries:
          - name: "Request Rate"
            query: 'rate(http_requests_total{service="$${__tags.service}"}[5m])'
          - name: "Error Rate"
            query: 'rate(http_requests_total{service="$${__tags.service}",status=~"5.."}[5m])'
      tracesToProfiles:
        datasourceUid: ""
      serviceMap:
        datasourceUid: prometheus
      nodeGraph:
        enabled: true
      search:
        filters:
          - id: service-name
            tag: service.name
            operator: "="
            scope: resource
          - id: span-name
            tag: name
            operator: "="
            scope: span
      lokiSearch:
        datasourceUid: loki
```

#### Step 1.10 — Grafana Dashboard Provisioning

File: `/opt/observability/configs/grafana/provisioning/dashboards/dashboards.yaml`

```yaml
apiVersion: 1

providers:
  - name: "HOPE Dashboards"
    orgId: 1
    folder: "HOPE"
    type: file
    disableDeletion: false
    editable: true
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: /var/lib/grafana/dashboards
      foldersFromFilesStructure: false
```

#### Step 1.11 — Grafana Faro Config (in grafana.ini)

File: `/opt/observability/configs/grafana/grafana.ini`

```ini
[server]
http_port = 3000
root_url = https://grafana.taphuynh.dev
serve_from_sub_path = false

[security]
admin_user = admin
admin_password = ${GF_SECURITY_ADMIN_PASSWORD}

[auth.anonymous]
enabled = false

[analytics]
reporting_enabled = false

[unified_alerting]
enabled = true

[alerting]
enabled = false

[feature_toggles]
enable = traceToMetrics tempoSearch tempoBackendSearch tempoServiceGraph

[plugin.grafana-pyroscope-app]
enabled = false

[app.faro]
enabled = true
```

#### Step 1.12 — Docker Compose

File: `/opt/observability/docker-compose.observability.yml`

```yaml
name: hope-observability

services:
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.120.0
    container_name: otel-collector
    restart: unless-stopped
    command: ["--config=/etc/otel-collector-config.yaml"]
    volumes:
      - ./configs/otel/otel-collector-config.yaml:/etc/otel-collector-config.yaml:ro
    ports:
      - "4317:4317"   # OTLP gRPC
      - "4318:4318"   # OTLP HTTP
      - "8889:8889"   # Prometheus self-metrics
      - "13133:13133" # Health check
      - "55679:55679" # zPages
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 256M
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:13133/"]
      interval: 15s
      timeout: 5s
      retries: 3
    depends_on:
      loki:
        condition: service_healthy
      tempo:
        condition: service_healthy

  prometheus:
    image: prom/prometheus:v3.2.0
    container_name: prometheus
    restart: unless-stopped
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
      - "--storage.tsdb.path=/prometheus"
      - "--storage.tsdb.retention.time=15d"
      - "--storage.tsdb.retention.size=15GB"
      - "--web.enable-remote-write-receiver"
      - "--web.enable-lifecycle"
      - "--web.console.libraries=/etc/prometheus/console_libraries"
      - "--web.console.templates=/etc/prometheus/consoles"
    volumes:
      - ./configs/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./data/prometheus:/prometheus
    ports:
      - "9090:9090"
    deploy:
      resources:
        limits:
          memory: 1G
        reservations:
          memory: 512M
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:9090/-/healthy"]
      interval: 15s
      timeout: 5s
      retries: 3

  loki:
    image: grafana/loki:3.4.0
    container_name: loki
    restart: unless-stopped
    command: ["-config.file=/etc/loki/loki-config.yaml"]
    volumes:
      - ./configs/loki/loki-config.yaml:/etc/loki/loki-config.yaml:ro
      - ./data/loki:/loki
    ports:
      - "3100:3100"
    deploy:
      resources:
        limits:
          memory: 1G
        reservations:
          memory: 512M
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3100/ready"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s

  tempo:
    image: grafana/tempo:2.7.0
    container_name: tempo
    restart: unless-stopped
    command: ["-config.file=/etc/tempo/tempo-config.yaml"]
    volumes:
      - ./configs/tempo/tempo-config.yaml:/etc/tempo/tempo-config.yaml:ro
      - ./data/tempo:/var/tempo
    ports:
      - "3200:3200"   # HTTP query
      - "4320:4317"   # OTLP gRPC (mapped to 4320 to avoid conflict with otel-collector)
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 256M
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3200/ready"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s

  grafana:
    image: grafana/grafana:11.5.0
    container_name: grafana
    restart: unless-stopped
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD:-hope-admin-2026}
      - GF_INSTALL_PLUGINS=https://storage.googleapis.com/integration-artifacts/grafana-lokiexplore-app/grafana-lokiexplore-app-latest.zip;grafana-lokiexplore-app
    volumes:
      - ./configs/grafana/grafana.ini:/etc/grafana/grafana.ini:ro
      - ./configs/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./configs/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - ./data/grafana:/var/lib/grafana
    ports:
      - "3000:3000"
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 256M
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/api/health"]
      interval: 15s
      timeout: 5s
      retries: 3
    depends_on:
      prometheus:
        condition: service_healthy
      loki:
        condition: service_healthy
      tempo:
        condition: service_healthy

networks:
  default:
    name: observability
    driver: bridge
```

#### Step 1.13 — Environment File

File: `/opt/observability/.env`

```bash
GRAFANA_ADMIN_PASSWORD=<set-a-strong-password>
```

#### Step 1.14 — Deploy and Verify

```bash
ssh hope@10.10.1.100
cd /opt/observability

# Deploy
docker compose -f docker-compose.observability.yml up -d

# Wait for health checks
sleep 30

# Verify all containers
docker compose -f docker-compose.observability.yml ps
# Expected: all 5 containers "healthy"

# Verify Prometheus
curl -s http://localhost:9090/-/healthy
# Expected: "Prometheus Server is Healthy."

# Verify Loki
curl -s http://localhost:3100/ready
# Expected: "ready"

# Verify Tempo
curl -s http://localhost:3200/ready
# Expected: "ready"

# Verify OTel Collector
curl -s http://localhost:13133/
# Expected: {"status":"Server available"...}

# Verify Grafana
curl -s http://localhost:3000/api/health
# Expected: {"commit":"...","database":"ok","version":"11.5.0"}

# Verify Prometheus scrapes itself
curl -s http://localhost:9090/api/v1/targets | python3 -m json.tool | grep -c '"health":"up"'
# Expected: at least 1 (prometheus self-scrape)
```

**Phase 1 Gate**: All 5 containers running and healthy. Grafana loads at `:3000`. Prometheus has at least self-scrape target UP.

---

### Phase 2: Server-Side Telemetry Wiring

**Effort**: ~2 days
**Prerequisites**: Phase 1 complete, SSH access to VM 200

#### Step 2.1 — Verify VM 200 Port Exposure

```bash
ssh hope@10.10.1.10

# Check if service ports are accessible from outside the VM
# From VM 400:
ssh hope@10.10.1.100

curl -s http://10.10.1.10:8868/metrics | head -5
curl -s http://10.10.1.10:8861/metrics | head -5
curl -s http://10.10.1.10:8862/metrics | head -5
curl -s http://10.10.1.10:8864/metrics | head -5

# If any returns "connection refused":
# The service is either not running or bound to 127.0.0.1
# Check K3s service definitions:
ssh hope@10.10.1.10
kubectl get svc -A | grep -E '8861|8862|8864|8868'

# If services use ClusterIP, add NodePort or hostPort:
# Option A: Change service type to NodePort
# Option B: Add hostNetwork: true to pod spec
# Option C: Use kubectl port-forward as a temporary test
```

#### Step 2.2 — API Gateway OTel Instrumentation

The API gateway already has OTEL env vars in its Dockerfile. Enable them:

```bash
# Set environment variables for the API gateway container/pod
OTEL_SERVICE_NAME=api-gateway
OTEL_TRACES_ENABLED=true
OTEL_METRICS_ENABLED=true
OTEL_LOGS_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.10.1.100:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_RESOURCE_ATTRIBUTES=service.namespace=hope,deployment.environment=production

# For the existing LoggingService Loki transport:
LOKI_HOST=http://10.10.1.100:3100
LOKI_ENABLED=true
```

If auto-instrumentation is not yet wired in code, add to `apps/api/src/instrumentation.ts`:

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const resource = new Resource({
  [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'api-gateway',
  [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '1.0.0',
  'service.namespace': 'hope',
  'deployment.environment': process.env.NODE_ENV || 'production',
});

const sdk = new NodeSDK({
  resource,
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 15000,
  }),
  logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
    new PrismaInstrumentation(),
  ],
});

sdk.start();

process.on('SIGTERM', () => sdk.shutdown());
```

Import this file at the very top of `apps/api/src/main.ts` (before anything else):

```typescript
import './instrumentation';
// ... rest of imports
```

#### Step 2.3 — STT OTel Instrumentation

```python
# apps/stt — add/update environment variables:
OTEL_SERVICE_NAME=stt
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.10.1.100:4317
OTEL_TRACES_ENABLED=true

# In the FastAPI app setup (likely main.py or a setup module):
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import Resource

resource = Resource.create({
    "service.name": "stt",
    "service.version": "2.0.0",
    "service.namespace": "hope",
    "deployment.environment": "production",
})

provider = TracerProvider(resource=resource)
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint="10.10.1.100:4317", insecure=True))
)
trace.set_tracer_provider(provider)

FastAPIInstrumentor.instrument_app(app)
```

#### Step 2.4 — SMR OTel Instrumentation

SMR already supports OTel. Enable via environment:

```bash
SMR_OTEL_ENABLED=true
OTEL_SERVICE_NAME=smr
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.10.1.100:4317
```

#### Step 2.5 — NLP OTel Instrumentation

NLP already has full OTel setup in `nlp.core.observability`. Enable via environment:

```bash
OTEL_SERVICE_NAME=nlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.10.1.100:4317
OTEL_TRACES_ENABLED=true
OTEL_METRICS_ENABLED=true
```

#### Step 2.6 — Verification

```bash
# From VM 400:

# 1. Verify Prometheus targets
curl -s http://localhost:9090/api/v1/targets | python3 -c "
import json, sys
data = json.load(sys.stdin)
for group in data['data']['activeTargets']:
    print(f\"{group['labels'].get('job', 'unknown'):25s} {group['health']:6s} {group['lastError']}\")
"
# Expected: all jobs show "up"

# 2. Verify Loki has logs
curl -s 'http://localhost:3100/loki/api/v1/query?query=\{service_name=~".+"}&limit=5' | python3 -m json.tool
# Expected: log entries from services

# 3. Verify Tempo has traces
curl -s 'http://localhost:3200/api/search?limit=5' | python3 -m json.tool
# Expected: trace summaries with multiple services

# 4. Cross-service trace test
# Make an API call that triggers downstream services:
curl -s http://10.10.1.10:8868/api/v1/health/services
# Then search Tempo for the resulting trace
```

**Phase 2 Gate**: Prometheus shows all scrape targets UP. Loki has logs from 4 services. Tempo shows traces spanning multiple services.

---

### Phase 3: Dashboards and Alerting

**Effort**: ~1 day
**Prerequisites**: Phase 2 complete

#### Step 3.1 — Import Existing SMR Dashboards

```bash
# Copy existing dashboard JSONs to Grafana provisioning directory
ssh hope@10.10.1.100

# From the repo (clone or scp):
cp infrastructure/grafana/dashboards/smr-overview.json \
   /opt/observability/configs/grafana/dashboards/
cp infrastructure/grafana/dashboards/smr-resilience.json \
   /opt/observability/configs/grafana/dashboards/
cp infrastructure/grafana/dashboards/smr-security.json \
   /opt/observability/configs/grafana/dashboards/

# Grafana auto-discovers new files (updateIntervalSeconds: 30)
```

#### Step 3.2 — Build Service Health Overview Dashboard

This is the primary at-a-glance dashboard. Build in Grafana UI or provision as JSON.

**Panels:**

| Row | Panel | Query | Visualization |
|-----|-------|-------|---------------|
| 1 | API Status | `up{job="api-gateway"}` | Stat (green/red) |
| 1 | STT Status | `up{job="stt"}` | Stat |
| 1 | SMR Status | `up{job="smr"}` | Stat |
| 1 | NLP Status | `up{job="nlp"}` | Stat |
| 1 | DB Status | `min(up{job="postgres-exporter"})` | Stat |
| 1 | Redis Status | `min(up{job="redis"})` | Stat |
| 2 | Request Rate | `sum(rate(http_requests_total[5m])) by (job)` | Time series |
| 2 | Error Rate | `sum(rate(http_requests_total{status=~"5.."}[5m])) by (job) / sum(rate(http_requests_total[5m])) by (job)` | Time series (%) |
| 3 | P95 Latency | `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, job))` | Time series |
| 3 | P50 Latency | `histogram_quantile(0.50, ...)` | Time series |
| 4 | Recent Errors | `{level="error"} \| json` (Loki) | Logs panel |

#### Step 3.3 — Build Database Cluster Dashboard

**Panels:**

| Panel | Query | Purpose |
|-------|-------|---------|
| Patroni Leader | `patroni_master` by instance | Who is primary? |
| Replication Lag | `pg_replication_lag_seconds` | Replica health |
| Active Connections | `pg_stat_activity_count` | Connection saturation |
| Transactions/sec | `rate(pg_stat_database_xact_commit[5m])` | Throughput |
| Cache Hit Ratio | `pg_stat_database_blks_hit / (pg_stat_database_blks_hit + pg_stat_database_blks_read)` | Buffer effectiveness |
| Table Bloat | `pg_stat_user_tables_n_dead_tup` | Vacuum health |
| Disk Usage | `pg_database_size_bytes` | Capacity |

#### Step 3.4 — Build Redis Monitoring Dashboard

**Panels:**

| Panel | Query | Purpose |
|-------|-------|---------|
| Memory Usage | `redis_memory_used_bytes / redis_memory_max_bytes` | Saturation |
| Connected Clients | `redis_connected_clients` | Client count |
| Commands/sec | `rate(redis_commands_processed_total[5m])` | Throughput |
| Keyspace | `redis_db_keys` | Key count per DB |
| Hit Ratio | `redis_keyspace_hits_total / (redis_keyspace_hits_total + redis_keyspace_misses_total)` | Cache effectiveness |
| Evictions | `rate(redis_evicted_keys_total[5m])` | Memory pressure |

#### Step 3.5 — Build AI Pipeline Performance Dashboard

**Panels:**

| Panel | Query | Purpose |
|-------|-------|---------|
| STT P95 Latency | `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{job="stt"}[5m]))` | Transcription speed |
| SMR Token Throughput | `rate(smr_tokens_total[5m])` | Generation speed |
| SMR Time to First Token | `histogram_quantile(0.95, rate(smr_time_to_first_token_seconds_bucket[5m]))` | Responsiveness |
| NLP Classification Time | `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{job="nlp"}[5m]))` | NER speed |
| SMR Active Generations | `smr_active_generations` | Concurrency |
| SMR Circuit Breaker | `smr_circuit_breaker_state` | Provider health |
| SMR Queue Depth | `smr_queue_size` | Backpressure |

#### Step 3.6 — Configure Slack Alerting

In Grafana UI → Alerting → Contact Points:

1. Create contact point "Slack Critical":
   - Type: Slack
   - Webhook URL: `https://hooks.slack.com/services/T.../B.../...`
   - Channel: `#hope-alerts-critical`
   - Title: `{{ .CommonLabels.alertname }}`

2. Create contact point "Slack Warning":
   - Channel: `#hope-alerts-warning`

3. Create contact point "Slack Info":
   - Channel: `#hope-alerts-info`

#### Step 3.7 — Configure Notification Policies

In Grafana UI → Alerting → Notification Policies:

```
Root policy: Slack Info (default receiver)
  │
  ├─ Match: severity=critical
  │  Receiver: Slack Critical
  │  Group wait: 30s
  │  Group interval: 5m
  │  Repeat interval: 5m
  │
  ├─ Match: severity=warning
  │  Receiver: Slack Warning
  │  Group wait: 1m
  │  Group interval: 10m
  │  Repeat interval: 30m
  │  Mute timings: nighttime (22:00-07:00)
  │
  └─ Match: severity=info
     Receiver: Slack Info
     Group wait: 5m
     Group interval: 30m
     Repeat interval: 2h
     Mute timings: weekends
```

#### Step 3.8 — Create Alert Rules

In Grafana UI → Alerting → Alert Rules:

**Folder: HOPE Critical Alerts**

| Rule | Expression | For | Labels |
|------|-----------|-----|--------|
| Service Down | `up == 0` | 1m | severity=critical |
| API Error Rate High | `rate(http_requests_total{status=~"5..",job="api-gateway"}[5m]) / rate(http_requests_total{job="api-gateway"}[5m]) > 0.05` | 2m | severity=critical |
| DB Replication Lag Critical | `pg_replication_lag_seconds > 30` | 1m | severity=critical |
| Redis OOM | `redis_memory_used_bytes / redis_memory_max_bytes > 0.95` | 1m | severity=critical |

**Folder: HOPE Warning Alerts**

| Rule | Expression | For | Labels |
|------|-----------|-----|--------|
| High API Latency | `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{job="api-gateway"}[5m])) > 2` | 5m | severity=warning |
| SMR Generation Errors | `rate(smr_generation_errors_total[5m]) > 0.1` | 5m | severity=warning |
| DB Connection Saturation | `pg_stat_activity_count / pg_settings_max_connections > 0.8` | 5m | severity=warning |
| Disk Usage High | `(1 - node_filesystem_avail_bytes/node_filesystem_size_bytes) > 0.8` | 10m | severity=warning |
| OTel Collector Drops | `rate(otelcol_exporter_send_failed_spans_total[5m]) > 0` | 5m | severity=warning |

**Folder: HOPE Info Alerts**

| Rule | Expression | For | Labels |
|------|-----------|-----|--------|
| DB Replication Lag Rising | `pg_replication_lag_seconds > 5` | 5m | severity=info |
| Redis Memory High | `redis_memory_used_bytes / redis_memory_max_bytes > 0.8` | 10m | severity=info |
| Client SDK Error Spike | Loki: `count_over_time({app="arcaai-vox",level="error"}[5m]) > 10` | 5m | severity=info |

#### Step 3.9 — Cloudflare Tunnel Route

Add in Cloudflare Zero Trust Dashboard → Tunnels → Configure:

| Public Hostname | Service |
|---|---|
| `grafana.taphuynh.dev` | `http://10.10.1.100:3000` |

**Phase 3 Gate**: All dashboards display live data. Slack receives test alert notification and resolve message.

---

### Phase 4: Client-Side RUM (Grafana Faro)

**Effort**: ~2 days
**Prerequisites**: Phase 3 complete

#### Step 4.1 — Add Faro Dependencies

```bash
# In the monorepo root
pnpm add -D @grafana/faro-web-sdk @grafana/faro-web-tracing --filter @arcaai/vox
pnpm add -D @grafana/faro-web-sdk @grafana/faro-web-tracing --filter ui-playground
```

#### Step 4.2 — Create Faro Integration Module in SDK

Create `packages/agentic-sdk-v2/src/core/faro/FaroIntegration.ts`:

```typescript
import {
  initializeFaro,
  getWebInstrumentations,
  type Faro,
  type FaroConfig,
  LogLevel,
} from '@grafana/faro-web-sdk';
import { TracingInstrumentation } from '@grafana/faro-web-tracing';

export interface FaroOptions {
  /** Grafana Faro collector URL (e.g., https://grafana.taphuynh.dev/collect) */
  collectorUrl: string;
  /** Application name */
  appName?: string;
  /** Application version */
  appVersion?: string;
  /** Tenant ID for multi-tenancy */
  tenantId?: string;
  /** User ID */
  userId?: string;
  /** Enable trace propagation to backend */
  enableTracing?: boolean;
  /** Propagate traces to these URL patterns */
  tracePropagationTargets?: (string | RegExp)[];
}

let faroInstance: Faro | null = null;

export function initFaro(options: FaroOptions): Faro {
  if (faroInstance) return faroInstance;

  const config: FaroConfig = {
    url: options.collectorUrl,
    app: {
      name: options.appName || 'arcaai-vox',
      version: options.appVersion || '2.0.0',
    },
    instrumentations: [
      ...getWebInstrumentations({
        captureConsole: true,
        captureConsoleDisabledLevels: [LogLevel.DEBUG, LogLevel.TRACE],
      }),
      ...(options.enableTracing
        ? [
            new TracingInstrumentation({
              instrumentationOptions: {
                propagateTraceHeaderCorsUrls:
                  options.tracePropagationTargets || [/.*/],
              },
            }),
          ]
        : []),
    ],
    sessionTracking: {
      enabled: true,
      persistent: true,
    },
    batching: {
      enabled: true,
      sendTimeout: 250,
      itemLimit: 50,
    },
  };

  faroInstance = initializeFaro(config);

  if (options.tenantId) {
    faroInstance.api.setUser({
      id: options.userId,
      attributes: { tenantId: options.tenantId },
    });
  }

  return faroInstance;
}

export function getFaro(): Faro | null {
  return faroInstance;
}

export function pushEvent(
  name: string,
  attributes?: Record<string, string>,
): void {
  faroInstance?.api.pushEvent(name, attributes);
}

export function pushError(error: Error, context?: Record<string, string>): void {
  faroInstance?.api.pushError(error, { context });
}

export function setUser(userId: string, tenantId: string): void {
  faroInstance?.api.setUser({
    id: userId,
    attributes: { tenantId },
  });
}

export function destroyFaro(): void {
  faroInstance?.pause();
  faroInstance = null;
}
```

#### Step 4.3 — Integrate Faro in AgenticProvider

In `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx`, add Faro initialization alongside existing SDK setup:

```typescript
import { initFaro, setUser, destroyFaro } from '../core/faro/FaroIntegration';

// Inside AgenticProvider initialization (useEffect):
if (config.logging?.faro?.enabled) {
  initFaro({
    collectorUrl: config.logging.faro.collectorUrl,
    appName: 'arcaai-vox',
    tenantId: config.api.tenantId,
    userId: authUser?.id,
    enableTracing: true,
    tracePropagationTargets: [
      new RegExp(config.api.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    ],
  });
}

// On auth change:
if (authUser) {
  setUser(authUser.id, config.api.tenantId);
}

// On unmount cleanup:
destroyFaro();
```

#### Step 4.4 — Add Custom Audio Pipeline Events

Instrument key SDK operations with Faro events:

```typescript
import { pushEvent } from '../core/faro/FaroIntegration';

// In audio capture start:
pushEvent('audio.capture.start', {
  sessionId,
  sttMode: mode, // 'local' | 'remote'
  noiseFilter: String(noiseFilterEnabled),
});

// In transcript received:
pushEvent('stt.transcript.received', {
  latencyMs: String(Date.now() - audioSentTimestamp),
  wordCount: String(transcript.split(' ').length),
  language,
});

// In WebSocket connect:
pushEvent('ws.connect', {
  url: wsUrl,
  reconnectAttempt: String(attemptNumber),
});

// In WebSocket disconnect:
pushEvent('ws.disconnect', {
  reason,
  durationMs: String(Date.now() - connectTimestamp),
});

// In summary generation:
pushEvent('summary.generation.start', {
  consultationId,
  provider,
});

pushEvent('summary.generation.complete', {
  consultationId,
  latencyMs: String(duration),
  tokenCount: String(tokens),
});
```

#### Step 4.5 — Update SDK Config Types

Add Faro config to `AgenticConfig`:

```typescript
interface AgenticConfig {
  // ... existing fields
  logging?: {
    // ... existing fields
    faro?: {
      enabled: boolean;
      collectorUrl: string;
    };
  };
}
```

#### Step 4.6 — Add Faro to ui-playground

In `apps/ui-playground/src/main.tsx`:

```typescript
import { initializeFaro, getWebInstrumentations } from '@grafana/faro-web-sdk';
import { TracingInstrumentation } from '@grafana/faro-web-tracing';

if (import.meta.env.PROD) {
  initializeFaro({
    url: import.meta.env.VITE_FARO_COLLECTOR_URL || 'https://grafana.taphuynh.dev/collect',
    app: {
      name: 'ui-playground',
      version: '1.0.0',
    },
    instrumentations: [
      ...getWebInstrumentations({ captureConsole: true }),
      new TracingInstrumentation(),
    ],
  });
}
```

#### Step 4.7 — Build Client SDK / RUM Dashboard

**Panels:**

| Panel | Source | Purpose |
|-------|--------|---------|
| Active Sessions | Faro (Loki) | Count of unique sessionId in last 15m |
| Web Vitals — LCP | Faro | Largest Contentful Paint distribution |
| Web Vitals — CLS | Faro | Cumulative Layout Shift |
| Web Vitals — INP | Faro | Interaction to Next Paint |
| JS Error Rate | Faro (Loki) | Errors per session |
| Top JS Errors | Faro (Loki) | Most frequent error messages |
| Audio Pipeline Events | Faro (Loki) | `audio.capture.start`, `stt.transcript.received` counts |
| STT Transcript Latency | Faro (Loki) | Distribution of `stt.transcript.received.latencyMs` |
| WebSocket Stability | Faro (Loki) | `ws.connect` / `ws.disconnect` / `ws.reconnect` counts |
| Browser Traces | Tempo | Browser-originated traces with backend correlation |

#### Step 4.8 — Verification

1. Open `ui-playground` in a browser
2. Perform a consultation (start session, speak, get transcript, generate summary)
3. In Grafana → Explore → Loki: query `{app="arcaai-vox"}` — should see logs + events
4. In Grafana → Explore → Tempo: search by `service.name=arcaai-vox` — should see browser traces
5. Click a browser trace → verify it links to backend API gateway span
6. Check the Client SDK / RUM dashboard — should show Web Vitals and custom events

**Phase 4 Gate**: Grafana shows browser sessions with Web Vitals. Custom audio events visible. Browser traces correlate with backend spans.

---

## 5. Future Enhancements (Phase 5+)

These are deferred from the initial deployment but documented for planning:

| Enhancement | Description | Priority |
|---|---|---|
| MinIO cold storage | Configure Loki S3 backend for chunks >30d, Tempo S3 for blocks >14d | High |
| NVIDIA DCGM GPU exporter | Deploy on VM 200 for GPU utilization, memory, temperature, power metrics | High |
| Node Exporter on all VMs | VM-level CPU, memory, disk, network metrics | Medium |
| Multi-tenant Loki | Route logs by `X-Scope-OrgID` header mapped to tenantId | Medium |
| PHI redaction in OTel Collector | Add `attributes/remove-phi` and `transform/redact-phi` processors | Medium |
| Audit log pipeline | Separate Loki tenant with 6-year retention for HIPAA compliance | Medium |
| kube-state-metrics | K3s pod/deployment/node metrics on VM 200 | Low |
| Grafana OnCall alternative | PagerDuty/Opsgenie integration for on-call rotation | Low |
| SLO tracking | Grafana SLO plugin for service-level objectives | Low |
| Continuous profiling | Grafana Pyroscope for CPU/memory profiling | Low |

---

## 6. Configuration Reference

### Environment Variables per Service

#### API Gateway (apps/api/)

```bash
# OpenTelemetry
OTEL_SERVICE_NAME=api-gateway
OTEL_TRACES_ENABLED=true
OTEL_METRICS_ENABLED=true
OTEL_LOGS_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.10.1.100:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_RESOURCE_ATTRIBUTES=service.namespace=hope,deployment.environment=production

# Loki (existing LoggingService transport)
LOKI_HOST=http://10.10.1.100:3100
LOKI_ENABLED=true
```

#### STT (apps/stt/)

```bash
OTEL_SERVICE_NAME=stt
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.10.1.100:4317
OTEL_TRACES_ENABLED=true
```

#### SMR (apps/smr/)

```bash
SMR_OTEL_ENABLED=true
OTEL_SERVICE_NAME=smr
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.10.1.100:4317
```

#### NLP (apps/nlp/)

```bash
OTEL_SERVICE_NAME=nlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.10.1.100:4317
OTEL_TRACES_ENABLED=true
OTEL_METRICS_ENABLED=true
```

#### @arcaai/vox SDK (client-side)

```typescript
const config: AgenticConfig = {
  logging: {
    faro: {
      enabled: true,
      collectorUrl: 'https://grafana.taphuynh.dev/collect',
    },
    // Disable existing transports when Faro is active:
    loki: { enabled: false },
    otel: { enabled: false },
  },
};
```

#### ui-playground (apps/ui-playground/)

```bash
VITE_FARO_COLLECTOR_URL=https://grafana.taphuynh.dev/collect
```

### Port Map (Complete)

| VM | IP | Port | Service | Protocol | Scraped By |
|---|---|---|---|---|---|
| 200 | 10.10.1.10 | 8868 | API Gateway | HTTP | Prometheus |
| 200 | 10.10.1.10 | 8861 | STT | HTTP | Prometheus |
| 200 | 10.10.1.10 | 8862 | SMR | HTTP | Prometheus |
| 200 | 10.10.1.10 | 8864 | NLP | HTTP | Prometheus |
| 400 | 10.10.1.100 | 4317 | OTel Collector gRPC | gRPC | — (receives) |
| 400 | 10.10.1.100 | 4318 | OTel Collector HTTP | HTTP | — (receives) |
| 400 | 10.10.1.100 | 8889 | OTel Collector metrics | HTTP | Prometheus |
| 400 | 10.10.1.100 | 9090 | Prometheus | HTTP | self |
| 400 | 10.10.1.100 | 3100 | Loki | HTTP | Prometheus |
| 400 | 10.10.1.100 | 3200 | Tempo (query) | HTTP | Prometheus |
| 400 | 10.10.1.100 | 4320 | Tempo (OTLP ingest) | gRPC | — (receives) |
| 400 | 10.10.1.100 | 3000 | Grafana | HTTP | Prometheus |
| 402 | 10.10.1.102 | 9000 | MinIO S3 API | HTTPS | — (storage) |
| 500 | 10.10.1.200 | 9187 | postgres_exporter | HTTP | Prometheus |
| 500 | 10.10.1.200 | 8008 | Patroni | HTTP | Prometheus |
| 500 | 10.10.1.200 | 2379 | etcd | HTTP | Prometheus |
| 501 | 10.10.1.201 | 9187 | postgres_exporter | HTTP | Prometheus |
| 501 | 10.10.1.201 | 8008 | Patroni | HTTP | Prometheus |
| 501 | 10.10.1.201 | 2379 | etcd | HTTP | Prometheus |
| 502 | 10.10.1.202 | 9187 | postgres_exporter | HTTP | Prometheus |
| 502 | 10.10.1.202 | 8008 | Patroni | HTTP | Prometheus |
| 502 | 10.10.1.202 | 2379 | etcd | HTTP | Prometheus |
| 420 | 10.10.1.120 | 9121 | redis_exporter | HTTP | Prometheus |
| 421 | 10.10.1.121 | 9121 | redis_exporter | HTTP | Prometheus |

### Cloudflare Tunnel Routes (New)

| Hostname | Target | Purpose |
|---|---|---|
| `grafana.taphuynh.dev` | `http://10.10.1.100:3000` | Grafana dashboards + Faro /collect |

---

## 7. Alerting Rules Reference

### Critical (Slack #hope-alerts-critical, repeat every 5m)

| Alert | PromQL / LogQL | Threshold | For |
|---|---|---|---|
| ServiceDown | `up == 0` | any target | 1m |
| APIErrorRateHigh | `rate(http_requests_total{status=~"5..",job="api-gateway"}[5m]) / rate(http_requests_total{job="api-gateway"}[5m])` | > 5% | 2m |
| DBReplicationLagCritical | `pg_replication_lag_seconds` | > 30s | 1m |
| DBPrimaryFailover | `changes(patroni_master[5m])` | > 0 | 0s |
| RedisOOM | `redis_memory_used_bytes / redis_memory_max_bytes` | > 95% | 1m |

### Warning (Slack #hope-alerts-warning, repeat every 30m, muted 22:00-07:00)

| Alert | PromQL / LogQL | Threshold | For |
|---|---|---|---|
| HighAPILatency | `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{job="api-gateway"}[5m]))` | > 2s | 5m |
| SMRGenerationErrors | `rate(smr_generation_errors_total[5m])` | > 0.1/s | 5m |
| DBConnectionSaturation | `pg_stat_activity_count / pg_settings_max_connections` | > 80% | 5m |
| DiskUsageHigh | `(1 - node_filesystem_avail_bytes/node_filesystem_size_bytes)` | > 80% | 10m |
| OTelCollectorDrops | `rate(otelcol_exporter_send_failed_spans_total[5m])` | > 0 | 5m |
| LokiIngestionErrors | `rate(loki_distributor_lines_received_total{status="error"}[5m])` | > 0 | 5m |

### Info (Slack #hope-alerts-info, repeat every 2h, muted weekends)

| Alert | PromQL / LogQL | Threshold | For |
|---|---|---|---|
| DBReplicationLagRising | `pg_replication_lag_seconds` | > 5s | 5m |
| RedisMemoryHigh | `redis_memory_used_bytes / redis_memory_max_bytes` | > 80% | 10m |
| ClientSDKErrorSpike | `count_over_time({app="arcaai-vox",level="error"}[5m])` | > 10 | 5m |
| CPUSustainedHigh | `rate(process_cpu_seconds_total[5m])` | > 80% | 15m |

---

## 8. Testing Checklist

### Infrastructure Verification

- [ ] All 5 Docker containers running and healthy on VM 400
- [ ] Prometheus self-scrape target UP
- [ ] OTel Collector health endpoint responds (`curl :13133`)
- [ ] Loki ready endpoint responds (`curl :3100/ready`)
- [ ] Tempo ready endpoint responds (`curl :3200/ready`)
- [ ] Grafana API health responds (`curl :3000/api/health`)
- [ ] MinIO buckets exist: `loki-chunks`, `loki-ruler`, `tempo-traces`

### Metrics Collection

- [ ] Prometheus: `api-gateway` target UP
- [ ] Prometheus: `stt` target UP
- [ ] Prometheus: `smr` target UP
- [ ] Prometheus: `nlp` target UP
- [ ] Prometheus: `postgres-exporter` (3 targets) UP
- [ ] Prometheus: `patroni` (3 targets) UP
- [ ] Prometheus: `etcd` (3 targets) UP
- [ ] Prometheus: `redis` (2 targets) UP
- [ ] Prometheus: self-monitoring targets (otel-collector, loki, tempo, grafana) UP

### Log Aggregation

- [ ] Loki receives logs from api-gateway
- [ ] Loki receives logs from stt
- [ ] Loki receives logs from smr
- [ ] Loki receives logs from nlp
- [ ] Log entries contain traceId and spanId
- [ ] Log entries contain tenantId
- [ ] Log entries contain service name

### Distributed Tracing

- [ ] Tempo receives traces from api-gateway
- [ ] Tempo receives traces from stt
- [ ] Tempo receives traces from smr
- [ ] Tempo receives traces from nlp
- [ ] Cross-service traces visible (one trace spans multiple services)
- [ ] Trace-to-log correlation works (click traceId → see logs)
- [ ] Service graph visible in Grafana (Tempo service map)

### Dashboards

- [ ] Service Health Overview shows live data
- [ ] Database Cluster dashboard shows Patroni status
- [ ] Redis Monitoring dashboard shows memory/commands
- [ ] AI Pipeline Performance dashboard shows latencies
- [ ] SMR dashboards (3 existing) display correctly
- [ ] Client SDK / RUM dashboard shows browser sessions (Phase 4)

### Alerting

- [ ] Slack contact points configured
- [ ] Notification policies route by severity
- [ ] Test: stop a service → critical alert fires in Slack within 2 minutes
- [ ] Test: restart service → resolve notification in Slack
- [ ] Mute timings configured for warning/info

### Client-Side RUM

- [ ] Faro SDK initializes in ui-playground
- [ ] Web Vitals (LCP, CLS, INP) visible in Grafana
- [ ] JS errors captured with stack traces
- [ ] Custom audio pipeline events visible
- [ ] Browser traces correlate with backend traces
- [ ] Session metadata includes tenantId

### End-to-End Trace

- [ ] Start consultation in browser
- [ ] Speak into microphone
- [ ] Find browser trace in Tempo
- [ ] Trace shows: browser → API Gateway → STT
- [ ] Each span links to corresponding logs in Loki

---

## 9. Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-04-02 | Initial design document created | This file |
