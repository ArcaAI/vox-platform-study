#!/usr/bin/env python3
"""
Component Latency Ablation Analyzer & Visualizer
Calculates isolated latencies for ASR, Denoise, and VAD across concurrency levels:
1. Full Pipeline (VAD ON + Denoise ON)         -> from logs/
2. Without VAD (VAD OFF + Denoise ON)           -> from logs_without_vad/
3. Pure ASR Only (VAD OFF + Denoise OFF)        -> from logs_without_vad_denoise/

Formulas:
- ASR Latency     = T(VAD OFF + Denoise OFF)
- Denoise Latency = T(VAD OFF + Denoise ON) - T(VAD OFF + Denoise OFF)
- VAD Latency     = T(VAD ON + Denoise ON)  - T(VAD OFF + Denoise ON)
"""

import csv
import glob
import os
import re
import sys
import numpy as np
import matplotlib.pyplot as plt

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DIR_FULL = os.path.join(BASE_DIR, "logs")
DIR_NO_VAD = os.path.join(BASE_DIR, "logs_without_vad")
DIR_ASR_ONLY = os.path.join(BASE_DIR, "logs_without_vad_denoise")


def parse_output_txt(fpath):
    """Parse metrics from a vllm_test_output_*.txt file."""
    if not os.path.exists(fpath):
        return None

    with open(fpath, "r", encoding="utf-8") as f:
        content = f.read()

    def extract_row(label):
        row_re = re.search(
            rf"{re.escape(label)}\s+([\d\.]+)\s+ms\s+([\d\.]+)\s+ms\s+([\d\.]+)\s+ms\s+([\d\.]+)\s+ms\s+([\d\.]+)\s+ms",
            content,
        )
        if row_re:
            return {
                "avg": float(row_re.group(1)),
                "p50": float(row_re.group(2)),
                "p95": float(row_re.group(3)),
                "min": float(row_re.group(4)),
                "max": float(row_re.group(5)),
            }
        return {"avg": 0.0, "p50": 0.0, "p95": 0.0, "min": 0.0, "max": 0.0}

    req_match = re.search(r"Total Requests / Sessions\s*:\s*(\d+)", content)
    pass_match = re.search(r"Passed Requests\s*:\s*(\d+)\s*\(([\d\.]+)%\)", content)
    rtf_match = re.search(r"RTF:\s*([\d\.]+)x", content)
    tp_match = re.search(r"Responses/sec:\s*([\d\.]+)", content)

    return {
        "total_requests": int(req_match.group(1)) if req_match else 0,
        "passed_requests": int(pass_match.group(1)) if pass_match else 0,
        "pass_rate": float(pass_match.group(2)) if pass_match else 100.0,
        "rtf": float(rtf_match.group(1)) if rtf_match else 1.0,
        "throughput": float(tp_match.group(1)) if tp_match else 0.0,
        "rtt": extract_row("1. WebSocket Return Latency"),
        "asr": extract_row("2. Server ASR Inference"),
        "gw": extract_row("3. Gateway & Transit Overhead"),
    }


def find_concurrencies():
    """Discover all concurrency levels tested across any of the directories."""
    concs = set()
    for d in (DIR_FULL, DIR_NO_VAD, DIR_ASR_ONLY):
        for f in glob.glob(os.path.join(d, "vllm_test_output_*.txt")):
            m = re.search(r"vllm_test_output_(\d+)\.txt", os.path.basename(f))
            if m:
                concs.add(int(m.group(1)))
    return sorted(list(concs))


