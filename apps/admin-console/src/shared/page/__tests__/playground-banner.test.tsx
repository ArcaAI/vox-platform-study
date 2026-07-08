import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlaygroundBanner } from '../playground-banner';

const sessionState: { data: { user: { username: string } } | undefined } = { data: undefined };

vi.mock('@/shared/auth', () => ({
    useSession: () => sessionState,
}));

describe('PlaygroundBanner', () => {
    it('renders the own-account note with the session username', () => {
        sessionState.data = { user: { username: 't.anders' } };
        render(<PlaygroundBanner />);

        expect(screen.getByRole('note').textContent).toContain('demo sessions run under your own account');
        expect(screen.getByText('(t.anders)')).toBeDefined();
    });

    it('renders without a username while the session hydrates', () => {
        sessionState.data = undefined;
        render(<PlaygroundBanner />);

        expect(screen.getByRole('note').textContent).toContain('Playground — demo sessions run under your own account');
    });
});
