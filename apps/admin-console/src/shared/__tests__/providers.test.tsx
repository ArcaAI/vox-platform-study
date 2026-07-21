import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
    usePathname: () => '/',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

import { Providers } from '../providers';

afterEach(() => {
    cleanup();
});

describe('Providers', () => {
    /**
     * The React canary bundled with Next 16 logs "Encountered a
     * script tag while rendering React component" for every executable
     * <script> created during a client render. next-themes' FOUC bootstrap
     * must therefore be an inert data block on the client (it is never
     * executed there anyway); only the SSR copy stays executable.
     */
    it('renders the next-themes bootstrap script as an inert data block on the client', () => {
        const { container } = render(
            <Providers>
                <div />
            </Providers>,
        );

        const script = [...container.querySelectorAll('script')].find((el) => el.innerHTML.includes('documentElement'));

        expect(script, 'next-themes bootstrap script not found').toBeDefined();
        expect(script?.getAttribute('type')).toBe('application/json');
    });
});