def main():
    concs = find_concurrencies()
    if not concs:
        print("❌ No benchmark log files found.")
        return

    print("=" * 105)
    print("🔬 SPEECH-TO-TEXT LATENCY ABLATION & COMPONENT BREAKDOWN ANALYSIS")
    print("=" * 105)
    print("Dirs analyzed:")
    print(f"  • Full Pipeline (VAD ON  + Denoise ON ) : {DIR_FULL}")
    print(f"  • Without VAD   (VAD OFF + Denoise ON ) : {DIR_NO_VAD}")
    print(f"  • Pure ASR Only (VAD OFF + Denoise OFF) : {DIR_ASR_ONLY}")
    print("=" * 105)

    comparison_rows = []

    for c in concs:
        d_full = parse_output_txt(os.path.join(DIR_FULL, f"vllm_test_output_{c}.txt"))
        d_no_vad = parse_output_txt(os.path.join(DIR_NO_VAD, f"vllm_test_output_{c}.txt"))
        d_asr = parse_output_txt(os.path.join(DIR_ASR_ONLY, f"vllm_test_output_{c}.txt"))

        # Raw Wire RTT (P50)
        rtt_full = d_full["rtt"]["p50"] if d_full else None
        rtt_no_vad = d_no_vad["rtt"]["p50"] if d_no_vad else None
        rtt_asr = d_asr["rtt"]["p50"] if d_asr else None

        # Server ASR Inference (P50)
        asr_inf_full = d_full["asr"]["p50"] if d_full else None
        asr_inf_no_vad = d_no_vad["asr"]["p50"] if d_no_vad else None
        asr_inf_asr = d_asr["asr"]["p50"] if d_asr else None

        # Transit Overhead (P50)
        gw_full = d_full["gw"]["p50"] if d_full else None
        gw_no_vad = d_no_vad["gw"]["p50"] if d_no_vad else None
        gw_asr = d_asr["gw"]["p50"] if d_asr else None

        # Differential Latency Computations
        calc_asr = rtt_asr if rtt_asr is not None else (asr_inf_full if asr_inf_full is not None else None)
        calc_denoise = None
        calc_vad = None

        if rtt_no_vad is not None and rtt_asr is not None:
            calc_denoise = max(0.0, rtt_no_vad - rtt_asr)

        if rtt_full is not None and rtt_no_vad is not None:
            calc_vad = max(0.0, rtt_full - rtt_no_vad)

        comparison_rows.append({
            "concurrency": c,
            "d_full": d_full,
            "d_no_vad": d_no_vad,
            "d_asr": d_asr,
            "rtt_full": rtt_full,
            "rtt_no_vad": rtt_no_vad,
            "rtt_asr": rtt_asr,
            "calc_asr": calc_asr,
            "calc_denoise": calc_denoise,
            "calc_vad": calc_vad,
        })

    # Unified Master Table requested by user
    print("\n" + "=" * 135)
    print("📊 UNIFIED PIPELINE & COMPONENT LATENCY BREAKDOWN (Median P50)")
    print("=" * 135)
    header = (
        f"{'Concurrency':<14} | "
        f"{'With VAD + Denoise':<20} | "
        f"{'With Only Denoise':<19} | "
        f"{'Without Denoise & VAD':<23} || "
        f"{'Only ASR Latency':<18} | "
        f"{'Only Denoise Latency':<22} | "
        f"{'Only VAD Latency':<18}"
    )
    print(header)
    print("-" * 135)

    for r in comparison_rows:
        f_s = f"{r['rtt_full']:.1f} ms" if r['rtt_full'] is not None else "—"
        nv_s = f"{r['rtt_no_vad']:.1f} ms" if r['rtt_no_vad'] is not None else "—"
        no_both_s = f"{r['rtt_asr']:.1f} ms" if r['rtt_asr'] is not None else "—"

        asr_s = f"{r['calc_asr']:.1f} ms" if r['calc_asr'] is not None else "—"
        den_s = f"{r['calc_denoise']:.1f} ms" if r['calc_denoise'] is not None else "—"
        vad_s = f"{r['calc_vad']:.1f} ms" if r['calc_vad'] is not None else "—"

        c_str = f"{r['concurrency']} Clients"
        row_str = (
            f"{c_str:<14} | "
            f"{f_s:<20} | "
            f"{nv_s:<19} | "
            f"{no_both_s:<23} || "
            f"{asr_s:<18} | "
            f"{den_s:<22} | "
            f"{vad_s:<18}"
        )
        print(row_str)

    print("=" * 135)
    print("📌 Legend & Formulas:")
    print("  • Only ASR Latency     = [Without Denoise & VAD]")
    print("  • Only Denoise Latency = [With Only Denoise] - [Without Denoise & VAD]")
    print("  • Only VAD Latency     = [With VAD + Denoise] - [With Only Denoise]")
    print("=" * 135)

    # 3. Export CSV with exact same column structure
    csv_path = os.path.join(DIR_FULL, "component_ablation_summary.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "Concurrency",
            "With VAD + Denoise",
            "With Only Denoise",
            "Without Denoise & VAD",
            "Only ASR Latency",
            "Only Denoise Latency",
            "Only VAD Latency",
        ])
        for r in comparison_rows:
            writer.writerow([
                f"{r['concurrency']} Clients",
                f"{r['rtt_full']:.1f} ms" if r["rtt_full"] is not None else "",
                f"{r['rtt_no_vad']:.1f} ms" if r["rtt_no_vad"] is not None else "",
                f"{r['rtt_asr']:.1f} ms" if r["rtt_asr"] is not None else "",
                f"{r['calc_asr']:.1f} ms" if r["calc_asr"] is not None else "",
                f"{r['calc_denoise']:.1f} ms" if r["calc_denoise"] is not None else "",
                f"{r['calc_vad']:.1f} ms" if r["calc_vad"] is not None else "",
            ])
    print(f"\n💾 Summary CSV saved to: {csv_path}")

    # Also save a pure numeric version for spreadsheet math
    num_csv_path = os.path.join(DIR_FULL, "component_ablation_numeric.csv")
    with open(num_csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "concurrency",
            "with_vad_denoise_ms",
            "with_only_denoise_ms",
            "without_denoise_vad_ms",
            "only_asr_latency_ms",
            "only_denoise_latency_ms",
            "only_vad_latency_ms",
        ])
        for r in comparison_rows:
            writer.writerow([
                r["concurrency"],
                round(r["rtt_full"], 2) if r["rtt_full"] is not None else "",
                round(r["rtt_no_vad"], 2) if r["rtt_no_vad"] is not None else "",
                round(r["rtt_asr"], 2) if r["rtt_asr"] is not None else "",
                round(r["calc_asr"], 2) if r["calc_asr"] is not None else "",
                round(r["calc_denoise"], 2) if r["calc_denoise"] is not None else "",
                round(r["calc_vad"], 2) if r["calc_vad"] is not None else "",
            ])

    # 4. Generate Plot if at least one complete row exists
    valid_rows = [r for r in comparison_rows if r["rtt_full"] and r["rtt_no_vad"] and r["rtt_asr"]]
    if valid_rows:
        plot_ablation(valid_rows)
    else:
        # Plot partial comparison of what we have
        plot_overview(comparison_rows)


