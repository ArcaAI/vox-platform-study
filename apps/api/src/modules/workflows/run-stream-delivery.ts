import { TenantSettingsService, WORKFLOW_RUNS_DEFAULTS, WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY } from '@arcaai/applications';
import { parseAsyncEnvelope } from '@arcaai/async-contract';
import type { Response } from 'express';

/**
 * TASK-1038 — small helpers shared by the three run-event consumers (SSE, WebSocket, completion
 * watcher), so they cannot drift in how they parse an entry or when they re-check a run.
 */

/** One stream entry's `data` field → an async-contract envelope, or `null` (refuse-if-unknown). */
export function parseRunStreamEntry(fields: string[]): ReturnType<typeof parseAsyncEnvelope> {
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] !== 'data') continue;
    try {
      return parseAsyncEnvelope(JSON.parse(fields[i + 1]));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * R-2 — how long an idle consumer waits before re-reading the run's status, so a stream whose
 * `workflow.run.completed` was lost (a producer crash between the terminal write and the XADD, a
 * trimmed stream) still ends instead of staying open forever. A platform knob
 * (`workflowRuns.streamTerminalCheckSeconds`), failing open to its default.
 */
export function terminalCheckIntervalMs(settings: TenantSettingsService | undefined): number {
  try {
    const value = settings?.resolvePlatform<number>(WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY).value;
    const seconds = typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : WORKFLOW_RUNS_DEFAULTS.streamTerminalCheckSeconds;
    return seconds * 1000;
  } catch {
    return WORKFLOW_RUNS_DEFAULTS.streamTerminalCheckSeconds * 1000;
  }
}

/**
 * R-9 — write one SSE chunk and honour the socket's backpressure.
 *
 * `res.write()` returning `false` means the kernel buffer is full and Node is now queueing in
 * user space; carrying on would buffer a slow client's whole run in this process. So the caller
 * waits for `drain` before it asks the hub for more — and since the hub is pull-based, a waiting
 * client has no read outstanding and its events stay in the stream, not in memory.
 *
 * Resolves `true` when the caller may continue, `false` when the client went away first.
 */
export function writeWithBackpressure(res: Response, chunk: string, signal: AbortSignal): Promise<boolean> {
  if (res.writableEnded || signal.aborted) return Promise.resolve(false);
  if (res.write(chunk) !== false) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean): void => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      signal.removeEventListener('abort', onClose);
      resolve(ok);
    };
    const onDrain = (): void => done(true);
    const onClose = (): void => done(false);
    res.once('drain', onDrain);
    res.once('close', onClose);
    signal.addEventListener('abort', onClose, { once: true });
  });
}
