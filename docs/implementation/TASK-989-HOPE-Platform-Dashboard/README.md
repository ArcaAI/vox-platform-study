# TASK-989 — HOPE Platform Dashboard (Application Plane) + Observability Hardening

| | |
|---|---|
| **Status** | Review — committed on a branch in `arca/hope-v2-deployment`, **not yet merged to `main`** |
| **Type** | infrastructure |
| **Date** | 2026-09-18 |
| **Primary repo** | `arca/hope-v2-deployment` (branch `task-989-platform-dashboard`) |
| **This repo** | documentation only — no application code changed |

---

## 1. Requirement Analysis

Build a Grafana dashboard for monitoring the HOPE platform, commit it to the
deployment repo, and apply observability best practices.

Scope decided with the owner on 2026-09-18:

- **One combined board** (`hope-platform`) with collapsible rows per domain,
  rather than three domain boards.
- Plus four hardening items: a CI gate for dashboard JSON, locking Grafana
  provisioning to Git, fixing stale panel descriptions, and Alertmanager rules
  for the new signals.

## 2. Current State Evaluation

### 2.1 What triggered it

A question — *"the Grafana dashboard shows nearly 1000 connections, what exactly
is it?"* — resolved to `node_sockstat_sockets_used` on **HOPE — Node & System
Activity**: the kernel's count of socket OBJECTS of every type on the single k3s
node, including UNIX-domain and netlink sockets held by kubelet and containerd.
It idles at 935–947 and had been flat for seven days. The actual live TCP
connection count was 73, and HOPE's own gateway connection count was 0.

The panel was not wrong. It was the only thing there was to read.

### 2.2 The measured gap

| | Before |
|---|---|
| Dashboards | 5 — all infrastructure (nodes, GPU, workloads, data-tier) |
| Panels | 67 — **zero** showing a HOPE service |
| Alert rules | 45 in 13 groups — **zero** able to fire on a product failure |

Meanwhile the application metrics were already scraped and unused:

| Job | Series | Examples going unrendered |
|---|---|---|
| `api-gateway` | 3 590 | `hope_api_http_requests_total{method,path,status}`, `hope_api_active_connections_count`, event-loop lag p50/p90/p99, `hope_job_*` |
| `text` | 455 | `text_time_to_first_token_seconds`, `text_tokens_per_second`, `text_provider_health`, `text_circuit_breaker_state` |
| `guardrail` | 320 | `guardrail_screening_decisions_total`, `guardrail_queue_depth`, `guardrail_circuit_breaker_state` |
| `stt` | 312 | `stt_streaming_sessions_{active,total}`, `stt_streaming_rtf`, queue-dropped, script-mismatch |
| `nlp` | 255 | `nlp_entities_total`, `nlp_inference_queue_{depth,wait_seconds}` |
| `harness` | 215 | `harness_regen_total` + generic FastAPI `http_*` only |
| `tts` | 121 | generic FastAPI `http_*` only |
| `stt-worker` | **5** | **`up` and `scrape_*` only — no app metrics exist to scrape** |

Note `hope_api_active_connections_count`: the gateway's own connection gauge
existed the whole time and had never been plotted.

### 2.3 Secondary findings

Found while validating, all confirmed against live data:

1. **`NodeFileDescriptorsExhausting` could never fire.** Its expression was
   `node_filefd_allocated / node_filefd_maximum > 0.8`, but `node_filefd_maximum`
   reports LONG_MAX (~9.2e18) on this host because k3s leaves `fs.file-max`
   effectively unlimited. At 53 440 allocated the ratio is ~6e-15. A dead alert
   is worse than no alert: it reads as coverage.
2. **Two stale panel descriptions** on `hope-node-system` — one credits
   PgBouncer/Redis pooling for keeping the socket line flat (there is no pooler
   on this deployment since TASK-847), one describes an unreachable fd ceiling.
3. **`allowUiUpdates: true`** on the dashboard provider let a UI edit persist and
   diverge from Git — the only artefact in the cluster with a non-Git write path.
