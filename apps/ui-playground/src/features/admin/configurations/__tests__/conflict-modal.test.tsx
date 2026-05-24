/**
 * ConfigConflictModal — unit tests (TASK-302 Stream D Phase D.5.1)
 *
 * Pins the modal stub's contract: an admin who hits an OCC conflict
 * (412 Precondition Failed) on save must see a refreshable dialog with
 * the latest version surfaced, NOT a generic "something went wrong"
 * toast or a silent failure. The 3-way diff UX lands later when
 * TASK-3XX-Global-Setting-History adds the row-history table.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// `vitest.config.ts` globally stubs `@arcaai/vox` to `export default {}`
// to keep tests fast (the SDK has heavy WASM/audio peer deps). Provide
// the one named export this test needs in a local mock so the import
// resolves to a real class — `@arcaai/vox`'s actual ConfigConflictError
// is structurally identical to this shim (verified by the SDK-level
// `useGlobalSettings.optimistic-locking.test.ts` suite).
class TestConfigConflictError extends Error {
    readonly code = 'CONFIG_CONFLICT';
    constructor(
        public readonly settingId: string,
        public readonly expectedVersion: number,
        public readonly currentVersion: number,
    ) {
        super(
            `Setting ${settingId} was changed by someone else ` +
                `(yourVersion=${expectedVersion}, currentVersion=${currentVersion}).`,
        );
        this.name = 'ConfigConflictError';
    }
}
vi.mock('@arcaai/vox', () => ({ ConfigConflictError: TestConfigConflictError }));
const { ConfigConflictError } = await import('@arcaai/vox');
const { ConfigConflictModal } = await import('../conflict-modal');

// The shadcn Dialog primitive renders into a Radix portal; we mock it
// out so the test asserts on plain DOM (`screen.getByText`) without
// having to thread `appendTo` through the test environment. The same
// strategy is used by `configurations-page.test.tsx`.
vi.mock('@arcaai/ui/dialog', () => ({
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
        open ? <div role="dialog">{children}</div> : null,
    DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

vi.mock('@arcaai/ui/button', () => ({
    Button: ({ children, onClick, variant }: { children: React.ReactNode; onClick?: () => void; variant?: string }) => (
        <button onClick={onClick} data-variant={variant}>
            {children}
        </button>
    ),
}));

describe('ConfigConflictModal (TASK-302 Stream D Phase D.5)', () => {
    it('shows the conflict copy with the latest version', () => {
        const err = new ConfigConflictError('gs-1', 7, 8);

        render(<ConfigConflictModal error={err} onRefresh={() => {}} onDismiss={() => {}} />);

        // The user-facing language is "changed by someone else" — NOT
        // "412 precondition failed" or "OCC conflict." Tech jargon belongs
        // in the developer console, not the admin's screen.
        expect(screen.getByText(/changed by someone else/i)).toBeTruthy();
        // The version numbers must be visible so the admin can grok the
        // gap ("oh, I was editing v7 and someone saved v8 in between").
        // Match the whole text node — versions are interpolated inline.
        const desc = screen.getByText(/version 7/i);
        expect(desc.textContent).toMatch(/version 7/i);
        expect(desc.textContent).toMatch(/version is 8/i);
        expect(screen.getByRole('button', { name: /refresh/i })).toBeTruthy();
    });

    it('calls onRefresh when the "Refresh and try again" button is clicked', () => {
        const err = new ConfigConflictError('gs-1', 7, 8);
        const onRefresh = vi.fn();

        render(<ConfigConflictModal error={err} onRefresh={onRefresh} onDismiss={() => {}} />);

        fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('calls onDismiss when the cancel button is clicked', () => {
        // Per the plan's Code Review Gate D bullet ("Confirm the conflict
        // modal is **dismissable**"): the user must always be able to
        // navigate away without resolving the conflict — never hostage
        // the page.
        const err = new ConfigConflictError('gs-1', 7, 8);
        const onDismiss = vi.fn();

        render(<ConfigConflictModal error={err} onRefresh={() => {}} onDismiss={onDismiss} />);

        fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('renders nothing when error is null (precondition for conditional mount)', () => {
        // The page mounts the modal only when an error is captured; this
        // test pins the convenience prop in case the parent passes `null`
        // during the dismiss animation.
        const { container } = render(
            <ConfigConflictModal error={null} onRefresh={() => {}} onDismiss={() => {}} />,
        );
        expect(container.firstChild).toBeNull();
    });
});
