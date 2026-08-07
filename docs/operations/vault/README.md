# HOPE Vault — Operator Runbook (k3s deployment)

> ## ⚠️ Check which Vault you are looking at before running anything here
>
> This page targets the **k3s/Helm** Vault — `kubectl exec`, pods `vault-0..2`, namespace
> `vault-system`. That deployment was designed and `kind`-tested but **never deployed**.
>
> The Vault **actually running as of 2026-08-07** is a 3-node Raft cluster on **Proxmox VMs
> 430-432**, with a Transit seal-Vault on **VM 434**, in Docker on Alpine. Its commands are
> completely different and root SSH is disabled on those hosts.
>
> **For seal / unseal / auto-unseal — and especially for recovering after a Proxmox host
> restart — use [`vm-cluster-seal-unseal.md`](./vm-cluster-seal-unseal.md).**
>
> The sections below on rotation, GitLab OIDC, Kubernetes auth and audit retention remain
> valid as *design* references, but every `kubectl`/`vex` invocation must be translated to
> `qm guest exec` + `docker exec` for the VM cluster.

> On-call reference for the HOPE HA Vault cluster (TASK-312). Goal: respond to any
> Vault incident in **< 30 min** using this page alone. Deployment artifacts and
> their design rationale live in
> [`infrastructure/single-deployment/vault/README.md`](../../../infrastructure/single-deployment/vault/README.md);
> this page is the **operational** companion (day-2: rotate, fail over, recover, monitor).

HOPE runs Vault **only on self-hosted Proxmox k3s** (cloud Terraform was descoped —
see TASK-312). All commands assume `kubectl` is pointed at the k3s cluster.

---

## Architecture at a glance

| Piece | What | Where |
|---|---|---|
| HA Vault | 3-node Raft (integrated storage), pods `vault-0..2` | ns `vault-system`, labels `app.kubernetes.io/name=vault,component=server` |
| Seal Vault | single node providing **Transit auto-unseal** for the HA cluster | pod `vault-seal-0`, StatefulSet/Service `vault-seal` |
| App auth | AppRole `hope-app` + agent-injector delivers secrets to API pods | ns `hope` |
| Workload auth | Kubernetes auth (`auth/kubernetes`), one role + one policy per service | policies: `infrastructure/docker/configs/vault/policies/k8s/hope-*.hcl` |
| CI auth | GitLab OIDC → JWT auth (`auth/jwt-gitlab`), roles `hope-ci` / `hope-ci-deploy` | policies: `.../policies/hope-ci{,-deploy}.hcl`; job wiring `.gitlab/ci/vault.yml` |
| Recovery keys | 5/3 recovery keys + (revoked) root, from `vault operator init` | Secret `vault-system/vault-init-keys` → **move offline** |
| Transit token | seal Vault token the HA nodes use to auto-unseal | Secret `vault-system/vault-seal-transit` |
| App creds | `role_id` + single-use `wrapped_secret_id` | Secret `hope/hope-vault-approle` |
| Issuer token | narrow token that mints new `secret_id`s (no root) | Secret `hope/hope-vault-approle-issuer` |

Auto-unseal chain: **HA node boots → asks seal Vault Transit to decrypt its root key → unseals.**
If the seal Vault is **down or sealed**, every HA node stays sealed. That is the
single most important fact on this page.

Unauthenticated health (works even after the root token is revoked):

```bash
for p in vault-0 vault-1 vault-2; do
  echo "== $p =="; kubectl -n vault-system exec -c vault "$p" -- vault status | grep -E 'Sealed|HA Mode|Raft'
done
```

---

## Bootstrap (Proxmox k3s)

Full procedure + flags: see the infra README. Order (run once):

