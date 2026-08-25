# TASK-804 — STT gateway credential drift + release-registry tenant context

| | |
|---|---|
| **Status** | Completed (code + dev cluster) · gateway fix awaits a build/promote |
| **Type** | bugfix (infrastructure + application) |
| **Branch** | `dev-2.2` |
| **Reported** | 2026-08-25 — "cannot start live transcription", `502 Bad Gateway` |
| **Repos touched** | `hope-v2` (code, this ticket) · `hope-v2-deployment` (template + runbook) |

---

## 1. Requirement Analysis

Two independent defects, found while tracing one symptom.

**D-1 — live transcription returns 502.** `POST /api/hope/audio/transcription-jobs/stream/session`
(admin-console BFF → gateway → STT) failed for every attempt.

**D-2 — every service's release registration 500s.** Found in the same log sweep:
`POST /api/v1/internal/service-releases` had been failing every 5 minutes on
`TenantScope: tenant context required for model ServiceRelease operation findMany`.
Unrelated to D-1 in cause, but it is why the release registry is empty.

---

## 2. Current State Evaluation

### D-1 — the chain (each hop concealed the next)

| Hop | Evidence |
|---|---|
| Browser / BFF | `502 Bad Gateway` |
| `hope-api` | `downstreamFailureKind: upstream_server_error`, `upstreamStatus: 500`, `capability: Transcription` |
| `hope-stt` | `POST /internal/streaming/sessions` → 500, `Failed to create session, rolling back` |
| `hope-stt` | `stt.model_credentials.resolve_failed provider=huggingface error_type=HTTPStatusError` |
| `hope-api` | **nothing** — a 401 on `/internal/*` produces no request-failure log line |

Reproduced inside the STT pod:

```
GET http://hope-api:8868/api/v1/internal/stt/model-registry-credential?provider=huggingface&tenantId=…
→ 401 {"message":"Invalid API key"}
```

**Root cause.** `API_GATEWAY_KEY` is not a free-form shared secret: BUG-013 requires it
to be the RAW value of an ACTIVE `SERVICE_ACCOUNT` row in `core."ApiKey"`, validated by
hash. `hope-secrets` carried a hand-minted key (`hope_sk_fa2c12…`) that no seed creates.
The dev database was re-seeded **2026-08-24 19:06** — the table now holds only the ten
seed rows, none with that prefix — while the Secret kept the stale value.

The 401 is then fatal by design: `stt/core/model_credentials.py` maps any fault to
`UNAVAILABLE` and **fails closed**, because treating a fault as "no credential
configured" would silently downgrade an entitled model pull to an anonymous one.
Correct posture; it just had nothing to say about *why*.

Not the cause: the HuggingFace fetch itself was working (a 302 to the silero-vad
weights succeeded seconds earlier).

### D-2 — the release registry could never write

`ServiceRelease` / `ServiceInstance` are in `TENANT_SCOPED_MODELS`, whose Prisma
extension fails closed without a tenant CLS context. **Neither writer supplies one:**

- the internal HTTP route is `@Public()` + `ServiceReleaseTokenGuard`, so no guard ever
  populates CLS `tenantId` — a service token identifies a *process*, not a tenant;
- the gateway registers **itself in-process** from `startServiceReleaseRegistration`,
  outside any HTTP request, so there is no CLS context at all.

So every boot registration and every 5-minute heartbeat 500'd — and the gateway's own
failed *silently*, because its registration is deliberately best-effort
(`registerOnce` swallows everything). The registry that exists to answer "what version
is running" could never record anything.

---

## 3. Implementation Plan

1. **D-2 (code, TDD)** — pin the two WRITE paths to the SYSTEM tenant. Read paths stay
   unpinned: they run under the caller's CLS and reach these rows through
   `SYSTEM_SHARED_READ_MODELS` widening.
2. **D-1 (dev cluster)** — repoint `hope-secrets.API_GATEWAY_KEY` at the **seeded**
   service-account key, which `seed/02-apikey.ts` recreates on every seed run and which
   therefore survives the next re-seed. Roll `hope-stt` + `hope-stt-worker`.
3. **D-1 (deployment repo)** — the template said `API_GATEWAY_KEY: "gateway_key"`, which
   is what invited a hand-minted value in the first place. Document the real contract and
   the failure mode.

---

## 4. Implementation Summary

### Code — `hope-v2`

