# SSH + Cloudflared Setup — Mac to Homelab VMs

**Date**: 2026-03-18
**Client**: macOS (iTerm2 + cloudflared)
**Target**: All VMs on Proxmox host (Dell 7920) via Cloudflare Tunnel
**Related**: [Cloudflare Tunnel (CT 101)](./deploy-ct101-cloudflare-tunnel.md) | [Network Topology](./proxmox-network-topology-design.md)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Prerequisites](#3-prerequisites)
4. [Step 1: Generate SSH Key](#4-step-1-generate-ssh-key)
5. [Step 2: Create SSH Config](#5-step-2-create-ssh-config)
6. [Step 3: Deploy Keys to VMs](#6-step-3-deploy-keys-to-vms)
7. [Step 4: Verify Access](#7-step-4-verify-access)
8. [Step 5: Disable Password Auth (Hardening)](#8-step-5-disable-password-auth-hardening)
9. [Daily Usage](#9-daily-usage)
10. [iTerm2 Setup](#10-iterm2-setup)
11. [Multi-VM Management](#11-multi-vm-management)
12. [Troubleshooting](#12-troubleshooting)
13. [Security Notes](#13-security-notes)
14. [Quick Reference](#14-quick-reference)

---

## 1. Overview

All VMs sit on internal bridge `vmbr1` (10.10.1.0/24) with no ports exposed to the internet. External access goes through a Cloudflare Tunnel running on CT 101, which has dedicated SSH hostnames for each VM.

**Before this setup:**

```
# Two commands, password every time, one VM at a time
sudo cloudflared access rdp --hostname ssh-git-runner.taphuynh.dev --url ssh://localhost:22
ssh dell@localhost   # prompts for password
```

**After this setup:**

```
# One command, no password, all VMs simultaneously
ssh gitlab-runner
```

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Mac (iTerm2)                                                    │
│                                                                  │
│  ssh gitlab-runner                                               │
│    │                                                             │
│    ├─ ~/.ssh/config resolves alias → ssh-git-runner.taphuynh.dev │
│    ├─ Match *.taphuynh.dev triggers ProxyCommand                 │
│    ├─ cloudflared access ssh --hostname <host> (inline, no sudo) │
│    ├─ ControlMaster reuses connection if already open            │
│    └─ ed25519 key authenticates (no password)                    │
│                                                                  │
└──────────────────────┬───────────────────────────────────────────┘
                       │ Cloudflare Tunnel (outbound TCP)
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  CT 101 — cloudflared (multi-homed)                              │
│  192.168.68.117 (vmbr0) / 10.10.1.2 (vmbr1)                     │
│                                                                  │
│  Routes ssh-git-runner.taphuynh.dev → ssh://10.10.1.111:22       │
└──────────────────────┬───────────────────────────────────────────┘
                       │ L2 on vmbr1
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  VM 411 — gitlab-runner (10.10.1.111)                            │
│  sshd accepts ed25519 key for user 'dell'                        │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Prerequisites

| Requirement | Check |
|-------------|-------|
| macOS with Homebrew | `brew --version` |
| cloudflared installed | `which cloudflared` → `/opt/homebrew/bin/cloudflared` |
| iTerm2 installed | Application exists in /Applications |
| Cloudflare Tunnel running on CT 101 | SSH hostnames resolve (see [CT 101 doc](./deploy-ct101-cloudflare-tunnel.md)) |
| User `dell` exists on all VMs | Created during VM provisioning |
| Password auth currently works | Needed for initial key deployment |

---

## 4. Step 1: Generate SSH Key

Generate an ed25519 key dedicated to the homelab:

```bash
ssh-keygen -t ed25519 -C "taphuynh@homelab" -f ~/.ssh/id_ed25519_homelab
```

- **Type**: ed25519 (current standard — stronger and faster than RSA)
- **Passphrase**: Set one. macOS Keychain caches it so you only enter it once per reboot.
- **Output files**:
  - `~/.ssh/id_ed25519_homelab` (private key — never leaves your Mac)
  - `~/.ssh/id_ed25519_homelab.pub` (public key — deployed to VMs)

Create the multiplexing socket directory:

```bash
mkdir -p ~/.ssh/sockets && chmod 700 ~/.ssh/sockets
```

---

## 5. Step 2: Create SSH Config

Write `~/.ssh/config` (or update the existing one):

```ssh-config
# Added by OrbStack: 'orb' SSH host for Linux machines
# This only works if it's at the top of ssh_config (before any Host blocks).
# This won't be added again if you remove it.
Include ~/.orbstack/ssh/config

Host github.com
  HostName github.com
  User git
  IdentitiesOnly yes
  IdentityFile ~/github

# --- Homelab VM Aliases ---
# Short names so you can type 'ssh gpu' instead of the full hostname.
# Placed BEFORE the Match block so they resolve first.

Host gpu
    HostName server-gpu.taphuynh.dev
Host master
    HostName ssh-master.taphuynh.dev
Host vuvu
    HostName ssh-vuvu.taphuynh.dev
Host minio
    HostName ssh-minio.taphuynh.dev
Host gitlab
    HostName ssh-git.taphuynh.dev
    ForwardAgent yes
Host git-remote
    HostName git-remote.taphuynh.dev
    User git
    Port 2222
Host gitlab-runner
    HostName ssh-git-runner.taphuynh.dev
Host db0
    HostName ssh-db0.taphuynh.dev
Host db1
    HostName ssh-db1.taphuynh.dev
Host db2
    HostName ssh-db2.taphuynh.dev

# --- Cloudflare Tunnel Wildcard ---
# Any host matching *.taphuynh.dev is routed through cloudflared.
# No background tunnel needed — ProxyCommand runs inline.

Match host *.taphuynh.dev
    ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h
    User dell
    IdentityFile ~/.ssh/id_ed25519_homelab
    StrictHostKeyChecking accept-new

# --- Global Defaults ---

Host *
    AddKeysToAgent yes
    UseKeychain yes
    IdentitiesOnly yes
    ControlMaster auto
    ControlPath ~/.ssh/sockets/%r@%h-%p
    ControlPersist 600
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

### Config Explained

| Directive | Purpose |
|-----------|---------|
| `Host gpu` / `HostName ...` | Short alias → full cloudflared hostname |
| `Match host *.taphuynh.dev` | Wildcard catches all homelab hostnames |
| `ProxyCommand cloudflared access ssh --hostname %h` | Runs cloudflared inline as the SSH transport — no separate tunnel process |
| `User dell` | Default user for all VMs |
| `IdentityFile ~/.ssh/id_ed25519_homelab` | Uses the homelab-specific key |
| `StrictHostKeyChecking accept-new` | Trusts on first connect, rejects if key changes (safer than `no`) |
| `ForwardAgent yes` (gitlab only) | Allows git operations on GitLab to use your local SSH keys |
| `git-remote` with `Port 2222` | GitLab's dedicated git-over-SSH service (gitlab-sshd) |
| `ControlMaster auto` | First SSH to a host creates a master socket; subsequent connections reuse it |
| `ControlPath ~/.ssh/sockets/%r@%h-%p` | Where master sockets are stored |
| `ControlPersist 600` | Master stays alive 10 minutes after last session closes |
| `ServerAliveInterval 30` | Sends keepalive every 30s to prevent tunnel timeout |
| `AddKeysToAgent yes` + `UseKeychain yes` | Caches passphrase in macOS Keychain |
| `IdentitiesOnly yes` | Only offers the specified key, not all keys in the agent |

### How Multiplexing Helps

| | First Connection | Subsequent Connections |
|---|---|---|
| **Without ControlMaster** | 2-4s (cloudflared + auth + handshake) | 2-4s (full repeat) |
| **With ControlMaster** | 2-4s (same) | ~0.1s (socket reuse) |

---

## 6. Step 3: Deploy Keys to VMs

### Automated Script

A deployment script is provided at `docs/scripts/deploy-ssh-keys.sh`. It handles key generation, tunneling, and `ssh-copy-id` for each VM.

```bash
# Preview what will happen (no changes)
./scripts/deploy-ssh-keys.sh --dry-run

# Deploy to ALL VMs (you'll enter dell's password once per VM)
./scripts/deploy-ssh-keys.sh

# Deploy to specific VMs only
./scripts/deploy-ssh-keys.sh gitlab-runner db0

# Retry any that failed
./scripts/deploy-ssh-keys.sh gpu minio
```

**What the script does for each VM:**

1. Checks if the key is already deployed (skips if yes)
2. Starts a cloudflared TCP tunnel to a unique local port
3. Waits for the tunnel to be ready
4. Runs `ssh-copy-id` (prompts for `dell`'s password)
5. Kills the tunnel and moves to the next VM

### Manual Deployment (Single VM)

If you prefer to do it manually or the script fails for a specific VM:

```bash
# Terminal 1: start tunnel (pick any unused local port)
cloudflared access tcp --hostname ssh-git-runner.taphuynh.dev --url localhost:2201

# Terminal 2: deploy the key
ssh-copy-id -i ~/.ssh/id_ed25519_homelab.pub -p 2201 dell@localhost

# Terminal 1: Ctrl+C to stop the tunnel
```

---

## 7. Step 4: Verify Access

After deploying keys, test each VM:

```bash
ssh gpu              # should connect without password
ssh master
ssh vuvu
ssh minio
ssh gitlab
ssh gitlab-runner
ssh db0
ssh db1
ssh db2
```

Verify key-based auth is working (no password prompt). If a VM still asks for a password, re-run the script for that VM:

```bash
./scripts/deploy-ssh-keys.sh <alias>
```

Test multiplexing — open a second connection to the same VM:

```bash
# Terminal 1
ssh gpu

# Terminal 2 (should connect in ~0.1s, no cloudflared overhead)
ssh gpu
```

---

## 8. Step 5: Disable Password Auth (Hardening)

Once key-based access is confirmed on all VMs, disable password authentication. This is optional but strongly recommended.

**On each VM** (or use Ansible to do all at once — see [Multi-VM Management](#11-multi-vm-management)):

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart sshd
```

Or create `/etc/ssh/sshd_config.d/hardening.conf` (cleaner, doesn't modify the main config):

```
PasswordAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
MaxAuthTries 3
X11Forwarding no
AllowUsers dell
```

Then restart: `sudo systemctl restart sshd`

> **Warning**: Make sure key-based access works BEFORE disabling passwords. Test from a separate terminal while still logged in. If you lock yourself out, you'll need Proxmox console access to fix it.

---

## 9. Daily Usage

### Connect to a VM

```bash
ssh gpu                    # short alias
ssh server-gpu.taphuynh.dev  # full hostname (also works)
```

### Run a command without interactive session

```bash
ssh db0 "systemctl status patroni"
ssh gpu "nvidia-smi"
ssh gitlab "docker ps"
```

### Copy files

```bash
# Local → VM
scp ./backup.sql db0:/tmp/

# VM → Local
scp gpu:/var/log/syslog ./gpu-syslog.log

# rsync (better for large/repeated transfers)
rsync -avz ./deploy/ gitlab:/opt/deploy/
```

### Persistent sessions with tmux

Mosh does not work through Cloudflare Tunnels (requires UDP). Use tmux instead:

```bash
# Start or attach to a persistent session
ssh gpu -t "tmux new-session -A -s main"

# With iTerm2 native integration (each tmux window = native tab)
ssh gpu -t "tmux -CC new-session -A -s main"
```

If the SSH connection drops, the tmux session survives. Reconnect and reattach:

```bash
ssh gpu -t "tmux attach -t main"
```

### Git operations via GitLab

```bash
# Clone (uses git-remote alias → port 2222 via cloudflared)
git clone git-remote:your-group/your-repo.git

# Or with full URL
git clone ssh://git@git-remote.taphuynh.dev:2222/your-group/your-repo.git
```

### Clean stale multiplexing sockets

If a connection hangs or you get "mux_client" errors:

```bash
# Kill a specific master connection
ssh -O exit gpu

# Nuclear option: remove all sockets
rm -f ~/.ssh/sockets/*
```

---

## 10. iTerm2 Setup

### Dynamic Profiles

Place a JSON file at `~/Library/Application Support/iTerm2/DynamicProfiles/homelab.json` to get one-click access to all VMs from the iTerm2 Toolbelt sidebar.

```json
{
  "Profiles": [
    {
      "Guid": "homelab-gpu",
      "Name": "VM 200 — GPU",
      "Tags": ["homelab", "compute"],
      "Badge Text": "GPU | 10.10.1.10",
      "Custom Command": "Yes",
      "Command": "ssh gpu -t 'tmux -CC new-session -A -s main'",
      "Tab Color": {"Red Component": 0.8, "Green Component": 0.2, "Blue Component": 0.2},
      "Use Tab Color": true,
      "Dynamic Profile Parent Name": "Default"
    },
    {
      "Guid": "homelab-master",
      "Name": "VM 400 — Master",
      "Tags": ["homelab", "infra"],
      "Badge Text": "MASTER | 10.10.1.100",
      "Custom Command": "Yes",
      "Command": "ssh master -t 'tmux -CC new-session -A -s main'",
      "Tab Color": {"Red Component": 0.2, "Green Component": 0.6, "Blue Component": 0.8},
      "Use Tab Color": true,
      "Dynamic Profile Parent Name": "Default"
    },
    {
      "Guid": "homelab-minio",
      "Name": "VM 402 — MinIO",
      "Tags": ["homelab", "storage"],
      "Badge Text": "MINIO | 10.10.1.102",
      "Custom Command": "Yes",
      "Command": "ssh minio -t 'tmux -CC new-session -A -s main'",
      "Tab Color": {"Red Component": 0.2, "Green Component": 0.7, "Blue Component": 0.3},
      "Use Tab Color": true,
      "Dynamic Profile Parent Name": "Default"
    },
    {
      "Guid": "homelab-gitlab",
      "Name": "VM 410 — GitLab",
      "Tags": ["homelab", "infra"],
      "Badge Text": "GITLAB | 10.10.1.110",
      "Custom Command": "Yes",
      "Command": "ssh gitlab -t 'tmux -CC new-session -A -s main'",
      "Tab Color": {"Red Component": 0.2, "Green Component": 0.6, "Blue Component": 0.8},
      "Use Tab Color": true,
      "Dynamic Profile Parent Name": "Default"
    },
    {
      "Guid": "homelab-gitlab-runner",
      "Name": "VM 411 — GitLab Runner",
      "Tags": ["homelab", "infra"],
      "Badge Text": "RUNNER | 10.10.1.111",
      "Custom Command": "Yes",
      "Command": "ssh gitlab-runner -t 'tmux -CC new-session -A -s main'",
      "Tab Color": {"Red Component": 0.2, "Green Component": 0.6, "Blue Component": 0.8},
      "Use Tab Color": true,
      "Dynamic Profile Parent Name": "Default"
    },
    {
      "Guid": "homelab-db0",
      "Name": "VM 500 — DB Primary",
      "Tags": ["homelab", "database"],
      "Badge Text": "DB-00 | 10.10.1.200",
      "Custom Command": "Yes",
      "Command": "ssh db0 -t 'tmux -CC new-session -A -s main'",
      "Tab Color": {"Red Component": 0.9, "Green Component": 0.6, "Blue Component": 0.1},
      "Use Tab Color": true,
      "Dynamic Profile Parent Name": "Default"
    },
    {
      "Guid": "homelab-db1",
      "Name": "VM 501 — DB Replica 1",
      "Tags": ["homelab", "database"],
      "Badge Text": "DB-01 | 10.10.1.201",
      "Custom Command": "Yes",
      "Command": "ssh db1 -t 'tmux -CC new-session -A -s main'",
      "Tab Color": {"Red Component": 0.9, "Green Component": 0.6, "Blue Component": 0.1},
      "Use Tab Color": true,
      "Dynamic Profile Parent Name": "Default"
    },
    {
      "Guid": "homelab-db2",
      "Name": "VM 502 — DB Replica 2",
      "Tags": ["homelab", "database"],
      "Badge Text": "DB-02 | 10.10.1.202",
      "Custom Command": "Yes",
      "Command": "ssh db2 -t 'tmux -CC new-session -A -s main'",
      "Tab Color": {"Red Component": 0.9, "Green Component": 0.6, "Blue Component": 0.1},
      "Use Tab Color": true,
      "Dynamic Profile Parent Name": "Default"
    },
    {
      "Guid": "homelab-vuvu",
      "Name": "VM 401 — Vuvu (AI no GPU)",
      "Tags": ["homelab", "compute"],
      "Badge Text": "VUVU | 10.10.1.101",
      "Custom Command": "Yes",
      "Command": "ssh vuvu -t 'tmux -CC new-session -A -s main'",
      "Tab Color": {"Red Component": 0.8, "Green Component": 0.2, "Blue Component": 0.2},
      "Use Tab Color": true,
      "Dynamic Profile Parent Name": "Default"
    }
  ]
}
```

### Color Scheme by Role

| Role | Color | VMs |
|------|-------|-----|
| Compute | Red | gpu, vuvu |
| Infrastructure | Blue | master, gitlab, gitlab-runner |
| Storage | Green | minio |
| Database | Orange | db0, db1, db2 |

### Using the Toolbelt

1. iTerm2 → View → Toolbelt → Profiles
2. A sidebar appears with all profiles, filterable by tags
3. Click any profile to open a new tab with the SSH + tmux connection

---

## 11. Multi-VM Management

### Synchronized Panes (Ad-Hoc Commands)

Open tmux with synchronized panes to all VMs — type once, executes everywhere:

```bash
#!/bin/zsh
# homelab-all.sh
SERVERS="gpu master vuvu minio gitlab gitlab-runner db0 db1 db2"

tmux new-session -d -s homelab "ssh $(echo $SERVERS | awk '{print $1}')"
for server in $(echo $SERVERS | cut -d' ' -f2-); do
    tmux split-window -t homelab "ssh $server"
    tmux select-layout -t homelab tiled
done
tmux set-option -t homelab synchronize-panes on
tmux attach -t homelab
```

Toggle sync on/off: `Ctrl-b` then `:set synchronize-panes off`

### Ansible (Repeatable Operations)

For configuration management, updates, and repeatable tasks:

```ini
# ~/ansible/inventory/homelab.ini

[compute]
gpu   ansible_host=server-gpu.taphuynh.dev
vuvu  ansible_host=ssh-vuvu.taphuynh.dev

[infra]
master         ansible_host=ssh-master.taphuynh.dev
gitlab         ansible_host=ssh-git.taphuynh.dev
gitlab-runner  ansible_host=ssh-git-runner.taphuynh.dev

[storage]
minio  ansible_host=ssh-minio.taphuynh.dev

[database]
db0  ansible_host=ssh-db0.taphuynh.dev
db1  ansible_host=ssh-db1.taphuynh.dev
db2  ansible_host=ssh-db2.taphuynh.dev

[all:vars]
ansible_user=dell
ansible_ssh_common_args=-o ProxyCommand="cloudflared access ssh --hostname %h"
```

```bash
# Check uptime on all VMs
ansible all -i ~/ansible/inventory/homelab.ini -m shell -a "uptime"

# Update packages on database nodes only
ansible database -i ~/ansible/inventory/homelab.ini -m apt -a "upgrade=yes" --become

# Run a playbook
ansible-playbook -i ~/ansible/inventory/homelab.ini playbooks/harden-sshd.yml
```

---

## 12. Troubleshooting

### "Permission denied (publickey)"

The key wasn't deployed to that VM. Re-run:

```bash
./scripts/deploy-ssh-keys.sh <alias>
```

Or deploy manually (see [Step 3](#6-step-3-deploy-keys-to-vms)).

### "mux_client: master did not respond" or connection hangs

Stale multiplexing socket. Clean it:

```bash
ssh -O exit <alias> 2>/dev/null
# or
rm -f ~/.ssh/sockets/*
```

### "cloudflared: command not found" in SSH

The `ProxyCommand` uses the full path `/opt/homebrew/bin/cloudflared`. Verify:

```bash
ls -la /opt/homebrew/bin/cloudflared
```

If cloudflared is elsewhere, update the `ProxyCommand` path in `~/.ssh/config`.

### Connection times out

1. Check that CT 101 is running: access Proxmox web UI → CT 101 → Status
2. Check that the cloudflared service is running on CT 101:
   ```bash
   # From Proxmox console
   pct exec 101 -- systemctl status cloudflared
   ```
3. Check that the target VM is running and sshd is active:
   ```bash
   # From Proxmox console
   qm status <VMID>
   ```

### "Host key verification failed"

The host key changed (VM was rebuilt). Remove the old key:

```bash
ssh-keygen -R <hostname>
# e.g.
ssh-keygen -R ssh-git-runner.taphuynh.dev
```

### Password still prompted after key deployment

Check that the key is in the VM's authorized_keys:

```bash
# Connect with password (old method) and verify
cloudflared access tcp --hostname ssh-git-runner.taphuynh.dev --url localhost:2201
ssh -p 2201 dell@localhost "cat ~/.ssh/authorized_keys"
```

Check permissions on the VM (SSH is strict about this):

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

---

## 13. Security Notes

### Layered Security Model

```
Layer 1: Cloudflare Access (identity verification, optional MFA)
  └─ Layer 2: Cloudflare Tunnel (no exposed ports on WAN)
      └─ Layer 3: SSH key authentication (ed25519)
          └─ Layer 4: OS-level (PermitRootLogin no, AllowUsers dell)
```

### Key Points

- **No ports are exposed** on the WAN. All SSH traffic flows outbound through the Cloudflare Tunnel.
- **ed25519 keys** are the current standard (2025-2026). A 256-bit ed25519 key provides equivalent security to 4096-bit RSA.
- **`StrictHostKeyChecking accept-new`** trusts a host on first connect but rejects if the key changes (MITM protection). Safer than `no`.
- **`ForwardAgent yes`** is only enabled for `gitlab` (needed for git operations). Never enable it globally — a compromised host with agent forwarding can use your keys to access other servers.
- **`IdentitiesOnly yes`** prevents SSH from trying every key in the agent, which avoids auth failures from too many attempts.

### Future Improvements

| Improvement | Benefit |
|-------------|---------|
| Cloudflare Access policies on `ssh-*.taphuynh.dev` | Require identity verification before tunnel access |
| Cloudflare short-lived SSH certificates | Eliminate long-lived keys entirely |
| Per-role SSH keys (infra/data/compute) | Limit blast radius if one key is compromised |
| fail2ban on VMs | Rate-limit auth attempts (defense in depth) |

---

## 14. Quick Reference

### VM Connection Map

| Alias | Hostname | Internal IP | VM ID | Role |
|-------|----------|-------------|-------|------|
| `gpu` | server-gpu.taphuynh.dev | 10.10.1.10 | VM 200 | K3s + GPU (AI services) |
| `master` | ssh-master.taphuynh.dev | 10.10.1.100 | VM 400 | Rancher + Argo CD |
| `vuvu` | ssh-vuvu.taphuynh.dev | 10.10.1.101 | VM 401 | AI without GPU |
| `minio` | ssh-minio.taphuynh.dev | 10.10.1.102 | VM 402 | MinIO S3 storage |
| `gitlab` | ssh-git.taphuynh.dev | 10.10.1.110 | VM 410 | GitLab CE |
| `git-remote` | git-remote.taphuynh.dev:2222 | 10.10.1.110 | VM 410 | GitLab SSH (git operations) |
| `gitlab-runner` | ssh-git-runner.taphuynh.dev | 10.10.1.111 | VM 411 | GitLab CI/CD Runners |
| `db0` | ssh-db0.taphuynh.dev | 10.10.1.200 | VM 500 | TimescaleDB Primary |
| `db1` | ssh-db1.taphuynh.dev | 10.10.1.201 | VM 501 | TimescaleDB Replica |
| `db2` | ssh-db2.taphuynh.dev | 10.10.1.202 | VM 502 | TimescaleDB Replica |

### Common Commands

```bash
ssh gpu                          # Connect to GPU VM
ssh db0 "systemctl status patroni"  # Run command remotely
scp ./file.txt gitlab:/tmp/      # Copy file to VM
ssh gpu -t "tmux -CC new-session -A -s main"  # Persistent session
ssh -O exit gpu                  # Kill stale multiplexing socket
./scripts/deploy-ssh-keys.sh     # Deploy keys to all VMs
./scripts/deploy-ssh-keys.sh db0 # Deploy key to specific VM
```

### Files on Mac

| File | Purpose |
|------|---------|
| `~/.ssh/config` | SSH aliases, cloudflared ProxyCommand, multiplexing |
| `~/.ssh/id_ed25519_homelab` | Private key (never share) |
| `~/.ssh/id_ed25519_homelab.pub` | Public key (deployed to VMs) |
| `~/.ssh/sockets/` | Multiplexing master sockets |
| `~/Library/Application Support/iTerm2/DynamicProfiles/homelab.json` | iTerm2 profiles |
| `docs/scripts/deploy-ssh-keys.sh` | Automated key deployment script |
