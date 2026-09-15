# Proxmox MCP — local operator setup, not part of HOPE

Documents a personal Claude Code tool the maintainer runs locally to operate their own Proxmox
homelab (`server.taphuynh.dev`) through natural-language MCP calls. Nothing here is deployed,
built, or shipped as part of the HOPE platform — it runs entirely outside this repo, on the
operator's own machine, registered at Claude Code **user scope** (every project, not just
`hope-v2` — there is no entry for it in this repo's `.mcp.json.example`, and there should never be
one). It is recorded here per
[`01-development-workflow.md`](../../../.claude/rules/01-development-workflow.md)'s documentation
convention, purely so the setup is reproducible and the gotchas aren't re-discovered from scratch.

Project: [RekklesNA/ProxmoxMCP-Plus](https://github.com/RekklesNA/ProxmoxMCP-Plus) — exposes
Proxmox VE (VM/LXC lifecycle, snapshots, backups, cluster status, ...) as MCP tools. Runtime path
chosen: Docker, native MCP Streamable HTTP (`mcp-http` mode).

## Layout

This directory holds only this file. Every path it references — `config.json`, the SSH keypair,
`known_hosts` — lives outside this repo, under `~/.proxmox-mcp/` on the operator's machine; none of
it is committed anywhere.

## How it works

### Why this was harder than the upstream README suggests

The upstream Docker quick-start assumes the client can reach the Proxmox API directly. Here it
can't, for two independent reasons:

1. **Proxmox is only reachable through a Cloudflare Tunnel**, and the public hostname
   (`server.taphuynh.dev`) sits behind Cloudflare Access (Zero Trust). Every HTTP request —
   including one carrying a valid Proxmox API token — gets 302-redirected to a Cloudflare Access
   login page before it ever reaches `pveproxy`.
2. **The operator cannot edit the Cloudflare Access policy** (no dashboard permission), so the
   obvious fix — a `Bypass` policy scoped to the container's egress IP, or a Service Token header —
   isn't available. It's also moot: ProxmoxMCP-Plus's `ProxmoxConfig` model has no field for extra
   HTTP headers, so it couldn't send a CF Access Service Token even if one existed.

The tool ships a purpose-built escape hatch for exactly this shape of problem: `api_tunnel`, a
local SSH port-forward the server establishes on startup before talking to the Proxmox API. That's
what's wired up below — with its own trap (see Gotchas), because the only thing the operator could
already reach was an SSH shell via `cloudflared access rdp`, not a plain SSH port.

### Architecture

```
Claude Code (any project, user-scope MCP)
  |  Streamable HTTP, http://localhost:8000/mcp
  v
Docker container "proxmox-mcp-plus" (ghcr.io/rekklesna/proxmoxmcp-plus:latest)
  |  on startup: SSHTunnelManager runs `ssh -N -L 127.0.0.1:8006:127.0.0.1:8006`
  |  using a dedicated ed25519 key, target = host.docker.internal:22
  v
host.docker.internal  (Docker Desktop's DNS name for the Mac itself)
  |  port 22 is NOT this Mac's sshd -- it's a local listener opened by:
  |  `sudo cloudflared access rdp --hostname remote.taphuynh.dev --url ssh://localhost:22`
  |  (must be kept running manually -- see Gotchas)
  v
Cloudflare Access (operator's cached browser/CLI login) -> Cloudflare Tunnel
  v
Proxmox node's real sshd (port 22) -- the SSH protocol terminates HERE, not at
  cloudflared, which is just relaying raw TCP bytes through the tunnel
  v
`-L` forward resolved locally on the Proxmox node -> 127.0.0.1:8006 (pveproxy)
```

Two independent auth layers stack here: Cloudflare Access authenticates the raw TCP hop into the
network (the operator's cached identity — no policy change needed for this path, unlike the
direct-HTTPS attempt), and SSH key auth authenticates the container once traffic reaches the real
sshd. Neither layer knows about the other.

The "right" fix, if dashboard access is ever granted, is a `Bypass` policy scoped to
`server.taphuynh.dev/api2/*` by egress IP — the container would hit the Proxmox API directly over
HTTPS, with no SSH hop, no `dev_mode`/`verify_ssl` compromise, and no dependency on a
manually-kept-alive `cloudflared` process.

### `config.json` — the parts that aren't in the upstream example

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

- `proxmox.host`/`port` point at the local end of the SSH tunnel, not the public hostname — once
  `api_tunnel` establishes the forward, `127.0.0.1:8006` inside the container *is* Proxmox's
  `pveproxy`.
- `api_tunnel.remote_host`/`remote_port` are resolved by the Proxmox node itself once SSH lands
  there (`127.0.0.1:8006` = pveproxy's own loopback listener), not by anything in between.
- `ssh.key_file`/`known_hosts_file` are container-internal paths, mounted in from the host at
  container-run time.

## Commands

```bash
# One-time key provisioning: dedicated key, never reused elsewhere
ssh-keygen -t ed25519 -f ~/.proxmox-mcp/ssh/proxmox_mcp_tunnel -N "" -C "proxmox-mcp-plus-tunnel"

# Get an interactive root shell via the existing Cloudflare Access identity,
# then append the PUBLIC key to /root/.ssh/authorized_keys on the Proxmox node
sudo cloudflared access rdp --hostname remote.taphuynh.dev --url ssh://localhost:22
ssh root@localhost

# Capture the host key exactly as the container will see it (through
# host.docker.internal:22, not scanned directly against the Proxmox node)
docker run --rm ghcr.io/rekklesna/proxmoxmcp-plus:latest \
  ssh-keyscan -p 22 -T 10 host.docker.internal > ~/.proxmox-mcp/ssh/known_hosts

# Run the container
docker run -d --name proxmox-mcp-plus --restart unless-stopped -p 8000:8000 \
  -e PROXMOX_MCP_MODE=mcp-http \
  -e MCP_HOST=0.0.0.0 \
  -e MCP_PORT=8000 \
  -e MCP_TRANSPORT=STREAMABLE_HTTP \
  -v "$HOME/.proxmox-mcp/config.json:/app/proxmox-config/config.json:ro" \
  -v "$HOME/.proxmox-mcp/ssh/proxmox_mcp_tunnel:/run/secrets/proxmox_mcp_tunnel:ro" \
  -v "$HOME/.proxmox-mcp/ssh/known_hosts:/run/secrets/known_hosts:ro" \
  ghcr.io/rekklesna/proxmoxmcp-plus:latest

# Register with Claude Code at USER scope (every project, not just hope-v2)
claude mcp add --transport http proxmox-mcp-plus http://localhost:8000/mcp -s user

# Verify
docker ps --filter name=proxmox-mcp-plus            # should show "Up", not "Restarting"
docker logs proxmox-mcp-plus --tail 20               # should end on "Uvicorn running on http://0.0.0.0:8000"
claude mcp list                                       # proxmox-mcp-plus should show "Connected"
```

Then, from a Claude Code session with the server loaded, call its `get_nodes` MCP tool and confirm
it returns real cluster data (node name, uptime, CPU/memory) — that is the only way to confirm the
full chain (SSH tunnel -> cloudflared -> Cloudflare Access -> Proxmox API) is actually working end
to end, not just that the container process is alive.

## Gotchas

| Gotcha | Detail |
|---|---|
| `cloudflared access rdp` must stay running | A manually-started, `sudo`-bound (port 22) foreground process on the Mac. If it dies (reboot, closed terminal, sleep), the SSH tunnel — and therefore every Proxmox MCP call — fails until restarted. Not a LaunchAgent today. |
| `security.dev_mode: true` + `proxmox.verify_ssl: false` | Required because `pveproxy` presents a self-signed cert and `ProxmoxConfig` has no CA-pinning field — the loader hard-blocks `verify_ssl: false` unless `dev_mode` is set (`"Insecure TLS configuration blocked"`). Accepted here because the real transport security is the SSH tunnel, not this loopback-only, post-tunnel TLS hop. |
| `api_tunnel` needs the full schema even when fields look optional | Pydantic validation fails with `api_tunnel.ssh_host: Field required` if the section only has `{"enabled": false}` — every field in `APITunnelConfig` is required regardless of `enabled`. |
| `command_policy.mode: "audit_only"` | Changed from the default-safe `deny_all`. Per upstream's `CommandPolicyGate.evaluate`, `deny_patterns` (the `rm -rf` / fork-bomb guards) still hard-block regardless of mode, but `allow_patterns` stop being enforced — `audit_only` only skips the allowlist check. Net effect: `execute_vm_command`/`execute_container_command` run any command that doesn't match a deny pattern; decisions are still logged (`CMD_POLICY_AUDIT_ALLOW`, etc.) but nothing is blocked. `high_risk_mode` (governs `delete_vm`, `delete_container`, `rollback_snapshot`, `restore_backup`) is also unset, so it defaults to `audit_only` too — those destructive ops are unguarded independently of the above. |
| New user-scope MCP servers may need a session restart | Tools from a server registered mid-session via `claude mcp add` sometimes aren't discoverable until a fresh session. If a freshly-added server's tools don't show up, start a new session before assuming something's broken. |
| Config validation happens at container startup, in a crash-restart loop | With `--restart unless-stopped`, a bad `config.json` produces a fast crash-loop (`docker ps` shows `Restarting (1) ...`) rather than a clean failure — check `docker logs proxmox-mcp-plus`, not just `docker ps` status, after any config change. |
| `ConnectionRefused` on this server in a Claude Code session | Means the local chain above isn't currently up (the Docker container, or `cloudflared access rdp`) — not that the server is unconfigured. Restart the pieces in the Architecture section above rather than assuming registration is broken. |

## Related

- [`../../../.claude/rules/01-development-workflow.md`](../../../.claude/rules/01-development-workflow.md) — the documentation convention this page follows
- `.mcp.json.example` (repo root) — the project-scope MCP servers HOPE itself uses; this tool is deliberately not one of them
