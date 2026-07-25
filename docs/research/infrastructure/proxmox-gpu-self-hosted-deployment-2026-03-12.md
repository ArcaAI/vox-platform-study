# Sequential Analysis: Self-Hosted Proxmox Deployment with GPU Passthrough

**Date**: 2026-03-12
**Hardware**: Dell Precision 7920 Tower — 2x Intel Xeon Platinum 8168 (96 logical CPUs), 256 GB DDR4 ECC, 2x NVIDIA RTX 2000 Ada Generation 16GB (AD107GL)
**Target**: HOPE Healthcare AI Platform — Playground/Self-Hosted

---

## Question

How should we architect a self-hosted Proxmox deployment for the HOPE platform on a 96-CPU / 256GB RAM / 2x GPU A2000 Ada server, with GPU sharing/passthrough capabilities, using only free/community/open-source software?

---

## Evidence Collection

### Evidence 1: Proxmox VE Licensing & Availability

- **Source**: proxmox.com, pve.proxmox.com wiki
- **Finding**: Proxmox VE is 100% free under AGPL v3. No feature restrictions without subscription. Enterprise subscription (€120–€1,100/yr per socket) adds support tickets and enterprise repo access only. All features are identical between free and paid.
- **Latest versions**: PVE 9.1 (Nov 2025, Debian Trixie 13.2, kernel 6.17.2) and PVE 8.4 (Apr 2025, Debian Bookworm)
- **Confidence**: High (official documentation)

### Evidence 2: GPU Identification — RTX A2000 Ada vs RTX 2000 Ada

- **Source**: NVIDIA product specs, localscore.ai benchmarks
- **Finding**: There are two distinct products:

| Spec | RTX A2000 (Ampere, 2021) | RTX 2000 Ada (Ada Lovelace, 2024) |
|------|--------------------------|-----------------------------------|
| Architecture | Ampere (GA106) | Ada Lovelace (AD107) |
| CUDA Cores | 3,328 | 2,816 |
| VRAM | 6 GB or 12 GB GDDR6 | **16 GB GDDR6 ECC** |
| FP32 | 8.0 TFLOPS | 12.0 TFLOPS |
| Tensor (sparse) | 63.9 TFLOPS | 191.9 TFLOPS (FP8) |
| TDP | 70W | ~70W |

The user's "A2000 Ada" with implied 16GB VRAM is most likely the **RTX 2000 Ada Generation** (AD107, Ada Lovelace). This is significantly better for AI workloads (3x tensor performance, ECC memory).

- **Confidence**: High (hardware specs confirmed)

### Evidence 3: GPU Passthrough on Proxmox

- **Source**: pve.proxmox.com/wiki/PCI_Passthrough, Proxmox forums
- **Finding**: PCI passthrough via VFIO gives near-native GPU performance (95–99%). Each GPU is exclusively assigned to one VM. Both GPUs cannot be shared between VMs without vGPU licensing.
- **Key constraint**: RTX 2000 Ada is NOT on NVIDIA's vGPU qualified list. No SR-IOV, no MIG support.
- **Confidence**: High (official wiki + forum reports)

### Evidence 4: NVIDIA Driver & CUDA — Free Options

- **Source**: NVIDIA developer blog, GitHub nvidia/open-gpu-kernel-modules
- **Finding**: All core NVIDIA software is free:

| Component | License | Cost |
|-----------|---------|------|
| NVIDIA proprietary driver (v595+) | NVIDIA EULA | Free |
| NVIDIA open kernel modules (v595.45.04) | MIT / GPLv2 | Free |
| CUDA Toolkit 13.2 | Free | Free |
| NVIDIA Container Toolkit | Apache 2.0 | Free |
| cuDNN | Free (dev account) | Free |

Open kernel modules are the default since R560, fully support Ada Lovelace, and provide equivalent CUDA performance.

- **Confidence**: High (official NVIDIA sources)

### Evidence 5: vGPU Unlock Community Project

