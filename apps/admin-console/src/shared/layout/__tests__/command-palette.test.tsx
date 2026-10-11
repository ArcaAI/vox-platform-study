/**
 * BUG-022 — the ⌘K palette filtered with NO roles, so the role-judged tiers (10-19 platform
 * screens) never appeared in it, not even for a super admin, and it disagreed with the sidebar.
 * It now passes the session's EFFECTIVE roles, exactly as the sidebar does.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../command-palette';
import { NARROW_TENANT_FIXTURE, renderInShell } from './nav-shell-fixture';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/dashboard',
}));
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function openPalette() {
  fireEvent.keyDown(document, { key: 'k', metaKey: true });
}

/** Each option reads `<label><route>` — match the Tenants screen exactly, not Tenant storage/profile. */
const isTenantsScreen = (option: HTMLElement) => option.textContent === 'Tenants/tenants';

describe('CommandPalette (BUG-022)', () => {
  it('lists the platform screens a super admin can open', async () => {
    renderInShell(<CommandPalette />);
    openPalette();
    await waitFor(() => expect(screen.getAllByRole('option').some(isTenantsScreen)).toBe(true));
  });

  it('lists the playground screens for an impersonated clinician, like the sidebar', async () => {
    renderInShell(<CommandPalette />, { ...NARROW_TENANT_FIXTURE, roles: ['DOCTOR'] });
    openPalette();
    expect(await screen.findByRole('option', { name: /consultation scribe/i })).toBeDefined();
    expect(screen.getAllByRole('option').some(isTenantsScreen)).toBe(false);
  });
});
