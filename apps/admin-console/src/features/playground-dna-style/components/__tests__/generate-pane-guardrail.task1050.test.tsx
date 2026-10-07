/**
 * TASK-1050 W3b — the DNA writing-style generate gets the same guardrail handling as the other
 * playgrounds: a block (the queue call's 422, or a job that failed on a guardrail code / notice) renders
 * the block panel with a retry; a warn on a completed job renders the warning banner.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES, type GuardrailNotice } from '@arcaai/types';
import { GatewayError } from '@/shared/api';
import { GeneratePane } from '../generate-pane';
import { dnaGuardrailFromError, dnaGuardrailFromJob } from '../generate-guardrail';

afterEach(() => cleanup());

const warning: GuardrailNotice = {
  schemaVersion: 1,
  noticeId: 'w-1',
  type: 'guardrail.warning',
  direction: 'outbound',
  action: 'warn',
  checks: [{ checkId: 'leakage_judge', category: 'credential', severity: 'medium' }],
  itemIds: [],
  messageKey: 'guardrail.warning.generic',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'],
  requiresAcknowledgement: false,
  resumable: false,
  policyVersion: 'pv',
  occurredAt: '2026-10-07T09:15:00.000Z',
};

const progress = { job: null, streamStatus: 'idle' as const, isTerminal: false };

function renderPane(props: Partial<Parameters<typeof GeneratePane>[0]> = {}) {
  return render(
    <GeneratePane
      samplesText=""
      onSamplesTextChange={vi.fn()}
      onGenerate={vi.fn()}
      isPending={false}
      gated={false}
      activeJobId={null}
      progress={progress as never}
      {...props}
    />,
  );
}

describe('DNA generate — guardrail', () => {
  it('reads a queue-time 422 block and a job that failed on a guardrail code', () => {
    expect(dnaGuardrailFromError(new GatewayError(422, 'x', undefined, { code: 'CONTENT_BLOCKED_NOT_MEDICAL' }))).toMatchObject({
      block: { code: 'CONTENT_BLOCKED_NOT_MEDICAL' },
    });
    expect(dnaGuardrailFromError(new GatewayError(403, 'x'))).toBeNull();
    expect(dnaGuardrailFromJob({ jobId: 'j', status: 'failed', progress: 100, error: 'CONTENT_BLOCKED' })).toMatchObject({ block: { code: 'CONTENT_BLOCKED' } });
    expect(dnaGuardrailFromJob({ jobId: 'j', status: 'failed', progress: 100, error: 'LLM timeout' })).toBeNull();
    expect(dnaGuardrailFromJob({ jobId: 'j', status: 'completed', progress: 100, result: { guardrailNotices: [warning] } })).toEqual({ block: null, warnings: [warning] });
  });

  it('renders the block panel with a retry', () => {
    const onGenerate = vi.fn();
    renderPane({ onGenerate, guardrail: { block: { notice: null, code: 'CONTENT_BLOCKED' }, warnings: [] } });
    const panel = screen.getByRole('alert');
    expect(within(panel).getByText(/safety check stopped this request/i)).toBeDefined();
    fireEvent.click(within(panel).getByRole('button', { name: /retry/i }));
    expect(onGenerate).toHaveBeenCalled();
  });

  it('renders the warning banner for a completed job', () => {
    renderPane({ guardrail: { block: null, warnings: [warning] } });
    const banner = document.querySelector<HTMLElement>('[data-slot="guardrail-notice-banner"]');
    expect(banner && within(banner).getByText(/Leakage/)).toBeTruthy();
  });
});