- **Source**: GitHub DualCoder/vgpu_unlock (4,400+ stars)
- **Finding**: Exists and is actively maintained. Uses Frida to spoof PCI device IDs. However:
  - NVIDIA EULA violation
  - Performance degrades after 20 minutes without valid license
  - Healthcare/HIPAA compliance risk
  - RTX 2000 Ada compatibility is unconfirmed
- **Confidence**: High (project exists, legal risk confirmed)

### Evidence 6: Alternative GPU Sharing (No License Required)

- **Source**: NVIDIA MPS docs, Container Toolkit docs
- **Finding**: Multiple free GPU sharing methods exist:

| Method | Isolation | Requires | Works on A2000 Ada |
|--------|-----------|----------|-------------------|
| CUDA_VISIBLE_DEVICES | Application-level | Nothing | Yes |
| MPS (Multi-Process Service) | Thread % + memory limits | Volta+ | Yes |
| Time-slicing (GPU Operator) | None (software interleave) | Kepler+ | Yes |
| Docker --device (CDI) | None | NVIDIA CTK + CDI spec | Yes |

MPS provides the best balance of sharing capability and resource control without licensing.

- **Confidence**: High (official NVIDIA documentation)

### Evidence 7: HOPE Platform GPU Requirements

- **Source**: Codebase exploration (apps/stt, apps/nlp, apps/smr)
- **Finding**:

| Service | GPU Required | CUDA Version | VRAM Estimate |
|---------|-------------|--------------|---------------|
| STT v2 (Whisper/NeMo) | Optional (strong benefit) | 12.1 | 2–6 GB |
| NLP (BERT models) | Optional (2–5x speedup) | 11.0+ | 2–4 GB |
| SMR (Summarization) | No (cloud LLM APIs) | N/A | N/A |
| API Gateway | No | N/A | N/A |

Total GPU VRAM needed per inference stack: ~4–10 GB. Fits within 16 GB per GPU.

- **Confidence**: High (codebase inspection)

### Evidence 8: AI Inference Performance on RTX 2000 Ada

- **Source**: localscore.ai benchmarks
- **Finding**:
  - Llama 3.2 1B: ~168 tok/s
  - Llama 3.1 8B (Q4): ~37.5 tok/s
  - Qwen2.5 14B (Q4): ~20.7 tok/s
  - Whisper: No specific benchmarks, but ONNX Whisper runs well within 4 GB VRAM
  - BERT NLP models: Easily fit in 2–4 GB VRAM
- **Confidence**: Medium (benchmarks from third-party, Whisper extrapolated)

---

## Hypotheses

### Hypothesis A: Full VM Passthrough (1 GPU per VM)

- **Supporting evidence**: E3, E4, E6, E7
- **Contradicting evidence**: None
- **Probability**: 85% (recommended approach)
- **Description**: Assign each GPU to a dedicated VM via VFIO passthrough. Run Docker + NVIDIA Container Toolkit inside each VM. Use MPS within each VM to share the GPU across multiple Docker containers.

### Hypothesis B: LXC Containers with GPU Device Binding

- **Supporting evidence**: E6 (near-native performance), E7 (lower overhead)
- **Contradicting evidence**: E3 (NVML errors when switching), forum reports of fragility
- **Probability**: 10% (viable but riskier)
- **Description**: Install NVIDIA drivers on Proxmox host, bind GPU device nodes into LXC containers. Lower overhead but weaker isolation and more fragile driver management.

### Hypothesis C: vGPU Unlock for GPU Sharing

- **Supporting evidence**: E5 (project exists)
- **Contradicting evidence**: E5 (EULA violation, healthcare compliance risk, unconfirmed Ada support)
- **Probability**: 5% (not recommended)
- **Description**: Use community vgpu_unlock to enable virtual GPU slicing. Rejected due to legal/compliance risk in healthcare production.

---

## Conclusion

**Answer**: Use Proxmox VE 9.1 (free) with full PCI passthrough (VFIO) for both GPUs, one GPU per VM. Install free NVIDIA open kernel modules + CUDA Toolkit + Container Toolkit inside each GPU VM. Use MPS for intra-VM GPU sharing between Docker containers.

