# Proxmox Network Topology — Dell 7920 Homelab

**Date**: 2026-03-12
**Host**: Dell Precision 7920 Tower — Proxmox VE 9.1
**Design Pattern**: VLAN-aware bridge + internal bridges with NAT + cloudflared ingress

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Network Architecture](#2-network-architecture)
3. [IP Addressing Plan](#3-ip-addressing-plan)
4. [VM/LXC Assignment](#4-vmlxc-assignment)
5. [Implementation: Proxmox Host](#5-implementation-proxmox-host)
6. [Implementation: Cloudflared LXC](#6-implementation-cloudflared-lxc)
7. [Implementation: VM/LXC Network Config](#7-implementation-vmlxc-network-config)
8. [Firewall Rules](#8-firewall-rules)
9. [Verification](#9-verification)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Design Principles

Based on community best practices (Proxmox forums, VirtualizationHowto, StandingLynx):

| Principle | Implementation |
|-----------|---------------|
| **Segment by trust/environment** | Separate bridges per environment (dev, staging, 4bits) |
| **Least privilege** | VMs only reach what they need — no flat network |
| **Single ingress point** | All external traffic enters through cloudflared LXC only |
| **No exposed ports** | Zero inbound ports on the WAN — Cloudflare Tunnel handles everything |
| **Shared services accessible** | ubuntu-live-gpu reachable from all environments |
| **Internet for all** | NAT masquerade on Proxmox host gives all internal VMs outbound internet |
| **Management isolated** | Proxmox web UI on a separate subnet from workloads |

---

## 2. Network Architecture

```
                            ┌─────────────────────────┐
                            │     INTERNET            │
                            │  (Cloudflare Edge)       │
                            └──────────┬──────────────┘
                                       │
                              Cloudflare Tunnel
                              (outbound only, no open ports)
                                       │
┌──────────────────────────────────────┼──────────────────────────────────────┐
│  PROXMOX HOST (Dell 7920)            │                                      │
│                                      │                                      │
│  ┌───────────────────────────────────┼────────────────────────────────────┐ │
│  │  vmbr0 — MANAGEMENT / LAN (192.168.68.0/24)                            │ │
│  │  Physical NIC: eno1                                                     │ │
│  │  Proxmox UI: 192.168.68.130 (fixed IP from router)                     │ │
│  │                                                                        │ │
│  │  ┌──────────────────┐                                                  │ │
│  │  │ cloudflared (LXC) │ 192.168.68.117                                   │ │
│  │  │ CT 100            │──── Also connected to vmbr1, vmbr2, vmbr3,      │ │
│  │  │                   │     vmbr4 (reaches all environments)            │ │
│  │  └──────────────────┘                                                  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  vmbr1 — SHARED SERVICES (10.10.1.0/24)                                │ │
│  │  Internal bridge (no physical NIC) — NAT to vmbr0                      │ │
│  │                                                                        │ │
│  │  ┌──────────────────┐                                                  │ │
│  │  │ ubuntu-live-gpu   │ 10.10.1.10                                      │ │
│  │  │ VM 101            │ GPU #1 (4f:00.0) + GPU #2 (d5:00.0)             │ │
│  │  │                   │ Also connected to vmbr2, vmbr3, vmbr4           │ │
│  │  └──────────────────┘                                                  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  vmbr2 — ARCA DEV (10.10.2.0/24)                                       │ │
│  │  Internal bridge (no physical NIC) — NAT to vmbr0                      │ │
│  │                                                                        │ │
│  │  ┌──────────────────┐  ┌──────────────────┐                            │ │
│  │  │ arca-dev-01       │  │ arca-dev-02       │                          │ │
│  │  │ VM 201            │  │ VM 202            │                          │ │
│  │  │ 10.10.2.11        │  │ 10.10.2.12        │                          │ │
│  │  └──────────────────┘  └──────────────────┘                            │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  vmbr3 — ARCA STAGING (10.10.3.0/24)                                   │ │
│  │  Internal bridge (no physical NIC) — NAT to vmbr0                      │ │
│  │                                                                        │ │
│  │  ┌──────────────────┐  ┌──────────────────┐                            │ │
│  │  │ arca-stg-01       │  │ arca-stg-02       │                          │ │
│  │  │ VM 301            │  │ VM 302            │                          │ │
│  │  │ 10.10.3.11        │  │ 10.10.3.12        │                          │ │
│  │  └──────────────────┘  └──────────────────┘                            │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  vmbr4 — 4BITS (10.10.4.0/24)                                          │ │
│  │  Internal bridge (no physical NIC) — NAT to vmbr0                      │ │
│  │                                                                        │ │
│  │  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌─────────┐   │ │
│  │  │ 4bits-01  │ │ 4bits-02  │ │ 4bits-03  │ │ 4bits-04  │ │ 4bits-05│   │ │
│  │  │ VM 401    │ │ VM 402    │ │ VM 403    │ │ VM 404    │ │ VM 405  │   │ │
│  │  │ 10.10.4.11│ │ 10.10.4.12│ │ 10.10.4.13│ │ 10.10.4.14│ │.4.15    │   │ │
│  │  └───────────┘ └───────────┘ └───────────┘ └───────────┘ └─────────┘   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  IP Forwarding + NAT Masquerade (iptables)                                  │
│  vmbr1,2,3,4 → vmbr0 → Internet                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Traffic Flow

```
End User → Cloudflare Edge → Cloudflare Tunnel → cloudflared LXC (192.168.68.117)
                                                       │
                                    ┌──────────────────┼──────────────────┐
                                    │                  │                  │
                              vmbr2 (dev)        vmbr3 (stg)       vmbr4 (4bits)
                              10.10.2.x          10.10.3.x         10.10.4.x
                                    │                  │                  │
                              arca-dev-*         arca-stg-*        4bits-*

All VMs → NAT (Proxmox host) → vmbr0 (192.168.68.0/24) → Router → Internet
```

---

## 3. IP Addressing Plan

### Subnets

| Bridge | Subnet | Gateway | Purpose |
|--------|--------|---------|---------|
| **vmbr0** | 192.168.68.0/24 | 192.168.68.1 (router) | LAN + Management + WAN uplink |
| **vmbr1** | 10.10.1.0/24 | 10.10.1.1 (PVE host) | Shared services (GPU VM) |
| **vmbr2** | 10.10.2.0/24 | 10.10.2.1 (PVE host) | ARCA Development |
| **vmbr3** | 10.10.3.0/24 | 10.10.3.1 (PVE host) | ARCA Staging |
| **vmbr4** | 10.10.4.0/24 | 10.10.4.1 (PVE host) | 4bits Project |

Note: vmbr0 uses your existing home LAN subnet assigned by the router. vmbr1–4 are private internal subnets that NAT through vmbr0 to reach the internet.

### Host Assignments

| VM/LXC | ID | Type | Bridge(s) | IP Address(es) | Role |
|--------|----|------|-----------|----------------|------|
| **Proxmox Host** | — | Host | vmbr0 | 192.168.68.130 (fixed) | Hypervisor management |
| **cloudflared** | CT 100 | LXC | vmbr0, vmbr1, vmbr2, vmbr3, vmbr4 | 192.168.68.117, 10.10.1.2, 10.10.2.2, 10.10.3.2, 10.10.4.2 | Tunnel ingress proxy |
| **ubuntu-live-gpu** | VM 101 | VM | vmbr1, vmbr2, vmbr3, vmbr4 | 10.10.1.10, 10.10.2.10, 10.10.3.10, 10.10.4.10 | Shared GPU compute |
| **arca-dev-01** | VM 201 | VM | vmbr2 | 10.10.2.11 | ARCA dev instance 1 |
| **arca-dev-02** | VM 202 | VM | vmbr2 | 10.10.2.12 | ARCA dev instance 2 |
| **arca-stg-01** | VM 301 | VM | vmbr3 | 10.10.3.11 | ARCA staging instance 1 |
| **arca-stg-02** | VM 302 | VM | vmbr3 | 10.10.3.12 | ARCA staging instance 2 |
| **4bits-01** | VM 401 | VM | vmbr4 | 10.10.4.11 | 4bits instance 1 |
| **4bits-02** | VM 402 | VM | vmbr4 | 10.10.4.12 | 4bits instance 2 |
| **4bits-03** | VM 403 | VM | vmbr4 | 10.10.4.13 | 4bits instance 3 |
| **4bits-04** | VM 404 | VM | vmbr4 | 10.10.4.14 | 4bits instance 4 |
| **4bits-05** | VM 405 | VM | vmbr4 | 10.10.4.15 | 4bits instance 5 |

### Why cloudflared and ubuntu-live-gpu Have Multiple NICs

**cloudflared** needs to reach every environment to proxy traffic. Rather than routing through the Proxmox host (adding latency and complexity), it gets a NIC on each bridge — direct L2 connectivity to every VM.

**ubuntu-live-gpu** is a shared resource. Every environment needs to reach it (for GPU compute, shared databases, etc.). Multi-homing it on all bridges means each environment accesses it at a local IP on their own subnet — no cross-subnet routing needed.

---

## 4. VM/LXC Assignment

### Connectivity Matrix

| Source ↓ / Dest → | cloudflared | ubuntu-gpu | arca-dev | arca-stg | 4bits |
|-------------------|-------------|------------|----------|----------|-------|
| **cloudflared** | — | vmbr1 | vmbr2 | vmbr3 | vmbr4 |
| **ubuntu-gpu** | vmbr1 | — | vmbr2 | vmbr3 | vmbr4 |
| **arca-dev-**** | vmbr2 | vmbr2 | vmbr2 (L2) | **blocked** | **blocked** |
| **arca-stg-**** | vmbr3 | vmbr3 | **blocked** | vmbr3 (L2) | **blocked** |
| **4bits-**** | vmbr4 | vmbr4 | **blocked** | **blocked** | vmbr4 (L2) |

Key isolation properties:
- arca-dev VMs **cannot** reach arca-stg or 4bits VMs (different bridges, no routing between them)
- arca-stg VMs **cannot** reach arca-dev or 4bits VMs
- 4bits VMs **cannot** reach arca-dev or arca-stg VMs
- All environments **can** reach ubuntu-live-gpu and cloudflared (multi-homed)
- All VMs **can** reach the internet (via NAT through Proxmox host)

---

## 5. Implementation: Proxmox Host

### 5.1 — Network Configuration

SSH into the Proxmox host and edit `/etc/network/interfaces`:

```bash
nano /etc/network/interfaces
```

Replace the contents with (adjust `eno1` to your actual physical NIC name — check with `ip link show`):

```
# /etc/network/interfaces
# Proxmox VE Network Configuration — Dell 7920 Homelab
# Proxmox Host IP: 192.168.68.130 (fixed by router)

auto lo
iface lo inet loopback

# ─────────────────────────────────────────────────────────
# Physical NIC
# ─────────────────────────────────────────────────────────
auto eno1
iface eno1 inet manual

# ─────────────────────────────────────────────────────────
# vmbr0 — LAN / MANAGEMENT + WAN
# Connected to physical NIC, on your home LAN (192.168.68.0/24)
# Proxmox web UI: https://192.168.68.130:8006
# ─────────────────────────────────────────────────────────
auto vmbr0
iface vmbr0 inet static
    address 192.168.68.130/24
    gateway 192.168.68.1
    bridge-ports eno1
    bridge-stp off
    bridge-fd 0

# ─────────────────────────────────────────────────────────
# vmbr1 — SHARED SERVICES (ubuntu-live-gpu)
# Internal only, NAT to internet via vmbr0
# ─────────────────────────────────────────────────────────
auto vmbr1
iface vmbr1 inet static
    address 10.10.1.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up   iptables -t nat -C POSTROUTING -s '10.10.1.0/24' -o vmbr0 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s '10.10.1.0/24' -o vmbr0 -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s '10.10.1.0/24' -o vmbr0 -j MASQUERADE 2>/dev/null || true

# ─────────────────────────────────────────────────────────
# vmbr2 — ARCA DEVELOPMENT
# Internal only, NAT to internet via vmbr0
# ─────────────────────────────────────────────────────────
auto vmbr2
iface vmbr2 inet static
    address 10.10.2.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up   iptables -t nat -C POSTROUTING -s '10.10.2.0/24' -o vmbr0 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s '10.10.2.0/24' -o vmbr0 -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s '10.10.2.0/24' -o vmbr0 -j MASQUERADE 2>/dev/null || true

# ─────────────────────────────────────────────────────────
# vmbr3 — ARCA STAGING
# Internal only, NAT to internet via vmbr0
# ─────────────────────────────────────────────────────────
auto vmbr3
iface vmbr3 inet static
    address 10.10.3.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up   iptables -t nat -C POSTROUTING -s '10.10.3.0/24' -o vmbr0 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s '10.10.3.0/24' -o vmbr0 -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s '10.10.3.0/24' -o vmbr0 -j MASQUERADE 2>/dev/null || true

# ─────────────────────────────────────────────────────────
# vmbr4 — 4BITS PROJECT
# Internal only, NAT to internet via vmbr0
# ─────────────────────────────────────────────────────────
auto vmbr4
iface vmbr4 inet static
    address 10.10.4.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up   iptables -t nat -C POSTROUTING -s '10.10.4.0/24' -o vmbr0 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s '10.10.4.0/24' -o vmbr0 -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s '10.10.4.0/24' -o vmbr0 -j MASQUERADE 2>/dev/null || true
```

### 5.2 — Enable IP Forwarding

```bash
# Enable immediately
sysctl -w net.ipv4.ip_forward=1

# Make persistent across reboots
echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.d/99-ip-forward.conf
```

### 5.3 — Prevent Cross-Environment Routing

The Proxmox host can route between vmbr1–4 by default (it has an IP on each). We need to:
1. **Explicitly ACCEPT** traffic from internal bridges to vmbr0 (internet-bound)
2. **DROP** traffic between isolated environments (vmbr2 ↔ vmbr3 ↔ vmbr4)

Order matters — ACCEPT rules must be evaluated before DROP rules.

```bash
cat > /etc/network/if-up.d/isolation-rules <<'SCRIPT'
#!/bin/bash
# Idempotent: flush custom chain and rebuild on every run

# Create a custom chain (or flush if it already exists)
iptables -N VM_ISOLATION 2>/dev/null || iptables -F VM_ISOLATION

# ── ACCEPT: Allow all internal bridges to reach internet (vmbr0) ──
iptables -A VM_ISOLATION -i vmbr1 -o vmbr0 -j ACCEPT
iptables -A VM_ISOLATION -i vmbr2 -o vmbr0 -j ACCEPT
iptables -A VM_ISOLATION -i vmbr3 -o vmbr0 -j ACCEPT
iptables -A VM_ISOLATION -i vmbr4 -o vmbr0 -j ACCEPT

# ── ACCEPT: Allow return traffic from internet back to VMs ──
iptables -A VM_ISOLATION -i vmbr0 -o vmbr1 -m state --state RELATED,ESTABLISHED -j ACCEPT
iptables -A VM_ISOLATION -i vmbr0 -o vmbr2 -m state --state RELATED,ESTABLISHED -j ACCEPT
iptables -A VM_ISOLATION -i vmbr0 -o vmbr3 -m state --state RELATED,ESTABLISHED -j ACCEPT
iptables -A VM_ISOLATION -i vmbr0 -o vmbr4 -m state --state RELATED,ESTABLISHED -j ACCEPT

# ── DROP: Block cross-environment routing ──
# arca-dev (vmbr2) cannot reach arca-stg (vmbr3) or 4bits (vmbr4)
iptables -A VM_ISOLATION -i vmbr2 -o vmbr3 -j DROP
iptables -A VM_ISOLATION -i vmbr2 -o vmbr4 -j DROP

# arca-stg (vmbr3) cannot reach arca-dev (vmbr2) or 4bits (vmbr4)
iptables -A VM_ISOLATION -i vmbr3 -o vmbr2 -j DROP
iptables -A VM_ISOLATION -i vmbr3 -o vmbr4 -j DROP

# 4bits (vmbr4) cannot reach arca-dev (vmbr2) or arca-stg (vmbr3)
iptables -A VM_ISOLATION -i vmbr4 -o vmbr2 -j DROP
iptables -A VM_ISOLATION -i vmbr4 -o vmbr3 -j DROP

# ── Hook the custom chain into FORWARD (only once) ──
iptables -C FORWARD -j VM_ISOLATION 2>/dev/null || iptables -I FORWARD -j VM_ISOLATION
SCRIPT

chmod +x /etc/network/if-up.d/isolation-rules
```

**Why a custom chain?** Using `iptables -I FORWARD` (insert) with individual rules is fragile — rule ordering depends on execution order, and re-running the script duplicates rules. A custom chain (`VM_ISOLATION`) is flushed and rebuilt cleanly every time, and hooked into FORWARD exactly once.

### 5.4 — Apply Network Configuration

```bash
# Apply without reboot
ifreload -a

# Verify bridges exist
ip -br addr show | grep vmbr

# Expected output:
# vmbr0   UP   192.168.68.130/24
# vmbr1   UP   10.10.1.1/24
# vmbr2   UP   10.10.2.1/24
# vmbr3   UP   10.10.3.1/24
# vmbr4   UP   10.10.4.1/24

# Verify NAT rules
iptables -t nat -L POSTROUTING -n | grep MASQUERADE

# Verify isolation rules
iptables -L FORWARD -n | grep DROP
```

---

## 6. Implementation: Cloudflared LXC

### 6.1 — Create LXC Container

In the Proxmox web UI:

1. **Create CT** (top right)
2. **General**: CT ID = `100`, Hostname = `cloudflared`
3. **Template**: Debian 12 or Ubuntu 24.04 (download from CT templates first)
4. **Disks**: 8 GB (cloudflared is tiny)
5. **CPU**: 2 cores
6. **Memory**: 512 MB (cloudflared uses very little)
7. **Network**: Configure the first NIC only for now (we'll add more)
   - Bridge: `vmbr0`, IP: `192.168.68.117/24`, Gateway: `192.168.68.1`

After creation, add the additional NICs via CLI:

```bash
# Add NIC for each environment
pct set 100 -net1 name=eth1,bridge=vmbr1,ip=10.10.1.2/24
pct set 100 -net2 name=eth2,bridge=vmbr2,ip=10.10.2.2/24
pct set 100 -net3 name=eth3,bridge=vmbr3,ip=10.10.3.2/24
pct set 100 -net4 name=eth4,bridge=vmbr4,ip=10.10.4.2/24
```

Note: The vmbr0 NIC (`192.168.68.117`) gives cloudflared internet access via your home LAN. Reserve this IP in your router's DHCP settings to avoid conflicts.

### 6.2 — Install Cloudflared Inside LXC

```bash
# Start and enter the container
pct start 100
pct enter 100

# Install cloudflared
apt update && apt install -y curl
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared.deb

# Authenticate (follow the URL it gives you)
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create hope-homelab

# Note the tunnel UUID from the output
```

### 6.3 — Configure Tunnel

```bash
mkdir -p /etc/cloudflared

cat > /etc/cloudflared/config.yml <<'EOF'
tunnel: <YOUR-TUNNEL-UUID>
credentials-file: /root/.cloudflared/<YOUR-TUNNEL-UUID>.json

ingress:
  # ─── Proxmox Management ───
  - hostname: pve.taphuynh.dev
    service: https://192.168.68.130:8006
    originRequest:
      noTLSVerify: true
      disableChunkedEncoding: true

  # ─── ARCA Dev Apps ───
  - hostname: dev.taphuynh.dev
    service: http://10.10.2.11:8868
    originRequest:
      disableChunkedEncoding: true
  - hostname: dev-ui.taphuynh.dev
    service: http://10.10.2.11:5175
    originRequest:
      disableChunkedEncoding: true

  # ─── ARCA Staging Apps ───
  - hostname: stg.taphuynh.dev
    service: http://10.10.3.11:8868
    originRequest:
      disableChunkedEncoding: true
  - hostname: stg-ui.taphuynh.dev
    service: http://10.10.3.11:5175
    originRequest:
      disableChunkedEncoding: true

  # ─── 4bits Apps ───
  - hostname: 4bits.taphuynh.dev
    service: http://10.10.4.11:80
    originRequest:
      disableChunkedEncoding: true

  # ─── SSH Access: ubuntu-live-gpu ───
  - hostname: gpu.taphuynh.dev
    service: ssh://10.10.1.10:22

  # ─── Catch-all ───
  - service: http_status:404
EOF
```

Adjust the hostnames and ports to match your actual services. The key point is that cloudflared can reach every VM directly because it has a NIC on each bridge.

### 6.4 — Create DNS Records in Cloudflare

```bash
# Create CNAME records pointing to the tunnel
cloudflared tunnel route dns hope-homelab pve.taphuynh.dev
cloudflared tunnel route dns hope-homelab dev.taphuynh.dev
cloudflared tunnel route dns hope-homelab dev-ui.taphuynh.dev
cloudflared tunnel route dns hope-homelab stg.taphuynh.dev
cloudflared tunnel route dns hope-homelab stg-ui.taphuynh.dev
cloudflared tunnel route dns hope-homelab 4bits.taphuynh.dev
cloudflared tunnel route dns hope-homelab gpu.taphuynh.dev
```

### 6.5 — Run as Service

```bash
cloudflared service install
systemctl enable cloudflared
systemctl start cloudflared
systemctl status cloudflared
```

### 6.6 — SSH Access to ubuntu-live-gpu via Cloudflare Tunnel

SSH through a Cloudflare Tunnel uses `cloudflared` as a proxy on both ends. The traffic flow:

```
Your Mac (ssh) → cloudflared ProxyCommand → Cloudflare Edge → Tunnel → cloudflared LXC → SSH to ubuntu-live-gpu (10.10.1.10:22)
```

This gives you remote SSH access from anywhere — no VPN, no open ports.

#### Step 1: Ensure SSH is running inside ubuntu-live-gpu (VM 101)

```bash
# Inside ubuntu-live-gpu VM
sudo apt update && sudo apt install -y openssh-server

# Verify it's running
sudo systemctl enable ssh
sudo systemctl start ssh
sudo systemctl status ssh

# Confirm it's listening on port 22
ss -tlnp | grep :22
```

#### Step 2: Verify cloudflared LXC can reach the VM over SSH

```bash
# Inside cloudflared LXC (CT 100)
# Test SSH connectivity to ubuntu-live-gpu on the vmbr1 subnet
apt install -y openssh-client   # if not already installed
ssh -o ConnectTimeout=5 user@10.10.1.10
# Replace 'user' with the actual username on ubuntu-live-gpu
# This should prompt for password — that confirms the path works
# Ctrl+C to cancel after confirming
```

#### Step 3: Restart cloudflared to pick up the new SSH ingress rule

The SSH ingress rule was added in section 6.3 (`gpu.taphuynh.dev → ssh://10.10.1.10:22`).
The DNS CNAME was added in section 6.4.

```bash
# Inside cloudflared LXC
systemctl restart cloudflared
systemctl status cloudflared

# Verify the tunnel is healthy
journalctl -u cloudflared --no-pager -n 20
```

#### Step 4: Install cloudflared on your Mac (client side)

```bash
brew install cloudflared
```

#### Step 5: Configure SSH on your Mac

Add this block to `~/.ssh/config` on your Mac:

```
Host gpu.taphuynh.dev
  ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h
  User <your-ubuntu-username>
  StrictHostKeyChecking no
```

> **Note**: The `cloudflared` path depends on how you installed it. Check with `which cloudflared`. Common paths:
> - Homebrew (Apple Silicon): `/opt/homebrew/bin/cloudflared`
> - Homebrew (Intel): `/usr/local/bin/cloudflared`

#### Step 6: Connect

```bash
ssh gpu.taphuynh.dev
```

On first connection, `cloudflared` may open a browser window for Cloudflare Access authentication (if you have Access policies configured). After authenticating, the SSH session will establish normally.

#### Optional: SSH Key Authentication

For passwordless login, copy your public key to the VM:

```bash
# From your Mac
ssh-copy-id -o ProxyCommand="/opt/homebrew/bin/cloudflared access ssh --hostname gpu.taphuynh.dev" <your-ubuntu-username>@gpu.taphuynh.dev
```

Or manually append your public key (`~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub`) to `~/.ssh/authorized_keys` on the VM.

#### Verification Checklist

| Check | Command | Expected |
|-------|---------|----------|
| SSH running on VM | `ss -tlnp \| grep :22` (inside VM) | `*:22 LISTEN` |
| cloudflared can reach VM | `ssh user@10.10.1.10` (from CT 100) | Password prompt |
| Tunnel has SSH route | `journalctl -u cloudflared -n 50` (CT 100) | No errors, route registered |
| DNS resolves | `nslookup gpu.taphuynh.dev` (from Mac) | Returns Cloudflare IP |
| SSH works end-to-end | `ssh gpu.taphuynh.dev` (from Mac) | Shell on ubuntu-live-gpu |

---

## 7. Implementation: VM/LXC Network Config

### 7.1 — ubuntu-live-gpu (VM 101) — Multi-Homed

This VM has 4 NICs to be reachable from all environments:

```bash
# Via Proxmox CLI (after creating the VM with vmbr1 as primary)
qm set 101 -net0 virtio,bridge=vmbr1
qm set 101 -net1 virtio,bridge=vmbr2
qm set 101 -net2 virtio,bridge=vmbr3
qm set 101 -net3 virtio,bridge=vmbr4
```

Inside the VM, first discover your actual interface names — they vary by VM:

```bash
ip -br link show | grep -v lo
# Common patterns: ens18/ens19/... or enp6s18/enp6s19/... depending on PCI slot
```

Then configure `/etc/netplan/01-netcfg.yaml` using the actual names. On the Dell 7920 ubuntu-live-gpu VM, the interfaces are `enp6s18`–`enp6s21`:

```yaml
network:
  version: 2
  ethernets:
    enp6s18:
      addresses: [10.10.1.10/24]
      routes:
        - to: default
          via: 10.10.1.1
      nameservers:
        addresses: [8.8.8.8, 1.1.1.1]
    enp6s19:
      addresses: [10.10.2.10/24]
    enp6s20:
      addresses: [10.10.3.10/24]
    enp6s21:
      addresses: [10.10.4.10/24]
```

Only the primary NIC (vmbr1) has a default gateway — this prevents routing conflicts. The other NICs are reachable on their local subnets only.

> **Note**: Interface names depend on the PCI bus slot assigned by Proxmox. Always run `ip -br link show` first to confirm. Common names are `ens18`/`ens19` or `enp6s18`/`enp6s19`.

```bash
sudo netplan apply
```

### 7.2 — arca-dev-01 (VM 201) — Single NIC

```bash
qm set 201 -net0 virtio,bridge=vmbr2
```

Inside the VM (`/etc/netplan/01-netcfg.yaml`):

```yaml
network:
  version: 2
  ethernets:
    ens18:
      addresses: [10.10.2.11/24]
      routes:
        - to: default
          via: 10.10.2.1
      nameservers:
        addresses: [8.8.8.8, 1.1.1.1]
```

### 7.3 — arca-dev-02 (VM 202)

Same as above but IP `10.10.2.12`.

### 7.4 — arca-stg-01 (VM 301)

```yaml
network:
  version: 2
  ethernets:
    ens18:
      addresses: [10.10.3.11/24]
      routes:
        - to: default
          via: 10.10.3.1
      nameservers:
        addresses: [8.8.8.8, 1.1.1.1]
```

### 7.5 — arca-stg-02 (VM 302)

Same as above but IP `10.10.3.12`.

### 7.6 — 4bits-01 through 4bits-05 (VM 401–405)

All on vmbr4, IPs `10.10.4.11` through `10.10.4.15`:

```yaml
network:
  version: 2
  ethernets:
    ens18:
      addresses: [10.10.4.1X/24]   # 11, 12, 13, 14, or 15
      routes:
        - to: default
          via: 10.10.4.1
      nameservers:
        addresses: [8.8.8.8, 1.1.1.1]
```

---

## 8. Firewall Rules

### Summary of What's Allowed

| From | To | Allowed | Via |
|------|----|---------|-----|
| Any VM | Internet | Yes | NAT masquerade through vmbr0 |
| cloudflared | Any VM | Yes | Multi-homed (NIC on each bridge) |
| Any VM | ubuntu-live-gpu | Yes | Multi-homed (NIC on each bridge) |
| arca-dev-01 | arca-dev-02 | Yes | Same bridge (vmbr2) |
| arca-stg-01 | arca-stg-02 | Yes | Same bridge (vmbr3) |
| 4bits-01–05 | Each other | Yes | Same bridge (vmbr4) |
| arca-dev-* | arca-stg-* | **No** | Different bridges, FORWARD DROP |
| arca-dev-* | 4bits-* | **No** | Different bridges, FORWARD DROP |
| arca-stg-* | 4bits-* | **No** | Different bridges, FORWARD DROP |
| External user | Any VM | Only via cloudflared tunnel | Cloudflare Tunnel |
| External user | Proxmox host directly | **No** | No ports exposed |

### Proxmox Firewall (Optional Enhancement)

You can also enable Proxmox's built-in firewall for defense-in-depth:

```bash
# Enable firewall at datacenter level
pvesh set /cluster/firewall/options --enable 1

# Allow Proxmox web UI from LAN only
pvesh create /cluster/firewall/rules --action ACCEPT --type in --source 192.168.68.0/24 --dport 8006 --proto tcp

# Allow SSH from LAN only
pvesh create /cluster/firewall/rules --action ACCEPT --type in --source 192.168.68.0/24 --dport 22 --proto tcp
```

---

## 9. Verification

### From Proxmox Host

```bash
# All bridges up with correct IPs
ip -br addr show | grep vmbr
# Expected:
# vmbr0   UP   192.168.68.130/24
# vmbr1   UP   10.10.1.1/24
# vmbr2   UP   10.10.2.1/24
# vmbr3   UP   10.10.3.1/24
# vmbr4   UP   10.10.4.1/24

# IP forwarding enabled
sysctl net.ipv4.ip_forward
# Expected: net.ipv4.ip_forward = 1

# NAT MASQUERADE rules (one per internal subnet)
iptables -t nat -L POSTROUTING -n -v | grep MASQUERADE
# Expected: 4 MASQUERADE rules for 10.10.1-4.0/24 → vmbr0

# Isolation chain loaded
iptables -L VM_ISOLATION -n -v
# Expected: ACCEPT rules for vmbr1-4 → vmbr0, then DROP rules for cross-env

# Verify FORWARD chain hooks into VM_ISOLATION
iptables -L FORWARD -n | head -5
# Expected: first rule is "VM_ISOLATION  all  --  0.0.0.0/0  0.0.0.0/0"
```

### From cloudflared LXC (CT 100)

```bash
# Can reach all environments
ping -c 1 10.10.1.10   # ubuntu-gpu (shared)
ping -c 1 10.10.2.11   # arca-dev-01
ping -c 1 10.10.3.11   # arca-stg-01
ping -c 1 10.10.4.11   # 4bits-01

# Can reach internet
ping -c 1 1.1.1.1

# Tunnel is running
systemctl status cloudflared
```

### Internet Access — Test From Every VM Type

This is the critical check. Run from inside each VM/LXC:

```bash
# 1. Raw IP connectivity (bypasses DNS)
ping -c 2 1.1.1.1

# 2. DNS resolution
nslookup google.com

# 3. Package manager (the real test)
sudo apt update
```

**Expected results by VM:**

| VM | Bridge | Gateway | Internet? | Why |
|----|--------|---------|-----------|-----|
| cloudflared (CT 100) | vmbr0 | 192.168.68.1 (router) | Yes | Directly on LAN, same as Proxmox host |
| ubuntu-live-gpu (VM 101) | vmbr1 | 10.10.1.1 (PVE) | Yes | NAT: 10.10.1.0/24 → vmbr0 → router |
| arca-dev-01 (VM 201) | vmbr2 | 10.10.2.1 (PVE) | Yes | NAT: 10.10.2.0/24 → vmbr0 → router |
| arca-stg-01 (VM 301) | vmbr3 | 10.10.3.1 (PVE) | Yes | NAT: 10.10.3.0/24 → vmbr0 → router |
| 4bits-01 (VM 401) | vmbr4 | 10.10.4.1 (PVE) | Yes | NAT: 10.10.4.0/24 → vmbr0 → router |

If `ping 1.1.1.1` works but `apt update` fails, it's a DNS issue — check `nameservers` in the netplan config.

If `ping 1.1.1.1` fails, check from the Proxmox host:
```bash
# Verify the NAT path works
sysctl net.ipv4.ip_forward                              # must be 1
iptables -t nat -L POSTROUTING -n -v | grep MASQUERADE  # must show rules
iptables -L VM_ISOLATION -n | grep ACCEPT               # must show vmbr→vmbr0 ACCEPT
```

### From arca-dev-01 (VM 201) — Full Connectivity Test

```bash
# Can reach other dev VM (same bridge, L2)
ping -c 1 10.10.2.12   # arca-dev-02 — should SUCCEED

# Can reach shared GPU VM (ubuntu-gpu is multi-homed on vmbr2)
ping -c 1 10.10.2.10   # ubuntu-gpu on dev bridge — should SUCCEED

# Can reach internet (NAT through PVE host)
ping -c 1 1.1.1.1      # should SUCCEED
sudo apt update         # should SUCCEED

# CANNOT reach staging or 4bits (blocked by VM_ISOLATION chain)
ping -c 1 10.10.3.11   # arca-stg-01 — should FAIL (timeout)
ping -c 1 10.10.4.11   # 4bits-01 — should FAIL (timeout)
```

### From External (Your Browser)

```
https://pve.taphuynh.dev     → Proxmox web UI
https://dev.taphuynh.dev     → ARCA dev API
https://stg.taphuynh.dev     → ARCA staging API
https://4bits.taphuynh.dev   → 4bits app
```

---

## 10. Troubleshooting

### VM Can't Reach Internet

```bash
# Inside the VM
ip route show
# Should show: default via 10.10.X.1 dev ens18

# From Proxmox host, verify NAT
iptables -t nat -L POSTROUTING -n -v
# Should show MASQUERADE rules with packet counts > 0

# Verify IP forwarding
cat /proc/sys/net/ipv4/ip_forward
# Should be: 1
```

### VMs on Same Bridge Can't See Each Other

```bash
# From Proxmox host, check bridge members
brctl show vmbr2
# Should list tap devices for both VMs

# Verify both VMs are on the same subnet
# VM 201: 10.10.2.11/24
# VM 202: 10.10.2.12/24
# Both must have /24 mask (not /32)
```

### Cloudflared Can't Reach a VM

```bash
# Inside cloudflared LXC, check all NICs are up
ip -br addr show
# Should show eth0 through eth4 with IPs

# Ping the target
ping -c 1 10.10.2.11

# If ping fails, check the bridge from Proxmox host
brctl show vmbr2
```

### Isolation Not Working (Dev Can Reach Staging)

```bash
# From Proxmox host, verify VM_ISOLATION chain exists and has rules
iptables -L VM_ISOLATION -n -v

# If missing or empty, re-run the isolation script
/etc/network/if-up.d/isolation-rules

# Verify FORWARD chain jumps to VM_ISOLATION
iptables -L FORWARD -n | head -3

# Test from arca-dev-01
ping -c 1 10.10.3.11
# Should timeout (not "destination unreachable" — DROP not REJECT)
```

### VM Can Reach Internet But DNS Fails

```bash
# Inside the VM, test raw IP connectivity first
ping -c 1 1.1.1.1
# If this works but apt/curl fail, it's a DNS issue

# Check DNS config
cat /etc/resolv.conf
# Should contain: nameserver 8.8.8.8 or nameserver 1.1.1.1

# Test DNS resolution
nslookup google.com 8.8.8.8
```

---

## Quick Reference Card

```
BRIDGES:
  vmbr0  192.168.68.0/24  LAN + Management   (physical NIC, gateway 192.168.68.1)
  vmbr1  10.10.1.0/24     Shared Services     (internal, NAT → vmbr0)
  vmbr2  10.10.2.0/24     ARCA Dev            (internal, NAT → vmbr0)
  vmbr3  10.10.3.0/24     ARCA Staging        (internal, NAT → vmbr0)
  vmbr4  10.10.4.0/24     4bits               (internal, NAT → vmbr0)

PROXMOX HOST: 192.168.68.130

MULTI-HOMED:
  cloudflared   → vmbr0 (192.168.68.117), vmbr1 (.2), vmbr2 (.2), vmbr3 (.2), vmbr4 (.2)
  ubuntu-gpu    → vmbr1 (.10), vmbr2 (.10), vmbr3 (.10), vmbr4 (.10)

SINGLE-HOMED:
  arca-dev-01   → vmbr2 (.11)
  arca-dev-02   → vmbr2 (.12)
  arca-stg-01   → vmbr3 (.11)
  arca-stg-02   → vmbr3 (.12)
  4bits-01      → vmbr4 (.11)
  4bits-02      → vmbr4 (.12)
  4bits-03      → vmbr4 (.13)
  4bits-04      → vmbr4 (.14)
  4bits-05      → vmbr4 (.15)

ISOLATION:
  vmbr2 ✗ vmbr3    (dev cannot reach staging)
  vmbr2 ✗ vmbr4    (dev cannot reach 4bits)
  vmbr3 ✗ vmbr4    (staging cannot reach 4bits)

EXTERNAL ACCESS:
  pve.taphuynh.dev   → Proxmox UI (HTTPS)
  gpu.taphuynh.dev   → SSH to ubuntu-live-gpu
  dev.taphuynh.dev   → ARCA dev API
  stg.taphuynh.dev   → ARCA staging API
  4bits.taphuynh.dev → 4bits app
```
