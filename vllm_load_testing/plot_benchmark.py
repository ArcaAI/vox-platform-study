#!/usr/bin/env python3
"""
Generate Performance Graphs and Load Scaling Reports from vLLM Benchmark Logs.
Reads logs/vllm_test_output_*.txt, logs/vllm_session_summary_*.csv, and logs/vllm_load_test_*.csv.
Generates:
1. logs/concurrency_vs_latency.png (Dedicated high-res chart: Concurrency vs Latency)
2. logs/vllm_load_test_charts.png (Multi-panel dashboard)
3. logs/benchmark_dashboard.html (Interactive HTML report with live SVG/Canvas chart & tables)
"""

import os
import glob
import re
import json
import numpy as np
import matplotlib.pyplot as plt

LOGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")

def parse_logs():
    """Extract metrics across all concurrency levels."""
    txt_files = glob.glob(os.path.join(LOGS_DIR, "vllm_test_output_*.txt"))
    data = []

    for fpath in txt_files:
        fname = os.path.basename(fpath)
        m = re.search(r"vllm_test_output_(\d+)\.txt", fname)
        if not m:
            continue
        concurrency = int(m.group(1))

        with open(fpath, "r", encoding="utf-8") as f:
            content = f.read()

        req_match = re.search(r"Total Requests / Sessions\s*:\s*(\d+)", content)
        pass_match = re.search(r"Passed Requests\s*:\s*(\d+)\s*\(([\d\.]+)%\)", content)
        fail_match = re.search(r"Failed Requests\s*:\s*(\d+)\s*\(([\d\.]+)%\)", content)
        rtf_match = re.search(r"RTF:\s*([\d\.]+)x", content)
        tp_match = re.search(r"Responses/sec:\s*([\d\.]+)", content)

        total_req = int(req_match.group(1)) if req_match else concurrency
        passed_req = int(pass_match.group(1)) if pass_match else concurrency
        failed_req = int(fail_match.group(1)) if fail_match else 0
        success_rate = float(pass_match.group(2)) if pass_match else 100.0
        rtf = float(rtf_match.group(1)) if rtf_match else 1.0
        throughput = float(tp_match.group(1)) if tp_match else 0.0

        def extract_row(label):
            row_re = re.search(rf"{re.escape(label)}\s+([\d\.]+)\s+ms\s+([\d\.]+)\s+ms\s+([\d\.]+)\s+ms\s+([\d\.]+)\s+ms\s+([\d\.]+)\s+ms", content)
            if row_re:
                return {
                    "avg": float(row_re.group(1)),
                    "p50": float(row_re.group(2)),
                    "p95": float(row_re.group(3)),
                    "min": float(row_re.group(4)),
                    "max": float(row_re.group(5)),
                }
            return {"avg": 0, "p50": 0, "p95": 0, "min": 0, "max": 0}

        rtt = extract_row("1. WebSocket Return Latency")
        asr = extract_row("2. Server ASR Inference")
        gw = extract_row("3. Gateway & Transit Overhead")

        data.append({
            "concurrency": concurrency,
            "total_req": total_req,
            "passed_req": passed_req,
            "failed_req": failed_req,
            "success_rate": success_rate,
            "rtf": rtf,
            "throughput": throughput,
            "rtt": rtt,
            "asr": asr,
            "gw": gw,
        })

    data.sort(key=lambda x: x["concurrency"])
    return data

