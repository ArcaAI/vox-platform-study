import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

/**
 * TASK-993 lane C — keep-alive pooling for the four `HttpModule.register(...)`
 * clients the gateway holds open to its in-cluster Python peers: `agent.module.ts`,
 * `speech.module.ts`, `streaming.module.ts`, `text-compat.module.ts`. None of the
 * four supplied an `httpAgent`/`httpsAgent`, so axios fell back to Node's
 * `http.globalAgent`/`https.globalAgent`.
 *
 * CORRECTION to the defect as originally framed (README S2.8: "no custom agent =>
 * keepAlive: false, new TCP handshake per call"). Verified empirically against the
 * Node version this service actually ships on (`apps/api/Dockerfile:1`
 * `ARG NODE_VERSION=24`; CI builds on `node:24-*`): `http.globalAgent` and
 * `https.globalAgent` do NOT default to `keepAlive: false`. Node has shipped both
 * global agents with `{ keepAlive: true, scheduling: 'lifo', timeout: 5000 }` since
 * Node 19 (nodejs/node#43522) — confirmed locally (`node -e "require('http').
 * globalAgent.keepAlive"` -> `true`). A bare `new http.Agent()` still defaults to
 * `keepAlive: false`; the GLOBAL singletons specifically do not. So these four call
 * sites were already getting opportunistic connection reuse, not a fresh handshake
 * on every call — the socket-reuse test below proves this directly (see its
 * "explicit keepAlive: false" case, not a bare "no agent" case, for exactly why).
 *
 * What was genuinely missing, and what this file actually fixes:
 *   - `http.globalAgent.maxSockets` is `Infinity` — no per-host ceiling at all.
 *   - it is a PROCESS-WIDE SHARED singleton: any code in the gateway that does not
 *     pass its own agent — unrelated libraries, instrumentation, anything added
 *     later — pools through the SAME agent as these four modules' downstream
 *     calls, so an unrelated caller can starve or bloat this pool.
 *   - its `timeout: 5000` (idle-socket inactivity) is one blunt value shared by
 *     EVERY caller of the global agent, yet these four modules run calls up to
 *     300_000ms (see the sizing note below) — a value chosen FOR these calls,
 *     not inherited from an unrelated default, is what removes that mismatch.
 *   - none of this was explicit or documented at the four call sites — the
 *     pooling behaviour a reader saw depended on which Node major version the
 *     process happened to run, not on anything stated in the code.
 *
 * At the platform target of 10 tenants x 100 concurrent users, these calls sit on
 * the hot path for every consultation, summarization and transcription call, so a
 * BOUNDED, DEDICATED, documented pool is still the right fix even though the
 * "zero reuse today" framing does not hold on this runtime.
 *
 * ONE pair of agents, shared BY REFERENCE across all four modules, not four
 * independent pools: `agent.module.ts` and `speech.module.ts` both call `TTS_URL`;
 * `streaming.module.ts` and `text-compat.module.ts` both call `TEXT_URL` (verified
 * against each controller's own `getConfigValue(...)` call site —
 * `agent.controller.ts:616`, `speech-proxy.controller.ts:148`,
 * `harness-tts-internal.controller.ts:160`, `text-proxy.controller.ts:426`,
 * `text-compat.controller.ts:885`). Sharing lets a socket opened for one module's
 * call to a host be reused by the OTHER module calling the SAME host, instead of
 * each warming its own disjoint pool to the same peer — while still being a
 * SMALLER, bounded, dedicated pool than the process-wide global agent above.
 *
 * Sizing, against the TASK-993 load model (README S1/S2.8-2.9): steady state is
 * ~167 req/s platform-wide, EXCLUDING audio/SSE streams — those streams (SSE text
 * generation, TTS audio) run up to 300_000ms (`STREAM_READ_TIMEOUT_MS`, and the
 * `timeout: 300_000` call sites in `agent.controller.ts`/`speech-proxy.controller.ts`/
 * `harness-tts-internal.controller.ts`) and are the concurrency driver, not the
 * request rate. A worst-case skew — a meaningful slice of the 1,000-user target
 * mid-stream against a SINGLE downstream host at once — lands in the low hundreds.
 *
 *   - `maxSockets: 256` per host (Node's Agent enforces this PER HOST, not
 *     globally). Headroom over that worst-case skew, and deliberately anchored to
 *     `apps/guardrail`'s own admission gate (also 256, `core/config.py:87-102,197`)
 *     and close to `apps/text`'s per-provider queue depth (200,
 *     `runtime_defaults.py:117`) — the gateway's pool should not be MORE generous
 *     than the ceiling a peer already enforces on itself, so backpressure still
 *     originates at the service that knows its true capacity. Across the (fixed,
 *     small) set of downstream hosts this bounds the shared agent at a few hundred
 *     to ~1,500 pooled sockets even if every host were saturated at once — well
 *     inside a container's usual open-file ceiling for a single-replica-in-dev
 *     gateway process.
 *   - `maxFreeSockets: 32` — Node's own default is 256; steady-state concurrency
 *     here (~167 req/s spread over many routes, most of which never reach these
 *     four modules) needs nowhere near that many idle warm sockets per host. 32
 *     gives a good reuse hit-rate for the README's ~10-req/min-per-user cadence
 *     without pinning excess idle file descriptors once a burst subsides.
 *   - `keepAliveMsecs` is left at Node's default (1000ms — the delay before the OS
 *     sends the first TCP keep-alive PROBE on an idle pooled socket; unrelated to
 *     any request timeout). Nothing here gives a load-bearing reason to move it:
 *     these are direct in-cluster calls (`http://hope-text:8862` etc., verified
 *     against `hope-v2-deployment/deployment/k8s/base/*.yaml`) with no intermediate
 *     proxy hop to coordinate with — contrast the INBOUND edge, where Cloudflare/
 *     Traefik sit in front and a different, already-tracked reconnect storm lives
 *     (README S2.12 F-2).
 *   - `timeout` (idle-socket INACTIVITY, not a request timeout — see
 *     `GATEWAY_HTTP_AGENT_IDLE_SOCKET_TIMEOUT_MS` below): set safely ABOVE the
 *     longest per-call axios timeout actually configured across these four
 *     modules' controllers (300_000ms). It resets on every byte transferred, so an
 *     active-but-sparse stream is untouched by it; its job is reaping a socket —
 *     usually a FREE, pooled one — that went silently dead (a rescheduled pod, a
 *     half-open connection with no FIN/RST) instead of leaving it in the pool
 *     until the next caller hits it with a connection error. It must never be
 *     shorter than the longest legitimate call, or it would truncate a live
 *     stream itself instead of leaving that to axios's own per-call timeout.
 *
 * `httpsAgent` is provided for parity even though every downstream URL in this
 * deployment is `http:` today (verified against `.env.dev`/`.env.sample` and every
 * `base/*.yaml` in `hope-v2-deployment` — `STT_URL`, `TEXT_URL`, `GUARDRAIL_URL`,
 * `NLP_URL`, `HARNESS_URL`, `TTS_URL` are all plain HTTP, in-cluster, no TLS
 * termination at the pod). `httpAgent` is the one expected to see any traffic.
 *
 * `timeout`/`maxRedirects` on the four `HttpModule.register(...)` calls are
 * UNCHANGED by this file — those are axios REQUEST-level settings; this file only
 * supplies the transport-level `httpAgent`/`httpsAgent`.
 */
