# Deploy Cloudflare Tunnel — CT 101 (Multi-Homed)

**Date**: 2026-03-18
**Container**: CT 101 (LXC) | **Bridges**: vmbr0, vmbr1, vmbr2, vmbr3, vmbr4 | **Multi-homed**
**Related**: [Infrastructure Overview](./proxmox-infrastructure-gitlab-rancher-plan.md) | [Network Topology](./proxmox-network-topology-design.md) | [GitLab (VM 410)](./deploy-vm410-gitlab.md) | [MinIO (VM 402)](./deploy-vm402-minio.md) | [Rancher (VM 400)](./deploy-vm400-master.md)

---

## Overview

CT 101 runs `cloudflared` as a systemd service inside an LXC container on the Proxmox host. It is multi-homed across all virtual bridges, giving it direct L2 access to every VM/LXC on the host. This makes it the single ingress point for all external traffic.

All external access to the homelab flows through this tunnel. Internal VM-to-VM traffic stays on `10.10.1.x` and never touches Cloudflare.

---

## Ingress Rules

Edit `/etc/cloudflared/config.yml` on CT 101. All rules go **before** the catch-all `- service: http_status:404` at the bottom.

### VM 200 — ubuntu-live-gpu (AI + GPU)

```yaml
  - hostname: server-gpu.taphuynh.dev
    service: ssh://10.10.1.10:22

  - hostname: api-staging.taphuynh.dev
    service: http://10.10.1.10:30080
    originRequest:
      disableChunkedEncoding: true
```

### VM 400 — master (Rancher + Argo)

```yaml
  - hostname: rancher.taphuynh.dev
    service: http://10.10.1.100:80
    originRequest:
      disableChunkedEncoding: true

  - hostname: ssh-master.taphuynh.dev
    service: ssh://10.10.1.100:22
```

### VM 401 — vuvu (AI, no GPU)

```yaml
  - hostname: ssh-vuvu.taphuynh.dev
    service: ssh://10.10.1.101:22
```

### VM 402 — minio

```yaml
  - hostname: s3.taphuynh.dev
    service: http://10.10.1.102:9000
    originRequest:
      disableChunkedEncoding: true

  - hostname: s3-console.taphuynh.dev
    service: http://10.10.1.102:9001

  - hostname: ssh-minio.taphuynh.dev
    service: ssh://10.10.1.102:22
```

### VM 410 — gitlab

```yaml
  - hostname: git.taphuynh.dev
    service: http://10.10.1.110:80
    originRequest:
      disableChunkedEncoding: true
      noHappyEyeballs: true

  - hostname: registry.taphuynh.dev
    service: http://10.10.1.110:5050
    originRequest:
      disableChunkedEncoding: true

  - hostname: pages.taphuynh.dev
    service: http://10.10.1.110:8090

  - hostname: ssh-git.taphuynh.dev
    service: ssh://10.10.1.110:22

  - hostname: git-remote.taphuynh.dev
    service: ssh://10.10.1.110:2222
```

### VM 411 — gitlab-runner

```yaml
  - hostname: ssh-git-runner.taphuynh.dev
    service: ssh://10.10.1.111:22
```

### VMs 500–502 — database cluster

```yaml
  - hostname: ssh-db0.taphuynh.dev
    service: ssh://10.10.1.200:22

  - hostname: ssh-db1.taphuynh.dev
    service: ssh://10.10.1.201:22

  - hostname: ssh-db2.taphuynh.dev
    service: ssh://10.10.1.202:22
```

### Catch-All (Must Be Last)

```yaml
  - service: http_status:404
```

---

## Route Summary

