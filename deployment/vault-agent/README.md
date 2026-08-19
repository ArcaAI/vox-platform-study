# Vault Agent injection — the pod-level secret contract

TASK-558 §13.2 (P1/P2/P6/P7) and §9.2 L7. This directory holds the **contract**,
not a deployment topology (see [`../README.md`](../README.md) for why).

| File                        | Purpose                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `reference-deployment.yaml` | One complete, annotated Deployment showing every required annotation. Copy the shape, swap the secret list.      |
| `kustomization.yaml`        | Makes the reference manifest buildable so it cannot rot: `kubectl kustomize deployment/vault-agent`.             |
| `check-contract.sh`         | Asserts the contract on any rendered manifest set — including a `helm template` of the `arca/hope-v2-deployment` chart. |

## Why Vault Agent and not External Secrets Operator

ESO is simpler to run: it reconciles a `SecretStore` into ordinary Kubernetes
`Secret` objects, and pods consume them with `envFrom`. That last step is exactly
the problem. A `Secret` object is base64, not encryption — its plaintext lives in
etcd, is visible to anything with `get secrets` in the namespace, appears in
`kubectl describe`-adjacent tooling and backups, and outlives the pod that needed
it. For a platform holding PHI that already runs Vault HA with AppRole and dynamic
database credentials, that is a strictly weaker posture than the one already paid
for.

With agent injection the secret never becomes a Kubernetes object at all: the
sidecar authenticates as the pod's ServiceAccount, renders the value into a
memory-backed `emptyDir` shared only with that pod, renews leases, and re-renders
on rotation. ESO remains acceptable for non-PHI, periodically-rotated values —
nothing in HOPE currently qualifies.

## The contract

```
one file per secret        /vault/secrets/<ENV_VAR_NAME>
file content               the raw value, no trailing newline
directory                  /vault/secrets  (injector default, emptyDir{medium: Memory})
pod env                    HOPE_SECRETS_DIR=/vault/secrets
kv-v2 path                 secret/data/hope/<ENV_VAR_NAME>, field `value`
```

The filename **is** the environment variable name. `packages/py-env` points
pydantic's `SecretsSettingsSource` at `HOPE_SECRETS_DIR`, and pydantic matches
files to fields by name — so `GUARDRAIL_SERVICE_TOKEN` is a field that resolves,
`guardrail-token` is a file nobody reads.

Source order (§13.2 P3, implemented once in `hope_env`):

```
init  >  host env  >  secrets_dir (Vault Agent)  >  .env.<NODE_ENV>  >  field default
```

The Vault file beats the dotenv deliberately: pydantic-settings' own default order
puts dotenv above `file_secret`, which would let a stale checked-out `.env` outrank
a freshly rotated secret.

### Three details that silently break it

1. **File ownership.** The injector defaults to uid 100 and mode 0640. Application
   containers run as uid/gid 1001 (`hope`, `infrastructure/docker/python-base/Dockerfile:48`).
   Without `agent-run-as-user: "1001"` the app reads nothing and the symptom looks
   like an unseeded secret. Set the agent's uid; do not widen the file mode.
2. **Trailing newline.** An untrimmed template (`{{ ... }}` instead of `{{- ... -}}`)
   appends `\n` to the value. A service token then fails every `hmac.compare_digest`
   and the 401 looks like a wrong secret rather than a wrong file.
3. **Sidecar vs. init-only.** `agent-pre-populate-only: "true"` renders once and
   exits, so a rotated secret never reaches a running pod. Keep the sidecar — it is
   what gives §13.2 P6's `reload_secrets()` something new to read.

## Per-service secret sets

Every name is a `vault-kv` descriptor in
`packages/applications/src/services/settings-registry/descriptors/platform-secrets.descriptors.ts`,
rendered through `toEnvVarName()`. Do not add a secret here that has no descriptor —
`scripts/vault-seed-secrets.sh` derives its seed list from the same source, so an
undeclared name would never be written to Vault.

