#!/usr/bin/env tsx
/**
 * `pnpm env:sync` — generate every managed environment artifact from the ONE
 * declared surface, and `pnpm env:sync --check` — fail on drift.
 *
 * ─── THE DECLARED SURFACE (the only source of truth) ─────────────────────────
 *   1. `HOPE_SETTINGS_REGISTRY` — the settings-registry catalog. Only the
 *      ENV-SUPPLIED tiers are rendered: `env` (deploy-time) and `vault-kv`
 *      (Vault kv-v2, but read from `process.env` under the `env` secrets
 *      provider — same NAME either way). `db-config` / `global-kv` /
 *      `db-secret` / `entitlement` are CONTROL-PLANE tiers: putting them in an
 *      env file would re-create the drift this generator exists to remove.
 *   2. `API_ENV_DESCRIPTORS` — the gateway's own declarations
 *      (`apps/api/src/config/`), which also build its boot-time zod schema.
 *   3. `ADMIN_CONSOLE_ENV_SETTINGS` — the console's declarations
 *      (`apps/admin-console/src/config/`), which also build its zod schema.
 *   4. `TOOLS_ENV_SETTINGS` — `@arcaai/tools`' single generator knob. It
 *      has no config module of its own, so it is declared below.
 *   5. `scripts/generated/python-env-surface.json` — the six Python services'
 *      pydantic-settings declarations plus their non-pydantic (`os.environ`)
 *      reads, emitted by `pnpm env:python-surface`. See "THE PYTHON HALF" below.
 *
 * Env-var names come from `toEnvVarName()` for every registry-sourced dotted
 * key — never hand-copied.
 *
 * ─── MANAGED OUTPUTS ─────────────────────────────────────────────────────────
 *   • `apps/api/.env.sample` the platform contract beyond the floor
 *   • `apps/admin-console/.env.sample` the console's own contract
 *   • `packages/tools/.env.sample` the generator knob
 *   • `apps/{stt,text,guardrail,nlp,harness,tts}/.env.sample`
 *                                          the six Python services, generated
 *                                          from their pydantic-settings
 * declarations
 *   • `.env.sample` CONSOLIDATED — the bootstrap floor
 *                                          + the 3 TS files + the 6 Python
 *                                          files above, assembled into ONE
 *                                          root artifact. This is what
 *                                          `pnpm setup:dev`/`pnpm setup:test`
 *                                          copy to create `.env.dev`/`.env.test`.
 *   • `turbo.json#globalEnv` declared surface ∪ real TS reads
 *
 * (The bootstrap floor originally lived in its own `.env.example`
 * file. A SEPARATE `.env.sample` was then hand-assembled that wrapped
 * `.env.example`'s content as its first section — two overlapping root
 * files, kept in sync by a script run by hand. That
 * duplication is gone: the floor is now rendered directly into `.env.sample`'s first
 * section by THIS generator, `.env.example` no longer exists, and `--check`
 * covers the whole consolidated file end to end.)
 *
 * ─── THE PYTHON HALF ────────────────────────────────────
 * This generator used to state that the six Python services were a "declared
 * boundary, not an oversight": their `.env.sample` files were hand-maintained
 * and inlined VERBATIM, and `scanTypeScriptReads()` globbed no `*.py`. The
 * stated reason was sound — TypeScript cannot import pydantic-settings — but
 * the consequence was not: 243 of 297 distinct Python env vars were invisible
 * to `env-drift-check`, so "the config migration is finished" could never be
 * falsified, and the assessment found the six samples understating the real
 * surface by ~2x with 15 keys declared against no reader at all.
 *
 * The boundary is now crossed by a MANIFEST rather than by an import:
 *
 *   `pnpm env:python-surface` (scripts/python-env-surface.py — needs Python)
 *        introspects every `BaseSettings` subclass with pydantic's OWN
 *        `EnvSettingsSource._extract_field_info`, harvests each field's `#`
 *        comment block as its description, AST-scans non-pydantic
 *        `os.environ` reads INCLUDING one-line helper indirection, and writes
 *        `scripts/generated/python-env-surface.json`.
 *
 *   THIS generator (needs no Python) reads that manifest as a declaration
 *        source and produces the six `.env.sample` files from it, folds every
 *        Python name into `turbo.json#globalEnv`, and lists them in the docs
 *        table. It ALSO regex-scans `*.py` for direct `os.environ` reads
 *        (`scanPythonReads()`) as an independent second opinion, so a newly
 *        added read fails `env:sync --check` even on a machine, or in a CI
 *        job, with no Python at all.
 *
 * The gates fail for different reasons and none subsumes another:
 * `env:python-surface --check` catches a stale MANIFEST (a pydantic field
 * changed), `env:sync --check` catches a stale ARTIFACT (a file generated from
 * the manifest was not regenerated).
 *
 * A THIRD gate covers the direction none of the above can see. Everything here
 * asks "is every var that is READ also DECLARED?"; `pnpm env:python-dead`
 * (also in scripts/python-env-surface.py) asks the reverse
 * — "is every DECLARED settings field actually READ?" A field nobody reads is
 * config theatre: an operator sets it, nothing happens, and no gate here would
 * ever notice. It is a stdlib AST pass, so it runs in its own zero-install CI
 * job (`python-dead-settings`) and needs neither this generator nor the
 * manifest.
 *
 * ─── DELIBERATELY *NOT* SCHEMA-VALIDATED (declared boundary, not an oversight) ─
 *   • `apps/example` — a Vite demo whose vars are `import.meta.env.VITE_*`,
 *     not process env.
 *   • `.env.test`, per-app `.env.prod` — environment TEMPLATES with
 *     deliberately environment-specific values (`.env.test` runs the DEV+100
 *     port scheme of commit d84f538e), not declarations. Neither is loaded
 *     directly by any application — `.env.test` is generated
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

/** Tiers whose values are supplied through the process environment. */
const ENV_SUPPLIED_TIERS = new Set(['env', 'vault-kv']);