1. `kubectl apply -k infrastructure/single-deployment/vault/seal-vault/` (digest-pinned; `-f .../seal-vault.yaml` for unpinned/E2E)
2. `infrastructure/single-deployment/vault/seal-vault/seal-bootstrap.sh` — init+unseal seal Vault, enable Transit, write `vault-seal-transit`. **Store the printed Shamir keys offline (5/3).**
3. `helm upgrade --install vault hashicorp/vault --version 0.32.0 -n vault-system -f helm/values.yaml -f manifests/audit-sidecar.values.yaml -f helm/values.digests.yaml`
4. `kubectl apply -k infrastructure/single-deployment/vault/bootstrap/` — `operator init` (recovery 5/3), store keys, enable audit (digest-pinned; `-f .../init-job.yaml` for unpinned/E2E).
5. `kubectl apply -f infrastructure/single-deployment/vault/manifests/` — NetworkPolicies + ServiceMonitor.
6. `infrastructure/single-deployment/vault/bootstrap/configure-app-auth.sh` — KV-v2 + Transit + AppRole + issuer token.
7. **Verify** (next section), move recovery keys offline, then **revoke the root token** (infra README → "Root token lifecycle").
8. `kubectl apply -f infrastructure/single-deployment/vault/monitoring/recording-rules.yaml -f .../monitoring/alerts.yaml` and import `monitoring/grafana-dashboard.json`.

---

## Privileged commands (`vex` helper)

