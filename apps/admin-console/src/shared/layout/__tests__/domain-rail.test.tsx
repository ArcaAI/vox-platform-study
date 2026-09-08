import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { NAV_DOMAINS } from '@/shared/navigation/nav-config';
import { DomainRail } from '../domain-rail';
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

function railLinks() {
  return within(screen.getByRole('navigation', { name: 'Capability domains' })).getAllByRole('link');
}

describe('DomainRail', () => {
  it('renders one named item per reachable domain (AC-4 — the reference rail has an unnamed control)', async () => {
    renderInShell(<DomainRail />);
    await screen.findByRole('link', { name: 'Overview' });

    const links = railLinks();
    expect(links).toHaveLength(NAV_DOMAINS.length);
    expect(links.map((link) => link.textContent)).toEqual(NAV_DOMAINS.map((domain) => domain.label));
    for (const link of links) {
      // Icon is decorative; the name comes from the sr-only label beside it.
      const icon = link.querySelector('svg');
      expect(icon?.getAttribute('aria-hidden'), `"${link.textContent}" icon must be decorative`).toBe('true');
    }
  });

  it('derives the active domain from the pathname alone (AC-6)', async () => {
    usePathnameMock.mockReturnValue('/harness/observability');
    renderInShell(<DomainRail />);

    const active = await screen.findByRole('link', { name: 'Workflow & Harness' });
    expect(active.getAttribute('aria-current')).toBe('true');
    expect(active.getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('data-active')).toBe('false');
  });

  it('follows the domain axis, not the tier axis, on a tenant-tier Platform Ops route (OD-2)', async () => {
    // /storage is tier 30-49 but domain platform-ops — the divergence that
    // makes the two axes worth keeping separate. (/ai-configuration, the
    // route this test used to pin, was removed from the rail by TASK-932 —
    // its "Speech & Voice" entry is gone entirely and the URL now redirects.)
    usePathnameMock.mockReturnValue('/storage');
    renderInShell(<DomainRail />);
    expect((await screen.findByRole('link', { name: 'Platform Ops' })).getAttribute('data-active')).toBe('true');
  });

  it('resolves a detail route to its parent entry domain', async () => {
    usePathnameMock.mockReturnValue('/tenants/t-123');
    renderInShell(<DomainRail />);
    expect((await screen.findByRole('link', { name: 'Tenancy' })).getAttribute('data-active')).toBe('true');
  });

  it('carries two state signals on the active item, never fill alone (AC-5 / EX-12)', async () => {
    usePathnameMock.mockReturnValue('/dashboard');
    const { container } = renderInShell(<DomainRail />);

    const active = await screen.findByRole('link', { name: 'Overview' });
    // Signal 1 — the --sidebar-accent fill.
    expect(active.className).toContain('bg-sidebar-accent');
    // Signal 2 — a 2px --foreground rule, rendered only for the active item.
    const rules = container.querySelectorAll('span.bg-foreground');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.className).toContain('w-0.5');
    expect(active.closest('li')?.contains(rules[0] as Node)).toBe(true);
  });

  it('hides every domain the caller cannot reach (AC-3)', async () => {
    renderInShell(<DomainRail />, NARROW_TENANT_FIXTURE);
    await screen.findByRole('link', { name: 'Clinical' });

    expect(railLinks().map((link) => link.textContent)).toEqual(['Knowledge & Agents', 'Clinical']);
    expect(screen.queryByRole('link', { name: 'Platform Ops' })).toBeNull();
    // Nothing is rendered inert-but-focusable (EX-11): unreachable means absent.
    expect(screen.queryByRole('link', { name: 'Tenancy' })).toBeNull();
  });

  it('navigates a single-visible-route domain straight to that route (Open Question)', async () => {
    renderInShell(<DomainRail />, NARROW_TENANT_FIXTURE);

    // Clinical has exactly one visible entry for this fixture.
    const clinical = await screen.findByRole('link', { name: 'Clinical' });
    expect(clinical.getAttribute('href')).toBe('/consultations');
    // A multi-route domain uses the same rule — its first visible entry — so
    // there is no dead click at any domain size.
    expect(screen.getByRole('link', { name: 'Knowledge & Agents' }).getAttribute('href')).toBe('/prompt-templates');
  });

  it('is a single tab stop with arrow traversal (AC-8)', async () => {
    usePathnameMock.mockReturnValue('/users');
    renderInShell(<DomainRail />);
    await screen.findByRole('link', { name: 'Overview' });

    const links = railLinks();
    const tabStops = links.filter((link) => link.getAttribute('tabindex') === '0');
    expect(tabStops).toHaveLength(1);
    // The tab stop is the ACTIVE domain, so Tab lands where the user already is.
    expect(tabStops[0]?.textContent).toBe('Identity & Access');

    tabStops[0]?.focus();
    // The handler lives on the list, so events are fired where they really
    // originate — on the focused item, bubbling up. TASK-932 moved Identity &
    // Access to the second-to-last rail position (Playground stays last), so
    // the next domain after it is now Playground, not Platform Ops.
    const list = screen.getByRole('navigation', { name: 'Capability domains' }).querySelector('ul') as HTMLUListElement;
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Playground');
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toBe('Identity & Access');
    fireEvent.keyDown(list, { key: 'Home' });
    expect(document.activeElement?.textContent).toBe('Overview');
    fireEvent.keyDown(list, { key: 'End' });
    expect(document.activeElement?.textContent).toBe('Playground');
    // Tab is never intercepted, so focus can always leave the rail.
    fireEvent.keyDown(list, { key: 'Tab' });
    expect(document.activeElement?.textContent).toBe('Playground');
  });

  it('has no axe violations in light theme', async () => {
    const { container } = renderInShell(<DomainRail />);
    await screen.findByRole('link', { name: 'Overview' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in dark theme', async () => {
    document.documentElement.classList.add('dark');
    const { container } = renderInShell(<DomainRail />);
    await screen.findByRole('link', { name: 'Overview' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the inline (mobile drawer) variant', async () => {
    const { container } = renderInShell(<DomainRail variant="inline" />, { width: 375 });
    await screen.findByRole('link', { name: 'Overview' });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('DomainRail — platform-wide feature gates (TASK-932 §3.2)', () => {
  it('hides the whole Workflow & Harness domain when its gate is off — every one of its entries is gated', async () => {
    renderInShell(<DomainRail />, {
      gates: { 'console.mlflow.enabled': true, 'console.agenticPolicy.enabled': true, 'console.tools.mcp.enabled': true, 'console.workflowHarness.enabled': false },
    });
    await screen.findByRole('link', { name: 'Overview' });
    expect(railLinks().map((link) => link.textContent)).not.toContain('Workflow & Harness');
  });

  it('keeps Platform Ops visible when only its gated entries are closed — the domain has ungated members too', async () => {
    renderInShell(<DomainRail />, {
      gates: { 'console.mlflow.enabled': false, 'console.agenticPolicy.enabled': false, 'console.tools.mcp.enabled': false, 'console.workflowHarness.enabled': true },
    });
    await screen.findByRole('link', { name: 'Overview' });
    expect(railLinks().map((link) => link.textContent)).toContain('Platform Ops');
  });
});