// ─────────────────────────────────────────────────────────────────────────────
// The Python manifest (see "THE PYTHON HALF" in the header)
// ─────────────────────────────────────────────────────────────────────────────

interface PythonField {
    name: string;
    aliases: string[];
    class: string;
    field: string;
    prefix: string;
    required: boolean;
    secret: boolean;
    dataType: string;
    default: string | number | boolean | null;
    description: string;
}

interface PythonManifest {
    distinctNames: number;
    services: Record<string, { port: number; title: string; fields: PythonField[] }>;
    /** Names read outside pydantic-settings (`os.environ`), name → files. */
    bareReads: Record<string, string[]>;
}

const PYTHON_MANIFEST_PATH = 'scripts/generated/python-env-surface.json';

const pythonManifest: PythonManifest = JSON.parse(readFileSync(join(ROOT, PYTHON_MANIFEST_PATH), 'utf8'));

/** Fixed rendering order, so the consolidated file is stable across runs. */
const PYTHON_SERVICES = ['guardrail', 'harness', 'nlp', 'stt', 'text', 'tts'] as const;

/**
 * Local-dev values that are NOT the code default — the only hand-owned data in
 * the Python half, and the reason `pnpm setup:dev` yields a WORKING env
 *  rather than one a developer must fix by hand.
 *
 * A local-dev value cannot be derived from the code: the code default is what
 * the service should do in PRODUCTION, and these are the handful of places
 * where a laptop's local infrastructure legitimately disagrees. Everything
 * else renders from `default` and is emitted COMMENTED OUT — an env file
 * should carry the deltas, not restate 500 defaults it would then hold
 * hostage to drift.
 *
 * Each entry is seeded from the value the hand-maintained `.env.sample` it
 * replaces actually carried, so this is a preservation list, not new policy.
 * Add to it only with the reason written down.
 */