| Hostname | Service Target | VM |
|----------|---------------|----|
| `server-gpu.taphuynh.dev` | `ssh://10.10.1.10:22` | VM 200 |
| `api-staging.taphuynh.dev` | `http://10.10.1.10:30080` | VM 200 |
| `ssh-master.taphuynh.dev` | `ssh://10.10.1.100:22` | VM 400 |
| `rancher.taphuynh.dev` | `http://10.10.1.100:80` | VM 400 |
| `ssh-vuvu.taphuynh.dev` | `ssh://10.10.1.101:22` | VM 401 |
| `ssh-minio.taphuynh.dev` | `ssh://10.10.1.102:22` | VM 402 |
| `s3.taphuynh.dev` | `http://10.10.1.102:9000` | VM 402 |
| `s3-console.taphuynh.dev` | `http://10.10.1.102:9001` | VM 402 |
| `ssh-git.taphuynh.dev` | `ssh://10.10.1.110:22` | VM 410 |
| `git-remote.taphuynh.dev` | `ssh://10.10.1.110:2222` | VM 410 |
| `git.taphuynh.dev` | `http://10.10.1.110:80` | VM 410 |
| `registry.taphuynh.dev` | `http://10.10.1.110:5050` | VM 410 |
| `pages.taphuynh.dev` | `http://10.10.1.110:8090` | VM 410 |
| `ssh-git-runner.taphuynh.dev` | `ssh://10.10.1.111:22` | VM 411 |
| `ssh-db0.taphuynh.dev` | `ssh://10.10.1.200:22` | VM 500 |
| `ssh-db1.taphuynh.dev` | `ssh://10.10.1.201:22` | VM 501 |
| `ssh-db2.taphuynh.dev` | `ssh://10.10.1.202:22` | VM 502 |

---

## Create DNS Records

Only create CNAME records for hostnames that don't already exist. Run from inside CT 101:

```bash
cloudflared tunnel route dns hope-homelab server-gpu.taphuynh.dev
cloudflared tunnel route dns hope-homelab api-staging.taphuynh.dev
cloudflared tunnel route dns hope-homelab ssh-master.taphuynh.dev
cloudflared tunnel route dns hope-homelab rancher.taphuynh.dev
cloudflared tunnel route dns hope-homelab ssh-vuvu.taphuynh.dev
cloudflared tunnel route dns hope-homelab ssh-minio.taphuynh.dev
cloudflared tunnel route dns hope-homelab s3.taphuynh.dev
cloudflared tunnel route dns hope-homelab s3-console.taphuynh.dev
cloudflared tunnel route dns hope-homelab ssh-git.taphuynh.dev
cloudflared tunnel route dns hope-homelab git-remote.taphuynh.dev
cloudflared tunnel route dns hope-homelab git.taphuynh.dev
cloudflared tunnel route dns hope-homelab registry.taphuynh.dev
cloudflared tunnel route dns hope-homelab pages.taphuynh.dev
cloudflared tunnel route dns hope-homelab ssh-git-runner.taphuynh.dev
cloudflared tunnel route dns hope-homelab ssh-db0.taphuynh.dev
cloudflared tunnel route dns hope-homelab ssh-db1.taphuynh.dev
cloudflared tunnel route dns hope-homelab ssh-db2.taphuynh.dev
```

---

## Restart Tunnel

After any config change:

```bash
systemctl restart cloudflared
systemctl status cloudflared
journalctl -u cloudflared --no-pager -n 30
```

---

## Cloudflare Free Tier — 100 MB Upload Limit

Cloudflare Free plan rejects any HTTP request body larger than **100 MB**. This affects all traffic routed through the tunnel. The analysis below maps every data flow and its Cloudflare exposure.

### Communication Matrix