4. **No CI gate** validated dashboard JSON, among eight otherwise-blocking gates.
5. **`text_generation_total`** shows 49 failed against 70 completed for
   `gemma-4-e2b-it-qat`, and one failure against a "model" named
   `s3://hope-models/gemma-4-e2b-it-qat-gguf/q4-0-451faffb5a16` — a bucket path
   leaking into a model id. **Not addressed here** (application-side).
6. **`hope_job_processing_total{status="failed"} = 15`** on `GenerateDnaReport`,
   split 9× `ServiceUnavailableException` / 6× `PrismaClientValidationError`.
   Consistent with the known TASK-974 note that the dev DB still needs a
   `RUN_SEED=all` reseed. **Not addressed here.**

## 3. Implementation Plan

| # | Change | Repo |
|---|---|---|
| 1 | `scripts/check-dashboards.py` — validation gate | deployment |
| 2 | `base/dashboards/platform.json` — the board (uid `hope-platform`) | deployment |
| 3 | `base/kustomization.yaml` — register in `grafana-dashboards` | deployment |
| 4 | `base/observability-config.yaml` — `allowUiUpdates/editable: false` | deployment |
| 5 | `base/dashboards/node-system-activity.json` — 2 descriptions | deployment |
| 6 | `base/alert-rules.yaml` — 4 app-plane groups; fix dead fd alert | deployment |
| 7 | `.gitlab-ci.yml` — blocking `dashboards` job | deployment |
| 8 | `docs/observability-dashboards.md` — §2.6, §3, §4.2 | deployment |
| 9 | this README | hope-v2 |

## 4. Implementation Summary

### 4.1 The board — `hope-platform`

**HOPE — Platform (Application Plane)**, 32 query panels: a 6-tile header strip
plus four collapsible rows (API Gateway, Realtime STT, AI Services, Jobs &
Queues). Prometheus throughout, with three Loki panels for WebSocket session
lifecycle, which exists only in gateway logs.

The header strip's **"Open gateway connections"** tile carries a description
naming `node_sockstat_sockets_used` explicitly and explaining why the two are not
comparable. That is the ticket's origin encoded where it will be read.

Design choices worth recording:

- **RED for services, USE for resources.** Gateway panels are rate/errors/
  duration; saturation panels (event-loop lag, queue depth, queue wait) are
  separate and labelled as saturation.
- **`$__rate_interval`, never a hardcoded range** — the five legacy boards
  hardcode `[5m]` and silently under-sample past a few hours' zoom.
- **4xx excluded from the gateway error ratio.** The 404-over-403 tenancy posture
  makes 404 a correct answer on any cross-tenant read; a 4xx-inclusive ratio
  would alert on the security design working.
- **No PHI or high-cardinality labels.** No panel groups by `tenantId`,
  `sessionId`, `patientId`; the CI gate rejects any PromQL that tries. Loki keeps
  the per-session detail, reached by drill-down.
- **Every panel carries a `description`** stating how to read the number and what
  a change in it means — enforced by the gate for non-grandfathered boards.

### 4.2 The CI gate — `scripts/check-dashboards.py`

Blocking, no `allow_failure`, `python:3.11-slim`, pinned `pyyaml==6.0.2`,
matching `config-refs`. Asserts: JSON parses; `uid` present and unique; every
file registered in the configMapGenerator **and** every registration backed by a
file; `datasource.uid` ∈ {prometheus, loki, tempo}; panel `description` + `unit`
present; no PHI-class label in PromQL; no hardcoded rate interval.

It walks panels nested inside collapsed rows — a naive walk over
`dashboard["panels"]` validates the expanded rows and skips everything else,
which on a row-based board is most of it.

The five legacy boards sit in an explicit `GRANDFATHERED` set exempting them from
the description/unit and rate-interval checks only (37 pre-existing occurrences).
Structural checks apply to every board, always. **The set may shrink; it must
never grow.** A gate that fails on 37 pre-existing issues on day one is a gate
someone turns off.

### 4.3 Alert rules — 45 → 58

Four new groups: `api_gateway` (3), `stt_realtime` (3), `ai_services` (5),
`jobs` (2).

