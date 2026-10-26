# Remote GPU Server Access & Passwordless SSH Setup Guide

This guide explains how remote diagnostics (continuous GPU telemetry via `nvidia-smi` and container log collection via Docker) work in the **vLLM STT Streaming Load Test**, and how passwordless SSH is configured between your client machine and the remote GPU server (`192.168.112.2`).

---

## 1. Why Passwordless SSH is Required

When running automated benchmarks with `vllm.py`, the script executes background commands on the remote GPU server:
1. **Background GPU Sampling**: Starts a detached `nvidia-smi` process querying GPU utilization %, VRAM usage, and power draw at 50 ms intervals into `/tmp/gpu_sample_<N>.csv`.
2. **Docker Runtime Logs**: Extracts `docker logs --since <timestamp> vllm-whisper` to isolate the exact ASR inference events for the benchmark.
3. **Telemetry Transfer**: Downloads `gpu_<N>.csv` via `scp` when the workload completes.

### The Problem with Password Prompts
Normally, SSH prompts for a password in the terminal:
```text
nitik@192.168.112.2's password:
```
Because `vllm.py` runs non-interactively using Python's `asyncio` and `subprocess` libraries, it cannot type a password. If SSH were to pause for a password:
* The benchmark would **freeze indefinitely** waiting for user input.
* In automated loops (e.g. `1 → 2 → 4 → 8 → 16 → 32`), unattended runs would fail.

**Passwordless SSH** (Public-Key Authentication) solves this by replacing interactive passwords with cryptographic key authentication, allowing the benchmark to start and stop remote diagnostics seamlessly.

---

## 2. How Public-Key Authentication Works

Passwordless SSH uses an asymmetric cryptographic key pair:

```text
[ Client Machine (Mac) ]                           [ Remote GPU Server (192.168.112.2) ]
~/.ssh/id_ed25519 (Private Key)                   ~/.ssh/authorized_keys (Public Key)
       │                                                              │
       │─── 1. Client connects to server ────────────────────────────>│
       │<── 2. Server sends encrypted challenge based on Public Key ──│
       │─── 3. Client signs challenge with Private Key ──────────────>│
       │<── 4. Server verifies signature -> Access Granted! ──────────│
```

1. **Private Key** (`~/.ssh/id_ed25519`): Stored securely on your client machine. It is secret and never leaves your computer.
2. **Public Key** (`~/.ssh/id_ed25519.pub`): Stored on the remote server inside `/home/nitik/.ssh/authorized_keys`.

When `vllm.py` initiates an SSH or SCP command:
* The remote server verifies that your client possesses the matching private key.
* Once mathematically proven, access is granted **instantly without entering a password**.

---

## 3. Step-by-Step Setup Instructions

If you need to configure passwordless SSH on a new machine or for another developer:

### Step 1: Generate an SSH Key Pair on Your Machine
Open terminal and generate a modern, high-security **ED25519** key pair (press Enter to accept default path and empty passphrase):

```bash
ssh-keygen -t ed25519 -C "vllm-benchmark-client"
```

This generates:
* `~/.ssh/id_ed25519` (Private key)
* `~/.ssh/id_ed25519.pub` (Public key)

### Step 2: Copy Your Public Key to the Remote GPU Server
Use `ssh-copy-id` to install your public key onto the GPU host:

```bash
ssh-copy-id nitik@192.168.112.2
```

> **Note**: You will be asked for the user's SSH password **one time** during this command. It automatically appends your public key to `/home/nitik/.ssh/authorized_keys` on the remote server.

### Step 3: Verify the Passwordless Connection
Verify that SSH can execute commands without prompting for credentials:

```bash
ssh -o BatchMode=yes nitik@192.168.112.2 "echo 'SSH Connection Successful!'"
```

If it prints `SSH Connection Successful!` without prompting for a password, passwordless SSH is working.

---

## 4. Why `vllm.py` Uses `-o BatchMode=yes`

In [vllm.py](file:///Users/apple/Desktop/vox/vllm_load_testing/vllm.py), all SSH and SCP calls include:
```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=no nitik@192.168.112.2 "<command>"
```

* **`-o BatchMode=yes`**: Instructs the SSH client to **never prompt for a password interactively**. If the SSH key authentication succeeds, it executes immediately. If authentication fails, it terminates with an exit code right away instead of hanging the load test process.
* **`-o StrictHostKeyChecking=no`**: Prevents the client from hanging on the interactive `"The authenticity of host ... can't be established. Are you sure you want to continue connecting (yes/no)?"` prompt when connecting for the first time.

---

## 5. Troubleshooting & Permissions

If passwordless SSH fails with `Permission denied (publickey)`:

1. **Check Remote Directory Permissions**:
   SSH is strict about permissions. On the GPU server (`192.168.112.2`):
   ```bash
   chmod 700 ~/.ssh
   chmod 600 ~/.ssh/authorized_keys
   ```

2. **Check Local Private Key Permissions**:
   On your client machine (Mac):
   ```bash
   chmod 700 ~/.ssh
   chmod 600 ~/.ssh/id_ed25519
   ```

3. **Check SSH Agent**:
   Ensure your key is loaded into your local SSH agent:
   ```bash
   ssh-add ~/.ssh/id_ed25519
   ```
