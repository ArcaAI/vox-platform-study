/**
 * `HopeClient` — the top-level entry point for `@arcaai/vox-node`. Wires one
 * `core/transport.ts#Transport` instance (connection-level config: base URL,
 * credentials, retry/timeout defaults) into every resource
 * (`src/resources/**`), which is the only thing this module does — no
 * request logic lives here.
 *
 * Named `HopeClient` (a client for the HOPE gateway), not `VoxNodeClient` —
 * per the ticket plan §3.2, the package brand (`@arcaai/vox-node`) and the
 * client class name are deliberately different: the package name carries
 * brand continuity with the browser `@arcaai/vox` SDK, while the class name
 * says what it actually talks to.
 */

import { Transport } from './core/transport';
import { ConsultationsResource, JobsResource, SummarizationResource } from './resources';

/**
 * Structured logger hook for `HopeClient`. Every method is optional so a
 * partial logger (e.g. only `error`) is valid.
 *
 * **PHI safety**: `HopeClient` never passes a request or response BODY to
 * any `HopeLogger` method — transcripts and summaries are PHI
 * (`.claude/rules/00-project-context.md`). `meta`, when present, carries only
 * non-content fields (method, path, status, requestId).
 *
 * Not yet wired to `core/transport.ts#Transport`, which has no logging hook
 * of its own (verified against the already-frozen transport core — see the
 * top-level task report). Accepted here for forward compatibility with the
 * `HopeClient` constructor shape in the ticket plan §3.2; currently inert.
 */
export interface HopeLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

/** Constructor options for {@link HopeClient}. */
export interface HopeClientOptions {
  /** e.g. `http://localhost:8868`. */
  baseUrl: string;
  /** Sent as `X-API-Key` on every request. */
  apiKey?: string;
  /** Sent as `X-Tenant-Id` on every request — global-admin API keys only. */
  tenantId?: string;
  /** Default `2`. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default `60_000`. */
  timeout?: number;
  /** Injectable for tests/proxies; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** See {@link HopeLogger}. */
  logger?: HopeLogger;
}

/**
 * The HOPE Node SDK client. Construction never touches the network — it only
 * builds the shared `Transport` and the resource instances hanging off it.
 *
 * ```ts
 * const hope = new HopeClient({ baseUrl: process.env.HOPE_API_URL!, apiKey: process.env.HOPE_API_KEY! });
 * const { summary } = await hope.summarization.summary({ session_data: {...} });
 * ```
 */
export class HopeClient {
  /** P0 — stateless, v1-compat pre-summary/summary (`POST /api/smr/api/v1/{presummary,summary/sync}`). */
  readonly summarization: SummarizationResource;
  /** P0.5 — minimal consultation read + consultation-bound summarization (`.summaries`). */
  readonly consultations: ConsultationsResource;
  /** P0.5 — async job get/cancel/stream/waitFor. */
  readonly jobs: JobsResource;

  constructor(options: HopeClientOptions) {
    if (!options.baseUrl) {
      throw new Error('HopeClient requires a non-empty `baseUrl` (e.g. "http://localhost:8868").');
    }

    const transport = new Transport({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      tenantId: options.tenantId,
      maxRetries: options.maxRetries,
      timeoutMs: options.timeout,
      fetch: options.fetch,
    });

    this.summarization = new SummarizationResource(transport);
    this.consultations = new ConsultationsResource(transport);
    this.jobs = new JobsResource(transport);
  }
}
