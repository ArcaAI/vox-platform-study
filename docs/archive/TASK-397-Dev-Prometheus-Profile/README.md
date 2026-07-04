# TASK-397 — Dev Prometheus (+Grafana) Opt-in Profile

| Field | Value |
|---|---|
| **Ticket** | TASK-397 |
| **Name** | Dev Prometheus (+Grafana) opt-in docker profile (backlog **P1-2**) |
| **Type** | `infrastructure` (docker compose + observability config) |
| **Status** | **Completed** |
| **Created** | 2026-07-02 |
| **Updated** | 2026-07-02 |
| **Owner** | Infrastructure |
| **Builds on / references** | **TASK-386** (Platform Runtime Metrics Backend) — this profile is what makes the TASK-386 read-API return real values; **TASK-251** (prod Observability Stack) — provisioning format mirrored |

> **Ticket-number check (per `00-project-context.mdc`):** the brief assumed `TASK-386–396` exist and asked for `TASK-397`. Actual highest on disk is **TASK-395** (`docs/implementation/TASK-390`…`395`; no `396`, no `397`). Per the explicit instruction the ticket was created as **TASK-397** with the exact folder/path given. **`TASK-396` is currently unused** — flagged so the numbering gap is intentional and visible.

---

## 1. Requirement Analysis

### 1.1 Description

Backlog **P1-2**: provide an **opt-in dev Prometheus (+Grafana)** docker profile so the **TASK-386** platform-metric **values** (per-service P95, requests/min, per-model running instances + inference latency) render in the Admin Console instead of em-dashing.

