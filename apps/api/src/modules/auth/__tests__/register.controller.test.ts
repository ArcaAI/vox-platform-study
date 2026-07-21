/**
 * Public registration endpoints.
 *
 * Contract: both routes 404 when REGISTRATION_SELF_SIGNUP_ENABLED is off
 * (default); when on, they delegate straight to RegistrationService.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { RegisterController } from '../register.controller';

const getConfigValue = vi.fn();
const register = vi.fn();
const verify = vi.fn();

const controller = () =>
    new RegisterController({ getConfigValue } as never, { register, verify } as never);

describe('RegisterController (TASK-497)', () => {
    beforeEach(() => vi.clearAllMocks());

    describe('when REGISTRATION_SELF_SIGNUP_ENABLED is OFF (default)', () => {
        beforeEach(() => getConfigValue.mockReturnValue(false));

        it('register() 404s without touching the service', async () => {
            await expect(controller().register({ email: 'a@b.com', password: 'x', tenantName: 'Acme' } as never)).rejects.toThrow(NotFoundException);
            expect(register).not.toHaveBeenCalled();
        });

        it('verify() 404s without touching the service', async () => {
            await expect(controller().verify({ token: 'raw' } as never)).rejects.toThrow(NotFoundException);
            expect(verify).not.toHaveBeenCalled();
        });
    });

    describe('when REGISTRATION_SELF_SIGNUP_ENABLED is ON', () => {
        beforeEach(() => getConfigValue.mockReturnValue(true));

        it('register() delegates to the service and returns a generic accepted body', async () => {
            register.mockResolvedValue(undefined);

            const result = await controller().register({ email: 'a@b.com', password: 'x', tenantName: 'Acme' } as never);

            expect(register).toHaveBeenCalledWith({ email: 'a@b.com', password: 'x', tenantName: 'Acme' });
            expect(result).toEqual({ success: true });
        });

        it('verify() delegates to the service and returns its result', async () => {
            verify.mockResolvedValue({ userId: 'u1', tenantId: 't1', tenantKey: 'acme' });

            const result = await controller().verify({ token: 'raw-token' } as never);

            expect(verify).toHaveBeenCalledWith('raw-token');
            expect(result).toEqual({ userId: 'u1', tenantId: 't1', tenantKey: 'acme' });
        });
    });
});
