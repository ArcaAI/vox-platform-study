# Endpoint inventory — service layer and infrastructure layer

Date: 2026-11-23  
Verification evidence: `review/grafana2/18-endpoint-verification.console.txt`, `18-endpoint-svc-mapping.txt`, `http-body-*.txt`  
Checked from this laptop against `192.168.112.6`. No configuration was changed.

## Service layer

| Endpoint | Namespace | Kubernetes service | Port mapping | Result | Owner |
|---|---|---|---|---|---|
| `http://192.168.112.6:30863` | `project-hope-vox-apps-v2` | `svc/hope-guardrail` | `8863:30863/TCP` | HTTP 401 — auth required, reachable | Indumati Vastrad |
| `http://192.168.112.6:30862` | `project-hope-vox-apps-v2` | `svc/hope-text` | `8862:30862/TCP` | HTTP 401 — auth required, reachable | Indumati Vastrad |
| `http://192.168.112.6:30864` | `project-hope-vox-apps-v2` | `svc/hope-nlp` | `8864:30864/TCP` | HTTP 200 | Indumati Vastrad |
| `http://192.168.112.6:31234` | `project-hope-vox-apps-v2` | `svc/hope-lmstudio` | `1234:31234/TCP` | HTTP 200. Note: service selector is `<none>` | Indumati Vastrad |

Guardrail and Text returning 401 is normal for authenticated APIs; it confirms the listener is up. The 401 bodies are only 45 bytes.

## Infrastructure layer

| Endpoint | Namespace | Kubernetes service | Port mapping | Result | Owner |
|---|---|---|---|---|---|
| `192.168.112.6:30543` | `project-hope-vox-infra-v2` | `svc/postgres` | `5432:30543/TCP` | TCP OPEN | Karan Mohan / Rijna Shameen |
| `http://192.168.112.6:30880` | `project-hope-vox-infra-v2` | `svc/temporal-ui` | `8080:30880/TCP` | HTTP 200 | Karan Mohan / Rijna Shameen |
| `http://192.168.112.6:30901` | `project-hope-vox-infra-v2` | `svc/silo-console` | `9001:30901/TCP` | HTTP 200 | Karan Mohan / Rijna Shameen |
| `http://192.168.112.6:30633` | `project-hope-vox-infra-v2` | `svc/qdrant` | `6333:30633/TCP` | HTTP 200 (REST API) | Karan Mohan / Rijna Shameen |
| `192.168.112.6:30634` | `project-hope-vox-infra-v2` | `svc/qdrant` | `6334:30634/TCP` | TCP OPEN (gRPC) | Karan Mohan / Rijna Shameen |
| `http://192.168.112.6:30820` | `project-hope-vox-infra-v2` | `svc/hope-vault` | `8200:30820/TCP` | HTTP 200 after redirect to `/ui/`; large page timed out mid-download but responded | Karan Mohan / Rijna Shameen |

## Grafana

| Endpoint | Namespace | Kubernetes service | Port mapping | Result |
|---|---|---|---|---|
| `http://192.168.112.6:30300/alerting` | `project-hope-vox-apps-v2` | `svc/grafana` | `3000:30300/TCP` | HTTP 200 after redirect to `/login?redirectTo=%2Falerting` |

The admin credential supplied in the message was tested against `GET /api/user` and returned HTTP 200, so it works.

**Security note:** that credential has now been shared in chat and must be treated as exposed. Rotate it, and prefer a service account/API token for any automation. The password was not written to any file under `review/grafana2/`.

## Layering confirmed

- Service-layer endpoints all map to `project-hope-vox-apps-v2`.
- Infrastructure-layer endpoints all map to `project-hope-vox-infra-v2`.
- This matches the namespace/Loki scope findings in `review/grafana2/namespace-scope.md`: the older `project-hope-vox` and `project-hope-vox-infra` stacks still exist separately, but the endpoints you listed are the newer v2 estate.
