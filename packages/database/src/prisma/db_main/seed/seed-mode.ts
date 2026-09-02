/**
 * Seed-mode gating
 *
 * Seeding is OPT-IN and FAILS CLOSED.
 *
 * Why this module exists: `migrate.sh` used to run the seed unconditionally in
 * every environment — the `NODE_ENV` if/else chose only the migration
 * mechanism, and the seed invocation sat outside it. The migration mechanism
 * was env-aware; the seed was not. In a deployed environment that meant
 * `seedAuditLog` upserting fabricated rows into the HIPAA audit trail (with a
 * real `update:` payload, so every run overwrote them) and `seedConsultation`
 * writing synthetic PHI.
 *
 * The compounding defect: `deployment/k8s/base/db-migrate.yaml` gives the Job
 * only `DATABASE_URL` — no `envFrom`, so `NODE_ENV` is absent inside the
 * container. `getNodeEnv()` falls back to `'development'`, which also made
 * `shouldSeedApiKeys()` return true and seed demo API keys carrying raw
 * secrets. That guard was correct and unreachable.
 *
 * Hence the rule below: **permission is never inferred from an absent
 * variable.** `RUN_SEED=all` requires `NODE_ENV` to be explicitly development
 * or test. An unset `NODE_ENV` is refused, not defaulted.
 */

/** `all` — every phase, including demo credentials and synthetic clinical data.
 *  `safe` — platform configuration only; no demo credentials, no synthetic PHI,
 *           no audit-trail writes. Suitable for a production day-1 bootstrap.
 *  `none` — no seeding at all. The default. */
export type SeedMode = 'all' | 'safe' | 'none';

const VALID_MODES: readonly SeedMode[] = ['all', 'safe', 'none'] as const;

/**
 * Phases excluded from `safe`, each because it writes something that must never
 * appear in a real environment:
 *
 * | Phase                                  | Why |
 * |----------------------------------------|-----|
 * | `02-apikey`                            | Demo API keys embedding raw secrets, ACTIVE and broadly scoped |
 * | `07f-arcaai-department-context-schemas`| One CUSTOMER tenant's department context schemas, `createdBy` a named tenant admin |
 * | `08-dna-writing-style`                 | Synthetic clinician writing samples |
 * | `09-consultation`                      | Synthetic, Vault-encrypted PHI |
 * | `10-audit-log`                         | Fabricated rows in the HIPAA audit trail |
 * | `23-arcaai-workflow-authoring`         | FABRICATED GOVERNANCE — see below |
 * | `23a-realtime-transcription-agent-arcaai` | FABRICATED GOVERNANCE — the ArcaAI half of TASK-858 D2 |
 * | `91-user`                              | Demo accounts (`*@example.com`) with a documented default password |
 *
 * ## A phase string is a FILE STEM, with one suffix (TASK-858)
 *
 * `23a-realtime-transcription-agent` seeds BOTH a SYSTEM-owned platform half and
 * an ArcaAI tenant-authored half, and the two halves belong on opposite sides of
 * this list. Splitting
 * it into two files would separate a graph from the compiled artifact whose
 * only correctness property is "equals what the compiler emits for that graph",
 * so instead the file exports two seed functions and `index.ts` gates them
 * with two phase strings: the bare stem for the SYSTEM half, and the stem plus
 * `-arcaai` for the tenant half. Nothing else in this list uses a suffix, and
 * nothing else should without the same reason.
 *
 * ## Why `23-arcaai-workflow-authoring` stays excluded (TASK-852 item 2, re-decided 2026-09-02)
 *
 * Its `WorkflowAssignment` rows are the switch that makes a tenant-authored graph govern a
 * consultation, so it is tempting to read "the substrate-exclusivity gate now passes, land the
 * rows" as "and therefore ship them everywhere". It is not. The rows carry
 * `createdBy: <the ArcaAI tenant admin>` and publish a CLINICAL workflow under that attribution.
 * In a demo database that is the point; in a real one it is a published clinical workflow
 * attributed to a named human who never authored it — a fabricated governance act, and the same
 * objection that keeps `AgentPromotion` out of this dataset entirely. A real tenant authors its
 * own.
 *
 * Two further reasons, each sufficient on its own:
 *
 *  - Every row is scoped to the ArcaAI **customer** tenant (`50000000-…`). `safe` is platform
 *    configuration only, and one customer's graphs are not platform configuration.
 *  - `createdBy` and the department override reference `91-user` / department rows that a `safe`
 *    run does not create, so the rows would land with dangling authorship.
 *
 * The SYSTEM-owned platform default (`21-workflow-definition`, `createdBy: SYSTEM_USER_ID`) is
 * deliberately NOT excluded — that IS platform configuration, and it is what a `safe` bootstrap
 * needs so a tenant with no graph of its own still resolves a lane. The same reasoning keeps the
 * SYSTEM half of `23a-realtime-transcription-agent` IN every mode: they are the clone-from-template library
 * `findSystemTemplates` serves, so excluding them would ship a production tenant a Workflow
 * Studio with nothing to start from.
 *
 * Kept as an explicit deny-list rather than an allow-list so that adding a new
 * platform-config phase does not silently require a second edit here — but
 * adding a new DEMO phase is a deliberate act with a test that fails until it
 * is listed (see `seed-mode.test.ts`, which also pins the set EXACTLY, so a
 * platform-config phase cannot be excluded by accident either).
 */
