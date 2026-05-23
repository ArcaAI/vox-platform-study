# Ubuntu Desktop + NetworkManager Conflict Resolution

**Date**: 2026-04-16
**Last Updated**: 2026-05-20
**Affected VM**: VM 400 (K3s master node)
**Bridge**: vmbr1 (Shared Services)
**Expected IP**: 10.10.1.100/24
**Gateway**: 10.10.1.1

---

## Problem Summary

After installing Ubuntu Desktop (GNOME) on an Ubuntu Server VM (Ubuntu Live Server installer), the network connection fails with the error:

> **"Connection failed - Activation of network connection failed"**

The VM loses its static IP configuration and SSH remote access becomes unavailable.

In a more severe state (observed on 2026-05-20 after partial fix attempt), the interface ends up **completely orphaned** — neither NetworkManager nor systemd-networkd manages it — and `ip addr show enp6s18` reports `state DOWN, qdisc noop` with no IP at all.

---

## Root Cause

Ubuntu Server (Live Server installer) uses **netplan** with **systemd-networkd** as the renderer to manage network interfaces. Installing `ubuntu-desktop` introduces **three** distinct conflicts at once. Each one alone can break networking; together they leave the interface unmanaged.

### Conflict 1 — NetworkManager hijacks the interface

`ubuntu-desktop` pulls in **NetworkManager**, which is the default network manager for GNOME. NetworkManager starts managing `enp6s18`, but has no static IP profile for it (it expects DHCP or manual GUI setup), so the interface gets no address.

### Conflict 2 — Netplan's default renderer flips to NetworkManager

On a fresh **Ubuntu Server** install, netplan's system-wide default renderer is `networkd`. After `ubuntu-desktop` is installed, the default flips to `NetworkManager`. If your netplan YAML doesn't explicitly set `renderer: networkd`, netplan hands the config to NetworkManager — which is now told to ignore the interface (see Conflict 1). Result: **nobody applies the config**, and `systemd-networkd` doesn't even know about the interface.

### Conflict 3 — cloud-init regenerates a competing netplan file

The Ubuntu Live Server installer leaves cloud-init enabled. On every boot, cloud-init writes `/etc/netplan/50-cloud-init.yaml` from the data it captured at install time — typically:

```yaml
network:
  version: 2
  ethernets:
    enp6s18:
      dhcp4: true
```

Netplan **merges** every `.yaml` file in `/etc/netplan/`. So your static-IP file (e.g. `01-netcfg.yaml`) gets merged with cloud-init's DHCP file → contradictory config (static + DHCP, no renderer). Even if you fix the renderer, cloud-init will **regenerate** `50-cloud-init.yaml` on the next reboot and you're back to square one unless cloud-init's network module is explicitly disabled.

### Evidence

**Mild case** (NetworkManager hijacked the interface):

```bash
$ ip addr show enp6s18
2: enp6s18: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000
    link/ether bc:24:11:6c:11:f8 brd ff:ff:ff:ff:ff:ff
# Notice: no "inet 10.10.1.100/24" line — interface is UP but unconfigured

$ nmcli device status
DEVICE          TYPE      STATE         CONNECTION
enp6s18         ethernet  disconnected  --
```

**Severe case — interface orphaned** (observed 2026-05-20 after `99-unmanaged.conf` was applied without the renderer/cloud-init fixes):

```bash
$ ip addr show enp6s18
2: enp6s18: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN group default qlen 1000
    link/ether bc:24:11:6c:11:f8 brd ff:ff:ff:ff:ff:ff
# state DOWN + qdisc noop = nobody is managing this interface

$ ip route
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1 linkdown
# No default route, no enp6s18 route at all

$ sudo systemctl status systemd-networkd
● systemd-networkd.service - Network Configuration
     Active: active (running) since Wed 2026-05-20 03:32:07 UTC
# Service is running, but logs only show "lo: Link UP" — enp6s18 was never picked up

$ sudo cat /etc/netplan/50-cloud-init.yaml
network:
  version: 2
  ethernets:
    enp6s18:
      dhcp4: true
# Confirms the cloud-init conflict
```

