/**
 * TASK-932 D-9 — the `presummary` fold.
 *
 * The stream itself is `useEventStream`, already covered; what has a RULE in it is the fold, and
 * the rule exists because SSE makes no ordering guarantee. A `running` event that lands after
 * `ready` would take a rendered pre-summary off the clinician's screen and replace it with a
 * skeleton — the same class of defect as a stale `section.patch` overwriting a newer one, which
 * `useDocumentSectionsStream` guards with its revision check.
 *
 * The other half is that this feed shares its channel with two unrelated payloads: the
 * undiscriminated whole-document `LiveSummaryEventDto` and `section.patch`. A fold that read any
 * of them would show a pre-summary made of somebody else's note.
 */
import { describe, expect, it } from 'vitest';

import { foldPreSummaryEvent, reconcilePreSummaryFromLatest, type PreSummaryView } from '../hooks';
import type { SummaryResult } from '../types';

const READY: PreSummaryView = { status: 'ready', content: '- Diabetes (recorded 11-Aug-2026)', error: null, agentSlug: 'case-notes-pre-summary', updatedAt: '2026-09-09T10:00:01.000Z' };

const event = (fields: Record<string, unknown>) => JSON.stringify({ event: 'presummary', ...fields });

describe('TASK-932 — foldPreSummaryEvent', () => {
  it('takes the first `running` event, so the panel can say "working" instead of showing nothing', () => {
    const next = foldPreSummaryEvent(null, event({ status: 'running', agentSlug: 'case-notes-pre-summary', updatedAt: '2026-09-09T10:00:00.000Z' }));
    expect(next).toEqual({ status: 'running', content: null, error: null, agentSlug: 'case-notes-pre-summary', updatedAt: '2026-09-09T10:00:00.000Z' });
  });

  it('takes `ready` over `running`, carrying the content', () => {
    const running = foldPreSummaryEvent(null, event({ status: 'running' }));
    const next = foldPreSummaryEvent(running, event({ status: 'ready', content: 'x', updatedAt: '2026-09-09T10:00:01.000Z' }));
    expect(next).toMatchObject({ status: 'ready', content: 'x' });
  });

  it('takes `degraded` over `running`, carrying the PHI-safe reason and no content', () => {
    const running = foldPreSummaryEvent(null, event({ status: 'running' }));
    const next = foldPreSummaryEvent(running, event({ status: 'degraded', error: 'no_case_notes' }));
    expect(next).toMatchObject({ status: 'degraded', error: 'no_case_notes', content: null });
  });

  it('NEVER lets a late `running` displace a terminal state — the rendered pre-summary stays', () => {
    expect(foldPreSummaryEvent(READY, event({ status: 'running' }))).toBe(READY);
    const degraded = foldPreSummaryEvent(null, event({ status: 'degraded', error: 'no_case_notes' }));
    expect(foldPreSummaryEvent(degraded, event({ status: 'running' }))).toBe(degraded);
  });

  it('a second terminal event DOES replace the first — a retry that succeeds must be shown', () => {
    const degraded = foldPreSummaryEvent(null, event({ status: 'degraded', error: 'pre_summary_failed' }));
    const next = foldPreSummaryEvent(degraded, event({ status: 'ready', content: 'x' }));
    expect(next).toMatchObject({ status: 'ready', content: 'x' });
  });

  it('remembers the agent slug across an event that omits it', () => {
    const running = foldPreSummaryEvent(null, event({ status: 'running', agentSlug: 'case-notes-pre-summary' }));
    expect(foldPreSummaryEvent(running, event({ status: 'ready', content: 'x' }))?.agentSlug).toBe('case-notes-pre-summary');
  });

  it('ignores every other payload on the shared channel', () => {
    // The legacy whole-document snapshot carries NO `event` discriminator at all.
    expect(foldPreSummaryEvent(null, JSON.stringify({ consultationId: 'c-1', runningSummary: 'S: cough', sections: [] }))).toBeNull();
    // …and a section patch carries a different one.
    expect(foldPreSummaryEvent(null, JSON.stringify({ event: 'section.patch', documentKey: 'soap_note', sectionKey: 'subjective' }))).toBeNull();
    // Malformed JSON, and an unknown status, both leave the current view alone.
    expect(foldPreSummaryEvent(READY, 'not json')).toBe(READY);
    expect(foldPreSummaryEvent(READY, event({ status: 'thinking' }))).toBe(READY);
  });
});

