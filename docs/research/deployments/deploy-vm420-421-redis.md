# Deploy Redis — VM 420 (Dev) & VM 421 (Staging)

**Date**: 2026-03-24
**VMs**: 420 (`10.10.1.120`) — Dev | 421 (`10.10.1.121`) — Staging
**Bridge**: vmbr1 | **Specs**: 2 vCPU / 2 GB RAM / 16 GB disk (Dev) | 2 vCPU / 4 GB RAM / 32 GB disk (Staging)
**Config files**: [`configs/redis/`](../configs/redis/)
**Cloudflare SSH**: `ssh-redis-dev.taphuynh.dev` (VM 420) | `ssh-redis-staging.taphuynh.dev` (VM 421)
**Related**: [Infrastructure Overview](../infrastructure/proxmox-infrastructure-gitlab-rancher-plan.md) | [Cloudflare Tunnel](./deploy-ct101-cloudflare-tunnel.md) | [PostgreSQL HA](./deploy-vm500-502-postgres-ha.md) | [MinIO](./deploy-vm402-minio.md)

> **Redis is not exposed through the Cloudflare Tunnel.** It uses a binary protocol and must only be reachable on the internal `10.10.1.0/24` network. Only SSH access is tunneled for remote management. Developer access from external machines uses SSH port forwarding through the existing Cloudflare SSH tunnel.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Why Separate VMs Per Environment](#2-why-separate-vms-per-environment)
3. [Redis Database Segmentation](#3-redis-database-segmentation)
4. [Prerequisites](#4-prerequisites)
5. [Create VMs (Proxmox Host)](#5-create-vms-proxmox-host)
6. [Prepare Each VM](#6-prepare-each-vm)
7. [Deploy Redis — Dev (VM 420)](#7-deploy-redis--dev-vm-420)
8. [Deploy Redis — Staging (VM 421)](#8-deploy-redis--staging-vm-421)
9. [Security Hardening](#9-security-hardening)
10. [Cloudflare Tunnel — SSH Only](#10-cloudflare-tunnel--ssh-only)
11. [Update Application Configuration](#11-update-application-configuration)
12. [Automated Backup](#12-automated-backup)
13. [Monitoring](#13-monitoring)
14. [Verify](#14-verify)
15. [Operational Runbook](#15-operational-runbook)
16. [Troubleshooting](#16-troubleshooting)
17. [Disk Expansion](#17-disk-expansion)
18. [Alpine Operational Reference](#18-alpine-operational-reference)

---

## 1. Architecture Overview

Redis serves multiple roles in the HOPE platform: BullMQ job queues, application caching, real-time Pub/Sub for STT transcriptions, Redis Streams for audio bridging and SMR task chunks, Celery/Dramatiq broker, and rate limiting. Each environment (dev/staging) gets its own isolated Redis VM.

```
                         ┌──────────────────────────────────────────────┐
                         │            HOPE APPLICATION STACK            │
                         │                                              │
                         │  NestJS API (BullMQ, Cache, Pub/Sub, Streams)│
                         │  STT-V2    (Dramatiq, Pub/Sub, Streams)      │
                         │  SMR       (Task state, Streams, Celery)     │
                         │  NLP       (Celery)                          │
                         └──────────┬──────────────────┬────────────────┘
                                    │                  │
                    ┌───────────────▼──┐     ┌─────────▼──────────────┐
                    │   VM 420 — Dev   │     │   VM 421 — Staging     │
                    │   10.10.1.120    │     │   10.10.1.121          │
                    ├──────────────────┤     ├────────────────────────┤
                    │ Redis 8 Alpine   │     │ Redis 8 Alpine         │
                    │ redis-exporter   │     │ redis-exporter         │
                    │                  │     │                        │
                    │ maxmemory: 512mb │     │ maxmemory: 2gb         │
                    │ AOF + RDB        │     │ AOF + RDB              │
                    │ Dangerous cmds   │     │ Dangerous cmds renamed │
                    │   ALLOWED        │     │   BLOCKED              │
                    └──────────────────┘     └────────────────────────┘
                    Port: 6379                Port: 6379
                    Exporter: 9121            Exporter: 9121
```

### Port Allocation (per VM)

| Port | Service | Purpose |
|------|---------|---------|
| 6379 | Redis | All client connections (BullMQ, cache, Pub/Sub, Streams) |
| 9121 | redis_exporter | Prometheus metrics |

### Why Single-Node (No Sentinel/Cluster)

Redis in HOPE is **not a primary datastore** — PostgreSQL is the source of truth. All Redis data is either:

- **Reconstructable** — BullMQ jobs can be re-enqueued, caches rebuild on miss
- **Ephemeral** — Pub/Sub messages, audio stream frames, rate limit counters
- **Short-lived** — SMR task state with TTL, Dramatiq job results

A single Redis instance with AOF persistence provides sufficient durability. If Redis goes down, the platform degrades gracefully (the `IRedisCacheService` already returns null/false when disconnected). Adding Sentinel complexity for data that is fundamentally transient is not worth it.

---

## 2. Why Separate VMs Per Environment

| Concern | Shared VM | Separate VMs |
|---------|-----------|--------------|
| Isolation | Dev `FLUSHALL` kills staging | Independent lifecycle |
| Resource contention | STT audio streams in dev starve staging | Dedicated memory/CPU |
| Independent restarts | Affects both environments | Restart dev freely |
| Security | Single breach exposes both | Staging can have stricter hardening |
| Cost on Proxmox | Saves 1 lightweight VM | 2 VMs at ~2-4 GB RAM — negligible |
| Pattern consistency | Breaks convention | Matches PG, GitLab, MinIO — each service owns its VM(s) |

---

## 3. Redis Database Segmentation

Redis logical databases (`SELECT N`) isolate concerns without running multiple processes. This prevents key collisions and allows selective `FLUSHDB` per subsystem.

| DB | Purpose | Consumers |
|----|---------|-----------|
| 0 | **BullMQ job queues** | NestJS API — consultation jobs (PreSummary, Summary, ComprehensiveSummary, ExtractNamedEntities) |
| 1 | **Application cache + rate limiting** | `IRedisCacheService` — get/set/setex/del, `ApiKeyRateLimiter`, `RateLimitingService` |
| 2 | **STT Pub/Sub + Streams** | `RedisSubscriberService` (stt:transcription:*), `StreamingAudioBridgeService` (stt:audio:*, stt:control:*, stt:result:*), STT-V2 Python (redis.asyncio) |
| 3 | **SMR Pub/Sub + Streams** | `SmrStreamConsumerService` (smr:stream:*), SMR Python `TaskManager` (smr:task:*) |
| 4 | **Celery broker + results** | SMR async tasks (legacy — former MLflow/FedL consumers were removed with those apps) |
| 5 | **Dramatiq broker + results** | STT-V2 `RedisBroker` + `RedisBackend` |

> **Note**: Pub/Sub in Redis is global — it works across all databases. The database number only isolates key-based operations (GET/SET/XADD/etc). Pub/Sub channel naming conventions (`stt:`, `smr:`) provide logical isolation.

---

## 4. Prerequisites

- Proxmox host with available resources (4 vCPU / 6 GB RAM / 48 GB disk total for both VMs)
- Alpine Linux 3.21 Virtual ISO (downloaded in Section 5.2)
- SSH access to Proxmox host
- Cloudflare Tunnel (CT 101) running — for SSH access only

---

## 5. Create VMs (Proxmox Host)

### 5.1 — VM Hardware Best Practices for Redis

Before creating the VMs, understand the hardware choices and why they matter for Redis:

| Setting | Value | Rationale |
|---------|-------|-----------|
| **SCSI Controller** | `virtio-scsi-single` | Each disk gets its own VirtIO SCSI controller with a dedicated I/O thread. Proxmox default since 7.3. Recommended by Proxmox docs for performance. |
| **IO Thread** | `iothread=1` | Offloads disk I/O to a dedicated QEMU thread instead of the main event loop. Reduces latency for I/O-intensive workloads like Redis AOF fsync. |
| **Disk cache** | `cache=none` | Default and recommended — bypasses host page cache (O_DIRECT), lets Redis manage its own memory. Avoids double-caching. |
| **Discard** | `discard=on` | Passes TRIM from guest to host storage. Keeps thin-provisioned LVM volumes small. |
| **SSD emulation** | `ssd=1` | Tells guest the disk is SSD-backed. Enables TRIM in guest, avoids unnecessary I/O scheduling overhead. |
| **CPU type** | `host` | Exposes all host CPU features to the VM (AES-NI, AVX, etc.). Since these VMs won't be live-migrated, `host` is safe and gives best performance. |
| **Machine type** | `q35` | Modern PCIe-based chipset. Better interrupt handling than i440fx. |
| **Ballooning** | `balloon=0` | **Disabled.** Redis must have guaranteed memory — the balloon driver reclaims RAM from VMs under host memory pressure. If Redis loses memory unexpectedly, it hits OOM or triggers evictions. For a cache/queue service, predictable memory is critical. |
| **NUMA** | `numa=0` | Not needed for 2 vCPU VMs. NUMA is relevant for multi-socket hosts with 4+ vCPUs. |
| **QEMU Guest Agent** | `agent=1` | Enables Proxmox to do clean shutdown, filesystem freeze for snapshots, and report guest IP. |
| **Start at boot** | `onboot=1` | Auto-start Redis VMs when the Proxmox host boots. |

#### On Shared Memory (Inter-VM Shared Memory)

Proxmox offers `ivshmem` for sharing a memory region between VMs or between host and guest. **This is not what you want for Redis.** `ivshmem` is designed for:

- GPU framebuffer sharing (Looking Glass)
- Inter-VM communication bypassing the network
- Custom DPDK/SPDK applications

Redis clients connect over TCP — they don't share memory with the Redis process. The correct way to give Redis more usable memory is to:

1. **Disable ballooning** (`balloon=0`) so the VM keeps its full RAM allocation
2. **Set fixed memory** — don't use min/max dynamic allocation
3. **Tune `maxmemory`** in `redis.conf` to ~70% of VM RAM (leave room for OS, Docker, AOF rewrite buffers)

### 5.2 — Create VMs

Download the Alpine **Virtual** ISO on the Proxmox host:

```bash
cd /var/lib/vz/template/iso/
wget https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-virt-3.21.0-x86_64.iso
```

Create both VMs with all hardware best practices from 5.1:

```bash
# ── Dev VM (420) ──────────────────────────────────────────────────────
qm create 420 --name redis-dev \
  --cores 2 --cpu cputype=host --numa 0 \
  --memory 2048 --balloon 0 \
  --machine q35 \
  --net0 virtio,bridge=vmbr1 \
  --scsihw virtio-scsi-single \
  --scsi0 local-lvm:16,iothread=1,discard=on,ssd=1,cache=none \
  --agent 1 --onboot 1 \
  --ide2 local:iso/alpine-virt-3.21.0-x86_64.iso,media=cdrom \
  --boot order=ide2

# ── Staging VM (421) ─────────────────────────────────────────────────
qm create 421 --name redis-staging \
  --cores 2 --cpu cputype=host --numa 0 \
  --memory 4096 --balloon 0 \
  --machine q35 \
  --net0 virtio,bridge=vmbr1 \
  --scsihw virtio-scsi-single \
  --scsi0 local-lvm:32,iothread=1,discard=on,ssd=1,cache=none \
  --agent 1 --onboot 1 \
  --ide2 local:iso/alpine-virt-3.21.0-x86_64.iso,media=cdrom \
  --boot order=ide2
```

Verify with `qm config 420` — key lines:

```
agent: 1
balloon: 0
cores: 2
cpu: cputype=host
machine: q35
memory: 2048
net0: virtio=...,bridge=vmbr1
numa: 0
onboot: 1
scsi0: local-lvm:vm-420-disk-0,discard=on,iothread=1,ssd=1,cache=none
scsihw: virtio-scsi-single
```

### 5.3 — Install Alpine on VM 420 (Dev)

Start the VM and open the Proxmox noVNC console:

```bash
qm start 420
# Proxmox web UI → VM 420 → Console
```

Login as `root` (no password) and run:

```bash
setup-alpine
```

#### IP Address Configuration

The network prompts during `setup-alpine`:

```
Available interfaces are: eth0.
Which one do you want to initialize? (or '?' or 'done') [eth0] eth0
Ip address for eth0? (or 'dhcp', 'none', '?') [dhcp] 10.10.1.120/24
Gateway? (or 'none') [none] 10.10.1.1
Do you want to do any manual network configuration? [no] no
DNS domain name? (e.g. 'bar.com') [] taphuynh.dev
DNS nameserver(s)? [none] 8.8.8.8 8.8.4.4
```

#### Remaining Prompts

| Prompt | Value |
|--------|-------|
| Keyboard layout | `us` |
| Hostname | `redis-dev` |
| Timezone | `UTC` |
| Root password | Set a strong password |
| SSH server | `openssh` |
| Disk | `sda`, type `sys` |

After the installer completes:

```bash
reboot
```

On the **Proxmox host**, detach the ISO and set boot order:

```bash
qm set 420 --ide2 none
qm set 420 --boot order=scsi0
```

### 5.4 — Install Alpine on VM 421 (Staging)

Same process, different hostname and IP:

```bash
qm start 421
# Proxmox web UI → VM 421 → Console
```

```bash
setup-alpine
```

Network prompts — use **`10.10.1.121/24`**:

```
Which one do you want to initialize? [eth0] eth0
Ip address for eth0? [dhcp] 10.10.1.121/24
Gateway? [none] 10.10.1.1
Do you want to do any manual network configuration? [no] no
DNS domain name? [] taphuynh.dev
DNS nameserver(s)? [none] 8.8.8.8 8.8.4.4
```

| Prompt | Value |
|--------|-------|
| Hostname | **`redis-staging`** |
| (all others) | Same as VM 420 |

```bash
reboot

# On Proxmox host
qm set 421 --ide2 none
qm set 421 --boot order=scsi0
```

### 5.5 — Verify IP Address & Network (Both VMs)

After reboot, login via Proxmox noVNC console as `root` on **each VM**:

```bash
# ── Check IP address ─────────────────────────────────────────────────
ip addr show eth0 | grep "inet "
# VM 420 → inet 10.10.1.120/24
# VM 421 → inet 10.10.1.121/24

# ── Check gateway ────────────────────────────────────────────────────
ip route show default
# → default via 10.10.1.1 dev eth0

# ── Check hostname ───────────────────────────────────────────────────
hostname
# VM 420 → redis-dev
# VM 421 → redis-staging

# ── Check DNS ─────────────────────────────────────────────────────────
cat /etc/resolv.conf
# → nameserver 8.8.8.8
# → nameserver 8.8.4.4

# ── Test connectivity ─────────────────────────────────────────────────
ping -c 2 10.10.1.1      # gateway
ping -c 2 10.10.1.2      # CT 101 (cloudflare tunnel)
ping -c 2 8.8.8.8        # internet
ping -c 2 google.com     # DNS resolution
```

If any check fails, fix manually:

```bash
# ── Fix static IP ─────────────────────────────────────────────────────
cat >   <<'EOF'
auto lo
iface lo inet loopback

auto eth0
iface eth0 inet static
    address 10.10.1.120/24
    gateway 10.10.1.1
EOF
# For VM 421: change address to 10.10.1.121/24

# ── Fix DNS ───────────────────────────────────────────────────────────
cat > /etc/resolv.conf <<'EOF'
nameserver 8.8.8.8
nameserver 8.8.4.4
EOF

# ── Fix hostname ──────────────────────────────────────────────────────
echo "redis-dev" > /etc/hostname   # or redis-staging for VM 421
hostname -F /etc/hostname

# ── Fix /etc/hosts ────────────────────────────────────────────────────
cat > /etc/hosts <<'EOF'
127.0.0.1       localhost
10.10.1.120     redis-dev
10.10.1.121     redis-staging
EOF

# ── Apply ─────────────────────────────────────────────────────────────
rc-service networking restart
rc-update add networking boot

# ── Verify ────────────────────────────────────────────────────────────
ping -c 2 google.com
```

> **Troubleshooting**: If `ping` says `bad address` for domain names, check `/etc/resolv.conf` is not empty and has permissions `-rw-r--r-- root:root`. Alpine's `udhcpc` can overwrite this file — prevent it with `chattr +i /etc/resolv.conf` on static-IP VMs.

---

## 6. Prepare Each VM

Run all steps in this section as **root** via Proxmox noVNC console on **both VMs** (420 and 421).

### 6.1 Enable Community Repository

```bash
sed -i 's|#\(.*community\)|\1|' /etc/apk/repositories
apk update && apk upgrade
```

### 6.2 Install All Packages

```bash
apk add \
  openssh-server \
  qemu-guest-agent \
  docker docker-cli-compose \
  iptables ip6tables awall \
  sudo shadow \
  bash zsh zsh-vcs curl wget git \
  nano \
  coreutils findutils grep \
  dcron \
  e2fsprogs-extra parted \
  util-linux procps \
  htop
```

| Group | Packages | Purpose |
|-------|----------|---------|
| SSH | `openssh-server` | Remote access |
| Virtualization | `qemu-guest-agent` | Proxmox guest agent — clean shutdown, IP reporting |
| Docker | `docker docker-cli-compose` | Container runtime + Compose v2 |
| Firewall | `iptables ip6tables awall` | Alpine Wall firewall |
| User management | `sudo shadow` | `sudo` support, `useradd`/`usermod` |
| Shell | `bash zsh zsh-vcs curl wget git` | Zsh + oh-my-zsh dependencies |
| Editor | `nano` | Terminal text editor |
| GNU utilities | `coreutils findutils grep` | GNU `date`, `find`, `grep` — BusyBox variants too limited |
| Cron | `dcron` | Scheduled tasks (backup script) |
| Disk tools | `e2fsprogs-extra parted` | Filesystem resize, partition management |
| System tools | `util-linux procps htop` | `lsblk`, `ps`, `top` |

### 6.3 Create the `dell` User

All homelab VMs use `dell` for SSH — matches `~/.ssh/config` on your Mac (`User dell`).

```bash
adduser -D -s /bin/zsh dell
passwd dell
echo "dell ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/dell
chmod 440 /etc/sudoers.d/dell
addgroup dell docker
```

### 6.4 Deploy SSH Key

From your **Mac**, deploy the homelab key. See [SSH & Cloudflared Setup](../networking/ssh-cloudflared-setup-mac.md) for the full guide.

**Option A — Direct (on the same network):**

```bash
ssh-copy-id -i ~/.ssh/id_ed25519_homelab.pub dell@10.10.1.120   # Dev
ssh-copy-id -i ~/.ssh/id_ed25519_homelab.pub dell@10.10.1.121   # Staging
```

**Option B — Via Cloudflare Tunnel (after CT 101 routes are added):**

```bash
# Terminal 1: start temporary tunnel
cloudflared access tcp --hostname ssh-redis-01.taphuynh.dev --url localhost:22
# Terminal 2: deploy the key
ssh-copy-id -i ~/.ssh/id_ed25519_homelab.pub -p 22 dell@localhost
```

**Option C — Manual (via Proxmox console, as dell user):**

```bash
su - dell
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat >> ~/.ssh/authorized_keys <<'KEY'
ssh-ed25519 AAAA... taphuynh@homelab
KEY
chmod 600 ~/.ssh/authorized_keys
exit
```

Verify:

```bash
# From your Mac
ssh dell@10.10.1.120
ssh dell@10.10.1.121
```

### 6.5 Configure SSH Server

```bash
cat > /etc/ssh/sshd_config.d/hardened.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
MaxAuthTries 3
X11Forwarding no
AllowTcpForwarding yes
ClientAliveInterval 30
ClientAliveCountMax 3
EOF

rc-service sshd restart
```

> **Important**: Deploy your SSH key (step 6.5) **before** setting `PasswordAuthentication no`. If locked out, use the Proxmox noVNC console.

### 6.6 Update Mac SSH Config

Add Redis VM aliases to `~/.ssh/config` on your **Mac**, in the Homelab VM Aliases section before `Match host *.taphuynh.dev`:

```ssh-config
Host redis-dev
    HostName ssh-redis-dev.taphuynh.dev
Host redis-staging
    HostName ssh-redis-staging.taphuynh.dev
```

The existing `Match host *.taphuynh.dev` block handles `ProxyCommand`, `User dell`, and `IdentityFile`.

After adding:

```bash
ssh redis-dev      # → connects to VM 420
ssh redis-staging  # → connects to VM 421
```

### 6.7 Install Oh My Zsh

Run as `dell` on **each VM**:

```bash
su - dell

sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended

git clone https://github.com/zsh-users/zsh-autosuggestions \
  ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions

git clone https://github.com/zsh-users/zsh-syntax-highlighting \
  ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting

cat > ~/.zshrc <<'ZSHRC'
export ZSH="$HOME/.oh-my-zsh"

ZSH_THEME="robbyrussell"

plugins=(
  git
  docker
  docker-compose
  zsh-autosuggestions
  zsh-syntax-highlighting
)

source $ZSH/oh-my-zsh.sh

alias ll='ls -lah'
alias dc='docker compose'
alias dps='docker compose ps'
alias dlogs='docker compose logs -f'
alias redis-cli='docker exec -it hope-redis redis-cli -a "$REDIS_PASS"'
ZSHRC

source ~/.zshrc
exit
```

### 6.8 Enable Services

```bash
rc-update add qemu-guest-agent default
rc-update add docker default
rc-update add dcron default
rc-update add sshd default
rc-update add local default
rc-update add networking boot

service qemu-guest-agent start
service docker start
service dcron start

rc-update show default
```

### 6.9 Create Redis Directories

```bash
mkdir -p /opt/redis/{data,logs,backups}
chown -R dell:dell /opt/redis
```

### 6.10 Configure Firewall (awall)

```bash
cat > /etc/awall/optional/redis.json <<'POLICY'
{
  "description": "Redis server firewall policy",

  "zone": {
    "internal": { "iface": "eth0" }
  },

  "filter": [
    {
      "in": "internal",
      "src": "10.10.1.0/24",
      "dest": "_fw",
      "service": { "proto": "tcp", "port": 22 },
      "action": "accept",
      "comment": "SSH from internal network"
    },
    {
      "in": "internal",
      "src": "10.10.1.0/24",
      "dest": "_fw",
      "service": { "proto": "tcp", "port": 6379 },
      "action": "accept",
      "comment": "Redis from internal network"
    },
    {
      "in": "internal",
      "src": "10.10.1.0/24",
      "dest": "_fw",
      "service": { "proto": "tcp", "port": 9121 },
      "action": "accept",
      "comment": "redis-exporter from internal network"
    },
    {
      "in": "internal",
      "src": "10.10.1.2",
      "dest": "_fw",
      "action": "accept",
      "comment": "CT 101 Cloudflare Tunnel full access"
    }
  ],

  "policy": [
    { "in": "_fw", "action": "accept" },
    { "in": "internal", "action": "drop" }
  ]
}
POLICY

awall enable redis
awall activate

rc-update add iptables
rc-update add ip6tables
```

### 6.11 Restrict Docker-Published Ports

```bash
IFACE="eth0"

cat > /etc/local.d/docker-firewall.start <<EOF
#!/bin/sh
iptables -I DOCKER-USER -i ${IFACE} ! -s 10.10.1.0/24 -j DROP 2>/dev/null || true
EOF

chmod +x /etc/local.d/docker-firewall.start
/etc/local.d/docker-firewall.start

iptables -L DOCKER-USER -n -v
```

### 6.12 Tune Kernel Parameters

```bash
cat > /etc/sysctl.d/99-redis.conf <<'EOF'
vm.overcommit_memory = 1
net.core.somaxconn = 65535
EOF

sysctl -p /etc/sysctl.d/99-redis.conf
```

Disable Transparent Huge Pages:

```bash
cat > /etc/local.d/disable-thp.start <<'EOF'
#!/bin/sh
echo never > /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null || true
echo never > /sys/kernel/mm/transparent_hugepage/defrag 2>/dev/null || true
EOF

chmod +x /etc/local.d/disable-thp.start
/etc/local.d/disable-thp.start

cat /sys/kernel/mm/transparent_hugepage/enabled
# → always madvise [never]
```

### 6.13 Verification — VM Is Production-Ready

Run on **each VM**:

```bash
# ── IP Address
ip addr show eth0 | grep "inet "
# Dev: 10.10.1.120/24  |  Staging: 10.10.1.121/24

# ── Hostname
hostname
# Dev: redis-dev  |  Staging: redis-staging

# ── OS
cat /etc/alpine-release
# → 3.21.x

# ── User & Shell
id dell
# → groups=...docker
getent passwd dell | cut -d: -f7
# → /bin/zsh

# ── Tools
which nano docker zsh git curl htop
docker --version && docker compose version

# ── Oh My Zsh
su - dell -c 'ls ~/.oh-my-zsh/oh-my-zsh.sh && echo OK'

# ── QEMU Guest Agent
service qemu-guest-agent status
# On Proxmox host: qm agent 420 ping

# ── Firewall
awall list
iptables -L DOCKER-USER -n -v

# ── Kernel Tuning
sysctl vm.overcommit_memory net.core.somaxconn
cat /sys/kernel/mm/transparent_hugepage/enabled

# ── Boot Services
rc-update show default
# → docker, qemu-guest-agent, dcron, sshd, local, iptables, ip6tables, networking

# ── Directories
ls -la /opt/redis/
# → data/ logs/ backups/ owned by dell:dell

# ── SSH (from your Mac)
ssh redis-dev
ssh redis-staging
```

---

## 7. Deploy Redis — Dev (VM 420)

### 7.1 Copy Config Files

```bash
# From your workstation
scp -r research/configs/redis/ dell@10.10.1.120:/opt/redis/
# Or via Cloudflare Tunnel alias
scp -r research/configs/redis/ redis-dev:/opt/redis/
```

### 7.2 Create Environment File

```bash
ssh redis-dev   # or: ssh dell@10.10.1.120
cd /opt/redis

cat > .env <<'EOF'
REDIS_PASS=CHANGE_ME_dev_password_here
ENVIRONMENT=dev
EOF

chmod 600 .env
```

> Generate a strong password: `openssl rand -base64 24`

### 7.3 Start Services

```bash
cd /opt/redis

# Use dev config
cp redis-dev.conf redis.conf

docker compose pull
docker compose up -d

# Verify
docker compose ps
docker logs hope-redis --tail 20
```

### 7.4 Quick Verification

```bash
# Ping
docker exec hope-redis redis-cli -a "$REDIS_PASS" ping
# → PONG

# Info
docker exec hope-redis redis-cli -a "$REDIS_PASS" info server | grep redis_version
# → redis_version:8.x.x

# Check maxmemory
docker exec hope-redis redis-cli -a "$REDIS_PASS" config get maxmemory
# → 536870912 (512 MB)

# Exporter
curl -s http://10.10.1.120:9121/metrics | grep redis_up
# → redis_up 1
```

---

## 8. Deploy Redis — Staging (VM 421)

### 8.1 Copy Config Files

```bash
scp -r research/configs/redis/ dell@10.10.1.121:/opt/redis/
# Or via alias: scp -r research/configs/redis/ redis-staging:/opt/redis/
```

### 8.2 Create Environment File

```bash
ssh redis-staging   # or: ssh dell@10.10.1.121
cd /opt/redis

cat > .env <<'EOF'
REDIS_PASS=CHANGE_ME_staging_password_here
ENVIRONMENT=staging
EOF

chmod 600 .env
```

> **Use a different password than dev.** Generate: `openssl rand -base64 24`

### 8.3 Start Services

```bash
cd /opt/redis

# Use staging config
cp redis-staging.conf redis.conf

docker compose pull
docker compose up -d

docker compose ps
docker logs hope-redis --tail 20
```

### 8.4 Verify

```bash
docker exec hope-redis redis-cli -a "$REDIS_PASS" ping
# → PONG

docker exec hope-redis redis-cli -a "$REDIS_PASS" config get maxmemory
# → 2147483648 (2 GB)

curl -s http://10.10.1.121:9121/metrics | grep redis_up
# → redis_up 1
```

---

## 9. Security Hardening

### 9.1 Dev vs Staging Differences

| Setting | Dev (VM 420) | Staging (VM 421) |
|---------|-------------|-----------------|
| `maxmemory` | 512 MB | 2 GB |
| `FLUSHALL` | Allowed | **Renamed** (blocked) |
| `FLUSHDB` | Allowed | **Renamed** (blocked) |
| `CONFIG` | Allowed | **Renamed** |
| `DEBUG` | Allowed | **Renamed** (blocked) |
| `KEYS` | Allowed | **Renamed** |
| `appendonly` | yes | yes |
| `save` (RDB) | yes | yes |

### 9.2 Password Rotation

To rotate the Redis password:

```bash
# 1. Update the password in .env
nano /opt/redis/.env

# 2. Update redis.conf
# Change the requirepass line

# 3. Restart Redis
docker compose down && docker compose up -d

# 4. Update all application .env files that reference this Redis
# 5. Restart application services
```

### 9.3 Network Security

Redis is protected by three layers:

1. **awall** — only allows `10.10.1.0/24` on ports 22, 6379, 9121
2. **Docker-USER iptables chain** — restricts Docker-published ports to `10.10.1.0/24`
3. **Redis `requirepass`** — authentication required for all commands

Redis is **never exposed** through the Cloudflare Tunnel. The binary protocol should not traverse HTTP tunnels.

---

## 10. Cloudflare Tunnel — SSH Only

Add SSH-only routes for remote management. **Do not add Redis port routes.**

### 10.1 Add Public Hostnames in Cloudflare Dashboard

Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/) → **Networks** → **Tunnels** → **hope-homelab** → **Public Hostnames**:

| Subdomain | Domain | Type | URL |
|-----------|--------|------|-----|
| `ssh-redis-dev` | `taphuynh.dev` | SSH | `ssh://10.10.1.120:22` |
| `ssh-redis-staging` | `taphuynh.dev` | SSH | `ssh://10.10.1.121:22` |

### 10.2 Developer Access to Redis (SSH Port Forwarding)

Developers needing direct Redis access from their Mac can use SSH tunneling through the Cloudflare Tunnel:

```bash
# Forward local port 6379 to dev Redis
ssh -L 6379:10.10.1.120:6379 ssh-redis-dev.taphuynh.dev

# Then in another terminal:
redis-cli -h 127.0.0.1 -p 6379 -a '<dev-password>'

# For staging:
ssh -L 6380:10.10.1.121:6379 ssh-redis-staging.taphuynh.dev
redis-cli -h 127.0.0.1 -p 6380 -a '<staging-password>'
```

### 10.3 Update Cloudflare Tunnel Documentation

After adding the SSH routes, update [`deploy-ct101-cloudflare-tunnel.md`](./deploy-ct101-cloudflare-tunnel.md) with the new entries:

```markdown
### VM 420 — redis-dev

| Subdomain | Domain | Type | URL | Notes |
|-----------|--------|------|-----|-------|
| `ssh-redis-dev` | `taphuynh.dev` | SSH | `ssh://10.10.1.120:22` | |

### VM 421 — redis-staging

| Subdomain | Domain | Type | URL | Notes |
|-----------|--------|------|-----|-------|
| `ssh-redis-staging` | `taphuynh.dev` | SSH | `ssh://10.10.1.121:22` | |
```

---

## 11. Update Application Configuration

### 11.1 Environment Variables

Update `.env` files for each environment. The database number in the URL controls which logical database is used.

**Dev environment** (all services connecting to `10.10.1.120`):

```env
# NestJS API — BullMQ + Cache
REDIS_HOST=10.10.1.120
REDIS_PORT=6379
REDIS_PASS=<dev-password>

# STT-V2 — Dramatiq broker (db5) + Pub/Sub + Streams (db2)
REDIS_URL=redis://:${REDIS_PASS}@10.10.1.120:6379/5

# SMR — Task state + Streams (db3)
SMR_V2_REDIS_URL=redis://:${REDIS_PASS}@10.10.1.120:6379/3

# Celery — Broker + results (db4)
CELERY_BROKER_URL=redis://:${REDIS_PASS}@10.10.1.120:6379/4
CELERY_RESULT_BACKEND=redis://:${REDIS_PASS}@10.10.1.120:6379/4

# Summary agent (db3 — shares with SMR)
SUMMARY_AGENT_REDIS_URL=redis://:${REDIS_PASS}@10.10.1.120:6379/3
```

**Staging environment** (all services connecting to `10.10.1.121`):

```env
# NestJS API — BullMQ + Cache
REDIS_HOST=10.10.1.121
REDIS_PORT=6379
REDIS_PASS=<staging-password>

# STT-V2
REDIS_URL=redis://:${REDIS_PASS}@10.10.1.121:6379/5

# SMR
SMR_V2_REDIS_URL=redis://:${REDIS_PASS}@10.10.1.121:6379/3

# Celery
CELERY_BROKER_URL=redis://:${REDIS_PASS}@10.10.1.121:6379/4
CELERY_RESULT_BACKEND=redis://:${REDIS_PASS}@10.10.1.121:6379/4

# Summary agent
SUMMARY_AGENT_REDIS_URL=redis://:${REDIS_PASS}@10.10.1.121:6379/3
```

### 11.2 Application Code Considerations

The NestJS API's `RedisServiceModule` reads from `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASS` — no code changes needed. BullMQ defaults to `db0`.

For database-specific connections in services that need a specific DB number, the connection URL with `/<db-number>` suffix handles selection automatically (e.g., `redis://:pass@host:6379/4`).

The `IRedisCacheService` should be configured to use `db1`. If it currently defaults to `db0`, update the `redis-cache.module.ts` connection options:

```typescript
db: 1, // Application cache database
```

---

## 12. Automated Backup

### 12.1 Deploy Backup Script

The backup script is included in the config files at `configs/redis/backup.sh`. Deploy it on **both VMs**:

```bash
sudo cp /opt/redis/backup.sh /usr/local/bin/redis-backup.sh
sudo chmod +x /usr/local/bin/redis-backup.sh
```

### 12.2 Schedule via Cron

```bash
# Dev — daily at 04:00
(sudo crontab -l 2>/dev/null; echo '0 4 * * * REDIS_PASS="<dev-password>" /usr/local/bin/redis-backup.sh >> /opt/redis/logs/backup.log 2>&1') | sudo crontab -

# Staging — daily at 04:00
(sudo crontab -l 2>/dev/null; echo '0 4 * * * REDIS_PASS="<staging-password>" /usr/local/bin/redis-backup.sh >> /opt/redis/logs/backup.log 2>&1') | sudo crontab -
```

### 12.3 Retention

| Environment | Retention | Schedule |
|-------------|-----------|----------|
| Dev | 3 days | Daily 04:00 |
| Staging | 7 days | Daily 04:00 |

### 12.4 Manual Backup

```bash
# Trigger an immediate backup
sudo REDIS_PASS="<password>" /usr/local/bin/redis-backup.sh

# Check backup files
ls -lah /opt/redis/backups/
```

---

## 13. Monitoring

### 13.1 redis-exporter

The `redis-exporter` sidecar is included in the Docker Compose file. It exposes Prometheus metrics on port `9121`.

### 13.2 Prometheus Scrape Config

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'redis'
    scrape_interval: 15s
    static_configs:
      - targets: ['10.10.1.120:9121']
        labels:
          environment: 'dev'
          service: 'redis'
      - targets: ['10.10.1.121:9121']
        labels:
          environment: 'staging'
          service: 'redis'
```

### 13.3 Key Metrics to Monitor

| Metric | Alert Threshold | Meaning |
|--------|----------------|---------|
| `redis_memory_used_bytes` | > 80% of `maxmemory` | Memory pressure — evictions starting |
| `redis_connected_clients` | > 500 (spike) | Possible connection leak |
| `redis_rejected_connections_total` | > 0 | `maxclients` reached |
| `redis_keyspace_hits_total / (hits + misses)` | < 80% | Poor cache hit ratio |
| `redis_rdb_last_bgsave_status` | != 1 | RDB snapshot failed |
| `redis_aof_last_bgrewrite_status` | != 1 | AOF rewrite failed |
| `redis_evicted_keys_total` | increasing | Memory full, keys being evicted |
| `redis_commands_duration_seconds` | p99 > 10ms | Slow commands — check slow log |

### 13.4 Recommended Grafana Dashboard

| Dashboard ID | Name |
|-------------|------|
| 763 | Redis Dashboard for Prometheus Redis Exporter |

---

## 14. Verify

### Full Verification Checklist

Run on **each VM** after deployment:

```bash
# 1. Service running and healthy
docker compose ps
# → hope-redis: running (healthy), redis-exporter: running

# 2. Redis responds
docker exec hope-redis redis-cli -a "$REDIS_PASS" ping
# → PONG

# 3. Correct version
docker exec hope-redis redis-cli -a "$REDIS_PASS" info server | grep redis_version
# → redis_version:8.x.x

# 4. Correct maxmemory
docker exec hope-redis redis-cli -a "$REDIS_PASS" config get maxmemory
# Dev: 536870912 (512 MB)
# Staging: 2147483648 (2 GB)

# 5. Persistence enabled
docker exec hope-redis redis-cli -a "$REDIS_PASS" config get appendonly
# → yes

# 6. Database isolation works
docker exec hope-redis redis-cli -a "$REDIS_PASS" -n 0 set test:bullmq "ok"
docker exec hope-redis redis-cli -a "$REDIS_PASS" -n 1 set test:cache "ok"
docker exec hope-redis redis-cli -a "$REDIS_PASS" -n 0 get test:cache
# → (nil) — keys are isolated per database
docker exec hope-redis redis-cli -a "$REDIS_PASS" -n 0 del test:bullmq
docker exec hope-redis redis-cli -a "$REDIS_PASS" -n 1 del test:cache

# 7. Reachable from other VMs
# From any other VM on 10.10.1.0/24:
redis-cli -h 10.10.1.120 -a '<dev-password>' ping
# → PONG

# 8. Exporter metrics
curl -s http://10.10.1.120:9121/metrics | grep redis_up
# → redis_up 1

# 9. Firewall rules active
awall list
iptables -L DOCKER-USER -n -v

# 10. Not reachable from outside internal network
# This should time out from any non-10.10.1.x machine
```

---

## 15. Operational Runbook

### Common Commands

```bash
# Redis CLI (from the VM)
docker exec -it hope-redis redis-cli -a "$REDIS_PASS"

# Monitor all commands in real-time
docker exec hope-redis redis-cli -a "$REDIS_PASS" monitor

# Slow log (commands taking > 10ms)
docker exec hope-redis redis-cli -a "$REDIS_PASS" slowlog get 10

# Memory usage report
docker exec hope-redis redis-cli -a "$REDIS_PASS" info memory

# Client connections
docker exec hope-redis redis-cli -a "$REDIS_PASS" client list

# Keyspace stats (keys per database)
docker exec hope-redis redis-cli -a "$REDIS_PASS" info keyspace

# Flush a specific database (dev only — blocked in staging)
docker exec hope-redis redis-cli -a "$REDIS_PASS" -n 0 FLUSHDB

# Trigger RDB snapshot
docker exec hope-redis redis-cli -a "$REDIS_PASS" BGSAVE

# Trigger AOF rewrite
docker exec hope-redis redis-cli -a "$REDIS_PASS" BGREWRITEAOF
```

### Restart Procedure

```bash
cd /opt/redis

# Graceful restart (waits for persistence to complete)
docker compose restart redis

# Full restart (down + up)
docker compose down
docker compose up -d
```

### Upgrading Redis

```bash
cd /opt/redis

# 1. Check current version
docker exec hope-redis redis-cli -a "$REDIS_PASS" info server | grep redis_version

# 2. Update image tag in docker-compose.yml
# Edit the redis image tag

# 3. Pull and recreate
docker compose pull
docker compose up -d

# 4. Verify
docker exec hope-redis redis-cli -a "$REDIS_PASS" info server | grep redis_version
```

---

## 16. Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `NOAUTH Authentication required` | Missing or wrong password | Check `REDIS_PASS` in `.env`, verify `redis.conf` has matching `requirepass` |
| `OOM command not allowed` | Memory limit reached, eviction policy can't free keys | Check `maxmemory-policy`, increase `maxmemory`, or flush unneeded databases |
| `Connection refused` | Redis not running or firewall blocking | `docker compose ps`, check `awall list` / `iptables -L -n`, verify port 6379 is published |
| High latency / slow commands | Large keys, blocking commands, or THP enabled | Check `slowlog`, verify THP is disabled, check `KEYS` usage |
| AOF rewrite failing | Disk full | Check `df -h`, clean old backups, expand disk |
| Exporter shows `redis_up 0` | Exporter can't connect | Verify exporter `REDIS_PASSWORD` matches, check container networking |
| `ERR unknown command` (staging) | Command has been renamed | Expected for `FLUSHALL`, `CONFIG`, etc. Use renamed versions or connect to dev |
| BullMQ jobs stuck | Redis memory full or connection issues | Check `info memory`, check `info clients`, restart BullMQ workers |

### Logs

```bash
# Redis logs
docker logs -f hope-redis

# Exporter logs
docker logs -f redis-exporter

# Backup logs
tail -f /opt/redis/logs/backup.log
```

---

## Quick Reference

```
VM 420 — Redis Dev (Alpine Linux 3.21)
  IP:         10.10.1.120
  SSH alias:  ssh redis-dev       (via cloudflared → ssh-redis-dev.taphuynh.dev)
  User:       dell                (zsh + oh-my-zsh)
  Port:       6379
  Exporter:   9121
  maxmemory:  512 MB
  Config:     /opt/redis/redis.conf (redis-dev.conf)
  Data:       /opt/redis/data/
  Backups:    /opt/redis/backups/ (3-day retention)
  Compose:    /opt/redis/docker-compose.yml

VM 421 — Redis Staging (Alpine Linux 3.21)
  IP:         10.10.1.121
  SSH alias:  ssh redis-staging   (via cloudflared → ssh-redis-staging.taphuynh.dev)
  User:       dell                (zsh + oh-my-zsh)
  Port:       6379
  Exporter:   9121
  maxmemory:  2 GB
  Config:     /opt/redis/redis.conf (redis-staging.conf)
  Data:       /opt/redis/data/
  Backups:    /opt/redis/backups/ (7-day retention)
  Compose:    /opt/redis/docker-compose.yml
```

### Connection Strings

| Environment | Purpose | Connection String |
|-------------|---------|-------------------|
| Dev | BullMQ (db0) | `redis://:password@10.10.1.120:6379/0` |
| Dev | Cache (db1) | `redis://:password@10.10.1.120:6379/1` |
| Dev | STT Streams (db2) | `redis://:password@10.10.1.120:6379/2` |
| Dev | SMR Streams (db3) | `redis://:password@10.10.1.120:6379/3` |
| Dev | Celery (db4) | `redis://:password@10.10.1.120:6379/4` |
| Dev | Dramatiq (db5) | `redis://:password@10.10.1.120:6379/5` |
| Staging | BullMQ (db0) | `redis://:password@10.10.1.121:6379/0` |
| Staging | Cache (db1) | `redis://:password@10.10.1.121:6379/1` |
| Staging | STT Streams (db2) | `redis://:password@10.10.1.121:6379/2` |
| Staging | SMR Streams (db3) | `redis://:password@10.10.1.121:6379/3` |
| Staging | Celery (db4) | `redis://:password@10.10.1.121:6379/4` |
| Staging | Dramatiq (db5) | `redis://:password@10.10.1.121:6379/5` |


---

## 17. Disk Expansion

If you need to expand a Redis VM's disk later, Alpine uses a raw partition layout (no LVM by default):

```bash
# On Proxmox host
qm resize 420 scsi0 +8G

# Inside the Alpine VM
# Check layout
lsblk
fdisk -l /dev/sda

# Resize partition (usually sda3 for sys install)
parted /dev/sda resizepart 3 100%

# Resize filesystem
resize2fs /dev/sda3

# Verify
df -h /
```

> If Alpine was installed with LVM (`lvmsys` option), use LVM expansion commands: `pvresize` → `lvextend` → `resize2fs`.

---

## 18. Alpine Operational Reference

Sections 7–16 of this guide use Docker Compose, which works identically on Alpine. The only differences are in host-level commands:

| Task | Command |
|------|---------|
| Start a service | `sudo service docker start` |
| Enable at boot | `sudo rc-update add docker default` |
| Check service status | `sudo service docker status` |
| View system logs | `tail -f /var/log/messages` |
| Reboot | `sudo reboot` |
| Firewall status | `awall list && iptables -L -n` |
| Add firewall rule | Edit `/etc/awall/optional/redis.json` → `awall activate` |
| Scheduled tasks | `crontab -e` |
