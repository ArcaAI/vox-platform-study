/**
 * TASK-985 — the teardown summary, from whichever finalizer got there first (D8 §1.5), and the
 * counter that makes its ABSENCE visible (D8 §8 N-5).
 *
 * ## What was wrong
 *
 * Four finalizers converge on one STT session; three of them built the usage summary and threw
 * it away, and the DELETE that is supposed to emit the ledger row answered **204** once any of
 * them had run. So the ordinary clean stop — control `FINALIZE` first, `DELETE` second —
 * produced NO `transcribe.stream` row at all. `removeSession` then treated 204 and "no summary
 * built" identically, with no warn and no counter, which is why the loss required a code read
 * to find rather than showing up on a dashboard.
 *
 * The STT-side fix is a teardown-summary STASH that makes that DELETE answer 200 with the
 * summary the earlier finalizer built (lane L-STT). This side already reads a 200 as the
 * emitting case — these tests pin that it does, and that every path which still emits nothing is
 * counted and warned rather than silent.
 */
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingSessionService } from '../streamingSession.service';
import { sttStreamTeardownSummaryMissingTotal } from '../stt-gateway.metrics';

/* eslint-disable @typescript-eslint/no-explicit-any */
const configWithSttUrl = (url: string): any => ({ config: { STT_URL: url } });

const summary = (overrides: Record<string, unknown> = {}) => ({
  session_id: 's-1',
  tenant_id: 'tenant-1',
  consultation_id: 'consult-1',
  user_id: 'doctor-1',
  pipeline_id: 'pipeline-9',
  closed_at: '2026-09-18T10:01:30',
  audio_seconds: 42.5,
  session_seconds: 90,
  engine: 'whisper_cpp',
  deployment: 'SELF_HOSTED',
  language_mode: 'ml-en',
  ...overrides,
});

const counterTotal = async (labels?: Record<string, string>): Promise<number> => {
  const data = await sttStreamTeardownSummaryMissingTotal.get();
  const matching = data.values.filter((v: any) => !labels || Object.entries(labels).every(([k, val]) => v.labels?.[k] === val));
  return matching.reduce((sum: number, v: any) => sum + v.value, 0);
};

describe('TASK-985 — teardown summary handling', () => {
  let httpService: any;
  let ledger: { recordUsage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    httpService = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
    ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
  });

  const build = () => new StreamingSessionService(httpService, configWithSttUrl('http://stt.internal:9000'), ledger as any);

  it('a 200 carrying a STASHED summary emits exactly one row, with the GATEWAY’s interrupted verdict', async () => {
    // This is the clean-stop sequence the stash restores: an earlier finalizer already tore the
    // session down, so the summary reaching us here is the stashed one — and `interrupted` is
    // still ours to decide, because STT has no notion of it.
    httpService.delete.mockReturnValue(of({ status: 200, data: summary() }));

    await build().removeSession('s-1', /* interrupted */ false, 'tenant-1');

    expect(ledger.recordUsage).toHaveBeenCalledTimes(1);
    expect(ledger.recordUsage.mock.calls[0][0].common.attributesJson.interrupted).toBe(false);
  });

  it('the same stashed summary bills as INTERRUPTED when the gateway says the session was aborted', async () => {
    httpService.delete.mockReturnValue(of({ status: 200, data: summary() }));

    await build().removeSession('s-1', /* interrupted */ true, 'tenant-1');

    expect(ledger.recordUsage.mock.calls[0][0].common.attributesJson.interrupted).toBe(true);
  });

  it('a 204 emits nothing, and is COUNTED and WARNed instead of passing silently', async () => {
    const before = await counterTotal({ status: '204' });
    httpService.delete.mockReturnValue(of({ status: 204, data: undefined }));

    await build().removeSession('s-1', false, 'tenant-1');

    expect(ledger.recordUsage).not.toHaveBeenCalled();
    expect(await counterTotal({ status: '204' })).toBe(before + 1);
  });

  it('a summary with no billable segment is counted separately — it is a different diagnosis', async () => {
    // A session that failed before any model loaded legitimately bills nothing. A session that
    // transcribed and reports no segment is a metering outage. One counter, two `status`
    // values, so the two are separable without a code read.
    const before = await counterTotal({ status: 'no-segments' });
    httpService.delete.mockReturnValue(of({ status: 200, data: summary({ engine: null, deployment: null, segments: [] }) }));

    await build().removeSession('s-1', false, 'tenant-1');

    expect(ledger.recordUsage).not.toHaveBeenCalled();
    expect(await counterTotal({ status: 'no-segments' })).toBe(before + 1);
  });

  it('an idempotent 404 ("already removed") is NOT counted — there is genuinely nothing to bill', async () => {
    const before = await counterTotal();
    httpService.delete.mockReturnValue(throwError(() => ({ response: { status: 404 } })));

    await build().removeSession('s-1', false, 'tenant-1');

    expect(await counterTotal()).toBe(before);
  });
});