/**
 * TASK-932 C1-2 — `usePreSummaryStream`'s REST catch-up.
 *
 * A `presummary` event published before the SSE stream subscribes is lost outright (observed
 * live, a 30ms window) — there is no replay, so a late mount or a full page refresh would show
 * nothing even though a `ready` pre-summary already landed. `getLatestPreSummary` reads the SAME
 * persisted row a `ready` SSE event describes, so reconciling it in is a matter of never letting a
 * REST read regress state the SSE fold has already produced.
 */
const latestPreSummary = (fields: Partial<SummaryResult> = {}): SummaryResult => ({
  id: 'ctx-9',
  consultationId: 'c-1',
  type: 'pre_summary',
  content: '- Diabetes (recorded 11-Aug-2026)',
  updatedAt: '2026-09-09T10:00:01.000Z',
  version: 1,
  ...fields,
});

describe('TASK-932 — reconcilePreSummaryFromLatest (usePreSummaryStream REST catch-up)', () => {
  it('seeds from the REST catch-up when no SSE event has arrived', () => {
    const latest = latestPreSummary();
    expect(reconcilePreSummaryFromLatest(null, latest)).toEqual({
      status: 'ready',
      content: latest.content,
      error: null,
      agentSlug: null,
      updatedAt: latest.updatedAt,
    });
  });

  it('a REST read is never applied once an equal-or-newer SSE event landed', () => {
    const running: PreSummaryView = {
      status: 'running',
      content: null,
      error: null,
      agentSlug: 'case-notes-pre-summary',
      updatedAt: '2026-09-09T10:00:02.000Z',
    };
    // The REST answer is OLDER than the running state's own `updatedAt`.
    const olderLatest = latestPreSummary({ updatedAt: '2026-09-09T10:00:00.000Z' });
    expect(reconcilePreSummaryFromLatest(running, olderLatest)).toBe(running);

    // Equal `updatedAt` also does not regress — there is nothing newer to reconcile in.
    const equalLatest = latestPreSummary({ updatedAt: running.updatedAt! });
    expect(reconcilePreSummaryFromLatest(running, equalLatest)).toBe(running);
  });

  it('an older REST response never regresses a terminal state', () => {
    const degraded: PreSummaryView = {
      status: 'degraded',
      content: null,
      error: 'no_case_notes',
      agentSlug: 'case-notes-pre-summary',
      updatedAt: '2026-09-09T10:00:05.000Z',
    };
    const olderLatest = latestPreSummary({ updatedAt: '2026-09-09T10:00:01.000Z' });
    expect(reconcilePreSummaryFromLatest(degraded, olderLatest)).toBe(degraded);
    expect(reconcilePreSummaryFromLatest(READY, olderLatest)).toBe(READY);
  });

  it('upgrades a `running` state whose `updatedAt` is strictly older than the REST answer', () => {
    const running: PreSummaryView = {
      status: 'running',
      content: null,
      error: null,
      agentSlug: 'case-notes-pre-summary',
      updatedAt: '2026-09-09T09:59:00.000Z',
    };
    const latest = latestPreSummary();
    expect(reconcilePreSummaryFromLatest(running, latest)).toEqual({
      status: 'ready',
      content: latest.content,
      error: null,
      agentSlug: 'case-notes-pre-summary',
      updatedAt: latest.updatedAt,
    });
  });
});
