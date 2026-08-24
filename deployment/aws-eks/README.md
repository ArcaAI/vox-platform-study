# AWS EKS — ConfigMap and Secret source files

Working artifacts extracted from the **live k3s `hope-v2-dev` namespace**
(cluster `c-nfhxq`) on 2026-08-24, restructured for the AWS EKS migration
described in `arca/hope-v2-deployment` → `docs/aws-eks/`.

Authoritative deployment manifests still live in **`arca/hope-v2-deployment`**.
These files are the input for that repo's AWS overlay, not a second source of truth.

## Layout

```
configmaps/          7 env files + a kustomization that generates the hashed maps
secrets/             Secrets Manager payload templates + the ESO wiring
```

## ConfigMaps

| File | Generated map | Consumers |
|---|---|---|
| `platform.env` | `hope-platform-config` | api, smr, nlp, tts, stt, harness, admin-console |
| `api.env` | `hope-api-config` | hope-api |
| `stt.env` | `hope-stt-config` | hope-stt-v2, hope-stt-v2-worker |
| `smr.env` | `hope-smr-config` | hope-smr |
| `harness.env` | `hope-harness-config` | hope-harness, hope-harness-worker |
| `qdrant.env` | `hope-qdrant-config` | hope-qdrant |
| `admin-console.env` | `hope-admin-console-config` | hope-admin-console |

Values are the **effective dev** state — base plus the `overlays/dev` merges,
which are marked with a comment block in each file. When splitting these back
into base + overlay, everything under `--- dev overlay overrides ---` belongs in
the overlay's `configMapGenerator` with `behavior: merge`.

Six further ConfigMaps in the namespace are not represented here because they are
already whole files in the deployment repo, not key/value config:
`observability-config`, `prometheus-alert-rules`, `alertmanager-config`,
`alloy-logs-config`, `hope-vault-config`, `grafana-dashboards`.
(`kube-root-ca.crt` is injected by Kubernetes.)

## Secrets

Grouped into the three Secrets Manager secrets defined in
`docs/aws-eks/02-kms-and-secrets.md` §4.2, so an ESO refresh has a small blast
radius and mirrors the ConfigMap split:

| Secret | Template | Contents |
|---|---|---|
| `hope/${ENV}/platform` | `hope-platform.template.json` | Bootstrap floor — DB, Redis, Vault AppRole, session/JWT keys |
| `hope/${ENV}/services` | `hope-services.template.json` | Internal service tokens, Qdrant keys, Grafana admin |
| `hope/${ENV}/providers` | `hope-providers.template.json` | Azure / HF / Sarvam credentials, Temporal DB identity |

Workflow:

```bash
cd secrets
./generate-values.sh                       # fresh values for every __GENERATE_*__

mkdir -p ~/hope-secrets-dev                # a working copy OUTSIDE this repo
cp hope-*.template.json ~/hope-secrets-dev/
for f in ~/hope-secrets-dev/*.template.json; do mv "$f" "${f/.template/}"; done
# ...fill every __PLACEHOLDER__...

ENV=dev AWS_REGION=ap-southeast-1 SRC=~/hope-secrets-dev ./provision.sh
kubectl apply -f external-secret.yaml      # after ${ENV}/${AWS_REGION} substitution
```

`provision.sh` refuses to upload a file that still contains a placeholder, and
strips the `_comment` key before upload. `.gitignore` blocks the filled copies;
`gitleaks` is the backstop.

## Deltas from the live k3s Secret — read before cutover

The live `hope-secrets` has 31 keys. The three templates carry 31 as well, but
they are **not the same 31**:

**Dropped deliberately**

| Key | Why |
|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Superseded by `DATABASE_URL`/`DIRECT_URL`. On k3s these carry the **superuser** password; on RDS the app must use a non-master role so the 90-day rotation lambda needs no coordinated restart. |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | Replaced by S3 + IRSA + `TenantStorageConfig` (`docs/aws-eks/03-database.md` §6). Keep them only until that row is verified. |
| `VAULT_TOKEN` | A long-lived root-equivalent token in an env var. AppRole (`VAULT_ROLE_ID`/`VAULT_SECRET_ID`) is the trust model; prod should use response-wrapped, single-use secret IDs. |

**Added — required but missing on k3s today**

| Key | Why |
|---|---|
| `DIRECT_URL` | Un-pooled connection for migrations. `DATABASE_URL` goes through PgBouncer/RDS Proxy in transaction mode, which migrations cannot use. |
| `HARNESS_INTERNAL_SERVICE_TOKEN` | Declared **required** by `hope-harness-worker`. Missing → `CreateContainerConfigError`, not a clean error. |
| `GUARDRAIL_SERVICE_TOKEN` | Guardrail's inbound `X-Service-Token` middleware. |
| `QDRANT_API_KEY`, `QDRANT_READ_ONLY_API_KEY` | `QDRANT__SERVICE__JWT_RBAC=true` is already set in `qdrant.env`, so RBAC is on and expects keys. |
| `GRAFANA_ADMIN_PASSWORD`, `TTS_SARVAM_API_KEY` | Per `docs/aws-eks/02` §4.2. |

**Broken on k3s today — do not carry forward**

- `SESSION_SECRET_KEY` is literally `<REPLACE_WITH_DEV_SESSION_SECRET>`.
- `SMR_V2_SERVICE_TOKEN` is the empty string, which puts the `X-Service-Token`
  middleware into dev-bypass mode.
- `HF_TOKEN` and `HUGGINGFACE_TOKEN` hold the same value; keep both keys only
  while both consumers still read their own spelling.

**Every value currently in `hope-secrets` must be treated as compromised.**
The `last-applied-configuration` annotation on that Secret exposes all of them in
plaintext to anyone with `get secret` in the namespace. Cutover is the natural
moment to rotate rather than copy.

## Not covered here

`hope-registry-creds` (imagePullSecret) becomes an ECR pull via the node role on
EKS. `hope-registry-credsf` looks like a typo'd duplicate — confirm nothing
references it, then delete it from the k3s namespace.