export const SEED_PHASES_EXCLUDED_FROM_SAFE: readonly string[] = [
  '02-apikey',
  '07f-arcaai-department-context-schemas',
  '08-dna-writing-style',
  '09-consultation',
  '10-audit-log',
  '23-arcaai-workflow-authoring',
  '23a-realtime-transcription-agent-arcaai',
  '91-user',
] as const;

/**
 * Resolve the seed mode from the environment. Throws rather than guessing.
 *
 * @param env process environment (injected for testability)
 */
export function resolveSeedMode(env: NodeJS.ProcessEnv = process.env): SeedMode {
  const raw = (env.RUN_SEED ?? '').trim().toLowerCase();

  if (raw === '') return 'none';

  if (!VALID_MODES.includes(raw as SeedMode)) {
    throw new Error(
      `RUN_SEED="${env.RUN_SEED}" is not a valid seed mode. ` +
        `Expected one of: ${VALID_MODES.join(' | ')}. Seeding is opt-in and defaults to "none".`,
    );
  }

  const mode = raw as SeedMode;

  if (mode === 'all') {
    // Demo credentials + synthetic PHI. Permission must be stated explicitly:
    // an ABSENT NODE_ENV is refused, never read as "development".
    const nodeEnv = env.NODE_ENV;
    if (!nodeEnv) {
      throw new Error(
        'RUN_SEED="all" requires NODE_ENV to be explicitly "development" or "test", but NODE_ENV is not set. ' +
          'Refusing to seed demo credentials and synthetic PHI on an unidentified environment. ' +
          'Set NODE_ENV, or use RUN_SEED="safe" for a production bootstrap.',
      );
    }
    if (nodeEnv !== 'development' && nodeEnv !== 'test') {
      throw new Error(
        `RUN_SEED="all" is refused when NODE_ENV="${nodeEnv}". ` +
          'That mode seeds demo API keys with raw secrets, demo accounts, synthetic PHI, and fabricated ' +
          'audit-trail rows. Use RUN_SEED="safe" outside development/test.',
      );
    }
  }

  return mode;
}

/** Whether a given seed phase (its file stem, e.g. `09-consultation`) runs in `mode`. */
export function isPhaseEnabled(phase: string, mode: SeedMode): boolean {
  if (mode === 'none') return false;
  if (mode === 'all') return true;
  return !SEED_PHASES_EXCLUDED_FROM_SAFE.includes(phase);
}
