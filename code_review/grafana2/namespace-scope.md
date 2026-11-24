# Namespace and Loki scope check

Date: 2026-11-23  
Evidence: `review/grafana2/14-namespace-scope-check.console.txt`, `15-namespace-and-loki-scope.console.txt`, `17-loki-infra-service-coverage.console.txt`

## Short answer

You are right to question it. **The services I listed earlier are specifically the ones in `project-hope-vox-apps-v2`**, because that is the namespace of the Grafana on port `30300`. That is **not the whole HOPE estate**.

There is a second, older HOPE generation in `project-hope-vox` and `project-hope-vox-infra`, plus a newer data tier in `project-hope-vox-infra-v2`. They have their own observability stack and their own Loki.

## Namespace map

| Namespace | Pods | Services | What it is |
|---|---:|---:|---|
| `project-hope-vox-apps-v2` | 36 | 24 | Newer app plane + Grafana 13.1.2 on `30300`, Prometheus, Tempo, OTel Collector, Alloy, app services |
| `project-hope-vox` | 18 | 19 | Older HOPE app plane: `hope-api-gateway`, `hope-nlp`, `hope-stt`, `hope-text`, `hope-guardrail`, `hope-vllm`, admin console, cloudflared, Traefik-like `gateway-test` |
| `project-hope-vox-infra` | 26 | 20 | Older data tier + **old Grafana/Loki/Prometheus/Alertmanager/Promtail**, postgres, redis, qdrant, silo/MinIO, temporal, vault |
| `project-hope-vox-infra-v2` | 7 | 8 | Newer data tier: `postgres`, `redis`, `temporal`, `hope-vault`, `qdrant`, `silo` (MinIO). These are the down Prometheus targets seen earlier |
| `monitoring` | 7 | 2 | Another older Prometheus/Grafana pair |
| `arcafabric` | 27 | 37 | Separate ArcaFabric stack with its own Grafana/Prometheus/MinIO/Postgres/Redis |

So when I said “the microservices running”, I meant those in `project-hope-vox-apps-v2`. Similar service names exist in `project-hope-vox`.

## Two separate Loki instances

### 1. New Loki — `project-hope-vox-apps-v2`

- Service: `svc/loki` (`3100`), image `grafana/loki:3.7.8`
- Fed by: Alloy DaemonSet → OTel Collector → Loki `/otlp`
- Alloy uses `POD_NAMESPACE` from the Downward API, so it only tails pods in `project-hope-vox-apps-v2`
- Alloy also excludes `node-type=gpu-node`
- Indexed labels: `service_name`, `k8s_namespace_name`, `k8s_container_name`, `deployment_environment_name`
- 24-hour query shows **only one namespace**:
  - `project-hope-vox-apps-v2`: 63,203 lines

This is the `loki` datasource used by the `HOPE` dashboards on port `30300`.

### 2. Old Loki — `project-hope-vox-infra`

- Service: `svc/loki` (`3100`) and `svc/loki-nodeport` (`31100`)
- Fed by Promtail; cluster-wide, not namespace-scoped
- Labels: `container`, `filename`, `job`, `namespace`, `node`, `pod`, `service_name`, `stream`
- 24-hour query shows many namespaces:

| Namespace | Lines/24h |
|---|---:|
| `project-hope-vox` | 438,142 |
| `project-hope-vox-infra` | 370,801 |
| `rubix` | 270,269 |
| `kube-system` | 89,734 |
| `project-hope-vox-apps-v2` | 91,107 |
| `arcafabric` | 87,998 |
| `project-hope-vox-infra-v2` | 13,037 |
| `argocd` | 8,248 |
| `monitoring` | 1,426 |
| others | small |

Service coverage in the old Loki:

**`project-hope-vox-infra`:** `loki`, `temporal`, `promtail`, `redis-store`, `grafana`, `postgres-pgvector-db`, `prometheus`

**`project-hope-vox-infra-v2`:** `temporal-ui`, `redis`, `temporal`, `postgres`, `qdrant`, `vault`

**`project-hope-vox`:** `hope-guardrail`, `hope-nlp`, `hope-tts`, `hope-text`, `hope-api-gateway`, `gateway-test`, `traefik`, `hope-harness-worker`, `cloudflared`, `hope-harness`, `hope-vllm`

## Implications for the earlier conclusions

1. The five services that “already have logs” were checked in the **apps-v2 Loki**. That is correct for the port-30300 Grafana.
2. `hope-stt-v2-worker` is silent in the apps-v2 Loki, but a similarly named legacy worker exists in `project-hope-vox` and is logged in the old Loki. Do not confuse the two.
3. The GPU-node Alloy exclusion only affects raw stdout capture for `project-hope-vox-apps-v2` pods. The legacy/GPU services in `project-hope-vox` are handled by the old Promtail/Loki stack.
4. The `HOPE` dashboards on port 30300 currently use only the new Loki datasource, so they **cannot see infra or legacy logs**. If you want one pane of glass, add the old infra Loki as a second datasource in Grafana and use it for infra/legacy panels.
5. Prometheus in apps-v2 scrapes targets across the estate (including `project-hope-vox-infra-v2`), which is why infrastructure metrics appear in the apps-v2 Grafana even though their logs live in the old Loki.

## Recommended next decisions

- Decide which Loki is the system of record.
  - If apps-v2 Loki: extend log shipping to GPU node and consider ingest from infra namespaces.
  - If old Loki: point the Grafana `loki` datasource at `project-hope-vox-infra` and align the new log-contract labels.
- Until then, treat the two Loki instances as scoped to two estates:
  - new Loki → `project-hope-vox-apps-v2`
  - old Loki → everything else, especially `project-hope-vox` and `project-hope-vox-infra`
