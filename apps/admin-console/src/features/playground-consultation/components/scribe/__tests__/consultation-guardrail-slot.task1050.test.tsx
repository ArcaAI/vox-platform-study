/**
 * TASK-1050 W3b — the note column's guardrail slot: a hold renders the block panel with ONLY the
 * allowed resumes (the locked medical check never offers "acknowledged"); live warnings render the
 * inline banner; the header badge says hold vs warnings.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES, type GuardrailNotice } from '@arcaai/types';
import { ConsultationGuardrailBadge, ConsultationGuardrailSlot } from '../consultation-guardrail-slot';

afterEach(cleanup);

const base: GuardrailNotice = {
  schemaVersion: 1,
  noticeId: 'b-1',
  type: 'guardrail.blocked',
  direction: 'inbound',
  action: 'block',
  checks: [{ checkId: 'medical_validation', severity: 'high' }],
  itemIds: ['seg-1'],
  messageKey: 'guardrail.blocked.not_medical',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.not_medical'],
  requiresAcknowledgement: false,
  resumable: true,
  policyVersion: 'pv',
  occurredAt: '2026-10-07T09:15:00.000Z',
};

describe('ConsultationGuardrailSlot', () => {
  it('a medical hold offers exclude and edit, never the override, and resumes with the choice', () => {
    const onResume = vi.fn();
    render(
      <ConsultationGuardrailSlot
        blocking={base}
        errorBlock={null}
        liveWarnings={[]}
        onResume={onResume}
        resumePending={false}
        pendingResolution={null}
      />,
    );
    expect(screen.queryByRole('button', { name: /override/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /edited the flagged content/i }));
    expect(onResume).toHaveBeenCalledWith({ noticeId: 'b-1', resolution: 'item_edited' });
  });

  it('a tenant-set block also offers the override', () => {
    const tenantBlock: GuardrailNotice = {
      ...base,
      checks: [{ checkId: 'injection_judge', category: 'instruction_override', severity: 'high' }],
      messageKey: 'guardrail.blocked.inbound',
      defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.inbound'],
    };
    render(
      <ConsultationGuardrailSlot
        blocking={tenantBlock}
        errorBlock={null}
        liveWarnings={[]}
        onResume={vi.fn()}
        resumePending={false}
        pendingResolution={null}
      />,
    );
    expect(screen.getByRole('button', { name: /override and continue once/i })).toBeDefined();
  });

  it('live warnings render the inline banner, and nothing renders when clean', () => {
    const warning: GuardrailNotice = {
      ...base,
      noticeId: 'w-1',
      type: 'guardrail.warning',
      action: 'warn',
      checks: [{ checkId: 'unsafe_content_judge', category: 'violence', severity: 'medium' }],
      messageKey: 'guardrail.warning.generic',
      defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'],
      resumable: false,
    };
    const { container, rerender } = render(
      <ConsultationGuardrailSlot
        blocking={null}
        errorBlock={null}
        liveWarnings={[warning]}
        onResume={vi.fn()}
        resumePending={false}
        pendingResolution={null}
      />,
    );
    expect(screen.getByText(/safety check warning on the live summary/i)).toBeDefined();
    rerender(
      <ConsultationGuardrailSlot
        blocking={null}
        errorBlock={null}
        liveWarnings={[]}
        onResume={vi.fn()}
        resumePending={false}
        pendingResolution={null}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('badges a hold over warnings', () => {
    const { rerender } = render(<ConsultationGuardrailBadge held warnings={2} />);
    expect(screen.getByText('Guardrail hold')).toBeDefined();
    rerender(<ConsultationGuardrailBadge held={false} warnings={2} />);
    expect(screen.getByText('2 safety warnings')).toBeDefined();
  });
});