`SttRealTimeFactorAboveOne` and `SttTranscriptUtterancesDropped` are `severity:
page`: RTF above 1.0 means latency grows without bound for as long as the
consultation continues, and a dropped utterance is missing from a clinician's
live transcript.

**One alert was deliberately NOT written.** WebSocket reconnect churn — the
pattern observed on 2026-09-18, 341 reconnects against 33 sessions on a fixed
~128 s cadence — has no Prometheus series: the gateway publishes its open-socket
aggregate to **Redis**, not Prometheus. Rather than ship a rule that cannot fire
(the exact failure mode found in §2.3.1), `alert-rules.yaml` carries a comment
explaining the gap and naming the prerequisite: a `hope_api_ws_reconnects_total`
counter in `arca/hope-v2`. The board charts it from Loki meanwhile.

### 4.4 Files changed

**`arca/hope-v2-deployment`** — branch `task-989-platform-dashboard`:

| File | Change |
|---|---|
| `scripts/check-dashboards.py` | new, 214 lines |
| `deployment/k8s/base/dashboards/platform.json` | new, 32 panels + 4 rows |
| `deployment/k8s/base/kustomization.yaml` | +1 line |
| `deployment/k8s/base/observability-config.yaml` | `allowUiUpdates`/`editable` → false |
| `deployment/k8s/base/dashboards/node-system-activity.json` | 2 descriptions |
| `deployment/k8s/base/alert-rules.yaml` | +4 groups / +13 rules; fd alert fixed |
| `.gitlab-ci.yml` | +`dashboards` job |
| `docs/observability-dashboards.md` | §2.4 stale-prose warning, §2.6, §3, §4.2 |

**`arca/hope-v2`**: this README only.

## 5. Verification

All run 2026-09-18 against the live dev cluster.

```
=== dashboards gate ===
✓ 6 dashboard(s), 100 panel(s): JSON valid, uids unique, wired,
  datasources known, no PHI labels

=== every panel target, POST /api/ds/query, 24h window ===
53 targets: 53 with data, 0 empty, 0 error

=== every new alert expression, live Prometheus ===
13 new alert expressions, 13 valid, 0 broken

=== alert rules parse ===
✓ rules parse: 58 rules in 17 groups

=== kubectl kustomize deployment/k8s/overlays/dev ===
✓ overlays/dev renders: 15701 lines
(staging, prod, standalone also render clean)

=== kubeconform -strict -summary -ignore-missing-schemas ===
Summary: 167 resources found in 1 file - Valid: 165, Invalid: 0, Errors: 0, Skipped: 2

=== ConfigMap regenerated ===
grafana-dashboards-b8662fcghd

=== .gitlab-ci.yml ===
✓ parses | 11 jobs
```

The second block is the one that matters: **every panel was proven to return
live data before commit.** A panel that has never returned a series is worse
than no panel — it reads as coverage.

## 6. Follow-ups (not in this ticket)

| # | Item |
|---|---|
| FU-1 | `hope_api_ws_reconnects_total` counter in `arca/hope-v2`, so reconnect churn becomes alertable. Prerequisite for the alert omitted in §4.3 |
| FU-2 | Root-cause the ~128 s WebSocket drop cadence — client vs cloudflared vs Traefik. The gateway has no idle reaper and does not close on unknown message types, so the close originates outside it |
| FU-3 | App metrics for `stt-worker` (currently `up` only), `harness` and `tts` |
| FU-4 | Bring the five legacy boards up to standard and shrink `GRANDFATHERED` to empty |
| FU-5 | Rewrite the stale Patroni/PgBouncer prose in `docs/observability-dashboards.md` §2.4 |
| FU-6 | Investigate the 41% `text_generation_total` failure rate and the `s3://…` model id (§2.3.5) |
| FU-7 | Investigate `GenerateDnaReport` job failures; likely the known TASK-974 dev-DB reseed (§2.3.6) |

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-18 | Ticket opened. Board, CI gate, alert groups, provisioning lock and doc updates implemented and verified. Committed to `task-989-platform-dashboard`; **not merged to `main`** — merging auto-deploys via Argo and is the owner's call. |
