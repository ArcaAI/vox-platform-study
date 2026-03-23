# Proxmox VE Setup Guide — Dell Precision 7920 Tower

**Hardware**: Dell Precision 7920 Tower, 2x Intel Xeon Platinum 8168 (96 logical CPUs), 256 GB RAM, 2x NVIDIA RTX 2000 Ada Generation (16 GB)
**Date**: 2026-03-12
**Proxmox Version**: 9.1
**Estimated Time**: 2–3 hours

---

## Table of Contents

1. [Hardware Overview (Confirmed)](#1-hardware-overview-confirmed)
2. [Prepare Installation Media](#2-prepare-installation-media)
3. [BIOS Configuration](#3-bios-configuration)
4. [Install Proxmox VE 9.1](#4-install-proxmox-ve-91)
5. [Post-Install Host Configuration](#5-post-install-host-configuration)
6. [Enable IOMMU & GPU Passthrough](#6-enable-iommu--gpu-passthrough)
7. [Create GPU VM (AI Primary)](#7-create-gpu-vm-ai-primary)
8. [Create GPU VM (AI Secondary)](#8-create-gpu-vm-ai-secondary)
9. [Create Database VM](#9-create-database-vm)
10. [Create Monitoring VM](#10-create-monitoring-vm)
11. [GPU VM Internal Setup](#11-gpu-vm-internal-setup)
12. [Networking Between VMs](#12-networking-between-vms)
13. [Verification Checklist](#13-verification-checklist)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Hardware Overview (Confirmed)

### Dell Precision 7920 Tower — Verified Specifications

| Component | Detail |
|-----------|--------|
| **Form Factor** | Tower workstation |
| **CPU** | 2x Intel Xeon Platinum 8168 @ 2.70 GHz (Turbo 3.70 GHz) |
| **Architecture** | Skylake-SP, LGA 3647 |
| **Cores** | 24 cores/socket × 2 sockets = **48 physical cores** |
| **Threads** | 2 threads/core = **96 logical CPUs** |
| **RAM** | 256 GB DDR4-2666 ECC |
| **GPU #1** | NVIDIA RTX 2000 Ada Generation (AD107GL) — **PCI 4f:00.0** |
| **GPU #2** | NVIDIA RTX 2000 Ada Generation (AD107GL) — **PCI d5:00.0** |
| **GPU VRAM** | 16 GB GDDR6 ECC per GPU |
| **GPU Device IDs** | VGA: `10de:28b0` / Audio: `10de:22be` |
| **Virtualization** | Intel VT-x confirmed |
| **BIOS Key** | F2 (Setup) / F12 (One-Time Boot Menu) |

### NUMA Topology (Confirmed)

```
NUMA Node 0 (Socket 0 — Xeon Platinum 8168 #1):
  Physical cores: 0-23
  HT siblings:    48-71
  Total:          48 logical CPUs
  L3 Cache:       33 MB

NUMA Node 1 (Socket 1 — Xeon Platinum 8168 #2):
  Physical cores: 24-47
  HT siblings:    72-95
  Total:          48 logical CPUs
  L3 Cache:       33 MB
```

### GPU PCI Topology

```
GPU #1: 4f:00.0 — NVIDIA RTX 2000 Ada [10de:28b0]
        4f:00.1 — NVIDIA HD Audio      [10de:22be]

GPU #2: d5:00.0 — NVIDIA RTX 2000 Ada [10de:28b0]
        d5:00.1 — NVIDIA HD Audio      [10de:22be]
```

The wide gap between PCI bus addresses (`4f` vs `d5`) strongly indicates the GPUs are on **different NUMA nodes** — GPU #1 (4f) likely on NUMA node 0 (CPU0), GPU #2 (d5) likely on NUMA node 1 (CPU1). This is the ideal layout for performance.

**Confirm after Proxmox install with:**
```bash
cat /sys/bus/pci/devices/0000:4f:00.0/numa_node   # expect: 0
cat /sys/bus/pci/devices/0000:d5:00.0/numa_node   # expect: 1
```

### PCIe Slot Layout

```
Slot 1: PCIe x8  Gen 3 (Open Ended)     — CPU0
Slot 2: PCIe x16 Gen 3                   — CPU0  ← GPU #1 (4f:00.0) likely here
Slot 3: PCIe x16 Gen 3 (wired as x1)    — CPU0
Slot 4: PCIe x16 Gen 3                   — CPU0
Slot 5: PCIe x16 Gen 3 (wired as x4)    — CPU0
Slot 6: PCIe x16 Gen 3                   — CPU1  ← GPU #2 (d5:00.0) likely here
Slot 7: PCIe x16 Gen 3                   — CPU1
```

The GPUs are already in the NUMA-optimal configuration — one per socket. No hardware changes needed.

### Pre-Flight Checklist

Before starting, confirm you have:

- [ ] Dell Precision 7920 Tower powered off
- [ ] USB flash drive (4 GB+) for Proxmox installer
- [ ] Network cable connected (for Proxmox web UI access)
- [ ] Monitor + keyboard connected (for initial setup only)
- [ ] A second computer to download ISO and access Proxmox web UI
- [ ] Static IP address planned for the Proxmox host
- [ ] Both GPUs physically installed in PCIe slots

---

## 2. Prepare Installation Media

### Download Proxmox VE 9.1 ISO

```
URL:  https://www.proxmox.com/en/downloads/proxmox-virtual-environment/iso/proxmox-ve-9-1-iso-installer
File: proxmox-ve_9.1-1.iso
Size: 1.83 GB
```

### Create Bootable USB

**macOS:**
```bash
# Find your USB device
diskutil list
# Unmount it (replace diskN with your USB disk number)
diskutil unmountDisk /dev/diskN
# Write ISO (use rdisk for faster write)
sudo dd if=./proxmox-ve_9.1-1.iso of=/dev/rdiskN bs=4M status=progress
```

**Windows:**
- Use [balenaEtcher](https://etcher.balena.io/) — select ISO, select USB, flash
- Or use [Rufus](https://rufus.ie/) — select DD mode (not ISO mode)

**Linux:**
```bash
sudo dd if=./proxmox-ve_9.1-1.iso of=/dev/sdX bs=4M status=progress conv=fdatasync
```

---

## 3. BIOS Configuration

Power on the Dell 7920 and press **F2** immediately to enter BIOS Setup.

### 3.1 — System Configuration

Navigate to: **System Configuration > SATA Operation**
- Set to: **AHCI**

### 3.2 — Virtualization Support (CRITICAL)

Navigate to: **Virtualization Support**

| Setting | Required Value | Why |
|---------|---------------|-----|
| **Virtualization** | Enabled | Enables Intel VT-x for KVM hypervisor |
| **VT for Direct I/O** | **Enabled** | Enables Intel VT-d (IOMMU) — required for GPU passthrough |
| **Trusted Execution** | Disabled | Not needed, can interfere |

This is the most critical step. Without **VT for Direct I/O**, GPU passthrough will not work.

### 3.3 — Security

Navigate to: **Security > Secure Boot**
- Set **Secure Boot Enable** to: **Disabled**

Proxmox can work with Secure Boot, but disabling it avoids complications with VFIO kernel module loading and NVIDIA driver installation inside VMs.

### 3.4 — Boot Configuration

Navigate to: **General > Boot Sequence**
- Set **Boot List Option** to: **UEFI**
- Ensure USB is in the boot order (or use F12 for one-time boot)

### 3.5 — Advanced (if available)

Navigate to: **Advanced > Processor Configuration** (or similar)

| Setting | Required Value |
|---------|---------------|
| **Hyper-Threading** | Enabled |
| **All Cores Active** | Enabled |
| **Intel Turbo Boost** | Enabled |
| **C-States** | Enabled (for power saving) or Disabled (for consistent latency) |

Navigate to: **Advanced > Integrated Devices** or **System Configuration**

| Setting | Required Value |
|---------|---------------|
| **Above 4G Decoding** | **Enabled** (if available — needed for GPUs with >4GB VRAM) |
| **SR-IOV Global Enable** | Enabled (if available) |

### 3.6 — Save & Exit

Press **Apply** then **Exit**. The system will reboot.

---

## 4. Install Proxmox VE 9.1

### 4.1 — Boot from USB

1. Insert the Proxmox USB drive
2. Power on and press **F12** for One-Time Boot Menu
3. Select the USB drive (UEFI mode)

### 4.2 — Proxmox Installer

The graphical installer will load. Follow these steps:

**Step 1: Welcome Screen**
- Select **Install Proxmox VE (Graphical)**

**Step 2: EULA**
- Click **I agree**

**Step 3: Target Disk**
- Select your primary SSD/NVMe for Proxmox OS
- Click **Options** to configure:
  - **Filesystem**: ext4 (simple, reliable) or ZFS RAID1 (if you have 2 identical drives for redundancy)
  - **hdsize**: Leave default (uses full disk)
  - **swapsize**: 16 GB (with 256 GB RAM, swap is rarely used)
  - **maxroot**: Leave default
  - **maxvz**: Leave default (remaining space for VM storage)

**Step 4: Location and Timezone**
- Country: *your country*
- Timezone: *your timezone*
- Keyboard: *your layout*

**Step 5: Administration Password**
- **Password**: Choose a strong root password
- **Email**: admin@yourdomain.com (for notifications)

**Step 6: Network Configuration**

| Field | Value | Notes |
|-------|-------|-------|
| **Management Interface** | Select your primary NIC (e.g., `eno1`) | The one with the cable connected |
| **Hostname (FQDN)** | `pve-hope.local` | Or your actual FQDN |
| **IP Address (CIDR)** | `192.168.1.100/24` | Use your network's static IP |
| **Gateway** | `192.168.1.1` | Your router/gateway |
| **DNS Server** | `192.168.1.1` or `8.8.8.8` | Your DNS |

**Step 7: Summary**
- Review all settings
- Check **Automatically reboot after successful installation**
- Click **Install**

Installation takes ~5–10 minutes. Remove the USB drive when prompted and let it reboot.

### 4.3 — First Access

After reboot, the console will display:

```
Welcome to the Proxmox Virtual Environment. Please use your web browser to
configure this server - connect to:

  https://192.168.1.100:8006/
```

Open a browser on another computer and navigate to `https://192.168.1.100:8006/`

- Accept the self-signed certificate warning
- Login: `root` / *your password*
- Realm: **Linux PAM standard authentication**

---

## 5. Post-Install Host Configuration

SSH into the Proxmox host (or use the web console Shell):

```bash
ssh root@192.168.1.100
```

### 5.1 — Switch to Free (No-Subscription) Repository

```bash
# Disable enterprise repo (requires paid subscription key)
mv /etc/apt/sources.list.d/pve-enterprise.list /etc/apt/sources.list.d/pve-enterprise.list.disabled

# Disable Ceph enterprise repo if present
if [ -f /etc/apt/sources.list.d/ceph.list ]; then
  mv /etc/apt/sources.list.d/ceph.list /etc/apt/sources.list.d/ceph.list.disabled
fi

# Add no-subscription repo (free, full features)
echo "deb http://download.proxmox.com/debian/pve trixie pve-no-subscription" > \
  /etc/apt/sources.list.d/pve-no-subscription.list
```

### 5.2 — Remove Subscription Nag (Optional)

The web UI shows a "No valid subscription" popup on login. To remove it:

```bash
# This is a cosmetic change only — all features work without subscription
sed -Ei.bak "s/NotFound/Active/g; s/notfound/active/g" /usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js
systemctl restart pveproxy
```

### 5.3 — Update System

```bash
apt update && apt dist-upgrade -y
```

If a kernel update is installed, reboot:

```bash
reboot
```

### 5.4 — Install Useful Tools

```bash
apt install -y vim htop iotop net-tools lm-sensors pciutils
```

### 5.5 — Verify Hardware Detection

```bash
# Check CPU topology
lscpu | grep -E "Socket|Core|Thread|NUMA|Model name"

# Check RAM
free -h

# Check GPUs
lspci -nn | grep -i nvidia

# Check NUMA nodes
numactl --hardware

# Check which NUMA node each GPU is on
cat /sys/bus/pci/devices/0000:4f:00.0/numa_node
cat /sys/bus/pci/devices/0000:d5:00.0/numa_node
```

**Expected output** (confirmed from your hardware):

```
4f:00.0 VGA compatible controller [0300]: NVIDIA Corporation AD107GL [RTX 2000 / 2000E Ada Generation] [10de:28b0] (rev a1)
4f:00.1 Audio device [0403]: NVIDIA Corporation AD107 High Definition Audio Controller [10de:22be] (rev a1)
d5:00.0 VGA compatible controller [0300]: NVIDIA Corporation AD107GL [RTX 2000 / 2000E Ada Generation] [10de:28b0] (rev a1)
d5:00.1 Audio device [0403]: NVIDIA Corporation AD107 High Definition Audio Controller [10de:22be] (rev a1)
```

**Your confirmed PCI addresses and device IDs:**

| GPU | PCI Address | Function | Device ID |
|-----|-------------|----------|-----------|
| GPU #1 VGA | `4f:00.0` | VGA controller | `10de:28b0` |
| GPU #1 Audio | `4f:00.1` | HD Audio | `10de:22be` |
| GPU #2 VGA | `d5:00.0` | VGA controller | `10de:28b0` |
| GPU #2 Audio | `d5:00.1` | HD Audio | `10de:22be` |

---

## 6. Enable IOMMU & GPU Passthrough

### 6.1 — Enable IOMMU in Bootloader

```bash
# Edit GRUB configuration
# The Dell 7920 uses Intel Xeon, so we need intel_iommu
CURRENT=$(grep GRUB_CMDLINE_LINUX_DEFAULT /etc/default/grub)
echo "Current GRUB line: $CURRENT"

# Set the correct kernel parameters
sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT="quiet"/GRUB_CMDLINE_LINUX_DEFAULT="quiet intel_iommu=on iommu=pt"/' /etc/default/grub

# Verify the change
grep GRUB_CMDLINE_LINUX_DEFAULT /etc/default/grub
# Should show: GRUB_CMDLINE_LINUX_DEFAULT="quiet intel_iommu=on iommu=pt"

update-grub
```

### 6.2 — Load VFIO Kernel Modules

```bash
cat >> /etc/modules <<'EOF'
vfio
vfio_iommu_type1
vfio_pci
EOF
```

### 6.3 — Blacklist NVIDIA Drivers on Host

The GPUs will be used inside VMs, not on the host. Prevent the host from loading NVIDIA drivers:

```bash
cat > /etc/modprobe.d/blacklist-nvidia.conf <<'EOF'
blacklist nouveau
blacklist nvidia
blacklist nvidia_drm
blacklist nvidia_modeset
blacklist nvidia_uvm
EOF
```

### 6.4 — Bind GPUs to VFIO-PCI

Both GPUs share the same device IDs (`10de:28b0` for VGA, `10de:22be` for Audio), so a single vfio-pci entry claims all four functions (2 GPUs × 2 functions each):

```bash
echo "options vfio-pci ids=10de:28b0,10de:22be disable_vga=1" > /etc/modprobe.d/vfio.conf
```

### 6.5 — Update Initramfs and Reboot

```bash
update-initramfs -u -k all
reboot
```

### 6.6 — Verify IOMMU After Reboot

```bash
# Verify IOMMU is active
dmesg | grep -e DMAR -e IOMMU
# Should show: "DMAR: IOMMU enabled"

# Verify VFIO claimed the GPUs
lspci -nnk | grep -A 3 -i nvidia
# Should show: Kernel driver in use: vfio-pci

# Check IOMMU groups for the GPUs
find /sys/kernel/iommu_groups/ -type l | sort -V | while read line; do
  group=$(echo $line | awk -F/ '{print $6}')
  device=$(basename $line)
  desc=$(lspci -nns $device 2>/dev/null)
  if echo "$desc" | grep -qi nvidia; then
    echo "IOMMU Group $group: $desc"
  fi
done
```

**What to check:**
- All four NVIDIA functions (`4f:00.0`, `4f:00.1`, `d5:00.0`, `d5:00.1`) show `Kernel driver in use: vfio-pci`
- GPU #1 functions (`4f:00.0` + `4f:00.1`) share one IOMMU group
- GPU #2 functions (`d5:00.0` + `d5:00.1`) share a **different** IOMMU group
- The two GPUs are in **different** IOMMU groups (required to pass them to different VMs)

Since your GPUs are on different PCI buses (`4f` vs `d5`) connected to different CPU sockets, they will almost certainly be in separate IOMMU groups. This is the ideal configuration.

**If both GPUs are in the same IOMMU group** (very unlikely given your topology), add `pcie_acs_override=downstream,multifunction` to the GRUB line. This is acceptable for a playground environment.

---

## 7. Create GPU VM (AI Primary)

### 7.1 — Download Ubuntu ISO

```bash
# Download Ubuntu 24.04.2 LTS Server ISO to Proxmox storage
cd /var/lib/vz/template/iso/
wget https://releases.ubuntu.com/24.04.2/ubuntu-24.04.2-live-server-amd64.iso
```

### 7.2 — Create VM via Web UI

In the Proxmox web UI (`https://192.168.1.100:8006`):

1. Click **Create VM** (top right)

**General tab:**
| Field | Value |
|-------|-------|
| Node | pve-hope |
| VM ID | 100 |
| Name | ai-primary |

**OS tab:**
| Field | Value |
|-------|-------|
| ISO image | ubuntu-24.04.2-live-server-amd64.iso |
| Type | Linux |
| Version | 6.x - 2.6 Kernel |

**System tab:**
| Field | Value |
|-------|-------|
| Machine | q35 |
| BIOS | OVMF (UEFI) |
| Add EFI Disk | Yes (select your storage) |
| SCSI Controller | VirtIO SCSI single |
| Qemu Agent | Checked |

**Disks tab:**
| Field | Value |
|-------|-------|
| Bus/Device | VirtIO Block (virtio0) |
| Storage | local-lvm (or your SSD storage) |
| Disk size | 300 GB |
| Cache | Write back |
| Discard | Checked |
| IO thread | Checked |

**CPU tab:**
| Field | Value |
|-------|-------|
| Sockets | 1 |
| Cores | 40 |
| Type | host |
| NUMA | Checked |

**Memory tab:**
| Field | Value |
|-------|-------|
| Memory (MiB) | 114688 (112 GB) |
| Ballooning | Unchecked (disable for GPU VMs) |

**Network tab:**
| Field | Value |
|-------|-------|
| Bridge | vmbr0 |
| Model | VirtIO (virtio) |
| VLAN Tag | (leave empty unless using VLANs) |

2. Click **Finish** (do NOT start yet)

### 7.3 — Add GPU to VM

In the web UI, select VM 100 (ai-primary):

1. Go to **Hardware** tab
2. Click **Add > PCI Device**

| Field | Value |
|-------|-------|
| Raw Device | `0000:4f:00.0` (GPU #1 — NUMA node 0) |
| All Functions | **Checked** (passes both VGA `4f:00.0` + Audio `4f:00.1`) |
| ROM-Bar | Checked |
| Primary GPU | Unchecked (unless you want console output on GPU) |
| PCI-Express | **Checked** |

3. Click **Add**

### 7.4 — NUMA Pinning (via CLI)

GPU #1 (`4f:00.0`) is on NUMA node 0 (CPU0: cores 0-23, HT siblings 48-71). Pin this VM to that NUMA node.

SSH into the Proxmox host and edit the VM config:

```bash
nano /etc/pve/qemu-server/100.conf
```

Ensure these lines are present:

```
cpu: host
numa: 1
sockets: 1
cores: 40
cpuunits: 1024
```

The VM gets 40 of the 48 logical CPUs on NUMA node 0. Proxmox's NUMA-aware scheduler will prefer local memory, reducing cross-socket latency for GPU DMA operations.

### 7.5 — Install Ubuntu in VM

1. Start VM 100
2. Open the **Console** (noVNC or SPICE)
3. Install Ubuntu Server 24.04 LTS:
   - Language: English
   - Keyboard: your layout
   - Network: DHCP or static IP (e.g., `192.168.1.101/24`)
   - Storage: Use entire disk (virtio)
   - Username: `hope` (or your preference)
   - Install OpenSSH server: **Yes**
   - No additional snaps
4. Reboot after installation
5. Remove the ISO from the VM hardware (CD/DVD drive)

---

## 8. Create GPU VM (AI Secondary)

Repeat the same process as VM 100, with these differences:

### VM Creation Settings

| Field | VM 100 (AI Primary) | VM 200 (AI Secondary) |
|-------|--------------------|-----------------------|
| VM ID | 100 | 200 |
| Name | ai-primary | ai-secondary |
| Cores | 40 | 24 |
| Memory | 114688 MiB (112 GB) | 81920 MiB (80 GB) |
| Disk | 300 GB | 200 GB |
| GPU | `0000:4f:00.0` (GPU #1, NUMA 0) | `0000:d5:00.0` (GPU #2, NUMA 1) |
| NUMA Pin | Node 0 (CPUs 0-23, 48-71) | Node 1 (CPUs 24-47, 72-95) |
| IP | 192.168.1.101 | 192.168.1.102 |

GPU #2 (`d5:00.0`) is on NUMA node 1 (CPU1: cores 24-47, HT siblings 72-95). Pin VM 200 to NUMA node 1 for optimal memory locality.

In `/etc/pve/qemu-server/200.conf`, ensure:

```
cpu: host
numa: 1
sockets: 1
cores: 24
cpuunits: 1024
hostpci0: 0000:d5:00.0,pcie=1,x-vga=0
```

---

## 9. Create Database VM

### VM Creation Settings

| Field | Value |
|-------|-------|
| VM ID | 300 |
| Name | database |
| Machine | q35 |
| BIOS | OVMF (UEFI) |
| Cores | 16 |
| CPU Type | host |
| Memory | 32768 MiB (32 GB) |
| Disk | 500 GB (VirtIO Block) |
| Network | vmbr0, VirtIO |
| GPU | **None** |
| IP | 192.168.1.103 |

**No GPU passthrough needed.** This VM runs PostgreSQL, Redis, MinIO, and Qdrant.

After Ubuntu installation, install Docker and deploy database services:

```bash
# Inside VM 300
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

---

## 10. Create Monitoring VM

### VM Creation Settings

| Field | Value |
|-------|-------|
| VM ID | 400 |
| Name | monitoring |
| Machine | q35 |
| BIOS | OVMF (UEFI) |
| Cores | 8 |
| CPU Type | host |
| Memory | 16384 MiB (16 GB) |
| Disk | 200 GB (VirtIO Block) |
| Network | vmbr0, VirtIO |
| GPU | **None** |
| IP | 192.168.1.104 |

This VM runs Prometheus, Grafana, Loki, and NVIDIA DCGM Exporter (collecting GPU metrics remotely from the GPU VMs).

---

## 11. GPU VM Internal Setup

Run these steps inside **both** VM 100 (ai-primary) and VM 200 (ai-secondary).

### 11.1 — System Update

```bash
sudo apt update && sudo apt upgrade -y
sudo reboot
```

### 11.2 — Install QEMU Guest Agent

```bash
sudo apt install -y qemu-guest-agent
sudo systemctl enable --now qemu-guest-agent
```

### 11.3 — Verify GPU is Visible

```bash
lspci | grep -i nvidia
# Should show your RTX 2000 Ada
```

### 11.4 — Install NVIDIA Drivers (Open Kernel Modules)

```bash
# Install prerequisites
sudo apt install -y linux-headers-$(uname -r) build-essential dkms

# Add NVIDIA package repository
sudo apt install -y software-properties-common
sudo add-apt-repository -y ppa:graphics-drivers/ppa
sudo apt update

# Install the latest NVIDIA open kernel driver
# Check available versions:
apt list 'nvidia-driver-*' 2>/dev/null | grep open

# Install (use the latest 5xx series available)
sudo apt install -y nvidia-driver-595-open

sudo reboot
```

After reboot:

```bash
nvidia-smi
```

Expected output:

```
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 595.xx.xx    Driver Version: 595.xx.xx    CUDA Version: 13.2                |
|-----------------------------------------+------------------------+----------------------+
| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |
| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |
|=========================================+========================+======================|
|   0  NVIDIA RTX 2000 Ada Gene...   Off | 00000000:01:00.0   Off |                  Off |
| 30%   35C    P8               7W /  70W |       1MiB /  16384MiB |      0%      Default |
+-----------------------------------------+------------------------+----------------------+
```

### 11.5 — Install CUDA Toolkit

```bash
# Add NVIDIA CUDA repository
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt update

# Install CUDA toolkit (driver already installed above)
sudo apt install -y cuda-toolkit

# Add to PATH
echo 'export PATH=/usr/local/cuda/bin:$PATH' >> ~/.bashrc
echo 'export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH' >> ~/.bashrc
source ~/.bashrc

# Verify
nvcc --version
```

### 11.6 — Install Docker (System Daemon Only)

```bash
# Install Docker Engine (system daemon)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Log out and back in for group to take effect
exit
# SSH back in

docker --version
```

> **IMPORTANT — Do NOT use Docker rootless mode for GPU VMs.**
>
> Docker rootless runs a separate daemon under your user account that does NOT read
> `/etc/docker/daemon.json` or `/etc/cdi/`. GPU containers will fail with
> `"no known GPU vendor found"` or `"unresolvable CDI devices"`.
>
> If Docker rootless was installed (check: `systemctl --user status docker`), disable it:
>
> ```bash
> systemctl --user stop docker
> systemctl --user disable docker
> docker context use default
> ```
>
> Use the system Docker daemon and add your user to the `docker` group instead.

Verify you are using the system daemon:

```bash
docker context ls
# "default *" should be the active context pointing to unix:///var/run/docker.sock
# If "rootless *" is active, run: docker context use default
```

### 11.7 — Install NVIDIA Container Toolkit + CDI

```bash
# Add NVIDIA CTK repository
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt update
sudo apt install -y nvidia-container-toolkit

# Configure Docker to use NVIDIA runtime
sudo nvidia-ctk runtime configure --runtime=docker

# Generate CDI (Container Device Interface) spec — required for Docker 29+ / CTK 1.17+
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml

# Restart Docker to pick up the new configuration
sudo systemctl restart docker
```

Verify the CDI spec was generated:

```bash
nvidia-ctk cdi list
# Expected output:
#   nvidia.com/gpu=0
#   nvidia.com/gpu=1
#   nvidia.com/gpu=all
```

> **Why CDI?** Docker 29+ uses containerd snapshotter by default, which discovers GPUs via
> CDI spec files in `/etc/cdi/` instead of the legacy `nvidia-container-runtime` hook.
> Without the CDI spec, `--gpus all` and `--device nvidia.com/gpu=all` both fail.
>
> **Regenerate after driver updates**: If you update the NVIDIA driver, re-run
> `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml` to refresh the spec.

### 11.8 — Verify Docker GPU Access

```bash
# CDI device syntax (Docker 29+ with containerd snapshotter)
docker run --rm --device nvidia.com/gpu=all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

This should show the same `nvidia-smi` output inside the container. If it works, GPU passthrough + Docker + NVIDIA CTK + CDI are all functioning.

To access a specific GPU only:

```bash
docker run --rm --device nvidia.com/gpu=0 nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

### 11.9 — Enable MPS for GPU Sharing (Optional)

If you want multiple Docker containers to share the GPU concurrently:

```bash
# Create MPS directories
sudo mkdir -p /tmp/nvidia-mps /tmp/nvidia-mps-log

# Create a systemd service for MPS
sudo tee /etc/systemd/system/nvidia-mps.service > /dev/null <<'EOF'
[Unit]
Description=NVIDIA CUDA MPS Control Daemon
After=nvidia-persistenced.service

[Service]
Type=forking
Environment="CUDA_MPS_PIPE_DIRECTORY=/tmp/nvidia-mps"
Environment="CUDA_MPS_LOG_DIRECTORY=/tmp/nvidia-mps-log"
ExecStart=/usr/bin/nvidia-cuda-mps-control -d
ExecStop=/bin/sh -c 'echo quit | /usr/bin/nvidia-cuda-mps-control'
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now nvidia-mps

# Verify MPS is running
echo "get_server_list" | nvidia-cuda-mps-control
```

### 11.10 — Enable NVIDIA Persistence Mode

Keeps the GPU initialized even when no processes are using it (faster cold-start for containers):

```bash
sudo nvidia-smi -pm 1

# Make persistent across reboots
sudo tee /etc/systemd/system/nvidia-persistenced.service > /dev/null <<'EOF'
[Unit]
Description=NVIDIA Persistence Daemon
Wants=syslog.target

[Service]
Type=forking
ExecStart=/usr/bin/nvidia-persistenced --user root
ExecStopPost=/bin/rm -rf /var/run/nvidia-persistenced

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now nvidia-persistenced
```

---

## 12. Networking Between VMs

All VMs are on the same bridge (`vmbr0`) and can communicate via their static IPs:

| VM | Hostname | IP | Ports |
|----|----------|-----|-------|
| ai-primary | ai-primary.local | 192.168.1.101 | 8861 (STT), 8862 (SMR), 8864 (NLP), 8868 (API), 5174 (Admin), 5175 (Playground) |
| ai-secondary | ai-secondary.local | 192.168.1.102 | 8861, 8864 (backup services) |
| database | database.local | 192.168.1.103 | 5432 (PostgreSQL), 6379 (Redis), 9000/9001 (MinIO), 6333/6334 (Qdrant) |
| monitoring | monitoring.local | 192.168.1.104 | 9090 (Prometheus), 3000 (Grafana) |

### Set Up /etc/hosts on Each VM

```bash
# Add to /etc/hosts on all VMs
cat >> /etc/hosts <<'EOF'
192.168.1.100  pve-hope pve-hope.local
192.168.1.101  ai-primary ai-primary.local
192.168.1.102  ai-secondary ai-secondary.local
192.168.1.103  database database.local
192.168.1.104  monitoring monitoring.local
EOF
```

### HOPE Service Configuration

When deploying HOPE services, point them to the database VM:

```env
# .env on ai-primary and ai-secondary
DATABASE_URL=postgresql://postgres:postgres@database.local:5432/hope
REDIS_URL=redis://:redis_password@database.local:6379
MINIO_ENDPOINT=http://database.local:9000
QDRANT_URL=http://database.local:6333
```

---

## 13. Verification Checklist

Run through this checklist after completing all steps:

### Proxmox Host

```bash
# IOMMU active
dmesg | grep -e DMAR -e IOMMU | head -5

# GPUs bound to vfio-pci
lspci -nnk | grep -A 2 "NVIDIA"

# All VMs visible
qm list
```

### GPU VMs (run inside each)

```bash
# GPU visible
nvidia-smi

# CUDA working
nvcc --version

# Verify using system Docker (not rootless)
docker context ls
# "default *" should be active

# CDI spec present
nvidia-ctk cdi list
# Should show nvidia.com/gpu=0, nvidia.com/gpu=1, nvidia.com/gpu=all

# Docker GPU access (CDI device syntax)
docker run --rm --device nvidia.com/gpu=all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi

# MPS running (if enabled)
echo "get_server_list" | nvidia-cuda-mps-control

# Network connectivity to database
ping -c 3 database.local
```

### Database VM

```bash
# Docker running
docker ps

# PostgreSQL accessible from GPU VMs
# (run from ai-primary)
psql -h database.local -U postgres -c "SELECT version();"
```

---

## 14. Troubleshooting

### GPU Not Visible in VM

**Symptom**: `lspci | grep -i nvidia` shows nothing inside the VM.

**Fix**:
1. Verify VFIO claimed the GPU on host: `lspci -nnk | grep -A 3 nvidia`
2. Check VM config has the PCI device: `cat /etc/pve/qemu-server/100.conf | grep hostpci`
3. Ensure Machine type is `q35` and BIOS is `OVMF`
4. Check IOMMU groups — GPU must be in its own group

### "IOMMU Not Detected" After Reboot

**Symptom**: `dmesg | grep IOMMU` shows nothing.

**Fix**:
1. Re-enter BIOS (F2) and verify **VT for Direct I/O** is **Enabled**
2. Check GRUB: `cat /proc/cmdline` should contain `intel_iommu=on`
3. If not, re-run `update-grub` and verify `/etc/default/grub`

### "Failed to Initialize NVML" in VM

**Symptom**: `nvidia-smi` fails with NVML error.

**Fix**:
1. Ensure the NVIDIA driver version inside the VM matches the GPU architecture
2. Try `sudo modprobe nvidia` manually
3. Check `dmesg | tail -30` for driver errors
4. Reboot the VM (not just the service)

### Both GPUs in Same IOMMU Group

**Symptom**: Cannot pass GPUs to different VMs.

**Fix** (unlikely to be needed — your GPUs are on separate sockets/buses `4f` and `d5`):
1. Your GPUs are already on different CPU sockets, so this should not happen
2. If it does, add to GRUB: `pcie_acs_override=downstream,multifunction`
   - This is a security trade-off — acceptable for a playground environment

### VM Won't Start — "VFIO Error"

**Symptom**: VM fails to start with VFIO-related error.

**Fix**:
1. Ensure no other VM is using the same GPU
2. Check that `disable_vga=1` is in `/etc/modprobe.d/vfio.conf`
3. Verify the PCI device ID in VM config matches the actual hardware
4. Run `update-initramfs -u -k all` and reboot host

### Docker: "no known GPU vendor found" or "unresolvable CDI devices"

**Symptom**: `docker run --device nvidia.com/gpu=all ...` fails with CDI errors, or `docker run --gpus all ...` fails with "no known GPU vendor found".

**Cause 1 — Docker rootless mode is active**:

The `get.docker.com` install script may also set up Docker rootless. The rootless daemon runs under your user account with a separate socket (`/run/user/1000/docker.sock`) and does NOT read `/etc/docker/daemon.json` or `/etc/cdi/`.

```bash
# Check if rootless is active
docker context ls
# If "rootless *" is the active context:

systemctl --user stop docker
systemctl --user disable docker
docker context use default
```

**Cause 2 — CDI spec not generated**:

Docker 29+ with containerd snapshotter requires a CDI spec file. Without it, Docker cannot discover GPUs.

```bash
# Check if CDI spec exists
ls -la /etc/cdi/nvidia.yaml

# If missing, generate it
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
nvidia-ctk cdi list
sudo systemctl restart docker
```

**Cause 3 — Using legacy `--gpus` flag with Docker 29+**:

The `--gpus all` flag relies on the legacy `nvidia-container-runtime` hook, which Docker 29's containerd snapshotter does not support. Use CDI device syntax instead:

```bash
# Old (broken on Docker 29+):
docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi

# New (CDI):
docker run --rm --device nvidia.com/gpu=all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

### Slow GPU Performance in VM

**Symptom**: GPU benchmarks significantly slower than expected.

**Fix**:
1. Ensure **PCI-Express** is checked in VM PCI device settings
2. Verify CPU type is `host` (not `kvm64`)
3. Check NUMA pinning — GPU and VM should be on the same NUMA node
4. Disable memory ballooning for GPU VMs
5. Enable persistence mode: `nvidia-smi -pm 1`

---

## Summary of IP Addresses and Credentials

| Resource | Address | Default Credentials |
|----------|---------|-------------------|
| Proxmox Web UI | https://192.168.1.100:8006 | root / *your password* |
| AI Primary SSH | ssh hope@192.168.1.101 | *your password/key* |
| AI Secondary SSH | ssh hope@192.168.1.102 | *your password/key* |
| Database SSH | ssh hope@192.168.1.103 | *your password/key* |
| Monitoring SSH | ssh hope@192.168.1.104 | *your password/key* |
| PostgreSQL | database.local:5432 | postgres / postgres |
| Redis | database.local:6379 | redis_password |
| MinIO Console | http://database.local:9001 | minio_admin / minio_admin |
| Grafana | http://monitoring.local:3000 | admin / admin |

---

## What's Next

After completing this guide, proceed with:

1. **Deploy database services** on VM 300 using the existing `infrastructure/docker/docker-compose.yml`
2. **Deploy HOPE AI services** on VM 100 using Docker Compose with GPU support
3. **Deploy monitoring stack** on VM 400 with Prometheus + Grafana + NVIDIA DCGM
4. **Configure reverse proxy** (Nginx/Caddy) on VM 100 for unified access
5. **Set up backups** using Proxmox's built-in backup scheduler (Datacenter > Backup)