**Confidence**: 8/10

**Key Evidence**: Proxmox is fully free (E1), RTX 2000 Ada supports only full passthrough — no vGPU (E3), all NVIDIA software is free (E4), MPS provides GPU sharing within a VM (E6), HOPE services fit within 16 GB VRAM (E7).

---

## Recommended Architecture

### Proxmox VE Installation

| Item | Value |
|------|-------|
| **Version** | Proxmox VE 9.1 |
| **Download** | https://www.proxmox.com/en/downloads/proxmox-virtual-environment/iso/proxmox-ve-9-1-iso-installer |
| **Size** | 1.83 GB ISO |
| **Base OS** | Debian Trixie 13.2 |
| **Kernel** | 6.17.2 |
| **License** | Free (AGPL v3) |
| **Repository** | No-subscription (free, full features) |
| **Cost** | $0 (optional €120/yr Community subscription for enterprise repo) |

### Post-Install: Switch to Free Repository

```bash
# Disable enterprise repo (requires subscription key)
mv /etc/apt/sources.list.d/pve-enterprise.list /etc/apt/sources.list.d/pve-enterprise.list.bak

# Enable no-subscription repo
echo "deb http://download.proxmox.com/debian/pve trixie pve-no-subscription" > \
  /etc/apt/sources.list.d/pve-no-subscription.list

apt update && apt dist-upgrade -y
```

### Enable IOMMU for GPU Passthrough

```bash
# For Intel CPU
sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT="quiet"/GRUB_CMDLINE_LINUX_DEFAULT="quiet intel_iommu=on iommu=pt"/' /etc/default/grub

# For AMD CPU
sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT="quiet"/GRUB_CMDLINE_LINUX_DEFAULT="quiet amd_iommu=on iommu=pt"/' /etc/default/grub

update-grub

# Load VFIO modules
cat >> /etc/modules <<EOF
vfio
vfio_iommu_type1
vfio_pci
EOF

# Blacklist NVIDIA on host (GPUs will be passed to VMs)
cat > /etc/modprobe.d/blacklist-nvidia.conf <<EOF
blacklist nouveau
blacklist nvidia
blacklist nvidia_drm
blacklist nvidia_modeset
EOF

# Bind GPUs to vfio-pci (replace IDs with actual PCI IDs from lspci -nn)
# Example: echo "options vfio-pci ids=10de:XXXX,10de:YYYY" > /etc/modprobe.d/vfio.conf

update-initramfs -u -k all
reboot
```

