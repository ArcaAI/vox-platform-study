# TASK-616 — Env-key consumer inventory (E4.1 prerequisite)

**Generated** 2026-08-08 by [`scripts/env-consumer-inventory.py`](../../../scripts/env-consumer-inventory.py) against the rendered `dev` overlay.
**Purpose**: answer, per key, *which services actually read this* — the input [E4.1](./component-design-config-plane.md) needs to split `hope-config` safely.

Re-run with:

```bash
kubectl kustomize <deployment-repo>/deployment/k8s/overlays/dev > /tmp/cm-dev.yaml
scripts/env-consumer-inventory.py --configmap /tmp/cm-dev.yaml
```

---

## 1. Why this had to exist before the split

Splitting a shared `envFrom` map has a **silent** failure mode: a service that loses a key it reads gets an *undefined variable*, not an error. The deployment repo's `check-config-refs.py` cannot help — it only sees explicit `configMapKeyRef`s and is blind to `envFrom` keys by construction.

So the split is not derivable from the manifests. It needs the consumer side.

**Keys are obtained by asking pydantic, not by parsing source.** The Python services combine `env_prefix`, `env_prefix_target="all"` and `AliasChoices`, so the env var a field reads is often not textually present in the file — `SMR_GATEWAY_URL` comes from a field named `gateway_url`, aliased `GATEWAY_URL`, under prefix `SMR_`. A regex over the source would have missed it, and would also have missed every `SMR_V2_*` transition alias.

## 2. Headline: the split is far more tractable than the design assumed

| | Count |
|---|---|
| ConfigMap keys | 55 |
| Read by **more than one** service → platform map | **7** |
| Read by **exactly one** service → per-service map | **44** |
| No literal consumer found | **4** |

E4.1 predicted the platform map would hold "`NODE_ENV`, `LOG_LEVEL`, `DEBUG`, `CORS_ALLOWED_ORIGINS`, all `*_PORT`, all internal `*_URL`, MinIO bucket names, `OTEL_*_ENABLED`" — a large shared core. **The data says otherwise**: the `*_URL` set, the MinIO buckets and the `OTEL_*` flags are each read by exactly one service, so they belong to that service's map, not the platform's. The genuinely shared surface is seven keys.

That matters for blast radius: the smaller the platform map, the rarer a fleet-wide rollout under the `configMapGenerator` hash mechanism (E4.3).

## 3. Platform map — read by more than one service (7)

| Key | Consumers |
|---|---|
| `NODE_ENV` | admin-console, api, smr |
| `DEBUG` | api, stt |
| `LOG_LEVEL` | api, stt |
| `AZURE_SPEECH_REGION` | stt, tts |
| `NLP_PORT` | api, nlp |
| `SMR_PORT` | api, smr |
| `TTS_PORT` | api, tts |

The three `*_PORT` entries are shared only because the gateway needs to *reach* the service while the service needs to *bind*. If the gateway moved to `*_URL` consistently (it already reads `NLP_URL`, `SMR_URL`, `TTS_URL`, `STT_V2_URL`, `GUARDRAIL_URL`, `HARNESS_URL`), all three would collapse to per-service and the platform map would be **four keys**.

## 4. Per-service map (44)