def plot_concurrency_vs_latency(data):
    """Plot focused, large single chart: Concurrency vs Latency."""
    concs = [d["concurrency"] for d in data]
    rtt_p50 = [d["rtt"]["p50"] for d in data]
    rtt_p95 = [d["rtt"]["p95"] for d in data]
    asr_p50 = [d["asr"]["p50"] for d in data]
    gw_p50 = [d["gw"]["p50"] for d in data]

    plt.figure(figsize=(12, 7))
    plt.title("vLLM STT Streaming: Concurrency vs Latency", fontsize=16, fontweight="bold", pad=15)

    plt.plot(concs, rtt_p50, marker="o", markersize=8, color="#2563eb", linewidth=2.8, label="WS Return Latency P50 (Median)")
    plt.plot(concs, rtt_p95, marker="s", markersize=7, color="#dc2626", linestyle="--", linewidth=2.0, label="WS Return Latency P95 (Tail)")
    plt.plot(concs, asr_p50, marker="^", markersize=7, color="#059669", linewidth=2.0, label="Server ASR Decode P50")
    plt.plot(concs, gw_p50, marker="d", markersize=7, color="#d97706", linewidth=2.0, label="Gateway Overhead P50")

    # Annotate P50 latency numbers on points
    for c, y in zip(concs, rtt_p50):
        label = f"{y:.1f}ms" if y < 1000 else f"{y/1000:.1f}s"
        plt.annotate(
            label,
            (c, y),
            textcoords="offset points",
            xytext=(0, 10),
            ha="center",
            fontsize=9,
            fontweight="bold",
            color="#1e3a8a",
        )

    plt.xscale("log", base=2)
    plt.yscale("log")
    plt.xlabel("Concurrency (Simultaneous Client Streams)", fontsize=12, fontweight="bold", labelpad=10)
    plt.ylabel("Latency in Milliseconds (Log Scale)", fontsize=12, fontweight="bold", labelpad=10)
    plt.xticks(concs, [f"{c}" for c in concs], fontsize=11)
    plt.yticks([50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000],
               ["50ms", "100ms", "200ms", "500ms", "1s", "2s", "5s", "10s", "20s", "30s"], fontsize=10)
    plt.grid(True, which="both", linestyle=":", alpha=0.6)
    plt.legend(loc="upper left", fontsize=11, framealpha=0.95)
    plt.tight_layout()

    out_path = os.path.join(LOGS_DIR, "concurrency_vs_latency.png")
    plt.savefig(out_path, dpi=200)
    plt.close()
    print(f"📊 Focused Concurrency vs Latency graph saved to: {out_path}")

