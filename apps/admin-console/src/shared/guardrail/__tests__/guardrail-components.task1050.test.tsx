/**
 * TASK-1050 W3b — the shared guardrail surfaces: the warning banner, the block panel (with only the
 * allowed Resume actions), the final-note warning dialog, and the notice list. Every one renders copy
 * keyed by `messageKey` and names checks/categories — never content.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES, type GuardrailNotice } from '@arcaai/types';
import { GuardrailBlockPanel } from '../guardrail-block-panel';
import { GuardrailItemBadge } from '../guardrail-item-badge';
import { GuardrailNoticeBanner } from '../guardrail-notice-banner';
import { GuardrailNoticeList } from '../guardrail-notice-list';
import { GuardrailWarningDialog } from '../guardrail-warning-dialog';

afterEach(() => cleanup());

const warning: GuardrailNotice = {
  schemaVersion: 1,
  noticeId: 'w-1',
  type: 'guardrail.warning',
  direction: 'inbound',
  action: 'warn',
  checks: [{ checkId: 'unsafe_content_judge', category: 'violence', severity: 'medium' }],
  itemIds: ['i-1'],
  messageKey: 'guardrail.warning.generic',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'],
  requiresAcknowledgement: true,
  resumable: false,
  policyVersion: 'pv',
  occurredAt: '2026-10-07T09:15:00.000Z',
};

const blockedOutbound: GuardrailNotice = {
  ...warning,
  noticeId: 'b-1',
  type: 'guardrail.blocked',
  direction: 'outbound',
  action: 'block',
  checks: [{ checkId: 'leakage_judge', category: 'system_prompt', severity: 'high' }],
  messageKey: 'guardrail.blocked.outbound',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.outbound'],
  requiresAcknowledgement: false,
  resumable: true,
};

const notMedical: GuardrailNotice = {
  ...blockedOutbound,
  noticeId: 'b-2',
  direction: 'inbound',
  checks: [{ checkId: 'medical_validation', severity: 'high' }],
  messageKey: 'guardrail.blocked.not_medical',
  defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.not_medical'],
};

describe('GuardrailNoticeBanner', () => {
  it('lists each check and category with the messageKey copy, once per noticeId', () => {
    render(<GuardrailNoticeBanner notices={[warning, warning, { ...warning, defaultMessage: 'raw patient text' } as GuardrailNotice]} />);
    const banner = screen.getByRole('status');
    expect(within(banner).getAllByText(GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'])).toHaveLength(1);
    expect(within(banner).getByText(/Unsafe content/)).toBeDefined();
    expect(within(banner).getByText(/violence/)).toBeDefined();
    expect(screen.queryByText('raw patient text')).toBeNull();
  });

  it('renders nothing without a valid warning', () => {
    const { container } = render(<GuardrailNoticeBanner notices={[]} />);
    expect(container.textContent).toBe('');
  });
});

describe('GuardrailBlockPanel', () => {
  it('names the check and the direction, and offers every resolution of a tenant-set block', () => {
    const onResume = vi.fn();
    render(<GuardrailBlockPanel notice={blockedOutbound} onResume={onResume} />);
    const panel = screen.getByRole('alert');
    expect(within(panel).getByText(/Leakage/)).toBeDefined();
    expect(within(panel).getByText(/Outbound/i)).toBeDefined();
    expect(within(panel).getByText(GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.outbound'])).toBeDefined();
    fireEvent.click(within(panel).getByRole('button', { name: /exclude the flagged content/i }));
    expect(onResume).toHaveBeenCalledWith({ noticeId: 'b-1', resolution: 'item_excluded' });
    expect(within(panel).getByRole('button', { name: /edited the flagged content/i })).toBeDefined();
    expect(within(panel).getByRole('button', { name: /override and continue once/i })).toBeDefined();
  });

  it('never offers the override for the locked medical check', () => {
    render(<GuardrailBlockPanel notice={notMedical} onResume={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /override/i })).toBeNull();
    expect(screen.getByRole('button', { name: /exclude the flagged content/i })).toBeDefined();
  });

  it('offers no resume action without a handler, and a retry when given one', () => {
    const onRetry = vi.fn();
    render(<GuardrailBlockPanel notice={blockedOutbound} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: /exclude/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('falls back to the legacy code when no notice was relayed', () => {
    render(<GuardrailBlockPanel notice={null} code="CONTENT_BLOCKED_NOT_MEDICAL" />);
    expect(screen.getByRole('alert').textContent).toMatch(/not classified as clinical/i);
  });
});

describe('GuardrailWarningDialog', () => {
  it('shows the outstanding warnings and acknowledges them in one action', () => {
    const onAcknowledge = vi.fn();
    render(<GuardrailWarningDialog open notices={[warning]} onOpenChange={vi.fn()} onAcknowledge={onAcknowledge} />);
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/Unsafe content/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: /acknowledge and continue/i }));
    expect(onAcknowledge).toHaveBeenCalledWith(['w-1']);
  });
});

describe('GuardrailNoticeList', () => {
  it('lists notices with state and offers acknowledge only for an open warning', () => {
    const onAcknowledge = vi.fn();
    render(
      <GuardrailNoticeList
        notices={[
          { ...warning, status: 'open' },
          { ...warning, noticeId: 'w-2', status: 'acknowledged' },
          { ...blockedOutbound, status: 'open' },
        ]}
        onAcknowledge={onAcknowledge}
      />,
    );
    const buttons = screen.getAllByRole('button', { name: /acknowledge/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onAcknowledge).toHaveBeenCalledWith('w-1');
    expect(screen.getByText('Acknowledged')).toBeDefined();
  });

  it('shows an empty state', () => {
    render(<GuardrailNoticeList notices={[]} />);
    expect(screen.getByText(/no guardrail notices/i)).toBeDefined();
  });
});

describe('GuardrailItemBadge', () => {
  it('labels the item status and counts, and renders nothing for a clean item', () => {
    const { rerender, container } = render(<GuardrailItemBadge status="withheld" />);
    expect(screen.getByText(/withheld/i)).toBeDefined();
    rerender(<GuardrailItemBadge warn={2} block={1} />);
    expect(screen.getByText(/1 blocked/i)).toBeDefined();
    expect(screen.getByText(/2 warnings/i)).toBeDefined();
    rerender(<GuardrailItemBadge status="clean" />);
    expect(container.textContent).toBe('');
  });
});

// ── E: ONE notice per (direction, type, target) lists every check that raised it ─────────────────
const threeChecks: GuardrailNotice['checks'] = [
  { checkId: 'injection_judge', category: 'instruction_override', severity: 'high' },
  { checkId: 'unsafe_content_judge', category: 'violence', severity: 'medium' },
  { checkId: 'leakage_judge', category: 'system_prompt', severity: 'low' },
];

describe('a notice that lists three checks renders all three', () => {
  it('banner: one entry, every check and category', () => {
    render(<GuardrailNoticeBanner notices={[{ ...warning, noticeId: 'w-3', checks: threeChecks }]} />);
    const banner = screen.getByRole('status');
    expect(within(banner).getAllByText(GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'])).toHaveLength(1);
    expect(within(banner).getAllByRole('listitem')).toHaveLength(3);
    expect(within(banner).getByText(/Unsafe content/)).toBeDefined();
    expect(within(banner).getByText(/Leakage/)).toBeDefined();
    expect(within(banner).getByText(/instruction/i)).toBeDefined();
  });

  it('block panel: every check is named, and ONE resume button set serves the whole notice', () => {
    const onResume = vi.fn();
    render(<GuardrailBlockPanel notice={{ ...blockedOutbound, noticeId: 'b-3', checks: threeChecks }} onResume={onResume} />);
    const panel = screen.getByRole('alert');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);
    expect(within(panel).getAllByRole('button', { name: /exclude the flagged content/i })).toHaveLength(1);
    expect(within(panel).getByRole('button', { name: /override/i })).toBeDefined();
  });

  it('block panel: a locked check among the three removes the override for the whole notice', () => {
    const checks: GuardrailNotice['checks'] = [threeChecks[0]!, { checkId: 'medical_validation', severity: 'high' }, threeChecks[2]!];
    render(<GuardrailBlockPanel notice={{ ...blockedOutbound, noticeId: 'b-4', direction: 'inbound', checks }} onResume={vi.fn()} />);
    const panel = screen.getByRole('alert');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);
    expect(within(panel).queryByRole('button', { name: /override/i })).toBeNull();
  });

  it('warning dialog and notice list: each notice shows all its checks', () => {
    const multi = { ...warning, noticeId: 'w-3', checks: threeChecks };
    render(<GuardrailWarningDialog open onOpenChange={vi.fn()} notices={[multi]} onAcknowledge={vi.fn()} />);
    expect(within(screen.getByRole('alertdialog')).getAllByRole('listitem')).toHaveLength(3 + 1);
    cleanup();
    render(<GuardrailNoticeList notices={[multi]} />);
    expect(screen.getAllByText(/severity/)).toHaveLength(3);
  });
});
