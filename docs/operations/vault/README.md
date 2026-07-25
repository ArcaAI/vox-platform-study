# HOPE Vault — Operator Runbook

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
`apps/api/.env.production`'s `PG_VAULT_MAX_TTL_SEC=2592000` (30d in seconds)
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
- [ ] API deploys with the AppRole **file** contract (`VAULT_ROLE_ID_FILE` / `VAULT_WRAPPED_SECRET_ID_FILE`, from Secret `hope/hope-vault-approle`); `apps/api/.env.production` is secret-free (TASK-312 §B).
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
