import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { SidebarTrigger } from '@arcaai/ui/components/shadcn/sidebar';
import { NAV_ENTRIES } from '@/shared/navigation/nav-config';
import { AppSidebar } from '../app-sidebar';
import { NARROW_TENANT_FIXTURE, renderInShell } from './nav-shell-fixture';

const usePathnameMock = vi.fn<() => string>(() => '/dashboard');
vi.mock('next/navigation', () => ({
  usePathname: () => usePathnameMock(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  usePathnameMock.mockReturnValue('/dashboard');
  document.documentElement.classList.remove('dark');
});

/** The scoped list, addressed by the landmark name the active domain gives it. */
function scopedNav(domainLabel: string) {
  return screen.getByRole('navigation', { name: `${domainLabel} navigation` });
}

describe('AppSidebar — scoped to the active domain', () => {
  it('renders only the active domain, not the 57-entry flat list', async () => {
    usePathnameMock.mockReturnValue('/consultations');
    renderInShell(<AppSidebar />);
    await screen.findByRole('link', { name: 'Consultations' });

    const links = within(scopedNav('Clinical')).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Patient consent', 'Audio pipelines', 'Transcription jobs', 'Consultations']);
    expect(links.length).toBeLessThan(NAV_ENTRIES.length);
    // A route from another domain is simply absent — not hidden-but-focusable.
    expect(screen.queryByRole('link', { name: 'Queues & jobs' })).toBeNull();
  });

  it('keeps tier sub-headers where a domain spans tiers, and names the domain where it does not (OD-3)', async () => {
    // AI Platform spans 10-19 and 30-49, so the tier labels stay useful — they
    // tell a super admin which rows are cross-tenant.
    usePathnameMock.mockReturnValue('/ai-models');
    const { unmount } = renderInShell(<AppSidebar />);
    await screen.findByRole('link', { name: 'AI models' });
    const aiHeadings = Array.from(scopedNav('AI Platform').querySelectorAll('[data-slot="sidebar-group-label"]')).map((el) => el.textContent);
    expect(aiHeadings).toEqual(['Platform', 'Tenant']);
    unmount();

    // Clinical sits entirely in one tier; a lone "Tenant" header would say
    // nothing, so the domain names itself instead.
    usePathnameMock.mockReturnValue('/consultations');
    renderInShell(<AppSidebar />);
    await screen.findByRole('link', { name: 'Consultations' });
    const clinicalHeadings = Array.from(scopedNav('Clinical').querySelectorAll('[data-slot="sidebar-group-label"]')).map((el) => el.textContent);
    expect(clinicalHeadings).toEqual(['Clinical']);
  });

  it('marks the current route with aria-current plus three state signals (AC-5)', async () => {
    usePathnameMock.mockReturnValue('/consultations');
    const { container } = renderInShell(<AppSidebar />);

    const active = await screen.findByRole('link', { name: 'Consultations' });
    expect(active.getAttribute('aria-current')).toBe('page');
    // Signals 1 and 2 come from the primitive's data-[active=true] classes
    // (--sidebar-accent fill + font-medium)…
    expect(active.getAttribute('data-active')).toBe('true');
    // …signal 3 is the 2px --foreground rule, rendered for the active row only.
    const rules = container.querySelectorAll('span.bg-foreground');
    expect(rules).toHaveLength(1);
    expect(active.closest('li')?.contains(rules[0] as Node)).toBe(true);

    expect(screen.getByRole('link', { name: 'Audio pipelines' }).getAttribute('data-active')).toBe('false');
  });

  it('activates only Tenant storage (not Tenants) on /tenants/storage', async () => {
    usePathnameMock.mockReturnValue('/tenants/storage');
    renderInShell(<AppSidebar />);

    const storage = await screen.findByRole('link', { name: 'Tenant storage' });
    expect(storage.getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('link', { name: 'Tenants' }).getAttribute('data-active')).toBe('false');
  });

  it('still activates Tenants on a tenant detail route (/tenants/t-123)', async () => {
    usePathnameMock.mockReturnValue('/tenants/t-123');
    renderInShell(<AppSidebar />);

    const tenants = await screen.findByRole('link', { name: 'Tenants' });
    expect(tenants.getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('link', { name: 'Tenant storage' }).getAttribute('data-active')).toBe('false');
  });

  it('falls back to the first reachable domain on a route no domain owns', async () => {
    // /account left the rail for the user menu (Phase A) — the shell must still
    // render a frame rather than an empty column, with nothing selected.
    usePathnameMock.mockReturnValue('/account');
    const { container } = renderInShell(<AppSidebar />);

    await screen.findByRole('link', { name: 'Dashboard' });
    expect(within(scopedNav('Overview')).getAllByRole('link').map((link) => link.textContent)).toEqual(['Dashboard', 'Monitoring', 'Releases']);
    expect(container.querySelectorAll('span.bg-foreground')).toHaveLength(0);
  });

  it('shows a narrowly-permissioned caller only the routes they hold (AC-3)', async () => {
    // `/agents` (the Agent Catalog) left the rail with TASK-815; the first
    // visible entry of this domain for this fixture is now `/prompt-templates`.
    usePathnameMock.mockReturnValue('/prompt-templates');
    renderInShell(<AppSidebar />, NARROW_TENANT_FIXTURE);
    await screen.findByRole('link', { name: 'Prompt templates' });

    expect(within(scopedNav('Knowledge & Agents')).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Prompt templates',
      'Knowledge Base',
    ]);
    expect(screen.queryByRole('link', { name: 'Context Schemas' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'DNA writing styles' })).toBeNull();
  });

  it('renders the frame for a domain with exactly one visible route, with that route selected (Open Question)', async () => {
    usePathnameMock.mockReturnValue('/consultations');
    renderInShell(<AppSidebar />, NARROW_TENANT_FIXTURE);

    const only = await screen.findByRole('link', { name: 'Consultations' });
    const links = within(scopedNav('Clinical')).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(only.getAttribute('data-active')).toBe('true');
    expect(only.getAttribute('aria-current')).toBe('page');
  });

  it('is a single tab stop with arrow traversal (AC-8)', async () => {
    usePathnameMock.mockReturnValue('/monitoring');
    renderInShell(<AppSidebar />);
    await screen.findByRole('link', { name: 'Monitoring' });

    const nav = scopedNav('Overview');
    const links = within(nav).getAllByRole('link');
    const tabStops = links.filter((link) => link.getAttribute('tabindex') === '0');
    expect(tabStops).toHaveLength(1);
    expect(tabStops[0]?.textContent).toBe('Monitoring');

    tabStops[0]?.focus();
    fireEvent.keyDown(nav, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Releases');
    fireEvent.keyDown(nav, { key: 'Home' });
    expect(document.activeElement?.textContent).toBe('Dashboard');
    // Wraps rather than trapping, and Tab is never swallowed.
    fireEvent.keyDown(nav, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toBe('Releases');
  });

  it('moves both tiers into the off-canvas drawer below md, behind a named trigger (AC-7)', async () => {
    usePathnameMock.mockReturnValue('/dashboard');
    renderInShell(
      <>
        <SidebarTrigger />
        <AppSidebar />
      </>,
      { width: 375 },
    );

    // The rail has no column of its own on mobile, and nothing is left behind
    // in the DOM to duplicate the landmark.
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Capability domains' })).toBeNull());

    const trigger = screen.getByRole('button', { name: 'Toggle Sidebar' });
    fireEvent.click(trigger);

    // Both tiers now live inside the drawer: the domain switcher and the
    // scoped list of the derived domain.
    const drawer = await screen.findByRole('dialog');
    const railInDrawer = await within(drawer).findByRole('navigation', { name: 'Capability domains' });
    expect(within(railInDrawer).getAllByRole('link').length).toBeGreaterThan(1);
    expect(within(drawer).getByRole('navigation', { name: 'Overview navigation' })).toBeDefined();
    // Radix owns the drawer's focus management — assert it actually ran.
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
  });

  it('keeps the brand link reachable', async () => {
    renderInShell(<AppSidebar />);
    expect(await screen.findByRole('link', { name: 'HOPE Admin' })).toBeDefined();
  });

  it('has no axe violations in light theme', async () => {
    const { container } = renderInShell(<AppSidebar />);
    await screen.findByRole('link', { name: 'Dashboard' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in dark theme', async () => {
    document.documentElement.classList.add('dark');
    const { container } = renderInShell(<AppSidebar />);
    await screen.findByRole('link', { name: 'Dashboard' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
