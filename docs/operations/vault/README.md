# Vault — retired HA design, kept as a mechanism reference

**This page documents a Vault architecture that is not the one running today, and most of its
commands target infrastructure that no longer exists.** Two designs preceded the current one, in
order: (1) a 3-node Raft HA cluster on Kubernetes (Helm chart `vault-system`, pods `vault-0..2`,
plus a separate Transit seal instance) — designed and `kind`-tested but **never deployed**; then
(2) that same HA shape hand-run on Proxmox VMs 430-432 with a seal VM 434 — this WAS live as of
2026-08-07, until VM 434 sealed itself on 2026-08-28 and took the whole estate down for two days
with its Shamir shares unrecoverable (TASK-833, 2026-08-30). Both are being decommissioned.

**The live Vault today is `hope-vault` in namespace `hope-v2-dev`:** a single instance,
`storage "file"` on a PVC, Shamir seal unsealed in-pod by a `vault-bootstrap` init/sidecar
container, with no dependency outside the cluster. Its manifest is
`arca/hope-v2-deployment` -> `deployment/k8s/base/vault.yaml`, and its operator procedure —
rebuild, wipe, re-seed, verification — is that repo's own `docs/vault-seal-migration.md`. **Go
there for anything operational against the Vault that actually exists.**

Everything below is retained only because parts of it are genuine, portable Vault mechanism
knowledge (secret rotation flow, GitLab OIDC login, Vault Agent injection failure modes) that
likely still applies to `hope-vault` in some form — **none of it has been re-verified against the
single-instance deployment**, and every `kubectl`/`vault` invocation below targets the retired
`vault-system` namespace and `vault-0..2` pods, not `hope-vault`.

## Layout

