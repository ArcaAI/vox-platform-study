# Observability recommendations — HOPE / VOX platform

Date: 2026-11-23  
Companion documents: `observability_discovery.md`, `observability_procedures.md`, `observability_troubleshoot.md`

These recommendations are based on the discovery evidence in `review/grafana2/`. Nothing here has been applied.

---

## 1. Guiding principles

1. **One pane of glass, two estates for now.** Grafana `30300` is the newer apps-v2 estate. Keep it as the primary UI, but add the old infra Loki as a second datasource so responders can see infra/legacy logs without switching tools.
2. **Metrics for detection, logs for explanation, traces for dependency blame.** Prometheus already has broad coverage; Loki and Tempo are underused.
3. **Do not increase Loki label cardinality.** The new Loki indexes only four labels by design. Use structured-metadata filters (`| field="value"`) for correlation IDs, pod, node, and level.
4. **Preserve PHI redaction.** All log changes must continue through the OTel Collector redaction pipeline.
5. **Alert on user-visible symptoms first.** Queue depth, error ratio, latency, and missing heartbeats matter more than raw resource saturation alone.
6. **Treat exposed credentials as compromised.** Rotate the Grafana admin password and any previously shared root/user passwords.

---

## 2. P0 — do these now

| # | Action | Why | Owner suggestion |
|---|---|---|---|
| 1 | Rotate the Grafana admin password and any shared root/user passwords | Credentials were shared in chat and must be considered exposed | Platform owner |
| 2 | Triage the 17 down Prometheus targets | `TargetDown` and `ExpectedTargetCountMismatch` are firing; data-tier and Temporal are affected | Karan Mohan / Rijna Shameen |
| 3 | Investigate `hope-stt-v2-worker` silence | Last log was 2026-11-21; could be a stalled clinical transcription worker | Indumati Vastrad |
| 4 | Confirm whether `TemporalDown` is a real outage or scrape misconfiguration | Firing page-severity alert; `Temporal UI` endpoint is reachable | Infra owner |
| 5 | Decide which Loki is system of record | Prevents responders from querying the wrong backend | Platform owner |

Suggested checks for P0 are in `observability_troubleshoot.md`.

---

## 3. Dashboard recommendations

Add these to the existing **HOPE** folder, next to the nine current dashboards.

| # | Dashboard | Monitor what | Key signals / datasources | Priority |
|---|---|---|---|---|
| 1 | **NestJS API runtime deep dive** | API runtime health beyond basic RED | `hope_api_nodejs_eventloop_lag_*`, GC duration, heap spaces, active handles/requests/resources, `hope_api_process_*`, FDs, `hope_api_http_*`, Tempo dependency spans. Prometheus + Tempo | P1 |
| 2 | **Python FastAPI golden signals** (templated by service) | Uniform request/runtime view for Python services | `http_requests_total`, request duration, `fastapi_inprogress`, `process_resident_memory_bytes`, `process_open_fds`, `python_gc_*`, restarts. Prometheus | P1 |
| 3 | **Guardrail decisions & outbox health** | Silent safety failures and audit loss | `guardrail_screening_decisions_total`, `guardrail_queue_depth`, `guardrail_inflight_requests`, `guardrail_admission_wait_seconds`, `guardrail_circuit_breaker_state`, `guardrail_peer_failures_total`, `guardrail_evaluation_outbox_*`. Prometheus + Loki (`guardrail.judge.undetermined`) | P1 |
| 4 | **STT realtime + batch worker SLO** | Streaming quality and batch backlog | Realtime: sessions active, RTF, first-partial, commit latency, ingest lag, dropped audio, `stt_vllm_slot_wait_seconds`. Batch: queue backlog, job failure rate, worker up, Temporal task failures. Prometheus + Loki | P1 |
| 5 | **Temporal / Harness workflow health** | Workflow-backed clinical flows | Workflow/task failure rate, task queue backlog, retries, workflow duration, worker restarts, `harness_regen_total`, `PodCrashLooping`, `ContainerWaitingOnError`. Prometheus + Loki | P1 |
| 6 | **Alertmanager & alert-fatigue triage** | What is firing, for how long, and whether notifications work | `ALERTS{alertstate=~"firing|pending"}`, alerts by rule/severity/namespace, `alertmanager_notifications_failed_total`, silences, TargetDown by job, MTTR. Prometheus | P0/P1 |
| 7 | **Log coverage / pipeline health** | Detect silent services and ingest gaps | `sum by (service_name) (count_over_time({k8s_namespace_name="project-hope-vox-apps-v2"}[1h]))`, expected-vs-actual service list, error/warn rate, Alloy active files, OTel queue saturation, Loki flush errors. Loki + Prometheus | P0/P1 |
| 8 | **NLP inference & queue health** | Queue wait and rejection before user impact | `nlp_inference_queue_depth`, queue wait p50/p95, `nlp_inference_batch_size`, `nlp_inference_rejections_total`, `nlp_documents_processed_total`, `nlp_process_rss_bytes`. Prometheus | P2 |
| 9 | **Text generation & language quality** | Product-specific quality regressions | `text_generation_total`, `text_time_to_first_token_seconds`, `text_tokens_per_second`, `text_provider_health`, circuit breakers, Loki language-repair outcomes, Malayalam character ratio. Prometheus + Loki | P2 |
| 10 | **TTS / model cold-start & residency** | Cold starts and evictions driving latency | `tts_model_loaded`, `model_load_seconds`, `model_load_failures_total`, `model_cache_*`, `model_evictions_total`, `model_resident_bytes`, framebuffer used. Prometheus | P2 |

