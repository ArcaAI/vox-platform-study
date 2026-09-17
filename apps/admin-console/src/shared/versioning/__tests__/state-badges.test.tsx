/**
 * TASK-965 WS-3 — the three badge families that are NOT lifecycle status (§3.1):
 * liveness (`ActiveBadge`), assignment (`AssignmentBadges`) and provenance (`OriginBadge`).
 *
 * Keeping them apart is the point. Before this kit the console conflated them — AG-15 badged a
 * DRAFT v4 as "Tenant default" because the assignment is per-SLUG, not per-version, and AG-3 told
 * an admin with no assignment that the agent was "currently the platform default" when resolution
 * is department -> tenant -> fail closed (`AGENT_NOT_ASSIGNED`, 503; TASK-890 OD-M removed the
 * platform tier for content). So the assertions below pin the WORDS, not the styling:
 *
 *   1. "Active" is about a version; "Tenant default" is about a slug — different components;
 *   2. no assignment says Unassigned and warns, and never claims a platform fallback;
 *   3. "None active" is a warning state a lineage row can render (§3.1 row model);
 *   4. provenance says Platform origin and, when the clone is locked, says so — a refused edit
 *      with no visible cause is the HV-8 defect.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { ActiveBadge, AssignmentBadges, OriginBadge, SYSTEM_TENANT_ID } from '../state-badges';

afterEach(cleanup);

describe('ActiveBadge', () => {
  it('names the served version of a lineage (model A)', () => {
    renderWithProviders(<ActiveBadge active />);
    expect(screen.getByText('Active')).toBeDefined();
  });

  it('names the pinned version instead for the head+version model', () => {
    renderWithProviders(<ActiveBadge pinnedVersionNumber={3} />);
    expect(screen.getByText('Pinned v3')).toBeDefined();
  });

  it('warns when a lineage has no active version at all', () => {
    renderWithProviders(<ActiveBadge noneActive />);
    expect(screen.getByText('None active')).toBeDefined();
  });

  it('renders nothing when the version is simply not the active one', () => {
    const { container } = renderWithProviders(<ActiveBadge active={false} />);
    expect(container.textContent).toBe('');
  });
});

describe('AssignmentBadges', () => {
  it('reads the tenant default and the department count', () => {
    renderWithProviders(<AssignmentBadges tenantDefault departmentCount={2} />);
    expect(screen.getByText('Tenant default')).toBeDefined();
    expect(screen.getByText('2 departments')).toBeDefined();
  });

  it('names a single department when the caller knows it', () => {
    renderWithProviders(<AssignmentBadges departmentCount={1} departmentName="Cardiology" />);
    expect(screen.getByText('Assigned to Cardiology')).toBeDefined();
  });

  it('counts tag selectors separately from departments', () => {
    renderWithProviders(<AssignmentBadges tenantDefault selectorCount={3} />);
    expect(screen.getByText('3 selectors')).toBeDefined();
  });

  it('says Unassigned and states the fail-closed consequence — never a platform fallback (AG-3)', () => {
    renderWithProviders(<AssignmentBadges />);
    const badge = screen.getByText('Unassigned');
    expect(badge).toBeDefined();
    const title = badge.closest('[title]')?.getAttribute('title') ?? '';
    expect(title.toLowerCase()).toContain('nothing resolves');
    expect(title.toLowerCase()).not.toContain('platform default');
  });
});

describe('OriginBadge', () => {
  it('names platform provenance for a row cloned from the SYSTEM reference set', () => {
    renderWithProviders(<OriginBadge sourceTenantId={SYSTEM_TENANT_ID} />);
    expect(screen.getByText(/Platform origin/)).toBeDefined();
  });

  it('says so when the clone is locked, so a refused edit has a visible cause (HV-8)', () => {
    renderWithProviders(<OriginBadge sourceTemplateSlug="platform-default-summarization" locked />);
    expect(screen.getByText(/Locked/)).toBeDefined();
  });

  it('marks a tenant-authored row', () => {
    renderWithProviders(<OriginBadge sourceTenantId={null} />);
    expect(screen.getByText('Tenant')).toBeDefined();
  });

  it('renders nothing when provenance is not on the wire', () => {
    const { container } = renderWithProviders(<OriginBadge />);
    expect(container.textContent).toBe('');
  });
});

describe('accessibility', () => {
  it('has no axe violations across the three families', async () => {
    const { container } = renderWithProviders(
      <div>
        <ActiveBadge active />
        <ActiveBadge noneActive />
        <AssignmentBadges tenantDefault departmentCount={2} selectorCount={1} />
        <AssignmentBadges />
        <OriginBadge sourceTenantId={SYSTEM_TENANT_ID} locked />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
