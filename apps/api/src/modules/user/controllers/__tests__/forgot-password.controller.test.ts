/**
 * Public forgot-password endpoint.
 *
 * Contract: POST /auth/forgot-password is unauthenticated, throttled, and
 * ALWAYS answers 202 with the same generic body — whether the email matched an
 * account, matched nothing, or the service blew up internally. The token/link
 * must never appear in the response; it travels only via the mailer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForgotPasswordController } from '../forgot-password.controller';

const requestSelfServiceReset = vi.fn();
const controller = () => new ForgotPasswordController({ requestSelfServiceReset } as never);

describe('ForgotPasswordController (TASK-400)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('delegates to the service and returns the generic accepted body', async () => {
        requestSelfServiceReset.mockResolvedValue(undefined);

        const result = await controller().request({ email: 'doc@example.com' } as never);

        expect(requestSelfServiceReset).toHaveBeenCalledWith({ email: 'doc@example.com' });
        expect(result).toEqual({
            success: true,
            message: 'If an account exists for that email, a password reset link has been sent.',
        });
    });

    it('returns the IDENTICAL body even when the service throws (no enumeration, no 5xx)', async () => {
        requestSelfServiceReset.mockRejectedValue(new Error('db down'));

        const result = await controller().request({ email: 'ghost@example.com' } as never);

        expect(result).toEqual({
            success: true,
            message: 'If an account exists for that email, a password reset link has been sent.',
        });
    });

    it('never includes token material in the response payload', async () => {
        requestSelfServiceReset.mockResolvedValue(undefined);
        const result = await controller().request({ email: 'doc@example.com' } as never);
        expect(JSON.stringify(result)).not.toMatch(/token|reset-password\?/i);
    });
});
