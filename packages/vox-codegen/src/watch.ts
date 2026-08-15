/**
 * `--watch` — regenerate whenever the tenant's schema changes.
 *
 * Polling, not streaming. The design named an "MCP-style `listChanged`
 * notification riding the SSE plane" as the eventual client contract, but
 * nothing implements it yet: a later change explicitly deferred a response-level
 * version-skew signal, and the loop event stream shipped
 * (`useConsultationEvents` / `consultation:loop:{id}`) carries AGENT actions
 * for one consultation, not a schema-change notification — there is no
 * `listChanged` channel to subscribe to. Polling the same discovery endpoint
 * on an interval, comparing `etag`, is the honest implementation available
 * at this baseline; it is also exactly what the SDK does NOT do (the SDK
 * pins its version for a session and never re-fetches), so
 * this tool intentionally behaves differently from a running consultation
 * client. If a `listChanged` SSE notification ships later, this is the
 * function to point at it instead.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fetchConsultationSchemaBundle } from './fetch-schema';
import { generateConsultationSchemaTypes } from './generate';
import type { RunCodegenOptions } from './run';

export interface WatchCycleInfo {
  changed: boolean;
  etag: string;
}

export interface WatchOptions extends RunCodegenOptions {
  intervalMs: number;
  /** Called after every poll, whether or not the bundle changed. */
  onCycle?: (info: WatchCycleInfo) => void;
  signal?: AbortSignal;
  /** Injectable for tests — replaces the real delay between polls. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * Poll the discovery endpoint every `intervalMs`, regenerating the output
 * file only when the served `etag` changes. Runs until `options.signal` is
 * aborted. A fetch/codegen error propagates immediately (stops the loop) —
 * one bad poll should surface, not be swallowed into an infinite retry.
 */
export async function watchCodegen(options: WatchOptions): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  let lastEtag: string | undefined;

  while (!options.signal?.aborted) {
    const bundle = await fetchConsultationSchemaBundle(options);
    const changed = bundle.etag !== lastEtag;

    if (changed) {
      const file = generateConsultationSchemaTypes(bundle, { tenantId: options.tenantId, generatedAt: options.generatedAt });
      await mkdir(dirname(resolve(options.outFile)), { recursive: true });
      await writeFile(options.outFile, file.contents, 'utf8');
      lastEtag = bundle.etag;
    }

    options.onCycle?.({ changed, etag: bundle.etag });

    if (options.signal?.aborted) break;
    await sleep(options.intervalMs);
  }
}
