/**
 * @arcaai/vox - useDnaReport Hook
 *
 * The doctor SELF-service surface over a clinician's own DNA writing-style
 * report — `DnaWritingStyleController` (`@Controller('dna-writing-styles')`,
 * JWT only — `@ForbidApiKey()`). No `/admin` prefix; the tenant-admin grid is
 * a separate surface.
 *
 * Sibling to `useDnaWritingStyle` (the sample-INGEST hook, TASK-974): that one
 * submits writing samples to the platform's hidden DNA analyst agent; this one
 * reads and edits the report the analyst produced — including the redaction
 * rule set that "the DNA report is used as the writing rule for redaction"
 * depends on. Rules are READ via `getMyRedactionRules` but WRITTEN through
 * `updateReport`'s `redactionRules` field — there is no dedicated write route.
 *
 * The SSE job stream (`jobs/:jobId/stream`) is deliberately NOT wired here — a
 * separate lane is fixing its auth. `getJobStatus`/`pollJobStatus` (GET
 * `jobs/:jobId`) is the documented polling fallback and is sufficient on its
 * own for tracking a generation job to completion, mirroring the
 * `getIngestJob`/`pollIngestJob` idiom of `useDnaWritingStyle`.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { ifMatchFor } from '../utils/occ';
import { DNA_WRITING_STYLE_ENDPOINTS } from '../core/constants';
import type {
  DnaReport,
  DnaGenerateInput,
  DnaGenerateJobResponse,
  DnaUpdateInput,
  DnaRedactionRuleSet,
  DnaSettings,
  DnaSettingsUpdateInput,
  DnaJobStatus,
} from '../types/dna';

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed']);

export interface PollDnaJobOptions {
  /** Delay between polls, in ms. Default 2000. */
  intervalMs?: number;
  /** Give up and reject once this many ms have elapsed. Default 120000 (2 min). */
  timeoutMs?: number;
}

export interface UseDnaReportReturn {
  /** The caller's active/default report — set by `getMyStyle` and `updateReport`. */
  myStyle: DnaReport | null;
  /** The caller's full report history — set by `listMyReports`. */
  myReports: DnaReport[];
  /** The caller's decrypted redaction/rewrite rule set — set by `getMyRedactionRules`. */
  redactionRules: DnaRedactionRuleSet | null;
  /** The caller's DNA on/off settings — set by `getSettings` and `setSettings`. */
  settings: DnaSettings | null;
  /** The most recent generation-job snapshot — set by `generate`, `getJobStatus`, `pollJobStatus`. */
  job: DnaJobStatus | null;
  isLoading: boolean;
  error: Error | null;

  /** `GET my-style` — the caller's active report. A 404 (no style yet) propagates like any other read. */
  getMyStyle: () => Promise<DnaReport>;
  /** `GET mine` — the caller's full report history (backs the report list / set-default picker). */
  listMyReports: () => Promise<DnaReport[]>;
  /** `GET my-style/redaction-rules` — always well-formed (`{ rules: [] }`), never 404s. */
  getMyRedactionRules: () => Promise<DnaRedactionRuleSet>;
  /** `GET settings` — the caller's DNA on/off toggle plus the tenant cascade's effective decision. */
  getSettings: () => Promise<DnaSettings>;

  /**
   * `PATCH :reportId` — the ONLY write path for `redactionRules` (there is no
   * dedicated rules endpoint). `If-Match` (required by the route) is derived
   * from `expectedVersion` via `ifMatchFor`.
   */
  updateReport: (reportId: string, input: DnaUpdateInput, expectedVersion: number) => Promise<DnaReport>;
  /**
   * `PUT settings` — `If-Match` is REQUIRED on every call. `GET settings`
   * answers `version: 0` while no override row exists yet, so the FIRST write
   * still carries a real `If-Match: "0"` (never an omitted header); the body's
   * `expectedVersion` (which the gateway rejects below `1`) is included only
   * once `currentVersion` is at least `1`. Defaults to `0` — the pre-first-write case.
   */
  setSettings: (input: DnaSettingsUpdateInput, currentVersion?: number) => Promise<DnaSettings>;

  /** `POST generate` — queues a generation job for the caller; poll the returned `jobId` below. */
  generate: (input?: DnaGenerateInput) => Promise<DnaGenerateJobResponse>;
  /** `GET jobs/:jobId` — a single status snapshot. */
  getJobStatus: (jobId: string) => Promise<DnaJobStatus>;
  /** Poll `GET jobs/:jobId` until it reaches a terminal status, or reject on `timeoutMs`. */
  pollJobStatus: (jobId: string, options?: PollDnaJobOptions) => Promise<DnaJobStatus>;
}

