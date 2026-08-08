# Disaster Recovery & Break-Glass Runbook

**Status**: SUPERSEDED — this runbook (TASK-369 Phase 5) describes recovery procedures for a Shamir-based Vault unseal model. The actual Vault HA deployed (vault-ha-deployment 2026-08-07) uses Raft with Transit auto-unseal, rendering the Shamir-dependent break-glass procedures in this document inapplicable to current infrastructure.

**Ticket**: TASK-369 (Data Encryption Initiative — Phase 5, key management / OPS)
**Audience**: On-call SRE + the Shamir key-share holders
**Covers**: Vault unseal, LUKS recovery, encrypted-backup restore, and the safe
ordering between them after a cold start / site loss.

> Break-glass = the controlled, audited use of the most privileged recovery
> material (Shamir shares, root token, LUKS escrow passphrases). Every step here
> is logged; after any break-glass event, run §6 (rotate what you touched).

---

## 0. The dependency order (why sequence matters)

HOPE's at-rest + key-management layers have a strict unlock order. Encryption
makes recovery **fail safe** — get the order wrong and nothing decrypts, but
nothing leaks either.

```
1. Vault unseal          (root of trust: holds DB creds, pgBackRest cipher pass,
                          MinIO keys, and — if you chose Vault LUKS custody — the
                          disk passphrases)
        │
2. LUKS unlock DB disks  (Postgres data+WAL on VMs 500–502 / single-server)
        │
3. Postgres restore      (pgBackRest repo is AES-256-CBC; pass comes from Vault)
        │
4. MinIO online + SSE    (media PHI; SSE keys via KES/KMS)
        │
5. App services back up  (api, python services reconnect with sslmode=require)
```

> **Circular-dependency guard:** Vault's OWN storage must NOT sit on a disk that
> depends on Vault to unlock. Vault uses Shamir (or its own cloud/HSM
> auto-unseal), never the database LUKS custody. Confirm this on every Vault
> node before an incident.

---

## 1. When to invoke

- Vault sealed after restart/crash (alert `VaultSealed` / `VaultTargetDown`).
- Lost a DB node / whole site; need to restore from pgBackRest.
- LUKS auto-unlock (clevis-tang / Vault) failed and a disk won't mount.
- Suspected key compromise (also see vault-transit-key-rotation.md §6).

---

## 2. Vault unseal (Shamir 3-of-5)

Production Vault is initialised `-key-shares=5 -key-threshold=3`
(deploy-vm430-432-vault.md §7). Unsealing needs **3 of the 5** share-holders.

```bash
# On each Vault node (430, 431, 432), after the process is running:
vault status | grep -E 'Sealed|HA Mode'         # Sealed: true (expected pre-unseal)

# THREE different share-holders each run ONE unseal (never paste all 3 from one
# place — that defeats Shamir). Repeat per node.
vault operator unseal <key-share-A>             # operator A
vault operator unseal <key-share-B>             # operator B
vault operator unseal <key-share-C>             # operator C

vault status | grep -E 'Sealed|HA Mode'         # -> Sealed: false, HA Mode: active|standby
```

- Unseal node 1 first, confirm `HA Mode: active`, then unseal nodes 2 & 3
  (they join as standby).
- **Quorum lost** (3 holders unreachable): the cluster CANNOT be unsealed —
  escalate to the incident commander. This is by design; there is no bypass.
- **Auto-unseal** (if later migrated to cloud KMS/HSM): nodes unseal on start;
  the Shamir shares become *recovery* keys for `vault operator rekey`/`generate-root`.

### Break-glass root token

The initial root token lives in the SRE password vault for emergencies only
(deploy-vm430-432-vault.md §7). Use it ONLY when no operator userpass works;
**revoke + regenerate** it immediately after (`vault token revoke <self>`,
`vault operator generate-root`). Record the use in the incident log.

---

## 3. LUKS recovery (data-disk won't unlock)

If clevis-tang (tang servers unreachable) or Vault-custody auto-unlock fails,
unlock manually with the escrowed passphrase.

```bash
# Confirm the device is a locked LUKS container
sudo cryptsetup status data_crypt || true
lsblk -f /dev/sdb          # FSTYPE = crypto_LUKS, no mountpoint = still locked

# Manual unlock with the escrowed passphrase (from the sealed offline escrow —
# see encryption-at-rest-luks-minio-sse-runbook.md §3). You will be prompted:
sudo cryptsetup open /dev/sdb data_crypt
sudo mount /dev/mapper/data_crypt /data
lsblk -f                   # /dev/mapper/data_crypt now mounted at /data
```