### VM Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Proxmox VE 9.1 Host                            │
│              96 vCPUs · 256 GB RAM · 2x RTX 2000 Ada                │
│                                                                     │
│  ┌─────────────────────────┐  ┌─────────────────────────┐          │
│  │  VM 1: AI Primary       │  │  VM 2: AI Secondary     │          │
│  │  Ubuntu 24.04 LTS       │  │  Ubuntu 24.04 LTS       │          │
│  │                         │  │                         │          │
│  │  40 vCPUs               │  │  24 vCPUs               │          │
│  │  112 GB RAM             │  │  80 GB RAM              │          │
│  │  GPU: RTX 2000 Ada #1   │  │  GPU: RTX 2000 Ada #2   │          │
│  │  Storage: 300 GB SSD    │  │  Storage: 200 GB SSD    │          │
│  │                         │  │                         │          │
│  │  Docker + NVIDIA CTK    │  │  Docker + NVIDIA CTK    │          │
│  │  + MPS daemon           │  │  + MPS daemon           │          │
│  │                         │  │                         │          │
│  │  Containers:            │  │  Containers:            │          │
│  │  ├─ STT v2 (Whisper)    │  │  ├─ NLP (BERT)          │          │
│  │  ├─ NLP (BERT backup)   │  │  ├─ STT v2 (backup)     │          │
│  │  ├─ API Gateway         │  │  ├─ Ollama (local LLM)  │          │
│  │  ├─ SMR (Summarization) │  │  └─ TTS (if needed)     │          │
│  │  ├─ Admin UI            │  │                         │          │
│  │  └─ UI Playground       │  │                         │          │
│  └─────────────────────────┘  └─────────────────────────┘          │
│                                                                     │
│  ┌─────────────────────────┐  ┌─────────────────────────┐          │
│  │  VM 3: Database         │  │  VM 4: Monitoring       │          │
│  │  Ubuntu 24.04 LTS       │  │  Ubuntu 24.04 LTS       │          │
│  │                         │  │                         │          │
│  │  16 vCPUs               │  │  8 vCPUs                │          │
│  │  32 GB RAM              │  │  16 GB RAM              │          │
│  │  No GPU                 │  │  No GPU                 │          │
│  │  Storage: 500 GB SSD    │  │  Storage: 200 GB SSD    │          │
│  │                         │  │                         │          │
│  │  ├─ PostgreSQL 18       │  │  ├─ Prometheus          │          │
│  │  ├─ Redis 8             │  │  ├─ Grafana             │          │
│  │  ├─ MinIO               │  │  ├─ Loki (logs)         │          │
│  │  └─ Qdrant              │  │  └─ NVIDIA DCGM         │          │
│  └─────────────────────────┘  └─────────────────────────┘          │
│                                                                     │
│  Host Reserve: 8 vCPUs · 16 GB RAM (Proxmox management)            │
└─────────────────────────────────────────────────────────────────────┘
```

### Resource Allocation Summary

| VM | vCPUs | RAM | GPU | Storage | Purpose |
|----|-------|-----|-----|---------|---------|
| **VM 1: AI Primary** | 40 | 112 GB | RTX 2000 Ada #1 | 300 GB | STT, NLP, API, SMR, frontends |
| **VM 2: AI Secondary** | 24 | 80 GB | RTX 2000 Ada #2 | 200 GB | NLP backup, local LLM, batch jobs |
| **VM 3: Database** | 16 | 32 GB | None | 500 GB | PostgreSQL, Redis, MinIO, Qdrant |
| **VM 4: Monitoring** | 8 | 16 GB | None | 200 GB | Prometheus, Grafana, DCGM |
| **Host Reserve** | 8 | 16 GB | None | — | Proxmox management |
| **Total** | **96** | **256 GB** | **2 GPUs** | **1.2 TB** | |

### GPU VM Internal Setup (VM 1 & VM 2)

```bash
# 1. Install NVIDIA open kernel modules
apt install -y linux-headers-$(uname -r) build-essential
apt install -y nvidia-open nvidia-utils-595

# 2. Verify GPU
nvidia-smi

# 3. Install CUDA Toolkit 13.2
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb
dpkg -i cuda-keyring_1.1-1_all.deb
apt update && apt install -y cuda-toolkit-13-2

# 4. Install Docker (system daemon only — do NOT use rootless mode)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# IMPORTANT: If Docker rootless was also installed (e.g. via dockerd-rootless-setuptool),
# disable it to avoid conflicts with GPU/CDI device access:
#   systemctl --user stop docker
#   systemctl --user disable docker
#   docker context use default

# 5. Install NVIDIA Container Toolkit
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update && sudo apt install -y nvidia-container-toolkit

# 6. Configure Docker runtime and generate CDI spec
sudo nvidia-ctk runtime configure --runtime=docker
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
sudo systemctl restart docker

# 7. Verify CDI spec was generated
nvidia-ctk cdi list
# Should show: nvidia.com/gpu=0, nvidia.com/gpu=1, nvidia.com/gpu=all

# 8. Verify Docker GPU access (uses CDI --device syntax, not legacy --gpus)
docker run --rm --device nvidia.com/gpu=all nvidia/cuda:12.6.0-base-ubuntu22.04 nvidia-smi

