#!/usr/bin/env python3
"""
Generate individual Grafana dashboard JSON files.

This script copies the existing dashboard JSON files from the project-hope
infrastructure directory to a dedicated manifests/dashboards/ subfolder,
allowing study and modification without affecting the Grafana ConfigMap generation.

It does NOT modify the existing generate.py or the ConfigMap generation.
Usage:
    cd /Users/apple/repos/VOX/review/observability
    python3 dashboards/generate_individual.py

Output:
    review/observability/manifests/dashboards/<dashboard-name>.json
    for each of the available dashboards.
"""

import json
import os
import sys

# Base directories
REPO_ROOT = "/Users/apple/repos/VOX"
SOURCE_DIR = os.path.join(REPO_ROOT, "project-hope", "infrastructure", "grafana", "dashboards")
OUTPUT_DIR = os.path.join(REPO_ROOT, "review", "observability", "manifests", "dashboards")

os.makedirs(OUTPUT_DIR, exist_ok=True)

# Known dashboard filenames to copy
DASHBOARD_FILES = [
    "hope-platform-metrics.json",
    "text-overview.json",
    "consumption.json",
    "agentic-trajectory.json",
    "gpu-vram.json",
    "model-retention.json",
    "optimistic-locking.json",
    "pgbouncer.json",
    "text-cache-friendliness.json",
    "text-resilience.json",
    "text-security.json",
    "harness-temporal.json",
]

print(f"Copying dashboards from: {SOURCE_DIR}")
print(f"Output directory: {OUTPUT_DIR}\n")

copied = 0
for filename in DASHBOARD_FILES:
    source_path = os.path.join(SOURCE_DIR, filename)
    if os.path.exists(source_path):
        # Validate JSON is parseable
        try:
            with open(source_path, 'r') as f:
                dash_data = json.load(f)
            # Copy to output directory
            dest_path = os.path.join(OUTPUT_DIR, filename)
            with open(dest_path, 'w') as f:
                json.dump(dash_data, f, indent=2)
            print(f"  ✓ {filename}")
            copied += 1
        except json.JSONDecodeError as e:
            print(f"  ✗ {filename} - invalid JSON: {e}")
    else:
        print(f"  ! {filename} - not found in {SOURCE_DIR}")

# Also try copying from project-hope-sks if it exists
SKS_DIR = os.path.join(REPO_ROOT, "project-hope-sks", "infrastructure", "grafana", "dashboards")
if os.path.isdir(SKS_DIR):
    print(f"\nAlso checking SKS directory: {SKS_DIR}")
    sks_files = [f for f in os.listdir(SKS_DIR) if f.endswith('.json')]
    for filename in sks_files:
        source_path = os.path.join(SKS_DIR, filename)
        if os.path.exists(source_path):
            try:
                with open(source_path, 'r') as f:
                    dash_data = json.load(f)
                # Only copy if not already copied
                if not os.path.exists(os.path.join(OUTPUT_DIR, filename)):
                    dest_path = os.path.join(OUTPUT_DIR, filename)
                    with open(dest_path, 'w') as f:
                        json.dump(dash_data, f, indent=2)
                    print(f"  ✓ {filename} (from SKS)")
                    copied += 1
                else:
                    print(f"  ~ {filename} (already copied, skipping)")
            except json.JSONDecodeError as e:
                print(f"  ✗ {filename} - invalid JSON: {e}")

# Also try copying from the archive TASK-251 directory
ARCHIVE_DIR = os.path.join(REPO_ROOT, "project-hope", "docs", "archive", "TASK-251-Observability-Stack", "configs", "grafana", "dashboards")
if os.path.isdir(ARCHIVE_DIR):
    print(f"\nAlso checking archive directory: {ARCHIVE_DIR}")
    archive_files = [f for f in os.listdir(ARCHIVE_DIR) if f.endswith('.json')]
    for filename in archive_files:
        source_path = os.path.join(ARCHIVE_DIR, filename)
        if os.path.exists(source_path):
            if not os.path.exists(os.path.join(OUTPUT_DIR, filename)):
                try:
                    with open(source_path, 'r') as f:
                        dash_data = json.load(f)
                    dest_path = os.path.join(OUTPUT_DIR, filename)
                    with open(dest_path, 'w') as f:
                        json.dump(dash_data, f, indent=2)
                    print(f"  ✓ {filename} (from archive)")
                    copied += 1
                except json.JSONDecodeError as e:
                    print(f"  ✗ {filename} - invalid JSON: {e}")
            else:
                print(f"  ~ {filename} (already copied, skipping)")

print(f"\n{'='*60}")
print(f"Total: {copied} dashboard JSON files copied to {OUTPUT_DIR}/")
print(f"{'='*60}")
print("\nNext steps:")
print("  1. Review the JSON files in the manifests/dashboards/ folder")
print("  2. Modify as needed for your Kubernetes environment")
print("  3. Import into Grafana UI or apply via ConfigMap")
