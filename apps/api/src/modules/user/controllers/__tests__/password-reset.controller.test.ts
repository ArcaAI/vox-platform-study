/**
 * PasswordResetController unit tests.
 *
 * This route completes an account takeover attack surface, so it is
 * deliberately `@Public()` (unauthenticated callers finishing their own
 * reset) with authorization carried entirely by the single-use token passed
 * to the service — losing `@Public()` would 401 every legitimate reset, and
 * gaining an unintended additional decorator would either lock it or loosen
 * it. Covers delegation to `UserPasswordService.completeReset` with the
 * exact token/newPassword pair and the response shape.
 */
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import { SKIP_AUTH_KEY } from '@arcaai/applications';

import { PasswordResetController } from '../password-reset.controller';

describe('PasswordResetController — delegation', () => {
  it('completes a reset with the token and new password', async () => {
    const userPasswordService = { completeReset: vi.fn().mockResolvedValue(undefined) };
    const controller = new PasswordResetController(userPasswordService as never);

    const result = await controller.complete({ token: 'tok-abc', newPassword: 'N3wP@ssword!' } as never);

    expect(userPasswordService.completeReset).toHaveBeenCalledWith({ token: 'tok-abc', newPassword: 'N3wP@ssword!' });
    expect(result).toEqual({ success: true });
  });
});

describe('PasswordResetController — authorization metadata', () => {
  it('the complete route is @Public()', () => {
    const reflector = new Reflector();
    const flag = reflector.get(SKIP_AUTH_KEY, PasswordResetController.prototype.complete);
    expect(flag).toBe(true);
  });
});
