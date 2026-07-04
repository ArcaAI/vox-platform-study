import 'server-only';
import { z } from 'zod';

/**
 * Server-side environment (rule 13): validated with zod, never exposed to the
 * client bundle. New runtime vars must also be registered in
 * turbo.json#globalEnv and mirrored in .env.dev / .env.example.
 */
const serverEnvSchema = z.object({
    /** HOPE API gateway origin the BFF talks to (all routes under /api/v1). */
    API_URL: z.url().default('http://localhost:8868'),
    /**
     * Secret the encrypted session cookie (jose JWE, dir + A256GCM) is keyed
     * from; the 32-byte AES key is derived via SHA-256 in src/server/session.ts.
     */
    ADMIN_SESSION_SECRET: z.string().min(32, 'ADMIN_SESSION_SECRET must be at least 32 characters'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(raw: Record<string, string | undefined>): ServerEnv {
    const result = serverEnvSchema.safeParse({
        API_URL: raw.API_URL || undefined,
        ADMIN_SESSION_SECRET: raw.ADMIN_SESSION_SECRET,
    });
    if (!result.success) {
        const details = result.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`).join('; ');
        throw new Error(`Invalid admin-console server environment — ${details}`);
    }
    return result.data;
}

let cached: ServerEnv | null = null;

/** Lazily validated so build-time module evaluation never requires secrets. */
export function serverEnv(): ServerEnv {
    cached ??= parseServerEnv(process.env);
    return cached;
}
