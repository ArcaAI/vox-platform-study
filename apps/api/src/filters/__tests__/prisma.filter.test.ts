/**
 * Prisma client exception filter sanitisation.
 *
 * The raw `exception.message` (which embeds column / constraint names)
 * must never reach the response body for any Prisma error code the filter
 * maps (P2002 / P2025 / P2003 / P2014) — the public body collapses to a
 * generic shape; the server-side log keeps the full detail.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';

import { PrismaClientExceptionFilter } from '../prisma.filter';
import { PrismaClientKnownRequestError } from '@arcaai/database';

function makePrismaError(opts: {
    code: string;
    meta: Record<string, unknown>;
    message: string;
}): PrismaClientKnownRequestError {
    const err = Object.assign(new Error(opts.message), {
        code: opts.code,
        meta: opts.meta,
        clientVersion: '0.0.0-test',
    });
    Object.setPrototypeOf(err, PrismaClientKnownRequestError.prototype);
    return err as unknown as PrismaClientKnownRequestError;
}

function makeHost(): {
    host: ArgumentsHost;
    response: Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
    request: Request;
} {
    const response = {
        status: vi.fn().mockReturnThis() as unknown as Response['status'],
        json: vi.fn().mockReturnThis() as unknown as Response['json'],
    } as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
    const request = {
        method: 'POST',
        url: '/api/v1/users',
        requestId: 'corr-1',
    } as unknown as Request;
    const host: ArgumentsHost = {
        switchToHttp: () => ({
            getRequest: () => request,
            getResponse: () => response,
        }),
    } as unknown as ArgumentsHost;
    return { host, response, request };
}

describe('PrismaClientExceptionFilter sanitisation (audit)', () => {
    let filter: PrismaClientExceptionFilter;

    beforeEach(() => {
        filter = new PrismaClientExceptionFilter();
    });

    describe('P2002 — Unique constraint violation', () => {
        it('client body has NO message field carrying err.message', () => {
            const err = makePrismaError({
                code: 'P2002',
                meta: { target: ['secret_email_field'] },
                message: 'Unique constraint failed on the fields: (`secret_email_field`)',
            });
            const { host, response } = makeHost();

            filter.catch(err, host);

            expect(response.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
            const body = response.json.mock.calls[0]?.[0] as Record<string, unknown>;
            expect(JSON.stringify(body)).not.toContain('secret_email_field');
            expect(JSON.stringify(body)).not.toContain('Unique constraint failed');
        });

        it('client body shape is {statusCode, error, correlationId} only', () => {
            const err = makePrismaError({
                code: 'P2002',
                meta: { target: ['email'] },
                message: 'leak',
            });
            const { host, response } = makeHost();

            filter.catch(err, host);

            const body = response.json.mock.calls[0]?.[0] as Record<string, unknown>;
            expect(Object.keys(body).sort()).toEqual(['correlationId', 'error', 'statusCode'].sort());
            expect(body.error).toBe('Unique constraint violation');
            expect(body.correlationId).toBe('corr-1');
        });
    });

    describe('P2025 — Record not found', () => {
        it('client body does not leak err.message text', () => {
            const err = makePrismaError({
                code: 'P2025',
                meta: { cause: 'Record to update not found (id=secret-row-xyz).' },
                message: 'Record to update not found (id=secret-row-xyz).',
            });
            const { host, response } = makeHost();

            filter.catch(err, host);

            expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
            const body = response.json.mock.calls[0]?.[0] as Record<string, unknown>;
            expect(JSON.stringify(body)).not.toContain('secret-row-xyz');
        });
    });

    describe('P2003 — Foreign key constraint violation', () => {
        it('client body does not leak err.message text', () => {
            const err = makePrismaError({
                code: 'P2003',
                meta: { field_name: 'tenantId_fkey_secret' },
                message: 'Foreign key constraint failed on the field: `tenantId_fkey_secret`',
            });
            const { host, response } = makeHost();

            filter.catch(err, host);

            expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
            const body = response.json.mock.calls[0]?.[0] as Record<string, unknown>;
            expect(JSON.stringify(body)).not.toContain('tenantId_fkey_secret');
        });
    });

    describe('P2014 — Required relation violation', () => {
        it('client body does not leak err.message text', () => {
            const err = makePrismaError({
                code: 'P2014',
                meta: { relation_name: 'secret_relation' },
                message: 'The change you are trying to make would violate the required relation `secret_relation`',
            });
            const { host, response } = makeHost();

            filter.catch(err, host);

            expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
            const body = response.json.mock.calls[0]?.[0] as Record<string, unknown>;
            expect(JSON.stringify(body)).not.toContain('secret_relation');
        });
    });

    describe('Server-side observability preserved', () => {
        it('the server log STILL records errorCode + errorMessage + errorMeta (so SREs can debug)', () => {
            const err = makePrismaError({
                code: 'P2002',
                meta: { target: ['email'] },
                message: 'Unique constraint failed',
            });
            const { host } = makeHost();
            const errorSpy = vi.spyOn((filter as any).logger, 'error').mockImplementation(() => undefined);

            filter.catch(err, host);

            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'Prisma database error',
                    errorCode: 'P2002',
                    errorMeta: expect.objectContaining({ target: ['email'] }),
                    errorMessage: expect.stringContaining('Unique constraint failed'),
                }),
            );
        });
    });
});