def plot_dashboard_charts(data):
    """Plot multi-panel dashboard chart."""
    concs = [d["concurrency"] for d in data]
    rtt_p50 = [d["rtt"]["p50"] for d in data]
    rtt_p95 = [d["rtt"]["p95"] for d in data]
    asr_p50 = [d["asr"]["p50"] for d in data]
    gw_p50 = [d["gw"]["p50"] for d in data]
    rtf_vals = [d["rtf"] for d in data]
    throughput_vals = [d["throughput"] for d in data]
    pass_counts = [d["passed_req"] for d in data]
    fail_counts = [d["failed_req"] for d in data]
    success_rates = [d["success_rate"] for d in data]

    fig, axs = plt.subplots(2, 2, figsize=(15, 11))
    fig.suptitle("vLLM Real-Time STT Streaming Server Load Scaling Analysis", fontsize=16, fontweight="bold", y=0.98)

    # 1. Latency vs Concurrency
    ax1 = axs[0, 0]
    ax1.plot(concs, rtt_p50, marker="o", color="#2563eb", linewidth=2.5, label="Total WS Return Latency (P50)")
    ax1.plot(concs, rtt_p95, marker="s", color="#dc2626", linestyle="--", linewidth=1.5, label="WS Return Latency (P95)")
    ax1.plot(concs, asr_p50, marker="^", color="#059669", linewidth=2.0, label="Server ASR Inference (P50)")
    ax1.plot(concs, gw_p50, marker="d", color="#d97706", linewidth=2.0, label="Gateway Overhead (P50)")
    ax1.set_xscale("log", base=2)
    ax1.set_yscale("log")
    ax1.set_xlabel("Concurrent Client Streams", fontweight="bold")
    ax1.set_ylabel("Latency in ms (Log Scale)", fontweight="bold")
    ax1.set_title("Concurrency vs Latency Breakdown", fontweight="bold")
    ax1.set_xticks(concs)
    ax1.get_xaxis().set_major_formatter(plt.ScalarFormatter())
    ax1.grid(True, which="both", linestyle=":", alpha=0.6)
    ax1.legend(loc="upper left", framealpha=0.9)

    # 2. Passed vs Failed Requests
    ax2 = axs[0, 1]
    x_indices = np.arange(len(concs))
    bar_width = 0.55
    ax2.bar(x_indices, pass_counts, width=bar_width, label="Passed Requests", color="#10b981", alpha=0.85)
    ax2.bar(x_indices, fail_counts, width=bar_width, bottom=pass_counts, label="Failed Requests", color="#ef4444", alpha=0.85)
    ax2.set_xlabel("Concurrent Client Streams", fontweight="bold")
    ax2.set_ylabel("Total Session Requests", fontweight="bold")
    ax2.set_title("Request Pass / Fail Rate", fontweight="bold")
    ax2.set_xticks(x_indices)
    ax2.set_xticklabels([str(c) for c in concs])
    ax2.grid(True, axis="y", linestyle=":", alpha=0.6)

    ax2_rate = ax2.twinx()
    ax2_rate.plot(x_indices, success_rates, color="#7c3aed", marker="D", linewidth=2.5, label="Success Rate (%)")
    ax2_rate.set_ylabel("Success Rate (%)", color="#7c3aed", fontweight="bold")
    ax2_rate.set_ylim(-5, 110)
    ax2_rate.tick_params(axis="y", labelcolor="#7c3aed")
    h1, l1 = ax2.get_legend_handles_labels()
    h2, l2 = ax2_rate.get_legend_handles_labels()
    ax2.legend(h1 + h2, l1 + l2, loc="center left", framealpha=0.9)

    # 3. Real-Time Factor (RTF)
    ax3 = axs[1, 0]
    ax3.plot(concs, rtf_vals, marker="o", color="#ec4899", linewidth=2.5, label="Observed RTF")
    ax3.axhline(1.0, color="#ef4444", linestyle="--", linewidth=1.5, label="Real-Time Threshold (1.0x)")
    ax3.fill_between(concs, 0, 1.0, color="#10b981", alpha=0.15, label="Real-Time Zone (RTF < 1.0)")
    ax3.fill_between(concs, 1.0, max(rtf_vals) * 1.15, color="#ef4444", alpha=0.1, label="Lag / Backlog Zone (RTF > 1.0)")
    ax3.set_xscale("log", base=2)
    ax3.set_xlabel("Concurrent Client Streams", fontweight="bold")
    ax3.set_ylabel("RTF (Wall Time / Audio Duration)", fontweight="bold")
    ax3.set_title("Real-Time Factor (RTF) vs Load", fontweight="bold")
    ax3.set_xticks(concs)
    ax3.get_xaxis().set_major_formatter(plt.ScalarFormatter())
    ax3.grid(True, linestyle=":", alpha=0.6)
    ax3.legend(loc="upper left", framealpha=0.9)

    # 4. Throughput
    ax4 = axs[1, 1]
    ax4.plot(concs, throughput_vals, marker="s", color="#06b6d4", linewidth=2.5, label="Relayed Transcripts / sec")
    ax4.set_xscale("log", base=2)
    ax4.set_xlabel("Concurrent Client Streams", fontweight="bold")
    ax4.set_ylabel("Throughput (Responses / sec)", fontweight="bold")
    ax4.set_title("Server Response Throughput vs Load", fontweight="bold")
    ax4.set_xticks(concs)
    ax4.get_xaxis().set_major_formatter(plt.ScalarFormatter())
    ax4.grid(True, linestyle=":", alpha=0.6)
    ax4.legend(loc="upper left", framealpha=0.9)

    plt.tight_layout(rect=[0, 0.03, 1, 0.95])
    chart_path = os.path.join(LOGS_DIR, "vllm_load_test_charts.png")
    plt.savefig(chart_path, dpi=200)
    plt.close()
    print(f"📊 Multi-panel dashboard saved to: {chart_path}")

