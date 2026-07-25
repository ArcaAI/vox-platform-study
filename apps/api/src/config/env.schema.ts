// Fail-fast environment validation for the API gateway — TASK-558 lane D
// (plan §9.2 L2: "validate before the framework boots; fail fast with the FULL
// list of problems, not the first one").
//
// SOURCE OF TRUTH: the schema is BUILT from setting descriptors, never from a
// hand-written key literal. `BOOTSTRAP_ENV_SETTINGS` (lane F) supplies the
// bootstrap floor, `PLATFORM_KNOB_SETTINGS` / `FEATURE_FLAG_SETTINGS` the
// operational knobs and gates still read from env, and
// `API_PLATFORM_ENV_SETTINGS` the gateway topology. Env-var NAMES come from
// `toEnvVarName()` — the mechanical dotted-key ↔ SCREAMING_SNAKE mapping of plan
// §3.3 — so a rename in the registry can never silently diverge from what this
// file validates. `scripts/env-sync.mts` generates `.env.example` and
// `turbo.json#globalEnv` from the SAME list.
//
// WHY THE SCHEMA COVERS FLAGS THIS PROCESS DOES NOT READ (e.g.
// `HARNESS_NER_PRIORS_ENABLED`): since lane C, every TS and Python deployable
// reads the SAME `.env.<NODE_ENV>` file. One shared file ⇒ one shared contract,
// so validating the whole platform surface at gateway boot turns a typo in a
// downstream service's flag into a loud boot failure instead of a flag that
// silently never takes effect.
//
// MAPPING FROM `failMode` TO THE SHAPE (the boot contract, plan §4 B4):
//   `closed`          → REQUIRED; absence is a hard boot error.
//   `open-to-default` → optional, defaulted from `descriptor.default`.
//
// ONE DOCUMENTED EXCEPTION. Lane F's registry forces `failMode: 'closed'` on
// every `sensitivity: 'secret'` descriptor (a secret must never fall back to a
// default). Three bootstrap-floor entries are secrets for that reason but are
// NOT unconditionally required by this process:
//   * VAULT_SECRET_ID / VAULT_WRAPPED_SECRET_ID — alternatives, and only needed
//     when SECRETS_PROVIDER=vault. Requiring both at once is unsatisfiable.
//   * VAULT_DB_ADMIN_PASS — consumed at Vault PROVISIONING time by
//     `infrastructure/docker/configs/vault/dev-init.sh`,
//     `scripts/setup-dev-vault-db.sh` and docker-compose. Zero TS readers, so it
//     is not part of this deployable's contract at all.
// Handled by `VAULT_CONDITIONAL` / `NOT_READ_BY_THIS_PROCESS` below rather than
// by weakening the descriptors, which are correct as classifications.

import { BOOTSTRAP_ENV_SETTINGS, FEATURE_FLAG_SETTINGS, PLATFORM_KNOB_SETTINGS, toEnvVarName, type SettingDescriptor } from '@arcaai/applications';
import { z } from 'zod';
import { API_PLATFORM_ENV_SETTINGS } from './env.descriptors';

/**
 * Consumed only by Vault provisioning tooling — never by this process.
 * Exported so `scripts/env-sync.mts` annotates it the same way in the generated
 * example files instead of re-stating the exception.
 */
export const NOT_READ_BY_THIS_PROCESS = new Set(['VAULT_DB_ADMIN_PASS']);

/**
 * Secrets whose `closed` failMode is the registry's secret invariant rather than
 * a boot requirement: needed only under `SECRETS_PROVIDER=vault`, and the two
 * secret_id forms are alternatives (see the header). Exported for the same
 * reason as `NOT_READ_BY_THIS_PROCESS`.
 */
export const VAULT_CONDITIONAL = new Set(['VAULT_SECRET_ID', 'VAULT_WRAPPED_SECRET_ID']);

/** Names whose value must parse as a TCP port. */
const PORT_NAME = /(^|_)PORT$/;

/** Names whose value must parse as an absolute http(s) URL. */
const URL_NAME = /(^|_)URL$/;

/**
 * `*_URL` names that are DATABASE/CACHE connection strings, not HTTP endpoints:
 * `postgres://`, `postgresql://`, `redis://`, `rediss://`. They are validated as
 * "an absolute URI with a scheme", never as http(s).
 */
const CONNECTION_STRING_NAME = new Set(['DATABASE_URL', 'DIRECT_URL', 'REDIS_URL']);

/**
 * The gateway's declared env surface. Order is stable (floor → knobs → gates →
 * topology) because `env-sync` renders `.env.example` in exactly this order.
 */
export const API_ENV_DESCRIPTORS: SettingDescriptor[] = [
  ...BOOTSTRAP_ENV_SETTINGS,
  ...PLATFORM_KNOB_SETTINGS,
  ...FEATURE_FLAG_SETTINGS,
  ...API_PLATFORM_ENV_SETTINGS,
].filter((d) => !NOT_READ_BY_THIS_PROCESS.has(toEnvVarName(d.key)));

