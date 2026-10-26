#!/usr/bin/env python3
"""
Comprehensive Latency Decomposition & Component Ablation Model
Calculates:
- Network & Gateway Base Transit: T_net = T_transit(ASR Only)
- Denoise Overhead:               T_denoise = T_transit(No VAD) - T_transit(ASR Only)
- VAD Overhead:                   T_vad = T_transit(Full) - T_transit(No VAD)
- GPU Whisper Decode:             T_asr = Server reported inferenceMs
- Total Wire Return Latency:      T_wire = T_net + T_denoise + T_vad + T_asr
"""

import csv
import glob
import os
import re
import numpy as np

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DIR_FULL = os.path.join(BASE_DIR, "logs")
DIR_NO_VAD = os.path.join(BASE_DIR, "logs_without_vad")
DIR_ASR_ONLY = os.path.join(BASE_DIR, "logs_without_vad_denoise")


def parse_output(folder):
    files = glob.glob(os.path.join(folder, "vllm_test_output_*.txt"))
    res = {}
    for f in files:
        m = re.search(r"vllm_test_output_(\d+)\.txt", os.path.basename(f))
        if not m:
            continue
        c = int(m.group(1))
        with open(f, "r", encoding="utf-8") as fp:
            txt = fp.read()

        def get_val(lbl):
            match = re.search(rf"{re.escape(lbl)}\s+([\d\.]+)\s+ms\s+([\d\.]+)\s+ms\s+([\d\.]+)\s+ms", txt)
            if match:
                return {"avg": float(match.group(1)), "p50": float(match.group(2)), "p95": float(match.group(3))}
            return {"avg": 0.0, "p50": 0.0, "p95": 0.0}

        req = re.search(r"Total Requests / Sessions\s*:\s*(\d+)", txt)
        pas = re.search(r"Passed Requests\s*:\s*(\d+)\s*\(([\d\.]+)%\)", txt)
        rtf = re.search(r"RTF:\s*([\d\.]+)x", txt)
        tp = re.search(r"Responses/sec:\s*([\d\.]+)", txt)

        res[c] = {
            "total_req": int(req.group(1)) if req else c,
            "passed_req": int(pas.group(1)) if pas else c,
            "pass_rate": float(pas.group(2)) if pas else 100.0,
            "rtf": float(rtf.group(1)) if rtf else 1.0,
            "tp": float(tp.group(1)) if tp else 0.0,
            "rtt": get_val("1. WebSocket Return Latency"),
            "asr": get_val("2. Server ASR Inference"),
            "gw": get_val("3. Gateway & Transit Overhead"),
        }
    return res


