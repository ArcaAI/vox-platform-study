import 'server-only';
import { serverEnv } from '@/config/env';
import type { SessionPayload } from '@/server/session';

/** All gateway routes live under /api/v1. `path` must not start with a slash. */
export function gatewayUrl(path: string, search = ''): string {
    return `${serverEnv().API_URL}/api/v1/${path}${search}`;
}

/**
 * The browser's User-Agent, forwarded on BFF → gateway calls so
 * audit rows (LOGIN, impersonation brackets, per-request impersonated
 * actions) record the operator's real client. Without it, Node's fetch
 * (undici) sends its hardcoded default and the gateway audits "node".
 */
export function clientUserAgentHeader(request: Request): Record<string, string> {
    const userAgent = request.headers.get('user-agent');
    return userAgent ? { 'user-agent': userAgent } : {};
}

/** The token requests act with: the impersonation token while active. */
export function activeAccessToken(session: SessionPayload): string {
    return session.impersonation?.accessToken ?? session.accessToken;
}

/** Extracts the gateway's error message for safe passthrough to the client. */
export async function gatewayErrorMessage(response: Response, fallback: string): Promise<string> {
    try {
        const body = (await response.clone().json()) as { message?: string | string[] };
        if (Array.isArray(body.message)) return body.message.join('; ');
        return body.message || fallback;
    } catch {
        return fallback;
    }
}