TASK-386 built the entire TypeScript read path (`PrometheusQueryService` → `GET /admin/platform/metrics` etc.) behind `PROMETHEUS_URL`, with **graceful degradation to em-dash when Prometheus is absent** (decision #1). The missing piece for a developer is a running Prometheus (scraping the services) plus a way to eyeball the series. This ticket delivers that as an **infra/config-only** change.

### 1.2 Scope (infra/config ONLY)

- Put Prometheus **and add Grafana** under an opt-in **`prometheus`** compose profile in `docker-compose.dev.yml`, scraping the four Python services + the API `/metrics`.
- Complete `configs/prometheus/prometheus.yml` scrape jobs for all four Python services + API.
- Add Grafana provisioning under `infrastructure/docker/configs/grafana/`: a Prometheus datasource + a starter platform dashboard (running instances, inference latency P95, request rates).
- Confirm `PROMETHEUS_URL` targets the compose Prometheus.

**Explicitly out of scope / untouched:** `apps/**`, `packages/**`, `docs/qa/**`, the shared `:8868` admin test stack, and the shared test `postgres/redis/minio` containers.

### 1.3 Acceptance criteria

1. `docker compose -f infrastructure/docker/docker-compose.dev.yml --profile prometheus config` validates.
2. Bringing up **only** the profile services starts Prometheus + Grafana without touching any other container.
3. Prometheus `/targets` (`:9090`) shows all configured jobs (UP for whatever is running; Python jobs may be DOWN until those services run — documented).
4. Grafana (`:3001`) has a healthy Prometheus datasource and the starter dashboard provisioned.
5. Value-flow documented: with this profile + the Python services up, the TASK-386 API tiles get real values. Verification does **not** require `:8868`.

---

## 2. Current State Evaluation (what already existed — extend, don't duplicate)

| Item | State before TASK-397 | Action taken |
|---|---|---|
| `prometheus` service in `docker-compose.dev.yml` | **Existed** (TASK-386), gated behind the **`observability`** profile; `prom/prometheus:v3.1.0`; `extra_hosts host.docker.internal`; TSDB volume; no healthcheck | **Extended:** added the **`prometheus`** profile alias (kept `observability`), added a healthcheck. No duplicate service. |
| `configs/prometheus/prometheus.yml` | **Complete already** (TASK-386): jobs `prometheus`(self), `api-gateway`, `stt`, `smr`, `guardrail`, `nlp`, `harness` — all 4 Python services + API + harness, via `host.docker.internal` | **No change** — confirmed complete; nothing to add. |
| `PROMETHEUS_URL` / `PROMETHEUS_PORT` in `.env.dev` | `PROMETHEUS_URL=http://localhost:9090`, `PROMETHEUS_PORT=9090` (already targets the compose Prometheus) | **Confirmed correct;** refreshed only the block comment to name the new `prometheus` profile. |
| Grafana in dev compose | **Missing** | **Added** (service + provisioning + starter dashboard). |
| Python metric surface | `model_running_instances` (gauge) + `model_inference_latency_seconds` (histogram), `{service, model}` labels, emitted by stt/smr/nlp/guardrail (TASK-386 `METRIC-CONTRACT.md` §3) | Consumed by the dashboard PromQL; no change. |

**Design note (profile naming):** the brief asked for a **`prometheus`** profile; TASK-386 shipped **`observability`** (referenced in its `README.md` + `METRIC-CONTRACT.md`). To satisfy the new requirement **without breaking those docs** and **without duplicating the service**, both services now carry `profiles: ["observability", "prometheus"]`. `--profile prometheus` is the canonical TASK-397 opt-in; `--profile observability` still works as an alias.

---

## 3. Implementation Summary

### 3.1 Files changed / added (all under owned paths)

**`infrastructure/docker/docker-compose.dev.yml`** (edited)
- `prometheus` service: `profiles: ["observability", "prometheus"]` (added the alias); added a `healthcheck` (`wget --spider /-/healthy`) so Grafana can wait for it; refreshed the comment block.
- **New `grafana` service** (`grafana/grafana:12.4.2`, container `hope-grafana`): same `profiles: ["observability", "prometheus"]`; `depends_on: prometheus (service_healthy)`; port `${GRAFANA_PORT:-3001}:3000`; mounts `./configs/grafana/provisioning` (ro) + `./configs/grafana/dashboards` (ro) + `grafana-data` volume; dev defaults `admin/admin`; anonymous **Viewer** enabled for no-login dashboard viewing; analytics/update-checks off.
- **New named volume** `grafana-data` (runtime UI state only; provisioning is read-only bind-mounts).

**`infrastructure/docker/configs/grafana/`** (new)
- `provisioning/datasources/datasource.yml` — single **Prometheus** datasource, `uid: hope-prometheus`, `url: http://prometheus:9090` (in-network service name), `isDefault: true`.
- `provisioning/dashboards/dashboards.yml` — file provider → `/var/lib/grafana/dashboards`, folder `HOPE`, 30s refresh.
- `dashboards/hope-platform-metrics.json` — **starter dashboard** "HOPE Platform Metrics (dev)" (`uid: hope-platform-metrics`), 7 panels bound to `hope-prometheus`, PromQL copied from `METRIC-CONTRACT.md`:
  1. **Running model instances (total)** — `sum(model_running_instances)` (stat)
  2. **Scrape targets UP (by job)** — `up` (mirrors `/targets`)
  3. **Running instances per model** — `sum by (service, model) (model_running_instances)` (table)
  4. **Inference latency p95 per model (s)** — `histogram_quantile(0.95, sum by (le, service, model) (rate(model_inference_latency_seconds_bucket[5m])))`
  5. **Inference latency avg per model (s)** — `rate(_sum)/rate(_count)` over 5m
  6. **HTTP request rate (req/s by job)** — `sum by (job) (rate(http_requests_total[5m]))`
  7. **API per-service request p95 (s)** — `histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))`

**`.env.dev`** (prometheus block comment only)
- `PROMETHEUS_URL` / `PROMETHEUS_PORT` unchanged (already correct). Comment updated to name the `--profile prometheus` opt-in (and note the `observability` alias).

### 3.2 How to run

```bash
# Opt-in: brings up Prometheus + Grafana only (name the services so the
# always-on qdrant/qdrant-init and everything else are left alone).
docker compose -f infrastructure/docker/docker-compose.dev.yml \
               --profile prometheus up -d prometheus grafana

# Prometheus UI: http://localhost:9090        (/targets for scrape health)
# Grafana UI:    http://localhost:3001        (dashboard: HOPE / "HOPE Platform Metrics (dev)")
```

### 3.3 Value-flow (why this un-em-dashes the TASK-386 tiles)

```
Python services (stt/smr/nlp/guardrail) on the HOST  ──emit──▶  /metrics
        model_running_instances, model_inference_latency_seconds, http_*
                              │  (scraped via host.docker.internal)
                              ▼
   Prometheus (compose, :9090, profile=prometheus)  ── stores TSDB
                              │  PromQL (METRIC-CONTRACT.md)
              ┌───────────────┴───────────────┐
              ▼                                ▼
  NestJS PrometheusQueryService        Grafana (:3001) starter dashboard
  (PROMETHEUS_URL=:9090, TASK-386)     (datasource hope-prometheus)
              │
              ▼
  GET /admin/platform/metrics  →  Admin Console tiles render REAL
  (P95, req/min, per-model running + latency)  instead of em-dash
```

- Prometheus is the **only** dependency the TASK-386 read path needs at `PROMETHEUS_URL`. With this profile up **and** the Python services running, the DOWN targets flip UP, `model_*` series populate, and the API tiles get real values.
- With Prometheus **absent**, TASK-386 degrades to em-dash by design — so this profile is the switch between "em-dash" and "real values".
- **No `:8868` required for this verification.** The API-gateway `/metrics` is scraped only if it happens to be up; scraping is a passive read-only HTTP GET and never starts/stops/restarts that stack.

---

## 4. Verification Evidence (2026-07-02)

**AC1 — config validates** (dev.yml only, `prometheus` profile):
```
$ docker compose -f infrastructure/docker/docker-compose.dev.yml --profile prometheus config
exit=0   (no warnings)
# services active in profile: grafana, prometheus, qdrant, qdrant-init
#   (qdrant/qdrant-init are always-on — no `profiles:` key — so they list here
#    but are NOT started because `up` names only prometheus+grafana)
```

**AC2 — up only the profile services** (`up -d prometheus grafana`):
```
Container hope-prometheus  Started → Healthy
Container hope-grafana     Started (waited for prometheus healthy)
Volumes created: hope-infra-dev_prometheus-data, hope-infra-dev_grafana-data
# "Found orphan containers ([hope-minio hope-postgres hope-redis ...])" warning
#   is EXPECTED — NOT passed --remove-orphans, so they are untouched.
```
Container check afterward — only the two new containers are recent; everything else keeps 9–10h uptime (untouched):
```
hope-grafana         Up ~1 minute (healthy)
hope-prometheus      Up 2 minutes (healthy)
hope-postgres        Up 10 hours (healthy)     hope-postgres-test   Up 9 hours (healthy)
hope-redis           Up 10 hours (healthy)     hope-redis-test      Up 9 hours (healthy)
hope-minio           Up 10 hours (healthy)     hope-minio-test      Up 9 hours (healthy)
hope-qdrant/-test, hope-temporal(-ui), hope-vault … all 9–10h (unchanged)
```

**AC3 — Prometheus `/targets`** (`GET :9090/api/v1/targets`) — all 7 configured jobs present:
```
JOB          HEALTH   INSTANCE                     NOTE
api-gateway  up       host.docker.internal:8868    live (host-run API; read-only scrape)
prometheus   up       localhost:9090               self
stt          down     host.docker.internal:8861    dial tcp — service not running on host
smr          down     host.docker.internal:8862    dial tcp — service not running on host
nlp          down     host.docker.internal:8864    dial tcp — service not running on host
guardrail    down     host.docker.internal:8863    dial tcp — service not running on host
harness      down     host.docker.internal:8866    dial tcp — service not running on host
```
> **DOWN targets that need services running to go UP:** `stt`, `smr`, `nlp`, `guardrail`, `harness`. Start them on the host (conda/pnpm) and Prometheus flips them UP on the next 15s scrape. `stt/smr/nlp/guardrail` are the ones that carry `model_running_instances` + `model_inference_latency_seconds` (the per-model tiles); `harness` emits `http_*` only (no models, by design — contract §8).

Instant queries proving the plumbing:
```
up                                        → 7 series (api-gateway=1, prometheus=1, stt/smr/nlp/guardrail/harness=0)
model_running_instances                   → 0 series  (empty until the Python services run — the em-dash state)
count(http_requests_total{job="api-gateway"}) → 0      (request-driven counter; absent until traffic flows through the API)
```

**AC4 — Grafana** (`:3001`):
```
GET /api/health                          → {"database":"ok","version":"12.4.2"}
GET /api/datasources                     → name=Prometheus uid=hope-prometheus type=prometheus url=http://prometheus:9090 isDefault=true
GET /api/datasources/uid/hope-prometheus/health
                                         → {"status":"OK","message":"Successfully queried the Prometheus API."}
GET /api/search?tag=hope                 → "HOPE Platform Metrics (dev)" uid=hope-platform-metrics folder="HOPE"
GET /api/dashboards/uid/hope-platform-metrics → 7 panels present (stat/timeseries/table as designed)
```

**Lint:** `ReadLints` on the compose file + all new Grafana config/JSON → no errors. Dashboard JSON validated with `json.load`.

---

## 5. Notes & Follow-ups

- **`http_requests_total` for `api-gateway` is empty until traffic flows** (prom-client creates the series lazily on first request). Panel 6/7 populate once the API serves requests. Not a defect and out of scope (owned by `apps/**`).
- **NLP HTTP metrics are `nlp_http_*`-namespaced** and **guardrail emits no `http_*`** (contract §6/§7/§10). Panel 6 (`http_requests_total` by job) therefore won't show NLP/guardrail HTTP rate — by design; per-model coverage for those comes from the `model_*` panels.
- **Multiple profiles are intentional.** If a future cleanup wants a single name, standardize on `prometheus` and update TASK-386's `README.md` + `METRIC-CONTRACT.md` references from `observability` (owned by that ticket — not changed here).
- `GRAFANA_PORT` defaults to `3001` (host port), aligned post-review with `09-infrastructure.mdc`'s port table; the container port stays `3000`. Override with `GRAFANA_PORT` if needed. (Initial verification ran on `:3000` before the alignment; re-verified on `:3001`.)

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-02 | Initial implementation. Added `prometheus` profile alias + healthcheck to the existing Prometheus service; added Grafana service + `grafana-data` volume; added Grafana provisioning (Prometheus datasource + dashboards provider + starter "HOPE Platform Metrics (dev)" dashboard); refreshed `.env.dev` prometheus block comment. Confirmed `prometheus.yml` already complete (no change). Verified: `config` valid, `up` starts only prometheus+grafana (shared stack untouched), `/targets` shows all 7 jobs (api-gateway+prometheus UP, 5 host services DOWN pending start), Grafana datasource health OK + dashboard provisioned. | `infrastructure/docker/docker-compose.dev.yml`; `infrastructure/docker/configs/grafana/**` (3 new files); `.env.dev` (prometheus block comment); this README |
