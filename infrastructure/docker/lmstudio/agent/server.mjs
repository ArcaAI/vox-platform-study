#!/usr/bin/env node
// =============================================================================
// LM Studio residency agent — entry point (TASK-1055, owner decision OD-1)
// =============================================================================
// Runs INSIDE the hope-lmstudio container, started by entrypoint.sh after the
// boot plan is loaded and kept alive by its supervisor loop. Listens on
// LMS_AGENT_HOST:LMS_AGENT_PORT (default 0.0.0.0:8869) and talks to the daemon
// on loopback only (127.0.0.1:LMS_PORT, REST + the SDK websocket).
//
// Logs are JSON lines on STDOUT (one object per line). Nothing that passes
// through here is model I/O — the agent loads and unloads, it never generates —
// so there is no prompt or completion to leak (the A-7 PHI rule holds).
//
// Env:
//   LMS_AGENT_HOST / LMS_AGENT_PORT   bind address (0.0.0.0 / 8869)
//   LMS_PORT                          the daemon's port (1234)
//   INTERNAL_ACCESS_TOKEN             X-Service-Token; empty (or CHANGE_ME) = dev bypass,
//                                     REFUSED when deployed (see isDeployed, R2-F9)
//   DEPLOYMENT_ENVIRONMENT / NODE_ENV the deployed-process marker (as the python services)
//   LMS_GPU_COUNT                     override the nvidia-smi card count
//   LMS_GPU                           offload ratio, as the boot loader (max)
//   HOPE_KVCONFIG_ENFORCE             strict (default) | warn — read-back drift
//   LMS_AGENT_LOAD_TIMEOUT_SECONDS    one load's ceiling (600); must stay below the
//                                     gateway's agent-load timeout (>= 900 s, R1-F5)
//   CUDA_DEVICE_ORDER                 must be PCI_BUS_ID for cuda:<n> == nvidia-smi index n (E13)
//   HOPE_API_URL                      the gateway, for the plan `ensure` loads from (wave 3; unset = no profiles)
//   HOPE_PLAN_FETCH_SECONDS           plan refresh cadence (60, the boot loader's value)
// =============================================================================
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createLmStudioClient } from '../loader/sdk-channel.mjs';
import { createDaemon } from './daemon.mjs';
import { readGpus } from './gpus.mjs';
import { createHandler } from './http.mjs';
import { createPlanCache } from './plan.mjs';
import { createResidencyAgent } from './residency.mjs';

const read = (env, name) => {
  const raw = env[name];
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed === '' ? undefined : trimmed;
};