# 9. Enable MPS for GPU sharing between containers
sudo mkdir -p /tmp/nvidia-mps /tmp/nvidia-mps-log
export CUDA_MPS_PIPE_DIRECTORY=/tmp/nvidia-mps
export CUDA_MPS_LOG_DIRECTORY=/tmp/nvidia-mps-log
nvidia-cuda-mps-control -d
```

> **Docker 29+ / NVIDIA CTK 1.17+ Breaking Change (2026-03)**
>
> Docker 29 with containerd snapshotter uses **CDI (Container Device Interface)** for GPU
> discovery instead of the legacy `nvidia-container-runtime` hook. Two extra steps are required
> compared to older guides:
>
> 1. **Generate CDI spec**: `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`
> 2. **Use `--device` instead of `--gpus`**: `docker run --device nvidia.com/gpu=all ...`
>
> The legacy `--gpus all` flag and `deploy.resources.reservations.devices` in Compose rely on
> the old runtime hook, which Docker 29's containerd snapshotter does not support.
>
> **Rootless Docker Warning**: Docker rootless mode runs a separate daemon that does NOT read
> `/etc/docker/daemon.json` or `/etc/cdi/`. GPU containers will fail with
> `"no known GPU vendor found"` or `"unresolvable CDI devices"`. For GPU VMs, always use the
> system Docker daemon and add your user to the `docker` group instead.

### Docker Compose with GPU (Production)

```yaml
# docker-compose.gpu.yml — for GPU VMs
# Uses CDI device syntax (Docker 29+ / NVIDIA CTK 1.17+)
services:
  stt:
    image: hope-stt:latest
    build:
      context: ./apps/stt
      target: ml-runtime
    devices:
      - nvidia.com/gpu=all
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - CUDA_MPS_PIPE_DIRECTORY=/tmp/nvidia-mps
    volumes:
      - /tmp/nvidia-mps:/tmp/nvidia-mps
    ports:
      - "8861:8861"

  nlp:
    image: hope-nlp:latest
    build:
      context: ./apps/nlp
    devices:
      - nvidia.com/gpu=all
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - CUDA_MPS_PIPE_DIRECTORY=/tmp/nvidia-mps
      - TEXT_CLASSIFIER_USE_GPU=true
      - TOKEN_CLASSIFIER_USE_GPU=true
    volumes:
      - /tmp/nvidia-mps:/tmp/nvidia-mps
    ports:
      - "8864:8864"
```

> **Note**: The `devices: [nvidia.com/gpu=all]` syntax replaces the older
> `deploy.resources.reservations.devices` block. To assign a specific GPU, use
> `nvidia.com/gpu=0` or `nvidia.com/gpu=1`.

---

## NVIDIA Software Stack — All Free, No License Required

| Component | Version | License | Download |
|-----------|---------|---------|----------|
| Proxmox VE | 9.1 | AGPL v3 | https://proxmox.com/en/downloads |
| NVIDIA Open Kernel Modules | 595.45.04 | MIT / GPLv2 | `apt install nvidia-open` |
| CUDA Toolkit | 13.2 | Free | https://developer.nvidia.com/cuda-downloads |
| NVIDIA Container Toolkit | Latest | Apache 2.0 | https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/ |
| cuDNN | Latest | Free (dev account) | https://developer.nvidia.com/cudnn |
| Docker Engine | Latest | Apache 2.0 | https://get.docker.com |
| Ubuntu Server | 24.04 LTS | Free | https://ubuntu.com/download/server |

**Total software licensing cost: $0**

---

## GPU Sharing Strategy Decision Matrix

| Scenario | Method | How |
|----------|--------|-----|
| STT + NLP on same GPU | MPS daemon | Both containers share GPU with thread/memory limits |
| One service at a time | CUDA_VISIBLE_DEVICES | Pin container to GPU 0 or 1 |
| Kubernetes future | Time-slicing via GPU Operator | ConfigMap replicas per GPU |
| Need hardware isolation | Upgrade to A100/H100 (MIG) | Not applicable to A2000 Ada |

### MPS Configuration for HOPE Services

```bash
# Allocate GPU resources per container via MPS
# STT v2: 60% GPU threads, 10 GB memory
echo "set_default_active_thread_percentage 60" | nvidia-cuda-mps-control
echo "set_default_device_pinned_mem_limit 0 10G" | nvidia-cuda-mps-control

