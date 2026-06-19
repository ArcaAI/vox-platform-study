# Encryption At Rest — LUKS, MinIO SSE & Backup Cipher Runbook

**Ticket**: TASK-369 (Data Encryption Initiative — Phase 1 + Phase 4 verification)
**Audience**: SRE / operators with host/VM root access
**Scope**: PostgreSQL data + WAL volumes, MinIO object storage (PHI media + pgBackRest), Redis, auto-unlock key custody, and encrypted-backup verification.

> Everything in this runbook is an **operator action on real hosts** (LUKS needs
> block-device + root access that CI/agents do not have). The repo only carries
> the config hooks (compose comments, `pgbackrest.conf` cipher, env wiring). Run
> these steps on the target VMs/servers.

---

## 0. Why (threat model)

At-rest disk encryption is the compliance floor: it covers **every** column,
index, WAL segment, temp file, and raw backup at once. It defends against stolen
disks, VM snapshots, decommissioned hardware, and raw backup files — it does
**not** defend against a live compromised node (that is field-level encryption +
RBAC, handled elsewhere in TASK-369).

| Data store | At-rest mechanism | Covers |
|---|---|---|
| PostgreSQL data + WAL (HA VMs 500–502) | LUKS/dm-crypt on the `/data` disk | All tables, indexes, WAL, temp |
| PostgreSQL (single-server / dev) | Host full-disk encryption (LUKS / FileVault) | Docker volume `hope-postgres-data-pg18` |
| MinIO media buckets (`recordings`, `generated-audio`, `documents`) | MinIO SSE-S3 (KES/KMS) | Audio/media PHI behind `Media.uri` |
| MinIO `pgbackrest` bucket | pgBackRest AES-256-CBC (client-side) **+** SSE-S3 | Backups + archived WAL (double-wrapped) |
| Redis | Persistence disabled, or LUKS volume | Cached PHI (if any) |

---

## 1. LUKS on the PostgreSQL HA cluster (VMs 500 / 501 / 502)

PGDATA lives at `/home/postgres/pgdata/data` **inside** the container, bind-mounted
from `/data/postgresql` on the host (see
[`deploy-vm500-502-postgres-ha.md`](./deploy-vm500-502-postgres-ha.md) §6.4). WAL
(`pg_wal`), the pgBackRest local cache (`/data/pgbackrest`), and etcd
(`/data/etcd`) all sit under `/data`. **Encrypting the `/data` block device
encrypts data + WAL + local backup cache in one shot.**

> **Ordering is critical.** LUKS must wrap the block device **before** `mkfs` and
> before any database data exists — do this at provisioning time (between §4.2
> "add a dedicated data disk" and §6.4 "create data directories" of the deploy
> guide). Encrypting a populated `/data` in place is **not** supported; retrofit
> requires: take a fresh pgBackRest backup → stop the stack → re-provision the
> disk with LUKS → restore (see §6 of this runbook + the DR runbook).

### 1.1 Encrypt the dedicated data disk (run on each of VM 500/501/502)

Assumes a dedicated data disk `/dev/sdb` (deploy guide §4.2). Adjust the device.

```bash
# 0. Confirm the target is EMPTY (no filesystem you need). DESTRUCTIVE format.
lsblk -f /dev/sdb

# 1. Create the LUKS2 container (AES-256-XTS, Argon2id KDF — cryptsetup default).
#    You will be prompted for the passphrase twice. Use a strong 32+ char value;
#    it is escrowed (§3) and consumed by the auto-unlock pin (§2), not typed at
#    every boot in production.
sudo cryptsetup luksFormat --type luks2 /dev/sdb

# 2. Open it -> creates /dev/mapper/data_crypt
sudo cryptsetup open /dev/sdb data_crypt

# 3. Filesystem (XFS is the deploy guide's choice for PG workloads)
sudo mkfs.xfs /dev/mapper/data_crypt

# 4. Mount at /data and persist (note: use the MAPPER device, not /dev/sdb)
sudo mkdir -p /data
sudo mount /dev/mapper/data_crypt /data
echo '/dev/mapper/data_crypt /data xfs defaults,noatime 0 2' | sudo tee -a /etc/fstab
```

Then continue with deploy guide §6.4 (create `/data/postgresql`, `/data/etcd`,
`/data/pgbackrest`, chown `1000:1000`).

### 1.2 Separate WAL disk (only if you split WAL out)

The default layout keeps WAL inside PGDATA, so §1.1 already covers it. **If** you
move WAL to its own disk (`pg_wal` symlink / tablespace on `/dev/sdc`), repeat
§1.1 for that device and mount it before initdb. Never leave a WAL disk
unencrypted — WAL contains full row images.

---

## 2. Auto-unlock key custody (no manual unseal at every boot)

Typing the LUKS passphrase on every reboot does not scale and blocks unattended
recovery. Pick **one** custody model and document the choice in the DR runbook.