const PYTHON_LOCAL_DEV_VALUES: ReadonlyArray<readonly [name: string, value: string, why: string]> = [
    // LM Studio is the default local OpenAI-compatible endpoint. It ignores the
    // key's VALUE but rejects an EMPTY Authorization header, so the judge needs
    // a non-empty placeholder to work at all against a local model.
    ['HARNESS_JUDGE_OPENAI_COMPAT_API_KEY', 'lm-studio', 'LM Studio rejects an empty bearer token'],
    // LM Studio's OpenAI-compat surface does not implement `json_object`
    // response_format; asking for it fails the call outright.
    ['HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT', 'text', 'LM Studio has no `json_object` support'],
    // PHI posture, not a tuning knob: the OTel GenAI instrumentation would
    // otherwise capture prompt/completion CONTENT into spans. The code default
    // is empty (= the upstream library default, which captures), so leaving it
    // unset locally would put clinical text in telemetry.
    ['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'NO_CONTENT', 'keeps clinical text out of spans'],
    // WHERE Hugging Face caches weights, never WHICH checkpoint runs. It must
    // be declared rather than inherited from an interactive login shell:
    // `~/.zshrc` is not sourced by services, CI jobs or coding agents, so every
    // download otherwise lands in `~/.cache/huggingface`.
    ['HF_HOME', '/Volumes/aillusion/huggingface', 'services never see an interactive shell’s HF_HOME'],
];

const pythonLocalDevValue = new Map(PYTHON_LOCAL_DEV_VALUES.map(([name, value]) => [name, value]));

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

/**
 * Prose that the Python source does not carry.
 *
 * These fifteen knobs used to be DECLARED here as
 * `SettingDescriptor`s, because `turbo.json#globalEnv` is a repo-wide
 * cache-correctness declaration and a Python-read variable missing from it is
 * undeclared whatever language reads it. The Python manifest now declares them
 * — along with the other ~500 this file could not see — so the declaration is
 * gone and only the DESCRIPTIONS remain, keyed by env var name.
 *
 * Keeping them is not sentiment: `scripts/python-env-surface.py` harvests each
 * field's `#` comment block as its description, and six of these fifteen have
 * no comment in `apps/nlp/src/nlp/core/config.py` at all. Dropping the overlay
 * would silently downgrade the generated sample's documentation while the key
 * count went up. An entry here is a standing invitation to move the prose into
 * the Python source and delete the line.
 *
 * Every one is TRANSPORT or GEOMETRY — queue bounds, batch geometry, cache
 * retention, a filesystem root. None selects a model, a label set or a
 * threshold; those stay `AiTaskDefault` x `AiModel` per
 * `00-project-context.md` §Configuration Principles.
 */
const PYTHON_DESCRIPTION_OVERLAY: ReadonlyMap<string, string> = new Map([
    ['NLP_INFERENCE_MAX_CONCURRENT', 'Concurrent forward passes across all NLP models (bootstrap fallback; the runtime value comes from the control plane).'],
    ['NLP_INFERENCE_BATCH_MAX_SIZE', 'Maximum items coalesced into one NLP forward pass.'],
    ['NLP_INFERENCE_BATCH_LINGER_MS', 'How long an otherwise-idle NLP request waits for company before dispatching. This is the ENTIRE latency price of batching — keep it well under the p50 forward pass.'],
    ['NLP_INFERENCE_QUEUE_MAX_DEPTH', 'Bounded NLP inference queue depth; at the bound the service sheds with 503 + `Retry-After` instead of growing until OOM.'],
    ['NLP_INFERENCE_QUEUE_MAX_WAIT_SECONDS', 'Wait ceiling for a queued NLP inference item; exceeding it sheds with 503 rather than serving a stale answer.'],
    ['NLP_INFERENCE_MAX_INFLIGHT_BATCHES', 'Concurrent forward passes against ONE NLP model.'],
    ['NLP_MODEL_CACHE_TTL_SECONDS', 'Idle TTL before an NLP model is evicted from the in-process cache.'],
    ['NLP_MODEL_CACHE_MAX_MODELS', 'LRU ceiling on resident NLP models.'],
    ['NLP_MODEL_LOCAL_ROOTS', 'Optional allow-list of filesystem roots a configured LOCAL model path must resolve inside. Unset = unrestricted, deliberately and documented.'],
    ['NLP_INFERENCE_INTERACTIVE_BATCH_MAX_SIZE', 'Maximum items coalesced into one INTERACTIVE-lane forward pass. The synchronous inline gate and the asynchronous per-utterance pass are different service classes with different latency budgets, so they do not share a queue geometry.'],
    ['NLP_INFERENCE_INTERACTIVE_BATCH_LINGER_MS', 'How long an otherwise-idle INTERACTIVE-lane request waits for company. Measured against the gate budget, not the bulk pass.'],
    ['NLP_INFERENCE_INTERACTIVE_QUEUE_MAX_DEPTH', 'Bounded INTERACTIVE-lane queue depth; at the bound the gate sheds with 503 + `Retry-After`.'],
    ['NLP_INFERENCE_INTERACTIVE_QUEUE_MAX_WAIT_SECONDS', 'Wait ceiling for a queued INTERACTIVE-lane item — this IS the declared inline-gate SLO. Past it the verdict is too late to gate anything, so a 503 the caller fails closed on beats a stale 200.'],
    ['NLP_INFERENCE_DEVICE', 'Where NLP guard tensors execute: "cpu" (safe on every host), "auto" (best device present), or an explicit "mps"/"cuda", which RAISES when absent rather than silently running several times slower. Transport/topology, never model identity.'],
    ['NLP_INFERENCE_DEVICE_CPU_ONLY_MODULES', 'Comma-separated dotted submodule paths kept on CPU when the device is an accelerator. A runtime-COMPATIBILITY fact about the installed gliner2/torch build, not policy: `count_embed.gru` trips an MPSNDArray assertion that ABORTS the process rather than raising, so the relocation is mandatory wherever that build runs on MPS.'],
]);

// ─────────────────────────────────────────────────────────────────────────────
// Render model
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvVar {
    name: string;
    tier: SettingDescriptor['tier'];
    /** True ⇔ `failMode: 'closed'` — absence must fail fast. */
    required: boolean;
    secret: boolean;
    default?: unknown;
    /** Template-only local-dev value for `.env.sample` — see `SettingDescriptor.sampleValue`. */
    sampleValue?: unknown;
    category: string;
    label: string;
    description: string;
    /** The deployable that READS it — the docs table's owner column. */
    owner: string;
}

/** Which deployable owns a variable, from the prefix convention. */
const SERVICE_PREFIX: ReadonlyArray<readonly [string, string]> = [
    ['STT_', 'apps/stt'],
    ['TEXT_', 'apps/text'],
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
        sampleValue: descriptor.sampleValue,
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

/**
 * Every declared key of the TYPESCRIPT surface, deduplicated by name.
 *
 * The Python surface is deliberately NOT folded in here: these two are governed
 * by different mechanisms (a hand-authored descriptor with a `tier` and a
 * `failMode` vs. a pydantic field introspected out of a service), they have
 * different owners, and `env-sync.test.ts` holds this one to a ~149-key ceiling
 * that exists to catch UNREVIEWED growth in the PLATFORM contract. Merging ~540
 * Python names into it would silently retire that ceiling. Both surfaces meet
 * in `computeGlobalEnv()` and in the docs table, which is where they belong.
 */
export const declaredSurface: EnvVar[] = (() => {
    const byName = new Map<string, EnvVar>();
    for (const v of [...bootstrapFloor, ...platformSurface, ...adminConsoleSurface, ...toolsSurface]) {
        if (!byName.has(v.name)) byName.set(v.name, v);
    }
    return [...byName.values()];
})();

// ─────────────────────────────────────────────────────────────────────────────
// The Python surface
// ─────────────────────────────────────────────────────────────────────────────

interface PythonEnvVar extends EnvVar {
    /** Also accepted, in precedence order after `name`. */
    aliases: string[];
    /** `undefined` ⇔ the field is required and the operator must supply a value. */
    codeDefault?: string;
    /** True ⇔ the line is emitted live; false ⇔ commented out at its default. */
    active: boolean;
}

function fromPythonField(field: PythonField, service: string): PythonEnvVar {
    const localDev = pythonLocalDevValue.get(field.name);
    const codeDefault = field.default === null ? undefined : String(field.default);
    return {
        name: field.name,
        aliases: field.aliases,
        tier: field.secret ? 'vault-kv' : 'env',
        required: field.required,
        secret: field.secret,
        default: codeDefault,
        category: field.class,
        label: field.name,
        description: PYTHON_DESCRIPTION_OVERLAY.get(field.name) ?? field.description,
        owner: `apps/${service}`,
        codeDefault,
        // Three reasons to emit a LIVE line, and only three:
        //   secret — must be minted/pasted; `generate-env-file.sh` keys off
        //                   the literal `CHANGE_ME` placeholder to fill it.
        //   required — pydantic has no default, so an absent line is a boot failure.
        //   local-dev — the code default is right for production and wrong here.
        // Everything else is commented out AT its default: an env file should
        // carry the deltas from the code, not a second copy of the code that
        // then drifts from it.
        active: field.secret || field.required || localDev !== undefined,
    };
}

const pythonSurface: ReadonlyArray<{ service: string; port: number; title: string; vars: PythonEnvVar[] }> = PYTHON_SERVICES.map((service) => {
    const payload = pythonManifest.services[service];
    return {
        service,
        port: payload.port,
        title: payload.title,
        vars: payload.fields.map((f) => fromPythonField(f, service)),
    };
});

/**
 * Read, but PROCESS PLUMBING rather than configuration — excluded from
 * `turbo.json#globalEnv`.
 *
 * `globalEnv` hashes each variable's VALUE into the turbo cache key, so a name
 * whose value legitimately differs between two shells on the same machine does
 * not "declare a config input", it destroys cache hits. `PYTHONPATH` is set
 * differently by conda, by an IDE, by a worktree-scoped test run and by CI, and
 * nothing in this repo treats it as a setting — it is how the interpreter finds
 * modules.
 *
 * This list is for that failure mode ONLY. It is not a place to hide a variable
 * you would rather not declare: anything an application READS to decide what to
 * do belongs in `globalEnv`, however inconvenient.
 */
const NOT_CONFIGURATION: ReadonlySet<string> = new Set(['PYTHONPATH']);

/** Every name any Python code can read — canonical, alias, or non-pydantic. */
const pythonAllNames: ReadonlySet<string> = new Set([
    ...pythonSurface.flatMap((s) => s.vars.flatMap((v) => [v.name, ...v.aliases])),
    ...Object.keys(pythonManifest.bareReads),
]);

const pythonFieldCount = pythonSurface.reduce((total, s) => total + s.vars.length, 0);

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
        '# Committed example files carry PLACEHOLDERS ONLY, never secrets.',
        '# ============================================================================',
    ].join('\n');

/**
 * The value written for a variable: never a real secret.
 *   secret → `CHANGE_ME` (wins even over `sampleValue` —
 *                                belt-and-suspenders alongside the registry's
 *                                own assembly-time throw, see `settings-registry.ts`)
 *   sampleValue declared → that value (template-only —
 *                                never fed back into a runtime fallback, unlike `default`)
 *   required, no code default → `CHANGE_ME` (the operator MUST supply one)
 *   otherwise → the declared default, or empty for "unset by default"
 *
 * Deliberately NOT `<CHANGE_ME>` (angle brackets): every env file this produces
 * is `source`d as shell by scripts/vault-seed-secrets.sh and generate-prod-secrets.sh
 * (their own headers call this out — "sourced, not parsed"), and `<`/`>` are shell
 * redirection operators. An unquoted `KEY=<CHANGE_ME>` is a syntax error there, not
 * a placeholder — found via scripts/dev-setup.sh's finalize step actually sourcing
 * a generated .env.dev.
 */
function exampleValue(v: EnvVar): string {
    if (v.secret) return 'CHANGE_ME';
    if (v.sampleValue !== undefined) return String(v.sampleValue);
    if (v.default !== undefined) return String(v.default);
    return v.required ? 'CHANGE_ME' : '';
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
        '# AUTHENTICATE to Vault. Everything else lives in the database or',
        '# in Vault, or in the deployable-specific example file next to it.',
        '#',
        '# `.env.dev` is gitignored and CI/production load no file at all — host env',
        '# only. Locally, `pnpm setup:dev` creates `.env.dev` for you (only if it',
        '# does not already exist) from the consolidated `.env.sample` at the repo',
        '# root, the TypeScript gateway AND all',
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
        '# The floor itself (DATABASE_URL, REDIS_*, VAULT_*, …) is the first section',
        '# of the consolidated `.env.sample` at the repo root; this file carries',
        '# everything else the platform declares.',
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

/**
 * One Python service's `.env.sample`, grouped by the settings class that owns
 * each field — the same grouping the source has, so a reader can go straight
 * from a line here to the declaration that produced it.
 */
function renderPythonExample(service: (typeof pythonSurface)[number]): string {
    const out: string[] = [
        BANNER(`apps/${service.service}'s pydantic-settings classes, via ${PYTHON_MANIFEST_PATH}\n# (regenerate the manifest with \`pnpm env:python-surface\`, then \`pnpm env:sync\`)`),
        '#',
        `# ${service.title} — apps/${service.service}, port ${service.port}.`,
        '#',
        '# A line is LIVE only when it must be set: a secret, a field pydantic has no',
        '# default for, or one of the few local-dev values that legitimately differ',
        '# from the code default (PYTHON_LOCAL_DEV_VALUES in scripts/env-sync.mts).',
        '# Every other knob is listed COMMENTED OUT at its code default — the default',
        '# lives in the Python source, and an env file that restates it only creates',
        '# something to drift. Uncomment a line to override it.',
        '#',
        '# `# also:` lists the other names pydantic accepts for the same field, in',
        '# precedence order after the canonical one.',
    ];

    for (const [category, group] of byCategory(service.vars as EnvVar[])) {
        out.push('', `# ── ${category} ${'─'.repeat(Math.max(0, 68 - category.length))}`);
        for (const v of group as PythonEnvVar[]) {
            out.push('');
            // The name is already on the declaration line below; repeating it as
            // a heading is noise on the ~250 fields that carry no prose at all.
            if (v.required) out.push(`# ${v.label} (REQUIRED — no code default)`);
            if (v.description) out.push(...wrap(v.description, 116, '#   '));
            if (v.aliases.length > 0) out.push(`#   also: ${v.aliases.join(', ')}`);
            const localDev = pythonLocalDevValue.get(v.name);
            if (localDev !== undefined && v.codeDefault !== undefined) {
                out.push(`#   local-dev value; the code default is \`${v.codeDefault}\``);
            }
            if (v.active) {
                out.push(`${v.name}=${v.secret ? 'CHANGE_ME' : (localDev ?? v.codeDefault ?? 'CHANGE_ME')}`);
            } else {
                out.push(`# ${v.name}=${v.codeDefault ?? ''}`);
            }
        }
    }
    out.push('');
    return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// `.env.sample` — the consolidated root artifact
// ─────────────────────────────────────────────────────────────────────────────

/** One key=value declaration line, keyed by name for de-duplication. */
const SAMPLE_KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/**
 * The six Python service sections of the consolidated file, GENERATED from the
 * manifest. They used to be read VERBATIM off disk as
 * hand-maintained files, which is exactly what let them drift ~2x away from the
 * real surface and carry 15 keys with no reader at all — see "THE PYTHON HALF"
 * in the header. Their content now comes from `renderPythonExample()`, the same
 * function that writes the per-service file, so the two can never disagree.
 */
const PYTHON_SAMPLE_SECTIONS: ReadonlyArray<{ path: string; title: string; note: string }> = pythonSurface.map((s) => ({
    path: `apps/${s.service}/.env.sample`,
    title: `${s.service.toUpperCase()} — ${s.title} (apps/${s.service}, :${s.port})`,
    note: `Generated by pnpm env:sync from ${PYTHON_MANIFEST_PATH}.`,
}));

const CONSOLIDATED_HEADER = [
    '# ============================================================================',
    '# HOPE Platform — Consolidated Local Dev/Test Sample (.env.sample)',
    '# ============================================================================',
    '# GENERATED FILE — DO NOT EDIT BY HAND. Produced by `pnpm env:sync`',
    '# `pnpm env:sync --check` fails the build (CI job `env-drift-check`) when this',
    '# file disagrees with its sources: the settings registry (bootstrap floor +',
    "# apps/api + apps/admin-console + packages/tools) and the 6 Python services'",
    '# own `.env.sample` files (read verbatim — see the generator header comment',
    '# for what "not schema-validated" means for those 6).',
    '#',
    '# This file is the SOURCE for local dev/test env files. It is never loaded',
    '# directly by any application:',
    '#   pnpm setup:dev   -> scripts/generate-env-file.sh copies this to .env.dev',
    '#                        (only if .env.dev doesn\'t already exist)',
    '#   pnpm setup:test  -> same, to .env.test, then applies test-specific',
    '#                        overrides (ports, isolated infra endpoints, fake',
    '#                        secrets) — see scripts/generate-env-file.sh',
    '# Both .env.dev and .env.test are gitignored; neither is ever committed.',
    '#',
    '# DE-DUPLICATION NOTE: several services historically used bare, unprefixed',
    '# key names (PORT, HOST, LOG_LEVEL, OTEL_SERVICE_NAME, ...) that collide',
    '# across services when concatenated into one file. Where a later section',
    '# would re-declare a key already set earlier, that later line is commented',
    '# out with a `# [duplicate key, see ... above]` note instead of being',
    '# emitted live — a flat env file can only have ONE active value per key',
    '# name, and emitting two active lines for one key is exactly the',
    '# "duplicate keys / silent last-wins" defect already found and',
    '# fixed once (that service\'s OWN process still gets its correct value when',
    '# launched via its `pnpm <svc>:dev` script, which injects PORT/HOST via',
    '# scripts/dev-service.sh BEFORE the file is read — see',
    '# docs/architecture/environment-configuration-reference.md).',
    '#',
    '# Full variable reference, provider/model default & fallback semantics:',
    '#   docs/architecture/environment-configuration-reference.md',
    '# ============================================================================',
    '',
].join('\n');

/** Append one section's content to `out`, commenting out any key already in `seen`. */
function appendDeduped(out: string[], seen: Map<string, string>, title: string, sourcePath: string, note: string, content: string): void {
    out.push('# ' + '='.repeat(76), `# ${title}`, `# Source: ${sourcePath}`, `# ${note}`, '# ' + '='.repeat(76), '');
    for (const line of content.split('\n')) {
        const match = SAMPLE_KEY_RE.exec(line);
        if (!match) {
            out.push(line);
            continue;
        }
        const key = match[1];
        const prevTitle = seen.get(key);
        if (prevTitle) {
            out.push(`# [duplicate key, see ${prevTitle} above] # ${line}`);
        } else {
            seen.set(key, title);
            out.push(line);
        }
    }
    out.push('');
}

function renderConsolidatedSample(apiContent: string, adminConsoleContent: string, toolsContent: string, pythonContent: ReadonlyMap<string, string>): string {
    const out: string[] = [CONSOLIDATED_HEADER];
    const seen = new Map<string, string>();

    appendDeduped(out, seen, 'ROOT BOOTSTRAP FLOOR', '(generated — bootstrap floor)', 'Required to reach the DB / authenticate to Vault.', renderRootExample());
    appendDeduped(out, seen, 'API GATEWAY (apps/api)', 'apps/api/.env.sample', 'The platform contract beyond the bootstrap floor: service URLs, secrets, OTel, storage, rate limiting.', apiContent);
    appendDeduped(out, seen, 'ADMIN CONSOLE (apps/admin-console)', 'apps/admin-console/.env.sample', 'Generated by pnpm env:sync.', adminConsoleContent);
    appendDeduped(out, seen, 'CODE GENERATORS (packages/tools)', 'packages/tools/.env.sample', 'Generated by pnpm env:sync.', toolsContent);
    for (const section of PYTHON_SAMPLE_SECTIONS) {
        // From the SAME render call that wrote the per-service file — never
        // re-read off disk, so the section and the file cannot disagree.
        appendDeduped(out, seen, section.title, section.path, section.note, pythonContent.get(section.path) as string);
    }

    return out.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// turbo.json#globalEnv
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Source trees whose `process.env.X` occurrences are DOCUMENTATION, not reads.
 *
 * `scanTypeScriptReads()` already excludes `docs/` on exactly this principle:
 * prose ABOUT a variable is not a program that READS one. A rendered
 * documentation portal is the same thing wearing a different hat — its "prose"
 * ships as `.tsx` template-literal constants holding copy-pasteable snippets —
 * but it lives under `apps/`, where the `docs/` prefix cannot reach it.
 *
 * The names in those snippets belong to the API CONSUMER's own service
 * (`HOPE_API_KEY`, `HOPE_SA_CLIENT_ID`, …); they are set in the reader's
 * deployment and nothing in this repo ever reads them. Declaring them would
 * poison the turbo cache key with names no build input depends on, and would
 * document another company's configuration as part of HOPE's platform env
 * surface in `env-surface.generated.md`.
 *
 * ## What is skipped, precisely: template literals — NOT whole files
 *
 * In these trees the snippets live in backtick constants, so only
 * TEMPLATE-LITERAL contents are blanked before matching. A `process.env.X`
 * written as ordinary code — a real member expression outside a snippet — is
 * still detected and still lands in `globalEnv`.
 *
 * That distinction is the safety net, and it has to be here: `eslint-config-turbo`
 * (whose `turbo/no-undeclared-env-vars` rule is the usual backstop for an
 * undeclared read) is spread into `flat/core.js` but NOT into `flat/next.js`,
 * which `apps/admin-console` uses and which is deliberately self-contained.
 * Verified by `eslint --print-config` on a console file: zero `turbo/*` rules
 * resolve there. So for a Next.js app there is no second line of defence — a
 * whole-file exclusion here would mean a genuine read could silently never
 * reach the turbo cache key.
 *
 * ADDING A SNIPPET to one of these trees: write `process.env.WHATEVER`
 * normally, inside the backtick constant. The snippet should read exactly like
 * the code you want a developer to copy — do NOT contort it to dodge this
 * scanner.
 *
 * ADDING A TREE to this list: only for a surface whose entire job is rendering
 * documentation, and state which one. It is not an escape hatch for a real read
 * you would rather not declare — write that read outside a template literal, as
 * you naturally would, and it is picked up regardless.
 */
export const DOCUMENTATION_SURFACES = [
    // The admin console's developer portal: @arcaai/vox-node SDK and REST
    // samples showing a consumer how to configure THEIR service.
    'apps/admin-console/src/features/developer-docs/',
];

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
 * a phantom variable. In rendered-documentation trees the template-literal
 * SNIPPETS are blanked for the same reason — see `DOCUMENTATION_SURFACES`.
 */
/**
 * The per-file half of {@link scanTypeScriptReads()}, exported so the
 * snippet-vs-real-read distinction can be tested directly on a string instead
 * of by planting a probe file in the repo.
 */
export function scanSourceForTests(raw: string, file: string): Set<string> {
    const READ = /process\.env(?:\.([A-Z][A-Z0-9_]{1,})|\[\s*['"`]([A-Z][A-Z0-9_]{1,})['"`]\s*\])\s*(=[^=]|$|[^=])/g;
    let source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    // In a documentation surface the backtick constants are RENDERED SNIPPETS —
    // prose about someone else's configuration. Blank their contents so the
    // names inside them do not register, while leaving real code untouched.
    if (DOCUMENTATION_SURFACES.some((dir) => file.startsWith(dir))) {
        source = source.replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``');
    }

    const found = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = READ.exec(source)) !== null) {
        // `process.env.X =` is a WRITE — not an input to the cache key.
        if (/^=[^=]/.test(match[3] ?? '')) continue;
        found.add((match[1] ?? match[2]) as string);
    }

    // …and the same reads written through a helper (see `TS_ENV_HELPERS`).
    const HELPER = new RegExp(`\\b(?:${TS_ENV_HELPERS.join('|')})\\(\\s*(['"\`])([A-Z][A-Z0-9_]{1,})\\1`, 'g');
    while ((match = HELPER.exec(source)) !== null) found.add(match[2] as string);

    return found;
}

/**
 * TypeScript env reads that go through a HELPER instead of `process.env.X`.
 *
 * `getEnvBoolean('OTEL_LOGS_ENABLED', false)` is as much a read as
 * `process.env.OTEL_LOGS_ENABLED`, but the name never appears next to
 * `process.env`, so `scanTypeScriptReads()`'s regex could not see it and
 * `turbo.json#globalEnv` did not declare it. Found while adding the Python
 * scanner, which had the identical blind spot: `apps/api/.env.prod` declares
 * `OTEL_LOGS_ENABLED` and `OTEL_LOG_BRIDGE`, both genuinely read by
 * `packages/applications/src/services/baseServices/logging/logging.service.ts`,
 * and the reader check reported them as orphans.
 *
 * The helpers are named rather than discovered because there are exactly four
 * of them and they live in one file
 * (`.../baseServices/logging/env.utils.ts`); each takes the variable NAME as
 * its first argument. Adding a fifth means adding it here — or, better,
 * reading `process.env` directly at the call site, which needs no list.
 */
const TS_ENV_HELPERS = ['getEnvString', 'getEnvBoolean', 'getEnvNumber'] as const;

export function scanTypeScriptReads(): Set<string> {
    const listed = execSync('git ls-files "*.ts" "*.tsx" "*.mts" "*.cts" "*.mjs" "*.js"', { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .filter((f) => !f.includes('node_modules') && !f.startsWith('docs/'));

    const isTestFile = (f: string) => /(^|\/)(__tests__|__mocks__|tests|test)\//.test(f) || /\.(test|spec|e2e-spec)\.[cm]?[jt]sx?$/.test(f);

    const READ = /process\.env(?:\.([A-Z][A-Z0-9_]{1,})|\[\s*['"`]([A-Z][A-Z0-9_]{1,})['"`]\s*\])\s*(=[^=]|$|[^=])/g;
    const found = new Set<string>();
    for (const file of listed) {
        if (isTestFile(file)) continue;
        for (const name of scanSourceForTests(readFileSync(join(ROOT, file), 'utf8'), file)) {
            found.add(name);
        }
    }
    return found;
}

/**
 * Direct `os.environ` reads in Python source — the second opinion.
 *
 * `scripts/python-env-surface.py` already AST-scans these, and more precisely
 * (it resolves module constants and one-line helper indirection, which no regex
 * can). This exists anyway because the manifest is a COMMITTED FILE: a developer
 * who adds `os.getenv("NEW_THING")` and forgets `pnpm env:python-surface` would
 * otherwise sail past `env-drift-check`, which is the exact class of invisibility
 * exists to end. A regex over `*.py` needs no Python
 * interpreter, so it runs in the same CI job as the rest of this generator and
 * fails the build on the spot.
 *
 * Test files are excluded on the same principle as `scanTypeScriptReads()`: a
 * test's environment is a fixture, not a configuration input.
 */
export function scanPythonReads(): Set<string> {
    const listed = execSync('git ls-files "*.py"', { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .filter((f) => !f.includes('node_modules') && !f.startsWith('docs/'));

    const isTestFile = (f: string) => /(^|\/)(tests?|__tests__|__mocks__)\//.test(f) || /(^|\/)(test_[^/]+|[^/]+_test|conftest)\.py$/.test(f);

    // `os.getenv("X")`, `os.environ.get("X")`, `os.environ["X"]`. A WRITE
    // (`os.environ["X"] = …`) is not a config input, so `=` right after the
    // bracket disqualifies the match — same rule the TypeScript scanner applies.
    const READ = /os\.(?:getenv\(\s*|environ\.get\(\s*|environ\[\s*)(['"])([A-Z][A-Z0-9_]{2,})\1\s*(\]\s*=[^=]|.?)/g;

    const found = new Set<string>();
    for (const file of listed) {
        if (isTestFile(file)) continue;
        const source = readFileSync(join(ROOT, file), 'utf8')
            // Strip `#` comments and both docstring forms: prose ABOUT a variable
            // is not a program that reads one (`nlp/core/config.py` discusses
            // `os.getenv` at length in exactly this way).
            .replace(/"""[\s\S]*?"""/g, '""')
            .replace(/'''[\s\S]*?'''/g, "''")
            .replace(/(^|[^'"])#[^\n]*/g, '$1');
        let match: RegExpExecArray | null;
        while ((match = READ.exec(source)) !== null) {
            if (/^\]\s*=[^=]/.test(match[3] ?? '')) continue;
            found.add(match[2]);
        }
    }
    return found;
}

/**
 * `turbo.json#globalEnv` — every name any code in this repo reads, in any
 * language. Cache correctness does not care which runtime performs the read.
 */
function computeGlobalEnv(): string[] {
    const names = new Set<string>(declaredSurface.map((v) => v.name));
    for (const name of scanTypeScriptReads()) names.add(name);
    for (const name of pythonAllNames) names.add(name);
    for (const name of scanPythonReads()) names.add(name);
    for (const name of NOT_CONFIGURATION) names.delete(name);
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
        '# The declared environment surface',
        '',
        'Generated from the settings registry plus each TypeScript deployable’s own',
        'schema, AND the six Python services’',
        'pydantic-settings declarations via `scripts/generated/python-env-surface.json`.',
        '`pnpm env:sync --check` (CI job `env-drift-check`) fails when this file,',
        'the `.env.sample` files (root consolidated / per-app), or `turbo.json#globalEnv`',
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
        `| Python declared fields | ${pythonFieldCount} |`,
        `| … distinct Python names (incl. aliases + \`os.environ\` reads) | ${pythonAllNames.size} |`,
        `| \`turbo.json#globalEnv\` entries | ${globalEnv.length} |`,
        '',
        '## Variables — the TypeScript platform surface',
        '',
        '| Variable | Tier | Required | Default | Read by | Purpose |',
        '|---|---|---|---|---|---|',
    ];
    const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    for (const v of rows) {
        const dflt = v.secret ? '`CHANGE_ME`' : v.default === undefined ? '—' : `\`${String(v.default)}\``;
        lines.push(`| \`${v.name}\` | \`${v.tier}\` | ${v.required ? 'yes' : 'no'} | ${dflt} | \`${v.owner}\` | ${cell(v.description || v.label)} |`);
    }

    lines.push(
        '',
        '## Variables — the Python services',
        '',
        'Introspected from each service’s pydantic-settings classes. **In file** says',
        'whether the generated `.env.sample` emits the line LIVE (a secret, a field with',
        'no code default, or a declared local-dev override) or commented out at its code',
        'default — see `renderPythonExample()` in `scripts/env-sync.mts`.',
        '',
        '| Variable | Service | Required | Secret | Default | In file | Also accepted |',
        '|---|---|---|---|---|---|---|',
    );
    const pythonRows = pythonSurface.flatMap((s) => s.vars.map((v) => [s.service, v] as const)).sort((a, b) => a[1].name.localeCompare(b[1].name));
    for (const [service, v] of pythonRows) {
        const dflt = v.secret ? '`CHANGE_ME`' : v.codeDefault === undefined ? '—' : `\`${v.codeDefault}\``;
        const also = v.aliases.length > 0 ? v.aliases.map((a) => `\`${a}\``).join(', ') : '—';
        lines.push(`| \`${v.name}\` | \`apps/${service}\` | ${v.required ? 'yes' : 'no'} | ${v.secret ? 'yes' : 'no'} | ${dflt} | ${v.active ? 'live' : 'commented'} | ${also} |`);
    }

    const bare = Object.entries(pythonManifest.bareReads);
    lines.push(
        '',
        '## Python reads OUTSIDE pydantic-settings',
        '',
        'Direct `os.environ` / `os.getenv` reads, including those through a one-line',
        'helper. They are declared in `turbo.json#globalEnv` but belong to no settings',
        'class, so no service validates them at startup — each one is a candidate for',
        'promotion into its service’s `BaseSettings`.',
        '',
        '| Variable | Read by |',
        '|---|---|',
    );
    for (const [name, files] of bare) {
        lines.push(`| \`${name}\` | ${files.map((f) => `\`${f}\``).join(', ')} |`);
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
    const apiContent = renderApiExample();
    const adminConsoleContent = renderAdminConsoleExample();
    const toolsContent = renderToolsExample();
    const pythonContent = new Map(pythonSurface.map((s) => [`apps/${s.service}/.env.sample`, renderPythonExample(s)]));
    return [
        { path: 'apps/api/.env.sample', content: apiContent },
        { path: 'apps/admin-console/.env.sample', content: adminConsoleContent },
        { path: 'packages/tools/.env.sample', content: toolsContent },
        ...[...pythonContent].map(([path, content]) => ({ path, content })),
        { path: '.env.sample', content: renderConsolidatedSample(apiContent, adminConsoleContent, toolsContent, pythonContent) },
        { path: 'turbo.json', content: renderTurboJson(globalEnv) },
        { path: 'env-surface.generated.md', content: renderDocsTable(globalEnv) },
    ];
}

/**
 * The bootstrap-floor content, exported so tests can assert its properties
 * (exact key set, ≤60 lines, no key beyond the floor) directly — it is no
 * longer a standalone file, so this is the only way to reach it.
 */
export function getBootstrapFloorContent(): string {
    return renderRootExample();
}

/**
 * Every key an operator-facing file DECLARES that nothing reads.
 *
 * The generated artifacts cannot drift — they are regenerated. The files below
 * are hand-maintained on purpose and therefore can, and did: the per-app
 * `.env.prod` templates are the ops reference for `docker --env-file` /
 * systemd `EnvironmentFile=` (production loads no env file itself), so a key
 * that lost its reader just sits there promising a knob that does nothing. That
 * is finding F-03 — `apps/guardrail/.env.prod` documented an engine plane that
 * had already been deleted — and deleting one file fixed one instance while
 * leaving the class open.
 *
 * Checking is better than deleting here, because unlike guardrail's the
 * surviving templates document a plane that really exists. This makes them
 * falsifiable: add a key with no reader and `env:sync --check` says so.
 */
const READER_CHECKED_FILES: readonly string[] = PYTHON_SERVICES.map((s) => `apps/${s}/.env.prod`).concat('apps/api/.env.prod');

/**
 * Names expanded by SHELL or interpolated by compose — `${VAULT_DB_NAME:-hope}`,
 * `"$GRAFANA_PORT"`.
 *
 * These belong to the reader check but NOT to `turbo.json#globalEnv`: turbo
 * hashes the value into a cache key for TASK BUILDS, and a variable only an
 * operator script expands is not a build input. `VAULT_ROLE_ID_FILE` and
 * `VAULT_WRAPPED_SECRET_ID_FILE` are the motivating case — read by
 * `infrastructure/single-deployment/vault/bootstrap/configure-app-auth.sh`,
 * declared in `apps/api/.env.prod`, invisible to both language scanners.
 *
 * Deliberately generous: a name MENTIONED in a shell/compose file counts. The
 * purpose is to avoid false accusations in a gate that blocks CI, and a missed
 * orphan costs a stale comment line while a false one costs a red pipeline.
 */
function scanShellReads(): Set<string> {
    const listed = execSync('git ls-files "*.sh" "*.yml" "*.yaml" "*.hcl" "Dockerfile*" "*/Dockerfile*"', { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .filter((f) => !f.includes('node_modules') && !f.startsWith('docs/'));

    const found = new Set<string>();
    for (const file of listed) {
        for (const m of readFileSync(join(ROOT, file), 'utf8').matchAll(/[A-Z][A-Z0-9_]{2,}/g)) {
            found.add(m[0]);
        }
    }
    return found;
}

function reportUnreadKeys(globalEnv: string[]): string[] {
    const readable = new Set([...globalEnv, ...scanShellReads()]);
    const problems: string[] = [];
    for (const rel of READER_CHECKED_FILES) {
        let content: string;
        try {
            content = readFileSync(join(ROOT, rel), 'utf8');
        } catch {
            continue; // Deleted on purpose (guardrail's, F-03). Absence is fine.
        }
        const orphans = content
            .split('\n')
            .map((line, i) => [SAMPLE_KEY_RE.exec(line)?.[1], i + 1] as const)
            .filter((entry): entry is readonly [string, number] => Boolean(entry[0]) && !readable.has(entry[0] as string));
        if (orphans.length > 0) {
            problems.push(`✗ ${rel} declares ${orphans.length} key(s) no code reads:\n${orphans.map(([name, line]) => `      ${rel}:${line}  ${name}`).join('\n')}`);
        }
    }
    return problems;
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
    const floorLines = getBootstrapFloorContent().split('\n').length;
    const globalEnv = computeGlobalEnv();
    const unread = reportUnreadKeys(globalEnv);
    const surfaces = `${keyCount} TS keys + ${pythonFieldCount} Python fields · ${globalEnv.length} globalEnv entries`;

    if (check) {
        if (drifted.length > 0 || unread.length > 0) {
            if (drifted.length > 0) {
                console.error('env:sync --check FAILED — generated artifacts are out of date.\n');
                console.error(drifted.join('\n\n'));
                console.error('\nRun `pnpm env:sync` and commit the result.');
                console.error('(If a PYTHON declaration changed, run `pnpm env:python-surface` first.)');
            }
            if (unread.length > 0) {
                console.error('\nenv:sync --check FAILED — an operator-facing file declares a key nothing reads.\n');
                console.error(unread.join('\n\n'));
                console.error('\nEither delete the line, or point it at the name the code actually reads.');
            }
            process.exit(1);
        }
        console.log(`env:sync --check OK — ${artifacts.length} artifacts match their declarations (${surfaces}); no unread keys in ${READER_CHECKED_FILES.length} operator-facing files.`);
        return;
    }

    for (const problem of unread) console.warn(`\n${problem}`);
    console.log(`\nDeclared surface: ${surfaces} · bootstrap floor ${floorLines} lines · targets ≤ ~120 keys and ≤ ~60 lines.`);
}

// `import`ed by the unit tests; executed by `pnpm env:sync`.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    main();
}
