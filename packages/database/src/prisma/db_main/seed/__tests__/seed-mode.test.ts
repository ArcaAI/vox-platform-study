/**
 * Seed-mode gating
 *
 * `packages/database/migrate.sh` ran the seed UNCONDITIONALLY in every
 * environment — the `NODE_ENV` if/else only chose the migration mechanism, and
 * the seed invocation sat outside it. In production that meant `seedAuditLog`
 * upserting fabricated rows into the HIPAA audit trail (with a real `update:`
 * payload, so it overwrote on every run) and `seedConsultation` writing
 * synthetic PHI.
 *
 * Worse, the migrate Job never receives `NODE_ENV` at all (no `envFrom` in
 * `deployment/k8s/base/db-migrate.yaml`), so `getNodeEnv()` fell back to its
 * default `'development'` — which ALSO made `shouldSeedApiKeys` return true,
 * seeding demo API keys with raw secrets. The guard existed; it was unreachable.
 *
 * These tests lock the replacement contract: seeding is opt-in via `RUN_SEED`,
 * defaults to OFF, and fails CLOSED — it never infers permission from an
 * environment variable that may simply be absent.
 */

import { describe, it, expect } from 'vitest';

import { resolveSeedMode, isPhaseEnabled, SEED_PHASES_EXCLUDED_FROM_SAFE } from '../seed-mode';

describe('resolveSeedMode — defaults and validation', () => {
  it('defaults to "none" when RUN_SEED is unset (fail closed)', () => {
    expect(resolveSeedMode({})).toBe('none');
  });

  it('defaults to "none" when RUN_SEED is empty', () => {
    expect(resolveSeedMode({ RUN_SEED: '' })).toBe('none');
  });

  it.each(['all', 'safe', 'none'])('accepts the documented mode %s', (mode) => {
    expect(resolveSeedMode({ RUN_SEED: mode, NODE_ENV: 'development' })).toBe(mode);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(resolveSeedMode({ RUN_SEED: '  SAFE ' })).toBe('safe');
  });

  it('throws on an unrecognized value rather than silently seeding', () => {
    expect(() => resolveSeedMode({ RUN_SEED: 'yes' })).toThrow(/RUN_SEED/);
  });
});

describe('resolveSeedMode — "all" is refused outside development/test', () => {
  it.each(['production', 'staging'])('throws when NODE_ENV=%s', (env) => {
    expect(() => resolveSeedMode({ RUN_SEED: 'all', NODE_ENV: env })).toThrow(/demo|production|refus/i);
  });

  it.each(['development', 'test'])('allows "all" when NODE_ENV=%s', (env) => {
    expect(resolveSeedMode({ RUN_SEED: 'all', NODE_ENV: env })).toBe('all');
  });

  it('refuses "all" when NODE_ENV is ABSENT — the migrate-Job case', () => {
    // The regression that motivated this ticket: an unset NODE_ENV must NOT be
    // read as "development". Permission is never inferred from an absent value.
    //
    // Asserts the ABSENT-specific message, not just /NODE_ENV/: the generic
    // wrong-environment branch below also throws for an undefined NODE_ENV and
    // also mentions it, so a loose matcher passes even if this branch is
    // deleted. An operator staring at a failed migrate Job needs to read
    // "NODE_ENV is not set", not `NODE_ENV="undefined"`.
    expect(() => resolveSeedMode({ RUN_SEED: 'all' })).toThrow(/NODE_ENV is not set/);
    // and it must point at the way forward
    expect(() => resolveSeedMode({ RUN_SEED: 'all' })).toThrow(/RUN_SEED="safe"/);
  });

  it('permits "safe" regardless of environment, including production', () => {
    expect(resolveSeedMode({ RUN_SEED: 'safe', NODE_ENV: 'production' })).toBe('safe');
    expect(resolveSeedMode({ RUN_SEED: 'safe' })).toBe('safe');
  });
});

describe('isPhaseEnabled — which phases each mode runs', () => {
  // added the last two. They are neither credentials nor PHI: both carry
  // `createdBy: <the ArcaAI tenant admin>`, so running them in `safe` would attribute tenant
  // configuration — and a PUBLISHED clinical workflow — to a named human who never authored it.
  // See `seed-mode.ts`'s table for the full reasoning.
  // adds the two `-arcaai` halves for the same reason: their rows carry
  // `createdBy: <the ArcaAI tenant admin>` on PUBLISHED clinical workflows. Their
  // SYSTEM halves (`23a-realtime-transcription-agent`,
  // `24-example-consultation-workflows`) stay IN every mode — see the "still runs
  // platform-config phases" case below.
  const DANGEROUS = [
    '02-apikey',
    '07f-arcaai-department-context-schemas',
    '08-dna-writing-style',
    '09-consultation',
    '10-audit-log',
    '23-arcaai-workflow-authoring',
    '23a-realtime-transcription-agent-arcaai',
    '24-example-consultation-workflows-arcaai',
    '91-user',
  ];

  it('runs nothing at all in "none"', () => {
    for (const phase of [...DANGEROUS, '01-policy', '15-entitlements']) {
      expect(isPhaseEnabled(phase, 'none')).toBe(false);
    }
  });

  it('runs every phase in "all"', () => {
    for (const phase of [...DANGEROUS, '01-policy', '15-entitlements']) {
      expect(isPhaseEnabled(phase, 'all')).toBe(true);
    }
  });

  it.each(DANGEROUS)('excludes %s from "safe" — demo credentials, synthetic PHI, audit-trail writes, or fabricated authorship', (phase) => {
    expect(isPhaseEnabled(phase, 'safe')).toBe(false);
  });

  // item 2. The assertions above are all `toContain`/one-way, so they catch a demo phase
  // that ESCAPED the deny-list and nothing else. The opposite mistake is just as bad and much
  // quieter: a PLATFORM-CONFIG phase added here by reflex leaves a production `safe` bootstrap
  // silently missing configuration, and no test above would notice. Pinning the set exactly makes
  // both directions a deliberate act — which is what the deny-list's own docstring promises.
  it('is EXACTLY this set — growing it silently would break a production bootstrap', () => {
    expect([...SEED_PHASES_EXCLUDED_FROM_SAFE].sort()).toEqual([...DANGEROUS].sort());
  });

  it('still runs platform-config phases in "safe"', () => {
    for (const phase of [
      '01-policy',
      '03-role',
      '15-entitlements',
      '20-ai-price-book',
      // the SYSTEM template halves. A `safe` bootstrap that skipped
      // them would ship a Workflow Studio with an empty template library, which
      // is precisely the platform configuration `safe` exists to install.
      '21-workflow-definition',
      '23a-realtime-transcription-agent',
      '24-example-consultation-workflows',
    ]) {
      expect(isPhaseEnabled(phase, 'safe')).toBe(true);
    }
  });

  it('keeps the excluded set explicit, so adding a demo phase is a deliberate act', () => {
    expect([...SEED_PHASES_EXCLUDED_FROM_SAFE].sort()).toEqual([...DANGEROUS].sort());
  });
});
