/**
 * ENTRY POINT 2 — drive N tenants x M users and report which ceiling bound.
 *
 *     pnpm load:run                                   # whatever fixture is available
 *     LOAD_TENANTS=10 LOAD_USERS=100 pnpm load:run     # the TASK-993 target
 *     LOAD_ARRIVAL=open LOAD_DURATION=180 pnpm load:run
 *
 * ## Population
 *
 * Prefers `tests/load/results/fixture.json`, the manifest
 * `fixture/seed-load-fixture.ts` writes. Without it the run falls back to the
 * credentials the ordinary dev seed already provides — two tenants, a handful
 * of users — and says so in every place a reader might otherwise take the run
 * for the 10x100 target. A smoke run is useful; a smoke run MISLABELLED as a
 * capacity run is worse than nothing.
 *
 * ## Ordering, and why it is this way
 *
 * 1. credentials, in the MAIN thread — `auth/login` is 5/min on an IP-keyed
 *    bucket, so acquisition has to be paced and centralised or the harness
 *    locks itself out before it starts.
 * 2. the lane probe, BEFORE the load — it reads live counters, and running it
 *    against counters the load is already moving makes it meaningless.
 * 3. a `/metrics` scrape, to bracket the run with the server's own count.
 * 4. the load.
 * 5. a second scrape, and the report.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createAggregate, mergeAggregate, type Aggregate } from './aggregate';
import { allowedShellSteps, applyCalibration, calibrate, groupKeyOf, type Calibration } from './calibrate';
import { acquire, CredentialError, type PrincipalSpec, type SessionStrategy } from './credentials';
import type { Credential } from './http';
import { diff, scrape, type MetricsSnapshot } from './metrics-probe';
import { probeLanes, type LaneReport } from './lane-probe';
import { render, toSerializable, type RunReport } from './report';
import { CONSOLE_SCREENS, MACHINE_SCREENS, SHELL_STEPS, staticFallbackProfile, type SessionProfile } from './scenario';
import type { BucketLane, HarnessConfig, Screen } from './types';
import type { WorkerInput } from './worker';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(HERE, '..', 'results');

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number; got ${JSON.stringify(raw)}`);
  return value;
}

function readConfig(): HarnessConfig {
  return {
    baseUrl: process.env.LOAD_BASE_URL ?? 'http://localhost:8868/api/v1',
    tenants: envInt('LOAD_TENANTS', 10),
    usersPerTenant: envInt('LOAD_USERS', 100),
    apiKeysPerTenant: envInt('LOAD_API_KEYS', 2),
    serviceAccountsPerTenant: envInt('LOAD_SERVICE_ACCOUNTS', 1),
    durationSeconds: envInt('LOAD_DURATION', 120),
    rampSeconds: envInt('LOAD_RAMP', 30),
    thinkMedianMs: envInt('LOAD_THINK_MS', 4_000),
    thinkSigma: Number(process.env.LOAD_THINK_SIGMA ?? 0.6),
    arrival: (process.env.LOAD_ARRIVAL as 'closed' | 'open') ?? 'closed',
    workers: envInt('LOAD_WORKERS', Math.max(2, Math.min(8, cpus().length - 1))),
    requestTimeoutMs: envInt('LOAD_REQUEST_TIMEOUT_MS', 30_000),
    pgConnectTimeoutMs: envInt('LOAD_PG_CONNECT_TIMEOUT_MS', 5_000),
    scrapeMetrics: process.env.LOAD_SCRAPE_METRICS !== '0',
    calibrate: process.env.LOAD_CALIBRATE !== '0',
    // The probes and the calibration spend real budget on live counters.
    // Starting the timed run immediately would begin it with a partly-spent
    // bucket and corrupt "how much fit before the first refusal" — the single
    // most useful number the run produces.
    cooldownSeconds: envInt('LOAD_COOLDOWN_S', 65),
  };
}

// ── population ─────────────────────────────────────────────────────────────

/** The manifest `fixture/seed-load-fixture.ts` writes. Kept in one place so the two cannot drift. */
export interface FixtureManifest {
  readonly generatedAt: string;
  readonly password: string;
  readonly tenants: ReadonlyArray<{
    readonly id: string;
    readonly key: string;
    readonly plan: string;
    readonly users: ReadonlyArray<{ readonly username: string }>;
    readonly apiKeys: readonly string[];
    readonly serviceAccounts: ReadonlyArray<{ readonly clientId: string; readonly clientSecret: string }>;
  }>;
}

/**
 * Credentials the ORDINARY dev seed already provides.
 *
 * Two tenants, so the lane probe still has the two it needs; nowhere near the
 * 10x100 target, which is the whole reason the fixture script exists.
 */
