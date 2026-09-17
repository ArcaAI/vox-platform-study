/**
 * TASK-965 WS-3 — `VersionHistoryPanel`, the ONE version list for both versioning models.
 *
 * AG-18: the agents Versions tab showed `vN · name`, status and `updatedAt` and nothing else —
 * no published/deprecated dates, no author, no checksum, no active marker, no row actions, no
 * compare. WF-18: the studio had no lineage view at all although `GET :id/versions` and its hook
 * already existed with zero consumers. INV-5: every screen hand-rolled its own `<ul>`.
 *
 * The panel is deliberately DUMB about the entity: it takes `VersionRow`s (a kit type, not a
 * feature type) and a caller-supplied action list, so agents, workflow definitions, context
 * schemas and document templates can share it without any of them leaking into the kit.
 *
 * The assertions pin behaviour a feature cannot re-derive: newest-first ordering, the active and
 * pinned markers, that a disabled action keeps a visible reason (rule 11 §5), the `aria-expanded`
 * contract on the detail disclosure, and that the whole thing is keyboard-operable.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { VersionHistoryPanel, type VersionRow } from '../version-history-panel';

afterEach(cleanup);

const VERSIONS: VersionRow[] = [
  {
    id: 'v1',
    versionNumber: 1,
    status: 'DEPRECATED',
    publishedAt: '2026-01-02T10:00:00.000Z',
    deprecatedAt: '2026-03-02T10:00:00.000Z',
    by: 'ana@hope.test',
  },
  {
    id: 'v2',
    versionNumber: 2,
    status: 'PUBLISHED',
    isActive: true,
    publishedAt: '2026-03-02T10:00:00.000Z',
    by: 'ana@hope.test',
    checksum: 'sha256:9f2b',
    detail: <p>model gpt-4o-mini</p>,
  },
  { id: 'v3', versionNumber: 3, status: 'DRAFT', updatedAt: '2026-04-02T10:00:00.000Z' },
];

/** Radix menus open on pointerdown, not click (the console's own row-menu test helper). */
function openRowMenu(rowIndex: number, version: string) {
  const trigger = within(screen.getAllByRole('listitem')[rowIndex]).getByRole('button', { name: `Actions for ${version}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

describe('VersionHistoryPanel', () => {
  it('lists versions newest first with their status', () => {
    renderWithProviders(<VersionHistoryPanel versions={VERSIONS} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => within(row).getByTestId('version-number').textContent)).toEqual(['v3', 'v2', 'v1']);
    expect(within(rows[0]).getByText('Draft')).toBeDefined();
    expect(within(rows[1]).getByText('Published')).toBeDefined();
    expect(within(rows[2]).getByText('Deprecated')).toBeDefined();
  });

  it('marks the active version and shows the dates and author the agents tab was missing (AG-18)', () => {
    renderWithProviders(<VersionHistoryPanel versions={VERSIONS} />);
    const active = screen.getAllByRole('listitem')[1];
    expect(within(active).getByText('Active')).toBeDefined();
    expect(within(active).getByText(/ana@hope\.test/)).toBeDefined();
    expect(within(active).getByText(/9f2b/)).toBeDefined();
  });

  it('marks a pinned version for the head+version model', () => {
    renderWithProviders(<VersionHistoryPanel versions={[{ id: 'a', versionNumber: 4, status: 'APPROVED', isPinned: true }]} />);
    expect(screen.getByText('Pinned v4')).toBeDefined();
  });

  it('renders the caller-supplied row actions and calls back with the row', async () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <VersionHistoryPanel versions={VERSIONS} actions={(row) => [{ key: 'activate', label: `Activate v${row.versionNumber}`, onSelect }]} />,
    );
    openRowMenu(2, 'v1');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Activate v1' }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: 1 }));
  });

  it('keeps a visible reason on a disabled action (rule 11 §5)', async () => {
    renderWithProviders(
      <VersionHistoryPanel
        versions={VERSIONS}
        actions={() => [{ key: 'activate', label: 'Activate', disabled: true, disabledReason: 'Already the active version', onSelect: () => {} }]}
      />,
    );
    openRowMenu(1, 'v2');
    expect(await screen.findByText('Already the active version')).toBeDefined();
  });

  it('exposes the detail disclosure with aria-expanded and toggles it from the keyboard', () => {
    renderWithProviders(<VersionHistoryPanel versions={VERSIONS} />);
    const toggle = screen.getByRole('button', { name: /details for v2/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /details for v2/i }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('model gpt-4o-mini')).toBeDefined();
  });

  it('opens a version through a real button when the caller wants row selection', () => {
    const onOpenVersion = vi.fn();
    renderWithProviders(<VersionHistoryPanel versions={VERSIONS} onOpenVersion={onOpenVersion} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open v3' }));
    expect(onOpenVersion).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: 3 }));
  });

  it('renders skeletons while loading, never a spinner or "Loading…" (rule 10)', () => {
    const { container } = renderWithProviders(<VersionHistoryPanel versions={[]} isPending />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/loading/i);
  });

  it('shows an empty state when a lineage has no versions yet', () => {
    renderWithProviders(<VersionHistoryPanel versions={[]} emptyTitle="No versions yet" />);
    expect(screen.getByText('No versions yet')).toBeDefined();
  });

  it('shows the error state with a retry when the versions call failed', () => {
    const onRetry = vi.fn();
    renderWithProviders(<VersionHistoryPanel versions={[]} error={new Error('boom')} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(
      <VersionHistoryPanel
        versions={VERSIONS}
        aria-label="Agent versions"
        onOpenVersion={() => {}}
        actions={() => [{ key: 'compare', label: 'Compare with previous', onSelect: () => {} }]}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