def print_ascii_chart(data):
    """Print an ASCII chart of Concurrency vs Latency directly in terminal."""
    print("\n" + "=" * 80)
    print("📈 CONCURRENCY vs LATENCY (P50 WS Round-Trip Time)")
    print("=" * 80)
    max_val = max(d["rtt"]["p50"] for d in data)
    bar_width = 45

    for d in data:
        c = d["concurrency"]
        ms = d["rtt"]["p50"]
        bar_len = int((ms / max_val) * bar_width) if max_val > 0 else 0
        bar = "█" * max(1, bar_len)
        latency_str = f"{ms:.1f} ms" if ms < 1000 else f"{ms/1000:.2f} s"
        print(f"Concurrency {c:>2} │ {bar:<{bar_width}} │ {latency_str}")
    print("=" * 80 + "\n")

def generate_html_report(data):
    """Generate standalone HTML report with interactive Chart.js canvas graph."""
    html_path = os.path.join(LOGS_DIR, "benchmark_dashboard.html")
    
    concs_json = json.dumps([f"{d['concurrency']} Clients" for d in data])
    rtt_p50_json = json.dumps([round(d["rtt"]["p50"], 1) for d in data])
    rtt_p95_json = json.dumps([round(d["rtt"]["p95"], 1) for d in data])
    asr_p50_json = json.dumps([round(d["asr"]["p50"], 1) for d in data])
    gw_p50_json = json.dumps([round(d["gw"]["p50"], 1) for d in data])

    rows = []
    for d in data:
        status_badge = f'<span style="color:#10b981;font-weight:bold;">{d["success_rate"]}% ({d["passed_req"]}/{d["total_req"]})</span>' if d["failed_req"] == 0 else f'<span style="color:#ef4444;font-weight:bold;">{d["success_rate"]}% ({d["passed_req"]}/{d["total_req"]})</span>'
        rtf_color = "#10b981" if d["rtf"] <= 1.05 else ("#f59e0b" if d["rtf"] <= 1.3 else "#ef4444")
        rows.append(f"""
        <tr>
            <td style="font-weight:bold;">{d['concurrency']} Clients</td>
            <td>{status_badge}</td>
            <td>{d['rtt']['p50']:.1f} ms</td>
            <td>{d['rtt']['p95']:.1f} ms</td>
            <td>{d['asr']['p50']:.1f} ms</td>
            <td>{d['gw']['p50']:.1f} ms</td>
            <td style="color:{rtf_color};font-weight:bold;">{d['rtf']:.3f}x</td>
            <td>{d['throughput']:.1f} resp/s</td>
        </tr>
        """)

    html_content = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>vLLM STT Streaming Load Test Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }}
        .container {{ max-width: 1200px; margin: 0 auto; }}
        h1 {{ color: #38bdf8; margin-bottom: 8px; }}
        p.subtitle {{ color: #94a3b8; margin-top: 0; margin-bottom: 24px; }}
        .card {{ background: #1e293b; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); }}
        table {{ width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; margin-top: 12px; }}
        th {{ background: #334155; color: #38bdf8; padding: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }}
        td {{ padding: 12px; border-bottom: 1px solid #334155; }}
        tr:hover td {{ background: #243248; }}
        .chart-box {{ position: relative; height: 420px; width: 100%; margin-top: 15px; }}
        img.chart {{ width: 100%; height: auto; border-radius: 8px; border: 1px solid #334155; margin-top: 15px; }}
        .btn-group {{ margin-top: 10px; margin-bottom: 10px; }}
        button {{ background: #334155; color: #fff; border: 1px solid #475569; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }}
        button.active {{ background: #38bdf8; color: #0f172a; font-weight: bold; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 vLLM Real-Time STT Streaming Load Scaling Dashboard</h1>
        <p class="subtitle">Gateway: <code>http://192.168.112.6:32458</code> | Model: <code>openai/whisper-large-v3-turbo</code> | Engine: <code>vLLM</code></p>
        
        <div class="card">
            <h2>📈 Interactive Graph: Concurrency vs Latency</h2>
            <div class="btn-group">
                <button id="btnLog" class="active" onclick="setScale('logarithmic')">Logarithmic Scale</button>
                <button id="btnLinear" onclick="setScale('linear')">Linear Scale</button>
            </div>
            <div class="chart-box">
                <canvas id="latencyChart"></canvas>
            </div>
        </div>

        <div class="card">
            <h2>📊 Concurrency Benchmark Matrix</h2>
            <table>
                <thead>
                    <tr>
                        <th>Concurrency</th>
                        <th>Pass Rate</th>
                        <th>WS RTT (P50)</th>
                        <th>WS RTT (P95)</th>
                        <th>ASR Decode (P50)</th>
                        <th>Gateway Overhead (P50)</th>
                        <th>RTF</th>
                        <th>Throughput</th>
                    </tr>
                </thead>
                <tbody>
                    {"".join(rows)}
                </tbody>
            </table>
        </div>

        <div class="card">
            <h2>🖼️ Multi-Panel High-Resolution Dashboard</h2>
            <img class="chart" src="vllm_load_test_charts.png" alt="Benchmark Charts">
        </div>
    </div>

    <script>
        const ctx = document.getElementById('latencyChart').getContext('2d');
        const labels = {concs_json};
        
        const chart = new Chart(ctx, {{
            type: 'line',
            data: {{
                labels: labels,
                datasets: [
                    {{
                        label: 'Total WS Return Latency P50',
                        data: {rtt_p50_json},
                        borderColor: '#38bdf8',
                        backgroundColor: '#38bdf8',
                        borderWidth: 3,
                        pointRadius: 6,
                        tension: 0.2
                    }},
                    {{
                        label: 'WS Return Latency P95 (Tail)',
                        data: {rtt_p95_json},
                        borderColor: '#ef4444',
                        backgroundColor: '#ef4444',
                        borderDash: [5, 5],
                        borderWidth: 2,
                        pointRadius: 5,
                        tension: 0.2
                    }},
                    {{
                        label: 'Server ASR Inference P50',
                        data: {asr_p50_json},
                        borderColor: '#10b981',
                        backgroundColor: '#10b981',
                        borderWidth: 2,
                        pointRadius: 5,
                        tension: 0.2
                    }},
                    {{
                        label: 'Gateway Overhead P50',
                        data: {gw_p50_json},
                        borderColor: '#f59e0b',
                        backgroundColor: '#f59e0b',
                        borderWidth: 2,
                        pointRadius: 5,
                        tension: 0.2
                    }}
                ]
            }},
            options: {{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {{
                    legend: {{ labels: {{ color: '#f8fafc', font: {{ size: 13 }} }} }},
                    tooltip: {{
                        callbacks: {{
                            label: function(context) {{
                                return context.dataset.label + ': ' + context.parsed.y + ' ms';
                            }}
                        }}
                    }}
                }},
                scales: {{
                    x: {{
                        ticks: {{ color: '#cbd5e1', font: {{ weight: 'bold' }} }},
                        grid: {{ color: '#334155' }}
                    }},
                    y: {{
                        type: 'logarithmic',
                        ticks: {{
                            color: '#cbd5e1',
                            callback: function(value) {{
                                if ([50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000].includes(value)) {{
                                    return value < 1000 ? value + 'ms' : (value/1000) + 's';
                                }}
                                return null;
                            }}
                        }},
                        grid: {{ color: '#334155' }}
                    }}
                }}
            }}
        }});

        function setScale(type) {{
            chart.options.scales.y.type = type;
            chart.update();
            document.getElementById('btnLog').classList.toggle('active', type === 'logarithmic');
            document.getElementById('btnLinear').classList.toggle('active', type === 'linear');
        }}
    </script>
</body>
</html>
"""
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_content)
    print(f"🌐 Interactive HTML Dashboard saved to: {html_path}")

def main():
    data = parse_logs()
    if not data:
        print("No log files found in:", LOGS_DIR)
        return

    plot_concurrency_vs_latency(data)
    plot_dashboard_charts(data)
    generate_html_report(data)
    print_ascii_chart(data)

if __name__ == "__main__":
    main()
