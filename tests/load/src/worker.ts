/**
 * One shard of virtual users, on its own thread.
 *
 * Sharding is not premature optimisation. At the 10x100 target with the
 * measured per-user rate, the client has to sustain several hundred requests a
 * second while timing each one to the millisecond. A single Node event loop can
 * ISSUE that, but its own scheduling jitter then lands in the p99 — and a run
 * whose tail latency is the client's is worse than no run, because it looks
 * like a platform finding.
 *
 * The worker is deliberately dumb. Credentials, the calibrated screen mix and
 * the per-tenant rate-limit lane are all decided in the MAIN thread and passed
 * in, so a worker never logs in (`auth/login` is 5/min on one shared IP bucket,
 * and workers racing for sessions would lock the harness out of the one route
 * it needs), never probes, and never has to agree with its siblings about
 * anything.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { add, createAggregate, type Aggregate } from './aggregate';
import { groupKeyOf } from './calibrate';
import { issue, type Credential } from './http';
import { pickScreen } from './scenario';
import { advance, lateness, mulberry32, rampOffsetMs, thinkTimeMs } from './thinktime';
import type { BucketLane, HarnessConfig, Screen } from './types';

export interface WorkerInput {
  readonly config: HarnessConfig;
  /** This shard's virtual users, already authenticated. */
  readonly credentials: readonly Credential[];
  /** Index of each credential in the FULL population, so the ramp stays evenly spread across shards. */
  readonly globalIndices: readonly number[];
  readonly totalUsers: number;
  /** `${kind}|${tenantId}` → the screens that group may actually issue, shell steps already folded in. */
  readonly screensByGroup: Readonly<Record<string, readonly Screen[]>>;
  /** tenantId → the lane the probe established for it. Lanes differ per tenant; see lane-probe.ts. */
  readonly laneByTenant: Readonly<Record<string, BucketLane>>;
  readonly t0Ms: number;
  readonly endAtMs: number;
  readonly seed: number;
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

async function runVirtualUser(input: WorkerInput, aggregate: Aggregate, credential: Credential, globalIndex: number): Promise<void> {
  const { config, t0Ms, endAtMs } = input;
  const screens = input.screensByGroup[groupKeyOf(credential.kind, credential.tenantId)] ?? [];
  if (screens.length === 0) return; // calibration found nothing this credential may reach

  const random = mulberry32(input.seed + globalIndex * 7919);
  const lane = input.laneByTenant[credential.tenantId] ?? 'indeterminate';

  const offset = rampOffsetMs(globalIndex, input.totalUsers, config.rampSeconds);
  const state = { dueAtMs: t0Ms + offset };
  await sleep(state.dueAtMs - Date.now());

  while (Date.now() < endAtMs) {
    const dueAtMs = state.dueAtMs;
    const wait = dueAtMs - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() >= endAtMs) break;

    // Evaluated for its own sake: the per-request `scheduleDelayMs` inside
    // `issue` is the number the report uses, and this call documents that the
    // user navigates whether or not it is behind — which is what lets the lag
    // accumulate in `open` mode instead of being quietly absorbed.
    void lateness(state, Date.now());

    const screen = pickScreen(screens, random);

    // CONCURRENT on purpose. A console screen fires its whole TanStack query set
    // on mount, and that burst is what a 60-second fixed window actually sees.
    // Serialising it here would smooth the load and move the breaking point.
    const results = await Promise.all(
      screen.steps.map((step) =>
        issue({
          baseUrl: config.baseUrl,
          credential,
          method: step.method,
          path: step.path,
          routeKey: step.path.split('?')[0],
          body: step.body,
          timeoutMs: config.requestTimeoutMs,
          pgConnectTimeoutMs: config.pgConnectTimeoutMs,
          lane,
          dueAtMs: dueAtMs - t0Ms,
          t0Ms,
        }),
      ),
    );
    for (const result of results) add(aggregate, result.sample);

    advance(state, Date.now(), thinkTimeMs(random, config.thinkMedianMs, config.thinkSigma), config.arrival);
  }
}

async function main(): Promise<void> {
  const input = workerData as WorkerInput;
  const aggregate = createAggregate(input.t0Ms, input.config.durationSeconds + input.config.rampSeconds);

  await Promise.all(input.credentials.map((credential, i) => runVirtualUser(input, aggregate, credential, input.globalIndices[i] ?? i)));

  parentPort?.postMessage(aggregate);
}

void main().then(
  () => undefined,
  (error: unknown) => {
    parentPort?.postMessage({ __error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  },
);