| File | Change |
|---|---|
| `packages/applications/src/services/serviceRelease/serviceRelease.service.ts` | `registerInstance` / `attachDigest` delegate to `*Scoped` bodies wrapped in a new `runAsSystemTenant()` helper |
| `packages/applications/src/services/serviceRelease/__tests__/service-release.service.test.ts` | 3 new tests + `isActive`/`run` on the CLS mock |

`runAsSystemTenant` pins an **active** context in place (`cls.set`) rather than opening a
nested `cls.run`, so the global CLS middleware's `requestId`/`correlationId` survive on
the HTTP path; it only opens a context when there is none (the in-process boot path).
The pin is not a widening — it re-states the tenant the factories already stamp.

### Dev cluster — `hope-v2` namespace `hope-v2-dev`

- `hope-secrets.API_GATEWAY_KEY`: `hope_sk_fa2c12…` → `hope_sa_test_d9f0…` (seeded
  `SERVICE_ACCOUNT`, scope `internal:stt:worker`).
  **Old value preserved** in the Secret's `last-applied-configuration` annotation.
- `hope-stt` + `hope-stt-worker` restarted.

### Deployment repo — `hope-v2-deployment`

| File | Change |
|---|---|
| `deployment/secrets.dev.yaml.example` | `API_GATEWAY_KEY` documented as a DB-backed credential, with the dev value, the staging/prod path, and the failure mode |
| `docs/deployment-runbook.md` | new **§12.1** — symptom → chain → cause → 10-second probe → fix per environment; open-items rows 16 and 17 |

---

## 5. Verification

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/applications test` | **RED first** (3 failing), then 10158 passed |
| `pnpm test:unit` (repo-wide) | **20569 passed**, 4 skipped, 9 todo — exit 0 |
| `pnpm --filter @arcaai/applications build` / `typecheck` | clean |
| `pnpm --filter @arcaai/applications lint` | 0 errors; no finding in the touched files (223 pre-existing warnings elsewhere) |
| `apps/api` build | `pnpm run build` in `apps/api` exits **0**. Via turbo (`pnpm api:build`) it fails with `ENOTEMPTY … rmdir dist/modules/*` — a `rimraf`/emit race on this machine, reproducible with **zero** working-tree changes under `apps/api`. Environmental, not this change. |

Live verification in the dev cluster, on the user's exact pipeline
(`81000000-0000-0000-0001-000000000118`, tenant `50000000-…0001`):

```
# credential resolution (was: HTTP 401 Invalid API key)
OK b'{"outcome":"absent"}'          # "no tier has an opinion → fetch anonymously" = correct for a public repo

# session creation (was: 500 → 502)
POST /internal/streaming/sessions
OK {"session_id":"19b034a5-…","status":"active","pipeline_id":"81000000-0000-0000-0001-000000000118","active_engine":"primary"}
```

The test session was deleted afterwards.

---

## 6. Residual Risk / Follow-ups

1. **The D-2 code fix is NOT in the cluster.** It needs a `hope-api` image build and a
   digest promote. Until then `service_registration.rejected` continues — cosmetic
   (registry telemetry only), no user-facing impact.
2. **Nothing detects this class of drift.** `check-config-refs.py` proves a `secretKeyRef`
   *exists*; it cannot know this value must also resolve to a live DB row. A post-seed
   smoke check running the §12.1 probe would have caught D-1 in seconds.
3. **A 401 on `/internal/*` is not logged by the gateway** — the reason the STT log was
   the only witness. Worth a deliberate warn-level line.
4. **`hope-secrets` is behind the TASK-803 rename** (out of scope, flagged as runbook
   open item 17): still carries `SMR_SERVICE_TOKEN` / `SMR_V2_SERVICE_TOKEN`, and has no
   `INTERNAL_ACCESS_TOKEN`, `TEXT_SERVICE_TOKEN`, `HARNESS_INTERNAL_SERVICE_TOKEN`,
   `GUARDRAIL_SERVICE_TOKEN` or `GRAFANA_ADMIN_PASSWORD` — so every internal hop is in
   `X-Service-Token` dev-bypass and Grafana is on its default admin password.
5. **The cleartext-annotation leak is confirmed real** (runbook §12 open item 8): the
   `last-applied-configuration` annotation exposes every value, including the Postgres
   superuser password and `VAULT_TOKEN`. Unchanged by this ticket; still needs rotation.

---

## 7. Change History

| Date | Change |
|---|---|
| 2026-08-25 | Ticket opened from a 502 report; D-1 and D-2 diagnosed, fixed and verified |
