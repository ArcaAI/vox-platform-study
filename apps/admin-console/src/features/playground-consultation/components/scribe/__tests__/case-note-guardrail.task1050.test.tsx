/**
 * TASK-1050 W3b — the case note column's guardrail surfaces:
 *   - Sign & save with outstanding warnings shows them in a confirm step, then approves with
 *     `acknowledgeGuardrailNotices: true` in ONE action — it never blocks on warnings (README §9.8.3);
 *   - without warnings it signs directly, as before;
 *   - the guardrail slot (block panel / banner) and header badge render where the note is.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES, type GuardrailNotice } from '@arcaai/types';
import { CaseNoteColumn } from '../case-note-column';
import type { SummaryResult } from '../../../api';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

afterEach(cleanup);

const DRAFT: SummaryResult = { id: 'note-1', consultationId: 'c-1', type: 'summary', content: 'S: stable.', version: 2 };

const warning: GuardrailNotice = {
  schemaVersion: 1,
  noticeId: 'w-1',
  type: 'guardrail.warning',
  direction: 'outbound',
  action: 'warn',
  checks: [{ checkId: 'clinical_safety_judge', category: 'dangerous_dosing', severity: 'high' }],
  itemIds: ['note-1'],
  messageKey: 'guardrail.warning.generic',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'],
  requiresAcknowledgement: true,
  resumable: false,
  policyVersion: 'pv',
  occurredAt: '2026-10-07T09:15:00.000Z',
};

function props(overrides: Partial<React.ComponentProps<typeof CaseNoteColumn>> = {}): React.ComponentProps<typeof CaseNoteColumn> {
  return {
    hasConsultation: true,
    isRecording: false,
    live: null,
    draft: DRAFT,
    draftLoading: false,
    progress: null,
    assurance: null,
    onGenerate: null,
    generatePending: false,
    onApprove: vi.fn(),
    approvePending: false,
    approved: false,
    ...overrides,
  };
}

describe('CaseNoteColumn — guardrail', () => {
  it('shows outstanding warnings in the sign confirm step, then approves and acknowledges in one action', () => {
    const onApprove = vi.fn();
    render(<CaseNoteColumn {...props({ onApprove, approveWarnings: [warning] })} />);
    fireEvent.click(screen.getByRole('button', { name: /sign & save/i }));
    expect(onApprove).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/Clinical safety/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: /acknowledge and sign/i }));
    expect(onApprove).toHaveBeenCalledWith({ overrideSafetyFlag: false, acknowledgeGuardrailNotices: true });
  });

  it('signs directly when there is nothing outstanding', () => {
    const onApprove = vi.fn();
    render(<CaseNoteColumn {...props({ onApprove })} />);
    fireEvent.click(screen.getByRole('button', { name: /sign & save/i }));
    expect(onApprove).toHaveBeenCalledWith({ overrideSafetyFlag: false });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('disables signing during a hold with a visible reason', () => {
    render(<CaseNoteColumn {...props({ approveDisabledReason: 'Resolve the guardrail hold before signing.' })} />);
    expect((screen.getByRole('button', { name: /sign & save/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Resolve the guardrail hold before signing.')).toBeDefined();
  });

  it('renders the guardrail slot inside the note and the badge in its header', () => {
    render(<CaseNoteColumn {...props({ guardrailSlot: <div>slot-content</div>, guardrailBadge: <span>badge-content</span> })} />);
    const note = screen.getByRole('region', { name: 'Case note' });
    expect(within(note).getByText('slot-content')).toBeDefined();
    expect(within(note).getByText('badge-content')).toBeDefined();
  });

  it('an INBOUND hold offers "Resolve & sign" with only the allowed resolutions, in one action', () => {
    const onApprove = vi.fn();
    const hold: GuardrailNotice = {
      ...warning,
      noticeId: 'b-1',
      type: 'guardrail.blocked',
      action: 'block',
      direction: 'inbound',
      checks: [{ checkId: 'injection_judge', category: 'instruction_override', severity: 'high' }],
      messageKey: 'guardrail.blocked.inbound',
      defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.inbound'],
      requiresAcknowledgement: false,
      resumable: true,
    };
    render(<CaseNoteColumn {...props({ onApprove, approveHold: { notice: hold, resolutions: ['item_excluded', 'acknowledged'] } })} />);
    fireEvent.click(screen.getByRole('button', { name: /sign & save/i }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/Prompt injection/)).toBeDefined();
    expect(within(dialog).getByRole('button', { name: /override once, resolve & sign/i })).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: /exclude the flagged content, resolve & sign/i }));
    expect(onApprove).toHaveBeenCalledWith({
      overrideSafetyFlag: false,
      acknowledgeGuardrailNotices: true,
      resolveHold: { noticeId: 'b-1', resolution: 'item_excluded' },
    });
  });

  it('the locked medical hold offers only "exclude" in the resolve-and-sign step', () => {
    const hold: GuardrailNotice = {
      ...warning,
      noticeId: 'b-2',
      type: 'guardrail.blocked',
      action: 'block',
      direction: 'inbound',
      checks: [{ checkId: 'medical_validation', severity: 'high' }],
      messageKey: 'guardrail.blocked.not_medical',
      defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.not_medical'],
      requiresAcknowledgement: false,
      resumable: true,
    };
    render(<CaseNoteColumn {...props({ approveHold: { notice: hold, resolutions: ['item_excluded'] } })} />);
    fireEvent.click(screen.getByRole('button', { name: /sign & save/i }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).queryByRole('button', { name: /override/i })).toBeNull();
    expect(within(dialog).getByRole('button', { name: /exclude the flagged content, resolve & sign/i })).toBeDefined();
  });
});
