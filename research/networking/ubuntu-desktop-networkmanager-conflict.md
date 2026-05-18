# Ubuntu Desktop + NetworkManager Conflict Resolution

**Date**: 2026-04-16
**Affected VM**: VM 400 (K3s master node)
**Bridge**: vmbr1 (Shared Services)
**Expected IP**: 10.10.1.100/24
**Gateway**: 10.10.1.1

---

## Problem Summary

After installing Ubuntu Desktop (GNOME) on an Ubuntu Server VM, the network connection fails with the error:

> **"Connection failed - Activation of network connection failed"**

The VM loses its static IP configuration and SSH remote access becomes unavailable.

---

## Root Cause

Ubuntu Server uses **netplan** with **systemd-networkd** as the renderer to manage network interfaces. When you install `ubuntu-desktop`, it also installs **NetworkManager**, which is the default network manager for GNOME desktop environments.

The conflict occurs because:

1. **NetworkManager** starts managing the network interface (`enp6s18`)
2. **NetworkManager** doesn't have the static IP configuration (it expects DHCP or manual GUI setup)
3. **netplan** is no longer applying its configuration because NetworkManager took over
4. Result: Interface has no IP address assigned

### Evidence

```bash
# Interface shows UP but NO IP address
$ ip addr show enp6s18
2: enp6s18: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000
    link/ether bc:24:11:6c:11:f8 brd ff:ff:ff:ff:ff:ff
# Notice: no "inet 10.10.1.100/24" line

# NetworkManager shows interface as "disconnected"
$ nmcli device status
DEVICE          TYPE      STATE         CONNECTION
enp6s18         ethernet  disconnected  --
# ... other K3s interfaces show "unmanaged"
```

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

### Option A: Keep netplan (Recommended for Servers)

Tell NetworkManager to NOT manage the physical interface, letting netplan handle it.

#### Step 1: Access VM via Proxmox Console

Since SSH is broken, access the VM through:
1. Proxmox Web UI → VM 400 → Console
2. Or: `qm terminal 400` from Proxmox host

#### Step 2: Configure NetworkManager to Ignore the Interface

```bash
# Create NetworkManager config to unmanage the interface
sudo tee /etc/NetworkManager/conf.d/99-unmanaged.conf << 'EOF'
[keyfile]
unmanaged-devices=interface-name:enp6s18
EOF

# Restart NetworkManager
sudo systemctl restart NetworkManager
```

#### Step 3: Re-apply netplan Configuration

```bash
# Verify netplan config exists
cat /etc/netplan/*.yaml

# Apply netplan
sudo netplan apply

# Verify IP is assigned
ip addr show enp6s18
```

#### Step 4: Verify Connectivity

```bash
# Test gateway
ping -c 2 10.10.1.1

# Test internet (through NAT)
ping -c 2 8.8.8.8
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

### Original netplan Config

File: `/etc/netplan/00-installer-config.yaml` (or similar)

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

---

## Related Documentation

- [Proxmox Network Topology Design](../infrastructure/proxmox-network-topology-design.md)
- [Proxmox Setup Dell 7920](../infrastructure/proxmox-setup-dell-7920-step-by-step.md)

---

## Change History

| Date | Description |
|------|-------------|
| 2026-04-16 | Initial documentation after VM 400 network failure |
