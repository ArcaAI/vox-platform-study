/**
 * TASK-307 W5.2 — Prisma Studio surface hardening (AC-16, audit C-9).
 *
 * The GET handler must:
 *   1. Refuse `@Public()` access — only authenticated `manage:all` callers
 *      may serve the studio shell.
 *   2. Read the bearer token from the `Authorization` header (server-side)
 *      instead of accepting a JWT via `?token=` query string (the audit's
 *      "JWT-in-URL" leak vector via CDN / browser / proxy logs).
 *
 * Module-level gating must also fail-closed in production: BOTH
 *   `NODE_ENV === 'development'` AND `ENABLE_PRISMA_STUDIO === 'true'`
 * are now required (closes the previous permissive default).
 *
 * @vitest-environment node
 */

import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { PrismaStudioController } from '../pstudio.controller';
import { shouldEnablePrismaStudio } from '../pstudio.module';
import type { Request, Response } from 'express';

const REQUIRED_PERMISSIONS_KEY = 'required_permissions';
const PUBLIC_METADATA_KEY = 'skip_auth';

const makeStudioService = () => ({
    executeQuery: vi.fn().mockResolvedValue([]),
    executeSequence: vi.fn().mockResolvedValue([]),
});

const makeRes = () => {
    const res: Partial<Response> = {
        status: vi.fn().mockReturnThis() as unknown as Response['status'],
        type: vi.fn().mockReturnThis() as unknown as Response['type'],
        send: vi.fn().mockReturnThis() as unknown as Response['send'],
    };
    return res as Response & {
        status: ReturnType<typeof vi.fn>;
        type: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
    };
};

const makeReq = (overrides: { authorization?: string; protocol?: string; host?: string } = {}): Request => {
    const headers: Record<string, string> = {};
    if (overrides.authorization) headers['authorization'] = overrides.authorization;
    if (overrides.host) headers['host'] = overrides.host;
    return {
        headers,
        protocol: overrides.protocol ?? 'https',
        get: ((name: string) => (name.toLowerCase() === 'host' ? overrides.host ?? 'api.test' : undefined)) as Request['get'],
    } as unknown as Request;
};

describe('TASK-307 W5.2 — PrismaStudioController GET hardening (AC-16, audit C-9)', () => {
    describe('Authorisation metadata', () => {
        it('NO LONGER carries @Public() metadata on the GET handler', () => {
            const isPublic = Reflect.getMetadata(
                PUBLIC_METADATA_KEY,
                PrismaStudioController.prototype.serveStudio,
            );
            expect(isPublic).toBeFalsy();
        });

        it('declares @Authorize(["manage","all"]) on the GET handler (matches POST)', () => {
            const required = Reflect.getMetadata(
                REQUIRED_PERMISSIONS_KEY,
                PrismaStudioController.prototype.serveStudio,
            );
            expect(required).toBeDefined();
            expect(Array.isArray(required)).toBe(true);
            expect(required).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ action: 'manage', subject: 'all' }),
                ]),
            );
        });
    });

    describe('serveStudio() behaviour', () => {
        it('renders the HTML shell with the token extracted from the Authorization header', () => {
            const controller = new PrismaStudioController(makeStudioService() as never);
            const res = makeRes();
            const req = makeReq({
                authorization: 'Bearer header-bearer-token-xyz',
                protocol: 'https',
                host: 'api.test',
            });

            controller.serveStudio(req, res);

            expect(res.status).not.toHaveBeenCalledWith(401);
            // HTML body must embed the token that arrived via Authorization
            // (NOT a token from a `?token=` query string — that vector is
            // now forbidden).
            const sentHtml = String((res.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '');
            expect(sentHtml).toContain('Bearer header-bearer-token-xyz');
            expect(res.type).toHaveBeenCalledWith('text/html');
        });

        it('returns 401 when no Authorization Bearer header is present (no `?token=` fallback)', () => {
            const controller = new PrismaStudioController(makeStudioService() as never);
            const res = makeRes();
            // No authorization header, no `?token=` query param accepted.
            const req = makeReq({});

            controller.serveStudio(req, res);

            expect(res.status).toHaveBeenCalledWith(401);
            // The 401 body MUST NOT instruct the caller to put a JWT in
            // the URL — that copy is what created the audit C-9 leak in
            // the first place.
            const sentBody = String((res.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '');
            expect(sentBody).not.toMatch(/\?token=/);
        });

        it('returns 401 when Authorization header is present but not a Bearer scheme', () => {
            const controller = new PrismaStudioController(makeStudioService() as never);
            const res = makeRes();
            const req = makeReq({ authorization: 'Basic dXNlcjpwYXNz' });

            controller.serveStudio(req, res);

            expect(res.status).toHaveBeenCalledWith(401);
            // The 401 must also not regress to the old "?token=" copy.
            const sentBody = String((res.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '');
            expect(sentBody).not.toMatch(/\?token=/);
            expect(sentBody).not.toContain('<!DOCTYPE html>');
        });
    });
});

describe('TASK-307 W5.2 — shouldEnablePrismaStudio() module gating (AC-16)', () => {
    it('returns FALSE when NODE_ENV is production, regardless of ENABLE_PRISMA_STUDIO', () => {
        expect(
            shouldEnablePrismaStudio({ NODE_ENV: 'production', ENABLE_PRISMA_STUDIO: 'true' }),
        ).toBe(false);
        expect(
            shouldEnablePrismaStudio({ NODE_ENV: 'production', ENABLE_PRISMA_STUDIO: undefined }),
        ).toBe(false);
    });

    it('returns FALSE when NODE_ENV is staging / preview / anything other than development', () => {
        expect(
            shouldEnablePrismaStudio({ NODE_ENV: 'staging', ENABLE_PRISMA_STUDIO: 'true' }),
        ).toBe(false);
        expect(
            shouldEnablePrismaStudio({ NODE_ENV: 'test', ENABLE_PRISMA_STUDIO: 'true' }),
        ).toBe(false);
    });

    it('returns FALSE when NODE_ENV is development but ENABLE_PRISMA_STUDIO is not "true"', () => {
        expect(
            shouldEnablePrismaStudio({ NODE_ENV: 'development', ENABLE_PRISMA_STUDIO: undefined }),
        ).toBe(false);
        expect(
            shouldEnablePrismaStudio({ NODE_ENV: 'development', ENABLE_PRISMA_STUDIO: 'false' }),
        ).toBe(false);
        expect(
            shouldEnablePrismaStudio({ NODE_ENV: 'development', ENABLE_PRISMA_STUDIO: '1' }),
        ).toBe(false);
    });

    it('returns TRUE only when BOTH conditions hold: NODE_ENV=development AND ENABLE_PRISMA_STUDIO=true', () => {
        expect(
            shouldEnablePrismaStudio({ NODE_ENV: 'development', ENABLE_PRISMA_STUDIO: 'true' }),
        ).toBe(true);
    });
});
