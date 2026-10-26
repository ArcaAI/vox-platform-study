#!/usr/bin/env python3
"""
Quick check script to verify VAD and Denoising status directly from the STT container.
Usage: python3 check_vad_denoise.py
"""

import os
import pty
import select
import sys
import time

SSH_HOST = "192.168.112.2"
SSH_USER = "nitik"
SSH_PASS = "idontknow"

def run_remote_cmd(cmd):
    pid, master_fd = pty.fork()
    if pid == 0:
        os.execlp("ssh", "ssh", "-o", "StrictHostKeyChecking=no", f"{SSH_USER}@{SSH_HOST}", cmd)
    else:
        password_sent = False
        output = []
        start_time = time.time()
        while time.time() - start_time < 15:
            r, _, _ = select.select([master_fd], [], [], 0.4)
            if master_fd in r:
                try:
                    data = os.read(master_fd, 1024)
                    if not data:
                        break
                    output.append(data)
                    text = data.decode("utf-8", errors="replace").lower()
                    if "password:" in text and not password_sent:
                        os.write(master_fd, f"{SSH_PASS}\n".encode())
                        password_sent = True
                except OSError:
                    break
        os.close(master_fd)
        os.waitpid(pid, 0)
        return b"".join(output).decode("utf-8", errors="replace")

if __name__ == "__main__":
    print("\n🔍 Checking STT Docker Container for VAD & Denoiser Status...\n" + "="*70)
    
    # 1. Session creation flags (has_vad, has_denoiser)
    cmd = "docker logs hope-stt 2>&1 | grep -E 'has_vad.*has_denoiser' | tail -n 3"
    res = run_remote_cmd(cmd)
    
    lines = [l for l in res.splitlines() if "has_vad" in l]
    if lines:
        print("✅ Session Status Flag (Live from STT runtime):")
        for line in lines[-2:]:
            print(f"   {line.strip()}")
    else:
        print("⚠️ Could not find session flags in recent logs.")

    print("\n" + "-"*70)
    # 2. Denoiser engine initialization
    cmd_denoise = "docker logs hope-stt 2>&1 | grep -i 'StreamingDenoiser initialized' | tail -n 2"
    res_denoise = run_remote_cmd(cmd_denoise)
    lines_denoise = [l for l in res_denoise.splitlines() if "StreamingDenoiser" in l]
    if lines_denoise:
        print("✅ Denoiser Engine:")
        for line in lines_denoise:
            print(f"   {line.strip()}")

    print("\n" + "-"*70)
    # 3. VAD segmenter configuration
    cmd_vad = "docker logs hope-stt 2>&1 | grep '\"component\": \"VAD\"' | tail -n 1"
    res_vad = run_remote_cmd(cmd_vad)
    lines_vad = [l for l in res_vad.splitlines() if '"component": "VAD"' in l]
    if lines_vad:
        print("✅ VAD Segmenter:")
        for line in lines_vad:
            print(f"   {line.strip()}")
            
    print("="*70 + "\n")
