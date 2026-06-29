/**
 * Resolves the HOPE API Gateway base URL for the admin app.
 *
 * The gateway mounts every route under the `api/v1` global prefix
 * (`apps/api/src/main.ts`), so the base URL MUST include `/api/v1` — the SDK
 * appends endpoint paths (e.g. `/auth/login`) directly onto it.
 *
 * In production the value is injected at build time via `VITE_API_URL` (see
 * `.env.example`). For local dev it defaults to the gateway's versioned origin
 * so the app works without an env file — mirroring `apps/ui-playground`.
 *
 * `||` (not `??`) is used so an empty `VITE_API_URL=` also falls back, never
 * producing a relative/version-less base URL (the previous `?? '/api'` default
 * sent requests to the dev origin, e.g. `http://localhost:5174/api/...`).
 */
export const DEFAULT_API_BASE_URL = 'http://localhost:8868/api/v1';

export function getApiBaseUrl(): string {
    return import.meta.env.VITE_API_URL || DEFAULT_API_BASE_URL;
}
