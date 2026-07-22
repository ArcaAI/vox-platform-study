import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import proxy from '../proxy';

function requestFor(pathname: string, cookie?: string): NextRequest {
    const headers = cookie ? { cookie } : undefined;
    return new NextRequest(new Request(`http://console.local${pathname}`, { headers }));
}

describe('proxy (public register/verify-email routes)', () => {
    it.each(['/register', '/verify-email', '/api/auth/register', '/api/auth/register/verify'])(
        'lets an unauthenticated request through to %s',
        (path) => {
            const response = proxy(requestFor(path));
            expect(response.status).toBe(200); // NextResponse.next() reports 200/no redirect
        },
    );

    it('still redirects an unauthenticated request to a protected page', () => {
        const response = proxy(requestFor('/tenants'));
        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toContain('/login');
    });

    it('still 401s an unauthenticated request to a protected API route', () => {
        const response = proxy(requestFor('/api/hope/admin/tenants'));
        expect(response.status).toBe(401);
    });
});