| # | From | To | Path | Via CF? | Large payload? | Risk |
|---|------|-----|------|---------|----------------|------|
| 1 | Dev Mac | GitLab web UI | `git.taphuynh.dev` | **Yes** | Rarely (file uploads) | Low |
| 2 | Dev Mac | Git push (HTTPS) | `git.taphuynh.dev:443` | **Yes** | Packfile can exceed 100 MB | **HIGH** |
| 3 | Dev Mac | Git push (SSH) | `git-remote.taphuynh.dev` → TCP tunnel | Yes (TCP stream) | Same data, but TCP stream | **Low** — not subject to HTTP body limit |
| 4 | Dev Mac | Git LFS push (HTTPS) | `git.taphuynh.dev:443` | **Yes** | LFS objects often > 100 MB | **HIGH** |
| 5 | Dev Mac | Git LFS push (SSH) | SSH transport via tunnel | Yes (TCP stream) | Same data, TCP stream | **Low** |
| 6 | Dev Mac | Docker push to registry | `registry.taphuynh.dev:443` | **Yes** | Individual layers can exceed 100 MB | **HIGH** |
| 7 | Dev Mac | MinIO upload | `s3.taphuynh.dev:443` | **Yes** | Possible | Medium |
| 8 | Runner (411) | GitLab API | `http://10.10.1.110` (internal) | **No** | — | None |
| 9 | Runner CI jobs | Git clone/fetch | Depends on DNS resolution | **Maybe** | Packfile | **Mitigated below** |
| 10 | Runner CI jobs | Docker push to registry | Depends on DNS resolution | **Maybe** | Image layers | **Mitigated below** |
| 11 | GitLab (410) | MinIO (402) | `http://10.10.1.102:9000` (internal) | **No** | — | None |
| 12 | Master (400) | GitLab registry | Depends on DNS resolution | **Maybe** | Image pulls | **Mitigated below** |

### Workaround Strategy

**Principle**: All VM-to-VM traffic MUST stay on the internal `10.10.1.x` network. Only human-initiated access from outside (Dev Mac) uses Cloudflare.

| Flow | Workaround |
|------|------------|
| **#2 Dev Git push (HTTPS)** | **Always use SSH** for git remotes: `ssh://git@git.taphuynh.dev/...`. SSH over `cloudflared access ssh` uses a TCP stream, not HTTP POST, so the 100 MB limit does not apply. |
| **#4 Dev LFS push** | Configure Git LFS to use SSH transport: `git config lfs.url ssh://git@git.taphuynh.dev`. Or use `GIT_LFS_SKIP_SMUDGE=1` and sync LFS separately on the internal network. |
| **#6 Dev Docker push** | For images > 100 MB: push from a machine on the internal network (VM 411 or SSH into any VM), or build on the runner via CI pipeline. |
| **#9–10 Runner CI** | Add `/etc/hosts` on VM 411 + `extra_hosts` in runner `config.toml` to resolve `git.taphuynh.dev` and `registry.taphuynh.dev` to internal IPs. See [Runner deployment guide](./deploy-vm411-gitlab-runner.md#31--dns-override-bypass-cloudflare-for-internal-traffic). |
| **#12 Rancher pulls** | Configure Rancher cluster to use `10.10.1.110:5050` as the registry endpoint, or add `/etc/hosts` on VM 400. See [Master deployment guide](./deploy-vm400-master.md#8-container-registry-access). |

> **Key insight**: The Cloudflare limit only applies to HTTP request bodies. SSH tunneled via `cloudflared access ssh` uses a WebSocket/TCP stream where Git data flows as a continuous stream, not discrete HTTP requests. This makes SSH the safe default for all Git operations from external machines.

---

## Verify

```bash
# From your Mac — test each route:

# GitLab
curl -sSI https://git.taphuynh.dev | head -5
# → HTTP/2 200 or 302

# Rancher
curl -sSI https://rancher.taphuynh.dev | head -5
# → HTTP/2 200 or 302

# MinIO Console
curl -sSI https://s3-console.taphuynh.dev | head -5

# API Staging
curl -sSI https://api-staging.taphuynh.dev | head -5

# SSH access (requires cloudflared on your Mac)
ssh -T git@git.taphuynh.dev
# → "Welcome to GitLab, @yourusername!"
```

---

## Operational Notes

### Adding a New Service

1. Add an ingress rule to `/etc/cloudflared/config.yml` (before the catch-all)
2. Create the DNS CNAME: `cloudflared tunnel route dns hope-homelab <hostname>`
3. Restart: `systemctl restart cloudflared`

### Logs

```bash
journalctl -u cloudflared -f --no-pager
```

### Tunnel Status

Check tunnel health in the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/) → Networks → Tunnels.
