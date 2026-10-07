/**
 * TASK-1050 W3b — the LLM playground's guardrail outcomes:
 *   - a WARN shows the notice banner ABOVE the output, and the output stays;
 *   - a BLOCK keeps the fail-closed panel, now naming the check and direction from the notice;
 *   - EGRESS_REDACTION_UNAVAILABLE gets its own, retryable panel.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES, type GuardrailNotice } from '@arcaai/types';
import { GatewayError } from '@/shared/api';
import { OutputPane, runStateFromGenerateError, runStateFromGenerateResult, type RunState } from '../output-pane';
import type { TaskStreamState } from '../../api/use-task-stream';

afterEach(() => cleanup());

const warning: GuardrailNotice = {
  schemaVersion: 1,
  noticeId: 'w-1',
  type: 'guardrail.warning',
  direction: 'outbound',
  action: 'warn',
  checks: [{ checkId: 'clinical_safety_judge', category: 'dangerous_dosing', severity: 'high' }],
  itemIds: [],
  messageKey: 'guardrail.warning.generic',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'],
  requiresAcknowledgement: false,
  resumable: false,
  policyVersion: 'pv',
  occurredAt: '2026-10-07T09:15:00.000Z',
};

const blocked: GuardrailNotice = {
  ...warning,
  noticeId: 'b-1',
  type: 'guardrail.blocked',
  direction: 'inbound',
  action: 'block',
  checks: [{ checkId: 'injection_judge', category: 'instruction_override', severity: 'high' }],
  messageKey: 'guardrail.blocked.inbound',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.inbound'],
};

const idleStream: TaskStreamState = {
  status: 'idle',
  content: '',
  reasoning: '',
  chunkCount: 0,
  usage: null,
  finishReason: null,
  error: null,
  guardrailNotices: [],
  reopen: () => undefined,
  close: () => undefined,
};

function renderPane(run: RunState, onRetry = vi.fn(), stream: TaskStreamState = idleStream) {
  render(
    <OutputPane
      run={run}
      stream={stream}
      isPending={false}
      postMortem={undefined}
      streamProviderModel=""
      onCancel={vi.fn()}
      cancelPending={false}
      onRetry={onRetry}
      onReattach={vi.fn()}
    />,
  );
  return onRetry;
}

const syncResult = {
  task_id: 't',
  status: 'completed',
  content: 'Generated note text',
  provider: 'lm-studio',
  model: 'm',
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  latency_ms: 10,
  finish_reason: 'stop',
  created_at: '2026-10-07T09:15:00.000Z',
};

describe('LLM playground guardrail outcomes', () => {
  it('a warn shows the banner above the output and keeps the output', () => {
    renderPane(runStateFromGenerateResult({ ...syncResult, guardrailNotices: [warning] }));
    const banner = document.querySelector<HTMLElement>('[data-slot="guardrail-notice-banner"]');
    if (!banner) throw new Error('no banner');
    expect(within(banner).getByText(/Clinical safety/)).toBeDefined();
    expect(within(banner).getByText(/dangerous dosing/)).toBeDefined();
    expect(screen.getByText('Generated note text')).toBeDefined();
    expect(banner.compareDocumentPosition(screen.getByText('Generated note text')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a block keeps the fail-closed panel and names the check and the direction', () => {
    const run = runStateFromGenerateError(
      new GatewayError(422, 'blocked', undefined, {
        code: 'CONTENT_BLOCKED',
        type: 'urn:hope:problem:guardrail-blocked',
        guardrailNotice: blocked,
        detail: 'Blocked by guardrail.',
      }),
    );
    expect(run?.kind).toBe('fail-closed');
    renderPane(run as RunState);
    const panel = screen.getByRole('alert');
    expect(within(panel).getByText(/422, text-generation fail-closed/)).toBeDefined();
    expect(within(panel).getByText(/Prompt injection/)).toBeDefined();
    expect(within(panel).getByText(/Inbound/)).toBeDefined();
  });

  it('EGRESS_REDACTION_UNAVAILABLE gets a distinct retryable panel', () => {
    const run = runStateFromGenerateError(new GatewayError(503, 'x', undefined, { code: 'EGRESS_REDACTION_UNAVAILABLE', retryable: true }));
    expect(run?.kind).toBe('redaction-unavailable');
    const onRetry = renderPane(run as RunState);
    const panel = screen.getByRole('alert');
    expect(within(panel).getByText('Paused: patient details could not be protected')).toBeDefined();
    expect(within(panel).queryByText(/422/)).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('keeps the legacy 422 mapping for a non-guardrail fail-closed code, and leaves other errors to the toast', () => {
    expect(runStateFromGenerateError(new GatewayError(422, 'x', undefined, { error_code: 'MODEL_NOT_SELECTED', detail: 'fixed' }))).toEqual({
      kind: 'fail-closed',
      message: 'fixed',
      code: 'MODEL_NOT_SELECTED',
    });
    expect(runStateFromGenerateError(new GatewayError(500, 'boom'))).toBeNull();
  });

  it('a streaming warn shows the banner above the streamed output (task stream notices)', () => {
    renderPane({ kind: 'stream', taskId: 't-1' }, vi.fn(), { ...idleStream, status: 'done', content: 'Streamed note', guardrailNotices: [warning] });
    const banner = document.querySelector<HTMLElement>('[data-slot="guardrail-notice-banner"]');
    if (!banner) throw new Error('no banner');
    expect(within(banner).getByText(/Clinical safety/)).toBeDefined();
    expect(screen.getByText('Streamed note')).toBeDefined();
  });

  it('a streaming block names the check instead of the bare upstream failure', () => {
    renderPane({ kind: 'stream', taskId: 't-1' }, vi.fn(), { ...idleStream, status: 'failed', error: 'Blocked', guardrailNotices: [blocked] });
    const panel = document.querySelector<HTMLElement>('[data-slot="guardrail-block-panel"]');
    if (!panel) throw new Error('no block panel');
    expect(within(panel).getByText(/Prompt injection/)).toBeDefined();
    expect(screen.queryByText(/Upstream failure/)).toBeNull();
  });
});
