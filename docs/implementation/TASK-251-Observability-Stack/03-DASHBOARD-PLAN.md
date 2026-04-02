# Phase 3: Dashboards and Alerting Plan

| Field | Value |
|-------|-------|
| **Phase** | 3 — Dashboards and Alerting |
| **Effort** | ~1 day |
| **Prerequisites** | Phase 2 complete — all Prometheus targets UP, Loki has logs, Tempo has traces |

---

## Table of Contents

1. [Import Existing Dashboards](#1-import-existing-dashboards)
2. [Dashboard 1: Service Health Overview](#2-dashboard-1-service-health-overview)
3. [Dashboard 2: Database Cluster](#3-dashboard-2-database-cluster)
4. [Dashboard 3: Redis Monitoring](#4-dashboard-3-redis-monitoring)
5. [Dashboard 4: AI Pipeline Performance](#5-dashboard-4-ai-pipeline-performance)
6. [Dashboard 5: Client SDK / RUM](#6-dashboard-5-client-sdk--rum)
7. [Alerting Configuration](#7-alerting-configuration)
8. [Verification](#8-verification)

---

## 1. Import Existing Dashboards

Three SMR dashboards already exist as JSON files in the repository.

### Step 1.1 — Copy Dashboard JSONs to VM 400

```bash
# From your local machine or the repo
scp infrastructure/grafana/dashboards/smr-v2-overview.json \
    hope@10.10.1.100:/opt/observability/configs/grafana/dashboards/
scp infrastructure/grafana/dashboards/smr-v2-resilience.json \
    hope@10.10.1.100:/opt/observability/configs/grafana/dashboards/
scp infrastructure/grafana/dashboards/smr-v2-security.json \
    hope@10.10.1.100:/opt/observability/configs/grafana/dashboards/
```

Grafana auto-discovers new JSON files (configured with `updateIntervalSeconds: 30`). No restart needed.

### Step 1.2 — Verify

Open Grafana → Dashboards → HOPE folder. Three SMR dashboards should appear:
- SMR V2 Overview
- SMR V2 Resilience
- SMR V2 Security

---

## 2. Dashboard 1: Service Health Overview

**Purpose**: Single most important dashboard — at-a-glance health of all services.

### Layout

```
┌──────────────────────────────────────────────────────────┐
│  HOPE Service Health Overview                    [15m ▼] │
├──────────────────────────────────────────────────────────┤
│ Row 1: Status Indicators                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ API  ✓   │ │ STT  ✓   │ │ SMR  ✓   │ │ NLP  ✓   │   │
│  │ 234 r/m  │ │ 56 r/m   │ │ 89 r/m   │ │ 45 r/m   │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │
│                                                          │
│  ┌──────────┐ ┌──────────┐                              │
│  │ DB  ✓    │ │Redis ✓   │                              │
│  │ lag: 0ms │ │ mem: 45% │                              │
│  └──────────┘ └──────────┘                              │
│                                                          │
│ Row 2: Request Rate (time series)                        │
│ Row 3: Error Rate (time series)                          │
│ Row 4: P95 Latency (time series)                         │
│ Row 5: Recent Errors (Loki logs panel)                   │
└──────────────────────────────────────────────────────────┘
```

### Panels

| Row | Panel | Datasource | Query | Visualization |
|-----|-------|-----------|-------|---------------|
| 1 | API Status | Prometheus | `up{job="api-gateway"}` | Stat (value mapping: 1=green "UP", 0=red "DOWN") |
| 1 | STT Status | Prometheus | `up{job="stt-v2"}` | Stat |
| 1 | SMR Status | Prometheus | `up{job="smr"}` | Stat |
| 1 | NLP Status | Prometheus | `up{job="nlp"}` | Stat |
| 1 | DB Status | Prometheus | `min(up{job="postgres-exporter"})` | Stat |
| 1 | Redis Status | Prometheus | `min(up{job="redis"})` | Stat |
| 2 | Request Rate | Prometheus | `sum(rate(http_requests_total[5m])) by (job)` | Time series, legend: `{{job}}` |
| 3 | Error Rate | Prometheus | `sum(rate(http_requests_total{status=~"5.."}[5m])) by (job) / sum(rate(http_requests_total[5m])) by (job) * 100` | Time series (%), thresholds: >1% yellow, >5% red |
| 4 | P95 Latency | Prometheus | `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, job))` | Time series (seconds), thresholds: >1s yellow, >2s red |
| 4 | P50 Latency | Prometheus | `histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, job))` | Time series |
| 5 | Recent Errors | Loki | `{level="error"} \| json` | Logs panel, limit 20 |

### Variables

| Name | Type | Query |
|------|------|-------|
| `$timeRange` | Built-in | Time picker (default: 15m) |

### Build Instructions

1. Open Grafana → Dashboards → New Dashboard
2. Add each panel in order, copying the query from the table above
3. Set the Stat panels to use "Value Mappings": `1` → "UP" (green), `0` → "DOWN" (red)
4. Save to the "HOPE" folder
5. Export as JSON → save to `/opt/observability/configs/grafana/dashboards/service-health-overview.json`

---

## 3. Dashboard 2: Database Cluster

**Purpose**: TimescaleDB HA cluster health — Patroni, replication, connections.

### Panels

| Panel | Datasource | Query | Visualization |
|-------|-----------|-------|---------------|
| Patroni Leader | Prometheus | `patroni_master` by instance | Stat (1=Primary, 0=Replica) |
| Replication Lag | Prometheus | `pg_replication_lag_seconds` | Time series (seconds), thresholds: >5s yellow, >30s red |
| Active Connections | Prometheus | `pg_stat_activity_count{datname!=""}` | Time series by instance |
| Connection Saturation | Prometheus | `pg_stat_activity_count / on(instance) pg_settings_max_connections * 100` | Gauge (%), thresholds: >60% yellow, >80% red |
| Transactions/sec | Prometheus | `rate(pg_stat_database_xact_commit{datname!=""}[5m])` | Time series |
| Cache Hit Ratio | Prometheus | `pg_stat_database_blks_hit / (pg_stat_database_blks_hit + pg_stat_database_blks_read) * 100` | Gauge (%), thresholds: <95% yellow, <90% red |
| Dead Tuples | Prometheus | `pg_stat_user_tables_n_dead_tup` by relname | Table (top 10) |
| Database Size | Prometheus | `pg_database_size_bytes` | Bar gauge (bytes) |
| etcd Leader | Prometheus | `etcd_server_is_leader` by instance | Stat |
| etcd Peer Latency | Prometheus | `histogram_quantile(0.99, rate(etcd_network_peer_round_trip_time_seconds_bucket[5m]))` | Time series |

### Variables

| Name | Type | Query |
|------|------|-------|
| `$instance` | Custom | `10.10.1.200:9187, 10.10.1.201:9187, 10.10.1.202:9187` |

---

## 4. Dashboard 3: Redis Monitoring

**Purpose**: Redis cluster health — memory, commands, clients.

### Panels

| Panel | Datasource | Query | Visualization |
|-------|-----------|-------|---------------|
| Memory Usage | Prometheus | `redis_memory_used_bytes / redis_memory_max_bytes * 100` | Gauge (%), thresholds: >80% yellow, >95% red |
| Memory Used (bytes) | Prometheus | `redis_memory_used_bytes` by instance | Time series |
| Connected Clients | Prometheus | `redis_connected_clients` | Time series |
| Commands/sec | Prometheus | `rate(redis_commands_processed_total[5m])` | Time series |
| Keyspace | Prometheus | `redis_db_keys` by db | Bar gauge |
| Hit Ratio | Prometheus | `irate(redis_keyspace_hits_total[5m]) / (irate(redis_keyspace_hits_total[5m]) + irate(redis_keyspace_misses_total[5m])) * 100` | Gauge (%) |
| Evictions | Prometheus | `rate(redis_evicted_keys_total[5m])` | Time series, thresholds: >0 red |
| Blocked Clients | Prometheus | `redis_blocked_clients` | Stat |
| Network I/O | Prometheus | `rate(redis_net_input_bytes_total[5m])`, `rate(redis_net_output_bytes_total[5m])` | Time series (bytes/sec) |

---

## 5. Dashboard 4: AI Pipeline Performance

**Purpose**: ML service performance — latency, throughput, GPU health.

### Panels

| Panel | Datasource | Query | Visualization |
|-------|-----------|-------|---------------|
| STT P95 Latency | Prometheus | `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{job="stt-v2"}[5m]))` | Time series |
| SMR Token Throughput | Prometheus | `rate(smr_v2_tokens_total[5m])` | Time series |
| SMR Time to First Token | Prometheus | `histogram_quantile(0.95, rate(smr_v2_time_to_first_token_seconds_bucket[5m]))` | Time series |
| NLP Classification Time | Prometheus | `histogram_quantile(0.95, rate(nlp_http_request_duration_seconds_bucket[5m]))` | Time series |
| SMR Active Generations | Prometheus | `smr_v2_active_generations` | Gauge |
| SMR Circuit Breaker State | Prometheus | `smr_v2_circuit_breaker_state` by provider | Stat (mapping: 0=Closed/green, 1=Open/red, 2=Half-open/yellow) |
| SMR Queue Depth | Prometheus | `smr_v2_queue_size` | Time series |
| SMR Generation Errors | Prometheus | `rate(smr_v2_generation_errors_total[5m])` by error_type | Time series |
| SMR Provider Health | Prometheus | `smr_v2_provider_health` by provider | Stat (1=healthy, 0=unhealthy) |
| SMR Rate Limit Rejections | Prometheus | `rate(smr_v2_rate_limit_rejections_total[5m])` | Time series |
| SMR Queue Wait Time | Prometheus | `histogram_quantile(0.95, rate(smr_v2_queue_wait_seconds_bucket[5m]))` | Time series |
| SMR Concurrent Requests | Prometheus | `smr_v2_concurrent_requests` by provider | Time series |

---

## 6. Dashboard 5: Client SDK / RUM

**Purpose**: Browser-side performance and user experience from Grafana Faro.
**Prerequisites**: Phase 4 (Faro integration) complete.

### Panels

| Panel | Datasource | Query | Visualization |
|-------|-----------|-------|---------------|
| Active Sessions | Loki | `count(count_over_time({app="arcaai-vox"} \| json [15m]) by (sessionId))` | Stat |
| Web Vitals — LCP | Loki | `{app="arcaai-vox"} \| json \| type="web-vital" \| name="LCP"` | Histogram / Time series |
| Web Vitals — CLS | Loki | `{app="arcaai-vox"} \| json \| type="web-vital" \| name="CLS"` | Histogram |
| Web Vitals — INP | Loki | `{app="arcaai-vox"} \| json \| type="web-vital" \| name="INP"` | Histogram |
| JS Error Rate | Loki | `count_over_time({app="arcaai-vox", level="error"}[5m])` | Time series |
| Top JS Errors | Loki | `{app="arcaai-vox", level="error"} \| json \| line_format "{{.message}}"` | Logs panel, grouped by message |
| Audio Pipeline Events | Loki | `count_over_time({app="arcaai-vox"} \| json \| name=~"audio\\..*"[5m])` by name | Bar chart |
| STT Transcript Latency | Loki | `{app="arcaai-vox"} \| json \| name="stt.transcript.received" \| unwrap latencyMs` | Histogram |
| WebSocket Stability | Loki | `count_over_time({app="arcaai-vox"} \| json \| name=~"ws\\..*"[5m])` by name | Time series |
| Browser Traces | Tempo | Search by `service.name=arcaai-vox` | Trace list |

---

## 7. Alerting Configuration

### Step 7.1 — Create Slack Contact Points

In Grafana UI → Alerting → Contact Points:

| Contact Point | Type | Channel | Purpose |
|--------------|------|---------|---------|
| Slack Critical | Slack webhook | `#hope-alerts-critical` | Immediate page |
| Slack Warning | Slack webhook | `#hope-alerts-warning` | Business hours |
| Slack Info | Slack webhook | `#hope-alerts-info` | Low priority |

For each, set:
- **Webhook URL**: `https://hooks.slack.com/services/T.../B.../...`
- **Title**: `{{ .CommonLabels.alertname }}`
- **Text**: `{{ range .Alerts }}{{ .Annotations.summary }}{{ end }}`

### Step 7.2 — Create Notification Policies

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

### Step 7.3 — Create Mute Timings

| Name | Schedule |
|------|----------|
| nighttime | Weekdays 22:00-07:00 |
| weekends | Saturday 00:00 - Monday 07:00 |

### Step 7.4 — Create Alert Rules

#### Critical Alerts (Folder: HOPE Critical)

| Rule | Expression | For | Severity |
|------|-----------|-----|----------|
| ServiceDown | `up == 0` | 1m | critical |
| APIErrorRateHigh | `rate(http_requests_total{status=~"5..",job="api-gateway"}[5m]) / rate(http_requests_total{job="api-gateway"}[5m]) > 0.05` | 2m | critical |
| DBReplicationLagCritical | `pg_replication_lag_seconds > 30` | 1m | critical |
| DBPrimaryFailover | `changes(patroni_master[5m]) > 0` | 0s | critical |
| RedisOOM | `redis_memory_used_bytes / redis_memory_max_bytes > 0.95` | 1m | critical |

For each rule, set:
- **Annotations**: `summary` = human-readable description
- **Labels**: `severity` = `critical`

#### Warning Alerts (Folder: HOPE Warning)

| Rule | Expression | For | Severity |
|------|-----------|-----|----------|
| HighAPILatency | `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{job="api-gateway"}[5m])) > 2` | 5m | warning |
| SMRGenerationErrors | `rate(smr_v2_generation_errors_total[5m]) > 0.1` | 5m | warning |
| DBConnectionSaturation | `pg_stat_activity_count / pg_settings_max_connections > 0.8` | 5m | warning |
| DiskUsageHigh | `(1 - node_filesystem_avail_bytes / node_filesystem_size_bytes) > 0.8` | 10m | warning |
| OTelCollectorDrops | `rate(otelcol_exporter_send_failed_spans_total[5m]) > 0` | 5m | warning |
| LokiIngestionErrors | `rate(loki_distributor_lines_received_total{status="error"}[5m]) > 0` | 5m | warning |

#### Info Alerts (Folder: HOPE Info)

| Rule | Expression | For | Severity |
|------|-----------|-----|----------|
| DBReplicationLagRising | `pg_replication_lag_seconds > 5` | 5m | info |
| RedisMemoryHigh | `redis_memory_used_bytes / redis_memory_max_bytes > 0.8` | 10m | info |
| ClientSDKErrorSpike | Loki: `count_over_time({app="arcaai-vox",level="error"}[5m]) > 10` | 5m | info |
| CPUSustainedHigh | `rate(process_cpu_seconds_total[5m]) > 0.8` | 15m | info |

---

## 8. Verification

### Dashboard Verification

| Dashboard | Check | Expected |
|-----------|-------|----------|
| Service Health Overview | All 6 status indicators | Green "UP" |
| Service Health Overview | Request Rate graph | Non-zero for active services |
| Service Health Overview | Recent Errors panel | Shows log lines (or empty if no errors) |
| Database Cluster | Patroni Leader | Exactly 1 node shows "Primary" |
| Database Cluster | Replication Lag | < 1s |
| Redis Monitoring | Memory Usage | Non-zero percentage |
| AI Pipeline Performance | SMR Circuit Breaker | Shows "Closed" (green) for active providers |
| Client SDK / RUM | Active Sessions | Shows count when browser is connected |
| SMR Overview | Existing dashboard | Renders with live data |
| SMR Resilience | Existing dashboard | Renders with live data |
| SMR Security | Existing dashboard | Renders with live data |

### Alerting Verification

| Test | Steps | Expected |
|------|-------|----------|
| Critical alert fires | Stop a service on VM 200 | Slack #hope-alerts-critical receives alert within 2 min |
| Critical alert resolves | Restart the service | Slack receives resolve notification |
| Warning alert fires | Generate sustained 5xx errors | Slack #hope-alerts-warning receives alert within 7 min |
| Mute timing works | Set clock to 23:00 → trigger warning | No Slack notification |
| Info alert | Raise Redis memory usage | Slack #hope-alerts-info receives alert |

### Alert Testing Commands

```bash
# Test: Stop api-gateway to trigger ServiceDown
ssh hope@10.10.1.10
kubectl scale deployment api-gateway --replicas=0 -n <namespace>
# Wait 2 minutes → check Slack #hope-alerts-critical
# Restore:
kubectl scale deployment api-gateway --replicas=1 -n <namespace>
# Wait 1 minute → check Slack for resolve notification
```

---

## Dashboard Export Workflow

After building each dashboard in the Grafana UI:

1. Click the share button → Export → Save to file
2. Copy the JSON to the repo:
   ```bash
   scp hope@10.10.1.100:/tmp/<dashboard>.json \
     docs/implementation/TASK-251-Observability-Stack/configs/grafana/dashboards/
   ```
3. The provisioning config auto-loads dashboards from `/var/lib/grafana/dashboards/`

---

## Completion Checklist

- [ ] 3 existing SMR dashboards imported and displaying data
- [ ] Service Health Overview dashboard built with all panels
- [ ] Database Cluster dashboard built with Patroni/replication panels
- [ ] Redis Monitoring dashboard built
- [ ] AI Pipeline Performance dashboard built with SMR custom metrics
- [ ] Client SDK / RUM dashboard built (after Phase 4)
- [ ] 3 Slack contact points configured
- [ ] Notification policies created (critical/warning/info routing)
- [ ] Mute timings configured (nighttime, weekends)
- [ ] 5 critical alert rules created and tested
- [ ] 6 warning alert rules created
- [ ] 4 info alert rules created
- [ ] Test: service down → Slack alert → restart → Slack resolve
- [ ] Cloudflare Tunnel route verified: grafana.taphuynh.dev loads
- [ ] All dashboard JSONs exported to repo
