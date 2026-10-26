#!/usr/bin/env python3
"""
Generate Final Benchmark Latency Table from Concurrency Benchmark Logs.

This script scans benchmark output directories (e.g., ML-Kalari/logs/concurrency_*)
and parses the `vllm_test_output_{N}.txt` files to produce a clean, finalized
latency matrix across concurrency levels.

Usage:
    python generate_final_table.py
    python generate_final_table.py --log-dir logs
    python generate_final_table.py --log-dir logs_without_vad_denoise
    python generate_final_table.py --stat p50 --format markdown
    python generate_final_table.py --output final_table.md
"""

import os
import re
import sys
import glob
import argparse
from typing import Dict, List, Any, Optional


def parse_output_txt(file_path: str) -> Optional[Dict[str, Any]]:
    """Parse a single vllm_test_output_{N}.txt file and extract summary and latency metrics."""
    if not os.path.isfile(file_path):
        return None

    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    data: Dict[str, Any] = {
        "file_path": file_path,
        "concurrency": None,
        "total_requests": None,
        "passed_requests": None,
        "failed_requests": 0,
        "pass_rate_pct": 0.0,
        "chunks_sent": None,
        "transcripts_relayed": None,
        "metrics": {},
    }

    # Extract concurrency
    c_match = re.search(r"Concurrency:\s*(\d+)", content)
    if c_match:
        data["concurrency"] = int(c_match.group(1))
    else:
        # Fallback to folder/file name
        fn_match = re.search(r"concurrency_(\d+)", file_path)
        if fn_match:
            data["concurrency"] = int(fn_match.group(1))

    # Extract request statistics
    tot_match = re.search(r"Total Requests / Sessions\s*:\s*([\d,]+)", content)
    if tot_match:
        data["total_requests"] = int(tot_match.group(1).replace(",", ""))

    passed_match = re.search(r"Passed Requests\s*:\s*([\d,]+)\s*\(([\d\.]+)%\)", content)
    if passed_match:
        data["passed_requests"] = int(passed_match.group(1).replace(",", ""))
        data["pass_rate_pct"] = float(passed_match.group(2))

    failed_match = re.search(r"Failed Requests\s*:\s*([\d,]+)", content)
    if failed_match:
        data["failed_requests"] = int(failed_match.group(1).replace(",", ""))

    chunks_match = re.search(r"Total Audio Chunks Sent\s*:\s*([\d,]+)", content)
    if chunks_match:
        data["chunks_sent"] = int(chunks_match.group(1).replace(",", ""))

    relayed_match = re.search(r"Total Transcripts Relayed\s*:\s*([\d,]+)", content)
    if relayed_match:
        data["transcripts_relayed"] = int(relayed_match.group(1).replace(",", ""))

    # Parse latency metric rows (matches both 3-column [avg, p50, p95] and 5-column [avg, p50, p95, min, max])
    metric_regex_3col = re.compile(
        r"^\s*([0-9]+\.\s*[^0-9\n]+?)\s{2,}(?:[A-Za-z0-9\s&/\-\(\)>]+?)\s+([\d\.]+)\s*ms\s+([\d\.]+)\s*ms\s+([\d\.]+)\s*ms",
        re.MULTILINE,
    )
    metric_regex_5col = re.compile(
        r"^\s*([0-9]+\.\s*[^0-9\n]+?)\s+([\d\.]+)\s*ms\s+([\d\.]+)\s*ms\s+([\d\.]+)\s*ms\s+([\d\.]+)\s*ms\s+([\d\.]+)\s*ms",
        re.MULTILINE,
    )

    matches_5 = list(metric_regex_5col.finditer(content))
    if matches_5:
        for m in matches_5:
            raw_name = m.group(1).strip()
            avg_val, p50_val, p95_val = float(m.group(2)), float(m.group(3)), float(m.group(4))
            min_val, max_val = float(m.group(5)), float(m.group(6))
            std_name = _standardize_metric_name(raw_name)
            data["metrics"][std_name] = {"avg": avg_val, "p50": p50_val, "p95": p95_val, "min": min_val, "max": max_val}
    else:
        for m in metric_regex_3col.finditer(content):
            raw_name = m.group(1).strip()
            avg_val, p50_val, p95_val = float(m.group(2)), float(m.group(3)), float(m.group(4))
            std_name = _standardize_metric_name(raw_name)
            data["metrics"][std_name] = {"avg": avg_val, "p50": p50_val, "p95": p95_val, "min": p50_val, "max": p95_val}

    return data


def _standardize_metric_name(raw_name: str) -> str:
    """Standardize raw pipeline stage strings to unified metric labels."""
    if "HTTP Session Creation" in raw_name:
        return "1. Session Creation (HTTP)"
    elif "WebSocket Connection" in raw_name:
        return "2. WebSocket Handshake"
    elif "Audio Ingress" in raw_name:
        return "3. Ingress & Redis Queue"
    elif "Denoising" in raw_name:
        return "4. RNNoise Denoising"
    elif "VAD" in raw_name:
        return "5. Silero VAD Evaluation"
    elif "Queue Wait" in raw_name:
        return "6. Server Queue Wait"
    elif "vLLM Whisper ASR" in raw_name or "ASR Inference" in raw_name:
        return "7. vLLM Whisper ASR Inference"
    elif "Postprocessing" in raw_name:
        return "8. Postprocessing & Redis Pub"
    elif "Gateway Redis Read" in raw_name or "Gateway & Transit" in raw_name:
        return "9. Gateway Egress to Client"
    elif "Full Latency" in raw_name or "WebSocket Return" in raw_name or "Combo" in raw_name:
        return "10. Full End-to-End Latency"
    return raw_name