| Service | Keys |
|---|---|
| **stt** (9) | `API_GATEWAY_TIMEOUT`, `MINIO_AUDIO_BUCKET`, `MINIO_CHUNK_BUCKET`, `MODEL_CACHE_MAX_MODELS`, `MODEL_CACHE_TTL_SECONDS`, `OTEL_ENABLED`, `OTEL_EXPORTER_ENDPOINT`, `TRANSCRIPTION_CHUNK_LENGTH_S`, `TRANSCRIPTION_TIMEOUT_SECONDS`, `WORKER_CONCURRENCY`, `WORKER_MAX_RETRIES` |
| **smr** (11) | `SMR_EXTERNAL_GUARDRAIL_ENABLED`, `SMR_GATEWAY_URL`, `SMR_OPENAI_COMPAT_BASE_URL`, `SMR_OPENAI_COMPAT_DEFAULT_MODEL`, `SMR_OPENAI_COMPAT_TIMEOUT_S`, `SMR_V2_METRICS_ENABLED`, `SMR_V2_OTEL_DEPLOYMENT_ENVIRONMENT`, `SMR_V2_OTEL_EXPORTER_ENDPOINT`, `SMR_V2_OTEL_INSECURE`, `SMR_V2_OTEL_LOGS_ENABLED`, `SMR_V2_OTEL_SERVICE_NAME`, `SMR_V2_OTEL_SERVICE_NAMESPACE` |
| **api** (13) | `ENABLE_PRISMA_STUDIO`, `GUARDRAIL_URL`, `HARNESS_URL`, `MINIO_USE_SSL`, `NLP_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_LOGS_ENABLED`, `OTEL_LOG_BRIDGE`, `OTEL_METRICS_ENABLED`, `OTEL_TRACES_ENABLED`, `SMR_URL`, `STT_V2_URL`, `TTS_URL` |
| **harness** (5) | `HARNESS_API_BASE_URL`, `HARNESS_CLAIM_CHECK_ENABLED`, `HARNESS_CLAIM_CHECK_STORE`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE` |
| **admin-console** (2) | `API_URL`, `NEXT_PUBLIC_API_HOST` |

`guardrail`, `nlp` and `tts` read **nothing** from `hope-config` beyond the platform keys — every one of their settings arrives as a literal `env:` entry in their own manifest. They need no per-service map at all.

## 5. Keys with no literal consumer (4)

Each verified individually by grepping the bare key, not just the `process.env` form.

| Key | Value | Verdict |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | `*` | **Dead by owner directive.** `apps/api/src/cors.config.ts` records it as retired — *"we do NOT use any ENV VARS for CORS values declaration"*; `TenantAllowedOrigin` is the sole source of truth. The remaining reference is the comment explaining the retirement. ⚠️ Worth deleting on presentation grounds alone: a key literally reading `CORS_ALLOWED_ORIGINS: "*"` in a PHI platform's ConfigMap looks like wide-open CORS to anyone auditing it |
| `GUARDRAIL_PORT` | `8863` | **Dead — prefix mismatch.** guardrail's root `Settings` uses the `GUARDRAIL_V2_` prefix, so it reads `GUARDRAIL_V2_PORT`. That variable is set as a literal `env:` entry in `guardrail.yaml`, so the service is correctly configured and this ConfigMap key is simply never consulted |
| `API_PORT` | `8868` | **Dead.** No non-test reader in `apps/api`; the gateway's own port arrives another way |
| `STT_V2_PORT` | `8861` | **Dead.** No source reference anywhere, in either repo |

None is load-bearing; all four can be deleted. Doing so is independent of the split.

## 6. Known blind spot — read this before trusting a "no consumer" result

The TypeScript side finds only literal `process.env.NAME` reads. A key consumed through an indirection — a config service, a destructured env object, a computed key — is invisible to it.

**This is not hypothetical.** `CORS_ALLOWED_ORIGINS` is referenced in `apps/api/src/cors.config.ts` but never as `process.env.CORS_ALLOWED_ORIGINS`; the first pass reported it as unread, and only a grep of the bare key revealed the reference (which then turned out to be a comment — the conclusion held, but by luck, not by method).

So: treat a TS "no consumer" as **"no literal read found"**, and confirm with a bare-key grep before deleting anything. The Python side has no such gap — pydantic is asked directly.

## 7. What this unblocks, and what still gates E4.1

**Unblocked**: the key→service ownership map above is exactly the input E4.1 needs. The split can now be authored against data rather than guessed.

**Still gating** — one piece of verification does not exist yet. Once keys move into per-service maps, nothing checks that a service's map still provides every key that service reads. `check-config-refs.py` covers explicit refs only. The options:

1. **Promote to explicit refs.** Every key a service genuinely requires becomes a non-optional `configMapKeyRef`, and `check-config-refs.py` covers it automatically — the route already taken for `HARNESS_API_BASE_URL` and `SMR_GATEWAY_URL` (E6.3). Verbose, but the failure mode becomes loud and CI-visible.
2. **A new `envFrom` coverage check** that renders each workload, resolves which generated map it consumes, and asserts the intersection with this inventory is complete. Keeps `envFrom` brevity; needs this inventory committed as a machine-readable artifact and kept current (a `--check` mode, like `pnpm env:sync --check`).

Option 1 is stronger for the small set of keys whose absence is fatal; option 2 scales better for tuning knobs with safe defaults. E4.2's existing decision rule already draws that line — this inventory just makes it applicable per key.