def main():
    full_data = parse_output(DIR_FULL)
    no_vad_data = parse_output(DIR_NO_VAD)
    asr_only_data = parse_output(DIR_ASR_ONLY)

    all_concs = sorted(list(set(full_data.keys()) | set(no_vad_data.keys()) | set(asr_only_data.keys())))

    rows = []
    for c in all_concs:
        f = full_data.get(c)
        nv = no_vad_data.get(c)
        ao = asr_only_data.get(c)

        # 1. Total Wire RTT (P50)
        rtt_full = f["rtt"]["p50"] if f else None
        rtt_no_vad = nv["rtt"]["p50"] if nv else None
        rtt_asr_only = ao["rtt"]["p50"] if ao else None

        # 2. GPU Whisper Decode (P50)
        asr_inf_full = f["asr"]["p50"] if f else None
        asr_inf_no_vad = nv["asr"]["p50"] if nv else None
        asr_inf_asr_only = ao["asr"]["p50"] if ao else None

        # 3. Transit & Overhead (P50)
        gw_full = f["gw"]["p50"] if f else None
        gw_no_vad = nv["gw"]["p50"] if nv else None
        gw_asr_only = ao["gw"]["p50"] if ao else None

        # Mathematical Decomposition
        # Base network transit = Transit Overhead when both Denoise and VAD are OFF
        t_net = gw_asr_only if gw_asr_only is not None else None

        # Denoise overhead = Transit(No VAD) - Transit(ASR Only)
        t_denoise = None
        if gw_no_vad is not None and gw_asr_only is not None:
            t_denoise = max(0.0, gw_no_vad - gw_asr_only)

        # VAD overhead = Transit(Full) - Transit(No VAD)
        t_vad = None
        if gw_full is not None and gw_no_vad is not None:
            t_vad = max(0.0, gw_full - gw_no_vad)

        # GPU ASR Decode = Direct server GPU execution
        t_asr = asr_inf_full if asr_inf_full is not None else (asr_inf_asr_only if asr_inf_asr_only is not None else None)

        rows.append({
            "concurrency": c,
            "rtt_full": rtt_full,
            "rtt_no_vad": rtt_no_vad,
            "rtt_asr_only": rtt_asr_only,
            "asr_inf_full": asr_inf_full,
            "asr_inf_no_vad": asr_inf_no_vad,
            "asr_inf_asr_only": asr_inf_asr_only,
            "gw_full": gw_full,
            "gw_no_vad": gw_no_vad,
            "gw_asr_only": gw_asr_only,
            "t_net": t_net,
            "t_denoise": t_denoise,
            "t_vad": t_vad,
            "t_asr": t_asr,
            "pass_full": f["pass_rate"] if f else None,
            "pass_no_vad": nv["pass_rate"] if nv else None,
            "pass_asr_only": ao["pass_rate"] if ao else None,
        })

    # Save Detailed CSV comparing all scenarios and all decomposed components
    csv_path = os.path.join(DIR_FULL, "comprehensive_latency_breakdown.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as fp:
        w = csv.writer(fp)
        w.writerow([
            "Concurrency",
            "Scenario 1: Full Pipeline Wire RTT (ms)",
            "Scenario 2: Without VAD Wire RTT (ms)",
            "Scenario 3: Pure ASR Only Wire RTT (ms)",
            "GPU Whisper ASR Decode (ms)",
            "Base Network & Gateway Transit (ms)",
            "Isolated Denoise CPU Latency (ms)",
            "Isolated VAD CPU Latency (ms)",
            "Sum Check: Base+Denoise+VAD+ASR (ms)",
            "Pass Rate Full (%)",
            "Pass Rate Without VAD (%)",
            "Pass Rate Pure ASR (%)",
        ])
        for r in rows:
            sum_check = (
                (r["t_net"] or 0.0) + (r["t_denoise"] or 0.0) + (r["t_vad"] or 0.0) + (r["t_asr"] or 0.0)
                if (r["t_net"] is not None and r["t_denoise"] is not None and r["t_vad"] is not None and r["t_asr"] is not None)
                else ""
            )
            w.writerow([
                f"{r['concurrency']} Clients",
                f"{r['rtt_full']:.2f}" if r["rtt_full"] is not None else "",
                f"{r['rtt_no_vad']:.2f}" if r["rtt_no_vad"] is not None else "",
                f"{r['rtt_asr_only']:.2f}" if r["rtt_asr_only"] is not None else "",
                f"{r['t_asr']:.2f}" if r["t_asr"] is not None else "",
                f"{r['t_net']:.2f}" if r["t_net"] is not None else "",
                f"{r['t_denoise']:.2f}" if r["t_denoise"] is not None else "",
                f"{r['t_vad']:.2f}" if r["t_vad"] is not None else "",
                f"{sum_check:.2f}" if isinstance(sum_check, float) else "",
                f"{r['pass_full']:.1f}%" if r["pass_full"] is not None else "",
                f"{r['pass_no_vad']:.1f}%" if r["pass_no_vad"] is not None else "",
                f"{r['pass_asr_only']:.1f}%" if r["pass_asr_only"] is not None else "",
            ])
    print(f"✅ Detailed comparison CSV generated at: {csv_path}")

    # Print Formatted Table in Console
    print("\n" + "=" * 145)
    print("🔬 COMPREHENSIVE STT LATENCY DECOMPOSITION & COMPONENT ABLATION TABLE (P50)")
    print("=" * 145)
    header = (
        f"{'Concurrency':<12} | "
        f"{'Scenario 1: Full':<17} | "
        f"{'Scenario 2: NoVAD':<18} | "
        f"{'Scenario 3: ASR-only':<21} || "
        f"{'GPU Whisper ASR':<16} | "
        f"{'Base Net Transit':<17} | "
        f"{'Denoise CPU':<12} | "
        f"{'VAD CPU':<10}"
    )
    print(header)
    print("-" * 145)
    for r in rows:
        f_s = f"{r['rtt_full']:.1f} ms" if r["rtt_full"] is not None else "—"
        nv_s = f"{r['rtt_no_vad']:.1f} ms" if r["rtt_no_vad"] is not None else "—"
        ao_s = f"{r['rtt_asr_only']:.1f} ms" if r["rtt_asr_only"] is not None else "—"

        asr_s = f"{r['t_asr']:.1f} ms" if r["t_asr"] is not None else "—"
        net_s = f"{r['t_net']:.1f} ms" if r["t_net"] is not None else "—"
        den_s = f"{r['t_denoise']:.1f} ms" if r["t_denoise"] is not None else "—"
        vad_s = f"{r['t_vad']:.1f} ms" if r["t_vad"] is not None else "—"

        print(
            f"{r['concurrency']:<2} Clients   | "
            f"{f_s:<17} | "
            f"{nv_s:<18} | "
            f"{ao_s:<21} || "
            f"{asr_s:<16} | "
            f"{net_s:<17} | "
            f"{den_s:<12} | "
            f"{vad_s:<10}"
        )
    print("=" * 145)


if __name__ == "__main__":
    main()
