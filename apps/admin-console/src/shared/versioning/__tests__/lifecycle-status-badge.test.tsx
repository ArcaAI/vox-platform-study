/**
 * TASK-965 WS-3 — `LifecycleStatusBadge` and the one status map behind it (§3.1 vocabulary).
 *
 * The defect this closes is INV-1: the SAME `WorkflowDefinitionStatus` enum was coloured
 * `destructive` on the Agents grid and `outline` in the studio switcher, and the model-B screens
 * rendered every status as a bare `outline` badge so APPROVED was indistinguishable from DRAFT
 * (HV-5). So the assertions below are about the MAP being single and total, not about one badge:
 *
 *   1. every status a console screen can hold resolves to a label + a variant + an icon;
 *   2. DEPRECATED is muted, NOT destructive (it is an end state, not a failure — §3.1);
 *   3. status is never carried by colour alone (WCAG 1.4.1): the label text is always rendered,
 *      and an icon accompanies it;
 *   4. an unknown status from a newer gateway degrades to readable text instead of crashing.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { LIFECYCLE_STATUS, LIFECYCLE_STATUS_ORDER, lifecycleStatusLabel } from '../lifecycle-status';
import { LifecycleStatusBadge } from '../lifecycle-status-badge';

afterEach(cleanup);

describe('lifecycle status vocabulary', () => {
  it('covers every status the console can hold, each with a label, a variant and an icon', () => {
    expect(LIFECYCLE_STATUS_ORDER).toEqual(['DRAFT', 'VALIDATED', 'PUBLISHED', 'APPROVED', 'DEPRECATED']);
    for (const status of LIFECYCLE_STATUS_ORDER) {
      const meta = LIFECYCLE_STATUS[status];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.variant).toBeDefined();
      expect(meta.icon).toBeDefined();
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it('renders DEPRECATED muted, not destructive (an end state, not a failure)', () => {
    expect(LIFECYCLE_STATUS.DEPRECATED.variant).toBe('outline');
    expect(LIFECYCLE_STATUS.DEPRECATED.className).toContain('text-muted-foreground');
  });

  it('distinguishes APPROVED from DRAFT for the head+version screens (HV-5)', () => {
    expect(LIFECYCLE_STATUS.APPROVED.variant).not.toBe(LIFECYCLE_STATUS.DRAFT.variant);
    expect(LIFECYCLE_STATUS.APPROVED.icon).not.toBe(LIFECYCLE_STATUS.PUBLISHED.icon);
  });

  it('title-cases an unknown status instead of throwing', () => {
    expect(lifecycleStatusLabel('SUPERSEDED')).toBe('Superseded');
    expect(lifecycleStatusLabel('DRAFT')).toBe('Draft');
  });
});

describe('LifecycleStatusBadge', () => {
  it('renders the label as text, with the icon hidden from assistive tech', () => {
    const { container } = renderWithProviders(<LifecycleStatusBadge status="PUBLISHED" />);
    expect(screen.getByText('Published')).toBeDefined();
    const icon = container.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders a status it does not know rather than nothing', () => {
    renderWithProviders(<LifecycleStatusBadge status="SUPERSEDED" />);
    expect(screen.getByText('Superseded')).toBeDefined();
  });

  it('has no axe violations for every known status', async () => {
    const { container } = renderWithProviders(
      <div>
        {LIFECYCLE_STATUS_ORDER.map((status) => (
          <LifecycleStatusBadge key={status} status={status} />
        ))}
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
