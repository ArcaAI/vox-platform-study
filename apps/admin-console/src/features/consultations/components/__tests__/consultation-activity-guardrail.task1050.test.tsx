/**
 * TASK-1050 W3b — consultation details gains a Guardrail tab (line tabs per the Screen Template), the
 * hold banner when the consultation is held, the Guardrail stat card and per-item guardrail badges.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES } from '@arcaai/types';
import { renderWithProviders } from '@/test/render';
import { ConsultationActivityScreen } from '../activity/consultation-activity-screen';

vi.mock('@arcaai/ui/components/timeline/renderers/image-grid-renderer', () => ({ ImageGridRenderer: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

beforeAll(() => {
  const box = (height: number) => ({ width: 800, height, top: 0, left: 0, right: 800, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return box(this.hasAttribute('data-index') ? 100 : 600);
  };
});

const BLOCK = {
  schemaVersion: 1,
  noticeId: 'n-block',
  type: 'guardrail.blocked',
  direction: 'inbound',
  action: 'block',
  checks: [{ checkId: 'injection_judge', category: 'instruction_override', severity: 'high' }],
  itemIds: ['note-1'],
  messageKey: 'guardrail.blocked.inbound',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.inbound'],
  requiresAcknowledgement: false,
  resumable: true,
  policyVersion: 'pv',
  occurredAt: '2026-10-07T09:15:00.000Z',
  status: 'open',
};

function page(processingReason?: string) {
  return {
    consultationId: 'c-1',
    status: 'PAUSED',
    processing: processingReason ? 'AWAITING_REVIEW' : 'IDLE',
    ...(processingReason ? { processingReason } : {}),
    encounters: [
      {
        seq: 1,
        visitType: 'new',
        externalRef: null,
        startedAt: '2026-10-07T09:00:00.000Z',
        endedAt: null,
        recordingStartMs: 0,
        recordingEndMs: null,
      },
    ],
    items: [
      {
        entryType: 'item',
        id: 'note-1',
        kind: 'NOTE',
        encounterSeq: 1,
        occurredAt: '2026-10-07T09:16:00.000Z',
        source: 'ai',
        latestVersion: { number: 1, content: 'Plan: rest', changeSource: 'ai', changedBy: null, createdAt: '2026-10-07T09:16:00.000Z' },
        versionCount: 1,
        edited: false,
      },
    ],
    nextCursor: null,
    hasMore: false,
    aggregates: {
      aiRunCount: 1,
      tokensIn: 1,
      tokensOut: 1,
      costMicros: 0,
      costBasis: [],
      editedItems: 0,
      feedbackUp: 0,
      feedbackDown: 0,
      guardrail: { evaluations: 5, warn: 1, block: 1, unverified: 0, openNotices: 1 },
    },
  };
}

function stub(processingReason?: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://t').pathname;
      if (path === '/api/hope/admin/consultations/c-1/activity') return Response.json(page(processingReason));
      if (path === '/api/hope/admin/consultations/c-1/guardrail-evaluations')
        return Response.json({ consultationId: 'c-1', items: [], nextCursor: null, hasMore: false, limit: 100 });
      if (path === '/api/hope/consultations/c-1/guardrail-notices') return Response.json({ notices: [BLOCK], unacknowledgedNoticeIds: [] });
      if (path === '/api/hope/users/me/settings') return Response.json([]);
      return Response.json({});
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConsultationActivityScreen — guardrail', () => {
  it('offers Activity and Guardrail tabs; the Guardrail tab shows notices and the evaluation grid', async () => {
    stub();
    renderWithProviders(<ConsultationActivityScreen consultationId="c-1" />);
    const tab = await screen.findByRole('tab', { name: /guardrail/i });
    expect(screen.getByRole('tab', { name: /activity/i })).toBeDefined();
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    expect(await screen.findByRole('grid', { name: /guardrail evaluations/i })).toBeDefined();
    expect(screen.getByRole('region', { name: /guardrail notices/i })).toBeDefined();
  });

  it('shows the Guardrail stat card and the per-item badge', async () => {
    stub();
    renderWithProviders(<ConsultationActivityScreen consultationId="c-1" />);
    expect(await screen.findByText(/5 checked/)).toBeDefined();
    await waitFor(() => expect(screen.getByText('Guardrail: 1 blocked')).toBeDefined());
  });

  it('shows the hold banner with Resume when the consultation is held', async () => {
    stub('GUARDRAIL_HOLD');
    renderWithProviders(<ConsultationActivityScreen consultationId="c-1" />);
    expect(await screen.findByRole('button', { name: /exclude the flagged content/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /override and continue once/i })).toBeDefined();
  });
});