const SEEDED_FALLBACK: FixtureManifest = {
  generatedAt: 'dev seed',
  password: 'password123',
  tenants: [
    {
      id: '50000000-0000-0000-0000-000000000000',
      key: '__GLOBAL__',
      plan: 'null (→ STARTER)',
      // `tenant_admin` first: the measured route mix is an admin console's, and a
      // clinician reaches almost none of it. Calibration drops what the rest
      // cannot see, but leading with the admin keeps a 1-user smoke run useful.
      users: [
        { username: 'tenant_admin' },
        { username: 'doctor' },
        { username: 'doctor2' },
        { username: 'department_head' },
        { username: 'nurse' },
        { username: 'senior_nurse' },
      ],
      apiKeys: ['hope_sk_test_a5c5e56x54c4437fbd6ce7dee9_631238', 'hope_sk_test_b7d8f67y65d5548gce8df8eef0_742349'],
      serviceAccounts: [],
    },
    {
      id: '50000000-0000-0000-0000-000000000001',
      key: 'ARCAAI',
      plan: 'ENTERPRISE',
      users: [],
      apiKeys: ['hope_sk_test_e0g1i90b98g8871jfh1gi1hhi3_075682', 'hope_ig_test_h3j4l23e21j1104mik4jl4kkl6_308915'],
      serviceAccounts: [
        {
          clientId: 'hope_svc_a4ca1a11ad3141b0c0de0001',
          clientSecret: 'hope_svcsec_test_4f0b1d7a2e6c48b39a15d0c7e2f83b6104d9a7c5e18f2b6039d4c8a71e0b5f2d',
        },
      ],
    },
  ],
};

