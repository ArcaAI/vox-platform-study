// =============================================================================
// The two SDK calls that apply and verify a load profile — shared I/O
// =============================================================================
// Used by the boot loader (load.mjs, A-6) and the residency agent
// (../agent/, TASK-1055), so a console reload goes through the exact channel
// and read-back a boot load does. kvconfig.mjs decides WHAT to send; this file
// only sends it and reads back what the daemon applied.
//
// Why the raw `port` and not `client.llm.load(modelKey, { config })`: the typed
// `LLMLoadModelConfig` in SDK 1.5.0 has no `parallel` field at all, and its
// `gpu` -> `gpuSplitConfig` converter can only emit a single-element `priority`
// (GPU 0, being falsy, drops out). See load.mjs's header for the measurements.
// =============================================================================

/**
 * Open the SDK client on loopback. The SDK is imported lazily so the pure
 * modules (and every unit test) can load without it.
 *
 * Always 127.0.0.1: LMS_SERVER_HOST (0.0.0.0) is what the HTTP server BINDS
 * to, not an address to dial.
 */
export async function createLmStudioClient(port, logger) {
  const { LMStudioClient } = await import('@lmstudio/sdk');
  return new LMStudioClient({ baseUrl: `ws://127.0.0.1:${port}`, ...(logger ? { logger } : {}) });
}

/**
 * Open the `loadModel` channel on `llmPort` (`client.llm.port`) and resolve
 * with the loaded instance info (`{ modelKey, identifier, instanceReference, … }`).
 *
 * `loadConfigStack` is a single "apiOverride" layer — the same layer name the
 * SDK's own `load()` uses, which is what makes these values win over the
 * model's stored defaults.
 *
 * @param {object} llmPort
 * @param {{ modelKey: string, identifier?: string, ttlMs?: number, kvConfig: object }} request
 * @param {{ onResolved?: (info: object) => void, onProgress?: (progress: number) => void }} [hooks]
 */
export function loadOverChannel(llmPort, request, hooks = {}) {
  return new Promise((resolve, reject) => {
    const channel = llmPort.createChannel(
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
            hooks.onResolved?.(message.info);
            if (message.ambiguous !== undefined) {
              // Never a warning to shrug at: the caller already resolved the key
              // to one exact entry, so an ambiguous match means the volume
              // carries two models answering to one key.
              reject(
                new Error(
                  `model key "${request.modelKey}" is AMBIGUOUS — it matches ${message.ambiguous.join(', ')}. ` +
                    'Refusing to guess which one a clinical request would reach.',
                ),
              );
            }
            break;
          case 'progress':
            hooks.onProgress?.(message.progress);
            break;
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
 * What the daemon ACTUALLY applied to one loaded instance — the effective,
 * in-force kvConfig (measured on the live pod, see load.mjs), not the model's
 * stored defaults.
 */
export async function readAppliedFields(llmPort, instanceReference) {
  const applied = await llmPort.callRpc('getLoadConfig', {
    specifier: { type: 'instanceReference', instanceReference },
  });
  return Array.isArray(applied?.fields) ? applied.fields : [];
}
