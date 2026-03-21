# Proxmox Shared Storage — External Disk via NFS

**Date**: 2026-03-12
**Host**: Dell Precision 7920 Tower — Proxmox VE 9.1
**Disk**: `/dev/sda2` (953.9 GB, exFAT) mounted at `/mnt/medish`
**Related**: [Network Topology](./proxmox-network-topology-design.md) | [GPU Setup](./proxmox-setup-dell-7920-step-by-step.md)

---

## Table of Contents

1. [Why NFS over Samba](#1-why-nfs-over-samba)
2. [Architecture Overview](#2-architecture-overview)
3. [Prepare the Disk on Proxmox Host](#3-prepare-the-disk-on-proxmox-host)
4. [Configure NFS Server on Proxmox Host](#4-configure-nfs-server-on-proxmox-host)
5. [Mount NFS Inside Each VM](#5-mount-nfs-inside-each-vm)
6. [Using Shared Storage with Docker](#6-using-shared-storage-with-docker)
7. [Per-Environment Access Control](#7-per-environment-access-control)
8. [Performance Tuning](#8-performance-tuning)
9. [Adding Samba Alongside NFS](#9-adding-samba-alongside-nfs)
10. [Verification](#10-verification)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Why NFS over Samba

All VMs in this homelab run Ubuntu Linux. NFS is the correct default:

| Factor | NFS | Samba (SMB) |
|--------|-----|-------------|
| Linux-to-Linux | Native kernel module, zero overhead | Userspace daemon, protocol translation |
| Throughput | Near-native disk I/O | 10–30% slower due to SMB protocol overhead |
| POSIX permissions | Full uid/gid, chmod, chown | Requires `force user` / `create mask` hacks |
| Docker bind mounts | Works directly | Permission mapping issues |
| Setup complexity | 3 commands on host | Samba config + user/password management |
| Proxmox integration | Native (Datacenter → Storage) | Not integrated |
| File locking | NFSv4 built-in | oplocks (works but different semantics) |
| macOS/Windows access | Possible but not native feel | Native for both |

**Decision**: Use NFS as the primary protocol. Add Samba only if you later need Mac/Windows desktop browsing (see [Section 9](#9-adding-samba-alongside-nfs)).

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  PROXMOX HOST (Dell 7920)                                           │
│                                                                     │
│  /dev/sda2 (954G) ──mount──▶ /mnt/medish                            │
│                               └── shared/                           │
│                                   ├── models/     (AI/ML models)    │
│                                   ├── datasets/   (training data)   │
│                                   ├── backups/    (DB dumps, VMs)   │
│                                   ├── media/      (audio, docs)     │
│                                   └── scratch/    (temp workspace)  │
│                                                                     │
│  NFS Server exports /mnt/medish to:                                 │
│    10.10.1.0/24 (vmbr1 — shared services)                           │
│    10.10.2.0/24 (vmbr2 — arca-dev)                                  │
│    10.10.3.0/24 (vmbr3 — arca-stg)                                  │
│    10.10.4.0/24 (vmbr4 — 4bits)                                     │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ubuntu-live-gpu (VM 101)     mounts 10.10.1.1:/mnt/medish          │
│  arca-dev-01     (VM 201)     mounts 10.10.2.1:/mnt/medish          │
│  arca-dev-02     (VM 202)     mounts 10.10.2.1:/mnt/medish          │
│  arca-stg-01     (VM 301)     mounts 10.10.3.1:/mnt/medish          │
│  arca-stg-02     (VM 302)     mounts 10.10.3.1:/mnt/medish          │
│  4bits-01–05     (VM 401–405) mounts 10.10.4.1:/mnt/medish          │
│                                                                     │
│  All VMs mount to: /mnt/shared                                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

Each VM connects to the NFS server via its own bridge gateway IP. This means traffic stays on the local bridge — no cross-subnet routing needed.

---

## 3. Prepare the Disk on Proxmox Host

### 3.1 — Identify the Filesystem

```bash
# On the Proxmox host
lsblk -f /dev/sda
blkid /dev/sda2
```

Current state:

```
NAME   SIZE       TYPE    MOUNTPOINTS
sda    953.9G     disk
├─sda1  16M       part
└─sda2 953.9G     part    /mnt/medish    (exFAT)
```

> **exFAT limitation**: The Linux kernel's exFAT driver does **not** implement `export_operations` (`encode_fh`), which NFS requires to generate stable file handles. This means `exportfs` will refuse to export an exFAT mount — even with `fsid=N`. A kernel patch was proposed in August 2024 but has not been merged as of kernel 6.17 (Proxmox VE 9.1). See **Section 3.4** below for the two workarounds.

### 3.2 — Make the Mount Persistent

The disk is already mounted at `/mnt/medish`. Make it survive reboots:

```bash
# 1. Get the UUID (more reliable than /dev/sda2 which can change on reboot)
blkid /dev/sda2
# Example: /dev/sda2: UUID="XXXX-XXXX" TYPE="exfat"

# 2. Add to /etc/fstab — replace UUID with your actual value
echo 'UUID=XXXX-XXXX /mnt/medish exfat defaults,nofail,uid=nobody,gid=nogroup,umask=002 0 0' >> /etc/fstab

# 3. Verify the fstab entry works
mount -a
df -h /mnt/medish
```

| Option | Purpose |
|--------|---------|
| `UUID=...` | Identifies the disk by UUID, not device name — survives USB port changes |
| `exfat` | Filesystem type (kernel exfat driver, built-in since Linux 5.7) |
| `nofail` | Boot continues normally if the disk is disconnected |
| `uid=nobody,gid=nogroup` | All files appear owned by nobody:nogroup (exFAT has no native ownership) |
| `umask=002` | Files are 775 (rwxrwxr-x) — writable by owner and group |
| `0 0` | Don't dump; don't fsck (exFAT fsck is not standard) |

### 3.3 — Create a Shared Directory Structure

```bash
mkdir -p /mnt/medish/{models,datasets,backups,media,scratch}

# On exFAT, chown/chmod are no-ops — ownership is controlled by the mount options
# (uid=nobody, gid=nogroup, umask=002 from fstab). No need to run chown/chmod.
```

| Directory | Purpose | Typical Contents |
|-----------|---------|-----------------|
| `models/` | AI/ML model files shared across GPU workloads | Whisper, NLP models, embeddings |
| `datasets/` | Training data, corpora | Audio samples, text corpora |
| `backups/` | VM backup exports, database dumps | `.sql.gz`, `.tar.gz`, Proxmox vzdump |
| `media/` | Audio files, documents for processing | `.wav`, `.mp3`, `.pdf` |
| `scratch/` | Temporary working space | Intermediate processing outputs |

Adjust these to your actual needs. You can add more directories at any time — they'll appear on all VMs instantly since NFS exports the parent.

### 3.4 — Workaround: exFAT Cannot Be Exported via NFS

The kernel NFS server (`knfsd`) requires the filesystem to implement `export_operations` (specifically `encode_fh`). The exFAT driver does not, so `exportfs` rejects it regardless of `fsid`. There are two options:

#### Option A: Reformat to ext4 (Recommended)

This gives full NFS support, POSIX permissions, and the best performance. **This destroys all data on the disk.**

```bash
# 1. Unmount the disk
umount /mnt/medish

# 2. Format sda2 as ext4 (DESTROYS ALL DATA)
mkfs.ext4 -L medish /dev/sda2

# 3. Update /etc/fstab — replace the exfat line with:
#    UUID=<new-uuid> /mnt/medish ext4 defaults,nofail 0 2
#    Get the new UUID: blkid /dev/sda2

# 4. Mount and create directories
mount -a
mkdir -p /mnt/medish/{models,datasets,backups,media,scratch}
chown -R nobody:nogroup /mnt/medish
chmod -R 775 /mnt/medish
```

After reformatting, the NFS export in Section 4.2 works without `fsid`:

```
/mnt/medish  10.10.1.0/24(rw,sync,no_subtree_check,no_root_squash) \
             10.10.2.0/24(rw,sync,no_subtree_check,no_root_squash) \
             10.10.3.0/24(rw,sync,no_subtree_check,no_root_squash) \
             10.10.4.0/24(rw,sync,no_subtree_check,no_root_squash)
```

#### Option B: Keep exFAT, Use Samba Instead of NFS

If you need to preserve the data on the disk (or want to keep it readable on Windows/Mac), use Samba (SMB) instead of NFS. Samba is a userspace daemon and does not require `export_operations` — it works with any mounted filesystem.

```bash
# 1. Install Samba on the Proxmox host
apt update && apt install -y samba

# 2. Configure the share
cat >> /etc/samba/smb.conf <<'EOF'

[medish]
   comment = Shared Storage (External Disk)
   path = /mnt/medish
   browseable = yes
   read only = no
   guest ok = yes
   force user = nobody
   force group = nogroup
   create mask = 0664
   directory mask = 0775
EOF

# 3. Restart Samba
systemctl restart smbd
systemctl enable smbd

# 4. Verify
smbclient -L localhost -N
# Should show: medish
```

Then mount via SMB inside each VM instead of NFS:

```bash
# Inside each VM
sudo apt update && sudo apt install -y cifs-utils
sudo mkdir -p /mnt/shared

# ubuntu-live-gpu (vmbr1 gateway)
echo '//10.10.1.1/medish /mnt/shared cifs guest,_netdev,uid=1000,gid=1000 0 0' | sudo tee -a /etc/fstab

# arca-dev VMs (vmbr2 gateway)
echo '//10.10.2.1/medish /mnt/shared cifs guest,_netdev,uid=1000,gid=1000 0 0' | sudo tee -a /etc/fstab

# arca-stg VMs (vmbr3 gateway)
echo '//10.10.3.1/medish /mnt/shared cifs guest,_netdev,uid=1000,gid=1000 0 0' | sudo tee -a /etc/fstab

# 4bits VMs (vmbr4 gateway)
echo '//10.10.4.1/medish /mnt/shared cifs guest,_netdev,uid=1000,gid=1000 0 0' | sudo tee -a /etc/fstab

sudo mount -a
```

| | Option A (ext4) | Option B (Samba) |
|---|---|---|
| Performance | Near-native (kernel NFS) | 10-30% slower (userspace SMB) |
| POSIX permissions | Full | Mapped via mount options |
| Data preserved | No (reformat) | Yes |
| Mac/Windows readable | No (without extra tools) | Yes (native) |
| Setup complexity | Simple | Moderate |

**Recommendation**: If the disk is empty or the data can be backed up, go with **Option A** (ext4). It's simpler, faster, and gives full NFS + POSIX support. If you need to keep the existing data or want Mac/Windows compatibility, use **Option B** (Samba).

---

## 4. Configure NFS Server on Proxmox Host

> **Prerequisite**: The disk must be ext4/xfs/btrfs/ZFS — not exFAT. If you still have exFAT, complete Section 3.4 Option A (reformat) or Option B (Samba) first. The NFS instructions below assume a filesystem that supports `export_operations`.

### 4.1 — Install NFS Server

```bash
apt update && apt install -y nfs-kernel-server
```

### 4.2 — Configure Exports

```bash
cat >> /etc/exports <<'EOF'

# ─── Shared storage for all internal VMs ───
# Exported to each internal bridge subnet
# vmbr1 (shared services): 10.10.1.0/24
# vmbr2 (arca-dev):        10.10.2.0/24
# vmbr3 (arca-stg):        10.10.3.0/24
# vmbr4 (4bits):            10.10.4.0/24
/mnt/medish  10.10.1.0/24(rw,sync,no_subtree_check,no_root_squash) \
                    10.10.2.0/24(rw,sync,no_subtree_check,no_root_squash) \
                    10.10.3.0/24(rw,sync,no_subtree_check,no_root_squash) \
                    10.10.4.0/24(rw,sync,no_subtree_check,no_root_squash)
EOF
```

**Export options explained:**

| Option | Purpose |
|--------|---------|
| `rw` | Read-write access |
| `sync` | Write data to disk before confirming — prevents corruption on power loss |
| `no_subtree_check` | Improves reliability when exporting a subdirectory of a filesystem |
| `no_root_squash` | Allows root on VMs to write as root (needed for Docker volumes) |

> **Security note**: The export is restricted to internal subnets only (10.10.x.0/24). No machine on your home LAN (192.168.68.0/24) or the internet can access this NFS share.

> **Tighter security alternative**: Replace `no_root_squash` with `root_squash` (the default). VM root users will be mapped to `nobody`. Manage write access via group permissions instead. This is recommended if you don't need Docker to write as root.

### 4.3 — Apply and Start

```bash
# Apply export configuration
exportfs -rav

# Enable and start NFS
systemctl enable nfs-kernel-server
systemctl start nfs-kernel-server

# Verify exports are active
showmount -e localhost
# Expected:
# /mnt/medish  10.10.1.0/24,10.10.2.0/24,10.10.3.0/24,10.10.4.0/24
```

---

## 5. Mount NFS Inside Each VM

### 5.1 — ubuntu-live-gpu (VM 101)

```bash
# 1. Install NFS client
sudo apt update && sudo apt install -y nfs-common

# 2. Create mount point
sudo mkdir -p /mnt/shared

# 3. Test mount (temporary)
sudo mount -t nfs 10.10.1.1:/mnt/medish /mnt/shared
ls /mnt/shared
# Should show: models  datasets  backups  media  scratch

# 4. Make persistent via /etc/fstab
echo '10.10.1.1:/mnt/medish /mnt/shared nfs defaults,_netdev,soft,timeo=30 0 0' | sudo tee -a /etc/fstab

# 5. Verify fstab works
sudo umount /mnt/shared
sudo mount -a
df -h /mnt/shared
```

### 5.2 — arca-dev VMs (VM 201, 202)

```bash
sudo apt update && sudo apt install -y nfs-common
sudo mkdir -p /mnt/shared
echo '10.10.2.1:/mnt/medish /mnt/shared nfs defaults,_netdev,soft,timeo=30 0 0' | sudo tee -a /etc/fstab
sudo mount -a
```

### 5.3 — arca-stg VMs (VM 301, 302)

```bash
sudo apt update && sudo apt install -y nfs-common
sudo mkdir -p /mnt/shared
echo '10.10.3.1:/mnt/medish /mnt/shared nfs defaults,_netdev,soft,timeo=30 0 0' | sudo tee -a /etc/fstab
sudo mount -a
```

### 5.4 — 4bits VMs (VM 401–405)

```bash
sudo apt update && sudo apt install -y nfs-common
sudo mkdir -p /mnt/shared
echo '10.10.4.1:/mnt/medish /mnt/shared nfs defaults,_netdev,soft,timeo=30 0 0' | sudo tee -a /etc/fstab
sudo mount -a
```

**Mount options explained:**

| Option | Purpose |
|--------|---------|
| `defaults` | Standard mount options (rw, suid, dev, exec, auto, nouser, async) |
| `_netdev` | Wait for network before mounting — prevents boot hang if NFS is slow |
| `soft` | Return error instead of hanging indefinitely if NFS server is unreachable |
| `timeo=30` | 3-second timeout (value is in deciseconds) before retry |
| `0 0` | Don't dump; don't fsck (NFS mounts can't be fscked from the client) |

### Quick Reference: Which Gateway IP for Which VM

| VM | Bridge | NFS Server IP | fstab Entry |
|----|--------|--------------|-------------|
| ubuntu-live-gpu (101) | vmbr1 | `10.10.1.1` | `10.10.1.1:/mnt/medish` |
| arca-dev-01 (201) | vmbr2 | `10.10.2.1` | `10.10.2.1:/mnt/medish` |
| arca-dev-02 (202) | vmbr2 | `10.10.2.1` | `10.10.2.1:/mnt/medish` |
| arca-stg-01 (301) | vmbr3 | `10.10.3.1` | `10.10.3.1:/mnt/medish` |
| arca-stg-02 (302) | vmbr3 | `10.10.3.1` | `10.10.3.1:/mnt/medish` |
| 4bits-01–05 (401–405) | vmbr4 | `10.10.4.1` | `10.10.4.1:/mnt/medish` |

---

## 6. Using Shared Storage with Docker

The NFS mount at `/mnt/shared` appears as a local directory to Docker. No special NFS driver needed.

### Docker Compose Example

```yaml
services:
  stt-v2:
    image: arcaai/stt-v2:latest
    volumes:
      - /mnt/shared/models:/app/models:ro
      - /mnt/shared/media:/app/input
      - /mnt/shared/scratch:/app/output

  nlp:
    image: arcaai/nlp:latest
    volumes:
      - /mnt/shared/models:/app/models:ro
      - /mnt/shared/datasets:/app/data:ro
```

### Docker Named Volume (Alternative)

If you prefer Docker-managed NFS volumes (useful for Swarm or when you want Docker to handle the mount):

```yaml
services:
  stt-v2:
    image: arcaai/stt-v2:latest
    volumes:
      - nfs-shared:/mnt/shared

volumes:
  nfs-shared:
    driver: local
    driver_opts:
      type: nfs
      o: addr=10.10.1.1,soft,timeo=30,_netdev
      device: ":/mnt/medish"
```

This approach lets Docker manage the NFS mount lifecycle — it mounts when the container starts and unmounts when it stops. Useful if you don't want a permanent system-wide mount.

---

## 7. Per-Environment Access Control

### Default: All Environments Read-Write

The base configuration in Section 4 gives all subnets `rw` access. This is fine for a playground.

### Read-Only for Staging and 4bits

If you want only dev to write while staging and 4bits can only read:

```bash
# Replace the /etc/exports entry on Proxmox host:
/mnt/medish  10.10.1.0/24(rw,sync,no_subtree_check,no_root_squash) \
                    10.10.2.0/24(rw,sync,no_subtree_check,no_root_squash) \
                    10.10.3.0/24(ro,sync,no_subtree_check) \
                    10.10.4.0/24(ro,sync,no_subtree_check)

# Apply
exportfs -rav
```

Staging and 4bits VMs can read models and datasets but cannot modify them.

### Per-Directory Exports

For finer control, export subdirectories separately:

```bash
# /etc/exports — granular approach
/mnt/medish/models    10.10.1.0/24(rw,sync,no_subtree_check,no_root_squash) \
                             10.10.2.0/24(ro,sync,no_subtree_check) \
                             10.10.3.0/24(ro,sync,no_subtree_check) \
                             10.10.4.0/24(ro,sync,no_subtree_check)

/mnt/medish/scratch   10.10.1.0/24(rw,sync,no_subtree_check,no_root_squash) \
                             10.10.2.0/24(rw,sync,no_subtree_check,no_root_squash)
```

Each VM would then mount each subdirectory separately:

```bash
echo '10.10.2.1:/mnt/medish/models /mnt/shared/models nfs defaults,_netdev,soft,timeo=30,ro 0 0' | sudo tee -a /etc/fstab
echo '10.10.2.1:/mnt/medish/scratch /mnt/shared/scratch nfs defaults,_netdev,soft,timeo=30 0 0' | sudo tee -a /etc/fstab
```

This is more complex to manage — only use it if you have a real need for per-directory access control.

---

## 8. Performance Tuning

### NFS Version

By default, modern Linux uses NFSv4. Verify:

```bash
# On any VM after mounting
nfsstat -m
# Look for "vers=4.2" — this is the best version
```

### Read-Ahead and Transfer Size

For large file workloads (AI models, audio files), increase the read/write buffer:

```bash
# In /etc/fstab on the VM, add rsize and wsize:
10.10.1.1:/mnt/medish /mnt/shared nfs defaults,_netdev,soft,timeo=30,rsize=1048576,wsize=1048576 0 0
```

| Option | Value | Purpose |
|--------|-------|---------|
| `rsize=1048576` | 1 MB | Maximum read transfer size per NFS request |
| `wsize=1048576` | 1 MB | Maximum write transfer size per NFS request |

This helps throughput for large sequential reads (loading models) but makes no difference for small random I/O.

### Disk I/O Scheduler

If `sda` is an SSD, set the I/O scheduler to `none` (noop) on the Proxmox host:

```bash
# Check current scheduler
cat /sys/block/sda/queue/scheduler
# Example: [mq-deadline] none

# Set to none for SSD
echo none > /sys/block/sda/queue/scheduler

# Make persistent
echo 'ACTION=="add|change", KERNEL=="sda", ATTR{queue/scheduler}="none"' > /etc/udev/rules.d/60-sda-scheduler.rules
```

If `sda` is a spinning HDD, keep `mq-deadline` (the default).

### Monitoring NFS Performance

```bash
# On Proxmox host — NFS server stats
nfsstat -s

# On any VM — NFS client stats
nfsstat -c

# Real-time I/O monitoring
iostat -x 2 /dev/sda
```

---

## 9. Adding Samba Alongside NFS

If you later need to browse the shared storage from your Mac or a Windows machine on your home LAN, add Samba on the Proxmox host. This runs alongside NFS — they don't conflict.

### Install Samba

```bash
# On the Proxmox host
apt install -y samba
```

### Configure Samba

```bash
cat >> /etc/samba/smb.conf <<'EOF'

[medish-shared]
   comment = Shared Storage (External Disk)
   path = /mnt/medish
   browseable = yes
   read only = no
   guest ok = no
   valid users = @sambashare
   create mask = 0664
   directory mask = 0775
   force group = nogroup
EOF
```

### Create a Samba User

```bash
# Create a system group for Samba access
groupadd -f sambashare

# Create a Samba user (or use an existing system user)
useradd -M -s /usr/sbin/nologin -G sambashare smbuser
smbpasswd -a smbuser
# Enter a password when prompted

# Restart Samba
systemctl restart smbd
systemctl enable smbd
```

### Connect from Mac

```
Finder → Go → Connect to Server → smb://192.168.68.130/medish-shared
```

### Connect from Windows

```
\\192.168.68.130\medish-shared
```

> **Note**: Samba is exposed on `vmbr0` (192.168.68.0/24 — your home LAN). It is NOT accessible from the internal VM subnets via SMB. VMs should continue using NFS.

---

## 10. Verification

### NFS Server (Proxmox Host)

```bash
# Exports are active
showmount -e localhost
# Expected: /mnt/medish  10.10.1.0/24,10.10.2.0/24,10.10.3.0/24,10.10.4.0/24

# NFS service is running
systemctl is-active nfs-kernel-server
# Expected: active

# Disk is mounted
df -h /mnt/medish
# Expected: /dev/sda2  954G  ...  /mnt/medish
```

### NFS Client (Any VM)

```bash
# Mount is active
df -h /mnt/shared
# Expected: 10.10.X.1:/mnt/medish  954G  ...

# NFS version in use
nfsstat -m
# Expected: vers=4.2

# Can list contents
ls /mnt/shared
# Expected: models  datasets  backups  media  scratch
```

### Cross-VM Read/Write Test

```bash
# From ubuntu-live-gpu:
echo "hello from $(hostname) at $(date)" > /mnt/shared/scratch/test-$(hostname).txt

# From arca-dev-01:
echo "hello from $(hostname) at $(date)" > /mnt/shared/scratch/test-$(hostname).txt

# From any VM — read all test files:
cat /mnt/shared/scratch/test-*.txt
# Should show entries from all VMs that wrote
```

### Performance Baseline

```bash
# Write speed test (from any VM)
dd if=/dev/zero of=/mnt/shared/scratch/speedtest bs=1M count=1024 oflag=direct
# Expected: 100+ MB/s on a 1Gbps virtual bridge (typically 200-400 MB/s)

# Read speed test
dd if=/mnt/shared/scratch/speedtest of=/dev/null bs=1M iflag=direct
# Expected: similar or faster than write

# Clean up
rm /mnt/shared/scratch/speedtest
```

---

## 11. Troubleshooting

### NFS Mount Fails or Hangs

```bash
# Inside the VM — check if NFS client is installed
dpkg -l | grep nfs-common
# If missing: sudo apt install -y nfs-common

# Check if Proxmox host NFS port is reachable (use your bridge gateway IP)
rpcinfo -p 10.10.X.1
# Should list: nfs, mountd, portmapper services

# If rpcinfo fails, check NFS server on Proxmox host
systemctl status nfs-kernel-server
# Restart if needed: systemctl restart nfs-kernel-server

# If mount hangs, the soft+timeo options in fstab will timeout instead of blocking
# Force unmount a stuck NFS mount:
sudo umount -f /mnt/shared
# Or lazy unmount (detaches immediately):
sudo umount -l /mnt/shared
```

### NFS Permission Denied

```bash
# On Proxmox host — verify the VM's IP is in the allowed subnet
showmount -e localhost
# Must include the VM's subnet (e.g., 10.10.2.0/24 for arca-dev VMs)

# Check the export options
cat /etc/exports
# Ensure rw (not ro) if the VM needs write access

# Re-export after changes
exportfs -rav
```

### Mount Disappears After Reboot

```bash
# Check fstab entry exists
grep nfs /etc/fstab
# Should show: 10.10.X.1:/mnt/medish /mnt/shared nfs ...

# Check if _netdev is present — without it, mount may fail before network is up
# If missing, update the fstab line to include _netdev

# Manual re-mount
sudo mount -a
```

### Stale File Handle Error

This happens when the NFS server restarted or the export changed while the VM had it mounted:

```bash
# Lazy unmount + remount
sudo umount -l /mnt/shared
sudo mount -a
```

### External Disk Not Mounting on Proxmox Reboot

```bash
# Check fstab
grep medish /etc/fstab
# Ensure nofail is present — without it, Proxmox won't boot if the disk is missing

# Check if the disk is detected
lsblk
# If sda is missing, check USB connection or SATA cable

# Check dmesg for disk errors
dmesg | grep -i sda | tail -20
```

---

## Quick Reference Card

```
DISK:
  /dev/sda2 (954G, exFAT) → /mnt/medish (Proxmox host, persistent via fstab UUID)

NFS SERVER (Proxmox host):
  Package:  nfs-kernel-server
  Export:   /mnt/medish → 10.10.1-4.0/24 (rw, sync)
  Config:   /etc/exports

NFS CLIENTS (all VMs):
  Package:  nfs-common
  Mount:    /mnt/shared (persistent via fstab, _netdev + soft)

GATEWAY IPs FOR NFS:
  ubuntu-live-gpu  → 10.10.1.1
  arca-dev VMs     → 10.10.2.1
  arca-stg VMs     → 10.10.3.1
  4bits VMs        → 10.10.4.1

DIRECTORIES:
  /mnt/shared/models/     AI/ML model files
  /mnt/shared/datasets/   Training data
  /mnt/shared/backups/    DB dumps, VM exports
  /mnt/shared/media/      Audio, documents
  /mnt/shared/scratch/    Temporary workspace

SAMBA (optional, for Mac/Windows desktop access):
  smb://192.168.68.130/medish-shared
  Only on home LAN (vmbr0), not internal VM subnets
```
