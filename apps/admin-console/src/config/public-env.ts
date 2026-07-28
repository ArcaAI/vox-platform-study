/**
 * Client-safe environment. Only non-secret NEXT_PUBLIC_* values belong here
 * (rule 13). The literal process.env member access is required so Next.js can
 * inline the value into the client bundle.
 */
export const publicEnv = {
  /**
   * Gateway origin for DIRECT browser connections — SSE/WS streams
   * authenticate with single-use tickets minted via /api/auth/stream-ticket
   * and connect to the gateway without passing through the BFF proxy.
   */
  apiHost: process.env.NEXT_PUBLIC_API_HOST ?? 'http://localhost:8868',
} as const;
