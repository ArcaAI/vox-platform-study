import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { DetailDrawer } from '../detail-drawer';


function sheetContent(): HTMLElement {
    const el = document.querySelector('[data-slot="sheet-content"]');
    if (!(el instanceof HTMLElement)) throw new Error('sheet content not rendered');
    return el;
}

describe('DetailDrawer', () => {
    it('renders the title, badges, meta line, body and pinned footer', () => {
        render(
            <DetailDrawer
                open
                onOpenChange={() => {}}
                title="Acme role"
                badges={<span data-testid="badge">System</span>}
                meta={<span data-testid="meta">role_01</span>}
                footer={<button data-testid="footer-action">Save</button>}
            >
                <p data-testid="body">Body content</p>
            </DetailDrawer>,
        );

        expect(screen.getByText('Acme role')).toBeDefined();
        expect(screen.getByTestId('badge')).toBeDefined();
        expect(screen.getByTestId('meta')).toBeDefined();
        expect(screen.getByTestId('body')).toBeDefined();
        expect(screen.getByTestId('footer-action')).toBeDefined();
    });

    it('scrolls only the body region (single scroll container)', () => {
        render(
            <DetailDrawer open onOpenChange={() => {}} title="Detail">
                <p data-testid="body">Body</p>
            </DetailDrawer>,
        );

        const region = screen.getByTestId('body').parentElement!;
        expect(region.className).toContain('overflow-y-auto');
        expect(region.className).toContain('flex-1');
        expect(region.className).toContain('min-h-0');
    });

    it('is a full-screen sheet on mobile and a constrained slide-over on desktop', () => {
        render(
            <DetailDrawer open onOpenChange={() => {}} title="Detail">
                <p>Body</p>
            </DetailDrawer>,
        );

        const content = sheetContent();
        // Mobile base: full-screen (edge to edge, no max width cap).
        expect(content.className).toContain('w-full');
        expect(content.className).toContain('max-w-none');
        // Desktop default size (md): constrained right slide-over.
        expect(content.className).toContain('md:max-w-xl');
    });

    it('maps the size prop to the desktop width', () => {
        const { rerender } = render(
            <DetailDrawer open onOpenChange={() => {}} title="Detail" size="lg">
                <p>Body</p>
            </DetailDrawer>,
        );
        expect(sheetContent().className).toContain('md:max-w-[40vw]');

        rerender(
            <DetailDrawer open onOpenChange={() => {}} title="Detail" size="xl">
                <p>Body</p>
            </DetailDrawer>,
        );
        expect(sheetContent().className).toContain('md:max-w-[56vw]');
    });

    it('calls onOpenChange(false) when the close control is used', () => {
        const onOpenChange = vi.fn();
        render(
            <DetailDrawer open onOpenChange={onOpenChange} title="Detail">
                <p>Body</p>
            </DetailDrawer>,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('has no axe violations', async () => {
        render(
            <DetailDrawer
                open
                onOpenChange={() => {}}
                title="Acme role"
                badges={<span>System</span>}
                meta={<span>role_01</span>}
                footer={<button type="button">Save</button>}
            >
                <p>Body content</p>
            </DetailDrawer>,
        );

        // Scan the dialog content (not document.body) so Radix's body-level
        // focus-guard spans — a library artifact, not this component — are excluded.
        const results = await axe(sheetContent(), { rules: { 'color-contrast': { enabled: false } } });
        expect(results).toHaveNoViolations();
    });

    /**
     * F-037: the live-DOM sweep found the discovery drawer's body region
     * (`overflow-y-auto`, 12 discovered models below the fold) flagged by axe
     * as SERIOUS `scrollable-region-focusable` — a scrollable region that
     * isn't in the keyboard tab order, so keyboard users can't scroll it.
     * jsdom/happy-dom apply no stylesheet, so `overflow-y-auto` never becomes
     * a computed style axe can key off in this environment (the live
     * Playwright scan is what caught it) — assert the structural fix
     * directly: the scroll container is itself a tab stop with an
     * accessible name, regardless of CSS resolution.
     */
    it('keeps the body scroll region keyboard-reachable (tabIndex + accessible name)', () => {
        render(
            <DetailDrawer open onOpenChange={() => {}} title="Detail">
                <p>Body</p>
            </DetailDrawer>,
        );

        const region = screen.getByText('Body').parentElement!;
        expect(region.getAttribute('tabindex')).toBe('0');
        expect(region.getAttribute('role')).toBe('region');
        expect(region.hasAttribute('aria-label') || region.hasAttribute('aria-labelledby')).toBe(true);
    });
});
