import 'server-only';
import { z } from 'zod';
import { ADMIN_CONSOLE_ENV_SETTINGS, type AdminConsoleEnvVar } from './env.descriptors';

/**
 * Server-side environment (rule 13): validated with zod, never exposed to the
 * client bundle.
 *
 * TASK-558 lane D — the shape is BUILT from `env.descriptors.ts`, so the schema,
 * `apps/admin-console/.env.example` and `turbo.json#globalEnv` all derive from
 * ONE declaration and cannot drift. `pnpm env:sync --check` is the gate.
 */
const SERVER_DESCRIPTORS = ADMIN_CONSOLE_ENV_SETTINGS.filter((d) => d.scope === 'server');

/**
 * Per-variable refinements the declaration vocabulary cannot express. Kept
 * explicit and tiny: a rule belongs here only when `type` genuinely cannot
 * carry it.
 */
const REFINEMENTS: Record<string, z.ZodType<string>> = {
    API_URL: z.url(),
    ADMIN_SESSION_SECRET: z.string().min(32, 'ADMIN_SESSION_SECRET must be at least 32 characters'),
};

function leaf(descriptor: AdminConsoleEnvVar): z.ZodType {
    const base = REFINEMENTS[descriptor.name] ?? z.string();
    // `required` ⇔ `failMode: 'closed'` (plan §4 B4): absence fails fast and is
    // never silently defaulted.
    if (descriptor.required) return base;
    return descriptor.default === undefined ? base.optional() : base.default(descriptor.default as never);
}

const serverEnvSchema = z.object({
    API_URL: leaf(SERVER_DESCRIPTORS.find((d) => d.name === 'API_URL')!) as z.ZodType<string>,
    ADMIN_SESSION_SECRET: leaf(SERVER_DESCRIPTORS.find((d) => d.name === 'ADMIN_SESSION_SECRET')!) as z.ZodType<string>,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(raw: Record<string, string | undefined>): ServerEnv {
    const candidate: Record<string, string> = {};
    for (const descriptor of SERVER_DESCRIPTORS) {
        // An empty value means "not configured" and must not defeat the default.
        const supplied = raw[descriptor.name];
        if (supplied) candidate[descriptor.name] = supplied;
    }
    const result = serverEnvSchema.safeParse(candidate);
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