- **Lost a key slot / rotating after a holder offboards**:
  `sudo cryptsetup luksAddKey /dev/sdb` (add new) then
  `sudo cryptsetup luksKillSlot /dev/sdb <slot>` (remove old) — **confirm with the
  incident commander before removing any slot** (removing the wrong slot can lock
  you out; this runbook does not auto-run destructive cryptsetup).
- **Re-bind auto-unlock after tang recovery**: `sudo clevis luks bind ...`
  (at-rest runbook §2).
- Audit slots: `sudo cryptsetup luksDump /dev/sdb | grep -A2 Keyslots`.

---

## 4. Postgres restore from the encrypted pgBackRest repo

The repo is AES-256-CBC encrypted (Phase 4). Restore works only when
`PGBACKREST_REPO1_CIPHER_PASS` (and the S3 creds) are present in the container
env — they come from Vault, so **Vault must be unsealed first (§2)**.

```bash
# 0. Fetch secrets from Vault into the node .env (operator)
vault kv get -field=PGBACKREST_REPO1_CIPHER_PASS  secret/hope/PGBACKREST_REPO1_CIPHER_PASS
vault kv get -field=PGBACKREST_REPO1_S3_KEY        secret/hope/PGBACKREST_REPO1_S3_KEY
vault kv get -field=PGBACKREST_REPO1_S3_KEY_SECRET secret/hope/PGBACKREST_REPO1_S3_KEY_SECRET
# -> write into research/configs/postgres-ha/.env (PGBACKREST_*), then recreate
#    the patroni container so it inherits them.

# 1. Verify the repo is reachable + encrypted
docker exec patroni pgbackrest --stanza=hope-cluster info | grep -i cipher   # aes-256-cbc

# 2. Restore (full / PITR). Full procedure incl. Patroni reinit:
#    research/deployments/deploy-vm500-502-postgres-ha.md §12.8
docker exec patroni pgbackrest --stanza=hope-cluster --delta restore          # latest
# PITR example:
# docker exec patroni pgbackrest --stanza=hope-cluster --type=time \
#   --target="2026-06-18 09:00:00" --delta restore
```

If `info` errors with a cipher/passphrase message, the Vault value is missing or
wrong — fix the env, do **not** disable the cipher.

---

## 5. MinIO recovery

- Bring MinIO back, restore root/service creds from Vault, re-attach the data
  volumes.
- Re-assert SSE on the PHI/backup buckets (at-rest runbook §5.1) — SSE config is
  per-bucket and survives restarts, but verify: `mc encrypt info homelab/recordings`.
- pgBackRest objects are independently client-side encrypted, so a MinIO restore
  never exposes backup plaintext even if SSE was mid-reconfiguration.

---

## 6. Post-break-glass — rotate what you touched

Anything exposed during recovery is now "used" and must be rotated:

| Touched during DR | Rotate via |
|---|---|
| Vault root token | `vault operator generate-root` + revoke old (deploy-vm430-432-vault.md) |
| AppRole secret-id (`hope-app`) | re-issue (deploy-vm430-432-vault.md §11) |
| LUKS passphrase (if read aloud / shared) | `cryptsetup luksAddKey` new, `luksKillSlot` old (§3) |
| pgBackRest cipher pass (if a NEW repo/stanza was created) | new `openssl rand -base64 48` → Vault → re-stanza |
| MinIO service creds (if re-issued) | `mc admin user svcacct add/rm` (deploy-vm402-minio.md §9b.3) |
| `hope-phi` (if key compromise suspected) | vault-transit-key-rotation.md §6 |

Then: close the incident, confirm `VaultSealed`/`VaultNoActiveNode` are clear,
and run the at-rest verification checklist (at-rest runbook §7).

---

## 7. Escrow & contacts (fill in per deployment — do NOT commit secrets)

| Item | Location (reference only) |
|---|---|
| Shamir share holders (5) | <names/roles — out-of-band roster> |
| Shamir shares | <geographically separated sealed envelopes> |
| Vault root token | <SRE offline password vault> |
| LUKS passphrase escrow (per node) | <sealed offline escrow> |
| Incident commander rota | <on-call schedule link> |

> Never store any of the above in this repo, chat, email, or a shared doc.