/** The validator for one variable, derived from its declared `dataType`. */
function leafSchema(name: string, descriptor: SettingDescriptor): z.ZodType {
  // The base carries the ABSENCE message: when a `failMode: 'closed'` variable
  // is missing entirely, zod reports this leaf's error, and "X is required" is
  // what an operator needs to read at 3am — not "expected string, received
  // undefined".
  const required = z.string({ error: `${name} is required and has no default` });
  if (descriptor.dataType === 'boolean') {
    return required.refine((v) => v === 'true' || v === 'false', { error: `${name} must be "true" or "false"` });
  }
  if (descriptor.dataType === 'number') {
    return required.refine(
      (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed)) return false;
        if (PORT_NAME.test(name)) return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535;
        return true;
      },
      { error: PORT_NAME.test(name) ? `${name} must be a TCP port between 1 and 65535` : `${name} must be a number` },
    );
  }
  if (CONNECTION_STRING_NAME.has(name)) {
    return required.refine((v) => URL.canParse(v), { error: `${name} must be an absolute connection URI (e.g. postgres://user:pass@host:5432/db)` });
  }
  if (URL_NAME.test(name)) {
    return required.refine(
      (v) => {
        try {
          return /^https?:$/.test(new URL(v).protocol);
        } catch {
          return false;
        }
      },
      { error: `${name} must be an absolute http(s) URL` },
    );
  }
  return required;
}

/** Object schema over the declared surface: required leaves, optional rest. */
function buildSchema(descriptors: SettingDescriptor[]): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};
  for (const descriptor of descriptors) {
    const name = toEnvVarName(descriptor.key);
    const leaf = leafSchema(name, descriptor);
    const required = descriptor.failMode === 'closed' && !VAULT_CONDITIONAL.has(name);
    shape[name] = required ? leaf : leaf.optional();
  }
  return z.object(shape);
}

const apiEnvSchema = buildSchema(API_ENV_DESCRIPTORS);

/** Coerce a validated string back to the type its descriptor declares. */
function coerce(descriptor: SettingDescriptor, value: string): string | number | boolean {
  if (descriptor.dataType === 'boolean') return value === 'true';
  if (descriptor.dataType === 'number') return Number(value);
  return value;
}

export type ApiEnv = Record<string, string | number | boolean | undefined>;

/**
 * Validate a raw environment against the declared surface.
 *
 * Throws ONE error listing EVERY problem (plan §9.2 L2) — a boot missing three
 * variables must say so once, not across three restarts.
 *
 * An empty string is treated as ABSENT: a `KEY=` line in an env file expresses
 * "not configured" and must not defeat the descriptor's default. Declared
 * defaults are fed through the SAME leaf validator as supplied values, so a
 * descriptor whose `default` contradicts its `dataType` fails these unit tests
 * rather than shipping.
 */
export function parseApiEnv(raw: Record<string, string | undefined>): ApiEnv {
  const candidate: Record<string, string> = {};
  for (const descriptor of API_ENV_DESCRIPTORS) {
    const name = toEnvVarName(descriptor.key);
    const supplied = raw[name];
    if (supplied !== undefined && supplied !== '') {
      candidate[name] = supplied;
    } else if (descriptor.default !== undefined) {
      candidate[name] = String(descriptor.default);
    }
  }

  const problems: string[] = [];
  const result = apiEnvSchema.safeParse(candidate);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const name = issue.path.join('.') || 'env';
      problems.push(issue.message.includes(name) ? issue.message : `${name}: ${issue.message}`);
    }
  }

  // Cross-field rule: the Vault AppRole pair is required only when Vault is
  // actually the secrets backend (see VAULT_CONDITIONAL above).
  const secretsProvider = (candidate.SECRETS_PROVIDER ?? 'env').toLowerCase().trim();
  if (secretsProvider === 'vault') {
    if (!candidate.VAULT_ROLE_ID) problems.push('VAULT_ROLE_ID is required when SECRETS_PROVIDER=vault');
    if (!candidate.VAULT_SECRET_ID && !candidate.VAULT_WRAPPED_SECRET_ID) {
      problems.push(
        'one of VAULT_SECRET_ID (dev, raw) or VAULT_WRAPPED_SECRET_ID (production, response-wrapped) is required when SECRETS_PROVIDER=vault',
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid API gateway environment — ${problems.length} problem(s):\n` +
        problems.map((p) => `  • ${p}`).join('\n') +
        '\nDeclared surface: .env.example (bootstrap floor) + apps/api/.env.example. Regenerate with `pnpm env:sync`.',
    );
  }

  const env: ApiEnv = {};
  for (const descriptor of API_ENV_DESCRIPTORS) {
    const name = toEnvVarName(descriptor.key);
    const value = candidate[name];
    env[name] = value === undefined ? undefined : coerce(descriptor, value);
  }
  return env;
}

let cached: ApiEnv | null = null;

/**
 * Lazily validated accessor. Called once from `apps/api/src/main.ts` immediately
 * after `loadEnv()` and BEFORE `NestFactory.create()`, so a missing env-tier
 * variable fails the boot rather than surfacing as an `undefined` at first use
 * (plan §9.2 L2/L3 — validate once, read the typed object thereafter).
 */
export function apiEnv(): ApiEnv {
  cached ??= parseApiEnv(process.env);
  return cached;
}

/** Test seam: drop the memoized parse. */
export function resetApiEnvCache(): void {
  cached = null;
}
