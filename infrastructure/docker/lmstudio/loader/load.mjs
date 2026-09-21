#!/usr/bin/env node
// =============================================================================
// A-6 preload, over the `@lmstudio/sdk` kvConfig websocket instead of `lms load`
// =============================================================================
// This replaces the `lms load` invocation that used to live in entrypoint.sh.
// The reason is not style: `lms load` has no flag for flash attention, none for
// KV-cache quantization and none for device selection, and
// `POST /api/v1/models/load` answers `unrecognized_keys` for all three
// (ticket §2.3). The daemon supports them; only the transport was missing.
//
// kvconfig.mjs decides WHAT to send and is unit-tested without a daemon. This
// file does the I/O and, crucially, the VERIFICATION.
//
// -----------------------------------------------------------------------------
// WHY THERE IS A READ-BACK, AND WHY IT IS FATAL BY DEFAULT
// -----------------------------------------------------------------------------
// A kvConfig is an untyped `{fields: [{key, value}]}` bag. A key the daemon does
// not recognise is not rejected — it is IGNORED. So the failure mode this
// transport introduces is precisely the one the ticket names as worse than not
// starting: a pod that comes up green while serving on parameters nobody asked
// for. `lms ps` would show the model loaded; every dashboard would be fine; the
// only symptom would be latency and VRAM that never improved.
//
// So after the load succeeds we ask the daemon what it ACTUALLY applied
// (`getLoadConfig`) and compare it field by field against what we sent. A key
// that did not land, or landed with a different value, is named and the pod
// refuses to serve — the same posture as the `die "preload ... failed"` this
// block replaces, extended to cover silent divergence as well as outright
// failure.
//
// That `getLoadConfig` returns the EFFECTIVE, in-force configuration (and not
// the model's stored defaults) is measured, not assumed. Against the live
// hope-lmstudio pod on 2026-09-21, the loaded gemma-4-e2b-it-qat instance
// answered:
//     llm.load.contextLength                  = 65536
//     llm.load.numParallelSessions            = 4
//     llm.load.llama.acceleration.offloadRatio = 1
//     load.gpuSplitConfig                     = {"strategy":"evenly",…}
// — i.e. exactly the values entrypoint.sh had passed as `--context-length`,
// `--parallel` and `--gpu max`, under the key names kvconfig.mjs uses. That run
// is also where the single normalisation on this path was found: `"max"` is
// stored as `1`, which is why kvconfig.mjs canonicalises the ratio to a number
// before sending it rather than teaching the comparison a special case.
//
// HOPE_KVCONFIG_ENFORCE=warn downgrades that to a warning, mirroring
// HOPE_ACCEL_ENFORCE in entrypoint.sh. It exists for the same reason: so a
// benign normalisation in a future daemon build can be survived by an operator
// at 3am without editing an image. `strict` is the default and should stay it.
//
// Uses the SDK's `port` (the same channel `client.llm.load()` itself opens)
// rather than `client.llm.load(modelKey, { config })`, because the typed
// `LLMLoadModelConfig` in SDK 1.5.0 cannot express two of the things we need:
// it has no `parallel`/`maxParallelPredictions` field at all, and its
// `gpu` -> `gpuSplitConfig` converter can only ever produce a single-element
// `priority` (it tests `gpuSetting.mainGpu ?` — so GPU 0, being falsy, drops
// out) and an always-empty `customRatio`. Hand-assembling the field list is
// what makes R-2 and R-6 reachable at all.
// =============================================================================
import { writeSync } from 'node:fs';

import { LMStudioClient } from '@lmstudio/sdk';

import { KvConfigError, assembleLoadRequest } from './kvconfig.mjs';

const EX_CONFIG = 78; // EX_CONFIG, so a misconfiguration is distinguishable from a crash

// writeSync(2), not process.stderr.write: stderr is a PIPE in a container, so
// Node buffers it asynchronously and `process.exit()` can discard whatever is
// still queued. The last line this process writes is the one that explains why
// the pod is not serving, and losing it is losing the diagnosis.
const log = (message) =>
  writeSync(2, `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} lms-loader: ${message}\n`);

const die = (message) => {
  log(`FATAL: ${message}`);
  process.exit(EX_CONFIG);
};

/** Key-sorted JSON, so two structurally equal values compare equal regardless of key order. */
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