def scan_log_directory(log_dir: str) -> List[Dict[str, Any]]:
    """Scan all concurrency_* directories in log_dir and parse output text files."""
    results = []
    concurrency_dirs = glob.glob(os.path.join(log_dir, "concurrency_*"))

    # Also check if files are directly in log_dir
    direct_files = glob.glob(os.path.join(log_dir, "vllm_test_output_*.txt"))
    for f in direct_files:
        parsed = parse_output_txt(f)
        if parsed and parsed.get("concurrency") is not None:
            results.append(parsed)

    for c_dir in concurrency_dirs:
        txt_files = glob.glob(os.path.join(c_dir, "vllm_test_output_*.txt"))
        if not txt_files:
            continue
        parsed = parse_output_txt(txt_files[0])
        if parsed and parsed.get("concurrency") is not None:
            results.append(parsed)

    # Deduplicate by concurrency
    by_c = {}
    for r in results:
        by_c[r["concurrency"]] = r
    results = list(by_c.values())
    results.sort(key=lambda x: x["concurrency"])
    return results


def format_matrix_table(
    results: List[Dict[str, Any]],
    stat_key: str = "p50",
    stat_title: str = "P50 (Median) Latency (ms)",
    as_markdown: bool = True,
) -> str:
    """Build a 2D matrix string: Rows = Services/Metrics, Cols = Concurrencies."""
    if not results:
        return "No benchmark data found."

    concurrencies = [str(r["concurrency"]) for r in results]

    ordered_metrics = [
        "1. Session Creation (HTTP)",
        "2. WebSocket Handshake",
        "3. Ingress & Redis Queue",
        "4. RNNoise Denoising",
        "5. Silero VAD Evaluation",
        "6. Server Queue Wait",
        "7. vLLM Whisper ASR Inference",
        "8. Postprocessing & Redis Pub",
        "9. Gateway Egress to Client",
        "10. Full End-to-End Latency",
    ]

    header_cols = ["concurrency"] + concurrencies
    rows = []

    # Add Latency rows
    for metric in ordered_metrics:
        row = [metric]
        for r in results:
            m_data = r["metrics"].get(metric)
            if m_data and stat_key in m_data:
                val = m_data[stat_key]
                row.append(f"{val:.2f}")
            else:
                row.append("-")
        rows.append(row)

    # Add operational summary rows
    pass_rate_row = ["Pass Rate (%)"]
    for r in results:
        pct = r.get("pass_rate_pct", 0.0)
        pass_rate_row.append(f"{pct:.1f}%")
    rows.append(pass_rate_row)

    relayed_row = ["Transcripts Relayed"]
    for r in results:
        cnt = r.get("transcripts_relayed")
        relayed_row.append(f"{cnt:,}" if cnt is not None else "-")
    rows.append(relayed_row)

    # Calculate column widths
    col_widths = [len(h) for h in header_cols]
    for row in rows:
        for idx, cell in enumerate(row):
            col_widths[idx] = max(col_widths[idx], len(str(cell)))

    lines = []
    title_banner = f"### 📊 Final Latency Matrix: {stat_title}" if as_markdown else f"\n=== {stat_title} ==="
    lines.append(title_banner)

    if as_markdown:
        header_line = "| " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(header_cols)) + " |"
        sep_line = "|:" + ":|:".join("-" * col_widths[i] for i in range(len(header_cols))) + ":|"
        lines.append(header_line)
        lines.append(sep_line)
        for r in rows:
            line = "| " + " | ".join(str(r[i]).ljust(col_widths[i]) if i == 0 else str(r[i]).rjust(col_widths[i]) for i in range(len(r))) + " |"
            lines.append(line)
    else:
        border = "+" + "+".join("-" * (w + 2) for w in col_widths) + "+"
        lines.append(border)
        header_line = "| " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(header_cols)) + " |"
        lines.append(header_line)
        lines.append(border)
        for r in rows:
            line = "| " + " | ".join(str(r[i]).ljust(col_widths[i]) if i == 0 else str(r[i]).rjust(col_widths[i]) for i in range(len(r))) + " |"
            lines.append(line)
        lines.append(border)

    return "\n".join(lines)


