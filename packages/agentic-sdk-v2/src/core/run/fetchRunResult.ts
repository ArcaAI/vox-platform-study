/**
 * Read the value a finished run delivered (TASK-1039).
 *
 * `GET …/runs/:runId/result` answers one of: the value itself (`X-Hope-Result-Kind: inline`), a
 * short-lived signed URL for a large value (`ref`, with `sizeBytes` and `sha256`), 204 for "ended,
 * delivered nothing", 409 `RUN_NOT_TERMINAL` for a race with the terminal write, and 410 once the
 * result is past its retention. A signed URL is a bearer credential for the object store, not for
 * HOPE: it is fetched WITHOUT the SDK's credentials, checked against the declared hash, and one
 * that was refused (expired) is re-requested once.
 */

import { RUN_ENDPOINTS, type RunKind } from '../constants';
import { RunResultError, RunResultIntegrityError } from './errors';

/** The slice of `AgenticClient` this needs. */
export interface RawRunClient {
  requestRaw(endpoint: string, options?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response>;
}

export interface FetchRunResultOptions {
  signal?: AbortSignal;
  /** Delay between `RUN_NOT_TERMINAL` retries. Default 500 ms. */
  notTerminalDelayMs?: number;
}

const NOT_TERMINAL_RETRIES = 5;

interface ResultRef {
  url: string;
  sha256?: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle === undefined) return null; // an insecure context has no SubtleCrypto: skip rather than fail the read
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `undefined` means the signed URL was refused (expired) — ask the route for a fresh one. */
async function followRef(runId: string, ref: ResultRef, signal?: AbortSignal): Promise<{ value: unknown } | undefined> {
  const response = await fetch(ref.url, { signal });
  if (response.status === 403 || response.status === 410) return undefined;
  if (!response.ok) throw new RunResultError({ runId, status: response.status, message: `The signed result URL of run ${runId} could not be read (${response.status}).` });
  const bytes = await response.arrayBuffer();
  if (ref.sha256 !== undefined) {
    const actual = await sha256Hex(bytes);
    if (actual !== null && actual !== ref.sha256.toLowerCase()) throw new RunResultIntegrityError(runId);
  }
  const text = new TextDecoder().decode(bytes);
  return { value: text.length === 0 ? null : (JSON.parse(text) as unknown) };
}

export async function fetchRunResult(client: RawRunClient, kind: RunKind, slug: string, runId: string, options: FetchRunResultOptions = {}): Promise<unknown> {
  const path = RUN_ENDPOINTS.RESULT(kind, slug, runId);
  let notTerminal = 0;
  let refAttempts = 0;

  for (;;) {
    let response: Response;
    try {
      response = await client.requestRaw(path, { headers: { Accept: 'application/json' }, signal: options.signal });
    } catch (error) {
      const context = (error as { context?: { status?: number; code?: string } }).context;
      if (context?.status === 409 && context.code === 'RUN_NOT_TERMINAL' && notTerminal < NOT_TERMINAL_RETRIES) {
        notTerminal += 1;
        await sleep(options.notTerminalDelayMs ?? 500, options.signal);
        continue;
      }
      throw error;
    }
    if (response.status === 204) return null;

    const text = await response.text();
    const parsed = text.length === 0 ? null : (JSON.parse(text) as unknown);
    if (response.headers.get('x-hope-result-kind') !== 'ref') return parsed;

    const fetched = await followRef(runId, parsed as ResultRef, options.signal);
    if (fetched !== undefined) return fetched.value;
    refAttempts += 1;
    if (refAttempts >= 2) throw new RunResultError({ runId, status: 403, message: `The signed result URL of run ${runId} was refused twice.` });
  }
}
