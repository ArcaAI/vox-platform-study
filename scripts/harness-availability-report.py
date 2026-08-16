#!/usr/bin/env python
"""Harness availability-measurement report — TASK-730 Task 4.

Produces the exact measurement the consultation-session-workflow assessment names as decisive
for whether the harness-mandatory end state (design.md D1) holds
(``docs/architecture/consultation-session-workflow/assessment/README.md`` §5, last paragraph):

    "harness 5xx rates, generation latency percentiles, and a Temporal query for duplicate
    harness-doc-{consultationId} executions (which also reveals how often §3.5's overwrite
    actually fires)."

This is a ONE-OFF ops script, not a durable Temporal activity: the measurement is a point-in-time
report an operator runs and reviews, not something that needs to execute inside a workflow or run
repeatedly in-band. It lives under ``scripts/`` rather than ``apps/harness/src/harness/temporal/``
for that reason (see TASK-730 README.md §4 Task 4's own framing).

WHAT THIS SCRIPT DOES NOT DO: it does not run a PromQL query itself (no Prometheus HTTP client
dependency is added to keep this script zero-additional-dependency against the harness/worker
environment). The 5xx-rate and latency-percentile sections print the exact PromQL to paste into
Prometheus/Grafana Explore instead — those numbers come from the EXISTING ``http_*`` metrics
already scraped (``infrastructure/docker/configs/prometheus/prometheus.yml``, job ``harness``;
cluster-side ``arca/hope-v2-deployment``'s ``observability-config.yaml``, same job name), not new
instrumentation.

USAGE (requires a reachable Temporal server — local dev: ``pnpm infra:dev:up`` with the
``temporal`` profile, or ``TEMPORAL_ADDRESS``/``TEMPORAL_NAMESPACE`` pointed at any other instance):

    ~/miniconda3/envs/arcaenv/bin/python scripts/harness-availability-report.py
    ~/miniconda3/envs/arcaenv/bin/python scripts/harness-availability-report.py --since-days 30
    ~/miniconda3/envs/arcaenv/bin/python scripts/harness-availability-report.py --json report.json

NOT RUN as part of TASK-730's execution: local infra (Temporal included) was down in that session
(see the ticket README's Implementation Summary) and there is no cluster/VM Temporal reachable
from it either. This script is authored and syntax-checked only; its output in this ticket's
README is explicitly marked "not run," never fabricated.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone

# Mirrors apps/harness/src/harness/temporal/activities.py:237 / workflows.py:2432 /
# apps/harness/src/harness/api/endpoints/internal.py:75-77 (`_workflow_id`) — the single
# deterministic id pattern every HarnessDocWorkflow start site uses. Do not change this without
# checking all three call sites stay in sync.
WORKFLOW_ID_PREFIX = "harness-doc-"

# PromQL for the two metrics that come from EXISTING http_* series (prometheus_fastapi_instrumentator
# defaults: http_requests_total counter, http_request_duration_seconds histogram), not new
# instrumentation. `service="harness"` is the label every harness http_* series carries per
# infrastructure/docker/configs/prometheus/prometheus.yml's metric_relabel_configs (local dev) and
# the equivalent cluster-side scrape config in arca/hope-v2-deployment.
PROMQL_5XX_RATE = (
    'sum(rate(http_requests_total{service="harness",status=~"5.."}[5m]))'
    ' / clamp_min(sum(rate(http_requests_total{service="harness"}[5m])), 0.001)'
)
PROMQL_LATENCY_P50 = (
    'histogram_quantile(0.50, sum(rate('
    'http_request_duration_seconds_bucket{service="harness"}[5m])) by (le))'
)
PROMQL_LATENCY_P95 = (
    'histogram_quantile(0.95, sum(rate('
    'http_request_duration_seconds_bucket{service="harness"}[5m])) by (le))'
)
PROMQL_LATENCY_P99 = (
    'histogram_quantile(0.99, sum(rate('
    'http_request_duration_seconds_bucket{service="harness"}[5m])) by (le))'
)


@dataclass
class DuplicateExecutionReport:
    workflow_id: str
    consultation_id: str
    execution_count: int
    run_ids: list[str]


async def _list_harness_doc_executions(
    address: str, namespace: str, since_days: int | None
) -> list[tuple[str, str]]:
    """Return (workflow_id, run_id) pairs for every harness-doc-{consultationId} execution.

    Uses Temporal's visibility list API (``Client.list_workflows``) with a ``STARTS_WITH`` filter
    on WorkflowId, per apps/harness's deterministic id pattern. No new Temporal query/search
    attribute is required — this is a plain visibility list filtered client-side.
    """
    from temporalio.client import Client

    client = await Client.connect(address, namespace=namespace)

    query = f'WorkflowId STARTS_WITH "{WORKFLOW_ID_PREFIX}"'
    if since_days is not None:
        start_after = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        query += f' AND StartTime >= "{start_after}"'

    pairs: list[tuple[str, str]] = []
    async for execution in client.list_workflows(query=query):
        pairs.append((execution.id, execution.run_id))
    return pairs


def _duplicate_report(pairs: list[tuple[str, str]]) -> list[DuplicateExecutionReport]:
    by_workflow_id: dict[str, list[str]] = {}
    for workflow_id, run_id in pairs:
        by_workflow_id.setdefault(workflow_id, []).append(run_id)

    reports = []
    for workflow_id, run_ids in by_workflow_id.items():
        if len(run_ids) > 1:
            consultation_id = workflow_id[len(WORKFLOW_ID_PREFIX) :]
            reports.append(
                DuplicateExecutionReport(
                    workflow_id=workflow_id,
                    consultation_id=consultation_id,
                    execution_count=len(run_ids),
                    run_ids=run_ids,
                )
            )
    return sorted(reports, key=lambda r: r.execution_count, reverse=True)


async def run(address: str, namespace: str, since_days: int | None) -> dict:
    pairs = await _list_harness_doc_executions(address, namespace, since_days)
    distinct_workflow_ids = len({wf_id for wf_id, _ in pairs})
    duplicates = _duplicate_report(pairs)

    execution_count_histogram = Counter(len(run_ids) for run_ids in _group(pairs).values())

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "temporal_address": address,
        "temporal_namespace": namespace,
        "since_days": since_days,
        "total_executions_seen": len(pairs),
        "distinct_consultation_workflow_ids": distinct_workflow_ids,
        "workflow_ids_with_multiple_executions": len(duplicates),
        "duplicate_rate": (
            round(len(duplicates) / distinct_workflow_ids, 4) if distinct_workflow_ids else None
        ),
        "execution_count_histogram": dict(sorted(execution_count_histogram.items())),
        "duplicates": [asdict(d) for d in duplicates],
        "note": (
            "A workflow_id with >1 execution is NOT automatically a bug: per "
            "apps/harness/src/harness/temporal/workflows.py's finalize-child comment, "
            "HarnessDocWorkflow has two legitimate start sites for the same "
            "harness-doc-{consultationId} id with Temporal's default ALLOW_DUPLICATE reuse "
            "policy, which only rejects a second start while the FIRST execution is still open. "
            "A second execution after the first completed is routine (a late transcript, or the "
            "loop's finalize child re-running after an earlier legacy-path run). This report "
            "counts executions; it does not itself classify duplicates as harmful vs. routine — "
            "that judgment belongs to whoever reviews this report against real consultation "
            "traffic, per the assessment's framing ('reveals how often the overwrite fires')."
        ),
        "promql_5xx_rate": PROMQL_5XX_RATE,
        "promql_latency_p50": PROMQL_LATENCY_P50,
        "promql_latency_p95": PROMQL_LATENCY_P95,
        "promql_latency_p99": PROMQL_LATENCY_P99,
    }


def _group(pairs: list[tuple[str, str]]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for workflow_id, run_id in pairs:
        out.setdefault(workflow_id, []).append(run_id)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--address",
        default="localhost:7233",
        help="Temporal frontend address (default: localhost:7233, matches "
        "TemporalConfig.address's local-dev default in "
        "apps/harness/src/harness/core/config.py)",
    )
    parser.add_argument("--namespace", default="default", help="Temporal namespace")
    parser.add_argument(
        "--since-days",
        type=int,
        default=None,
        help="Only consider executions started in the last N days (default: no limit)",
    )
    parser.add_argument("--json", metavar="PATH", help="Write the full report as JSON to PATH")
    args = parser.parse_args()

    try:
        report = asyncio.run(run(args.address, args.namespace, args.since_days))
    except Exception as exc:  # noqa: BLE001 - top-level CLI error surface, intentional
        print(f"ERROR: could not reach Temporal at {args.address!r} ({exc!r}).", file=sys.stderr)
        print(
            "This report requires a reachable Temporal server. Local dev: "
            "`pnpm infra:dev:up -- ` with the `temporal` profile "
            "(infrastructure/docker/docker-compose.dev.yml).",
            file=sys.stderr,
        )
        return 1

    print(f"Generated: {report['generated_at']}")
    print(f"Temporal:  {report['temporal_address']} / namespace {report['temporal_namespace']}")
    print(f"Window:    {'last ' + str(report['since_days']) + ' days' if report['since_days'] else 'all history'}")
    print()
    print(f"Total executions seen:               {report['total_executions_seen']}")
    print(f"Distinct consultation workflow ids:  {report['distinct_consultation_workflow_ids']}")
    print(f"Workflow ids with >1 execution:      {report['workflow_ids_with_multiple_executions']}")
    print(f"Duplicate rate:                      {report['duplicate_rate']}")
    print()
    print("Execution-count histogram (executions per workflow_id -> count of workflow_ids):")
    for count, freq in report["execution_count_histogram"].items():
        print(f"  {count} execution(s): {freq} workflow_id(s)")
    print()
    print("5xx rate / latency percentiles come from EXISTING http_* metrics — run these in")
    print("Prometheus/Grafana Explore (job/service label: harness):")
    print(f"  5xx rate:  {report['promql_5xx_rate']}")
    print(f"  p50:       {report['promql_latency_p50']}")
    print(f"  p95:       {report['promql_latency_p95']}")
    print(f"  p99:       {report['promql_latency_p99']}")
    print()
    print(report["note"])

    if args.json:
        with open(args.json, "w") as f:
            json.dump(report, f, indent=2)
        print(f"\nFull report written to {args.json}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
