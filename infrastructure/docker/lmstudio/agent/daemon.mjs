// =============================================================================
// The daemon adapter: everything the agent asks LM Studio, over loopback
// =============================================================================
// Two transports, each used for what only it can do:
//   REST  http://127.0.0.1:<port>  /lmstudio-greeting (liveness — BODY-checked,
//         because this server answers 200 for every path) and /api/v1/models
//         (the on-disk catalogue `selectModelKey` resolves against, exactly as
//         the boot loader does).
//   SDK   ws://127.0.0.1:<port>    listLoaded / getLoadConfig / unloadModel and
//         the `loadModel` channel — the only way to set parallel slots, KV
//         quantization, GPU split and the identifier (TASK-996 §2.3).
// =============================================================================
import { createLmStudioClient, loadOverChannel, readAppliedFields } from '../loader/sdk-channel.mjs';

const NAMESPACES = ['llm', 'embedding'];
const READ_TIMEOUT_MS = 5_000;
const CONNECTION_FAILURE = /ECONNREFUSED|ECONNRESET|EPIPE|socket|websocket|disconnect|connection (closed|lost|refused)|not connected/i;

/**
 * @param {{ port: number, fetchImpl?: typeof fetch, connect?: () => Promise<object>,
 *           log?: (level, event, fields) => void, loadTimeoutMs?: number }} deps
 */
export function createDaemon({
  port,
  fetchImpl = fetch,
  connect = () => createLmStudioClient(port),
  log = () => {},
  loadTimeoutMs = 600_000,
}) {
  const base = `http://127.0.0.1:${port}`;
  let clientPromise = null;

  const client = () => {
    clientPromise ??= connect().catch((error) => {
      clientPromise = null;
      throw error;
    });
    return clientPromise;
  };

  /**
   * Drop the client after a CONNECTION failure, so the next call reconnects
   * instead of reusing a dead socket. An application error (unknown
   * identifier, a failed load) keeps it: disposing would also tear down any
   * load channel another request has open on the same client.
   */
  const withClient = async (fn) => {
    const current = await client();
    try {
      return await fn(current);
    } catch (error) {
      if (clientPromise && CONNECTION_FAILURE.test(String(error?.message ?? error))) {
        clientPromise = null;
        await current[Symbol.asyncDispose]?.().catch(() => {});
      }
      throw error;
    }
  };

  const portOf = (current, type) => (current[type] ?? current.llm).port;

  const getJson = async (path) => {
    const response = await fetchImpl(`${base}${path}`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`GET ${path} answered HTTP ${response.status}`);
    return response.json();
  };

  return {
    async greet() {
      const body = await getJson('/lmstudio-greeting');
      return body?.lmstudio === true;
    },

    async listModels() {
      const body = await getJson('/api/v1/models');
      // `/api/v1/models` answers `{ models }`; the OpenAI-compatible `/v1/models`
      // answers `{ data }` — accept both, as load.mjs does.
      return Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
    },

    listLoaded() {
      return withClient(async (current) => {
        const out = [];
        for (const type of NAMESPACES) {
          if (!current[type]?.port) continue;
          const infos = await current[type].port.callRpc('listLoaded', undefined);
          for (const info of infos ?? []) {
            out.push({
              type,
              identifier: info.identifier,
              modelKey: info.modelKey,
              instanceReference: info.instanceReference,
              sizeBytes: info.sizeBytes,
            });
          }
        }
        return out;
      });
    },

    appliedFields(instance) {
      return withClient((current) => readAppliedFields(portOf(current, instance.type), instance.instanceReference));
    },

    load(request) {
      return withClient(async (current) => {
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`the loadModel channel did not finish within ${Math.round(loadTimeoutMs / 1000)}s`)),
            loadTimeoutMs,
          );
        });
        let lastProgress = 0;
        try {
          const info = await Promise.race([
            loadOverChannel(current.llm.port, request, {
              onProgress: (progress) => {
                if (progress - lastProgress >= 0.25 || progress === 1) {
                  lastProgress = progress;
                  log('info', 'residency.load_progress', { identifier: request.identifier, progress });
                }
              },
            }),
            timeout,
          ]);
          return { type: 'llm', ...info };
        } finally {
          clearTimeout(timer);
        }
      });
    },

    unload(instance) {
      return withClient((current) =>
        portOf(current, instance.type).callRpc('unloadModel', { identifier: instance.identifier }),
      );
    },
  };
}
