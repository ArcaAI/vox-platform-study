# TASK-1052 — Vault AppRole secret_id rotation

| Field | Value |
|---|---|
| Status | Completed (awaiting owner sign-off) |
| Type | infrastructure (bugfix) |
| Repo | `arca/hope-v2-deployment` `main`: `8c1acda` (rotation + consumer switch), `4522f5b` (CI gates) |
| Opened | 2026-10-09 |

## 1. Requirement analysis

On 2026-10-09 the TASK-1045 rollout (pipeline #1404, build `1042ba78`) could not start `hope-api`:
`VaultSecretsProvider.boot() FATAL: cannot authenticate to Vault — invalid role or secret ID`.
The `hope-app` AppRole issues secret IDs with `secret_id_ttl: 720h`; the one in `hope-secrets` was minted
at the 2026-09-08 Vault re-init and expired 30 days later. Nothing re-mints it, so every consumer that logs in
at boot (api, checkpoint-worker, model-publisher, db-migrate, db-seed, reset) fails, and long-running pods
fail at their next login (token_max_ttl 24h). Owner chose a rotation mechanism (option b), not a non-expiring id.

## 2. Current state evaluation

- `base/vault.yaml` sidecar `vault-bootstrap` mints the secret_id once (at provision) into Secret
  `hope-vault-approle`; an operator then hand-copies it into `hope-secrets`.
- Consumers read `VAULT_ROLE_ID` / `VAULT_SECRET_ID` from `hope-secrets`, which the sidecar's Role cannot write.

## 3. Implementation plan / summary

| Change | File |
|---|---|
| `rotate_secret_id_if_due()`: hourly (and on sidecar start) look the published secret_id up; if expired/unknown or < 10 days left, re-assert the role, mint a new id, canary it (login + `transit/encrypt/hope-phi`), republish `hope-vault-approle`. Only if the old id was already dead, `rollout restart` the three consumer Deployments | `base/vault.yaml` |
| Role: `get`/`patch` on deployments `hope-api`, `hope-checkpoint-worker`, `hope-model-publisher` | `base/vault.yaml` |
| Consumers read the AppRole from `hope-vault-approle` (the Secret the sidecar owns), not `hope-secrets` | `base/{api,checkpoint-worker,model-publisher,db-migrate}.yaml`, `out-of-band/{hope-db-seed,hope-reset}.yaml` |
| "SURFACE READY" log no longer instructs a hand copy | `base/vault.yaml` |

Running pods keep the old id (still valid ≥ 10 days at rotation) and pick up the new one on their next restart,
so a routine rotation restarts nothing. `VAULT_ROLE_ID`/`VAULT_SECRET_ID` in `hope-secrets` are now unused and can
be removed by hand once this is live.

Known trade-off: rotation reads the root token from `hope-vault-init`, exactly as the existing provision path does.
Revoking the root token (the sidecar's own advice) disables rotation as well; a scoped rotator policy is follow-up.

## 4. Verification

- `kubectl kustomize` renders `overlays/{dev,staging,prod,standalone}` (8 `hope-vault-approle` refs each);
  `overlays/orbstack` fails on a missing gitignored `local/ca.crt` (pre-existing, unrelated).
- `sh -n` on the sidecar script: OK. BusyBox `date -D` verified in the live sidecar image.
- Live (2026-10-09): a fresh secret_id was minted inside `hope-vault-0` with the same login + encrypt canary and
  published to `hope-vault-approle` (expires 2026-11-08T05:27Z).
- `hope-secrets` could not be patched (the sidecar's Role cannot write it), so the consumer switch was the deploy path.
- Deployed 2026-10-09 05:32Z via Argo auto-sync of `8c1acda`: Synced / Healthy, operation Succeeded; `hope-vault-0`
  restarted and self-unsealed; `hope-api` booted on `0.0.0-dev-2-2.1042ba78`; checkpoint-worker and model-publisher
  re-rolled onto the new Secret (their pre-rollout pods had logged "Vault token renewal DEGRADED").
- Rotation logic proven against the live store with the exact `vault.yaml` quoting: lookup reads
  `exp=2026-11-08T05:27:26 left_h=719 due=no`; an unknown/expired id parses as empty and takes the re-mint path.
  `kubectl auth can-i patch deployment/hope-api` = yes, `deployment/hope-text` = no (scoped as intended).
- CI: deployment pipeline #1407 green (all gates). hope-v2 pipeline #1404 green after `verify-dev` re-run.

### CI gates fixed in `4522f5b`

| Gate | Cause | Fix |
|---|---|---|
| `secret-keys` (red on `8c1acda`) | consumers now read `hope-vault-approle`, undeclared in the inventory | declared it (`VAULT_ROLE_ID`, `VAULT_SECRET_ID` required); dropped the keys from `hope-secrets` |
| `capacity` (red since 2026-10-02, TASK-1031) | STT pinned with `CUDA_VISIBLE_DEVICES` instead of an `nvidia.com/gpu` request, so rules 8/9 counted it as CPU plane (+40 GiB ceiling) | `GPU_ROLE` membership classifies a workload as GPU plane, as before |

## 5. Change history

| Date | Change |
|---|---|
| 2026-10-09 | Opened from the TASK-1045 rollout incident; rotation + consumer switch implemented; live secret_id re-minted into `hope-vault-approle`. |
| 2026-10-09 | Deployment repo aligned (local `main` tracked `arcaai/main`; re-pointed to `origin/main`, gemma 32768/q4_0 commit rebased on top); pushed as `4797dbe` + `1a0d259` (owner-approved); deployed and verified; CI green. |
| 2026-10-09 | Owner rewrote the two commit messages (trailer removed, trees identical): `4797dbe`→`8c1acda`, `1a0d259`→`4522f5b`. Local only — the owner force-pushes; Argo and pipeline #1406/#1407 still name the old hashes until then. |
