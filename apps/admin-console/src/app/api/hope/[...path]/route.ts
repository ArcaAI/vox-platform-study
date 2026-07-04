import { handleProxy } from '@/server/hope-proxy';

/**
 * Catch-all BFF proxy: /api/hope/<path> -> ${API_URL}/api/v1/<path>.
 * All logic (auth header, tenant scope, OCC headers, 401 recovery) lives in
 * src/server/hope-proxy.ts where it is unit-tested.
 */
type RouteContext = { params: Promise<{ path: string[] }> };

async function handler(request: Request, context: RouteContext): Promise<Response> {
    const { path } = await context.params;
    return handleProxy(request, path);
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