function loadFixture(warnings: string[]): FixtureManifest {
  const path = resolve(RESULTS_DIR, 'fixture.json');
  if (!existsSync(path)) {
    warnings.push(
      'NO LOAD FIXTURE. Falling back to the credentials the ordinary dev seed provides — 2 tenants, ' +
        'a handful of users. This run CANNOT speak to the 10x100 target. Provision one with `pnpm load:seed` (see tests/load/README.md).',
    );
    return SEEDED_FALLBACK;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureManifest;
}

/** Expand the manifest into the principals this run will actually drive, capped by the config. */
function buildPrincipals(config: HarnessConfig, fixture: FixtureManifest, warnings: string[]): PrincipalSpec[] {
  const specs: PrincipalSpec[] = [];
  const tenants = fixture.tenants.slice(0, config.tenants);

  if (tenants.length < config.tenants) {
    warnings.push(`asked for ${config.tenants} tenants, fixture has ${tenants.length}`);
  }

  for (const tenant of tenants) {
    const users = tenant.users.slice(0, config.usersPerTenant);
    if (users.length < config.usersPerTenant) {
      warnings.push(`tenant ${tenant.key}: asked for ${config.usersPerTenant} users, fixture has ${users.length}`);
    }
    for (const user of users) {
      specs.push({
        kind: 'human',
        tenantId: tenant.id,
        label: `${tenant.key}/${user.username}`,
        username: user.username,
        password: fixture.password,
        tenantKey: tenant.key,
      });
    }
    for (const key of tenant.apiKeys.slice(0, config.apiKeysPerTenant)) {
      specs.push({ kind: 'api_key', tenantId: tenant.id, label: `${tenant.key}/apikey`, apiKey: key });
    }
    for (const account of tenant.serviceAccounts.slice(0, config.serviceAccountsPerTenant)) {
      specs.push({
        kind: 'service_account',
        tenantId: tenant.id,
        label: `${tenant.key}/svc`,
        clientId: account.clientId,
        clientSecret: account.clientSecret,
      });
    }
  }
  return specs;
}

/**
 * Turn specs into live credentials.
 *
 * `reuse` (the default) logs in ONCE per tenant and shares that session across
 * that tenant's virtual users. That is sound for the CURRENT platform because
 * ranks 1-3 key the bucket `t:<tenantId>` with no principal component — but it
 * cannot exercise the per-principal bucket OD-2 proposes, so `LOAD_SESSIONS=distinct`
 * exists and the choice is printed in the report.
 */
async function acquireAll(
  config: HarnessConfig,
  specs: readonly PrincipalSpec[],
  strategy: SessionStrategy,
  warnings: string[],
): Promise<Credential[]> {
  const ctx = { baseUrl: config.baseUrl, timeoutMs: config.requestTimeoutMs, pgConnectTimeoutMs: config.pgConnectTimeoutMs, t0Ms: Date.now() };
  const credentials: Credential[] = [];
  const humanSessionByTenant = new Map<string, Credential>();
  let logins = 0;

  for (const spec of specs) {
    if (spec.kind === 'human' && strategy === 'reuse') {
      const existing = humanSessionByTenant.get(spec.tenantId);
      if (existing) {
        credentials.push({ ...existing, label: spec.label });
        continue;
      }
    }
    try {
      if (spec.kind === 'human') {
        logins += 1;
        // `auth/login` is 5/min on ONE shared IP bucket. 13 s between logins keeps
        // a `distinct` run legal; `reuse` pays it once per tenant and barely notices.
        if (logins > 1) await new Promise((r) => setTimeout(r, strategy === 'distinct' ? 13_000 : 500));
      }
      const credential = await acquire(ctx, spec);
      credentials.push(credential);
      if (spec.kind === 'human' && strategy === 'reuse') humanSessionByTenant.set(spec.tenantId, credential);
    } catch (error) {
      const reason = error instanceof CredentialError ? `${error.message}` : String(error);
      warnings.push(`could not acquire ${spec.label}: ${reason}`);
    }
  }
  return credentials;
}

// ── the run ────────────────────────────────────────────────────────────────

function loadProfile(): SessionProfile {
  const path = resolve(RESULTS_DIR, 'session-profile.json');
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as SessionProfile;
  return staticFallbackProfile();
}

async function runWorkers(
  config: HarnessConfig,
  credentials: readonly Credential[],
  screensByGroup: Readonly<Record<string, readonly Screen[]>>,
  laneByTenant: Readonly<Record<string, BucketLane>>,
  t0Ms: number,
): Promise<Aggregate> {
  const endAtMs = t0Ms + (config.rampSeconds + config.durationSeconds) * 1000;
  const workerCount = Math.max(1, Math.min(config.workers, credentials.length));
  const total = createAggregate(t0Ms, config.rampSeconds + config.durationSeconds);

  const shards: Array<{ credentials: Credential[]; globalIndices: number[] }> = Array.from({ length: workerCount }, () => ({
    credentials: [],
    globalIndices: [],
  }));
  credentials.forEach((credential, index) => {
    const shard = shards[index % workerCount]!;
    shard.credentials.push(credential);
    shard.globalIndices.push(index);
  });

  const results = await Promise.all(
    shards.map(
      (shard, i) =>
        new Promise<Aggregate>((resolveShard, rejectShard) => {
          const input: WorkerInput = {
            config,
            credentials: shard.credentials,
            globalIndices: shard.globalIndices,
            totalUsers: credentials.length,
            screensByGroup,
            laneByTenant,
            t0Ms,
            endAtMs,
            seed: 0x51f3 + i * 104729,
          };
          // `new URL(...)` rather than a string path so tsx's ESM hooks apply to
          // the worker exactly as they do to this file.
          const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: input });
          worker.once('message', (message: Aggregate & { __error?: string }) => {
            if (message.__error) rejectShard(new Error(`worker ${i}: ${message.__error}`));
            else resolveShard(message);
          });
          worker.once('error', rejectShard);
          worker.once('exit', (code) => {
            if (code !== 0) rejectShard(new Error(`worker ${i} exited with code ${code}`));
          });
        }),
    ),
  );

  for (const result of results) mergeAggregate(total, result);
  return total;
}

