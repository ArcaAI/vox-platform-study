#!/usr/bin/env tsx
/**
 * `pnpm env:sync` — generate every managed environment artifact from the ONE
 * declared surface, and `pnpm env:sync --check` — fail on drift.
 *
 * TASK-558 lane D (plan §9.1 D1/D2/D8, §5 Phase 3).
 *
 * ─── THE DECLARED SURFACE (the only source of truth) ─────────────────────────
 *   1. `HOPE_SETTINGS_REGISTRY`  — the settings-registry catalog. Only the
 *      ENV-SUPPLIED tiers are rendered: `env` (deploy-time) and `vault-kv`
 *      (Vault kv-v2, but read from `process.env` under the `env` secrets
 *      provider — same NAME either way). `db-config` / `global-kv` /
 *      `db-secret` / `entitlement` are CONTROL-PLANE tiers: putting them in an
 *      env file would re-create the drift this ticket exists to remove.
 *   2. `API_ENV_DESCRIPTORS`     — the gateway's own declarations
 *      (`apps/api/src/config/`), which also build its boot-time zod schema.
 *   3. `ADMIN_CONSOLE_ENV_SETTINGS` — the console's declarations
 *      (`apps/admin-console/src/config/`), which also build its zod schema.
 *   4. `TOOLS_ENV_SETTINGS`      — `@arcaai/tools`' single generator knob. It
 *      has no config module of its own, so it is declared below.
 *
 * Env-var names come from `toEnvVarName()` for every registry-sourced dotted
 * key — never hand-copied (plan §3.3).
 *
 * ─── MANAGED OUTPUTS ─────────────────────────────────────────────────────────
 *   • `.env.example`                       the BOOTSTRAP FLOOR only (plan §3.3)
 *   • `apps/api/.env.sample`               the platform contract beyond the floor
 *   • `apps/admin-console/.env.sample`     the console's own contract
 *   • `packages/tools/.env.sample`         the generator knob
 *   • `turbo.json#globalEnv`                declared surface ∪ real TS reads
 *   • `docs/implementation/TASK-558-Environment-Configuration-Refactor/env-surface.generated.md`
 *
 * (TASK-584: per-app generated targets renamed `.env.example` → `.env.sample`
 * for naming consistency with the hand-maintained Python examples and the
 * root consolidated `.env.sample`, TASK-583. Only the root bootstrap-floor
 * file keeps the `.env.example` name — it isn't itself "a service".)
 *
 * ─── DELIBERATELY *NOT* MANAGED (declared boundary, not an oversight) ────────
 *   • `apps/{stt,smr,guardrail,nlp,harness,tts}/.env.sample` — their schema is
 *     pydantic-settings, which the drift gate cannot import (CI has no Python
 *     service environment), and whose FULL field surface is ~500 keys against
 *     the plan's ~120-key target (§8). Their operator documentation therefore
 *     stays hand-maintained; the keys of theirs that ARE registry-declared
 *     appear in the generated docs table with an explicit owner column.
 *   • `apps/example`, `apps/ui-playground` — Vite demos whose vars are
 *     `import.meta.env.VITE_*`, not process env.
 *   • `.env.test`, per-app `.env.prod` — environment TEMPLATES with
 *     deliberately environment-specific values (`.env.test` runs the DEV+100
 *     port scheme of commit d84f538e), not declarations. Neither is loaded
 *     directly by any application (TASK-583/584) — `.env.test` is generated
 *     at setup time, and `.env.prod` files are ops reference only.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_CONSOLE_ENV_SETTINGS, type AdminConsoleEnvVar } from '../apps/admin-console/src/config/env.descriptors';
import { API_ENV_DESCRIPTORS, NOT_READ_BY_THIS_PROCESS, VAULT_CONDITIONAL } from '../apps/api/src/config/env.schema';
import { HOPE_SETTINGS_REGISTRY } from '../packages/applications/src/services/settings-registry/registry';
import { toEnvVarName, type SettingDescriptor } from '../packages/applications/src/services/settings-registry/registry.types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TICKET_DOC = 'docs/implementation/TASK-558-Environment-Configuration-Refactor';

/** Tiers whose values are supplied through the process environment. */
const ENV_SUPPLIED_TIERS = new Set(['env', 'vault-kv']);

