# Proxmox MCP — Local Operator Setup

> **Not part of HOPE's product infrastructure.** This documents a personal Claude Code
> tool the maintainer runs locally to operate their own Proxmox homelab
> (`server.taphuynh.dev`) through natural-language MCP calls. Nothing here is
> deployed, built, or shipped as part of the HOPE platform — it lives entirely
> outside this repo, on the operator's machine. It's recorded here per
> [`01-development-workflow.md`](../../../.claude/rules/01-development-workflow.md)'s
> documentation convention, purely so the setup is reproducible and the gotchas aren't
> re-discovered from scratch next time.

Project: [RekklesNA/ProxmoxMCP-Plus](https://github.com/RekklesNA/ProxmoxMCP-Plus) —
exposes Proxmox VE (VM/LXC lifecycle, snapshots, backups, cluster status, ...) as MCP
tools. Runtime path chosen: **Docker, native MCP Streamable HTTP** (`mcp-http` mode),
registered with Claude Code at **user scope** (available in every project, not just
`hope-v2`).

## Why this was harder than the README suggests

The README's Docker quick-start assumes the client can reach the Proxmox API directly.
Here it can't, for two independent reasons:

1. **Proxmox is only reachable through a Cloudflare Tunnel**, and the public hostname
   (`server.taphuynh.dev`) sits behind **Cloudflare Access** (Zero Trust). Every HTTP
   request — including one carrying a valid Proxmox API token — gets 302-redirected to
   a Cloudflare Access login page before it ever reaches `pveproxy`. Confirmed by
   curling the API directly with the token and observing the redirect to
   `<team>.cloudflareaccess.com/cdn-cgi/access/login/...`.
2. **The operator cannot edit the Cloudflare Access policy** (no dashboard permission),
   so the obvious fix — a `Bypass` policy scoped to the container's egress IP, or a
   Service Token the container could send as a header — was not available. It's also
   moot: ProxmoxMCP-Plus's `ProxmoxConfig` model has no field for extra HTTP headers,
   so it couldn't send a CF Access Service Token even if one existed.

The tool does ship a purpose-built escape hatch for exactly this shape of problem:
`api_tunnel`, a local SSH port-forward the server establishes on startup before talking
to the Proxmox API. That's what's wired up below — but it comes with its own trap
(see "Two-hop tunnel" below), because the *only* thing the operator could already reach
was an SSH shell via `cloudflared access rdp`, not a plain SSH port.

## Architecture

```
Claude Code (any project, user-scope MCP)
  │  Streamable HTTP, http://localhost:8000/mcp
  ▼
Docker container "proxmox-mcp-plus" (ghcr.io/rekklesna/proxmoxmcp-plus:latest)
  │  on startup: SSHTunnelManager runs `ssh -N -L 127.0.0.1:8006:127.0.0.1:8006`
  │  using a dedicated ed25519 key, target = host.docker.internal:22
  ▼
host.docker.internal  (Docker Desktop's DNS name for the Mac itself)
  │  port 22 is NOT this Mac's sshd — it's a local listener opened by:
  │  `sudo cloudflared access rdp --hostname remote.taphuynh.dev --url ssh://localhost:22`
  │  (must be kept running manually — see "Operational gotchas")
  ▼
Cloudflare Access (operator's cached browser/CLI login) → Cloudflare Tunnel
  ▼
Proxmox node's real sshd (port 22) — the SSH protocol terminates HERE, not at
  cloudflared, which is just relaying raw TCP bytes through the tunnel
  ▼
`-L` forward resolved locally on the Proxmox node → 127.0.0.1:8006 (pveproxy)
```

Two independent auth layers stack here: Cloudflare Access authenticates the *raw TCP
hop into the network* (via the operator's cached identity — no policy change needed
for this path, unlike the direct-HTTPS attempt), and SSH key auth authenticates the
*container* once traffic reaches the real sshd. Neither layer knows about the other.

### Why not just fix the Cloudflare policy?

That's the "right" fix and should replace this setup if dashboard access is ever
granted: a `Bypass` policy scoped to `server.taphuynh.dev/api2/*` (by egress IP) would
let the container hit the Proxmox API directly over HTTPS, with no SSH hop, no
`dev_mode`/`verify_ssl` compromise, and no dependency on a manually-kept-alive
`cloudflared` process. Revisit if that becomes available.

## Files (all outside this repo, on the operator's machine)

| Path | Contents |
|---|---|
| `~/.proxmox-mcp/config.json` | Full ProxmoxMCP-Plus config (Proxmox host/port, auth token, SSH tunnel, MCP transport, command policy) |
| `~/.proxmox-mcp/ssh/proxmox_mcp_tunnel` (+ `.pub`) | Dedicated ed25519 keypair, no passphrase, single-purpose (this tunnel only) |
| `~/.proxmox-mcp/ssh/known_hosts` | Pinned host keys for `host.docker.internal:22`, captured via `ssh-keyscan` through the live chain so it matches exactly what the container will see |

None of this is committed anywhere. The API token and SSH private key exist only in
`~/.proxmox-mcp/` and inside the running container (mounted read-only).

## `config.json` — the parts that aren't in the upstream example

```json
{
  "proxmox": {
    "host": "127.0.0.1",
    "port": 8006,
    "verify_ssl": false,
    "service": "PVE"
  },
  "api_tunnel": {
    "enabled": true,
    "ssh_host": "host.docker.internal",
    "local_host": "127.0.0.1",
    "local_port": 8006,
    "remote_host": "127.0.0.1",
    "remote_port": 8006,
    "connect_timeout": 15
  },
  "auth": {
    "user": "root@pam",
    "token_name": "memac",
    "token_value": "<redacted>"
  },
  "ssh": {
    "user": "root",
    "port": 22,
    "key_file": "/run/secrets/proxmox_mcp_tunnel",
    "known_hosts_file": "/run/secrets/known_hosts",
    "strict_host_key_checking": true
  },
  "security": { "dev_mode": true },
  "command_policy": { "mode": "audit_only", "...": "see gotcha below" }
}
```

- `proxmox.host`/`port` point at the **local end of the SSH tunnel**, not the public
  hostname — once `api_tunnel` establishes the forward, `127.0.0.1:8006` inside the
  container *is* Proxmox's `pveproxy`.
- `api_tunnel.remote_host`/`remote_port` are resolved by the **Proxmox node itself**
  once SSH lands there (`127.0.0.1:8006` = pveproxy's own loopback listener), not by
  anything in between.
- `ssh.key_file`/`known_hosts_file` are container-internal paths — mounted in from the
  host at container-run time (see below), not baked into the image.

## Docker run command

```bash
docker run -d --name proxmox-mcp-plus --restart unless-stopped -p 8000:8000 \
  -e PROXMOX_MCP_MODE=mcp-http \
  -e MCP_HOST=0.0.0.0 \
  -e MCP_PORT=8000 \
  -e MCP_TRANSPORT=STREAMABLE_HTTP \
  -v "$HOME/.proxmox-mcp/config.json:/app/proxmox-config/config.json:ro" \
  -v "$HOME/.proxmox-mcp/ssh/proxmox_mcp_tunnel:/run/secrets/proxmox_mcp_tunnel:ro" \
  -v "$HOME/.proxmox-mcp/ssh/known_hosts:/run/secrets/known_hosts:ro" \
  ghcr.io/rekklesna/proxmoxmcp-plus:latest
```

`--restart unless-stopped` keeps it surviving Docker Desktop / machine restarts.

## Claude Code registration

```bash
claude mcp add --transport http proxmox-mcp-plus http://localhost:8000/mcp -s user
```

`-s user` scope makes it available in every project's Claude Code session, not just
`hope-v2` — deliberate, since this has nothing to do with HOPE. `claude mcp list`
should show `proxmox-mcp-plus: ... - ✔ Connected`.

## SSH key provisioning (one-time, manual)

The container's `ssh` subprocess has no TTY, so it can only authenticate with a key —
password auth (even though `SSHConfig` has a `password` field for a *different* code
path) isn't wired into `SSHTunnelManager._start_process`; it doesn't pass `sshpass` or
any password to the `ssh` invocation, so a password-only account would just hang/fail.

1. Generate a dedicated key (never reused elsewhere):
   ```bash
   ssh-keygen -t ed25519 -f ~/.proxmox-mcp/ssh/proxmox_mcp_tunnel -N "" -C "proxmox-mcp-plus-tunnel"
   ```
2. Get an interactive root shell the way the operator normally does (via the existing
   Cloudflare Access identity — password auth, not reused by anything below):
   ```bash
   sudo cloudflared access rdp --hostname remote.taphuynh.dev --url ssh://localhost:22
   ssh root@localhost
   ```
3. Append the **public** key to `/root/.ssh/authorized_keys` on the Proxmox node.
4. Capture the real host key as the container will see it (must be done through the
   same `host.docker.internal:22` path, not scanned directly against the Proxmox node,
   or the known_hosts entry's hostname field won't match):
   ```bash
   docker run --rm ghcr.io/rekklesna/proxmoxmcp-plus:latest \
     ssh-keyscan -p 22 -T 10 host.docker.internal > ~/.proxmox-mcp/ssh/known_hosts
   ```

## Operational gotchas

| Gotcha | Detail |
|---|---|
| **`cloudflared access rdp` must stay running** | It's a manually-started, `sudo`-bound (port 22) foreground process on the Mac. If it dies (reboot, closed terminal, sleep), the SSH tunnel — and therefore every Proxmox MCP call — fails until it's restarted. Not currently a LaunchAgent; worth making one if this needs to survive reboots unattended. |
| **`security.dev_mode: true` + `proxmox.verify_ssl: false`** | Required because `pveproxy` presents a self-signed cert and `ProxmoxConfig` has no CA-pinning field — the loader hard-blocks `verify_ssl: false` unless `dev_mode` is set (`"Insecure TLS configuration blocked"`). Accepted here because the real transport security is the SSH tunnel, not this TLS hop (loopback-only, post-tunnel). |
| **`api_tunnel` needs the *full* schema even when unused fields look optional** | Pydantic validation failed with `api_tunnel.ssh_host: Field required` when the section only had `{"enabled": false}` — every field in `APITunnelConfig` is required regardless of `enabled`. |
| **`command_policy.mode: "audit_only"`** | Changed from the default-safe `deny_all`. Per upstream's `CommandPolicyGate.evaluate`: `deny_patterns` (the `rm -rf` / fork-bomb guards) still hard-block regardless of mode, but `allow_patterns` stop being enforced — `audit_only` only skips the allowlist check, it doesn't add a new gate. Net effect: `execute_vm_command`/`execute_container_command` now run **any** command that doesn't match a deny pattern; decisions are still logged with distinct codes (`CMD_POLICY_AUDIT_ALLOW` etc.) but nothing is blocked on them. `high_risk_mode` (governs `delete_vm`, `delete_container`, `rollback_snapshot`, `restore_backup`, etc.) isn't set in config either, so it's *also* defaulting to `audit_only` — those destructive ops are unguarded too, independent of this change. |
| **New user-scope MCP servers may need a session restart** | Tools from a server registered via `claude mcp add` mid-session sometimes aren't discoverable until a fresh session — though in practice this one auto-connected within the same session once the container came up healthy. If a freshly-added server's tools don't show up via ToolSearch, start a new session before assuming something's broken. |
| **Config validation happens at container startup, in a crash-restart loop** | With `--restart unless-stopped`, a bad `config.json` produces a fast crash-loop (`docker ps` shows `Restarting (1) ...`) rather than a clean failure — always check `docker logs proxmox-mcp-plus` after any config change, not just `docker ps` status. |

## Verifying it's working

```bash
docker ps --filter name=proxmox-mcp-plus            # should show "Up", not "Restarting"
docker logs proxmox-mcp-plus --tail 20               # should end on "Uvicorn running on http://0.0.0.0:8000"
claude mcp list                                       # proxmox-mcp-plus should show "✔ Connected"
```

Then, from a Claude Code session with the server loaded, call the `get_nodes` MCP tool
and confirm it returns real cluster data (node name, uptime, CPU/memory) rather than an
error — that's the only way to confirm the full chain (SSH tunnel → cloudflared →
Cloudflare Access → Proxmox API) is actually working end to end, not just that the
container process is alive.