In the GNOME Settings → Network panel, the **Wired** section is also missing entirely — because NetworkManager has been told to ignore the only physical interface. This is *expected* with the unmanaged-devices approach, not an additional bug.

---

## Installation Commands That Caused the Issue

```bash
sudo apt update
sudo apt upgrade

# This installs GNOME + NetworkManager
sudo apt install ubuntu-desktop

# Enable GUI on boot
sudo systemctl set-default graphical.target

sudo reboot
```

---

## Solution Options

### Option A: Keep netplan/systemd-networkd (Recommended for Servers)

Hand the physical interface back to `systemd-networkd` via netplan. **All three layers** (NetworkManager unmanaged, explicit `renderer: networkd`, cloud-init disabled) must be in place — fixing only one will leave the interface broken in a different way.

This is the procedure that was verified working on VM 400 on **2026-05-20**.

#### Step 1: Access VM via Proxmox Console

Since SSH is broken, access the VM through:

1. Proxmox Web UI → VM 400 → Console
2. Or: `qm terminal 400` from Proxmox host

#### Step 2: Tell NetworkManager to Ignore the Interface

```bash
sudo tee /etc/NetworkManager/conf.d/99-unmanaged.conf << 'EOF'
[keyfile]
unmanaged-devices=interface-name:enp6s18
EOF

sudo systemctl restart NetworkManager
```

#### Step 3: Disable cloud-init's Network Management

This is the step most commonly missed. Without it, cloud-init regenerates `50-cloud-init.yaml` on every boot and re-introduces the DHCP conflict.

```bash
sudo tee /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg > /dev/null << 'EOF'
network: {config: disabled}
EOF

sudo mv /etc/netplan/50-cloud-init.yaml /etc/netplan/50-cloud-init.yaml.disabled
```

> If `50-cloud-init.yaml` does not exist, skip the `mv` — only the `99-disable-network-config.cfg` is required to prevent future regeneration.

#### Step 4: Write a Clean netplan with Explicit `renderer: networkd`

```bash
sudo tee /etc/netplan/01-netcfg.yaml > /dev/null << 'EOF'
network:
  version: 2
  renderer: networkd
  ethernets:
    enp6s18:
      addresses: [10.10.1.100/24]
      routes:
        - to: default
          via: 10.10.1.1
      nameservers:
        addresses: [8.8.8.8, 1.1.1.1]
EOF

sudo chmod 600 /etc/netplan/01-netcfg.yaml
sudo chmod 600 /etc/netplan/*.disabled 2>/dev/null || true
```

> **`renderer: networkd`** is the critical line — after `ubuntu-desktop` is installed, netplan's default renderer flips to `NetworkManager`. Without this explicit override, the config gets handed to NM, which is told to ignore the interface (Step 2), and nothing applies.
>
> **`chmod 600`** silences the `Permissions for /etc/netplan/01-netcfg.yaml are too open` warning from `netplan apply`.

#### Step 5: Apply and Bring the Interface Up

```bash
sudo netplan generate
sudo netplan apply
sudo systemctl restart systemd-networkd
sudo ip link set enp6s18 up
```

#### Step 6: Verify Connectivity

```bash
ip addr show enp6s18
# Expected: state UP, inet 10.10.1.100/24

ip route
# Expected: default via 10.10.1.1 dev enp6s18

ping -c 2 10.10.1.1       # gateway
ping -c 2 8.8.8.8         # internet via IP (NAT)
ping -c 2 google.com      # DNS + internet
```

If any of these fail, inspect `systemd-networkd` directly:

```bash
sudo journalctl -u systemd-networkd --no-pager -n 30
sudo networkctl status enp6s18
```

---

### Option B: Manual IP Assignment (Emergency Recovery)

If netplan still doesn't work, manually assign the IP to restore SSH access immediately:

```bash
# Manually assign IP (temporary until reboot)
sudo ip addr add 10.10.1.100/24 dev enp6s18
sudo ip route add default via 10.10.1.1

# Verify
ip addr show enp6s18
ping -c 2 10.10.1.1
```

**Note**: This is temporary. After reboot, you'll need to fix the underlying issue.

---

### Option C: Switch Fully to NetworkManager

