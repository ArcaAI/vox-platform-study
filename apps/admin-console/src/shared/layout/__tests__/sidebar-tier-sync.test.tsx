import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, SidebarContent, SidebarProvider } from '@arcaai/ui/components/shadcn/sidebar';
import { SidebarTierSync } from '../sidebar-tier-sync';

function mockViewport(width: number) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    vi.stubGlobal('matchMedia', (query: string) => {
        const min = /min-width:\s*(\d+)/.exec(query);
        const max = /max-width:\s*(\d+)/.exec(query);
        const matches = min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false;
        return {
            matches,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
            onchange: null,
        } as MediaQueryList;
    });
}

function renderSidebar() {
    return render(
        <SidebarProvider>
            <SidebarTierSync />
            <Sidebar collapsible="icon">
                <SidebarContent />
            </Sidebar>
        </SidebarProvider>,
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('SidebarTierSync', () => {
    it('defaults the icon rail to collapsed on the tablet tier', async () => {
        mockViewport(1024);
        const { container } = renderSidebar();
        await waitFor(() => {
            const el = container.querySelector('[data-slot="sidebar"][data-state]');
            expect(el?.getAttribute('data-state')).toBe('collapsed');
            expect(el?.getAttribute('data-collapsible')).toBe('icon');
        });
    });

    it('leaves the sidebar expanded on the desktop tier', async () => {
        mockViewport(1440);
        const { container } = renderSidebar();
        // Allow effects to run, then confirm it stayed expanded.
        await waitFor(() => {
            expect(container.querySelector('[data-slot="sidebar"][data-state]')).not.toBeNull();
        });
        const el = container.querySelector('[data-slot="sidebar"][data-state]');
        expect(el?.getAttribute('data-state')).toBe('expanded');
    });
});