async function main() {
  let request;
  try {
    request = assembleLoadRequest(process.env);
  } catch (error) {
    if (error instanceof KvConfigError) {
      die(`${error.message}. Nothing was sent to the daemon.`);
    }
    throw error;
  }

  const port = Number(process.env.LMS_PORT ?? 1234);
  // Always loopback: the daemon's websocket is reached inside the container.
  // LMS_SERVER_HOST (0.0.0.0) is what the HTTP server BINDS to, not an address
  // to dial — connecting to 0.0.0.0 is a different thing and works by accident
  // at best.
  const client = new LMStudioClient({ baseUrl: `ws://127.0.0.1:${port}` });

  log(`preloading ${request.modelKey}`);
  for (const { key, value } of request.kvConfig.fields) {
    log(`  kvConfig ${key} = ${JSON.stringify(value)}`);
  }
  if (request.kvConfig.fields.length === 0) {
    log('  kvConfig <empty> — every knob is unset, the daemon will use its own defaults');
  }

  try {
    const info = await loadModel(client, request);
    log(`loaded ${info.modelKey} as "${info.identifier}"`);
    await verifyApplied(client, info, request.kvConfig.fields);
  } finally {
    // The websocket keeps the event loop alive, so without this the process
    // would sit there having already done its job and A-6 would never return.
    await client[Symbol.asyncDispose]().catch(() => {});
  }
}

/**
 * Open the `loadModel` channel and resolve with the loaded instance info.
 * `loadConfigStack` is a single "apiOverride" layer — the same layer name the
 * SDK's own `load()` uses, which is what makes these values win over the
 * model's stored defaults.
 */
function loadModel(client, request) {
  return new Promise((resolve, reject) => {
    let lastProgressLog = 0;
    const channel = client.llm.port.createChannel(
      'loadModel',
      {
        modelKey: request.modelKey,
        identifier: request.identifier,
        ttlMs: request.ttlMs,
        loadConfigStack: { layers: [{ layerName: 'apiOverride', config: request.kvConfig }] },
      },
      (message) => {
        switch (message.type) {
          case 'resolved':
            log(`resolved to ${message.info.modelKey}`);
            if (message.ambiguous !== undefined) {
              // Never a warning to shrug at here: A-3 already asserted that the
              // key we intend to serve is visible, so an ambiguous match means
              // the volume carries two models answering to one key.
              reject(
                new Error(
                  `model key "${request.modelKey}" is AMBIGUOUS — it matches ${message.ambiguous.join(', ')}. ` +
                    'Refusing to guess which one a clinical request would reach.',
                ),
              );
            }
            break;
          case 'progress': {
            const now = Date.now();
            if (now - lastProgressLog > 5000 || message.progress === 1) {
              log(`  loading ${(message.progress * 100).toFixed(1)}%`);
              lastProgressLog = now;
            }
            break;
          }
          case 'success':
            resolve(message.info);
            break;
          default:
            break;
        }
      },
    );
    channel.onError.subscribeOnce(reject);
  });
}

/**
 * Ask the daemon what it actually applied and compare, field by field.
 * See the header for why a silent drop is the failure mode that matters.
 */
async function verifyApplied(client, info, sentFields) {
  if (sentFields.length === 0) return;

  const applied = await client.llm.port.callRpc('getLoadConfig', {
    specifier: { type: 'instanceReference', instanceReference: info.instanceReference },
  });
  const appliedByKey = new Map(applied.fields.map((field) => [field.key, field.value]));

  const problems = [];
  for (const { key, value } of sentFields) {
    if (!appliedByKey.has(key)) {
      problems.push(`${key}: NOT APPLIED — the daemon ignored this key (an unknown kvConfig key is dropped, not rejected)`);
      continue;
    }
    const actual = appliedByKey.get(key);
    if (stable(actual) !== stable(value)) {
      problems.push(`${key}: requested ${JSON.stringify(value)} but the daemon applied ${JSON.stringify(actual)}`);
    }
  }

  if (problems.length === 0) {
    log(`verified — all ${sentFields.length} requested kvConfig field(s) are in force`);
    return;
  }

  const summary =
    `the daemon is NOT serving on the requested parameters:\n${problems.map((p) => `    ${p}`).join('\n')}`;
  if ((process.env.HOPE_KVCONFIG_ENFORCE ?? 'strict') === 'strict') {
    die(
      `${summary}\n  A pod that silently serves on different parameters than were requested is worse ` +
        'than one that does not start. Set HOPE_KVCONFIG_ENFORCE=warn to serve anyway.',
    );
  }
  log(`WARNING: ${summary}`);
}

main()
  .then(() => {
    // Explicit, because the SDK may leave a timer behind even after disposal
    // and A-6 blocks on this process. Every log line above was written with
    // writeSync, so nothing is lost by exiting here.
    process.exit(0);
  })
  .catch((error) => {
    die(
      `preload of '${process.env.LMS_LOAD ?? '<unset>'}' failed — refusing to serve a pod that would answer ` +
        `with an empty loaded_instances[] forever. Cause: ${error?.stack ?? error}`,
    );
  });