Current `hope-platform` and `hope-vllm` dashboards already cover parts of some of these; the new dashboards should link to them rather than duplicate every panel.

---

## 4. Logging recommendations

### 4.1 Loki datasource strategy

- Keep the existing `loki` datasource for apps-v2.
- Add a second datasource, e.g. `Loki (Infra)`, pointing to the old Loki:
  `http://loki.project-hope-vox-infra.svc.cluster.local:3100`
- Remember the old Loki uses different labels: `namespace`, `job`, `pod`, `container`, `service_name`. Queries must not reuse `k8s_namespace_name`.

### 4.2 GPU-node stdout coverage

Alloy currently excludes `node-type=gpu-node`, but GPU services already export structured logs via app-level OTLP. Adding a GPU Alloy DaemonSet would capture raw tracebacks that bypass the OTLP logger, but will duplicate lines unless deduplicated.

Recommended order:

1. First fix/restart `hope-stt-v2-worker` and confirm app-level logs resume.
2. If raw traceback coverage is required, add a dedicated GPU Alloy DaemonSet.
3. Add a dedupe rule in the OTel Collector, or disable app-level log export for services whose stdout is tailed.
4. Verify duplicates with a count query before rolling broadly.

### 4.3 Admin console verbosity

`hope-admin-console` has only 11 log lines in 24h. This is low traffic, not a collection failure. If more visibility is needed, enable request/access logging in the Next.js app rather than changing Loki.

### 4.4 Label discipline

- Keep only the four indexed labels in the new Loki.
- Use structured metadata filters for `hope_request_id`, `enduser.id`, `k8s_pod_name`, `detected_level`, etc.
- Do not index tenant, patient, consultation, or raw URL fields.

---

## 5. Alerting recommendations

1. **Reduce noise from `TargetDown`:** group by job/namespace and route data-tier failures to infra owner, app failures to service owner.
2. **Add missing-log alerts:** expected service emits zero lines over 6h. Use a longer window to avoid quiet-period false positives.
3. **Tune `ExpectedTargetCountMismatch`:** document the expected count per job so the alert is actionable.
4. **Split severity:** keep `TemporalDown`, `PodCrashLooping`, `GPUTemperatureHigh` as page; queue/backlog and capacity as ticket.
5. **Add notification health:** alert on `alertmanager_notifications_failed_total`.
6. **Investigate Grafana API 500:** `/api/search?type=alert` returned 500 and Grafana logs show TraceQL/`/api/search` errors. Include these in self-monitoring.
7. **Add runbook links in alert annotations** to `observability_troubleshoot.md`.

---

## 6. Implementation roadmap

### Phase 1 — stabilize (days 1–2)

- Rotate credentials.
- Triage down targets and firing alerts.
- Restart/investigate STT batch worker.
- Add `Alertmanager & alert-fatigue triage` and `Log coverage / pipeline health` dashboards.
- Add second Loki datasource.

### Phase 2 — service depth (week 1)

- Add NestJS runtime, Python golden signals, Guardrail, and STT/Temporal dashboards.
- Add Loki panels to those dashboards.
- Add missing-log alerts.

### Phase 3 — quality and hardening (weeks 2–3)

- Add NLP, Text quality, TTS cold-start dashboards.
- Decide on GPU Alloy DS and dedupe strategy.
- Add SLOs and error budgets for API, STT, Guardrail, and Temporal.
- Document ownership and review cadence.

---

## 7. Ownership mapping

| Area | Suggested owner |
|---|---|
| Guardrail, Text, NLP, LM Studio, STT services | Indumati Vastrad |
| PostgreSQL, Temporal, Silo/MinIO, Qdrant, Vault | Karan Mohan / Rijna Shameen |
| Grafana, Prometheus, Loki, Tempo, OTel Collector, alert rules | Platform / observability owner |
| Security and credential rotation | Platform owner + security |

---

## 8. Success criteria

- Every service in the endpoint inventory has a log-coverage panel.
- No unexplained firing `TargetDown` for more than one working day.
- `TemporalDown` resolved or explicitly silenced with a documented reason.
- STT batch worker emits fresh heartbeat logs and queue backlog is visible.
- Responders can answer within five minutes: is it metrics, logs, or traces that show the fault?
- No credentials or PHI appear in dashboards, alert annotations, or exported evidence.
