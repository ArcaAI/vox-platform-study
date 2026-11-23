#!/usr/bin/env python3
"""Generate Grafana dashboards + the 07-grafana-dashboards.yaml ConfigMap.

Source of truth for the dashboard JSON. Re-run after editing:

    python3 review/observability/dashboards/generate.py

It rewrites ../manifests/07-grafana-dashboards.yaml in place, preserving the two
pre-existing dashboards (prometheus-overview, logs-overview) read back from that
file, then appends the per-app / infra / GPU dashboards.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.normpath(os.path.join(HERE, "..", "manifests", "07-grafana-dashboards.yaml"))

DS_P = {"type": "prometheus", "uid": "prometheus"}
DS_L = {"type": "loki", "uid": "loki"}


def _ds(kind):
    return DS_P if kind == "p" else DS_L


def _targets(kind, pairs):
    out = []
    for i, pair in enumerate(pairs):
        expr, legend = (pair if isinstance(pair, (list, tuple)) else (pair, "auto"))
        t = {"datasource": _ds(kind), "expr": expr, "refId": chr(65 + i)}
        if legend is not None:
            t["legendFormat"] = legend
        out.append(t)
    return out


def _pack(panels):
    """Auto-place panels on a 24-col grid, top to bottom."""
    x = y = rowh = 0
    for p in panels:
        w, h = p["gridPos"]["w"], p["gridPos"]["h"]
        if x + w > 24:
            x, rowh = 0, rowh
            y += rowh
            rowh = 0
        p["gridPos"]["x"], p["gridPos"]["y"] = x, y
        x += w
        rowh = max(rowh, h)
    for p in panels:
        p.pop("_spec", None)
    return panels


def stat(title, kind, expr, unit="short", w=6, h=5, thresholds=None, legend=None):
    fc = {"defaults": {"unit": unit}, "overrides": []}
    if thresholds:
        fc["defaults"]["thresholds"] = {"mode": "absolute", "steps": thresholds}
    return {
        "type": "stat", "title": title, "datasource": _ds(kind),
        "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
        "fieldConfig": fc,
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                    "colorMode": "value", "graphMode": "area"},
        "targets": _targets(kind, [(expr, legend)]),
    }


def ts(title, kind, pairs, unit="short", w=12, h=8, stack=False, fill=8):
    return {
        "type": "timeseries", "title": title, "datasource": _ds(kind),
        "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
        "fieldConfig": {"defaults": {"unit": unit, "custom": {"fillOpacity": fill, "stacking": {"mode": "normal" if stack else "none"}}}, "overrides": []},
        "options": {"legend": {"displayMode": "list", "placement": "bottom", "calcs": []},
                    "tooltip": {"mode": "multi", "sort": "desc"}},
        "targets": _targets(kind, pairs),
    }


def logs(title, expr, w=24, h=14):
    return {
        "type": "logs", "title": title, "datasource": DS_L,
        "gridPos": {"h": h, "w": w, "x": 0, "y": 0},
        "options": {"showTime": True, "wrapLogMessage": True, "sortOrder": "Descending",
                    "enableLogDetails": True, "dedupStrategy": "none"},
        "targets": _targets("l", [(expr, None)]),
    }


def dashboard(uid, title, tags, panels, time_from="now-6h", variables=None):
    return {
        "annotations": {"list": []},
        "editable": True,
        "fiscalYearStartMonth": 0,
        "graphTooltip": 1,
        "id": None,
        "links": [],
        "panels": _pack(panels),
        "refresh": "30s",
        "schemaVersion": 39,
        "tags": tags,
        "templating": {"list": variables or []},
        "time": {"from": time_from, "to": "now"},
        "timezone": "browser",
        "title": title,
        "uid": uid,
        "version": 1,
    }


def search_var():
    return {"name": "search", "label": "search", "type": "textbox", "query": "",
            "current": {"selected": False, "text": "", "value": ""}}


# --------------------------------------------------------------------------- #
# Kubernetes infrastructure
# --------------------------------------------------------------------------- #
def k8s_infra():
    P, L = "p", "l"
    node = 'job="node-exporter"'
    panels = [
        stat("Nodes Ready", P, 'sum(kube_node_status_condition{condition="Ready",status="true"})', "short", 4, 5,
             [{"color": "red", "value": None}, {"color": "green", "value": 1}]),
        stat("Nodes Total", P, "count(kube_node_info)", "short", 4, 5),
        stat("Pods Running", P, 'sum(kube_pod_status_phase{phase="Running"})', "short", 4, 5),
        stat("Pods Pending", P, 'sum(kube_pod_status_phase{phase="Pending"})', "short", 4, 5,
             [{"color": "green", "value": None}, {"color": "orange", "value": 1}]),
        stat("Pods Failed", P, 'sum(kube_pod_status_phase{phase="Failed"})', "short", 4, 5,
             [{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        stat("Deployments Available", P, "sum(kube_deployment_status_replicas_available)", "short", 4, 5),
        ts("Node CPU usage %", P, [(f'100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{{{node},mode="idle"}}[5m])))', "{{instance}}")],
           "percent", 12, 8),
        ts("Node memory used %", P,
           [(f'100 * (1 - node_memory_MemAvailable_bytes{{{node}}} / node_memory_MemTotal_bytes{{{node}}})', "{{instance}}")], "percent", 12, 8),
        ts("Node filesystem used %", P,
           [(f'100 * (1 - node_filesystem_avail_bytes{{{node},fstype!~"tmpfs|overlay"}} / node_filesystem_size_bytes{{{node},fstype!~"tmpfs|overlay"}})', "{{instance}} {{mountpoint}}")],
           "percent", 12, 8),
        ts("Node load average (1m)", P, [(f"node_load1{{{node}}}", "{{instance}}")], "short", 12, 8),
        ts("Node network receive (- sent)", P,
           [(f'rate(node_network_receive_bytes_total{{{node},device!~"lo|veth.*|cali.*|docker.*|br-.*"}}[5m])', "rx {{instance}} {{device}}"),
            (f'-rate(node_network_transmit_bytes_total{{{node},device!~"lo|veth.*|cali.*|docker.*|br-.*"}}[5m])', "tx {{instance}} {{device}}")],
           "Bps", 12, 8),
        ts("Pods by phase", P, [('sum by (phase) (kube_pod_status_phase)', "{{phase}}")], "short", 12, 8, stack=True),
        ts("Top pods by CPU (cores)", P,
           [('topk(10, sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="", container!="POD"}[5m])))', "{{namespace}}/{{pod}}")],
           "none", 12, 8, fill=0),
        ts("Top pods by memory", P,
           [('topk(10, sum by (namespace, pod) (container_memory_working_set_bytes{container!="", container!="POD"}))', "{{namespace}}/{{pod}}")],
           "bytes", 12, 8, fill=0),
        ts("Container restarts (rate)", P,
           [('sum by (namespace, pod) (rate(kube_pod_container_status_restarts_total[10m]))', "{{namespace}}/{{pod}}")],
           "short", 12, 8, fill=0),
        ts("Cluster capacity (cores / GiB RAM)", P,
           [("sum(kube_node_status_allocatable{resource=\"cpu\"})", "allocatable cores"),
            ("sum(kube_node_status_capacity{resource=\"cpu\"})", "capacity cores"),
            ("sum(kube_node_status_allocatable{resource=\"memory\"}) / 1024/1024/1024", "allocatable GiB"),
            ("sum(kube_node_status_capacity{resource=\"memory\"}) / 1024/1024/1024", "capacity GiB")],
           "short", 12, 8),
    ]
    return dashboard("k8s-infra", "Kubernetes Infrastructure", ["k8s", "infra", "node"], panels, "now-6h")


# --------------------------------------------------------------------------- #
# STT + GPU host
# --------------------------------------------------------------------------- #
def stt_gpu():
    P, L = "p", "l"
    ne = 'job="node-exporter-gpu"'
    stt = 'job="stt-gpu"'
    vllm = 'job="vllm"'
    panels = [
        stat("GPU host CPU %", P, f'100 * (1 - avg(rate(node_cpu_seconds_total{{{ne},mode="idle"}}[5m])))', "percent", 4, 5,
             [{"color": "green", "value": None}, {"color": "orange", "value": 70}, {"color": "red", "value": 90}]),
        stat("GPU host memory %", P,
             f'100 * (1 - node_memory_MemAvailable_bytes{{{ne}}} / node_memory_MemTotal_bytes{{{ne}}})', "percent", 4, 5,
             [{"color": "green", "value": None}, {"color": "orange", "value": 80}, {"color": "red", "value": 92}]),
        stat("Load (1m)", P, f"node_load1{{{ne}}}", "short", 4, 5),
        stat("STT sessions active", P, f"sum(stt_streaming_sessions_active{{{stt}}})", "short", 4, 5),
        stat("STT queue depth", P, f'sum(stt_worker_queue_depth{{{stt}}})', "short", 4, 5,
             [{"color": "green", "value": None}, {"color": "orange", "value": 5}, {"color": "red", "value": 20}]),
        stat("vLLM requests running", P, f'sum(vllm:num_requests_running{{{vllm}}})', "short", 4, 5),
        ts("GPU host CPU % by core-mode", P,
           [(f'avg by (mode) (rate(node_cpu_seconds_total{{{ne}}}[5m])) * 100', "{{mode}}")], "percent", 12, 8, stack=True),
        ts("GPU host memory", P,
           [(f'node_memory_MemTotal_bytes{{{ne}}} - node_memory_MemAvailable_bytes{{{ne}}}', "used"),
            (f'node_memory_MemAvailable_bytes{{{ne}}}', "available"),
            (f'node_memory_Cached_bytes{{{ne}}}', "cached")], "bytes", 12, 8),
        ts("GPU host filesystem used %", P,
           [(f'100 * (1 - node_filesystem_avail_bytes{{{ne},fstype!~"tmpfs|overlay"}} / node_filesystem_size_bytes{{{ne},fstype!~"tmpfs|overlay"}})', "{{mountpoint}}")],
           "percent", 12, 8),
        ts("GPU host network", P,
           [(f'rate(node_network_receive_bytes_total{{{ne},device!~"lo|veth.*|docker.*|br-.*"}}[5m])', "rx {{device}}"),
            (f'-rate(node_network_transmit_bytes_total{{{ne},device!~"lo|veth.*|docker.*|br-.*"}}[5m])', "tx {{device}}")], "Bps", 12, 8),
        ts("STT active sessions", P, [(f"stt_streaming_sessions_active{{{stt}}}", "active"),
                                      (f"rate(stt_streaming_sessions_total{{{stt}}}[5m])", "new/s")], "short", 12, 8),
        ts("STT worker queue / in-progress", P,
           [(f"stt_worker_queue_depth{{{stt}}}", "queue depth"),
            (f"stt_worker_jobs_in_progress{{{stt}}}", "in progress")], "short", 12, 8),
        ts("STT inference latency p95/p50", P,
           [(f'histogram_quantile(0.95, sum by (le) (rate(stt_streaming_inference_latency_seconds_bucket{{{stt}}}[$__rate_interval])))', "p95"),
            (f'histogram_quantile(0.50, sum by (le) (rate(stt_streaming_inference_latency_seconds_bucket{{{stt}}}[$__rate_interval])))', "p50")], "s", 12, 8),
        ts("STT real-time factor (RTF) p95", P,
           [(f'histogram_quantile(0.95, sum by (le) (rate(stt_streaming_rtf_bucket{{{stt}}}[$__rate_interval])))', "p95 RTF")], "short", 12, 8),
        ts("STT ingest lag p95", P,
           [(f'histogram_quantile(0.95, sum by (le) (rate(stt_ingest_lag_seconds_bucket{{{stt}}}[$__rate_interval])))', "p95")], "s", 12, 8),
        ts("STT audio processed (streaming + batch)", P,
           [(f'rate(stt_streaming_audio_duration_seconds_total{{{stt}}}[5m])', "streaming audio s/s"),
            (f'rate(stt_audio_duration_seconds_sum{{{stt}}}[5m])', "batch audio s/s")], "short", 12, 8),
        ts("STT errors / drops", P,
           [(f"rate(stt_streaming_inference_queue_dropped_total{{{stt}}}[5m])", "queue dropped/s"),
            (f"rate(stt_streaming_script_mismatch_total{{{stt}}}[5m])", "script mismatch/s"),
            (f"rate(stt_streaming_endpoint_decisions_total{{{stt}}}[5m])", "endpoint decisions/s")], "short", 12, 8),
        ts("Whisper engine via vLLM", P,
           [(f'sum(vllm:num_requests_running{{{vllm}}})', "running"),
            (f'sum(vllm:num_requests_waiting{{{vllm}}})', "waiting"),
            (f'sum(vllm:kv_cache_usage_perc{{{vllm}}})', "kv cache %")], "short", 12, 8),
        stat("STT log lines (range)", L, f'sum(count_over_time({{{stt}}}[$__range]))', "short", 8, 5),
        stat("STT error lines (range)", P, "", "short", 0, 0) if False else stat("STT error-ish (range)", L,
             f'sum(count_over_time({{{stt}}} |~ "(?i)(error|exception|panic|fatal|traceback)" [$__range]))', "short", 8, 5,
             [{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        ts("STT log volume by stream", L, [(f'sum by (stream) (count_over_time({{job="stt-gpu"}} [5m]))', "{{stream}}")], "short", 8, 5),
        logs("STT logs", '{job="stt-gpu"} |~ "$search"', 24, 12),
        logs("STT errors", '{job="stt-gpu"} |~ "(?i)(error|exception|traceback|panic|fatal)"', 24, 12),
    ]
    return dashboard("stt-gpu", "STT / GPU Server", ["stt", "gpu", "hope"], panels, "now-6h", [search_var()])


# --------------------------------------------------------------------------- #
# vLLM
# --------------------------------------------------------------------------- #
def vllm():
    P, L = "p", "l"
    j = 'job="vllm"'
    panels = [
        stat("Requests running", P, f'sum(vllm:num_requests_running{{{j}}})', "short", 4, 5),
        stat("Requests waiting", P, f'sum(vllm:num_requests_waiting{{{j}}})', "short", 4, 5,
             [{"color": "green", "value": None}, {"color": "orange", "value": 1}]),
        stat("KV cache usage %", P, f'sum(vllm:kv_cache_usage_perc{{{j}}}) * 100', "percent", 4, 5),
        stat("Success rate /s", P, f'sum(rate(vllm:request_success_total{{{j}}}[5m]))', "short", 4, 5),
        stat("Preemptions/s", P, f'sum(rate(vllm:num_preemptions_total{{{j}}}[5m]))', "short", 4, 5,
             [{"color": "green", "value": None}, {"color": "orange", "value": 0.1}]),
        stat("Generation tok/s", P, f'sum(rate(vllm:generation_tokens_total{{{j}}}[5m]))', "short", 4, 5),
        ts("Requests running / waiting", P,
           [(f'sum(vllm:num_requests_running{{{j}}}) by ()', "running"),
            (f'sum(vllm:num_requests_waiting{{{j}}})', "waiting")], "short", 12, 8),
        ts("KV cache usage %", P, [(f'vllm:kv_cache_usage_perc{{{j}}} * 100', "{{model_name}}")], "percent", 12, 8),
        ts("Throughput (tokens/s)", P,
           [(f'sum(rate(vllm:generation_tokens_total{{{j}}}[$__rate_interval]))', "generation"),
            (f'sum(rate(vllm:prompt_tokens_total{{{j}}}[$__rate_interval]))', "prompt")], "tokens/s", 12, 8),
        ts("TTFT p95 / p50", P,
           [(f'histogram_quantile(0.95, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket{{{j}}}[$__rate_interval])))', "p95"),
            (f'histogram_quantile(0.50, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket{{{j}}}[$__rate_interval])))', "p50")], "s", 12, 8),
        ts("Inter-token latency (TPOT) p95", P,
           [(f'histogram_quantile(0.95, sum by (le) (rate(vllm:request_time_per_output_token_seconds_bucket{{{j}}}[$__rate_interval])))', "p95")], "s", 12, 8),
        ts("End-to-end request latency p95", P,
           [(f'histogram_quantile(0.95, sum by (le) (rate(vllm:e2e_request_latency_seconds_bucket{{{j}}}[$__rate_interval])))', "p95")], "s", 12, 8),
        ts("Preemptions / requests success", P,
           [(f'sum(rate(vllm:num_preemptions_total{{{j}}}[$__rate_interval]))', "preemptions/s"),
            (f'sum(rate(vllm:request_success_total{{{j}}}[$__rate_interval]))', "success/s")], "short", 12, 8),
        ts("vLLM process CPU / memory", P,
           [(f'rate(process_cpu_seconds_total{{{j}}}[$__rate_interval])', "cpu cores"),
            (f'process_resident_memory_bytes{{{j}}}', "resident bytes")], "short", 12, 8),
        ts("HTTP request rate by status", P,
           [(f'sum by (status) (rate(http_requests_total{{{j}}}[$__rate_interval]))', "{{status}}")], "reqps", 12, 8),
        stat("vLLM error logs (range)", L,
             'sum(count_over_time({job="vllm"} |~ "(?i)(error|exception|traceback|panic|fatal)" [$__range]))', "short", 6, 5,
             [{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        stat("vLLM log lines (range)", L, 'sum(count_over_time({job="vllm"} [$__range]))', "short", 6, 5),
        logs("vLLM logs", '{job="vllm"} |~ "$search"', 24, 14),
        logs("vLLM errors", '{job="vllm"} |~ "(?i)(error|exception|traceback|panic|fatal|CUDA|OOM)"', 24, 12),
    ]
    return dashboard("vllm", "vLLM — GPU Inference", ["vllm", "gpu", "llm"], panels, "now-6h", [search_var()])


# --------------------------------------------------------------------------- #
# Per-application dashboards
# --------------------------------------------------------------------------- #
def _app_common(container, app):
    """Panels common to every app: log volume/errors + cAdvisor CPU/mem."""
    ns = 'namespace="project-hope-vox"'
    pod = f'namespace="project-hope-vox", pod=~"{app}-.*"'
    return [
        stat("Log lines (range)", "l", f'sum(count_over_time({{{ns}, container="{container}"}} |~ "$search" [$__range]))', "short", 4, 5),
        stat("Error-ish lines (range)", "l",
             f'sum(count_over_time({{{ns}, container="{container}"}} |~ "(?i)(error|exception|traceback|panic|fatal)" [$__range]))',
             "short", 4, 5, [{"color": "green", "value": None}, {"color": "red", "value": 1}]),
        stat("CPU (cores)", "p", f'sum(rate(container_cpu_usage_seconds_total{{{pod}, container!="", container!="POD"}}[5m]))', "none", 4, 5),
        stat("Memory", "p", f'sum(container_memory_working_set_bytes{{{pod}, container!="", container!="POD"}})', "bytes", 4, 5),
        ts("Log volume (per $__interval)", "l",
           [(f'sum(count_over_time({{{ns}, container="{container}"}} |~ "$search" [$__interval]))', "lines")], "short", 12, 8),
        ts("Errors (per $__interval)", "l",
           [(f'sum(count_over_time({{{ns}, container="{container}"}} |~ "(?i)(error|exception|traceback|panic|fatal)" [$__interval]))', "errors")], "short", 12, 8),
        ts("CPU (cores) by pod", "p",
           [(f'sum by (pod) (rate(container_cpu_usage_seconds_total{{{pod}, container!="", container!="POD"}}[5m]))', "{{pod}}")], "none", 12, 8),
        ts("Memory by pod", "p",
           [(f'sum by (pod) (container_memory_working_set_bytes{{{pod}, container!="", container!="POD"}})', "{{pod}}")], "bytes", 12, 8),
    ]


def app_dashboard(container, app, title, tags, metric_panels):
    ns = 'namespace="project-hope-vox"'
    panels = _app_common(container, app) + metric_panels + [
        logs("Logs", f'{{{ns}, container="{container}"}} |~ "$search"', 24, 14),
        logs("Errors", f'{{{ns}, container="{container}"}} |~ "(?i)(error|exception|traceback|panic|fatal)"', 24, 12),
    ]
    return dashboard(f"app-{app}", title, ["app", app] + tags, panels, "now-6h", [search_var()])


def apps():
    A = {}

    def q(expr, legend="auto"):
        return (expr, legend)

    A["app-hope-api-gateway.json"] = app_dashboard(
        "hope-api-gateway", "hope-api-gateway", "App — API Gateway", ["gateway"],
        [
            ts("Request rate", "p", [q('sum(rate(api_gateway_http_requests_total[$__rate_interval]))', "requests/s")], "reqps", 12, 8),
            ts("Request latency p95 / p50", "p",
               [q('histogram_quantile(0.95, sum by (le) (rate(api_gateway_http_request_duration_seconds_bucket[$__rate_interval])))', "p95"),
                q('histogram_quantile(0.50, sum by (le) (rate(api_gateway_http_request_duration_seconds_bucket[$__rate_interval])))', "p50")], "s", 12, 8),
            ts("Active connections", "p", [q('sum(api_gateway_active_connections_count)', "connections")], "short", 12, 8),
            ts("Event loop lag p99", "p", [q('api_gateway_nodejs_eventloop_lag_p99_seconds', "p99")], "s", 12, 8),
            ts("STT gateway relay lag p95", "p",
               [q('histogram_quantile(0.95, sum by (le) (rate(stt_gateway_relay_lag_seconds_bucket[$__rate_interval])))', "p95")], "s", 12, 8),
            ts("Prisma pool (in use / waiting)", "p",
               [q('sum(api_gateway_prisma_pool_in_use)', "in use"),
                q('sum(api_gateway_prisma_pool_waiting)', "waiting")], "short", 12, 8),
        ])

    A["app-hope-guardrail.json"] = app_dashboard(
        "hope-guardrail", "hope-guardrail", "App — Guardrail", ["guardrail"],
        [
            ts("Request rate", "p", [q('sum(rate(http_requests_total{job="hope-apps", app="hope-guardrail"}[$__rate_interval]))', "requests/s")], "reqps", 12, 8),
            ts("Request latency p95 / p50", "p",
               [q('histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="hope-apps", app="hope-guardrail"}[$__rate_interval])))', "p95"),
                q('histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket{job="hope-apps", app="hope-guardrail"}[$__rate_interval])))', "p50")], "s", 12, 8),
            ts("Queue depth / in-flight", "p",
               [q('guardrail_queue_depth{job="hope-apps", app="hope-guardrail"}', "queue"),
                q('guardrail_inflight_requests{job="hope-apps", app="hope-guardrail"}', "in-flight")], "short", 12, 8),
            ts("Circuit breaker state", "p", [q('guardrail_circuit_breaker_state{job="hope-apps", app="hope-guardrail"}', "state")], "short", 12, 8),
            ts("Peer failures (rate)", "p", [q('sum(rate(guardrail_peer_failures_total{job="hope-apps", app="hope-guardrail"}[$__rate_interval]))', "failures/s")], "short", 12, 8),
            ts("Inference latency p95", "p",
               [q('histogram_quantile(0.95, sum by (le) (rate(model_inference_latency_seconds_bucket{job="hope-apps", app="hope-guardrail"}[$__rate_interval])))', "p95")], "s", 12, 8),
        ])

    A["app-hope-harness.json"] = app_dashboard(
        "hope-harness", "hope-harness", "App — Harness", ["harness"],
        [
            ts("Request rate", "p", [q('sum(rate(http_requests_total{job="hope-apps", app="hope-harness"}[$__rate_interval]))', "requests/s")], "reqps", 12, 8),
            ts("Request latency p95 / p50", "p",
               [q('histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="hope-apps", app="hope-harness"}[$__rate_interval])))', "p95"),
                q('histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket{job="hope-apps", app="hope-harness"}[$__rate_interval])))', "p50")], "s", 12, 8),
            ts("Regenerations (rate)", "p", [q('sum(rate(harness_regen_total{job="hope-apps", app="hope-harness"}[$__rate_interval]))', "regen/s")], "short", 12, 8),
        ])

    A["app-hope-nlp.json"] = app_dashboard(
        "hope-nlp", "hope-nlp", "App — NLP", ["nlp"],
        [
            ts("Request rate", "p", [q('sum(rate(http_requests_total{job="hope-apps", app="hope-nlp"}[$__rate_interval]))', "requests/s")], "reqps", 12, 8),
            ts("Documents / entities processed", "p",
               [q('sum(rate(nlp_documents_processed_total{job="hope-apps", app="hope-nlp"}[$__rate_interval]))', "docs/s"),
                q('sum(rate(nlp_entities_total{job="hope-apps", app="hope-nlp"}[$__rate_interval]))', "entities/s")], "short", 12, 8),
            ts("Inference queue depth", "p", [q('nlp_inference_queue_depth{job="hope-apps", app="hope-nlp"}', "queue")], "short", 12, 8),
            ts("Queue wait p95", "p",
               [q('histogram_quantile(0.95, sum by (le) (rate(nlp_inference_queue_wait_seconds_bucket{job="hope-apps", app="hope-nlp"}[$__rate_interval])))', "p95")], "s", 12, 8),
            ts("Inference latency p95 / p50", "p",
               [q('histogram_quantile(0.95, sum by (le) (rate(model_inference_latency_seconds_bucket{job="hope-apps", app="hope-nlp"}[$__rate_interval])))', "p95"),
                q('histogram_quantile(0.50, sum by (le) (rate(model_inference_latency_seconds_bucket{job="hope-apps", app="hope-nlp"}[$__rate_interval])))', "p50")], "s", 12, 8),
            ts("Batch size p50", "p",
               [q('histogram_quantile(0.5, sum by (le) (rate(nlp_inference_batch_size_bucket{job="hope-apps", app="hope-nlp"}[$__rate_interval])))', "p50")], "short", 12, 8),
        ])

    A["app-hope-text.json"] = app_dashboard(
        "hope-text", "hope-text", "App — Text generation", ["text", "llm"],
        [
            ts("Generations (rate)", "p", [q('sum(rate(text_generation_total{job="hope-apps", app="hope-text"}[$__rate_interval]))', "generations/s")], "reqps", 12, 8),
            ts("Tokens throughput", "p", [q('sum(rate(text_tokens_total{job="hope-apps", app="hope-text"}[$__rate_interval]))', "tokens/s")], "tokens/s", 12, 8),
            ts("Generation errors (rate)", "p", [q('sum(rate(text_generation_errors_total{job="hope-apps", app="hope-text"}[$__rate_interval]))', "errors/s")], "short", 12, 8),
            ts("Time to first token p95 / p50", "p",
               [q('histogram_quantile(0.95, sum by (le) (rate(text_time_to_first_token_seconds_bucket{job="hope-apps", app="hope-text"}[$__rate_interval])))', "p95"),
                q('histogram_quantile(0.50, sum by (le) (rate(text_time_to_first_token_seconds_bucket{job="hope-apps", app="hope-text"}[$__rate_interval])))', "p50")], "s", 12, 8),
            ts("Generation latency p95", "p",
               [q('histogram_quantile(0.95, sum by (le) (rate(text_generation_latency_seconds_bucket{job="hope-apps", app="hope-text"}[$__rate_interval])))', "p95")], "s", 12, 8),
            ts("Active generations", "p", [q('sum(text_active_generations{job="hope-apps", app="hope-text"})', "active")], "short", 12, 8),
            ts("Output tokens/s p50", "p",
               [q('histogram_quantile(0.5, sum by (le) (rate(text_tokens_per_second_bucket{job="hope-apps", app="hope-text"}[$__rate_interval])))', "p50")], "short", 12, 8),
            ts("Stop reasons (rate)", "p",
               [q('sum by (stop_reason) (rate(text_stop_reason_total{job="hope-apps", app="hope-text"}[$__rate_interval]))', "{{stop_reason}}")], "short", 12, 8),
        ])

    A["app-hope-tts.json"] = app_dashboard(
        "hope-tts", "hope-tts", "App — TTS", ["tts"],
        [
            ts("Request rate", "p", [q('sum(rate(tts_requests_total{job="hope-apps", app="hope-tts"}[$__rate_interval]))', "requests/s")], "reqps", 12, 8),
            ts("Characters synthesised (rate)", "p", [q('sum(rate(tts_characters_total{job="hope-apps", app="hope-tts"}[$__rate_interval]))', "chars/s")], "short", 12, 8),
            ts("Provider errors (rate)", "p", [q('sum(rate(tts_provider_errors_total{job="hope-apps", app="hope-tts"}[$__rate_interval]))', "errors/s")], "short", 12, 8),
            ts("Real-time factor (RTF) p95", "p",
               [q('histogram_quantile(0.95, sum by (le) (rate(tts_rtf_bucket{job="hope-apps", app="hope-tts"}[$__rate_interval])))', "p95")], "short", 12, 8),
            ts("Time to first audio (TTFA) p95", "p",
               [q('histogram_quantile(0.95, sum by (le) (rate(tts_ttfa_seconds_bucket{job="hope-apps", app="hope-tts"}[$__rate_interval])))', "p95")], "s", 12, 8),
            ts("Active streams", "p", [q('sum(tts_active_streams{job="hope-apps", app="hope-tts"})', "streams")], "short", 12, 8),
            ts("Model loaded", "p", [q('tts_model_loaded{job="hope-apps", app="hope-tts"}', "loaded")], "short", 12, 8),
        ])

    # Logs-only apps (no scrapeable metrics).
    for c, name, title in [
        ("hope-harness-worker", "hope-harness-worker", "App — Harness Worker"),
        ("hope-admin-console", "hope-admin-console", "App — Admin Console"),
    ]:
        ns = 'namespace="project-hope-vox"'
        panels = [
            stat("Log lines (range)", "l", f'sum(count_over_time({{{ns}, container="{c}"}} |~ "$search" [$__range]))', "short", 6, 5),
            stat("Error-ish lines (range)", "l",
                 f'sum(count_over_time({{{ns}, container="{c}"}} |~ "(?i)(error|exception|traceback|panic|fatal)" [$__range]))',
                 "short", 6, 5, [{"color": "green", "value": None}, {"color": "red", "value": 1}]),
            ts("Log volume (per $__interval)", "l",
               [(f'sum(count_over_time({{{ns}, container="{c}"}} |~ "$search" [$__interval]))', "lines")], "short", 12, 8),
            stat("CPU (cores)", "p", f'sum(rate(container_cpu_usage_seconds_total{{namespace="project-hope-vox", pod=~"{name}-.*", container!="", container!="POD"}}[5m]))', "none", 6, 5),
            stat("Memory", "p", f'sum(container_memory_working_set_bytes{{namespace="project-hope-vox", pod=~"{name}-.*", container!="", container!="POD"}})', "bytes", 6, 5),
            ts("Errors (per $__interval)", "l",
               [(f'sum(count_over_time({{{ns}, container="{c}"}} |~ "(?i)(error|exception|traceback|panic|fatal)" [$__interval]))', "errors")], "short", 12, 8),
            logs("Logs", f'{{{ns}, container="{c}"}} |~ "$search"', 24, 14),
            logs("Errors", f'{{{ns}, container="{c}"}} |~ "(?i)(error|exception|traceback|panic|fatal)"', 24, 12),
        ]
        A[f"app-{name}.json"] = dashboard(f"app-{name}", title, ["app", name], panels, "now-6h", [search_var()])

    return A


# --------------------------------------------------------------------------- #
# Load the two pre-existing dashboards and write everything back out
# --------------------------------------------------------------------------- #
def load_existing(path):
    """Parse `  <name>.json: |` blocks (4-space-indented JSON) from the ConfigMap."""
    if not os.path.exists(path):
        return {}
    text = open(path).read()
    lines = text.splitlines()
    out = {}
    i = 0
    while i < len(lines):
        m = re.match(r"^  ([A-Za-z0-9_.-]+\.json): \|\s*$", lines[i])
        if m:
            name = m.group(1)
            i += 1
            buf = []
            while i < len(lines) and (lines[i].startswith("    ") or lines[i].strip() == ""):
                buf.append(lines[i][4:] if lines[i].startswith("    ") else "")
                i += 1
            out[name] = json.loads("\n".join(buf))
        else:
            i += 1
    return out


HEADER = """# Grafana dashboards — namespace project-hope-vox-infra
#
# GENERATED FILE — edit review/observability/dashboards/generate.py and re-run it,
# do not hand-edit the JSON below (the provider in 06-grafana-provisioning.yaml
# points at /var/lib/grafana/dashboards, and 09-grafana.yaml mounts this ConfigMap
# there). Each key becomes a file.
#
# Dashboards:
#   prometheus-overview  — baseline Prometheus health
#   logs-overview        — cross-namespace log search (Loki)
#   k8s-infra            — cluster nodes + workloads (node-exporter, KSM, cAdvisor)
#   stt-gpu              — STT service + GPU host CPU/memory + whisper vLLM
#   vllm                 — vLLM inference metrics + logs/errors
#   app-hope-*           — one dashboard per HOPE application (logs + metrics)
---"""


def emit(dashboards):
    lines = [HEADER, "apiVersion: v1", "kind: ConfigMap", "metadata:",
             "  name: grafana-dashboards", "  namespace: project-hope-vox-infra",
             "  labels:", "    app: grafana", "    app.kubernetes.io/part-of: project-hope",
             "data:"]
    for name, obj in dashboards.items():
        lines.append(f"  {name}: |")
        for ln in json.dumps(obj, indent=2).splitlines():
            lines.append("    " + ln)
    return "\n".join(lines) + "\n"


def main():
    existing = load_existing(MANIFEST)
    dashboards = {}
    for keep in ("prometheus-overview.json", "logs-overview.json"):
        if keep in existing:
            dashboards[keep] = existing[keep]
    dashboards["k8s-infra.json"] = k8s_infra()
    dashboards["stt-gpu.json"] = stt_gpu()
    dashboards["vllm.json"] = vllm()
    dashboards.update(apps())

    with open(MANIFEST, "w") as f:
        f.write(emit(dashboards))
    print(f"wrote {MANIFEST} with {len(dashboards)} dashboards:")
    for n in dashboards:
        print("  -", n)


if __name__ == "__main__":
    main()