def plot_ablation(valid_rows):
    """Plot stacked breakdown and component curves."""
    concs = [r["concurrency"] for r in valid_rows]
    asr_vals = [r["calc_asr"] for r in valid_rows]
    den_vals = [r["calc_denoise"] for r in valid_rows]
    vad_vals = [r["calc_vad"] for r in valid_rows]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(15, 6))

    # Stacked bar breakdown
    x = np.arange(len(concs))
    width = 0.55

    ax1.bar(x, asr_vals, width, label="Pure ASR Base", color="#2563eb")
    ax1.bar(x, den_vals, width, bottom=asr_vals, label="Denoise Component", color="#d97706")
    bottom_vad = [a + d for a, d in zip(asr_vals, den_vals)]
    ax1.bar(x, vad_vals, width, bottom=bottom_vad, label="VAD Component", color="#10b981")

    ax1.set_title("Latency Composition Breakdown (P50)", fontsize=14, fontweight="bold", pad=12)
    ax1.set_xlabel("Concurrency (Concurrent Clients)", fontsize=11)
    ax1.set_ylabel("Latency (ms)", fontsize=11)
    ax1.set_xticks(x)
    ax1.set_xticklabels([f"{c} Clients" for c in concs])
    ax1.legend(loc="upper left")
    ax1.grid(axis="y", linestyle="--", alpha=0.5)

    # Component Curves
    ax2.plot(concs, asr_vals, marker="o", color="#2563eb", linewidth=2.5, label="ASR Base Latency")
    ax2.plot(concs, den_vals, marker="s", color="#d97706", linewidth=2.2, label="Denoise Latency")
    ax2.plot(concs, vad_vals, marker="^", color="#10b981", linewidth=2.2, label="VAD Latency")

    ax2.set_title("Isolated Component Scaling", fontsize=14, fontweight="bold", pad=12)
    ax2.set_xlabel("Concurrency", fontsize=11)
    ax2.set_ylabel("Latency (ms)", fontsize=11)
    ax2.grid(True, linestyle="--", alpha=0.5)
    ax2.legend(loc="upper left")

    plt.tight_layout()
    chart_path = os.path.join(DIR_FULL, "component_ablation_latency.png")
    plt.savefig(chart_path, dpi=200)
    plt.close()
    print(f"📊 Component ablation chart saved to: {chart_path}\n")


def plot_overview(rows):
    """Plot whatever comparisons are available."""
    fig, ax = plt.subplots(figsize=(12, 6))

    concs = [r["concurrency"] for r in rows]
    full_c = [r["concurrency"] for r in rows if r["rtt_full"]]
    full_v = [r["rtt_full"] for r in rows if r["rtt_full"]]

    no_vad_c = [r["concurrency"] for r in rows if r["rtt_no_vad"]]
    no_vad_v = [r["rtt_no_vad"] for r in rows if r["rtt_no_vad"]]

    asr_c = [r["concurrency"] for r in rows if r["rtt_asr"]]
    asr_v = [r["rtt_asr"] for r in rows if r["rtt_asr"]]

    if full_c:
        ax.plot(full_c, full_v, marker="o", linewidth=2.5, color="#2563eb", label="Full (VAD ON + Denoise ON)")
    if no_vad_c:
        ax.plot(no_vad_c, no_vad_v, marker="s", linewidth=2.2, color="#d97706", label="Without VAD (VAD OFF + Denoise ON)")
    if asr_c:
        ax.plot(asr_c, asr_v, marker="^", linewidth=2.2, color="#10b981", label="Pure ASR (VAD OFF + Denoise OFF)")

    ax.set_title("STT Streaming Pipeline Comparison (Latency P50)", fontsize=14, fontweight="bold", pad=12)
    ax.set_xlabel("Concurrency (Concurrent Streams)", fontsize=11)
    ax.set_ylabel("WebSocket Return Latency P50 (ms)", fontsize=11)
    ax.grid(True, linestyle="--", alpha=0.5)
    ax.legend(loc="upper left")

    plt.tight_layout()
    chart_path = os.path.join(DIR_FULL, "pipeline_comparison_overview.png")
    plt.savefig(chart_path, dpi=200)
    plt.close()
    print(f"📊 Pipeline comparison chart saved to: {chart_path}\n")


if __name__ == "__main__":
    main()
