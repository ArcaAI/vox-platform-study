/**
 * `governingRunOf` — the ONE derivation of a consultation's governing-run summary.
 *
 * Every surface that answers "which run is documenting this consultation, and did it work?"
 * reads the same persisted marker through this function: the consultation response, the
 * `GET consultations/:id/workflow` route, and both SDKs. A second reader would eventually
 * disagree about what an absent `runStatus` means, which is the one thing that must not vary:
 * a marker written before the terminal fields existed, and a run still in flight, are the same
 * fact — RUNNING.
 */
import { describe, expect, it } from 'vitest';
import { governingRunOf, withGoverningEngineMarker } from '../governing-engine';

const RUN = '018f0000-0000-7000-8000-000000000001';
const SLUG = 'arcaai-consultation-v1';

function marker(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    governingEngine: { engine: 'tenant-workflow', workflowRunId: RUN, workflowDefinitionSlug: SLUG, decidedAt: '2026-09-17T09:00:00.000Z', ...extra },
  };
}

describe('governingRunOf', () => {
  it('answers null for an ungoverned consultation, and for every malformed marker', () => {
    expect(governingRunOf(null)).toBeNull();
    expect(governingRunOf({})).toBeNull();
    expect(governingRunOf({ governingEngine: { engine: 'tenant-workflow' } })).toBeNull();
    expect(governingRunOf({ governingEngine: { engine: 'something-else', workflowRunId: RUN } })).toBeNull();
  });

  it('reads a marker with no terminal fields as RUNNING, not as unknown', () => {
    expect(governingRunOf(marker())).toEqual({
      workflowDefinitionSlug: SLUG,
      workflowRunId: RUN,
      status: 'RUNNING',
      degraded: false,
      decidedAt: '2026-09-17T09:00:00.000Z',
      failureReason: null,
    });
  });

  it('carries the terminal status and its reason once the watcher has stamped them', () => {
    expect(
      governingRunOf(marker({ runStatus: 'FAILED', terminalReason: 'n_output failed its schema', endedAt: '2026-09-17T09:12:00.000Z' })),
    ).toMatchObject({
      status: 'FAILED',
      failureReason: 'n_output failed its schema',
      degraded: false,
    });
  });

  it('carries the degraded FLAG on a COMPLETED run — degraded is never a status', () => {
    expect(governingRunOf(marker({ runStatus: 'COMPLETED', degraded: true }))).toMatchObject({
      status: 'COMPLETED',
      degraded: true,
      failureReason: null,
    });
  });

  it('rejects a status outside the PERSISTED vocabulary — the interpreter words never leak', () => {
    expect(governingRunOf(marker({ runStatus: 'SUCCEEDED' })).status).toBe('RUNNING');
    expect(governingRunOf(marker({ runStatus: 'DEGRADED' })).status).toBe('RUNNING');
  });

  it('accepts every persisted terminal status', () => {
    for (const status of ['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT'] as const) {
      expect(governingRunOf(marker({ runStatus: status })).status).toBe(status);
    }
  });

  it('derives from what `withGoverningEngineMarker` actually writes', () => {
    const summary = governingRunOf(withGoverningEngineMarker({ patientRef: 'keep-me' }, { workflowRunId: RUN, workflowDefinitionSlug: SLUG }));

    expect(summary).toMatchObject({ workflowRunId: RUN, workflowDefinitionSlug: SLUG, status: 'RUNNING', degraded: false, failureReason: null });
    expect(typeof summary!.decidedAt).toBe('string');
  });
});