export function useDnaReport(): UseDnaReportReturn {
  const { execute, isLoading, error } = useApiOperation('useDnaReport');

  const [myStyle, setMyStyle] = useState<DnaReport | null>(null);
  const [myReports, setMyReports] = useState<DnaReport[]>([]);
  const [redactionRules, setRedactionRules] = useState<DnaRedactionRuleSet | null>(null);
  const [settings, setSettingsState] = useState<DnaSettings | null>(null);
  const [job, setJob] = useState<DnaJobStatus | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getMyStyle = useCallback(
    () =>
      execute<DnaReport>('getMyStyle', async (client) => {
        const report = await client.get<DnaReport>(DNA_WRITING_STYLE_ENDPOINTS.MY_STYLE);
        setMyStyle(report);
        return report;
      }),
    [execute],
  );

  const listMyReports = useCallback(
    () =>
      execute<DnaReport[]>('listMyReports', async (client) => {
        const raw = await client.get(DNA_WRITING_STYLE_ENDPOINTS.MINE);
        const items = extractArray<DnaReport>(raw);
        setMyReports(items);
        return items;
      }),
    [execute],
  );

  const getMyRedactionRules = useCallback(
    () =>
      execute<DnaRedactionRuleSet>('getMyRedactionRules', async (client) => {
        const rules = await client.get<DnaRedactionRuleSet>(DNA_WRITING_STYLE_ENDPOINTS.MY_STYLE_REDACTION_RULES);
        setRedactionRules(rules);
        return rules;
      }),
    [execute],
  );

  const getSettings = useCallback(
    () =>
      execute<DnaSettings>('getSettings', async (client) => {
        const data = await client.get<DnaSettings>(DNA_WRITING_STYLE_ENDPOINTS.SETTINGS);
        setSettingsState(data);
        return data;
      }),
    [execute],
  );

  const updateReport = useCallback(
    (reportId: string, input: DnaUpdateInput, expectedVersion: number) =>
      execute<DnaReport>('updateReport', async (client) => {
        const updated = await client.patchWithIfMatch<DnaReport>(
          DNA_WRITING_STYLE_ENDPOINTS.UPDATE_REPORT(reportId),
          input,
          ifMatchFor(expectedVersion),
        );
        setMyStyle(updated);
        return updated;
      }),
    [execute],
  );

  const setSettings = useCallback(
    (input: DnaSettingsUpdateInput, currentVersion = 0) =>
      execute<DnaSettings>('setSettings', async (client) => {
        // `expectedVersion` carries `@Min(1)` server-side, so the pre-first-write
        // `0` must be OMITTED from the body — `If-Match` still carries the real
        // `"0"` create-intent validator regardless.
        const body = currentVersion >= 1 ? { ...input, expectedVersion: currentVersion } : input;
        const updated = await client.putWithIfMatch<DnaSettings>(DNA_WRITING_STYLE_ENDPOINTS.SETTINGS, body, ifMatchFor(currentVersion));
        setSettingsState(updated);
        return updated;
      }),
    [execute],
  );

  const generate = useCallback(
    (input: DnaGenerateInput = {}) =>
      execute<DnaGenerateJobResponse>('generate', async (client) => {
        const data = await client.post<DnaGenerateJobResponse>(DNA_WRITING_STYLE_ENDPOINTS.GENERATE, input);
        setJob({ jobId: data.jobId, status: 'queued' });
        return data;
      }),
    [execute],
  );

  const getJobStatus = useCallback(
    (jobId: string) =>
      execute<DnaJobStatus>('getJobStatus', async (client) => {
        const data = await client.get<DnaJobStatus>(DNA_WRITING_STYLE_ENDPOINTS.JOB(jobId));
        setJob(data);
        return data;
      }),
    [execute],
  );

  const pollJobStatus = useCallback(
    (jobId: string, options?: PollDnaJobOptions) => {
      const intervalMs = options?.intervalMs ?? 2000;
      const timeoutMs = options?.timeoutMs ?? 120000;
      const deadline = Date.now() + timeoutMs;

      return execute<DnaJobStatus>(
        'pollJobStatus',
        (client) =>
          new Promise<DnaJobStatus>((resolve, reject) => {
            const poll = async () => {
              try {
                const data = await client.get<DnaJobStatus>(DNA_WRITING_STYLE_ENDPOINTS.JOB(jobId));
                setJob(data);

                if (TERMINAL_JOB_STATUSES.has(data.status)) {
                  resolve(data);
                  return;
                }

                if (Date.now() >= deadline) {
                  reject(new Error(`Polling DNA job "${jobId}" exceeded timeout of ${timeoutMs}ms`));
                  return;
                }

                pollTimerRef.current = setTimeout(poll, intervalMs);
              } catch (err) {
                reject(err);
              }
            };

            poll();
          }),
        false,
      );
    },
    [execute],
  );

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  return useMemo(
    () => ({
      myStyle,
      myReports,
      redactionRules,
      settings,
      job,
      isLoading,
      error,
      getMyStyle,
      listMyReports,
      getMyRedactionRules,
      getSettings,
      updateReport,
      setSettings,
      generate,
      getJobStatus,
      pollJobStatus,
    }),
    [
      myStyle,
      myReports,
      redactionRules,
      settings,
      job,
      isLoading,
      error,
      getMyStyle,
      listMyReports,
      getMyRedactionRules,
      getSettings,
      updateReport,
      setSettings,
      generate,
      getJobStatus,
      pollJobStatus,
    ],
  );
}
