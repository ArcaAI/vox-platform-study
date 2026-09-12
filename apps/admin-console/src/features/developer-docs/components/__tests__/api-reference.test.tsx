import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * TASK-955 — the embedded Scalar reference.
 *
 * Scalar is written for a page whose DOCUMENT scrolls: its layout is
 * `min-height: 100dvh` and its sidebar is `position: sticky` with a
 * viewport-derived height. The console never scrolls the document (the shell
 * inset is `h-svh overflow-hidden`, rule 11 §App Shell), so an unconstrained
 * Scalar spilled into the shell's content region and dragged the page header,
 * the plane tabs and the status footer along with it. The wrapper must
 * therefore be the ONE scroll container of the `fill` panel and must hand its
 * own height to Scalar, so the sidebar sticks inside it instead of overflowing.
 */

const useTheme = vi.fn<() => { resolvedTheme?: string }>();
vi.mock('next-themes', () => ({ useTheme: () => useTheme() }));

vi.mock('@scalar/api-reference-react', () => ({
  ApiReferenceReact: ({ configuration }: { configuration: Record<string, unknown> }) => (
    <div data-testid="scalar" className="scalar-app scalar-api-reference references-layout" data-configuration={JSON.stringify(configuration)} />
  ),
}));

import { ApiReference } from '../api-reference';

afterEach(() => {
  cleanup();
  useTheme.mockReset();
});

describe('ApiReference', () => {
  it('shows a skeleton until next-themes has resolved the theme', () => {
    useTheme.mockReturnValue({});
    render(<ApiReference plane="business" />);

    expect(screen.getByTestId('api-reference-skeleton')).toBeDefined();
    expect(screen.queryByTestId('scalar')).toBeNull();
  });

  it('is the one scroll container of the panel and hands its own height to Scalar', () => {
    useTheme.mockReturnValue({ resolvedTheme: 'dark' });
    render(<ApiReference plane="business" />);

    const host = screen.getByTestId('scalar').parentElement!;
    expect(host.getAttribute('data-slot')).toBe('api-reference');

    // The wrapper scrolls, not the shell's content region behind it.
    expect(host.className).toContain('overflow-y-auto');
    expect(host.className).toContain('h-full');
    expect(host.className).toContain('min-h-0');

    // Scalar's viewport assumptions are re-pointed at the wrapper: the layout
    // fills the wrapper (not 100dvh) and `--full-height` — the root of its
    // sticky-sidebar height — becomes the wrapper's container-query height.
    expect(host.className).toContain('@container-size');
    expect(host.className).toContain('[&_.scalar-app.references-layout]:min-h-full!');
    expect(host.className).toContain('[&_.scalar-app.references-layout]:[--full-height:100cqh]!');
  });

  it('points Scalar at the plane-scoped spec route with the client and every outbound affordance off', () => {
    useTheme.mockReturnValue({ resolvedTheme: 'light' });
    render(<ApiReference plane="admin" />);

    const configuration = JSON.parse(screen.getByTestId('scalar').getAttribute('data-configuration')!) as Record<string, unknown>;
    expect(configuration.url).toBe('/api/docs/spec/admin');
    expect(configuration.darkMode).toBe(false);
    expect(configuration.forceDarkModeState).toBe('light');
    // Owner decision D-3: read-only reference, no live client against the gateway.
    expect(configuration.hideClientButton).toBe(true);
    expect(configuration.hideTestRequestButton).toBe(true);
    // No egress path for a private healthcare API's surface.
    expect(configuration.showDeveloperTools).toBe('never');
    expect(configuration.agent).toEqual({ disabled: true });
    expect(configuration.mcp).toEqual({ disabled: true });
  });
});