async function main(): Promise<void> {
  const config = readConfig();
  const strategy: SessionStrategy = (process.env.LOAD_SESSIONS as SessionStrategy) ?? 'reuse';
  const warnings: string[] = [];
  const profile = loadProfile();

  if (profile.source === 'static-fallback') {
    warnings.push(
      'route mix is the STATIC FALLBACK derived from console source, not a measurement. Run `pnpm load:session` first — OD-1 asked for a measured number.',
    );
  }
  if (strategy === 'reuse') {
    warnings.push(
      "LOAD_SESSIONS=reuse: one JWT per tenant, shared by that tenant's virtual users. Correct for the CURRENT tenant-wide bucket; cannot exercise a per-principal bucket (OD-2).",
    );
  }

  const fixture = loadFixture(warnings);
  const specs = buildPrincipals(config, fixture, warnings);

  console.log(`[load:run] acquiring credentials for ${specs.length} principals (strategy=${strategy})…`);
  const credentials = await acquireAll(config, specs, strategy, warnings);
  if (credentials.length === 0) throw new Error('no credentials could be acquired — is the gateway up and seeded?');
  console.log(`[load:run] ${credentials.length} credentials ready`);

  const probeContext = {
    baseUrl: config.baseUrl,
    timeoutMs: config.requestTimeoutMs,
    pgConnectTimeoutMs: config.pgConnectTimeoutMs,
    t0Ms: Date.now(),
  };

  // PER TENANT, and before the load: lanes differ per tenant (a tenant with no
  // plan has no rank-3 opinion and falls through to the IP-keyed platform
  // lane), and the probe reads counters the load would otherwise be moving.
  const laneReport: LaneReport = await probeLanes(
    { ...probeContext, routeA: process.env.LOAD_PROBE_ROUTE_A ?? 'users/me/settings', routeB: process.env.LOAD_PROBE_ROUTE_B ?? 'agents' },
    credentials,
  );
  const laneByTenant: Record<string, BucketLane> = Object.fromEntries(Object.entries(laneReport.byTenant).map(([id, verdict]) => [id, verdict.lane]));
  console.log(
    `[load:run] rate-limit lanes: ${Object.entries(laneByTenant)
      .map(([id, lane]) => `${id.slice(0, 8)}=${lane}`)
      .join(' ')}`,
  );

  // Ask the platform which routes each credential class can actually reach,
  // rather than encoding an assumption about the fixture's roles. Without this,
  // a fixture seeded with clinicians spends the run exercising the authorization
  // guard — measured at 63/96 responses on the first smoke run.
  let calibration: Calibration | undefined;
  const screensByGroup: Record<string, Screen[]> = {};
  if (config.calibrate) {
    console.log('[load:run] calibrating reachable routes…');
    calibration = await calibrate(probeContext, credentials, CONSOLE_SCREENS, MACHINE_SCREENS);
    for (const [groupKey, allowed] of Object.entries(calibration.allowed)) {
      const isHuman = groupKey.startsWith('human|');
      const base = isHuman ? CONSOLE_SCREENS : MACHINE_SCREENS;
      const shell = isHuman ? allowedShellSteps(SHELL_STEPS, allowed) : [];
      screensByGroup[groupKey] = applyCalibration(base, allowed).map((screen) => ({ ...screen, steps: [...shell, ...screen.steps] }));
    }
    const droppedTotal = Object.values(calibration.dropped).reduce((sum, list) => sum + list.length, 0);
    if (droppedTotal > 0)
      warnings.push(`calibration dropped ${droppedTotal} (group, route) pairs the fixture's credentials cannot reach — see the CALIBRATION section.`);
    if (Object.values(screensByGroup).every((screens) => screens.length === 0)) {
      throw new Error('calibration left no reachable route for any credential — the fixture roles do not match the screen mix');
    }
  } else {
    warnings.push(
      'LOAD_CALIBRATE=0: routes were NOT checked for reachability, so 401/403 responses will be counted as harness faults instead of being avoided.',
    );
    for (const credential of credentials) {
      const groupKey = groupKeyOf(credential.kind, credential.tenantId);
      const isHuman = credential.kind === 'human';
      screensByGroup[groupKey] = (isHuman ? CONSOLE_SCREENS : MACHINE_SCREENS).map((screen) => ({
        ...screen,
        steps: [...(isHuman ? SHELL_STEPS : []), ...screen.steps],
      }));
    }
  }

  // Let the limiter windows the probes and the calibration spent roll over, or
  // the run starts mid-window and "how much fit before the first refusal" is
  // measuring the probe's leftovers.
  if (config.cooldownSeconds > 0) {
    console.log(`[load:run] cooling down ${config.cooldownSeconds}s so the rate-limit windows reset…`);
    await new Promise((r) => setTimeout(r, config.cooldownSeconds * 1000));
  }

  const before: MetricsSnapshot | undefined = config.scrapeMetrics ? await scrape(config.baseUrl) : undefined;

  console.log(`[load:run] running ${config.rampSeconds}s ramp + ${config.durationSeconds}s at ${credentials.length} virtual users…`);
  const t0Ms = Date.now();
  const aggregate = await runWorkers(config, credentials, screensByGroup, laneByTenant, t0Ms);

  const after: MetricsSnapshot | undefined = config.scrapeMetrics ? await scrape(config.baseUrl) : undefined;

  const report: RunReport = {
    config,
    profile,
    lanes: laneReport,
    calibration,
    aggregate,
    metrics: before && after ? diff(before, after) : undefined,
    sessionStrategy: strategy,
    warnings,
  };

  console.log(render(report));

  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = resolve(RESULTS_DIR, `run-${stamp}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(toSerializable(report), null, 2)}\n`);
  writeFileSync(resolve(RESULTS_DIR, `run-${stamp}.txt`), render(report));
  console.log(`[load:run] written ${jsonPath}`);
}

main().catch((error: unknown) => {
  console.error('[load:run] failed:', error);
  process.exitCode = 1;
});
