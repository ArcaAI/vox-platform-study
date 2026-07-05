import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '@arcaai/ui/components/shadcn/sidebar';
import { NAV_ENTRIES } from '@/shared/navigation/nav-config';
import { renderWithProviders } from '@/test/render';
import { AppSidebar } from '../app-sidebar';

vi.mock('next/navigation', () => ({
    usePathname: () => '/dashboard',
}));

/** Global-admin permissions so every implemented nav entry is visible. */
function stubPermissionsFetch() {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ userId: 'u-1', tenantId: null, permissions: [{ action: 'manage', subject: 'all' }] })),
    );
}

function renderSidebar() {
    stubPermissionsFetch();
    return renderWithProviders(
        <SidebarProvider>
            <AppSidebar />
        </SidebarProvider>,
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('AppSidebar', () => {
    it('renders a labeled navigation landmark with a decorative icon before every entry label', async () => {
        renderSidebar();

        // Entries appear once the permissions query resolves.
        await screen.findByRole('link', { name: 'Dashboard' });
        const nav = screen.getByRole('navigation', { name: 'Main' });
        const links = within(nav).getAllByRole('link');
        expect(links).toHaveLength(NAV_ENTRIES.length);

        for (const link of links) {
            const icon = link.querySelector('svg');
            expect(icon, `"${link.textContent}" is missing an icon`).not.toBeNull();
            expect(icon?.getAttribute('aria-hidden'), `"${link.textContent}" icon must be decorative`).toBe('true');
            // Icon precedes the label so the collapsed rail shows it.
            expect(link.firstElementChild?.tagName.toLowerCase()).toBe('svg');
        }
    });

    it('marks the current route with aria-current and active styling', async () => {
        renderSidebar();

        const dashboard = await screen.findByRole('link', { name: 'Dashboard' });
        expect(dashboard.getAttribute('aria-current')).toBe('page');
        expect(dashboard.getAttribute('data-active')).toBe('true');

        const tenants = screen.getByRole('link', { name: 'Tenants' });
        expect(tenants.getAttribute('aria-current')).toBeNull();
        expect(tenants.getAttribute('data-active')).toBe('false');
    });

    it('wires the collapsed-state tooltip on every menu button', async () => {
        renderSidebar();

        await screen.findByRole('link', { name: 'Dashboard' });
        const nav = screen.getByRole('navigation', { name: 'Main' });
        for (const link of within(nav).getAllByRole('link')) {
            // Radix Tooltip.Trigger stamps data-state on its trigger element.
            expect(link.getAttribute('data-state'), `"${link.textContent}" has no tooltip wiring`).not.toBeNull();
        }
    });

    it('keeps the brand link accessible-name intact for the collapsed rail', async () => {
        renderSidebar();
        expect(await screen.findByRole('link', { name: 'HOPE Admin' })).toBeDefined();
    });
});