| Workload                           | Vault role       | Injected secrets                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hope-api` (gateway)               | `hope-api`       | `JWT_SECRET_KEY`, `SESSION_SECRET_KEY`, `API_KEY_PEPPER`, `OIDC_CLIENT_SECRET`, `REDIS_PASS`, `MQTT_PASS`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `TEXT_SERVICE_TOKEN`, `NLP_SERVICE_TOKEN`, `GUARDRAIL_SERVICE_TOKEN`, `HARNESS_SERVICE_TOKEN`, `TTS_SERVICE_TOKEN`, `API_GATEWAY_KEY` |
| `hope-smr`                         | `hope-smr`       | `TEXT_SERVICE_TOKEN`, `REDIS_PASS` (TASK-602: Azure/OpenAI/Anthropic keys are BYOK-only — db-secret, not Vault-kv)                                                                                                                                                                                                          |
| `hope-guardrail`                   | `hope-guardrail` | `GUARDRAIL_SERVICE_TOKEN`, `REDIS_PASS`                                                                                                                                                                                                                                                         |
| `hope-nlp`                         | `hope-nlp`       | `NLP_SERVICE_TOKEN`                                                                                                                                                                                                                                                                                                       |
| `hope-harness` (+ Temporal worker) | `hope-harness`   | `HARNESS_SERVICE_TOKEN`, `HARNESS_JUDGE_OPENAI_COMPAT_API_KEY`, `HARNESS_CLAIM_CHECK_ACCESS_KEY`, `HARNESS_CLAIM_CHECK_SECRET_KEY`                                                                                                                                                                                        |
| `hope-tts`                         | `hope-tts`       | `TTS_SERVICE_TOKEN` (TASK-602: Sarvam + Azure Speech keys are BYOK-only — db-secret, not Vault-kv)                                                                                                                                                                                                                        |
| `hope-stt` (+ worker)              | `hope-stt`       | `API_GATEWAY_KEY`, `AZURE_FOUNDRY_API_KEY` (TASK-602: AZURE_SPEECH_KEY is BYOK-only — db-secret, not Vault-kv; Foundry preview key retained)                                                                                                                                                                               |

The gateway holds the superset because it both issues and verifies the
service-token hop in each direction. `API_GATEWAY_KEY` (not `STT_SERVICE_TOKEN` —
there is no such secret) is STT's credential; it authenticates with
`X-Internal-Service-Key`.

The matching Vault policies are
`infrastructure/docker/configs/vault/policies/k8s/hope-<service>.hcl`; the same
files are loaded by the dev bootstrap so dev and cluster differ in transport, not
in layout.

## Helm equivalent

The `arca/hope-v2-deployment` chart takes the same annotations under `podAnnotations`:

```yaml
podAnnotations:
  vault.hashicorp.com/agent-inject: 'true'
  vault.hashicorp.com/auth-path: 'auth/kubernetes'
  vault.hashicorp.com/role: 'hope-guardrail'
  vault.hashicorp.com/agent-pre-populate-only: 'false'
  vault.hashicorp.com/agent-run-as-user: '1001'
  vault.hashicorp.com/agent-run-as-group: '1001'
  vault.hashicorp.com/agent-inject-token: 'false'
  vault.hashicorp.com/secret-volume-path: '/vault/secrets'
  vault.hashicorp.com/agent-inject-secret-GUARDRAIL_SERVICE_TOKEN: 'secret/data/hope/GUARDRAIL_SERVICE_TOKEN'
  vault.hashicorp.com/agent-inject-template-GUARDRAIL_SERVICE_TOKEN: |
    {{- with secret "secret/data/hope/GUARDRAIL_SERVICE_TOKEN" -}}{{ .Data.data.value }}{{- end -}}
env:
  - name: HOPE_SECRETS_DIR
    value: /vault/secrets
```

In a Helm chart the Vault template delimiters collide with Go template
delimiters — wrap the annotation value in `{{` `` `...` `` `}}` or a `.Values`
string, and verify the render with:

```bash
helm template <chart> | deployment/vault-agent/check-contract.sh -
```

## Verifying

```bash
kubectl kustomize deployment/vault-agent            # builds
deployment/vault-agent/check-contract.sh            # contract assertions
```

`kubectl apply --dry-run=client` is NOT usable offline: it resolves REST mappings
against a live API server and fails with `couldn't get current server API group
list` when none is reachable. Use the two commands above, plus a real
`--dry-run=server` once a cluster is in reach.