If you prefer NetworkManager to handle networking (typical for desktop use):

#### Step 1: Configure Static IP via NetworkManager

```bash
# Create a new connection with static IP
sudo nmcli con add type ethernet con-name "vmbr1-static" ifname enp6s18 \
  ipv4.addresses "10.10.1.100/24" \
  ipv4.gateway "10.10.1.1" \
  ipv4.dns "8.8.8.8,1.1.1.1" \
  ipv4.method manual \
  connection.autoconnect yes

# Activate the connection
sudo nmcli con up "vmbr1-static"

# Verify
ip addr show enp6s18
```

#### Step 2: Disable netplan (Optional)

```bash
# Rename existing netplan configs
sudo mv /etc/netplan/00-installer-config.yaml /etc/netplan/00-installer-config.yaml.disabled

# Create minimal netplan that delegates to NetworkManager
sudo tee /etc/netplan/01-network-manager.yaml << 'EOF'
network:
  version: 2
  renderer: NetworkManager
EOF

sudo netplan apply
```

---

## Troubleshooting

### Check Interface Names

```bash
# List all network interfaces
ip -br link show | grep -v lo

# Common patterns:
# - ens18, ens19 (older naming)
# - enp6s18, enp6s19 (PCI bus naming)
```

### Check netplan Syntax

```bash
# Validate netplan config
sudo netplan generate

# Apply with debug output
sudo netplan apply --debug
```

### Check systemd-networkd Status

```bash
# netplan uses systemd-networkd as backend
systemctl status systemd-networkd

# If not running:
sudo systemctl enable systemd-networkd
sudo systemctl start systemd-networkd
```

### Check NetworkManager Status

```bash
# View all devices and their state
nmcli device status

# View all connections
nmcli connection show

# View connection details
nmcli connection show "connection-name"
```

### Force Interface Up

```bash
# Bring interface up manually
sudo ip link set enp6s18 up

# Then try netplan again
sudo netplan apply
```

### Interface stuck in `state DOWN, qdisc noop`

If `ip addr show enp6s18` reports `state DOWN, qdisc noop` and `ip route` shows no default route for it, the interface is **orphaned** — neither NetworkManager nor systemd-networkd is managing it. This happens when `99-unmanaged.conf` is applied (NM ignores the NIC) **and** netplan's effective renderer is still `NetworkManager` (no explicit `renderer: networkd`).

Confirm by listing every netplan file and the active renderer:

```bash
ls -la /etc/netplan/
sudo cat /etc/netplan/*.yaml

# Inspect the generated systemd-networkd unit (if renderer is networkd, this file exists)
ls /run/systemd/network/

# Confirm systemd-networkd never saw the interface
sudo journalctl -u systemd-networkd --no-pager -n 30 | grep enp6s18 || echo "enp6s18 never picked up by networkd"
```

Fix: re-run **Option A** in full — Steps 2, 3, **and** 4 (the renderer override and cloud-init disable are mandatory).

### cloud-init Regenerates `50-cloud-init.yaml` on Reboot

If networking works after `netplan apply` but breaks again after a reboot, cloud-init is rewriting its netplan file. Verify with:

```bash
ls -la /etc/netplan/
# If 50-cloud-init.yaml reappeared, cloud-init's network module is still active

sudo cat /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg
# Should contain: network: {config: disabled}
```

If the disable file is missing or wrong, re-run **Option A — Step 3**.

---

## VM 400 Specific Configuration

### Network Topology

```
VM 400 (K3s Master)
├── Interface: enp6s18
├── Bridge: vmbr1 (Shared Services)
├── IP: 10.10.1.100/24
├── Gateway: 10.10.1.1 (Proxmox host)
└── DNS: 8.8.8.8, 1.1.1.1
```

### Original netplan Config (pre-ubuntu-desktop)

File: `/etc/netplan/00-installer-config.yaml` (or similar, as written by the Ubuntu Live Server installer)

```yaml
network:
  version: 2
  ethernets:
    enp6s18:
      addresses: [10.10.1.100/24]
      routes:
        - to: default
          via: 10.10.1.1
      nameservers:
        addresses: [8.8.8.8, 1.1.1.1]
```

