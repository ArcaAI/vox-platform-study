/**
 * The gateway's own view of the run, taken from `GET /metrics`.
 *
 * The client's view is incomplete by construction: a request that is refused
 * before it reaches a handler, or one whose connection the OS queued, looks the
 * same from outside. Scraping the gateway's Prometheus endpoint before and
 * after gives an independent count that the report cross-checks against — if
 * the client counted 40k requests and the server counted 31k, 9k never arrived
 * and the run is measuring the CLIENT, not the platform.
 *
 * `/metrics` is `@Public()` and excluded from the `api/v1` prefix, so this needs
 * no credential.
 *
 * ## What is NOT here, and why it matters
 *
 * There is **no Prisma / pg pool metric on this endpoint**. TASK-993 §2.10
 * concludes the gateway HPA must be driven by a saturation signal rather than
 * CPU, because pool exhaustion queues requests while CPU stays low — but the
 * pool depth, the acquire wait and the acquire-timeout count are not exported
 * anywhere. So the one number that would settle §2.10 cannot be read, and the
 * harness has to infer pool timeouts from response latency instead
 * (`attribution.ts`). `nodejs_eventloop_lag_p99` is captured below as the
 * closest available proxy: it distinguishes "the event loop is busy" from "the
 * event loop is idle and waiting", which is exactly the distinction the CPU
 * trigger cannot make.
 */

/** The handful of series worth carrying into a capacity report. */
const SERIES_OF_INTEREST = [
  'api_gateway_http_requests_total',
  'api_gateway_nodejs_eventloop_lag_p99_seconds',
  'api_gateway_nodejs_eventloop_lag_max_seconds',
  'api_gateway_nodejs_active_handles_total',
  'api_gateway_nodejs_active_requests_total',
  'api_gateway_active_connections_count',
  'api_gateway_process_resident_memory_bytes',
  'api_gateway_process_cpu_seconds_total',
  'hope_job_active_count',
  'api_gateway_entitlements_meter_check_skipped_total',
  'api_gateway_hope_usage_emission_failed_total',
] as const;

export interface MetricsSnapshot {
  readonly at: number;
  /** `series{labels}` → value, for the series above only. */
  readonly series: Readonly<Record<string, number>>;
  /** HTTP request counts folded down to `status` → total, across every path. */
  readonly requestsByStatus: Readonly<Record<string, number>>;
  readonly error?: string;
}

const EMPTY: Omit<MetricsSnapshot, 'at' | 'error'> = { series: {}, requestsByStatus: {} };

export function parsePrometheus(text: string): Omit<MetricsSnapshot, 'at' | 'error'> {
  const series: Record<string, number> = {};
  const requestsByStatus: Record<string, number> = {};

  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const spaceAt = line.lastIndexOf(' ');
    if (spaceAt < 0) continue;
    const key = line.slice(0, spaceAt);
    const value = Number(line.slice(spaceAt + 1));
    if (!Number.isFinite(value)) continue;

    const name = key.split('{')[0] ?? key;
    if (!SERIES_OF_INTEREST.includes(name as (typeof SERIES_OF_INTEREST)[number])) continue;
    series[key] = value;

    if (name === 'api_gateway_http_requests_total') {
      const status = /status="(\d+)"/.exec(key)?.[1];
      if (status) requestsByStatus[status] = (requestsByStatus[status] ?? 0) + value;
    }
  }
  return { series, requestsByStatus };
}

export async function scrape(baseOrigin: string, timeoutMs = 15_000): Promise<MetricsSnapshot> {
  const url = `${baseOrigin.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '')}/metrics`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { at: Date.now(), ...EMPTY, error: `HTTP ${response.status}` };
    return { at: Date.now(), ...parsePrometheus(await response.text()) };
  } catch (error) {
    return { at: Date.now(), ...EMPTY, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface MetricsDelta {
  /** Server-side request count for the run window, by status. */
  readonly requestsByStatus: Readonly<Record<string, number>>;
  readonly totalRequests: number;
  /** Counters that only grow, differenced. Gauges are reported at their END value. */
  readonly counterDeltas: Readonly<Record<string, number>>;
  readonly endGauges: Readonly<Record<string, number>>;
  readonly note?: string;
}

const GAUGE_PREFIXES = [
  'api_gateway_nodejs_eventloop_lag_p99_seconds',
  'api_gateway_nodejs_eventloop_lag_max_seconds',
  'api_gateway_nodejs_active_handles_total',
  'api_gateway_nodejs_active_requests_total',
  'api_gateway_active_connections_count',
  'api_gateway_process_resident_memory_bytes',
  'hope_job_active_count',
];

export function diff(before: MetricsSnapshot, after: MetricsSnapshot): MetricsDelta {
  if (before.error || after.error) {
    return { requestsByStatus: {}, totalRequests: 0, counterDeltas: {}, endGauges: {}, note: `scrape failed: ${before.error ?? after.error}` };
  }

  const requestsByStatus: Record<string, number> = {};
  for (const [status, value] of Object.entries(after.requestsByStatus)) {
    const delta = value - (before.requestsByStatus[status] ?? 0);
    // A negative delta means the process restarted mid-run and its counters
    // reset — a fact about the RUN, not noise to be clamped away.
    if (delta !== 0) requestsByStatus[status] = delta;
  }

  const counterDeltas: Record<string, number> = {};
  const endGauges: Record<string, number> = {};
  for (const [key, value] of Object.entries(after.series)) {
    const name = key.split('{')[0] ?? key;
    if (GAUGE_PREFIXES.includes(name)) {
      endGauges[key] = value;
    } else {
      const delta = value - (before.series[key] ?? 0);
      if (delta !== 0) counterDeltas[key] = Number(delta.toFixed(3));
    }
  }

  const totalRequests = Object.values(requestsByStatus).reduce((a, b) => a + b, 0);
  const restarted = Object.values(requestsByStatus).some((v) => v < 0);
  return {
    requestsByStatus,
    totalRequests,
    counterDeltas,
    endGauges,
    note: restarted
      ? 'a counter went BACKWARDS — the gateway process restarted during the run; treat every server-side number as unusable'
      : undefined,
  };
}