export const GATEWAY_HTTP_AGENT_MAX_SOCKETS = 256;
export const GATEWAY_HTTP_AGENT_MAX_FREE_SOCKETS = 32;
export const GATEWAY_HTTP_AGENT_IDLE_SOCKET_TIMEOUT_MS = 360_000;

export interface GatewayKeepAliveAgents {
  httpAgent: HttpAgent;
  httpsAgent: HttpsAgent;
}

/**
 * Builds a fresh `{ httpAgent, httpsAgent }` pair with the pooling above.
 * Exported (rather than only the singleton below) so a test can construct an
 * ISOLATED pair against a throwaway server without sharing sockets — or a socket
 * count — with the app-wide singleton.
 */
export function createGatewayKeepAliveAgents(): GatewayKeepAliveAgents {
  const options = {
    keepAlive: true,
    maxSockets: GATEWAY_HTTP_AGENT_MAX_SOCKETS,
    maxFreeSockets: GATEWAY_HTTP_AGENT_MAX_FREE_SOCKETS,
    timeout: GATEWAY_HTTP_AGENT_IDLE_SOCKET_TIMEOUT_MS,
  };
  return {
    httpAgent: new HttpAgent(options),
    httpsAgent: new HttpsAgent(options),
  };
}

/**
 * The shared pair every `HttpModule.register(...)` site spreads in, so
 * `TTS_URL`/`TEXT_URL` sockets pool ACROSS modules (see the file doc above)
 * rather than each module warming its own, disjoint pool to the same host.
 */
export const gatewayKeepAliveAgents: GatewayKeepAliveAgents = createGatewayKeepAliveAgents();