### Current Working Config (after 2026-05-20 fix)

File: `/etc/netplan/01-netcfg.yaml` (mode `0600`)

```yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    enp6s18:
      addresses: [10.10.1.100/24]
      routes:
        - to: default
          via: 10.10.1.1
      nameservers:
        addresses: [8.8.8.8, 1.1.1.1]
```

Supporting files now in place on VM 400:

| File | Purpose |
|---|---|
| `/etc/netplan/01-netcfg.yaml` | Active netplan config (`renderer: networkd`, static IP) |
| `/etc/netplan/50-cloud-init.yaml.disabled` | Old cloud-init config, renamed so netplan ignores it |
| `/etc/NetworkManager/conf.d/99-unmanaged.conf` | NetworkManager told to ignore `enp6s18` |
| `/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg` | Prevents cloud-init from regenerating `50-cloud-init.yaml` on boot |

### Additional Interfaces (K3s)

The VM also has K3s/Kubernetes networking interfaces:
- `flannel.1` - Flannel VXLAN overlay
- `cni0` - Container Network Interface bridge
- `docker0` - Docker bridge (if using Docker)
- `veth*` - Virtual ethernet pairs for pods

These are managed by K3s, not by netplan or NetworkManager.

---

## Prevention

When installing a desktop environment on an Ubuntu Server with static IP:

### Method 1: Install Desktop Without NetworkManager

```bash
# Install GNOME without the full ubuntu-desktop meta-package
sudo apt install gnome-shell gnome-session gdm3 gnome-terminal nautilus

# This gives you a basic GNOME desktop without NetworkManager
```

### Method 2: Pre-configure NetworkManager Exclusion

Before installing ubuntu-desktop:

```bash
# Create the unmanaged config first
sudo mkdir -p /etc/NetworkManager/conf.d
sudo tee /etc/NetworkManager/conf.d/99-unmanaged.conf << 'EOF'
[keyfile]
unmanaged-devices=interface-name:enp6s18;interface-name:ens*;interface-name:enp*
EOF

# Then install desktop
sudo apt install ubuntu-desktop
```

### Method 3: Use netplan with NetworkManager Renderer

Configure netplan to use NetworkManager as the renderer but still define static IPs:

```yaml
# /etc/netplan/01-netcfg.yaml
network:
  version: 2
  renderer: NetworkManager
  ethernets:
    enp6s18:
      addresses: [10.10.1.100/24]
      routes:
        - to: default
          via: 10.10.1.1
      nameservers:
        addresses: [8.8.8.8, 1.1.1.1]
```

### Method 4: Disable cloud-init Network Management (Always Recommended)

Independent of which renderer you choose, disable cloud-init's network module so it stops regenerating `/etc/netplan/50-cloud-init.yaml` (which always contains `dhcp4: true` and conflicts with any static config).

```bash
sudo tee /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg > /dev/null << 'EOF'
network: {config: disabled}
EOF

# Remove (or disable) the existing cloud-init netplan file if it exists
sudo mv /etc/netplan/50-cloud-init.yaml /etc/netplan/50-cloud-init.yaml.disabled 2>/dev/null || true
```

Do this **on every VM 4xx host** as part of standard provisioning, before installing any desktop or making the netplan static-IP customisation. It is a no-op on VMs that have already been fixed.

---

## Related Documentation

- [Proxmox Network Topology Design](../infrastructure/proxmox-network-topology-design.md)
- [Proxmox Setup Dell 7920](../infrastructure/proxmox-setup-dell-7920-step-by-step.md)

---

## Change History

| Date | Description |
|------|-------------|
| 2026-04-16 | Initial documentation after VM 400 network failure |
| 2026-05-20 | Documented full root cause after re-occurrence on VM 400. Original Option A was incomplete on a desktop-converted server: `99-unmanaged.conf` alone leaves the interface orphaned (`state DOWN, qdisc noop`). Added two additional required pieces — explicit `renderer: networkd` in netplan, and disabling cloud-init's network module — and rewrote Option A as a verified end-to-end procedure. Added troubleshooting subsections for the orphaned-interface and cloud-init regeneration cases, added Method 4 to Prevention, and captured the current working VM 400 config. |
