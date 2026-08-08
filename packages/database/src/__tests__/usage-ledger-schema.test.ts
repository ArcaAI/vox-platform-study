/**
 * TASK-615 — schema-level guards for the usage ledger and its rollups.
 *
 * These read `db_main/*.prisma` off disk (the tenant-scope drift guard's
 * technique) because the invariants they protect live in the SCHEMA, not in any
 * TypeScript surface — a regression here is a data-integrity bug that no
 * unit-mocked repository test can see.
 *
 * Two invariants:
 *
 *  1. IDEMPOTENT APPEND — `AiUsageEvent.idempotencyKey` must be `@unique`. It is
 *     the only thing standing between an outbox redelivery and double-billing a
 *     tenant.
 *
 *  2. THE ROLLUP DIMENSION TUPLE IS UNIQUE AND NULL-FREE — the hourly/daily
 *     rollups are maintained by UPSERT on their full dimension tuple
 *     (tenant × bucketStart × capability × provider × model × unit). Postgres
 *     treats every NULL as DISTINCT, so a NULLABLE `model` column would make
 *     that unique index silently non-idempotent: two upserts for the same
 *     model-less capability (e.g. an STT audio-second row) would NOT conflict
 *     and the rollup would double-count. `model` therefore carries the same
 *     EMPTY-STRING SENTINEL treatment as `AgentTrajectoryStep.runId`, which was
 *     introduced for exactly this failure mode.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_MAIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'db_main');

function modelBody(file: string, model: string): string {
  const src = readFileSync(join(DB_MAIN_DIR, file), 'utf-8');
  const match = new RegExp(`^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(src);
  if (!match?.[1]) throw new Error(`model ${model} not found in ${file}`);
  return match[1];
}

/**
 * A field declaration of the given Prisma scalar type, e.g. `Float`.
 *
 * Matches `  <name> <Type>` at the start of a line ONLY, so the doc comments —
 * which say things like "never Float" precisely because that is the rule — are
 * not mistaken for a column of that type.
 */
function declaresFieldOfType(body: string, type: string): boolean {
  return new RegExp(`^\\s*\\w+\\s+${type}\\b`, 'm').test(body);
}

/** The field names inside a `@@unique([...])` block, in declaration order. */
function uniqueTuple(body: string): string[] {
  const match = /@@unique\(\[([^\]]+)\]/.exec(body);
  if (!match?.[1]) throw new Error('no @@unique found');
  return match[1].split(',').map((f) => f.trim());
}

describe('AiUsageEvent — idempotent append', () => {
  const body = modelBody('usage-ledger.prisma', 'AiUsageEvent');

  it('declares `idempotencyKey` UNIQUE (the anti-double-billing guard)', () => {
    expect(body).toMatch(/^\s*idempotencyKey\s+String\s+@unique/m);
  });

  it('separates `occurredAt` (when the usage happened) from `recordedAt` (when we saw it)', () => {
    expect(body).toMatch(/^\s*occurredAt\s+DateTime/m);
    expect(body).toMatch(/^\s*recordedAt\s+DateTime/m);
  });

  it('records `quantity` as Decimal — never a float', () => {
    expect(body).toMatch(/^\s*quantity\s+Decimal/m);
  });

  it('holds money as integer micros (BigInt), never Float', () => {
    expect(body).toMatch(/^\s*unitPriceMicros\s+BigInt\?/m);
    expect(body).toMatch(/^\s*costMicros\s+BigInt\?/m);
    expect(declaresFieldOfType(body, 'Float')).toBe(false);
  });

  it('carries NO `resourceStatus` column (append-only, hard retention)', () => {
    expect(body).not.toMatch(/^\s*resourceStatus\s/m);
  });
});

describe.each([
  ['AiUsageRollupHourly', 'AiUsageRollupHourly_dimension_unique'],
  ['AiUsageRollupDaily', 'AiUsageRollupDaily_dimension_unique'],
])('%s — upsert dimension tuple', (model, indexName) => {
  const body = modelBody('usage-ledger.prisma', model);

  it('is unique on the FULL dimension tuple', () => {
    // TASK-615 #4 — `operation` joins the grain so the LLM_TOKENS meter can
    // exclude guardrail.validate/harness.step; empty-string sentinel like `model`.
    // TASK-638 — `deployment` joins it so billing can consume the allowance
    // SELF_HOSTED-first and keep BYOK off the managed premium.
    expect(uniqueTuple(body)).toEqual(['tenantId', 'bucketStart', 'capability', 'operation', 'provider', 'deployment', 'model', 'unit']);
  });

  it(`names the index \`${indexName}\``, () => {
    expect(body).toContain(indexName);
  });

  it('declares every tuple member NON-NULLABLE (a NULL would defeat the unique)', () => {
    for (const field of ['tenantId', 'bucketStart', 'capability', 'operation', 'provider', 'deployment', 'model', 'unit']) {
      // `field Type?` anywhere in the tuple re-opens the NULL-is-distinct hole.
      expect(body, `${field} must not be nullable`).not.toMatch(new RegExp(`^\\s*${field}\\s+\\w+\\?`, 'm'));
    }
  });

  it('gives `model` an empty-string sentinel default (capabilities with no model)', () => {
    expect(body).toMatch(/^\s*model\s+String\s+@default\(""\)/m);
  });

  it('sums quantity as Decimal and cost as BigInt micros', () => {
    expect(body).toMatch(/^\s*quantitySum\s+Decimal/m);
    expect(body).toMatch(/^\s*costMicrosSum\s+BigInt/m);
  });
});

describe('AiPriceBook — effective-dated, supersede-only', () => {
  const body = modelBody('usage-ledger.prisma', 'AiPriceBook');

  it('carries the two price planes and an open-ended effective window', () => {
    expect(body).toMatch(/^\s*plane\s+AiPriceBookPlane/m);
    expect(body).toMatch(/^\s*effectiveFrom\s+DateTime/m);
    // Nullable = "still in force"; superseding a row sets it rather than editing the price.
    expect(body).toMatch(/^\s*effectiveTo\s+DateTime\?/m);
  });

  it('prices in integer micros', () => {
    expect(body).toMatch(/^\s*unitPriceMicros\s+BigInt/m);
    expect(declaresFieldOfType(body, 'Float')).toBe(false);
  });
});

describe('BillingInvoice — money is integer micros', () => {
  const body = modelBody('billing.prisma', 'BillingInvoice');

  it('stores subtotal and total as BigInt micros', () => {
    expect(body).toMatch(/^\s*subtotalMicros\s+BigInt/m);
    expect(body).toMatch(/^\s*totalMicros\s+BigInt/m);
    expect(declaresFieldOfType(body, 'Float')).toBe(false);
  });

  it('keeps `_version` for OCC-guarded finalize', () => {
    expect(body).toMatch(/@map\("_version"\)/);
  });

  it('is unique per (tenant, period) so a month cannot be invoiced twice', () => {
    expect(uniqueTuple(body)).toEqual(['tenantId', 'periodStart']);
  });
});
