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

import { foldPreSummaryEvent, type PreSummaryView } from '../hooks';

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