const positiveInt = (env, name, fallback) => {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name}: expected a positive integer, got "${raw}"`);
  return value;
};

/** The unfilled-secret sentinel (hope_env PLACEHOLDER_SENTINEL): the ABSENCE of a value. */
export const PLACEHOLDER_SENTINEL = 'CHANGE_ME';

/**
 * The gateway's timeout for one agent load (R1-F5: >= 900 s). The agent's own
 * load ceiling must stay STRICTLY below it, so the agent answers a slow load
 * with a clean LOAD_FAILED instead of the gateway aborting mid-load and
 * reporting a timeout for a model that may still land.
 */
export const GATEWAY_AGENT_LOAD_TIMEOUT_SECONDS = 900;

/**
 * Is this a DEPLOYED process, i.e. one that must fail closed? Same rule as the
 * python services (apps/nlp/src/nlp/core/internal_auth.py `is_deployed`,
 * TASK-892 C3): `NODE_ENV=test` declares a test run and wins; otherwise a
 * non-blank DEPLOYMENT_ENVIRONMENT (set in every deployed environment — base
 * `production`, the dev overlay `dev`) or NODE_ENV=production. `CI` alone is
 * not a deployment.
 */
export function isDeployed(env) {
  const nodeEnv = String(env.NODE_ENV ?? '').trim().toLowerCase();
  if (nodeEnv === 'test') return false;
  if (String(env.DEPLOYMENT_ENVIRONMENT ?? '').trim() !== '') return true;
  return nodeEnv === 'production';
}

/** The agent's configuration, from the environment. Throws naming the variable. */
export function agentConfig(env) {
  const token = read(env, 'INTERNAL_ACCESS_TOKEN') ?? '';
  return {
    host: read(env, 'LMS_AGENT_HOST') ?? '0.0.0.0',
    port: positiveInt(env, 'LMS_AGENT_PORT', 8869),
    daemonPort: positiveInt(env, 'LMS_PORT', 1234),
    // The sentinel is no token at all (hope_env.real_secret): dev bypass, or a refusal when deployed.
    token: token === PLACEHOLDER_SENTINEL ? '' : token,
    instance: read(env, 'HOSTNAME') ?? 'hope-lmstudio',
    loadTimeoutMs: positiveInt(env, 'LMS_AGENT_LOAD_TIMEOUT_SECONDS', 600) * 1000,
  };
}

/** `(level, event, fields)` -> one JSON line. `write` is injected for tests. */
export function createJsonLogger(write = (text) => process.stdout.write(text), now = Date.now) {
  return (level, event, fields = {}) => {
    write(`${JSON.stringify({ ts: new Date(now()).toISOString(), level, logger: 'lmstudio-agent', event, ...fields })}\n`);
  };
}

const describe = (part) => (part instanceof Error ? `${part.name}: ${part.message}` : String(part));

/** The SDK logs through `console` by default; route it into the JSON stream (debug dropped). */
export function sdkLogger(log) {
  const at = (level) => (...parts) => log(level, 'sdk.log', { message: parts.map(describe).join(' ') });
  return { info: at('info'), warn: at('warn'), error: at('error'), debug: () => {} };
}

/**
 * Build (not start) the agent server. `daemon` / `gpus` / `write` / `fetchImpl`
 * are injected in tests; production uses the real daemon adapter, nvidia-smi
 * and the gateway. The plan cache is built here and started by `main`.
 */
export function buildAgentServer({ env = process.env, daemon, gpus, write, fetchImpl } = {}) {
  const config = agentConfig(env);
  const log = createJsonLogger(write);
  const daemonAdapter =
    daemon ??
    createDaemon({
      port: config.daemonPort,
      log,
      loadTimeoutMs: config.loadTimeoutMs,
      connect: () => createLmStudioClient(config.daemonPort, sdkLogger(log)),
    });
  const gpuReader = gpus ?? { read: () => readGpus() };

  const plan = createPlanCache({ env, token: config.token, log, ...(fetchImpl ? { fetchImpl } : {}) });
  const agent = createResidencyAgent({ daemon: daemonAdapter, gpus: gpuReader, env, instance: config.instance, log, plan });
  const deployed = isDeployed(env);
  const server = createServer(createHandler({ agent, token: config.token, deployed, log }));
  // A load can legitimately take minutes; the response must not be cut short.
  server.requestTimeout = 0;

  /**
   * One startup line that records what E13 needs to be checked on the pod:
   * the card list in nvidia-smi (= PCI) order, and whether the daemon was
   * started with CUDA_DEVICE_ORDER=PCI_BUS_ID (so its gpuSplit index n is the
   * same card as nvidia-smi index n).
   */
  const startup = async () => {
    const order = read(env, 'CUDA_DEVICE_ORDER') ?? null;
    if (order !== 'PCI_BUS_ID') {
      log('warn', 'agent.cuda_device_order', {
        cuda_device_order: order,
        message:
          'CUDA_DEVICE_ORDER is not PCI_BUS_ID: the daemon may number GPUs fastest-first, so cuda:<n> (nvidia-smi index) ' +
          'and a gpuSplit index n are not guaranteed to be the same card',
      });
    }
    if (config.loadTimeoutMs >= GATEWAY_AGENT_LOAD_TIMEOUT_SECONDS * 1000) {
      log('warn', 'agent.load_timeout_not_below_gateway', {
        load_timeout_seconds: config.loadTimeoutMs / 1000,
        gateway_timeout_seconds: GATEWAY_AGENT_LOAD_TIMEOUT_SECONDS,
        message:
          'LMS_AGENT_LOAD_TIMEOUT_SECONDS is not below the gateway agent-load timeout: the gateway may abort a ' +
          'load the agent is still waiting on and report a timeout for a model that then lands',
      });
    }
    const readings = await gpuReader.read();
    let auth = 'X-Service-Token';
    if (config.token === '') {
      auth = deployed
        ? 'REFUSING every /internal route (no INTERNAL_ACCESS_TOKEN in a deployed environment)'
        : 'disabled (empty INTERNAL_ACCESS_TOKEN, dev bypass)';
    }
    log('info', 'agent.gpus', {
      cuda_device_order: order,
      gpus: readings ? readings.map(({ index, uuid, name }) => ({ index, uuid, name })) : null,
      auth,
    });
  };

  return { server, startup, config, log, plan };
}

async function main() {
  let built;
  try {
    built = buildAgentServer();
  } catch (error) {
    createJsonLogger()('error', 'agent.config_invalid', { reason: String(error?.message ?? error) });
    process.exit(78); // EX_CONFIG, as the rest of the image
  }
  const { server, startup, config, log, plan } = built;

  process.on('uncaughtException', (error) => {
    log('error', 'agent.crashed', { reason: String(error?.stack ?? error) });
    process.exit(1); // the entrypoint's supervisor restarts it
  });
  process.on('unhandledRejection', (error) => {
    log('error', 'agent.crashed', { reason: String(error?.stack ?? error) });
    process.exit(1);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log('info', 'agent.stopping', { signal });
      plan.stop();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }

  server.listen(config.port, config.host, () => {
    log('info', 'agent.listening', { host: config.host, port: config.port, daemon_port: config.daemonPort });
    startup().catch((error) => log('warn', 'agent.startup_check_failed', { reason: String(error?.message ?? error) }));
    // Off the request path: ensure reads only the cache this keeps fresh.
    plan.start();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