/** `@arcaai/tools` has no config module; its one knob is declared here. */
const TOOLS_ENV_SETTINGS: SettingDescriptor[] = [
    {
        key: 'outputPath',
        tier: 'env',
        dataType: 'string',
        sensitivity: 'internal',
        maxScope: 'system',
        editableBy: 'none',
        failMode: 'open-to-default',
        category: 'Code generation',
        label: 'Generator output base path',
        description: 'Base path the domain-layer generators write to, relative to `packages/tools` (`generate-data-model`, `generate-data-entity`, `generate-factory`).',
        default: '..',
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// Render model
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvVar {
    name: string;
    tier: SettingDescriptor['tier'];
    /** True ⇔ `failMode: 'closed'` — absence must fail fast (plan §4 B4). */
    required: boolean;
    secret: boolean;
    default?: unknown;
    category: string;
    label: string;
    description: string;
    /** The deployable that READS it — the docs table's owner column. */
    owner: string;
}

/** Which deployable owns a variable, from the prefix convention of plan §3.3 R5.1. */
const SERVICE_PREFIX: ReadonlyArray<readonly [string, string]> = [
    ['STT_', 'apps/stt'],
    ['SMR_', 'apps/smr'],
    ['GUARDRAIL_', 'apps/guardrail'],
    ['NLP_', 'apps/nlp'],
    ['HARNESS_', 'apps/harness'],
    ['TTS_', 'apps/tts'],
    ['TEMPORAL_', 'apps/harness'],
];

/**
 * The gateway also reads a downstream service's `*_URL` (it calls it) and its
 * `*_SERVICE_TOKEN` (it authenticates with it) — those are shared, not
 * service-private.
 */
function ownerOf(name: string): string {
    if (/_URL$/.test(name) || /_SERVICE_TOKEN$/.test(name)) return 'apps/api';
    const match = SERVICE_PREFIX.find(([prefix]) => name.startsWith(prefix));
    return match ? match[1] : 'apps/api';
}

function fromDescriptor(descriptor: SettingDescriptor, owner?: string): EnvVar {
    const name = toEnvVarName(descriptor.key);
    return {
        name,
        tier: descriptor.tier,
        required: descriptor.failMode === 'closed',
        secret: descriptor.sensitivity === 'secret',
        default: descriptor.default,
        category: descriptor.category,
        label: descriptor.label ?? name,
        description: descriptor.description ?? '',
        owner: owner ?? ownerOf(name),
    };
}

function fromAdminConsole(descriptor: AdminConsoleEnvVar): EnvVar {
    return {
        name: descriptor.name,
        tier: 'env',
        required: descriptor.required,
        secret: descriptor.type === 'secret',
        default: descriptor.default,
        category: descriptor.scope === 'tooling' ? 'Tooling' : 'Admin Console',
        label: descriptor.label,
        description: descriptor.description,
        owner: 'apps/admin-console',
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Partitioning the surface
// ─────────────────────────────────────────────────────────────────────────────

const registryEnvSupplied = HOPE_SETTINGS_REGISTRY.list()
    .filter((d) => ENV_SUPPLIED_TIERS.has(d.tier))
    .map((d) => fromDescriptor(d));

/** The bootstrap floor: what a process needs to REACH the DB / authenticate to Vault. */
const bootstrapFloor = registryEnvSupplied.filter((v) => v.category === 'Bootstrap');
const bootstrapNames = new Set(bootstrapFloor.map((v) => v.name));

const apiDeclared = API_ENV_DESCRIPTORS.map((d) => fromDescriptor(d));
const apiDeclaredNames = new Set(apiDeclared.map((v) => v.name));

/**
 * Everything declared beyond the floor. Since lane C, every TS *and* Python
 * deployable reads the SAME `.env.<NODE_ENV>` file, so this is one shared
 * contract document; the `owner` column of the generated docs table records
 * which deployable actually reads each line.
 */
const platformSurface = [...apiDeclared, ...registryEnvSupplied.filter((v) => !apiDeclaredNames.has(v.name))].filter((v) => !bootstrapNames.has(v.name));

const adminConsoleSurface = ADMIN_CONSOLE_ENV_SETTINGS.map(fromAdminConsole);
const toolsSurface = TOOLS_ENV_SETTINGS.map((d) => fromDescriptor(d, 'packages/tools'));

/** Every declared key, deduplicated by name — the surface plan §8 counts. */
export const declaredSurface: EnvVar[] = (() => {
    const byName = new Map<string, EnvVar>();
    for (const v of [...bootstrapFloor, ...platformSurface, ...adminConsoleSurface, ...toolsSurface]) {
        if (!byName.has(v.name)) byName.set(v.name, v);
    }
    return [...byName.values()];
})();

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

const BANNER = (source: string) =>
    [
        '# ============================================================================',
        '# GENERATED FILE — DO NOT EDIT BY HAND.',
        '#',
        `# Produced by \`pnpm env:sync\` from ${source}.`,
        '# `pnpm env:sync --check` fails the build (CI job `env-drift-check`) when this',
        '# file and the schema disagree. To change a variable, change its DECLARATION',
        '# and regenerate — editing this file is reverted by the next sync.',
        '#',
        '# Committed example files carry PLACEHOLDERS ONLY, never secrets (plan §9.1 D3).',
        '# ============================================================================',
    ].join('\n');

/**
 * The value written for a variable: never a real secret (plan §9.1 D3).
 *   secret            → `<CHANGE_ME>`
 *   required, no code default → `<CHANGE_ME>` (the operator MUST supply one)
 *   otherwise         → the declared default, or empty for "unset by default"
 */
function exampleValue(v: EnvVar): string {
    if (v.secret) return '<CHANGE_ME>';
    if (v.default !== undefined) return String(v.default);
    return v.required ? '<CHANGE_ME>' : '';
}

/**
 * How a variable's requirement is annotated. `failMode: 'closed'` alone
 * OVERSTATES two cases, so the exception sets that `apps/api/src/config/
 * env.schema.ts` already applies at boot are imported rather than restated here
 * — one declaration of the exception, honoured by both the validator and the
 * generated documentation.
 */
function requirementNote(v: EnvVar, verbose: boolean): string {
    if (NOT_READ_BY_THIS_PROCESS.has(v.name)) return ' (Vault provisioning only)';
    if (VAULT_CONDITIONAL.has(v.name)) return ' (required with Vault; either form)';
    if (!v.required) return '';
    return verbose ? ' (REQUIRED — boot fails without it)' : ' (REQUIRED)';
}

function wrap(text: string, width: number, prefix: string): string[] {
    if (!text) return [];
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
        if (line && `${line} ${word}`.length + prefix.length > width) {
            lines.push(prefix + line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) lines.push(prefix + line);
    return lines;
}

/** Group preserving first-seen category order. */
function byCategory(vars: EnvVar[]): Map<string, EnvVar[]> {
    const groups = new Map<string, EnvVar[]>();
    for (const v of vars) {
        const bucket = groups.get(v.category);
        if (bucket) bucket.push(v);
        else groups.set(v.category, [v]);
    }
    return groups;
}

/** Compact rendering: one label comment per variable. Used for the root floor. */
function renderCompact(vars: EnvVar[]): string[] {
    const out: string[] = [];
    for (const [category, group] of byCategory(vars)) {
        out.push('', `# ── ${category} ${'─'.repeat(Math.max(0, 68 - category.length))}`);
        for (const v of group) {
            out.push(`# ${v.label}${requirementNote(v, false)}`);
            out.push(`${v.name}=${exampleValue(v)}`);
        }
    }
    return out;
}

/** Full rendering: label + wrapped description + owner. Used for app files. */
function renderVerbose(vars: EnvVar[]): string[] {
    const out: string[] = [];
    for (const [category, group] of byCategory(vars)) {
        out.push('', `# ── ${category} ${'─'.repeat(Math.max(0, 68 - category.length))}`);
        for (const v of group) {
            out.push('');
            out.push(`# ${v.label}${requirementNote(v, true)}`);
            out.push(...wrap(v.description, 116, '#   '));
            out.push(`#   tier: ${v.tier} · read by: ${v.owner}`);
            out.push(`${v.name}=${exampleValue(v)}`);
        }
    }
    return out;
}

function renderRootExample(): string {
    return [
        BANNER('the `Bootstrap` category of the settings registry\n# (packages/applications/src/services/settings-registry/descriptors/bootstrap-env.descriptors.ts)'),
        '#',
        '# THE BOOTSTRAP FLOOR — and nothing else.',
        '#',
        '# A variable belongs here only if it is required TO REACH the database or TO',
        '# AUTHENTICATE to Vault (plan §3.2). Everything else lives in the database or',
        '# in Vault, or in the deployable-specific example file next to it.',
        '#',
        '# `.env.dev` is gitignored and CI/production load no file at all — host env',
        '# only. Locally, `pnpm setup:dev` creates `.env.dev` for you (only if it',
        '# does not already exist) from the consolidated `.env.sample` at the repo',
        '# root (TASK-583) — since TASK-558 lane C, the TypeScript gateway AND all',
        '# six Python services read that ONE resulting file. See',
        '# docs/architecture/environment-configuration-reference.md for the full',
        '# variable reference.',
        ...renderCompact(bootstrapFloor),
        '',
    ].join('\n');
}

function renderApiExample(): string {
    return [
        BANNER('the settings registry + apps/api/src/config/env.descriptors.ts'),
        '#',
        '# THE PLATFORM CONTRACT BEYOND THE BOOTSTRAP FLOOR.',
        '#',
        '# The floor itself (DATABASE_URL, REDIS_*, VAULT_*, …) lives in the repo-root',
        '# `.env.example`; this file carries everything else the platform declares.',
        '#',
        '# Since lane C there is ONE env file per environment, shared by the gateway and',
        '# all six Python services, so this is one shared contract: the `read by:` note',
        '# on each variable records which deployable actually consumes it.',
        '#',
        '# Every variable here is also validated at gateway boot by',
        '# `apps/api/src/config/env.schema.ts`, before `NestFactory.create()`.',
        ...renderVerbose(platformSurface),
        '',
    ].join('\n');
}

function renderAdminConsoleExample(): string {
    return [
        BANNER('apps/admin-console/src/config/env.descriptors.ts'),
        '#',
        '# The Next.js admin console. `API_URL` and `ADMIN_SESSION_SECRET` are validated',
        '# by `src/config/env.ts` (server-only); `NEXT_PUBLIC_API_HOST` is inlined into',
        '# the client bundle and MUST stay non-secret.',
        ...renderVerbose(adminConsoleSurface),
        '',
    ].join('\n');
}

function renderToolsExample(): string {
    return [BANNER('scripts/env-sync.mts (TOOLS_ENV_SETTINGS)'), ...renderVerbose(toolsSurface), ''].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// turbo.json#globalEnv
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every environment variable TypeScript code actually READS.
 *
 * `turbo.json#globalEnv` is a CACHE-CORRECTNESS declaration, not documentation:
 * `turbo/no-undeclared-env-vars` (active via `eslint-config-turbo`) fails lint
 * for any `process.env.X` that is missing from it. So the list is the declared
 * surface UNIONED with a scan of the real reads — which is also what makes the
 * 29 registered-but-nonexistent entries the plan counted disappear on their own,
 * instead of being patched away by hand.
 *
 * WRITES are excluded (`process.env.NO_COLOR = '1'` is not a config input), and
 * comments are stripped first so a `process.env.X` inside prose cannot register
 * a phantom variable.
 */
function scanTypeScriptReads(): Set<string> {
    const listed = execSync('git ls-files "*.ts" "*.tsx" "*.mts" "*.cts" "*.mjs" "*.js"', { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .filter((f) => !f.includes('node_modules') && !f.startsWith('docs/'));

    const isTestFile = (f: string) => /(^|\/)(__tests__|__mocks__|tests|test)\//.test(f) || /\.(test|spec|e2e-spec)\.[cm]?[jt]sx?$/.test(f);

    const READ = /process\.env(?:\.([A-Z][A-Z0-9_]{1,})|\[\s*['"`]([A-Z][A-Z0-9_]{1,})['"`]\s*\])\s*(=[^=]|$|[^=])/g;
    const found = new Set<string>();
    for (const file of listed) {
        if (isTestFile(file)) continue;
        const source = readFileSync(join(ROOT, file), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        let match: RegExpExecArray | null;
        while ((match = READ.exec(source)) !== null) {
            const tail = match[3] ?? '';
            // `process.env.X =` is a WRITE — not an input to the cache key.
            if (/^=[^=]/.test(tail)) continue;
            found.add((match[1] ?? match[2]) as string);
        }
    }
    return found;
}

function computeGlobalEnv(): string[] {
    const names = new Set<string>(declaredSurface.map((v) => v.name));
    for (const name of scanTypeScriptReads()) names.add(name);
    return [...names].sort();
}

function renderTurboJson(globalEnv: string[]): string {
    const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8')) as Record<string, unknown>;
    turbo.globalEnv = globalEnv;
    return `${JSON.stringify(turbo, null, 4)}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Docs table
// ─────────────────────────────────────────────────────────────────────────────

function renderDocsTable(globalEnv: string[]): string {
    const rows = [...declaredSurface].sort((a, b) => a.name.localeCompare(b.name));
    const counts = new Map<string, number>();
    for (const v of rows) counts.set(v.tier, (counts.get(v.tier) ?? 0) + 1);

    const lines = [
        '<!-- GENERATED FILE — DO NOT EDIT BY HAND. Produced by `pnpm env:sync`. -->',
        '',
        '# TASK-558 — The declared environment surface',
        '',
        'Generated from the settings registry plus each TypeScript deployable’s own',
        'schema. `pnpm env:sync --check` (CI job `env-drift-check`) fails when this file,',
        'the root `.env.example` / per-app `.env.sample` files, or `turbo.json#globalEnv`',
        'disagree with those declarations.',
        '',
        '## Summary',
        '',
        '| Metric | Value |',
        '|---|---:|',
        `| Declared keys (distinct) | ${rows.length} |`,
        `| … of which required (\`failMode: closed\`) | ${rows.filter((r) => r.required).length} |`,
        `| … of which secret | ${rows.filter((r) => r.secret).length} |`,
        ...[...counts.entries()].sort().map(([tier, n]) => `| … tier \`${tier}\` | ${n} |`),
        `| \`turbo.json#globalEnv\` entries | ${globalEnv.length} |`,
        '',
        '## Variables',
        '',
        '| Variable | Tier | Required | Default | Read by | Purpose |',
        '|---|---|---|---|---|---|',
    ];
    for (const v of rows) {
        const dflt = v.secret ? '`<CHANGE_ME>`' : v.default === undefined ? '—' : `\`${String(v.default)}\``;
        const purpose = (v.description || v.label).replace(/\|/g, '\\|').replace(/\n/g, ' ');
        lines.push(`| \`${v.name}\` | \`${v.tier}\` | ${v.required ? 'yes' : 'no'} | ${dflt} | \`${v.owner}\` | ${purpose} |`);
    }
    lines.push('');
    return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Drive
// ─────────────────────────────────────────────────────────────────────────────

interface Artifact {
    path: string;
    content: string;
}

export function buildArtifacts(): Artifact[] {
    const globalEnv = computeGlobalEnv();
    return [
        { path: '.env.example', content: renderRootExample() },
        { path: 'apps/api/.env.sample', content: renderApiExample() },
        { path: 'apps/admin-console/.env.sample', content: renderAdminConsoleExample() },
        { path: 'packages/tools/.env.sample', content: renderToolsExample() },
        { path: 'turbo.json', content: renderTurboJson(globalEnv) },
        { path: `${TICKET_DOC}/env-surface.generated.md`, content: renderDocsTable(globalEnv) },
    ];
}

/**
 * A readable drift report.
 *
 * Deliberately NOT a positional line-by-line diff: a single inserted key shifts
 * every following line, which renders as a wall of false differences. Instead it
 * reports the first differing line for location, then the SET difference — the
 * lines that are only on disk and the lines that are only in the regenerated
 * output — which is what an author actually needs to fix the drift.
 */
function driftReport(expected: string, actual: string): string {
    const actualLines = actual.split('\n');
    const expectedLines = expected.split('\n');
    const firstDiff = actualLines.findIndex((line, i) => line !== expectedLines[i]);

    const expectedSet = new Set(expectedLines);
    const actualSet = new Set(actualLines);
    const onlyOnDisk = actualLines.filter((l) => l.trim() && !expectedSet.has(l));
    const onlyGenerated = expectedLines.filter((l) => l.trim() && !actualSet.has(l));

    const show = (label: string, sign: string, lines: string[]) =>
        lines.length === 0
            ? []
            : [`    ${label} (${lines.length}):`, ...lines.slice(0, 10).map((l) => `      ${sign} ${l}`), ...(lines.length > 10 ? [`      … ${lines.length - 10} more`] : [])];

    return [
        `    first difference at line ${firstDiff === -1 ? actualLines.length + 1 : firstDiff + 1}`,
        ...show('on disk but not generated', '-', onlyOnDisk),
        ...show('generated but not on disk', '+', onlyGenerated),
    ].join('\n');
}

function main(): void {
    const check = process.argv.includes('--check');
    const artifacts = buildArtifacts();
    const drifted: string[] = [];

    for (const artifact of artifacts) {
        const full = join(ROOT, artifact.path);
        let onDisk = '';
        try {
            onDisk = readFileSync(full, 'utf8');
        } catch {
            onDisk = '';
        }
        if (onDisk === artifact.content) continue;
        if (check) {
            drifted.push(`✗ ${artifact.path}\n${driftReport(artifact.content, onDisk)}`);
        } else {
            writeFileSync(full, artifact.content);
            console.log(`updated  ${artifact.path}`);
        }
    }

    const keyCount = declaredSurface.length;
    const rootLines = artifacts.find((a) => a.path === '.env.example')!.content.split('\n').length;

    if (check) {
        if (drifted.length > 0) {
            console.error('env:sync --check FAILED — generated artifacts are out of date.\n');
            console.error(drifted.join('\n\n'));
            console.error('\nRun `pnpm env:sync` and commit the result.');
            process.exit(1);
        }
        console.log(`env:sync --check OK — ${artifacts.length} artifacts match the declared surface (${keyCount} keys, root example ${rootLines} lines).`);
        return;
    }

    console.log(`\nDeclared surface: ${keyCount} keys · root .env.example ${rootLines} lines · plan §8 targets ≤ ~120 keys and ≤ ~60 lines.`);
}

// `import`ed by the unit tests; executed by `pnpm env:sync`.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    main();
}
