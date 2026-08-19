# MinIO PHI Object Backup & Recovery

**Status**: Design — approved for build on the Tier-1 half, **deferral pending owner sign-off** on the Tier-2 half (§10).
**Subject**: object storage on VM 402 (`10.10.1.102:9000`) — the buckets holding clinical audio recordings and patient attachments.
**Live audit date**: 2026-08-08. Every number in §2 was measured on the running system on that date; §12 lists what was *not* verified.
**Companion**: [Vault backup & restore](../vault/vm-cluster-seal-unseal.md#10-backup--restore) — the house standard this design deliberately copies (encryption model, credential scoping, retention, tested restore).

---

## 1. The one thing to understand

There is **no backup of any kind** for the object store. Not partial, not stale — none.

Nor is there any of the defence-in-depth that would soften that: no bucket versioning, no
replication, no server-side encryption, no object lock, no lifecycle rule on any `hope-*`
bucket, no LUKS on the host disk, and no Proxmox backup job for the VM. Every clinical
recording exists exactly once, in one place, in plaintext, on one consumer-grade machine.

Two facts make this materially worse than "a service lacks a backup":

1. **The application's MinIO credential is root-equivalent.** The access key the platform uses
   (`hope-v2-dev`) is a MinIO service account whose `ParentUser` is `minioadmin` and whose
   `Policy` is `implied` — it inherits the root account's implicit full-admin policy. A bug or a
   leaked k8s Secret can delete every object in every bucket, including the Postgres backups and
   the Vault snapshots. With no versioning, that deletion is final.
2. **This machine is also the destination for everyone else's backups.** pgBackRest writes
   Postgres backups to `s3://pgbackrest` on this MinIO; the Vault cluster writes its Raft
   snapshots and its non-exportable Transit seal key to `s3://vault-backups` on this MinIO. So
   the platform's primary PHI object store, its database backup, and its secrets backup all sit
   on one physical host — and that host has no backup either.

The correct mental model is not "one system is missing a backup". It is: **one power supply,
one motherboard, one room stands between this platform and total, unrecoverable data loss.**

---

## 2. Ground truth — measured 2026-08-08

### 2.1 The deployment

| Property | Value | How verified |
|---|---|---|
| Host | Proxmox VM 402, `10.10.1.102`, Ubuntu 24.04, Docker | `qm list`, guest exec |
| MinIO release | `RELEASE.2025-04-22T22-12-26Z` | `mc admin info` |
| Topology | **Single-Node Single-Drive**, 1 pool / 1 drive / `EC:0` / erasure stripe size 1 | `mc admin info` |
| Capacity | 293 GB filesystem, **217 GB used, 64 GB free (78%)** | `df -h` |
| Contents | 200 GiB used, **31 buckets, 103,994 objects** | `mc admin info` |
| Disk encryption | **None.** Plain LVM/ext4, `/etc/crypttab` empty | `lsblk`, `cat /etc/crypttab` |
| Backup automation | **None.** No root cron, no user cron, no systemd timer, and `/usr/local/bin/minio-backup.sh` does not exist | `crontab -l`, `systemctl list-timers` |
| TLS | Serves HTTPS with a leaf from `ARCAAI Internal CA`, `notAfter = 2028-03-21` | [MinIO deploy doc §14](../../research/deployments/deploy-vm402-minio.md) |

> The `.minio.sys` metadata backup described in [`deploy-vm402-minio.md` §13](../../research/deployments/deploy-vm402-minio.md)
> **was never installed.** Any claim that backup "covers only metadata" is inaccurate; it covers
> nothing.

### 2.2 Data-protection features — all absent

| Feature | State | Evidence |
|---|---|---|
| Bucket versioning | Not enabled on any bucket checked | `mc version info` → "is un-versioned" on `hope-audio`, `hope-recordings-arcaai`, `hope-attachments-global`, `vault-backups`, `pgbackrest` |
| Bucket replication | Not configured | `mc replicate ls` → "replication configuration not set" |
| Server-side encryption | Not configured | `mc encrypt info` → "configuration was not found" |
| KMS / KES | Not deployed | `mc admin kms key status` → "KMS is not configured" |
| Lifecycle on `hope-*` | None | `mc ilm rule ls homelab/hope-audio` → "does not exist" |
| Object lock | Not enabled (and see §5.3 — cannot be added to an existing bucket on this release) | implied by un-versioned |

Lifecycle rules exist on exactly three buckets, all infrastructure: `vault-backups`
(`Expiration.Days = 30`), `pgbackrest` (`NoncurrentVersionExpiration 7d`), `gitlab-registry`.

### 2.3 Where the bytes actually are

Per-bucket, on disk (`du -sh /srv/minio/data/*`), largest first:

| Bucket | Size | What it is | Back up? |
|---|---|---|---|
| `gitlab-registry` | **181 G** | container image layers | **No** — see §3.1 |
| `hope-audio` | **15 G** | shared/legacy audio bucket, 12,520 objects | **Yes** |
| `hope-recordings-arcaai` | **2.9 G** | ArcaAI tenant recordings, 2,219 objects | **Yes** |
| `gitlab-artifacts` | 882 M | CI artifacts | No |
| `pgbackrest` | 718 M | Postgres backups | No — §3.3 |
| `langfuse` | 603 M (69 MiB logical, 56,273 objects) | LLM trace events | **Owner call** — §3.4 |
| `gitlab-uploads` | 233 M | GitLab attachments | No |
| `hope-recordings-global` | 230 M | Global-tenant recordings | **Yes** |
| `hope-audio-global` | 205 M | orphaned pre-rename recordings | **Yes** — §3.2 |
| `audio` | 135 M | 33 objects, `session_*.wav`, **no producer in the codebase** | **Yes** (pending triage) |
| `gitlab-lfs`, `gitlab-runner-cache` | 45 M, 26 M | git LFS, CI cache | No |
| `gitlab-pages`, `hope-attachments-global` | 388 K, 312 K | — / patient attachments | No / **Yes** |
| `vault-backups` | 148 K | Vault Raft + seal backups | No — §3.3 |
| `tts-audio` | 72 K | **no producer in the codebase** | **Yes** (pending triage) |
| 15 further `hope-*` and `gitlab-*` buckets | 4 K each | empty | Yes if `hope-*` (they will fill) |

**87% of the object store is a container registry.** The PHI-shaped surface is **~18.6 GB**.

### 2.4 What the PHI bytes consist of

Measured inside the four non-empty audio buckets:

| Bucket | `complete.wav` | `chunk_*.pcm` | `transcript.json` + `metadata.json` | total |
|---|---|---|---|---|
| `hope-audio` | 7.5 G | 7.2 G | 45 M | 15 G |
| `hope-recordings-arcaai` | 1.4 G | 1.4 G | 5 M | 2.9 G |
| `hope-recordings-global` | 112 M | 116 M | 0.7 M | 230 M |
| `hope-audio-global` | 106 M | 96 M | 1.0 M | 205 M |

Roughly **half of every PHI byte is `chunk_*.pcm`** — the interim PCM snapshots a streaming
session writes every snapshot interval, sitting in the same session directory as the finished
`complete.wav`. See §3.5 for whether that is safe to skip (short answer: probably, but it is not
worth the risk, because capacity is not the constraint).

### 2.5 Growth rate

`hope-recordings-arcaai` object counts by day-prefix: 16 (07-31), 20 (08-01), 508 (08-03), 250
(08-04), 183 (08-05), 646 (08-06), 536 (08-07). 2.9 GB accrued over roughly eight days ≈
**~350 MB/day gross, ~180 MB/day excluding chunks**, for one tenant at pilot volume.

### 2.6 Is this real patient data?

**Unknown, and not for this document to decide.** What was observed: the object names under
`hope-recordings-arcaai/…/jobs/` are dominated by `test-1.wav`, `test-2.wav`, `test-3.wav`,
`whatstheweatherlike_(mp3cut.net).wav`, `validation-0-47_(mp3cut.net).wav`, `asr_ml.wav`,
`SDK_ORTHO.mp3`, and `DannyBCM002_CTChestPlainContrast_Acute.wav` — an ASR test-fixture corpus,
not a clinical one. A minority (e.g. `50070681757578754_20250911_ml.wav`) are ambiguous.

Separately, the only Kubernetes namespace that exists is `hope-v2-dev`, its ConfigMap carries
`NODE_ENV=development`, and there is no staging or production namespace.

So the honest reading is: **today this is a pilot/test corpus; the gap becomes an active
PHI-loss exposure the moment real consultations start** — which is exactly what the
day-1 launch means. That timing is the whole argument for §10's recommendation. It is an
owner determination whether any object in these buckets is already real PHI (open question
**Q1**, §12).

---

## 3. What needs backing up, and what does not

### 3.1 Excluded: reproducible by construction

| Excluded | Size | Why |
|---|---|---|
| `gitlab-registry` | 181 G | Every layer is rebuildable from the Git history plus CI. Backing it up would cost 18× the entire PHI set to preserve something a `docker build` regenerates. |
| `gitlab-artifacts`, `gitlab-lfs`, `gitlab-runner-cache`, `gitlab-uploads`, `gitlab-*` | ~1.2 G | CI/SCM working data, owned by GitLab's own backup story, outside this document. |

This one exclusion is where the "don't back up what can be regenerated" rule earns its keep: it
takes the job from 209 GB to under 20 GB, which is what makes every option in §4 affordable.

### 3.2 Included: irreplaceable

Per the code map (see the citations in §13), the object store is the **only** copy of:

- `raw/complete.wav` — the clinical recording as captured. Nothing regenerates it.
- `processed/complete.wav` — the normalised/denoised derivative. *In principle* re-derivable from
  raw by re-running the STT pre-processing chain, but the chain is model- and
  configuration-versioned; a 2027 re-run does not reproduce a 2026 artifact. Treat as
  irreplaceable.
- Attachments in `hope-attachments-*` (excluding `.thumb.webp`, which is regenerated from the
  original).

The bucket list must include four groups that are easy to miss:

1. **`hope-audio` (15 G)** — the shared fallback bucket. Tenant bucket resolution ends in a
   `catch` that warns and falls back to the global `MINIO_AUDIO_BUCKET`, so a resolution failure
   silently writes one tenant's PHI here. It is not a legacy bucket; it is a live write target.
2. **`hope-audio-{global,arcaai,4bits,mumbai-hospital}`** — orphans of the `audio` → `recordings`
   slug rename. The rename rewrote the `TenantBucket` row in place and provisioned the *new*
   physical bucket; nothing migrated the objects or deleted the old buckets. They still hold real
   recordings, and **no `TenantBucket` row names them any more** — they are reachable only via the
   absolute `s3://` string in `Media.uri`. An operator enumerating buckets from the database would
   miss them entirely.
3. **`audio` (135 M) and `tts-audio` (72 K)** — no producer anywhere in the codebase. Provenance
   unknown; include them in the baseline (they cost nothing) and triage separately (**Q2**).
4. **Every empty `hope-*` bucket** — they are provisioned per tenant and will fill.

### 3.3 Deliberately excluded: other people's backups

- **`pgbackrest`** — owned by the Postgres backup lane. Copying it here would double-store the same PHI and
  create a circular dependency (the Postgres backup's backup living beside it). It is called out
  in §4.1 as part of the same failure domain, but it is not this job's payload.
  *Observation for the Postgres backup owner, not acted on here*: `pgbackrest.conf` sets no `repo1-cipher-type`,
  so Postgres backups are compressed but **not encrypted** at rest in a bucket with no SSE on a
  disk with no LUKS.
- **`vault-backups`** — excluded for a specific and non-obvious reason. Vault's backups are
  `age`-encrypted to a keypair whose **private half lives on the Proxmox host** at
  `pve-node1:/root/vault-pki/backup-age.key` (verified present, mode `600`, 2026-08-08). The
  destination this design proposes is also on `pve-node1`. Copying Vault ciphertext there would
  put it on the same machine as its own decryption key and collapse the key separation that
  design depends on. Vault's off-host copy is the Vault runbook's problem, not this one's.

### 3.4 Owner call: `langfuse`

69 MiB across 56,273 trace-event objects. Langfuse records LLM prompts and completions, and this
platform's prompts carry clinical text. If those traces contain unredacted transcript content
they are PHI and belong in the payload; if [telemetry PHI
guardrails](../telemetry-phi-guardrails.md) are effective they may not be. **Not decided here**
(**Q3**). Excluded from the default payload; adding it costs 69 MiB.

### 3.5 The `chunk_*.pcm` question — and why not to be clever

Excluding chunks would halve the payload, from ~18.6 GB to ~9.8 GB. The reasoning is sound:
`chunk_NNNN.pcm` are interim snapshots of a stream whose finished product is `complete.wav` in
the same directory, and their cleanup path is dead code anyway (it targets the wrong bucket and
the wrong prefix, and has no caller), so they accumulate forever.

**Do not exclude them, at least not initially.** Three reasons:

1. Byte-equivalence has **not** been proven. `complete.wav` is a WAV container; chunks are raw
   PCM; the processed variants may differ in more than framing. An exclusion rule built on an
   unverified equivalence is exactly the kind of cleverness that turns a backup into a
   near-backup.
2. For a session that **crashed mid-stream, the chunks are the only copy** — there is no
   `complete.wav` to fall back to. Any exclusion must therefore be conditional
   ("skip `chunk_*.pcm` only where a sibling `complete.wav` exists"), which is more logic to get
   wrong for no benefit.
3. **Capacity is not the constraint.** 18.6 GB against 406 GB of free destination (§4.2) is 4.6%.
   Halving it buys nothing.

Revisit only if the payload approaches the destination's capacity, and only after a sampled
duration/content equivalence check passes. Until then: back up everything in the `hope-*`
buckets, verbatim.

### 3.6 Included even though reproducible: `transcript.json` / `metadata.json`

~51 MB total, and genuinely reproducible — Postgres holds the authoritative transcript in
`TranscriptionJob.encryptedResultText` (Vault-Transit `hope-phi` ciphertext) and in
`ContextItem.encryptedContent`. Keep them anyway: they make a restored archive
self-describing, and 51 MB is noise. **Note the corollary — transcripts survive a total object-store
loss; audio does not.** That asymmetry is the single most useful fact for anyone triaging a real
incident.

---

## 4. Where the backup goes

### 4.1 State the obvious thing plainly

MinIO is on the same Proxmox host as everything else. Verified 2026-08-08: `pvecm nodes` reports
this is not a cluster; every `10.10.1.x` neighbour is a `bc:24:11:*` virtual NIC on this one
machine. There is no second node, no second site, and no NAS.

**A backup that stays on this host is not disaster recovery.** It does not survive fire, theft,
flood, a failed PSU, a hypervisor-level ransomware event, or the machine simply not coming back.
Anyone who writes "MinIO is backed up" after building only the on-host tier has made the
situation worse than leaving it visibly broken, because the next person will believe it.

What an on-host-but-off-MinIO copy **does** buy is real, and is the more likely set of failures:

| Threat | On-host copy helps? |
|---|---|
| Application bug or leaked credential deletes objects (root-equivalent — §1) | **Yes** — the app cannot reach the hypervisor filesystem |
| MinIO backend corruption / bad upgrade / `EC:0` bitrot | **Yes** |
| Operator error (`mc rm --recursive`, bucket deleted) | **Yes** |
| VM 402 disk failure | **Yes** (destination is a different physical disk) |
| Host loss — fire, theft, flood, PSU, board | **No** |
| Ransomware with hypervisor root | **No** |

So the honest framing is two tiers, and they must be named separately and never conflated:

- **Tier 1 — on-host, off-MinIO.** Covers rows 1–4. Cheap, buildable today. §5–§8.
- **Tier 2 — off-site.** Covers rows 5–6. Requires an owner decision. §10.

### 4.2 The Tier-1 destination

The only spare capacity on the host is `/mnt/medish` — and it comes with sharp edges that change
the design:

| Property | Value | Consequence |
|---|---|---|
| Device | `/dev/sda2`, **USB-attached Lexar E6**, 954 GB | Different physical disk from the NVMe holding every VM — survives NVMe failure. Also *removable*, which §10 turns into an advantage. |
| Free space | **406 GB** | ~20× the payload. Not a constraint. |
| Filesystem | **exFAT**, mounted `uid=65534,gid=65534,fmask=0002,dmask=0002` | **exFAT has no POSIX permissions and no ownership.** `chmod` is a no-op; every file is world-readable. Encryption is not a nicety here — it is the *only* available access control. |
| Journaling | **None** (exFAT) | A power cut mid-write can corrupt the volume. The design must self-verify integrity rather than assume it. |
| SMART | Not readable through the USB bridge (`Unknown USB bridge [0x21c4:0xb06a]`) | No health telemetry on the backup medium. Assume it will fail without warning. |
| Current contents | 548 GB of ML datasets, `archive/keys/`, `ssh.zip`, `tap.git` (a private key) | It is a shared scratch disk, not a vault. Anything written in the clear is exposed to every user on the host and to anyone who unplugs the drive. |

The NVMe is not an alternative: the `pve` volume group has **16.25 GB free** and the `data`
thinpool is **83.73% full**. There is no room, and it is the same disk as the VMs anyway.

> **Not a backup, but worth knowing it exists**: an LVM thin snapshot
> `snap_vm-402-disk-1_task636-pre-metrics-restart` of VM 402's disk is currently held on that
> same 83.73%-full thinpool. It is a same-disk, same-pool point-in-time copy taken by another
> workstream. It does not survive disk loss, it consumes pool capacity, and it must not be
> counted as data protection.

### 4.3 Where the job runs, and why that matters

Run it **on `pve-node1`**, not on VM 402 and not in the cluster. That placement is the whole
point:

- `/mnt/medish` is local to `pve-node1` — no network write path to compromise.
- Neither an application compromise nor a MinIO compromise reaches the hypervisor filesystem.
  The blast radius from §1 stops at the bucket boundary.
- Reading over the **S3 API** (not by copying `/srv/minio/data`) keeps the archive portable and
  version-independent. The on-disk backend layout (`<bucket>/<key>/xl.meta` + part files) is a
  MinIO internal; restoring it by file copy is fragile and couples the backup to a server
  release. Archive the *objects*, keyed by their real `s3://bucket/key`.

`pve-node1` needs `mc` and `age` installed (verified 2026-08-08: neither is present).

---

## 5. Encryption, and who can decrypt

### 5.1 The requirement

`/mnt/medish` cannot enforce file permissions (§4.2). A plaintext PHI archive there would be
readable by every user on the hypervisor and by anyone who walks off with a USB drive. That is a
new breach surface, not a safety net.

**Every archive is `age`-encrypted before it touches the destination.** This copies the Vault
backup's model exactly ([`vm-cluster-seal-unseal.md` §10](../vault/vm-cluster-seal-unseal.md#10-backup--restore)):
encrypt to a public key held on the writing host, keep the private key elsewhere, so *the host
that writes the backups cannot read them back*.

### 5.2 Key custody — and a trap specific to this host

Use a **new, dedicated keypair** — call it `phi-backup-age`. Do **not** reuse the Vault backup
keypair, because its private half is on `pve-node1` (§3.3), which is precisely the host that must
not be able to read PHI.

| Half | Where it lives |
|---|---|
| `phi-backup-age.pub` | `pve-node1:/root/phi-backup/age.pub`, world-readable — it is a public key |
| `phi-backup-age.key` | **Offline only.** Same custody procedure and same physical location as the Vault Shamir shares. Never on `pve-node1`, never on VM 402, never in Git, never in Vault (Vault's own recovery may depend on this backup). |

**The corollary is unavoidable and must be written on the envelope: lose the private key and
every backup ever taken is permanently unreadable.** Escrow at least two copies in separate
physical custody, and verify them during the drill in §9 — a key that has never decrypted
anything is a key you do not know you have.

### 5.3 What about just turning on versioning and object lock?

Worth considering, because it directly counters the §1 blast radius, and worth understanding why
it is not sufficient.

- **Versioning**: MinIO SNSD deployments have implemented a zero-parity erasure-coded backend with
  versioning support since `RELEASE.2022-06-02T02-11-04Z`; this server is `2025-04-22`, so it
  should be available on an existing bucket. *Verify on a scratch bucket before relying on it* —
  MinIO's documentation has since split between the community server and the commercial AIStor
  line, and the two do not describe identical capabilities.
- **Object lock**: object locking traditionally had to be enabled **at bucket creation**. MinIO
  removed that restriction in `RELEASE.2025-05-20T20-30-00Z` — **one month after this server's
  release**. So on the running version, object lock cannot be added to any existing bucket;
  it would require creating new buckets and migrating.
- **Neither is a backup.** Both live on the same drive, in the same MinIO, in the same VM, on the
  same host. They protect against deletion; they do nothing about disk failure, corruption, or
  host loss.

**Recommendation**: enable versioning on the `hope-*` buckets as a cheap complement (it closes
the accidental-overwrite and accidental-delete window immediately, and the workload is
append-mostly so version growth is small) — but explicitly **as a complement, never as the
answer**, and only after confirming free space, which is at 78%. Not part of this design's
critical path.

---

## 6. Credential scoping

Follow the `vault-backup-svc` precedent — **but invert the verbs, and understand why.**

The precedent policy, read live 2026-08-08, is:

```json
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:PutObject"],"Resource":["arn:aws:s3:::vault-backups/*"]},
  {"Effect":"Allow","Action":["s3:ListBucket"],"Resource":["arn:aws:s3:::vault-backups"]}]}
```

That shape is write-only because there MinIO is the backup **destination**: the credential can
deposit backups and cannot read or erase its own history.

Here MinIO is the backup **source**. The mirror-image scoping is read-only:

```json
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:GetObject"],
   "Resource":["arn:aws:s3:::hope-audio/*","arn:aws:s3:::hope-audio-*/*",
               "arn:aws:s3:::hope-recordings-*/*","arn:aws:s3:::hope-attachments-*/*",
               "arn:aws:s3:::audio/*","arn:aws:s3:::tts-audio/*"]},
  {"Effect":"Allow","Action":["s3:ListBucket"],
   "Resource":["arn:aws:s3:::hope-audio","arn:aws:s3:::hope-audio-*",
               "arn:aws:s3:::hope-recordings-*","arn:aws:s3:::hope-attachments-*",
               "arn:aws:s3:::audio","arn:aws:s3:::tts-audio"]}]}
```

`GetObject` + `ListBucket` on the named buckets. **No `PutObject`, no `DeleteObject`, no access
to `pgbackrest`, `vault-backups`, or any `gitlab-*` bucket.** The backup reader must never be
able to modify what it is reading, and a leak of it must not widen into the other tenants of
this MinIO.

Attach it to a dedicated user (`hope-phi-backup-svc`) with its own service-account key pair, and
store that key pair on `pve-node1` only — **not** in the k8s Secret, not in Git, not in the
repo's `.env` files.

> Related, and not fixed by this design: the application's own credential is root-equivalent
> (§1). Scoping *it* down to its own buckets is a separate change with a separate blast radius,
> and belongs with the credential-scoping lane, not here. Recorded as **Q4**.

---

## 7. Retention

### 7.1 What this repo can and cannot establish

**It cannot establish a clinical or legal records-retention requirement for audio recordings, and
this document will not invent one.** A repo-wide search finds retention obligations discussed only
for *audit logs* (HIPAA §164.316(b)(2)(i), six years) — a different obligation covering different
artifacts. The only retention artifact touching general data is a seed default
(`general` / `retention-days` = 365) that governs nothing about objects.

The retention period for clinical recordings is set by the jurisdiction the covered entity
operates in and by the entity's own records policy. It is **owner-owned** (**Q5**).

### 7.2 Backup retention is a different question, and this one we can answer

Backup retention answers "how far back can we recover from?", not "how long must the record be
kept?". Those are independent, and conflating them is a common and expensive mistake.

**Proposed: 30 days**, matching the `vault-backups` ILM rule already in force
(`{"Expiration":{"Days":30}}`, read live) so the estate has one number rather than two.

At ~350 MB/day and a ~18.6 GB baseline, 30 days of daily deltas plus monthly full baselines is
roughly **40–60 GB** against 406 GB free. Comfortable, with years of headroom at current growth.

### 7.3 Two interactions that must be written down

1. **Backup retention does not satisfy a records-retention obligation.** If an object is deleted
   from MinIO and then ages out of the 30-day window, it is gone. If a legal obligation to retain
   it for years exists (§7.1 — unestablished), the *primary* store must satisfy it. The backup is
   a recovery mechanism, not an archive.
2. **Retention works against right-to-erasure.** A patient erasure request satisfied by deleting
   the object from MinIO is **not complete for another 30 days**, because the object still exists
   in backup archives. Every erasure procedure must either (a) state and accept that window, or
   (b) include a step to purge the archives — which, because the archives are encrypted tarballs,
   means re-writing them. Option (a) with a documented window is the normal and defensible
   choice; it just has to be an actual written choice. Flag to whoever owns the erasure procedure
   (**Q6**).

---

## 8. The Tier-1 design

### 8.1 Shape

Nightly, on `pve-node1`:

```
mc find (objects newer than last success)
      → stage → tar → age -r <phi-backup-age.pub>
      → /mnt/medish/backups/hope-phi/
```

One `age`-encrypted tar per run. Monthly, the same job takes a **full baseline** (no time
window) so that a restore never needs to chain more than ~31 archives and a missed run can never
create a permanent gap.

This is deliberately the same shape as `/opt/vault/backup.sh` — `tar | age | write to a scoped
destination`, one cron line, fail-closed on an empty archive. Same shape means same drill, same
failure modes, same thing to reason about at 3 a.m.

### 8.2 State, and why there is almost none

Delta selection uses object modification time, not a tracked object list:

```
window = now − (last successful run) + 1h slack
```

The workload is append-only (recordings are written once and never modified), so mtime selection
is exact, and the slack tolerates clock skew at the cost of re-copying a few objects.

The state is therefore a **single timestamp** — one integer in a plaintext file. This is not
incidental: **object keys are themselves PHI-bearing.** Keys look like
`{tenant}/{yyyy}/{MM}/streaming/{session-uuid}/raw/complete.wav`, and attachment keys carry the
user-supplied filename, which can be a patient name. A conventional "list of objects already
backed up" state file would be a plaintext PHI index sitting on a world-readable exFAT volume.
A timestamp is not.

For the same reason, the per-run **manifest** (`tar -tv` output, which lists real keys) is
`age`-encrypted alongside its archive. The **plaintext run log** carries only counts, byte
totals, and the archive's SHA-256 — never a key.

### 8.3 Layout

```
/mnt/medish/backups/hope-phi/
├── baseline/<YYYY-MM-DD>/<bucket>.tar.age        # monthly full
├── daily/<YYYY-MM-DD>/<bucket>.tar.age           # delta since last success
├── manifest/<YYYY-MM-DD>/<bucket>.list.age       # tar -tv, age-encrypted (contains keys)
├── STATE/last-success                            # unix timestamp, plaintext, no PHI
└── run.log                                       # counts + bytes + sha256 only, no keys
```

Tar sidesteps a real exFAT trap: exFAT forbids `: " * ? < > | \` in filenames, and object keys
are not guaranteed to avoid them. Inside a tar archive, arbitrary key bytes survive intact. It
also avoids writing 100k+ tiny files to a consumer USB volume.

### 8.4 The job

Authored here; **executed by the owner**. Nothing in this document has been run against live
infrastructure.

```sh
#!/bin/sh
# /root/phi-backup/backup.sh — HOPE PHI object backup (Tier 1).
# Reads MinIO over S3 with a READ-ONLY scoped credential; writes age-encrypted
# archives to the USB volume. This host holds only the PUBLIC age key: it can
# write these backups and cannot read them back. See docs/operations/storage/minio-phi-backup.md
set -eu

DEST=/mnt/medish/backups/hope-phi
PUB=$(cat /root/phi-backup/age.pub)
STATE="$DEST/STATE/last-success"
TS=$(date -u +%Y-%m-%d)
NOW=$(date -u +%s)
STAGE=$(mktemp -d /var/tmp/phibk.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT

# Buckets: every hope-* bucket, plus the two unattributed legacy buckets.
# NOTE: hope-audio and hope-audio-<tenant> are NOT legacy — see design doc §3.2.
BUCKETS=$(mc ls --json phibk | sed -n 's/.*"key":"\([^/]*\)\/".*/\1/p' \
          | grep -E '^(hope-|audio$|tts-audio$)')

# Monthly (1st of month) or first-ever run => full baseline, no time window.
if [ "$(date -u +%d)" = "01" ] || [ ! -f "$STATE" ]; then
  KIND=baseline; WINDOW=""
else
  LAST=$(cat "$STATE")
  AGE_S=$(( NOW - LAST + 3600 ))            # +1h slack for clock skew
  KIND=daily;    WINDOW="--newer-than ${AGE_S}s"
fi

mkdir -p "$DEST/$KIND/$TS" "$DEST/manifest/$TS" "$DEST/STATE"

for B in $BUCKETS; do
  rm -rf "$STAGE/$B"; mkdir -p "$STAGE/$B"
  # shellcheck disable=SC2086  # WINDOW is intentionally word-split (empty on baseline)
  mc find "phibk/$B" $WINDOW --exec "mc cp -q {} $STAGE/$B/" >/dev/null 2>&1 || true
  [ -n "$(find "$STAGE/$B" -type f -print -quit)" ] || continue   # nothing new

  OUT="$DEST/$KIND/$TS/$B.tar.age"
  tar cf - -C "$STAGE" "$B" | age -r "$PUB" -o "$OUT"
  [ -s "$OUT" ] || { echo "FATAL: empty archive for $B" >&2; exit 1; }   # fail closed

  # Manifest lists real object keys => PHI-bearing => encrypted.
  tar tvf - < /dev/null >/dev/null 2>&1 || true
  ( cd "$STAGE" && tar tvf - </dev/null 2>/dev/null; find "$B" -type f ) \
    | age -r "$PUB" -o "$DEST/manifest/$TS/$B.list.age"

  # Plaintext log: counts, bytes, checksum. Never a key.
  printf '%s %s %s files=%s bytes=%s sha256=%s\n' \
    "$(date -u +%FT%TZ)" "$KIND" "$B" \
    "$(find "$STAGE/$B" -type f | wc -l)" "$(stat -c %s "$OUT")" \
    "$(sha256sum "$OUT" | cut -d' ' -f1)" >> "$DEST/run.log"
done

echo "$NOW" > "$STATE"
```

```
# /etc/cron.d/hope-phi-backup  — 03:15 UTC, after Vault's 02:30/02:45 window
15 3 * * *  root  /root/phi-backup/backup.sh >> /var/log/hope-phi-backup.log 2>&1
```

Prerequisites on `pve-node1`: `apt install age`; install `mc`; `mc alias set phibk
https://10.10.1.102:9000 …` using the **read-only** `hope-phi-backup-svc` key from §6; pin the
MinIO leaf certificate the way the Vault VMs do (`~/.mc/certs/CAs/minio.crt` — **and note it
expires `2028-03-21`; backups fail closed when it lapses**).

### 8.5 Pruning

Deliberately **not** in the nightly job. A backup script that deletes is a backup script that can
delete the wrong thing at 3 a.m. Run pruning as a separate, dated, reviewed step:

```sh
find /mnt/medish/backups/hope-phi/daily    -mindepth 1 -maxdepth 1 -type d -mtime +30
find /mnt/medish/backups/hope-phi/baseline -mindepth 1 -maxdepth 1 -type d -mtime +90
```

(listed, not deleted — confirm, then remove.) Keep baselines longer than dailies: a baseline is
the anchor every subsequent delta restores on top of.

### 8.6 Monitoring

exFAT is unjournaled and the drive reports no SMART (§4.2), so integrity must be actively
checked rather than assumed:

- Alert if `STATE/last-success` is older than 36 hours.
- Alert if a nightly run wrote 0 bytes on a day with recorded consultations.
- **Weekly**: re-verify the SHA-256 of every archive in the last 7 days against `run.log`. This
  needs no decryption, so it can run unattended — and it is the only defence against silent
  corruption on a consumer USB volume.
- Alert if `/mnt/medish` free space drops below 100 GB.

Wire these into whatever monitoring lands; until then they are an operator check.

---

## 9. Restore — and the drill that makes it real

An untested restore is not a backup. The Vault runbook sets the bar
([§10 restore drill](../vault/vm-cluster-seal-unseal.md#restore-drill--performed-2026-08-07-passed)),
and the lesson from that drill transfers directly: the row that mattered was not "the archive
extracts" but "the restored key actually decrypts live ciphertext". **The analogue here is not
"the .wav file extracts" — it is "the restored object is byte-identical AND `Media.uri` still
resolves to it."** An object restored under a different bucket or key is unreachable and
therefore worthless, because `Media.bucketId` is `NULL` in practice and `Media.uri` is the only
pointer that exists.

### 9.1 Restoring a single object

```sh
# 1. Find which archive holds it (manifests are encrypted; needs the offline key).
for m in /mnt/medish/backups/hope-phi/manifest/*/<bucket>.list.age; do
  age -d -i <phi-backup-age.key> "$m" | grep -q "<object-key>" && echo "$m"
done

# 2. Extract just that object.
age -d -i <phi-backup-age.key> \
    /mnt/medish/backups/hope-phi/<kind>/<date>/<bucket>.tar.age \
  | tar xf - "<bucket>/<object-key>"

# 3. Put it back at the EXACT original bucket + key. Requires admin MinIO
#    credentials — the backup credential is read-only by design (§6).
mc cp "<bucket>/<object-key>" "admin/<bucket>/<object-key>"
```

### 9.2 Restoring a whole bucket

Restore the most recent **baseline**, then every **daily** delta after it, in chronological
order, extracting each over the previous. Because the workload is append-only, ordering conflicts
are not expected — but restore in order anyway.

### 9.3 The drill — run before this is called done

Perform in a scratch namespace, never against live buckets. Record the result in a table in this
document, matching the Vault drill's format.

| # | Check | Pass criterion |
|---|---|---|
| 1 | Archive decrypts with the **escrowed offline** key (not a copy on the host) | `age -d` succeeds |
| 2 | Object count matches the run-log count for that archive | equal |
| 3 | Restore a sampled `raw/complete.wav` into a scratch bucket | `sha256sum` identical to the live object |
| 4 | Restored audio is genuinely playable, not merely present | `ffprobe` reports the expected duration and codec |
| 5 | Restore a sampled attachment | byte-identical |
| 6 | **`Media.uri` for the sampled object still resolves after restore** | the app can presign and fetch it |
| 7 | Full-bucket restore of the smallest PHI bucket end to end | object count and total bytes match live |
| 8 | Time the restore of one 2.9 GB bucket | record it — this is the RTO number |
| 9 | Cold-start test: an operator who did not build this can follow §9.1 alone | succeeds without asking the author |

**Row 6 is the one that matters.** Rows 1–5 prove the archive is well-formed. Row 6 proves the
platform can actually *use* what was restored.

**Cadence**: at build time, then quarterly, then after any MinIO upgrade or bucket-naming change.

---

## 10. Tier 2 — off-site — and the recommendation

### 10.1 What Tier 1 leaves on the table

Everything in §4.1's bottom two rows. If the Proxmox host is lost — fire, theft, flood, a dead
board, hypervisor-level ransomware — Tier 1 is lost with it, because it is on the same machine.

And the loss is not confined to audio. Because pgBackRest and the Vault backups also target this
same MinIO on this same host (§1), **host loss destroys the clinical recordings, the Postgres
backup, and the Vault seal-key backup simultaneously.** There is nothing left to restore from and
nothing left to restore *with*.

### 10.2 Options, with real costs

The payload is ~18.6 GB. **Cost is not the obstacle** — every cloud option below is under
$2/month. The obstacle is a Business Associate Agreement.

**And encryption does not remove that obstacle.** HHS's cloud-computing guidance is explicit: a
CSP that *stores* ePHI is a business associate and needs a BAA **even when the data is encrypted
and the CSP has no key** — the "no-view services" case. The conduit exception covers
transmission only, not storage. Uploading `age`-encrypted PHI to a provider without a BAA is a
HIPAA violation regardless of how good the encryption is.

| Option | Recurring cost | BAA | Assessment |
|---|---|---|---|
| **Second USB drive, rotated off-site** | ~$80 once | **Not required** — the data never leaves the covered entity | Cheapest, fastest, no counterparty. RPO = rotation interval (weekly ⇒ up to 7 days of loss). Depends on human discipline; a rotation that quietly stops looks exactly like one that works. Archives are already `age`-encrypted, so a lost drive is not a plaintext exposure — see the caveat below. |
| **Backblaze B2** | ~$0.11/mo | Offered — **verify current terms** | Cheap, S3-compatible, `mc mirror` works unchanged. |
| **Wasabi** | ~$7/mo (1 TB minimum) | Offered — **verify current terms** | Flat pricing, no egress fees, but a 1 TB floor for 18 GB. |
| **AWS S3 → Glacier Deep Archive** | pennies/mo + restore egress | Yes, via the AWS BAA (S3 is HIPAA-eligible) | Strongest compliance posture; slowest restores (hours); most account setup. |
| **Cloudflare R2** | ~$0.28/mo | **Enterprise plans only** | Tempting because a Cloudflare tunnel is already in use — but the BAA gate likely disqualifies it at this scale. Do not assume the existing tunnel account carries a BAA. |

> **Caveat on "encrypted, so a lost drive is fine."** HHS's breach-notification safe harbour turns
> on encryption meeting NIST SP 800-111. `age` (X25519 + ChaCha20-Poly1305) is strong modern
> cryptography but is **not FIPS 140-validated**, which is what that guidance points at. Whether
> it qualifies is a compliance judgement, not an engineering one. Do not promise safe harbour in
> a breach-response plan on the strength of this document (**Q7**).

### 10.3 Recommendation

**Build Tier 1 now. Defer Tier 2 with an explicit, dated risk acceptance.**

Build Tier 1 because it is genuinely cheap — under 20 GB, one cron line, a script shaped like one
that already runs in production — and because it closes the *likely* failure modes (application
bug, credential compromise, operator error, disk failure) that a healthcare platform will meet
long before it meets a fire.

Defer Tier 2 not because it is expensive (it costs cents) but because the decision it requires
cannot be made by an engineer or an agent: it is a choice of counterparty and a signed BAA, or a
commitment to a physical drive-rotation discipline. Making that choice badly — shipping PHI to a
provider without a BAA — is worse than the gap it closes.

**Do not defer Tier 2 open-endedly.** It is a one-hour decision plus a $0.11/month bill, or an
$80 drive. §11 exists so it gets a date rather than drifting.

---

## 11. Risk acceptance — for the owner

The Tier-2 deferral means accepting a specific, bounded risk. Stated plainly, without hedging:

> **What is lost, in what scenario.** If the Proxmox host `pve-node1` is destroyed or becomes
> permanently unavailable — fire, theft, flood, water damage, a failed board or PSU with no
> spare, or ransomware obtaining hypervisor root — then **every clinical audio recording and
> every patient attachment ever captured by this platform is permanently and irrecoverably
> lost.** So is the Postgres database and its pgBackRest backup, and so is the Vault Transit
> seal-key backup, because all three live on that same machine (§1, §10.1).
>
> There is no second copy anywhere. Recovery would not be slow or partial. It would be
> impossible.
>
> Tier 1 (§5–§9) does not change this. Tier 1 protects against application bugs, credential
> compromise, operator error, and the failure of VM 402's own disk. It does **not** protect
> against the loss of the host, because it lives on the host.

**Accepted by**: _______________________   **Date**: ______________

**Tier-2 decision due by**: ______________
*(the decision — which destination, and BAA or off-site drive rotation — not the implementation)*

**Reviewed on**: ______________
*(re-review whenever the answer to Q1 changes from "test data" to "real patient data", whichever
comes first — that transition is what converts this from a housekeeping gap into a reportable
one)*

---

## 12. Open questions — owner, not engineering

| # | Question | Why it cannot be answered here |
|---|---|---|
| **Q1** | **Do the `hope-recordings-*` / `hope-audio*` buckets already contain real patient data**, or is it all pilot/test material? §2.6 shows a test-fixture-dominated corpus and a `hope-v2-dev`-only cluster, but a minority of objects are ambiguous. | Determining whether an audio file is a real consultation requires knowing who was recorded. Not inferable from a filename, and not something to guess at. Drives the urgency of everything above. |
| **Q2** | What are the `audio` (135 MB, 33 objects) and `tts-audio` (72 KB) buckets? Neither has a producer anywhere in the codebase. | Provenance is outside the repo. They are included in the backup payload by default because they cost nothing; they may instead warrant deletion. |
| **Q3** | Do `langfuse` trace events contain unredacted clinical text? | Depends on whether the telemetry PHI guardrails are effective in practice, which needs an inspection decision, not a grep. If yes, langfuse joins the payload (69 MiB). |
| **Q4** | Should the application's MinIO credential be scoped down from root-equivalent? | A credential rotation with a real blast radius; belongs with the credential-scoping lane. Recorded here because it is the reason the backup destination must be off-MinIO. |
| **Q5** | What is the records-retention requirement for clinical audio in this deployment's jurisdiction? | A legal/clinical determination. The repo establishes nothing beyond audit-log retention, and this document refuses to invent a number. |
| **Q6** | How does right-to-erasure interact with a 30-day backup window? | Needs a written choice by whoever owns the erasure procedure — accept the window, or purge archives on erasure. §7.3. |
| **Q7** | Does `age` encryption satisfy the breach-notification safe harbour for an off-site drive? | A compliance judgement about NIST SP 800-111 conformance, not an engineering one. §10.2. |
| **Q8** | Tier-2 destination: BAA counterparty, or physical drive rotation? | The deferral in §10.3/§11 exists precisely because this is the owner's call. |

---

## 13. Evidence

**Verified live on 2026-08-08** (read-only; no bucket, policy, user, credential, or replication
change was made):

- `qm list`; `pvecm nodes`; `/etc/pve/jobs.cfg` (absent); `/etc/pve/vzdump.cron` (empty);
  `/etc/pve/storage.cfg`; `lsblk`; `findmnt /mnt/medish`; `udevadm info /dev/sda`; `vgs`; `lvs`
- On VM 402: `df -h`; `du -sh /srv/minio/data/*`; `crontab -l` (root and `dell`);
  `systemctl list-timers`; `/etc/crypttab`; `mc admin info`; `mc ls`; `mc ls --summarize
  --recursive`; `mc version info`; `mc replicate ls`; `mc encrypt info`; `mc ilm rule ls|export`;
  `mc admin kms key status`; `mc admin user list`; `mc admin policy list|info`;
  `mc admin user svcacct ls|info`
- On VM 434: `/opt/vault/backup.sh`, `crontab -l` — the house-standard precedent
- On VM 500: `pgbackrest.conf` (secret lines filtered)
- On VM 200 (k3s): `kubectl get ns`; `kubectl get pods -A`; `hope-config` ConfigMap; the key
  *names* of the `hope-secrets` Secret and the *lengths* of the MinIO values (never the values)

**Taken from the codebase**, not from the live system: the bucket-naming derivation
(`TenantBucketFactory.buildBucketName`), the `audio`→`recordings` rename orphaning
(`seed/05a-tenant-bucket.ts`), the audio-bucket resolution fallback chain
(`transcription-job.controller.ts`), the streaming write paths (`stt/streaming/session_manager.py`,
`stt/storage/path_resolver.py`), the dead chunk-cleanup path (`stt/storage/blob_service.py`), the
`Media.uri` pointer and always-empty `Media.hash` (`media.prisma`, `storage.controller.ts`), and
the absence of any lifecycle/versioning/SSE caller.

**Not verified, and stated as such**: whether MinIO SNSD versioning genuinely works on this
release (§5.3 — test on a scratch bucket first); whether `chunk_*.pcm` are byte-recoverable into
`complete.wav` (§3.5 — deliberately not relied upon); the exact BAA terms of any provider in
§10.2; and everything in §12.

---

## 14. Related

- [Vault backup & restore](../vault/vm-cluster-seal-unseal.md#10-backup--restore) — the house standard: encryption model, credential scoping, retention, tested restore
- [MinIO deployment record](../../research/deployments/deploy-vm402-minio.md) — how VM 402 was built (its §13 backup script was never installed — §2.1)
- [Encryption-at-rest runbook](../../research/deployments/encryption-at-rest-luks-minio-sse-runbook.md) — LUKS/SSE specification, confirmed **not** deployed
- [DR break-glass runbook](../../research/deployments/dr-break-glass-runbook.md) — assumes the MinIO data disk is re-attached intact; this document is what covers the case where it is not
- [`09-infrastructure-devops.md` §Configuration Tiers](../../../.claude/rules/09-infrastructure-devops.md) — the PHI posture and where credentials may live

---

## 15. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Created. Grounded in a read-only live audit of VM 402 and `pve-node1`. Key findings: no backup of any kind exists (not even the metadata backup previously credited); the application's MinIO credential is root-equivalent (`ParentUser: minioadmin`, `Policy: implied`), so an app compromise can erase the PHI objects, the Postgres backups, and the Vault seal backup alike; 87% of the object store is a reproducible container registry, leaving a ~18.6 GB PHI surface; the only spare host capacity is a USB **exFAT** volume with no POSIX permissions, which makes encryption the sole available access control. **Recommendation: build Tier 1 (on-host, off-MinIO, age-encrypted, read-only-scoped) now; defer Tier 2 (off-site) with the dated risk acceptance in §11** — deferred because it requires a BAA counterparty or a drive-rotation commitment, not because of cost. | Claude |