Most day-2 commands below (raft, leases, KV writes, step-down) need a token. The root
token is **revoked** post-bootstrap, so mint a temporary one from the offline recovery
keys (see [Privileged access after root revocation](#emergency-unseal-quorum-lost)),
then paste this helper **once**. It streams the token over **stdin**, so the token
never appears in the pod's `ps`/argv:

```bash
export VAULT_TOKEN=<token-from-generate-root>
vex() { p="$1"; shift; printf '%s\n' "$VAULT_TOKEN" \
  | kubectl -n vault-system exec -i -c vault "$p" -- \
    sh -ec 'IFS= read -r VAULT_TOKEN; export VAULT_TOKEN VAULT_ADDR=http://127.0.0.1:8200; exec "$@"' _ "$@"; }
# usage: vex vault-0 vault operator raft list-peers
```

When `VAULT_TOKEN` expires, re-mint with generate-root and re-export. Read-only health
(`vault status`) needs **no** token — use the loops as written.

---

## Daily ops

```bash
# 1. Cluster health — all unsealed, exactly one active leader
for p in vault-0 vault-1 vault-2; do kubectl -n vault-system exec -c vault "$p" -- vault status | grep -E 'Sealed|HA Mode'; done

# 2. Raft peers + autopilot (needs a token via the vex helper above)
vex vault-0 vault operator raft list-peers
vex vault-0 vault operator raft autopilot state

# 3. Audit log tail (also streamed to stdout by the audit-log-shipper sidecar → Loki)
kubectl -n vault-system exec -c vault vault-0 -- tail -n 50 /vault/audit/vault-audit.log

# 4. Leases / tokens in flight
vex vault-0 vault read sys/leases/count
```

Dashboards + alerts: see [Alerting & dashboards](#alerting--dashboards). Green
baseline = 3 unsealed nodes, 1 leader, `vault_autopilot_healthy=1`, 0 audit failures.

---

## Secret & credential rotation

**KV-v2 application secrets** (e.g. `SESSION_SECRET_KEY`): write a new version; the
API picks it up on its next cache refresh / restart.

```bash
vex vault-0 vault kv put secret/hope/<key> value=<new>
```

### Rotating a platform secret end to end (TASK-558 lane K)

The full procedure, for a secret that both the TypeScript gateway and a Python
service consume — `GUARDRAIL_SERVICE_TOKEN` is the worked example because it is
a *shared* secret and therefore the one where a half-rotation causes 401s.

The layout is fixed everywhere: `secret/data/hope/<ENV_VAR_NAME>`, field `value`.
Dev, CI and cluster differ only in **transport** (HTTP client / rendered file), and
the name is always the descriptor key from
`packages/applications/src/services/settings-registry/descriptors/platform-secrets.descriptors.ts`
run through `toEnvVarName()`. If a name is not a `vault-kv` descriptor,
`scripts/vault-seed-secrets.sh` will never write it and nothing will read it.

```bash
# 0. Confirm the name is a registered vault-kv descriptor (fails loudly if not).
pnpm --filter @arcaai/applications build
./scripts/vault-seed-secrets.sh --dry-run --only GUARDRAIL_SERVICE_TOKEN --allow-non-dev

# 1. Write the NEW value as a new kv-v2 version. Prior versions stay readable,
#    which is what makes an overlap possible (and is mandatory for API_KEY_PEPPER).
printf '%s' "$NEW_VALUE" | vex vault-0 vault kv put secret/hope/GUARDRAIL_SERVICE_TOKEN value=-

# 2. Confirm both sides see the same version.
vex vault-0 vault kv metadata get secret/hope/GUARDRAIL_SERVICE_TOKEN | grep -E 'current_version'

# 3. Consumers converge:
#    - TypeScript gateway: SecretsService publishes on `arca:secrets:invalidate`;
#      every node drops its cache entry. TTL is the backstop, not the mechanism.
#        vex vault-0 vault kv get -field=value secret/hope/GUARDRAIL_SERVICE_TOKEN >/dev/null
#    - Python services: the Vault Agent sidecar re-renders
#      /vault/secrets/GUARDRAIL_SERVICE_TOKEN in place. A settings object built
#      once at startup keeps the OLD value — trigger the service's
#      `reload_secrets()` (§13.2 P6) or roll the deployment:
kubectl -n hope rollout restart deploy/hope-guardrail deploy/hope-api

# 4. Verify no 401s on the hop that uses it.
kubectl -n hope logs deploy/hope-guardrail --since=5m | grep -i 'service_token\|401' || echo "clean"
```

**Both ends must move together.** `GUARDRAIL_SERVICE_TOKEN` is presented by the
gateway *and* verified by guardrail; rotating one side alone is an outage on that
hop. `API_KEY_PEPPER` is the opposite problem — it must be rotated with a
**staged overlap** (verify against the `keyVersion` recorded on each `ApiKey`
row), never swapped, or every issued API key dies at once. See §9.2 L6 / the
descriptor's own `description` field.

**Never** rotate by editing a `.env` file: since TASK-558 the committed env files
carry placeholders only, and a value that must change without a restart is by
definition not an env var (§9.2 L1).

**AppRole `secret_id` (per (re)deploy — NO root needed)** — uses the narrow issuer token:

```bash
APP_NS=hope infrastructure/single-deployment/vault/bootstrap/rotate-secret-id.sh
kubectl -n hope rollout restart deploy/<api-deploy>   # consume the fresh wrapped secret_id
```

**AppRole token** — the API auto-renews it at 50% TTL (TASK-312 Phase B). No action
unless `VaultAppSecretsDegraded` fires (then check Vault reachability).

**Dynamic DB credentials** — issued + auto-renewed per app instance via
`database/creds/hope-app-role`; leases auto-revoke on shutdown. To force-rotate the
DB **root** the engine uses: `vault write -f database/rotate-root/<conn>`.

`hope-app-role` has two TTLs (BUG-006 follow-up, 2026-07-13):

| TTL | Value | Meaning |
|---|---|---|
| `default_ttl` | `1h` (all envs) | Lease duration `VaultLeaseRenewer` (`apps/api/src/vault-prisma.module.ts`) renews at 50% via `sys/leases/renew` — cheap, frequent Vault round-trips, matches Vault-native rotation practice |
| `max_ttl` | dev `168h` (7d) / prod `720h` (30d) | Hard ceiling from lease ISSUE time (does not reset on renewal). Once elapsed time nears this ceiling (within `min(300s, 25% of max_ttl)`), the renewer stops renewing and force-rotates the PG role instead: `wrapper.swap()` drops the old dynamic user and mints a fresh one |

Widening `max_ttl` (previously `24h` everywhere, pre-BUG-006) trades a longer
compromised-credential blast-radius window for far fewer forced pool-swap /
`DROP ROLE` events — deliberate for dev convenience and prod connection-pool
stability. If a credential is suspected compromised, don't wait for
`max_ttl`: `vault lease revoke database/creds/hope-app-role/<lease-id>` kills
it immediately (the app's next query fails and the renewer's swap fallback
recovers on its next tick — see `apps/api/src/vault-prisma.module.ts`'s
`renew` callback).

**Dev** — set by TWO scripts that MUST stay in sync (`vault write
database/roles/hope-app-role ... default_ttl=1h max_ttl=168h ...`):
`scripts/setup-dev-vault-db.sh` (manual re-apply / `pnpm setup:dev`) and
`infrastructure/docker/configs/vault/dev-init.sh` (the `vault-init` sidecar,
runs automatically on `./scripts/start-infra.sh --all`). `.env.dev` sets
`PG_VAULT_MAX_TTL_SEC=604800` (7d in seconds) to match.

**Production** — there is currently NO in-repo script that provisions this
role (unlike dev); `infrastructure/single-deployment/vault/bootstrap/` only
configures kv-v2/transit/AppRole, and `deployment/` (k3s+ArgoCD) only wires
env vars. Provision it manually once per prod Vault, then keep
`apps/api/.env.prod`'s `PG_VAULT_MAX_TTL_SEC=2592000` (30d in seconds)
in sync with whatever `max_ttl` you set below:

```bash
vault write database/config/hope-main \
  plugin_name=postgresql-database-plugin \
  allowed_roles="hope-app-role" \
  connection_url="postgresql://{{username}}:{{password}}@<prod-pg-host>:5432/hope_main?sslmode=require" \
  username="<vault_admin>" \
  password="<vault_admin_password>"
vault write database/roles/hope-app-role \
  db_name=hope-main \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' INHERIT IN ROLE hope_app_template;" \
  revocation_statements="REVOKE ALL PRIVILEGES ON DATABASE hope_main FROM \"{{name}}\"; REASSIGN OWNED BY \"{{name}}\" TO hope_app_template; DROP OWNED BY \"{{name}}\"; DROP ROLE IF EXISTS \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="720h" \
  max_open_connections=50
```

If `PG_VAULT_MAX_TTL_SEC` is ever unset or drifts out of sync with the real
Vault `max_ttl`, the app falls back to a conservative 24h — safe (it just
swaps more often than strictly necessary) but not silent: watch for
unexpectedly frequent `Vault DB lease pool swapped` log lines.

**Transit key rotation** (`hope-globalsetting`): `vault write -f transit/keys/hope-globalsetting/rotate`.
Transit auto-decrypts old ciphertext with prior key versions, so this is
zero-downtime; optionally `rewrap` historical ciphertext afterwards.

---

## GitLab CI → Vault (OIDC)

TASK-558 §13.3. No long-lived `VAULT_TOKEN` in GitLab project settings: each job
that needs a secret presents a short-lived, job-scoped GitLab ID token, and Vault's
JWT auth method decides what it may read from the token's own claims.

**This GitLab is Free tier**, verified 2026-07-26 against `https://git.taphuynh.dev`
(project `arca/hope-v2`, id 6) with the project CI-lint endpoint: a config using
the native `secrets:`/`vault:` keyword is rejected with
`jobs:<job> config contains unknown keys: secrets`, while the same config using
only `id_tokens:` lints valid. So the login + read is a shell step,
`.gitlab/ci/vault-login.sh`, driven by `.gitlab/ci/vault.yml`. If the project moves
to Premium the roles and policies below are unchanged; only the job syntax changes.

### One-time setup

```bash
vault auth enable -path=jwt-gitlab jwt
vault write auth/jwt-gitlab/config \
  oidc_discovery_url="https://git.taphuynh.dev" \
  bound_issuer="https://git.taphuynh.dev"

vault policy write hope-ci        infrastructure/docker/configs/vault/policies/hope-ci.hcl
vault policy write hope-ci-deploy infrastructure/docker/configs/vault/policies/hope-ci-deploy.hcl

vault write auth/jwt-gitlab/role/hope-ci - <<'EOF'
{ "role_type": "jwt", "user_claim": "user_email",
  "bound_audiences": ["https://vault.hope.arcaai.com"],
  "bound_claims_type": "glob",
  "bound_claims": { "project_path": "arca/hope-v2" },
  "token_policies": ["hope-ci"],
  "token_ttl": "10m", "token_max_ttl": "20m", "token_num_uses": 20 }
EOF

vault write auth/jwt-gitlab/role/hope-ci-deploy - <<'EOF'
{ "role_type": "jwt", "user_claim": "user_email",
  "bound_audiences": ["https://vault.hope.arcaai.com"],
  "bound_claims_type": "glob",
  "bound_claims": { "project_path": "arca/hope-v2",
                    "ref": ["staging", "dev", "v*"] },
  "token_policies": ["hope-ci-deploy"],
  "token_ttl": "10m", "token_max_ttl": "20m", "token_num_uses": 20 }
EOF
```

Then seed the CI credentials and flip the switch:

```bash
vault kv put secret/ci/DATABASE_URL     value='postgresql://ci_user:...@10.10.1.250:5000/vox_staging'
vault kv put secret/ci/REDIS_URL        value='redis://:...@10.10.1.120:6379/8'
vault kv put secret/ci/REDIS_PASS       value='...'
vault kv put secret/ci/JWT_SECRET_KEY   value='...'
vault kv put secret/ci/API_KEY_PEPPER   value='...'
vault kv put secret/deploy/DEPLOY_TOKEN value='...'
vault kv put secret/deploy/GITHUB_BACKUP_USER  value='...'
vault kv put secret/deploy/GITHUB_BACKUP_TOKEN value='...'
vault kv put secret/deploy/PGB_SMOKE_SSH_KEY           value=@id_ed25519
vault kv put secret/deploy/PGB_SMOKE_ADMIN_PG_PASSWORD value='...'
vault kv put secret/deploy/PGB_SMOKE_APP_PG_PASSWORD   value='...'
```

GitLab → Settings → CI/CD → Variables: set **`VAULT_ADDR`** to the cluster Vault
URL. It is topology, not a secret — do **not** mask it. That one variable turns the
mechanism on for every wired job; while it is empty every job silently falls back
to the existing `CI_*` variables, so there is no half-migrated state.

### Two syntax traps

Both were hit while validating this procedure against a real Vault 1.18:

* `bound_claims` is a **map** field. The command-line form
  `bound_claims='{"project_path":"..."}'` is rejected with
  `expected a map, got 'string'`. Use JSON on stdin (`- <<'EOF'`), as above.
* `"ref": "{staging,dev,v*}"` matches **nothing**. Vault's glob matcher supports
  `*` only — there is no brace alternation — so that value would be compared
  literally. Use a JSON **array**; `bound_claims` matches if any element matches.

### ⚠ Open item — branch protection

`GET /projects/6/protected_branches` (2026-07-26) returns **`main` and `release`
only**. `staging` and `dev` — the refs `deploy-staging`, `smoke-pgbouncer-staging`
and `github-backup` run on — are unprotected, so anyone who can push a branch can
run those pipelines and obtain the deploy credentials.

Protect `staging` and `dev`, then add `"ref_protected": "true"` to the
`hope-ci-deploy` role's `bound_claims`. `ref_protected` is asserted by GitLab and
cannot be forged by a pipeline author, which makes it the only claim in this design
that is a genuine privilege boundary. Until then the `ref` claim is scoping, not
enforcement.

### Debugging a failed job login

`vault-login.sh` prints the exact Vault error plus the job's own claims. The usual
causes, in order:

| Symptom | Cause |
|---|---|
| `claim "ref" does not match any associated bound claim values` | the job runs on a ref the role does not bind (see the array form above) |
| `claim "project_path" ...` | the role is bound to a different project, or the token came from a fork |
| `invalid audience` | `VAULT_OIDC_AUD` in `.gitlab-ci.yml` ≠ the role's `bound_audiences` |
| `permission denied` on the kv read | login succeeded but the policy does not cover that path — check `secret/ci/*` vs `secret/deploy/*` |
| `VAULT_ID_TOKEN is absent` | the job has no `id_tokens:` block; extend a node base or add `id_tokens: !reference [.vault-oidc-id-token, id_tokens]` |

Values fetched at runtime are **not** masked by GitLab (masking only covers
variables defined in project settings). Never wrap the job's Vault step in `set -x`.

---

## Kubernetes secret delivery (Vault Agent injection)

TASK-558 §13.2 / §9.2 L7. Pods get platform secrets from a Vault Agent **sidecar**
that renders one file per secret into a memory-backed volume — not from Kubernetes
`Secret` objects. A `Secret` is base64, not encryption: its plaintext sits in etcd,
is readable by anything with `get secrets` in the namespace, and outlives the pod.
For PHI that is the weaker posture; External Secrets Operator, which materializes
exactly those objects, is acceptable only for non-PHI values (currently: none).

The full contract, the per-service secret table, the reference manifest and the
Helm equivalent live in
[`deployment/vault-agent/README.md`](../../../deployment/vault-agent/README.md).
Operationally:

```bash
# Enable Kubernetes auth once, then one role per service ServiceAccount.
vault auth enable kubernetes
vault write auth/kubernetes/config kubernetes_host="https://$KUBERNETES_PORT_443_TCP_ADDR:443"

for svc in api smr guardrail nlp harness tts stt; do
  vault policy write "hope-$svc" "infrastructure/docker/configs/vault/policies/k8s/hope-$svc.hcl"
  vault write "auth/kubernetes/role/hope-$svc" \
    bound_service_account_names="hope-$svc" \
    bound_service_account_namespaces=hope \
    policies="hope-$svc" ttl=1h
done
```

Verify a rendered manifest set before it reaches the cluster:

```bash
kubectl kustomize deployment/vault-agent | deployment/vault-agent/check-contract.sh -
helm template <chart>                    | deployment/vault-agent/check-contract.sh -
```

Three failure modes that all present as "the secret is empty":

1. **File ownership** — the injector defaults to uid 100 / mode 0640; application
   containers run as uid 1001. Set `vault.hashicorp.com/agent-run-as-user: "1001"`.
2. **Trailing newline** — an untrimmed template appends `\n`, so every
   `X-Service-Token` compare fails with a 401 that looks like a wrong secret. Use
   `{{- with secret ... -}}{{ .Data.data.value }}{{- end -}}`.
3. **`agent-pre-populate-only: "true"`** — renders once and exits, so a rotated
   secret never reaches a running pod. Keep the sidecar.

Dev parity: `infrastructure/docker/configs/vault/dev-init.sh` writes the *same*
per-service policy files and seeds the *same* `secret/hope/<NAME>` paths, so a
policy typo surfaces on a laptop rather than in staging. It seeds 19 of the 24
`vault-kv` descriptors — every self-hosted one. The five **external** provider
credentials (`AZURE_SPEECH_KEY`, `AZURE_FOUNDRY_API_KEY`, `SMR_AZURE_API_KEY`,
`TTS_SARVAM_API_KEY`, `HARNESS_JUDGE_OPENAI_COMPAT_API_KEY`) are deliberately left
absent: all five are `failMode: 'closed'`, so absence is a clean "not configured",
while a placeholder would turn that into a remote 401.

---

## Leader failover (manual)

Planned maintenance on the active node — step down gracefully (a standby takes over
in seconds; clients retry transparently):

```bash
ACTIVE=$(for p in vault-0 vault-1 vault-2; do kubectl -n vault-system exec -c vault "$p" -- vault status 2>/dev/null | grep -q 'HA Mode.*active' && echo "$p"; done)
vex "$ACTIVE" vault operator step-down
```

Unplanned: just delete the active pod — Raft elects a new leader automatically
(verified by the chaos drill, Drill A). Confirm with the Daily-ops health loop.

---

## Emergency unseal (quorum lost)

**Symptom A — every node sealed, seal Vault is down/sealed** (most common). The HA
nodes can't reach Transit. Fix the seal Vault; the HA nodes then auto-unseal with
no key entry:

```bash
kubectl -n vault-system get pod vault-seal-0                 # up?
kubectl -n vault-system exec vault-seal-0 -- vault status    # Sealed: true?
# A seal-Vault RESTART needs MANUAL re-unseal with 3 of the 5 offline Shamir keys:
kubectl -n vault-system exec vault-seal-0 -- vault operator unseal <key-1>
kubectl -n vault-system exec vault-seal-0 -- vault operator unseal <key-2>
kubectl -n vault-system exec vault-seal-0 -- vault operator unseal <key-3>
# Within ~30s the HA nodes auto-unseal. If a node is stuck: kubectl -n vault-system delete pod vault-N
```

**Symptom B — Raft quorum lost** (2+ HA nodes gone, `VaultQuorumAtRisk`/`VaultNoActiveLeader`).
If ≥1 node survives, restore the others (delete pods → they rejoin + auto-unseal).
If ALL Raft data is lost, restore from the latest snapshot with a privileged token:

```bash
vex vault-0 vault operator raft snapshot restore -force /path/snap.snap
```

Take snapshots routinely: `vault operator raft snapshot save <file>` (script via CronJob).

**Privileged access after root revocation** — the root token is revoked post-bootstrap.
For operations needing root, mint a temporary one from the **offline recovery keys**,
then revoke it again:

```bash
kubectl -n vault-system exec -c vault vault-0 -- vault operator generate-root -init   # → OTP + nonce
# each custodian: vault operator generate-root -nonce=<nonce>  (enter a recovery key) ×3
kubectl -n vault-system exec -c vault vault-0 -- vault operator generate-root -decode=<encoded> -otp=<otp>
# ... use the token, then: vault token revoke -self
```

---

## Audit-log retention

Two sidecars run alongside each Vault pod (Helm `audit-sidecar.values.yaml`):

- **audit-log-shipper** — `tail -F` the audit log to stdout → the cluster log agent
  (Promtail/Vector) ships it to Loki. **Loki is the durable, queryable store.**
- **audit-log-rotator** — copytruncate rotation: when `/vault/audit/vault-audit.log`
  exceeds `MAX_BYTES` (100Mi) it's archived + truncated in place. Safe because Vault
  opens the file `O_APPEND` (no SIGHUP/reopen needed). Keeps `KEEP` (5) on-PVC archives.

If `VaultAuditPVCLowSpace` fires: confirm the rotator container is running
(`kubectl -n vault-system logs vault-0 -c audit-log-rotator`); if the log agent is
backed up, the PVC is the buffer — expand it or lower `MAX_BYTES`/`KEEP`.

⚠️ If audit is the **only** device and it can't write, Vault **blocks all requests**
(`VaultAuditLogWriteFailures` is `critical`). Never let the audit PVC reach 100%.

---

## Alerting & dashboards

PrometheusRules + Grafana dashboard live in
[`infrastructure/single-deployment/vault/monitoring/`](../../../infrastructure/single-deployment/vault/monitoring/README.md).
Apply `recording-rules.yaml` + `alerts.yaml`; import `grafana-dashboard.json`.

| Alert | Meaning | First action |
|---|---|---|
| `VaultSealed` / `VaultClusterSealedOrUnreachable` | node(s) sealed | [Emergency unseal](#emergency-unseal-quorum-lost) |
| `VaultNoActiveLeader` / `VaultQuorumAtRisk` | no leader / quorum risk | [Leader failover](#leader-failover-manual) / [quorum lost](#emergency-unseal-quorum-lost) |
| `VaultNodeDown` | scrape target down | check pod/node, kubelet |
| `VaultLeaderFlapping` | unstable elections | check disk/CPU/network on `vault-*` |
| `VaultAutopilotUnhealthy` | a voter lagging | `raft autopilot state` |
| `VaultAuditLogWriteFailures` | audit blocked (availability!) | [Audit-log retention](#audit-log-retention) |
| `VaultAuditPVCLowSpace` / `VaultDataPVCLowSpace` | volume filling | expand PVC / check rotator |

---

## App-side Vault metrics (future)

`monitoring/alerts-app.yaml` is ready but **inactive** until the HOPE API exports
three series it already has the data for. The API serves `prom-client` at
`GET /metrics` (`apps/api/src/observability/metrics.ts`), and
`SecretsService.health()` already tracks `degraded` + lease-renew `failureCount`.

Add a small collector (gauge with a `collect()` hook reading the live `SecretsService`):

| Metric | Type | Fed from |
|---|---|---|
| `arca_vault_degraded` | gauge 0/1 | `SecretsService.health().degraded` |
| `arca_vault_token_ttl_remaining_seconds` | gauge | AppRole token-renew loop |
| `arca_vault_lease_renewal_failure_total` | counter | `VaultLeaseRenewer.failureCount` |

Then `kubectl apply -f monitoring/alerts-app.yaml`.

---

## Chaos drills

Validate self-recovery on **staging** (never unannounced in prod):

```bash
CHAOS_CONFIRM=yes scripts/chaos/vault-drill.sh                       # leader kill, follower auto-unseal, transit outage
APP_HEALTH_URL=https://api.staging/health CHAOS_CONFIRM=yes scripts/chaos/vault-drill.sh   # + assert app recovers
DRILLS="C" CHAOS_CONFIRM=yes scripts/chaos/vault-drill.sh            # a single drill
```

Each fault must self-recover (the cluster ends with 3 unsealed nodes + a leader).
Drill C black-holes the seal Service (reversible) — it never restarts the seal Vault,
so no manual re-unseal is needed. For the planned 7-day soak (TASK-312 Phase F.3),
run the drill on a schedule against staging and watch the dashboard for `degraded`.

---

## Production cutover & staging soak (TASK-312 Phase F.3)

The cluster, app wiring, and drills are verified on `kind`; the remaining gate is an
**operational staging soak + cutover** on the real k3s cluster. This is a human-run
checklist (it needs real infra + ≥7 days), not an automated step.

**Pre-cutover gate** (all must be true):

- [ ] Bootstrap complete on staging k3s (Bootstrap section); **root token revoked**; the 5/3 recovery keys are **offline** (not in-cluster).
- [ ] `monitoring/recording-rules.yaml` + `alerts.yaml` applied; Grafana dashboard imported; a deliberately-sealed node fires `VaultSealed` (prove the pipe end-to-end).
- [ ] API deploys with the AppRole **file** contract (`VAULT_ROLE_ID_FILE` / `VAULT_WRAPPED_SECRET_ID_FILE`, from Secret `hope/hope-vault-approle`); `apps/api/.env.prod` is secret-free (TASK-312 §B).
- [ ] The deploy pipeline runs `bootstrap/rotate-secret-id.sh` **before each rollout** (fresh single-use wrapped secret_id) — no root needed.
- [ ] Raft snapshots scheduled (`vault operator raft snapshot save` via CronJob).

**Staging soak (≥168 h / 7 days):**

```bash
# Run the drill on a schedule (e.g. CronJob/CI nightly) against staging, asserting the
# API stays healthy through each fault. The dashboard's `degraded` panel must stay 0.
APP_HEALTH_URL=https://api.staging.hope/health CHAOS_CONFIRM=yes scripts/chaos/vault-drill.sh
```

Pass = ≥168 h with **no unexplained `arca_vault_degraded` / `VaultAppSecretsDegraded`**
events and every injected fault self-recovered. Capture the soak log + dashboard
screenshots as the AC-F3 evidence.

**Cutover:** roll the API onto Vault during a low-traffic window → watch `/readiness`
(503 ⇒ pulled from the LB automatically) → smoke-test an auth + a GlobalSetting
read/write (exercises KV + transit) → watch the dashboard for 30 min.
**Rollback:** the previous release (or env-var secret source) stays one `kubectl rollout
undo` away; Vault changes here are additive and non-destructive.

---

## Break-glass quick reference

| Need | Command |
|---|---|
| Is it sealed? | `kubectl -n vault-system exec -c vault vault-0 -- vault status` |
| Re-unseal seal Vault | `kubectl -n vault-system exec vault-seal-0 -- vault operator unseal <key>` ×3 |
| Fresh app secret_id | `APP_NS=hope bootstrap/rotate-secret-id.sh` |
| Temp root | `vault operator generate-root` (recovery keys) → `vault token revoke -self` |
| Snapshot | `vault operator raft snapshot save snap.snap` |
| Recovery keys | Secret `vault-system/vault-init-keys` (should be **offline**, not in-cluster) |
