#!/usr/bin/env bash
# GPU Metrics Logger
# Logs GPU Memory (VRAM), Compute Utilization, Temperature, and Power Draw to CSV.

OUTPUT_FILE="${1:-gpu_metrics.csv}"
INTERVAL="${2:-1}"

echo "Starting GPU monitor. Writing metrics to: ${OUTPUT_FILE} (Interval: ${INTERVAL}s)"
echo "Press Ctrl+C to stop."

# Header
echo "Timestamp,GPU_Index,Name,Memory_Used_MiB,Memory_Total_MiB,Memory_Util_Percent,GPU_Compute_Util_Percent,Temperature_C,Power_Draw_W" > "${OUTPUT_FILE}"

while true; do
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    if command -v nvidia-smi &> /dev/null; then
        nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.memory,utilization.gpu,temperature.gpu,power.draw \
            --format=csv,noheader,nounits | while IFS=',' read -r idx name mem_used mem_total mem_util gpu_util temp power; do
            # Trim whitespace
            idx=$(echo "$idx" | xargs)
            name=$(echo "$name" | xargs)
            mem_used=$(echo "$mem_used" | xargs)
            mem_total=$(echo "$mem_total" | xargs)
            mem_util=$(echo "$mem_util" | xargs)
            gpu_util=$(echo "$gpu_util" | xargs)
            temp=$(echo "$temp" | xargs)
            power=$(echo "$power" | xargs)

            echo "${TIMESTAMP},${idx},\"${name}\",${mem_used},${mem_total},${mem_util},${gpu_util},${temp},${power}" >> "${OUTPUT_FILE}"
        done
    else
        # Fallback for systems without nvidia-smi (e.g. testing locally on Apple Silicon)
        echo "${TIMESTAMP},0,\"System\",0,0,0,0,0,0" >> "${OUTPUT_FILE}"
    fi

    sleep "${INTERVAL}"
done