def export_csv(results: List[Dict[str, Any]], csv_path: str):
    """
    Export clean, separate tables for each metric and stat into CSV,
    with explicit headers and blank rows (gaps) between every section.
    """
    import csv

    concurrencies = [str(r["concurrency"]) for r in results]
    header = ["concurrency"] + concurrencies

    ordered_metrics = [
        "1. Session Creation (HTTP)",
        "2. WebSocket Handshake",
        "3. Ingress & Redis Queue",
        "4. RNNoise Denoising",
        "5. Silero VAD Evaluation",
        "6. Server Queue Wait",
        "7. vLLM Whisper ASR Inference",
        "8. Postprocessing & Redis Pub",
        "9. Gateway Egress to Client",
        "10. Full End-to-End Latency",
    ]

    stat_sections = [
        ("p50", "TABLE 1: P50 (MEDIAN) LATENCY (ms)"),
        ("p95", "TABLE 2: P95 TAIL LATENCY (ms)"),
        ("avg", "TABLE 3: AVERAGE LATENCY (ms)"),
        ("min", "TABLE 4: MINIMUM LATENCY (ms)"),
        ("max", "TABLE 5: MAXIMUM LATENCY (ms)"),
    ]

    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)

        for stat_key, title in stat_sections:
            # Table Title Banner
            writer.writerow([title] + [""] * len(concurrencies))
            writer.writerow(header)

            for metric in ordered_metrics:
                row = [metric]
                for r in results:
                    m_data = r["metrics"].get(metric)
                    if m_data and stat_key in m_data:
                        row.append(f"{m_data[stat_key]:.2f}")
                    else:
                        row.append("")
                writer.writerow(row)

            # Two blank rows gap between tables
            writer.writerow([])
            writer.writerow([])

        # Table 6: Reliability and Volume
        writer.writerow(["TABLE 6: RELIABILITY & RUN VOLUME"] + [""] * len(concurrencies))
        writer.writerow(["concurrency"] + concurrencies)
        writer.writerow(["Total Requests"] + [str(r.get("total_requests", 0)) for r in results])
        writer.writerow(["Passed Requests"] + [str(r.get("passed_requests", 0)) for r in results])
        writer.writerow(["Failed Requests"] + [str(r.get("failed_requests", 0)) for r in results])
        writer.writerow(["Pass Rate (%)"] + [f"{r.get('pass_rate_pct', 0.0):.1f}%" for r in results])
        writer.writerow(["Total Audio Chunks Sent"] + [f"{r.get('chunks_sent', 0):,}" for r in results])
        writer.writerow(["Total Transcripts Relayed"] + [f"{r.get('transcripts_relayed', 0):,}" for r in results])

    print(f"📁 CSV report exported to: {csv_path}")



def main():
    parser = argparse.ArgumentParser(
        description="Generate final latency breakdown table from benchmark text files."
    )
    parser.add_argument(
        "--log-dir",
        type=str,
        default="/Users/apple/Desktop/vox/ML-Kalari/logs",
        help="Path to logs directory containing concurrency_* folders (default: ML-Kalari/logs)",
    )
    parser.add_argument(
        "--stat",
        type=str,
        default="all",
        choices=["all", "p50", "p95", "avg"],
        help="Latency percentile to display: 'all', 'p50', 'p95', or 'avg'",
    )
    parser.add_argument(
        "--format",
        type=str,
        default="markdown",
        choices=["markdown", "grid", "csv"],
        help="Output display format ('markdown', 'grid', or 'csv')",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Optional file path to save the output report (default: <log_dir>/final_table.md or .csv)",
    )

    args = parser.parse_args()

    log_dir = os.path.abspath(args.log_dir)
    if not os.path.isdir(log_dir):
        print(f"❌ Error: Log directory not found at {log_dir}")
        sys.exit(1)

    results = scan_log_directory(log_dir)
    if not results:
        print(f"⚠️ No concurrency test results found in {log_dir}")
        sys.exit(1)

    dir_label = os.path.basename(log_dir)
    print(f"\n📂 Scanned {len(results)} concurrency test runs from `{log_dir}`:")
    concurrency_list = [str(r["concurrency"]) for r in results]
    print(f"   Available Concurrencies: {', '.join(concurrency_list)}\n")

    report_sections = []

    stats_to_run = (
        [("p50", "P50 (Median) Latency (ms)"), ("p95", "P95 Tail Latency (ms)"), ("avg", "Average Latency (ms)")]
        if args.stat == "all"
        else [(args.stat, f"{args.stat.upper()} Latency (ms)")]
    )

    as_markdown = args.format != "grid"

    for stat_key, stat_title in stats_to_run:
        tbl = format_matrix_table(results, stat_key=stat_key, stat_title=stat_title, as_markdown=as_markdown)
        report_sections.append(tbl)
        print(tbl)
        print("\n" + ("-" * 80) + "\n")

    full_report_text = f"# Final Concurrency Benchmark Report ({dir_label})\n\n" + "\n\n".join(report_sections)

    # Determine default destination if not specified
    if args.output:
        out_path = os.path.abspath(args.output)
    else:
        out_path = os.path.join(log_dir, "final_table.csv" if args.format == "csv" else "final_table.md")

    if out_path.endswith(".csv") or args.format == "csv":
        export_csv(results, out_path)
    else:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(full_report_text + "\n")
        print(f"📄 Markdown report saved to: {out_path}")


if __name__ == "__main__":
    main()