### Option A — clevis + tang (recommended; Network-Bound Disk Encryption)

The disk auto-unlocks **only** while it can reach the tang server(s) on the
trusted LAN. Stolen disk off-network = stays locked.

```bash
# On each DB VM
sudo apt-get install -y clevis clevis-luks clevis-systemd

# Bind the LUKS device to a tang server (run a tang server on a trusted,
# separate host first; 2+ tang servers via an SSS pin for redundancy).
sudo clevis luks bind -d /dev/sdb tang '{"url":"http://tang.internal:7500"}'

# Enable unlock at boot
sudo systemctl enable clevis-luks-askpass.path

# Redundant 2-of-2 / 2-of-3 across tang servers (survives one tang outage):
sudo clevis luks bind -d /dev/sdb sss '{"t":2,"pins":{"tang":[{"url":"http://tang1.internal:7500"},{"url":"http://tang2.internal:7500"}]}}'
```

### Option B — Vault-stored passphrase

A systemd unit fetches the passphrase from Vault KV at boot and feeds it to
`cryptsetup`. **Beware the bootstrap dependency:** Vault's OWN storage must not
sit on a disk that depends on Vault to unlock (circular). Keep Vault on Shamir or
Transit auto-unseal (see [`deploy-vm430-432-vault.md`](./deploy-vm430-432-vault.md)),
and only use Vault custody for the *database/MinIO* disks.

```bash
# Store the LUKS passphrase once (per node) in Vault KV
vault kv put secret/hope/luks/pg-node1 passphrase="<the-luks-passphrase>"

# A boot-time unit (sketch) reads it back and opens the device:
#   PASS=$(vault kv get -field=passphrase secret/hope/luks/pg-node1)
#   printf '%s' "$PASS" | cryptsetup open /dev/sdb data_crypt -
```

> Whichever option: keep an offline copy of every passphrase (§3) so a total
> tang/Vault outage never makes the disk permanently unrecoverable.

---

## 3. Passphrase escrow (break-glass)

- Store each node's LUKS passphrase as a recovery key slot AND in a sealed
  offline escrow (physical envelope / offline password vault) — **never** in the
  repo, chat, or email.
- Add a second key slot for a recovery passphrase so rotating the primary does
  not require re-encrypting: `sudo cryptsetup luksAddKey /dev/sdb`.
- Record slot usage: `sudo cryptsetup luksDump /dev/sdb` (shows enabled key slots).
- The DR runbook ([`dr-break-glass-runbook.md`](./dr-break-glass-runbook.md))
  references this escrow for recovery.

---

## 4. Single-server & dev hosts

| Target | Action |
|---|---|
| **Single-server prod** | Enable LUKS full-disk encryption at OS install (Ubuntu "Encrypt the new installation"), OR put `/var/lib/docker` on a dedicated LUKS volume (same steps as §1.1, mount at `/var/lib/docker` before installing Docker). The compose volume `hope-postgres-data-pg18` then inherits encryption. |
| **Dev laptops** | Host full-disk encryption: macOS **FileVault** (`fdesetup status`) / Linux **LUKS**. Dev data is non-PHI but FDE is the baseline. No compose change needed — see the comment on the `postgres-data` volume in `infrastructure/docker/docker-compose.yml`. |

---

## 5. MinIO server-side encryption (SSE) — PHI media + backups

MinIO SSE encrypts objects at rest using a KMS. The largest PHI store is audio/
media behind `Media.uri`; the `pgbackrest` bucket holds DB backups + WAL.

### 5.1 Production — SSE-S3 via KES (auto-encrypt new objects)

```bash
# 1. Stand up KES backed by a real KMS (or Vault Transit) and point MinIO at it
#    (MINIO_KMS_KES_ENDPOINT / MINIO_KMS_KES_KEY_FILE / MINIO_KMS_KES_CAPATH).
#    See https://min.io/docs/minio/linux/operations/server-side-encryption.html

# 2. Create a key in KES (one shared key is fine; per-bucket keys also work)
mc admin kms key create homelab hope-sse-key

# 3. Enable automatic SSE-S3 on the PHI media + backup buckets
for b in recordings generated-audio documents pgbackrest backups; do
  mc encrypt set sse-s3 "homelab/$b"
done

# 4. Verify
mc encrypt info homelab/recordings    # -> Auto encryption 'sse-s3' is enabled
```

> Existing objects written before SSE was enabled are NOT retroactively
> encrypted. Re-write them (copy-in-place) if they must be encrypted:
> `mc cp --recursive --attr "x-amz-server-side-encryption=AES256" homelab/recordings homelab/recordings`.

### 5.2 Dev — built-in single-key KMS (opt-in)

The dev compose ships the hooks commented out (`infrastructure/docker/docker-compose.yml`):
uncomment `MINIO_KMS_SECRET_KEY` on the `minio` service and the
`mc encrypt set sse-s3 ...` lines in `minio-setup`, then recreate:

```bash
openssl rand -base64 32   # -> use as MINIO_KMS_SECRET_KEY=hope-dev-key:<base64>
docker compose -f infrastructure/docker/docker-compose.yml up -d --force-recreate minio minio-setup
```

### 5.3 Note on the pgBackRest bucket

pgBackRest already encrypts every file **client-side** with AES-256-CBC (Phase 4,
`repo1-cipher-type` in `pgbackrest.conf`). SSE-S3 on the `pgbackrest` bucket is
**defense-in-depth** (a second, server-side layer) — keep both; they are
independent (different keys, different blast radius).

---

## 6. Encrypted backup & restore verification (Phase 4)

After wiring `repo1-cipher-type=aes-256-cbc` + `PGBACKREST_REPO1_CIPHER_PASS`
(Vault), confirm encryption is actually in effect and that restore works.

### 6.1 Confirm the repo is encrypted

```bash
# Cipher must read 'aes-256-cbc' (it was 'none' before TASK-369)
docker exec patroni pgbackrest --stanza=hope-cluster info | grep -i cipher
# -> cipher: aes-256-cbc

# A fresh backup should succeed with the passphrase present in the container env
docker exec patroni pgbackrest --stanza=hope-cluster --type=full backup
docker exec patroni pgbackrest --stanza=hope-cluster verify
```

### 6.2 Prove the passphrase is required (negative test, staging only)

```bash
# Temporarily unset the cipher pass and confirm pgBackRest FAILS CLOSED
docker exec -e PGBACKREST_REPO1_CIPHER_PASS= patroni \
  pgbackrest --stanza=hope-cluster info
# -> error: unable to ... cipher passphrase required   (expected)
```

### 6.3 Restore verification (staging / throwaway container)

Use the temp-container restore from
[`deploy-vm500-502-postgres-ha.md`](./deploy-vm500-502-postgres-ha.md) §12.8 — it
works unchanged because the cipher pass is supplied via the container env. A
restore that completes proves the Vault-held passphrase decrypts the repo. Full
PITR / cluster restore lives in the DR runbook.

---

## 7. Verification checklist (at rest)

```bash
# LUKS present on the data disk — TYPE must be 'crypto_LUKS'
lsblk -f /dev/sdb
# NAME   FSTYPE      ... 
# sdb    crypto_LUKS ...
# └─data_crypt xfs   ... /data

# Active mapping + cipher
sudo cryptsetup status data_crypt
# type: LUKS2 / cipher: aes-xts-plain64 / keysize: 512 bits

# The LOCKED device is unreadable (negative proof). On a maintenance window:
sudo umount /data && sudo cryptsetup close data_crypt
sudo mount /dev/sdb /data    # -> mount: wrong fs type / unknown filesystem (EXPECTED — it's ciphertext)
sudo cryptsetup open /dev/sdb data_crypt && sudo mount /dev/mapper/data_crypt /data   # reopen

# Key slots (escrow audit)
sudo cryptsetup luksDump /dev/sdb | grep -A2 'Keyslots'

# MinIO SSE active on PHI/backup buckets
for b in recordings generated-audio documents pgbackrest; do mc encrypt info "homelab/$b"; done

# pgBackRest repo encrypted
docker exec patroni pgbackrest --stanza=hope-cluster info | grep -i cipher   # -> aes-256-cbc
```

| Check | Pass criteria |
|---|---|
| `lsblk -f` on data disk | `FSTYPE = crypto_LUKS` |
| `cryptsetup status` | `type: LUKS2`, `cipher: aes-xts-plain64` |
| Locked-volume mount | Fails / unreadable ciphertext |
| MinIO `mc encrypt info` | `sse-s3` enabled on media + backup buckets |
| `pgbackrest info` | `cipher: aes-256-cbc` |
| Negative cipher-pass test | pgBackRest fails closed without the passphrase |

---

## 8. What still requires an operator (cannot be done from the repo)

- Run §1 LUKS formatting on each VM (block-device + root access).
- Choose + configure auto-unlock custody (§2) and escrow passphrases (§3).
- Stand up KES/KMS and enable MinIO SSE (§5.1).
- **Rotate the exposed `pgbackrest-svc` MinIO credentials** that were previously
  committed in `pgbackrest.conf` (deploy-vm402-minio.md §9b.3), then store the
  new pair + the cipher passphrase in Vault (`secret/hope/PGBACKREST_*`).
- Enable server-side Postgres TLS on Patroni/PgBouncer (Phase 2 dependency) so
  the `sslmode=require` clients can connect.

See [`infrastructure/SECURITY_DEPLOYMENT_GUIDE.md`](../../infrastructure/SECURITY_DEPLOYMENT_GUIDE.md)
for the consolidated operator action list.
