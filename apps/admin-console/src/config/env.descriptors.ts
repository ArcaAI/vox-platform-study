// The admin console's declared environment surface — TASK-558 lane D
// (plan §9.1 D1: schema is the source of truth, example files are generated).
//
// ONE declaration, three consumers:
//   * `env.ts`              builds the zod schema for the SERVER-scoped vars.
//   * `public-env.ts`       reads the CLIENT-scoped var by literal member access
//                           (required so Next.js can inline it into the bundle).
//   * `scripts/env-sync.ts` generates `apps/admin-console/.env.sample` and the
//                           `turbo.json#globalEnv` entries.
//
// WHY A LOCAL SHAPE INSTEAD OF `SettingDescriptor` FROM `@arcaai/applications`:
// that package is the NestJS application layer. Importing it here would drag the
// whole server-side dependency graph into a Next.js app's module graph for the
// sake of one interface. The fields below map 1:1 onto the registry vocabulary
// (`required` ⇔ `failMode: 'closed'`, plan §4 B4), and because each entry states
// its ENV VAR NAME directly there is no dotted-key mapping to duplicate — the
// `toEnvVarName()` obligation applies only to registry-sourced dotted keys.
//
// Every entry corresponds to a verified reader, named in its description;
// `default` is transcribed from that reader's own fallback.

export interface AdminConsoleEnvVar {
    /** The environment variable name, exactly as an operator writes it. */
    readonly name: string;
    readonly type: 'string' | 'number' | 'secret';
    /** True ⇔ `failMode: 'closed'` — absence must fail fast, never default. */
    readonly required: boolean;
    readonly default?: string | number;
    /**
     * `server`  — validated by `env.ts`; never reaches the client bundle.
     * `client`  — inlined into the browser bundle; MUST be non-secret.
     * `tooling` — consumed by dev/test shell scripts, not by app code.
     */
    readonly scope: 'server' | 'client' | 'tooling';
    readonly label: string;
    readonly description: string;
}

export const ADMIN_CONSOLE_ENV_SETTINGS: readonly AdminConsoleEnvVar[] = [
    {
        name: 'API_URL',
        type: 'string',
        required: false,
        default: 'http://localhost:8868',
        scope: 'server',
        label: 'Gateway origin (server side)',
        description: 'Origin the BFF proxy (`src/app/api/hope/[...path]/route.ts`) forwards to. Server-side only — never reaches the client bundle.',
    },
    {
        name: 'ADMIN_SESSION_SECRET',
        type: 'secret',
        required: true,
        scope: 'server',
        label: 'Session cookie secret',
        description:
            'Secret the encrypted session cookie (jose JWE, dir + A256GCM) is keyed from; the 32-byte AES key is derived via SHA-256 in `src/server/session.ts`. Minimum 32 characters — the console refuses to start without it.',
    },
    {
        name: 'NEXT_PUBLIC_API_HOST',
        type: 'string',
        required: false,
        default: 'http://localhost:8868',
        scope: 'client',
        label: 'Gateway origin (browser side)',
        description:
            'Origin the BROWSER connects to directly for SSE/WS streams (authenticated with single-use stream tickets). Inlined into the client bundle by Next.js, so it must be non-secret (`src/config/public-env.ts`).',
    },
    {
        name: 'ADMIN_PORT',
        type: 'number',
        required: false,
        default: 5176,
        scope: 'tooling',
        label: 'Dev/test server port',
        description: 'Port the dev (5176) or test (5276) console binds — read by `scripts/dev-stack.sh` and `scripts/start-test-app.sh`, not by application code.',
    },
];