# NLP: 40% GPU threads, 4 GB memory
# (Applied per-process via CUDA_MPS_ACTIVE_THREAD_PERCENTAGE env var)
```

---

## vGPU Unlock — Detailed Assessment

### Status: NOT VIABLE for RTX 2000 Ada (Ada Lovelace)

The community vGPU unlock projects (DualCoder/vgpu_unlock, vgpu_unlock-rs, PolloLoco guide) **do not support Ada Lovelace or Ampere GPUs**. This is a hard technical limitation, not just a risk/policy concern.

From the authoritative PolloLoco guide (last updated Feb 2025):

> "If you have GPUs from the Ampere and Ada Lovelace generation, you are out of luck, unless you have a vGPU qualified card from this list like the A5000 or RTX 6000 Ada."
>
> "!!! THIS MEANS THAT YOUR RTX 30XX or 40XX WILL NOT WORK !!!"

#### Supported generations (vgpu_unlock):
- Maxwell 2.0 (GTX 9xx) — except GTX 970
- Pascal (GTX 10xx, Quadro Pxxxx)
- **Turing (GTX 16xx, RTX 20xx, Txxxx)** — best supported

#### NOT supported:
- **Ampere (RTX 30xx, A-series)** — does not work
- **Ada Lovelace (RTX 40xx, RTX 2000 Ada)** — does not work

The RTX 4090 support request (GitHub issue #120) has been open since September 2023 with no resolution. The unlock mechanism relies on PCI device ID spoofing via Frida, and NVIDIA changed the vGPU manager's validation in Ampere+ to prevent this approach.

**Bottom line**: Even for a playground environment, vGPU unlock is not an option for your RTX 2000 Ada cards. It simply does not work on this GPU generation.

---

## What NOT to Use (and Why)

| Option | Reason to Avoid |
|--------|-----------------|
| **vgpu_unlock** | Does NOT work on Ada Lovelace GPUs — hard technical limitation |
| **NVIDIA vGPU license** | RTX 2000 Ada not on qualified list; starts at $250/user/yr for vWS |
| **Nouveau driver** | No CUDA support — useless for AI/ML workloads |
| **LXC GPU passthrough** | Fragile, NVML errors when switching, weaker isolation |
| **Bare metal (no Proxmox)** | Loses VM isolation, snapshot/backup, resource management |

---

## NUMA Optimization (Confirmed Dual-Socket)

**Confirmed hardware**: 2x Intel Xeon Platinum 8168 (24 cores/socket, 48 threads/socket)

```
NUMA Node 0 (Socket 0): CPUs 0-23, 48-71  — GPU #1 at PCI 4f:00.0
NUMA Node 1 (Socket 1): CPUs 24-47, 72-95 — GPU #2 at PCI d5:00.0
```

```bash
# VM 100 (AI Primary) — /etc/pve/qemu-server/100.conf
# Pinned to NUMA node 0, same as GPU #1 (4f:00.0)
cpu: host
numa: 1
sockets: 1
cores: 40

# VM 200 (AI Secondary) — /etc/pve/qemu-server/200.conf
# Pinned to NUMA node 1, same as GPU #2 (d5:00.0)
cpu: host
numa: 1
sockets: 1
cores: 24
```

Each GPU VM is pinned to the NUMA node of its physical GPU, eliminating cross-socket memory latency for GPU DMA operations.

---

## Next Steps

1. **Confirm GPU model**: Run `lspci -nn | grep NVIDIA` on the server to confirm exact PCI device IDs
2. **Confirm CPU topology**: Run `lscpu` to determine socket count, NUMA nodes, and core layout
3. **Install Proxmox VE 9.1** from ISO
4. **Configure IOMMU and VFIO** per the instructions above
5. **Create VMs** per the architecture diagram
6. **Install NVIDIA stack** inside GPU VMs
7. **Deploy HOPE services** via Docker Compose with GPU support
8. **Set up monitoring** with Prometheus + Grafana + NVIDIA DCGM