| Path | What it holds |
|---|---|
| `README.md` | This file |
| `vm-cluster-seal-unseal.md` | The seal/unseal and disaster-recovery procedure for the retired VM cluster (design #2 above) — also historical, kept for the same reason |

## How it works (retired design — mechanism reference only)

### Architecture as designed

| Piece | What | Where |
|---|---|---|
| HA Vault | 3-node Raft (integrated storage), pods `vault-0..2` | ns `vault-system` |
| Seal Vault | single node providing Transit auto-unseal for the HA cluster | pod `vault-seal-0` |
| App auth | AppRole `hope-app` + agent-injector delivers secrets to API pods | ns `hope` |
| Workload auth | Kubernetes auth (`auth/kubernetes`), one role + policy per service | `infrastructure/docker/configs/vault/policies/k8s/hope-*.hcl` |
| CI auth | GitLab OIDC -> JWT auth (`auth/jwt-gitlab`), roles `hope-ci` / `hope-ci-deploy` | `.gitlab/ci/vault.yml`, `.gitlab/ci/vault-login.sh` |

Auto-unseal chain, conceptually still how any Transit-sealed Vault works: an HA node boots, asks
the seal Vault's Transit engine to decrypt its root key, and unseals — if the seal Vault is down or
sealed, every HA node stays sealed.

### Secret rotation flow (likely still applies to `hope-vault`, unverified)

- **KV-v2 application secrets**: write a new version (`vault kv put secret/hope/<key> value=<new>`);
  consumers pick it up on their next cache refresh, or immediately via the
  `arca:secrets:invalidate` Redis pub/sub channel — `SecretsInvalidationSubscriber`, wired by
  `SecretsModule.forRoot()`, drops the cache entry on every node the moment a rotation is
  published; the TTL refresh is the backstop, not the mechanism.
- The registered name for any platform secret is always the descriptor key from
  `packages/applications/src/services/settings-registry/descriptors/platform-secrets.descriptors.ts`
  run through `toEnvVarName()` — `scripts/vault-seed-secrets.sh --dry-run --only <NAME>` confirms a
  name is a registered `vault-kv` descriptor before you rotate it; an unregistered name is never
  written and nothing reads it.
- Python services get a rotated value re-rendered by their Vault Agent sidecar, but a settings
  object already built at startup keeps the old value until the service's `reload_secrets()` runs
  or the deployment rolls.
- `JWT_SECRET_KEY` has its own page — [`../jwt-secret-rotation.md`](../jwt-secret-rotation.md) —
  because it is exercised by every request, so a half-rotation is a platform-wide 401, not a
  degraded hop.
- `API_KEY_PEPPER` must be rotated with a staged overlap (verify against the `keyVersion` recorded
  on each `ApiKey` row), never swapped outright, or every issued API key dies at once.
- Dynamic DB credentials (`database/creds/hope-app-role`) carry two TTLs: `default_ttl` (renewed at
  50% by `VaultLeaseRenewer`, `apps/api/src/vault-prisma.module.ts`) and `max_ttl` (a hard ceiling
  from issue time; once within `min(300s, 25% of max_ttl)` of it, the renewer stops renewing and
  force-rotates the Postgres role instead via `wrapper.swap()`).

### GitLab CI to Vault (OIDC) — the login mechanism, likely still portable

No long-lived `VAULT_TOKEN` in GitLab project settings: a job presents a short-lived, job-scoped
GitLab ID token, and Vault's JWT auth method (`auth/jwt-gitlab`) decides what it may read from the
token's own claims. Two syntax traps hit while validating this against a real Vault 1.18:

- `bound_claims` is a map field — `bound_claims='{"project_path":"..."}'` on the command line is
  rejected (`expected a map, got 'string'`); write the role config as JSON on stdin instead.
- Vault's glob matcher supports `*` only, no brace alternation — `"ref": "{staging,dev,v*}"`
  matches nothing literally. Use a JSON array; `bound_claims` matches if any element matches.

### Kubernetes secret delivery (Vault Agent sidecar) — failure modes, likely still relevant

Pods get platform secrets from a Vault Agent sidecar that renders one file per secret into a
memory-backed volume, not from Kubernetes `Secret` objects (a `Secret` is base64 in etcd, readable
by anything with `get secrets` in the namespace — too weak a posture for PHI). The reference
contract this section originally pointed at (`deployment/vault-agent/`) no longer exists in either
this repo or `arca/hope-v2-deployment` — do not follow that path if you find it cited elsewhere.
Three failure modes that all present as "the secret is empty", preserved because they are Vault
Agent facts, not facts about the retired cluster:

1. **File ownership** — the injector defaults to uid 100 / mode 0640; application containers often
   run as a different uid. Set `vault.hashicorp.com/agent-run-as-user` to match.
2. **Trailing newline** — an untrimmed template appends `\n`, so a token compare fails with a 401
   that looks like a wrong secret. Use `{{- with secret ... -}}{{ .Data.data.value }}{{- end -}}`.
3. **`agent-pre-populate-only: "true"`** — renders once and exits, so a rotated secret never
   reaches a running pod. Keep the sidecar running.

### Failover, emergency unseal, audit, alerting, chaos drills, cutover — condensed

These sections of the retired design (leader step-down, quorum-loss recovery via Raft snapshot,
root-token minting from offline recovery keys, audit-log shipping + rotation sidecars, Prometheus
alert names, a `scripts/chaos/vault-drill.sh` chaos suite, and a staging-soak/cutover checklist)
described a 3-node Raft cluster's operational surface. None of it applies mechanically to a
single-instance Vault with no Raft peers and no separate seal node — there is no leader to fail
over, no quorum to lose, and no Transit-seal dependency chain. Do not run any command from an
earlier version of this page against `hope-vault`; follow `docs/vault-seal-migration.md` in
`arca/hope-v2-deployment` instead.

## Gotchas

- **`scripts/chaos/vault-drill.sh` still defaults to `VAULT_NAMESPACE=vault-system`** — it has not
  been adapted for `hope-vault` in `hope-v2-dev`, so running it as-is targets a namespace that no
  longer holds the live Vault.
- **The `deployment/vault-agent/` contract folder this page used to point to is gone** — not
  renamed, not moved into `arca/hope-v2-deployment` under a new name that this pass could find.
  Anything that still cites it (including other rule/doc files) is describing a path that does not
  resolve; don't chase it further without confirming with the owner.
- **Both ends of a shared secret must move together.** A secret presented by one service and
  verified by another (the historical example here was `GUARDRAIL_SERVICE_TOKEN`) is an outage on
  that hop if only one side rotates.
- **Never rotate a secret by editing a `.env` file.** Committed env files carry placeholders only,
  and a value that must change without a restart is by definition not an env var
  (`.claude/rules/09-infrastructure-devops.md` the Configuration Tiers section).

## Related

- `arca/hope-v2-deployment`'s own `docs/vault-seal-migration.md` — the actual, current operator procedure for `hope-vault`
- [`vm-cluster-seal-unseal.md`](./vm-cluster-seal-unseal.md) — the second retired design (VM cluster), kept for the same mechanism-reference reason
- [`../jwt-secret-rotation.md`](../jwt-secret-rotation.md) — `JWT_SECRET_KEY`'s own rotation contract
- [`../../../infrastructure/single-deployment/vault/README.md`](../../../infrastructure/single-deployment/vault/README.md) — the retired design's deployment artifacts and rationale, kept in this repo as a design record
- [`../../../.claude/rules/09-infrastructure-devops.md`](../../../.claude/rules/09-infrastructure-devops.md) — current cluster topology, secret-delivery posture, and configuration tiers
